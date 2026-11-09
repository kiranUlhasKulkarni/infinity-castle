import {
  BackSide,
  BoxGeometry,
  Color,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  PlaneGeometry,
  PMREMGenerator,
  Quaternion,
  RedFormat,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  Vector4,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ATMOSPHERE, POND } from '../config.js';
import { mulberry32, wrapSigned } from '../utils/math.js';
import { castleUniforms, GLSL_COMMON } from './shaders.js';

const MAX_RIPPLES = 12;
const GLOW_RES = 128;
const LOTUS_SCALE = 1.5;

/**
 * Doma's Lotus Pond — the parts of the boss room the instanced castle can't
 * draw: the water and the ice lotuses. The hall itself (bed, engawa, bridge,
 * dais, icy shoji walls, ceiling) is ordinary castle geometry from layout.js,
 * so it lives in the same InstancedMeshes, collides, morphs and gets cut by
 * the trapdoor like everything else.
 *
 * Water (one custom shader, no extra scene render):
 *   • reflections are traced analytically — the hall is a known box, so the
 *     mirrored view ray is intersected with its walls / ceiling and shaded
 *     with the same frosted-paper pattern; soft (rough water), rippled,
 *   • through the surface: a shallow pebble bed, the lotuses' light pooling
 *     on it (a baked glow map) and drifting caustics,
 *   • ripple rings from wading feet, as normal displacement (12 live rings).
 *
 * Lotuses: an InstancedMesh of crystalline petals (MeshPhysicalMaterial,
 * transmission 1.0, ior 1.5, blue attenuation) around a glowing HDR core
 * (the bloom catches it), on frosted ice pads. Transmission costs a second
 * opaque render, so it's only used close up on desktop; far away and on touch
 * devices the petals swap to a non-transmissive glassy look.
 *
 * Mist: low-lying frost (Doma's Blood Demon Art) — big soft puffs (one instanced
 * draw, all motion in the vertex shader) creeping across the water and the
 * bridge, breathing in opacity and size, lit by the lotuses. Not scene.fog, which
 * would grey the castle's black void everywhere. No depth texture is needed for
 * the soft fade: the hall's surfaces are known, so each fragment fades by its
 * height above whatever is under it (water, bridge, dais, engawa), by its
 * distance to the walls, and near Tanjiro's and Kanao's legs (depthWrite off) —
 * no hard seams where a puff meets anything.
 *
 * The castle is periodic, so each pond is drawn at its copy nearest the camera.
 */
export class LotusPonds {
  constructor(scene, renderer, { low = false } = {}) {
    this.scene = scene;
    this.low = low;
    this.period = [1, 1, 1];
    this.ripples = { value: Array.from({ length: MAX_RIPPLES }, () => new Vector4(0, 0, -99, 0)) };
    this.rippleIdx = 0;
    if (!low) renderer.transmissionResolutionScale = 0.5; // the refraction behind ice is blurry anyway

    const env = iceEnvironment(renderer);
    this.env = env; // shared with the ice Buddha
    const petalGeo = lotusGeometry();
    const coreGeo = new SphereGeometry(0.075, 12, 8).scale(1, 0.75, 1).translate(0, 0.07, 0);
    const padGeo = new CylinderGeometry(0.5, 0.5, 0.03, 20, 1);
    this.petalHiMat = new MeshPhysicalMaterial({
      color: new Color(0.82, 0.93, 1.0),
      transmission: 1.0,
      ior: 1.5,
      thickness: 0.32,
      attenuationColor: new Color(0.42, 0.72, 1.0),
      attenuationDistance: 0.5,
      roughness: 0.1,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.08,
      specularIntensity: 1,
      envMap: env,
      envMapIntensity: 1.3,
      emissive: new Color(0.05, 0.16, 0.34),
      side: DoubleSide,
    });
    this.petalLoMat = new MeshPhysicalMaterial({
      color: new Color(0.55, 0.8, 1.0),
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      roughness: 0.12,
      metalness: 0.1,
      clearcoat: 1,
      clearcoatRoughness: 0.1,
      envMap: env,
      envMapIntensity: 1.4,
      emissive: new Color(0.08, 0.26, 0.55),
      side: DoubleSide,
    });
    this.padMat = new MeshPhysicalMaterial({
      color: new Color(0.06, 0.16, 0.2),
      roughness: 0.3,
      metalness: 0,
      clearcoat: 1,
      clearcoatRoughness: 0.15,
      envMap: env,
      envMapIntensity: 0.7,
      emissive: new Color(0.0, 0.025, 0.05),
    });
    this.petalEmissive = { hi: this.petalHiMat.emissive.clone(), lo: this.petalLoMat.emissive.clone() };

    const maxLotus = POND.lotuses, maxPads = POND.lotuses + 45;
    const mistTex = mistTexture();
    const mistGeo = mistGeometry(low ? Math.round(POND.mist / 2) : POND.mist);
    this.actors = []; // Vector3s the mist parts around (Tanjiro, Kanao) — set by main
    this.slots = [];
    for (let i = 0; i < POND.perPeriod; i++) {
      const group = new Group();
      group.name = `lotus-pond-${i}`;
      group.visible = false;
      const glowData = new Uint8Array(GLOW_RES * GLOW_RES);
      const glow = new DataTexture(glowData, GLOW_RES, GLOW_RES, RedFormat);
      glow.magFilter = glow.minFilter = LinearFilter;
      const water = new Mesh(new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), waterMaterial(this.ripples, glow, low));
      const petalsHi = new InstancedMesh(petalGeo, this.petalHiMat, maxLotus);
      const petalsLo = new InstancedMesh(petalGeo, this.petalLoMat, maxLotus);
      petalsLo.instanceMatrix = petalsHi.instanceMatrix; // one set of transforms, two looks
      petalsLo.renderOrder = 2;
      const coreMat = new MeshBasicMaterial({ color: new Color(0.5, 1.3, 2.6) });
      const cores = new InstancedMesh(coreGeo, coreMat, maxLotus);
      const pads = new InstancedMesh(padGeo, this.padMat, maxPads);
      const mist = new Mesh(mistGeo, mistMaterial(mistTex, glow));
      mist.frustumCulled = false;
      mist.renderOrder = 3; // after the lotuses
      group.add(water, pads, petalsHi, petalsLo, cores, mist);
      scene.add(group);
      this.slots.push({ group, water, petalsHi, petalsLo, cores, coreMat, pads, mist, glow, glowData, pond: null, copy: new Vector3(), show: 0 });
    }
    this.hidden = true;
  }

  /** New castle layout (startup, or after a Biwa rearrangement). */
  setLayout(layout) {
    this.period = layout.period;
    const m = new Matrix4(), q = new Quaternion(), s = new Vector3(), t = new Vector3(), Y = new Vector3(0, 1, 0);
    this.slots.forEach((slot, i) => {
      const pond = layout.ponds?.[i] ?? null;
      slot.pond = pond;
      slot.show = 0;
      slot.group.visible = false;
      if (!pond) return;
      const S = pond.size, inner = S - 2 * pond.engawa + 0.6;
      slot.water.scale.set(inner, 1, inner);
      slot.water.position.y = pond.surf;
      const u = slot.water.material.uniforms;
      u.uHalf.value = S / 2;
      u.uHeight.value = pond.height;
      const mu = slot.mist.material.uniforms;
      mu.uHalf.value = S / 2;
      mu.uRegion.value = S / 2 - 1.5;
      mu.uInner.value = S / 2 - pond.engawa;
      mu.uSurf.value = pond.surf;
      mu.uBridge.value.set(pond.bridge / 2, pond.bridgeTop);
      mu.uDais.value.set(pond.dais / 2, pond.daisTop);
      // lotuses + their pads
      const L = pond.lotus, n = Math.min(L.length / 4, POND.lotuses);
      for (let k = 0; k < n; k++) {
        const x = L[k * 4], z = L[k * 4 + 1], sc = L[k * 4 + 2] * LOTUS_SCALE, r = L[k * 4 + 3];
        q.setFromAxisAngle(Y, r);
        m.compose(t.set(x, pond.surf + 0.012, z), q, s.setScalar(sc));
        slot.petalsHi.setMatrixAt(k, m);
        slot.cores.setMatrixAt(k, m);
        m.compose(t.set(x, pond.surf + 0.004, z), q, s.set(sc * 1.45, 1, sc * 1.45));
        slot.pads.setMatrixAt(k, m);
      }
      const PD = pond.pads, np = Math.min(PD.length / 4, slot.pads.instanceMatrix.count - n);
      for (let k = 0; k < np; k++) {
        q.setFromAxisAngle(Y, PD[k * 4 + 3]);
        const sc = PD[k * 4 + 2] * LOTUS_SCALE;
        m.compose(t.set(PD[k * 4], pond.surf + 0.004, PD[k * 4 + 1]), q, s.set(sc, 1, sc));
        slot.pads.setMatrixAt(n + k, m);
      }
      for (const mesh of [slot.petalsHi, slot.cores]) {
        mesh.count = n;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere();
      }
      slot.petalsLo.count = n;
      slot.petalsLo.computeBoundingSphere();
      slot.pads.count = n + np;
      slot.pads.instanceMatrix.needsUpdate = true;
      slot.pads.computeBoundingSphere();
      // glow map: the light each lotus pools on the water and the bed (room-local, S × S)
      const g = new Float32Array(GLOW_RES * GLOW_RES);
      const px = S / GLOW_RES;
      for (let k = 0; k < n; k++) {
        const x = L[k * 4], z = L[k * 4 + 1], sig = 0.75 * L[k * 4 + 2] * LOTUS_SCALE, R = Math.ceil((sig * 3) / px);
        const ci = Math.floor((x + S / 2) / px), cj = Math.floor((z + S / 2) / px);
        for (let j = Math.max(1, cj - R); j <= Math.min(GLOW_RES - 2, cj + R); j++)
          for (let ii = Math.max(1, ci - R); ii <= Math.min(GLOW_RES - 2, ci + R); ii++) {
            const dx = (ii + 0.5) * px - S / 2 - x, dz = (j + 0.5) * px - S / 2 - z;
            g[j * GLOW_RES + ii] += Math.exp(-(dx * dx + dz * dz) / (2 * sig * sig));
          }
      }
      for (let k = 0; k < g.length; k++) slot.glowData[k] = Math.min(255, Math.round(255 * (1 - Math.exp(-g[k] * 1.1))));
      slot.glow.needsUpdate = true;
    });
  }

  /** The slot drawn nearest to `cam` (its group is visible), or null. */
  nearestVisible(cam) {
    let best = null, bd = Infinity;
    for (const slot of this.slots) {
      if (!slot.pond || !slot.group.visible) continue;
      const d = slot.copy.distanceToSquared(cam);
      if (d < bd) (bd = d), (best = slot);
    }
    return best;
  }

  /** Index of the pond whose hall contains `p` (its bounding box), or -1. */
  inside(p) {
    const [Px, Py, Pz] = this.period;
    for (let i = 0; i < this.slots.length; i++) {
      const pd = this.slots[i].pond;
      if (!pd) continue;
      const h = pd.size / 2 - 0.25;
      const dx = wrapSigned(p.x - pd.c[0], Px), dy = wrapSigned(p.y - pd.c[1], Py), dz = wrapSigned(p.z - pd.c[2], Pz);
      if (Math.abs(dx) < h && Math.abs(dz) < h && dy > pd.bed - 1.2 && dy < pd.height) return i;
    }
    return -1;
  }

  /** World height of the water surface above `p` if `p` is over a pond's open water, else null. */
  level(p) {
    if (this.hidden) return null;
    const [Px, Py, Pz] = this.period;
    for (const slot of this.slots) {
      const pd = slot.pond;
      if (!pd || slot.show < 0.99) continue;
      const h = pd.size / 2 - pd.engawa;
      const dx = wrapSigned(p.x - pd.c[0], Px), dy = wrapSigned(p.y - pd.c[1], Py), dz = wrapSigned(p.z - pd.c[2], Pz);
      if (Math.abs(dx) < h && Math.abs(dz) < h && dy > pd.bed - 0.6 && dy < pd.surf + 0.4) return p.y - dy + pd.surf;
    }
    return null;
  }

  /** A ripple ring at (x, z) — strength ~0.2 (a still foot) … 1.6 (a landing). */
  ripple(x, z, strength = 0.4) {
    const r = this.ripples.value[this.rippleIdx];
    this.rippleIdx = (this.rippleIdx + 1) % MAX_RIPPLES;
    r.set(x, z, castleUniforms.uTime.value, strength);
  }

  /** The nearest pond copy's centre (door level) to `p`, or null — for the debug teleport. */
  nearest(p) {
    let best = null, bd = Infinity;
    for (const slot of this.slots) {
      const pd = slot.pond;
      if (!pd) continue;
      const c = this.copyNear(pd.c, p, new Vector3());
      const d = c.distanceToSquared(p);
      if (d < bd) (bd = d), (best = { center: c, pond: pd });
    }
    return best;
  }

  copyNear(c, p, out) {
    const [Px, Py, Pz] = this.period;
    return out.set(p.x + wrapSigned(c[0] - p.x, Px), p.y + wrapSigned(c[1] - p.y, Py), p.z + wrapSigned(c[2] - p.z, Pz));
  }

  /** hidden: the Biwa is playing (the castle is being cut / rearranged) — the water drains at once. */
  update(dt, camera, hidden) {
    this.hidden = hidden;
    const cam = camera.position;
    const fogD = ATMOSPHERE.glowFogDensity;
    let nearest = Infinity;
    for (const slot of this.slots) {
      const pd = slot.pond;
      if (!pd || hidden) {
        slot.group.visible = false;
        slot.show = 0;
        continue;
      }
      const c = this.copyNear(pd.c, cam, slot.copy);
      const d = Math.max(0, c.distanceTo(cam) - pd.size * 0.6);
      if (d > 130) { // fully fogged beyond this
        slot.group.visible = false;
        continue;
      }
      slot.show = Math.min(1, slot.show + dt / 0.7);
      const e = 1 - Math.pow(1 - slot.show, 3); // the water spreads and the lotuses open out from the centre
      slot.group.visible = true;
      slot.group.position.copy(c);
      slot.group.scale.setScalar(Math.max(0.001, e));
      const u = slot.water.material.uniforms;
      u.uCenter.value.copy(c);
      u.uScale.value = Math.max(0.001, e);
      const mu = slot.mist.material.uniforms;
      mu.uScale.value = Math.max(0.001, e);
      mu.uOpacity.value = 0.22 * e;
      mu.uHero.value.copy(this.actors[0] ?? mu.uHero.value);
      mu.uKanao.value.copy(this.actors[1] ?? mu.uKanao.value);
      // transmission only up close, and never on touch devices
      const near = !this.low && d < 22;
      slot.petalsHi.visible = near;
      slot.petalsLo.visible = !near;
      const fog = Math.exp(-((fogD * d) ** 2));
      const pulse = 0.88 + 0.12 * Math.sin(castleUniforms.uTime.value * 1.3 + c.x);
      slot.coreMat.color.setRGB(0.5, 1.3, 2.6).multiplyScalar(fog * pulse);
      if (d < nearest) {
        nearest = d;
        this.petalHiMat.emissive.copy(this.petalEmissive.hi).multiplyScalar(fog);
        this.petalLoMat.emissive.copy(this.petalEmissive.lo).multiplyScalar(fog);
      }
    }
  }

  /** Compile every pond shader (both petal looks) behind the loading screen, so nothing hitches on first sight. */
  warm(renderer, camera) {
    const saved = this.slots.map((s) => [s.group.visible, s.petalsHi.visible, s.petalsLo.visible, s.group.position.clone()]);
    const ahead = new Vector3(0, 0, -6).applyQuaternion(camera.quaternion).add(camera.position);
    for (const s of this.slots) {
      s.group.visible = s.petalsHi.visible = s.petalsLo.visible = true;
      s.group.position.copy(ahead);
    }
    renderer.compile(this.scene, camera);
    this.slots.forEach((s, i) => {
      [s.group.visible, s.petalsHi.visible, s.petalsLo.visible] = saved[i];
      s.group.position.copy(saved[i][3]);
    });
  }
}

/* ───────────── water ───────────── */

function waterMaterial(ripples, glow, low) {
  return new ShaderMaterial({
    defines: low ? { LOW: 1, MAX_RIPPLES } : { MAX_RIPPLES },
    uniforms: {
      ...castleUniforms,
      uMinSize: { value: 0 },
      uCenter: { value: new Vector3() }, // the hall's centre at door level (copy nearest the camera)
      uHalf: { value: 20 },
      uHeight: { value: 16 },
      uScale: { value: 1 },
      uGlow: { value: glow },
      uRipples: ripples,
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: /* glsl */ `
      ${GLSL_COMMON}
      uniform vec3 uCenter;
      uniform float uHalf, uHeight, uScale;
      uniform sampler2D uGlow;
      uniform vec4 uRipples[MAX_RIPPLES];
      varying vec3 vWorld;

      // light the lotuses pool on the water (room-local glow map; its border is black)
      float glowAt(vec2 p) {
        return texture2D(uGlow, (p - uCenter.xz) / (2.0 * uHalf * uScale) + 0.5).r;
      }
      // the frosted shoji seen in the water: bays, koshi board, head rail, transom, beam — softened by the ripples
      vec3 wallColor(float a, float v, float blur) {
        float bu = fract(a / 1.7);
        float post = 1.0 - smoothstep(0.035, 0.035 + blur, min(bu, 1.0 - bu) * 1.7);
        float sv = mod(v, 3.4);
        float rails = 1.0 - smoothstep(0.52 - blur, 0.52 + blur, sv);
        rails = max(rails, smoothstep(2.6 - blur, 2.6 + blur, sv) * (1.0 - smoothstep(2.78 - blur, 2.78 + blur, sv)));
        rails = max(rails, smoothstep(3.22 - blur, 3.22 + blur, sv));
        float id = floor(a / 1.7) + floor(v / 3.4) * 17.0;
        float rnd = hash12(vec2(id, 3.7));
        float lit = step(rnd, 0.9) * (0.7 + 0.6 * hash12(vec2(id, 9.1)));
        vec3 paper = mix(vec3(0.42, 0.72, 1.0), vec3(0.62, 0.86, 1.0), rnd) * (lit * 1.25 + 0.04) * uShojiBrightness;
        return mix(paper, vec3(0.006, 0.008, 0.012), max(post, rails) * 0.92);
      }

      void main() {
        vec3 V = normalize(vWorld - cameraPosition);
        vec2 p = vWorld.xz;
        // ripple rings from wading feet
        vec2 grad = vec2(0.0);
        float ring = 0.0;
        for (int i = 0; i < MAX_RIPPLES; i++) {
          vec4 r = uRipples[i];
          float age = uTime - r.z;
          if (age < 0.0 || age > 3.2) continue;
          vec2 d = p - r.xy;
          float dist = length(d);
          float rad = 0.12 + age * 0.9;
          float x = dist - rad;
          float life = 1.0 - age / 3.2;
          float env = exp(-x * x * 14.0) * r.w * life * life / (1.0 + rad * 1.5);
          float ph = x * 24.0;
          grad += d / max(dist, 1e-3) * cos(ph) * env;
          ring += max(sin(ph), 0.0) * env;
        }
        // the surface breathes very slightly (still, dark water)
        #ifdef LOW
          float w1 = vnoise3(vec3(p * 0.9, uTime * 0.3)) - 0.5;
          vec2 wav = vec2(w1, -w1);
        #else
          vec2 wav = vec2(vnoise3(vec3(p * 0.9, uTime * 0.3)), vnoise3(vec3(p * 0.9 + 17.0, uTime * 0.3))) - 0.5;
        #endif
        vec3 N = normalize(vec3(-(grad.x * 0.4 + wav.x * 0.05), 1.0, -(grad.y * 0.4 + wav.y * 0.05)));

        // reflection: the mirrored ray hits the hall's walls or ceiling (an exact box)
        vec3 R = reflect(V, N);
        R.y = max(R.y, 0.02);
        vec3 o = vWorld;
        float hw = uHalf - 0.22;
        float tx = R.x > 0.0 ? (uCenter.x + hw - o.x) / max(R.x, 1e-4) : (uCenter.x - hw - o.x) / min(R.x, -1e-4);
        float tz = R.z > 0.0 ? (uCenter.z + hw - o.z) / max(R.z, 1e-4) : (uCenter.z - hw - o.z) / min(R.z, -1e-4);
        float ty = (uCenter.y + uHeight - 0.4 - o.y) / R.y;
        float t = max(min(min(tx, tz), ty), 0.0);
        vec3 h = o + R * t;
        float blur = 0.03 + t * 0.012 + length(grad) * 0.5;
        vec3 refl;
        if (ty <= min(tx, tz)) {
          vec2 g = abs(fract(h.xz / 5.0) - 0.5);
          float beam = 1.0 - smoothstep(0.02, 0.04 + blur, min(g.x, g.y));
          refl = vec3(0.006, 0.012, 0.022) + vec3(0.02, 0.05, 0.09) * beam;
          // the paper walls light the ceiling's edges
          float edge = min(uHalf - abs(h.x - uCenter.x), uHalf - abs(h.z - uCenter.z));
          refl += vec3(0.06, 0.13, 0.22) * exp(-edge * 0.22) * (1.0 - beam * 0.6);
        } else {
          refl = wallColor(tx < tz ? h.z : h.x, h.y - uCenter.y, blur);
        }
        refl *= exp(-t * 0.012);

        // through the surface: a shallow pebble bed, the lotuses' light pooling, caustics
        vec3 Rr = refract(V, N, 0.75);
        float tb = ${POND.waterDepth.toFixed(3)} / max(-Rr.y, 0.08);
        vec2 bp = p + Rr.xz * tb;
        vec2 cell = floor(bp * 3.0);
        vec2 fc = fract(bp * 3.0) - 0.5 + (vec2(hash12(cell + 1.3), hash12(cell + 7.1)) - 0.5) * 0.4;
        float stone = smoothstep(0.5, 0.3, length(fc));
        vec3 bed = vec3(0.01, 0.022, 0.03) * (0.5 + 0.7 * hash12(cell) * stone);
        #ifdef LOW
          float caus = 0.45;
        #else
          float caus = pow(vnoise3(vec3(bp * 2.2, uTime * 0.5)), 3.0) * 2.0;
        #endif
        bed += vec3(0.15, 0.45, 0.85) * glowAt(bp) * (0.5 + caus);
        bed *= exp(-tb * vec3(3.0, 1.2, 0.7));

        float cosT = clamp(dot(-V, N), 0.0, 1.0);
        float F = max(0.12 + 0.88 * pow(1.0 - cosT, 4.0), 0.32); // dark water: always a strong mirror
        vec3 col = mix(bed, refl, F);
        float gs = glowAt(p);
        col += vec3(0.25, 0.65, 1.2) * gs * gs * 0.55; // halo of cold light around each lotus
        col += vec3(0.5, 0.8, 1.0) * ring * 0.35;      // ripple crests catch the paper's light
        gl_FragColor = vec4(applyFog(col, vWorld, uFogDensity), 1.0);
      }`,
  });
}

/* ───────────── mist ───────────── */

/** Puffs scattered over the hall (local), each: centre, and size / phase / drift speed / drift heading. */
function mistGeometry(n) {
  const quad = new PlaneGeometry(1, 1);
  const g = new InstancedBufferGeometry();
  g.index = quad.index;
  g.setAttribute('position', quad.attributes.position);
  g.setAttribute('uv', quad.attributes.uv);
  const rnd = mulberry32(2024);
  const region = POND.size / 2 - 1.5;
  const c = new Float32Array(n * 3), pr = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    c.set([(rnd() * 2 - 1) * region, 0.1 + rnd() * 0.85, (rnd() * 2 - 1) * region], i * 3);
    // a prevailing creep (one direction, loosely) so the frost seems to flow across the water
    pr.set([3.5 + rnd() * 4.5, rnd() * 100, 0.12 + rnd() * 0.3, 0.7 + (rnd() - 0.5) * 1.4], i * 4);
  }
  g.setAttribute('aCenter', new InstancedBufferAttribute(c, 3));
  g.setAttribute('aParams', new InstancedBufferAttribute(pr, 4));
  g.instanceCount = n;
  return g;
}

function mistMaterial(tex, glow) {
  return new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: castleUniforms.uTime,
      uTex: { value: tex },
      uGlow: { value: glow },
      uScale: { value: 1 },
      uHalf: { value: 20 },
      uRegion: { value: 18.5 },
      uInner: { value: 16.8 },
      uSurf: { value: -0.1 },
      uBridge: { value: new Vector2(2.6, 0.3) }, // half width, top
      uDais: { value: new Vector2(5, 0.6) }, // half size, top
      uHero: { value: new Vector3(0, -1e4, 0) },
      uKanao: { value: new Vector3(0, -1e4, 0) },
      uOpacity: { value: 0.17 },
      uColor: { value: new Color(0.62, 0.84, 0.95) },
    },
    vertexShader: /* glsl */ `
      uniform float uTime, uScale, uRegion;
      attribute vec3 aCenter;
      attribute vec4 aParams;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying float vAlpha;
      void main() {
        float t = uTime;
        vec3 c = aCenter;
        c.xz = mod(c.xz + vec2(cos(aParams.w), sin(aParams.w)) * aParams.z * t + uRegion, 2.0 * uRegion) - uRegion;
        c.y += sin(t * 0.27 + aParams.y) * 0.1;
        float size = aParams.x * (1.0 + 0.18 * sin(t * 0.19 + aParams.y * 2.3)); // breathing
        vec3 origin = modelMatrix[3].xyz;
        vec3 cw = origin + c * uScale;
        // camera-facing, slowly turning
        vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
        vec3 up = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
        float a = aParams.y + t * 0.05 * (fract(aParams.y) - 0.5);
        vec2 q = mat2(cos(a), sin(a), -sin(a), cos(a)) * position.xy;
        vWorld = cw + (right * q.x + up * q.y) * size * uScale;
        vLocal = (vWorld - origin) / uScale;
        vUv = uv;
        // opacity breathes; puffs fade out before they wrap around the hall
        vAlpha = (0.6 + 0.4 * sin(t * 0.33 + aParams.y * 4.1)) * smoothstep(uRegion, uRegion - 3.0, max(abs(c.x), abs(c.z)));
        gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex;
      uniform sampler2D uGlow;
      uniform float uHalf, uInner, uSurf, uOpacity;
      uniform vec2 uBridge, uDais;
      uniform vec3 uHero, uKanao, uColor;
      varying vec2 vUv;
      varying vec3 vWorld;
      varying vec3 vLocal;
      varying float vAlpha;
      float floorAt(vec2 p) {
        if (abs(p.x) > uInner || abs(p.y) > uInner) return 0.0;
        if (abs(p.x) < uDais.x && abs(p.y) < uDais.x) return uDais.y;
        if (abs(p.y) < uBridge.x) return uBridge.y;
        return uSurf;
      }
      void main() {
        float a = texture2D(uTex, vUv).r * vAlpha;
        a *= smoothstep(0.0, 0.6, vLocal.y - floorAt(vLocal.xz));     // melts into water / boards: no seam
        a *= 1.0 - smoothstep(0.9, 2.4, vLocal.y - uSurf);           // low-lying: about knee to waist high
        a *= smoothstep(0.3, 1.8, uHalf - max(abs(vLocal.x), abs(vLocal.z))); // never slices into the walls
        // parts softly around Tanjiro and Kanao: no hard line across their legs
        a *= mix(0.15, 1.0, smoothstep(0.15, 0.9, length(vWorld.xz - uHero.xz)));
        a *= mix(0.15, 1.0, smoothstep(0.15, 0.9, length(vWorld.xz - uKanao.xz)));
        a *= smoothstep(0.8, 3.0, distance(vWorld, cameraPosition)); // no puff edge in the lens
        float g = texture2D(uGlow, vLocal.xz / (2.0 * uHalf) + 0.5).r;
        gl_FragColor = vec4(uColor * (0.5 + 1.1 * g), a * uOpacity); // lotus light glows in the mist
      }`,
  });
}

/** A soft, lumpy smoke puff (radial falloff × fractal noise) as a single-channel texture. */
function mistTexture(size = 128) {
  const rnd = mulberry32(555);
  const octaves = [[4, 0.55], [8, 0.3], [16, 0.15]].map(([n, a]) => ({ n, a, g: Float32Array.from({ length: (n + 1) * (n + 1) }, () => rnd()) }));
  const data = new Uint8Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (const { n: k, a, g } of octaves) {
        const fx = (x / size) * k, fy = (y / size) * k, x0 = Math.floor(fx), y0 = Math.floor(fy);
        const tx = fx - x0, ty = fy - y0, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
        const at = (i, j) => g[j * (k + 1) + i];
        n += a * ((at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx) * (1 - sy) + (at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx) * sy);
      }
      const r = Math.hypot(x / size - 0.5, y / size - 0.5) * 2;
      const t = Math.min(1, Math.max(0, (r - 0.15) / 0.85));
      const fall = 1 - t * t * (3 - 2 * t);
      data[y * size + x] = Math.round(255 * fall * Math.pow(0.3 + 0.7 * n, 1.6));
    }
  const tex = new DataTexture(data, size, size, RedFormat);
  tex.magFilter = LinearFilter;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

/* ───────────── ice lotus ───────────── */

/** Three rings of cupped, pointed petals (9 + 7 + 5), opening wider at the rim. One merged geometry. */
export function lotusGeometry() {
  const parts = [];
  const rings = [
    [9, 0.34, 0.38, 0.0],
    [7, 0.27, 0.8, 0.35],
    [5, 0.19, 1.15, 0.1],
  ];
  for (const [n, len, tilt, ph] of rings) {
    for (let i = 0; i < n; i++) {
      const g = new SphereGeometry(0.5, 8, 6);
      const pa = g.attributes.position;
      for (let v = 0; v < pa.count; v++) {
        const tip = pa.getZ(v) + 0.5; // 0 at the base, 1 at the tip
        const x = pa.getX(v) * len * 0.62 * (1 - tip * tip * 0.78);
        const y = pa.getY(v) * 0.05 + tip * tip * len * 0.35; // thin, cupped upward
        pa.setXYZ(v, x, y, tip * len);
      }
      g.computeVertexNormals();
      g.rotateX(-tilt);
      g.translate(0, 0.02, 0.035);
      g.rotateY(ph + (i / n) * Math.PI * 2);
      parts.push(g);
    }
  }
  const merged = mergeGeometries(parts);
  parts.forEach((g) => g.dispose());
  return merged;
}

/** A tiny icy hall (glowing paper walls, cold specks) prefiltered into an env map, so the ice has something to sparkle with. */
function iceEnvironment(renderer) {
  const scene = new Scene();
  const disposables = [];
  const add = (geo, color, side = DoubleSide) => {
    const mat = new MeshBasicMaterial({ color, side });
    const mesh = new Mesh(geo, mat);
    disposables.push(geo, mat);
    scene.add(mesh);
    return mesh;
  };
  add(new BoxGeometry(10, 6, 10), new Color(0.004, 0.01, 0.022), BackSide);
  const paper = new Color(0.5, 0.82, 1.25).multiplyScalar(1.5);
  for (let i = 0; i < 4; i++) {
    const m = add(new PlaneGeometry(8.5, 2.6), paper);
    const a = (i * Math.PI) / 2;
    m.position.set(Math.sin(a) * 4.9, 0.4, Math.cos(a) * 4.9);
    m.rotation.y = a + Math.PI;
  }
  for (let i = 0; i < 9; i++) {
    const m = add(new SphereGeometry(0.18, 8, 6), new Color(0.7, 1.0, 1.4).multiplyScalar(5));
    m.position.set(Math.sin(i * 2.4) * 3.2, -1.6 + (i % 3) * 0.3, Math.cos(i * 2.4) * 3.2);
  }
  const pm = new PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.035);
  pm.dispose();
  disposables.forEach((d) => d.dispose());
  return rt.texture;
}
