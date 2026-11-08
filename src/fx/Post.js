import { HalfFloatType, Vector2, WebGLRenderTarget } from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { RENDER } from '../config.js';

/**
 * HDR pipeline (same recipe as the fireworks project): the scene renders to a
 * half-float MSAA target so shoji paper and lanterns can be 2–5× brighter than
 * white; UnrealBloomPass with a threshold near 1.0 makes only those glow while
 * the wood stays crisp and dark; ACES tone mapping; then a grade pass with
 * vignette, film grain, the Biwa's red flash, chromatic aberration and a
 * radial speed blur during freefall.
 */
const FinalShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAberration: { value: 0 },
    uZoom: { value: 0 },
    uFlash: { value: 0 },
    uRes: { value: new Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAberration, uZoom, uFlash;
    uniform vec2 uRes;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    vec3 sampleCA(vec2 uv, vec2 off) {
      return vec3(texture2D(tDiffuse, uv + off).r, texture2D(tDiffuse, uv).g, texture2D(tDiffuse, uv - off).b);
    }
    void main() {
      vec2 c = vUv - 0.5;
      float r = length(c);
      vec2 off = c * (0.0025 + uAberration) * r * 2.0;
      vec3 col = sampleCA(vUv, off);
      if (uZoom > 0.001) {
        vec3 acc = col;
        for (int i = 1; i < 7; i++) {
          float k = float(i) / 6.0;
          acc += sampleCA(vUv - c * uZoom * 0.09 * k, off);
        }
        col = mix(col, acc / 7.0, smoothstep(0.08, 0.45, r));
      }
      // warm grade: lift the blacks toward ink-brown, keep highlights golden
      col = mix(col, col * vec3(1.04, 0.97, 0.9), 0.6);
      col *= mix(1.0, smoothstep(0.92, 0.18, r), 0.78);
      col += vec3(1.0, 0.12, 0.08) * uFlash * (0.35 + 0.65 * smoothstep(0.75, 0.0, r)) * 0.55;
      col += (hash(vUv * uRes + fract(uTime * 7.13) * 100.0) - 0.5) * 0.035;
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    const size = renderer.getDrawingBufferSize(new Vector2());
    const target = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, target);
    this.composer.addPass(new RenderPass(scene, camera));
    const b = RENDER.bloom;
    this.bloom = new UnrealBloomPass(new Vector2(size.x, size.y), b.strength, b.radius, b.threshold);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.baseBloom = b.strength;
  }

  setSize(w, h, pr) {
    // MSAA on a half-float target is expensive; at high pixel ratios it's barely visible
    const samples = pr > 1.3 ? 0 : 4;
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples !== samples) {
        rt.samples = samples;
        rt.dispose();
      }
    }
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.final.uniforms.uRes.value.set(w * pr, h * pr);
  }

  render(dt, time, fx) {
    const u = this.final.uniforms;
    u.uTime.value = time;
    u.uAberration.value = fx.aberration;
    u.uZoom.value = fx.zoom;
    u.uFlash.value = fx.flash;
    this.bloom.strength = this.baseBloom * (1 + fx.flash * 0.9);
    this.composer.render(dt);
  }
}
