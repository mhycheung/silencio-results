/**
 * views/modeassign.js — the Stage-3 mode assignment, as NUMBERS.
 *
 * Per measured (sampler) mode: the assigned label, the method, the Kerr-plane
 * distance `d_k` of that candidate from 2.2.0, the deviation flag, the blob
 * size, the blob medians of `f` and `gamma`, the conformal threshold, and
 * whether the calibration was valid. Below it the CONTAINMENT MATRIX: the
 * fraction of each of the nine candidates' prediction samples inside that
 * measured mode's conformal region. One measured blob routinely contains
 * several candidates at 1.0, so the printed label is the d_k rank, not a
 * containment measurement — that is why the matrix is drawn.
 *
 * NO VERDICTS. NO FETCH (`main.js :: ensureData` fetches `modeassign.json`).
 *
 * ON-PAGE TEXT IS DELIBERATELY MINIMAL (user ruling 2026-09-18: plots and
 * tables, not words). The payload keeps its notes, conventions and provenance;
 * this view no longer draws them. Do not re-add prose here.
 *
 * THE LOOKUP: a record matches when, for EVERY axis of
 * `config.MODEASSIGN_AXES`, the record's value is `null` or equals the
 * selection. `null` on either side is a wildcard. `not_computed` and
 * `empty_intersection` records are shown as such, with their reason.
 *
 * THE DEFAULT is the payload's own `default_config` string, resolved by
 * MATCHING a record, never by re-parsing the label (A4).
 *
 * CONVENTIONS (A1): `f` in Hz, damping RATE `gamma = 1/tau` in 1/s; `delta_t`
 * and `t_start` in units of the remnant mass `M_rem`, origin at the IMR
 * maximum-likelihood peak; `d_k` ranks candidates and is NOT a goodness of fit;
 * `posterior_mode_idx` is the Stage-2 MATCHED index, joined to the per-run EM
 * index through the payload's `em_index` map (no identity fallback).
 */
import { MODEASSIGN_AXES, MODEASSIGN_STATUSES } from "../config.js";
import { modeAssignConfig } from "../state.js";
import {
  BODY_FONT,
  MUTED_COLOR,
  TEXT_COLOR,
  availableWidth,
  drawMessage,
  setCanvasCssSize,
} from "./plotutil.js";

/** This view's key in the view registry. Value: "modeassign". */
export const VIEW = "modeassign";

/** Font of the table cells. Smaller than `BODY_FONT`: the containment matrix is
 *  ten columns wide and must fit a laptop window without scrolling. */
export const TABLE_FONT = "11px system-ui, sans-serif";

/** Font of a section heading. */
export const HEAD_FONT = "bold 12px system-ui, sans-serif";

/** Row pitch of a table, in CSS pixels. Value: 15. */
export const ROW_H = 15;

/** Line pitch of a prose line, in CSS pixels. Value: 16. */
export const LINE_H = 16;

/** Horizontal gap between two table columns, in CSS pixels. Value: 14. */
export const COL_GAP = 14;

/** Margins of the text block, in CSS pixels. */
export const PAD = Object.freeze({ left: 14, right: 16, top: 16, bottom: 18 });

/** Colour of a cell that carries no number because the calibration was invalid. */
export const ABSENT_COLOR = "#999999";

/** Printed in place of a number that does not exist. Value: "–" (en dash). */
export const ABSENT = "–";

/** Columns of the assignment table: [header, key]. The body builds the cells. */
const ASSIGN_COLUMNS = Object.freeze([
  "measured mode (Stage-2 idx)",
  "EM mode idx in run",
  "label",
  "method",
  "d_k",
  "deviation flag",
  "blob n",
  "median f [Hz]",
  "median γ [1/s]",
  "threshold",
  "calibration",
]);

/**
 * Key of the payload's `em_index` map. Mirrors
 * `silencio.site.data.modeassign.config_key`, whose `:g` format prints 10.0 as
 * "10" — which is what `String(10)` prints for the same number read out of
 * JSON, so the two sides agree without a format string on either.
 * @param {number} n @param {number} dt @param {number} t
 */
export function emKey(n, dt, t) {
  return `${Number(n)}/${Number(dt)}/${Number(t)}`;
}

/**
 * The configuration a record was computed at, as a plain object over
 * `config.MODEASSIGN_AXES`.
 * @param {Object} rec one payload record
 */
export function recordConfig(rec) {
  const out = {};
  for (const axis of MODEASSIGN_AXES) out[axis] = rec[axis] ?? null;
  return out;
}

/**
 * True when one record matches a selection.
 *
 * `null` on either side is a WILDCARD. Numbers are compared as numbers and
 * everything else as strings, because the rail's `<select>` hands back the
 * string "10" for the number 10 (state.js keeps hash values as strings).
 *
 * @param {Object} rec a payload record
 * @param {Object} sel `{axis: value|null}` over `config.MODEASSIGN_AXES`
 */
export function recordMatches(rec, sel) {
  for (const axis of MODEASSIGN_AXES) {
    const want = sel[axis];
    const got = rec[axis];
    if (want === null || want === undefined) continue;
    if (got === null || got === undefined) continue;
    const bothNumeric = Number.isFinite(Number(want)) && typeof got === "number";
    const ok = bothNumeric ? Number(want) === got : String(want) === String(got);
    if (!ok) return false;
  }
  return true;
}

/**
 * The configuration the view falls back to: the payload's `default_config`, at
 * the lowest `n_modes` that carries it.
 *
 * RESOLVED BY MATCHING, not by parsing the label string: re-parsing it here
 * would be a second declaration of the configuration grid (A4). When no record
 * carries the label (a payload whose default was not computed), the lowest
 * `n_modes` `computed` record is used instead and the view says which.
 *
 * @param {Object} doc the parsed `modeassign.json`
 * @returns {{config: Object, source: string}}
 */
export function defaultConfigOf(doc) {
  const wanted = doc.default_config;
  const byLabel = doc.records.filter((r) => r.config_label === wanted);
  const pool = byLabel.length ? byLabel : doc.records.filter((r) => r.status === "computed");
  if (!pool.length) {
    return { config: {}, source: "no computed record in this payload" };
  }
  let best = pool[0];
  for (const r of pool) {
    if ((r.n_modes ?? Infinity) < (best.n_modes ?? Infinity)) best = r;
  }
  return {
    config: recordConfig(best),
    source: byLabel.length
      ? `payload default_config "${wanted}", lowest n_modes`
      : `payload default_config "${wanted}" matches no record; lowest n_modes computed record`,
  };
}

/** `v.toFixed(d)`, or the en dash when `v` is not a finite number. */
function fmt(v, d) {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : ABSENT;
}

/** Break `text` into lines no wider than `maxW` under the current ctx font. */
function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? `${line} ${w}` : w;
    if (line && ctx.measureText(t).width > maxW) {
      lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class ModeAssignView {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lastFrameMs = NaN;
    /** This view has no zoomable panel; the interaction layer reads it anyway. */
    this.hitAreas = [];
  }

  /**
   * Draw one frame.
   *
   * @param {Object} args
   * @param {Object} args.state store state
   * @param {Object} args.loader Loader with preload() done
   * @param {Object[]} [args.series] unused: the assignment is a property of the
   *        Stage-2 window, not of the compare set
   * @param {Object} [args.ctxOverride] draw here instead of the canvas (SVG export)
   * @returns {number} frame time in ms
   */
  render({ state, loader, ctxOverride }) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();

    // `hasExtra` reads the event block, which RAISES on a payload that has
    // none. A payload without an event block cannot advertise anything, so the
    // absence is the answer, not an error to propagate onto the page.
    let advertised = false;
    try {
      advertised = loader.hasExtra("mode_assign");
    } catch (e) {
      advertised = false;
    }
    const doc = advertised ? loader.modeAssignCached() : undefined;

    const block = this._block(state, loader, doc, advertised, ctxOverride);
    const ctx = ctxOverride ?? this._prepareCanvas(block.width, block.height);
    const w = ctxOverride ? ctxOverride.width : this._cssW;
    const h = ctxOverride ? ctxOverride.height : this._cssH;
    if (!ctxOverride) this.hitAreas = [];

    if (block.message) {
      drawMessage(ctx, w, h, block.message);
    } else {
      this._paint(ctx, block);
    }
    this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    return this.lastFrameMs;
  }

  /**
   * Build the draw list, and with it the block's size.
   *
   * The list is built BEFORE the canvas is sized because the height of this
   * view is its content: a two-mode configuration is half the height of a
   * three-mode one, and a `not_computed` record is four lines.
   */
  _block(state, loader, doc, advertised, ctxOverride) {
    const avail = ctxOverride ? ctxOverride.width : availableWidth(this.canvas);
    const ctx = this.ctx; // measurement only; never painted on here
    if (!advertised) {
      return {
        message:
          `${loader.event}: this payload carries no mode-assignment records ` +
          `(the Stage-3 identification has not been built for it).`,
        width: avail,
        height: 0,
      };
    }
    if (doc === undefined) {
      return { message: "loading the mode-assignment records …", width: avail, height: 0 };
    }

    const fallback = defaultConfigOf(doc);
    const sel = modeAssignConfig(state, fallback.config);
    const matches = doc.records.filter((r) => recordMatches(r, sel));
    const items = [];

    items.push({ kind: "head", text: `Mode assignment — ${doc.event}` });
    const selText = MODEASSIGN_AXES.map(
      (a) => `${a} = ${sel[a] === null || sel[a] === undefined ? "(any)" : sel[a]}`
    ).join("   ");
    items.push({ kind: "text", text: selText });
    // ONE short line (user ruling 2026-09-18: no explanations on the page).
    items.push({
      kind: "muted",
      text: "Label = nearest candidate by d_k. The matrix shows which candidates also fit.",
    });
    ctx.font = BODY_FONT;
    const noteW = Math.min(avail, 980) - PAD.left - PAD.right;
    items.push({ kind: "gap", h: 8 });

    if (!matches.length) {
      items.push({
        kind: "text",
        text: "No record was computed for this configuration. Change one dropdown.",
      });
    }
    if (matches.length > 1) {
      items.push({
        kind: "muted",
        text: `${matches.length} records match; the first is shown.`,
      });
      items.push({ kind: "gap", h: 6 });
    }

    const rec = matches[0];
    if (rec !== undefined) this._recordItems(items, rec, doc, state, ctx, noteW);

    // Column widths from the measured text, so nothing is clipped.
    ctx.font = TABLE_FONT;
    for (const it of items) {
      if (it.kind !== "row") continue;
      const tbl = it.table;
      tbl.w = tbl.w ?? [];
      it.cells.forEach((c, i) => {
        const wpx = ctx.measureText(String(c.text)).width;
        tbl.w[i] = Math.max(tbl.w[i] ?? 0, wpx);
      });
    }

    let height = PAD.top + PAD.bottom;
    let maxW = 0;
    for (const it of items) {
      if (it.kind === "gap") height += it.h;
      else if (it.kind === "row") height += ROW_H;
      else height += LINE_H;
      if (it.kind === "row") {
        const tot = it.table.w.reduce((a, b) => a + b + COL_GAP, 0);
        maxW = Math.max(maxW, PAD.left + tot + PAD.right);
      } else {
        ctx.font = it.kind === "head" ? HEAD_FONT : BODY_FONT;
        maxW = Math.max(maxW, PAD.left + ctx.measureText(String(it.text)).width + PAD.right);
      }
    }
    return { items, width: Math.max(avail, Math.ceil(maxW)), height: Math.ceil(height) };
  }

  /** Append the items of ONE record: its status, then its two tables. */
  _recordItems(items, rec, doc, state, ctx, noteW) {
    if (!MODEASSIGN_STATUSES.includes(rec.status)) {
      // A4: an unregistered status is never shown as a computed result.
      items.push({ kind: "text", text: `record status "${rec.status}" is not a registered status` });
      return;
    }
    items.push({ kind: "head", text: `status: ${rec.status}` });
    if (rec.status !== "computed") {
      const reason =
        rec.reason ??
        (rec.status === "empty_intersection"
          ? "the Stage-2 file holds no intersection samples for this window"
          : "no reason recorded");
      for (const line of wrap(ctx, `reason: ${reason}`, noteW)) {
        items.push({ kind: "text", text: line });
      }
      return;
    }
    if (typeof rec.all_conformal === "boolean") {
      items.push({
        kind: "muted",
        text: `every mode assigned by the conformal test: ${rec.all_conformal ? "yes" : "no"}`,
      });
    }
    items.push({ kind: "gap", h: 8 });

    // The EM index applies to ONE run, and the rail's start time picks it.
    const tStart = Array.isArray(state.t) && state.t.length ? Number(state.t[0]) : null;
    const perm =
      tStart === null ? undefined : doc.em_index[emKey(rec.n_modes, rec.delta_t, tStart)];
    items.push({
      kind: "muted",
      text:
        `EM mode index at t_start = ${tStart === null ? "?" : tStart} M_rem` +
        (perm === undefined ? " — that run is outside this Stage-2 window" : ""),
    });
    items.push({ kind: "gap", h: 4 });

    // ---- table 1: one row per measured mode -------------------------------
    const t1 = { w: [] };
    items.push({ kind: "head", text: "assignment" });
    items.push({
      kind: "row",
      table: t1,
      header: true,
      cells: ASSIGN_COLUMNS.map((t) => ({ text: t })),
    });
    for (const a of rec.assignments) {
      const em =
        perm === undefined
          ? "not in this Stage-2 window"
          : perm[a.posterior_mode_idx] === undefined
            ? ABSENT
            : String(perm[a.posterior_mode_idx]);
      const cal = a.calibration_valid
        ? "valid"
        : `invalid: blob too small to calibrate (n = ${a.blob_n})`;
      items.push({
        kind: "row",
        table: t1,
        cells: [
          { text: String(a.posterior_mode_idx) },
          { text: em, muted: perm === undefined },
          { text: a.predicted_label ?? `${ABSENT} (none assigned)`, muted: !a.predicted_label },
          { text: a.method ?? ABSENT },
          { text: fmt(a.d_k, 3) },
          { text: a.deviation_flag ? "yes" : "no" },
          { text: typeof a.blob_n === "number" ? String(a.blob_n) : ABSENT },
          { text: fmt(a.blob_median_f_Hz, 2) },
          { text: fmt(a.blob_median_gamma, 2) },
          { text: fmt(a.threshold, 4) },
          { text: cal, muted: !a.calibration_valid },
        ],
      });
    }
    items.push({ kind: "gap", h: 12 });

    // ---- table 2: the containment matrix ----------------------------------
    const cand = doc.candidates_ranked.map((c) => c.label);
    const t2 = { w: [] };
    items.push({
      kind: "head",
      text: "fraction of each candidate inside the measured blob (columns in d_k order)",
    });
    items.push({
      kind: "row",
      table: t2,
      header: true,
      cells: [{ text: "measured mode" }, ...cand.map((c) => ({ text: c })), { text: "" }],
    });
    for (const a of rec.assignments) {
      const frac = a.fraction_inside ?? {};
      const invalid = !a.calibration_valid;
      items.push({
        kind: "row",
        table: t2,
        cells: [
          { text: String(a.posterior_mode_idx) },
          ...cand.map((c) => {
            const v = frac[c];
            return { text: v === null || v === undefined ? ABSENT : fmt(v, 3), muted: v === null || v === undefined };
          }),
          { text: invalid ? "blob too small to calibrate" : "", muted: true },
        ],
      });
    }
    items.push({ kind: "gap", h: 10 });
    items.push({
      kind: "muted",
      text: `d_k of each candidate: ${doc.candidates_ranked
        .map((c) => `${c.label} ${fmt(c.d_k, 3)}`)
        .join("   ")}`,
    });
  }

  /** Paint the draw list. */
  _paint(ctx, block) {
    let y = PAD.top + LINE_H;
    ctx.save();
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    for (const it of block.items) {
      if (it.kind === "gap") {
        y += it.h;
        continue;
      }
      if (it.kind === "row") {
        ctx.font = TABLE_FONT;
        let x = PAD.left;
        it.cells.forEach((c, i) => {
          ctx.fillStyle = it.header ? TEXT_COLOR : c.muted ? ABSENT_COLOR : TEXT_COLOR;
          ctx.fillText(String(c.text), x, y);
          x += (it.table.w[i] ?? 0) + COL_GAP;
        });
        if (it.header) {
          const tot = it.table.w.reduce((a, b) => a + b + COL_GAP, 0);
          ctx.strokeStyle = ABSENT_COLOR;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(PAD.left, y + 3.5);
          ctx.lineTo(PAD.left + tot, y + 3.5);
          ctx.stroke();
        }
        y += ROW_H;
        continue;
      }
      ctx.font = it.kind === "head" ? HEAD_FONT : BODY_FONT;
      ctx.fillStyle = it.kind === "muted" ? MUTED_COLOR : TEXT_COLOR;
      ctx.fillText(String(it.text), PAD.left, y);
      y += LINE_H;
    }
    ctx.restore();
  }

  /**
   * Size the canvas to the block and clear it.
   *
   * The canvas is allowed to be WIDER than its box: `.plotscroll` in the app's
   * CSS is `overflow-x: auto`, so the containment matrix scrolls sideways on a
   * narrow window instead of being clipped or squeezed.
   */
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
