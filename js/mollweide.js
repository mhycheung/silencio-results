/**
 * mollweide.js — the Mollweide map projection, for the sky view.
 *
 * Part of the silencio interactive results application.
 *
 * CONVENTIONS (pitfall A1, stated here because this is where the browser
 * projection meets matplotlib's):
 *   * `lambda` is a longitude in RADIANS on [-pi, pi]. Right ascension is
 *     wrapped into that range first, exactly as
 *     `plot_sky_posterior_compare` wraps it:
 *     `ra_p = where(ra > pi, ra - 2*pi, ra)`.
 *   * `phi` is a latitude (declination) in RADIANS on [-pi/2, pi/2].
 *   * The output (x, y) is in matplotlib's Mollweide axes coordinates, where
 *     the full map spans x in [-2*sqrt(2), 2*sqrt(2)] and y in
 *     [-sqrt(2), sqrt(2)]. It is NOT normalised to [-1, 1].
 *
 * THE CLOSED FORM (spec section 4, Tier 5):
 *
 *   x = 2*sqrt(2) * lambda * cos(aux) / pi
 *   y = sqrt(2) * sin(aux)
 *
 * where the auxiliary angle `aux` solves
 *
 *   2*aux + sin(2*aux) = pi * sin(phi)
 *
 * TWO SOLVERS, AND WHY BOTH EXIST
 * -------------------------------
 * Gate G9 requires this projection to match matplotlib's to < 1e-6, because
 * the site replaces a published matplotlib figure and must not move a point
 * on the sky. But matplotlib does NOT solve that equation to machine
 * precision, and it does not solve it in `aux`.
 *
 * MEASURED 2026-09-15 on the 5 000-point GW250114 sky bank: matplotlib's
 * projection differs from a machine-precision solve of the same equation by
 * up to 9.94e-4, a thousand times the gate's own bar. The two are genuinely
 * different numbers, so "the correct Mollweide" and "what the published
 * figure drew" are not interchangeable here.
 *
 * `mollweideMatplotlib` therefore reproduces matplotlib's algorithm exactly,
 * transcribed from the installed source
 * (`matplotlib/projections/geo.py`, `MollweideTransform.transform_non_affine`,
 * matplotlib 3.10.8):
 *
 *     def d(theta):
 *         delta = -(theta + sin(theta) - pi_sin_l) / (1 + cos(theta))
 *         return delta, abs(delta) > 0.001
 *
 *     clat  = pi/2 - abs(latitude)
 *     ihigh = clat < 0.087          # within 5 degrees of a pole
 *     ilow  = ~ihigh
 *
 *     # low branch: Newton-Raphson in theta, where aux = theta/2
 *     pi_sin_l = pi * sin(latitude[ilow])
 *     theta = 2.0 * latitude[ilow]
 *     delta, large_delta = d(theta)
 *     while any(large_delta):
 *         theta[large_delta] += delta[large_delta]      # MASKED update
 *         delta, large_delta = d(theta)
 *     aux[ilow] = theta / 2
 *
 *     # high branch: Taylor approximation, no iteration at all
 *     e = clat[ihigh]
 *     d = 0.5 * (3 * pi * e**2) ** (1/3)
 *     aux[ihigh] = (pi/2 - d) * sign(latitude[ihigh])
 *
 * Three details of that algorithm decide whether a port matches, and each one
 * was got wrong by an obvious-looking implementation before it was measured:
 *
 *   1. The iteration variable is `theta = 2*aux`, NOT `aux`. The tolerance
 *      `0.001` is therefore a tolerance on `theta`, i.e. 5e-4 in `aux`. A port
 *      that tests `0.001` against an `aux`-space step is twice as strict, takes
 *      an extra Newton step on some points, and lands CLOSER to the true root
 *      than matplotlib — which is a mismatch, because matplotlib is the
 *      reference. MEASURED: that error alone was 1.46e-3.
 *   2. The update is MASKED: only the points whose own step is still large are
 *      advanced. Each point therefore stops independently, and a point's
 *      answer does not depend on the batch it was transformed in.
 *   3. Latitudes within 5 degrees of a pole never enter Newton at all. There
 *      is no latitude clamping in this version of matplotlib; the pole branch
 *      replaces it.
 *
 * `mollweideExact` solves the same equation to machine precision. It is the
 * mathematically correct Mollweide projection, kept because it is the honest
 * definition and because gate G9 reports both. It is NOT what the sky view
 * uses.
 */

/** Newton stopping tolerance of matplotlib's MollweideTransform. Value: 0.001.
 *
 *  This is a tolerance on matplotlib's iteration variable `theta = 2*aux`, so
 *  it is 5e-4 in the auxiliary angle. Source: matplotlib/projections/geo.py,
 *  `MollweideTransform.transform_non_affine`, `np.abs(delta) > 0.001`.
 *  Asserted at use in `auxAngleMatplotlib`. */
export const MPL_NEWTON_TOL = 0.001;

/** Colatitude below which matplotlib skips Newton for a Taylor branch.
 *  Value: 0.087 radians (~5 degrees). Source: same function,
 *  `ihigh = clat < 0.087`. */
export const MPL_POLE_CLAT = 0.087;

/** Iteration cap. Value: 100. Newton is quadratic on this equation, so both
 *  solvers converge in single-digit iterations; the cap only bounds a
 *  pathological input rather than shaping the answer. */
export const MAX_ITER = 100;

/** Convergence threshold of the EXACT solver, in radians. Value: 1e-15. */
export const EXACT_TOL = 1e-15;

/** Latitude clamp used by the EXACT solver only. Value: 1e-9 radians.
 *  The Newton denominator vanishes at the poles, so the exact solver clamps.
 *  matplotlib 3.10.8 does not clamp; it branches (see MPL_POLE_CLAT). */
export const EXACT_LAT_CLAMP = 1e-9;

const SQRT2 = Math.SQRT2;
const TWO_SQRT2_OVER_PI = (2.0 * Math.SQRT2) / Math.PI;

/**
 * Wrap a right ascension into [-pi, pi], as `plot_sky_posterior_compare` does.
 *
 * Source: `pe_diagnostics.py:1820-1823`,
 * `wrap(r) = np.where(r > np.pi, r - 2*np.pi, r)`. Note this is NOT a general
 * modulo: it maps (pi, 2pi] to (-pi, 0] and leaves everything else alone,
 * which is correct for an RA already on [0, 2pi).
 *
 * @param {number} ra right ascension in radians
 * @returns {number} longitude in radians
 */
export function wrapRa(ra) {
  return ra > Math.PI ? ra - 2.0 * Math.PI : ra;
}

/**
 * Auxiliary angle, reproducing matplotlib's algorithm exactly.
 *
 * Transcribed from `MollweideTransform.transform_non_affine`; see the module
 * docstring for the source and for the three details that decide a match.
 *
 * @param {number} phi latitude in radians
 * @returns {number} the auxiliary angle `aux` in radians
 */
export function auxAngleMatplotlib(phi) {
  const clat = Math.PI / 2 - Math.abs(phi);

  // High branch: within MPL_POLE_CLAT of a pole, matplotlib uses a Taylor
  // approximation and never iterates.
  if (clat < MPL_POLE_CLAT) {
    const e = clat;
    const d = 0.5 * Math.pow(3 * Math.PI * e * e, 1.0 / 3.0);
    return (Math.PI / 2 - d) * Math.sign(phi);
  }

  // Low branch: Newton-Raphson in theta = 2*aux.
  const piSinL = Math.PI * Math.sin(phi);
  let theta = 2.0 * phi;
  let delta = -(theta + Math.sin(theta) - piSinL) / (1 + Math.cos(theta));
  let guard = 0;
  // A4: the tolerance is declared above and applied here, in matplotlib's own
  // iteration variable, not in `aux`.
  while (Math.abs(delta) > MPL_NEWTON_TOL) {
    theta += delta;
    delta = -(theta + Math.sin(theta) - piSinL) / (1 + Math.cos(theta));
    if (++guard > MAX_ITER) break;
  }
  return theta / 2.0;
}

/**
 * Auxiliary angle, solved to machine precision.
 *
 * Solves `2*aux + sin(2*aux) = pi*sin(phi)` by Newton, iterated to
 * convergence. This is the mathematically correct Mollweide auxiliary angle
 * and is NOT what matplotlib returns.
 *
 * @param {number} phi latitude in radians
 * @returns {number} aux in radians
 */
export function auxAngleExact(phi) {
  const lat = Math.min(
    Math.max(phi, -Math.PI / 2 + EXACT_LAT_CLAMP),
    Math.PI / 2 - EXACT_LAT_CLAMP
  );
  const sinPhi = Math.sin(lat);
  let aux = lat;
  for (let k = 0; k < MAX_ITER; k++) {
    const delta =
      (Math.PI * sinPhi - 2.0 * aux - Math.sin(2.0 * aux)) /
      (2.0 + 2.0 * Math.cos(2.0 * aux));
    aux += delta;
    if (Math.abs(delta) < EXACT_TOL) break;
  }
  return aux;
}

/** Project from an auxiliary angle. Shared by both solvers. */
function project(lambda, aux) {
  return {
    x: TWO_SQRT2_OVER_PI * lambda * Math.cos(aux),
    y: SQRT2 * Math.sin(aux),
  };
}

/**
 * Mollweide projection, reproducing matplotlib. THIS is what the sky view uses.
 * @param {number} lambda longitude in radians on [-pi, pi]
 * @param {number} phi latitude in radians on [-pi/2, pi/2]
 * @returns {{x: number, y: number}}
 */
export function mollweideMatplotlib(lambda, phi) {
  return project(lambda, auxAngleMatplotlib(phi));
}

/**
 * Mollweide projection, solved to machine precision. Not used by the view.
 * @param {number} lambda longitude in radians on [-pi, pi]
 * @param {number} phi latitude in radians on [-pi/2, pi/2]
 * @returns {{x: number, y: number}}
 */
export function mollweideExact(lambda, phi) {
  return project(lambda, auxAngleExact(phi));
}

/**
 * Registry of the available solvers. RAISES on an unregistered name (A4) —
 * no nearest match, no silent default.
 */
const SOLVERS = Object.freeze({
  matplotlib: mollweideMatplotlib,
  exact: mollweideExact,
});

export const SOLVER_KEYS = Object.freeze(Object.keys(SOLVERS));

/**
 * The solver the sky view uses. Value: "matplotlib".
 *
 * Chosen because the site replaces a published matplotlib figure and gate G9
 * measures agreement with THAT figure, not with the ideal projection. The
 * ideal projection is off by up to 9.94e-4 from what was published.
 */
export const VIEW_SOLVER = "matplotlib";

/** @param {string} key */
export function getSolver(key) {
  const s = SOLVERS[key];
  if (s === undefined) {
    throw new Error(
      `mollweide.getSolver: unregistered solver "${key}". Registered: ${SOLVER_KEYS.join(", ")}`
    );
  }
  return s;
}

/**
 * Project many points at once, into interleaved [x0, y0, x1, y1, ...].
 *
 * @param {ArrayLike<number>} ra right ascensions in radians (wrapped here)
 * @param {ArrayLike<number>} dec declinations in radians
 * @param {string} [solver] registered solver key
 * @returns {Float64Array} length 2*n
 */
export function projectMany(ra, dec, solver = VIEW_SOLVER) {
  const fn = getSolver(solver); // RAISES on an unregistered key
  const n = ra.length;
  if (dec.length !== n) {
    throw new Error(`mollweide.projectMany: ra has ${n} points, dec has ${dec.length}`);
  }
  const out = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const p = fn(wrapRa(ra[i]), dec[i]);
    out[2 * i] = p.x;
    out[2 * i + 1] = p.y;
  }
  return out;
}

/** Half-width of the full Mollweide map in x. Value: 2*sqrt(2). */
export const X_HALF_WIDTH = 2.0 * Math.SQRT2;

/** Half-height of the full Mollweide map in y. Value: sqrt(2). */
export const Y_HALF_HEIGHT = Math.SQRT2;

/**
 * The map outline (the bounding ellipse), as an interleaved polyline.
 * @param {number} [n] number of points around the ellipse
 * @returns {Float64Array}
 */
export function outline(n = 256) {
  const out = new Float64Array(2 * (n + 1));
  for (let i = 0; i <= n; i++) {
    const a = (2.0 * Math.PI * i) / n;
    out[2 * i] = X_HALF_WIDTH * Math.cos(a);
    out[2 * i + 1] = Y_HALF_HEIGHT * Math.sin(a);
  }
  return out;
}

/**
 * Graticule polylines (meridians and parallels) in projected coordinates.
 * @param {string} [solver] registered solver key
 * @returns {Float64Array[]}
 */
export function graticule(solver = VIEW_SOLVER) {
  const fn = getSolver(solver);
  const lines = [];
  const STEP = 64;
  // Meridians every 30 degrees.
  for (let d = -180; d <= 180; d += 30) {
    const lam = (d * Math.PI) / 180;
    const pts = new Float64Array(2 * (STEP + 1));
    for (let i = 0; i <= STEP; i++) {
      const phi = -Math.PI / 2 + (Math.PI * i) / STEP;
      const p = fn(lam, phi);
      pts[2 * i] = p.x;
      pts[2 * i + 1] = p.y;
    }
    lines.push(pts);
  }
  // Parallels every 30 degrees.
  for (let d = -60; d <= 60; d += 30) {
    const phi = (d * Math.PI) / 180;
    const pts = new Float64Array(2 * (STEP + 1));
    for (let i = 0; i <= STEP; i++) {
      const lam = -Math.PI + (2 * Math.PI * i) / STEP;
      const p = fn(lam, phi);
      pts[2 * i] = p.x;
      pts[2 * i + 1] = p.y;
    }
    lines.push(pts);
  }
  return lines;
}
