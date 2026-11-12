// Headless sanity check of the geometry core: node test/core.test.mjs
import * as THREE from 'three';
import { Generator } from '../src/core/pipeline.js';

function soup(geo) {
  const g = geo.toNonIndexed();
  return new Float32Array(g.attributes.position.array);
}

function edgeStats(ind) {
  const m = new Map();
  for (let i = 0; i < ind.length; i += 3) for (let e = 0; e < 3; e++) {
    const a = ind[i + e], b = ind[i + (e + 1) % 3];
    const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
    m.set(key, (m.get(key) || 0) + 1);
  }
  let open = 0, nonManifold = 0;
  for (const c of m.values()) { if (c === 1) open++; else if (c > 2) nonManifold++; }
  return { open, nonManifold };
}

const shapes = {
  sphere: new THREE.SphereGeometry(25, 48, 32),
  box: new THREE.BoxGeometry(40, 30, 20),
  torus: new THREE.TorusGeometry(25, 9, 24, 64),
};
let fail = false;
for (const [name, geo] of Object.entries(shapes)) {
  for (const mode of ['both', 'surface', 'volume']) {
    const gen = new Generator();
    gen.setMesh(soup(geo));
    const r = await gen.run({ mode, pore: 9, strandInt: 1.4, strandSurf: 1.6, blend: 0.7, res: 128, smooth: 2, seed: 1 }, async () => true);
    const es = edgeStats(r.indices);
    const s = r.stats;
    const ok = es.open === 0 && s.density > 0.02 && s.density < 0.7 && s.triangles > 1000;
    if (!ok) fail = true;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}/${mode}: cells=${s.cells} tris=${s.triangles} density=${(s.density * 100).toFixed(1)}% open=${es.open} nonmanifold=${es.nonManifold} ${s.ms.toFixed(0)}ms`);
  }
}
{
  const gen = new Generator();
  gen.setMesh(soup(shapes.sphere));
  // solid check: enormous strands should reproduce the solid volume
  const r = await gen.run({ mode: 'both', pore: 9, strandInt: 30, strandSurf: 30, blend: 0, res: 96, smooth: 0, seed: 1 }, async () => true);
  const ok = Math.abs(r.stats.density - 1) < 0.02;
  if (!ok) fail = true;
  console.log(`${ok ? 'ok  ' : 'FAIL'} solid-fill density=${r.stats.density.toFixed(4)}`);
}
process.exit(fail ? 1 : 0);
