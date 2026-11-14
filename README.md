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
| Cell shape | *Random* Poisson foam, or a lattice: *Cubic*, *Kelvin* (BCC, truncated octahedra), *Rhombic* (FCC, rhombic dodecahedra), *Honeycomb* (hex prisms along Z), *Radial* (rings about Z, or about the first keep cylinder's axis) |
| Jitter | 0 = perfect lattice, 1 = scrambled; lattice shapes only |
| Pore size | Nearest-seed distance (Poisson-disk radius or lattice pitch), i.e. nominal cell diameter |
| Internal / skin strand Ø | Strut diameters inside the body and on the surface |
| Junction blend | Smooth-min fillet radius at every node |
| Resolution | Voxels along the longest axis (keep strands ≥ ~2.2 voxels) |
| Mesh smoothing | Taubin passes on the output mesh |
| Orientation | Re-pose the part before anything is computed: ±90° nudges, typed X·Y·Z angles, or **Lay face flat** then click the face that should sit on the bed (Z up). Keep cylinders follow the part |
| Save project | Downloads a small `.json` with every setting, keep cylinder and the pose for the loaded file. Drop it back on the page (before or after the model) to restore. The same data is kept in the browser per file name automatically |
| Solid shell | Keep everything within *n* mm of every surface solid (mating faces, bores, outer skin) |
| Keep cylinders | Capped cylinders kept solid: wall > 0 keeps a liner around a bore, wall 0 keeps a solid boss. **Pick** then click the face in the view to snap the centre onto its axis |
| Printer | *Raw* leaves the lattice as generated. *FDM-ready* stretches cells along Z (strands lean nearer vertical) and drops a vertical pin from every floating island to the strand below it |
| Highlight islands | Red dots mark material that starts in mid-air on an FDM printer (nothing within one voxel below) and does not re-attach to supported material within one strand diameter, so the underside of a bridge is not flagged. Shown in both modes |

Keep-solid and printer settings are remembered per file name in the browser.

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
4. **Keep solid**: the shell field `-sdf - shell` and capped-cylinder SDFs are unioned into the strand field
   with the same smooth-min, then everything is clipped to the body.
5. **Print checks** (`src/core/print.js`): each layer of the voxel field is split into 8-connected blobs; a
   blob with no solid voxel in the 3×3 footprint below is an island, unless the material above it joins
   supported material within a strand diameter (bridge undersides). FDM mode evaluates the Voronoi in a
   metric scaled along Z (bisectors stay planes, strand radii stay Euclidean) and stamps a vertical capsule
   from each island down to the first solid below it, or to the bed if the column stays inside the part.
6. **Mesh** with welded marching cubes + Taubin smoothing, export binary STL — `src/core/mc.js`.

STEP files are tessellated with [occt-import-js](https://github.com/kovacsv/occt-import-js) (OpenCascade, WASM).

## Deploy

`.github/workflows/pages.yml` builds and publishes to GitHub Pages on pushes to `main`
(enable Pages → Source: GitHub Actions in the repo settings).
