/**
 * colors.js — the one colour scheme, shared by every view.
 *
 * The live selection is always drawn in LIVE_COLOR. Each pinned run takes the
 * next colour from PIN_PALETTE, assigned in pin order and kept stable while the
 * pin exists, so a colour means one run across every view (spec section 6).
 *
 * The palette is the Okabe-Ito colour-blind-safe set (8 hues), which keeps the
 * overlays distinguishable for the common colour-vision deficiencies.
 */

/** Colour of the live (slider-driven) selection. Value: "#111111". */
export const LIVE_COLOR = "#111111";

/**
 * Live palette — one colour per LIVE run, assigned in `liveRuns` order.
 *
 * THE DEFECT THIS FIXES (2026-09-16). `liveRuns` is the cross product of the
 * selected mode counts and start times, so "the live selection" is often
 * SEVERAL runs, not one. Giving every one of them LIVE_COLOR made them
 * indistinguishable in the two views where colour means run (sky and fit band),
 * where the dash channel is already spent on the credible level. With
 * n_modes = [1, 2, 3] three sky contours drew in one colour AND one dash.
 *
 * `LIVE_PALETTE[0] === LIVE_COLOR`, so the common case of ONE live run is
 * byte-identical to before this change — the same identity property that
 * ruling 22 chose dash concatenation for.
 *
 * WHY A LIGHTNESS RAMP AND NOT MORE HUES. PIN_PALETTE already holds all eight
 * Okabe-Ito hues, so a hue here would read as a pinned run. The live runs are
 * one ordered family, and a dark-to-mid ramp says that. KNOWN LIMITATION:
 * `#8c8c8c` sits near PIN_PALETTE's grey `#999999`, which can only collide with
 * 8 pins AND 3 live runs at once.
 */
export const LIVE_PALETTE = Object.freeze(["#111111", "#5a5a5a", "#8c8c8c"]);

/**
 * Stable colour for the i-th LIVE run, in `liveRuns` order.
 * @param {number} index 0-based index into the live-run list
 */
export function liveColor(index) {
  return LIVE_PALETTE[index % LIVE_PALETTE.length];
}

/** Pin palette, assigned round-robin in pin order. */
export const PIN_PALETTE = Object.freeze([
  "#e69f00", // orange
  "#56b4e9", // sky blue
  "#009e73", // bluish green
  "#cc79a7", // reddish purple
  "#0072b2", // blue
  "#d55e00", // vermillion
  "#f0e442", // yellow
  "#999999", // grey
]);

/** Colour for scatter points, derived from the run colour at lower alpha. */
export function withAlpha(hex, alpha) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Stable colour for the i-th pinned run.
 * @param {number} index 0-based pin index
 */
export function pinColor(index) {
  return PIN_PALETTE[index % PIN_PALETTE.length];
}

/**
 * Mode palette — ruling 18, "colour means MODE".
 *
 * A mode index gets the SAME colour in every view and for every run, which is
 * request 1 verbatim: "For each mode, I want it to always be plot in a
 * different color (both contour and the scatter point), which should be
 * consistent across plots and runs etc."
 *
 * Okabe-Ito again, so the modes stay separable under the common colour-vision
 * deficiencies. Yellow "#f0e442" is deliberately LEFT OUT: it is the one hue of
 * the set with too little contrast against the white canvas to read as a thin
 * contour line.
 *
 * TRAP (config.js, stated again here at the point of use): a mode index is a
 * sampler EM-classified index. It is NOT a QNM label and modes are NEVER
 * ordered by amplitude, so a colour here identifies a mode WITHIN one fit and
 * carries no physical identification across fits.
 */
export const MODE_PALETTE = Object.freeze([
  "#0072b2", // blue
  "#d55e00", // vermillion
  "#009e73", // bluish green
  "#cc79a7", // reddish purple
  "#e69f00", // orange
  "#56b4e9", // sky blue
]);

/**
 * Stable colour for mode index `m`, in every view and for every run (ruling 18).
 * @param {number} m 0-based sampler EM mode index
 */
export function modeColor(m) {
  return MODE_PALETTE[m % MODE_PALETTE.length];
}

/**
 * Run dash patterns — ruling 18, "dash means RUN".
 *
 * Colour can carry one variable. Request 1 gives it to the mode, so the run
 * moves to the dash channel. The first four entries are byte-identical to the
 * `MODE_DASH` they replace (`corner.js:31`, `fgamma.js:72` before this change),
 * so a single-run plot looks exactly as it did.
 */
export const RUN_DASH = Object.freeze([[], [6, 4], [2, 3], [10, 3, 2, 3], [1, 3], [12, 4]]);

/**
 * Stable dash for the i-th run of the compare set (ruling 18).
 * @param {number} index 0-based index into the series array
 * @returns {number[]} a Canvas 2D line-dash array; `[]` means solid
 */
export function runDash(index) {
  return RUN_DASH[index % RUN_DASH.length];
}
