import './styles.css';
import { ACESFilmicToneMapping, Clock, Color, HemisphereLight, PerspectiveCamera, PointLight, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { ATMOSPHERE, CAMERA, CASTLE, COMPANION, OPENING, POND, RENDER } from './config.js';
import { generateLayout } from './castle/layout.js';
import { buildBuckets } from './castle/buckets.js';
import { CastleMeshes, lampColor } from './castle/CastleMeshes.js';
import { LotusPonds } from './castle/LotusPond.js';
import { IceBuddha } from './castle/IceBuddha.js';
import { Collision } from './castle/Collision.js';
import { castleUniforms } from './castle/shaders.js';
import { Biped, rimUniform } from './player/Biped.js';
import { KANAO, TANJIRO } from './player/profiles.js';
import { CompanionAI } from './player/CompanionAI.js';
import { Controller } from './player/Controller.js';
import { Crows } from './fx/Crows.js';
import { Atmosphere } from './fx/Atmosphere.js';
import { Post } from './fx/Post.js';
import { AudioEngine } from './audio/AudioEngine.js';
import { Music } from './audio/Music.js';
import { BiwaDrop, fallDistance } from './BiwaDrop.js';
import { Estate, ROOM_RESERVE, roomLayout } from './Estate.js';

const params = new URLSearchParams(location.search);
const DEBUG = params.has('debug');
// Touch screens get on-screen controls (loaded on demand); desktop gets none.
const TOUCH = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

/* ───────────── renderer / scene ───────────── */

const renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = RENDER.exposure;
let pixelRatio = Math.min(RENDER.maxPixelRatio, window.devicePixelRatio || 1);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.domElement.className = 'scene';
document.getElementById('app').appendChild(renderer.domElement);

const scene = new Scene();
scene.background = new Color(ATMOSPHERE.background);
const camera = new PerspectiveCamera(CAMERA.fov, innerWidth / innerHeight, 0.08, 600);

/* ───────────── castle ───────────── */

// The castle is generated, uploaded and its shaders compiled behind the loading
// screen, with a landing pad exactly where the opening plunge will end — so
// nothing heavy happens mid-fall.
const SPAWN = new Vector3(0, 0, 0);
const FALL = fallDistance(OPENING.fallSeconds, 0, OPENING.terminal);
const PAD = [SPAWN.x, SPAWN.y - FALL - 2.4, SPAWN.z];
const layout = generateLayout({ seed: CASTLE.seed, anchor: PAD, shaftHeight: FALL + 14, reserve: [ROOM_RESERVE] });
layout.buckets = buildBuckets(layout.period, layout.colliders, layout.colliderCount); // ready before the landing
const castle = new CastleMeshes(scene, layout);
const collision = new Collision();
const estate = new Estate(scene); // the tatami room of the opening
const ponds = new LotusPonds(scene, renderer, { low: TOUCH }); // Doma's water + ice lotuses (the hall itself is castle geometry)
ponds.setLayout(layout);
const buddha = new IceBuddha(ponds); // Renge Bodhisattva at the back of the water + the Icicle Breath
collision.setLayout(roomLayout(layout.period, estate)); // phase 1: just the room

/* ───────────── lights for the (toon-shaded) character ───────────── */
// The castle has no real lights (shader lighting); Tanjiro gets a dim warm
// ambient plus two point lights that jump to the two nearest paper lanterns.
const hemi = new HemisphereLight(0x8a4a30, 0x1a0606, 1.1);
scene.add(hemi);
const lampLights = [new PointLight(0xff7a3a, 0, 16, 1.6), new PointLight(0xff7a3a, 0, 16, 1.6)];
lampLights.forEach((l) => scene.add(l));
const heroFill = new PointLight(0xffa060, 4, 9, 1.4);
scene.add(heroFill);

/* ───────────── everything else ───────────── */

const audio = new AudioEngine();
const music = new Music();
const character = new Biped(scene, TANJIRO);
const controller = new Controller(camera, renderer.domElement, character, collision);
controller.spawn(SPAWN);
controller.water = ponds; // wading in the Lotus Pond: ripples at his feet
controller.heading = controller.camYaw;
controller.locked = true; // the opening is a cinematic: look around, no walking
const kanao = new Biped(scene, KANAO);
const companion = new CompanionAI(kanao, controller.state, { ...COMPANION, collision });
controller.partner = companion.state; // plain data both ways: no module imports the other
ponds.actors = [controller.pos, companion.pos]; // the mist parts around their legs
companion.spawn(new Vector3(...COMPANION.spawn), controller.heading);
const atmosphere = new Atmosphere(scene);
atmosphere.estate = 1;
const crows = new Crows(scene, audio);
const post = new Post(renderer, scene, camera);
post.setSize(innerWidth, innerHeight, pixelRatio);

/* ───────────── touch controls (touch screens only) ───────────── */

let touch = null;
const canBiwa = () => phase === 'explore' && !biwa.active && !biwa.safe && controller.grounded && controller.interaction === 'none';
if (TOUCH) {
  import('./input/TouchControls.js').then(({ TouchControls }) => {
    touch = new TouchControls(controller, { onBiwa: () => canBiwa() && biwa.trigger('strum') });
    touch.visible = phase === 'explore';
  });
  // touch hints instead of keyboard ones
  document.getElementById('hint').innerHTML =
    '<span><b>Left thumb</b> move · push to the rim to run</span><span><b>Right side</b> drag to look</span><span><b>Buttons</b> jump · Kanao · Biwa</span>';
}

const shiftAll = (dx, dy, dz) => {
  controller.shift(dx, dy, dz);
  companion.shift(dx, dy, dz);
  crows.shift(dx, dy, dz);
};
const biwa = new BiwaDrop({ controller, castle, collision, audio, onShift: shiftAll, seed: CASTLE.seed, onCommit: (next) => ponds.setLayout(next) });

character.onStep = (speed) => {
  if (!controller.wading) audio.step(speed); // in the pond the strides splash instead (controller.onSplash)
};
controller.onSplash = (s) => audio.splash(s);
controller.onLand = (v) => {
  if (v > 7) audio.thud(Math.min(1, v / 40));
  if (v > 14) controller.fx.shake = Math.max(controller.fx.shake, Math.min(1.8, v / 25));
};
controller.onVoid = () => biwa.trigger('catch'); // there is no bottom: the castle catches you
// the 'K' moment: a warm glow of embers between them, at head height
const kissPoint = new Vector3();
function updateKissPoint() {
  const a = controller.pos, b = companion.pos;
  kissPoint.set((a.x + b.x) / 2, Math.max(a.y, b.y) + 1.42, (a.z + b.z) / 2);
}
controller.onKiss = () => {
  updateKissPoint();
  atmosphere.burst(kissPoint);
  audio.chime?.();
};

/* ───────────── opening: gate → estate → Biwa drop → castle ───────────── */

const gate = document.getElementById('gate');
const bar = document.getElementById('gate-bar');
const prompt = document.getElementById('gate-prompt');
const letterbox = document.getElementById('letterbox');
let entered = false;
let phase = 'gate'; // gate → estate → drop → explore
let phaseT = 0;

function startEstate() {
  phase = 'estate';
  phaseT = 0;
  castle.visible = false; // the castle must not exist yet
  estate.visible = true;
  atmosphere.estate = 1;
}

function drop() {
  if (phase !== 'estate') return;
  phase = 'drop';
  phaseT = 0;
  // the floor beneath them splits and slides apart; the castle is waiting below
  estate.openTrapdoor();
  controller.camCollide = true; // the lens stays under the room's ceiling, looking down the gap
  atmosphere.estate = 0;
  castle.visible = true;
  letterbox.classList.add('letterbox--on');
  biwa.trigger('intro', {
    layout,
    anchor: PAD,
    hold: OPENING.hold,
    fallSeconds: OPENING.fallSeconds,
    terminal: OPENING.terminal,
    onLanded: () => {
      phase = 'explore';
      controller.locked = false; // control returns
      if (touch) touch.visible = true;
      biwa.armed = true; // the hidden timer starts now
      letterbox.classList.remove('letterbox--on');
      const hint = document.getElementById('hint');
      hint.classList.add('hint--on');
      setTimeout(() => hint.classList.add('hint--fade'), 9000);
    },
  });
}
renderer.domElement.addEventListener('pointerdown', () => {
  if (phase === 'estate' && phaseT > 0.8) drop();
});
// both models load in parallel; the bar tracks the pair
const progress = [0, 0];
const showProgress = () => (bar.style.transform = `scaleX(${((progress[0] + progress[1]) / 2).toFixed(3)})`);
Promise.all([
  character.load((p) => ((progress[0] = p), showProgress())),
  kanao.load((p) => ((progress[1] = p), showProgress())).catch((err) => console.warn('[kanao] failed to load — continuing without her', err)),
])
  .then(() => {
    // Pre-fling every castle block now, behind the gate, while the castle is
    // hidden: the drop itself then costs nothing but a visibility flip.
    castle.assemble(SPAWN, PAD, CASTLE.seed + 1, OPENING.fallSeconds - 0.7);
    ponds.warm(renderer, camera); // compile the water + both lotus looks now, not on first sight
    buddha.warm(renderer, scene, camera); // and both looks of the ice Buddha
    bar.style.transform = 'scaleX(1)';
    gate.classList.add('gate--ready');
    prompt.textContent = TOUCH ? 'Tap to enter' : 'Click to enter';
  })
  .catch((err) => {
    console.error('[character] failed to load', err);
    prompt.textContent = 'Could not load Tanjiro — click to enter anyway';
    gate.classList.add('gate--ready');
  });

function enter() {
  if (entered || !gate.classList.contains('gate--ready')) return;
  entered = true;
  audio.unlock(); // user gesture: audio may start now
  music.play();
  controller.enabled = true;
  renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
  gate.classList.add('gate--leaving');
  setTimeout(() => gate.remove(), 2200);
  startEstate();
}
gate.addEventListener('click', enter);
window.addEventListener('keydown', (e) => {
  if (!entered && (e.code === 'Enter' || e.code === 'Space')) enter();
  if (DEBUG && e.code === 'KeyP' && phase === 'explore') window.__castle.toPond();
  if (DEBUG && e.code === 'KeyB') {
    if (phase === 'estate') drop();
    else if (phase === 'explore') biwa.trigger('strum');
  }
});

/* ───────────── resize + adaptive resolution ───────────── */

function resize() {
  const w = innerWidth, h = innerHeight;
  if (!w || !h) return; // hidden / collapsed (a 0×0 size would poison the FOV with NaN)
  camera.aspect = w / h;
  // Portrait phones: widen the vertical FOV so the horizontal view stays ≥ ~62°
  // (a plain 62° vertical FOV would leave a ~30° keyhole at 9:19.5).
  const minH = (62 * Math.PI) / 180;
  const vForH = (2 * Math.atan(Math.tan(minH / 2) / camera.aspect) * 180) / Math.PI;
  controller.fovBase = Math.min(88, Math.max(CAMERA.fov, vForH));
  camera.updateProjectionMatrix();
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h);
  post.setSize(w, h, pixelRatio);
}
addEventListener('resize', resize);
// rotation: some mobile browsers report the new size a beat after the event
addEventListener('orientationchange', () => {
  resize();
  setTimeout(resize, 300);
});
window.visualViewport?.addEventListener('resize', resize);
resize();

let perfT = 0, perfFrames = 0, goodStreak = 0;
function adapt(dt, rawDt) {
  // a hidden / throttled tab says nothing about GPU load: start the window over
  if (document.hidden || rawDt > 0.2) {
    perfT = 0;
    perfFrames = 0;
    return;
  }
  perfT += dt;
  perfFrames++;
  if (perfT < 1.5) return;
  const fps = perfFrames / perfT;
  perfT = 0;
  perfFrames = 0;
  if (biwa.active) return; // judge on normal frames only
  if (fps < 48 && pixelRatio <= RENDER.minPixelRatio && !ponds.low) {
    ponds.low = true; // still struggling at the lowest resolution: drop the ice's transmission for good
    console.info('[pond] low frame rate: ice falls back to the cheaper material');
  }
  if (fps < 48 && pixelRatio > RENDER.minPixelRatio) {
    pixelRatio = Math.max(RENDER.minPixelRatio, pixelRatio - 0.25);
    goodStreak = 0;
    resize();
  } else if (fps > 58) {
    if (++goodStreak > 4 && pixelRatio < Math.min(RENDER.maxPixelRatio, devicePixelRatio || 1)) {
      pixelRatio = Math.min(RENDER.maxPixelRatio, pixelRatio + 0.25);
      goodStreak = 0;
      resize();
    }
  }
}

let stats = null;
if (params.has('stats')) {
  stats = new Stats();
  document.body.appendChild(stats.dom);
}

/* ───────────── loop ───────────── */

/** Phase 1: the room's paper andon lamps light it (same shader path as the castle). */
function estateLamps(p) {
  const list = estate.lamps.map((l) => ({ x: l.x, y: l.y, z: l.z, d2: l.distanceToSquared(p), id: 0 })).sort((a, b) => a.d2 - b.d2);
  const pos = castleUniforms.uLampPos.value, col = castleUniforms.uLampCol.value;
  for (let i = 0; i < pos.length; i++) {
    const l = list[i];
    if (l) {
      pos[i].set(l.x, l.y, l.z);
      col[i].set(1.0, 0.42, 0.14).multiplyScalar(2.0);
    } else {
      pos[i].set(0, -1e5, 0);
      col[i].set(0, 0, 0);
    }
  }
  return list;
}

/* ───────────── biome: the warm castle ↔ Doma's freezing hall ───────────── */
// Stepping into a Lotus Pond's hall lerps every light over POND.transitionSeconds:
// ambient (hemisphere + the shader's ambient field), the lantern point lights,
// the hero fill, the characters' rim light, the abyss haze, the bloom tint and
// the colour grade. Leaving lerps it all back.
const WARM = { sky: new Color(0x8a4a30), ground: new Color(0x1a0606), abyss: new Color(ATMOSPHERE.abyssGlow), hero: new Vector3(0.5, 0.21, 0.08), fill: new Color(1, 0.62, 0.38) };
const COLD = { sky: new Color(0x2c5878), ground: new Color(0x04101a), abyss: new Color(0x04162a), hero: new Vector3(0.1, 0.27, 0.48), fill: new Color(0.5, 0.78, 1.0), rim: new Color(0.42, 0.78, 1.0) };
let biome = 0; // 0..1, linear in time
let biomeK = 0; // eased
const _lc = new Vector3();
function updateBiome(dt, p) {
  const target = phase === 'explore' && ponds.inside(p) >= 0 ? 1 : 0;
  biome += clampAbs(target - biome, dt / POND.transitionSeconds);
  biomeK = biome * biome * (3 - 2 * biome);
  const k = biomeK;
  castleUniforms.uBiome.value = k;
  castleUniforms.uAbyss.value.copy(WARM.abyss).lerp(COLD.abyss, k);
  castleUniforms.uHeroLight.value.lerpVectors(WARM.hero, COLD.hero, k);
  hemi.color.copy(WARM.sky).lerp(COLD.sky, k);
  hemi.groundColor.copy(WARM.ground).lerp(COLD.ground, k);
  rimUniform.value.lerp(COLD.rim, k); // (the Biwa sets the warm rim each frame)
  post.setBiome(k);
  castleUniforms.uIceFog.value = POND.iceFog * k; // frost haze only inside the hall
}
const clampAbs = (v, m) => Math.max(-m, Math.min(m, v));

// Kanao wades too: rings at her feet (her speed from her motion)
const kanaoPrev = new Vector3();
let kanaoRippleT = 0;
function kanaoWade(dt) {
  const q = companion.pos;
  const sp = kanaoPrev.distanceTo(q) / Math.max(dt, 1e-3);
  kanaoPrev.copy(q);
  const lvl = ponds.level(q);
  if (lvl === null || lvl <= q.y + 0.02 || sp > 30) return;
  kanaoRippleT -= dt;
  if (kanaoRippleT > 0) return;
  const moving = sp > 0.4;
  kanaoRippleT = moving ? Math.min(0.42, Math.max(0.18, 1.6 / (sp + 2))) : 1.6;
  ponds.ripple(q.x, q.z, moving ? Math.min(0.7, 0.28 + sp * 0.05) : 0.14);
}

const clock = new Clock();
let time = 0;
const tmp = new Vector3();

function frame() {
  const rawDt = clock.getDelta();
  if (DEBUG && window.__castle?.frozen) post.render(0, time, biwa.fx); // debug: hold the frame still
  else step(Math.min(rawDt, 1 / 20), rawDt);
  requestAnimationFrame(frame);
}

function step(dt, rawDt) {
  time += dt;
  castleUniforms.uTime.value = time;

  if (phase === 'estate') {
    phaseT += dt;
    if (phaseT > OPENING.estateSeconds) drop();
  } else if (phase === 'drop') {
    phaseT += dt;
    if (phaseT > 1.1) controller.camCollide = false;
    if (phaseT > 1.6 && estate.visible) estate.visible = false; // the room is far above now
  }
  estate.update(dt);
  biwa.update(dt);
  controller.update(dt);
  if (kanao.ready) companion.update(dt);

  // lights follow Tanjiro and the lanterns around him
  const p = controller.pos;
  updateBiome(dt, p);
  biwa.safe = phase === 'explore' && ponds.inside(p) >= 0; // Doma's hall: the Biwa timer holds
  ponds.update(dt, camera, biwa.active || !castle.visible); // the water drains the instant the Biwa sounds
  if (kanao.ready) kanaoWade(dt);
  buddha.update(dt, camera, controller, audio, time); // its 15 s loop only runs while he's near a hall
  castleUniforms.uHeroPos.value.set(p.x, p.y + 2.4, p.z);
  const near = phase === 'estate' || phase === 'gate' ? estateLamps(p) : castle.updateLamps(p);
  const lampsOn = phase === 'estate' || phase === 'gate' || !castle.busy; // castle lamps dim while it rearranges
  castleUniforms.uLampFade.value += ((lampsOn ? 1 : 0) - castleUniforms.uLampFade.value) * Math.min(1, dt * 4);
  for (let i = 0; i < lampLights.length; i++) {
    const l = near[i];
    if (l && lampsOn) {
      lampLights[i].position.set(l.x, l.y, l.z);
      const c = lampColor(l.cold, biomeK * 0.55, _lc);
      const m = Math.max(c.x, c.y, c.z);
      lampLights[i].color.setRGB(c.x / m, c.y / m, c.z / m);
      // fade a lantern's light as anyone gets close, so no one stands in a blown-out hot spot
      const dT = lampLights[i].position.distanceTo(p);
      const dK = kanao.ready ? lampLights[i].position.distanceTo(companion.pos) : 99;
      const near2 = Math.min(1, (Math.min(dT, dK) / 3) ** 2);
      const target = (l.cold ? 5 : 18) * near2 * castleUniforms.uLampFade.value; // the lotus glows are a soft wash
      lampLights[i].intensity += (target - lampLights[i].intensity) * Math.min(1, dt * 6);
    } else lampLights[i].intensity *= 0.9;
  }
  tmp.set(Math.sin(controller.camYaw), 0, Math.cos(controller.camYaw));
  heroFill.position.set(p.x - tmp.x * 1.6, p.y + 2.3, p.z - tmp.z * 1.6);
  heroFill.color.copy(WARM.fill).lerp(COLD.fill, biomeK);
  heroFill.color.g -= 0.4 * biwa.fx.flash;
  heroFill.color.b -= 0.25 * biwa.fx.flash;

  if (touch) touch.biwaReady = canBiwa();
  crows.update(dt, p, camera, time);
  updateKissPoint();
  atmosphere.update(camera, biwa.fx.fall, pixelRatio, dt);
  post.render(dt, time, biwa.fx);
  adapt(dt, rawDt);
  stats?.update();
}
requestAnimationFrame(frame);

// handy for debugging from the console
if (DEBUG) {
  window.__castle = { scene, camera, renderer, post, controller, character, kanao, companion, estate, castle, collision, biwa, crows, music, audio, ponds, buddha };
  // jump to the nearest Lotus Pond (on its engawa, facing the bridge); also the P key
  window.__castle.toPond = () => {
    const n = ponds.nearest(controller.pos);
    if (!n) return null;
    const { center, pond } = n;
    const at = new Vector3(center.x - pond.size / 2 + pond.engawa / 2, center.y + 0.05, center.z + 4);
    controller.pos.copy(at);
    controller.vel.set(0, 0, 0);
    controller.heading = controller.camYaw = Math.PI / 2; // facing +x, across the water
    companion.spawn(at.clone().add(new Vector3(0, 0, 1.2)), controller.heading);
    return center;
  };
  window.__castle.biome = () => biomeK;
  // run n frames synchronously (testing when the tab is throttled); returns the phase
  window.__castle.tick = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) step(dt, dt);
    return phase;
  };
  window.__castle.setPixelRatio = (p) => {
    pixelRatio = p;
    resize();
  };
}
