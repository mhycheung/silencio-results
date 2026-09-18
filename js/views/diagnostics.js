/**
 * views/diagnostics.js — sampler diagnostics (spec section 6, view 4).
 *
 * Part of the silencio interactive results application.
 *
 * REBUILT BY TASK R6 (request 5: "the diagnostics labels overlap and are
 * unreadable; show ALL the per-chain diagnostics").
 *
 * WHAT CHANGED, AND WHY
 * ---------------------
 * 1. THE GRID IS COMPUTED, NOT FIXED. The panels used to be a hard-coded 3x2
 *    with literal divisors (`(outer.w - GAP.x) / 2`, `(outer.h - 2*GAP.y) / 3`).
 *    Adding a seventh panel to that layout overflowed the surface SILENTLY.
 *    The panels are now a frozen registry (`PANELS`) and the grid is derived
 *    from its length, so adding a panel re-flows the view instead of drawing
 *    off the canvas. Selection goes through `panelSpec`, which RAISES on an
 *    unregistered key (pitfall A4) — never a silent skip.
 *
 * 2. EVERY PANEL IS TITLED. In a nine-panel grid a panel is no longer
 *    identifiable from its axis labels alone.
 *
 * 3. THE PER-CHAIN TRACES ARE COMPLETE. The view drew one trace panel, for
 *    `f`. It now draws one per parameter in `TRACE_PARAMS`, which is the
 *    content of the predecessor project's `trace_all.png`.
 *
 * 4. THE EM-CLUSTER PANEL IS HERE (task R6-emcluster). It was reported missing
 *    by task R6, which owned neither the reader nor the fetch path. Both now
 *    exist: `MAGIC_TIER6`/`TIER6_N_KEEP` in `config.js`, `parseTier6` in
 *    `format.js`, `loader.tier6` and the `ensureData` branch in `main.js`.
 *
 * THE EM-CLUSTER PANEL, AND WHAT IT SHOWS
 * ---------------------------------------
 * It is the browser form of the predecessor project's
 * `chain_emlabel{k}_f_vs_gamma.png` (`postprocessing/diagnostics.py`,
 * `_draw_chain_panel`). EM is the sampler's expectation-maximisation mode
 * classifier: it fits one Gaussian per mode in the (f, gamma) plane and
 * relabels the modes as the chains move. The panel answers "did the mode
 * classification settle, and did the chains settle on the SAME clusters".
 *
 *   * The cloud is the (f, gamma) history of the cold chains, coloured by SWEEP
 *     NUMBER on a viridis ramp: dark purple early, yellow late.
 *   * Each thin ellipse is one EM snapshot's 1-sigma cluster, in the same
 *     sweep colour. THE ELLIPSES MIGRATING ACROSS THE PANEL ARE THE DRIFT; that
 *     migration is the content of the figure.
 *   * The thick red ellipses are the CURRENT per-chain EM clusters, one per
 *     cold chain and hyper-cluster.
 *   * The thick blue dashed ellipses are the hyper-EM reference clusters, which
 *     are shared across chains. A red ellipse far from its blue reference is a
 *     chain that classified its modes differently from the consensus.
 *   * Crosses are divergences: grey before burn-in, black after.
 *
 * THE COLOUR AXIS IS THE FULL SWEEP HISTORY INCLUDING WARMUP, 0 .. n_sweeps.
 * Tier 2 keeps post-burn-in draws only, so this panel CANNOT be drawn from
 * Tier 2 and does not try: it draws from Tier 6 or it says it is waiting.
 *
 * THE 4-VS-8 TRAP IN THIS PANEL. `samples.h5` is 4 cold chains plus 4 hot ones,
 * and its EM arrays are 8 deep while its sample arrays are 4 deep. Tier 6 ships
 * the cold block only and records `n_cold`; this panel takes its chain count
 * from that header field and never from an array's first axis. The hot chains'
 * EM fits are not in the payload and are drawn nowhere.
 *
 * WHICH PER-CHAIN SLOT IS WHICH MODE DIFFERS PER CHAIN, and that is the whole
 * point of the figure. For hyper-cluster `k` the raw per-chain slot is
 * `hyper_perms[c][k]` now, and `em_match_perm[s][c][k]` at snapshot `s`. The
 * legend prints the current mapping.
 *
 * WHY THE PRIOR-BOX PANEL IS DRAWN UNCROPPED
 * ------------------------------------------
 * Spec section 6 requires the page to show "the prior box, uncropped,
 * including posterior mass at the edge". The axes of that panel are the FULL
 * prior box (`f` in [20, 1024] Hz, `gamma` in [1, 2500] 1/s from
 * config.priorBox), not the posterior range, so a posterior pressed against a
 * bound is visible as such instead of being scaled away. The occupancy numbers
 * beside it are the fraction of samples within `config.PRIOR_EDGE_FRAC` of
 * each bound.
 *
 * THE CHAIN-COUNT TRAP, and why the traces are drawn this way
 * -----------------------------------------------------------
 * The posterior is the COLD block only. `samples.h5` reports `n_chains = 4`
 * while several of its arrays are 8 deep (4 cold + 4 hot). In the browser the
 * chain count comes from Tier 2's `chain_boundaries` and NEVER from an array's
 * length, so the trace panels split the block at those boundaries. Getting
 * this wrong would draw four chains as one and make a badly mixed sampler look
 * converged. EVERY per-chain panel says so in the rendered figure: the legend
 * names the chains "cold chain c" and the notice block states that the hot
 * chains are not drawn anywhere on this page.
 *
 * CONVENTIONS (pitfall A1, restated at the point of use):
 *   * `t_start` in M_rem, origin at the IMR maximum-likelihood peak GPS time.
 *   * `f` in Hz; the damping variable is the RATE `gamma = 1/tau` in 1/s.
 *   * The trace x axis is the sample index WITHIN the cold block, after
 *     burn-in. It is not a sweep count.
 *   * Mode indices are sampler EM indices, not QNM labels, never ordered by
 *     amplitude (`A_true` is nan on real data).
 */

import { PIN_PALETTE, withAlpha } from "../colors.js";
import { PRIOR_EDGE_FRAC, SWEEP_CMAP_STOPS, getParam, priorBox } from "../config.js";
import { t6Cov, t6Mean, t6ScatterIndex, tier2Param } from "../format.js";
import { windowOf, zoomKey } from "../state.js";
import {
  BODY_FONT,
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
  fmtNum,
  isNarrow,
  measureBlock,
  padRange,
  plotBox,
  setCanvasCssSize,
  strokeSeries,
  unionRange,
} from "./plotutil.js";

/**
 * The Tier 3 metric panels: field, label, and the reference line to draw.
 *
 * `ref` is a conventional threshold, drawn as a dashed rule so the panel can be
 * read without remembering the number. R-hat 1.01 and ESS 400 are the usual
 * convergence conventions; they are NOT gates of this campaign, and the panel
 * labels them "convention", not "pass".
 *
 * `refShort` is the fallback drawn when the panel is too narrow for the full
 * label. Declared rather than derived, so a narrow panel never silently shows
 * a truncated word.
 */
export const METRICS = Object.freeze([
  { field: "max_rhat", label: "max R-hat", unit: "", ref: 1.01, refLabel: "1.01 (convention)", refShort: "1.01" },
  { field: "min_ess", label: "min ESS", unit: "samples", ref: 400, refLabel: "400 (convention)", refShort: "400" },
  { field: "divergences", label: "divergences", unit: "count", ref: null, refLabel: null, refShort: null },
  { field: "snr", label: "SNR", unit: "", ref: null, refLabel: null, refShort: null },
]);

/** Parameters whose prior-edge occupancy is reported. */
export const EDGE_PARAMS = Object.freeze(["f", "gamma"]);

/**
 * Parameters given a per-chain trace panel, in display order.
 * Value: ["f", "gamma", "A", "epsilon"].
 *
 * This is the parameter set of the predecessor project's `trace_all.png`
 * (`postprocessing/diagnostics.py`), which is what "all the per-chain
 * diagnostics" means for the trace family. `A` and `epsilon` are DERIVED in
 * the browser from the stored [cR, sR, cL, sL] columns by `physical.js`; they
 * are not stored.
 */
export const TRACE_PARAMS = Object.freeze(["f", "gamma", "A", "epsilon"]);

/**
 * Viridis anchor colours, as [fraction, r, g, b], ascending in fraction.
 *
 * Value: the 9 standard viridis samples at 0, 1/8, ... 1. This is the colour
 * map the predecessor project's figure uses (`Normalize(0, n_samp)` with
 * `viridis`), so a reader who knows that figure reads this one the same way:
 * dark purple = early sweeps, yellow = late.
 *
 * Declared HERE and nowhere else (A4). It is local to this view because no
 * other view has a sweep axis to colour.
 */
const VIRIDIS_ANCHORS = Object.freeze([
  [0.0, 68, 1, 84],
  [0.125, 72, 40, 120],
  [0.25, 62, 73, 137],
  [0.375, 49, 104, 142],
  [0.5, 38, 130, 142],
  [0.625, 31, 158, 137],
  [0.75, 53, 183, 121],
  [0.875, 109, 205, 89],
  [1.0, 253, 231, 37],
]);

/** Lazily built lookup of SWEEP_CMAP_STOPS viridis colours. */
let SWEEP_LUT = null;

/**
 * The viridis colour at fraction `u` of the sweep range, clamped to [0, 1].
 *
 * @param {number} u 0 at sweep 0, 1 at sweep n_sweeps
 * @param {number} [alpha]
 * @returns {string} a CSS rgba() colour
 */
export function sweepColor(u, alpha = 1) {
  if (!Number.isInteger(SWEEP_CMAP_STOPS) || SWEEP_CMAP_STOPS < 2) {
    throw new Error(
      `diagnostics.sweepColor: config.SWEEP_CMAP_STOPS=${SWEEP_CMAP_STOPS} must be an integer >= 2`
    );
  }
  if (SWEEP_LUT === null) {
    SWEEP_LUT = [];
    for (let i = 0; i < SWEEP_CMAP_STOPS; i++) {
      const f = i / (SWEEP_CMAP_STOPS - 1);
      let j = 0;
      while (j < VIRIDIS_ANCHORS.length - 2 && f > VIRIDIS_ANCHORS[j + 1][0]) j++;
      const [f0, r0, g0, b0] = VIRIDIS_ANCHORS[j];
      const [f1, r1, g1, b1] = VIRIDIS_ANCHORS[j + 1];
      const w = f1 === f0 ? 0 : (f - f0) / (f1 - f0);
      SWEEP_LUT.push([
        Math.round(r0 + w * (r1 - r0)),
        Math.round(g0 + w * (g1 - g0)),
        Math.round(b0 + w * (b1 - b0)),
      ]);
    }
  }
  const c = Number.isFinite(u) ? Math.min(1, Math.max(0, u)) : 0;
  const [r, g, b] = SWEEP_LUT[Math.round(c * (SWEEP_CMAP_STOPS - 1))];
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * The 1-sigma ellipse of a symmetric 2x2 covariance.
 *
 * TRANSCRIBED from `silencio.postprocessing.diagnostics._draw_2d_ellipse`
 * (line 773), which is the definition the production figure uses, and mirrored
 * by `site/data/emdiag.ellipse_1sigma`:
 *
 *     vals, vecs = np.linalg.eigh(cov_2d)
 *     vals = np.maximum(vals, 1e-10)
 *     w, h = 2.0 * np.sqrt(vals)
 *     ang = np.degrees(np.arctan2(vecs[1, 0], vecs[0, 0]))
 *
 * `numpy.linalg.eigh` returns the eigenvalues ASCENDING, so `w` belongs to the
 * SMALLER eigenvalue and the angle is that of the FIRST eigenvector. This
 * closed form reproduces that ordering. An eigenvector's SIGN is arbitrary in
 * both implementations, so the angle may differ from numpy's by 180 degrees;
 * the ellipse it describes is identical.
 *
 * @param {number[][]} cov [[xx, xy], [xy, yy]]
 * @returns {{w: number, h: number, angleDeg: number}} full axis LENGTHS, not
 *          semi-axes — `w` is 2*sqrt(lambda_min), as in the source.
 */
export function ellipse1Sigma(cov) {
  const a = cov[0][0];
  const b = cov[0][1];
  const d = cov[1][1];
  const half = (a + d) / 2;
  const disc = Math.sqrt(((a - d) / 2) ** 2 + b * b);
  const l0 = Math.max(half - disc, 1e-10); // smaller eigenvalue
  const l1 = Math.max(half + disc, 1e-10);
  // Eigenvector of the SMALLER eigenvalue, normalised.
  let vx;
  let vy;
  if (b !== 0) {
    vx = b;
    vy = l0 - a;
  } else if (a <= d) {
    vx = 1;
    vy = 0;
  } else {
    vx = 0;
    vy = 1;
  }
  const norm = Math.hypot(vx, vy) || 1;
  vx /= norm;
  vy /= norm;
  return {
    w: 2 * Math.sqrt(l0),
    h: 2 * Math.sqrt(l1),
    angleDeg: (Math.atan2(vy, vx) * 180) / Math.PI,
  };
}

/** Segments used to draw one ellipse as a polyline. Value: 48.
 *  A polyline, not `ctx.ellipse`, because `surface.SvgSurface` implements only
 *  the Canvas 2D subset the views already use, and SVG export must not lose
 *  the ellipses. 48 segments is smooth at every panel size this grid produces. */
const ELLIPSE_SEGMENTS = 48;

/** Colour of the CURRENT per-chain EM cluster. Value: "#d62728" (red). */
const EM_CURRENT_COLOR = "#d62728";

/** Colour of the hyper-EM reference cluster. Value: "#1f77b4" (blue). */
const EM_REF_COLOR = "#1f77b4";

/** This view's key in the view registry, and the prefix of its window keys. */
const VIEW = "diagnostics";

/** Window key of the shared t_start axis of the four metric panels. */
const X_AXIS_ID = "t_start";

/** Window key of the shared sample-index axis of the trace panels. */
const TRACE_X_AXIS_ID = "trace_index";

/** Window keys of the EM-cluster panel's two axes (task R4: every panel zooms). */
const EM_X_AXIS_ID = "em_f";
const EM_Y_AXIS_ID = "em_gamma";

/**
 * THE PANEL REGISTRY (pitfall A4). Every panel this view can draw is declared
 * here, once, in display order. The grid is computed from the LENGTH of this
 * array, so adding an entry re-flows the view; nothing downstream carries a
 * panel count.
 */
export const PANELS = Object.freeze([
  ...METRICS.map((m) =>
    Object.freeze({
      key: `metric_${m.field}`,
      kind: "metric",
      field: m.field,
      title: `${m.label} vs t_start`,
    })
  ),
  ...TRACE_PARAMS.map((p) =>
    Object.freeze({
      key: `trace_${p}`,
      kind: "trace",
      param: p,
      title: `per-chain trace: ${getParam(p).label}`,
    })
  ),
  Object.freeze({
    key: "emcluster",
    kind: "emcluster",
    title: "EM clusters during sampling",
  }),
  Object.freeze({ key: "priorbox", kind: "priorbox", title: "prior box, UNCROPPED" }),
]);

/** Every registered panel key, in display order. */
export const PANEL_KEYS = Object.freeze(PANELS.map((p) => p.key));

/**
 * Registry lookup. RAISES on an unregistered key (A4) — no silent skip.
 *
 * The failure this prevents: a panel key that no longer matches the registry
 * would otherwise leave a blank cell in the grid, which reads as "this
 * diagnostic is clean" rather than "this diagnostic was not drawn".
 *
 * @param {string} key
 */
export function panelSpec(key) {
  const p = PANELS.find((q) => q.key === key);
  if (p === undefined) {
    throw new Error(
      `diagnostics.panelSpec: unregistered panel "${key}". Registered: ${PANEL_KEYS.join(", ")}`
    );
  }
  return p;
}

/** Maximum panel columns, whatever the panel count. Value: 3.
 *  Four columns on a 1000 px canvas leaves under 150 px per panel, at which
 *  point the axis labels cost more room than the data. */
export const MAX_COLS = 3;

/** Panel columns in the narrow (phone) layout. Value: 1. */
export const NARROW_COLS = 1;

/** Height of one panel in the narrow layout. Value: 240 CSS px. */
export const NARROW_PANEL_H = 240;

/**
 * The grid shape for `n` panels: at most `maxCols` columns, otherwise as square
 * as possible. Declared as a function so the layout has ONE definition (A4).
 * @param {number} n
 * @param {number} [maxCols] MAX_COLS on a wide canvas, NARROW_COLS on a phone
 * @returns {{cols: number, rows: number}}
 */
export function gridShape(n, maxCols = MAX_COLS) {
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`diagnostics.gridShape: panel count must be a positive integer, got ${n}`);
  }
  if (!Number.isInteger(maxCols) || maxCols < 1) {
    throw new Error(`diagnostics.gridShape: maxCols must be a positive integer, got ${maxCols}`);
  }
  const cols = Math.min(maxCols, Math.ceil(Math.sqrt(n)));
  return { cols, rows: Math.ceil(n / cols) };
}

/* Margins. `right` is the legend column; `top` leaves room for the first row's
   panel title, `bottom` for the last row's axis title. */
const PAD = Object.freeze({ left: 74, right: 236, top: 26, bottom: 44 });

/* Gaps between panels. `x` must clear a panel's y tick labels plus its rotated
   y title (about 66 px); `y` must clear the axis title of the panel above
   (36 px below its box) plus the panel title of the panel below (24 px above
   its box). */
const GAP = Object.freeze({ x: 72, y: 64 });

export class DiagnosticsView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lastFrameMs = NaN;
    /** Panels the interaction layer may zoom; republished on every frame. */
    this.hitAreas = [];
    /**
     * What the EM-cluster panel actually drew, republished on every LIVE frame
     * and `null` while the Tier 6 block is not resident.
     *
     * Published so a gate can check the numbers the panel DREW against the
     * numbers an independent reader gets from the same file, rather than
     * re-implementing the panel's arithmetic and checking that against itself.
     */
    this.lastEm = null;
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
    // The prior box is per event (config.priorBox); the panel helpers read it here.
    this._ev = state.ev;
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();

    const nModesList = [...state.n].sort((a, b) => a - b);

    // Tier 3 metric series, one per mode count.
    const metricData = new Map(); // `${n}|${field}` -> {ts, vs, bad}
    let nFound = 0;
    for (const n of nModesList) {
      let times = [];
      try {
        times = loader.startTimes(state.cfg, n);
      } catch (e) {
        times = [];
      }
      for (const m of METRICS) {
        const ts = [];
        const vs = [];
        const bad = [];
        for (const t of times) {
          const rec = loader.summaryOf(state.cfg, n, t);
          if (rec === undefined) continue;
          const v = Number(rec[m.field]);
          if (!Number.isFinite(v)) continue;
          ts.push(t);
          vs.push(v);
          bad.push(rec.status !== "converged");
          nFound++;
        }
        metricData.set(`${n}|${m.field}`, { ts, vs, bad });
      }
    }

    const live = series.find((s) => !s.isPin) ?? series[0];
    const t2 = live ? loader.tier2Cached(live.cfg, live.n, live.t) : undefined;
    // Tier 6 is fetched by `main.ensureData`, never from inside a view: a view
    // has no redraw callback, so a fetch started here could not show its own
    // result. The panel draws what is resident and says so when it is not.
    const t6 = live ? loader.tier6Cached(live.cfg, live.n, live.t) : undefined;

    // The canvas is sized only now: the narrow layout's height depends on the
    // legend, and the legend on the blocks just looked up.
    const ctx = ctxOverride ?? this._prepareCanvas(nFound > 0, { nModesList, t2, t6, live });
    const w = ctxOverride ? ctxOverride.width : this._cssW;
    const h = ctxOverride ? ctxOverride.height : this._cssH;

    if (nFound === 0) {
      drawMessage(ctx, w, h, `no Tier 3 summary rows for configuration "${state.cfg}"`);
      this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
      return this.lastFrameMs;
    }

    // ---- the computed grid.
    // `this._narrow`, not `w`, decides, so an SVG export repeats the screen.
    const narrow = this._narrow;
    const { cols, rows } = gridShape(PANELS.length, narrow ? NARROW_COLS : MAX_COLS);
    const outer = narrow
      ? { x: PAD.left, y: PAD.top, w: Math.max(10, w - PAD.left - NARROW_PAD_RIGHT), h: this._plotH(rows) }
      : plotBox(w, h, PAD);
    const cw = (outer.w - (cols - 1) * GAP.x) / cols;
    const chh = (outer.h - (rows - 1) * GAP.y) / rows;
    const cellOf = (i) => ({
      x: outer.x + (i % cols) * (cw + GAP.x),
      y: outer.y + Math.floor(i / cols) * (chh + GAP.y),
      w: cw,
      h: chh,
    });

    const liveT = new Set(state.t);
    if (!ctxOverride) this.hitAreas = [];

    // The Kerr maximum-likelihood mode predictions of this run, from Tier 3.
    // On real data these ARE finite, while `A_true` is nan — so they are drawn
    // as truth markers and nothing here is ever ranked by amplitude.
    const kerr = live ? loader.summaryOf(live.cfg, live.n, live.t)?.kerr : undefined;

    const occupancy = [];

    PANELS.forEach((spec, i) => {
      const box = cellOf(i);
      panelSpec(spec.key); // RAISES if the registry and this loop ever disagree
      if (spec.kind === "metric") {
        this._drawMetric(ctx, box, spec, { state, metricData, nModesList, liveT, ctxOverride });
      } else if (spec.kind === "trace") {
        this._drawTrace(ctx, box, spec, { state, t2, live, ctxOverride });
      } else if (spec.kind === "emcluster") {
        this._drawEmCluster(ctx, box, spec, { state, t6, live, kerr, ctxOverride });
      } else if (spec.kind === "priorbox") {
        this._drawPriorBox(ctx, box, spec, { t2, occupancy });
      } else {
        throw new Error(`diagnostics: panel "${spec.key}" has unknown kind "${spec.kind}"`);
      }
    });

    const legendData = { nModesList, t2, t6, live, occupancy };
    if (narrow) {
      // No bound in the narrow layout: the canvas was made tall enough for the
      // whole column, so nothing is truncated.
      this._drawLegend(ctx, NARROW_LEGEND_X, outer.y + outer.h + PAD.bottom + NARROW_LEGEND_GAP, Infinity, legendData);
    } else {
      this._drawLegend(ctx, w - PAD.right + 14, PAD.top + 6, h - PAD.bottom, legendData);
    }

    this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    return this.lastFrameMs;
  }

  /** One Tier 3 metric panel: the metric against t_start, one line per mode count. */
  _drawMetric(ctx, box, spec, { state, metricData, nModesList, liveT, ctxOverride }) {
    const m = METRICS.find((q) => q.field === spec.field);
    const allT = [];
    const allV = [];
    for (const n of nModesList) {
      const d = metricData.get(`${n}|${m.field}`);
      if (!d) continue;
      allT.push(...d.ts);
      allV.push(...d.vs);
    }
    if (m.ref !== null) allV.push(m.ref);
    const xr = windowOf(state, VIEW, X_AXIS_ID, padRange(unionRange(allT) ?? [0, 15], 0.04));
    const yr = windowOf(state, VIEW, spec.key, padRange(unionRange(allV) ?? [0, 1], 0.08));
    const { sx, sy, ax, ay } = drawFrame(ctx, box, {
      xr,
      yr,
      xlabel: "t_start [M_rem]",
      ylabel: m.unit ? `${m.label} [${m.unit}]` : m.label,
      title: spec.title,
      grid: true,
      yTarget: 4,
    });
    if (!ctxOverride) {
      this.hitAreas.push({
        box,
        ax,
        ay,
        xKey: zoomKey(VIEW, X_AXIS_ID),
        yKey: zoomKey(VIEW, spec.key),
      });
    }

    if (m.ref !== null && m.ref >= yr[0] && m.ref <= yr[1]) {
      ctx.save();
      ctx.strokeStyle = "#c9a0a0";
      ctx.lineWidth = 1.2;
      ctx.setLineDash([7, 4]);
      ctx.beginPath();
      ctx.moveTo(box.x, sy(m.ref));
      ctx.lineTo(box.x + box.w, sy(m.ref));
      ctx.stroke();
      ctx.restore();
      // The label sits INSIDE the panel. A panel too narrow for the full label
      // takes the declared short form rather than overhanging its own y tick
      // labels, which is how this view produced overlapping text before.
      ctx.save();
      ctx.font = BODY_FONT;
      ctx.fillStyle = "#a07070";
      ctx.textAlign = "right";
      ctx.textBaseline = "bottom";
      const full = m.refLabel;
      const label = ctx.measureText(full).width <= box.w - 6 ? full : m.refShort;
      if (ctx.measureText(label).width <= box.w - 6) {
        ctx.fillText(label, box.x + box.w - 3, sy(m.ref) - 2);
      }
      ctx.restore();
    }

    // The live slider position.
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = MUTED_COLOR;
    ctx.lineWidth = 1;
    for (const t of liveT) {
      if (t < xr[0] || t > xr[1]) continue;
      ctx.beginPath();
      ctx.moveTo(sx(t), box.y);
      ctx.lineTo(sx(t), box.y + box.h);
      ctx.stroke();
    }
    ctx.restore();

    nModesList.forEach((n, ni) => {
      const d = metricData.get(`${n}|${m.field}`);
      if (!d || d.ts.length === 0) return;
      const color = PIN_PALETTE[ni % PIN_PALETTE.length];
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.8;
      ctx.setLineDash([]);
      strokeSeries(ctx, box, d.ts, d.vs, sx, sy);
      ctx.restore();
      // A run whose status is not "converged" gets a hollow ring, so a flagged
      // run is visible even when its metric looks ordinary.
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      for (let i = 0; i < d.ts.length; i++) {
        const cx = sx(d.ts[i]);
        const cy = sy(d.vs[i]);
        if (d.bad[i]) {
          ctx.strokeStyle = "#d55e00";
          ctx.lineWidth = 1.6;
          ctx.setLineDash([]);
          ctx.beginPath();
          ctx.arc(cx, cy, 4.6, 0, 2 * Math.PI);
          ctx.stroke();
        }
        if (liveT.has(d.ts[i])) {
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(cx, cy, 3.0, 0, 2 * Math.PI);
          ctx.fill();
        }
      }
      ctx.restore();
    });
  }

  /**
   * One per-chain trace panel, for the live run.
   *
   * Colour is the COLD CHAIN and dash is the mode, which is the opposite
   * assignment from the mode-decomposed views (ruling 18) and is deliberate:
   * the question a trace panel answers is "do the chains agree", so the chain
   * must be the channel the eye separates first. The legend says so.
   */
  _drawTrace(ctx, box, spec, { state, t2, live, ctxOverride }) {
    const p = getParam(spec.param); // RAISES on an unregistered parameter
    const ylabel = `${p.label}${p.unit ? ` [${p.unit}]` : ""}`;
    if (t2 === undefined) {
      drawFrame(ctx, box, {
        xr: [0, 1],
        yr: [0, 1],
        xlabel: "sample index",
        ylabel,
        title: spec.title,
      });
      ctx.save();
      ctx.font = BODY_FONT;
      ctx.fillStyle = MUTED_COLOR;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        live ? "Tier 2 block not resident yet" : "no live run selected",
        box.x + box.w / 2,
        box.y + box.h / 2
      );
      ctx.restore();
      return;
    }

    const cb = t2.chainBoundaries; // the chain count comes from HERE, never a shape
    const cols = [];
    for (let m = 0; m < t2.n_modes; m++) cols.push(tier2Param(t2, spec.param, m));
    const vals = [];
    for (const c of cols) for (const v of c) vals.push(v);
    const { sx, sy, ax, ay } = drawFrame(ctx, box, {
      xr: windowOf(state, VIEW, TRACE_X_AXIS_ID, [0, t2.nSamples]),
      yr: windowOf(state, VIEW, spec.key, padRange(unionRange(vals) ?? [0, 1], 0.06)),
      xlabel: "sample index",
      ylabel,
      title: spec.title,
      grid: true,
      yTarget: 4,
    });
    if (!ctxOverride) {
      this.hitAreas.push({
        box,
        ax,
        ay,
        xKey: zoomKey(VIEW, TRACE_X_AXIS_ID),
        yKey: zoomKey(VIEW, spec.key),
      });
    }
    for (let m = 0; m < cols.length; m++) {
      for (let c = 0; c < t2.nChains; c++) {
        const i0 = cb[c];
        const i1 = cb[c + 1];
        const xs = new Float64Array(i1 - i0);
        const ys = new Float64Array(i1 - i0);
        for (let i = i0; i < i1; i++) {
          xs[i - i0] = i;
          ys[i - i0] = cols[m][i];
        }
        ctx.save();
        ctx.strokeStyle = withAlpha(PIN_PALETTE[c % PIN_PALETTE.length], 0.85);
        ctx.lineWidth = m === 0 ? 0.8 : 0.6;
        ctx.setLineDash(m === 0 ? [] : [3, 2]);
        strokeSeries(ctx, box, xs, ys, sx, sy);
        ctx.restore();
      }
    }
    // Chain boundaries, as faint rules: the cold block is a concatenation, and
    // a trace that looks continuous across a boundary is a coincidence.
    ctx.save();
    ctx.strokeStyle = "#dddddd";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    for (let c = 1; c < t2.nChains; c++) {
      ctx.beginPath();
      ctx.moveTo(sx(cb[c]), box.y);
      ctx.lineTo(sx(cb[c]), box.y + box.h);
      ctx.stroke();
    }
    ctx.restore();
  }

  /**
   * Stroke one 1-sigma ellipse of a (f, gamma) covariance.
   *
   * THE ROTATION IS APPLIED IN DATA SPACE and only then mapped through `sx` and
   * `sy`. Rotating in PIXEL space would be wrong: the two axes have different
   * data-per-pixel scales, so a pixel-space rotation of the eigenvectors would
   * tilt every ellipse by the aspect ratio of the panel.
   *
   * @param {number[]} mu [f, gamma] @param {number[][]} cov [[xx,xy],[xy,yy]]
   */
  _strokeEllipse(ctx, sx, sy, mu, cov, color, lineWidth, dash) {
    const { w, h, angleDeg } = ellipse1Sigma(cov);
    const a = w / 2; // semi-axis, because `w`/`h` are full axis LENGTHS
    const b = h / 2;
    const th = (angleDeg * Math.PI) / 180;
    const ca = Math.cos(th);
    const sa = Math.sin(th);
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash(dash);
    ctx.beginPath();
    for (let i = 0; i <= ELLIPSE_SEGMENTS; i++) {
      const t = (2 * Math.PI * i) / ELLIPSE_SEGMENTS;
      const dx = a * Math.cos(t);
      const dy = b * Math.sin(t);
      const px = sx(mu[0] + ca * dx - sa * dy);
      const py = sy(mu[1] + sa * dx + ca * dy);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.restore();
  }

  /**
   * The EM-cluster-during-sampling panel (Tier 6). See the header note.
   *
   * EVERY CHAIN COUNT HERE IS `t6.nCold`, which comes from the Tier 6 HEADER.
   * It is never an array's first axis: the source arrays are 8 deep (4 cold +
   * 4 hot) while the sample arrays are 4 deep, and indexing one with the
   * other's row would draw a hot chain's EM fit over a cold chain's samples.
   * Tier 6 ships the cold block only, so rows 4..7 are not in this file at all.
   */
  _drawEmCluster(ctx, box, spec, { state, t6, live, kerr, ctxOverride }) {
    const pf = getParam("f");
    const pg = getParam("gamma");
    const xlabel = `${pf.label} [${pf.unit}]`;
    const ylabel = `${pg.label} [${pg.unit}]`;

    if (t6 === undefined) {
      drawFrame(ctx, box, { xr: [0, 1], yr: [0, 1], xlabel, ylabel, title: spec.title });
      ctx.save();
      ctx.font = BODY_FONT;
      ctx.fillStyle = MUTED_COLOR;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        live ? "Tier 6 block not resident yet" : "no live run selected",
        box.x + box.w / 2,
        box.y + box.h / 2
      );
      ctx.restore();
      if (!ctxOverride) this.lastEm = null;
      return;
    }

    // A4, asserted at use: the colour axis is the sweep number over the FULL
    // history INCLUDING warmup. If a payload ever shipped a post-burn-in range
    // the panel would still draw, and would silently lose its whole point.
    if (!(t6.nSweeps > 0) || !(t6.burnIn >= 0) || !(t6.burnIn <= t6.nSweeps)) {
      throw new Error(
        `diagnostics: Tier 6 block has n_sweeps=${t6.nSweeps}, burn_in=${t6.burnIn}. ` +
          `The EM panel colours by sweep over 0..n_sweeps, so burn-in must lie inside it.`
      );
    }

    const C = t6.nCold; // FROM THE HEADER
    const K = t6.n_modes;
    const S = t6.nSnapshots;

    const xr = windowOf(state, VIEW, EM_X_AXIS_ID, t6.fRange);
    const yr = windowOf(state, VIEW, EM_Y_AXIS_ID, t6.gammaRange);
    const { sx, sy, ax, ay } = drawFrame(ctx, box, {
      xr,
      yr,
      xlabel,
      ylabel,
      title: spec.title,
      grid: true,
      xTarget: 3,
      yTarget: 4,
    });
    if (!ctxOverride) {
      this.hitAreas.push({
        box,
        ax,
        ay,
        xKey: zoomKey(VIEW, EM_X_AXIS_ID),
        yKey: zoomKey(VIEW, EM_Y_AXIS_ID),
      });
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();

    // ---- the cloud: every kept sweep of every cold chain, coloured by sweep.
    const sf = t6.arrays.scatter_f;
    const sg = t6.arrays.scatter_g;
    let nScatter = 0;
    for (let i = 0; i < t6.nKeep; i++) {
      const sweep = i * t6.scatterStride;
      ctx.fillStyle = sweepColor(sweep / t6.nSweeps, 0.32);
      for (let c = 0; c < C; c++) {
        for (let k = 0; k < K; k++) {
          const j = t6ScatterIndex(t6, c, i, k);
          const fv = sf[j];
          const gv = sg[j];
          if (!Number.isFinite(fv) || !Number.isFinite(gv)) continue;
          ctx.fillRect(sx(fv) - 0.7, sy(gv) - 0.7, 1.4, 1.4);
          nScatter++;
        }
      }
    }

    // ---- divergences: grey before burn-in, black after.
    const dsw = t6.arrays.div_sweep;
    const df = t6.arrays.div_f;
    const dg = t6.arrays.div_g;
    ctx.save();
    ctx.lineWidth = 1;
    for (let i = 0; i < t6.nDiv; i++) {
      if (!Number.isFinite(df[i]) || !Number.isFinite(dg[i])) continue;
      ctx.strokeStyle = dsw[i] < t6.burnIn ? "#b0b0b0" : "#000000";
      cross(ctx, sx(df[i]), sy(dg[i]), 2.5);
    }
    ctx.restore();

    // ---- the drift: one thin 1-sigma ellipse per EM snapshot, per cold chain,
    // per hyper-cluster, in the sweep colour of that snapshot.
    const perm = t6.arrays.em_match_perm;
    const sweepNums = t6.arrays.em_sweep_nums;
    for (let s = 0; s < S; s++) {
      const col = sweepColor(sweepNums[s] / t6.nSweeps, 0.85);
      for (let c = 0; c < C; c++) {
        for (let k = 0; k < K; k++) {
          // The per-chain EM SLOT of hyper-cluster k at this snapshot. Which
          // slot holds which cluster differs per chain and changes with time.
          const raw = perm[(s * C + c) * K + k];
          const j = (s * C + c) * K + raw;
          const mu = t6Mean(t6, "em_means", j);
          this._strokeEllipse(ctx, sx, sy, mu, t6Cov(t6, "em_covs", j), col, 0.9, []);
          ctx.fillStyle = col;
          dot(ctx, sx(mu[0]), sy(mu[1]), 1.3);
        }
      }
    }

    // ---- the hyper-EM reference clusters: shared across chains, so they carry
    // NO chain axis. A red ellipse far from its blue reference is a chain that
    // classified its modes differently from the cross-chain consensus.
    for (let k = 0; k < K; k++) {
      this._strokeEllipse(
        ctx, sx, sy,
        t6Mean(t6, "hyper_ref_means", k),
        t6Cov(t6, "hyper_ref_covs", k),
        EM_REF_COLOR, 2.2, [6, 4]
      );
    }

    // ---- the CURRENT per-chain EM clusters.
    //
    // `samples.h5` stores no current EM MEANS at all; the mean comes from the
    // LAST history snapshot, which `emdiag.build_emdiag` ASSERTS is the current
    // EM state (it checks `em_history_covs_lin_[S-1] == em_covs_lin` and
    // RAISES otherwise). So a red ellipse here is either right or absent.
    const hyperPerms = t6.arrays.hyper_perms;
    const perChain = [];
    for (let c = 0; c < C; c++) {
      const clusters = [];
      for (let k = 0; k < K; k++) {
        const raw = hyperPerms[c * K + k];
        const j = c * K + raw;
        const mu = t6Mean(t6, "cur_means", j);
        const cov = t6Cov(t6, "cur_covs", j);
        this._strokeEllipse(ctx, sx, sy, mu, cov, EM_CURRENT_COLOR, 2.2, []);
        ctx.fillStyle = EM_CURRENT_COLOR;
        dot(ctx, sx(mu[0]), sy(mu[1]), 2.6);
        clusters.push({ k, raw, mean: [mu[0], mu[1]], ellipse: ellipse1Sigma(cov) });
      }
      perChain.push({ chain: c, clusters });
    }

    // ---- Kerr truth markers. `ref_to_inj` indexes `kerrLabels`, and it is
    // PRECOMPUTED because the assignment needs a Hungarian solver the browser
    // bundle does not carry. Lime = matched to a hyper-cluster, grey = not.
    let nKerr = 0;
    if (kerr) {
      const matched = new Set();
      for (let k = 0; k < K; k++) {
        const li = t6.arrays.ref_to_inj[k];
        if (li < t6.kerrLabels.length) matched.add(t6.kerrLabels[li]);
      }
      ctx.save();
      ctx.lineWidth = 1.8;
      for (const lab of t6.kerrLabels) {
        const rec = kerr[lab];
        const fv = Number(rec?.f);
        const gv = Number(rec?.inv_tau);
        if (!Number.isFinite(fv) || !Number.isFinite(gv)) continue;
        ctx.strokeStyle = matched.has(lab) ? "#2ca02c" : "#888888";
        cross(ctx, sx(fv), sy(gv), 5);
        nKerr++;
      }
      ctx.restore();
    }

    ctx.restore();

    if (!ctxOverride) {
      this.lastEm = {
        run: live ? live.label : null,
        nCold: C,
        nModes: K,
        nSnapshots: S,
        nKeep: t6.nKeep,
        nSweeps: t6.nSweeps,
        burnIn: t6.burnIn,
        scatterStride: t6.scatterStride,
        /** The sweep value that maps to the TOP of the colour ramp. */
        colourMaxSweep: t6.nSweeps,
        /** The largest sweep a scatter point carries. */
        maxScatterSweep: (t6.nKeep - 1) * t6.scatterStride,
        nScatterDrawn: nScatter,
        nDivDrawn: t6.nDiv,
        nKerrDrawn: nKerr,
        perChain,
        xr: [xr[0], xr[1]],
        yr: [yr[0], yr[1]],
      };
    }
  }

  /**
   * The UNCROPPED prior box, with the Tier 2 points.
   *
   * DELIBERATELY NOT ZOOMABLE, and so it publishes no hit area. This panel
   * exists to show the prior box UNCROPPED, which the page states in words as a
   * required notice (spec section 6). A zoom would crop it and make that
   * statement false. The same two parameters zoom freely in the corner and
   * f-gamma views, so request 6 loses nothing here.
   */
  _drawPriorBox(ctx, box, spec, { t2, occupancy }) {
    const bx = priorBox("f", this._ev);
    const by = priorBox("gamma", this._ev);
    const pf = getParam("f");
    const pg = getParam("gamma");
    const { sx: bsx, sy: bsy } = drawFrame(ctx, box, {
      xr: bx,
      yr: by,
      xlabel: `${pf.label} [${pf.unit}]`,
      ylabel: `${pg.label} [${pg.unit}]`,
      title: spec.title,
      grid: true,
      xTarget: 3,
      yTarget: 4,
    });
    if (t2 === undefined) return;
    if (!(PRIOR_EDGE_FRAC > 0 && PRIOR_EDGE_FRAC < 0.5)) {
      throw new Error(`diagnostics: config.PRIOR_EDGE_FRAC=${PRIOR_EDGE_FRAC} must be in (0, 0.5)`);
    }
    for (let m = 0; m < t2.n_modes; m++) {
      const fc = tier2Param(t2, "f", m);
      const gc = tier2Param(t2, "gamma", m);
      ctx.save();
      ctx.beginPath();
      ctx.rect(box.x, box.y, box.w, box.h);
      ctx.clip();
      ctx.fillStyle = withAlpha(PIN_PALETTE[m % PIN_PALETTE.length], 0.22);
      for (let i = 0; i < fc.length; i++) ctx.fillRect(bsx(fc[i]), bsy(gc[i]), 1.4, 1.4);
      ctx.restore();
      for (const key of EDGE_PARAMS) {
        const col = key === "f" ? fc : gc;
        const b = priorBox(key, this._ev);
        const wid = (b[1] - b[0]) * PRIOR_EDGE_FRAC;
        let lo = 0;
        let hi = 0;
        for (let i = 0; i < col.length; i++) {
          if (col[i] <= b[0] + wid) lo++;
          if (col[i] >= b[1] - wid) hi++;
        }
        occupancy.push({ mode: m, key, lo: lo / col.length, hi: hi / col.length });
      }
    }
  }

  /** The legend column, the occupancy readout and the required notices. */
  /**
   * @param {number} lx @param {number} ly top-left of the column
   * @param {number} bottomLimit baseline reserved for the truncation notice;
   *        Infinity for no bound
   * @returns {number} the y below the column
   */
  _drawLegend(ctx, lx, ly, bottomLimit, { nModesList, t2, t6, live, occupancy }) {
    /*
     * THE LEGEND COLUMN IS BOUNDED BY THE SURFACE.
     *
     * The defect this prevents, MEASURED 2026-09-16 at a 1280x800 window: the
     * column's content grows with the mode count (one occupancy line per mode
     * and parameter) and with the chain count (the EM slot mapping). Adding the
     * EM key pushed the last notice lines 16 px (2 modes) to 44 px (3 modes)
     * BELOW the bottom of the canvas, where they are not merely ugly but
     * invisible — a notice the page is required to show, silently not shown.
     *
     * So every line below here goes through `putLine`, which refuses to paint
     * past `contentLimit` and records that it did. A truncated column SAYS it is
     * truncated; it never just stops.
     *
     * THE NOTICE GETS A RESERVED SLOT, and this is load-bearing.
     * The first version of this guard bounded the CONTENT at `bottomLimit` and
     * then painted the notice at `bottomLimit` too, bypassing `putLine`. Both
     * could therefore claim the same baseline. MEASURED by gate H6 on the
     * 10-panel layout, 2026-09-16, at 1280x800: the notice overlapped the line
     * 'γ [1, 2.50e+3] 1/s.' by [94.28, 3.00] px — 1 overlapping pair, H6 false.
     * So the content stops one line HIGHER, at `contentLimit`, and the notice
     * owns `bottomLimit` alone. The gap is then exactly `LINE_H`, the same
     * spacing that yields 0 overlaps across the other 141 texts on this canvas.
     * Cost, accepted: when the column is full to the last line, one content
     * line is traded for the notice that says so. A visible notice beats a
     * hidden collision — request 5 is about readability.
     */
    //: Legend line advance in CSS pixels. Declared once and used for BOTH the
    //: line step and the notice reservation, so the two cannot drift apart.
    const LINE_H = 14;
    const contentLimit = bottomLimit - LINE_H;
    let truncated = false;
    const putLine = (text, color) => {
      if (ly > contentLimit) {
        truncated = true;
        return;
      }
      if (text !== "") {
        ctx.fillStyle = color;
        ctx.fillText(text, lx, ly);
      }
      ly += LINE_H;
    };
    ly = drawLegend(
      ctx,
      lx,
      ly,
      nModesList.map((n, ni) => ({
        color: PIN_PALETTE[ni % PIN_PALETTE.length],
        label: `${n}-mode fits`,
      })),
      "metric panels: mode count"
    );
    ly += 4;
    ly = drawLegend(
      ctx,
      lx,
      ly,
      [{ color: "#d55e00", label: 'status != "converged"', marker: "dot" }],
      undefined
    );
    ly += 6;
    if (t2 !== undefined) {
      ly = drawLegend(
        ctx,
        lx,
        ly,
        Array.from({ length: t2.nChains }, (_, c) => ({
          color: PIN_PALETTE[c % PIN_PALETTE.length],
          label: `cold chain ${c}`,
          lineWidth: 1.4,
        })),
        `traces: ${live.label}`
      );
      ly += 6;
    }

    // ---- the EM-cluster panel's colour bar and key.
    //
    // The colour bar is the panel's ONLY statement of what the cloud colour
    // means, so it carries both ends of the range in words: the ramp runs from
    // sweep 0 to `n_sweeps`, the FULL history, warmup included.
    if (t6 !== undefined) {
      ctx.save();
      ctx.font = BODY_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = TEXT_COLOR;
      ctx.fillText("EM panel: sweep number", lx, ly);
      ly += 15;
      const barW = 150;
      const barH = 9;
      for (let i = 0; i < barW; i++) {
        ctx.fillStyle = sweepColor(i / (barW - 1), 1);
        ctx.fillRect(lx + i, ly, 1.2, barH);
      }
      ly += barH + 9;
      ctx.fillStyle = MUTED_COLOR;
      ctx.fillText("0", lx, ly);
      ctx.textAlign = "right";
      ctx.fillText(`${t6.nSweeps} (all sweeps)`, lx + barW, ly);
      ctx.textAlign = "left";
      ly += 14;
      ctx.restore();
      ly = drawLegend(
        ctx,
        lx,
        ly,
        [
          { color: EM_CURRENT_COLOR, label: "current EM cluster", lineWidth: 2.2 },
          { color: EM_REF_COLOR, label: "hyper-EM reference", dash: [6, 4], lineWidth: 2.2 },
          { color: "#2ca02c", label: "Kerr max-L mode", marker: "dot" },
          { color: "#000000", label: `divergence, sweep > ${t6.burnIn}`, marker: "dot" },
          { color: "#b0b0b0", label: `divergence, sweep < ${t6.burnIn}`, marker: "dot" },
        ],
        undefined
      );
      ctx.save();
      ctx.font = BODY_FONT;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillStyle = TEXT_COLOR;
      ctx.fillText("EM slot per cold chain:", lx, ly);
      ly += 14;
      ctx.fillStyle = MUTED_COLOR;
      // TWO CHAINS PER LINE. This mapping is the one part of the EM key that
      // grows with the chain count, and the column is short at an 800 px window.
      for (let c = 0; c < t6.nCold; c += 2) {
        const parts = [];
        for (let q = c; q < Math.min(c + 2, t6.nCold); q++) {
          const slots = [];
          for (let k = 0; k < t6.n_modes; k++) {
            slots.push(t6.arrays.hyper_perms[q * t6.n_modes + k]);
          }
          parts.push(`c${q}: ${slots.join(",")}`);
        }
        ctx.fillText(parts.join("    "), lx, ly);
        ly += 14;
      }
      ctx.restore();
      ly += 4;
    }

    ctx.save();
    ctx.font = BODY_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText(`prior-edge occupancy (${(100 * PRIOR_EDGE_FRAC).toFixed(0)}% of box)`, lx, ly);
    ly += 15;
    if (occupancy.length === 0) {
      putLine("waiting for the Tier 2 block", MUTED_COLOR);
    } else {
      for (const o of occupancy) {
        const flag = o.lo > 0.01 || o.hi > 0.01;
        putLine(
          `mode ${o.mode} ${o.key}: lo ${(100 * o.lo).toFixed(2)}%  hi ${(100 * o.hi).toFixed(2)}%`,
          flag ? "#a05000" : MUTED_COLOR
        );
      }
    }
    ly += 6;
    const bx = priorBox("f", this._ev);
    const by = priorBox("gamma", this._ev);
    for (const line of [
      "Traces: colour is the COLD CHAIN,",
      "dash is the mode index.",
      "",
      "EVERY per-chain panel here shows",
      "COLD chains only. The 4 hot chains",
      "have no sample arrays and are drawn",
      "nowhere on this page.",
      "",
      "The prior box panel is UNCROPPED:",
      `f [${fmtNum(bx[0])}, ${fmtNum(bx[1])}] Hz,`,
      `γ [${fmtNum(by[0])}, ${fmtNum(by[1])}] 1/s.`,
      "Mass at a bound is shown, not",
      "scaled away.",
    ]) {
      putLine(line, MUTED_COLOR);
    }
    if (truncated) {
      // `bottomLimit` is RESERVED: `putLine` never paints below `contentLimit`
      // = `bottomLimit - LINE_H`, so this baseline is always free and is one
      // full line clear of the last content line. See the reservation note above.
      ctx.fillStyle = "#a05000";
      ctx.fillText("… legend truncated: taller window", lx, bottomLimit);
    }
    ctx.restore();
    return ly;
  }

  /** Height of `rows` panel rows, gaps included, in the narrow layout. */
  _plotH(rows) {
    return rows * NARROW_PANEL_H + (rows - 1) * GAP.y;
  }

  /**
   * @param {boolean} hasPanels false when only a message is drawn
   * @param {Object} data `_drawLegend`'s data, less the occupancy rows, which
   *        the prior-box panel computes while drawing. Their COUNT is known
   *        here (modes x EDGE_PARAMS), and only the count sets the height.
   */
  _prepareCanvas(hasPanels, data) {
    const avail = availableWidth(this.canvas);
    this._narrow = isNarrow(avail);
    if (this._narrow && hasPanels) {
      const nOcc = data.t2 === undefined ? 0 : data.t2.n_modes * EDGE_PARAMS.length;
      const occupancy = Array.from({ length: nOcc }, () => ({ mode: 0, key: "f", lo: 0, hi: 0 }));
      const legendH = measureBlock((c, x, y) => this._drawLegend(c, x, y, Infinity, { ...data, occupancy }));
      const { rows } = gridShape(PANELS.length, NARROW_COLS);
      setCanvasCssSize(this.canvas, avail, PAD.top + this._plotH(rows) + PAD.bottom + NARROW_LEGEND_GAP + legendH);
    } else if (this._narrow) {
      setCanvasCssSize(this.canvas, avail, avail / 2);
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
