/**
 * tier4.js — the Tier 4 fit-band reader (magic "SGB1").
 *
 * Part of the silencio interactive results application.
 *
 * THE FORMAT IS FIXED BY `src/silencio/site/data/pack.py` (task T2), function
 * `write_tier4`, NOT by `payload_format.py`, which has no Tier 4. This reader
 * was written against a real file produced by that writer; the header fields
 * below are the ones MEASURED in
 * `T2-data-tiers/data/probe_1unit_2026-09-16/GW250114/band/prod_0p3s/2_9.bin`.
 *
 * Container (shared with Tier 1, 2 and 5):
 *   bytes 0..3    ASCII magic "SGB1"
 *   bytes 4..7    uint32 little-endian header length H
 *   bytes 8..8+H  UTF-8 JSON header
 *   then          the payload at the offsets the header gives
 *
 * Header:
 *   {"magic":"SGB1","config":str,"n_modes":int,"t_start":int,
 *    "detectors":["H1","L1"],"M":4915,"levels":[50,90,99],"dtype":"int16",
 *    "arrays":{"<det>":{"<name>":{"offset":int,"n":int,"scale":float}}},
 *    "pad":int,"shift_min":{det:int},"shift_max":{det:int},
 *    "idx_start":{det:int},"window_start_gps":float,"injection_gps":float,
 *    "trigger_gps":float,"n_draw":100,"band_rng_seed":12345,
 *    "sample_rate":16384.0,"analysis_duration_s":0.3,
 *    "whitened_rms":{det:float},"provenance":{...}}
 *
 * Array names per detector: "strain", "median", and "lo_<L>"/"hi_<L>" for each
 * L in `levels`.
 *
 * QUANTISATION. Every array is int16 with its OWN positive scale; the physical
 * value is `stored * scale` (pack.quantise_int16). The scale is chosen so the
 * peak magnitude maps to 32767, so the relative quantisation error is about
 * 3e-5 of that array's peak. That is far below the 1% of gate G8 part 2 and is
 * invisible at plot resolution, but it is a lossy store and this is where that
 * is written down.
 *
 * CONVENTIONS (pitfall A1):
 *   * The band and the strain live in WHITENED space, in units of sigma. They
 *     are dimensionless; `whitened_rms` near 1 is the sanity check.
 *   * The time axis is `t = arange(M)/sample_rate` SECONDS from the window
 *     start, and the window start is `t_start` in `M_rem` from the IMR
 *     maximum-likelihood peak GPS.
 *   * The stored M samples are the CENTRAL slice `[pad, pad+pad+M)` of the
 *     padded projection grid, so the stored axis is exactly the data's axis.
 *   * The band is a POSTERIOR band over `n_draw` draws at `band_rng_seed`, not
 *     a confidence interval on the data.
 */

import { CREDIBLE_LEVELS } from "./config.js";

/** Magic bytes of a Tier 4 fit-band file. Value: "SGB1". Mirrors pack.py. */
export const MAGIC_TIER4 = "SGB1";

/** Arrays present for every detector, besides the per-level band edges. */
export const BASE_ARRAYS = Object.freeze(["strain", "median"]);

function readContainer(buffer, expectedMagic) {
  const bytes = new Uint8Array(buffer);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== expectedMagic) {
    throw new Error(`tier4: bad magic "${magic}", expected "${expectedMagic}"`);
  }
  const headerLen = new DataView(buffer).getUint32(4, true);
  const json = new TextDecoder("utf-8").decode(new Uint8Array(buffer, 8, headerLen));
  return { header: JSON.parse(json), dataOffset: 8 + headerLen };
}

/**
 * Parse a Tier 4 fit-band file, dequantising every array to Float64Array.
 *
 * @param {ArrayBuffer} buffer
 * @returns {{header: Object, config: string, n_modes: number, t_start: number,
 *            M: number, detectors: string[], levels: number[],
 *            sampleRate: number, times: Float64Array,
 *            arrays: Object<string, Object<string, Float64Array>>}}
 */
export function parseTier4(buffer) {
  const { header, dataOffset } = readContainer(buffer, MAGIC_TIER4);

  const M = header.M;
  if (!Number.isInteger(M) || M <= 0) {
    throw new Error(`tier4.parseTier4: header M=${JSON.stringify(M)} is not a positive integer`);
  }
  const levels = header.levels;
  if (!Array.isArray(levels) || levels.length === 0) {
    throw new Error(`tier4.parseTier4: header levels=${JSON.stringify(levels)} is empty`);
  }
  // A4: the level set is declared in config.js and asserted here, at use. A
  // payload built with a different set must fail loudly, because the control
  // rail offers exactly these three and a mismatch would silently mislabel a
  // band.
  for (const L of levels) {
    if (!CREDIBLE_LEVELS.includes(L)) {
      throw new Error(
        `tier4.parseTier4: payload level ${L} is not in config.CREDIBLE_LEVELS ` +
          `[${CREDIBLE_LEVELS.join(", ")}]`
      );
    }
  }
  if (header.dtype !== "int16") {
    throw new Error(`tier4.parseTier4: unsupported dtype "${header.dtype}", expected "int16"`);
  }
  const detectors = header.detectors;
  if (!Array.isArray(detectors) || detectors.length === 0) {
    throw new Error(`tier4.parseTier4: header detectors=${JSON.stringify(detectors)} is empty`);
  }

  const wanted = [...BASE_ARRAYS];
  for (const L of levels) wanted.push(`lo_${L}`, `hi_${L}`);

  const arrays = {};
  for (const det of detectors) {
    const per = header.arrays?.[det];
    if (per === undefined) {
      throw new Error(
        `tier4.parseTier4: header lists detector "${det}" but has no arrays for it`
      );
    }
    const out = {};
    for (const name of wanted) {
      const meta = per[name];
      if (meta === undefined) {
        throw new Error(
          `tier4.parseTier4: detector "${det}" is missing array "${name}" ` +
            `(present: ${Object.keys(per).join(", ")})`
        );
      }
      if (meta.n !== M) {
        throw new Error(
          `tier4.parseTier4: ${det}/${name} has n=${meta.n} but the header says M=${M}`
        );
      }
      if (!(meta.scale > 0)) {
        throw new Error(`tier4.parseTier4: ${det}/${name} has non-positive scale ${meta.scale}`);
      }
      const off = dataOffset + meta.offset;
      // An Int16Array view needs 2-byte alignment; copy when the JSON header
      // length leaves the payload unaligned.
      const stored =
        off % 2 === 0
          ? new Int16Array(buffer, off, M)
          : new Int16Array(buffer.slice(off, off + 2 * M));
      const v = new Float64Array(M);
      const s = meta.scale;
      for (let i = 0; i < M; i++) v[i] = stored[i] * s;
      out[name] = v;
    }
    // `band_valid[det] = [lo, hi)`: the stored columns where the posterior band
    // is defined. Outside it no draw covers the column (every draw's sky shift
    // has one sign), the file holds 0, and the band is left BLANK: its arrays
    // become NaN here, which fillBand/strokeSeries skip. The strain is kept.
    // Absent key = the whole window is valid (every payload before 2026-09-18).
    const valid = header.band_valid?.[det];
    if (valid !== undefined) {
      const [lo, hi] = valid;
      if (!(Number.isInteger(lo) && Number.isInteger(hi) && 0 <= lo && lo < hi && hi <= M)) {
        throw new Error(
          `tier4.parseTier4: ${det} band_valid=${JSON.stringify(valid)} is not [lo, hi) inside M=${M}`
        );
      }
      for (const name of wanted) {
        if (name === "strain") continue;
        out[name].fill(NaN, 0, lo);
        out[name].fill(NaN, hi, M);
      }
    }
    arrays[det] = out;
  }

  const sampleRate = header.sample_rate;
  if (!(sampleRate > 0)) {
    throw new Error(
      `tier4.parseTier4: header sample_rate=${JSON.stringify(sampleRate)} is not positive`
    );
  }
  const times = new Float64Array(M);
  for (let i = 0; i < M; i++) times[i] = i / sampleRate;

  return {
    header,
    config: header.config,
    n_modes: header.n_modes,
    t_start: header.t_start,
    M,
    detectors: [...detectors],
    levels: [...levels],
    sampleRate,
    /** Seconds from the analysis-window start. */
    times,
    arrays,
  };
}

/**
 * The band-edge array names for one credible level.
 *
 * RAISES when the level is absent from this payload (A4): the fit-band view is
 * limited to the precomputed levels, and a silent fallback to a different level
 * would draw a band the label does not describe.
 *
 * @param {Object} t4 result of parseTier4
 * @param {number} level percent
 * @returns {{lo: string, hi: string}}
 */
export function bandKeys(t4, level) {
  if (!t4.levels.includes(level)) {
    throw new Error(
      `tier4.bandKeys: level ${level}% is not precomputed in this payload. ` +
        `Available: ${t4.levels.join(", ")}. Tier 4 bands cannot be recomputed ` +
        `in the browser (the whitening does not factor through the per-sample ` +
        `parameters), so there is no fallback.`
    );
  }
  return { lo: `lo_${level}`, hi: `hi_${level}` };
}

/**
 * Time axis in MILLISECONDS, which is what the published fit-band figure uses.
 * @param {Object} t4
 * @returns {Float64Array}
 */
export function timesMs(t4) {
  const out = new Float64Array(t4.M);
  for (let i = 0; i < t4.M; i++) out[i] = t4.times[i] * 1e3;
  return out;
}
