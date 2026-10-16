// Sword life-cycle state machine. Framework-free so it can be unit tested.
//
//  hidden → summoning → ready ⇄ charging → attack → recover → ready
//                          ↘ dismissing → hidden
//
// Visual layers read: manifest (0..1), charge (0..1), attackT (0..1), strength.

export class SwordController {
  constructor(opts = {}) {
    this.cfg = {
      summonSec: 0.85,
      dismissSec: 0.55,
      chargeSec: 1.1,          // stationary time to reach full charge
      stillSpeed: 0.28,        // screen-heights/s below which the hand counts as still
      swingSpeed: 1.7,         // screen-heights/s above which a swing triggers an attack
      attackCooldownSec: 0.35, // after recover finishes
      attackSec: 0.6,
      recoverSec: 0.7,
      autoCharge: true,
      ...opts,
    };
    this.onEvent = null;
    this.reset();
  }

  reset() {
    this.state = 'hidden';
    this.manifest = 0;
    this.charge = 0;
    this.attackT = 0;
    this.recoverT = 0;
    this.strength = 0;
    this.holdCharge = false;
    this._cool = 0;
  }

  _emit(name, data) { if (this.onEvent) this.onEvent(name, data); }

  get visible() { return this.state !== 'hidden'; }
  get armed() { return this.state === 'ready' || this.state === 'charging'; }
  get attacking() { return this.state === 'attack'; }

  summon() {
    if (this.state === 'hidden' || this.state === 'dismissing') {
      if (this.state === 'hidden') this.manifest = 0;
      this.state = 'summoning';
      this.charge = 0;
      this._emit('summon');
      return true;
    }
    return false;
  }

  dismiss() {
    if (this.state === 'hidden' || this.state === 'dismissing') return false;
    this.state = 'dismissing';
    this.charge = 0;
    this._emit('dismiss');
    return true;
  }

  /** @param {number} [power] 0..1 strength override */
  attack(power) {
    if (!this.armed) return false;
    if (this._cool > 0) return false;
    this.strength = power != null ? power : 0.55 + 0.45 * this.charge;
    this.state = 'attack';
    this.attackT = 0;
    this._emit('attack', { strength: this.strength, charge: this.charge });
    this.charge = 0;
    return true;
  }

  setTimings({ attack, recover }) {
    if (attack) this.cfg.attackSec = attack;
    if (recover) this.cfg.recoverSec = recover;
  }

  /**
   * @param {number} dt seconds
   * @param {{speed:number, handPresent:boolean}} input speed in screen-heights/s
   */
  update(dt, input = { speed: 0, handPresent: true }) {
    const c = this.cfg;
    if (this._cool > 0) this._cool -= dt;
    switch (this.state) {
      case 'summoning':
        this.manifest = Math.min(1, this.manifest + dt / c.summonSec);
        if (this.manifest >= 1) { this.state = 'ready'; this._emit('ready'); }
        break;
      case 'dismissing':
        this.manifest = Math.max(0, this.manifest - dt / c.dismissSec);
        if (this.manifest <= 0) { this.state = 'hidden'; this._emit('hidden'); }
        break;
      case 'ready':
      case 'charging': {
        const still = input.handPresent && input.speed < c.stillSpeed;
        const charging = this.holdCharge || (c.autoCharge && still);
        if (charging) this.charge = Math.min(1, this.charge + dt / c.chargeSec);
        else this.charge = Math.max(0, this.charge - dt * 1.6);
        const next = this.charge > 0.04 ? 'charging' : 'ready';
        if (next !== this.state) {
          this.state = next;
          if (next === 'charging') this._emit('charge-start');
        }
        if (input.handPresent && input.speed > c.swingSpeed && this._cool <= 0) {
          // swing: attack, strength grows a little with swing speed
          const bonus = Math.min(0.2, (input.speed - c.swingSpeed) * 0.08);
          this.attack(Math.min(1, 0.55 + 0.45 * this.charge + bonus));
        }
        break;
      }
      case 'attack':
        this.attackT = Math.min(1, this.attackT + dt / c.attackSec);
        if (this.attackT >= 1) { this.state = 'recover'; this.recoverT = 0; this._emit('recover'); }
        break;
      case 'recover':
        this.recoverT = Math.min(1, this.recoverT + dt / c.recoverSec);
        if (this.recoverT >= 1) {
          this.state = 'ready';
          this._cool = c.attackCooldownSec;
          this._emit('ready');
        }
        break;
      default:
        break;
    }
  }
}
