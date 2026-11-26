// src/core/StatusEffects.js
import { S, $, clamp, rnd, showBanner } from './State.js';
import { scene } from './SceneManager.js';
import { emitParticleBurst } from './ParticleSystem.js';
import { sfx } from './AudioEngine.js';

export const MAX_EFFECT_STACKS = 10;
export const MAX_WET_STACKS = 100;
export const EFFECT_TYPES = ['poison', 'burn', 'freeze'];
export const TEMPERATURE_ORDER = ['freezing', 'cold', 'cool', 'normal', 'warm', 'hot', 'hell'];
export const WET_LIQUID_TYPES = ['water', 'blood', 'acid'];

export function normalizeWetLiquidType(t) {
  if (t === 'blood') return 'blood';
  if (t === 'acid' || t === 'toxic' || t === 'poison') return 'acid';
  return 'water';
}

// 7 градаций температуры мира и их влияние на эффекты, источники и пассивную среду
export const WORLD_TEMPERATURE_PROFILES = {
  freezing: {
    id: 'freezing',
    label: '🥶 Очень холодно',
    burnGainMult: 0.45,
    burnDecayMult: 2.3,
    burnDamageMult: 0.6,
    burnSourceMax: 4,
    freezeGainMult: 1.75,
    freezeDecayMult: 0.35,
    freezeSourceMax: 10,
    poisonGainMult: 0.85,
    poisonDecayMult: 1.15,
    poisonDamageMult: 0.9,
    passiveFreezeRate: 0.24, // Пассивное замерзание мира работает ТОЛЬКО при «Очень холодно»
    passiveBurnRate: 0,
    wetDryRate: 0.9
  },
  cold: {
    id: 'cold',
    label: '❄️ Холодно',
    burnGainMult: 0.72,
    burnDecayMult: 1.45,
    burnDamageMult: 0.82,
    burnSourceMax: 7,
    freezeGainMult: 1.35,
    freezeDecayMult: 0.65,
    freezeSourceMax: 10,
    poisonGainMult: 0.95,
    poisonDecayMult: 1.05,
    poisonDamageMult: 0.95,
    passiveFreezeRate: 0,    // На «Холодно» мир НЕ замерзает
    passiveBurnRate: 0,
    wetDryRate: 1.6
  },
  cool: {
    id: 'cool',
    label: '🌬️ Прохладно',
    burnGainMult: 0.9,
    burnDecayMult: 1.15,
    burnDamageMult: 0.92,
    burnSourceMax: 9,
    freezeGainMult: 1.15,
    freezeDecayMult: 0.85,
    freezeSourceMax: 10,
    poisonGainMult: 1.0,
    poisonDecayMult: 1.0,
    poisonDamageMult: 1.0,
    passiveFreezeRate: 0,
    passiveBurnRate: 0,
    wetDryRate: 2.6
  },
  normal: {
    id: 'normal',
    label: '🌤️ Нормально',
    burnGainMult: 1.0,
    burnDecayMult: 1.0,
    burnDamageMult: 1.0,
    burnSourceMax: 10,
    freezeGainMult: 1.0,
    freezeDecayMult: 1.0,
    freezeSourceMax: 10,
    poisonGainMult: 1.0,
    poisonDecayMult: 1.0,
    poisonDamageMult: 1.0,
    passiveFreezeRate: 0,
    passiveBurnRate: 0,
    wetDryRate: 4.0
  },
  warm: {
    id: 'warm',
    label: '☀️ Тепло',
    burnGainMult: 1.15,
    burnDecayMult: 0.85,
    burnDamageMult: 1.1,
    burnSourceMax: 10,
    freezeGainMult: 0.82,
    freezeDecayMult: 1.35,
    freezeSourceMax: 8,
    poisonGainMult: 1.05,
    poisonDecayMult: 0.95,
    poisonDamageMult: 1.05,
    passiveFreezeRate: 0,
    passiveBurnRate: 0,
    wetDryRate: 6.5
  },
  hot: {
    id: 'hot',
    label: '🔥 Жарко',
    burnGainMult: 1.4,
    burnDecayMult: 0.58,
    burnDamageMult: 1.3,
    burnSourceMax: 10,
    freezeGainMult: 0.45,
    freezeDecayMult: 2.4,
    freezeSourceMax: 4,
    poisonGainMult: 1.12,
    poisonDecayMult: 0.9,
    poisonDamageMult: 1.15,
    passiveFreezeRate: 0,
    passiveBurnRate: 0.04,
    wetDryRate: 11.5
  },
  hell: {
    id: 'hell',
    label: '🌋 Ад',
    burnGainMult: 1.85,
    burnDecayMult: 0.25,
    burnDamageMult: 1.65,
    burnSourceMax: 10,
    freezeGainMult: 0.0,
    freezeDecayMult: 12.0,
    freezeSourceMax: 0,
    poisonGainMult: 1.15,
    poisonDecayMult: 0.85,
    poisonDamageMult: 1.2,
    passiveFreezeRate: 0,
    passiveBurnRate: 0.34,
    wetDryRate: 26.0
  }
};

// Внешние колбэки для исключения циклических импортов
const _hooks = {
  dealDamage: null,
  updateBlockOBB: null,
  onBlockBurnedOut: null,
  triggerStagger: null
};

export function registerStatusEffectsHooks(hooks = {}) {
  if (typeof hooks.dealDamage === 'function') _hooks.dealDamage = hooks.dealDamage;
  if (typeof hooks.updateBlockOBB === 'function') _hooks.updateBlockOBB = hooks.updateBlockOBB;
  if (typeof hooks.onBlockBurnedOut === 'function') _hooks.onBlockBurnedOut = hooks.onBlockBurnedOut;
  if (typeof hooks.triggerStagger === 'function') _hooks.triggerStagger = hooks.triggerStagger;
}

export function dealExternalStatusDamage(target, dmg, opts = {}) {
  if (!_hooks.dealDamage || !target || dmg <= 0) return;
  _hooks.dealDamage(target, Math.max(1, Math.round(dmg)), null, 0, Object.assign({ skipAutoRagdoll: true }, opts));
}

export function triggerExternalStagger(target, dirX = 0, dirZ = 0, strength = 0.7) {
  if (target && _hooks.triggerStagger) {
    _hooks.triggerStagger(target, dirX, dirZ, strength);
  }
}

export function getBaseWorldTemperatureKey() {
  const key = S.worldSettings?.worldTemperature || 'normal';
  return WORLD_TEMPERATURE_PROFILES[key] ? key : 'normal';
}

export function getEffectiveWorldTemperatureKey() {
  const baseKey = getBaseWorldTemperatureKey();
  const baseIdx = TEMPERATURE_ORDER.indexOf(baseKey);
  const offset = Number(S.weatherRuntime?.tempOffset) || 0;
  let effIdx = clamp(Math.round(baseIdx + offset), 0, TEMPERATURE_ORDER.length - 1);
  // Охлаждение осадками не может опустить не-ледяной мир до «Очень холодно» (freezing)
  if (baseKey !== 'freezing' && effIdx === 0) effIdx = 1;
  return TEMPERATURE_ORDER[effIdx] || 'normal';
}

export function getWorldTemperatureProfile() {
  const key = getEffectiveWorldTemperatureKey();
  return WORLD_TEMPERATURE_PROFILES[key] || WORLD_TEMPERATURE_PROFILES.normal;
}

export function createDefaultStatusEffectsState() {
  return {
    poison: { stacks: 0, timer: 0, tickTimer: 0 },
    burn:   { stacks: 0, timer: 0, tickTimer: 0 },
    freeze: { stacks: 0, timer: 0 },
    wet:    { stacks: 0, timer: 0, liquidType: 'water', tickTimer: 0 }
  };
}

export function ensureStatusEffects(target) {
  if (!target) return null;
  if (!target.statusEffects || typeof target.statusEffects !== 'object') {
    target.statusEffects = createDefaultStatusEffectsState();
  } else {
    for (const k of EFFECT_TYPES) {
      if (!target.statusEffects[k]) {
        target.statusEffects[k] = k === 'freeze'
          ? { stacks: 0, timer: 0 }
          : { stacks: 0, timer: 0, tickTimer: 0 };
      }
    }
    if (!target.statusEffects.wet) {
      target.statusEffects.wet = { stacks: 0, timer: 0, liquidType: 'water', tickTimer: 0 };
    }
  }
  return target.statusEffects;
}

export function getWetness(target) {
  return clamp(Number(target?.statusEffects?.wet?.stacks) || 0, 0, MAX_WET_STACKS);
}

export function getWetnessLiquidType(target) {
  return normalizeWetLiquidType(target?.statusEffects?.wet?.liquidType);
}

export function isEntityWet(target) {
  return getWetness(target) >= 5;
}

export function isEntitySoaked(target) {
  return getWetness(target) > 50;
}

// Штраф «Промокшего» — утяжеление и повышенный расход стамины
export function getWetWeightMultiplier(target) {
  const w = getWetness(target);
  if (w > 50) return 1.14;
  if (w >= 15) return 1.04;
  return 1.0;
}

export function getWetStaminaDrainMultiplier(target) {
  return isEntitySoaked(target) ? 1.22 : 1.0;
}

export function applyWetness(target, amount = 8, liquidType = 'water', opts = {}) {
  if (!target || amount <= 0 || !isLivingTarget(target)) return false;
  if (target.isDisabled || target._depletedDisabled || target._deadCooldown > 0 || target._permanentlyDead) return false;
  if (target.isP && S.playerDead) return false;

  const se = ensureStatusEffects(target);
  const safeType = normalizeWetLiquidType(liquidType);

  if (target.effectSource === 'burn') {
    if (Math.random() < 0.25) spawnSteamBurst(target);
    return false;
  }

  let add = amount;
  if (se.burn.stacks > 0) {
    se.burn.timer -= add * 0.28;
    if (se.burn.timer <= 0) {
      se.burn.stacks = Math.max(0, se.burn.stacks - 1);
      se.burn.timer = se.burn.stacks > 0 ? getStackDuration('burn', se.burn.stacks) : 0;
      spawnSteamBurst(target);
    }
    add *= 0.55;
  }

  const prevType = normalizeWetLiquidType(se.wet.liquidType);
  if (safeType === 'water') {
    if (opts.rinse || amount >= 9 || se.wet.stacks < 6) {
      se.wet.liquidType = 'water';
    }
  } else {
    const prio = { water: 0, blood: 1, acid: 2 };
    if (se.wet.stacks < 6 || (prio[safeType] ?? 1) >= (prio[prevType] ?? 0)) {
      se.wet.liquidType = safeType;
    }
  }

  se.wet.stacks = clamp((se.wet.stacks || 0) + add, 0, MAX_WET_STACKS);
  se.wet.timer = Math.max(se.wet.timer || 0, 1.4);
  return true;
}

export function getTargetKind(target) {
  if (!target) return 'unknown';
  if (target.isP || target.isCustomNPC || target.isRemotePlayer || target.rig) return 'living';
  if (target.m && target.id && String(target.id).startsWith('blk_')) return 'block';
  if (target.group && target.item) return 'world_item';
  if (target.useType !== undefined || target.holdMode !== undefined) return 'item';
  return 'unknown';
}

export function isLivingTarget(target) {
  return getTargetKind(target) === 'living';
}

export function isTargetFlammable(target) {
  if (!target) return false;
  if (isLivingTarget(target)) return true;
  if (target.effectSource === 'burn') return true;
  if (getTargetKind(target) === 'world_item') {
    return Boolean(target.isFlammable || target.item?.isFlammable || target.item?.effectSource === 'burn');
  }
  return Boolean(target.isFlammable);
}

export function doesTargetTakeFireDamage(target) {
  if (!target) return false;
  if (target.effectSource === 'burn') return false; // Источник огня не получает урон от собственного горения
  if (isLivingTarget(target)) return true;
  if (getTargetKind(target) === 'world_item') {
    return Boolean(target.takesFireDamage || target.item?.takesFireDamage);
  }
  return Boolean(target.takesFireDamage);
}

export function getEffectStacks(target, type) {
  if (!target) return 0;
  const src = target.effectSource || (target.item?.effectSource);
  let srcStacks = 0;
  if (src === type) {
    const prof = getWorldTemperatureProfile();
    srcStacks = type === 'burn' ? prof.burnSourceMax : (type === 'freeze' ? prof.freezeSourceMax : MAX_EFFECT_STACKS);
  }
  const st = target.statusEffects?.[type]?.stacks || 0;
  const itemSt = target.item?.statusEffects?.[type]?.stacks || 0;
  return Math.max(srcStacks, st, itemSt);
}

export function isEntityFrozen(ent) {
  if (!ent) return false;
  return getEffectStacks(ent, 'freeze') > 0;
}

export function isItemFrozen(item) {
  if (!item) return false;
  return getEffectStacks(item, 'freeze') > 0;
}

export function isBlockSlippery(box) {
  if (!box) return false;
  return getEffectStacks(box, 'freeze') > 0 || Boolean(box._frozenFromLiquid);
}

export function clearTargetStatusEffects(target) {
  if (!target) return;
  const se = ensureStatusEffects(target);
  se.poison.stacks = 0; se.poison.timer = 0; se.poison.tickTimer = 0;
  se.burn.stacks = 0;   se.burn.timer = 0;   se.burn.tickTimer = 0;
  se.freeze.stacks = 0; se.freeze.timer = 0;
  se.wet.stacks = 0;    se.wet.timer = 0;    se.wet.liquidType = 'water'; se.wet.tickTimer = 0;
  if (target._frozenFromLiquid) {
    thawLiquidBlock(target);
  }
}

function getTargetWorldCenter(target, outVec) {
  const kind = getTargetKind(target);
  if (kind === 'living') {
    return outVec.set(target.x || 0, (target.y || 0) + (target.colliderHeight || 2.5) * 0.5, target.z || 0);
  }
  if (kind === 'block' && target.m) {
    return outVec.copy(target.m.position);
  }
  if (kind === 'world_item') {
    return outVec.set(target.x || 0, (target.y || 0) + 0.5, target.z || 0);
  }
  return outVec.set(0, -9999, 0);
}

const _vFxPos = new THREE.Vector3();

export function spawnSteamBurst(target) {
  getTargetWorldCenter(target, _vFxPos);
  if (_vFxPos.y < -5000) return;
  emitParticleBurst(_vFxPos.x, _vFxPos.y, _vFxPos.z, 7, {
    preset: 'smoke',
    color: '#e2f1ff',
    sizeStart: 0.42,
    sizeEnd: 0.95,
    speed: 2.4,
    spread: 0.9,
    gravity: 2.5,
    lifetime: 0.75
  });
  if (target?.isP) sfx.steam?.(0.85);
}

function getStackDuration(type, stacks) {
  // Чем больше стаков, тем дольше эффект держится до потери 1 стака
  if (type === 'poison') return 4.2 + stacks * 0.85;
  if (type === 'burn')   return 3.2 + stacks * 0.65;
  if (type === 'freeze') return 3.6 + stacks * 0.75;
  return 4.0;
}

/**
 * Накладывает статусный эффект на цель с учётом:
 * - горючести (isFlammable),
 * - температуры мира,
 * - взаимной нейтрализации burn <-> freeze,
 * - синхронизации worldItem <-> item.
 */
export function applyStatusEffect(target, type, amount = 1, opts = {}) {
  if (!target || !EFFECT_TYPES.includes(type) || amount <= 0) return false;
  if (target.isDisabled || target._depletedDisabled || target._deadCooldown > 0 || target._permanentlyDead) return false;
  if (target.isP && S.playerDead) return false;

  const kind = getTargetKind(target);
  const prof = getWorldTemperatureProfile();

  const sePre = ensureStatusEffects(target);
  // Проверка допустимости по температуре мира (огонь всегда способен растапливать лёд!)
  if (type === 'freeze' && prof.freezeGainMult <= 0.001) return false;
  if (type === 'burn' && prof.burnGainMult <= 0.001 && sePre.freeze.stacks <= 0 && !target._frozenFromLiquid) return false;

  // Не все блоки и предметы могут гореть
  if (type === 'burn' && !isTargetFlammable(target)) {
    // Но если на негорючий замороженный объект подействовал огонь — он всё равно растапливает лёд!
    const curFreeze = sePre.freeze.stacks;
    if (curFreeze > 0 || target._frozenFromLiquid) {
      const melt = Math.min(curFreeze, Math.max(1, Math.round(amount)));
      sePre.freeze.stacks = Math.max(0, curFreeze - melt);
      sePre.freeze.timer = sePre.freeze.stacks > 0
        ? Math.min(sePre.freeze.timer, getStackDuration('freeze', sePre.freeze.stacks))
        : 0;
      target._heatThawGrace = 2.6;
      spawnSteamBurst(target);
      if (sePre.freeze.stacks <= 0 && target._frozenFromLiquid) {
        thawLiquidBlock(target);
      }
      syncWorldItemEffectsMirror(target);
      return true;
    }
    return false;
  }

  // Жидкости обрабатываются по своим температурным правилам
  if (kind === 'block' && target.matterState === 'liquid') {
    const lTemp = target.liquidTemp || 'neutral';
    if (type === 'burn' && target.effectSource !== 'burn') return false;
    if (type === 'freeze' && lTemp === 'hot') return false;
    if (type === 'poison' && lTemp !== 'neutral' && target.effectSource !== 'poison') return false;
  }

  const se = ensureStatusEffects(target);
  let add = Math.max(1, Math.round(amount));

  // Взаимная нейтрализация: Горение <-> Заморозка (побеждает более сильный по стакам)
  if (type === 'burn' && (se.freeze.stacks > 0 || target._frozenFromLiquid)) {
    const cancel = Math.min(se.freeze.stacks, add);
    se.freeze.stacks = Math.max(0, se.freeze.stacks - cancel);
    add -= cancel;
    target._heatThawGrace = 2.6;
    spawnSteamBurst(target);
    if (se.freeze.stacks <= 0) {
      se.freeze.timer = 0;
      if (target._frozenFromLiquid) thawLiquidBlock(target);
    } else {
      se.freeze.timer = Math.min(se.freeze.timer, getStackDuration('freeze', se.freeze.stacks));
    }
    if (add <= 0) {
      syncWorldItemEffectsMirror(target);
      return true;
    }
  } else if (type === 'freeze' && se.burn.stacks > 0) {
    const cancel = Math.min(se.burn.stacks, add);
    se.burn.stacks -= cancel;
    add -= cancel;
    spawnSteamBurst(target);
    if (se.burn.stacks <= 0) {
      se.burn.timer = 0;
    }
    if (add <= 0) {
      syncWorldItemEffectsMirror(target);
      return true;
    }
  }

  // Мокрый/промокший персонаж: защита от горения и уязвимость к заморозке
  const wetAmt = kind === 'living' ? (se.wet?.stacks || 0) : 0;
  if (type === 'burn' && wetAmt >= 5 && target.effectSource !== 'burn') {
    const soaked = wetAmt > 50;
    if (soaked || Math.random() < 0.35) {
      add = Math.max(0, add - 1);
      se.wet.stacks = Math.max(0, se.wet.stacks - (soaked ? 18 : 12));
      spawnSteamBurst(target);
      if (add <= 0) return true;
    }
  } else if (type === 'freeze' && wetAmt > 50 && !opts.noWetBonus) {
    add += 1;
  }

  // Источник эффекта не теряет свой эффект и не перекрывается более слабым
  const eff = se[type];
  const prevStacks = eff.stacks;
  const maxCap = opts.maxStacks ? Math.min(MAX_EFFECT_STACKS, opts.maxStacks) : MAX_EFFECT_STACKS;
  eff.stacks = clamp(eff.stacks + add, 0, maxCap);

  const wetDurBoost = (type === 'freeze' && wetAmt >= 5) ? (wetAmt > 50 ? 1.65 : 1.3) : 1.0;
  const mult = type === 'burn' ? prof.burnGainMult : (type === 'freeze' ? prof.freezeGainMult : prof.poisonGainMult);
  eff.timer = Math.max(eff.timer, getStackDuration(type, eff.stacks) * clamp(mult, 0.35, 2.0) * wetDurBoost);

  // Если заморозилась нейтральная или холодная жидкость — превращаем её в лёд!
  if (kind === 'block' && target.matterState === 'liquid' && type === 'freeze') {
    const lTemp = target.liquidTemp || 'neutral';
    const freezeThreshold = lTemp === 'cold' ? 1 : 2;
    if (eff.stacks >= freezeThreshold) {
      freezeLiquidBlock(target);
    }
  }

  // При заморозке игрока мгновенно выключаем полёт и сбрасываем заряд броска
    if (type === 'freeze' && eff.stacks > 0 && target.isP) {
    target.isFlying = false;
    S.isChargingThrow = false;
    S.throwChargeT = 0;
    if (prevStacks === 0) {
      sfx.freeze?.(0.95);
      showBanner('❄️ Вы заморожены! Движение заблокировано, пока лёд не растает.', '#56f0ff');
    }
  }

  syncWorldItemEffectsMirror(target);
  return true;
}

function syncWorldItemEffectsMirror(target) {
  if (!target) return;
  if (getTargetKind(target) === 'world_item' && target.item) {
    target.item.statusEffects = JSON.parse(JSON.stringify(ensureStatusEffects(target)));
  }
}

/* ---------- ЗАМОРОЗКА И ОТТАИВАНИЕ ЖИДКОСТЕЙ ---------- */

export function freezeLiquidBlock(box) {
  if (!box || box.matterState !== 'liquid' || box._frozenFromLiquid) return;
  box._frozenFromLiquid = true;
  box._boilProgress = 0;
  box._origColorHex = box.colorHex;
  const firstMat = Array.isArray(box.m?.material) ? box.m.material[0] : box.m?.material;
  box._origOpacity = firstMat?.opacity ?? 0.72;
  box._origTransparent = firstMat?.transparent ?? true;
  box.matterState = 'solid';

  if (box.m && box.m.material) {
    const mats = Array.isArray(box.m.material) ? box.m.material : [box.m.material];
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (!m) continue;
      if (m.color) m.color.set('#b9ecff');
      if (m.roughness !== undefined) m.roughness = 0.14;
      m.transparent = true;
      m.opacity = 0.88;
    }
  }
  if (_hooks.updateBlockOBB) _hooks.updateBlockOBB(box);
  spawnSteamBurst(box);
}

export function thawLiquidBlock(box) {
  if (!box || !box._frozenFromLiquid) return;
  box._frozenFromLiquid = false;
  box.matterState = 'liquid';
  if (box.m && box.m.material) {
    const mats = Array.isArray(box.m.material) ? box.m.material : [box.m.material];
    for (let i = 0; i < mats.length; i++) {
      const m = mats[i];
      if (!m) continue;
      if (m.color) m.color.set(box._origColorHex || '#38bdf8');
      m.transparent = true;
      m.opacity = box._origOpacity ?? 0.72;
    }
  }
  if (_hooks.updateBlockOBB) _hooks.updateBlockOBB(box);
}

/* ---------- ПЕРЕДАЧА ЭФФЕКТОВ ПРИ КОНТАКТЕ ---------- */

/**
 * Передаёт эффекты от source к target (и опционально в обратную сторону при bidirectional=true).
 * @param {object} source
 * @param {object} target
 * @param {number} dt - 0 для мгновенного удара (ближний бой, пинок, снаряд), >0 для непрерывного контакта.
 * @param {boolean} bidirectional
 * @param {number} chanceMult
 */
export function transferEffectsOnContact(source, target, dt = 0, bidirectional = false, chanceMult = 1.0) {
  if (!source || !target || source === target) return;
  const prof = getWorldTemperatureProfile();

  const transferOneWay = (from, to) => {
    const toSe = ensureStatusEffects(to);
    for (let i = 0; i < EFFECT_TYPES.length; i++) {
      const type = EFFECT_TYPES[i];
      const stacks = getEffectStacks(from, type);
      if (stacks <= 0) continue;

      const isPermSource = (from.effectSource === type) || (from.item?.effectSource === type);
      // При непрерывном контакте вторичный носитель не может накручивать стаки выше себя (защита от пинг-понга)
      if (dt > 0 && !isPermSource) {
        if (type === 'freeze' && (to._heatThawGrace || 0) > 0) continue;
        const maxTransfer = stacks - 1;
        const targetCur = toSe[type]?.stacks || 0;
        if (maxTransfer <= 0 || targetCur >= maxTransfer) continue;
      }

      // При контакте с горящим объектом/сущностью живые получают и урон, и шанс загореться
      const tempMult = type === 'burn' ? prof.burnGainMult : (type === 'freeze' ? prof.freezeGainMult : prof.poisonGainMult);
      if (tempMult <= 0.001) continue;

      // Шанс передачи пропорционален стакам эффекта (1 стак ~22%, 10 стаков ~96%)
      const baseProb = clamp((0.14 + stacks * 0.082) * chanceMult * tempMult, 0.04, 0.96);
      const triggerProb = dt > 0
        ? (1 - Math.pow(1 - baseProb, dt * 1.65))
        : baseProb;

      if (Math.random() < triggerProb) {
        const grantStacks = (isPermSource && stacks >= 7) ? 2 : 1;
        const cap = isPermSource ? MAX_EFFECT_STACKS : Math.max(1, stacks - (dt > 0 ? 1 : 0));
        applyStatusEffect(to, type, grantStacks, { maxStacks: cap });
      }

      // Прямой контактный ожог живых при касании горящего объекта/персонажа
      if (type === 'burn' && isLivingTarget(to) && to.effectSource !== 'burn' && _hooks.dealDamage) {
        if (dt > 0) {
          if ((to._burnContactCd || 0) <= 0) {
            to._burnContactCd = 0.6;
            const cDmg = Math.round((2 + stacks * 1.1) * prof.burnDamageMult);
            _hooks.dealDamage(to, cDmg, null, 0, { skipAutoRagdoll: true });
          }
        } else {
          const cDmg = Math.round((2 + stacks * 1.2) * prof.burnDamageMult);
          _hooks.dealDamage(to, cDmg, null, 0, { skipAutoRagdoll: true });
        }
      }
    }
  };

  transferOneWay(source, target);
  if (bidirectional) {
    transferOneWay(target, source);
  }
}

/**
 * Специальное взаимодействие любой цели (игрок, NPC, блок, предмет) с блоком жидкости.
 */
export function interactTargetWithLiquid(target, liquidBlock, dt = 0.016) {
  if (!target || !liquidBlock || target === liquidBlock) return;
  if (liquidBlock._frozenFromLiquid) {
    // Замёрзшая жидкость ведёт себя как твёрдый лёд
    transferEffectsOnContact(liquidBlock, target, dt, true, 1.0);
    return;
  }
  if (liquidBlock.matterState !== 'liquid') return;

  const lTemp = liquidBlock.liquidTemp || 'neutral';
  const tSe = ensureStatusEffects(target);

  // 1. Горячая жидкость снимает заморозку и быстро сушит мокроту
  if (lTemp === 'hot') {
    if (tSe.freeze.stacks > 0) {
      tSe.freeze.stacks = 0;
      tSe.freeze.timer = 0;
      spawnSteamBurst(target);
      syncWorldItemEffectsMirror(target);
    }
    if (tSe.wet.stacks > 0) {
      tSe.wet.stacks = Math.max(0, tSe.wet.stacks - 42 * dt);
      if (Math.random() < dt * 2.5) spawnSteamBurst(target);
    }
  }

  // 2. Нейтральная и холодная жидкости тушат горение и намачивают живых
  if (lTemp === 'neutral' || lTemp === 'cold') {
    if (tSe.burn.stacks > 0 && target.effectSource !== 'burn') {
      tSe.burn.stacks = 0;
      tSe.burn.timer = 0;
      spawnSteamBurst(target);
      syncWorldItemEffectsMirror(target);
    }
    if (isLivingTarget(target) && liquidBlock.effectSource !== 'burn') {
      const isAcidic = liquidBlock.effectSource === 'poison' || (liquidBlock.statusEffects?.poison?.stacks || 0) > 0;
      const liqType = isAcidic ? 'acid' : 'water';
      applyWetness(target, 48 * dt, liqType, { rinse: liqType === 'water' });
    }
  }

  // 3. Заморозка замораживает нейтральную и холодную жидкость в лёд
  const targetFreeze = getEffectStacks(target, 'freeze');
  if (targetFreeze > 0 && (lTemp === 'neutral' || lTemp === 'cold')) {
    const rate = lTemp === 'cold' ? 1.8 : 0.95;
    const prob = 1 - Math.pow(1 - clamp(0.18 + targetFreeze * 0.08, 0.1, 0.95), dt * rate);
    if (Math.random() < prob) {
      applyStatusEffect(liquidBlock, 'freeze', targetFreeze >= 5 ? 2 : 1);
    }
  }

  // 4. Яд отравляет нейтральную жидкость
  const targetPoison = getEffectStacks(target, 'poison');
  if (targetPoison > 0 && lTemp === 'neutral') {
    const prob = 1 - Math.pow(1 - clamp(0.15 + targetPoison * 0.08, 0.1, 0.92), dt * 1.1);
    if (Math.random() < prob) {
      applyStatusEffect(liquidBlock, 'poison', 1);
    }
  }

  // 5. Сама жидкость передаёт свои эффекты (отравленная вода, ледяная вода, лава-источник) цели
  transferEffectsOnContact(liquidBlock, target, dt, false, 1.15);
}

/* ---------- ПУЛ 3D ЛЕДЯНЫХ ОБОЛОЧЕК (ZERO-ALLOCATION В ИГРОВОМ ЦИКЛЕ) ---------- */

let _iceOverlayGroup = null;
let _iceGeo = null;
let _iceMat = null;
const _iceCubePool = [];
let _icePoolCursor = 0;

function ensureIceOverlayPool() {
  if (!_iceOverlayGroup) {
    _iceOverlayGroup = new THREE.Group();
    _iceOverlayGroup.name = 'StatusEffectsIceOverlays';
    _iceOverlayGroup.userData.noCollider = true;
    scene.add(_iceOverlayGroup);
  }
  if (!_iceGeo) {
    _iceGeo = new THREE.BoxGeometry(1, 1, 1);
  }
  if (!_iceMat) {
    _iceMat = new THREE.MeshStandardMaterial({
      color: 0xa5f3fc,
      emissive: 0x0ea5e9,
      emissiveIntensity: 0.32,
      roughness: 0.12,
      metalness: 0.08,
      transparent: true,
      opacity: 0.48,
      depthWrite: false
    });
  }
}

function acquireIceCubeMesh() {
  ensureIceOverlayPool();
  if (_icePoolCursor < _iceCubePool.length) {
    const m = _iceCubePool[_icePoolCursor++];
    m.visible = true;
    return m;
  }
  const m = new THREE.Mesh(_iceGeo, _iceMat);
  m.userData.noCollider = true;
  m.castShadow = false;
  m.receiveShadow = false;
  m.renderOrder = 4;
  _iceOverlayGroup.add(m);
  _iceCubePool.push(m);
  _icePoolCursor++;
  return m;
}

export function clearAllStatusEffectVisuals() {
  for (let i = 0; i < _iceCubePool.length; i++) {
    _iceCubePool[i].visible = false;
  }
  _icePoolCursor = 0;
}

function renderIceShellForTarget(target, freezeStacks) {
  if (freezeStacks <= 0) return;
  const kind = getTargetKind(target);
  const cube = acquireIceCubeMesh();

  if (kind === 'living') {
    const scY = target.rig?.g?.scale?.y || 1;
    const scX = target.rig?.g?.scale?.x || 1;
    const h = (target.colliderHeight || 2.5) * scY;
    const w = Math.max(1.35, (target.colliderRadius || 0.42) * 3.2) * scX;
    cube.position.set(target.x, target.y + h * 0.5, target.z);
    if (target.rig?.g) {
      cube.quaternion.copy(target.rig.g.quaternion);
    } else {
      cube.quaternion.identity();
    }
    cube.scale.set(w, h + 0.18, w);
  } else if (kind === 'block' && target.m) {
    cube.position.copy(target.m.position);
    cube.quaternion.copy(target.m.quaternion);
    cube.scale.set((target.w || 1) + 0.14, (target.h || 1) + 0.14, (target.d || 1) + 0.14);
  } else if (kind === 'world_item' && target.group) {
    const sz = target.item?.holdMode === 'carried' ? 1.35 : 0.88;
    cube.position.copy(target.group.position);
    cube.quaternion.copy(target.group.quaternion);
    cube.scale.set(sz * (target.scaleX || 1), sz * (target.scaleY || 1), sz * (target.scaleZ || 1));
  } else {
    cube.visible = false;
  }
}

/* ---------- ЧАСТИЦЫ ЭФФЕКТОВ И СВЕТ ГОРЕНИЯ ---------- */

function emitStatusParticlesForTarget(target, dt) {
  const pStacks = getEffectStacks(target, 'poison');
  const bStacks = getEffectStacks(target, 'burn');
  const fStacks = getEffectStacks(target, 'freeze');
  const wetAmt = isLivingTarget(target) ? getWetness(target) : 0;
  if (pStacks <= 0 && bStacks <= 0 && fStacks <= 0 && wetAmt < 8) return;

  getTargetWorldCenter(target, _vFxPos);
  if (_vFxPos.y < -5000) return;

  const kind = getTargetKind(target);
  const spread = kind === 'block'
    ? clamp(Math.max(target.w || 1, target.d || 1) * 0.32, 0.4, 2.2)
    : 0.45;
  const hHalf = kind === 'block' ? (target.h || 1) * 0.45 : (kind === 'living' ? 1.0 : 0.3);

  if (bStacks > 0 && Math.random() < dt * (2.2 + bStacks * 0.9)) {
    emitParticleBurst(
      _vFxPos.x + rnd(-spread, spread),
      _vFxPos.y + rnd(-hHalf * 0.4, hHalf * 0.6),
      _vFxPos.z + rnd(-spread, spread),
      1,
      {
        preset: 'fire',
        color: Math.random() < 0.35 ? '#ffce3a' : '#ff5722',
        sizeStart: 0.32 + bStacks * 0.03,
        sizeEnd: 0.08,
        speed: 2.2,
        spread: 0.45,
        gravity: 3.8,
        lifetime: 0.55
      }
    );
  }

  if (pStacks > 0 && Math.random() < dt * (1.6 + pStacks * 0.65)) {
    emitParticleBurst(
      _vFxPos.x + rnd(-spread, spread),
      _vFxPos.y + rnd(-hHalf * 0.3, hHalf * 0.6),
      _vFxPos.z + rnd(-spread, spread),
      1,
      {
        preset: 'circle',
        color: Math.random() < 0.4 ? '#a3e635' : '#22c55e',
        sizeStart: 0.22 + pStacks * 0.02,
        sizeEnd: 0.04,
        speed: 1.4,
        spread: 0.55,
        gravity: 1.5,
        lifetime: 0.72
      }
    );
  }

  if (fStacks > 0 && Math.random() < dt * (1.2 + fStacks * 0.45)) {
    emitParticleBurst(
      _vFxPos.x + rnd(-spread, spread),
      _vFxPos.y + rnd(-hHalf * 0.2, hHalf * 0.7),
      _vFxPos.z + rnd(-spread, spread),
      1,
      {
        preset: 'snow',
        color: '#bae6fd',
        sizeStart: 0.22,
        sizeEnd: 0.05,
        speed: 0.9,
        spread: 0.65,
        gravity: -1.4,
        lifetime: 0.85
      }
    );
  }

  if (wetAmt >= 8 && fStacks <= 0) {
    const dripRate = wetAmt > 50 ? 6.5 : 2.6;
    if (Math.random() < dt * dripRate) {
      const lType = getWetnessLiquidType(target);
      const dripCol = lType === 'blood' ? '#dc2626' : (lType === 'acid' ? '#4ade80' : '#7dd3fc');
      emitParticleBurst(
        _vFxPos.x + rnd(-0.42, 0.42),
        _vFxPos.y + rnd(-0.35, 0.55),
        _vFxPos.z + rnd(-0.42, 0.42),
        1,
        {
          preset: 'circle',
          color: dripCol,
          sizeStart: wetAmt > 50 ? 0.14 : 0.1,
          sizeEnd: 0.04,
          speed: 0.35,
          spread: 0.2,
          gravity: -10.5,
          lifetime: 0.48
        }
      );
      if (target.isP && Math.random() < 0.08) sfx.wetDrip?.(0.65);
    }
  }
}

/**
 * Вызывается из WorldRegistry.updateWorldLights — добавляет динамический свет от горящих объектов в общий пул PointLight.
 */
export function collectBurningLightCandidates(pushCandidateFn) {
  if (typeof pushCandidateFn !== 'function') return;

  const checkTarget = t => {
    const bStacks = getEffectStacks(t, 'burn');
    if (bStacks <= 0) return;
    getTargetWorldCenter(t, _vFxPos);
    if (_vFxPos.y < -5000) return;
    const flicker = 0.86 + 0.14 * Math.sin((S.time || 0) * 19 + _vFxPos.x * 3.1);
    const intensity = clamp(0.85 + bStacks * 0.22, 0.85, 3.2);
    const dist = clamp(6.5 + bStacks * 1.15, 6.5, 18.0);
    pushCandidateFn(_vFxPos, '#ff7b29', intensity, dist, flicker);
  };

  if (S.player && !S.playerDead) checkTarget(S.player);
  for (let i = 0; i < S.customNPCs.length; i++) {
    const n = S.customNPCs[i];
    if (n && !n.isDisabled && !(n._deadCooldown > 0) && !n._permanentlyDead) checkTarget(n);
  }
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (b && !b.isDisabled && !b._depletedDisabled) checkTarget(b);
  }
  for (let i = 0; i < S.worldItems.length; i++) {
    const wi = S.worldItems[i];
    if (wi && !wi.isDisabled) checkTarget(wi);
  }
}

/* ---------- ГЛАВНЫЙ КАДРОВЫЙ ТИК СТАТУСНЫХ ЭФФЕКТОВ ---------- */

function tickTargetStatusEffects(target, dt, prof) {
  if (!target) return;
  const kind = getTargetKind(target);
  const se = ensureStatusEffects(target);
  if (target._burnContactCd > 0) target._burnContactCd = Math.max(0, target._burnContactCd - dt);
  if (target._heatThawGrace > 0) target._heatThawGrace = Math.max(0, target._heatThawGrace - dt);
  // 1. Поддержание перманентного источника эффекта с учётом температуры мира
  const srcType = target.effectSource || target.item?.effectSource || 'none';
  if (target._frozenFromLiquid && se.freeze.stacks <= 0 && srcType !== 'freeze') {
    thawLiquidBlock(target);
  }

  if (srcType !== 'none' && EFFECT_TYPES.includes(srcType)) {
    const srcMax = srcType === 'burn'
      ? prof.burnSourceMax
      : (srcType === 'freeze' ? prof.freezeSourceMax : MAX_EFFECT_STACKS);
    if (srcMax > 0) {
      se[srcType].stacks = srcMax;
      se[srcType].timer = 999;
    } else {
      // Например, ледяной источник полностью нивелирован в «Ад»
      se[srcType].stacks = 0;
      se[srcType].timer = 0;
    }
  }

  // 1.5. Сушка статуса «Мокрый / Промокший» и остаточный яд при кислотном загрязнении
  if (kind === 'living' && se.wet && se.wet.stacks > 0) {
    if (se.wet.timer > 0) {
      se.wet.timer = Math.max(0, se.wet.timer - dt);
    } else {
      const dryRate = (prof.wetDryRate || 4.0) + (se.burn.stacks > 0 ? 14.0 : 0);
      se.wet.stacks = Math.max(0, se.wet.stacks - dryRate * dt);
      if (se.wet.stacks <= 0.1) {
        se.wet.stacks = 0;
        se.wet.liquidType = 'water';
        se.wet.tickTimer = 0;
      }
    }

    if (se.wet.stacks >= 8 && normalizeWetLiquidType(se.wet.liquidType) === 'acid') {
      se.wet.tickTimer = (se.wet.tickTimer || 0) - dt;
      if (se.wet.tickTimer <= 0) {
        const soaked = se.wet.stacks > 50;
        se.wet.tickTimer = 1.5;
        if (Math.random() < (soaked ? 0.55 : 0.28)) {
          applyStatusEffect(target, 'poison', 1, { maxStacks: 6 });
        }
      }
    }
  }

  // 2. Пассивное влияние экстремальной температуры мира (замерзание ТОЛЬКО при freezing)
  if (prof.passiveFreezeRate > 0 && srcType !== 'burn') {
    const canPassiveFreeze =
      kind === 'living' ||
      (kind === 'block' && target.matterState === 'liquid' && (target.liquidTemp || 'neutral') !== 'hot');
    const wetFreezeMult = kind === 'living'
      ? (se.wet.stacks > 50 ? 2.25 : (se.wet.stacks >= 5 ? 1.55 : 1.0))
      : 1.0;
    if (canPassiveFreeze && Math.random() < prof.passiveFreezeRate * wetFreezeMult * dt) {
      applyStatusEffect(target, 'freeze', 1, { maxStacks: kind === 'living' ? 5 : 4, noWetBonus: true });
    }
  }
  if (prof.passiveBurnRate > 0 && srcType !== 'freeze') {
    const canPassiveBurn = kind === 'living' || (isTargetFlammable(target) && kind !== 'unknown');
    if (canPassiveBurn && Math.random() < prof.passiveBurnRate * dt) {
      applyStatusEffect(target, 'burn', 1, { maxStacks: 6 });
    }
  }

  // 3. Таймеры затухания стаков (не действуют на свой собственный эффект у источника)
  for (let i = 0; i < EFFECT_TYPES.length; i++) {
    const type = EFFECT_TYPES[i];
    const eff = se[type];
    if (eff.stacks <= 0) continue;

    if (srcType === type) continue; // Источник не гаснет сам по себе

    const decayMult = type === 'burn'
      ? prof.burnDecayMult
      : (type === 'freeze' ? prof.freezeDecayMult : prof.poisonDecayMult);

    eff.timer -= dt * decayMult;
    if (eff.timer <= 0) {
      eff.stacks = Math.max(0, eff.stacks - 1);
      if (eff.stacks > 0) {
        eff.timer = getStackDuration(type, eff.stacks);
      } else {
        eff.timer = 0;
        if (type === 'freeze' && target._frozenFromLiquid) {
          thawLiquidBlock(target);
        }
      }
    }
  }

  // 4. Периодический урон от Отравления (только живым)
  if (se.poison.stacks > 0 && kind === 'living' && srcType !== 'poison') {
    se.poison.tickTimer = (se.poison.tickTimer || 0) - dt;
    if (se.poison.tickTimer <= 0) {
      se.poison.tickTimer = 1.1;
      if (target.isP) sfx.poisonBubble?.(0.75);
      const dmg = Math.max(1, Math.round((2 + se.poison.stacks * 1.55) * prof.poisonDamageMult));
      if (_hooks.dealDamage) {
        _hooks.dealDamage(target, dmg, null, 0, { skipAutoRagdoll: true });
      }
    }
  }

  // 5. Периодический урон от Горения (живым всегда; блокам/предметам — только при takesFireDamage)
  if (se.burn.stacks > 0 && doesTargetTakeFireDamage(target)) {
    se.burn.tickTimer = (se.burn.tickTimer || 0) - dt;
    if (se.burn.tickTimer <= 0) {
      se.burn.tickTimer = 0.78;
      if (target.isP) sfx.burnCrack?.(0.75);
      const wetFireProt = (kind === 'living' && se.wet?.stacks >= 5)
        ? (se.wet.stacks > 50 ? 0.6 : 0.78)
        : 1.0;
      const dmg = Math.max(1, Math.round((3 + se.burn.stacks * 2.15) * prof.burnDamageMult * wetFireProt));
      if (kind === 'living') {
        if (_hooks.dealDamage) {
          _hooks.dealDamage(target, dmg, null, 0, { skipAutoRagdoll: true });
        }
      } else if (kind === 'block') {
        if (target.fireHp === undefined) target.fireHp = target.maxFireHp || 100;
        target.fireHp = Math.max(0, target.fireHp - dmg);
        if (target.fireHp <= 0) {
          target._burnedOut = true;
          target._depletedDisabled = true;
          if (target.m) target.m.visible = false;
          if (target.haloSprite) target.haloSprite.visible = false;
          if (target.cpVisualGroup) target.cpVisualGroup.visible = false;
          if (_hooks.updateBlockOBB) _hooks.updateBlockOBB(target);
          spawnSteamBurst(target);
          if (_hooks.onBlockBurnedOut) _hooks.onBlockBurnedOut(target);
        }
      } else if (kind === 'world_item' && target.item) {
        if (!target.item.infiniteDurability) {
          target.item.durability = Math.max(0, (target.item.durability ?? target.item.maxDurability ?? 100) - dmg);
          if (target.item.durability <= 0) {
            target._burnedOutItem = true;
          }
        }
      }
    }
  }

  // 6. Зеркалирование состояния для предметов в мире
  if (kind === 'world_item') {
    syncWorldItemEffectsMirror(target);
  }

  // 7. Визуальная ледяная оболочка и частицы
  const fStacks = getEffectStacks(target, 'freeze');
  if (fStacks > 0 && !(kind === 'block' && target._frozenFromLiquid)) {
    renderIceShellForTarget(target, fStacks);
  }
  emitStatusParticlesForTarget(target, dt);
}

// Обновление эффектов на предметах, лежащих в инвентаре / руках сущности
function tickInventoryItemsEffects(ent, dt, prof) {
  if (!ent) return;
  const list = [];
  if (Array.isArray(ent.inventory)) {
    for (let i = 0; i < ent.inventory.length; i++) {
      if (ent.inventory[i]) list.push(ent.inventory[i]);
    }
  }
  if (ent.carriedItem) list.push(ent.carriedItem);
  if (ent.equippedItem) list.push(ent.equippedItem);

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    const se = ensureStatusEffects(it);
    const src = it.effectSource || 'none';
    if (src !== 'none' && EFFECT_TYPES.includes(src)) {
      const srcMax = src === 'burn' ? prof.burnSourceMax : (src === 'freeze' ? prof.freezeSourceMax : MAX_EFFECT_STACKS);
      se[src].stacks = srcMax;
      se[src].timer = srcMax > 0 ? 999 : 0;
    }
    for (let k = 0; k < EFFECT_TYPES.length; k++) {
      const t = EFFECT_TYPES[k];
      if (se[t].stacks <= 0 || src === t) continue;
      const dMult = t === 'burn' ? prof.burnDecayMult : (t === 'freeze' ? prof.freezeDecayMult : prof.poisonDecayMult);
      se[t].timer -= dt * dMult;
      if (se[t].timer <= 0) {
        se[t].stacks = Math.max(0, se[t].stacks - 1);
        se[t].timer = se[t].stacks > 0 ? getStackDuration(t, se[t].stacks) : 0;
      }
    }
  }
}

export function updateStatusEffectsRuntime(dt) {
  _icePoolCursor = 0;
  const prof = getWorldTemperatureProfile();

  // 1. Игрок
  if (S.player && !S.playerDead) {
    tickTargetStatusEffects(S.player, dt, prof);
    tickInventoryItemsEffects(S.player, dt, prof);
  }

  // 2. NPC
  for (let i = 0; i < S.customNPCs.length; i++) {
    const npc = S.customNPCs[i];
    if (!npc || npc.isDisabled || npc._deadCooldown > 0 || npc._permanentlyDead) continue;
    tickTargetStatusEffects(npc, dt, prof);
    tickInventoryItemsEffects(npc, dt, prof);
  }

  // 3. Блоки сцены
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b.isDisabled || b._depletedDisabled) continue;
    const hasAny =
      Boolean(b._frozenFromLiquid) ||
      (b.effectSource && b.effectSource !== 'none') ||
      (b.statusEffects && (b.statusEffects.poison?.stacks > 0 || b.statusEffects.burn?.stacks > 0 || b.statusEffects.freeze?.stacks > 0)) ||
      (prof.passiveFreezeRate > 0 && b.matterState === 'liquid') ||
      (prof.passiveBurnRate > 0 && b.isFlammable);
    if (!hasAny) continue;
    tickTargetStatusEffects(b, dt, prof);
  }

  // 4. Предметы в мире
  for (let i = S.worldItems.length - 1; i >= 0; i--) {
    const wi = S.worldItems[i];
    if (!wi || wi.isDisabled) continue;
    tickTargetStatusEffects(wi, dt, prof);
    if (wi._burnedOutItem) {
      if (wi.group) scene.remove(wi.group);
      if (wi.tag) scene.remove(wi.tag);
      S.worldItems.splice(i, 1);
    }
  }

  // Скрываем неиспользованные ледяные кубы из пула
  for (let i = _icePoolCursor; i < _iceCubePool.length; i++) {
    _iceCubePool[i].visible = false;
  }
  updatePlayerStatusHUD();
}

export function resetAllStatusEffectsRuntime() {
  if (S.weatherRuntime) {
    S.weatherRuntime.tempOffset = 0;
    S.weatherRuntime.duration = 0;
    S.weatherRuntime.effectiveTemp = getBaseWorldTemperatureKey();
  }
  clearAllStatusEffectVisuals();
  if (S.player) clearTargetStatusEffects(S.player);
  for (let i = 0; i < S.customNPCs.length; i++) {
    if (S.customNPCs[i]) clearTargetStatusEffects(S.customNPCs[i]);
  }
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b) continue;
    clearTargetStatusEffects(b);
    if (b._burnedOut) {
      b._burnedOut = false;
      b.fireHp = b.maxFireHp || 100;
    }
  }
  for (let i = 0; i < S.worldItems.length; i++) {
    if (S.worldItems[i]) clearTargetStatusEffects(S.worldItems[i]);
  }
}

let _lastStatusHudSig = '';

export function updatePlayerStatusHUD() {
  const wrap = $('statusEffectsHUD');
  if (!wrap) return;

  if (S.state !== 'play' || !S.player || S.playerDead) {
    if (!wrap.hidden) wrap.hidden = true;
    _lastStatusHudSig = '';
    return;
  }

  const p = S.player;
  const pSt = getEffectStacks(p, 'poison');
  const bSt = getEffectStacks(p, 'burn');
  const fSt = getEffectStacks(p, 'freeze');
  const wetAmt = Math.round(getWetness(p));
  const wetTier = wetAmt > 50 ? 2 : (wetAmt >= 5 ? 1 : 0);
  const wetType = getWetnessLiquidType(p);
  const effTempKey = getEffectiveWorldTemperatureKey();
  const baseTempKey = getBaseWorldTemperatureKey();
  const phase = S.weatherRuntime?.phase || 'none';
  const phaseLabel = S.weatherRuntime?.phaseLabel || '';

  const sig = `${pSt}|${bSt}|${fSt}|${wetTier}:${Math.floor(wetAmt / 10)}:${wetType}|${effTempKey}|${baseTempKey}|${phase}`;
  if (sig === _lastStatusHudSig) return;
  _lastStatusHudSig = sig;

  const pills = [];
  if (pSt > 0) {
    pills.push(`<div class="se-pill se-poison">☠️ Отравление <b>x${pSt}</b></div>`);
  }
  if (bSt > 0) {
    pills.push(`<div class="se-pill se-burn">🔥 Горение <b>x${bSt}</b></div>`);
  }
  if (fSt > 0) {
    pills.push(`<div class="se-pill se-freeze">❄️ Заморозка <b>x${fSt}</b></div>`);
  }
  if (wetTier > 0) {
    const liqTag = wetType === 'blood' ? '🩸'
      : wetType === 'acid' ? '🧪'
      : (wetTier === 2 ? '💦' : '💧');
    const wetWord = wetTier === 2 ? 'Промокший' : 'Мокрый';
    const extraCls = wetType === 'blood' ? ' se-wet-blood' : (wetType === 'acid' ? ' se-wet-acid' : '');
    pills.push(`<div class="se-pill se-wet${extraCls}">${liqTag} ${wetWord} <b>${wetAmt}%</b></div>`);
  }
  if (effTempKey !== 'normal' || effTempKey !== baseTempKey) {
    const prof = getWorldTemperatureProfile();
    const diff = TEMPERATURE_ORDER.indexOf(effTempKey) - TEMPERATURE_ORDER.indexOf(baseTempKey);
    const arrow = diff < 0 ? ' ↓' : (diff > 0 ? ' ↑' : '');
    pills.push(`<div class="se-pill se-temp">${prof.label}${arrow}</div>`);
  }
  if (phase !== 'none' && phaseLabel) {
    pills.push(`<div class="se-pill se-temp">${phaseLabel}</div>`);
  }

  if (pills.length === 0) {
    wrap.hidden = true;
    wrap.innerHTML = '';
  } else {
    wrap.hidden = false;
    wrap.innerHTML = pills.join('');
  }
}