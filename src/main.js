import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { toBinarySTL } from './stl.js';

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

const group = new THREE.Group();
scene.add(group);
let source = null, lattice = null, cap = null, grid = null;
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
const params = { mode: 'both', pore: 8, strandInt: 1.2, strandSurf: 1.4, blend: 0.6, res: 160, smooth: 2, seed: 1 };
const DEF = {
  pore: { min: 1, max: 50, step: 0.1 },
  strandInt: { min: 0.1, max: 10, step: 0.05 },
  strandSurf: { min: 0.1, max: 10, step: 0.05 },
  blend: { min: 0, max: 5, step: 0.05 },
  res: { min: 64, max: 320, step: 8 },
  smooth: { min: 0, max: 10, step: 1 },
};
let model = null; // {bbox, volume, name, triangles}
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
seg('#demo', (v) => loadDemo(v));
let cutAxis = 0;
seg('#cutAxis', (v) => { cutAxis = +v; updateCut(); });
$('#cut').addEventListener('input', updateCut);
$('#seed').addEventListener('change', () => { params.seed = Math.max(0, Math.floor(+$('#seed').value || 0)); changed(); });
$('#dice').addEventListener('click', () => { params.seed = Math.floor(Math.random() * 9999); $('#seed').value = params.seed; changed(); });
$('#ghost').addEventListener('change', updateVisibility);
$('#generate').addEventListener('click', () => generate());
$('#export').addEventListener('click', exportSTL);

function updateCut() {
  if (!model) return;
  const f = +$('#cut').value / 100;
  const n = new THREE.Vector3(); n.setComponent(cutAxis, -1);
  const lo = model.bbox.min[cutAxis], hi = model.bbox.max[cutAxis];
  clip.normal.copy(n);
  clip.constant = f >= 1 ? 1e9 : lo + (hi - lo) * f;
  dirty = true;
}
function updateVisibility() {
  if (source) {
    source.visible = !lattice || $('#ghost').checked;
    source.material = lattice ? matGhost : matSolid;
  }
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
  if (thin / h < 2.2) {
    w.hidden = false;
    w.textContent = `Strands are only ${(thin / h).toFixed(1)} voxels thick — they may break up. Raise resolution to ≥ ${need}${need > DEF.res.max ? ' (type it in)' : ''} or thicken the strands.`;
  } else w.hidden = true;
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
  result = null;
  $('#export').disabled = true;
  $('#stats').innerHTML = '';
  $('#empty').hidden = true;
}

function sendMesh(positions, name) {
  model = null;
  pendingName = name;
  showSource(positions);
  const copy = positions.slice();
  worker.postMessage({ type: 'mesh', positions: copy }, [copy.buffer]);
}
let pendingName = '';

async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  try {
    const buf = await file.arrayBuffer();
    if (ext === 'stl') {
      const geo = new STLLoader().parse(buf);
      sendMesh(new Float32Array(geo.attributes.position.array), file.name);
    } else if (ext === 'step' || ext === 'stp') {
      model = null; pendingName = file.name;
      setProgress('Reading STEP (loading CAD kernel)…', 0.15);
      worker.postMessage({ type: 'step', buffer: buf }, [buf]);
    } else toast('Unsupported file type — use .stl, .step or .stp');
  } catch (e) { toast(`Could not read ${file.name}: ${e.message}`); }
}

function loadDemo(kind) {
  let g;
  if (kind === 'sphere') g = new THREE.SphereGeometry(30, 64, 40);
  else if (kind === 'cube') g = new THREE.BoxGeometry(50, 50, 50);
  else if (kind === 'torus') g = new THREE.TorusGeometry(32, 13, 32, 96);
  else g = new THREE.TorusKnotGeometry(26, 9, 200, 28);
  sendMesh(new Float32Array(g.toNonIndexed().attributes.position.array), `demo ${kind}`);
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
  if (msg.positions) showSource(msg.positions);
  setProgress(null);
  model = { bbox: msg.bbox, volume: msg.volume, name: pendingName, triangles: msg.triangles };
  const size = msg.bbox.max.map((v, i) => v - msg.bbox.min[i]);
  const D = Math.max(...size);
  // scale slider ranges and defaults to the part
  const st = nice(D / 2000);
  DEF.pore = { min: snap(D / 30, { min: st, max: 1e9, step: st }), max: nice(D / 1.5), step: st };
  DEF.strandInt = { min: st, max: nice(D / 12), step: st };
  DEF.strandSurf = { ...DEF.strandInt };
  DEF.blend = { min: 0, max: nice(D / 25), step: st };
  params.pore = snap(Math.cbrt(msg.volume > 0 ? msg.volume : size[0] * size[1] * size[2]) / 4.5, DEF.pore);
  params.strandInt = snap(params.pore * 0.13, DEF.strandInt);
  params.strandSurf = snap(params.pore * 0.15, DEF.strandSurf);
  params.blend = snap(params.pore * 0.07, DEF.blend);
  for (const k of Object.keys(DEF)) syncCtl(k);
  $('#modelInfo').textContent = `${model.name} · ${size.map((s) => s.toFixed(1)).join(' × ')} mm · ${msg.triangles.toLocaleString()} triangles`;
  $('#generate').disabled = false;
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
  worker.postMessage({ type: 'generate', id: jobId, params: { ...params } });
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
    const mb = (84 + s.triangles * 50) / 1048576;
    $('#stats').innerHTML = [
      ['Relative density', `${(s.density * 100).toFixed(1)} %`],
      ['Lattice volume', `${fmtVol(s.volume)}`],
      ['Cells', s.cells.toLocaleString()],
      ['Triangles', `${s.triangles.toLocaleString()} (${mb.toFixed(1)} MB)`],
      ['Voxel', `${s.voxel.toFixed(3)} mm · ${s.grid.join('×')}`],
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
window.__fv = { params, generate, loadDemo, get result() { return result; } };
