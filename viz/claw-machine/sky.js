// The world outside the machine: you are floating in the sky. At night you look down on a city
// at night; by day it is randomly either the open sea or a big city with a cathedral. The scene
// is painted once onto a canvas and fluffy clouds drift across it with CSS transforms, so the
// background animates on the compositor without ever waking the WebGL renderer.

const isNight = (d = new Date()) => d.getHours() >= 19 || d.getHours() < 6;

function rng(seed) {
  return () => (seed = (seed * 16807) % 2147483647) / 2147483647;
}

function gradient(g, y0, y1, stops) {
  const grd = g.createLinearGradient(0, y0, 0, y1);
  for (const [t, c] of stops) grd.addColorStop(t, c);
  return grd;
}

function glow(g, x, y, r, color) {
  const rg = g.createRadialGradient(x, y, 0, x, y, r);
  rg.addColorStop(0, color);
  rg.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"));
  g.fillStyle = rg;
  g.fillRect(x - r, y - r, 2 * r, 2 * r);
}

function paintNight(g, w, h, rnd) {
  const H = h * 0.58;
  g.fillStyle = gradient(g, 0, H, [
    [0, "#040818"],
    [0.55, "#0c1638"],
    [0.9, "#2a2552"],
    [1, "#4a3354"],
  ]);
  g.fillRect(0, 0, w, H);
  for (let i = 0; i < 320; i++) {
    const a = rnd() * 0.8 + 0.2;
    g.fillStyle = `rgba(255,255,255,${a * (1 - rnd() * 0.5)})`;
    const s = rnd() < 0.05 ? 1.8 : 0.9;
    g.fillRect(rnd() * w, rnd() * H * 0.9, s, s);
  }
  const m = Math.min(w, h);
  glow(g, w * 0.82, h * 0.15, m * 0.16, "rgba(190,205,255,0.25)");
  g.fillStyle = "#f4f1e6";
  g.beginPath();
  g.arc(w * 0.82, h * 0.15, m * 0.032, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = "rgba(200,195,180,0.35)";
  g.beginPath();
  g.arc(w * 0.814, h * 0.144, m * 0.008, 0, 7);
  g.arc(w * 0.83, h * 0.16, m * 0.006, 0, 7);
  g.fill();

  // the city far below: dark ground, light pollution at the horizon, lights in perspective
  g.fillStyle = gradient(g, H, h, [
    [0, "#1a1530"],
    [0.15, "#0b0a1a"],
    [1, "#04040b"],
  ]);
  g.fillRect(0, H, w, h - H);
  g.globalCompositeOperation = "lighter";
  g.fillStyle = gradient(g, H - h * 0.08, H + h * 0.06, [
    [0, "rgba(255,140,80,0)"],
    [0.6, "rgba(255,150,90,0.22)"],
    [1, "rgba(255,150,90,0)"],
  ]);
  g.fillRect(0, H - h * 0.08, w, h * 0.14);
  const vx = w * 0.5;
  const warm = ["255,214,150", "255,190,110", "255,240,210", "200,220,255", "255,170,90"];
  for (let i = 0; i < 5200; i++) {
    const d = Math.pow(rnd(), 1.8);
    const y = H + (h - H) * Math.pow(d, 1.35) + 1;
    const x = vx + (rnd() - 0.5) * w * (0.9 + 3.2 * d);
    if (x < 0 || x > w) continue;
    const s = 0.5 + d * 2.4;
    const c = warm[(rnd() * warm.length) | 0];
    g.fillStyle = `rgba(${c},${0.35 + rnd() * 0.65})`;
    g.fillRect(x, y, s, s * 0.8);
    if (rnd() < 0.04) glow(g, x, y, s * 6, `rgba(${c},0.18)`);
  }
  // highways: streams of head/tail lights fanning out from the vanishing point
  for (let r = 0; r < 9; r++) {
    const ex = vx + (r - 4) * w * 0.45 + (rnd() - 0.5) * w * 0.2;
    for (let i = 0; i < 160; i++) {
      const t = Math.pow(i / 160, 1.5);
      const x = vx + (ex - vx) * t,
        y = H + (h - H) * t;
      g.fillStyle = i % 2 ? `rgba(255,230,170,${0.5 + t * 0.4})` : `rgba(255,80,70,${0.4 + t * 0.4})`;
      const s = 0.8 + t * 2.2;
      g.fillRect(x, y, s, s);
    }
  }
  g.globalCompositeOperation = "source-over";
}

function paintSea(g, w, h, rnd) {
  const H = h * 0.6;
  g.fillStyle = gradient(g, 0, H, [
    [0, "#2f7fd6"],
    [0.6, "#7fbdf0"],
    [1, "#e4f3fb"],
  ]);
  g.fillRect(0, 0, w, H);
  const m = Math.min(w, h);
  const sx = w * 0.2,
    sy = h * 0.2;
  glow(g, sx, sy, m * 0.5, "rgba(255,248,220,0.35)");
  glow(g, sx, sy, m * 0.08, "rgba(255,255,240,0.95)");
  g.fillStyle = gradient(g, H, h, [
    [0, "#9cc6dd"],
    [0.08, "#4f8fbf"],
    [0.5, "#21659c"],
    [1, "#0f3f6b"],
  ]);
  g.fillRect(0, H, w, h - H);
  // distant islands
  g.fillStyle = "rgba(70,110,140,0.55)";
  for (const [x, wd, ht] of [
    [0.62, 0.12, 0.012],
    [0.71, 0.05, 0.007],
    [0.08, 0.07, 0.008],
  ]) {
    g.beginPath();
    g.ellipse(w * x, H, w * wd, h * ht, 0, Math.PI, 0);
    g.fill();
  }
  // wave texture in perspective, and the sun's glitter path
  for (let i = 0; i < 2600; i++) {
    const d = Math.pow(rnd(), 1.6);
    const y = H + (h - H) * d + 1;
    const x = rnd() * w;
    const len = 2 + d * 26;
    g.fillStyle = rnd() < 0.5 ? `rgba(255,255,255,${0.08 + d * 0.12})` : `rgba(10,40,80,${0.1 + d * 0.15})`;
    g.fillRect(x, y, len, 0.6 + d * 1.6);
  }
  g.globalCompositeOperation = "lighter";
  for (let i = 0; i < 900; i++) {
    const d = Math.pow(rnd(), 1.3);
    const y = H + (h - H) * d + 1;
    const spread = w * (0.02 + d * 0.22);
    const x = sx + (rnd() - 0.5) * spread * 2 * (rnd() * 0.6 + 0.4);
    g.fillStyle = `rgba(255,250,225,${0.25 + rnd() * 0.6})`;
    g.fillRect(x, y, 2 + d * 18 * rnd(), 0.8 + d * 1.5);
  }
  g.globalCompositeOperation = "source-over";
}

function paintCity(g, w, h, rnd) {
  const H = h * 0.56;
  g.fillStyle = gradient(g, 0, H, [
    [0, "#3a86d4"],
    [0.65, "#9fcdf0"],
    [1, "#e8f2f7"],
  ]);
  g.fillRect(0, 0, w, H);
  const m = Math.min(w, h);
  glow(g, w * 0.78, h * 0.14, m * 0.45, "rgba(255,250,225,0.3)");
  glow(g, w * 0.78, h * 0.14, m * 0.06, "rgba(255,255,245,0.95)");
  g.fillStyle = gradient(g, H, h, [
    [0, "#c9d6dc"],
    [0.3, "#9aa6a0"],
    [1, "#6f7b70"],
  ]);
  g.fillRect(0, H, w, h - H);
  // rows of buildings from the hazy horizon to the near blocks below us
  const haze = (t) => `rgba(205,222,232,${(1 - t) * 0.75})`;
  const palette = ["#e3d9c8", "#cfc6b8", "#b9b3aa", "#d7c3a5", "#a9b2b8", "#e8e2d6"];
  const roofs = ["#b0563c", "#8c5a46", "#6d7378", "#9a4a36"];
  const rows = 9;
  for (let r = 0; r < rows; r++) {
    const t = r / (rows - 1);
    const base = H + (h - H) * Math.pow(t, 1.6) + h * 0.01;
    const scale = 0.25 + t * 2.2;
    let x = -rnd() * 40;
    while (x < w) {
      const bw = (14 + rnd() * 30) * scale;
      const bh = (10 + rnd() * 40 + (rnd() < 0.08 ? 60 : 0)) * scale;
      g.fillStyle = palette[(rnd() * palette.length) | 0];
      g.fillRect(x, base - bh, bw - 2 * scale, bh);
      // shaded side + roof + windows on the nearer rows
      g.fillStyle = "rgba(0,0,0,0.12)";
      g.fillRect(x + bw * 0.7, base - bh, bw * 0.3 - 2 * scale, bh);
      g.fillStyle = roofs[(rnd() * roofs.length) | 0];
      g.fillRect(x, base - bh - 2.5 * scale, bw - 2 * scale, 2.5 * scale);
      if (t > 0.3) {
        g.fillStyle = "rgba(60,80,100,0.35)";
        for (let wy = base - bh + 4 * scale; wy < base - 3 * scale; wy += 5 * scale)
          for (let wx = x + 3 * scale; wx < x + bw - 5 * scale; wx += 5 * scale) g.fillRect(wx, wy, 2 * scale, 2.5 * scale);
      }
      x += bw;
    }
    // atmospheric haze only on the distant rows, so the cathedral and the near blocks stay crisp
    if (r < 3) {
      g.fillStyle = haze(t);
      g.fillRect(0, H, w, base - H);
    }
    if (r === 3) cathedral(g, w * 0.17, base, h * 0.24, rnd);
  }
}

// a gothic cathedral: twin spired towers, a rose window, the nave and a central flèche
function cathedral(g, cx, base, size, rnd) {
  const s = size;
  const stone = "#d9ccb2",
    shade = "#b7a98f",
    dark = "#5b5348";
  const fill = (c, pts) => {
    g.fillStyle = c;
    g.beginPath();
    pts.forEach(([x, y], i) => (i ? g.lineTo(cx + x * s, base - y * s) : g.moveTo(cx + x * s, base - y * s)));
    g.closePath();
    g.fill();
  };
  // nave + roof running back
  fill(shade, [
    [0.15, 0],
    [0.95, 0],
    [0.95, 0.42],
    [0.15, 0.42],
  ]);
  fill("#7b8a8f", [
    [0.12, 0.42],
    [0.98, 0.42],
    [0.9, 0.58],
    [0.2, 0.58],
  ]);
  // flèche over the crossing
  fill(dark, [
    [0.6, 0.58],
    [0.66, 0.58],
    [0.63, 1.05],
  ]);
  // façade towers with spires
  for (const tx of [-0.22, 0.12]) {
    fill(stone, [
      [tx, 0],
      [tx + 0.2, 0],
      [tx + 0.2, 0.78],
      [tx, 0.78],
    ]);
    fill(shade, [
      [tx + 0.14, 0],
      [tx + 0.2, 0],
      [tx + 0.2, 0.78],
      [tx + 0.14, 0.78],
    ]);
    fill(stone, [
      [tx - 0.01, 0.78],
      [tx + 0.21, 0.78],
      [tx + 0.1, 1.32],
    ]);
    g.fillStyle = dark;
    for (let k = 0; k < 3; k++) g.fillRect(cx + (tx + 0.06) * s, base - (0.32 + k * 0.15) * s, 0.08 * s, 0.09 * s);
  }
  // centre gable with the rose window and portals
  fill(stone, [
    [-0.02, 0],
    [0.12, 0],
    [0.12, 0.6],
    [0.05, 0.72],
    [-0.02, 0.6],
  ]);
  g.fillStyle = "#7d5f8f";
  g.beginPath();
  g.arc(cx + 0.05 * s, base - 0.46 * s, 0.05 * s, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = dark;
  for (const px of [-0.17, 0.02, 0.17]) {
    g.beginPath();
    g.moveTo(cx + px * s, base);
    g.lineTo(cx + px * s, base - 0.12 * s);
    g.arc(cx + (px + 0.03) * s, base - 0.12 * s, 0.03 * s, Math.PI, 0);
    g.lineTo(cx + (px + 0.06) * s, base);
    g.fill();
  }
  void rnd;
}

// one puffy cumulus, painted once into its own canvas: dozens of soft-edged puffs piled into a
// dome, a flattened base, then sunlit-top / shaded-bottom grading
function cloudCanvas(rnd, w, night) {
  const h = Math.round(w * 0.6);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  const lit = night ? "160,172,220" : "255,255,255";
  for (let i = 0; i < 60; i++) {
    const t = rnd();
    const dome = Math.sin(t * Math.PI);
    const x = w * (0.12 + t * 0.76);
    const r = w * (0.05 + rnd() * 0.08) * (0.55 + dome * 0.7);
    const y = h * 0.66 - rnd() * dome * h * 0.36;
    const rg = g.createRadialGradient(x, y, 0, x, y, r);
    rg.addColorStop(0, `rgba(${lit},0.95)`);
    rg.addColorStop(0.55, `rgba(${lit},0.8)`);
    rg.addColorStop(1, `rgba(${lit},0)`);
    g.fillStyle = rg;
    g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  // flat-ish base that fades out
  g.globalCompositeOperation = "destination-out";
  const base = g.createLinearGradient(0, h * 0.68, 0, h * 0.82);
  base.addColorStop(0, "rgba(0,0,0,0)");
  base.addColorStop(1, "rgba(0,0,0,1)");
  g.fillStyle = base;
  g.fillRect(0, h * 0.68, w, h * 0.32);
  // shading: light from above, cooler and darker underneath
  g.globalCompositeOperation = "source-atop";
  const shade = g.createLinearGradient(0, h * 0.2, 0, h * 0.75);
  shade.addColorStop(0, "rgba(255,255,255,0)");
  shade.addColorStop(1, night ? "rgba(25,30,62,0.75)" : "rgba(160,182,214,0.6)");
  g.fillStyle = shade;
  g.fillRect(0, 0, w, h);
  g.globalCompositeOperation = "source-over";
  return c;
}

export function createSky(root) {
  const bg = document.createElement("canvas");
  bg.className = "sky-bg";
  root.appendChild(bg);
  const layer = document.createElement("div");
  layer.className = "sky-clouds";
  root.appendChild(layer);

  let mode = null;
  let seed = (Math.random() * 1e9) | 0;
  const listeners = [];
  const mirror = document.createElement("canvas"); // small copy for the machine's mirror
  mirror.width = 512;
  mirror.height = 256;

  function paint() {
    const pr = Math.min(devicePixelRatio, 1.5);
    const w = Math.round(innerWidth * pr),
      h = Math.round(innerHeight * pr);
    bg.width = w;
    bg.height = h;
    const g = bg.getContext("2d");
    const rnd = rng(seed);
    if (mode === "night") paintNight(g, w, h, rnd);
    else if (mode === "sea") paintSea(g, w, h, rnd);
    else paintCity(g, w, h, rnd);
    mirror.getContext("2d").drawImage(bg, 0, 0, mirror.width, mirror.height);
  }

  function makeClouds() {
    layer.textContent = "";
    const rnd = rng(seed + 1);
    const night = mode === "night";
    const count = mode === "sea" ? 8 : night ? 7 : 10;
    for (let i = 0; i < count; i++) {
      const near = i >= count - 3; // a few big clouds drifting below us
      const cw = Math.round((near ? 520 : 260) + rnd() * 260);
      const c = cloudCanvas(rnd, cw, night);
      const el = document.createElement("div");
      el.className = "cloud";
      el.appendChild(c);
      const top = near ? 62 + rnd() * 24 : 3 + rnd() * 40;
      const dur = (near ? 70 : 140) + rnd() * 120;
      el.style.top = top + "%";
      el.style.width = (near ? 55 : 28) + rnd() * 22 + "vw";
      el.style.opacity = (night ? 0.75 : 0.95) - rnd() * 0.15;
      el.style.animationDuration = dur.toFixed(0) + "s";
      el.style.animationDelay = (-rnd() * dur).toFixed(1) + "s";
      c.style.animationDuration = (6 + rnd() * 6).toFixed(1) + "s"; // gentle bobbing
      c.style.animationDelay = (-rnd() * 6).toFixed(1) + "s";
      layer.appendChild(el);
    }
  }

  function setMode() {
    const next = isNight() ? "night" : mode && mode !== "night" ? mode : Math.random() < 0.5 ? "sea" : "city";
    if (next === mode) return;
    mode = next;
    root.dataset.mode = mode;
    paint();
    makeClouds();
    for (const f of listeners) f(mirror);
  }

  setMode();
  setInterval(setMode, 5 * 60 * 1000); // follow the clock: switch to the night view after dark
  let t;
  addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(paint, 200);
  });

  return {
    get mode() {
      return mode;
    },
    mirrorCanvas: mirror,
    onChange: (f) => listeners.push(f),
  };
}
