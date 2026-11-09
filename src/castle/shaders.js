import { Color, ShaderMaterial, Vector3 } from 'three';
import { ATMOSPHERE, CASTLE } from '../config.js';

export const MAX_LAMPS = 8;

/**
 * Uniforms shared by every castle material (and the sky), so one update per
 * frame drives fog, lantern lights, the hero light and the Biwa pulse.
 */
export const castleUniforms = {
  uPeriod: { value: new Vector3(1, 1, 1) },
  uCull: { value: CASTLE.cullRadius },
  uTime: { value: 0 },
  uFogDensity: { value: ATMOSPHERE.fogDensity },
  uGlowFog: { value: ATMOSPHERE.glowFogDensity },
  uAbyss: { value: new Color(ATMOSPHERE.abyssGlow) },
  uLampPos: { value: Array.from({ length: MAX_LAMPS }, () => new Vector3(0, -1e5, 0)) },
  uLampCol: { value: Array.from({ length: MAX_LAMPS }, () => new Vector3()) },
  uHeroPos: { value: new Vector3() },
  uHeroLight: { value: new Vector3(0.5, 0.21, 0.08) },
  uPulse: { value: 0 }, // Biwa strum: the paper flares blood-red
  uLampFade: { value: 1 },
  uShojiBrightness: { value: CASTLE.shojiBrightness },
  uBiome: { value: 0 }, // 0 = the castle's warm lantern glow, 1 = Doma's freezing blue (lerped over 3 s)
  uIceFog: { value: 0 }, // pale-blue haze density inside Doma's hall (0 everywhere else: the void stays black)
};

export const GLSL_COMMON = /* glsl */ `
  uniform vec3 uPeriod;
  uniform float uCull;
  uniform float uTime;
  uniform float uFogDensity;
  uniform float uGlowFog;
  uniform vec3 uAbyss;
  uniform vec3 uLampPos[${MAX_LAMPS}];
  uniform vec3 uLampCol[${MAX_LAMPS}];
  uniform vec3 uHeroPos;
  uniform vec3 uHeroLight;
  uniform float uPulse;
  uniform float uLampFade;
  uniform float uMinSize;
  uniform float uShojiBrightness;
  uniform float uBiome;
  uniform float uIceFog;

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float hash13(vec3 p3) {
    p3 = fract(p3 * 0.1031);
    p3 += dot(p3, p3.zyx + 31.32);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash13(i), n100 = hash13(i + vec3(1, 0, 0));
    float n010 = hash13(i + vec3(0, 1, 0)), n110 = hash13(i + vec3(1, 1, 0));
    float n001 = hash13(i + vec3(0, 0, 1)), n101 = hash13(i + vec3(1, 0, 1));
    float n011 = hash13(i + vec3(0, 1, 1)), n111 = hash13(i + vec3(1, 1, 1));
    return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y), mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
  }
  // The void: black above, a faint crimson haze far below.
  vec3 voidColor(vec3 dir) {
    float down = smoothstep(0.05, 1.0, -dir.y);
    return uAbyss * down * down;
  }
  vec3 applyFog(vec3 col, vec3 wp, float density) {
    vec3 v = wp - cameraPosition;
    float d = length(v);
    float f = 1.0 - exp(-density * density * d * d);
    col = mix(col, voidColor(v / max(d, 1e-3)), f);
    // Doma's frost: a pale-blue haze that thickens with distance (only while inside his hall)
    float fi = 1.0 - exp(-uIceFog * uIceFog * d * d);
    return mix(col, vec3(0.11, 0.19, 0.26), fi * 0.65);
  }
  float glowTransmit(vec3 wp) {
    float d = length(wp - cameraPosition);
    return exp(-uGlowFog * uGlowFog * d * d);
  }
  // Warm light: the 8 nearest paper lanterns + the glow around the hero + an
  // ambient "the whole castle is lit from within" field.
  float ambientField(vec3 p) { return vnoise3(p * 0.045 + vec3(0.0, uTime * 0.02, 0.0)); }
  vec3 castleLight(vec3 p, vec3 n, float field) {
    vec3 sum = vec3(0.0);
    for (int i = 0; i < ${MAX_LAMPS}; i++) {
      vec3 L = uLampPos[i] - p;
      float d2 = dot(L, L);
      L *= inversesqrt(max(d2, 1e-4));
      float att = 1.0 / (1.0 + d2 * 0.11);
      sum += uLampCol[i] * att * (0.2 + 0.8 * max(dot(n, L), 0.0));
    }
    sum *= uLampFade;
    vec3 H = uHeroPos - p;
    float h2 = dot(H, H);
    H *= inversesqrt(max(h2, 1e-4));
    sum += uHeroLight * (1.0 / (1.0 + h2 * 0.035)) * (0.3 + 0.7 * max(dot(n, H), 0.0));
    vec3 amb = mix(vec3(0.01, 0.005, 0.005), vec3(0.11, 0.038, 0.016), field * field);
    amb += vec3(0.05, 0.012, 0.01) * max(-n.y, 0.0); // crimson bounce from the abyss below
    vec3 ambCold = mix(vec3(0.004, 0.008, 0.014), vec3(0.03, 0.075, 0.12), field * field) + vec3(0.006, 0.02, 0.04) * max(-n.y, 0.0);
    amb = mix(amb, ambCold, uBiome);
    amb *= 0.8 + 0.2 * max(n.y, 0.0);
    return sum + amb + vec3(0.9, 0.12, 0.06) * uPulse * 0.6;
  }
`;

// Fragment-only (uses derivatives). Pen-and-ink box edges, like the blueprint drawing.
const GLSL_INK = /* glsl */ `
  float inkEdge(vec2 uv, vec2 sz, float width) {
    vec2 d = sz * 0.5 - abs(uv);
    float e = min(d.x, d.y);
    float fw = fwidth(e);
    return (1.0 - smoothstep(width, width + fw * 1.5, e)) * (1.0 - smoothstep(0.03, 0.14, fw));
  }
`;

const VERT = /* glsl */ `
  ${GLSL_COMMON}
  attribute vec4 aInfo;
  varying vec3 vLocal;
  varying vec3 vObjN;
  varying vec3 vN;
  varying vec3 vWorld;
  varying vec4 vInfo;
  varying vec3 vSize;
  varying float vField;

  void main() {
    vec3 s = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
    vec3 c = instanceMatrix[3].xyz;
    // The castle is periodic: draw the copy of this instance nearest the camera.
    vec3 shift = uPeriod * floor((cameraPosition - c) / uPeriod + 0.5);
    float rad = 0.5 * length(s);
    float dist = length(c + shift - cameraPosition);
    // skip what's hidden by fog, and thin far-away pieces that would only shimmer
    if (s.x * s.y * s.z < 1e-7 || dist - rad > uCull || rad < (dist - rad) * uMinSize) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0); // outside the clip volume
      return;
    }
    vec4 wp = instanceMatrix * vec4(position, 1.0);
    wp.xyz += shift;
    vLocal = position * s;
    vSize = s;
    vObjN = normal;
    vN = normalize(mat3(instanceMatrix) * (normal / (s * s)));
    vWorld = wp.xyz;
    vInfo = aInfo;
    vField = ambientField(wp.xyz);
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const VARYINGS = /* glsl */ `
  varying float vField;
  varying vec3 vLocal;
  varying vec3 vObjN;
  varying vec3 vN;
  varying vec3 vWorld;
  varying vec4 vInfo;
  varying vec3 vSize;
`;

/* ─────────────────────────── Wood (decks, posts, stairs, roofs) ─────────────────────────── */

const WOOD_FRAG = /* glsl */ `
  ${GLSL_COMMON}
  ${GLSL_INK}
  ${VARYINGS}
  void main() {
    vec3 n = normalize(vN);
    float kind = vInfo.x;
    float seed = vInfo.y;
    float tone = vInfo.z;
    vec3 a = abs(vObjN);
    vec2 uv, sz;
    if (a.x > 0.5) { uv = vLocal.zy; sz = vSize.zy; }
    else if (a.y > 0.5) { uv = vLocal.xz; sz = vSize.xz; }
    else { uv = vLocal.xy; sz = vSize.xy; }

    // planks run along the longer side of each face
    bool alongX = sz.x >= sz.y;
    float across = alongX ? uv.y : uv.x;
    float along = alongX ? uv.x : uv.y;
    float plankW = kind < 0.5 ? 0.34 : 0.16;
    float pc = across / plankW;
    float pid = floor(pc);
    float pf = fract(pc);
    float prnd = hash12(vec2(pid, seed * 97.0));
    float grain = sin(along * (5.0 + prnd * 6.0) + sin(along * 1.1 + prnd * 9.0) * 2.4 + pf * 7.0);
    float fwp = fwidth(pc);
    float seam = mix(smoothstep(0.0, 0.07, pf) * smoothstep(1.0, 0.93, pf), 0.85, smoothstep(0.15, 0.5, fwp));

    vec3 albedo = vec3(0.34, 0.14, 0.065) * (0.6 + 0.4 * prnd) * tone;
    albedo *= 0.88 + 0.12 * grain * (1.0 - smoothstep(0.1, 0.4, fwp));
    if (kind > 1.5 && kind < 2.5) albedo = vec3(0.07, 0.035, 0.03) * tone; // dark lacquered roofs
    if (kind > 3.5 && kind < 4.5) albedo *= 0.7; // railings
    albedo *= mix(0.5, 1.0, seam);
    if (kind > 4.5 && a.y > 0.5) {
      // tatami: 0.9 × 1.8 m mats in a running layout, woven igusa straw, dark cloth borders
      vec2 q = vWorld.xz / vec2(1.8, 0.9);
      float row = floor(q.y);
      q.x += mod(row, 2.0) * 0.5;
      vec2 f = fract(q);
      float mid = hash12(floor(q) + 3.1);
      float weave = 0.86 + 0.14 * sin(vWorld.z * 140.0) * (1.0 - smoothstep(0.004, 0.012, fwidth(vWorld.z * 140.0) / 140.0));
      vec3 straw = mix(vec3(0.42, 0.4, 0.19), vec3(0.48, 0.42, 0.2), mid) * weave;
      float heri = 1.0 - smoothstep(0.02, 0.035, min(f.y, 1.0 - f.y)); // long-edge cloth band
      float seamT = 1.0 - smoothstep(0.004, 0.01, min(f.x, 1.0 - f.x));
      albedo = mix(straw, vec3(0.03, 0.025, 0.03), max(heri, seamT * 0.8));
    }

    // Doma's room: the cold leaches the colour out of the wood
    albedo = mix(albedo, vec3(dot(albedo, vec3(0.3, 0.55, 0.15))) * vec3(0.85, 0.97, 1.12), uBiome * 0.5);
    vec3 col = albedo * castleLight(vWorld, n, vField);
    float ink = inkEdge(uv, sz, kind > 3.5 ? 0.012 : 0.028);
    col = mix(col, vec3(0.006, 0.003, 0.002), ink * 0.9);
    gl_FragColor = vec4(applyFog(col, vWorld, uFogDensity), 1.0);
  }
`;

/* ─────────────────────────── Shoji houses ─────────────────────────── */

const SHOJI_FRAG = /* glsl */ `
  ${GLSL_COMMON}
  ${GLSL_INK}
  ${VARYINGS}
  void main() {
    vec3 n = normalize(vN);
    float seed = vInfo.x;
    float litP = vInfo.y;
    vec3 a = abs(vObjN);
    vec3 light = castleLight(vWorld, n, vField);
    vec3 diffuse;
    vec3 emissive = vec3(0.0);
    vec2 uvE, szE;

    if (a.y > 0.5) {
      // floor / ceiling of the room: dark boards
      uvE = vLocal.xz; szE = vSize.xz;
      float pf = fract(vLocal.x / 0.3);
      diffuse = vec3(0.12, 0.05, 0.025) * (0.8 + 0.2 * step(0.08, pf)) * light;
    } else {
      bool xFace = a.x > 0.5;
      float faceW = xFace ? vSize.z : vSize.x;
      uvE = xFace ? vLocal.zy : vLocal.xy;
      szE = xFace ? vSize.zy : vSize.xy;
      float u = (xFace ? vLocal.z : vLocal.x) + faceW * 0.5;
      float v = vLocal.y + vSize.y * 0.5;
      float faceId = xFace ? (vObjN.x > 0.0 ? 1.0 : 2.0) : (vObjN.z > 0.0 ? 3.0 : 4.0);

      float story = floor(v / 3.4);
      float sv = v - story * 3.4; // metres within this storey
      float nb = max(1.0, floor(faceW / 1.7 + 0.5));
      float bw = faceW / nb;
      float bay = floor(u / bw);
      float bu = u - bay * bw;
      float rnd = hash13(vec3(seed * 91.7 + faceId * 13.1, story, bay));
      float rnd2 = hash13(vec3(bay + 7.0, story * 7.3, seed * 31.1 + faceId));
      float rnd3 = hash13(vec3(seed * 5.3 + bay, faceId * 3.1, story + 11.0));

      // frame: posts, koshi-ita board, head rail, ranma transom, beam
      float post = 1.0 - step(0.09, bu) * step(bu, bw - 0.09);
      float koshi = 1.0 - step(0.52, sv);
      float head = step(2.6, sv) * step(sv, 2.78);
      float beam = step(3.22, sv);
      float transom = step(2.78, sv) * step(sv, 3.22);
      float frame = max(max(post, koshi), max(head, beam));

      // kumiko lattice (fine bars in metres)
      float pw = bw - 0.18;
      float ph = transom > 0.5 ? 0.44 : 2.08;
      vec2 pq = vec2((bu - 0.09) / pw, transom > 0.5 ? (sv - 2.78) / 0.44 : (sv - 0.52) / 2.08);
      vec2 cells = transom > 0.5 ? vec2(9.0, 2.0) : vec2(3.0, 6.0);
      vec2 g = abs(fract(pq * cells) - 0.5);
      vec2 bar = (0.5 - g) * vec2(pw, ph) / cells;
      float barD = min(bar.x, bar.y);
      float fwb = fwidth(barD);
      float lattice = (1.0 - smoothstep(0.011, 0.011 + fwb * 1.5, barD)) * (1.0 - smoothstep(0.02, 0.06, fwb));

      float lit = step(rnd, litP);
      float flick = 1.0 + 0.07 * sin(uTime * (1.5 + rnd * 4.0) + rnd * 40.0) * sin(uTime * 7.3 + rnd2 * 9.0);
      float inner = clamp(1.15 - 0.6 * length((pq - vec2(0.5, 0.32)) * vec2(1.1, 0.8)), 0.25, 1.0);
      vec3 warm = mix(vec3(1.0, 0.27, 0.05), vec3(1.0, 0.46, 0.15), rnd2);
      vec3 ice = mix(vec3(0.42, 0.72, 1.0), vec3(0.62, 0.86, 1.0), rnd2); // Doma's hall: frosted paper, moonlit from behind
      warm = mix(warm, ice, max(vInfo.w, uBiome * 0.6));
      warm = mix(warm, vec3(1.0, 0.07, 0.04), uPulse);
      float inten = (lit * (0.75 + 1.55 * rnd2) + 0.035) * flick * (1.0 + uPulse * 2.5);

      // rare: a silhouette waiting behind the paper
      if (rnd3 < 0.03 && lit > 0.5 && transom < 0.5) {
        float body = length((pq - vec2(0.5, 0.18)) * vec2(3.2, 1.9));
        float headD = length((pq - vec2(0.5, 0.56)) * vec2(7.0, 4.6));
        inten *= mix(0.12, 1.0, smoothstep(0.85, 1.0, min(body, headD)));
      }
      float paper = 1.0 - frame;
      emissive = warm * inten * inner * paper * (1.0 - lattice * 0.88);

      // far away: the fine pattern averages into a soft glow (no aliasing)
      float fwu = fwidth(u / bw);
      float far = smoothstep(0.25, 0.7, fwu);
      emissive = mix(emissive, warm * 1.5 * litP * 0.45 * (1.0 + uPulse * 2.5), far);

      vec3 frameWood = mix(vec3(0.13, 0.055, 0.028), vec3(0.05, 0.045, 0.05), vInfo.w);
      vec3 paperAlb = mix(vec3(0.32, 0.24, 0.18), vec3(0.24, 0.28, 0.32), vInfo.w);
      diffuse = mix(paperAlb, frameWood, max(frame, lattice) * (1.0 - far * 0.6)) * light;
    }

    float ink = inkEdge(uvE, szE, 0.03);
    diffuse = mix(diffuse, vec3(0.006, 0.003, 0.002), ink * 0.9);
    emissive *= (1.0 - ink) * uShojiBrightness;
    vec3 col = applyFog(diffuse, vWorld, uFogDensity) + emissive * glowTransmit(vWorld);
    gl_FragColor = vec4(col, 1.0);
  }
`;

/* ─────────────────────────── Paper lanterns ─────────────────────────── */

const LANTERN_FRAG = /* glsl */ `
  ${GLSL_COMMON}
  ${VARYINGS}
  void main() {
    float seed = vInfo.x;
    float power = vInfo.y;
    float v = vLocal.y / vSize.y + 0.5;
    vec3 col;
    if (abs(vObjN.y) > 0.5 || v < 0.1 || v > 0.9) {
      col = applyFog(vec3(0.02, 0.008, 0.006) * castleLight(vWorld, normalize(vN), vField), vWorld, uFogDensity);
    } else {
      float rib = smoothstep(0.35, 0.5, abs(fract(v * 9.0) - 0.5));
      float bulge = sin((v - 0.1) / 0.8 * 3.14159);
      float flick = 0.88 + 0.12 * sin(uTime * (3.0 + seed * 3.0) + seed * 50.0) * sin(uTime * 11.0 + seed * 20.0);
      vec3 warm = mix(vec3(1.0, 0.24, 0.05), vec3(1.0, 0.42, 0.12), seed);
      warm = mix(warm, vec3(0.45, 0.75, 1.0), uBiome * 0.55);
      warm = mix(warm, vec3(1.0, 0.05, 0.03), uPulse);
      col = warm * (1.5 + 1.3 * power) * flick * (0.55 + 0.45 * bulge) * (1.0 - rib * 0.55) * (1.0 + uPulse * 2.0);
      col *= glowTransmit(vWorld);
    }
    gl_FragColor = vec4(col, 1.0);
  }
`;

function make(frag, minSize) {
  return new ShaderMaterial({ uniforms: { ...castleUniforms, uMinSize: { value: minSize } }, vertexShader: VERT, fragmentShader: frag });
}
export const createWoodMaterial = () => make(WOOD_FRAG, 0.0075);
export const createShojiMaterial = () => make(SHOJI_FRAG, 0.0);
export const createLanternMaterial = () => make(LANTERN_FRAG, 0.0025);
