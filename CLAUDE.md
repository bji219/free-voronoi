# free-voronoi

Browser tool: imports STL/STEP, outputs a **volumetric** Voronoi lattice as binary STL. Internal strands meet the surface web node-for-node. Everything runs client-side in a Web Worker; nothing is uploaded.
Remote: github.com/bji219/free-voronoi (private). Deployed by `.github/workflows/pages.yml` on push to `main`.

## Commands

```
npm install
npm run dev        # vite; use --port 5177 --strictPort for the browser tests
npm test           # 5 node scripts, ~80 checks, also runs in CI before build
npm run build      # static site in dist/
```

No linter or TypeScript. Plain ES modules, `"type": "module"`. Stack: Vite 8, three r187 (viewer + STLLoader + OrbitControls), occt-import-js (STEP, WASM).

## Layout

| Path | Role |
| --- | --- |
| `src/main.js` | All UI: viewer, controls, keep-cylinder picking, orientation, project save/load, persistence, worker messaging. Large and imperative, no framework. |
| `src/worker.js` | Worker shell: STEP tessellation, owns one `Generator`, relays progress/results (typed arrays are transferred). |
| `src/core/pipeline.js` | `Generator`: caches voxel grid and seeds across runs, so slider tweaks redo only invalidated stages. Cache keys live here. |
| `src/core/voxel.js` | Mesh to narrow-band SDF. Sign from 3-axis parity vote, magnitude from exact point-triangle distance. |
| `src/core/seeds.js` | Seed generation: Poisson-disk (`random`) or lattice presets (`cubic kelvin rhombic honeycomb radial`). |
| `src/core/field.js` | Per-voxel 4-nearest-seed Voronoi: bisector planes give walls, plane-plane lines give edges, smooth-min blend, then shell + keep cylinders, clipped to the body. |
| `src/core/print.js` | FDM island detection (`findIslands`, `absorbed`) and pin-down capsules (`pinIslands`). |
| `src/core/orient.js` | Quaternion helpers and `rotateSoup` for re-posing the imported mesh. |
| `src/core/mc.js` | Welded marching cubes, Taubin smoothing, volumes. |
| `src/stl.js` | Binary STL writer. |
| `test/*.test.mjs` | Node tests, no framework. Each prints `ok`/`FAIL` lines and exits non-zero on failure. |

## Architecture rules that are easy to break

- **Resolution is voxels along the longest bbox axis** (`h = D/res`). Pore, strand and blend defaults scale with part size in `onLoaded`. Thin plates are undersampled on the short axis; `checkWarn` warns below 8 voxels.
- **Orientation happens before voxelisation.** `orig` (raw soup) is rotated by `orient` about `pivot` (its bbox centre) and re-sent to the worker via `postMesh`. Re-posing keeps all settings (`reorienting` flag in `onLoaded`). Keep cylinders are rotated with the part (centre rotated, axis snapped to nearest principal axis).
- **Bisectors stay planes under FDM stretch.** The Z-stretch metric scales seed z by `1/stretch`; plane normals use `dz*zs`, strand radii stay Euclidean. Change `field.js` and `seeds.js` hashing together.
- **Narrow-band SDF is clamped.** Deep-inside voxels read as `-(band+h)`, not true depth. Anything needing depth must extend `bandVox` in `pipeline.js` (the shell does). Tests use analytic box depth for this reason.
- **Island detector tolerates bridges.** A blob is an island only if no solid sits in the 3x3 footprint below and it does not join supported material within `minLayers = max(2, ceil(2*rPin/h))`. Do not drop this, or horizontal strands report dozens of false islands.
- **Pins are skipped** if the column below leaves the part (it would hang over air).
- **Worker results are transferred**, so any new typed array in the result must be added to the transfer list in `worker.js`.
- **Seed cache key** in `pipeline.js` includes pore, seed, stretch, shape, jitter, center, axis. Add any new seed input there.
- **Final field** is `max(lattice, sdf)`: lattice clipped to the body. Shell and keeps are unioned into `lattice` via `smin` before the clip.

## UI state and persistence

- Per-file settings are stored in `localStorage` under `fv:part:<filename>` as a versioned project: `{app:'free-voronoi', v:1, file, params, keeps, printer, pin, orient}`. First entries were flat; `restore()` accepts both.
- **Save project** downloads the same JSON as `<name>.voronoi.json` (about 400 bytes, no geometry). Dropping it before the model stores it for that file name; after, it applies immediately.
- Keep cylinders: `{axis 0|1|2, d, wall, len, c:[x,y,z]}`. `wall>0` keeps a bore liner, `wall 0` a solid boss. Radial cell shape follows the first valid keep's axis and centre.
- While **Lay face flat** or a keep **Pick** is armed, the solid part is shown alone (`updateVisibility`), lattice and islands hidden.
- Test hooks: `window.__fv` (params, keeps, generate, setShape, setPrinter, setOrient, rotate90, layFlat, project, openProject, viz). `document.body.dataset.ready` holds the id of the last finished job, used for waiting in browser tests.
- Setting `__fv.params.x` directly does not regenerate. Go through the control (set value, dispatch `change`) or call `changed()` paths.

## Testing

`npm test` covers geometry only (watertight, density, keep fields, island detection, shapes, orientation math). UI is verified by hand or Playwright:

- Playwright Python in a venv, headless chromium with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist` (no GPU).
- Serve with the webapp-testing skill's `scripts/with_server.py --server "npx vite --port 5177 --strictPort" --port 5177 -- python <script>`.
- Real parts: `/Users/BrendanInglis/Documents/Intelligent Design Works Limited/CAD/FreeCad` (binary STLs, 8-120 mm). Main fixture: `01 OP1-SV2 Accessories/Production_STLs/op1_retro_knob_v3-Knob.stl` (17x17x14 mm). Its pot-shaft bore is r=3.10 along Z, z 2.3 to 10.1, counterbore r=3.65 below z 2.3. Good keep-cylinder test: d 6.2, wall 1.2, len 8.2, centre (0,0,6.2).
- Known results on the knob (raw, jitter 0.1): random 1 island, cubic 0, kelvin 4, rhombic 0, honeycomb 1, radial 3. FDM with shell 0.6 + bore liner: 0 islands.
- Z-stretch does not reliably reduce island count on small parts; it reduces steep-overhang area (about 49% in tests). Pins are the real island fix.

## Conventions

- Match existing style: terse, minimal comments that explain why, no new dependencies without need.
- New geometry behaviour gets a node test first; UI behaviour gets a Playwright check on the knob.
- Update the README parameter table and "How it works" when adding a user-visible control.
- Scratch scripts and screenshots go in the session scratchpad, not the repo.

## Status and open items

- Shipped: shell, keep cylinders with face picking, FDM mode (stretch, island detection, pins), six cell shapes plus jitter, orientation (90 degree nudges, Euler, lay-face-flat), project save/load, solid preview during picking.
- **GitHub Pages is not enabled**, so the deploy job 404s. Repo is private (Pages on private needs a paid plan): make it public or upgrade, then `gh api -X POST repos/bji219/free-voronoi/pages -f build_type=workflow` and rerun the failed workflow.
- Much of this work may be uncommitted; check `git status` first. The git repo is this nested folder, not the parent workspace.
- Ideas not built: keeping selected faces solid by face-picking (only shell + cylinders exist), thin-axis adaptive resolution for plate-like parts, true slicer simulation.
