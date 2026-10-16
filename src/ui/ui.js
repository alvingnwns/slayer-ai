// DOM bindings: style selector, camera panel, settings drawer, toasts.
import { STYLES, STYLE_BY_ID } from '../styles.js';
import { LM } from '../tracking/gestures.js';

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'nichirin-ar.settings.v1';

export const DEFAULT_SETTINGS = {
  mode: 'hold',          // 'hold' | 'latch'
  fistEnter: 0.72,
  graceMs: 450,
  swingSpeed: 1.7,
  autoCharge: true,
  camBg: true,
  landmarks: true,
  bloom: true,
  quality: 'auto',       // 'auto' | 'high' | 'low'
  reduceShake: false,
  volume: 0.6,
  muted: false,
  offX: 0,
  offY: 0,
  roll: 0,
  scale: 1,
  gripShift: 0,
  grip: 'forearm',       // 'forearm' | 'knuckles'
  depth: true,
  style: 'flame',
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* ignore */ }
}

const HAND_LINES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export class UI {
  constructor(settings, handlers) {
    this.s = settings;
    this.h = handlers;
    this.els = {
      hud: $('hud'), start: $('start'), styles: $('styles'), preview: $('preview'), overlay: $('overlay'),
      camEmpty: $('camEmpty'), camChip: $('camChip'), btnCam: $('btnCam'), camMsg: $('camMsg'),
      fistFill: $('fistFill'), fistMark: $('fistMark'), stateTitle: $('stateTitle'), stateSub: $('stateSub'),
      palmRing: $('palmRing'), toast: $('toast'), drawer: $('drawer'), drawerBody: $('drawerBody'),
      help: $('help'), debug: $('debug'), btnMute: $('btnMute'), startNote: $('startNote'),
    };
    this._toastTimer = 0;
    this.octx = this.els.overlay.getContext('2d');
    this._buildStyles();
    this._buildDrawer();
    this._wire();
    this.setStyle(this.s.style, true);
    this.els.fistMark.style.left = `${this.s.fistEnter * 100}%`;
    this.refreshMute();
  }

  // ------------------------------------------------------------ build
  _buildStyles() {
    for (const st of STYLES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'style-card';
      b.dataset.id = st.id;
      b.style.setProperty('--c', st.ui);
      b.setAttribute('aria-pressed', 'false');
      b.innerHTML = `<span class="key">${st.key}</span><span class="jp">${st.jp}</span><span class="nm">${st.name}</span><span class="bl">${st.blurb}</span>`;
      b.addEventListener('click', () => this.h.onStyle(st.id));
      this.els.styles.appendChild(b);
    }
  }

  _buildDrawer() {
    const body = this.els.drawerBody;
    const s = this.s;
    const add = (html) => { const d = document.createElement('div'); d.innerHTML = html; body.append(...d.childNodes); };
    const slider = (key, label, min, max, step, hint = '', fmt = (v) => v) => `
      <div class="row"><label for="set-${key}">${label}</label><output id="out-${key}">${fmt(s[key])}</output>
      <input type="range" id="set-${key}" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${s[key]}" />
      ${hint ? `<small>${hint}</small>` : ''}</div>`;
    const check = (key, label, hint = '') => `
      <div class="row"><label for="set-${key}">${label}</label>
      <input type="checkbox" id="set-${key}" data-key="${key}" ${s[key] ? 'checked' : ''} />
      ${hint ? `<small>${hint}</small>` : ''}</div>`;
    const select = (key, label, opts, hint = '') => `
      <div class="row"><label for="set-${key}">${label}</label>
      <select id="set-${key}" data-key="${key}">${opts.map(([v, t]) => `<option value="${v}" ${s[key] === v ? 'selected' : ''}>${t}</option>`).join('')}</select>
      ${hint ? `<small>${hint}</small>` : ''}</div>`;

    add(`<h3>Gesture</h3>`);
    add(select('mode', 'Sword behaviour', [['hold', 'Hold — only while gripping'], ['latch', 'Latch — stays until sheathed']],
      'Hold: opening your fist (after the grace period) sheathes the sword. Latch: it stays; hold an open palm ~2 s or press X.'));
    add(slider('fistEnter', 'Fist threshold', 0.5, 0.95, 0.01, 'Lower = easier to trigger, but more false positives.', (v) => (+v).toFixed(2)));
    add(slider('graceMs', 'Open grace period', 100, 1500, 50, 'How long the hand must stay open before the sword reacts.', (v) => `${v} ms`));
    add(slider('swingSpeed', 'Swing sensitivity', 0.8, 3.5, 0.1, 'Hand speed (screen-heights/s) that triggers an attack. Lower = more sensitive.', (v) => (+v).toFixed(1)));
    add(check('autoCharge', 'Charge when held still'));

    add(`<h3>Calibration</h3>`);
    add(`<div class="row"><span>Align blade to my wrist</span><button class="btn sm" id="btnCalibrate" type="button">Calibrate (C)</button>
      <small>Hold your fist the way you want the blade to point, then press Calibrate.</small></div>`);
    add(select('grip', 'Blade direction', [['forearm', 'Along the forearm (recommended)'], ['knuckles', 'Across the knuckles (real grip line)']],
      'The knuckle line matches a real grip but points sideways for a palm-forward fist.'));
    add(slider('roll', 'Blade angle', -3.14, 3.14, 0.02, '', (v) => `${Math.round((v * 180) / Math.PI)}°`));
    add(slider('offX', 'Position X', -1, 1, 0.01, '', (v) => (+v).toFixed(2)));
    add(slider('offY', 'Position Y', -1, 1, 0.01, '', (v) => (+v).toFixed(2)));
    add(slider('gripShift', 'Grip position along blade', -0.6, 0.6, 0.01, '', (v) => (+v).toFixed(2)));
    add(slider('scale', 'Sword size', 0.5, 1.6, 0.01, '', (v) => (+v).toFixed(2)));
    add(check('depth', 'Hand-size depth cue', 'Moves the sword nearer/farther using apparent hand size. Approximate only — a single webcam has no true depth.'));
    add(`<div class="row"><span>Reset calibration</span><button class="btn sm" id="btnResetCal" type="button">Reset</button></div>`);

    add(`<h3>Visuals</h3>`);
    add(check('camBg', 'Show camera background', 'Off = dark cinematic stage.'));
    add(check('landmarks', 'Show hand landmarks in preview'));
    add(check('bloom', 'Bloom glow'));
    add(select('quality', 'Quality', [['auto', 'Auto'], ['high', 'High'], ['low', 'Low (best performance)']]));
    add(check('reduceShake', 'Reduce shake & flashes', 'Disables the Thunder camera shake and dims the impact flash.'));

    add(`<h3>Audio</h3>`);
    add(slider('volume', 'Volume', 0, 1, 0.01, '', (v) => `${Math.round(v * 100)}%`));
  }

  _wire() {
    const e = this.els;
    $('btnGear').addEventListener('click', () => this.toggleDrawer());
    $('btnCloseDrawer').addEventListener('click', () => this.toggleDrawer(false));
    $('btnHelp').addEventListener('click', () => this.toggleHelp());
    $('btnCloseHelp').addEventListener('click', () => this.toggleHelp(false));
    $('btnMute').addEventListener('click', () => this.h.onMute());
    e.btnCam.addEventListener('click', () => this.h.onToggleCamera());
    $('btnCalibrate').addEventListener('click', () => this.h.onCalibrate());
    $('btnResetCal').addEventListener('click', () => this.h.onResetCalibration());

    e.drawerBody.addEventListener('input', (ev) => {
      const t = ev.target;
      const key = t.dataset?.key;
      if (!key) return;
      let v;
      if (t.type === 'checkbox') v = t.checked;
      else if (t.type === 'range') v = parseFloat(t.value);
      else v = t.value;
      this.s[key] = v;
      this._refreshOutputs();
      this.h.onSetting(key, v);
    });
  }

  _refreshOutputs() {
    const s = this.s;
    const set = (k, txt) => { const o = $(`out-${k}`); if (o) o.textContent = txt; };
    set('fistEnter', s.fistEnter.toFixed(2));
    set('graceMs', `${s.graceMs} ms`);
    set('swingSpeed', s.swingSpeed.toFixed(1));
    set('roll', `${Math.round((s.roll * 180) / Math.PI)}°`);
    set('offX', s.offX.toFixed(2));
    set('offY', s.offY.toFixed(2));
    set('gripShift', s.gripShift.toFixed(2));
    set('scale', s.scale.toFixed(2));
    set('volume', `${Math.round(s.volume * 100)}%`);
    this.els.fistMark.style.left = `${s.fistEnter * 100}%`;
  }

  /** push programmatic changes (e.g. calibration) back into the drawer controls */
  syncControls() {
    for (const el of this.els.drawerBody.querySelectorAll('[data-key]')) {
      const v = this.s[el.dataset.key];
      if (el.type === 'checkbox') el.checked = !!v; else el.value = v;
    }
    this._refreshOutputs();
  }

  // ------------------------------------------------------------ state
  setStyle(id, silent = false) {
    this.s.style = id;
    const def = STYLE_BY_ID[id];
    document.documentElement.style.setProperty('--accent', def.ui);
    for (const b of this.els.styles.children) b.setAttribute('aria-pressed', String(b.dataset.id === id));
    if (!silent) saveSettings(this.s);
  }

  toggleDrawer(force) {
    const open = force ?? !this.els.drawer.classList.contains('open');
    this.els.drawer.classList.toggle('open', open);
    this.els.drawer.setAttribute('aria-hidden', String(!open));
  }

  toggleHelp(force) {
    const show = force ?? this.els.help.hidden;
    this.els.help.hidden = !show;
  }

  get drawerOpen() { return this.els.drawer.classList.contains('open'); }

  showHud() {
    this.els.start.hidden = true;
    this.els.hud.hidden = false;
  }

  toast(msg, ms = 2600) {
    const t = this.els.toast;
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  setStartNote(msg) { this.els.startNote.textContent = msg || ''; }

  setCamera(status, detail) {
    const labels = {
      off: 'Camera off', requesting: 'Requesting…', loading: 'Loading model…', searching: 'Looking for hand…',
      tracking: 'Hand tracked', denied: 'Permission denied', error: 'Camera error', 'no-camera': 'No camera',
      lost: 'Hand lost', lowlight: 'Low light',
    };
    this.els.camChip.dataset.s = status;
    this.els.camChip.textContent = labels[status] || status;
    this.els.camMsg.textContent = detail || '';
    const on = ['requesting', 'loading', 'searching', 'tracking', 'lost', 'lowlight'].includes(status);
    this.els.camEmpty.hidden = on && this.els.preview.srcObject != null;
    this.els.btnCam.textContent = on ? 'Turn off' : 'Enable camera';
    this.els.btnCam.classList.toggle('on', on);
  }

  attachPreview(video) {
    // show the same stream in the PiP (mirrored via CSS)
    this.els.preview.srcObject = video ? video.srcObject : null;
    if (video) this.els.preview.play().catch(() => {});
    this.els.camEmpty.hidden = !!video;
  }

  setState(title, sub = '') {
    if (this.els.stateTitle.textContent !== title) this.els.stateTitle.textContent = title;
    if (this.els.stateSub.textContent !== sub) this.els.stateSub.textContent = sub;
  }

  setFist(v) { this.els.fistFill.style.width = `${Math.round(Math.min(1, Math.max(0, v)) * 100)}%`; }

  setPalmProgress(p) {
    const el = this.els.palmRing;
    el.hidden = !(p > 0.02);
    if (!el.hidden) el.firstElementChild.style.width = `${Math.round(p * 100)}%`;
  }

  refreshMute() {
    this.els.btnMute.textContent = this.s.muted ? '🔇' : '♪';
    this.els.btnMute.setAttribute('aria-pressed', String(this.s.muted));
  }

  drawLandmarks(lm, fist) {
    const c = this.els.overlay;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== w) { c.width = w; c.height = h; }
    const g = this.octx;
    g.clearRect(0, 0, c.width, c.height);
    if (!lm || !this.s.landmarks) return;
    // the overlay uses object-fit-like mapping of a 16:9 frame; videos are ~16:9
    g.lineWidth = 2;
    g.strokeStyle = fist ? 'rgba(255,140,60,0.95)' : 'rgba(120,255,180,0.9)';
    g.beginPath();
    for (const [a, b] of HAND_LINES) {
      g.moveTo(lm[a].x * c.width, lm[a].y * c.height);
      g.lineTo(lm[b].x * c.width, lm[b].y * c.height);
    }
    g.stroke();
    g.fillStyle = '#fff';
    for (const p of lm) { g.beginPath(); g.arc(p.x * c.width, p.y * c.height, 2.2, 0, 6.283); g.fill(); }
    // palm centre
    g.fillStyle = 'rgba(255,200,80,0.95)';
    g.beginPath(); g.arc(lm[LM.MIDDLE_MCP].x * c.width, lm[LM.MIDDLE_MCP].y * c.height, 4, 0, 6.283); g.fill();
  }

  clearOverlay() {
    const c = this.els.overlay;
    this.octx.clearRect(0, 0, c.width, c.height);
  }

  setDebug(text) {
    this.els.debug.textContent = text;
  }
  get debugVisible() { return !this.els.debug.hidden; }
  toggleDebug() { this.els.debug.hidden = !this.els.debug.hidden; }
}
