// Copies the MediaPipe WASM runtime out of node_modules and downloads the
// hand_landmarker.task model so the app runs fully locally (no CDN at runtime).
import { cpSync, existsSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = resolve(root, 'public/mediapipe/wasm');
const modelDst = resolve(root, 'public/models/hand_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

if (existsSync(wasmSrc)) {
  mkdirSync(wasmDst, { recursive: true });
  cpSync(wasmSrc, wasmDst, { recursive: true });
  console.log('[assets] copied MediaPipe wasm ->', wasmDst);
} else {
  console.warn('[assets] node_modules/@mediapipe/tasks-vision not installed yet; skipping wasm copy');
}

if (existsSync(modelDst) && statSync(modelDst).size > 1_000_000) {
  console.log('[assets] model already present');
} else {
  try {
    mkdirSync(dirname(modelDst), { recursive: true });
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(modelDst, Buffer.from(await res.arrayBuffer()));
    console.log('[assets] downloaded hand_landmarker.task');
  } catch (err) {
    console.warn('[assets] could not download model (' + err.message + '). The app will fall back to the Google-hosted URL at runtime.');
  }
}
