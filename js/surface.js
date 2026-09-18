/**
 * surface.js — an SVG recorder exposing the Canvas 2D subset the views use.
 *
 * Part of the silencio interactive results application.
 *
 * WHY THIS EXISTS. The views draw on Canvas 2D, which exports to PNG for free
 * (`canvas.toBlob`) but cannot produce a vector file. Rather than write a
 * second rendering path per view — five more chances for the screen and the
 * export to disagree — this class implements the SAME method names Canvas 2D
 * uses and records the calls as SVG. A view therefore renders to either target
 * with no change to its drawing code, and what you export is what you saw.
 *
 * `views/corner.js` gets SVG export the same way, through its `ctxOverride`
 * field; its drawing code is untouched.
 *
 * WHAT IS IMPLEMENTED, and nothing more: the subset the views actually call.
 *   state      save, restore, globalAlpha
 *   transform  translate, rotate, scale, setTransform, resetTransform
 *   style      strokeStyle, fillStyle, lineWidth, setLineDash, lineCap, lineJoin
 *   text       font, textAlign, textBaseline, fillText, measureText
 *   paths      beginPath, closePath, moveTo, lineTo, rect, arc, stroke, fill
 *   shapes     strokeRect, fillRect, clearRect
 *   clipping   clip
 *
 * A method this class does not implement is a method no view may call. Adding a
 * call to a view without adding it here makes the SVG silently lose the
 * element, so the unimplemented names are defined and THROW rather than being
 * absent (pitfall A4: no silent fallback).
 *
 * LIMITS, stated because they are real:
 *   * `arc` is emitted as a 32-segment polyline. At marker sizes this is
 *     visually exact; it is not a true SVG arc.
 *   * `measureText` returns an ESTIMATE (0.6 em per character). No view
 *     positions anything load-bearing on it; text is placed with `textAlign`.
 *   * Coordinates are baked through the current transform, so the emitted SVG
 *     has no nested transforms except on rotated text.
 */

/** Segments used to approximate a full circle in `arc`. Value: 32. */
export const ARC_SEGMENTS = 32;

/** Estimated glyph width as a fraction of the font size. Value: 0.6. */
export const TEXT_WIDTH_EM = 0.6;

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function num(v) {
  // Three decimals is below one device pixel and keeps the file small.
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? 0 : r;
}

/** Multiply two affine matrices [a, b, c, d, e, f]. */
function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

const ANCHOR = { left: "start", center: "middle", right: "end", start: "start", end: "end" };
const BASELINE = {
  top: "hanging",
  hanging: "hanging",
  middle: "central",
  alphabetic: "alphabetic",
  bottom: "auto",
  ideographic: "auto",
};

export class SvgSurface {
  /**
   * @param {number} width CSS pixels
   * @param {number} height CSS pixels
   * @param {Object} [opts]
   * @param {string} [opts.background] background fill; omit for transparent
   */
  constructor(width, height, opts = {}) {
    this.width = width;
    this.height = height;
    this._bg = opts.background ?? "#ffffff";
    this._out = [];
    this._defs = [];
    this._clipSeq = 0;
    this._path = [];
    this._cur = null;
    this._stack = [];
    // A canvas-like handle, so view code that reads `ctx.canvas` still works.
    this.canvas = {
      width,
      height,
      clientWidth: width,
      clientHeight: height,
    };
    this.strokeStyle = "#000000";
    this.fillStyle = "#000000";
    this.lineWidth = 1;
    this.globalAlpha = 1;
    this.font = "12px system-ui, sans-serif";
    this.textAlign = "start";
    this.textBaseline = "alphabetic";
    this.lineCap = "butt";
    this.lineJoin = "miter";
    this._dash = [];
    this._ctm = [1, 0, 0, 1, 0, 0];
    this._clip = null;
  }

  // -- state ---------------------------------------------------------------

  save() {
    this._stack.push({
      strokeStyle: this.strokeStyle,
      fillStyle: this.fillStyle,
      lineWidth: this.lineWidth,
      globalAlpha: this.globalAlpha,
      font: this.font,
      textAlign: this.textAlign,
      textBaseline: this.textBaseline,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      dash: this._dash.slice(),
      ctm: this._ctm.slice(),
      clip: this._clip,
    });
  }

  restore() {
    const s = this._stack.pop();
    if (s === undefined) return;
    this.strokeStyle = s.strokeStyle;
    this.fillStyle = s.fillStyle;
    this.lineWidth = s.lineWidth;
    this.globalAlpha = s.globalAlpha;
    this.font = s.font;
    this.textAlign = s.textAlign;
    this.textBaseline = s.textBaseline;
    this.lineCap = s.lineCap;
    this.lineJoin = s.lineJoin;
    this._dash = s.dash;
    this._ctm = s.ctm;
    this._clip = s.clip;
  }

  setLineDash(d) {
    this._dash = Array.isArray(d) ? d.slice() : [];
  }

  getLineDash() {
    return this._dash.slice();
  }

  // -- transforms ----------------------------------------------------------

  translate(tx, ty) {
    this._ctm = mul(this._ctm, [1, 0, 0, 1, tx, ty]);
  }

  rotate(a) {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this._ctm = mul(this._ctm, [c, s, -s, c, 0, 0]);
  }

  scale(sx, sy) {
    this._ctm = mul(this._ctm, [sx, 0, 0, sy, 0, 0]);
  }

  setTransform(a, b, c, d, e, f) {
    this._ctm = [a, b, c, d, e, f];
  }

  resetTransform() {
    this._ctm = [1, 0, 0, 1, 0, 0];
  }

  _pt(x, y) {
    const m = this._ctm;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /** True when the transform is a pure translation plus uniform scale. */
  _isAxisAligned() {
    const m = this._ctm;
    return Math.abs(m[1]) < 1e-12 && Math.abs(m[2]) < 1e-12;
  }

  // -- paths ---------------------------------------------------------------

  beginPath() {
    this._path = [];
    this._cur = null;
  }

  moveTo(x, y) {
    this._cur = { pts: [this._pt(x, y)], closed: false };
    this._path.push(this._cur);
  }

  lineTo(x, y) {
    if (this._cur === null) return this.moveTo(x, y);
    this._cur.pts.push(this._pt(x, y));
  }

  closePath() {
    if (this._cur) this._cur.closed = true;
  }

  rect(x, y, w, h) {
    this._cur = {
      pts: [this._pt(x, y), this._pt(x + w, y), this._pt(x + w, y + h), this._pt(x, y + h)],
      closed: true,
    };
    this._path.push(this._cur);
    // Canvas leaves the current point at the rect origin for a following lineTo.
    this._cur = null;
  }

  arc(cx, cy, r, a0, a1, ccw = false) {
    let span = a1 - a0;
    if (!ccw && span < 0) span += 2 * Math.PI;
    if (ccw && span > 0) span -= 2 * Math.PI;
    const n = Math.max(3, Math.ceil((Math.abs(span) / (2 * Math.PI)) * ARC_SEGMENTS));
    const pts = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + (span * i) / n;
      pts.push(this._pt(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
    const closed = Math.abs(Math.abs(span) - 2 * Math.PI) < 1e-9;
    this._cur = { pts, closed };
    this._path.push(this._cur);
  }

  _d() {
    const parts = [];
    for (const sp of this._path) {
      if (sp.pts.length === 0) continue;
      parts.push(`M${num(sp.pts[0][0])} ${num(sp.pts[0][1])}`);
      for (let i = 1; i < sp.pts.length; i++) {
        parts.push(`L${num(sp.pts[i][0])} ${num(sp.pts[i][1])}`);
      }
      if (sp.closed) parts.push("Z");
    }
    return parts.join(" ");
  }

  _clipAttr() {
    return this._clip ? ` clip-path="url(#${this._clip})"` : "";
  }

  _alphaAttr(kind) {
    return this.globalAlpha < 1 ? ` ${kind}-opacity="${num(this.globalAlpha)}"` : "";
  }

  _strokeAttrs() {
    // The transform is baked into the coordinates, so the stroke width must be
    // scaled by the same factor or it would not match the canvas.
    const m = this._ctm;
    const k = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    let a =
      ` fill="none" stroke="${esc(this.strokeStyle)}"` +
      ` stroke-width="${num(this.lineWidth * k)}"`;
    if (this._dash.length) a += ` stroke-dasharray="${this._dash.map((v) => num(v * k)).join(",")}"`;
    if (this.lineCap !== "butt") a += ` stroke-linecap="${esc(this.lineCap)}"`;
    if (this.lineJoin !== "miter") a += ` stroke-linejoin="${esc(this.lineJoin)}"`;
    return a + this._alphaAttr("stroke");
  }

  stroke() {
    const d = this._d();
    if (d === "") return;
    this._out.push(`<path d="${d}"${this._strokeAttrs()}${this._clipAttr()}/>`);
  }

  fill() {
    const d = this._d();
    if (d === "") return;
    this._out.push(
      `<path d="${d}" fill="${esc(this.fillStyle)}" stroke="none"` +
        `${this._alphaAttr("fill")}${this._clipAttr()}/>`
    );
  }

  clip() {
    const id = `clip${++this._clipSeq}`;
    this._defs.push(`<clipPath id="${id}"><path d="${this._d()}"/></clipPath>`);
    this._clip = id;
  }

  // -- shapes --------------------------------------------------------------

  strokeRect(x, y, w, h) {
    this.beginPath();
    this.rect(x, y, w, h);
    this.stroke();
  }

  fillRect(x, y, w, h) {
    this.beginPath();
    this.rect(x, y, w, h);
    this.fill();
  }

  clearRect(x, y, w, h) {
    // On an SVG the background is painted once in toSVG(); a clearRect over the
    // whole surface is therefore a no-op rather than a white rectangle that
    // would defeat a transparent export.
    if (x <= 0 && y <= 0 && w >= this.width && h >= this.height) return;
    const save = this.fillStyle;
    this.fillStyle = this._bg;
    this.fillRect(x, y, w, h);
    this.fillStyle = save;
  }

  // -- text ----------------------------------------------------------------

  _fontParts() {
    const m = /(\d+(?:\.\d+)?)px\s+(.*)$/.exec(this.font);
    return m ? { size: parseFloat(m[1]), family: m[2] } : { size: 12, family: "sans-serif" };
  }

  measureText(text) {
    const { size } = this._fontParts();
    return { width: String(text).length * size * TEXT_WIDTH_EM };
  }

  fillText(text, x, y) {
    const { size, family } = this._fontParts();
    const anchor = ANCHOR[this.textAlign] ?? "start";
    const baseline = BASELINE[this.textBaseline] ?? "alphabetic";
    let attrs =
      `font-family="${esc(family)}" font-size="${num(size)}"` +
      ` fill="${esc(this.fillStyle)}" text-anchor="${anchor}"` +
      ` dominant-baseline="${baseline}"${this._alphaAttr("fill")}`;
    if (this._isAxisAligned()) {
      const [px, py] = this._pt(x, y);
      this._out.push(
        `<text x="${num(px)}" y="${num(py)}" ${attrs}${this._clipAttr()}>${esc(text)}</text>`
      );
    } else {
      // Rotated text keeps a transform, because baking a rotation into x/y
      // would lose the glyph orientation.
      const m = this._ctm;
      const t = `matrix(${[m[0], m[1], m[2], m[3], m[4], m[5]].map(num).join(" ")})`;
      this._out.push(
        `<g transform="${t}"${this._clipAttr()}>` +
          `<text x="${num(x)}" y="${num(y)}" ${attrs}>${esc(text)}</text></g>`
      );
    }
  }

  // -- output --------------------------------------------------------------

  /** The finished SVG document as a string. */
  toSVG() {
    const bg =
      this._bg === null || this._bg === "none"
        ? ""
        : `<rect width="${num(this.width)}" height="${num(this.height)}" fill="${esc(this._bg)}"/>`;
    const defs = this._defs.length ? `<defs>${this._defs.join("")}</defs>` : "";
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${num(this.width)}" ` +
      `height="${num(this.height)}" viewBox="0 0 ${num(this.width)} ${num(this.height)}">` +
      defs +
      bg +
      this._out.join("") +
      `</svg>`
    );
  }

  /** Number of emitted elements. Used by the smoke test. */
  get elementCount() {
    return this._out.length;
  }
}

/**
 * Methods of Canvas 2D that a view must NOT use, because this recorder cannot
 * represent them. Defined so that calling one fails loudly instead of silently
 * dropping the element from the SVG (A4).
 */
for (const name of [
  "bezierCurveTo",
  "quadraticCurveTo",
  "ellipse",
  "arcTo",
  "createLinearGradient",
  "createRadialGradient",
  "createPattern",
  "drawImage",
  "putImageData",
  "getImageData",
  "strokeText",
  "transform",
  "isPointInPath",
]) {
  if (!(name in SvgSurface.prototype)) {
    SvgSurface.prototype[name] = function unsupported() {
      throw new Error(
        `surface.SvgSurface: "${name}" is not supported by the SVG recorder. ` +
          `A view must only use the documented Canvas 2D subset, or the SVG ` +
          `export would silently differ from the canvas.`
      );
    };
  }
}
