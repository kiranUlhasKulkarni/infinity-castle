/**
 * Touch controls — loaded ONLY on touch devices (main.js imports this module
 * dynamically after `isTouchDevice()`), so desktop never gets this markup, CSS
 * or listeners.
 *
 *  • Left half: a virtual joystick. Its base rests in the bottom-left corner;
 *    a touch anywhere on the left half re-centres it under the thumb, the knob
 *    follows the thumb (clamped to the rim) and everything glides home on
 *    release. Its vector feeds `controller.stick`, which replaces WASD while
 *    held; pushed to the rim = sprint.
 *  • Right half: drag to look (same yaw / pitch path as the mouse).
 *  • Buttons (bottom right, above the music bars): jump, Kanao (the 'K'
 *    moment), and the Biwa (spring the trap now).
 *
 * All touch handlers are non-passive and call preventDefault(), so the page
 * never scrolls, zooms or fires emulated mouse events.
 */

export const isTouchDevice = () => 'ontouchstart' in window || navigator.maxTouchPoints > 0;

const RIM = 54; // px: knob travel
const LOOK_GAIN = 2.3; // touch px → mouse-equivalent px (phone pixels are small)

const CSS = /* css */ `
.tc { position: fixed; inset: 0; z-index: 7; pointer-events: none; opacity: 0; transition: opacity 1.2s ease; }
.tc--on { opacity: 1; }
.tc--on .tc-zone, .tc--on .tc-btn { pointer-events: auto; }
.tc-zone { position: absolute; top: 0; bottom: 0; touch-action: none; }
.tc-zone--move { left: 0; width: 50%; }
.tc-zone--look { right: 0; width: 50%; }

.tc-stick {
  position: absolute;
  left: 0; top: 0;
  width: 132px; height: 132px;
  margin: -66px 0 0 -66px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(255, 190, 140, 0.05) 0%, rgba(255, 160, 100, 0.09) 62%, rgba(255, 170, 120, 0.13) 100%);
  border: 1px solid rgba(255, 200, 160, 0.22);
  box-shadow: 0 0 24px rgba(255, 110, 40, 0.08), inset 0 0 18px rgba(255, 140, 70, 0.08);
  backdrop-filter: blur(3px) saturate(120%);
  -webkit-backdrop-filter: blur(3px) saturate(120%);
  transition: transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.4s ease;
  opacity: 0.55;
  pointer-events: none;
}
.tc-stick--active { transition: opacity 0.15s ease; opacity: 1; }
.tc-knob {
  position: absolute;
  left: 50%; top: 50%;
  width: 54px; height: 54px;
  margin: -27px 0 0 -27px;
  border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, rgba(255, 236, 214, 0.38), rgba(255, 160, 100, 0.16) 70%);
  border: 1px solid rgba(255, 220, 190, 0.4);
  box-shadow: 0 0 14px rgba(255, 120, 50, 0.25);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  transition: transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1.3);
}
.tc-stick--active .tc-knob { transition: none; }

.tc-buttons {
  position: absolute;
  right: max(16px, env(safe-area-inset-right));
  bottom: calc(max(16px, env(safe-area-inset-bottom)) + 56px); /* above the music bars */
  display: grid;
  grid-template-columns: auto auto;
  grid-template-areas: ". biwa" "kiss jump";
  gap: 12px;
  align-items: end;
}
.tc-btn {
  display: grid;
  place-items: center;
  width: 52px; height: 52px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid rgba(255, 210, 170, 0.28);
  background: rgba(40, 14, 8, 0.18);
  color: rgba(255, 225, 195, 0.85);
  box-shadow: 0 0 18px rgba(255, 110, 40, 0.1), inset 0 0 12px rgba(255, 150, 80, 0.08);
  backdrop-filter: blur(8px) saturate(130%);
  -webkit-backdrop-filter: blur(8px) saturate(130%);
  touch-action: none;
  -webkit-tap-highlight-color: transparent;
  transition: transform 0.12s ease, background 0.2s ease, box-shadow 0.2s ease;
}
.tc-btn svg { width: 22px; height: 22px; filter: drop-shadow(0 0 4px rgba(255, 130, 60, 0.55)); }
.tc-btn--jump { grid-area: jump; width: 64px; height: 64px; }
.tc-btn--jump svg { width: 26px; height: 26px; }
.tc-btn--kiss { grid-area: kiss; }
.tc-btn--biwa { grid-area: biwa; justify-self: end; }
.tc-btn--down { transform: scale(0.9); background: rgba(255, 120, 50, 0.22); box-shadow: 0 0 22px rgba(255, 120, 50, 0.35); }
.tc-btn:disabled { opacity: 0.35; }
.viz { z-index: 8; } /* the music bars stay tappable above the look zone */

@media (orientation: landscape) and (max-height: 500px) {
  .tc-stick { width: 112px; height: 112px; margin: -56px 0 0 -56px; }
  .tc-buttons { bottom: calc(max(12px, env(safe-area-inset-bottom)) + 48px); gap: 10px; }
  .tc-btn { width: 46px; height: 46px; }
  .tc-btn--jump { width: 56px; height: 56px; }
}
`;

const ICONS = {
  jump: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V6M6 11l6-6 6 6"/></svg>',
  kiss: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 20.5s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.6a4.3 4.3 0 0 1 7.5 2.7c0 5.6-7.5 10.2-7.5 10.2z"/></svg>',
  // a biwa: pear-shaped body, neck and pegs
  biwa: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M9.2 21c-3 0-4.7-2.4-4.2-5.4.4-2.6 2.6-5.1 5.6-6.1l3.1 3.1c-1 3-3.5 5.2-6.1 5.6"/><path d="M10.6 9.5 18 2.6M16.4 2.4l1.6 1.6M18.6 4.6l1.4 1.4M8 16l2.4-2.4"/><circle cx="8.6" cy="17.4" r="0.8" fill="currentColor"/></svg>',
};

export class TouchControls {
  /**
   * @param {object} controller  the Controller (stick, look(), jumpQueued, interactQueued)
   * @param {object} opts { onBiwa: () => void }
   */
  constructor(controller, { onBiwa } = {}) {
    this.c = controller;
    this.onBiwa = onBiwa;
    this.moveId = null;
    this.lookId = null;
    this.home = { x: 0, y: 0 };
    this.centre = { x: 0, y: 0 };
    this.lookLast = { x: 0, y: 0 };

    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'tc';
    root.setAttribute('aria-hidden', 'true');
    root.innerHTML = `
      <div class="tc-zone tc-zone--move"></div>
      <div class="tc-zone tc-zone--look"></div>
      <div class="tc-stick"><div class="tc-knob"></div></div>
      <div class="tc-buttons">
        <button class="tc-btn tc-btn--biwa" type="button" aria-label="Biwa">${ICONS.biwa}</button>
        <button class="tc-btn tc-btn--kiss" type="button" aria-label="Kanao">${ICONS.kiss}</button>
        <button class="tc-btn tc-btn--jump" type="button" aria-label="Jump">${ICONS.jump}</button>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this.stick = root.querySelector('.tc-stick');
    this.knob = root.querySelector('.tc-knob');

    const opt = { passive: false };
    const move = root.querySelector('.tc-zone--move');
    const look = root.querySelector('.tc-zone--look');
    move.addEventListener('touchstart', (e) => this.moveStart(e), opt);
    look.addEventListener('touchstart', (e) => this.lookStart(e), opt);
    // moves / ends are tracked on the window so a thumb can slide off its zone
    window.addEventListener('touchmove', (e) => this.touchMove(e), opt);
    window.addEventListener('touchend', (e) => this.touchEnd(e), opt);
    window.addEventListener('touchcancel', (e) => this.touchEnd(e), opt);

    const button = (sel, fn) => {
      const b = root.querySelector(sel);
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        b.classList.add('tc-btn--down');
        fn();
      }, opt);
      const up = (e) => {
        e.preventDefault();
        b.classList.remove('tc-btn--down');
      };
      b.addEventListener('touchend', up, opt);
      b.addEventListener('touchcancel', up, opt);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      return b;
    };
    button('.tc-btn--jump', () => (this.c.jumpQueued = true));
    button('.tc-btn--kiss', () => (this.c.interactQueued = true));
    this.biwaBtn = button('.tc-btn--biwa', () => this.onBiwa?.());

    // no pinch-zoom / double-tap zoom anywhere (iOS ignores user-scalable=no)
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault(), opt);
    document.addEventListener('dblclick', (e) => e.preventDefault(), opt);

    this.layout();
    addEventListener('resize', () => this.layout());
    addEventListener('orientationchange', () => {
      this.release(); // a held thumb doesn't survive a rotation
      setTimeout(() => this.layout(), 250);
    });
  }

  /** Controls fade in once there's something to control (after the opening). */
  set visible(v) {
    this.root.classList.toggle('tc--on', v);
    if (!v) this.release();
  }

  /** Biwa button availability (no drop mid-drop / mid-moment). */
  set biwaReady(v) {
    if (this.biwaBtn.disabled === !v) return;
    this.biwaBtn.disabled = !v;
  }

  layout() {
    const landscapeShort = innerHeight < 500;
    const inset = landscapeShort ? 84 : 100;
    this.home.x = inset + 8;
    this.home.y = innerHeight - inset - 4;
    if (this.moveId === null) this.place(this.home.x, this.home.y, 0, 0);
    else if (this.centre.y > innerHeight || this.centre.x > innerWidth) this.releaseStick(); // base would be off-screen
  }

  place(cx, cy, kx, ky) {
    this.centre.x = cx;
    this.centre.y = cy;
    this.stick.style.transform = `translate(${cx}px, ${cy}px)`;
    this.knob.style.transform = `translate(${kx}px, ${ky}px)`;
  }

  moveStart(e) {
    e.preventDefault();
    if (this.moveId !== null) return;
    const t = e.changedTouches[0];
    this.moveId = t.identifier;
    // re-centre the base under the thumb (unless the thumb landed on it)
    const d = Math.hypot(t.clientX - this.home.x, t.clientY - this.home.y);
    const cx = d < RIM ? this.home.x : t.clientX, cy = d < RIM ? this.home.y : t.clientY;
    this.stick.classList.add('tc-stick--active');
    this.place(cx, cy, 0, 0);
    this.drag(t);
  }

  lookStart(e) {
    e.preventDefault();
    if (this.lookId !== null) return;
    const t = e.changedTouches[0];
    this.lookId = t.identifier;
    this.lookLast.x = t.clientX;
    this.lookLast.y = t.clientY;
  }

  drag(t) {
    let dx = t.clientX - this.centre.x, dy = t.clientY - this.centre.y;
    const d = Math.hypot(dx, dy);
    if (d > RIM) {
      dx *= RIM / d;
      dy *= RIM / d;
    }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const s = this.c.stick;
    s.x = dx / RIM;
    s.y = -dy / RIM; // screen up = forward
    s.active = true;
  }

  touchMove(e) {
    let used = false;
    for (const t of e.changedTouches) {
      if (t.identifier === this.moveId) {
        this.drag(t);
        used = true;
      } else if (t.identifier === this.lookId) {
        this.c.look((t.clientX - this.lookLast.x) * LOOK_GAIN, (t.clientY - this.lookLast.y) * LOOK_GAIN);
        this.lookLast.x = t.clientX;
        this.lookLast.y = t.clientY;
        used = true;
      }
    }
    if (used) e.preventDefault();
  }

  touchEnd(e) {
    for (const t of e.changedTouches) {
      if (t.identifier === this.moveId) this.releaseStick();
      else if (t.identifier === this.lookId) this.lookId = null;
    }
  }

  releaseStick() {
    this.moveId = null;
    const s = this.c.stick;
    s.x = s.y = 0;
    s.active = false;
    // snap back: knob to the centre, base glides home (CSS transitions)
    this.stick.classList.remove('tc-stick--active');
    this.place(this.home.x, this.home.y, 0, 0);
  }

  release() {
    if (this.moveId !== null) this.releaseStick();
    this.lookId = null;
  }
}
