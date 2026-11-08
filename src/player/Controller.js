import { Quaternion, Vector3 } from 'three';
import { CAMERA, CONTROLLER } from '../config.js';
import { angleDelta, clamp, damp, lerp } from '../utils/math.js';

const DOWN = new Vector3(0, -1, 0);
const _o = new Vector3();
const _d = new Vector3();
const _look = new Vector3();
const _cam = new Vector3();
const UP = new Vector3(0, 1, 0);

/** The 'K' moment: Kanao walks over (approach), they lean in (kiss), then ease apart (release). */
export const INTERACT = { approachMax: 5, kiss: 3, release: 0.9, distance: 0.6 };

/**
 * Third-person controller.
 *
 *  Input   WASD (camera-relative), Shift run, Space jump, mouse look (pointer lock,
 *          drag-to-look fallback), wheel zoom. Touch devices feed `stick` (an
 *          analog vector that replaces WASD while held) and call `look()` — see
 *          input/TouchControls.js, which only loads on touch screens.
 *  Floor   a THREE.Raycaster cast straight down from Tanjiro's origin (raised by the
 *          step height so stairs can be climbed) against the nearby-collider proxy.
 *          The ray length grows with fall speed, so fast falls never tunnel.
 *  Walls   capsule push-out against the same nearby boxes.
 *  Camera  a smoothed pivot at shoulder height behind him, pulled in when a wall
 *          is between pivot and lens (a second raycast).
 */
export class Controller {
  constructor(camera, dom, character, collision) {
    this.camera = camera;
    this.dom = dom;
    this.char = character;
    this.col = collision;
    this.pos = new Vector3();
    this.vel = new Vector3();
    this.heading = 0;
    this.camYaw = Math.PI; // camera looks along +Z·(sin, cos)
    this.camPitch = CAMERA.pitch;
    this.camDist = CAMERA.distance;
    this.zoom = CAMERA.distance;
    this.pivot = new Vector3();
    this.grounded = false;
    this.airTime = 0;
    this.coyote = 0;
    this.scripted = false; // Biwa freefall: position driven externally, no collision
    this.enabled = false; // input (after the intro gate)
    this.keys = new Set();
    this.onLand = null;
    this.onVoid = null;
    this.onJump = null;
    this.landedImpulse = 0;
    this.speed = 0;
    // camera effects driven by the Biwa sequence
    this.fx = { fall: 0, shake: 0, roll: 0, fovKick: 0 };
    this.shakeT = 0;
    this.locked = false; // cinematic: look around, but no walking
    this.camCollide = false; // keep the lens out of walls even while scripted (inside the opening's room)
    this.windupT = 0; // jump anticipation timer
    this.jumpQueued = false;
    this.interactQueued = false;
    this.interaction = 'none'; // none | approach | kiss | release
    this.interactT = 0;
    this.faceHeading = 0;
    this.camYawTarget = null;
    this.partner = null; // plain-data state of the companion ({ position, arrived }) — set by main
    this.onKiss = null;
    this.quat = new Quaternion();
    // analog movement (virtual joystick): x = right, y = forward, magnitude 0..1
    this.stick = { x: 0, y: 0, active: false };
    this.fovBase = CAMERA.fov; // widened in portrait (main.js on resize)
    /**
     * Read-only snapshot for other systems (CompanionAI, FX). Plain data, same
     * object every frame, so readers never need to import this module.
     */
    this.state = {
      position: this.pos,
      velocity: this.vel,
      rotation: this.quat, // heading as a quaternion (breadcrumb snapshots)
      heading: 0,
      grounded: true,
      motion: 'grounded', // grounded | jumping | falling
      scripted: false,
      windup: 0,
      speed: 0, // horizontal
      speed3: 0, // full 3D speed (how fast he flew an arc)
      interaction: 'none', // none | approach | kiss | release
      faceHeading: 0, // during an interaction: the way he faces (toward her)
    };
    this.bindInput();
  }

  bindInput() {
    const dom = this.dom;
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'Space') this.jumpQueued = true;
      if (e.code === 'KeyK') this.interactQueued = true;
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    const look = (dx, dy) => this.look(dx, dy);
    document.addEventListener('mousemove', (e) => {
      if (!this.enabled) return;
      if (document.pointerLockElement === dom) look(e.movementX, e.movementY);
      else if (this.dragging) look(e.movementX * 1.4, e.movementY * 1.4);
    });
    dom.addEventListener('mousedown', (e) => {
      if (!this.enabled) return;
      this.dragging = true;
      if (document.pointerLockElement !== dom && e.button === 0) dom.requestPointerLock?.()?.catch?.(() => {});
    });
    window.addEventListener('mouseup', () => (this.dragging = false));
    dom.addEventListener('wheel', (e) => {
      this.zoom = clamp(this.zoom + e.deltaY * 0.004, 2.2, 9);
    }, { passive: true });
  }

  /** Camera look by a pointer delta (mouse pixels; touch scales its own). */
  look(dx, dy) {
    if (!this.enabled) return;
    this.camYaw -= dx * CAMERA.sensitivity;
    this.camPitch = clamp(this.camPitch + dy * CAMERA.sensitivity, CAMERA.minPitch, CAMERA.maxPitch);
  }

  spawn(p) {
    this.pos.copy(p);
    this.vel.set(0, 0, 0);
    this.pivot.set(p.x, p.y + CAMERA.pivotHeight, p.z);
    this.grounded = true;
  }

  /** Shift everything by a whole number of periods (keeps floats small; invisible). */
  shift(dx, dy, dz) {
    this.pos.x += dx; this.pos.y += dy; this.pos.z += dz;
    this.pivot.x += dx; this.pivot.y += dy; this.pivot.z += dz;
    this.camera.position.x += dx; this.camera.position.y += dy; this.camera.position.z += dz;
  }

  update(dt) {
    const k = this.keys;
    let fwd = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    let side = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let run = k.has('ShiftLeft') || k.has('ShiftRight');
    let amount = 1; // analog throttle (joystick)
    const stk = this.stick;
    if (stk.active) {
      // the joystick replaces WASD: direction from the vector, speed from how far it's pushed
      const m = Math.min(1, Math.hypot(stk.x, stk.y));
      fwd = stk.y;
      side = stk.x;
      run = m > 0.88; // pushed to the rim: sprint
      amount = run ? 1 : 0.3 + 0.7 * clamp((m - 0.12) / 0.76, 0, 1);
      if (m < 0.12) fwd = side = 0; // dead zone
    }
    const fx = Math.sin(this.camYaw), fz = Math.cos(this.camYaw);
    // right = forward × up
    let wx = fx * fwd + -fz * side;
    let wz = fz * fwd + fx * side;
    const wl = Math.hypot(wx, wz);
    this.updateInteraction(dt);
    const busy = this.interaction !== 'none'; // the 'K' moment: no walking
    const active = this.enabled && !this.locked && !this.scripted && !busy && wl > 0;
    if (wl > 0) { wx /= wl; wz /= wl; }
    const target = active ? (run ? CONTROLLER.runSpeed : CONTROLLER.walkSpeed * amount) : 0;
    // Inertia: speed builds with `accel`, and with no input he glides to a halt
    // under `friction` (exponential damping — frame-rate independent).
    const air = this.grounded ? 1 : CONTROLLER.airControl;
    const rate = (active ? CONTROLLER.accel : CONTROLLER.friction) * air;
    const a = damp(rate, dt);
    this.vel.x += ((active ? wx * target : 0) - this.vel.x) * a;
    this.vel.z += ((active ? wz * target : 0) - this.vel.z) * a;
    if (!active && Math.hypot(this.vel.x, this.vel.z) < 0.05) this.vel.x = this.vel.z = 0;
    if (this.scripted) {
      this.vel.x *= 1 - Math.min(1, dt * 3);
      this.vel.z *= 1 - Math.min(1, dt * 3);
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    if (busy) {
      // turn to face her
      this.heading += angleDelta(this.heading, this.faceHeading) * damp(8, dt);
    } else if (this.speed > 0.3 && !this.scripted) {
      const h = Math.atan2(this.vel.x, this.vel.z);
      this.heading += angleDelta(this.heading, h) * damp(CONTROLLER.turnRate, dt);
    }

    let landed = 0;
    if (!this.scripted) landed = this.physics(dt);
    else {
      this.grounded = false;
      this.airTime = 0;
    }

    const windup = this.windupT > 0 ? 1 - this.windupT / CONTROLLER.jumpWindup : 0;
    this.char.root.position.copy(this.pos);
    this.char.root.rotation.y = this.heading;
    this.char.update(dt, {
      speed: this.speed,
      grounded: this.grounded,
      vy: this.vel.y,
      freefall: this.scripted,
      landed,
      windup,
      kiss: this.interaction === 'kiss' ? 1 : 0,
    });
    const st = this.state;
    st.heading = this.heading;
    this.quat.setFromAxisAngle(UP, this.heading);
    st.grounded = this.grounded;
    st.motion = this.grounded && windup === 0 ? 'grounded' : this.vel.y > 0 || windup > 0 ? 'jumping' : 'falling';
    st.scripted = this.scripted;
    st.windup = windup;
    st.speed = this.speed;
    st.speed3 = this.vel.length();
    st.interaction = this.interaction;
    st.faceHeading = this.faceHeading;
    this.updateCamera(dt);
  }

  /** 'K': approach → kiss (3 s) → release → exploring again. */
  updateInteraction(dt) {
    const q = this.interactQueued;
    this.interactQueued = false;
    const P = this.partner;
    if (this.interaction === 'none') {
      if (!q || !P || !this.enabled || this.locked || this.scripted || !this.grounded || this.windupT > 0) return;
      if (P.mode !== 'follow') return;
      const dx = P.position.x - this.pos.x, dz = P.position.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 12 || Math.abs(P.position.y - this.pos.y) > 1.2) return; // she's not with him
      this.interaction = 'approach';
      this.interactT = 0;
      this.faceHeading = d > 0.05 ? Math.atan2(dx, dz) : this.heading;
      // frame them from the side (whichever side the camera is nearer)
      const a = this.faceHeading + Math.PI / 2, b = this.faceHeading - Math.PI / 2;
      this.camYawTarget = Math.abs(angleDelta(this.camYaw, a)) < Math.abs(angleDelta(this.camYaw, b)) ? a : b;
      return;
    }
    this.interactT += dt;
    if (this.interaction === 'approach') {
      if ((P?.arrived && this.interactT > 0.35) || this.interactT > INTERACT.approachMax) {
        this.interaction = 'kiss';
        this.interactT = 0;
        this.onKiss?.();
      }
    } else if (this.interaction === 'kiss') {
      if (this.interactT > INTERACT.kiss) {
        this.interaction = 'release';
        this.interactT = 0;
      }
    } else if (this.interaction === 'release' && this.interactT > INTERACT.release) {
      this.interaction = 'none';
      this.camYawTarget = null;
    }
  }

  physics(dt) {
    const C = CONTROLLER;
    const col = this.col;
    col.updateNear(this.pos);
    // jump: 1) anticipation — sink into the knees for a beat, 2) take-off
    this.coyote = this.grounded ? 0.12 : Math.max(0, this.coyote - dt);
    if (this.jumpQueued) {
      this.jumpQueued = false;
      if (this.enabled && !this.locked && this.interaction === 'none' && this.coyote > 0 && this.windupT <= 0 && this.vel.y <= 0.1) this.windupT = C.jumpWindup;
    }
    if (this.windupT > 0) {
      this.windupT -= dt;
      if (this.windupT <= 0) {
        this.windupT = 0;
        this.vel.y = C.jumpSpeed;
        this.grounded = false;
        this.coyote = 0;
        this.onJump?.();
      }
    }
    this.vel.y = Math.max(this.vel.y - C.gravity * dt, -C.terminalVelocity);

    // horizontal move + wall push-out (two passes resolve corners)
    this.pos.x += this.vel.x * dt;
    this.pos.z += this.vel.z * dt;
    for (let i = 0; i < 2; i++) col.pushOut(this.pos, C.radius, C.stepHeight, C.bodyHeight);

    // head bump
    if (this.vel.y > 0) {
      const ceil = col.ceiling(this.pos, C.radius, 0.6, C.bodyHeight + this.vel.y * dt + 0.05);
      if (ceil < Infinity) {
        this.pos.y = Math.min(this.pos.y, ceil - C.bodyHeight - 0.02);
        this.vel.y = 0;
      }
    }

    // floor: raycast down from the origin, raised by the step height
    const wasGrounded = this.grounded;
    const fallStep = Math.max(0, -this.vel.y * dt);
    const reach = C.stepHeight + fallStep + (wasGrounded && this.vel.y <= 0 ? 0.42 : 0.04);
    _o.set(this.pos.x, this.pos.y + C.stepHeight, this.pos.z);
    const hit = this.vel.y <= 0.01 ? col.raycast(_o, DOWN, reach, true) : null;
    let landed = 0;
    if (hit) {
      if (!wasGrounded) landed = clamp(-this.vel.y / 24, 0.12, 1.2); // landing shock strength
      if (!wasGrounded) this.onLand?.(-this.vel.y);
      this.pos.y = hit.point.y;
      this.vel.y = 0;
      this.grounded = true;
      this.airTime = 0;
    } else {
      this.pos.y += this.vel.y * dt;
      this.grounded = false;
      this.airTime += dt;
      // fell off the edge into the void: is there anything at all below?
      if (this.airTime > C.voidCatchSeconds && this.vel.y < 0) {
        _o.set(this.pos.x, this.pos.y, this.pos.z);
        if (!col.raycast(_o, DOWN, 68, true)) {
          this.airTime = -999; // only once
          this.onVoid?.();
        }
      }
    }
    return landed;
  }

  updateCamera(dt) {
    const fx = this.fx;
    // pivot follows (tighter when falling fast so he doesn't leave the frame)
    const follow = this.scripted ? 30 : CAMERA.follow;
    _look.set(this.pos.x, this.pos.y + CAMERA.pivotHeight, this.pos.z);
    this.pivot.lerp(_look, damp(follow, dt));
    if (this.scripted) this.pivot.y = _look.y; // no lag while plunging

    if (this.camYawTarget !== null && this.interaction !== 'release') {
      this.camYaw += angleDelta(this.camYaw, this.camYawTarget) * damp(2.2, dt);
      this.camPitch += (0.08 - this.camPitch) * damp(2.2, dt);
    }
    const pitch = lerp(this.camPitch, 1.28, fx.fall);
    const distWanted = lerp(this.zoom, 6.2, fx.fall);
    const yaw = this.camYaw + fx.roll * 0.15;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const f = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const right = { x: -f.z, z: f.x };
    const shoulder = CAMERA.shoulder * (1 - fx.fall);
    _d.set(-f.x * cp, sp, -f.z * cp); // pivot → camera

    // keep the lens out of walls
    let dist = distWanted;
    if ((!this.scripted || this.camCollide) && this.col.proxy.count) {
      _o.copy(this.pivot);
      _o.x += right.x * shoulder;
      _o.z += right.z * shoulder;
      const hit = this.col.raycast(_o, _d, distWanted + 0.3, false);
      if (hit) dist = Math.max(CAMERA.minDistance, hit.distance - 0.3);
    }
    this.camDist = dist < this.camDist ? dist : this.camDist + (dist - this.camDist) * damp(this.scripted ? 5 : 3, dt);

    _cam.copy(this.pivot).addScaledVector(_d, this.camDist);
    _cam.x += right.x * shoulder;
    _cam.z += right.z * shoulder;

    // shake
    this.shakeT += dt;
    const sh = fx.shake;
    if (sh > 0) {
      _cam.x += (Math.sin(this.shakeT * 41) + Math.sin(this.shakeT * 67)) * 0.05 * sh;
      _cam.y += (Math.sin(this.shakeT * 53) + Math.sin(this.shakeT * 29)) * 0.05 * sh;
      _cam.z += Math.sin(this.shakeT * 37) * 0.05 * sh;
    }
    this.camera.position.copy(_cam);
    _look.copy(this.pivot);
    _look.x += right.x * shoulder + f.x * 1.2 * (1 - fx.fall);
    _look.z += right.z * shoulder + f.z * 1.2 * (1 - fx.fall);
    _look.y -= 0.15;
    if (fx.fall > 0.01) {
      // look past him, down the shaft
      _look.y -= 4 * fx.fall;
    }
    this.camera.up.set(Math.sin(fx.roll) * 0.6, 1, 0).normalize();
    this.camera.lookAt(_look);

    const run = clamp((this.speed - CONTROLLER.walkSpeed) / (CONTROLLER.runSpeed - CONTROLLER.walkSpeed), 0, 1);
    const fov = this.fovBase + run * 6 * (this.grounded ? 1 : 0.5) + fx.fall * 22 + fx.fovKick;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov += (fov - this.camera.fov) * damp(6, dt);
      this.camera.updateProjectionMatrix();
    }
  }
}
