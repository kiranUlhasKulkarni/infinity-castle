import { BoxGeometry, CylinderGeometry, DynamicDrawUsage, InstancedBufferAttribute, InstancedMesh, Vector3 } from 'three';
import { BIWA, CASTLE } from '../config.js';
import { easeInOutCubic, mulberry32, wrapSigned } from '../utils/math.js';
import { castleUniforms, createLanternMaterial, createShojiMaterial, createWoodMaterial, MAX_LAMPS } from './shaders.js';

const CATS = ['wood', 'house', 'lantern'];
const LAMP_GRID = 16;

/** Writes a TRS matrix (column-major) into `out` at offset o. */
function compose(out, o, px, py, pz, qx, qy, qz, qw, sx, sy, sz) {
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;
  out[o] = (1 - (yy + zz)) * sx; out[o + 1] = (xy + wz) * sx; out[o + 2] = (xz - wy) * sx; out[o + 3] = 0;
  out[o + 4] = (xy - wz) * sy; out[o + 5] = (1 - (xx + zz)) * sy; out[o + 6] = (yz + wx) * sy; out[o + 7] = 0;
  out[o + 8] = (xz + wy) * sz; out[o + 9] = (yz - wx) * sz; out[o + 10] = (1 - (xx + yy)) * sz; out[o + 11] = 0;
  out[o + 12] = px; out[o + 13] = py; out[o + 14] = pz; out[o + 15] = 1;
}

/** Spatial key so the morph pairs nearby old blocks with nearby new ones (coherent slides, not a swarm). */
function spatialKey(x, y, z) {
  const ix = Math.floor(x / 12) & 63, iy = Math.floor(y / 12) & 63, iz = Math.floor(z / 12) & 63;
  return (iy << 12) | (ix << 6) | iz;
}
const _out = new Float64Array(3);
const KEYS = 1 << 18;
const _counts = new Int32Array(KEYS + 1);
/** Indices 0..n-1 ordered by spatial key — an O(n) counting sort (90k blocks in ~2 ms, vs ~35 ms for Array.sort). */
function spatialOrder(pos, n, P, keys = new Int32Array(n), order = new Int32Array(n)) {
  _counts.fill(0);
  for (let i = 0; i < n; i++) {
    const o = i * 3;
    const k = spatialKey(((pos[o] % P[0]) + P[0]) % P[0], ((pos[o + 1] % P[1]) + P[1]) % P[1], ((pos[o + 2] % P[2]) + P[2]) % P[2]);
    keys[i] = k;
    _counts[k + 1]++;
  }
  for (let k = 0; k < KEYS; k++) _counts[k + 1] += _counts[k];
  for (let i = 0; i < n; i++) order[_counts[keys[i]]++] = i;
  return order;
}

/**
 * The castle's three InstancedMeshes (wood, shoji houses, lanterns): one draw
 * call each for ~60k instances. Handles uploading a layout, the trapdoor
 * under Tanjiro, and the violent rearrangement between two layouts.
 */
export class CastleMeshes {
  constructor(scene, layout) {
    this.period = layout.period;
    castleUniforms.uPeriod.value.set(...layout.period);
    const geos = {
      wood: new BoxGeometry(1, 1, 1),
      house: new BoxGeometry(1, 1, 1),
      lantern: new CylinderGeometry(0.5, 0.5, 1, 10, 1),
    };
    const mats = { wood: createWoodMaterial(), house: createShojiMaterial(), lantern: createLanternMaterial() };
    this.cats = {};
    for (const name of CATS) {
      const cap = Math.ceil(layout[name].count * 1.3) + 256;
      const mesh = new InstancedMesh(geos[name], mats[name], cap);
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      const info = new InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      info.setUsage(DynamicDrawUsage);
      mesh.geometry.setAttribute('aInfo', info);
      mesh.frustumCulled = false; // wrapped + culled in the vertex shader instead
      mesh.matrixAutoUpdate = false;
      mesh.name = `castle-${name}`;
      scene.add(mesh);
      this.cats[name] = {
        mesh,
        info,
        cap,
        count: 0,
        pos: new Float32Array(cap * 3),
        quat: new Float32Array(cap * 4),
        scl: new Float32Array(cap * 3),
        inf: new Float32Array(cap * 4),
      };
    }
    this.morph = null;
    this.trap = null;
    this.setLayout(layout);
  }

  /** Upload a layout instantly. */
  setLayout(layout) {
    this.layout = layout;
    for (const name of CATS) {
      const c = this.cats[name];
      const src = layout[name];
      const n = Math.min(src.count, c.cap);
      c.pos.fill(0); c.quat.fill(0); c.scl.fill(0); c.inf.fill(0);
      c.pos.set(src.pos.subarray(0, n * 3));
      c.quat.set(src.quat.subarray(0, n * 4));
      c.scl.set(src.scl.subarray(0, n * 3));
      c.inf.set(src.info.subarray(0, n * 4));
      for (let i = n; i < c.cap; i++) c.quat[i * 4 + 3] = 1;
      c.count = n;
      this.writeAll(c);
    }
    this.buildLampGrid(layout);
  }

  writeAll(c) {
    const m = c.mesh.instanceMatrix.array;
    for (let i = 0; i < c.cap; i++) {
      const p = i * 3, q = i * 4;
      compose(m, i * 16, c.pos[p], c.pos[p + 1], c.pos[p + 2], c.quat[q], c.quat[q + 1], c.quat[q + 2], c.quat[q + 3], c.scl[p], c.scl[p + 1], c.scl[p + 2]);
    }
    c.info.array.set(c.inf);
    c.info.needsUpdate = true;
    c.mesh.instanceMatrix.needsUpdate = true;
    c.mesh.count = c.cap;
  }

  /* ───────────── lantern lights ───────────── */

  buildLampGrid(layout) {
    const P = layout.period;
    this.lampN = P.map((p) => Math.ceil(p / LAMP_GRID));
    const grid = new Map();
    for (let i = 0; i < layout.lampCount; i++) {
      const x = layout.lamps[i * 3], y = layout.lamps[i * 3 + 1], z = layout.lamps[i * 3 + 2];
      const key = this.lampKey(Math.floor(x / LAMP_GRID), Math.floor(y / LAMP_GRID), Math.floor(z / LAMP_GRID));
      let l = grid.get(key);
      if (!l) grid.set(key, (l = []));
      l.push(i);
    }
    this.lampGrid = grid;
    this.lamps = layout.lamps;
    this.nearLamps = [];
  }
  lampKey(i, j, k) {
    const [nx, ny, nz] = this.lampN;
    return (((i % nx) + nx) % nx) + nx * ((((j % ny) + ny) % ny) + ny * (((k % nz) + nz) % nz));
  }

  /** Feeds the 8 lanterns nearest `p` to the shaders; returns them (nearest first) for real lights. */
  updateLamps(p) {
    const [Px, Py, Pz] = this.period;
    const ci = Math.floor(p.x / LAMP_GRID), cj = Math.floor(p.y / LAMP_GRID), ck = Math.floor(p.z / LAMP_GRID);
    const found = this.nearLamps;
    found.length = 0;
    for (let i = ci - 1; i <= ci + 1; i++)
      for (let j = cj - 1; j <= cj + 1; j++)
        for (let k = ck - 1; k <= ck + 1; k++) {
          const list = this.lampGrid.get(this.lampKey(i, j, k));
          if (!list) continue;
          for (const id of list) {
            const x = this.lamps[id * 3], y = this.lamps[id * 3 + 1], z = this.lamps[id * 3 + 2];
            const wx = p.x + wrapSigned(x - p.x, Px), wy = p.y + wrapSigned(y - p.y, Py), wz = p.z + wrapSigned(z - p.z, Pz);
            const d2 = (wx - p.x) ** 2 + (wy - p.y) ** 2 + (wz - p.z) ** 2;
            found.push({ x: wx, y: wy, z: wz, d2, id });
          }
        }
    found.sort((a, b) => a.d2 - b.d2);
    const pos = castleUniforms.uLampPos.value, col = castleUniforms.uLampCol.value;
    for (let i = 0; i < MAX_LAMPS; i++) {
      const l = found[i];
      if (l) {
        pos[i].set(l.x, l.y, l.z);
        const flick = 0.9 + 0.1 * Math.sin(castleUniforms.uTime.value * (3 + (l.id % 7)) + l.id);
        col[i].set(1.0, 0.42, 0.14).multiplyScalar(2.0 * flick);
      } else {
        pos[i].set(0, -1e5, 0);
        col[i].set(0, 0, 0);
      }
    }
    return found;
  }

  /* ───────────── Biwa: trapdoor + rearrangement ───────────── */

  /**
   * The trapdoor. Finds the exact floor instance(s) directly beneath `p` (the
   * slab he's standing on — a 30 m deck, a tatami floor, a bridge) and cuts a
   * hole in it: the slab is swapped for up to four rim pieces around a square
   * opening, and the opening itself is two panels that slide apart under the
   * rim. Anything small under him (a stair step) simply slides out of the way.
   * Purely visual: collision is stripped by the Biwa sequence at the same moment.
   */
  openTrapdoor(p) {
    const HOLE = 4.4; // wide enough for both of them
    const [Px, Py, Pz] = this.period;
    const slide = []; // fallback: small pieces slide away
    const panels = [];
    let spare = 0; // temp slots are taken from the top of each mesh's spare capacity
    const take = (c) => {
      const slot = c.cap - 1 - spare++;
      return slot > c.count ? slot : -1;
    };
    const put = (c, slot, x, y, z, sx, sy, sz, info) => {
      c.pos.set([x, y, z], slot * 3);
      c.quat.set([0, 0, 0, 1], slot * 4);
      c.scl.set([sx, sy, sz], slot * 3);
      c.inf.set(info, slot * 4);
      c.info.array.set(info, slot * 4);
      this.writeOne(c, slot);
    };
    const c = this.cats.wood;
    for (let i = 0; i < c.count; i++) {
      const o = i * 3, q = i * 4;
      const dx = wrapSigned(c.pos[o] - p.x, Px), dy = wrapSigned(c.pos[o + 1] - p.y, Py), dz = wrapSigned(c.pos[o + 2] - p.z, Pz);
      if (Math.abs(dx) > 40 || Math.abs(dz) > 40 || Math.abs(dy) > 3) continue;
      if (Math.abs(c.quat[q + 3]) < 0.999) continue; // only upright pieces carry him
      const hx = c.scl[o] / 2, hy = c.scl[o + 1] / 2, hz = c.scl[o + 2] / 2;
      if (Math.abs(dx) > hx + 0.4 || Math.abs(dz) > hz + 0.4) continue; // not under him
      const top = dy + hy;
      if (top < -0.9 || top > 0.3 || hy > 0.45) continue; // a floor slab right under his feet
      const x0 = p.x + dx - hx, x1 = p.x + dx + hx, z0 = p.z + dz - hz, z1 = p.z + dz + hz;
      const yc = p.y + dy;
      if (hx * 2 < HOLE + 0.8 || hz * 2 < HOLE + 0.8) {
        // too small to cut (a step, a narrow plank): slide it away
        const alongX = hx - Math.abs(dx) < hz - Math.abs(dz);
        const dist = (alongX ? hx : hz) * 2 + 2.5;
        const sg = (alongX ? dx : dz) >= 0 ? 1 : -1;
        slide.push({ c, i, ox: c.pos[o], oz: c.pos[o + 2], dx: alongX ? sg * dist : 0, dz: alongX ? 0 : sg * dist });
        continue;
      }
      // the opening, centred under him but kept inside the slab
      const hx0 = Math.min(Math.max(p.x - HOLE / 2, x0 + 0.4), x1 - 0.4 - HOLE), hx1 = hx0 + HOLE;
      const hz0 = Math.min(Math.max(p.z - HOLE / 2, z0 + 0.4), z1 - 0.4 - HOLE), hz1 = hz0 + HOLE;
      const info = Array.from(c.inf.subarray(q, q + 4));
      const H = hy * 2;
      const rims = [
        [x0, hx0, z0, z1],
        [hx1, x1, z0, z1],
        [hx0, hx1, z0, hz0],
        [hx0, hx1, hz1, z1],
      ];
      const slots = [];
      for (const [a0, a1, b0, b1] of rims) {
        if (a1 - a0 < 0.05 || b1 - b0 < 0.05) continue;
        const slot = take(c);
        if (slot < 0) break;
        put(c, slot, (a0 + a1) / 2, yc, (b0 + b1) / 2, a1 - a0, H, b1 - b0, info);
        slots.push(slot);
      }
      if (slots.length < 2) continue; // no spare capacity: leave it
      // the cut slab itself disappears (the morph grows its replacement from nothing)
      c.scl.fill(0, o, o + 3);
      this.writeOne(c, i);
      // two panels that slide apart under the rim (along the slab's longer side)
      const alongX = hx >= hz;
      for (const sg of [-1, 1]) {
        const slot = take(c);
        if (slot < 0) break;
        const px = alongX ? (hx0 + hx1) / 2 + (sg * HOLE) / 4 : (hx0 + hx1) / 2;
        const pz = alongX ? (hz0 + hz1) / 2 : (hz0 + hz1) / 2 + (sg * HOLE) / 4;
        const sx = alongX ? HOLE / 2 : HOLE, sz = alongX ? HOLE : HOLE / 2;
        put(c, slot, px, yc, pz, sx, H * 0.9, sz, info);
        panels.push({ c, slot, ox: px, oy: yc, oz: pz, dx: alongX ? sg * (HOLE / 2 + 0.05) : 0, dz: alongX ? 0 : sg * (HOLE / 2 + 0.05), sink: H + 0.02 });
      }
    }
    c.mesh.instanceMatrix.needsUpdate = true;
    c.info.needsUpdate = true;
    this.trap = { slide, panels, t: 0 };
  }

  /**
   * Begin rearranging into `next`. Each block slides (one axis at a time,
   * like the castle's sliding rooms) to a block of the new layout, the wave
   * spreading outward from Tanjiro.
   */
  startMorph(next, p, seed, span = BIWA.morphSeconds) {
    for (const _ of this.planMorph(next, p, seed, span)); // eslint-disable-line no-empty
  }

  /**
   * The same plan, built in slices (a generator: each next() does a few
   * thousand blocks) so it can be spread over frames during the fall instead
   * of stalling one. The morph starts when the generator finishes.
   */
  *planMorph(next, p, seed, span = BIWA.morphSeconds) {
    const rnd = mulberry32(seed);
    const [Px, Py, Pz] = this.period;
    const plan = {};
    for (const name of CATS) {
      const c = this.cats[name];
      const src = next[name];
      const oldN = c.count;
      const newN = Math.min(src.count, c.cap);
      // pooled buffers (allocated once at capacity): no garbage, no GC pause mid-fall
      const B = (this.pool ??= {})[name] ??= {
        keys: new Int32Array(c.cap), oldOrder: new Int32Array(c.cap), newOrder: new Int32Array(c.cap),
        from: { pos: new Float32Array(c.cap * 3), quat: new Float32Array(c.cap * 4), scl: new Float32Array(c.cap * 3) },
        to: { pos: new Float32Array(c.cap * 3), quat: new Float32Array(c.cap * 4), scl: new Float32Array(c.cap * 3), inf: new Float32Array(c.cap * 4) },
        start: new Float32Array(c.cap), dur: new Float32Array(c.cap), order: new Uint8Array(c.cap),
        begun: new Uint8Array(c.cap), done: new Uint8Array(c.cap), active: new Int32Array(c.cap),
      };
      const oldOrder = spatialOrder(c.pos, oldN, this.period, B.keys, B.oldOrder);
      yield;
      const newOrder = spatialOrder(src.pos, newN, this.period, B.keys, B.newOrder);
      yield;

      const total = Math.max(oldN, newN);
      const from = B.from, to = B.to;
      from.pos.set(c.pos.subarray(0, total * 3));
      from.quat.set(c.quat.subarray(0, total * 4));
      from.scl.set(c.scl.subarray(0, total * 3));
      const SP = src.pos, SQ = src.quat, SS = src.scl, SI = src.info;
      const FP = from.pos, FQ = from.quat, FS = from.scl, TP = to.pos, TQ = to.quat, TS = to.scl, TI = to.inf, CI = c.inf;
      let free = oldN;
      for (let r = 0; r < total; r++) {
        if ((r & 16383) === 16383) yield;
        const slot = r < oldN ? oldOrder[r] : free++;
        const o3 = slot * 3, o4 = slot * 4;
        if (r < newN) {
          const s3 = newOrder[r] * 3, s4 = newOrder[r] * 4;
          TP[o3] = SP[s3]; TP[o3 + 1] = SP[s3 + 1]; TP[o3 + 2] = SP[s3 + 2];
          TS[o3] = SS[s3]; TS[o3 + 1] = SS[s3 + 1]; TS[o3 + 2] = SS[s3 + 2];
          TQ[o4] = SQ[s4]; TQ[o4 + 1] = SQ[s4 + 1]; TQ[o4 + 2] = SQ[s4 + 2]; TQ[o4 + 3] = SQ[s4 + 3];
          TI[o4] = SI[s4]; TI[o4 + 1] = SI[s4 + 1]; TI[o4 + 2] = SI[s4 + 2]; TI[o4 + 3] = SI[s4 + 3];
          if (r >= oldN) {
            // new block: grows in place
            FP[o3] = TP[o3]; FP[o3 + 1] = TP[o3 + 1]; FP[o3 + 2] = TP[o3 + 2];
            FQ[o4] = TQ[o4]; FQ[o4 + 1] = TQ[o4 + 1]; FQ[o4 + 2] = TQ[o4 + 2]; FQ[o4 + 3] = TQ[o4 + 3];
            FS[o3] = FS[o3 + 1] = FS[o3 + 2] = 0;
          }
        } else {
          // surplus old block: shrinks away where it is
          TP[o3] = FP[o3]; TP[o3 + 1] = FP[o3 + 1]; TP[o3 + 2] = FP[o3 + 2];
          TS[o3] = TS[o3 + 1] = TS[o3 + 2] = 0; // (pooled buffer: clear explicitly)
          TQ[o4] = FQ[o4]; TQ[o4 + 1] = FQ[o4 + 1]; TQ[o4 + 2] = FQ[o4 + 2]; TQ[o4 + 3] = FQ[o4 + 3];
          TI[o4] = CI[o4]; TI[o4 + 1] = CI[o4 + 1]; TI[o4 + 2] = CI[o4 + 2]; TI[o4 + 3] = CI[o4 + 3];
        }
      }
      // timing per slot
      const { start, dur, order } = B;
      const active = B.active;
      let nActive = 0;
      // Only blocks that can be seen move (within the fog, measured from his whole
      // fall line, since he plunges ~180 m while it happens); the rest snap at the end.
      const reach = 100, reach2 = reach * reach; // looking down the shaft, the horizon is fog
      const fallY = p.y - 90; // middle of the plunge
      const d2 = (x, y, z) => {
        const dx = wrapSigned(x - p.x, Px), dz = wrapSigned(z - p.z, Pz);
        const dy = Math.max(0, Math.abs(wrapSigned(y - fallY, Py)) - 90); // distance to the fall segment
        return dx * dx + dy * dy + dz * dz;
      };
      for (let s = 0; s < total; s++) {
        if ((s & 16383) === 16383) yield;
        const o = s * 3;
        const dd2 = Math.min(d2(FP[o], FP[o + 1], FP[o + 2]), d2(TP[o], TP[o + 1], TP[o + 2]));
        if (dd2 > reach2) continue; // never visible: snaps at the end
        const d = Math.sqrt(dd2);
        const dd = 0.4 + rnd() * 0.75;
        dur[s] = dd;
        start[s] = Math.min(span - dd, (d / reach) * span * 0.45 + rnd() * span * 0.35);
        order[s] = Math.floor(rnd() * 6);
        active[nActive++] = s;
      }
      B.begun.fill(0, 0, total);
      B.done.fill(0, 0, total);
      plan[name] = { from, to, total, start, dur, order, active: active.subarray(0, nActive), begun: B.begun, done: B.done, newN };
    }
    this.morph = { plan, t: 0, next, span };
  }

  /**
   * The castle manifests: every block near the fall (and the landing pad)
   * starts flung far out along one axis and slides into place, in staggered
   * waves across `span` seconds. The layout is already uploaded (setLayout at
   * load), so only the displaced start state is written here — no hitch.
   */
  assemble(p, anchor, seed, span) {
    const rnd = mulberry32(seed);
    const [Px, Py, Pz] = this.period;
    const plan = {};
    const reach = CASTLE.cullRadius + 20;
    for (const name of CATS) {
      const c = this.cats[name];
      const n = c.count;
      const off = new Float32Array(n * 3);
      const start = new Float32Array(n), dur = new Float32Array(n);
      const active = [];
      const arr = c.mesh.instanceMatrix.array;
      for (let s = 0; s < n; s++) {
        const o = s * 3, q = s * 4;
        const dxp = wrapSigned(c.pos[o] - p.x, Px), dyp = wrapSigned(c.pos[o + 1] - p.y, Py), dzp = wrapSigned(c.pos[o + 2] - p.z, Pz);
        const dxa = wrapSigned(c.pos[o] - anchor[0], Px), dya = wrapSigned(c.pos[o + 1] - anchor[1], Py), dza = wrapSigned(c.pos[o + 2] - anchor[2], Pz);
        // distance to the fall line between him and the pad
        const dLine = Math.min(Math.hypot(dxp, dzp), Math.hypot(dxa, dza));
        const inSpan = Math.min(Math.abs(dyp), Math.abs(dya), (dyp < 0 && dya > 0) ? 0 : 1e9);
        if (Math.hypot(dLine, inSpan) > reach) continue;
        // Blocks level with / above where he starts stay put (out of sight behind the
        // room's walls), and ~40% are already home so the castle is visibly waiting
        // below when the floor opens; the rest slide in around him during the fall.
        if (dyp > -7 || dLine > 46 || rnd() < 0.4) continue;
        const axis = Math.floor(rnd() * 3);
        const dist = (rnd() < 0.5 ? -1 : 1) * (35 + rnd() * 70);
        off[o + axis] = dist;
        const d = Math.hypot(dxa, dya, dza);
        const dd = 0.7 + rnd() * 0.9;
        dur[s] = dd;
        // the region around the pad settles first-ish so the catch is ready; the rest keeps sliding
        start[s] = Math.min(span - dd, (d < 30 ? rnd() * 0.45 : rnd() * 0.85) * (span - dd));
        active.push(s);
        compose(arr, s * 16, c.pos[o] + off[o], c.pos[o + 1] + off[o + 1], c.pos[o + 2] + off[o + 2], c.quat[q], c.quat[q + 1], c.quat[q + 2], c.quat[q + 3], 0, 0, 0);
      }
      c.mesh.instanceMatrix.needsUpdate = true;
      plan[name] = { mode: 'assemble', off, start, dur, active: Int32Array.from(active) };
    }
    this.morph = { plan, t: 0, next: null, span };
  }

  /**
   * Hiding is done in the vertex shader (every instance culled), not with
   * mesh.visible: a hidden mesh defers its ~5 MB instance upload to the frame
   * it reappears, which would hitch right at the Biwa strum.
   */
  set visible(v) {
    this._visible = v;
    castleUniforms.uCull.value = v ? CASTLE.cullRadius : -1e6;
  }
  get visible() {
    return this._visible ?? true;
  }

  /** Advance trapdoor + morph. Returns true on the frame the new layout is committed. */
  update(dt) {
    if (this.trap) {
      const tr = this.trap;
      tr.t += dt;
      const k = Math.min(1, tr.t / BIWA.trapdoorSeconds);
      const e = k * k * (3 - 2 * k);
      const touched = new Set();
      for (const it of tr.slide) {
        it.c.pos[it.i * 3] = it.ox + it.dx * e;
        it.c.pos[it.i * 3 + 2] = it.oz + it.dz * e;
        this.writeOne(it.c, it.i);
        touched.add(it.c);
      }
      // panels: drop a hair (under the rim), then snap apart
      const drop = Math.min(1, k * 2.5), open = Math.max(0, (k - 0.25) / 0.75);
      const eo = 1 - Math.pow(1 - open, 3);
      for (const it of tr.panels) {
        const o = it.slot * 3;
        it.c.pos[o] = it.ox + it.dx * eo;
        it.c.pos[o + 1] = it.oy - it.sink * drop;
        it.c.pos[o + 2] = it.oz + it.dz * eo;
        this.writeOne(it.c, it.slot);
        touched.add(it.c);
      }
      for (const c of touched) c.mesh.instanceMatrix.needsUpdate = true;
      if (k >= 1) this.trap = null;
    }
    if (!this.morph) return false;
    const m = this.morph;
    m.t += dt;
    const PER = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
    const [Px, Py, Pz] = this.period;
    const Pv = [Px, Py, Pz];
    for (const name of CATS) {
      const c = this.cats[name];
      const pl = m.plan[name];
      const arr = c.mesh.instanceMatrix.array;
      if (pl.mode === 'assemble') {
        for (let a = 0; a < pl.active.length; a++) {
          const s = pl.active[a];
          const local = (m.t - pl.start[s]) / pl.dur[s];
          if (local <= 0) continue;
          const t = Math.min(1, local);
          const e = 1 - Math.pow(1 - t, 4); // slam into place
          const k = 1 - e;
          const o = s * 3, q = s * 4;
          const g = Math.min(1, t * 3); // grows in fast, mostly slides
          compose(arr, s * 16, c.pos[o] + pl.off[o] * k, c.pos[o + 1] + pl.off[o + 1] * k, c.pos[o + 2] + pl.off[o + 2] * k, c.quat[q], c.quat[q + 1], c.quat[q + 2], c.quat[q + 3], c.scl[o] * g, c.scl[o + 1] * g, c.scl[o + 2] * g);
        }
        c.mesh.instanceMatrix.needsUpdate = true;
        continue;
      }
      const { from, to } = pl;
      let infoDirty = false, moved = false;
      for (let a = 0; a < pl.active.length; a++) {
        const s = pl.active[a];
        if (pl.done[s]) continue;
        const local = (m.t - pl.start[s]) / pl.dur[s];
        if (local <= 0) continue;
        if (!pl.begun[s]) {
          pl.begun[s] = 1;
          c.inf.set(to.inf.subarray(s * 4, s * 4 + 4), s * 4);
          c.info.array.set(to.inf.subarray(s * 4, s * 4 + 4), s * 4);
          infoDirty = true;
        }
        moved = true;
        const t = Math.min(1, local);
        if (t >= 1) pl.done[s] = 1; // home: written once more below, then left alone
        const o = s * 3, q = s * 4;
        // Manhattan slide: each axis in turn
        const ord = PER[pl.order[s]];
        const out = _out;
        for (let ax = 0; ax < 3; ax++) {
          const axis = ord[ax];
          const seg = Math.min(1, Math.max(0, t * 3 - ax));
          const delta = wrapSigned(to.pos[o + axis] - from.pos[o + axis], Pv[axis]);
          out[axis] = from.pos[o + axis] + delta * easeInOutCubic(seg);
        }
        const e = easeInOutCubic(t);
        // slerp (normalized lerp is enough for these 90° turns)
        let qx = from.quat[q], qy = from.quat[q + 1], qz = from.quat[q + 2], qw = from.quat[q + 3];
        let tx = to.quat[q], ty = to.quat[q + 1], tz = to.quat[q + 2], tw = to.quat[q + 3];
        if (qx * tx + qy * ty + qz * tz + qw * tw < 0) { tx = -tx; ty = -ty; tz = -tz; tw = -tw; }
        qx += (tx - qx) * e; qy += (ty - qy) * e; qz += (tz - qz) * e; qw += (tw - qw) * e;
        const ql = Math.hypot(qx, qy, qz, qw) || 1;
        const sx = from.scl[o] + (to.scl[o] - from.scl[o]) * e;
        const sy = from.scl[o + 1] + (to.scl[o + 1] - from.scl[o + 1]) * e;
        const sz = from.scl[o + 2] + (to.scl[o + 2] - from.scl[o + 2]) * e;
        c.pos[o] = out[0]; c.pos[o + 1] = out[1]; c.pos[o + 2] = out[2];
        compose(arr, s * 16, out[0], out[1], out[2], qx / ql, qy / ql, qz / ql, qw / ql, sx, sy, sz);
      }
      if (moved) c.mesh.instanceMatrix.needsUpdate = true;
      if (infoDirty) c.info.needsUpdate = true;
    }
    if (m.t >= m.span) {
      this.commit(m);
      return true;
    }
    return false;
  }

  writeOne(c, i) {
    const p = i * 3, q = i * 4;
    compose(c.mesh.instanceMatrix.array, i * 16, c.pos[p], c.pos[p + 1], c.pos[p + 2], c.quat[q], c.quat[q + 1], c.quat[q + 2], c.quat[q + 3], c.scl[p], c.scl[p + 1], c.scl[p + 2]);
  }

  commit(m) {
    this.morph = null;
    if (m.next) this.setLayout(m.next);
    // assembly: every animated block has already reached home on this frame; nothing to rewrite
  }

  get busy() {
    return !!this.morph;
  }
}

export const _v = new Vector3();
