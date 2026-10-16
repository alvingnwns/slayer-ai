// Maps a hand sample (screen position + orientation estimate) onto the katana.
// The result is a *visually convincing approximation*: a monocular webcam gives
// a reliable 2D position and in-plane angle, only a rough depth/tilt.
import * as THREE from 'three';
import { OneEuro } from '../tracking/filters.js';

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

export class SwordRig {
  constructor(stage, katana) {
    this.stage = stage;
    this.katana = katana;
    this.root = new THREE.Group();
    this.root.add(katana.group);

    this.pos = [new OneEuro(1.3, 1.6), new OneEuro(1.3, 1.6), new OneEuro(0.8, 0.8)];
    this.vec = Array.from({ length: 6 }, () => new OneEuro(1.6, 1.2));
    this.target = new THREE.Vector3();
    this.smoothPos = new THREE.Vector3();
    this.dir = new THREE.Vector3(0, 1, 0);
    this.normal = new THREE.Vector3(0, 0, 1);
    this.angle = 0;          // current in-plane blade angle (rad, 0 = up), for calibration
    this.speed = 0;          // screen-heights per second
    this.lostFor = 0;
    this.confidence = 1;     // dims the sword when tracking is lost
    this._prev = new THREE.Vector3();
    this._have = false;
    this._prevValid = false;
    this._bob = 0;
  }

  /**
   * @param {number} dt
   * @param {object|null} s hand sample {present, ndcX, ndcY, size, up, across, normal}
   * @param {object} cfg calibration settings
   */
  update(dt, s, cfg, realDt = dt) {
    const present = !!(s && s.present);
    if (present) {
      // hand re-acquired somewhere else: jump instead of gliding (and don't count it as a swing)
      if (this.lostFor > 0.3) this.reset();
      this.lostFor = 0;
      const depth = cfg.depth ? THREE.MathUtils.clamp((s.size - 0.16) * 5, -0.5, 0.9) : 0;
      this.stage.ndcToWorld(s.ndcX, s.ndcY, depth, this.target);

      // blade axis: along the forearm (default) or across the knuckles (real grip line)
      let d = cfg.grip === 'knuckles' ? s.across : s.up;
      let dx = d[0], dy = d[1], dz = d[2];
      if (cfg.grip === 'knuckles' && dy < 0) { dx = -dx; dy = -dy; dz = -dz; }
      const nx = s.normal[0], ny = s.normal[1], nz = s.normal[2];

      // roll calibration, rotating about the viewing axis
      const c = Math.cos(cfg.roll), sn = Math.sin(cfg.roll);
      const rdx = dx * c - dy * sn, rdy = dx * sn + dy * c;
      const rnx = nx * c - ny * sn, rny = nx * sn + ny * c;

      const f = this.vec;
      if (!this._have) f.forEach((o) => o.reset());
      this.dir.set(f[0].filter(rdx, dt), f[1].filter(rdy, dt), f[2].filter(dz, dt)).normalize();
      this.normal.set(f[3].filter(rnx, dt), f[4].filter(rny, dt), f[5].filter(nz, dt)).normalize();

      this.smoothPos.set(
        this.pos[0].filter(this.target.x, dt),
        this.pos[1].filter(this.target.y, dt),
        this.pos[2].filter(this.target.z, dt),
      );
      this._have = true;
    } else {
      this.lostFor += dt;
    }
    this.confidence += ((this.lostFor > 0.35 ? 0.45 : 1) - this.confidence) * Math.min(1, dt * 5);

    // orientation basis: Y = blade, Z = palm normal projected ⟂ Y
    _y.copy(this.dir);
    _z.copy(this.normal).addScaledVector(_y, -this.normal.dot(_y));
    if (_z.lengthSq() < 1e-4) _z.set(0, 0, 1);
    _z.normalize();
    _x.crossVectors(_y, _z).normalize();
    _m.makeBasis(_x, _y, _z);
    this.root.quaternion.setFromRotationMatrix(_m);
    this.angle = Math.atan2(this.dir.x, this.dir.y);

    this._bob += dt;
    const bob = Math.sin(this._bob * 1.7) * 0.012;
    this.root.position.set(
      this.smoothPos.x + cfg.offX + this.dir.x * cfg.gripShift,
      this.smoothPos.y + cfg.offY + this.dir.y * cfg.gripShift + bob,
      this.smoothPos.z,
    );
    this.root.scale.setScalar(cfg.scale);

    // hand speed in screen-heights/s (smoothed)
    const rd = Math.max(realDt, 1 / 240);
    if (this._have && this._prevValid) {
      const v = this._prev.distanceTo(this.smoothPos) / rd / this.stage.viewHeightWorld;
      this.speed += (v - this.speed) * (1 - Math.exp(-rd / 0.06));
    }
    this._prev.copy(this.smoothPos);
    this._prevValid = this._have;
  }

  reset() {
    this._have = false;
    this._prevValid = false;
    this.speed = 0;
    this.lostFor = 0;
    this.pos.forEach((o) => o.reset());
  }
}
