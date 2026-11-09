import {
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DynamicDrawUsage,
  Group,
  InstancedMesh,
  LatheGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Quaternion,
  RepeatWrapping,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { POND } from '../config.js';
import { mulberry32 } from '../utils/math.js';
import { lotusGeometry } from './LotusPond.js';

const UP = new Vector3(0, 1, 0);
const GRAVITY = 12;
const LIFE = 3; // seconds an icicle lasts (flying + stuck) before it shatters
const SHATTER = 0.22;
const MOUTH = new Vector3(0, 0.55, 1.05); // head-local
const CONE_HALF = 0.65; // half the icicle's length (cone apex at +y)

/**
 * Renge Bodhisattva — Doma's ice Buddha, seated on a lotus throne at the back of
 * the Lotus Pond, and its Icicle Breath.
 *
 * Model: no GLTF, so the figure is procedural, built from smooth primitives
 * (a lathed torso, ellipsoid legs and head, capsule arms, a curled ushnisha,
 * long ear lobes, a flame-ringed mandorla) in a pivot hierarchy, so it can
 * lean and open its arms.
 *
 * Material is the point: MeshPhysicalMaterial with transmission 1.0, roughness
 * 0.1, ior 1.31 (ice), a thick body (thickness 4) and deep blue attenuation, so
 * light that passes through turns glacier-blue, plus a procedural frost normal
 * map so the refraction and highlights break up like real ice. On touch devices
 * — or when the frame rate sags even at the lowest resolution — it swaps to a
 * MeshStandardMaterial (metalness 0.9, roughness 0.1) that reads as polished
 * ice for a fraction of the cost.
 *
 * Every POND.attackSeconds (15 s) it leans forward, spreads its arms and
 * breathes a burst of icicles (one InstancedMesh of cones, same ice) radially
 * across the pond. They fly with gravity, stick into the bridge, the dais, the
 * engawa, the walls or the water (pond geometry is known, so collision is exact
 * and analytic), and shatter after 3 s. No damage: it's a spectacle. The whole
 * loop only runs while Tanjiro is near the hall.
 */
export class IceBuddha {
  constructor(ponds) {
    this.ponds = ponds;
    const normal = frostNormalMap();
    normal.repeat.set(3, 3);
    this.hi = new MeshPhysicalMaterial({
      color: new Color(0.3, 0.64, 0.92),
      transmission: 1.0,
      roughness: 0.1,
      ior: 1.31,
      thickness: 4.0,
      attenuationColor: new Color(0.06, 0.4, 0.78),
      attenuationDistance: 1.8,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.05,
      specularIntensity: 1,
      envMap: ponds.env,
      envMapIntensity: 1.2,
      normalMap: normal,
      normalScale: new Vector2(0.3, 0.3),
      emissive: new Color(0.01, 0.05, 0.11),
    });
    this.lo = new MeshStandardMaterial({
      color: new Color(0.2, 0.44, 0.7),
      metalness: 0.9,
      roughness: 0.1,
      envMap: ponds.env,
      envMapIntensity: 0.75, // polished-ice sheen without blooming out against the bright paper
      normalMap: normal,
      normalScale: new Vector2(0.3, 0.3),
      emissive: new Color(0.008, 0.035, 0.08),
    });
    this.baseEmissive = { hi: this.hi.emissive.clone(), lo: this.lo.emissive.clone() };
    this.mat = this.hi;

    const m = buildBuddha(this.hi);
    Object.assign(this, m); // root, torso, head, armL, armR, mandorla, meshes
    this.root.visible = false;

    // icicles
    const N = POND.icicles + 10;
    this.N = N;
    const cone = new ConeGeometry(0.11, CONE_HALF * 2, 7, 1);
    this.icicles = new InstancedMesh(cone, this.hi, N);
    this.icicles.instanceMatrix.setUsage(DynamicDrawUsage);
    this.icicles.frustumCulled = false;
    this.icicles.count = 0;
    this.meshes.push(this.icicles);
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.dir = new Float32Array(N * 3);
    this.age = new Float32Array(N);
    this.size = new Float32Array(N);
    this.state = new Uint8Array(N); // 0 free, 1 flying, 2 stuck
    this.alive = 0;
    this.rnd = mulberry32(4242);

    this.slot = null;
    this.pond = null;
    this.active = false;
    this.timer = POND.attackSeconds;
    this.pose = 0; // 0 rest … 1 leaning in, arms open
    this.poseTarget = 0;
    this.breathT = -1; // ≥ 0 while the breath is streaming
    this.spawned = 0;
    this.burstFx = { ripples: 0, hits: 0, lastHit: 0 };
    this._m = new Matrix4();
    this._q = new Quaternion();
    this._v = new Vector3();
    this._s = new Vector3();
    this._d = new Vector3();
  }

  /** Attach to the pond being drawn nearest the camera. */
  attach(slot) {
    this.slot = slot;
    this.pond = slot?.pond ?? null;
    this.clear();
    if (!slot || !this.pond) {
      this.root.removeFromParent();
      this.icicles.removeFromParent();
      this.root.visible = false;
      return;
    }
    const b = this.pond.buddha;
    slot.group.add(this.root, this.icicles);
    this.root.position.set(0, this.pond.surf, b.z);
    this.root.rotation.y = b.facing > 0 ? 0 : Math.PI; // the model faces +z
    this.root.scale.setScalar(b.scale);
    this.root.visible = true;
  }

  clear() {
    this.state.fill(0);
    this.alive = 0;
    this.icicles.count = 0;
    this.breathT = -1;
    this.timer = POND.attackSeconds;
  }

  setMaterial(mat) {
    if (mat === this.mat) return;
    this.mat = mat;
    for (const mesh of this.meshes) mesh.material = mat;
  }

  /**
   * controller: Tanjiro (position, camera shake); audio: breath + ice hits; ripple(x, z, s): water rings.
   */
  update(dt, camera, controller, audio, time) {
    const slot = this.ponds.nearestVisible(camera.position);
    if (slot !== this.slot || slot?.pond !== this.pond) this.attach(slot);
    if (!slot) return;
    const pd = this.pond;
    const c = slot.copy;
    const p = controller.pos;
    const near = Math.max(Math.abs(p.x - c.x), Math.abs(p.z - c.z)) < pd.size / 2 + 25 && Math.abs(p.y - c.y) < 22;
    // transmission only up close on desktop (ponds.low: touch device, or a struggling GPU)
    const camNear = camera.position.distanceTo(c) < pd.size / 2 + 28;
    this.setMaterial(!this.ponds.low && camNear ? this.hi : this.lo);
    this.mandorla.rotation.z += dt * 0.05;

    if (!near) {
      // the loop costs nothing when he's away: freeze the timer, settle the pose, drop the icicles
      if (this.active) this.clear();
      this.active = false;
      this.pose += (0 - this.pose) * Math.min(1, dt * 2);
      this.applyPose(time);
      return;
    }
    this.active = true;

    // ── the 15 s loop ──
    this.timer -= dt;
    if (this.breathT < 0) {
      this.poseTarget = this.timer < 1.7 ? 1 : 0; // anticipation: lean in, open up
      if (this.timer <= 0) {
        this.breathT = 0;
        this.spawned = 0;
        this.burstFx.ripples = this.burstFx.hits = 0;
        audio.iceBreath?.();
        const inside = this.ponds.inside(p) >= 0;
        if (inside) controller.fx.shake = Math.max(controller.fx.shake, 0.7);
      }
    }
    if (this.breathT >= 0) {
      this.breathT += dt;
      this.poseTarget = 1.18; // the push of the breath
      const want = Math.min(POND.icicles, Math.floor((this.breathT / 0.75) * POND.icicles));
      if (want > this.spawned) this.spawn(want - this.spawned);
      if (this.breathT > 0.95) {
        this.breathT = -1;
        this.timer = POND.attackSeconds;
      }
    }
    const rate = this.poseTarget > this.pose ? 3.2 : 1.4; // quick to lean in, slow to settle back
    this.pose += (this.poseTarget - this.pose) * Math.min(1, dt * rate);
    this.applyPose(time);
    // the ice glows from within as it gathers the breath
    const glow = 1 + 1.8 * Math.max(0, this.pose);
    this.hi.emissive.copy(this.baseEmissive.hi).multiplyScalar(glow);
    this.lo.emissive.copy(this.baseEmissive.lo).multiplyScalar(glow);

    if (this.alive) this.simulate(dt, controller, audio, time);
  }

  applyPose(time) {
    const k = this.pose;
    const breathe = Math.sin(time * 0.8) * 0.008;
    this.torso.rotation.x = 0.2 * k; // lean toward the pond
    this.torso.scale.set(1 + 0.03 * k, 1 + breathe + 0.02 * k, 1 + 0.03 * k);
    this.head.rotation.x = -0.16 * k; // chin up: the mouth opens onto the room
    this.armL.rotation.set(-0.35 * k, 0, 0.5 * k); // arms swing out and up
    this.armR.rotation.set(-0.35 * k, 0, -0.5 * k);
  }

  spawn(n) {
    const pd = this.pond;
    const rnd = this.rnd;
    // the mouth, in pond-local coordinates
    this.head.updateWorldMatrix(true, false);
    const o = this.head.localToWorld(this._v.copy(MOUTH));
    this.slot.group.worldToLocal(o);
    const f = pd.buddha.facing;
    for (let k = 0; k < n; k++) {
      let i = this.state.indexOf(0);
      if (i < 0) break;
      const yaw = (rnd() * 2 - 1) * 1.3; // a wide fan across the pond
      const pitch = -0.38 + rnd() * 0.62;
      const sp = 15 + rnd() * 17;
      const ch = Math.cos(pitch);
      const dx = Math.sin(yaw) * ch, dz = f * Math.cos(yaw) * ch, dy = Math.sin(pitch);
      const j = i * 3;
      this.pos[j] = o.x + dx * 0.4;
      this.pos[j + 1] = o.y + dy * 0.4;
      this.pos[j + 2] = o.z + dz * 0.4;
      this.vel[j] = dx * sp;
      this.vel[j + 1] = dy * sp;
      this.vel[j + 2] = dz * sp;
      this.age[i] = -rnd() * 0.04;
      this.size[i] = 0.6 + rnd() * 0.9;
      this.state[i] = 1;
      this.alive++;
      this.spawned++;
    }
  }

  /** Height of whatever solid is under (x, z) in the hall (pond-local): engawa, bridge, dais, or the water. */
  floorAt(x, z) {
    const pd = this.pond;
    const inner = pd.size / 2 - pd.engawa;
    if (Math.abs(x) > inner || Math.abs(z) > inner) return 0;
    if (Math.abs(x) < pd.dais / 2 && Math.abs(z) < pd.dais / 2) return pd.daisTop;
    if (Math.abs(z) < pd.bridge / 2) return pd.bridgeTop;
    return null; // open water
  }

  simulate(dt, controller, audio, time) {
    const pd = this.pond;
    const h = pd.size / 2 - 0.25, ceil = pd.height - 0.5;
    const m = this._m, q = this._q, s = this._s, d = this._d, v = this._v;
    const arr = this.icicles.instanceMatrix.array;
    const group = this.slot.group;
    let top = 0;
    for (let i = 0; i < this.N; i++) {
      const st = this.state[i];
      if (!st) {
        arr.fill(0, i * 16, i * 16 + 16); // scale 0
        continue;
      }
      top = i + 1;
      this.age[i] += dt;
      const j = i * 3;
      const sz = this.size[i];
      if (st === 1) {
        this.vel[j + 1] -= GRAVITY * dt;
        this.pos[j] += this.vel[j] * dt;
        this.pos[j + 1] += this.vel[j + 1] * dt;
        this.pos[j + 2] += this.vel[j + 2] * dt;
        d.set(this.vel[j], this.vel[j + 1], this.vel[j + 2]).normalize();
        this.dir[j] = d.x; this.dir[j + 1] = d.y; this.dir[j + 2] = d.z;
        // the tip
        const tx = this.pos[j] + d.x * CONE_HALF * sz, ty = this.pos[j + 1] + d.y * CONE_HALF * sz, tz = this.pos[j + 2] + d.z * CONE_HALF * sz;
        const fl = this.floorAt(tx, tz);
        const ground = fl ?? pd.surf;
        let hit = 0; // 1 wood, 2 water, 3 wall/ceiling
        let back = 0;
        if (ty <= ground && d.y < 0) {
          hit = fl === null ? 2 : 1;
          back = (ground - ty) / d.y; // slide back along the flight to the surface
        } else if (Math.abs(tx) > h || Math.abs(tz) > h || ty > ceil) hit = 3;
        if (hit) {
          const embed = (hit === 2 ? 0.5 : 0.28) * sz; // water swallows more of it
          this.pos[j] += d.x * (back - embed);
          this.pos[j + 1] += d.y * (back - embed);
          this.pos[j + 2] += d.z * (back - embed);
          this.state[i] = 2;
          this.impact(hit, tx + d.x * back, tz + d.z * back, controller, audio, time, group);
        }
        if (this.pos[j + 1] < pd.bed - 4) this.age[i] = LIFE + SHATTER; // lost
      }
      const age = this.age[i];
      if (age >= LIFE + SHATTER) {
        this.state[i] = 0;
        this.alive--;
        arr.fill(0, i * 16, i * 16 + 16);
        continue;
      }
      // shatter: a quick swell then gone
      const sh = age > LIFE ? (age - LIFE) / SHATTER : 0;
      const k = sh > 0 ? (1 - sh) * (1 + 0.6 * Math.sin(sh * Math.PI)) : Math.min(1, Math.max(0, age) * 12);
      d.set(this.dir[j], this.dir[j + 1], this.dir[j + 2]);
      q.setFromUnitVectors(UP, d);
      m.compose(v.set(this.pos[j], this.pos[j + 1], this.pos[j + 2]), q, s.set(sz * k * (1 + sh * 0.8), sz * Math.max(k, 0.001), sz * k * (1 + sh * 0.8)));
      m.toArray(arr, i * 16);
    }
    this.icicles.count = top;
    this.icicles.instanceMatrix.needsUpdate = true;
  }

  impact(kind, x, z, controller, audio, time, group) {
    const fx = this.burstFx;
    const w = group.localToWorld(this._s.set(x, 0, z));
    const dist = Math.hypot(w.x - controller.pos.x, w.z - controller.pos.z);
    if (kind === 2 && fx.ripples < 8 && dist < 24) {
      fx.ripples++;
      this.ponds.ripple(w.x, w.z, 0.55);
    }
    if (fx.hits < 12 && time - fx.lastHit > 0.035 && dist < 30) {
      fx.hits++;
      fx.lastHit = time;
      audio.iceHit?.(Math.max(0.15, 1 - dist / 30), kind);
    }
  }

  /** Compile both looks behind the loading screen. */
  warm(renderer, scene, camera) {
    const ahead = new Vector3(0, 0, -30).applyQuaternion(camera.quaternion).add(camera.position);
    scene.add(this.root);
    this.root.position.copy(ahead);
    this.root.visible = true;
    this.icicles.count = 1;
    scene.add(this.icicles);
    for (const mat of [this.hi, this.lo]) {
      this.setMaterial(mat);
      renderer.compile(scene, camera);
    }
    this.root.removeFromParent();
    this.icicles.removeFromParent();
    this.root.visible = false;
    this.icicles.count = 0;
    this.slot = null;
    this.pond = null;
  }
}

/* ───────────── the figure ───────────── */

/** A capsule from a to b (radius r). */
function limb(a, b, r) {
  const dir = new Vector3().subVectors(b, a);
  const len = dir.length();
  const g = new CapsuleGeometry(r, Math.max(0.01, len), 8, 18);
  g.applyQuaternion(new Quaternion().setFromUnitVectors(UP, dir.normalize()));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}
const ellipsoid = (rx, ry, rz, x, y, z, seg = 32) => new SphereGeometry(1, seg, Math.round(seg * 0.6)).scale(rx, ry, rz).translate(x, y, z);
const strip = (g) => {
  // merging needs identical attribute sets: keep only what every part shares
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
};
const merge = (parts) => {
  const g = mergeGeometries(parts.map(strip));
  parts.forEach((p) => p.dispose());
  return g;
};

/**
 * Seated Buddha, model space: faces +z, throne base at y = 0 (the water line),
 * ~8.9 m tall before POND.buddhaScale. Pivots: torso at the hips, head at the
 * neck, arms at the shoulders.
 */
function buildBuddha(mat) {
  const root = new Group();
  root.name = 'renge-bodhisattva';
  const meshes = [];
  const mesh = (geo, parent) => {
    const m = new Mesh(geo, mat);
    parent.add(m);
    meshes.push(m);
    return m;
  };

  // throne: drum, a ring of huge lotus petals, cushion; crossed legs
  const petals = lotusGeometry().scale(9.5, 9.5, 9.5).translate(0, 0.55, 0);
  mesh(
    merge([
      new CylinderGeometry(3.0, 3.3, 1.4, 48, 1).translate(0, 0.7, 0),
      petals,
      new CylinderGeometry(2.85, 3.05, 0.4, 48, 1).translate(0, 1.6, 0),
      ellipsoid(2.9, 0.9, 2.2, 0, 2.3, 0.35, 40),
      ellipsoid(0.55, 0.32, 0.9, 1.15, 2.85, 1.05, 16), // the soles, turned up on the knees
      ellipsoid(0.55, 0.32, 0.9, -1.15, 2.85, 1.05, 16),
    ]),
    root,
  );
  // mandorla: a great ring of flames behind the figure (turns slowly)
  const mandorla = new Group();
  mandorla.position.set(0, 6.2, -2.4);
  root.add(mandorla);
  const flames = [new TorusGeometry(5.0, 0.14, 10, 96), new TorusGeometry(4.55, 0.06, 8, 96)];
  for (let i = 0; i < 28; i++) {
    const a = (i / 28) * Math.PI * 2;
    const len = i % 2 ? 0.9 : 1.5;
    flames.push(new ConeGeometry(0.2, len, 6, 1).translate(0, 5.0 + len / 2, 0).rotateZ(a));
  }
  mesh(merge(flames).scale(1, 1.18, 1), mandorla);

  // torso (lathed, flattened front-to-back) with a breast line
  const torso = new Group();
  torso.position.set(0, 2.45, -0.15);
  root.add(torso);
  const prof = [[0.01, 0], [1.72, 0.05], [1.85, 0.5], [1.58, 1.3], [1.7, 2.2], [1.85, 2.9], [1.66, 3.5], [1.12, 3.85], [0.62, 4.05], [0.58, 4.35], [0.01, 4.42]].map(([r, y]) => new Vector2(r, y));
  mesh(
    merge([
      new LatheGeometry(prof, 56).scale(1, 1, 0.74),
      ellipsoid(0.78, 0.6, 0.42, 0.68, 2.72, 0.92, 24),
      ellipsoid(0.78, 0.6, 0.42, -0.68, 2.72, 0.92, 24),
      ellipsoid(1.5, 0.22, 1.05, 0, 1.15, 0.12, 32), // the robe's sash
    ]),
    torso,
  );

  // head: skull, curled ushnisha, long lobes, closed eyes, nose, lips, urna; a halo
  const head = new Group();
  head.position.set(0, 4.3, 0.05);
  torso.add(head);
  const hp = [
    ellipsoid(0.92, 1.12, 0.98, 0, 1.05, 0.05, 40),
    ellipsoid(0.52, 0.45, 0.52, 0, 2.15, -0.05, 24),
    ellipsoid(0.17, 0.64, 0.3, 0.93, 0.9, -0.02, 14),
    ellipsoid(0.17, 0.64, 0.3, -0.93, 0.9, -0.02, 14),
    ellipsoid(0.25, 0.06, 0.09, 0.35, 1.18, 0.9, 12),
    ellipsoid(0.25, 0.06, 0.09, -0.35, 1.18, 0.9, 12),
    ellipsoid(0.14, 0.25, 0.17, 0, 0.92, 1.0, 12),
    ellipsoid(0.27, 0.07, 0.1, 0, 0.56, 0.93, 12),
    ellipsoid(0.07, 0.07, 0.05, 0, 1.45, 0.98, 8),
  ];
  // snail-shell curls over the crown
  const cr = mulberry32(77);
  for (let i = 0; i < 70; i++) {
    const u = cr() * Math.PI * 2, vv = Math.acos(1 - cr() * 0.95);
    const nx = Math.sin(vv) * Math.cos(u), ny = Math.cos(vv), nz = Math.sin(vv) * Math.sin(u);
    if (nz > 0.55 && ny < 0.75) continue; // keep the forehead bare
    hp.push(ellipsoid(0.13, 0.11, 0.13, nx * 0.9, 1.05 + ny * 1.1, 0.05 + nz * 0.96, 8));
  }
  hp.push(new TorusGeometry(1.9, 0.07, 8, 72).translate(0, 1.1, -1.05));
  mesh(merge(hp), head);

  // arms: shoulder → elbow → hands resting in the lap (they part when it opens up)
  const arm = (side) => {
    const g = new Group();
    g.position.set(1.55 * side, 3.45, 0);
    torso.add(g);
    const sh = new Vector3(0, 0, 0), el = new Vector3(0.45 * side, -1.9, 0.3), hd = new Vector3(-1.2 * side, -2.9, 1.35);
    mesh(merge([ellipsoid(0.62, 0.55, 0.6, 0, 0, 0, 20), limb(sh, el, 0.44), limb(el, hd, 0.36), ellipsoid(0.55, 0.22, 0.42, hd.x, hd.y, hd.z, 16)]), g);
    return g;
  };
  const armL = arm(1), armR = arm(-1);
  return { root, torso, head, armL, armR, mandorla, meshes };
}

/** A tileable frost normal map: fractal value noise heights → normals. */
function frostNormalMap(size = 256) {
  const rnd = mulberry32(31337);
  const grid = (n) => Float32Array.from({ length: n * n }, () => rnd());
  const octaves = [[8, 0.5], [16, 0.28], [32, 0.15], [64, 0.07]].map(([n, a]) => ({ n, a, g: grid(n) }));
  const H = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let h = 0;
      for (const { n, a, g } of octaves) {
        const fx = (x / size) * n, fy = (y / size) * n;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const at = (i, j) => g[((j % n) + n) % n * n + (((i % n) + n) % n)];
        h += a * ((at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy);
      }
      H[y * size + x] = h;
    }
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => H[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * 6, dy = (at(x, y + 1) - at(x, y - 1)) * 6;
      const l = Math.hypot(dx, dy, 1);
      const o = (y * size + x) * 4;
      data[o] = Math.round((-dx / l * 0.5 + 0.5) * 255);
      data[o + 1] = Math.round((-dy / l * 0.5 + 0.5) * 255);
      data[o + 2] = Math.round((1 / l * 0.5 + 0.5) * 255);
      data[o + 3] = 255;
    }
  const tex = new DataTexture(data, size, size);
  tex.wrapS = tex.wrapT = RepeatWrapping;
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}
