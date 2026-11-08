import { CHARACTER, COMPANION } from '../config.js';

/**
 * Character profiles for Biped.js: model, size, look, bone map and cloth chains.
 * Bone names are matched as RegExp sources against three.js-sanitised names
 * (spaces become underscores).
 */

const BIP = (side, part) => `Bip001_?${side ? side + '_?' : ''}${part}`;

export const TANJIRO = {
  name: 'Tanjiro',
  url: CHARACTER.url,
  height: CHARACTER.height,
  hideWeapon: CHARACTER.hideWeapon,
  outline: CHARACTER.outline, // generated inverted-hull ink outline
  materials: null, // keep the file's textures, cel-shaded
  faceMesh: /Face/, // which way he looks (sets the model's forward)
  rig: {
    pelvis: BIP('', 'Pelvis'),
    spine1: BIP('', 'Spine1'),
    spine2: BIP('', 'Spine2'),
    neck: BIP('', 'Neck'),
    head: BIP('', 'Head'),
    lThigh: BIP('L', 'Thigh'),
    lCalf: BIP('L', 'Calf'), // the knee joint
    lFoot: BIP('L', 'Foot'),
    lToe: BIP('L', 'Toe0'),
    rThigh: BIP('R', 'Thigh'),
    rCalf: BIP('R', 'Calf'),
    rFoot: BIP('R', 'Foot'),
    lUpper: BIP('L', 'UpperArm'),
    lFore: BIP('L', 'Forearm'),
    rUpper: BIP('R', 'UpperArm'),
    rFore: BIP('R', 'Forearm'),
  },
  // the 'K' lean-in (radians): torso lean, neck, head pitch (+ = looks down), head tilt (to his right)
  kiss: { lean: 0.44, neck: 0.14, head: 0.12, tilt: 0.3 },
  // spring-damper secondary motion (k stiffness, zeta damping, gain = response to acceleration)
  cloth: [
    { match: '^Bone_Skirt', k: 48, zeta: 0.28, gain: 0.04, trail: 0.42, lift: 1.0, roll: 0.045 }, // haori hem
    { match: '^Bone_Sleeve', k: 62, zeta: 0.3, gain: 0.03, trail: 0.25, lift: 0.7, roll: 0.03, scale: 0.8 },
    { match: '^Bone_Hair', k: 110, zeta: 0.38, gain: 0.015, trail: 0.12, lift: 0.35, roll: 0.015, scale: 0.6 },
  ],
};

// ── Kanao: the painted look, ported 1:1 from the fireworks project's config ──
// Her .glb ships with no textures (every part renders flat grey), so each
// material is re-coloured by name. First matching rule wins (see modelStyle.js).
const KANAO_LOOK = [
  // Her sword & sheath are on separate skeletons the game attached to her hand;
  // without that link they float at her feet, so they're hidden
  // (first, so their outline shells are hidden too).
  { match: /sword|sheath/i, type: 'hide' },
  { match: /LINES|^7_(boots|cloak)\.2/, type: 'line', color: '#140b14', side: 'back' }, // built-in anime outline shells (inflated hulls)
  { match: /eyeshadows/, color: '#5a2a4a' }, // warm plum eyeliner
  { match: /faceshadows/, color: '#e2ad9c' },
  { match: /hair/, color: '#1c1226' }, // black with a plum sheen
  { match: /cloak/, color: '#f6eef2' }, // white capelet
  { match: /back|body/, color: '#1d1b28' }, // dark corps uniform
  { match: /butterfly/, color: '#f49ad6', emissive: '#c46cff', emissiveIntensity: 1.6 },
  // Glossy violet eyes with a painted lilac anime iris and catch-lights
  // (bind-pose units: each eye spans x 0.01–0.072, y 1.31–1.37).
  {
    match: /eyes/,
    type: 'standard',
    color: '#b07ad6',
    emissive: '#9a62d8',
    emissiveIntensity: 1.1,
    roughness: 0.15,
    iris: {
      center: [0.041, 1.341],
      radius: [0.019, 0.023],
      pupil: 0.34,
      top: '#2e1650',
      mid: '#8a5ccc',
      bottom: '#e4c8ff',
      pupilColor: '#1a0c2c',
      sclera: '#f6f0fa',
    },
  },
  // a faint warm self-light keeps her face readable in the dark
  { match: /face|hands/, color: '#f8dccd', emissive: '#f2b9a6', emissiveIntensity: 0.16 },
  { match: /boots/, color: '#2a2027' },
];

export const KANAO = {
  name: 'Kanao',
  url: COMPANION.url,
  height: COMPANION.height,
  outline: 0, // she has her own built-in ink shells (the LINES materials)
  materials: KANAO_LOOK,
  faceMesh: /5_face/,
  // A soft, happy face (from fireworks): lip corners and cheeks lift a little,
  // lower lids rise; a gentle blush and small closed smile are painted on.
  expression: {
    head: '^C_Head_1_',
    face: '^C_Nose_',
    bones: {
      '^[LR]_LipCorner_': { up: 0.0035, out: 0.0012 },
      '^[LR]_Cheek_': { up: 0.0018 },
      '^[LR]_LowerEyelids_': { up: 0.0018 },
    },
    tint: {
      material: /5_face/,
      up: '^C_FaceMiddle_',
      blush: { cheeks: ['^L_Cheek_', '^R_Cheek_'], color: '#ff86aa', strength: 0.42, radius: 0.016 },
      mouth: { corners: ['^L_UpperLipC_', '^R_UpperLipC_'], color: '#86304a', width: 0.9, sag: 0.0024, thickness: 0.0014 },
    },
  },
  rig: {
    pelvis: '^C_Hips_1_',
    spine1: '^C_Spine_1_',
    spine2: '^C_Spine_3_',
    neck: '^C_Neck_1_\\d',
    head: '^C_Head_1_\\d',
    lThigh: '^L_Thigh_1_\\d',
    lCalf: '^L_Calf_1_\\d', // the knee joint
    lFoot: '^L_Foot_1_\\d',
    lToe: '^L_Toe_1_\\d',
    rThigh: '^R_Thigh_1_\\d',
    rCalf: '^R_Calf_1_\\d',
    rFoot: '^R_Foot_1_\\d',
    lUpper: '^L_UpperArm_1_\\d',
    lFore: '^L_Forearm_1_\\d',
    rUpper: '^R_UpperArm_1_\\d',
    rFore: '^R_Forearm_1_\\d',
  },
  // she's a little shorter: chin up, up on her toes, hands drawn in
  kiss: { lean: 0.36, neck: 0.08, head: -0.2, tilt: 0.24, tiptoe: 0.035, hands: 1 },
  cloth: [
    { match: '^[LRC]_Cape[A-Z]_\\d', k: 40, zeta: 0.26, gain: 0.045, trail: 0.4, lift: 1.0, roll: 0.05 }, // white capelet
    { match: '^[LR]_Skirt[A-Z]_\\d', k: 55, zeta: 0.3, gain: 0.03, trail: 0.25, lift: 0.8, roll: 0.035, scale: 0.7 },
    { match: '^C_Sidetail', k: 35, zeta: 0.22, gain: 0.05, trail: 0.45, lift: 1.0, roll: 0.06 }, // side ponytail
    { match: '^[LRC]_Hair(Back|Side)', k: 90, zeta: 0.35, gain: 0.018, trail: 0.15, lift: 0.4, roll: 0.02, scale: 0.6 },
  ],
};
