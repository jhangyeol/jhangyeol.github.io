// Run with: node bin/test-mlp.cjs
// Exercises the exact numerical core embedded in the standalone page.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const html = fs.readFileSync(path.join(__dirname, "../mlp.html"), "utf8");
const script = html.match(/<script id="mlp-core">([\s\S]*?)<\/script>/)[1];
const core = vm.runInNewContext(script + "\nMLPCore;");
let checked = 0;

for (const kind of ["clusters", "circles", "spiral", "hopf", "moons", "xor", "swiss", "scurve"]) {
  for (const d of ["hopf", "swiss", "scurve"].includes(kind) ? [3] : [2, 3]) {
    const data = core.dataset(kind, d, 240, 0.08, 42);
    assert.equal(JSON.stringify(data), JSON.stringify(core.dataset(kind, d, 240, 0.08, 42)), "Seed reproducibility");
    assert.equal(data.train.length, 192);
    assert.equal(data.validation.length, 48);
    assert.equal(new Set([...data.train, ...data.validation].map((p) => p.id)).size, 240);
    for (let j = 0; j < d; j++) {
      const mean = data.train.reduce((s, p) => s + p.x[j], 0) / data.train.length;
      const variance = data.train.reduce((s, p) => s + p.x[j] ** 2, 0) / data.train.length;
      assert.ok(Math.abs(mean) < 1e-10);
      assert.ok(Math.abs(variance - 1) < 1e-10);
    }
    for (const h of [d - 1, d, d + 1]) {
      for (const objective of ["reconstruction", "classification"]) {
        const model = new core.Model(d, h, data.k, objective, "tanh", 123);
        const initial = model.evaluate(data.train).loss;
        const random = core.rng(99);
        for (let i = 0; i < 300; i++) {
          const batch = Array.from({ length: 32 }, () => data.train[Math.floor(random() * data.train.length)]);
          model.trainStep(batch, 0.01);
        }
        const final = model.evaluate(data.train).loss;
        assert.ok(Number.isFinite(final) && final < initial, `${kind} ${d}/${h} ${objective}: ${initial} → ${final}`);
        assert.ok(Number.isFinite(model.evaluate(data.validation).loss));
        const snapshot = model.snapshot(data);
        assert.equal(snapshot.latents.length, 240);
        assert.equal(snapshot.latents[0].length, h);
        const previousWeight = snapshot.weights[0][0];
        model.trainStep(data.train.slice(0, 32), 0.01);
        assert.equal(snapshot.weights[0][0], previousWeight, "Snapshots must not mutate");
        checked++;
      }
      const a = new core.Model(d, h, data.k, "reconstruction", "tanh", 123);
      const b = new core.Model(d, h, data.k, "classification", "tanh", 123);
      assert.deepEqual(Array.from(a.w1), Array.from(b.w1), "Paired encoders share initialization");
    }
  }
}

// Finite differences catch incorrect MSE averaging, softmax derivatives, and indexing.
for (const activation of ["tanh", "relu", "gelu", "leaky", "sigmoid", "linear"]) {
  for (const objective of ["reconstruction", "classification"]) {
    const data = core.dataset("clusters", 3, 60, 0.08, 17);
    const model = new core.Model(3, 4, 3, objective, activation, 19);
    const batch = data.train.slice(0, 5);
    const gradients = model.gradients(batch);
    const eps = 1e-5;
    model.params.forEach((parameter, layer) => {
      for (let i = 0; i < parameter.length; i++) {
        const original = parameter[i];
        parameter[i] = original + eps;
        const plus = model.evaluate(batch).loss;
        parameter[i] = original - eps;
        const minus = model.evaluate(batch).loss;
        parameter[i] = original;
        const numerical = (plus - minus) / (2 * eps);
        assert.ok(Math.abs(numerical - gradients[layer][i]) < 2e-6, `${activation}/${objective}, parameter ${layer}:${i}`);
      }
    });
  }
}

// GELU must train successfully under both objectives at all three widths.
for (const objective of ["reconstruction", "classification"]) {
  for (const width of [0, 1, 2]) {
    const experiment = new core.Experiment(objective, width, { activation: "gelu", d: 3, n: 240 });
    const before = experiment.model.evaluate(experiment.data.train).loss;
    for (let i = 0; i < 300; i++) experiment.trainOne();
    const after = experiment.model.evaluate(experiment.data.train).loss;
    assert.ok(Number.isFinite(after) && after < before, `GELU ${objective}, width ${width}: ${before} → ${after}`);
    assert.ok(Number.isFinite(experiment.model.evaluate(experiment.data.validation).loss));
  }
}

const link = core.dataset("hopf", 2, 120, 0, 9);
assert.equal(link.d, 3, "Hopf link always has three input coordinates");
link.points.forEach((p) => {
  const [x, y, z] = p.raw;
  if (p.label === 0) {
    assert.ok(Math.abs(x * x + y * y - 1) < 1e-12);
    assert.equal(z, 0);
  } else {
    assert.ok(Math.abs((x - 1) ** 2 + z * z - 1) < 1e-12);
    assert.equal(y, 0);
  }
});
const zeroNoise = core.dataset("clusters", 3, 60, 0, 42);
const unstable = new core.Model(3, 2, 3, "classification", "linear", 1);
unstable.b2.set([1000, -1000, 0]);
assert.ok(Number.isFinite(unstable.evaluate(zeroNoise.train).loss), "Stable log-sum-exp");
assert.ok(Math.abs(unstable.forward(zeroNoise.train[0].x).y.reduce((a, b) => a + b, 0) - 1) < 1e-12);
// Independent experiments own their data, optimizer, random stream, and replay cursor.
const experiments = ["reconstruction", "classification"].flatMap((objective) => [0, 1, 2].map((width) => new core.Experiment(objective, width)));
assert.deepEqual(
  experiments.map((e) => e.model.h),
  [1, 2, 3, 1, 2, 3]
);
const untouched = experiments.slice(1).map((e) => JSON.stringify(e.history));
const first = experiments[0];
first.start();
for (let i = 0; i < 25; i++) first.trainOne();
first.pause();
assert.equal(first.step, 25);
assert.equal(first.history.at(-1).step, 25);
assert.deepEqual(
  experiments.slice(1).map((e) => JSON.stringify(e.history)),
  untouched
);
assert.ok(experiments.slice(1).every((e) => e.step === 0 && !e.running));
const learned = JSON.stringify(first.model.params.map((p) => Array.from(p)));
first.seek(0);
first.startReplay();
while (first.replaying) first.replayTick();
assert.equal(first.shown, first.history.length - 1);
assert.equal(JSON.stringify(first.model.params.map((p) => Array.from(p))), learned, "Replay must not change learned weights");
experiments[1].start();
first.seek(0);
assert.equal(experiments[1].running, true, "Seeking one panel does not pause another");
first.start();
first.trainOne();
assert.equal(first.step, 26, "Resume trains from latest weights, not the replay cursor");
first.reset({ ...first.config, kind: "hopf" });
assert.equal(first.data.d, 3);
assert.equal(first.model.h, 2);
assert.equal(first.step, 0);
assert.equal(first.history.length, 1);
assert.equal(experiments[1].running, true, "Reset is panel-local");
experiments[2].reset({ ...experiments[2].config, d: 3 });
assert.equal(experiments[2].model.h, 4, "Expanded width is d+1");
const replica = new core.Experiment("reconstruction", 0);
experiments[0].reset({ ...replica.config });
for (let i = 0; i < 30; i++) {
  replica.trainOne();
  experiments[0].trainOne();
}
assert.equal(JSON.stringify(replica.history), JSON.stringify(experiments[0].history), "Training is reproducible per panel");
const completed = new core.Experiment("classification", 2, { n: 240 });
completed.start();
while (completed.running) completed.trainOne();
assert.equal(completed.step, core.MAX_STEPS);
assert.equal(completed.history.length, core.MAX_STEPS / 10 + 1);
completed.seek(0);
completed.startReplay();
while (completed.replaying) completed.replayTick();
completed.start();
assert.equal(completed.running, false, "A completed panel cannot train past its step limit");
assert.equal(completed.history[completed.shown].step, core.MAX_STEPS);

console.log("PASS: independent panel state, d+1 widths, training isolation, replay, resume, reset, seeded reproducibility.");
console.log(
  `PASS: ${checked} dataset/dimension/width/objective cases; finite-difference gradients for all activations and objectives; splits, scaling, seeds, snapshots, Hopf geometry, stable softmax.`
);

// Both optimizers implement the intended updates from exactly the same gradient.
const optData = core.dataset("clusters", 2, 60, 0.08, 42);
for (const optimizer of ["sgd", "adam"]) {
  const model = new core.Model(2, 3, 3, "classification", "tanh", 42);
  const batch = optData.train.slice(0, 16),
    gradients = model.gradients(batch);
  const before = model.params.map((p) => Array.from(p));
  model.trainStep(batch, 0.01, optimizer);
  model.params.forEach((p, layer) =>
    p.forEach((value, i) => {
      const g = gradients[layer][i];
      const expected = before[layer][i] - 0.01 * (optimizer === "sgd" ? g : g / (Math.abs(g) + 1e-8));
      assert.ok(Math.abs(value - expected) < 1e-12, `${optimizer} update`);
    })
  );
  for (const objective of ["classification", "reconstruction"]) {
    const e = new core.Experiment(objective, 2, { optimizer, n: 240, lr: 0.03 });
    const initial = e.model.evaluate(e.data.train).loss;
    for (let i = 0; i < 400; i++) e.trainOne();
    assert.ok(e.model.evaluate(e.data.train).loss < initial, `${optimizer}/${objective} learning`);
  }
}
const configurable = new core.Experiment("reconstruction", 1);
configurable.reset({ ...configurable.config, h: 12, objective: "classification", optimizer: "sgd" });
assert.equal(configurable.model.h, 12);
assert.equal(configurable.model.o, 3);
assert.equal(configurable.objective, "classification");
assert.equal(configurable.config.optimizer, "sgd");
configurable.reset({ ...configurable.config, h: 0 });
assert.equal(configurable.model.h, 1);
configurable.reset({ ...configurable.config, kind: "swiss", d: 2, widthIndex: 2, h: null });
assert.equal(configurable.model.d, 3);
assert.equal(configurable.model.h, 4);

// The slice center must equal the actual loss; evaluating it must not mutate live weights or Adam state.
for (const objective of ["reconstruction", "classification"]) {
  const e = new core.Experiment(objective, 2, { kind: "moons", n: 240 });
  for (let i = 0; i < 20; i++) e.trainOne();
  const m = e.model,
    refs = core.parameterRefs(m),
    axisA = 0,
    axisB = refs.findIndex((r) => r.group === 2),
    a = refs[axisA],
    b = refs[axisB];
  const x = m.params[a.group][a.index],
    y = m.params[b.group][b.index],
    weights = m.params.map((p) => Array.from(p));
  const before = JSON.stringify({ weights, m: m.m, v: m.v, t: m.t });
  const points = e.data.train.slice(0, 24);
  const spec = {
    model: { d: m.d, h: m.h, k: m.k, objective: m.objective, activation: m.activation, weights },
    points,
    axisA,
    axisB,
    bounds: [x - 1, x + 1, y - 1, y + 1],
    resolution: 5,
  };
  const grid = core.sliceGrid(spec),
    expected = m.evaluate(points).loss;
  assert.ok(Math.abs(grid.currentLoss - expected) < 1e-12);
  assert.ok(Math.abs(grid.values[12] - expected) < 1e-12);
  assert.ok(grid.max > grid.min);
  assert.equal(JSON.stringify({ weights: m.params.map((p) => Array.from(p)), m: m.m, v: m.v, t: m.t }), before);
  assert.throws(() => core.sliceGrid({ ...spec, axisB: axisA }));
}
const contours = core.contourSegments([0, 1, 2, 1, 2, 3, 2, 3, 4], 3, 1.5);
assert.ok(contours.length > 0);
for (const segment of contours) for (const [x, y] of segment) assert.ok(Math.abs(x + y - 1.5) < 1e-12, "Interpolated contour of x+y");
assert.equal(core.contourSegments([0, 0, 0, 0], 2, 1).length, 0);
assert.equal(core.contourSegments([0, 1, 1, 0], 2, 0.4).length, 2, "Saddle contour");
console.log(
  "PASS: SGD/Adam exact updates and training, configurable objective and 1–12 neurons, 3D datasets, loss slice correctness and immutability, interpolated contours."
);
