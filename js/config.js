/**
 * config.js — every constant this application freezes, declared ONCE.
 *
 * Pitfall A4: a hard-coded value is named here with its value in the doc
 * comment, and it is ASSERTED at the point of use (see `format.js`,
 * `loader.js`). Selection among parameters and views goes through a frozen
 * registry that RAISES on an unregistered key — never a silent default.
 *
 * Pitfall A1 (conventions, stated once, repeated where a comparison happens):
 *   - `t_start` is in units of the remnant mass M_rem, origin at the IMR
 *     maximum-likelihood peak GPS time.
 *   - `f` is a frequency in Hz.
 *   - the sampled damping variable is the RATE `gamma = 1/tau` in 1/s. The
 *     prior box is on gamma, not on tau. Tier 2 stores `tau` in seconds and
 *     `gamma` is derived as 1/tau.
 *   - mode indices are sampler EM-classified indices. They are NOT QNM labels
 *     and they are NEVER ordered by amplitude (`A_true` is nan on real data).
 */

/** Base URL of the R2 bucket that serves all five data tiers.
 *  Value: "https://silencio-gw.fyi" (the apex; it already sends
 *  Access-Control-Allow-Origin: https://mhycheung.github.io, MEASURED 2026-09-16).
 *  The host `data.silencio-gw.fyi` does not exist and must never be used. */
export const DATA_BASE_URL = "https://silencio-gw.fyi";

/**
 * The events this build serves, ORDERED, the default first.
 *
 * Value: ["GW250114", "GW150914", "GW190521_030229", "GW190521_074359",
 *         "GW230814_230901", "GW231028_153006", "GW231123",
 *         "GW231226_101520"].
 *
 * These are SITE KEYS, the directory names of the payload on the data host.
 * They are the only event literals in `js/`: every other event-dependent
 * quantity — the IMR max-L sky point, the remnant mass and spin, the detector
 * list, the start times — is read from the `event` block of that event's
 * `summary.json` (see `loader.eventMeta`). A key written anywhere else in `js/`
 * is a bug.
 *
 * TRAP: there are TWO GW190521s, both from 2019-05-21. `GW190521_030229` is the
 * massive one; `GW190521_074359` is not. A bare `GW190521` is always a bug.
 *
 * `assertEvent` RAISES on an unregistered key (A4) — the selector and the URL
 * hash both go through it, so an unknown key can never reach the loader and
 * produce a page of 404s.
 */
export const EVENTS = Object.freeze([
  "GW250114",
  "GW150914",
  "GW190521_030229",
  "GW190521_074359",
  "GW230814_230901",
  "GW231028_153006",
  "GW231123",
  "GW231226_101520",
]);

/** The event a bare URL shows. Value: EVENTS[0], the first of the list. */
export const DEFAULT_EVENT = EVENTS[0];

/**
 * Registry check for an event key. RAISES on an unregistered key (A4).
 * @param {string} key site event key
 * @returns {string} the same key
 */
export function assertEvent(key) {
  if (!EVENTS.includes(key)) {
    throw new Error(
      `config.assertEvent: unregistered event "${key}". Registered: ${EVENTS.join(", ")}`
    );
  }
  return key;
}

/** Tier 1 histogram resolution, per axis. Value: 64. Asserted in format.js. */
export const GRID_BINS = 64;

/** Gaussian smoothing applied to a Tier 1 grid before contouring, in BINS.
 *  Value: 1.0.
 *
 *  Why it is not zero. A Tier 1 grid puts 2 000 samples into 64x64 = 4 096
 *  bins, so the mean occupancy is about 0.5 counts per bin and the level set
 *  at a credible threshold is shot-noise dominated: it breaks into hundreds
 *  of speckle islands. MEASURED on the synthetic payload, 2026-09-15: 212
 *  polylines per grid unsmoothed, and 1.10 ms per grid, which puts a
 *  108-grid frame at 119 ms and out of reach of gate G3 (< 33 ms).
 *  Smoothing by one bin is the same remedy `corner.py` applies by default.
 *  Set to 0 to contour the raw histogram.
 *
 *  Asserted at use in contour_core.contourGrid. */
export const CONTOUR_SMOOTH_SIGMA = 1.0;

/** The discrete smoothing stops the rail's slider offers, in BINS (request 3).
 *  Value: [0, 0.5, 1.0, 1.5, 2.0, 3.0].
 *
 *  Why discrete and not a continuum. Sigma is part of the contour worker's memo
 *  key (`contour_worker.js:75`), and that cache is what makes the start-time
 *  drag cheap (MEASURED 2026-09-15: a 6-overlay frame falls from 108 fresh
 *  grids to 18). A continuous slider would miss the cache on every pointer
 *  move. Six stops keep it effective.
 *
 *  Why these stops. `CONTOUR_SMOOTH_SIGMA = 1.0` is included and is the
 *  default, so the shipped appearance is unchanged until the user moves the
 *  slider. 0 contours the raw histogram. R1 MEASURED that sigma, not grid
 *  resolution, is the lever on the fragmentation the user reported (ruling 19),
 *  so the stops extend well above 1.0.
 *
 *  Asserted at use in state.js when parsing the `sig` hash key. */
export const SMOOTH_SIGMAS = Object.freeze([0, 0.5, 1.0, 1.5, 2.0, 3.0]);

/** Tier 2 sample count per run, cold block only. Value: 2000.
 *  TRAP: `samples.h5` reports n_chains = 4 while several arrays are 8 deep
 *  (4 cold + 4 hot). Tier 2 carries the COLD block only: 4 chains x 500. */
export const TIER2_N_SAMPLES = 2000;

/** Tier 2 float32 columns per mode, in file order. Value:
 *  ["f", "tau", "cR", "sR", "cL", "sL"]. Asserted in format.js. */
export const TIER2_COLUMNS = Object.freeze(["f", "tau", "cR", "sR", "cL", "sL"]);

/** Magic bytes identifying each binary tier. Asserted in format.js. */
export const MAGIC_TIER1 = "SGR1";
export const MAGIC_TIER2 = "SGS1";

/** Magic bytes of a Tier 6 EM-diagnostic file. Value: "SGE1".
 *  Mirrors `silencio.site.data.emdiag.MAGIC_TIER6`. Asserted in format.js. */
export const MAGIC_TIER6 = "SGE1";

/** Scatter points Tier 6 keeps PER COLD CHAIN, over the FULL sweep history
 *  including warmup. Value: 400. Mirrors `emdiag.TIER6_N_KEEP`.
 *
 *  Asserted in `format.parseTier6`, at use. A payload built with a different
 *  thinning must fail loudly rather than draw a cloud whose density the legend
 *  misdescribes: point `i` of a chain is sweep `i * scatter_stride`, and the
 *  stride is only meaningful against a known `n_keep`. */
export const TIER6_N_KEEP = 400;

/** Maximum Tier 6 EM-diagnostic blocks held in memory at once. Value: 8.
 *  One block is 12-38 kB on disk (MEASURED over the 48-run GW250114 payload,
 *  2026-09-16) and a few hundred kB once dequantised to Float64, so a small
 *  cache makes a slider step back free at negligible cost. */
export const TIER6_CACHE_MAX = 8;

/** Number of colour stops in the sweep-number colour map of the EM-cluster
 *  panel. Value: 256. Asserted in views/diagnostics.js at use. */
export const SWEEP_CMAP_STOPS = 256;

/** Credible levels offered in the control rail, in percent. Value: [50, 90, 99].
 *  Tier 4 (fit band) is limited to exactly these three; every other view could
 *  in principle take a continuous level, and takes these for consistency. */
export const CREDIBLE_LEVELS = Object.freeze([50, 90, 99]);

/** Line dash per credible level, so nested levels are told apart by style as
 *  well as by position (request 2, "distinct line styles").
 *  Value: 50 -> [2, 3], 90 -> [] (solid), 99 -> [7, 4].
 *
 *  90 is solid because it is the default and the most read. `levelDash` RAISES
 *  on an undeclared level (A4) rather than falling back to solid, which would
 *  silently draw two different levels in the same style. */
const LEVEL_DASH = Object.freeze({ 50: [2, 3], 90: [], 99: [7, 4] });

/**
 * The dash pattern of one credible level. RAISES on an undeclared level (A4).
 * @param {number} level in percent
 * @returns {number[]} a Canvas 2D line-dash array; `[]` means solid
 */
export function levelDash(level) {
  const d = LEVEL_DASH[level];
  if (d === undefined) {
    throw new Error(
      `config.levelDash: no dash is declared for level ${level}%. ` +
        `Declared: ${Object.keys(LEVEL_DASH).join(", ")}. This raises rather ` +
        `than defaulting to solid, because two levels drawn in one style are ` +
        `indistinguishable on the canvas.`
    );
  }
  return d;
}

/*
 * There is no mode-labelling toggle (removed 2026-09-18). The payload builder
 * relabels every sample by its EM classification before any tier is written, so
 * the mode index on every view IS the EM label. The raw sampler slot index is
 * not shown: it is ordered per chain, so pooled over chains it mixes modes.
 */

/**
 * Frozen parameter registry. `source`:
 *   "t2"      - a stored Tier 2 column
 *   "derived" - computed in the browser from [cR, sR, cL, sL] by physical.js
 *   "t2fn"    - a closed-form function of one stored column
 */
const PARAM_REGISTRY = Object.freeze({
  f: { key: "f", label: "f", unit: "Hz", source: "t2", column: "f" },
  gamma: { key: "gamma", label: "γ = 1/τ", unit: "1/s", source: "t2fn", column: "tau", fn: (x) => 1.0 / x },
  tau: { key: "tau", label: "τ", unit: "s", source: "t2", column: "tau" },
  A: { key: "A", label: "A", unit: "strain", source: "derived", field: "A" },
  epsilon: { key: "epsilon", label: "ε", unit: "", source: "derived", field: "epsilon" },
  phi: { key: "phi", label: "φ", unit: "rad", source: "derived", field: "phi" },
  theta: { key: "theta", label: "θ", unit: "rad", source: "derived", field: "theta" },
});

/** Default corner-panel parameter subset, in display order. */
export const DEFAULT_PARAMS = Object.freeze(["f", "gamma", "A", "epsilon"]);

/** All registered parameter keys, in canonical display order. */
export const PARAM_KEYS = Object.freeze(["f", "gamma", "tau", "A", "epsilon", "phi", "theta"]);

/**
 * Registry lookup. RAISES on an unregistered key (A4) — no nearest match,
 * no silent default.
 * @param {string} key
 */
export function getParam(key) {
  const p = PARAM_REGISTRY[key];
  if (p === undefined) {
    throw new Error(
      `config.getParam: unregistered parameter "${key}". Registered: ${PARAM_KEYS.join(", ")}`
    );
  }
  return p;
}

/** Frozen view registry. RAISES on an unregistered view. */
const VIEW_REGISTRY = Object.freeze({
  corner: { key: "corner", label: "Corner" },
  fgamma: { key: "fgamma", label: "f–γ plane" },
  crossrun: { key: "crossrun", label: "Cross-run" },
  diagnostics: { key: "diagnostics", label: "Diagnostics" },
  fitband: { key: "fitband", label: "Fit band" },
  sky: { key: "sky", label: "Sky" },
  modeassign: { key: "modeassign", label: "Mode assignment" },
  ampphase: { key: "ampphase", label: "Amplitude and phase" },
  consistency: { key: "consistency", label: "Consistency" },
});

export const VIEW_KEYS = Object.freeze(Object.keys(VIEW_REGISTRY));

export function getView(key) {
  const v = VIEW_REGISTRY[key];
  if (v === undefined) {
    throw new Error(
      `config.getView: unregistered view "${key}". Registered: ${VIEW_KEYS.join(", ")}`
    );
  }
  return v;
}

/** Number of neighbouring slider positions prefetched on each side. Value: 2. */
export const PREFETCH_RADIUS = 2;

/** Maximum Tier 2 run blocks held in memory at once. Value: 64 (~5.7 MB). */
export const TIER2_CACHE_MAX = 64;

/** Maximum Tier 4 fit-band blocks held in memory at once. Value: 6.
 *  One block is 8 arrays x 4915 samples x 2 detectors as Float64 = 0.63 MB
 *  after dequantisation, so 6 is about 3.8 MB. The fit band is one run at a
 *  time, so a small cache is enough to make a slider step back free. */
export const TIER4_CACHE_MAX = 6;

/** Maximum Tier 5 per-run visit-index blocks held in memory at once. Value: 32.
 *  One block is 8000 uint16 = 16 kB, so the whole 48-run campaign would fit;
 *  32 is ample. The Tier 5 GRID is event-level and cached forever, separately. */
export const TIER5_CACHE_MAX = 32;

/**
 * The sampler's prior box, per EVENT and per parameter, in the parameter's own unit.
 *
 * Value: `f` in [20, 1024] Hz and `gamma = 1/tau` in [1, 2500] 1/s for every event,
 * EXCEPT `f` in [24, 1024] Hz for GW230814_230901.
 *
 * PROVENANCE: MEASURED 2026-09-18 by reading `f_min`, `f_max`, `gamma_min`,
 * `gamma_max` from the resolved `config.toml` of EVERY published run; each event
 * had one value set. Before 2026-09-18 this was one box for all events, which
 * was wrong for GW230814_230901. The payload carries no prior fields, so the
 * values are declared here (A4) and `priorBox` RAISES on an undeclared event.
 *
 * Spec section 6 requires the prior box to be shown UNCROPPED, including any
 * posterior mass sitting at the edge. So this box is drawn, never used to clip.
 */
const BOX_STANDARD = Object.freeze({
  f: Object.freeze([20.0, 1024.0]),
  gamma: Object.freeze([1.0, 2500.0]),
});
const PRIOR_BOX_BY_EVENT = Object.freeze({
  "GW250114": BOX_STANDARD,
  "GW150914": BOX_STANDARD,
  "GW190521_030229": BOX_STANDARD,
  "GW190521_074359": BOX_STANDARD,
  "GW230814_230901": Object.freeze({ f: Object.freeze([24.0, 1024.0]), gamma: BOX_STANDARD.gamma }),
  "GW231028_153006": BOX_STANDARD,
  "GW231123": BOX_STANDARD,
  "GW231226_101520": BOX_STANDARD,
});
for (const ev of EVENTS) {
  if (PRIOR_BOX_BY_EVENT[ev] === undefined) {
    throw new Error(`config: no prior box declared for event "${ev}"`);
  }
}

/** Parameters that have a declared prior box. */
export const PRIOR_BOX_KEYS = Object.freeze(Object.keys(BOX_STANDARD));

/**
 * The prior box of one parameter for one event. RAISES when either is
 * undeclared (A4): a view that silently skipped the box would report no edge
 * occupancy and look clean.
 * @param {string} key
 * @param {string} ev site event key
 * @returns {number[]} [lo, hi]
 */
export function priorBox(key, ev) {
  getParam(key); // RAISES first on a parameter that is not registered at all
  const box = PRIOR_BOX_BY_EVENT[assertEvent(ev)];
  const b = box[key];
  if (b === undefined) {
    throw new Error(
      `config.priorBox: no prior box is declared for "${key}". ` +
        `Declared: ${PRIOR_BOX_KEYS.join(", ")}. This raises rather than ` +
        `returning an unbounded box, because prior-edge occupancy against a ` +
        `made-up bound is a false statement.`
    );
  }
  return b;
}

/**
 * Amplitude prior shape parameters and auxiliary floor, identical for every
 * published run (MEASURED 2026-09-18 from every run's `config.toml`: a = b = 1.5,
 * schwinger_t_min = 1e36). The per-mode prior density is
 * (1 - eps^2)^(-1/2) Q(a/2, t_min A_R^2) Q(b/2, t_min A_L^2) in (A, eps), flat in
 * the phases: flat in A up to a taper near 1/sqrt(t_min) = 1e-18. The tables in
 * prior.js were computed for exactly these values and assert them at use.
 */
export const AMP_PRIOR = Object.freeze({ a: 1.5, b: 1.5, t_min: 1e36 });

/**
 * The DEFAULT drawn range of a parameter axis (user request 2026-09-18: "show
 * the plots in prior range"), so the axes do not move with the data.
 *
 * Value: `f` and `gamma` take the event's prior box; `tau = 1/gamma` takes the
 * inverse of the gamma box; `epsilon` in [-1, 1], `phi` in [0, 2 pi] and
 * `theta` in [0, pi] are the ranges these derived quantities are DEFINED on
 * (physical.js). `A` has no upper prior bound, so it returns `null` and keeps
 * the payload's bulk window (request 7 of 2026-09-16).
 *
 * RAISES for an unregistered parameter or event (A4).
 * @param {string} key a registered parameter
 * @param {string} ev site event key
 * @returns {number[]|null} [lo, hi], or null when the default is data-dependent
 */
export function defaultAxisRange(key, ev) {
  getParam(key);
  assertEvent(ev);
  switch (key) {
    case "f":
    case "gamma":
      return priorBox(key, ev);
    case "tau": {
      const g = priorBox("gamma", ev);
      return [1.0 / g[1], 1.0 / g[0]];
    }
    case "epsilon":
      return [-1.0, 1.0];
    case "phi":
      return [0.0, 2.0 * Math.PI];
    case "theta":
      return [0.0, Math.PI];
    default:
      return null;
  }
}

/**
 * Fraction of the prior-box width counted as "at the edge" by the diagnostics
 * view. Value: 0.02 (2% of the box width at each end).
 * Asserted in views/diagnostics.js at use.
 */
export const PRIOR_EDGE_FRAC = 0.02;


/* ===========================================================================
 * The OPTIONAL prediction-side payload files (campaign of 2026-09-18, task T4).
 *
 * WHY THEY ARE OPTIONAL AND ADVERTISED. `kerr9/blobs.bin` and `modeassign.json`
 * are built from one plan's T1 and T3 products, and an event whose T1/T3 have
 * not run yet still has a complete payload without them. A 404 is not a network
 * failure, so it does not reach `requestfailed`; it reaches the CONSOLE, and
 * gate G-site's bar is zero console messages. So the payload ADVERTISES what it
 * carries, in the `extras` map of the `event` block of `summary.json`, and the
 * loader fetches a file only when the map names it. The advert and the files are
 * written by one call (`silencio.site.data.extras.add_prediction_extras`), so
 * they cannot disagree.
 * ======================================================================== */

/** Key of the advert map inside the `event` block. Value: "extras".
 *  Mirrors `silencio.site.data.extras.EXTRAS_KEY`. */
export const EXTRAS_KEY = "extras";

/** Advert name -> payload-relative path, for every optional file.
 *  Value: {kerr9: "kerr9/blobs.bin", mode_assign: "modeassign.json",
 *          amp_phase: "ampphase.json"}.
 *  Mirrors `extras.EXTRA_PATHS`; `loader` ASSERTS the advertised path against
 *  this table before fetching, so a payload cannot redirect the browser (A4). */
export const EXTRA_PATHS = Object.freeze({
  kerr9: "kerr9/blobs.bin",
  mode_assign: "modeassign.json",
  amp_phase: "ampphase.json",
});

/**
 * The nine Kerr QNM labels, in the order the blob file stores them.
 *
 * Value: ["2.2.0", "2.2.1", "2.1.0", "2.0.0", "3.3.0", "4.4.0", "3.2.0",
 *         "3.3.1", "4.4.1"].
 *
 * A4: the same tuple is declared in `silencio.prediction.kerr_blobs` as
 * `KERR_BLOB_MODE_LABELS` and is carried in the blob file's header;
 * `loader.kerr9()` asserts the header against this list, so a payload built
 * from a different label set fails loudly instead of drawing a blob under the
 * wrong name. The blob index `m<k>` of a Tier 1 key is the index INTO THIS
 * LIST; it is never a sampler EM mode index.
 */
export const KERR_BLOB_MODE_LABELS = Object.freeze([
  "2.2.0",
  "2.2.1",
  "2.1.0",
  "2.0.0",
  "3.3.0",
  "4.4.0",
  "3.2.0",
  "3.3.1",
  "4.4.1",
]);

/** Kerr blob labels drawn when the page opens. Value: ["2.2.0", "2.2.1"].
 *  The two the f–γ view drew as crosses before the blobs existed, so the
 *  default appearance of the view is unchanged apart from their width. */
export const KERR9_DEFAULT_LABELS = Object.freeze(["2.2.0", "2.2.1"]);

/** The `config` component of a Kerr blob Tier 1 key. Value: "kerr9".
 *  Mirrors `silencio.site.data.kerrblobs.KERR9_CONFIG`. No run is named
 *  `kerr9`, so a blob entry can never collide with a posterior entry. */
export const KERR9_CONFIG = "kerr9";

/** The `t_start` component of a Kerr blob Tier 1 key. Value: 0.
 *  A prediction blob has no start time; the key has a slot for one. */
export const KERR9_T_START = 0;

/** The parameter pair every Kerr blob is gridded on. Value: ["f", "gamma"]. */
export const KERR9_PAIR = Object.freeze(["f", "gamma"]);

/**
 * Registry check for a Kerr blob label. RAISES on an unregistered label (A4).
 * @param {string} label e.g. "3.3.0"
 * @returns {string} the same label
 */
export function assertKerrLabel(label) {
  if (!KERR_BLOB_MODE_LABELS.includes(label)) {
    throw new Error(
      `config.assertKerrLabel: unregistered Kerr label "${label}". ` +
        `Registered: ${KERR_BLOB_MODE_LABELS.join(", ")}`
    );
  }
  return label;
}

/**
 * The six configuration axes of a Stage-3 mode-assignment record, in the order
 * the control rail offers them.
 *
 * Value: ["n_modes", "delta_t", "blob_type", "posterior_type",
 *         "window_criteria", "mode_criteria"].
 *
 * Mirrors `silencio.site.data.modeassign.MODEASSIGN_AXES`. A record may carry
 * `null` on an axis it does not constrain, and `null` means "every value of
 * this axis" — a `not_computed` record has no blob type and no mode criterion,
 * because neither is defined when the posterior type has no implementation.
 */
export const MODEASSIGN_AXES = Object.freeze([
  "n_modes",
  "delta_t",
  "blob_type",
  "posterior_type",
  "window_criteria",
  "mode_criteria",
]);

/** Statuses a mode-assignment record may carry. Value: ["computed",
 *  "empty_intersection", "not_computed"]. The view draws each one differently,
 *  so an unregistered status RAISES rather than being shown as computed. */
export const MODEASSIGN_STATUSES = Object.freeze([
  "computed",
  "empty_intersection",
  "not_computed",
]);

/**
 * The two configuration axes the "Amplitude and phase" view and the
 * "Consistency" table select on. Value: ["n_modes", "delta_t"].
 *
 * Mirrors `silencio.site.data.ampphase.AMPPHASE_AXES`. They are a SUBSET of
 * `MODEASSIGN_AXES`: the other four axes of the Stage-3 grid are FIXED for
 * every number in `ampphase.json`, at the configuration the producer declares,
 * and the payload carries that configuration so the page PRINTS it instead of
 * offering a choice that does not exist.
 */
export const AMPPHASE_AXES = Object.freeze(["n_modes", "delta_t"]);

/** Quantile levels, in percent, of every log-amplitude quantity in
 *  `ampphase.json`. Value: [5, 16, 50, 84, 95]. Mirrors
 *  `ampphase.QUANTILE_LEVELS`; the JSON keys are q05 q16 q50 q84 q95. */
export const AMPPHASE_QUANTILES = Object.freeze([5, 16, 50, 84, 95]);

/** The four quantile-summarised quantities of `ampphase.json`, in the order the
 *  "Amplitude and phase" view lays out its columns. Mirrors
 *  `ampphase.LINEAR_QUANTITIES`. The first two are absolute, the last two are
 *  relative to the mode assigned 2.2.0 in the same run. */
export const AMPPHASE_LINEAR = Object.freeze([
  "log10A_R",
  "log10A_L",
  "log10_ratio_A_R_to_220",
  "log10_ratio_A_L_to_220",
]);

/** The four circular-summarised quantities of `ampphase.json`, same order.
 *  Mirrors `ampphase.PHASE_QUANTITIES`. */
export const AMPPHASE_PHASE = Object.freeze([
  "phi_R",
  "phi_L",
  "dphi_R_to_220",
  "dphi_L_to_220",
]);

/** The two `kind` values a consistency record may carry. Value:
 *  ["t_start", "window_pooled_at_T0"]. Mirrors
 *  `ampphase.CONSISTENCY_KINDS`. The table prints each kind differently, so an
 *  unregistered kind is reported as such and never shown as a per-start-time
 *  row. */
export const CONSISTENCY_KINDS = Object.freeze(["t_start", "window_pooled_at_T0"]);

/**
 * The quantity a column of the "Amplitude and phase" view draws, by index.
 *
 * Index 0..3 are the ABSOLUTE columns (A_R, A_L, phi_R, phi_L); the RELATIVE
 * selection draws the ratio and phase-difference columns instead. Each entry
 * names the payload key, whether it is circular, and the axis label WITH its
 * unit (A1: the unit is on the axis, never only in a caption).
 */
export const AMPPHASE_COLUMNS = Object.freeze({
  absolute: Object.freeze([
    Object.freeze({ key: "log10A_R", circular: false, label: "log10 A_R [strain]" }),
    Object.freeze({ key: "log10A_L", circular: false, label: "log10 A_L [strain]" }),
    Object.freeze({ key: "phi_R", circular: true, label: "phi_R: measured − predicted [rad]" }),
    Object.freeze({ key: "phi_L", circular: true, label: "phi_L: measured − predicted [rad]" }),
  ]),
  relative: Object.freeze([
    Object.freeze({
      key: "log10_ratio_A_R_to_220",
      circular: false,
      label: "log10 (A_R / A_R of 2.2.0)",
    }),
    Object.freeze({
      key: "log10_ratio_A_L_to_220",
      circular: false,
      label: "log10 (A_L / A_L of 2.2.0)",
    }),
    Object.freeze({
      key: "dphi_R_to_220",
      circular: true,
      label: "phi_R − phi_R(2.2.0): measured − predicted [rad]",
    }),
    Object.freeze({
      key: "dphi_L_to_220",
      circular: true,
      label: "phi_L − phi_L(2.2.0): measured − predicted [rad]",
    }),
  ]),
});

/**
 * The column set of one display mode. RAISES on an unregistered mode (A4): the
 * view must never fall through to the absolute columns while the rail says
 * "relative to 2.2.0".
 * @param {string} mode "absolute" or "relative"
 */
export function ampPhaseColumns(mode) {
  const cols = AMPPHASE_COLUMNS[mode];
  if (cols === undefined) {
    throw new Error(
      `config.ampPhaseColumns: unregistered display mode "${mode}". ` +
        `Registered: ${Object.keys(AMPPHASE_COLUMNS).join(", ")}`
    );
  }
  return cols;
}
