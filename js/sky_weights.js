/**
 * sky_weights.js — Tier 5 readers and the visit-count weighting of the sky view.
 *
 * Part of the silencio interactive results application.
 *
 * Tier 5 is two kinds of file, both in the standard container defined by
 * `src/silencio/site/data/pack.py` (magic "SGK1"):
 *
 *   kind "grid" — the EVENT-level IMR sky posterior, once for the whole event:
 *       float32 ra[n] then float32 dec[n], in radians.
 *   kind "run"  — one run's `samples_omega_idx` as uint16, plus
 *       `chain_boundaries` in the header.
 *
 * Because the grid is shared and only the indices change, moving the
 * start-time slider re-weights the SAME points and needs no fetch (spec
 * section 4, Tier 5).
 *
 * THE WEIGHTING, AND WHY IT IS DEFINED THIS WAY
 * ---------------------------------------------
 * `plot_sky_posterior_compare` (`pe_diagnostics.py:1756-1872`) renders the
 * ringdown sky posterior as the IMR samples weighted by Metropolis-Hastings
 * visit counts:
 *
 *     counts     = bincount(concat(samples_omega_idx_c), minlength=K)
 *     visited    = counts > 0
 *     log_counts = log1p(counts[visited])
 *     sizes      = 4 + 12 * log_counts / max(log_counts.max(), 1e-9)
 *
 * Marker size and marker colour are both monotone in `counts`, so what a
 * reader takes off the figure is the ORDER of the points by visit count.
 * Gate G9 part 2 holds this module to that ordering, exactly, on 5 runs.
 *
 * CONVENTIONS (pitfall A1):
 *   * `ra`, `dec` in radians. `samples_omega_idx` are INDICES into the sky
 *     bank (range [0, K-1]), not angles.
 *   * The COLD block only. The chain count comes from `chain_boundaries`,
 *     never from an array's length.
 *   * Nothing is ranked by amplitude: `A_true` is nan on real data.
 */

/** Magic bytes of a Tier 5 sky file. Value: "SGK1". Mirrors pack.py. */
export const MAGIC_TIER5 = "SGK1";

/** Marker-size floor of the published figure. Value: 4. */
export const SIZE_BASE = 4;

/** Marker-size span of the published figure. Value: 12. */
export const SIZE_SPAN = 12;

/** Guard against a zero maximum in the size normalisation. Value: 1e-9. */
export const SIZE_EPS = 1e-9;

function readContainer(buffer, expectedMagic) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== expectedMagic) {
    throw new Error(`sky_weights: bad magic "${magic}", expected "${expectedMagic}"`);
  }
  const headerLen = new DataView(buffer).getUint32(4, true);
  const json = new TextDecoder("utf-8").decode(new Uint8Array(buffer, 8, headerLen));
  return { header: JSON.parse(json), dataOffset: 8 + headerLen };
}

/**
 * Parse a Tier 5 file of either kind.
 * @param {ArrayBuffer} buffer
 * @returns {Object} for kind "grid": {header, kind, n, ra, dec};
 *                   for kind "run":  {header, kind, n, omegaIdx, nChains, chainBoundaries}
 */
export function parseTier5(buffer) {
  const { header, dataOffset } = readContainer(buffer, MAGIC_TIER5);
  const n = header.n;

  if (header.kind === "grid") {
    // A Float32Array view needs 4-byte alignment; copy when the JSON header
    // length leaves the payload unaligned.
    const need = 4 * n;
    const slice = (off) =>
      off % 4 === 0
        ? new Float32Array(buffer, off, n)
        : new Float32Array(buffer.slice(off, off + need));
    return {
      header,
      kind: "grid",
      n,
      ra: slice(dataOffset),
      dec: slice(dataOffset + need),
    };
  }

  if (header.kind === "run") {
    const need = 2 * n;
    const off = dataOffset;
    const omegaIdx =
      off % 2 === 0
        ? new Uint16Array(buffer, off, n)
        : new Uint16Array(buffer.slice(off, off + need));
    const cb = header.chain_boundaries;
    if (!Array.isArray(cb) || cb.length < 2 || cb[cb.length - 1] !== n) {
      throw new Error(
        `sky_weights.parseTier5: chain_boundaries ${JSON.stringify(cb)} do not end at n=${n}`
      );
    }
    return {
      header,
      kind: "run",
      n,
      omegaIdx,
      /** Number of COLD chains. Never infer this from an array's length. */
      nChains: cb.length - 1,
      chainBoundaries: cb,
    };
  }

  throw new Error(`sky_weights.parseTier5: unknown kind "${header.kind}"`);
}

/**
 * Visit counts per sky point, `bincount(omega_idx, minlength=K)`.
 *
 * @param {ArrayLike<number>} omegaIdx visit indices into the sky bank
 * @param {number} K sky-bank size
 * @returns {Int32Array} length K
 */
export function visitCounts(omegaIdx, K) {
  if (!(K > 0)) throw new Error(`sky_weights.visitCounts: K must be > 0, got ${K}`);
  const counts = new Int32Array(K);
  for (let i = 0; i < omegaIdx.length; i++) {
    const k = omegaIdx[i];
    if (k < 0 || k >= K) {
      throw new Error(
        `sky_weights.visitCounts: index ${k} at position ${i} is outside the ` +
          `sky bank of ${K} points`
      );
    }
    counts[k] += 1;
  }
  return counts;
}

/**
 * Point indices sorted by (visit count, point index) ascending — a TOTAL order.
 *
 * The point index is the tie-break. Most points are visited 0 or 1 times, so
 * ties dominate, and a bare sort by count alone is not reproducible across
 * implementations. Gate G9 part 2 compares this array element for element
 * against the Python reference.
 *
 * @param {ArrayLike<number>} counts
 * @returns {Int32Array}
 */
export function countOrdering(counts) {
  const K = counts.length;
  const order = new Int32Array(K);
  for (let i = 0; i < K; i++) order[i] = i;
  // Array.prototype.sort on a TypedArray sorts numerically in place; the
  // comparator makes the (count, index) order explicit rather than relying on
  // any stability guarantee.
  const arr = Array.from(order);
  arr.sort((a, b) => (counts[a] - counts[b]) || (a - b));
  for (let i = 0; i < K; i++) order[i] = arr[i];
  return order;
}

/**
 * Marker sizes of the published figure, for the visited points only.
 *
 * `sizes = 4 + 12 * log1p(counts) / max(log1p(counts).max(), 1e-9)`, matching
 * `pe_diagnostics.py:1838-1845`.
 *
 * @param {ArrayLike<number>} counts
 * @returns {{indices: Int32Array, logCounts: Float64Array, sizes: Float64Array}}
 */
export function visitedMarkers(counts) {
  const K = counts.length;
  let nVis = 0;
  for (let i = 0; i < K; i++) if (counts[i] > 0) nVis++;
  const indices = new Int32Array(nVis);
  const logCounts = new Float64Array(nVis);
  let w = 0;
  let maxLog = 0;
  for (let i = 0; i < K; i++) {
    if (counts[i] > 0) {
      const lc = Math.log1p(counts[i]);
      indices[w] = i;
      logCounts[w] = lc;
      if (lc > maxLog) maxLog = lc;
      w++;
    }
  }
  const denom = Math.max(maxLog, SIZE_EPS);
  const sizes = new Float64Array(nVis);
  for (let i = 0; i < nVis; i++) {
    sizes[i] = SIZE_BASE + (SIZE_SPAN * logCounts[i]) / denom;
  }
  return { indices, logCounts, sizes };
}
