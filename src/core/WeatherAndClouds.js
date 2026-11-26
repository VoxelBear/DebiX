// src/core/WeatherAndClouds.js
import { S, clamp, rnd } from './State.js';
import { scene, camera, hemi, setAtmosphericSkybox, getEffectiveSkyColors } from './SceneManager.js';
import { updateWeatherAudio, sfx } from './AudioEngine.js';
import { emitParticleBurst } from './ParticleSystem.js';
import {
  applyStatusEffect,
  applyWetness,
  dealExternalStatusDamage,
  ensureStatusEffects,
  getEffectiveWorldTemperatureKey,
  getWorldTemperatureProfile,
  isTargetFlammable,
  triggerExternalStagger
} from './StatusEffects.js';

// 4 базовых вещества осадков (+ Ясно)
export const WEATHER_PROFILES = {
  none:  { id: 'none',  label: '☀️ Ясно' },
  water: { id: 'water', label: '💧 Обычные осадки' },
  blood: { id: 'blood', label: '🩸 Кровавые осадки' },
  acid:  { id: 'acid',  label: '🧪 Кислотные / Токсичные осадки' },
  lava:  { id: 'lava',  label: '🌋 Лавовые осадки' }
};

export function normalizeWeatherSubstance(rawType) {
  if (!rawType || rawType === 'none') return 'none';
  if (rawType === 'water' || rawType === 'rain' || rawType === 'snow') return 'water';
  if (rawType === 'blood' || rawType === 'blood_rain') return 'blood';
  if (rawType === 'acid' || rawType === 'acid_rain' || rawType === 'toxic' || rawType === 'poison') return 'acid';
  if (rawType === 'lava' || rawType === 'fire_rain') return 'lava';
  return 'none';
}

// Профили всех расчётных фаз осадков
export const WEATHER_PHASES = {
  none:          { label: '☀️ Ясно', kind: 'none', color: '#ffffff', speed: 0, drift: 0, dropW: 0.04, dropH: 0.9, opacity: 0 },
  // Обычные (вода)
  snow:          { label: '❄️ Снег', kind: 'snow', color: '#f8fafc', speed: 6.0, drift: 2.6, dropW: 0.16, dropH: 0.16, opacity: 0.92, wetType: 'water', wetRate: 0 },
  rain:          { label: '🌧️ Дождь', kind: 'rain', color: '#93c5fd', speed: 34, drift: 2.2, dropW: 0.045, dropH: 1.35, opacity: 0.74, wetType: 'water', wetRate: 13 },
  warm_rain:     { label: '🌦️ Тёплый дождь', kind: 'rain', color: '#bae6fd', speed: 32, drift: 2.0, dropW: 0.048, dropH: 1.32, opacity: 0.72, wetType: 'water', wetRate: 14 },
  hail:          { label: '🧊 Град', kind: 'hail', color: '#e0f2fe', speed: 40, drift: 1.8, dropW: 0.18, dropH: 0.18, opacity: 0.92, isHail: true, hailDmg: [2, 4], wetType: 'water', wetRate: 7 },
  steam:         { label: '🌫️ Пар / Влажный туман', kind: 'mist', color: '#e2f1ff', speed: 0, drift: 0, dropW: 0, dropH: 0, opacity: 0, wetType: 'water', wetRate: 5 },
  evaporate:     { label: '💨 Полное испарение', kind: 'evaporate', color: '#f1f5f9', speed: 0, drift: 0, dropW: 0, dropH: 0, opacity: 0 },
  // Кровавые
  blood_snow:    { label: '🩸 Кровавый снег', kind: 'snow', color: '#f87171', speed: 6.2, drift: 2.5, dropW: 0.16, dropH: 0.16, opacity: 0.92, wetType: 'blood', wetRate: 2 },
  blood_rain:    { label: '🩸 Кровавый дождь', kind: 'rain', color: '#dc2626', speed: 34, drift: 2.2, dropW: 0.048, dropH: 1.38, opacity: 0.78, wetType: 'blood', wetRate: 13 },
  blood_hail:    { label: '🩸 Кровавый град', kind: 'hail', color: '#991b1b', speed: 41, drift: 1.9, dropW: 0.2, dropH: 0.2, opacity: 0.94, isHail: true, hailDmg: [3, 5], wetType: 'blood', wetRate: 8 },
  // Кислотные / Токсичные (единый тип)
  acid_snow:     { label: '🧪 Кислотный снег', kind: 'snow', color: '#86efac', speed: 6.2, drift: 2.5, dropW: 0.16, dropH: 0.16, opacity: 0.92, wetType: 'acid', wetRate: 3 },
  acid_rain:     { label: '🧪 Кислотный дождь', kind: 'rain', color: '#4ade80', speed: 33, drift: 2.4, dropW: 0.052, dropH: 1.35, opacity: 0.78, wetType: 'acid', wetRate: 13 },
  acid_hail:     { label: '🧪 Кислотный град', kind: 'hail', color: '#22c55e', speed: 41, drift: 2.0, dropW: 0.19, dropH: 0.19, opacity: 0.94, isHail: true, hailDmg: [3, 5], wetType: 'acid', wetRate: 8 },
  acid_mist:     { label: '🧪 Токсичный пар / Туман', kind: 'mist', color: '#4ade80', speed: 0, drift: 0, dropW: 0, dropH: 0, opacity: 0, wetType: 'acid', wetRate: 6 },
  // Лавовые
  obsidian_hail: { label: '🪨 Обсидиановый град', kind: 'hail', color: '#1e1b4b', speed: 45, drift: 1.6, dropW: 0.22, dropH: 0.22, opacity: 0.96, isHail: true, hailDmg: [6, 9], hailStagger: 0.38 },
  ash:           { label: '🌫️ Вулканический пепел', kind: 'snow', color: '#52525b', speed: 5.4, drift: 3.0, dropW: 0.15, dropH: 0.15, opacity: 0.88 },
  lava_rain:     { label: '🔥 Лавовый дождь', kind: 'rain', color: '#ff6b2b', speed: 30, drift: 2.8, dropW: 0.085, dropH: 1.15, opacity: 0.95 }
};

let _phaseRoll = Math.random();
let _phaseCycleTimer = 0;
let _lastResolvedKey = '';
let _mistEmitAccum = 0;
const _fogColorTarget = new THREE.Color();
const _mistColorTmp = new THREE.Color();
const _cloudTintTmp = new THREE.Color();
const _weatherCloudColorTmp = new THREE.Color();
const _atmoFogColorTmp = new THREE.Color();
const _smoothedFogColor = new THREE.Color('#88ccff');
let _smoothedFogDensity = 0.0038;
let _fogSmoothInited = false;
const _skyMidSyncTmp = new THREE.Color();
const _skyHorizSyncTmp = new THREE.Color();
const _hemiSkyBaseTmp = new THREE.Color();
const _hemiGndBaseTmp = new THREE.Color();

// Цветовые палитры атмосферного скайбокса и туч по типу осадков
const WEATHER_ATMOSPHERE_PALETTES = {
  water: {
    skyTop: '#1e293b',
    skyMid: '#475569',
    skyBot: '#64748b',
    cloudColor: '#5b6472',
    cloudEmissive: '#2c3340',
    cloudEmissiveInt: 0.32,
    fogTint: '#64748b'
  },
  blood: {
    skyTop: '#2b060a',
    skyMid: '#7f1d1d',
    skyBot: '#b91c1c',
    cloudColor: '#b91c2c',
    cloudEmissive: '#6e0d18',
    cloudEmissiveInt: 0.55,
    fogTint: '#991b1b'
  },
  acid: {
    skyTop: '#062614',
    skyMid: '#15803d',
    skyBot: '#34d399',
    cloudColor: '#1ea84c',
    cloudEmissive: '#0e5928',
    cloudEmissiveInt: 0.48,
    fogTint: '#15803d'
  },
  lava: {
    skyTop: '#09070f',
    skyMid: '#241432',
    skyBot: '#4a4352',
    cloudColor: '#2a1f36',
    cloudEmissive: '#1e122b',
    cloudEmissiveInt: 0.40,
    fogTint: '#362b3f'
  }
};

let _atmoAlphaSmooth = 0;
let _atmoActiveSubstance = 'water';
let _cloudWeatherBoostSmooth = 0;

function resolvePrecipitationState(substance, effTemp) {
  if (substance === 'none') {
    return { phase: 'none', hasMist: false, mistColor: '#ffffff', mistDensity: 0 };
  }

  const key = `${substance}|${effTemp}`;
  if (key !== _lastResolvedKey) {
    _lastResolvedKey = key;
    _phaseRoll = Math.random();
    _phaseCycleTimer = rnd(16, 26);
  }

  let phase = 'none';
  let hasMist = false;
  let mistColor = '#ffffff';
  let mistDensity = 0;

  if (substance === 'water') {
    if (effTemp === 'freezing') phase = 'snow';
    else if (effTemp === 'cold') phase = _phaseRoll < 0.70 ? 'snow' : 'hail';
    else if (effTemp === 'cool') phase = _phaseRoll < 0.50 ? 'rain' : 'hail';
    else if (effTemp === 'normal') phase = 'rain';
    else if (effTemp === 'warm') phase = 'warm_rain';
    else if (effTemp === 'hot') {
      // Тропическая влажность: 50% тёплый дождь, 50% испарение в пар
      phase = _phaseRoll < 0.50 ? 'warm_rain' : 'steam';
      hasMist = true;
      mistColor = '#e2f1ff';
      mistDensity = phase === 'steam' ? 0.55 : 0.28;
    } else { // hell: 50% полное испарение, 50% пар
      phase = _phaseRoll < 0.50 ? 'evaporate' : 'steam';
      hasMist = phase === 'steam';
      mistColor = '#f1f5f9';
      mistDensity = phase === 'steam' ? 0.5 : 0.12;
    }
  } else if (substance === 'blood') {
    if (effTemp === 'freezing') phase = 'blood_snow';
    else if (effTemp === 'cold') phase = _phaseRoll < 0.70 ? 'blood_snow' : 'blood_hail';
    else if (effTemp === 'cool') phase = _phaseRoll < 0.50 ? 'blood_rain' : 'blood_hail';
    else if (effTemp === 'normal' || effTemp === 'warm') phase = 'blood_rain';
    else {
      // Жарко / Ад: кровь сворачивается в кровавый град + кровавый туман/облака
      phase = 'blood_hail';
      hasMist = true;
      mistColor = effTemp === 'hell' ? '#7f1d1d' : '#991b1b';
      mistDensity = effTemp === 'hell' ? 0.85 : 0.58;
    }
  } else if (substance === 'acid') {
    if (effTemp === 'freezing') phase = 'acid_snow';
    else if (effTemp === 'cold') phase = _phaseRoll < 0.70 ? 'acid_snow' : 'acid_hail';
    else if (effTemp === 'cool') phase = _phaseRoll < 0.50 ? 'acid_rain' : 'acid_hail';
    else if (effTemp === 'normal' || effTemp === 'warm') phase = 'acid_rain';
    else if (effTemp === 'hot') {
      phase = _phaseRoll < 0.50 ? 'acid_rain' : 'acid_mist';
      hasMist = true;
      mistColor = '#4ade80';
      mistDensity = phase === 'acid_mist' ? 0.65 : 0.28;
    } else { // hell: 50% испарение, 50% токсичный пар
      phase = _phaseRoll < 0.50 ? 'evaporate' : 'acid_mist';
      hasMist = phase === 'acid_mist';
      mistColor = '#22c55e';
      mistDensity = phase === 'acid_mist' ? 0.75 : 0.16;
    }
  } else if (substance === 'lava') {
    if (effTemp === 'freezing') phase = 'obsidian_hail';
    else if (effTemp === 'cold') {
      phase = 'ash';
      hasMist = true;
      mistColor = '#64748b';
      mistDensity = 0.35; // Вулканический смог от пепла
    } else if (effTemp === 'cool') {
      phase = _phaseRoll < 0.50 ? 'ash' : 'lava_rain';
      if (phase === 'ash') {
        hasMist = true;
        mistColor = '#64748b';
        mistDensity = 0.28;
      }
    } else {
      phase = 'lava_rain';
    }
  }

  return { phase, hasMist, mistColor, mistDensity };
}

/* ---------- 1. БЫСТРАЯ 2D-КАРТА КРЫШ И СТЕН (ROOF HEIGHT GRID) ---------- */

const ROOF_GRID_SIZE = 52;
const ROOF_CELL_SIZE = 1.5;
const ROOF_HALF_EXTENT = (ROOF_GRID_SIZE * ROOF_CELL_SIZE) * 0.5;
const _roofHeightGrid = new Float32Array(ROOF_GRID_SIZE * ROOF_GRID_SIZE);
let _roofOriginX = 0;
let _roofOriginZ = 0;
let _roofRebuildTimer = 0;
let _roofLastBlockCount = -1;
const _vRoofTmp = new THREE.Vector3();

function rebuildRoofHeightGrid(centerX, centerZ) {
  _roofOriginX = Math.floor(centerX / ROOF_CELL_SIZE) * ROOF_CELL_SIZE - ROOF_HALF_EXTENT;
  _roofOriginZ = Math.floor(centerZ / ROOF_CELL_SIZE) * ROOF_CELL_SIZE - ROOF_HALF_EXTENT;
  _roofHeightGrid.fill(-99999);

  const minWorldX = _roofOriginX;
  const maxWorldX = _roofOriginX + ROOF_GRID_SIZE * ROOF_CELL_SIZE;
  const minWorldZ = _roofOriginZ;
  const maxWorldZ = _roofOriginZ + ROOF_GRID_SIZE * ROOF_CELL_SIZE;

  const blocks = S.allBlocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.isDisabled || b._depletedDisabled) continue;
    if (b.matterState !== 'solid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (b.components && !b.components.physics?.enabled) continue;
    if (b.x1 < minWorldX || b.x0 > maxWorldX || b.z1 < minWorldZ || b.z0 > maxWorldZ) continue;

    // Небольшое расширение на 0.2м перекрывает стыки между стенами и крышей
    const gx0 = clamp(Math.floor((b.x0 - 0.2 - _roofOriginX) / ROOF_CELL_SIZE), 0, ROOF_GRID_SIZE - 1);
    const gx1 = clamp(Math.floor((b.x1 + 0.2 - _roofOriginX) / ROOF_CELL_SIZE), 0, ROOF_GRID_SIZE - 1);
    const gz0 = clamp(Math.floor((b.z0 - 0.2 - _roofOriginZ) / ROOF_CELL_SIZE), 0, ROOF_GRID_SIZE - 1);
    const gz1 = clamp(Math.floor((b.z1 + 0.2 - _roofOriginZ) / ROOF_CELL_SIZE), 0, ROOF_GRID_SIZE - 1);

    const topY = b.y1;
    if (!b.isRotated) {
      for (let gz = gz0; gz <= gz1; gz++) {
        const row = gz * ROOF_GRID_SIZE;
        for (let gx = gx0; gx <= gx1; gx++) {
          if (topY > _roofHeightGrid[row + gx]) {
            _roofHeightGrid[row + gx] = topY;
          }
        }
      }
    } else {
      const bx = b.m.position.x;
      const by = b.m.position.y;
      const bz = b.m.position.z;
      const padX = b.hx + 0.25;
      const padZ = b.hz + 0.25;
      for (let gz = gz0; gz <= gz1; gz++) {
        const wz = _roofOriginZ + (gz + 0.5) * ROOF_CELL_SIZE;
        const row = gz * ROOF_GRID_SIZE;
        for (let gx = gx0; gx <= gx1; gx++) {
          const wx = _roofOriginX + (gx + 0.5) * ROOF_CELL_SIZE;
          _vRoofTmp.set(wx - bx, 0, wz - bz).applyQuaternion(b.invQuat);
          if (Math.abs(_vRoofTmp.x) <= padX && Math.abs(_vRoofTmp.z) <= padZ) {
            if (topY > _roofHeightGrid[row + gx]) {
              _roofHeightGrid[row + gx] = topY;
            }
          }
        }
      }
    }
  }
}

export function sampleRoofHeightAt(x, z) {
  const gx = Math.floor((x - _roofOriginX) / ROOF_CELL_SIZE);
  const gz = Math.floor((z - _roofOriginZ) / ROOF_CELL_SIZE);
  if (gx < 0 || gx >= ROOF_GRID_SIZE || gz < 0 || gz >= ROOF_GRID_SIZE) return -99999;
  return _roofHeightGrid[gz * ROOF_GRID_SIZE + gx];
}

/**
 * Точная проверка, открыта ли точка (x, y, z) небу (нет ли над ней твёрдой крыши или перекрытия).
 */
export function isPointExposedToSky(x, y, z) {
  const blocks = S.allBlocks;
  const checkMinY = y + 0.45;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.isDisabled || b._depletedDisabled) continue;
    if (b.matterState !== 'solid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (b.components && !b.components.physics?.enabled) continue;
    if (b.y1 <= checkMinY) continue;
    if (x < b.x0 - 0.15 || x > b.x1 + 0.15 || z < b.z0 - 0.15 || z > b.z1 + 0.15) continue;

    if (!b.isRotated) return false;
    _vRoofTmp.set(x - b.m.position.x, 0, z - b.m.position.z).applyQuaternion(b.invQuat);
    if (Math.abs(_vRoofTmp.x) <= b.hx + 0.25 && Math.abs(_vRoofTmp.z) <= b.hz + 0.25) {
      return false;
    }
  }
  return true;
}

/* ---------- 2. ОБЛАКА (R6 / LEGO INSTANCED MESH + СПЛОШНАЯ ОБЛАЧНОСТЬ) ---------- */

const CLOUD_COUNT = 180;
const CLOUD_SPAN = 420;
let _cloudMesh = null;
let _cloudMat = null;
let _overcastMesh = null;
let _overcastMat = null;
const _cloudSeeds = [];
const _cloudDummy = new THREE.Object3D();

function createRadialOvercastAlphaMap() {
  const cv = document.createElement('canvas');
  cv.width = 128;
  cv.height = 128;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(64, 64, 14, 64, 64, 64);
  g.addColorStop(0.0, '#ffffff');
  g.addColorStop(0.55, '#ffffff');
  g.addColorStop(0.82, '#666666');
  g.addColorStop(1.0, '#000000');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(cv);
  tex.needsUpdate = true;
  return tex;
}

function initCloudsSystem() {
  if (_cloudMesh) return;
  const geo = new THREE.BoxGeometry(1, 1, 1);
  _cloudMat = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.92,
    depthWrite: true,
    fog: false
  });
  _cloudMesh = new THREE.InstancedMesh(geo, _cloudMat, CLOUD_COUNT);
  _cloudMesh.frustumCulled = false;
  _cloudMesh.castShadow = false;
  _cloudMesh.receiveShadow = false;
  _cloudMesh.userData.noCollider = true;
  scene.add(_cloudMesh);

  // Верхний сплошной слой для полной облачности с мягким радиальным затуханием к горизонту
  const overGeo = new THREE.PlaneGeometry(960, 960);
  overGeo.rotateX(Math.PI / 2);
  _overcastMat = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    alphaMap: createRadialOvercastAlphaMap(),
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false
  });
  _overcastMesh = new THREE.Mesh(overGeo, _overcastMat);
  _overcastMesh.visible = false;
  _overcastMesh.frustumCulled = false;
  _overcastMesh.userData.noCollider = true;
  scene.add(_overcastMesh);

  // Детерминированная генерация облаков с приоритетом появления по кучности
  let s = 1337;
  const nextRand = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };

  for (let i = 0; i < CLOUD_COUNT; i++) {
    const threshold = i / CLOUD_COUNT; // Порог кучности, при котором появляется облако
    _cloudSeeds.push({
      x: (nextRand() - 0.5) * CLOUD_SPAN,
      z: (nextRand() - 0.5) * CLOUD_SPAN,
      yOff: (nextRand() - 0.5) * 8.5,
      w: 14 + nextRand() * 26,
      h: 3.2 + nextRand() * 5.2,
      d: 12 + nextRand() * 24,
      driftSpd: 1.6 + nextRand() * 1.4,
      threshold
    });
  }
}

function updateClouds(dt, anchorX, anchorZ, substance, intensity) {
  initCloudsSystem();
  const cs = S.worldSettings?.cloudsSettings;
  if (!cs || cs.enabled === false || S.itemStudioOpen) {
    _cloudMesh.visible = false;
    _overcastMesh.visible = false;
    return;
  }

  const effSub = substance !== undefined
    ? substance
    : normalizeWeatherSubstance(S.worldSettings?.weatherSettings?.type);
  const effInt = intensity !== undefined
    ? intensity
    : clamp(Number(S.worldSettings?.weatherSettings?.intensity) ?? 0.75, 0.1, 1.0);

  if (effSub !== 'none') _atmoActiveSubstance = effSub;

  // Плавная инерция плотности облачности от интенсивности осадков
  const targetBoost = effSub !== 'none' ? clamp(effInt, 0.05, 1.0) : 0;
  _cloudWeatherBoostSmooth += (targetBoost - _cloudWeatherBoostSmooth) * Math.min(1, dt * 1.6);

  // Плавная автоматическая смена кучности облаков (если включено)
  let baseCov;
  if (cs.dynamicCoverage) {
    const spd = clamp(Number(cs.dynamicSpeed) || 0.04, 0.005, 0.5);
    const t = (S.time || 0) * spd;
    const wave = 0.5 + 0.36 * Math.sin(t) + 0.14 * Math.sin(t * 2.37 + 1.1);
    baseCov = clamp(wave, 0, 1);
  } else {
    baseCov = clamp(Number(cs.coverage) ?? 0.35, 0, 1);
  }

  // Чем сильнее осадки — тем больше облаков затягивает небо
  const precipCovFill = _cloudWeatherBoostSmooth * 0.86;
  const cov = clamp(baseCov + (1 - baseCov) * precipCovFill, 0, 1);
  S._effectiveCloudCoverage = cov;

  if (cov <= 0.005) {
    _cloudMesh.visible = false;
    _overcastMesh.visible = false;
    return;
  }

  const cloudHeight = clamp(Number(cs.height) ?? 72, 16, 260);
  const colHex = cs.color || '#ffffff';
  _cloudMat.color.set(colHex);

  // Плотность (непрозрачность), диффузный цвет и emissive-подсветка снизу (пробивает синий hemi.groundColor)
  const wBoost = _cloudWeatherBoostSmooth;
  _cloudMat.opacity = clamp(0.60 + wBoost * 0.38, 0.58, 0.98);

  if (wBoost > 0.01) {
    const palKey = effSub !== 'none' ? effSub : _atmoActiveSubstance;
    const pal = WEATHER_ATMOSPHERE_PALETTES[palKey] || WEATHER_ATMOSPHERE_PALETTES.water;
    _weatherCloudColorTmp.set(pal.cloudColor);
    const colorBlend = clamp(0.28 + Math.pow(wBoost, 0.85) * 0.70, 0, 0.98);
    _cloudMat.color.lerp(_weatherCloudColorTmp, colorBlend);

    _cloudMat.emissive.set(pal.cloudEmissive || pal.cloudColor);
    _cloudMat.emissiveIntensity = (pal.cloudEmissiveInt ?? 0.45) * clamp(0.25 + wBoost * 0.75, 0, 1);
  } else {
    _cloudMat.emissive.setHex(0x000000);
    _cloudMat.emissiveIntensity = 0;
  }

  if (S.weatherRuntime?.hasMist && S.weatherRuntime.mistColor && S.weatherRuntime.mistDensity > 0.15) {
    _cloudTintTmp.set(S.weatherRuntime.mistColor);
    const tintAmt = clamp(S.weatherRuntime.mistDensity * 0.42, 0.12, 0.50);
    _cloudMat.color.lerp(_cloudTintTmp, tintAmt);
  }
  _overcastMat.color.copy(_cloudMat.color);
  if (wBoost > 0.01) {
    // Чуть затемняем верхний unlit-слой overcast, чтобы он сливался с нижней стороной 3D-облаков
    _overcastMat.color.multiplyScalar(0.84);
  }

  const halfSpan = CLOUD_SPAN * 0.5;
  const windShift = (S.time || 0) * 2.2;
  // При высокой кучности (0.7..1.0) облака расширяются, смыкаясь в плотный ковёр
  const expandScale = cov > 0.65 ? (1.0 + (cov - 0.65) * 1.95) : 1.0;

  let activeCount = 0;
  for (let i = 0; i < CLOUD_COUNT; i++) {
    const c = _cloudSeeds[i];
    if (c.threshold > cov) continue;

    // Плавный рост облака при появлении
    const appear = clamp((cov - c.threshold) / 0.12, 0.05, 1.0);
    let rx = ((c.x + windShift * c.driftSpd - anchorX + halfSpan) % CLOUD_SPAN + CLOUD_SPAN) % CLOUD_SPAN - halfSpan;
    let rz = ((c.z - anchorZ + halfSpan) % CLOUD_SPAN + CLOUD_SPAN) % CLOUD_SPAN - halfSpan;
    const edgeFade = clamp(1.0 - (Math.hypot(rx, rz) - halfSpan * 0.72) / (halfSpan * 0.28), 0, 1);
    if (edgeFade <= 0.02) continue;

    const visScale = appear * edgeFade;
    _cloudDummy.position.set(anchorX + rx, cloudHeight + c.yOff, anchorZ + rz);
    _cloudDummy.rotation.set(0, 0, 0);
    _cloudDummy.scale.set(c.w * visScale * expandScale, c.h * visScale, c.d * visScale * expandScale);
    _cloudDummy.updateMatrix();
    _cloudMesh.setMatrixAt(activeCount, _cloudDummy.matrix);
    activeCount++;
  }

  _cloudMesh.count = activeCount;
  _cloudMesh.visible = activeCount > 0;
  _cloudMesh.instanceMatrix.needsUpdate = true;

  // Сплошная облачность при кучности > 0.72 (или плотных осадках) закрывает небо
  const overThreshold = 0.78 - _cloudWeatherBoostSmooth * 0.12;
  if (cov > overThreshold) {
    const overAlpha = clamp(((cov - overThreshold) / Math.max(0.12, 1 - overThreshold)) * (0.82 + _cloudWeatherBoostSmooth * 0.18), 0, 0.98);
    _overcastMesh.visible = true;
    _overcastMesh.position.set(anchorX, cloudHeight + 4.5, anchorZ);
    _overcastMat.opacity = overAlpha;
  } else {
    _overcastMesh.visible = false;
  }
}

/* ---------- 3. ОСАДКИ И ПОГОДА (INSTANCED MESH С ОБРЕЗКОЙ ПО КРЫШАМ) ---------- */

const MAX_WEATHER_DROPS = 1200;
const WEATHER_AREA_R = 38;
const WEATHER_SKY_OFFSET = 32;

// Дальняя оптимизированная 3-слойная завеса осадков (убирает видимую границу радиуса вокруг игрока)
let _distantPrecipGroup = null;
let _distantPrecipLayers = [];
let _distantRainTex = null;
let _distantSnowTex = null;

function createDistantPrecipTexture(mode = 'rain') {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 256;
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, 256, 256);

  let seed = mode === 'snow' ? 9187 : 4219;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };

  if (mode === 'snow') {
    for (let i = 0; i < 240; i++) {
      const x = rand() * 256;
      const y = rand() * 256;
      const r = 1.2 + rand() * 2.4;
      const a = 0.25 + rand() * 0.65;
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(2)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
      if (x < r + 1) { ctx.beginPath(); ctx.arc(x + 256, y, r, 0, Math.PI * 2); ctx.fill(); }
      if (y < r + 1) { ctx.beginPath(); ctx.arc(x, y + 256, r, 0, Math.PI * 2); ctx.fill(); }
    }
  } else {
    ctx.lineCap = 'round';
    for (let i = 0; i < 210; i++) {
      const x = rand() * 256;
      const y = rand() * 256;
      const len = 14 + rand() * 28;
      const tilt = 1.5 + rand() * 2.5;
      const a = 0.16 + rand() * 0.52;
      ctx.strokeStyle = `rgba(255,255,255,${a.toFixed(2)})`;
      ctx.lineWidth = 1.0 + rand() * 1.1;
      const drawStreak = (ox, oy) => {
        ctx.beginPath();
        ctx.moveTo(x + ox, y + oy);
        ctx.lineTo(x + ox + tilt, y + oy + len);
        ctx.stroke();
      };
      drawStreak(0, 0);
      if (y + len > 256) drawStreak(0, -256);
      if (x + tilt > 256) drawStreak(-256, 0);
    }
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function initDistantPrecipSheets() {
  if (_distantPrecipGroup) return;
  _distantRainTex = createDistantPrecipTexture('rain');
  _distantSnowTex = createDistantPrecipTexture('snow');

  _distantPrecipGroup = new THREE.Group();
  _distantPrecipGroup.visible = false;
  _distantPrecipGroup.userData.noCollider = true;

  const specs = [
    { radius: 36,  height: 76,  repX: 14, repY: 3.6, opScale: 0.42, speedMul: 1.00 },
    { radius: 74,  height: 102, repX: 22, repY: 4.4, opScale: 0.34, speedMul: 0.86 },
    { radius: 122, height: 132, repX: 30, repY: 5.0, opScale: 0.25, speedMul: 0.72 }
  ];

  for (let i = 0; i < specs.length; i++) {
    const sp = specs[i];
    const geo = new THREE.CylinderGeometry(sp.radius, sp.radius, sp.height, 32, 1, true);
    const uScroll = { value: new THREE.Vector2(i * 0.31, i * 0.17) };
    const uRepeat = { value: new THREE.Vector2(sp.repX, sp.repY) };

    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: _distantRainTex,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: true
    });
    mat.customProgramCacheKey = () => `debix_dist_precip_v1_${i}`;
    mat.onBeforeCompile = shader => {
      shader.uniforms.uPrecipScroll = uScroll;
      shader.uniforms.uPrecipRepeat = uRepeat;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vPrecipRawUv;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPrecipRawUv = uv;');
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec2 vPrecipRawUv;\nuniform vec2 uPrecipScroll;\nuniform vec2 uPrecipRepeat;'
        )
        .replace(
          '#include <map_fragment>',
          `
          #ifdef USE_MAP
            vec2 pUv = fract(vPrecipRawUv * uPrecipRepeat + uPrecipScroll);
            vec4 sampledDiffuseColor = texture2D( map, pUv );
            float vFade = smoothstep(0.0, 0.16, vPrecipRawUv.y) * smoothstep(1.0, 0.82, vPrecipRawUv.y);
            sampledDiffuseColor.a *= vFade;
            diffuseColor *= sampledDiffuseColor;
          #endif
          `
        );
    };

    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    mesh.userData.noCollider = true;
    _distantPrecipGroup.add(mesh);
    _distantPrecipLayers.push({ mesh, mat, spec: sp, uScroll, uRepeat });
  }

  scene.add(_distantPrecipGroup);
}

function updateDistantPrecipSheets(dt, anchorPos, prof, intensity, cloudHeight, visible) {
  initDistantPrecipSheets();
  if (!visible || !prof || prof.speed <= 0 || prof.dropW <= 0) {
    _distantPrecipGroup.visible = false;
    return;
  }

  _distantPrecipGroup.visible = true;
  const isFlake = prof.kind === 'snow';
  const targetTex = isFlake ? _distantSnowTex : _distantRainTex;
  const scrollYRate = (prof.speed / 24.0) * (isFlake ? 0.55 : 0.92);
  const scrollXRate = (prof.drift / 48.0);
  const tNow = S.time || 0;

  for (let i = 0; i < _distantPrecipLayers.length; i++) {
    const layer = _distantPrecipLayers[i];
    if (layer.mat.map !== targetTex) {
      layer.mat.map = targetTex;
      layer.mat.needsUpdate = true;
    }
    layer.mat.color.set(prof.color);

    const baseOp = clamp((prof.opacity ?? 0.78) * (0.28 + intensity * 0.72) * layer.spec.opScale, 0.04, 0.52);
    layer.mat.opacity = baseOp;

    const maxCenterY = cloudHeight - layer.spec.height * 0.44;
    const desiredCenterY = Math.min(anchorPos.y + layer.spec.height * 0.18, maxCenterY);
    layer.mesh.position.set(anchorPos.x, desiredCenterY, anchorPos.z);

    layer.uScroll.value.y = (layer.uScroll.value.y + scrollYRate * layer.spec.speedMul * dt) % 1.0;
    const sway = isFlake ? Math.sin(tNow * 0.9 + i * 1.7) * 0.08 * dt : scrollXRate * dt;
    layer.uScroll.value.x = (layer.uScroll.value.x + sway + 1.0) % 1.0;
  }
}

let _weatherMesh = null;
let _weatherMat = null;
const _dropX = new Float32Array(MAX_WEATHER_DROPS);
const _dropY = new Float32Array(MAX_WEATHER_DROPS);
const _dropZ = new Float32Array(MAX_WEATHER_DROPS);
const _dropSpd = new Float32Array(MAX_WEATHER_DROPS);
const _dropPhase = new Float32Array(MAX_WEATHER_DROPS);
let _weatherInited = false;
const _dropDummy = new THREE.Object3D();

function initWeatherDrops() {
  if (_weatherInited) return;
  _weatherInited = true;

  const geo = new THREE.BoxGeometry(1, 1, 1);
  _weatherMat = new THREE.MeshBasicMaterial({
    color: 0x93c5fd,
    transparent: true,
    opacity: 0.78,
    depthWrite: false
  });
  _weatherMesh = new THREE.InstancedMesh(geo, _weatherMat, MAX_WEATHER_DROPS);
  _weatherMesh.frustumCulled = false;
  _weatherMesh.castShadow = false;
  _weatherMesh.receiveShadow = false;
  _weatherMesh.visible = false;
  _weatherMesh.userData.noCollider = true;
  scene.add(_weatherMesh);

  for (let i = 0; i < MAX_WEATHER_DROPS; i++) {
    _dropX[i] = rnd(-WEATHER_AREA_R, WEATHER_AREA_R);
    _dropY[i] = rnd(-10, WEATHER_SKY_OFFSET);
    _dropZ[i] = rnd(-WEATHER_AREA_R, WEATHER_AREA_R);
    _dropSpd[i] = rnd(0.84, 1.18);
    _dropPhase[i] = rnd(0, Math.PI * 2);
  }
}

function respawnDrop(i, anchorX, anchorY, anchorZ, skyTopY, randomFillY = false) {
  const ang = Math.random() * Math.PI * 2;
  const rad = Math.pow(Math.random(), 0.65) * WEATHER_AREA_R;
  _dropX[i] = anchorX + Math.cos(ang) * rad;
  _dropZ[i] = anchorZ + Math.sin(ang) * rad;
  const roofY = sampleRoofHeightAt(_dropX[i], _dropZ[i]);
  const floorY = Math.max(anchorY - 14, roofY);
  if (randomFillY && skyTopY > floorY + 1) {
    _dropY[i] = rnd(floorY + 0.5, skyTopY);
  } else {
    _dropY[i] = skyTopY + rnd(0, 8);
  }
}

let _weatherEffectTickAccum = 0;
let _weatherBlockScanCursor = 0;

function updateWeatherTempOffset(dt, substance, intensity) {
  if (!S.weatherRuntime) return;
  const allowTempShift = S.worldSettings?.weatherSettings?.affectTemperature !== false;

  if (S.state !== 'play' || !allowTempShift) {
    if (!allowTempShift) S.weatherRuntime.tempOffset = 0;
    S.weatherRuntime.effectiveTemp = getEffectiveWorldTemperatureKey();
    return;
  }

  let off = Number(S.weatherRuntime.tempOffset) || 0;
  if (substance === 'none') {
    // Плавный возврат температуры к базовой в сухую погоду
    const recover = 0.015 * dt;
    off = Math.abs(off) <= recover ? 0 : (off - Math.sign(off) * recover);
    S.weatherRuntime.duration = 0;
  } else if (substance === 'lava') {
    // Лавовые осадки постепенно прогревают мир
    S.weatherRuntime.duration = (S.weatherRuntime.duration || 0) + dt;
    off = clamp(off + 0.013 * intensity * dt, -1.15, 1.65);
  } else {
    // Водяные / кровавые / кислотные осадки постепенно охлаждают мир (не ниже cold)
    S.weatherRuntime.duration = (S.weatherRuntime.duration || 0) + dt;
    off = clamp(off - 0.0095 * intensity * dt, -1.15, 1.65);
  }

  S.weatherRuntime.tempOffset = off;
  S.weatherRuntime.effectiveTemp = getEffectiveWorldTemperatureKey();
}

let _mistScreenEl = null;

function updateWeatherMistScreenOverlay(resolved, intensity, anchorPos) {
  if (!_mistScreenEl) {
    _mistScreenEl = document.createElement('div');
    _mistScreenEl.id = 'weatherMistOverlay';
    _mistScreenEl.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:5;opacity:0;transition:opacity 0.55s ease,background 0.6s ease;';
    document.body.appendChild(_mistScreenEl);
  }
  const active = resolved.hasMist && !S.itemStudioOpen && S.state !== 'menu';
  if (!active) {
    _mistScreenEl.style.opacity = '0';
    return;
  }
  const sheltered = !isPointExposedToSky(anchorPos.x, anchorPos.y + 1.6, anchorPos.z);
  const col = resolved.mistColor || '#e2f1ff';
  const targetOp = clamp(resolved.mistDensity * intensity * (sheltered ? 0.14 : 0.34), 0.04, 0.34);
  _mistScreenEl.style.background =
    `radial-gradient(circle at 50% 45%, transparent 25%, ${col} 125%), linear-gradient(180deg, ${col}55 0%, transparent 55%, ${col}77 100%)`;
  _mistScreenEl.style.opacity = targetOp.toFixed(3);
}

function updateWeatherAtmosphereAndMist(dt, anchorPos, substance, resolved, intensity) {
  // 0. Атмосферный скайбокс поверх основного (альфа и цвет зависят от плотности и типа осадков)
  const wantAtmo = substance !== 'none' && !S.itemStudioOpen && S.state !== 'menu';
  if (wantAtmo) _atmoActiveSubstance = substance;
  const targetAtmoAlpha = wantAtmo
    ? clamp(0.16 + Math.pow(intensity, 1.1) * 0.76, 0.14, 0.92)
    : 0;
  _atmoAlphaSmooth += (targetAtmoAlpha - _atmoAlphaSmooth) * Math.min(1, dt * 1.65);

  const pal = WEATHER_ATMOSPHERE_PALETTES[_atmoActiveSubstance] || WEATHER_ATMOSPHERE_PALETTES.water;
  setAtmosphericSkybox(pal.skyTop, pal.skyMid, pal.skyBot, _atmoAlphaSmooth);

  // 1. Точное согласование тумана с цветом горизонта неба (убирает резкую синюю полосу на стыке с водой)
  getEffectiveSkyColors(_skyMidSyncTmp, _skyHorizSyncTmp);

  if (scene.fog && scene.fog.density !== undefined) {
    const baseDensity = Number(S.worldSettings?.fogDensity) ?? 0.0038;
    const baseCol = S.worldSettings?.fogColor || '#88ccff';
    const atmoFogExtra = _atmoAlphaSmooth * 0.0052;
    const mistFogExtra = resolved.hasMist ? (resolved.mistDensity * 0.036 * intensity) : 0;
    const targetDensity = baseDensity + atmoFogExtra + mistFogExtra;

    _fogColorTarget.set(baseCol);
    if (_atmoAlphaSmooth > 0.005) {
      // Туман стремится точно к цвету атмосферного горизонта, чтобы вода и небо сливались без шва
      _fogColorTarget.lerp(_skyHorizSyncTmp, clamp(_atmoAlphaSmooth * 1.05, 0, 0.96));
    }
    if (resolved.hasMist && resolved.mistColor) {
      const mistBlend = clamp(resolved.mistDensity * 0.82 * intensity, 0, 0.85);
      _mistColorTmp.set(resolved.mistColor);
      _fogColorTarget.lerp(_mistColorTmp, mistBlend);
    }

    if (!_fogSmoothInited) {
      _fogSmoothInited = true;
      _smoothedFogColor.copy(_fogColorTarget);
      _smoothedFogDensity = targetDensity;
    } else {
      const k = Math.min(1, dt * 2.2);
      _smoothedFogColor.lerp(_fogColorTarget, k);
      _smoothedFogDensity += (targetDensity - _smoothedFogDensity) * k;
    }

    if (S.weatherRuntime) {
      S.weatherRuntime.effectiveFogColor = '#' + _smoothedFogColor.getHexString();
      S.weatherRuntime.effectiveFogDensity = _smoothedFogDensity;
    }

    // Не перебиваем подводный фильтр, если камера под водой
    const camInLiquid = Boolean(S.player?.inLiquid && S.player?.currentLiquidBlock && camera.position.y < S.player.currentLiquidBlock.y1);
    if (!camInLiquid) {
      scene.fog.color.copy(_smoothedFogColor);
      scene.fog.density = _smoothedFogDensity;
    }
  }

  // 1.5. Мягкая адаптация рассеянного света (HemisphereLight) под атмосферу осадков
  if (hemi) {
    const ss = S.worldSettings?.sunSettings;
    _hemiSkyBaseTmp.set(ss?.hemiSkyColor || '#ffffff');
    _hemiGndBaseTmp.set(ss?.hemiGroundColor || '#5588bb');
    if (_atmoAlphaSmooth > 0.005) {
      hemi.color.copy(_hemiSkyBaseTmp).lerp(_skyMidSyncTmp, clamp(_atmoAlphaSmooth * 0.42, 0, 0.42));
      hemi.groundColor.copy(_hemiGndBaseTmp).lerp(_skyHorizSyncTmp, clamp(_atmoAlphaSmooth * 0.55, 0, 0.55));
    } else {
      hemi.color.copy(_hemiSkyBaseTmp);
      hemi.groundColor.copy(_hemiGndBaseTmp);
    }
  }

  // 2. Мягкая атмосферная дымка экрана в густом паре/тумане
  updateWeatherMistScreenOverlay(resolved, intensity, anchorPos);

  // 3. Густые клубы пара / стелющегося кровавого и кислотного тумана вокруг игрока
  if (!resolved.hasMist || S.itemStudioOpen) return;
  _mistEmitAccum += dt;
  const interval = clamp(0.11 / Math.max(0.3, intensity * resolved.mistDensity), 0.07, 0.24);
  if (_mistEmitAccum < interval) return;
  _mistEmitAccum = 0;

  const isRisingSteam = resolved.phase === 'steam' || resolved.phase === 'acid_mist' || resolved.phase === 'evaporate';
  const puffCount = Math.max(2, Math.round(2 + resolved.mistDensity * 3 * intensity));

  for (let k = 0; k < puffCount; k++) {
    const px = anchorPos.x + rnd(-16, 16);
    const pz = anchorPos.z + rnd(-16, 16);
    const roofY = sampleRoofHeightAt(px, pz);
    const groundY = roofY > -9000 ? roofY : anchorPos.y;
    const py = isRisingSteam
      ? (groundY + rnd(0.25, 1.4))
      : (groundY + rnd(0.8, 5.2));
    if (!isPointExposedToSky(px, py + 0.3, pz)) continue;

    emitParticleBurst(px, py, pz, 1, {
      preset: 'smoke',
      color: resolved.mistColor || '#e2f1ff',
      sizeStart: isRisingSteam ? rnd(1.1, 1.9) : rnd(1.8, 2.8),
      sizeEnd: isRisingSteam ? rnd(2.8, 4.4) : rnd(3.6, 5.4),
      speed: isRisingSteam ? 1.15 : 0.65,
      spread: isRisingSteam ? 0.9 : 1.8,
      gravity: isRisingSteam ? 2.4 : 0.2,
      lifetime: isRisingSteam ? 2.1 : 3.2
    });
  }
}

function applyWeatherGameplayEffects(dt, substance, phase, resolved, intensity) {
  if (S.state !== 'play' || substance === 'none' || phase === 'none') return;

  _weatherEffectTickAccum += dt;
  if (_weatherEffectTickAccum < 0.4) return;
  const stepDt = _weatherEffectTickAccum;
  _weatherEffectTickAccum = 0;

  const effTemp = getEffectiveWorldTemperatureKey();
  const tempProf = getWorldTemperatureProfile();
  const pInfo = WEATHER_PHASES[phase] || WEATHER_PHASES.none;

  const affectEntityOrItem = (target, x, y, z, isLiving) => {
    if (!target || target.isDisabled || target._depletedDisabled || target._deadCooldown > 0 || target._permanentlyDead) return;
    if (!isPointExposedToSky(x, y, z)) return;

    const se = ensureStatusEffects(target);

    // 1. Полное испарение в «Ад» — сушит мокроту, без контакта с каплями
    if (phase === 'evaporate') {
      if (isLiving && se.wet?.stacks > 0) {
        se.wet.stacks = Math.max(0, se.wet.stacks - 16 * stepDt);
      }
      return;
    }

    // 2. Намокание и загрязнение (живые сущности)
    if (isLiving && pInfo.wetType) {
      let wetRate = pInfo.wetRate || 0;
      if (pInfo.kind === 'snow' && effTemp === 'cool') wetRate = Math.max(wetRate, 3.0);
      if (phase === 'steam' && effTemp === 'hell') {
        wetRate = 0;
        se.wet.stacks = Math.max(0, se.wet.stacks - 22 * stepDt);
      }
      if (wetRate > 0) {
        applyWetness(target, wetRate * intensity * stepDt, pInfo.wetType, { rinse: pInfo.wetType === 'water' });
      }
    }

    // 3. Тушение огня негорючими осадками
    if (substance !== 'lava' && phase !== 'steam' && se.burn.stacks > 0 && target.effectSource !== 'burn') {
      se.burn.timer -= stepDt * (3.2 + intensity * 3.8);
      if (se.burn.timer <= 0) {
        se.burn.stacks = Math.max(0, se.burn.stacks - 1);
        se.burn.timer = se.burn.stacks > 0 ? 1.5 : 0;
      }
    }

    // 4. СНЕГ: работает как модификатор заморозки ТОЛЬКО при «Очень холодно» (freezing)
    if (pInfo.kind === 'snow' && phase !== 'ash') {
      if (effTemp === 'freezing') {
        const prob = clamp(0.22 * intensity * tempProf.freezeGainMult * stepDt, 0, 0.85);
        if (Math.random() < prob) {
          applyStatusEffect(target, 'freeze', 1, { maxStacks: isLiving ? 6 : 5 });
        }
      }
    }

    // 5. ГРАД (обычный, кровавый, кислотный, обсидиановый)
    if (pInfo.isHail && isLiving) {
      const hitChance = clamp(0.46 * intensity * stepDt, 0, 0.92);
      if (Math.random() < hitChance) {
        const [minD, maxD] = pInfo.hailDmg || [2, 4];
        const dmg = Math.round(rnd(minD, maxD));
        dealExternalStatusDamage(target, dmg, { skipAutoRagdoll: true });

        if (target.isP) {
          if (phase === 'obsidian_hail') sfx.obsidianHit?.(0.95);
          else sfx.hailHit?.(0.85);
        }

        emitParticleBurst(x, y + 0.35, z, phase === 'obsidian_hail' ? 5 : 3, {
          preset: 'spark',
          color: phase === 'obsidian_hail' ? '#6366f1' : pInfo.color,
          sizeStart: 0.16,
          sizeEnd: 0.03,
          speed: 3.4,
          spread: 1.2,
          gravity: -12,
          lifetime: 0.32
        });

        // Обсидиановый град с шансом пошатывает цель (stagger)
        if (pInfo.hailStagger && Math.random() < pInfo.hailStagger) {
          const ang = rnd(0, Math.PI * 2);
          triggerExternalStagger(target, Math.cos(ang), Math.sin(ang), 0.72);
        }
      }
    }

    // 6. КИСЛОТНЫЕ / ТОКСИЧНЫЕ ОСАДКИ (единый эффект poison)
    if (substance === 'acid') {
      const mult = phase === 'acid_mist' ? 1.25 : 1.0;
      if (Math.random() < clamp(0.32 * mult * intensity * stepDt, 0, 0.9)) {
        applyStatusEffect(target, 'poison', 1, { maxStacks: 7 });
      }
    }

    // 7. КРОВАВЫЙ ТУМАН (при hot/hell дополнительно пачкает кровью)
    if (substance === 'blood' && resolved.hasMist && isLiving) {
      applyWetness(target, 4.5 * intensity * stepDt, 'blood');
    }

    // 8. ЛАВОВЫЙ ДОЖДЬ (быстро растапливает заморозку, затем поджигает горючих и живых)
    if (phase === 'lava_rain') {
      if (se.freeze.stacks > 0 || target._frozenFromLiquid) {
        const meltProb = clamp(1.35 * intensity * stepDt, 0.25, 0.95);
        if (Math.random() < meltProb) {
          applyStatusEffect(target, 'burn', 2, { maxStacks: 7 });
        }
      } else if (isLiving || isTargetFlammable(target)) {
        const prob = clamp(0.34 * intensity * Math.max(0.45, tempProf.burnGainMult) * stepDt, 0, 0.9);
        if (Math.random() < prob) {
          applyStatusEffect(target, 'burn', 1, { maxStacks: 7 });
        }
      }
    }
  };

  // 1. Игрок
  if (S.player && !S.playerDead) {
    affectEntityOrItem(S.player, S.player.x, S.player.y + 1.8, S.player.z, true);
  }

  // 2. NPC
  for (let i = 0; i < S.customNPCs.length; i++) {
    const npc = S.customNPCs[i];
    if (!npc || npc.isDisabled || npc._deadCooldown > 0 || npc._permanentlyDead) continue;
    affectEntityOrItem(npc, npc.x, npc.y + 1.8, npc.z, true);
  }

  // 3. Предметы в мире
  for (let i = 0; i < S.worldItems.length; i++) {
    const wi = S.worldItems[i];
    if (!wi || wi.isDisabled) continue;
    affectEntityOrItem(wi, wi.x, wi.y + 0.5, wi.z, false);
  }

  // 4. Блоки сцены: при лавовом дожде приоритетно растапливаем все замёрзшие блоки и водоёмы
  const totalB = S.allBlocks.length;
  if (phase === 'lava_rain' && totalB > 0) {
    for (let i = 0; i < totalB; i++) {
      const b = S.allBlocks[i];
      if (!b || b.isDisabled || b._depletedDisabled || !b.m) continue;
      if (!b._frozenFromLiquid && !(b.statusEffects?.freeze?.stacks > 0)) continue;
      const cx = b.m.position.x;
      const cz = b.m.position.z;
      const topY = b.y1 + 0.08;
      // Для крупных водоёмов проверяем центр и 4 четверти — достаточно открытого участка
      const exposed =
        isPointExposedToSky(cx, topY, cz) ||
        isPointExposedToSky(cx + b.hx * 0.5, topY, cz) ||
        isPointExposedToSky(cx - b.hx * 0.5, topY, cz) ||
        isPointExposedToSky(cx, topY, cz + b.hz * 0.5) ||
        isPointExposedToSky(cx, topY, cz - b.hz * 0.5);
      if (exposed && Math.random() < clamp(1.25 * intensity * stepDt, 0.35, 0.95)) {
        applyStatusEffect(b, 'burn', 2);
      }
    }
  }

  // Остальные блоки сцены (батчами по 24 блока за тик)
  if (totalB > 0) {
    const batch = Math.min(24, totalB);
    for (let k = 0; k < batch; k++) {
      const idx = (_weatherBlockScanCursor++) % totalB;
      const b = S.allBlocks[idx];
      if (!b || b.isDisabled || b._depletedDisabled || !b.m) continue;

      const isRelevant =
        (phase === 'lava_rain') ? (b.isFlammable) :
        (pInfo.kind === 'snow' && effTemp === 'freezing') ? (b.matterState === 'liquid' || b.isDynamicPhysics || b.statusEffects?.burn?.stacks > 0) :
        (substance === 'acid') ? (b.matterState === 'liquid' || b.isDynamicPhysics || b.statusEffects?.burn?.stacks > 0) :
        (b.statusEffects?.burn?.stacks > 0);

      if (!isRelevant) continue;
      affectEntityOrItem(b, b.m.position.x, b.y1, b.m.position.z, false);
    }
  }
}

export function updateWeatherAndClouds(dt) {
  const anchorPos = (S.state === 'play' && S.player && !S.playerDead)
    ? { x: S.player.x, y: S.player.y, z: S.player.z }
    : { x: camera.position.x, y: camera.position.y, z: camera.position.z };

  const ws = S.worldSettings?.weatherSettings;
  const substance = normalizeWeatherSubstance(ws?.type);
  const intensity = clamp(Number(ws?.intensity) ?? 0.75, 0.1, 1.0);

  // 1. Погода и фазовая матрица (вычисляем до облаков, чтобы тучи реагировали на осадки без лага в 1 кадр)
  initWeatherDrops();
  updateWeatherTempOffset(dt, substance, intensity);
  const effTemp = getEffectiveWorldTemperatureKey();

  if (substance !== 'none') {
    _phaseCycleTimer -= dt;
    if (_phaseCycleTimer <= 0) {
      _phaseRoll = Math.random();
      _phaseCycleTimer = rnd(16, 26);
    }
  }

  const resolved = resolvePrecipitationState(substance, effTemp);
  const phase = resolved.phase;
  const prof = WEATHER_PHASES[phase] || WEATHER_PHASES.none;

  if (S.weatherRuntime) {
    S.weatherRuntime.substance = substance;
    S.weatherRuntime.phase = phase;
    S.weatherRuntime.phaseLabel = prof.label;
    S.weatherRuntime.effectiveTemp = effTemp;
    S.weatherRuntime.hasHail = Boolean(prof.isHail);
    S.weatherRuntime.hasMist = Boolean(resolved.hasMist);
    S.weatherRuntime.mistColor = resolved.mistColor;
    S.weatherRuntime.mistDensity = resolved.mistDensity;
  }

  // 2. Облака (кучность, плотность и цвет зависят от осадков)
  updateClouds(dt, anchorPos.x, anchorPos.z, substance, intensity);

  // 3. Атмосферный скайбокс, туман и частицы пара/смога
  updateWeatherAtmosphereAndMist(dt, anchorPos, substance, resolved, intensity);

  const cloudH = S.worldSettings?.cloudsSettings?.enabled !== false
    ? clamp(Number(S.worldSettings?.cloudsSettings?.height) ?? 72, 16, 260)
    : anchorPos.y + WEATHER_SKY_OFFSET + 28;

  if (substance === 'none' || S.itemStudioOpen) {
    _weatherMesh.visible = false;
    updateDistantPrecipSheets(dt, anchorPos, null, 0, cloudH, false);
    updateWeatherAudio('none', 0, false);
    return;
  }

  // Дальняя 3-слойная завеса осадков до горизонта
  updateDistantPrecipSheets(dt, anchorPos, prof, intensity, cloudH, true);

  // Периодически обновляем 2D-карту крыш и стен
  _roofRebuildTimer -= dt;
  const movedDist = Math.hypot(
    anchorPos.x - (_roofOriginX + ROOF_HALF_EXTENT),
    anchorPos.z - (_roofOriginZ + ROOF_HALF_EXTENT)
  );
  if (_roofRebuildTimer <= 0 || movedDist > 6.5 || _roofLastBlockCount !== S.allBlocks.length) {
    _roofRebuildTimer = 0.35;
    _roofLastBlockCount = S.allBlocks.length;
    rebuildRoofHeightGrid(anchorPos.x, anchorPos.z);
  }

  const hasFallingDrops = prof.speed > 0 && prof.dropW > 0;
  if (!hasFallingDrops) {
    _weatherMesh.visible = false;
  } else {
    _weatherMat.color.set(prof.color);
    _weatherMat.opacity = prof.opacity ?? 0.78;

    const skyTopY = Math.min(anchorPos.y + WEATHER_SKY_OFFSET, cloudH);
    const activeDrops = Math.max(80, Math.floor(MAX_WEATHER_DROPS * intensity * (prof.isHail ? 0.55 : 1.0)));
    const isDrifting = prof.kind === 'snow';
    const isSpinning = isDrifting || prof.isHail;
    const tiltZ = isSpinning ? 0 : 0.08;
    const tNow = S.time || 0;

    let visibleCount = 0;
    for (let i = 0; i < activeDrops; i++) {
      const fallSpd = prof.speed * _dropSpd[i];
      _dropY[i] -= fallSpd * dt;

      if (isDrifting) {
        _dropX[i] += Math.sin(tNow * 1.8 + _dropPhase[i]) * prof.drift * dt;
        _dropZ[i] += Math.cos(tNow * 1.4 + _dropPhase[i]) * prof.drift * dt;
      } else {
        _dropX[i] += prof.drift * dt;
      }

      const dx = _dropX[i] - anchorPos.x;
      const dz = _dropZ[i] - anchorPos.z;
      if (Math.abs(dx) > WEATHER_AREA_R || Math.abs(dz) > WEATHER_AREA_R) {
        respawnDrop(i, anchorPos.x, anchorPos.y, anchorPos.z, skyTopY, true);
      }

      const roofY = sampleRoofHeightAt(_dropX[i], _dropZ[i]);
      const cutY = Math.max(anchorPos.y - 16, roofY + 0.15);

      if (_dropY[i] <= cutY) {
        respawnDrop(i, anchorPos.x, anchorPos.y, anchorPos.z, skyTopY, false);
        const newRoof = sampleRoofHeightAt(_dropX[i], _dropZ[i]);
        if (_dropY[i] <= newRoof + 0.15) continue;
      }

      _dropDummy.position.set(_dropX[i], _dropY[i], _dropZ[i]);
      if (isSpinning) {
        const spinMul = prof.isHail ? 4.5 : 1.0;
        _dropDummy.rotation.set(tNow * spinMul + _dropPhase[i], tNow * 0.7 * spinMul, _dropPhase[i]);
      } else {
        _dropDummy.rotation.set(0, 0, tiltZ);
      }
      _dropDummy.scale.set(prof.dropW, prof.dropH, prof.dropW);
      _dropDummy.updateMatrix();
      _weatherMesh.setMatrixAt(visibleCount, _dropDummy.matrix);
      visibleCount++;
    }

    _weatherMesh.count = visibleCount;
    _weatherMesh.visible = visibleCount > 0;
    _weatherMesh.instanceMatrix.needsUpdate = true;
  }

  // Фоновый звук погоды с учётом крыши и активной фазы
  const playerSheltered = !isPointExposedToSky(anchorPos.x, anchorPos.y + 1.6, anchorPos.z);
  updateWeatherAudio(phase, intensity, playerSheltered);

  // Геймплейные эффекты погоды в режиме Игры
  applyWeatherGameplayEffects(dt, substance, phase, resolved, intensity);
}