/**
 * main.js — bootstrap, the view registry, the render loop and figure export.
 *
 * Startup order:
 *   1. read the URL hash into the store (unknown keys ignored, ruling 5). The
 *      `ev` key is read FIRST and alone, because it decides which payload the
 *      loader preloads; an unregistered key falls back to DEFAULT_EVENT with a
 *      warning (state.js)
 *   2. preload Tier 1 (grids) and Tier 3 (summary) for the whole event
 *   3. build the control rail
 *   4. render on every state change, coalesced to one frame
 *
 * Only ONE render runs at a time. A state change during a render marks the
 * frame dirty and re-renders when it finishes, so a fast drag drops
 * intermediate frames instead of queueing them (ruling 2).
 *
 * THE VIEW REGISTRY (pitfall A4)
 * ------------------------------
 * Every view key in `config.VIEW_REGISTRY` must have a factory here, and the
 * pairing is CHECKED at boot: a registered view with no factory, or a factory
 * for an unregistered view, raises immediately instead of producing a blank
 * panel when a user picks that view. Selection goes through `getView`, which
 * raises on an unregistered key — there is no silent default view.
 *
 * View instances are created LAZILY and then KEPT, because several of them hold
 * caches worth preserving across a view switch: the sky view keeps the
 * projected sky bank (5 000 points), and the f-gamma, fit-band and sky views
 * keep their last prepared frame so that SVG export needs no refetch.
 *
 * FETCHING IS NEVER ON THE FRAME PATH
 * -----------------------------------
 * A view draws from what is already resident and says so when a block is
 * missing. `ensureData` fires the fetches that the current view and state need
 * and redraws when one lands. This is what keeps the slider live: a drag
 * re-renders from cache immediately and fills in detail as it arrives.
 *
 * EXPORT
 * ------
 * PNG is the canvas itself (`toBlob`). SVG re-draws the ACTIVE view into
 * `surface.SvgSurface`, the recorder that implements the Canvas 2D subset the
 * views use, so the vector file comes from the same drawing code as the screen
 * rather than a second path that could disagree with it. File names carry the
 * event, view, run selection, level and date (provenance, D1).
 */

import { getView, VIEW_KEYS } from "./config.js";
import { liveColor, pinColor, runDash } from "./colors.js";
import { Loader } from "./loader.js";
import { Store, defaultState, levelsOf, liveRuns, parseHash, runKey, stateToHash } from "./state.js";
import { ContourClient } from "./worker_client.js";
import { ControlRail } from "./controls.js";
import { attachInteractions } from "./interact.js";
import { SvgSurface } from "./surface.js";
import { AmpPhaseView } from "./views/ampphase.js";
import { ConsistencyView } from "./views/consistency.js";
import { CornerView } from "./views/corner.js";
import { FGammaView } from "./views/fgamma.js";
import { CrossRunView } from "./views/crossrun.js";
import { DiagnosticsView } from "./views/diagnostics.js";
import { FitBandView } from "./views/fitband.js";
import { ModeAssignView } from "./views/modeassign.js";
import { SkyView } from "./views/sky.js";

/**
 * Build the compare set: the live selection first, then the pins.
 *
 * EACH SERIES CARRIES BOTH CHANNELS, and which one means "run" depends on the
 * view (ruling 18, and the data fact behind it):
 *
 *   * `dash` — the run's dash, from `runDash(i)`. Used by the views that
 *     decompose by MODE (corner, f-gamma, cross-run), where colour is spent on
 *     the mode index and the run must therefore take the dash channel.
 *   * `color` — the run's colour, `liveColor(i)` per LIVE run and `pinColor(i)`
 *     per pin. Used by the views that have NO mode decomposition at all (fit
 *     band, sky): Tier 4 and Tier 5 carry no per-mode split, so there is no
 *     mode in those views to colour and the run keeps the colour.
 *     THE LIVE SET IS OFTEN SEVERAL RUNS — it is the cross product of the
 *     selected mode counts and start times — so it is indexed into
 *     LIVE_PALETTE, not painted one flat LIVE_COLOR. With a single live run
 *     `liveColor(0) === LIVE_COLOR` and nothing changes.
 *
 * `i` indexes the whole series array, live runs included, so no two overlaid
 * runs share a dash.
 */
export function buildSeries(st) {
  const out = [];
  liveRuns(st).forEach((r, i) => {
    out.push({ ...r, color: liveColor(i), label: `${runKey(r.cfg, r.n, r.t)} (live)`, isPin: false });
  });
  st.pins.forEach((q, i) => {
    out.push({ ...q, color: pinColor(i), label: runKey(q.cfg, q.n, q.t), isPin: true });
  });
  out.forEach((s, i) => {
    s.dash = runDash(i);
  });
  return out;
}

/**
 * The view factories, one per registered view key.
 *
 * Exported so a test can check the registry pairing without booting a DOM.
 */
export function viewFactories(canvas, client) {
  return {
    corner: () => new CornerView(canvas, client),
    fgamma: () => new FGammaView(canvas, client),
    crossrun: () => new CrossRunView(canvas),
    diagnostics: () => new DiagnosticsView(canvas),
    fitband: () => new FitBandView(canvas),
    modeassign: () => new ModeAssignView(canvas),
    ampphase: () => new AmpPhaseView(canvas),
    consistency: () => new ConsistencyView(canvas),
    sky: () => new SkyView(canvas, client),
  };
}

/**
 * Check that the view registry and the factory table agree, in both directions.
 * RAISES on a mismatch (A4): the failure this prevents is a view that appears
 * in the rail's selector and then draws nothing.
 * @param {Object} factories
 */
export function assertViewRegistry(factories) {
  const missing = VIEW_KEYS.filter((k) => typeof factories[k] !== "function");
  if (missing.length) {
    throw new Error(
      `main: config.VIEW_REGISTRY has ${missing.join(", ")} but main.js has no ` +
        `factory for ${missing.length > 1 ? "them" : "it"}. Every registered ` +
        `view must be constructible, or the rail would offer a view that draws nothing.`
    );
  }
  const extra = Object.keys(factories).filter((k) => !VIEW_KEYS.includes(k));
  if (extra.length) {
    throw new Error(
      `main: main.js has a factory for unregistered view(s) ${extra.join(", ")}. ` +
        `Add them to config.VIEW_REGISTRY or remove the factory.`
    );
  }
}

/** Trigger a browser download of one Blob under `name`. */
function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick: revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * A file name that says what the figure is (D1): event, view, the run
 * selection, the credible level and the date.
 * @param {Object} st @param {string} ext
 */
export function exportName(st, ext) {
  const runs = liveRuns(st)
    .map((r) => `${r.n}_${r.t}`)
    .join("-");
  const pins = st.pins.length ? `_pin${st.pins.map((q) => `${q.n}_${q.t}`).join("-")}` : "";
  const date = new Date().toISOString().slice(0, 10);
  // Several levels may be shown at once, and none is legal (request 2), so the
  // name carries the whole set. "levnone" keeps the field present rather than
  // producing a bare "lev_" that reads like a lost value.
  const levs = levelsOf(st);
  const lev = levs.length ? levs.join("-") : "none";
  // The event comes from the STATE, not from a module constant: the site serves
  // eight, and a file named for the wrong one is a provenance failure (D1).
  return `silencio_${st.ev}_${st.view}_${st.cfg}_${runs}${pins}_lev${lev}_${date}.${ext}`;
}

export async function boot({ baseUrl, mount } = {}) {
  const el = {
    rail: document.getElementById("rail"),
    canvas: document.getElementById("plot"),
    status: document.getElementById("status"),
    title: document.getElementById("title"),
    exportPng: document.getElementById("export-png"),
    exportSvg: document.getElementById("export-svg"),
  };
  if (mount) Object.assign(el, mount);


  // The event is read from the hash BEFORE anything is fetched: it decides which
  // payload the loader preloads. Everything else is parsed a second time once
  // the payload is in, because the default configuration comes from the payload.
  const first = parseHash(window.location.hash, defaultState());
  if (first.warnings.length) console.warn(first.warnings.join("\n"));

  el.title.textContent = first.state.ev;
  el.status.textContent = `loading Tier 1 and Tier 3 for ${first.state.ev} …`;
  const loader = new Loader({ ...(baseUrl ? { baseUrl } : {}), event: first.state.ev });
  await loader.preload();

  const cfg0 = loader.configs()[0];
  const { state: parsed, warnings } = parseHash(
    window.location.hash,
    defaultState(cfg0, first.state.ev)
  );
  if (warnings.length) console.warn(warnings.join("\n"));
  const store = new Store(parsed);

  const client = new ContourClient();
  const factories = viewFactories(el.canvas, client);
  assertViewRegistry(factories);
  const instances = new Map();
  /** Lazily construct, then keep, the instance of one view. */
  const viewFor = (key) => {
    getView(key); // RAISES on an unregistered key
    if (!instances.has(key)) instances.set(key, factories[key]());
    return instances.get(key);
  };

  const rail = new ControlRail(el.rail, store, loader);

  // Cursor zoom, drag pan and double-click reset (task R4, request 6). The
  // hit areas are read LIVE from the active view instance, so a view switch
  // needs no re-attachment and a view that publishes none is simply inert.
  const detachInteractions = attachInteractions(
    el.canvas,
    store,
    () => instances.get(store.state.view)?.hitAreas ?? []
  );

  let rendering = false;
  let dirty = false;
  /** True while the payload of another event is being preloaded. */
  let eventBusy = false;

  /**
   * Move the whole application to another event.
   *
   * Everything event-scoped is dropped and rebuilt, because none of the cache
   * keys carry the event: a Tier 2 block is keyed `<cfg>/<n>_<t>`, a contour is
   * memoised on that same key plus the levels and sigma, and a view instance
   * holds its last frame. Anything kept would be drawn under the new event's
   * label — a plausible-looking wrong figure.
   *
   * The run selection resets to the new event's first configuration, lowest
   * mode count and earliest start time, because the previous selection need not
   * exist there. Pins and zoom windows are cleared for the same reason.
   *
   * @param {string} key a registered site event key
   */
  async function applyEvent(key) {
    if (eventBusy || key === loader.event) return;
    eventBusy = true;
    try {
      el.status.textContent = `loading Tier 1 and Tier 3 for ${key} …`;
      await loader.switchEvent(key); // RAISES on an unregistered key (A4)
          await client.clearCache();
      instances.clear();
      const cfg = loader.configs()[0];
      const ns = loader.modeCounts(cfg);
      const ts = loader.startTimes(cfg, ns[0]);
      store.set({ ev: key, cfg, n: [ns[0]], t: [ts[0]], pins: [], z: {} });
      el.title.textContent = key;
    } catch (e) {
      el.status.textContent = `event ${key}: ${e.message}`;
      console.error(e);
      eventBusy = false;
      return;
    }
    eventBusy = false;
    rail.build();
    await draw();
  }

  /**
   * Fire the fetches the current view needs, and redraw when one lands. Errors
   * are swallowed per block: a missing Tier 4 file must not blank the page, and
   * the view already says in words when a block is absent.
   */
  function ensureData(st, series) {
    for (const s of series) {
      loader.prefetchNeighbours(s.cfg, s.n, s.t).catch(() => {});
    }
    const needT2 =
      st.view === "diagnostics" || ((st.view === "corner" || st.view === "fgamma") && st.scatter);
    if (needT2) {
      const wanted = st.view === "diagnostics" ? series.filter((s) => !s.isPin) : series;
      for (const s of wanted) {
        if (loader.tier2Cached(s.cfg, s.n, s.t) === undefined) {
          loader.tier2(s.cfg, s.n, s.t).then(() => draw()).catch(() => {});
        }
      }
    }
    // Tier 6 — the EM-cluster panel of the diagnostics view. Fetched for the
    // LIVE runs only, matching the Tier 2 rule above: the EM panel draws the
    // live selection, and a pin would add a block nothing on screen reads.
    //
    // THIS BRANCH IS WHAT MAKES THE PANEL POSSIBLE AT ALL. A view receives only
    // {state, loader, series, ctxOverride}: it has no store handle and no
    // redraw callback, so a fetch started inside the view could never request
    // the repaint that shows its result. `ensureData` is the sanctioned place,
    // and it redraws when the block lands.
    if (st.view === "diagnostics") {
      for (const s of series.filter((q) => !q.isPin)) {
        if (loader.tier6Cached(s.cfg, s.n, s.t) === undefined) {
          loader.tier6(s.cfg, s.n, s.t).then(() => draw()).catch((e) => {
            el.status.textContent = `Tier 6 ${runKey(s.cfg, s.n, s.t)}: ${e.message}`;
          });
        }
      }
    }
    if (st.view === "fitband") {
      for (const s of series) {
        if (loader.tier4Cached(s.cfg, s.n, s.t) === undefined) {
          loader.tier4(s.cfg, s.n, s.t).then(() => draw()).catch((e) => {
            el.status.textContent = `Tier 4 ${runKey(s.cfg, s.n, s.t)}: ${e.message}`;
          });
        }
      }
    }
    // The OPTIONAL prediction files of the 2026-09-18 campaign. They are
    // fetched only when the payload ADVERTISES them: an unadvertised file
    // answers 404, a 404 is a console message, and gate G-site's bar is zero
    // console messages. `hasExtra` reads the event block and RAISES on a
    // payload that has none, so the guard is inside a try.
    let hasKerr9 = false;
    let hasModeAssign = false;
    let hasAmpPhase = false;
    try {
      hasKerr9 = loader.hasExtra("kerr9");
      hasModeAssign = loader.hasExtra("mode_assign");
      hasAmpPhase = loader.hasExtra("amp_phase");
    } catch (e) {
      hasKerr9 = false;
      hasModeAssign = false;
      hasAmpPhase = false;
    }
    if (st.view === "fgamma" && hasKerr9 && loader.kerr9Cached() === undefined) {
      loader.kerr9().then(() => draw()).catch((e) => {
        el.status.textContent = `Kerr blobs: ${e.message}`;
      });
    }
    if (st.view === "modeassign" && hasModeAssign && loader.modeAssignCached() === undefined) {
      // The rail's assignment dropdowns are built FROM this file, so the rail
      // is synced before the redraw; otherwise the row stays empty until the
      // next state change.
      loader.modeAssign().then(() => {
        rail.sync();
        draw();
      }).catch((e) => {
        el.status.textContent = `mode assignment: ${e.message}`;
      });
    }
    // The "Amplitude and phase" view and the "Consistency" table read ONE file,
    // so the fetch is keyed on the pair of views and not on either of them. The
    // rail's amplitude/phase dropdowns are built FROM this file, so the rail is
    // synced before the redraw; otherwise the row stays empty until the next
    // state change.
    if (
      (st.view === "ampphase" || st.view === "consistency") &&
      hasAmpPhase &&
      loader.ampPhaseCached() === undefined
    ) {
      loader.ampPhase().then(() => {
        rail.sync();
        draw();
      }).catch((e) => {
        el.status.textContent = `amplitude/phase: ${e.message}`;
      });
    }
    if (st.view === "sky") {
      if (loader.tier5GridCached() === undefined) {
        loader.tier5Grid().then(() => draw()).catch((e) => {
          el.status.textContent = `Tier 5 grid: ${e.message}`;
        });
      }
      for (const s of series) {
        if (loader.tier5RunCached(s.cfg, s.n, s.t) === undefined) {
          loader.tier5Run(s.cfg, s.n, s.t).then(() => draw()).catch((e) => {
            el.status.textContent = `Tier 5 ${runKey(s.cfg, s.n, s.t)}: ${e.message}`;
          });
        }
      }
    }
  }

  async function draw() {
    // Nothing is drawable between `switchEvent` dropping the old payload and
    // the new one landing: the loader has no runs, no summary and no Tier 1.
    if (eventBusy) return;
    if (rendering) {
      dirty = true;
      return;
    }
    rendering = true;
    try {
      const st = store.state;
      const series = buildSeries(st);
      const view = viewFor(st.view);
      const ms = await view.render({ state: st, loader, series });
      if (ms !== null) {
        el.status.textContent =
          `${getView(st.view).label}: ${series.length} run(s), frame ${Number(ms).toFixed(1)} ms`;
      }
      ensureData(st, series);
    } catch (e) {
      el.status.textContent = `error: ${e.message}`;
      console.error(e);
    } finally {
      rendering = false;
      if (dirty) {
        dirty = false;
        requestAnimationFrame(() => draw());
      }
    }
  }

  /** Export the active view as a PNG, straight off the canvas. */
  async function exportPng() {
    const st = store.state;
    const name = exportName(st, "png");
    await new Promise((resolve) => {
      el.canvas.toBlob((blob) => {
        if (blob) download(blob, name);
        resolve();
      }, "image/png");
    });
    el.status.textContent = `exported ${name}`;
  }

  /**
   * Export the active view as an SVG, by re-drawing it into the SVG recorder.
   * The view's own drawing code runs unchanged, so the file matches the screen.
   */
  async function exportSvg() {
    const st = store.state;
    const w = el.canvas.clientWidth || 900;
    const h = el.canvas.clientHeight || 700;
    const surface = new SvgSurface(w, h, { background: "#ffffff" });
    const view = viewFor(st.view);
    await view.render({ state: st, loader, series: buildSeries(st), ctxOverride: surface });
    const name = exportName(st, "svg");
    download(new Blob([surface.toSVG()], { type: "image/svg+xml" }), name);
    el.status.textContent = `exported ${name} (${surface.elementCount} elements)`;
  }

  if (el.exportPng) el.exportPng.addEventListener("click", () => exportPng().catch((e) => {
    el.status.textContent = `PNG export failed: ${e.message}`;
  }));
  if (el.exportSvg) el.exportSvg.addEventListener("click", () => exportSvg().catch((e) => {
    el.status.textContent = `SVG export failed: ${e.message}`;
  }));

  // ONE path handles an event change, whoever asked for it: the rail's selector
  // and a hand-edited or back-button hash both land here, through the state.
  store.subscribe((st) => {
    if (st.ev !== loader.event) {
      applyEvent(st.ev).catch((e) => {
        el.status.textContent = `event ${st.ev}: ${e.message}`;
      });
      return;
    }
    draw();
  });
  window.addEventListener("hashchange", () => {
    const got = parseHash(window.location.hash, store.state);
    if (stateToHash(got.state) !== stateToHash(store.state)) store.set(got.state);
  });
  window.addEventListener("resize", () => draw());

  rail.sync();
  await draw();
  return {
    store,
    loader,
    rail,
    applyEvent,
    client,
    viewFor,
    exportPng,
    exportSvg,
    instances,
    detachInteractions,
  };
}

if (typeof window !== "undefined" && !window.__SILENCIO_NO_AUTOBOOT__) {
  window.addEventListener("DOMContentLoaded", () => {
    boot()
      .then((app) => {
        // Published for the gate scripts, which check the pixel/data round trip
        // of the axes a view actually drew. Reading them is the only way to
        // test the REAL axes rather than a re-implementation of them.
        window.__SILENCIO_APP__ = app;
      })
      .catch((e) => {
        const s = document.getElementById("status");
        if (s) s.textContent = `startup failed: ${e.message}`;
        console.error(e);
      });
  });
}
