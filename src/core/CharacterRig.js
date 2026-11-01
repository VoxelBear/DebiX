// src/core/CharacterRig.js
import { S, TAU, clamp } from './State.js';
import {
  makePartMat,
  defaultFaceURL,
  setMeshFrontSprite
} from './TextureFactory.js';

export const MAX_COSMETIC_PARTS = 16;
export const MAX_ITEM_PARTS = 16;
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

// Создание X-Ray маркеров для редактора (рендерятся поверх любых мешей с depthTest: false и чёткой индикацией направления)
export function createXRayGripMarkerMesh(colorHex = '#00e676', scale = 1.0) {
  const group = new THREE.Group();
  group.renderOrder = 999;

  const coreMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.92
  });
  const outlineMat = new THREE.MeshBasicMaterial({
    color: '#ffffff',
    wireframe: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.85
  });
  const fwdMat = new THREE.MeshBasicMaterial({
    color: '#56f0ff',
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.95
  });
  const upMat = new THREE.MeshBasicMaterial({
    color: '#ffce3a',
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.9
  });

  // Центральная сфера хвата + контрастный каркас
  const core = new THREE.Mesh(getSharedPrimitiveGeo('sphere'), coreMat);
  core.scale.setScalar(0.32 * scale);
  group.add(core);

  const wire = new THREE.Mesh(getSharedPrimitiveGeo('sphere'), outlineMat);
  wire.scale.setScalar(0.38 * scale);
  group.add(wire);

  // Кольцо прицела вокруг точки хвата
  const ring = new THREE.Mesh(getSharedPrimitiveGeo('torus'), outlineMat);
  ring.scale.setScalar(0.45 * scale);
  group.add(ring);

  // Стрелка направления «Вперёд (-Z)» (показывает, куда будет смотреть ствол/клинок)
  const fwdShaft = new THREE.Mesh(getSharedPrimitiveGeo('cylinder'), fwdMat);
  fwdShaft.scale.set(0.08 * scale, 0.42 * scale, 0.08 * scale);
  fwdShaft.rotation.x = Math.PI / 2;
  fwdShaft.position.set(0, 0, -0.22 * scale);
  group.add(fwdShaft);

  const fwdTip = new THREE.Mesh(getSharedPrimitiveGeo('cone'), fwdMat);
  fwdTip.scale.set(0.2 * scale, 0.28 * scale, 0.2 * scale);
  fwdTip.rotation.x = -Math.PI / 2;
  fwdTip.position.set(0, 0, -0.42 * scale);
  group.add(fwdTip);

  // Малый указатель «Вверх (+Y)»
  const upTip = new THREE.Mesh(getSharedPrimitiveGeo('cone'), upMat);
  upTip.scale.set(0.14 * scale, 0.22 * scale, 0.14 * scale);
  upTip.position.set(0, 0.24 * scale, 0);
  group.add(upTip);

  group.traverse(o => {
    o.renderOrder = 999;
    o.userData.noCollider = true;
  });
  return group;
}

export function createXRayMuzzleMarkerMesh(colorHex = '#ff3e3e', scale = 1.0) {
  const group = new THREE.Group();
  group.renderOrder = 999;

  const muzMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.94
  });
  const ringMat = new THREE.MeshBasicMaterial({
    color: '#ffce3a',
    wireframe: true,
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: 0.9
  });

  // Кольцо среза ствола
  const ring = new THREE.Mesh(getSharedPrimitiveGeo('torus'), ringMat);
  ring.scale.setScalar(0.42 * scale);
  group.add(ring);

  // Центральное ядро точки вылета
  const core = new THREE.Mesh(getSharedPrimitiveGeo('sphere'), muzMat);
  core.scale.setScalar(0.22 * scale);
  group.add(core);

  // Стрелка направления вылета снаряда (-Z)
  const cone = new THREE.Mesh(getSharedPrimitiveGeo('cone'), muzMat);
  cone.scale.set(0.28 * scale, 0.45 * scale, 0.28 * scale);
  cone.rotation.x = -Math.PI / 2;
  cone.position.set(0, 0, -0.22 * scale);
  group.add(cone);

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
  if (shape === 'sphere') geo = new THREE.SphereGeometry(0.4, 14, 10);
  else if (shape === 'cylinder') geo = new THREE.CylinderGeometry(0.35, 0.35, 0.6, 14);
  else if (shape === 'cone') geo = new THREE.ConeGeometry(0.4, 0.7, 14);
  else if (shape === 'torus') geo = new THREE.TorusGeometry(0.38, 0.08, 10, 18);
  else if (shape === 'plane') geo = new THREE.PlaneGeometry(0.8, 0.8);
  else geo = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  SHARED_GEO_CACHE[shape] = geo;
  return geo;
}

export function getSharedPrimitiveMat(colorHex = '#ffce3a', emissiveHex = null) {
  const normCol = (colorHex || '#ffce3a').toLowerCase();
  const normEm = emissiveHex ? emissiveHex.toLowerCase() : '';
  const key = `${normCol}|${normEm}`;
  if (SHARED_MAT_CACHE[key]) return SHARED_MAT_CACHE[key];

  const mat = new THREE.MeshStandardMaterial({
    color: normCol,
    roughness: 0.35,
    metalness: 0.2,
    side: THREE.DoubleSide
  });
  if (normEm) {
    mat.emissive.set(normEm);
    mat.emissiveIntensity = 1.2;
  }
  SHARED_MAT_CACHE[key] = mat;
  return mat;
}

// Кратчайшая угловая интерполяция без скачка через -PI / +PI
function lerpAngle(a, b, t) {
  let diff = ((b - a + Math.PI) % TAU) - Math.PI;
  if (diff < -Math.PI) diff += TAU;
  return a + diff * t;
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

// Приводит любой аксессуар/питомца к формату с массивом parts (от 1 до 16 примитивов)
export function normalizeCosmeticItem(item) {
  if (!item) return null;
  if (!item.parentSlot) item.parentSlot = 'head';
  if (item.enabled === undefined) item.enabled = true;
  if (!item.petBehavior) item.petBehavior = 'orbit'; // 'orbit' | 'follow'
  if (item.petDistance === undefined) item.petDistance = 2.2;
  if (item.petHeight === undefined) item.petHeight = 1.5;
  if (item.petSpeed === undefined) item.petSpeed = 2.4;

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
  return item;
}

/* ---------- НОРМАЛИЗАЦИЯ И ШАБЛОНЫ ПРЕДМЕТОВ / ОРУЖИЯ / КОНТЕЙНЕРОВ ---------- */

export function normalizeItemData(item) {
  if (!item) return null;
  if (!item.id) item.id = 'item_' + Date.now() + '_' + Math.floor(Math.random() * 999);
  if (!item.name) item.name = 'Предмет';
  if (!item.icon) item.icon = '🗡️';

  // 'held' (1 рука, хотбар) | 'carried' (2 руки, крупный контейнер)
  if (!item.holdMode) item.holdMode = 'held';

  // 'none' | 'melee' | 'ranged' | 'throwable' | 'consumable' | 'shield' | 'torch'
  if (!item.useType) item.useType = item.holdMode === 'carried' ? 'none' : 'melee';

  // Точка держания (Grip Point) — смещение и поворот предмета относительно кисти руки
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
        item.gripPoint = { x: 0.25, y: 0, z: -0.18, rx: 0, ry: 0, rz: 0 };
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

  // Свечение / Факел
  if (!item.lightData) {
    item.lightData = {
      enabled: item.useType === 'torch',
      color: '#ff9f43',
      intensity: 1.8,
      distance: 16
    };
  }

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
        texDataURL: null
      }
    ];
  } else if (item.projectileParts.length > MAX_ITEM_PARTS) {
    item.projectileParts.length = MAX_ITEM_PARTS;
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
      projSpeed: 46,
      maxRange: 75,
      gravityFactor: 0.08,
      blastRadius: 0,
      spread: 0.02,
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
        { id: uid(), name: 'Энерго-ядро', shape: 'cylinder', x: 0, y: 0.22, z: -0.35, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.48, sy: 0.7, sz: 0.48, color: '#00e676' },
        { id: uid(), name: 'Ствол', shape: 'cylinder', x: 0, y: 0.18, z: -0.78, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.25, sy: 0.65, sz: 0.25, color: '#56f0ff' }
      ],
      projectileParts: [
        { id: uid(), name: 'Плазма-заряд', shape: 'cylinder', x: 0, y: 0, z: 0, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.28, sy: 1.1, sz: 0.28, color: '#00ff88' },
        { id: uid(), name: 'Ореол', shape: 'sphere', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.45, sy: 0.45, sz: 0.45, color: '#56f0ff' }
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
        { id: uid(), name: 'Кристалл Огня', shape: 'sphere', x: 0, y: 0.85, z: -0.45, rx: 0, ry: 0, rz: 0, sx: 0.55, sy: 0.55, sz: 0.55, color: '#ff3e3e' }
      ],
      projectileParts: [
        { id: uid(), name: 'Огненное ядро', shape: 'sphere', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.7, sy: 0.7, sz: 0.7, color: '#ff3e3e' },
        { id: uid(), name: 'Хвост пламени', shape: 'cone', x: 0, y: 0, z: 0.35, rx: Math.PI / 2, ry: 0, rz: 0, sx: 0.55, sy: 0.9, sz: 0.55, color: '#ffce3a' }
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
        { id: uid(), name: 'Искра', shape: 'sphere', x: 0, y: 0.38, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.22, sy: 0.22, sz: 0.22, color: '#ff3e3e' }
      ],
      projectileParts: [
        { id: uid(), name: 'Корпус бомбы', shape: 'sphere', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.65, sy: 0.65, sz: 0.65, color: '#22252a' },
        { id: uid(), name: 'Искра', shape: 'sphere', x: 0, y: 0.32, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.28, sy: 0.28, sz: 0.28, color: '#ff3e3e' }
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
      lightData: { enabled: true, color: '#ff9f43', intensity: 2.2, distance: 18 },
      gripPoint: { x: 0, y: 0.15, z: 0, rx: -0.25, ry: 0, rz: 0 },
      parts: [
        { id: uid(), name: 'Рукоять факела', shape: 'cylinder', x: 0, y: 0, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.26, sy: 1.4, sz: 0.26, color: '#6d4c41' },
        { id: uid(), name: 'Пламя', shape: 'cone', x: 0, y: 0.55, z: 0, rx: 0, ry: 0, rz: 0, sx: 0.42, sy: 0.65, sz: 0.42, color: '#ff9f43' }
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
      gripPoint: { x: 0.25, y: 0, z: -0.18, rx: 0, ry: 0, rz: 0 },
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
    // Поворот применяется к корню в точке хвата (0,0,0 сокета), а примитивы смещаются относительно рукояти
    root.rotation.set(item.gripPoint.rx || 0, item.gripPoint.ry || 0, item.gripPoint.rz || 0);
    partsHolder.position.set(item.gripPoint.x || 0, item.gripPoint.y || 0, item.gripPoint.z || 0);
  }
  root.add(partsHolder);
  root.userData.partsHolder = partsHolder;

  const srcParts = isProjectile ? (item.projectileParts || item.parts) : item.parts;
  const count = Math.min(MAX_ITEM_PARTS, srcParts.length);

  for (let i = 0; i < count; i++) {
    const pt = srcParts[i];
    const geo = getSharedPrimitiveGeo(pt.shape || 'box');
    const isGlowing = isProjectile || (item.lightData && item.lightData.enabled && i === count - 1);
    const mat = pt.texDataURL
      ? new THREE.MeshStandardMaterial({ color: pt.color || '#ffce3a', roughness: 0.35, metalness: 0.2, side: THREE.DoubleSide })
      : getSharedPrimitiveMat(pt.color || '#ffce3a', isGlowing ? (pt.color || '#ffce3a') : null);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pt.x || 0, pt.y || 0, pt.z || 0);
    mesh.rotation.set(pt.rx || 0, pt.ry || 0, pt.rz || 0);
    mesh.scale.set(pt.sx ?? 1, pt.sy ?? 1, pt.sz ?? 1);
    mesh.castShadow = !isProjectile;
    mesh.receiveShadow = !isProjectile;
    mesh.userData.noCollider = true;
    mesh.userData.itemPart = pt;
    mesh.userData.itemPartIdx = i;
    mesh.userData.isProjectilePart = isProjectile;

    if (pt.texDataURL) {
      setMeshFrontSprite(mesh, pt.texDataURL);
    }

    partsHolder.add(mesh);
    root.userData.partMeshes.push(mesh);
  }

  // В режиме редактора Студии добавляем сквозные X-Ray маркеры Точки держания (Grip) и Точки вылета (Muzzle)
  if (showMarkers && !isProjectile) {
    const gripMarker = createXRayGripMarkerMesh('#00e676', 1.0);
    // Инвертированное смещение показывает точку, где находится кисть руки относительно примитивов
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
  const geo = getSharedPrimitiveGeo(part.shape || 'box');
  const mat = new THREE.MeshStandardMaterial({
    color: part.color || '#ffce3a',
    roughness: 0.35,
    metalness: 0.2,
    side: THREE.DoubleSide
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(part.x || 0, part.y || 0, part.z || 0);
  mesh.rotation.set(part.rx || 0, part.ry || 0, part.rz || 0);
  mesh.scale.set(part.sx ?? 1, part.sy ?? 1, part.sz ?? 1);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // Строго визуальный меш без физического коллайдера
  mesh.userData.noCollider = true;
  mesh.userData.cosmeticItem = item;
  mesh.userData.cosmeticPart = part;
  mesh.userData.cosmeticPartIdx = partIdx;
  mesh.userData.cosmeticGroup = group;

  if (part.texDataURL) {
    setMeshFrontSprite(mesh, part.texDataURL);
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

  const count = Math.min(MAX_COSMETIC_PARTS, item.parts.length);
  for (let i = 0; i < count; i++) {
    const part = item.parts[i];
    const pMesh = buildPrimitiveMesh(part, item, i, group);
    group.add(pMesh);
    group.userData.partMeshes.push(pMesh);
  }
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

  // 1. Ноги: пивот в тазобедренном суставе (y = 0.95), геометрия смещена вниз на -0.475
  const legGeo = new THREE.BoxGeometry(0.46, 0.95, 0.46);
  legGeo.translate(0, R6_PIVOTS.legCenterOffset, 0);
  const legL = new THREE.Mesh(legGeo, mLegL);
  legL.position.set(-0.25, R6_PIVOTS.hipY, 0);
  legL.userData.pivotOffsetY = R6_PIVOTS.legCenterOffset;

  const legR = new THREE.Mesh(legGeo, mLegR);
  legR.position.set(0.25, R6_PIVOTS.hipY, 0);
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
  const armGeo = new THREE.BoxGeometry(0.44, 0.96, 0.44);
  armGeo.translate(0, R6_PIVOTS.armCenterOffset, 0);
  const armL = new THREE.Mesh(armGeo, mArmL);
  armL.position.set(-0.73, R6_PIVOTS.shoulderY, 0);
  armL.userData.pivotOffsetY = R6_PIVOTS.armCenterOffset;

  const armR = new THREE.Mesh(armGeo, mArmR);
  armR.position.set(0.73, R6_PIVOTS.shoulderY, 0);
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
    coil,
    wings,
    customCosMeshes,
    petEntries,
    syncCustomCosmetics
  };
}

// Запуск процедурной анимации удара/действия (вместо setTimeout)
export function triggerEntityAttack(ent, style = 'punch') {
  if (!ent) return;
  ent.attackAnimDuration = 0.28;
  ent.attackAnimT = ent.attackAnimDuration;
  ent.attackStyle = style;
}

// Единый процедурный аниматор рига R6 с поддержкой удержания 1 рукой, переноски 2 руками и замаха
export function updateEntityAnimation(ent, dt, opts = {}) {
  if (!ent || !ent.rig) return;
  const rig = ent.rig;
  const moving = !!opts.moving;
  const grounded = opts.grounded !== undefined ? !!opts.grounded : (ent.grounded !== undefined ? !!ent.grounded : true);
  const inLiquid = !!opts.inLiquid;
  const vy = ent.vy || 0;
  const t = (S.time || 0) + (ent.qIdx || 0) * 0.37;

  const stepPhase = (ent.step || 0) * 1.85;
  const walkSwing = moving ? Math.sin(stepPhase) : 0;
  const walkBounce = moving && grounded && !inLiquid ? Math.abs(Math.cos(stepPhase)) * 0.055 : 0;
  const idleBreath = Math.sin(t * 2.4) * 0.025;

  let legLX = 0;
  let legRX = 0;
  let legLZ = 0;
  let legRZ = 0;

  let armLX = 0;
  let armRX = 0;
  let armLY = 0;
  let armRY = 0;
  let armLZ = -0.04 - Math.abs(idleBreath) * 0.8;
  let armRZ = 0.04 + Math.abs(idleBreath) * 0.8;

  let torsoX = idleBreath * 0.35;
  let torsoY = 0;
  let torsoZ = 0;

  let headX = -idleBreath * 0.3;
  let headY = 0;
  let headZ = 0;

  if (inLiquid) {
    const swimPhase = t * 5.2;
    legLX = Math.sin(swimPhase) * 0.55 + 0.2;
    legRX = -Math.sin(swimPhase) * 0.55 + 0.2;
    armLX = Math.cos(swimPhase) * 0.85 - 0.5;
    armRX = -Math.cos(swimPhase) * 0.85 - 0.5;
    armLZ = -0.28;
    armRZ = 0.28;
    torsoX = 0.26;
    headX = -0.2;
  } else if (!grounded) {
    const airFactor = clamp(vy * 0.06, -0.45, 0.45);
    legLX = -0.32 + walkSwing * 0.35;
    legRX = 0.26 - walkSwing * 0.35;
    legLZ = -0.05;
    legRZ = 0.05;

    armLX = -0.42 - airFactor * 0.7;
    armRX = -0.42 - airFactor * 0.7;
    armLZ = -0.26;
    armRZ = 0.26;
    torsoX = -airFactor * 0.22;
    headX = airFactor * 0.18;
  } else if (moving) {
    legLX = walkSwing * 0.72;
    legRX = -walkSwing * 0.72;

    armLX = -walkSwing * 0.68;
    armRX = walkSwing * 0.68;
    armLZ = -0.07;
    armRZ = 0.07;

    torsoX = 0.07;
    torsoY = -walkSwing * 0.08;
    headX = -0.04;
    headY = walkSwing * 0.05;
  } else {
    armLX = Math.sin(t * 1.7) * 0.035;
    armRX = -Math.sin(t * 1.7) * 0.035;
    headY = Math.sin(t * 1.1) * 0.05;
  }

  // Если в Студии редактируется точка хвата этого персонажа — ставим руки в наглядную позу удержания
  const isEditingCharGrip =
    S.state === 'edit' &&
    S.selectedRef &&
    S.selectedRef.kind === 'char' &&
    S.selectedRef.ent === ent &&
    S.selectedRef.editMode;

  if (isEditingCharGrip === 'carry_grip' || ent.carriedItem) {
    // Поза переноски крупного контейнера в 2 руках (carried)
    armLX = -1.35 + (isEditingCharGrip ? 0 : Math.sin(t * 3.0) * 0.03);
    armRX = -1.35 + (isEditingCharGrip ? 0 : Math.sin(t * 3.0) * 0.03);
    armLY = 0.28;
    armRY = -0.28;
    armLZ = -0.08;
    armRZ = 0.08;
    torsoX = isEditingCharGrip ? 0 : -0.06;
  } else if (isEditingCharGrip === 'hand_grip') {
    // Наглядная поза вытянутой вперёд правой руки (-90°) для точной настройки 1-ручного хвата в Студии
    armRX = -Math.PI / 2;
    armRY = 0;
    armRZ = 0;
    torsoX = 0;
    torsoY = 0;
  } else if (ent.holdPose === 'throw_charge') {
    // Замах правой рукой назад для метания снаряда
    armRX = -2.35;
    armRY = 0.22;
    armRZ = 0.18;
    torsoY = -0.25;
  } else if (ent.holdPose === 'aim') {
    // Прицеливание из стрелкового оружия / посоха (с поправкой на угол камеры по вертикали)
    const pitchOffset = ent.isP ? clamp(-S.pitch, -0.7, 0.7) : 0;
    armRX = -Math.PI / 2 + pitchOffset;
    armRY = 0;
    armRZ = 0;
    headX += pitchOffset * 0.45;
  } else if (ent.holdPose === 'shield') {
    // Удержание силового щита перед корпусом
    armRX = -Math.PI / 2;
    armRY = -0.25;
    armRZ = 0;
  } else if (ent.holdPose === 'tool' || ent.holdPose === 'weapon') {
    // Удержание 1-ручного оружия/предмета в правой руке прямо вперёд
    armRX = -1.52 + Math.sin(t * 2.5) * 0.03;
    armRY = -0.03;
    armRZ = 0.02;
  }

  // Анимация удара/выстрела от плечевого сустава
  if (ent.attackAnimT && ent.attackAnimT > 0) {
    ent.attackAnimT = Math.max(0, ent.attackAnimT - dt);
    const dur = ent.attackAnimDuration || 0.28;
    const p = 1 - ent.attackAnimT / dur;
    const strikeCurve = Math.sin(Math.pow(p, 0.65) * Math.PI);

    if (ent.attackStyle === 'shoot') {
      armRX = -1.55 - 0.28 * strikeCurve;
      torsoX -= 0.06 * strikeCurve;
    } else {
      armRX = -1.95 * strikeCurve;
      armRY = -0.32 * strikeCurve;
      armRZ = 0.18 * strikeCurve;
      torsoY += 0.28 * strikeCurve;
      torsoX += 0.12 * strikeCurve;
    }
  }

  const blend = 1 - Math.exp(-18 * Math.max(0.001, dt));

  rig.legL.position.set(-0.25, R6_PIVOTS.hipY + walkBounce * 0.4, 0);
  rig.legR.position.set(0.25, R6_PIVOTS.hipY + walkBounce * 0.4, 0);
  rig.torso.position.set(0, R6_PIVOTS.waistY + walkBounce, 0);

  const upperShiftZ = Math.sin(torsoX) * 0.88;
  const upperShiftY = (Math.cos(torsoX) - 1) * 0.88 + walkBounce;
  const shoulderTwistZ = Math.sin(torsoY) * 0.65;

  rig.armL.position.set(-0.73, R6_PIVOTS.shoulderY + upperShiftY + idleBreath * 0.5, upperShiftZ + shoulderTwistZ);
  rig.armR.position.set(0.73, R6_PIVOTS.shoulderY + upperShiftY + idleBreath * 0.5, upperShiftZ - shoulderTwistZ);
  rig.head.position.set(0, R6_PIVOTS.neckY + upperShiftY, upperShiftZ * 1.1);

  rig.legL.rotation.x += (legLX - rig.legL.rotation.x) * blend;
  rig.legR.rotation.x += (legRX - rig.legR.rotation.x) * blend;
  rig.legL.rotation.z += (legLZ - rig.legL.rotation.z) * blend;
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

// Движение всех Питомцев относительно их собственной мировой позиции
function updateEntityPets(ent, dt) {
  if (!ent || !ent.rig || !ent.rig.petEntries || ent.rig.petEntries.length === 0) return;

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

export function makeTagSprite(w = 280, h = 105, sx = 3.1, sy = 1.15) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, transparent: true, depthWrite: false }));
  s.scale.set(sx, sy, 1);
  s.userData = { c, g: c.getContext('2d'), t, last: '' };
  return s;
}

export function updateTag(spr, rankText, nameText, chatText, isMe = false, hpInfo = null) {
  const hpKey = hpInfo && hpInfo.show ? `${Math.ceil(hpInfo.hp)}/${hpInfo.maxHp}` : '';
  const key = `${rankText}|${nameText}|${chatText}|${isMe}|${hpKey}`;
  if (spr.userData.last === key) return;
  spr.userData.last = key;
  const { c, g, t } = spr.userData;
  g.clearRect(0, 0, c.width, c.height);

  if (chatText) {
    g.fillStyle = 'rgba(255,255,255,.95)';
    g.strokeStyle = '#222';
    g.lineWidth = 3;
    g.beginPath();
    g.roundRect(14, 4, c.width - 28, 32, 10);
    g.fill();
    g.stroke();
    g.fillStyle = '#111';
    g.font = '800 13px "Montserrat",sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(chatText, c.width / 2, 20);
  }
  g.font = '900 17px "Montserrat",sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineWidth = 5;
  g.strokeStyle = 'rgba(0,0,0,.85)';
  const label = `${rankText} ${nameText}`;
  g.strokeText(label, c.width / 2, 54);
  g.fillStyle = isMe ? '#56f0ff' : '#ffe066';
  g.fillText(label, c.width / 2, 54);

  if (hpInfo && hpInfo.show) {
    const bw = 160;
    const bh = 16;
    const bx = (c.width - bw) / 2;
    const by = 74;
    const ratio = clamp(hpInfo.hp / Math.max(1, hpInfo.maxHp), 0, 1);
    g.fillStyle = 'rgba(0,0,0,.78)';
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
    g.font = '800 11px "Montserrat",sans-serif';
    g.fillText(`${Math.ceil(hpInfo.hp)} / ${hpInfo.maxHp} HP`, c.width / 2, by + bh / 2 + 1);
  }

  t.needsUpdate = true;
}