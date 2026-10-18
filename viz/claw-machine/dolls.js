// Procedural plush geometry. Every character is merged into ONE BufferGeometry with vertex
// colors, so all dolls of a kind render as a single InstancedMesh draw call and every doll in
// the machine shares one material. Faces are printed into a shared texture atlas (uv1) and
// mapped onto a patch that hugs the front of the head, like the printed/embroidered face of
// a real plush; everything else samples a white texel and keeps its vertex color.

import * as THREE from "three";
import { mergeGeometries, mergeVertices } from "three/addons/utils/BufferGeometryUtils.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { CHARACTERS } from "./characters.js";

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1);
const Y = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();

// face atlas: 4 x 2 cells; the last cell is plain white for non-face parts
const CELL = 256;
const COLS = 4;
const ROWS = 2;
const WHITE_UV = [(COLS - 0.5) / COLS, 0.5 / ROWS];
const FACE = { A: 1.1, top: 0.8, bottom: -0.85 }; // patch extent: azimuth ±A, elevation range (rad)
const MARGIN = 0.02;

function cellUV(index, u, v) {
  const cx = index % COLS,
    cy = Math.floor(index / COLS);
  const uu = MARGIN + u * (1 - 2 * MARGIN),
    vv = MARGIN + v * (1 - 2 * MARGIN);
  return [(cx + uu) / COLS, 1 - (cy + 1) / ROWS + vv / ROWS];
}

function headColorFn(c) {
  const base = new THREE.Color(c.colors.base);
  const accent = new THREE.Color(c.colors.accent);
  if (c.pattern !== "hachiware") return () => base;
  // two-tone "hachi" split: blue cap over the head with a white inverted V down the forehead
  return (nx, ny, nz) => {
    const forehead = nz > 0.25 && Math.abs(nx) < 0.5 * (0.78 - ny);
    const cap = (ny > 0.08 || (nz < -0.25 && ny > -0.45)) && !forehead;
    return cap ? accent : base;
  };
}

function paint(geo, colorOrFn, uv1) {
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    if (typeof colorOrFn === "function") {
      const x = pos.getX(i),
        y = pos.getY(i),
        z = pos.getZ(i);
      const l = Math.hypot(x, y, z) || 1;
      c.copy(colorOrFn(x / l, y / l, z / l));
    } else c.set(colorOrFn);
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
  if (!uv1) {
    uv1 = new Float32Array(pos.count * 2);
    for (let i = 0; i < pos.count; i++) uv1.set(WHITE_UV, i * 2);
  }
  geo.setAttribute("uv1", new THREE.BufferAttribute(uv1, 2));
  return geo;
}

class Builder {
  constructor() {
    this.parts = [];
  }
  // geo is built around the origin, painted in its own space, then placed
  add(geo, color, pos, quat = IDENTITY, scale = [1, 1, 1], uv1) {
    paint(geo, color, uv1);
    _m.compose(_v.set(...pos), quat, _s.set(...scale));
    geo.applyMatrix4(_m);
    this.parts.push(geo);
  }
  build() {
    const g = mergeGeometries(this.parts);
    for (const p of this.parts) p.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

const sphere = (r, w = 20, h = 14) => new THREE.SphereGeometry(r, w, h);

// point and outward normal on the head ellipsoid at azimuth a (0 = front) and elevation e
function onHead(head, a, e, lift = 0) {
  const d = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  const n = new THREE.Vector3(d.x / head.sx, d.y / head.sy, d.z / head.sz).normalize();
  const p = new THREE.Vector3(d.x * head.r * head.sx, head.y + d.y * head.r * head.sy, d.z * head.r * head.sz);
  p.addScaledVector(n, lift);
  return { p: p.toArray(), n, q: new THREE.Quaternion().setFromUnitVectors(Z, n) };
}

// ---------- face texture ----------

const INK = "#231d24";
const MOUTH = "#5b2231";
const TONGUE = "#f0808f";

function drawFace(g, c, ox, oy) {
  const S = CELL;
  const f = c.face;
  const h = c.head;
  const hex = (n) => "#" + new THREE.Color(n).getHexString();
  // base: the head's own colors, pixel by pixel, so the patch blends into the head
  const colorAt = headColorFn(c);
  const img = g.createImageData(S, S);
  const bytes = new Map();
  for (let py = 0; py < S; py++) {
    const e = FACE.top - ((py + 0.5) / S) * (FACE.top - FACE.bottom);
    for (let px = 0; px < S; px++) {
      const a = -FACE.A + ((px + 0.5) / S) * 2 * FACE.A;
      const col = colorAt(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
      if (!bytes.has(col)) bytes.set(col, col.getRGB({}, THREE.SRGBColorSpace));
      const rgb = bytes.get(col);
      const i = (py * S + px) * 4;
      img.data[i] = rgb.r * 255;
      img.data[i + 1] = rgb.g * 255;
      img.data[i + 2] = rgb.b * 255;
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, ox, oy); // putImageData ignores the canvas transform

  // draw in "surface units": 1 = head radius along the surface, +v up
  g.save();
  g.translate(S / 2, (FACE.top / (FACE.top - FACE.bottom)) * S);
  g.scale(S / (2 * FACE.A) / h.sx, -S / (FACE.top - FACE.bottom) / h.sy);
  const ell = (x, y, rx, ry, fill, rot = 0) => {
    g.beginPath();
    g.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
    g.fillStyle = fill;
    g.fill();
  };
  const stroke = (w, color) => {
    g.lineWidth = w;
    g.strokeStyle = color;
    g.lineCap = "round";
    g.lineJoin = "round";
    g.stroke();
  };

  const mouthY = f.muzzle ? -0.34 : -0.2;
  if (f.muzzle) ell(0, -0.3, 0.42, 0.28, hex(c.colors.accent));

  for (const s of [-1, 1]) {
    // blush with the little diagonal hatch lines
    const bx = s * 0.72,
      by = -0.17;
    g.globalAlpha = 0.9;
    ell(bx, by, 0.15, 0.085, hex(c.colors.blush));
    g.globalAlpha = 0.55;
    for (let i = -1; i <= 1; i++) {
      g.beginPath();
      g.moveTo(bx + i * 0.06 + 0.025, by + 0.045);
      g.lineTo(bx + i * 0.06 - 0.025, by - 0.045);
      stroke(0.016, "#e0607f");
    }
    g.globalAlpha = 1;

    const ex = s * 0.36;
    if (f.eyes === "big") {
      ell(ex, 0, 0.1, 0.14, INK);
      ell(ex - 0.025, 0.05, 0.045, 0.05, "#ffffff");
      ell(ex + 0.035, -0.07, 0.018, 0.02, "#ffffff");
    } else if (f.eyes === "small") {
      ell(ex, 0.01, 0.07, 0.095, INK);
      ell(ex - 0.018, 0.04, 0.028, 0.032, "#ffffff");
    } else if (f.eyes === "dot") {
      ell(ex, 0.02, 0.055, 0.07, INK);
      ell(ex - 0.015, 0.04, 0.02, 0.022, "#ffffff");
    } else if (f.eyes === "side") {
      // momonga's sly sideways glance
      g.beginPath();
      g.ellipse(ex, 0.0, 0.14, 0.085, 0, 0, Math.PI * 2);
      g.fillStyle = "#ffffff";
      g.fill();
      stroke(0.035, INK);
      ell(ex + s * 0.055, -0.005, 0.07, 0.07, INK);
      ell(ex + s * 0.035, 0.02, 0.022, 0.022, "#ffffff");
    }
    if (f.brows) {
      g.beginPath();
      g.moveTo(ex - s * 0.075, 0.25);
      g.lineTo(ex + s * 0.055, 0.215);
      stroke(0.028, INK);
    }
  }

  if (f.nose === true) {
    ell(0, -0.08, 0.1, 0.07, hex(c.colors.accent));
    ell(-0.025, -0.06, 0.03, 0.02, "rgba(255,255,255,0.7)");
  } else if (f.nose === "dark") {
    ell(0, -0.17, 0.055, 0.038, INK);
  }

  if (f.mouth === "omega") {
    g.beginPath();
    g.moveTo(-0.065, mouthY + 0.012);
    g.quadraticCurveTo(-0.033, mouthY - 0.05, 0, mouthY);
    g.quadraticCurveTo(0.033, mouthY - 0.05, 0.065, mouthY + 0.012);
    stroke(0.022, INK);
  } else if (f.mouth === "smile" || f.mouth === "yell") {
    const w = f.mouth === "yell" ? 0.085 : 0.08,
      d = f.mouth === "yell" ? 0.2 : 0.15;
    g.save();
    g.beginPath();
    g.moveTo(-w, mouthY + 0.02);
    g.quadraticCurveTo(0, mouthY - d, w, mouthY + 0.02);
    g.closePath();
    g.fillStyle = MOUTH;
    g.fill();
    g.clip();
    ell(0, mouthY - d * 0.55, w * 0.65, d * 0.3, TONGUE);
    g.restore();
  } else if (f.mouth === "teeth") {
    ell(0, -0.24, 0.055, 0.05, MOUTH);
    g.fillStyle = "#ffffff";
    g.fillRect(-0.034, -0.19, 0.03, -0.03);
    g.fillRect(0.004, -0.19, 0.03, -0.03);
  }
  g.restore();
}

function faceAtlas() {
  const canvas = document.createElement("canvas");
  canvas.width = CELL * COLS;
  canvas.height = CELL * ROWS;
  const g = canvas.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  CHARACTERS.forEach((c, i) => {
    g.save();
    g.translate((i % COLS) * CELL, Math.floor(i / COLS) * CELL);
    g.beginPath();
    g.rect(0, 0, CELL, CELL);
    g.clip();
    drawFace(g, c, (i % COLS) * CELL, Math.floor(i / COLS) * CELL);
    g.restore();
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.channel = 1; // sampled with uv1
  tex.anisotropy = 8;
  return tex;
}

// ---------- geometry ----------

function buildCharacter(c, index) {
  const b = new Builder();
  const h = c.head;
  const col = c.colors;

  // head + the face patch printed on its front
  b.add(sphere(h.r, 48, 32), headColorFn(c), [0, h.y, 0], IDENTITY, [h.sx, h.sy, h.sz]);
  const patch = new THREE.SphereGeometry(h.r * 1.002, 40, 32, Math.PI / 2 - FACE.A, 2 * FACE.A, Math.PI / 2 - FACE.top, FACE.top - FACE.bottom);
  const uv = patch.attributes.uv;
  const uv1 = new Float32Array(uv.count * 2);
  for (let i = 0; i < uv.count; i++) uv1.set(cellUV(index, uv.getX(i), uv.getY(i)), i * 2);
  b.add(patch, 0xffffff, [0, h.y, 0], IDENTITY, [h.sx, h.sy, h.sz], uv1);

  // body melts into the head like mochi; stubby arms and feet
  const br = c.body.r;
  b.add(sphere(br, 32, 20), col.base, [0, c.body.y, 0], IDENTITY, [1.08, 0.92, 0.95]);
  for (const s of [-1, 1]) {
    const arm = new THREE.Quaternion().setFromAxisAngle(Z, s * 0.6);
    b.add(sphere(0.013, 14, 10), col.base, [s * br * 0.92, c.body.y + 0.008, br * 0.3], arm, [1, 1.45, 1]);
    b.add(sphere(0.016, 14, 10), col.base, [s * 0.02, c.body.y - br * 0.76, br * 0.42], IDENTITY, [1, 0.7, 1.25]);
  }

  // ears: placed on the head surface, standing along its normal
  const ear = (a, e, geo, color, scale, lean = 0, lift = -0.004, upright = false) => {
    const { p, n } = onHead(h, a, e, lift);
    const q = upright ? new THREE.Quaternion() : new THREE.Quaternion().setFromUnitVectors(Y, n);
    q.multiply(new THREE.Quaternion().setFromAxisAngle(Z, lean));
    b.add(geo, color, p, q, scale);
  };
  for (const s of [-1, 1]) {
    if (c.ears === "bear") ear(s * 0.95, 0.95, sphere(0.015, 14, 10), col.base, [1, 0.9, 0.7]);
    if (c.ears === "small") ear(s * 1.2, 0.85, sphere(0.013, 12, 8), col.base, [1, 0.85, 0.7]);
    if (c.ears === "cat") {
      const cone = new THREE.ConeGeometry(0.019, 0.032, 18, 1);
      cone.translate(0, 0.011, 0);
      ear(s * 0.95, 0.9, cone, col.accent, [1, 1, 0.55]);
    }
    if (c.ears === "rabbit") {
      // long, parallel and nearly vertical, like the plush
      const cap = new THREE.CapsuleGeometry(0.0115, 0.062, 8, 16);
      cap.translate(0, 0.04, 0);
      ear(s * 0.3, 1.2, cap, col.base, [1, 1, 0.62], -s * 0.06, -0.01, true);
    }
    if (c.ears === "round") {
      ear(s * 1.0, 0.72, sphere(0.021, 18, 12), col.base, [1, 1, 0.42], 0, -0.002);
      ear(s * 1.0, 0.72, sphere(0.0135, 14, 10), col.accent, [1, 1, 0.3], 0, 0.004);
    }
  }
  if (c.tuft) ear(0, 1.2, sphere(0.014, 14, 10), col.accent, [1.3, 0.75, 1.1], 0, -0.002);

  if (c.tail) {
    const t = c.tail;
    b.add(sphere(t.r, 24, 16), col.base, [0, t.y + 0.02, t.z], IDENTITY, [1.15, 1.45, 0.85]);
  }
  if (c.mane) {
    // curly mane: two staggered rows of small tufts framing the face
    for (const [n, rr, z, sz] of [
      [15, 1.0, -0.006, 0.0125],
      [14, 0.86, -0.024, 0.0135],
    ]) {
      for (let i = 0; i < n; i++) {
        const ang = (i / (n - 1)) * Math.PI * 1.3 - Math.PI * 0.15 + (rr < 1 ? 0.06 : 0);
        const x = Math.cos(ang) * h.r * h.sx * rr;
        const y = h.y + Math.sin(ang) * h.r * h.sy * rr - 0.004;
        b.add(sphere(sz, 10, 7), col.accent, [x, y, z], IDENTITY, [1, 1, 0.8]);
      }
    }
  }
  return b.build();
}

function fabricNormalMap(size = 128) {
  // knit-like fuzz: random short fibers baked into a tiling height field, then to normals
  const h = new Float32Array(size * size);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let k = 0; k < size * size * 0.6; k++) {
    const x0 = rnd() * size,
      y0 = rnd() * size,
      a = rnd() * Math.PI,
      len = 2 + rnd() * 4,
      amp = 0.4 + rnd() * 0.6;
    for (let t = 0; t < len; t++) {
      const x = Math.floor(x0 + Math.cos(a) * t + size) % size;
      const y = Math.floor(y0 + Math.sin(a) * t + size) % size;
      h[y * size + x] += amp;
    }
  }
  const data = new Uint8Array(size * size * 4);
  const n = new THREE.Vector3();
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)];
      const dy = h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x];
      n.set(-dx * 0.35, -dy * 0.35, 1).normalize();
      const i = (y * size + x) * 4;
      data[i] = (n.x * 0.5 + 0.5) * 255;
      data[i + 1] = (n.y * 0.5 + 0.5) * 255;
      data[i + 2] = (n.z * 0.5 + 0.5) * 255;
      data[i + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(5, 3);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

let fabricNormal = null;
const fabric = () => (fabricNormal ??= fabricNormalMap());

export function createDollMaterial() {
  return new THREE.MeshPhysicalMaterial({
    vertexColors: true,
    map: faceAtlas(),
    roughness: 0.9,
    sheen: 1,
    sheenRoughness: 0.5,
    sheenColor: new THREE.Color(0.6, 0.6, 0.6),
    normalMap: fabric(),
    normalScale: new THREE.Vector2(0.4, 0.4),
  });
}

// ---------- scanned / sculpted glTF models ----------

// Bakes a glTF scene (including a skinned rest pose) into one static geometry with one group per
// material, scaled and placed to fit the character's physics hull, so it can be instanced like
// the procedural dolls. Materials are rebuilt as plush fabric that keeps the model's colors.
async function loadModel(c) {
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const gltf = await loader.loadAsync(c.model.url);
  const root = gltf.scene;
  root.updateMatrixWorld(true);
  const parts = new Map(); // source material -> geometries
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.geometry;
    const pos = src.attributes.position;
    const P = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      if (o.isSkinnedMesh) o.getVertexPosition(i, v);
      else v.fromBufferAttribute(pos, i);
      v.applyMatrix4(o.matrixWorld);
      v.toArray(P, i * 3);
    }
    let g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(P, 3));
    if (src.attributes.uv) {
      const uv = src.attributes.uv;
      const U = new Float32Array(uv.count * 2);
      for (let i = 0; i < uv.count; i++) U.set([uv.getX(i), uv.getY(i)], i * 2);
      g.setAttribute("uv", new THREE.BufferAttribute(U, 2));
    }
    if (src.attributes.color) {
      // vertex-painted models (e.g. Shisa) keep their colors. The spec says COLOR_0 is linear,
      // but this exporter wrote sRGB values, so convert or everything looks washed out.
      const col = src.attributes.color;
      const C = new Float32Array(col.count * 3);
      const c = new THREE.Color();
      for (let i = 0; i < col.count; i++) {
        c.setRGB(col.getX(i), col.getY(i), col.getZ(i), THREE.SRGBColorSpace);
        C.set([c.r, c.g, c.b], i * 3);
      }
      g.setAttribute("color", new THREE.BufferAttribute(C, 3));
      g.userData.vertexColors = true;
    }
    if (src.index) g.setIndex(Array.from(src.index.array));
    if (!parts.has(o.material)) parts.set(o.material, []);
    parts.get(o.material).push(g);
  });

  // fit to the character's size: height from the spec, centered, standing on the body bottom
  const geos = [],
    mats = [];
  for (const [m, list] of parts) {
    geos.push(list.length > 1 ? mergeGeometries(list) : list[0]);
    mats.push(m);
  }
  const box = new THREE.Box3();
  for (const g of geos) {
    g.computeBoundingBox();
    box.union(g.boundingBox);
  }
  const size = box.getSize(new THREE.Vector3());
  const k = c.model.height / size.y;
  const bottom = c.body.y - c.body.r;
  const fit = new THREE.Matrix4()
    .makeTranslation(0, bottom, 0)
    .multiply(new THREE.Matrix4().makeRotationY(c.model.rotY || 0))
    .multiply(new THREE.Matrix4().makeScale(k, k, k))
    .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));

  const out = [];
  geos.forEach((g, i) => {
    g.applyMatrix4(fit);
    const vertexColors = !!g.userData.vertexColors;
    if (!vertexColors) {
      // every merged part needs the same attributes: plain white where the model has none
      const W = new Float32Array(g.attributes.position.count * 3).fill(1);
      g.setAttribute("color", new THREE.BufferAttribute(W, 3));
    }
    // smooth shading from welded positions; give uv-less parts a wrap-around uv for the fabric
    if (!g.attributes.uv) {
      const p = g.attributes.position;
      const U = new Float32Array(p.count * 2);
      for (let j = 0; j < p.count; j++) U.set([Math.atan2(p.getX(j), p.getZ(j)) / (2 * Math.PI) + 0.5, p.getY(j) * 12], j * 2);
      g.setAttribute("uv", new THREE.BufferAttribute(U, 2));
      g = mergeVertices(g, 1e-5);
    }
    g.computeVertexNormals();
    out.push(g);
    const src = mats[i];
    const color = src.color ? src.color.clone() : new THREE.Color(1, 1, 1);
    const dark = color.r + color.g + color.b < 0.15;
    mats[i] = new THREE.MeshPhysicalMaterial({
      color,
      vertexColors: true,
      map: src.map || null,
      roughness: dark ? 0.35 : 0.9, // glossy plastic eyes vs. fuzzy fabric
      sheen: dark ? 0 : 1,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(0.6, 0.6, 0.6),
      normalMap: dark ? null : fabric(),
      normalScale: new THREE.Vector2(0.4, 0.4),
      side: THREE.DoubleSide,
    });
  });
  const geometry = mergeGeometries(out, true);
  geometry.computeBoundingSphere();
  return { geometry, material: mats, bounds: new THREE.Box3().setFromBufferAttribute(geometry.attributes.position) };
}

export async function createDollMeshes(scene, capacity) {
  const material = createDollMaterial();
  const built = await Promise.all(CHARACTERS.map(async (c, i) => (c.model ? loadModel(c) : { geometry: buildCharacter(c, i), material })));
  return built.map(({ geometry, material: mat, bounds }, i) => {
    if (bounds) CHARACTERS[i].modelBounds = bounds;
    const mesh = new THREE.InstancedMesh(geometry, mat, capacity);
    mesh.count = 0;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false; // the whole machine is always in view
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(mesh);
    return mesh;
  });
}
