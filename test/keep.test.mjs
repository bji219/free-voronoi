// Solid shell + keep-cylinder field behaviour: node test/keep.test.mjs
import * as THREE from 'three';
import { buildGrid } from '../src/core/voxel.js';
import { makeSeeds } from '../src/core/seeds.js';
import { evalField } from '../src/core/field.js';
import { Generator } from '../src/core/pipeline.js';

const soup = (geo) => new Float32Array(geo.toNonIndexed().attributes.position.array);
let fail = false;
const check = (ok, msg) => { if (!ok) fail = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };

const tris = soup(new THREE.BoxGeometry(40, 30, 20));
const bbox = { min: [-20, -15, -10], max: [20, 15, 10] };
const res = 96, h = 40 / res;
const base = { mode: 'volume', pore: 9, rInt: 0.7, rSurf: 0.8, blend: 0.7 };

async function field(extra, bandVox) {
  const g = buildGrid(tris, bbox, res, bandVox);
  const seeds = makeSeeds(tris, bbox, g, 9, 1);
  const f = await evalField(g, seeds, { ...base, ...extra }, null);
  return { g, f };
}
function* nodes(g) {
  for (let k = 0; k < g.nz; k++) for (let j = 0; j < g.ny; j++) for (let i = 0; i < g.nx; i++) {
    const idx = (k * g.ny + j) * g.nx + i;
    const x = g.ox + i * h, y = g.oy + j * h, z = g.oz + k * h;
    // analytic depth inside the 40x30x20 box (negative = inside), independent of the SDF band
    const sd = -Math.min(20 - Math.abs(x), 15 - Math.abs(y), 10 - Math.abs(z));
    yield { idx, x, y, z, sd };
  }
}

{ // --- solid shell: every voxel within `shell` of the surface is solid, deeper ones are not all solid
  const shell = 3;
  const { g, f } = await field({ shell }, Math.ceil((shell + 0.7) / h) + 2);
  let bad = 0, deepEmpty = 0;
  for (const n of nodes(g)) {
    if (n.sd < -1.5 * h && n.sd > -(shell - 1.5 * h) && f[n.idx] >= 0) bad++;
    if (n.sd < -(shell + 0.7 + 2 * h) && f[n.idx] > 0) deepEmpty++;
  }
  check(bad === 0, `shell: all voxels inside 3 mm skin are solid (violations=${bad})`);
  check(deepEmpty > 0, `shell: interior is still a lattice (empty deep voxels=${deepEmpty})`);
}
{ // --- solid keep cylinder along Z through the box centre
  const { g, f } = await field({ keeps: [{ c: [0, 0, 0], a: [0, 0, 1], r: 5, len: 100, wall: 0 }] }, 6);
  let bad = 0;
  for (const n of nodes(g)) {
    if (n.sd < -1.5 * h && Math.hypot(n.x, n.y) < 5 - 1.5 * h && f[n.idx] >= 0) bad++;
  }
  check(bad === 0, `keep cylinder (solid): all voxels inside r=5 are solid (violations=${bad})`);
}
{ // --- tube keep: annulus [r-wall, r] is solid, the bore core stays open
  const { g, f } = await field({ keeps: [{ c: [0, 0, 0], a: [0, 0, 1], r: 5, len: 100, wall: 2 }] }, 6);
  let bad = 0, coreEmpty = 0;
  for (const n of nodes(g)) {
    const rad = Math.hypot(n.x, n.y);
    if (n.sd < -1.5 * h && rad > 3 + 1.5 * h && rad < 5 - 1.5 * h && f[n.idx] >= 0) bad++;
    if (n.sd < -5 && rad < 1.5 && f[n.idx] > 0) coreEmpty++;
  }
  check(bad === 0, `keep cylinder (tube): annulus is solid (violations=${bad})`);
  check(coreEmpty > 0, `keep cylinder (tube): core not filled (empty core voxels=${coreEmpty})`);
}
{ // --- short cylinder along X is bounded by its length
  const { g, f } = await field({ keeps: [{ c: [0, 0, 0], a: [1, 0, 0], r: 4, len: 10, wall: 0 }] }, 6);
  let bad = 0, outsideSolid = 0, outsideTotal = 0;
  for (const n of nodes(g)) {
    const rad = Math.hypot(n.y, n.z);
    if (n.sd < -1.5 * h && rad < 4 - 1.5 * h && Math.abs(n.x) < 5 - 1.5 * h && f[n.idx] >= 0) bad++;
    if (n.sd < -5 && rad < 2 && Math.abs(n.x) > 8 && Math.abs(n.x) < 14) { outsideTotal++; if (f[n.idx] < 0) outsideSolid++; }
  }
  check(bad === 0, `keep cylinder (X, len 10): inside is solid (violations=${bad})`);
  check(outsideSolid < outsideTotal * 0.8, `keep cylinder (X, len 10): beyond the ends is lattice (${outsideSolid}/${outsideTotal} solid)`);
}
{ // --- full pipeline with shell + keeps stays watertight and the shell reads in density
  const gen = new Generator();
  gen.setMesh(tris);
  const p = { mode: 'both', pore: 9, strandInt: 1.4, strandSurf: 1.6, blend: 0.7, res: 96, smooth: 1, seed: 1 };
  const a = await gen.run(p, async () => true);
  const b = await gen.run({ ...p, shell: 2, keeps: [{ c: [0, 0, 0], a: [0, 0, 1], r: 5, len: 100, wall: 0 }] }, async () => true);
  const m = new Map();
  for (let i = 0; i < b.indices.length; i += 3) for (let e = 0; e < 3; e++) {
    const u = b.indices[i + e], v = b.indices[i + (e + 1) % 3];
    const key = u < v ? u * 4294967296 + v : v * 4294967296 + u;
    m.set(key, (m.get(key) || 0) + 1);
  }
  let open = 0; for (const c of m.values()) if (c === 1) open++;
  check(open === 0, `pipeline: shell+keep mesh is watertight (open=${open})`);
  check(b.stats.density > a.stats.density + 0.1, `pipeline: density rose ${(a.stats.density * 100).toFixed(1)}% → ${(b.stats.density * 100).toFixed(1)}%`);
}
process.exit(fail ? 1 : 0);
