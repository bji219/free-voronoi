// Seed placement. A Poisson-disk layer is laid on the surface and sunk a third of
// a cell inward, so cell walls meet the skin square-on and the surface pattern is
// regular. The interior is then filled with a second Poisson-disk pass that
// respects the first, which makes the two patterns one continuous foam.

import { isInside } from './voxel.js';

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
 * @returns {Float32Array} seed positions (xyz)
 */
export function makeSeeds(tris, bbox, grid, spacing, seed) {
  const rnd = mulberry32(seed * 7919 + 13);
  const nt = tris.length / 9;
  const s = spacing;

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
  const dense = new Hash(bbox, s * 0.5);
  const nDense = Math.min(400000, Math.ceil((area / (s * s)) * 12));
  for (let i = 0; i < nDense; i++) { const p = sample(); dense.add(p[0], p[1], p[2]); }

  // surface Poisson disk (dart throwing), then sink inward
  const surf = new Hash(bbox, s);
  const all = new Hash(bbox, s);
  const out = [];
  const nCand = Math.min(1500000, Math.ceil((area / (s * s)) * 30));
  const depth = 0.35 * s;
  for (let i = 0; i < nCand; i++) {
    const p = sample();
    if (surf.anyWithin(p[0], p[1], p[2], s)) continue;
    surf.add(p[0], p[1], p[2]);
    let q = null;
    for (const d of [depth, -depth, depth * 0.5, -depth * 0.5]) {
      const x = p[0] - p[3] * d, y = p[1] - p[4] * d, z = p[2] - p[5] * d;
      if (isInside(grid, x, y, z)) { q = [x, y, z]; break; }
    }
    if (!q) q = [p[0], p[1], p[2]];
    all.add(q[0], q[1], q[2]);
    out.push(q[0], q[1], q[2]);
  }

  // interior Poisson disk
  const nInt = Math.min(1500000, Math.ceil((vol / (s * s * s)) * 30));
  for (let i = 0; i < nInt; i++) {
    const x = bbox.min[0] + rnd() * size[0], y = bbox.min[1] + rnd() * size[1], z = bbox.min[2] + rnd() * size[2];
    if (!isInside(grid, x, y, z)) continue;
    if (dense.anyWithin(x, y, z, s)) continue;
    if (all.anyWithin(x, y, z, s)) continue;
    all.add(x, y, z);
    out.push(x, y, z);
  }
  return new Float32Array(out);
}
