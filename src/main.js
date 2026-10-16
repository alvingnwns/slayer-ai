import * as THREE from 'three';
import './ui/style.css';

import { Stage } from './scene/stage.js';
import { Katana } from './sword/katana.js';
import { SwordRig } from './sword/rig.js';
import { SwordController } from './sword/controller.js';
import { HandTracker } from './tracking/handTracker.js';
import { analyzeHand } from './tracking/handPose.js';
import { FistDetector, HoldDetector } from './tracking/gestures.js';
import { STYLES, STYLE_BY_ID } from './styles.js';
import { FlameFx } from './vfx/flame.js';
import { WaterFx } from './vfx/water.js';
import { InsectFx } from './vfx/insect.js';
import { ThunderFx } from './vfx/thunder.js';
import { AudioEngine } from './audio/synth.js';
import { UI, loadSettings, saveSettings, DEFAULT_SETTINGS } from './ui/ui.js';

const BASE = import.meta.env.BASE_URL || '/';
const settings = loadSettings();
if (!STYLE_BY_ID[settings.style]) settings.style = 'flame';

// --------------------------------------------------------------- scene setup
const canvas = document.getElementById('gl');
let stage;
try {
  stage = new Stage(canvas);
} catch (err) {
  console.error(err);
  document.getElementById('start').querySelector('.start-note').textContent =
    'WebGL could not be initialised in this browser, so the 3D scene cannot run.';
  throw err;
}

const katana = new Katana();
const rig = new SwordRig(stage, katana);
stage.scene.add(rig.root);

const ctrl = new SwordController();
const audio = new AudioEngine();
audio.volume = settings.volume;
audio.muted = settings.muted;

const host = { stage, katana };
const fx = {
  flame: new FlameFx(STYLE_BY_ID.flame, host),
  water: new WaterFx(STYLE_BY_ID.water, host),
  insect: new InsectFx(STYLE_BY_ID.insect, host),
  thunder: new ThunderFx(STYLE_BY_ID.thunder, host),
};
for (const f of Object.values(fx)) {
  stage.scene.add(f.world);
  rig.root.add(f.local);
}

// rim/key light for the sword itself
const keyLight = new THREE.DirectionalLight(0xfff1dd, 2.2);
keyLight.position.set(-2, 3, 4);
stage.scene.add(keyLight);
stage.scene.add(new THREE.AmbientLight(0x8890a8, 0.25));

// optional GLB override
katana.tryLoadGlb(`${BASE}models/katana.glb`).then((ok) => { if (ok) ui.toast('Loaded custom katana.glb'); });

// --------------------------------------------------------------- tracking
const tracker = new HandTracker();
const fist = new FistDetector({ enter: settings.fistEnter, graceMs: settings.graceMs });
const palmHold = new HoldDetector(0.8, 2000);

let cameraWanted = false;      // user intent
let lastResult = null;         // last MediaPipe result
let lastSample = null;         // last analysed hand sample (camera)
let lastSeenAt = 0;
let handVisible = false;

// --------------------------------------------------------------- mouse / keyboard fallback
const mouse = {
  nx: 0.5, ny: 0.55, down: false, active: false, angle: 0.0, lean: 0,
  vfist: false, lastMove: 0, px: 0.5, py: 0.55,
};
const keys = { space: false };

const mouseSample = {
  present: true, ndcX: 0, ndcY: 0, size: 0.16, up: [0, 1, 0], across: [1, 0, 0], normal: [0, 0, 1], fist: 0.05, open: 0,
};

function buildMouseSample(dt) {
  // sword leans slightly into the movement for a more natural feel
  const vx = (mouse.nx - mouse.px) / Math.max(dt, 1e-3);
  mouse.px = mouse.nx; mouse.py = mouse.ny;
  mouse.lean += (THREE.MathUtils.clamp(-vx * 0.35, -0.5, 0.5) - mouse.lean) * Math.min(1, dt * 6);
  const a = mouse.angle + mouse.lean;
  const s = mouseSample;
  s.ndcX = mouse.nx * 2 - 1;
  s.ndcY = -(mouse.ny * 2 - 1);
  s.up = [Math.sin(a), Math.cos(a), 0.0];
  s.across = [Math.cos(a), -Math.sin(a), 0.0];
  s.fist = mouse.down || mouse.vfist ? 1 : 0.05;
  return s;
}

canvas.addEventListener('pointermove', (e) => {
  if (!mouse.active) { mouse.px = e.clientX / window.innerWidth; mouse.py = e.clientY / window.innerHeight; rig.reset(); }
  mouse.nx = e.clientX / window.innerWidth;
  mouse.ny = e.clientY / window.innerHeight;
  mouse.active = true;
  mouse.lastMove = performance.now();
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.button === 0) { mouse.down = true; audio.init(); }
  if (e.button === 2) { triggerAttack(); }
});
window.addEventListener('pointerup', (e) => { if (e.button === 0) mouse.down = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  mouse.angle += Math.sign(e.deltaY) * 0.12;
}, { passive: true });

window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.target instanceof HTMLSelectElement || (e.target instanceof HTMLInputElement && e.target.type !== 'range' && e.target.type !== 'checkbox')) return;
  const k = e.key.toLowerCase();
  const st = STYLES.find((s) => s.key === e.key);
  if (st) { selectStyle(st.id); return; }
  switch (k) {
    case 'tab': {
      e.preventDefault();
      const i = STYLES.findIndex((s) => s.id === settings.style);
      selectStyle(STYLES[(i + 1) % STYLES.length].id);
      break;
    }
    case 'f': mouse.vfist = !mouse.vfist; ui.toast(mouse.vfist ? 'Sword drawn (F to sheathe)' : 'Sword sheathed'); break;
    case ' ':
      e.preventDefault();
      audio.init();
      if (!ctrl.visible) { mouse.vfist = true; break; }
      keys.space = true; ctrl.holdCharge = true;
      break;
    case 'x': sheathe(); break;
    case 'q': mouse.angle -= 0.1; break;
    case 'e': mouse.angle += 0.1; break;
    case 'c': calibrate(); break;
    case 'b': setSetting('camBg', !settings.camBg); ui.syncControls(); break;
    case 'm': toggleMute(); break;
    case 'd': ui.toggleDebug(); break;
    case 's': ui.toggleDrawer(); break;
    case '?': case '/': ui.toggleHelp(); break;
    case 'escape': ui.toggleDrawer(false); ui.toggleHelp(false); break;
    default: break;
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && keys.space) {
    keys.space = false;
    ctrl.holdCharge = false;
    triggerAttack();
  }
});

// --------------------------------------------------------------- actions
function triggerAttack() {
  if (!ctrl.visible) return;
  ctrl.attack();
}

function sheathe() {
  mouse.vfist = false;
  mouse.down = false;
  pendingDismiss = false;
  fist.reset();
  palmHold.reset();
  if (ctrl.dismiss()) audio.dismiss();
}

let pendingDismiss = false;
function requestDismiss() {
  if (ctrl.state === 'attack' || ctrl.state === 'recover') pendingDismiss = true;
  else if (ctrl.dismiss()) audio.dismiss();
}

function selectStyle(id) {
  if (settings.style === id) return;
  settings.style = id;
  ui.setStyle(id);
  applyStyle(true);
}

function applyStyle(sound) {
  const def = STYLE_BY_ID[settings.style];
  for (const [id, f] of Object.entries(fx)) f.setActive(id === settings.style);
  katana.setStyle(settings.style);
  ctrl.setTimings(def.timing);
  if (sound) audio.switchStyle(settings.style);
}

function calibrate() {
  // make the *current* wrist angle the "blade straight up" reference
  settings.roll = THREE.MathUtils.clamp(settings.roll + rig.angle, -Math.PI, Math.PI);
  if (!cameraActive()) { mouse.angle = 0; settings.roll = 0; }
  saveSettings(settings);
  ui.syncControls();
  ui.toast('Calibrated — blade angle aligned to your hand');
}

function toggleMute() {
  settings.muted = !settings.muted;
  audio.setMuted(settings.muted);
  ui.refreshMute();
  saveSettings(settings);
}

function setSetting(key, v) {
  settings[key] = v;
  switch (key) {
    case 'fistEnter': fist.cfg.enter = v; fist.cfg.exit = Math.max(0.3, v - 0.22); break;
    case 'graceMs': fist.cfg.graceMs = v; break;
    case 'swingSpeed': ctrl.cfg.swingSpeed = v; break;
    case 'autoCharge': ctrl.cfg.autoCharge = v; break;
    case 'volume': audio.setVolume(v); break;
    case 'quality': perf.forced = v; applyQuality(); break;
    case 'bloom': stage.setBloom(v); break;
    case 'mode': palmHold.reset(); break;
    default: break;
  }
  saveSettings(settings);
}

const ui = new UI(settings, {
  onStyle: selectStyle,
  onSetting: setSetting,
  onMute: toggleMute,
  onCalibrate: calibrate,
  onResetCalibration: () => {
    for (const k of ['offX', 'offY', 'roll', 'scale', 'gripShift', 'grip']) settings[k] = DEFAULT_SETTINGS[k];
    mouse.angle = 0;
    saveSettings(settings);
    ui.syncControls();
    ui.toast('Calibration reset');
  },
  onToggleCamera: () => (cameraActive() ? disableCamera() : enableCamera()),
});

setSetting('fistEnter', settings.fistEnter);
ctrl.cfg.swingSpeed = settings.swingSpeed;
ctrl.cfg.autoCharge = settings.autoCharge;
audio.setVolume(settings.volume);

// camera lifecycle ------------------------------------------------------
function cameraActive() { return tracker.active; }

async function enableCamera() {
  cameraWanted = true;
  await audio.init();
  const ok = await tracker.start();
  if (ok) {
    ui.attachPreview(tracker.video);
    ui.toast('Camera ready — close your fist to draw the katana');
  } else {
    cameraWanted = false;
    ui.attachPreview(null);
    ui.toast('Camera unavailable — mouse & keyboard mode is active', 4200);
  }
  return ok;
}

function disableCamera() {
  cameraWanted = false;
  tracker.stop();
  ui.attachPreview(null);
  ui.clearOverlay();
  lastSample = null;
  lastResult = null;
  handVisible = false;
  fist.reset();
  palmHold.reset();
  stage.setVideo(null);
}

tracker.addEventListener('status', (e) => {
  const { status, detail } = e.detail;
  ui.setCamera(status, detail);
  if (status === 'denied' || status === 'error' || status === 'no-camera') {
    ui.setStartNote(detail);
    ui.toast(detail, 5000);
  }
});

document.addEventListener('visibilitychange', () => {
  // free the camera while the tab is hidden; resume when it is back
  if (document.hidden && tracker.active) {
    tracker.stop('Paused (tab hidden)');
    ui.attachPreview(null);
    tracker._resume = true;
  } else if (!document.hidden && tracker._resume) {
    tracker._resume = false;
    enableCamera();
  }
});

// start overlay ---------------------------------------------------------
document.getElementById('btnStartCam').addEventListener('click', async () => {
  const note = document.getElementById('btnStartCam');
  note.disabled = true;
  ui.setStartNote('Waiting for camera permission…');
  const ok = await enableCamera();
  note.disabled = false;
  if (ok) ui.showHud();
  else ui.setStartNote(tracker.detail || 'Camera could not be started. You can continue with mouse & keyboard.');
});
document.getElementById('btnStartMouse').addEventListener('click', async () => {
  await audio.init();
  ui.showHud();
  ui.setCamera('off', '');
  ui.toast('Mouse & keyboard mode — press ? for controls', 3500);
});

// --------------------------------------------------------------- performance
const perf = {
  forced: settings.quality,
  level: 1,           // 1 = full, 0.6, 0.4
  acc: 0, frames: 0, lowSince: 0,
};
function applyQuality() {
  const q = perf.forced;
  if (q === 'low') { perf.level = 0.4; stage.setQuality('low'); }
  else if (q === 'high') { perf.level = 1; stage.setQuality('high'); stage.setBloom(settings.bloom); }
  else if (perf.level < 1) { stage.setQuality(perf.level < 0.5 ? 'low' : 'high'); }
  stage.setBloom(settings.bloom);
}
applyQuality();

// --------------------------------------------------------------- main loop
const tipW = new THREE.Vector3();
const baseW = new THREE.Vector3();
const midW = new THREE.Vector3();
const prevTip = new THREE.Vector3();
const tipVel = new THREE.Vector3();
const swingDir = new THREE.Vector3(1, 0, 0);
const offset = new THREE.Vector3();
const frame = {
  time: 0, dt: 0, tip: tipW, mid: midW, base: baseW, dir: new THREE.Vector3(0, 1, 0), vel: tipVel, swingDir,
  speed: 0, manifest: 0, charge: 0, attacking: false, attackT: 0, recovering: false, recoverT: 0,
  attackStarted: false, strength: 0, pixelHeight: 1, quality: 1,
};

let attackStartedFlag = false;
ctrl.onEvent = (name) => {
  if (name === 'summon') audio.summon(settings.style);
  else if (name === 'attack') {
    attackStartedFlag = true;
    audio.attack(settings.style, ctrl.strength);
  } else if (name === 'ready' && pendingDismiss) {
    pendingDismiss = false;
    if (ctrl.dismiss()) audio.dismiss();
  } else if (name === 'hidden') {
    for (const f of Object.values(fx)) f.heat = 0;
  }
};

applyStyle(false);
katana.applyTint(STYLE_BY_ID[settings.style], 0);

let lastT = performance.now();
let smoothFps = 60;
let uiAcc = 0;
let time = 0;
const tintCol = [1, 1, 1];

function frameLoop(now) {
  requestAnimationFrame(frameLoop);
  const realDt = (now - lastT) / 1000;
  lastT = now;
  if (realDt <= 0) return;
  const dt = Math.min(realDt, 0.05);
  time += dt;
  smoothFps += (1 / dt - smoothFps) * 0.05;

  // ---- 1. input --------------------------------------------------------
  let sample = null;
  let usingCamera = false;
  if (tracker.ready) {
    usingCamera = true;
    const res = tracker.detect(now);
    if (res !== undefined) {
      lastResult = res;
      if (res) {
        lastSample = analyzeHand(res.landmarks, res.world, tracker.videoSize.w / tracker.videoSize.h);
        const ndc = stage.videoToNdc(lastSample.nx, lastSample.ny);
        lastSample.ndcX = ndc.x;
        lastSample.ndcY = ndc.y;
        lastSeenAt = now;
        handVisible = true;
      } else {
        handVisible = false;
      }
    }
    if (lastSample && now - lastSeenAt > 120) handVisible = false;
    sample = handVisible ? lastSample : null;
    if (sample && mouse.vfist) { sample = { ...sample, fist: Math.max(sample.fist, 1) }; }
    // hand lost, but virtual fist (F/Space) active: still allow keyboard control with last pose
    if (!sample && mouse.vfist && lastSample) sample = { ...lastSample, fist: 1 };
    // camera on but no tracked hand: keyboard/mouse still works as a fallback
    if (!sample && (mouse.vfist || mouse.down)) sample = buildMouseSample(dt);
  } else {
    sample = buildMouseSample(dt);
  }

  // ---- 2. gesture → life-cycle ----------------------------------------
  const fistScore = sample ? sample.fist : null;
  const ev = fist.update(fistScore, now);
  if (ev === 'close') {
    pendingDismiss = false;
    if (!ctrl.visible || ctrl.state === 'dismissing') ctrl.summon();
  } else if (ev === 'open') {
    if (settings.mode === 'hold' && !mouse.vfist) requestDismiss();
  }
  // Latch mode: open palm held for 2 s sheathes (progress shown in the HUD)
  let palmProgress = 0;
  if (settings.mode === 'latch' && usingCamera && ctrl.armed && sample && !fist.closed) {
    if (palmHold.update(sample.open, now)) requestDismiss();
    palmProgress = palmHold._since != null && !palmHold._fired ? Math.min(1, (now - palmHold._since) / palmHold.holdMs) : 0;
  } else palmHold.reset();

  // ---- 3. rig pose -----------------------------------------------------
  if (!usingCamera && !mouse.active) {
    // keep the mouse sword in a comfortable starting position
    mouse.nx = 0.5; mouse.ny = 0.6;
  }
  rig.update(dt, sample, settings, realDt);

  ctrl.update(dt, { speed: rig.speed, handPresent: !!sample });

  // ---- 4. frame description for VFX -----------------------------------
  const def = STYLE_BY_ID[settings.style];
  const active = fx[settings.style];
  frame.time = time;
  frame.dt = dt;
  frame.manifest = ctrl.manifest;
  frame.charge = ctrl.charge;
  frame.attacking = ctrl.state === 'attack';
  frame.attackT = ctrl.attackT;
  frame.recovering = ctrl.state === 'recover';
  frame.recoverT = ctrl.recoverT;
  frame.strength = ctrl.strength;
  frame.speed = rig.speed;
  frame.pixelHeight = stage.renderer.domElement.height;
  frame.quality = perf.level;
  frame.attackStarted = attackStartedFlag;

  rig.root.updateMatrixWorld(true);
  sampleBlade();
  active.swordOffset(frame, offset);
  rig.root.position.add(offset);
  rig.root.updateMatrixWorld(true);
  sampleBlade();

  // tip velocity (world) and swing direction (screen plane)
  tipVel.copy(tipW).sub(prevTip).divideScalar(dt);
  prevTip.copy(tipW);
  const sp = Math.hypot(tipVel.x, tipVel.y);
  if (sp > 0.8) {
    swingDir.set(tipVel.x / sp, tipVel.y / sp, 0);
  } else if (frame.attackStarted || sp < 0.2) {
    // no clear motion (key/click attack): slash across the blade, left-to-right
    swingDir.set(frame.dir.y, -frame.dir.x, 0);
    if (swingDir.lengthSq() < 1e-4) swingDir.set(1, 0, 0);
    swingDir.normalize();
  }

  // ---- 5. visual state -------------------------------------------------
  const reveal = 1 - Math.pow(1 - ctrl.manifest, 3);
  katana.setReveal(reveal, time);
  const pulse = 1 + ctrl.charge * 1.6 + (frame.attacking ? 1.2 * (1 - ctrl.attackT) : 0);
  katana.applyTint(def, THREE.MathUtils.smoothstep(ctrl.manifest, 0.3, 1.0));
  katana.bladeMat.emissiveIntensity *= pulse * rig.confidence;
  keyLight.intensity = 2.2 * (0.5 + 0.5 * rig.confidence);

  for (const f of Object.values(fx)) f.update(frame);
  attackStartedFlag = false;

  // heat haze: only the flame set writes the pass; otherwise switch it off
  if (fx.flame.heat <= 0.01) stage.setHeat({ x: 0, y: 0 }, { x: 0, y: 0 }, 0);

  // ---- 6. render -------------------------------------------------------
  const showVideo = usingCamera && settings.camBg;
  if (showVideo) stage.setVideo(tracker.video, tracker.videoSize.w / tracker.videoSize.h);
  else stage.setVideo(null);
  tintCol[0] = def.mid[0]; tintCol[1] = def.mid[1]; tintCol[2] = def.mid[2];
  const bloomBoost = 0.55 + 0.2 * ctrl.charge + (frame.attacking ? 0.2 * (1 - ctrl.attackT) : 0);
  stage.render(dt, {
    dim: Math.min(1, ctrl.manifest * 0.9 + ctrl.charge * 0.2),
    tint: tintCol,
    bloomStrength: bloomBoost,
    shakeEnabled: !settings.reduceShake,
  });

  audio.update(settings.style, ctrl.manifest, ctrl.charge, dt);

  // ---- 7. adaptive quality --------------------------------------------
  perf.acc += dt; perf.frames++;
  if (perf.frames >= 90) {
    const avg = perf.acc / perf.frames;
    perf.acc = 0; perf.frames = 0;
    if (perf.forced === 'auto') {
      if (avg > 0.026 && perf.level > 0.4) {
        perf.level = perf.level > 0.7 ? 0.6 : 0.4;
        stage.maxPixelRatio = Math.max(1, stage.maxPixelRatio * 0.8);
        if (perf.level <= 0.4) stage.setQuality('low');
        stage.resize();
        ui.toast('Reduced effect density to stay smooth');
      }
    }
  }

  // ---- 8. HUD (throttled) ---------------------------------------------
  uiAcc += dt;
  if (usingCamera) {
    ui.drawLandmarks(handVisible && lastResult ? lastResult.landmarks : null, fist.closed);
  }
  if (uiAcc > 0.08) {
    uiAcc = 0;
    updateHud(usingCamera, sample, palmProgress);
  }
}

function sampleBlade() {
  const g = katana.group;
  tipW.copy(katana.tipLocal);
  midW.copy(katana.midLocal);
  baseW.copy(katana.baseLocal);
  g.localToWorld(tipW);
  g.localToWorld(midW);
  g.localToWorld(baseW);
  frame.dir.copy(tipW).sub(baseW).normalize();
}

function updateHud(usingCamera, sample, palmProgress) {
  ui.setFist(fist.score);
  ui.setPalmProgress(palmProgress);

  // camera chip: promote searching → tracking / lost / low light
  if (usingCamera) {
    let st = tracker.status;
    if (st === 'searching' || st === 'tracking' || st === 'lost' || st === 'lowlight') {
      if (tracker.brightness < 38) st = 'lowlight';
      else if (handVisible) st = 'tracking';
      else st = ctrl.visible ? 'lost' : 'searching';
      const detail = st === 'lowlight' ? 'Very dark image — face a light for steadier tracking.'
        : st === 'lost' ? 'Hand left the frame — the blade holds its last position.'
        : st === 'searching' ? 'Show your hand to the camera.' : '';
      ui.setCamera(st, detail);
    }
  }

  const def = STYLE_BY_ID[settings.style];
  let title = '', sub = '';
  switch (ctrl.state) {
    case 'hidden':
      title = usingCamera ? 'Close your fist to draw your blade' : 'Hold the mouse button (or press F) to draw your blade';
      sub = `${def.jp} · ${def.name}`;
      break;
    case 'summoning': title = 'Nichirin blade awakening…'; sub = def.jp; break;
    case 'ready': title = `${def.jp} — ready`; sub = usingCamera ? 'Hold still to charge · swing to strike' : 'Space: charge & release · right-click: strike'; break;
    case 'charging': title = `${def.jp} — charging`; sub = `${Math.round(ctrl.charge * 100)}% · swing or release Space to unleash`; break;
    case 'attack': title = def.romaji; sub = def.name; break;
    case 'recover': title = 'Recovering breath…'; sub = ''; break;
    case 'dismissing': title = 'Sheathing…'; sub = ''; break;
    default: break;
  }
  if (ctrl.visible && usingCamera && !handVisible && ctrl.armed) sub = 'Tracking lost — show your hand';
  if (fist.closed && fist.graceProgress > 0.05 && settings.mode === 'hold') sub = 'Hand opening — sword will sheathe';
  ui.setState(title, sub);

  if (ui.debugVisible) {
    ui.setDebug([
      `fps        ${smoothFps.toFixed(0)}   quality ${perf.level}`,
      `input      ${usingCamera ? 'camera ' + tracker.delegate : 'mouse/keyboard'}`,
      `inference  ${tracker.inferenceMs.toFixed(1)} ms   luma ${tracker.brightness.toFixed(0)}`,
      `fist       raw ${sample ? sample.fist.toFixed(2) : '--'}  smooth ${fist.score.toFixed(2)}  ${fist.closed ? 'CLOSED' : 'open'}`,
      `sword      ${ctrl.state}  manifest ${ctrl.manifest.toFixed(2)}  charge ${ctrl.charge.toFixed(2)}`,
      `speed      ${rig.speed.toFixed(2)} screens/s   conf ${rig.confidence.toFixed(2)}`,
      `particles  f${fx.flame.embers.alive} w${fx.water.drops.alive + fx.water.spray.alive} i${fx.insect.flies.alive + fx.insect.sparks.alive} t${fx.thunder.sparks.alive}`,
      `draw calls ${stage.renderer.info.render.calls}   tris ${stage.renderer.info.render.triangles}`,
    ].join('\n'));
  }
}

// --------------------------------------------------------------- lifecycle
function cleanup() {
  tracker.dispose();
  audio.dispose();
  for (const f of Object.values(fx)) f.dispose();
  katana.dispose();
  stage.dispose();
}
window.addEventListener('pagehide', cleanup);

// debug / test hook (no camera data is exposed)
window.__nichirin = {
  ctrl, settings, fx, katana, rig, stage, mouse, perf,
  select: selectStyle, attack: triggerAttack, summon: () => { mouse.vfist = true; },
};

requestAnimationFrame((t) => { lastT = t; requestAnimationFrame(frameLoop); });
