// Runs a full stream through SGBT (with and without tree replacement) and records
// snapshots so the UI can play back / scrub through time.
// Evaluation is prequential: every instance is first predicted (test), then its
// label is revealed immediately and used for training (no label delay).
import { schedule, mulberry32 } from "./data.js";
import { SGBT } from "./sgbt.js";

const STATIONARY = { changes: [], windows: [], phase: () => 0, display: () => 0 };

export function runSimulation(cfg, sc, real) {
  const { task, period, noise, every, seed, params } = cfg;
  const d = sc.dim;
  let T;
  let xs;
  let ys;
  let sch;
  if (sc.real) {
    T = Math.min(cfg.T, real.n);
    xs = real.X.subarray(0, T * d);
    ys = real.y.subarray(0, T);
    sch = STATIONARY;
  } else {
    T = cfg.T;
    sch = schedule(sc.fixedDrift || cfg.drift, T, period);
    const rng = mulberry32(seed);
    xs = new Float32Array(T * d);
    ys = new Float32Array(T);
    for (let t = 0; t < T; t++) {
      const s = sc.sample(rng, sch.phase(t, rng), noise);
      for (let f = 0; f < d; f++) xs[t * d + f] = s.x[f];
      ys[t] = s.y;
    }
  }

  const model = new SGBT(task, { ...params, d });
  const base = new SGBT(task, { ...params, d, replace: false });
  const W = 200;
  const lossA = new Float32Array(T);
  const lossB = new Float32Array(T);
  let sumA = 0;
  let sumB = 0;
  let cumA = 0;
  let cumB = 0;
  const events = [];
  const frames = [];
  const metric = (pred, y) => (task === "cls" ? ((pred > 0.5 ? 1 : 0) === y ? 1 : 0) : (pred - y) ** 2);
  const agg = (sum, n) => (task === "cls" ? sum / n : Math.sqrt(sum / n));

  const record = (t) => {
    const n = Math.min(t, W) || 1;
    frames.push({
      t,
      ...model.snapshot(),
      metric: t ? agg(sumA, n) : null,
      baseMetric: t ? agg(sumB, n) : null,
      cumMetric: t ? agg(cumA, t) : null,
      cumBase: t ? agg(cumB, t) : null,
    });
  };
  record(0);
  const x = new Array(d);
  for (let t = 0; t < T; t++) {
    for (let f = 0; f < d; f++) x[f] = xs[t * d + f];
    const y = ys[t];
    // test ...
    lossA[t] = metric(model.predict(x), y);
    lossB[t] = metric(base.predict(x), y);
    sumA += lossA[t];
    sumB += lossB[t];
    cumA += lossA[t];
    cumB += lossB[t];
    if (t >= W) {
      sumA -= lossA[t - W];
      sumB -= lossB[t - W];
    }
    // ... then train on the same instance
    for (const e of model.learn(x, y)) events.push(e);
    base.learn(x, y);
    if ((t + 1) % every === 0 || t === T - 1) record(t + 1);
  }
  const summary = { model: agg(cumA, T), base: agg(cumB, T), swaps: events.filter((e) => e.type === "swap").length };
  return { cfg: { ...cfg, T }, sc, sch, d, xs, ys, frames, events, summary };
}
