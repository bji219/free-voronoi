import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { toBinarySTL } from './stl.js';
import { qIdentity, qAxisAngle, qMul, qInv, qBetween, qRotate, qToEuler, qFromEuler, rotateSoup, nearestAxis, soupCenter } from './core/orient.js';

const $ = (s) => document.querySelector(s);

// ---------------------------------------------------------------- viewer
const canvas = $('#view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.localClippingEnabled = true;
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
camera.up.set(0, 0, 1);
camera.position.set(120, -160, 110);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.12;
controls.addEventListener('change', () => (dirty = true));

scene.add(new THREE.HemisphereLight(0xffffff, 0x30343c, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 2.2);
const fill = new THREE.DirectionalLight(0xffc98a, 0.7);
camera.add(key, fill);
key.position.set(-1, 1.5, 1);
fill.position.set(2, -1, 0.5);
scene.add(camera);

const clip = new THREE.Plane(new THREE.Vector3(-1, 0, 0), 1e9);
const matLattice = new THREE.MeshStandardMaterial({ color: 0xd9dde4, roughness: 0.55, metalness: 0.05, clippingPlanes: [clip] });
// Back faces drawn flat in the accent colour read as solid cross-sections at the cut.
const matCap = new THREE.MeshBasicMaterial({ color: 0xff9d2e, side: THREE.BackSide, clippingPlanes: [clip] });
const matGhost = new THREE.MeshStandardMaterial({ color: 0x9fb4d8, transparent: true, opacity: 0.16, depthWrite: false, roughness: 0.8, side: THREE.DoubleSide });
const matSolid = new THREE.MeshStandardMaterial({ color: 0x6d7482, roughness: 0.7, side: THREE.DoubleSide });
const matKeep = new THREE.MeshBasicMaterial({ color: 0xff9d2e, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
const matKeepHot = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.4, depthWrite: false, side: THREE.DoubleSide });
const matIsland = new THREE.PointsMaterial({ color: 0xff3b30, size: 1, sizeAttenuation: true, depthTest: false, transparent: true, opacity: 0.95 });

const group = new THREE.Group();
scene.add(group);
const keepViz = new THREE.Group();
scene.add(keepViz);
let source = null, lattice = null, cap = null, grid = null, islandPts = null;
let dirty = true;

function resize() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
}
renderer.setAnimationLoop(() => {
  resize();
  if (controls.update()) dirty = true;
  if (dirty) { renderer.render(scene, camera); dirty = false; }
});

function frame(bbox) {
  const c = new THREE.Vector3().addVectors(new THREE.Vector3(...bbox.min), new THREE.Vector3(...bbox.max)).multiplyScalar(0.5);
  const r = new THREE.Vector3(...bbox.max).distanceTo(new THREE.Vector3(...bbox.min)) / 2;
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(0.75, -1.1, 0.7).normalize().multiplyScalar(r / Math.sin((camera.fov * Math.PI) / 360) * 0.8));
  camera.near = r / 100; camera.far = r * 50;
  camera.updateProjectionMatrix();
  if (grid) { scene.remove(grid); grid.geometry.dispose(); }
  const span = nice(r * 4);
  grid = new THREE.GridHelper(span, 20, 0x3a3f4b, 0x23262e);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(c.x, c.y, bbox.min[2]);
  scene.add(grid);
  dirty = true;
}

// ---------------------------------------------------------------- state
const params = { mode: 'both', pore: 8, strandInt: 1.2, strandSurf: 1.4, blend: 0.6, res: 160, smooth: 2, seed: 1, shell: 0, stretch: 1.5, shape: 'random', jitter: 0.1 };
const DEF = {
  jitter: { min: 0, max: 1, step: 0.05 },
  pore: { min: 1, max: 50, step: 0.1 },
  strandInt: { min: 0.1, max: 10, step: 0.05 },
  strandSurf: { min: 0.1, max: 10, step: 0.05 },
  blend: { min: 0, max: 5, step: 0.05 },
  res: { min: 64, max: 320, step: 8 },
  smooth: { min: 0, max: 10, step: 1 },
  shell: { min: 0, max: 5, step: 0.05 },
  stretch: { min: 1, max: 2.5, step: 0.05 },
};
// keep cylinders: {axis:0|1|2, d (Ø mm), wall (mm, 0 = solid), len (mm), c:[x,y,z]}
let keeps = [];
let printer = 'raw';
let picking = -1; // index of the keep waiting for a click in the view
let model = null; // {bbox, volume, name, triangles}
// orientation: the part as imported (orig) is rotated by `orient` about its bbox centre before voxelisation
let orig = null, pivot = [0, 0, 0], orient = qIdentity();
let laying = false; // waiting for a click on the face that should lie on the bed
let reorienting = false; // the next 'loaded' message is a re-pose, keep the user's settings
let result = null; // {positions, indices, stats}
let jobId = 0, busy = false, queued = false, timer = 0;

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });

// ---------------------------------------------------------------- controls
const nice = (v) => { const p = Math.pow(10, Math.floor(Math.log10(v))); const m = v / p; return (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p; };
const dec = (step) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
const snap = (v, d) => Math.min(d.max, Math.max(d.min, Math.round(v / d.step) * d.step));

function syncCtl(name) {
  const el = document.querySelector(`.ctl[data-p=${name}]`);
  const d = DEF[name];
  const [num, range] = el.querySelectorAll('input');
  for (const i of [num, range]) { i.min = d.min; i.max = d.max; i.step = d.step; }
  num.value = params[name].toFixed(dec(d.step));
  range.value = params[name];
}
for (const el of document.querySelectorAll('.ctl')) {
  const name = el.dataset.p;
  const [num, range] = el.querySelectorAll('input');
  range.addEventListener('input', () => { params[name] = +range.value; num.value = params[name].toFixed(dec(DEF[name].step)); changed(); });
  num.addEventListener('change', () => {
    const d = DEF[name];
    let v = parseFloat(num.value);
    if (!isFinite(v)) v = params[name];
    v = Math.max(d.min, v);
    if (v > d.max) d.max = v; // typed values may exceed the slider range
    params[name] = v; syncCtl(name); changed();
  });
  syncCtl(name);
}
function seg(id, cb) {
  const root = $(id);
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    for (const x of root.children) x.classList.toggle('on', x === b);
    cb(b.dataset.v);
  });
}
seg('#mode', (v) => { params.mode = v; changed(); });
seg('#shape', (v) => { params.shape = v; syncShape(); persist(); changed(); });
function syncShape() { $('#jitterCtl').classList.toggle('gone', params.shape === 'random'); } // jitter only applies to lattice shapes
function setSeg(id, v) { for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === v); }
syncShape();
seg('#demo', (v) => loadDemo(v));
let cutAxis = 0;
seg('#cutAxis', (v) => { cutAxis = +v; updateCut(); });
$('#cut').addEventListener('input', updateCut);
$('#seed').addEventListener('change', () => { params.seed = Math.max(0, Math.floor(+$('#seed').value || 0)); changed(); });
$('#dice').addEventListener('click', () => { params.seed = Math.floor(Math.random() * 9999); $('#seed').value = params.seed; changed(); });
$('#ghost').addEventListener('change', updateVisibility);
$('#generate').addEventListener('click', () => generate());
$('#export').addEventListener('click', exportSTL);
seg('#printer', (v) => { printer = v; syncPrinter(); persist(); changed(); });
$('#pin').addEventListener('change', () => { persist(); changed(); });
$('#showIslands').addEventListener('change', updateVisibility);
function syncPrinter() { $('#fdmCtls').classList.toggle('off', printer !== 'fdm'); }
syncPrinter();

// ---------------------------------------------------------------- keep cylinders
const AXIS = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
function keepsForWorker() {
  return keeps.filter((K) => K.d > 0 && K.len > 0).map((K) => ({ c: K.c.slice(), a: AXIS[K.axis], r: K.d / 2, len: K.len, wall: K.wall }));
}
function newKeep() {
  const size = model.bbox.max.map((v, i) => v - model.bbox.min[i]);
  const D = Math.max(...size), st = DEF.strandInt.step;
  const c = model.bbox.min.map((v, i) => v + size[i] / 2);
  return { axis: 2, d: snap(D / 4, { min: st, max: 1e9, step: st }), wall: snap(Math.max(params.strandSurf * 1.5, D / 20), { min: 0, max: 1e9, step: st }), len: snap(size[2] * 1.2, { min: st, max: 1e9, step: st }), c };
}
function renderKeeps() {
  const root = $('#keeps');
  const fmt = (v) => (+v).toFixed(dec(DEF.strandInt.step));
  root.innerHTML = keeps.map((K, n) => `
    <div class="keep${n === picking ? ' picking' : ''}" data-n="${n}">
      <div class="seg axis">${['X', 'Y', 'Z'].map((a, i) => `<button data-v="${i}"${K.axis === i ? ' class="on"' : ''}>${a}</button>`).join('')}</div>
      <label>Ø mm<input type="number" data-f="d" value="${fmt(K.d)}" min="0" step="${DEF.strandInt.step}" /></label>
      <label title="0 = solid boss, >0 = liner around a bore">wall<input type="number" data-f="wall" value="${fmt(K.wall)}" min="0" step="${DEF.strandInt.step}" /></label>
      <label>length<input type="number" data-f="len" value="${fmt(K.len)}" min="0" step="${DEF.strandInt.step}" /></label>
      <button class="mini pick${n === picking ? ' on' : ''}" title="Click the bore / boss face in the view">${n === picking ? 'Click…' : 'Pick'}</button>
      <button class="mini del" title="Remove">✕</button>
      <div class="xyz">${['X', 'Y', 'Z'].map((a, i) => `<label>centre ${a}<input type="number" data-f="c${i}" value="${K.c[i].toFixed(2)}" step="0.1" /></label>`).join('')}</div>
    </div>`).join('');
  updateKeepViz();
  updateVisibility();
}
function updateKeepViz() {
  for (const m of keepViz.children) m.geometry.dispose();
  keepViz.clear();
  keeps.forEach((K, n) => {
    if (!(K.d > 0 && K.len > 0)) return;
    const r = K.d / 2, ri = K.wall > 0 ? Math.max(0, r - K.wall) : 0;
    const g = new THREE.CylinderGeometry(r, r, K.len, 48, 1, ri > 0);
    const m = new THREE.Mesh(g, n === picking ? matKeepHot : matKeep);
    if (ri > 0) m.add(new THREE.Mesh(new THREE.CylinderGeometry(ri, ri, K.len, 48, 1, true), m.material));
    if (K.axis === 0) m.rotation.z = -Math.PI / 2; else if (K.axis === 2) m.rotation.x = Math.PI / 2;
    m.position.set(K.c[0], K.c[1], K.c[2]);
    keepViz.add(m);
  });
  dirty = true;
}
$('#addKeep').addEventListener('click', () => {
  if (!model) { toast('Load a model first.'); return; }
  keeps.push(newKeep());
  picking = keeps.length - 1;
  canvas.classList.add('picking');
  renderKeeps(); persist(); changed();
});
$('#keeps').addEventListener('click', (e) => {
  const row = e.target.closest('.keep'); if (!row) return;
  const n = +row.dataset.n, K = keeps[n];
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.v != null) { K.axis = +b.dataset.v; renderKeeps(); persist(); changed(); }
  else if (b.classList.contains('del')) { keeps.splice(n, 1); if (picking === n) picking = -1; else if (picking > n) picking--; canvas.classList.toggle('picking', picking >= 0); renderKeeps(); persist(); changed(); }
  else if (b.classList.contains('pick')) { picking = picking === n ? -1 : n; canvas.classList.toggle('picking', picking >= 0); renderKeeps(); }
});
$('#keeps').addEventListener('change', (e) => {
  const row = e.target.closest('.keep'), f = e.target.dataset.f; if (!row || !f) return;
  const K = keeps[+row.dataset.n];
  let v = parseFloat(e.target.value); if (!isFinite(v)) v = 0;
  if (f[0] === 'c' && f.length === 2) K.c[+f[1]] = v; else K[f] = Math.max(0, v);
  renderKeeps(); persist(); changed();
});
// click in the view while picking: snap the cylinder centre onto the axis of the clicked face
const ray = new THREE.Raycaster();
let downAt = null;
canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
canvas.addEventListener('pointerup', (e) => {
  if ((picking < 0 && !laying) || !source || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const rect = canvas.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
  const hit = ray.intersectObject(source, false).find((h) => clip.distanceToPoint(h.point) >= 0);
  if (!hit) { toast('Click on the model surface.'); return; }
  if (laying) { // roll the part so the clicked face points straight down
    const fn = hit.face.normal;
    setLaying(false);
    setOrient(qMul(qBetween([fn.x, fn.y, fn.z], [0, 0, -1]), orient));
    return;
  }
  const K = keeps[picking]; if (!K) return;
  const n = hit.face.normal.clone();
  // the mesh normal points out of the solid: into a bore, away from a boss
  const to = n.multiplyScalar(K.wall > 0 ? K.d / 2 : -K.d / 2);
  const c = hit.point.clone().add(to);
  const a = K.axis;
  const ext = model.bbox.max[a] - model.bbox.min[a];
  const mid = (model.bbox.max[a] + model.bbox.min[a]) / 2;
  K.c = [c.x, c.y, c.z];
  K.c[a] = K.len >= ext ? mid : hit.point.getComponent(a);
  picking = -1; canvas.classList.remove('picking');
  renderKeeps(); persist(); changed();
});

// per-part settings survive a reload
const storeKey = () => `fv:part:${pendingName}`;
function persist() {
  if (!model && !reorienting) return;
  try { localStorage.setItem(storeKey(), JSON.stringify(project())); } catch {}
}
// everything that describes a result for a given file: settings, keep cylinders, pose
function project() {
  return { app: 'free-voronoi', v: 1, file: pendingName, params: { ...params }, keeps: keeps.map((K) => ({ ...K, c: K.c.slice() })), printer, pin: $('#pin').checked, orient: orient.slice() };
}
function storedOrient() {
  try {
    const q = JSON.parse(localStorage.getItem(storeKey()) || 'null')?.orient;
    return Array.isArray(q) && q.length === 4 && q.every(Number.isFinite) ? q : qIdentity();
  } catch { return qIdentity(); }
}
const isIdentity = (q) => Math.abs(q[3]) > 0.9999999;

// ---------------------------------------------------------------- orientation
function setOrient(q) {
  if (!orig) return;
  // carry existing keep cylinders into the new pose
  const delta = qMul(q, qInv(orient));
  for (const K of keeps) {
    const r = qRotate(delta, K.c.map((v, i) => v - pivot[i]));
    K.c = r.map((v, i) => v + pivot[i]);
    const ax = [0, 0, 0]; ax[K.axis] = 1;
    K.axis = nearestAxis(qRotate(delta, ax));
  }
  orient = q;
  reorienting = true;
  persist();
  syncEuler();
  postMesh(rotateSoup(orig, orient, pivot));
}
function setLaying(v) {
  laying = v;
  canvas.classList.toggle('laying', v);
  $('#layFlat').classList.toggle('on', v);
  $('#layFlat').textContent = v ? 'Click a face…' : 'Lay face flat';
  if (v && picking >= 0) { picking = -1; canvas.classList.remove('picking'); renderKeeps(); }
  updateVisibility();
}
function syncEuler() {
  const e = qToEuler(orient);
  document.querySelectorAll('#orient input[data-e]').forEach((i, k) => { i.value = Math.round(e[k] * 10) / 10; });
}
$('#orient .ogrid').addEventListener('click', (e) => {
  const b = e.target.closest('.rot button'); if (!b) return;
  setOrient(qMul(qAxisAngle(+b.dataset.a, +b.dataset.d * Math.PI / 2), orient));
});
document.querySelectorAll('#orient input[data-e]').forEach((inp) => inp.addEventListener('change', () => {
  const e = [...document.querySelectorAll('#orient input[data-e]')].map((i) => parseFloat(i.value) || 0);
  setOrient(qFromEuler(e));
}));
$('#orientReset').addEventListener('click', () => setOrient(qIdentity()));
$('#layFlat').addEventListener('click', () => { if (orig) setLaying(!laying); });
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (!s) return false;
    const sp = s.params || s; // v1 projects nest params; the first per-part entries were flat
    for (const k of Object.keys(params)) {
      if (!(k in sp)) continue;
      const v = sp[k];
      if (typeof params[k] === 'number') { if (Number.isFinite(+v)) { params[k] = +v; if (DEF[k] && params[k] > DEF[k].max) DEF[k].max = params[k]; } }
      else if (typeof v === 'string') params[k] = v;
    }
    keeps = Array.isArray(s.keeps) ? s.keeps.filter((K) => K && Array.isArray(K.c)) : [];
    printer = s.printer === 'fdm' ? 'fdm' : 'raw'; $('#pin').checked = s.pin !== false;
    setSeg('#printer', printer); setSeg('#mode', params.mode); $('#seed').value = params.seed;
    return true;
  } catch { return false; }
}

function updateCut() {
  if (!model) return;
  const f = +$('#cut').value / 100;
  const n = new THREE.Vector3(); n.setComponent(cutAxis, -1);
  const lo = model.bbox.min[cutAxis], hi = model.bbox.max[cutAxis];
  clip.normal.copy(n);
  clip.constant = f >= 1 ? 1e9 : lo + (hi - lo) * f;
  dirty = true;
}
// While a pick mode is armed (lay-flat or a keep cylinder) the solid part is shown on its own,
// so the face to click is the real one and not a strand in front of it.
function updateVisibility() {
  const preview = laying || picking >= 0;
  if (source) {
    source.visible = preview || !lattice || $('#ghost').checked;
    source.material = lattice && !preview ? matGhost : matSolid;
  }
  if (lattice) lattice.visible = cap.visible = !preview;
  if (islandPts) islandPts.visible = !preview && $('#showIslands').checked;
  dirty = true;
}

function changed() {
  checkWarn();
  if (!model || !$('#auto').checked) return;
  clearTimeout(timer);
  timer = setTimeout(generate, 220);
}
function checkWarn() {
  const w = $('#warn');
  if (!model) { w.hidden = true; return; }
  const size = model.bbox.max.map((v, i) => v - model.bbox.min[i]);
  const h = Math.max(...size) / params.res;
  const thin = Math.min(params.mode === 'surface' ? Infinity : params.strandInt, params.mode === 'volume' ? Infinity : params.strandSurf);
  const need = Math.ceil((Math.max(...size) / (thin / 2.2)) / 8) * 8;
  const msgs = [];
  if (thin / h < 2.2) msgs.push(`Strands are only ${(thin / h).toFixed(1)} voxels thick — they may break up. Raise resolution to ≥ ${need}${need > DEF.res.max ? ' (type it in)' : ''} or thicken the strands.`);
  const tv = Math.min(...size) / h;
  if (tv < 8) msgs.push(`The part is only ${tv.toFixed(1)} voxels across its thinnest axis (${Math.min(...size).toFixed(2)} mm) — resolution follows the longest axis, so thin plates lose detail. Raise resolution.`);
  w.hidden = msgs.length === 0;
  w.textContent = msgs.join(' ');
}

// ---------------------------------------------------------------- loading
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 7000);
}
function setProgress(stage, f) {
  $('#progress').hidden = stage == null;
  if (stage != null) { $('#bar').style.width = `${Math.round(f * 100)}%`; $('#stageLabel').textContent = stage; }
}

function showSource(positions) {
  if (source) { group.remove(source); source.geometry.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.computeVertexNormals();
  source = new THREE.Mesh(g, matSolid);
  group.add(source);
  if (lattice) { group.remove(lattice, cap); lattice.geometry.dispose(); lattice = cap = null; }
  if (islandPts) { scene.remove(islandPts); islandPts.geometry.dispose(); islandPts = null; }
  $('#islandInfo').textContent = '';
  result = null;
  $('#export').disabled = true;
  $('#stats').innerHTML = '';
  $('#empty').hidden = true;
}

function postMesh(positions) {
  model = null;
  showSource(positions);
  const copy = positions.slice();
  worker.postMessage({ type: 'mesh', positions: copy }, [copy.buffer]);
}
// a fresh import: remember the raw soup, re-apply the orientation saved for this part
function importMesh(positions, name) {
  pendingName = name;
  orig = positions; pivot = soupCenter(positions);
  orient = storedOrient(); reorienting = false;
  setLaying(false); syncEuler();
  postMesh(isIdentity(orient) ? positions : rotateSoup(positions, orient, pivot));
}
let pendingName = '';

async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    const buf = await file.arrayBuffer();
    if (ext === 'stl') {
      const geo = new STLLoader().parse(buf);
      importMesh(new Float32Array(geo.attributes.position.array), file.name);
    } else if (ext === 'step' || ext === 'stp') {
      model = null; orig = null; pendingName = file.name;
      setProgress('Reading STEP (loading CAD kernel)…', 0.15);
      worker.postMessage({ type: 'step', buffer: buf }, [buf]);
    }
    else if (ext === 'json') openProject(JSON.parse(new TextDecoder().decode(buf)), file.name);
    else toast('Unsupported file type — use .stl, .step, .stp or a saved .json project');
  } catch (e) { toast(`Could not read ${file.name}: ${e.message}`); }
}
function saveProject() {
  if (!model) return;
  const blob = new Blob([JSON.stringify(project(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${model.name.replace(/\.(stl|step|stp)$/i, '')}.voronoi.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
// A project is the per-part settings entry plus the file name it belongs to. Opening one stores it
// under that file name, so it applies when the file is (re)loaded — or immediately if it already is.
function openProject(pj, fname) {
  if (!pj || pj.app !== 'free-voronoi' || !pj.params) { toast(`${fname} is not a free-voronoi project file.`); return; }
  const target = pj.file || (model && model.name);
  if (!target) { toast('Load the model first, or save the project from a loaded model so it names its file.'); return; }
  try { localStorage.setItem(`fv:part:${target}`, JSON.stringify(pj)); } catch {}
  if (!model || model.name !== target) { toast(`Settings for ${target} loaded — drop that file to apply them.`); return; }
  restore();
  for (const k of Object.keys(DEF)) syncCtl(k);
  setSeg('#shape', params.shape); syncShape(); syncPrinter(); renderKeeps(); persist();
  const q = Array.isArray(pj.orient) && pj.orient.length === 4 ? pj.orient : qIdentity();
  if (q.some((v, i) => Math.abs(v - orient[i]) > 1e-6)) { const k = keeps; keeps = []; setOrient(q); keeps = k; } // keeps are already in the project's frame
  else changed();
}
$('#saveProj').addEventListener('click', saveProject);

function loadDemo(kind) {
  let g;
  if (kind === 'sphere') g = new THREE.SphereGeometry(30, 64, 40);
  else if (kind === 'cube') g = new THREE.BoxGeometry(50, 50, 50);
  else if (kind === 'torus') g = new THREE.TorusGeometry(32, 13, 32, 96);
  else g = new THREE.TorusKnotGeometry(26, 9, 200, 28);
  importMesh(new Float32Array(g.toNonIndexed().attributes.position.array), `demo ${kind}`);
}

$('#pick').addEventListener('click', () => $('#file').click());
$('#file').addEventListener('change', (e) => { if (e.target.files[0]) loadFile(e.target.files[0]); e.target.value = ''; });
addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dragging'); });
addEventListener('dragleave', () => document.body.classList.remove('dragging'));
addEventListener('drop', (e) => {
  e.preventDefault(); document.body.classList.remove('dragging');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});

function onLoaded(msg) {
  if (msg.positions) { // STEP tessellated in the worker: treat it like a fresh import
    if (!orig) {
      orig = msg.positions; pivot = soupCenter(orig); orient = storedOrient(); reorienting = false; setLaying(false); syncEuler();
      if (!isIdentity(orient)) { postMesh(rotateSoup(orig, orient, pivot)); return; }
    }
    showSource(msg.positions);
  }
  setProgress(null);
  model = { bbox: msg.bbox, volume: msg.volume, name: pendingName, triangles: msg.triangles };
  const size = msg.bbox.max.map((v, i) => v - msg.bbox.min[i]);
  const D = Math.max(...size);
  $('#orient').classList.remove('off');
  if (reorienting) { // same part, new pose: keep every setting, just rebuild
    reorienting = false;
    $('#modelInfo').textContent = `${model.name} · ${size.map((s) => s.toFixed(1)).join(' × ')} mm · ${msg.triangles.toLocaleString()} triangles`;
    renderKeeps(); frame(msg.bbox); updateCut(); updateVisibility(); checkWarn(); generate();
    return;
  }
  // scale slider ranges and defaults to the part
  const st = nice(D / 2000);
  DEF.pore = { min: snap(D / 30, { min: st, max: 1e9, step: st }), max: nice(D / 1.5), step: st };
  DEF.strandInt = { min: st, max: nice(D / 12), step: st };
  DEF.strandSurf = { ...DEF.strandInt };
  DEF.blend = { min: 0, max: nice(D / 25), step: st };
  DEF.shell = { min: 0, max: nice(D / 5), step: st };
  params.pore = snap(Math.cbrt(msg.volume > 0 ? msg.volume : size[0] * size[1] * size[2]) / 4.5, DEF.pore);
  params.strandInt = snap(params.pore * 0.13, DEF.strandInt);
  params.strandSurf = snap(params.pore * 0.15, DEF.strandSurf);
  params.blend = snap(params.pore * 0.07, DEF.blend);
  params.shell = 0; keeps = []; picking = -1; canvas.classList.remove('picking');
  params.shape = 'random'; params.jitter = 0.1;
  restore();
  for (const k of Object.keys(DEF)) syncCtl(k);
  setSeg('#shape', params.shape); syncShape();
  syncPrinter();
  renderKeeps();
  $('#modelInfo').textContent = `${model.name} · ${size.map((s) => s.toFixed(1)).join(' × ')} mm · ${msg.triangles.toLocaleString()} triangles`;
  $('#generate').disabled = false; $('#saveProj').disabled = false;
  frame(msg.bbox);
  updateCut();
  updateVisibility();
  checkWarn();
  generate();
}

// ---------------------------------------------------------------- generate
function generate() {
  if (!model) return;
  clearTimeout(timer);
  jobId++;
  busy = true;
  setProgress('Starting', 0.01);
  const fdm = printer === 'fdm';
  const K = keeps.find((K) => K.d > 0 && K.len > 0); // radial cells follow the first keep cylinder's axis
  worker.postMessage({ type: 'generate', id: jobId, params: { ...params, keeps: keepsForWorker(), stretch: fdm ? params.stretch : 1, pin: fdm && $('#pin').checked, center: K ? K.c.slice() : null, axis: K ? K.axis : 2 } });
}

worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'loaded') return onLoaded(m);
  if (m.type === 'error') { busy = false; setProgress(null); toast(m.message); return; }
  if (m.id !== jobId) return;
  if (m.type === 'progress') setProgress(m.stage, m.fraction);
  if (m.type === 'result') {
    busy = false;
    setProgress(null);
    result = m;
    if (lattice) { group.remove(lattice, cap); lattice.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.positions, 3));
    g.setIndex(new THREE.BufferAttribute(m.indices, 1));
    g.computeVertexNormals();
    lattice = new THREE.Mesh(g, matLattice);
    cap = new THREE.Mesh(g, matCap);
    group.add(cap, lattice);
    updateVisibility();
    $('#export').disabled = false;
    const s = m.stats;
    if (islandPts) { scene.remove(islandPts); islandPts.geometry.dispose(); islandPts = null; }
    if (m.islands.length) {
      const ig = new THREE.BufferGeometry();
      ig.setAttribute('position', new THREE.BufferAttribute(m.islands, 3));
      matIsland.size = s.voxel * 6;
      islandPts = new THREE.Points(ig, matIsland);
      islandPts.renderOrder = 10;
      islandPts.visible = !(laying || picking >= 0) && $('#showIslands').checked;
      scene.add(islandPts);
    }
    $('#islandInfo').textContent = s.islands === 0
      ? (s.pins ? `No floating islands — ${s.pins} pin${s.pins > 1 ? 's' : ''} added.` : 'No floating islands: every layer has something under it.')
      : `${s.islands} floating island${s.islands > 1 ? 's' : ''}${s.pins ? ` left after ${s.pins} pins (these hang over open air)` : ''} — on FDM each starts a layer in mid-air. Switch to FDM-ready or add supports.`;
    const mb = (84 + s.triangles * 50) / 1048576;
    $('#stats').innerHTML = [
      ['Relative density', `${(s.density * 100).toFixed(1)} %`],
      ['Lattice volume', `${fmtVol(s.volume)}`],
      ['Cells', s.cells.toLocaleString()],
      ['Triangles', `${s.triangles.toLocaleString()} (${mb.toFixed(1)} MB)`],
      ['Voxel', `${s.voxel.toFixed(3)} mm · ${s.grid.join('×')}`],
      ['Islands', `${s.islands}${s.pins ? ` · ${s.pins} pinned` : ''}`],
      ['Compute', `${(s.ms / 1000).toFixed(2)} s`],
    ].map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join('');
    document.body.dataset.ready = String(jobId);
  }
};
const fmtVol = (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} cm³` : `${v.toFixed(1)} mm³`);

function exportSTL() {
  if (!result) return;
  const blob = new Blob([toBinarySTL(result.positions, result.indices)], { type: 'model/stl' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${model.name.replace(/\.(stl|step|stp)$/i, '').replace(/\s+/g, '-')}-voronoi.stl`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// test hooks
window.__fv = { params, generate, loadDemo, setOrient, project, openProject, viz() { return { lattice: !!lattice && lattice.visible, source: !!source && source.visible, solid: !!source && source.material === matSolid }; }, get orient() { return orient; }, rotate90(a, d) { setOrient(qMul(qAxisAngle(a, d * Math.PI / 2), orient)); }, layFlat(n) { setOrient(qMul(qBetween(n, [0, 0, -1]), orient)); }, get result() { return result; }, get keeps() { return keeps; }, set keeps(v) { keeps = v; renderKeeps(); persist(); changed(); }, setPrinter(v) { printer = v; setSeg('#printer', v); syncPrinter(); changed(); }, setShape(v, j) { params.shape = v; if (j != null) params.jitter = j; setSeg('#shape', v); syncShape(); syncCtl('jitter'); changed(); } };
