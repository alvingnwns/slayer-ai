// Flame Breathing: curved fire trails, flame shell around the blade, rising
// embers, burst on attack, heat-haze (applied by the stage post pass).
import * as THREE from 'three';
import { StyleFx, clamp01, rand, smooth } from './base.js';
import { NOISE_GLSL, STYLE_UNIFORM_GLSL, SweepTrail, SlashPool } from './common.js';
import { Particles } from './particles.js';
import { BLADE_LEN, BLADE_START } from '../sword/katana.js';

const TRAIL_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  ${STYLE_UNIFORM_GLSL}
  varying float vAge; varying float vAcross; varying vec3 vWorld;
  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;
    float life = 1.0 - vAge;
    // flames lick upward in world space and flare away from the blade
    vec2 p = vWorld.xy * 2.6 + vec2(0.0, -uTime * 1.8);
    float n = fbm(p + vec2(vAge * 3.0, vAcross * 2.0));
    float body = life * (0.35 + 1.1 * n);
    body *= smoothstep(0.0, 0.12, vAcross) * 0.65 + 0.35;
    float cut = smoothstep(0.0, 0.25, body - vAge * 0.45);
    float heat = clamp(body * 1.5 - vAge * 0.6, 0.0, 1.5);
    vec3 col = mix(uEdge, uMid, smoothstep(0.1, 0.6, heat));
    col = mix(col, uCore, smoothstep(0.95, 1.6, heat));
    gl_FragColor = vec4(col * (0.85 + uPower * 0.45), cut * (0.35 + uPower * 0.4) * uGain);
  }
`;

const AURA_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const AURA_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  ${STYLE_UNIFORM_GLSL}
  varying vec2 vUv;
  void main() {
    float along = vUv.y;                       // 0 hilt → 1 tip
    float n = fbm(vec2(vUv.x * 9.0, along * 5.0 - uTime * 3.2));
    float n2 = fbm(vec2(vUv.x * 17.0 + 3.0, along * 9.0 - uTime * 5.5));
    float body = (0.25 + n * 0.9 + n2 * 0.35) * (1.0 - along * 0.55);
    body *= smoothstep(0.0, 0.05, along) * smoothstep(1.0, 0.9, along);
    float heat = clamp(body * (0.8 + uPower), 0.0, 1.6);
    vec3 col = mix(uEdge, uMid, smoothstep(0.1, 0.55, heat));
    col = mix(col, uCore, smoothstep(0.6, 1.2, heat));
    gl_FragColor = vec4(col * 0.95, clamp(body * uPower * 0.55, 0.0, 1.0) * uGain);
  }
`;

export class FlameFx extends StyleFx {
  constructor(def, host) {
    super(def, host);
    this.trail = new SweepTrail({ samples: 44, sub: 3, life: 0.55, fragment: TRAIL_FRAG, uniforms: this.uniforms });
    this.world.add(this.trail.mesh);

    this.embers = new Particles(900, { gain: this.gain });
    this.world.add(this.embers.points);

    this.slash = new SlashPool('flame', this.uniforms, 3);
    this.world.add(this.slash.group);

    const auraGeo = new THREE.CylinderGeometry(0.075, 0.05, BLADE_LEN, 28, 1, true);
    this.auraMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: AURA_VERT, fragmentShader: AURA_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.aura = new THREE.Mesh(auraGeo, this.auraMat);
    this.aura.position.y = BLADE_START + BLADE_LEN / 2;
    this.aura.renderOrder = 5;
    this.local.add(this.aura);

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._acc = 0;
    this._power = 0;
    this._uvA = { x: 0, y: 0 };
    this._uvB = { x: 0, y: 0 };
  }

  onShown(f) { this.trail.reset(f.mid, f.tip, f.time); }
  onHidden() { this.embers.clear(); this.slash.clear(); }

  tick(f) {
    const { stage } = this.host;
    const def = this.def;
    // power: how violently the flame burns right now
    let power = 0.25 * f.manifest + 0.55 * f.charge;
    if (f.attacking) power = Math.max(power, 1.0 - f.attackT * 0.35);
    else if (f.recovering) power = Math.max(power, 0.65 * (1 - f.recoverT));
    power = clamp01(power + Math.min(0.35, f.speed * 0.1));
    this._power += (power - this._power) * Math.min(1, f.dt * 9);
    const P = this._power;
    this.uniforms.uPower.value = P;

    // --- blade flame shell
    const s = 1 + P * 0.6;
    this.aura.scale.set(s, 1, s);
    this.aura.visible = f.manifest > 0.02;

    // --- swept trail: wider during an attack
    const frac = 0.5 - 0.32 * P;
    this._a.lerpVectors(f.base, f.tip, frac);
    this._b.copy(f.tip);
    this.trail.life = 0.38 + 0.4 * P;
    if (f.manifest > 0.05) this.trail.push(this._a, this._b, f.time);

    // --- attack burst
    if (f.attackStarted) {
      const sd = f.swingDir;
      for (let k = 0; k < 2; k++) {
        this.slash.spawn(f.tip.x - sd.x * 0.3 * k, f.tip.y - sd.y * 0.3 * k, f.tip.z, sd.x, sd.y, {
          size: (0.9 + 0.35 * f.strength) * (1 - k * 0.25), grow: 1.8, speed: 3.2, dur: 0.55 + k * 0.1, roll: k * 0.08,
        });
      }
      const n = Math.round(110 * f.quality);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = rand(1.0, 5.0) * (0.6 + f.strength * 0.6);
        this.embers.emit({
          x: f.tip.x, y: f.tip.y, z: f.tip.z,
          vx: Math.cos(a) * sp + sd.x * 1.5, vy: Math.sin(a) * sp + sd.y * 1.5, vz: rand(-0.5, 0.5),
          life: rand(0.35, 0.95), size: rand(0.03, 0.075), sizeEnd: 0.1,
          r: def.accent[0], g: def.accent[1], b: def.accent[2], r1: def.edge[0], g1: def.edge[1], b1: def.edge[2],
          drag: 2.0, gravity: -1.2, shape: 1, turb: 1.0,
        });
      }
      stage.addFlash(0.12 * f.strength);
    }

    // --- rising embers along the blade, inheriting its motion
    const rate = (22 + 80 * P) * f.manifest * f.quality;
    this._acc += rate * f.dt;
    while (this._acc >= 1) {
      this._acc -= 1;
      const t = rand(0.05, 1);
      this._p.lerpVectors(f.base, f.tip, t);
      this.embers.emit({
        x: this._p.x + rand(-0.03, 0.03), y: this._p.y + rand(-0.03, 0.03), z: this._p.z + rand(-0.04, 0.04),
        vx: f.vel.x * 0.18 + rand(-0.3, 0.3), vy: f.vel.y * 0.18 + rand(0.5, 1.5), vz: rand(-0.2, 0.2),
        life: rand(0.7, 1.7), size: rand(0.028, 0.07) * (0.7 + P * 0.6), sizeEnd: 0.15,
        r: def.accent[0], g: def.accent[1], b: def.accent[2], r1: def.edge[0], g1: def.edge[1], b1: def.edge[2],
        drag: 0.9, gravity: 0.45, shape: 1, turb: 1.6, alpha: 0.95,
      });
    }

    this.embers.update(f.dt, f.time, f.pixelHeight);
    this.slash.update(f.dt);

    // --- light + heat haze
    const flick = 0.85 + 0.15 * Math.sin(f.time * 31) * Math.sin(f.time * 17.3);
    this.light.position.copy(f.mid);
    this.light.position.z += 0.5;
    this.light.intensity = (0.8 + 7 * P) * flick * this.weight * f.manifest;
    this.heat = P * smooth(0.0, 0.2, f.manifest);
    if (this.heat > 0.01) {
      stage.worldToUv(f.mid, this._uvA);
      stage.worldToUv(f.tip, this._uvB);
      stage.setHeat(this._uvA, this._uvB, this.heat * this.weight, 0.09 + 0.08 * P);
    }
  }

  dispose() {
    this.trail.dispose(); this.embers.dispose(); this.slash.dispose();
    this.aura.geometry.dispose(); this.auraMat.dispose();
  }
}
