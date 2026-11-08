import {
  AnimationMixer,
  Matrix4,
  BackSide,
  Box3,
  Color,
  DataTexture,
  Group,
  MathUtils,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  Quaternion,
  RedFormat,
  SkinnedMesh,
  SRGBColorSpace,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { styleModel } from './kanao/modelStyle.js';
import { addFaceTint } from './kanao/faceDetail.js';
import { applyExpression, findBone } from './kanao/expression.js';
import { damp } from '../utils/math.js';

const { clamp, lerp } = MathUtils;

/** Shared rim colour (warm glow of the shoji; flares red on the Biwa strum). */
export const rimUniform = { value: new Color(1.0, 0.45, 0.18) };

// Three-step light ramp — the same cel look as the fireworks project.
let ramp = null;
function toonRamp() {
  if (!ramp) {
    ramp = new DataTexture(new Uint8Array([80, 165, 255]), 3, 1, RedFormat);
    ramp.minFilter = ramp.magFilter = NearestFilter;
    ramp.generateMipmaps = false;
    ramp.needsUpdate = true;
  }
  return ramp;
}

/** Warm fresnel rim on any toon / standard material (chains existing patches). */
function addRim(mat) {
  if (mat.userData.rim || !(mat.isMeshToonMaterial || mat.isMeshStandardMaterial)) return;
  mat.userData.rim = true;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.call(mat, shader, renderer);
    shader.uniforms.uRim = rimUniform;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uRim;')
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        float rimF = pow(1.0 - clamp(dot(normalize(vViewPosition), normal), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += uRim * rimF * 0.9;`,
      );
  };
  const key = mat.customProgramCacheKey?.() ?? '';
  mat.customProgramCacheKey = () => `${key}|rim`;
  mat.needsUpdate = true;
}

/** Default look (Tanjiro): keep the file's textures, render them cel-shaded. */
function toonFrom(src) {
  const mat = new MeshToonMaterial({
    name: src.name,
    map: src.map ?? null,
    color: src.map ? new Color('#ffffff') : src.color?.clone() ?? new Color('#ffffff'),
    gradientMap: toonRamp(),
    transparent: src.transparent,
    alphaTest: src.alphaTest,
    side: src.side,
  });
  if (mat.map) mat.map.colorSpace = SRGBColorSpace;
  return mat;
}

/** Inverted-hull ink outline that follows the skin (thickness in world metres). */
function outlineMaterial(thickness) {
  const m = new MeshBasicMaterial({ color: '#0b0405', side: BackSide });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vec3 olN = normalize(normalMatrix * objectNormal);
      mvPosition.xyz += olN * ${thickness.toFixed(4)} * clamp(-mvPosition.z * 0.22, 0.7, 2.2);
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  return m;
}

const AX = new Vector3(1, 0, 0); // character-space lateral axis (his left)
const AY = new Vector3(0, 1, 0);
const AZ = new Vector3(0, 0, 1);
const _q = new Quaternion();
const _q2 = new Quaternion();
const _pq = new Quaternion();
const _rq = new Quaternion();
const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _ax = new Vector3();
const _az = new Vector3();

const KNEE_MAX = 2.35; // radians; knees only ever bend forward (min 0)

/**
 * Which way a face mesh looks: the average of its SKINNED vertex normals
 * (horizontal, world space). The back of the head is hair, so the face mesh's
 * normals point where the character looks. Returns null if it can't tell.
 */
function meshFacing(mesh) {
  const g = mesh.geometry;
  const N = g.attributes.normal, SI = g.attributes.skinIndex, SW = g.attributes.skinWeight;
  if (!N) return null;
  mesh.updateMatrixWorld(true);
  let mats = null;
  if (mesh.isSkinnedMesh && SI && SW) {
    const sk = mesh.skeleton;
    mats = sk.bones.map((b, i) => new Matrix4().multiplyMatrices(b.matrixWorld, sk.boneInverses[i]).multiply(mesh.bindMatrix));
  }
  const acc = new Vector3(), n = new Vector3(), t = new Vector3(), out = new Vector3();
  for (let i = 0; i < N.count; i += 2) {
    n.fromBufferAttribute(N, i);
    if (mats) {
      out.set(0, 0, 0);
      for (let k = 0; k < 4; k++) {
        const w = SW.getComponent(i, k);
        if (w) out.add(t.copy(n).transformDirection(mats[SI.getComponent(i, k)]).multiplyScalar(w));
      }
    } else out.copy(n).transformDirection(mesh.matrixWorld);
    acc.add(out.normalize());
  }
  acc.y = 0;
  return acc.lengthSq() > 1e-6 ? acc.normalize() : null;
}

/**
 * A procedurally animated biped built from a GLB and a profile (see profiles.js).
 *
 *  • Look: the profile's material rules (Kanao's painted look, ported from the
 *    fireworks project) or cel-shaded file textures + a generated ink outline
 *    (Tanjiro); a warm rim light on both.
 *  • Motion: the file's idle clip(s) when present; on top of that a procedural
 *    run, jump (anticipation crouch → mid-air tuck), landing shock absorber and
 *    freefall, all rotating bones about CHARACTER-space axes (converted to each
 *    bone's parent space at runtime), so it works on any biped rig.
 *  • Secondary motion: spring-damper chains for capes, skirts, sleeves and hair.
 *
 * Inputs each frame (update): { speed, grounded, vy, freefall, landed, windup }.
 */
export class Biped {
  constructor(scene, profile) {
    this.profile = profile;
    this.root = new Group(); // position = feet, rotation.y = heading (faces +Z)
    this.lean = new Group(); // body pitch / roll (freefall dive)
    this.bob = new Group(); // gait bob / crouch
    this.model = new Group(); // yaw fix + scale fit
    this.root.add(this.lean);
    this.lean.add(this.bob);
    this.bob.add(this.model);
    scene.add(this.root);
    this.ready = false;
    this.phase = 0;
    this.runW = 0;
    this.airW = 0;
    this.fallW = 0;
    this.crouchW = 0; // jump anticipation
    this.shock = 0; // landing shock absorber (spring)
    this.shockV = 0;
    this.shockHold = 0;
    this.shockTarget = 0;
    this.kissW = 0; // the 'K' lean-in
    this.onStep = null;
    this.time = Math.random() * 10;
  }

  async load(onProgress) {
    const P = this.profile;
    const gltf = await new GLTFLoader().loadAsync(P.url, (e) => {
      if (e.total) onProgress?.(e.loaded / e.total);
    });
    const scene = gltf.scene;
    scene.traverse((o) => {
      if (o.isCamera || o.isLight) o.visible = false;
      if (o.isMesh) {
        o.frustumCulled = false;
        o.castShadow = false;
        if (/Weapon|sword|sheath/i.test(o.name) || /Weapon|sword|sheath/i.test(o.material?.name ?? '')) o.userData.weapon = true;
      }
    });
    if (P.materials) {
      styleModel(scene, { materials: P.materials, castShadow: false }); // fireworks' painted look
    } else {
      const toons = new Map();
      scene.traverse((o) => {
        if (!o.isMesh) return;
        if (!toons.has(o.material)) toons.set(o.material, toonFrom(o.material));
        o.material = toons.get(o.material);
      });
    }
    if (P.hideWeapon) scene.traverse((o) => o.userData.weapon && (o.visible = false));
    const lineMats = new Set();
    scene.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material.isMeshBasicMaterial) lineMats.add(o.material); // ink shells
      else addRim(o.material);
    });
    if (P.outline) {
      const outline = outlineMaterial(P.outline);
      lineMats.add(outline);
      const skinned = [];
      scene.traverse((o) => o.isSkinnedMesh && o.visible && skinned.push(o));
      for (const m of skinned) {
        const ol = new SkinnedMesh(m.geometry, outline);
        ol.bind(m.skeleton, m.bindMatrix);
        ol.position.copy(m.position);
        ol.quaternion.copy(m.quaternion);
        ol.scale.copy(m.scale);
        ol.frustumCulled = false;
        m.parent.add(ol);
      }
    }
    // face: smile bones (model space, before scaling) + painted blush / mouth
    if (P.expression) applyExpression(scene, P.expression);

    // ── rig ──
    const bones = {};
    scene.traverse((o) => o.isBone && (bones[o.name] = o));
    const find = (src) => (src ? Object.values(bones).find((b) => new RegExp(src).test(b.name)) ?? null : null);
    this.b = Object.fromEntries(Object.entries(P.rig).map(([k, re]) => [k, find(re)]));
    this.procedural = ['pelvis', 'spine1', 'head', 'lThigh', 'lCalf', 'lFoot', 'rThigh', 'rCalf', 'rFoot', 'lUpper', 'lFore', 'rUpper', 'rFore'].every((k) => this.b[k]);
    if (!this.procedural) console.warn(`[biped] ${P.name}: rig incomplete, procedural motion off`, this.b);
    this.gaitBones = Object.values(this.b).filter(Boolean);

    // secondary motion chains
    this.cloth = (P.cloth ?? [])
      .map((c) => {
        const re = new RegExp(c.match);
        const list = Object.values(bones).filter((b) => re.test(b.name) && !/End|Twist|Spt|Lct/.test(b.name));
        const set = new Set(list);
        // Rotations compound down a chain, so weights ramp with depth and are
        // normalised per chain: the total bend is ~2.4 × the spring angle
        // whether the chain has 2 links (Tanjiro's hem) or 7 (Kanao's cape).
        const info = list.map((b) => {
          let depth = 0, root = b;
          for (let p = b.parent; p && set.has(p); p = p.parent) {
            depth++;
            root = p;
          }
          return { b, depth, root };
        });
        const chainLen = new Map();
        for (const it of info) chainLen.set(it.root, Math.max(chainLen.get(it.root) ?? 0, it.depth + 1));
        const items = info.map(({ b, depth, root }) => {
          const n = chainLen.get(root);
          return { bone: b, w: ((c.scale ?? 1) * 2.4 * (1 + depth)) / ((n * (n + 1)) / 2) };
        });
        return { ...c, items, c: 2 * c.zeta * Math.sqrt(c.k), p: 0, r: 0, vp: 0, vr: 0 };
      })
      .filter((g) => g.items.length);
    for (const g of this.cloth) for (const it of g.items) this.gaitBones.push(it.bone);
    for (const b of this.gaitBones) b.userData.bind = b.quaternion.clone();
    this.prevPos = new Vector3();
    this.prevVel = new Vector3();
    this.acc = new Vector3();
    this.hasPrev = false;

    this.model.add(scene);
    this.scene = scene;
    scene.updateMatrixWorld(true);

    // Facing: the model is turned so its FACE looks along +Z (the root's
    // forward; the controller points +Z along the velocity). Measured from the
    // face mesh's skinned normals — bone directions are unreliable (Tanjiro's
    // Toe0 bone sits behind his ankle, which once turned him around).
    // Fallback for rigs without a face mesh: heel → toe.
    let fwd = null;
    if (P.faceMesh) {
      scene.traverse((o) => {
        if (!fwd && o.isMesh && P.faceMesh.test(o.material?.name || o.name)) fwd = meshFacing(o);
      });
    }
    if (!fwd && this.b.lFoot && this.b.lToe) {
      fwd = this.b.lToe.getWorldPosition(_v1).sub(this.b.lFoot.getWorldPosition(_v2));
      fwd.y = 0;
      fwd = fwd.lengthSq() > 1e-10 ? fwd.normalize() : null;
    }
    if (fwd) {
      // into root space (the root may already be turned by the controller)
      fwd.applyQuaternion(this.root.getWorldQuaternion(_q).invert());
      this.model.rotation.y = -Math.atan2(fwd.x, fwd.z); // face → +Z
    }
    this.model.updateMatrixWorld(true);

    // Scale to height, feet on y = 0 (fit what's drawn, ignoring swords and ink shells).
    const fitBox = () => {
      const box = new Box3();
      scene.traverse((o) => {
        if (o.isMesh && o.visible && !o.userData.weapon && !lineMats.has(o.material)) box.expandByObject(o, true);
      });
      return box;
    };
    let box = fitBox();
    const s = P.height / Math.max(box.getSize(_v1).y, 1e-6);
    this.model.scale.setScalar(s);
    this.model.updateMatrixWorld(true);
    box = fitBox();
    const c = box.getCenter(_v2);
    this.model.position.sub(this.bob.worldToLocal(_v3.set(c.x, box.min.y, c.z)));
    this.model.updateMatrixWorld(true);

    this.setupFaceTint(scene);

    // animations: everything from the idle layer plays together.
    // The legs belong to the procedural layer, always: their tracks are stripped
    // from the idle clips so the clip can never overwrite the knee / thigh / foot
    // rotations (no stiff, locked legs while the idle is blending in or out).
    this.mixer = new AnimationMixer(scene);
    const runClip = gltf.animations.find((a) => /run|sprint|jog/i.test(a.name));
    const legNames = new Set(this.procedural ? ['lThigh', 'lCalf', 'lFoot', 'lToe', 'rThigh', 'rCalf', 'rFoot', 'rToe'].map((k) => this.b[k]?.name).filter(Boolean) : []);
    const idleClips = gltf.animations
      .filter((a) => a !== runClip && !/walk/i.test(a.name))
      .map((clip) => {
        const c = clip.clone();
        c.tracks = c.tracks.filter((t) => !legNames.has(t.name.slice(0, t.name.lastIndexOf('.'))));
        return c;
      })
      .filter((c) => c.tracks.length);
    this.idleActions = idleClips.map((clip) => {
      const a = this.mixer.clipAction(clip);
      a.play();
      return a;
    });
    this.hasIdle = this.idleActions.length > 0;
    this.runAction = runClip ? this.mixer.clipAction(runClip) : null;
    if (this.runAction) {
      this.runAction.play();
      this.runAction.setEffectiveWeight(0);
    }
    this.ready = true;
    return this;
  }

  /** Blush + smile painted on the face follow the cheek / mouth bones (ported from fireworks' ModelSlot). */
  setupFaceTint(scene) {
    const ex = this.profile.expression;
    const cfg = ex?.tint;
    if (!cfg) return;
    let mat = null;
    scene.traverse((o) => {
      if (!mat && o.isMesh && cfg.material.test(o.material?.name || '')) mat = o.material;
    });
    const head = findBone(scene, ex.head);
    const nose = findBone(scene, ex.face);
    const crown = findBone(scene, cfg.up);
    const cheeks = (cfg.blush?.cheeks ?? []).map((n) => findBone(scene, n));
    const mouth = (cfg.mouth?.corners ?? []).map((n) => findBone(scene, n));
    if (!mat || !head || !nose || !crown || [...cheeks, ...mouth].some((b) => !b)) return;
    scene.updateMatrixWorld(true);
    const hp = new Vector3().setFromMatrixPosition(head.matrixWorld);
    const toHead = head.getWorldQuaternion(new Quaternion()).invert();
    const localUp = new Vector3().setFromMatrixPosition(crown.matrixWorld).sub(hp).applyQuaternion(toHead).normalize();
    const localFwd = new Vector3().setFromMatrixPosition(nose.matrixWorld).sub(hp).applyQuaternion(toHead);
    localFwd.addScaledVector(localUp, -localFwd.dot(localUp)).normalize();
    this.tint = { uniforms: addFaceTint(mat, cfg), cheeks, mouth, head, localFwd, localUp, q: new Quaternion() };
  }

  updateFaceTint() {
    const t = this.tint;
    if (!t) return;
    const { uniforms: u, cheeks, mouth, head, localFwd, localUp, q } = t;
    head.getWorldQuaternion(q);
    u.uFaceFwd.value.copy(localFwd).applyQuaternion(q);
    u.uFaceUp.value.copy(localUp).applyQuaternion(q);
    if (cheeks.length) {
      u.uCheekL.value.setFromMatrixPosition(cheeks[0].matrixWorld);
      u.uCheekR.value.setFromMatrixPosition(cheeks[1].matrixWorld);
    }
    if (mouth.length) {
      u.uMouthL.value.setFromMatrixPosition(mouth[0].matrixWorld);
      u.uMouthR.value.setFromMatrixPosition(mouth[1].matrixWorld);
    }
  }

  /* ───── bone helpers (character-space axes) ───── */

  /** Rotate bone about a character-space axis through its pivot. */
  turn(bone, axis, angle) {
    if (!bone || !angle) return;
    this.root.getWorldQuaternion(_rq);
    _v1.copy(axis).applyQuaternion(_rq);
    _q.setFromAxisAngle(_v1, angle);
    bone.parent.getWorldQuaternion(_pq);
    _q2.copy(_pq).invert().multiply(_q).multiply(_pq);
    bone.quaternion.premultiply(_q2);
  }

  /** Rotate bone so that bone→child points along a character-space direction (blended by w). */
  aim(bone, child, dir, w) {
    if (!bone || !child || w <= 0) return;
    bone.getWorldPosition(_v1);
    child.getWorldPosition(_v2);
    const cur = _v2.sub(_v1).normalize();
    this.root.getWorldQuaternion(_rq);
    const target = _v3.copy(dir).normalize().applyQuaternion(_rq);
    _q.setFromUnitVectors(cur, target);
    _q.slerp(_q2.identity(), 1 - w);
    bone.parent.getWorldQuaternion(_pq);
    _q2.copy(_pq).invert().multiply(_q).multiply(_pq);
    bone.quaternion.premultiply(_q2);
  }

  /**
   * @param {number} dt
   * @param {object} s { speed, grounded, vy, freefall, landed (impact 0..1.2 on the landing frame), windup (0..1) }
   */
  update(dt, s) {
    if (!this.ready) return;
    this.time += dt;
    const moving = clamp((s.speed - 0.4) / 3.5, 0, 1);
    this.runW = lerp(this.runW, moving * (s.grounded ? 1 : 0.3), damp(9, dt));
    this.airW = lerp(this.airW, s.grounded ? 0 : 1, damp(s.grounded ? 16 : 7, dt));
    this.fallW = lerp(this.fallW, s.freefall ? 1 : 0, damp(s.freefall ? 3 : 7, dt));
    this.crouchW = lerp(this.crouchW, s.windup ?? 0, damp(30, dt));
    // the lean-in eases in and out like the fall / landing blends (never snaps)
    this.kissW = lerp(this.kissW, s.kiss ?? 0, damp(s.kiss ? 2.4 : 3.2, dt));

    // landing shock absorber: an impulse into a damped spring (hold the crouch on heavy landings)
    if (s.landed) {
      const impact = clamp(s.landed, 0, 1.2);
      this.shockV += 11 * impact;
      this.shockHold = impact >= 0.9 ? 0.38 : 0;
      this.shockTarget = impact >= 0.9 ? 0.95 : 0;
    }
    if (this.shockHold > 0) this.shockHold -= dt;
    else this.shockTarget = 0;
    {
      const k = 150, c = 2 * 0.7 * Math.sqrt(k);
      const steps = Math.ceil(dt / (1 / 120));
      const h = dt / steps;
      for (let n = 0; n < steps; n++) {
        this.shockV += (k * (this.shockTarget - this.shock) - c * this.shockV) * h;
        this.shock += this.shockV * h;
      }
      if (this.shock < 0) {
        this.shock = 0;
        this.shockV = Math.max(0, this.shockV);
      }
      this.shock = Math.min(this.shock, 1.3);
    }

    // Order matters: 1) reset procedurally driven bones to bind pose, 2) the mixer
    // writes the animated (non-leg) bones, 3) the procedural layer is applied on
    // top, last, every frame — so nothing the clip does can stiffen the joints.
    for (const b of this.gaitBones) b.quaternion.copy(b.userData.bind);
    const procW = !this.hasIdle ? 1 : clamp(Math.max(this.runW, this.airW, this.crouchW, this.shock, this.fallW), 0, 1);
    for (const a of this.idleActions) a.setEffectiveWeight(1 - procW);
    if (this.runAction) this.runAction.setEffectiveWeight(this.runW);
    this.mixer.update(dt);
    this.scene.updateMatrixWorld(true);

    const freq = 0.9 + s.speed * 0.17;
    const prev = this.phase;
    this.phase += dt * freq * Math.PI * 2 * (s.grounded ? 1 : 0.25);
    if (s.grounded && s.speed > 1 && Math.floor(prev / Math.PI) !== Math.floor(this.phase / Math.PI)) this.onStep?.(s.speed);

    this.bob.position.y = 0;
    this.lean.rotation.set(0, 0, 0);
    this.lean.position.y = 0;
    if (this.procedural) this.gait(dt, s, procW); // always: the legs are procedural-only
    this.secondary(dt, s);
    this.updateFaceTint();
  }

  gait(dt, s, procW) {
    const b = this.b;
    const sp = clamp((s.speed - 3) / 5, 0, 1); // walk → sprint
    const run = this.runW * (1 - this.airW);
    const air = this.airW * (1 - this.fallW);
    const fall = this.fallW;
    const crouch = this.crouchW * (1 - this.airW);
    const shock = this.shock;
    const still = (1 - this.runW) * (1 - this.airW) * (1 - fall); // standing
    const own = this.hasIdle ? 0 : 1; // upper-body idle is procedural only for clip-less rigs
    const breath = Math.sin(this.time * 1.7);
    const kiss = this.kissW;
    const K = this.profile.kiss ?? {};
    const hands = (K.hands ?? 0) * kiss * own;

    // ── arms: down from whatever the bind pose is, relaxed out & back ──
    const armDown = procW * (1 - fall);
    this.aim(b.lUpper, b.lFore, _v3.set(0.3 + 0.35 * air - 0.2 * hands, -1 + 0.4 * air, -0.1 - 0.25 * crouch + 0.2 * shock + 0.55 * hands), armDown);
    this.aim(b.rUpper, b.rFore, _v3.set(-0.3 - 0.35 * air + 0.2 * hands, -1 + 0.4 * air, -0.1 - 0.25 * crouch + 0.2 * shock + 0.55 * hands), armDown);
    if (fall > 0) {
      const fl = Math.sin(this.time * 9) * 0.25;
      this.aim(b.lUpper, b.lFore, _v3.set(1, 0.55 + fl, 0.1), fall);
      this.aim(b.rUpper, b.rFore, _v3.set(-1, 0.55 - fl, 0.1), fall);
    }
    const sw = Math.sin(this.phase);
    const armA = lerp(0.4, 0.95, sp) * run;
    this.turn(b.lUpper, AX, sw * armA);
    this.turn(b.rUpper, AX, -sw * armA);
    const elbow = lerp(0.35, 1.35, sp) * run + 0.7 * air + 0.3 * fall + 0.5 * crouch + 0.6 * shock + 0.12 * still * own + 1.1 * hands;
    this.turn(b.lFore, AX, -elbow);
    this.turn(b.rFore, AX, -elbow);

    // ── legs ──
    // Each leg runs the same cycle, the right offset by π. Thigh swing = sin(φ);
    // the knee flexes on the BACKSWING (peak just after toe-off, cos(φ+0.45) > 0),
    // so the foot kicks up behind instead of a straight leg pendulum-swinging.
    const legA = lerp(0.42, 0.88, sp) * run;
    const kneeA = lerp(0.7, 1.75, sp) * run;
    const legs = [
      [b.lThigh, b.lCalf, b.lFoot, this.phase, 1],
      [b.rThigh, b.rCalf, b.rFoot, this.phase + Math.PI, -1],
    ];
    for (const [thigh, calf, foot, ph, side] of legs) {
      const swing = Math.sin(ph) * legA; // + = forward
      let knee = 0.12 * run + kneeA * Math.pow(Math.max(0, Math.cos(ph + 0.45)), 1.4);
      let thighF = swing;
      // jump anticipation: sink into the knees before take-off
      thighF += 0.6 * crouch;
      knee += 1.2 * crouch;
      // mid-air: knees tucked up (one leg a little higher), never hanging straight
      thighF += air * (side > 0 ? 0.75 : 0.45);
      knee += air * (side > 0 ? 1.35 : 1.0);
      // landing: absorb the impact deep in the knees, then spring back
      thighF += 0.78 * shock;
      knee += 1.55 * shock;
      // freefall: legs apart, flailing
      const flail = Math.sin(this.time * 7.5 + side) * 0.35 * fall;
      thighF += (0.25 + flail) * fall;
      knee += (0.55 + flail * 0.5) * fall;
      // standing: a soft bend so knees never lock dead straight
      knee += 0.08 * still;
      knee = clamp(knee, 0, KNEE_MAX); // knees never bend backward
      this.turn(thigh, AX, -thighF);
      if (fall > 0) this.turn(thigh, AZ, -0.35 * fall * side);
      this.turn(calf, AX, knee);
      // keep the sole roughly level (more in a crouch / landing, toes trail in the run)
      const flat = clamp(thighF - knee, -1.1, 0.9) * lerp(0.35, 0.9, Math.max(crouch, shock, still));
      // (up on her toes for the lean-in)
      this.turn(foot, AX, flat - 0.25 * Math.max(0, Math.cos(ph + 0.45)) * run - 0.5 * (K.tiptoe ? kiss : 0));
    }

    // ── torso ──
    const leanA = lerp(0.06, 0.3, sp) * run + 0.15 * air + 0.32 * crouch + 0.38 * shock;
    this.turn(b.pelvis, AY, -sw * 0.14 * run);
    this.turn(b.spine1, AX, leanA * 0.6 + 0.015 * breath * still * own + (K.lean ?? 0) * 0.55 * kiss);
    this.turn(b.spine2, AX, leanA * 0.4 + (K.lean ?? 0) * 0.45 * kiss);
    this.turn(b.spine2 ?? b.spine1, AY, sw * 0.22 * run);
    this.turn(b.neck, AX, (K.neck ?? 0) * kiss);
    this.turn(b.head, AX, -leanA * 0.55 - 0.3 * fall + (K.head ?? 0) * kiss);
    this.turn(b.head, AZ, (K.tilt ?? 0) * kiss); // tilt to their own right: facing each other, the heads interleave

    // hips drop with the knees (metres, root space)
    const sink = 0.2 * crouch + 0.3 * shock;
    this.bob.position.y = -0.04 * run + Math.abs(Math.cos(this.phase)) * 0.075 * run - sink + 0.004 * breath * still * own + (K.tiptoe ?? 0) * kiss;
    this.lean.rotation.x = fall * (1.05 + Math.sin(this.time * 1.7) * 0.15);
    this.lean.rotation.z = fall * Math.sin(this.time * 1.1) * 0.3;
    this.lean.position.y = fall * 0.8;
  }

  /** Spring-damper cloth: acceleration in character space → cape / skirt / sleeve / hair swing. */
  secondary(dt, s) {
    if (!this.cloth?.length || dt <= 0) return;
    const p = this.root.position;
    if (!this.hasPrev) {
      this.prevPos.copy(p);
      this.hasPrev = true;
      return;
    }
    const v = _v1.copy(p).sub(this.prevPos).divideScalar(dt);
    this.prevPos.copy(p);
    if (v.lengthSq() > 90 * 90) v.copy(this.prevVel); // teleports / recentering
    const a = _v2.copy(v).sub(this.prevVel).divideScalar(dt);
    this.prevVel.copy(v);
    this.acc.lerp(a.clampLength(0, 60), damp(14, dt));
    const h = this.root.rotation.y;
    const fx = Math.sin(h), fz = Math.cos(h);
    const lx = Math.cos(h), lz = -Math.sin(h);
    // soft-saturated so a sprint start doesn't pin the cloth, while a stop still swings it
    const accF = 18 * Math.tanh((this.acc.x * fx + this.acc.z * fz) / 18);
    const accL = 18 * Math.tanh((this.acc.x * lx + this.acc.z * lz) / 18);
    const velF = v.x * fx + v.z * fz;
    const fall = this.fallW;
    const rising = clamp(-s.vy / 30, -0.3, 1) * (s.grounded ? 0 : 1);
    // character axes in world space (once per frame) + a fresh world-rotation cache
    this._wq = this._wq ?? new Map();
    this._wq.clear();
    this.root.getWorldQuaternion(_rq);
    _ax.copy(AX).applyQuaternion(_rq);
    _az.copy(AZ).applyQuaternion(_rq);
    for (let i = 0; i < this.cloth.length; i++) {
      const g = this.cloth[i];
      // + pitch = hem swings back. Accelerating → lags back; braking → swings forward.
      let tp = clamp(velF / 8.6, -0.3, 1) * g.trail + accF * g.gain + rising * g.lift * 0.5 + this.shock * g.lift * 0.25;
      tp += fall * g.lift * (0.9 + 0.35 * Math.sin(this.time * 13 + i * 2));
      tp += 0.03 * Math.sin(this.time * 1.7 + i * 1.3);
      const tr = clamp(-accL * g.roll, -0.6, 0.6) + fall * 0.25 * Math.sin(this.time * 9 + i);
      const steps = Math.ceil(dt / (1 / 120));
      const hh = dt / steps;
      for (let n = 0; n < steps; n++) {
        g.vp += (g.k * (tp - g.p) - g.c * g.vp) * hh;
        g.vr += (g.k * (tr - g.r) - g.c * g.vr) * hh;
        g.p += g.vp * hh;
        g.r += g.vr * hh;
      }
      g.p = clamp(g.p, -1.1, 1.5);
      g.r = clamp(g.r, -0.8, 0.8);
      for (const it of g.items) {
        // pitch then roll about character axes, as one world-space rotation
        _q.setFromAxisAngle(_ax, g.p * it.w);
        _q2.setFromAxisAngle(_az, g.r * it.w);
        this.turnCached(it.bone, _q2.multiply(_q));
      }
    }
  }

  /**
   * Bone world rotations for the cloth pass, cached parent-first (chains are
   * listed parents before children). Saves walking the whole ancestor chain for
   * every one of ~200 spring bones (that was ~3 ms a frame).
   */
  worldQ(o) {
    let q = this._wq.get(o);
    if (q) return q;
    q = o === this.root || !o.parent ? o.getWorldQuaternion(new Quaternion()) : this.worldQ(o.parent).clone().multiply(o.quaternion);
    this._wq.set(o, q);
    return q;
  }

  /** Apply a WORLD-space rotation to a bone about its pivot, keeping the cache current. */
  turnCached(bone, qW) {
    const pw = this.worldQ(bone.parent);
    _pq.copy(pw).invert().multiply(qW).multiply(pw);
    bone.quaternion.premultiply(_pq);
    this._wq.set(bone, pw.clone().multiply(bone.quaternion));
  }
}
