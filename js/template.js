/**
 * template.js — the ringdown template, ported to the browser.
 *
 * Part of the silencio interactive results application.
 *
 * THIS IS A PORT OF `src/silencio/signal/templates.py` lines 11-88
 * (`basis_templates_single` and `generate_signal_single_detector`). Gate G8
 * holds it to < 1e-5 relative against the Python original on real samples.
 *
 * The formulas, transcribed from that source:
 *
 *   e1_j(t) = exp(-t/tau_j) * cos(2*pi*f_j*t)
 *   e2_j(t) = exp(-t/tau_j) * sin(2*pi*f_j*t)
 *
 *   coeff_e1_j = (cR_j + cL_j)*F+  -  (sR_j + sL_j)*Fx
 *   coeff_e2_j = (cR_j - cL_j)*Fx  +  (sR_j - sL_j)*F+
 *
 *   h(t) = sum_j  coeff_e1_j * e1_j(t)  +  coeff_e2_j * e2_j(t)
 *
 * CONVENTIONS (pitfall A1, stated here because this is where the port meets
 * its Python original):
 *   * `f` is in Hz. `tau` is a damping time in SECONDS. The sampled variable
 *     and the prior box are the RATE `gamma = 1/tau` in 1/s; this function
 *     takes tau, exactly as the Python original does.
 *   * `times` is in SECONDS from the start of the analysis window, i.e.
 *     `t = arange(M)/sample_rate`, and t >= 0.
 *   * Cartesian amplitudes are ordered `[cR, sR, cL, sL]` per mode, the
 *     sampler's own ordering, flattened as
 *     `[cR_0, sR_0, cL_0, sL_0, cR_1, ...]`.
 *   * `fp` (F+) and `fc` (Fx) are the antenna-pattern scalars for ONE
 *     detector at ONE sky point. They are dimensionless.
 *   * The returned `h` is an UNWHITENED strain time series. The site's
 *     Tier 4 band lives in whitened space and is precomputed; this port is
 *     used for the unwhitened overlay and for gate G8 (spec section 4).
 *   * Mode indices are sampler EM-classified indices. They are not QNM
 *     labels and they are never ordered by amplitude (`A_true` is nan on
 *     real data).
 *
 * Everything here is float64: JavaScript numbers are IEEE-754 doubles, and
 * the gate's Python side sets `jax_enable_x64` so both sides agree.
 */

/** Cartesian amplitude components per mode, in file order. Value: 4. */
export const N_CARTESIAN_PER_MODE = 4;

/** Two basis templates per mode: e1 (cosine) and e2 (sine). Value: 2. */
export const N_BASIS = 2;

/**
 * Basis templates for one mode, `templates.py:11-30`.
 *
 * @param {number} f frequency in Hz
 * @param {number} tau damping time in seconds
 * @param {ArrayLike<number>} times time array in seconds, t >= 0
 * @param {Float64Array} [e1Out] optional output buffer, length times.length
 * @param {Float64Array} [e2Out] optional output buffer, length times.length
 * @returns {{e1: Float64Array, e2: Float64Array}}
 */
export function basisTemplatesSingle(f, tau, times, e1Out, e2Out) {
  const M = times.length;
  const e1 = e1Out ?? new Float64Array(M);
  const e2 = e2Out ?? new Float64Array(M);
  if (e1.length !== M || e2.length !== M) {
    throw new Error(
      `template.basisTemplatesSingle: output buffers must have length ${M}`
    );
  }
  const omega = 2.0 * Math.PI * f;
  for (let i = 0; i < M; i++) {
    const t = times[i];
    const decay = Math.exp(-t / tau);
    e1[i] = decay * Math.cos(omega * t);
    e2[i] = decay * Math.sin(omega * t);
  }
  return { e1, e2 };
}

/**
 * The full single-detector signal, `templates.py:37-88`.
 *
 * Grouped by basis template exactly as the Python original groups it, so the
 * two sides perform the same arithmetic in the same order:
 *
 *   h = sum_j e1_j * [(cR_j + cL_j)*F+ - (sR_j + sL_j)*Fx]
 *     + sum_j e2_j * [(cR_j - cL_j)*Fx + (sR_j - sL_j)*F+]
 *
 * @param {ArrayLike<number>} x Cartesian amplitudes, length 4*N, ordered
 *   [cR_0, sR_0, cL_0, sL_0, cR_1, ...]
 * @param {ArrayLike<number>} f frequencies in Hz, length N
 * @param {ArrayLike<number>} tau damping times in seconds, length N
 * @param {ArrayLike<number>} times time array in seconds, length M
 * @param {number} fp F+ antenna pattern scalar
 * @param {number} fc Fx antenna pattern scalar
 * @returns {Float64Array} h(t), length M, unwhitened strain
 */
export function generateSignalSingleDetector(x, f, tau, times, fp, fc) {
  const nModes = f.length;
  if (tau.length !== nModes) {
    throw new Error(
      `template.generateSignalSingleDetector: f has ${nModes} modes but tau has ${tau.length}`
    );
  }
  // A4: the Cartesian block size is declared above and asserted here, at use.
  if (x.length !== N_CARTESIAN_PER_MODE * nModes) {
    throw new Error(
      `template.generateSignalSingleDetector: x has length ${x.length}, ` +
        `expected ${N_CARTESIAN_PER_MODE} * ${nModes} = ${N_CARTESIAN_PER_MODE * nModes}`
    );
  }
  if (!Number.isFinite(fp) || !Number.isFinite(fc)) {
    throw new Error(
      `template.generateSignalSingleDetector: non-finite antenna patterns fp=${fp}, fc=${fc}`
    );
  }

  const M = times.length;
  const h = new Float64Array(M);
  const e1 = new Float64Array(M);
  const e2 = new Float64Array(M);

  for (let j = 0; j < nModes; j++) {
    const o = j * N_CARTESIAN_PER_MODE;
    const cR = x[o];
    const sR = x[o + 1];
    const cL = x[o + 2];
    const sL = x[o + 3];

    // templates.py:83-84, transcribed literally.
    const coeffE1 = (cR + cL) * fp - (sR + sL) * fc;
    const coeffE2 = (cR - cL) * fc + (sR - sL) * fp;

    basisTemplatesSingle(f[j], tau[j], times, e1, e2);
    for (let i = 0; i < M; i++) {
      h[i] += coeffE1 * e1[i] + coeffE2 * e2[i];
    }
  }
  return h;
}

/**
 * Uniform time axis in seconds, `t = arange(M)/sampleRate`.
 *
 * This is the axis `plot_whitened_fit_band` uses (`times = np.arange(M) /
 * sample_rate`), and the axis the Tier 4 payload's arrays are sampled on.
 *
 * @param {number} M number of samples
 * @param {number} sampleRate in Hz
 * @returns {Float64Array}
 */
export function timeAxis(M, sampleRate) {
  if (!(sampleRate > 0)) {
    throw new Error(`template.timeAxis: sampleRate must be > 0, got ${sampleRate}`);
  }
  const t = new Float64Array(M);
  for (let i = 0; i < M; i++) t[i] = i / sampleRate;
  return t;
}
