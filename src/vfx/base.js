// Base class shared by the four Breathing Style effect sets.
//
// Every style gets two groups:
//   world – lives in scene space (trails, particles, bolts, slash waves)
//   local – parented to the katana so it moves rigidly with the blade
//
// `frame` (built once per render frame by the app) carries everything the
// effects need; styles never reach into the tracking or UI layers.
import * as THREE from 'three';
import { makeStyleUniforms } from './common.js';

/**
 * @typedef {object} VfxFrame
 * @property {number} time  seconds
 * @property {number} dt
 * @property {THREE.Vector3} tip   blade tip, world
 * @property {THREE.Vector3} mid   blade midpoint, world
 * @property {THREE.Vector3} base  start of blade (habaki), world
 * @property {THREE.Vector3} dir   unit vector base→tip, world
 * @property {THREE.Vector3} vel   tip velocity (world units/s)
 * @property {number} speed        hand speed in screen-heights/s
 * @property {number} manifest     0..1
 * @property {number} charge       0..1
 * @property {boolean} attacking
 * @property {number} attackT      0..1 within the attack
 * @property {boolean} recovering
 * @property {number} recoverT     0..1 within the recovery
 * @property {boolean} attackStarted true for exactly one frame
 * @property {number} strength     0..1
 * @property {number} pixelHeight  drawing-buffer height
 * @property {number} quality      particle budget multiplier 0.4..1
 */

export class StyleFx {
  constructor(def, host) {
    this.def = def;
    this.host = host; // { stage, katana }
    this.world = new THREE.Group();
    this.local = new THREE.Group();
    this.gain = { value: 0 };
    this.uniforms = makeStyleUniforms(def, this.gain);
    this.weight = 0;
    this.target = 0;
    this.heat = 0;           // 0..1 heat-haze request (flame only)
    this.light = new THREE.PointLight(new THREE.Color(def.mid[0], def.mid[1], def.mid[2]), 0, 6, 2);
    this.world.add(this.light);
    this.world.visible = false;
    this.local.visible = false;
    this._attackFired = false;
  }

  setActive(on) { this.target = on ? 1 : 0; }

  get visible() { return this.weight > 0.002; }

  /** @returns {THREE.Vector3} extra displacement of the sword (dash/thrust) */
  swordOffset(frame, out) { return out.set(0, 0, 0); }

  update(frame) {
    const dt = frame.dt;
    this.weight += (this.target - this.weight) * (1 - Math.exp(-dt * (this.target > this.weight ? 7 : 9)));
    if (this.target === 0 && this.weight < 0.004) {
      if (this.world.visible) {
        this.world.visible = false;
        this.local.visible = false;
        this.gain.value = 0;
        this.onHidden();
      }
      this.heat = 0;
      return;
    }
    if (!this.world.visible) {
      this.world.visible = true;
      this.local.visible = true;
      this.onShown(frame);
    }
    this.gain.value = this.weight;
    this.uniforms.uTime.value = frame.time;
    this.tick(frame);
  }

  // hooks ------------------------------------------------------------
  onShown() {}
  onHidden() {}
  tick() {}
  dispose() {}
}

/** clamp helper */
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const rand = (a, b) => a + Math.random() * (b - a);
export const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
