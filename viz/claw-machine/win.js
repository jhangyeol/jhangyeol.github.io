// "You got it!" modal: the won doll spins and sparkles in its own small WebGL view.
// The renderer is created on first win and reused; it only renders while the modal is open.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { CHARACTERS } from "./characters.js";

const $ = (id) => document.getElementById(id);

export function createWinModal(meshes) {
  const root = $("win");
  const canvas = $("win-canvas");
  let gl = null;
  let open = false;
  let t = 0;
  let last = 0;
  let types = [0];
  let shown = -1;
  let onClose = null;

  // CSS sparkles scattered around the doll
  const sparkles = $("win-sparkles");
  for (let i = 0; i < 16; i++) {
    const s = document.createElement("i");
    const a = Math.random() * Math.PI * 2,
      r = 38 + Math.random() * 14;
    s.style.left = 50 + Math.cos(a) * r + "%";
    s.style.top = 46 + Math.sin(a) * r * 0.9 + "%";
    s.style.animationDelay = (Math.random() * 1.4).toFixed(2) + "s";
    s.style.fontSize = 12 + Math.random() * 16 + "px";
    s.textContent = i % 3 ? "✦" : "✧";
    sparkles.appendChild(s);
  }

  function setup() {
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environmentIntensity = 0.6;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(0.4, 1, 1);
    // decay 0: the lights sit a few cm from the doll, physical falloff would blow it out to white
    const rimA = new THREE.PointLight(0xff7fc0, 0, 0, 0);
    rimA.position.set(-0.25, 0.1, -0.15);
    const rimB = new THREE.PointLight(0x7fd8ff, 0, 0, 0);
    rimB.position.set(0.25, 0.12, -0.15);
    const glint = new THREE.PointLight(0xffffff, 0, 0, 0);
    scene.add(key, rimA, rimB, glint, new THREE.HemisphereLight(0xffffff, 0xffd6e8, 0.45));
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 5);
    camera.position.set(0, 0.03, 0.52);
    camera.lookAt(0, 0.012, 0);
    const doll = new THREE.Mesh(meshes[0].geometry, meshes[0].material);
    scene.add(doll);
    gl = { renderer, scene, camera, doll, rimA, rimB, glint };
  }

  function frame(now) {
    if (!open) return;
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000 || 0);
    last = now;
    t += dt;
    const { renderer, scene, camera, doll, rimA, rimB, glint } = gl;
    // several prizes (the smashed machine): show them one after another
    const idx = Math.floor(t / 1.6) % types.length;
    if (idx !== shown) {
      shown = idx;
      doll.geometry = meshes[types[idx]].geometry;
      doll.material = meshes[types[idx]].material;
    }
    // pop in with a little overshoot, then spin and bob
    const pop = t < 0.6 ? 1 + Math.sin((t / 0.6) * Math.PI) * 0.25 - (1 - t / 0.6) * 0.9 : 1;
    doll.scale.setScalar(Math.max(0.05, pop));
    doll.rotation.y = Math.sin(t * 0.9) * 0.5 + t * 1.6 * (t > 1.2 ? 1 : t / 1.2); // face the player first, then spin
    doll.position.y = Math.sin(t * 3) * 0.008;
    // twinkling rim lights + a glint that sweeps over the plush
    rimA.intensity = 0.5 + 0.3 * Math.sin(t * 7);
    rimB.intensity = 0.5 + 0.3 * Math.sin(t * 7 + 2);
    glint.position.set(Math.sin(t * 2 + 1) * 0.12, 0.08, 0.18);
    glint.intensity = 0.35 * Math.max(0, Math.sin(t * 5));
    renderer.render(scene, camera);
  }

  function resize() {
    const s = canvas.clientWidth;
    gl.renderer.setSize(s, s, false);
  }

  // list: doll types to show; title defaults to "<name> 뽑았다고~"; done: called on close
  function show(list, title, done = null) {
    types = list;
    shown = -1;
    onClose = done;
    $("win-name").textContent = title || `${CHARACTERS[list[0]].name} 뽑았다고~`;
    root.classList.add("show");
    if (!gl) setup();
    resize();
    t = 0;
    last = performance.now();
    if (!open) {
      open = true;
      requestAnimationFrame(frame);
    }
    $("win-close").focus();
  }

  function close() {
    open = false;
    root.classList.remove("show");
    const f = onClose;
    onClose = null;
    if (f) f();
  }

  $("win-close").onclick = close;
  root.addEventListener("click", (e) => e.target === root && close());

  return { open: show, close, isOpen: () => open };
}
