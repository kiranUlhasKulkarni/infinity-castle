import { Color, Vector2, Vector3 } from 'three';

/**
 * Painted-on face detail for a model whose textures are missing (Kanao's file
 * ships flat face and eye meshes):
 *   • addFaceTint() → cheek blush + a small smile, drawn on the face material
 *     around live bones, so they move with the head
 *   • addIris()     → anime iris, pupil and catch-lights on the eye material,
 *     painted in the mesh's own (pre-skinning) space
 * Both patch the material's shader; the returned uniforms are updated per frame.
 */

const keyed = (material, tag) => {
  const key = material.customProgramCacheKey?.() ?? '';
  material.customProgramCacheKey = () => `${key}|${tag}`;
  material.needsUpdate = true;
};

/**
 * Blush around two cheek points + a smile curve between two mouth points.
 * Distances are measured across the face plane (fwd = out of the face, up =
 * the head's up), and only near the front of the face, so nothing leaks onto
 * the chin, neck or the back of the head.
 */
export function addFaceTint(material, { blush, mouth }) {
  const uniforms = {
    uFaceFwd: { value: new Vector3(0, 0, 1) },
    uFaceUp: { value: new Vector3(0, 1, 0) },
    uCheekL: { value: new Vector3(0, -1e3, 0) },
    uCheekR: { value: new Vector3(0, -1e3, 0) },
    uBlushColor: { value: new Color(blush?.color ?? '#ff8fae') },
    uBlush: { value: blush?.strength ?? 0 },
    uBlushRadius: { value: blush?.radius ?? 0.015 },
    uMouthL: { value: new Vector3(0, -1e3, 0) },
    uMouthR: { value: new Vector3(0, -1e3, 0) },
    uMouthColor: { value: new Color(mouth?.color ?? '#8a3a52') },
    uMouth: { value: mouth ? 1 : 0 },
    uMouthShape: { value: new Vector3(mouth?.width ?? 0.8, mouth?.sag ?? 0.0015, mouth?.thickness ?? 0.0008) },
  };
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFaceWorld;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvFaceWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec3 vFaceWorld;
        uniform vec3 uFaceFwd; uniform vec3 uFaceUp;
        uniform vec3 uCheekL; uniform vec3 uCheekR;
        uniform vec3 uBlushColor; uniform float uBlush; uniform float uBlushRadius;
        uniform vec3 uMouthL; uniform vec3 uMouthR;
        uniform vec3 uMouthColor; uniform float uMouth; uniform vec3 uMouthShape;
        float blushAt(vec3 c) {
          vec3 d = vFaceWorld - c;
          float depth = dot(d, uFaceFwd);
          d -= uFaceFwd * depth; // across the face, ignoring depth
          return exp(-dot(d, d) / (uBlushRadius * uBlushRadius)) * step(-0.004, depth);
        }
        float smileAt() {
          vec3 mid = 0.5 * (uMouthL + uMouthR);
          vec3 side = uMouthL - uMouthR;
          side -= uFaceFwd * dot(side, uFaceFwd);
          float halfW = 0.5 * length(side) * uMouthShape.x;
          side = normalize(side);
          vec3 d = vFaceWorld - mid;
          float depth = dot(d, uFaceFwd);
          float u = dot(d, side) / halfW;
          float v = dot(d, uFaceUp);
          float y = uMouthShape.y * (u * u - 1.0); // centre dips, corners lift
          float th = uMouthShape.z * (1.0 - 0.55 * u * u); // tapers to the corners
          float line = 1.0 - smoothstep(th * 0.45, th, abs(v - y));
          return line * (1.0 - smoothstep(0.85, 1.0, abs(u))) * step(-0.006, depth);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        float blush = (blushAt(uCheekL) + blushAt(uCheekR)) * uBlush;
        diffuseColor.rgb = mix(diffuseColor.rgb, uBlushColor, clamp(blush, 0.0, 0.8));
        diffuseColor.rgb = mix(diffuseColor.rgb, uMouthColor, smileAt() * uMouth);`,
      );
  };
  keyed(material, 'face-tint');
  return uniforms;
}

/**
 * Anime iris on an eye mesh, in the mesh's bind-pose space (the `position`
 * attribute, before skinning). Both eyes share one material: each fragment
 * picks the eye centre on its side (x > 0 / x < 0).
 *   center: [x, y] of the right-hand eye (mirrored for the other), radius: [rx, ry]
 */
export function addIris(material, o) {
  const uniforms = {
    uIrisCenter: { value: new Vector2(...o.center) },
    uIrisRadius: { value: new Vector2(...o.radius) },
    uPupil: { value: o.pupil ?? 0.35 },
    uIrisTop: { value: new Color(o.top) },
    uIrisMid: { value: new Color(o.mid) },
    uIrisBottom: { value: new Color(o.bottom) },
    uPupilColor: { value: new Color(o.pupilColor) },
    uSclera: { value: new Color(o.sclera) },
    uCatch: { value: new Color(o.highlight ?? '#ffffff') },
  };
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vEyePos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvEyePos = position.xy;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        varying vec2 vEyePos;
        uniform vec2 uIrisCenter; uniform vec2 uIrisRadius; uniform float uPupil;
        uniform vec3 uIrisTop; uniform vec3 uIrisMid; uniform vec3 uIrisBottom;
        uniform vec3 uPupilColor; uniform vec3 uSclera; uniform vec3 uCatch;
        float irisMask;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        {
          vec2 c = vec2(sign(vEyePos.x) * uIrisCenter.x, uIrisCenter.y);
          vec2 p = (vEyePos - c) / uIrisRadius; // unit circle = iris edge
          float r = length(p);
          float t = clamp(p.y * 0.5 + 0.5, 0.0, 1.0); // 0 bottom → 1 top
          vec3 iris = mix(uIrisBottom, uIrisMid, smoothstep(0.0, 0.55, t));
          iris = mix(iris, uIrisTop, smoothstep(0.55, 1.0, t));
          iris = mix(iris, uIrisTop, smoothstep(0.72, 1.0, r) * 0.8); // dark limbal ring
          float aa = fwidth(r) * 1.5;
          irisMask = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
          vec3 col = mix(uSclera, iris, irisMask);
          col = mix(col, uPupilColor, (1.0 - smoothstep(uPupil - aa, uPupil + aa, r)) * 0.9);
          // catch-lights: a big one up-left, a small one down-right
          float h1 = length((p - vec2(-0.32, 0.38)) / vec2(0.26, 0.3));
          float h2 = length((p - vec2(0.3, -0.42)) / vec2(0.12, 0.12));
          float catchL = max(1.0 - smoothstep(1.0 - aa * 4.0, 1.0, h1), (1.0 - smoothstep(1.0 - aa * 8.0, 1.0, h2)) * 0.85);
          col = mix(col, uCatch, catchL * irisMask);
          diffuseColor.rgb = col;
          irisMask = max(irisMask * (1.0 - t) * 0.8, catchL * irisMask);
        }`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        totalEmissiveRadiance *= irisMask; // only the lower iris and catch-lights glow`,
      );
  };
  keyed(material, 'iris');
  return uniforms;
}
