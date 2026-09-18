/**
 * interact.js — cursor zoom, drag pan and double-click reset, for every panel.
 *
 * Part of the silencio interactive results application. Added by task R4
 * (request 6: "every panel: zoom in and out with the cursor").
 *
 * HOW A PANEL BECOMES INTERACTIVE
 * -------------------------------
 * A view publishes, at the end of its `render`, a flat list of HIT AREAS:
 *
 *   this.hitAreas = [{box, ax, ay, xKey, yKey}]
 *
 * `box` is `{x, y, w, h}` in CSS pixels, `ax`/`ay` are the `axis.makeAxis`
 * objects that drew it, and `xKey`/`yKey` are the state window keys from
 * `state.zoomKey`. Either key may be null for an axis that must not move — the
 * density axis of a corner diagonal, for instance, which is normalised to the
 * panel height and means nothing as a data range.
 *
 * Nothing here knows any view. That is deliberate: a new view becomes zoomable
 * by publishing hit areas, with no change to this module.
 *
 * WHY A DRAG USES THE DOMAIN CAPTURED AT POINTERDOWN
 * -------------------------------------------------
 * Rendering is coalesced (`main.js` drops intermediate frames), so during a
 * fast drag the published axes lag the state by one or more frames. Panning
 * against the LIVE axis would therefore compound a stale scale and the content
 * would slip away from the cursor. The drag instead stores the domain and the
 * pixel-to-data ratio at pointerdown and maps the total pixel displacement
 * through those, so the point grabbed stays under the cursor whatever the
 * renderer is doing.
 *
 * TOUCH (mobile support, 2026-09-16)
 * -----------------------------------
 * One finger belongs to the PAGE: a swipe scrolls, so a phone user can always
 * scroll past a plot. Touch pointers therefore never start a drag. Two fingers
 * belong to the panel under their midpoint: pinch zooms and moving the midpoint
 * pans, both from the domain captured when the second finger landed, for the
 * same reason a drag does (see above). A double tap resets that panel, like a
 * double click. The canvas CSS sets `touch-action: pan-x pan-y`, so the browser
 * keeps one-finger scrolling but leaves the pinch to this module.
 *
 * CONVENTIONS (pitfall A1): everything here is in CSS pixels and in whatever
 * physical unit the axis was built with. This module converts between the two
 * and knows neither.
 */

import { isDrawableDomain, panDomain, zoomDomain } from "./views/axis.js";

/**
 * Zoom factor applied per unit of `WheelEvent.deltaY`, in the browser's
 * `deltaMode` 0 (pixels). Value: 0.0015 per pixel, so one ordinary notch of
 * about 100 px is a factor of e^0.15 = 1.16, and a flick is smooth rather than
 * a jump. Declared here and asserted in `wheelFactor` (A4).
 */
export const WHEEL_ZOOM_RATE = 0.0015;

/**
 * Largest factor a single wheel event may apply. Value: 4.
 *
 * Trackpads and free-spinning wheels deliver very large `deltaY` values, and an
 * unclamped exponential turns one flick into a factor of thousands — from which
 * the user cannot get back except by double-clicking. Declared here and
 * asserted in `wheelFactor` (A4).
 */
export const WHEEL_MAX_FACTOR = 4.0;

/** Longest gap between the two taps of a double tap. Value: 300 ms. */
export const DOUBLE_TAP_MS = 300;

/** Largest distance between the two taps of a double tap, and the largest
 *  movement a tap may have. Value: 24 CSS px. */
export const DOUBLE_TAP_PX = 24;

/**
 * The window patch of a two-finger gesture, from the state at its start.
 *
 * The data point under the starting midpoint is scaled about by
 * `factor = startDistance / distance` (fingers apart = zoom in, as on every
 * phone map), and then follows the midpoint as it moves.
 *
 * @param {Object} g {hit, xDomain, yDomain, xPerPx, yPerPx, mx0, my0, d0}
 * @param {number} mx current midpoint CSS pixel x
 * @param {number} my current midpoint CSS pixel y
 * @param {number} d current finger distance in CSS pixels
 * @returns {Object} zero, one or two window entries, keyed by window key
 */
export function pinchPatch(g, mx, my, d) {
  const out = {};
  if (!(d > 0) || !(g.d0 > 0)) return out;
  const factor = g.d0 / d;
  if (g.hit.xKey && g.xDomain) {
    const anchor = g.hit.ax.toData(g.mx0);
    const z = zoomDomain(g.xDomain, anchor, factor);
    const dd = panDomain(z, -(mx - g.mx0) * g.xPerPx * factor);
    if (isDrawableDomain(dd)) out[g.hit.xKey] = dd;
  }
  if (g.hit.yKey && g.yDomain) {
    const anchor = g.hit.ay.toData(g.my0);
    const z = zoomDomain(g.yDomain, anchor, factor);
    const dd = panDomain(z, -(my - g.my0) * g.yPerPx * factor);
    if (isDrawableDomain(dd)) out[g.hit.yKey] = dd;
  }
  return out;
}

/** Lines-to-pixels and pages-to-pixels, for the two non-pixel wheel modes. */
const DELTA_MODE_PX = Object.freeze([1, 16, 400]);

/**
 * The zoom factor one wheel event asks for.
 *
 * Scrolling DOWN (`deltaY > 0`) zooms OUT, which is the convention of every
 * map and plot the user already has open.
 *
 * @param {number} deltaY
 * @param {number} [deltaMode] WheelEvent.deltaMode: 0 px, 1 line, 2 page
 * @returns {number} a finite, positive factor
 */
export function wheelFactor(deltaY, deltaMode = 0) {
  if (!(WHEEL_ZOOM_RATE > 0) || !(WHEEL_MAX_FACTOR > 1)) {
    throw new Error(
      `interact: WHEEL_ZOOM_RATE must be positive and WHEEL_MAX_FACTOR > 1, ` +
        `got ${WHEEL_ZOOM_RATE} and ${WHEEL_MAX_FACTOR}.`
    );
  }
  if (!Number.isFinite(deltaY)) return 1;
  const px = deltaY * (DELTA_MODE_PX[deltaMode] ?? 1);
  const f = Math.exp(px * WHEEL_ZOOM_RATE);
  return Math.min(WHEEL_MAX_FACTOR, Math.max(1 / WHEEL_MAX_FACTOR, f));
}

/**
 * The hit area under a point, or null. Later areas win, so a view may publish a
 * small panel over a large one.
 *
 * @param {Object[]} areas
 * @param {number} px CSS pixel x
 * @param {number} py CSS pixel y
 */
export function hitTest(areas, px, py) {
  let found = null;
  for (const a of areas) {
    const b = a.box;
    if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) found = a;
  }
  return found;
}

/**
 * The window patch one wheel event produces for one hit area.
 *
 * A window that comes out non-drawable is DROPPED rather than stored, so the
 * axis keeps whatever it had: zooming can never leave a panel unable to draw.
 *
 * @param {Object} hit a hit area
 * @param {number} px cursor CSS pixel x
 * @param {number} py cursor CSS pixel y
 * @param {number} factor from `wheelFactor`
 * @returns {Object} zero, one or two window entries, keyed by window key
 */
export function zoomPatch(hit, px, py, factor) {
  const out = {};
  if (hit.xKey && hit.ax) {
    const d = zoomDomain(hit.ax.domain, hit.ax.toData(px), factor);
    if (isDrawableDomain(d)) out[hit.xKey] = d;
  }
  if (hit.yKey && hit.ay) {
    const d = zoomDomain(hit.ay.domain, hit.ay.toData(py), factor);
    if (isDrawableDomain(d)) out[hit.yKey] = d;
  }
  return out;
}

/**
 * Attach the wheel, drag and double-click handlers to the canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {Object} store the `state.Store`
 * @param {Function} getHitAreas () -> the ACTIVE view's hit areas
 * @returns {Function} a teardown function, for tests
 */
export function attachInteractions(canvas, store, getHitAreas) {
  /**
   * Event coordinates in the CSS pixel frame the views draw in. The canvas is
   * laid out at its CSS size and the 2D context carries the device-pixel-ratio
   * transform, so a hit area is in CSS pixels; `rect` is scaled by any further
   * CSS transform on the element, hence the ratio.
   */
  const at = (e) => {
    const rect = canvas.getBoundingClientRect();
    const kx = rect.width > 0 ? (canvas.clientWidth || rect.width) / rect.width : 1;
    const ky = rect.height > 0 ? (canvas.clientHeight || rect.height) / rect.height : 1;
    return { x: (e.clientX - rect.left) * kx, y: (e.clientY - rect.top) * ky };
  };

  const apply = (patch) => {
    if (Object.keys(patch).length === 0) return;
    store.set({ z: { ...store.state.z, ...patch } });
  };

  const onWheel = (e) => {
    const { x, y } = at(e);
    const hit = hitTest(getHitAreas(), x, y);
    if (!hit) return;
    // Only once a panel is actually under the cursor: elsewhere the page must
    // keep scrolling normally.
    e.preventDefault();
    apply(zoomPatch(hit, x, y, wheelFactor(e.deltaY, e.deltaMode)));
  };

  /** The live drag: the state captured at pointerdown, never re-read after. */
  let drag = null;

  const onDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    // A finger never drags: one finger scrolls the page (see TOUCH above).
    if (e.pointerType === "touch") return;
    const { x, y } = at(e);
    const hit = hitTest(getHitAreas(), x, y);
    if (!hit) return;
    drag = {
      x0: x,
      y0: y,
      hit,
      xDomain: hit.ax ? [...hit.ax.domain] : null,
      yDomain: hit.ay ? [...hit.ay.domain] : null,
      // Data units per CSS pixel, at the moment of the grab.
      xPerPx: hit.ax ? hit.ax.toData(x + 1) - hit.ax.toData(x) : 0,
      yPerPx: hit.ay ? hit.ay.toData(y + 1) - hit.ay.toData(y) : 0,
      moved: false,
    };
    if (canvas.setPointerCapture && e.pointerId !== undefined) {
      canvas.setPointerCapture(e.pointerId);
    }
  };

  const onMove = (e) => {
    if (!drag) return;
    const { x, y } = at(e);
    const dx = x - drag.x0;
    const dy = y - drag.y0;
    if (!drag.moved && Math.abs(dx) < 2 && Math.abs(dy) < 2) return;
    drag.moved = true;
    e.preventDefault();
    const patch = {};
    // The content follows the cursor, so the domain moves the OTHER way.
    if (drag.hit.xKey && drag.xDomain) {
      const d = panDomain(drag.xDomain, -dx * drag.xPerPx);
      if (isDrawableDomain(d)) patch[drag.hit.xKey] = d;
    }
    if (drag.hit.yKey && drag.yDomain) {
      const d = panDomain(drag.yDomain, -dy * drag.yPerPx);
      if (isDrawableDomain(d)) patch[drag.hit.yKey] = d;
    }
    apply(patch);
  };

  const onUp = (e) => {
    if (!drag) return;
    if (canvas.releasePointerCapture && e.pointerId !== undefined) {
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        // The capture was already lost; nothing to release.
      }
    }
    drag = null;
  };

  /** Reset the windows of the panel under (x, y); true when there was one. */
  const resetAt = (x, y) => {
    const hit = hitTest(getHitAreas(), x, y);
    if (!hit) return false;
    const z = { ...store.state.z };
    let changed = false;
    for (const k of [hit.xKey, hit.yKey]) {
      if (k && k in z) {
        delete z[k];
        changed = true;
      }
    }
    if (changed) store.set({ z });
    return true;
  };

  const onDblClick = (e) => {
    const { x, y } = at(e);
    if (resetAt(x, y)) e.preventDefault();
  };

  /** The live two-finger gesture, captured when the second finger landed. */
  let pinch = null;
  /** The last completed tap, for double-tap detection: {x, y, t}. */
  let lastTap = null;
  /** The single-finger touch in progress, if it may still be a tap. */
  let tap = null;

  const twoFinger = (e) => {
    const a = at(e.touches[0]);
    const b = at(e.touches[1]);
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  const onTouchStart = (e) => {
    if (e.touches.length === 1) {
      const p = at(e.touches[0]);
      tap = { x: p.x, y: p.y, t: e.timeStamp };
      return;
    }
    tap = null;
    if (e.touches.length !== 2) return;
    const { mx, my, d } = twoFinger(e);
    const hit = hitTest(getHitAreas(), mx, my);
    if (!hit) return;
    e.preventDefault();
    pinch = {
      hit,
      mx0: mx,
      my0: my,
      d0: d,
      xDomain: hit.ax ? [...hit.ax.domain] : null,
      yDomain: hit.ay ? [...hit.ay.domain] : null,
      xPerPx: hit.ax ? hit.ax.toData(mx + 1) - hit.ax.toData(mx) : 0,
      yPerPx: hit.ay ? hit.ay.toData(my + 1) - hit.ay.toData(my) : 0,
    };
  };

  const onTouchMove = (e) => {
    if (tap && e.touches.length === 1) {
      const p = at(e.touches[0]);
      if (Math.hypot(p.x - tap.x, p.y - tap.y) > DOUBLE_TAP_PX) tap = null;
    }
    if (!pinch || e.touches.length !== 2) return;
    if (e.cancelable) e.preventDefault();
    const { mx, my, d } = twoFinger(e);
    apply(pinchPatch(pinch, mx, my, d));
  };

  const onTouchEnd = (e) => {
    if (e.touches.length < 2) pinch = null;
    if (!tap || e.touches.length !== 0) return;
    const cur = tap;
    tap = null;
    if (
      lastTap &&
      cur.t - lastTap.t <= DOUBLE_TAP_MS &&
      Math.hypot(cur.x - lastTap.x, cur.y - lastTap.y) <= DOUBLE_TAP_PX
    ) {
      lastTap = null;
      // Some mobile browsers also fire dblclick; a second reset is a no-op.
      if (resetAt(cur.x, cur.y) && e.cancelable) e.preventDefault();
      return;
    }
    lastTap = cur;
  };

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);
  canvas.addEventListener("dblclick", onDblClick);
  canvas.addEventListener("touchstart", onTouchStart, { passive: false });
  canvas.addEventListener("touchmove", onTouchMove, { passive: false });
  canvas.addEventListener("touchend", onTouchEnd);
  canvas.addEventListener("touchcancel", onTouchEnd);

  return () => {
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("pointerdown", onDown);
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerup", onUp);
    canvas.removeEventListener("pointercancel", onUp);
    canvas.removeEventListener("dblclick", onDblClick);
    canvas.removeEventListener("touchstart", onTouchStart);
    canvas.removeEventListener("touchmove", onTouchMove);
    canvas.removeEventListener("touchend", onTouchEnd);
    canvas.removeEventListener("touchcancel", onTouchEnd);
  };
}
