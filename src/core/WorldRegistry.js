// src/core/WorldRegistry.js
import { S, clamp } from './State.js';
import { scene } from './SceneManager.js';
import { createBlockMaterial, setMeshFrontSprite } from './TextureFactory.js';
import { makeTagSprite, updateTag } from './CharacterRig.js';
import { createDefaultParticleData, clearAllParticles } from './ParticleSystem.js';

// Оптимизированный пул реальных источников света (PointLight) — исключает перекомпиляцию шейдеров и просадку FPS
const MAX_ACTIVE_POINT_LIGHTS = 8;
const pointLightPool = [];

function ensurePointLightPool() {
  if (pointLightPool.length > 0) return;
  for (let i = 0; i < MAX_ACTIVE_POINT_LIGHTS; i++) {
    const pl = new THREE.PointLight(0xffffff, 0, 0.01, 1.5);
    pl.castShadow = false;
    pl.position.set(0, -9999, 0);
    scene.add(pl);
    pointLightPool.push(pl);
  }
}

export function createDefaultLightData(defaultColor = '#56f0ff', autoVisual = false) {
  return {
    mode: autoVisual ? 'visual' : 'none', // 'none' | 'visual' | 'point'
    color: defaultColor || '#56f0ff',
    intensity: autoVisual ? 1.2 : 1.4,
    distance: 14,
    pulseSpeed: 0
  };
}

export function createDefaultLogicData() {
  return {
    tag: '',               // Собственный тег блока (например: 'door_1', 'tp_exit')
    trigger: 'none',       // 'none' | 'keyE' | 'touch' | 'hit'
    action: 'door_slide',  // 'door_slide' | 'door_ghost' | 'teleport' | 'buy_perk' | 'give_cash' | 'bounce_pad'
    targetTag: '',         // Тег целевых блоков (если пусто — действует на сам блок)
    cost: 0,               // Цена активации в R$
    oneTimeBuy: true,      // Если true, после первой оплаты становится бесплатным (unlocked)
    unlocked: false,       // Оплачено ли уже в текущей сессии
    cooldown: 1.0,         // Кулдаун повторного нажатия (сек)
    stayTime: 4.0,         // Время в открытом состоянии для дверей (0 = навсегда / рычаг toggle)
    speed: 4.5,            // Скорость движения двери
    moveX: 0,              // Смещение двери по X
    moveY: 5,              // Смещение двери по Y (по умолчанию поднимается вверх на 5 студов)
    moveZ: 0,              // Смещение двери по Z
    tpX: 0,                // Координаты телепорта (если targetTag не задан)
    tpY: 6,
    tpZ: 0,
    perkType: 'speed',     // 'speed' | 'grav' | 'halo' | 'heal' | 'damage'
    rewardCash: 25,        // Награда для 'give_cash'
    promptText: '',        // Свой текст подсказки
    showBadge: true        // Показывать 3D-бейдж над блоком
  };
}

export function syncBlockLightVisuals(box) {
  if (!box || !box.m || !box.m.material) return;
  if (!box.lightData) {
    box.lightData = createDefaultLightData(box.colorHex, false);
  }
  const ld = box.lightData;
  const mat = box.m.material;

  if (!mat.emissive) return;

  if (ld.mode === 'visual' || ld.mode === 'point') {
    const glowHex = ld.color || box.colorHex || '#ffffff';
    mat.emissive.set(glowHex);
    const baseInt = clamp(Number(ld.intensity) || 1.2, 0.05, 5.0);
    // Для режима 'point' сам блок тоже светится неоном, чтобы выглядеть как источник света
    mat.emissiveIntensity = ld.mode === 'point' ? Math.min(2.5, baseInt * 0.85) : baseInt;
  } else if (box.damageOnContact > 0 && box.colorHex === '#ff1e1e') {
    mat.emissive.set('#ff1e1e');
    mat.emissiveIntensity = 0.75;
  } else {
    mat.emissive.setHex(0x000000);
    mat.emissiveIntensity = 0;
  }
}

// Обновление пульсации свечения и распределение пула PointLight по ближайшим к камере светящимся блокам
export function updateWorldLights(camPos) {
  ensurePointLightPool();
  const t = S.time || (performance.now() * 0.001);
  const pointCandidates = [];

  for (let i = 0; i < S.allBlocks.length; i++) {
    const box = S.allBlocks[i];
    const ld = box.lightData;
    if (!ld || ld.mode === 'none') continue;

    let pulseMult = 1.0;
    if (ld.pulseSpeed && ld.pulseSpeed > 0) {
      pulseMult = 0.65 + 0.35 * Math.sin(t * ld.pulseSpeed * 3.0 + i);
      if (box.m.material && box.m.material.emissive) {
        const baseInt = clamp(Number(ld.intensity) || 1.2, 0.05, 5.0);
        box.m.material.emissiveIntensity =
          (ld.mode === 'point' ? Math.min(2.5, baseInt * 0.85) : baseInt) * pulseMult;
      }
    }

    if (ld.mode === 'point') {
      const p = box.m.position;
      const dx = camPos ? p.x - camPos.x : 0;
      const dy = camPos ? p.y - camPos.y : 0;
      const dz = camPos ? p.z - camPos.z : 0;
      const distSq = dx * dx + dy * dy + dz * dz;
      const maxRange = (Number(ld.distance) || 14) + 55;
      if (distSq <= maxRange * maxRange) {
        pointCandidates.push({ box, ld, distSq, pulseMult });
      }
    }
  }

  if (pointCandidates.length > MAX_ACTIVE_POINT_LIGHTS) {
    pointCandidates.sort((a, b) => a.distSq - b.distSq);
  }

  for (let i = 0; i < MAX_ACTIVE_POINT_LIGHTS; i++) {
    const pl = pointLightPool[i];
    const cand = pointCandidates[i];
    if (cand) {
      const { box, ld, pulseMult } = cand;
      pl.color.set(ld.color || box.colorHex || '#ffffff');
      pl.intensity = clamp(Number(ld.intensity) || 1.4, 0.1, 6.0) * pulseMult;
      pl.distance = clamp(Number(ld.distance) || 14, 2, 80);
      pl.position.copy(box.m.position);
    } else {
      pl.intensity = 0;
      pl.distance = 0.01;
      pl.position.set(0, -9999, 0);
    }
  }
}

export function clearWorld() {
  clearAllParticles();
  for (const pl of pointLightPool) {
    pl.intensity = 0;
    pl.position.set(0, -9999, 0);
  }
  for (const b of S.allBlocks) {
    scene.remove(b.m);
    if (b.cpVisualGroup) scene.remove(b.cpVisualGroup);
  }
  S.allBlocks.length = 0;

  for (const c of S.spawnedCoins) {
    scene.remove(c.m);
  }
  S.spawnedCoins.length = 0;

  for (const ch of S.colliderHelpers) {
    scene.remove(ch);
  }
  S.colliderHelpers.length = 0;

  S.queueCoords = [];
  S.blockIdCounter = 1;
}

export function addSceneBlock(opts) {
  const {
    x = 0,
    y = 0,
    z = 0,
    w = 4,
    h = 1,
    d = 4,
    colorHex = '#ecf5ff',
    gold = false,
    customTexDataURL = null,
    matterState = 'solid', // 'solid' | 'liquid' | 'gas'
    bounciness = 0,
    conveyorVz = 0,
    conveyorVx = 0,
    damageOnContact = 0,
    teleportToCheckpoint = false,
    spinSpeed = 0,
    checkpointData = null,
    spawnerData = null,
    particleData = null,
    lightData = null,
    logicData = null,
    label = 'Блок',
    shape = 'box',
    isCustom = false
  } = opts;

  let geo;
  if (shape === 'cylinder') geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
  else if (shape === 'sphere') geo = new THREE.SphereGeometry(0.5, 16, 12);
  else geo = new THREE.BoxGeometry(1, 1, 1);

  const normalizedHex = colorHex.startsWith('#')
    ? colorHex
    : '#' + new THREE.Color(colorHex).getHexString();

  const mat = createBlockMaterial(
    normalizedHex,
    w / 2.2,
    d / 2.2,
    gold,
    null,
    matterState
  );

  const m = new THREE.Mesh(geo, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y - h / 2, z);
  m.castShadow = matterState === 'solid';
  m.receiveShadow = true;
  scene.add(m);

  const isKillLaserDefault = damageOnContact > 0 && matterState === 'solid' && normalizedHex === '#ff1e1e';
  const resolvedLightData = Object.assign(
    createDefaultLightData(normalizedHex, isKillLaserDefault),
    lightData || {}
  );
  const resolvedLogicData = Object.assign(createDefaultLogicData(), logicData || {});

  const id = 'blk_' + S.blockIdCounter++;
  const box = {
    id,
    label: label || 'Объект #' + S.blockIdCounter,
    shape,
    x0: x - w / 2,
    x1: x + w / 2,
    y0: y - h,
    y1: y,
    z0: z - d / 2,
    z1: z + d / 2,
    w,
    h,
    d,
    hx: w / 2,
    hy: h / 2,
    hz: d / 2,
    invQuat: new THREE.Quaternion(),
    axisX: new THREE.Vector3(1, 0, 0),
    axisY: new THREE.Vector3(0, 1, 0),
    axisZ: new THREE.Vector3(0, 0, 1),
    isRotated: false,
    boundRadius: Math.hypot(w / 2, h / 2, d / 2),
    m,
    colorHex: normalizedHex,
    gold: !!gold,
    customTexDataURL: customTexDataURL || null,
    matterState,
    bounciness: Number(bounciness) || 0,
    conveyorVz: Number(conveyorVz) || 0,
    conveyorVx: Number(conveyorVx) || 0,
    damageOnContact: Number(damageOnContact) || 0,
    teleportToCheckpoint: !!teleportToCheckpoint,
    spinSpeed: Number(spinSpeed) || 0,
    colliderScale: { x: 1, y: 1, z: 1 },
    checkpointData: checkpointData || {
      enabled: false,
      stage: 1,
      title: 'Чекпоинт',
      rewardCash: 50,
      skipSpots: 2
    },
    spawnerData: spawnerData || {
      mode: 'none',
      interval: 5,
      timer: 5,
      spawnType: 'npc'
    },
    particleData: Object.assign(createDefaultParticleData(), particleData || {}),
    lightData: resolvedLightData,
    logicData: resolvedLogicData,
    logicRuntime: {
      basePos: null,
      openT: 0,          // 0..1 прогресс открытия двери
      targetOpen: false, // Куда сейчас движется дверь
      stayTimer: 0,      // Таймер до автозакрытия
      cdTimer: 0,        // Таймер кулдауна триггера
      ghostOpen: false   // Проходима ли призрачная дверь сейчас
    },
    cpVisualGroup: null,
    isCustom
  };

  m.userData.editorRef = { kind: 'block', box };
  if (customTexDataURL) {
    setMeshFrontSprite(m, customTexDataURL);
  }

  S.allBlocks.push(box);
  syncBlockLightVisuals(box);
  syncBlockSpecialVisuals(box);
  updateBlockOBB(box);
  return box;
}

export function updateBlockOBB(box) {
  const m = box.m;
  const w = Math.max(0.15, Math.abs(m.scale.x));
  const h = Math.max(0.1, Math.abs(m.scale.y));
  const d = Math.max(0.15, Math.abs(m.scale.z));
  box.w = w;
  box.h = h;
  box.d = d;

  const cs = box.colliderScale || { x: 1, y: 1, z: 1 };
  const cw = w * cs.x;
  const ch = h * cs.y;
  const cd = d * cs.z;
  box.hx = cw * 0.5;
  box.hy = ch * 0.5;
  box.hz = cd * 0.5;
  box.boundRadius = Math.hypot(box.hx, box.hy, box.hz);

  m.updateMatrixWorld();
  box.invQuat.copy(m.quaternion).invert();
  box.axisX.set(1, 0, 0).applyQuaternion(m.quaternion).normalize();
  box.axisY.set(0, 1, 0).applyQuaternion(m.quaternion).normalize();
  box.axisZ.set(0, 0, 1).applyQuaternion(m.quaternion).normalize();
  box.isRotated =
    Math.abs(m.rotation.x) > 0.0005 ||
    Math.abs(m.rotation.y) > 0.0005 ||
    Math.abs(m.rotation.z) > 0.0005;

  const cx = m.position.x;
  const cy = m.position.y;
  const cz = m.position.z;
  const ex =
    Math.abs(box.axisX.x) * box.hx +
    Math.abs(box.axisY.x) * box.hy +
    Math.abs(box.axisZ.x) * box.hz;
  const ey =
    Math.abs(box.axisX.y) * box.hx +
    Math.abs(box.axisY.y) * box.hy +
    Math.abs(box.axisZ.y) * box.hz;
  const ez =
    Math.abs(box.axisX.z) * box.hx +
    Math.abs(box.axisY.z) * box.hy +
    Math.abs(box.axisZ.z) * box.hz;

  box.x0 = cx - ex;
  box.x1 = cx + ex;
  box.y0 = cy - ey;
  box.y1 = cy + ey;
  box.z0 = cz - ez;
  box.z1 = cz + ez;
}

export function getLogicBadgeStrings(box) {
  const lg = box.logicData;
  if (!lg || lg.trigger === 'none') return null;

  const trigBadge = lg.trigger === 'keyE'
    ? '[E]'
    : lg.trigger === 'touch'
    ? '[КАСАНИЕ]'
    : '[УДАР ЛКМ]';

  const costVal = Number(lg.cost) || 0;
  const needPay = costVal > 0 && !(lg.oneTimeBuy && lg.unlocked);
  const priceTag = needPay ? `💰 ${costVal} R$` : (costVal > 0 && lg.unlocked ? '✅ КУПЛЕНО' : '');

  let title = lg.promptText ? lg.promptText.trim() : '';
  if (!title) {
    if (lg.action === 'door_slide') title = `🚪 ДВЕРЬ / ЛИФТ ${trigBadge}`;
    else if (lg.action === 'door_ghost') title = `👻 ПРИЗРАЧНЫЙ ПРОХОД ${trigBadge}`;
    else if (lg.action === 'teleport') title = `🌀 ТЕЛЕПОРТ ${trigBadge}`;
    else if (lg.action === 'buy_perk') {
      const pNames = {
        speed: '🌀 Пружина Скорости',
        grav: '🚀 Пружина Прыжка',
        halo: '😇 VIP Нимб (x2 R$)',
        heal: '❤️ Мед-Станция (+HP)',
        damage: '🥊 Усиление Удара (+15)'
      };
      title = `${pNames[lg.perkType] || '🛒 Покупка'} ${trigBadge}`;
    } else if (lg.action === 'give_cash') {
      title = `🪙 +${lg.rewardCash || 25} R$ ${trigBadge}`;
    } else if (lg.action === 'bounce_pad') {
      title = `🚀 КАТАПУЛЬТА ${trigBadge}`;
    } else {
      title = `⚡ ТРИГГЕР ${trigBadge}`;
    }
  }

  const sub = priceTag || (lg.targetTag ? `Цель: #${lg.targetTag}` : box.label);
  return { title, sub, trigBadge };
}

export function syncBlockSpecialVisuals(box) {
  if (box.cpVisualGroup) {
    scene.remove(box.cpVisualGroup);
    box.cpVisualGroup = null;
  }

  if (box.checkpointData && box.checkpointData.enabled) {
    const g = new THREE.Group();
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(1.5, 1.5, 0.22, 20),
      new THREE.MeshBasicMaterial({ color: 0x00ff88 })
    );
    pad.position.set(0, box.h / 2 + 0.11, 0);
    const spr = makeTagSprite(320, 90, 3.8, 1.05);
    spr.position.set(0, box.h / 2 + 2.6, 0);
    const cd = box.checkpointData;
    const subText = cd.skipSpots > 0
      ? `+${cd.rewardCash} R$ и -${cd.skipSpots} мест!`
      : `+${cd.rewardCash} R$`;
    updateTag(spr, `⭐ ЧЕКПОИНТ #${cd.stage}`, cd.title, subText);
    g.add(pad, spr);
    g.position.copy(box.m.position);
    g.rotation.copy(box.m.rotation);
    g.traverse(o => {
      o.userData.editorRef = { kind: 'block', box };
    });
    scene.add(g);
    box.cpVisualGroup = g;
    return;
  }

  const lg = box.logicData;
  if (lg && lg.trigger !== 'none' && lg.showBadge !== false) {
    const info = getLogicBadgeStrings(box);
    if (info) {
      const g = new THREE.Group();
      const spr = makeTagSprite(320, 90, 3.6, 1.0);
      spr.position.set(0, box.h / 2 + 2.1, 0);
      updateTag(spr, info.title, info.sub, lg.tag ? `#${lg.tag}` : '');
      g.add(spr);
      g.position.copy(box.m.position);
      g.traverse(o => {
        o.userData.editorRef = { kind: 'block', box };
      });
      scene.add(g);
      box.cpVisualGroup = g;
    }
  }
}

export function resetAllLogicRuntime(reanchorCurrentAsBase = false) {
  for (const box of S.allBlocks) {
    if (!box.logicRuntime) {
      box.logicRuntime = {
        basePos: null,
        openT: 0,
        targetOpen: false,
        stayTimer: 0,
        cdTimer: 0,
        ghostOpen: false
      };
    }
    const rt = box.logicRuntime;
    if (reanchorCurrentAsBase || !rt.basePos) {
      rt.basePos = box.m.position.clone();
    } else {
      box.m.position.copy(rt.basePos);
    }
    rt.openT = 0;
    rt.targetOpen = false;
    rt.stayTimer = 0;
    rt.cdTimer = 0;
    if (rt.ghostOpen && box.m.material) {
      rt.ghostOpen = false;
      box.m.material.transparent = box.matterState !== 'solid';
      box.m.material.opacity = box.matterState === 'solid' ? 1.0 : (box.matterState === 'liquid' ? 0.72 : 0.55);
    }
    updateBlockOBB(box);
    if (box.cpVisualGroup) {
      box.cpVisualGroup.position.copy(box.m.position);
    }
  }
}

export function rebuildPhysicsArrays() {
  for (const ch of S.colliderHelpers) scene.remove(ch);
  S.colliderHelpers.length = 0;

  for (const box of S.allBlocks) {
    updateBlockOBB(box);
    syncBlockLightVisuals(box);
    const m = box.m;

    if (S.state === 'edit' && box.logicRuntime) {
      box.logicRuntime.basePos = m.position.clone();
      box.logicRuntime.openT = 0;
      box.logicRuntime.targetOpen = false;
      box.logicRuntime.stayTimer = 0;
    }

    if (m.material && m.material.map) {
      m.material.map.repeat.set(
        Math.max(1, Math.round(box.w / 2.2)),
        Math.max(1, Math.round(box.d / 2.2))
      );
    }
    if (box.cpVisualGroup) {
      box.cpVisualGroup.position.copy(m.position);
      if (box.checkpointData && box.checkpointData.enabled) {
        box.cpVisualGroup.rotation.copy(m.rotation);
      }
    }

    if (S.showColliders && box.matterState !== 'gas') {
      const colGeo = new THREE.BoxGeometry(box.hx * 2, box.hy * 2, box.hz * 2);
      const colWire = new THREE.LineSegments(
        new THREE.EdgesGeometry(colGeo),
        new THREE.LineBasicMaterial({
          color: box.damageOnContact > 0 ? 0xff3e3e : 0x00ff88
        })
      );
      colWire.position.copy(m.position);
      colWire.rotation.copy(m.rotation);
      scene.add(colWire);
      S.colliderHelpers.push(colWire);
    }
  }

  if (S.showColliders && S.player) {
    const p = S.player;
    const pr = p.colliderRadius || 0.42;
    const ph = p.colliderHeight || 2.5;
    const pWire = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(pr * 2, ph, pr * 2)),
      new THREE.LineBasicMaterial({ color: 0x56f0ff })
    );
    pWire.position.set(p.x, p.y + ph / 2, p.z);
    scene.add(pWire);
    S.colliderHelpers.push(pWire);
  }
}

export function addCheckpointBlock(x, y, z, stage, title, rewardCash, skipSpots = 0) {
  return addSceneBlock({
    x,
    y,
    z,
    w: 6.4,
    h: 0.8,
    d: 6.4,
    colorHex: '#ffeaa7',
    gold: true,
    label: `Чекпоинт Обби #${stage}`,
    checkpointData: { enabled: true, stage, title, rewardCash, skipSpots }
  });
}