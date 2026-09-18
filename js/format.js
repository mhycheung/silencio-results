/**
 * format.js — readers for the binary payload tiers.
 *
 * THE BINARY LAYOUT IS FIXED HERE AND IN THE MATCHING PYTHON WRITER
 * (the matching Python payload-format writer in the silencio repository).
 * Task T2 writes the real payload; it must produce exactly this layout.
 *
 * Common container, both tiers:
 *   bytes 0..3    ASCII magic ("SGR1" for Tier 1 grids, "SGS1" for Tier 2 samples)
 *   bytes 4..7    uint32 little-endian header length H
 *   bytes 8..8+H  UTF-8 JSON header (provenance + index)
 *   then          the raw payload, little-endian, at the offsets the header gives
 *
 * Every numeric field is little-endian. Provenance (D1) lives in the JSON
 * header under "provenance": {script, source_run, silencio_version, thinning,
 * seed, build_date}.
 *
 * TIER 1 — grids. Header:
 *   {"magic":"SGR1","bins":64,"event":"GW250114","provenance":{...},
 *    "entries":[{"key":"<config>/<n>_<t>/m<mode>/<px>-<py>",
 *                "config":..., "n_modes":int, "t_start":int, "mode":int,
 *                "px":str, "py":str, "offset":int, "nx":64, "ny":64,
 *                "xmin":f, "xmax":f, "ymin":f, "ymax":f}, ...]}
 *   Payload: for each entry, nx*ny uint8 values, C order, index = iy*nx + ix.
 *   `ix` runs along the FIRST-named parameter `px`, `iy` along `py`. Bins are
 *   uniform, so [xmin, xmax] and nx give the edges; no edge array is stored.
 *   Counts are the 2D histogram rescaled so that max = 255 (uint8).
 *
 * TIER 2 — samples. Header:
 *   {"magic":"SGS1","config":str,"n_modes":int,"t_start":int,
 *    "n_samples":2000,"columns":["f","tau","cR","sR","cL","sL"],
 *    "chain_boundaries":[0,500,1000,1500,2000],
 *    "has_em_labels":bool,"provenance":{...}}
 *   Payload: float32 array of shape (n_samples, n_modes, 6) in C order,
 *   then, if has_em_labels, uint8 array of shape (n_samples, n_modes).
 *
 *   TRAP: the posterior is the COLD block only. `samples.h5` reports
 *   n_chains = 4 while several of its arrays are 8 deep (4 hot chains). The
 *   chain count comes from `chain_boundaries`, NEVER from an array's shape.
 */

import {
  GRID_BINS,
  MAGIC_TIER1,
  MAGIC_TIER2,
  MAGIC_TIER6,
  TIER2_COLUMNS,
  TIER6_N_KEEP,
  getParam,
} from "./config.js";
import { cartesianToPhysicalScalar } from "./physical.js";

function readContainer(buffer, expectedMagic) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== expectedMagic) {
    throw new Error(`format: bad magic "${magic}", expected "${expectedMagic}"`);
  }
  const headerLen = new DataView(buffer).getUint32(4, true);
  const json = new TextDecoder("utf-8").decode(new Uint8Array(buffer, 8, headerLen));
  return { header: JSON.parse(json), dataOffset: 8 + headerLen };
}

/**
 * Parse a Tier 1 grid file.
 * @param {ArrayBuffer} buffer
 * @returns {{header: Object, grids: Map<string, Object>}}
 */
export function parseTier1(buffer) {
  const { header, dataOffset } = readContainer(buffer, MAGIC_TIER1);
  // A4: the resolution is declared in config.js and asserted here, at use.
  if (header.bins !== GRID_BINS) {
    throw new Error(
      `format.parseTier1: payload bins=${header.bins} but config.GRID_BINS=${GRID_BINS}`
    );
  }
  const grids = new Map();
  for (const e of header.entries) {
    if (e.nx !== GRID_BINS || e.ny !== GRID_BINS) {
      throw new Error(`format.parseTier1: entry ${e.key} has nx=${e.nx}, ny=${e.ny}`);
    }
    grids.set(e.key, {
      key: e.key,
      config: e.config,
      n_modes: e.n_modes,
      t_start: e.t_start,
      mode: e.mode,
      px: e.px,
      py: e.py,
      nx: e.nx,
      ny: e.ny,
      // The DEFAULT VIEW WINDOW (request 7), not a clip: the stored grid still
      // spans [xmin, xmax] x [ymin, ymax] and keeps all its mass. For every
      // parameter except `A` the bulk range IS the full sample min/max, so
      // nothing but the amplitude panels opens zoomed.
      xbulk_lo: e.xbulk_lo,
      xbulk_hi: e.xbulk_hi,
      ybulk_lo: e.ybulk_lo,
      ybulk_hi: e.ybulk_hi,
      xmin: e.xmin,
      xmax: e.xmax,
      ymin: e.ymin,
      ymax: e.ymax,
      counts: new Uint8Array(buffer, dataOffset + e.offset, e.nx * e.ny),
    });
  }
  return { header, grids };
}

/** Canonical Tier 1 key for one (run, mode, parameter pair). */
export function gridKey(config, nModes, tStart, mode, px, py) {
  return `${config}/${nModes}_${tStart}/m${mode}/${px}-${py}`;
}

/**
 * Parse a Tier 2 sample file.
 * @param {ArrayBuffer} buffer
 */
export function parseTier2(buffer) {
  const { header, dataOffset } = readContainer(buffer, MAGIC_TIER2);
  // A4: the column set is declared in config.js and asserted here.
  const cols = header.columns;
  if (cols.length !== TIER2_COLUMNS.length || cols.some((c, i) => c !== TIER2_COLUMNS[i])) {
    throw new Error(
      `format.parseTier2: columns ${cols.join(",")} != config.TIER2_COLUMNS ${TIER2_COLUMNS.join(",")}`
    );
  }
  const nSamples = header.n_samples;
  const nModes = header.n_modes;
  const nCol = cols.length;
  const nFloat = nSamples * nModes * nCol;
  // A Float32Array view needs 4-byte alignment; copy when the header length
  // leaves the payload unaligned.
  const off = dataOffset;
  const data =
    off % 4 === 0
      ? new Float32Array(buffer, off, nFloat)
      : new Float32Array(buffer.slice(off, off + 4 * nFloat));
  let emLabels = null;
  if (header.has_em_labels) {
    emLabels = new Uint8Array(buffer, off + 4 * nFloat, nSamples * nModes);
  }
  const cb = header.chain_boundaries;
  if (!Array.isArray(cb) || cb.length < 2 || cb[cb.length - 1] !== nSamples) {
    throw new Error(
      `format.parseTier2: chain_boundaries ${JSON.stringify(cb)} do not end at n_samples=${nSamples}`
    );
  }
  return {
    header,
    config: header.config,
    n_modes: nModes,
    t_start: header.t_start,
    nSamples,
    columns: cols,
    /** Number of COLD chains. Never infer this from an array's first axis. */
    nChains: cb.length - 1,
    chainBoundaries: cb,
    data,
    emLabels,
  };
}

/**
 * Extract one parameter for one mode from a Tier 2 block, as Float64Array of
 * length nSamples. Handles stored columns, closed-form functions of a stored
 * column, and the four parameters derived through physical.js.
 *
 * @param {Object} t2 result of parseTier2
 * @param {string} paramKey registered key in config.PARAM_REGISTRY
 * @param {number} mode 0-based mode index (sampler EM index, not a QNM label)
 */
export function tier2Param(t2, paramKey, mode) {
  const p = getParam(paramKey); // RAISES on an unregistered key
  const { data, nSamples, n_modes: nModes, columns } = t2;
  if (mode < 0 || mode >= nModes) {
    throw new Error(`format.tier2Param: mode ${mode} out of range (n_modes=${nModes})`);
  }
  const nCol = columns.length;
  const stride = nModes * nCol;
  const base = mode * nCol;
  const out = new Float64Array(nSamples);

  if (p.source === "t2" || p.source === "t2fn") {
    const ci = columns.indexOf(p.column);
    if (ci < 0) throw new Error(`format.tier2Param: column "${p.column}" absent`);
    const fn = p.source === "t2fn" ? p.fn : null;
    for (let i = 0; i < nSamples; i++) {
      const v = data[i * stride + base + ci];
      out[i] = fn ? fn(v) : v;
    }
    return out;
  }

  // derived: [cR, sR, cL, sL] -> {A_R, A_L, A, epsilon, phi, theta}
  const iCR = columns.indexOf("cR");
  const iSR = columns.indexOf("sR");
  const iCL = columns.indexOf("cL");
  const iSL = columns.indexOf("sL");
  for (let i = 0; i < nSamples; i++) {
    const o = i * stride + base;
    const phys = cartesianToPhysicalScalar(data[o + iCR], data[o + iSR], data[o + iCL], data[o + iSL]);
    out[i] = phys[p.field];
  }
  return out;
}

/*
 * TIER 6 — the EM-cluster-during-sampling diagnostic (magic "SGE1").
 * ------------------------------------------------------------------
 * Written by `silencio/site/data/emdiag.py`; this is its mirror reader.
 *
 * Header:
 *   {"magic":"SGE1","config":str,"n_modes":int,"t_start":int,
 *    "n_cold":int,"n_sweeps":int,"burn_in_sweeps":int,"n_keep":400,
 *    "scatter_stride":int,"n_snapshots":int,"n_div":int,
 *    "f_range":[lo,hi],"gamma_range":[lo,hi],"kerr_labels":[str],
 *    "cov_entries":["xx","xy","yy"],
 *    "arrays":{"<name>":{"offset":int,"n":int,"shape":[int],
 *                        "dtype":"int16"|"uint8"|"uint32"|"float32",
 *                        "scale":float}},
 *    "provenance":{...},"conventions":str}
 *
 * Payload: each array contiguous at `dataOffset + offset`, C order. The writer
 * pads the JSON header so `dataOffset` is a multiple of 4 and orders the arrays
 * widest-first, so every view is aligned and zero-copy. This reader still falls
 * back to a copy on a misaligned offset rather than throwing, because an
 * alignment assumption that fails should cost a memcpy, not the panel.
 *
 * CONVENTIONS (pitfall A1, restated where the two sides meet):
 *   * `f` is in Hz. The second coordinate is the damping RATE
 *     `gamma = 1/tau` in 1/s, stored DIRECTLY — Tier 6 does not store tau.
 *   * Covariances are the 2x2 (f, gamma) sub-block, stored as the three unique
 *     entries [xx, xy, yy]; rebuild as [[xx, xy], [xy, yy]].
 *   * `int16` arrays are quantised: the physical value is `stored * scale`,
 *     the SAME rule Tier 4 uses.
 *   * THE 4-VS-8 CHAIN TRAP. `samples.h5` reports n_chains = 4 while its EM
 *     arrays are 8 deep (4 cold + 4 hot). Tier 6 ships the COLD block only and
 *     records `n_cold` in the header. THE CHAIN COUNT COMES FROM THAT HEADER
 *     FIELD, never from an array's first axis.
 *   * Scatter point `i` of a chain is sweep `i * scatter_stride`, and the
 *     colour scale runs 0 .. n_sweeps — the FULL history INCLUDING warmup.
 *     Tier 2 keeps post-burn-in draws only; Tier 6 deliberately does not.
 */

/** Typed-array constructor and byte width per Tier 6 dtype. Mirrors emdiag._NP. */
const T6_DTYPE = Object.freeze({
  int16: { ctor: Int16Array, width: 2 },
  uint8: { ctor: Uint8Array, width: 1 },
  uint32: { ctor: Uint32Array, width: 4 },
  float32: { ctor: Float32Array, width: 4 },
});

/** Arrays without which the EM-cluster panel cannot be drawn. Absence RAISES
 *  (A4) rather than leaving the panel to skip a piece of itself in silence. */
export const TIER6_ARRAYS = Object.freeze([
  "scatter_f", "scatter_g", "em_sweep_nums", "em_means", "em_covs",
  "em_ref_means", "em_ref_covs", "cur_means", "cur_covs",
  "hyper_ref_means", "hyper_ref_covs", "em_match_perm", "hyper_perms",
  "ref_to_inj", "div_sweep", "div_f", "div_g", "div_chain", "div_mode",
]);

/** Read one Tier 6 array as a plain JS-friendly typed array.
 *  `int16` and `float32` come back as Float64Array (int16 dequantised by its
 *  scale); the index arrays keep their integer type. */
function readT6Array(buffer, dataOffset, name, meta) {
  const spec = T6_DTYPE[meta.dtype];
  if (spec === undefined) {
    throw new Error(
      `format.parseTier6: array "${name}" has unsupported dtype "${meta.dtype}". ` +
        `Supported: ${Object.keys(T6_DTYPE).join(", ")}`
    );
  }
  const off = dataOffset + meta.offset;
  const raw =
    off % spec.width === 0
      ? new spec.ctor(buffer, off, meta.n)
      : new spec.ctor(buffer.slice(off, off + spec.width * meta.n));
  if (meta.dtype === "int16") {
    if (!(meta.scale > 0)) {
      throw new Error(
        `format.parseTier6: array "${name}" has non-positive scale ${meta.scale}; ` +
          `an int16 payload is stored as value = stored * scale`
      );
    }
    const out = new Float64Array(meta.n);
    for (let i = 0; i < meta.n; i++) out[i] = raw[i] * meta.scale;
    return out;
  }
  if (meta.dtype === "float32") {
    const out = new Float64Array(meta.n);
    for (let i = 0; i < meta.n; i++) out[i] = raw[i];
    return out;
  }
  return raw;
}

/**
 * Parse a Tier 6 EM-diagnostic file.
 *
 * Every array's stored `shape` is checked against the header scalars, so a
 * block built for a different chain, mode or snapshot count fails here instead
 * of being indexed with the wrong stride and drawing another chain's ellipse
 * under this chain's label.
 *
 * @param {ArrayBuffer} buffer
 */
export function parseTier6(buffer) {
  const { header, dataOffset } = readContainer(buffer, MAGIC_TIER6);
  // A4: the thinning is declared in config.js and asserted here, at use.
  if (header.n_keep !== TIER6_N_KEEP) {
    throw new Error(
      `format.parseTier6: payload n_keep=${header.n_keep} but ` +
        `config.TIER6_N_KEEP=${TIER6_N_KEEP}`
    );
  }
  const C = header.n_cold;
  const K = header.n_modes;
  const N = header.n_keep;
  const S = header.n_snapshots;
  const D = header.n_div;
  for (const [field, v] of [
    ["n_cold", C], ["n_modes", K], ["n_keep", N], ["n_snapshots", S],
    ["n_div", D], ["n_sweeps", header.n_sweeps],
    ["scatter_stride", header.scatter_stride],
  ]) {
    if (!Number.isInteger(v) || v < 0) {
      throw new Error(`format.parseTier6: header ${field}=${JSON.stringify(v)} is not a count`);
    }
  }
  if (S < 1) {
    throw new Error(
      `format.parseTier6: n_snapshots=${S}. The CURRENT EM state is the LAST ` +
        `snapshot, so a block with no snapshot has no current cluster to draw.`
    );
  }
  const expect = {
    scatter_f: [C, N, K], scatter_g: [C, N, K],
    em_sweep_nums: [S],
    em_means: [S, C, K, 2], em_covs: [S, C, K, 3],
    em_ref_means: [S, K, 2], em_ref_covs: [S, K, 3],
    cur_means: [C, K, 2], cur_covs: [C, K, 3],
    hyper_ref_means: [K, 2], hyper_ref_covs: [K, 3],
    em_match_perm: [S, C, K], hyper_perms: [C, K], ref_to_inj: [K],
    div_sweep: [D], div_f: [D], div_g: [D], div_chain: [D], div_mode: [D],
  };
  const arrays = {};
  const shapes = {};
  for (const name of TIER6_ARRAYS) {
    const meta = header.arrays?.[name];
    if (meta === undefined) {
      throw new Error(
        `format.parseTier6: array "${name}" is absent. Present: ` +
          `${Object.keys(header.arrays ?? {}).join(", ")}`
      );
    }
    const want = expect[name];
    const got = meta.shape;
    if (!Array.isArray(got) || got.length !== want.length || got.some((d, i) => d !== want[i])) {
      throw new Error(
        `format.parseTier6: array "${name}" has shape [${got}] but the header ` +
          `scalars require [${want}]`
      );
    }
    arrays[name] = readT6Array(buffer, dataOffset, name, meta);
    shapes[name] = [...want];
  }
  // `cov_entries` fixes how the three stored numbers rebuild a 2x2 (A4). A
  // payload that reordered them would draw a valid-looking but wrong ellipse.
  const ce = header.cov_entries;
  if (!Array.isArray(ce) || ce.length !== 3 || ce[0] !== "xx" || ce[1] !== "xy" || ce[2] !== "yy") {
    throw new Error(
      `format.parseTier6: cov_entries ${JSON.stringify(ce)} is not ["xx","xy","yy"], ` +
        `so [[xx,xy],[xy,yy]] would rebuild the wrong matrix`
    );
  }
  return {
    header,
    config: header.config,
    n_modes: K,
    t_start: header.t_start,
    /** COLD chain count, from the HEADER — never from an array's first axis. */
    nCold: C,
    nKeep: N,
    nSnapshots: S,
    nDiv: D,
    /** Total sweeps INCLUDING warmup. This is the colour-axis maximum. */
    nSweeps: header.n_sweeps,
    burnIn: header.burn_in_sweeps,
    /** Scatter point `i` of a chain is sweep `i * scatterStride`. */
    scatterStride: header.scatter_stride,
    fRange: header.f_range,
    gammaRange: header.gamma_range,
    kerrLabels: header.kerr_labels,
    arrays,
    shapes,
  };
}

/** Flat C-order element index of scatter point `i` of mode `k` in cold chain `c`. */
export function t6ScatterIndex(t6, c, i, k) {
  return (c * t6.nKeep + i) * t6.n_modes + k;
}

/**
 * The 2x2 (f, gamma) covariance stored at triplet index `j` of array `name`.
 * @returns {number[][]} [[xx, xy], [xy, yy]]
 */
export function t6Cov(t6, name, j) {
  const a = t6.arrays[name];
  if (a === undefined) throw new Error(`format.t6Cov: no Tier 6 array "${name}"`);
  const o = 3 * j;
  return [
    [a[o], a[o + 1]],
    [a[o + 1], a[o + 2]],
  ];
}

/** The (f, gamma) mean stored at pair index `j` of array `name`. */
export function t6Mean(t6, name, j) {
  const a = t6.arrays[name];
  if (a === undefined) throw new Error(`format.t6Mean: no Tier 6 array "${name}"`);
  return [a[2 * j], a[2 * j + 1]];
}

/** Chain index of sample i, from `chainBoundaries` (never from a shape). */
export function chainOfSample(t2, i) {
  const cb = t2.chainBoundaries;
  for (let c = 0; c < cb.length - 1; c++) {
    if (i >= cb[c] && i < cb[c + 1]) return c;
  }
  throw new Error(`format.chainOfSample: sample ${i} outside chain boundaries`);
}
