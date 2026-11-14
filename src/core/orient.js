// Re-posing an imported part before anything else sees it.
// Quaternions are plain arrays [x, y, z, w]; angles are radians unless the
// function name says Euler (degrees, for the UI). Rotations happen about a
// pivot (the imported part's bbox centre) so the part stays where it was.

export const qIdentity = () => [0, 0, 0, 1];

export function qAxisAngle(axis, angle) {
  const q = [0, 0, 0, Math.cos(angle / 2)];
  q[axis] = Math.sin(angle / 2);
  return q;
}

export function qMul(a, b) { // a ∘ b: apply b first, then a
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export const qInv = (q) => [-q[0], -q[1], -q[2], q[3]];

export function qRotate(q, v) {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  // t = 2 q×v ; v' = v + w t + q×t
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + y * tz - z * ty, vy + w * ty + z * tx - x * tz, vz + w * tz + x * ty - y * tx];
}

// Shortest rotation taking unit vector a onto unit vector b.
export function qBetween(a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) { // antiparallel: half turn about any axis ⟂ a
    let ax = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const c = [a[1] * ax[2] - a[2] * ax[1], a[2] * ax[0] - a[0] * ax[2], a[0] * ax[1] - a[1] * ax[0]];
    const l = Math.hypot(...c);
    return [c[0] / l, c[1] / l, c[2] / l, 0];
  }
  const q = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0], 1 + d];
  const l = Math.hypot(...q);
  return q.map((v) => v / l);
}

// Euler angles in degrees, applied as X, then Y, then Z about the fixed world axes.
export function qFromEuler([ex, ey, ez]) {
  const d = Math.PI / 180;
  return qMul(qAxisAngle(2, ez * d), qMul(qAxisAngle(1, ey * d), qAxisAngle(0, ex * d)));
}
export function qToEuler(q) {
  const [x, y, z, w] = q, r = 180 / Math.PI;
  const sy = 2 * (w * y - z * x);
  if (Math.abs(sy) > 0.999999) return [0, Math.sign(sy) * 90, Math.atan2(2 * (x * y + w * z) * Math.sign(sy), 1 - 2 * (y * y + z * z)) * r];
  return [
    Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * r,
    Math.asin(sy) * r,
    Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * r,
  ];
}

export function soupCenter(s) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < s.length; i += 3) for (let a = 0; a < 3; a++) { const v = s[i + a]; if (v < min[a]) min[a] = v; if (v > max[a]) max[a] = v; }
  return [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
}

export function rotateSoup(s, q, pivot) {
  const out = new Float32Array(s.length);
  const [px, py, pz] = pivot;
  for (let i = 0; i < s.length; i += 3) {
    const r = qRotate(q, [s[i] - px, s[i + 1] - py, s[i + 2] - pz]);
    out[i] = r[0] + px; out[i + 1] = r[1] + py; out[i + 2] = r[2] + pz;
  }
  return out;
}

export function nearestAxis(v) {
  const a = v.map(Math.abs);
  return a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2;
}
