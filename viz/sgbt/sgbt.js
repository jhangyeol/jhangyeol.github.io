// Streaming Gradient Boosted Trees (simplified, 2-D features).
// Each boosting stage k holds one streaming regression tree that fits the
// Newton step -g/h (weight h) w.r.t. F_{k-1}, XGBoost-style. Leaves grow by a
// Hoeffding-bound split test. Each stage monitors its own error; on a warning a
// background tree starts learning in parallel, on drift it replaces the stage.

const BINS = 24;
const LO = -1.25;
const HI = 1.25;
const BW = (HI - LO) / BINS;
const binOf = (v) => {
  const b = Math.floor((v - LO) / BW);
  return b < 0 ? 0 : b >= BINS ? BINS - 1 : b;
};
const edgeAfter = (b) => LO + (b + 1) * BW;
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

function newLeaf(depth, G, H, n, d) {
  return {
    leaf: true,
    depth,
    G,
    H,
    n,
    since: 0,
    hG: new Float64Array(d * BINS),
    hH: new Float64Array(d * BINS),
    hN: new Float64Array(d * BINS),
  };
}

export class StreamTree {
  constructor(id, bornAt, p) {
    this.id = id;
    this.bornAt = bornAt;
    this.p = p;
    this.d = p.d || 2;
    this.root = newLeaf(0, 0, 0, 0, this.d);
    this.n = 0;
    this.splits = 0;
    this.lastSplitAt = null;
  }

  leafOf(x) {
    let nd = this.root;
    while (!nd.leaf) nd = x[nd.f] <= nd.thr ? nd.left : nd.right;
    return nd;
  }

  value(nd) {
    return -nd.G / (nd.H + this.p.lambda);
  }

  predict(x) {
    return this.value(this.leafOf(x));
  }

  learn(x, g, h, t) {
    const l = this.leafOf(x);
    l.G += g;
    l.H += h;
    l.n += 1;
    this.n += 1;
    if (l.depth >= this.p.maxDepth) return;
    for (let f = 0; f < this.d; f++) {
      const i = f * BINS + binOf(x[f]);
      l.hG[i] += g;
      l.hH[i] += h;
      l.hN[i] += 1;
    }
    if (++l.since >= this.p.grace) {
      l.since = 0;
      this.trySplit(l, t);
    }
  }

  trySplit(l, t) {
    const { lambda, delta, tau, minLeaf, gamma } = this.p;
    const best = [];
    for (let f = 0; f < this.d; f++) {
      const o = f * BINS;
      let Gt = 0;
      let Ht = 0;
      let Nt = 0;
      for (let b = 0; b < BINS; b++) {
        Gt += l.hG[o + b];
        Ht += l.hH[o + b];
        Nt += l.hN[o + b];
      }
      const base = (Gt * Gt) / (Ht + lambda);
      let GL = 0;
      let HL = 0;
      let NL = 0;
      let top = { gain: 0, f, b: -1, Nt };
      for (let b = 0; b < BINS - 1; b++) {
        GL += l.hG[o + b];
        HL += l.hH[o + b];
        NL += l.hN[o + b];
        if (NL < minLeaf || Nt - NL < minLeaf) continue;
        const GR = Gt - GL;
        const HR = Ht - HL;
        const gain = 0.5 * ((GL * GL) / (HL + lambda) + (GR * GR) / (HR + lambda) - base);
        if (gain > top.gain) top = { gain, f, b, Nt, GL, HL, NL, GR, HR, NR: Nt - NL };
      }
      best.push(top);
    }
    best.sort((a, b) => b.gain - a.gain);
    const [b1, b2] = best;
    if (b1.b < 0 || b1.gain <= gamma * b1.Nt) return;
    const eps = Math.sqrt(Math.log(1 / delta) / (2 * b1.Nt));
    const ratio = b2.gain / b1.gain;
    if (!(ratio < 1 - eps || eps < tau)) return;
    // split
    l.leaf = false;
    l.f = b1.f;
    l.thr = edgeAfter(b1.b);
    l.left = newLeaf(l.depth + 1, b1.GL, b1.HL, b1.NL, this.d);
    l.right = newLeaf(l.depth + 1, b1.GR, b1.HR, b1.NR, this.d);
    l.gain = b1.gain;
    l.splitAt = t;
    l.hG = l.hH = l.hN = null;
    this.splits += 1;
    this.lastSplitAt = t;
  }

  // Compact snapshot: nodes[i] = [f, thr, left, right, value, n, depth] (f = -1 for leaves)
  snapshot() {
    const nodes = [];
    const walk = (nd) => {
      const i = nodes.length;
      nodes.push(null);
      if (nd.leaf) {
        nodes[i] = [-1, 0, -1, -1, this.value(nd), nd.n, nd.depth];
      } else {
        const L = walk(nd.left);
        const R = walk(nd.right);
        nodes[i] = [nd.f, nd.thr, L, R, this.value(nd), nd.n, nd.depth, nd.splitAt];
      }
      return i;
    };
    walk(this.root);
    let depth = 0;
    let leaves = 0;
    for (const nd of nodes) {
      if (nd[0] < 0) {
        leaves++;
        if (nd[6] > depth) depth = nd[6];
      }
    }
    return { id: this.id, bornAt: this.bornAt, n: this.n, splits: this.splits, lastSplitAt: this.lastSplitAt, depth, leaves, nodes };
  }
}

export function leafIndexSnap(snap, x) {
  const N = snap.nodes;
  let i = 0;
  while (N[i][0] >= 0) i = x[N[i][0]] <= N[i][1] ? N[i][2] : N[i][3];
  return i;
}

export function predictSnap(snap, x) {
  return snap.nodes[leafIndexSnap(snap, x)][4];
}

export const DEFAULTS = {
  trees: 10,
  eta: 0.3,
  grace: 60,
  delta: 0.01,
  tau: 0.08,
  lambda: 1,
  gamma: 1e-4,
  minLeaf: 8,
  maxDepth: 5,
  replace: true,
  sensitivity: 1,
  minAge: 300,
  zWarn: 3,
};

export class SGBT {
  constructor(task, p) {
    this.task = task;
    this.p = p;
    this.nextId = 1;
    this.t = 0;
    this.trees = [];
    this.alts = [];
    this.det = [];
    for (let k = 0; k < p.trees; k++) {
      this.trees.push(this.makeTree());
      this.alts.push(null);
      this.det.push(this.freshDetector());
    }
  }

  makeTree() {
    return new StreamTree(this.nextId++, this.t, this.p);
  }

  freshDetector() {
    return { ef: 0, es: 0, ev: 0, z: 0, cnt: 0, state: "ok", warnAt: null, altErr: 0 };
  }

  raw(x) {
    let F = 0;
    for (const tr of this.trees) F += this.p.eta * tr.predict(x);
    return F;
  }

  predict(x) {
    const F = this.raw(x);
    return this.task === "cls" ? sigmoid(F) : F;
  }

  // Train on one instance; returns list of events (warn / swap / cancel).
  learn(x, y) {
    const { eta, replace } = this.p;
    const t = this.t;
    const events = [];
    let F = 0;
    for (let k = 0; k < this.trees.length; k++) {
      const tr = this.trees[k];
      const fk = tr.predict(x);
      let g;
      let h;
      if (this.task === "cls") {
        const p = sigmoid(F);
        g = p - y;
        h = Math.max(p * (1 - p), 1e-6);
      } else {
        g = F - y;
        h = 1;
      }
      const err = (g + h * fk) ** 2;
      if (replace) this.monitor(k, err, x, g, h, t, events);
      this.trees[k].learn(x, g, h, t);
      if (this.alts[k]) this.alts[k].learn(x, g, h, t);
      F += eta * fk;
    }
    this.t += 1;
    return events;
  }

  monitor(k, err, x, g, h, t, events) {
    const d = this.det[k];
    const s = this.p.sensitivity;
    d.cnt += 1;
    if (d.cnt === 1) {
      d.ef = d.es = err;
      d.ev = err * err;
    } else {
      d.ef += 0.03 * (err - d.ef);
      d.ev += 0.003 * ((err - d.es) ** 2 - d.ev);
      d.es += 0.003 * (err - d.es);
    }
    const alt = this.alts[k];
    if (alt) {
      const ae = (g + h * alt.predict(x)) ** 2;
      d.altErr = alt.n === 0 ? ae : d.altErr + 0.03 * (ae - d.altErr);
    }
    if (d.cnt < this.p.minAge) return;
    const floor = this.task === "cls" ? 2e-3 : 2e-3;
    // fast mean ~ 66 samples: z-score of the fast mean against the slow mean/variance
    d.z = (d.ef - d.es) / Math.sqrt(d.ev / 66 + 1e-12);
    const Z = this.p.zWarn ?? 3;
    const warnLine = d.z > Z / s ? d.es * (1 + 0.45 / s) + floor : Infinity;
    const driftLine = d.z > (2 * Z) / s ? d.es * (1 + 0.9 / s) + floor : Infinity;
    if (d.state === "ok" && d.ef > warnLine) {
      d.state = "warn";
      d.warnAt = t;
      this.alts[k] = this.makeTree();
      d.altErr = 0;
      events.push({ type: "warn", t, slot: k, treeId: this.trees[k].id, altId: this.alts[k].id });
    } else if (d.state === "warn") {
      if (d.ef > driftLine) {
        const old = this.trees[k];
        const repl = this.alts[k] && this.alts[k].n > 0 ? this.alts[k] : this.makeTree();
        events.push({
          type: "swap",
          t,
          slot: k,
          oldId: old.id,
          newId: repl.id,
          usedAlt: repl === this.alts[k],
          warnAt: d.warnAt,
          ef: d.ef,
          es: d.es,
          retired: old.snapshot(),
        });
        this.trees[k] = repl;
        this.alts[k] = null;
        this.det[k] = this.freshDetector();
        this.det[k].cnt = Math.min(repl.n, this.p.minAge - 1);
        this.det[k].ef = this.det[k].es = d.altErr || err;
        // downstream stages see a different residual now; let them re-settle briefly
        for (let j = k + 1; j < this.det.length; j++) {
          const dj = this.det[j];
          dj.ef = dj.es;
          dj.cnt = Math.min(dj.cnt, this.p.minAge - 100);
        }
      } else if (d.ef < d.es * (1 + 0.1 / s) && t - d.warnAt > 250) {
        events.push({ type: "cancel", t, slot: k, treeId: this.trees[k].id, altId: this.alts[k].id });
        d.state = "ok";
        d.warnAt = null;
        this.alts[k] = null;
      }
    }
  }

  snapshot() {
    return {
      trees: this.trees.map((t) => t.snapshot()),
      alts: this.alts.map((a) => (a ? a.snapshot() : null)),
      det: this.det.map((d) => ({ ef: d.ef, es: d.es, z: d.z, state: d.state, warnAt: d.warnAt, cnt: d.cnt })),
    };
  }
}
