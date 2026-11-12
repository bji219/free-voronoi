import { Generator, soupBBox } from './core/pipeline.js';
import occtWasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';

const gen = new Generator();
let latest = 0;
let occtPromise = null;

const yieldNow = () => new Promise((r) => setTimeout(r, 0));

async function stepToSoup(buffer) {
  if (!occtPromise) {
    occtPromise = import('occt-import-js').then((m) => (m.default || m)({ locateFile: () => occtWasmUrl }));
  }
  const occt = await occtPromise;
  const res = occt.ReadStepFile(new Uint8Array(buffer), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.0005, angularDeflection: 0.3 });
  if (!res.success || !res.meshes.length) throw new Error('Could not read any solid from this STEP file.');
  let n = 0;
  for (const m of res.meshes) n += (m.index ? m.index.array.length : m.attributes.position.array.length / 3) * 3;
  const out = new Float32Array(n);
  let o = 0;
  for (const m of res.meshes) {
    const p = m.attributes.position.array;
    if (m.index) {
      const idx = m.index.array;
      for (let i = 0; i < idx.length; i++) { const v = idx[i] * 3; out[o++] = p[v]; out[o++] = p[v + 1]; out[o++] = p[v + 2]; }
    } else {
      for (let i = 0; i < p.length; i++) out[o++] = p[i];
    }
  }
  return out;
}

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'mesh' || msg.type === 'step') {
      latest++;
      const tris = msg.type === 'step' ? await stepToSoup(msg.buffer) : msg.positions;
      if (tris.length < 36) throw new Error('The file contains no usable triangles.');
      gen.setMesh(tris);
      const reply = { type: 'loaded', bbox: soupBBox(tris), volume: gen.volume, triangles: tris.length / 9 };
      if (msg.type === 'step') reply.positions = tris.slice();
      self.postMessage(reply, reply.positions ? [reply.positions.buffer] : []);
    } else if (msg.type === 'generate') {
      const id = ++latest;
      let last = 0;
      const tick = async (stage, fraction) => {
        const now = performance.now();
        if (now - last > 40 || fraction < 0.4) {
          self.postMessage({ type: 'progress', id: msg.id, stage, fraction });
          await yieldNow();
          last = performance.now();
        }
        return id === latest;
      };
      const r = await gen.run(msg.params, tick);
      if (!r || id !== latest) return;
      self.postMessage({ type: 'result', id: msg.id, ...r }, [r.positions.buffer, r.indices.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err?.message || String(err) });
  }
};
