/**
 * loader.js — the payload loader.
 *
 * Tier 1 (grids) and Tier 3 (summary) are PRELOADED for the whole event, once.
 * That is what makes the start-time slider free: moving it needs no fetch and
 * no posterior recompute (spec section 4, ruling 2).
 *
 * Tier 2 (samples) is fetched on demand, per displayed or pinned run, and the
 * neighbouring slider positions are prefetched so that a drag does not stall
 * on the network.
 *
 * Tier 4 (fit band) and Tier 5 (sky) are fetched on demand by task T4's views,
 * through the same LRU-plus-in-flight-sharing path as Tier 2.
 *
 * THE TIER 5 GRID IS EVENT-LEVEL: it is the IMR sky posterior, shared by every
 * run, so it is fetched ONCE and cached for the life of the page. That is what
 * makes the sky slider free — moving it re-weights the same points and fetches
 * only the run's 16 kB visit-index block (spec section 4, Tier 5).
 *
 * URL layout under the R2 apex (spec section 5):
 *   <base>/<EVENT>/runs.json
 *   <base>/<EVENT>/summary.json
 *   <base>/<EVENT>/grids.bin
 *   <base>/<EVENT>/samples/<config>/<n>_<t>.f32     Tier 2
 *   <base>/<EVENT>/band/<config>/<n>_<t>.bin        Tier 4, magic SGB1
 *   <base>/<EVENT>/sky/grid.bin                     Tier 5 grid, magic SGK1
 *   <base>/<EVENT>/sky/<config>/<n>_<t>.bin         Tier 5 run,  magic SGK1
 *   <base>/<EVENT>/emdiag/<config>/<n>_<t>.bin      Tier 6, magic SGE1
 *
 * The base is `https://silencio-gw.fyi` (config.DATA_BASE_URL). The host
 * `data.silencio-gw.fyi` does not exist.
 */

import {
  assertEvent,
  DATA_BASE_URL,
  DEFAULT_EVENT,
  EXTRAS_KEY,
  EXTRA_PATHS,
  KERR9_CONFIG,
  KERR9_PAIR,
  KERR9_T_START,
  KERR_BLOB_MODE_LABELS,
  PREFETCH_RADIUS,
  TIER2_CACHE_MAX,
  TIER4_CACHE_MAX,
  TIER5_CACHE_MAX,
  TIER6_CACHE_MAX,
} from "./config.js";
import { gridKey, parseTier1, parseTier2, parseTier6 } from "./format.js";
import { parseTier4 } from "./tier4.js";
import { parseTier5 } from "./sky_weights.js";
import { runKey } from "./state.js";

export class Loader {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.baseUrl] defaults to config.DATA_BASE_URL
   * @param {string} [opts.event] defaults to config.DEFAULT_EVENT; RAISES when
   *   it is not a registered key (A4)
   * @param {Function} [opts.fetchImpl] injected for tests; defaults to global fetch
   */
  constructor(opts = {}) {
    this.baseUrl = (opts.baseUrl ?? DATA_BASE_URL).replace(/\/+$/, "");
    this.event = assertEvent(opts.event ?? DEFAULT_EVENT);
    this._fetch = opts.fetchImpl ?? ((...a) => fetch(...a));
    this.runs = null; // runs.json
    this.summary = null; // Tier 3
    this.tier1 = null; // {header, grids: Map}
    this._t2 = new Map(); // runKey -> parsed Tier 2
    this._t2order = []; // LRU order of runKey
    this._inflight = new Map(); // runKey -> Promise
    this._t4 = new Map(); // runKey -> parsed Tier 4
    this._t4order = [];
    this._t4inflight = new Map();
    this._t5 = new Map(); // runKey -> parsed Tier 5 "run" block
    this._t5order = [];
    this._t5inflight = new Map();
    this._t5grid = null; // parsed Tier 5 "grid", event-level, cached forever
    this._t5gridInflight = null;
    this._t6 = new Map(); // runKey -> parsed Tier 6 EM-diagnostic block
    this._t6order = [];
    this._t6inflight = new Map();
    // The three OPTIONAL prediction files. All are EVENT-level and small, so
    // each is fetched once and kept for the life of the page, like the Tier 5
    // sky grid. Dropped by `switchEvent`, which is what stops one event's
    // blobs being drawn under another event's label.
    this._kerr9 = null;
    this._kerr9Inflight = null;
    this._modeAssign = null;
    this._modeAssignInflight = null;
    this._ampPhase = null;
    this._ampPhaseInflight = null;
  }

  url(path) {
    return `${this.baseUrl}/${this.event}/${path}`;
  }

  async _json(path) {
    const r = await this._fetch(this.url(path));
    if (!r.ok) throw new Error(`loader: ${path} -> HTTP ${r.status}`);
    return r.json();
  }

  async _buffer(path) {
    const r = await this._fetch(this.url(path));
    if (!r.ok) throw new Error(`loader: ${path} -> HTTP ${r.status}`);
    return r.arrayBuffer();
  }

  /** Preload Tier 1 and Tier 3 plus the run index. Call once at startup. */
  async preload() {
    const [runs, summary, gridBuf] = await Promise.all([
      this._json("runs.json"),
      this._json("summary.json"),
      this._buffer("grids.bin"),
    ]);
    this.runs = runs;
    this.summary = summary;
    this.tier1 = parseTier1(gridBuf); // asserts magic and GRID_BINS
    return this;
  }

  /**
   * Point this loader at another event and preload it.
   *
   * EVERY cache is dropped first. A Tier 2 block is keyed on
   * `<cfg>/<n>_<t>`, which carries no event, so a surviving entry would draw
   * the previous event's posterior under the new event's label. The in-flight
   * requests are dropped the same way, and any that is already running is
   * discarded when it lands (see `_assertSameEvent`).
   *
   * @param {string} key a registered site event key; RAISES otherwise (A4)
   * @returns {Promise<Loader>} this, after `preload()`
   */
  async switchEvent(key) {
    assertEvent(key);
    this.event = key;
    this.runs = null;
    this.summary = null;
    this.tier1 = null;
    this._t2.clear();
    this._t2order.length = 0;
    this._inflight.clear();
    this._t4.clear();
    this._t4order.length = 0;
    this._t4inflight.clear();
    this._t5.clear();
    this._t5order.length = 0;
    this._t5inflight.clear();
    this._t5grid = null;
    this._t5gridInflight = null;
    this._t6.clear();
    this._t6order.length = 0;
    this._t6inflight.clear();
    this._kerr9 = null;
    this._kerr9Inflight = null;
    this._modeAssign = null;
    this._modeAssignInflight = null;
    this._ampPhase = null;
    this._ampPhaseInflight = null;
    return this.preload();
  }

  /**
   * RAISES when the loader has moved to another event since a fetch started.
   *
   * The failure this prevents: a Tier 2, 4, 5 or 6 block requested for the old
   * event landing in the cache after `switchEvent`, under a run key that
   * carries no event, and being drawn as the new event's data.
   * @param {string} ev the event the request was issued for
   */
  _assertSameEvent(ev) {
    if (this.event !== ev) {
      throw new Error(
        `loader: a fetch for event "${ev}" landed after the loader moved to ` +
          `"${this.event}"; it is discarded rather than cached under a run key ` +
          `that carries no event.`
      );
    }
  }

  /**
   * The `event` block of Tier 3 — every event-level constant the views need:
   * `{key, imr_maxl_ra, imr_maxl_dec, final_mass_maxl, final_spin_maxl,
   * detectors, ref_detector, n_start_times, start_times}`.
   *
   * RAISES when the payload carries no block, or when its `key` is not the
   * event that was asked for (A4). Both are a mis-built or mis-served payload,
   * and the alternative — a view falling back to a literal — is exactly what
   * this block exists to remove: it would draw one event's sky cross over
   * another event's posterior and look perfectly plausible.
   *
   * @returns {Object} the event block
   */
  eventMeta() {
    if (!this.summary) throw new Error("loader.eventMeta: call preload() first");
    const ev = this.summary.event;
    if (ev === undefined || ev === null || typeof ev !== "object") {
      throw new Error(
        `loader.eventMeta: ${this.url("summary.json")} carries no "event" block ` +
          `(found ${JSON.stringify(ev)}). A payload built before the multi-event ` +
          `build has the event name as a bare string there; rebuild it with ` +
          `build_payload.py.`
      );
    }
    if (ev.key !== this.event) {
      throw new Error(
        `loader.eventMeta: summary.json event block says key "${ev.key}" but this ` +
          `loader asked for "${this.event}".`
      );
    }
    return ev;
  }

  /** Configuration names present in the payload, in `runs.json` order. */
  configs() {
    if (!this.runs) throw new Error("loader.configs: call preload() first");
    return this.runs.configs.map((c) => c.name);
  }

  /** Mode counts available for a configuration, ascending. */
  modeCounts(cfg) {
    return [...new Set(this._runsOf(cfg).map((r) => r.n_modes))].sort((a, b) => a - b);
  }

  /** Start times available for a configuration and mode count, ascending, in M_rem. */
  startTimes(cfg, nModes) {
    return this._runsOf(cfg)
      .filter((r) => r.n_modes === nModes)
      .map((r) => r.t_start)
      .sort((a, b) => a - b);
  }

  _runsOf(cfg) {
    if (!this.runs) throw new Error("loader: call preload() first");
    const c = this.runs.configs.find((x) => x.name === cfg);
    if (c === undefined) {
      throw new Error(
        `loader: unknown configuration "${cfg}". Present: ${this.configs().join(", ")}`
      );
    }
    return c.runs;
  }

  /** Tier 3 summary record for one run, or undefined. */
  summaryOf(cfg, n, t) {
    if (!this.summary) throw new Error("loader.summaryOf: call preload() first");
    return this.summary.runs[runKey(cfg, n, t)];
  }

  /**
   * One preloaded Tier 1 grid. Returns undefined when the pair was not
   * precomputed, which is the caller's signal to fall back to Tier 2.
   */
  grid(cfg, n, t, mode, px, py) {
    if (!this.tier1) throw new Error("loader.grid: call preload() first");
    return this.tier1.grids.get(gridKey(cfg, n, t, mode, px, py));
  }

  /** Cached Tier 2 block, or undefined when it is not resident. */
  tier2Cached(cfg, n, t) {
    return this._t2.get(runKey(cfg, n, t));
  }

  /**
   * Fetch (or return cached) Tier 2 samples for one run. Concurrent calls for
   * the same run share one request.
   */
  async tier2(cfg, n, t) {
    const k = runKey(cfg, n, t);
    const hit = this._t2.get(k);
    if (hit !== undefined) {
      this._touch(k);
      return hit;
    }
    const busy = this._inflight.get(k);
    if (busy !== undefined) return busy;
    const ev = this.event;
    const p = (async () => {
      const buf = await this._buffer(`samples/${cfg}/${n}_${t}.f32`);
      this._assertSameEvent(ev);
      const parsed = parseTier2(buf); // asserts magic and columns
      if (parsed.n_modes !== n || parsed.t_start !== t) {
        throw new Error(
          `loader.tier2: ${k} header says n_modes=${parsed.n_modes}, t_start=${parsed.t_start}`
        );
      }
      this._t2.set(k, parsed);
      this._touch(k);
      this._evict();
      this._inflight.delete(k);
      return parsed;
    })();
    this._inflight.set(k, p);
    p.catch(() => this._inflight.delete(k));
    return p;
  }

  _touch(k) {
    const i = this._t2order.indexOf(k);
    if (i >= 0) this._t2order.splice(i, 1);
    this._t2order.push(k);
  }

  _evict() {
    while (this._t2order.length > TIER2_CACHE_MAX) {
      const victim = this._t2order.shift();
      this._t2.delete(victim);
    }
  }

  /**
   * Prefetch the PREFETCH_RADIUS neighbouring start times on each side of `t`,
   * so that dragging the slider hits the cache. Errors are swallowed: a failed
   * prefetch must never break the current frame.
   * @returns {Promise<void>}
   */
  async prefetchNeighbours(cfg, n, t) {
    const times = this.startTimes(cfg, n);
    const i = times.indexOf(t);
    if (i < 0) return;
    const jobs = [];
    for (let d = 1; d <= PREFETCH_RADIUS; d++) {
      for (const j of [i - d, i + d]) {
        if (j >= 0 && j < times.length) {
          jobs.push(this.tier2(cfg, n, times[j]).catch(() => null));
        }
      }
    }
    await Promise.all(jobs);
  }

  /**
   * Generic "cached, or one shared in-flight fetch" path, used by Tiers 4 and 5.
   *
   * Written once rather than three times, because the failure this prevents is
   * subtle: two concurrent calls for the same run must SHARE one request, or a
   * slider drag issues duplicate multi-megabyte fetches.
   *
   * @param {string} k cache key
   * @param {string} path payload path under the event directory
   * @param {Function} parse ArrayBuffer -> parsed block
   * @param {Map} store @param {string[]} order @param {Map} inflight
   * @param {number} maxEntries
   * @param {Function} [verify] called with the parsed block; should throw on a mismatch
   */
  async _cachedBinary(k, path, parse, store, order, inflight, maxEntries, verify) {
    const hit = store.get(k);
    if (hit !== undefined) {
      const i = order.indexOf(k);
      if (i >= 0) order.splice(i, 1);
      order.push(k);
      return hit;
    }
    const busy = inflight.get(k);
    if (busy !== undefined) return busy;
    const ev = this.event;
    const p = (async () => {
      const buf = await this._buffer(path);
      this._assertSameEvent(ev);
      const parsed = parse(buf);
      if (verify) verify(parsed);
      store.set(k, parsed);
      order.push(k);
      while (order.length > maxEntries) {
        const victim = order.shift();
        if (victim !== k) store.delete(victim);
      }
      inflight.delete(k);
      return parsed;
    })();
    inflight.set(k, p);
    p.catch(() => inflight.delete(k));
    return p;
  }

  /** Cached Tier 4 block, or undefined when it is not resident. */
  tier4Cached(cfg, n, t) {
    return this._t4.get(runKey(cfg, n, t));
  }

  /**
   * Fetch (or return cached) the Tier 4 fit band of one run.
   *
   * The header is checked against the run that was asked for, so a mis-served
   * or mis-built file fails loudly instead of drawing another run's band under
   * this run's label.
   *
   * @returns {Promise<Object>} parseTier4 result, arrays dequantised to Float64
   */
  async tier4(cfg, n, t) {
    const k = runKey(cfg, n, t);
    return this._cachedBinary(
      k,
      `band/${cfg}/${n}_${t}.bin`,
      parseTier4,
      this._t4,
      this._t4order,
      this._t4inflight,
      TIER4_CACHE_MAX,
      (parsed) => {
        if (parsed.n_modes !== n || parsed.t_start !== t) {
          throw new Error(
            `loader.tier4: ${k} header says n_modes=${parsed.n_modes}, t_start=${parsed.t_start}`
          );
        }
      }
    );
  }

  /** The event-level Tier 5 sky grid, if it has already been fetched. */
  tier5GridCached() {
    return this._t5grid ?? undefined;
  }

  /**
   * The event-level Tier 5 sky grid (the IMR sky posterior points).
   *
   * Fetched once and kept for the life of the page: every run re-weights these
   * SAME points, which is what makes the sky slider need no fetch.
   *
   * @returns {Promise<Object>} parseTier5 result of kind "grid"
   */
  async tier5Grid() {
    if (this._t5grid !== null) return this._t5grid;
    if (this._t5gridInflight !== null) return this._t5gridInflight;
    const ev = this.event;
    this._t5gridInflight = (async () => {
      const buf = await this._buffer("sky/grid.bin");
      this._assertSameEvent(ev);
      const parsed = parseTier5(buf);
      if (parsed.kind !== "grid") {
        throw new Error(
          `loader.tier5Grid: sky/grid.bin has kind "${parsed.kind}", expected "grid"`
        );
      }
      this._t5grid = parsed;
      this._t5gridInflight = null;
      return parsed;
    })();
    this._t5gridInflight.catch(() => {
      this._t5gridInflight = null;
    });
    return this._t5gridInflight;
  }

  /** Cached Tier 5 run block, or undefined when it is not resident. */
  tier5RunCached(cfg, n, t) {
    return this._t5.get(runKey(cfg, n, t));
  }

  /**
   * Fetch (or return cached) one run's Tier 5 sky visit indices.
   * @returns {Promise<Object>} parseTier5 result of kind "run"
   */
  async tier5Run(cfg, n, t) {
    const k = runKey(cfg, n, t);
    return this._cachedBinary(
      k,
      `sky/${cfg}/${n}_${t}.bin`,
      parseTier5,
      this._t5,
      this._t5order,
      this._t5inflight,
      TIER5_CACHE_MAX,
      (parsed) => {
        if (parsed.kind !== "run") {
          throw new Error(
            `loader.tier5Run: ${k} has kind "${parsed.kind}", expected "run"`
          );
        }
      }
    );
  }

  /** Cached Tier 6 EM-diagnostic block, or undefined when it is not resident. */
  tier6Cached(cfg, n, t) {
    return this._t6.get(runKey(cfg, n, t));
  }

  /**
   * Fetch (or return cached) the Tier 6 EM-cluster diagnostic of one run.
   *
   * The header is checked against the run that was asked for, so a mis-served
   * file fails loudly instead of drawing another run's EM clusters under this
   * run's label.
   *
   * @returns {Promise<Object>} parseTier6 result
   */
  async tier6(cfg, n, t) {
    const k = runKey(cfg, n, t);
    return this._cachedBinary(
      k,
      `emdiag/${cfg}/${n}_${t}.bin`,
      parseTier6,
      this._t6,
      this._t6order,
      this._t6inflight,
      TIER6_CACHE_MAX,
      (parsed) => {
        if (parsed.n_modes !== n || parsed.t_start !== t) {
          throw new Error(
            `loader.tier6: ${k} header says n_modes=${parsed.n_modes}, t_start=${parsed.t_start}`
          );
        }
      }
    );
  }

  /* -----------------------------------------------------------------------
   * The OPTIONAL prediction files, `kerr9/blobs.bin` and `modeassign.json`.
   *
   * THE ADVERT IS THE WHOLE POINT. A payload says which of them it carries, in
   * the `extras` map of its `event` block. A file that is not advertised is
   * NEVER requested: an HTTP 404 is not a network failure, so it does not reach
   * `requestfailed`, it reaches the console, and gate G-site's bar is zero
   * console messages. `hasExtra` is therefore the guard every caller uses, and
   * `extraPath` checks the advertised path against `config.EXTRA_PATHS` so a
   * payload cannot redirect the browser to an arbitrary URL (A4).
   * -------------------------------------------------------------------- */

  /** The advert map of this event's payload; `{}` when it carries none. */
  extras() {
    const ev = this.eventMeta();
    const raw = ev[EXTRAS_KEY];
    return raw && typeof raw === "object" ? raw : {};
  }

  /**
   * True when this event's payload carries the named optional file.
   * @param {string} name a key of `config.EXTRA_PATHS`
   */
  hasExtra(name) {
    if (EXTRA_PATHS[name] === undefined) {
      throw new Error(
        `loader.hasExtra: unregistered extra "${name}". ` +
          `Registered: ${Object.keys(EXTRA_PATHS).join(", ")}`
      );
    }
    return Object.prototype.hasOwnProperty.call(this.extras(), name);
  }

  /** The payload path of one advertised extra. RAISES when the advert and the
   *  declared path disagree, or when the extra is not advertised at all. */
  extraPath(name) {
    const declared = EXTRA_PATHS[name];
    if (declared === undefined) {
      throw new Error(
        `loader.extraPath: unregistered extra "${name}". ` +
          `Registered: ${Object.keys(EXTRA_PATHS).join(", ")}`
      );
    }
    const advertised = this.extras()[name];
    if (advertised === undefined) {
      throw new Error(
        `loader.extraPath: event "${this.event}" does not advertise "${name}", so ` +
          `it is not fetched. An unadvertised file would answer 404, and a 404 is ` +
          `a console error.`
      );
    }
    if (advertised !== declared) {
      throw new Error(
        `loader.extraPath: event "${this.event}" advertises "${name}" at ` +
          `"${advertised}" but the declared path is "${declared}".`
      );
    }
    return declared;
  }

  /** The parsed nine-mode Kerr blob file, if it has already been fetched. */
  kerr9Cached() {
    return this._kerr9 ?? undefined;
  }

  /**
   * Fetch (or return cached) the nine Kerr prediction blobs of this event.
   *
   * The file is a Tier 1 grid file (magic SGR1) whose entries are PREDICTIONS,
   * not posteriors: `mode` is the index into `config.KERR_BLOB_MODE_LABELS` and
   * never a sampler EM index. The header's label list is asserted against that
   * declaration (A4), so a payload built from a different label set fails loudly
   * rather than drawing a blob under the wrong name.
   *
   * @returns {Promise<Object>} `{header, grids, labels, maxl}`
   */
  async kerr9() {
    if (this._kerr9 !== null) return this._kerr9;
    if (this._kerr9Inflight !== null) return this._kerr9Inflight;
    const ev = this.event;
    const path = this.extraPath("kerr9");
    this._kerr9Inflight = (async () => {
      const buf = await this._buffer(path);
      this._assertSameEvent(ev);
      const parsed = parseTier1(buf); // asserts magic and GRID_BINS
      const h = parsed.header;
      if (h.kind !== "kerr_blobs") {
        throw new Error(
          `loader.kerr9: ${path} header kind "${h.kind}", expected "kerr_blobs"`
        );
      }
      const labels = Array.isArray(h.mode_labels) ? h.mode_labels : [];
      if (labels.join(",") !== KERR_BLOB_MODE_LABELS.join(",")) {
        throw new Error(
          `loader.kerr9: ${path} mode_labels [${labels.join(", ")}] != the ` +
            `declared KERR_BLOB_MODE_LABELS [${KERR_BLOB_MODE_LABELS.join(", ")}]`
        );
      }
      const maxl = new Map();
      for (const m of h.maxl ?? []) {
        if (!(Number(m.f) > 0) || !(Number(m.gamma) > 0)) {
          throw new Error(
            `loader.kerr9: ${path} maximum-likelihood point of "${m.label}" is ` +
              `f=${m.f} Hz, gamma=${m.gamma} 1/s; both must be > 0`
          );
        }
        maxl.set(m.label, { f: Number(m.f), gamma: Number(m.gamma) });
      }
      const out = { header: h, grids: parsed.grids, labels, maxl };
      this._kerr9 = out;
      this._kerr9Inflight = null;
      return out;
    })();
    this._kerr9Inflight.catch(() => {
      this._kerr9Inflight = null;
    });
    return this._kerr9Inflight;
  }

  /**
   * One Kerr blob grid, by label, from what is already resident.
   * @param {string} label one of `config.KERR_BLOB_MODE_LABELS`
   * @returns {Object|undefined}
   */
  kerr9Grid(label) {
    const blob = this.kerr9Cached();
    if (blob === undefined) return undefined;
    const k = blob.labels.indexOf(label);
    if (k < 0) return undefined;
    return blob.grids.get(
      gridKey(KERR9_CONFIG, blob.labels.length, KERR9_T_START, k, KERR9_PAIR[0], KERR9_PAIR[1])
    );
  }

  /** The parsed mode-assignment records, if they have already been fetched. */
  modeAssignCached() {
    return this._modeAssign ?? undefined;
  }

  /**
   * Fetch (or return cached) the Stage-3 mode-assignment records of this event.
   * @returns {Promise<Object>} the parsed `modeassign.json`
   */
  async modeAssign() {
    if (this._modeAssign !== null) return this._modeAssign;
    if (this._modeAssignInflight !== null) return this._modeAssignInflight;
    const ev = this.event;
    const path = this.extraPath("mode_assign");
    this._modeAssignInflight = (async () => {
      const r = await this._fetch(this.url(path));
      if (!r.ok) throw new Error(`loader.modeAssign: ${path} -> HTTP ${r.status}`);
      const doc = await r.json();
      this._assertSameEvent(ev);
      if (doc.event !== ev) {
        throw new Error(
          `loader.modeAssign: ${path} says event "${doc.event}" but this loader ` +
            `asked for "${ev}".`
        );
      }
      for (const key of ["records", "axes", "candidates_ranked", "em_index", "notes"]) {
        if (doc[key] === undefined) {
          throw new Error(`loader.modeAssign: ${path} has no "${key}"`);
        }
      }
      this._modeAssign = doc;
      this._modeAssignInflight = null;
      return doc;
    })();
    this._modeAssignInflight.catch(() => {
      this._modeAssignInflight = null;
    });
    return this._modeAssignInflight;
  }

  /** The parsed amplitude/phase summaries, if they have already been fetched. */
  ampPhaseCached() {
    return this._ampPhase ?? undefined;
  }

  /**
   * Fetch (or return cached) the amplitude/phase summaries of this event.
   *
   * The required keys are checked here rather than in the two views that read
   * the file, so a payload short of one of them fails ONCE, loudly, with the
   * key named -- instead of drawing an empty panel in each view.
   *
   * @returns {Promise<Object>} the parsed `ampphase.json`
   */
  async ampPhase() {
    if (this._ampPhase !== null) return this._ampPhase;
    if (this._ampPhaseInflight !== null) return this._ampPhaseInflight;
    const ev = this.event;
    const path = this.extraPath("amp_phase");
    this._ampPhaseInflight = (async () => {
      const r = await this._fetch(this.url(path));
      if (!r.ok) throw new Error(`loader.ampPhase: ${path} -> HTTP ${r.status}`);
      const doc = await r.json();
      this._assertSameEvent(ev);
      if (doc.event !== ev) {
        throw new Error(
          `loader.ampPhase: ${path} says event "${doc.event}" but this loader ` +
            `asked for "${ev}".`
        );
      }
      for (const key of [
        "notes",
        "axes",
        "default_config",
        "t_start_m",
        "prediction",
        "prediction_flags",
        "measured",
        "consistency",
        "provenance",
      ]) {
        if (doc[key] === undefined) {
          throw new Error(`loader.ampPhase: ${path} has no "${key}"`);
        }
      }
      this._ampPhase = doc;
      this._ampPhaseInflight = null;
      return doc;
    })();
    this._ampPhaseInflight.catch(() => {
      this._ampPhaseInflight = null;
    });
    return this._ampPhaseInflight;
  }
}
