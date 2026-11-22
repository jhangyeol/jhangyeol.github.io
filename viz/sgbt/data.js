// Synthetic 2-D streams whose concept drifts over time.
// Every scenario exposes sample(rng, phase) and truth(x1, x2, phase).
// `phase` is a real number: integer = a pure concept, fraction = in-between.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(rng) {
  let u = 0;
  while (u === 0) u = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const lerp = (a, b, t) => a + (b - a) * t;

function rotate(x, y, a) {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c * x - s * y, s * x + c * y];
}

// Interpolate between cyclic concept parameter vectors.
function conceptParams(list, phase) {
  const K = list.length;
  const i = Math.floor(phase);
  const f = phase - i;
  const A = list[((i % K) + K) % K];
  const B = list[(((i + 1) % K) + K) % K];
  return A.map((v, j) => lerp(v, B[j], f));
}

const uniform = (rng) => [rng() * 2 - 1, rng() * 2 - 1];

// Distance from point to polyline (array of [x,y]).
function polyDist(px, py, pts) {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy;
    let t = L > 0 ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + t * dx - px;
    const ey = ay + t * dy - py;
    const d = ex * ex + ey * ey;
    if (d < best) best = d;
  }
  return best;
}

// Curve-based scenarios (moons, spiral): class c lives on curve c(u), u in [0,1].
function curveScenario({ id, name, desc, curve, spin, spread }) {
  const cache = new Map();
  const polys = (phase) => {
    const key = phase.toFixed(4);
    if (!cache.has(key)) {
      if (cache.size > 64) cache.clear();
      const a = phase * spin;
      const mk = (c) => {
        const out = [];
        for (let i = 0; i <= 120; i++) {
          const [x, y] = curve(c, i / 120);
          out.push(rotate(x, y, a));
        }
        return out;
      };
      cache.set(key, [mk(0), mk(1)]);
    }
    return cache.get(key);
  };
  return {
    id,
    name,
    desc,
    sample(rng, phase, noise) {
      const y = rng() < 0.5 ? 0 : 1;
      const [x0, y0] = curve(y, rng());
      const [x, z] = rotate(x0 + gauss(rng) * spread, y0 + gauss(rng) * spread, phase * spin);
      const flip = rng() < noise;
      return { x: [x, z], y: flip ? 1 - y : y };
    },
    truth(x1, x2, phase) {
      const [p0, p1] = polys(phase);
      const d0 = polyDist(x1, x2, p0);
      const d1 = polyDist(x1, x2, p1);
      return sigmoid((d0 - d1) / (2 * spread * spread));
    },
  };
}

const CLS = [
  curveScenario({
    id: "moons",
    name: "Two Moons",
    desc: "두 개의 반달. concept가 바뀔 때마다 90° 회전.",
    spin: Math.PI / 2,
    spread: 0.09,
    curve: (c, u) => {
      const t = u * Math.PI;
      return c === 0 ? [(Math.cos(t) - 0.5) * 0.75, (Math.sin(t) - 0.25) * 0.75] : [(0.5 - Math.cos(t)) * 0.75, (0.25 - Math.sin(t)) * 0.75];
    },
  }),
  curveScenario({
    id: "spiral",
    name: "Spiral",
    desc: "두 팔 나선. concept마다 90° 회전.",
    spin: Math.PI / 2,
    spread: 0.05,
    curve: (c, u) => {
      const r = 0.08 + 0.85 * u;
      const th = 2.6 * Math.PI * u + c * Math.PI;
      return [r * Math.cos(th), r * Math.sin(th)];
    },
  }),
  (() => {
    // x2 > a0 + a1 x + a2 x^2 + a3 x^3
    const C = [
      [-0.4, 0, 0.9, 0],
      [0, -0.6, 0, 0.9],
      [0.35, 0, -0.9, 0],
      [0, 0.7, 0, -0.5],
    ];
    const poly = (x, a) => a[0] + a[1] * x + a[2] * x * x + a[3] * x * x * x;
    return {
      id: "poly",
      name: "Polynomial",
      desc: "다항식 곡선 위/아래로 class가 나뉨. concept마다 계수가 바뀜.",
      sample(rng, phase, noise) {
        const x = uniform(rng);
        const y = x[1] > poly(x[0], conceptParams(C, phase)) ? 1 : 0;
        return { x, y: rng() < noise ? 1 - y : y };
      },
      truth(x1, x2, phase) {
        return sigmoid((x2 - poly(x1, conceptParams(C, phase))) / 0.015);
      },
    };
  })(),
  (() => {
    const C = [
      [0, 0, 0.55],
      [0.35, 0.3, 0.4],
      [-0.3, -0.2, 0.65],
      [0.25, -0.35, 0.35],
    ];
    return {
      id: "circle",
      name: "Moving Circle",
      desc: "원 안쪽이 class 1. 중심과 반지름이 이동.",
      sample(rng, phase, noise) {
        const x = uniform(rng);
        const [cx, cy, r] = conceptParams(C, phase);
        const y = Math.hypot(x[0] - cx, x[1] - cy) < r ? 1 : 0;
        return { x, y: rng() < noise ? 1 - y : y };
      },
      truth(x1, x2, phase) {
        const [cx, cy, r] = conceptParams(C, phase);
        return sigmoid((r - Math.hypot(x1 - cx, x2 - cy)) / 0.015);
      },
    };
  })(),
  {
    id: "xor",
    name: "Rotating XOR",
    desc: "XOR(사분면) 패턴. concept마다 45° 회전.",
    sample(rng, phase, noise) {
      const x = uniform(rng);
      const [u, v] = rotate(x[0], x[1], -phase * (Math.PI / 4));
      const y = u * v > 0 ? 1 : 0;
      return { x, y: rng() < noise ? 1 - y : y };
    },
    truth(x1, x2, phase) {
      const [u, v] = rotate(x1, x2, -phase * (Math.PI / 4));
      return sigmoid((Math.sign(u * v) * Math.min(Math.abs(u), Math.abs(v))) / 0.015);
    },
  },
];

const REG = [
  (() => {
    // z = a x^2 + b xy + c y + d x^3
    const C = [
      [0.9, 0, 0.5, 0],
      [-0.6, 0.9, 0, 0.4],
      [0, -0.8, -0.6, 0],
      [0.5, 0, 0, -0.9],
    ];
    const f = (x, y, a) => a[0] * x * x + a[1] * x * y + a[2] * y + a[3] * x * x * x - a[0] * 0.33;
    return {
      id: "rpoly",
      name: "Polynomial",
      desc: "다항식 곡면 z = f(x₁, x₂). concept마다 계수가 바뀜.",
      sample(rng, phase, noise) {
        const x = uniform(rng);
        return { x, y: f(x[0], x[1], conceptParams(C, phase)) + gauss(rng) * noise };
      },
      truth: (x1, x2, phase) => f(x1, x2, conceptParams(C, phase)),
    };
  })(),
  (() => {
    const C = [
      [1, 0],
      [1.5, 0.5],
      [0.8, 1],
      [2, 1.5],
    ];
    const f = (x, y, [k, ph]) => Math.sin(Math.PI * (k * x + ph)) * Math.cos(0.5 * Math.PI * y);
    return {
      id: "sine",
      name: "Sine Wave",
      desc: "사인 곡면. concept마다 주파수와 위상이 변함.",
      sample(rng, phase, noise) {
        const x = uniform(rng);
        return { x, y: f(x[0], x[1], conceptParams(C, phase)) + gauss(rng) * noise };
      },
      truth: (x1, x2, phase) => f(x1, x2, conceptParams(C, phase)),
    };
  })(),
  (() => {
    // two bumps (+ / -) whose centers move
    const C = [
      [-0.4, -0.4, 0.4, 0.4],
      [0.4, -0.4, -0.4, 0.4],
      [0.4, 0.4, -0.4, -0.4],
      [-0.4, 0.4, 0.4, -0.4],
    ];
    const f = (x, y, [ax, ay, bx, by]) => Math.exp(-((x - ax) ** 2 + (y - ay) ** 2) / 0.12) - Math.exp(-((x - bx) ** 2 + (y - by) ** 2) / 0.12);
    return {
      id: "peaks",
      name: "Moving Peaks",
      desc: "봉우리(+)와 골짜기(−)가 위치를 바꿈.",
      sample(rng, phase, noise) {
        const x = uniform(rng);
        return { x, y: f(x[0], x[1], conceptParams(C, phase)) + gauss(rng) * noise };
      },
      truth: (x1, x2, phase) => f(x1, x2, conceptParams(C, phase)),
    };
  })(),
  {
    id: "rspiral",
    name: "Spiral Ripple",
    desc: "나선형 물결 z = sin(2θ + 5r − φ). concept마다 회전.",
    sample(rng, phase, noise) {
      const x = uniform(rng);
      return { x, y: this.truth(x[0], x[1], phase) + gauss(rng) * noise };
    },
    truth(x1, x2, phase) {
      const r = Math.hypot(x1, x2);
      return Math.sin(2 * Math.atan2(x2, x1) + 5 * r - phase * (Math.PI / 2)) * Math.min(1, r * 2.5);
    },
  },
  (() => {
    const C = [
      [0.2, -0.3],
      [-0.4, 0.4],
      [0.5, 0.5],
      [-0.2, -0.5],
    ];
    const f = (x, y, [a, b]) => (x > a ? 0.8 : -0.4) + (y > b ? -0.5 : 0.3) + (x > a && y > b ? 0.4 : 0);
    return {
      id: "steps",
      name: "Steps",
      desc: "계단형(piecewise constant) 함수. 경계 위치가 이동. 트리가 가장 잘 맞추는 형태.",
      sample(rng, phase, noise) {
        const x = uniform(rng);
        return { x, y: f(x[0], x[1], conceptParams(C, Math.round(phase))) + gauss(rng) * noise };
      },
      truth: (x1, x2, phase) => f(x1, x2, conceptParams(C, Math.round(phase))),
    };
  })(),
];

export const SCENARIOS = { cls: CLS, reg: REG };

// Concept schedule. Returns { phase(t, rng) for sampling, display(t) for drawing, changes: [t...] }.
export function schedule(kind, T, period) {
  const changes = [];
  for (let b = period; b < T; b += period) changes.push(b);
  const w = period * 0.4;
  const near = (t) => {
    const i = Math.floor((t + w / 2) / period);
    const b = i * period;
    return { i, b, frac: Math.min(1, Math.max(0, (t - (b - w / 2)) / w)) };
  };
  if (kind === "none") return { changes: [], phase: () => 0, display: () => 0, windows: [] };
  if (kind === "abrupt") {
    const ph = (t) => Math.floor(t / period);
    return { changes, phase: ph, display: ph, windows: [] };
  }
  const windows = changes.map((b) => [b - w / 2, b + w / 2]);
  if (kind === "gradual") {
    return {
      changes,
      windows,
      phase(t, rng) {
        const { i, frac } = near(t);
        if (i === 0) return 0;
        return rng() < frac ? i : i - 1;
      },
      display(t) {
        const { i, frac } = near(t);
        return i === 0 ? 0 : frac >= 0.5 ? i : i - 1;
      },
    };
  }
  // incremental
  const ph = (t) => {
    const { i, frac } = near(t);
    return i === 0 ? 0 : i - 1 + frac;
  };
  return { changes, windows, phase: ph, display: ph };
}
