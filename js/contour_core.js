/**
 * contour_core.js — highest-density-region thresholds and marching squares.
 *
 * Pure functions, no DOM and no worker API, so the identical code runs inside
 * the Web Worker in the browser and inside Node for the benchmark.
 *
 * CONVENTIONS (A1):
 *   - `counts` is a Tier 1 uint8 grid, C order, index = iy*nx + ix. `ix` runs
 *     along the first-named parameter (x), `iy` along the second (y).
 *   - Bins are uniform. The value at (ix, iy) is the histogram count in the
 *     bin whose CENTRE is x = xmin + (ix + 0.5)*(xmax - xmin)/nx, and likewise
 *     for y. Contours are therefore drawn on the (nx-1) x (ny-1) lattice of
 *     cells between bin centres, in DATA coordinates.
 *   - A credible level `q` (e.g. 0.90) selects the highest-density region: the
 *     threshold is the largest grid value `T` such that the total count in
 *     cells with value >= T is at least q of the grid total. This is the same
 *     definition used by the Python corner plots, applied to the binned
 *     density rather than to the samples.
 *   - Contours are closed or open polylines, each a Float64Array
 *     [x0, y0, x1, y1, ...] in data units.
 *
 * TWO IMPLEMENTATION POINTS THAT COST A ROUND, recorded so they are not
 * undone:
 *
 * 1. THE HALF-COUNT OFFSET. Grid values are integers and the HDR threshold is
 *    an integer, so `value == threshold` is common, not rare. Interpolating
 *    against the integer threshold then puts contour endpoints exactly on grid
 *    CORNERS, where four cells meet, the incidence list has more than two
 *    segments, and the curve fragments. Marching squares therefore runs
 *    against `threshold - 0.5`. For integer data `v >= T` and `v > T - 0.5`
 *    are the identical classification, so the region is unchanged, but the
 *    interpolation parameter is now strictly inside (0, 1).
 *    MEASURED effect on a Gaussian test grid: 9 polylines -> 1 polyline.
 *
 * 2. SEGMENTS ARE STITCHED ON EDGE IDENTITY, NOT ON COORDINATES. Each contour
 *    endpoint lies on one grid edge, so it is labelled by that edge's integer
 *    id. Matching integers is exact and fast; matching quantised floats is
 *    neither.
 */

import { CONTOUR_SMOOTH_SIGMA } from "./config.js";

/** Number of distinct values a uint8 grid can hold. Value: 256. */
const UINT8_LEVELS = 256;

/**
 * Separable Gaussian blur of a grid, with sigma in BINS.
 *
 * Edge handling renormalises by the in-bounds kernel weight, so no mass is
 * lost at the border and a flat field stays flat.
 *
 * @param {ArrayLike<number>} counts
 * @param {number} nx @param {number} ny @param {number} sigma in bins
 * @returns {Float64Array} length nx*ny, C order, index = iy*nx + ix
 */
export function smoothGrid(counts, nx, ny, sigma) {
  const n = nx * ny;
  const out = new Float64Array(n);
  if (!(sigma > 0)) {
    for (let i = 0; i < n; i++) out[i] = counts[i];
    return out;
  }
  const r = Math.max(1, Math.ceil(3 * sigma));
  const k = new Float64Array(2 * r + 1);
  for (let d = -r; d <= r; d++) k[d + r] = Math.exp((-0.5 * d * d) / (sigma * sigma));
  const tmp = new Float64Array(n);
  // along x
  for (let iy = 0; iy < ny; iy++) {
    const row = iy * nx;
    for (let ix = 0; ix < nx; ix++) {
      let acc = 0;
      let wsum = 0;
      const lo = Math.max(-r, -ix);
      const hi = Math.min(r, nx - 1 - ix);
      for (let d = lo; d <= hi; d++) {
        const w = k[d + r];
        acc += w * counts[row + ix + d];
        wsum += w;
      }
      tmp[row + ix] = acc / wsum;
    }
  }
  // along y
  for (let ix = 0; ix < nx; ix++) {
    for (let iy = 0; iy < ny; iy++) {
      let acc = 0;
      let wsum = 0;
      const lo = Math.max(-r, -iy);
      const hi = Math.min(r, ny - 1 - iy);
      for (let d = lo; d <= hi; d++) {
        const w = k[d + r];
        acc += w * tmp[(iy + d) * nx + ix];
        wsum += w;
      }
      out[iy * nx + ix] = acc / wsum;
    }
  }
  return out;
}

/**
 * Highest-density-region thresholds for a real-valued field.
 * Same definition as `hdrThresholds`, without the uint8 assumption.
 *
 * @param {Float64Array} field
 * @param {number[]} levels credible fractions in (0, 1)
 * @returns {number[]}
 */
export function hdrThresholdsFloat(field, levels) {
  const v = Float64Array.from(field);
  v.sort();
  let total = 0;
  for (let i = 0; i < v.length; i++) total += v[i];
  const out = new Array(levels.length).fill(0);
  if (total <= 0) return out;
  const targets = levels.map((q) => q * total);
  const done = new Array(levels.length).fill(false);
  let acc = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    acc += v[i];
    for (let m = 0; m < levels.length; m++) {
      if (!done[m] && acc >= targets[m]) {
        out[m] = v[i];
        done[m] = true;
      }
    }
    if (done.every(Boolean)) break;
  }
  return out;
}

/**
 * Highest-density-region thresholds CALIBRATED ON THE RAW HISTOGRAM while the
 * curve is drawn on a SMOOTHED field. RULING 21 (2026-09-16).
 *
 * THE DEFECT THIS FIXES, MEASURED. Smoothing and then thresholding the blurred
 * field gives a curve that is a correct HDR of the BLURRED density but not of
 * the posterior. The blur moves mass out of the peak, so the region holding
 * 90% of the smoothed mass holds MORE than 90% of the samples. On the GW250114
 * sky posterior the shipped "90%" curve enclosed 0.9648 of the IMR posterior
 * (0.9685 run-weighted). Round 2 separated the two candidate mechanisms: the
 * SMOOTHED-field mass inside the same drawn curve was 0.8995 / 0.9006 / 0.8999
 * at sigma = 0.5 / 1 / 2, so the contour machinery is CORRECT and the density
 * it was contouring was the wrong one.
 *
 * THE FIX. Contour the smoothed field, because request 3 asks for a smooth
 * curve, but choose the threshold so that the RAW histogram mass enclosed
 * equals the nominal level. Appearance and label are then both right. Do not
 * ship a curve labelled 90% that encloses 96%.
 *
 * Sky is the worst case and resolution cannot help it: that posterior is a thin
 * arc one bin thick and eighty long, still one bin thick at 384x192, so sigma=1
 * blurs across its entire thickness.
 *
 * WHY THE THRESHOLD IS A MIDPOINT, not a field value. `marchingSquares`
 * classifies on `value > thr`, so returning a value that a cell actually takes
 * would exclude that cell from its own level set. The threshold is therefore
 * placed halfway between the last INCLUDED field value and the next lower
 * DISTINCT one. This also keeps the interpolation parameter strictly inside
 * (0, 1), for the same reason as the half-count offset above.
 *
 * WHY TIES ARE TAKEN AS A GROUP. A super-level set of a field cannot split
 * cells that share a value, so the whole tie group is included and its raw mass
 * counted with it. Over-inclusion at the boundary is bounded by one tie group
 * and is the only behaviour consistent with `value > thr`.
 *
 * @param {ArrayLike<number>} field the SMOOTHED field actually contoured
 * @param {ArrayLike<number>} counts the RAW histogram the level is calibrated on
 * @param {number[]} levels credible fractions in (0, 1)
 * @returns {number[]} threshold on `field` for each level, same order
 */
export function hdrThresholdsCalibrated(field, counts, levels) {
  const n = field.length;
  if (counts.length !== n) {
    throw new Error(
      `contour_core.hdrThresholdsCalibrated: field has ${n} cells but the raw ` +
        `histogram has ${counts.length}. The threshold is chosen on one and ` +
        `applied to the other, so they must be the same grid.`
    );
  }
  const out = new Array(levels.length).fill(0);
  let total = 0;
  for (let i = 0; i < n; i++) total += counts[i];
  if (total <= 0) return out;

  // Cell indices ordered by DECREASING smoothed field value.
  const ord = new Array(n);
  for (let i = 0; i < n; i++) ord[i] = i;
  ord.sort((a, b) => field[b] - field[a]);

  const targets = levels.map((q) => q * total);
  const done = new Array(levels.length).fill(false);
  let acc = 0;
  let i = 0;
  while (i < n) {
    const v = field[ord[i]];
    let j = i;
    while (j < n && field[ord[j]] === v) acc += counts[ord[j++]];
    // Halfway to the next distinct value; below the last group, halve it.
    //
    // ULP GUARD, and it is load-bearing. When `v` and the next distinct value
    // differ by one ulp, the midpoint ROUNDS BACK TO `v`, and `field > thr`
    // then excludes the whole tie group the level was calibrated to include.
    // MEASURED before this guard: the enclosed raw mass fell 9.4e-04 BELOW the
    // nominal level. Falling back to the next distinct value itself keeps the
    // cell set exactly right; it costs the strict-interior interpolation only
    // in the one case where no representable midpoint exists.
    const vNext = j < n ? field[ord[j]] : 0.5 * v;
    let thr = 0.5 * (v + vNext);
    if (!(thr < v && thr > vNext)) thr = vNext;
    for (let m = 0; m < levels.length; m++) {
      if (!done[m] && acc >= targets[m]) {
        out[m] = thr;
        done[m] = true;
      }
    }
    if (done.every(Boolean)) break;
    i = j;
  }
  return out;
}

/**
 * Highest-density-region thresholds for a uint8 grid.
 * O(N + 256): a 256-bin value histogram, not a sort.
 *
 * @param {Uint8Array} counts
 * @param {number[]} levels credible fractions in (0, 1), e.g. [0.5, 0.9]
 * @returns {number[]} threshold grid value for each level, same order
 */
export function hdrThresholds(counts, levels) {
  const hist = new Float64Array(UINT8_LEVELS);
  let total = 0;
  for (let i = 0; i < counts.length; i++) {
    const v = counts[i];
    hist[v] += v;
    total += v;
  }
  const out = new Array(levels.length).fill(0);
  if (total <= 0) return out;
  const targets = levels.map((q) => q * total);
  const done = new Array(levels.length).fill(false);
  let acc = 0;
  for (let v = UINT8_LEVELS - 1; v >= 1; v--) {
    acc += hist[v];
    for (let k = 0; k < levels.length; k++) {
      if (!done[k] && acc >= targets[k]) {
        out[k] = v;
        done[k] = true;
      }
    }
  }
  for (let k = 0; k < levels.length; k++) if (!done[k]) out[k] = 1;
  return out;
}

// Segment table for marching squares. Index bits: 1 = corner a (ix, iy),
// 2 = b (ix+1, iy), 4 = c (ix+1, iy+1), 8 = d (ix, iy+1). Edge codes:
// 0 = bottom (a-b), 1 = right (b-c), 2 = top (d-c), 3 = left (a-d).
const SEG_TABLE = [
  [], // 0
  [[3, 0]], // 1
  [[0, 1]], // 2
  [[3, 1]], // 3
  [[1, 2]], // 4
  null, // 5  ambiguous, resolved at run time
  [[0, 2]], // 6
  [[3, 2]], // 7
  [[2, 3]], // 8
  [[2, 0]], // 9
  null, // 10 ambiguous
  [[2, 1]], // 11
  [[1, 3]], // 12
  [[1, 0]], // 13
  [[0, 3]], // 14
  [], // 15
];

/**
 * Marching squares on a uint8 grid at one threshold.
 *
 * FILL RINGS (`closeAtEdge = true`). A region that reaches the edge of the
 * grid gives an OPEN polyline, because the lattice stops at the outermost bin
 * centres. Filling that polyline closes it with a straight chord and cuts the
 * region off (the defect a wide posterior showed on the site, 2026-09-18). With
 * `closeAtEdge` the field is padded by a ring of nodes that sit EXACTLY on the
 * grid edge (x = xmin, xmax; y = ymin, ymax) and are always outside the region.
 * Every contour is then a closed ring, and the part of it that runs along the
 * grid edge follows the edge. The grid spans the sample min/max, so no sample
 * lies beyond that edge. Use these rings for FILLS only; strokes use the open
 * polylines, so no line is drawn along the grid edge.
 *
 * @param {ArrayLike<number>} counts the field, C order
 * @param {number} nx @param {number} ny
 * @param {number} thr the threshold to contour at. For an INTEGER field the
 *        caller must pass `T - 0.5`; see the half-count offset note above.
 * @param {number} xmin @param {number} xmax @param {number} ymin @param {number} ymax
 * @param {boolean} [closeAtEdge] pad so every contour closes along the grid edge
 * @returns {Float64Array[]} polylines, each [x0,y0,x1,y1,...] in data units
 */
export function marchingSquares(counts, nx0, ny0, thr, xmin, xmax, ymin, ymax, closeAtEdge = false) {
  const dx = (xmax - xmin) / nx0;
  const dy = (ymax - ymin) / ny0;
  let field = counts;
  let nx = nx0;
  let ny = ny0;
  // Node coordinates. Unpadded: the bin centres. Padded: the bin centres plus
  // one node on each grid edge.
  let cx = (ix) => xmin + (ix + 0.5) * dx;
  let cy = (iy) => ymin + (iy + 0.5) * dy;
  if (closeAtEdge) {
    nx = nx0 + 2;
    ny = ny0 + 2;
    field = new Float64Array(nx * ny).fill(-Infinity);
    for (let iy = 0; iy < ny0; iy++) {
      for (let ix = 0; ix < nx0; ix++) field[(iy + 1) * nx + ix + 1] = counts[iy * nx0 + ix];
    }
    cx = (ix) => (ix === 0 ? xmin : ix === nx - 1 ? xmax : xmin + (ix - 0.5) * dx);
    cy = (iy) => (iy === 0 ? ymin : iy === ny - 1 ? ymax : ymin + (iy - 0.5) * dy);
  }
  // Interpolation parameter along an edge from value v0 to v1. A padding node
  // (-Infinity) takes the crossing onto itself, which is the grid edge.
  const tOf = (v0, v1) => (v0 === -Infinity ? 0 : v1 === -Infinity ? 1 : (thr - v0) / (v1 - v0));

  // Edge ids. A horizontal edge starts at grid point (ix, iy) and runs +x; a
  // vertical edge starts at (ix, iy) and runs +y. Both fit in one integer.
  const hId = (ix, iy) => (iy * nx + ix) * 2;
  const vId = (ix, iy) => (iy * nx + ix) * 2 + 1;

  const segA = [];
  const segB = [];
  const coordX = new Map(); // edge id -> x
  const coordY = new Map(); // edge id -> y

  for (let iy = 0; iy < ny - 1; iy++) {
    const row0 = iy * nx;
    const row1 = row0 + nx;
    for (let ix = 0; ix < nx - 1; ix++) {
      const va = field[row0 + ix];
      const vb = field[row0 + ix + 1];
      const vc = field[row1 + ix + 1];
      const vd = field[row1 + ix];
      let idx = 0;
      if (va > thr) idx |= 1;
      if (vb > thr) idx |= 2;
      if (vc > thr) idx |= 4;
      if (vd > thr) idx |= 8;
      if (idx === 0 || idx === 15) continue;
      let pairs = SEG_TABLE[idx];
      if (pairs === null) {
        // Saddle: resolved with the cell mean, the usual stand-in for the
        // asymptotic decider. The choice is consistent across the grid.
        const joined = (va + vb + vc + vd) / 4 > thr;
        if (idx === 5) pairs = joined ? [[3, 2], [1, 0]] : [[3, 0], [1, 2]];
        else pairs = joined ? [[0, 3], [2, 1]] : [[0, 1], [2, 3]];
      }
      const x0 = cx(ix);
      const x1 = cx(ix + 1);
      const y0 = cy(iy);
      const y1 = cy(iy + 1);

      for (let q = 0; q < pairs.length; q++) {
        const pair = pairs[q];
        for (let e = 0; e < 2; e++) {
          const code = pair[e];
          let id;
          let x;
          let y;
          switch (code) {
            case 0: {
              id = hId(ix, iy);
              x = x0 + tOf(va, vb) * (x1 - x0);
              y = y0;
              break;
            }
            case 1: {
              id = vId(ix + 1, iy);
              x = x1;
              y = y0 + tOf(vb, vc) * (y1 - y0);
              break;
            }
            case 2: {
              id = hId(ix, iy + 1);
              x = x0 + tOf(vd, vc) * (x1 - x0);
              y = y1;
              break;
            }
            default: {
              id = vId(ix, iy);
              x = x0;
              y = y0 + tOf(va, vd) * (y1 - y0);
              break;
            }
          }
          if (!coordX.has(id)) {
            coordX.set(id, x);
            coordY.set(id, y);
          }
          if (e === 0) segA.push(id);
          else segB.push(id);
        }
      }
    }
  }
  return stitch(segA, segB, coordX, coordY);
}

/**
 * Join segments, given as pairs of EDGE IDS, into polylines.
 *
 * @param {number[]} segA edge id of each segment's first endpoint
 * @param {number[]} segB edge id of each segment's second endpoint
 * @param {Map<number, number>} coordX edge id -> x
 * @param {Map<number, number>} coordY edge id -> y
 * @returns {Float64Array[]}
 */
export function stitch(segA, segB, coordX, coordY) {
  const n = segA.length;
  if (n === 0) return [];
  const inc = new Map(); // edge id -> array of segment indices
  for (let s = 0; s < n; s++) {
    for (const id of [segA[s], segB[s]]) {
      let lst = inc.get(id);
      if (lst === undefined) inc.set(id, (lst = []));
      lst.push(s);
    }
  }

  const used = new Uint8Array(n);
  const polys = [];

  const walk = (startSeg, startId, out) => {
    let seg = startSeg;
    let id = startId;
    for (;;) {
      used[seg] = 1;
      out.push(coordX.get(id), coordY.get(id));
      const cands = inc.get(id);
      let next = -1;
      let nextId = -1;
      for (let k = 0; k < cands.length; k++) {
        const cs = cands[k];
        if (cs === seg || used[cs]) continue;
        next = cs;
        nextId = segA[cs] === id ? segB[cs] : segA[cs];
        break;
      }
      if (next < 0) return;
      seg = next;
      id = nextId;
    }
  };

  const back = [];
  const fwd = [];
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    back.length = 0;
    fwd.length = 0;
    walk(s, segA[s], back);
    used[s] = 0;
    walk(s, segB[s], fwd);
    const pts = new Float64Array(back.length + fwd.length);
    let w = 0;
    for (let i = back.length - 2; i >= 0; i -= 2) {
      pts[w++] = back[i];
      pts[w++] = back[i + 1];
    }
    for (let i = 0; i < fwd.length; i++) pts[w++] = fwd[i];
    if (pts.length >= 4) polys.push(pts);
  }
  return polys;
}

/**
 * Contour one grid at several credible levels.
 *
 * The grid is smoothed by `sigma` bins first (config.CONTOUR_SMOOTH_SIGMA by
 * default). With `sigma = 0` the raw integer histogram is contoured, and the
 * threshold then carries the half-count offset.
 *
 * RULING 21: with `sigma > 0` the curve is drawn on the SMOOTHED field but the
 * threshold is calibrated so that the enclosed mass of the RAW histogram equals
 * the nominal level. See `hdrThresholdsCalibrated`. Thresholding the blurred
 * field directly, which this replaced, labelled 96.5% of the sky posterior
 * "90%".
 *
 * @param {{counts:Uint8Array,nx:number,ny:number,xmin:number,xmax:number,ymin:number,ymax:number}} g
 * @param {number[]} levels credible fractions in (0,1)
 * @param {number} [sigma] smoothing width in bins
 * Each level carries `polylines` (open where the region meets the grid edge;
 * STROKE these) and `rings` (always closed, along the grid edge where needed;
 * FILL these). See `marchingSquares`.
 *
 * @returns {{level:number, threshold:number, polylines:Float64Array[], rings:Float64Array[]}[]}
 */
export function contourGrid(g, levels, sigma = CONTOUR_SMOOTH_SIGMA) {
  if (!(sigma >= 0)) throw new Error(`contour_core.contourGrid: sigma must be >= 0, got ${sigma}`);
  if (sigma === 0) {
    // Raw integer histogram: uint8 fast path, half-count offset at use.
    const thr = hdrThresholds(g.counts, levels);
    return levels.map((q, k) => ({
      level: q,
      threshold: thr[k],
      polylines: marchingSquares(g.counts, g.nx, g.ny, thr[k] - 0.5, g.xmin, g.xmax, g.ymin, g.ymax),
      rings: marchingSquares(g.counts, g.nx, g.ny, thr[k] - 0.5, g.xmin, g.xmax, g.ymin, g.ymax, true),
    }));
  }
  const field = smoothGrid(g.counts, g.nx, g.ny, sigma);
  const thr = hdrThresholdsCalibrated(field, g.counts, levels);
  return levels.map((q, k) => ({
    level: q,
    threshold: thr[k],
    polylines: marchingSquares(field, g.nx, g.ny, thr[k], g.xmin, g.xmax, g.ymin, g.ymax),
    rings: marchingSquares(field, g.nx, g.ny, thr[k], g.xmin, g.xmax, g.ymin, g.ymax, true),
  }));
}

/**
 * 1D marginal of a Tier 1 grid.
 * @param {Uint8Array} counts @param {number} nx @param {number} ny
 * @param {0|1} axis 0 keeps x (sums over y), 1 keeps y (sums over x)
 * @returns {Float64Array} length nx for axis 0, ny for axis 1
 */
export function marginal1D(counts, nx, ny, axis) {
  if (axis === 0) {
    const out = new Float64Array(nx);
    for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) out[ix] += counts[iy * nx + ix];
    return out;
  }
  if (axis === 1) {
    const out = new Float64Array(ny);
    for (let iy = 0; iy < ny; iy++) {
      let s = 0;
      for (let ix = 0; ix < nx; ix++) s += counts[iy * nx + ix];
      out[iy] = s;
    }
    return out;
  }
  throw new Error(`contour_core.marginal1D: axis must be 0 or 1, got ${axis}`);
}
