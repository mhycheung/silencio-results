/**
 * state.js — the whole application state, and its round trip through the URL
 * hash (ruling 5: URL state must round-trip).
 *
 * Hash grammar, `key=value` joined by `&`, as in spec section 5:
 *   ev    one registered event key          e.g. GW250114
 *   cfg   one configuration name            e.g. prod_0p3s
 *   n     comma list of mode counts shown   e.g. 2,3
 *   t     comma list of start times shown   e.g. 5,9      (units: M_rem)
 *   view  one registered view key           e.g. corner
 *   p     comma list of parameter keys      e.g. f,gamma
 *   lev   credible levels in percent, a COMMA LIST, and the EMPTY value is
 *         legal and means "draw no contour lines" (request 2)
 *                                           e.g. 50,90   or   90   or
 *   sig   contour smoothing sigma in BINS, one of config.SMOOTH_SIGMAS  e.g. 1.5
 *   pin   comma list of pinned runs, each "<cfg>:<n>:<t>"
 *   sc    "1" to draw Tier 2 scatter, "0" not to
 *   pr    "1" to overlay the prior in the corner view (grey dotted), "0" not to
 *   z     view windows, comma list of "<view>/<axisId>:<lo>:<hi>"
 *   km    Kerr blob labels drawn on the f-gamma view, a COMMA LIST, and the
 *         EMPTY value is legal and means "draw no prediction blob"
 *                                           e.g. 2.2.0,2.2.1  or  3.3.0  or
 *   ma    mode-assignment configuration, a comma list of "<axis>:<value>" over
 *         config.MODEASSIGN_AXES. An axis that is absent takes the payload's
 *         own `default_config`, which is why the default is the EMPTY map and
 *         not a hard-coded configuration: the grid that was computed is a
 *         property of the payload, not of the application
 *                                           e.g. n_modes:2,delta_t:10
 *   ap    amplitude/phase configuration, a comma list of "<axis>:<value>" over
 *         config.AMPPHASE_AXES. Same rule as `ma`: an axis that is absent takes
 *         the payload's own default, because the (n_modes, delta_t) grid that
 *         was computed is a property of the payload
 *                                           e.g. n_modes:3,delta_t:10
 *   apm   amplitude/phase display mode, one key of config.AMPPHASE_COLUMNS:
 *         "absolute" (A_R, A_L, phi_R, phi_L) or "relative" (the same four
 *         relative to the mode assigned 2.2.0). Omitted means "absolute"
 *                                           e.g. relative
 *
 * UNKNOWN KEYS ARE IGNORED, so an old link degrades rather than breaks
 * (spec section 5). An unparseable value for a known key falls back to the
 * default for that key, and the fallback is reported through `parseHash`'s
 * `warnings` array — it is never silent.
 */

import {
  AMPPHASE_AXES,
  AMPPHASE_COLUMNS,
  CONTOUR_SMOOTH_SIGMA,
  CREDIBLE_LEVELS,
  DEFAULT_EVENT,
  DEFAULT_PARAMS,
  EVENTS,
  KERR9_DEFAULT_LABELS,
  KERR_BLOB_MODE_LABELS,
  MODEASSIGN_AXES,
  PARAM_KEYS,
  SMOOTH_SIGMAS,
  VIEW_KEYS,
} from "./config.js";
import { isDrawableDomain } from "./views/axis.js";

/**
 * The default state, used for a bare URL and for any key that fails to parse.
 * @param {string} [cfg] configuration name
 * @param {string} [ev] site event key; defaults to `config.DEFAULT_EVENT`
 */
/** The amplitude/phase display mode a bare URL shows. Value: "absolute".
 *  Declared here because it is a property of the APPLICATION's default state,
 *  not of the payload; the payload owns the (n_modes, delta_t) default. */
export const AMPPHASE_DEFAULT_MODE = "absolute";

export function defaultState(cfg = "prod_0p3s", ev = DEFAULT_EVENT) {
  return {
    ev,
    cfg,
    n: [2],
    t: [5],
    view: "corner",
    p: [...DEFAULT_PARAMS],
    levs: [90],
    pins: [],
    scatter: false,
    prior: false,
    sig: CONTOUR_SMOOTH_SIGMA,
    z: {},
    km: [...KERR9_DEFAULT_LABELS],
    ma: {},
    ap: {},
    apm: AMPPHASE_DEFAULT_MODE,
  };
}

/**
 * The credible levels to draw: sorted ascending, a subset of CREDIBLE_LEVELS.
 *
 * THE EMPTY ARRAY IS LEGAL and means "draw no contour lines" (request 2, which
 * asked for the levels to be individually toggleable "including none showing").
 * A view must therefore handle an empty set by drawing no lines, NOT by falling
 * back to a default level.
 *
 * @param {Object} st store state
 * @returns {number[]}
 */
export function levelsOf(st) {
  return Array.isArray(st.levs) ? st.levs : [];
}

/**
 * The single highest selected level, or `null` when none is selected.
 *
 * For the two consumers that genuinely cannot take a set: a Tier 3 band exists
 * only at 90% (`crossrun.js`), and a caption naming one level.
 *
 * @param {Object} st store state
 * @returns {number|null}
 */
export function primaryLevel(st) {
  const L = levelsOf(st);
  return L.length ? L[L.length - 1] : null;
}

/**
 * The hash key of one zoom window (task R4).
 *
 * WHY THE VIEW IS PART OF THE KEY, AND WHY THE PANEL IS NOT. In a corner
 * matrix, column j shares an x parameter and row i shares a y parameter. A
 * per-PANEL window would let the same parameter show a different range in two
 * panels, which stops the figure being a corner plot. So corner keys its
 * windows on the PARAMETER. The view is in the key as well, so that zooming
 * `f` in the corner view does not silently move the f-gamma view.
 *
 * @param {string} view registered view key
 * @param {string} axisId parameter name, or a view-private axis id
 */
export function zoomKey(view, axisId) {
  return `${view}/${axisId}`;
}

/**
 * The data range one axis must draw: the stored zoom window if there is a
 * drawable one, else the caller's own computed range.
 *
 * Absent a stored window the behaviour is exactly what it was before task R4,
 * which is what makes every existing link keep working.
 *
 * @param {Object} st store state
 * @param {string} view registered view key
 * @param {string} axisId parameter name, or a view-private axis id
 * @param {number[]} fallback the range the view computed for itself
 * @returns {number[]} [lo, hi]
 */
export function windowOf(st, view, axisId, fallback) {
  const w = st.z?.[zoomKey(view, axisId)];
  return isDrawableDomain(w) ? w : fallback;
}

/**
 * The data-dependent windows the views last DREW, keyed by `zoomKey`. A view
 * records an axis here only when its default range comes from the data (today
 * the corner view's `A`), because only those move when the run changes.
 * Not part of the store and not in the hash.
 */
const drawnWindows = new Map();

/** Record the window a view drew for a data-dependent axis. */
export function noteDrawnWindow(view, axisId, range) {
  drawnWindows.set(zoomKey(view, axisId), [range[0], range[1]]);
}

/**
 * The zoom map with every recorded data-dependent window frozen in, so a
 * change of run (the t_start slider) keeps the axes where they are. An entry
 * the user already set wins. Double-click reset still clears the entry.
 * @param {Object} st store state
 * @returns {Object} a new `z` map
 */
export function freezeDrawnWindows(st) {
  const z = { ...(st.z ?? {}) };
  for (const [k, w] of drawnWindows) if (!isDrawableDomain(z[k]) && isDrawableDomain(w)) z[k] = w;
  return z;
}

function parseIntList(s, warnings, key) {
  const out = [];
  for (const tok of s.split(",")) {
    if (tok === "") continue;
    const v = Number.parseInt(tok, 10);
    if (Number.isNaN(v)) {
      warnings.push(`state: ignored non-integer "${tok}" in ${key}`);
      continue;
    }
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Parse a location hash into a state object.
 * @param {string} hash with or without the leading "#"
 * @param {Object} [base] state to start from; defaults to `defaultState()`
 * @returns {{state: Object, warnings: string[]}}
 */
export function parseHash(hash, base = null) {
  const warnings = [];
  const st = base ? { ...base } : defaultState();
  const raw = (hash || "").replace(/^#/, "");
  if (raw === "") return { state: st, warnings };

  for (const pair of raw.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    if (eq < 0) {
      warnings.push(`state: ignored hash token "${pair}" with no "="`);
      continue;
    }
    const key = decodeURIComponent(pair.slice(0, eq));
    const val = decodeURIComponent(pair.slice(eq + 1));
    switch (key) {
      case "ev":
        // A4: the registered keys are declared in config.EVENTS. An unknown key
        // falls back to the one already held — the same unknown-value warning
        // path as `view` — rather than fetching a payload that does
        // not exist and filling the console with 404s.
        if (EVENTS.includes(val)) st.ev = val;
        else warnings.push(`state: unknown event "${val}", kept "${st.ev}"`);
        break;
      case "cfg":
        if (val !== "") st.cfg = val;
        break;
      case "n": {
        const v = parseIntList(val, warnings, "n");
        if (v.length) st.n = v.sort((a, b) => a - b);
        break;
      }
      case "t": {
        const v = parseIntList(val, warnings, "t");
        if (v.length) st.t = v.sort((a, b) => a - b);
        break;
      }
      case "view":
        if (VIEW_KEYS.includes(val)) st.view = val;
        else warnings.push(`state: unknown view "${val}", kept "${st.view}"`);
        break;
      case "p": {
        const v = val.split(",").filter((k) => k !== "");
        const good = v.filter((k) => PARAM_KEYS.includes(k));
        for (const k of v) {
          if (!good.includes(k)) warnings.push(`state: unknown parameter "${k}", dropped`);
        }
        if (good.length) st.p = good;
        break;
      }
      case "lev": {
        // A COMMA LIST, and "" is legal and means no contour lines (request 2).
        // An old single-value link, `lev=90`, therefore still parses, to [90].
        const good = [];
        for (const tok of val.split(",")) {
          if (tok === "") continue;
          const v = Number.parseInt(tok, 10);
          if (CREDIBLE_LEVELS.includes(v)) {
            if (!good.includes(v)) good.push(v);
          } else {
            warnings.push(
              `state: level "${tok}" not in ${CREDIBLE_LEVELS.join(",")}, dropped`
            );
          }
        }
        st.levs = good.sort((a, b) => a - b);
        break;
      }
      case "sig": {
        // A4: the stops are declared in config.SMOOTH_SIGMAS and asserted here.
        // An unlisted sigma is REFUSED, not rounded to the nearest stop: it
        // would miss the contour worker's memo cache on every frame.
        const v = Number.parseFloat(val);
        if (SMOOTH_SIGMAS.includes(v)) st.sig = v;
        else {
          warnings.push(
            `state: smoothing "${val}" not in ${SMOOTH_SIGMAS.join(",")}, kept ${st.sig}`
          );
        }
        break;
      }
      case "mode":
        // Legacy key of the removed labels toggle (2026-09-18). Old shared links
        // still carry it; every view now draws EM labels, so it is ignored.
        break;
      case "pin": {
        const pins = [];
        for (const tok of val.split(",")) {
          if (tok === "") continue;
          const parts = tok.split(":");
          if (parts.length !== 3) {
            warnings.push(`state: ignored malformed pin "${tok}"`);
            continue;
          }
          const n = Number.parseInt(parts[1], 10);
          const t = Number.parseInt(parts[2], 10);
          if (Number.isNaN(n) || Number.isNaN(t)) {
            warnings.push(`state: ignored pin with non-integer n or t: "${tok}"`);
            continue;
          }
          pins.push({ cfg: parts[0], n, t });
        }
        st.pins = pins;
        break;
      }
      case "sc":
        st.scatter = val === "1";
        break;
      case "pr":
        st.prior = val === "1";
        break;
      case "km": {
        // A COMMA LIST over config.KERR_BLOB_MODE_LABELS, and "" is legal and
        // means "draw no prediction blob" — the same rule `lev` follows. An
        // unregistered label is DROPPED with a warning, never mapped to a
        // neighbour: a blob drawn under the wrong QNM name is a false statement.
        const good = [];
        for (const tok of val.split(",")) {
          if (tok === "") continue;
          if (KERR_BLOB_MODE_LABELS.includes(tok)) {
            if (!good.includes(tok)) good.push(tok);
          } else {
            warnings.push(`state: unknown Kerr label "${tok}", dropped`);
          }
        }
        st.km = good;
        break;
      }
      case "ma": {
        const m = {};
        for (const tok of val.split(",")) {
          if (tok === "") continue;
          const c = tok.indexOf(":");
          if (c < 0) {
            warnings.push(`state: ignored malformed mode-assignment axis "${tok}"`);
            continue;
          }
          const axis = tok.slice(0, c);
          if (!MODEASSIGN_AXES.includes(axis)) {
            warnings.push(`state: unknown mode-assignment axis "${axis}", dropped`);
            continue;
          }
          m[axis] = tok.slice(c + 1);
        }
        st.ma = m;
        break;
      }
      case "ap": {
        // The same grammar and the same wildcard rule as `ma`, over the two
        // axes of config.AMPPHASE_AXES. An unknown axis is DROPPED with a
        // warning: a selection on an axis the payload does not carry would
        // match no record and leave a blank page with no reason given.
        const m = {};
        for (const tok of val.split(",")) {
          if (tok === "") continue;
          const c = tok.indexOf(":");
          if (c < 0) {
            warnings.push(`state: ignored malformed amplitude/phase axis "${tok}"`);
            continue;
          }
          const axis = tok.slice(0, c);
          if (!AMPPHASE_AXES.includes(axis)) {
            warnings.push(`state: unknown amplitude/phase axis "${axis}", dropped`);
            continue;
          }
          m[axis] = tok.slice(c + 1);
        }
        st.ap = m;
        break;
      }
      case "apm": {
        // An unregistered display mode falls back to the default and SAYS so.
        // `config.ampPhaseColumns` RAISES on an unregistered mode, so an
        // unchecked value from a hand-edited link would break the whole view.
        if (Object.prototype.hasOwnProperty.call(AMPPHASE_COLUMNS, val)) {
          st.apm = val;
        } else {
          warnings.push(
            `state: unknown amplitude/phase display mode "${val}", using ` +
              `"${AMPPHASE_DEFAULT_MODE}"`
          );
          st.apm = AMPPHASE_DEFAULT_MODE;
        }
        break;
      }
      case "z": {
        // A window that is not drawable (non-finite, reversed or collapsed)
        // is DROPPED, not clamped: the view then falls back to its computed
        // range, so a hand-edited link draws the data instead of an empty
        // panel. The drop is reported, never silent.
        const z = {};
        for (const tok of val.split(",")) {
          if (tok === "") continue;
          // A key is "<view>/<axisId>" and holds no ":", so a plain split is
          // unambiguous.
          const parts = tok.split(":");
          if (parts.length !== 3) {
            warnings.push(`state: ignored malformed window "${tok}"`);
            continue;
          }
          const dom = [Number.parseFloat(parts[1]), Number.parseFloat(parts[2])];
          if (!isDrawableDomain(dom)) {
            warnings.push(
              `state: dropped window "${tok}" — [${dom[0]}, ${dom[1]}] is not drawable`
            );
            continue;
          }
          z[parts[0]] = dom;
        }
        st.z = z;
        break;
      }
      default:
        // Unknown key: ignored on purpose, so old links degrade not break.
        warnings.push(`state: ignored unknown hash key "${key}"`);
    }
  }
  return { state: st, warnings };
}

/**
 * Serialise a state back to a hash string, WITHOUT the leading "#".
 * `parseHash(stateToHash(s)).state` deep-equals `s` for every valid `s`.
 */
export function stateToHash(st) {
  const parts = [
    // The event comes first: it is the outermost selection, and it is the key a
    // reader of a shared link most needs to see.
    `ev=${encodeURIComponent(st.ev)}`,
    `cfg=${encodeURIComponent(st.cfg)}`,
    `n=${st.n.join(",")}`,
    `t=${st.t.join(",")}`,
    `view=${st.view}`,
    `p=${st.p.join(",")}`,
    // Always emitted, even when empty: `lev=` is how "no contour lines" round
    // trips. Omitting the key would make the parser fall back to the default.
    `lev=${levelsOf(st).join(",")}`,
    `sig=${st.sig}`,
  ];
  if (st.pins.length) {
    parts.push(`pin=${st.pins.map((q) => `${encodeURIComponent(q.cfg)}:${q.n}:${q.t}`).join(",")}`);
  }
  parts.push(`sc=${st.scatter ? 1 : 0}`);
  // Always emitted, even when empty: `km=` is how "no prediction blob" round
  // trips, exactly as `lev=` does for the contour levels.
  parts.push(`km=${kerrLabelsOf(st).join(",")}`);
  const makeys = Object.keys(st.ma ?? {}).sort();
  if (makeys.length) {
    parts.push(`ma=${makeys.map((k) => `${k}:${st.ma[k]}`).join(",")}`);
  }
  const apkeys = Object.keys(st.ap ?? {}).sort();
  if (apkeys.length) {
    parts.push(`ap=${apkeys.map((k) => `${k}:${st.ap[k]}`).join(",")}`);
  }
  // Emitted only when it is not the default, so a bare link stays bare and the
  // round trip is still a fixed point (the parser's default is the same value).
  if ((st.apm ?? AMPPHASE_DEFAULT_MODE) !== AMPPHASE_DEFAULT_MODE) {
    parts.push(`apm=${st.apm}`);
  }
  if (st.prior) parts.push("pr=1");
  // Keys are sorted, so the same set of windows always writes the same hash and
  // the round trip is a fixed point. `String(v)` is the shortest decimal that
  // reads back as the same double, so no precision is lost.
  const zkeys = Object.keys(st.z ?? {}).sort();
  if (zkeys.length) {
    parts.push(`z=${zkeys.map((k) => `${k}:${String(st.z[k][0])}:${String(st.z[k][1])}`).join(",")}`);
  }
  return parts.join("&");
}

/**
 * The Kerr prediction-blob labels to draw: a subset of KERR_BLOB_MODE_LABELS.
 *
 * THE EMPTY ARRAY IS LEGAL and means "draw no prediction blob", the same rule
 * `levelsOf` follows for the credible levels.
 *
 * @param {Object} st store state
 * @returns {string[]}
 */
export function kerrLabelsOf(st) {
  return Array.isArray(st.km) ? st.km : [];
}

/**
 * The mode-assignment configuration to show, axis by axis.
 *
 * The user's choice wins; every axis the user has not set falls back to the
 * PAYLOAD's `default_config`, which is passed in because the configuration grid
 * that was actually computed is a property of the payload and not of this
 * application. An axis neither set nor defaulted is `null`, which the record
 * lookup treats as "any value".
 *
 * @param {Object} st store state
 * @param {Object} fallback `{axis: value}` resolved from the payload
 * @returns {Object} `{axis: value|null}` over every axis
 */
export function modeAssignConfig(st, fallback = {}) {
  const chosen = st.ma ?? {};
  const out = {};
  for (const axis of MODEASSIGN_AXES) {
    const v = chosen[axis] !== undefined ? chosen[axis] : fallback[axis];
    out[axis] = v === undefined ? null : v;
  }
  return out;
}

/**
 * The amplitude/phase configuration to show, axis by axis.
 *
 * The same contract as `modeAssignConfig`, over `config.AMPPHASE_AXES`: the
 * user's choice wins, and an axis the user has not set falls back to the
 * PAYLOAD's own default, which is passed in because the (n_modes, delta_t)
 * grid that was computed is a property of the payload and not of this
 * application. An axis neither set nor defaulted is `null`.
 *
 * @param {Object} st store state
 * @param {Object} fallback `{axis: value}` resolved from the payload
 * @returns {Object} `{axis: value|null}` over every axis
 */
export function ampPhaseConfig(st, fallback = {}) {
  const chosen = st.ap ?? {};
  const out = {};
  for (const axis of AMPPHASE_AXES) {
    const v = chosen[axis] !== undefined ? chosen[axis] : fallback[axis];
    out[axis] = v === undefined ? null : v;
  }
  return out;
}

/** The amplitude/phase display mode: one registered key of
 *  `config.AMPPHASE_COLUMNS`, defaulting to `AMPPHASE_DEFAULT_MODE`. */
export function ampPhaseMode(st) {
  const v = st.apm;
  return Object.prototype.hasOwnProperty.call(AMPPHASE_COLUMNS, v)
    ? v
    : AMPPHASE_DEFAULT_MODE;
}

/** Canonical key for one run, used by every cache and every colour map. */
export function runKey(cfg, n, t) {
  return `${cfg}/${n}_${t}`;
}

/** The live (slider-driven) run set: the cross product of `n` and `t`. */
export function liveRuns(st) {
  const out = [];
  for (const n of st.n) for (const t of st.t) out.push({ cfg: st.cfg, n, t });
  return out;
}

/**
 * A tiny observable store. `set` applies a shallow patch, writes the hash and
 * notifies subscribers. Hash writes use `replaceState` so that dragging the
 * slider does not fill the browser history (ruling 2: the slider is live).
 */
export class Store {
  constructor(initial) {
    this._st = initial;
    this._subs = new Set();
    this._raf = null;
  }
  get state() {
    return this._st;
  }
  subscribe(fn) {
    this._subs.add(fn);
    return () => this._subs.delete(fn);
  }
  set(patch) {
    this._st = { ...this._st, ...patch };
    this._writeHash();
    for (const fn of this._subs) fn(this._st);
  }
  _writeHash() {
    if (typeof window === "undefined" || !window.history) return;
    const h = "#" + stateToHash(this._st);
    if (window.location.hash !== h) {
      window.history.replaceState(null, "", h);
    }
  }
}
