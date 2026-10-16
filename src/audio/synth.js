// Fully procedural Web Audio: no sample files, no network. Each style has a
// looping ambience bed (gain follows manifest/charge) plus one-shot cues.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.6;
    this.muted = false;
    this.beds = {};
    this.activeStyle = 'flame';
    this._noise = null;
    this._nextCrackle = 0;
  }

  /** must be called from a user gesture */
  async init() {
    if (this.ctx) { if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const c = this.ctx;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 4;
    this.master = c.createGain();
    this.master.gain.value = this.muted ? 0 : this.volume;
    this.master.connect(comp).connect(c.destination);

    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noise = buf;

    this._buildBeds();
  }

  setVolume(v) {
    this.volume = v;
    if (this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : v, this.ctx.currentTime, 0.05);
  }
  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.setTargetAtTime(m ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  _noiseSrc(loop = true) {
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise;
    s.loop = loop;
    return s;
  }

  _buildBeds() {
    const c = this.ctx;
    const mk = () => { const g = c.createGain(); g.gain.value = 0; g.connect(this.master); return g; };
    const lfo = (freq, depth, target) => {
      const o = c.createOscillator(); o.frequency.value = freq;
      const g = c.createGain(); g.gain.value = depth;
      o.connect(g).connect(target); o.start();
      return o;
    };

    // flame: low rumble + flicker
    {
      const out = mk();
      const n = this._noiseSrc(); const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 380;
      const g = c.createGain(); g.gain.value = 0.9;
      n.connect(lp).connect(g).connect(out); n.start();
      lfo(5.3, 120, lp.frequency);
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 55;
      const og = c.createGain(); og.gain.value = 0.12;
      o.connect(lp); o.start();
      this.beds.flame = out;
    }
    // water: flowing band-passed noise sweeping slowly
    {
      const out = mk();
      const n = this._noiseSrc(); const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 1.2;
      n.connect(bp).connect(out); n.start();
      lfo(0.35, 500, bp.frequency);
      const n2 = this._noiseSrc(); const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 3500;
      const g2 = c.createGain(); g2.gain.value = 0.12;
      n2.connect(hp).connect(g2).connect(out); n2.start();
      this.beds.water = out;
    }
    // insect: shimmering wing tremolo on a high fifth
    {
      const out = mk();
      for (const [f, a] of [[1174, 0.07], [1760, 0.045], [2349, 0.025]]) {
        const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
        const g = c.createGain(); g.gain.value = a;
        const trem = c.createGain(); trem.gain.value = 0.5;
        o.connect(g).connect(trem).connect(out); o.start();
        lfo(11 + f / 400, 0.5, trem.gain);
        lfo(5, f * 0.006, o.frequency);
      }
      this.beds.insect = out;
    }
    // thunder: 50 Hz electrical hum + bright crackle
    {
      const out = mk();
      const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 50;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 260;
      const g = c.createGain(); g.gain.value = 0.22;
      o.connect(lp).connect(g).connect(out); o.start();
      const n = this._noiseSrc(); const hp = c.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 5200;
      const ng = c.createGain(); ng.gain.value = 0.0;
      n.connect(hp).connect(ng).connect(out); n.start();
      lfo(23, 0.05, ng.gain);
      this.beds.thunder = out;
    }
  }

  /** call every frame */
  update(styleId, manifest, charge, dt) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    for (const [id, g] of Object.entries(this.beds)) {
      const on = id === styleId ? 1 : 0;
      const level = on * (0.0 + 0.1 * manifest + 0.28 * charge);
      g.gain.setTargetAtTime(level, t, 0.12);
    }
    // random crackles / pops that give each ambience character
    this._nextCrackle -= dt;
    if (this._nextCrackle <= 0 && manifest > 0.5) {
      this._nextCrackle = 0.08 + Math.random() * (0.35 - 0.2 * charge);
      this._crackle(styleId, 0.3 + charge * 0.7);
    }
  }

  _env(g, t, a, peak, d) {
    g.gain.cancelScheduledValues(t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  }

  _crackle(style, k) {
    const c = this.ctx, t = c.currentTime;
    const g = c.createGain(); g.connect(this.master);
    if (style === 'flame') {
      const n = this._noiseSrc(false); const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1200 + Math.random() * 2500; f.Q.value = 2;
      n.connect(f).connect(g); this._env(g, t, 0.002, 0.14 * k, 0.04);
      n.start(t, Math.random(), 0.06);
    } else if (style === 'water') {
      const o = c.createOscillator(); o.type = 'sine';
      const base = 500 + Math.random() * 900;
      o.frequency.setValueAtTime(base, t); o.frequency.exponentialRampToValueAtTime(base * 2.2, t + 0.06);
      o.connect(g); this._env(g, t, 0.004, 0.06 * k, 0.07); o.start(t); o.stop(t + 0.12);
    } else if (style === 'insect') {
      const o = c.createOscillator(); o.type = 'triangle';
      o.frequency.value = [1568, 2093, 2637, 3136][Math.floor(Math.random() * 4)];
      o.connect(g); this._env(g, t, 0.003, 0.05 * k, 0.25); o.start(t); o.stop(t + 0.3);
    } else {
      const n = this._noiseSrc(false); const f = c.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 4000;
      n.connect(f).connect(g); this._env(g, t, 0.001, 0.2 * k, 0.025);
      n.start(t, Math.random(), 0.04);
    }
  }

  /** one-shot cues ---------------------------------------------------- */
  summon(styleId) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    // "shing": filtered noise sweep + two bright partials
    const g = c.createGain(); g.connect(this.master);
    const n = this._noiseSrc(false); const bp = c.createBiquadFilter(); bp.type = 'bandpass'; bp.Q.value = 3;
    bp.frequency.setValueAtTime(2500, t); bp.frequency.exponentialRampToValueAtTime(9000, t + 0.45);
    n.connect(bp).connect(g); this._env(g, t, 0.03, 0.35, 0.5); n.start(t, 0, 0.6);
    for (const [f, a] of [[2637, 0.1], [3951, 0.06]]) {
      const o = c.createOscillator(); o.type = 'sine'; o.frequency.value = f;
      const og = c.createGain(); og.connect(this.master); this._env(og, t + 0.12, 0.01, a, 0.9);
      o.connect(og); o.start(t + 0.12); o.stop(t + 1.1);
    }
    this._tone(styleId, 0.7);
  }

  dismiss() {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const g = c.createGain(); g.connect(this.master);
    const n = this._noiseSrc(false); const lp = c.createBiquadFilter(); lp.type = 'lowpass';
    lp.frequency.setValueAtTime(6000, t); lp.frequency.exponentialRampToValueAtTime(400, t + 0.4);
    n.connect(lp).connect(g); this._env(g, t, 0.01, 0.18, 0.4); n.start(t, 0, 0.5);
  }

  /** short identity chord on style change / summon */
  _tone(styleId, level = 0.5) {
    const c = this.ctx, t = c.currentTime;
    const notes = {
      flame: [196, 294, 392],      // low, brass-like fifth
      water: [330, 494, 659],      // open, airy
      insect: [880, 1319, 1760],   // high, delicate
      thunder: [147, 220, 1109],   // dark + sharp ping
    }[styleId] || [220, 330];
    const type = { flame: 'sawtooth', water: 'sine', insect: 'triangle', thunder: 'square' }[styleId] || 'sine';
    notes.forEach((f, i) => {
      const o = c.createOscillator(); o.type = type; o.frequency.value = f;
      const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = styleId === 'insect' ? 6000 : 1400;
      const g = c.createGain(); g.connect(this.master);
      this._env(g, t + i * 0.04, 0.02, 0.05 * level, 0.5);
      o.connect(lp).connect(g); o.start(t + i * 0.04); o.stop(t + 0.8 + i * 0.04);
    });
  }

  switchStyle(styleId) {
    if (!this.ctx) return;
    this._tone(styleId, 0.5);
  }

  attack(styleId, strength = 1) {
    if (!this.ctx) return;
    const c = this.ctx, t = c.currentTime;
    const out = c.createGain(); out.gain.value = 0.55 + 0.45 * strength; out.connect(this.master);
    const noise = (dur, f0, f1, type, q, peak, atk = 0.01, delay = 0) => {
      const g = c.createGain(); g.connect(out);
      const n = this._noiseSrc(false); const f = c.createBiquadFilter(); f.type = type; f.Q.value = q;
      f.frequency.setValueAtTime(f0, t + delay); f.frequency.exponentialRampToValueAtTime(f1, t + delay + dur);
      n.connect(f).connect(g); this._env(g, t + delay, atk, peak, dur); n.start(t + delay, 0, dur + 0.1);
    };
    const tone = (f0, f1, dur, type, peak, delay = 0) => {
      const o = c.createOscillator(); o.type = type;
      o.frequency.setValueAtTime(f0, t + delay); o.frequency.exponentialRampToValueAtTime(f1, t + delay + dur);
      const g = c.createGain(); g.connect(out); this._env(g, t + delay, 0.004, peak, dur);
      o.connect(g); o.start(t + delay); o.stop(t + delay + dur + 0.05);
    };
    switch (styleId) {
      case 'flame':
        noise(0.55, 300, 2400, 'bandpass', 0.9, 0.9, 0.06);
        noise(0.7, 1800, 200, 'lowpass', 0.7, 0.55, 0.02, 0.1);
        tone(110, 38, 0.5, 'sine', 0.8);
        for (let i = 0; i < 6; i++) noise(0.05, 3000, 1500, 'bandpass', 3, 0.3, 0.002, 0.08 + Math.random() * 0.5);
        break;
      case 'water':
        noise(0.9, 500, 2200, 'bandpass', 1.4, 0.75, 0.15);
        noise(1.0, 3000, 500, 'bandpass', 0.8, 0.45, 0.05, 0.25);
        for (let i = 0; i < 7; i++) tone(500 + Math.random() * 700, 1500 + Math.random() * 1500, 0.08, 'sine', 0.12, 0.1 + Math.random() * 0.7);
        break;
      case 'insect':
        tone(1900, 3600, 0.14, 'sine', 0.4);
        noise(0.12, 4000, 9000, 'highpass', 1, 0.5, 0.002);
        for (let i = 0; i < 5; i++) tone(2000 + i * 380, 2000 + i * 380, 0.3, 'triangle', 0.08, 0.15 + i * 0.05);
        break;
      case 'thunder':
        noise(0.5, 9000, 1800, 'highpass', 0.7, 1.0, 0.001, 0.05);
        tone(180, 30, 0.7, 'sine', 1.0, 0.05);
        noise(0.15, 7000, 2500, 'bandpass', 2, 0.8, 0.001);
        break;
      default: break;
    }
  }

  dispose() {
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.ctx = null;
  }
}
