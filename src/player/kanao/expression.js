import { Matrix4, Vector3 } from 'three';

/**
 * Ported from the fireworks project (scene/characters/embrace.js):
 * findBone + applyExpression (Kanao's soft smile, applied once at load).
 */
const _m = new Matrix4();

export const findBone = (root, pattern) => {
  const re = new RegExp(pattern);
  let hit = null;
  root.traverse((o) => {
    if (!hit && o.isBone && re.test(o.name)) hit = o;
  });
  return hit;
};

/**
 * Face-bone expression applied once at load (model space, before scaling).
 * `bones` maps a name RegExp to { up, out, fwd } offsets in model units:
 * up = model +Y, out = away from the face's centre line, fwd = toward the face.
 */
export function applyExpression(root, { head, face, bones = {} }) {
  const headBone = findBone(root, head);
  const faceBone = findBone(root, face);
  if (!headBone || !faceBone) return;
  root.updateMatrixWorld(true);
  const hp = new Vector3().setFromMatrixPosition(headBone.matrixWorld);
  const fp = new Vector3().setFromMatrixPosition(faceBone.matrixWorld);
  const fwd = new Vector3(fp.x - hp.x, 0, fp.z - hp.z).normalize();
  const up = new Vector3(0, 1, 0);
  const side = new Vector3().crossVectors(up, fwd).normalize();
  for (const [pattern, o] of Object.entries(bones)) {
    const re = new RegExp(pattern);
    root.traverse((bone) => {
      if (!bone.isBone || !re.test(bone.name)) return;
      const bp = new Vector3().setFromMatrixPosition(bone.matrixWorld);
      const outSign = Math.sign(bp.clone().sub(hp).dot(side)) || 1;
      const offset = new Vector3()
        .addScaledVector(up, o.up ?? 0)
        .addScaledVector(side, (o.out ?? 0) * outSign)
        .addScaledVector(fwd, o.fwd ?? 0);
      // model-space offset → the bone's parent space
      _m.copy(bone.parent.matrixWorld).invert();
      const origin = new Vector3().applyMatrix4(_m);
      offset.applyMatrix4(_m).sub(origin);
      bone.position.add(offset);
    });
  }
  root.updateMatrixWorld(true);
}
