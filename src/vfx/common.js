// Shared VFX building blocks: GLSL noise, ribbon strips, sweep trails,
// procedural lightning mesh, slash-wave pool and blade aura.
import * as THREE from 'three';

export const NOISE_GLSL = /* glsl */ `
  float h11(float p){ return fract(sin(p * 127.1) * 43758.5453); }
  float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vnoise(vec2 p){
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm(vec2 p){
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 4; i++) { v += a * vnoise(p); p = p * 2.03 + 11.7; a *= 0.5; }
    return v;
  }
`;

const colorUniform = (c) => ({ value: new THREE.Color(c[0], c[1], c[2]) });

/** Common uniform bag for a style's materials. */
export function makeStyleUniforms(def, gain) {
  return {
    uTime: { value: 0 },
    uGain: gain,
    uCore: colorUniform(def.core),
    uMid: colorUniform(def.mid),
    uEdge: colorUniform(def.edge),
    uAccent: colorUniform(def.accent),
    uPower: { value: 0 },
  };
}

export const STYLE_UNIFORM_GLSL = /* glsl */ `
  uniform float uTime; uniform float uGain; uniform float uPower;
  uniform vec3 uCore; uniform vec3 uMid; uniform vec3 uEdge; uniform vec3 uAccent;
`;

// ---------------------------------------------------------------- Strip
/** Generic ribbon: n control rows, each row has two edge points (a, b). */
export class Strip {
  constructor(n, material) {
    this.n = n;
    this.pos = new Float32Array(n * 2 * 3);
    const info = new Float32Array(n * 2 * 2);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      info[i * 4] = u; info[i * 4 + 1] = 0;
      info[i * 4 + 2] = u; info[i * 4 + 3] = 1;
    }
    const idx = [];
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aInfo', new THREE.BufferAttribute(info, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);
    this.geometry = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
  }
  set(i, ax, ay, az, bx, by, bz) {
    const o = i * 6;
    this.pos[o] = ax; this.pos[o + 1] = ay; this.pos[o + 2] = az;
    this.pos[o + 3] = bx; this.pos[o + 4] = by; this.pos[o + 5] = bz;
  }
  commit() { this.geometry.attributes.position.needsUpdate = true; }
  dispose() { this.geometry.dispose(); }
}

export const STRIP_VERT = /* glsl */ `
  attribute vec2 aInfo;
  varying vec2 vInfo;
  varying vec3 vWorld;
  void main() {
    vInfo = aInfo;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

export function stripMaterial(fragment, uniforms, { additive = true } = {}) {
  return new THREE.ShaderMaterial({
    uniforms,
    vertexShader: STRIP_VERT,
    fragmentShader: fragment,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
  });
}

// ---------------------------------------------------------------- SweepTrail
const TRAIL_VERT = /* glsl */ `
  attribute vec2 aInfo;   // x = birth time, y = across (0..1)
  uniform float uTime;
  uniform float uLife;
  varying float vAge;
  varying float vAcross;
  varying vec3 vWorld;
  void main() {
    vAge = (uTime - aInfo.x) / uLife;
    vAcross = aInfo.y;
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

/**
 * Surface swept by a blade segment (a→b) over time. Catmull-Rom subdivided so
 * fast swings read as smooth curves rather than polylines.
 */
export class SweepTrail {
  constructor({ samples = 44, sub = 3, life = 0.5, fragment, uniforms }) {
    this.N = samples;
    this.sub = sub;
    this.M = (samples - 1) * sub + 1;
    this.ax = new Float32Array(samples); this.ay = new Float32Array(samples); this.az = new Float32Array(samples);
    this.bx = new Float32Array(samples); this.by = new Float32Array(samples); this.bz = new Float32Array(samples);
    this.t = new Float32Array(samples);
    this.count = 0;
    this.lastPush = -1;
    this.minInterval = 1 / 100;

    this.pos = new Float32Array(this.M * 2 * 3);
    this.info = new Float32Array(this.M * 2 * 2);
    const idx = [];
    for (let i = 0; i < this.M - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aInfo', new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);
    this.geometry = g;

    this.uniforms = { ...uniforms, uLife: { value: life } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: TRAIL_VERT,
      fragmentShader: fragment,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
  }

  set life(v) { this.uniforms.uLife.value = v; }
  get life() { return this.uniforms.uLife.value; }

  /** fill the history with the current position so no stale ribbon appears */
  reset(a, b, time) {
    for (let i = 0; i < this.N; i++) {
      this.ax[i] = a.x; this.ay[i] = a.y; this.az[i] = a.z;
      this.bx[i] = b.x; this.by[i] = b.y; this.bz[i] = b.z;
      this.t[i] = time - 10;
    }
    this.count = 0;
    this.lastPush = -1;
    this._rebuild(time);
  }

  push(a, b, time) {
    if (time - this.lastPush < this.minInterval && this.count > 0) {
      // refresh newest sample in place
      this.ax[0] = a.x; this.ay[0] = a.y; this.az[0] = a.z;
      this.bx[0] = b.x; this.by[0] = b.y; this.bz[0] = b.z;
      this.t[0] = time;
    } else {
      // shift history (N is small; copyWithin is cheap)
      for (const arr of [this.ax, this.ay, this.az, this.bx, this.by, this.bz, this.t]) arr.copyWithin(1, 0, this.N - 1);
      this.ax[0] = a.x; this.ay[0] = a.y; this.az[0] = a.z;
      this.bx[0] = b.x; this.by[0] = b.y; this.bz[0] = b.z;
      this.t[0] = time;
      this.lastPush = time;
      this.count = Math.min(this.N, this.count + 1);
    }
    this._rebuild(time);
  }

  _rebuild(time) {
    const N = this.N, S = this.sub;
    let o = 0, io = 0;
    const cr = (p0, p1, p2, p3, u) => {
      const u2 = u * u, u3 = u2 * u;
      return 0.5 * ((2 * p1) + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
    };
    for (let k = 0; k < N - 1; k++) {
      const k0 = Math.max(0, k - 1), k1 = k, k2 = k + 1, k3 = Math.min(N - 1, k + 2);
      for (let s = 0; s < S; s++) {
        const u = s / S;
        const t = this.t[k1] + (this.t[k2] - this.t[k1]) * u;
        this.pos[o++] = cr(this.ax[k0], this.ax[k1], this.ax[k2], this.ax[k3], u);
        this.pos[o++] = cr(this.ay[k0], this.ay[k1], this.ay[k2], this.ay[k3], u);
        this.pos[o++] = cr(this.az[k0], this.az[k1], this.az[k2], this.az[k3], u);
        this.pos[o++] = cr(this.bx[k0], this.bx[k1], this.bx[k2], this.bx[k3], u);
        this.pos[o++] = cr(this.by[k0], this.by[k1], this.by[k2], this.by[k3], u);
        this.pos[o++] = cr(this.bz[k0], this.bz[k1], this.bz[k2], this.bz[k3], u);
        this.info[io++] = t; this.info[io++] = 0;
        this.info[io++] = t; this.info[io++] = 1;
      }
    }
    // final point
    const e = N - 1;
    this.pos[o++] = this.ax[e]; this.pos[o++] = this.ay[e]; this.pos[o++] = this.az[e];
    this.pos[o++] = this.bx[e]; this.pos[o++] = this.by[e]; this.pos[o++] = this.bz[e];
    this.info[io++] = this.t[e]; this.info[io++] = 0;
    this.info[io++] = this.t[e]; this.info[io++] = 1;
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aInfo.needsUpdate = true;
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------- Lightning
const BOLT_VERT = /* glsl */ `
  attribute vec2 aInfo;     // x = across (-1..1), y = brightness
  varying vec2 vInfo;
  void main() {
    vInfo = aInfo;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const BOLT_FRAG = /* glsl */ `
  uniform vec3 uCore; uniform vec3 uMid; uniform float uGain; uniform float uFlicker;
  varying vec2 vInfo;
  void main() {
    float d = abs(vInfo.x);
    float core = smoothstep(0.35, 0.0, d);
    float glow = smoothstep(1.0, 0.0, d);
    vec3 col = uCore * core * 2.2 + uMid * glow * glow * 1.2;
    float a = (core * 0.9 + glow * glow * 0.6) * vInfo.y * uGain * uFlicker;
    gl_FragColor = vec4(col, a);
  }
`;

/**
 * Procedural branching lightning drawn as camera-facing quads (the scene is
 * essentially 2.5D). Rebuilt on demand into a fixed-size buffer.
 */
export class BoltMesh {
  constructor(maxSegs, uniforms) {
    this.max = maxSegs;
    this.n = 0;
    this.pos = new Float32Array(maxSegs * 4 * 3);
    this.info = new Float32Array(maxSegs * 4 * 2);
    const idx = new Uint16Array(maxSegs * 6);
    for (let s = 0; s < maxSegs; s++) {
      const v = s * 4;
      idx.set([v, v + 1, v + 2, v + 1, v + 3, v + 2], s * 6);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aInfo', new THREE.BufferAttribute(this.info, 2).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);
    this.geometry = g;
    this.uniforms = { uCore: uniforms.uCore, uMid: uniforms.uMid, uGain: uniforms.uGain, uFlicker: { value: 1 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: BOLT_VERT, fragmentShader: BOLT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  clear() { this.n = 0; this.geometry.setDrawRange(0, 0); }

  _seg(ax, ay, az, bx, by, bz, width, bright) {
    if (this.n >= this.max) return;
    const dx = bx - ax, dy = by - ay;
    const l = Math.hypot(dx, dy) || 1e-5;
    const px = (-dy / l) * width, py = (dx / l) * width;
    const o = this.n * 12, io = this.n * 8;
    const P = this.pos, I = this.info;
    P[o] = ax + px; P[o + 1] = ay + py; P[o + 2] = az;
    P[o + 3] = ax - px; P[o + 4] = ay - py; P[o + 5] = az;
    P[o + 6] = bx + px; P[o + 7] = by + py; P[o + 8] = bz;
    P[o + 9] = bx - px; P[o + 10] = by - py; P[o + 11] = bz;
    I[io] = 1; I[io + 1] = bright; I[io + 2] = -1; I[io + 3] = bright;
    I[io + 4] = 1; I[io + 5] = bright; I[io + 6] = -1; I[io + 7] = bright;
    this.n++;
  }

  /** midpoint-displacement bolt with random branches */
  bolt(ax, ay, az, bx, by, bz, { jag = 0.18, depth = 5, width = 0.02, bright = 1, branch = 0.35, branchLen = 0.45 } = {}) {
    this._split(ax, ay, az, bx, by, bz, jag, depth, width, bright, branch, branchLen, 0);
    this.geometry.setDrawRange(0, this.n * 6);
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aInfo.needsUpdate = true;
  }

  _split(ax, ay, az, bx, by, bz, jag, depth, width, bright, branch, branchLen, level) {
    if (depth <= 0 || this.n >= this.max - 2) {
      this._seg(ax, ay, az, bx, by, bz, width, bright);
      return;
    }
    const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5, mz = (az + bz) * 0.5;
    const dx = bx - ax, dy = by - ay;
    const l = Math.hypot(dx, dy) || 1e-5;
    const off = (Math.random() - 0.5) * 2 * jag * l;
    const cx = mx + (-dy / l) * off, cy = my + (dx / l) * off;
    this._split(ax, ay, az, cx, cy, mz, jag, depth - 1, width, bright, branch, branchLen, level);
    this._split(cx, cy, mz, bx, by, bz, jag, depth - 1, width, bright, branch, branchLen, level);
    if (level < 2 && depth >= 3 && Math.random() < branch) {
      const ang = Math.atan2(dy, dx) + (Math.random() < 0.5 ? -1 : 1) * (0.35 + Math.random() * 0.6);
      const len = l * branchLen * (0.5 + Math.random() * 0.8);
      this._split(cx, cy, mz, cx + Math.cos(ang) * len, cy + Math.sin(ang) * len, mz,
        jag, depth - 2, width * 0.6, bright * 0.6, branch * 0.5, branchLen, level + 1);
    }
  }

  dispose() { this.geometry.dispose(); this.material.dispose(); }
}

// ---------------------------------------------------------------- Slash wave
const SLASH_VERT = /* glsl */ `
  attribute vec2 aInfo;     // x along arc (0..1), y across (-1..1)
  varying vec2 vInfo;
  void main() {
    vInfo = aInfo;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

function slashFragment(body) {
  return /* glsl */ `
    ${NOISE_GLSL}
    uniform float uProg; uniform float uGain; uniform float uTime; uniform float uSeed;
    uniform vec3 uCore; uniform vec3 uMid; uniform vec3 uEdge;
    varying vec2 vInfo;
    void main() {
      float along = vInfo.x;          // 0..1 along the arc
      float across = vInfo.y;         // -1 (inner) .. 1 (outer)
      float tip = smoothstep(0.0, 0.18, along) * smoothstep(1.0, 0.82, along);
      float fade = (1.0 - uProg) * smoothstep(0.0, 0.08, uProg);
      ${body}
    }
  `;
}

const SLASH_BODIES = {
  // flame: noisy, thick, hot core with red rim
  flame: `
    float n = fbm(vec2(along * 6.0 + uSeed, across * 2.0 - uTime * 3.0));
    float body = smoothstep(1.0, -0.2, abs(across + (n - 0.5) * 0.9)) * tip;
    float hot = smoothstep(0.55, 0.0, abs(across)) * tip;
    vec3 col = mix(uEdge, uMid, body) + uCore * hot * 0.7;
    gl_FragColor = vec4(col * 1.15, body * fade);`,
  // water: smooth crescent, translucent, foamy edge
  water: `
    float body = smoothstep(1.0, 0.1, abs(across)) * tip;
    float foam = smoothstep(0.75, 1.0, abs(across)) * (0.5 + 0.5 * sin(along * 38.0 + uTime * 6.0)) * tip;
    vec3 col = mix(uMid, uCore, smoothstep(0.7, 0.0, abs(across))) + uCore * foam;
    gl_FragColor = vec4(col * 1.25, (body * 0.7 + foam * 0.5) * fade);`,
  // insect: needle-thin precise line with glints
  insect: `
    float line = smoothstep(0.2, 0.0, abs(across)) * tip;
    float glint = smoothstep(0.02, 0.0, abs(fract(along * 6.0 + uProg * 3.0) - 0.5)) * line;
    vec3 col = mix(uMid, uCore, line) + uCore * glint;
    gl_FragColor = vec4(col * 1.8, (line * 0.9 + glint) * fade);`,
  // thunder: razor-thin jagged flash
  thunder: `
    float j = (vnoise(vec2(along * 14.0 + uSeed, 3.0)) - 0.5) * 1.1;
    float line = smoothstep(0.22, 0.0, abs(across + j)) * tip;
    float halo = smoothstep(1.0, 0.0, abs(across + j)) * tip * 0.35;
    vec3 col = uCore * line * 2.2 + uMid * halo * 1.4;
    gl_FragColor = vec4(col, (line + halo) * fade);`,
};

/** pool of crescent slash meshes, launched along the swing direction */
export class SlashPool {
  constructor(styleId, uniforms, count = 3) {
    const seg = 40;
    const pos = [], info = [], idx = [];
    const half = 1.0; // radians each side
    for (let i = 0; i <= seg; i++) {
      const t = i / seg;
      const a = (t - 0.5) * 2 * half;
      for (const across of [-1, 1]) {
        // crescent: thickness is greatest in the middle, radius 1
        const thick = 0.17 * Math.sin(t * Math.PI) + 0.012;
        const r = 1 + across * thick;
        pos.push(Math.sin(a) * r, Math.cos(a) * r - 1, 0);
        info.push(t, across);
      }
    }
    for (let i = 0; i < seg; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.geometry.setAttribute('aInfo', new THREE.Float32BufferAttribute(info, 2));
    this.geometry.setIndex(idx);
    this.items = [];
    this.group = new THREE.Group();
    for (let i = 0; i < count; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uProg: { value: 1 }, uGain: uniforms.uGain, uTime: uniforms.uTime, uSeed: { value: Math.random() * 10 },
          uCore: uniforms.uCore, uMid: uniforms.uMid, uEdge: uniforms.uEdge,
        },
        vertexShader: SLASH_VERT,
        fragmentShader: slashFragment(SLASH_BODIES[styleId]),
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.geometry, mat);
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      this.group.add(mesh);
      this.items.push({ mesh, mat, t: 1, dur: 1, vx: 0, vy: 0, s0: 1, s1: 1, thin: 1, active: false });
    }
    this.next = 0;
  }

  /**
   * @param {number} x @param {number} y @param {number} z start position
   * @param {number} dx @param {number} dy unit direction of travel
   */
  spawn(x, y, z, dx, dy, { size = 1, grow = 1.5, speed = 3, dur = 0.5, roll = 0, thin = 1 } = {}) {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    it.active = true;
    it.t = 0;
    it.dur = dur;
    it.vx = dx * speed; it.vy = dy * speed;
    it.s0 = size; it.s1 = size * grow; it.thin = thin;
    it.mat.uniforms.uSeed.value = Math.random() * 10;
    const m = it.mesh;
    m.visible = true;
    m.position.set(x, y, z);
    // arc's convex side (local +Y) should face travel direction
    m.rotation.z = Math.atan2(dy, dx) - Math.PI / 2 + roll;
    m.scale.set(size, size * thin, 1);
  }

  update(dt) {
    for (const it of this.items) {
      if (!it.active) continue;
      it.t += dt / it.dur;
      if (it.t >= 1) { it.active = false; it.mesh.visible = false; continue; }
      const e = 1 - (1 - it.t) * (1 - it.t);
      const s = it.s0 + (it.s1 - it.s0) * e;
      it.mesh.scale.set(s, s * it.thin, 1);
      it.mesh.position.x += it.vx * dt * (1 - it.t * 0.7);
      it.mesh.position.y += it.vy * dt * (1 - it.t * 0.7);
      it.mat.uniforms.uProg.value = it.t;
    }
  }

  clear() { for (const it of this.items) { it.active = false; it.mesh.visible = false; } }
  dispose() { this.geometry.dispose(); for (const it of this.items) it.mat.dispose(); }
}
