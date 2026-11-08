import { BufferGeometry, DoubleSide, Float32BufferAttribute, InstancedBufferAttribute, InstancedMesh, Matrix4, Quaternion, ShaderMaterial, Vector3 } from 'three';
import { CROWS } from '../config.js';
import { castleUniforms, GLSL_COMMON } from '../castle/shaders.js';
import { mulberry32 } from '../utils/math.js';

/** Low-poly crow: diamond body, fanned tail, two-segment wings (aWing = flap weight). */
function crowGeometry() {
  const pos = [];
  const wing = [];
  const tri = (a, b, c, wa = 0, wb = 0, wc = 0) => {
    pos.push(...a, ...b, ...c);
    wing.push(wa, wb, wc);
  };
  const nose = [0, 0.01, 0.36], tail = [0, 0.02, -0.3], top = [0, 0.085, 0.02], bot = [0, -0.07, 0.02], L = [0.085, 0, 0.02], R = [-0.085, 0, 0.02];
  for (const [a, b] of [[top, L], [L, bot], [bot, R], [R, top]]) {
    tri(nose, a, b);
    tri(tail, b, a);
  }
  // beak
  tri([0, 0.0, 0.48], [0.025, 0.02, 0.34], [-0.025, 0.02, 0.34]);
  // tail fan
  tri([0, 0.02, -0.26], [0.13, 0.0, -0.58], [-0.13, 0.0, -0.58]);
  // wings: root → elbow → tip (x sign = side)
  for (const s of [1, -1]) {
    const r0 = [s * 0.06, 0.03, 0.12], r1 = [s * 0.06, 0.03, -0.12];
    const e0 = [s * 0.38, 0.02, 0.06], e1 = [s * 0.38, 0.02, -0.16];
    const tip = [s * 0.72, -0.02, -0.2];
    tri(r0, e0, r1, 0, 0.5, 0);
    tri(r1, e0, e1, 0, 0.5, 0.5);
    tri(e0, tip, e1, 0.5, 1, 0.5);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute(pos, 3));
  g.setAttribute('aWing', new Float32BufferAttribute(wing, 1));
  g.computeVertexNormals();
  return g;
}

const VERT = /* glsl */ `
  uniform float uTime;
  attribute float aWing;
  attribute vec2 aFlap; // phase, flap strength (0 = gliding)
  varying vec3 vWorld;
  void main() {
    vec3 p = position;
    float flap = sin(uTime * 13.0 + aFlap.x) * aFlap.y;
    float lift = abs(p.x);
    p.y += lift * sin(flap) * 1.15 + aWing * aWing * sin(flap + 0.6) * 0.18 * aFlap.y;
    p.x *= mix(1.0, cos(flap) * 0.9 + 0.1, step(0.001, aWing));
    vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
    vWorld = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

const FRAG = /* glsl */ `
  ${GLSL_COMMON}
  varying vec3 vWorld;
  void main() {
    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    vec3 v = normalize(cameraPosition - vWorld);
    float rim = pow(1.0 - abs(dot(n, v)), 2.2);
    vec3 col = vec3(0.012, 0.01, 0.014) + vec3(1.0, 0.42, 0.16) * rim * 0.35 + castleLight(vWorld, n, 0.4) * 0.03;
    gl_FragColor = vec4(applyFog(col, vWorld, uFogDensity * 0.85), 1.0);
  }
`;

const _m = new Matrix4();
const _q = new Quaternion();
const _s = new Vector3();
const _p = new Vector3();
const _look = new Matrix4();
const UP = new Vector3(0, 1, 0);
const _v = new Vector3();
const _t = new Vector3();

/**
 * Kasugai crows — Kiriya Ubuyashiki's messengers threading the void.
 * Classic boids (separation / alignment / cohesion) steered toward three
 * roosts that orbit Tanjiro, plus "messenger" flybys that swoop past the lens.
 */
export class Crows {
  constructor(scene, audio) {
    const n = CROWS.count;
    this.n = n;
    this.audio = audio;
    this.rnd = mulberry32(4242);
    const geo = crowGeometry();
    this.flap = new InstancedBufferAttribute(new Float32Array(n * 2), 2);
    geo.setAttribute('aFlap', this.flap);
    this.mesh = new InstancedMesh(
      geo,
      new ShaderMaterial({ uniforms: castleUniforms, vertexShader: VERT, fragmentShader: FRAG, side: DoubleSide }),
      n,
    );
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.group = new Uint8Array(n);
    this.msg = new Int8Array(n); // messenger waypoint (−1 none)
    this.msgT = new Float32Array(n);
    this.cawed = new Uint8Array(n);
    this.roosts = [0, 1, 2].map((i) => ({
      angle: (i / 3) * Math.PI * 2,
      speed: (0.12 + this.rnd() * 0.1) * (i % 2 ? 1 : -1),
      radius: 26 + this.rnd() * 30,
      height: -6 + this.rnd() * 22,
      c: new Vector3(),
    }));
    this.flybyIn = 6;
    this.flyPath = [];
    this.inited = false;
  }

  init(center) {
    const r = this.rnd;
    for (let i = 0; i < this.n; i++) {
      this.group[i] = i % 3;
      const a = r() * Math.PI * 2;
      this.pos[i * 3] = center.x + Math.cos(a) * (20 + r() * 40);
      this.pos[i * 3 + 1] = center.y + (r() - 0.3) * 30;
      this.pos[i * 3 + 2] = center.z + Math.sin(a) * (20 + r() * 40);
      this.vel[i * 3] = -Math.sin(a) * CROWS.speed;
      this.vel[i * 3 + 2] = Math.cos(a) * CROWS.speed;
      this.msg[i] = -1;
      this.flap.array[i * 2] = r() * 20;
      this.flap.array[i * 2 + 1] = 0.8;
    }
    this.inited = true;
  }

  shift(dx, dy, dz) {
    for (let i = 0; i < this.n; i++) {
      this.pos[i * 3] += dx;
      this.pos[i * 3 + 1] += dy;
      this.pos[i * 3 + 2] += dz;
    }
  }

  /** Send a few crows swooping right past the camera. */
  flyby(camera) {
    const fwd = camera.getWorldDirection(new Vector3());
    const right = new Vector3().crossVectors(fwd, UP).normalize();
    const side = this.rnd() < 0.5 ? 1 : -1;
    const close = camera.position.clone().addScaledVector(fwd, 3.5 + this.rnd() * 3).add(new Vector3(0, -0.4 + this.rnd() * 1.6, 0));
    const dir = right.clone().multiplyScalar(side).addScaledVector(fwd, -0.35 + this.rnd() * 0.3).normalize();
    const start = close.clone().addScaledVector(dir, -38).addScaledVector(fwd, -6);
    const end = close.clone().addScaledVector(dir, 55).add(new Vector3(0, 6, 0));
    this.flyPath = [close, end];
    const count = 2 + Math.floor(this.rnd() * 4);
    let picked = 0;
    for (let i = 0; i < this.n && picked < count; i++) {
      const j = Math.floor(this.rnd() * this.n);
      if (this.msg[j] >= 0) continue;
      this.msg[j] = 0;
      this.msgT[j] = 0;
      this.cawed[j] = 0;
      const o = j * 3;
      this.pos[o] = start.x + (this.rnd() - 0.5) * 3;
      this.pos[o + 1] = start.y + (this.rnd() - 0.5) * 2;
      this.pos[o + 2] = start.z + (this.rnd() - 0.5) * 3;
      const v = dir.clone().multiplyScalar(22);
      this.vel[o] = v.x; this.vel[o + 1] = v.y; this.vel[o + 2] = v.z;
      picked++;
    }
  }

  update(dt, center, camera, time) {
    if (!this.inited) this.init(center);
    dt = Math.min(dt, 1 / 20);
    const n = this.n;
    const P = this.pos, V = this.vel;
    const C = CROWS;
    for (const r of this.roosts) {
      r.angle += r.speed * dt;
      r.c.set(center.x + Math.cos(r.angle) * r.radius, center.y + r.height + Math.sin(time * 0.2 + r.radius) * 6, center.z + Math.sin(r.angle) * r.radius);
    }
    this.flybyIn -= dt;
    if (this.flybyIn <= 0) {
      this.flyby(camera);
      this.flybyIn = C.flybyEvery[0] + this.rnd() * (C.flybyEvery[1] - C.flybyEvery[0]);
    }
    const nr2 = C.neighbourRadius * C.neighbourRadius;
    const sr2 = C.separation * C.separation;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const px = P[o], py = P[o + 1], pz = P[o + 2];
      let ax = 0, ay = 0, az = 0;
      const vx0 = V[o], vy0 = V[o + 1], vz0 = V[o + 2];
      if (this.msg[i] >= 0) {
        // messenger: seek waypoints fast
        this.msgT[i] += dt;
        const wp = this.flyPath[this.msg[i]];
        if (!wp || this.msgT[i] > 7) {
          this.msg[i] = -1;
        } else {
          _t.set(wp.x - px, wp.y - py, wp.z - pz);
          const d = _t.length();
          if (d < 5) this.msg[i]++;
          _t.multiplyScalar(24 / Math.max(d, 1e-3));
          ax += (_t.x - vx0) * 3; ay += (_t.y - vy0) * 3; az += (_t.z - vz0) * 3;
          const cd = camera.position.distanceTo(_v.set(px, py, pz));
          if (cd < 9 && !this.cawed[i]) {
            this.cawed[i] = 1;
            if (this.rnd() < 0.6) this.audio?.caw(cd);
          }
        }
      }
      if (this.msg[i] < 0) {
        let cx = 0, cy = 0, cz = 0, alx = 0, aly = 0, alz = 0, sx = 0, sy = 0, sz = 0, cnt = 0;
        const g = this.group[i];
        for (let j = 0; j < n; j++) {
          if (j === i || this.group[j] !== g) continue;
          const q = j * 3;
          const dx = P[q] - px, dy = P[q + 1] - py, dz = P[q + 2] - pz;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > nr2) continue;
          cnt++;
          cx += dx; cy += dy; cz += dz;
          alx += V[q]; aly += V[q + 1]; alz += V[q + 2];
          if (d2 < sr2) {
            const inv = 1 / Math.max(d2, 0.01);
            sx -= dx * inv; sy -= dy * inv; sz -= dz * inv;
          }
        }
        if (cnt) {
          ax += (cx / cnt) * 0.6 + (alx / cnt - vx0) * 1.1 + sx * 6;
          ay += (cy / cnt) * 0.6 + (aly / cnt - vy0) * 1.1 + sy * 6;
          az += (cz / cnt) * 0.6 + (alz / cnt - vz0) * 1.1 + sz * 6;
        }
        // roost: seek + circle
        const r = this.roosts[g].c;
        const tx = r.x - px, ty = r.y - py, tz = r.z - pz;
        const td = Math.hypot(tx, ty, tz) || 1;
        ax += (tx / td) * 4 + (-tz / td) * 2.4;
        ay += (ty / td) * 3;
        az += (tz / td) * 4 + (tx / td) * 2.4;
        // keep a little distance from Tanjiro
        const hx = px - center.x, hy = py - center.y - 1.5, hz = pz - center.z;
        const hd2 = hx * hx + hy * hy + hz * hz;
        if (hd2 < 36) {
          ax += hx * 3; ay += hy * 3; az += hz * 3;
        }
      }
      // integrate
      const al = Math.hypot(ax, ay, az);
      if (al > C.maxForce * 2) {
        const k = (C.maxForce * 2) / al;
        ax *= k; ay *= k; az *= k;
      }
      let vx = vx0 + ax * dt, vy = vy0 + ay * dt, vz = vz0 + az * dt;
      const sp = Math.hypot(vx, vy, vz) || 1;
      const maxS = this.msg[i] >= 0 ? 26 : C.speed * 1.3, minS = C.speed * 0.6;
      const cl = Math.min(maxS, Math.max(minS, sp)) / sp;
      vx *= cl; vy *= cl; vz *= cl;
      V[o] = vx; V[o + 1] = vy; V[o + 2] = vz;
      P[o] += vx * dt; P[o + 1] += vy * dt; P[o + 2] += vz * dt;
      // lost far behind (e.g. after a Biwa drop): reappear near its roost
      const fx = P[o] - center.x, fy = P[o + 1] - center.y, fz = P[o + 2] - center.z;
      if (fx * fx + fy * fy + fz * fz > 140 * 140) {
        const r = this.roosts[this.group[i]].c;
        P[o] = r.x + (this.rnd() - 0.5) * 20;
        P[o + 1] = r.y + (this.rnd() - 0.5) * 10;
        P[o + 2] = r.z + (this.rnd() - 0.5) * 20;
        this.msg[i] = -1;
      }
      // flap harder when climbing, glide when diving
      const climb = vy / sp;
      this.flap.array[i * 2 + 1] += ((climb > -0.15 ? 0.75 + climb * 0.6 : 0.12) - this.flap.array[i * 2 + 1]) * Math.min(1, dt * 3);
      // orient along velocity
      _p.set(P[o], P[o + 1], P[o + 2]);
      _v.set(P[o] + vx, P[o + 1] + vy, P[o + 2] + vz);
      _look.lookAt(_v, _p, UP); // +Z toward velocity
      _q.setFromRotationMatrix(_look);
      _s.setScalar(this.msg[i] >= 0 ? 1.45 : 1.25);
      _m.compose(_p, _q, _s);
      this.mesh.setMatrixAt(i, _m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;
  }
}
