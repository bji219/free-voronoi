# free-voronoi

Free, in-browser tool that turns an STL or STEP model into a **volumetric** Voronoi lattice:
strands run through the whole body and meet the surface pattern node-for-node. Nothing is uploaded;
all geometry runs in a Web Worker.

```
npm install
npm run dev      # local dev server
npm test         # headless geometry checks (watertightness, density)
npm run build    # static site in dist/
```

## Parameters

| Control | Effect |
| --- | --- |
| Mode | Volume + skin, volume only, or hollow skin only |
| Pore size | Seed spacing (Poisson-disk), i.e. nominal cell diameter |
| Internal / skin strand Ø | Strut diameters inside the body and on the surface |
| Junction blend | Smooth-min fillet radius at every node |
| Resolution | Voxels along the longest axis (keep strands ≥ ~2.2 voxels) |
| Mesh smoothing | Taubin passes on the output mesh |

## How it works

1. **Voxelise** the mesh into a narrow-band signed distance field (3-axis parity vote for sign, exact
   point-triangle distances for magnitude) — `src/core/voxel.js`.
2. **Seed** a Poisson-disk layer on the surface, sunk a third of a cell inward, then Poisson-fill the
   interior against it — `src/core/seeds.js`.
3. **Field**: for each voxel take the four nearest seeds. Distance to plane-plane intersection lines
   gives the cell *edges* (internal strands); distance to bisector planes gives the cell *walls*, whose
   trace on the skin is the surface web. Because edges are where walls meet, internal strands land
   exactly on surface nodes. Everything is combined with a smooth-min and clipped to the body —
   `src/core/field.js`.
4. **Mesh** with welded marching cubes + Taubin smoothing, export binary STL — `src/core/mc.js`.

STEP files are tessellated with [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade, WASM).

## Deploy

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on pushes to `main`
(enable Pages → Source: GitHub Actions in the repo settings).
