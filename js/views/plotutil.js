/**
 * views/plotutil.js — drawing helpers shared by the T4 views.
 *
 * Part of the silencio interactive results application.
 *
 * `views/corner.js` (task T3) carries its own private axis and legend code and
 * is deliberately NOT refactored onto this module: it is gated by G2/G3 as it
 * stands, and rewriting working drawing code to share a helper buys nothing.
 * This module exists for the five views T4 adds.
 *
 * Everything here draws through the Canvas 2D subset that `surface.js` also
 * implements, so every view can render either to a real canvas context (for
 * the screen and for PNG) or to the SVG recorder (for SVG export) with no
 * change to the view code.
 *
 * CONVENTIONS (pitfall A1): nothing here knows about physics. Callers pass
 * ranges already in physical units and supply the axis label, including the
 * unit, themselves.
 *
 * ZOOM (task R4). `scale` is kept, but it is now a thin wrapper over
 * `axis.makeAxis`, which carries its domain and can map pixel -> data as well.
 * `drawFrame` returns the two axis OBJECTS beside the two closures, so a view
 * can publish them for hit-testing. That addition is backward compatible:
 * every existing consumer destructures only `{sx, sy}`.
 */

import { makeAxis } from "./axis.js";

/** Default plot margins in CSS pixels. */
export const PAD = Object.freeze({ left: 68, right: 16, top: 16, bottom: 52 });

/** Axis, frame and text colours, shared so every T4 view matches the corner view. */
export const FRAME_COLOR = "#bbbbbb";
export const TEXT_COLOR = "#222222";
export const MUTED_COLOR = "#666666";
export const GRID_COLOR = "#ececec";

/** Body font used for tick labels and legends. */
export const BODY_FONT = "12px system-ui, sans-serif";

/*
 * LABEL GEOMETRY (task R6, request 5: "the labels overlap and are unreadable").
 *
 * Every offset a label is placed at is a NAMED constant here with its value in
 * the comment (pitfall A4), and every one of them is measured FROM THE PANEL
 * BOX, never from the drawing surface.
 *
 * THE DEFECT THESE REPLACE. `drawFrame` used to place the rotated y-axis title
 * at `ctx.translate(16, box.y + box.h / 2)`. The y coordinate is correctly
 * panel-relative; the x coordinate was the literal 16, which is SURFACE
 * absolute. Every panel outside the left column therefore drew its y title at
 * the far left edge of the whole canvas, stacked on top of the left column's
 * title. That is the overlap the user reported.
 */

/** Gap between a y tick label's right edge and the panel's left edge. Value: 6 px. */
export const TICK_LABEL_GAP = 6;

/** Gap between the widest y tick label and the rotated y title. Value: 8 px. */
export const Y_TITLE_GAP = 8;

/** Gap between the panel's bottom edge and the top of an x tick label. Value: 5 px. */
export const X_TICK_LABEL_GAP = 5;

/** Gap between the panel's bottom edge and the top of the x axis title. Value: 24 px.
 *  A 12 px tick label occupies 5..17 below the box, so 24 clears it. */
export const X_TITLE_GAP = 24;

/** Gap between the panel's top edge and the BOTTOM of the panel title. Value: 12 px.
 *  The topmost y tick label is centred on the box's top edge and so reaches
 *  6 px above it; 12 clears that. */
export const PANEL_TITLE_GAP = 12;

/** Half the height of one line of BODY_FONT text. Value: 6 px (a 12 px font).
 *  Used to test whether two y tick labels, which are centred on their tick,
 *  would touch. Canvas reports ascent and descent per string; this is the
 *  fixed half-line the layout reserves, which is the larger of the two and so
 *  the conservative choice. */
export const TEXT_HALF_HEIGHT = 6;

/** Minimum clear space between two adjacent tick labels. Value: 3 px.
 *  A label that would come closer than this to the previous one is DROPPED —
 *  see `drawFrame`. */
export const TICK_LABEL_CLEARANCE = 3;

/** Target pixels per x tick when the caller names no `xTarget`. Value: 72. */
export const X_TICK_PITCH = 72;

/** Target pixels per y tick when the caller names no `yTarget`. Value: 46. */
export const Y_TICK_PITCH = 46;

/*
 * NARROW (PHONE) LAYOUT (mobile support, 2026-09-16).
 *
 * Five views keep a 200-268 px legend column on the right of the canvas. On a
 * phone that column alone is most of the screen, so below NARROW_MAX_W a view
 * moves its legend BELOW the plot and sets the canvas height itself, as plot
 * height + legend height. On a wide canvas nothing here is called with effect:
 * `setCanvasCssSize(canvas, null, null)` leaves the stylesheet in charge, so the
 * desktop draws exactly what it drew before (gate M-G2 checks the pixels).
 */

/** Available width below which a view uses its narrow layout. Value: 600 CSS px. */
export const NARROW_MAX_W = 600;

/** Right margin of the plot area in the narrow layout. Value: 16 CSS px. */
export const NARROW_PAD_RIGHT = 16;

/** Left edge of a legend drawn below the plot. Value: 12 CSS px. */
export const NARROW_LEGEND_X = 12;

/** Gap between the plot area's bottom margin and the first legend line. Value: 20 CSS px. */
export const NARROW_LEGEND_GAP = 20;

/**
 * The width a view may lay itself out in: the canvas's SCROLL BOX, not the
 * canvas. The corner view can make the canvas wider than the screen, so the
 * canvas's own width would feed that choice back into itself.
 * @param {HTMLCanvasElement} canvas
 */
export function availableWidth(canvas) {
  const p = canvas.parentElement;
  return (p && p.clientWidth) || canvas.clientWidth || 900;
}

/** @param {number} w available width in CSS px */
export function isNarrow(w) {
  return w < NARROW_MAX_W;
}

/**
 * Pin the canvas CSS size. `null` clears that dimension, which hands it back to
 * the stylesheet — the wide layout. Writes only on change, because a write
 * forces layout.
 */
export function setCanvasCssSize(canvas, width, height) {
  const ws = width == null ? "" : `${Math.round(width)}px`;
  const hs = height == null ? "" : `${Math.round(height)}px`;
  if (canvas.style.width !== ws) canvas.style.width = ws;
  if (canvas.style.height !== hs) canvas.style.height = hs;
}

let _scratchCtx = null;

/**
 * The end y of a block of text drawn from y = 0, measured by drawing it once on
 * a detached scratch canvas. `draw(ctx, x, y)` must return the y just below the
 * block, as `drawLegend` does. Nothing reaches the screen.
 * @param {Function} draw
 * @returns {number}
 */
export function measureBlock(draw) {
  if (_scratchCtx === null) _scratchCtx = document.createElement("canvas").getContext("2d");
  _scratchCtx.save();
  try {
    return draw(_scratchCtx, 0, 0);
  } finally {
    _scratchCtx.restore();
  }
}

/**
 * How many ticks fit along a pixel extent, at the given pitch.
 *
 * Used ONLY when the caller names no target. A small panel in a computed grid
 * would otherwise get the old fixed 6 x ticks and 5 y ticks whatever its size,
 * and the labels would collide. Floored at 2 so an axis always shows a scale.
 *
 * @param {number} extent box width or height in CSS pixels
 * @param {number} pitch desired pixels per tick
 */
export function autoTarget(extent, pitch) {
  return Math.max(2, Math.min(8, Math.floor(extent / pitch)));
}

/**
 * Round numbers spanning [lo, hi], about `target` of them.
 *
 * Steps are restricted to 1, 2, 5 times a power of ten, which is what makes the
 * labels readable at any zoom.
 *
 * @param {number} lo
 * @param {number} hi
 * @param {number} [target]
 * @returns {number[]}
 */
export function niceTicks(lo, hi, target = 5) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) return [lo];
  const raw = (hi - lo) / Math.max(target, 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const first = Math.ceil(lo / step - 1e-9) * step;
  const out = [];
  for (let v = first; v <= hi + step * 1e-9; v += step) {
    // Snap values that are one ulp off a round number.
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

/**
 * Short numeric label. Exponential outside [1e-3, 1e4), else 3 significant
 * figures with trailing zeros trimmed.
 * @param {number} v
 */
export function fmtNum(v) {
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a === 0) return "0";
  if (a >= 1e4 || a < 1e-3) return v.toExponential(1);
  const s = v.toPrecision(3);
  return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
}

/**
 * A linear map from a data range onto a pixel range.
 *
 * `flip` is for the y axis, where pixels grow downward and data grows upward.
 *
 * @param {number} d0 data low
 * @param {number} d1 data high
 * @param {number} p0 pixel at d0
 * @param {number} p1 pixel at d1
 * @param {boolean} [flip]
 */
export function scale(d0, d1, p0, p1, flip = false) {
  return makeAxis(d0, d1, p0, p1, flip).toPixel;
}

/**
 * Pad a data range by a fraction of its span, so points do not sit on the frame.
 * A degenerate range is widened to something drawable.
 * @param {number[]} r [lo, hi]
 * @param {number} [frac]
 * @returns {number[]}
 */
export function padRange(r, frac = 0.05) {
  let [lo, hi] = r;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi === lo) {
    const d = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 0.5;
    return [lo - d, hi + d];
  }
  const d = (hi - lo) * frac;
  return [lo - d, hi + d];
}

/** Union of ranges, ignoring non-finite values. Returns null when empty. */
export function unionRange(values) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * The plot box inside a surface of the given CSS size.
 * @param {number} w
 * @param {number} h
 * @param {Object} [pad]
 */
export function plotBox(w, h, pad = PAD) {
  return {
    x: pad.left,
    y: pad.top,
    w: Math.max(10, w - pad.left - pad.right),
    h: Math.max(10, h - pad.top - pad.bottom),
  };
}

/**
 * Draw the frame, tick marks, tick labels and axis titles of one panel.
 *
 * @param {Object} ctx Canvas 2D context, or an SvgSurface
 * @param {Object} box {x, y, w, h}
 * @param {Object} o
 * @param {number[]} o.xr x data range
 * @param {number[]} o.yr y data range
 * @param {string} o.xlabel including the unit
 * @param {string} o.ylabel including the unit
 * @param {boolean} [o.grid] draw faint grid lines at the ticks
 * @param {number} [o.xTarget] approximate x tick count
 * @param {number} [o.yTarget] approximate y tick count
 * @param {Function} [o.xfmt] x tick formatter
 * @returns {{sx: Function, sy: Function, ax: Object, ay: Object,
 *            xticks: number[], yticks: number[]}}
 */
export function drawFrame(ctx, box, o) {
  const { xr, yr, xlabel, ylabel } = o;
  const ax = makeAxis(xr[0], xr[1], box.x, box.x + box.w);
  const ay = makeAxis(yr[0], yr[1], box.y, box.y + box.h, true);
  const sx = ax.toPixel;
  const sy = ay.toPixel;
  const xticks = niceTicks(xr[0], xr[1], o.xTarget ?? autoTarget(box.w, X_TICK_PITCH));
  const yticks = niceTicks(yr[0], yr[1], o.yTarget ?? autoTarget(box.h, Y_TICK_PITCH));
  const xfmt = o.xfmt ?? fmtNum;

  ctx.save();
  ctx.setLineDash([]);

  if (o.grid) {
    ctx.strokeStyle = GRID_COLOR;
    ctx.lineWidth = 1;
    for (const t of xticks) {
      if (t < xr[0] || t > xr[1]) continue;
      ctx.beginPath();
      ctx.moveTo(sx(t), box.y);
      ctx.lineTo(sx(t), box.y + box.h);
      ctx.stroke();
    }
    for (const t of yticks) {
      if (t < yr[0] || t > yr[1]) continue;
      ctx.beginPath();
      ctx.moveTo(box.x, sy(t));
      ctx.lineTo(box.x + box.w, sy(t));
      ctx.stroke();
    }
  }

  ctx.strokeStyle = FRAME_COLOR;
  ctx.lineWidth = 1;
  ctx.strokeRect(box.x + 0.5, box.y + 0.5, box.w, box.h);

  ctx.fillStyle = TEXT_COLOR;
  ctx.font = BODY_FONT;

  // x ticks, below the frame.
  //
  // A label is CLAMPED into the panel horizontally, so it can never reach into
  // the neighbouring panel's margin, and it is DROPPED when it would come
  // within TICK_LABEL_CLEARANCE of the label before it. Dropping beats drawing
  // two numbers on top of each other: an unreadable axis states nothing.
  ctx.textBaseline = "top";
  let lastRight = -Infinity;
  for (const t of xticks) {
    if (t < xr[0] || t > xr[1]) continue;
    const px = sx(t);
    ctx.strokeStyle = FRAME_COLOR;
    ctx.beginPath();
    ctx.moveTo(px, box.y + box.h);
    ctx.lineTo(px, box.y + box.h - 4);
    ctx.stroke();
    const label = xfmt(t);
    const wid = ctx.measureText(label).width;
    let left = px - wid / 2;
    if (left < box.x) left = box.x;
    if (left + wid > box.x + box.w) left = box.x + box.w - wid;
    if (left < lastRight + TICK_LABEL_CLEARANCE) continue;
    ctx.textAlign = "left";
    ctx.fillText(label, left, box.y + box.h + X_TICK_LABEL_GAP);
    lastRight = left + wid;
  }
  ctx.textAlign = "center";
  ctx.fillText(xlabel, box.x + box.w / 2, box.y + box.h + X_TITLE_GAP);

  // y ticks, left of the frame. The widest label drawn sets where the rotated
  // y title goes, so the title clears the numbers at any zoom.
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  let maxTickW = 0;
  let lastTop = Infinity;
  for (const t of yticks) {
    if (t < yr[0] || t > yr[1]) continue;
    const py = sy(t);
    ctx.strokeStyle = FRAME_COLOR;
    ctx.beginPath();
    ctx.moveTo(box.x, py);
    ctx.lineTo(box.x + 4, py);
    ctx.stroke();
    const label = fmtNum(t);
    // Labels run bottom-to-top in pixels, so "the previous one" is below.
    if (py + TEXT_HALF_HEIGHT + TICK_LABEL_CLEARANCE > lastTop) continue;
    maxTickW = Math.max(maxTickW, ctx.measureText(label).width);
    ctx.fillText(label, box.x - TICK_LABEL_GAP, py);
    lastTop = py - TEXT_HALF_HEIGHT;
  }

  // The y axis title — PANEL-RELATIVE IN BOTH COORDINATES. See the header note
  // on the surface-absolute `16` this replaces.
  ctx.save();
  ctx.translate(box.x - TICK_LABEL_GAP - maxTickW - Y_TITLE_GAP, box.y + box.h / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(ylabel, 0, 0);
  ctx.restore();

  // An optional panel title, centred above the panel. Added for the computed
  // diagnostics grid, where a panel is no longer identifiable from its axis
  // labels alone. Optional, so every existing caller is unaffected.
  if (o.title) {
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText(o.title, box.x + box.w / 2, box.y - PANEL_TITLE_GAP);
  }

  ctx.restore();
  return { sx, sy, ax, ay, xticks, yticks };
}

/**
 * Draw a legend block. Each entry is {color, label, dash, marker}.
 * `marker` "line" (default) or "dot".
 *
 * @param {Object} ctx
 * @param {number} x left edge
 * @param {number} y top edge
 * @param {Object[]} entries
 * @param {string} [title]
 * @returns {number} the y coordinate just below the block
 */
export function drawLegend(ctx, x, y, entries, title) {
  ctx.save();
  ctx.font = BODY_FONT;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.setLineDash([]);
  let yy = y;
  if (title) {
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText(title, x, yy);
    yy += 16;
  }
  for (const e of entries) {
    if (e.marker === "dot") {
      ctx.fillStyle = e.color;
      ctx.beginPath();
      ctx.arc(x + 9, yy, 3.4, 0, 2 * Math.PI);
      ctx.fill();
    } else {
      ctx.strokeStyle = e.color;
      ctx.lineWidth = e.lineWidth ?? 2.4;
      ctx.setLineDash(e.dash ?? []);
      ctx.beginPath();
      ctx.moveTo(x, yy);
      ctx.lineTo(x + 18, yy);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = TEXT_COLOR;
    ctx.fillText(e.label, x + 24, yy);
    yy += 15;
  }
  ctx.restore();
  return yy;
}

/**
 * Stroke a polyline given as parallel data arrays, clipped to the box.
 * Non-finite samples break the line rather than drawing a spike to zero.
 *
 * @param {Object} ctx
 * @param {Object} box
 * @param {ArrayLike<number>} xs data x
 * @param {ArrayLike<number>} ys data y
 * @param {Function} sx
 * @param {Function} sy
 */
export function strokeSeries(ctx, box, xs, ys, sx, sy) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  ctx.beginPath();
  let pen = false;
  const n = Math.min(xs.length, ys.length);
  for (let i = 0; i < n; i++) {
    const vx = xs[i];
    const vy = ys[i];
    if (!Number.isFinite(vx) || !Number.isFinite(vy)) {
      pen = false;
      continue;
    }
    const px = sx(vx);
    const py = sy(vy);
    if (!pen) {
      ctx.moveTo(px, py);
      pen = true;
    } else ctx.lineTo(px, py);
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * Fill the region between two y series (a band), clipped to the box.
 *
 * Runs of finite samples are filled as separate polygons, so a gap in the band
 * is a gap in the fill and never a straight line across it.
 */
export function fillBand(ctx, box, xs, lo, hi, sx, sy) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(box.x, box.y, box.w, box.h);
  ctx.clip();
  const n = Math.min(xs.length, lo.length, hi.length);
  let i = 0;
  while (i < n) {
    while (
      i < n &&
      !(Number.isFinite(xs[i]) && Number.isFinite(lo[i]) && Number.isFinite(hi[i]))
    ) {
      i++;
    }
    const start = i;
    while (
      i < n &&
      Number.isFinite(xs[i]) &&
      Number.isFinite(lo[i]) &&
      Number.isFinite(hi[i])
    ) {
      i++;
    }
    const end = i;
    if (end - start < 2) continue;
    ctx.beginPath();
    ctx.moveTo(sx(xs[start]), sy(hi[start]));
    for (let k = start + 1; k < end; k++) ctx.lineTo(sx(xs[k]), sy(hi[k]));
    for (let k = end - 1; k >= start; k--) ctx.lineTo(sx(xs[k]), sy(lo[k]));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/** A filled dot. */
export function dot(ctx, px, py, r) {
  ctx.beginPath();
  ctx.arc(px, py, r, 0, 2 * Math.PI);
  ctx.fill();
}

/** A cross marker, for the Kerr predictions. */
export function cross(ctx, px, py, r) {
  ctx.beginPath();
  ctx.moveTo(px - r, py);
  ctx.lineTo(px + r, py);
  ctx.moveTo(px, py - r);
  ctx.lineTo(px, py + r);
  ctx.stroke();
}

/** Centred message, for a view with nothing to draw yet. */
export function drawMessage(ctx, w, h, text) {
  ctx.save();
  ctx.font = BODY_FONT;
  ctx.fillStyle = MUTED_COLOR;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, w / 2, h / 2);
  ctx.restore();
}
