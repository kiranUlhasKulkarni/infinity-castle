import { BoxGeometry, CylinderGeometry, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, Vector3 } from 'three';
import { createLanternMaterial, createShojiMaterial, createWoodMaterial } from './castle/shaders.js';
import { KIND } from './castle/layout.js';

const ROOM = 7; // half size of the room (m)
const HOLE = 3; // half size of the trapdoor (m)
const HEIGHT = 3.6;
const TRAP_SECONDS = 0.34;

/**
 * Phase 1 of the opening: a tatami room in the Ubuyashiki mansion — shoji
 * walls, a coffered ceiling, paper andon lamps — and Tanjiro standing on the
 * two floor panels in the middle.
 *
 * When the Biwa sounds, those two panels drop a hand's breadth and slide apart
 * under the surrounding floor (a sliding-door trapdoor), and he plunges through
 * the gap into the glowing castle below.
 *
 * Everything reuses the castle's own wood / shoji / lantern shaders (tiny
 * InstancedMeshes; the floor uses the wood shader's tatami pattern), so the
 * room and the castle share one look. Collision is a handful of boxes handed
 * to the same Collision system (see roomLayout).
 */
export class Estate {
  constructor(scene) {
    this.group = new Group();
    this.group.name = 'ubuyashiki-room';
    scene.add(this.group);

    const parts = { wood: [], house: [], lantern: [] };
    this.colliders = [];
    const add = (cat, x, y, z, sx, sy, sz, info, collide = false) => {
      parts[cat].push({ p: [x, y, z], s: [sx, sy, sz], info });
      if (collide) this.colliders.push([x, y, z, sx / 2, sy / 2, sz / 2]);
      return parts[cat].length - 1;
    };
    const W = (kind, x, y, z, sx, sy, sz, collide = false) => add('wood', x, y, z, sx, sy, sz, [kind, Math.random(), 1, 0], collide);
    const R = ROOM, H = HOLE;

    // floor: a ring of tatami around the two trapdoor panels
    W(KIND.tatami, 0, -0.15, (R + H) / 2, 2 * R, 0.3, R - H, true);
    W(KIND.tatami, 0, -0.15, -(R + H) / 2, 2 * R, 0.3, R - H, true);
    W(KIND.tatami, (R + H) / 2, -0.15, 0, R - H, 0.3, 2 * H, true);
    W(KIND.tatami, -(R + H) / 2, -0.15, 0, R - H, 0.3, 2 * H, true);
    this.trap = [
      W(KIND.tatami, -H / 2, -0.15, 0, H, 0.3, 2 * H, true),
      W(KIND.tatami, H / 2, -0.15, 0, H, 0.3, 2 * H, true),
    ];
    // shoji walls (lit from the garden), pillars, the nageshi beam, ceiling
    add('house', 0, HEIGHT / 2, R + 0.15, 2 * R + 0.6, HEIGHT, 0.3, [3.1, 0.6, 1, 0], true);
    add('house', 0, HEIGHT / 2, -R - 0.15, 2 * R + 0.6, HEIGHT, 0.3, [5.7, 0.6, 1, 0], true);
    add('house', R + 0.15, HEIGHT / 2, 0, 0.3, HEIGHT, 2 * R, [8.3, 0.6, 1, 0], true);
    add('house', -R - 0.15, HEIGHT / 2, 0, 0.3, HEIGHT, 2 * R, [9.9, 0.6, 1, 0], true);
    for (const x of [-R, 0, R]) for (const z of [-R, 0, R]) if (x || z) W(KIND.beam, x, HEIGHT / 2, z, 0.26, HEIGHT, 0.26);
    for (const s of [-1, 1]) {
      W(KIND.beam, 0, 2.75, s * (R - 0.05), 2 * R, 0.2, 0.16);
      W(KIND.beam, s * (R - 0.05), 2.75, 0, 0.16, 0.2, 2 * R);
    }
    W(KIND.floor, 0, HEIGHT + 0.15, 0, 2 * R + 0.6, 0.3, 2 * R + 0.6, true);
    for (let i = -3; i <= 3; i++) {
      W(KIND.beam, i * 2, HEIGHT - 0.06, 0, 0.14, 0.14, 2 * R);
      W(KIND.beam, 0, HEIGHT - 0.06, i * 2, 2 * R, 0.14, 0.14);
    }
    // paper andon lamps in the corners
    for (const x of [-1, 1]) for (const z of [-1, 1]) add('lantern', x * (R - 1.1), 0.42, z * (R - 1.1), 0.46, 0.84, 0.46, [Math.random(), 0.6, 0, 0]);
    this.lamps = parts.lantern.map((l) => new Vector3(l.p[0], l.p[1] + 0.2, l.p[2]));

    const mats = { wood: createWoodMaterial(), house: createShojiMaterial(), lantern: createLanternMaterial() };
    // own cull radius: the castle's is used to hide the castle during this phase
    for (const m of Object.values(mats)) m.uniforms = { ...m.uniforms, uCull: { value: 200 } };
    const geos = { wood: new BoxGeometry(1, 1, 1), house: new BoxGeometry(1, 1, 1), lantern: new CylinderGeometry(0.5, 0.5, 1, 10, 1) };
    this.meshes = {};
    this.parts = parts;
    this._m = new Matrix4();
    this._q = new Quaternion();
    for (const cat of Object.keys(parts)) {
      const list = parts[cat];
      const mesh = new InstancedMesh(geos[cat], mats[cat], list.length);
      if (cat === 'wood') mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      const info = new Float32Array(list.length * 4);
      list.forEach((it, i) => {
        this._m.compose(new Vector3(...it.p), this._q, new Vector3(...it.s));
        mesh.setMatrixAt(i, this._m);
        info.set(it.info, i * 4);
      });
      mesh.geometry.setAttribute('aInfo', new InstancedBufferAttribute(info, 4));
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.meshes[cat] = mesh;
    }
    this.trapT = -1;
  }

  /** The two floor panels drop a little and slide apart under the surrounding floor. */
  openTrapdoor() {
    this.trapT = 0;
  }

  update(dt) {
    if (this.trapT < 0 || this.trapT > TRAP_SECONDS + 0.1) return;
    this.trapT += dt;
    const k = Math.min(1, this.trapT / TRAP_SECONDS);
    const drop = Math.min(1, k / 0.18); // first: sink below the surrounding floor
    const slide = Math.max(0, (k - 0.12) / 0.88);
    const e = slide * slide * (3 - 2 * slide); // fast, then a hard stop in the slot
    const mesh = this.meshes.wood;
    this.trap.forEach((idx, n) => {
      const it = this.parts.wood[idx];
      const sgn = n === 0 ? -1 : 1;
      const x = it.p[0] + sgn * (HOLE + 0.35) * e;
      const y = it.p[1] - 0.36 * drop;
      this._m.compose(new Vector3(x, y, it.p[2]), this._q, new Vector3(...it.s));
      mesh.setMatrixAt(idx, this._m);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }

  set visible(v) {
    this.group.visible = v;
  }
  get visible() {
    return this.group.visible;
  }
}

/** Collision "layout" for the room: floor ring, trapdoor panels, walls, ceiling. */
export function roomLayout(period, estate) {
  const c = new Float32Array(estate.colliders.length * 6);
  estate.colliders.forEach((b, i) => c.set(b, i * 6));
  return { period, colliders: c, colliderCount: estate.colliders.length };
}

/** Volume the castle generator must keep empty so nothing pokes into the room. */
export const ROOM_RESERVE = [0, 1.4, 0, ROOM + 1.2, HEIGHT / 2 + 2.6, ROOM + 1.2];
