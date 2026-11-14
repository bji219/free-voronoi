// Implicit Voronoi foam.
//
// For every grid node we find its four nearest seeds. From those:
//   * distance to the bisector planes  -> cell WALLS  (used only at the skin)
//   * distance to plane-plane lines    -> cell EDGES  (the internal strands)
// Surface strands are tubes running where a cell wall meets the skin; since a
// cell edge is where walls meet, every internal strand lands exactly on a node
// of the surface pattern. A smooth-min fillets all the junctions.
//
// Optional extras, all unioned in with the same smooth-min:
//   * shell   — keep everything within `shell` mm of the surface solid
//   * keeps   — capped cylinders (solid, or a tube when wall > 0) kept solid
//   * stretch — anisotropic metric: cells are `stretch`× taller than wide, so
//               strands lean closer to vertical (friendlier to FDM printing).
//               Seeds are compared in z/stretch space; bisectors stay planes in
//               real space (normal = M·(b−a)), so strand radii stay Euclidean.

const BIG = 1e9;

function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const d = a - b;
  const h = k - (d < 0 ? -d : d);
  if (h <= 0) return a < b ? a : b;
  return (a < b ? a : b) - (h * h) / (4 * k);
}

// Signed distance to a capped cylinder K = {cx,cy,cz, ax,ay,az (unit), r, hl, wall}.
// wall > 0 keeps only the annulus [r - wall, r] (a bore liner); 0 keeps the solid core.
function keepDist(px, py, pz, K) {
  const rx = px - K.cx, ry = py - K.cy, rz = pz - K.cz;
  const t = rx * K.ax + ry * K.ay + rz * K.az;
  const qx = rx - t * K.ax, qy = ry - t * K.ay, qz = rz - t * K.az;
  const rad = Math.sqrt(qx * qx + qy * qy + qz * qz);
  const dr = K.wall > 0 ? Math.abs(rad - (K.r - K.wall / 2)) - K.wall / 2 : rad - K.r;
  const da = Math.abs(t) - K.hl;
  const mx = dr > 0 ? dr : 0, my = da > 0 ? da : 0;
  return Math.min(Math.max(dr, da), 0) + Math.sqrt(mx * mx + my * my);
}

/**
 * @param g grid from buildGrid
 * @param {Float32Array} seeds
 * @param p {mode:'both'|'surface'|'volume', pore, rInt, rSurf, blend, shell?, keeps?, stretch?}
 *          keeps: [{c:[x,y,z], a:[x,y,z], r, len, wall}]
 * @param onSlab async (fraction) => bool  — return false to abort
 */
export async function evalField(g, seeds, p, onSlab) {
  const { nx, ny, nz, h, ox, oy, oz, sdf } = g;
  const out = new Float32Array(g.N);
  const ns = seeds.length / 3;
  const useInt = p.mode !== 'surface', useSurf = p.mode !== 'volume';
  const rI = p.rInt, rS = p.rSurf, k = p.blend;
  const axisDepth = 0.6 * rS;
  const cut = 1.8 * h;
  const shell = p.shell > 0 ? p.shell : 0;
  const az = p.stretch > 1 ? p.stretch : 1, zs = 1 / az;
  const keeps = (p.keeps || []).filter((K) => K && K.r > 0 && K.len > 0).map((K) => {
    const l = Math.hypot(K.a[0], K.a[1], K.a[2]) || 1;
    return { cx: K.c[0], cy: K.c[1], cz: K.c[2], ax: K.a[0] / l, ay: K.a[1] / l, az: K.a[2] / l, r: K.r, hl: K.len / 2, wall: K.wall > 0 ? Math.min(K.wall, K.r) : 0 };
  });
  const nk = keeps.length;

  // --- CSR hash of seeds
  const c = p.pore;
  let bx = Infinity, by = Infinity, bz = Infinity, Bx = -Infinity, By = -Infinity, Bz = -Infinity;
  for (let i = 0; i < ns; i++) {
    const x = seeds[i * 3], y = seeds[i * 3 + 1], z = seeds[i * 3 + 2] * zs;
    if (x < bx) bx = x; if (y < by) by = y; if (z < bz) bz = z;
    if (x > Bx) Bx = x; if (y > By) By = y; if (z > Bz) Bz = z;
  }
  const cnx = Math.max(1, Math.floor((Bx - bx) / c) + 1), cny = Math.max(1, Math.floor((By - by) / c) + 1), cnz = Math.max(1, Math.floor((Bz - bz) / c) + 1);
  const start = new Int32Array(cnx * cny * cnz + 1);
  const cellOf = new Int32Array(ns);
  for (let i = 0; i < ns; i++) {
    const ci = (Math.floor((seeds[i * 3 + 2] * zs - bz) / c) * cny + Math.floor((seeds[i * 3 + 1] - by) / c)) * cnx + Math.floor((seeds[i * 3] - bx) / c);
    cellOf[i] = ci; start[ci + 1]++;
  }
  for (let i = 0; i < start.length - 1; i++) start[i + 1] += start[i];
  const fill = start.slice(0, -1);
  const sp = new Float32Array(ns * 3);
  for (let i = 0; i < ns; i++) {
    const d = fill[cellOf[i]]++;
    sp[d * 3] = seeds[i * 3]; sp[d * 3 + 1] = seeds[i * 3 + 1]; sp[d * 3 + 2] = seeds[i * 3 + 2] * zs;
  }

  // Gather seeds within R of a point into cand[]; returns count.
  let cand = new Int32Array(256);
  const gather = (x, y, z, R) => {
    const i0 = Math.max(0, Math.floor((x - R - bx) / c)), i1 = Math.min(cnx - 1, Math.floor((x + R - bx) / c));
    const j0 = Math.max(0, Math.floor((y - R - by) / c)), j1 = Math.min(cny - 1, Math.floor((y + R - by) / c));
    const k0 = Math.max(0, Math.floor((z - R - bz) / c)), k1 = Math.min(cnz - 1, Math.floor((z + R - bz) / c));
    const R2 = R * R;
    let n = 0;
    for (let kk = k0; kk <= k1; kk++) for (let jj = j0; jj <= j1; jj++) {
      const row = (kk * cny + jj) * cnx;
      for (let s = start[row + i0], e = start[row + i1 + 1]; s < e; s++) {
        const dx = sp[s * 3] - x, dy = sp[s * 3 + 1] - y, dz = sp[s * 3 + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= R2) {
          if (n === cand.length) { const t = new Int32Array(n * 2); t.set(cand); cand = t; }
          cand[n++] = s;
        }
      }
    }
    return n;
  };
  // distance to the 4th nearest seed of a point (expanding search)
  const fourth = (x, y, z) => {
    for (let R = 1.25 * c; ; R *= 1.6) {
      const n = gather(x, y, z, R);
      if (n >= 4 || R > 64 * c) {
        if (n < 4) return R;
        let a = BIG, b = BIG, cc = BIG, d = BIG;
        for (let q = 0; q < n; q++) {
          const s = cand[q];
          const dx = sp[s * 3] - x, dy = sp[s * 3 + 1] - y, dz = sp[s * 3 + 2] - z;
          const v = dx * dx + dy * dy + dz * dz;
          if (v < d) { if (v < cc) { d = cc; if (v < b) { cc = b; if (v < a) { b = a; a = v; } else b = v; } else cc = v; } else d = v; }
        }
        return Math.sqrt(d);
      }
    }
  };

  const B = 4; // block size in voxels; all nodes of a block share one candidate list
  const rho = 0.5 * B * h * Math.sqrt(3);
  const bi = new Int32Array(4), bd = new Float64Array(4);
  const an = new Float64Array(3), nX = new Float64Array(3), nY = new Float64Array(3), nZ = new Float64Array(3);

  for (let k0 = 0; k0 < nz; k0 += B) {
    for (let j0 = 0; j0 < ny; j0 += B) {
      for (let i0 = 0; i0 < nx; i0 += B) {
        let nc = -1;
        const k1 = Math.min(nz, k0 + B), j1 = Math.min(ny, j0 + B), i1 = Math.min(nx, i0 + B);
        for (let kk = k0; kk < k1; kk++) for (let jj = j0; jj < j1; jj++) {
          let idx = (kk * ny + jj) * nx + i0;
          for (let ii = i0; ii < i1; ii++, idx++) {
            const sd = sdf[idx];
            if (sd > cut) { out[idx] = sd; continue; }
            if (nc < 0) {
              const cxp = ox + (i0 + 0.5 * (B - 1)) * h, cyp = oy + (j0 + 0.5 * (B - 1)) * h, czp = (oz + (k0 + 0.5 * (B - 1)) * h) * zs;
              nc = gather(cxp, cyp, czp, fourth(cxp, cyp, czp) + 2 * rho + 1e-6);
            }
            const px = ox + ii * h, py = oy + jj * h, pzr = oz + kk * h, pz = pzr * zs;
            // four nearest among candidates (in the stretched metric)
            bd[0] = bd[1] = bd[2] = bd[3] = BIG; bi[0] = bi[1] = bi[2] = bi[3] = -1;
            for (let q = 0; q < nc; q++) {
              const s = cand[q];
              const dx = sp[s * 3] - px, dy = sp[s * 3 + 1] - py, dz = sp[s * 3 + 2] - pz;
              const v = dx * dx + dy * dy + dz * dz;
              if (v >= bd[3]) continue;
              let m = 3;
              while (m > 0 && bd[m - 1] > v) { bd[m] = bd[m - 1]; bi[m] = bi[m - 1]; m--; }
              bd[m] = v; bi[m] = s;
            }
            let lattice = BIG;
            if (bi[1] >= 0) {
              const s0 = bi[0] * 3;
              let m = 0;
              for (let q = 1; q < 4 && bi[q] >= 0; q++, m++) {
                const s = bi[q] * 3;
                // M·(b−a) with M = diag(1,1,1/az²); sp holds z/az, so the z part is dz'/az
                const dx = sp[s] - sp[s0], dy = sp[s + 1] - sp[s0 + 1], dz = (sp[s + 2] - sp[s0 + 2]) * zs;
                const l = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1e-12;
                an[m] = (bd[q] - bd[0]) / (2 * l);
                nX[m] = dx / l; nY[m] = dy / l; nZ[m] = dz / l;
              }
              if (useInt) {
                for (let a = 0; a < m; a++) for (let b = a + 1; b < m; b++) {
                  const cs = nX[a] * nX[b] + nY[a] * nY[b] + nZ[a] * nZ[b];
                  const s2 = 1 - cs * cs;
                  if (s2 < 1e-4) continue;
                  const e = Math.sqrt(Math.max(0, (an[a] * an[a] + an[b] * an[b] - 2 * cs * an[a] * an[b]) / s2)) - rI;
                  lattice = smin(lattice, e, k);
                }
              }
              if (useSurf && sd > -g.band) {
                let w = an[0];
                for (let a = 1; a < m; a++) w = smin(w, an[a], k);
                const dd = sd + axisDepth;
                lattice = smin(lattice, Math.sqrt(w * w + dd * dd) - rS, k);
              }
            }
            if (shell > 0) lattice = smin(lattice, -sd - shell, k);
            for (let q = 0; q < nk; q++) lattice = smin(lattice, keepDist(px, py, pzr, keeps[q]), k);
            out[idx] = lattice > sd ? lattice : sd;
          }
        }
      }
    }
    if (onSlab && !(await onSlab(Math.min(1, (k0 + B) / nz)))) return null;
  }
  return out;
}
