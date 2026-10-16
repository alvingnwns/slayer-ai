// Water Breathing: spiral water ribbons around the blade, flowing wave trail,
// droplets and spray, graceful crescent arcs, dispersal on recovery.
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
    float wave = 0.5 + 0.5 * sin(vAcross * 9.0 - uTime * 5.0 + vAge * 11.0 + fbm(vWorld.xy * 3.0) * 4.0);
    float crest = smoothstep(0.72, 1.0, wave);
    float body = life * life * (0.28 + 0.5 * wave) * smoothstep(0.0, 0.18, vAcross + 0.12);
    vec3 col = mix(uEdge, uMid, wave);
    col = mix(col, uCore, crest * 0.9 + vAcross * 0.25);
    gl_FragColor = vec4(col * 0.9, (body + crest * life * 0.4) * (0.3 + uPower * 0.4) * uGain);
  }
`;

const RIBBON_FRAG = /* glsl */ `
  ${NOISE_GLSL}
  ${STYLE_UNIFORM_GLSL}
  varying vec2 vInfo; varying vec3 vWorld;
  void main() {
    float u = vInfo.x;
    float across = abs(vInfo.y - 0.5) * 2.0;
    float flow = 0.5 + 0.5 * sin(u * 46.0 - uTime * 7.0 + vInfo.y * 3.0);
    float edge = smoothstep(1.0, 0.55, across);
    float ends = smoothstep(0.0, 0.1, u) * smoothstep(1.0, 0.82, u);
    float a = edge * ends * (0.3 + 0.45 * flow) * (0.3 + uPower * 0.4);
    vec3 col = mix(uMid, uCore, flow * 0.6 + (1.0 - across) * 0.2);
    gl_FragColor = vec4(col * 0.85, a * uGain);
  }
`;

const SEG = 72;

export class WaterFx extends StyleFx {
  constructor(def, host) {
    super(def, host);
    this.trail = new SweepTrail({ samples: 48, sub: 3, life: 0.8, fragment: TRAIL_FRAG, uniforms: this.uniforms });
    this.world.add(this.trail.mesh);

    this.ribbonMat = stripMaterial(RIBBON_FRAG, this.uniforms);
    this.ribbons = [new Strip(SEG, this.ribbonMat), new Strip(SEG, this.ribbonMat)];
    for (const r of this.ribbons) { r.mesh.renderOrder = 3; this.world.add(r.mesh); }

    this.drops = new Particles(900, { gain: this.gain });
    this.world.add(this.drops.points);
    this.spray = new Particles(700, { gain: this.gain });
    this.world.add(this.spray.points);

    this.slash = new SlashPool('water', this.uniforms, 3);
    this.world.add(this.slash.group);

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._v = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._z = new THREE.Vector3(0, 0, 1);
    this._acc = 0;
    this._spin = 0;
    this._power = 0;
    this._expand = 0;
  }

  onShown(f) { this.trail.reset(f.mid, f.tip, f.time); }
  onHidden() { this.drops.clear(); this.spray.clear(); this.slash.clear(); }

  tick(f) {
    const def = this.def;
    let power = 0.32 * f.manifest + 0.5 * f.charge;
    if (f.attacking) power = Math.max(power, 1);
    else if (f.recovering) power = Math.max(power, 0.8 * (1 - f.recoverT));
    power = clamp01(power + Math.min(0.3, f.speed * 0.08));
    this._power += (power - this._power) * Math.min(1, f.dt * 7);
    const P = this._power;
    this.uniforms.uPower.value = P;

    // spiral speed: calm → fast during the attack; expands and "lets go" on recovery
    this._spin += f.dt * (2.4 + 7 * P + (f.attacking ? 6 : 0));
    const expandTarget = f.recovering ? 1.6 + 1.2 * f.recoverT : f.attacking ? 1.5 : 1;
    this._expand += (expandTarget - this._expand) * Math.min(1, f.dt * 5);

    // --- spiral ribbons (world space, wrapped around the blade axis)
    const dir = f.dir;
    this._u.crossVectors(dir, this._z);
    if (this._u.lengthSq() < 1e-4) this._u.set(1, 0, 0);
    this._u.normalize();
    this._v.crossVectors(dir, this._u).normalize();
    const L = f.tip.distanceTo(f.base);
    const w = 0.05 + 0.045 * P;
    for (let r = 0; r < 2; r++) {
      const strip = this.ribbons[r];
      const phase = r * Math.PI + this._spin * (r ? -0.7 : 1);
      for (let i = 0; i < SEG; i++) {
        const s = i / (SEG - 1);
        const th = phase + s * (5.2 + 1.5 * P) * Math.PI;
        const rad = (0.1 + 0.07 * Math.sin(s * Math.PI)) * this._expand * (0.7 + 0.5 * P)
          + 0.025 * Math.sin(f.time * 3 + s * 9 + r * 2);
        const along = s * (L * 1.04) - 0.02;
        const cx = f.base.x + dir.x * along + (this._u.x * Math.cos(th) + this._v.x * Math.sin(th)) * rad;
        const cy = f.base.y + dir.y * along + (this._u.y * Math.cos(th) + this._v.y * Math.sin(th)) * rad;
        const cz = f.base.z + dir.z * along + (this._u.z * Math.cos(th) + this._v.z * Math.sin(th)) * rad;
        strip.set(i, cx - dir.x * w, cy - dir.y * w, cz - dir.z * w, cx + dir.x * w, cy + dir.y * w, cz + dir.z * w);
      }
      strip.commit();
      strip.mesh.visible = f.manifest > 0.02;
    }

    // --- wide flowing sweep
    this._a.lerpVectors(f.base, f.tip, 0.55 - 0.3 * P);
    this._b.copy(f.tip);
    this.trail.life = 0.55 + 0.5 * P;
    if (f.manifest > 0.05) this.trail.push(this._a, this._b, f.time);

    // --- attack: elegant arcs + spray along the swing
    if (f.attackStarted) {
      const sd = f.swingDir;
      for (let k = 0; k < 2; k++) {
        this.slash.spawn(f.tip.x, f.tip.y, f.tip.z - 0.05 * k, sd.x, sd.y, {
          size: (1.0 + 0.4 * f.strength) * (1 + k * 0.28), grow: 1.55, speed: 2.4 - k * 0.5, dur: 0.9 + k * 0.15, thin: 1 - k * 0.15,
        });
      }
      const n = Math.round(140 * f.quality);
      for (let i = 0; i < n; i++) {
        const spread = rand(-0.9, 0.9);
        const ca = Math.cos(spread), sa = Math.sin(spread);
        const dx = sd.x * ca - sd.y * sa, dy = sd.x * sa + sd.y * ca;
        const sp = rand(1.2, 4.2) * (0.6 + 0.6 * f.strength);
        this.spray.emit({
          x: f.tip.x + rand(-0.1, 0.1), y: f.tip.y + rand(-0.1, 0.1), z: f.tip.z + rand(-0.1, 0.1),
          vx: dx * sp, vy: dy * sp, vz: rand(-0.4, 0.4),
          life: rand(0.5, 1.2), size: rand(0.02, 0.05), sizeEnd: 0.4,
          r: def.core[0], g: def.core[1], b: def.core[2], r1: def.mid[0], g1: def.mid[1], b1: def.mid[2],
          drag: 1.6, gravity: -1.5, shape: 0, alpha: 0.85,
        });
      }
    }

    // --- droplets shed from the ribbons; many more while dispersing
    const rate = (10 + 34 * P + (f.recovering ? 70 * (1 - f.recoverT) : 0)) * f.manifest * f.quality;
    this._acc += rate * f.dt;
    while (this._acc >= 1) {
      this._acc -= 1;
      const s = Math.random();
      const th = this._spin + s * 5.5 * Math.PI;
      const rad = 0.12 * this._expand;
      const along = s * L;
      const ox = this._u.x * Math.cos(th) + this._v.x * Math.sin(th);
      const oy = this._u.y * Math.cos(th) + this._v.y * Math.sin(th);
      const oz = this._u.z * Math.cos(th) + this._v.z * Math.sin(th);
      const out = f.recovering ? rand(0.4, 1.4) : rand(0.1, 0.5);
      this.drops.emit({
        x: f.base.x + dir.x * along + ox * rad, y: f.base.y + dir.y * along + oy * rad, z: f.base.z + dir.z * along + oz * rad,
        vx: f.vel.x * 0.25 + ox * out, vy: f.vel.y * 0.25 + oy * out + 0.2, vz: oz * out,
        life: rand(0.6, 1.4), size: rand(0.035, 0.075), sizeEnd: 0.5,
        r: def.core[0], g: def.core[1], b: def.core[2], r1: def.mid[0], g1: def.mid[1], b1: def.mid[2],
        drag: 0.7, gravity: -1.6, shape: 3, alpha: 0.9,
      });
    }

    this.drops.update(f.dt, f.time, f.pixelHeight);
    this.spray.update(f.dt, f.time, f.pixelHeight);
    this.slash.update(f.dt);

    this.light.position.copy(f.mid);
    this.light.position.z += 0.5;
    this.light.intensity = (0.6 + 4.5 * P) * this.weight * f.manifest;
  }

  dispose() {
    this.trail.dispose(); this.drops.dispose(); this.spray.dispose(); this.slash.dispose();
    for (const r of this.ribbons) r.dispose();
    this.ribbonMat.dispose();
  }
}
