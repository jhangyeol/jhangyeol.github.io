import { SCENARIOS, loadReal } from "./data.js";
import { DEFAULTS, predictSnap, leafIndexSnap } from "./sgbt.js";
import { runSimulation } from "./sim.js";
import { INFO } from "./info.js";

const $ = (id) => document.getElementById(id);
const LO = -1.2;
const HI = 1.2;
const GRID = 150;
const TGRID = 90;
const POINT_WINDOW = 320;
const BASE_FPS = 15;
const MAX_LEN = 30000;
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
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const FEAT_PALETTE = ["#109a8e", "#8a5cf0", "#c99a06", "#d6408a", "#3a86ff", "#7a8b10", "#a0522d", "#0aa2c0", "#b04ad8", "#5b6b7f"];

const PDEF = [
  { k: "length", label: "Stream length", min: 2000, max: MAX_LEN, step: 1000, cfg: true },
  { k: "period", label: "Concept period", min: 500, max: 10000, step: 250, cfg: true, synthOnly: true },
  { k: "noise", label: "Noise", min: 0, max: 0.3, step: 0.01, cfg: true, synthOnly: true },
  { k: "trees", label: "Trees (S)", min: 1, max: 20, step: 1 },
  { k: "eta", label: "Learning rate η", min: 0.05, max: 1, step: 0.05 },
  { k: "grace", label: "Grace period", min: 20, max: 300, step: 10 },
  { k: "delta", label: "Split confidence δ", min: -4, max: -1, step: 0.5, log: true },
  { k: "tau", label: "Tie threshold τ", min: 0.01, max: 0.3, step: 0.01 },
  { k: "lambda", label: "L2 λ", min: 0, max: 5, step: 0.1 },
  { k: "maxDepth", label: "Max depth", min: 1, max: 8, step: 1 },
  { k: "replace", label: "Tree replacement", bool: true },
  { k: "sensitivity", label: "Detector sensitivity", min: 0.5, max: 2, step: 0.1 },
];

const S = {
  task: "cls",
  scenario: { cls: "moons", reg: "rpoly" },
  drift: "abrupt",
  noise: { cls: 0.05, reg: 0.1 },
  period: 1500,
  lengthSyn: 6000,
  lengthReal: MAX_LEN,
  seed: 7,
  params: { ...DEFAULTS },
  axes: {},
  run: null,
  fi: 0,
  playing: false,
  speed: 1,
  show: { boundary: true, truth: true, points: true },
  sel: null, // { id, slot }
  overlay: "ensemble",
  hoverLeaf: null,
};

const scen = () => SCENARIOS[S.task].find((s) => s.id === S.scenario[S.task]);
const axesOf = (sc) => S.axes[sc.id] || sc.axes || [0, 1];

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

function divColor(v, t) {
  const c = v < 0 ? C.negRGB : C.posRGB;
  const m = C.midRGB;
  return [m[0] + (c[0] - m[0]) * t, m[1] + (c[1] - m[1]) * t, m[2] + (c[2] - m[2]) * t];
}
const css = (rgb, a = 1) => `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${a})`;
const featColor = (f) => (S.run && S.run.d === 2 ? [C.f1, C.f2][f] : FEAT_PALETTE[f % FEAT_PALETTE.length]);

function fmtRaw(feat, v) {
  const r = feat.raw(v);
  if (feat.fmt) return feat.fmt(r);
  const a = Math.abs(r);
  if (a >= 10000) return (r / 1000).toFixed(0) + "k";
  if (a >= 100) return r.toFixed(0);
  if (a >= 10) return r.toFixed(1);
  return r.toFixed(2);
}

// ---------------------------------------------------------------- run
let runToken = 0;
async function rerun(keep = true) {
  const sc = scen();
  const tok = ++runToken;
  const n0 = S.run ? S.run.frames.length - 1 : 1;
  const ratio = keep && S.run ? S.fi / n0 : 0;
  let real = null;
  if (sc.real) {
    setStatus("데이터 불러오는 중…");
    try {
      real = await loadReal(sc);
    } catch (e) {
      setStatus("데이터를 불러오지 못했습니다: " + e.message);
      return;
    }
    if (tok !== runToken) return;
  }
  setStatus("");
  const T = sc.real ? Math.min(S.lengthReal, real.n) : S.lengthSyn;
  const run = runSimulation(
    {
      task: S.task,
      scenario: sc.id,
      drift: sc.fixedDrift || S.drift,
      T,
      period: S.period,
      noise: S.noise[S.task],
      every: Math.max(10, Math.round(T / 300)),
      seed: S.seed,
      params: { ...S.params },
    },
    sc,
    real
  );
  derive(run);
  S.run = run;
  S.fi = Math.round(ratio * (run.frames.length - 1));
  S.sel = null;
  S.overlay = "ensemble";
  closeDrawer();
  $("scrub").max = run.frames.length - 1;
  syncDatasetUI();
  buildCards();
  layoutTimeline();
  render(false);
  return run;
}

function setStatus(msg) {
  const el = $("status");
  el.textContent = msg;
  el.style.display = msg ? "flex" : "none";
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
      const span = { from: e.t, to: null };
      run.warns[e.slot].push(span);
      open.set(e.slot, span);
    } else if (e.type === "cancel" || e.type === "swap") {
      const span = open.get(e.slot);
      if (span) {
        span.to = e.t;
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
  const vals = run.frames.slice(1).flatMap((f) => [f.metric, f.baseMetric, f.cumMetric, f.cumBase]);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  run.yr = run.cfg.task === "cls" ? [Math.max(0, Math.floor(lo * 10) / 10), 1] : [0, Math.ceil(hi * 11) / 10];
  run.sliceCache = new Map();
}

const frame = () => S.run.frames[S.fi];
const lifeOf = (slot, id) => S.run.life[slot].find((l) => l.id === id);

// first frame whose time is after sample t (so events at t are included)
function frameAfter(t) {
  const F = S.run.frames;
  let lo = 0;
  let hi = F.length - 1;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (F[m].t > t) hi = m;
    else lo = m + 1;
  }
  return lo;
}
function frameNear(t) {
  const i = frameAfter(t);
  const F = S.run.frames;
  return i > 0 && Math.abs(F[i - 1].t - t) < Math.abs(F[i].t - t) ? i - 1 : i;
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

// ---------------------------------------------------------------- slice (for d > 2)
function sliceAt(fi) {
  const run = S.run;
  if (run.sliceCache.has(fi)) return run.sliceCache.get(fi);
  const d = run.d;
  const t1 = Math.max(1, run.frames[fi].t);
  const t0 = Math.max(0, t1 - POINT_WINDOW);
  const out = new Array(d);
  const buf = [];
  for (let f = 0; f < d; f++) {
    buf.length = 0;
    for (let t = t0; t < t1; t++) buf.push(run.xs[t * d + f]);
    buf.sort((a, b) => a - b);
    out[f] = buf.length ? buf[buf.length >> 1] : 0;
  }
  run.sliceCache.set(fi, out);
  return out;
}

// Leaf regions of a tree inside the current 2-D slice (axes a, b; other features fixed at slice).
function regionsOf(snap, axes, slice) {
  const [a, b] = axes;
  const out = new Map();
  const walk = (i, x0, x1, y0, y1) => {
    const nd = snap.nodes[i];
    if (nd[0] < 0) {
      if (x1 > x0 && y1 > y0) out.set(i, [x0, x1, y0, y1]);
      return;
    }
    const f = nd[0];
    const th = nd[1];
    if (f === a) {
      walk(nd[2], x0, Math.min(x1, th), y0, y1);
      walk(nd[3], Math.max(x0, th), x1, y0, y1);
    } else if (f === b) {
      walk(nd[2], x0, x1, y0, Math.min(y1, th));
      walk(nd[3], x0, x1, Math.max(y0, th), y1);
    } else walk(slice[f] <= th ? nd[2] : nd[3], x0, x1, y0, y1);
  };
  walk(0, LO, HI, LO, HI);
  return out;
}

// ---------------------------------------------------------------- plot
const plot = $("plot");
const hm = document.createElement("canvas");
hm.width = hm.height = GRID;
const hctx = hm.getContext("2d");
let gridCache = { key: "" };
let truthCache = { key: "" };

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

function overlaySpec(fr) {
  const r = resolveSel(fr);
  if (S.sel && r && r.snap && S.overlay === "tree") return { kind: "tree", trees: [r.snap], key: "t" + r.snap.id + ":" + r.snap.n };
  if (S.sel && r && r.snap && S.overlay === "upto" && (r.status === "active" || r.status === "warn"))
    return { kind: "upto", trees: fr.trees.slice(0, S.sel.slot + 1), key: "u" + S.sel.slot };
  return { kind: "ens", trees: fr.trees, key: "e" };
}

function baseVec() {
  return S.run.d > 2 ? sliceAt(S.fi).slice() : [0, 0];
}

function gridValues(spec, axes) {
  const key = [S.fi, spec.key, axes.join(",")].join("|");
  if (gridCache.key === key && gridCache.run === S.run) return gridCache.vals;
  const N = GRID;
  const eta = S.run.cfg.params.eta;
  const F = new Float32Array(N * N);
  const v = baseVec();
  const [a, b] = axes;
  for (const tr of spec.trees) {
    for (let j = 0; j < N; j++) {
      v[b] = cellY(j, N);
      for (let i = 0; i < N; i++) {
        v[a] = cellX(i, N);
        F[j * N + i] += eta * predictSnap(tr, v);
      }
    }
  }
  gridCache = { key, vals: F, run: S.run };
  return F;
}

function truthValues(phase, axes) {
  const sc = S.run.sc;
  const N = TGRID;
  const key = [phase.toFixed(3), axes.join(","), S.run.d > 2 ? S.fi : ""].join("|");
  if (truthCache.key === key && truthCache.run === S.run) return truthCache.vals;
  const out = new Float32Array(N * N);
  const v = baseVec();
  const [a, b] = axes;
  for (let j = 0; j < N; j++) {
    v[b] = cellY(j, N);
    for (let i = 0; i < N; i++) {
      v[a] = cellX(i, N);
      out[j * N + i] = sc.truthVec(v, phase);
    }
  }
  truthCache = { key, vals: out, run: S.run };
  return out;
}

// marching squares on a cell-centre grid
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
  const sc = run.sc;
  const axes = axesOf(sc);
  const [a, b] = axes;
  const W = plot.parentElement.clientWidth;
  const ctx = sizeCanvas(plot, W, W);
  const toPx = (x) => ((x - LO) / (HI - LO)) * W;
  const toPy = (y) => ((HI - y) / (HI - LO)) * W;
  const isCls = run.cfg.task === "cls";
  ctx.clearRect(0, 0, W, W);
  ctx.fillStyle = C.card;
  ctx.fillRect(0, 0, W, W);

  const spec = overlaySpec(fr);
  const F = gridValues(spec, axes);
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

  // grid
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
  if (S.show.truth && sc.truthVec) {
    const ph = run.sch.display(Math.max(0, fr.t - 1));
    const tv = truthValues(ph, axes);
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = C.ink;
    if (isCls) {
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.7;
      contour(ctx, tv, TGRID, 0.5, W);
    } else {
      ctx.lineWidth = 1;
      ctx.globalAlpha = 0.45;
      for (const l of regLevels()) contour(ctx, tv, TGRID, l, W);
    }
    ctx.globalAlpha = 1;
    ctx.setLineDash([]);
  }
  // selected tree partition (within the slice)
  const r = resolveSel(fr);
  if (r && r.snap) {
    const regs = regionsOf(r.snap, axes, baseVec());
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
  if (S.show.points) {
    const d = run.d;
    const t1 = fr.t;
    const t0 = Math.max(0, t1 - POINT_WINDOW);
    const rad = W < 420 ? 2.4 : 3.1;
    for (let t = t0; t < t1; t++) {
      const al = 0.18 + 0.82 * ((t - t0 + 1) / POINT_WINDOW) ** 1.4;
      // tiny deterministic jitter so quantized / discrete features don't stack exactly
      const jx = d > 2 ? (((t * 7919) % 97) / 97 - 0.5) * 0.012 : 0;
      const jy = d > 2 ? (((t * 104729) % 89) / 89 - 0.5) * 0.012 : 0;
      const x = toPx(run.xs[t * d + a] + jx);
      const y = toPy(run.xs[t * d + b] + jy);
      const yv = run.ys[t];
      const col = isCls ? (yv > 0.5 ? C.posRGB : C.negRGB) : divColor(yv / run.vmax, Math.min(1, Math.abs(yv / run.vmax)) * 0.85 + 0.15);
      ctx.globalAlpha = al;
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
  // axis names + raw ticks
  const fa = sc.features[a];
  const fb = sc.features[b];
  ctx.font = "10.5px -apple-system, sans-serif";
  ctx.fillStyle = C.muted;
  ctx.textAlign = "center";
  for (const g of [-1, 0, 1]) ctx.fillText(fmtRaw(fa, g), toPx(g), W - 5);
  ctx.textAlign = "left";
  for (const g of [-1, 0, 1]) ctx.fillText(fmtRaw(fb, g), 4, toPy(g) - 4);
  ctx.font = "600 11px -apple-system, sans-serif";
  ctx.fillStyle = C.ink;
  ctx.textAlign = "right";
  ctx.fillText(fa.name + " →", W - 6, W - 18);
  ctx.save();
  ctx.translate(16, 8);
  ctx.rotate(Math.PI / 2);
  ctx.textAlign = "left";
  ctx.fillText(fb.name + " →", 0, 0);
  ctx.restore();
  ctx.textAlign = "left";

  renderLegend(spec, treeScale);
}

let legendKey = "";
function renderLegend(spec, treeScale) {
  const isCls = S.run.cfg.task === "cls";
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
  const truth = S.run.sc.truthVec ? `<span class="key"><i class="dash"></i>true</span>` : "";
  const key = [left, right, mid, spec.kind, truth, C.card].join("|");
  if (key === legendKey) return;
  legendKey = key;
  $("legend").innerHTML =
    `<span class="num">${left}</span><span class="grad" style="background:linear-gradient(90deg, ${C.neg}, ${C.card}, ${C.pos})"></span><span class="num">${right}</span>
    <span class="muted">${mid}</span><span class="key"><i></i>model</span>${truth}`;
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
    } else {
      ctx.arc(X(pos[i][0]), Y(pos[i][1]), r * 0.8, 0, Math.PI * 2);
      ctx.fillStyle = featColor(nd[0]);
    }
    ctx.fill();
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
        <div class="meter" title="drift detector"><div class="fill"></div><div class="tick w"></div><div class="tick d"></div></div>
      </div>
      <div class="alt" title="백그라운드 트리 (클릭하여 보기)"><canvas></canvas><span class="num"></span></div>`;
    el.querySelector(".tcard").addEventListener("click", () => openDrawer({ id: frame().trees[k].id, slot: k }));
    el.querySelector(".alt").addEventListener("click", (e) => {
      e.stopPropagation();
      const fr = frame();
      if (fr.alts[k]) openDrawer({ id: fr.alts[k].id, slot: k });
    });
    box.appendChild(el);
    slots.push(el);
  }
}

// detector level: 1.0 = drift line, 0.5 = warning line (both the ratio and the z-score must pass)
function detLevel(d, p) {
  if (!d || !(d.es > 0)) return 0;
  const ratio = (d.ef / d.es - 1) / (0.9 / p.sensitivity);
  const z = (d.z || 0) / ((2 * p.zWarn) / p.sensitivity);
  return Math.max(0, Math.min(ratio, z));
}

function renderCards(animate) {
  const fr = frame();
  const p = S.run.cfg.params;
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
    el.classList.toggle("fresh", since > 0 && fr.t - since < Math.max(400, S.run.cfg.T / 20));
    const d = fr.det[k];
    const warn = d.state === "warn";
    el.classList.toggle("warn", warn);
    el.classList.toggle("sel", !!S.sel && S.sel.slot === k);
    drawMini(card.querySelector("canvas"), tr);
    const m = el.querySelector(".meter");
    const cold = !p.replace || d.cnt < p.minAge;
    m.classList.toggle("cold", cold);
    const lv = detLevel(d, p);
    const f = m.querySelector(".fill");
    f.style.width = (cold ? 0 : clamp(lv / 1.25, 0, 1) * 100) + "%";
    f.style.background = lv >= 1 ? C.drift : lv >= 0.5 ? C.warn : C.ok;
    m.querySelector(".w").style.cssText = `left:40%;background:${C.warn}`;
    m.querySelector(".d").style.cssText = `left:80%;background:${C.drift}`;
    const altEl = el.querySelector(".alt");
    if (warn && fr.alts[k]) {
      const alt = fr.alts[k];
      drawMini(altEl.querySelector("canvas"), alt, { small: true, dashed: true });
      altEl.querySelector("span").textContent = `bg T${alt.id} · ${fmtK(alt.n)}`;
    }
  }
}

// ---------------------------------------------------------------- log & stats
let logKey = "";
function renderLog() {
  const t = frame().t;
  const list = S.run.swaps.filter((e) => e.t < t);
  $("swapCount").textContent = `${list.length} / ${S.run.swaps.length}`;
  const key = S.run.cfg.seed + ":" + list.length + ":" + S.run.frames.length + ":" + S.run.swaps.length + ":" + S.run.sc.id;
  if (key === logKey) return;
  logKey = key;
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

function conceptLabel(t) {
  const run = S.run;
  const sc = run.sc;
  if (sc.real) return "Real stream";
  if ((sc.fixedDrift || run.cfg.drift) === "none") return "Stationary";
  const ph = run.sch.display(Math.max(0, t - 1));
  const i = Math.floor(ph + 1e-6);
  const frac = ph - i;
  const name = sc.conceptName ? ` · ${sc.conceptName(i)}` : "";
  return frac > 0.02 ? `Concept ${i + 1} → ${i + 2}` : `Concept ${i + 1}${name}`;
}

function renderStats() {
  const fr = frame();
  const isCls = S.run.cfg.task === "cls";
  const f = (v) => (v == null ? "–" : isCls ? (v * 100).toFixed(1) + "%" : v.toFixed(3));
  const m = isCls ? "Accuracy" : "RMSE";
  const swaps = S.run.swaps.filter((e) => e.t < fr.t).length;
  $("stats").innerHTML = `<div class="st"><span>${m} · last 200</span><b>${f(fr.metric)}</b><em>w/o replacement ${f(fr.baseMetric)}</em></div>
    <div class="st"><span>${m} · overall</span><b>${f(fr.cumMetric)}</b><em>w/o replacement ${f(fr.cumBase)}</em></div>
    <div class="st sm"><span>Swaps</span><b>${swaps}</b><em>of ${S.run.swaps.length}</em></div>
    <div class="st sm"><span>Leaves</span><b>${fr.trees.reduce((s, t) => s + t.leaves, 0)}</b><em>&nbsp;</em></div>`;
  $("tlabel").textContent = `t = ${fmtT(fr.t)} / ${fmtT(S.run.cfg.T)}`;
  $("scrub").value = S.fi;
  const lab = conceptLabel(fr.t);
  const el = $("concept");
  if (el.textContent !== lab) {
    if (S.playing && el.textContent && !S.run.sc.real) {
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
  if (!S.run) return;
  const W = tl.clientWidth || 800;
  const S_ = S.run.S;
  const rowH = S_ <= 12 ? 11 : 6;
  const L = { W, padL: 34, padR: 8, top: 8, chartH: 110, gap: 22, rowH, rows: S_ };
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
  const bottom = L.rowsTop + L.rows * L.rowH;
  ctx.clearRect(0, 0, L.W, L.H);
  ctx.font = "10.5px -apple-system, sans-serif";
  ctx.fillStyle = C.line;
  for (const [a, b] of run.sch.windows || []) ctx.fillRect(L.x(a), L.top, L.x(b) - L.x(a), bottom - L.top);
  ctx.strokeStyle = C.faint;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  for (const c of run.sch.changes) {
    ctx.moveTo(L.x(c) + 0.5, L.top);
    ctx.lineTo(L.x(c) + 0.5, bottom);
  }
  ctx.stroke();
  ctx.setLineDash([]);
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
  const line = (key, color, width, dash, alpha = 1) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.globalAlpha = alpha;
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
    ctx.globalAlpha = 1;
  };
  line("cumBase", C.faint, 1.2, [1.5, 2.5]);
  line("cumMetric", C.accent, 1.2, [1.5, 2.5], 0.8);
  line("baseMetric", C.faint, 1.5, [4, 3]);
  line("metric", C.accent, 2, []);
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
      ctx.fillText("#" + (k + 1), L.padL - 4, yy + L.rowH - 1);
    }
  }
  ctx.fillStyle = C.drift;
  for (const e of run.swaps) ctx.fillRect(L.x(e.t) - 1, L.rowsTop + e.slot * L.rowH - 1, 2.5, L.rowH + 2);
  ctx.textAlign = "center";
  ctx.fillStyle = C.muted;
  for (let i = 0; i <= 4; i++) ctx.fillText(fmtK((T * i) / 4), L.x((T * i) / 4), bottom + 15);
  ctx.textAlign = "left";
  ctx.fillText("warning / swap per stage", L.padL, L.rowsTop - 5);
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
  seek(frameNear(t));
}

// ---------------------------------------------------------------- drawer
const drawer = $("drawer");
const TV = { k: 1, tx: 0, ty: 0, fit: true, W: 1, H: 1 };
let drawerKey = "";
let treeKey = "";

function openDrawer(sel) {
  if (!S.sel || S.sel.id !== sel.id) TV.fit = true;
  S.sel = sel;
  S.hoverLeaf = null;
  drawer.classList.add("open");
  drawerKey = "";
  treeKey = "";
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
  const k = slot + 1;
  const life = lifeOf(slot, id);
  let lead = "";
  if (r.status === "active" || r.status === "warn")
    lead = `${k === 1 ? "첫 단계: 원래 타깃" : `F${sub(k - 1)}(x)까지의 잔차`}를 학습해 예측에 η·f${sub(k)}(x)로 더해집니다.${
      r.status === "warn" ? " 오차가 경고선을 넘어 백그라운드 트리를 함께 학습 중." : ""
    }`;
  else if (r.status === "bg") lead = `#${k} 단계의 경고 이후 함께 학습 중인 백그라운드 트리. drift가 확정되면 이 트리가 투입됩니다.`;
  else if (r.status === "retired") lead = `t=${fmtT(r.ev.t)}에 drift 감지로 교체되어 퇴역 (→ T${r.ev.newId}). 아래는 퇴역 직전 모습.`;
  else lead = `아직 생성되지 않은 트리입니다${life ? ` (t=${fmtT(life.bgFrom ?? life.from)}에 생성)` : ""}. 시간을 앞으로 이동하면 나타납니다.`;

  let html = `<p class="lead">${lead}</p>`;
  const canUpto = r.status === "active" || r.status === "warn";
  if (canUpto && fr.alts[slot])
    html += `<div class="bgnote" data-alt="${fr.alts[slot].id}">⟳ 백그라운드 T${fr.alts[slot].id} 학습 중 · n=${fmtK(fr.alts[slot].n)} · ${
      fr.alts[slot].leaves
    } leaves <span style="margin-left:auto">보기 →</span></div>`;
  if (S.overlay === "upto" && !canUpto) S.overlay = "ensemble";
  html += `<div class="ovl-row"><div class="seg" id="ovl">
      <button data-v="ensemble" class="${S.overlay === "ensemble" ? "on" : ""}">Ensemble</button>
      <button data-v="tree" class="${S.overlay === "tree" ? "on" : ""}" ${snap ? "" : "disabled"}>This tree</button>
      <button data-v="upto" class="${S.overlay === "upto" ? "on" : ""}" ${canUpto ? "" : "disabled"}>Up to #${k}</button>
    </div><button class="info" data-info="overlay">i</button></div>`;
  const det = r.det;
  const p = run.cfg.params;
  const dash = "–";
  const inSlot = snap && life && r.status !== "bg" ? life.from : snap ? snap.bornAt : null;
  const endT = r.status === "retired" ? r.ev.t : fr.t;
  const warming = det && det.cnt < p.minAge;
  html += `<div class="kv num">
    <div>born<b>${snap ? "t=" + fmtT(snap.bornAt) : dash}</b></div>
    <div>${r.status === "bg" ? "bg age" : "in slot"}<b>${snap ? fmtK(endT - inSlot) : dash}</b></div>
    <div>samples<b>${snap ? fmtK(snap.n) : dash}</b></div>
    <div>leaves<b>${snap ? snap.leaves : dash}</b></div>
    <div>depth<b>${snap ? snap.depth : dash}</b></div>
    <div>last split<b>${snap && snap.lastSplitAt != null ? "t=" + fmtT(snap.lastSplitAt) : dash}</b></div>
    <div>error ratio<b>${det ? (warming ? "warming" : (det.ef / det.es).toFixed(2) + "×") : dash}</b></div>
    <div>z-score<b>${det && !warming ? (det.z || 0).toFixed(1) : dash}</b></div>
    <div>detector<b>${det && !warming ? Math.round(detLevel(det, p) * 100) + "%" : dash}</b></div>
  </div>`;
  $("dInfo").innerHTML = html;
  const used = snap ? [...new Set(snap.nodes.filter((n) => n[0] >= 0).map((n) => n[0]))].sort((a, b) => a - b) : [];
  $("dFeat").innerHTML = used
    .map((f) => `<span class="fchip"><i style="background:${featColor(f)}"></i>${esc(run.sc.features[f].name)}</span>`)
    .join("");
  renderTree(snap);
  $("dHist").innerHTML = `<div class="dsec"><h3>Slot #${k} history</h3><button class="info" data-info="history">i</button></div>${historyBar(
    slot,
    fr.t
  )}`;
}

function renderTree(snap) {
  const empty = $("tEmpty");
  const g = $("tg");
  if (!snap) {
    g.innerHTML = "";
    empty.style.display = "block";
    treeKey = "";
    return;
  }
  empty.style.display = "none";
  const box = $("tbox");
  const cw = box.clientWidth || 400;
  const ch = box.clientHeight || 400;
  const eta = S.run.cfg.params.eta;
  // in fit mode pick whichever orientation fills the panel better
  let orient = TV.orient || "tb";
  if (TV.fit) {
    const fitK = (o) => {
      const { W, H } = treeSize(snap, o);
      return Math.min((cw - 16) / W, (ch - 16) / H);
    };
    orient = fitK("lr") > fitK("tb") * 1.05 ? "lr" : "tb";
  }
  const key = snap.id + ":" + snap.n + ":" + snap.nodes.length + ":" + orient;
  if (key !== treeKey) {
    treeKey = key;
    const { svg, W, H } = treeSVG(snap, eta, orient);
    g.innerHTML = svg;
    TV.W = W;
    TV.H = H;
    TV.orient = orient;
  }
  for (const el of g.querySelectorAll(".lf")) el.classList.toggle("hl", +el.dataset.leaf === S.hoverLeaf);
  applyTV();
}

function applyTV() {
  const box = $("tbox");
  const cw = box.clientWidth;
  const ch = box.clientHeight;
  if (TV.fit && cw && ch) {
    TV.k = Math.min((cw - 16) / TV.W, (ch - 16) / TV.H, 1.6);
    TV.tx = (cw - TV.W * TV.k) / 2;
    TV.ty = Math.max(8, (ch - TV.H * TV.k) / 2);
  }
  $("tg").setAttribute("transform", `translate(${TV.tx},${TV.ty}) scale(${TV.k})`);
  $("tZoom").textContent = Math.round(TV.k * 100) + "%";
}

function zoomAt(mx, my, f) {
  const k = clamp(TV.k * f, 0.03, 4);
  TV.tx = mx - ((mx - TV.tx) * k) / TV.k;
  TV.ty = my - ((my - TV.ty) * k) / TV.k;
  TV.k = k;
  TV.fit = false;
  applyTV();
}

// Geometry shared by size estimation and drawing. Internal nodes are two-line boxes (feature / threshold).
function treeGeom(snap, orient) {
  const feats = S.run.sc.features;
  const N = snap.nodes;
  const { pos, leaves, maxD } = layoutTree(snap);
  const lines = N.map((nd) => (nd[0] >= 0 ? [feats[nd[0]].name, "≤ " + fmtRaw(feats[nd[0]], nd[1])] : null));
  const boxW = (i) => Math.max(...lines[i].map((s) => s.length)) * 6.3 + 14;
  const maxBox = Math.max(40, ...N.map((nd, i) => (nd[0] >= 0 ? boxW(i) : 0)));
  let X;
  let Y;
  let W;
  let H;
  if (orient === "lr") {
    const colW = maxBox + 34;
    const rowH = 30;
    X = (i) => 10 + maxBox / 2 + pos[i][1] * colW;
    Y = (i) => 16 + (pos[i][0] + 0.5) * rowH;
    W = 10 + maxBox / 2 + maxD * colW + 96;
    H = leaves * rowH + 32;
  } else {
    const sx = 52;
    const sy = 74;
    X = (i) => 10 + (pos[i][0] + 0.5) * sx;
    Y = (i) => 20 + pos[i][1] * sy;
    W = Math.max(leaves * sx + 20, maxBox + 20);
    H = maxD * sy + 60;
  }
  return { N, lines, boxW, X, Y, W, H };
}

function treeSize(snap, orient) {
  const { W, H } = treeGeom(snap, orient);
  return { W, H };
}

function treeSVG(snap, eta, orient) {
  const { N, lines, boxW, X, Y, W, H } = treeGeom(snap, orient);
  const lr = orient === "lr";
  let edges = "";
  let nodes = "";
  for (let i = 0; i < N.length; i++) {
    const nd = N[i];
    const x = X(i);
    const y = Y(i);
    if (nd[0] >= 0) {
      const w = boxW(i);
      for (const [c, lab] of [
        [nd[2], "≤"],
        [nd[3], ">"],
      ]) {
        const cx = X(c);
        const cy = Y(c);
        let d;
        let lx;
        let ly;
        if (lr) {
          const sx0 = x + w / 2;
          const ex = cx - (N[c][0] >= 0 ? boxW(c) / 2 : 9);
          d = `M${sx0},${y} C${sx0 + 18},${y} ${ex - 18},${cy} ${ex},${cy}`;
          lx = (sx0 + ex) / 2;
          ly = (y + cy) / 2 + (lab === "≤" ? -4 : 10);
        } else {
          d = `M${x},${y + 15} C${x},${y + 38} ${cx},${cy - 38} ${cx},${cy - (N[c][0] >= 0 ? 15 : 9)}`;
          lx = (x + cx) / 2 + (lab === "≤" ? -7 : 7);
          ly = (y + cy) / 2 + 2;
        }
        edges += `<path d="${d}" fill="none" stroke="${C.line2}" stroke-width="1.3"/>`;
        edges += `<text x="${lx}" y="${ly}" text-anchor="middle" style="fill:${C.muted};font-size:9.5px">${lab}</text>`;
      }
      const col = featColor(nd[0]);
      nodes += `<g><title>${esc(lines[i].join(" "))} · split at t=${fmtT(nd[7] ?? 0)} · n=${fmtK(nd[5])}</title>
        <rect x="${x - w / 2}" y="${y - 15}" width="${w}" height="30" rx="7" fill="${C.card}" stroke="${col}" stroke-width="1.6"/>
        <text x="${x}" y="${y - 2}" text-anchor="middle" style="font-weight:600">${esc(lines[i][0])}</text>
        <text x="${x}" y="${y + 10}" text-anchor="middle">${esc(lines[i][1])}</text></g>`;
    } else {
      const v = clamp((eta * nd[4]) / S.run.leafScale, -1, 1);
      const val = (eta * nd[4]).toFixed(2);
      const txt = lr
        ? `<text x="${x + 14}" y="${y + 3.5}">${val} <tspan style="fill:${C.muted};font-size:9.5px">n ${fmtK(nd[5])}</tspan></text>`
        : `<text x="${x}" y="${y + 22}" text-anchor="middle">${val}</text><text x="${x}" y="${y + 33}" text-anchor="middle" style="fill:${
            C.muted
          };font-size:9.5px">n ${fmtK(nd[5])}</text>`;
      nodes += `<g class="lf" data-leaf="${i}"><title>leaf · w=${nd[4].toFixed(3)} · η·w=${val} · n=${fmtK(nd[5])}</title>
        <circle cx="${x}" cy="${y}" r="9" fill="${css(divColor(v, 0.3 + 0.7 * Math.abs(v)))}" stroke="${C.card}" stroke-width="1.5"/>${txt}</g>`;
    }
  }
  return { svg: edges + nodes, W, H };
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
      html += `<button class="hseg" data-id="${l.id}" style="left:${pct(l.bgFrom)}%;width:${pct(
        l.from - l.bgFrom
      )}%;background:${col};opacity:.35" title="T${l.id} background"></button>`;
    html += `<button class="hseg num" data-id="${l.id}" style="left:${pct(l.from)}%;width:calc(${pct(to - l.from)}% - 2px);background:${col};${
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
  if (on && S.run) {
    if (S.fi >= S.run.frames.length - 1) seek(0);
    last = 0;
    acc = 0;
    requestAnimationFrame(loop);
  }
}

// ---------------------------------------------------------------- controls
function fillScenarios() {
  const sel = $("scenario");
  const groups = new Map();
  for (const s of SCENARIOS[S.task]) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }
  sel.innerHTML = [...groups]
    .map(([g, list]) => `<optgroup label="${esc(g)}">${list.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</optgroup>`)
    .join("");
  sel.value = S.scenario[S.task];
}

function syncDatasetUI() {
  const sc = scen();
  const dsel = $("drift");
  dsel.disabled = !!(sc.fixedDrift || sc.real);
  dsel.value = sc.real ? "none" : sc.fixedDrift || S.drift;
  $("dsDesc").textContent = sc.desc + (sc.source ? ` (${sc.source})` : "");
  $("scenario").title = sc.desc;
  $("chipTruth").style.display = sc.truthVec ? "" : "none";
  const row = $("axes");
  if (sc.dim > 2 && sc.features) {
    const [a, b] = axesOf(sc);
    const opts = (cur) => sc.features.map((f, i) => `<option value="${i}" ${i === cur ? "selected" : ""}>${esc(f.name)}</option>`).join("");
    row.innerHTML = `<label>x <select data-ax="0">${opts(a)}</select></label><label>y <select data-ax="1">${opts(b)}</select></label>
      <span class="muted">나머지 속성 = 최근 중앙값</span><button class="info" data-info="slice">i</button>`;
    row.style.display = "flex";
  } else {
    row.style.display = "none";
    row.innerHTML = "";
  }
  buildParams();
}

function syncTask() {
  for (const b of $("task").children) b.classList.toggle("on", b.dataset.v === S.task);
}

function paramValue(k) {
  const sc = scen();
  if (k === "noise") return S.noise[S.task];
  if (k === "period") return S.period;
  if (k === "length") return sc.real ? Math.min(S.lengthReal, sc.n || MAX_LEN) : S.lengthSyn;
  return S.params[k];
}

function buildParams() {
  const sc = scen();
  const box = $("prows");
  const defs = PDEF.filter((d) => !(d.synthOnly && sc.real));
  box.innerHTML = defs
    .map((d) => {
      if (d.bool)
        return `<div class="prow"><label><input type="checkbox" data-k="${d.k}" ${S.params[d.k] ? "checked" : ""}/> ${
          d.label
        } <button class="info" data-info="${d.k}">i</button></label></div>`;
      const max = d.k === "length" && sc.real && sc.n ? Math.min(MAX_LEN, sc.n) : d.max;
      return `<div class="prow"><label>${d.label} <button class="info" data-info="${d.k}">i</button></label><output class="num" data-o="${d.k}"></output>
      <input type="range" data-k="${d.k}" min="${d.min}" max="${max}" step="${d.step}"/></div>`;
    })
    .join("");
  for (const d of defs) {
    const el = box.querySelector(`input[data-k="${d.k}"]`);
    if (d.bool) {
      el.addEventListener("change", () => {
        S.params[d.k] = el.checked;
        rerun();
      });
      continue;
    }
    const out = box.querySelector(`[data-o="${d.k}"]`);
    const show = (v) =>
      (out.textContent = d.log ? v.toExponential(0) : d.k === "length" || d.k === "period" ? fmtT(v) : d.step < 1 ? (+v).toFixed(2) : String(v));
    el.value = d.log ? Math.log10(paramValue(d.k)) : paramValue(d.k);
    show(paramValue(d.k));
    let timer = 0;
    el.addEventListener("input", () => {
      let v = d.log ? Math.pow(10, +el.value) : +el.value;
      if (d.k === "length" && sc.real && sc.n && v > Math.min(MAX_LEN, sc.n) - d.step) v = Math.min(MAX_LEN, sc.n);
      if (d.k === "noise") S.noise[S.task] = v;
      else if (d.k === "period") S.period = v;
      else if (d.k === "length") {
        if (sc.real) S.lengthReal = v;
        else S.lengthSyn = v;
      } else S.params[d.k] = v;
      show(v);
      clearTimeout(timer);
      timer = setTimeout(() => rerun(), 150);
    });
  }
}

function placeNear(el, anchor, w) {
  const r = anchor.getBoundingClientRect();
  el.style.display = "block";
  const ew = el.offsetWidth || w;
  const eh = el.offsetHeight;
  const x = clamp(r.left + r.width / 2 - ew / 2, 8, window.innerWidth - ew - 8);
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

function setHoverLeaf(v) {
  if (v === S.hoverLeaf) return;
  S.hoverLeaf = v;
  for (const el of $("tg").querySelectorAll(".lf")) el.classList.toggle("hl", +el.dataset.leaf === v);
  renderPlot();
}

function bind() {
  $("task").addEventListener("click", (e) => {
    const v = e.target.dataset.v;
    if (!v || v === S.task) return;
    S.task = v;
    syncTask();
    fillScenarios();
    rerun(false);
  });
  $("scenario").addEventListener("change", (e) => {
    S.scenario[S.task] = e.target.value;
    rerun(false);
  });
  $("drift").addEventListener("change", (e) => {
    S.drift = e.target.value;
    rerun(false);
  });
  $("axes").addEventListener("change", (e) => {
    const s = e.target.closest("select[data-ax]");
    if (!s) return;
    const sc = scen();
    const ax = axesOf(sc).slice();
    const i = +s.dataset.ax;
    const v = +s.value;
    if (ax[1 - i] === v) ax[1 - i] = ax[i];
    ax[i] = v;
    S.axes[sc.id] = ax;
    syncDatasetUI();
    render(false);
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

  // drawer
  $("dClose").addEventListener("click", closeDrawer);
  $("dInfo").addEventListener("click", (e) => {
    const o = e.target.closest("#ovl button");
    if (o && !o.disabled) {
      S.overlay = o.dataset.v;
      drawerKey = "";
      render(false);
      return;
    }
    const alt = e.target.closest(".bgnote");
    if (alt) openDrawer({ id: +alt.dataset.alt, slot: S.sel.slot });
  });
  $("dHist").addEventListener("click", (e) => {
    const seg = e.target.closest(".hseg");
    if (!seg) return;
    const id = +seg.dataset.id;
    const slot = S.sel.slot;
    const l = lifeOf(slot, id);
    if (S.sel.id !== id) TV.fit = true;
    S.sel = { id, slot };
    drawerKey = "";
    treeKey = "";
    if (!resolveSel(frame()).snap) seek(l.to != null ? Math.max(0, frameAfter(l.to - 1) - 1) : frameAfter(l.from));
    else render(false);
  });
  // tree view: hover, zoom, pan
  const tbox = $("tbox");
  tbox.addEventListener("mouseover", (e) => {
    const g = e.target.closest(".lf");
    setHoverLeaf(g ? +g.dataset.leaf : null);
  });
  tbox.addEventListener("mouseleave", () => setHoverLeaf(null));
  tbox.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const r = tbox.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false }
  );
  let pan = null;
  tbox.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    pan = { x: e.clientX, y: e.clientY, tx: TV.tx, ty: TV.ty, moved: false };
    tbox.setPointerCapture(e.pointerId);
  });
  tbox.addEventListener("pointermove", (e) => {
    if (!pan) return;
    const dx = e.clientX - pan.x;
    const dy = e.clientY - pan.y;
    if (!pan.moved && Math.hypot(dx, dy) < 3) return;
    pan.moved = true;
    tbox.classList.add("panning");
    TV.tx = pan.tx + dx;
    TV.ty = pan.ty + dy;
    TV.fit = false;
    applyTV();
  });
  const endPan = () => {
    pan = null;
    tbox.classList.remove("panning");
  };
  tbox.addEventListener("pointerup", endPan);
  tbox.addEventListener("pointercancel", endPan);
  tbox.addEventListener("dblclick", () => {
    TV.fit = true;
    renderTree(resolveSel(frame()).snap);
  });
  const center = (f) => zoomAt(tbox.clientWidth / 2, tbox.clientHeight / 2, f);
  $("tIn").addEventListener("click", () => center(1.3));
  $("tOut").addEventListener("click", () => center(1 / 1.3));
  $("tFit").addEventListener("click", () => {
    TV.fit = true;
    renderTree(resolveSel(frame()).snap);
  });
  new ResizeObserver(() => {
    if (!S.sel) return;
    treeKey = "";
    renderTree(resolveSel(frame()).snap);
  }).observe(tbox);

  // log
  $("log").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-t]");
    if (!li) return;
    setPlaying(false);
    S.fi = frameAfter(+li.dataset.t);
    TV.fit = true;
    openDrawer({ id: +li.dataset.id, slot: +li.dataset.slot });
  });

  // plot hover
  const tip = $("tip");
  plot.addEventListener("mousemove", (e) => {
    if (!S.run) return;
    const r = plot.getBoundingClientRect();
    const u = LO + ((e.clientX - r.left) / r.width) * (HI - LO);
    const w = HI - ((e.clientY - r.top) / r.height) * (HI - LO);
    const sc = S.run.sc;
    const [a, b] = axesOf(sc);
    const v = baseVec();
    v[a] = u;
    v[b] = w;
    const fr = frame();
    const eta = S.run.cfg.params.eta;
    let F = 0;
    for (const tr of fr.trees) F += eta * predictSnap(tr, v);
    let html =
      `<span class="muted">${esc(sc.features[a].name)} ${esc(fmtRaw(sc.features[a], u))}, ${esc(sc.features[b].name)} ${esc(
        fmtRaw(sc.features[b], w)
      )}</span><br>` + (S.run.cfg.task === "cls" ? `p(y=1) = <b>${sigmoid(F).toFixed(3)}</b>` : `ŷ = <b>${F.toFixed(3)}</b>`);
    const rs = resolveSel(fr);
    let leaf = null;
    if (rs && rs.snap) {
      leaf = leafIndexSnap(rs.snap, v);
      html += `<br>T${S.sel.id} leaf: η·w = <b>${(eta * rs.snap.nodes[leaf][4]).toFixed(3)}</b>`;
    }
    tip.innerHTML = html;
    tip.style.display = "block";
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    tip.style.left = Math.max(4, Math.min(px + 14, r.width - tip.offsetWidth - 4)) + "px";
    tip.style.top = (py > r.height - 70 ? py - tip.offsetHeight - 10 : py + 14) + "px";
    if (rs && rs.snap) setHoverLeaf(leaf);
  });
  plot.addEventListener("mouseleave", () => {
    tip.style.display = "none";
    setHoverLeaf(null);
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

  let rt = 0;
  new ResizeObserver(() => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (!S.run) return;
      layoutTimeline();
      render(false);
    }, 60);
  }).observe(document.querySelector("main"));
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    readColors();
    legendKey = "";
    drawerKey = "";
    treeKey = "";
    if (!S.run) return;
    layoutTimeline();
    render(false);
  });
}

// URL hash: #task=reg&ds=fried&t=3000&sel=2  (jump to a state; handy for sharing)
function hashParams() {
  const h = {};
  for (const part of location.hash.slice(1).split("&")) {
    const [k, v] = part.split("=");
    if (k) h[k] = decodeURIComponent(v || "");
  }
  return h;
}

export async function start() {
  readColors();
  const h = hashParams();
  if (h.task === "cls" || h.task === "reg") S.task = h.task;
  if (h.ds && SCENARIOS[S.task].some((s) => s.id === h.ds)) S.scenario[S.task] = h.ds;
  if (h.len) S.lengthSyn = clamp(+h.len, 2000, MAX_LEN);
  syncTask();
  fillScenarios();
  bind();
  setPlaying(false);
  const run = await rerun(false);
  if (!run) return;
  if (h.t) {
    seek(frameNear(+h.t));
    if (h.sel) {
      const k = clamp(+h.sel - 1, 0, S.run.S - 1);
      openDrawer({ id: frame().trees[k].id, slot: k });
    }
  } else setPlaying(true);
}
