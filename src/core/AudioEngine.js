// src/core/AudioEngine.js
import { S, $, clamp, rnd, pick, showBanner } from './State.js';

let AC = null;
let masterGain = null;
let sfxGain = null;
let musicGain = null;
let ambienceGain = null;
let noiseBufferWhite = null;
let noiseBufferPink = null;
let soundOn = true;

// Кэш декодированных AudioBuffer для пользовательских звуков (DataURL -> AudioBuffer)
const decodedCustomBuffers = new Map();

// Состояние секвенсора фоновой музыки и генератора эмбиента
let currentMusicId = 'none';
let musicTimerId = null;
let musicStep = 0;
let customMusicSource = null;

let currentAmbienceId = 'none';
let ambienceNodes = [];
let ambienceTimerId = null;
let customAmbienceSource = null;

export const MUSIC_PRESETS = [
  { id: 'none', name: '🔇 Без музыки' },
  { id: 'heaven_choir', name: '😇 Светлый Рай (Арфа и Солнечный Канон)' },
  { id: 'stardew_farm', name: '🌾 Уютная Ферма (Кантри / Stardew Valley)' },
  { id: 'obby_arcade', name: '🎮 Чиптюн-Аркада (Весёлый Обби)' },
  { id: 'chill_sandbox', name: '🌱 Лоу-Фай Песочница (Мягкий Билдер)' },
  { id: 'epic_orchestra', name: '🎻 Эпический Оркестр (Масштабная Битва)' },
  { id: 'action_boss', name: '⚔️ Боевой Синт-Рок (Арена / Боссфайт)' },
  { id: 'cyber_synth', name: '🌌 Кибер-Синтвейв (Неоновая Ночь)' },
  { id: 'backrooms_jazz', name: '🎷 Бэкрумс Джаз (Ностальгический Холл)' },
  { id: 'dungeon_dark', name: '🏰 Мрачный Данжен (Тёмное Фэнтези)' },
  { id: 'heaven_horror', name: '👁️ Божественный Хоррор (Жуткий Хорал)' }
];

export const AMBIENCE_PRESETS = [
  { id: 'none', name: '🔇 Без фонового звука' },
  { id: 'heaven_wind', name: '☀️ Тёплый бриз, птички и хрустальные перезвоны' },
  { id: 'farm_village', name: '🌾 Деревня и Ферма (Ручей, птицы и сверчки)' },
  { id: 'sunny_nature', name: '🐦 Солнечный луг и лесные птицы' },
  { id: 'battlefield_epic', name: '⚔️ Поле великой битвы (Далёкие горны и гроза)' },
  { id: 'backrooms_hum', name: '💡 Бэкрумс (Гул люминесцентных ламп 60Hz)' },
  { id: 'cave_dungeon', name: '💧 Подземелье, эхо и капли воды' },
  { id: 'cyber_city', name: '⚡ Неоновый мегаполис и реактор' },
  { id: 'lava_inferno', name: '🌋 Вулкан, рокот и кипящая лава' },
  { id: 'ocean_waves', name: '🌊 Морской прибой и шум волн' },
  { id: 'eldritch_horror', name: '👁️ Жуткий Эфир (Холодный ветер и шёпот)' }
];

export const BUILTIN_SFX_LIST = [
  { id: 'none', name: '🔇 Без звука' },
  { id: 'sfx:click', name: '🔘 Клик / Переключатель' },
  { id: 'sfx:buttonPress', name: '🛎️ Нажатие кнопки / плиты' },
  { id: 'sfx:leverPull', name: '🕹️ Рычаг / Ручка двери' },
  { id: 'sfx:gate', name: '🚪 Открытие ворот / Двери' },
  { id: 'sfx:coil', name: '🌀 Пружина / Батут / Бафф' },
  { id: 'sfx:cash', name: '🪙 Монеты / Покупка (R$)' },
  { id: 'sfx:checkpoint', name: '⭐ Чекпоинт / Победа' },
  { id: 'sfx:teleport', name: '🌀 Телепортация / Портал' },
  { id: 'sfx:zap', name: '⚡ Выстрел бластера / Разряд' },
  { id: 'sfx:swing', name: '🗡️ Взмах меча / Оружия' },
  { id: 'sfx:slap', name: '🥊 Удар кулаком / Пощёчина' },
  { id: 'sfx:hit', name: '💥 Попадание / Урон' },
  { id: 'sfx:explosion', name: '💣 Взрыв снаряда / Бомбы' },
  { id: 'sfx:heal', name: '💚 Исцеление / Аптечка' },
  { id: 'sfx:oof', name: '💀 Смерть / Поломка (OOF)' },
  { id: 'sfx:splash', name: '💦 Всплеск воды' },
  { id: 'sfx:gas', name: '☁️ Выброс пара / Газа' }
];

function createNoiseBuffers(ctx) {
  const sr = ctx.sampleRate;
  const len = sr * 2;

  noiseBufferWhite = ctx.createBuffer(1, len, sr);
  const outW = noiseBufferWhite.getChannelData(0);
  for (let i = 0; i < len; i++) {
    outW[i] = Math.random() * 2 - 1;
  }

  noiseBufferPink = ctx.createBuffer(1, len, sr);
  const outP = noiseBufferPink.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    outP[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.045;
    b6 = white * 0.115926;
  }
}

export function initAudio() {
  if (!AC) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (C) {
      AC = new C();
      masterGain = AC.createGain();
      sfxGain = AC.createGain();
      musicGain = AC.createGain();
      ambienceGain = AC.createGain();

      masterGain.gain.value = soundOn ? 0.8 : 0;
      sfxGain.gain.value = S.worldSettings?.sfxVolume ?? 0.85;
      musicGain.gain.value = S.worldSettings?.musicVolume ?? 0.42;
      ambienceGain.gain.value = S.worldSettings?.ambienceVolume ?? 0.45;

      sfxGain.connect(masterGain);
      musicGain.connect(masterGain);
      ambienceGain.connect(masterGain);
      masterGain.connect(AC.destination);

      createNoiseBuffers(AC);
      syncAudioWithWorldSettings();
    }
  }
  if (AC && AC.state === 'suspended') {
    AC.resume().then(() => {
      syncAudioWithWorldSettings();
    }).catch(() => {});
  }
}

export function syncVolumesFromSettings() {
  if (!AC) return;
  const ws = S.worldSettings || {};
  if (sfxGain) sfxGain.gain.setTargetAtTime(clamp(ws.sfxVolume ?? 0.85, 0, 1.5), AC.currentTime, 0.04);
  if (musicGain) musicGain.gain.setTargetAtTime(clamp(ws.musicVolume ?? 0.42, 0, 1.5), AC.currentTime, 0.08);
  if (ambienceGain) ambienceGain.gain.setTargetAtTime(clamp(ws.ambienceVolume ?? 0.45, 0, 1.5), AC.currentTime, 0.08);
}

export function syncAudioWithWorldSettings() {
  if (!AC) return;
  syncVolumesFromSettings();
  const ws = S.worldSettings || {};
  const targetMus = ws.musicPreset || (S.gameMode?.id === 'heaven_queue' ? 'heaven_choir' : 'stardew_farm');
  const targetAmb = ws.ambiencePreset || (S.gameMode?.id === 'heaven_queue' ? 'heaven_wind' : 'farm_village');
  if (targetMus !== currentMusicId) setWorldMusic(targetMus);
  if (targetAmb !== currentAmbienceId) setWorldAmbience(targetAmb);
}

export function tone(f0, f1, dur, type = 'sine', vol = 0.18, delay = 0, opts = {}) {
  if (!AC || !soundOn) return;
  const pitchSpread = opts.pitchVar !== undefined ? opts.pitchVar : 0.075;
  const pMult = pitchSpread > 0 ? (1 + (Math.random() * 2 - 1) * pitchSpread) : 1;
  const timeJitter = opts.noJitter ? 0 : Math.random() * 0.005;

  const t = AC.currentTime + delay + timeJitter;
  const o = AC.createOscillator();
  const g = AC.createGain();

  o.type = type;
  const startFreq = Math.max(18, f0 * pMult);
  o.frequency.setValueAtTime(startFreq, t);
  if (f1) {
    const endFreq = Math.max(18, f1 * pMult);
    o.frequency.exponentialRampToValueAtTime(endFreq, t + dur);
  }
  if (opts.detuneCents !== undefined) {
    o.detune.setValueAtTime(opts.detuneCents + rnd(-8, 8), t);
  }

  const targetBus = opts.bus === 'music' ? musicGain : (opts.bus === 'ambience' ? ambienceGain : sfxGain);
  const attack = Math.min(dur * 0.35, opts.attack || 0.012);
  const finalVol = Math.max(0.0005, vol * rnd(0.93, 1.07));

  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(finalVol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  if (opts.filterFreq) {
    const flt = AC.createBiquadFilter();
    flt.type = opts.filterType || 'lowpass';
    flt.frequency.setValueAtTime(opts.filterFreq * rnd(0.9, 1.1), t);
    if (opts.filterEndFreq) {
      flt.frequency.exponentialRampToValueAtTime(Math.max(40, opts.filterEndFreq), t + dur);
    }
    if (opts.filterQ) flt.Q.value = opts.filterQ;
    o.connect(flt);
    flt.connect(g);
  } else {
    o.connect(g);
  }

  g.connect(targetBus || masterGain);
  o.start(t);
  o.stop(t + dur + 0.03);
}

export function noiseBurst(dur = 0.12, vol = 0.15, delay = 0, opts = {}) {
  if (!AC || !soundOn || !noiseBufferWhite) return;
  const t = AC.currentTime + delay;
  const src = AC.createBufferSource();
  src.buffer = opts.pink ? noiseBufferPink : noiseBufferWhite;
  src.playbackRate.value = (opts.rate || 1.0) * rnd(0.86, 1.16);

  const flt = AC.createBiquadFilter();
  flt.type = opts.filterType || 'bandpass';
  const fStart = (opts.freq || 900) * rnd(0.88, 1.12);
  flt.frequency.setValueAtTime(fStart, t);
  if (opts.freqEnd) {
    flt.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freqEnd * rnd(0.9, 1.1)), t + dur);
  }
  flt.Q.value = opts.q ?? 1.4;

  const g = AC.createGain();
  const attack = Math.min(dur * 0.35, opts.attack || 0.006);
  const v = Math.max(0.0005, vol * rnd(0.9, 1.1));
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(v, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);

  const targetBus = opts.bus === 'music' ? musicGain : (opts.bus === 'ambience' ? ambienceGain : sfxGain);
  src.connect(flt);
  flt.connect(g);
  g.connect(targetBus || masterGain);

  const maxOffset = Math.max(0, src.buffer.duration - dur - 0.05);
  src.start(t, Math.random() * maxOffset);
  src.stop(t + dur + 0.02);
}

/* ---------- ПОЛЬЗОВАТЕЛЬСКИЕ ЗВУКИ И МУЗЫКА (UPLOAD / DECODE / PLAY) ---------- */

export async function decodeCustomAudioEntry(entry) {
  if (!AC || !entry || !entry.dataURL) return null;
  if (decodedCustomBuffers.has(entry.id)) {
    return decodedCustomBuffers.get(entry.id);
  }
  try {
    const resp = await fetch(entry.dataURL);
    const arrBuf = await resp.arrayBuffer();
    const audioBuf = await AC.decodeAudioData(arrBuf);
    decodedCustomBuffers.set(entry.id, audioBuf);
    return audioBuf;
  } catch (err) {
    console.warn('Не удалось декодировать аудио:', entry.name, err);
    return null;
  }
}

export function playCustomAudioById(customId, opts = {}) {
  initAudio();
  if (!AC || !soundOn) return null;
  const cleanId = String(customId || '').replace(/^custom:/, '');
  const entry = (S.customAudioLibrary || []).find(a => a.id === cleanId);
  if (!entry) return null;

  const playFromBuf = buf => {
    if (!buf || !AC) return;
    const src = AC.createBufferSource();
    src.buffer = buf;
    const pitchVar = opts.pitchVar !== undefined ? opts.pitchVar : 0.06;
    src.playbackRate.value = (opts.rate || 1.0) * (1 + (Math.random() * 2 - 1) * pitchVar);
    src.loop = Boolean(opts.loop);

    const g = AC.createGain();
    g.gain.value = clamp(opts.vol ?? 0.8, 0, 2.0);

    const targetBus = opts.bus === 'music' ? musicGain : (opts.bus === 'ambience' ? ambienceGain : sfxGain);
    src.connect(g);
    g.connect(targetBus || masterGain);
    src.start(0);
    if (opts.onSourceCreated) opts.onSourceCreated(src, g);
  };

  if (decodedCustomBuffers.has(entry.id)) {
    playFromBuf(decodedCustomBuffers.get(entry.id));
  } else {
    decodeCustomAudioEntry(entry).then(playFromBuf);
  }
}

export function promptUploadCustomAudio(category = 'sfx', onLoaded = null) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'audio/*,.mp3,.wav,.ogg,.webm,.m4a';
  inp.onchange = e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    if (file.size > 6.5 * 1024 * 1024) {
      showBanner('⚠️ Файл слишком большой (макс. ~6 МБ для сохранения в проект)!', '#ffce3a');
      return;
    }
    const reader = new FileReader();
    reader.onload = async ev => {
      initAudio();
      const dataURL = ev.target.result;
      const cleanName = file.name.replace(/\.[^.]+$/, '').slice(0, 36) || 'Свой звук';
      const entry = {
        id: 'aud_' + Date.now() + '_' + Math.floor(Math.random() * 999),
        name: cleanName,
        category: category || 'sfx',
        dataURL
      };
      if (!Array.isArray(S.customAudioLibrary)) S.customAudioLibrary = [];
      S.customAudioLibrary.push(entry);
      await decodeCustomAudioEntry(entry);
      sfx.cash();
      showBanner(`🔊 Аудио «${entry.name}» добавлено в библиотеку проекта!`, '#00e676');
      if (onLoaded) onLoaded(entry);
    };
    reader.readAsDataURL(file);
  };
  inp.click();
}

export function playSoundId(soundId, opts = {}) {
  if (!soundId || soundId === 'none') return false;
  initAudio();
  if (!AC || !soundOn) return false;

  let distMult = 1.0;
  if (opts.pos && S.player) {
    const lx = S.state === 'edit' ? S.edCamPos.x : S.player.x;
    const ly = S.state === 'edit' ? S.edCamPos.y : (S.player.y + 1.5);
    const lz = S.state === 'edit' ? S.edCamPos.z : S.player.z;
    const d = Math.hypot(opts.pos.x - lx, opts.pos.y - ly, opts.pos.z - lz);
    const maxD = opts.maxDist || 28;
    if (d >= maxD) return false;
    distMult = clamp(1 - d / maxD, 0.05, 1.0);
  }

  if (soundId.startsWith('custom:')) {
    playCustomAudioById(soundId, Object.assign({}, opts, { vol: (opts.vol ?? 0.85) * distMult }));
    return true;
  }

  const sfxName = soundId.replace(/^sfx:/, '');
  if (typeof sfx[sfxName] === 'function') {
    sfx[sfxName](distMult);
    return true;
  }
  return false;
}

/* ---------- КАТАЛОГ ЗВУКОВЫХ ИМПАКТОВ (SFX) С ВАРИАТИВНЫМ ПИТЧЕМ ---------- */

export const sfx = {
  oof(v = 1) {
    tone(215, 118, 0.25, 'sawtooth', 0.24 * v, 0, { pitchVar: 0.09, filterFreq: 950 });
    tone(162, 92, 0.27, 'triangle', 0.20 * v, 0.02, { pitchVar: 0.09 });
    noiseBurst(0.11, 0.12 * v, 0, { freq: 380, freqEnd: 120 });
  },
  coil(v = 1) {
    tone(240, 790, 0.26, 'sine', 0.19 * v, 0, { pitchVar: 0.08 });
    tone(790, 440, 0.22, 'triangle', 0.13 * v, 0.11, { pitchVar: 0.08 });
  },
  jump(v = 1) {
    tone(245, 535, 0.14, 'sine', 0.13 * v, 0, { pitchVar: 0.1 });
    noiseBurst(0.055, 0.05 * v, 0, { freq: 650, freqEnd: 1400, q: 1.0 });
  },
  step(surface = 'studs', inLiquid = false, v = 1) {
    if (inLiquid) {
      tone(190, 320, 0.09, 'sine', 0.08 * v, 0, { pitchVar: 0.16 });
      noiseBurst(0.11, 0.09 * v, 0, { pink: true, freq: 620, freqEnd: 260, q: 1.8 });
      return;
    }
    if (surface === 'metal') {
      tone(520, 210, 0.065, 'triangle', 0.09 * v, 0, { pitchVar: 0.14 });
      tone(1180, 680, 0.045, 'sine', 0.05 * v, 0.005, { pitchVar: 0.16 });
      noiseBurst(0.04, 0.06 * v, 0, { freq: 2200, q: 3.2 });
    } else if (surface === 'glass' || surface === 'neon') {
      tone(920, 480, 0.055, 'sine', 0.075 * v, 0, { pitchVar: 0.14 });
      noiseBurst(0.035, 0.05 * v, 0, { freq: 3100, q: 2.5 });
    } else if (surface === 'smooth') {
      tone(155, 78, 0.055, 'sine', 0.085 * v, 0, { pitchVar: 0.12 });
      noiseBurst(0.04, 0.055 * v, 0, { freq: 950, freqEnd: 420, q: 1.2 });
    } else {
      tone(185, 88, 0.06, 'triangle', 0.095 * v, 0, { pitchVar: 0.14 });
      noiseBurst(0.042, 0.065 * v, 0, { freq: 1250, freqEnd: 520, q: 1.6 });
    }
  },
  land(impactSpeed = 10, surface = 'studs', v = 1) {
    const scale = clamp(impactSpeed / 18, 0.4, 1.4) * v;
    tone(145, 52, 0.12, 'triangle', 0.18 * scale, 0, { pitchVar: 0.12 });
    noiseBurst(0.09, 0.14 * scale, 0, { pink: true, freq: surface === 'metal' ? 1400 : 580, freqEnd: 160, q: 1.2 });
  },
  cash(v = 1) {
    tone(987.77, 1318.5, 0.11, 'square', 0.13 * v, 0, { pitchVar: 0.05, filterFreq: 3200 });
    tone(1318.5, 1975.5, 0.23, 'triangle', 0.16 * v, 0.08, { pitchVar: 0.05 });
  },
  swing(v = 1) {
    noiseBurst(0.14, 0.16 * v, 0, { pink: true, freq: 320, freqEnd: 1450, q: 1.8, attack: 0.025 });
    tone(260, 120, 0.12, 'sine', 0.1 * v, 0.01, { pitchVar: 0.14 });
  },
  slap(v = 1) {
    tone(430, 88, 0.14, 'sawtooth', 0.24 * v, 0, { pitchVar: 0.12, filterFreq: 1800 });
    noiseBurst(0.08, 0.18 * v, 0, { freq: 1400, freqEnd: 350, q: 1.1 });
  },
  hit(v = 1) {
    tone(185, 58, 0.17, 'square', 0.26 * v, 0, { pitchVar: 0.13, filterFreq: 1100 });
    noiseBurst(0.095, 0.2 * v, 0, { freq: 850, freqEnd: 220, q: 1.3 });
  },
  kick(v = 1) {
    tone(145, 42, 0.18, 'sawtooth', 0.28 * v, 0, { pitchVar: 0.1, filterFreq: 720 });
    tone(95, 36, 0.22, 'sine', 0.3 * v, 0, { pitchVar: 0.08 });
    noiseBurst(0.12, 0.22 * v, 0, { pink: true, freq: 540, freqEnd: 140, q: 1.1 });
  },
  stagger(v = 1) {
    tone(220, 125, 0.12, 'triangle', 0.16 * v, 0, { pitchVar: 0.12 });
    noiseBurst(0.07, 0.1 * v, 0, { pink: true, freq: 720, freqEnd: 280, q: 1.4 });
  },
  zap(v = 1) {
    tone(740, 82, 0.34, 'sawtooth', 0.26 * v, 0, { pitchVar: 0.11, filterFreq: 2800, filterEndFreq: 240 });
    tone(360, 62, 0.32, 'square', 0.18 * v, 0.02, { pitchVar: 0.11, filterFreq: 1600 });
    noiseBurst(0.075, 0.16 * v, 0, { freq: 2200, freqEnd: 420, q: 1.2 });
  },
  explosion(v = 1) {
    tone(130, 28, 0.55, 'sawtooth', 0.34 * v, 0, { pitchVar: 0.1, filterFreq: 420, filterEndFreq: 60 });
    tone(85, 22, 0.62, 'sine', 0.36 * v, 0.01, { pitchVar: 0.08 });
    noiseBurst(0.52, 0.32 * v, 0, { pink: true, freq: 680, freqEnd: 95, q: 0.8, attack: 0.01 });
  },
  reloadStart(v = 1) {
    tone(320, 480, 0.07, 'triangle', 0.13 * v, 0, { pitchVar: 0.06 });
    noiseBurst(0.045, 0.09 * v, 0.02, { freq: 1800, q: 2.5 });
  },
  reloadDone(v = 1) {
    tone(480, 720, 0.08, 'triangle', 0.15 * v, 0, { pitchVar: 0.05 });
    tone(720, 980, 0.11, 'sine', 0.15 * v, 0.06, { pitchVar: 0.05 });
  },
  emptyClick(v = 1) {
    tone(820, 340, 0.04, 'square', 0.12 * v, 0, { pitchVar: 0.08, filterFreq: 1900 });
  },
  pickup(v = 1) {
    tone(390, 680, 0.1, 'triangle', 0.15 * v, 0, { pitchVar: 0.08 });
    tone(680, 920, 0.12, 'sine', 0.13 * v, 0.06, { pitchVar: 0.08 });
  },
  drop(v = 1) {
    tone(360, 165, 0.12, 'triangle', 0.14 * v, 0, { pitchVar: 0.09 });
  },
  heal(v = 1) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone(f, f * 1.02, 0.22, 'sine', 0.13 * v, i * 0.055, { pitchVar: 0.04 })
    );
  },
  shieldBlock(v = 1) {
    tone(640, 290, 0.16, 'triangle', 0.22 * v, 0, { pitchVar: 0.09 });
    tone(1120, 880, 0.12, 'sine', 0.14 * v, 0.01, { pitchVar: 0.1 });
  },
  click(v = 1) {
    tone(760, 420, 0.045, 'triangle', 0.13 * v, 0, { pitchVar: 0.08 });
  },
  buttonPress(v = 1) {
    tone(540, 320, 0.065, 'square', 0.13 * v, 0, { pitchVar: 0.07, filterFreq: 1600 });
    tone(680, 860, 0.075, 'triangle', 0.11 * v, 0.04, { pitchVar: 0.07 });
  },
  leverPull(v = 1) {
    tone(280, 190, 0.08, 'sawtooth', 0.14 * v, 0, { pitchVar: 0.09, filterFreq: 950 });
    tone(420, 610, 0.09, 'triangle', 0.14 * v, 0.055, { pitchVar: 0.09 });
  },
  teleport(v = 1) {
    tone(260, 1280, 0.32, 'sine', 0.18 * v, 0, { pitchVar: 0.07 });
    tone(520, 240, 0.28, 'triangle', 0.13 * v, 0.06, { pitchVar: 0.08 });
    noiseBurst(0.22, 0.1 * v, 0, { pink: true, freq: 600, freqEnd: 2400, q: 2.2 });
  },
  checkpoint(v = 1) {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) =>
      tone(f, f, 0.28, 'triangle', 0.15 * v, i * 0.06, { pitchVar: 0.03 })
    );
  },
  gate(v = 1) {
    [392, 493.88, 587.33, 783.99, 1046.5, 1318.5].forEach((f, i) =>
      tone(f, f, 0.58, 'sine', 0.14 * v, i * 0.08, { pitchVar: 0.03 })
    );
  },
  splash(v = 1) {
    tone(260, 95, 0.22, 'sine', 0.20 * v, 0, { pitchVar: 0.12 });
    tone(160, 70, 0.28, 'triangle', 0.16 * v, 0.03, { pitchVar: 0.12 });
    noiseBurst(0.24, 0.18 * v, 0, { pink: true, freq: 950, freqEnd: 280, q: 1.1 });
  },
  gas(v = 1) {
    tone(180, 420, 0.35, 'sine', 0.11 * v, 0, { pitchVar: 0.1 });
    noiseBurst(0.32, 0.14 * v, 0, { pink: true, freq: 1600, freqEnd: 650, q: 1.5 });
  },
  gizmoTick(v = 1) {
    tone(920, 640, 0.022, 'sine', 0.055 * v, 0, { pitchVar: 0.05 });
  },
  spawnPop(v = 1) {
    tone(310, 690, 0.095, 'sine', 0.14 * v, 0, { pitchVar: 0.09 });
  },
  undo(v = 1) {
    tone(560, 330, 0.09, 'triangle', 0.12 * v, 0, { pitchVar: 0.05 });
  },
  clap(v = 1) {
    noiseBurst(0.055, 0.16 * v, 0, { pink: true, freq: 1550, freqEnd: 750, q: 2.2, attack: 0.003 });
    tone(420, 190, 0.04, 'triangle', 0.08 * v, 0, { pitchVar: 0.12 });
  },
  laugh(v = 1) {
    [520, 610, 560, 660].forEach((f, i) => {
      tone(f, f * 0.78, 0.11, 'triangle', 0.12 * v, i * 0.12, { pitchVar: 0.1 });
    });
  },
  emoteWave(v = 1) {
    tone(440, 660, 0.11, 'sine', 0.12 * v, 0, { pitchVar: 0.08 });
    tone(660, 880, 0.14, 'triangle', 0.11 * v, 0.08, { pitchVar: 0.08 });
  },
  emoteNo(v = 1) {
    tone(310, 260, 0.11, 'triangle', 0.13 * v, 0, { pitchVar: 0.07 });
    tone(250, 185, 0.15, 'triangle', 0.13 * v, 0.12, { pitchVar: 0.07 });
  }
};

/* ---------- ПРОЦЕДУРНЫЙ СИНТЕЗАТОР ФОНОВОЙ МУЗЫКИ ---------- */

const N = {
  C2: 65.41, D2: 73.42, Eb2: 77.78, E2: 82.41, F2: 87.31, G2: 98.00, Ab2: 103.83, A2: 110.00, Bb2: 116.54, B2: 123.47,
  C3: 130.81, D3: 146.83, Eb3: 155.56, E3: 164.81, F3: 174.61, Fs3: 185.00, G3: 196.00, Ab3: 207.65, A3: 220.00, Bb3: 233.08, B3: 246.94,
  C4: 261.63, D4: 293.66, Eb4: 311.13, E4: 329.63, F4: 349.23, Fs4: 369.99, G4: 392.00, Ab4: 415.30, A4: 440.00, Bb4: 466.16, B4: 493.88,
  C5: 523.25, D5: 587.33, Eb5: 622.25, E5: 659.25, F5: 698.46, Fs5: 739.99, G5: 783.99, A5: 880.00, B5: 987.77, C6: 1046.5, D6: 1174.66, E6: 1318.5
};

function stopCurrentMusic() {
  if (musicTimerId) {
    clearInterval(musicTimerId);
    musicTimerId = null;
  }
  if (customMusicSource) {
    try { customMusicSource.stop(); } catch (_) {}
    customMusicSource = null;
  }
}

export function setWorldMusic(presetId = 'none') {
  currentMusicId = presetId || 'none';
  if (S.worldSettings) S.worldSettings.musicPreset = currentMusicId;
  stopCurrentMusic();
  if (!AC || currentMusicId === 'none') return;

  if (currentMusicId.startsWith('custom:')) {
    playCustomAudioById(currentMusicId, {
      bus: 'music',
      loop: true,
      pitchVar: 0,
      vol: 0.85,
      onSourceCreated: src => { customMusicSource = src; }
    });
    return;
  }

  musicStep = 0;

  // 1. 😇 СВЕТЛЫЙ РАЙ (Арфа, Челеста и Солнечный Канон в C-Major — добрая, чистая и радостная мелодия)
  if (currentMusicId === 'heaven_choir') {
    const canonChords = [
      { bass: N.C3, arp: [N.C4, N.E4, N.G4, N.C5, N.E5, N.G5, N.C5, N.G4] }, // C major
      { bass: N.G2, arp: [N.B3, N.D4, N.G4, N.B4, N.D5, N.G5, N.B4, N.G4] }, // G major
      { bass: N.A2, arp: [N.C4, N.E4, N.A4, N.C5, N.E5, N.G5, N.C5, N.A4] }, // Am7 (мягкий)
      { bass: N.F2, arp: [N.A3, N.C4, N.F4, N.A4, N.C5, N.F5, N.C5, N.A4] }  // F major
    ];
    const sweetMelody = [
      N.E5, 0, N.G5, 0, N.D5, 0, N.G5, 0,
      N.C5, 0, N.E5, N.G5, N.A5, 0, N.G5, 0
    ];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const bar = Math.floor(step / 8) % canonChords.length;
      const cur = canonChords[bar];
      const sub = step % 8;

      // Мягкий тёплый бас-пэд на сильную долю
      if (sub === 0) {
        tone(cur.bass, cur.bass, 1.9, 'sine', 0.11, 0, { bus: 'music', attack: 0.15, pitchVar: 0.002 });
        tone(cur.bass * 2, cur.bass * 2, 1.7, 'triangle', 0.05, 0, { bus: 'music', attack: 0.18, filterFreq: 950, pitchVar: 0.003 });
      }

      // Перебор золотой арфы (короткая атака + нежный спад без гудения)
      const harpNote = cur.arp[sub];
      tone(harpNote, harpNote, 0.52, 'triangle', 0.065, 0, { bus: 'music', attack: 0.01, filterFreq: 1850, pitchVar: 0.004 });

      // Светлая мелодия челесты / колокольчика
      const mel = sweetMelody[step % sweetMelody.length];
      if (mel > 0) {
        tone(mel, mel, 0.65, 'sine', 0.06, 0.01, { bus: 'music', attack: 0.012, pitchVar: 0.003 });
        tone(mel * 2, mel * 2, 0.35, 'sine', 0.02, 0.015, { bus: 'music', attack: 0.01, pitchVar: 0.003 });
      }
    }, 240);
  }

  // 2. 🌾 УЮТНАЯ ФЕРМА / ДЕРЕВНЯ (в духе Stardew Valley — G-Major, гитара-кантри, маримба и флейта)
  else if (currentMusicId === 'stardew_farm') {
    const prog = [
      { root: N.G2, fifth: N.D3, chord: [N.G3, N.B3, N.D4, N.G4] }, // G
      { root: N.C3, fifth: N.G2, chord: [N.C4, N.E4, N.G4, N.B4] }, // Cmaj7
      { root: N.E2, fifth: N.B2, chord: [N.G3, N.B3, N.D4, N.E4] }, // Em7
      { root: N.D3, fifth: N.A2, chord: [N.A3, N.D4, N.Fs4, N.A4] } // D
    ];
    const fluteNotes = [
      N.B4, N.D5, N.G5, N.Fs5, N.E5, N.D5, N.B4, 0,
      N.G4, N.A4, N.B4, N.D5, N.E5, 0, N.D5, 0
    ];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const bar = Math.floor(step / 8) % prog.length;
      const ch = prog[bar];
      const sub = step % 8;

      // Прыгучий деревенский бас (Root - Fifth на 1 и 5 долю)
      if (sub === 0 || sub === 4) {
        const bFreq = sub === 0 ? ch.root : ch.fifth;
        tone(bFreq, bFreq, 0.36, 'triangle', 0.13, 0, { bus: 'music', attack: 0.008, filterFreq: 650, pitchVar: 0.004 });
      }

      // Акустический гитарный перебор / маримба
      const pickNote = ch.chord[sub % ch.chord.length];
      tone(pickNote, pickNote, 0.24, 'triangle', 0.065, 0, { bus: 'music', attack: 0.006, filterFreq: 1600, pitchVar: 0.006 });

      // Деревянный шейкер на слабую долю
      if (sub === 2 || sub === 6) {
        noiseBurst(0.035, 0.03, 0, { bus: 'music', pink: true, freq: 3400, q: 2.2 });
      }

      // Пасторальная флейта / деревянный ксилофон
      const fl = fluteNotes[step % fluteNotes.length];
      if (fl > 0) {
        tone(fl, fl, 0.42, 'sine', 0.068, 0.01, { bus: 'music', attack: 0.035, pitchVar: 0.006 });
        tone(fl * 0.5, fl * 0.5, 0.18, 'triangle', 0.035, 0, { bus: 'music', attack: 0.005, filterFreq: 1200, pitchVar: 0.005 });
      }
    }, 225);
  }

  // 3. 🎻 ЭПИЧЕСКИЙ ОРКЕСТР (Масштабные битвы — D-Minor, медные валторны, марш литавр и хор струнных)
  else if (currentMusicId === 'epic_orchestra') {
    const epicBars = [
      { bass: N.D2, brass: [N.D3, N.A3, N.D4] },  // Dm
      { bass: N.Bb2 * 0.5, brass: [N.Bb2, N.F3, N.D4] }, // Bb
      { bass: N.G2, brass: [N.G2, N.D3, N.Bb3] }, // Gm
      { bass: N.A2, brass: [N.A2, N.E3, N.C4 + 15.5] } // A major (C#4 = 277.18)
    ];
    const heroMelody = [
      N.D4, N.D4, N.A4, N.A4, N.Bb4, N.A4, N.G4, N.F4,
      N.G4, N.A4, N.F4, N.D4, N.E4, N.F4, N.E4, N.C4 + 15.5
    ];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const bar = Math.floor(step / 8) % epicBars.length;
      const cur = epicBars[bar];
      const sub = step % 8;

      // Стаккато низких струнных (виолончели и контрабасы — маршевый ритм)
      if (sub === 0 || sub === 2 || sub === 3 || sub === 4 || sub === 6 || sub === 7) {
        tone(cur.bass, cur.bass, 0.17, 'sawtooth', 0.11, 0, { bus: 'music', attack: 0.015, filterFreq: 480, pitchVar: 0.008 });
      }

      // Мощный аккорд медных духовых (валторны / тромбоны) в начале такта
      if (sub === 0) {
        cur.brass.forEach(f => {
          tone(f, f, 1.35, 'sawtooth', 0.058, 0, { bus: 'music', attack: 0.12, filterFreq: 1150, detuneCents: 6, pitchVar: 0.008 });
        });
      }

      // Героическая мелодия высоких струнных и труб
      if (sub % 2 === 0) {
        const mNote = heroMelody[Math.floor(step / 2) % heroMelody.length];
        tone(mNote, mNote, 0.38, 'sawtooth', 0.068, 0, { bus: 'music', attack: 0.035, filterFreq: 1950, detuneCents: 8, pitchVar: 0.008 });
        tone(mNote * 2, mNote * 2, 0.34, 'triangle', 0.035, 0.01, { bus: 'music', attack: 0.04, filterFreq: 2400, pitchVar: 0.008 });
      }

      // Оркестровые литавры (Timpani) и боевой малый барабан
      if (sub === 0 || sub === 4) {
        tone(cur.bass * 1.5, cur.bass * 0.75, 0.28, 'sine', 0.17, 0, { bus: 'music', attack: 0.006, pitchVar: 0.015 });
      }
      if (sub === 4 || sub === 7) {
        noiseBurst(0.11, 0.075, 0, { bus: 'music', pink: true, freq: 1350, freqEnd: 450, q: 1.3 });
      }
    }, 185);
  }

  // 4. 🎷 БЭКРУМС ДЖАЗ (Атмосферный расстроенный лоу-фай джаз в пустом холле — Caretaker / Liminal Lounge)
  else if (currentMusicId === 'backrooms_jazz') {
    const jazzBars = [
      { walk: [N.D2, N.F2, N.A2, N.Ab2], chord: [N.F3, N.A3, N.C4, N.E4] },  // Dm9
      { walk: [N.G2, N.B2, N.D3, N.Db3 || 138.59], chord: [N.F3, N.A3, N.B3, N.E4] }, // G13
      { walk: [N.C2, N.E2, N.G2, N.A2], chord: [N.E3, N.G3, N.B3, N.D4] },   // Cmaj9
      { walk: [N.A2, N.G2, N.E2, N.Eb2], chord: [N.G3, N.C4 + 15.5, N.F4, N.A4] } // A7alt
    ];
    const muteHorn = [N.E4, N.G4, N.A4, N.B4, N.D5, N.C5, N.A4, N.G4, N.F4];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const bar = Math.floor(step / 8) % jazzBars.length;
      const jb = jazzBars[bar];
      const sub = step % 8;

      // Эффект плывущей виниловой пластинки (Tape Wow & Flutter)
      const tapeFlutter = Math.sin(step * 0.45) * 16;

      // Мягкий шагающий контрабас (Walking Upright Bass) каждые 2 шага
      if (sub % 2 === 0) {
        const wNote = jb.walk[(sub / 2) % jb.walk.length];
        tone(wNote, wNote * 0.99, 0.55, 'sine', 0.14, 0, {
          bus: 'music', attack: 0.018, detuneCents: tapeFlutter, pitchVar: 0.008
        });
      }

      // Приглушённое ретро-пианино с лёгким опозданием (свинг)
      if (sub === 0 || sub === 3 || sub === 6) {
        jb.chord.forEach((f, idx) => {
          tone(f, f * 0.996, 0.95, 'triangle', 0.042, idx * 0.028, {
            bus: 'music', attack: 0.03, filterFreq: 760, detuneCents: tapeFlutter, pitchVar: 0.012
          });
        });
      }

      // Далёкая задумчивая труба с сурдиной / вибрафоном из соседнего коридора
      if (sub === 2 || (sub === 5 && Math.random() < 0.65)) {
        const hNote = pick(muteHorn);
        tone(hNote, hNote * 0.992, 0.85, 'sine', 0.045, 0.03, {
          bus: 'music', attack: 0.08, filterFreq: 900, detuneCents: tapeFlutter + 8, pitchVar: 0.015
        });
      }

      // Джазовые щётки по малому барабану и мягкий шорох винила
      if (sub % 2 === 0) {
        noiseBurst(0.14, 0.026, 0, { bus: 'music', pink: true, freq: 2100, q: 1.6, attack: 0.03 });
      } else {
        noiseBurst(0.05, 0.018, 0.04, { bus: 'music', freq: 4200, q: 3.0 });
      }
    }, 320);
  }

  // 5. 🎮 ЧИПТЮН-АРКАДА (Весёлый Обби)
  else if (currentMusicId === 'obby_arcade') {
    const bass = [N.C3, N.C3, N.G2, N.G2, N.A2, N.A2, N.F2, N.G2];
    const lead = [
      N.C5, N.E5, N.G5, N.E5, N.A5, N.G5, N.E5, N.D5,
      N.C5, N.D5, N.E5, N.G5, N.A5, N.G5, N.F5, N.D5
    ];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const bNote = bass[Math.floor(step / 2) % bass.length];
      tone(bNote, bNote, 0.16, 'triangle', 0.13, 0, { bus: 'music', attack: 0.008, pitchVar: 0.005 });

      const lNote = lead[step % lead.length];
      if (step % 2 === 0 || Math.random() < 0.75) {
        tone(lNote, lNote, 0.14, 'square', 0.075, 0, { bus: 'music', attack: 0.006, filterFreq: 2600, pitchVar: 0.01 });
      }
      if (step % 4 === 0) {
        tone(135, 38, 0.09, 'sine', 0.15, 0, { bus: 'music', pitchVar: 0.02 });
      } else if (step % 2 === 1) {
        noiseBurst(0.035, 0.045, 0, { bus: 'music', freq: 5200, q: 2.5 });
      }
    }, 185);
  }

  // 6. 🌌 КИБЕР-СИНТВЕЙВ (Неоновая Ночь)
  else if (currentMusicId === 'cyber_synth') {
    const roots = [N.D2, N.Bb2, N.G2, N.A2];
    const arpOffsets = [1, 1.5, 2, 1.5, 2.4, 2, 1.5, 1.2];
    const leadPhrase = [N.D5, N.F5, N.A5, N.G5, N.F5, N.E5, N.D5, N.A4];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const root = roots[Math.floor(step / 16) % roots.length];
      tone(root, root, 0.17, 'sawtooth', 0.13, 0, { bus: 'music', attack: 0.008, filterFreq: 520, filterEndFreq: 160, pitchVar: 0.008 });

      const mult = arpOffsets[step % arpOffsets.length];
      tone(root * 2 * mult, root * 2 * mult, 0.15, 'sawtooth', 0.065, 0, { bus: 'music', attack: 0.01, filterFreq: 1900, pitchVar: 0.01 });

      if (step % 4 === 0) {
        const ln = leadPhrase[Math.floor(step / 4) % leadPhrase.length];
        tone(ln, ln, 0.55, 'sawtooth', 0.06, 0, { bus: 'music', attack: 0.04, filterFreq: 2400, detuneCents: 10, pitchVar: 0.01 });
      }
      if (step % 4 === 0) {
        tone(125, 34, 0.12, 'sine', 0.17, 0, { bus: 'music', pitchVar: 0.02 });
      } else if (step % 4 === 2) {
        noiseBurst(0.11, 0.09, 0, { bus: 'music', pink: true, freq: 1400, freqEnd: 400, q: 1.0 });
      }
    }, 195);
  }

  // 7. 🏰 МРАЧНЫЙ ДАНЖЕН (Тёмное Фэнтези)
  else if (currentMusicId === 'dungeon_dark') {
    const droneNotes = [N.D2, N.Eb2, N.C2, N.D2];
    const mysteryNotes = [N.D4, N.Eb4, N.G4, N.A4, N.Bb4, N.Fs4, N.D4];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      if (step % 6 === 0) {
        const dr = droneNotes[Math.floor(step / 6) % droneNotes.length];
        tone(dr, dr, 2.8, 'sawtooth', 0.11, 0, { bus: 'music', attack: 0.6, filterFreq: 290, pitchVar: 0.01 });
        tone(dr * 1.5, dr * 1.5, 2.6, 'triangle', 0.07, 0.08, { bus: 'music', attack: 0.7, filterFreq: 480, pitchVar: 0.01 });
      }
      if (step % 3 === 0) {
        tone(78, 36, 0.28, 'sine', 0.14, 0, { bus: 'music', pitchVar: 0.04 });
      }
      if (step % 2 === 1 && Math.random() < 0.7) {
        const mn = pick(mysteryNotes);
        tone(mn, mn * 0.995, 0.95, 'sine', 0.055, 0, { bus: 'music', attack: 0.02, pitchVar: 0.02 });
      }
    }, 440);
  }

  // 8. 🌱 ЛОУ-ФАЙ ПЕСОЧНИЦА (Мягкий Билдер)
  else if (currentMusicId === 'chill_sandbox') {
    const jazzChords = [
      [N.F3, N.A3, N.C4, N.E4],
      [N.E3, N.G3, N.B3, N.D4],
      [N.D3, N.F3, N.A3, N.C4],
      [N.G3, N.B3, N.D4, N.E4]
    ];
    const penta = [N.A4, N.C5, N.D5, N.E5, N.G5, N.E5, N.D5, N.C5];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const ch = jazzChords[Math.floor(step / 8) % jazzChords.length];
      if (step % 8 === 0) {
        ch.forEach((f, idx) => {
          tone(f, f, 1.9, 'triangle', 0.065, idx * 0.035, { bus: 'music', attack: 0.04, filterFreq: 1100, pitchVar: 0.008 });
        });
        tone(ch[0] * 0.5, ch[0] * 0.5, 1.6, 'sine', 0.11, 0, { bus: 'music', attack: 0.03, pitchVar: 0.005 });
      }
      if (step % 2 === 0 && Math.random() < 0.8) {
        const pn = penta[(step / 2 + Math.floor(Math.random() * 2)) % penta.length];
        tone(pn, pn, 0.48, 'sine', 0.055, 0, { bus: 'music', attack: 0.015, pitchVar: 0.01 });
      }
      if (step % 4 === 2) {
        noiseBurst(0.04, 0.03, 0, { bus: 'music', pink: true, freq: 2400, q: 1.8 });
      }
    }, 310);
  }

  // 9. ⚔️ БОЕВОЙ СИНТ-РОК (Арена / Боссфайт)
  else if (currentMusicId === 'action_boss') {
    const riff = [N.E2, N.E2, N.G2, N.E2, N.A2, N.Ab2, N.G2, N.F2];
    const stabs = [N.E4, N.G4, N.Bb4, N.A4];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const rf = riff[step % riff.length];
      tone(rf, rf, 0.14, 'sawtooth', 0.15, 0, { bus: 'music', attack: 0.005, filterFreq: 850, pitchVar: 0.015 });
      tone(rf * 2, rf * 2, 0.13, 'square', 0.08, 0, { bus: 'music', attack: 0.005, filterFreq: 1400, pitchVar: 0.015 });

      if (step % 4 === 0) {
        const st = stabs[Math.floor(step / 4) % stabs.length];
        tone(st, st * 0.98, 0.22, 'sawtooth', 0.085, 0, { bus: 'music', filterFreq: 2600, pitchVar: 0.02 });
      }
      if (step % 2 === 0) {
        tone(150, 36, 0.09, 'sine', 0.18, 0, { bus: 'music', pitchVar: 0.03 });
      } else {
        noiseBurst(0.06, 0.09, 0, { bus: 'music', freq: 1850, q: 1.4 });
      }
    }, 155);
  }

  // 10. 👁️ БОЖЕСТВЕННЫЙ ХОРРОР (Сохранена та самая мистическая лидийская тема)
  else if (currentMusicId === 'heaven_horror') {
    const chords = [
      [N.C3, N.G3, N.B3, N.E4],
      [N.D3, N.A3, N.Fs4, N.A4],
      [N.E3, N.B3, N.G4, N.D5],
      [N.F3, N.C4, N.A4, N.E5]
    ];
    const arp = [N.E4, N.G4, N.B4, N.D5, N.E5, N.Fs5, N.G5, N.E5];
    musicTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      const step = musicStep++;
      const chord = chords[Math.floor(step / 8) % chords.length];
      if (step % 8 === 0) {
        chord.forEach(freq => {
          tone(freq, freq, 2.7, 'sine', 0.08, 0, { bus: 'music', attack: 0.75, pitchVar: 0.008 });
          tone(freq * 2, freq * 2, 2.4, 'triangle', 0.03, 0.05, { bus: 'music', attack: 0.8, filterFreq: 1400, pitchVar: 0.01 });
        });
      }
      const note = arp[step % arp.length];
      tone(note, note, 0.55, 'sine', 0.065, 0, { bus: 'music', attack: 0.02, pitchVar: 0.012 });
    }, 340);
  }
}

/* ---------- ПРОЦЕДУРНЫЕ ФОНОВЫЕ ЗВУКИ ЛОКАЦИЙ (AMBIENCE) ---------- */

function stopCurrentAmbience() {
  if (ambienceTimerId) {
    clearInterval(ambienceTimerId);
    ambienceTimerId = null;
  }
  for (const n of ambienceNodes) {
    try { n.stop?.(); } catch (_) {}
    try { n.disconnect?.(); } catch (_) {}
  }
  ambienceNodes = [];
  if (customAmbienceSource) {
    try { customAmbienceSource.stop(); } catch (_) {}
    customAmbienceSource = null;
  }
}

function createContinuousNoiseDrone(opts = {}) {
  if (!AC || !noiseBufferPink) return;
  const src = AC.createBufferSource();
  src.buffer = opts.white ? noiseBufferWhite : noiseBufferPink;
  src.loop = true;
  src.playbackRate.value = opts.rate || 1.0;

  const flt = AC.createBiquadFilter();
  flt.type = opts.filterType || 'lowpass';
  flt.frequency.value = opts.freq || 420;
  flt.Q.value = opts.q ?? 0.7;

  const lfo = AC.createOscillator();
  const lfoGain = AC.createGain();
  lfo.frequency.value = opts.lfoRate || 0.16;
  lfoGain.gain.value = opts.lfoDepth || 180;
  lfo.connect(lfoGain);
  lfoGain.connect(flt.frequency);

  const g = AC.createGain();
  g.gain.value = opts.vol ?? 0.16;

  src.connect(flt);
  flt.connect(g);
  g.connect(ambienceGain || masterGain);

  src.start(0);
  lfo.start(0);
  ambienceNodes.push(src, lfo, lfoGain, flt, g);
}

function createHumOscillator(freq, type, vol, filterFreq = 400) {
  if (!AC) return;
  const osc = AC.createOscillator();
  const flt = AC.createBiquadFilter();
  const g = AC.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  flt.type = 'lowpass';
  flt.frequency.value = filterFreq;
  g.gain.value = vol;
  osc.connect(flt);
  flt.connect(g);
  g.connect(ambienceGain || masterGain);
  osc.start(0);
  ambienceNodes.push(osc, flt, g);
}

export function setWorldAmbience(presetId = 'none') {
  currentAmbienceId = presetId || 'none';
  if (S.worldSettings) S.worldSettings.ambiencePreset = currentAmbienceId;
  stopCurrentAmbience();
  if (!AC || currentAmbienceId === 'none') return;

  if (currentAmbienceId.startsWith('custom:')) {
    playCustomAudioById(currentAmbienceId, {
      bus: 'ambience',
      loop: true,
      pitchVar: 0,
      vol: 0.85,
      onSourceCreated: src => { customAmbienceSource = src; }
    });
    return;
  }

  // 1. ☀️ СВЕТЛЫЙ РАЙ (Мягкий тёплый ветерок без завываний, утренние птички и мажорный хрустальный перезвон)
  if (currentAmbienceId === 'heaven_wind') {
    createContinuousNoiseDrone({ filterType: 'lowpass', freq: 340, q: 0.5, lfoRate: 0.08, lfoDepth: 90, vol: 0.09 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      // Чистый мажорный перезвон ветряных колокольчиков (C6 - D6 - E6 - G6)
      if (Math.random() < 0.7) {
        const n1 = pick([N.C6, N.D6, N.E6, 1567.98]);
        const n2 = pick([N.E6, 1567.98, 1760.0]);
        tone(n1, n1, 0.9, 'sine', 0.032, 0, { bus: 'ambience', attack: 0.02, pitchVar: 0.005 });
        tone(n2, n2, 1.1, 'sine', 0.026, 0.16, { bus: 'ambience', attack: 0.02, pitchVar: 0.005 });
      }
      // Далёкая добрая трель птички
      if (Math.random() < 0.45) {
        const bf = rnd(2100, 2700);
        tone(bf, bf * 1.22, 0.075, 'sine', 0.028, 0.35, { bus: 'ambience', pitchVar: 0.04 });
        tone(bf * 1.15, bf * 1.35, 0.085, 'sine', 0.025, 0.46, { bus: 'ambience', pitchVar: 0.04 });
      }
    }, 1500);
  }

  // 2. 🌾 ДЕРЕВНЯ И ФЕРМА (Шелест листвы, ручеёк, птицы и уютные сверчки)
  else if (currentAmbienceId === 'farm_village') {
    createContinuousNoiseDrone({ filterType: 'bandpass', freq: 620, q: 0.7, lfoRate: 0.15, lfoDepth: 180, vol: 0.1 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      // Сверчок (серия из 3 быстрых высокочастотных чирпов)
      if (Math.random() < 0.7) {
        for (let i = 0; i < 3; i++) {
          tone(3850, 3920, 0.028, 'sine', 0.022, i * 0.048, { bus: 'ambience', attack: 0.004, pitchVar: 0.02 });
        }
      }
      // Пение деревенской птички
      if (Math.random() < 0.55) {
        const f = rnd(1750, 2450);
        tone(f, f * 1.25, 0.08, 'sine', 0.036, 0.25, { bus: 'ambience', pitchVar: 0.06 });
        tone(f * 1.2, f * 0.95, 0.09, 'sine', 0.032, 0.36, { bus: 'ambience', pitchVar: 0.06 });
      }
    }, 1350);
  }

  // 3. 💡 БЭКРУМС (Электрический гул люминесцентных ламп 60Hz/120Hz, вентиляция и потрескивание дросселя)
  else if (currentAmbienceId === 'backrooms_hum') {
    createHumOscillator(60, 'sawtooth', 0.055, 240);
    createHumOscillator(120, 'triangle', 0.045, 360);
    createContinuousNoiseDrone({ filterType: 'bandpass', freq: 950, q: 2.2, lfoRate: 0.06, lfoDepth: 120, vol: 0.07 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      // Электрическое потрескивание мигающей лампы дневного света
      if (Math.random() < 0.55) {
        noiseBurst(0.035, 0.04, 0, { bus: 'ambience', freq: 2800, q: 3.5 });
        if (Math.random() < 0.5) {
          noiseBurst(0.025, 0.035, 0.06, { bus: 'ambience', freq: 3200, q: 4.0 });
        }
      }
    }, 1250);
  }

  // 4. ⚔️ ПОЛЕ ВЕЛИКОЙ БИТВЫ (Низкий грозовой фронт, далёкие боевые горны и лязг стали вдали)
  else if (currentAmbienceId === 'battlefield_epic') {
    createContinuousNoiseDrone({ filterType: 'lowpass', freq: 210, q: 0.9, lfoRate: 0.11, lfoDepth: 85, vol: 0.22 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      // Далёкий раскат грома / артиллерии
      if (Math.random() < 0.5) {
        noiseBurst(1.1, 0.14, 0, { bus: 'ambience', pink: true, freq: 140, freqEnd: 55, q: 0.8, attack: 0.25 });
      }
      // Боевой рог вдалеке
      if (Math.random() < 0.35) {
        const hornF = pick([N.D3, N.A2, N.G2]);
        tone(hornF, hornF * 1.01, 1.4, 'sawtooth', 0.045, 0.2, { bus: 'ambience', attack: 0.35, filterFreq: 520, pitchVar: 0.01 });
      }
    }, 2200);
  }

  // 5. 🐦 СОЛНЕЧНЫЙ ЛУГ И ЛЕСНЫЕ ПТИЦЫ
  else if (currentAmbienceId === 'sunny_nature') {
    createContinuousNoiseDrone({ filterType: 'lowpass', freq: 520, q: 0.6, lfoRate: 0.16, lfoDepth: 160, vol: 0.11 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      if (Math.random() < 0.75) {
        const baseF = rnd(1800, 2900);
        tone(baseF, baseF * 1.28, 0.085, 'sine', 0.042, 0, { bus: 'ambience', pitchVar: 0.08 });
        tone(baseF * 1.18, baseF * 0.92, 0.095, 'sine', 0.038, 0.11, { bus: 'ambience', pitchVar: 0.08 });
      }
    }, 1500);
  }

  // 6. 💧 ПОДЗЕМЕЛЬЕ, ГУЛ И КАПЛИ ВОДЫ
  else if (currentAmbienceId === 'cave_dungeon') {
    createContinuousNoiseDrone({ filterType: 'lowpass', freq: 190, q: 1.5, lfoRate: 0.09, lfoDepth: 65, vol: 0.24 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      if (Math.random() < 0.8) {
        const dropF = rnd(680, 1250);
        tone(dropF, dropF * 1.65, 0.075, 'sine', 0.055, 0, { bus: 'ambience', attack: 0.004, pitchVar: 0.1 });
        tone(dropF * 1.6, dropF * 2.1, 0.12, 'sine', 0.02, 0.14, { bus: 'ambience', attack: 0.01, pitchVar: 0.1 });
      }
    }, 1150);
  }

  // 7. ⚡ НЕОНОВЫЙ РЕАКТОР И КИБЕР-ГУЛ
  else if (currentAmbienceId === 'cyber_city') {
    createContinuousNoiseDrone({ filterType: 'lowpass', freq: 260, q: 2.2, lfoRate: 0.25, lfoDepth: 110, vol: 0.2 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      tone(110, 112, 1.8, 'sawtooth', 0.038, 0, { bus: 'ambience', attack: 0.4, filterFreq: 340, pitchVar: 0.02 });
    }, 1500);
  }

  // 8. 🌋 ВУЛКАН, РОКОТ И КИПЯЩАЯ ЛАВА
  else if (currentAmbienceId === 'lava_inferno') {
    createContinuousNoiseDrone({ filterType: 'lowpass', freq: 155, q: 1.1, lfoRate: 0.18, lfoDepth: 55, vol: 0.3 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      tone(rnd(95, 190), rnd(220, 360), 0.14, 'sine', 0.07, 0, { bus: 'ambience', pitchVar: 0.15 });
    }, 650);
  }

  // 9. 🌊 МОРСКОЙ ПРИБОЙ И ШУМ ВОЛН
  else if (currentAmbienceId === 'ocean_waves') {
    createContinuousNoiseDrone({ filterType: 'lowpass', freq: 480, q: 0.7, lfoRate: 0.12, lfoDepth: 340, vol: 0.24 });
  }

  // 10. 👁️ ЖУТКИЙ ЭФИР (Сохранённый холодный мистический эмбиент)
  else if (currentAmbienceId === 'eldritch_horror') {
    createContinuousNoiseDrone({ filterType: 'bandpass', freq: 520, q: 2.8, lfoRate: 0.14, lfoDepth: 260, vol: 0.22 });
    ambienceTimerId = setInterval(() => {
      if (!AC || !soundOn || AC.state !== 'running') return;
      if (Math.random() < 0.65) {
        const chime = pick([1046.5, 1108.73, 1318.5, 1479.98]);
        tone(chime, chime * 0.98, 1.6, 'sine', 0.035, 0, { bus: 'ambience', attack: 0.25, pitchVar: 0.04 });
      }
    }, 1400);
  }
}

/* ---------- 3D-ЗВУКИ ОБЪЕКТОВ И АВТОМАТИЧЕСКАЯ ОЗВУЧКА ШАГОВ/ПРИЗЕМЛЕНИЙ ---------- */

let lastPlayerStepVal = 0;
let wasPlayerGrounded = true;
let wasPlayerInLiquid = false;
let spatialZonesTimer = 0;

export function createDefaultSoundData() {
  return {
    soundId: 'sfx:gate',
    mode: 'trigger',
    radius: 18,
    interval: 2.5,
    volume: 0.85,
    pitchVar: 0.1
  };
}

export function updateAudioEngineRuntime(dt) {
  if (!AC || !soundOn) return;

  const p = S.player;
  if (S.state === 'play' && p && !S.playerDead) {
    let floorSurface = 'studs';
    for (let i = 0; i < S.allBlocks.length; i++) {
      const b = S.allBlocks[i];
      if (b._depletedDisabled || b.matterState !== 'solid') continue;
      if (
        p.x >= b.x0 - 0.35 && p.x <= b.x1 + 0.35 &&
        p.z >= b.z0 - 0.35 && p.z <= b.z1 + 0.35 &&
        Math.abs(p.y - b.y1) < 0.45
      ) {
        floorSurface = b.surfaceType || 'studs';
        break;
      }
    }

    if (p.inLiquid && !wasPlayerInLiquid) {
      sfx.splash(0.95);
    } else if (!p.inLiquid && wasPlayerInLiquid) {
      sfx.splash(0.55);
    }
    wasPlayerInLiquid = Boolean(p.inLiquid);

    if (p.grounded && !wasPlayerGrounded) {
      sfx.land(Math.abs(p._lastAirVy || 10), floorSurface, 0.9);
    }
    if (!p.grounded) {
      p._lastAirVy = p.vy;
    }
    wasPlayerGrounded = Boolean(p.grounded);

    if ((p.grounded || p.inLiquid) && Math.abs((p.step || 0) - lastPlayerStepVal) >= 2.15) {
      lastPlayerStepVal = p.step || 0;
      sfx.step(floorSurface, p.inLiquid, 0.85);
    }
  }

  spatialZonesTimer += dt;
  if (spatialZonesTimer >= 0.25) {
    const stepDt = spatialZonesTimer;
    spatialZonesTimer = 0;
    for (let i = 0; i < S.allBlocks.length; i++) {
      const b = S.allBlocks[i];
      if (!b || b.isDisabled || b._depletedDisabled || !b.components?.sound?.enabled || !b.soundData) continue;
      const snd = b.soundData;
      if (snd.mode !== 'zone_loop') continue;
      snd._timer = (snd._timer || 0) - stepDt;
      if (snd._timer <= 0) {
        snd._timer = Math.max(0.4, Number(snd.interval) || 2.5) * rnd(0.88, 1.14);
        playSoundId(snd.soundId || 'sfx:coil', {
          pos: b.m.position,
          maxDist: Math.max(3, Number(snd.radius) || 18),
          vol: Number(snd.volume) ?? 0.85,
          pitchVar: Number(snd.pitchVar) ?? 0.1
        });
      }
    }
  }
}

export function toggleMasterMute() {
  initAudio();
  soundOn = !soundOn;
  if (masterGain && AC) {
    masterGain.gain.setTargetAtTime(soundOn ? 0.8 : 0, AC.currentTime, 0.03);
  }
  const muteBtn = $('muteBtn');
  if (muteBtn) {
    muteBtn.textContent = soundOn ? 'ЗВУК: 🟢' : 'ЗВУК: 🔴';
  }
  return soundOn;
}

const muteBtn = $('muteBtn');
if (muteBtn) {
  muteBtn.addEventListener('click', () => {
    toggleMasterMute();
  });
}