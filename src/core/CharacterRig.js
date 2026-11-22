// src/core/CharacterRig.js
import { S, TAU, clamp } from './State.js';
import { buildBBModelGroup } from './BBModelLoader.js';
import {
  makePartMat,
  defaultFaceURL,
  setMeshFrontSprite,
  createHaloSprite
} from './TextureFactory.js';

export const MAX_COSMETIC_PARTS = 64;
export const MAX_ITEM_PARTS = 64;
export const MAX_ACTIVE_PER_SLOT = 2;

export const SLOT_LABELS_RU = {
  pet: 'Питомец',
  head: 'Голова',
  torso: 'Торс',
  armL: 'Л. рука',
  armR: 'П. рука',
  legL: 'Л. нога',
  legR: 'П. нога'
};

// Маппинг встроенной косметики к слотам персонажа для общего учёта лимита (2 на слот)
export const BUILTIN_COS_SLOT = {
  hat: 'head',
  crown: 'head',
  hair: 'head',
  glasses: 'head',
  halo: 'head',
  wings: 'torso',
  backpack: 'torso',
  sword: 'torso',
  coil: 'armR'
};

// Константы суставных пивотов R6
export const R6_PIVOTS = {
  hipY: 0.95,          // Точка вращения ног (тазобедренный сустав)
  legCenterOffset: -0.475,
  waistY: 0.95,        // Точка вращения торса (поясница)
  torsoCenterOffset: 0.50,
  shoulderY: 1.83,     // Точка вращения рук (плечевой сустав)
  armCenterOffset: -0.38,
  neckY: 1.98,         // Точка вращения головы (шея)
  headCenterOffset: 0.34
};

// Дефолтные точки хвата персонажа:
// 1) handGripPoint — внутри правой руки (armR). При поднятии руки вперёд (-90° по X)
//    поворот rx = +90° (PI/2), ry = 180° (PI) выравнивает ось -Z оружия точно вперёд по взгляду игрока, а +Y — строго вверх.
export const DEFAULT_HAND_GRIP_POINT = {
  x: 0,
  y: -0.76,
  z: 0.08,
  rx: Math.PI / 2,
  ry: Math.PI,
  rz: 0
};

// 2) carryGripPoint — перед торсом персонажа (в пространстве rig.g, где +Z — вперёд).
//    Поворот ry = 180° (PI) направляет лицевую сторону (-Z) контейнера вперёд от груди между двумя руками.
export const DEFAULT_CARRY_GRIP_POINT = {
  x: 0,
  y: 1.35,
  z: 0.95,
  rx: 0,
  ry: Math.PI,
  rz: 0
};

export function normalizeCharacterGripPoints(target, fallbackSource = null) {
  if (!target) return target;
  const srcH = (target.handGripPoint) || (fallbackSource && fallbackSource.handGripPoint) || DEFAULT_HAND_GRIP_POINT;
  target.handGripPoint = {
    x: Number(srcH.x ?? DEFAULT_HAND_GRIP_POINT.x) || 0,
    y: Number(srcH.y ?? DEFAULT_HAND_GRIP_POINT.y) || 0,
    z: Number(srcH.z ?? DEFAULT_HAND_GRIP_POINT.z) || 0,
    rx: Number(srcH.rx ?? DEFAULT_HAND_GRIP_POINT.rx) || 0,
    ry: Number(srcH.ry ?? DEFAULT_HAND_GRIP_POINT.ry) || 0,
    rz: Number(srcH.rz ?? DEFAULT_HAND_GRIP_POINT.rz) || 0
  };

  const srcC = (target.carryGripPoint) || (fallbackSource && fallbackSource.carryGripPoint) || DEFAULT_CARRY_GRIP_POINT;
  target.carryGripPoint = {
    x: Number(srcC.x ?? DEFAULT_CARRY_GRIP_POINT.x) || 0,
    y: Number(srcC.y ?? DEFAULT_CARRY_GRIP_POINT.y) || 0,
    z: Number(srcC.z ?? DEFAULT_CARRY_GRIP_POINT.z) || 0,
    rx: Number(srcC.rx ?? DEFAULT_CARRY_GRIP_POINT.rx) || 0,
    ry: Number(srcC.ry ?? DEFAULT_CARRY_GRIP_POINT.ry) || 0,
    rz: Number(srcC.rz ?? DEFAULT_CARRY_GRIP_POINT.rz) || 0
  };
  return target;
}

// Создание аккуратных высокоточных X-Ray гизмо-маркеров для Студии (depthTest: false, без громоздких сеток)
export function createXRayGripMarkerMesh(colorHex = '#00e676', scale = 1.0) {
  const group = new THREE.Group();
  group.renderOrder = 999;

  const mkMat = (col, op = 0.96) =>
    new THREE.MeshBasicMaterial({
      color: col,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: op,
      side: THREE.DoubleSide
    });

  const coreMat = mkMat(colorHex, 0.98);
  const ringMat = mkMat('#ffffff', 0.9);
  const xMat = mkMat('#ff4757', 0.96);   // Красный (+X)
  const yMat = mkMat('#00e676', 0.96);   // Зелёный (+Y)
  const zMat = mkMat('#00d2ff', 0.96);   // Синий (+Z / -Z ствол)
  const goldMat = mkMat('#ffce3a', 0.95);
  const hitMat = mkMat('#ffffff', 0.0);

  // Увеличенная сфера клика для лёгкого попадания мышью
  const hitSphere = new THREE.Mesh(new THREE.SphereGeometry(0.18 * scale, 10, 10), hitMat);
  group.add(hitSphere);

  // Объёмный мультяшный кристалл в центре пивота
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.075 * scale, 0), coreMat);
  group.add(core);

  // Пухлое белое кольцо вокруг кристалла
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.13 * scale, 0.016 * scale, 12, 32), ringMat);
  group.add(ring);

  // Направление ствола / клинка (-Z) — толстая голубая стрела с золотым кольцом
  const fwdShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022 * scale, 0.022 * scale, 0.26 * scale, 12), zMat);
  fwdShaft.rotation.x = Math.PI / 2;
  fwdShaft.position.set(0, 0, -0.15 * scale);
  group.add(fwdShaft);

  const fwdCollar = new THREE.Mesh(new THREE.TorusGeometry(0.042 * scale, 0.01 * scale, 8, 16), goldMat);
  fwdCollar.position.set(0, 0, -0.27 * scale);
  group.add(fwdCollar);

  const fwdTip = new THREE.Mesh(new THREE.ConeGeometry(0.058 * scale, 0.13 * scale, 14), zMat);
  fwdTip.rotation.x = -Math.PI / 2;
  fwdTip.position.set(0, 0, -0.32 * scale);
  group.add(fwdTip);

  // Ось «Вверх (+Y)» — пухлая зелёная стрелка
  const upShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018 * scale, 0.018 * scale, 0.16 * scale, 10), yMat);
  upShaft.position.set(0, 0.09 * scale, 0);
  group.add(upShaft);

  const upTip = new THREE.Mesh(new THREE.ConeGeometry(0.045 * scale, 0.1 * scale, 12), yMat);
  upTip.position.set(0, 0.2 * scale, 0);
  group.add(upTip);

  // Ось «Вправо (+X)» — пухлая красная стрелка
  const sideShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.018 * scale, 0.018 * scale, 0.14 * scale, 10), xMat);
  sideShaft.rotation.z = -Math.PI / 2;
  sideShaft.position.set(0.08 * scale, 0, 0);
  group.add(sideShaft);

  const sideTip = new THREE.Mesh(new THREE.ConeGeometry(0.042 * scale, 0.095 * scale, 12), xMat);
  sideTip.rotation.z = -Math.PI / 2;
  sideTip.position.set(0.18 * scale, 0, 0);
  group.add(sideTip);

  group.traverse(o => {
    o.renderOrder = 999;
    o.userData.noCollider = true;
  });
  return group;
}

export function createXRayMuzzleMarkerMesh(colorHex = '#ff4757', scale = 1.0) {
  const group = new THREE.Group();
  group.renderOrder = 999;

  const mkMat = (col, op = 0.96) =>
    new THREE.MeshBasicMaterial({
      color: col,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: op,
      side: THREE.DoubleSide
    });

  const muzMat = mkMat(colorHex, 0.98);
  const goldMat = mkMat('#ffce3a', 0.95);
  const whiteMat = mkMat('#ffffff', 0.98);
  const hitMat = mkMat('#ffffff', 0.0);

  const hitSphere = new THREE.Mesh(new THREE.SphereGeometry(0.18 * scale, 10, 10), hitMat);
  group.add(hitSphere);

  // Толстое мультяшное кольцо прицела
  const outerRing = new THREE.Mesh(new THREE.TorusGeometry(0.12 * scale, 0.016 * scale, 12, 32), muzMat);
  group.add(outerRing);

  const innerRing = new THREE.Mesh(new THREE.TorusGeometry(0.055 * scale, 0.012 * scale, 10, 24), goldMat);
  group.add(innerRing);

  // 4 объёмных деления прицела
  const tickGeoV = new THREE.BoxGeometry(0.022 * scale, 0.065 * scale, 0.022 * scale);
  const tickGeoH = new THREE.BoxGeometry(0.065 * scale, 0.022 * scale, 0.022 * scale);
  const tTop = new THREE.Mesh(tickGeoV, goldMat);
  tTop.position.set(0, 0.12 * scale, 0);
  const tBot = new THREE.Mesh(tickGeoV, goldMat);
  tBot.position.set(0, -0.12 * scale, 0);
  const tLeft = new THREE.Mesh(tickGeoH, goldMat);
  tLeft.position.set(-0.12 * scale, 0, 0);
  const tRight = new THREE.Mesh(tickGeoH, goldMat);
  tRight.position.set(0.12 * scale, 0, 0);
  group.add(tTop, tBot, tLeft, tRight);

  const centerDot = new THREE.Mesh(new THREE.OctahedronGeometry(0.038 * scale, 0), whiteMat);
  group.add(centerDot);

  // Объёмный пунктир направления выстрела (-Z) с крупным наконечником
  const dashGeo = new THREE.CylinderGeometry(0.016 * scale, 0.016 * scale, 0.07 * scale, 10);
  dashGeo.rotateX(Math.PI / 2);
  for (let i = 0; i < 3; i++) {
    const dash = new THREE.Mesh(dashGeo, muzMat);
    dash.position.set(0, 0, -(0.08 + i * 0.105) * scale);
    group.add(dash);
  }

  const tip = new THREE.Mesh(new THREE.ConeGeometry(0.055 * scale, 0.13 * scale, 14), muzMat);
  tip.rotation.x = -Math.PI / 2;
  tip.position.set(0, 0, -0.39 * scale);
  group.add(tip);

  group.traverse(o => {
    o.renderOrder = 999;
    o.userData.noCollider = true;
  });
  return group;
}

// КЭШ ГЕОМЕТРИЙ И МАТЕРИАЛОВ — исключает создание лишних буферов и просадку FPS в масштабных боях
const SHARED_GEO_CACHE = {};
const SHARED_MAT_CACHE = {};

export function getSharedPrimitiveGeo(shape = 'box') {
  if (SHARED_GEO_CACHE[shape]) return SHARED_GEO_CACHE[shape];
  let geo;
  if (shape === 'bbmodel' || shape === 'none') {
    geo = new THREE.BufferGeometry();
    // 2 вершины и 0 треугольников: ничего не рендерит, но Box3.setFromObject не выдаёт ±Infinity/NaN
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-0.04, -0.04, -0.04, 0.04, 0.04, 0.04], 3));
    geo.setIndex([]);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
  } 
  else if (shape === 'sphere') geo = new THREE.SphereGeometry(0.4, 14, 10);
  else if (shape === 'cylinder') geo = new THREE.CylinderGeometry(0.35, 0.35, 0.6, 14);
  else if (shape === 'cone') geo = new THREE.ConeGeometry(0.4, 0.7, 14);
  else if (shape === 'torus') geo = new THREE.TorusGeometry(0.38, 0.08, 10, 18);
  else if (shape === 'plane') geo = new THREE.PlaneGeometry(0.8, 0.8);
  else geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  SHARED_GEO_CACHE[shape] = geo;
  return geo;
}

export function getSharedPrimitiveMat(
  colorHex = '#ffce3a',
  emissiveHex = null,
  emissiveInt = 1.2,
  isPseudo = false
) {
  const normCol = (colorHex || '#ffce3a').toLowerCase();
  const normEm = emissiveHex ? emissiveHex.toLowerCase() : '';
  const effectiveInt = normEm
    ? (isPseudo ? clamp(Number(emissiveInt || 1.4) * 2.5, 2.0, 7.5) : clamp(Number(emissiveInt || 1.4) * 1.5, 1.2, 5.0))
    : 0;
  const normInt = normEm ? effectiveInt.toFixed(2) : '0';
  const key = `${normCol}|${normEm}|${normInt}|${isPseudo ? '1' : '0'}`;
  if (SHARED_MAT_CACHE[key]) return SHARED_MAT_CACHE[key];

  const mat = new THREE.MeshStandardMaterial({
    color: normCol,
    roughness: normEm ? 0.15 : 0.35,
    metalness: normEm ? 0.0 : 0.2,
    side: THREE.DoubleSide
  });
  if (normEm) {
    mat.emissive.set(normEm);
    mat.emissiveIntensity = effectiveInt;
  }
  SHARED_MAT_CACHE[key] = mat;
  return mat;
}

export function createDefaultPartParticleData(defaultColor = '#ffffff') {
  return {
    enabled: false,
    preset: 'spark',     // 'spark' | 'fire' | 'heart' | 'star' | 'smoke' | 'hit' | 'custom'
    texDataURL: null,
    color: defaultColor || '#ffffff',
    rate: 10,
    lifetime: 1.1,
    sizeStart: 0.32,
    sizeEnd: 0.05,
    speed: 2.2,
    dirX: 0,
    dirY: 1,
    dirZ: 0,
    spread: 0.65,
    gravity: -0.8,
    rotSpeed: 2.0,
    flicker: 0.1,
    fadeOut: true
  };
}

export function normalizePartEffects(pt, defaultPseudo = false, defaultReal = false) {
  if (!pt) return pt;
  pt.pseudoLight = pt.pseudoLight !== undefined ? !!pt.pseudoLight : !!defaultPseudo;
  pt.realLight = pt.realLight !== undefined ? !!pt.realLight : !!defaultReal;
  pt.lightColor = pt.lightColor || pt.color || '#ffce3a';
  pt.lightIntensity = pt.lightIntensity !== undefined ? Number(pt.lightIntensity) : 1.5;
  pt.lightDistance = pt.lightDistance !== undefined ? Number(pt.lightDistance) : 14;
  pt.particleData = Object.assign(
    createDefaultPartParticleData(pt.color || '#ffffff'),
    pt.particleData || {}
  );
  return pt;
}

// Кратчайшая угловая интерполяция без скачка через -PI / +PI
function lerpAngle(a, b, t) {
  let diff = ((b - a + Math.PI) % TAU) - Math.PI;
  if (diff < -Math.PI) diff += TAU;
  return a + diff * t;
}

// Подсчитывает количество активных (включённых) предметов в указанном слоте у сущности
export function syncBuiltinCosmetics(rig, preset = {}, isAngel = false) {
  if (!rig) return;
  if (rig.hatGroup) {
    rig.hatGroup.visible = !!preset.hat;
    if (preset.hat && rig.hatMat) {
      if (typeof preset.hat === 'number') rig.hatMat.color.setHex(preset.hat);
      else rig.hatMat.color.set(preset.hat);
    }
  }
  if (rig.hair) {
    rig.hair.visible = !!preset.hair;
    if (preset.hair && rig.hairMat) {
      if (typeof preset.hair === 'number') rig.hairMat.color.setHex(preset.hair);
      else rig.hairMat.color.set(preset.hair);
    }
  }
  if (rig.crown) rig.crown.visible = !!preset.crown;
  if (rig.glasses) rig.glasses.visible = !!preset.glasses;
  if (rig.backpack) rig.backpack.visible = !!preset.backpack;
  if (rig.sword) rig.sword.visible = !!preset.sword;
  if (rig.halo) rig.halo.visible = isAngel || !!preset.halo;
  if (rig.haloAura) rig.haloAura.visible = isAngel || !!preset.halo;
  if (rig.coil) rig.coil.visible = !!preset.coil;
  if (rig.wings) rig.wings.visible = isAngel || !!preset.wings;
}

export function syncRigAppearanceFromPreset(rig, preset = {}, isAngel = false) {
  if (!rig || !preset) return;
  const cHead = isAngel ? 0xfff3d6 : (preset.head ?? 0xf5cd30);
  const cTorso = isAngel ? 0xffffff : (preset.torso ?? 0x00a2ff);
  const cArmL = isAngel ? 0xfff3d6 : (preset.armL ?? cHead);
  const cArmR = isAngel ? 0xfff3d6 : (preset.armR ?? cHead);
  const cLegL = isAngel ? 0xf4d068 : (preset.legL ?? (preset.legs ?? 0x2ecc71));
  const cLegR = isAngel ? 0xf4d068 : (preset.legR ?? (preset.legs ?? 0x2ecc71));

  if (rig.mHead) { rig.mHead.color.set(cHead); rig.mHead.userData.baseColor = rig.mHead.color.getHex(); }
  if (rig.mTorso) { rig.mTorso.color.set(cTorso); rig.mTorso.userData.baseColor = rig.mTorso.color.getHex(); }
  if (rig.mArmL) { rig.mArmL.color.set(cArmL); rig.mArmL.userData.baseColor = rig.mArmL.color.getHex(); }
  if (rig.mArmR) { rig.mArmR.color.set(cArmR); rig.mArmR.userData.baseColor = rig.mArmR.color.getHex(); }
  if (rig.mLegL) { rig.mLegL.color.set(cLegL); rig.mLegL.userData.baseColor = rig.mLegL.color.getHex(); }
  if (rig.mLegR) { rig.mLegR.color.set(cLegR); rig.mLegR.userData.baseColor = rig.mLegR.color.getHex(); }

  syncBuiltinCosmetics(rig, preset, isAngel);

  const limbTex = preset.limbTex || {};
  if (rig.head) setMeshFrontSprite(rig.head, preset.faceDataURL || limbTex.head || defaultFaceURL);
  if (rig.torso) setMeshFrontSprite(rig.torso, limbTex.torso || null);
  if (rig.armL) setMeshFrontSprite(rig.armL, limbTex.armL || null);
  if (rig.armR) setMeshFrontSprite(rig.armR, limbTex.armR || null);
  if (rig.legL) setMeshFrontSprite(rig.legL, limbTex.legL || null);
  if (rig.legR) setMeshFrontSprite(rig.legR, limbTex.legR || null);
}

// Подсчитывает количество активных (включённых) предметов в указанном слоте у сущности
export function countActiveItemsInSlot(ent, slotName, ignoreCustomItem = null, ignoreBuiltinKey = null) {
  if (!ent) return 0;
  let count = 0;

  if (ent.rig) {
    for (const [bKey, bSlot] of Object.entries(BUILTIN_COS_SLOT)) {
      if (bSlot !== slotName || bKey === ignoreBuiltinKey) continue;
      const obj = bKey === 'hat' ? ent.rig.hatGroup : ent.rig[bKey];
      if (obj && obj.visible) count++;
    }
  }

  const customList = (ent.preset && ent.preset.customCosmetics) || [];
  for (const c of customList) {
    if (!c || c === ignoreCustomItem) continue;
    normalizeCosmeticItem(c);
    if (c.parentSlot === slotName && c.enabled !== false) {
      count++;
    }
  }
  return count;
}

const _tmpBoxCorner = new THREE.Vector3();

// ЗАМЕНИТЬ функцию updateGroupRootHitbox в src/core/CharacterRig.js:
export function updateGroupRootHitbox(rootGroup) {
  if (!rootGroup) return null;
  if (rootGroup.userData && rootGroup.userData.rootHitbox) {
    const oldHb = rootGroup.userData.rootHitbox;
    if (oldHb.parent) oldHb.parent.remove(oldHb);
    delete rootGroup.userData.rootHitbox;
  }
  return null;
}

export function normalizeCosmeticItem(item) {
  if (!item) return null;
  if (!item.parentSlot) item.parentSlot = 'head';
  if (item.enabled === undefined) item.enabled = true;
  if (!item.petBehavior) item.petBehavior = 'orbit';
  if (item.petDistance === undefined) item.petDistance = 2.2;
  if (item.petHeight === undefined) item.petHeight = 1.5;
  if (item.petSpeed === undefined) item.petSpeed = 2.4;

  // Корневая трансформация всего аксессуара целиком (Root Transform)
  item.rootX = Number(item.rootX) || 0;
  item.rootY = Number(item.rootY) || 0;
  item.rootZ = Number(item.rootZ) || 0;
  item.rootRX = Number(item.rootRX) || 0;
  item.rootRY = Number(item.rootRY) || 0;
  item.rootRZ = Number(item.rootRZ) || 0;
  item.rootSX = Math.max(0.1, Number(item.rootSX) || 1);
  item.rootSY = Math.max(0.1, Number(item.rootSY) || 1);
  item.rootSZ = Math.max(0.1, Number(item.rootSZ) || 1);

  if (!Array.isArray(item.parts) || item.parts.length === 0) {
    item.parts = [
      {
        id: 'pt_' + Date.now() + '_0',
        name: 'Примитив #1',
        shape: item.shape || 'box',
        x: item.x || 0,
        y: item.y !== undefined ? item.y : (item.parentSlot === 'pet' ? 0 : 0.55),
        z: item.z || 0,
        rx: item.rx || 0,
        ry: item.ry || 0,
        rz: item.rz || 0,
        sx: item.sx || 0.6,
        sy: item.sy || 0.4,
        sz: item.sz || 0.6,
        color: item.color || '#ffce3a',
        texDataURL: item.texDataURL || null
      }
    ];
  } else if (item.parts.length > MAX_COSMETIC_PARTS) {
    item.parts.length = MAX_COSMETIC_PARTS;
  }
  for (let i = 0; i < item.parts.length; i++) {
    normalizePartEffects(item.parts[i], false, false);
  }
  return item;
}

/* ---------- НОРМАЛИЗАЦИЯ И ШАБЛОНЫ ПРЕДМЕТОВ / ОРУЖИЯ / КОНТЕЙНЕРОВ ---------- */

export function normalizeItemData(item) {
  if (!item) return null;
  if (!item.id) item.id = 'item_' + Date.now() + '_' + Math.floor(Math.random() * 999);
  if (!item.name) item.name = 'Предмет';
  if (!item.icon) item.icon = '🗡️';
  if (!item.holdMode) item.holdMode = 'held';
  if (!item.useType) item.useType = item.holdMode === 'carried' ? 'none' : 'melee';

  // Корневой масштаб и смещение всего предмета целиком (Root Transform)
  item.rootX = Number(item.rootX) || 0;
  item.rootY = Number(item.rootY) || 0;
  item.rootZ = Number(item.rootZ) || 0;
  item.rootRX = Number(item.rootRX) || 0;
  item.rootRY = Number(item.rootRY) || 0;
  item.rootRZ = Number(item.rootRZ) || 0;
  item.rootSX = Math.max(0.1, Number(item.rootSX) || 1);
  item.rootSY = Math.max(0.1, Number(item.rootSY) || 1);
  item.rootSZ = Math.max(0.1, Number(item.rootSZ) || 1);

  if (!item.gripPoint) {
    item.gripPoint = { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 };
  } else {
    item.gripPoint.x = Number(item.gripPoint.x) || 0;
    item.gripPoint.y = Number(item.gripPoint.y) || 0;
    item.gripPoint.z = Number(item.gripPoint.z) || 0;
    item.gripPoint.rx = Number(item.gripPoint.rx) || 0;
    item.gripPoint.ry = Number(item.gripPoint.ry) || 0;
    item.gripPoint.rz = Number(item.gripPoint.rz) || 0;

    // Автоматическая миграция старых дефолтных координат хвата из версий до Этапа 4.4
    if (
      item.holdMode === 'carried' &&
      Math.abs(item.gripPoint.y - 1.25) < 0.01 &&
      Math.abs(item.gripPoint.z - -1.15) < 0.01
    ) {
      item.gripPoint.x = 0;
      item.gripPoint.y = 0;
      item.gripPoint.z = 0;
      item.gripPoint.rx = 0;
      item.gripPoint.ry = 0;
      item.gripPoint.rz = 0;
    } else if (
      item.holdMode === 'held' &&
      (Math.abs(item.gripPoint.y - -0.35) < 0.01 || Math.abs(item.gripPoint.y - -0.32) < 0.01) &&
      item.gripPoint.ry === 0 &&
      item.gripPoint.rz === 0
    ) {
      if (item.useType === 'shield') {
        item.gripPoint = { x: -0.22, y: 0, z: -0.18, rx: 0, ry: 0, rz: 0 };
      } else if (item.useType === 'torch') {
        item.gripPoint = { x: 0, y: 0.15, z: 0, rx: -0.25, ry: 0, rz: 0 };
      } else if (item.useType === 'melee') {
        item.gripPoint = { x: 0, y: 0, z: 0, rx: 0.45, ry: 0, rz: 0 };
      } else if (item.useType === 'ranged' && Math.abs(item.gripPoint.rx - 0.35) < 0.02) {
        item.gripPoint = { x: 0, y: 0.12, z: 0.15, rx: -0.25, ry: 0, rz: 0 };
      } else if (item.useType === 'ranged') {
        item.gripPoint = { x: 0, y: 0.05, z: -0.06, rx: 0, ry: 0, rz: 0 };
      } else {
        item.gripPoint = { x: 0, y: 0.05, z: -0.08, rx: 0, ry: 0, rz: 0 };
      }
    } else if (item.useType === 'shield' && Math.abs(item.gripPoint.x - 0.25) < 0.01) {
      item.gripPoint.x = -0.22;
    }
  }

  // Точка вылета / броска снаряда (Muzzle / Throw Point) в локальных координатах предмета
  if (!item.muzzlePoint) {
    item.muzzlePoint = { x: 0, y: 0.15, z: -0.9 };
  } else {
    item.muzzlePoint.x = Number(item.muzzlePoint.x) || 0;
    item.muzzlePoint.y = Number(item.muzzlePoint.y) || 0;
    item.muzzlePoint.z = Number(item.muzzlePoint.z) ?? -0.8;
  }

  // Прочность и расходование
  if (item.infiniteDurability === undefined) {
    item.infiniteDurability = item.useType !== 'consumable' && item.holdMode !== 'carried';
  }
  if (item.maxDurability === undefined) item.maxDurability = item.useType === 'consumable' ? 1 : 100;
  if (item.durability === undefined) item.durability = item.maxDurability;
  if (item.durabilityCostPerUse === undefined) item.durabilityCostPerUse = item.useType === 'consumable' ? 1 : 10;
  if (item.passiveDecayPerSec === undefined) item.passiveDecayPerSec = 0; // Например, сгорание факела
  if (item.dropOnHit === undefined) item.dropOnHit = item.holdMode === 'carried';
  if (item.fallDamageMult === undefined) item.fallDamageMult = item.holdMode === 'carried' ? 4.5 : 0;

  // Боевые параметры (ближний / дальний / метательный)
  if (item.damage === undefined) item.damage = 30; // Может быть 0 для игрушечного оружия
  if (item.range === undefined) item.range = 4.2;  // Дальность удара мечом
  if (item.radius === undefined) item.radius = 2.0; // Ширина/радиус взмаха
  if (item.knockback === undefined) item.knockback = 9;
  if (item.cooldown === undefined) item.cooldown = 0.4;

  // Параметры стрельбы и метания (баллистика, магазин, прицел)
  if (item.projSpeed === undefined) item.projSpeed = item.useType === 'throwable' ? 24 : 38;
  if (item.minThrowSpeed === undefined) item.minThrowSpeed = 8;
  if (item.maxChargeTime === undefined) item.maxChargeTime = 1.15;
  if (item.maxRange === undefined) item.maxRange = 65;
  if (item.gravityFactor === undefined) {
    item.gravityFactor = item.useType === 'throwable' ? 1.0 : 0.15; // 0 = прямая линия (лазер), 1 = парабола
  }
  if (item.blastRadius === undefined) item.blastRadius = item.useType === 'throwable' ? 3.5 : 0;
  if (item.spread === undefined) item.spread = 0.03; // Разброс (0 = идеальная точность)
  if (item.canAim === undefined) item.canAim = true; // Прицеливание на ПКМ с линией траектории
  if (item.autoFire === undefined) item.autoFire = true;

  // Магазин (для огнестрела/магии) и Стаки (для метательного/расходников)
  if (item.infiniteAmmo === undefined) item.infiniteAmmo = false;
  if (item.magSize === undefined) item.magSize = 12;
  if (item.ammo === undefined) item.ammo = item.magSize;
  if (item.reserveAmmo === undefined) item.reserveAmmo = 36;
  if (item.reloadTime === undefined) item.reloadTime = 1.4;
  if (item.stackCount === undefined) item.stackCount = item.useType === 'throwable' ? 5 : 1;

  // Хилки / Еда / Зелья
  if (item.healAmount === undefined) item.healAmount = 40; // Положительное лечит, отрицательное отнимает HP
  if (item.buffSpeed === undefined) item.buffSpeed = 0;
  if (item.buffJump === undefined) item.buffJump = 0;
  if (item.buffDamage === undefined) item.buffDamage = 0;
  if (item.buffScale === undefined) item.buffScale = 0;

  // Экипировка / Пассивные бонусы (Броня / Каска / Артефакт при удержании)
  if (!item.equipStats) {
    item.equipStats = {
      maxHpBonus: 0,
      armorPct: 0,       // % снижения входящего урона (0..90)
      invulnerable: false,
      damageBonus: 0,
      speedBonus: 0
    };
  }

  // Свечение предмета (Настоящий свет и Псевдо-свет) + Эмиттер частиц предмета
  if (!item.lightData) {
    const isTorch = item.useType === 'torch';
    item.lightData = {
      enabled: isTorch,
      realLight: isTorch,
      pseudoLight: isTorch,
      color: '#ff9f43',
      intensity: 1.8,
      distance: 16
    };
  } else {
    if (item.lightData.realLight === undefined) {
      item.lightData.realLight = !!item.lightData.enabled;
    }
    if (item.lightData.pseudoLight === undefined) {
      item.lightData.pseudoLight = !!item.lightData.enabled;
    }
    item.lightData.enabled = !!(item.lightData.realLight || item.lightData.enabled);
    item.lightData.color = item.lightData.color || '#ff9f43';
    item.lightData.intensity = Number(item.lightData.intensity) || 1.8;
    item.lightData.distance = Number(item.lightData.distance) || 16;
  }

  item.particleData = Object.assign(
    createDefaultPartParticleData(item.lightData.color || '#ff9f43'),
    item.particleData || {}
  );

  // Примитивы самого предмета (до 16 штук)
  if (!Array.isArray(item.parts) || item.parts.length === 0) {
    item.parts = [
      {
        id: 'ipt_1',
        name: 'Основа',
        shape: 'box',
        x: 0, y: 0, z: 0,
        rx: 0, ry: 0, rz: 0,
        sx: 0.4, sy: 0.4, sz: 0.9,
        color: '#56f0ff',
        texDataURL: null
      }
    ];
  } else if (item.parts.length > MAX_ITEM_PARTS) {
    item.parts.length = MAX_ITEM_PARTS;
  }
  for (let i = 0; i < item.parts.length; i++) {
    const isTorchTip = item.useType === 'torch' && i === item.parts.length - 1;
    normalizePartEffects(item.parts[i], isTorchTip, isTorchTip);
  }

  // Примитивы снаряда (до 16 штук) — для огнестрела и метательного оружия
  if (!Array.isArray(item.projectileParts) || item.projectileParts.length === 0) {
    item.projectileParts = [
      {
        id: 'ppt_1',
        name: 'Ядро снаряда',
        shape: 'sphere',
        x: 0, y: 0, z: 0,
        rx: 0, ry: 0, rz: 0,
        sx: 0.45, sy: 0.45, sz: 0.45,
        color: '#ffce3a',
        texDataURL: null,
        pseudoLight: true
      }
    ];
  } else if (item.projectileParts.length > MAX_ITEM_PARTS) {
    item.projectileParts.length = MAX_ITEM_PARTS;
  }
  for (let i = 0; i < item.projectileParts.length; i++) {
    normalizePartEffects(item.projectileParts[i], true, false);
  }

  return item;
}

export function createStarterItemTemplate(presetType = 'sword') {
  const uid = () => 'ipt_' + Math.floor(Math.random() * 999999);

  if (presetType === 'sword') {
    return normalizeItemData({
      name: 'Алмазный Меч',
      icon: '🗡️',
      holdMode: 'held',
      useType: 'melee',
      infiniteDurability: true,
      damage: 35,
      range: 4.4,
      radius: 2.2,
      knockback: 10,
      cooldown: 0.35,
      gripPoint: { x: 0, y: 0, z: 0, rx: 0.45, ry: 0, rz: 0 },
      parts: [
        { id: uid(), name: 'Рукоять', shape: 'cylinder', x: 0, y: 0, z: 0, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.25, sy: 0.65, sz: 0.25, color: '#5c4033' },
        { id: uid(), name: 'Гарда', shape: 'box', x: 0, y: 0, z: -0.22, rx: 0, ry: 0, rz: 0, sx: 0.9, sy: 0.22, sz: 0.18, color: '#ffd700' },
        { id: uid(), name: 'Клинок', shape: 'box', x: 0, y: 0, z: -0.95, rx: 0, ry: 0, rz: 0, sx: 0.28, sy: 0.12, sz: 2.5, color: '#56f0ff' },
        { id: uid(), name: 'Остриё', shape: 'cone', x: 0, y: 0, z: -1.72, rx: -Math.PI / 2, ry: 0, rz: 0, sx: 0.26, sy: 0.45, sz: 0.14, color: '#56f0ff' }
      ]
    });
  }

  if (presetType === 'blaster') {
    return normalizeItemData({
      name: 'Импульсный Бластер',
      icon: '🔫',
      holdMode: 'held',
      useType: 'ranged',
      infiniteDurability: true,
      damage: 25,
      projSpeed: 48,
      maxRange: 85,
      gravityFactor: 0,
      blastRadius: 0,
      spread: 0.004,
      canAim: true,
      autoFire: true,
      cooldown: 0.22,
      magSize: 15,
      ammo: 15,
      reserveAmmo: 60,
      infiniteAmmo: false,
      reloadTime: 1.3,
      gripPoint: { x: 0, y: 0.05, z: -0.06, rx: 0, ry: 0, rz: 0 },
      muzzlePoint: { x: 0, y: 0.18, z: -1.02 },
      parts: [
        { id: uid(), name: 'Рукоять', shape: 'box', x: 0, y: -0.05, z: 0.06, rx: 0.22, ry: 0, rz: 0, sx: 0.32, sy: 0.72, sz: 0.38, color: '#2c3e50' },
        { id: uid(), name: 'Корпус', shape: 'box', x: 0, y: 0.18, z: -0.32, rx: 0, ry: 0, rz: 0, sx: 0.42, sy: 0.45, sz: 1.4, color: '#ecf0f1' },
        { id: uid(), name: 'Энерго-ядро', shape: 'cylinder', x: 0, y: 0.22, z: -0.35, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.48, sy: 0.7, sz: 0.48, color: '#00e676', pseudoLight: true, lightColor: '#00e676', lightIntensity: 1.6 },
        { id: uid(), name: 'Ствол', shape: 'cylinder', x: 0, y: 0.18, z: -0.78, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.25, sy: 0.65, sz: 0.25, color: '#56f0ff' }
      ],
      projectileParts: [
        { id: uid(), name: 'Плазма-заряд', shape: 'cylinder', x: 0, y: 0, z: 0, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.28, sy: 1.1, sz: 0.28, color: '#00ff88', pseudoLight: true, realLight: true, lightColor: '#00ff88', lightDistance: 10 },
        { id: uid(), name: 'Ореол', shape: 'sphere', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.45, sy: 0.45, sz: 0.45, color: '#56f0ff', pseudoLight: true }
      ]
    });
  }

  if (presetType === 'staff') {
    return normalizeItemData({
      name: 'Посох Фаерболов',
      icon: '🪄',
      holdMode: 'held',
      useType: 'ranged',
      infiniteDurability: true,
      damage: 45,
      projSpeed: 28,
      maxRange: 65,
      gravityFactor: 0.35,
      blastRadius: 3.8,
      spread: 0.03,
      canAim: true,
      autoFire: false,
      cooldown: 0.65,
      magSize: 8,
      ammo: 8,
      infiniteAmmo: true,
      gripPoint: { x: 0, y: 0.12, z: 0.15, rx: -0.25, ry: 0, rz: 0 },
      muzzlePoint: { x: 0, y: 0.88, z: -0.52 },
      parts: [
        { id: uid(), name: 'Древко', shape: 'cylinder', x: 0, y: 0.1, z: -0.2, rx: -0.35, ry: 0, rz: 0, sx: 0.22, sy: 2.6, sz: 0.22, color: '#6d4c41' },
        { id: uid(), name: 'Оправа', shape: 'torus', x: 0, y: 0.85, z: -0.45, rx: -0.35, ry: 0, rz: 0, sx: 0.65, sy: 0.65, sz: 0.65, color: '#ffd700' },
        {
          id: uid(),
          name: 'Кристалл Огня',
          shape: 'sphere',
          x: 0, y: 0.85, z: -0.45,
          rx: 0, ry: 0, rz: 0,
          sx: 0.55, sy: 0.55, sz: 0.55,
          color: '#ff3e3e',
          pseudoLight: true,
          realLight: true,
          lightColor: '#ff3e3e',
          lightIntensity: 1.8,
          lightDistance: 12,
          particleData: { enabled: true, preset: 'spark', color: '#ff6b6b', rate: 8, lifetime: 0.9, sizeStart: 0.26, sizeEnd: 0.04, speed: 1.6, spread: 0.8, gravity: 0.5 }
        }
      ],
      projectileParts: [
        {
          id: uid(),
          name: 'Огненное ядро',
          shape: 'sphere',
          x: 0, y: 0, z: 0,
          rx: 0, ry: 0, rz: 0,
          sx: 0.7, sy: 0.7, sz: 0.7,
          color: '#ff3e3e',
          pseudoLight: true,
          realLight: true,
          lightColor: '#ff5252',
          lightDistance: 14,
          particleData: { enabled: true, preset: 'fire', color: '#ff9f43', rate: 16, lifetime: 0.55, sizeStart: 0.36, sizeEnd: 0.05, speed: 1.5, spread: 0.9, gravity: 1.0 }
        },
        { id: uid(), name: 'Хвост пламени', shape: 'cone', x: 0, y: 0, z: 0.35, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.55, sy: 0.9, sz: 0.55, color: '#ffce3a', pseudoLight: true }
      ]
    });
  }

  if (presetType === 'grenade') {
    return normalizeItemData({
      name: 'Импульсная Бомба',
      icon: '💣',
      holdMode: 'held',
      useType: 'throwable',
      infiniteDurability: true,
      damage: 55,
      projSpeed: 26,
      minThrowSpeed: 9,
      maxChargeTime: 1.1,
      gravityFactor: 1.0,
      blastRadius: 4.8,
      spread: 0.02,
      canAim: true,
      stackCount: 5,
      infiniteAmmo: false,
      cooldown: 0.45,
      gripPoint: { x: 0, y: 0.05, z: -0.08, rx: 0, ry: 0, rz: 0 },
      muzzlePoint: { x: 0, y: 0.1, z: -0.45 },
      parts: [
        { id: uid(), name: 'Корпус бомбы', shape: 'sphere', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.65, sy: 0.65, sz: 0.65, color: '#22252a' },
        { id: uid(), name: 'Запал', shape: 'cylinder', x: 0, y: 0.26, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.25, sy: 0.25, sz: 0.25, color: '#ffce3a' },
        {
          id: uid(),
          name: 'Искра',
          shape: 'sphere',
          x: 0, y: 0.38, z: 0,
          rx: 0, ry: 0, rz: 0,
          sx: 0.22, sy: 0.22, sz: 0.22,
          color: '#ff3e3e',
          pseudoLight: true,
          lightColor: '#ffce3a',
          particleData: { enabled: true, preset: 'spark', color: '#ffce3a', rate: 9, lifetime: 0.55, sizeStart: 0.2, sizeEnd: 0.03, speed: 2.0, spread: 1.0, gravity: -1.5 }
        }
      ],
      projectileParts: [
        { id: uid(), name: 'Корпус бомбы', shape: 'sphere', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.65, sy: 0.65, sz: 0.65, color: '#22252a', pseudoLight: false },
        {
          id: uid(),
          name: 'Искра',
          shape: 'sphere',
          x: 0, y: 0.32, z: 0,
          rx: 0, ry: 0, rz: 0,
          sx: 0.28, sy: 0.28, sz: 0.28,
          color: '#ff3e3e',
          pseudoLight: true,
          particleData: { enabled: true, preset: 'spark', color: '#ffce3a', rate: 14, lifetime: 0.5, sizeStart: 0.24, sizeEnd: 0.04, speed: 2.2, spread: 1.1, gravity: -1.5 }
        }
      ]
    });
  }

  if (presetType === 'medkit') {
    return normalizeItemData({
      name: 'Аптечка / Курочка',
      icon: '🍗',
      holdMode: 'held',
      useType: 'consumable',
      infiniteDurability: false,
      maxDurability: 2,
      durability: 2,
      durabilityCostPerUse: 1,
      healAmount: 50,
      buffSpeed: 1.5,
      cooldown: 0.6,
      gripPoint: { x: 0, y: 0.08, z: -0.1, rx: 0, ry: 0, rz: 0 },
      parts: [
        { id: uid(), name: 'Кейс аптечки', shape: 'box', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.95, sy: 0.68, sz: 0.5, color: '#ffffff' },
        { id: uid(), name: 'Крест Верт.', shape: 'box', x: 0, y: 0, z: -0.14, rx: 0, ry: 0, rz: 0, sx: 0.2, sy: 0.45, sz: 0.08, color: '#ff3e3e' },
        { id: uid(), name: 'Крест Гориз.', shape: 'box', x: 0, y: 0, z: -0.14, rx: 0, ry: 0, rz: 0, sx: 0.45, sy: 0.2, sz: 0.08, color: '#ff3e3e' }
      ]
    });
  }

  if (presetType === 'torch') {
    return normalizeItemData({
      name: 'Шахтёрский Факел',
      icon: '🔦',
      holdMode: 'held',
      useType: 'torch',
      infiniteDurability: false,
      maxDurability: 100,
      durability: 100,
      passiveDecayPerSec: 1.5,
      lightData: { enabled: true, realLight: true, pseudoLight: true, color: '#ff9f43', intensity: 2.2, distance: 18 },
      gripPoint: { x: 0, y: 0.15, z: 0, rx: -0.25, ry: 0, rz: 0 },
      parts: [
        { id: uid(), name: 'Рукоять факела', shape: 'cylinder', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.26, sy: 1.4, sz: 0.26, color: '#6d4c41' },
        {
          id: uid(),
          name: 'Пламя',
          shape: 'cone',
          x: 0, y: 0.55, z: 0,
          rx: 0, ry: 0, rz: 0,
          sx: 0.42, sy: 0.65, sz: 0.42,
          color: '#ff9f43',
          pseudoLight: true,
          realLight: true,
          lightColor: '#ff9f43',
          lightIntensity: 2.2,
          lightDistance: 18,
          particleData: { enabled: true, preset: 'fire', color: '#ff9f43', rate: 12, lifetime: 0.85, sizeStart: 0.34, sizeEnd: 0.05, speed: 2.0, dirX: 0, dirY: 1, dirZ: 0, spread: 0.45, gravity: 1.2 }
        }
      ]
    });
  }

  if (presetType === 'shield') {
    return normalizeItemData({
      name: 'Силовой Щит (+Броня)',
      icon: '🛡️',
      holdMode: 'held',
      useType: 'shield',
      infiniteDurability: true,
      equipStats: {
        maxHpBonus: 50,
        armorPct: 50,
        invulnerable: false,
        damageBonus: 10,
        speedBonus: 0
      },
      gripPoint: { x: -0.22, y: 0, z: -0.18, rx: 0, ry: 0, rz: 0 },
      parts: [
        { id: uid(), name: 'Основа щита', shape: 'box', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 1.7, sy: 2.1, sz: 0.22, color: '#2980b9' },
        { id: uid(), name: 'Кромка', shape: 'box', x: 0, y: 0, z: -0.04, rx: 0, ry: 0, rz: 0, sx: 1.35, sy: 1.75, sz: 0.22, color: '#56f0ff' }
      ]
    });
  }

  if (presetType === 'crate') {
    return normalizeItemData({
      name: 'Хрупкий Контейнер (2 руки)',
      icon: '📦',
      holdMode: 'carried',
      useType: 'none',
      infiniteDurability: false,
      maxDurability: 60,
      durability: 60,
      dropOnHit: true,
      fallDamageMult: 5.0,
      gripPoint: { x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0 },
      parts: [
        { id: uid(), name: 'Коробка', shape: 'box', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 2.6, sy: 2.4, sz: 2.6, color: '#d35400' },
        { id: uid(), name: 'Лента X', shape: 'box', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 2.7, sy: 0.45, sz: 2.7, color: '#f39c12' },
        { id: uid(), name: 'Яйцо внутри', shape: 'sphere', x: 0, y: 0.55, z: 0, rx: 0, ry: 0, rz: 0, sx: 1.3, sy: 1.6, sz: 1.3, color: '#00e676' }
      ]
    });
  }

  return normalizeItemData({ name: 'Новый Предмет' });
}

// Сборка 3D-группы предмета или снаряда (с использованием кэша геометрий и материалов!)
export function buildItemGroup(item, opts = {}) {
  normalizeItemData(item);
  const isProjectile = !!opts.isProjectile;
  const showMarkers = !!opts.showMarkers;
  const applyGripOffset = !!opts.applyGripOffset;

  const root = new THREE.Group();
  root.userData.itemData = item;
  root.userData.partMeshes = [];

  const partsHolder = new THREE.Group();
  if (applyGripOffset && !isProjectile && item.gripPoint) {
    root.rotation.set(item.gripPoint.rx || 0, item.gripPoint.ry || 0, item.gripPoint.rz || 0);
    partsHolder.position.set(
      (item.gripPoint.x || 0) + (item.rootX || 0),
      (item.gripPoint.y || 0) + (item.rootY || 0),
      (item.gripPoint.z || 0) + (item.rootZ || 0)
    );
    partsHolder.rotation.set(item.rootRX || 0, item.rootRY || 0, item.rootRZ || 0);
    partsHolder.scale.set(item.rootSX || 1, item.rootSY || 1, item.rootSZ || 1);
  } else if (!isProjectile) {
    partsHolder.position.set(item.rootX || 0, item.rootY || 0, item.rootZ || 0);
    partsHolder.rotation.set(item.rootRX || 0, item.rootRY || 0, item.rootRZ || 0);
    partsHolder.scale.set(item.rootSX || 1, item.rootSY || 1, item.rootSZ || 1);
  }
  root.add(partsHolder);
  root.userData.partsHolder = partsHolder;

  const srcParts = isProjectile ? (item.projectileParts || item.parts) : item.parts;
  const count = Math.min(MAX_ITEM_PARTS, srcParts.length);
  const isTorchOff =
    item.useType === 'torch' &&
    item.lightData &&
    !item.lightData.realLight &&
    !item.lightData.pseudoLight &&
    !item.lightData.enabled;

  for (let i = 0; i < count; i++) {
    const pt = normalizePartEffects(srcParts[i], isProjectile, false);
    const geo = getSharedPrimitiveGeo(pt.shape || 'box');
    const itemHasPseudo = !isProjectile && item.lightData && item.lightData.pseudoLight && i === count - 1;
    const isGlowing = !isTorchOff && (pt.pseudoLight || pt.realLight || itemHasPseudo);
    const isPseudoSource = !isTorchOff && !!(pt.pseudoLight || itemHasPseudo);
    const glowHex = isGlowing ? (pt.lightColor || pt.color || item.lightData?.color || '#ffce3a') : null;
    const rawGlowInt = isGlowing ? (Number(pt.lightIntensity) || Number(item.lightData?.intensity) || 1.4) : 0;
    const glowInt = isPseudoSource
      ? clamp(rawGlowInt * 2.5, 2.0, 7.5)
      : clamp(rawGlowInt * 1.5, 1.2, 5.0);

    let mat;
    if (pt.texDataURL) {
      mat = new THREE.MeshStandardMaterial({
        color: pt.color || '#ffce3a',
        roughness: isPseudoSource ? 0.15 : 0.35,
        metalness: isPseudoSource ? 0.0 : 0.2,
        side: THREE.DoubleSide
      });
      if (isGlowing && glowHex) {
        mat.emissive.set(glowHex);
        mat.emissiveIntensity = glowInt;
      }
    } else {
      mat = getSharedPrimitiveMat(pt.color || '#ffce3a', glowHex, glowInt, isPseudoSource);
    }

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pt.x || 0, pt.y || 0, pt.z || 0);
    mesh.rotation.set(pt.rx || 0, pt.ry || 0, pt.rz || 0);
    mesh.scale.set(pt.sx ?? 1, pt.sy ?? 1, pt.sz ?? 1);
    mesh.castShadow = !isProjectile && !isGlowing;
    mesh.receiveShadow = !isProjectile;
    mesh.userData.noCollider = true;
    mesh.userData.itemPart = pt;
    mesh.userData.effectPart = pt;
    mesh.userData.effectOwnerItem = item;
    mesh.userData.itemPartIdx = i;
    mesh.userData.isProjectilePart = isProjectile;

    if (pt.shape === 'none') {
      mesh.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      if (showMarkers && !isProjectile) {
        const pivHelper = createXRayGripMarkerMesh('#56f0ff', 0.55);
        pivHelper.traverse(o => {
          o.userData.noCollider = true;
          o.userData.itemPart = pt;
          o.userData.itemPartIdx = i;
        });
        mesh.add(pivHelper);
      }
    } else if (pt.shape === 'bbmodel' && pt.bbmodelData) {
      mesh.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
      mesh.castShadow = false;
      const bbmGrp = buildBBModelGroup(pt.bbmodelData, pt.color || '#ffffff');
      if (bbmGrp) {
        bbmGrp.traverse(o => {
          o.userData.noCollider = true;
          o.userData.itemPart = pt;
          o.userData.itemPartIdx = i;
          o.userData.isProjectilePart = isProjectile;
        });
        mesh.add(bbmGrp);
      }
    } else if (pt.texDataURL) {
      setMeshFrontSprite(mesh, pt.texDataURL);
    }

    partsHolder.add(mesh);
    root.userData.partMeshes.push(mesh);

    if (isGlowing && glowHex) {
      const partDim = Math.min(4.5, Math.max(pt.sx ?? 1, pt.sy ?? 1, pt.sz ?? 1));
      const haloScale = clamp(
        isPseudoSource
          ? (partDim * 1.55 + rawGlowInt * 1.0)
          : (partDim * 1.25 + rawGlowInt * 0.75),
        0.6,
        9.0
      );
      const haloOpacity = isPseudoSource
        ? clamp(rawGlowInt * 0.46, 0.35, 0.95)
        : clamp(rawGlowInt * 0.38, 0.25, 0.85);

      const haloSpr = createHaloSprite(glowHex, haloScale, haloOpacity);
      haloSpr.position.set(pt.x || 0, pt.y || 0, pt.z || 0);
      partsHolder.add(haloSpr);
      mesh.userData.haloSprite = haloSpr;
    }
  }

  // Создаём единый корневой коллайдер предмета (Root Hitbox)
  updateGroupRootHitbox(root);

  if (showMarkers && !isProjectile) {
    const gripMarker = createXRayGripMarkerMesh('#00e676', 1.0);
    gripMarker.position.set(
      -(item.gripPoint.x || 0),
      -(item.gripPoint.y || 0),
      -(item.gripPoint.z || 0)
    );
    gripMarker.rotation.set(
      item.gripPoint.rx || 0,
      item.gripPoint.ry || 0,
      item.gripPoint.rz || 0
    );
    gripMarker.userData.isGripMarker = true;
    gripMarker.traverse(o => {
      o.userData.isGripMarker = true;
      o.userData.markerGroup = gripMarker;
    });
    root.add(gripMarker);
    root.userData.gripMarker = gripMarker;

    if (item.useType === 'ranged' || item.useType === 'throwable') {
      const muzzleMarker = createXRayMuzzleMarkerMesh('#ff3e3e', 1.0);
      muzzleMarker.position.set(
        item.muzzlePoint.x || 0,
        item.muzzlePoint.y || 0,
        item.muzzlePoint.z ?? -0.8
      );
      muzzleMarker.userData.isMuzzleMarker = true;
      muzzleMarker.traverse(o => {
        o.userData.isMuzzleMarker = true;
        o.userData.markerGroup = muzzleMarker;
      });
      partsHolder.add(muzzleMarker);
      root.userData.muzzleMarker = muzzleMarker;
    }
  }

  return root;
}

// Создаёт стартового составного питомца (из 4 примитивов), которого можно редактировать до 16 частей
export function createStarterPetItem(index = 1) {
  return {
    id: 'pet_' + Date.now() + '_' + Math.floor(Math.random() * 999),
    name: 'Питомец #' + index,
    parentSlot: 'pet',
    enabled: true,
    petBehavior: 'orbit',
    petDistance: 2.2,
    petHeight: 1.5,
    petSpeed: 2.4,
    parts: [
      {
        id: 'pt_body',
        name: 'Тело',
        shape: 'box',
        x: 0, y: 0, z: 0,
        rx: 0, ry: 0, rz: 0,
        sx: 0.9, sy: 0.85, sz: 0.95,
        color: '#ffce3a',
        texDataURL: defaultFaceURL
      },
      {
        id: 'pt_earL',
        name: 'Левое ушко',
        shape: 'cone',
        x: -0.22, y: 0.36, z: 0,
        rx: 0, ry: 0, rz: 0.2,
        sx: 0.45, sy: 0.5, sz: 0.45,
        color: '#ff9f43',
        texDataURL: null
      },
      {
        id: 'pt_earR',
        name: 'Правое ушко',
        shape: 'cone',
        x: 0.22, y: 0.36, z: 0,
        rx: 0, ry: 0, rz: -0.2,
        sx: 0.45, sy: 0.5, sz: 0.45,
        color: '#ff9f43',
        texDataURL: null
      },
      {
        id: 'pt_tail',
        name: 'Хвостик',
        shape: 'sphere',
        x: 0, y: -0.05, z: -0.32,
        rx: 0, ry: 0, rz: 0,
        sx: 0.4, sy: 0.4, sz: 0.4,
        color: '#ffffff',
        texDataURL: null
      }
    ]
  };
}

export function buildPrimitiveMesh(part, item, partIdx, group) {
  normalizePartEffects(part, false, false);
  const geo = getSharedPrimitiveGeo(part.shape || 'box');
  const isGlowing = !!(part.pseudoLight || part.realLight);
  const isPseudoSource = !!part.pseudoLight;
  const glowHex = isGlowing ? (part.lightColor || part.color || '#ffce3a') : null;
  const rawGlowInt = isGlowing ? (Number(part.lightIntensity) || 1.5) : 0;
  // Псевдо-источники света горят заметно ярче и сочнее (boosted emissive)
  const glowInt = isPseudoSource
    ? clamp(rawGlowInt * 2.5, 2.0, 7.5)
    : clamp(rawGlowInt * 1.5, 1.2, 5.0);

  const mat = new THREE.MeshStandardMaterial({
    color: part.color || '#ffce3a',
    roughness: isPseudoSource ? 0.15 : 0.35,
    metalness: isPseudoSource ? 0.0 : 0.2,
    side: THREE.DoubleSide
  });
  if (isGlowing && glowHex) {
    mat.emissive.set(glowHex);
    mat.emissiveIntensity = glowInt;
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(part.x || 0, part.y || 0, part.z || 0);
  mesh.rotation.set(part.rx || 0, part.ry || 0, part.rz || 0);
  mesh.scale.set(part.sx ?? 1, part.sy ?? 1, part.sz ?? 1);
  mesh.castShadow = !isGlowing;
  mesh.receiveShadow = true;

  // Строго визуальный меш без физического коллайдера
  mesh.userData.noCollider = true;
  mesh.userData.cosmeticItem = item;
  mesh.userData.cosmeticPart = part;
  mesh.userData.effectPart = part;
  mesh.userData.effectOwnerItem = item;
  mesh.userData.cosmeticPartIdx = partIdx;
  mesh.userData.cosmeticGroup = group;

  if (part.shape === 'none') {
    mesh.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    if (S.state === 'edit') {
      const pivHelper = createXRayGripMarkerMesh('#56f0ff', 0.5);
      pivHelper.traverse(o => {
        o.userData.noCollider = true;
        o.userData.cosmeticItem = item;
        o.userData.cosmeticPart = part;
        o.userData.cosmeticPartIdx = partIdx;
        o.userData.cosmeticGroup = group;
      });
      mesh.add(pivHelper);
    }
  } else if (part.shape === 'bbmodel' && part.bbmodelData) {
    mesh.material = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    mesh.castShadow = false;
    const bbmGrp = buildBBModelGroup(part.bbmodelData, part.color || '#ffffff');
    if (bbmGrp) {
      bbmGrp.traverse(o => {
        o.userData.noCollider = true;
        o.userData.cosmeticItem = item;
        o.userData.cosmeticPart = part;
        o.userData.cosmeticPartIdx = partIdx;
        o.userData.cosmeticGroup = group;
      });
      mesh.add(bbmGrp);
    }
  } else if (part.texDataURL) {
    setMeshFrontSprite(mesh, part.texDataURL);
  }

  // Оптический ореол («гало») вокруг светящегося элемента аксессуара/питомца
  if (isGlowing && glowHex && group) {
    const partDim = Math.min(4.5, Math.max(part.sx ?? 1, part.sy ?? 1, part.sz ?? 1));
    const haloScale = clamp(
      isPseudoSource
        ? (partDim * 1.55 + rawGlowInt * 1.0)
        : (partDim * 1.25 + rawGlowInt * 0.75),
      0.6,
      9.0
    );
    const haloOpacity = isPseudoSource
      ? clamp(rawGlowInt * 0.46, 0.35, 0.95)
      : clamp(rawGlowInt * 0.38, 0.25, 0.85);

    const haloSpr = createHaloSprite(glowHex, haloScale, haloOpacity);
    haloSpr.position.set(part.x || 0, part.y || 0, part.z || 0);
    group.add(haloSpr);
    mesh.userData.haloSprite = haloSpr;
  }

  return mesh;
}

export function buildCustomCosmeticGroup(item) {
  normalizeCosmeticItem(item);
  const group = new THREE.Group();
  group.visible = item.enabled !== false;
  group.userData.noCollider = true;
  group.userData.cosmeticItem = item;
  group.userData.partMeshes = [];

  const partsHolder = new THREE.Group();
  partsHolder.position.set(item.rootX || 0, item.rootY || 0, item.rootZ || 0);
  partsHolder.rotation.set(item.rootRX || 0, item.rootRY || 0, item.rootRZ || 0);
  partsHolder.scale.set(item.rootSX || 1, item.rootSY || 1, item.rootSZ || 1);
  group.add(partsHolder);
  group.userData.partsHolder = partsHolder;

  const count = Math.min(MAX_COSMETIC_PARTS, item.parts.length);
  for (let i = 0; i < count; i++) {
    const part = item.parts[i];
    const pMesh = buildPrimitiveMesh(part, item, i, partsHolder);
    pMesh.userData.cosmeticGroup = group;
    partsHolder.add(pMesh);
    group.userData.partMeshes.push(pMesh);
  }

  // Создаём единый корневой коллайдер аксессуара/питомца (Root Hitbox)
  updateGroupRootHitbox(group);

  return group;
}

// Оставляем алиас для обратной совместимости
export const buildCustomCosmeticMesh = buildCustomCosmeticGroup;

export function createRobloxRig(preset, scale = 1, isAngel = false) {
  normalizeCharacterGripPoints(preset);
  const g = new THREE.Group();
  const cHead = isAngel ? 0xfff3d6 : (preset.head ?? 0xf5cd30);
  const cTorso = isAngel ? 0xffffff : (preset.torso ?? 0x00a2ff);
  const cArmL = isAngel ? 0xfff3d6 : (preset.armL ?? cHead);
  const cArmR = isAngel ? 0xfff3d6 : (preset.armR ?? cHead);
  const cLegL = isAngel ? 0xf4d068 : (preset.legL ?? (preset.legs ?? 0x2ecc71));
  const cLegR = isAngel ? 0xf4d068 : (preset.legR ?? (preset.legs ?? 0x2ecc71));

  const limbTex = preset.limbTex || {};
  const mHead = makePartMat(cHead);
  const mTorso = makePartMat(cTorso);
  const mArmL = makePartMat(cArmL);
  const mArmR = makePartMat(cArmR);
  const mLegL = makePartMat(cLegL);
  const mLegR = makePartMat(cLegR);

  // Объёмный невидимый меш для мгновенного и надёжного клика по персонажу на любой дистанции
  const pickBoxGeo = new THREE.BoxGeometry(1.8, 2.45, 0.55);
  const pickBoxMat = new THREE.MeshBasicMaterial({
    transparent: true,
    opacity: 0,
    depthWrite: false,
    colorWrite: false
  });
  const charPickMesh = new THREE.Mesh(pickBoxGeo, pickBoxMat);
  charPickMesh.position.set(0, 1.225, 0);
  charPickMesh.userData.isCharPickMesh = true;
  charPickMesh.userData.isTransparentDefault = true;
  charPickMesh.userData.noCollider = true;
  g.add(charPickMesh);

  // 1. Ноги: пивот в тазобедренном суставе (y = 0.95), геометрия смещена вниз на -0.475
  // В локальном пространстве рига лицо смотрит в +Z, поэтому анатомическая ПРАВАЯ сторона персонажа — это -X, а ЛЕВАЯ — +X.
  const legGeo = new THREE.BoxGeometry(0.46, 0.95, 0.46);
  legGeo.translate(0, R6_PIVOTS.legCenterOffset, 0);
  const legL = new THREE.Mesh(legGeo, mLegL);
  legL.position.set(0.25, R6_PIVOTS.hipY, 0);
  legL.userData.pivotOffsetY = R6_PIVOTS.legCenterOffset;

  const legR = new THREE.Mesh(legGeo, mLegR);
  legR.position.set(-0.25, R6_PIVOTS.hipY, 0);
  legR.userData.pivotOffsetY = R6_PIVOTS.legCenterOffset;
  g.add(legL, legR);

  // 2. Торс: пивот в пояснице (y = 0.95), геометрия смещена вверх на +0.50 (визуальный центр = 1.45)
  const torsoGeo = new THREE.BoxGeometry(0.98, 1.0, 0.48);
  torsoGeo.translate(0, R6_PIVOTS.torsoCenterOffset, 0);
  const torso = new THREE.Mesh(torsoGeo, mTorso);
  torso.position.set(0, R6_PIVOTS.waistY, 0);
  torso.userData.pivotOffsetY = R6_PIVOTS.torsoCenterOffset;
  g.add(torso);

  // 3. Руки: пивот в плечевом суставе (y = 1.83), геометрия смещена вниз на -0.38 (визуальный центр = 1.45)
  // armR (ведущая правая рука) находится справа по взгляду со спины (-0.73 по X в локальных координатах рига)
  const armGeo = new THREE.BoxGeometry(0.44, 0.96, 0.44);
  armGeo.translate(0, R6_PIVOTS.armCenterOffset, 0);
  const armL = new THREE.Mesh(armGeo, mArmL);
  armL.position.set(0.73, R6_PIVOTS.shoulderY, 0);
  armL.userData.pivotOffsetY = R6_PIVOTS.armCenterOffset;

  const armR = new THREE.Mesh(armGeo, mArmR);
  armR.position.set(-0.73, R6_PIVOTS.shoulderY, 0);
  armR.userData.pivotOffsetY = R6_PIVOTS.armCenterOffset;
  g.add(armL, armR);

  // Сокеты для удерживаемых (1 рука) и переносимых (2 руки) предметов
  const handGripSocket = new THREE.Group();
  armR.add(handGripSocket);

  const carrySocket = new THREE.Group();
  g.add(carrySocket);

  // X-Ray маркеры точек хвата персонажа для визуальной настройки в Студии
  const handGripMarker = createXRayGripMarkerMesh('#00e676', 0.85);
  handGripMarker.visible = false;
  handGripMarker.userData.isCharHandGripMarker = true;
  handGripMarker.traverse(o => {
    o.userData.isCharHandGripMarker = true;
    o.userData.markerGroup = handGripMarker;
  });
  armR.add(handGripMarker);

  const carryGripMarker = createXRayGripMarkerMesh('#ff9f43', 1.05);
  carryGripMarker.visible = false;
  carryGripMarker.userData.isCharCarryGripMarker = true;
  carryGripMarker.traverse(o => {
    o.userData.isCharCarryGripMarker = true;
    o.userData.markerGroup = carryGripMarker;
  });
  g.add(carryGripMarker);

  function syncGripSockets(srcPreset = preset) {
    normalizeCharacterGripPoints(srcPreset);
    const hp = srcPreset.handGripPoint;
    const cp = srcPreset.carryGripPoint;

    handGripSocket.position.set(hp.x, hp.y, hp.z);
    handGripSocket.rotation.set(hp.rx, hp.ry, hp.rz);
    handGripMarker.position.set(hp.x, hp.y, hp.z);
    handGripMarker.rotation.set(hp.rx, hp.ry, hp.rz);

    carrySocket.position.set(cp.x, cp.y, cp.z);
    carrySocket.rotation.set(cp.rx, cp.ry, cp.rz);
    carryGripMarker.position.set(cp.x, cp.y, cp.z);
    carryGripMarker.rotation.set(cp.rx, cp.ry, cp.rz);
  }
  syncGripSockets(preset);

  function setGripMarkersVisible(visible) {
    handGripMarker.visible = !!visible;
    carryGripMarker.visible = !!visible;
  }

  // 4. Голова: пивот в основании шеи (y = 1.98), геометрия смещена вверх на +0.34 (визуальный центр = 2.32)
  const headGeo = new THREE.BoxGeometry(0.68, 0.68, 0.68);
  headGeo.translate(0, R6_PIVOTS.headCenterOffset, 0);
  const head = new THREE.Mesh(headGeo, mHead);
  head.position.set(0, R6_PIVOTS.neckY, 0);
  head.userData.pivotOffsetY = R6_PIVOTS.headCenterOffset;
  g.add(head);

  setMeshFrontSprite(head, preset.faceDataURL || limbTex.head || defaultFaceURL);
  if (limbTex.torso) setMeshFrontSprite(torso, limbTex.torso);
  if (limbTex.armL) setMeshFrontSprite(armL, limbTex.armL);
  if (limbTex.armR) setMeshFrontSprite(armR, limbTex.armR);
  if (limbTex.legL) setMeshFrontSprite(legL, limbTex.legL);
  if (limbTex.legR) setMeshFrontSprite(legR, limbTex.legR);

  // Встроенная косметика (скорректирована относительно суставных пивотов)
  const hOff = R6_PIVOTS.headCenterOffset;
  const tOff = R6_PIVOTS.torsoCenterOffset;
  const aOff = R6_PIVOTS.armCenterOffset;

  const hairMat = new THREE.MeshLambertMaterial({ color: preset.hair || 0x7a421d });
  const hair = new THREE.Mesh(new THREE.BoxGeometry(0.76, 0.32, 0.76), hairMat);
  hair.position.set(0, hOff + 0.3, 0);
  hair.visible = !!preset.hair;
  hair.userData.noCollider = true;
  head.add(hair);

  const hatGroup = new THREE.Group();
  const hatMat = new THREE.MeshLambertMaterial({ color: preset.hat || 0x111111 });
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.08, 16), hatMat);
  brim.position.set(0, 0.36, 0);
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.48, 16), hatMat);
  top.position.set(0, 0.62, 0);
  hatGroup.add(brim, top);
  hatGroup.position.set(0, hOff, 0);
  hatGroup.visible = !!preset.hat;
  hatGroup.userData.noCollider = true;
  head.add(hatGroup);

  const crown = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.35, 0.28, 8),
    new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.6, roughness: 0.25 })
  );
  crown.position.set(0, hOff + 0.46, 0);
  crown.visible = !!preset.crown;
  crown.userData.noCollider = true;
  head.add(crown);

  const glasses = new THREE.Mesh(
    new THREE.BoxGeometry(0.74, 0.18, 0.12),
    new THREE.MeshLambertMaterial({ color: 0x111111 })
  );
  glasses.position.set(0, hOff + 0.06, 0.34);
  glasses.visible = !!preset.glasses;
  glasses.userData.noCollider = true;
  head.add(glasses);

  const backpack = new THREE.Mesh(
    new THREE.BoxGeometry(0.68, 0.72, 0.32),
    new THREE.MeshLambertMaterial({ color: 0xe67e22 })
  );
  backpack.position.set(0, tOff + 0.03, -0.38);
  backpack.visible = !!preset.backpack;
  backpack.userData.noCollider = true;
  torso.add(backpack);

  const sword = new THREE.Mesh(
    new THREE.BoxGeometry(0.14, 1.25, 0.06),
    new THREE.MeshStandardMaterial({ color: 0x56f0ff, metalness: 0.7, roughness: 0.2 })
  );
  sword.position.set(0.2, tOff + 0.1, -0.32);
  sword.rotation.z = 0.55;
  sword.visible = !!preset.sword;
  sword.userData.noCollider = true;
  torso.add(sword);

  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(0.45, 0.055, 8, 20),
    new THREE.MeshBasicMaterial({ color: 0xffe64c })
  );
  halo.rotation.x = Math.PI / 2;
  halo.position.set(0, hOff + 0.6, 0);
  halo.visible = isAngel || !!preset.halo;
  halo.userData.noCollider = true;
  head.add(halo);

  const haloAura = createHaloSprite('#ffe64c', 2.35, 0.75);
  haloAura.position.set(0, hOff + 0.6, 0);
  haloAura.visible = halo.visible;
  haloAura.userData.noCollider = true;
  head.add(haloAura);

  const coil = new THREE.Mesh(
    new THREE.TorusGeometry(0.28, 0.06, 8, 16),
    new THREE.MeshBasicMaterial({ color: 0xff3e3e })
  );
  coil.position.set(0, aOff - 0.2, 0);
  coil.visible = !!preset.coil;
  coil.userData.noCollider = true;
  armR.add(coil);

  const wings = new THREE.Group();
  wings.position.set(0, tOff + 0.15, -0.28);
  wings.visible = isAngel || !!preset.wings;
  wings.userData.noCollider = true;
  const wGeo = new THREE.BoxGeometry(0.85, 0.5, 0.1);
  const wMat = new THREE.MeshLambertMaterial({ color: 0xfff7cc, emissive: 0x554400 });
  const wL = new THREE.Mesh(wGeo, wMat);
  wL.position.set(-0.55, 0.1, 0);
  wL.rotation.z = 0.3;
  const wR = new THREE.Mesh(wGeo, wMat);
  wR.position.set(0.55, 0.1, 0);
  wR.rotation.z = -0.3;
  wings.add(wL, wR);
  torso.add(wings);

  const sockets = { head, torso, armL, armR, legL, legR };
  const customCosMeshes = [];
  const petEntries = [];

  function syncCustomCosmetics(list) {
    const prevPetStates = new Map();
    for (const pe of petEntries) {
      if (pe.item && pe.item.id) {
        prevPetStates.set(pe.item.id, {
          worldX: pe.worldX,
          worldY: pe.worldY,
          worldZ: pe.worldZ,
          worldRot: pe.worldRot,
          orbitAngle: pe.orbitAngle,
          followDelayTimer: pe.followDelayTimer
        });
      }
    }

    for (const cm of customCosMeshes) {
      if (cm.parent) cm.parent.remove(cm);
    }
    customCosMeshes.length = 0;
    petEntries.length = 0;
    if (!Array.isArray(list)) return;

    let petCounter = 0;
    for (const item of list) {
      normalizeCosmeticItem(item);
      const cosGroup = buildCustomCosmeticGroup(item);
      cosGroup.visible = item.enabled !== false;

      if (item.parentSlot === 'pet') {
        const dist = Number(item.petDistance) || 2.2;
        const h = Number(item.petHeight) || 1.5;
        cosGroup.position.set(dist, h, 0);
        g.add(cosGroup);

        const saved = prevPetStates.get(item.id);
        petEntries.push({
          item,
          group: cosGroup,
          petIdx: petCounter++,
          worldX: saved ? saved.worldX : null,
          worldY: saved ? saved.worldY : null,
          worldZ: saved ? saved.worldZ : null,
          worldRot: saved ? saved.worldRot : 0,
          orbitAngle: saved ? saved.orbitAngle : null,
          followDelayTimer: saved ? (saved.followDelayTimer || 0) : 0
        });
      } else {
        const parentBone = sockets[item.parentSlot] || head;
        cosGroup.position.set(0, (parentBone.userData && parentBone.userData.pivotOffsetY) || 0, 0);
        parentBone.add(cosGroup);
      }
      customCosMeshes.push(cosGroup);
    }
  }
  if (preset.customCosmetics) syncCustomCosmetics(preset.customCosmetics);

  g.scale.setScalar(scale);
  g.traverse(o => {
    if (o.isMesh && !(o.userData && (o.userData.isFrontSprite || o.userData.noCollider))) {
      o.castShadow = true;
    }
  });

  return {
    g,
    legL,
    legR,
    armL,
    armR,
    head,
    torso,
    sockets,
    handGripSocket,
    carrySocket,
    handGripMarker,
    carryGripMarker,
    syncGripSockets,
    setGripMarkersVisible,
    mHead,
    mTorso,
    mArmL,
    mArmR,
    mLegL,
    mLegR,
    hair,
    hairMat,
    hatGroup,
    hatMat,
    crown,
    glasses,
    backpack,
    sword,
    halo,
    haloAura,
    coil,
    wings,
    customCosMeshes,
    petEntries,
    syncCustomCosmetics,
    syncBuiltinCosmetics: (p = preset) => syncBuiltinCosmetics({ hatGroup, hatMat, hair, hairMat, crown, glasses, backpack, sword, halo, haloAura, coil, wings }, p, isAngel)
  };
}

// Запуск процедурной анимации удара/действия (вместо setTimeout)
// Каталог жестов и эмоций игрока (R6 Emotes)
export const EMOTES_CATALOG = [
  { id: 'yes', icon: '👍', name: 'Согласие', chat: '👍 Да, согласен!', loop: false, duration: 2.3 },
  { id: 'no', icon: '🙅', name: 'Отказ', chat: '🙅 Нет, не пойдёт!', loop: false, duration: 2.3 },
  { id: 'wave', icon: '👋', name: 'Привет!', chat: '👋 Всем привет!', loop: false, duration: 2.4 },
  { id: 'shrug', icon: '🤷', name: 'Не знаю / Что?', chat: '🤷 Без понятия...', loop: false, duration: 2.4 },
  { id: 'sit', icon: '🪑', name: 'Сесть', chat: '🪑 Присел отдохнуть', loop: true, duration: 0 },
  { id: 'lay', icon: '🛌', name: 'Лечь', chat: '🛌 Прилёг почиллить...', loop: true, duration: 0 },
  { id: 'fake_die', icon: '💀', name: 'Умереть понарошку', chat: '💀 *Развалился на детальки*', loop: true, duration: 0 },
  { id: 'dance1', icon: '🕺', name: 'Танец 1', chat: '🕺 /e dance', loop: true, duration: 0 },
  { id: 'dance2', icon: '💃', name: 'Танец 2', chat: '💃 Оп-оп, Казачок!', loop: true, duration: 0 },
  { id: 'dance3', icon: '🪩', name: 'Танец 3', chat: '🪩 Диско-волна!', loop: true, duration: 0 },
  { id: 'clap', icon: '👏', name: 'Хлопать', chat: '👏 Браво! Красавчик!', loop: false, duration: 2.6 },
  { id: 'laugh', icon: '😂', name: 'Смеяться', chat: '😂 АХАХАХ, умора!', loop: false, duration: 2.6 },
  { id: 'dab', icon: '😎', name: 'Дэб', chat: '😎 Эпичный ДЭБ!', loop: false, duration: 1.9 },
  { id: 'cry', icon: '😭', name: 'Плакать', chat: '😭 Ну почему так обидно... Хнык-хнык!', loop: true, duration: 0 },
  { id: 'angry', icon: '😡', name: 'Злиться', chat: '😡 УХ, КАК Я ЗОЛ!! Держите меня!', loop: false, duration: 2.6 }
];

console.log('✅ [DebiX] CharacterRig: обновлённая система R6-жестов загружена');

// Запуск или переключение жеста у персонажа
export function triggerEntityEmote(ent, emoteId) {
  if (!ent) return null;
  const def = EMOTES_CATALOG.find(e => e.id === emoteId);
  if (!def) return null;

  // Повторное нажатие на бесконечный жест (сесть/лечь/танец/развалиться) выключает его
  if (ent.activeEmote === emoteId && def.loop) {
    stopEntityEmote(ent);
    return null;
  }

  ent.activeEmote = def.id;
  ent.emoteTimer = 0;
  ent.emoteDuration = def.loop ? 0 : (def.duration || 2.4);
  ent._emotePosBlendT = 0.45;
  ent._lastClapStep = -1;

  // Случайный разброс деталек для «Умереть понарошку»
  // При rx = ±PI/2 и ry = 0 ось Z вращает деталь строго горизонтально на полу!
  if (emoteId === 'fake_die') {
    const s = () => (Math.random() * 2 - 1);
    ent._ragdollParts = {
      torso: { x: s() * 0.16, y: 0.24, z: -0.15 + s() * 0.15, rx: Math.PI / 2, ry: 0, rz: s() * 0.7 },
      head:  { x: -0.45 + s() * 0.28, y: 0.34, z: 0.82 + s() * 0.2, rx: 0, ry: s() * 1.1, rz: s() * 0.2 },
      armL:  { x: 0.92 + s() * 0.2, y: 0.22, z: 0.28 + s() * 0.22, rx: Math.PI / 2, ry: 0, rz: 0.55 + s() * 0.5 },
      armR:  { x: -0.92 + s() * 0.2, y: 0.22, z: -0.22 + s() * 0.22, rx: -Math.PI / 2, ry: 0, rz: -0.55 + s() * 0.5 },
      legL:  { x: 0.52 + s() * 0.18, y: 0.23, z: -0.88 + s() * 0.18, rx: Math.PI / 2, ry: 0, rz: -0.38 + s() * 0.45 },
      legR:  { x: -0.52 + s() * 0.18, y: 0.23, z: -0.82 + s() * 0.18, rx: -Math.PI / 2, ry: 0, rz: 0.38 + s() * 0.45 }
    };
  }

  return def;
}

export function stopEntityEmote(ent) {
  if (!ent || !ent.activeEmote) return false;
  ent.activeEmote = null;
  ent.emoteTimer = 0;
  ent.emoteDuration = 0;
  ent._emotePosBlendT = 0.42;
  return true;
}

// Запуск процедурной анимации удара/действия
export function triggerEntityAttack(ent, style = 'punch') {
  if (!ent) return;
  if (ent.activeEmote) stopEntityEmote(ent);
  ent.attackAnimDuration = style === 'kick' ? 0.36 : 0.28;
  ent.attackAnimT = ent.attackAnimDuration;
  ent.attackStyle = style;
}

// Единый процедурный аниматор рига R6 с поддержкой удержания 1 рукой, переноски 2 руками, замаха и 12 жестов
export function updateEntityAnimation(ent, dt, opts = {}) {
  if (!ent || !ent.rig) return;
  const rig = ent.rig;

  // ФИЗИЧЕСКИЙ РЭГДОЛЛ R6 (падение, болтающиеся конечности и плавный подъём)
  if (ent.ragdoll && (ent.ragdoll.active || ent.ragdoll.recoverTimer > 0)) {
    const rd = ent.ragdoll;
    const isRec = !rd.active && rd.recoverTimer > 0;
    const blend = 1 - Math.exp(-(isRec ? 14 : 22) * Math.max(0.001, dt));
    const L = rd.limbs;

    // При активном рэгдоле тело вращается целиком (rig.g), а суставы свободно болтаются
    const tTorsoX = isRec ? 0 : (L?.torso?.rx || 0);
    const tTorsoZ = isRec ? 0 : (L?.torso?.rz || 0);
    const tHeadX = isRec ? 0 : (L?.head?.rx || 0);
    const tHeadZ = isRec ? 0 : (L?.head?.rz || 0);
    const tArmLX = isRec ? 0 : (L?.armL?.rx || 0);
    const tArmLZ = isRec ? 0.05 : (L?.armL?.rz || 0.35);
    const tArmRX = isRec ? 0 : (L?.armR?.rx || 0);
    const tArmRZ = isRec ? -0.05 : (L?.armR?.rz || -0.35);
    const tLegLX = isRec ? 0 : (L?.legL?.rx || 0);
    const tLegLZ = isRec ? 0 : (L?.legL?.rz || 0.15);
    const tLegRX = isRec ? 0 : (L?.legR?.rx || 0);
    const tLegRZ = isRec ? 0 : (L?.legR?.rz || -0.15);

    rig.legL.position.set(0.25, R6_PIVOTS.hipY, 0);
    rig.legR.position.set(-0.25, R6_PIVOTS.hipY, 0);
    rig.torso.position.set(0, R6_PIVOTS.waistY, 0);
    rig.armL.position.set(0.73, R6_PIVOTS.shoulderY, 0);
    rig.armR.position.set(-0.73, R6_PIVOTS.shoulderY, 0);
    rig.head.position.set(0, R6_PIVOTS.neckY, 0);

    rig.torso.rotation.x += (tTorsoX - rig.torso.rotation.x) * blend;
    rig.torso.rotation.y += (0 - rig.torso.rotation.y) * blend;
    rig.torso.rotation.z += (tTorsoZ - rig.torso.rotation.z) * blend;

    rig.head.rotation.x += (tHeadX - rig.head.rotation.x) * blend;
    rig.head.rotation.y += (0 - rig.head.rotation.y) * blend;
    rig.head.rotation.z += (tHeadZ - rig.head.rotation.z) * blend;

    rig.armL.rotation.x += (tArmLX - rig.armL.rotation.x) * blend;
    rig.armL.rotation.y += (0 - rig.armL.rotation.y) * blend;
    rig.armL.rotation.z += (tArmLZ - rig.armL.rotation.z) * blend;

    rig.armR.rotation.x += (tArmRX - rig.armR.rotation.x) * blend;
    rig.armR.rotation.y += (0 - rig.armR.rotation.y) * blend;
    rig.armR.rotation.z += (tArmRZ - rig.armR.rotation.z) * blend;

    rig.legL.rotation.x += (tLegLX - rig.legL.rotation.x) * blend;
    rig.legL.rotation.y += (0 - rig.legL.rotation.y) * blend;
    rig.legL.rotation.z += (tLegLZ - rig.legL.rotation.z) * blend;

    rig.legR.rotation.x += (tLegRX - rig.legR.rotation.x) * blend;
    rig.legR.rotation.y += (0 - rig.legR.rotation.y) * blend;
    rig.legR.rotation.z += (tLegRZ - rig.legR.rotation.z) * blend;
    return;
  }
  const moving = !!opts.moving;
  const sprinting = opts.sprinting !== undefined ? !!opts.sprinting : !!ent.sprinting;
  const grounded = opts.grounded !== undefined ? !!opts.grounded : (ent.grounded !== undefined ? !!ent.grounded : true);
  const inLiquid = !!opts.inLiquid;
  const vy = ent.vy || 0;
  const t = (S.time || 0) + (ent.qIdx || 0) * 0.37;

  // Управление таймером и авто-отменой активного жеста
  if (ent.activeEmote) {
    ent.emoteTimer = (ent.emoteTimer || 0) + dt;
    ent._emotePosBlendT = 0.42;
    const isFullBodyEmote = ['sit', 'lay', 'fake_die', 'dance1', 'dance2', 'dance3'].includes(ent.activeEmote);

    if (
      inLiquid ||
      !grounded ||
      (ent.attackAnimT && ent.attackAnimT > 0) ||
      (isFullBodyEmote && moving && ent.emoteTimer > 0.15)
    ) {
      stopEntityEmote(ent);
    } else if (ent.emoteDuration > 0 && ent.emoteTimer >= ent.emoteDuration) {
      stopEntityEmote(ent);
    }
  } else if (ent._emotePosBlendT > 0) {
    ent._emotePosBlendT = Math.max(0, ent._emotePosBlendT - dt);
  }

  const stepPhase = (ent.step || 0) * 1.85;
  const walkSwing = moving ? Math.sin(stepPhase) : 0;
  let walkBounce = moving && grounded && !inLiquid ? Math.abs(Math.cos(stepPhase)) * 0.055 : 0;
  const idleBreath = Math.sin(t * 2.4) * 0.025;

  let legLX = 0, legLY = 0, legLZ = 0;
  let legRX = 0, legRY = 0, legRZ = 0;

  let armLX = 0, armLY = 0, armLZ = 0.04 + Math.abs(idleBreath) * 0.8;
  let armRX = 0, armRY = 0, armRZ = -0.04 - Math.abs(idleBreath) * 0.8;

  let torsoX = idleBreath * 0.35;
  let torsoY = 0;
  let torsoZ = 0;

  let headX = -idleBreath * 0.3;
  let headY = 0;
  let headZ = 0;

  // ВАЖНО: базовые суставные позиции объявляются ДО блока жестов, чтобы не вызывать ReferenceError и не затирать позы!
  let posLegL = { x: 0.25, y: R6_PIVOTS.hipY + walkBounce * 0.4, z: 0 };
  let posLegR = { x: -0.25, y: R6_PIVOTS.hipY + walkBounce * 0.4, z: 0 };
  let posTorso = { x: 0, y: R6_PIVOTS.waistY + walkBounce, z: 0 };
  let shoulderShiftX = 0;
  let shoulderShiftY = 0;
  let shoulderShiftZ = 0;
  let customLimbPositions = false;
  let explicitUpperPositions = null;

  if (inLiquid) {
    const swimPhase = t * 5.2;
    legLX = Math.sin(swimPhase) * 0.55 + 0.2;
    legRX = -Math.sin(swimPhase) * 0.55 + 0.2;
    armLX = Math.cos(swimPhase) * 0.85 - 0.5;
    armRX = -Math.cos(swimPhase) * 0.85 - 0.5;
    armLZ = 0.28;
    armRZ = -0.28;
    torsoX = 0.26;
    headX = -0.2;
  } else if (!grounded) {
    const airFactor = clamp(vy * 0.06, -0.45, 0.45);
    legLX = -0.32 + walkSwing * 0.35;
    legRX = 0.26 - walkSwing * 0.35;
    legLZ = 0.05;
    legRZ = -0.05;

    armLX = -0.42 - airFactor * 0.7;
    armRX = -0.42 - airFactor * 0.7;
    armLZ = 0.26;
    armRZ = -0.26;
    torsoX = -airFactor * 0.22;
    headX = airFactor * 0.18;
  } else if (moving) {
    const sprintSwingMult = sprinting ? 1.28 : 1.0;
    legLX = walkSwing * 0.72 * sprintSwingMult;
    legRX = -walkSwing * 0.72 * sprintSwingMult;

    armLX = -walkSwing * 0.68 * sprintSwingMult;
    armRX = walkSwing * 0.68 * sprintSwingMult;
    armLZ = sprinting ? 0.11 : 0.07;
    armRZ = sprinting ? -0.11 : -0.07;

    torsoX = sprinting ? 0.19 : 0.07;
    torsoY = -walkSwing * (sprinting ? 0.12 : 0.08);
    headX = sprinting ? -0.12 : -0.04;
    headY = walkSwing * 0.05;
  } else {
    armLX = Math.sin(t * 1.7) * 0.035;
    armRX = -Math.sin(t * 1.7) * 0.035;
    headY = Math.sin(t * 1.1) * 0.05;
  }

  // ТИПЫ ПОХОДКИ ПЕРСОНАЖА / NPC: 'normal' | 'monster' | 'levitate'
  const gait = (S.state !== 'edit' && (ent.aiModules?.navigation?.gait || ent.gait)) || 'normal';
  if (!ent.activeEmote && !inLiquid) {
    if (gait === 'monster') {
      if (ent._monsterSideSign === undefined) {
        ent._monsterSideSign = Math.random() < 0.5 ? -1 : 1;
      }
      const sideSign = ent._monsterSideSign;
      const mPhase = stepPhase * 0.78;
      const mSway = moving ? Math.sin(mPhase) : Math.sin(t * 1.6) * 0.35;
      const mBob = moving ? Math.abs(Math.cos(mPhase)) : 0;

      // Тяжёлая шаркающая поступь и усталый наклон корпуса вперёд и набок
      customLimbPositions = true;
      const limpDip = moving ? (mSway > 0 ? -0.05 * mSway : -0.02) : 0;
      posLegL = { x: 0.26, y: R6_PIVOTS.hipY + limpDip, z: 0 };
      posLegR = { x: -0.26, y: R6_PIVOTS.hipY + limpDip, z: 0 };
      posTorso = { x: mSway * 0.05, y: R6_PIVOTS.waistY + limpDip, z: 0 };

      torsoX = 0.22 + mBob * 0.07;
      torsoZ = sideSign * 0.15 + mSway * 0.08;
      torsoY = -mSway * 0.1;

      headX = -0.10 + Math.sin(t * 2.3) * 0.06;
      headZ = sideSign * 0.18 + mSway * 0.06;
      headY = mSway * 0.08;

      // Руки вытянуты ВПЕРЁД перед грудью (отрицательный X в R6!) и плавно качаются вверх-вниз
      shoulderShiftZ = 0.1;
      armLX = -1.42 + (moving ? Math.sin(mPhase) * 0.18 : Math.sin(t * 2.0) * 0.07);
      armRX = -1.48 + (moving ? -Math.sin(mPhase) * 0.18 : Math.cos(t * 2.0) * 0.07);
      armLZ = -0.06 + mSway * 0.05;
      armRZ = 0.06 + mSway * 0.05;

      if (moving) {
        legLX = Math.sin(mPhase) * 0.58;
        legRX = -Math.sin(mPhase) * 0.52;
        legLZ = 0.06;
        legRZ = -0.06;
      }
    } else if (gait === 'levitate') {
      // Плавное парение над землёй: руки слегка отведены назад и в стороны, ноги свободно покачиваются в воздухе
      customLimbPositions = true;
      const hoverWave = Math.sin(t * 2.6);
      const hoverWaveCos = Math.cos(t * 2.6);
      const hoverLift = 0.42 + hoverWave * 0.12;
      const sideDrift = Math.sin(t * 1.4) * 0.06;

      posLegL = { x: 0.25 + sideDrift, y: R6_PIVOTS.hipY + hoverLift, z: 0 };
      posLegR = { x: -0.25 + sideDrift, y: R6_PIVOTS.hipY + hoverLift, z: 0 };
      posTorso = { x: sideDrift, y: R6_PIVOTS.waistY + hoverLift, z: 0 };

      torsoX = moving ? 0.24 + hoverWave * 0.04 : 0.06 + hoverWave * 0.03;
      torsoZ = Math.cos(t * 1.4) * 0.05;
      torsoY = Math.sin(t * 1.2) * 0.05;

      headX = moving ? -0.16 : -0.04 + hoverWaveCos * 0.04;
      headZ = -torsoZ * 0.6;

      // В R6 положительный X отводит руки назад за спину, а armLZ > 0 / armRZ < 0 разводит их в стороны
      armLX = (moving ? 0.52 : 0.32) + hoverWave * 0.12;
      armRX = (moving ? 0.52 : 0.32) - hoverWave * 0.12;
      armLZ = 0.34 + hoverWaveCos * 0.07;
      armRZ = -0.34 - hoverWaveCos * 0.07;

      // Ноги слегка отведены назад и плавно покачиваются в невесомости
      legLX = (moving ? 0.38 : 0.22) + hoverWave * 0.12;
      legRX = (moving ? 0.48 : 0.30) - hoverWave * 0.12;
      legLZ = 0.06;
      legRZ = -0.06;
    }
  }

  const isEditingCharGrip =
    S.state === 'edit' &&
    S.selectedRef &&
    S.selectedRef.kind === 'char' &&
    S.selectedRef.ent === ent &&
    S.selectedRef.editMode;

  // Вычисляем вертикальный угол взгляда (lookPitch): положительный = взгляд вверх, отрицательный = вниз.
  // В локальном пространстве R6 отрицательный rotation.x поднимает голову и руки вверх!
  const rawPitch = ent.isP ? (S.pitch || 0) : (ent.pitch || 0);
  const lookPitch = S.state === 'edit' ? 0 : clamp(rawPitch, -1.05, 0.85);
  const pitchRotX = -lookPitch;

  if (!ent.activeEmote) {
    // Голова плавно наклоняется по взгляду вверх/вниз у всех игроков и ботов
    headX += pitchRotX * 0.65;

    if (isEditingCharGrip === 'carry_grip' || ent.carriedItem) {
      const carryPitch = isEditingCharGrip ? 0 : pitchRotX * 0.55;
      armLX = -1.35 + carryPitch + (isEditingCharGrip ? 0 : Math.sin(t * 3.0) * 0.03);
      armRX = -1.35 + carryPitch + (isEditingCharGrip ? 0 : Math.sin(t * 3.0) * 0.03);
      armLZ = -0.22;
      armRZ = 0.22;
      torsoX = isEditingCharGrip ? 0 : (-0.06 + pitchRotX * 0.22);
    } else if (isEditingCharGrip === 'hand_grip') {
      armRX = -Math.PI / 2;
      armRY = 0;
      armRZ = 0;
      torsoX = 0;
      torsoY = 0;
    } else if (ent.holdPose === 'throw_charge') {
      armRX = -2.35 + pitchRotX * 0.65;
      armRY = -0.22;
      armRZ = -0.18;
      torsoY = 0.25;
      torsoX += pitchRotX * 0.25;
    } else if (ent.holdPose === 'aim') {
      armRX = -Math.PI / 2 + pitchRotX * 0.92;
      armRY = 0;
      armRZ = 0;
      torsoX += pitchRotX * 0.28;
    } else if (ent.holdPose === 'shield') {
      armRX = -Math.PI / 2 + pitchRotX * 0.65;
      armRY = 0.25;
      armRZ = 0;
      torsoX += pitchRotX * 0.18;
    } else if (ent.holdPose === 'tool' || ent.holdPose === 'weapon') {
      armRX = -1.52 + pitchRotX * 0.82 + Math.sin(t * 2.5) * 0.03;
      armRY = 0.03;
      armRZ = -0.02;
      torsoX += pitchRotX * 0.22;
    } else if (!moving) {
      // Даже без предмета в руках лёгкий наклон корпуса передаёт направление взгляда игрока
      torsoX += pitchRotX * 0.14;
    }
  } 

  // ПРОЦЕДУРНАЯ КИНЕМАТИКА 12 ЖЕСТОВ ИГРОКА
  if (ent.activeEmote) {
    const et = ent.emoteTimer || 0;
    const em = ent.activeEmote;
    const dur = ent.emoteDuration || 0;
    const envIn = clamp(et / 0.2, 0, 1);
    const envOut = dur > 0 ? clamp((dur - et) / 0.25, 0, 1) : 1;
    const env = Math.sin(envIn * envOut * (Math.PI / 2));

    if (em === 'yes') {
      // 👍 Согласие: чёткие кивки головой + одобрительный жест правой рукой
      const nod = Math.sin(et * 6.5);
      headX = (0.18 + nod * 0.28) * env;
      headY = 0;
      armRX = (-1.75 + nod * 0.14) * env;
      armRY = 0;
      armRZ = 0.16 * env;
      armLX = -0.15 * env;
      armLZ = 0.12 * env;
      torsoX = (0.05 + nod * 0.05) * env;
      shoulderShiftZ = 0.08 * env;
    } else if (em === 'no') {
      // 🙅 Отказ: мотание головой + отмашка руками перед грудью (строго через ось Z, без выкручивания по Y!)
      const wave = Math.sin(et * 6.8);
      headY = wave * 0.42 * env;
      headX = 0.04 * env;

      shoulderShiftX = -0.1 * env;
      shoulderShiftZ = 0.22 * env;

      armLX = -1.52 * env;
      armRX = -1.34 * env;
      armLY = 0;
      armRY = 0;
      armLZ = (-0.36 + wave * 0.36) * env;
      armRZ = (0.36 + wave * 0.36) * env;
      torsoY = -wave * 0.12 * env;
    } else if (em === 'wave') {
      // 👋 Привет!: высокий взмах правой рукой над головой
      const swing = Math.sin(et * 7.0);
      armRX = -2.82 * env;
      armRY = 0;
      armRZ = (-0.36 + swing * 0.36) * env;
      armLX = 0.08 * env;
      armLZ = 0.14 * env;
      headZ = 0.14 * env;
      headY = Math.sin(et * 3.5) * 0.1 * env;
      torsoZ = 0.06 * env;
    } else if (em === 'shrug') {
      // 🤷 Не знаю / Что?: поднятые плечи и разведённые в стороны руки
      const pulse = Math.sin(et * 4.2) * 0.05;
      shoulderShiftY = 0.14 * env;
      armLX = -0.68 * env;
      armRX = -0.68 * env;
      armLY = 0;
      armRY = 0;
      armLZ = (0.78 + pulse) * env;
      armRZ = -(0.78 + pulse) * env;
      headZ = 0.26 * env;
      headX = -0.08 * env;
      headY = Math.sin(et * 3.2) * 0.12 * env;
      torsoX = -0.06 * env;
    } else if (em === 'clap') {
      // 👏 Хлопать: концы рук сходятся вплотную (X = ±0.21 при толщине 0.44) и соприкасаются перед грудью
      const clapFreq = 7.8;
      const rawSin = Math.abs(Math.sin(et * clapFreq));
      const clapTouch = Math.pow(1 - rawSin, 1.3); // 1.0 — момент касания ладоней, 0.0 — размах

      shoulderShiftX = -0.15 * env;
      shoulderShiftZ = 0.24 * env;

      armLX = (-1.45 + clapTouch * 0.05) * env;
      armRX = (-1.45 + clapTouch * 0.05) * env;
      armLY = 0;
      armRY = 0;
      armLZ = -(0.08 + clapTouch * 0.46) * env;
      armRZ = (0.08 + clapTouch * 0.46) * env;

      headX = (0.05 + clapTouch * 0.08) * env;
      torsoX = (0.03 + clapTouch * 0.04) * env;
    } else if (em === 'laugh') {
      // 😂 Смеяться: живой ритмичный хохот «Ха-ха-ха!» с руками на животе и наклоном корпуса назад
      customLimbPositions = true;
      const ha = Math.pow(Math.abs(Math.sin(et * 5.0)), 1.3);
      const sway = Math.sin(et * 2.5);
      const dip = -ha * 0.05 * env;

      posLegL = { x: 0.25, y: R6_PIVOTS.hipY + dip, z: 0 };
      posLegR = { x: -0.25, y: R6_PIVOTS.hipY + dip, z: 0 };
      posTorso = { x: 0, y: R6_PIVOTS.waistY + dip, z: 0 };

      shoulderShiftY = ha * 0.08 * env;
      shoulderShiftZ = 0.16 * env;

      torsoX = (-0.20 - ha * 0.12) * env;
      torsoZ = sway * 0.06 * env;
      headX = (-0.26 - ha * 0.16) * env;
      headZ = sway * 0.10 * env;

      armLX = (-0.95 - ha * 0.10) * env;
      armRX = (-0.95 - ha * 0.10) * env;
      armLY = 0;
      armRY = 0;
      armLZ = -0.42 * env;
      armRZ = 0.42 * env;
      legLX = ha * 0.08 * env;
      legRX = ha * 0.08 * env;
    } else if (em === 'sit') {
      // 🪑 Сесть: таз опущен точно на землю (y = 0.23), ноги вытянуты вперёд
      customLimbPositions = true;
      const dropY = -0.72;
      posLegL = { x: 0.25, y: R6_PIVOTS.hipY + dropY, z: 0 };
      posLegR = { x: -0.25, y: R6_PIVOTS.hipY + dropY, z: 0 };
      posTorso = { x: 0, y: R6_PIVOTS.waistY + dropY, z: 0 };

      legLX = -Math.PI / 2;
      legRX = -Math.PI / 2;
      legLZ = 0.12;
      legRZ = -0.12;

      armLX = -0.52 + Math.sin(t * 2.0) * 0.03;
      armRX = -0.52 - Math.sin(t * 2.0) * 0.03;
      armLZ = -0.10;
      armRZ = 0.10;
      torsoX = -0.06 + idleBreath * 0.3;
      headX = 0.06 - idleBreath * 0.2;
    } else if (em === 'lay') {
      // 🛌 Лечь: риг ровно лежит на спине на полу, руки сложены на животе
      customLimbPositions = true;
      posTorso = { x: 0, y: 0.24, z: 0 };
      posLegL = { x: 0.25, y: 0.24, z: 0 };
      posLegR = { x: -0.25, y: 0.24, z: 0 };
      explicitUpperPositions = {
        armL: { x: 0.65, y: 0.32, z: -0.82 },
        armR: { x: -0.65, y: 0.32, z: -0.82 },
        head: { x: 0, y: 0.34, z: -1.02 }
      };

      torsoX = -Math.PI / 2;
      legLX = -Math.PI / 2;
      legRX = -Math.PI / 2;
      legLZ = 0.08;
      legRZ = -0.08;

      headX = -Math.PI / 2 + 0.26 + Math.sin(t * 1.8) * 0.03;
      armLX = -Math.PI / 2 - 0.18;
      armRX = -Math.PI / 2 - 0.18;
      armLZ = -0.34;
      armRZ = 0.34;
    } else if (em === 'fake_die') {
      // 💀 Умереть понарошку: все 6 кубиков R6 рассыпаются по полу вокруг игрока
      customLimbPositions = true;
      const scatter = 1 - Math.pow(1 - clamp(et / 0.24, 0, 1), 3);
      const rp = ent._ragdollParts || {
        torso: { x: 0.05, y: 0.24, z: -0.15, rx: Math.PI / 2, ry: 0, rz: 0.35 },
        head:  { x: -0.42, y: 0.34, z: 0.78, rx: 0, ry: -0.6, rz: 0.15 },
        armL:  { x: 0.92, y: 0.22, z: 0.28, rx: Math.PI / 2, ry: 0, rz: 0.6 },
        armR:  { x: -0.92, y: 0.22, z: -0.24, rx: -Math.PI / 2, ry: 0, rz: -0.55 },
        legL:  { x: 0.52, y: 0.23, z: -0.85, rx: Math.PI / 2, ry: 0, rz: -0.35 },
        legR:  { x: -0.52, y: 0.23, z: -0.80, rx: -Math.PI / 2, ry: 0, rz: 0.45 }
      };

      posTorso = {
        x: rp.torso.x * scatter,
        y: R6_PIVOTS.waistY + (rp.torso.y - R6_PIVOTS.waistY) * scatter,
        z: rp.torso.z * scatter
      };
      posLegL = {
        x: 0.25 + (rp.legL.x - 0.25) * scatter,
        y: R6_PIVOTS.hipY + (rp.legL.y - R6_PIVOTS.hipY) * scatter,
        z: rp.legL.z * scatter
      };
      posLegR = {
        x: -0.25 + (rp.legR.x + 0.25) * scatter,
        y: R6_PIVOTS.hipY + (rp.legR.y - R6_PIVOTS.hipY) * scatter,
        z: rp.legR.z * scatter
      };
      explicitUpperPositions = {
        armL: {
          x: 0.73 + (rp.armL.x - 0.73) * scatter,
          y: R6_PIVOTS.shoulderY + (rp.armL.y - R6_PIVOTS.shoulderY) * scatter,
          z: rp.armL.z * scatter
        },
        armR: {
          x: -0.73 + (rp.armR.x + 0.73) * scatter,
          y: R6_PIVOTS.shoulderY + (rp.armR.y - R6_PIVOTS.shoulderY) * scatter,
          z: rp.armR.z * scatter
        },
        head: {
          x: rp.head.x * scatter,
          y: R6_PIVOTS.neckY + (rp.head.y - R6_PIVOTS.neckY) * scatter,
          z: rp.head.z * scatter
        }
      };

      torsoX = rp.torso.rx * scatter; torsoY = rp.torso.ry * scatter; torsoZ = rp.torso.rz * scatter;
      headX = rp.head.rx * scatter;   headY = rp.head.ry * scatter;   headZ = rp.head.rz * scatter;
      armLX = rp.armL.rx * scatter;   armLY = rp.armL.ry * scatter;   armLZ = rp.armL.rz * scatter;
      armRX = rp.armR.rx * scatter;   armRY = rp.armR.ry * scatter;   armRZ = rp.armR.rz * scatter;
      legLX = rp.legL.rx * scatter;   legLY = rp.legL.ry * scatter;   legLZ = rp.legL.rz * scatter;
      legRX = rp.legR.rx * scatter;   legRY = rp.legR.ry * scatter;   legRZ = rp.legR.rz * scatter;
    } else if (em === 'dance1') {
      // 🕺 Танец 1: классический ритмичный Roblox /e dance
      customLimbPositions = true;
      const beat = et * 5.6;
      const s = Math.sin(beat);
      const c = Math.cos(beat);
      const bounce = -Math.abs(Math.cos(beat * 2)) * 0.08;
      const swayX = s * 0.15;

      posLegL = { x: 0.25 + swayX * 0.4, y: R6_PIVOTS.hipY + bounce, z: 0 };
      posLegR = { x: -0.25 + swayX * 0.4, y: R6_PIVOTS.hipY + bounce, z: 0 };
      posTorso = { x: swayX, y: R6_PIVOTS.waistY + bounce, z: 0 };

      torsoZ = -s * 0.14;
      torsoY = c * 0.28;
      torsoX = Math.sin(beat * 2) * 0.06;
      headZ = s * 0.12;
      headY = -c * 0.2;

      armLX = -1.35 + Math.sin(beat * 2) * 0.65;
      armRX = -1.35 - Math.sin(beat * 2) * 0.65;
      armLZ = 0.24 + Math.max(0, s) * 0.45;
      armRZ = -0.24 - Math.max(0, -s) * 0.45;

      legLX = Math.sin(beat * 2) * 0.36;
      legRX = -Math.sin(beat * 2) * 0.36;
      legLZ = Math.max(0, s) * 0.25;
      legRZ = -Math.max(0, -s) * 0.25;
    } else if (em === 'dance2') {
      // 💃 Танец 2: присядка «Казачок» со сложенными на груди руками и выбросом ног вперёд
      customLimbPositions = true;
      const kBeat = et * 6.4;
      const s = Math.sin(kBeat);
      const squat = -0.36 + Math.abs(Math.cos(kBeat)) * 0.15;

      posLegL = { x: 0.25, y: R6_PIVOTS.hipY + squat, z: 0 };
      posLegR = { x: -0.25, y: R6_PIVOTS.hipY + squat, z: 0 };
      posTorso = { x: s * 0.06, y: R6_PIVOTS.waistY + squat, z: 0 };

      const kickL = Math.max(0, s);
      const kickR = Math.max(0, -s);

      legLX = -1.42 * kickL + 0.52 * kickR;
      legRX = -1.42 * kickR + 0.52 * kickL;
      legLZ = 0.16 * kickL;
      legRZ = -0.16 * kickR;

      shoulderShiftX = -0.12;
      shoulderShiftZ = 0.22;
      armLX = -1.50;
      armRX = -1.36;
      armLY = 0;
      armRY = 0;
      armLZ = -0.56;
      armRZ = 0.56;

      torsoX = -0.12;
      torsoZ = -s * 0.12;
      headZ = s * 0.14;
      headX = 0.12;
    } else if (em === 'dance3') {
      // 🪩 Танец 3: диско-волна руками и корпусом
      customLimbPositions = true;
      const dBeat = et * 5.2;
      const s = Math.sin(dBeat);
      const c = Math.cos(dBeat);
      const dip = -Math.abs(Math.cos(dBeat * 2)) * 0.09;

      posLegL = { x: 0.25 + s * 0.05, y: R6_PIVOTS.hipY + dip, z: 0 };
      posLegR = { x: -0.25 + s * 0.05, y: R6_PIVOTS.hipY + dip, z: 0 };
      posTorso = { x: s * 0.14, y: R6_PIVOTS.waistY + dip, z: 0 };

      torsoZ = -s * 0.2;
      torsoY = c * 0.32;
      torsoX = Math.sin(dBeat * 2) * 0.07;
      headZ = s * 0.16;
      headY = -c * 0.22;

      armRX = -2.42 + s * 0.72;
      armRZ = -0.42 + s * 0.52;
      armLX = -1.15 - s * 0.72;
      armLZ = 0.42 + s * 0.42;

      legLZ = Math.max(0, s) * 0.32;
      legRZ = -Math.max(0, -s) * 0.32;
      legLX = c * 0.26;
      legRX = -c * 0.26;
    } else if (em === 'dab') {
      // 😎 Дэб: голова опущена в сгиб согнутой перед лицом левой руки, правая рука резко вытянута в сторону и вверх
      const snap = Math.pow(env, 0.45);
      headX = 0.52 * snap;
      headY = -0.45 * snap;
      headZ = -0.22 * snap;

      torsoX = 0.18 * snap;
      torsoY = -0.25 * snap;
      torsoZ = -0.18 * snap;

      shoulderShiftX = -0.08 * snap;
      shoulderShiftZ = 0.18 * snap;

      // Левая рука согнута перед лицом
      armLX = -1.75 * snap;
      armLY = -0.35 * snap;
      armLZ = -0.82 * snap;

      // Правая рука вытянута по диагонали вправо-вверх
      armRX = -2.25 * snap;
      armRY = 0.25 * snap;
      armRZ = -0.95 * snap;
    } else if (em === 'cry') {
      // 😭 Плакать: обе ладони закрывают лицо, плечи и голова дрожат от всхлипываний
      const sob = Math.abs(Math.sin(et * 8.5));
      const sway = Math.sin(et * 2.8);

      shoulderShiftX = -0.16 * env;
      shoulderShiftY = sob * 0.08 * env;
      shoulderShiftZ = 0.24 * env;

      headX = (0.38 + sob * 0.12) * env;
      headZ = sway * 0.08 * env;
      torsoX = (0.16 + sob * 0.05) * env;
      torsoZ = sway * 0.05 * env;

      armLX = (-2.05 - sob * 0.08) * env;
      armRX = (-2.05 - sob * 0.08) * env;
      armLZ = -0.48 * env;
      armRZ = 0.48 * env;
    } else if (em === 'angry') {
      // 😡 Злиться: сжатые кулаки трясутся по бокам, корпус напряжён, ноги притоптывают от ярости
      customLimbPositions = true;
      const stompPhase = et * 11.0;
      const stompL = Math.max(0, Math.sin(stompPhase));
      const stompR = Math.max(0, -Math.sin(stompPhase));
      const rageShake = Math.sin(et * 26.0);

      posLegL = { x: 0.27, y: R6_PIVOTS.hipY + stompL * 0.12 * env, z: 0 };
      posLegR = { x: -0.27, y: R6_PIVOTS.hipY + stompR * 0.12 * env, z: 0 };
      posTorso = { x: rageShake * 0.02 * env, y: R6_PIVOTS.waistY - 0.04 * env, z: 0 };

      torsoX = 0.24 * env;
      headX = (0.18 + Math.abs(rageShake) * 0.06) * env;
      headY = rageShake * 0.08 * env;

      shoulderShiftY = 0.08 * env;
      armLX = (-1.15 + rageShake * 0.12) * env;
      armRX = (-1.15 - rageShake * 0.12) * env;
      armLZ = 0.36 * env;
      armRZ = -0.36 * env;

      legLX = -stompL * 0.42 * env;
      legRX = -stompR * 0.42 * env;
    }
  }

  // Анимация удара/выстрела от плечевого сустава (если походка 'monster' — удар двумя руками сразу!)
  if (ent.attackAnimT && ent.attackAnimT > 0) {
    ent.attackAnimT = Math.max(0, ent.attackAnimT - dt);
    const dur = ent.attackAnimDuration || 0.28;
    const p = 1 - ent.attackAnimT / dur;
    const strikeCurve = Math.sin(Math.pow(p, 0.65) * Math.PI);

    if (ent.attackStyle === 'kick') {
      // Мощный пинок правой ногой вперёд в стиле Dark Messiah
      const kickCurve = Math.sin(Math.pow(p, 0.52) * Math.PI);
      legRX = -1.68 * kickCurve;
      legRZ = -0.08 * kickCurve;
      legLX = 0.22 * kickCurve;
      torsoX = -0.26 * kickCurve;
      torsoY = 0.22 * kickCurve;
      headX = 0.16 * kickCurve;
      armLX = 0.55 * kickCurve;
      armLZ = 0.48 * kickCurve;
      armRX = 0.42 * kickCurve;
      armRZ = -0.45 * kickCurve;
    } else if (ent.attackStyle === 'shoot') {
      armRX = -1.55 - 0.28 * strikeCurve;
      torsoX -= 0.06 * strikeCurve;
    } else if (gait === 'monster') {
      // Двуручный сокрушающий удар монстра сверху вниз!
      armLX = -1.42 - 0.95 * strikeCurve;
      armRX = -1.48 - 0.95 * strikeCurve;
      armLZ = -0.24 * strikeCurve;
      armRZ = 0.24 * strikeCurve;
      torsoX += 0.34 * strikeCurve;
      headX += 0.18 * strikeCurve;
    } else {
      armRX = -1.95 * strikeCurve;
      armRY = 0.32 * strikeCurve;
      armRZ = -0.18 * strikeCurve;
      torsoY -= 0.28 * strikeCurve;
      torsoX += 0.12 * strikeCurve;
    }
  }

  // Анимация оглушения (Стан): покачивание корпуса и кружение головы
  if ((ent.stunTimer || 0) > 0 && !ent.activeEmote) {
    const dizzy = t * 7.5;
    torsoX += 0.14 + Math.sin(dizzy * 0.5) * 0.06;
    torsoZ += Math.cos(dizzy) * 0.11;
    headX += 0.12 + Math.sin(dizzy) * 0.18;
    headY += Math.cos(dizzy) * 0.24;
    headZ += Math.sin(dizzy * 0.8) * 0.2;
    armLX += -0.35 + Math.sin(dizzy) * 0.12;
    armRX += -0.35 - Math.sin(dizzy) * 0.12;
    armLZ += 0.28;
    armRZ -= 0.28;
  }

  // Анимация пошатывания (Stagger), если удар/пинок не сбил персонажа в рэгдолл
  if (ent.stagger && ent.stagger.timer > 0) {
    ent.stagger.timer = Math.max(0, ent.stagger.timer - dt);
    const dur = Math.max(0.1, ent.stagger.duration || 0.45);
    const p = 1 - ent.stagger.timer / dur; // 0 -> 1
    // Резкий откат назад и плавный возврат равновесия с лёгкой отдачей
    const wave = Math.sin(p * Math.PI) * Math.pow(1 - p, 0.35) * (ent.stagger.strength || 1.0);

    const rot = ent.rot || 0;
    const dx = ent.stagger.dirX || 0;
    const dz = ent.stagger.dirZ || 0;
    const localFwd = dx * Math.sin(rot) + dz * Math.cos(rot);   // +1 толчок вперёд (в спину), -1 назад (в грудь)
    const localLeft = dx * Math.cos(rot) - dz * Math.sin(rot);  // +1 толчок влево, -1 вправо

    torsoX += localFwd * 0.48 * wave;
    torsoZ += -localLeft * 0.42 * wave;
    headX += -localFwd * 0.32 * wave;
    headZ += localLeft * 0.28 * wave;
    armLX += (-0.65 + localFwd * 0.25) * wave;
    armRX += (-0.65 + localFwd * 0.25) * wave;
    armLZ += 0.45 * wave;
    armRZ += -0.45 * wave;

    if (ent.stagger.timer <= 0) {
      ent.stagger = null;
    }
  }

  const blend = 1 - Math.exp(-18 * Math.max(0.001, dt));

  const transformTorsoOffset = (ox, oy, oz) => {
    const cz = Math.cos(torsoZ), sz = Math.sin(torsoZ);
    const x1 = ox * cz - oy * sz;
    const y1 = ox * sz + oy * cz;
    const z1 = oz;

    const cy = Math.cos(torsoY), sy = Math.sin(torsoY);
    const x2 = x1 * cy + z1 * sy;
    const y2 = y1;
    const z2 = -x1 * sy + z1 * cy;

    const cx = Math.cos(torsoX), sx = Math.sin(torsoX);
    const x3 = x2;
    const y3 = y2 * cx - z2 * sx;
    const z3 = y2 * sx + z2 * cx;

    return {
      x: posTorso.x + x3,
      y: posTorso.y + y3,
      z: posTorso.z + z3
    };
  };

  let posArmL, posArmR, posHead;
  if (explicitUpperPositions) {
    posArmL = explicitUpperPositions.armL;
    posArmR = explicitUpperPositions.armR;
    posHead = explicitUpperPositions.head;
  } else {
    const shoulderRelY = (R6_PIVOTS.shoulderY - R6_PIVOTS.waistY) + shoulderShiftY + idleBreath * 0.5;
    const neckRelY = R6_PIVOTS.neckY - R6_PIVOTS.waistY;
    posArmL = transformTorsoOffset(0.73 + shoulderShiftX, shoulderRelY, shoulderShiftZ);
    posArmR = transformTorsoOffset(-0.73 - shoulderShiftX, shoulderRelY, shoulderShiftZ);
    posHead = transformTorsoOffset(0, neckRelY, 0);
  }

  if (customLimbPositions || ent.activeEmote || ent._emotePosBlendT > 0) {
    const pBlend = 1 - Math.exp(-15 * Math.max(0.001, dt));
    const lerpPos = (mesh, target) => {
      mesh.position.x += (target.x - mesh.position.x) * pBlend;
      mesh.position.y += (target.y - mesh.position.y) * pBlend;
      mesh.position.z += (target.z - mesh.position.z) * pBlend;
    };
    lerpPos(rig.legL, posLegL);
    lerpPos(rig.legR, posLegR);
    lerpPos(rig.torso, posTorso);
    lerpPos(rig.armL, posArmL);
    lerpPos(rig.armR, posArmR);
    lerpPos(rig.head, posHead);
  } else {
    rig.legL.position.set(posLegL.x, posLegL.y, posLegL.z);
    rig.legR.position.set(posLegR.x, posLegR.y, posLegR.z);
    rig.torso.position.set(posTorso.x, posTorso.y, posTorso.z);
    rig.armL.position.set(posArmL.x, posArmL.y, posArmL.z);
    rig.armR.position.set(posArmR.x, posArmR.y, posArmR.z);
    rig.head.position.set(posHead.x, posHead.y, posHead.z);
  }

  rig.legL.rotation.x += (legLX - rig.legL.rotation.x) * blend;
  rig.legL.rotation.y += (legLY - rig.legL.rotation.y) * blend;
  rig.legL.rotation.z += (legLZ - rig.legL.rotation.z) * blend;

  rig.legR.rotation.x += (legRX - rig.legR.rotation.x) * blend;
  rig.legR.rotation.y += (legRY - rig.legR.rotation.y) * blend;
  rig.legR.rotation.z += (legRZ - rig.legR.rotation.z) * blend;

  rig.armL.rotation.x += (armLX - rig.armL.rotation.x) * blend;
  rig.armL.rotation.y += (armLY - rig.armL.rotation.y) * blend;
  rig.armL.rotation.z += (armLZ - rig.armL.rotation.z) * blend;

  rig.armR.rotation.x += (armRX - rig.armR.rotation.x) * blend;
  rig.armR.rotation.y += (armRY - rig.armR.rotation.y) * blend;
  rig.armR.rotation.z += (armRZ - rig.armR.rotation.z) * blend;

  rig.torso.rotation.x += (torsoX - rig.torso.rotation.x) * blend;
  rig.torso.rotation.y += (torsoY - rig.torso.rotation.y) * blend;
  rig.torso.rotation.z += (torsoZ - rig.torso.rotation.z) * blend;

  rig.head.rotation.x += (headX - rig.head.rotation.x) * blend;
  rig.head.rotation.y += (headY - rig.head.rotation.y) * blend;
  rig.head.rotation.z += (headZ - rig.head.rotation.z) * blend;
}
function updateEntityPets(ent, dt) {
  if (!ent || !ent.rig || !ent.rig.petEntries || ent.rig.petEntries.length === 0) return;
  if (ent.isDisabled || ent._deadCooldown > 0 || ent._permanentlyDead) {
    for (const pe of ent.rig.petEntries) {
      if (pe.group) pe.group.visible = false;
    }
    return;
  }

  const activeEntries = ent.rig.petEntries.filter(pe => {
    const isOn = pe.item.enabled !== false;
    pe.group.visible = isOn;
    return isOn;
  });
  const totalPets = activeEntries.length;
  if (totalPets === 0) return;

  const sc = Math.max(0.1, ent.rig.g.scale.x || 1);
  const ownerX = ent.rig.g.position.x;
  const ownerY = ent.rig.g.position.y;
  const ownerZ = ent.rig.g.position.z;
  const ownerRot = ent.rig.g.rotation.y || ent.rot || 0;

  const animClock = performance.now() * 0.001;

  for (let i = 0; i < totalPets; i++) {
    const entry = activeEntries[i];
    const { item, group } = entry;
    const dist = Math.max(0.8, Number(item.petDistance) ?? 2.2);
    const height = Number(item.petHeight) ?? 1.5;
    const speed = Math.max(0.2, Number(item.petSpeed) ?? 2.4);

    if (
      S.state === 'edit' &&
      S.selectedRef &&
      S.selectedRef.kind === 'cosmetic' &&
      S.selectedRef.item === item
    ) {
      group.position.set(dist / sc, height / sc, 0);
      group.rotation.set(0, 0, 0);
      entry.worldX = null;
      continue;
    }

    const bob = Math.sin(animClock * 3.8 + i * 1.9) * 0.14;
    let wx, wy, wz, wRot;

    if (item.petBehavior === 'follow') {
      const targetY = ownerY + height + bob;

      if (entry.worldX === null || Math.hypot(ownerX - entry.worldX, ownerZ - entry.worldZ) > 35) {
        const initAng = ownerRot + Math.PI + (i === 0 ? -0.35 : 0.35);
        entry.worldX = ownerX + Math.sin(initAng) * dist;
        entry.worldY = targetY;
        entry.worldZ = ownerZ + Math.cos(initAng) * dist;
        entry.worldRot = Math.atan2(ownerX - entry.worldX, ownerZ - entry.worldZ);
        entry.followDelayTimer = 0;
      } else {
        const dxToOwner = ownerX - entry.worldX;
        const dzToOwner = ownerZ - entry.worldZ;
        const distToOwner = Math.hypot(dxToOwner, dzToOwner);

        if (distToOwner > dist + 0.12) {
          if (entry.followDelayTimer <= 0) {
            entry.followDelayTimer = 0.18;
          }
          if (entry.followDelayTimer > 0.01) {
            entry.followDelayTimer = Math.max(0.01, entry.followDelayTimer - dt);
          } else {
            const dirX = dxToOwner / distToOwner;
            const dirZ = dzToOwner / distToOwner;

            let goalX = ownerX - dirX * dist;
            let goalZ = ownerZ - dirZ * dist;

            if (totalPets > 1) {
              const other = activeEntries[(i + 1) % totalPets];
              if (other && other !== entry && other.worldX !== null) {
                const sepX = entry.worldX - other.worldX;
                const sepZ = entry.worldZ - other.worldZ;
                const sepD = Math.hypot(sepX, sepZ);
                if (sepD < 1.15 && sepD > 0.001) {
                  goalX += (sepX / sepD) * (1.15 - sepD) * 0.85;
                  goalZ += (sepZ / sepD) * (1.15 - sepD) * 0.85;
                }
              }
            }

            const moveDx = goalX - entry.worldX;
            const moveDz = goalZ - entry.worldZ;
            const moveDist = Math.hypot(moveDx, moveDz);

            const followRate = speed * (moveDist > 0.8 ? 2.1 : 1.35);
            const alphaXZ = 1 - Math.exp(-followRate * dt);
            entry.worldX += moveDx * alphaXZ;
            entry.worldZ += moveDz * alphaXZ;

            if (moveDist > 0.04) {
              const desiredRot = Math.atan2(dxToOwner, dzToOwner);
              entry.worldRot = lerpAngle(entry.worldRot, desiredRot, 1 - Math.exp(-8.5 * dt));
            }
          }
        } else {
          entry.followDelayTimer = 0;

          const minPersonalSpace = Math.min(dist * 0.55, 0.95);
          if (distToOwner < minPersonalSpace && distToOwner > 0.001) {
            const push = (minPersonalSpace - distToOwner) * (1 - Math.exp(-6.0 * dt));
            entry.worldX -= (dxToOwner / distToOwner) * push;
            entry.worldZ -= (dzToOwner / distToOwner) * push;
          }
        }

        const alphaY = 1 - Math.exp(-6.5 * dt);
        entry.worldY += (targetY - entry.worldY) * alphaY;
      }

      wx = entry.worldX;
      wy = entry.worldY;
      wz = entry.worldZ;
      wRot = entry.worldRot;
    } else {
      const phase = (i * TAU) / Math.max(1, totalPets);
      if (entry.orbitAngle === null || entry.orbitAngle === undefined) {
        entry.orbitAngle = phase;
      }
      entry.orbitAngle = (entry.orbitAngle + dt * speed) % TAU;
      const ang = entry.orbitAngle;

      const targetX = ownerX + Math.cos(ang) * dist;
      const targetZ = ownerZ + Math.sin(ang) * dist;
      const targetY = ownerY + height + bob;
      const tangentRot = Math.atan2(-Math.sin(ang), Math.cos(ang));

      if (entry.worldX === null || Math.hypot(targetX - entry.worldX, targetZ - entry.worldZ) > 35) {
        entry.worldX = targetX;
        entry.worldY = targetY;
        entry.worldZ = targetZ;
        entry.worldRot = tangentRot;
      } else {
        const alphaOrbit = 1 - Math.exp(-12.0 * dt);
        entry.worldX += (targetX - entry.worldX) * alphaOrbit;
        entry.worldZ += (targetZ - entry.worldZ) * alphaOrbit;
        entry.worldY += (targetY - entry.worldY) * (1 - Math.exp(-7.0 * dt));
        entry.worldRot = tangentRot;
      }

      wx = entry.worldX;
      wy = entry.worldY;
      wz = entry.worldZ;
      wRot = entry.worldRot;
    }

    const ldx = (wx - ownerX) / sc;
    const ldy = (wy - ownerY) / sc;
    const ldz = (wz - ownerZ) / sc;
    const cos = Math.cos(-ownerRot);
    const sin = Math.sin(-ownerRot);

    group.position.set(ldx * cos - ldz * sin, ldy, ldx * sin + ldz * cos);
    group.rotation.set(0, wRot - ownerRot, 0);
  }
}

export function updateAllPets(dt) {
  if (S.player && !S.queueLine.includes(S.player)) {
    updateEntityPets(S.player, dt);
  }
  for (const e of S.queueLine) {
    updateEntityPets(e, dt);
  }
  for (const npc of S.customNPCs) {
    updateEntityPets(npc, dt);
  }
  if (S.archangelEnt) {
    updateEntityPets(S.archangelEnt, dt);
  }
}

export function pushEntityChatBubble(ent, text, durationSec = 5.2) {
  if (!ent) return;
  const clean = String(text || '').trim();
  if (!clean) {
    ent.chat = '';
    ent.chatT = 0;
    return;
  }
  if (!Array.isArray(ent.chatQueue)) ent.chatQueue = [];
  const now = performance.now() * 0.001;

  ent.chatQueue.push({
    text: clean,
    bornAt: now,
    duration: durationSec
  });
  // Храним максимум 3 последних сообщения (новое вытесняет самое старое вверх)
  while (ent.chatQueue.length > 3) {
    ent.chatQueue.shift();
  }

  ent.chat = clean;
  ent.chatT = durationSec;
  ent._lastPushedChat = clean;
}

export function makeTagSprite(w = 400, h = 210, sx = 4.3, sy = 2.25) {
  const c = document.createElement('canvas');
  c.width = Math.max(380, w);
  c.height = Math.max(200, h);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: t,
      transparent: true,
      depthWrite: false,
      depthTest: false
    })
  );
  s.scale.set(Math.max(4.1, sx), Math.max(2.15, sy), 1);
  // Привязываем нижний край спрайта к точке над головой, чтобы ник был высоко, а облачка чата росли вверх
  s.center.set(0.5, 0.12);
  s.renderOrder = 990;
  s.userData = { c, g: c.getContext('2d'), t, last: '' };
  return s;
}

export function updateTag(spr, rankText, nameText, chatText, isMe = false, hpInfo = null, ent = null) {
  if (!spr || !spr.userData) return;
  const owner = ent || spr.userData.editorRef?.ent || null;
  const now = performance.now() * 0.001;

  // Если у сущности изменилось поле ent.chat напрямую (например, реплика NPC или эмоция) — кладём его в очередь облачков
  if (owner) {
    if (!Array.isArray(owner.chatQueue)) owner.chatQueue = [];
    if (chatText && chatText !== owner._lastPushedChat) {
      // В режиме Студии показываем превью фразы только когда сам персонаж выделен, а в Игре — всегда с таймером угасания
      if (S.state !== 'edit' || (S.selectedRef?.kind === 'char' && S.selectedRef.ent === owner)) {
        pushEntityChatBubble(owner, chatText, 5.0);
      } else {
        owner._lastPushedChat = chatText;
      }
    } else if (!chatText) {
      owner._lastPushedChat = '';
    }
    // Очищаем истёкшие сообщения
    owner.chatQueue = owner.chatQueue.filter(m => now - m.bornAt < m.duration);
    if (owner.chatQueue.length === 0 && owner.chatT <= 0 && S.state === 'play') {
      owner.chat = '';
    }
  }

  const activeBubbles = owner && Array.isArray(owner.chatQueue)
    ? owner.chatQueue
    : (chatText && S.state !== 'play' ? [{ text: chatText, bornAt: now - 0.5, duration: 999 }] : []);

  // Формируем ключ кэша с квантованием времени анимации (30 FPS), чтобы плавно отрисовывать Pop-In и Fade-Out
  const bubblesKey = activeBubbles
    .map(b => {
      const age = now - b.bornAt;
      const rem = b.duration - age;
      const animStep = (age < 0.28 || rem < 1.1) ? Math.floor(now * 30) : 'steady';
      return `${b.text}@${animStep}`;
    })
    .join('||');

  const hpKey = hpInfo && hpInfo.show ? `${Math.ceil(hpInfo.hp)}/${hpInfo.maxHp}` : '';
  const key = `${rankText}|${nameText}|${bubblesKey}|${isMe}|${hpKey}`;
  if (spr.userData.last === key) return;
  spr.userData.last = key;

  const { c, g, t } = spr.userData;
  g.clearRect(0, 0, c.width, c.height);

  // 1. Отрисовка до 3 облачков сообщений (снизу вверх: самое свежее над именем, предыдущие выше)
  const baseNameY = 148;
  const bubbleHeight = 36;
  const bubbleGap = 5;

  for (let i = 0; i < activeBubbles.length; i++) {
    const b = activeBubbles[i];
    const age = Math.max(0, now - b.bornAt);
    const rem = Math.max(0, b.duration - age);

    // Плавное появление (0.22с) и плавное угасание за последнюю 1.0с жизни сообщения
    const fadeIn = clamp(age / 0.22, 0, 1);
    const fadeOut = clamp(rem / 1.0, 0, 1);
    const alpha = fadeIn * fadeOut;
    if (alpha <= 0.02) continue;

    // Самое новое сообщение (последнее в массиве) находится на слоте 0 прямо над именем, старые — выше
    const slotFromBottom = activeBubbles.length - 1 - i;
    const popOffset = (1 - fadeIn) * 10;
    const floatUpOffset = (1 - fadeOut) * 6;
    const cy = baseNameY - 34 - slotFromBottom * (bubbleHeight + bubbleGap) + popOffset - floatUpOffset;
    const scale = 0.88 + 0.12 * fadeIn;

    g.save();
    g.globalAlpha = alpha * (slotFromBottom === 0 ? 1.0 : slotFromBottom === 1 ? 0.92 : 0.82);
    g.translate(c.width / 2, cy);
    g.scale(scale, scale);

    g.font = '800 15.5px "Montserrat",sans-serif';
    const textMetrics = g.measureText(b.text);
    const boxW = clamp(textMetrics.width + 32, 90, c.width - 16);
    const boxH = bubbleHeight;

    g.fillStyle = 'rgba(255, 255, 255, 0.96)';
    g.strokeStyle = '#141a29';
    g.lineWidth = 3.2;
    g.beginPath();
    g.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, 11);
    g.fill();
    g.stroke();

    g.fillStyle = '#0f172a';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(b.text, 0, 1, boxW - 18);
    g.restore();
  }

  // 2. Отрисовка Никнейма (без лишних префиксов, если rankText пустой)
  g.font = '900 18.5px "Montserrat",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5.5;
  g.strokeStyle = 'rgba(0,0,0,.88)';
  const cleanRank = String(rankText || '').trim();
  const cleanName = String(nameText || '').trim();
  const label = cleanRank ? `${cleanRank} ${cleanName}` : cleanName;
  g.strokeText(label, c.width / 2, baseNameY);
  g.fillStyle = isMe ? '#56f0ff' : '#ffe066';
  g.fillText(label, c.width / 2, baseNameY);

  // 3. Полоска здоровья (HP Bar)
  if (hpInfo && hpInfo.show) {
    const bw = 184;
    const bh = 18;
    const bx = (c.width - bw) / 2;
    const by = baseNameY + 18;
    const ratio = clamp(hpInfo.hp / Math.max(1, hpInfo.maxHp), 0, 1);
    g.fillStyle = 'rgba(0,0,0,.82)';
    g.beginPath();
    g.roundRect(bx - 2, by - 2, bw + 4, bh + 4, 6);
    g.fill();
    g.fillStyle = ratio > 0.5 ? '#00e676' : ratio > 0.25 ? '#ffce3a' : '#ff3e3e';
    if (ratio > 0) {
      g.beginPath();
      g.roundRect(bx, by, bw * ratio, bh, 4);
      g.fill();
    }
    g.fillStyle = '#fff';
    g.font = '800 12px "Montserrat",sans-serif';
    g.fillText(`${Math.ceil(hpInfo.hp)} / ${hpInfo.maxHp} HP`, c.width / 2, by + bh / 2 + 1);
  }

  t.needsUpdate = true;
}
