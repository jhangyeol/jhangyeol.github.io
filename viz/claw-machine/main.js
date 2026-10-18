import RAPIER from "@dimforge/rapier3d-compat";
import * as THREE from "three";
import { ClawSim, DEFAULT_SETTINGS } from "./sim.js";
import { CHARACTERS } from "./characters.js";
import { createScene } from "./scene.js";
import { createDollMeshes } from "./dolls.js";
import { createWinModal } from "./win.js";
import { createSky } from "./sky.js";
import { startWalkers } from "./walkers.js";

// no top-level await: the site's terser build step can't parse it and silently drops the file
export async function start() {
  const $ = (id) => document.getElementById(id);
  const COIN = 500;
  const CAPACITY = 60;
  const START_DOLLS = 18;
  // the characters that go into the machine (all five have real 3D models)
  const STOCK = CHARACTERS.map((c, i) => i).filter((i) => ["chiikawa", "hachiware", "momonga", "usagi", "shisa"].includes(CHARACTERS[i].id));
  const stockType = () => STOCK[Math.floor(Math.random() * STOCK.length)];
  const SETTINGS_KEY = "claw-machine-settings";
  const QUALITY_KEY = "claw-machine-quality";
  const SMASH_PRESSES = 10; // hidden feature: mash the grab button this many times...
  const SMASH_WINDOW = 3000; // ...within this many ms

  function loadSettings() {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
    } catch {}
  }

  const sky = createSky($("sky"));
  startWalkers($("sky"));
  await RAPIER.init();

  const canvas = $("view");
  const view = createScene(canvas);
  const mirrorSky = new THREE.CanvasTexture(sky.mirrorCanvas);
  mirrorSky.colorSpace = THREE.SRGBColorSpace;
  view.setMirrorSky(mirrorSky);
  const meshes = await createDollMeshes(view.scene, CAPACITY); // before the sim: model bounds shape the colliders
  const sim = new ClawSim(RAPIER, loadSettings());
  const winModal = createWinModal(meshes);

  // fill the machine and let the pile settle before the first frame is shown
  function fill() {
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < START_DOLLS / 3; i++) sim.spawnRandomDoll(stockType());
      for (let i = 0; i < 50; i++) sim.update(1 / 60);
    }
    for (let i = 0; i < 120; i++) sim.update(1 / 60);
    sim.events.length = 0;
  }
  fill();

  // ---------- render sync ----------

  const _m = new THREE.Matrix4();
  const _p = new THREE.Vector3();
  const _q = new THREE.Quaternion();
  const _s = new THREE.Vector3(1, 1, 1);
  const counts = new Array(CHARACTERS.length);

  function syncDolls() {
    counts.fill(0);
    for (const d of sim.dolls) {
      const t = d.body.translation();
      const r = d.body.rotation();
      _m.compose(_p.set(t.x, t.y, t.z), _q.set(r.x, r.y, r.z, r.w), _s);
      meshes[d.type].setMatrixAt(counts[d.type]++, _m);
    }
    meshes.forEach((m, i) => {
      m.count = counts[i];
      m.instanceMatrix.needsUpdate = true;
    });
  }

  // ---------- UI ----------

  const stats = { spent: 0, won: [] };
  let wonThisGame = false;
  let dirty = 3; // frames that must be rendered regardless of motion

  function toast(text, kind = "") {
    const el = $("toast");
    el.textContent = text;
    el.className = "toast show " + kind;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => (el.className = "toast " + kind), 2200);
  }

  function renderShelf() {
    $("won-count").textContent = stats.won.length;
    $("spent").textContent = stats.spent.toLocaleString("ko-KR");
    $("shelf").innerHTML = stats.won
      .slice(-12)
      .map((t) => {
        const c = CHARACTERS[t];
        const hex = "#" + c.colors.base.toString(16).padStart(6, "0");
        return `<span class="chip"><i style="background:${hex}"></i>${c.name}</span>`;
      })
      .join("");
  }

  function updateButtons() {
    const idle = sim.state === "idle";
    $("coin").disabled = !idle;
    // the grab button never gets `disabled`: presses are counted even between games (see smash)
    $("drop").classList.toggle("off", sim.state !== "play");
    $("doll-count").textContent = `${sim.dolls.length} / ${CAPACITY}`;
    $("add").disabled = sim.dolls.length >= CAPACITY || sim.broken;
    const n = sim.settings.randomCycle;
    $("cycle-info").textContent = n > 0 ? `다음 강한 판까지 ${n - (sim.playCount % n)}판` : "랜덤 게임 꺼짐";
  }

  function insertCoin() {
    if (!sim.insertCoin()) return;
    stats.spent += COIN;
    wonThisGame = false;
    renderShelf();
    dirty = 3;
  }

  const presses = [];
  function drop() {
    sim.drop();
    // hidden: mash the button and the machine breaks open
    const now = performance.now();
    presses.push(now);
    while (presses.length && now - presses[0] > SMASH_WINDOW) presses.shift();
    if (presses.length >= SMASH_PRESSES && !sim.broken) {
      presses.length = 0;
      smash();
    }
  }

  function addDoll() {
    if (sim.broken) return;
    const d = sim.spawnRandomDoll(stockType());
    if (d) toast(`${CHARACTERS[d.type].name} 추가!`);
    dirty = 3;
    updateButtons();
  }

  // ---------- hidden feature: smash the machine, every doll is yours ----------

  function smash() {
    view.shatter();
    view.setPowered(true);
    sim.breakOpen();
    toast("쨍그랑!!", "pop");
    dirty = 3;
    updateButtons();
    setTimeout(() => {
      const types = sim.dolls.map((d) => d.type);
      stats.won.push(...types);
      renderShelf();
      for (const d of [...sim.dolls]) sim.removeDoll(d);
      winModal.open(types.length ? types : [0], `${types.length}마리 전부 뽑았다고~!`, () => {
        // the machine gets fixed and restocked
        sim.repair();
        view.restoreGlass();
        fill();
        view.setPowered(false);
        toast("기계 수리 완료!");
        dirty = 3;
        updateButtons();
      });
    }, 2300);
  }

  // ---------- viewpoint: click and drag on the machine to walk around it (−45° … +45°) ----------

  let viewAngle = 0;
  function setAngle(deg) {
    viewAngle = Math.max(-45, Math.min(45, deg));
    view.setViewAngle(viewAngle);
  }
  // one finger / mouse drag turns the view; two fingers pinch to zoom; the wheel zooms too
  let zoom = 1;
  const pointers = new Map();
  let dragX = 0,
    dragStart = 0,
    pinchDist = 0,
    pinchZoom = 1;
  const pinchSpan = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragX = e.clientX;
      dragStart = viewAngle;
      canvas.classList.add("dragging");
    } else if (pointers.size === 2) {
      pinchDist = pinchSpan();
      pinchZoom = zoom;
    }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      // dragging right swings you to the left side, like grabbing the scene and turning it
      setAngle(dragStart - ((e.clientX - dragX) / canvas.clientWidth) * 120);
    } else if (pointers.size === 2 && pinchDist > 0) {
      zoom = view.setZoom((pinchZoom * pinchDist) / pinchSpan());
    }
  });
  const dragEnd = (e) => {
    if (!pointers.delete(e.pointerId)) return;
    if (pointers.size === 1) {
      // back to one finger: continue turning from where it is now
      const [p] = pointers.values();
      dragX = p.x;
      dragStart = viewAngle;
    }
    if (pointers.size === 0) canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", dragEnd);
  canvas.addEventListener("pointercancel", dragEnd);
  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoom = view.setZoom(zoom * Math.exp(e.deltaY * 0.0015));
    },
    { passive: false }
  );
  canvas.addEventListener("dblclick", () => {
    setAngle(0);
    zoom = view.setZoom(1);
  });

  // ---------- graphics quality: AO + bloom on capable devices, plain forward render otherwise ----------

  function readQuality() {
    try {
      const q = localStorage.getItem(QUALITY_KEY);
      if (q) return q === "high";
    } catch {}
    return !matchMedia("(pointer: coarse)").matches;
  }
  let highQuality = readQuality();
  function applyQuality() {
    view.setQuality(highQuality);
    $("quality").textContent = highQuality ? "✨ 고화질" : "⚡ 가볍게";
    dirty = 3;
  }
  $("quality").onclick = () => {
    highQuality = !highQuality;
    try {
      localStorage.setItem(QUALITY_KEY, highQuality ? "high" : "low");
    } catch {}
    applyQuality();
  };
  applyQuality();

  $("coin").onclick = insertCoin;
  $("drop").onclick = drop;
  $("add").onclick = addDoll;

  // operator settings (based on how Korean boards expose them)
  const settingFields = ["catchPower", "topPower", "movePower", "randomCycle"];
  for (const key of settingFields) {
    const input = $(key);
    const out = $(key + "-v");
    input.value = sim.settings[key];
    out.textContent = input.value;
    input.oninput = () => {
      sim.settings[key] = +input.value;
      out.textContent = input.value;
      saveSettings(sim.settings);
      updateButtons();
    };
  }
  $("exitDrop").checked = sim.settings.exitDrop;
  $("exitDrop").onchange = (e) => {
    sim.settings.exitDrop = e.target.checked;
    saveSettings(sim.settings);
  };
  $("reset-settings").onclick = () => {
    Object.assign(sim.settings, DEFAULT_SETTINGS);
    saveSettings(sim.settings);
    for (const key of settingFields) {
      $(key).value = sim.settings[key];
      $(key + "-v").textContent = sim.settings[key];
    }
    $("exitDrop").checked = sim.settings.exitDrop;
    updateButtons();
  };
  $("settings-toggle").onclick = () => $("settings").classList.toggle("open");

  // ---------- input: keyboard + on-screen joystick ----------

  const keys = new Set();
  const stickVec = { x: 0, z: 0 };
  addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    const k = e.key.toLowerCase();
    if (winModal.isOpen()) {
      if (k === "enter" || k === "escape" || k === " ") {
        e.preventDefault();
        winModal.close();
      }
      return;
    }
    if (k === "q") return setAngle(viewAngle - 15);
    if (k === "e") return setAngle(viewAngle + 15);
    if (k === "r") return setAngle(0);
    if (["arrowleft", "arrowright", "arrowup", "arrowdown", " "].includes(k)) e.preventDefault();
    if (k === " ") {
      if (!e.repeat) drop();
    } else if (k === "enter" || k === "c") insertCoin();
    else if (k === "n") addDoll();
    else keys.add(k);
  });
  addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));
  addEventListener("blur", () => keys.clear());

  const pad = $("stick");
  const nub = $("stick-nub");
  let padId = null;
  function padMove(e) {
    const r = pad.getBoundingClientRect();
    let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    let y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    const l = Math.hypot(x, y);
    if (l > 1) (x /= l), (y /= l);
    stickVec.x = Math.abs(x) > 0.18 ? x : 0;
    stickVec.z = Math.abs(y) > 0.18 ? y : 0;
    nub.style.transform = `translate(${x * 34}px, ${y * 34}px)`;
  }
  pad.addEventListener("pointerdown", (e) => {
    padId = e.pointerId;
    pad.setPointerCapture(padId);
    padMove(e);
  });
  pad.addEventListener("pointermove", (e) => e.pointerId === padId && padMove(e));
  const padEnd = () => {
    padId = null;
    stickVec.x = stickVec.z = 0;
    nub.style.transform = "";
  };
  pad.addEventListener("pointerup", padEnd);
  pad.addEventListener("pointercancel", padEnd);

  function readInput() {
    let x = stickVec.x,
      z = stickVec.z;
    if (keys.has("arrowleft") || keys.has("a")) x -= 1;
    if (keys.has("arrowright") || keys.has("d")) x += 1;
    if (keys.has("arrowup") || keys.has("w")) z -= 1;
    if (keys.has("arrowdown") || keys.has("s")) z += 1;
    // the cabinet joystick is 4-way, like most Korean machines
    if (Math.abs(x) >= Math.abs(z)) z = 0;
    else x = 0;
    sim.input.x = Math.max(-1, Math.min(1, x));
    sim.input.z = Math.max(-1, Math.min(1, z));
  }

  // ---------- events ----------

  const STATE_TEXT = {
    idle: "코인을 넣어 주세요",
    drop: "내려가는 중…",
    grab: "잡는 중…",
    lift: "올라가는 중…",
    move: "출구로 이동 중…",
  };

  // several dolls can tumble into the chute together: gather them into one modal
  let modalWins = [];
  function showWin(type) {
    if (!winModal.isOpen()) modalWins = [];
    modalWins.push(type);
    winModal.open([...modalWins], modalWins.length > 1 ? `${modalWins.length}마리 뽑았다고~` : undefined);
  }

  function handleEvents() {
    for (const e of sim.events) {
      if (e.type === "won") {
        stats.won.push(e.doll.type);
        wonThisGame = true;
        renderShelf();
        showWin(e.doll.type);
      } else if (e.type === "state") {
        if (e.state === "idle" && !wonThisGame && !sim.broken) toast("아깝다! 다시 도전?");
        // the cabinet lights up pink while a coin is in
        if (!sim.broken) view.setPowered(e.state !== "idle");
        updateButtons();
      }
      dirty = 3;
    }
    sim.events.length = 0;
  }

  sky.onChange(() => {
    mirrorSky.needsUpdate = true;
    dirty = 3;
  });

  // ---------- main loop: fixed-step physics, render only when something moves ----------

  const resize = () => {
    view.resize();
    dirty = 3;
  };
  addEventListener("resize", resize);
  resize();
  updateButtons();
  renderShelf();

  let last = performance.now();
  let still = 0;

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    readInput();

    // When the claw is parked and every doll is asleep nothing can change, so both the physics
    // step and the GPU frame are skipped entirely (the sky keeps drifting on the CSS compositor).
    let awake = false;
    for (const d of sim.dolls)
      if (!d.body.isSleeping()) {
        awake = true;
        break;
      }
    const moving = view.update(dt);
    const active = sim.state !== "idle" || awake || dirty > 0 || moving;
    still = active ? 0 : still + 1;

    if (still <= 20) {
      sim.update(dt);
      handleEvents();
      syncDolls();
      view.syncClaw(sim);
      view.render();
      if (dirty > 0) dirty--;
    } else {
      sim.acc = 0;
    }

    if (sim.state === "play") $("status").textContent = `남은 시간 ${Math.ceil(sim.timeLeft)}초`;
    else $("status").textContent = STATE_TEXT[sim.state] ?? "";
  }
  if (new URLSearchParams(location.search).has("debug")) Object.assign(window, { sim, view, THREE, sky, winModal });
  $("loading").remove();
  requestAnimationFrame(frame);
}
