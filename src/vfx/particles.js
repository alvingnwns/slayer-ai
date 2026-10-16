// Pooled GPU point-sprite system. All simulation is allocation-free typed-array
// maths; spawning writes into a ring buffer so nothing is ever created at runtime.
import * as THREE from 'three';

const VERT = /* glsl */ `
  attribute float aSize;
  attribute float aAlpha;
  attribute vec3 aColor;
  attribute float aShape;
  attribute float aSeed;
  uniform float uScale;
  uniform float uGain;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vShape;
  varying float vSeed;
  void main() {
    vColor = aColor;
    vAlpha = aAlpha * uGain;
    vShape = aShape;
    vSeed = aSeed;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = aAlpha > 0.001 ? max(1.0, aSize * uScale / -mv.z) : 0.0;
  }
`;

const FRAG = /* glsl */ `
  uniform float uTime;
  varying vec3 vColor;
  varying float vAlpha;
  varying float vShape;
  varying float vSeed;

  float wing(vec2 p, float flap) {
    // butterfly: two lobes each side, squashed horizontally by the flap
    p.x = abs(p.x) / max(0.12, flap);
    float up = length((p - vec2(0.42, 0.22)) * vec2(1.0, 1.15)) ;
    float lo = length((p - vec2(0.3, -0.22)) * vec2(1.25, 1.3));
    float m = max(smoothstep(0.36, 0.28, up), smoothstep(0.26, 0.19, lo));
    float body = smoothstep(0.06, 0.0, abs(p.x) * flap) * smoothstep(0.42, 0.3, abs(p.y));
    return max(m * 0.9, body);
  }

  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r = length(p);
    float m;
    vec3 col = vColor;
    if (vShape < 0.5) {                 // soft glow
      m = exp(-r * r * 3.2);
    } else if (vShape < 1.5) {          // ember: hot core, crisp rim
      m = smoothstep(1.0, 0.55, r);
      col = mix(col, vec3(1.0, 0.95, 0.8), smoothstep(0.5, 0.0, r) * 0.7);
    } else if (vShape < 2.5) {          // butterfly
      float a = vSeed * 6.2831;
      float c = cos(a), s = sin(a);
      vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y) * 1.25;
      float flap = abs(sin(uTime * 14.0 + vSeed * 40.0)) * 0.9 + 0.1;
      m = wing(q, flap);
      col = mix(col, vec3(1.0), smoothstep(0.7, 0.0, r) * 0.25);
      if (m < 0.01) discard;
    } else {                            // droplet: bright rim + highlight
      float rim = smoothstep(0.55, 0.95, r) * smoothstep(1.0, 0.9, r);
      float hi = smoothstep(0.35, 0.0, length(p - vec2(-0.3, -0.3)));
      m = smoothstep(1.0, 0.8, r) * (0.35 + rim * 0.7) + hi * 0.8;
    }
    float a = m * vAlpha;
    if (a < 0.003) discard;
    gl_FragColor = vec4(col * 1.0, a);
  }
`;

export class Particles {
  /**
   * @param {number} max pool size
   * @param {{blending?:number, gain?:{value:number}}} opts
   */
  constructor(max, opts = {}) {
    this.max = max;
    this.head = 0;
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 3);
    this.size = new Float32Array(max);
    this.alpha = new Float32Array(max);
    this.shape = new Float32Array(max);
    this.seed = new Float32Array(max);
    // simulation state
    this.vel = new Float32Array(max * 3);
    this.life = new Float32Array(max);   // 0 = dead
    this.age = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.size0 = new Float32Array(max);
    this.size1 = new Float32Array(max);
    this.alpha0 = new Float32Array(max);
    this.col1 = new Float32Array(max * 3);
    this.col0 = new Float32Array(max * 3);
    this.turb = new Float32Array(max);
    this.alive = 0;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aShape', new THREE.BufferAttribute(this.shape, 1));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);
    this.geometry = g;

    this.uniforms = {
      uScale: { value: 600 },
      uTime: { value: 0 },
      uGain: opts.gain || { value: 1 },
    };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      blending: opts.blending ?? THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
  }

  /**
   * Spawn one particle. `p` fields are all optional numbers:
   * x,y,z, vx,vy,vz, life, size, sizeEnd (multiplier), alpha,
   * r,g,b (start) r1,g1,b1 (end), drag, gravity, turb, shape(0..3)
   */
  emit(p) {
    const i = this.head;
    this.head = (this.head + 1) % this.max;
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z || 0;
    this.vel[i3] = p.vx || 0; this.vel[i3 + 1] = p.vy || 0; this.vel[i3 + 2] = p.vz || 0;
    this.life[i] = p.life || 1;
    this.age[i] = 0;
    this.size0[i] = p.size || 0.1;
    this.size1[i] = p.sizeEnd == null ? 0.2 : p.sizeEnd;
    this.alpha0[i] = p.alpha == null ? 1 : p.alpha;
    this.col0[i3] = p.r; this.col0[i3 + 1] = p.g; this.col0[i3 + 2] = p.b;
    this.col1[i3] = p.r1 == null ? p.r : p.r1;
    this.col1[i3 + 1] = p.g1 == null ? p.g : p.g1;
    this.col1[i3 + 2] = p.b1 == null ? p.b : p.b1;
    this.drag[i] = p.drag || 0;
    this.grav[i] = p.gravity || 0;
    this.turb[i] = p.turb || 0;
    this.shape[i] = p.shape || 0;
    this.seed[i] = Math.random();
    this.geometry.attributes.aShape.needsUpdate = true;
    this.geometry.attributes.aSeed.needsUpdate = true;
  }

  update(dt, time, pixelHeight) {
    const u = this.uniforms;
    u.uTime.value = time;
    // point size in px: world size → screen via perspective (fov 40°, handled by uScale)
    u.uScale.value = pixelHeight / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
    let alive = 0;
    const { pos, vel, life, age, col, col0, col1, size, size0, size1, alpha, alpha0, drag, grav, turb, seed } = this;
    for (let i = 0; i < this.max; i++) {
      const l = life[i];
      if (l <= 0) { if (alpha[i] !== 0) alpha[i] = 0; continue; }
      const a = age[i] + dt;
      if (a >= l) {
        life[i] = 0; alpha[i] = 0; size[i] = 0;
        continue;
      }
      age[i] = a;
      alive++;
      const k = a / l;
      const i3 = i * 3;
      const d = Math.exp(-drag[i] * dt);
      vel[i3] *= d; vel[i3 + 1] *= d; vel[i3 + 2] *= d;
      vel[i3 + 1] += grav[i] * dt;
      const tb = turb[i];
      if (tb > 0) {
        const s = seed[i] * 31.4;
        vel[i3] += Math.sin(time * 3.1 + s) * tb * dt;
        vel[i3 + 1] += Math.cos(time * 2.3 + s * 1.7) * tb * dt * 0.6;
        vel[i3 + 2] += Math.sin(time * 2.7 + s * 0.6) * tb * dt * 0.3;
      }
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      col[i3] = col0[i3] + (col1[i3] - col0[i3]) * k;
      col[i3 + 1] = col0[i3 + 1] + (col1[i3 + 1] - col0[i3 + 1]) * k;
      col[i3 + 2] = col0[i3 + 2] + (col1[i3 + 2] - col0[i3 + 2]) * k;
      size[i] = size0[i] * (1 + (size1[i] - 1) * k);
      // quick fade-in, long fade-out
      const fin = Math.min(1, k * 14);
      alpha[i] = alpha0[i] * fin * (1 - k) * (1 - k * 0.3);
    }
    this.alive = alive;
    const at = this.geometry.attributes;
    at.position.needsUpdate = true;
    at.aColor.needsUpdate = true;
    at.aSize.needsUpdate = true;
    at.aAlpha.needsUpdate = true;
  }

  clear() {
    this.life.fill(0);
    this.alpha.fill(0);
    this.alive = 0;
  }

  dispose() {
    this.geometry.dispose();
    this.material.dispose();
  }
}
