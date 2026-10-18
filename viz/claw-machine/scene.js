// Cabinet, lighting and claw visuals. Static parts are built once; only the claw and dolls move.

import * as THREE from "three";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { GTAOPass } from "three/addons/postprocessing/GTAOPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { DIM, PRONG_PATH, PRONG_RADIUS } from "./sim.js";

const { hx, hz, top, chute: CH, guardH } = DIM;
const LAYER_GLASS = 1; // transparent things the AO pass and the mirror should not see
const POST = 0.036;

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  draw(c.getContext("2d"), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function noise(g, w, h, amount) {
  const img = g.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * amount;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  g.putImageData(img, 0, 0);
}

const floorTexture = () =>
  canvasTexture(512, 512, (g, w, h) => {
    g.fillStyle = "#e05a92";
    g.fillRect(0, 0, w, h);
    noise(g, w, h, 26); // felt grain
  });

const signTexture = () =>
  canvasTexture(1024, 256, (g, w, h) => {
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, "#ffffff");
    grd.addColorStop(1, "#ffe6f1");
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    g.font = "150px 'Jua', 'Noto Sans KR', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineJoin = "round";
    g.lineWidth = 26;
    g.strokeStyle = "#ff7fb4";
    g.strokeText("인형뽑기", w / 2, h / 2 + 8);
    g.fillStyle = "#ffffff";
    g.fillText("인형뽑기", w / 2, h / 2 + 8);
    for (let i = 0; i < 26; i++) {
      // marquee bulbs along the edges
      g.fillStyle = i % 2 ? "#ffd1e4" : "#ffb3d2";
      g.beginPath();
      g.arc(20 + (i * (w - 40)) / 25, 16, 9, 0, 7);
      g.arc(20 + (i * (w - 40)) / 25, h - 16, 9, 0, 7);
      g.fill();
    }
  });

export function createScene(canvas) {
  // transparent canvas: the sky behind the machine is a CSS layer (sky.js), so it can drift
  // without forcing WebGL to redraw
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();

  // ---- camera: first person, standing at the machine, high enough to see the whole gantry ----
  // A lever swings the viewpoint around the machine up to ±90° so the player can judge depth
  // (does the claw reach the back?) the way you would by stepping to a front corner or the side.
  const camera = new THREE.PerspectiveCamera(40, 1, 0.05, 20);
  camera.layers.enable(LAYER_GLASS);
  const FRONT_POS = new THREE.Vector3(0, 1.55, 1.9);
  const FRONT_TARGET = new THREE.Vector3(0, 0.36, -0.05);
  const PIVOT = new THREE.Vector3(0, 0, -0.05);
  // zoom: 1 = default distance, smaller = closer (scroll wheel / pinch)
  const ZOOM_MIN = 0.45;
  const MAX_ANGLE = 90;
  const view = { angle: 0, target: 0, zoom: 1, zoomTarget: 1 };
  function placeCamera() {
    const a = (view.angle * Math.PI) / 180;
    const k = Math.min(1, Math.abs(view.angle) / 45); // corner framing, held from 45° on round to the side
    const off = FRONT_POS.clone()
      .sub(PIVOT)
      .applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
    camera.position.copy(PIVOT).add(off);
    camera.position.y = FRONT_POS.y - 0.04 * k;
    // at the corners look toward the back half, so the corner post sits off to one side
    const t = FRONT_TARGET.clone();
    t.x += Math.sign(view.angle) * -0.14 * k;
    t.z += -0.18 * k;
    camera.position.sub(t).multiplyScalar(view.zoom).add(t);
    camera.lookAt(t);
  }
  placeCamera();
  function setViewAngle(deg) {
    view.target = Math.max(-MAX_ANGLE, Math.min(MAX_ANGLE, deg));
  }
  function setZoom(z) {
    view.zoomTarget = Math.max(ZOOM_MIN, Math.min(1, z));
    return view.zoomTarget;
  }

  // ---- lights: one shadow-casting top light + soft fill ----
  scene.add(new THREE.HemisphereLight(0xfff4fb, 0x5a3550, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(0.08, 2.2, 0.35);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = -0.5;
  sc.right = 0.5;
  sc.top = 0.5;
  sc.bottom = -0.5;
  sc.near = 0.9;
  sc.far = 2.6;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.004;
  key.shadow.radius = 3;
  scene.add(key);
  const front = new THREE.PointLight(0xffe2f0, 0.35, 3, 2);
  front.position.set(0, 0.6, 0.8);
  scene.add(front);

  // ---- materials ----
  // The shell is white; when a coin goes in it warms to a soft pink glow (see setPowered).
  const SHELL_OFF = new THREE.Color(0xfbf8fa);
  const SHELL_ON = new THREE.Color(0xffd2e7);
  const shell = new THREE.MeshPhysicalMaterial({
    color: SHELL_OFF.clone(),
    roughness: 0.32,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    emissive: 0xff5fa2,
    emissiveIntensity: 0,
  });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xe8e8ec, metalness: 1, roughness: 0.18 });
  const darkMetal = new THREE.MeshStandardMaterial({ color: 0x2a2b31, metalness: 0.7, roughness: 0.4 });
  const glass = new THREE.MeshPhysicalMaterial({
    color: 0xeaf6ff,
    metalness: 0,
    roughness: 0.04,
    transparent: true,
    opacity: 0.07,
    envMapIntensity: 0.6,
    depthWrite: false,
  });
  const acrylic = new THREE.MeshPhysicalMaterial({
    color: 0xd8f3ff,
    roughness: 0.08,
    transparent: true,
    opacity: 0.22,
    envMapIntensity: 1.6,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // LED strips: unlit (plain diffuser, no glow) until a coin goes in, then HDR-bright pink so
  // they are the only thing that crosses the bloom threshold
  const LED_OFF = new THREE.Color(0xe9e4e7);
  const LED_ON = new THREE.Color(0xff6fae).multiplyScalar(16);
  const led = new THREE.MeshBasicMaterial({ color: LED_OFF.clone() });

  // everything pushed here never moves; it is merged into one mesh per material at the end
  const statics = [];
  const addStatic = (...meshes) => {
    for (const m of meshes) {
      m.receiveShadow = true;
      statics.push(m);
      scene.add(m);
    }
  };
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    addStatic(m);
    return m;
  };

  // ---- play field: felt floor (L-shape around the chute hole) ----
  const floorShape = new THREE.Shape();
  // shape y = -world z, so that rotating -90° about x maps it back with the normal facing up
  floorShape.moveTo(-hx, hz);
  floorShape.lineTo(hx, hz);
  floorShape.lineTo(hx, -hz);
  floorShape.lineTo(CH.x1, -hz);
  floorShape.lineTo(CH.x1, -CH.z0);
  floorShape.lineTo(-hx, -CH.z0);
  floorShape.closePath();
  const floorGeo = new THREE.ShapeGeometry(floorShape);
  floorGeo.rotateX(-Math.PI / 2);
  const fuv = floorGeo.attributes.uv;
  for (let i = 0; i < fuv.count; i++) fuv.setXY(i, fuv.getX(i) * 1.5, fuv.getY(i) * 1.5);
  const floorTex = floorTexture();
  floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
  addStatic(new THREE.Mesh(floorGeo, new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.95 })));

  // chute shaft (dark) + clear guard
  const shaftMat = new THREE.MeshStandardMaterial({ color: 0x141018, roughness: 0.9, side: THREE.BackSide });
  const shaft = new THREE.Mesh(new THREE.BoxGeometry(CH.x1 - CH.x0, 0.4, CH.z1 - CH.z0), shaftMat);
  shaft.position.set((CH.x0 + CH.x1) / 2, -0.2, (CH.z0 + CH.z1) / 2);
  addStatic(shaft);
  const guardA = new THREE.Mesh(new THREE.PlaneGeometry(hz - CH.z0, guardH), acrylic);
  guardA.rotation.y = Math.PI / 2;
  guardA.position.set(CH.x1, guardH / 2, (CH.z0 + hz) / 2);
  const guardB = new THREE.Mesh(new THREE.PlaneGeometry(CH.x1 - CH.x0, guardH), acrylic);
  guardB.position.set((CH.x0 + CH.x1) / 2, guardH / 2, CH.z0);
  addStatic(guardA, guardB);
  box(0.006, 0.006, hz - CH.z0, chrome, CH.x1, guardH, (CH.z0 + hz) / 2);
  box(CH.x1 - CH.x0, 0.006, 0.006, chrome, (CH.x0 + CH.x1) / 2, guardH, CH.z0);
  const exitTex = canvasTexture(256, 96, (g, w, h) => {
    g.fillStyle = "#ffe14d";
    g.font = "900 64px 'Noto Sans KR', sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("▼ 출구", w / 2, h / 2 + 4);
  });
  const exitSign = new THREE.Mesh(new THREE.PlaneGeometry(0.12, 0.045), new THREE.MeshBasicMaterial({ map: exitTex, transparent: true }));
  exitSign.layers.set(LAYER_GLASS);
  exitSign.position.set((CH.x0 + CH.x1) / 2, guardH * 0.55, CH.z0 + 0.002);
  scene.add(exitSign);

  // ---- cabinet ----
  // back panel: a real mirror (rendered at half resolution, and only when a frame is drawn)
  const mirror = new Reflector(new THREE.PlaneGeometry(2 * hx, top), {
    color: 0xb8c0c8,
    textureWidth: 512,
    textureHeight: 512,
    clipBias: 0.003,
    multisample: 0,
  });
  mirror.position.set(0, top / 2, -hz + 0.002);
  mirror.layers.set(LAYER_GLASS);
  scene.add(mirror);
  let mirrorSky = null;
  const reflect = mirror.onBeforeRender;
  mirror.onBeforeRender = function (r, s, c) {
    // the sky is a CSS layer, so give the reflection a painted copy of it
    const bg = s.background;
    s.background = mirrorSky;
    reflect.call(this, r, s, c);
    s.background = bg;
  };
  box(2 * hx, 0.02, 0.01, chrome, 0, 0.01, -hz + 0.006);

  // side glass (static) and the front glass (separate: it can shatter)
  for (const [x, ry] of [
    [-hx, Math.PI / 2],
    [hx, -Math.PI / 2],
  ]) {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(2 * hz, top), glass);
    p.position.set(x, top / 2, 0);
    p.rotation.y = ry;
    addStatic(p);
  }
  const frontGlass = new THREE.Mesh(new THREE.PlaneGeometry(2 * hx, top), glass);
  frontGlass.position.set(0, top / 2, hz);
  frontGlass.rotation.y = Math.PI;
  frontGlass.layers.set(LAYER_GLASS);
  frontGlass.renderOrder = 2;
  scene.add(frontGlass);
  // clear acrylic lid so the gantry and the hanging claw are visible from above
  const lid = new THREE.Mesh(new THREE.PlaneGeometry(2 * hx, 2 * hz), glass);
  lid.rotation.x = Math.PI / 2;
  lid.position.set(0, top + 0.06, 0);
  addStatic(lid);

  // frame: corner posts, a top frame around the lid, LED strips
  for (const sx of [-1, 1])
    for (const sz of [-1, 1]) {
      const h = top + 0.66 + (sz < 0 ? 0.3 : 0); // rear posts carry the marquee
      box(POST, h, POST, shell, sx * (hx + POST / 2), h / 2 - 0.6, sz * (hz + POST / 2));
      if (sz > 0) box(0.008, top - 0.06, 0.008, led, sx * (hx + 0.004), top / 2, hz + POST + 0.001);
    }
  for (const sz of [-1, 1]) box(2 * hx + 2 * POST, 0.05, POST, shell, 0, top + 0.035, sz * (hz + POST / 2));
  for (const sx of [-1, 1]) box(POST, 0.05, 2 * hz, shell, sx * (hx + POST / 2), top + 0.035, 0);
  box(2 * hx, 0.008, 0.008, led, 0, top + 0.004, hz - 0.004);
  for (const sx of [-1, 1]) box(0.008, 0.008, 2 * hz, led, sx * (hx - 0.004), top + 0.004, 0);
  // marquee sign over the back, facing the player
  box(2 * hx + 2 * POST, 0.3, 0.02, shell, 0, top + 0.21, -hz - POST / 2);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2 * hx, 0.26), new THREE.MeshBasicMaterial({ map: signTexture() }));
  sign.position.set(0, top + 0.21, -hz - POST / 2 + 0.011);
  addStatic(sign);
  // lower cabinet with the control panel
  box(2 * hx + 2 * POST, 0.6, POST, shell, 0, -0.302, hz + POST / 2);
  const panelZ = hz + POST + 0.11;
  box(2 * hx + 2 * POST, 0.05, 0.22, shell, 0, -0.045, panelZ);
  box(2 * hx + 2 * POST, 0.012, 0.012, led, 0, -0.072, panelZ + 0.11);

  // joystick + drop button (they move with the player's input)
  const knobMat = new THREE.MeshPhysicalMaterial({ color: 0xe8203a, roughness: 0.25, clearcoat: 1 });
  const stick = new THREE.Group();
  stick.position.set(-0.13, -0.02, panelZ);
  const shaftMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.07, 12), chrome);
  shaftMesh.position.y = 0.035;
  const knob = new THREE.Mesh(new THREE.SphereGeometry(0.021, 24, 16), knobMat);
  knob.position.y = 0.075;
  stick.add(shaftMesh, knob);
  const stickBase = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.034, 0.008, 24), darkMetal);
  stickBase.position.set(-0.13, -0.017, panelZ);
  scene.add(stick);
  addStatic(stickBase);
  const btnRing = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.01, 32), chrome);
  btnRing.position.set(0.13, -0.017, panelZ);
  const btn = new THREE.Mesh(
    new THREE.CylinderGeometry(0.03, 0.03, 0.016, 32),
    new THREE.MeshPhysicalMaterial({ color: 0x2f7bff, roughness: 0.2, clearcoat: 1, emissive: 0x0a2aff, emissiveIntensity: 0.35 })
  );
  btn.position.set(0.13, -0.008, panelZ);
  addStatic(btnRing);
  scene.add(btn);

  // ---- gantry: two rails, a bridge that rides them in x, a trolley that rides the bridge in z,
  // and the cable reel the claw hangs from ----
  const railY = top - 0.035;
  for (const sz of [-1, 1]) {
    const rail = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.007, 2 * hx, 14), chrome);
    rail.rotation.z = Math.PI / 2;
    rail.position.set(0, railY, sz * (hz - 0.014));
    addStatic(rail);
    for (const sx of [-1, 1]) box(0.02, 0.03, 0.03, darkMetal, sx * (hx - 0.01), railY + 0.01, sz * (hz - 0.014));
  }
  const bridge = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.016, 2 * hz - 0.03), chrome);
  const beam2 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.016, 2 * hz - 0.03), chrome);
  beam.position.x = -0.022;
  beam2.position.x = 0.022;
  bridge.add(beam, beam2);
  for (const sz of [-1, 1]) {
    // rollers riding the rails
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.028, 0.028), darkMetal);
    shoe.position.set(0, 0.006, sz * (hz - 0.014));
    bridge.add(shoe);
  }
  bridge.traverse((m) => (m.castShadow = true));
  scene.add(bridge);
  const trolley = new THREE.Group();
  const trolleyBody = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.032, 0.06), darkMetal);
  const motor = new THREE.Mesh(
    new THREE.CylinderGeometry(0.016, 0.016, 0.05, 18),
    new THREE.MeshStandardMaterial({ color: 0x3d6fd8, metalness: 0.5, roughness: 0.4 })
  );
  motor.rotation.z = Math.PI / 2;
  motor.position.set(0, 0.026, -0.01);
  const reel = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.02, 18), chrome);
  reel.rotation.z = Math.PI / 2;
  reel.position.set(0, -0.022, 0);
  trolley.add(trolleyBody, motor, reel);
  trolley.traverse((m) => (m.castShadow = true));
  scene.add(trolley);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.0018, 0.0018, 1, 6), new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }));
  scene.add(cable);

  const hub = new THREE.Group();
  const hubBody = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.033, 0.06, 32), chrome);
  const hubCap = new THREE.Mesh(new THREE.CylinderGeometry(0.036, 0.036, 0.016, 32), shell);
  hubCap.position.y = 0.034;
  const coil = new THREE.Mesh(
    new THREE.CylinderGeometry(0.02, 0.02, 0.02, 20),
    new THREE.MeshStandardMaterial({ color: 0xb87333, metalness: 1, roughness: 0.35 })
  );
  coil.position.y = 0.05;
  for (const m of [hubBody, hubCap, coil]) m.castShadow = true;
  hub.add(hubBody, hubCap, coil);
  scene.add(hub);

  const prongMat = new THREE.MeshStandardMaterial({ color: 0xd7d9de, metalness: 1, roughness: 0.22 });
  const prongs = [0, 1, 2].map((k) => {
    const phi = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
    const r = new THREE.Vector3(Math.cos(phi), 0, Math.sin(phi));
    const pts = PRONG_PATH.map(([u, y]) => r.clone().multiplyScalar(u).setY(y));
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    const tip = new THREE.SphereGeometry(PRONG_RADIUS * 1.25, 12, 8);
    tip.translate(...pts[pts.length - 1].toArray());
    const pin = new THREE.CylinderGeometry(0.004, 0.004, 0.018, 10);
    pin.rotateX(Math.PI / 2);
    pin.rotateY(-phi);
    const tube = new THREE.TubeGeometry(curve, 24, PRONG_RADIUS, 8, false);
    const mesh = new THREE.Mesh(mergeGeometries([tube, tip, pin]), prongMat);
    mesh.castShadow = true;
    scene.add(mesh);
    return mesh;
  });

  // merge static parts: dozens of draw calls become one per material
  const byMat = new Map();
  for (const m of statics) {
    m.updateMatrixWorld(true);
    const g = m.geometry.clone();
    g.applyMatrix4(m.matrixWorld);
    if (!byMat.has(m.material)) byMat.set(m.material, []);
    byMat.get(m.material).push(g);
    scene.remove(m);
    m.geometry.dispose();
  }
  for (const [mat, geos] of byMat) {
    const merged = new THREE.Mesh(mergeGeometries(geos), mat);
    merged.receiveShadow = !mat.transparent;
    merged.renderOrder = mat.transparent ? 2 : 0;
    merged.matrixAutoUpdate = false;
    if (mat.transparent) merged.layers.set(LAYER_GLASS);
    scene.add(merged);
  }

  // ---- machine power glow ----
  const power = { level: 0, target: 0 };
  function setPowered(on) {
    power.target = on ? 1 : 0;
  }

  // ---- hidden feature: the front glass shatters ----
  // Shards are one merged, CPU-animated geometry (one draw call), alive for ~2 s.
  let shards = null;
  const shardMat = new THREE.MeshPhysicalMaterial({
    color: 0xe6f6ff,
    roughness: 0.05,
    transparent: true,
    opacity: 0.6,
    envMapIntensity: 3,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  function shatter() {
    frontGlass.visible = false;
    const nx = 7,
      ny = 8;
    const pts = [];
    for (let j = 0; j <= ny; j++)
      for (let i = 0; i <= nx; i++) {
        const edge = i === 0 || j === 0 || i === nx || j === ny;
        const jx = edge ? 0 : (Math.random() - 0.5) * 0.7,
          jy = edge ? 0 : (Math.random() - 0.5) * 0.7;
        pts.push([-hx + ((i + jx) / nx) * 2 * hx, ((j + jy) / ny) * top]);
      }
    const tris = [];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = pts[j * (nx + 1) + i],
          b = pts[j * (nx + 1) + i + 1],
          c = pts[(j + 1) * (nx + 1) + i],
          d = pts[(j + 1) * (nx + 1) + i + 1];
        tris.push([a, b, d], [a, d, c]);
      }
    const n = tris.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(n * 9), 3));
    const list = tris.map((t) => {
      const cx = (t[0][0] + t[1][0] + t[2][0]) / 3,
        cy = (t[0][1] + t[1][1] + t[2][1]) / 3;
      return {
        local: t.map(([x, y]) => new THREE.Vector3(x - cx, y - cy, 0)),
        p: new THREE.Vector3(cx, cy, hz),
        v: new THREE.Vector3((Math.random() - 0.5) * 0.6 + cx * 0.8, Math.random() * 0.9 + 0.3, 0.35 + Math.random() * 0.8),
        q: new THREE.Quaternion(),
        w: new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize(),
        spin: 4 + Math.random() * 10,
      };
    });
    const mesh = new THREE.Mesh(geo, shardMat);
    mesh.frustumCulled = false;
    mesh.layers.set(LAYER_GLASS);
    scene.add(mesh);
    shards = { mesh, list, t: 0 };
    shake(0.012);
  }
  const _dq = new THREE.Quaternion(),
    _v = new THREE.Vector3();
  function updateShards(dt) {
    if (!shards) return false;
    shards.t += dt;
    const pos = shards.mesh.geometry.attributes.position;
    shards.list.forEach((s, i) => {
      s.v.y -= 9.8 * dt;
      s.p.addScaledVector(s.v, dt);
      s.q.premultiply(_dq.setFromAxisAngle(s.w, s.spin * dt));
      for (let k = 0; k < 3; k++) {
        _v.copy(s.local[k]).applyQuaternion(s.q).add(s.p);
        pos.setXYZ(i * 3 + k, _v.x, _v.y, _v.z);
      }
    });
    pos.needsUpdate = true;
    shards.mesh.geometry.computeVertexNormals();
    shardMat.opacity = 0.6 * Math.max(0, 1 - shards.t / 2);
    if (shards.t > 2) {
      scene.remove(shards.mesh);
      shards.mesh.geometry.dispose();
      shards = null;
    }
    return true;
  }
  function restoreGlass() {
    frontGlass.visible = true;
  }

  let shakeAmp = 0;
  function shake(amount) {
    shakeAmp = Math.max(shakeAmp, amount);
  }

  // per-frame animation of everything the scene owns; returns true while anything moves
  function update(dt) {
    let moving = false;
    const d = view.target - view.angle;
    const dz = view.zoomTarget - view.zoom;
    if (Math.abs(d) > 0.02 || Math.abs(dz) > 0.0005 || shakeAmp > 0) {
      const ease = 1 - Math.exp(-dt * 9);
      view.angle += d * ease;
      view.zoom += dz * ease;
      placeCamera();
      if (shakeAmp > 0) {
        camera.position.x += (Math.random() - 0.5) * shakeAmp;
        camera.position.y += (Math.random() - 0.5) * shakeAmp;
        shakeAmp = Math.max(0, shakeAmp - dt * 0.012);
      }
      moving = true;
    }
    if (Math.abs(power.target - power.level) > 0.001) {
      power.level += Math.sign(power.target - power.level) * Math.min(Math.abs(power.target - power.level), dt / 0.6);
      shell.color.lerpColors(SHELL_OFF, SHELL_ON, power.level);
      shell.emissiveIntensity = 0.32 * power.level;
      led.color.lerpColors(LED_OFF, LED_ON, power.level);
      moving = true;
    }
    if (updateShards(dt)) moving = true;
    return moving;
  }

  // ---- post-processing (high quality): ambient occlusion between plushies + LED glow ----
  // Glass and the mirror live on their own layer so the AO pass, which renders through a twin
  // camera, sees straight through them.
  const aoCamera = camera.clone();
  let composer = null;
  let high = false;
  function buildComposer() {
    const rt = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    const gtao = new GTAOPass(scene, aoCamera, 1, 1);
    gtao.blendIntensity = 0.85;
    gtao.updateGtaoMaterial({ radius: 0.07, distanceExponent: 1.4, thickness: 1, scale: 1, samples: 12 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    composer.addPass(gtao);
    // threshold above anything lit (sunlit white shell ≈ 4) so only powered LEDs bloom
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(1, 1), 0.5, 0.35, 7));
    composer.addPass(new OutputPass());
  }
  function setQuality(isHigh) {
    high = isHigh;
    if (high && !composer) buildComposer();
    key.shadow.mapSize.set(high ? 2048 : 1024, high ? 2048 : 1024);
    if (key.shadow.map) {
      key.shadow.map.dispose();
      key.shadow.map = null;
    }
    resize();
  }
  function render() {
    if (!high) return renderer.render(scene, camera);
    aoCamera.copy(camera);
    aoCamera.layers.set(0);
    composer.render();
  }

  function resize() {
    const w = canvas.clientWidth,
      h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    if (composer) {
      composer.setPixelRatio(renderer.getPixelRatio());
      composer.setSize(w, h);
    }
    const pr = renderer.getPixelRatio();
    mirror.getRenderTarget().setSize(Math.round((w * pr) / 2), Math.round((h * pr) / 2));
    camera.aspect = w / h;
    // keep the full machine width in view on portrait screens
    const hfov = 2 * Math.atan(0.58 / 2.1);
    const needV = (2 * Math.atan(Math.tan(hfov / 2) / camera.aspect) * 180) / Math.PI;
    camera.fov = Math.min(80, Math.max(40, needV));
    camera.updateProjectionMatrix();
  }

  const _q = new THREE.Quaternion();
  function syncClaw(sim) {
    const hp = sim.hub.translation();
    const s = sim.clawScale; // the prong meshes are built at size 100%, about their hinge
    hub.position.set(hp.x, hp.y, hp.z);
    hub.scale.setScalar(s);
    bridge.position.set(hp.x, railY, 0);
    trolley.position.set(hp.x, railY - 0.002, hp.z);
    reel.rotation.x = hp.y * 60; // the reel turns as the cable pays out
    const cy0 = railY - 0.03,
      cy1 = hp.y + 0.06 * s;
    cable.position.set(hp.x, (cy0 + cy1) / 2, hp.z);
    cable.scale.y = Math.max(0.001, cy0 - cy1);
    sim.prongs.forEach((p, i) => {
      const t = p.body.translation();
      const q = p.body.rotation();
      prongs[i].position.set(t.x, t.y, t.z);
      prongs[i].quaternion.copy(_q.set(q.x, q.y, q.z, q.w));
      prongs[i].scale.setScalar(s);
    });
    stick.rotation.set(-sim.input.z * 0.32, 0, -sim.input.x * 0.32);
    btn.position.y = sim.state === "drop" && sim.t < 0.35 ? -0.013 : -0.008;
  }

  function setMirrorSky(texture) {
    mirrorSky = texture;
  }

  return {
    renderer,
    scene,
    camera,
    MAX_ANGLE,
    resize,
    syncClaw,
    render,
    setQuality,
    setViewAngle,
    setZoom,
    update,
    setPowered,
    shatter,
    restoreGlass,
    shake,
    setMirrorSky,
  };
}
