/**
 * views/corner.js — the corner view, drawn on a single Canvas 2D surface.
 *
 * Contours come from Tier 1 grids, through the Web Worker (never on the main
 * thread). Scatter points, when enabled, come from Tier 2.
 *
 * THE VISUAL ENCODING (ruling 18, and it is the inverse of what this view did
 * before 2026-09-16)
 * ---------------------------------------------------------------------------
 *   * COLOUR means MODE, through `colors.modeColor(m)`. One mode index keeps one
 *     colour in every view and for every run. Contours, the Tier 2 scatter and
 *     the diagonal 1-D marginals all use it.
 *   * DASH means RUN, through `series[i].dash` (`colors.runDash`), AND it means
 *     CREDIBLE LEVEL, through `config.levelDash(L)`. Two variables share the one
 *     dash channel, so they are COMPOSED BY CONCATENATION (`composeDash` below):
 *     an empty array is solid and is the identity of that composition, so a
 *     single run at 90% draws exactly the solid line it drew before.
 *   * Mode indices are sampler EM indices. They carry no ordering and are never
 *     ranked by amplitude (`A_true` is nan on real data), so a colour identifies
 *     a mode WITHIN one fit and asserts nothing across fits.
 *
 * Every selected credible level is drawn, and its region is FILLED at
 * `FILL_ALPHA` of the mode colour. `state.levs` may be EMPTY, which means "draw
 * no contour lines": the view then issues no contour request at all, rather than
 * requesting an empty level set and paying the smoothing cost for nothing.
 *
 * CONVENTIONS (A1, restated where they are used):
 *   `f` in Hz; `gamma = 1/tau` in 1/s (the sampled variable, and the prior
 *   box); `t_start` in M_rem with origin at the IMR maximum-likelihood peak
 *   GPS; `phi`, `theta` in radians; `A` in strain; `epsilon` dimensionless.
 *
 * Panel layout: a lower-triangular P x P matrix over the selected parameters.
 * Panel (row i, col j) with j < i puts params[j] on x and params[i] on y.
 * The diagonal panel i carries the 1D marginal of params[i].
 */

import { defaultAxisRange, getParam, levelDash } from "../config.js";
import { marginal1D } from "../contour_core.js";
import { priorBinDensity, priorSupport } from "../prior.js";
import { gridKey, tier2Param } from "../format.js";
import { modeColor, withAlpha } from "../colors.js";
import { levelsOf, noteDrawnWindow, runKey, windowOf, zoomKey } from "../state.js";
import { makeAxis } from "./axis.js";
import {
  NARROW_LEGEND_GAP,
  NARROW_LEGEND_X,
  availableWidth,
  isNarrow,
  measureBlock,
  setCanvasCssSize,
} from "./plotutil.js";

/** This view's key in the view registry, and the prefix of its window keys. */
const VIEW = "corner";

/** Prior overlay: grey, dotted (user request 2026-09-18). */
const PRIOR_COLOR = "#7a7a7a";
const PRIOR_DASH = Object.freeze([2, 3]);

/** Opacity of one filled credible region, over the mode's colour. Value: 0.10.
 *
 *  Why 0.10 and not more. The regions of the three offered levels are NESTED,
 *  so at the mode's peak all three fills stack and the composite opacity is
 *  1 - (1 - 0.10)^3 = 0.271. That is still a light tint: the contour lines,
 *  the Tier 2 scatter and any other mode's fill underneath all stay legible
 *  through it. At 0.20 per level the stack reaches 0.488 and an overlaid second
 *  mode is no longer readable through the first, which is the failure this
 *  value is chosen against. One level alone at 0.10 is a visible tint, not an
 *  invisible one, so the low value costs nothing in the common case.
 *
 *  Declared here, used in the contour loop below, and matched by the identical
 *  constant in `views/fgamma.js` (A4). */
const FILL_ALPHA = 0.1;

/**
 * Compose the RUN dash and the LEVEL dash onto the one dash channel (ruling 18).
 *
 * Concatenation, because an empty array means solid and is therefore the
 * identity: run 0 (solid) at 90% (solid) gives `[]`, which is exactly the line
 * this view drew before the encoding changed. Every declared pattern has EVEN
 * length, so the concatenation never inverts the on/off phase of the second
 * pattern.
 *
 * @param {number[]} runDashPattern from `series[i].dash`
 * @param {number[]} levelDashPattern from `config.levelDash(level)`
 * @returns {number[]} a Canvas 2D line-dash array
 */
function composeDash(runDashPattern, levelDashPattern) {
  return [...runDashPattern, ...levelDashPattern];
}

/** Panel margins in CSS pixels. */
const PAD = { left: 62, right: 10, top: 10, bottom: 46, gap: 6 };

/** Smallest panel side in the narrow (phone) layout. Value: 110 CSS px. Below
 *  it the canvas grows wider than the screen and scrolls sideways in its box. */
export const NARROW_MIN_PANEL = 110;

export class CornerView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import("../worker_client.js").ContourClient} contourClient
   */
  constructor(canvas, contourClient) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.client = contourClient;
    this.lastFrameMs = NaN;
    /** Panels the interaction layer may zoom; republished on every frame. */
    this.hitAreas = [];
  }

  /**
   * Draw one frame.
   * @param {Object} args
   * @param {Object} args.state    store state
   * @param {Object} args.loader   Loader with preload() done
   * @param {Object[]} args.series [{cfg, n, t, color, label, isPin}]
   * @param {Object} [args.ctxOverride] draw into this surface instead of the
   *        canvas. This is the whole of the SVG-export support: the drawing
   *        code below is unchanged, because `surface.SvgSurface` implements the
   *        same Canvas 2D subset. The contour request uses a separate worker
   *        tag so that an export cannot supersede the live frame's request.
   */
  async render({ state, loader, series, ctxOverride }) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();
    const params = state.p;
    const P = params.length;

    // 1. Assemble every grid the lower triangle needs, for every (run, mode).
    const reqs = [];
    for (const s of series) {
      for (let m = 0; m < s.n; m++) {
        for (let i = 1; i < P; i++) {
          for (let j = 0; j < i; j++) {
            const g = loader.grid(s.cfg, s.n, s.t, m, params[j], params[i]);
            if (g === undefined) continue;
            reqs.push({
              seriesKey: runKey(s.cfg, s.n, s.t),
              // DASH means run (ruling 18); COLOUR is taken from the mode below.
              dash: s.dash ?? [],
              mode: m,
              i,
              j,
              grid: g,
            });
          }
        }
      }
    }

    // The credible levels to draw. THE EMPTY SET IS LEGAL and means "no contour
    // lines" (ruling 20): the request below is then skipped entirely, so an
    // empty selection costs no smoothing and no marching squares.
    const levs = levelsOf(state);
    const levels = levs.map((L) => L / 100);
    let results = [];
    if (reqs.length && levels.length) {
      // The key must be STABLE across frames: it is the worker's memo-cache
      // key, and a per-frame index would defeat the cache that makes the
      // slider drag cheap. Results come back in request order.
      const payload = reqs.map((r) => ({
        key: gridKey(r.grid.config, r.grid.n_modes, r.grid.t_start, r.mode, r.grid.px, r.grid.py),
        counts: r.grid.counts,
        nx: r.grid.nx,
        ny: r.grid.ny,
        xmin: r.grid.xmin,
        xmax: r.grid.xmax,
        ymin: r.grid.ymin,
        ymax: r.grid.ymax,
      }));
      const got = await this.client.contourLatest(
        ctxOverride ? "corner-export" : "corner",
        payload,
        levels,
        state.sig
      );
      if (got === null) return null; // superseded by a newer slider position
      results = got;
    }

    // 2. Axis ranges: the union over every contributing grid, per parameter.
    //
    // TWO ranges are accumulated. `range` is the full stored span of the grids.
    // `bulk` is the DEFAULT VIEW WINDOW the payload carries (request 7): for
    // every parameter except `A` it equals the full span, and for `A` it
    // excludes the long upper tail. It is a window, not a clip — the grid still
    // holds all of its mass, which is what makes the zoom reversible.
    const range = new Map();
    const bulk = new Map();
    const widenInto = (map, key, lo, hi) => {
      const cur = map.get(key);
      if (cur === undefined) map.set(key, [lo, hi]);
      else map.set(key, [Math.min(cur[0], lo), Math.max(cur[1], hi)]);
    };
    for (const r of reqs) {
      widenInto(range, params[r.j], r.grid.xmin, r.grid.xmax);
      widenInto(range, params[r.i], r.grid.ymin, r.grid.ymax);
      widenInto(bulk, params[r.j], r.grid.xbulk_lo, r.grid.xbulk_hi);
      widenInto(bulk, params[r.i], r.grid.ybulk_lo, r.grid.ybulk_hi);
    }
    for (const p of params) if (!range.has(p)) range.set(p, [0, 1]);

    // The range each parameter is DRAWN on: the user's zoom window if there is
    // one, else the payload's bulk window, else the full span. A payload built
    // before the bulk fields existed has no `bulk` entry and falls back to the
    // full span, so an older payload still draws.
    //
    // A parameter with a declared default range (the prior box, or the range a
    // derived quantity is defined on) draws on THAT, so the axes do not move
    // with the run (user request 2026-09-18). Only the others (today `A`) take
    // the data window, and those are recorded so a t_start change can freeze them.
    const win = new Map();
    for (const p of params) {
      const fixed = defaultAxisRange(p, state.ev);
      const b = bulk.get(p);
      const dataWin = b !== undefined && Number.isFinite(b[0]) && b[1] > b[0] ? b : range.get(p);
      const w = windowOf(state, VIEW, p, fixed ?? dataWin);
      win.set(p, w);
      if (fixed === null && !ctxOverride) noteDrawnWindow(VIEW, p, w);
    }

    // 3. Draw.
    const ctx = ctxOverride ?? this._prepareCanvas(P, series, state);
    if (ctxOverride) {
      this._cssW = ctxOverride.width;
      this._cssH = ctxOverride.height;
    }
    const geom = this._panelGeometry(P);
    this._drawFrames(ctx, geom, params);

    // One invertible axis pair per panel, built ONCE. Contours, scatter,
    // marginals, tick labels and the interaction hit areas all read these same
    // objects, so no two layers can disagree about where a datum lands.
    const axes = new Map();
    for (let i = 0; i < P; i++) {
      for (let j = 0; j <= i; j++) {
        const b = geom.panel(i, j);
        const xr = win.get(params[j]);
        const yr = win.get(params[i]);
        axes.set(`${i}|${j}`, {
          box: b,
          ax: makeAxis(xr[0], xr[1], b.x, b.x + b.w),
          // A diagonal panel's y axis is the 1D density, normalised to the
          // panel height. It carries no data range, so it is not zoomable.
          ay: i === j ? null : makeAxis(yr[0], yr[1], b.y, b.y + b.h, true),
        });
      }
    }
    const axesOf = (i, j) => axes.get(`${i}|${j}`);

    // Hit areas for the interaction layer. Published for the live canvas only:
    // an SVG export draws at its own size, and publishing its boxes would
    // leave the pointer hit-testing against a figure nobody is looking at.
    if (!ctxOverride) {
      this.hitAreas = [];
      for (let i = 0; i < P; i++) {
        for (let j = 0; j <= i; j++) {
          const a = axesOf(i, j);
          this.hitAreas.push({
            box: a.box,
            ax: a.ax,
            ay: a.ay,
            xKey: zoomKey(VIEW, params[j]),
            yKey: i === j ? null : zoomKey(VIEW, params[i]),
          });
        }
      }
    }

    for (let k = 0; k < reqs.length; k++) {
      const r = reqs[k];
      const res = results[k];
      if (!res) continue;
      const box = geom.panel(r.i, r.j);
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      // COLOUR is the mode; DASH is run composed with level (ruling 18).
      const col = modeColor(r.mode);
      ctx.strokeStyle = col;
      ctx.fillStyle = withAlpha(col, FILL_ALPHA);
      ctx.lineWidth = 1.4;
      const { ax, ay } = axesOf(r.i, r.j);
      // `contourGrid` returns one entry per requested level, IN REQUEST ORDER,
      // so `res.levels[li]` is the level `levs[li]`. Verified in the R0 smoke
      // check ("the levels come back in request order").
      for (let li = 0; li < res.levels.length; li++) {
        const L = res.levels[li];
        // Every polyline of ONE level goes into ONE path, so the nonzero fill
        // rule cuts a hole where a ring is nested inside another ring of the
        // same level. `SvgSurface.fill()` takes no fill-rule argument and SVG
        // defaults to nonzero as well, so screen and export agree.
        ctx.beginPath();
        for (const poly of L.rings) {
          for (let q = 0; q < poly.length; q += 2) {
            const px = ax.toPixel(poly[q]);
            const py = ay.toPixel(poly[q + 1]);
            if (q === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.closePath();
        }
        ctx.fill();
        ctx.setLineDash(composeDash(r.dash, levelDash(levs[li])));
        for (const poly of L.polylines) {
          ctx.beginPath();
          for (let q = 0; q < poly.length; q += 2) {
            const px = ax.toPixel(poly[q]);
            const py = ay.toPixel(poly[q + 1]);
            if (q === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // 4. Optional Tier 2 scatter, drawn under nothing (last, at low alpha).
    if (state.scatter) this._drawScatter(ctx, geom, params, axesOf, state, loader, series);

    // 5. Diagonal 1D marginals, from the same Tier 1 grids.
    this._drawMarginals(ctx, geom, params, axesOf, reqs);

    // 5b. Optional prior overlay (user request 2026-09-18), grey dotted.
    if (state.prior) this._drawPrior(ctx, geom, params, axesOf, win, state.ev, reqs);

    // 6. Axis ticks and labels.
    this._drawAxes(ctx, geom, params, win);
    if (this._narrow) {
      this._drawLegend(ctx, series, state, NARROW_LEGEND_X, geom.bottom + PAD.bottom + NARROW_LEGEND_GAP);
    } else {
      this._drawLegend(ctx, series, state, this._cssW - 200, PAD.top + 8);
    }

    this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    return this.lastFrameMs;
  }

  /**
   * Narrow: square panels of at least NARROW_MIN_PANEL, the canvas at least as
   * wide as the screen, and the legend below the grid instead of over the
   * empty upper triangle, which is too small on a phone to hold it.
   */
  _prepareCanvas(P, series, state) {
    const avail = availableWidth(this.canvas);
    this._narrow = isNarrow(avail);
    if (this._narrow) {
      const np = Math.max(1, P);
      const cssW = Math.max(avail, PAD.left + np * NARROW_MIN_PANEL + (np - 1) * PAD.gap + PAD.right);
      const side = (cssW - PAD.left - PAD.right - (np - 1) * PAD.gap) / np;
      const gridH = np * side + (np - 1) * PAD.gap;
      const legendH = measureBlock((c, x, y) => this._drawLegend(c, series, state, x, y));
      setCanvasCssSize(this.canvas, cssW, PAD.top + gridH + PAD.bottom + NARROW_LEGEND_GAP + legendH);
    } else {
      setCanvasCssSize(this.canvas, null, null);
    }
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const cssW = this.canvas.clientWidth || 800;
    const cssH = this.canvas.clientHeight || 800;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    this._cssW = cssW;
    this._cssH = cssH;
    return ctx;
  }

  _panelGeometry(P) {
    const w = this._cssW - PAD.left - PAD.right;
    const h = this._cssH - PAD.top - PAD.bottom;
    const cw = (w - (P - 1) * PAD.gap) / P;
    // Narrow: square panels; the height below the grid belongs to the legend.
    const ch = this._narrow ? cw : (h - (P - 1) * PAD.gap) / P;
    return {
      P,
      cw,
      ch,
      /** y of the grid's bottom edge. */
      bottom: PAD.top + P * ch + (P - 1) * PAD.gap,
      panel(i, j) {
        return {
          x: PAD.left + j * (cw + PAD.gap),
          y: PAD.top + i * (ch + PAD.gap),
          w: cw,
          h: ch,
        };
      },
    };
  }

  _drawFrames(ctx, geom, params) {
    ctx.strokeStyle = "#bbbbbb";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (let i = 0; i < geom.P; i++) {
      for (let j = 0; j <= i; j++) {
        const b = geom.panel(i, j);
        ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
      }
    }
  }

  _drawScatter(ctx, geom, params, axesOf, state, loader, series) {
    for (const s of series) {
      const t2 = loader.tier2Cached(s.cfg, s.n, s.t);
      if (t2 === undefined) continue; // not resident; the fetch is already queued
      for (let m = 0; m < t2.n_modes; m++) {
        const cols = {};
        for (const p of params) cols[p] = tier2Param(t2, p, m);
        // Request 1 verbatim: the scatter point of a mode carries the same
        // colour as that mode's contour, in every view and for every run.
        ctx.fillStyle = withAlpha(modeColor(m), 0.18);
        for (let i = 1; i < geom.P; i++) {
          for (let j = 0; j < i; j++) {
            const { box: b, ax, ay } = axesOf(i, j);
            const xs = cols[params[j]];
            const ys = cols[params[i]];
            ctx.save();
            ctx.beginPath();
            ctx.rect(b.x, b.y, b.w, b.h);
            ctx.clip();
            for (let q = 0; q < xs.length; q++) {
              const px = ax.toPixel(xs[q]);
              const py = ay.toPixel(ys[q]);
              ctx.fillRect(px, py, 1.2, 1.2);
            }
            ctx.restore();
          }
        }
      }
    }
  }

  _drawMarginals(ctx, geom, params, axesOf, reqs) {
    // For each (series, mode, parameter), find one grid containing it and
    // marginalise the other axis. Uses only preloaded Tier 1 data.
    const seen = new Set();
    for (const r of reqs) {
      for (const [idx, axis] of [[r.j, 0], [r.i, 1]]) {
        const tag = `${r.seriesKey}|${r.mode}|${idx}`;
        if (seen.has(tag)) continue;
        seen.add(tag);
        const dens = marginal1D(r.grid.counts, r.grid.nx, r.grid.ny, axis);
        const lo = axis === 0 ? r.grid.xmin : r.grid.ymin;
        const hi = axis === 0 ? r.grid.xmax : r.grid.ymax;
        const { box: b, ax } = axesOf(idx, idx);
        let dmax = 0;
        for (const v of dens) if (v > dmax) dmax = v;
        if (dmax <= 0) continue;
        ctx.save();
        ctx.beginPath();
        ctx.rect(b.x, b.y, b.w, b.h);
        ctx.clip();
        // A 1-D marginal is not a credible level, so it takes the RUN dash
        // alone, and the MODE colour (ruling 18).
        ctx.strokeStyle = modeColor(r.mode);
        ctx.lineWidth = 1.3;
        ctx.setLineDash(r.dash);
        ctx.beginPath();
        const n = dens.length;
        for (let k = 0; k < n; k++) {
          const v = lo + ((k + 0.5) * (hi - lo)) / n;
          const px = ax.toPixel(v);
          const py = b.y + b.h - (dens[k] / dmax) * b.h * 0.92;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  /**
   * The prior overlay: its bounds as grey dotted lines in every panel, and the
   * 1D marginal prior on each diagonal panel. The 1D prior is the bin average
   * over the posterior grid's bin count across the drawn window, scaled to its
   * own peak like the posterior marginals (prior.js).
   */
  _drawPrior(ctx, geom, params, axesOf, win, ev, reqs) {
    const nb = reqs.length ? reqs[0].grid.nx : 64;
    ctx.save();
    ctx.strokeStyle = PRIOR_COLOR;
    ctx.lineWidth = 1.3;
    ctx.setLineDash([...PRIOR_DASH]);
    const P = geom.P;
    for (let i = 0; i < P; i++) {
      for (let j = 0; j <= i; j++) {
        const { box: b, ax, ay } = axesOf(i, j);
        ctx.save();
        ctx.beginPath();
        ctx.rect(b.x, b.y, b.w, b.h);
        ctx.clip();
        const xw = win.get(params[j]);
        for (const v of priorSupport(params[j], ev)) {
          if (!Number.isFinite(v) || v < xw[0] || v > xw[1]) continue;
          ctx.beginPath();
          ctx.moveTo(ax.toPixel(v), b.y);
          ctx.lineTo(ax.toPixel(v), b.y + b.h);
          ctx.stroke();
        }
        if (i !== j) {
          const yw = win.get(params[i]);
          for (const v of priorSupport(params[i], ev)) {
            if (!Number.isFinite(v) || v < yw[0] || v > yw[1]) continue;
            ctx.beginPath();
            ctx.moveTo(b.x, ay.toPixel(v));
            ctx.lineTo(b.x + b.w, ay.toPixel(v));
            ctx.stroke();
          }
        } else {
          const dens = priorBinDensity(params[j], ev, xw[0], xw[1], nb);
          let dmax = 0;
          for (const v of dens) if (v > dmax) dmax = v;
          if (dmax > 0) {
            ctx.beginPath();
            for (let k = 0; k < nb; k++) {
              const v = xw[0] + ((k + 0.5) * (xw[1] - xw[0])) / nb;
              const px = ax.toPixel(v);
              const py = b.y + b.h - (dens[k] / dmax) * b.h * 0.92;
              if (k === 0) ctx.moveTo(px, py);
              else ctx.lineTo(px, py);
            }
            ctx.stroke();
          }
        }
        ctx.restore();
      }
    }
    ctx.restore();
  }

  _drawAxes(ctx, geom, params, range) {
    ctx.setLineDash([]);
    ctx.fillStyle = "#222222";
    ctx.font = "12px system-ui, sans-serif";
    const P = geom.P;
    for (let j = 0; j < P; j++) {
      const b = geom.panel(P - 1, j);
      const p = getParam(params[j]);
      const r = range.get(params[j]);
      ctx.textBaseline = "top";
      if (this._narrow) {
        // Narrow: each end label sits INSIDE its panel's width. Centred on the
        // edges, adjacent panels' labels are only PAD.gap apart and overlapped,
        // and the last one ran past PAD.right (MEASURED 2026-09-16, gate M-G1:
        // 3 overlapping pairs and 1 clipped label).
        ctx.textAlign = "left";
        ctx.fillText(fmt(r[0]), b.x, b.y + b.h + 4);
        ctx.textAlign = "right";
        ctx.fillText(fmt(r[1]), b.x + b.w, b.y + b.h + 4);
        ctx.textAlign = "center";
      } else {
        ctx.textAlign = "center";
        ctx.fillText(fmt(r[0]), b.x, b.y + b.h + 4);
        ctx.fillText(fmt(r[1]), b.x + b.w, b.y + b.h + 4);
      }
      ctx.fillText(p.unit ? `${p.label} [${p.unit}]` : p.label, b.x + b.w / 2, b.y + b.h + 20);
    }
    for (let i = 0; i < P; i++) {
      const b = geom.panel(i, 0);
      const p = getParam(params[i]);
      const r = range.get(params[i]);
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(fmt(r[1]), b.x - 4, b.y + 6);
      ctx.fillText(fmt(r[0]), b.x - 4, b.y + b.h - 6);
      ctx.save();
      ctx.translate(14, b.y + b.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(p.unit ? `${p.label} [${p.unit}]` : p.label, 0, 0);
      ctx.restore();
    }
  }

  /**
   * The legend. It STATES THE ENCODING, because the encoding changed on
   * 2026-09-16 and a reader of an exported figure has no other way to know it:
   * colour is the mode, the dash is the run, and the level adds its own dash on
   * the end of the run's. The mode entries used to be drawn in a fixed grey
   * (`#555555`); that was correct only while the mode carried no colour.
   *
   * @param {number} x left edge. Wide: `this._cssW - 200` — 200 px, not 190:
   *        the encoding caption below is the widest text this view draws, and
   *        at 190 its longest line ran off the right edge of the canvas.
   * @param {number} y0 first line's y
   * @returns {number} the y below the legend
   */
  _drawLegend(ctx, series, state, x, y0) {
    ctx.setLineDash([]);
    ctx.font = "12px system-ui, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    let y = y0;
    const NEUTRAL = "#444444";
    const swatch = (color, dash, lineWidth) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 18, y);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    const heading = (text) => {
      ctx.fillStyle = "#222222";
      ctx.fillText(text, x, y);
      y += 16;
    };

    const levs = levelsOf(state);
    heading(
      levs.length
        ? `credible regions: ${levs.join(", ")}%`
        : "no credible region drawn"
    );

    // COLOUR = MODE. Only the modes that some run in the compare set actually
    // has are listed; mode indices are sampler EM indices, not QNM labels.
    const nModes = series.reduce((a, s) => Math.max(a, s.n), 0);
    heading("colour = mode index");
    for (let m = 0; m < nModes; m++) {
      const col = modeColor(m);
      swatch(col, [], 2.5);
      // The same very light shade the contour region is filled with.
      ctx.fillStyle = withAlpha(col, FILL_ALPHA);
      ctx.fillRect(x, y - 5, 18, 10);
      ctx.fillStyle = "#222222";
      ctx.fillText(`mode ${m}`, x + 24, y);
      y += 15;
    }
    y += 4;

    // DASH = RUN.
    for (const s of series) {
      swatch(NEUTRAL, s.dash ?? [], 1.6);
      ctx.fillStyle = "#222222";
      ctx.fillText(s.label, x + 24, y);
      y += 15;
    }
    y += 4;

    // DASH = LEVEL, appended to the run's dash.
    if (levs.length) {
      for (const L of levs) {
        swatch(NEUTRAL, levelDash(L), 1.6);
        ctx.fillStyle = "#222222";
        ctx.fillText(`${L}%`, x + 24, y);
        y += 15;
      }
      y += 4;
    }

    if (state.prior) {
      swatch(PRIOR_COLOR, [...PRIOR_DASH], 1.6);
      ctx.fillStyle = "#222222";
      ctx.fillText("prior (one mode)", x + 24, y);
      y += 19;
    }

    // Kept to about 26 characters a line: the legend column is 200 px wide and
    // a longer line is drawn off the edge of the canvas, where it is lost.
    ctx.fillStyle = "#666666";
    for (const line of [
      "Dash = run + level,",
      "joined end to end.",
      `smoothing σ = ${state.sig} bin`,
      "Mode indices are sampler",
      "EM indices, not QNM labels,",
      "and not ordered by",
      "amplitude.",
    ]) {
      ctx.fillText(line, x, y);
      y += 14;
    }
    return y;
  }
}

function fmt(v) {
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e4 || a < 1e-3) return v.toExponential(1);
  return v.toPrecision(3);
}
