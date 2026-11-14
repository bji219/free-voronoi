import { buildGrid } from './voxel.js';
import { makeSeeds } from './seeds.js';
import { evalField } from './field.js';
import { marchingCubes, taubin, signedVolume, soupVolume } from './mc.js';
import { findIslands, pinIslands } from './print.js';

export function soupBBox(t) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < t.length; i += 3) for (let a = 0; a < 3; a++) {
    const v = t[i + a];
    if (v < min[a]) min[a] = v;
    if (v > max[a]) max[a] = v;
  }
  return { min, max };
}

/**
 * Stateful generator: caches the voxel grid and seeds between runs so slider
 * tweaks only redo the stages they invalidate.
 */
export class Generator {
  setMesh(tris) {
    this.tris = tris;
    this.bbox = soupBBox(tris);
    this.volume = soupVolume(tris);
    this.grid = null; this.gridKey = '';
    this.seeds = null; this.seedKey = '';
  }

  /**
   * @param p {mode, pore, strandInt, strandSurf, blend, res, smooth, seed,
   *           shell?, keeps?, stretch?, pin?, shape?, jitter?, center?, axis?}  (see field.js / seeds.js / print.js)
   * @param tick async (stage, fraction) => bool  (false aborts)
   */
  async run(p, tick) {
    const t0 = performance.now();
    const size = [0, 1, 2].map((a) => this.bbox.max[a] - this.bbox.min[a]);
    const h = Math.max(...size) / p.res;
    const rInt = p.strandInt / 2, rSurf = p.strandSurf / 2;
    const k = p.blend;
    const shell = p.shell > 0 ? p.shell : 0;
    const stretch = p.stretch > 1 ? p.stretch : 1;
    const bandVox = Math.ceil(Math.max(1.6 * rSurf + k, shell + k) / h) + 2;

    if (!(await tick('Voxelising model', 0.02))) return null;
    const gk = `${p.res}|${bandVox}`;
    if (this.gridKey !== gk) {
      this.grid = null;
      this.grid = buildGrid(this.tris, this.bbox, p.res, bandVox);
      this.gridKey = gk;
    }
    if (!(await tick('Placing cells', 0.3))) return null;
    const shape = p.shape || 'random', jitter = p.jitter || 0;
    const sk = `${p.pore}|${p.seed}|${stretch}|${shape}|${jitter}|${p.center ? p.center.join(',') : ''}|${p.axis ?? ''}`;
    if (this.seedKey !== sk) {
      this.seeds = makeSeeds(this.tris, this.bbox, this.grid, p.pore, p.seed, { stretch, shape, jitter, center: p.center, axis: p.axis });
      this.seedKey = sk;
    }
    if (this.seeds.length < 6) throw new Error('Pore size is too large for this model — no cells fit.');

    const field = await evalField(this.grid, this.seeds, { mode: p.mode, pore: p.pore, rInt, rSurf, blend: k, shell, keeps: p.keeps, stretch },
      (f) => tick('Growing strands', 0.35 + 0.42 * f));
    if (!field) return null;

    if (!(await tick('Checking overhangs', 0.78))) return null;
    const rPin = p.mode === 'surface' ? rSurf : rInt;
    const minLayers = Math.max(2, Math.ceil((2 * rPin) / h)); // bridge undersides up to a strand diameter tall are fine
    let islands = findIslands(field, this.grid, minLayers), pins = 0;
    if (p.pin && islands.length) {
      pins = pinIslands(field, this.grid, islands, { r: rPin, blend: k });
      islands = findIslands(field, this.grid, minLayers);
    }
    const islandPts = new Float32Array(islands.length * 3);
    islands.forEach((s, n) => { islandPts[n * 3] = this.grid.ox + s.i * h; islandPts[n * 3 + 1] = this.grid.oy + s.j * h; islandPts[n * 3 + 2] = this.grid.oz + s.k * h; });

    if (!(await tick('Meshing', 0.82))) return null;
    const mesh = marchingCubes(field, this.grid);
    if (p.smooth > 0) {
      if (!(await tick('Smoothing', 0.92))) return null;
      taubin(mesh.positions, mesh.indices, p.smooth);
    }
    const volume = signedVolume(mesh.positions, mesh.indices);
    return {
      positions: mesh.positions,
      indices: mesh.indices,
      islands: islandPts,
      stats: {
        islands: islands.length,
        pins,
        triangles: mesh.indices.length / 3,
        cells: this.seeds.length / 3,
        voxel: h,
        grid: [this.grid.nx, this.grid.ny, this.grid.nz],
        volume,
        solidVolume: this.volume,
        density: this.volume > 0 ? volume / this.volume : 0,
        ms: performance.now() - t0,
        thin: Math.min(p.mode === 'surface' ? Infinity : p.strandInt, p.mode === 'volume' ? Infinity : p.strandSurf) / h,
      },
    };
  }
}
