import { MUSIC } from '../config.js';

/**
 * Background music: a hidden YouTube IFrame player used purely as an audio
 * source, looping forever, plus the bottom-right equalizer that toggles mute.
 *
 *  • The player is parked invisibly behind the canvas (opacity ~0, 200×200 —
 *    YouTube's minimum). display:none / 0×0 makes some browsers refuse or
 *    pause playback, so it stays rendered but unseen and unclickable.
 *  • Autoplay policy: nothing plays until the visitor's first click (the
 *    intro gate). If the browser still blocks it, the next click retries.
 *  • Looping: native loop (playlist = same id) + a seek-to-0 on ENDED as a
 *    fallback.
 *  • Cross-origin audio can't be analysed, so the bars synthesise organic
 *    motion while the track is actually playing and flatten when muted.
 */

let apiPromise = null;
function loadYouTubeApi(timeoutMs = 15000) {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const timer = setTimeout(() => reject(new Error('YouTube IFrame API timed out')), timeoutMs);
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      previous?.();
      resolve(window.YT);
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.async = true;
    s.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Could not load the YouTube IFrame API'));
    };
    document.head.appendChild(s);
  });
  return apiPromise;
}

export function youtubeId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) return u.pathname.slice(1);
    return u.searchParams.get('v');
  } catch {
    return /^[\w-]{11}$/.test(url) ? url : null;
  }
}

const PLAYING = 1, ENDED = 0, BUFFERING = 3;

export class Music {
  constructor() {
    this.videoId = youtubeId(MUSIC.url);
    this.player = null;
    this.ready = false;
    this.wantPlay = false;
    this.muted = false;
    this.state = -1;
    this.failed = false;
    this.energy = 0;
    this.buildUi();
    this.load();
  }

  load() {
    const host = document.getElementById('yt-audio-host');
    const mount = document.createElement('div');
    host.appendChild(mount);
    loadYouTubeApi()
      .then((YT) => {
        this.player = new YT.Player(mount, {
          width: '200',
          height: '200',
          videoId: this.videoId,
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            loop: 1,
            playlist: this.videoId, // required for native looping of a single video
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              this.ready = true;
              this.player.setVolume(Math.round(MUSIC.volume * 100));
              if (this.muted) this.player.mute();
              if (this.wantPlay) this.player.playVideo();
            },
            onStateChange: (e) => {
              this.state = e.data;
              if (e.data === ENDED && this.wantPlay) {
                this.player.seekTo(MUSIC.startSeconds ?? 0, true);
                this.player.playVideo();
              }
              this.refreshUi();
            },
            onError: (e) => {
              // 2 bad id · 5 html5 · 100 removed · 101/150 embedding disabled by the owner
              console.warn(`[music] YouTube error ${e.data} for ${this.videoId}`);
              this.failed = true;
              this.refreshUi();
            },
          },
        });
      })
      .catch((err) => {
        console.warn('[music]', err.message);
        this.failed = true;
        this.refreshUi();
      });

    // If the browser blocked playback, any later click tries again.
    window.addEventListener('pointerdown', () => {
      if (this.wantPlay && this.ready && this.state !== PLAYING && this.state !== BUFFERING) this.player.playVideo();
    });
  }

  /** Call from a user gesture (the intro click). */
  play() {
    this.wantPlay = true;
    if (this.ready) {
      if (!this.muted) this.player.unMute();
      this.player.playVideo();
    }
    this.el.classList.add('viz--on');
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.ready) {
      if (this.muted) this.player.mute();
      else {
        this.player.unMute();
        if (this.wantPlay && this.state !== PLAYING) this.player.playVideo();
      }
    }
    this.refreshUi();
  }

  get playing() {
    return this.wantPlay && !this.muted && (this.state === PLAYING || this.state === BUFFERING);
  }

  /* ───── equalizer UI ───── */

  buildUi() {
    const el = document.getElementById('viz');
    this.el = el;
    this.bars = Array.from(el.querySelectorAll('span'));
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      this.toggleMute();
    });
    el.addEventListener('mousedown', (e) => e.stopPropagation()); // don't grab the pointer
    this.smooth = new Float32Array(this.bars.length).fill(0.1);
    const loop = (now) => {
      this.tick(now / 1000);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  refreshUi() {
    this.el.classList.toggle('viz--muted', this.muted);
    this.el.classList.toggle('viz--failed', this.failed);
    this.el.setAttribute('aria-label', this.muted ? 'Unmute music' : 'Mute music');
    this.el.setAttribute('aria-pressed', String(this.muted));
  }

  tick(t) {
    const target = this.playing ? 1 : 0;
    this.energy += (target - this.energy) * (target > this.energy ? 0.06 : 0.12);
    const e = this.energy;
    for (let i = 0; i < this.bars.length; i++) {
      const wobble = 0.5 + 0.3 * Math.sin(t * (3.1 + i * 0.9) + i * 1.7) + 0.2 * Math.sin(t * (7.3 + i * 1.3) + i * 3.1);
      const v = e * (0.25 + 0.75 * wobble);
      this.smooth[i] += (v - this.smooth[i]) * 0.25;
      this.bars[i].style.transform = `scaleY(${(0.12 + this.smooth[i] * 0.88).toFixed(3)})`;
    }
  }
}
