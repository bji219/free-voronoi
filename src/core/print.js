// FDM print checks on the voxel field. z is the build axis.
//
// An "island" is a connected blob in one layer with nothing to sit on in the
// layer below (nothing within one voxel in x/y, so ≤45° overhangs pass, as they
// do on a real printer). Pinning drops a vertical strut from each island to the
// first solid below it, or to the bed if the column stays inside the part.

function smin(a, b, k) {
  if (k <= 0) return a < b ? a : b;
  const d = a - b;
  const h = k - (d < 0 ? -d : d);
  if (h <= 0) return a < b ? a : b;
  return (a < b ? a : b) - (h * h) / (4 * k);
}

function groundLayer(f, g) {
  const nxy = g.nx * g.ny;
  for (let k = 0; k < g.nz; k++) {
    const base = k * nxy;
    for (let q = 0; q < nxy; q++) if (f[base + q] < 0) return k;
  }
  return -1;
}

/**
 * @param {Float32Array} f  field (negative = solid)
 * @param g grid {nx,ny,nz}
 * @param minLayers  ignore an island if the unsupported material above it joins
 *   supported material within this many layers (the underside sag of a bridge:
 *   one layer printed in air, anchored on the next). 0 = strict, every island.
 * @returns {{i:number,j:number,k:number,size:number}[]} one representative voxel per island
 */
export function findIslands(f, g, minLayers = 0) {
  const { nx, ny, nz } = g;
  const nxy = nx * ny;
  const kg = groundLayer(f, g);
  if (kg < 0) return [];
  const label = new Uint8Array(nxy);
  const stack = new Int32Array(nxy);
  const members = new Int32Array(nxy);
  const maskA = minLayers > 0 ? new Uint8Array(nxy) : null, maskB = minLayers > 0 ? new Uint8Array(nxy) : null;
  const islands = [];
  for (let k = kg + 1; k < nz; k++) {
    label.fill(0);
    const base = k * nxy, below = base - nxy;
    for (let q0 = 0; q0 < nxy; q0++) {
      if (f[base + q0] >= 0 || label[q0]) continue;
      let sp = 0, n = 0, si = 0, sj = 0, supported = false;
      stack[sp++] = q0; label[q0] = 1;
      while (sp) {
        const c = stack[--sp];
        const cj = (c / nx) | 0, ci = c - cj * nx;
        members[n++] = c; si += ci; sj += cj;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = cj + dj; if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = ci + di; if (ii < 0 || ii >= nx) continue;
            const nb = jj * nx + ii;
            if (!supported && f[below + nb] < 0) supported = true;
            if (f[base + nb] < 0 && !label[nb]) { label[nb] = 1; stack[sp++] = nb; }
          }
        }
      }
      if (supported) continue;
      if (minLayers > 0 && absorbed(f, g, members, n, k, minLayers, maskA, maskB, stack)) continue;
      // representative: member voxel nearest the centroid
      const ci0 = si / n, cj0 = sj / n;
      let best = -1, bd = Infinity;
      for (let m = 0; m < n; m++) {
        const c = members[m], cj = (c / nx) | 0, ci = c - cj * nx;
        const d = (ci - ci0) * (ci - ci0) + (cj - cj0) * (cj - cj0);
        if (d < bd) { bd = d; best = c; }
      }
      const bj = (best / nx) | 0;
      islands.push({ i: best - bj * nx, j: bj, k, size: n });
    }
  }
  return islands;
}

// Follow the unsupported material above an island layer by layer. True if, within
// maxLayers, it joins material that rests on something other than itself.
// A region that simply ends (a free-floating body) is never absorbed.
function absorbed(f, g, members, n, k, maxLayers, cur, next, stack) {
  const { nx, ny, nz } = g;
  const nxy = nx * ny;
  cur.fill(0);
  for (let m = 0; m < n; m++) cur[members[m]] = 1;
  for (let step = 1; step <= maxLayers; step++) {
    const kk = k + step;
    if (kk >= nz) return false;
    const base = kk * nxy, below = base - nxy;
    next.fill(0);
    let sp = 0, any = false;
    // seeds: solid voxels in layer kk sitting on the current region, then flood-fill their layer components
    for (let q = 0; q < nxy; q++) {
      if (!cur[q] || f[base + q] >= 0 || next[q]) continue;
      next[q] = 1; stack[sp++] = q;
    }
    let supported = false;
    while (sp) {
      const c = stack[--sp];
      any = true;
      const cj = (c / nx) | 0, ci = c - cj * nx;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = cj + dj; if (jj < 0 || jj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = ci + di; if (ii < 0 || ii >= nx) continue;
          const nb = jj * nx + ii;
          if (!supported && f[below + nb] < 0 && !cur[nb]) supported = true;
          if (f[base + nb] < 0 && !next[nb]) { next[nb] = 1; stack[sp++] = nb; }
        }
      }
    }
    if (!any) return false;
    if (supported) return true;
    const t = cur; cur = next; next = t;
  }
  return false;
}

/**
 * Stamp a vertical capsule under each island, in place. Returns the number pinned.
 * @param opts {r: strut radius (mm), blend: smooth-min radius (mm)}
 */
export function pinIslands(f, g, islands, opts) {
  const { nx, ny, nz, h, ox, oy, oz, sdf } = g;
  const nxy = nx * ny;
  const r = opts.r, kb = opts.blend || 0;
  const kg = groundLayer(f, g);
  let pins = 0;
  for (const isl of islands) {
    const { i, j, k } = isl;
    let kHit = -1, kExit = -1;
    for (let kk = k - 1; kk >= 0; kk--) {
      const base = kk * nxy;
      let solid = false;
      for (let dj = -1; dj <= 1 && !solid; dj++) {
        const jj = j + dj; if (jj < 0 || jj >= ny) continue;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di; if (ii < 0 || ii >= nx) continue;
          if (f[base + jj * nx + ii] < 0) { solid = true; break; }
        }
      }
      if (solid) { kHit = kk; break; }
      if (sdf[base + j * nx + i] > 0) { kExit = kk; break; }
    }
    let kEnd;
    if (kHit >= 0) kEnd = kHit;
    else if (kExit >= 0 && kExit < kg) kEnd = kExit + 1; // reached the bed inside the part
    else if (kExit < 0) kEnd = 0;
    else continue; // hangs over air outside the part: nothing to pin to
    if (kEnd >= k) continue;
    const x = ox + i * h, y = oy + j * h;
    const z1 = oz + kEnd * h - r, z2 = oz + k * h + h;
    const R = r + kb;
    const i0 = Math.max(0, Math.floor((x - R - ox) / h)), i1 = Math.min(nx - 1, Math.ceil((x + R - ox) / h));
    const j0 = Math.max(0, Math.floor((y - R - oy) / h)), j1 = Math.min(ny - 1, Math.ceil((y + R - oy) / h));
    const k0 = Math.max(0, Math.floor((z1 - R - oz) / h)), k1 = Math.min(nz - 1, Math.ceil((z2 + R - oz) / h));
    for (let kk = k0; kk <= k1; kk++) {
      const pz = oz + kk * h;
      const dz = pz < z1 ? z1 - pz : pz > z2 ? pz - z2 : 0;
      for (let jj = j0; jj <= j1; jj++) {
        const dy = oy + jj * h - y;
        let idx = (kk * ny + jj) * nx + i0;
        for (let ii = i0; ii <= i1; ii++, idx++) {
          const dx = ox + ii * h - x;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz) - r;
          const v = smin(f[idx], d, kb);
          const sd = sdf[idx];
          f[idx] = v > sd ? v : sd;
        }
      }
    }
    pins++;
  }
  return pins;
}
