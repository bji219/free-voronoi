// Cell shape presets (seed lattices): node test/shapes.test.mjs
import * as THREE from 'three';
import { buildGrid } from '../src/core/voxel.js';
import { makeSeeds, SHAPES } from '../src/core/seeds.js';
import { Generator } from '../src/core/pipeline.js';

let fail = false;
const check = (ok, msg) => { if (!ok) fail = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const soup = (geo) => new Float32Array(geo.toNonIndexed().attributes.position.array);
const tris = soup(new THREE.BoxGeometry(40, 30, 20));
const bbox = { min: [-20, -15, -10], max: [20, 15, 10] };
const g = buildGrid(tris, bbox, 64, 6);
const s = 6;

function nnStats(seeds, inner) {
  // nearest-neighbour distance of seeds well inside the box
  const n = seeds.length / 3; let min = Infinity, max = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const x = seeds[i * 3], y = seeds[i * 3 + 1], z = seeds[i * 3 + 2];
    if (Math.abs(x) > 20 - inner || Math.abs(y) > 15 - inner || Math.abs(z) > 10 - inner) continue;
    let d = Infinity;
    for (let j = 0; j < n; j++) if (j !== i) d = Math.min(d, Math.hypot(seeds[j * 3] - x, seeds[j * 3 + 1] - y, seeds[j * 3 + 2] - z));
    min = Math.min(min, d); max = Math.max(max, d); cnt++;
  }
  return { min, max, cnt };
}

check(Array.isArray(SHAPES) && SHAPES.includes('random') && SHAPES.length === 6, `SHAPES exported: ${SHAPES}`);

for (const shape of ['cubic', 'kelvin', 'rhombic', 'honeycomb']) {
  const seeds = makeSeeds(tris, bbox, g, s, 1, { shape, jitter: 0 });
  const st = nnStats(seeds, s);
  check(st.cnt >= 10 && Math.abs(st.min - s) < 0.02 * s && Math.abs(st.max - s) < 0.02 * s, `${shape}: nearest-seed distance = pore (${st.min.toFixed(2)}..${st.max.toFixed(2)} over ${st.cnt} interior seeds)`);
  let outside = 0, far = 0;
  for (let i = 0; i < seeds.length; i += 3) {
    const o = Math.max(Math.abs(seeds[i]) - 20, Math.abs(seeds[i + 1]) - 15, Math.abs(seeds[i + 2]) - 10);
    if (o > 0) outside++;
    if (o > s + 1e-6) far++;
  }
  check(outside > 0 && far === 0, `${shape}: seeds extend one cell past the skin (${outside} outside, ${far} too far)`);
}
{ // deterministic + jitter changes positions
  const a = makeSeeds(tris, bbox, g, s, 1, { shape: 'cubic', jitter: 0 });
  const b = makeSeeds(tris, bbox, g, s, 1, { shape: 'cubic', jitter: 0 });
  const c = makeSeeds(tris, bbox, g, s, 1, { shape: 'cubic', jitter: 0.5 });
  check(a.length === b.length && a.every((v, i) => v === b[i]), 'cubic: deterministic');
  // every jittered seed sits within jitter·pore/2 (per axis) of some lattice point, and most have moved
  let moved = 0, big = 0;
  for (let i = 0; i < c.length; i += 3) {
    // residual to the ideal cubic lattice (centred on the box centre, pitch s), per axis
    const r = [c[i], c[i + 1], c[i + 2]].map((v) => Math.abs(v / s - Math.round(v / s)) * s);
    if (Math.max(...r) > 1e-6) moved++; if (Math.max(...r) > 0.5 * s / 2 + 1e-6) big++;
  }
  check(moved > c.length / 3 / 2 && big === 0, `cubic jitter 0.5: ${moved}/${c.length / 3} seeds moved, none more than jitter·pore/2 per axis (${big} too far)`);
}
{ // honeycomb: straight prisms (same xy in every layer), layer pitch = pore, and stretch scales the pitch
  const h1 = makeSeeds(tris, bbox, g, s, 1, { shape: 'honeycomb', jitter: 0 });
  const zs = [...new Set(Array.from({ length: h1.length / 3 }, (_, i) => +h1[i * 3 + 2].toFixed(4)))].sort((a, b) => a - b);
  const pitch = zs[1] - zs[0];
  check(Math.abs(pitch - s) < 1e-3, `honeycomb: layer pitch ${pitch.toFixed(3)} = pore`);
  const h2 = makeSeeds(tris, bbox, g, s, 1, { shape: 'honeycomb', jitter: 0, stretch: 1.5 });
  const zs2 = [...new Set(Array.from({ length: h2.length / 3 }, (_, i) => +h2[i * 3 + 2].toFixed(4)))].sort((a, b) => a - b);
  check(Math.abs(zs2[1] - zs2[0] - 1.5 * s) < 1e-3, `honeycomb stretch 1.5: layer pitch ${(zs2[1] - zs2[0]).toFixed(3)}`);
  // straight prisms: the two interior layers (z = 0 and z = 6) hold the same xy columns
  const col = (z) => { const set = new Set(); for (let i = 0; i < h1.length; i += 3) if (Math.abs(h1[i + 2] - z) < 1e-3 && Math.abs(h1[i]) < 20 && Math.abs(h1[i + 1]) < 15) set.add(`${h1[i].toFixed(3)},${h1[i + 1].toFixed(3)}`); return set; };
  const c0 = col(0), c6 = col(6);
  check(c0.size > 10 && c0.size === c6.size && [...c0].every((k) => c6.has(k)), `honeycomb: ${c0.size} columns identical across layers`);
}
{ // radial: rings around the given centre at multiples of pore
  const r = makeSeeds(tris, bbox, g, s, 1, { shape: 'radial', jitter: 0, center: [4, -3, 0], axis: 2 });
  let bad = 0, onAxis = 0;
  for (let i = 0; i < r.length; i += 3) {
    const rad = Math.hypot(r[i] - 4, r[i + 1] + 3);
    if (rad < 1e-3) onAxis++;
    else if (Math.abs(rad / s - Math.round(rad / s)) > 1e-3) bad++;
  }
  check(bad === 0 && onAxis > 0, `radial: all seeds on rings n·pore about (4,-3) (${bad} off-ring, ${onAxis} on axis)`);
  const rx = makeSeeds(tris, bbox, g, s, 1, { shape: 'radial', jitter: 0, center: [0, 0, 0], axis: 0 });
  let badx = 0;
  for (let i = 0; i < rx.length; i += 3) { const rad = Math.hypot(rx[i + 1], rx[i + 2]); if (rad > 1e-3 && Math.abs(rad / s - Math.round(rad / s)) > 1e-3) badx++; }
  check(badx === 0, `radial about X: rings in the YZ plane (${badx} off-ring)`);
}
{ // the random shape is bit-identical to the old default
  const a = makeSeeds(tris, bbox, g, s, 1), b = makeSeeds(tris, bbox, g, s, 1, { shape: 'random', jitter: 0.5 });
  check(a.length === b.length && a.every((v, i) => v === b[i]), 'random: unchanged by the shape options');
}
// full pipeline on every shape: watertight, sane density
for (const shape of SHAPES) {
  const gen = new Generator(); gen.setMesh(tris);
  const r = await gen.run({ mode: 'both', pore: 7, strandInt: 1.2, strandSurf: 1.4, blend: 0.6, res: 96, smooth: 1, seed: 1, shape, jitter: 0 }, async () => true);
  const m = new Map();
  for (let i = 0; i < r.indices.length; i += 3) for (let e = 0; e < 3; e++) {
    const u = r.indices[i + e], v = r.indices[i + (e + 1) % 3];
    const key = u < v ? u * 4294967296 + v : v * 4294967296 + u;
    m.set(key, (m.get(key) || 0) + 1);
  }
  let open = 0; for (const c of m.values()) if (c === 1) open++;
  check(open === 0 && r.stats.density > 0.03 && r.stats.density < 0.6, `pipeline ${shape}: cells=${r.stats.cells} density=${(r.stats.density * 100).toFixed(1)}% open=${open}`);
}
process.exit(fail ? 1 : 0);
