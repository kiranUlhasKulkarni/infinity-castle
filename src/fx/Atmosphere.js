import { AdditiveBlending, BackSide, BufferGeometry, Float32BufferAttribute, LineSegments, Mesh, Points, ShaderMaterial, SphereGeometry, Vector3 } from 'three';
import { castleUniforms, GLSL_COMMON } from '../castle/shaders.js';
import { mulberry32 } from '../utils/math.js';

/**
 * The void around the castle:
 *  • a sky dome (pitch black, a faint crimson haze deep below and tiny distant
 *    glimmers of rooms too far away to resolve) matching the fog colour,
 *  • ember motes drifting up through the air (world-space, wrapped around the
 *    camera so they're infinite too — when you fall they rush past you),
 *  • speed streaks that only appear in freefall,
 *    (in Doma's room they turn to drifting frost motes),
 *  • a brief warm burst of the same embers (HDR, so the bloom catches it) —
 *    the glow between Tanjiro and Kanao in the 'K' moment.
 */
export class Atmosphere {
  constructor(scene) {
    this.uniforms = {
      ...castleUniforms,
      uFall: { value: 0 },
      uPixelRatio: { value: 1 },
      uEstate: { value: 0 }, // 1 = the normal world's moonlit night sky
    };

    // ── sky dome ──
    const sky = new Mesh(
      new SphereGeometry(500, 48, 24),
      new ShaderMaterial({
        uniforms: this.uniforms,
        side: BackSide,
        depthWrite: false,
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            vec4 wp = modelMatrix * vec4(position, 1.0);
            gl_Position = projectionMatrix * viewMatrix * wp;
            gl_Position.z = gl_Position.w; // at the far plane
          }`,
        fragmentShader: /* glsl */ `
          ${GLSL_COMMON}
          uniform float uEstate;
          varying vec3 vDir;
          vec3 nightSky(vec3 d) {
            vec3 col = mix(vec3(0.02, 0.028, 0.07), vec3(0.004, 0.006, 0.02), smoothstep(0.0, 0.6, d.y));
            col = mix(col, vec3(0.015, 0.02, 0.05), smoothstep(0.02, -0.1, d.y));
            vec3 moonDir = normalize(vec3(-0.45, 0.42, -0.78));
            float m = dot(d, moonDir);
            col += vec3(1.0, 0.95, 0.85) * smoothstep(0.9994, 0.9997, m) * 2.4;
            col += vec3(0.35, 0.42, 0.7) * pow(max(m, 0.0), 220.0) * 0.6 + vec3(0.1, 0.13, 0.25) * pow(max(m, 0.0), 12.0) * 0.25;
            vec3 g = d * 340.0;
            float h = hash13(floor(g));
            if (h < 0.012 && d.y > 0.02) {
              float s = smoothstep(0.4, 0.0, length(fract(g) - 0.5));
              col += vec3(0.75, 0.8, 1.0) * s * (0.5 + 0.5 * sin(uTime * (1.0 + h * 40.0) + h * 300.0)) * 0.7;
            }
            return col;
          }
          void main() {
            vec3 d = normalize(vDir);
            if (uEstate > 0.999) { gl_FragColor = vec4(nightSky(d), 1.0); return; }
            vec3 col = voidColor(d);
            // far-off rooms: sparse warm specks, denser toward the abyss
            vec3 g = d * 260.0;
            vec3 cell = floor(g);
            float h = hash13(cell);
            float dens = mix(0.004, 0.02, smoothstep(0.2, -0.8, d.y));
            if (h < dens) {
              vec3 f = fract(g) - 0.5;
              float spark = smoothstep(0.42, 0.0, length(f));
              float tw = 0.6 + 0.4 * sin(uTime * (0.5 + h * 30.0) + h * 400.0);
              col += vec3(1.0, 0.42, 0.14) * spark * tw * 0.55;
            }
            gl_FragColor = vec4(mix(col, nightSky(d), uEstate), 1.0);
          }`,
      }),
    );
    sky.renderOrder = -10;
    sky.frustumCulled = false;
    this.sky = sky;
    scene.add(sky);

    // ── embers ──
    const rnd = mulberry32(99);
    const N = 1100;
    const pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = rnd() * 80;
      pos[i * 3 + 1] = rnd() * 80;
      pos[i * 3 + 2] = rnd() * 80;
      seed[i] = rnd();
    }
    const eg = new BufferGeometry();
    eg.setAttribute('position', new Float32BufferAttribute(pos, 3));
    eg.setAttribute('aSeed', new Float32BufferAttribute(seed, 1));
    this.embers = new Points(
      eg,
      new ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        vertexShader: /* glsl */ `
          uniform float uTime;
          uniform float uPixelRatio;
          attribute float aSeed;
          varying float vAlpha;
          varying float vSeed;
          const float BOX = 80.0;
          void main() {
            vec3 p = position + vec3(sin(uTime * 0.31 + aSeed * 40.0) * 1.4, uTime * (0.5 + aSeed * 0.9), cos(uTime * 0.27 + aSeed * 23.0) * 1.4);
            p = mod(p - cameraPosition + BOX * 0.5, BOX) - BOX * 0.5 + cameraPosition;
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            float d = -mv.z;
            gl_PointSize = clamp((2.2 + aSeed * 3.0) * uPixelRatio * 24.0 / max(d, 0.5), 0.0, 9.0 * uPixelRatio);
            float edge = 1.0 - smoothstep(BOX * 0.32, BOX * 0.5, length(p - cameraPosition));
            vAlpha = edge * (0.55 + 0.45 * sin(uTime * (1.0 + aSeed * 3.0) + aSeed * 90.0));
            vSeed = aSeed;
          }`,
        fragmentShader: /* glsl */ `
          uniform float uBiome;
          varying float vAlpha;
          varying float vSeed;
          void main() {
            vec2 c = gl_PointCoord - 0.5;
            float a = smoothstep(0.5, 0.0, length(c));
            vec3 col = mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.66, 0.3), vSeed);
            col = mix(col, mix(vec3(0.35, 0.7, 1.0), vec3(0.75, 0.9, 1.0), vSeed) * 0.75, uBiome); // embers → frost motes
            gl_FragColor = vec4(col * a * vAlpha * 1.6, 1.0);
          }`,
      }),
    );
    this.embers.frustumCulled = false;
    scene.add(this.embers);

    // ── freefall streaks ──
    const S = 420;
    const sp = new Float32Array(S * 2 * 3), se = new Float32Array(S * 2), ss = new Float32Array(S * 2);
    for (let i = 0; i < S; i++) {
      const x = rnd() * 50, y = rnd() * 50, z = rnd() * 50, s = rnd();
      for (let e = 0; e < 2; e++) {
        sp.set([x, y, z], (i * 2 + e) * 3);
        se[i * 2 + e] = e;
        ss[i * 2 + e] = s;
      }
    }
    const sg = new BufferGeometry();
    sg.setAttribute('position', new Float32BufferAttribute(sp, 3));
    sg.setAttribute('aEnd', new Float32BufferAttribute(se, 1));
    sg.setAttribute('aSeed', new Float32BufferAttribute(ss, 1));
    this.streaks = new LineSegments(
      sg,
      new ShaderMaterial({
        uniforms: this.uniforms,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        vertexShader: /* glsl */ `
          uniform float uFall;
          attribute float aEnd;
          attribute float aSeed;
          varying float vA;
          const float BOX = 50.0;
          void main() {
            vec3 p = mod(position - cameraPosition + BOX * 0.5, BOX) - BOX * 0.5 + cameraPosition;
            p.y += aEnd * (2.0 + aSeed * 5.0) * uFall;
            float r = length(p.xz - cameraPosition.xz);
            vA = uFall * smoothstep(1.5, 4.0, r) * (1.0 - smoothstep(16.0, 25.0, r)) * (0.4 + 0.6 * aSeed) * (1.0 - aEnd * 0.9);
            gl_Position = projectionMatrix * viewMatrix * vec4(p, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          varying float vA;
          void main() { gl_FragColor = vec4(vec3(1.0, 0.62, 0.42) * vA * 0.9, 1.0); }`,
      }),
    );
    this.streaks.frustumCulled = false;
    scene.add(this.streaks);

    // ── warm burst (pooled; one at a time) ──
    const B = 120;
    const bs = new Float32Array(B * 3);
    for (let i = 0; i < B; i++) bs.set([rnd(), rnd(), rnd()], i * 3);
    const bg = new BufferGeometry();
    bg.setAttribute('position', new Float32BufferAttribute(new Float32Array(B * 3), 3));
    bg.setAttribute('aRand', new Float32BufferAttribute(bs, 3));
    this.burstUniforms = { uPixelRatio: this.uniforms.uPixelRatio, uT: { value: 99 }, uLife: { value: 3.4 }, uCenter: { value: new Vector3() } };
    this.burstPoints = new Points(
      bg,
      new ShaderMaterial({
        uniforms: this.burstUniforms,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
        vertexShader: /* glsl */ `
          uniform float uT, uLife, uPixelRatio;
          uniform vec3 uCenter;
          attribute vec3 aRand;
          varying float vAlpha;
          varying float vSeed;
          void main() {
            float t = uT;
            float k = 1.0 - exp(-t * (1.6 + aRand.y * 1.5));           // ease out from the centre
            float ang = aRand.x * 6.2832 + t * (0.9 + aRand.z * 1.4);  // slow swirl
            float r = (0.04 + aRand.y * 0.3) * k;
            vec3 p = uCenter + vec3(cos(ang) * r, (aRand.z - 0.5) * 0.22 * k + t * (0.03 + aRand.x * 0.1), sin(ang) * r);
            vec4 mv = viewMatrix * vec4(p, 1.0);
            gl_Position = projectionMatrix * mv;
            gl_PointSize = clamp((1.0 + aRand.z * 1.8) * uPixelRatio * 22.0 / max(-mv.z, 0.4), 0.0, 14.0 * uPixelRatio);
            float life = clamp(t / uLife, 0.0, 1.0);
            vAlpha = smoothstep(0.0, 0.08, life) * (1.0 - smoothstep(0.45, 1.0, life)) * (0.6 + 0.4 * sin(t * (4.0 + aRand.x * 6.0) + aRand.y * 40.0));
            vSeed = aRand.z;
          }`,
        fragmentShader: /* glsl */ `
          varying float vAlpha;
          varying float vSeed;
          void main() {
            float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
            vec3 col = mix(vec3(1.0, 0.42, 0.16), vec3(1.0, 0.72, 0.5), vSeed);
            gl_FragColor = vec4(col * a * vAlpha * 2.4, 1.0); // > 1: blooms
          }`,
      }),
    );
    this.burstPoints.frustumCulled = false;
    this.burstPoints.visible = false;
    this.burstFollow = null;
    scene.add(this.burstPoints);
  }

  /** A brief warm glow of embers at `p` (a Vector3 it keeps following while it lasts). */
  burst(p) {
    this.burstFollow = p;
    this.burstUniforms.uCenter.value.copy(p);
    this.burstUniforms.uT.value = 0;
    this.burstPoints.visible = true;
  }

  set estate(v) {
    this.uniforms.uEstate.value = v;
    this.embers.visible = v < 0.5;
  }

  update(camera, fall, pixelRatio, dt = 0) {
    const bu = this.burstUniforms;
    if (this.burstPoints.visible) {
      bu.uT.value += dt;
      if (this.burstFollow) bu.uCenter.value.lerp(this.burstFollow, Math.min(1, dt * 6));
      if (bu.uT.value > bu.uLife.value) this.burstPoints.visible = false;
    }
    this.sky.position.copy(camera.position);
    this.uniforms.uFall.value = fall;
    this.uniforms.uPixelRatio.value = pixelRatio;
    this.streaks.visible = fall > 0.01;
  }
}
