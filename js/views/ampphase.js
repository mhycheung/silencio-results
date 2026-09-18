/**
 * views/ampphase.js — measured ringdown amplitude and phase against the
 * prec_amp prediction, per assigned mode, against start time.
 *
 * One row per measured (Stage-2 matched) mode of the selected
 * `(n_modes, delta_t)`, labelled with the Stage-3 mode assignment. Four
 * columns: the two log-amplitudes and the two phases, ABSOLUTE or RELATIVE to
 * the mode assigned 2.2.0 as the rail selects. A phase panel draws
 * MEASURED - PREDICTED circular means, not the phase itself.
 *
 * Blue = prediction over the UNFLAGGED samples, grey = over ALL samples (drawn
 * only when something is flagged), black = measured. A filled dot is a run
 * inside the Stage-2 window, a hollow grey dot one outside it.
 *
 * NO VERDICTS: the view draws what was measured and what was predicted.
 *
 * NO FETCH (the view contract). `main.js :: ensureData` fetches `ampphase.json`
 * when this view is selected and the event advertises it.
 *
 * ON-PAGE TEXT IS DELIBERATELY MINIMAL (user ruling 2026-09-18: plots, not
 * words). The payload still carries its notes, conventions and provenance; this
 * view no longer draws them. Do not re-add prose here.
 *
 * CONVENTIONS (A1): `t_start` in units of the remnant mass `M_rem`, origin at
 * the IMR maximum-likelihood peak; amplitudes are strain at the detector as
 * log10; phases in radians wrapped to (-pi, pi], with
 * `R ~ cos(omega t - phi_R)` and `L ~ cos(omega t + phi_L)`; the measured
 * samples are stored at `t_start = 0` and taken to each run's own start time
 * with that run's own `f` and `gamma`, per sample.
 */
import { AMPPHASE_AXES, ampPhaseColumns } from "../config.js";
import { withAlpha } from "../colors.js";
import { ampPhaseConfig, ampPhaseMode } from "../state.js";
import {
  BODY_FONT,
  MUTED_COLOR,
  TEXT_COLOR,
  availableWidth,
  drawFrame,
  drawLegend,
  drawMessage,
  fillBand,
  padRange,
  setCanvasCssSize,
  strokeSeries,
  unionRange,
} from "./plotutil.js";

/** This view's key in the view registry. Value: "ampphase". */
export const VIEW = "ampphase";

/** Colour of the prediction over the UNFLAGGED samples. Value: "#0072b2"
 *  (Okabe–Ito blue, the palette the rest of the app draws from). */
export const PRED_COLOR = "#0072b2";

/** Colour of the prediction over ALL samples, flagged ones included. */
export const PRED_ALL_COLOR = "#999999";

/** Colour of a measured point from a run INSIDE the Stage-2 window. */
export const MEAS_COLOR = "#111111";

/** Colour of a measured point from a run OUTSIDE the Stage-2 window. */
export const MEAS_OUT_COLOR = "#8c8c8c";

/** Panel height, in CSS pixels. Value: 208. */
export const PANEL_H = 208;

/** Minimum panel width, in CSS pixels. Value: 214. Below it the four columns
 *  would have no room for their tick labels, so the canvas is made WIDER than
 *  its box instead and `.plotscroll` scrolls sideways. */
export const PANEL_MIN_W = 214;

/** Gaps between panels, in CSS pixels. `x` leaves room for the y tick labels
 *  and rotated y title of the panel to its right. */
export const GAP = Object.freeze({ x: 92, y: 62 });

/** Margins of the whole block, in CSS pixels. */
export const PAD = Object.freeze({ left: 70, right: 18, top: 16, bottom: 20 });

/** Line pitch of a prose line, in CSS pixels. Value: 16. */
export const LINE_H = 16;

/** Font of a section heading. */
export const HEAD_FONT = "bold 12px system-ui, sans-serif";

/** Radius of a measured marker, in CSS pixels. Value: 3. */
export const DOT_R = 3;

/** Half-width of an error-bar cap, in CSS pixels. Value: 2.5. */
export const CAP_W = 2.5;

/**
 * Gap between the LAST header line and the top edge of the first panel row,
 * in CSS pixels. Value: 46.
 *
 * It must clear the PANEL TITLE, which `plotutil.drawFrame` draws ABOVE the
 * panel box with its baseline at `box.y - PANEL_TITLE_GAP` (12 px), so the
 * title occupies roughly `box.y - 24 .. box.y - 12`. MEASURED 2026-09-18: the
 * first value used here was 22, and the last header line and the first row of
 * panel titles were drawn on top of each other. 46 = 24 for the title + 22 of
 * air.
 */
export const HEAD_GAP = 46;

/**
 * Gap between the BOTTOM edge of the last panel row and the legend, in CSS
 * pixels. Value: 58. It must clear the X AXIS TITLE, whose baseline
 * `drawFrame` puts at `box.y + box.h + X_TITLE_GAP` (24 px). MEASURED
 * 2026-09-18: at 34 the legend heading overlapped the bottom row's x title.
 */
export const LEGEND_GAP = 58;

/**
 * Key of the payload's `measured` map. Mirrors
 * `silencio.site.data.ampphase.axis_key`, whose `:g` format prints 10.0 as
 * "10" — which is what `String(10)` prints for the same number read out of
 * JSON, so the two sides agree without a format string on either.
 * @param {number|string} n @param {number|string} dt
 */
export function apKey(n, dt) {
  return `${Number(n)}/${Number(dt)}`;
}

/**
 * The `(n_modes, delta_t)` selection resolved against the payload's default.
 *
 * The payload's `default_config` is used as the fallback WITHOUT being parsed
 * out of any label string: the producer resolved it (A4, `ampphase.default_axes`)
 * and carries the resolved pair plus the sentence that says how.
 *
 * @param {Object} state store state
 * @param {Object} doc the parsed `ampphase.json`
 * @returns {{config: Object, source: string}}
 */
export function resolveConfig(state, doc) {
  const d = doc.default_config ?? {};
  const fallback = {};
  for (const axis of AMPPHASE_AXES) {
    if (d[axis] !== undefined && d[axis] !== null) fallback[axis] = d[axis];
  }
  return { config: ampPhaseConfig(state, fallback), source: d.source ?? "payload default" };
}

/** Wrap an angle into (-pi, pi]; `null` for a non-finite input. */
export function wrapAngle(a) {
  if (!Number.isFinite(a)) return null;
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/**
 * Index of `value` in the prediction's `t_start_m` grid, or -1.
 *
 * Exact-to-1e-9 matching, never a nearest neighbour: a measured run whose start
 * time is not ON the prediction grid has no prediction to be compared with, and
 * silently moving it to the closest grid column would compare two different
 * start times. The caller drops the point and the view says how many it dropped.
 *
 * @param {number[]} grid @param {number} value
 */
export function tIndex(grid, value) {
  if (!Array.isArray(grid) || !Number.isFinite(value)) return -1;
  for (let i = 0; i < grid.length; i++) {
    if (Number.isFinite(grid[i]) && Math.abs(grid[i] - value) <= 1e-9) return i;
  }
  return -1;
}

/** `v.toFixed(d)` or "–" when `v` is not a finite number. */
function fmt(v, d) {
  return Number.isFinite(v) ? Number(v).toFixed(d) : "–";
}

export class AmpPhaseView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lastFrameMs = NaN;
    /** This view keeps no zoom windows; the interaction layer reads the list. */
    this.hitAreas = [];
  }

  /**
   * Draw one frame.
   * @param {Object} args
   * @param {Object} args.state store state
   * @param {Object} args.loader Loader with preload() done
   * @param {Object} [args.ctxOverride] draw here instead of the canvas (SVG)
   * @returns {number} frame time in ms
   */
  render({ state, loader, ctxOverride }) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();

    // `hasExtra` reads the event block, which RAISES on a payload that has
    // none. A payload without an event block cannot advertise anything, so the
    // absence is the answer, not an error to put on the page.
    let advertised = false;
    try {
      advertised = loader.hasExtra("amp_phase");
    } catch (e) {
      advertised = false;
    }
    const doc = advertised ? loader.ampPhaseCached() : undefined;
    const plan = this._plan(state, loader, doc, advertised, ctxOverride);
    const ctx = ctxOverride ?? this._prepareCanvas(plan.width, plan.height);
    const w = ctxOverride ? ctxOverride.width : this._cssW;
    const h = ctxOverride ? ctxOverride.height : this._cssH;
    if (!ctxOverride) this.hitAreas = [];
    if (plan.message) drawMessage(ctx, w, h, plan.message);
    else this._paint(ctx, plan);
    this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    return this.lastFrameMs;
  }

  /** Build the draw plan, and with it the canvas size. */
  _plan(state, loader, doc, advertised, ctxOverride) {
    const avail = ctxOverride ? ctxOverride.width : availableWidth(this.canvas);
    const ctx = this.ctx; // measurement only
    if (!advertised) {
      return {
        message:
          `${loader.event}: this payload carries no amplitude/phase summaries ` +
          `(the prediction and the rescaled tracks have not been built for it).`,
        width: avail,
        height: 0,
      };
    }
    if (doc === undefined) {
      return { message: "loading the amplitude/phase summaries …", width: avail, height: 0 };
    }

    const { config: sel } = resolveConfig(state, doc);
    const key = apKey(sel.n_modes, sel.delta_t);
    const block = (doc.measured ?? {})[key];
    const mode = ampPhaseMode(state);
    const cols = ampPhaseColumns(mode);
    const flagged = Number(doc.prediction_flags?.counts?.any ?? 0);
    const nPred = Number(doc.prediction_flags?.n_samples ?? 0);

    // ONE short line, and the title. User ruling 2026-09-18: no explanations.
    const head = [];
    head.push({
      kind: "head",
      text:
        `Amplitude and phase — ${doc.event} — n_modes ${sel.n_modes ?? "(any)"}, ` +
        `delta_t ${sel.delta_t ?? "(any)"} M_rem, ` +
        `${mode === "relative" ? "relative to 2.2.0" : "absolute"}`,
    });
    head.push({
      kind: "muted",
      text:
        "Measured (black) vs predicted (blue)." +
        (flagged > 0
          ? ` Grey: includes flagged samples. Flagged: ${flagged} of ${nPred}.`
          : ""),
    });

    if (block === undefined) {
      const have = Object.keys(doc.measured ?? {}).join(", ") || "none";
      head.push({ kind: "gap", h: 8 });
      head.push({
        kind: "text",
        text: `No amplitude/phase summary for n_modes = ${sel.n_modes}, delta_t = ${sel.delta_t}.`,
      });
      head.push({ kind: "muted", text: `available (n_modes/delta_t): ${have}` });
      return this._textOnly(ctx, head, doc, avail);
    }

    const rows = Object.keys(block)
      .map((k) => ({ j: Number(k), entry: block[k] }))
      .sort((a, b) => a.j - b.j);
    if (!rows.length) {
      head.push({ kind: "gap", h: 8 });
      head.push({ kind: "text", text: "This configuration has no matched mode." });
      return this._textOnly(ctx, head, doc, avail);
    }

    // Per row and column, the series to draw. Built here so that the height of
    // the block and the y ranges are known before anything is painted.
    let dropped = 0;
    const panels = [];
    for (const row of rows) {
      const label = row.entry.assigned_label;
      const pred = (doc.prediction ?? {})[label] ?? {};
      const predUn = pred.unflagged;
      const predAll = pred.all;
      for (let c = 0; c < cols.length; c++) {
        const col = cols[c];
        const meas = row.entry[col.key];
        const p = predUn ? predUn[col.key] : undefined;
        const pa = predAll ? predAll[col.key] : undefined;
        const xs = doc.t_start_m ?? [];
        const pts = [];
        const tm = row.entry.t_start_m ?? [];
        for (let i = 0; i < tm.length; i++) {
          const it = tIndex(xs, tm[i]);
          if (it < 0) {
            dropped += 1;
            continue;
          }
          if (col.circular) {
            const mm = meas ? meas.cmean?.[i] : null;
            const pm = p ? p.cmean?.[it] : null;
            const sd = meas ? meas.cstd?.[i] : null;
            const d = Number.isFinite(mm) && Number.isFinite(pm) ? wrapAngle(mm - pm) : null;
            pts.push({
              x: tm[i],
              mid: d,
              lo: Number.isFinite(d) && Number.isFinite(sd) ? d - sd : null,
              hi: Number.isFinite(d) && Number.isFinite(sd) ? d + sd : null,
              inWindow: Boolean(row.entry.in_window?.[i]),
            });
          } else {
            pts.push({
              x: tm[i],
              mid: meas ? meas.q50?.[i] : null,
              lo: meas ? meas.q05?.[i] : null,
              hi: meas ? meas.q95?.[i] : null,
              inWindow: Boolean(row.entry.in_window?.[i]),
            });
          }
        }
        // The band and centre line of the prediction, on the prediction grid.
        const band = col.circular
          ? p && Array.isArray(p.cstd)
            ? { lo: p.cstd.map((s) => (Number.isFinite(s) ? -s : null)), hi: p.cstd.slice(), mid: p.cstd.map(() => 0) }
            : null
          : p && Array.isArray(p.q05)
            ? { lo: p.q05.slice(), hi: p.q95.slice(), mid: p.q50.slice() }
            : null;
        const bandAll =
          flagged > 0 && pa
            ? col.circular && Array.isArray(pa.cstd)
              ? { lo: pa.cstd.map((s) => (Number.isFinite(s) ? -s : null)), hi: pa.cstd.slice(), mid: pa.cstd.map(() => 0) }
              : Array.isArray(pa.q05)
                ? { lo: pa.q05.slice(), hi: pa.q95.slice(), mid: pa.q50.slice() }
                : null
            : null;
        const vals = [];
        for (const q of pts) for (const v of [q.lo, q.mid, q.hi]) if (Number.isFinite(v)) vals.push(v);
        for (const b of [band, bandAll]) {
          if (!b) continue;
          for (const arr of [b.lo, b.hi]) for (const v of arr) if (Number.isFinite(v)) vals.push(v);
        }
        const hasAny = vals.length > 0;
        let yr = padRange(unionRange(vals) ?? [-1, 1], 0.08);
        if (col.circular) {
          yr = [Math.max(yr[0], -Math.PI), Math.min(yr[1], Math.PI)];
          if (!(yr[1] > yr[0])) yr = [-Math.PI, Math.PI];
        }
        panels.push({
          row: rows.indexOf(row),
          col: c,
          col_def: col,
          label,
          j: row.j,
          method: row.entry.method,
          xs,
          pts,
          band,
          bandAll,
          yr,
          hasAny,
          // WHY THE PANEL IS EMPTY, in the reader's terms. The reference mode
          // is named FIRST: a relative column of the mode assigned 2.2.0 is
          // the ratio of that mode to itself, which is 1 with a phase
          // difference of 0 identically. Both sides leave it empty by
          // construction, and saying "no model for 2.2.0" there would be
          // FALSE — 2.2.0 is the one mode that certainly has a model.
          absent: !hasAny
            ? label === undefined || label === null
              ? "this mode carries no assigned label"
              : label === "2.2.0" && mode === "relative"
                ? "reference mode: ratio to itself"
                : p === undefined
                  ? `no prediction for ${label}`
                  : `no model for ${label}`
            : null,
        });
      }
    }

    const xr = padRange(unionRange((doc.t_start_m ?? []).filter(Number.isFinite)) ?? [0, 20], 0.04);
    const foot = [];
    if (dropped > 0) {
      foot.push({ kind: "muted", text: `${dropped} point(s) off the prediction grid: dropped.` });
    }

    const nc = cols.length;
    const nr = rows.length;
    const panelW = Math.max(
      PANEL_MIN_W,
      (avail - PAD.left - PAD.right - (nc - 1) * GAP.x) / nc
    );
    const gridW = PAD.left + nc * panelW + (nc - 1) * GAP.x + PAD.right;
    const headH = head.reduce((a, it) => a + (it.kind === "gap" ? it.h : LINE_H), 0);
    const legendH = 6 * 15 + 8;
    const footH = foot.reduce((a, it) => a + (it.kind === "gap" ? it.h : LINE_H), 0);
    const gridH = nr * PANEL_H + (nr - 1) * GAP.y;
    return {
      head,
      foot,
      panels,
      rows,
      cols,
      xr,
      panelW,
      nr,
      nc,
      headH,
      gridH,
      flagged,
      width: Math.max(avail, Math.ceil(gridW)),
      height: Math.ceil(
        PAD.top + headH + HEAD_GAP + gridH + LEGEND_GAP + legendH + footH + PAD.bottom
      ),
    };
  }

  /** A plan with the text block only: used when there is no panel to draw. */
  _textOnly(ctx, head, doc, avail) {
    const h = head.reduce((a, it) => a + (it.kind === "gap" ? it.h : LINE_H), 0);
    return {
      head,
      foot: [],
      panels: [],
      rows: [],
      cols: [],
      headH: h,
      gridH: 0,
      nr: 0,
      nc: 0,
      flagged: 0,
      width: avail,
      height: Math.ceil(PAD.top + h + PAD.bottom),
    };
  }

  /** Paint the plan. */
  _paint(ctx, plan) {
    let y = PAD.top + LINE_H;
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (const it of plan.head) {
      if (it.kind === "gap") {
        y += it.h;
        continue;
      }
      ctx.font = it.kind === "head" ? HEAD_FONT : BODY_FONT;
      ctx.fillStyle = it.kind === "muted" ? MUTED_COLOR : TEXT_COLOR;
      ctx.fillText(String(it.text), PAD.left, y);
      y += LINE_H;
    }
    ctx.restore();

    const top = PAD.top + plan.headH + HEAD_GAP;
    for (const p of plan.panels) {
      const box = {
        x: PAD.left + p.col * (plan.panelW + GAP.x),
        y: top + p.row * (PANEL_H + GAP.y),
        w: plan.panelW,
        h: PANEL_H,
      };
      this._panel(ctx, box, p, plan);
    }

    let ly = top + plan.gridH + LEGEND_GAP;
    if (plan.panels.length) {
      ly = this._legend(ctx, PAD.left, ly, plan);
      ly += 6;
    }
    ctx.save();
    ctx.font = BODY_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (const it of plan.foot) {
      if (it.kind === "gap") {
        ly += it.h;
        continue;
      }
      ctx.fillStyle = it.kind === "muted" ? MUTED_COLOR : TEXT_COLOR;
      ctx.fillText(String(it.text), PAD.left, ly);
      ly += LINE_H;
    }
    ctx.restore();
  }

  /** Draw one panel: frame, prediction band(s), measured points. */
  _panel(ctx, box, p, plan) {
    const { sx, sy } = drawFrame(ctx, box, {
      xr: plan.xr,
      yr: p.yr,
      xlabel: "t_start [M_rem after the IMR peak]",
      ylabel: p.col_def.label,
      grid: true,
      xTarget: 5,
      yTarget: 5,
      title: `mode ${p.j} → ${p.label ?? "(no label)"}${p.method ? ` (${p.method})` : ""}`,
    });
    if (!p.hasAny) {
      ctx.save();
      ctx.font = BODY_FONT;
      ctx.fillStyle = MUTED_COLOR;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(p.absent ?? "no data", box.x + box.w / 2, box.y + box.h / 2);
      ctx.restore();
      return;
    }
    // The all-sample band FIRST, so the unflagged one is legible on top of it.
    if (p.bandAll) {
      ctx.fillStyle = withAlpha(PRED_ALL_COLOR, 0.35);
      fillBand(ctx, box, p.xs, p.bandAll.lo, p.bandAll.hi, sx, sy);
    }
    if (p.band) {
      ctx.fillStyle = withAlpha(PRED_COLOR, 0.3);
      fillBand(ctx, box, p.xs, p.band.lo, p.band.hi, sx, sy);
      ctx.strokeStyle = PRED_COLOR;
      ctx.lineWidth = 1.6;
      ctx.setLineDash([]);
      strokeSeries(ctx, box, p.xs, p.band.mid, sx, sy);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    for (const q of p.pts) {
      if (!Number.isFinite(q.mid)) continue;
      const col = q.inWindow ? MEAS_COLOR : MEAS_OUT_COLOR;
      const px = sx(q.x);
      ctx.strokeStyle = col;
      ctx.lineWidth = 1.1;
      if (Number.isFinite(q.lo) && Number.isFinite(q.hi)) {
        ctx.beginPath();
        ctx.moveTo(px, sy(q.lo));
        ctx.lineTo(px, sy(q.hi));
        ctx.moveTo(px - CAP_W, sy(q.lo));
        ctx.lineTo(px + CAP_W, sy(q.lo));
        ctx.moveTo(px - CAP_W, sy(q.hi));
        ctx.lineTo(px + CAP_W, sy(q.hi));
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(px, sy(q.mid), DOT_R, 0, 2 * Math.PI);
      if (q.inWindow) {
        ctx.fillStyle = col;
        ctx.fill();
      } else {
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /** The legend: one entry per colour and marker, no caption. */
  _legend(ctx, x, y, plan) {
    const entries = [
      { color: PRED_COLOR, label: "predicted median" },
      {
        color: withAlpha(PRED_COLOR, 0.45),
        label: "predicted 5–95 % (amplitude) or ± circular std (phase)",
        lineWidth: 8,
      },
    ];
    if (plan.flagged > 0) {
      entries.push({
        color: withAlpha(PRED_ALL_COLOR, 0.5),
        label: `predicted, all samples (${plan.flagged} flagged)`,
        lineWidth: 8,
      });
    }
    entries.push(
      { color: MEAS_COLOR, label: "measured, in window", marker: "dot" },
      { color: MEAS_OUT_COLOR, label: "measured, outside window", marker: "dot" }
    );
    return drawLegend(ctx, x, y, entries, "what is drawn");
  }

  /**
   * Size the canvas to the block and clear it.
   *
   * The canvas is allowed to be WIDER than its box: `.plotscroll` in the app's
   * CSS is `overflow-x: auto`, so four columns scroll sideways on a narrow
   * window instead of being squeezed until their tick labels collide.
   */
  _prepareCanvas(width, height) {
    const cssW = Math.max(1, Math.round(width));
    const cssH = Math.max(160, Math.round(height || 320));
    setCanvasCssSize(this.canvas, cssW, cssH);
    const dpr = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
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
