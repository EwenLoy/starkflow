const STORAGE_KEY = 'ornate-chess:sound';

export class ChessAudio {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.enabled = true;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'off') this.enabled = false;
    } catch {
      /* private mode */
    }
    this._unlock = () => this.unlock();
    window.addEventListener('pointerdown', this._unlock, { once: true });
    window.addEventListener('keydown', this._unlock, { once: true });
  }

  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? 0.18 : 0;
    this.master.connect(this.ctx.destination);
  }

  setEnabled(value) {
    this.enabled = !!value;
    try {
      localStorage.setItem(STORAGE_KEY, this.enabled ? 'on' : 'off');
    } catch {
      /* private mode */
    }
    if (this.master) {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(this.enabled ? 0.18 : 0, this.ctx.currentTime + 0.12);
    }
    if (this.enabled) this.unlock();
  }

  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  #tone(freq, duration = 0.18, { type = 'sine', gain = 0.4, when = 0, slide = 0 } = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + when;
    const osc = this.ctx.createOscillator();
    const env = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + duration);
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(env).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  #noise(duration = 0.14, { cutoff = 900, gain = 0.35, when = 0 } = {}) {
    if (!this.ctx || !this.enabled) return;
    const t = this.ctx.currentTime + when;
    const length = Math.ceil(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i += 1) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    src.connect(filter).connect(env).connect(this.master);
    src.start(t);
  }

  select() {
    this.#tone(740, 0.06, { type: 'triangle', gain: 0.22 });
  }

  move() {
    this.#noise(0.12, { cutoff: 760, gain: 0.45 });
    this.#tone(148, 0.1, { type: 'triangle', gain: 0.3, slide: -36 });
  }

  capture() {
    this.#noise(0.2, { cutoff: 520, gain: 0.55 });
    this.#tone(96, 0.22, { type: 'sine', gain: 0.55, slide: -34 });
    this.#tone(210, 0.14, { type: 'triangle', gain: 0.24, when: 0.02, slide: -40 });
  }

  check() {
    this.#tone(880, 0.16, { type: 'sine', gain: 0.24 });
    this.#tone(1320, 0.24, { type: 'sine', gain: 0.15, when: 0.1 });
  }

  turn() {
    this.#tone(520, 0.09, { type: 'sine', gain: 0.12 });
    this.#tone(780, 0.13, { type: 'sine', gain: 0.08, when: 0.07 });
  }

  win() {
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      this.#tone(freq, 0.5, { type: 'triangle', gain: 0.2, when: i * 0.12 });
    });
  }

  lose() {
    [392, 329.63, 261.63].forEach((freq, i) => {
      this.#tone(freq, 0.55, { type: 'sine', gain: 0.18, when: i * 0.14 });
    });
  }

  draw() {
    this.#tone(440, 0.35, { type: 'sine', gain: 0.16 });
    this.#tone(466.16, 0.4, { type: 'sine', gain: 0.14, when: 0.1 });
  }
}
