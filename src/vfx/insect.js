// Insect Breathing: luminous butterflies, hair-fine trails, a narrow thrust
// beam and a concentrated particle burst at the end of the attack.
import * as THREE from 'three';
import { StyleFx, clamp01, rand } from './base.js';
import { NOISE_GLSL, STYLE_UNIFORM_GLSL, SweepTrail, SlashPool, Strip, stripMaterial } from './common.js';
import { Particles } from './particles.js';

const TRAIL_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  ${STYLE_UNIFORM_GLSL}
  varying float vAge; varying float vAcross; varying vec3 vWorld;
  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;
    float life = 1.0 - vAge;
    float glint = pow(0.5 + 0.5 * sin(vAge * 70.0 - uTime * 12.0), 6.0);
    float a = life * life * (0.55 + glint * 0.9);
    vec3 col = mix(uMid, uCore, glint * 0.8 + 0.15);
    col = mix(col, uAccent, smoothstep(0.5, 1.0, vAge) * 0.6);
    gl_FragColor = vec4(col * 1.6, a * (0.5 + uPower * 0.6) * uGain);
  }
`;

const NEEDLE_FRAG = /* glsl */ `
  ${STYLE_UNIFORM_GLSL}
  uniform float uProg;
  varying vec2 vInfo; varying vec3 vWorld;
  void main() {
    float u = vInfo.x;                       // 0 at the tip of the blade → 1 at the spear point
    float across = abs(vInfo.y - 0.5) * 2.0;
    float core = smoothstep(1.0, 0.0, across);
    float taper = smoothstep(1.0, 0.7, u) * smoothstep(0.0, 0.05, u);
    float fade = 1.0 - uProg;
    vec3 col = uCore * core * core * 2.0 + uMid * core * 0.9 + uAccent * smoothstep(0.6, 1.0, across) * 0.4;
    gl_FragColor = vec4(col, core * taper * fade * uGain);
  }
`;

const NEEDLE_SEG = 14;

export class InsectFx extends StyleFx {
  constructor(def, host) {
    super(def, host);
    this.trailTip = new SweepTrail({ samples: 48, sub: 3, life: 0.75, fragment: TRAIL_FRAG, uniforms: this.uniforms });
    this.trailMid = new SweepTrail({ samples: 40, sub: 2, life: 0.5, fragment: TRAIL_FRAG, uniforms: this.uniforms });
    this.world.add(this.trailTip.mesh, this.trailMid.mesh);

    this.flies = new Particles(380, { gain: this.gain });
    this.sparks = new Particles(600, { gain: this.gain });
    this.world.add(this.flies.points, this.sparks.points);

    this.slash = new SlashPool('insect', this.uniforms, 2);
    this.world.add(this.slash.group);

    this.needleUniforms = { ...this.uniforms, uProg: { value: 1 } };
    this.needleMat = stripMaterial(NEEDLE_FRAG, this.needleUniforms);
    this.needle = new Strip(NEEDLE_SEG, this.needleMat);
    this.needle.mesh.visible = false;
    this.needle.mesh.renderOrder = 4;
    this.world.add(this.needle.mesh);

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._o = new THREE.Vector3();
    this._acc = 0;
    this._sparkAcc = 0;
    this._power = 0;
    this._burst = false;
    this._needleOrigin = new THREE.Vector3();
    this._needleDir = new THREE.Vector3();
    this._needleLen = 0;
  }

  onShown(f) {
    this.trailTip.reset(f.tip, f.tip, f.time);
    this.trailMid.reset(f.mid, f.mid, f.time);
  }
  onHidden() { this.flies.clear(); this.sparks.clear(); this.slash.clear(); this.needle.mesh.visible = false; }

  /** anticipation → lightning-fast thrust → ease back */
  swordOffset(f, out) {
    if (!f.attacking) return out.set(0, 0, 0);
    const t = f.attackT;
    let d;
    if (t < 0.1) d = -0.15 * (t / 0.1);
    else if (t < 0.2) d = -0.15 + (0.15 + 0.85) * ((t - 0.1) / 0.1) ** 0.6;
    else d = 0.85 * Math.exp(-(t - 0.2) * 4.2);
    return out.copy(f.dir).multiplyScalar(d * (0.5 + 0.5 * f.strength));
  }

  _burstAt(p, count, f) {
    const def = this.def;
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(0.5, 3.2);
      const fly = i % 6 === 0;
      const pool = fly ? this.flies : this.sparks;
      pool.emit({
        x: p.x, y: p.y, z: p.z,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(-0.6, 0.6),
        life: fly ? rand(1.0, 2.0) : rand(0.35, 0.9),
        size: fly ? rand(0.17, 0.3) : rand(0.025, 0.06), sizeEnd: fly ? 0.9 : 0.1,
        r: def.core[0], g: def.core[1], b: def.core[2],
        r1: (fly ? def.accent : def.mid)[0], g1: (fly ? def.accent : def.mid)[1], b1: (fly ? def.accent : def.mid)[2],
        drag: fly ? 1.8 : 2.6, shape: fly ? 2 : 0, turb: fly ? 1.5 : 0.2,
      });
    }
  }

  tick(f) {
    const def = this.def;
    let power = 0.3 * f.manifest + 0.55 * f.charge;
    if (f.attacking) power = 1;
    else if (f.recovering) power = Math.max(power, 0.5 * (1 - f.recoverT));
    power = clamp01(power + Math.min(0.25, f.speed * 0.06));
    this._power += (power - this._power) * Math.min(1, f.dt * 8);
    const P = this._power;
    this.uniforms.uPower.value = P;

    // --- hair-fine trails following the tip and the middle of the blade
    if (f.manifest > 0.05) {
      this._a.copy(f.tip);
      this._b.copy(f.tip).addScaledVector(f.dir, -0.05);
      this.trailTip.push(this._a, this._b, f.time);
      this._a.copy(f.mid);
      this._b.copy(f.mid).addScaledVector(f.dir, -0.035);
      this.trailMid.push(this._a, this._b, f.time);
    }

    // --- attack: narrow thrust beam
    if (f.attackStarted) {
      this._burst = false;
      this._needleOrigin.copy(f.tip);
      this._needleDir.copy(f.dir);
      this._needleLen = 2.8 + 1.2 * f.strength;
      const sd = f.swingDir;
      this.slash.spawn(f.tip.x, f.tip.y, f.tip.z, f.dir.x, f.dir.y, { size: 0.42, grow: 2.4, speed: 5, dur: 0.4, thin: 1 });
      this.slash.spawn(f.tip.x, f.tip.y, f.tip.z, sd.x, sd.y, { size: 0.7, grow: 1.5, speed: 2.0, dur: 0.5, thin: 1 });
    }
    const nm = this.needle.mesh;
    if (f.attacking && this._needleLen > 0) {
      const t = f.attackT;
      const ext = Math.min(1, Math.max(0, (t - 0.08) / 0.17));        // thrust out fast
      const len = this._needleLen * (1 - (1 - ext) ** 3);
      const wid = 0.032 * (1 - clamp01((t - 0.3) / 0.5));
      nm.visible = ext > 0;
      this.needleUniforms.uProg.value = clamp01((t - 0.25) / 0.7);
      this._o.set(-this._needleDir.y, this._needleDir.x, 0).multiplyScalar(wid);
      const o = this._needleOrigin;
      for (let i = 0; i < NEEDLE_SEG; i++) {
        const s = i / (NEEDLE_SEG - 1);
        const x = o.x + this._needleDir.x * len * s, y = o.y + this._needleDir.y * len * s, z = o.z + this._needleDir.z * len * s;
        const k = Math.sin(s * Math.PI * 0.9 + 0.15) ; // fatter near the base, needle-sharp at the end
        this.needle.set(i, x + this._o.x * k, y + this._o.y * k, z, x - this._o.x * k, y - this._o.y * k, z);
      }
      this.needle.commit();
      // concentrated burst where the thrust ends
      if (!this._burst && t >= 0.3) {
        this._burst = true;
        this._p.copy(o).addScaledVector(this._needleDir, len);
        this._burstAt(this._p, Math.round(90 * f.quality), f);
        this.host.stage.addFlash(0.06);
      }
    } else if (nm.visible) {
      nm.visible = false;
    }

    // --- butterflies flutter off the blade
    const rate = (7 + 30 * f.charge + 10 * P) * f.manifest * f.quality;
    this._acc += rate * f.dt;
    while (this._acc >= 1) {
      this._acc -= 1;
      this._p.lerpVectors(f.base, f.tip, rand(0.1, 1));
      const a = rand(0, Math.PI * 2);
      this.flies.emit({
        x: this._p.x, y: this._p.y, z: this._p.z + rand(-0.05, 0.1),
        vx: Math.cos(a) * rand(0.15, 0.5) + f.vel.x * 0.1, vy: Math.sin(a) * rand(0.15, 0.5) + rand(0.1, 0.5) + f.vel.y * 0.1, vz: rand(-0.1, 0.2),
        life: rand(1.6, 3.0), size: rand(0.17, 0.28), sizeEnd: 0.8,
        r: def.mid[0], g: def.mid[1], b: def.mid[2],
        r1: Math.random() < 0.4 ? def.accent[0] : def.core[0], g1: Math.random() < 0.4 ? def.accent[1] : def.core[1], b1: Math.random() < 0.4 ? def.accent[2] : def.core[2],
        drag: 0.5, shape: 2, turb: 2.2, alpha: 0.95,
      });
    }
    // tiny luminous motes
    this._sparkAcc += (20 + 40 * P) * f.manifest * f.quality * f.dt;
    while (this._sparkAcc >= 1) {
      this._sparkAcc -= 1;
      this._p.lerpVectors(f.base, f.tip, rand(0, 1));
      this.sparks.emit({
        x: this._p.x, y: this._p.y, z: this._p.z,
        vx: rand(-0.2, 0.2), vy: rand(0.0, 0.5), vz: rand(-0.1, 0.1),
        life: rand(0.5, 1.1), size: rand(0.02, 0.045), sizeEnd: 0.1,
        r: def.core[0], g: def.core[1], b: def.core[2], r1: def.mid[0], g1: def.mid[1], b1: def.mid[2],
        drag: 1.0, shape: 0, turb: 0.8, alpha: 0.9,
      });
    }

    this.flies.update(f.dt, f.time, f.pixelHeight);
    this.sparks.update(f.dt, f.time, f.pixelHeight);
    this.slash.update(f.dt);

    this.light.position.copy(f.mid);
    this.light.position.z += 0.5;
    this.light.intensity = (0.5 + 3.5 * P) * this.weight * f.manifest;
  }

  dispose() {
    this.trailTip.dispose(); this.trailMid.dispose(); this.flies.dispose(); this.sparks.dispose();
    this.slash.dispose(); this.needle.dispose(); this.needleMat.dispose();
  }
}
