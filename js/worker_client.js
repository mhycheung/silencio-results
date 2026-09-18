/**
 * worker_client.js — promise wrapper around the contouring worker, with
 * supersede-by-tag so that a slider drag never queues stale frames.
 *
 * Ruling 2: dragging the slider must already change the plot. The failure mode
 * this class exists to prevent is a backlog — one contour request per pointer
 * move, each drawn in turn, so the plot lags the handle by the whole queue.
 * `requestLatest(tag, ...)` keeps only the newest request per tag; superseded
 * requests resolve to `null` and their callers draw nothing.
 */

export class ContourClient {
  /**
   * @param {string} [workerUrl] module URL of contour_worker.js
   */
  constructor(workerUrl = new URL("./contour_worker.js", import.meta.url)) {
    this._worker = new Worker(workerUrl, { type: "module" });
    this._nextId = 1;
    this._pending = new Map(); // id -> {resolve, reject}
    this._newestByTag = new Map(); // tag -> id
    this._worker.onmessage = (ev) => this._onMessage(ev.data);
    this._worker.onerror = (e) => {
      for (const { reject } of this._pending.values()) reject(new Error(`contour worker: ${e.message}`));
      this._pending.clear();
    };
  }

  _onMessage(msg) {
    const p = this._pending.get(msg.id);
    if (p === undefined) return;
    this._pending.delete(msg.id);
    if (msg.type === "error") p.reject(new Error(msg.error));
    else p.resolve(msg);
  }

  _send(payload, transfer) {
    const id = this._nextId++;
    const promise = new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
    this._worker.postMessage({ ...payload, id }, transfer || []);
    return { id, promise };
  }

  /** Round-trip check that the worker started. Resolves to the latency in ms. */
  async ping() {
    const t0 = performance.now();
    const { promise } = this._send({ type: "ping" });
    await promise;
    return performance.now() - t0;
  }

  /**
   * Contour a batch of grids. One message per frame, not one per panel.
   *
   * `sigma` is the smoothing width in BINS (request 3, the smoothing slider).
   * Leaving it `undefined` keeps the worker's own default,
   * `config.CONTOUR_SMOOTH_SIGMA` (`contour_worker.js:72`), so every existing
   * two-argument caller behaves exactly as before.
   *
   * @param {Object[]} grids each {key, counts, nx, ny, xmin, xmax, ymin, ymax}
   * @param {number[]} levels credible fractions in (0, 1)
   * @param {number} [sigma] smoothing width in bins
   * @returns {Promise<Object[]>} results array, same order as `grids`
   */
  async contour(grids, levels, sigma) {
    const { promise } = this._send({ type: "contour", grids, levels, sigma });
    return (await promise).results;
  }

  /**
   * Contour, superseding any earlier in-flight request with the same tag.
   *
   * `sigma` is already part of the worker's memo key (`contour_worker.js:75`),
   * so moving the smoothing slider re-uses every cached grid at the sigma it
   * lands on rather than invalidating the cache.
   *
   * @param {string} tag
   * @param {Object[]} grids
   * @param {number[]} levels credible fractions in (0, 1)
   * @param {number} [sigma] smoothing width in bins
   * @returns {Promise<Object[]|null>} null if a newer request superseded this one
   */
  async contourLatest(tag, grids, levels, sigma) {
    const { id, promise } = this._send({ type: "contour", grids, levels, sigma });
    this._newestByTag.set(tag, id);
    const msg = await promise;
    if (this._newestByTag.get(tag) !== id) return null;
    return msg.results;
  }

  /**
   * Drop the worker's memo cache.
   *
   * REQUIRED ON AN EVENT CHANGE. The memo key is `<grid key>|<levels>|<sigma>`
   * and a grid key is `<cfg>/<n>_<t>/<mode>/<px>/<py>` — no event in it — so a
   * surviving entry would draw the previous event's contour under the new
   * event's label.
   *
   * @returns {Promise<number>} how many entries were dropped
   */
  async clearCache() {
    const { promise } = this._send({ type: "clearCache" });
    return (await promise).n;
  }

  terminate() {
    this._worker.terminate();
    this._pending.clear();
  }
}
