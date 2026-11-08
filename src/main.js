import './styles.css';
import { ACESFilmicToneMapping, Clock, Color, HemisphereLight, PerspectiveCamera, PointLight, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
import Stats from 'three/examples/jsm/libs/stats.module.js';
import { ATMOSPHERE, CAMERA, CASTLE, COMPANION, OPENING, RENDER } from './config.js';
import { generateLayout } from './castle/layout.js';
import { buildBuckets } from './castle/buckets.js';
import { CastleMeshes } from './castle/CastleMeshes.js';
import { Collision } from './castle/Collision.js';
import { castleUniforms } from './castle/shaders.js';
import { Biped } from './player/Biped.js';
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
collision.setLayout(roomLayout(layout.period, estate)); // phase 1: just the room

/* ───────────── lights for the (toon-shaded) character ───────────── */
// The castle has no real lights (shader lighting); Tanjiro gets a dim warm
// ambient plus two point lights that jump to the two nearest paper lanterns.
scene.add(new HemisphereLight(0x8a4a30, 0x1a0606, 1.1));
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
controller.heading = controller.camYaw;
controller.locked = true; // the opening is a cinematic: look around, no walking
const kanao = new Biped(scene, KANAO);
const companion = new CompanionAI(kanao, controller.state, { ...COMPANION, collision });
controller.partner = companion.state; // plain data both ways: no module imports the other
companion.spawn(new Vector3(...COMPANION.spawn), controller.heading);
const atmosphere = new Atmosphere(scene);
atmosphere.estate = 1;
const crows = new Crows(scene, audio);
const post = new Post(renderer, scene, camera);
post.setSize(innerWidth, innerHeight, pixelRatio);

/* ───────────── touch controls (touch screens only) ───────────── */

let touch = null;
const canBiwa = () => phase === 'explore' && !biwa.active && controller.grounded && controller.interaction === 'none';
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
const biwa = new BiwaDrop({ controller, castle, collision, audio, onShift: shiftAll, seed: CASTLE.seed });

character.onStep = (speed) => audio.step(speed);
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
  castleUniforms.uHeroPos.value.set(p.x, p.y + 2.4, p.z);
  const near = phase === 'estate' || phase === 'gate' ? estateLamps(p) : castle.updateLamps(p);
  const lampsOn = phase === 'estate' || phase === 'gate' || !castle.busy; // castle lamps dim while it rearranges
  castleUniforms.uLampFade.value += ((lampsOn ? 1 : 0) - castleUniforms.uLampFade.value) * Math.min(1, dt * 4);
  for (let i = 0; i < lampLights.length; i++) {
    const l = near[i];
    if (l && lampsOn) {
      lampLights[i].position.set(l.x, l.y, l.z);
      // fade a lantern's light as anyone gets close, so no one stands in a blown-out hot spot
      const dT = lampLights[i].position.distanceTo(p);
      const dK = kanao.ready ? lampLights[i].position.distanceTo(companion.pos) : 99;
      const near2 = Math.min(1, (Math.min(dT, dK) / 3) ** 2);
      const target = 18 * near2 * castleUniforms.uLampFade.value;
      lampLights[i].intensity += (target - lampLights[i].intensity) * Math.min(1, dt * 6);
    } else lampLights[i].intensity *= 0.9;
  }
  tmp.set(Math.sin(controller.camYaw), 0, Math.cos(controller.camYaw));
  heroFill.position.set(p.x - tmp.x * 1.6, p.y + 2.3, p.z - tmp.z * 1.6);
  heroFill.color.setRGB(1, 0.62 - 0.4 * biwa.fx.flash, 0.38 - 0.25 * biwa.fx.flash);

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
  window.__castle = { scene, camera, renderer, post, controller, character, kanao, companion, estate, castle, collision, biwa, crows, music, audio };
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
