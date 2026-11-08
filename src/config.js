/**
 * ──────────────────────────────────────────────────────────────────────────
 *  Everything you're likely to want to tweak lives in this one file.
 * ──────────────────────────────────────────────────────────────────────────
 */

/**
 * The castle is one procedurally generated block of architecture that repeats
 * forever in x, y and z (a 3-torus). Every instance is wrapped to the copy
 * nearest the camera in the vertex shader, so the labyrinth is endless in all
 * six directions at zero CPU cost. Fog hides the seam long before it's visible.
 */
export const CASTLE = {
  seed: 1907, // change for a different castle
  // Big cells → sprawling contiguous decks (26–38 m) linked by wide bridges and stairs.
  cell: [44, 12, 44], // metres per generation cell (x, y, z); one 'storey' of the castle is 12 m
  cells: [6, 18, 6], // cells per period → period = cell × cells (264 × 216 × 264 m)
  deckSize: [26, 38], // upright deck width / depth range (m)
  emptyChance: 0.06, // cells left as void (open shafts you can see across)
  uprightChance: 0.72, // compounds with normal gravity (walkable); the rest are Escher-rotated
  linkChance: 0.97, // neighbouring decks joined by a bridge / stairs
  bridgeWidth: 3.6,
  stairWidth: 3.0,
  hallChance: 0.5, // open tatami halls on the big decks
  decorBeams: 110, // huge beams / stair flights crossing the void at impossible angles
  cullRadius: 150, // instances beyond this (fully fogged) are skipped in the vertex shader
  shojiBrightness: 0.7, // shoji window brightness multiplier (0.7 = the requested −30%)
};

/** Fog / void. Fog colour is pure black; emissive paper fades slower than wood. */
export const ATMOSPHERE = {
  background: '#020103',
  fogDensity: 0.0128, // exp² fog for wood (≈ 95% fogged at 135 m)
  glowFogDensity: 0.0092, // exp² fog for glowing shoji & lanterns (they read further away)
  abyssGlow: '#3a0a0c', // faint crimson haze deep below (the castle's heart)
};

/** Character. The GLB lives in the project root; Vite copies it on build. */
export const CHARACTER = {
  url: new URL('../tanjiro_arena_of_valor.glb', import.meta.url).href,
  height: 1.68, // metres; the model is auto-scaled to this
  hideWeapon: false, // true hides the Nichirin blade
  outline: 0.012, // ink outline thickness (world metres)
};

/** Kanao, the companion who follows Tanjiro (model copied from ../fireworks). */
export const COMPANION = {
  url: new URL('../kanao.glb', import.meta.url).href,
  height: 1.63,
  followDistance: 1.1, // metres of path she keeps behind him (right on his heels)
  personalSpace: 0.78, // never closer than this to him in a straight line (no clipping into his mesh)
  maxSpeed: 10.5, // a touch faster than his sprint, so she catches up
  spawn: [-1.7, 0, 0.7], // on the trapdoor beside him at the start
};

/** Third-person controller + physics. */
export const CONTROLLER = {
  walkSpeed: 4.2,
  runSpeed: 8.6, // Shift
  accel: 9, // how quickly speed builds toward the input direction (1/s)
  friction: 3.6, // how quickly he glides to a halt when keys are released (1/s) — lower = more inertia
  airControl: 0.3, // fraction of accel/friction available in the air
  turnRate: 12, // how quickly Tanjiro turns to face his heading (1/s)
  jumpSpeed: 6.4,
  jumpWindup: 0.11, // anticipation crouch before take-off (s)
  gravity: 24,
  terminalVelocity: 58,
  radius: 0.34, // capsule radius for wall collision
  bodyHeight: 1.6,
  stepHeight: 0.48, // tallest ledge he can step up (stairs are 0.3 m)
  voidCatchSeconds: 1.7, // airborne this long with nothing below → the castle catches him
};

export const CAMERA = {
  fov: 62,
  distance: 4.6,
  minDistance: 1.1,
  pivotHeight: 1.45, // pivot above his feet (shoulder height)
  shoulder: 0.42, // over-the-shoulder offset to the right
  pitch: 0.22, // initial pitch (radians, + looks down)
  minPitch: -0.95,
  maxPitch: 1.25,
  sensitivity: 0.0022,
  follow: 14, // pivot smoothing (1/s)
};

/**
 * Opening cinematic.
 *  Phase 1  Tanjiro stands in the moonlit courtyard of the estate (no castle).
 *  Phase 2  After `estateSeconds` (or the first click) the Biwa sounds and the ground vanishes.
 *  Phase 3  The castle assembles around him as he falls (blocks slide into place).
 *  Phase 4  He lands heavily on a deck; control returns.
 */
export const OPENING = {
  estateSeconds: 5,
  hold: 0.22, // the instant of suspension after the floor opens, before gravity takes him
  fallSeconds: 4.6, // cinematic plunge (the pad is placed exactly where it ends)
  terminal: 40, // m/s
};

/** The Biwa drop: Nakime's strum opens the floor and the castle rearranges. */
export const BIWA = {
  minSeconds: 20, // hidden timer: a sudden trap after a random time in [min, max] of exploring
  maxSeconds: 60,
  trapdoorSeconds: 0.16, // the floor under him splits open (immediate, jarring)
  morphStart: 0.45,
  morphSeconds: 4.2, // window in which every block slides to its new place (far below, violently)
  fallSeconds: 5.4, // deep scripted freefall before collision returns (pad is waiting below)
  terminal: 40, // m/s: reached after ~1.7 s, so ~3.7 s of the plunge is at terminal velocity
  // Optional: drop a real biwa sample here (e.g. '/biwa.mp3' in /public). null = synthesized strum.
  sampleUrl: null,
};

export const CROWS = {
  count: 150,
  speed: 13,
  maxForce: 9,
  neighbourRadius: 7,
  separation: 2.2,
  roamRadius: 70, // flocks circle within this distance of Tanjiro
  flybyEvery: [9, 22], // seconds between messenger crows swooping past the camera
};

export const RENDER = {
  maxPixelRatio: 1.5,
  minPixelRatio: 0.75,
  bloom: { strength: 0.595, radius: 0.55, threshold: 1.0 }, // strength = 0.85 × 0.7 (−30%)
  exposure: 0.95,
};

/**
 * Background music (YouTube IFrame API, hidden player, loops forever).
 * Paste any YouTube / YouTube Music URL. Starts on the first click (autoplay policy).
 * Click the bars in the bottom-right corner to mute / unmute.
 */
export const MUSIC = {
  url: 'https://www.youtube.com/watch?v=_q5wnUh0D5o',
  volume: 0.6, // 0..1
  startSeconds: 0, // where the loop restarts
};
