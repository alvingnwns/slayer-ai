// Thunder Breathing: procedural branching lightning, arcs around the blade,
// zig-zag trail, short charge → near-instant dash, impact flash with decay.
import * as THREE from 'three';
import { StyleFx, clamp01, rand } from './base.js';
import { STYLE_UNIFORM_GLSL, SweepTrail, SlashPool, BoltMesh } from './common.js';
import { Particles } from './particles.js';

const TRAIL_FRAG = /* glsl */ `
  ${STYLE_UNIFORM_GLSL}
  varying float vAge; varying float vAcross; varying vec3 vWorld;
  void main() {
    if (vAge < 0.0 || vAge > 1.0) discard;
    float life = 1.0 - vAge;
    float f = life * life * life;
    float crack = step(0.5, fract(vAge * 18.0 + vAcross * 3.0));
    vec3 col = mix(uMid, uCore, f) + uAccent * 0.25 * (1.0 - f) * crack;
    gl_FragColor = vec4(col * 2.0, f * (0.35 + 0.65 * crack) * (0.5 + uPower * 0.8) * uGain);
  }
`;

// attack timeline (fractions of attackT)
const WINDUP = 0.16;

export class ThunderFx extends StyleFx {
  constructor(def, host) {
    super(def, host);
    this.trail = new SweepTrail({ samples: 40, sub: 1, life: 0.32, fragment: TRAIL_FRAG, uniforms: this.uniforms });
    this.world.add(this.trail.mesh);

    this.arcs = new BoltMesh(520, this.uniforms);   // blade arcs
    this.main = new BoltMesh(700, this.uniforms);   // the big strike
    this.world.add(this.arcs.mesh, this.main.mesh);

    this.sparks = new Particles(500, { gain: this.gain });
    this.world.add(this.sparks.points);

    this.slash = new SlashPool('thunder', this.uniforms, 2);
    this.world.add(this.slash.group);

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._q = new THREE.Vector3();
    this._arcT = 0;
    this._mainT = 0;
    this._fired = false;
    this._power = 0;
    this._flash = 0;
    this._acc = 0;
  }

  onShown(f) { this.trail.reset(f.mid, f.tip, f.time); }
  onHidden() { this.sparks.clear(); this.slash.clear(); this.arcs.clear(); this.main.clear(); }

  /** charge → blink-fast dash → quick return */
  swordOffset(f, out) {
    if (!f.attacking || f.attackT < WINDUP) {
      if (f.attacking) return out.copy(f.dir).multiplyScalar(-0.06 * (f.attackT / WINDUP)); // coil back slightly
      return out.set(0, 0, 0);
    }
    const t = (f.attackT - WINDUP) / (1 - WINDUP);
    const d = t < 0.1 ? t / 0.1 : Math.exp(-(t - 0.1) * 5.5);
    return out.copy(f.dir).multiplyScalar(d * 1.55 * (0.55 + 0.45 * f.strength));
  }

  tick(f) {
    const { stage } = this.host;
    const def = this.def;
    let power = 0.22 * f.manifest + 0.7 * f.charge;
    if (f.attacking) power = f.attackT < WINDUP ? 0.8 + 0.2 * (f.attackT / WINDUP) : 1;
    else if (f.recovering) power = Math.max(power, 0.5 * (1 - f.recoverT));
    power = clamp01(power + Math.min(0.3, f.speed * 0.07));
    this._power += (power - this._power) * Math.min(1, f.dt * 14);
    const P = this._power;
    this.uniforms.uPower.value = P;

    // --- zig-zag trail: jitter the samples so it reads as forked, not smooth
    if (f.manifest > 0.05) {
      const j = 0.03 + 0.11 * clamp01(f.speed * 0.25 + (f.attacking ? 0.6 : 0));
      this._a.lerpVectors(f.base, f.tip, 0.45).add(this._p.set(rand(-j, j), rand(-j, j), 0));
      this._b.copy(f.tip).add(this._q.set(rand(-j, j), rand(-j, j), 0));
      this.trail.push(this._a, this._b, f.time);
    }

    // --- attack: wind-up, then strike
    if (f.attackStarted) { this._fired = false; this._mainT = 0; }
    if (f.attacking && !this._fired && f.attackT >= WINDUP) {
      this._fired = true;
      this._mainT = 0.22;
      stage.addFlash(0.55 * (0.6 + 0.4 * f.strength));
      stage.shake(this.def.shake * f.strength, 0.22);
      const sd = f.swingDir;
      this.slash.spawn(f.tip.x, f.tip.y, f.tip.z, f.dir.x, f.dir.y, { size: 0.9, grow: 2.4, speed: 7, dur: 0.28, thin: 0.55 });
      this.slash.spawn(f.tip.x, f.tip.y, f.tip.z, sd.x, sd.y, { size: 0.7, grow: 1.8, speed: 3, dur: 0.32, thin: 0.5 });
      const n = Math.round(90 * f.quality);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        const sp = rand(1.5, 6);
        this.sparks.emit({
          x: f.tip.x, y: f.tip.y, z: f.tip.z,
          vx: Math.cos(a) * sp + f.dir.x * 2, vy: Math.sin(a) * sp + f.dir.y * 2, vz: rand(-0.4, 0.4),
          life: rand(0.15, 0.55), size: rand(0.02, 0.05), sizeEnd: 0.1,
          r: def.core[0], g: def.core[1], b: def.core[2], r1: def.mid[0], g1: def.mid[1], b1: def.mid[2],
          drag: 3.0, shape: 0,
        });
      }
    }

    // --- main bolt: regenerated rapidly for a flickering strike, with controlled decay
    if (this._mainT > 0) {
      this._mainT -= f.dt;
      const k = clamp01(this._mainT / 0.22);
      this.main.uniforms.uFlicker.value = 0.35 + 0.65 * k;
      this._arcT -= f.dt;
      if (this._arcT <= 0 || this.main.n === 0) {
        this._arcT = 0.035;
        this.main.clear();
        const L = 2.6 + 1.6 * f.strength;
        const ex = f.tip.x + f.dir.x * L, ey = f.tip.y + f.dir.y * L, ez = f.tip.z;
        this.main.bolt(f.tip.x, f.tip.y, f.tip.z, ex, ey, ez, { jag: 0.2, depth: 6, width: 0.07 * (0.6 + k), bright: 1.1, branch: 0.5, branchLen: 0.5 });
        // a second bolt from the blade root keeps the blade itself lit
        this.main.bolt(f.base.x, f.base.y, f.base.z, f.tip.x, f.tip.y, f.tip.z, { jag: 0.06, depth: 4, width: 0.04, bright: 0.9, branch: 0.2, branchLen: 0.3 });
      }
      if (this._mainT <= 0) this.main.clear();
    }

    // --- blade arcs: constantly crackling, more intense while charging
    this._acc -= f.dt;
    if (this._acc <= 0) {
      this._acc = 0.05 + (1 - P) * 0.06;
      this.arcs.clear();
      const n = Math.round((1 + 6 * P) * f.manifest * (f.quality > 0.6 ? 1 : 0.5)) + (Math.random() < 0.4 ? 1 : 0);
      for (let i = 0; i < n; i++) {
        this._p.lerpVectors(f.base, f.tip, rand(0.05, 1));
        const a = rand(0, Math.PI * 2);
        const r = rand(0.18, 0.4) * (0.7 + P * 0.8);
        this.arcs.bolt(this._p.x, this._p.y, this._p.z, this._p.x + Math.cos(a) * r, this._p.y + Math.sin(a) * r, this._p.z,
          { jag: 0.28, depth: 3, width: 0.04, bright: 0.6 + 0.4 * P, branch: 0.2, branchLen: 0.5 });
      }
      // a few arcs run the whole length of the blade when fully charged
      if (f.charge > 0.5 && Math.random() < f.charge * 0.7) {
        this.arcs.bolt(f.base.x, f.base.y, f.base.z, f.tip.x, f.tip.y, f.tip.z, { jag: 0.1, depth: 4, width: 0.04, bright: 0.9, branch: 0.1 });
      }
      this.arcs.uniforms.uFlicker.value = 0.7 + 0.3 * Math.random();
      // sparks at the arc roots
      if (Math.random() < 0.5 * P * f.quality) {
        this._p.lerpVectors(f.base, f.tip, Math.random());
        this.sparks.emit({
          x: this._p.x, y: this._p.y, z: this._p.z, vx: rand(-1.4, 1.4), vy: rand(-1.4, 1.4), vz: 0,
          life: rand(0.12, 0.3), size: rand(0.02, 0.04), sizeEnd: 0.1,
          r: def.core[0], g: def.core[1], b: def.core[2], drag: 2.5, shape: 0,
        });
      }
    }

    this.sparks.update(f.dt, f.time, f.pixelHeight);
    this.slash.update(f.dt);

    // --- light: strobing, spikes on impact
    const strobe = 0.75 + 0.25 * Math.random();
    const impact = this._mainT > 0 ? 14 * (this._mainT / 0.22) : 0;
    this.light.position.copy(f.mid);
    this.light.position.z += 0.5;
    this.light.intensity = (0.8 + 6 * P) * strobe * this.weight * f.manifest + impact;
  }

  dispose() {
    this.trail.dispose(); this.arcs.dispose(); this.main.dispose(); this.sparks.dispose(); this.slash.dispose();
  }
}
