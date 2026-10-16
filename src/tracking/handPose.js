// Converts MediaPipe landmarks into a compact, renderer-agnostic hand sample.
// Output vectors are already in "scene space": x right (mirrored selfie view),
// y up, z toward the viewer. Depth is only an estimate (monocular).
import { LM, analyzeGesture } from './gestures.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/**
 * @param {{x:number,y:number,z:number}[]} lm normalised image landmarks
 * @param {{x:number,y:number,z:number}[]|null} world metric world landmarks
 * @param {number} aspect video width / height
 */
export function analyzeHand(lm, world, aspect) {
  // --- screen position of the palm centre (normalised, un-mirrored)
  const ids = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  let px = 0, py = 0;
  for (const i of ids) { px += lm[i].x; py += lm[i].y; }
  px /= ids.length; py /= ids.length;

  // palm size in "video heights" – a rough proxy for distance to camera
  const size = Math.hypot((lm[LM.MIDDLE_MCP].x - lm[LM.WRIST].x) * aspect, lm[LM.MIDDLE_MCP].y - lm[LM.WRIST].y);

  // --- orientation. World landmarks are metric & consistent, so prefer them.
  // Convert image axes (x right, y down, z away) to scene axes, mirrored in x.
  const P = (i) => {
    if (world) return [-world[i].x, -world[i].y, -world[i].z];
    return [-(lm[i].x * aspect), -lm[i].y, -(lm[i].z || 0) * aspect];
  };
  // forearm-ish axis: wrist -> middle knuckle. The depth component is noisy
  // so it is damped.
  const up = sub(P(LM.MIDDLE_MCP), P(LM.WRIST));
  up[2] *= 0.45;
  const across = sub(P(LM.INDEX_MCP), P(LM.PINKY_MCP));
  across[2] *= 0.45;
  let normal = norm(cross(sub(P(LM.INDEX_MCP), P(LM.WRIST)), sub(P(LM.PINKY_MCP), P(LM.WRIST))));
  if (normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]]; // always face the viewer

  const g = analyzeGesture(world || lm);

  return {
    present: true,
    nx: px,
    ny: py,
    size,
    up: norm(up),
    across: norm(across),
    normal,
    fist: g.fist,
    open: g.open,
    curls: g.curls,
  };
}
