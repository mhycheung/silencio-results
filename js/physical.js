/**
 * physical.js — Cartesian -> physical amplitude parameters, in the browser.
 *
 * Direct port of `silencio.diagnostics.physical._cartesian_to_physical_core`
 * (`src/silencio/diagnostics/physical.py:37-77`, read 2026-09-15).
 *
 * CONVENTIONS (pitfall A1 — stated where the comparison happens):
 *   - Input order per mode is [cR, sR, cL, sL], exactly the sampler's Cartesian
 *     ordering and exactly the column order of a Tier 2 `.f32` payload block.
 *   - z_R = cR + i sR, z_L = cL + i sL  (the SAME sign on both imaginary parts).
 *   - A       = |z_R| + |z_L|                      (strain amplitude, arbitrary units)
 *   - epsilon = (|z_L| - |z_R|) / A                (ellipticity, dimensionless, [-1, 1])
 *   - theta   = arg(z_L z_R) / 2 folded to [0, pi) (polarisation angle, radians)
 *   - phi     = (phi_s + delta) mod 2pi in [0, 2pi) (GW reference phase, radians)
 *     with phi_s = wrap_pi(arg(z_L) - theta) and delta = atan2(sin theta, eps cos theta).
 *
 * TRAP that this port exists to avoid: JavaScript `%` is a REMAINDER, not a
 * modulo. `(-0.1) % (2*Math.PI)` is -0.1 in JS but +6.183 in Python. Every
 * wrap below therefore goes through `pyMod` / `wrapPi`, never through `%`.
 *
 * TRAP: `theta` uses the branch that puts the discontinuity at theta = pi/2,
 * not at 0/pi. Reproducing the naive `% (2pi) / 2` would give a different,
 * bimodal answer near the boundaries. See the Python docstring at
 * physical.py:55-60.
 *
 * Verified by gate G2 (< 1e-5 relative on 2000 real samples), with a
 * sign-flipped negative control that must FAIL the same bar. Gate script:
 * the G2 physical-port check script in the silencio repository.
 */

const TWO_PI = 2 * Math.PI;

/** Python-style modulo: result carries the sign of `m`, so it is >= 0 for m > 0. */
export function pyMod(x, m) {
  const r = x % m;
  return r !== 0 && r < 0 !== m < 0 ? r + m : r;
}

/** Wrap an angle to (-pi, pi], matching `(x + pi) % (2pi) - pi` in Python. */
export function wrapPi(x) {
  return pyMod(x + Math.PI, TWO_PI) - Math.PI;
}

/**
 * Scalar conversion. Returns {A_R, A_L, A, epsilon, phi, theta}.
 *
 * @param {number} cR
 * @param {number} sR
 * @param {number} cL
 * @param {number} sL
 */
export function cartesianToPhysicalScalar(cR, sR, cL, sL) {
  const A_R = Math.hypot(cR, sR);
  const A_L = Math.hypot(cL, sL);
  const A = A_R + A_L;
  // jnp.where(A > 0, (A_L - A_R) / A, 0.0)
  const epsilon = A > 0 ? (A_L - A_R) / A : 0.0;

  // arg(z_L * z_R): (cL + i sL)(cR + i sR) = (cL cR - sL sR) + i (cL sR + sL cR)
  const prodRe = cL * cR - sL * sR;
  const prodIm = cL * sR + sL * cR;
  const argProduct = Math.atan2(prodIm, prodRe); // (-pi, pi]
  const theta =
    argProduct >= 0 ? argProduct / 2.0 : argProduct / 2.0 + Math.PI;

  const alphaL = Math.atan2(sL, cL);
  const phiS = wrapPi(alphaL - theta);

  const delta = Math.atan2(Math.sin(theta), epsilon * Math.cos(theta));
  const phi = pyMod(phiS + delta, TWO_PI);

  return { A_R, A_L, A, epsilon, phi, theta };
}

/** The six derived field names, in the order this module emits them. */
export const PHYSICAL_FIELDS = ["A_R", "A_L", "A", "epsilon", "phi", "theta"];

/**
 * Batch conversion over a flat Float32Array/Float64Array laid out as
 * `(nSamples, nModes, 4)` in C order, i.e. the Cartesian block of a Tier 2 file.
 *
 * @param {Float32Array|Float64Array} flat  length nSamples*nModes*4
 * @param {number} nSamples
 * @param {number} nModes
 * @returns {Object<string, Float64Array>} each of length nSamples*nModes,
 *          C-ordered (sample-major).
 */
export function cartesianToPhysicalBatch(flat, nSamples, nModes) {
  const n = nSamples * nModes;
  const out = {};
  for (const k of PHYSICAL_FIELDS) out[k] = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const b = 4 * i;
    const p = cartesianToPhysicalScalar(flat[b], flat[b + 1], flat[b + 2], flat[b + 3]);
    for (const k of PHYSICAL_FIELDS) out[k][i] = p[k];
  }
  return out;
}

/**
 * Forward map, port of `physical_to_cartesian` (physical.py:143-175).
 * Present so a round-trip can be checked without leaving the browser.
 */
export function physicalToCartesian(A, epsilon, phi, theta) {
  const delta = Math.atan2(Math.sin(theta), epsilon * Math.cos(theta));
  const phiS = phi - delta;
  const A_R = (A * (1.0 - epsilon)) / 2.0;
  const A_L = (A * (1.0 + epsilon)) / 2.0;
  const alphaR = theta - phiS;
  const alphaL = theta + phiS;
  return [
    A_R * Math.cos(alphaR),
    A_R * Math.sin(alphaR),
    A_L * Math.cos(alphaL),
    A_L * Math.sin(alphaL),
  ];
}
