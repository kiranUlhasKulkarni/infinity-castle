import { CASTLE } from '../config.js';
import { mulberry32, wrapPositive, wrapSigned } from '../utils/math.js';

/**
 * Procedural Infinity Castle layout (pure data, no three.js).
 *
 * Structure (read from the circular blueprint): rooms, decks, stairs and
 * bridges packed around the viewer in EVERY direction, gravity turned
 * sideways and upside-down, so there is no horizon, no outside, no exit.
 *
 *  • The world is a periodic block (3-torus) split into cells.
 *  • "Upright" cells hold a compound with normal gravity: a wooden deck,
 *    shoji houses, railings, lanterns, an optional balcony with stairs and an
 *    upside-down room hanging beneath. Upright decks are linked by bridges
 *    (flat or stepped) and long staircases to the layer above/below — the
 *    walkable labyrinth.
 *  • Other cells hold the same kind of compound rotated by 90°/180° (Escher's
 *    Relativity): ceilings of houses, sideways stairs, inverted decks.
 *  • Giant beams and stair flights cross the void at impossible angles.
 *
 * Scale: cells are big (44 m), so upright decks are sprawling 26–38 m floors —
 * with open tatami halls, shoji houses and lanterns — joined to nearly every
 * neighbour by wide flat bridges (deck heights in a layer snap to a few
 * levels) or long, steep staircases. You can sprint for a long time.
 *
 * Every rotation inside a compound is a multiple of 90°, so every collidable
 * part has an exact axis-aligned box: what you see is what you stand on, even
 * on the side of a sideways house.
 *
 * Walkways reserve "clearance" volumes; decorative parts that would intrude
 * on someone else's walkway are dropped, so paths stay open while everything
 * else intersects freely.
 */

export const KIND = { floor: 0, beam: 1, roof: 2, step: 3, rail: 4, tatami: 5 };
export const CAT = { wood: 0, house: 1, lantern: 2 };

const STORY = 3.4;
const STEP_RISE = 0.3;
const HEAD_ROOM = 2.7;

const QI = [0, 0, 0, 1];

/* ───────────── quaternion helpers (plain arrays [x, y, z, w]) ───────────── */

function qAxis(ax, ay, az, angle) {
  const s = Math.sin(angle / 2);
  return [ax * s, ay * s, az * s, Math.cos(angle / 2)];
}
function qMul(a, b) {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
function qRotate(q, x, y, z) {
  const [qx, qy, qz, qw] = q;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [
    ix * qw + iw * -qx + iy * -qz - iz * -qy,
    iy * qw + iw * -qy + iz * -qx - ix * -qz,
    iz * qw + iw * -qz + ix * -qy - iy * -qx,
  ];
}
/** Half extents of the world AABB of a box (half sizes h) rotated by q. */
function rotatedHalf(q, hx, hy, hz) {
  const [x, y, z, w] = q;
  const m00 = 1 - 2 * (y * y + z * z), m01 = 2 * (x * y - z * w), m02 = 2 * (x * z + y * w);
  const m10 = 2 * (x * y + z * w), m11 = 1 - 2 * (x * x + z * z), m12 = 2 * (y * z - x * w);
  const m20 = 2 * (x * z - y * w), m21 = 2 * (y * z + x * w), m22 = 1 - 2 * (x * x + y * y);
  return [
    Math.abs(m00) * hx + Math.abs(m01) * hy + Math.abs(m02) * hz,
    Math.abs(m10) * hx + Math.abs(m11) * hy + Math.abs(m12) * hz,
    Math.abs(m20) * hx + Math.abs(m21) * hy + Math.abs(m22) * hz,
  ];
}

// "Up" of a rotated compound points along one of the other five axes.
const ORIENTATIONS = [
  qAxis(1, 0, 0, Math.PI), // upside down
  qAxis(0, 0, 1, -Math.PI / 2), // up → +x
  qAxis(0, 0, 1, Math.PI / 2), // up → -x
  qAxis(1, 0, 0, Math.PI / 2), // up → +z
  qAxis(1, 0, 0, -Math.PI / 2), // up → -z
];

/* ───────────── clearance volumes (spatial hash, periodic) ───────────── */

class ClearanceGrid {
  constructor(period, size = 16) {
    this.P = period;
    this.g = size;
    this.n = period.map((p) => Math.ceil(p / size));
    this.cells = new Map();
    this.boxes = [];
  }
  key(i, j, k) {
    const [nx, ny, nz] = this.n;
    i = ((i % nx) + nx) % nx;
    j = ((j % ny) + ny) % ny;
    k = ((k % nz) + nz) % nz;
    return i + nx * (j + ny * k);
  }
  add(cx, cy, cz, hx, hy, hz, owner, hard = false) {
    const id = this.boxes.length;
    this.boxes.push({ c: [cx, cy, cz], h: [hx, hy, hz], owner, hard });
    this.forCells(cx, cy, cz, hx, hy, hz, (key) => {
      let list = this.cells.get(key);
      if (!list) this.cells.set(key, (list = []));
      list.push(id);
    });
  }
  forCells(cx, cy, cz, hx, hy, hz, fn) {
    const g = this.g;
    const i0 = Math.floor((cx - hx) / g), i1 = Math.floor((cx + hx) / g);
    const j0 = Math.floor((cy - hy) / g), j1 = Math.floor((cy + hy) / g);
    const k0 = Math.floor((cz - hz) / g), k1 = Math.floor((cz + hz) / g);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) for (let k = k0; k <= k1; k++) fn(this.key(i, j, k));
  }
  /** True if the box hits a clearance of another owner (hard ones block everyone, incl. walkways). */
  blocked(cx, cy, cz, hx, hy, hz, owner, walkway) {
    const P = this.P;
    let hit = false;
    const seen = new Set();
    this.forCells(cx, cy, cz, hx, hy, hz, (key) => {
      if (hit) return;
      const list = this.cells.get(key);
      if (!list) return;
      for (const id of list) {
        if (seen.has(id)) continue;
        seen.add(id);
        const b = this.boxes[id];
        if (b.owner === owner) continue;
        if (walkway && !b.hard) continue;
        if (
          Math.abs(wrapSigned(cx - b.c[0], P[0])) < hx + b.h[0] &&
          Math.abs(wrapSigned(cy - b.c[1], P[1])) < hy + b.h[1] &&
          Math.abs(wrapSigned(cz - b.c[2], P[2])) < hz + b.h[2]
        ) {
          hit = true;
          return;
        }
      }
    });
    return hit;
  }
}

/* ───────────── part sink ───────────── */

class PartSink {
  constructor(period, clear) {
    this.P = period;
    this.clear = clear;
    this.parts = [[], [], []]; // per category
    this.colliders = [];
    this.lamps = [];
  }
  /**
   * cat: CAT.*, c: world centre, s: full size in the part's own frame, q: world rotation.
   * flags: collide, render (default true), walkway (immune to soft clearances), owner.
   */
  emit(cat, c, s, q, info, { collide = false, render = true, walkway = false, owner = -1, aabbExact = true, skipClear = false } = {}) {
    const h = rotatedHalf(q, s[0] / 2, s[1] / 2, s[2] / 2);
    if (!skipClear && this.clear.blocked(c[0], c[1], c[2], h[0], h[1], h[2], owner, walkway)) return false;
    const P = this.P;
    const cx = wrapPositive(c[0], P[0]), cy = wrapPositive(c[1], P[1]), cz = wrapPositive(c[2], P[2]);
    if (render) this.parts[cat].push({ c: [cx, cy, cz], s, q, info });
    if (collide && aabbExact) this.colliders.push([cx, cy, cz, h[0], h[1], h[2]]);
    if (cat === CAT.lantern && render) this.lamps.push([cx, cy, cz]);
    return true;
  }
}

/**
 * A local frame (compound / walkway): emits parts given in local coordinates.
 */
class Frame {
  constructor(sink, q, t, owner) {
    this.sink = sink;
    this.q = q;
    this.t = t;
    this.owner = owner;
  }
  part(cat, x, y, z, sx, sy, sz, info, flags = {}, localQ = QI) {
    const p = qRotate(this.q, x, y, z);
    const c = [p[0] + this.t[0], p[1] + this.t[1], p[2] + this.t[2]];
    const q = localQ === QI ? this.q : qMul(this.q, localQ);
    const exact = localQ === QI && flags.aabbExact !== false;
    return this.sink.emit(cat, c, [sx, sy, sz], q, info, { owner: this.owner, ...flags, aabbExact: exact });
  }
  /** True if a local box is free of other owners' clearance (used to place houses whole or not at all). */
  free(x, y, z, sx, sy, sz) {
    const p = qRotate(this.q, x, y, z);
    const h = rotatedHalf(this.q, sx / 2, sy / 2, sz / 2);
    return !this.sink.clear.blocked(p[0] + this.t[0], p[1] + this.t[1], p[2] + this.t[2], h[0], h[1], h[2], this.owner, false);
  }
  wood(kind, x, y, z, sx, sy, sz, rnd, flags, localQ) {
    return this.part(CAT.wood, x, y, z, sx, sy, sz, [kind, rnd(), 0.6 + rnd() * 0.8, 0], flags, localQ);
  }
}

/* ───────────── builders ───────────── */

/** Railing along a deck edge with gaps: posts (visual) + rails (top one collides). */
function railing(f, rnd, ax, a0, a1, cross, y, gaps, opts = {}) {
  // ax: 'x' → rail runs along x at z = cross; 'z' → along z at x = cross
  const segs = [];
  let start = a0;
  const sorted = gaps.slice().sort((p, q) => p[0] - q[0]);
  for (const [g0, g1] of sorted) {
    if (g0 > start + 0.3) segs.push([start, g0]);
    start = Math.max(start, g1);
  }
  if (a1 > start + 0.3) segs.push([start, a1]);
  for (const [s0, s1] of segs) {
    const len = s1 - s0;
    const mid = (s0 + s1) / 2;
    const P = (along, yy, sa, sy, sc, flags) =>
      ax === 'x'
        ? f.wood(KIND.rail, along, yy, cross, sa, sy, sc, rnd, flags)
        : f.wood(KIND.rail, cross, yy, along, sc, sy, sa, rnd, flags);
    P(mid, y + 1.0, len, 0.12, 0.14, { collide: true, walkway: opts.walkway });
    P(mid, y + 0.5, len, 0.07, 0.08, { walkway: opts.walkway });
    const posts = Math.max(1, Math.round(len / 2.4));
    for (let i = 0; i <= posts; i++) {
      const a = s0 + (len * i) / posts;
      P(a, y + 0.52, 0.16, 1.04, 0.16, { walkway: opts.walkway });
      if (opts.lanterns && i % 3 === 1 && rnd() < 0.55) {
        const lx = ax === 'x' ? a : cross, lz = ax === 'x' ? cross : a;
        f.part(CAT.lantern, lx, y + 1.42, lz, 0.38, 0.56, 0.38, [rnd(), 0.8 + rnd() * 0.6, 0, 0], { walkway: opts.walkway });
      }
    }
  }
}

/**
 * A straight staircase along local x (dir ±1) from (a0, y0) to (a1, y1) at z = cross.
 * Generated in the frame's coordinates; `axis` 'x' | 'z'.
 */
function stairs(f, rnd, axis, aLow, aHigh, yLow, yHigh, cross, width, opts = {}) {
  const rise = yHigh - yLow;
  const n = Math.max(1, Math.round(rise / STEP_RISE));
  const h = rise / n;
  const run = (aHigh - aLow) / n;
  const wk = opts.walkway ?? true;
  const flags = { collide: true, walkway: wk };
  const P = (along, yy, sa, sy, sc, kind, fl, q) =>
    axis === 'x'
      ? f.wood(kind, along, yy, cross, sa, sy, sc, rnd, fl, q)
      : f.wood(kind, cross, yy, along, sc, sy, sa, rnd, fl, q);
  for (let k = 1; k <= n; k++) {
    const top = yLow + k * h;
    const a = aLow + (k - 0.5) * run;
    const th = h + 0.32;
    P(a, top - th / 2, Math.abs(run) + 0.03, th, width, KIND.step, flags);
    // invisible side guards so you can't step off the side of the flight
    for (const side of [-1, 1]) {
      const off = side * (width / 2 + 0.08);
      if (axis === 'x') f.wood(KIND.rail, a, top + 0.6, cross + off, Math.abs(run) + 0.03, 1.2, 0.1, rnd, { collide: true, render: false, walkway: wk });
      else f.wood(KIND.rail, cross + off, top + 0.6, a, 0.1, 1.2, Math.abs(run) + 0.03, rnd, { collide: true, render: false, walkway: wk });
    }
  }
  // Tilted stringers + handrails (visual only)
  const lenA = aHigh - aLow;
  const L = Math.hypot(lenA, rise);
  const theta = Math.atan2(rise, Math.abs(lenA)) * Math.sign(lenA);
  const midA = (aLow + aHigh) / 2;
  const midY = (yLow + yHigh) / 2;
  const q = axis === 'x' ? qAxis(0, 0, 1, theta) : qAxis(1, 0, 0, -theta);
  for (const side of [-1, 1]) {
    const off = cross + side * (width / 2 + 0.06);
    const S = (yy, sy, sw, kind) =>
      axis === 'x'
        ? f.wood(kind, midA, yy, off, L + 0.4, sy, sw, rnd, { walkway: wk }, q)
        : f.wood(kind, off, yy, midA, sw, sy, L + 0.4, rnd, { walkway: wk }, q);
    S(midY - 0.28, 0.5, 0.2, KIND.beam);
    if (opts.handrail !== false) S(midY + 0.98, 0.09, 0.1, KIND.rail);
  }
  if (opts.lanterns) {
    const lx = axis === 'x' ? aLow : cross + width / 2 + 0.06;
    const lz = axis === 'x' ? cross + width / 2 + 0.06 : aLow;
    f.part(CAT.lantern, lx, yLow + 1.45, lz, 0.38, 0.56, 0.38, [rnd(), 1, 0, 0], { walkway: wk });
  }
}

/** A flat bridge along `axis` between a0..a1 at height y (deck top), centred on `cross`. */
function bridge(f, rnd, axis, a0, a1, y, cross, width) {
  const len = a1 - a0;
  const mid = (a0 + a1) / 2;
  const fl = { collide: true, walkway: true };
  const P = (along, yy, sa, sy, sc, kind, flags) =>
    axis === 'x' ? f.wood(kind, along, yy, cross, sa, sy, sc, rnd, flags) : f.wood(kind, cross, yy, along, sc, sy, sa, rnd, flags);
  P(mid, y - 0.2, len + 0.1, 0.4, width, KIND.floor, fl);
  // beams under both edges
  for (const s of [-1, 1]) {
    const off = s * (width / 2 - 0.15);
    if (axis === 'x') f.wood(KIND.beam, mid, y - 0.6, cross + off, len, 0.45, 0.3, rnd, { walkway: true });
    else f.wood(KIND.beam, cross + off, y - 0.6, mid, 0.3, 0.45, len, rnd, { walkway: true });
  }
  for (const s of [-1, 1]) railing(f, rnd, axis, a0, a1, cross + s * (width / 2 - 0.08), y, [], { walkway: true, lanterns: true });
  // covered corridor (like the long roofed bridge in the blueprint)
  if (rnd() < 0.42) {
    const n = Math.max(1, Math.round(len / 4.5));
    for (let i = 0; i <= n; i++) {
      const a = a0 + (len * i) / n;
      for (const s of [-1, 1]) {
        const off = cross + s * (width / 2 - 0.08);
        if (axis === 'x') f.wood(KIND.beam, a, y + 1.5, off, 0.22, 3.0, 0.22, rnd, { walkway: true });
        else f.wood(KIND.beam, off, y + 1.5, a, 0.22, 3.0, 0.22, rnd, { walkway: true });
      }
      if (i < n && rnd() < 0.6) {
        const la = a0 + (len * (i + 0.5)) / n;
        if (axis === 'x') f.part(CAT.lantern, la, y + 2.45, cross, 0.42, 0.62, 0.42, [rnd(), 1.2, 0, 0], { walkway: true });
        else f.part(CAT.lantern, cross, y + 2.45, la, 0.42, 0.62, 0.42, [rnd(), 1.2, 0, 0], { walkway: true });
      }
    }
    P(mid, y + 3.12, len + 1.2, 0.26, width + 1.4, KIND.roof, { collide: true, walkway: true });
    P(mid, y + 3.42, len + 0.6, 0.34, width * 0.55, KIND.roof, { walkway: true });
  }
  // a pillar or two dropping into the void
  if (len > 9 && rnd() < 0.7) {
    const L = 8 + rnd() * 30;
    P(mid, y - 0.4 - L / 2, 0.55, L, 0.55, KIND.beam, { walkway: true });
  }
}

/** A shoji house with eaves, roof and hanging lanterns. Base at local y = by. `flip` hangs it upside down. */
function house(f, rnd, x, by, z, w, d, stories, flip = false) {
  const H = STORY * stories;
  const sgn = flip ? -1 : 1;
  const cy = by + (sgn * H) / 2;
  // all or nothing: a house never loses its walls and keeps a floating roof
  if (!f.free(x, by + (sgn * (H + 1.2)) / 2, z, w + 2.4, H + 1.2, d + 2.4)) return 0;
  f.part(CAT.house, x, cy, z, w, H, d, [rnd(), 0.55 + rnd() * 0.4, stories, 0], { collide: true });
  // sill
  f.wood(KIND.beam, x, by + sgn * 0.12, z, w + 0.14, 0.24, d + 0.14, rnd);
  // mid eave on two-storey houses
  if (stories > 1) f.wood(KIND.roof, x, by + sgn * STORY, z, w + 1.3, 0.24, d + 1.3, rnd, { collide: true });
  // eave + upper roof block
  const top = by + sgn * H;
  f.wood(KIND.roof, x, top + sgn * 0.17, z, w + 1.7, 0.34, d + 1.7, rnd, { collide: true });
  f.wood(KIND.roof, x, top + sgn * 0.62, z, w * 0.72 + 0.4, 0.58, d * 0.72 + 0.4, rnd, { collide: true });
  if (rnd() < 0.35) f.wood(KIND.roof, x, top + sgn * 1.05, z, w * 0.4, 0.3, d * 0.4, rnd);
  // lanterns hanging from the eave corners
  for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    if (rnd() < 0.55) f.part(CAT.lantern, x + sx * (w / 2 + 0.55), top - sgn * 0.62, z + sz * (d / 2 + 0.55), 0.42, 0.62, 0.42, [rnd(), 0.8 + rnd() * 0.7, 0, 0]);
  }
  return H;
}

/**
 * An open tatami hall on a deck: a raised tatami floor under a big roof held up
 * by pillars, with shoji walls on one or two sides (the rest stays open, so you
 * can run straight through). Local deck frame, floor top at y = 0.
 */
function tatamiHall(f, rnd, x, z, w, d) {
  const H = 4.2;
  // the mats (a hand's breadth above the deck: stepping up is automatic)
  f.wood(KIND.tatami, x, 0.05, z, w, 0.1, d, rnd, { collide: true, walkway: true });
  // border beam around the mats
  for (const s of [-1, 1]) {
    f.wood(KIND.beam, x, 0.07, z + s * (d / 2 + 0.1), w + 0.4, 0.14, 0.2, rnd);
    f.wood(KIND.beam, x + s * (w / 2 + 0.1), 0.07, z, 0.2, 0.14, d, rnd);
  }
  // pillars every ~3.6 m around the edge
  const nx = Math.max(2, Math.round(w / 3.6)), nz = Math.max(2, Math.round(d / 3.6));
  const pillar = (px, pz) => f.wood(KIND.beam, px, H / 2, pz, 0.34, H, 0.34, rnd, { collide: true });
  for (let i = 0; i <= nx; i++) for (const s of [-1, 1]) pillar(x - w / 2 + (w * i) / nx, z + s * d / 2);
  for (let i = 1; i < nz; i++) for (const s of [-1, 1]) pillar(x + s * w / 2, z - d / 2 + (d * i) / nz);
  // shoji walls on one or two sides (thin lit paper slabs between the pillars)
  const sides = [['x', -1], ['x', 1], ['z', -1], ['z', 1]].sort(() => rnd() - 0.5).slice(0, rnd() < 0.5 ? 1 : 2);
  for (const [ax, s] of sides) {
    if (ax === 'x') f.part(CAT.house, x, H / 2 - 0.05, z + s * d / 2, w - 0.4, H - 0.3, 0.16, [rnd(), 0.55 + rnd() * 0.35, 1, 0], { collide: true });
    else f.part(CAT.house, x + s * w / 2, H / 2 - 0.05, z, 0.16, H - 0.3, d - 0.4, [rnd(), 0.55 + rnd() * 0.35, 1, 0], { collide: true });
  }
  // roof: beams, a wide eave and a raised ridge block
  for (const s of [-1, 1]) {
    f.wood(KIND.beam, x, H + 0.15, z + s * d / 2, w + 0.6, 0.3, 0.34, rnd);
    f.wood(KIND.beam, x + s * w / 2, H + 0.15, z, 0.34, 0.3, d + 0.6, rnd);
  }
  f.wood(KIND.roof, x, H + 0.47, z, w + 2.2, 0.34, d + 2.2, rnd, { collide: true });
  f.wood(KIND.roof, x, H + 1.0, z, w * 0.7, 0.7, d * 0.7, rnd, { collide: true });
  f.wood(KIND.roof, x, H + 1.55, z, w * 0.36, 0.4, d * 0.2, rnd);
  // lanterns hanging inside
  for (let i = 0; i < 3; i++) {
    if (rnd() < 0.7) f.part(CAT.lantern, x + (rnd() - 0.5) * (w - 2), H - 0.7, z + (rnd() - 0.5) * (d - 2), 0.46, 0.66, 0.46, [rnd(), 0.9 + rnd() * 0.5, 0, 0]);
  }
}

const overlaps = (a, b, m = 0) => a[0] - m < b[2] && a[2] + m > b[0] && a[1] - m < b[3] && a[3] + m > b[1];

/**
 * A compound in its local frame: deck top at y = 0, deck spans x∈[-w/2, w/2], z∈[-d/2, d/2].
 * gaps: { '+x': [[a0, a1]], … } railing openings where walkways attach.
 */
function compound(f, rnd, spec) {
  const { w, d, gaps = {}, avoid = null, upright, allowBalcony } = spec;
  const hw = w / 2, hd = d / 2;
  const deckFlags = { collide: true, walkway: upright };
  f.wood(KIND.floor, 0, -0.3, 0, w, 0.6, d, rnd, deckFlags);
  // perimeter beams under the deck
  f.wood(KIND.beam, 0, -0.85, hd - 0.25, w, 0.5, 0.4, rnd);
  f.wood(KIND.beam, 0, -0.85, -hd + 0.25, w, 0.5, 0.4, rnd);
  f.wood(KIND.beam, hw - 0.25, -0.85, 0, 0.4, 0.5, d, rnd);
  f.wood(KIND.beam, -hw + 0.25, -0.85, 0, 0.4, 0.5, d, rnd);
  // pillars plunging into the void (and a few tall posts rising through)
  const pillarPts = [[-hw + 0.5, -hd + 0.5], [hw - 0.5, -hd + 0.5], [-hw + 0.5, hd - 0.5], [hw - 0.5, hd - 0.5]];
  if (w > 12) pillarPts.push([0, -hd + 0.5], [0, hd - 0.5]);
  if (d > 12) pillarPts.push([-hw + 0.5, 0], [hw - 0.5, 0]);
  for (const [px, pz] of pillarPts) {
    if (rnd() < 0.8) {
      const L = 5 + rnd() * rnd() * 34;
      f.wood(KIND.beam, px, -0.6 - L / 2, pz, 0.62, L, 0.62, rnd, { collide: true });
    }
    if (rnd() < 0.12) {
      const L = 8 + rnd() * 14;
      f.wood(KIND.beam, px, L / 2, pz, 0.5, L, 0.5, rnd, { collide: true });
    }
  }

  const obstacles = []; // [x0, z0, x1, z1] rects houses must avoid
  if (avoid) obstacles.push([avoid[0] - 3.6, avoid[1] - 3.6, avoid[0] + 3.6, avoid[1] + 3.6]);
  // keep lanes clear inward from each walkway attachment
  for (const [side, list] of Object.entries(gaps)) {
    for (const [g0, g1] of list) {
      if (side === '+x') obstacles.push([hw - 4, g0 - 0.6, hw, g1 + 0.6]);
      if (side === '-x') obstacles.push([-hw, g0 - 0.6, -hw + 4, g1 + 0.6]);
      if (side === '+z') obstacles.push([g0 - 0.6, hd - 4, g1 + 0.6, hd]);
      if (side === '-z') obstacles.push([g0 - 0.6, -hd, g1 + 0.6, -hd + 4]);
    }
  }

  // balcony at a corner, reached by a short flight of stairs
  const balconyGaps = [];
  if (allowBalcony && rnd() < 0.5) {
    const bw = 5 + rnd() * 3, bd = 5 + rnd() * 3;
    const steps = rnd() < 0.5 ? 14 : 20;
    const hb = steps * STEP_RISE;
    const run = steps * 0.36;
    const sx = rnd() < 0.5 ? -1 : 1, sz = rnd() < 0.5 ? -1 : 1;
    const bx0 = sx > 0 ? hw - bw : -hw, bx1 = bx0 + bw;
    const bz0 = sz > 0 ? hd - bd : -hd, bz1 = bz0 + bd;
    const stairEnd = sx > 0 ? bx0 : bx1; // stairs arrive at the balcony's inner x edge
    const stairStart = stairEnd - sx * run;
    if (Math.abs(stairStart) < hw - 1.2 && f.free((bx0 + bx1) / 2, hb / 2 + 1, (bz0 + bz1) / 2, bw, hb + 2, bd)) {
      const bcx = (bx0 + bx1) / 2, bcz = (bz0 + bz1) / 2;
      f.wood(KIND.floor, bcx, hb - 0.25, bcz, bw, 0.5, bd, rnd, deckFlags);
      for (const px of [bx0 + 0.3, bx1 - 0.3]) for (const pz of [bz0 + 0.3, bz1 - 0.3]) f.wood(KIND.beam, px, hb / 2 - 0.25, pz, 0.4, hb - 0.5, 0.4, rnd, { collide: true });
      const laneZ = bcz;
      stairs(f, rnd, 'x', stairStart, stairEnd, 0, hb, laneZ, 1.5, { lanterns: rnd() < 0.5, walkway: upright });
      // balcony railings (gap where the stairs arrive)
      const gapZ = [[laneZ - 0.9, laneZ + 0.9]];
      railing(f, rnd, 'z', bz0, bz1, sx > 0 ? bx0 + 0.08 : bx1 - 0.08, hb, gapZ, { lanterns: true });
      railing(f, rnd, 'z', bz0, bz1, sx > 0 ? bx1 - 0.08 : bx0 + 0.08, hb, []);
      railing(f, rnd, 'x', bx0, bx1, bz0 + 0.08, hb, []);
      railing(f, rnd, 'x', bx0, bx1, bz1 - 0.08, hb, []);
      obstacles.push([Math.min(bx0, stairStart) - 0.4, bz0 - 0.4, Math.max(bx1, stairStart), bz1 + 0.4]);
      balconyGaps.push(sx > 0 ? '+x' : '-x');
      if (rnd() < 0.45 && bw > 5.5 && bd > 5.5) house(f, rnd, bcx, hb, bcz, bw - 2.6, bd - 2.6, 1);
    }
  }

  // railings around the main deck
  const noRail = upright ? 0.22 : 0.5;
  const sideRail = (side, ax, a0, a1, cross) => {
    if (rnd() < noRail && !(gaps[side]?.length)) return;
    railing(f, rnd, ax, a0, a1, cross, 0, gaps[side] ?? [], { lanterns: true });
  };
  sideRail('+z', 'x', -hw, hw, hd - 0.08);
  sideRail('-z', 'x', -hw, hw, -hd + 0.08);
  sideRail('+x', 'z', -hd, hd, hw - 0.08);
  sideRail('-x', 'z', -hd, hd, -hw + 0.08);

  // shoji houses on the deck (a walkable ring stays open around them)
  const margin = upright ? 2.1 : 1.0;
  const placed = [];
  const big = upright && w > 20 && d > 20;
  // an open tatami hall on the big decks
  if (big && rnd() < CASTLE.hallChance) {
    for (let tries = 0; tries < 8; tries++) {
      const hwid = 9 + rnd() * Math.min(8, w - 2 * margin - 12), hdep = 8 + rnd() * Math.min(7, d - 2 * margin - 12);
      const x = -hw + margin + 1 + hwid / 2 + rnd() * (w - 2 * margin - 2 - hwid);
      const z = -hd + margin + 1 + hdep / 2 + rnd() * (d - 2 * margin - 2 - hdep);
      const rect = [x - hwid / 2 - 1.2, z - hdep / 2 - 1.2, x + hwid / 2 + 1.2, z + hdep / 2 + 1.2];
      if (obstacles.some((o) => overlaps(rect, o, 0.2))) continue;
      if (!f.free(x, 3, z, hwid + 2.2, 6, hdep + 2.2)) continue;
      placed.push(rect);
      tatamiHall(f, rnd, x, z, hwid, hdep);
      break;
    }
  }
  const maxHouses = big ? 6 : 3;
  for (let tries = 0; tries < (big ? 30 : 14) && placed.length < maxHouses; tries++) {
    const maxW = w - margin * 2, maxD = d - margin * 2;
    if (maxW < 3.5 || maxD < 3.5) break;
    const hwid = 3.5 + rnd() * Math.min(7, maxW - 3.5);
    const hdep = 3.5 + rnd() * Math.min(7, maxD - 3.5);
    const x = -hw + margin + hwid / 2 + rnd() * (maxW - hwid);
    const z = -hd + margin + hdep / 2 + rnd() * (maxD - hdep);
    const rect = [x - hwid / 2, z - hdep / 2, x + hwid / 2, z + hdep / 2];
    if (obstacles.some((o) => overlaps(rect, o, 0.2)) || placed.some((p) => overlaps(rect, p, 1.4))) continue;
    placed.push(rect);
    house(f, rnd, x, 0, z, hwid, hdep, rnd() < 0.38 ? 2 : 1);
  }
  // an upside-down room hanging beneath the deck
  if (rnd() < 0.33) {
    const hwid = Math.min(w - 2, 4 + rnd() * 6), hdep = Math.min(d - 2, 4 + rnd() * 6);
    house(f, rnd, (rnd() - 0.5) * (w - hwid), -0.6, (rnd() - 0.5) * (d - hdep), hwid, hdep, rnd() < 0.3 ? 2 : 1, true);
  }
}

/* ───────────── main entry ───────────── */

/**
 * @param {object} opts
 * @param {number} opts.seed
 * @param {number[]} opts.anchor  [x, y, z] — a deck top is guaranteed exactly here (spawn / Biwa landing pad)
 * @param {number}  [opts.shaftHeight] — clear vertical shaft above the anchor (for the fall)
 */
export function generateLayout({ seed = CASTLE.seed, anchor = [0, 0, 0], shaftHeight = 0, reserve = [] } = {}) {
  const rnd = mulberry32(seed);
  const [cx, cy, cz] = CASTLE.cell;
  const [nx, ny, nz] = CASTLE.cells;
  const P = [cx * nx, cy * ny, cz * nz];
  const clear = new ClearanceGrid(P);
  const sink = new PartSink(P, clear);
  const idx = (i, j, k) => (((i % nx) + nx) % nx) + nx * ((((j % ny) + ny) % ny) + ny * (((k % nz) + nz) % nz));

  const A = [wrapPositive(anchor[0], P[0]), wrapPositive(anchor[1], P[1]), wrapPositive(anchor[2], P[2])];
  const ai = Math.floor(A[0] / cx), aj = Math.floor(A[1] / cy), ak = Math.floor(A[2] / cz);

  // Shaft above the landing pad: nothing at all may intrude.
  const shaftR = 3.4;
  const shaftH = Math.min(shaftHeight, P[1] - 6);
  if (shaftH > 0) clear.add(A[0], A[1] + 0.25 + shaftH / 2, A[2], shaftR, shaftH / 2, shaftR, -2, true);
  // other volumes nothing may enter (e.g. the opening's tatami room): [cx, cy, cz, hx, hy, hz]
  for (const r of reserve) clear.add(wrapPositive(r[0], P[0]), wrapPositive(r[1], P[1]), wrapPositive(r[2], P[2]), r[3], r[4], r[5], -3, true);

  /* 1 ─ cell types */
  const N = nx * ny * nz;
  const type = new Int8Array(N); // 0 empty, 1 upright, 2 rotated
  const orient = new Int8Array(N);
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const id = idx(i, j, k);
        const r = rnd();
        type[id] = r < CASTLE.emptyChance ? 0 : rnd() < CASTLE.uprightChance ? 1 : 2;
        orient[id] = Math.floor(rnd() * ORIENTATIONS.length);
      }
  type[idx(ai, aj, ak)] = 1;
  // keep the column above the pad empty so the fall is clean
  if (shaftH > 0) {
    const layers = Math.ceil((shaftH + 4) / cy) + 1;
    for (let l = 1; l <= layers; l++) if (l < ny) type[idx(ai, aj + l, ak)] = 0;
  }

  /* 2 ─ upright decks */
  const decks = new Map(); // id → deck
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const id = idx(i, j, k);
        if (type[id] !== 1) continue;
        const isAnchor = i === ai && j === aj && k === ak;
        const [s0, s1] = CASTLE.deckSize;
        const w = s0 + rnd() * (s1 - s0), d = s0 + rnd() * (s1 - s0);
        let x, y, z;
        if (isAnchor) {
          x = A[0] + (rnd() - 0.5) * (w - 7.5);
          z = A[2] + (rnd() - 0.5) * (d - 7.5);
          y = A[1];
        } else {
          const jx = Math.max(0, (cx - w) / 2 - 1.2), jz = Math.max(0, (cz - d) / 2 - 1.2);
          x = i * cx + cx / 2 + (rnd() * 2 - 1) * jx;
          z = k * cz + cz / 2 + (rnd() * 2 - 1) * jz;
          // heights in a layer snap to a few levels, so most neighbours join flat
          y = j * cy + 2.5 + [0, 0, 0, 1.8, 3.6][Math.floor(rnd() * 5)];
        }
        decks.set(id, { id, i, j, k, x, y, z, w, d, isAnchor, gaps: { '+x': [], '-x': [], '+z': [], '-z': [] }, up: 0 });
      }
  // the pad's deck may poke out of its cell: clear neighbours it would collide with
  const pad = decks.get(idx(ai, aj, ak));
  for (const dk of decks.values()) {
    if (dk === pad) continue;
    const ddx = Math.abs(wrapSigned(dk.x - pad.x, P[0])), ddz = Math.abs(wrapSigned(dk.z - pad.z, P[2])), ddy = Math.abs(wrapSigned(dk.y - pad.y, P[1]));
    if (ddx < (dk.w + pad.w) / 2 + 2 && ddz < (dk.d + pad.d) / 2 + 2 && ddy < 9) {
      decks.delete(dk.id);
      type[dk.id] = 0;
    }
  }
  // deck clearance (walk space above each upright deck)
  for (const dk of decks.values()) clear.add(dk.x, dk.y + HEAD_ROOM / 2 - 0.3, dk.z, dk.w / 2, HEAD_ROOM / 2 + 0.3, dk.d / 2, dk.id);

  /* 3 ─ walkways between upright decks */
  let walkOwner = N + 10;
  const walkways = [];
  const tryLink = (a, b, axis, allowRise) => {
    // a → b along +axis (b is the neighbour with the larger coordinate, unwrapped)
    const crossA0 = axis === 'x' ? a.z - a.d / 2 : a.x - a.w / 2;
    const crossA1 = axis === 'x' ? a.z + a.d / 2 : a.x + a.w / 2;
    const bc = axis === 'x' ? a.z + wrapSigned(b.z - a.z, P[2]) : a.x + wrapSigned(b.x - a.x, P[0]);
    const bHalfC = axis === 'x' ? b.d / 2 : b.w / 2;
    const lo = Math.max(crossA0, bc - bHalfC) + 2.4;
    const hi = Math.min(crossA1, bc + bHalfC) - 2.4;
    if (hi < lo) return false;
    const cross = lo + rnd() * (hi - lo);
    const aEdge = axis === 'x' ? a.x + a.w / 2 : a.z + a.d / 2;
    const bAlong = axis === 'x' ? a.x + wrapSigned(b.x - a.x, P[0]) : a.z + wrapSigned(b.z - a.z, P[2]);
    const bEdge = bAlong - (axis === 'x' ? b.w / 2 : b.d / 2);
    const gap = bEdge - aEdge;
    if (gap < 1.5) return false;
    const by = a.y + wrapSigned(b.y - a.y, P[1]);
    const dy = by - a.y;
    const flat = Math.abs(dy) < 0.4;
    if (!flat && (!allowRise || Math.abs(dy) / gap > 1.05)) return false; // steep but runnable (0.3 m risers)
    // walkway clearance volume (must not cut through another walkway's space)
    const midA = (aEdge + bEdge) / 2;
    const yLo = Math.min(a.y, by), yHi = Math.max(a.y, by);
    const ccx = axis === 'x' ? midA : cross, ccz = axis === 'x' ? cross : midA;
    const halfW = (flat ? CASTLE.bridgeWidth : CASTLE.stairWidth) / 2 + 0.3;
    const hx = axis === 'x' ? gap / 2 - 0.4 : halfW, hz = axis === 'x' ? halfW : gap / 2 - 0.4;
    const owner = walkOwner++;
    const cyy = (yLo + yHi + HEAD_ROOM) / 2 - 0.4, hy = (yHi - yLo + HEAD_ROOM + 0.8) / 2;
    if (clear.blocked(ccx, cyy, ccz, hx, hy, hz, owner, false)) return false;
    clear.add(ccx, cyy, ccz, hx, hy, hz, owner);
    walkways.push({ axis, aEdge, bEdge, ay: a.y, by, cross, owner, flat, a: a.id, b: b.id });
    const ga = axis === 'x' ? '+x' : '+z', gb = axis === 'x' ? '-x' : '-z';
    const gapA = axis === 'x' ? cross - a.z : cross - a.x;
    const gapB = axis === 'x' ? cross - bc : cross - (a.x + wrapSigned(b.x - a.x, P[0]));
    const gw = (flat ? CASTLE.bridgeWidth : CASTLE.stairWidth) / 2 + 0.15;
    a.gaps[ga].push([gapA - gw, gapA + gw]);
    b.gaps[gb].push([gapB - gw, gapB + gw]);
    return true;
  };
  for (const a of decks.values()) {
    for (const axis of ['x', 'z']) {
      const nb = axis === 'x' ? decks.get(idx(a.i + 1, a.j, a.k)) : decks.get(idx(a.i, a.j, a.k + 1));
      if (nb && rnd() < CASTLE.linkChance) tryLink(a, nb, axis, true);
    }
  }
  // long staircases to the layer above (diagonal neighbours)
  for (const a of decks.values()) {
    const opts = [
      [1, 0, 'x', false], [0, 1, 'z', false], [-1, 0, 'x', true], [0, -1, 'z', true],
    ];
    for (let n = opts.length - 1; n > 0; n--) {
      const m = Math.floor(rnd() * (n + 1));
      [opts[n], opts[m]] = [opts[m], opts[n]];
    }
    for (const [di, dk, axis, reverse] of opts) {
      if (a.up >= 2 || rnd() > 0.7) continue;
      const b = decks.get(idx(a.i + di, a.j + 1, a.k + dk));
      if (!b) continue;
      const ok = reverse ? tryLink(b, a, axis, true) : tryLink(a, b, axis, true);
      if (ok) a.up++;
    }
  }

  // connectivity stats (cheap; handy for tuning): decks joined by walkways
  const stats = (() => {
    const parent = new Map([...decks.keys()].map((k) => [k, k]));
    const find = (x) => (parent.get(x) === x ? x : (parent.set(x, find(parent.get(x))), parent.get(x)));
    for (const wk of walkways) if (wk.a !== undefined) parent.set(find(wk.a), find(wk.b));
    const sizes = new Map();
    for (const k of decks.keys()) sizes.set(find(k), (sizes.get(find(k)) ?? 0) + 1);
    return { decks: decks.size, walkways: walkways.length, flat: walkways.filter((w) => w.flat).length, largestGroup: Math.max(...sizes.values()), padGroup: sizes.get(find(idx(ai, aj, ak))) };
  })();

  /* 4 ─ build walkways (before compounds so their parts respect walkway space) */
  for (const wk of walkways) {
    const f = new Frame(sink, QI, [0, 0, 0], wk.owner);
    const fr = mulberry32(wk.owner * 7919 + seed);
    if (wk.flat) bridge(f, fr, wk.axis, wk.aEdge, wk.bEdge, Math.max(wk.ay, wk.by), wk.cross, CASTLE.bridgeWidth);
    else if (wk.by > wk.ay) stairs(f, fr, wk.axis, wk.aEdge, wk.bEdge, wk.ay, wk.by, wk.cross, CASTLE.stairWidth, { lanterns: true });
    else stairs(f, fr, wk.axis, wk.bEdge, wk.aEdge, wk.by, wk.ay, wk.cross, CASTLE.stairWidth, { lanterns: true });
    // landing posts with lanterns at both ends
  }

  /* 5 ─ upright compounds */
  for (const dk of decks.values()) {
    const f = new Frame(sink, QI, [dk.x, dk.y, dk.z], dk.id);
    const fr = mulberry32(dk.id * 104729 + seed * 13);
    const avoid = dk.isAnchor ? [wrapSigned(A[0] - dk.x, P[0]), wrapSigned(A[2] - dk.z, P[2])] : null;
    compound(f, fr, { w: dk.w, d: dk.d, gaps: dk.gaps, avoid, upright: true, allowBalcony: !dk.isAnchor });
  }

  /* 6 ─ Escher-rotated compounds */
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const id = idx(i, j, k);
        if (type[id] !== 2) continue;
        const fr = mulberry32(id * 15485863 + seed * 7);
        const w = 8 + fr() * 10, d = 8 + fr() * 10;
        const yaw = qAxis(0, 1, 0, (Math.floor(fr() * 4) * Math.PI) / 2);
        const q = qMul(ORIENTATIONS[orient[id]], yaw);
        const t = [i * cx + cx / 2 + (fr() - 0.5) * 8, j * cy + cy / 2 + (fr() - 0.5) * 6, k * cz + cz / 2 + (fr() - 0.5) * 8];
        compound(new Frame(sink, q, t, id), fr, { w, d, upright: false, allowBalcony: true });
      }

  /* 7 ─ beams & stair flights crossing the void at impossible angles */
  const dr = mulberry32(seed * 31 + 5);
  for (let n = 0; n < CASTLE.decorBeams; n++) {
    const c = [dr() * P[0], dr() * P[1], dr() * P[2]];
    // directions biased toward 30–60° tilts so they read as "wrong"
    const yawA = dr() * Math.PI * 2;
    const tilt = (0.35 + dr() * 0.55) * (dr() < 0.5 ? 1 : -1);
    const q = qMul(qAxis(0, 1, 0, yawA), qAxis(1, 0, 0, tilt));
    const len = 22 + dr() * 60;
    const dir = qRotate(q, 0, 0, 1);
    let ok = true;
    for (let s = -len / 2; s <= len / 2 && ok; s += 2.5) {
      if (clear.blocked(c[0] + dir[0] * s, c[1] + dir[1] * s, c[2] + dir[2] * s, 1.6, 1.6, 1.6, -9, false)) ok = false;
    }
    if (!ok) continue;
    const f = new Frame(sink, q, c, -9);
    const decor = { aabbExact: false, skipClear: true };
    if (dr() < 0.62) {
      f.wood(KIND.beam, 0, 0, 0, 0.9, 0.9, len, dr, decor);
      if (dr() < 0.5) f.wood(KIND.beam, 0, 1.4, 0, 0.5, 0.5, len * 0.9, dr, decor);
    } else {
      // a stair flight in the tilted frame: steps keep their own "gravity"
      const steps = Math.floor(len / 0.5);
      for (let s = 0; s < steps; s++) {
        f.wood(KIND.step, 0, s * 0.3 - steps * 0.15, -len / 2 + s * 0.5, 2.2, 0.62, 0.52, dr, decor);
      }
      for (const sd of [-1, 1]) f.wood(KIND.beam, sd * 1.15, -0.3, 0, 0.2, 0.5, Math.hypot(len, steps * 0.3), dr, decor, qAxis(1, 0, 0, -Math.atan2(steps * 0.3, len)));
      if (dr() < 0.6) f.part(CAT.lantern, 1.3, 1.2, 0, 0.42, 0.62, 0.42, [dr(), 1.1, 0, 0], decor);
    }
  }

  const out = pack(sink, P, A);
  out.stats = stats;
  return out;
}

/** Packs part lists into typed arrays ready for instancing / collision. */
function pack(sink, period, anchor) {
  const cats = sink.parts.map((list) => {
    const n = list.length;
    const pos = new Float32Array(n * 3), quat = new Float32Array(n * 4), scl = new Float32Array(n * 3), info = new Float32Array(n * 4);
    list.forEach((p, i) => {
      pos.set(p.c, i * 3);
      quat.set(p.q, i * 4);
      scl.set(p.s, i * 3);
      info.set(p.info, i * 4);
    });
    return { count: n, pos, quat, scl, info };
  });
  const nc = sink.colliders.length;
  const colliders = new Float32Array(nc * 6);
  sink.colliders.forEach((c, i) => colliders.set(c, i * 6));
  const lamps = new Float32Array(sink.lamps.length * 3);
  sink.lamps.forEach((l, i) => lamps.set(l, i * 3));
  return { period, wood: cats[0], house: cats[1], lantern: cats[2], colliders, colliderCount: nc, lamps, lampCount: sink.lamps.length, anchor };
}
