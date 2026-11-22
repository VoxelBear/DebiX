// src/core/ScriptEngine.js
import { S, $, clamp, rnd, showBanner } from './State.js';
import { updateSkybox } from './SceneManager.js';
import { sfx, playSoundId } from './AudioEngine.js';
import { emitParticleBurst } from './ParticleSystem.js';
import {
  updateBlockOBB,
  syncBlockComponentsState,
  syncBlockLightVisuals,
  syncBlockSpecialVisuals
} from './WorldRegistry.js';
import {
  ensureNpcModules,
  refreshEntityTagWithHP,
  updateShopUI
} from './EntityManager.js';

const MAX_LOOP_ITERATIONS_PER_CALL = 5000;
const MAX_FRAME_BUDGET_MS = 3.5;
const MAX_LOGS = 80;

// Запрещённые идентификаторы для защиты от выхода из песочницы
const FORBIDDEN_IDENTIFIERS = [
  'window', 'document', 'globalThis', 'parent', 'top', 'frames', 'opener',
  'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'AsyncGeneratorFunction',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker', 'ServiceWorker',
  'navigator', 'location', 'history', 'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore',
  'import', 'require', 'process', '__proto__', 'prototype', 'constructor', 'Reflect', 'Proxy'
];

const FORBIDDEN_REGEX = new RegExp(`(?<!\\.|\\b(?:const|let|var|function)\\s+)\\b(${FORBIDDEN_IDENTIFIERS.join('|')})\\b(?!:)`);

/* ============================================================================
   1. БИБЛИОТЕКА ГОТОВЫХ ШАБЛОНОВ АДДОНОВ (10 ШАБЛОНОВ)
   ============================================================================ */

export const SCRIPT_TEMPLATES = {
  block: [
    {
      id: 'tpl_blk_magnet',
      name: '🧲 Магнитное / Грави-Поле',
      code: `// Притягивает или отталкивает физические блоки и игрока в радиусе
export const params = {
  force: { type: 'number', default: 28, min: -120, max: 120, step: 2, label: 'Сила (+ тянет, - толкает)' },
  radius: { type: 'number', default: 14, min: 2, max: 50, step: 1, label: 'Радиус поля (м)' },
  affectPlayer: { type: 'boolean', default: true, label: 'Действовать на игрока' },
  activeColor: { type: 'color', default: '#00f2fe', label: 'Цвет активного магнита' }
};

export function onStart(self, api) {
  self.setState('enabled', true);
  self.setColor(self.params.activeColor);
}

export function onTick(self, dt, api) {
  if (!self.getState('enabled', true)) return;
  const myPos = self.getPosition();
  const targets = api.world.getEntitiesInRadius(myPos, self.params.radius);

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.id === self.id) continue;
    if (t.kind === 'player' && !self.params.affectPlayer) continue;

    const tPos = t.getPosition();
    const dist = api.math.dist(myPos, tPos);
    if (dist < 0.8) continue;

    const dir = api.math.directionTo(tPos, myPos);
    const falloff = 1 - (dist / self.params.radius) * 0.6;
    const pull = self.params.force * falloff * dt;
    t.applyImpulse(dir.x * pull, dir.y * pull * 0.65, dir.z * pull);
  }
}

export function onInteract(self, actor, api) {
  const next = !self.getState('enabled', true);
  self.setState('enabled', next);
  self.setColor(next ? self.params.activeColor : '#475569');
  api.audio.playSfx('click', self.getPosition());
  api.ui.showBanner(next ? '🧲 Магнит включён!' : '⚪ Магнит отключён', '#56f0ff');
}`
    },
    {
      id: 'tpl_blk_sine_platform',
      name: '🛗 Парящая Платформа (Синусоида)',
      code: `// Плавно двигает и вращает платформу по математической волне
export const params = {
  heightAmp: { type: 'number', default: 3.5, min: 0, max: 25, step: 0.5, label: 'Амплитуда по Y (м)' },
  horizAmp: { type: 'number', default: 0, min: 0, max: 25, step: 0.5, label: 'Амплитуда по X (м)' },
  speed: { type: 'number', default: 1.6, min: 0.1, max: 8, step: 0.1, label: 'Скорость волны' },
  spinSpeed: { type: 'number', default: 25, min: -180, max: 180, step: 5, label: 'Вращение (°/сек)' }
};

export function onStart(self, api) {
  const pos = self.getPosition();
  self.setState('startX', pos.x);
  self.setState('startY', pos.y);
  self.setState('startZ', pos.z);
}

export function onTick(self, dt, api) {
  const sx = self.getState('startX', 0);
  const sy = self.getState('startY', 2);
  const sz = self.getState('startZ', 0);

  const wave = api.math.sin(api.time * self.params.speed);
  const cosW = api.math.cos(api.time * self.params.speed);

  self.setPosition(
    sx + cosW * self.params.horizAmp,
    sy + wave * self.params.heightAmp,
    sz
  );

  if (self.params.spinSpeed !== 0) {
    self.rotate(0, self.params.spinSpeed * dt, 0);
  }
}`
    },
    {
      id: 'tpl_blk_mine_trap',
      name: '💣 Импульсная Плита-Ловушка',
      code: `// Срабатывает при касании: мигает и отбрасывает все физические объекты и игрока
export const params = {
  blastForce: { type: 'number', default: 18, min: 4, max: 45, step: 1, label: 'Сила взрывной волны' },
  damage: { type: 'number', default: 25, min: 0, max: 100, step: 5, label: 'Урон взрыва' },
  radius: { type: 'number', default: 8, min: 2, max: 25, step: 0.5, label: 'Радиус поражения' },
  cooldown: { type: 'number', default: 3.0, min: 0.5, max: 15, step: 0.5, label: 'Перезарядка (сек)' }
};

export function onCollide(self, other, api) {
  const readyAt = self.getState('readyAt', 0);
  if (api.time < readyAt) return;
  self.setState('readyAt', api.time + self.params.cooldown);

  const pos = self.getPosition();
  api.audio.playSfx('explosion', pos);
  api.world.spawnParticles(pos.x, pos.y + 0.6, pos.z, 18, { color: '#ff3e3e', speed: 6 });

  const targets = api.world.getEntitiesInRadius(pos, self.params.radius);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.id === self.id) continue;
    const dir = api.math.directionTo(pos, t.getPosition());
    t.applyImpulse(dir.x * self.params.blastForce, self.params.blastForce * 0.75, dir.z * self.params.blastForce);
    if (self.params.damage > 0) {
      t.damage(self.params.damage);
    }
  }
}`
    },
    {
      id: 'tpl_blk_weight_plate',
      name: '⚖️ Весовая Плита (Контроль груза)',
      code: `// Проверяет вес физических кубов и игрока сверху и открывает связанную дверь
export const params = {
  requiredKg: { type: 'number', default: 50, min: 5, max: 500, step: 5, label: 'Нужный вес (кг)' },
  targetDoorTag: { type: 'string', default: 'door_1', label: 'Тег или ID двери' },
  readyColor: { type: 'color', default: '#00e676', label: 'Цвет при активации' },
  idleColor: { type: 'color', default: '#ff3e3e', label: 'Цвет ожидания' }
};

export function onTick(self, dt, api) {
  const pos = self.getPosition();
  const scale = self.getScale();
  const radius = Math.max(scale.x, scale.z) * 0.75;
  const near = api.world.getEntitiesInRadius(pos, radius + 1.5);

  let currentKg = 0;
  for (let i = 0; i < near.length; i++) {
    const e = near[i];
    if (e.id === self.id) continue;
    const ePos = e.getPosition();
    if (ePos.y >= pos.y && ePos.y <= pos.y + scale.y + 2.2) {
      currentKg += Math.max(0, e.getWeight());
    }
  }

  const isPressed = currentKg >= self.params.requiredKg;
  const wasPressed = self.getState('pressed', false);

  if (isPressed !== wasPressed) {
    self.setState('pressed', isPressed);
    self.setColor(isPressed ? self.params.readyColor : self.params.idleColor);
    api.audio.playSfx('click', pos);
    self.sendSignal(self.params.targetDoorTag, isPressed ? 'forward_motion' : 'reverse_motion');
    api.ui.showBanner(
      isPressed
        ? '⚖️ Вес достаточен (' + Math.round(currentKg) + ' кг) — проход открыт!'
        : '⚖️ Груз снят — проход закрывается!',
      isPressed ? '#00e676' : '#ffce3a'
    );
  }
}`
    }
  ],

  npc: [
    {
      id: 'tpl_npc_boss_phases',
      name: '👑 Босс: Фаза Ярости на 50% HP',
      code: `// Когда здоровье NPC падает ниже порога — он увеличивается, ускоряется и отбрасывает врагов
export const params = {
  rageHpPct: { type: 'number', default: 50, min: 10, max: 90, step: 5, label: 'Порог ярости (% HP)' },
  rageScale: { type: 'number', default: 1.65, min: 1.0, max: 3.5, step: 0.05, label: 'Размер в ярости' },
  rageSpeed: { type: 'number', default: 9.2, min: 3, max: 18, step: 0.5, label: 'Скорость в ярости' },
  shockwaveForce: { type: 'number', default: 16, min: 0, max: 35, step: 1, label: 'Ударная волна' },
  battleCry: { type: 'string', default: 'ТЕПЕРЬ Я В ЯРОСТИ!! 🔥', label: 'Боевой клич' }
};

export function onStart(self, api) {
  self.setState('enraged', false);
}

export function onDamaged(self, info, api) {
  if (self.getState('enraged', false)) return;
  const hpPct = (self.getHp() / Math.max(1, self.getMaxHp())) * 100;

  if (hpPct <= self.params.rageHpPct && self.getHp() > 0) {
    self.setState('enraged', true);
    self.setScale(self.params.rageScale);
    self.setWalkSpeed(self.params.rageSpeed);
    self.setGait('monster');
    self.say(self.params.battleCry, 5.0);

    const pos = self.getPosition();
    api.audio.playSfx('explosion', pos);
    api.world.spawnParticles(pos.x, pos.y + 1.5, pos.z, 22, { color: '#ff3e3e', speed: 7 });
    api.ui.showBanner('⚠️ ' + self.name + ': ' + self.params.battleCry, '#ff3e3e');

    // Отбрасываем всех вокруг ударной волной
    const targets = api.world.getEntitiesInRadius(pos, 8.0);
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i];
      if (t.id === self.id) continue;
      const dir = api.math.directionTo(pos, t.getPosition());
      t.applyImpulse(dir.x * self.params.shockwaveForce, 7, dir.z * self.params.shockwaveForce);
    }
  }
}`
    },
    {
      id: 'tpl_npc_trainer',
      name: '🧙 Тренер Характеристик за R$',
      code: `// При разговоре [E] прокачивает скорость и макс. HP игрока за монеты R$
export const params = {
  cost: { type: 'number', default: 50, min: 10, max: 1000, step: 10, label: 'Цена тренировки (R$)' },
  bonusHp: { type: 'number', default: 25, min: 0, max: 200, step: 5, label: 'Бонус к Макс. HP' },
  bonusSpeed: { type: 'number', default: 1.2, min: 0, max: 6, step: 0.2, label: 'Бонус к Скорости' }
};

export function onDialogue(self, info, api) {
  const p = api.player;
  if (!p) return;

  if (p.getCash() < self.params.cost) {
    self.say('Приходи, когда накопишь ' + self.params.cost + ' R$ на тренировку! 💪', 4.0);
    return;
  }

  p.addCash(-self.params.cost);
  p.setMaxHp(p.getMaxHp() + self.params.bonusHp);
  p.heal(self.params.bonusHp);
  p.setWalkSpeed(p.getWalkSpeed() + self.params.bonusSpeed);

  const pos = self.getPosition();
  api.audio.playSfx('coin', pos);
  api.world.spawnParticles(pos.x, pos.y + 1.5, pos.z, 16, { color: '#00e676', speed: 5 });
  self.say('Отличная тренировка! Твои силы выросли! ✨', 4.0);
  api.ui.showBanner('💪 Прокачка: +' + self.params.bonusHp + ' HP и +' + self.params.bonusSpeed + ' к скорости!', '#00e676');
}`
    }
  ],

  item: [
    {
      id: 'tpl_itm_grav_gun',
      name: '⚡ Импульсная Грави-Пушка',
      code: `// При использовании (ЛКМ) создаёт направленную грави-волну, раскидывающую блоки и врагов
export const params = {
  pushForce: { type: 'number', default: 24, min: 5, max: 60, step: 1, label: 'Сила импульса' },
  radius: { type: 'number', default: 10, min: 2, max: 25, step: 1, label: 'Радиус захвата (м)' },
  upLift: { type: 'number', default: 6.5, min: 0, max: 20, step: 0.5, label: 'Подброс вверх' },
  waveColor: { type: 'color', default: '#56f0ff', label: 'Цвет грави-волны' }
};

export function onUse(self, info, api) {
  const p = api.player;
  if (!p) return;
  const pPos = p.getPosition();
  const fwd = p.getForward();

  const waveCenter = {
    x: pPos.x + fwd.x * 3.0,
    y: pPos.y + 1.2,
    z: pPos.z + fwd.z * 3.0
  };

  api.audio.playSfx('coil', waveCenter);
  api.world.spawnParticles(waveCenter.x, waveCenter.y, waveCenter.z, 16, {
    color: self.params.waveColor,
    speed: 6.5
  });

  const targets = api.world.getEntitiesInRadius(waveCenter, self.params.radius);
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    if (t.kind === 'player') continue;
    t.applyImpulse(
      fwd.x * self.params.pushForce,
      self.params.upLift,
      fwd.z * self.params.pushForce
    );
  }
}`
    },
    {
      id: 'tpl_itm_vampire_blade',
      name: '🧛 Вампирский Клинок',
      code: `// При попадании по врагу восстанавливает здоровье владельцу
export const params = {
  healPerHit: { type: 'number', default: 12, min: 1, max: 100, step: 1, label: 'Вампиризм (+HP за удар)' },
  extraPush: { type: 'number', default: 6, min: 0, max: 25, step: 1, label: 'Доп. отбрасывание' }
};

export function onHit(self, info, api) {
  const p = api.player;
  if (!p) return;
  p.heal(self.params.healPerHit);

  if (info && info.target) {
    const tPos = info.target.getPosition();
    api.world.spawnParticles(tPos.x, tPos.y + 1.2, tPos.z, 10, { color: '#ff3e3e', speed: 4 });
    const dir = api.math.directionTo(p.getPosition(), tPos);
    info.target.applyImpulse(dir.x * self.params.extraPush, 3, dir.z * self.params.extraPush);
  }
}`
    }
  ],

  world: [
    {
      id: 'tpl_wld_day_night',
      name: '🌍 Динамическая Смена Дня и Ночи',
      code: `// Плавная 4-фазная смена суток (Утро -> День -> Вечер -> Ночь) с градиентом неба, орбитой Солнца и восходом Луны ночью
export const params = {
  cycleSpeed: { type: 'number', default: 0.12, min: 0.01, max: 1.5, step: 0.01, label: 'Скорость течения суток' },
  startPhase: { type: 'number', default: 0.35, min: 0, max: 6.28, step: 0.1, label: 'Начальная фаза (рад)' },
  orbitRadius: { type: 'number', default: 110, min: 50, max: 220, step: 5, label: 'Радиус орбиты светил' },
  morningSkyMid: { type: 'color', default: '#ff9a76', label: 'Горизонт утром (Рассвет)' },
  daySkyTop: { type: 'color', default: '#1565c0', label: 'Верх неба днём' },
  eveningSkyMid: { type: 'color', default: '#ff5e62', label: 'Горизонт вечером (Закат)' },
  nightSkyTop: { type: 'color', default: '#050714', label: 'Верх неба ночью' },
  moonColor: { type: 'color', default: '#dbeafe', label: 'Цвет Луны ночью' },
  moonSize: { type: 'number', default: 15, min: 6, max: 45, step: 1, label: 'Размер Луны' }
};

export function onWorldTick(self, dt, api) {
  const angle = (self.params.startPhase || 0) + api.time * self.params.cycleSpeed;
  const R = self.params.orbitRadius || 110;

  const cosA = api.math.cos(angle);
  const sinA = api.math.sin(angle);

  const sunX = cosA * R;
  const sunY = sinA * R;
  const sunZ = sinA * (R * 0.34);

  const moonX = -sunX;
  const moonY = -sunY;
  const moonZ = -sunZ;

  const morning = {
    cTop: '#1e3c72',
    cMid: self.params.morningSkyMid || '#ff9a76',
    cBot: '#ffeaa7',
    cFog: '#f3a683',
    cSun: '#ffb142'
  };
  const day = {
    cTop: self.params.daySkyTop || '#1565c0',
    cMid: '#62b6ff',
    cBot: '#dff4ff',
    cFog: '#88ccff',
    cSun: '#fff6dd'
  };
  const evening = {
    cTop: '#2c1654',
    cMid: self.params.eveningSkyMid || '#ff5e62',
    cBot: '#ff9966',
    cFog: '#e56b6f',
    cSun: '#ff6348'
  };
  const night = {
    cTop: self.params.nightSkyTop || '#050714',
    cMid: '#0f172a',
    cBot: '#1e293b',
    cFog: '#0f172a',
    cSun: '#1e293b'
  };

  const twilight = cosA >= 0 ? morning : evening;

  let skyTop, skyMid, skyBot, fogCol, sunCol;
  if (sinA >= 0) {
    const tDay = api.math.smoothstep(0.0, 0.68, sinA);
    skyTop = api.math.lerpColor(twilight.cTop, day.cTop, tDay);
    skyMid = api.math.lerpColor(twilight.cMid, day.cMid, tDay);
    skyBot = api.math.lerpColor(twilight.cBot, day.cBot, tDay);
    fogCol = api.math.lerpColor(twilight.cFog, day.cFog, tDay);
    sunCol = api.math.lerpColor(twilight.cSun, day.cSun, tDay);
  } else {
    const tNight = api.math.smoothstep(0.0, 0.55, -sinA);
    skyTop = api.math.lerpColor(twilight.cTop, night.cTop, tNight);
    skyMid = api.math.lerpColor(twilight.cMid, night.cMid, tNight);
    skyBot = api.math.lerpColor(twilight.cBot, night.cBot, tNight);
    fogCol = api.math.lerpColor(twilight.cFog, night.cFog, tNight);
    sunCol = twilight.cSun;
  }

  const isSunVisible = sinA > -0.04;
  const isMoonVisible = sinA < 0.08;

  const sunIntensity = isSunVisible ? api.math.clamp(sinA * 1.35 + 0.18, 0.12, 1.35) : 0;
  const hemiIntensity = isSunVisible
    ? api.math.clamp(0.42 + sinA * 0.52, 0.4, 0.95)
    : api.math.clamp(0.28 + (-sinA) * 0.08, 0.26, 0.38);

  api.world.setSunState({
    enabled: isSunVisible,
    x: sunX,
    y: sunY,
    z: sunZ,
    intensity: sunIntensity,
    hemiIntensity: hemiIntensity,
    color: sunCol,
    shellColor: sunCol
  });

  api.world.setMoonState({
    enabled: isMoonVisible,
    x: moonX,
    y: Math.max(6, moonY),
    z: moonZ,
    size: self.params.moonSize || 15,
    color: self.params.moonColor || '#dbeafe',
    glow: true
  });

  api.world.setSkyColors(skyTop, skyMid, skyBot, fogCol);
}`
    },
    {
      id: 'tpl_wld_low_grav_waves',
      name: '🪐 Гравитационные Аномалии',
      code: `// Каждые N секунд генерирует по-настоящему случайную гравитацию в заданном диапазоне и плавно переходит к ней
export const params = {
  minGrav: { type: 'number', default: 2, min: 0.5, max: 35, step: 0.5, label: 'Мин. гравитация (м/с²)' },
  maxGrav: { type: 'number', default: 46, min: 10, max: 90, step: 1, label: 'Макс. гравитация (м/с²)' },
  intervalSec: { type: 'number', default: 10, min: 3, max: 60, step: 1, label: 'Интервал смены (сек)' },
  smoothSpeed: { type: 'number', default: 4.5, min: 0.5, max: 25, step: 0.5, label: 'Плавность перехода' }
};

export function onWorldStart(self, api) {
  const cur = api.world.getGravity();
  self.setState('targetGrav', cur);
  self.setState('nextSwitchAt', api.time + 1.0);
}

export function onWorldTick(self, dt, api) {
  const nextAt = self.getState('nextSwitchAt', 0);

  if (api.time >= nextAt) {
    const low = Math.min(self.params.minGrav, self.params.maxGrav);
    const high = Math.max(self.params.minGrav, self.params.maxGrav);
    const prevTarget = self.getState('targetGrav', 22);

    // Генерируем действительно случайное значение, заметно отличающееся от предыдущего
    let nextGrav = api.math.random(low, high);
    for (let attempt = 0; attempt < 5; attempt++) {
      if (api.math.abs(nextGrav - prevTarget) >= Math.max(2, (high - low) * 0.18)) break;
      nextGrav = api.math.random(low, high);
    }
    nextGrav = Math.round(nextGrav * 10) / 10;

    self.setState('targetGrav', nextGrav);
    self.setState('nextSwitchAt', api.time + Math.max(2, self.params.intervalSec));

    api.audio.playSfx('coil');
    const tag =
      nextGrav < 6 ? '🛰️ Почти невесомость' :
      nextGrav < 14 ? '🌙 Пониженная гравитация' :
      nextGrav <= 27 ? '🌍 Земное притяжение' : '🪐 Гипергравитация';
    const col =
      nextGrav < 14 ? '#56f0ff' :
      nextGrav <= 27 ? '#00e676' : '#ff6b6b';

    api.ui.showBanner('🪐 Аномалия: ' + tag + ' (' + nextGrav.toFixed(1) + ' м/с²)!', col);
  }

  // Плавное стремление текущей гравитации к случайной цели
  const targetG = self.getState('targetGrav', 22);
  const currentG = api.world.getGravity();
  if (api.math.abs(currentG - targetG) > 0.05) {
    const stepT = api.math.clamp(dt * (self.params.smoothSpeed || 4.5), 0, 1);
    api.world.setGravity(api.math.lerp(currentG, targetG, stepT));
  }
}`
    }
  ]
};

export function createSingleScriptEntry(targetType = 'block', enabled = false, tplIdx = 0) {
  const tplList = SCRIPT_TEMPLATES[targetType] || SCRIPT_TEMPLATES.block;
  const tpl = tplList[tplIdx % Math.max(1, tplList.length)] || tplList[0];
  return {
    id: 'scr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    enabled: Boolean(enabled),
    targetType,
    name: tpl ? tpl.name.replace(/^[^\wа-яА-ЯёЁ]+/, '').trim() : 'Мой Скрипт',
    code: tpl ? tpl.code : '',
    paramValues: {},
    collapsed: false,
    showBadge: true,
    hasInteractHook: false,
    runtimeDisabled: false,
    lastError: ''
  };
}

export function createDefaultScriptData(targetType = 'block') {
  const firstEntry = createSingleScriptEntry(targetType, false, 0);
  return {
    enabled: false,
    collapsed: false,
    targetType,
    name: firstEntry.name,
    code: firstEntry.code,
    paramValues: {},
    showBadge: true,
    hasInteractHook: false,
    runtimeDisabled: false,
    lastError: '',
    scripts: [firstEntry]
  };
}

export function ensureScriptContainer(container, targetType = 'block') {
  if (!container || typeof container !== 'object') {
    return createDefaultScriptData(targetType);
  }
  if (!container.targetType) container.targetType = targetType;
  if (container.collapsed === undefined) container.collapsed = false;

  if (!Array.isArray(container.scripts)) {
    const hasLegacyCode = typeof container.code === 'string' && container.code.trim().length > 0;
    const migrated = hasLegacyCode
      ? {
          id: container.id || ('scr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
          enabled: Boolean(container.enabled),
          targetType: container.targetType || targetType,
          name: container.name || 'Мой Скрипт',
          code: container.code,
          paramValues: container.paramValues ? JSON.parse(JSON.stringify(container.paramValues)) : {},
          collapsed: false,
          showBadge: container.showBadge !== false,
          hasInteractHook: Boolean(container.hasInteractHook),
          runtimeDisabled: false,
          lastError: ''
        }
      : createSingleScriptEntry(targetType, Boolean(container.enabled), 0);
    container.scripts = [migrated];
  } else {
    container.scripts = container.scripts.filter(Boolean).map((s, idx) => ({
      id: s.id || ('scr_' + Date.now() + '_' + idx),
      enabled: Boolean(s.enabled),
      targetType: s.targetType || targetType,
      name: s.name || `Скрипт #${idx + 1}`,
      code: typeof s.code === 'string' ? s.code : '',
      paramValues: (s.paramValues && typeof s.paramValues === 'object') ? s.paramValues : {},
      collapsed: Boolean(s.collapsed),
      showBadge: s.showBadge !== false,
      hasInteractHook: Boolean(s.hasInteractHook),
      runtimeDisabled: Boolean(s.runtimeDisabled),
      lastError: s.lastError || '',
      _compiled: s._compiled || null,
      _compiledSource: s._compiledSource || null
    }));
  }

  syncScriptContainerFlags(container);
  return container;
}

export function syncScriptContainerFlags(container) {
  if (!container || !Array.isArray(container.scripts)) return;
  let anyEnabled = false;
  let anyInteract = false;
  for (let i = 0; i < container.scripts.length; i++) {
    const s = container.scripts[i];
    if (!s) continue;
    if (s.enabled && !s._compiled) {
      compileSandboxedScript(s);
    }
    if (s.enabled) {
      anyEnabled = true;
      if (s.hasInteractHook) anyInteract = true;
    }
  }
  container.enabled = anyEnabled;
  container.hasInteractHook = anyInteract;
  const first = container.scripts[0];
  if (first) {
    container.name = first.name;
    container.code = first.code;
    container.paramValues = first.paramValues;
  }
}

/* ============================================================================
   2. ПЕСОЧНИЦА, ПАРСЕР PARAMS И ЗАЩИТА ОТ БЕСКОНЕЧНЫХ ЦИКЛОВ (4 КОНТУРА)
   ============================================================================ */

export function pushScriptConsoleLog(level, sourceName, msg) {
  if (!Array.isArray(S.scriptLogs)) S.scriptLogs = [];
  const timeStr = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  S.scriptLogs.push({
    time: timeStr,
    level,
    source: sourceName || 'Script',
    text: String(msg)
  });
  if (S.scriptLogs.length > MAX_LOGS) {
    S.scriptLogs.shift();
  }
  renderScriptConsoleOutput();
}

// Очищает комментарии и строки только для проверки запрещённых идентификаторов
function stripCommentsAndStrings(code) {
  return String(code || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, '""');
}

export function validateAndTransformScript(rawCode) {
  const code = String(rawCode || '');
  if (!code.trim()) {
    return { ok: true, transformedCode: '', hooksPresent: {} };
  }

  const stripped = stripCommentsAndStrings(code);
  const forbiddenMatch = stripped.match(FORBIDDEN_REGEX);
  if (forbiddenMatch) {
    return {
      ok: false,
      error: `Запрещённый идентификатор «${forbiddenMatch[1]}»: доступ к браузеру и сети заблокирован песочницей.`
    };
  }

  // Нормализация ES-экспортов (export const / export function)
  let transformed = code
    .replace(/^\s*export\s+const\s+/gm, 'const ')
    .replace(/^\s*export\s+let\s+/gm, 'let ')
    .replace(/^\s*export\s+var\s+/gm, 'var ')
    .replace(/^\s*export\s+function\s+/gm, 'function ');

  // Авто-инжекция счётчика итераций __guard() в циклы while и for
  transformed = transformed
    .replace(/\bwhile\s*\(([^)]*)\)/g, 'while ((__guard(), ($1)))')
    .replace(/\bfor\s*\(([^;]*);([^;]*);([^)]*)\)/g, (_, init, cond, step) => {
      const cleanCond = cond.trim();
      return cleanCond
        ? `for (${init}; (__guard(), (${cleanCond})); ${step})`
        : `for (${init}; __guard(); ${step})`;
    });

  const hooksPresent = {
    onStart: /\bfunction\s+onStart\b/.test(transformed),
    onTick: /\bfunction\s+onTick\b/.test(transformed),
    onInteract: /\bfunction\s+(onInteract|onKeyE)\b/.test(transformed),
    onCollide: /\bfunction\s+onCollide\b/.test(transformed),
    onSignal: /\bfunction\s+onSignal\b/.test(transformed),
    onAiTick: /\bfunction\s+onAiTick\b/.test(transformed),
    onDamaged: /\bfunction\s+onDamaged\b/.test(transformed),
    onDeath: /\bfunction\s+onDeath\b/.test(transformed),
    onDialogue: /\bfunction\s+onDialogue\b/.test(transformed),
    onUse: /\bfunction\s+onUse\b/.test(transformed),
    onHit: /\bfunction\s+onHit\b/.test(transformed),
    onWorldStart: /\bfunction\s+onWorldStart\b/.test(transformed),
    onWorldTick: /\bfunction\s+onWorldTick\b/.test(transformed),
    onPlayerDeath: /\bfunction\s+onPlayerDeath\b/.test(transformed),
    onPlayerRespawn: /\bfunction\s+onPlayerRespawn\b/.test(transformed)
  };

  return { ok: true, transformedCode: transformed, hooksPresent };
}

// Создаёт изолированную Proxy-клетку, не выпускающую скрипт в globalThis/window
function createSandboxEnvironment(guardFn) {
  const allowedGlobals = {
    Math,
    Number,
    String,
    Boolean,
    Array,
    Object,
    JSON,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    NaN,
    Infinity,
    undefined,
    __guard: guardFn
  };

  return new Proxy(allowedGlobals, {
    has() {
      // Перехватываем поиск любых переменных, чтобы скрипт никогда не вышел в window
      return true;
    },
    get(target, prop) {
      if (prop === Symbol.unscopables) return undefined;
      if (Object.prototype.hasOwnProperty.call(target, prop)) {
        return target[prop];
      }
      return undefined;
    },
    set() {
      return false;
    }
  });
}

export function compileSandboxedScript(scriptData) {
  if (!scriptData) return null;
  if (scriptData._compiled && scriptData._compiledSource === scriptData.code) {
    return scriptData._compiled;
  }

  const check = validateAndTransformScript(scriptData.code);
  if (!check.ok) {
    scriptData.lastError = check.error;
    scriptData.runtimeDisabled = true;
    scriptData._compiled = null;
    return null;
  }

  scriptData.hasInteractHook = Boolean(check.hooksPresent.onInteract);

  let loopCount = 0;
  const guardFn = () => {
    if (++loopCount > MAX_LOOP_ITERATIONS_PER_CALL) {
      throw new Error(`Превышен лимит итераций цикла (${MAX_LOOP_ITERATIONS_PER_CALL} за кадр). Бесконечный цикл остановлен.`);
    }
    return true;
  };

  const resetGuard = () => {
    loopCount = 0;
  };

  const sandboxEnv = createSandboxEnvironment(guardFn);

  const wrapperBody = `
    with (__sandbox) {
      return (function() {
        "use strict";
        ${check.transformedCode}
        return {
          params: typeof params !== 'undefined' ? params : {},
          onStart: typeof onStart === 'function' ? onStart : null,
          onTick: typeof onTick === 'function' ? onTick : null,
          onInteract: typeof onInteract === 'function' ? onInteract : (typeof onKeyE === 'function' ? onKeyE : null),
          onCollide: typeof onCollide === 'function' ? onCollide : null,
          onSignal: typeof onSignal === 'function' ? onSignal : null,
          onAiTick: typeof onAiTick === 'function' ? onAiTick : null,
          onDamaged: typeof onDamaged === 'function' ? onDamaged : null,
          onDeath: typeof onDeath === 'function' ? onDeath : null,
          onDialogue: typeof onDialogue === 'function' ? onDialogue : null,
          onUse: typeof onUse === 'function' ? onUse : null,
          onHit: typeof onHit === 'function' ? onHit : null,
          onWorldStart: typeof onWorldStart === 'function' ? onWorldStart : null,
          onWorldTick: typeof onWorldTick === 'function' ? onWorldTick : null,
          onPlayerDeath: typeof onPlayerDeath === 'function' ? onPlayerDeath : null,
          onPlayerRespawn: typeof onPlayerRespawn === 'function' ? onPlayerRespawn : null
        };
      })();
    }
  `;

  try {
    const factory = new Function('__sandbox', wrapperBody);
    resetGuard();
    const exportsObj = factory(sandboxEnv);
    const compiled = {
      exports: exportsObj || {},
      resetGuard,
      started: false,
      stateStore: {}
    };
    scriptData._compiled = compiled;
    scriptData._compiledSource = scriptData.code;
    scriptData.lastError = '';
    scriptData.runtimeDisabled = false;
    return compiled;
  } catch (err) {
    scriptData.lastError = err.message || String(err);
    scriptData.runtimeDisabled = true;
    scriptData._compiled = null;
    return null;
  }
}

export function parseScriptMetaParams(scriptData) {
  if (!scriptData) return {};
  const compiled = compileSandboxedScript(scriptData);
  if (!compiled || !compiled.exports || typeof compiled.exports.params !== 'object' || !compiled.exports.params) {
    return {};
  }
  const rawParams = compiled.exports.params;
  if (!scriptData.paramValues || typeof scriptData.paramValues !== 'object') {
    scriptData.paramValues = {};
  }
  const resolved = {};
  for (const key of Object.keys(rawParams)) {
    const spec = rawParams[key];
    if (!spec || typeof spec !== 'object') {
      resolved[key] = scriptData.paramValues[key] !== undefined ? scriptData.paramValues[key] : spec;
    } else {
      if (scriptData.paramValues[key] === undefined && spec.default !== undefined) {
        scriptData.paramValues[key] = spec.default;
      }
      resolved[key] = scriptData.paramValues[key] !== undefined ? scriptData.paramValues[key] : spec.default;
    }
  }
  return resolved;
}

/* ============================================================================
   3. БЕЗОПАСНЫЕ FACADE-ОБЁРТКИ ДЛЯ БЛОКОВ, NPC, ИГРОКА, ПРЕДМЕТОВ И МИРА
   ============================================================================ */

const safeNum = (v, def = 0, min = -10000, max = 10000) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return clamp(n, min, max);
};

function parseHexToRgb(hexStr) {
  const clean = String(hexStr || '#ffffff').trim().replace(/^#/, '');
  if (clean.length === 3) {
    return {
      r: parseInt(clean[0] + clean[0], 16) || 0,
      g: parseInt(clean[1] + clean[1], 16) || 0,
      b: parseInt(clean[2] + clean[2], 16) || 0
    };
  }
  const num = parseInt(clean.slice(0, 6), 16);
  if (Number.isNaN(num)) return { r: 255, g: 255, b: 255 };
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function lerpHexColor(hexA, hexB, t) {
  const k = clamp(Number(t) || 0, 0, 1);
  const a = parseHexToRgb(hexA);
  const b = parseHexToRgb(hexB);
  const r = Math.round(a.r + (b.r - a.r) * k);
  const g = Math.round(a.g + (b.g - a.g) * k);
  const bl = Math.round(a.b + (b.b - a.b) * k);
  const toH = n => clamp(n, 0, 255).toString(16).padStart(2, '0');
  return `#${toH(r)}${toH(g)}${toH(bl)}`;
}

function createBlockFacade(box, scriptData = null, compiled = null) {
  if (!box || !box.m) return null;
  const paramsObj = scriptData ? parseScriptMetaParams(scriptData) : {};
  const stateMap = compiled ? compiled.stateStore : (box._scriptState || (box._scriptState = {}));

  return Object.freeze({
    kind: 'block',
    id: box.id,
    get name() { return box.label; },
    set name(v) { box.label = String(v || 'Блок').slice(0, 48); },
    params: Object.freeze(paramsObj),

    getState(k, defVal = undefined) {
      return stateMap[k] !== undefined ? stateMap[k] : defVal;
    },
    setState(k, val) {
      stateMap[String(k)] = val;
    },

    getPosition() {
      return { x: box.m.position.x, y: box.m.position.y, z: box.m.position.z };
    },
    setPosition(x, y, z) {
      const nx = safeNum(x, box.m.position.x, -2500, 2500);
      const ny = safeNum(y, box.m.position.y, -500, 2500);
      const nz = safeNum(z, box.m.position.z, -2500, 2500);
      const dx = nx - box.m.position.x;
      const dy = ny - box.m.position.y;
      const dz = nz - box.m.position.z;

      box.m.position.set(nx, ny, nz);
      box.m.updateMatrixWorld();
      updateBlockOBB(box);
      if (box.cpVisualGroup) box.cpVisualGroup.position.copy(box.m.position);
      if (box.haloSprite) box.haloSprite.position.copy(box.m.position);

      // Если игрок стоит на этом блоке — плавно переносим игрока вместе с ним
      const p = S.player;
      if (p && !S.playerDead && box.matterState === 'solid') {
        if (
          p.x + 0.42 >= box.x0 && p.x - 0.42 <= box.x1 &&
          p.z + 0.42 >= box.z0 && p.z - 0.42 <= box.z1 &&
          Math.abs(p.y - box.y1) < 0.55
        ) {
          p.x += dx;
          p.y += dy;
          p.z += dz;
        }
      }
    },
    move(dx, dy, dz) {
      this.setPosition(
        box.m.position.x + safeNum(dx, 0, -100, 100),
        box.m.position.y + safeNum(dy, 0, -100, 100),
        box.m.position.z + safeNum(dz, 0, -100, 100)
      );
    },

    getRotation() {
      return {
        x: THREE.MathUtils.radToDeg(box.m.rotation.x),
        y: THREE.MathUtils.radToDeg(box.m.rotation.y),
        z: THREE.MathUtils.radToDeg(box.m.rotation.z)
      };
    },
    setRotation(rxDeg, ryDeg, rzDeg) {
      box.m.rotation.set(
        THREE.MathUtils.degToRad(safeNum(rxDeg, 0, -36000, 36000)),
        THREE.MathUtils.degToRad(safeNum(ryDeg, 0, -36000, 36000)),
        THREE.MathUtils.degToRad(safeNum(rzDeg, 0, -36000, 36000))
      );
      box.m.quaternion.setFromEuler(box.m.rotation);
      box.m.updateMatrixWorld();
      updateBlockOBB(box);
    },
    rotate(drxDeg, dryDeg, drzDeg) {
      const cur = this.getRotation();
      this.setRotation(
        cur.x + safeNum(drxDeg, 0, -720, 720),
        cur.y + safeNum(dryDeg, 0, -720, 720),
        cur.z + safeNum(drzDeg, 0, -720, 720)
      );
    },

    getScale() {
      return { x: box.m.scale.x, y: box.m.scale.y, z: box.m.scale.z };
    },
    setScale(sx, sy, sz) {
      box.m.scale.set(
        safeNum(sx, box.w, 0.15, 400),
        safeNum(sy, box.h, 0.15, 400),
        safeNum(sz, box.d, 0.15, 400)
      );
      box.w = box.m.scale.x;
      box.h = box.m.scale.y;
      box.d = box.m.scale.z;
      box.m.updateMatrixWorld();
      updateBlockOBB(box);
    },

    getColor() { return box.colorHex || '#ffffff'; },
    setColor(hex) {
      if (typeof hex === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(hex.trim())) {
        box.colorHex = hex.trim();
        if (box.m.material && box.m.material.color) {
          box.m.material.color.set(box.colorHex);
        }
        syncBlockLightVisuals(box);
      }
    },

    getWeight() { return Number(box.weight) || 15; },
    setWeight(kg) {
      box.weight = safeNum(kg, 15, -5000, 10000);
      if (box.components?.physics) box.components.physics.weight = box.weight;
    },

    getVelocity() {
      return { x: box.physVx || 0, y: box.physVy || 0, z: box.physVz || 0 };
    },
    setVelocity(vx, vy, vz) {
      box.physVx = safeNum(vx, 0, -45, 45);
      box.physVy = safeNum(vy, 0, -45, 45);
      box.physVz = safeNum(vz, 0, -45, 45);
    },
    applyImpulse(ix, iy, iz) {
      if (!box.isDynamicPhysics) return;
      const mass = Math.max(0.5, Math.abs(Number(box.weight) || 15));
      const invM = clamp(18 / mass, 0.01, 4.0);
      box.physVx = clamp((box.physVx || 0) + safeNum(ix, 0, -200, 200) * invM, -38, 38);
      box.physVy = clamp((box.physVy || 0) + safeNum(iy, 0, -200, 200) * invM, -38, 38);
      box.physVz = clamp((box.physVz || 0) + safeNum(iz, 0, -200, 200) * invM, -38, 38);
      box.physGrounded = false;
    },
    damage() {},

    sendSignal(targetTag, action = 'toggle_motion') {
      if (!targetTag || typeof window.__debixActivateBlockMotionByTag !== 'function') return;
      window.__debixActivateBlockMotionByTag(box, String(targetTag), String(action));
    }
  });
}

function createEntityFacade(ent, scriptData = null, compiled = null) {
  if (!ent) return null;
  const paramsObj = scriptData ? parseScriptMetaParams(scriptData) : {};
  const stateMap = compiled ? compiled.stateStore : (ent._scriptState || (ent._scriptState = {}));

  return Object.freeze({
    kind: ent.isP ? 'player' : 'npc',
    id: ent.id || (ent.isP ? 'player' : 'npc'),
    get name() { return ent.name || 'NPC'; },
    set name(v) {
      ent.name = String(v || 'NPC').slice(0, 36);
      refreshEntityTagWithHP(ent);
    },
    params: Object.freeze(paramsObj),

    getState(k, defVal = undefined) {
      return stateMap[k] !== undefined ? stateMap[k] : defVal;
    },
    setState(k, val) {
      stateMap[String(k)] = val;
    },

    getPosition() {
      return { x: ent.x || 0, y: ent.y || 0, z: ent.z || 0 };
    },
    setPosition(x, y, z) {
      ent.x = safeNum(x, ent.x, -2500, 2500);
      ent.y = safeNum(y, ent.y, -200, 2500);
      ent.z = safeNum(z, ent.z, -2500, 2500);
      if (ent.rig?.g) ent.rig.g.position.set(ent.x, ent.y, ent.z);
      if (ent.tag) ent.tag.position.set(ent.x, ent.y + 3.35, ent.z);
    },
    getForward() {
      const yaw = ent.isP ? S.yaw : (ent.rot + Math.PI);
      const cp = ent.isP ? Math.cos(S.pitch) : 1;
      return {
        x: -Math.sin(yaw) * cp,
        y: ent.isP ? Math.sin(S.pitch) : 0,
        z: -Math.cos(yaw) * cp
      };
    },
    getScale() {
      return ent.rig?.g?.scale?.x || 1;
    },
    setScale(sc) {
      const s = safeNum(sc, 1, 0.35, 5.0);
      if (ent.rig?.g) ent.rig.g.scale.setScalar(s);
    },

    getHp() { return ent.hp ?? 100; },
    getMaxHp() { return ent.maxHp ?? 100; },
    setHp(v) {
      ent.hp = safeNum(v, ent.hp, 0, ent.maxHp || 100);
      ent.hpBarTimer = 3.5;
      refreshEntityTagWithHP(ent);
      if (ent.isP) updateShopUI();
    },
    setMaxHp(v) {
      ent.maxHp = safeNum(v, 100, 1, 10000);
      if (ent.isP) ent.baseMaxHp = ent.maxHp;
      ent.hp = Math.min(ent.hp, ent.maxHp);
      refreshEntityTagWithHP(ent);
      if (ent.isP) updateShopUI();
    },
    heal(amount) {
      const add = safeNum(amount, 0, 0, 5000);
      if (add <= 0) return;
      ent.hp = Math.min(ent.maxHp || 100, (ent.hp || 0) + add);
      ent.hpBarTimer = 3.5;
      refreshEntityTagWithHP(ent);
      if (ent.isP) updateShopUI();
    },
    damage(amount) {
      const dmg = safeNum(amount, 0, 0, 5000);
      if (dmg <= 0 || typeof window.__debixScriptDealDamage !== 'function') return;
      window.__debixScriptDealDamage(ent, dmg);
    },

    getWalkSpeed() { return ent.walkSpeed || (ent.isP ? 7.6 : 5.4); },
    setWalkSpeed(spd) {
      const s = safeNum(spd, 6, 1.5, 30);
      ent.walkSpeed = s;
      if (ent.aiModules?.navigation) ent.aiModules.navigation.walkSpeed = s;
    },
    getJumpPower() { return ent.jumpPower || 10.2; },
    setJumpPower(jp) {
      const j = safeNum(jp, 10.2, 2, 40);
      ent.jumpPower = j;
      if (ent.aiModules?.navigation) ent.aiModules.navigation.jumpPower = j;
    },
    setGait(gait) {
      if (['normal', 'monster', 'levitate'].includes(gait)) {
        ent.gait = gait;
        if (ent.aiModules?.navigation) ent.aiModules.navigation.gait = gait;
      }
    },

    getWeight() { return safeNum(ent.weight, 70, 5, 5000); },
    setWeight(kg) { ent.weight = safeNum(kg, 70, 5, 5000); },

    getCash() { return ent.cash ?? 0; },
    addCash(delta) {
      if (!ent.isP) return;
      ent.cash = Math.max(0, Math.round((ent.cash || 0) + safeNum(delta, 0, -100000, 100000)));
      updateShopUI();
    },

    applyImpulse(vx, vy, vz) {
      ent.vxKnock = clamp((ent.vxKnock || 0) + safeNum(vx, 0, -45, 45), -45, 45);
      ent.vzKnock = clamp((ent.vzKnock || 0) + safeNum(vz, 0, -45, 45), -45, 45);
      const upY = safeNum(vy, 0, -35, 35);
      if (Math.abs(upY) > 0.05) {
        ent.vy = clamp((ent.vy || 0) + upY, -35, 35);
        ent.grounded = false;
      }
    },

    say(text, duration = 4.0) {
      ent.chat = String(text || '').slice(0, 120);
      ent.chatT = safeNum(duration, 4.0, 0.5, 15);
      refreshEntityTagWithHP(ent);
    },
    setTargetPosition(tx, tz) {
      if (ent.isP) return;
      ent.tx = safeNum(tx, ent.x, -2500, 2500);
      ent.tz = safeNum(tz, ent.z, -2500, 2500);
    }
  });
}

let _particleTokens = 12;
let _lastTokenRefill = 0;

function createEngineApiBridge(sourceLabel, dt = 0.016) {
  const now = performance.now() * 0.001;
  if (now - _lastTokenRefill > 0.25) {
    _particleTokens = 12;
    _lastTokenRefill = now;
  }

  return Object.freeze({
    time: S.time || 0,
    dt: safeNum(dt, 0.016, 0.0001, 0.1),

    log(...args) {
      const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      pushScriptConsoleLog('info', sourceLabel, msg);
    },

    math: Object.freeze({
      clamp,
      lerp: (a, b, t) => a + (b - a) * clamp(t, 0, 1),
      lerpColor: (hexA, hexB, t) => lerpHexColor(hexA, hexB, t),
      smoothstep: (edge0, edge1, x) => {
        const t = clamp((x - edge0) / ((edge1 - edge0) || 1), 0, 1);
        return t * t * (3 - 2 * t);
      },
      random: (min = 0, max = 1) => rnd(min, max),
      randomInt: (min = 0, max = 10) => Math.floor(rnd(min, max + 0.999)),
      sin: Math.sin,
      cos: Math.cos,
      abs: Math.abs,
      hypot: Math.hypot,
      atan2: Math.atan2,
      degToRad: d => THREE.MathUtils.degToRad(Number(d) || 0),
      radToDeg: r => THREE.MathUtils.radToDeg(Number(r) || 0),
      dist(p1, p2) {
        if (!p1 || !p2) return Infinity;
        return Math.hypot((p1.x || 0) - (p2.x || 0), (p1.y || 0) - (p2.y || 0), (p1.z || 0) - (p2.z || 0));
      },
      directionTo(fromPt, toPt) {
        if (!fromPt || !toPt) return { x: 0, y: 1, z: 0 };
        const dx = (toPt.x || 0) - (fromPt.x || 0);
        const dy = (toPt.y || 0) - (fromPt.y || 0);
        const dz = (toPt.z || 0) - (fromPt.z || 0);
        const l = Math.hypot(dx, dy, dz) || 1;
        return { x: dx / l, y: dy / l, z: dz / l };
      }
    }),

    get player() {
      return S.player ? createEntityFacade(S.player) : null;
    },

    world: Object.freeze({
      getGravity() { return S.worldSettings.gravity ?? 22; },
      setGravity(g) { S.worldSettings.gravity = safeNum(g, 22, 0, 100); },

      setSkyColors(topHex, midHex, botHex, fogHex) {
        if (topHex) S.worldSettings.skyTop = String(topHex);
        if (midHex) S.worldSettings.skyMid = String(midHex);
        if (botHex) S.worldSettings.skyBot = String(botHex);
        if (fogHex) S.worldSettings.fogColor = String(fogHex);
        updateSkybox(false);
      },

      setSunPosition(x, y, z, intensity = null, colorHex = null) {
        const ss = S.worldSettings.sunSettings;
        if (!ss) return;
        ss.enabled = true;
        ss.x = safeNum(x, ss.x, -500, 500);
        ss.y = safeNum(y, ss.y, -500, 500);
        ss.z = safeNum(z, ss.z, -500, 500);
        if (intensity !== null) ss.intensity = safeNum(intensity, ss.intensity, 0, 5);
        if (colorHex) {
          ss.color = String(colorHex);
          ss.shellColor = String(colorHex);
        }
        updateSkybox(false);
      },

      setSunState(opts = {}) {
        if (!opts || typeof opts !== 'object') return;
        const ss = S.worldSettings.sunSettings;
        if (!ss) return;
        if (opts.enabled !== undefined) ss.enabled = Boolean(opts.enabled);
        if (opts.x !== undefined) ss.x = safeNum(opts.x, ss.x, -500, 500);
        if (opts.y !== undefined) ss.y = safeNum(opts.y, ss.y, -500, 500);
        if (opts.z !== undefined) ss.z = safeNum(opts.z, ss.z, -500, 500);
        if (opts.intensity !== undefined) ss.intensity = safeNum(opts.intensity, ss.intensity, 0, 5);
        if (opts.hemiIntensity !== undefined) ss.hemiIntensity = safeNum(opts.hemiIntensity, ss.hemiIntensity ?? 0.9, 0.05, 2.5);
        if (opts.color) ss.color = String(opts.color);
        if (opts.shellColor) ss.shellColor = String(opts.shellColor);
        if (opts.shellSize !== undefined) ss.shellSize = safeNum(opts.shellSize, ss.shellSize || 14, 2, 80);
        updateSkybox(false);
      },

      setMoonState(opts = {}) {
        if (!opts || typeof opts !== 'object') return;
        if (!S.worldSettings.moonSettings) {
          S.worldSettings.moonSettings = {
            enabled: false,
            shape: 'sphere',
            size: 15,
            color: '#dbeafe',
            glow: true,
            x: -45,
            y: 75,
            z: -35
          };
        }
        const ms = S.worldSettings.moonSettings;
        if (opts.enabled !== undefined) ms.enabled = Boolean(opts.enabled);
        if (opts.x !== undefined) ms.x = safeNum(opts.x, ms.x, -500, 500);
        if (opts.y !== undefined) ms.y = safeNum(opts.y, ms.y, -500, 500);
        if (opts.z !== undefined) ms.z = safeNum(opts.z, ms.z, -500, 500);
        if (opts.size !== undefined) ms.size = safeNum(opts.size, ms.size || 15, 2, 80);
        if (opts.color) ms.color = String(opts.color);
        if (opts.glow !== undefined) ms.glow = Boolean(opts.glow);
        updateSkybox(false);
      },

      findBlock(query) {
        if (!query) return null;
        const q = String(query).trim().toLowerCase();
        const found = S.allBlocks.find(
          b => b && !b._depletedDisabled && (
            (b.id && b.id.toLowerCase() === q) ||
            (b.signalData?.tag && b.signalData.tag.toLowerCase() === q) ||
            (b.label && b.label.toLowerCase() === q)
          )
        );
        return found ? createBlockFacade(found) : null;
      },

      getEntitiesInRadius(center, radius = 10) {
        if (!center) return [];
        const r = safeNum(radius, 10, 0.5, 120);
        const cx = safeNum(center.x, 0);
        const cy = safeNum(center.y, 0);
        const cz = safeNum(center.z, 0);
        const res = [];

        if (S.player && !S.playerDead) {
          if (Math.hypot(S.player.x - cx, S.player.y - cy, S.player.z - cz) <= r) {
            res.push(createEntityFacade(S.player));
          }
        }
        for (let i = 0; i < S.customNPCs.length; i++) {
          const n = S.customNPCs[i];
          if (!n || n.isDisabled || n._deadCooldown > 0 || n._permanentlyDead) continue;
          if (Math.hypot(n.x - cx, n.y - cy, n.z - cz) <= r) {
            res.push(createEntityFacade(n));
          }
        }
        for (let i = 0; i < S.allBlocks.length; i++) {
          const b = S.allBlocks[i];
          if (!b || b.isDisabled || b._depletedDisabled || !b.isDynamicPhysics) continue;
          const bp = b.m.position;
          if (Math.hypot(bp.x - cx, bp.y - cy, bp.z - cz) <= r) {
            res.push(createBlockFacade(b));
          }
        }
        return res;
      },

      spawnParticles(x, y, z, count = 10, opts = {}) {
        if (_particleTokens <= 0) return;
        _particleTokens--;
        emitParticleBurst(
          safeNum(x, 0),
          safeNum(y, 1),
          safeNum(z, 0),
          clamp(Number(count) || 10, 1, 28),
          {
            preset: opts.preset || 'spark',
            color: opts.color || '#56f0ff',
            sizeStart: safeNum(opts.size, 0.35, 0.05, 2.0),
            sizeEnd: 0.05,
            speed: safeNum(opts.speed, 4.5, 0.2, 20),
            spread: 1.25,
            gravity: safeNum(opts.gravity, -6, -25, 25),
            lifetime: 0.75
          }
        );
      }
    }),

    audio: Object.freeze({
      playSfx(id = 'click', pos = null) {
        const clean = String(id || 'click');
        if (typeof sfx[clean] === 'function') {
          sfx[clean]();
        } else {
          playSoundId(clean, pos ? { pos } : {});
        }
      }
    }),

    ui: Object.freeze({
      showBanner(text, color = '#56f0ff') {
        showBanner(String(text || '').slice(0, 140), String(color || '#56f0ff'));
      }
    })
  });
}

/* ============================================================================
   4. ВЫПОЛНЕНИЕ ЖИЗНЕННОГО ЦИКЛА СКРИПТОВ (РАНТ-ТАЙМ ДИСПЕТЧЕР МУЛЬТИ-СКРИПТОВ)
   ============================================================================ */

function invokeSafeHook(scriptEntry, hookName, selfFacade, arg2, apiBridge, sourceLabel) {
  if (!scriptEntry || !scriptEntry.enabled || scriptEntry.runtimeDisabled) return false;
  const compiled = compileSandboxedScript(scriptEntry);
  if (!compiled || !compiled.exports) return false;

  const fn = compiled.exports[hookName];
  if (typeof fn !== 'function') return false;

  const t0 = performance.now();
  try {
    compiled.resetGuard();
    if (hookName === 'onTick' || hookName === 'onWorldTick' || hookName === 'onAiTick') {
      fn(selfFacade, arg2, apiBridge);
    } else if (hookName === 'onStart' || hookName === 'onWorldStart') {
      fn(selfFacade, apiBridge);
    } else {
      fn(selfFacade, arg2, apiBridge);
    }
    const elapsed = performance.now() - t0;
    if (elapsed > MAX_FRAME_BUDGET_MS * 2.5) {
      throw new Error(`Превышен лимит времени кадра (${elapsed.toFixed(1)} мс > ${(MAX_FRAME_BUDGET_MS * 2.5).toFixed(1)} мс)`);
    }
    return true;
  } catch (err) {
    scriptEntry.lastError = `[${hookName}] ${err.message || err}`;
    scriptEntry.runtimeDisabled = true;
    pushScriptConsoleLog('error', sourceLabel, scriptEntry.lastError);
    showBanner(`⚠️ Скрипт «${scriptEntry.name || sourceLabel}» остановлен: ${err.message}`, '#ff3e3e');
    return false;
  }
}

function resetContainerScriptsRuntime(container, targetType) {
  if (!container) return;
  ensureScriptContainer(container, targetType);
  container._compiled = null;
  container.runtimeDisabled = false;
  for (let i = 0; i < container.scripts.length; i++) {
    const s = container.scripts[i];
    if (s) {
      s._compiled = null;
      s.runtimeDisabled = false;
    }
  }
}

export function resetAllScriptsRuntime() {
  if (S.worldSettings?.worldScriptData) {
    resetContainerScriptsRuntime(S.worldSettings.worldScriptData, 'world');
  }
  if (S.worldSettings?.moonSettings) {
    S.worldSettings.moonSettings.enabled = false;
  }
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (b?.scriptData) resetContainerScriptsRuntime(b.scriptData, 'block');
  }
  for (let i = 0; i < S.customNPCs.length; i++) {
    const n = S.customNPCs[i];
    if (n?.aiModules?.customScript) resetContainerScriptsRuntime(n.aiModules.customScript, 'npc');
  }
  for (let i = 0; i < (S.worldItems || []).length; i++) {
    const wi = S.worldItems[i];
    if (wi?.item?.scriptData) resetContainerScriptsRuntime(wi.item.scriptData, 'item');
  }
}

export function runBlockScriptHook(box, hookName, eventPayload = {}) {
  if (!box || box.isDisabled || box._depletedDisabled) return false;
  if (!box.components?.script?.enabled || !box.scriptData) return false;
  const container = ensureScriptContainer(box.scriptData, 'block');
  if (!container.enabled) return false;

  const api = createEngineApiBridge(box.label || box.id, 0.016);
  let secondArg = eventPayload;
  if (hookName === 'onInteract' && eventPayload.actor) {
    secondArg = createEntityFacade(eventPayload.actor);
  } else if (hookName === 'onCollide' && eventPayload.entity) {
    secondArg = createEntityFacade(eventPayload.entity);
  }

  let anyRan = false;
  for (let i = 0; i < container.scripts.length; i++) {
    const scr = container.scripts[i];
    if (!scr || !scr.enabled || scr.runtimeDisabled) continue;
    const compiled = compileSandboxedScript(scr);
    if (!compiled) continue;
    const selfFacade = createBlockFacade(box, scr, compiled);
    if (!compiled.started) {
      compiled.started = true;
      invokeSafeHook(scr, 'onStart', selfFacade, null, api, box.label);
    }
    if (invokeSafeHook(scr, hookName, selfFacade, secondArg, api, box.label)) {
      anyRan = true;
    }
  }
  return anyRan;
}

export function runNpcScriptHook(npc, hookName, eventPayload = {}) {
  if (!npc || npc.isDisabled || npc._deadCooldown > 0 || npc._permanentlyDead) return false;
  const rawSd = npc.aiModules?.customScript;
  if (!rawSd) return false;
  const container = ensureScriptContainer(rawSd, 'npc');
  if (!container.enabled) return false;

  const api = createEngineApiBridge(npc.name || npc.id, eventPayload.dt || 0.016);
  let anyRan = false;

  for (let i = 0; i < container.scripts.length; i++) {
    const scr = container.scripts[i];
    if (!scr || !scr.enabled || scr.runtimeDisabled) continue;
    const compiled = compileSandboxedScript(scr);
    if (!compiled) continue;
    const selfFacade = createEntityFacade(npc, scr, compiled);
    if (!compiled.started) {
      compiled.started = true;
      invokeSafeHook(scr, 'onStart', selfFacade, null, api, npc.name);
    }
    if (invokeSafeHook(scr, hookName, selfFacade, eventPayload, api, npc.name)) {
      anyRan = true;
    }
  }
  return anyRan;
}

export function runItemScriptHook(item, hookName, eventPayload = {}) {
  if (!item || !item.scriptData) return false;
  const container = ensureScriptContainer(item.scriptData, 'item');
  if (!container.enabled) return false;

  const payload = Object.assign({}, eventPayload);
  if (payload.target) payload.target = createEntityFacade(payload.target);
  const api = createEngineApiBridge(item.name || 'Item', 0.016);
  let anyRan = false;

  for (let i = 0; i < container.scripts.length; i++) {
    const scr = container.scripts[i];
    if (!scr || !scr.enabled || scr.runtimeDisabled) continue;
    const compiled = compileSandboxedScript(scr);
    if (!compiled) continue;

    const paramsObj = parseScriptMetaParams(scr);
    const selfFacade = Object.freeze({
      kind: 'item',
      name: item.name,
      params: Object.freeze(paramsObj),
      getState: (k, d) => (compiled.stateStore[k] !== undefined ? compiled.stateStore[k] : d),
      setState: (k, v) => { compiled.stateStore[String(k)] = v; }
    });

    if (invokeSafeHook(scr, hookName, selfFacade, payload, api, item.name)) {
      anyRan = true;
    }
  }
  return anyRan;
}

export function runWorldScriptHook(hookName, eventPayload = {}) {
  const rawWsd = S.worldSettings?.worldScriptData;
  if (!rawWsd) return false;
  const container = ensureScriptContainer(rawWsd, 'world');
  if (!container.enabled) return false;

  const api = createEngineApiBridge('Мир', eventPayload.dt || 0.016);
  let anyRan = false;

  for (let i = 0; i < container.scripts.length; i++) {
    const scr = container.scripts[i];
    if (!scr || !scr.enabled || scr.runtimeDisabled) continue;
    const compiled = compileSandboxedScript(scr);
    if (!compiled) continue;

    const paramsObj = parseScriptMetaParams(scr);
    const selfFacade = Object.freeze({
      kind: 'world',
      name: S.currentProjectTitle || 'Мир',
      params: Object.freeze(paramsObj),
      getState: (k, d) => (compiled.stateStore[k] !== undefined ? compiled.stateStore[k] : d),
      setState: (k, v) => { compiled.stateStore[String(k)] = v; }
    });

    if (invokeSafeHook(scr, hookName, selfFacade, eventPayload, api, 'Мир')) {
      anyRan = true;
    }
  }
  return anyRan;
}

export function updateAllScriptsRuntime(dt, player) {
  // 1. Глобальные скрипты мира
  const rawWsd = S.worldSettings?.worldScriptData;
  if (rawWsd) {
    const wContainer = ensureScriptContainer(rawWsd, 'world');
    if (wContainer.enabled) {
      const api = createEngineApiBridge('Мир', dt);
      for (let sIdx = 0; sIdx < wContainer.scripts.length; sIdx++) {
        const scr = wContainer.scripts[sIdx];
        if (!scr || !scr.enabled || scr.runtimeDisabled) continue;
        const compiled = compileSandboxedScript(scr);
        if (!compiled) continue;

        const paramsObj = parseScriptMetaParams(scr);
        const selfFacade = Object.freeze({
          kind: 'world',
          name: S.currentProjectTitle || 'Мир',
          params: Object.freeze(paramsObj),
          getState: (k, d) => (compiled.stateStore[k] !== undefined ? compiled.stateStore[k] : d),
          setState: (k, v) => { compiled.stateStore[String(k)] = v; }
        });
        if (!compiled.started) {
          compiled.started = true;
          invokeSafeHook(scr, 'onWorldStart', selfFacade, null, api, scr.name || 'Мир');
        }
        invokeSafeHook(scr, 'onWorldTick', selfFacade, dt, api, scr.name || 'Мир');
      }
    }
  }

  // 2. Скрипты блоков
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b.isDisabled || b._depletedDisabled) continue;
    if (!b.components?.script?.enabled || !b.scriptData) continue;
    const bContainer = ensureScriptContainer(b.scriptData, 'block');
    if (!bContainer.enabled) continue;

    const api = createEngineApiBridge(b.label || b.id, dt);
    for (let sIdx = 0; sIdx < bContainer.scripts.length; sIdx++) {
      const scr = bContainer.scripts[sIdx];
      if (!scr || !scr.enabled || scr.runtimeDisabled) continue;
      const compiled = compileSandboxedScript(scr);
      if (!compiled) continue;

      const selfFacade = createBlockFacade(b, scr, compiled);
      if (!compiled.started) {
        compiled.started = true;
        invokeSafeHook(scr, 'onStart', selfFacade, null, api, b.label);
      }
      if (compiled.exports.onTick) {
        invokeSafeHook(scr, 'onTick', selfFacade, dt, api, b.label);
      }
    }
  }

  // 3. Скрипты NPC
  for (let i = 0; i < S.customNPCs.length; i++) {
    const npc = S.customNPCs[i];
    if (!npc || npc.isDisabled || npc._deadCooldown > 0 || npc._permanentlyDead) continue;
    const rawNpcSd = npc.aiModules?.customScript;
    if (!rawNpcSd) continue;
    const nContainer = ensureScriptContainer(rawNpcSd, 'npc');
    if (!nContainer.enabled) continue;

    const api = createEngineApiBridge(npc.name || npc.id, dt);
    for (let sIdx = 0; sIdx < nContainer.scripts.length; sIdx++) {
      const scr = nContainer.scripts[sIdx];
      if (!scr || !scr.enabled || scr.runtimeDisabled) continue;
      const compiled = compileSandboxedScript(scr);
      if (!compiled) continue;

      const selfFacade = createEntityFacade(npc, scr, compiled);
      if (!compiled.started) {
        compiled.started = true;
        invokeSafeHook(scr, 'onStart', selfFacade, null, api, npc.name);
      }
      if (compiled.exports.onAiTick || compiled.exports.onTick) {
        const hook = compiled.exports.onAiTick ? 'onAiTick' : 'onTick';
        invokeSafeHook(scr, hook, selfFacade, dt, api, npc.name);
      }
    }
  }
}

/* ============================================================================
   5. ГЕНЕРАЦИЯ КАРТОЧКИ ИНСПЕКТОРА И АВТО-ПОЛЗУНКОВ PARAMS (МУЛЬТИ-СКРИПТЫ)
   ============================================================================ */

function renderSingleScriptEntryHTML(scr, idx, totalCount, targetType, templates) {
  compileSandboxedScript(scr);
  const compiled = scr._compiled;
  const rawSchema = (compiled && compiled.exports && typeof compiled.exports.params === 'object' && compiled.exports.params)
    ? compiled.exports.params
    : {};
  parseScriptMetaParams(scr);

  const paramKeys = Object.keys(rawSchema);
  const paramsRowsHTML = paramKeys.length > 0
    ? paramKeys.map(key => {
        const spec = rawSchema[key] || {};
        const val = scr.paramValues?.[key] ?? spec.default ?? 0;
        const label = spec.label || key;
        const type = spec.type || (typeof val === 'boolean' ? 'boolean' : (typeof val === 'number' ? 'number' : 'string'));

        if (type === 'boolean') {
          return `
            <div class="prop-row">
              <label title="${key}">${label}</label>
              <input type="checkbox" data-scr-idx="${idx}" data-scr-param="${key}" data-scr-ptype="boolean" ${val ? 'checked' : ''}>
            </div>
          `;
        }
        if (type === 'color') {
          return `
            <div class="prop-row">
              <label title="${key}">${label}</label>
              <input type="color" class="ed-color" data-scr-idx="${idx}" data-scr-param="${key}" data-scr-ptype="color" value="${val || '#56f0ff'}">
            </div>
          `;
        }
        if (type === 'number') {
          const minAttr = spec.min !== undefined ? `min="${spec.min}"` : '';
          const maxAttr = spec.max !== undefined ? `max="${spec.max}"` : '';
          const stepAttr = `step="${spec.step !== undefined ? spec.step : 1}"`;
          const hasRange = spec.min !== undefined && spec.max !== undefined;
          return `
            <div class="prop-row">
              <label title="${key}">${label}</label>
              ${hasRange ? `<input type="range" ${minAttr} ${maxAttr} ${stepAttr} data-scr-idx="${idx}" data-scr-param-range="${key}" value="${val}" style="flex:1">` : ''}
              <input type="number" class="ed-inp" ${minAttr} ${maxAttr} ${stepAttr} data-scr-idx="${idx}" data-scr-param="${key}" data-scr-ptype="number" value="${val}" style="width:68px">
            </div>
          `;
        }
        return `
          <div class="prop-row">
            <label title="${key}">${label}</label>
            <input class="ed-inp" data-scr-idx="${idx}" data-scr-param="${key}" data-scr-ptype="string" value="${String(val ?? '')}" style="flex:1">
          </div>
        `;
      }).join('')
    : `<div style="font-size:10px;color:#64748b;text-align:center;padding:3px">У скрипта нет объявленных <b>params</b></div>`;

  const statusBadge = scr.lastError
    ? `<span style="color:#ff5252;font-size:9.5px;font-weight:800">⚠️ Ошибка</span>`
    : (scr.enabled ? `<span style="color:#00e676;font-size:9.5px;font-weight:800">🟢 ВКЛ</span>` : `<span style="color:#94a3b8;font-size:9.5px">⏸️ Выкл</span>`);

  return `
    <div class="scr-subcard" style="background:rgba(13,17,27,0.92);border:1px solid ${scr.enabled ? '#a29bfe' : '#2b354d'};border-radius:8px;overflow:hidden">
      <div class="ecs-comp-head" data-scr-item-toggle="${idx}" style="padding:5px 8px;background:rgba(162,155,254,0.08)">
        <div class="ecs-comp-title" style="text-transform:none;font-size:11px">
          <span class="ecs-arrow">${scr.collapsed ? '▶' : '▼'}</span>
          <span>#${idx + 1} ${scr.name || 'Скрипт'}</span>
        </div>
        <div class="ecs-comp-actions">
          ${statusBadge}
          <button class="ecs-comp-del" data-scr-del-idx="${idx}" type="button" title="Удалить этот скрипт">#✕</button>
        </div>
      </div>
      <div class="ecs-comp-body" ${scr.collapsed ? 'hidden' : ''} style="padding:7px">
        <div class="prop-row">
          <label>Активен</label>
          <input type="checkbox" data-scr-enabled="${idx}" ${scr.enabled ? 'checked' : ''}>
          <input class="ed-inp" data-scr-name="${idx}" value="${scr.name || 'Мой Скрипт'}" style="flex:1" placeholder="Название скрипта...">
        </div>

        <div class="prop-row">
          <label>Шаблон</label>
          <select class="ed-inp" data-scr-tpl="${idx}" style="flex:1">
            <option value="">-- Выбрать шаблон аддона --</option>
            ${templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
            ${(S.customScriptsLibrary || []).filter(s => s.targetType === targetType).map((s, lIdx) => `<option value="lib:${lIdx}">📚 [Мои] ${s.name}</option>`).join('')}
          </select>
        </div>

        <div style="display:flex;gap:5px">
          <button class="ed-btn apply-oneclick" data-scr-open-ide="${idx}" type="button" style="flex:1;justify-content:center;background:linear-gradient(135deg,#6c5ce7,#00a2ff);border-color:#a29bfe">
            💻 Открыть Редактор Кода
          </button>
          <button class="ed-btn" data-scr-save-lib="${idx}" type="button" title="Сохранить скрипт в библиотеку проекта">⭐ В библ.</button>
        </div>

        ${scr.lastError ? `
          <div style="background:rgba(255,62,62,0.14);border:1px solid #ff3e3e;border-radius:6px;padding:6px;font:700 10px/1.35 var(--f);color:#ff9f9f">
            ⚠️ <b>${scr.lastError}</b>
            <button class="ed-btn" data-scr-restart="${idx}" type="button" style="margin-top:4px;width:100%;justify-content:center;padding:3px">🔄 Сбросить ошибку и перезапустить</button>
          </div>
        ` : ''}

        <div style="background:rgba(16,20,32,0.85);border:1px solid #283147;border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <span style="font:800 9.5px var(--f);color:#a29bfe;text-transform:uppercase">🎛️ Параметры (params):</span>
            ${paramKeys.length > 0 ? `<button class="ed-btn" data-scr-reset-params="${idx}" type="button" style="padding:1px 6px;font-size:9px">↺ Сброс</button>` : ''}
          </div>
          ${paramsRowsHTML}
        </div>
      </div>
    </div>
  `;
}

export function renderScriptAddonInspectorCardHTML(scriptData, targetType = 'block', removable = true) {
  if (!scriptData) return '';
  const container = ensureScriptContainer(scriptData, targetType);
  const templates = SCRIPT_TEMPLATES[targetType] || SCRIPT_TEMPLATES.block;
  const scriptsList = container.scripts || [];
  const activeCount = scriptsList.filter(s => s && s.enabled).length;

  const entriesHTML = scriptsList.length > 0
    ? scriptsList.map((scr, idx) => renderSingleScriptEntryHTML(scr, idx, scriptsList.length, targetType, templates)).join('')
    : `<div style="font-size:10.5px;color:#94a3b8;text-align:center;padding:6px">Нет прикреплённых скриптов. Нажми «➕ Добавить скрипт» ниже!</div>`;

  return `
    <div class="ecs-comp-card" data-scr-container-card="1" style="border-color:#a29bfe">
      <div class="ecs-comp-head" data-scr-root-toggle="1">
        <div class="ecs-comp-title">
          <span class="ecs-arrow">${container.collapsed ? '▶' : '▼'}</span>
          <span>🧩 Скрипт-Аддоны (${activeCount}/${scriptsList.length})</span>
        </div>
        <div class="ecs-comp-actions">
          <button class="ed-btn apply-oneclick" data-scr-add-new="1" type="button" style="padding:2px 7px;font-size:9.5px" title="Добавить ещё один скрипт на этот объект">➕ Скрипт</button>
          ${removable ? `<button class="ecs-comp-del" data-scr-remove-component="1" type="button" title="Отключить компонент скриптов с объекта">🗑️</button>` : ''}
        </div>
      </div>
      <div class="ecs-comp-body" ${container.collapsed ? 'hidden' : ''} style="gap:8px">
        ${entriesHTML}
        <button class="ed-btn" data-scr-add-new="1" type="button" style="width:100%;justify-content:center;border-color:#a29bfe;color:#dcd6ff;padding:6px">
          ➕ Добавить ещё один кастомный скрипт
        </button>
      </div>
    </div>
  `;
}

export function bindScriptAddonInspectorEvents(cont, scriptData, targetType, onChangedCallback, onRemoveCallback = null) {
  if (!cont || !scriptData) return;
  const container = ensureScriptContainer(scriptData, targetType);
  const cardEl = cont.querySelector('[data-scr-container-card="1"]') || cont;

  const rootHead = cardEl.querySelector('[data-scr-root-toggle="1"]');
  if (rootHead) {
    rootHead.onclick = e => {
      if (e.target.closest('button')) return;
      container.collapsed = !container.collapsed;
      if (onChangedCallback) onChangedCallback(true);
    };
  }

  const removeCompBtn = cardEl.querySelector('[data-scr-remove-component="1"]');
  if (removeCompBtn && onRemoveCallback) {
    removeCompBtn.onclick = e => {
      e.stopPropagation();
      onRemoveCallback();
    };
  }

  cardEl.querySelectorAll('[data-scr-add-new]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const nextTplIdx = container.scripts.length;
      const newEntry = createSingleScriptEntry(targetType, true, nextTplIdx);
      newEntry.name = `${newEntry.name} #${container.scripts.length + 1}`;
      container.collapsed = false;
      container.scripts.push(newEntry);
      syncScriptContainerFlags(container);
      sfx.jump?.();
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  cardEl.querySelectorAll('[data-scr-item-toggle]').forEach(head => {
    head.onclick = e => {
      if (e.target.closest('button')) return;
      const idx = +head.dataset.scrItemToggle;
      const scr = container.scripts[idx];
      if (!scr) return;
      scr.collapsed = !scr.collapsed;
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  cardEl.querySelectorAll('[data-scr-del-idx]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const idx = +btn.dataset.scrDelIdx;
      container.scripts.splice(idx, 1);
      if (container.scripts.length === 0 && onRemoveCallback) {
        syncScriptContainerFlags(container);
        onRemoveCallback();
        return;
      }
      syncScriptContainerFlags(container);
      sfx.oof?.();
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  cardEl.querySelectorAll('[data-scr-enabled]').forEach(chk => {
    chk.onchange = e => {
      const idx = +chk.dataset.scrEnabled;
      const scr = container.scripts[idx];
      if (!scr) return;
      scr.enabled = e.target.checked;
      scr.runtimeDisabled = false;
      scr._compiled = null;
      compileSandboxedScript(scr);
      syncScriptContainerFlags(container);
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  cardEl.querySelectorAll('[data-scr-name]').forEach(inp => {
    inp.oninput = e => {
      const idx = +inp.dataset.scrName;
      const scr = container.scripts[idx];
      if (!scr) return;
      scr.name = e.target.value || `Скрипт #${idx + 1}`;
      syncScriptContainerFlags(container);
      if (onChangedCallback) onChangedCallback(false);
    };
    inp.onchange = () => {
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  cardEl.querySelectorAll('[data-scr-tpl]').forEach(sel => {
    sel.onchange = e => {
      const idx = +sel.dataset.scrTpl;
      const scr = container.scripts[idx];
      const val = e.target.value;
      if (!scr || !val) return;
      if (val.startsWith('lib:')) {
        const libIdx = +val.replace('lib:', '');
        const saved = (S.customScriptsLibrary || []).filter(s => s.targetType === targetType)[libIdx];
        if (saved) {
          scr.name = saved.name;
          scr.code = saved.code;
          scr.paramValues = JSON.parse(JSON.stringify(saved.paramValues || {}));
          scr.enabled = true;
          scr._compiled = null;
        }
      } else {
        const list = SCRIPT_TEMPLATES[targetType] || SCRIPT_TEMPLATES.block;
        const tpl = list.find(t => t.id === val);
        if (tpl) {
          scr.name = tpl.name.replace(/^[^\wа-яА-ЯёЁ]+/, '').trim();
          scr.code = tpl.code;
          scr.paramValues = {};
          scr.enabled = true;
          scr._compiled = null;
        }
      }
      compileSandboxedScript(scr);
      syncScriptContainerFlags(container);
      sfx.coil?.();
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  cardEl.querySelectorAll('[data-scr-open-ide]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.scrOpenIde;
      openScriptStudioModal(container, targetType, () => {
        syncScriptContainerFlags(container);
        if (onChangedCallback) onChangedCallback(true);
      }, idx);
    };
  });

  cardEl.querySelectorAll('[data-scr-save-lib]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.scrSaveLib;
      const scr = container.scripts[idx];
      if (!scr) return;
      if (!Array.isArray(S.customScriptsLibrary)) S.customScriptsLibrary = [];
      S.customScriptsLibrary.push({
        id: 'scr_' + Date.now(),
        targetType,
        name: scr.name || 'Мой Аддон',
        code: scr.code || '',
        paramValues: JSON.parse(JSON.stringify(scr.paramValues || {}))
      });
      sfx.cash?.();
      showBanner(`⭐ Скрипт «${scr.name}» сохранён в библиотеку аддонов!`, '#a29bfe');
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  cardEl.querySelectorAll('[data-scr-restart]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.scrRestart;
      const scr = container.scripts[idx];
      if (!scr) return;
      scr.lastError = '';
      scr.runtimeDisabled = false;
      scr._compiled = null;
      compileSandboxedScript(scr);
      syncScriptContainerFlags(container);
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  cardEl.querySelectorAll('[data-scr-reset-params]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.scrResetParams;
      const scr = container.scripts[idx];
      if (!scr) return;
      scr.paramValues = {};
      parseScriptMetaParams(scr);
      if (onChangedCallback) onChangedCallback(true);
    };
  });

  // Привязка авто-ползунков params для каждого скрипта
  cardEl.querySelectorAll('[data-scr-param]').forEach(inp => {
    const idx = +inp.dataset.scrIdx;
    const key = inp.dataset.scrParam;
    const pType = inp.dataset.scrPtype;
    const scr = container.scripts[idx];
    if (!scr) return;

    const updateVal = raw => {
      if (!scr.paramValues) scr.paramValues = {};
      if (pType === 'boolean') scr.paramValues[key] = Boolean(inp.checked);
      else if (pType === 'number') scr.paramValues[key] = Number(raw) || 0;
      else scr.paramValues[key] = String(raw ?? '');

      const pairedRange = cardEl.querySelector(`[data-scr-idx="${idx}"][data-scr-param-range="${key}"]`);
      if (pairedRange && pairedRange !== inp) pairedRange.value = scr.paramValues[key];
      if (onChangedCallback) onChangedCallback(false);
    };
    inp.oninput = e => updateVal(e.target.value);
    inp.onchange = e => updateVal(e.target.value);
  });

  cardEl.querySelectorAll('[data-scr-param-range]').forEach(rng => {
    const idx = +rng.dataset.scrIdx;
    const key = rng.dataset.scrParamRange;
    const scr = container.scripts[idx];
    if (!scr) return;

    rng.oninput = e => {
      if (!scr.paramValues) scr.paramValues = {};
      const v = Number(e.target.value) || 0;
      scr.paramValues[key] = v;
      const pairedNum = cardEl.querySelector(`[data-scr-idx="${idx}"][data-scr-param="${key}"]`);
      if (pairedNum) pairedNum.value = v;
      if (onChangedCallback) onChangedCallback(false);
    };
  });
}

/* ============================================================================
   6. ВСТРОЕННАЯ В ИГРУ IDE РЕДАКТОРА СКРИПТОВ (#scriptStudioModal)
   ============================================================================ */

const API_CHEATSHEET_ITEMS = [
  { label: '📍 Позиция объекта', snippet: 'const pos = self.getPosition();\nself.setPosition(pos.x, pos.y + 1, pos.z);' },
  { label: '🔄 Вращение объекта', snippet: 'self.rotate(0, 45 * dt, 0);' },
  { label: '🎨 Сменить цвет', snippet: "self.setColor('#00e676');" },
  { label: '🚀 Физический импульс', snippet: 'self.applyImpulse(0, 12, 0);' },
  { label: '📡 Найти цели в радиусе', snippet: 'const list = api.world.getEntitiesInRadius(self.getPosition(), 10);\nfor (const t of list) {\n  if (t.id !== self.id) t.applyImpulse(0, 8, 0);\n}' },
  { label: '👑 Доступ к Игроку', snippet: 'if (api.player) {\n  api.player.heal(15);\n  api.player.applyImpulse(0, 10, 0);\n}' },
  { label: '🌅 Градиент цветов неба', snippet: "const col = api.math.lerpColor('#1565c0', '#050714', 0.5);\napi.world.setSkyColors(col, '#62b6ff', '#dff4ff', '#88ccff');" },
  { label: '🎆 Всплеск 3D-частиц', snippet: "const p = self.getPosition();\napi.world.spawnParticles(p.x, p.y + 1, p.z, 15, { color: '#56f0ff', speed: 5 });" },
  { label: '🔊 Проиграть звук', snippet: "api.audio.playSfx('coil', self.getPosition());" },
  { label: '📢 Показать баннер', snippet: "api.ui.showBanner('Скрипт сработал!', '#ffce3a');" },
  { label: '📝 Вывод в консоль', snippet: "api.log('Текущее время:', api.time.toFixed(1));" }
];

let _activeModalContainer = null;
let _activeModalScriptEntry = null;
let _activeModalScriptIdx = 0;
let _activeModalTargetType = 'block';
let _activeModalOnSave = null;

function ensureScriptStudioModalDOM() {
  let modal = $('scriptStudioModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'scriptStudioModal';
    modal.hidden = true;
    document.body.appendChild(modal);
  }
  if (!modal._eventsIsolated) {
    modal._eventsIsolated = true;
    ['mousedown', 'pointerdown', 'mouseup', 'pointerup', 'click', 'wheel', 'contextmenu'].forEach(evName => {
      modal.addEventListener(evName, e => e.stopPropagation());
    });
  }
  return modal;
}

function updateLineNumbers() {
  const ta = $('scrCodeTextarea');
  const gutter = $('scrLineNumbers');
  if (!ta || !gutter) return;
  const linesCount = Math.max(1, ta.value.split('\n').length);
  let nums = '';
  for (let i = 1; i <= linesCount; i++) {
    nums += i + '\n';
  }
  gutter.textContent = nums;
  gutter.scrollTop = ta.scrollTop;
}

export function renderScriptConsoleOutput() {
  const box = $('scrConsoleOutput');
  if (!box) return;
  const logs = S.scriptLogs || [];
  if (logs.length === 0) {
    box.innerHTML = `<div style="color:#64748b">Консоль песочницы готова. Используй <b>api.log("текст")</b> для отладки.</div>`;
    return;
  }
  box.innerHTML = logs
    .map(l => {
      const col = l.level === 'error' ? '#ff6b6b' : (l.level === 'ok' ? '#00e676' : '#cbd5e1');
      return `<div style="color:${col}">[${l.time}] <b>[${l.source}]</b> ${l.text}</div>`;
    })
    .join('');
  box.scrollTop = box.scrollHeight;
}

export function openScriptStudioModal(scriptDataOrContainer = null, targetType = 'block', onSaveCallback = null, scriptIdx = 0) {
  let container = scriptDataOrContainer;

  if (!container) {
    if (S.selectedRef?.kind === 'block' && S.selectedRef.box) {
      const box = S.selectedRef.box;
      box.scriptData = ensureScriptContainer(box.scriptData, 'block');
      if (box.components) box.components.script = { enabled: true, collapsed: false };
      container = box.scriptData;
      targetType = 'block';
    } else if (S.selectedRef?.kind === 'char' && S.selectedRef.ent && !S.selectedRef.ent.isP) {
      const npc = S.selectedRef.ent;
      const mods = ensureNpcModules(npc);
      mods.customScript = ensureScriptContainer(mods.customScript, 'npc');
      container = mods.customScript;
      targetType = 'npc';
    } else if (S.selectedRef?.kind === 'world_item' && S.selectedRef.worldEntry?.item) {
      const item = S.selectedRef.worldEntry.item;
      item.scriptData = ensureScriptContainer(item.scriptData, 'item');
      container = item.scriptData;
      targetType = 'item';
    } else {
      S.worldSettings.worldScriptData = ensureScriptContainer(S.worldSettings.worldScriptData, 'world');
      container = S.worldSettings.worldScriptData;
      targetType = 'world';
    }
  } else if (!Array.isArray(container.scripts)) {
    // Если передали одиночный объект скрипта или старый контейнер
    container = ensureScriptContainer(container, targetType);
  }

  if (container.scripts.length === 0) {
    container.scripts.push(createSingleScriptEntry(targetType, true, 0));
  }

  const resolvedIdx = clamp(Number(scriptIdx) || 0, 0, container.scripts.length - 1);
  _activeModalContainer = container;
  _activeModalScriptIdx = resolvedIdx;
  _activeModalScriptEntry = container.scripts[resolvedIdx];
  _activeModalTargetType = targetType;
  _activeModalOnSave = onSaveCallback;

  const modal = ensureScriptStudioModalDOM();
  const templates = SCRIPT_TEMPLATES[targetType] || SCRIPT_TEMPLATES.block;
  const typeLabelRU =
    targetType === 'block' ? '🧱 Аддон Блока / Физики' :
    targetType === 'npc' ? '🤖 Аддон ИИ NPC' :
    targetType === 'item' ? '⚔️ Аддон Предмета / Оружия' : '🌍 Аддон Правил Мира';

  const multiSwitchHTML = `
    <select class="ed-inp" id="scrModalSwitchEntry" style="width:175px;border-color:#a29bfe" title="Переключить редактируемый скрипт на этом объекте">
      ${container.scripts.map((s, idx) => `<option value="${idx}" ${idx === resolvedIdx ? 'selected' : ''}>#${idx + 1}: ${s.name || 'Скрипт'}</option>`).join('')}
    </select>
    <button class="ed-btn" id="btnModalAddAnotherScr" type="button" title="Добавить ещё один скрипт на этот объект">➕ Ещё скрипт</button>
  `;

  modal.innerHTML = `
    <div class="scr-ide-box">
      <div class="scr-ide-head">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <span class="badge-3d" style="background:linear-gradient(135deg,#6c5ce7,#00a2ff)">DEBIX SCRIPT SANDBOX</span>
          <b style="font:900 12.5px var(--f);color:#fff">${typeLabelRU}</b>
          ${multiSwitchHTML}
          <input class="ed-inp" id="scrModalNameInp" value="${_activeModalScriptEntry.name || 'Мой Аддон'}" style="width:185px;font-weight:800">
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <select class="ed-inp" id="scrModalTplSelect" style="width:210px">
            <option value="">📂 Загрузить готовый шаблон...</option>
            ${templates.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}
          </select>
          <button class="ed-btn apply-oneclick" id="btnScrCheckAndSave" type="button">✅ Проверить и Применить (Ctrl+S)</button>
          <button class="ed-btn danger" id="btnCloseScrModal" type="button">✕ Закрыть</button>
        </div>
      </div>

      <div class="scr-ide-main">
        <!-- Поле кода с номерами строк -->
        <div class="scr-editor-col">
          <div class="scr-code-wrap">
            <pre class="scr-line-nums" id="scrLineNumbers">1</pre>
            <textarea class="scr-code-area" id="scrCodeTextarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
          </div>
          <div class="scr-console-wrap">
            <div class="scr-console-head">
              <span>🖥️ КОНСОЛЬ ПЕСОЧНИЦЫ И ПРОВЕРКА БЕЗОПАСНОСТИ (Loop Guard: 5000 итер.)</span>
              <button class="ed-btn" id="btnClearScrConsole" type="button" style="padding:1px 7px;font-size:9.5px">Очистить</button>
            </div>
            <div class="scr-console-body" id="scrConsoleOutput"></div>
          </div>
        </div>

        <!-- Правая панель: Шпаргалка API в 1 клик -->
        <div class="scr-api-col">
          <div style="font:900 10.5px var(--f);color:#a29bfe;text-transform:uppercase;letter-spacing:.04em">
            📚 Безопасный API (Кликни для вставки в код)
          </div>
          <div style="font-size:10px;color:#94a3b8;line-height:1.35">
            Все переменные в <b>export const params</b> автоматически создают ползунки в Инспекторе!
          </div>
          <div class="scr-api-list">
            ${API_CHEATSHEET_ITEMS.map((item, idx) => `
              <button class="scr-api-chip" data-api-snip="${idx}" type="button">
                <b>${item.label}</b>
                <code>${item.snippet.split('\n')[0]}</code>
              </button>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  modal.hidden = false;
  S.scriptModalOpen = true;

  const ta = $('scrCodeTextarea');
  ta.value = _activeModalScriptEntry.code || '';
  updateLineNumbers();
  renderScriptConsoleOutput();

  ta.addEventListener('input', updateLineNumbers);
  ta.addEventListener('scroll', () => {
    const gutter = $('scrLineNumbers');
    if (gutter) gutter.scrollTop = ta.scrollTop;
  });

  // Поддержка клавиши Tab (2 пробела) и Ctrl+S внутри редактора кода
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      ta.value = ta.value.substring(0, start) + '  ' + ta.value.substring(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
      updateLineNumbers();
    } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
      e.preventDefault();
      $('btnScrCheckAndSave')?.click();
    }
  });

  if ($('scrModalSwitchEntry')) {
    $('scrModalSwitchEntry').onchange = e => {
      const nextIdx = +e.target.value || 0;
      openScriptStudioModal(_activeModalContainer, _activeModalTargetType, _activeModalOnSave, nextIdx);
    };
  }

  if ($('btnModalAddAnotherScr')) {
    $('btnModalAddAnotherScr').onclick = () => {
      const newEntry = createSingleScriptEntry(_activeModalTargetType, true, _activeModalContainer.scripts.length);
      newEntry.name = `${newEntry.name} #${_activeModalContainer.scripts.length + 1}`;
      _activeModalContainer.scripts.push(newEntry);
      syncScriptContainerFlags(_activeModalContainer);
      sfx.jump?.();
      openScriptStudioModal(_activeModalContainer, _activeModalTargetType, _activeModalOnSave, _activeModalContainer.scripts.length - 1);
    };
  }

  $('scrModalTplSelect').onchange = e => {
    const tpl = templates.find(t => t.id === e.target.value);
    if (!tpl) return;
    ta.value = tpl.code;
    $('scrModalNameInp').value = tpl.name.replace(/^[^\wа-яА-ЯёЁ]+/, '').trim();
    updateLineNumbers();
    sfx.click?.();
  };

  modal.querySelectorAll('[data-api-snip]').forEach(btn => {
    btn.onclick = () => {
      const snip = API_CHEATSHEET_ITEMS[+btn.dataset.apiSnip]?.snippet;
      if (!snip) return;
      const start = ta.selectionStart ?? ta.value.length;
      const end = ta.selectionEnd ?? ta.value.length;
      ta.value = ta.value.substring(0, start) + '\n' + snip + '\n' + ta.value.substring(end);
      ta.focus();
      updateLineNumbers();
      sfx.click?.();
    };
  });

  $('btnClearScrConsole').onclick = () => {
    S.scriptLogs = [];
    renderScriptConsoleOutput();
  };

  $('btnScrCheckAndSave').onclick = () => {
    const nextName = ($('scrModalNameInp').value || '').trim() || 'Мой Аддон';
    const nextCode = ta.value;

    _activeModalScriptEntry.name = nextName;
    _activeModalScriptEntry.code = nextCode;
    _activeModalScriptEntry.enabled = true;
    _activeModalScriptEntry._compiled = null;

    const compiled = compileSandboxedScript(_activeModalScriptEntry);
    syncScriptContainerFlags(_activeModalContainer);

    if (compiled) {
      parseScriptMetaParams(_activeModalScriptEntry);
      pushScriptConsoleLog('ok', nextName, '✅ Код прошёл проверку безопасности и успешно скомпилирован!');
      sfx.cash?.();
      showBanner(`🧩 Скрипт «${nextName}» успешно скомпилирован и применён!`, '#00e676');
      if ($('scrModalSwitchEntry') && $('scrModalSwitchEntry').options[_activeModalScriptIdx]) {
        $('scrModalSwitchEntry').options[_activeModalScriptIdx].textContent = `#${_activeModalScriptIdx + 1}: ${nextName}`;
      }
      if (_activeModalOnSave) _activeModalOnSave(_activeModalContainer);
    } else {
      pushScriptConsoleLog('error', nextName, '❌ Ошибка компиляции: ' + _activeModalScriptEntry.lastError);
      sfx.oof?.();
      showBanner(`❌ Ошибка в скрипте: ${_activeModalScriptEntry.lastError}`, '#ff3e3e');
    }
  };

  $('btnCloseScrModal').onclick = () => {
    modal.hidden = true;
    S.scriptModalOpen = false;
    syncScriptContainerFlags(_activeModalContainer);
    if (_activeModalOnSave) _activeModalOnSave(_activeModalContainer);
  };
}