// Seed placement.
//
// 'random': a Poisson-disk layer is laid on the surface and sunk a third of a
// cell inward, so cell walls meet the skin square-on and the surface pattern is
// regular. The interior is then filled with a second Poisson-disk pass that
// respects the first, which makes the two patterns one continuous foam.
//
// Lattice shapes fill the bounding box plus a one-cell margin with a regular
// point set (so cells at the skin are simply cut by the surface), optionally
// jittered. `spacing` is always the nearest-seed distance.

import { isInside } from './voxel.js';

export const SHAPES = ['random', 'cubic', 'kelvin', 'rhombic', 'honeycomb', 'radial'];

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Hash {
  constructor(bbox, cell) {
    this.c = cell;
    this.b = bbox.min;
    this.n = [0, 1, 2].map((a) => Math.max(1, Math.ceil((bbox.max[a] - bbox.min[a]) / cell) + 1));
    this.head = new Int32Array(this.n[0] * this.n[1] * this.n[2]).fill(-1);
    this.next = [];
    this.pts = [];
  }
  cellOf(x, a) { return Math.min(this.n[a] - 1, Math.max(0, Math.floor((x - this.b[a]) / this.c))); }
  add(x, y, z) {
    const id = this.pts.length / 3;
    this.pts.push(x, y, z);
    const ci = (this.cellOf(z, 2) * this.n[1] + this.cellOf(y, 1)) * this.n[0] + this.cellOf(x, 0);
    this.next.push(this.head[ci]);
    this.head[ci] = id;
  }
  // true if any stored point lies within r of (x,y,z)
  anyWithin(x, y, z, r) {
    const r2 = r * r, p = this.pts;
    const i0 = this.cellOf(x - r, 0), i1 = this.cellOf(x + r, 0);
    const j0 = this.cellOf(y - r, 1), j1 = this.cellOf(y + r, 1);
    const k0 = this.cellOf(z - r, 2), k1 = this.cellOf(z + r, 2);
    for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      for (let id = this.head[(k * this.n[1] + j) * this.n[0] + i]; id >= 0; id = this.next[id]) {
        const dx = p[id * 3] - x, dy = p[id * 3 + 1] - y, dz = p[id * 3 + 2] - z;
        if (dx * dx + dy * dy + dz * dz < r2) return true;
      }
    }
    return false;
  }
}

/**
 * @param opts {stretch?, shape?, jitter?, center?, axis?}
 *   stretch  >1 stretches the metric along z (cells `stretch`× taller)
 *   shape    one of SHAPES (default 'random')
 *   jitter   0..1 random displacement of lattice seeds, in units of spacing/2 per axis
 *   center   [x,y,z] axis point for 'radial' (default: bbox centre)
 *   axis     0|1|2 ring axis for 'radial' (default z)
 * @returns {Float32Array} seed positions (xyz)
 */
export function makeSeeds(tris, bbox, grid, spacing, seed, opts = {}) {
  const stretch = opts.stretch > 1 ? opts.stretch : 1;
  const shape = SHAPES.includes(opts.shape) ? opts.shape : 'random';
  const rnd = mulberry32(seed * 7919 + 13);
  const nt = tris.length / 9;
  const s = spacing;
  const zs = stretch > 1 ? 1 / stretch : 1;
  const hb = { min: [bbox.min[0], bbox.min[1], bbox.min[2] * zs], max: [bbox.max[0], bbox.max[1], bbox.max[2] * zs] };

  // cumulative triangle areas
  const cum = new Float64Array(nt);
  let area = 0;
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    area += 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
    cum[t] = area;
  }
  const size = [0, 1, 2].map((a) => bbox.max[a] - bbox.min[a]);
  const vol = size[0] * size[1] * size[2];
  if (!(area > 0)) return new Float32Array(0);

  const sample = () => {
    const r = rnd() * area;
    let lo = 0, hi = nt - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < r) lo = m + 1; else hi = m; }
    const o = lo * 9;
    let a = rnd(), b = rnd();
    if (a + b > 1) { a = 1 - a; b = 1 - b; }
    const c = 1 - a - b;
    const ux = tris[o + 3] - tris[o], uy = tris[o + 4] - tris[o + 1], uz = tris[o + 5] - tris[o + 2];
    const vx = tris[o + 6] - tris[o], vy = tris[o + 7] - tris[o + 1], vz = tris[o + 8] - tris[o + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const nl = Math.hypot(nx, ny, nz) || 1;
    return [
      c * tris[o] + a * tris[o + 3] + b * tris[o + 6],
      c * tris[o + 1] + a * tris[o + 4] + b * tris[o + 7],
      c * tris[o + 2] + a * tris[o + 5] + b * tris[o + 8],
      nx / nl, ny / nl, nz / nl,
    ];
  };

  // dense surface cloud: cheap "how deep am I" test for interior candidates
  const dense = new Hash(hb, s * 0.5);
  const nDense = Math.min(400000, Math.ceil((area / (s * s)) * 12));
  for (let i = 0; i < nDense; i++) { const p = sample(); dense.add(p[0], p[1], p[2] * zs); }

  if (shape !== 'random') return latticeSeeds(shape, bbox, grid, dense, s, stretch, rnd, opts);

  // surface Poisson disk (dart throwing), then sink inward
  const surf = new Hash(hb, s);
  const all = new Hash(hb, s);
  const out = [];
  const nCand = Math.min(1500000, Math.ceil((area / (s * s)) * 30));
  const depth = 0.35 * s;
  for (let i = 0; i < nCand; i++) {
    const p = sample();
    if (surf.anyWithin(p[0], p[1], p[2] * zs, s)) continue;
    surf.add(p[0], p[1], p[2] * zs);
    let q = null;
    for (const d of [depth, -depth, depth * 0.5, -depth * 0.5]) {
      const x = p[0] - p[3] * d, y = p[1] - p[4] * d, z = p[2] - p[5] * d;
      if (isInside(grid, x, y, z)) { q = [x, y, z]; break; }
    }
    if (!q) q = [p[0], p[1], p[2]];
    all.add(q[0], q[1], q[2] * zs);
    out.push(q[0], q[1], q[2]);
  }

  // interior Poisson disk
  const nInt = Math.min(1500000, Math.ceil((vol / (s * s * s)) * 30));
  for (let i = 0; i < nInt; i++) {
    const x = bbox.min[0] + rnd() * size[0], y = bbox.min[1] + rnd() * size[1], z = bbox.min[2] + rnd() * size[2];
    if (!isInside(grid, x, y, z)) continue;
    if (dense.anyWithin(x, y, z * zs, s)) continue;
    if (all.anyWithin(x, y, z * zs, s)) continue;
    all.add(x, y, z * zs);
    out.push(x, y, z);
  }
  return new Float32Array(out);
}

// Regular point sets, generated in stretched space (z' = z / stretch) and mapped
// back, so cells are taller by `stretch` like the random foam. A seed is kept if
// it lies inside the part or within one spacing of the surface.
function latticeSeeds(shape, bbox, grid, dense, s, stretch, rnd, opts) {
  const zs = 1 / stretch;
  const jit = Math.min(1, Math.max(0, opts.jitter || 0)) * s / 2;
  const lo = [bbox.min[0] - s, bbox.min[1] - s, bbox.min[2] * zs - s];
  const hi = [bbox.max[0] + s, bbox.max[1] + s, bbox.max[2] * zs + s];
  const c = [(bbox.min[0] + bbox.max[0]) / 2, (bbox.min[1] + bbox.max[1]) / 2, (bbox.min[2] + bbox.max[2]) / 2 * zs];
  const out = [];
  const emit = (x, y, zp) => {
    if (jit > 0) { x += (rnd() * 2 - 1) * jit; y += (rnd() * 2 - 1) * jit; zp += (rnd() * 2 - 1) * jit; }
    const z = zp * stretch;
    if (isInside(grid, x, y, z) || dense.anyWithin(x, y, zp, s)) out.push(x, y, z);
  };
  // cover [lo,hi] with a point lattice of pitch a (per axis) centred on c, plus basis offsets
  const lattice = (a, basis) => {
    const r = [0, 1, 2].map((k) => [Math.ceil((lo[k] - c[k]) / a[k]) - 1, Math.floor((hi[k] - c[k]) / a[k]) + 1]);
    for (let k = r[2][0]; k <= r[2][1]; k++) for (let j = r[1][0]; j <= r[1][1]; j++) for (let i = r[0][0]; i <= r[0][1]; i++) {
      for (const b of basis) {
        const x = c[0] + (i + b[0]) * a[0], y = c[1] + (j + b[1]) * a[1], z = c[2] + (k + b[2]) * a[2];
        if (x < lo[0] || x > hi[0] || y < lo[1] || y > hi[1] || z < lo[2] || z > hi[2]) continue;
        emit(x, y, z);
      }
    }
  };
  if (shape === 'cubic') lattice([s, s, s], [[0, 0, 0]]);
  else if (shape === 'kelvin') { const a = 2 * s / Math.sqrt(3); lattice([a, a, a], [[0, 0, 0], [0.5, 0.5, 0.5]]); }
  else if (shape === 'rhombic') { const a = s * Math.SQRT2; lattice([a, a, a], [[0, 0, 0], [0.5, 0.5, 0], [0.5, 0, 0.5], [0, 0.5, 0.5]]); }
  else if (shape === 'honeycomb') honeycomb();
  else if (shape === 'radial') radial();
  return new Float32Array(out);

  function honeycomb() {
    const dy = s * Math.sqrt(3) / 2;
    const j0 = Math.ceil((lo[1] - c[1]) / dy) - 1, j1 = Math.floor((hi[1] - c[1]) / dy) + 1;
    const k0 = Math.ceil((lo[2] - c[2]) / s) - 1, k1 = Math.floor((hi[2] - c[2]) / s) + 1;
    for (let k = k0; k <= k1; k++) {
      const z = c[2] + k * s; if (z < lo[2] || z > hi[2]) continue;
      for (let j = j0; j <= j1; j++) {
        const y = c[1] + j * dy; if (y < lo[1] || y > hi[1]) continue;
        const off = (j & 1) ? s / 2 : 0;
        const i0 = Math.ceil((lo[0] - c[0] - off) / s) - 1, i1 = Math.floor((hi[0] - c[0] - off) / s) + 1;
        for (let i = i0; i <= i1; i++) { const x = c[0] + off + i * s; if (x >= lo[0] && x <= hi[0]) emit(x, y, z); }
      }
    }
  }
  function radial() {
    const a = opts.axis === 0 || opts.axis === 1 ? opts.axis : 2;
    const u = (a + 1) % 3, v = (a + 2) % 3;
    const ctr = opts.center ? [opts.center[0], opts.center[1], opts.center[2] * zs] : c.slice();
    const k0 = Math.ceil((lo[a] - ctr[a]) / s) - 1, k1 = Math.floor((hi[a] - ctr[a]) / s) + 1;
    const rMax = Math.hypot(Math.max(hi[u] - ctr[u], ctr[u] - lo[u]), Math.max(hi[v] - ctr[v], ctr[v] - lo[v]));
    const nR = Math.ceil(rMax / s) + 1;
    const p = [0, 0, 0];
    for (let k = k0; k <= k1; k++) {
      p[a] = ctr[a] + k * s; if (p[a] < lo[a] || p[a] > hi[a]) continue;
      for (let n = 0; n <= nR; n++) {
        const r = n * s, m = n === 0 ? 1 : Math.max(1, Math.round((2 * Math.PI * r) / s));
        const phase = (n & 1) ? Math.PI / m : 0;
        for (let q = 0; q < m; q++) {
          const t = phase + (2 * Math.PI * q) / m;
          p[u] = ctr[u] + r * Math.cos(t); p[v] = ctr[v] + r * Math.sin(t);
          if (p[u] < lo[u] || p[u] > hi[u] || p[v] < lo[v] || p[v] > hi[v]) continue;
          emit(p[0], p[1], p[2]);
        }
      }
    }
  }
}
