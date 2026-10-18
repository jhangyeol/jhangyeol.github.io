// Claw-machine physics. Pure logic on top of Rapier (no rendering), so it also runs in Node for tuning.
//
// The claw is modelled like a real one: three dynamic prongs hinged on a kinematic hub. A return
// spring always pushes each prong open, and a force-limited joint motor (the solenoid "coil")
// pulls it shut. The operator's power setting is the coil's torque cap, so a low setting leaves
// the spring nearly winning: the claw closes limply and lets the doll's weight pry it open.

import { CHARACTERS } from "./characters.js";

export const DIM = {
  hx: 0.4, // play-field half width (x)
  hz: 0.34, // play-field half depth (z, +z faces the player)
  top: 0.95,
  chute: { x0: -0.4, x1: -0.15, z0: 0.09, z1: 0.34 },
  guardH: 0.1,
};
export const HUB_TOP_Y = 0.74;
const HUB_MIN_Y = 0.19;

// Prong profile in (radial u, vertical y) relative to its hinge; drawn and collided identically.
export const HINGE_R = 0.03;
export const HINGE_Y = -0.036;
export const PRONG_PATH = [
  [0, 0],
  [0.038, -0.078],
  [0.014, -0.13],
  [-0.02, -0.15],
];
export const PRONG_RADIUS = 0.0055;
const PRONG_OPEN = 0.95; // rad, positive = tip swings outward

// How far the open claw reaches from the hub axis in ±x and ±z, from the actual prong geometry,
// so the gantry can stop the claw just before it touches a wall.
function clawReach() {
  const r = { x0: 0, x1: 0, z0: 0, z1: 0 };
  for (let k = 0; k < 3; k++) {
    const phi = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
    for (const [u, y] of PRONG_PATH) {
      // swing the profile point open about the hinge, then out by the hinge radius
      const radial = HINGE_R + u * Math.cos(PRONG_OPEN) - y * Math.sin(PRONG_OPEN) + PRONG_RADIUS * 1.25;
      const x = Math.cos(phi) * radial,
        z = Math.sin(phi) * radial;
      r.x0 = Math.min(r.x0, x);
      r.x1 = Math.max(r.x1, x);
      r.z0 = Math.min(r.z0, z);
      r.z1 = Math.max(r.z1, z);
    }
  }
  return r;
}
const REACH = clawReach();
const WALL_GAP = 0.006;
const HUB_RANGE = {
  x0: -DIM.hx - REACH.x0 + WALL_GAP,
  x1: DIM.hx - REACH.x1 - WALL_GAP,
  z0: -DIM.hz - REACH.z0 + WALL_GAP,
  z1: DIM.hz - REACH.z1 - WALL_GAP,
};
// parking spot over the chute, pulled in if the chute's center is closer to a wall than the claw allows
export const HOME = {
  x: Math.max(HUB_RANGE.x0, (DIM.chute.x0 + DIM.chute.x1) / 2),
  z: Math.min(HUB_RANGE.z1, (DIM.chute.z0 + DIM.chute.z1) / 2),
};
const PRONG_SHUT = -0.35; // motor target past the limit so the claw keeps squeezing
const PRONG_LIMIT = [-0.18, 1.0];

// Korean operator boards expose power as 1..48; we map it linearly onto coil torque.
export const POWER_MAX = 48;
export const TAU_FULL = 0.11; // N·m of coil torque at power 48 (tuned headless in Node)
const TAU_OPEN = 0.05;
export const TAU_SPRING = 0.05; // return spring, always on
const MOTOR_STIFF = 4;
const MOTOR_DAMP = 0.02;

export const STEP = 1 / 120;
const MAX_SUBSTEPS = 6;
const MAX_DOLLS = 60;
const PLAY_TIME = 30;

const G_STATIC = 0x1;
const G_DOLL = 0x2;
const G_CLAW = 0x4;
const groups = (member, filter) => (member << 16) | filter;

export const DEFAULT_SETTINGS = {
  catchPower: 40, // 잡는 힘
  topPower: 26, // 상승 후 힘
  movePower: 22, // 이동 힘
  randomCycle: 10, // 랜덤 게임 주기: 매 N번째 판은 전부 최대 힘 (0 = 끔)
  exitDrop: false, // 배출구 앞에서 힘 풀기
};

function rotate(q, v) {
  // v' = q v q*, written out to avoid allocations
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

function quatFromY(dx, dy, dz) {
  // shortest rotation taking +Y onto the (unit) direction
  const w = 1 + dy;
  if (w < 1e-6) return { x: 1, y: 0, z: 0, w: 0 };
  const n = Math.hypot(dz, -dx, w);
  return { x: dz / n, y: 0, z: -dx / n, w: w / n };
}

export class ClawSim {
  constructor(RAPIER, settings = {}) {
    this.R = RAPIER;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.tauFull = settings.tauFull ?? TAU_FULL;
    this.tauSpring = settings.tauSpring ?? TAU_SPRING;
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = STEP;
    world.integrationParameters.lengthUnit = 0.1;
    this.world = world;
    this.acc = 0;
    this.dolls = [];
    this.nextId = 1;
    this.events = [];
    this.state = "idle";
    this.t = 0;
    this.timeLeft = 0;
    this.playCount = 0;
    this.strong = false;
    this.power = 0;
    this.input = { x: 0, z: 0 };
    this.vel = { x: 0, z: 0 };
    this.hubPos = { x: HOME.x, y: HUB_TOP_Y, z: HOME.z };
    this.stepCount = 0;
    this.buildMachine();
    this.buildClaw();
  }

  // ---------- construction ----------

  box(x, y, z, hx, hy, hz, friction = 0.6) {
    const d = this.R.ColliderDesc.cuboid(hx, hy, hz)
      .setTranslation(x, y, z)
      .setFriction(friction)
      .setCollisionGroups(groups(G_STATIC, G_DOLL | G_CLAW));
    return this.world.createCollider(d);
  }

  buildMachine() {
    const { hx, hz, top, chute: c, guardH } = DIM;
    const t = 0.02;
    // floor with the prize hole in the front-left corner
    this.box((c.x1 + hx) / 2, -t, 0, (hx - c.x1) / 2, t, hz, 0.7);
    this.box((-hx + c.x1) / 2, -t, (-hz + c.z0) / 2, (c.x1 + hx) / 2, t, (c.z0 + hz) / 2, 0.7);
    // cabinet walls (glass)
    this.box(-hx - t, top / 2, 0, t, top / 2 + 0.3, hz + 2 * t, 0.3);
    this.box(hx + t, top / 2, 0, t, top / 2, hz + 2 * t, 0.3);
    this.box(0, top / 2, -hz - t, hx + 2 * t, top / 2, t, 0.3);
    this.frontWall = this.box(0, top / 2, hz + t, hx + 2 * t, top / 2 + 0.3, t, 0.3);
    // acrylic guard around the chute
    const g = 0.004;
    this.box(c.x1 + g, guardH / 2, (c.z0 + hz) / 2, g, guardH / 2, (hz - c.z0) / 2 + g, 0.3);
    this.box((c.x0 + c.x1) / 2, guardH / 2, c.z0 - g, (c.x1 - c.x0) / 2 + g, guardH / 2, g, 0.3);
    // chute shaft below the hole
    this.box(c.x1 + g, -0.2, (c.z0 + hz) / 2, g, 0.2, (hz - c.z0) / 2, 0.2);
    this.box((c.x0 + c.x1) / 2, -0.2, c.z0 - g, (c.x1 - c.x0) / 2, 0.2, g, 0.2);
  }

  buildClaw() {
    const R = this.R;
    const hp = this.hubPos;
    this.hub = this.world.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(hp.x, hp.y, hp.z));
    this.world.createCollider(R.ColliderDesc.cylinder(0.03, 0.033).setCollisionGroups(groups(G_CLAW, G_DOLL)), this.hub);
    this.prongs = [];
    for (let k = 0; k < 3; k++) {
      const phi = -Math.PI / 2 + (k * 2 * Math.PI) / 3;
      const r = { x: Math.cos(phi), z: Math.sin(phi) };
      const axis = { x: -r.z, y: 0, z: r.x };
      const anchor = { x: r.x * HINGE_R, y: HINGE_Y, z: r.z * HINGE_R };
      const body = this.world.createRigidBody(
        R.RigidBodyDesc.dynamic()
          .setTranslation(hp.x + anchor.x, hp.y + anchor.y, hp.z + anchor.z)
          .setAngularDamping(1.5)
          .setCanSleep(false)
      );
      for (let i = 0; i + 1 < PRONG_PATH.length; i++) {
        const [u0, y0] = PRONG_PATH[i];
        const [u1, y1] = PRONG_PATH[i + 1];
        const a = { x: r.x * u0, y: y0, z: r.z * u0 };
        const b = { x: r.x * u1, y: y1, z: r.z * u1 };
        const dx = b.x - a.x,
          dy = b.y - a.y,
          dz = b.z - a.z;
        const len = Math.hypot(dx, dy, dz);
        this.world.createCollider(
          R.ColliderDesc.capsule(len / 2, PRONG_RADIUS)
            .setTranslation((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2)
            .setRotation(quatFromY(dx / len, dy / len, dz / len))
            .setDensity(2600)
            .setFriction(0.75)
            .setCollisionGroups(groups(G_CLAW, G_DOLL | G_STATIC)),
          body
        );
      }
      body.addTorque({ x: axis.x * this.tauSpring, y: 0, z: axis.z * this.tauSpring }, false);
      const joint = this.world.createImpulseJoint(R.JointData.revolute(anchor, { x: 0, y: 0, z: 0 }, axis), this.hub, body, true);
      joint.setContactsEnabled(false);
      joint.setLimits(PRONG_LIMIT[0], PRONG_LIMIT[1]);
      joint.configureMotorModel(R.MotorModel.ForceBased);
      const [tu, ty] = PRONG_PATH[PRONG_PATH.length - 1];
      this.prongs.push({ body, joint, phi, tip: { x: r.x * tu, y: ty, z: r.z * tu } });
    }
    this.setMotor(false, TAU_OPEN);
  }

  setMotor(shut, tau) {
    for (const p of this.prongs) {
      p.joint.configureMotorPosition(shut ? PRONG_SHUT : PRONG_OPEN, MOTOR_STIFF, MOTOR_DAMP);
      p.joint.setMotorMaxForce(tau);
    }
  }

  setGripPower(power) {
    this.power = power;
    this.setMotor(true, (this.tauFull * Math.max(0, power)) / POWER_MAX);
  }

  // ---------- dolls ----------

  addDoll(type, x, y, z, rot = { x: 0, y: 0, z: 0, w: 1 }) {
    if (this.dolls.length >= MAX_DOLLS) return null;
    const R = this.R;
    const c = CHARACTERS[type];
    const body = this.world.createRigidBody(
      R.RigidBodyDesc.dynamic()
        .setTranslation(x, y, z)
        .setRotation(rot)
        .setLinearDamping(0.5)
        // plush squashes where it touches, so it barely rolls; without this a doll lying on its
        // side can roll for seconds and keep waking the whole pile
        .setAngularDamping(3.5)
    );
    const add = (desc) =>
      this.world.createCollider(
        desc
          .setDensity(110)
          .setFriction(0.9)
          .setRestitution(0.05)
          .setCollisionGroups(groups(G_DOLL, G_STATIC | G_DOLL | G_CLAW)),
        body
      );
    // One capsule hull from bottom of body to top of head. A plush squashes into its neck, so
    // modelling the neck as a rigid notch would let any claw "hook" a doll regardless of power.
    if (c.modelBounds) {
      // glTF doll: capsule fitted to the model's bounding box (long ears get their own ball)
      const bb = c.modelBounds;
      const H = bb.max.y - bb.min.y;
      const top = bb.min.y + H * (1 - (c.model.earFrac || 0));
      const r = (Math.min(bb.max.x - bb.min.x, bb.max.z - bb.min.z) / 2) * 0.92;
      const y0 = bb.min.y + r,
        y1 = Math.max(y0 + 0.002, top - r);
      add(R.ColliderDesc.capsule((y1 - y0) / 2, r).setTranslation(0, (y0 + y1) / 2, 0));
      if (c.model.earFrac) add(R.ColliderDesc.ball(0.02).setTranslation(0, bb.max.y - H * c.model.earFrac * 0.45, 0));
    } else {
      const h = c.head,
        b = c.body;
      const r = (h.r * h.sx + b.r) / 2;
      const y0 = b.y - b.r + r,
        y1 = h.y + h.r * h.sy - r;
      add(R.ColliderDesc.capsule(Math.max(0.001, (y1 - y0) / 2), r).setTranslation(0, (y0 + y1) / 2, 0));
      if (c.tail) add(R.ColliderDesc.ball(c.tail.r).setTranslation(0, c.tail.y, c.tail.z));
      if (c.earBall) add(R.ColliderDesc.ball(c.earBall.r).setTranslation(0, c.earBall.y, 0));
    }
    const doll = { id: this.nextId++, type, body };
    this.dolls.push(doll);
    return doll;
  }

  spawnRandomDoll(type = Math.floor(Math.random() * CHARACTERS.length), rnd = Math.random) {
    const c = DIM.chute;
    let x, z;
    do {
      x = -0.32 + rnd() * 0.66;
      z = -0.26 + rnd() * 0.52;
    } while (x < c.x1 + 0.07 && z > c.z0 - 0.07);
    // Mostly face-up or sitting facing the player, the way staff stock a real machine so the
    // faces show through the glass. Rotation = yaw (about y) then tilt back (about x).
    const yaw = (rnd() - 0.5) * 1.2;
    const tilt = rnd() < 0.6 ? -1.3 - rnd() * 0.3 : (rnd() - 0.5) * 0.5;
    const cy = Math.cos(yaw / 2),
      sy = Math.sin(yaw / 2),
      cx = Math.cos(tilt / 2),
      sx = Math.sin(tilt / 2);
    const q = { x: cy * sx, y: sy * cx, z: -sy * sx, w: cy * cx };
    return this.addDoll(type, x, 0.5 + rnd() * 0.15, z, q);
  }

  removeDoll(doll) {
    this.world.removeRigidBody(doll.body);
    const i = this.dolls.indexOf(doll);
    if (i >= 0) this.dolls.splice(i, 1);
  }

  // ---------- hidden feature: smash the front glass ----------

  breakOpen() {
    if (this.broken) return;
    this.broken = true;
    this.world.removeCollider(this.frontWall, true);
    this.go("broken");
    // everything inside bursts out toward the player
    for (const d of this.dolls) {
      const b = d.body;
      b.setLinvel({ x: (Math.random() - 0.5) * 0.8, y: 0.6 + Math.random() * 1.2, z: 1.1 + Math.random() * 1.4 }, true);
      b.setAngvel({ x: (Math.random() - 0.5) * 8, y: (Math.random() - 0.5) * 8, z: (Math.random() - 0.5) * 8 }, true);
    }
  }

  repair() {
    const { hx, hz, top } = DIM;
    const t = 0.02;
    this.frontWall = this.box(0, top / 2, hz + t, hx + 2 * t, top / 2 + 0.3, t, 0.3);
    for (const d of [...this.dolls]) this.removeDoll(d);
    // park the claw back over the chute
    const hp = this.hubPos;
    const dx = HOME.x - hp.x,
      dy = HUB_TOP_Y - hp.y,
      dz = HOME.z - hp.z;
    Object.assign(hp, { x: HOME.x, y: HUB_TOP_Y, z: HOME.z });
    this.hub.setTranslation(hp, true);
    for (const p of this.prongs) {
      const o = p.body.translation();
      p.body.setTranslation({ x: o.x + dx, y: o.y + dy, z: o.z + dz }, true);
      p.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    this.broken = false;
    this.go("idle");
  }

  // ---------- game flow ----------

  insertCoin() {
    if (this.state !== "idle") return false;
    this.playCount++;
    const n = this.settings.randomCycle;
    this.strong = n > 0 && this.playCount % n === 0;
    this.timeLeft = PLAY_TIME;
    this.go("play");
    return true;
  }

  drop() {
    if (this.state === "play") this.go("drop");
  }

  go(state) {
    this.state = state;
    this.t = 0;
    this.events.push({ type: "state", state });
    if (state === "drop" || state === "release" || state === "idle") this.setMotor(false, TAU_OPEN);
  }

  powerFor(key) {
    return this.strong ? POWER_MAX : this.settings[key];
  }

  hubTouching() {
    const R = this.R;
    const filter = groups(0xffff, G_DOLL | G_STATIC);
    const hp = this.hubPos;
    const hit = this.world.castRay(new R.Ray({ x: hp.x, y: hp.y - 0.034, z: hp.z }, { x: 0, y: -1, z: 0 }), 0.2, true, undefined, filter);
    if (hit && hit.timeOfImpact < 0.008) return true;
    for (const p of this.prongs) {
      const q = p.body.rotation();
      const o = p.body.translation();
      const tip = rotate(q, p.tip);
      const ray = new R.Ray({ x: o.x + tip.x, y: o.y + tip.y, z: o.z + tip.z }, { x: 0, y: -1, z: 0 });
      const h = this.world.castRay(ray, 0.05, true, undefined, filter);
      if (h && h.timeOfImpact < 0.004) return true;
    }
    return false;
  }

  moveToward(tx, tz, speed, dt) {
    const hp = this.hubPos;
    const dx = tx - hp.x,
      dz = tz - hp.z;
    const d = Math.hypot(dx, dz);
    const s = speed * dt;
    if (d <= s) {
      hp.x = tx;
      hp.z = tz;
      return true;
    }
    hp.x += (dx / d) * s;
    hp.z += (dz / d) * s;
    return false;
  }

  fixedStep(dt) {
    this.t += dt;
    const hp = this.hubPos;
    switch (this.state) {
      case "play": {
        const a = 1 - Math.exp(-dt * 12); // gantry inertia
        this.vel.x += (this.input.x * 0.2 - this.vel.x) * a;
        this.vel.z += (this.input.z * 0.2 - this.vel.z) * a;
        hp.x = Math.min(HUB_RANGE.x1, Math.max(HUB_RANGE.x0, hp.x + this.vel.x * dt));
        hp.z = Math.min(HUB_RANGE.z1, Math.max(HUB_RANGE.z0, hp.z + this.vel.z * dt));
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) this.go("drop");
        break;
      }
      case "drop":
        this.vel.x = this.vel.z = 0;
        if (this.t > 0.3) {
          hp.y -= 0.22 * dt;
          if (hp.y <= HUB_MIN_Y || (this.stepCount % 2 === 0 && this.hubTouching())) {
            hp.y = Math.max(hp.y, HUB_MIN_Y);
            this.go("grab");
          }
        }
        break;
      case "grab":
        if (this.t > 0.2 && this.power === 0) this.setGripPower(this.powerFor("catchPower"));
        if (this.t > 1.1) this.go("lift");
        break;
      case "lift":
        hp.y += 0.17 * dt;
        if (hp.y >= HUB_TOP_Y) {
          hp.y = HUB_TOP_Y;
          this.go("top");
        }
        break;
      case "top": {
        // after reaching the top the board drops to "top power"
        const k = Math.min(1, this.t / 0.35);
        const p = this.powerFor("catchPower") * (1 - k) + this.powerFor("topPower") * k;
        this.setGripPower(p);
        if (this.t > 0.6) this.go("move");
        break;
      }
      case "move": {
        const near = Math.hypot(HOME.x - hp.x, HOME.z - hp.z) < 0.09;
        const p = this.settings.exitDrop && near && !this.strong ? 0 : this.powerFor("movePower");
        if (p !== this.power) this.setGripPower(p);
        if (this.moveToward(HOME.x, HOME.z, 0.2, dt)) this.go("release");
        break;
      }
      case "release":
        if (this.t > 1.4) this.go("idle");
        break;
    }
    if (this.state === "idle" || this.state === "play" || this.state === "drop" || this.state === "release") this.power = 0;
    this.hub.setNextKinematicTranslation(hp);
  }

  update(frameDt) {
    this.acc = Math.min(this.acc + frameDt, STEP * MAX_SUBSTEPS);
    let n = 0;
    while (this.acc >= STEP) {
      this.fixedStep(STEP);
      this.world.step();
      this.acc -= STEP;
      this.stepCount++;
      n++;
      if (this.stepCount % 6 === 0) this.collectPrizes();
    }
    return n;
  }

  collectPrizes() {
    const dt = 6 * STEP;
    const c = DIM.chute;
    for (let i = this.dolls.length - 1; i >= 0; i--) {
      const d = this.dolls[i];
      const body = d.body;
      const p = body.translation();
      // A doll teetering on an edge can jitter just above Rapier's sleep threshold forever and keep
      // its whole island awake. If it has barely moved for a while, zero its velocity so the
      // engine's own sleeping takes over. (Forcing body.sleep() here instead corrupts stacked
      // contacts and lets dolls sink through the floor.)
      if (!body.isSleeping()) {
        const v = body.linvel(),
          w = body.angvel();
        const calm = v.x * v.x + v.y * v.y + v.z * v.z < 0.03 ** 2 && w.x * w.x + w.y * w.y + w.z * w.z < 0.8 ** 2;
        d.calm = calm ? (d.calm || 0) + dt : 0;
        if (d.calm > 1.5) {
          body.setLinvel({ x: 0, y: 0, z: 0 }, false);
          body.setAngvel({ x: 0, y: 0, z: 0 }, false);
          d.calm = 0;
        }
      }
      if (this.broken) continue; // dolls are flying out of the smashed machine
      const inChute = p.x < c.x1 && p.z > c.z0;
      if (p.y < -0.09 && inChute) {
        // any doll that drops down the chute is won, however it got there (claw, nudged off the
        // pile, rolled in between games)
        this.removeDoll(d);
        this.events.push({ type: "won", doll: d });
      } else if (p.y < -0.03 || !Number.isFinite(p.y)) {
        // safety net: never let a doll vanish through the floor; drop it back in from above
        body.setTranslation({ x: Math.min(0.3, Math.max(c.x1 + 0.08, p.x || 0)), y: 0.5, z: Math.max(-0.25, Math.min(0.25, p.z || 0)) }, true);
        body.setLinvel({ x: 0, y: 0, z: 0 }, true);
        body.setAngvel({ x: 0, y: 0, z: 0 }, true);
        this.rescued = (this.rescued || 0) + 1;
      }
    }
  }
}
