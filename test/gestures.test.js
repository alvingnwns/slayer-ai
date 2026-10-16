import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeGesture, FistDetector, HoldDetector, LM } from '../src/tracking/gestures.js';
import { SwordController } from '../src/sword/controller.js';

// Synthetic planar hand: wrist at the origin, fingers along +y when open.
// `curl` 0..1 folds every finger toward the palm (towards -y, then back).
function hand(curl) {
  const lm = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  const fingers = [
    [LM.INDEX_MCP, -0.03, 0.09, [0.04, 0.025, 0.02]],
    [LM.MIDDLE_MCP, -0.01, 0.095, [0.045, 0.028, 0.02]],
    [LM.RING_MCP, 0.01, 0.09, [0.04, 0.025, 0.02]],
    [LM.PINKY_MCP, 0.03, 0.08, [0.03, 0.02, 0.018]],
  ];
  for (const [mcpIdx, x, y, segs] of fingers) {
    let p = { x, y, z: 0 };
    lm[mcpIdx] = p;
    let ang = Math.PI / 2; // pointing +y
    segs.forEach((l, i) => {
      ang += curl * (Math.PI * 0.5); // each joint bends 90° when fully curled
      p = { x: p.x, y: p.y + Math.sin(ang) * l, z: p.z - Math.cos(ang) * l };
      lm[mcpIdx + 1 + i] = p;
    });
  }
  lm[LM.THUMB_CMC] = { x: -0.04, y: 0.02, z: 0 };
  lm[LM.THUMB_MCP] = { x: -0.06, y: 0.04, z: 0 };
  lm[LM.THUMB_IP] = { x: -0.075, y: 0.06, z: 0 };
  lm[LM.THUMB_TIP] = curl > 0.5 ? { x: 0.0, y: 0.07, z: 0.02 } : { x: -0.09, y: 0.08, z: 0 };
  return lm;
}

test('open hand scores low fist, closed hand scores high', () => {
  const open = analyzeGesture(hand(0));
  const closed = analyzeGesture(hand(1));
  assert.ok(open.fist < 0.35, `open fist=${open.fist}`);
  assert.ok(closed.fist > 0.75, `closed fist=${closed.fist}`);
  assert.ok(open.open > 0.7, `open palm=${open.open}`);
  assert.ok(closed.open < 0.2, `closed palm=${closed.open}`);
});

test('partially curled hand sits between the thresholds', () => {
  const half = analyzeGesture(hand(0.5)).fist;
  assert.ok(half > 0.25 && half < 0.85, `half=${half}`);
});

test('FistDetector needs sustained closure and honours the open grace', () => {
  const d = new FistDetector({ cooldownMs: 0 });
  let t = 0;
  const events = [];
  const step = (score, ms) => { for (let i = 0; i < ms; i += 16) { t += 16; const e = d.update(score, t); if (e) events.push([e, t]); } };
  step(0.1, 200);
  step(0.9, 40);        // too short: no event
  step(0.1, 100);
  assert.deepEqual(events, []);
  step(0.95, 300);
  assert.equal(events[0][0], 'close');
  step(0.2, 200);       // shorter than grace → still closed
  assert.equal(d.closed, true);
  step(0.9, 100);       // flicker back
  step(0.2, 700);
  assert.equal(events.at(-1)[0], 'open');
  assert.equal(d.closed, false);
});

test('brief tracking dropouts do not open the fist', () => {
  const d = new FistDetector({ cooldownMs: 0 });
  let t = 0;
  const events = [];
  const step = (score, ms) => { for (let i = 0; i < ms; i += 16) { t += 16; const e = d.update(score, t); if (e) events.push(e); } };
  step(0.95, 400);
  assert.deepEqual(events, ['close']);
  step(null, 120);      // lost for 120ms
  step(0.95, 300);
  assert.deepEqual(events, ['close']);
});

test('cooldown limits re-triggering', () => {
  const d = new FistDetector({ cooldownMs: 1500, graceMs: 100 });
  let t = 0; const ev = [];
  const step = (s, ms) => { for (let i = 0; i < ms; i += 16) { t += 16; const e = d.update(s, t); if (e) ev.push(e); } };
  step(0.95, 300); step(0.1, 400); step(0.95, 300);
  assert.deepEqual(ev, ['close', 'open']); // second close suppressed by cooldown
  step(0.95, 1500);
  assert.deepEqual(ev, ['close', 'open', 'close']);
});

test('HoldDetector fires once per hold', () => {
  const h = new HoldDetector(0.8, 300);
  let fired = 0, t = 0;
  for (let i = 0; i < 40; i++) { t += 16; if (h.update(0.9, t)) fired++; }
  assert.equal(fired, 1);
  t += 16; h.update(0.1, t);
  for (let i = 0; i < 40; i++) { t += 16; if (h.update(0.9, t)) fired++; }
  assert.equal(fired, 2);
});

test('SwordController life-cycle', () => {
  const c = new SwordController({ summonSec: 0.5, dismissSec: 0.25, attackSec: 0.3, recoverSec: 0.3, attackCooldownSec: 0 });
  const log = [];
  c.onEvent = (n) => log.push(n);
  assert.equal(c.state, 'hidden');
  assert.equal(c.attack(), false);
  c.summon();
  for (let i = 0; i < 40; i++) c.update(0.016, { speed: 1, handPresent: true });
  assert.equal(c.state, 'ready');
  c.update(0.016, { speed: 3, handPresent: true }); // swing
  assert.equal(c.state, 'attack');
  for (let i = 0; i < 60; i++) c.update(0.016, { speed: 1, handPresent: true });
  assert.equal(c.state, 'ready');
  for (let i = 0; i < 90; i++) c.update(0.016, { speed: 0, handPresent: true }); // hold still
  assert.ok(c.charge > 0.9, `charge=${c.charge}`);
  c.attack();
  assert.ok(c.strength > 0.95);
  for (let i = 0; i < 60; i++) c.update(0.016, { speed: 1, handPresent: true });
  c.dismiss();
  for (let i = 0; i < 40; i++) c.update(0.016, { speed: 0, handPresent: true });
  assert.equal(c.state, 'hidden');
  assert.ok(log.includes('summon') && log.includes('attack') && log.includes('hidden'));
});
