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
  "PASS: SGD/Adam exact updates and training, configurable objective and neuron counts, 3D datasets, loss slice correctness and immutability, interpolated contours."
);

// Backpropagation through three hidden layers, including the selected nonlinearity at every layer.
for (const activation of ["tanh", "relu", "gelu", "leaky", "sigmoid", "linear"]) {
  for (const objective of ["classification", "reconstruction"]) {
    const data = core.dataset("moons", 2, 60, 0.05, 9),
      model = new core.Model(2, 3, 2, objective, activation, 11, [3, 2]);
    // Offset biases to avoid testing the undefined derivative at a ReLU kink.
    model.params.forEach((p, group) => {
      if (group % 2)
        p.forEach((_, i) => {
          p[i] = 0.17 + i * 0.031;
        });
    });
    const batch = data.train.slice(0, 4),
      gradients = model.gradients(batch),
      eps = 1e-5;
    model.params.forEach((p, l) =>
      p.forEach((value, i) => {
        p[i] = value + eps;
        const plus = model.evaluate(batch).loss;
        p[i] = value - eps;
        const minus = model.evaluate(batch).loss;
        p[i] = value;
        assert.ok(Math.abs((plus - minus) / (2 * eps) - gradients[l][i]) < 3e-6, `deep ${activation}/${objective} ${l}:${i}`);
      })
    );
    assert.deepEqual(Array.from(model.hiddenSizes), [3, 3, 2]);
    assert.equal(model.snapshot(data).layerLatents.length, 3);
  }
}
const deep = new core.Experiment("classification", 1, { extraHidden: [3, 4, 5], stepLimit: 10 });
assert.equal(deep.model.hiddenSizes.length, 3, "Three hidden layer limit");
deep.start();
while (deep.running) deep.trainOne();
assert.equal(deep.step, 10);
const pack = JSON.parse(html.match(/<script id="mnist-data" type="application\/json">([\s\S]*?)<\/script>/)[1]);
assert.equal(pack.indices.length, 1000);
assert.equal(new Set(pack.indices).size, 1000);
assert.equal(pack.coordinates.length, 1000);
const png = Buffer.from(pack.image.split(",")[1], "base64");
assert.equal(png.readUInt32BE(16), 700);
assert.equal(png.readUInt32BE(20), 1120);
// A deterministic test corpus checks MNIST handling without requiring a PNG decoder in Node.
const pixels = new Uint8Array(1000 * 784);
for (let i = 0; i < 1000; i++) pixels[i * 784 + (i % 784)] = 255;
core.registerMnist(pixels, pack.coordinates, pack.indices);
const mnist = core.dataset("mnist", 2, 900, 0.3, 42);
assert.equal(mnist.d, 784);
assert.equal(mnist.k, 10);
assert.equal(mnist.points.length, 300);
assert.equal(mnist.train.length, 240);
assert.equal(mnist.validation.length, 60);
assert.ok(mnist.points.every((p) => p.x.length === 784 && p.view.length === 3));
const large = new core.Experiment("classification", 1, { kind: "mnist", n: 100, stepLimit: 50000 });
assert.equal(large.model.h, 784);
assert.equal(large.limit, 1000);
assert.equal(large.maxHidden, 1024);
assert.equal(large.model.m, null, "Optimizer buffers are allocated only in the training worker");
large.reset({ ...large.config, h: 5000, extraHidden: [5000, 5000, 5000] });
assert.equal(large.model.h, 1024);
assert.deepEqual(Array.from(large.model.hiddenSizes), [1024, 128, 128]);
assert.ok(large.model.params.reduce((sum, p) => sum + p.length, 0) < 2000000, "Parameter bound");
for (let i = 0; i < 40; i++) {
  large.history.push({ step: i + 1, model: large.history[0].model });
  large.compactHistory();
}
assert.ok(large.history.length <= 8);
assert.equal(large.history[0].step, 0);
assert.equal(large.history.at(-1).step, 40);
// The cached output-head landscape agrees with direct evaluation for a deep model.
const dm = new core.Model(2, 3, 2, "classification", "tanh", 12, [4, 2]),
  refs = core.parameterRefs(dm, true),
  data = core.dataset("moons", 2, 60, 0.1, 42),
  a = refs[0],
  b = refs[1],
  weights = dm.params.map((p) => Array.from(p));
const sliced = core.sliceGrid({
  model: { d: dm.d, h: dm.h, k: dm.k, objective: dm.objective, activation: dm.activation, extraHidden: [4, 2], weights },
  points: data.train.slice(0, 10),
  axisARef: a,
  axisBRef: b,
  bounds: [-1, 1, -1, 1],
  resolution: 3,
});
dm.params[a.group][a.index] = 1;
dm.params[b.group][b.index] = -1;
assert.ok(Math.abs(sliced.values[2] - dm.evaluate(data.train.slice(0, 10)).loss) < 1e-12);
console.log(
  "PASS: three-layer numerical gradients, per-layer latents, configurable step limits, MNIST package and pixel handling, 784 default width, model/history caps, cached deep output-head landscape."
);

// PCA uses training rows only, with centered orthogonal components and zero padding.
const pcaRows = [
  [-3, 0],
  [3, 0],
  [0, -1],
  [0, 1],
  [1000, 1000],
];
const projected = core.latentPCA(pcaRows, [0, 1, 2, 3]);
assert.ok(Math.abs(projected.explained[0] - 0.9) < 1e-6);
assert.ok(Math.abs(projected.explained[1] - 0.1) < 1e-6);
assert.ok(Math.abs(projected.scores[0][0] + 3) < 1e-5);
assert.ok(projected.scores.every((row) => row[2] === 0));
for (let axis = 0; axis < 2; axis++) assert.ok(Math.abs(projected.scores.slice(0, 4).reduce((sum, row) => sum + row[axis], 0)) < 1e-9);
assert.ok(Math.abs(projected.scores.slice(0, 4).reduce((sum, row) => sum + row[0] * row[1], 0)) < 1e-8);
assert.ok(core.latentPCA([[2], [2], [2]], [0, 1]).scores.every((row) => row.every((v) => v === 0)));
const rankOne = core.latentPCA(
  [
    [1, 2, 3],
    [-1, -2, -3],
    [0, 0, 0],
  ],
  [0, 1, 2]
);
assert.ok(Math.abs(rankOne.explained[0] - 1) < 1e-9);
assert.ok(rankOne.explained.slice(1).every((v) => Math.abs(v) < 1e-9));
console.log("PASS: PCA variance ordering, centering, orthogonality, training-only fit, constant/rank-deficient activations.");

// Tiny MNIST weight changes must occupy a visible fraction of the fitted viewport.
const trajectoryRefs = [
  { group: 0, index: 0 },
  { group: 0, index: 1 },
  { group: 0, index: 2 },
  { group: 1, index: 0 },
];
const tinyHistory = [{ model: { weights: [[0.1, 0.2, 0.3], [0]] } }, { model: { weights: [[0.1, 0.20001, 0.30003], [10]] } }];
const trajectory = core.trajectoryWindow(tinyHistory, trajectoryRefs);
assert.deepEqual(Array.from(trajectory.axes), [2, 1], "Choose moving weights rather than a constant weight or bias");
for (let axis = 0; axis < 2; axis++) {
  const index = trajectory.axes[axis],
    low = trajectory.bounds[2 * axis],
    high = trajectory.bounds[2 * axis + 1];
  const first = tinyHistory[0].model.weights[0][index],
    last = tinyHistory[1].model.weights[0][index];
  assert.ok(low < first && last < high);
  assert.ok((last - first) / (high - low) > 0.2, "Small movements remain visible");
}
const manualTrajectory = core.trajectoryWindow(tinyHistory, trajectoryRefs, [0, 1]);
assert.deepEqual(Array.from(manualTrajectory.axes), [0, 1]);
assert.ok(manualTrajectory.bounds.every(Number.isFinite));
assert.ok(manualTrajectory.bounds[1] > manualTrajectory.bounds[0], "Stationary axes retain a nonzero range");
console.log("PASS: trajectory axis selection, adaptive tiny-motion bounds, manual axes and stationary ranges.");
