/**
 * views/fitband.js — whitened strain with the posterior fit band, per detector
 * (spec section 6, view 5).
 *
 * Part of the silencio interactive results application.
 *
 * This is the most direct view of whether the model tracks the ringdown: one
 * stacked panel per detector, the whitened data as a grey line, and the
 * posterior band of every run in the compare set on top of it.
 *
 * Data is Tier 4 (`tier4.js`, magic "SGB1"), fetched per run and dequantised
 * from int16 to Float64 by the reader.
 *
 * ONE BAND PER SELECTED LEVEL, NESTED (ruling 20)
 * -----------------------------------------------
 * Tier 4 stores `lo_<L>`/`hi_<L>` for EVERY level in `header.levels`, so unlike
 * the cross-run view this one can draw the whole selected set. `st.levs` is a
 * SET, the empty set is legal, and each selected level gets its own band in its
 * own `levelDash(L)` style. Levels nest, so the widest is drawn first and the
 * narrowest last; a point inside k bands has been filled k times and reads
 * darker, which is the second, redundant cue on top of the dash.
 *
 * WITH AN EMPTY LEVEL SET this view still draws the whitened strain and the
 * posterior medians. "No credible region" is a statement about the band, not an
 * instruction to blank the panel.
 *
 * THE `bandKeys` GUARD. `bandKeys(t4, level)` RAISES when a level is not among
 * the precomputed ones, and that raise is correct: Tier 4 bands cannot be
 * recomputed in the browser (the whitening does not factor through the
 * per-sample parameters), so there is no honest fallback, and drawing a 90%
 * band under a 50% label would be worse than an error message. But a raise on
 * the FRAME PATH would take the whole view down every time the rail offered a
 * level some payload happened to lack. So the payload's own `levels` list is
 * checked BEFORE the call: a level the payload does not carry is drawn as no
 * band and NAMED IN THE LEGEND. The raise is kept as the assertion it is, for
 * a caller that skips the check, and is never reached from here.
 *
 * COLOUR MEANS RUN IN THIS VIEW, AND RULING 18 DOES NOT APPLY. Tier 4 carries
 * no per-mode decomposition at all — there is no mode here to colour. So colour
 * stays the run, and the dash channel carries the credible LEVEL. The legend
 * states both, because this is the one view where dash is not the run.
 *
 * THE TIME AXIS IS ABSOLUTE, AND THAT MATTERS FOR OVERLAY (pitfall A1)
 * -------------------------------------------------------------------
 * Tier 4 stores `times` as SECONDS FROM ITS OWN ANALYSIS-WINDOW START, and the
 * window start moves with `t_start`. Two runs at different `t_start` therefore
 * have different meanings for "t = 0". Plotting them on a shared
 * window-relative axis would slide one band along the other and invite a
 * conclusion about a shift that is pure bookkeeping.
 *
 * So this view converts to milliseconds relative to the TRIGGER:
 *
 *     x = (window_start_gps - trigger_gps) * 1e3 + 1e3 * t_within_window
 *
 * using the header's own `window_start_gps` and `trigger_gps`. Every run then
 * sits on one physical axis and an overlay is meaningful.
 *
 * OTHER CONVENTIONS (A1):
 *   * The band and the strain are in WHITENED space, in units of sigma. They
 *     are dimensionless; `whitened_rms` near 1 is the sanity check, and it is
 *     printed per detector so a badly whitened segment is visible.
 *   * The band is a POSTERIOR band over `n_draw` draws at `band_rng_seed`. It
 *     is NOT a confidence interval on the data, and it is not a residual.
 *   * The stored arrays are int16 with a per-array scale: lossy at about 3e-5
 *     of each array's peak, which is invisible here but is not exact.
 *   * `t_start` is in M_rem with origin at the IMR maximum-likelihood peak GPS.
 *
 * THE STRAIN IS DRAWN FROM THE LIVE RUN ONLY. Every run of one event and
 * configuration carries the same whitened data over its own window, so drawing
 * all of them would stack identical curves and darken the overlap into
 * something that looks like a wider band.
 */

import { bandKeys, timesMs } from "../tier4.js";
import { withAlpha } from "../colors.js";
import { levelDash } from "../config.js";
import { levelsOf, runKey, windowOf, zoomKey } from "../state.js";
import {
  BODY_FONT,
  MUTED_COLOR,
  NARROW_LEGEND_GAP,
  NARROW_LEGEND_X,
  NARROW_PAD_RIGHT,
  TEXT_COLOR,
  availableWidth,
  drawFrame,
  drawLegend,
  drawMessage,
  fillBand,
  isNarrow,
  measureBlock,
  padRange,
  plotBox,
  setCanvasCssSize,
  strokeSeries,
  unionRange,
} from "./plotutil.js";

/** Colour of the whitened data line. Value: a mid grey, under every band. */
export const STRAIN_COLOR = "#8a8a8a";

/** Fill alpha of ONE credible band. Value: 0.13, the same for every level.
 *
 *  Why one alpha and not three. The levels NEST, so the fills compound: a point
 *  inside k of them is painted k times and reaches 1 - (1 - 0.13)^k, i.e. 0.13,
 *  0.24, 0.34 for k = 1, 2, 3. That is a monotone darkening towards the median
 *  with no tuning, and it stays correct for any SUBSET the rail selects —
 *  including a single level, where a hand-tuned "innermost" alpha would be
 *  wrong. 0.13 is chosen so three stacked bands reach about a third opacity,
 *  which stays readable over the grey strain line rather than hiding it.
 *
 *  The dash of each band edge (`config.levelDash`) is the primary, redundant
 *  cue; this alpha is the secondary one. */
export const BAND_FILL_ALPHA = 0.13;

/** Stroke width of a band edge, in CSS pixels. Value: 1.0, thinner than the
 *  median at 1.2, so the median stays the dominant line in the panel. */
export const BAND_EDGE_WIDTH = 1.0;

/** Colour of the credible-level dash key in the legend. Value: "#444444", a
 *  neutral that belongs to no run, because the dash key describes the LEVEL
 *  channel and applies to every run's colour alike. */
export const LEVEL_KEY_COLOR = "#444444";

/** This view's key in the view registry, and the prefix of its window keys. */
const VIEW = "fitband";

/** Window key of the shared time axis, in ms relative to the trigger. */
const X_AXIS_ID = "t_ms";

const PAD = Object.freeze({ left: 76, right: 236, top: 20, bottom: 56 });
const GAP_Y = 52;

/** Height of one detector panel in the narrow (phone) layout. Value: 200 CSS px. */
export const NARROW_PANEL_H = 200;

export class FitBandView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lastFrameMs = NaN;
    /** Panels the interaction layer may zoom; republished on every frame. */
    this.hitAreas = [];
    /** Last prepared frame, so SVG export redraws without refetching. */
    this._cache = null;
  }

  /**
   * Draw one frame.
   *
   * @param {Object} args
   * @param {Object} args.state @param {Object} args.loader @param {Object[]} args.series
   * @param {Object} [args.ctxOverride] draw here instead of the canvas (SVG export)
   * @returns {number} frame ms
   */
  render({ state, loader, series, ctxOverride }) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();

    // This view needs no worker, so `ctxOverride` runs the FULL prepare-and-draw
    // path rather than replaying a cached frame. That keeps SVG export exact
    // even on the first frame, and it is what lets the view be rendered — and
    // therefore tested — outside a browser, against a real Tier 4 file.

    // 1. Collect the resident Tier 4 blocks. main.js queues the fetches.
    const blocks = [];
    for (const s of series) {
      const t4 = loader.tier4Cached(s.cfg, s.n, s.t);
      if (t4 === undefined) continue;
      blocks.push({ s, t4, key: runKey(s.cfg, s.n, s.t) });
    }

    const frame = { state, series, blocks };
    if (blocks.length) {
      // 2. Detector panels: the union of the detectors present, in the order
      //    the first block lists them (H1 is the reference detector).
      const dets = [];
      for (const b of blocks) for (const d of b.t4.detectors) if (!dets.includes(d)) dets.push(d);
      frame.dets = dets;

      // 3. One absolute time axis in ms relative to the trigger, per block,
      //    and the band-edge arrays for every selected level the payload has.
      const levs = levelsOf(state);
      frame.levs = levs;
      /** Selected levels absent from at least one payload, for the legend. */
      const missing = [];
      for (const b of blocks) {
        const h = b.t4.header;
        const off = 1e3 * (Number(h.window_start_gps) - Number(h.trigger_gps));
        if (!Number.isFinite(off)) {
          throw new Error(
            `fitband: ${b.key} header has window_start_gps=${h.window_start_gps}, ` +
              `trigger_gps=${h.trigger_gps}; an absolute time axis is not ` +
              `constructible, and a window-relative overlay of runs at ` +
              `different t_start would be misleading`
          );
        }
        const tms = timesMs(b.t4);
        const abs = new Float64Array(tms.length);
        for (let i = 0; i < tms.length; i++) abs[i] = off + tms[i];
        b.tAbs = abs;
        // Widest level first, so the nested fills compound inwards and the
        // narrowest band is drawn last and stays visible.
        b.bands = [];
        for (const L of [...levs].sort((p, q) => q - p)) {
          // GUARDED: `bandKeys` raises on a level this payload does not carry,
          // so the payload's own list is consulted first. A missing level is
          // drawn as no band and named in the legend, never substituted.
          if (!b.t4.levels.includes(L)) {
            if (!missing.includes(L)) missing.push(L);
            continue;
          }
          const k = bandKeys(b.t4, L);
          b.bands.push({ level: L, lo: k.lo, hi: k.hi, dash: levelDash(L) });
        }
      }
      frame.missing = missing.sort((p, q) => p - q);

      const xs = [];
      for (const b of blocks) {
        xs.push(b.tAbs[0], b.tAbs[b.tAbs.length - 1]);
      }
      frame.xr = padRange(unionRange(xs) ?? [0, 1], 0.01);

      // 4. A shared y range per detector over the strain and every band.
      frame.yr = new Map();
      for (const d of dets) {
        const vals = [];
        for (const b of blocks) {
          const a = b.t4.arrays[d];
          if (a === undefined) continue;
          // "median" is included so that an EMPTY level set, which draws no
          // band at all, still yields a y range that contains the medians.
          const names = ["strain", "median"];
          for (const q of b.bands) names.push(q.lo, q.hi);
          for (const name of names) {
            const col = a[name];
            for (let i = 0; i < col.length; i += 8) vals.push(col[i]);
          }
        }
        frame.yr.set(d, padRange(unionRange(vals) ?? [-4, 4], 0.05));
      }
      frame.live = series.find((s) => !s.isPin) ?? series[0];
      frame.liveBlock =
        blocks.find((b) => frame.live && b.key === runKey(frame.live.cfg, frame.live.n, frame.live.t)) ??
        blocks[0];
    }

    this._cache = frame;
    const ctx = ctxOverride ?? this._prepareCanvas(frame);
    const w = ctxOverride ? ctxOverride.width : this._cssW;
    const h = ctxOverride ? ctxOverride.height : this._cssH;
    this._draw(ctx, w, h, frame);
    this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    return this.lastFrameMs;
  }

  _draw(ctx, w, h, frame) {
    const { state, blocks } = frame;
    if (!blocks || blocks.length === 0) {
      drawMessage(ctx, w, h, "fetching the Tier 4 fit band …");
      return;
    }
    const dets = frame.dets;
    if (ctx === this.ctx) this.hitAreas = [];
    const nr = dets.length;
    // Narrow: fixed-height panels and the legend below them. `this._narrow`,
    // not `w`, decides, so an SVG export repeats the layout on the screen.
    const outer = this._narrow
      ? { x: PAD.left, y: PAD.top, w: Math.max(10, w - PAD.left - NARROW_PAD_RIGHT), h: this._plotH(nr) }
      : plotBox(w, h, PAD);
    const ph = (outer.h - (nr - 1) * GAP_Y) / nr;

    dets.forEach((d, r) => {
      const box = { x: outer.x, y: outer.y + r * (ph + GAP_Y), w: outer.w, h: ph };
      // One shared time window across detectors, one strain window per
      // detector: the panels are stacked on a common x axis, so zooming one
      // must move both, while their amplitudes are independent.
      const { sx, sy, ax, ay } = drawFrame(ctx, box, {
        xr: windowOf(state, VIEW, X_AXIS_ID, frame.xr),
        yr: windowOf(state, VIEW, `strain_${d}`, frame.yr.get(d)),
        xlabel: "t − t_trigger [ms]",
        ylabel: `${d} whitened strain [σ]`,
        grid: true,
        yTarget: 4,
      });
      if (ctx === this.ctx) {
        this.hitAreas.push({
          box,
          ax,
          ay,
          xKey: zoomKey(VIEW, X_AXIS_ID),
          yKey: zoomKey(VIEW, `strain_${d}`),
        });
      }

      // The whitened data, from the live run only.
      const lb = frame.liveBlock;
      if (lb && lb.t4.arrays[d] !== undefined) {
        ctx.save();
        ctx.strokeStyle = STRAIN_COLOR;
        ctx.lineWidth = 0.8;
        ctx.setLineDash([]);
        strokeSeries(ctx, box, lb.tAbs, lb.t4.arrays[d].strain, sx, sy);
        ctx.restore();
      }

      // Every run's bands, then its median on top.
      //
      // COLOUR IS THE RUN, DASH IS THE CREDIBLE LEVEL. `b.bands` is already
      // ordered widest-first, so the fills compound inwards (BAND_FILL_ALPHA)
      // and the narrowest level ends up darkest. An empty `b.bands` — the empty
      // level set, or a payload missing every selected level — simply draws no
      // band and leaves the strain and the median.
      for (const b of blocks) {
        const a = b.t4.arrays[d];
        if (a === undefined) continue;
        for (const q of b.bands) {
          ctx.fillStyle = withAlpha(b.s.color, BAND_FILL_ALPHA);
          fillBand(ctx, box, b.tAbs, a[q.lo], a[q.hi], sx, sy);
          ctx.save();
          ctx.strokeStyle = b.s.color;
          ctx.lineWidth = BAND_EDGE_WIDTH;
          ctx.setLineDash(q.dash);
          strokeSeries(ctx, box, b.tAbs, a[q.lo], sx, sy);
          strokeSeries(ctx, box, b.tAbs, a[q.hi], sx, sy);
          ctx.restore();
        }
        ctx.save();
        ctx.strokeStyle = b.s.color;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([]);
        strokeSeries(ctx, box, b.tAbs, a.median, sx, sy);
        ctx.restore();
      }

      // Per-detector header: the whitening sanity check, in the panel.
      const rms = frame.liveBlock?.t4.header?.whitened_rms?.[d];
      ctx.save();
      ctx.font = BODY_FONT;
      ctx.fillStyle = MUTED_COLOR;
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.fillText(
        Number.isFinite(Number(rms))
          ? `${d}   whitened RMS = ${Number(rms).toFixed(4)} σ (1 is ideal)`
          : d,
        box.x,
        box.y - 4
      );
      ctx.restore();
    });

    if (this._narrow) {
      this._legend(ctx, NARROW_LEGEND_X, outer.y + outer.h + PAD.bottom + NARROW_LEGEND_GAP, frame);
    } else {
      this._legend(ctx, w - PAD.right + 14, PAD.top + 6, frame);
    }
  }

  /** Height of the stacked panels, gaps included, in the narrow layout. */
  _plotH(nr) {
    return nr * NARROW_PANEL_H + (nr - 1) * GAP_Y;
  }

  /** Draw the legend block from (lx, ly); returns the y below it. */
  _legend(ctx, lx, ly, frame) {
    const { blocks } = frame;
    // Legend, part 1: COLOUR, which in this view means the RUN.
    const levs = frame.levs ?? [];
    ly = drawLegend(
      ctx,
      lx,
      ly,
      [
        { color: STRAIN_COLOR, label: "whitened data", lineWidth: 1.4 },
        ...blocks.map((b) => ({ color: b.s.color, label: b.s.label })),
      ],
      levs.length
        ? `colour = run; band ${levs.join(", ")}%`
        : "colour = run; no band drawn"
    );
    ly += 8;

    // Legend, part 2: DASH, which in this view means the credible LEVEL. The
    // key is drawn in a neutral colour because it applies to every run alike.
    if (levs.length) {
      ly = drawLegend(
        ctx,
        lx,
        ly,
        levs.map((L) => ({
          color: LEVEL_KEY_COLOR,
          label: `${L}% band edge`,
          dash: levelDash(L),
          lineWidth: BAND_EDGE_WIDTH + 0.6,
        })),
        ""
      );
      ly += 8;
    }
    const h0 = blocks[0].t4.header;
    ctx.save();
    ctx.font = BODY_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText("line: posterior median", lx, ly);
    ly += 15;
    ctx.fillStyle = MUTED_COLOR;
    for (const line of [
      `band from ${h0.n_draw} posterior draws`,
      `at band_rng_seed = ${h0.band_rng_seed}`,
      "",
      "This is a POSTERIOR band over",
      "draws, not a confidence interval",
      "on the data and not a residual.",
      "",
      `${h0.M} samples at ${h0.sample_rate} Hz,`,
      `analysis duration ${h0.analysis_duration_s} s.`,
      "Stored int16 with a per-array",
      "scale: lossy at ~3e-5 of each",
      "array's peak.",
      "",
      "x is relative to the trigger, so",
      "runs at different t_start overlay",
      "on one physical axis.",
    ]) {
      if (line !== "") ctx.fillText(line, lx, ly);
      ly += 14;
    }
    ctx.restore();
    return ly;
  }

  _prepareCanvas(frame) {
    const avail = availableWidth(this.canvas);
    this._narrow = isNarrow(avail);
    if (this._narrow && frame.blocks.length) {
      const legendH = measureBlock((c, x, y) => this._legend(c, x, y, frame));
      const hh = PAD.top + this._plotH(frame.dets.length) + PAD.bottom + NARROW_LEGEND_GAP + legendH;
      setCanvasCssSize(this.canvas, avail, hh);
    } else if (this._narrow) {
      setCanvasCssSize(this.canvas, avail, avail);
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
