# 無限城 · Infinity Castle

A third-person exploration of an endless, inescapable castle: wooden decks, stairs and shoji rooms wrapping around you in every direction, gravity turned sideways and upside down, a pitch-black void lit only by warm paper lanterns. Tanjiro explores sprawling 30 m decks, tatami halls, long bridges and steep stairways with Kanao right on his heels. Without warning the Biwa sounds, the floor under him splits open, and the whole castle rearranges itself during a long plunge through the dark.

Built with plain three.js (r186) and Vite, using the same HDR, bloom and cel-shading recipe as `../fireworks`.

## Run it

```bash
npm install
npm run dev        # http://localhost:5174
npm run build      # production build → dist/
```

Click the title to enter. Browsers only allow audio after a click, which is why the gate is there.

| Control | Action |
|---|---|
| W A S D | move (camera-relative) |
| Shift | run |
| Space | jump |
| K | a quiet moment with Kanao (she comes to him, they lean in; 3 s) |
| Mouse | look (pointer lock; drag to look also works) |
| Wheel | zoom |
| Esc | release the cursor |
| Music bars, bottom right | mute or unmute the background music |

### Touch screens (phones, tablets)

Touch devices (`'ontouchstart' in window || navigator.maxTouchPoints > 0`) get on-screen controls; on desktop the module isn't even downloaded, so there's no extra markup, CSS or listeners. Touch-screen laptops count as touch devices too, and get both schemes.

| Touch | Action |
|---|---|
| Left half | virtual joystick. It rests bottom-left and re-centres under your thumb; the knob follows it and everything glides home on release. Push to the rim to sprint; anything less is an analog walk. |
| Right half | drag to look (same yaw/pitch as the mouse; works with a thumb on the stick at the same time) |
| ↑ | jump |
| ♥ | the 'K' moment with Kanao |
| Biwa | spring the trap now (greyed out mid-fall or mid-moment) |

* **How it plugs in.** The joystick vector goes into `controller.stick`, which replaces WASD while held. The look drag calls `controller.look()`, the same path as the mouse.
* **No browser gestures.** Every touch handler is non-passive and calls `preventDefault()`, and pinch, double-tap zoom and scrolling are blocked.
* **Placement.** The controls fade in once the opening's landing hands over control. The buttons sit above the music bars, which stay tappable.
* **Rotation.** The canvas, camera aspect and post chain resize on `resize`, `orientationchange` and `visualViewport` resize.
* **Portrait.** The vertical FOV widens, up to 88°, so the horizontal view stays at least about 62°. A phone held upright would otherwise see a narrow slit.

URL flags: `?stats` shows an FPS meter. `?debug` lets **B** trigger the Biwa and exposes `window.__castle`, including `__castle.tick(n)` to step frames when the tab is throttled.

## How it flows

1. **The room (Ubuyashiki mansion).** Tanjiro and Kanao stand on the tatami in a shoji room. You can look around but not walk; this part is a cinematic.
2. **The Hashira drop.** After 5 s (or on your first click) the Biwa is strummed. The two floor panels under them sink a hand's breadth and slide apart under the surrounding floor, so the glowing castle is visible far below. They hang for a beat, then fall.
3. **The castle manifests.** During the 4.6 s plunge the camera swings overhead to look down the shaft. Blocks of the castle near the fall line slam into place around them from 35–105 m away.
4. **Exploration.** They land heavily on a deck, crouch into the landing, and control returns. A hidden random timer (20–60 s) then springs the trap at any moment, mid-sprint or not, and falling off an edge into the void does too. There is no exit.

## Where things live

```
index.html, src/styles.css     gate, letterbox, controls hint, music bars
src/config.js                  everything you might want to tweak (start here)
src/main.js                    renderer, the opening phases, lights, game loop
src/Estate.js                  the tatami room + sliding trapdoor (phase 1–2)
src/BiwaDrop.js                the strum → trapdoor → freefall → rearrange → land sequence
src/castle/
  layout.js                    procedural generator (pure data; also runs in a worker)
  layout.worker.js             builds the next castle off the main thread
  CastleMeshes.js              the 3 InstancedMeshes, trapdoor, morph, assembly
  shaders.js                   wood / tatami / shoji / lantern shaders, fog, lighting
  Collision.js                 spatial hash + Raycaster proxy + capsule push-out
  buckets.js                   the collision spatial hash as flat arrays (built in the worker)
src/player/
  Controller.js                third-person controller (input, physics, camera); exports `state`
  Biped.js                     GLB loading, looks, procedural biped animation, cloth springs
  profiles.js                  Tanjiro and Kanao: bone maps, materials, cloth chains
  CompanionAI.js               Kanao's path-following
  kanao/                       painted-look code ported 1:1 from ../fireworks
src/input/TouchControls.js     joystick, look zone and buttons; loaded only on touch screens
src/fx/                        crows (boids), atmosphere (void, embers, speed streaks), post
src/audio/                     synthesized SFX (biwa strum, steps, caws, wind), YouTube BGM
tanjiro_arena_of_valor.glb     Tanjiro (also in ../fireworks as tanjiro.glb)
kanao.glb                      Kanao, copied from ../fireworks/public/models (fireworks is untouched)
```

## The castle

* **Generation (`layout.js`).** The world is one 264 × 216 × 264 m block of 6 × 18 × 6 big cells (44 × 12 × 44 m), repeated forever in x, y and z. About 72% of cells are "upright": a sprawling 26–38 m wooden deck with an open tatami hall (pillars, big roof, shoji walls on a side or two, lanterns inside), up to six shoji houses, railings with lanterns, an optional balcony with stairs, and sometimes an upside-down room hanging underneath. Deck heights in a layer snap to a few levels, so most neighbours join with wide (3.6 m) flat bridges, some roofed like the long covered bridge in the blueprint; the rest, and the layers above, are joined by steep 3 m staircases. About 440 decks per period, and ~99% of them form one connected network (the landing deck always in it), so you can sprint for as long as you like. The remaining cells hold smaller compounds rotated 90°/180°, in the spirit of Escher's *Relativity*, and ~110 giant beams and stair flights cross the void at impossible 30–60° angles.
* **What you see is what you stand on.** Every rotation inside a compound is a multiple of 90°, so every collidable part has an exact box. You can walk on the side of a sideways house.
* **Walkways stay open.** Bridges, stairs and decks reserve head-room volumes. Decoration that would cut into another owner's walkway is dropped, and houses are placed whole or not at all.
* **Rendering.** About 90k instances are drawn in 3 draw calls (wood, shoji houses, lanterns). The vertex shader draws each instance's copy nearest the camera, which is what makes the castle endless at no CPU cost. It also skips anything past the fog (150 m; the fog is thinner than before so the castle stretches further into the dark) and thin pieces too small to matter.
* **Look.** Procedural plank grain, tatami weave, and pen-and-ink box edges taken from the blueprint drawing. The shoji have lattice paper lit from inside (HDR, so it blooms), occasional silhouettes behind the paper, and far shoji average into a soft glow. Lighting comes from the 8 nearest lanterns, a warm ambient field, and a faint crimson haze rising from the abyss below.
* **Bloom.** `UnrealBloomPass` runs on a half-float target with a threshold of 1.0, so only paper and lanterns glow. Strength 0.595 and shoji brightness 0.7 are both 30% below the first version (`RENDER.bloom`, `CASTLE.shojiBrightness`). ACES tone mapping, then a grade pass with vignette, grain, chromatic aberration, a red strum flash and a radial speed blur in freefall.

## Characters

* **Tanjiro.** The GLB's textures are kept and rendered with a 3-step toon ramp, a generated ink outline (inverted hull that follows the skin), and a warm rim light. The file ships only an idle clip ("Idleshow"); everything else is procedural.
* **Kanao (companion).** Her "painted" look is ported directly from `../fireworks`: `modelStyle.js` recolours each material, her built-in LINES ink shells are drawn back-faces-only, `faceDetail.js` paints a lilac anime iris with catch-lights plus a blush and soft smile that follow her cheek and mouth bones, and the smile bone offsets are applied at load. Her sword and sheath are hidden, as in fireworks.
* **Facing.** Each model is turned so its face looks along the character's forward, measured from the face mesh's skinned normals. (Bone directions are unreliable: Tanjiro's toe bone sits behind his ankle, which once had him facing the camera and running backward, with every procedural bend mirrored.)
* **Procedural biped (`Biped.js`, both characters).** Bones are rotated about character-space axes, so the same code drives Tanjiro's `Bip001` rig and Kanao's `C_Hips` / `L_Thigh` rig. Order each frame: bones reset to bind pose → `mixer.update()` → the procedural layer, applied last. The legs are procedural only: their tracks are stripped from the idle clip, so it can never stiffen the knees.
  * **Run.** The thigh swings with sin(φ), with the right leg offset by π. Each knee flexes on the backswing (a peak just after toe-off), so the heel kicks up behind instead of a straight leg swinging like a pendulum. Arm swing, elbow bend, forward lean, hip and shoulder counter-twist, and a bob complete the cycle.
  * **Jump.** First, anticipation: a 0.11 s crouch into the knees before any upward velocity. Then mid-air, with knees tucked up (one higher than the other).
  * **Landing.** The impact feeds a damped spring that sinks deep into the knees and springs back; heavy landings hold the crouch for a moment.
  * Knees are clamped to 0–135° so they never bend backward. Pose blends use `THREE.MathUtils.lerp` with frame-rate independent damping.
* **The 'K' moment.** Lean-in weights ease in and out like the landing blends (never snapping): torso lean through both spine bones, neck, a head pitch (he looks down, she looks up) and a tilt to each one's own right, so their heads interleave; she rises onto her toes and draws her hands in.
* **Cloth.** Underdamped spring-dampers on Tanjiro's haori hem, sleeves and hair, and on Kanao's capelet, skirt, side ponytail and hair. They are driven by acceleration in character space: the cloth lags when a character sets off, swings forward when they brake, then settles. In freefall it's blown up and flutters.
* **Inertia.** Speed builds with `accel` and glides to a stop under `friction` (`CONTROLLER` in config).

### Kanao's follower AI (`CompanionAI.js`)

* **Breadcrumbs.** Every node of the path queue is a full snapshot of Tanjiro: `{ position, rotation (quaternion), state: 'grounded' | 'jumping' | 'falling', speed, windup }`. Grounded crumbs are dropped every 12 cm; airborne ones every frame, so a sprint-jump arc is never thinned out. She samples the queue with a Catmull-Rom spline, so the arc stays round even when frames are far apart.
* **Distance.** She keeps 1.1 m of path behind him. Her speed is his speed plus a pull proportional to the gap, so she stays on his heels even in a sprint. She never comes closer than 0.78 m in a straight line: if he turns back into her, she eases aside, unless that would put her off an edge.
* **Jumps and stairs.** On grounded crumbs her own floor `Raycaster` is live and snaps her onto the step under her feet. On jumping or falling crumbs the ray is off and she rides his exact XYZ arc, at no less than the speed he flew it, so she never hangs mid-air or snags a platform edge, even if he stopped right after landing.
* **Facing.** While moving she faces her velocity. When she stops, she turns to face the same way he does.
* **Biwa drops.** She falls beside him through the same opening, lands next to him, and the queue restarts.
* **The 'K' moment.** The controller runs a small state machine: approach → kiss → release. During approach she overrides her follow distance and walks straight to the spot 0.6 m in front of him. Both turn to face each other and the camera eases round to frame them from the side. When she reports `arrived` they lean in for 3 s while a warm burst of embers blooms between them at head height, with a soft chime. Then they ease back to neutral, her distance returns to 1.1 m and control comes back. WASD and jumping are off throughout, and the Biwa timer waits.
* **No circular imports.** She reads only `controller.state`, a plain object (position, velocity, rotation, heading, grounded, motion, scripted, windup, speed, interaction, faceHeading). The controller reads only her plain `state` (position, arrived). Neither module imports the other.

## Collision

The floor is found with a `THREE.Raycaster` pointing straight down from Tanjiro's origin, raised by the step height so stairs (0.3 m risers) can be climbed. The ray grows with fall speed so fast falls never pass through a floor. It isn't cast against the whole castle, which would be slow: a spatial hash finds the boxes near him and copies them into a small proxy `InstancedMesh` each frame, and the ray is cast against that. Walls use capsule-vs-box push-out on the same set. The camera casts a second ray so the lens never ends up inside a wall.

## The Biwa drop (a sudden trap)

The strum is synthesized: a Karplus-Strong rake across four strings tuned like a biwa (B-E-F#-B), with the instrument's buzzing *sawari* bridge and a plectrum slap, in a long hall reverb. Set `BIWA.sampleUrl` to use a real recording instead. A hidden timer fires it after 20–60 s of exploring, the instant it runs out, mid-sprint or not. Then:

1. **The trapdoor.** The exact floor instance under him (the 30 m deck, the tatami floor, the bridge) is found in the instance buffer and cut. It's swapped for rim pieces around a 4.4 m opening, and two panels snap apart under the rim in 0.16 s. A bridge too narrow to cut slides away whole. His ground collision is gone in the same frame.
2. **The plunge.** He and Kanao fall about 5.4 s and 180 m down a clear shaft, reaching terminal velocity (40 m/s) after 1.7 s, with speed streaks, radial blur and the camera looking down past them.
3. **The rearrangement.** A worker generates a new castle with a landing deck exactly where the fall ends. Every block within view slides to its new place, one axis at a time like the castle's sliding rooms, in waves spreading from him; the rest snap into place.
4. **The landing.** Collision returns and they smash down onto the new deck.

Coordinates are then shifted back near the origin by whole periods; since the castle repeats, the shift can't be seen.

**No stalls mid-fall.**
* The worker also builds the collision broad phase as flat arrays, so the commit costs nothing.
* The pairing of old and new blocks uses an O(n) counting sort, planned a few milliseconds per frame.
* Its buffers are pooled, so there are no garbage-collection pauses.
* The worker is warmed up at load.
* After a warm-up drop, a drop measures about 4 ms per frame on average and 8 ms at worst.

## Kasugai crows

150 crows fly as a boids flock (separation, alignment, cohesion) around three roosts that circle Tanjiro. Every 9–22 s a few messenger crows swoop right past the camera and caw. The crows are low-poly black geometry with a warm rim light, wing flaps run in the vertex shader, and all of them are one instanced draw call.

## Music

The background track is played by a hidden YouTube IFrame player and loops forever (`MUSIC.url` in config). It starts on the first click, and if the browser still blocks it, the next click retries. The player is kept rendered but invisible (opacity ≈ 0, behind the canvas) rather than 0×0 or `display:none`, because some browsers refuse or pause playback otherwise. The five bars in the bottom-right corner animate while it plays; click them to mute and they flatten.

## Performance

Measured on an Apple M4 (the second figure set is after the castle expansion, in an 800×975-pixel pane):
* CPU: about 4–6 ms per frame for the whole loop, including both characters and about 200 spring-driven bones. The cloth pass caches world rotations: 0.2–0.3 ms.
* GPU: about 59 fps at a 1.5× pixel ratio with the 150 m view (60 with the old 118 m).
* The opening drop holds about 60 fps.

How the expensive parts stay cheap:
* **No hitch at the strum.** The opening castle is generated, its collision hash built, uploaded, assembled and its shaders compiled behind the loading screen. While it's hidden, its instances are culled in the shader rather than with `mesh.visible`, so the 5 MB instance upload has already happened before the drop.
* **Adaptive resolution.** The pixel ratio drops if the frame rate sags. Hidden or throttled tabs are ignored, so a background tab doesn't wrongly downgrade it.
* **No MSAA at high pixel ratios.**

## Notes

* Tanjiro's GLB has no run animation, so his run, jump, landing and fall are procedural, layered on the biped skeleton. If you add a clip whose name contains "run", it plays automatically and blends in.
* Kanao's GLB has no animations at all and is in a T-pose. The procedural layer lowers her arms and gives her a breathing idle.
