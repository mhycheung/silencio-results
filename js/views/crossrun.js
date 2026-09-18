/**
 * views/crossrun.js — `f` and `gamma` against start time, with credible bands,
 * for every run of the selected configuration (spec section 6, view 3).
 *
 * Part of the silencio interactive results application.
 *
 * WHAT IS NEW HERE, honestly stated: this view already exists as STATIC group
 * figures. The gain is that it is interactive and overlayable, not that the
 * content is new (spec section 6, view 3).
 *
 * NO FETCH. Everything drawn here comes from the preloaded Tier 3 summary:
 * `summary.runs["<cfg>/<n>_<t>"].per_mode[m][param] = {median, q05, q95}`.
 * Moving the slider therefore costs nothing but a redraw.
 *
 * LAYOUT: rows are parameters (`f` on top, `gamma` below), columns are the
 * selected mode counts. Within a panel, x is `t_start` and each sampler mode
 * index gets its own colour, with the q05..q95 band shaded.
 *
 * CONVENTIONS (pitfall A1, restated at the point of use):
 *   * `t_start` is in units of the remnant mass M_rem, origin at the IMR
 *     maximum-likelihood peak GPS time.
 *   * `f` is in Hz. The damping variable is the RATE `gamma = 1/tau` in 1/s,
 *     which is what the sampler samples and what the prior box is on.
 *   * Colour here means SAMPLER EM MODE INDEX, not a QNM label. Mode indices
 *     are not ordered by amplitude and carry no physical identification
 *     (`A_true` is nan on real data).
 *
 * COLOUR MEANS MODE, THROUGH THE SHARED `modeColor` (ruling 18). This view was
 * already keyed on the mode index, but through its own `PIN_PALETTE[m]`, so a
 * mode was one colour here and a different one in the corner and f-gamma views.
 * It now draws from the one shared mode palette, so mode index `m` is the same
 * hue in every view and for every run — which is the whole point of ruling 18.
 *
 * THE BAND IS ALWAYS 90%, WHATEVER THE LEVEL CONTROL SAYS. Tier 3 stores only
 * `q05` and `q95`, so the 5th-to-95th-percentile interval is the only band
 * this view can draw. The control rail now carries a SET of levels (`st.levs`,
 * ruling 20), and this view is the asymmetric one: it draws the band when 90 is
 * in that set, and otherwise draws none and says so in words. It NEVER relabels
 * q05/q95 as a 50% or 99% band — that would be a false statement about the
 * posterior, not a cosmetic mismatch.
 *
 * SO LINE DASH CARRIES NO LEVEL CODE HERE. With exactly one drawable band level
 * there is nothing for a per-level dash to distinguish, and the legend says so
 * rather than leaving the reader to guess at an encoding that is not there.
 */

import { modeColor, withAlpha } from "../colors.js";
import { getParam } from "../config.js";
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

/** Parameters shown, one panel row each, in display order. */
export const CROSSRUN_PARAMS = Object.freeze(["f", "gamma"]);

/** The credible level Tier 3's q05/q95 actually represent, in percent. Value: 90. */
export const TIER3_BAND_LEVEL = 90;

/** Panel margins and the gap between panels, in CSS pixels. */
/** This view's key in the view registry, and the prefix of its window keys. */
const VIEW = "crossrun";

/** Window key of the shared x axis. Every panel in this view plots t_start. */
const X_AXIS_ID = "t_start";

const PAD = Object.freeze({ left: 72, right: 200, top: 18, bottom: 54 });
const GAP = Object.freeze({ x: 44, y: 46 });

/** Height of one panel in the narrow (phone) layout, where the panels form ONE column. Value: 190 CSS px. */
export const NARROW_PANEL_H = 190;

/** Vertical gap between panels in the narrow layout. Value: 66 CSS px, 20 more than
 *  GAP.y, because every narrow panel carries its own heading above it. */
export const NARROW_GAP_Y = 66;

export class CrossRunView {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.lastFrameMs = NaN;
    /** Panels the interaction layer may zoom; republished on every frame. */
    this.hitAreas = [];
  }

  /**
   * Draw one frame.
   *
   * @param {Object} args
   * @param {Object} args.state store state
   * @param {Object} args.loader Loader with preload() done
   * @param {Object[]} args.series the compare set, used only to mark the live
   *        and pinned runs on the start-time axis
   * @param {Object} [args.ctxOverride] draw here instead of the canvas (SVG export)
   * @returns {number} frame time in ms
   */
  render({ state, loader, series, ctxOverride }) {
    const t0 = (typeof performance !== "undefined" ? performance : Date).now();

    const nModesList = [...state.n].sort((a, b) => a - b);
    const rows = CROSSRUN_PARAMS;

    // 1. Collect the Tier 3 rows: one entry per (n_modes, mode index, t_start).
    //    A run missing from the summary is skipped, not faked.
    const data = new Map(); // `${n}|${m}|${param}` -> {ts, med, lo, hi}
    let maxMode = 0;
    let nFound = 0;
    for (const n of nModesList) {
      let times;
      try {
        times = loader.startTimes(state.cfg, n);
      } catch (e) {
        times = [];
      }
      for (const param of rows) {
        const perMode = [];
        for (const t of times) {
          const rec = loader.summaryOf(state.cfg, n, t);
          if (rec === undefined || !Array.isArray(rec.per_mode)) continue;
          nFound++;
          for (let m = 0; m < rec.per_mode.length; m++) {
            const st = rec.per_mode[m]?.[param];
            if (st === undefined) continue;
            if (perMode[m] === undefined) perMode[m] = { ts: [], med: [], lo: [], hi: [] };
            perMode[m].ts.push(t);
            perMode[m].med.push(st.median);
            perMode[m].lo.push(st.q05);
            perMode[m].hi.push(st.q95);
            if (m > maxMode) maxMode = m;
          }
        }
        perMode.forEach((v, m) => {
          if (v) data.set(`${n}|${m}|${param}`, v);
        });
      }
    }

    // The selected credible levels (ruling 20). The EMPTY set is legal and
    // means "draw no credible regions", so this is a membership test and never
    // a fallback to a default level. `levs` is read here and nowhere else, so
    // the band condition and the legend text cannot disagree.
    const levs = levelsOf(state);
    const legendFrame = { maxMode, levs };
    const nPanels = Math.max(1, nModesList.length) * rows.length;

    // The canvas is sized only now, because the narrow layout's height depends
    // on the data just collected (the legend length).
    const ctx = ctxOverride ?? this._prepareCanvas(nFound ? nPanels : 0, legendFrame);
    const w = ctxOverride ? ctxOverride.width : this._cssW;
    const h = ctxOverride ? ctxOverride.height : this._cssH;

    if (nFound === 0) {
      drawMessage(ctx, w, h, `no Tier 3 summary rows for configuration "${state.cfg}"`);
      this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
      return this.lastFrameMs;
    }

    // 2. Panel geometry: rows = parameters, columns = mode counts.
    const nc = Math.max(1, nModesList.length);
    const nr = rows.length;
    // Narrow: ONE column, ordered by mode count and then parameter, each
    // panel titled. `this._narrow`, not `w`, decides, so an SVG export repeats
    // the screen.
    const narrow = this._narrow;
    const outer = narrow
      ? { x: PAD.left, y: PAD.top, w: Math.max(10, w - PAD.left - NARROW_PAD_RIGHT), h: this._plotH(nc * nr) }
      : plotBox(w, h, PAD);
    const cw = (outer.w - (nc - 1) * GAP.x) / nc;
    const ch = (outer.h - (nr - 1) * GAP.y) / nr;
    const panel = narrow
      ? (r, c) => ({
          x: outer.x,
          y: outer.y + (c * nr + r) * (NARROW_PANEL_H + NARROW_GAP_Y),
          w: outer.w,
          h: NARROW_PANEL_H,
        })
      : (r, c) => ({
          x: outer.x + c * (cw + GAP.x),
          y: outer.y + r * (ch + GAP.y),
          w: cw,
          h: ch,
        });

    // 3. A shared y range per parameter, so panels of different mode counts are
    //    directly comparable across columns.
    const yr = new Map();
    for (const param of rows) {
      const vals = [];
      for (const [k, v] of data) {
        if (!k.endsWith(`|${param}`)) continue;
        for (const x of v.lo) vals.push(x);
        for (const x of v.hi) vals.push(x);
      }
      // One window per PARAMETER, so a row stays directly comparable across
      // columns after a zoom, exactly as it is before one.
      yr.set(param, windowOf(state, VIEW, param, padRange(unionRange(vals) ?? [0, 1], 0.06)));
    }

    // 4. Draw each panel.
    if (!ctxOverride) this.hitAreas = [];
    const bandShown = levs.includes(TIER3_BAND_LEVEL);
    const liveT = new Set(state.t);
    const pinKeys = new Set(series.filter((s) => s.isPin).map((s) => runKey(s.cfg, s.n, s.t)));

    for (let c = 0; c < nc; c++) {
      const n = nModesList[c];
      let times = [];
      try {
        times = loader.startTimes(state.cfg, n);
      } catch (e) {
        times = [];
      }
      const xr = windowOf(state, VIEW, X_AXIS_ID, padRange(unionRange(times) ?? [0, 15], 0.04));

      for (let r = 0; r < nr; r++) {
        const param = rows[r];
        const p = getParam(param);
        const box = panel(r, c);
        const { sx, sy, ax, ay } = drawFrame(ctx, box, {
          xr,
          yr: yr.get(param),
          xlabel: "t_start [M_rem after the IMR peak]",
          ylabel: p.unit ? `${p.label} [${p.unit}]` : p.label,
          grid: true,
          xTarget: 6,
          yTarget: 5,
        });
        if (!ctxOverride) {
          this.hitAreas.push({
            box,
            ax,
            ay,
            xKey: zoomKey(VIEW, X_AXIS_ID),
            yKey: zoomKey(VIEW, param),
          });
        }

        // The live start time(s), as a vertical rule, so the slider position is
        // visible in a view whose x axis IS the slider.
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

        for (let m = 0; m < n; m++) {
          const v = data.get(`${n}|${m}|${param}`);
          if (v === undefined) continue;
          // Ruling 18: colour means MODE, from the one shared palette.
          const color = modeColor(m);
          if (bandShown) {
            ctx.fillStyle = withAlpha(color, 0.18);
            fillBand(ctx, box, v.ts, v.lo, v.hi, sx, sy);
          }
          ctx.save();
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.8;
          ctx.setLineDash([]);
          strokeSeries(ctx, box, v.ts, v.med, sx, sy);
          ctx.restore();

          // Mark the live and pinned runs, so the compare set is locatable here.
          ctx.save();
          ctx.fillStyle = color;
          for (let i = 0; i < v.ts.length; i++) {
            const t = v.ts[i];
            const isLive = liveT.has(t);
            const isPin = pinKeys.has(runKey(state.cfg, n, t));
            if (!isLive && !isPin) continue;
            ctx.beginPath();
            ctx.arc(sx(t), sy(v.med[i]), isPin ? 4.2 : 3.0, 0, 2 * Math.PI);
            ctx.fill();
          }
          ctx.restore();
        }

        // Column heading, once per column; on every panel in the narrow column.
        if (r === 0 || narrow) {
          ctx.save();
          ctx.font = BODY_FONT;
          ctx.fillStyle = TEXT_COLOR;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillText(`${n}-mode fits`, box.x + box.w / 2, box.y - 4);
          ctx.restore();
        }
      }
    }

    // 5. Legend.
    if (narrow) {
      this._legend(ctx, NARROW_LEGEND_X, outer.y + outer.h + PAD.bottom + NARROW_LEGEND_GAP, legendFrame);
    } else {
      this._legend(ctx, w - PAD.right + 14, PAD.top + 6, legendFrame);
    }

    this.lastFrameMs = (typeof performance !== "undefined" ? performance : Date).now() - t0;
    return this.lastFrameMs;
  }

  /** Height of `np` stacked panels, gaps included, in the narrow layout. */
  _plotH(np) {
    return np * NARROW_PANEL_H + (np - 1) * NARROW_GAP_Y;
  }

  /**
   * Draw the legend block from (lx, ly); returns the y below it. Colour means
   * MODE INDEX in this view, and the legend says so.
   * @param {{maxMode: number, levs: number[]}} frame
   */
  _legend(ctx, lx, ly, { maxMode, levs }) {
    const bandShown = levs.includes(TIER3_BAND_LEVEL);
    /** Selected levels this view cannot honour, for the legend to name. */
    const undrawable = levs.filter((L) => L !== TIER3_BAND_LEVEL);
    const entries = [];
    for (let m = 0; m <= maxMode; m++) {
      entries.push({ color: modeColor(m), label: `mode index ${m}` });
    }
    ly = drawLegend(ctx, lx, ly, entries, "sampler EM mode index");
    ly += 8;
    ctx.save();
    ctx.font = BODY_FONT;
    ctx.fillStyle = MUTED_COLOR;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    // The legend states the encoding this frame actually used, and names every
    // selected level it could not honour. A level silently dropped from the
    // drawing but left showing in the rail is the failure mode this text exists
    // to prevent.
    const common = [
      "line: posterior median",
      "dot: live or pinned run",
      "dashed rule: slider position",
      "",
      "colour: sampler EM mode index",
      "(the shared mode palette, so a",
      "mode is one colour in every view)",
      "",
      "Line dash carries NO level code",
      "here: 90% is the only band level",
      "Tier 3 can draw.",
    ];
    let notes;
    if (bandShown) {
      notes = [
        `band: ${TIER3_BAND_LEVEL}% credible`,
        "(Tier 3 q05..q95)",
        ...common,
      ];
      if (undrawable.length) {
        notes.push(
          "",
          `No ${undrawable.join("% / ")}% band is drawn:`,
          "Tier 3 stores only q05/q95."
        );
      }
    } else if (levs.length === 0) {
      notes = ["no credible band: no level is", "selected in the rail.", "", ...common];
    } else {
      notes = [
        `the rail asks for ${levs.join("% / ")}%,`,
        "but Tier 3 stores only q05/q95.",
        `No band is drawn: a ${TIER3_BAND_LEVEL}%`,
        `band under a ${levs.join("/")}% label`,
        "would be mislabelled.",
        "",
        ...common,
      ];
    }
    notes.push(
      "",
      "Mode indices are sampler EM",
      "indices, not QNM labels, and",
      "are not ordered by amplitude."
    );
    for (const line of notes) {
      if (line !== "") ctx.fillText(line, lx, ly);
      ly += 14;
    }
    ctx.restore();
    return ly;
  }

  /**
   * @param {number} nPanels panels to lay out; 0 when only a message is drawn
   * @param {Object} legendFrame the argument `_legend` will be drawn with
   */
  _prepareCanvas(nPanels, legendFrame) {
    const avail = availableWidth(this.canvas);
    this._narrow = isNarrow(avail);
    if (this._narrow && nPanels > 0) {
      const legendH = measureBlock((c, x, y) => this._legend(c, x, y, legendFrame));
      setCanvasCssSize(this.canvas, avail, PAD.top + this._plotH(nPanels) + PAD.bottom + NARROW_LEGEND_GAP + legendH);
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
