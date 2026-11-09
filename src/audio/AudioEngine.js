import { BIWA } from '../config.js';

/**
 * Sound effects, all synthesised with WebAudio (no files needed):
 *  • the Biwa strum — Karplus-Strong plucked strings tuned like a biwa
 *    (B-E-F#-B), struck in a fast rake, with the buzzy "sawari" grit and a
 *    bachi (plectrum) slap, through a long hall reverb,
 *  • wooden footsteps, landing thuds, crow caws, the wind of freefall.
 * Set BIWA.sampleUrl in config.js to use a real recording instead.
 * The AudioContext is created/resumed on the first click (autoplay policy).
 */
export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
  }

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.build();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  build() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    // hall reverb
    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(3.2, 2.6);
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.5;
    this.reverb.connect(this.wet).connect(this.master);
    this.strumBuffer = this.renderStrum();
    if (BIWA.sampleUrl) {
      fetch(BIWA.sampleUrl)
        .then((r) => r.arrayBuffer())
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => (this.strumBuffer = buf))
        .catch((e) => console.warn('[audio] biwa sample failed, using the synthesized strum', e));
    }
    // continuous wind (gain follows fall speed)
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuffer(2);
    noise.loop = true;
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = 500;
    this.windFilter.Q.value = 0.7;
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0.015;
    noise.connect(this.windFilter).connect(this.windGain).connect(this.master);
    noise.start();
    this.ready = true;
  }

  noiseBuffer(seconds) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.floor(ctx.sampleRate * seconds);
    const b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = b.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return b;
  }

  /** Karplus-Strong rake across four biwa strings, rendered once into a buffer. */
  renderStrum() {
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const len = Math.floor(sr * 3.2);
    const out = new Float32Array(len);
    const notes = [61.74, 82.41, 92.5, 123.47]; // B1 E2 F#2 B2
    notes.forEach((f, s) => {
      const start = Math.floor(sr * (0.004 + s * 0.022));
      const N = Math.round(sr / f);
      const buf = new Float32Array(N);
      let prev = 0;
      for (let i = 0; i < N; i++) {
        const w = Math.random() * 2 - 1;
        prev = prev * 0.35 + w * 0.65; // slightly darker pluck
        buf[i] = prev;
      }
      let idx = 0;
      const decay = 0.9965 - s * 0.0004;
      for (let n = start; n < len; n++) {
        const a = buf[idx];
        const b = buf[(idx + 1) % N];
        const y = 0.5 * (a + b) * decay;
        buf[idx] = y;
        idx = (idx + 1) % N;
        out[n] += a * (0.9 - s * 0.08);
      }
    });
    // bachi slap: a short bright noise transient
    for (let i = 0; i < sr * 0.03; i++) out[i] += (Math.random() * 2 - 1) * Math.pow(1 - i / (sr * 0.03), 3) * 0.9;
    // sawari: the biwa's buzzing bridge → asymmetric soft clipping
    let peak = 0;
    for (let i = 0; i < len; i++) {
      const x = out[i] * 1.6;
      out[i] = Math.tanh(x + 0.25 * x * x) - Math.tanh(0.0);
      peak = Math.max(peak, Math.abs(out[i]));
    }
    const b = ctx.createBuffer(1, len, sr);
    const d = b.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (out[i] / (peak || 1)) * 0.95;
    return b;
  }

  strum() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.strumBuffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 45;
    const presence = ctx.createBiquadFilter();
    presence.type = 'peaking';
    presence.frequency.value = 2400;
    presence.gain.value = 5;
    const g = ctx.createGain();
    g.gain.value = 1.0;
    src.connect(hp).connect(presence).connect(g);
    g.connect(this.master);
    g.connect(this.reverb);
    src.start();
    // a sub "boom" under the strum: the castle shifting
    const o = ctx.createOscillator();
    const og = ctx.createGain();
    o.frequency.setValueAtTime(70, ctx.currentTime + 0.05);
    o.frequency.exponentialRampToValueAtTime(28, ctx.currentTime + 2.2);
    og.gain.setValueAtTime(0.0001, ctx.currentTime);
    og.gain.exponentialRampToValueAtTime(0.5, ctx.currentTime + 0.12);
    og.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 2.4);
    o.connect(og).connect(this.master);
    o.start();
    o.stop(ctx.currentTime + 2.5);
  }

  /** A soft, warm wind-chime shimmer (the 'K' moment): a few sine bells into the hall. */
  chime() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    [659.25, 987.77, 1318.5, 1479.98].forEach((f, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t = t0 + i * 0.11;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.07 / (1 + i * 0.4), t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.6);
      o.connect(g);
      g.connect(this.master);
      g.connect(this.reverb);
      o.start(t);
      o.stop(t + 2.7);
    });
  }

  step(speed) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const v = Math.min(1, 0.25 + speed / 12);
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(150 + Math.random() * 60, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * v, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    o.connect(g).connect(this.master);
    g.connect(this.reverb);
    o.start(t);
    o.stop(t + 0.13);
    const n = ctx.createBufferSource();
    n.buffer = this.noiseShort ??= this.noiseBuffer(0.05);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1800 + Math.random() * 800;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.06 * v, t);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
    n.connect(f).connect(ng).connect(this.master);
    n.start(t);
  }

  /** A wading step / splash in shallow water: a filtered slosh plus a small bubble "plip". */
  splash(strength = 0.3) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseSplash ??= this.noiseBuffer(0.4);
    n.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.setValueAtTime(900 + Math.random() * 500, t);
    f.frequency.exponentialRampToValueAtTime(420, t + 0.25);
    f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * strength, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18 + strength * 0.3);
    n.connect(f).connect(g).connect(this.master);
    g.connect(this.reverb);
    n.start(t);
    n.stop(t + 0.5);
    const o = ctx.createOscillator();
    o.type = 'sine';
    const f0 = 500 + Math.random() * 400;
    o.frequency.setValueAtTime(f0, t + 0.03);
    o.frequency.exponentialRampToValueAtTime(f0 * 2.2, t + 0.09);
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t + 0.03);
    og.gain.exponentialRampToValueAtTime(0.05 * strength, t + 0.04);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    o.connect(og).connect(this.master);
    o.start(t + 0.03);
    o.stop(t + 0.12);
  }

  /** The Icicle Breath: a long frozen exhale (hiss falling through a band) over a low groan. */
  iceBreath() {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const n = ctx.createBufferSource();
    n.buffer = this.noiseLong ??= this.noiseBuffer(2);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 0.7;
    f.frequency.setValueAtTime(5200, t);
    f.frequency.exponentialRampToValueAtTime(900, t + 1.4);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.32, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
    n.connect(f).connect(g).connect(this.master);
    g.connect(this.reverb);
    n.start(t);
    n.stop(t + 1.7);
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(55, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 1.2);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 220;
    const og = ctx.createGain();
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(0.18, t + 0.2);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1.4);
    o.connect(lp).connect(og).connect(this.master);
    og.connect(this.reverb);
    o.start(t);
    o.stop(t + 1.5);
  }

  /** An icicle striking: a glassy ping (kind 1 wood, 2 water, 3 wall). */
  iceHit(vol = 0.5, kind = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const base = kind === 2 ? 1400 : 2400 + Math.random() * 1800;
    for (const [mul, a] of [[1, 1], [2.76, 0.4]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = base * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.06 * vol * a, t + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + (kind === 2 ? 0.12 : 0.35));
      o.connect(g).connect(this.master);
      g.connect(this.reverb);
      o.start(t);
      o.stop(t + 0.4);
    }
    if (kind === 2) this.splash(0.25 * vol);
    else this.step(4 * vol); // the thunk into wood / paper
  }

  thud(strength = 1) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(110, t);
    o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.7 * strength, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    o.connect(g).connect(this.master);
    g.connect(this.reverb);
    o.start(t);
    o.stop(t + 0.55);
    this.step(10);
  }

  caw(distance = 5) {
    if (!this.ready) return;
    const ctx = this.ctx;
    const vol = Math.min(0.22, 1.2 / (1 + distance));
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (pan) pan.pan.value = Math.random() * 1.6 - 0.8;
    for (let k = 0; k < 2; k++) {
      const t = ctx.currentTime + k * 0.32;
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(560 + Math.random() * 60, t);
      o.frequency.linearRampToValueAtTime(390, t + 0.22);
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 1350;
      f.Q.value = 3;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
      o.connect(f).connect(g);
      if (pan) g.connect(pan);
      else g.connect(this.master);
      o.start(t);
      o.stop(t + 0.3);
    }
    if (pan) {
      pan.connect(this.master);
      pan.connect(this.reverb);
    }
  }

  /** Wind roar follows fall speed (0..1). */
  setWind(amount) {
    if (!this.ready) return;
    const t = this.ctx.currentTime;
    this.windGain.gain.setTargetAtTime(0.015 + amount * 0.32, t, 0.15);
    this.windFilter.frequency.setTargetAtTime(500 + amount * 1400, t, 0.2);
  }
}
