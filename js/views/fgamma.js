/**
 * views/fgamma.js — the f-gamma plane: mode identification (spec section 6, view 2).
 *
 * Part of the silencio interactive results application.
 *
 * Posterior contours in `(f, gamma)` come from the preloaded Tier 1 grids,
 * contoured in the Web Worker (never on the main thread). Optional Tier 2
 * points are overlaid when the rail's scatter toggle is on.
 *
 * THE VISUAL ENCODING (ruling 18, and it is the inverse of what this view did
 * before 2026-09-16)
 * ---------------------------------------------------------------------------
 *   * COLOUR means MODE, through `colors.modeColor(m)` — contours, their fills
 *     and the Tier 2 scatter. One mode keeps one colour in every view and for
 *     every run.
 *   * DASH means RUN, through `series[i].dash`, AND it means CREDIBLE LEVEL,
 *     through `config.levelDash(L)`. The two are COMPOSED BY CONCATENATION
 *     (`composeDash` below); an empty array is solid and is the identity, so a
 *     single run at 90% draws the solid line it drew before.
 *   * The Kerr overlay and the ranking block are per-RUN annotations, not modes,
 *     so they are drawn in a NEUTRAL colour and identified by the run dash. They
 *     must not take a run colour: `PIN_PALETTE` and `MODE_PALETTE` share hues,
 *     and a coloured cross would read as a mode.
 *
 * Every selected credible level is drawn and filled at `FILL_ALPHA`. An EMPTY
 * `state.levs` means "draw no contour lines": the view then issues no contour
 * request, rather than requesting an empty level set and paying the smoothing.
 *
 * THE KERR OVERLAY IS OPTIONAL, AND ITS ABSENCE IS NOT AN ERROR
 * -------------------------------------------------------------
 * The Kerr 220/221 predictions require `summary.runs[key].kerr`, a Tier 3 field
 * that does NOT exist in the payload as of 2026-09-15 and may never be added.
 * This view therefore DRAWS WITHOUT IT: when the field is absent the crosses
 * and the distance ranking are omitted, the panel says in words that they are
 * unavailable, and the posterior is drawn exactly as it would be otherwise.
 *
 * `kerr.js` still RAISES on a missing "2.2.0" inside an existing `kerr` block —
 * that is a different condition (a malformed block, not an absent one) and it
 * stays a hard error. This view distinguishes the two: no block at all is a
 * missing OPTIONAL feature; a block without its reference mode is corrupt data.
 *
 * WHEN THE OVERLAY IS UNAVAILABLE, the panel falls back to reporting Tier 3's
 * own `mode_id_distance_per_mode`, clearly labelled as a value computed on the
 * server rather than here. That is a different quantity from this view's
 * ranking metric and is never presented as the same thing.
 *
 * CONVENTIONS (pitfall A1, restated at the point of use):
 *   * `f` in Hz. The damping variable is the RATE `gamma = 1/tau` in 1/s: it is
 *     what the sampler samples and what the prior box is on.
 *   * The ranking metric of spec section 6 is
 *       x = f / f_220,  y = (1/tau) / (1/tau_220),  d = sqrt((x-1)^2 + (y-1)^2)
 *     ascending, evaluated at each mode's POSTERIOR MEDIAN `f` and `gamma` from
 *     Tier 3, against the predictions at the IMR maximum-likelihood sample.
 *   * Mode indices are sampler EM indices, never QNM labels, and are never
 *     ordered by amplitude (`A_true` is nan on real data). The distance ranking
 *     exists precisely because the indices carry no identification.
 *
 * THE NINE KERR PREDICTION BLOBS (campaign of 2026-09-18, task T4)
 * -----------------------------------------------------------------
 * A cross states no width. The optional payload file `kerr9/blobs.bin` carries,
 * for each of the nine QNM labels, a 64x64 density grid of 1999 draws of
 * (f, gamma) propagated from the IMR posterior, in the SAME Tier 1 container
 * the posterior grids use — so a prediction is contoured by the code that
 * already contours a posterior, at the same credible levels and the same
 * smoothing. Its nine maximum-likelihood points are drawn as filled dots.
 *
 * ENCODING. A prediction is a per-EVENT annotation: it belongs to no run and to
 * no sampler mode, so it takes NEITHER the mode colour nor the run dash. It is
 * drawn in one neutral colour, unfilled, and each blob is NAMED in text beside
 * its maximum-likelihood dot. That is what keeps it readable with all nine on:
 * nine more hues would collide with MODE_PALETTE and nine more dashes are not
 * distinguishable at all.
 *
 * THE BLOBS ARE OPTIONAL, exactly as the per-run `kerr` block is. An event whose
 * payload does not advertise `kerr9` draws no blob, says so in the legend, and
 * is otherwise unchanged. The 2.2.0 and 2.2.1 CROSSES of the per-run `kerr`
 * block are kept: they are the maximum-likelihood prediction of THAT RUN's
 * remnant, and they are what the view has always drawn.
 *
 * THE PRIOR BOX is drawn here only where its edges fall inside the plotted
 * range. The full uncropped box, with any posterior mass sitting against it,
 * is the diagnostics view's job: on this view's axes the box (f in
 * [20, 1024] Hz, gamma in [1, 2500] 1/s) is so much wider than the posterior
 * that plotting all of it would reduce every contour to a dot.
 */

import {
  KERR9_CONFIG,
  KERR9_T_START,
  KERR_BLOB_MODE_LABELS,
  defaultAxisRange,
  getParam,
  levelDash,
  priorBox,
} from "../config.js";
import { modeColor, withAlpha } from "../colors.js";
import { gridKey, tier2Param } from "../format.js";
import { KERR_DRAW_LABELS, KERR_REF_LABEL, kerrPredictions, rankModes } from "../kerr.js";
import { kerrLabelsOf, levelsOf, runKey, windowOf, zoomKey } from "../state.js";
import {
  BODY_FONT,
  FRAME_COLOR,
  MUTED_COLOR,
  NARROW_LEGEND_GAP,
  NARROW_LEGEND_X,
  NARROW_PAD_RIGHT,
  TEXT_COLOR,
  availableWidth,
  cross,
  dot,
  drawFrame,
  drawLegend,
  drawMessage,
  isNarrow,
  measureBlock,
  padRange,
  plotBox,
  setCanvasCssSize,
  unionRange,
} from "./plotutil.js";

/** The two parameters of this plane, in axis order. Value: f on x, gamma on y. */
export const FGAMMA_X = "f";
export const FGAMMA_Y = "gamma";

/** Opacity of one filled credible region, over the mode's colour. Value: 0.10.
 *  IDENTICAL to `views/corner.js` FILL_ALPHA, and for the same reason: the three
 *  offered levels nest, so all three fills stack to 1 - (1 - 0.10)^3 = 0.271,
 *  which is still light enough to read a second mode's contour through. The two
 *  views must agree, or one mode would look denser on one panel than another. */
const FILL_ALPHA = 0.1;

/**
 * Compose the RUN dash and the LEVEL dash onto the one dash channel (ruling 18).
 * Concatenation, because `[]` means solid and is therefore the identity: run 0
 * at 90% stays exactly the solid line this view drew before. Every declared
 * pattern has even length, so the phase of the second pattern is preserved.
 *
 * @param {number[]} runDashPattern from `series[i].dash`
 * @param {number[]} levelDashPattern from `config.levelDash(level)`
 * @returns {number[]}
 */
function composeDash(runDashPattern, levelDashPattern) {
  return [...runDashPattern, ...levelDashPattern];
}

/** Plot margins in CSS pixels; the right margin holds the legend and ranking. */
/** This view's key in the view registry, and the prefix of its window keys. */
const VIEW = "fgamma";

const PAD = Object.freeze({ left: 76, right: 268, top: 20, bottom: 56 });

/** Plot-area height over plot-area width in the narrow (phone) layout. Value: 0.9. */
export const NARROW_ASPECT = 0.9;

export class FGammaView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import("../worker_client.js").ContourClient} contourClient
   */
  constructor(canvas, contourClient) {
    this.canvas = canvas;
    this.ctx = contourClient === undefined ? null : canvas.getContext("2d");
    if (this.ctx === null) this.ctx = canvas.getContext("2d");
    this.client = contourClient;
    this.lastFrameMs = NaN;
    /** Panels the interaction layer may zoom; republished on every frame. */
    this.hitAreas = [];
    /** Last prepared frame, so SVG export redraws without touching the worker. */
    this._cache = null;
  }

  /**
   * Draw one frame.
   *
   * @param {Object} args
   * @param {Object} args.state store state
   * @param {Object} args.loader Loader with preload() done
   * @param {Object[]} args.series [{cfg, n, t, color, label, isPin}]
   * @param {Object} [args.ctxOverride] draw here instead of the canvas; reuses
   *        the cached contours and never issues a worker request (SVG export)
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

    // 1. One Tier 1 grid per (run, mode) in the (f, gamma) plane.
    const reqs = [];
    for (const s of series) {
      for (let m = 0; m < s.n; m++) {
        const g = loader.grid(s.cfg, s.n, s.t, m, FGAMMA_X, FGAMMA_Y);
        if (g === undefined) continue;
        reqs.push({
          key: runKey(s.cfg, s.n, s.t),
          // DASH means run (ruling 18); COLOUR comes from the mode at draw time.
          dash: s.dash ?? [],
          label: s.label,
          mode: m,
          grid: g,
          s,
        });
      }
    }

    // 1b. One Tier 1 grid per SELECTED Kerr prediction blob. Same container,
    //     same worker, same levels. `kerr9Grid` returns undefined until the
    //     optional file is resident; `main.js :: ensureData` fetches it.
    const kreqs = [];
    for (const lab of kerrLabelsOf(state)) {
      const g = loader.kerr9Grid(lab);
      if (g === undefined) continue;
      // A4: assert the key the loader handed back is the blob key, so a
      // posterior grid can never be drawn as a prediction.
      if (g.config !== KERR9_CONFIG || g.t_start !== KERR9_T_START) {
        throw new Error(
          `fgamma: Kerr blob "${lab}" came back with config="${g.config}", ` +
            `t_start=${g.t_start}; expected "${KERR9_CONFIG}", ${KERR9_T_START}`
        );
      }
      kreqs.push({ label: lab, mode: KERR_BLOB_MODE_LABELS.indexOf(lab), grid: g });
    }

    // THE EMPTY LEVEL SET IS LEGAL and means "no contour lines" (ruling 20).
    // The request below is then skipped entirely, so nothing is smoothed.
    const levs = levelsOf(state);
    const levels = levs.map((L) => L / 100);
    let results = [];
    let kresults = [];
    if ((reqs.length || kreqs.length) && levels.length) {
      // A STABLE key per grid: it is the worker's memo-cache key, and a
      // per-frame index would defeat the cache that makes the drag cheap.
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
      // The blob grids ride the SAME worker call, appended after the posterior
      // grids, so one frame issues one request and the memo cache sees one
      // stable key per grid.
      for (const r of kreqs) {
        payload.push({
          key: gridKey(
            r.grid.config, r.grid.n_modes, r.grid.t_start, r.mode, r.grid.px, r.grid.py
          ),
          counts: r.grid.counts,
          nx: r.grid.nx,
          ny: r.grid.ny,
          xmin: r.grid.xmin,
          xmax: r.grid.xmax,
          ymin: r.grid.ymin,
          ymax: r.grid.ymax,
        });
      }
      const got = await this.client.contourLatest("fgamma", payload, levels, state.sig);
      if (got === null) return null; // superseded by a newer slider position
      results = got.slice(0, reqs.length);
      kresults = got.slice(reqs.length);
    }

    // 2. Kerr predictions and the distance ranking, per run. OPTIONAL: a run
    //    with no `kerr` block contributes no overlay and no ranking, and that
    //    is a normal state, not an error.
    const overlays = [];
    let missingKerr = 0;
    for (const s of series) {
      const key = runKey(s.cfg, s.n, s.t);
      const rec = loader.summaryOf(s.cfg, s.n, s.t);
      if (rec === undefined) continue;
      if (rec.kerr === undefined || rec.kerr === null) {
        missingKerr++;
        overlays.push({
          key,
          // A run annotation takes the DASH channel, never a colour: colour is
          // spent on the mode and PIN_PALETTE shares hues with MODE_PALETTE.
          dash: s.dash ?? [],
          label: s.label,
          predictions: null,
          ranking: null,
          serverDistances: Array.isArray(rec.mode_id_distance_per_mode)
            ? rec.mode_id_distance_per_mode
            : null,
        });
        continue;
      }
      // A `kerr` block that exists but is malformed (no "2.2.0", non-physical
      // values) is corrupt data and RAISES through kerr.js. Only its ABSENCE
      // is tolerated.
      const predictions = kerrPredictions(rec, key);
      let ranking = null;
      if (Array.isArray(rec.per_mode)) {
        const fMed = rec.per_mode.map((pm) => pm?.[FGAMMA_X]?.median);
        const gMed = rec.per_mode.map((pm) => pm?.[FGAMMA_Y]?.median);
        if (fMed.every(Number.isFinite) && gMed.every(Number.isFinite)) {
          ranking = rankModes(fMed, gMed, predictions);
        }
      }
      overlays.push({
        key,
        dash: s.dash ?? [],
        label: s.label,
        predictions,
        ranking,
        serverDistances: null,
      });
    }

    // 3. Axis ranges: the union over every contributing grid, widened to hold
    //    any Kerr prediction so a cross is never silently off-panel.
    const xs = [];
    const ys = [];
    for (const r of reqs) {
      xs.push(r.grid.xmin, r.grid.xmax);
      ys.push(r.grid.ymin, r.grid.ymax);
    }
    for (const o of overlays) {
      if (o.predictions === null) continue;
      for (const lab of KERR_DRAW_LABELS) {
        const p = o.predictions[lab];
        if (p === undefined) continue;
        xs.push(p.f);
        ys.push(p.invTau);
      }
    }
    // The nine maximum-likelihood prediction points, for the SELECTED labels
    // only. TRAP (kerrblobs.py): this is the IMR maximum-likelihood SAMPLE, not
    // row 0 of the blob.
    const kmaxl = [];
    const blob = loader.kerr9Cached();
    if (blob !== undefined) {
      for (const lab of kerrLabelsOf(state)) {
        const m = blob.maxl.get(lab);
        if (m !== undefined) kmaxl.push({ label: lab, f: m.f, gamma: m.gamma });
      }
    }

    const frame = {
      state,
      reqs,
      results,
      kreqs,
      kresults,
      kmaxl,
      kerrBlobAvailable: blob !== undefined,
      kerrNDraws: blob === undefined ? null : blob.header.n_draws,
      overlays,
      missingKerr,
      series,
      // Carried on the FRAME, not read from `state` at draw time: the SVG
      // export re-draws a CACHED frame, and the level set and sigma it was
      // contoured at must be the ones the legend then names.
      levs,
      sig: state.sig,
      // Default: the prior box, padded so its dashed edges stay visible
      // (user request 2026-09-18). Fixed, so it does not move with the run.
      xr: padRange(defaultAxisRange(FGAMMA_X, state.ev), 0.02),
      yr: padRange(defaultAxisRange(FGAMMA_Y, state.ev), 0.02),
      scatter: [],
    };

    // 4. Tier 2 points, from whatever is already resident. main.js queues the
    //    fetch and redraws; a frame never blocks on the network.
    if (state.scatter) {
      for (const s of series) {
        const t2 = loader.tier2Cached(s.cfg, s.n, s.t);
        if (t2 === undefined) continue;
        for (let m = 0; m < t2.n_modes; m++) {
          frame.scatter.push({
            // Colour is looked up from the MODE at draw time (ruling 18).
            mode: m,
            x: tier2Param(t2, FGAMMA_X, m),
            y: tier2Param(t2, FGAMMA_Y, m),
          });
        }
      }
    }

    this._cache = frame;
    const ctx = this._prepareCanvas(frame);
    this._draw(ctx, this._cssW, this._cssH, frame);
    this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    return this.lastFrameMs;
  }

  _draw(ctx, w, h, frame) {
    const { state, reqs, results, overlays } = frame;
    // `this._narrow`, not `w`, decides, so an SVG export repeats the screen.
    const box = this._narrow ? this._narrowBox(w) : plotBox(w, h, PAD);
    // The ranges actually drawn: the user's zoom windows where there are any
    // (task R4), otherwise exactly the ranges the frame computed.
    const xr = windowOf(state, VIEW, FGAMMA_X, frame.xr);
    const yr = windowOf(state, VIEW, FGAMMA_Y, frame.yr);

    if (this._isEmpty(frame)) {
      drawMessage(ctx, w, h, `no (${FGAMMA_X}, ${FGAMMA_Y}) Tier 1 grid for the selected run(s)`);
      return;
    }

    const px = getParam(FGAMMA_X);
    const py = getParam(FGAMMA_Y);
    const { sx, sy, ax, ay } = drawFrame(ctx, box, {
      xr,
      yr,
      xlabel: `${px.label} [${px.unit}]`,
      ylabel: `${py.label} [${py.unit}]`,
      grid: true,
    });

    // The zoomable panel. `ctx === this.ctx` only on the live canvas: an SVG
    // export draws at its own size, and its boxes must never be hit-tested.
    if (ctx === this.ctx) {
      this.hitAreas = [
        { box, ax, ay, xKey: zoomKey(VIEW, FGAMMA_X), yKey: zoomKey(VIEW, FGAMMA_Y) },
      ];
    }

    // Prior-box edges, where they fall inside the plotted range. The full
    // uncropped box is the diagnostics view's panel.
    ctx.save();
    ctx.strokeStyle = "#c9a0a0";
    ctx.lineWidth = 1.2;
    ctx.setLineDash([7, 4]);
    const bx = priorBox(FGAMMA_X, state.ev);
    const by = priorBox(FGAMMA_Y, state.ev);
    for (const v of bx) {
      if (v < xr[0] || v > xr[1]) continue;
      ctx.beginPath();
      ctx.moveTo(sx(v), box.y);
      ctx.lineTo(sx(v), box.y + box.h);
      ctx.stroke();
    }
    for (const v of by) {
      if (v < yr[0] || v > yr[1]) continue;
      ctx.beginPath();
      ctx.moveTo(box.x, sy(v));
      ctx.lineTo(box.x + box.w, sy(v));
      ctx.stroke();
    }
    ctx.restore();

    // Tier 2 points, under the contours.
    for (const sc of frame.scatter) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      // Request 1 verbatim: a mode's scatter point is the mode's contour colour.
      ctx.fillStyle = withAlpha(modeColor(sc.mode), 0.16);
      const n = Math.min(sc.x.length, sc.y.length);
      for (let i = 0; i < n; i++) ctx.fillRect(sx(sc.x[i]), sy(sc.y[i]), 1.3, 1.3);
      ctx.restore();
    }

    // Contours.
    for (let k = 0; k < reqs.length; k++) {
      const r = reqs[k];
      const res = results[k];
      if (!res) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      // COLOUR is the mode; DASH is the run composed with the level.
      const col = modeColor(r.mode);
      ctx.strokeStyle = col;
      ctx.fillStyle = withAlpha(col, FILL_ALPHA);
      ctx.lineWidth = 1.6;
      // `contourGrid` returns one entry per requested level, IN REQUEST ORDER,
      // so `res.levels[li]` is the level `frame.levs[li]`.
      for (let li = 0; li < res.levels.length; li++) {
        const L = res.levels[li];
        // One path per LEVEL, so the nonzero fill rule cuts a hole where one
        // ring of that level nests inside another. `SvgSurface.fill()` takes no
        // fill-rule argument and SVG also defaults to nonzero, so the screen and
        // the export agree.
        ctx.beginPath();
        for (const poly of L.rings) {
          for (let q = 0; q < poly.length; q += 2) {
            const ppx = sx(poly[q]);
            const ppy = sy(poly[q + 1]);
            if (q === 0) ctx.moveTo(ppx, ppy);
            else ctx.lineTo(ppx, ppy);
          }
          ctx.closePath();
        }
        ctx.fill();
        ctx.setLineDash(composeDash(r.dash, levelDash(frame.levs[li])));
        for (const poly of L.polylines) {
          ctx.beginPath();
          for (let q = 0; q < poly.length; q += 2) {
            const ppx = sx(poly[q]);
            const ppy = sy(poly[q + 1]);
            if (q === 0) ctx.moveTo(ppx, ppy);
            else ctx.lineTo(ppx, ppy);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // The Kerr prediction blobs. NEUTRAL colour, no fill, no run dash: a
    // prediction belongs to no run and to no sampler mode (see the header).
    // The credible-level dash is kept, so a 50% ring is told from a 99% one.
    for (let k = 0; k < frame.kreqs.length; k++) {
      const res = frame.kresults[k];
      if (!res) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      ctx.strokeStyle = MUTED_COLOR;
      ctx.lineWidth = 1.2;
      for (let li = 0; li < res.levels.length; li++) {
        ctx.setLineDash(levelDash(frame.levs[li]));
        for (const poly of res.levels[li].polylines) {
          ctx.beginPath();
          for (let q = 0; q < poly.length; q += 2) {
            const ppx = sx(poly[q]);
            const ppy = sy(poly[q + 1]);
            if (q === 0) ctx.moveTo(ppx, ppy);
            else ctx.lineTo(ppx, ppy);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    }

    // The nine maximum-likelihood prediction points and their labels. Drawn
    // after the contours so a dot is never hidden under a ring.
    for (const m of frame.kmaxl) {
      const cx = sx(m.f);
      const cy = sy(m.gamma);
      if (cx < box.x || cx > box.x + box.w || cy < box.y || cy > box.y + box.h) continue;
      ctx.save();
      ctx.setLineDash([]);
      ctx.fillStyle = TEXT_COLOR;
      dot(ctx, cx, cy, 3);
      ctx.font = BODY_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText(m.label, cx + 5, cy + 3);
      ctx.restore();
    }

    // Kerr crosses, when the optional field is there.
    for (const o of overlays) {
      if (o.predictions === null) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      // A Kerr prediction belongs to a RUN, not to a mode. It therefore takes
      // the run's DASH and a neutral colour: a coloured cross would read as a
      // mode under the new encoding.
      ctx.setLineDash(o.dash);
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = TEXT_COLOR;
      // THE CROSS CARRIES NO TEXT LABEL (fixed 2026-09-18, task T4 part 2).
      // The blob maximum-likelihood DOT above prints the same label a few
      // pixels away, and with the nine-blob overlay on, "2.2.0" and "2.2.1"
      // each appeared twice on the panel. The label is kept at the dot, which
      // is the point the label belongs to; the cross keeps its marker and the
      // legend names it. The size still separates the two: the reference label
      // gets the larger cross.
      for (const lab of KERR_DRAW_LABELS) {
        const p = o.predictions[lab];
        if (p === undefined) continue; // an absent 221 draws nothing
        cross(ctx, sx(p.f), sy(p.invTau), lab === KERR_REF_LABEL ? 8 : 6);
      }
      ctx.restore();
    }

    if (this._narrow) {
      this._legend(ctx, NARROW_LEGEND_X, box.y + box.h + PAD.bottom + NARROW_LEGEND_GAP, frame);
    } else {
      this._legend(ctx, w - PAD.right + 14, PAD.top + 6, frame);
    }
    void FRAME_COLOR;
  }

  /** True when `_draw` draws only a message, and so no legend. */
  _isEmpty(frame) {
    return (
      frame.reqs.length === 0 &&
      frame.scatter.length === 0 &&
      (frame.kreqs?.length ?? 0) === 0 &&
      (frame.kmaxl?.length ?? 0) === 0
    );
  }

  /** The plot area in the narrow layout: full width, height NARROW_ASPECT x width. */
  _narrowBox(w) {
    const bw = Math.max(10, w - PAD.left - NARROW_PAD_RIGHT);
    return { x: PAD.left, y: PAD.top, w: bw, h: NARROW_ASPECT * bw };
  }

  /** Draw the legend and ranking block from (lx, ly); returns the y below it. */
  _legend(ctx, lx, ly, frame) {
    // The legend STATES THE ENCODING, because it changed on 2026-09-16 and a
    // reader of an exported figure has no other way to recover it.
    const { overlays } = frame;
    const px = getParam(FGAMMA_X);
    const py = getParam(FGAMMA_Y);
    const bx = priorBox(FGAMMA_X, frame.state.ev);
    const by = priorBox(FGAMMA_Y, frame.state.ev);
    const levs = frame.levs ?? [];
    const nModes = frame.series.reduce((a, s) => Math.max(a, s.n), 0);

    // COLOUR = MODE.
    ly = drawLegend(
      ctx,
      lx,
      ly,
      Array.from({ length: nModes }, (_, m) => ({
        color: modeColor(m),
        label: `mode ${m}`,
        lineWidth: 2.4,
      })),
      "colour = mode index"
    );
    ly += 6;

    // DASH = RUN.
    ly = drawLegend(
      ctx,
      lx,
      ly,
      frame.series.map((s) => ({
        color: MUTED_COLOR,
        label: s.label,
        dash: s.dash ?? [],
        lineWidth: 1.4,
      })),
      ""
    );
    ly += 6;

    // DASH = CREDIBLE LEVEL, appended to the run's dash.
    ly = drawLegend(
      ctx,
      lx,
      ly,
      levs.map((L) => ({
        color: MUTED_COLOR,
        label: `${L}%`,
        dash: levelDash(L),
        lineWidth: 1.4,
      })),
      ""
    );
    ly += 6;

    ctx.save();
    ctx.font = BODY_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    ctx.fillStyle = MUTED_COLOR;
    const kerrLines = [`large cross: Kerr ${KERR_REF_LABEL}`];
    if (frame.kerrBlobAvailable) kerrLines.push("grey: Kerr blobs, dot = IMR max-L");
    for (const line of kerrLines) {
      ctx.fillText(line, lx, ly);
      ly += 14;
    }
    ctx.restore();
    return ly;
  }

  _prepareCanvas(frame) {
    const avail = availableWidth(this.canvas);
    this._narrow = isNarrow(avail);
    if (this._narrow) {
      const box = this._narrowBox(avail);
      const legendH = this._isEmpty(frame) ? 0 : measureBlock((c, x, y) => this._legend(c, x, y, frame));
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
