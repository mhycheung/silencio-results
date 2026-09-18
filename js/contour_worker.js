/**
 * contour_worker.js — the Web Worker that owns ALL contouring.
 *
 * Why a worker (ruling 2, the point of the campaign): the start-time slider
 * must redraw while it is being dragged. Marching squares over every panel of
 * a corner plot must therefore never run on the main thread, where it would
 * block the drag itself.
 *
 * Load it as a MODULE worker:
 *     new Worker("./js/contour_worker.js", { type: "module" })
 *
 * Protocol
 *   in : {id, type:"contour", grids:[{key, counts:Uint8Array, nx, ny,
 *         xmin, xmax, ymin, ymax}], levels:[0.5, 0.9]}
 *   out: {id, type:"contour", results:[{key, levels:[{level, threshold,
 *         polylines:[Float64Array]}]}]}
 *   in : {id, type:"ping"}  ->  out: {id, type:"pong"}
 *   in : {id, type:"clearCache"}  ->  out: {id, type:"cacheCleared", n}
 *
 * THE MEMO CACHE IS WHAT MAKES THE DRAG CHEAP. Contours are a pure function of
 * (Tier 1 grid, credible level), and a Tier 1 grid never changes once it is
 * loaded. During a slider drag only the LIVE run's grids are new; every pinned
 * run's grids repeat unchanged on every frame. Caching by
 * `key | level | sigma` therefore turns a 6-overlay frame from 108 fresh
 * grids into 18. MEASURED in Node, 2026-09-15, 64x64 grids, one level:
 * 108 grids 79.6 ms, 18 grids 13.4 ms.
 *
 * Because results are cached they are structure-cloned back, NOT transferred:
 * a transferred buffer is detached and could not be served again.
 */

import { contourGrid } from "./contour_core.js";
import { CONTOUR_SMOOTH_SIGMA } from "./config.js";

/** Maximum memoised (grid, level) contour sets. Value: 4096. */
const CACHE_MAX = 4096;

const cache = new Map(); // "key|level|sigma" -> levels array

function cacheGet(k) {
  const v = cache.get(k);
  if (v !== undefined) {
    // Refresh the LRU position.
    cache.delete(k);
    cache.set(k, v);
  }
  return v;
}

function cacheSet(k, v) {
  cache.set(k, v);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "ping") {
    self.postMessage({ id: msg.id, type: "pong" });
    return;
  }
  if (msg.type === "clearCache") {
    const n = cache.size;
    cache.clear();
    self.postMessage({ id: msg.id, type: "cacheCleared", n });
    return;
  }
  if (msg.type !== "contour") {
    self.postMessage({ id: msg.id, type: "error", error: `unknown message type "${msg.type}"` });
    return;
  }
  try {
    const sigma = msg.sigma ?? CONTOUR_SMOOTH_SIGMA;
    let hits = 0;
    const results = msg.grids.map((g) => {
      const ck = `${g.key}|${msg.levels.join(",")}|${sigma}`;
      let levels = cacheGet(ck);
      if (levels === undefined) {
        levels = contourGrid(g, msg.levels, sigma);
        cacheSet(ck, levels);
      } else {
        hits++;
      }
      return { key: g.key, levels };
    });
    self.postMessage({ id: msg.id, type: "contour", results, cacheHits: hits, cacheSize: cache.size });
  } catch (e) {
    self.postMessage({ id: msg.id, type: "error", error: String(e && e.stack ? e.stack : e) });
  }
};
