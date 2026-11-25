// src/core/SurfaceWeatherLayer.js
import { S, clamp, rnd } from './State.js';
import { camera } from './SceneManager.js';
import { emitParticleBurst } from './ParticleSystem.js';
import {
  tickSurfaceWeatherVisualsTime,
  rebuildSurfacePrecipitationMeshes,
  updateBlockSurfaceCoatings,
  clearSurfaceWeatherVisuals
} from './SurfaceWeatherVisuals.js';
import { sfx } from './AudioEngine.js';
import {
  getEffectiveWorldTemperatureKey,
  applyWetness,
  applyStatusEffect,
  dealExternalStatusDamage
} from './StatusEffects.js';
import {
  WEATHER_PHASES,
  isPointExposedToSky,
  normalizeWeatherSubstance
} from './WeatherAndClouds.js';

const CELL_SIZE = 1.6;
const ACTIVE_RADIUS_CELLS = 15; // Область ~48x48м вокруг игрока/камеры
const MAX_CELLS = 750;
const SIM_STEP_SEC = 0.25;

const _surfHooks = {
  updateBlockOBB: null
};

export function registerSurfaceWeatherHooks(hooks = {}) {
  if (typeof hooks.updateBlockOBB === 'function') _surfHooks.updateBlockOBB = hooks.updateBlockOBB;
}

// Хранилище разреженных ячеек поверхности: "gx,gz" -> Cell
const _cells = new Map();
let _simAccum = 0;
let _geoRefreshTick = 0;
let _lastBlockCount = -1;
let _steamSoundCd = 0;

const _vSurfLocal = new THREE.Vector3();

// Детерминированный 2D-шум для естественной неравномерности луж и сугробов
function hash2D(x, z) {
  let n = Math.imul(x, 374761393) + Math.imul(z, 668265263);
  n = (n ^ (n >>> 13)) * 1274126177;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
}

function samplePatchNoise(gx, gz) {
  const n0 = hash2D(gx, gz);
  const n1 = hash2D(Math.floor(gx * 0.5), Math.floor(gz * 0.5));
  const n2 = hash2D(Math.floor(gx * 0.25), Math.floor(gz * 0.25));
  return clamp(n0 * 0.32 + n1 * 0.43 + n2 * 0.25, 0.12, 1.0);
}

/**
 * Находит самый верхний открытый небу твёрдый или жидкий блок в точке (wx, wz).
 */
function sampleHighestExposedSurface(wx, wz) {
  let bestSolidY = -Infinity;
  let bestSolidBlock = null;
  let bestLiquidY = -Infinity;
  let bestLiquidBlock = null;

  const blocks = S.allBlocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.isDisabled || b._depletedDisabled || b._isCarriedByPlayer) continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (b.components && !b.components.physics?.enabled) continue;
    if (b.matterState !== 'solid' && b.matterState !== 'liquid') continue;
    if (wx < b.x0 || wx > b.x1 || wz < b.z0 || wz > b.z1) continue;

    if (b.isRotated && b.m) {
      _vSurfLocal.set(wx - b.m.position.x, 0, wz - b.m.position.z).applyQuaternion(b.invQuat);
      if (Math.abs(_vSurfLocal.x) > b.hx + 0.05 || Math.abs(_vSurfLocal.z) > b.hz + 0.05) continue;
    }

    if (b.matterState === 'solid') {
      if (b.y1 > bestSolidY) {
        bestSolidY = b.y1;
        bestSolidBlock = b;
      }
    } else if (b.matterState === 'liquid') {
      if (b.y1 > bestLiquidY) {
        bestLiquidY = b.y1;
        bestLiquidBlock = b;
      }
    }
  }

  // Если сверху над твёрдым полом уже плещется жидкость — точка принадлежит водоёму
  if (bestLiquidBlock && bestLiquidY >= bestSolidY - 0.05) {
    return { kind: 'liquid', y: bestLiquidY, block: bestLiquidBlock };
  }
  if (bestSolidBlock) {
    return { kind: 'solid', y: bestSolidY, block: bestSolidBlock };
  }
  return null;
}

function getOrCreateCell(gx, gz, surf) {
  const key = `${gx},${gz}`;
  let cell = _cells.get(key);
  if (cell) {
    if (surf && surf.kind === 'solid') {
      cell.baseY = surf.y;
      cell.block = surf.block;
    }
    return cell;
  }

  if (!surf || surf.kind !== 'solid') return null;

  // Ограничение максимального числа ячеек: вытесняем самые сухие/дальние
  if (_cells.size >= MAX_CELLS) {
    let victimKey = null;
    let lowestScore = Infinity;
    for (const [k, c] of _cells) {
      const score = c.liquidDepth + c.snowDepth + c.crustDepth;
      if (score < lowestScore) {
        lowestScore = score;
        victimKey = k;
      }
    }
    if (victimKey) _cells.delete(victimKey);
  }

  cell = {
    key,
    gx,
    gz,
    wx: (gx + 0.5) * CELL_SIZE,
    wz: (gz + 0.5) * CELL_SIZE,
    baseY: surf.y,
    block: surf.block,
    noise: samplePatchNoise(gx, gz),
    // Жидкий слой (лужи)
    liquidDepth: 0,
    liquidSubstance: 'water',
    frozenRatio: 0, // 0..1 — степень обледенения лужи при freezing
    // Твёрдый/сыпучий слой (снег, пепел, обсидиановая крошка)
    snowDepth: 0,
    snowSubstance: 'water',
    solidType: 'snow', // 'snow' | 'ash' | 'obsidian'
    // Остывшая лавовая корка (результат термальной реакции воды и лавы)
    crustDepth: 0
  };
  _cells.set(key, cell);
  return cell;
}

function triggerGroundSteamReaction(wx, wy, wz, anchorPos) {
  emitParticleBurst(wx, wy + 0.15, wz, 3, {
    preset: 'smoke',
    color: '#e2f1ff',
    sizeStart: 0.45,
    sizeEnd: 1.25,
    speed: 1.8,
    spread: 0.7,
    gravity: 2.2,
    lifetime: 0.85
  });
  if (_steamSoundCd <= 0 && anchorPos) {
    const d = Math.hypot(wx - anchorPos.x, wz - anchorPos.z);
    if (d < 22) {
      _steamSoundCd = 0.45;
      sfx.steam?.(clamp(1 - d / 24, 0.25, 0.85));
    }
  }
}

/**
 * Депозит осадков в ячейку + термальные реакции (лава <-> снег/вода).
 */
function depositPrecipitationOnCell(cell, substance, phase, intensity, stepDt, anchorPos) {
  const pInfo = WEATHER_PHASES[phase] || WEATHER_PHASES.none;
  if (!pInfo || pInfo.kind === 'none' || pInfo.kind === 'mist' || pInfo.kind === 'evaporate') return;

  // Неравномерный темп накопления (ямки и шумные пятна растут заметно быстрее)
  const uneven = 0.45 + cell.noise * 1.15;
  const amt = 0.042 * intensity * uneven * stepDt;

  // 1. ТЕРМАЛЬНАЯ РЕАКЦИЯ: лавовый дождь падает на снег или не-лавовую лужу -> пар и испарение!
  if (phase === 'lava_rain') {
    const hasWatery = (cell.snowDepth > 0.01 && cell.solidType === 'snow') ||
      (cell.liquidDepth > 0.01 && cell.liquidSubstance !== 'lava');
    if (hasWatery) {
      cell.snowDepth = Math.max(0, cell.snowDepth - amt * 3.2);
      if (cell.liquidSubstance !== 'lava') {
        cell.liquidDepth = Math.max(0, cell.liquidDepth - amt * 2.8);
        cell.frozenRatio = Math.max(0, cell.frozenRatio - 0.5);
      }
      if (Math.random() < 0.45) triggerGroundSteamReaction(cell.wx, cell.baseY, cell.wz, anchorPos);
      return;
    }
    cell.liquidSubstance = 'lava';
    cell.frozenRatio = 0;
    cell.liquidDepth = clamp(cell.liquidDepth + amt * 0.85, 0, 0.36);
    return;
  }

  // 2. ТЕРМАЛЬНАЯ РЕАКЦИЯ: вода/кровь/кислота падают на лавовую лужу -> пар + тёмная корка!
  if (substance !== 'lava' && cell.liquidSubstance === 'lava' && cell.liquidDepth > 0.015) {
    const cooled = Math.min(cell.liquidDepth, amt * 2.6);
    cell.liquidDepth -= cooled;
    cell.crustDepth = clamp(cell.crustDepth + cooled * 0.9, 0, 0.24);
    if (cell.liquidDepth <= 0.01) {
      cell.liquidDepth = 0;
      cell.liquidSubstance = substance;
    }
    if (Math.random() < 0.45) triggerGroundSteamReaction(cell.wx, cell.baseY, cell.wz, anchorPos);
    return;
  }

  // 3. Обычное накопление по фазе
  if (phase === 'ash') {
    cell.solidType = 'ash';
    cell.snowSubstance = 'lava';
    cell.snowDepth = clamp(cell.snowDepth + amt * 1.15, 0, 0.52);
  } else if (phase === 'obsidian_hail') {
    cell.solidType = 'obsidian';
    cell.snowSubstance = 'lava';
    cell.snowDepth = clamp(cell.snowDepth + amt * 0.85, 0, 0.42);
  } else if (pInfo.kind === 'snow') {
    // Снег накапливается неравномерными объёмными 3D-сугробами
    cell.solidType = 'snow';
    cell.snowSubstance = substance;
    cell.snowDepth = clamp(cell.snowDepth + amt * 1.65, 0, 0.85);
  } else if (pInfo.isHail) {
    // Град создаёт ЛУЖИ и СНЕГ/ЛЕДЯНУЮ КРОШКУ одновременно!
    cell.solidType = 'snow';
    cell.snowSubstance = substance;
    cell.snowDepth = clamp(cell.snowDepth + amt * 0.85, 0, 0.48);
    cell.liquidSubstance = substance;
    cell.liquidDepth = clamp(cell.liquidDepth + amt * 0.72, 0, 0.38);
  } else if (pInfo.kind === 'rain') {
    // Дождь создаёт лужи своего цвета и подтапливает/смывает тонкий пепел
    if (cell.solidType === 'ash' && cell.snowDepth > 0) {
      cell.snowDepth = Math.max(0, cell.snowDepth - amt * 1.4);
    }
    cell.liquidSubstance = substance;
    cell.liquidDepth = clamp(cell.liquidDepth + amt * 0.9, 0, 0.42);
  }
}

/**
 * Клеточный автомат: сток луж и талой воды в углубления и водоёмы,
 * таяние снега, впитывание, испарение и обледенение луж.
 */
function simulateSurfaceCells(stepDt, effTemp, substance, phase, anchorPos) {
  const meltRates = { freezing: 0, cold: 0, cool: 0.022, normal: 0.055, warm: 0.11, hot: 0.22, hell: 0.45 };
  const evapRates = { freezing: 0, cold: 0.002, cool: 0.004, normal: 0.01, warm: 0.02, hot: 0.048, hell: 0.12 };
  const thawIceRates = { freezing: 0, cold: 0.025, cool: 0.12, normal: 0.28, warm: 0.5, hot: 0.85, hell: 1.6 };

  const meltRate = meltRates[effTemp] ?? 0.05;
  const evapRate = evapRates[effTemp] ?? 0.01;
  const thawIceRate = thawIceRates[effTemp] ?? 0.25;
  const soakRate = 0.0042;
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  const toDelete = [];

  for (const cell of _cells.values()) {
    // Проверка, не исчез ли опорный блок
    if (!cell.block || cell.block.isDisabled || cell.block._depletedDisabled) {
      toDelete.push(cell.key);
      continue;
    }

    // Периодически уточняем высоту динамических/движущихся блоков
    if (cell.block.isDynamicPhysics || cell.block.components?.motion?.enabled) {
      cell.baseY = cell.block.y1;
    }

    // 0. Горячая лавовая лужа прямо на замёрзшем блоке / воде активно растапливает лёд!
    if (
      cell.liquidSubstance === 'lava' &&
      cell.liquidDepth > 0.012 &&
      (cell.block._frozenFromLiquid || (cell.block.statusEffects?.freeze?.stacks || 0) > 0)
    ) {
      applyStatusEffect(cell.block, 'burn', 2);
      if (Math.random() < 0.45) triggerGroundSteamReaction(cell.wx, cell.baseY, cell.wz, anchorPos);
      // Если лёд растаял обратно в воду — верхняя лавовая лужа шипит и уходит в пар
      if (cell.block.matterState === 'liquid') {
        cell.liquidDepth = 0;
        toDelete.push(cell.key);
        continue;
      }
    }

    // 1. Таяние снега в воду / рассеивание пепла и обсидиановой крошки
    if (cell.snowDepth > 0) {
      if (cell.solidType === 'snow') {
        if (meltRate > 0) {
          const melted = Math.min(cell.snowDepth, meltRate * (0.7 + cell.noise * 0.6) * stepDt);
          cell.snowDepth -= melted;
          if (cell.liquidSubstance === 'lava' && cell.liquidDepth > 0.01) {
            cell.liquidDepth = Math.max(0, cell.liquidDepth - melted * 0.8);
            cell.crustDepth = clamp(cell.crustDepth + melted * 0.5, 0, 0.24);
          } else {
            cell.liquidSubstance = cell.snowSubstance || 'water';
            cell.liquidDepth = clamp(cell.liquidDepth + melted * 0.78, 0, 0.45);
          }
        }
      } else {
        // Пепел и обсидиановая крошка не тают в воду, а постепенно развеиваются
        const disp = (cell.solidType === 'ash' ? 0.012 : 0.008) * stepDt;
        cell.snowDepth = Math.max(0, cell.snowDepth - disp);
      }
    }

    // 2. Остывшая базальтовая корка медленно разрушается
    if (cell.crustDepth > 0) {
      cell.crustDepth = Math.max(0, cell.crustDepth - 0.009 * stepDt);
    }

    // 3. Обледенение луж при freezing и их оттаивание при потеплении
    if (cell.liquidDepth > 0.012 && cell.liquidSubstance !== 'lava') {
      if (effTemp === 'freezing') {
        cell.frozenRatio = clamp(cell.frozenRatio + 0.16 * stepDt, 0, 1);
      } else if (cell.frozenRatio > 0) {
        cell.frozenRatio = Math.max(0, cell.frozenRatio - thawIceRate * stepDt);
      }
    } else if (cell.liquidSubstance === 'lava') {
      cell.frozenRatio = 0;
    }

    // 4. Сток жидкости в более низкие углубления и в соседние жидкие блоки (водоёмы)
    if (cell.liquidDepth > 0.018 && cell.frozenRatio < 0.65) {
      const isLava = cell.liquidSubstance === 'lava';
      const flowSpeed = isLava ? 0.16 : 0.34;
      const myLevel = cell.baseY + cell.liquidDepth;

      // Ищем самую низкую соседнюю точку (приоритет — углубления и водоёмы)
      let bestDir = null;
      let bestDrop = 0.008;
      let bestSurf = null;
      let bestNbCell = null;

      for (let d = 0; d < 4; d++) {
        const ngx = cell.gx + dirs[d][0];
        const ngz = cell.gz + dirs[d][1];
        const nKey = `${ngx},${ngz}`;
        const existing = _cells.get(nKey);
        if (existing) {
          const drop = myLevel - (existing.baseY + existing.liquidDepth);
          if (drop > bestDrop && cell.baseY - existing.baseY <= 4.5) {
            bestDrop = drop;
            bestDir = d;
            bestNbCell = existing;
            bestSurf = null;
          }
        } else {
          const nwx = (ngx + 0.5) * CELL_SIZE;
          const nwz = (ngz + 0.5) * CELL_SIZE;
          const surf = sampleHighestExposedSurface(nwx, nwz);
          if (!surf) continue;
          const drop = myLevel - surf.y;
          if (drop > bestDrop && cell.baseY - surf.y <= 4.5) {
            bestDrop = drop;
            bestDir = d;
            bestNbCell = null;
            bestSurf = surf;
          }
        }
      }

      if (bestDir !== null) {
        const transfer = Math.min(cell.liquidDepth * 0.35, bestDrop * flowSpeed);
        if (transfer > 0.003) {
          if (bestSurf && bestSurf.kind === 'liquid' && bestSurf.block) {
            // Сток уходит напрямую в источник воды / водоём!
            cell.liquidDepth -= transfer;
            if (cell.liquidSubstance !== 'lava') {
              bestSurf.block._weatherRunoffAccum = (bestSurf.block._weatherRunoffAccum || 0) + transfer * CELL_SIZE * CELL_SIZE;
            }
          } else {
            const ngx = cell.gx + dirs[bestDir][0];
            const ngz = cell.gz + dirs[bestDir][1];
            const nb = bestNbCell || getOrCreateCell(ngx, ngz, bestSurf);
            if (nb) {
              // Термальная реакция при встрече лавового и водного потоков
              if ((cell.liquidSubstance === 'lava') !== (nb.liquidSubstance === 'lava') && nb.liquidDepth > 0.015) {
                cell.liquidDepth -= transfer;
                nb.liquidDepth = Math.max(0, nb.liquidDepth - transfer * 0.8);
                nb.crustDepth = clamp(nb.crustDepth + transfer * 0.7, 0, 0.24);
                if (Math.random() < 0.35) triggerGroundSteamReaction(nb.wx, nb.baseY, nb.wz, anchorPos);
              } else {
                cell.liquidDepth -= transfer;
                nb.liquidDepth = clamp(nb.liquidDepth + transfer, 0, 0.52);
                if (nb.liquidDepth <= transfer * 1.4 || cell.liquidSubstance !== 'water') {
                  nb.liquidSubstance = cell.liquidSubstance;
                }
                nb.frozenRatio = Math.min(nb.frozenRatio, cell.frozenRatio);
              }
            }
          }
        }
      }
    }

    // 5. Впитывание и испарение жидкости (замёрзшая лужа почти не испаряется)
    if (cell.liquidDepth > 0) {
      if (cell.liquidSubstance === 'lava') {
        // Лавовая лужа без лавового дождя остывает в корку
        if (phase !== 'lava_rain') {
          const coolSpd = (effTemp === 'freezing' || effTemp === 'cold' ? 0.032 : 0.014) * stepDt;
          const cooled = Math.min(cell.liquidDepth, coolSpd);
          cell.liquidDepth -= cooled;
          cell.crustDepth = clamp(cell.crustDepth + cooled * 0.55, 0, 0.24);
        }
      } else if (cell.frozenRatio < 0.8) {
        const activeEvap = (soakRate + evapRate) * (1 - cell.frozenRatio * 0.85) * stepDt;
        cell.liquidDepth = Math.max(0, cell.liquidDepth - activeEvap);
        if (cell.liquidDepth <= 0.002) {
          cell.liquidDepth = 0;
          cell.frozenRatio = 0;
        }
      }
    }

    // Очистка полностью сухих/пустых ячеек или ушедших далеко от игрока
    const farDist = anchorPos ? Math.hypot(cell.wx - anchorPos.x, cell.wz - anchorPos.z) : 0;
    const isEmpty = cell.liquidDepth <= 0.002 && cell.snowDepth <= 0.002 && cell.crustDepth <= 0.002;
    if (isEmpty || farDist > (ACTIVE_RADIUS_CELLS + 10) * CELL_SIZE) {
      toDelete.push(cell.key);
    }
  }

  for (let i = 0; i < toDelete.length; i++) {
    _cells.delete(toDelete[i]);
  }
}

/**
 * Гидрология: осадки и поверхностный сток заставляют жидкие блоки расти вверх.
 * Чем больше площадь объекта жидкости (w * d), тем медленнее подъём уровня.
 */
function updateLiquidBlocksHydrology(stepDt, substance, phase, intensity, effTemp) {
  if (S.state !== 'play') return;
  if (S.worldSettings?.weatherSettings?.growLiquids === false) return;

  const pInfo = WEATHER_PHASES[phase] || WEATHER_PHASES.none;
  const isLiquidPrecip =
    substance !== 'none' &&
    substance !== 'lava' &&
    (pInfo.kind === 'rain' || pInfo.isHail || (pInfo.kind === 'snow' && effTemp !== 'freezing' && effTemp !== 'cold'));

  const blocks = S.allBlocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.isDisabled || b._depletedDisabled || b.matterState !== 'liquid' || b._frozenFromLiquid || !b.m) continue;
    if (b.components && !b.components.physics?.enabled) continue;

    // Фиксируем исходную высоту и нижнюю грань (дно) водоёма при первом обновлении в Игре
    if (b._weatherBaseH === undefined) {
      b._weatherBaseH = b.h;
      b._weatherBaseY0 = b.m.position.y - b.h * 0.5;
    }

    const runoff = b._weatherRunoffAccum || 0;
    b._weatherRunoffAccum = 0;

    const area = Math.max(2.0, (b.w || 2) * (b.d || 2));
    // Обратная зависимость скорости роста от площади водоёма: маленький пруд растёт быстро, океан — очень медленно
    const areaDamp = 1.0 / Math.pow(area / 12.0, 0.72);
    const maxAllowedH = b._weatherBaseH + clamp(Math.max(1.25, b._weatherBaseH * 0.65), 1.25, 6.0);

    let dh = 0;
    if (isLiquidPrecip && isPointExposedToSky(b.m.position.x, b.y1 + 0.08, b.m.position.z)) {
      const phaseMult = pInfo.isHail ? 0.65 : (pInfo.kind === 'snow' ? 0.35 : 1.0);
      dh += 0.085 * intensity * phaseMult * areaDamp * stepDt;
    }
    if (runoff > 0) {
      dh += (runoff / area) * 0.55;
    }

    // В сухую/жаркую погоду лишняя вода постепенно испаряется обратно к базовому уровню
    if (dh <= 0 && b.h > b._weatherBaseH + 0.002) {
      const drySpd = (effTemp === 'hell' ? 0.14 : (effTemp === 'hot' ? 0.065 : (effTemp === 'warm' ? 0.028 : 0.012)));
      dh -= drySpd * Math.max(0.25, areaDamp) * stepDt;
    }

    if (Math.abs(dh) < 0.0001) continue;

    const newH = clamp(b.h + dh, b._weatherBaseH, maxAllowedH);
    if (Math.abs(newH - b.h) < 0.0001) continue;

    b.h = newH;
    b.m.scale.y = newH;
    // Дно остаётся на месте — жидкость растёт строго вверх!
    b.m.position.y = b._weatherBaseY0 + newH * 0.5;
    b.m.updateMatrixWorld();

    if (_surfHooks.updateBlockOBB) _surfHooks.updateBlockOBB(b);
    if (b.haloSprite) b.haloSprite.position.copy(b.m.position);
    if (b.cpVisualGroup) b.cpVisualGroup.position.copy(b.m.position);
  }
}

/**
 * Воздействие луж/обледенения на игрока и NPC (намокание, загрязнение, ожог от лавовой лужи).
 */
function applySurfaceCellEffectsToLiving(stepDt) {
  if (S.state !== 'play' || _cells.size === 0) return;

  const checkEnt = ent => {
    if (!ent || ent.isDisabled || ent._deadCooldown > 0 || ent._permanentlyDead) return;
    if (ent.isP && (S.playerDead || ent.isFlying)) return;
    const sample = sampleSurfaceWeatherAt(ent.x, ent.y, ent.z);
    if (!sample) return;

    if (sample.hasLavaPuddle) {
      applyStatusEffect(ent, 'burn', 1, { maxStacks: 5 });
      if (Math.random() < 0.4) dealExternalStatusDamage(ent, 3);
    } else if (sample.liquidDepth >= 0.045 && !sample.onFrozenPuddle) {
      applyWetness(ent, 14 * stepDt, sample.liquidSubstance, { rinse: sample.liquidSubstance === 'water' });
      if (sample.liquidSubstance === 'acid' && Math.random() < 0.25 * stepDt) {
        applyStatusEffect(ent, 'poison', 1, { maxStacks: 5 });
      }
    }
  };

  if (S.player) checkEnt(S.player);
  for (let i = 0; i < S.customNPCs.length; i++) {
    checkEnt(S.customNPCs[i]);
  }
}

/**
 * Быстрая выборка поверхностного слоя под ногами сущности (для скольжения по льду и луж).
 */
export function sampleSurfaceWeatherAt(x, y, z) {
  if (_cells.size === 0) return null;
  const gx = Math.floor(x / CELL_SIZE);
  const gz = Math.floor(z / CELL_SIZE);
  const cell = _cells.get(`${gx},${gz}`);
  if (!cell) return null;
  if (Math.abs(y - cell.baseY) > 0.65) return null;

  return {
    liquidDepth: cell.liquidDepth,
    liquidSubstance: cell.liquidSubstance,
    frozenRatio: cell.frozenRatio,
    onFrozenPuddle: cell.liquidDepth > 0.015 && cell.frozenRatio >= 0.45,
    hasLavaPuddle: cell.liquidSubstance === 'lava' && cell.liquidDepth > 0.02,
    snowDepth: cell.snowDepth,
    solidType: cell.solidType,
    isLavaCrust: cell.crustDepth > 0.02
  };
}

export function clearSurfaceWeatherLayer() {
  _cells.clear();
  clearSurfaceWeatherVisuals();
}

export function resetSurfaceWeatherLayer(restoreLiquids = true) {
  clearSurfaceWeatherLayer();
  if (!restoreLiquids) return;

  const blocks = S.allBlocks || [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b._weatherBaseH === undefined) continue;
    if (b.m && b.matterState === 'liquid') {
      b.h = b._weatherBaseH;
      b.m.scale.y = b._weatherBaseH;
      b.m.position.y = b._weatherBaseY0 + b._weatherBaseH * 0.5;
      b.m.updateMatrixWorld();
      if (_surfHooks.updateBlockOBB) _surfHooks.updateBlockOBB(b);
      if (b.haloSprite) b.haloSprite.position.copy(b.m.position);
      if (b.cpVisualGroup) b.cpVisualGroup.position.copy(b.m.position);
    }
    delete b._weatherBaseH;
    delete b._weatherBaseY0;
    b._weatherRunoffAccum = 0;
  }
}

export function updateSurfaceWeatherLayer(dt) {
  if (_steamSoundCd > 0) _steamSoundCd = Math.max(0, _steamSoundCd - dt);
  tickSurfaceWeatherVisualsTime(S.time || performance.now() * 0.001);

  if (S.itemStudioOpen || S.state === 'menu') {
    rebuildSurfacePrecipitationMeshes(null, CELL_SIZE);
    return;
  }

  _simAccum += dt;
  if (_simAccum < SIM_STEP_SEC) return;
  const stepDt = _simAccum;
  _simAccum = 0;

  const ws = S.worldSettings?.weatherSettings;
  const substance = normalizeWeatherSubstance(ws?.type);
  const intensity = clamp(Number(ws?.intensity) ?? 0.75, 0.1, 1.0);
  const phase = S.weatherRuntime?.phase || 'none';
  const effTemp = getEffectiveWorldTemperatureKey();

  const anchorPos = (S.state === 'play' && S.player && !S.playerDead)
    ? { x: S.player.x, y: S.player.y, z: S.player.z }
    : { x: camera.position.x, y: camera.position.y, z: camera.position.z };

  // 1. Новые порции осадков в случайные ячейки вокруг игрока/камеры (неравномерное покрытие)
  const allowAccum = ws?.accumulateSurface !== false;
  if (allowAccum && substance !== 'none' && phase !== 'none') {
    const cGx = Math.floor(anchorPos.x / CELL_SIZE);
    const cGz = Math.floor(anchorPos.z / CELL_SIZE);
    const samplesPerTick = Math.round(24 + 38 * intensity);

    for (let s = 0; s < samplesPerTick; s++) {
      const ox = Math.round(rnd(-ACTIVE_RADIUS_CELLS, ACTIVE_RADIUS_CELLS));
      const oz = Math.round(rnd(-ACTIVE_RADIUS_CELLS, ACTIVE_RADIUS_CELLS));
      if (ox * ox + oz * oz > ACTIVE_RADIUS_CELLS * ACTIVE_RADIUS_CELLS) continue;

      const gx = cGx + ox;
      const gz = cGz + oz;
      const wx = (gx + 0.5) * CELL_SIZE;
      const wz = (gz + 0.5) * CELL_SIZE;

      const key = `${gx},${gz}`;
      let cell = _cells.get(key);
      if (!cell) {
        const surf = sampleHighestExposedSurface(wx, wz);
        if (!surf || surf.kind !== 'solid') continue;
        cell = getOrCreateCell(gx, gz, surf);
      }
      if (!cell) continue;

      depositPrecipitationOnCell(cell, substance, phase, intensity, stepDt * 3.2, anchorPos);
    }
  }

  // 2. Периодическая ре-синхронизация крыш (если игрок построил крышу над уже лежащей лужей/сугробом)
  _geoRefreshTick++;
  if (_lastBlockCount !== S.allBlocks.length || _geoRefreshTick % 12 === 0) {
    _lastBlockCount = S.allBlocks.length;
    for (const [k, cell] of _cells) {
      if (!isPointExposedToSky(cell.wx, cell.baseY + 0.1, cell.wz)) {
        // Под новой крышей осадки перестают падать, а существующий тонкий слой быстрее сходит
        cell.snowDepth = Math.max(0, cell.snowDepth - 0.02 * stepDt);
      }
    }
  }

  // 3. Симуляция стока, таяния, испарения и обледенения луж
  if (_cells.size > 0) {
    simulateSurfaceCells(stepDt, effTemp, substance, phase, anchorPos);
    applySurfaceCellEffectsToLiving(stepDt);
  }

  // 4. Гидрология: рост жидких блоков вверх
  updateLiquidBlocksHydrology(stepDt, substance, phase, intensity, effTemp);

  // 5. Постепенное покрытие поверхности блоков + объединённые меши луж/сугробов
  updateBlockSurfaceCoatings(stepDt, substance, phase, intensity, effTemp, anchorPos);
  rebuildSurfacePrecipitationMeshes(_cells, CELL_SIZE);
}