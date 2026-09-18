/**
 * kerr.js — the Kerr quasinormal-mode predictions and the mode-identification
 * ranking metric of the f-gamma view.
 *
 * Part of the silencio interactive results application.
 *
 * WHAT THIS IS FOR. Spec section 6, view 2: the f-gamma plane shows the
 * ringdown posterior against the Kerr 220 and 221 predictions derived from the
 * IMR maximum-likelihood posterior, and ranks the sampler's modes by how close
 * they sit to the 220 prediction:
 *
 *     x = f / f_220
 *     y = (1/tau) / (1/tau_220)
 *     d = sqrt((x - 1)^2 + (y - 1)^2)          ascending
 *
 * A MISSING "2.2.0" RAISES. It is never defaulted, never substituted with
 * another mode and never silently skipped (pitfall A4). The whole metric is
 * defined relative to 220; without it there is no ranking, and a view that
 * quietly ranked by something else would be reporting a different quantity
 * under the same name.
 *
 * WHERE THE NUMBERS COME FROM, AND THE OPEN DEPENDENCY
 * ----------------------------------------------------
 * Server side, each run directory carries `imr_truth_blob.npz` with
 * `f_Hz (1999, n_modes)`, `inv_tau_Hz (1999, n_modes)` and
 * `mode_labels (n_modes,)` such as `["2.2.0", "2.2.1", "3.3.0"]`, plus
 * `final_mass` and `final_spin`. Those are 1999 draws of the IMR posterior.
 *
 * The BROWSER cannot read a run directory. As of 2026-09-15 no payload tier
 * carries these predictions: `summary.json` (Tier 3) has `per_mode`,
 * `max_rhat`, `min_ess`, `divergences`, `snr`, `mode_id_distance`,
 * `mode_id_distance_per_mode`, `status`, `title`, `A_true` and
 * `manifest_results`, and no `kerr` block (MEASURED on
 * `T2-data-tiers/data/probe_1unit_2026-09-16/GW250114/summary.json`).
 *
 * This module therefore defines the Tier 3 contract it needs and RAISES until
 * that contract is met, rather than inventing the numbers:
 *
 *     summary.runs["<config>/<n>_<t>"].kerr = {
 *       "2.2.0": {"f": <Hz>, "inv_tau": <1/s>},
 *       "2.2.1": {"f": <Hz>, "inv_tau": <1/s>},   // absent for 1-mode runs
 *       ...
 *     }
 *
 * taken at the IMR MAXIMUM-LIKELIHOOD sample, not the posterior median, because
 * spec section 6 says "from the IMR max-L posterior" and a median of a ratio is
 * not the ratio of medians.
 *
 * NOTE on 1-mode runs: `n1_t0Mf` has `mode_labels == ["2.2.0"]` only, so
 * "2.2.1" is legitimately absent there (MEASURED). `2.2.0` is present in every
 * run of the campaign, so the ranking metric is always computable and only the
 * 221 marker is sometimes missing. An absent 221 is drawn as nothing; an absent
 * 220 raises.
 *
 * CONVENTIONS (pitfall A1): `f` in Hz. The damping variable is the RATE
 * `gamma = 1/tau` in 1/s, which is what the sampler samples and what the prior
 * box is on; `inv_tau` in the payload is that same rate. Mode indices in the
 * posterior are sampler EM-classified indices, are NOT QNM labels, and are
 * never ordered by amplitude (`A_true` is nan on real data) — which is exactly
 * why this distance ranking exists.
 */

/** The reference QNM label. Value: "2.2.0". Its absence RAISES. */
export const KERR_REF_LABEL = "2.2.0";

/** The first overtone label. Value: "2.2.1". May be absent on 1-mode runs. */
export const KERR_OVERTONE_LABEL = "2.2.1";

/** Labels the f-gamma view draws as predictions, in draw order. */
export const KERR_DRAW_LABELS = Object.freeze([KERR_REF_LABEL, KERR_OVERTONE_LABEL]);

/**
 * The Kerr predictions of one run, from its Tier 3 summary record.
 *
 * @param {Object} record a `summary.runs["<config>/<n>_<t>"]` entry
 * @param {string} [runKeyForMessage] used only to make the error legible
 * @returns {Object<string, {f: number, invTau: number}>}
 * @throws when the `kerr` block or the "2.2.0" entry is absent (A4)
 */
export function kerrPredictions(record, runKeyForMessage = "<unknown run>") {
  if (record === undefined || record === null) {
    throw new Error(
      `kerr.kerrPredictions: no Tier 3 summary record for ${runKeyForMessage}`
    );
  }
  const raw = record.kerr;
  if (raw === undefined || raw === null) {
    throw new Error(
      `kerr.kerrPredictions: Tier 3 record for ${runKeyForMessage} has no "kerr" ` +
        `block, so the ${KERR_REF_LABEL} prediction is unavailable and the ` +
        `f-gamma ranking metric x = f/f_220, y = (1/tau)/(1/tau_220) cannot be ` +
        `computed. The payload must carry ` +
        `summary.runs[key].kerr = {"${KERR_REF_LABEL}": {"f": Hz, "inv_tau": 1/s}, ...} ` +
        `at the IMR max-likelihood sample (source: imr_truth_blob.npz, keys ` +
        `f_Hz / inv_tau_Hz / mode_labels). This is not defaulted on purpose.`
    );
  }
  const out = {};
  for (const [label, v] of Object.entries(raw)) {
    const f = Number(v?.f);
    const invTau = Number(v?.inv_tau ?? v?.invTau);
    if (!Number.isFinite(f) || !Number.isFinite(invTau)) {
      throw new Error(
        `kerr.kerrPredictions: ${runKeyForMessage} label "${label}" has ` +
          `non-finite f=${v?.f} or inv_tau=${v?.inv_tau}`
      );
    }
    if (!(f > 0) || !(invTau > 0)) {
      throw new Error(
        `kerr.kerrPredictions: ${runKeyForMessage} label "${label}" has ` +
          `non-physical f=${f} Hz or inv_tau=${invTau} 1/s; both must be > 0 ` +
          `because the ranking metric divides by them`
      );
    }
    out[label] = { f, invTau };
  }
  if (out[KERR_REF_LABEL] === undefined) {
    throw new Error(
      `kerr.kerrPredictions: ${runKeyForMessage} has no "${KERR_REF_LABEL}" ` +
        `prediction (present: ${Object.keys(out).join(", ") || "none"}). ` +
        `The ranking metric is defined relative to ${KERR_REF_LABEL}, so this ` +
        `RAISES rather than falling back to another mode.`
    );
  }
  return out;
}

/**
 * The mode-identification distance of one posterior mode from the 220 prediction.
 *
 * `d = sqrt((f/f_220 - 1)^2 + ((1/tau)/(1/tau_220) - 1)^2)`, spec section 6.
 *
 * @param {number} f mode frequency in Hz
 * @param {number} invTau mode damping rate gamma = 1/tau in 1/s
 * @param {{f: number, invTau: number}} ref the 220 prediction
 * @returns {{x: number, y: number, d: number}}
 */
export function modeDistance(f, invTau, ref) {
  if (!(ref?.f > 0) || !(ref?.invTau > 0)) {
    throw new Error(
      `kerr.modeDistance: reference prediction must have f > 0 and invTau > 0, ` +
        `got f=${ref?.f}, invTau=${ref?.invTau}`
    );
  }
  const x = f / ref.f;
  const y = invTau / ref.invTau;
  return { x, y, d: Math.hypot(x - 1, y - 1) };
}

/**
 * Rank a run's modes by distance from the 220 prediction, ASCENDING.
 *
 * The mode index is the tie-break, so the order is total and reproducible.
 * Nothing is ranked by amplitude: `A_true` is nan on real data.
 *
 * @param {number[]} f per-mode frequency in Hz, index = sampler EM mode index
 * @param {number[]} invTau per-mode gamma = 1/tau in 1/s
 * @param {Object<string, {f: number, invTau: number}>} predictions
 * @returns {{mode: number, x: number, y: number, d: number}[]}
 */
export function rankModes(f, invTau, predictions) {
  const ref = predictions[KERR_REF_LABEL];
  if (ref === undefined) {
    throw new Error(
      `kerr.rankModes: predictions have no "${KERR_REF_LABEL}" entry ` +
        `(present: ${Object.keys(predictions).join(", ") || "none"})`
    );
  }
  if (f.length !== invTau.length) {
    throw new Error(
      `kerr.rankModes: f has ${f.length} modes but invTau has ${invTau.length}`
    );
  }
  const rows = [];
  for (let m = 0; m < f.length; m++) {
    const { x, y, d } = modeDistance(f[m], invTau[m], ref);
    rows.push({ mode: m, x, y, d });
  }
  rows.sort((a, b) => a.d - b.d || a.mode - b.mode);
  return rows;
}
