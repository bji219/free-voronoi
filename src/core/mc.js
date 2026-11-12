// Marching cubes with welded vertices, optional Taubin smoothing, and
// volume / orientation bookkeeping.
import { edgeTable, triTable } from 'three/examples/jsm/objects/MarchingCubes.js';

// edge -> [di, dj, dk, axis] of its lower node
const EDGE = [
  [0, 0, 0, 0], [1, 0, 0, 1], [0, 1, 0, 0], [0, 0, 0, 1],
  [0, 0, 1, 0], [1, 0, 1, 1], [0, 1, 1, 0], [0, 0, 1, 1],
  [0, 0, 0, 2], [1, 0, 0, 2], [1, 1, 0, 2], [0, 1, 0, 2],
];

export function marchingCubes(f, g) {
  const { nx, ny, nz, h, ox, oy, oz } = g;
  const nxy = nx * ny;
  let pos = new Float32Array(1 << 16), np = 0;
  let ind = new Uint32Array(1 << 16), ni = 0;
  let c0 = new Int32Array(nxy * 3).fill(-1), c1 = new Int32Array(nxy * 3).fill(-1);
  const ev = new Int32Array(12);
  const stride = [1, nx, nxy];

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const n0 = k * nxy + j * nx + i;
        let ci = 0;
        if (f[n0] < 0) ci |= 1;
        if (f[n0 + 1] < 0) ci |= 2;
        if (f[n0 + 1 + nx] < 0) ci |= 4;
        if (f[n0 + nx] < 0) ci |= 8;
        if (f[n0 + nxy] < 0) ci |= 16;
        if (f[n0 + 1 + nxy] < 0) ci |= 32;
        if (f[n0 + 1 + nx + nxy] < 0) ci |= 64;
        if (f[n0 + nx + nxy] < 0) ci |= 128;
        const bits = edgeTable[ci];
        if (bits === 0) continue;
        for (let e = 0; e < 12; e++) {
          if (!(bits & (1 << e))) continue;
          const E = EDGE[e];
          const li = i + E[0], lj = j + E[1], ax = E[3];
          const cache = E[2] ? c1 : c0;
          const key = (lj * nx + li) * 3 + ax;
          let v = cache[key];
          if (v < 0) {
            const a = (k + E[2]) * nxy + lj * nx + li;
            const fa = f[a], fb = f[a + stride[ax]];
            let t = fa / (fa - fb);
            if (!(t >= 0 && t <= 1)) t = 0.5;
            if (np + 3 > pos.length) { const p2 = new Float32Array(pos.length * 2); p2.set(pos); pos = p2; }
            v = np / 3;
            pos[np++] = ox + (li + (ax === 0 ? t : 0)) * h;
            pos[np++] = oy + (lj + (ax === 1 ? t : 0)) * h;
            pos[np++] = oz + (k + E[2] + (ax === 2 ? t : 0)) * h;
            cache[key] = v;
          }
          ev[e] = v;
        }
        for (let t = ci << 4; triTable[t] !== -1; t += 3) {
          const a = ev[triTable[t]], b = ev[triTable[t + 1]], c = ev[triTable[t + 2]];
          if (a === b || b === c || a === c) continue;
          if (ni + 3 > ind.length) { const i2 = new Uint32Array(ind.length * 2); i2.set(ind); ind = i2; }
          ind[ni++] = a; ind[ni++] = b; ind[ni++] = c;
        }
      }
    }
    const t = c0; c0 = c1; c1 = t; c1.fill(-1);
  }
  const positions = pos.slice(0, np), indices = ind.slice(0, ni);
  if (signedVolume(positions, indices) < 0) {
    for (let i = 0; i < ni; i += 3) { const t = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = t; }
  }
  return { positions, indices };
}

export function signedVolume(p, ind) {
  let v = 0;
  for (let i = 0; i < ind.length; i += 3) {
    const a = ind[i] * 3, b = ind[i + 1] * 3, c = ind[i + 2] * 3;
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
       - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
       + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  return v / 6;
}

export function soupVolume(t) {
  let v = 0;
  for (let o = 0; o < t.length; o += 9) {
    v += t[o] * (t[o + 4] * t[o + 8] - t[o + 5] * t[o + 7])
       - t[o + 1] * (t[o + 3] * t[o + 8] - t[o + 5] * t[o + 6])
       + t[o + 2] * (t[o + 3] * t[o + 7] - t[o + 4] * t[o + 6]);
  }
  return Math.abs(v / 6);
}

// Taubin lambda/mu smoothing: removes voxel faceting without shrinking strands.
export function taubin(p, ind, iterations) {
  const n = p.length / 3;
  const acc = new Float32Array(p.length), cnt = new Uint16Array(n);
  for (let i = 0; i < ind.length; i += 3) {
    cnt[ind[i]] += 2; cnt[ind[i + 1]] += 2; cnt[ind[i + 2]] += 2;
  }
  const pass = (f) => {
    acc.fill(0);
    for (let i = 0; i < ind.length; i += 3) {
      const a = ind[i] * 3, b = ind[i + 1] * 3, c = ind[i + 2] * 3;
      for (let d = 0; d < 3; d++) {
        const pa = p[a + d], pb = p[b + d], pc = p[c + d];
        acc[a + d] += pb + pc; acc[b + d] += pa + pc; acc[c + d] += pa + pb;
      }
    }
    for (let v = 0; v < n; v++) {
      const m = cnt[v]; if (!m) continue;
      const o = v * 3;
      p[o] += f * (acc[o] / m - p[o]);
      p[o + 1] += f * (acc[o + 1] / m - p[o + 1]);
      p[o + 2] += f * (acc[o + 2] / m - p[o + 2]);
    }
  };
  for (let it = 0; it < iterations; it++) { pass(0.5); pass(-0.53); }
}
