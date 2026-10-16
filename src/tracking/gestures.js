// Pure, framework-free gesture logic built on MediaPipe hand landmarks.
// MediaPipe itself only supplies the 21 landmarks; everything here is ours.

export const LM = {
  WRIST: 0,
  THUMB_CMC: 1, THUMB_MCP: 2, THUMB_IP: 3, THUMB_TIP: 4,
  INDEX_MCP: 5, INDEX_PIP: 6, INDEX_DIP: 7, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_DIP: 11, MIDDLE_TIP: 12,
  RING_MCP: 13, RING_PIP: 14, RING_DIP: 15, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_DIP: 19, PINKY_TIP: 20,
};

const FINGERS = [
  [LM.INDEX_MCP, LM.INDEX_PIP, LM.INDEX_TIP],
  [LM.MIDDLE_MCP, LM.MIDDLE_PIP, LM.MIDDLE_TIP],
  [LM.RING_MCP, LM.RING_PIP, LM.RING_TIP],
  [LM.PINKY_MCP, LM.PINKY_PIP, LM.PINKY_TIP],
];

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));

/**
 * Curl of one finger in [0..1] (0 = straight, 1 = fully folded).
 * Two rotation-invariant cues are averaged:
 *  - tip-to-wrist distance relative to knuckle-to-wrist distance
 *  - angle between the proximal and distal finger segments
 */
export function fingerCurl(lm, [mcp, pip, tip]) {
  const wrist = lm[LM.WRIST];
  const ratio = dist(lm[tip], wrist) / Math.max(1e-6, dist(lm[mcp], wrist));
  const curlRatio = clamp01((1.7 - ratio) / (1.7 - 1.05));

  const ax = lm[pip].x - lm[mcp].x, ay = lm[pip].y - lm[mcp].y, az = (lm[pip].z || 0) - (lm[mcp].z || 0);
  const bx = lm[tip].x - lm[pip].x, by = lm[tip].y - lm[pip].y, bz = (lm[tip].z || 0) - (lm[pip].z || 0);
  const cos = (ax * bx + ay * by + az * bz) / Math.max(1e-9, Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz));
  const curlAngle = clamp01((0.9 - cos) / (0.9 + 0.2));

  return (curlRatio + curlAngle) * 0.5;
}

/** Thumb tucked across the palm → 1, thumb stretched away → 0. */
export function thumbCurl(lm) {
  const palmWidth = Math.max(1e-6, dist(lm[LM.INDEX_MCP], lm[LM.PINKY_MCP]));
  const d = dist(lm[LM.THUMB_TIP], lm[LM.PINKY_MCP]) / palmWidth;
  return clamp01((1.55 - d) / (1.55 - 0.85));
}

/**
 * Analyse the pose of a hand from 21 landmarks (world or normalised; both
 * work because only ratios are used).
 * @returns {{fist:number, open:number, curls:number[]}}
 */
export function analyzeGesture(lm) {
  const curls = FINGERS.map((f) => fingerCurl(lm, f));
  const thumb = thumbCurl(lm);
  const four = curls.reduce((a, b) => a + b, 0);
  const fist = (four + thumb * 0.5) / 4.5;
  const maxCurl = Math.max(...curls);
  // open palm: every finger nearly straight
  const open = clamp01(1 - maxCurl * 2.2);
  return { fist, open, curls: [...curls, thumb] };
}

/**
 * Debounced open/closed detector with hysteresis, short tracking-loss
 * tolerance and a re-trigger cooldown. Time is injected for testability.
 */
export class FistDetector {
  constructor(opts = {}) {
    this.cfg = {
      enter: 0.72,       // smoothed score needed to count as closed
      exit: 0.5,         // smoothed score below which the fist is "opening"
      enterMs: 90,       // how long score must stay above `enter`
      graceMs: 450,      // how long it must stay below `exit` before 'open' fires
      lostHoldMs: 160,   // tracking dropouts shorter than this keep the last score
      lostOpenMs: 900,   // no hand for this long counts as an open hand
      cooldownMs: 500,   // minimum time between two 'close' events
      smoothMs: 55,      // EMA time constant
      ...opts,
    };
    this.reset();
  }

  reset() {
    this.closed = false;
    this.score = 0;
    this._raw = 0;
    this._aboveSince = null;
    this._belowSince = null;
    this._lostSince = null;
    this._lastClose = -1e9;
    this._lastT = null;
  }

  /**
   * @param {number|null} rawScore fist score or null when no hand
   * @param {number} nowMs
   * @returns {'close'|'open'|null} event fired by this update
   */
  update(rawScore, nowMs) {
    const c = this.cfg;
    const dt = this._lastT == null ? 16 : Math.max(0, nowMs - this._lastT);
    this._lastT = nowMs;

    let event = null;
    let hasHand = rawScore != null;
    if (hasHand) {
      this._lostSince = null;
      this._raw = rawScore;
    } else {
      if (this._lostSince == null) this._lostSince = nowMs;
      const lostFor = nowMs - this._lostSince;
      if (lostFor > c.lostHoldMs) hasHand = false;
      else hasHand = true; // keep last raw value through brief dropouts
      if (lostFor > c.lostOpenMs) this._raw = 0;
    }

    const a = 1 - Math.exp(-dt / c.smoothMs);
    this.score += (this._raw - this.score) * a;

    if (!this.closed) {
      if (this.score >= c.enter && this._lostSince == null) {
        if (this._aboveSince == null) this._aboveSince = nowMs;
        if (nowMs - this._aboveSince >= c.enterMs && nowMs - this._lastClose >= c.cooldownMs) {
          this.closed = true;
          this._lastClose = nowMs;
          this._aboveSince = null;
          this._belowSince = null;
          event = 'close';
        }
      } else {
        this._aboveSince = null;
      }
    } else {
      const lowered = this.score < c.exit || (this._lostSince != null && nowMs - this._lostSince > c.lostOpenMs);
      if (lowered) {
        if (this._belowSince == null) this._belowSince = nowMs;
        if (nowMs - this._belowSince >= c.graceMs) {
          this.closed = false;
          this._belowSince = null;
          event = 'open';
        }
      } else {
        this._belowSince = null;
      }
    }
    return event;
  }

  /** 0..1 progress of the open-grace timer, for UI feedback. */
  get graceProgress() {
    if (!this.closed || this._belowSince == null || this._lastT == null) return 0;
    return clamp01((this._lastT - this._belowSince) / this.cfg.graceMs);
  }
}

/** Fires once when the open-palm score stays high for `holdMs`. */
export class HoldDetector {
  constructor(threshold = 0.8, holdMs = 700) {
    this.threshold = threshold;
    this.holdMs = holdMs;
    this._since = null;
    this._fired = false;
  }
  reset() { this._since = null; this._fired = false; }
  update(value, nowMs) {
    if (value != null && value >= this.threshold) {
      if (this._since == null) this._since = nowMs;
      if (!this._fired && nowMs - this._since >= this.holdMs) {
        this._fired = true;
        return true;
      }
    } else {
      this._since = null;
      this._fired = false;
    }
    return false;
  }
}
