import { SCENARIOS } from "./data.js";
import { DEFAULTS, predictSnap, leafIndexSnap } from "./sgbt.js";
import { runSimulation } from "./sim.js";
import { INFO } from "./info.js";

const $ = (id) => document.getElementById(id);
const LO = -1.2;
const HI = 1.2;
const GRID = 150;
const POINT_WINDOW = 320;
const BASE_FPS = 15;
const SUB = ["₀", "₁", "₂", "₃", "₄", "₅", "₆", "₇", "₈", "₉"];
const sub = (n) =>
  String(n)
    .split("")
    .map((d) => SUB[+d])
    .join("");
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "") + "k" : String(Math.round(n)));
const fmtT = (n) => Math.round(n).toLocaleString("en-US");
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const sigmoid = (z) => 1 / (1 + Math.exp(-z));

const PDEF = [
  { k: "trees", label: "Trees (S)", min: 1, max: 20, step: 1 },
  { k: "eta", label: "Learning rate η", min: 0.05, max: 1, step: 0.05 },
  { k: "grace", label: "Grace period", min: 20, max: 300, step: 10 },
  { k: "delta", label: "Split confidence δ", min: -4, max: -1, step: 0.5, log: true },
  { k: "tau", label: "Tie threshold τ", min: 0.01, max: 0.3, step: 0.01 },
  { k: "lambda", label: "L2 λ", min: 0, max: 5, step: 0.1 },
  { k: "maxDepth", label: "Max depth", min: 1, max: 8, step: 1 },
  { k: "replace", label: "Tree replacement", bool: true },
  { k: "sensitivity", label: "Detector sensitivity", min: 0.5, max: 2, step: 0.1 },
  { k: "noise", label: "Noise", min: 0, max: 0.3, step: 0.01, cfg: true },
  { k: "period", label: "Concept period", min: 500, max: 3000, step: 250, cfg: true },
];

const S = {
  task: "cls",
  scenario: { cls: "moons", reg: "rpoly" },
  drift: "abrupt",
  noise: { cls: 0.05, reg: 0.1 },
  period: 1500,
  seed: 7,
  params: { ...DEFAULTS },
  run: null,
  fi: 0,
  prevFi: 0,
  playing: false,
  speed: 1,
  show: { boundary: true, truth: true, points: true },
  sel: null, // { id, slot }
  overlay: "ensemble",
  hoverLeaf: null,
};

let C = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  const get = (n) => cs.getPropertyValue("--" + n).trim();
  const rgb = (h) => {
    if (h.startsWith("#")) {
      const n = parseInt(h.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }
    return (h.match(/[\d.]+/g) || [0, 0, 0]).slice(0, 3).map(Number);
  };
  for (const n of ["bg", "card", "ink", "muted", "faint", "line", "line2", "accent", "neg", "pos", "f1", "f2", "warn", "drift", "ok"]) C[n] = get(n);
  C.negRGB = rgb(C.neg);
  C.posRGB = rgb(C.pos);
  C.midRGB = rgb(C.card);
}

// v in [-1, 1] -> rgb mixed from card color toward neg/pos with intensity t
function divColor(v, t) {
  const c = v < 0 ? C.negRGB : C.posRGB;
  const m = C.midRGB;
  return [m[0] + (c[0] - m[0]) * t, m[1] + (c[1] - m[1]) * t, m[2] + (c[2] - m[2]) * t];
}
const css = (rgb, a = 1) => `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${a})`;

// ---------------------------------------------------------------- run
function rerun(keep = true) {
  const n0 = S.run ? S.run.frames.length - 1 : 1;
  const ratio = keep && S.run ? S.fi / n0 : 0;
  const T = S.period * 4;
  const run = runSimulation({
    task: S.task,
    scenario: S.scenario[S.task],
    drift: S.drift,
    T,
    period: S.period,
    noise: S.noise[S.task],
    every: Math.max(10, Math.round(T / 300)),
    seed: S.seed,
    params: { ...S.params },
  });
  derive(run);
  S.run = run;
  S.fi = Math.round(ratio * (run.frames.length - 1));
  S.prevFi = S.fi;
  S.sel = null;
  S.overlay = "ensemble";
  closeDrawer();
  $("scrub").max = run.frames.length - 1;
  buildCards();
  layoutTimeline();
  render(false);
}

function derive(run) {
  const S_ = run.frames[0].trees.length;
  run.S = S_;
  run.retired = new Map();
  run.swaps = [];
  run.warns = Array.from({ length: S_ }, () => []);
  run.life = Array.from({ length: S_ }, (_, k) => [{ id: run.frames[0].trees[k].id, from: 0, to: null, bgFrom: null }]);
  const open = new Map();
  for (const e of run.events) {
    if (e.type === "warn") {
      const span = { from: e.t, to: null, end: "open", altId: e.altId };
      run.warns[e.slot].push(span);
      open.set(e.slot, span);
    } else if (e.type === "cancel" || e.type === "swap") {
      const span = open.get(e.slot);
      if (span) {
        span.to = e.t;
        span.end = e.type;
        open.delete(e.slot);
      }
    }
    if (e.type === "swap") {
      run.retired.set(e.oldId, e);
      run.swaps.push(e);
      const L = run.life[e.slot];
      L[L.length - 1].to = e.t;
      L.push({ id: e.newId, from: e.t, to: null, bgFrom: e.usedAlt ? e.warnAt : null });
    }
  }
  const T = run.cfg.T;
  for (const ws of run.warns) for (const w of ws) if (w.to == null) w.to = T;
  if (run.cfg.task === "reg") {
    const a = Array.from(run.ys, Math.abs).sort((x, y) => x - y);
    run.vmax = Math.max(0.5, a[Math.floor(a.length * 0.98)]);
  } else run.vmax = 1;
  run.leafScale = run.cfg.task === "cls" ? 0.6 : run.vmax * 0.35;
  const lo = Math.min(...run.frames.slice(1).flatMap((f) => [f.metric, f.baseMetric]));
  const hi = Math.max(...run.frames.slice(1).flatMap((f) => [f.metric, f.baseMetric]));
  run.yr = run.cfg.task === "cls" ? [Math.max(0, Math.floor(lo * 10) / 10), 1] : [0, Math.ceil(hi * 11) / 10];
}

const frame = () => S.run.frames[S.fi];

function lifeOf(slot, id) {
  return S.run.life[slot].find((l) => l.id === id);
}

// ---------------------------------------------------------------- selection
function resolveSel(fr) {
  if (!S.sel) return null;
  const { id, slot } = S.sel;
  if (fr.trees[slot] && fr.trees[slot].id === id)
    return { snap: fr.trees[slot], status: fr.det[slot].state === "warn" ? "warn" : "active", det: fr.det[slot] };
  if (fr.alts[slot] && fr.alts[slot].id === id) return { snap: fr.alts[slot], status: "bg" };
  const ev = S.run.retired.get(id);
  if (ev && ev.t < fr.t) return { snap: ev.retired, status: "retired", ev };
  return { snap: null, status: "unborn" };
}

function regionsOf(snap) {
  if (snap._regions) return snap._regions;
  const out = new Map();
  const walk = (i, x0, x1, y0, y1) => {
    const nd = snap.nodes[i];
    if (nd[0] < 0) {
      out.set(i, [x0, x1, y0, y1]);
      return;
    }
    if (nd[0] === 0) {
      walk(nd[2], x0, Math.min(x1, nd[1]), y0, y1);
      walk(nd[3], Math.max(x0, nd[1]), x1, y0, y1);
    } else {
      walk(nd[2], x0, x1, y0, Math.min(y1, nd[1]));
      walk(nd[3], x0, x1, Math.max(y0, nd[1]), y1);
    }
  };
  walk(0, LO, HI, LO, HI);
  Object.defineProperty(snap, "_regions", { value: out, enumerable: false });
  return out;
}

// ---------------------------------------------------------------- plot
const plot = $("plot");
const pctx = plot.getContext("2d");
const hm = document.createElement("canvas");
hm.width = hm.height = GRID;
const hctx = hm.getContext("2d");
let plotW = 0;
let gridCache = { key: "", vals: null };
let truthCache = { key: "", vals: null };

function sizeCanvas(cv, w, h) {
  const d = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(w * d) || cv.height !== Math.round(h * d)) {
    cv.width = Math.round(w * d);
    cv.height = Math.round(h * d);
  }
  const ctx = cv.getContext("2d");
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return ctx;
}

const cellX = (i, N) => LO + ((i + 0.5) * (HI - LO)) / N;
const cellY = (j, N) => HI - ((j + 0.5) * (HI - LO)) / N;

// What the background shows: returns { vals (in [-1,1]-ish), kind }
function overlaySpec(fr) {
  const r = resolveSel(fr);
  const eta = S.run.cfg.params.eta;
  if (S.sel && r && r.snap && S.overlay === "tree") return { kind: "tree", trees: [r.snap], key: "t" + r.snap.id + ":" + r.snap.n };
  if (S.sel && r && r.snap && S.overlay === "upto" && (r.status === "active" || r.status === "warn"))
    return { kind: "upto", trees: fr.trees.slice(0, S.sel.slot + 1), key: "u" + S.sel.slot };
  return { kind: "ens", trees: fr.trees, key: "e", eta };
}

function gridValues(fr, spec) {
  const key = S.fi + "|" + spec.key + "|" + S.run.cfg.seed;
  if (gridCache.key === key && gridCache.run === S.run) return gridCache.vals;
  const N = GRID;
  const eta = S.run.cfg.params.eta;
  const F = new Float32Array(N * N);
  for (const tr of spec.trees) {
    for (let j = 0; j < N; j++) {
      const y = cellY(j, N);
      for (let i = 0; i < N; i++) F[j * N + i] += eta * predictSnap(tr, cellX(i, N), y);
    }
  }
  gridCache = { key, vals: F, run: S.run };
  return F;
}

function truthValues(phase) {
  const N = 90;
  const key = phase.toFixed(3);
  if (truthCache.key === key && truthCache.run === S.run) return truthCache.vals;
  const v = new Float32Array(N * N);
  const sc = S.run.sc;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) v[j * N + i] = sc.truth(cellX(i, N), cellY(j, N), phase);
  truthCache = { key, vals: v, run: S.run };
  return v;
}

// marching squares on cell-centre grid
const MS = [
  [],
  [[3, 2]],
  [[2, 1]],
  [[3, 1]],
  [[0, 1]],
  [
    [3, 0],
    [2, 1],
  ],
  [[0, 2]],
  [[3, 0]],
  [[3, 0]],
  [[0, 2]],
  [
    [0, 1],
    [3, 2],
  ],
  [[0, 1]],
  [[3, 1]],
  [[2, 1]],
  [[3, 2]],
  [],
];
function contour(ctx, vals, N, level, W) {
  const s = W / N;
  ctx.beginPath();
  for (let j = 0; j < N - 1; j++) {
    for (let i = 0; i < N - 1; i++) {
      const a = vals[j * N + i];
      const b = vals[j * N + i + 1];
      const c = vals[(j + 1) * N + i + 1];
      const d = vals[(j + 1) * N + i];
      const idx = (a > level ? 8 : 0) | (b > level ? 4 : 0) | (c > level ? 2 : 0) | (d > level ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      const pt = (e) => {
        let x;
        let y;
        if (e === 0) {
          x = i + (level - a) / (b - a);
          y = j;
        } else if (e === 1) {
          x = i + 1;
          y = j + (level - b) / (c - b);
        } else if (e === 2) {
          x = i + (level - d) / (c - d);
          y = j + 1;
        } else {
          x = i;
          y = j + (level - a) / (d - a);
        }
        return [(x + 0.5) * s, (y + 0.5) * s];
      };
      for (const [e1, e2] of MS[idx]) {
        const p = pt(e1);
        const q = pt(e2);
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      }
    }
  }
  ctx.stroke();
}

function regLevels() {
  const v = S.run.vmax;
  const step = v > 1.2 ? 0.5 : v > 0.6 ? 0.25 : 0.1;
  const out = [];
  for (let l = -Math.floor(v / step) * step; l <= v + 1e-9; l += step) out.push(+l.toFixed(3));
  return out;
}

function renderPlot() {
  const run = S.run;
  const fr = frame();
  const W = plot.parentElement.clientWidth;
  plotW = W;
  const ctx = sizeCanvas(plot, W, W);
  const toPx = (x) => ((x - LO) / (HI - LO)) * W;
  const toPy = (y) => ((HI - y) / (HI - LO)) * W;
  const isCls = run.cfg.task === "cls";
  ctx.clearRect(0, 0, W, W);
  ctx.fillStyle = C.card;
  ctx.fillRect(0, 0, W, W);

  const spec = overlaySpec(fr);
  const F = gridValues(fr, spec);
  const N = GRID;
  let treeScale = 1;
  if (spec.kind === "tree") {
    const eta = run.cfg.params.eta;
    treeScale = Math.max(1e-6, ...spec.trees[0].nodes.filter((n) => n[0] < 0).map((n) => Math.abs(eta * n[4])));
  }
  if (S.show.boundary || spec.kind === "tree") {
    const img = hctx.createImageData(N, N);
    for (let p = 0; p < N * N; p++) {
      let v;
      let t;
      if (spec.kind === "tree") {
        v = F[p] / treeScale;
        t = Math.min(1, Math.abs(v)) * 0.7;
      } else if (isCls) {
        v = 2 * sigmoid(F[p]) - 1;
        t = Math.pow(Math.abs(v), 0.85) * 0.5;
      } else {
        v = F[p] / run.vmax;
        t = Math.min(1, Math.abs(v)) * 0.72;
      }
      const c = divColor(v, t);
      img.data[p * 4] = c[0];
      img.data[p * 4 + 1] = c[1];
      img.data[p * 4 + 2] = c[2];
      img.data[p * 4 + 3] = 255;
    }
    hctx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(hm, 0, 0, W, W);
  }

  // axes
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const g of [-1, 0, 1]) {
    ctx.moveTo(toPx(g) + 0.5, 0);
    ctx.lineTo(toPx(g) + 0.5, W);
    ctx.moveTo(0, toPy(g) + 0.5);
    ctx.lineTo(W, toPy(g) + 0.5);
  }
  ctx.stroke();

  // model contours
  if (S.show.boundary && spec.kind !== "tree") {
    ctx.strokeStyle = C.ink;
    if (isCls) {
      ctx.lineWidth = 2;
      contour(ctx, F, N, 0, W);
    } else {
      for (const l of regLevels()) {
        ctx.lineWidth = l === 0 ? 1.6 : 0.8;
        ctx.globalAlpha = l === 0 ? 0.85 : 0.45;
        contour(ctx, F, N, l, W);
      }
      ctx.globalAlpha = 1;
    }
  }
  // truth
  if (S.show.truth) {
    const ph = run.sch.display(Math.max(0, fr.t - 1));
    const tv = truthValues(ph);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = C.ink;
    if (isCls) {
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      contour(ctx, tv, 90, 0.5, W);
    } else {
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.45;
      for (const l of regLevels()) contour(ctx, tv, 90, l, W);
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }
  // selected tree partition
  const r = resolveSel(fr);
  if (r && r.snap) {
    const regs = regionsOf(r.snap);
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.55;
    for (const [, [x0, x1, y0, y1]] of regs) ctx.strokeRect(toPx(x0) + 0.5, toPy(y1) + 0.5, toPx(x1) - toPx(x0), toPy(y0) - toPy(y1));
    ctx.globalAlpha = 1;
    if (S.hoverLeaf != null && regs.has(S.hoverLeaf)) {
      const [x0, x1, y0, y1] = regs.get(S.hoverLeaf);
      ctx.fillStyle = C.ink;
      ctx.globalAlpha = 0.14;
      ctx.fillRect(toPx(x0), toPy(y1), toPx(x1) - toPx(x0), toPy(y0) - toPy(y1));
      ctx.globalAlpha = 1;
      ctx.lineWidth = 2.5;
      ctx.strokeRect(toPx(x0), toPy(y1), toPx(x1) - toPx(x0), toPy(y0) - toPy(y1));
    }
  }
  // points
  if (S.show.points) {
    const t1 = fr.t;
    const t0 = Math.max(0, t1 - POINT_WINDOW);
    const rad = W < 420 ? 2.4 : 3.1;
    for (let t = t0; t < t1; t++) {
      const a = 0.18 + 0.82 * ((t - t0 + 1) / POINT_WINDOW) ** 1.4;
      const x = toPx(run.xs[2 * t]);
      const y = toPy(run.xs[2 * t + 1]);
      const yv = run.ys[t];
      const col = isCls ? (yv > 0.5 ? C.posRGB : C.negRGB) : divColor(yv / run.vmax, Math.min(1, Math.abs(yv / run.vmax)) * 0.85 + 0.15);
      ctx.globalAlpha = a;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fillStyle = css(col);
      ctx.fill();
      ctx.lineWidth = 0.8;
      ctx.strokeStyle = C.card;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }
  // axis labels
  ctx.fillStyle = C.muted;
  ctx.font = "11px -apple-system, sans-serif";
  ctx.fillText("x₁ →", W - 34, W - 6);
  ctx.save();
  ctx.translate(12, 36);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("x₂ →", 0, 0);
  ctx.restore();

  renderLegend(spec, treeScale);
}

let legendKey = "";
function renderLegend(spec, treeScale) {
  const isCls = S.run.cfg.task === "cls";
  const grad = (a, b) => `linear-gradient(90deg, ${C.neg}, ${C.card}, ${C.pos})`;
  let left;
  let right;
  let mid = "";
  if (spec.kind === "tree") {
    left = (-treeScale).toFixed(2);
    right = "+" + treeScale.toFixed(2);
    mid = `η·f${sub(S.sel.slot + 1)}(x)`;
  } else if (isCls) {
    left = "class 0";
    right = "class 1";
    mid = spec.kind === "upto" ? `σ(F${sub(S.sel.slot + 1)})` : "p(y=1)";
  } else {
    left = (-S.run.vmax).toFixed(1);
    right = "+" + S.run.vmax.toFixed(1);
    mid = spec.kind === "upto" ? `F${sub(S.sel.slot + 1)}(x)` : "ŷ";
  }
  const key = [left, right, mid, spec.kind].join("|");
  if (key === legendKey) return;
  legendKey = key;
  $("legend").innerHTML = `<span class="num">${left}</span><span class="grad" style="background:${grad()}"></span><span class="num">${right}</span>
    <span class="muted">${mid}</span>
    <span class="key"><i></i>model</span><span class="key"><i class="dash"></i>true</span>`;
}

// ---------------------------------------------------------------- mini trees
function layoutTree(snap) {
  const N = snap.nodes;
  const pos = new Array(N.length);
  let leaf = 0;
  let maxD = 0;
  const walk = (i) => {
    const nd = N[i];
    if (nd[6] > maxD) maxD = nd[6];
    if (nd[0] < 0) {
      pos[i] = [leaf++, nd[6]];
      return pos[i][0];
    }
    const a = walk(nd[2]);
    const b = walk(nd[3]);
    pos[i] = [(a + b) / 2, nd[6]];
    return pos[i][0];
  };
  walk(0);
  return { pos, leaves: leaf, maxD };
}

function drawMini(cv, snap, opts = {}) {
  const w = cv.clientWidth || 100;
  const h = cv.clientHeight || 50;
  const ctx = sizeCanvas(cv, w, h);
  ctx.clearRect(0, 0, w, h);
  if (!snap) return;
  const { pos, leaves, maxD } = layoutTree(snap);
  const pad = opts.small ? 3 : 5;
  const X = (p) => pad + ((p + 0.5) / leaves) * (w - 2 * pad);
  const Y = (d) => (maxD ? pad + (d / maxD) * (h - 2 * pad) : h / 2);
  const N = snap.nodes;
  ctx.strokeStyle = C.line2;
  ctx.lineWidth = 1;
  if (opts.dashed) ctx.setLineDash([2, 2]);
  ctx.beginPath();
  for (let i = 0; i < N.length; i++) {
    if (N[i][0] < 0) continue;
    for (const c of [N[i][2], N[i][3]]) {
      ctx.moveTo(X(pos[i][0]), Y(pos[i][1]));
      ctx.lineTo(X(pos[c][0]), Y(pos[c][1]));
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
  const eta = S.run.cfg.params.eta;
  const r = opts.small ? 1.8 : leaves > 24 ? 2.2 : 3;
  for (let i = 0; i < N.length; i++) {
    const nd = N[i];
    ctx.beginPath();
    if (nd[0] < 0) {
      const v = clamp((eta * nd[4]) / S.run.leafScale, -1, 1);
      ctx.arc(X(pos[i][0]), Y(pos[i][1]), r, 0, Math.PI * 2);
      ctx.fillStyle = css(divColor(v, 0.25 + 0.75 * Math.abs(v)));
      ctx.fill();
    } else {
      ctx.arc(X(pos[i][0]), Y(pos[i][1]), r * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = nd[0] === 0 ? C.f1 : C.f2;
      ctx.fill();
    }
  }
}

// ---------------------------------------------------------------- cards
let slots = [];
function buildCards() {
  const box = $("trees");
  box.innerHTML = "";
  slots = [];
  for (let k = 0; k < S.run.S; k++) {
    const el = document.createElement("div");
    el.className = "slot";
    el.innerHTML = `<div class="tcard">
        <div class="tc-top"><span class="k">#${k + 1}</span><b class="id num"></b><span class="badge">new</span></div>
        <canvas class="mini"></canvas>
        <div class="tc-meta num"><span class="lv"></span><span class="age"></span></div>
        <div class="meter" title="drift detector: 단기/장기 오차 비율"><div class="fill"></div><div class="tick w"></div><div class="tick d"></div></div>
      </div>
      <div class="alt" title="백그라운드 트리 (클릭하여 보기)"><canvas></canvas><span class="num"></span></div>`;
    el.querySelector(".tcard").addEventListener("click", () => {
      const fr = frame();
      openDrawer({ id: fr.trees[k].id, slot: k });
    });
    el.querySelector(".alt").addEventListener("click", (e) => {
      e.stopPropagation();
      const fr = frame();
      if (fr.alts[k]) openDrawer({ id: fr.alts[k].id, slot: k });
    });
    box.appendChild(el);
    slots.push(el);
  }
}

function renderCards(animate) {
  const fr = frame();
  const p = S.run.cfg.params;
  const wK = 0.45 / p.sensitivity;
  const dK = 0.9 / p.sensitivity;
  const scale = dK * 1.25;
  for (let k = 0; k < slots.length; k++) {
    const el = slots[k];
    const tr = fr.trees[k];
    const card = el.querySelector(".tcard");
    const prevId = el.dataset.id;
    if (animate && prevId && +prevId !== tr.id) {
      const g = card.cloneNode(true);
      g.classList.add("ghost");
      g.classList.remove("enter");
      const oc = card.querySelector("canvas");
      const gc = g.querySelector("canvas");
      gc.width = oc.width;
      gc.height = oc.height;
      gc.getContext("2d").drawImage(oc, 0, 0);
      el.appendChild(g);
      setTimeout(() => g.remove(), 950);
      card.classList.remove("enter");
      void card.offsetWidth;
      card.classList.add("enter");
    }
    el.dataset.id = tr.id;
    const life = lifeOf(k, tr.id);
    const since = life ? life.from : tr.bornAt;
    el.querySelector(".id").textContent = "T" + tr.id;
    el.querySelector(".lv").textContent = tr.leaves + (tr.leaves === 1 ? " leaf" : " leaves");
    el.querySelector(".age").textContent = "age " + fmtK(fr.t - since);
    el.classList.toggle("fresh", since > 0 && fr.t - since < 400);
    const d = fr.det[k];
    const warn = d.state === "warn";
    el.classList.toggle("warn", warn);
    el.classList.toggle("sel", !!S.sel && S.sel.slot === k);
    drawMini(card.querySelector("canvas"), tr);
    // meter
    const m = el.querySelector(".meter");
    const cold = !p.replace || d.cnt < p.minAge;
    m.classList.toggle("cold", cold);
    const ratio = d.es > 0 ? d.ef / d.es - 1 : 0;
    const fill = clamp(ratio / scale, 0, 1);
    const f = m.querySelector(".fill");
    f.style.width = (cold ? 0 : fill * 100) + "%";
    f.style.background = ratio > dK ? C.drift : ratio > wK ? C.warn : C.ok;
    const tw = m.querySelector(".w");
    const td = m.querySelector(".d");
    tw.style.left = (wK / scale) * 100 + "%";
    tw.style.background = C.warn;
    td.style.left = (dK / scale) * 100 + "%";
    td.style.background = C.drift;
    // alt
    if (warn && fr.alts[k]) {
      const a = fr.alts[k];
      drawMini(el.querySelector(".alt canvas"), a, { small: true, dashed: true });
      el.querySelector(".alt span").textContent = `bg T${a.id} · ${fmtK(a.n)}`;
    }
  }
}

// ---------------------------------------------------------------- log & stats
let logCount = -1;
function renderLog() {
  const t = frame().t;
  const list = S.run.swaps.filter((e) => e.t < t);
  $("swapCount").textContent = `${list.length} / ${S.run.swaps.length}`;
  if (list.length === logCount) return;
  logCount = list.length;
  const ol = $("log");
  if (!list.length) {
    ol.innerHTML = `<li class="empty">${S.run.cfg.params.replace ? "아직 교체 없음" : "Tree replacement 꺼짐"}</li>`;
    return;
  }
  ol.innerHTML = list
    .slice()
    .reverse()
    .map(
      (e) => `<li data-t="${e.t}" data-id="${e.oldId}" data-slot="${e.slot}">
        <span class="t num">t=${fmtT(e.t)}</span><span class="num">#${e.slot + 1}</span>
        <span class="num">T${e.oldId} <span class="arrow">→</span> T${e.newId}</span>${
          e.usedAlt ? '<span class="tag">bg</span>' : "<span></span>"
        }</li>`
    )
    .join("");
}

function renderStats() {
  const fr = frame();
  const isCls = S.run.cfg.task === "cls";
  const f = (v) => (v == null ? "–" : isCls ? (v * 100).toFixed(1) + "%" : v.toFixed(3));
  const swaps = S.run.swaps.filter((e) => e.t < fr.t).length;
  $("stats").innerHTML = `<div>${isCls ? "Accuracy" : "RMSE"} (last 200)<b>${f(fr.metric)}</b></div>
    <div class="base">w/o replacement<b>${f(fr.baseMetric)}</b></div>
    <div>Swaps<b>${swaps}</b></div>
    <div>Total leaves<b>${fr.trees.reduce((s, t) => s + t.leaves, 0)}</b></div>`;
  const T = S.run.cfg.T;
  $("tlabel").textContent = `t = ${fmtT(fr.t)} / ${fmtT(T)}`;
  $("scrub").value = S.fi;
  // concept label
  const ph = S.run.sch.display(Math.max(0, fr.t - 1));
  const i = Math.floor(ph + 1e-6);
  const frac = ph - i;
  const lab = S.run.cfg.drift === "none" ? "Stationary" : frac > 0.02 ? `Concept ${i + 1} → ${i + 2}` : `Concept ${i + 1}`;
  const el = $("concept");
  if (el.textContent !== lab) {
    if (S.playing && el.textContent) {
      el.classList.add("flash");
      setTimeout(() => el.classList.remove("flash"), 700);
    }
    el.textContent = lab;
  }
}

// ---------------------------------------------------------------- timeline
const tl = $("timeline");
const tlLayer = document.createElement("canvas");
let TL = null;

function layoutTimeline() {
  const W = tl.clientWidth || 800;
  const S_ = S.run.S;
  const rowH = S_ <= 12 ? 11 : 6;
  const L = { W, padL: 30, padR: 8, top: 8, chartH: 110, gap: 22, rowH, rows: S_ };
  L.rowsTop = L.top + L.chartH + L.gap;
  L.H = L.rowsTop + S_ * rowH + 22;
  L.x = (t) => L.padL + (t / S.run.cfg.T) * (W - L.padL - L.padR);
  TL = L;
  tl.style.height = L.H + "px";
  const d = window.devicePixelRatio || 1;
  tlLayer.width = Math.round(W * d);
  tlLayer.height = Math.round(L.H * d);
  const ctx = tlLayer.getContext("2d");
  ctx.setTransform(d, 0, 0, d, 0, 0);
  drawTimelineLayer(ctx, L);
}

function drawTimelineLayer(ctx, L) {
  const run = S.run;
  const T = run.cfg.T;
  const [y0, y1] = run.yr;
  const Y = (v) => L.top + L.chartH - ((v - y0) / (y1 - y0)) * L.chartH;
  const right = L.W - L.padR;
  ctx.clearRect(0, 0, L.W, L.H);
  ctx.font = "10.5px -apple-system, sans-serif";
  // concept windows / changes
  ctx.fillStyle = C.line;
  for (const [a, b] of run.sch.windows || []) ctx.fillRect(L.x(a), L.top, L.x(b) - L.x(a), L.rowsTop + L.rows * L.rowH - L.top);
  ctx.strokeStyle = C.faint;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  for (const c of run.sch.changes) {
    ctx.moveTo(L.x(c) + 0.5, L.top);
    ctx.lineTo(L.x(c) + 0.5, L.rowsTop + L.rows * L.rowH);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  // y grid
  ctx.strokeStyle = C.line;
  ctx.fillStyle = C.muted;
  ctx.textAlign = "right";
  ctx.beginPath();
  for (let i = 0; i <= 2; i++) {
    const v = y0 + ((y1 - y0) * i) / 2;
    ctx.moveTo(L.padL, Y(v) + 0.5);
    ctx.lineTo(right, Y(v) + 0.5);
    ctx.fillText(run.cfg.task === "cls" ? Math.round(v * 100) + "%" : v.toFixed(2), L.padL - 4, Y(v) + 3.5);
  }
  ctx.stroke();
  // lines
  const line = (key, color, width, dash) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (const f of run.frames) {
      if (f[key] == null) continue;
      const x = L.x(f.t);
      const y = Y(clamp(f[key], y0, y1));
      if (!started) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      started = true;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line("baseMetric", C.faint, 1.5, [4, 3]);
  line("metric", C.accent, 2, []);
  // rows
  for (let k = 0; k < L.rows; k++) {
    const yy = L.rowsTop + k * L.rowH;
    ctx.fillStyle = C.line;
    ctx.fillRect(L.padL, yy + L.rowH / 2 - 0.5, right - L.padL, 1);
    ctx.fillStyle = C.warn;
    ctx.globalAlpha = 0.55;
    for (const w of run.warns[k]) ctx.fillRect(L.x(w.from), yy + 1, Math.max(1.5, L.x(w.to) - L.x(w.from)), L.rowH - 2);
    ctx.globalAlpha = 1;
    if (L.rowH >= 10 || k % 5 === 0) {
      ctx.fillStyle = C.muted;
      ctx.fillText("#" + (k + 1), L.padL - 4, yy + L.rowH - 0.5);
    }
  }
  ctx.fillStyle = C.drift;
  for (const e of run.swaps) ctx.fillRect(L.x(e.t) - 1, L.rowsTop + e.slot * L.rowH - 1, 2.5, L.rowH + 2);
  // x axis
  ctx.textAlign = "center";
  ctx.fillStyle = C.muted;
  const by = L.rowsTop + L.rows * L.rowH + 15;
  for (let i = 0; i <= 4; i++) ctx.fillText(fmtK((T * i) / 4), L.x((T * i) / 4), by);
  ctx.textAlign = "left";
  ctx.fillText("warning / swap per stage", L.padL, L.rowsTop - 4);
}

function renderTimeline() {
  if (!TL) return;
  const L = TL;
  const ctx = sizeCanvas(tl, L.W, L.H);
  ctx.clearRect(0, 0, L.W, L.H);
  const xp = L.x(frame().t);
  ctx.globalAlpha = 0.3;
  ctx.drawImage(tlLayer, 0, 0, L.W, L.H);
  ctx.globalAlpha = 1;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, xp, L.H);
  ctx.clip();
  ctx.drawImage(tlLayer, 0, 0, L.W, L.H);
  ctx.restore();
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(xp, L.top - 2);
  ctx.lineTo(xp, L.rowsTop + L.rows * L.rowH + 2);
  ctx.stroke();
  if (S.sel) {
    const yy = L.rowsTop + S.sel.slot * L.rowH;
    ctx.strokeStyle = C.accent;
    ctx.lineWidth = 1;
    ctx.strokeRect(L.padL - 0.5, yy - 0.5, L.W - L.padR - L.padL + 1, L.rowH + 1);
  }
}

function seekX(clientX) {
  const r = tl.getBoundingClientRect();
  const t = clamp(((clientX - r.left - TL.padL) / (TL.W - TL.padL - TL.padR)) * S.run.cfg.T, 0, S.run.cfg.T);
  seek(Math.round((t / S.run.cfg.T) * (S.run.frames.length - 1)));
}

// ---------------------------------------------------------------- drawer
const drawer = $("drawer");
function openDrawer(sel) {
  S.sel = sel;
  S.hoverLeaf = null;
  if (S.overlay === "upto" && !resolveSel(frame())) S.overlay = "ensemble";
  drawer.classList.add("open");
  drawerKey = "";
  render(false);
}
function closeDrawer() {
  drawer.classList.remove("open");
  if (S.sel) {
    S.sel = null;
    S.hoverLeaf = null;
    if (S.run) render(false);
  }
}

let drawerKey = "";
function renderDrawer() {
  if (!S.sel) return;
  const fr = frame();
  const r = resolveSel(fr);
  const { slot, id } = S.sel;
  const snap = r.snap;
  const key = [id, r.status, snap ? snap.n + ":" + snap.nodes.length : "", S.overlay, fr.t].join("|");
  if (key === drawerKey) return;
  drawerKey = key;
  $("dTitle").innerHTML = `#${slot + 1} · T${id}`;
  const pill = $("dPill");
  const labels = { active: "active", warn: "warning", bg: "background", retired: "retired", unborn: "not born yet" };
  pill.className = "pill " + r.status;
  pill.textContent = labels[r.status];
  const run = S.run;
  const eta = run.cfg.params.eta;
  const k = slot + 1;
  const life = lifeOf(slot, id);
  let lead = "";
  if (r.status === "active" || r.status === "warn")
    lead = `${k === 1 ? "첫 단계: 원래 타깃" : `F${sub(k - 1)}(x)까지의 잔차`}를 학습해 예측에 η·f${sub(k)}(x)로 더해집니다.${
      r.status === "warn" ? " 오차가 경고선을 넘어 백그라운드 트리를 함께 학습 중." : ""
    }`;
  else if (r.status === "bg") lead = `#${k} 단계의 경고 이후 함께 학습 중인 백그라운드 트리. drift가 확정되면 이 트리가 투입됩니다.`;
  else if (r.status === "retired") lead = `t=${fmtT(r.ev.t)}에 drift 감지로 교체되어 퇴역 (→ T${r.ev.newId}). 아래는 퇴역 직전 모습.`;
  else lead = `아직 생성되지 않은 트리입니다${life ? ` (t=${fmtT(life.bgFrom ?? life.from)}에 생성)` : ""}.`;

  let html = `<p class="lead">${lead}</p>`;
  if ((r.status === "active" || r.status === "warn") && fr.alts[slot])
    html += `<div class="bgnote" data-alt="${fr.alts[slot].id}">⟳ 백그라운드 T${fr.alts[slot].id} 학습 중 · n=${fmtK(fr.alts[slot].n)} · ${
      fr.alts[slot].leaves
    } leaves <span style="margin-left:auto">보기 →</span></div>`;
  if (snap) {
    const canUpto = r.status === "active" || r.status === "warn";
    if (S.overlay === "upto" && !canUpto) S.overlay = "ensemble";
    html += `<div class="dsec"><h3>Plot overlay</h3><button class="info" data-info="overlay">i</button></div>
      <div class="seg" id="ovl">
        <button data-v="ensemble" class="${S.overlay === "ensemble" ? "on" : ""}">Ensemble</button>
        <button data-v="tree" class="${S.overlay === "tree" ? "on" : ""}">This tree</button>
        ${canUpto ? `<button data-v="upto" class="${S.overlay === "upto" ? "on" : ""}">Up to #${k}</button>` : ""}
      </div>`;
    const inSlot = life ? (r.status === "bg" ? null : life.from) : null;
    const endT = r.status === "retired" ? r.ev.t : fr.t;
    const det = r.det;
    const ratio = det && det.es > 0 ? det.ef / det.es : null;
    html += `<div class="kv num" style="margin-top:12px">
      <div>born<b>t=${fmtT(snap.bornAt)}</b></div>
      <div>${r.status === "bg" ? "bg age" : "in slot"}<b>${fmtK(endT - (inSlot ?? snap.bornAt))}</b></div>
      <div>samples<b>${fmtK(snap.n)}</b></div>
      <div>leaves<b>${snap.leaves}</b></div>
      <div>depth<b>${snap.depth}</b></div>
      <div>last split<b>${snap.lastSplitAt == null ? "–" : "t=" + fmtT(snap.lastSplitAt)}</b></div>
      ${
        ratio != null
          ? `<div>error ratio<b>${
              det.cnt < run.cfg.params.minAge ? "warming up" : ratio.toFixed(2) + "×"
            }</b></div><div>fast err<b>${det.ef.toExponential(1)}</b></div><div>slow err<b>${det.es.toExponential(1)}</b></div>`
          : ""
      }
    </div>`;
    html += `<div class="dsec"><h3>Structure</h3><span class="muted" style="font-size:12px">잎에 마우스를 올리면 영역 표시</span></div>
      <div class="treebox">${treeSVG(snap, eta)}</div>`;
  } else {
    html += `<div class="empty-tree">시간을 앞으로 이동하면 나타납니다.</div>`;
  }
  html += `<div class="dsec"><h3>Slot #${k} history</h3><button class="info" data-info="history">i</button></div>${historyBar(slot, fr.t)}`;
  $("dBody").innerHTML = html;
}

function treeSVG(snap, eta) {
  const { pos, leaves, maxD } = layoutTree(snap);
  const sx = Math.max(46, 400 / Math.max(1, leaves));
  const sy = 58;
  const W = Math.max(400, leaves * sx + 10);
  const H = maxD * sy + 62;
  const X = (p) => 5 + (p + 0.5) * sx;
  const Y = (d) => 22 + d * sy;
  const N = snap.nodes;
  let edges = "";
  let nodes = "";
  for (let i = 0; i < N.length; i++) {
    const nd = N[i];
    const x = X(pos[i][0]);
    const y = Y(pos[i][1]);
    if (nd[0] >= 0) {
      for (const [c, lab] of [
        [nd[2], "≤"],
        [nd[3], ">"],
      ]) {
        const cx = X(pos[c][0]);
        const cy = Y(pos[c][1]);
        edges += `<path d="M${x},${y + 10} C${x},${y + 30} ${cx},${cy - 30} ${cx},${cy - 10}" fill="none" stroke="${C.line2}" stroke-width="1.3"/>`;
        edges += `<text x="${(x + cx) / 2 + (lab === "≤" ? -6 : 6)}" y="${(y + cy) / 2 + 2}" text-anchor="middle" style="fill:${
          C.muted
        };font-size:9.5px">${lab}</text>`;
      }
      const col = nd[0] === 0 ? C.f1 : C.f2;
      nodes += `<g><title>split on x${sub(nd[0] + 1)} at t=${fmtT(nd[7] ?? 0)} · n=${fmtK(nd[5])}</title>
        <rect x="${x - 31}" y="${y - 10}" width="62" height="20" rx="6" fill="${C.card}" stroke="${col}" stroke-width="1.5"/>
        <text x="${x}" y="${y + 3.5}" text-anchor="middle">x${sub(nd[0] + 1)} ≤ ${nd[1].toFixed(2)}</text></g>`;
    } else {
      const v = clamp((eta * nd[4]) / S.run.leafScale, -1, 1);
      nodes += `<g class="lf${S.hoverLeaf === i ? " hl" : ""}" data-leaf="${i}"><title>leaf · w=${nd[4].toFixed(3)} · η·w=${(eta * nd[4]).toFixed(
        3
      )} · n=${fmtK(nd[5])}</title>
        <circle cx="${x}" cy="${y}" r="9" fill="${css(divColor(v, 0.3 + 0.7 * Math.abs(v)))}" stroke="${C.card}" stroke-width="1.5"/>
        <text x="${x}" y="${y + 22}" text-anchor="middle">${(eta * nd[4]).toFixed(2)}</text>
        <text x="${x}" y="${y + 33}" text-anchor="middle" style="fill:${C.muted};font-size:9.5px">n ${fmtK(nd[5])}</text></g>`;
    }
  }
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${edges}${nodes}</svg>`;
}

function historyBar(slot, now) {
  const T = S.run.cfg.T;
  const pct = (t) => (t / T) * 100;
  const L = S.run.life[slot];
  const palette = [C.accent, C.f1, C.f2, C.pos];
  let html = `<div class="hist">`;
  L.forEach((l, i) => {
    const to = l.to ?? T;
    const col = palette[i % palette.length];
    if (l.bgFrom != null && l.bgFrom < l.from)
      html += `<button class="seg" data-id="${l.id}" style="left:${pct(l.bgFrom)}%;width:${pct(
        l.from - l.bgFrom
      )}%;background:${col};opacity:.35" title="T${l.id} background"></button>`;
    html += `<button class="seg num" data-id="${l.id}" style="left:${pct(l.from)}%;width:calc(${pct(to - l.from)}% - 2px);background:${col};${
      S.sel && S.sel.id === l.id ? "outline:2px solid " + C.ink + ";outline-offset:1px" : ""
    }" title="T${l.id}: t=${fmtT(l.from)}–${fmtT(to)}">T${l.id}</button>`;
  });
  html += `<div class="now" style="left:${pct(now)}%"></div></div>`;
  return html;
}

// ---------------------------------------------------------------- render / playback
function render(animate) {
  renderPlot();
  renderCards(animate);
  renderLog();
  renderStats();
  renderTimeline();
  renderDrawer();
}

function seek(fi) {
  fi = clamp(fi, 0, S.run.frames.length - 1);
  const prev = S.fi;
  S.fi = fi;
  const step = fi - prev;
  render(step > 0 && step <= 3);
}

let last = 0;
let acc = 0;
function loop(ts) {
  if (!S.playing) return;
  const dt = last ? Math.min(0.1, (ts - last) / 1000) : 0;
  last = ts;
  acc += dt * BASE_FPS * S.speed;
  if (acc >= 1) {
    const n = Math.floor(acc);
    acc -= n;
    if (S.fi >= S.run.frames.length - 1) {
      setPlaying(false);
      return;
    }
    seek(S.fi + n);
  }
  requestAnimationFrame(loop);
}

const ICON_PLAY = `<svg viewBox="0 0 16 16"><path d="M4 2v12l10-6z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 16 16"><path d="M3 2h3.5v12H3zM9.5 2H13v12H9.5z"/></svg>`;
function setPlaying(on) {
  S.playing = on;
  $("bPlay").innerHTML = on ? ICON_PAUSE : ICON_PLAY;
  if (on) {
    if (S.fi >= S.run.frames.length - 1) seek(0);
    last = 0;
    acc = 0;
    requestAnimationFrame(loop);
  }
}

// ---------------------------------------------------------------- controls
function fillScenarios() {
  const sel = $("scenario");
  sel.innerHTML = SCENARIOS[S.task].map((s) => `<option value="${s.id}">${s.name}</option>`).join("");
  sel.value = S.scenario[S.task];
  sel.title = SCENARIOS[S.task].find((s) => s.id === S.scenario[S.task]).desc;
}

function syncTask() {
  for (const b of $("task").children) b.classList.toggle("on", b.dataset.v === S.task);
}

function buildParams() {
  const box = $("prows");
  box.innerHTML = PDEF.map((d) => {
    if (d.bool)
      return `<div class="prow"><label><input type="checkbox" data-k="${d.k}" ${S.params[d.k] ? "checked" : ""}/> ${
        d.label
      } <button class="info" data-info="${d.k}">i</button></label></div>`;
    return `<div class="prow"><label>${d.label} <button class="info" data-info="${d.k}">i</button></label><output class="num" data-o="${d.k}"></output>
      <input type="range" data-k="${d.k}" min="${d.min}" max="${d.max}" step="${d.step}"/></div>`;
  }).join("");
  for (const d of PDEF) {
    const el = box.querySelector(`input[data-k="${d.k}"]`);
    if (d.bool) {
      el.addEventListener("change", () => {
        S.params[d.k] = el.checked;
        rerun();
      });
      continue;
    }
    const get = () => (d.k === "noise" ? S.noise[S.task] : d.k === "period" ? S.period : S.params[d.k]);
    const out = box.querySelector(`[data-o="${d.k}"]`);
    const show = (v) => (out.textContent = d.log ? v.toExponential(0) : d.step < 1 ? (+v).toFixed(2) : String(v));
    el.value = d.log ? Math.log10(get()) : get();
    show(get());
    let timer = 0;
    el.addEventListener("input", () => {
      const v = d.log ? Math.pow(10, +el.value) : +el.value;
      if (d.k === "noise") S.noise[S.task] = v;
      else if (d.k === "period") S.period = v;
      else S.params[d.k] = v;
      show(v);
      clearTimeout(timer);
      timer = setTimeout(() => rerun(), 120);
    });
  }
}

function placeNear(el, anchor, w) {
  const r = anchor.getBoundingClientRect();
  el.style.display = "block";
  const ew = el.offsetWidth || w;
  const eh = el.offsetHeight;
  let x = clamp(r.left + r.width / 2 - ew / 2, 8, window.innerWidth - ew - 8);
  let y = r.bottom + 8;
  if (y + eh > window.innerHeight - 8) y = Math.max(8, r.top - eh - 8);
  el.style.left = x + "px";
  el.style.top = y + "px";
}

function showInfo(btn) {
  const it = INFO[btn.dataset.info];
  if (!it) return;
  const pop = $("pop");
  if (pop.dataset.for === btn.dataset.info && pop.style.display === "block") {
    pop.style.display = "none";
    pop.dataset.for = "";
    return;
  }
  pop.innerHTML = `<h4>${it.title}</h4>${it.body}`;
  pop.dataset.for = btn.dataset.info;
  placeNear(pop, btn, 320);
}

function bind() {
  $("task").addEventListener("click", (e) => {
    const v = e.target.dataset.v;
    if (!v || v === S.task) return;
    S.task = v;
    syncTask();
    fillScenarios();
    buildParams();
    rerun(false);
  });
  $("scenario").addEventListener("change", (e) => {
    S.scenario[S.task] = e.target.value;
    fillScenarios();
    rerun(false);
  });
  $("drift").addEventListener("change", (e) => {
    S.drift = e.target.value;
    rerun(false);
  });
  $("btnParams").addEventListener("click", (e) => {
    e.stopPropagation();
    const p = $("params");
    if (p.classList.toggle("open")) placeNear(p, $("btnParams"), 300);
    else p.style.display = "";
  });
  $("reseed").addEventListener("click", () => {
    S.seed = (Math.random() * 1e9) | 0;
    rerun();
  });
  for (const b of document.querySelectorAll("[data-show]"))
    b.addEventListener("click", () => {
      const k = b.dataset.show;
      S.show[k] = !S.show[k];
      b.classList.toggle("on", S.show[k]);
      renderPlot();
    });

  document.addEventListener("click", (e) => {
    const info = e.target.closest(".info");
    if (info) {
      e.stopPropagation();
      showInfo(info);
      return;
    }
    if (!e.target.closest("#pop")) $("pop").style.display = "none";
    const p = $("params");
    if (p.classList.contains("open") && !e.target.closest("#params") && !e.target.closest("#btnParams")) {
      p.classList.remove("open");
      p.style.display = "";
    }
  });

  // drawer interactions (delegated)
  $("dClose").addEventListener("click", closeDrawer);
  $("dBody").addEventListener("click", (e) => {
    const o = e.target.closest("#ovl button");
    if (o) {
      S.overlay = o.dataset.v;
      drawerKey = "";
      render(false);
      return;
    }
    const alt = e.target.closest(".bgnote");
    if (alt) {
      openDrawer({ id: +alt.dataset.alt, slot: S.sel.slot });
      return;
    }
    const seg = e.target.closest(".hist .seg");
    if (seg) {
      const id = +seg.dataset.id;
      const slot = S.sel.slot;
      const l = lifeOf(slot, id);
      S.sel = { id, slot };
      // jump into the tree's lifetime if not visible now
      const r = resolveSel(frame());
      drawerKey = "";
      if (!r.snap) {
        const t = l.to != null ? l.to - 1 : l.from + 1;
        seek(Math.ceil((t / S.run.cfg.T) * (S.run.frames.length - 1)));
      } else render(false);
    }
  });
  $("dBody").addEventListener("mouseover", (e) => {
    const g = e.target.closest(".lf");
    const v = g ? +g.dataset.leaf : null;
    if (v !== S.hoverLeaf) {
      S.hoverLeaf = v;
      for (const el of $("dBody").querySelectorAll(".lf")) el.classList.toggle("hl", +el.dataset.leaf === v);
      renderPlot();
    }
  });
  $("dBody").addEventListener("mouseleave", () => {
    if (S.hoverLeaf != null) {
      S.hoverLeaf = null;
      for (const el of $("dBody").querySelectorAll(".lf")) el.classList.remove("hl");
      renderPlot();
    }
  });

  // log
  $("log").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-t]");
    if (!li) return;
    const t = +li.dataset.t;
    setPlaying(false);
    S.fi = clamp(Math.ceil(((t + 1) / S.run.cfg.T) * (S.run.frames.length - 1)), 0, S.run.frames.length - 1);
    openDrawer({ id: +li.dataset.id, slot: +li.dataset.slot });
  });

  // plot hover
  const tip = $("tip");
  plot.addEventListener("mousemove", (e) => {
    const r = plot.getBoundingClientRect();
    const x1 = LO + ((e.clientX - r.left) / r.width) * (HI - LO);
    const x2 = HI - ((e.clientY - r.top) / r.height) * (HI - LO);
    const fr = frame();
    const eta = S.run.cfg.params.eta;
    let F = 0;
    for (const tr of fr.trees) F += eta * predictSnap(tr, x1, x2);
    let html =
      `<span class="muted">(${x1.toFixed(2)}, ${x2.toFixed(2)})</span><br>` +
      (S.run.cfg.task === "cls" ? `p(y=1) = <b>${sigmoid(F).toFixed(3)}</b>` : `ŷ = <b>${F.toFixed(3)}</b>`);
    const rs = resolveSel(fr);
    let leaf = null;
    if (rs && rs.snap) {
      leaf = leafIndexSnap(rs.snap, x1, x2);
      html += `<br>T${S.sel.id} leaf: η·w = <b>${(eta * rs.snap.nodes[leaf][4]).toFixed(3)}</b>`;
    }
    tip.innerHTML = html;
    tip.style.display = "block";
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    tip.style.left = Math.min(px + 14, r.width - tip.offsetWidth - 4) + "px";
    tip.style.top = (py > r.height - 70 ? py - tip.offsetHeight - 10 : py + 14) + "px";
    if (leaf !== S.hoverLeaf && rs && rs.snap) {
      S.hoverLeaf = leaf;
      for (const el of $("dBody").querySelectorAll(".lf")) el.classList.toggle("hl", +el.dataset.leaf === leaf);
      renderPlot();
    }
  });
  plot.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    if (S.hoverLeaf != null) {
      S.hoverLeaf = null;
      for (const el of $("dBody").querySelectorAll(".lf")) el.classList.remove("hl");
      renderPlot();
    }
  });

  // timeline scrubbing
  let drag = false;
  tl.addEventListener("pointerdown", (e) => {
    drag = true;
    tl.setPointerCapture(e.pointerId);
    setPlaying(false);
    seekX(e.clientX);
  });
  tl.addEventListener("pointermove", (e) => drag && seekX(e.clientX));
  tl.addEventListener("pointerup", () => (drag = false));
  $("scrub").addEventListener("input", (e) => {
    setPlaying(false);
    seek(+e.target.value);
  });

  // transport
  $("bPlay").addEventListener("click", () => setPlaying(!S.playing));
  $("bStart").addEventListener("click", () => {
    setPlaying(false);
    seek(0);
  });
  $("bBack").addEventListener("click", () => {
    setPlaying(false);
    seek(S.fi - 1);
  });
  $("bFwd").addEventListener("click", () => {
    setPlaying(false);
    seek(S.fi + 1);
  });
  $("speed").addEventListener("change", (e) => (S.speed = +e.target.value));
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea")) return;
    if (e.key === " ") {
      e.preventDefault();
      setPlaying(!S.playing);
    } else if (e.key === "ArrowRight") {
      setPlaying(false);
      seek(S.fi + (e.shiftKey ? 10 : 1));
    } else if (e.key === "ArrowLeft") {
      setPlaying(false);
      seek(S.fi - (e.shiftKey ? 10 : 1));
    } else if (e.key === "Escape") {
      closeDrawer();
      $("pop").style.display = "none";
    }
  });

  // resize & theme
  let rt = 0;
  const onResize = () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      layoutTimeline();
      render(false);
    }, 60);
  };
  new ResizeObserver(onResize).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    readColors();
    legendKey = "";
    drawerKey = "";
    layoutTimeline();
    render(false);
  });
}

export function start() {
  readColors();
  syncTask();
  fillScenarios();
  buildParams();
  bind();
  setPlaying(false);
  rerun(false);
  const mt = location.hash.match(/task=(cls|reg)/);
  if (mt && mt[1] !== S.task) {
    S.task = mt[1];
    syncTask();
    fillScenarios();
    buildParams();
    rerun(false);
  }
  const m = location.hash.match(/t=(\d+)/);
  if (m) seek(Math.round((+m[1] / S.run.cfg.T) * (S.run.frames.length - 1)));
  else setPlaying(true);
  const ms = location.hash.match(/sel=(\d+)/);
  if (ms && m) {
    const k = clamp(+ms[1] - 1, 0, S.run.S - 1);
    openDrawer({ id: frame().trees[k].id, slot: k });
  }
}
