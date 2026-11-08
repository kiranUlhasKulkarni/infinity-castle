import {
  BackSide,
  Color,
  FrontSide,
  DataTexture,
  Euler,
  MeshBasicMaterial,
  MeshStandardMaterial,
  MeshToonMaterial,
  NearestFilter,
  Quaternion,
  RedFormat,
} from 'three';
import { addIris } from './faceDetail.js';

/**
 * Re-skins a loaded .glb for the scene's anime look.
 *
 * `rules` is an ordered list; the first rule whose `match` (RegExp) fits a
 * material's name wins:
 *   { match: /hair/i, color: '#16101e' }                          → cel-shaded toon
 *   { match: /LINES/, type: 'line', color: '#120a12' }             → flat ink
 *   { match: /sword/i, type: 'standard', metalness: 0.8 }           → PBR
 *   { match: /Body/, keepMap: true }                                → toon, keeping the file's texture
 *   { match: /sword/, type: 'hide' }                                 → not drawn
 *   { match: /eyes/, iris: { center, radius, … } }                  → painted anime iris (faceDetail.js)
 * Optional per rule: emissive, emissiveIntensity, roughness, metalness, opacity,
 * side ('front' | 'back'). Ink-outline shells (inverted hulls) must draw one side
 * only, or they cover the whole body in black.
 * Materials no rule matches are left as they are.
 */

// Three-step light ramp: lit, mid tone, shadow — the classic anime cel look.
let ramp = null;
function toonRamp() {
  if (!ramp) {
    ramp = new DataTexture(new Uint8Array([90, 170, 255]), 3, 1, RedFormat);
    ramp.minFilter = ramp.magFilter = NearestFilter;
    ramp.generateMipmaps = false;
    ramp.needsUpdate = true;
  }
  return ramp;
}

function makeMaterial(src, rule) {
  const side = rule.side === 'back' ? BackSide : rule.side === 'front' ? FrontSide : src.side;
  const base = {
    name: src.name,
    side,
    map: rule.keepMap ? src.map : null,
    transparent: (rule.opacity ?? 1) < 1,
    opacity: rule.opacity ?? 1,
  };
  if (base.map) base.map.colorSpace = 'srgb';
  const color = rule.color ? new Color(rule.color) : rule.keepMap ? new Color('#ffffff') : src.color?.clone() ?? new Color('#ffffff');
  if (rule.type === 'line') return new MeshBasicMaterial({ ...base, color, map: null });
  const emissive = {
    emissive: new Color(rule.emissive ?? '#000000'),
    emissiveIntensity: rule.emissiveIntensity ?? (rule.emissive ? 1 : 0),
  };
  const mat =
    rule.type === 'standard'
      ? new MeshStandardMaterial({ ...base, ...emissive, color, roughness: rule.roughness ?? 0.6, metalness: rule.metalness ?? 0 })
      : new MeshToonMaterial({ ...base, ...emissive, color, gradientMap: toonRamp() });
  if (rule.iris) addIris(mat, rule.iris);
  return mat;
}

/** Applies material rules + shadow flags to every mesh under `root` (a clone). */
export function styleModel(root, { materials = [], castShadow = true } = {}) {
  const made = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = castShadow;
    o.receiveShadow = false; // avoids shadow acne on cel shading
    const list = Array.isArray(o.material) ? o.material : [o.material];
    if (list.some((m) => materials.find((r) => r.match.test(m.name || ''))?.type === 'hide')) {
      o.visible = false;
      o.castShadow = false;
      return;
    }
    const next = list.map((m) => {
      const rule = materials.find((r) => r.match.test(m.name || ''));
      if (!rule) return m;
      if (!made.has(m)) made.set(m, makeMaterial(m, rule));
      return made.get(m);
    });
    o.material = Array.isArray(o.material) ? next : next[0];
  });
}

/**
 * Bend bones of a model that has no animations (e.g. lower T-posed arms).
 * `pose` maps a bone-name RegExp source to an [x, y, z] rotation in radians,
 * applied on top of the bind pose in the bone's local space.
 */
export function poseBones(root, pose = {}) {
  const rules = Object.entries(pose).map(([src, rot]) => [new RegExp(src), new Quaternion().setFromEuler(new Euler(...rot))]);
  if (!rules.length) return;
  root.traverse((o) => {
    if (!o.isBone) return;
    const hit = rules.find(([re]) => re.test(o.name));
    if (hit) o.quaternion.multiply(hit[1]);
  });
}
