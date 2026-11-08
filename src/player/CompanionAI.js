import { MathUtils, Quaternion, Vector3 } from 'three';
import { angleDelta, damp } from '../utils/math.js';

const { clamp, lerp } = MathUtils;
const SAMPLE = 0.12; // metres between grounded breadcrumbs (airborne: every frame)
const DOWN = new Vector3(0, -1, 0);
const UP = new Vector3(0, 1, 0);
const _a = new Vector3();
const _b = new Vector3();
const _o = new Vector3();

/** Catmull-Rom on one axis (centripetal-ish smoothing of the recorded arc). */
function cr(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/**
 * Kanao follows Tanjiro.
 *
 *  Breadcrumbs: every node is a full snapshot of him —
 *    { position: Vector3, rotation: Quaternion, state: 'grounded' | 'jumping' | 'falling', speed, windup, s }
 *  — recorded every 12 cm on the ground and EVERY FRAME while he's airborne, so
 *  a sprint-jump's arc is never thinned out. She travels along that queue
 *  ~1.1 m (of path) behind him, sampling it with a Catmull-Rom spline so the
 *  arc stays round even when frames are far apart.
 *
 *  Grounded vs airborne: on 'grounded' crumbs her own floor Raycaster is live
 *  (she's snapped onto the step under her feet, so stairs never cut corners).
 *  On 'jumping' / 'falling' crumbs the ray and any notion of gravity are off:
 *  she rides the exact XYZ arc he flew, at no less than the speed he flew it,
 *  so she never hangs mid-air or snags on a platform edge — even if he stopped
 *  right after landing. The ray comes back on the first grounded crumb.
 *
 *  Personal space: never closer than `personalSpace` to him in a straight line
 *  (she eases aside / waits instead of clipping into his mesh).
 *
 *  Facing: her velocity while moving; his heading when stopped.
 *
 *  Biwa drops: while he's in scripted freefall she falls beside him, then lands
 *  next to him and the queue restarts.
 *
 *  Interaction ('K'): she walks straight to the spot 0.6 m in front of him,
 *  turns to face him and reports `state.arrived`; the shared lean-in pose is
 *  driven by `leader.interaction`.
 *
 *  It only reads `leader` (the controller's plain-data state) and casts rays
 *  against `collision`; no import of the controller, no circular dependency.
 */
export class CompanionAI {
  constructor(biped, leader, { followDistance = 1.1, maxSpeed = 10.5, personalSpace = 0.78, collision = null } = {}) {
    this.biped = biped;
    this.leader = leader;
    this.D = followDistance;
    this.baseD = followDistance;
    this.maxSpeed = maxSpeed;
    this.personalSpace = personalSpace;
    this.col = collision;
    this.pos = new Vector3();
    this.prev = new Vector3();
    this.vel = new Vector3();
    this.sep = new Vector3(); // personal-space nudge (smoothed)
    this.heading = 0;
    this.path = []; // breadcrumbs (see above)
    this.s = 0; // her progress along the path
    this.v = 0; // her path speed
    this.mode = 'follow'; // follow | fall | interact
    this.fallOffset = new Vector3(1.2, 0, 0.7); // inside the trapdoor opening with him
    this.wasGrounded = true;
    this.rayOn = true;
    this.interactTarget = new Vector3();
    /** Plain-data snapshot for other systems (the controller waits on `arrived`). */
    this.state = { position: this.pos, heading: 0, arrived: false, mode: 'follow' };
  }

  crumb(p, rotationY, state, speed, windup, s) {
    return {
      position: new Vector3(p.x, p.y, p.z),
      rotation: new Quaternion().setFromAxisAngle(UP, rotationY),
      state,
      speed,
      windup,
      s,
    };
  }

  spawn(p, heading) {
    this.pos.copy(p);
    this.prev.copy(p);
    this.heading = heading;
    this.resetPath();
  }

  /** Seed the path with a straight grounded line from her to him. */
  resetPath() {
    const L = this.leader;
    this.path.length = 0;
    this.path.push(this.crumb(this.pos, this.heading, 'grounded', 0, 0, 0));
    const d = this.pos.distanceTo(L.position);
    if (d > 1e-3) this.path.push(this.crumb(L.position, L.heading, 'grounded', 0, 0, d));
    this.s = 0;
    this.v = 0;
    this.sep.set(0, 0, 0);
  }

  shift(dx, dy, dz) {
    _o.set(dx, dy, dz);
    this.pos.add(_o);
    this.prev.add(_o);
    this.interactTarget.add(_o);
    for (const c of this.path) c.position.add(_o);
  }

  /** Index i such that path[i].s <= s < path[i+1].s (clamped). */
  segment(s) {
    const P = this.path;
    let i = 0;
    while (i < P.length - 2 && P[i + 1].s < s) i++;
    return i;
  }

  /** Smoothed point at path distance s → out; returns the segment index. */
  sampleAt(s, out) {
    const P = this.path;
    if (P.length === 1) {
      out.copy(P[0].position);
      return 0;
    }
    const i = this.segment(s);
    const a = P[i], b = P[i + 1];
    const t = clamp((s - a.s) / Math.max(b.s - a.s, 1e-6), 0, 1);
    const p0 = (P[i - 1] ?? a).position, p1 = a.position, p2 = b.position, p3 = (P[i + 2] ?? b).position;
    out.set(cr(p0.x, p1.x, p2.x, p3.x, t), cr(p0.y, p1.y, p2.y, p3.y, t), cr(p0.z, p1.z, p2.z, p3.z, t));
    return i;
  }

  /** Her own floor ray (only meaningful near him: it uses his nearby-collider proxy). */
  floorAt(p, up = 0.5, down = 1.1) {
    const col = this.col;
    if (!col || !col.proxy.count || p.distanceToSquared(this.leader.position) > 64) return null;
    _o.set(p.x, p.y + up, p.z);
    const hit = col.raycast(_o, DOWN, up + down, true);
    return hit ? hit.point.y : null;
  }

  record() {
    const L = this.leader;
    const lp = L.position;
    const P = this.path;
    const last = P[P.length - 1];
    const air = L.motion !== 'grounded';
    if (!last) {
      P.push(this.crumb(lp, L.heading, L.motion, L.speed3, L.windup, 0));
      return;
    }
    const d = last.position.distanceTo(lp);
    if (d > 25) {
      this.resetPath(); // he teleported (only outside drops): start over
      return;
    }
    // airborne: every frame (never thin out the arc); grounded: every 12 cm;
    // always on a state change (take-off / landing / jump wind-up)
    const changed = L.motion !== last.state || (L.windup > 0 && !last.windup);
    if (d >= SAMPLE || (air && d > 0.005) || changed) P.push(this.crumb(lp, L.heading, L.motion, L.speed3, L.windup, last.s + d));
  }

  update(dt) {
    const L = this.leader;
    const lp = L.position;
    let grounded = true;
    let windup = 0;
    let landed = 0;

    if (L.scripted) {
      // ── freefall beside him ──
      this.mode = 'fall';
      const t = performance.now() / 1000;
      const o = this.fallOffset;
      _a.set(lp.x + o.x + Math.sin(t * 0.9) * 0.4, lp.y + o.y + Math.sin(t * 1.3) * 0.3, lp.z + o.z + Math.cos(t * 0.8) * 0.4);
      this.pos.lerp(_a, damp(this.pos.distanceTo(_a) > 20 ? 30 : 8, dt));
      grounded = false;
    } else if (this.mode === 'fall') {
      // he's out of the freefall: land on his deck beside him (the pad is wider than this offset)
      if (L.grounded) {
        this.pos.set(lp.x + this.fallOffset.x, lp.y, lp.z + this.fallOffset.z);
        const fy = this.floorAt(this.pos, 0.6, 1.5);
        if (fy !== null) this.pos.y = fy;
        landed = 1.1;
        this.mode = 'follow';
        this.resetPath();
      } else {
        this.pos.lerp(_a.set(lp.x + this.fallOffset.x, lp.y + 0.4, lp.z + this.fallOffset.z), damp(10, dt));
        grounded = false;
      }
    } else if (L.interaction !== 'none' || this.mode === 'interact') {
      this.interact(dt);
    } else {
      ({ grounded, windup } = this.follow(dt));
    }

    // velocity & facing
    this.vel.copy(this.pos).sub(this.prev).divideScalar(Math.max(dt, 1e-4));
    this.prev.copy(this.pos);
    const hs = Math.hypot(this.vel.x, this.vel.z);
    let want = L.heading, rate = 3.5;
    if (this.mode === 'interact') {
      // walking over: face where she's going; there: face him, firmly
      const toHim = Math.atan2(lp.x - this.pos.x, lp.z - this.pos.z);
      want = hs > 0.6 && this.pos.distanceTo(this.interactTarget) > 0.35 ? Math.atan2(this.vel.x, this.vel.z) : toHim;
      rate = 9;
    } else if (hs > 0.5 && this.mode === 'follow') {
      want = Math.atan2(this.vel.x, this.vel.z);
      rate = 10;
    }
    this.heading += angleDelta(this.heading, want) * damp(rate, dt);

    if (grounded && !this.wasGrounded && !landed) landed = clamp(-this.vel.y / 24, 0.12, 1.2);
    this.wasGrounded = grounded;

    const st = this.state;
    st.heading = this.heading;
    st.mode = this.mode;

    const b = this.biped;
    b.root.position.copy(this.pos);
    b.root.rotation.y = this.heading;
    b.update(dt, {
      speed: this.mode === 'fall' ? 0 : Math.min(hs, 11),
      grounded,
      vy: this.vel.y,
      freefall: this.mode === 'fall',
      landed,
      windup,
      kiss: L.interaction === 'kiss' ? 1 : 0,
    });
  }

  follow(dt) {
    const L = this.leader;
    const lp = L.position;
    this.record();
    const P = this.path;
    const tail = P[P.length - 1];
    const leaderS = tail.s + tail.position.distanceTo(lp);
    const targetS = leaderS - this.D;
    if (targetS - this.s > 40) this.s = targetS - 40; // never trail absurdly far

    const i = this.segment(this.s);
    const seg = [P[i], P[i + 1] ?? P[i]];
    const airborne = seg[0].state !== 'grounded' || seg[1].state !== 'grounded';

    // speed: his own speed (feed-forward) + a pull proportional to the gap, eased
    const gap = targetS - this.s;
    let want = clamp(L.speed + gap * 3.2, 0, this.maxSpeed);
    if (gap < 0) want = 0;
    if (airborne) want = Math.max(want, seg[0].speed, seg[1].speed, 3); // ride his arc at his pace: no hovering
    this.v = lerp(this.v, want, damp(want > this.v ? 7 : 8, dt));
    if (airborne) this.v = Math.max(this.v, want); // no easing into a mid-air stall

    // advance (on the ground stop at the follow point; in the air finish the arc, but never pass him)
    const cap = airborne ? leaderS - 0.3 : Math.max(this.s, targetS);
    this.s = Math.max(this.s, Math.min(this.s + this.v * dt, cap));
    const j = this.sampleAt(this.s, _a);
    const c0 = P[j], c1 = P[j + 1] ?? P[j];
    const onGround = c0.state === 'grounded' && c1.state === 'grounded';

    if (onGround) {
      // personal space: ease aside instead of standing inside him
      _b.set(_a.x - lp.x, 0, _a.z - lp.z);
      const d = _b.length();
      if (d < this.personalSpace) {
        if (d < 1e-3) _b.set(-Math.sin(L.heading), 0, -Math.cos(L.heading));
        else _b.divideScalar(d);
        _b.multiplyScalar(this.personalSpace - d);
      } else _b.set(0, 0, 0);
      this.sep.lerp(_b, damp(10, dt));
      _a.x += this.sep.x;
      _a.z += this.sep.z;
      // floor ray: live on grounded crumbs — snap onto the step under her
      const fy = this.floorAt(_a);
      if (fy !== null) _a.y = fy;
      else if (this.sep.lengthSq() > 1e-6) {
        // the nudge would put her off the edge: undo it
        _a.x -= this.sep.x;
        _a.z -= this.sep.z;
        this.sep.set(0, 0, 0);
      }
    } else this.sep.multiplyScalar(1 - damp(10, dt));
    this.pos.copy(_a);

    // forget path she's already walked (keep one crumb behind her for the spline)
    while (P.length > 3 && P[2].s < this.s - 0.5) P.shift();
    return { grounded: onGround, windup: Math.max(c0.windup, c1.windup) };
  }

  interact(dt) {
    const L = this.leader;
    const lp = L.position;
    const st = this.state;
    if (this.mode !== 'interact') {
      // override the follow distance: walk straight to 0.6 m in front of him
      this.mode = 'interact';
      this.D = 0.6;
      st.arrived = false;
      this.v = 0;
      this.interactTarget.set(lp.x + Math.sin(L.faceHeading) * this.D, lp.y, lp.z + Math.cos(L.faceHeading) * this.D);
    }
    if (L.interaction === 'none') {
      // released: back to following
      this.mode = 'follow';
      this.D = this.baseD;
      st.arrived = false;
      this.resetPath();
      return;
    }
    const T = this.interactTarget;
    _b.set(T.x - this.pos.x, 0, T.z - this.pos.z);
    const d = _b.length();
    if (L.interaction === 'kiss' && d > 0.02) {
      // the moment started without her (very far away): she's simply there
      this.pos.x = T.x;
      this.pos.z = T.z;
    } else if (d > 0.02) {
      const want = Math.min(2.8, d * 3);
      this.v = lerp(this.v, want, damp(6, dt));
      const step = Math.min(d, this.v * dt);
      this.pos.x += (_b.x / d) * step;
      this.pos.z += (_b.z / d) * step;
    } else {
      this.pos.x = T.x;
      this.pos.z = T.z;
      this.v = 0;
    }
    const fy = this.floorAt(this.pos);
    this.pos.y = fy !== null ? fy : lerp(this.pos.y, lp.y, damp(8, dt));
    // arrived = on the spot and turned to face him
    const toHim = Math.atan2(lp.x - this.pos.x, lp.z - this.pos.z);
    st.arrived = d <= 0.02 && Math.abs(angleDelta(this.heading, toHim)) < 0.25;
  }
}
