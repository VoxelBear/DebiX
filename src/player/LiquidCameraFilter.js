// src/player/LiquidCameraFilter.js
import { S, clamp } from '../core/State.js';
import { scene, camera } from '../core/SceneManager.js';
import { sfx } from '../core/AudioEngine.js';

let filterCv = null;
let filterCtx = null;
let mediaBlend = 0;
let lastMediumType = null; // null | 'liquid' | 'gas'
let activeMediumType = null; // null | 'liquid' | 'gas'
let currentRgb = { r: 56, g: 159, b: 255 };
let targetRgb = { r: 56, g: 159, b: 255 };

const _vCamLocal = new THREE.Vector3();
const _baseFogColTmp = new THREE.Color();
const _medFogColTmp = new THREE.Color();

function getActiveAirFog() {
  const wr = S.weatherRuntime;
  const ws = S.worldSettings || {};
  const color = (wr && wr.effectiveFogColor) ? wr.effectiveFogColor : (ws.fogColor || '#88ccff');
  const density = (wr && typeof wr.effectiveFogDensity === 'number')
    ? wr.effectiveFogDensity
    : (ws.fogDensity ?? 0.0038);
  return { color, density };
}

// Пул пузырьков для жидкости
const BUBBLE_COUNT = 18;
const bubbles = [];

function initBubbles() {
  if (bubbles.length > 0) return;
  for (let i = 0; i < BUBBLE_COUNT; i++) {
    bubbles.push({
      x: Math.random(),
      y: Math.random(),
      size: 5 + Math.random() * 12,
      speed: 0.12 + Math.random() * 0.28,
      wobbleSpeed: 2.0 + Math.random() * 3.0,
      wobbleAmp: 0.015 + Math.random() * 0.025,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.35 + Math.random() * 0.45
    });
  }
}

// Пул мягких облачных частиц для газа / тумана
const GAS_PARTICLE_COUNT = 20;
const gasPuffs = [];

function initGasPuffs() {
  if (gasPuffs.length > 0) return;
  for (let i = 0; i < GAS_PARTICLE_COUNT; i++) {
    gasPuffs.push({
      x: Math.random(),
      y: Math.random(),
      size: 16 + Math.random() * 32,
      speedX: 0.04 + Math.random() * 0.09,
      speedY: (Math.random() - 0.5) * 0.02,
      wobbleSpeed: 1.2 + Math.random() * 1.8,
      wobbleAmp: 0.02 + Math.random() * 0.03,
      phase: Math.random() * Math.PI * 2,
      alpha: 0.16 + Math.random() * 0.28
    });
  }
}

function hexToRgb(hex) {
  if (!hex) return { r: 56, g: 159, b: 255 };
  let c = hex.replace('#', '').trim();
  if (c.length === 3) {
    c = c[0] + c[0] + c[1] + c[1] + c[2] + c[2];
  }
  const num = parseInt(c, 16);
  if (isNaN(num)) return { r: 56, g: 159, b: 255 };
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255
  };
}

function ensureFilterCanvas() {
  if (filterCv) return filterCv;
  filterCv = document.createElement('canvas');
  filterCv.id = 'liquidFilterCanvas';
  filterCv.style.cssText =
    'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:16;display:none;';
  document.body.appendChild(filterCv);
  filterCtx = filterCv.getContext('2d');
  initBubbles();
  initGasPuffs();
  return filterCv;
}

export function resetLiquidCameraFilter() {
  mediaBlend = 0;
  lastMediumType = null;
  activeMediumType = null;
  if (filterCv) filterCv.style.display = 'none';
  if (scene.fog && S.worldSettings) {
    const airFog = getActiveAirFog();
    scene.fog.color.set(airFog.color);
    scene.fog.density = airFog.density;
  }
}

// Проверяет, находится ли точка КАМЕРЫ строго внутри объема жидкого или газового блока
function getMediumBlockUnderCamera() {
  const cx = camera.position.x;
  const cy = camera.position.y;
  const cz = camera.position.z;

  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b.isDisabled || b._depletedDisabled || b._evaporated) continue;
    const st = b.matterState;
    if (st !== 'liquid' && st !== 'gas') continue;

    // Быстрое отсечение по ограничивающему AABB
    if (
      cx < b.x0 || cx > b.x1 ||
      cy < b.y0 || cy > b.y1 ||
      cz < b.z0 || cz > b.z1
    ) {
      continue;
    }

    // Точная проверка с учётом трёхмерного поворота блока (OBB)
    if (b.isRotated && b.invQuat) {
      _vCamLocal.set(cx - b.m.position.x, cy - b.m.position.y, cz - b.m.position.z);
      _vCamLocal.applyQuaternion(b.invQuat);
      if (
        Math.abs(_vCamLocal.x) <= b.hx &&
        Math.abs(_vCamLocal.y) <= b.hy &&
        Math.abs(_vCamLocal.z) <= b.hz
      ) {
        return b;
      }
    } else {
      return b;
    }
  }
  return null;
}

export function updateLiquidCameraFilter(player, dt = 0.016) {
  if (S.state !== 'play' || !player || S.playerDead) {
    if (mediaBlend > 0) resetLiquidCameraFilter();
    return;
  }

  const cv = ensureFilterCanvas();
  const ctx = filterCtx;

  // Фильтр включается ТОЛЬКО если сама КАМЕРА находится внутри объекта жидкости или газа!
  const camBlock = getMediumBlockUnderCamera();
  const currentType = camBlock ? camBlock.matterState : null;

  if (camBlock) {
    activeMediumType = currentType;
  }

  // Звуковое сопровождение при входе камеры в среду
  if (currentType && currentType !== lastMediumType) {
    if (currentType === 'liquid') {
      sfx.splash();
    } else if (currentType === 'gas') {
      sfx.gas();
    }
  }
  lastMediumType = currentType;

  // Плавное нарастание / угасание эффекта
  const inMediumNow = Boolean(currentType);
  const targetBlend = inMediumNow ? 1.0 : 0.0;
  const blendRate = inMediumNow ? 5.5 : 4.0;
  mediaBlend += (targetBlend - mediaBlend) * Math.min(1.0, dt * blendRate);

  if (mediaBlend <= 0.005) {
    cv.style.display = 'none';
    activeMediumType = null;
    if (scene.fog && S.worldSettings) {
      const airFog = getActiveAirFog();
      scene.fog.color.set(airFog.color);
      scene.fog.density = airFog.density;
    }
    return;
  }

  cv.style.display = 'block';

  // Определение цвета среды из блока
  if (camBlock && camBlock.colorHex) {
    targetRgb = hexToRgb(camBlock.colorHex);
  }
  const colorLerpRate = Math.min(1.0, dt * 6.5);
  currentRgb.r += (targetRgb.r - currentRgb.r) * colorLerpRate;
  currentRgb.g += (targetRgb.g - currentRgb.g) * colorLerpRate;
  currentRgb.b += (targetRgb.b - currentRgb.b) * colorLerpRate;

  const r = Math.round(currentRgb.r);
  const g = Math.round(currentRgb.g);
  const b = Math.round(currentRgb.b);

  const isGas = activeMediumType === 'gas';
  const isLava = !isGas && r > 170 && b < 100 && r > g * 1.05;

  // 1. Трехмерный объемный туман сцены (Scene Fog) под цвет жидкости или газа
  if (scene.fog && S.worldSettings) {
    const airFog = getActiveAirFog();
    _baseFogColTmp.set(airFog.color);
    _medFogColTmp.setRGB(r / 255, g / 255, b / 255);
    scene.fog.color.copy(_baseFogColTmp).lerp(_medFogColTmp, mediaBlend * 0.9);

    const targetFogDens = isGas ? 0.052 : (isLava ? 0.062 : 0.04);
    scene.fog.density =
      airFog.density +
      (targetFogDens - airFog.density) * mediaBlend;
  }

  // 2. Отрисовка экранного фильтра
  const w = Math.max(320, Math.floor(window.innerWidth / 2));
  const h = Math.max(240, Math.floor(window.innerHeight / 2));
  if (cv.width !== w || cv.height !== h) {
    cv.width = w;
    cv.height = h;
  }

  ctx.clearRect(0, 0, w, h);
  const t = S.time || performance.now() * 0.001;

  if (isGas) {
    // ==================== РЕЖИМ ГАЗА / ОБЛАКА / ДЫМА ====================
    // А) Рассеянная дымчатая тонировка
    const baseAlpha = 0.22 * mediaBlend;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${baseAlpha})`;
    ctx.fillRect(0, 0, w, h);

    // Б) Мягкая туманная виньетка
    const grad = ctx.createRadialGradient(
      w * 0.5,
      h * 0.5,
      Math.min(w, h) * 0.22,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.65
    );
    const edgeAlpha = 0.52 * mediaBlend;
    const innerAlpha = 0.06 * mediaBlend;
    grad.addColorStop(0.0, `rgba(${r}, ${g}, ${b}, ${innerAlpha})`);
    grad.addColorStop(0.65, `rgba(${Math.round(r * 0.9)}, ${Math.round(g * 0.9)}, ${Math.round(b * 0.9)}, ${edgeAlpha * 0.55})`);
    grad.addColorStop(1.0, `rgba(${Math.round(r * 0.7)}, ${Math.round(g * 0.7)}, ${Math.round(b * 0.7)}, ${edgeAlpha})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // В) Дрейфующие горизонтальные слои дымки/пара
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    for (let i = 0; i < 3; i++) {
      const yBase = (h * (i + 1)) / 4;
      const waveOffset = t * (0.6 + i * 0.25) + i * 2.2;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 25) {
        const yWave =
          yBase +
          Math.sin(x * 0.012 + waveOffset) * 14 +
          Math.cos(x * 0.02 - t * 0.8) * 8;
        if (x === 0) ctx.moveTo(x, yWave);
        else ctx.lineTo(x, yWave);
      }
      ctx.lineWidth = 22 + i * 8;
      ctx.strokeStyle = `rgba(${r}, ${g}, ${b}, ${0.14 * mediaBlend})`;
      ctx.stroke();
    }
    ctx.restore();

    // Г) Стилизованные плывущие круглые облачка / хлопья тумана (Lego/Roblox Cloud Puffs)
    for (let i = 0; i < gasPuffs.length; i++) {
      const p = gasPuffs[i];
      p.x += p.speedX * dt;
      p.y += p.speedY * dt;
      if (p.x > 1.1) {
        p.x = -0.1;
        p.y = Math.random();
      }
      const gx = (p.x + Math.sin(t * p.wobbleSpeed + p.phase) * p.wobbleAmp) * w;
      const gy = p.y * h;
      const gRad = p.size * (0.85 + 0.15 * Math.sin(t * 1.5 + i));
      const gAlpha = p.alpha * mediaBlend;

      ctx.save();
      const pGrad = ctx.createRadialGradient(gx, gy, gRad * 0.1, gx, gy, gRad);
      pGrad.addColorStop(0.0, `rgba(${r}, ${g}, ${b}, ${gAlpha * 0.85})`);
      pGrad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, ${gAlpha * 0.45})`);
      pGrad.addColorStop(1.0, `rgba(${r}, ${g}, ${b}, 0.0)`);
      ctx.fillStyle = pGrad;
      ctx.beginPath();
      ctx.arc(gx, gy, gRad, 0, Math.PI * 2);
      ctx.fill();

      // Маленькое стилизованное лего-ядро в центре хлопьев
      ctx.fillStyle = `rgba(255, 255, 255, ${gAlpha * 0.4})`;
      ctx.beginPath();
      ctx.arc(gx, gy, gRad * 0.28, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

  } else {
    // ==================== РЕЖИМ ЖИДКОСТИ (ВОДА / ЛАВА) ====================
    // А) Базовая тонировка
    const baseAlpha = (isLava ? 0.38 : 0.28) * mediaBlend;
    ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${baseAlpha})`;
    ctx.fillRect(0, 0, w, h);

    // Б) Виньетка глубины
    const grad = ctx.createRadialGradient(
      w * 0.5,
      h * 0.5,
      Math.min(w, h) * 0.2,
      w * 0.5,
      h * 0.5,
      Math.max(w, h) * 0.65
    );
    const edgeAlpha = (isLava ? 0.72 : 0.58) * mediaBlend;
    const innerAlpha = (isLava ? 0.12 : 0.08) * mediaBlend;
    grad.addColorStop(0.0, `rgba(${r}, ${g}, ${b}, ${innerAlpha})`);
    grad.addColorStop(0.65, `rgba(${Math.round(r * 0.85)}, ${Math.round(g * 0.85)}, ${Math.round(b * 0.85)}, ${edgeAlpha * 0.6})`);
    grad.addColorStop(1.0, `rgba(${Math.round(r * 0.6)}, ${Math.round(g * 0.6)}, ${Math.round(b * 0.6)}, ${edgeAlpha})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // В) Стилизованные каустики (Lego Caustic Waves)
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.lineWidth = 3;
    ctx.strokeStyle = isLava
      ? `rgba(255, 230, 140, ${0.22 * mediaBlend})`
      : `rgba(255, 255, 255, ${0.18 * mediaBlend})`;

    for (let i = 0; i < 4; i++) {
      const yBase = (h * (i + 1)) / 5;
      const waveOffset = t * (1.2 + i * 0.3) + i * 1.5;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 20) {
        const yWave =
          yBase +
          Math.sin(x * 0.015 + waveOffset) * 9 +
          Math.cos(x * 0.03 - t * 1.5) * 5;
        if (x === 0) ctx.moveTo(x, yWave);
        else ctx.lineTo(x, yWave);
      }
      ctx.stroke();
    }

    const rippleCount = 3;
    for (let k = 0; k < rippleCount; k++) {
      const rx = (w * (0.25 + k * 0.28) + Math.sin(t * 0.8 + k) * 35);
      const ry = (h * (0.35 + (k % 2) * 0.3) + Math.cos(t * 0.9 + k) * 25);
      const rRadius = 24 + ((t * 18 + k * 35) % 65);
      const rAlpha = (1 - (rRadius - 24) / 65) * 0.16 * mediaBlend;
      ctx.strokeStyle = `rgba(255, 255, 255, ${rAlpha})`;
      ctx.beginPath();
      ctx.arc(rx, ry, rRadius, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();

    // Г) Всплывающие стилизованные пузырьки
    for (let i = 0; i < bubbles.length; i++) {
      const bObj = bubbles[i];
      bObj.y -= bObj.speed * dt;
      if (bObj.y < -0.05) {
        bObj.y = 1.05;
        bObj.x = Math.random();
      }
      const bx = (bObj.x + Math.sin(t * bObj.wobbleSpeed + bObj.phase) * bObj.wobbleAmp) * w;
      const by = bObj.y * h;
      const bRad = bObj.size * (0.75 + 0.25 * Math.sin(t * 3.0 + i));
      const bAlpha = bObj.alpha * mediaBlend;

      ctx.save();
      if (isLava) {
        ctx.fillStyle = `rgba(255, 200, 70, ${bAlpha * 0.8})`;
        ctx.beginPath();
        ctx.arc(bx, by, bRad * 0.7, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = `rgba(255, 255, 255, ${bAlpha})`;
        ctx.beginPath();
        ctx.arc(bx - bRad * 0.2, by - bRad * 0.2, bRad * 0.25, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.strokeStyle = `rgba(255, 255, 255, ${bAlpha * 0.75})`;
        ctx.lineWidth = 1.8;
        ctx.fillStyle = `rgba(255, 255, 255, ${bAlpha * 0.18})`;
        ctx.beginPath();
        ctx.arc(bx, by, bRad, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();

        ctx.fillStyle = `rgba(255, 255, 255, ${bAlpha * 0.9})`;
        ctx.beginPath();
        ctx.arc(bx - bRad * 0.35, by - bRad * 0.35, Math.max(1.2, bRad * 0.25), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    // Д) Верхняя волнообразная полоса уровня воды
    ctx.save();
    ctx.fillStyle = isLava
      ? `rgba(255, 120, 40, ${0.35 * mediaBlend})`
      : `rgba(180, 235, 255, ${0.28 * mediaBlend})`;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w, 0);
    for (let x = w; x >= 0; x -= 25) {
      const ySurf = 14 + Math.sin(x * 0.02 + t * 3.5) * 5 + Math.cos(t * 2.2 + x * 0.01) * 3;
      ctx.lineTo(x, ySurf);
    }
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}
