/**
 * views/axis.js — an INVERTIBLE linear axis, carrying its own domain.
 *
 * Part of the silencio interactive results application. Added by task R4
 * (requests 6 and 7: cursor zoom on every panel, and a default zoom for the
 * amplitude panels).
 *
 * WHY THIS EXISTS
 * ---------------
 * `plotutil.scale(d0, d1, p0, p1, flip)` returns a bare closure: data -> pixel,
 * with **no inverse, no stored domain and no identity**. That is enough to draw
 * and nothing more. Every interaction needs the other direction — a wheel event
 * arrives as a pixel and has to become the data value under the cursor — and a
 * zoom needs to know the domain it is zooming. So this module returns an OBJECT
 * that keeps `domain` and `range` and can map both ways.
 *
 * `scale()` is NOT removed: it is re-expressed as `makeAxis(...).toPixel`, so
 * the five views that destructure `{sx, sy}` from `drawFrame` keep working with
 * no change. `corner.js`, which does its axis arithmetic inline and does not
 * import `plotutil`, is converted separately.
 *
 * CONVENTIONS (pitfall A1)
 * ------------------------
 * Nothing here knows any physics. A caller passes a domain already in physical
 * units. `flip` is for the y axis, where pixels grow downward while data grows
 * upward — the same meaning `plotutil.scale` gives it.
 *
 * DEGENERATE CASES, both declared rather than discovered at run time (A4):
 *   * a zero-width DOMAIN (`d1 === d0`) uses a span of 1, exactly as
 *     `plotutil.scale` does, so `toPixel` stays a drop-in replacement;
 *   * a zero-width PIXEL range (`p1 === p0`) makes the inverse undefined —
 *     every pixel maps to the same datum. `toData` then returns the domain low
 *     rather than dividing by zero and returning NaN or Infinity, which would
 *     propagate silently into a zoom domain. This case cannot arise from
 *     `plotBox`, which floors a box at 10 px, but a caller may build a box by
 *     hand.
 */

/**
 * Build an invertible linear axis.
 *
 * @param {number} d0 data value at pixel `p0`
 * @param {number} d1 data value at pixel `p1`
 * @param {number} p0 pixel at `d0`
 * @param {number} p1 pixel at `d1`
 * @param {boolean} [flip] y-axis orientation: data up, pixels down
 * @returns {{domain: number[], range: number[], flip: boolean,
 *            toPixel: function(number): number,
 *            toData: function(number): number}}
 */
export function makeAxis(d0, d1, p0, p1, flip = false) {
  const span = d1 - d0;
  // Matches plotutil.scale exactly, so toPixel is a drop-in replacement.
  const safe = span === 0 ? 1 : span;
  const pspan = p1 - p0;

  const toPixel = flip
    ? (v) => p1 - ((v - d0) / safe) * pspan
    : (v) => p0 + ((v - d0) / safe) * pspan;

  const toData =
    pspan === 0
      ? () => d0 // the inverse is undefined; see the header note.
      : flip
        ? (px) => d0 + ((p1 - px) / pspan) * safe
        : (px) => d0 + ((px - p0) / pspan) * safe;

  return { domain: [d0, d1], range: [p0, p1], flip, toPixel, toData };
}

/**
 * Zoom a domain about a fixed data value.
 *
 * `pivot` stays at the same PIXEL, which is what makes wheel-zoom feel
 * anchored to the cursor: the caller passes `axis.toData(eventPixel)`.
 *
 * `factor < 1` zooms in (a narrower domain), `factor > 1` zooms out. A
 * non-finite or non-positive factor is refused rather than silently ignored
 * (A4): it would otherwise collapse the domain to a point or invert it, and a
 * view drawn on an inverted domain looks like a rendering bug rather than a
 * bad argument.
 *
 * @param {number[]} domain [lo, hi]
 * @param {number} pivot data value held fixed
 * @param {number} factor
 * @returns {number[]} the new [lo, hi]
 */
export function zoomDomain(domain, pivot, factor) {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(
      `axis.zoomDomain: factor must be finite and positive, got ${factor}. ` +
        "A non-positive factor would collapse or invert the domain."
    );
  }
  const [lo, hi] = domain;
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !Number.isFinite(pivot)) {
    return domain;
  }
  return [pivot - (pivot - lo) * factor, pivot + (hi - pivot) * factor];
}

/**
 * Shift a domain by a distance expressed in DATA units.
 *
 * Drag-to-pan computes that distance as the difference of two `toData` calls,
 * so the point under the cursor stays under the cursor.
 *
 * @param {number[]} domain [lo, hi]
 * @param {number} delta data-unit shift
 * @returns {number[]}
 */
export function panDomain(domain, delta) {
  const [lo, hi] = domain;
  if (!Number.isFinite(delta) || !Number.isFinite(lo) || !Number.isFinite(hi)) {
    return domain;
  }
  return [lo + delta, hi + delta];
}

/**
 * True when a domain is usable for drawing: finite, ordered, non-degenerate.
 *
 * Used to reject a stored window that arrived from a hand-edited URL before it
 * reaches a view, so a bad link falls back to the computed range instead of
 * drawing an empty panel.
 *
 * @param {*} d
 * @returns {boolean}
 */
export function isDrawableDomain(d) {
  return (
    Array.isArray(d) &&
    d.length === 2 &&
    Number.isFinite(d[0]) &&
    Number.isFinite(d[1]) &&
    d[1] > d[0]
  );
}
