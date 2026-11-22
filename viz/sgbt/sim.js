// Runs a full stream through SGBT (with and without tree replacement) and records
// snapshots so the UI can play back / scrub through time.
import { SCENARIOS, schedule, mulberry32 } from "./data.js";
import { SGBT } from "./sgbt.js";

export function runSimulation(cfg) {
  const { task, scenario, drift, T, period, noise, every, seed, params } = cfg;
  const sc = SCENARIOS[task].find((s) => s.id === scenario);
  const sch = schedule(drift, T, period);
  const rng = mulberry32(seed);
  const xs = new Float32Array(T * 2);
  const ys = new Float32Array(T);
  const phases = new Float32Array(T);
  for (let t = 0; t < T; t++) {
    const ph = sch.phase(t, rng);
    const s = sc.sample(rng, ph, noise);
    xs[2 * t] = s.x[0];
    xs[2 * t + 1] = s.x[1];
    ys[t] = s.y;
    phases[t] = ph;
  }

  const model = new SGBT(task, { ...params });
  const base = new SGBT(task, { ...params, replace: false });
  const W = 200;
  const lossA = new Float32Array(T);
  const lossB = new Float32Array(T);
  let sumA = 0;
  let sumB = 0;
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
    });
  };
  record(0);
  for (let t = 0; t < T; t++) {
    const x = [xs[2 * t], xs[2 * t + 1]];
    const y = ys[t];
    // prequential: test, then train
    lossA[t] = metric(model.predict(x), y);
    lossB[t] = metric(base.predict(x), y);
    sumA += lossA[t];
    sumB += lossB[t];
    if (t >= W) {
      sumA -= lossA[t - W];
      sumB -= lossB[t - W];
    }
    for (const e of model.learn(x, y)) events.push(e);
    base.learn(x, y);
    if ((t + 1) % every === 0) record(t + 1);
  }
  // overall prequential numbers
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const summary = {
    model: task === "cls" ? mean(lossA) : Math.sqrt(mean(lossA)),
    base: task === "cls" ? mean(lossB) : Math.sqrt(mean(lossB)),
    swaps: events.filter((e) => e.type === "swap").length,
  };
  return { cfg, sc, sch, xs, ys, phases, frames, events, summary };
}
