import { $ } from './State.js';

let AC = null;
let master = null;
let soundOn = true;

export function initAudio() {
  if (!AC) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (C) {
      AC = new C();
      master = AC.createGain();
      master.gain.value = 0.7;
      master.connect(AC.destination);
    }
  }
  if (AC && AC.state === 'suspended') AC.resume();
}

export function tone(f0, f1, dur, type = 'sine', vol = 0.18, delay = 0) {
  if (!AC || !soundOn) return;
  const t = AC.currentTime + delay;
  const o = AC.createOscillator();
  const g = AC.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.03);
}

export const sfx = {
  oof() {
    tone(210, 125, 0.26, 'sawtooth', 0.26);
    tone(160, 95, 0.26, 'triangle', 0.22, 0.02);
  },
  coil() {
    tone(240, 780, 0.28, 'sine', 0.2);
    tone(780, 420, 0.22, 'triangle', 0.14, 0.12);
  },
  jump() {
    tone(260, 520, 0.14, 'sine', 0.12);
  },
  cash() {
    tone(987.77, 1318.5, 0.12, 'square', 0.14);
    tone(1318.5, 1975.5, 0.24, 'triangle', 0.16, 0.09);
  },
  slap() {
    tone(420, 90, 0.15, 'sawtooth', 0.28);
  },
  hit() {
    tone(180, 65, 0.18, 'square', 0.3);
  },
  zap() {
    tone(680, 75, 0.45, 'sawtooth', 0.32);
    tone(320, 55, 0.45, 'square', 0.24, 0.04);
  },
  checkpoint() {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone(f, f, 0.28, 'triangle', 0.15, i * 0.06)
    );
  },
  gate() {
    [392, 493.88, 587.33, 783.99, 1046.5, 1318.5].forEach((f, i) =>
      tone(f, f, 0.65, 'sine', 0.16, i * 0.09)
    );
  }
};

const muteBtn = $('muteBtn');
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    initAudio();
    soundOn = !soundOn;
    if (master) master.gain.value = soundOn ? 0.7 : 0;
    muteBtn.textContent = soundOn ? 'ЗВУК: ВКЛ' : 'ЗВУК: ВЫКЛ';
  });
}