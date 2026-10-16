// One-Euro filter (Casiez et al. 2012): low jitter when slow, low lag when fast.
const alpha = (cutoff, dt) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

export class OneEuro {
  constructor(minCutoff = 1.2, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }
  reset() { this.x = null; this.dx = 0; }
  filter(v, dt) {
    if (this.x == null || dt <= 0) { this.x = v; this.dx = 0; return v; }
    const rawD = (v - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawD - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (v - this.x);
    return this.x;
  }
}
