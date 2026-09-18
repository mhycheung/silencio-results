/**
 * views/consistency.js — the measured-against-predicted credible levels, as a
 * PLOT: credible level against start time, one panel per assigned mode.
 *
 * WHAT IS DRAWN. One panel per measured (Stage-2 matched) mode of the selected
 * `(n_modes, delta_t)`. x is the run start time in `M_rem`, y the credible
 * level of the prediction point in the measured posterior, ranked by a
 * k-nearest-neighbour density (0 at the posterior mode, 1 outside every
 * sample). One colour per quantity group (`LEVEL_GROUPS`): the 4-D level, the
 * 4-D ratio level and the four 1-D levels. SOLID is the assigned label, DASHED
 * in the same colour is the deliberately WRONG-label control (the A2 control of
 * the task that produced the numbers). The pooled-window record — every
 * in-window run taken to `t_start = 0` and pooled — is a marker at the RIGHT
 * EDGE, past a dashed separator, never joined to the per-start-time line.
 *
 * WHAT COLOUR MEANS HERE. Ruling 18 reserves hue for the sampler mode index in
 * the views that decompose a panel BY mode. This view does not: a panel holds
 * exactly one mode, named in its title, so hue is free and carries the quantity
 * group.
 *
 * ONLY THE UNFLAGGED prediction samples are plotted (`SELECTIONS[0]`). The
 * flagged count is printed when it is non-zero; the all-sample band lives in
 * the "Amplitude and phase" view.
 *
 * NO VERDICTS: no threshold, no "confirmed", no "consistent". A control that
 * does not move toward 1 means the test has no power at that start time.
 *
 * NO FETCH (the view contract). `main.js :: ensureData` fetches `ampphase.json`
 * when this view is selected and the event advertises it. The selection is
 * shared with "Amplitude and phase" through the one hash key `ap`.
 *
 * ON-PAGE TEXT IS DELIBERATELY MINIMAL (user ruling 2026-09-18: plots, not
 * words, and a plot rather than a table). The payload keeps its notes,
 * definition, caveat and provenance; this view no longer draws them, and the
 * 26-column table it used to draw is gone. Do not re-add either.
 *
 * CONVENTIONS (A1): `t_start` in `M_rem`, origin at the IMR maximum-likelihood
 * peak; `delta_t` the Stage-2 window half-width in `M_rem`.
 */

import { CONSISTENCY_KINDS } from "../config.js";
import { apKey, resolveConfig } from "./ampphase.js";
import {
  BODY_FONT,
  FRAME_COLOR,
  MUTED_COLOR,
  TEXT_COLOR,
  availableWidth,
  drawFrame,
  drawLegend,
  drawMessage,
  padRange,
  setCanvasCssSize,
  strokeSeries,
  unionRange,
} from "./plotutil.js";

/** This view's key in the view registry. Value: "consistency". */
export const VIEW = "consistency";

/** Font of a section heading. */
export const HEAD_FONT = "bold 12px system-ui, sans-serif";

/** Line pitch of a prose line, in CSS pixels. Value: 16. */
export const LINE_H = 16;

/** Panel height, in CSS pixels. Value: 208 (the same as `ampphase.js`). */
export const PANEL_H = 208;

/** Vertical gap between two panels, in CSS pixels. Value: 62. */
export const PANEL_GAP = 62;

/** Margins of the block, in CSS pixels. */
export const PAD = Object.freeze({ left: 70, right: 24, top: 16, bottom: 20 });

/**
 * Gap between the last header line and the top edge of the first panel, in CSS
 * pixels. Value: 46 — it must clear the PANEL TITLE, which `drawFrame` draws
 * above the box at `box.y - PANEL_TITLE_GAP`. Same constant, same reason, as
 * `ampphase.HEAD_GAP`.
 */
export const HEAD_GAP = 46;

/**
 * Gap between the bottom of the last panel and the legend, in CSS pixels.
 * Value: 58 — it must clear the x axis title at `box.y + box.h + X_TITLE_GAP`.
 */
export const LEGEND_GAP = 58;

/** Dash of the wrong-label control line. Value: [5, 4]. */
export const CONTROL_DASH = Object.freeze([5, 4]);

/** Radius of a pooled-window marker, in CSS pixels. Value: 4. */
export const POOLED_R = 4;

/**
 * The quantity groups of the plot, one line each.
 *
 * `key(tag, sel)` builds the record field: `tag` is "pred" (the assigned label)
 * or "control" (the deliberately wrong label), `sel` is "unflagged" or "all".
 * Declared ONCE here (A4) and used for the legend and the lines alike, so a
 * legend entry can never name a different field from the one drawn.
 */
export const LEVEL_GROUPS = Object.freeze([
  Object.freeze({
    id: "4d",
    label: "4-D",
    color: "#0072b2",
    key: (tag, sel) => `level4d_${tag}_${sel}`,
  }),
  Object.freeze({
    id: "4d_ratio",
    label: "4-D ratio to 2.2.0",
    color: "#d55e00",
    key: (tag, sel) => `level4d_ratio_${tag}_${sel}`,
  }),
  Object.freeze({
    id: "log10A_R",
    label: "log10 A_R",
    color: "#009e73",
    key: (tag, sel) => `level_log10A_R_${tag}_${sel}`,
  }),
  Object.freeze({
    id: "log10A_L",
    label: "log10 A_L",
    color: "#cc79a7",
    key: (tag, sel) => `level_log10A_L_${tag}_${sel}`,
  }),
  Object.freeze({
    id: "phi_R",
    label: "phi_R",
    color: "#e69f00",
    key: (tag, sel) => `level_phi_R_${tag}_${sel}`,
  }),
  Object.freeze({
    id: "phi_L",
    label: "phi_L",
    color: "#56b4e9",
    key: (tag, sel) => `level_phi_L_${tag}_${sel}`,
  }),
]);

/** The two prediction-sample selections. `SELECTIONS[0]` is the one plotted. */
export const SELECTIONS = Object.freeze(["unflagged", "all"]);

/** The two label tags: the assignment and the A2 control. */
export const TAGS = Object.freeze(["pred", "control"]);

/**
 * The records of one `(n_modes, delta_t)`, grouped by measured mode.
 *
 * @param {Object} doc the parsed `ampphase.json`
 * @param {number|string} n @param {number|string} dt
 * @returns {Map<number, Object[]>} mode index -> its records, per-start-time
 *          rows first in start-time order and the pooled row last
 */
export function recordsByMode(doc, n, dt) {
  const out = new Map();
  for (const rec of doc.consistency?.records ?? []) {
    if (Number(rec.n_modes) !== Number(n) || Number(rec.delta_t) !== Number(dt)) continue;
    const j = Number(rec.posterior_mode_idx);
    if (!out.has(j)) out.set(j, []);
    out.get(j).push(rec);
  }
  for (const [, list] of out) {
    list.sort((a, b) => {
      const pa = a.kind === "t_start" ? 0 : 1;
      const pb = b.kind === "t_start" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return Number(a.t_start_m ?? 0) - Number(b.t_start_m ?? 0);
    });
  }
  return new Map([...out.entries()].sort((a, b) => a[0] - b[0]));
}

export class ConsistencyView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lastFrameMs = NaN;
    /** No zoomable panel; the interaction layer reads the list anyway. */
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
    if (!advertised) {
      return {
        message: `${loader.event}: this payload carries no consistency numbers.`,
        width: avail,
        height: 0,
      };
    }
    if (doc === undefined) {
      return { message: "loading the consistency numbers …", width: avail, height: 0 };
    }

    const { config: sel } = resolveConfig(state, doc);
    const prov = doc.consistency?.provenance ?? {};
    const nFlagged = Number(prov.n_flagged ?? 0);
    const nPred = Number(prov.n_pred ?? 0);

    // ONE short line, and the title. User ruling 2026-09-18: no explanations.
    const head = [
      {
        kind: "head",
        text:
          `Consistency — ${doc.event} — n_modes ${sel.n_modes ?? "(any)"}, ` +
          `delta_t ${sel.delta_t ?? "(any)"} M_rem`,
      },
      {
        kind: "muted",
        text:
          "Solid: assigned label. Dashed: wrong-label control." +
          (nFlagged > 0 ? ` Flagged: ${nFlagged} of ${nPred}, not plotted.` : ""),
      },
    ];

    const byMode = recordsByMode(doc, sel.n_modes, sel.delta_t);
    if (!byMode.size) {
      const have = [
        ...new Set((doc.consistency?.records ?? []).map((r) => `${r.n_modes}/${r.delta_t}`)),
      ].join(", ");
      head.push({ kind: "gap", h: 8 });
      head.push({
        kind: "text",
        text: `No consistency record for n_modes = ${sel.n_modes}, delta_t = ${sel.delta_t}.`,
      });
      head.push({ kind: "muted", text: `available (n_modes/delta_t): ${have || "none"}` });
      return this._textOnly(head, avail);
    }

    // Per mode, the series of every group and tag, plus the pooled values.
    // A4: a record whose `kind` is not registered is NOT drawn, and the count
    // of skipped records is printed.
    const sub = SELECTIONS[0];
    let skipped = 0;
    const panels = [];
    const allT = [];
    for (const [j, list] of byMode) {
      const first = list[0] ?? {};
      const perT = list.filter((r) => r.kind === "t_start");
      const pooled = list.filter((r) => r.kind === "window_pooled_at_T0");
      for (const r of list) if (!CONSISTENCY_KINDS.includes(r.kind)) skipped += 1;
      const xs = perT
        .filter((r) => CONSISTENCY_KINDS.includes(r.kind))
        .map((r) => Number(r.t_start_m));
      for (const x of xs) if (Number.isFinite(x)) allT.push(x);
      const lines = [];
      for (const g of LEVEL_GROUPS) {
        for (const tag of TAGS) {
          const ys = perT
            .filter((r) => CONSISTENCY_KINDS.includes(r.kind))
            .map((r) => {
              const v = r[g.key(tag, sub)];
              return typeof v === "number" && Number.isFinite(v) ? v : NaN;
            });
          const pv = pooled.length ? pooled[0][g.key(tag, sub)] : undefined;
          lines.push({
            group: g,
            tag,
            xs,
            ys,
            pooled: typeof pv === "number" && Number.isFinite(pv) ? pv : null,
            any: ys.some(Number.isFinite),
          });
        }
      }
      panels.push({
        j,
        label: first.assigned_label ?? null,
        method: first.method ?? null,
        control: first.control_label ?? null,
        lines,
        hasPooled: pooled.length > 0,
        any: lines.some((l) => l.any || l.pooled !== null),
      });
    }

    const tr = unionRange(allT) ?? [0, 20];
    // The pooled marker sits past the last start time, behind a separator, so
    // it is never read as another point of the line.
    const span = tr[1] - tr[0] || 1;
    const xPooled = tr[1] + 0.12 * span;
    const anyPooled = panels.some((p) => p.hasPooled);
    const xr = padRange(anyPooled ? [tr[0], xPooled + 0.04 * span] : tr, 0.04);
    const xLast = tr[1];

    const foot = [];
    if (skipped > 0) {
      foot.push({
        kind: "muted",
        text: `${skipped} record(s) of an unregistered kind were not drawn.`,
      });
    }

    const headH = head.reduce((a, it) => a + (it.kind === "gap" ? it.h : LINE_H), 0);
    const footH = foot.reduce((a, it) => a + (it.kind === "gap" ? it.h : LINE_H), 0);
    const gridH = panels.length * PANEL_H + (panels.length - 1) * PANEL_GAP;
    const legendH = (LEVEL_GROUPS.length + 3) * 15 + 16;
    return {
      head,
      foot,
      panels,
      xr,
      xPooled,
      xLast,
      anyPooled,
      panelW: Math.max(260, avail - PAD.left - PAD.right),
      gridH,
      headH,
      width: avail,
      height: Math.ceil(
        PAD.top + headH + HEAD_GAP + gridH + LEGEND_GAP + legendH + footH + PAD.bottom
      ),
    };
  }

  /** A plan with the text block only: used when there is no panel to draw. */
  _textOnly(head, avail) {
    const h = head.reduce((a, it) => a + (it.kind === "gap" ? it.h : LINE_H), 0);
    return {
      head,
      foot: [],
      panels: [],
      headH: h,
      gridH: 0,
      panelW: avail,
      xr: [0, 1],
      xPooled: 1,
      xLast: 1,
      anyPooled: false,
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
    plan.panels.forEach((p, i) => {
      const box = {
        x: PAD.left,
        y: top + i * (PANEL_H + PANEL_GAP),
        w: plan.panelW,
        h: PANEL_H,
      };
      this._panel(ctx, box, p, plan);
    });

    let ly = top + plan.gridH + LEGEND_GAP;
    if (plan.panels.length) {
      ly = this._legend(ctx, PAD.left, ly);
      ly += 6;
    }
    ctx.save();
    ctx.font = BODY_FONT;
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (const it of plan.foot) {
      ctx.fillStyle = it.kind === "muted" ? MUTED_COLOR : TEXT_COLOR;
      ctx.fillText(String(it.text), PAD.left, ly);
      ly += LINE_H;
    }
    ctx.restore();
  }

  /** One panel: frame, the twelve lines, the pooled markers. */
  _panel(ctx, box, p, plan) {
    const { sx, sy } = drawFrame(ctx, box, {
      xr: plan.xr,
      yr: [0, 1],
      xlabel: "t_start [M_rem after the IMR peak]",
      ylabel: "credible level",
      grid: true,
      yTarget: 5,
      title:
        `mode ${p.j} → ${p.label ?? "(no label)"}${p.method ? ` (${p.method})` : ""}` +
        `${p.control ? `, control ${p.control}` : ""}`,
    });
    if (!p.any) {
      ctx.save();
      ctx.font = BODY_FONT;
      ctx.fillStyle = MUTED_COLOR;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("no level recorded", box.x + box.w / 2, box.y + box.h / 2);
      ctx.restore();
      return;
    }
    for (const l of p.lines) {
      if (!l.any) continue;
      ctx.strokeStyle = l.group.color;
      ctx.lineWidth = l.tag === "pred" ? 1.8 : 1.2;
      ctx.setLineDash(l.tag === "pred" ? [] : CONTROL_DASH);
      strokeSeries(ctx, box, l.xs, l.ys, sx, sy);
    }
    ctx.setLineDash([]);
    if (!plan.anyPooled) return;
    // The separator and the pooled markers, at the right edge.
    ctx.save();
    ctx.beginPath();
    ctx.rect(box.x, box.y, box.w, box.h);
    ctx.clip();
    const xsep = sx((plan.xLast + plan.xPooled) / 2);
    ctx.strokeStyle = FRAME_COLOR;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(xsep, box.y);
    ctx.lineTo(xsep, box.y + box.h);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.font = BODY_FONT;
    ctx.fillStyle = MUTED_COLOR;
    ctx.textAlign = "center";
    // At the BOTTOM of the panel: the pooled levels themselves sit high in
    // every panel drawn so far, and a top label was printed over them.
    ctx.textBaseline = "bottom";
    ctx.fillText("pooled", sx(plan.xPooled), box.y + box.h - 3);
    const px = sx(plan.xPooled);
    for (const l of p.lines) {
      if (l.pooled === null) continue;
      const py = sy(l.pooled);
      ctx.strokeStyle = l.group.color;
      ctx.fillStyle = l.group.color;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(px, py, POOLED_R, 0, 2 * Math.PI);
      if (l.tag === "pred") ctx.fill();
      else ctx.stroke();
    }
    ctx.restore();
  }

  /** The legend: one entry per quantity group, plus what solid and dashed mean. */
  _legend(ctx, x, y) {
    const entries = LEVEL_GROUPS.map((g) => ({ color: g.color, label: g.label }));
    entries.push(
      { color: TEXT_COLOR, label: "assigned label" },
      { color: TEXT_COLOR, label: "wrong-label control", dash: [...CONTROL_DASH] },
      { color: TEXT_COLOR, label: "pooled over the window at t_start = 0", marker: "dot" }
    );
    return drawLegend(ctx, x, y, entries, "credible level, unflagged prediction samples");
  }

  /** Size the canvas to the block and clear it. */
  _prepareCanvas(width, height) {
    const cssW = Math.max(1, Math.round(width));
    const cssH = Math.max(120, Math.round(height || 320));
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
