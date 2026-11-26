// 1-euro filter for real-time low-latency filtering of noisy pose landmark signals.
// Casiez et al., CHI 2012: "1 € Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"
// adapts cutoff frequency based on movement speed: heavy smoothing when static to eliminate jitter,
// and high cutoff when moving to prevent lag.

class LowPassFilter {
  private y: number | null = null;
  private s: number | null = null;

  // filters value using exponential smoothing with smoothing factor alpha
  filter(value: number, alpha: number): number {
    if (this.y === null) {
      this.s = value;
      this.y = value;
      return value;
    }
    this.y = value;
    this.s = alpha * value + (1 - alpha) * (this.s as number);
    return this.s;
  }

  // checks if a filtered state already exists
  hasLast(): boolean {
    return this.y !== null;
  }

  // returns the most recent raw sample
  last(): number {
    return this.y ?? 0;
  }

  // clears stored filter state
  reset(): void {
    this.y = null;
    this.s = null;
  }
}

export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;
  private xFilter: LowPassFilter;
  private dxFilter: LowPassFilter;
  private lastTime: number | null = null;

  constructor(minCutoff = 0.5, beta = 0.02, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.xFilter = new LowPassFilter();
    this.dxFilter = new LowPassFilter();
  }

  // calculates smoothing factor alpha from cutoff frequency and delta time
  private alpha(cutoff: number, dt: number): number {
    const tau = 1.0 / (2 * Math.PI * cutoff);
    return 1.0 / (1.0 + tau / dt);
  }

  // filters coordinate value based on its estimated speed of change
  filter(value: number, timestamp = performance.now()): number {
    if (this.lastTime === null) {
      this.lastTime = timestamp;
      return this.xFilter.filter(value, 1.0);
    }

    const dt = Math.max((timestamp - this.lastTime) / 1000.0, 1e-4);
    this.lastTime = timestamp;

    const dx = this.xFilter.hasLast()
      ? (value - this.xFilter.last()) / dt
      : 0;
    const edx = this.dxFilter.filter(dx, this.alpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(value, this.alpha(cutoff, dt));
  }

  // resets temporal state
  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTime = null;
  }
}

export interface FilterableLandmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

export class PoseLandmarkFilter {
  private filters: { x: OneEuroFilter; y: OneEuroFilter; z: OneEuroFilter }[] = [];

  constructor(count = 33, minCutoff = 0.5, beta = 0.02) {
    for (let i = 0; i < count; i++) {
      this.filters.push({
        x: new OneEuroFilter(minCutoff, beta),
        y: new OneEuroFilter(minCutoff, beta),
        z: new OneEuroFilter(minCutoff, beta),
      });
    }
  }

  // filters landmarks continuously to eliminate micro-jitter while preserving fast movement responsiveness
  filter<T extends FilterableLandmark>(landmarks: T[], timestamp = performance.now()): T[] {
    return landmarks.map((lm, i) => {
      if (i >= this.filters.length) return lm;
      if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return lm;

      const filteredX = this.filters[i].x.filter(lm.x, timestamp);
      const filteredY = this.filters[i].y.filter(lm.y, timestamp);
      const filteredZ = Number.isFinite(lm.z)
        ? this.filters[i].z.filter(lm.z, timestamp)
        : lm.z;

      return {
        ...lm,
        x: filteredX,
        y: filteredY,
        z: filteredZ,
      } as T;
    });
  }

  // clears filter temporal memory across all landmarks
  reset(): void {
    for (const f of this.filters) {
      f.x.reset();
      f.y.reset();
      f.z.reset();
    }
  }
}
