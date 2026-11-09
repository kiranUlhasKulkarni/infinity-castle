import { BIWA, CONTROLLER } from './config.js';
import { castleUniforms } from './castle/shaders.js';
import { generateLayout } from './castle/layout.js';
import { rimUniform } from './player/Biped.js';
import { clamp, damp, smoothstep } from './utils/math.js';

const FALL_TERMINAL = BIWA.terminal ?? 46; // m/s during the scripted plunge

/** Distance fallen after t seconds from speed v0 under gravity, capped at terminal velocity. */
export function fallDistance(t, v0 = 0, terminal = FALL_TERMINAL) {
  const g = CONTROLLER.gravity;
  const tt = Math.max(0, (terminal - v0) / g);
  if (t <= tt) return v0 * t + 0.5 * g * t * t;
  return v0 * tt + 0.5 * g * tt * tt + terminal * (t - tt);
}

/**
 * Nakime's Biwa.
 *
 * A hidden randomised timer (20–60 s of exploring, a sudden trap) or falling
 * off an edge into the void triggers:
 *   1. a sharp strum; the shoji flare blood-red,
 *   2. the exact floor slab under Tanjiro is cut open — two panels snap apart
 *      under him (CastleMeshes.openTrapdoor) — and his ground collision is gone,
 *   3. a deep plunge (~5.4 s, most of it at terminal velocity) down a clear
 *      shaft; the camera swings overhead to look down past him,
 *   4. every block of the castle slides to a new place (a freshly generated
 *      layout, built in a worker) in waves spreading out from him,
 *   5. the new layout contains a landing deck exactly where his fall ends, with
 *      a clear shaft above it; collision returns and he lands.
 */
export class BiwaDrop {
  constructor({ controller, castle, collision, audio, onShift, seed, onCommit = null }) {
    this.onCommit = onCommit; // the new layout is live (the Lotus Ponds follow it)
    this.c = controller;
    this.castle = castle;
    this.collision = collision;
    this.audio = audio;
    this.onShift = onShift;
    this.seed = seed;
    this.count = 0;
    this.state = 'idle';
    this.t = 0;
    this.fx = { flash: 0, aberration: 0, zoom: 0, fall: 0 };
    this.scheduleNext();
    try {
      this.worker = new Worker(new URL('./castle/layout.worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onLayout(e.data);
    } catch (err) {
      console.warn('[biwa] worker unavailable, generating on the main thread', err);
      this.worker = null;
    }
    this.pending = null;
    this.reqId = 0;
    this.armed = false; // the hidden timer starts after the opening
    this.safe = false; // inside a Lotus Pond hall: no trap fires
    // warm the worker up (module load + JIT) long before the first trap, so the
    // real request comes back in ~0.5 s instead of missing the fall
    this.worker?.postMessage({ id: -1, seed: seed + 1, anchor: [0, 0, 0], shaftHeight: 0 });
  }

  scheduleNext() {
    this.timer = BIWA.minSeconds + Math.random() * (BIWA.maxSeconds - BIWA.minSeconds);
  }

  get active() {
    return this.state !== 'idle';
  }

  /** Fall profile: speed v0 at t=0, gravity until terminal velocity. Returns distance fallen. */
  disp(t) {
    return fallDistance(t, this.v0, this.terminal);
  }
  speedAt(t) {
    return Math.min(this.terminal, this.v0 + CONTROLLER.gravity * t);
  }

  /**
   * kind: 'strum' (hidden timer: trapdoor + rearrangement), 'catch' (fell into the void),
   *       'intro' (the opening: the castle assembles around him from nothing).
   * opts (intro): { layout, anchor, fallSeconds, terminal, onLanded }
   */
  trigger(kind = 'strum', opts = {}) {
    if (this.active) return;
    this.state = 'falling';
    this.kind = kind;
    this.t = 0;
    this.count++;
    this.audio.strum();
    this.fx.flash = 1;
    this.fallSeconds = opts.fallSeconds ?? BIWA.fallSeconds;
    this.terminal = opts.terminal ?? FALL_TERMINAL;
    this.onLanded = opts.onLanded ?? null;
    this.hold = opts.hold ?? 0; // suspended for a beat before gravity takes over
    const c = this.c;
    c.scripted = true;
    c.grounded = false;
    this.y0 = c.pos.y;
    this.v0 = Math.max(0, -c.vel.y);
    const D = this.disp(this.fallSeconds);
    this.committed = false;
    this.morphing = false;
    this.planner = null;
    this.assembleMode = !!opts.layout;
    this.layoutSeed = this.seed + this.count * 7919;
    if (opts.layout) {
      // the castle was generated (and uploaded) ahead of time with a pad at opts.anchor;
      // if its assembly was already staged (castle.busy), it simply starts playing now
      this.anchor = opts.anchor;
      this.pending = opts.layout;
      this.morphing = this.castle.busy;
      return;
    }
    const landY = this.y0 - D - 2.4;
    this.anchor = [c.pos.x, landY, c.pos.z];
    if (kind === 'strum') this.castle.openTrapdoor(c.pos);
    this.pending = null;
    const req = { id: ++this.reqId, seed: this.layoutSeed, anchor: this.anchor, shaftHeight: D + 14 };
    if (this.worker) this.worker.postMessage(req);
    else this.pending = generateLayout(req);
  }

  onLayout({ id, layout }) {
    if (id !== this.reqId) return;
    this.pending = layout;
  }

  update(dt) {
    const fx = this.fx;
    fx.flash = Math.max(0, fx.flash - dt * 1.6);
    castleUniforms.uPulse.value = fx.flash * fx.flash;
    rimUniform.value.setRGB(1.0, 0.45 - 0.33 * fx.flash, 0.18 - 0.1 * fx.flash);

    if (this.state === 'idle') {
      // Doma's hall is a safe zone: the timer pauses while he's inside (main sets `safe`) and resumes on the way out
      if (this.armed && !this.safe && this.c.enabled && this.c.grounded && this.c.interaction === 'none') {
        this.timer -= dt;
        if (this.timer <= 0) this.trigger('strum');
      }
      this.relax(dt);
      return;
    }

    this.t += dt;
    const t = this.t;
    const c = this.c;

    // the new castle: start sliding once it's ready and the trapdoor is open
    if (!this.morphing && this.pending && t >= BIWA.morphStart) {
      if (this.assembleMode) {
        this.castle.assemble(c.pos, this.anchor, this.layoutSeed, this.fallSeconds - BIWA.morphStart - 0.35);
        this.morphing = true;
        fx.flash = Math.max(fx.flash, 0.45);
      } else {
        // plan the rearrangement a few milliseconds per frame (no stall mid-fall);
        // it must finish before the landing, so a late plan shortens the slide
        this.planner ??= this.castle.planMorph(this.pending, c.pos, this.layoutSeed, Math.min(BIWA.morphSeconds, Math.max(1.6, this.hold + this.fallSeconds - t - 0.7)));
        const t0 = performance.now();
        let done = false;
        while (!done && performance.now() - t0 < 3.5) done = this.planner.next().done;
        if (done) {
          this.planner = null;
          this.morphing = true;
          fx.flash = Math.max(fx.flash, 0.45);
        }
      }
    }
    if (!this.morphing && !this.pending && t > 3.6 && this.worker) {
      // worker too slow: do it here rather than miss the landing
      this.pending = generateLayout({ seed: this.layoutSeed, anchor: this.anchor, shaftHeight: this.disp(this.fallSeconds) + 14 });
    }
    const committedNow = this.castle.update(dt);
    if (committedNow) {
      this.collision.setLayout(this.pending);
      this.onCommit?.(this.pending);
      this.committed = true;
    }

    if (this.state === 'falling') {
      // scripted plunge
      const tf = Math.max(0, t - this.hold);
      c.pos.y = this.y0 - this.disp(tf);
      c.vel.y = tf > 0 ? -this.speedAt(tf) : 0;
      const k = smoothstep(this.hold, this.hold + 0.55, t);
      fx.fall = Math.max(fx.fall, k);
      c.fx.fall = fx.fall;
      c.fx.shake = 1.3 * Math.exp(-t * 2.2) + 0.25 * k;
      c.fx.roll = Math.sin(t * 1.9) * 0.35 * k;
      fx.aberration = 0.012 * k;
      fx.zoom = clamp(-c.vel.y / this.terminal, 0, 1) * k;
      this.audio.setWind(fx.zoom);
      // release onto the pad once the castle has settled
      if (tf >= this.fallSeconds && this.committed) {
        c.scripted = false;
        c.vel.y = -this.speedAt(tf);
        c.airTime = 0;
        this.state = 'landing';
        this.landT = 0;
      } else if (tf >= this.fallSeconds) {
        // castle not committed yet (very slow device): hover-fall gently above the pad
        this.y0 += this.disp(tf) - this.disp(tf - dt) - 0.5 * dt;
      }
    } else if (this.state === 'landing') {
      this.landT += dt;
      if (c.grounded || this.landT > 3) {
        this.audio.setWind(0);
        c.fx.shake = this.kind === 'intro' ? 2.4 : 1.6;
        this.state = 'idle';
        this.scheduleNext();
        this.recenter();
        this.onLanded?.();
        this.onLanded = null;
      }
    }
  }

  relax(dt) {
    const fx = this.fx;
    const c = this.c;
    fx.fall += (0 - fx.fall) * damp(2.2, dt);
    c.fx.fall = fx.fall;
    c.fx.shake += (0 - c.fx.shake) * damp(4, dt);
    c.fx.roll += (0 - c.fx.roll) * damp(3, dt);
    fx.aberration += (0 - fx.aberration) * damp(4, dt);
    fx.zoom += (0 - fx.zoom) * damp(5, dt);
  }

  /** Keep coordinates near the origin by shifting whole periods (invisible: the castle repeats). */
  recenter() {
    const P = this.castle.period;
    const p = this.c.pos;
    const dx = -P[0] * Math.round(p.x / P[0]);
    const dy = -P[1] * Math.round(p.y / P[1]);
    const dz = -P[2] * Math.round(p.z / P[2]);
    if (dx || dy || dz) this.onShift(dx, dy, dz);
  }
}
