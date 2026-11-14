// Orientation maths used to re-pose an imported part before voxelisation: node test/orient.test.mjs
import { qIdentity, qAxisAngle, qMul, qInv, qBetween, qRotate, qToEuler, qFromEuler, rotateSoup, nearestAxis, soupCenter } from '../src/core/orient.js';

let fail = false;
const check = (ok, msg) => { if (!ok) fail = true; console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); };
const near = (a, b, eps = 1e-5) => Math.abs(a - b) < eps;
const vnear = (a, b, eps = 1e-5) => a.length === b.length && a.every((v, i) => near(v, b[i], eps));

// axis-aligned box soup 40 × 20 × 10 centred at (5, 0, 0)
function box(sx, sy, sz, c) {
  const h = [sx / 2, sy / 2, sz / 2], out = [];
  const corner = (m) => m.map((s, i) => c[i] + s * h[i]);
  const quads = [
    [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]], [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]],
    [[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]], [[-1,1,-1],[1,1,-1],[1,1,1],[-1,1,1]],
    [[-1,-1,-1],[-1,1,-1],[-1,1,1],[-1,-1,1]], [[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]],
  ];
  for (const q of quads) { const p = q.map(corner); out.push(...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]); }
  return new Float32Array(out);
}
function bbox(s) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], s[i + a]); max[a] = Math.max(max[a], s[i + a]); }
  return { min, max, size: max.map((v, i) => v - min[i]) };
}
const deg = Math.PI / 180;
const soup = box(40, 20, 10, [5, 0, 0]);
const c0 = soupCenter(soup);
check(vnear(c0, [5, 0, 0]), `soupCenter = bbox centre ${c0}`);

{ // identity leaves the soup alone
  const r = rotateSoup(soup, qIdentity(), c0);
  check(r !== soup && vnear(Array.from(r), Array.from(soup)), 'identity rotation copies the soup unchanged');
}
{ // +90° about X: the Y extent becomes the Z extent; the pivot stays put
  const r = rotateSoup(soup, qAxisAngle(0, 90 * deg), c0);
  const b = bbox(r);
  check(vnear(b.size, [40, 10, 20]), `X+90 swaps Y/Z extents → ${b.size.map((v) => v.toFixed(2))}`);
  check(vnear(bbox(r).min.map((v, i) => v + b.size[i] / 2), c0), 'rotation is about the bbox centre');
}
{ // +90° about Z: X extent becomes Y extent
  const b = bbox(rotateSoup(soup, qAxisAngle(2, 90 * deg), c0));
  check(vnear(b.size, [20, 40, 10]), `Z+90 swaps X/Y extents → ${b.size.map((v) => v.toFixed(2))}`);
}
{ // composing two quarter turns about one axis = half turn; inverse undoes
  const q = qMul(qAxisAngle(1, 90 * deg), qAxisAngle(1, 90 * deg));
  const p = qRotate(q, [1, 0, 0]);
  check(vnear(p, [-1, 0, 0]), `two Y+90 = Y+180 (x̂ → ${p.map((v) => v.toFixed(3))})`);
  const back = qRotate(qMul(qInv(q), q), [0.3, -0.2, 0.9]);
  check(vnear(back, [0.3, -0.2, 0.9]), 'q⁻¹·q is the identity');
}
{ // lay-flat: the clicked face normal must end up pointing straight down
  const n = [0.6, 0, 0.8];
  const q = qBetween(n, [0, 0, -1]);
  check(vnear(qRotate(q, n), [0, 0, -1]), 'qBetween maps the face normal onto −Z');
  // antiparallel case (top face clicked) must still produce a valid half turn
  const q2 = qBetween([0, 0, 1], [0, 0, -1]);
  check(vnear(qRotate(q2, [0, 0, 1]), [0, 0, -1]) && near(Math.hypot(...q2), 1), 'antiparallel normals give a unit half-turn');
  // already down: identity
  check(vnear(qBetween([0, 0, -1], [0, 0, -1]), [0, 0, 0, 1]), 'parallel normals give the identity');
}
{ // Euler (degrees, applied X then Y then Z about fixed axes) round-trips
  for (const e of [[0, 0, 0], [90, 0, 0], [0, 90, 0], [30, -45, 120], [-170, 10, 5]]) {
    const q = qFromEuler(e);
    const q2 = qFromEuler(qToEuler(q));
    const p = [0.2, 0.7, -0.4];
    check(vnear(qRotate(q, p), qRotate(q2, p), 1e-4), `euler ${e} round-trips through a quaternion`);
  }
  check(vnear(qRotate(qFromEuler([90, 0, 0]), [0, 1, 0]), [0, 0, 1]), 'euler X+90 takes ŷ to ẑ');
}
{ // keep-cylinder axis snaps to the nearest principal axis after a rotation
  check(nearestAxis(qRotate(qAxisAngle(0, 90 * deg), [0, 0, 1])) === 1, 'ẑ rotated X+90 → Y axis');
  check(nearestAxis(qRotate(qAxisAngle(1, 90 * deg), [0, 0, 1])) === 0, 'ẑ rotated Y+90 → X axis');
  check(nearestAxis([0.1, -0.9, 0.3]) === 1, 'nearestAxis picks the dominant component');
}
process.exit(fail ? 1 : 0);
