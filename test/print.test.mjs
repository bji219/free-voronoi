// FDM helpers: island detection, pin-down, Z-stretch. node test/print.test.mjs
import * as THREE from 'three';
import { buildGrid } from '../src/core/voxel.js';
import { makeSeeds } from '../src/core/seeds.js';
import { evalField } from '../src/core/field.js';
import { findIslands, pinIslands } from '../src/core/print.js';
import { Generator } from '../src/core/pipeline.js';

let fail = false;
const check = (ok, msg) => { if (!ok) fail = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

function synth() {
  const g = { nx: 24, ny: 24, nz: 24, h: 1, ox: 0, oy: 0, oz: 0 };
  g.N = g.nx * g.ny * g.nz;
  g.sdf = new Float32Array(g.N).fill(-100); // whole grid counts as "inside the part"
  const f = new Float32Array(g.N).fill(1);
  const at = (i, j, k) => (k * g.ny + j) * g.nx + i;
  const box = (i0, i1, j0, j1, k0, k1, v = -1) => { for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f[at(i, j, k)] = v; };
  return { g, f, at, box };
}

{ // --- detection: floor + supported column + 45° stair are fine; a floating blob is one island
  const { g, f, box } = synth();
  box(0, 23, 0, 23, 1, 2);            // floor
  box(2, 3, 2, 3, 3, 9);              // column standing on the floor
  for (let s = 0; s < 6; s++) box(15 + s, 16 + s, 2, 3, 3 + s, 3 + s); // 45° staircase
  box(8, 11, 8, 11, 10, 12);          // floating blob, lowest layer k=10
  const isl = findIslands(f, g);
  check(isl.length === 1, `islands: exactly one island found (${isl.length})`);
  check(isl[0] && isl[0].k === 10 && isl[0].i >= 8 && isl[0].i <= 11, `islands: island sits at k=10 (${JSON.stringify(isl[0])})`);
}
{ // --- detection: a steep (>60°) overhang is flagged, the lowest layer of the part is not
  const { g, f, box } = synth();
  box(0, 23, 0, 23, 5, 6); // floor raised off k=0: still not an island (it's the bed layer)
  for (let s = 0; s < 5; s++) box(4 + 3 * s, 5 + 3 * s, 2, 3, 7 + s, 7 + s); // 3 voxels/layer ≈ 72°: nothing in the 3×3 below
  const isl = findIslands(f, g);
  check(isl.length === 4, `islands: 72° overhang flags each unsupported step (${isl.length})`);
}
{ // --- pin-down: after pinning, the blob is connected to the floor and no islands remain
  const { g, f, at, box } = synth();
  box(0, 23, 0, 23, 1, 2);
  box(8, 11, 8, 11, 10, 12);
  const before = findIslands(f, g);
  const pins = pinIslands(f, g, before, { r: 1.2, blend: 0 });
  check(pins === 1, `pin: one pin added (${pins})`);
  check(findIslands(f, g).length === 0, 'pin: no islands remain');
  let column = true;
  for (let k = 3; k <= 9; k++) if (f[at(9, 9, k)] >= 0 && f[at(10, 10, k)] >= 0) column = false;
  check(column, 'pin: vertical strut fills the column between blob and floor');
}
{ // --- pin-down: an island hanging over empty space outside the part is left alone
  const { g, f, at, box } = synth();
  box(0, 23, 0, 23, 1, 2);
  box(8, 11, 8, 11, 10, 12);
  for (let k = 0; k < 10; k++) for (let j = 8; j <= 11; j++) for (let i = 8; i <= 11; i++) g.sdf[at(i, j, k)] = 5; // air below it
  const pins = pinIslands(f, g, findIslands(f, g), { r: 1.2, blend: 0 });
  check(pins === 0, `pin: nothing pinned through air outside the part (${pins})`);
  check(findIslands(f, g).length === 1, 'pin: the unfixable island is still reported');
}

{ // --- bridge underside: a 1-voxel sag line under a bar that is anchored one layer up is not an island (minHeight)
  const { g, f, box } = synth();
  box(0, 23, 0, 23, 1, 2);            // floor
  box(4, 5, 10, 11, 3, 14);           // left column
  box(16, 17, 10, 11, 3, 14);         // right column
  box(4, 17, 10, 11, 15, 15);         // bar joining the columns (supported by both)
  box(8, 13, 10, 11, 14, 14);         // sag line under the bar's middle, detached from the columns
  check(findIslands(f, g).length === 1, 'bridge: strict detection flags the sag line');
  check(findIslands(f, g, 2).length === 0, 'bridge: sag absorbed within 2 layers is ignored');
  box(8, 13, 10, 11, 11, 13);         // make the sag 4 layers tall: now a real hanging lump
  check(findIslands(f, g, 2).length === 1, 'bridge: a 4-layer hanging lump is still an island');
}
{ // --- a free-floating blob is an island whatever the tolerance
  const { g, f, box } = synth();
  box(0, 23, 0, 23, 1, 2);
  box(8, 11, 8, 11, 10, 12);
  check(findIslands(f, g, 50).length === 1, 'floating blob: never absorbed, flagged at any minHeight');
}

const soup = (geo) => new Float32Array(geo.toNonIndexed().attributes.position.array);
const tris = soup(new THREE.BoxGeometry(40, 30, 20));
const bbox = { min: [-20, -15, -10], max: [20, 15, 10] };
{ // --- stretch=1 is bit-identical to the old path
  const g = buildGrid(tris, bbox, 64, 6);
  const s0 = makeSeeds(tris, bbox, g, 9, 1), s1 = makeSeeds(tris, bbox, g, 9, 1, { stretch: 1 });
  check(s0.length === s1.length && s0.every((v, i) => v === s1[i]), 'stretch 1: seeds unchanged');
  const p = { mode: 'both', pore: 9, rInt: 0.7, rSurf: 0.8, blend: 0.7 };
  const f0 = await evalField(g, s0, p, null), f1 = await evalField(g, s1, { ...p, stretch: 1 }, null);
  check(f0.every((v, i) => v === f1[i]), 'stretch 1: field unchanged');
}
{ // --- stretched cells have less steep-overhang surface (faces pointing down past 45°), summed over three seeds
  const p = { mode: 'volume', pore: 7, strandInt: 1.4, strandSurf: 1.6, blend: 0.6, res: 96, smooth: 0 };
  const overhang = (r) => {
    const P = r.positions, I = r.indices; let a = 0;
    for (let t = 0; t < I.length; t += 3) {
      const A = I[t] * 3, B = I[t + 1] * 3, C = I[t + 2] * 3;
      const ux = P[B] - P[A], uy = P[B + 1] - P[A + 1], uz = P[B + 2] - P[A + 2];
      const vx = P[C] - P[A], vy = P[C + 1] - P[A + 1], vz = P[C + 2] - P[A + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const l = Math.hypot(nx, ny, nz);
      if (l > 0 && nz / l < -Math.SQRT1_2) a += l / 2;
    }
    return a;
  };
  let raw = 0, fdm = 0;
  for (const seed of [1, 2, 3]) {
    const gen = new Generator(); gen.setMesh(tris);
    raw += overhang(await gen.run({ ...p, seed }, async () => true));
    fdm += overhang(await gen.run({ ...p, seed, stretch: 1.6 }, async () => true));
  }
  check(fdm < raw * 0.9, `stretch 1.6: steep-overhang area ${fdm.toFixed(0)} < ${raw.toFixed(0)} mm² (${((1 - fdm / raw) * 100).toFixed(0)}% less)`);
}
{ // --- pipeline FDM mode: pins remove islands and the mesh stays watertight
  const gen = new Generator(); gen.setMesh(tris);
  const r = await gen.run({ mode: 'volume', pore: 7, strandInt: 1.4, strandSurf: 1.6, blend: 0.6, res: 96, smooth: 1, seed: 1, stretch: 1.5, pin: true }, async () => true);
  check(r.stats.pins > 0, `pipeline: pins added (${r.stats.pins})`);
  check(r.stats.islands === 0, `pipeline: islands after pinning = ${r.stats.islands}`);
  check(r.islands instanceof Float32Array && r.islands.length === r.stats.islands * 3, 'pipeline: island points returned');
  const m = new Map();
  for (let i = 0; i < r.indices.length; i += 3) for (let e = 0; e < 3; e++) {
    const u = r.indices[i + e], v = r.indices[i + (e + 1) % 3];
    const key = u < v ? u * 4294967296 + v : v * 4294967296 + u;
    m.set(key, (m.get(key) || 0) + 1);
  }
  let open = 0; for (const c of m.values()) if (c === 1) open++;
  check(open === 0, `pipeline: FDM mesh watertight (open=${open})`);
}
process.exit(fail ? 1 : 0);
