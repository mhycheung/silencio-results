/**
 * views/sky.js — the sky view: the IMR sky posterior and the ringdown-weighted
 * posterior, in a Mollweide projection (spec section 6, view 6).
 *
 * Part of the silencio interactive results application.
 *
 * Tier 5 is two files: an EVENT-level grid of IMR sky-posterior points
 * (`ra`, `dec` in radians), and one small per-run block of Metropolis-Hastings
 * visit indices into that grid. Because the grid is shared and only the indices
 * change, moving the start-time slider RE-WEIGHTS THE SAME POINTS and needs no
 * fetch after the first run block.
 *
 * WHAT IS DRAWN
 *   1. the Mollweide outline and graticule;
 *   2. every IMR posterior point, as small grey dots — the unweighted sky;
 *   3. per run, the VISITED points, sized by visit count exactly as the
 *      published figure sizes them (`sky_weights.visitedMarkers`);
 *   4. contours of both the IMR and the visit-weighted density;
 *   5. the IMR maximum-likelihood sky point, as a marker.
 *
 * THE PROJECTION IS MATPLOTLIB'S, DELIBERATELY, AND IS GATED
 * ---------------------------------------------------------
 * `mollweide.js` carries two solvers. The view uses `VIEW_SOLVER =
 * "matplotlib"`, a faithful transcription of
 * `matplotlib.projections.geo.MollweideAxes`, which does NOT solve
 * `2*aux + sin(2*aux) = pi*sin(phi)` to machine precision: it differs from a
 * machine-precision solve of its own equation by up to 9.94e-4 on this event's
 * sky bank. The mathematically exact projection FAILS gate G9 part 1 for that
 * reason. Do not "correct" this: matplotlib is the reference, because matching
 * the published figure is the point. Gate G9 part 1 holds the port to 9.93e-16.
 *
 * CONTOURS ARE BINNED IN PROJECTED COORDINATES, AND THAT IS LEGITIMATE HERE
 * ------------------------------------------------------------------------
 * The contour path wants a regular 2D grid, so the projected points are
 * histogrammed on a uniform grid in Mollweide axes coordinates. This is sound
 * because MOLLWEIDE IS AN EQUAL-AREA PROJECTION: equal area in the projected
 * plane is equal solid angle on the sphere, so bin counts are proportional to
 * probability per steradian and the contour is a contour of sky density. The
 * same would be wrong in a conformal projection.
 *
 * SMOOTHING IS `st.sig`, AND IT BIASES THE LEVEL — MEASURED, NOT ASSUMED
 * -----------------------------------------------------------------------
 * The smoothing width is the rail's `st.sig` (ruling 20), not a constant, so
 * this view smooths by exactly what the other contour views smooth by.
 *
 * The contour worker blurs the histogram and THEN takes the highest-density
 * threshold of the BLURRED field. That level set bounds 90% of the blurred
 * field correctly — MEASURED 0.8995 to 0.9006 across sigma = 0.5, 1 and 2 —
 * but it does NOT bound 90% of the SAMPLES, because the blur moved mass off
 * the ridge. On this event's sky bank the nominal 90% line holds 0.9648 of
 * the IMR points at sigma = 1, and 0.9080 at sigma = 0.
 *
 * WHY THIS VIEW AND NOT THE CORNER VIEW. The GW250114 sky posterior is a thin
 * arc: at 96 x 48 it occupies 35 bins inside a 78 x 19 bin bounding box, so it
 * is about ONE bin thick and eighty long, and it is still one bin thick at
 * 384 x 192. A sigma of one bin therefore blurs across its whole thickness.
 * A corner blob is many bins across and barely moves.
 *
 * MEASURED 2026-09-16 by the R5 sky probes `discriminate_sky_contour` and
 * `mechanism_sky_smoothing`, which are kept with the campaign notes and are NOT
 * shipped with this application. The grid resolution and the uint8 rescale were
 * both ablated and are NOT the lever (|delta| <= 0.003).
 *
 * Do not paste an internal repository path back into this comment: this file is
 * PUBLISHED, and the leak gate refuses the build over it (MEASURED 2026-09-16 —
 * the gate caught exactly that here, and it has no override flag).
 *
 * CONVENTIONS (pitfall A1):
 *   * `ra`, `dec` in radians. `ra` is wrapped to [-pi, pi] by `wrapRa` before
 *     projection, which is what puts ra = 0 at the centre of the figure.
 *   * Marker SIZE is monotone in visit count, as in the published figure. It is
 *     not a credible region and carries no level.
 *   * The visit indices are the COLD block only; the chain count comes from
 *     `chain_boundaries`, never from an array length.
 *   * Nothing is ranked by amplitude (`A_true` is nan on real data).
 */

import { levelDash } from "../config.js";
import { withAlpha } from "../colors.js";
import { X_HALF_WIDTH, Y_HALF_HEIGHT, graticule, mollweideMatplotlib, outline, projectMany } from "../mollweide.js";
import { visitCounts, visitedMarkers } from "../sky_weights.js";
import { levelsOf, runKey, windowOf, zoomKey } from "../state.js";
import {
  BODY_FONT,
  MUTED_COLOR,
  NARROW_LEGEND_GAP,
  NARROW_LEGEND_X,
  NARROW_PAD_RIGHT,
  TEXT_COLOR,
  availableWidth,
  drawLegend,
  drawMessage,
  isNarrow,
  measureBlock,
  plotBox,
  setCanvasCssSize,
} from "./plotutil.js";
// The projected axes are built directly, not through `plotutil.scale`: this
// view needs the INVERSE as well, to turn a cursor pixel into a projected
// coordinate (task R4).
import { makeAxis } from "./axis.js";

/**
 * The IMR maximum-likelihood sky point, in radians, read from the PAYLOAD.
 *
 * PROVENANCE (A4): the `event` block of the event's `summary.json`, fields
 * `imr_maxl_ra` and `imr_maxl_dec`, written by
 * `silencio.site.data.summary.event_block` from the run's `run_meta.json`
 * fields `ra_maxL` and `dec_maxL`.
 *
 * It used to be a pair of literals here, correct for GW250114 only. The site
 * now serves eight events, so a literal would draw one event's sky cross over
 * another event's posterior — a plausible-looking wrong figure. `eventMeta`
 * RAISES when the block is missing rather than falling back.
 *
 * @param {Object} loader
 * @returns {{ra: number, dec: number}} radians
 */
export function imrMaxLPoint(loader) {
  const ev = loader.eventMeta(); // RAISES on a payload with no event block
  for (const k of ["imr_maxl_ra", "imr_maxl_dec"]) {
    if (!Number.isFinite(ev[k])) {
      throw new Error(
        `sky.imrMaxLPoint: event block of "${ev.key}" has ${k} = ${ev[k]}, ` +
          `which is not a finite number of radians.`
      );
    }
  }
  return { ra: ev.imr_maxl_ra, dec: ev.imr_maxl_dec };
}

/**
 * Contour histogram resolution in projected coordinates. Value: 96 x 48.
 *
 * The Mollweide box is 2:1 (half-width 2*sqrt(2), half-height sqrt(2)), so a
 * 96 x 48 grid has square bins. It is finer than the 64 x 64 of Tier 1 because
 * the sky bank has K = 5000 points spread over an ellipse rather than 2000 in a
 * compact blob, and coarser than the point count would allow so that the
 * smoothed level set stays a closed curve rather than speckle.
 */
export const SKY_NX = 96;
export const SKY_NY = 48;

/** This view's key in the view registry, and the prefix of its window keys. */
const VIEW = "sky";

const PAD = Object.freeze({ left: 24, right: 248, top: 20, bottom: 40 });

export class SkyView {
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
    this._cache = null;
    /** Projected sky bank, computed once: the grid never changes. */
    this._proj = null;
    this._projN = 0;
  }

  /**
   * Draw one frame.
   *
   * @param {Object} args
   * @param {Object} args.state @param {Object} args.loader @param {Object[]} args.series
   * @param {Object} [args.ctxOverride] draw here instead of the canvas (SVG export)
   * @returns {Promise<number|null>} frame ms, or null when superseded
   */
  async render({ state, loader, series, ctxOverride }) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();

    if (ctxOverride) {
      if (this._cache === null) {
        drawMessage(ctxOverride, ctxOverride.width, ctxOverride.height, "nothing drawn yet");
        return 0;
      }
      this._draw(ctxOverride, ctxOverride.width, ctxOverride.height, this._cache);
      return (typeof performance !== "undefined" ? performance : Date).now() - t0;
    }

    const grid = loader.tier5GridCached();
    if (grid === undefined) {
      const ctx0 = this._prepareCanvas(null);
      drawMessage(ctx0, this._cssW, this._cssH, "fetching the Tier 5 sky grid …");
      return (typeof performance !== "undefined" ? performance : Date).now() - t0;
    }

    // The projection of the sky bank is reused across frames: the grid is
    // event-level and immutable, so this is done once per page, not per frame.
    if (this._proj === null || this._projN !== grid.n) {
      this._proj = projectMany(grid.ra, grid.dec); // VIEW_SOLVER = "matplotlib"
      this._projN = grid.n;
    }
    const proj = this._proj;
    const K = grid.n;

    // Per-run visit counts, from whatever is resident. No fetch here.
    const runs = [];
    for (const s of series) {
      const t5 = loader.tier5RunCached(s.cfg, s.n, s.t);
      if (t5 === undefined) continue;
      const counts = visitCounts(t5.omegaIdx, K);
      runs.push({ s, t5, key: runKey(s.cfg, s.n, s.t), counts, markers: visitedMarkers(counts) });
    }

    // Contours: the IMR sky density, and each run's visit-weighted density.
    // The keys are STABLE (they are the worker's memo-cache keys).
    //
    // `st.levs` MAY BE EMPTY, and that legally means "draw no contour lines"
    // (ruling 20). An empty set skips the worker request entirely rather than
    // falling back to a default level: there is nothing to ask for.
    const levels = levelsOf(state);
    let imrContour = null;
    if (levels.length) {
      const payload = [
        { key: `sky-imr|K${K}`, ...this._histogram(proj, K, null) },
        ...runs.map((r) => ({ key: `sky-run|${r.key}`, ...this._histogram(proj, K, r.counts) })),
      ];
      const got = await this.client.contourLatest(
        "sky",
        payload,
        levels.map((L) => L / 100),
        state.sig
      );
      if (got === null) return null; // superseded by a newer slider position
      imrContour = got[0];
      runs.forEach((r, i) => {
        r.contour = got[i + 1];
      });
    }

    // The event-level max-L sky point travels IN THE FRAME, so the SVG export,
    // which redraws from `this._cache`, marks the same point as the screen even
    // if the event changed in between.
    const frame = {
      state, series, grid, proj, K, runs, levels, imrContour,
      maxl: imrMaxLPoint(loader),
    };
    this._cache = frame;
    const ctx = this._prepareCanvas(frame);
    this._draw(ctx, this._cssW, this._cssH, frame);
    this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    return this.lastFrameMs;
  }

  /**
   * Histogram the projected points on a uniform grid in Mollweide coordinates,
   * rescaled to uint8 with max 255, which is the field the contour worker takes.
   *
   * `weights` null gives the unweighted IMR density; otherwise it is the visit
   * count per point, which is exactly the weighting the published figure uses.
   *
   * @param {Float64Array} proj length 2*K, [x0, y0, x1, y1, ...]
   * @param {number} K
   * @param {ArrayLike<number>|null} weights
   */
  _histogram(proj, K, weights) {
    const xmin = -X_HALF_WIDTH;
    const xmax = X_HALF_WIDTH;
    const ymin = -Y_HALF_HEIGHT;
    const ymax = Y_HALF_HEIGHT;
    const acc = new Float64Array(SKY_NX * SKY_NY);
    for (let k = 0; k < K; k++) {
      const wgt = weights === null ? 1 : weights[k];
      if (!(wgt > 0)) continue;
      const x = proj[2 * k];
      const y = proj[2 * k + 1];
      let ix = Math.floor(((x - xmin) / (xmax - xmin)) * SKY_NX);
      let iy = Math.floor(((y - ymin) / (ymax - ymin)) * SKY_NY);
      if (ix < 0) ix = 0;
      if (ix >= SKY_NX) ix = SKY_NX - 1;
      if (iy < 0) iy = 0;
      if (iy >= SKY_NY) iy = SKY_NY - 1;
      acc[iy * SKY_NX + ix] += wgt;
    }
    let peak = 0;
    for (const v of acc) if (v > peak) peak = v;
    const counts = new Uint8Array(SKY_NX * SKY_NY);
    if (peak > 0) {
      for (let i = 0; i < acc.length; i++) counts[i] = Math.round((acc[i] / peak) * 255);
    }
    return { counts, nx: SKY_NX, ny: SKY_NY, xmin, xmax, ymin, ymax };
  }

  _draw(ctx, w, h, frame) {
    const { state, grid, proj, K, runs, levels, imrContour } = frame;
    // Narrow: the ellipse spans the full width and the legend goes below it.
    // `this._narrow`, not `w`, decides, so an SVG export repeats the screen.
    const outer = this._narrow ? this._narrowBox(w) : plotBox(w, h, PAD);

    // Fit the 2:1 Mollweide ellipse inside the panel, preserving its aspect.
    const s = Math.min(outer.w / (2 * X_HALF_WIDTH), outer.h / (2 * Y_HALF_HEIGHT));
    const bw = s * 2 * X_HALF_WIDTH;
    const bh = s * 2 * Y_HALF_HEIGHT;
    const bx = outer.x + (outer.w - bw) / 2;
    const by = outer.y + (outer.h - bh) / 2;
    // Projected Mollweide coordinates, in the projection's own units. The
    // window is the whole ellipse until the user zooms. A wheel event applies
    // the SAME factor to x and y, so the projection's 2:1 aspect — the thing
    // that makes it equal-area on the page — survives any zoom.
    const xr = windowOf(state, VIEW, "x", [-X_HALF_WIDTH, X_HALF_WIDTH]);
    const yr = windowOf(state, VIEW, "y", [-Y_HALF_HEIGHT, Y_HALF_HEIGHT]);
    const ax = makeAxis(xr[0], xr[1], bx, bx + bw);
    const ay = makeAxis(yr[0], yr[1], by, by + bh, true);
    const sx = ax.toPixel;
    const sy = ay.toPixel;
    if (ctx === this.ctx) {
      this.hitAreas = [
        {
          box: { x: outer.x, y: outer.y, w: outer.w, h: outer.h },
          ax,
          ay,
          xKey: zoomKey(VIEW, "x"),
          yKey: zoomKey(VIEW, "y"),
        },
      ];
    }

    // Everything projected is clipped to the panel, so a zoomed sky cannot
    // spill over the legend rail to its right.
    ctx.save();
    ctx.beginPath();
    ctx.rect(outer.x, outer.y, outer.w, outer.h);
    ctx.clip();

    // Graticule, then outline.
    ctx.save();
    ctx.strokeStyle = "#e4e4e4";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    for (const line of graticule()) {
      ctx.beginPath();
      for (let i = 0; i < line.length; i += 2) {
        const px = sx(line[i]);
        const py = sy(line[i + 1]);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
    const out = outline();
    ctx.strokeStyle = "#999999";
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let i = 0; i < out.length; i += 2) {
      const px = sx(out[i]);
      const py = sy(out[i + 1]);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.stroke();
    ctx.restore();

    // The IMR posterior points, unweighted.
    ctx.save();
    ctx.fillStyle = "rgba(120,120,120,0.35)";
    for (let k = 0; k < K; k++) {
      ctx.fillRect(sx(proj[2 * k]) - 0.6, sy(proj[2 * k + 1]) - 0.6, 1.2, 1.2);
    }
    ctx.restore();

    // The IMR contour.
    if (imrContour) this._strokeContour(ctx, imrContour, sx, sy, "#555555", 1.6, levels);

    // Per run: visited markers, sized by visit count, then the weighted contour.
    for (const r of runs) {
      const { indices, sizes } = r.markers;
      ctx.save();
      ctx.fillStyle = withAlpha(r.s.color, 0.6);
      for (let i = 0; i < indices.length; i++) {
        const k = indices[i];
        // `sizes` is the published figure's marker AREA scale; the radius is
        // its square root so that area stays monotone in the visit count.
        const rad = Math.sqrt(sizes[i]) * 0.55;
        ctx.beginPath();
        ctx.arc(sx(proj[2 * k]), sy(proj[2 * k + 1]), rad, 0, 2 * Math.PI);
        ctx.fill();
      }
      ctx.restore();
      if (r.contour) this._strokeContour(ctx, r.contour, sx, sy, r.s.color, 1.8, levels);
    }

    // The IMR maximum-likelihood sky point, from the payload's event block.
    const m = mollweideMatplotlib(wrapToPi(frame.maxl.ra), frame.maxl.dec);
    ctx.save();
    ctx.strokeStyle = "#cc0000";
    ctx.lineWidth = 2.0;
    ctx.setLineDash([]);
    const mx = sx(m.x);
    const my = sy(m.y);
    ctx.beginPath();
    ctx.moveTo(mx - 7, my);
    ctx.lineTo(mx + 7, my);
    ctx.moveTo(mx, my - 7);
    ctx.lineTo(mx, my + 7);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mx, my, 5, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.restore();

    ctx.restore(); // end of the clip that holds the projection inside the panel

    if (this._narrow) {
      this._legend(ctx, NARROW_LEGEND_X, outer.y + outer.h + PAD.bottom + NARROW_LEGEND_GAP, frame);
    } else {
      this._legend(ctx, w - PAD.right + 14, PAD.top + 6, frame);
    }
    void grid;
  }

  /** The plot area in the narrow layout: full width, height = width / 2 (the ellipse's aspect). */
  _narrowBox(w) {
    const bw = Math.max(10, w - PAD.left - NARROW_PAD_RIGHT);
    return { x: PAD.left, y: PAD.top, w: bw, h: bw / 2 };
  }

  /** Draw the legend block from (lx, ly); returns the y below it. */
  _legend(ctx, lx, ly, frame) {
    const { state, K, runs, levels } = frame;
    ly = drawLegend(
      ctx,
      lx,
      ly,
      [
        { color: "rgba(120,120,120,0.8)", label: `IMR posterior (${K} points)`, marker: "dot" },
        ...levels.map((L) => ({
          color: "#555555",
          label: `IMR ${L}% contour`,
          dash: levelDash(L), // RAISES on an undeclared level
          lineWidth: 1.6,
        })),
        { color: "#cc0000", label: "IMR max-L sky point", lineWidth: 2 },
      ],
      "sky posterior"
    );
    ly += 6;
    if (runs.length) {
      ly = drawLegend(
        ctx,
        lx,
        ly,
        runs.map((r) => ({ color: r.s.color, label: r.s.label })),
        "ringdown-weighted: one line per RUN"
      );
      ly += 6;
    }
    ctx.save();
    ctx.font = BODY_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = TEXT_COLOR;
    if (runs.length) {
      const r0 = runs[0];
      let nVis = 0;
      for (let i = 0; i < r0.counts.length; i++) if (r0.counts[i] > 0) nVis++;
      ctx.fillText(`${nVis} of ${K} points visited`, lx, ly);
      ly += 15;
      ctx.fillStyle = MUTED_COLOR;
      ctx.fillText(`${r0.t5.nChains} cold chains, ${r0.t5.n} samples`, lx, ly);
      ly += 15;
    } else {
      ctx.fillStyle = MUTED_COLOR;
      ctx.fillText("fetching the run's visit indices …", lx, ly);
      ly += 15;
    }
    ly += 4;
    ctx.fillStyle = MUTED_COLOR;
    for (const line of [
      `levels: ${levels.length ? levels.join(", ") + "%" : "none"}`,
    ]) {
      if (line !== "") ctx.fillText(line, lx, ly);
      ly += 14;
    }
    ctx.restore();
    return ly;
  }

  /**
   * Stroke one contour result, one credible level at a time.
   *
   * DASH MEANS THE LEVEL and COLOUR MEANS THE RUN (ruling 20). Ruling 18's
   * "colour means the mode" does NOT apply to this view: Tier 5 carries no
   * per-mode split, so there is no mode here to colour. The IMR layer and a
   * run layer at the same level therefore share a dash and are told apart by
   * colour.
   *
   * @param {number[]} levels the percent levels in the order they were
   *        requested. `res.levels` must be parallel to it, or this RAISES
   *        (A4): the dash is assigned by POSITION, so a mismatch would
   *        silently mislabel a level instead of failing visibly.
   */
  _strokeContour(ctx, res, sx, sy, color, lw, levels) {
    if (res.levels.length !== levels.length) {
      throw new Error(
        `sky._strokeContour: the worker returned ${res.levels.length} level sets ` +
          `for the ${levels.length} requested (${levels.join(", ")}%).`
      );
    }
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    for (let i = 0; i < res.levels.length; i++) {
      ctx.setLineDash(levelDash(levels[i])); // RAISES on an undeclared level
      for (const poly of res.levels[i].polylines) {
        ctx.beginPath();
        for (let q = 0; q < poly.length; q += 2) {
          const px = sx(poly[q]);
          const py = sy(poly[q + 1]);
          if (q === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  _prepareCanvas(frame) {
    const avail = availableWidth(this.canvas);
    this._narrow = isNarrow(avail);
    if (this._narrow) {
      const box = this._narrowBox(avail);
      const legendH = frame ? measureBlock((c, x, y) => this._legend(c, x, y, frame)) : 0;
      setCanvasCssSize(this.canvas, avail, box.y + box.h + PAD.bottom + NARROW_LEGEND_GAP + legendH);
    } else {
      setCanvasCssSize(this.canvas, null, null);
    }
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const cssW = this.canvas.clientWidth || 900;
    const cssH = this.canvas.clientHeight || 700;
    if (
      this.canvas.width !== Math.round(cssW * dpr) ||
      this.canvas.height !== Math.round(cssH * dpr)
    ) {
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
}

/** Wrap an angle to [-pi, pi). Mirrors mollweide.wrapRa for a single value. */
function wrapToPi(a) {
  const twoPi = 2 * Math.PI;
  let x = ((a + Math.PI) % twoPi + twoPi) % twoPi;
  return x - Math.PI;
}
