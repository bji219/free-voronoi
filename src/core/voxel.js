// Voxelisation of a triangle soup into a narrow-band signed distance field.
// Sign comes from parity ray casting along all three axes (majority vote, so
// small mesh defects don't leak), magnitude from exact point-triangle distances
// propagated outward from the surface.

const BIG = 1e9;

// Squared distance from point p to triangle ti of soup t (Ericson, RTCD 5.1.5).
export function ptTriDist2(px, py, pz, t, ti) {
  const o = ti * 9;
  const ax = t[o], ay = t[o + 1], az = t[o + 2];
  const bx = t[o + 3], by = t[o + 4], bz = t[o + 5];
  const cx = t[o + 6], cy = t[o + 7], cz = t[o + 8];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  let qx, qy, qz;
  if (d1 <= 0 && d2 <= 0) { qx = ax; qy = ay; qz = az; }
  else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz;
    const d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { qx = bx; qy = by; qz = bz; }
    else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        qx = ax + v * abx; qy = ay + v * aby; qz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz;
        const d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { qx = cx; qy = cy; qz = cz; }
        else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            qx = ax + w * acx; qy = ay + w * acy; qz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && (d4 - d3) >= 0 && (d5 - d6) >= 0) {
              const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
              qx = bx + w * (cx - bx); qy = by + w * (cy - by); qz = bz + w * (cz - bz);
            } else {
              const den = 1 / (va + vb + vc);
              const v = vb * den, w = vc * den;
              qx = ax + abx * v + acx * w; qy = ay + aby * v + acy * w; qz = az + abz * v + acz * w;
            }
          }
        }
      }
    }
  }
  const dx = px - qx, dy = py - qy, dz = pz - qz;
  return dx * dx + dy * dy + dz * dz;
}

function parityAxis(tris, g, a, votes) {
  const n = [g.nx, g.ny, g.nz];
  const st = [1, g.nx, g.nx * g.ny];
  const org = [g.ox, g.oy, g.oz];
  const u = (a + 1) % 3, v = (a + 2) % 3;
  const nu = n[u], nv = n[v], na = n[a];
  const su = st[u], sv = st[v], sa = st[a];
  const inv = 1 / g.h;
  const tog = new Uint8Array(g.nx * g.ny * g.nz);
  const nt = tris.length / 9;
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const u0 = (tris[o + u] - org[u]) * inv, v0 = (tris[o + v] - org[v]) * inv, a0 = (tris[o + a] - org[a]) * inv;
    const u1 = (tris[o + 3 + u] - org[u]) * inv, v1 = (tris[o + 3 + v] - org[v]) * inv, a1 = (tris[o + 3 + a] - org[a]) * inv;
    const u2 = (tris[o + 6 + u] - org[u]) * inv, v2 = (tris[o + 6 + v] - org[v]) * inv, a2 = (tris[o + 6 + a] - org[a]) * inv;
    const area = (u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0);
    if (area === 0) continue;
    const iu0 = Math.max(0, Math.ceil(Math.min(u0, u1, u2))), iu1 = Math.min(nu - 1, Math.floor(Math.max(u0, u1, u2)));
    const iv0 = Math.max(0, Math.ceil(Math.min(v0, v1, v2))), iv1 = Math.min(nv - 1, Math.floor(Math.max(v0, v1, v2)));
    for (let iv = iv0; iv <= iv1; iv++) {
      for (let iu = iu0; iu <= iu1; iu++) {
        const w0 = (u1 - iu) * (v2 - iv) - (u2 - iu) * (v1 - iv);
        const w1 = (u2 - iu) * (v0 - iv) - (u0 - iu) * (v2 - iv);
        const w2 = (u0 - iu) * (v1 - iv) - (u1 - iu) * (v0 - iv);
        if (!((w0 >= 0 && w1 >= 0 && w2 >= 0) || (w0 <= 0 && w1 <= 0 && w2 <= 0))) continue;
        const ta = (w0 * a0 + w1 * a1 + w2 * a2) / area;
        let ia = Math.ceil(ta);
        if (ia >= na) continue;
        if (ia < 0) ia = 0;
        tog[iu * su + iv * sv + ia * sa] ^= 1;
      }
    }
  }
  for (let iv = 0; iv < nv; iv++) {
    for (let iu = 0; iu < nu; iu++) {
      let idx = iu * su + iv * sv, s = 0;
      for (let ia = 0; ia < na; ia++, idx += sa) {
        s ^= tog[idx];
        votes[idx] += s;
      }
    }
  }
}

/**
 * @param {Float32Array} tris triangle soup (9 floats per triangle)
 * @param {{min:number[],max:number[]}} bbox
 * @param {number} res nodes along the longest axis
 * @param {number} bandVox signed-distance band half-width in voxels
 */
export function buildGrid(tris, bbox, res, bandVox) {
  const size = [bbox.max[0] - bbox.min[0], bbox.max[1] - bbox.min[1], bbox.max[2] - bbox.min[2]];
  const h = Math.max(size[0], size[1], size[2]) / res;
  const pad = 3;
  // Irrational-ish offsets keep grid nodes off mesh vertices/edges.
  const ox = bbox.min[0] - (pad + 0.0137) * h;
  const oy = bbox.min[1] - (pad + 0.0291) * h;
  const oz = bbox.min[2] - (pad + 0.0173) * h;
  const nx = Math.ceil(size[0] / h) + 2 * pad + 1;
  const ny = Math.ceil(size[1] / h) + 2 * pad + 1;
  const nz = Math.ceil(size[2] / h) + 2 * pad + 1;
  const N = nx * ny * nz;
  const g = { nx, ny, nz, h, ox, oy, oz, N, band: bandVox * h };

  const votes = new Uint8Array(N);
  for (let a = 0; a < 3; a++) parityAxis(tris, g, a, votes);
  const inside = votes;
  for (let i = 0; i < N; i++) inside[i] = votes[i] >= 2 ? 1 : 0;

  // --- exact distances near the surface
  const d2 = new Float32Array(N).fill(BIG);
  const tri = new Int32Array(N).fill(-1);
  const nt = tris.length / 9;
  const inv = 1 / h;
  const near = 1.5 * h;
  for (let t = 0; t < nt; t++) {
    const o = t * 9;
    const ax = tris[o], ay = tris[o + 1], az = tris[o + 2];
    const bx = tris[o + 3], by = tris[o + 4], bz = tris[o + 5];
    const cx = tris[o + 6], cy = tris[o + 7], cz = tris[o + 8];
    let nxn = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    let nyn = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    let nzn = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const nl = Math.hypot(nxn, nyn, nzn);
    const planar = nl > 0;
    if (planar) { nxn /= nl; nyn /= nl; nzn /= nl; }
    const i0 = Math.max(0, Math.floor((Math.min(ax, bx, cx) - ox) * inv) - 1), i1 = Math.min(nx - 1, Math.ceil((Math.max(ax, bx, cx) - ox) * inv) + 1);
    const j0 = Math.max(0, Math.floor((Math.min(ay, by, cy) - oy) * inv) - 1), j1 = Math.min(ny - 1, Math.ceil((Math.max(ay, by, cy) - oy) * inv) + 1);
    const k0 = Math.max(0, Math.floor((Math.min(az, bz, cz) - oz) * inv) - 1), k1 = Math.min(nz - 1, Math.ceil((Math.max(az, bz, cz) - oz) * inv) + 1);
    for (let k = k0; k <= k1; k++) {
      const pz = oz + k * h;
      for (let j = j0; j <= j1; j++) {
        const py = oy + j * h;
        let idx = (k * ny + j) * nx + i0;
        for (let i = i0; i <= i1; i++, idx++) {
          const px = ox + i * h;
          if (planar && Math.abs((px - ax) * nxn + (py - ay) * nyn + (pz - az) * nzn) > near) continue;
          const d = ptTriDist2(px, py, pz, tris, t);
          if (d < d2[idx]) { d2[idx] = d; tri[idx] = t; }
        }
      }
    }
  }

  // --- propagate closest-triangle labels outward through the band
  const band2 = g.band * g.band;
  let queue = [];
  for (let i = 0; i < N; i++) if (tri[i] >= 0) queue.push(i);
  const queued = new Uint8Array(N);
  const nxy = nx * ny;
  while (queue.length) {
    const next = [];
    for (let q = 0; q < queue.length; q++) {
      const idx = queue[q];
      queued[idx] = 0;
      const t = tri[idx];
      const k = (idx / nxy) | 0, r = idx - k * nxy, j = (r / nx) | 0, i = r - j * nx;
      for (let dk = -1; dk <= 1; dk++) {
        const kk = k + dk; if (kk < 0 || kk >= nz) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj; if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di; if (ii < 0 || ii >= nx) continue;
            const n = (kk * ny + jj) * nx + ii;
            if (tri[n] === t) continue;
            const d = ptTriDist2(ox + ii * h, oy + jj * h, oz + kk * h, tris, t);
            if (d < d2[n] * 0.99999 && d <= band2) {
              d2[n] = d; tri[n] = t;
              if (!queued[n]) { queued[n] = 1; next.push(n); }
            }
          }
        }
      }
    }
    queue = next;
  }

  const sdf = d2;
  const far = g.band + h;
  for (let i = 0; i < N; i++) {
    const d = tri[i] >= 0 ? Math.sqrt(d2[i]) : far;
    sdf[i] = inside[i] ? -d : d;
  }
  g.sdf = sdf;
  g.inside = inside;
  return g;
}

export function isInside(g, x, y, z) {
  const i = Math.round((x - g.ox) / g.h), j = Math.round((y - g.oy) / g.h), k = Math.round((z - g.oz) / g.h);
  if (i < 0 || j < 0 || k < 0 || i >= g.nx || j >= g.ny || k >= g.nz) return false;
  return g.inside[(k * g.ny + j) * g.nx + i] === 1;
}
