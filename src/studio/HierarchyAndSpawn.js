// src/studio/HierarchyAndSpawn.js
import { S, $, showBanner, ITEM_STUDIO_ORIGIN } from '../core/State.js';
import { buildBBModelGroup, extractBBModelParts } from '../core/BBModelLoader.js';
import { cv, renderer, scene, camera } from '../core/SceneManager.js';
import { createBlockMaterial, drawFacePresetOnCtx } from '../core/TextureFactory.js';
import { sfx } from '../core/AudioEngine.js';
import {
  MAX_ITEM_PARTS,
  MAX_COSMETIC_PARTS,
  createStarterItemTemplate,
  getSharedPrimitiveGeo,
  normalizePartEffects,
  normalizeCosmeticItem,
  normalizeItemData,
  buildItemGroup,
  buildCustomCosmeticGroup,
  createRobloxRig
} from '../core/CharacterRig.js';
import {
  addSceneBlock,
  addCheckpointBlock,
  rebuildPhysicsArrays,
  syncBlockSpecialVisuals,
  createBlockGeometryByShape,
  createBlockPivotHelperMesh,
  ensureBlockComponents,
  syncBlockComponentsState,
  syncSceneVisibilityForMode,
  syncStudioMotionAndSignalHelpers
} from '../core/WorldRegistry.js';
import {
  spawnCustomNPC,
  spawnWorldItem,
  attachRigToEntity,
  syncEntityHeldItemMesh
} from '../core/EntityManager.js';
import {
  raycaster,
  mouseNDC,
  selectEditorObject,
  focusOnSelected,
  deleteSelected,
  pushUndoState,
  pushItemUndoState,
  pushCosmeticUndoState,
  openItemStudio3D,
  closeItemStudio3D,
  syncItemStudioPreview
} from './StudioController.js';
import { syncLibraryItemIfEditing, renderInspectorUI } from './InspectorPanel.js';
import { isPaintModalOpen } from './PaintStudio2D.js';
import {
  createDefaultMediaScreenData,
  createDefaultSoundEmitterData,
  syncBlockMediaVisuals
} from '../core/MediaSystem.js';

/* ---------- КАТАЛОГ БАЗОВЫХ ПРЕФАБОВ И КАТЕГОРИЙ (UNITY PROJECT DOCK) ---------- */

export const BUILTIN_PREFAB_CATALOG = [
  { key: 'prim_empty', title: 'Пустышка (Empty)', category: 'primitives', border: '#56f0ff' },
  { key: 'prim_box', title: 'Примитив: Куб', category: 'primitives', border: '#f1f5f9' },
  { key: 'prim_sphere', title: 'Примитив: Сфера', category: 'primitives', border: '#f1f5f9' },
  { key: 'prim_cylinder', title: 'Примитив: Цилиндр', category: 'primitives', border: '#f1f5f9' },
  { key: 'prim_cone', title: 'Примитив: Конус', category: 'primitives', border: '#f1f5f9' },
  { key: 'prim_wedge', title: 'Примитив: Клин', category: 'primitives', border: '#f1f5f9' },
  { key: 'prim_torus', title: 'Примитив: Кольцо', category: 'primitives', border: '#f1f5f9' },

  { key: 'solid', title: 'Лего-Блок (Твёрдый)', category: 'blocks', border: '#56f0ff' },
  { key: 'liquid', title: 'Вода / Лава (Жидкость)', category: 'blocks', border: '#00a8ff' },
  { key: 'gas', title: 'Облако / Пар (Газ)', category: 'blocks', border: '#dfe6e9' },
  { key: 'checkpoint', title: 'Чекпоинт Обби', category: 'blocks', border: '#ffeaa7' },
  { key: 'kill', title: 'Урон-Лазер (Kill)', category: 'blocks', border: '#ff3e3e' },
  { key: 'trampoline', title: 'Прыгучий Батут', category: 'blocks', border: '#00e676' },

  { key: 'door', title: 'Дверь / Лифт [E]', category: 'logic', border: '#00e676' },
  { key: 'button', title: 'Кнопка / Рычаг [E]', category: 'logic', border: '#00e676' },
  { key: 'plate', title: 'Нажимная Плита', category: 'logic', border: '#ffce3a' },
  { key: 'teleport', title: 'Пара Телепортов', category: 'logic', border: '#56f0ff' },
  { key: 'vip_gate', title: 'VIP-Ворота за R$', category: 'logic', border: '#ffce3a' },
  { key: 'shop_pad', title: 'Магазин за R$', category: 'logic', border: '#00e676' },
  { key: 'spawner', title: 'Спавнер Объектов', category: 'logic', border: '#9b59b6' },
  { key: 'media_screen', title: 'Видео-Экран (TV)', category: 'logic', border: '#00d2ff' },
  { key: 'media_speaker', title: '3D-Колонка (Звук)', category: 'logic', border: '#00e676' },

  { key: 'item_sword', title: 'Алмазный Меч', category: 'weapons', border: '#ff6b6b' },
  { key: 'item_blaster', title: 'Импульсный Бластер', category: 'weapons', border: '#ff6b6b' },
  { key: 'item_staff', title: 'Посох Фаерболов', category: 'weapons', border: '#a29bfe' },
  { key: 'item_grenade', title: 'Импульсная Бомба', category: 'weapons', border: '#ff9f43' },
  { key: 'item_medkit', title: 'Аптечка / Еда', category: 'weapons', border: '#00e676' },
  { key: 'item_torch', title: 'Шахтёрский Факел', category: 'weapons', border: '#ffce3a' },
  { key: 'item_shield', title: 'Силовой Щит', category: 'weapons', border: '#56f0ff' },
  { key: 'item_crate', title: 'Контейнер (2 руки)', category: 'weapons', border: '#e67e22' },

  { key: 'npc', title: 'NPC-Бот (R6)', category: 'chars', border: '#56f0ff' }
];

const SYSTEM_FOLDERS = [
  { id: 'all', name: 'Все префабы', icon: '📁' },
  { id: 'primitives', name: 'Пустышки и Примитивы', icon: '🧊' },
  { id: 'blocks', name: 'Блоки и Среды', icon: '🧱' },
  { id: 'logic', name: 'Логика и Механики', icon: '⚡' },
  { id: 'weapons', name: 'Оружие и Предметы', icon: '🗡️' },
  { id: 'chars', name: 'Персонажи и NPC', icon: '🤖' },
  { id: 'library', name: 'Мой Арсенал и Гардероб', icon: '⭐' }
];

const PRIMITIVE_LABELS_RU = {
  box: 'Куб',
  sphere: 'Сфера',
  cylinder: 'Цилиндр',
  cone: 'Конус',
  wedge: 'Клин',
  torus: 'Кольцо',
  plane: 'Плоскость'
};

/* ---------- СИСТЕМА ВЛОЖЕННОСТИ (UNITY PARENT-CHILD HIERARCHY & MATRIX PROPAGATION) ---------- */

// Виртуальный 3D-пивот для трансформации папок/пустых родительских групп
export const folderPivotMesh = new THREE.Object3D();
folderPivotMesh.name = 'FolderGroupPivot';
folderPivotMesh.userData.noCollider = true;
scene.add(folderPivotMesh);

const _baselineMatrix = new THREE.Matrix4();
const _BaselineInv = new THREE.Matrix4();
const _deltaMatrix = new THREE.Matrix4();
const _childNewMatrix = new THREE.Matrix4();
const _decPos = new THREE.Vector3();
const _decQuat = new THREE.Quaternion();
const _decScale = new THREE.Vector3();

const _prevParentPos = new THREE.Vector3();
const _prevParentQuat = new THREE.Quaternion();
const _prevParentScale = new THREE.Vector3();

const _currParentPos = new THREE.Vector3();
const _currParentQuat = new THREE.Quaternion();
const _currParentScale = new THREE.Vector3();

const _prevLocalPos = new THREE.Vector3();
const _prevLocalQuat = new THREE.Quaternion();
const _localStepQuat = new THREE.Quaternion();
const _invPrevLocalQuat = new THREE.Quaternion();

const _stepQuat = new THREE.Quaternion();
const _invPrevQuat = new THREE.Quaternion();
const _stepPos = new THREE.Vector3();
const _childOffset = new THREE.Vector3();

const _baseLocalPos = new THREE.Vector3();
const _baseLocalQuat = new THREE.Quaternion();
const _localDeltaQuat = new THREE.Quaternion();
const _invBaseLocalQuat = new THREE.Quaternion();
const _baselineChildrenMap = new Map();
const _baselinePartsMap = new Map();

let _hasBaseline = false;

/* ---------- ПУСТЫЕ ОБЪЕКТЫ С ПИВОТОМ (UNITY EMPTY GAMEOBJECT) ---------- */

let _hierOrderSeq = 10;
export function ensureNodeHierOrder(obj) {
  if (!obj) return 0;
  if (typeof obj.hierOrder !== 'number') {
    obj.hierOrder = _hierOrderSeq;
    _hierOrderSeq += 10;
  }
  return obj.hierOrder;
}

function createEmptyPivotHelperMesh() {
  const g = new THREE.Group();
  const mkMat = (col, op = 0.9) =>
    new THREE.MeshBasicMaterial({
      color: col,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: op
    });

  // Невидимая сфера для клика по пустышке в 3D-сцене
  const hit = new THREE.Mesh(new THREE.SphereGeometry(0.28, 8, 8), mkMat('#ffffff', 0));
  g.add(hit);

  // Аккуратный центральный ромб-пивот и 3 оси
  const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), mkMat('#56f0ff', 0.92));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.012, 8, 24), mkMat('#ffffff', 0.75));
  g.add(core, ring);

  const axX = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.02, 0.02), mkMat('#ff4757', 0.9));
  axX.position.x = 0.13;
  const axY = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.26, 0.02), mkMat('#00e676', 0.9));
  axY.position.y = 0.13;
  const axZ = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.26), mkMat('#00d2ff', 0.9));
  axZ.position.z = 0.13;
  g.add(axX, axY, axZ);

  g.traverse(o => {
    o.renderOrder = 998;
    o.userData.noCollider = true;
  });
  return g;
}

export function clearEmptyObjects() {
  if (!Array.isArray(S.emptyObjects)) S.emptyObjects = [];
  for (const emp of S.emptyObjects) {
    if (emp.group) scene.remove(emp.group);
  }
  S.emptyObjects.length = 0;
  S.emptyIdCounter = 1;
}

export function setEmptyObjectsHelperVisible(visible) {
  if (!Array.isArray(S.emptyObjects)) return;
  for (const emp of S.emptyObjects) {
    if (emp.helper) {
      emp.helper.visible = !!visible && !emp.editorHidden;
    }
  }
}

// Создаёт пустой объект (Пустышку). Если передан parentKey, спавнится в (0,0,0) локальных координат родителя!
export function spawnEmptyObject(opts = {}) {
  if (!Array.isArray(S.emptyObjects)) S.emptyObjects = [];
  if (!S.emptyIdCounter) S.emptyIdCounter = 1;

  const id = opts.id || ('emp_' + S.emptyIdCounter++);
  const name = opts.name || (`Пустышка #${S.emptyObjects.length + 1}`);
  const parentKey = opts.parentKey || null;

  let x = opts.x ?? 0;
  let y = opts.y ?? 2;
  let z = opts.z ?? 0;
  let rx = opts.rx ?? 0;
  let ry = opts.ry ?? 0;
  let rz = opts.rz ?? 0;
  let sx = opts.sx ?? 1;
  let sy = opts.sy ?? 1;
  let sz = opts.sz ?? 1;

  // Если создаём как дочернюю пустышку — ставим в (0,0,0) локальных координат родителя
  if (parentKey && opts.x === undefined) {
    const pInfo = getSceneNodeByKey(parentKey);
    if (pInfo && pInfo.mesh) {
      pInfo.mesh.updateMatrixWorld(true);
      const wp = new THREE.Vector3();
      const wq = new THREE.Quaternion();
      const ws = new THREE.Vector3();
      pInfo.mesh.matrixWorld.decompose(wp, wq, ws);
      const we = new THREE.Euler().setFromQuaternion(wq);
      x = Number(wp.x.toFixed(3));
      y = Number(wp.y.toFixed(3));
      z = Number(wp.z.toFixed(3));
      rx = we.x;
      ry = we.y;
      rz = we.z;
    }
    if (pInfo && pInfo.obj) {
      if (pInfo.kind === 'folder') pInfo.obj.collapsed = false;
      else pInfo.obj.hierCollapsed = false;
    }
  } else if (!parentKey && opts.x === undefined) {
    // В корне сцены — перед камерой редактора
    const fwd = new THREE.Vector3(
      -Math.sin(S.edYaw) * Math.cos(S.edPitch),
      Math.sin(S.edPitch),
      -Math.cos(S.edYaw) * Math.cos(S.edPitch)
    );
    const sp = S.edCamPos.clone().addScaledVector(fwd, 7);
    x = Math.round(sp.x * 2) / 2;
    y = Math.max(0.5, Math.round(sp.y * 2) / 2);
    z = Math.round(sp.z * 2) / 2;
  }

  const group = new THREE.Group();
  group.position.set(x, y, z);
  group.rotation.set(rx, ry, rz);
  group.scale.set(sx, sy, sz);
  group.userData.noCollider = true;

  const helper = createEmptyPivotHelperMesh();
  helper.visible = S.state === 'edit';
  group.add(helper);
  scene.add(group);

  const emp = {
    id,
    name,
    x,
    y,
    z,
    rx,
    ry,
    rz,
    sx,
    sy,
    sz,
    parentKey,
    hierOrder: opts.hierOrder !== undefined ? opts.hierOrder : ensureNodeHierOrder({}),
    hierCollapsed: false,
    editorLocked: false,
    editorHidden: false,
    group,
    helper
  };

  group.traverse(o => {
    o.userData.editorRef = { kind: 'empty', emptyObj: emp };
  });

  S.emptyObjects.push(emp);
  return emp;
}

// Конвертирует legacy-пустышку из S.emptyObjects в универсальный модульный объект S.allBlocks с сохранением всех дочерних связей
export function convertEmptyObjToModularBlock(emp) {
  if (!emp) return null;
  const g = emp.group;
  const pos = g ? g.position.clone() : new THREE.Vector3(emp.x || 0, emp.y || 2, emp.z || 0);
  const rot = g ? g.rotation.clone() : new THREE.Euler(emp.rx || 0, emp.ry || 0, emp.rz || 0);
  const scl = g ? g.scale.clone() : new THREE.Vector3(emp.sx || 1, emp.sy || 1, emp.sz || 1);

  const box = addSceneBlock({
    x: pos.x,
    y: pos.y + scl.y * 0.5,
    z: pos.z,
    w: Math.max(0.2, scl.x),
    h: Math.max(0.2, scl.y),
    d: Math.max(0.2, scl.z),
    colorHex: '#f1f5f9',
    label: emp.name || 'Объект',
    shape: 'box',
    isRawEmpty: true,
    isCustom: true
  });

  box.m.position.copy(pos);
  box.m.rotation.copy(rot);
  box.m.scale.copy(scl);
  box.m.updateMatrixWorld(true);

  box.parentKey = emp.parentKey || null;
  box.sceneFolderId = emp.sceneFolderId || null;
  box.hierOrder = emp.hierOrder;
  box.hierCollapsed = emp.hierCollapsed;
  box.editorLocked = emp.editorLocked;
  box.editorHidden = emp.editorHidden;

  const oldKey = `empty:${emp.id}`;
  const newKey = `block:${box.id}`;
  for (const child of getDirectSceneChildren(oldKey)) {
    setParentKeyOfNode(child.obj, newKey);
  }

  if (g) scene.remove(g);
  const idx = (S.emptyObjects || []).indexOf(emp);
  if (idx >= 0) S.emptyObjects.splice(idx, 1);

  syncBlockComponentsState(box);
  return box;
}

// Собирает корневой объект и все его дочерние примитивы из Иерархии Сцены в единый предмет/оружие (itemData)
export function compileSceneHierarchyToItemData(rootBox) {
  if (!rootBox) return null;
  ensureBlockComponents(rootBox);
  if (!rootBox.components.item.itemData) {
    rootBox.components.item.itemData = createStarterItemTemplate('sword');
    rootBox.components.item.itemData.name = rootBox.label || 'Мой Предмет';
  }
  const baseItem = normalizeItemData(JSON.parse(JSON.stringify(rootBox.components.item.itemData)));
  baseItem.name = rootBox.label || baseItem.name || 'Мой Предмет';

  const compiledParts = [];
  const rootM = rootBox.m;
  rootM.updateMatrixWorld(true);
  const rootPos = rootM.position.clone();
  const rootQuat = rootM.quaternion.clone();
  const invRootQuat = rootQuat.clone().invert();

  const pushBlockAsPart = (b, isRootSelf = false) => {
    ensureBlockComponents(b);
    if (!b.components.geometry?.enabled) return;
    if (compiledParts.length >= MAX_ITEM_PARTS) return;

    const bm = b.m;
    bm.updateMatrixWorld(true);
    let locPos = new THREE.Vector3(0, 0, 0);
    let locEuler = new THREE.Euler(0, 0, 0);

    if (!isRootSelf) {
      locPos.copy(bm.position).sub(rootPos).applyQuaternion(invRootQuat).multiplyScalar(0.35);
      const locQuat = invRootQuat.clone().multiply(bm.quaternion);
      locEuler.setFromQuaternion(locQuat);
    }

    const hasVis = Boolean(b.components.visual?.enabled) || b.shape === 'bbmodel';
    const col = hasVis ? (b.colorHex || '#f1f5f9') : '#f1f5f9';
    const ld = b.lightData || {};
    const pd = b.particleData || {};

    const ptShape = b.shape === 'wedge' ? 'box' : (b.shape || 'box');
    const ptBBModel = (b.shape === 'bbmodel' && b.bbmodelData)
      ? JSON.parse(JSON.stringify(b.bbmodelData))
      : null;

    const pt = normalizePartEffects({
      id: 'ipt_' + b.id,
      name: b.label || `Деталь #${compiledParts.length + 1}`,
      shape: ptShape,
      x: Number(locPos.x.toFixed(3)),
      y: Number(locPos.y.toFixed(3)),
      z: Number(locPos.z.toFixed(3)),
      rx: locEuler.x,
      ry: locEuler.y,
      rz: locEuler.z,
      sx: Number(Math.max(0.05, bm.scale.x * 0.35).toFixed(3)),
      sy: Number(Math.max(0.05, bm.scale.y * 0.35).toFixed(3)),
      sz: Number(Math.max(0.05, bm.scale.z * 0.35).toFixed(3)),
      color: col,
      texDataURL: hasVis ? (b.customTexDataURL || null) : null,
      realLight: hasVis && ld.mode === 'point',
      pseudoLight: hasVis && (ld.mode === 'visual' || b.surfaceType === 'neon'),
      lightColor: ld.color || col,
      lightIntensity: ld.intensity || 1.4,
      lightDistance: ld.distance || 12,
      particleData: hasVis && pd.enabled ? JSON.parse(JSON.stringify(pd)) : undefined
    }, false, false);
    if (ptBBModel) pt.bbmodelData = ptBBModel;
    pt.components = { visual: hasVis };
    compiledParts.push(pt);
  };

  const descendants = getAllSceneDescendants(`block:${rootBox.id}`);
  const rootIsContainerOnly = descendants.length > 0 && rootBox.shape !== 'bbmodel' && !rootBox.components.visual?.enabled;
  if (rootBox.components.geometry?.enabled && !rootIsContainerOnly) {
    pushBlockAsPart(rootBox, true);
  }
  for (const d of descendants) {
    if (d.kind === 'block' && d.obj) {
      pushBlockAsPart(d.obj, false);
    }
  }

  if (compiledParts.length > 0) {
    baseItem.parts = compiledParts;
  } else if (!Array.isArray(baseItem.parts) || baseItem.parts.length === 0) {
    baseItem.parts = [
      normalizePartEffects({
        id: 'ipt_root_' + Date.now(),
        name: 'Основа #1',
        shape: 'box',
        x: 0, y: 0, z: 0,
        rx: 0, ry: 0, rz: 0,
        sx: 0.35, sy: 0.9, sz: 0.2,
        color: '#f1f5f9',
        texDataURL: null
      }, false, false)
    ];
    baseItem.parts[0].components = { visual: false };
  }

  rootBox.components.item.itemData = baseItem;
  return baseItem;
}

export function getSceneNodeByKey(nodeKey) {
  if (!nodeKey || typeof nodeKey !== 'string') return null;
  const sep = nodeKey.indexOf(':');
  if (sep < 0) return null;
  const kind = nodeKey.slice(0, sep);
  const id = nodeKey.slice(sep + 1);

  if (kind === 'block') {
    const box = S.allBlocks.find(b => b.id === id);
    return box ? { kind: 'block', id, obj: box, mesh: box.m } : null;
  }
  if (kind === 'world_item') {
    const wi = S.worldItems.find(w => w.id === id);
    return wi ? { kind: 'world_item', id, obj: wi, mesh: wi.group } : null;
  }
  if (kind === 'char') {
    const ent = id === 'player'
      ? S.player
      : (id === 'archangel'
          ? S.archangelEnt
          : (S.customNPCs.find(n => n.id === id) || S.queueLine.find(n => n.id === id)));
    return ent ? { kind: 'char', id, obj: ent, mesh: ent.rig?.g } : null;
  }
  if (kind === 'folder') {
    const sf = (S.sceneFolders || []).find(f => f.id === id);
    return sf ? { kind: 'folder', id, obj: sf, mesh: folderPivotMesh } : null;
  }
  if (kind === 'empty') {
    const emp = (S.emptyObjects || []).find(e => e.id === id);
    return emp ? { kind: 'empty', id, obj: emp, mesh: emp.group } : null;
  }
  return null;
}

export function getKeyFromEditorRef(ref) {
  if (!ref) return null;
  if (ref.kind === 'block' && ref.box) return `block:${ref.box.id}`;
  if (ref.kind === 'world_item' && ref.worldEntry && (!ref.editMode || ref.editMode === 'root')) {
    return `world_item:${ref.worldEntry.id}`;
  }
  if (ref.kind === 'char' && ref.ent && (!ref.editMode || ref.editMode === 'root')) {
    const cid = ref.ent.isP ? 'player' : (ref.ent.isArchangel ? 'archangel' : ref.ent.id);
    return `char:${cid}`;
  }
  if (ref.kind === 'folder' && ref.folder) return `folder:${ref.folder.id}`;
  if (ref.kind === 'empty' && ref.emptyObj) return `empty:${ref.emptyObj.id}`;
  return null;
}

export function getParentKeyOfNode(nodeObj) {
  if (!nodeObj) return null;
  if (nodeObj.parentKey) return nodeObj.parentKey;
  if (nodeObj.sceneFolderId) return `folder:${nodeObj.sceneFolderId}`;
  return null;
}

export function setParentKeyOfNode(nodeObj, nextParentKey) {
  if (!nodeObj) return;
  nodeObj.parentKey = nextParentKey || null;
  if (nextParentKey && nextParentKey.startsWith('folder:')) {
    nodeObj.sceneFolderId = nextParentKey.slice(7);
  } else {
    nodeObj.sceneFolderId = null;
  }
}

export function isDescendantOf(candidateKey, targetAncestorKey) {
  if (!candidateKey || !targetAncestorKey) return false;
  if (candidateKey === targetAncestorKey) return true;
  let curKey = candidateKey;
  let guard = 0;
  while (curKey && guard++ < 64) {
    const info = getSceneNodeByKey(curKey);
    if (!info || !info.obj) break;
    const pKey = getParentKeyOfNode(info.obj);
    if (!pKey) break;
    if (pKey === targetAncestorKey) return true;
    curKey = pKey;
  }
  return false;
}

export function getDirectSceneChildren(parentKey) {
  const res = [];
  if (!parentKey) return res;

  for (const sf of S.sceneFolders || []) {
    if (getParentKeyOfNode(sf) === parentKey) {
      res.push({ kind: 'folder', id: sf.id, key: `folder:${sf.id}`, obj: sf });
    }
  }
  for (const emp of S.emptyObjects || []) {
    if (getParentKeyOfNode(emp) === parentKey) {
      res.push({ kind: 'empty', id: emp.id, key: `empty:${emp.id}`, obj: emp });
    }
  }
  if (S.player && getParentKeyOfNode(S.player) === parentKey) {
    res.push({ kind: 'char', id: 'player', key: 'char:player', obj: S.player });
  }
  if (S.archangelEnt && getParentKeyOfNode(S.archangelEnt) === parentKey) {
    res.push({ kind: 'char', id: 'archangel', key: 'char:archangel', obj: S.archangelEnt });
  }
  for (const npc of S.customNPCs) {
    if (getParentKeyOfNode(npc) === parentKey) {
      res.push({ kind: 'char', id: npc.id, key: `char:${npc.id}`, obj: npc });
    }
  }
  for (const wi of S.worldItems) {
    if (getParentKeyOfNode(wi) === parentKey) {
      res.push({ kind: 'world_item', id: wi.id, key: `world_item:${wi.id}`, obj: wi });
    }
  }
  for (const b of S.allBlocks) {
    if (getParentKeyOfNode(b) === parentKey) {
      res.push({ kind: 'block', id: b.id, key: `block:${b.id}`, obj: b });
    }
  }
  return res;
}

export function getAllSceneDescendants(parentKey, out = [], visited = new Set()) {
  if (!parentKey || visited.has(parentKey)) return out;
  visited.add(parentKey);
  const direct = getDirectSceneChildren(parentKey);
  for (const ch of direct) {
    out.push(ch);
    getAllSceneDescendants(ch.key, out, visited);
  }
  return out;
}

// Находит корневого родителя в иерархии для логики выделения как в Unity (1-й клик -> корень структуры, 2-й клик -> конкретная часть)
export function getTopMostParentEditorRef(baseRef) {
  const startKey = getKeyFromEditorRef(baseRef);
  if (!startKey) return baseRef;

  let topKey = startKey;
  let guard = 0;
  while (guard++ < 64) {
    const info = getSceneNodeByKey(topKey);
    if (!info || !info.obj) break;
    const pKey = getParentKeyOfNode(info.obj);
    if (!pKey) break;
    const pInfo = getSceneNodeByKey(pKey);
    if (!pInfo) break;
    topKey = pKey;
  }

  if (topKey === startKey) return baseRef;
  const topInfo = getSceneNodeByKey(topKey);
  if (!topInfo) return baseRef;

  if (topInfo.kind === 'block') return { kind: 'block', box: topInfo.obj };
  if (topInfo.kind === 'world_item') {
    return {
      kind: 'world_item',
      worldEntry: topInfo.obj,
      item: topInfo.obj.item,
      editMode: 'root',
      partIdx: 0,
      inWorldPlacement: true
    };
  }
  if (topInfo.kind === 'char') return { kind: 'char', ent: topInfo.obj, editMode: 'root' };
  if (topInfo.kind === 'folder') return { kind: 'folder', folder: topInfo.obj };
  if (topInfo.kind === 'empty') return { kind: 'empty', emptyObj: topInfo.obj };
  return baseRef;
}

// Вычисляет центр всех дочерних объектов папки для установки Гизмо папки
export function syncFolderPivotToChildren(folder) {
  if (!folder) return folderPivotMesh;
  const desc = getAllSceneDescendants(`folder:${folder.id}`);
  const meshDesc = desc.filter(d => d.kind !== 'folder');
  if (meshDesc.length === 0) {
    folderPivotMesh.position.set(folder.x || 0, folder.y || 2, folder.z || 0);
  } else {
    let sx = 0, sy = 0, sz = 0, cnt = 0;
    for (const d of meshDesc) {
      const info = getSceneNodeByKey(d.key);
      if (info && info.mesh) {
        sx += info.mesh.position.x;
        sy += info.mesh.position.y;
        sz += info.mesh.position.z;
        cnt++;
      }
    }
    if (cnt > 0) {
      folderPivotMesh.position.set(sx / cnt, sy / cnt, sz / cnt);
    }
  }
  folderPivotMesh.rotation.set(0, 0, 0);
  folderPivotMesh.scale.set(1, 1, 1);
  folderPivotMesh.updateMatrixWorld(true);
  return folderPivotMesh;
}

// Проверяет, является ли candidatePartId потомком targetAncestorId в иерархии parentPartId
export function isPartDescendantOf(partsArr, candidatePartId, targetAncestorId) {
  if (!Array.isArray(partsArr) || !candidatePartId || !targetAncestorId) return false;
  if (candidatePartId === targetAncestorId) return true;
  let curId = candidatePartId;
  let guard = 0;
  while (curId && guard++ < 128) {
    const pt = partsArr.find(p => p && p.id === curId);
    if (!pt || !pt.parentPartId) break;
    if (pt.parentPartId === targetAncestorId) return true;
    curId = pt.parentPartId;
  }
  return false;
}

// Запоминает точное начальное состояние родителя и всех уровней его дочерних элементов перед трансформацией
export function recordHierarchyBaseline(ref = S.selectedRef) {
  _hasBaseline = false;
  _baselineChildrenMap.clear();
  _baselinePartsMap.clear();
  if (!ref) return;
  const mesh = ref.mesh || ref.box?.m || ref.ent?.rig?.g || ref.worldEntry?.group || ref.emptyObj?.group;
  if (!mesh) return;
  mesh.updateMatrixWorld(true);
  _baselineMatrix.copy(mesh.matrixWorld);
  mesh.getWorldPosition(_prevParentPos);
  mesh.getWorldQuaternion(_prevParentQuat);
  _prevParentQuat.normalize();

  _baseLocalPos.copy(mesh.position);
  _baseLocalQuat.copy(mesh.quaternion).normalize();

  // Снапшот вложенных деталей внутри предмета или аксессуара
  if (
    (ref.kind === 'world_item' && (ref.editMode === 'part' || ref.editMode === 'proj_part')) ||
    (ref.kind === 'cosmetic' && ref.editMode === 'part')
  ) {
    const parentPart = ref.part;
    const partsArr = ref.kind === 'cosmetic'
      ? ref.item?.parts
      : (ref.editMode === 'proj_part' ? ref.item?.projectileParts : ref.item?.parts);
    const partMeshes = (ref.kind === 'cosmetic'
      ? ref.group?.userData?.partMeshes
      : (ref.editMode === 'proj_part' ? ref.projPreviewGroup?.userData?.partMeshes : ref.worldEntry?.group?.userData?.partMeshes)) || [];

    if (parentPart && parentPart.id && Array.isArray(partsArr)) {
      for (let i = 0; i < partsArr.length; i++) {
        const pt = partsArr[i];
        const pm = partMeshes[i];
        if (!pt || !pm || pt.id === parentPart.id) continue;
        if (isPartDescendantOf(partsArr, pt.id, parentPart.id)) {
          _baselinePartsMap.set(pt.id, {
            pos: pm.position.clone(),
            quat: pm.quaternion.clone().normalize()
          });
        }
      }
    }
  }

  // Снапшот дочерних объектов сцены (на любой глубине иерархии)
  const parentKey = getKeyFromEditorRef(ref);
  if (parentKey) {
    const descendants = getAllSceneDescendants(parentKey);
    for (const d of descendants) {
      const m = d.kind === 'block'
        ? d.obj?.m
        : (d.kind === 'world_item' ? d.obj?.group : (d.kind === 'char' ? d.obj?.rig?.g : d.obj?.group));
      if (m) {
        m.updateMatrixWorld(true);
        _baselineChildrenMap.set(d.key, {
          pos: m.position.clone(),
          quat: m.quaternion.clone().normalize()
        });
      }
    }
  }

  _hasBaseline = true;
}

// Применяет трансформацию от начального снапшота (Baseline -> Current) ко всем уровням дочерних объектов без накопления погрешности
export function propagateHierarchyTransform(ref = S.selectedRef) {
  if (!_hasBaseline || !ref) return;
  const rootMesh = ref.mesh || ref.box?.m || ref.ent?.rig?.g || ref.worldEntry?.group || ref.emptyObj?.group;
  if (!rootMesh) return;

  rootMesh.updateMatrixWorld(true);
  rootMesh.getWorldPosition(_currParentPos);
  rootMesh.getWorldQuaternion(_currParentQuat);
  _currParentQuat.normalize();

  // Чистый поворот относительно начального состояния (Baseline -> Current)
  _invPrevQuat.copy(_prevParentQuat).invert();
  _stepQuat.copy(_currParentQuat).multiply(_invPrevQuat).normalize();

  // 1. Если трансформируется деталь внутри предмета/аксессуара, у которой есть дочерние детали (любой глубины вложенности)
  if (
    (ref.kind === 'world_item' && (ref.editMode === 'part' || ref.editMode === 'proj_part')) ||
    (ref.kind === 'cosmetic' && ref.editMode === 'part')
  ) {
    const parentPart = ref.part;
    if (parentPart && parentPart.id && _baselinePartsMap.size > 0) {
      const partsArr = ref.kind === 'cosmetic'
        ? ref.item.parts
        : (ref.editMode === 'proj_part' ? ref.item.projectileParts : ref.item.parts);
      const partMeshes = (ref.kind === 'cosmetic'
        ? ref.group?.userData?.partMeshes
        : (ref.editMode === 'proj_part' ? ref.projPreviewGroup?.userData?.partMeshes : ref.worldEntry?.group?.userData?.partMeshes)) || [];

      _invBaseLocalQuat.copy(_baseLocalQuat).invert();
      _localDeltaQuat.copy(rootMesh.quaternion).normalize().multiply(_invBaseLocalQuat).normalize();

      for (let i = 0; i < partsArr.length; i++) {
        const pt = partsArr[i];
        const pm = partMeshes[i];
        if (!pt || !pm) continue;
        const initSnap = _baselinePartsMap.get(pt.id);
        if (!initSnap) continue;

        _childOffset.subVectors(initSnap.pos, _baseLocalPos).applyQuaternion(_localDeltaQuat);
        pm.position.copy(rootMesh.position).add(_childOffset);

        pm.quaternion.copy(_localDeltaQuat).multiply(initSnap.quat).normalize();
        pm.rotation.setFromQuaternion(pm.quaternion);

        pt.x = pm.position.x;
        pt.y = pm.position.y;
        pt.z = pm.position.z;
        pt.rx = pm.rotation.x;
        pt.ry = pm.rotation.y;
        pt.rz = pm.rotation.z;
        pm.updateMatrixWorld(true);
      }
    }
    return;
  }

  // 2. Трансформация дочерних объектов сцены (работает и на карте, и для иерархий блоков на подиуме 3D STUDIO)
  if (S.itemStudioOpen && ref.kind !== 'block' && ref.kind !== 'empty' && ref.kind !== 'folder') return;
  const parentKey = getKeyFromEditorRef(ref);
  if (!parentKey) return;

  const descendants = getAllSceneDescendants(parentKey);
  if (descendants.length === 0) return;

  for (const d of descendants) {
    const initSnap = _baselineChildrenMap.get(d.key);
    if (d.kind === 'block') {
      const box = d.obj;
      const m = box.m;
      if (!m || !initSnap) continue;

      _childOffset.subVectors(initSnap.pos, _prevParentPos).applyQuaternion(_stepQuat);
      m.position.copy(_currParentPos).add(_childOffset);

      m.quaternion.copy(_stepQuat).multiply(initSnap.quat).normalize();
      m.rotation.setFromQuaternion(m.quaternion);

      m.scale.set(box.w, box.h, box.d);

      box.cx = m.position.x;
      box.cy = m.position.y;
      box.cz = m.position.z;
      box.x = m.position.x;
      box.y = m.position.y + box.h / 2;
      box.z = m.position.z;
      box.rx = m.rotation.x;
      box.ry = m.rotation.y;
      box.rz = m.rotation.z;
      if (box.logicRuntime) {
        box.logicRuntime.basePos = m.position.clone();
        box.logicRuntime.baseQuat = m.quaternion.clone();
      }
      if (box.cpVisualGroup) {
        box.cpVisualGroup.position.copy(m.position);
        if (box.checkpointData?.enabled) box.cpVisualGroup.rotation.copy(m.rotation);
      }
      if (box.haloSprite) box.haloSprite.position.copy(box.m.position);
      m.updateMatrixWorld(true);
    } else if (d.kind === 'world_item') {
      const wi = d.obj;
      const g = wi.group;
      if (!g || !initSnap) continue;

      _childOffset.subVectors(initSnap.pos, _prevParentPos).applyQuaternion(_stepQuat);
      g.position.copy(_currParentPos).add(_childOffset);

      g.quaternion.copy(_stepQuat).multiply(initSnap.quat).normalize();
      g.rotation.setFromQuaternion(g.quaternion);

      wi.x = g.position.x;
      wi.y = g.position.y;
      wi.z = g.position.z;
      wi.rotX = g.rotation.x;
      wi.rotY = g.rotation.y;
      wi.rotZ = g.rotation.z;
      if (wi.tag) {
        wi.tag.position.set(wi.x, wi.y + 1.65 * Math.max(1, g.scale.y), wi.z);
      }
      g.updateMatrixWorld(true);
    } else if (d.kind === 'char') {
      const ent = d.obj;
      const g = ent.rig?.g;
      if (!g || !initSnap) continue;

      _childOffset.subVectors(initSnap.pos, _prevParentPos).applyQuaternion(_stepQuat);
      g.position.copy(_currParentPos).add(_childOffset);

      g.quaternion.copy(_stepQuat).multiply(initSnap.quat).normalize();
      g.rotation.setFromQuaternion(g.quaternion);

      ent.x = g.position.x;
      ent.y = g.position.y;
      ent.z = g.position.z;
      ent.rot = g.rotation.y;
      ent.yaw = g.rotation.y;
      if (ent.isCustomNPC) {
        ent.homeX = ent.x;
        ent.homeZ = ent.z;
      }
      if (ent.tag) {
        ent.tag.position.set(ent.x, ent.y + (ent.isArchangel ? 4.5 : 3.35), ent.z);
      }
      g.updateMatrixWorld(true);
    } else if (d.kind === 'empty') {
      const emp = d.obj;
      const g = emp.group;
      if (!g || !initSnap) continue;

      _childOffset.subVectors(initSnap.pos, _prevParentPos).applyQuaternion(_stepQuat);
      g.position.copy(_currParentPos).add(_childOffset);

      g.quaternion.copy(_stepQuat).multiply(initSnap.quat).normalize();
      g.rotation.setFromQuaternion(g.quaternion);

      emp.x = g.position.x;
      emp.y = g.position.y;
      emp.z = g.position.z;
      emp.rx = g.rotation.x;
      emp.ry = g.rotation.y;
      emp.rz = g.rotation.z;
      g.updateMatrixWorld(true);
    }
  }

  rebuildPhysicsArrays();
}

/* ---------- 3D THUMBNAIL GENERATOR (HIGH-RES OFFSCREEN RENDER TARGET) ---------- */

const THUMB_SIZE = 128;
let thumbScene = null;
let thumbCamera = null;
let thumbStageHolder = null;
let thumbRT = null;
let thumbPixelBuffer = null;
let thumbOutCanvas = null;
let thumbOutCtx = null;
let thumbImgData = null;

const prefabThumbCache = new Map();
const itemThumbCache = new Map();
const cosmeticThumbCache = new Map();

function ensureThumbnailRenderer() {
  if (thumbScene) return;

  thumbScene = new THREE.Scene();
  thumbCamera = new THREE.PerspectiveCamera(32, 1, 0.05, 100);

  const amb = new THREE.HemisphereLight(0xffffff, 0x334155, 1.2);
  thumbScene.add(amb);

  const dirKey = new THREE.DirectionalLight(0xfff8e7, 1.45);
  dirKey.position.set(5, 8, 6);
  thumbScene.add(dirKey);

  const dirRim = new THREE.DirectionalLight(0x56f0ff, 0.8);
  dirRim.position.set(-6, 3, -5);
  thumbScene.add(dirRim);

  thumbStageHolder = new THREE.Group();
  thumbScene.add(thumbStageHolder);

  thumbRT = new THREE.WebGLRenderTarget(THUMB_SIZE, THUMB_SIZE, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    format: THREE.RGBAFormat,
    depthBuffer: true,
    stencilBuffer: false
  });

  thumbPixelBuffer = new Uint8Array(THUMB_SIZE * THUMB_SIZE * 4);
  thumbOutCanvas = document.createElement('canvas');
  thumbOutCanvas.width = THUMB_SIZE;
  thumbOutCanvas.height = THUMB_SIZE;
  thumbOutCtx = thumbOutCanvas.getContext('2d');
  thumbImgData = thumbOutCtx.createImageData(THUMB_SIZE, THUMB_SIZE);
}

const _thumbBox = new THREE.Box3();
const _thumbMeshBox = new THREE.Box3();
const _thumbCenter = new THREE.Vector3();
const _thumbSize = new THREE.Vector3();
const _prevViewport = new THREE.Vector4();
const _prevScissor = new THREE.Vector4();

function computeVisualBounds(rootObj) {
  _thumbBox.makeEmpty();
  rootObj.updateMatrixWorld(true);
  rootObj.traverse(o => {
    if (!o.isMesh || !o.visible) return;
    if (
      o.userData?.isRootHitbox ||
      o.userData?.isCharPickMesh ||
      o.userData?.isHaloSprite ||
      o.userData?.isGripMarker ||
      o.userData?.isMuzzleMarker
    ) {
      return;
    }
    if (o.geometry) {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
      _thumbMeshBox.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
      _thumbBox.union(_thumbMeshBox);
    }
  });
  if (_thumbBox.isEmpty()) {
    _thumbBox.min.set(-0.5, -0.5, -0.5);
    _thumbBox.max.set(0.5, 0.5, 0.5);
  }
  return _thumbBox;
}

export function renderObject3DToDataURL(object3D, viewOpts = {}) {
  ensureThumbnailRenderer();

  while (thumbStageHolder.children.length > 0) {
    thumbStageHolder.remove(thumbStageHolder.children[0]);
  }

  const wrapper = new THREE.Group();
  wrapper.add(object3D);
  const rotY = viewOpts.rotY !== undefined ? viewOpts.rotY : -0.58;
  const rotX = viewOpts.rotX !== undefined ? viewOpts.rotX : 0.14;
  wrapper.rotation.set(rotX, rotY, 0);
  thumbStageHolder.add(wrapper);

  const bounds = computeVisualBounds(wrapper);
  bounds.getCenter(_thumbCenter);
  bounds.getSize(_thumbSize);

  wrapper.position.sub(_thumbCenter);
  thumbStageHolder.updateMatrixWorld(true);

  const maxDim = Math.max(0.25, _thumbSize.x, _thumbSize.y, _thumbSize.z);
  const fovRad = THREE.MathUtils.degToRad(thumbCamera.fov);
  const dist = (maxDim / (2 * Math.tan(fovRad / 2))) * (viewOpts.padding || 1.12);

  thumbCamera.position.set(0, dist * 0.22, dist);
  thumbCamera.lookAt(0, 0, 0);
  thumbCamera.updateProjectionMatrix();

  const prevTarget = renderer.getRenderTarget();
  const prevClearColor = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();
  const prevShadowAuto = renderer.shadowMap.autoUpdate;
  renderer.getViewport(_prevViewport);
  renderer.getScissor(_prevScissor);

  renderer.shadowMap.autoUpdate = false;
  renderer.setRenderTarget(thumbRT);
  renderer.setViewport(0, 0, THUMB_SIZE, THUMB_SIZE);
  renderer.setClearColor(0x000000, 0);
  renderer.clear(true, true, true);
  renderer.render(thumbScene, thumbCamera);
  renderer.readRenderTargetPixels(thumbRT, 0, 0, THUMB_SIZE, THUMB_SIZE, thumbPixelBuffer);

  renderer.setRenderTarget(prevTarget);
  renderer.setViewport(_prevViewport);
  renderer.setScissor(_prevScissor);
  renderer.setClearColor(prevClearColor, prevClearAlpha);
  renderer.shadowMap.autoUpdate = prevShadowAuto;

  const dst = thumbImgData.data;
  const rowBytes = THUMB_SIZE * 4;
  for (let y = 0; y < THUMB_SIZE; y++) {
    const srcRow = (THUMB_SIZE - 1 - y) * rowBytes;
    const dstRow = y * rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      dst[dstRow + i] = thumbPixelBuffer[srcRow + i];
    }
  }

  thumbOutCtx.clearRect(0, 0, THUMB_SIZE, THUMB_SIZE);
  thumbOutCtx.putImageData(thumbImgData, 0, 0);

  while (thumbStageHolder.children.length > 0) {
    thumbStageHolder.remove(thumbStageHolder.children[0]);
  }

  return thumbOutCanvas.toDataURL('image/png');
}

function buildPrefabPreviewModel(spawnKey) {
  const g = new THREE.Group();
  if (spawnKey === 'prim_empty') {
    const helper = createBlockPivotHelperMesh();
    helper.scale.setScalar(4.2);
    g.add(helper);
    return { model: g, rotY: -0.6, rotX: 0.25, padding: 1.2 };
  }
  if (spawnKey && spawnKey.startsWith('prim_')) {
    const shape = spawnKey.replace('prim_', '');
    const geo = createBlockGeometryByShape(shape);
    const mat = new THREE.MeshStandardMaterial({
      color: 0xf1f5f9,
      roughness: 0.35,
      metalness: 0.08
    });
    const m = new THREE.Mesh(geo, mat);
    m.scale.setScalar(2.2);
    if (shape === 'torus') m.rotation.x = 0.45;
    g.add(m);
    return { model: g, rotY: -0.6, rotX: 0.24, padding: 1.15 };
  }

  if (spawnKey && spawnKey.startsWith('item_')) {
    const presetKey = spawnKey.replace('item_', '');
    const itemData = createStarterItemTemplate(presetKey);
    const itemGrp = buildItemGroup(itemData, { isProjectile: false, showMarkers: false, applyGripOffset: false });
    return { model: itemGrp, rotY: 0.65, rotX: 0.22, padding: 1.08 };
  }

  if (spawnKey === 'npc') {
    const rig = createRobloxRig({
      head: 0xf5cd30,
      torso: 0xe74c3c,
      armL: 0xf5cd30,
      armR: 0xf5cd30,
      legL: 0x2c3e50,
      legR: 0x2c3e50
    }, 1, false);
    const fc = document.createElement('canvas');
    fc.width = fc.height = 128;
    drawFacePresetOnCtx(fc.getContext('2d'), null, 'classic');
    const fTex = new THREE.CanvasTexture(fc);
    const decal = new THREE.Mesh(
      new THREE.PlaneGeometry(0.68, 0.68),
      new THREE.MeshBasicMaterial({ map: fTex, transparent: true, depthWrite: false })
    );
    decal.position.set(0, 0.34, 0.345);
    rig.head.add(decal);
    rig.armR.rotation.x = -0.65;
    rig.armL.rotation.x = 0.35;
    rig.legL.rotation.x = -0.3;
    rig.legR.rotation.x = 0.3;
    return { model: rig.g, rotY: -0.45, rotX: 0.08, padding: 1.08 };
  }

  if (spawnKey === 'solid') {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 2.5, 2.5),
      createBlockMaterial('#56f0ff', 2, 2, false, null, 'solid')
    );
    g.add(m);
  } else if (spawnKey === 'liquid') {
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 1.6, 2.6),
      new THREE.MeshStandardMaterial({ color: '#0066cc', roughness: 0.2 })
    );
    const wave = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 2.0, 3.0),
      createBlockMaterial('#00a8ff', 2, 2, false, null, 'liquid')
    );
    g.add(core, wave);
  } else if (spawnKey === 'gas') {
    const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85 });
    const s1 = new THREE.Mesh(new THREE.SphereGeometry(1.0, 14, 12), mat);
    const s2 = new THREE.Mesh(new THREE.SphereGeometry(0.78, 14, 12), mat);
    s2.position.set(-0.85, -0.15, 0.2);
    const s3 = new THREE.Mesh(new THREE.SphereGeometry(0.82, 14, 12), mat);
    s3.position.set(0.85, -0.1, -0.15);
    g.add(s1, s2, s3);
  } else if (spawnKey === 'checkpoint') {
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(3.2, 0.7, 3.2),
      createBlockMaterial('#ffeaa7', 2, 2, true, null, 'solid')
    );
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(1.15, 1.15, 0.25, 20),
      new THREE.MeshStandardMaterial({ color: 0x00e676, emissive: 0x00a850, emissiveIntensity: 0.5 })
    );
    pad.position.y = 0.45;
    g.add(base, pad);
  } else if (spawnKey === 'door') {
    const door = new THREE.Mesh(
      new THREE.BoxGeometry(2.8, 3.4, 0.6),
      createBlockMaterial('#f39c12', 2, 2, true, null, 'solid')
    );
    const handle = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.2, 0.8, 12),
      new THREE.MeshStandardMaterial({ color: 0x00e676, emissive: 0x00e676, emissiveIntensity: 0.6 })
    );
    handle.rotation.x = Math.PI / 2;
    handle.position.set(0.85, 0, 0);
    g.add(door, handle);
  } else if (spawnKey === 'button') {
    const stand = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 1.7, 1.3),
      createBlockMaterial('#334155', 1, 1, false, null, 'solid')
    );
    const btn = new THREE.Mesh(
      new THREE.CylinderGeometry(0.48, 0.48, 0.38, 16),
      new THREE.MeshStandardMaterial({ color: 0x00e676, emissive: 0x00e676, emissiveIntensity: 0.8 })
    );
    btn.position.y = 0.95;
    g.add(stand, btn);
  } else if (spawnKey === 'plate') {
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.3, 3.0),
      new THREE.MeshStandardMaterial({ color: 0x1e293b })
    );
    const top = new THREE.Mesh(
      new THREE.BoxGeometry(2.5, 0.3, 2.5),
      new THREE.MeshStandardMaterial({ color: 0xffce3a, emissive: 0xd35400, emissiveIntensity: 0.45 })
    );
    top.position.y = 0.22;
    g.add(base, top);
  } else if (spawnKey === 'teleport') {
    const padA = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.2, 0.4, 20),
      new THREE.MeshStandardMaterial({ color: 0x00d2ff, emissive: 0x0088cc, emissiveIntensity: 0.7 })
    );
    padA.position.set(-0.95, -0.2, 0.4);
    const ringA = new THREE.Mesh(
      new THREE.TorusGeometry(0.95, 0.12, 10, 24),
      new THREE.MeshBasicMaterial({ color: 0x56f0ff })
    );
    ringA.rotation.x = Math.PI / 2;
    ringA.position.set(-0.95, 0.25, 0.4);

    const padB = new THREE.Mesh(
      new THREE.CylinderGeometry(1.1, 1.2, 0.4, 20),
      new THREE.MeshStandardMaterial({ color: 0xa29bfe, emissive: 0x6c5ce7, emissiveIntensity: 0.7 })
    );
    padB.position.set(0.95, 0.2, -0.4);
    g.add(padA, ringA, padB);
  } else if (spawnKey === 'vip_gate') {
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.5, roughness: 0.25 });
    const topBar = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.42, 0.55), frameMat);
    topBar.position.y = 1.4;
    const botBar = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.42, 0.55), frameMat);
    botBar.position.y = -1.4;
    g.add(topBar, botBar);
    for (let x = -1.2; x <= 1.2; x += 0.6) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 2.6, 10), frameMat);
      bar.position.x = x;
      g.add(bar);
    }
  } else if (spawnKey === 'shop_pad') {
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.65, 3.0),
      createBlockMaterial('#00e676', 2, 2, true, null, 'solid')
    );
    const coil = new THREE.Mesh(
      new THREE.TorusGeometry(0.72, 0.2, 12, 24),
      new THREE.MeshStandardMaterial({ color: 0xffce3a, emissive: 0xf39c12, emissiveIntensity: 0.5 })
    );
    coil.position.y = 0.95;
    g.add(pad, coil);
  } else if (spawnKey === 'kill') {
    const laser = new THREE.Mesh(
      new THREE.BoxGeometry(3.4, 0.65, 0.95),
      new THREE.MeshStandardMaterial({ color: 0xff1e1e, emissive: 0xff0000, emissiveIntensity: 1.2 })
    );
    g.add(laser);
  } else if (spawnKey === 'trampoline') {
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.7, 1.85, 0.4, 20),
      new THREE.MeshStandardMaterial({ color: 0x1e293b })
    );
    const mat = new THREE.Mesh(
      new THREE.CylinderGeometry(1.45, 1.45, 0.45, 20),
      new THREE.MeshStandardMaterial({ color: 0x00e676, emissive: 0x00b862, emissiveIntensity: 0.4 })
    );
    mat.position.y = 0.18;
    g.add(base, mat);
  } else if (spawnKey === 'spawner') {
    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(3.0, 0.65, 3.0),
      createBlockMaterial('#9b59b6', 2, 2, true, null, 'solid')
    );
    const coin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.78, 0.78, 0.24, 20),
      new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.6, roughness: 0.2 })
    );
    coin.rotation.x = Math.PI / 2;
    coin.position.y = 1.05;
    g.add(pad, coin);
  } else if (spawnKey === 'media_screen') {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(3.6, 2.2, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x111827, roughness: 0.35, metalness: 0.4 })
    );
    const display = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 1.85),
      new THREE.MeshBasicMaterial({ color: 0x00d2ff })
    );
    display.position.z = 0.19;
    g.add(frame, display);
  } else if (spawnKey === 'media_speaker') {
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 2.4, 1.4),
      new THREE.MeshStandardMaterial({ color: 0x1e293b, roughness: 0.45 })
    );
    const woofer = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 0.12, 20),
      new THREE.MeshStandardMaterial({ color: 0x00e676, emissive: 0x00a850, emissiveIntensity: 0.45 })
    );
    woofer.rotation.x = Math.PI / 2;
    woofer.position.set(0, -0.35, 0.68);
    const tweeter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.3, 0.3, 0.12, 18),
      new THREE.MeshStandardMaterial({ color: 0x56f0ff, emissive: 0x00a2ff, emissiveIntensity: 0.45 })
    );
    tweeter.rotation.x = Math.PI / 2;
    tweeter.position.set(0, 0.55, 0.68);
    g.add(body, woofer, tweeter);
  } else {
    const m = new THREE.Mesh(
      new THREE.BoxGeometry(2, 2, 2),
      createBlockMaterial('#56f0ff', 1, 1, false, null, 'solid')
    );
    g.add(m);
  }

  return { model: g, rotY: -0.62, rotX: 0.24, padding: 1.1 };
}

export function getPrefab3DThumbnail(spawnKey) {
  if (prefabThumbCache.has(spawnKey)) {
    return prefabThumbCache.get(spawnKey);
  }
  const spec = buildPrefabPreviewModel(spawnKey);
  const url = renderObject3DToDataURL(spec.model, spec);
  prefabThumbCache.set(spawnKey, url);
  return url;
}

export function getPrimitive3DThumbnail(shape = 'box', colorHex = '#56f0ff') {
  const cacheKey = `prim_${shape}_${colorHex}`;
  if (prefabThumbCache.has(cacheKey)) {
    return prefabThumbCache.get(cacheKey);
  }
  const geo = shape === 'wedge' ? createBlockGeometryByShape('wedge') : getSharedPrimitiveGeo(shape);
  const mat = new THREE.MeshStandardMaterial({
    color: colorHex,
    roughness: 0.28,
    metalness: 0.18,
    side: THREE.DoubleSide
  });
  const mesh = new THREE.Mesh(geo, mat);
  if (shape === 'torus') mesh.rotation.x = 0.45;
  const url = renderObject3DToDataURL(mesh, { rotY: -0.6, rotX: 0.25, padding: 1.15 });
  prefabThumbCache.set(cacheKey, url);
  return url;
}

export function getItem3DThumbnail(itemData, forceRefresh = false) {
  if (!itemData) return '';
  const norm = normalizeItemData(itemData);
  const sig = JSON.stringify({
    p: norm.parts,
    rx: norm.rootRX,
    ry: norm.rootRY,
    rz: norm.rootRZ,
    sx: norm.rootSX,
    sy: norm.rootSY,
    sz: norm.rootSZ
  });
  if (!forceRefresh && itemThumbCache.has(sig)) {
    return itemThumbCache.get(sig);
  }
  const grp = buildItemGroup(norm, { isProjectile: false, showMarkers: false, applyGripOffset: false });
  const url = renderObject3DToDataURL(grp, { rotY: 0.65, rotX: 0.22, padding: 1.1 });
  itemThumbCache.set(sig, url);
  return url;
}

export function getCosmetic3DThumbnail(cosData, forceRefresh = false) {
  if (!cosData) return '';
  const norm = normalizeCosmeticItem(cosData);
  const sig = JSON.stringify({
    p: norm.parts,
    rx: norm.rootRX,
    ry: norm.rootRY,
    rz: norm.rootRZ,
    sx: norm.rootSX,
    sy: norm.rootSY,
    sz: norm.rootSZ
  });
  if (!forceRefresh && cosmeticThumbCache.has(sig)) {
    return cosmeticThumbCache.get(sig);
  }
  const grp = buildCustomCosmeticGroup(norm);
  grp.visible = true;
  const url = renderObject3DToDataURL(grp, { rotY: -0.55, rotX: 0.2, padding: 1.1 });
  cosmeticThumbCache.set(sig, url);
  return url;
}

function getCustomBlockPrefabThumbnail(blkSnap) {
  if (blkSnap.shape === 'bbmodel' && blkSnap.bbmodelData) {
    const bbmSig = 'cblk_bbm_' + (blkSnap.bbmodelData.id || blkSnap.bbmodelData.name);
    if (prefabThumbCache.has(bbmSig)) return prefabThumbCache.get(bbmSig);
    const grp = buildBBModelGroup(blkSnap.bbmodelData, blkSnap.colorHex || '#ffffff');
    const url = grp ? renderObject3DToDataURL(grp, { rotY: -0.6, rotX: 0.22, padding: 1.15 }) : '';
    prefabThumbCache.set(bbmSig, url);
    return url;
  }
  const sig = 'cblk_' + JSON.stringify({
    s: blkSnap.shape,
    w: blkSnap.w,
    h: blkSnap.h,
    d: blkSnap.d,
    c: blkSnap.colorHex,
    m: blkSnap.matterState,
    g: blkSnap.gold
  });
  if (prefabThumbCache.has(sig)) return prefabThumbCache.get(sig);
  let geo;
  if (blkSnap.shape === 'cylinder') geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 18);
  else if (blkSnap.shape === 'sphere') geo = new THREE.SphereGeometry(0.5, 16, 12);
  else geo = new THREE.BoxGeometry(1, 1, 1);

  const mat = createBlockMaterial(blkSnap.colorHex || '#56f0ff', 2, 2, !!blkSnap.gold, null, blkSnap.matterState || 'solid');
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(
    Math.min(4, Math.max(0.5, blkSnap.w || 2)),
    Math.min(4, Math.max(0.5, blkSnap.h || 1)),
    Math.min(4, Math.max(0.5, blkSnap.d || 2))
  );
  const url = renderObject3DToDataURL(mesh, { rotY: -0.6, rotX: 0.24, padding: 1.12 });
  prefabThumbCache.set(sig, url);
  return url;
}

/* ---------- НАПОЛНЕНИЕ КАРТОЧЕК ПРИМИТИВОВ И ДОК-ПАНЕЛИ ПРЕФАБОВ ---------- */

export function populateStudioCardThumbnails() {
  const primColors = {
    box: '#56f0ff',
    sphere: '#00e676',
    cylinder: '#ffce3a',
    cone: '#ff6b6b',
    torus: '#a29bfe',
    plane: '#ff9f43'
  };

  document.querySelectorAll('.prim-card[data-prim]').forEach(btn => {
    const shape = btn.dataset.prim;
    if (!shape || btn.querySelector('img')) return;
    const labelTxt = PRIMITIVE_LABELS_RU[shape] || btn.textContent.trim();
    const thumbURL = getPrimitive3DThumbnail(shape, primColors[shape] || '#56f0ff');
    btn.innerHTML = `<img class="prim-thumb-img" src="${thumbURL}" alt="${shape}"><span>${labelTxt}</span>`;
  });

  refreshPrefabDockUI();
}

function getAllAvailablePrefabCards() {
  const cards = [];

  for (const b of BUILTIN_PREFAB_CATALOG) {
    cards.push({
      id: b.key,
      spawnKey: b.key,
      title: b.title,
      category: b.category,
      border: b.border,
      thumb: getPrefab3DThumbnail(b.key),
      isCustom: false
    });
  }

  const savedItems = S.savedItemsLibrary || [];
  for (let i = 0; i < savedItems.length; i++) {
    const it = savedItems[i];
    if (!it) continue;
    cards.push({
      id: `lib_item_${i}`,
      spawnKey: `lib_item_${i}`,
      title: it.name || `Предмет #${i + 1}`,
      category: 'library',
      border: '#ff9f43',
      thumb: getItem3DThumbnail(it),
      isCustom: true,
      libType: 'saved_item',
      libIdx: i
    });
  }

  const savedCos = S.savedCosmeticsLibrary || [];
  for (let i = 0; i < savedCos.length; i++) {
    const c = savedCos[i];
    if (!c) continue;
    cards.push({
      id: `lib_cos_${i}`,
      spawnKey: `lib_cos_${i}`,
      title: c.name || `Аксессуар #${i + 1}`,
      category: 'library',
      border: '#d6a2e8',
      thumb: getCosmetic3DThumbnail(c),
      isCustom: true,
      libType: 'saved_cos',
      libIdx: i
    });
  }

  const customPrefabs = S.customPrefabsLibrary || [];
  for (let i = 0; i < customPrefabs.length; i++) {
    const cp = customPrefabs[i];
    if (!cp) continue;
    let thumb = '';
    if (cp.kind === 'block' && cp.data) thumb = getCustomBlockPrefabThumbnail(cp.data);
    else if (cp.kind === 'world_item' && cp.data) thumb = getItem3DThumbnail(cp.data);
    else if (cp.kind === 'cosmetic' && cp.data) thumb = getCosmetic3DThumbnail(cp.data);
    else thumb = getPrefab3DThumbnail('npc');

    cards.push({
      id: cp.id,
      spawnKey: `custom_prefab_${cp.id}`,
      title: cp.title || 'Мой Префаб',
      category: 'library',
      border: '#00e676',
      thumb,
      isCustom: true,
      libType: 'custom_prefab',
      customPrefabId: cp.id
    });
  }

  const customModels = S.customModelsLibrary || [];
  for (let i = 0; i < customModels.length; i++) {
    const m = customModels[i];
    if (!m) continue;
    cards.push({
      id: `lib_bbm_${i}`,
      spawnKey: `lib_bbm_${i}`,
      title: `📦 ${m.name || ('BBModel #' + (i + 1))}`,
      category: 'library',
      border: '#a29bfe',
      thumb: getCustomBlockPrefabThumbnail({ shape: 'bbmodel', bbmodelData: m, colorHex: '#ffffff' }),
      isCustom: true,
      libType: 'saved_bbmodel',
      libIdx: i
    });
  }

  return cards;
}

export function refreshPrefabDockUI() {
  const folderTreeEl = $('prefabFolderTree');
  const gridEl = $('prefabGridContainer');
  const breadEl = $('activeFolderBreadcrumb');
  if (!folderTreeEl || !gridEl) return;

  if (!Array.isArray(S.prefabFolders)) S.prefabFolders = [];
  if (!S.activePrefabFolderId) S.activePrefabFolderId = 'all';

  const allCards = getAllAvailablePrefabCards();
  const cardMap = new Map(allCards.map(c => [c.id, c]));

  let foldersHTML = '';
  for (const sf of SYSTEM_FOLDERS) {
    const cnt = sf.id === 'all'
      ? allCards.length
      : allCards.filter(c => c.category === sf.id).length;
    const isAct = S.activePrefabFolderId === sf.id;
    foldersHTML += `
      <div class="folder-item ${isAct ? 'active' : ''}" data-pfolder="${sf.id}">
        <span class="folder-item-left">${sf.icon} ${sf.name}</span>
        <span class="folder-count">${cnt}</span>
      </div>
    `;
  }

  if (S.prefabFolders.length > 0) {
    foldersHTML += `<div style="font:800 9px var(--f);color:#64748b;text-transform:uppercase;padding:6px 4px 2px">Мои Папки (Перетащи сюда)</div>`;
    for (const uf of S.prefabFolders) {
      const isAct = S.activePrefabFolderId === uf.id;
      const validItems = (uf.items || []).filter(id => cardMap.has(id));
      foldersHTML += `
        <div class="folder-item ${isAct ? 'active' : ''}" data-pfolder="${uf.id}" data-custom-folder="1">
          <span class="folder-item-left">📂 ${uf.name}</span>
          <div style="display:flex;align-items:center;gap:3px">
            <div class="folder-act-btns">
              <button class="hier-qbtn" data-uf-ren="${uf.id}" type="button" title="Переименовать папку">✏️</button>
              <button class="hier-qbtn" data-uf-del="${uf.id}" type="button" title="Удалить папку">🗑️</button>
            </div>
            <span class="folder-count">${validItems.length}</span>
          </div>
        </div>
      `;
    }
  }

  folderTreeEl.innerHTML = foldersHTML;

  folderTreeEl.querySelectorAll('.folder-item[data-pfolder]').forEach(el => {
    el.onclick = e => {
      if (e.target.closest('button')) return;
      S.activePrefabFolderId = el.dataset.pfolder;
      refreshPrefabDockUI();
    };
  });

  folderTreeEl.querySelectorAll('[data-uf-ren]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const uf = S.prefabFolders.find(f => f.id === btn.dataset.ufRen);
      if (!uf) return;
      const nextName = prompt('Новое название папки:', uf.name);
      if (nextName && nextName.trim()) {
        uf.name = nextName.trim();
        refreshPrefabDockUI();
      }
    };
  });

  folderTreeEl.querySelectorAll('[data-uf-del]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const fid = btn.dataset.ufDel;
      const idx = S.prefabFolders.findIndex(f => f.id === fid);
      if (idx >= 0) {
        S.prefabFolders.splice(idx, 1);
        if (S.activePrefabFolderId === fid) S.activePrefabFolderId = 'all';
        refreshPrefabDockUI();
      }
    };
  });

  const searchQuery = (($('prefabSearchInp') && $('prefabSearchInp').value) || '').trim().toLowerCase();
  const activeCustomFolder = S.prefabFolders.find(f => f.id === S.activePrefabFolderId);
  const activeSysFolder = SYSTEM_FOLDERS.find(f => f.id === S.activePrefabFolderId);

  if (breadEl) {
    if (activeCustomFolder) breadEl.textContent = `📂 ${activeCustomFolder.name}`;
    else if (activeSysFolder) breadEl.textContent = `${activeSysFolder.icon} ${activeSysFolder.name}`;
  }

  let visibleCards = [];
  if (activeCustomFolder) {
    visibleCards = (activeCustomFolder.items || [])
      .map(id => cardMap.get(id))
      .filter(Boolean);
  } else if (S.activePrefabFolderId === 'all') {
    visibleCards = allCards;
  } else {
    visibleCards = allCards.filter(c => c.category === S.activePrefabFolderId);
  }

  if (searchQuery) {
    visibleCards = visibleCards.filter(c => c.title.toLowerCase().includes(searchQuery));
  }

  gridEl.style.setProperty('--card-size', (S.prefabCardSize || 96) + 'px');

  if (visibleCards.length === 0) {
    gridEl.innerHTML = `
      <div style="grid-column:1/-1;padding:24px;text-align:center;color:#8fa0bd;font:700 11.5px var(--f)">
        В этой папке пока пусто. Перетащи сюда любую карточку префаба или нажми <b>«💾 В префаб»</b>, чтобы сохранить выбранный на сцене объект!
      </div>
    `;
    return;
  }

  gridEl.innerHTML = visibleCards
    .map(c => {
      const canRemove = Boolean(activeCustomFolder || c.isCustom);
      const canShare = Boolean(c.isCustom);
      return `
        <div class="spawn-card" data-spawn="${c.spawnKey}" data-card-id="${c.id}" style="border-color:${c.border || '#2e3340'}">
          ${canShare ? `<button class="card-del-btn" data-card-share="${c.id}" type="button" title="Опубликовать в общую Мастерскую UGC" style="left:4px;right:auto;background:rgba(0,162,255,0.88);color:#fff">☁️</button>` : ''}
          ${canRemove ? `<button class="card-del-btn" data-card-del="${c.id}" type="button" title="${activeCustomFolder ? 'Убрать из папки' : 'Удалить префаб'}">✕</button>` : ''}
          <div class="ico">
            <img class="thumb-3d-img" src="${c.thumb}" alt="${c.title}">
          </div>
          <div class="card-title">${c.title}</div>
        </div>
      `;
    })
    .join('');

  gridEl.querySelectorAll('[data-card-share]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const cid = btn.dataset.cardShare;
      const card = cardMap.get(cid);
      if (!card || !window.__debixPublishDockCardToHub) return;
      window.__debixPublishDockCardToHub(card);
    };
  });

  gridEl.querySelectorAll('[data-card-del]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const cid = btn.dataset.cardDel;
      if (activeCustomFolder) {
        activeCustomFolder.items = (activeCustomFolder.items || []).filter(x => x !== cid);
        refreshPrefabDockUI();
        return;
      }
      if (cid.startsWith('cpref_')) {
        const idx = (S.customPrefabsLibrary || []).findIndex(p => p.id === cid);
        if (idx >= 0) S.customPrefabsLibrary.splice(idx, 1);
      } else if (cid.startsWith('lib_item_')) {
        const idx = +cid.replace('lib_item_', '');
        if (S.savedItemsLibrary[idx]) S.savedItemsLibrary.splice(idx, 1);
      } else if (cid.startsWith('lib_cos_')) {
        const idx = +cid.replace('lib_cos_', '');
        if (S.savedCosmeticsLibrary[idx]) S.savedCosmeticsLibrary.splice(idx, 1);
      } else if (cid.startsWith('lib_bbm_')) {
        const idx = +cid.replace('lib_bbm_', '');
        if (S.customModelsLibrary && S.customModelsLibrary[idx]) S.customModelsLibrary.splice(idx, 1);
      }
      refreshPrefabDockUI();
    };
  });
}

function serializeBlockSnapshotForPrefab(b, originPos = null) {
  return {
    label: b.label,
    shape: b.shape,
    colliderShape: b.colliderShape || 'auto',
    surfaceType: b.surfaceType || 'studs',
    dx: originPos ? Number((b.m.position.x - originPos.x).toFixed(3)) : 0,
    dy: originPos ? Number((b.m.position.y - originPos.y).toFixed(3)) : 0,
    dz: originPos ? Number((b.m.position.z - originPos.z).toFixed(3)) : 0,
    w: b.m.scale.x,
    h: b.m.scale.y,
    d: b.m.scale.z,
    rx: b.m.rotation.x,
    ry: b.m.rotation.y,
    rz: b.m.rotation.z,
    colorHex: b.colorHex,
    gold: b.gold,
    customTexDataURL: b.customTexDataURL,
    matterState: b.matterState,
    bounciness: b.bounciness,
    conveyorVz: b.conveyorVz,
    conveyorVx: b.conveyorVx,
    damageOnContact: b.damageOnContact,
    teleportToCheckpoint: b.teleportToCheckpoint,
    spinSpeed: b.spinSpeed,
    colliderScale: b.colliderScale ? Object.assign({}, b.colliderScale) : { x: 1, y: 1, z: 1 },
    components: b.components ? JSON.parse(JSON.stringify(b.components)) : null,
    interactionData: b.interactionData ? JSON.parse(JSON.stringify(b.interactionData)) : null,
    motionData: b.motionData ? JSON.parse(JSON.stringify(b.motionData)) : null,
    signalData: b.signalData ? JSON.parse(JSON.stringify(b.signalData)) : null,
    costData: b.costData ? JSON.parse(JSON.stringify(b.costData)) : null,
    soundData: b.soundData ? JSON.parse(JSON.stringify(b.soundData)) : null,
    mediaScreenData: b.mediaScreenData ? JSON.parse(JSON.stringify(b.mediaScreenData)) : null,
    soundEmitterData: b.soundEmitterData ? JSON.parse(JSON.stringify(b.soundEmitterData)) : null,
    checkpointData: b.checkpointData ? JSON.parse(JSON.stringify(b.checkpointData)) : null,
    spawnerData: b.spawnerData ? JSON.parse(JSON.stringify(b.spawnerData)) : null,
    particleData: b.particleData ? JSON.parse(JSON.stringify(b.particleData)) : null,
    lightData: b.lightData ? JSON.parse(JSON.stringify(b.lightData)) : null,
    scriptData: b.scriptData ? {
      enabled: Boolean(b.scriptData.enabled),
      targetType: b.scriptData.targetType || 'block',
      name: b.scriptData.name || 'Мой Скрипт',
      code: b.scriptData.code || '',
      paramValues: JSON.parse(JSON.stringify(b.scriptData.paramValues || {})),
      showBadge: b.scriptData.showBadge !== false
    } : null,
    bbmodelData: b.bbmodelData ? JSON.parse(JSON.stringify(b.bbmodelData)) : null,
    logicData: b.logicData ? JSON.parse(JSON.stringify(b.logicData)) : null
  };
}

export function buildPrefabEntryFromSelected(ref = S.selectedRef) {
  if (!ref) return null;
  const pid = 'cpref_' + Date.now() + '_' + Math.floor(Math.random() * 999);

  if (ref.kind === 'block' && ref.box) {
    const b = ref.box;
    const rootPos = b.m.position;
    const descBlocks = getAllSceneDescendants(`block:${b.id}`)
      .filter(d => d.kind === 'block' && d.obj)
      .map(d => serializeBlockSnapshotForPrefab(d.obj, rootPos));

    const data = serializeBlockSnapshotForPrefab(b, null);
    if (descBlocks.length > 0) {
      data.childrenBlocks = descBlocks;
    }
    return {
      id: pid,
      kind: 'block',
      title: b.label || 'Мой Префаб',
      data
    };
  }

  if (ref.kind === 'folder' && ref.folder) {
    const descBlocks = getAllSceneDescendants(`folder:${ref.folder.id}`)
      .filter(d => d.kind === 'block' && d.obj);
    if (descBlocks.length === 0) return null;
    const firstBlk = descBlocks[0].obj;
    const rootPos = firstBlk.m.position;
    const data = serializeBlockSnapshotForPrefab(firstBlk, null);
    data.label = ref.folder.name || data.label;
    data.childrenBlocks = descBlocks.slice(1).map(d => serializeBlockSnapshotForPrefab(d.obj, rootPos));
    return {
      id: pid,
      kind: 'block',
      title: ref.folder.name || 'Группа объектов',
      data
    };
  }

  if (ref.kind === 'world_item' && ref.item) {
    return {
      id: pid,
      kind: 'world_item',
      title: ref.item.name || 'Мой Предмет',
      data: JSON.parse(JSON.stringify(ref.item))
    };
  }

  if (ref.kind === 'cosmetic' && ref.item) {
    return {
      id: pid,
      kind: 'cosmetic',
      title: ref.item.name || 'Мой Аксессуар',
      data: JSON.parse(JSON.stringify(ref.item))
    };
  }

  if (ref.kind === 'char' && ref.ent) {
    const ent = ref.ent;
    return {
      id: pid,
      kind: 'npc',
      title: ent.name || 'Мой NPC',
      data: Object.assign({}, JSON.parse(JSON.stringify(ent.preset || {})), {
        name: ent.name,
        chat: ent.chat,
        scale: ent.rig?.g?.scale?.x || 1,
        hpEnabled: ent.hpEnabled,
        maxHp: ent.maxHp,
        hp: ent.maxHp,
        meleeDamage: ent.meleeDamage,
        walkSpeed: ent.walkSpeed || 5.4,
        jumpPower: ent.jumpPower || 10.2,
        wander: ent.wander,
        aggressive: ent.aggressive,
        equippedItem: ent.equippedItem ? JSON.parse(JSON.stringify(ent.equippedItem)) : null,
        aiModules: ent.aiModules ? JSON.parse(JSON.stringify(ent.aiModules)) : null
      })
    };
  }

  return null;
}

export function saveSelectedObjectAsPrefab() {
  const entry = buildPrefabEntryFromSelected(S.selectedRef);
  if (!entry) {
    showBanner('Сначала выбери любой блок, группу, предмет, аксессуар или NPC на сцене, чтобы сохранить его в префабы!', '#ffce3a');
    return;
  }
  if (!Array.isArray(S.customPrefabsLibrary)) S.customPrefabsLibrary = [];
  S.customPrefabsLibrary.push(entry);

  const customFolder = S.prefabFolders.find(f => f.id === S.activePrefabFolderId);
  if (customFolder) {
    if (!Array.isArray(customFolder.items)) customFolder.items = [];
    customFolder.items.push(entry.id);
  } else {
    S.activePrefabFolderId = 'library';
  }

  if (window.__debixSyncCustomAsset && !S.isApplyingRemoteSync) {
    window.__debixSyncCustomAsset('prefab', entry);
  }

  sfx.cash();
  refreshPrefabDockUI();
  showBanner(`💾 «${entry.title}» сохранён в префабы! Нажми ☁️ на его карточке, чтобы поделиться с игроками.`, '#00e676');
}

/* ---------- ДРЕВОВИДНАЯ ИЕРАРХИЯ СЦЕНЫ (UNITY PARENT-CHILD TREE) ---------- */

function getBlockHierarchyIcon(b) {
  if (b.components?.mediaScreen?.enabled) return '📺';
  if (b.components?.soundEmitter?.enabled) return '📻';
  if (b.components && !b.components.geometry?.enabled && !b.components.item?.enabled) return '🎯';
  if (b.components && b.components.item?.enabled) return b.components.item.itemData?.icon || '🗡️';
  if (b.checkpointData && b.checkpointData.enabled) return '⭐';
  if (b.logicData && (b.logicData.trigger !== 'none' || b.logicData.tag)) {
    const act = b.logicData.action;
    if (act === 'teleport') return '🌀';
    if (act === 'buy_perk') return '🛒';
    if (act === 'give_cash') return '🪙';
    if (act === 'door_ghost') return '👻';
    if (b.logicData.trigger === 'touch') return '👟';
    if (b.logicData.trigger === 'keyE' && b.logicData.targetTag) return '🔘';
    return '🚪';
  }
  if (b.components && !b.components.physics?.enabled) return '🧊';
  if (b.matterState === 'liquid') return '💧';
  if (b.matterState === 'gas') return '☁️';
  if (b.damageOnContact > 0) return '🚨';
  if (b.bounciness > 0) return '🟢';
  return '🧱';
}

// Автоматически разворачивает всех родителей выбранного объекта, чтобы он гарантированно отобразился в дереве
export function uncollapseAncestorsOfRef(ref = S.selectedRef) {
  if (!ref) return;
  const key = getKeyFromEditorRef(ref);
  if (!key) return;

  if (ref.kind === 'world_item' && ref.worldEntry) {
    ref.worldEntry.hierCollapsed = false;
  }
  if (ref.kind === 'cosmetic') {
    if (ref.ent) ref.ent.hierCollapsed = false;
    if (ref.item) ref.item.hierCollapsed = false;
  }

  let curKey = key;
  let guard = 0;
  while (curKey && guard++ < 64) {
    const info = getSceneNodeByKey(curKey);
    if (!info || !info.obj) break;
    const pKey = getParentKeyOfNode(info.obj);
    if (!pKey) break;
    const pInfo = getSceneNodeByKey(pKey);
    if (pInfo && pInfo.obj) {
      if (pInfo.kind === 'folder') pInfo.obj.collapsed = false;
      else pInfo.obj.hierCollapsed = false;
    }
    curKey = pKey;
  }
}

export function refreshHierarchyUI() {
  const filter = ($('hierFilter') && $('hierFilter').value) || 'all';
  const query = (($('hierSearchInp') && $('hierSearchInp').value) || '').trim().toLowerCase();
  const cont = $('hierContainer');
  if (!cont) return;

  // Раскрываем всех родителей выбранного объекта, чтобы он всегда был виден в списке
  uncollapseAncestorsOfRef(S.selectedRef);

  if (!Array.isArray(S.sceneFolders)) S.sceneFolders = [];

  // Собираем полный список узлов дерева (папки, персонажи, аксессуары, предметы, блоки и их дочерние части)
  const nodesMap = new Map();

  const registerNode = node => {
    nodesMap.set(node.key, Object.assign({ children: [] }, node));
  };

  // 1. Папки / Пустые родительские группы
  if (filter === 'all') {
    for (const sf of S.sceneFolders) {
      const isSel = S.selectedRef?.kind === 'folder' && S.selectedRef.folder === sf;
      registerNode({
        key: `folder:${sf.id}`,
        kind: 'folder',
        id: sf.id,
        obj: sf,
        parentKey: getParentKeyOfNode(sf),
        title: sf.name,
        badge: 'Группа',
        icon: '📁',
        isSel,
        collapsed: !!sf.collapsed,
        canHaveVisLock: false,
        canEditFolder: true,
        canToggleActive: true,
        disabled: !!sf.isDisabled
      });
    }
  }

  // 1.5. Пустые объекты с пивотом (Empty GameObjects)
  if (filter === 'all') {
    for (const emp of S.emptyObjects || []) {
      ensureNodeHierOrder(emp);
      const isSel = S.selectedRef?.kind === 'empty' && S.selectedRef.emptyObj === emp;
      registerNode({
        key: `empty:${emp.id}`,
        kind: 'empty',
        id: emp.id,
        obj: emp,
        parentKey: getParentKeyOfNode(emp),
        title: emp.name,
        badge: 'Empty',
        icon: '🎯',
        isSel,
        collapsed: !!emp.hierCollapsed,
        hidden: !!emp.editorHidden,
        disabled: !!emp.isDisabled,
        locked: !!emp.editorLocked,
        canHaveVisLock: true,
        canToggleActive: true
      });
    }
  }

  // 2. Персонажи + вложенные в них 3D-Аксессуары и Питомцы + примитивы аксессуаров
  const addCharacterWithChildren = (ent, charId, icon, roleBadge) => {
    const charKey = `char:${charId}`;
    const isSelChar = S.selectedRef?.kind === 'char' && S.selectedRef.ent === ent;
    registerNode({
      key: charKey,
      kind: 'char',
      id: charId,
      obj: ent,
      parentKey: getParentKeyOfNode(ent),
      title: ent.name,
      badge: roleBadge,
      icon,
      isSel: isSelChar,
      collapsed: ent.hierCollapsed !== undefined ? !!ent.hierCollapsed : true,
      hidden: !!ent.editorHidden,
      disabled: !!ent.isDisabled,
      locked: !!ent.editorLocked,
      canHaveVisLock: true,
      canToggleActive: !ent.isP
    });

    // Вложенные удерживаемые (1 рука / Хотбар) и переносимые (2 руки) предметы персонажа
    const registerHeldOrCarriedItemNode = (itm, slotKey, badgeText) => {
      if (!itm) return;
      normalizeItemData(itm);
      const itemNodeKey = `char_item:${charId}:${slotKey}`;
      const isSelItm =
        S.selectedRef?.kind === 'world_item' &&
        S.selectedRef.item === itm &&
        (!S.selectedRef.editMode || S.selectedRef.editMode === 'root');

      registerNode({
        key: itemNodeKey,
        kind: 'char_item',
        id: `${charId}:${slotKey}`,
        obj: itm,
        ownerEnt: ent,
        slotKey,
        parentKey: charKey,
        title: `${itm.icon || '🗡️'} ${itm.name || 'Предмет'}`,
        badge: badgeText,
        thumbUrl: getItem3DThumbnail(itm),
        isSel: isSelItm,
        collapsed: itm.hierCollapsed !== undefined ? !!itm.hierCollapsed : true,
        hidden: false,
        locked: false,
        canHaveVisLock: false
      });

      const parts = itm.parts || [];
      for (let pIdx = 0; pIdx < parts.length; pIdx++) {
        const pt = parts[pIdx];
        const parentPtIdx = pt.parentPartId ? parts.findIndex(x => x.id === pt.parentPartId) : -1;
        const ptParentKey = parentPtIdx >= 0 ? `char_item_part:${charId}:${slotKey}:${parentPtIdx}` : itemNodeKey;
        const isSelPt =
          S.selectedRef?.kind === 'world_item' &&
          S.selectedRef.item === itm &&
          S.selectedRef.editMode === 'part' &&
          S.selectedRef.partIdx === pIdx;

        registerNode({
          key: `char_item_part:${charId}:${slotKey}:${pIdx}`,
          kind: 'char_item_part',
          id: `${charId}:${slotKey}:${pIdx}`,
          obj: pt,
          ownerEnt: ent,
          ownerItem: itm,
          slotKey,
          partIdx: pIdx,
          parentKey: ptParentKey,
          title: pt.name || `Часть #${pIdx + 1}`,
          badge: pt.shape,
          icon: '🧩',
          isSel: isSelPt,
          collapsed: false,
          canHaveVisLock: false
        });
      }
    };

    if (ent.carriedItem) {
      registerHeldOrCarriedItemNode(ent.carriedItem, 'carried', '📦 В 2 руках');
    }
    if (ent.isP && Array.isArray(ent.inventory)) {
      for (let sIdx = 0; sIdx < ent.inventory.length; sIdx++) {
        const slotItm = ent.inventory[sIdx];
        if (!slotItm || typeof slotItm !== 'object') continue;
        const isAct = (S.activeSlot ?? 0) === sIdx;
        registerHeldOrCarriedItemNode(slotItm, `slot_${sIdx}`, isAct ? `🤚 В руке (#${sIdx + 1})` : `🎒 Слот #${sIdx + 1}`);
      }
    } else if (!ent.isP && ent.equippedItem) {
      registerHeldOrCarriedItemNode(ent.equippedItem, 'equipped', '🤚 В руке');
    }

    // Вложенные 3D-Аксессуары и Питомцы персонажа
    const cosList = ent.preset?.customCosmetics || [];
    for (let cIdx = 0; cIdx < cosList.length; cIdx++) {
      const cos = cosList[cIdx];
      if (!cos) continue;
      normalizeCosmeticItem(cos);
      const cosKey = `cosmetic:${charId}:${cIdx}`;
      const isSelCos =
        S.selectedRef?.kind === 'cosmetic' &&
        S.selectedRef.item === cos &&
        (S.selectedRef.editMode === 'root' || !S.selectedRef.editMode);

      registerNode({
        key: cosKey,
        kind: 'cosmetic',
        id: `${charId}:${cIdx}`,
        obj: cos,
        ownerEnt: ent,
        cosIdx: cIdx,
        parentKey: charKey,
        title: cos.name || `Аксессуар #${cIdx + 1}`,
        badge: cos.parentSlot,
        thumbUrl: getCosmetic3DThumbnail(cos),
        isSel: isSelCos,
        collapsed: cos.hierCollapsed !== undefined ? !!cos.hierCollapsed : true,
        hidden: cos.enabled === false,
        locked: false,
        canHaveVisLock: true
      });

      // Дочерние примитивы внутри аксессуара
      for (let pIdx = 0; pIdx < cos.parts.length; pIdx++) {
        const pt = cos.parts[pIdx];
        const parentPtIdx = pt.parentPartId ? cos.parts.findIndex(x => x.id === pt.parentPartId) : -1;
        const ptParentKey = parentPtIdx >= 0
          ? `cos_part:${charId}:${cIdx}:${parentPtIdx}`
          : cosKey;
        const isSelPt =
          S.selectedRef?.kind === 'cosmetic' &&
          S.selectedRef.item === cos &&
          S.selectedRef.editMode === 'part' &&
          S.selectedRef.partIdx === pIdx;

        registerNode({
          key: `cos_part:${charId}:${cIdx}:${pIdx}`,
          kind: 'cos_part',
          id: `${charId}:${cIdx}:${pIdx}`,
          obj: pt,
          ownerEnt: ent,
          ownerCos: cos,
          cosIdx: cIdx,
          partIdx: pIdx,
          parentKey: ptParentKey,
          title: pt.name || `Деталь #${pIdx + 1}`,
          badge: pt.shape,
          icon: '🧩',
          isSel: isSelPt,
          collapsed: false,
          canHaveVisLock: false
        });
      }
    }
  };

  if (filter === 'all' || filter === 'chars') {
    if (S.player) addCharacterWithChildren(S.player, 'player', '👑', 'Игрок');
    if (S.archangelEnt) addCharacterWithChildren(S.archangelEnt, 'archangel', '😇', 'Судья');
    for (const npc of S.customNPCs) {
      addCharacterWithChildren(npc, npc.id, '🤖', 'NPC');
    }
    for (let i = 0; i < S.queueLine.length; i++) {
      const e = S.queueLine[i];
      if (e.isP) continue;
      addCharacterWithChildren(e, e.id, '🧍', `#${i + 1}`);
    }
  }

  // 3. Предметы и Оружие в мире + их дочерние примитивы
  if (filter === 'all' || filter === 'items') {
    for (let i = S.worldItems.length - 1; i >= 0; i--) {
      const wi = S.worldItems[i];
      const wiKey = `world_item:${wi.id}`;
      const isSelWi =
        S.selectedRef?.kind === 'world_item' &&
        S.selectedRef.worldEntry === wi &&
        (!S.selectedRef.editMode || S.selectedRef.editMode === 'root');

      registerNode({
        key: wiKey,
        kind: 'world_item',
        id: wi.id,
        obj: wi,
        parentKey: getParentKeyOfNode(wi),
        title: wi.item.name,
        badge: wi.item.holdMode === 'carried' ? '2 руки' : wi.item.useType,
        thumbUrl: getItem3DThumbnail(wi.item),
        isSel: isSelWi,
        collapsed: wi.hierCollapsed !== undefined ? !!wi.hierCollapsed : true,
      hidden: !!wi.editorHidden,
      disabled: !!wi.isDisabled,
      locked: !!wi.editorLocked,
      canHaveVisLock: true,
      canToggleActive: true
      });

      const parts = wi.item.parts || [];
      for (let pIdx = 0; pIdx < parts.length; pIdx++) {
        const pt = parts[pIdx];
        const parentPtIdx = pt.parentPartId ? parts.findIndex(x => x.id === pt.parentPartId) : -1;
        const ptParentKey = parentPtIdx >= 0 ? `item_part:${wi.id}:${parentPtIdx}` : wiKey;
        const isSelPt =
          S.selectedRef?.kind === 'world_item' &&
          S.selectedRef.worldEntry === wi &&
          S.selectedRef.editMode === 'part' &&
          S.selectedRef.partIdx === pIdx;

        registerNode({
          key: `item_part:${wi.id}:${pIdx}`,
          kind: 'item_part',
          id: `${wi.id}:${pIdx}`,
          obj: pt,
          ownerWi: wi,
          partIdx: pIdx,
          parentKey: ptParentKey,
          title: pt.name || `Часть #${pIdx + 1}`,
          badge: pt.shape,
          icon: '🧩',
          isSel: isSelPt,
          collapsed: false,
          canHaveVisLock: false
        });
      }
    }
  }

  // 4. Блоки сцены
  if (filter !== 'items' && filter !== 'chars') {
    for (let i = S.allBlocks.length - 1; i >= 0; i--) {
      const b = S.allBlocks[i];
      const hasLogic = b.logicData && (b.logicData.trigger !== 'none' || !!b.logicData.tag);
      if (filter === 'logic' && !hasLogic) continue;
      if (filter === 'checkpoints' && (!b.checkpointData || !b.checkpointData.enabled)) continue;
      if (filter === 'clouds' && b.matterState !== 'gas') continue;
      if (filter === 'blocks' && b.matterState === 'gas') continue;

      const isSel = S.selectedRef?.kind === 'block' && S.selectedRef.box === b;
      let badgeRight = b.matterState;
      if (b.components && !b.components.geometry?.enabled && !b.components.item?.enabled) {
        badgeRight = 'Empty';
      } else if (b.components && b.components.item?.enabled) {
        badgeRight = 'Предмет';
      } else if (b.logicData && b.logicData.tag) {
        badgeRight = `#${b.logicData.tag}`;
      } else if (b.logicData && b.logicData.targetTag) {
        badgeRight = `→#${b.logicData.targetTag}`;
      } else if (b.components && !b.components.physics?.enabled) {
        badgeRight = b.shape || 'Примитив';
      }

      const isCarriedBlk = S.player && S.player.carriedPhysicsBlock === b;

      registerNode({
        key: `block:${b.id}`,
        kind: 'block',
        id: b.id,
        obj: b,
        parentKey: isCarriedBlk ? 'char:player' : getParentKeyOfNode(b),
        title: b.label,
        badge: isCarriedBlk ? '📦 В руках [E]' : badgeRight,
        icon: getBlockHierarchyIcon(b),
        isSel,
        collapsed: !!b.hierCollapsed,
      hidden: !!b.editorHidden,
      disabled: !!b.isDisabled,
      locked: !!b.editorLocked,
      canHaveVisLock: true,
      canToggleActive: true
      });
    }
  }

  // Строим дерево вложенности
  const rootNodes = [];
  for (const node of nodesMap.values()) {
    if (query) {
      const match =
        node.title.toLowerCase().includes(query) ||
        (node.badge || '').toLowerCase().includes(query);
      if (match) rootNodes.push(node);
      continue;
    }

    if (node.parentKey && nodesMap.has(node.parentKey) && node.parentKey !== node.key) {
      nodesMap.get(node.parentKey).children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  // Сортируем корневые узлы и все дочерние списки по пользовательскому порядку hierOrder (как в Unity)
  const sortNodesByOrder = list => {
    list.sort((a, b) => {
      const oa = a.obj ? ensureNodeHierOrder(a.obj) : 0;
      const ob = b.obj ? ensureNodeHierOrder(b.obj) : 0;
      return oa - ob;
    });
    for (const item of list) {
      if (item.children && item.children.length > 1) {
        sortNodesByOrder(item.children);
      }
    }
  };
  sortNodesByOrder(rootNodes);

  // РЕЖИМ ИЗОЛЯЦИИ В 3D STUDIO (как Prefab Mode в Unity):
  // Когда открыта 3D Студия, слева отображается иерархия ТОЛЬКО редактируемого объекта и его дочерних частей!
  let activeRootNodes = rootNodes;
  let studioIsolationBannerHTML = '';

  if (S.itemStudioOpen && S.selectedRef) {
    const ref = S.selectedRef;
    let isolatedRootKey = null;

    if (ref.kind === 'world_item' && ref.worldEntry) {
      isolatedRootKey = `world_item:${ref.worldEntry.id}`;
    } else if (ref.kind === 'cosmetic' && ref.item) {
      const ent = ref.ent || S.player;
      const charId = ent?.isP ? 'player' : (ent?.isArchangel ? 'archangel' : ent?.id);
      const cIdx = (ent?.preset?.customCosmetics || []).indexOf(ref.item);
      if (charId && cIdx >= 0) {
        isolatedRootKey = `cosmetic:${charId}:${cIdx}`;
      }
    } else if (ref.kind === 'char' && ref.ent) {
      const ent = ref.ent;
      const charId = ent.isP ? 'player' : (ent.isArchangel ? 'archangel' : ent.id);
      isolatedRootKey = `char:${charId}`;
    } else if (ref.kind === 'block' && ref.box) {
      let rootBox = ref.box;
      let guard = 0;
      while (rootBox.parentKey && rootBox.parentKey.startsWith('block:') && guard++ < 64) {
        const pid = rootBox.parentKey.slice(6);
        const pBox = S.allBlocks.find(b => b.id === pid);
        if (!pBox || pBox === rootBox) break;
        rootBox = pBox;
      }
      isolatedRootKey = `block:${rootBox.id}`;
    }

    const isolatedNode = isolatedRootKey ? nodesMap.get(isolatedRootKey) : null;
    if (isolatedNode) {
      // Принудительно раскрываем сам редактируемый объект, чтобы сразу были видны все его примитивы/детали
      isolatedNode.collapsed = false;
      activeRootNodes = [isolatedNode];

      // Если у предмета есть снаряды (ranged / throwable), добавляем ветку примитивов снаряда прямо в корень изоляции
      if (ref.kind === 'world_item' && ref.item && (ref.item.useType === 'ranged' || ref.item.useType === 'throwable')) {
        const wi = ref.worldEntry;
        const projParts = ref.item.projectileParts || [];
        const projChildren = projParts.map((pt, pIdx) => ({
          key: `proj_part:${wi.id}:${pIdx}`,
          kind: 'proj_part',
          id: `${wi.id}:${pIdx}`,
          obj: pt,
          ownerWi: wi,
          partIdx: pIdx,
          title: pt.name || `Ядро #${pIdx + 1}`,
          badge: pt.shape,
          icon: '🚀',
          isSel: ref.editMode === 'proj_part' && ref.partIdx === pIdx,
          collapsed: false,
          children: []
        }));
        projChildren.forEach(pn => nodesMap.set(pn.key, pn));

        const projRootNode = {
          key: `proj_root:${wi.id}`,
          kind: 'proj_root',
          id: wi.id,
          obj: ref.item,
          ownerWi: wi,
          title: `Снаряд (${projParts.length})`,
          badge: 'Снаряд',
          icon: '🚀',
          isSel: ref.editMode === 'proj_part',
          collapsed: false,
          children: projChildren
        };
        nodesMap.set(projRootNode.key, projRootNode);
        activeRootNodes.push(projRootNode);
      }

      studioIsolationBannerHTML = `
        <div style="background:rgba(0,162,255,0.14);border:1px solid #00a2ff;border-radius:7px;padding:6px 8px;margin-bottom:5px;display:flex;align-items:center;justify-content:space-between;gap:6px">
          <span style="font:800 10px var(--f);color:#56f0ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
            🛠️ 3D STUDIO: ${isolatedNode.title}
          </span>
          <button class="hier-qbtn" id="btnHierExitIsolation" type="button" style="opacity:1;background:#00a2ff;color:#fff;padding:2px 6px;font:800 9.5px var(--f)" title="Выйти из 3D Студии ко всей сцене">⬅ В мир</button>
        </div>
      `;
    }
  }

  const renderTreeNodeHTML = node => {
    const hasChildren = node.children && node.children.length > 0;
    const expBtn = hasChildren
      ? `<button class="hier-exp-btn" data-hexp="${node.key}" type="button" title="Развернуть / Свернуть дочерние элементы">${node.collapsed ? '▶' : '▼'}</button>`
      : `<span class="hier-exp-spacer"></span>`;

    const leftVis = node.thumbUrl
      ? `<img class="lib-thumb-3d" style="width:18px;height:18px" src="${node.thumbUrl}" alt="">`
      : `<span>${node.icon || '🧱'}</span>`;

    const hasCustomParent =
      (node.kind === 'block' || node.kind === 'world_item' || node.kind === 'char' || node.kind === 'folder' || node.kind === 'empty') &&
      !!node.parentKey;
    const hasPartParent =
      (node.kind === 'item_part' || node.kind === 'cos_part') &&
      !!node.obj?.parentPartId;

    const unparentBtn = (hasCustomParent || hasPartParent)
      ? `<button class="hier-qbtn" data-hunparent="${node.key}" type="button" title="Вынести из родителя в корень">⤴</button>`
      : '';

    const folderBtns = node.canEditFolder
      ? `
        <button class="hier-qbtn" data-sf-ren="${node.id}" type="button" title="Переименовать группу">✏️</button>
        <button class="hier-qbtn" data-sf-del="${node.id}" type="button" title="Удалить группу (дочерние объекты останутся)">🗑️</button>
      `
      : '';

    const activeToggleBtn = node.canToggleActive
      ? `<button class="hier-qbtn ${node.disabled ? 'is-off' : 'is-on'}" data-hactive="${node.key}" type="button" title="${node.disabled ? 'Объект ВЫКЛЮЧЕН везде (Студия + Игра). Нажми чтобы включить' : 'Объект ВКЛЮЧЁН (как в Unity). Нажми чтобы полностью отключить'}">${node.disabled ? '⛔' : '☑️'}</button>`
      : '';

    const visLockBtns = node.canHaveVisLock
      ? `
        ${activeToggleBtn}
        <button class="hier-qbtn ${node.hidden ? 'active' : ''}" data-hvis="${node.kind}:${node.id}" type="button" title="Скрыть / Показать ТОЛЬКО в Студии (не влияет на игру)">${node.hidden ? '🚫' : '👁️'}</button>
        <button class="hier-qbtn ${node.locked ? 'active' : ''}" data-hlock="${node.kind}:${node.id}" type="button" title="Заблокировать / Разблокировать">${node.locked ? '🔒' : '🔓'}</button>
      `
      : activeToggleBtn;

    const countBadge = hasChildren ? `<small style="color:#56f0ff">(${node.children.length})</small>` : '';

    return `
      <div class="hier-tree-node">
        <div class="hier-item ${node.isSel ? 'sel' : ''} ${node.hidden ? 'is-hidden' : ''} ${node.locked ? 'is-locked' : ''} ${node.disabled ? 'is-disabled-obj' : ''}"
             data-hkey="${node.key}" data-hkind="${node.kind}" data-hid="${node.id}">
          <div class="hier-item-main">
            ${expBtn}
            ${leftVis}
            <span>${node.title}</span>
            ${countBadge}
          </div>
          <div class="hier-item-actions">
            ${node.badge ? `<small>${node.badge}</small>` : ''}
            ${unparentBtn}
            ${folderBtns}
            ${visLockBtns}
          </div>
        </div>
        ${hasChildren && !node.collapsed ? `
          <div class="hier-tree-children">
            ${node.children.map(renderTreeNodeHTML).join('')}
          </div>
        ` : ''}
      </div>
    `;
  };

  let html = studioIsolationBannerHTML + activeRootNodes.map(renderTreeNodeHTML).join('');
  if (!S.itemStudioOpen) {
    html += `<div class="hier-root-dropzone" id="hierRootDropZone">⬇ Перетащи сюда, чтобы вынести объект в корень сцены</div>`;
  }
  cont.innerHTML = html;

  if ($('btnHierExitIsolation')) {
    $('btnHierExitIsolation').onclick = () => closeItemStudio3D(false);
  }

  // Сворачивание / разворачивание веток
  cont.querySelectorAll('[data-hexp]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const key = btn.dataset.hexp;
      const node = nodesMap.get(key);
      if (!node || !node.obj) return;
      if (node.kind === 'folder') {
        node.obj.collapsed = !node.obj.collapsed;
      } else {
        const cur = node.obj.hierCollapsed !== undefined
          ? !!node.obj.hierCollapsed
          : (node.kind === 'char' || node.kind === 'world_item' || node.kind === 'cosmetic');
        node.obj.hierCollapsed = !cur;
      }
      refreshHierarchyUI();
    };
  });

  // Отвязка от родителя в корень (кнопка ⤴)
  cont.querySelectorAll('[data-hunparent]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const key = btn.dataset.hunparent;
      const node = nodesMap.get(key);
      if (!node || !node.obj) return;
      if (node.kind === 'item_part' || node.kind === 'cos_part') {
        node.obj.parentPartId = null;
      } else {
        setParentKeyOfNode(node.obj, null);
      }
      sfx.jump();
      refreshHierarchyUI();
    };
  });

  // Переименование и удаление папок
  cont.querySelectorAll('[data-sf-ren]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const sf = S.sceneFolders.find(f => f.id === btn.dataset.sfRen);
      if (!sf) return;
      const next = prompt('Название группы/папки в сцене:', sf.name);
      if (next && next.trim()) {
        sf.name = next.trim();
        refreshHierarchyUI();
      }
    };
  });

  cont.querySelectorAll('[data-sf-del]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const fid = btn.dataset.sfDel;
      const folderKey = `folder:${fid}`;
      for (const ch of getDirectSceneChildren(folderKey)) {
        setParentKeyOfNode(ch.obj, null);
      }
      const idx = S.sceneFolders.findIndex(f => f.id === fid);
      if (idx >= 0) S.sceneFolders.splice(idx, 1);
      refreshHierarchyUI();
    };
  });

  // Кнопки скрытия (👁️) и блокировки (🔒)
  cont.querySelectorAll('[data-hvis]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      if (btn.dataset.hvis && btn.dataset.hvis.startsWith('cosmetic:')) {
        const node = nodesMap.get(btn.dataset.hvis);
        if (node && node.obj && node.ownerEnt) {
          node.obj.enabled = node.obj.enabled === false;
          node.ownerEnt.rig?.syncCustomCosmetics(node.ownerEnt.preset.customCosmetics);
          attachRigToEntity(node.ownerEnt);
          if (S.itemStudioOpen) syncItemStudioPreview();
          refreshHierarchyUI();
        }
        return;
      }
      const info = getSceneNodeByKey(btn.dataset.hvis);
      if (!info || !info.obj) return;
      const target = info.obj;
      const kind = info.kind;

      const nextHidden = !Boolean(target.editorHidden);
      const setStudioHidden = t => {
        if (!t) return;
        t.editorHidden = nextHidden;
      };
      setStudioHidden(target);
      for (const desc of getAllSceneDescendants(btn.dataset.hvis)) {
        setStudioHidden(desc.obj);
      }
      syncSceneVisibilityForMode(S.state);
      refreshHierarchyUI();
    };
  });

  // Кнопка полного Включения / Выключения объекта (как в Unity — действует и в Студии, и в Игре)
  cont.querySelectorAll('[data-hactive]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const key = btn.dataset.hactive;
      const info = getSceneNodeByKey(key);
      if (!info || !info.obj) return;
      if (info.kind === 'char' && info.obj.isP) {
        showBanner('Игрока нельзя отключить!', '#ffce3a');
        return;
      }
      pushUndoState('Переключение активности объекта');
      const nextDisabled = !Boolean(info.obj.isDisabled);
      const setNodeDisabled = t => {
        if (!t || t.isP) return;
        t.isDisabled = nextDisabled;
        if (nextDisabled && t.ragdoll) t.ragdoll = null;
      };
      setNodeDisabled(info.obj);
      for (const desc of getAllSceneDescendants(key)) {
        setNodeDisabled(desc.obj);
      }
      syncSceneVisibilityForMode(S.state);
      rebuildPhysicsArrays();
      sfx.click?.();
      refreshHierarchyUI();
    };
  });

  cont.querySelectorAll('[data-hlock]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const info = getSceneNodeByKey(btn.dataset.hlock);
      if (!info || !info.obj) return;
      const target = info.obj;
      const nextLock = !target.editorLocked;

      const applyLock = (k, t, lck) => {
        t.editorLocked = lck;
        if (k === 'block' && t.m) t.m.userData.editorLocked = lck;
        else if (k === 'world_item' && t.group) t.group.userData.editorLocked = lck;
        else if (k === 'char' && t.rig?.g) t.rig.g.userData.editorLocked = lck;
        else if (k === 'empty' && t.group) t.group.userData.editorLocked = lck;
      };
      applyLock(info.kind, target, nextLock);
      for (const desc of getAllSceneDescendants(btn.dataset.hlock)) {
        applyLock(desc.kind, desc.obj, nextLock);
      }
      refreshHierarchyUI();
    };
  });

  // Клик по узлу иерархии — выбор любого родителя, ребёнка, аксессуара или отдельной детали
  cont.querySelectorAll('.hier-item[data-hkey]').forEach(el => {
    el.onclick = e => {
      if (e.target.closest('button')) return;
      const node = nodesMap.get(el.dataset.hkey);
      if (!node) return;

      if (node.kind === 'proj_root' || node.kind === 'proj_part') {
        selectEditorObject({
          kind: 'world_item',
          worldEntry: node.ownerWi,
          item: node.ownerWi.item,
          editMode: 'proj_part',
          partIdx: node.partIdx || 0,
          inWorldPlacement: false
        });
        return;
      }

      if (node.kind === 'folder') {
        selectEditorObject({ kind: 'folder', folder: node.obj });
        return;
      }
      if (node.kind === 'empty') {
        selectEditorObject({ kind: 'empty', emptyObj: node.obj });
        focusOnSelected();
        return;
      }
      if (node.kind === 'block') {
        selectEditorObject({ kind: 'block', box: node.obj, inStudio: S.itemStudioOpen });
        if (!S.itemStudioOpen) focusOnSelected();
        return;
      }
      if (node.kind === 'world_item') {
        selectEditorObject({
          kind: 'world_item',
          worldEntry: node.obj,
          item: node.obj.item,
          editMode: 'root',
          partIdx: 0,
          inWorldPlacement: !S.itemStudioOpen
        });
        focusOnSelected();
        return;
      }
      if (node.kind === 'item_part') {
        const wi = node.ownerWi;
        wi.hierCollapsed = false;
        selectEditorObject({
          kind: 'world_item',
          worldEntry: wi,
          item: wi.item,
          editMode: 'part',
          partIdx: node.partIdx,
          inWorldPlacement: !S.itemStudioOpen
        });
        return;
      }
      if (node.kind === 'char') {
        selectEditorObject({ kind: 'char', ent: node.obj, editMode: 'root', inStudio: S.itemStudioOpen });
        focusOnSelected();
        return;
      }
      if (node.kind === 'cosmetic') {
        const ent = node.ownerEnt;
        const cos = node.obj;
        ent.hierCollapsed = false;
        const group = ent.rig?.customCosMeshes?.find(g => g.userData?.cosmeticItem === cos);
        selectEditorObject({
          kind: 'cosmetic',
          ent,
          item: cos,
          group,
          editMode: 'root',
          partIdx: 0,
          inWorldPlacement: !S.itemStudioOpen
        });
        return;
      }
      if (node.kind === 'cos_part') {
        const ent = node.ownerEnt;
        const cos = node.ownerCos;
        ent.hierCollapsed = false;
        cos.hierCollapsed = false;
        const group = ent.rig?.customCosMeshes?.find(g => g.userData?.cosmeticItem === cos);
        selectEditorObject({
          kind: 'cosmetic',
          ent,
          item: cos,
          group,
          editMode: 'part',
          partIdx: node.partIdx,
          inWorldPlacement: !S.itemStudioOpen
        });
      }
      if (node.kind === 'char_item' || node.kind === 'char_item_part') {
        const ent = node.ownerEnt;
        const itm = node.kind === 'char_item' ? node.obj : node.ownerItem;
        ent.hierCollapsed = false;
        if (node.kind === 'char_item_part') itm.hierCollapsed = false;

        // Если предмет лежит в слоте хотбара игрока — делаем этот слот активным, чтобы создался heldItemMesh
        if (ent.isP && typeof node.slotKey === 'string' && node.slotKey.startsWith('slot_')) {
          const sIdx = +node.slotKey.replace('slot_', '');
          if (!Number.isNaN(sIdx)) S.activeSlot = sIdx;
        }
        syncEntityHeldItemMesh(ent);

        // НИКОГДА не передаём ent.rig.g в качестве group предмета, иначе rebuildWorldItemVisual удалит модель игрока со сцены!
        let meshGrp = node.slotKey === 'carried'
          ? ent.rig?.carriedItemMesh
          : ent.rig?.heldItemMesh;
        if (!meshGrp || meshGrp === ent.rig?.g) {
          meshGrp = buildItemGroup(itm, { isProjectile: false, showMarkers: true, applyGripOffset: false });
          scene.add(meshGrp);
        }

        const proxyEntry = {
          id: `held_${ent.id || 'player'}_${node.slotKey}`,
          item: itm,
          x: ent.x || 0,
          y: (ent.y || 0) + 1.4,
          z: ent.z || 0,
          group: meshGrp,
          _ownerEnt: ent,
          _slotKey: node.slotKey
        };
        selectEditorObject({
          kind: 'world_item',
          worldEntry: proxyEntry,
          item: itm,
          editMode: node.kind === 'char_item_part' ? 'part' : 'root',
          partIdx: node.partIdx || 0,
          inWorldPlacement: !S.itemStudioOpen
        });
        return;
      }
    };
  });

  refreshPrefabDockUI();

  // Автоматическая перемотка (скролл) списка иерархии к выбранному объекту
  const scrollSelectedHierItem = () => {
    const selEl = cont.querySelector('.hier-item.sel');
    if (selEl) {
      try {
        selEl.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
      } catch (_) {
        selEl.scrollIntoView();
      }
    }
  };
  scrollSelectedHierItem();
  requestAnimationFrame(scrollSelectedHierItem);
}

/* ---------- СПАВН ПРИМИТИВОВ И ПРЕФАБОВ ---------- */

function findLatestDoorTag() {
  for (let i = S.allBlocks.length - 1; i >= 0; i--) {
    const b = S.allBlocks[i];
    if (b.logicData && b.logicData.tag && (b.logicData.action === 'door_slide' || b.logicData.action === 'door_ghost')) {
      return b.logicData.tag;
    }
  }
  return 'door_1';
}

export function spawnPrimitiveInEditor(shape = 'box', worldDropPos = null, parentPartIdOverride = undefined) {
  const shapeLabel = shape === 'none' ? 'Пустышка' : (PRIMITIVE_LABELS_RU[shape] || shape);

  // Если в 3D Студии открыт блок сцены — создаём дочерний блок прямо на подиуме без выхода из 3D Студии!
  if (S.selectedRef && S.selectedRef.kind === 'block' && S.selectedRef.box) {
    const parentBox = S.selectedRef.box;
    pushUndoState(`Создание дочернего объекта (${shapeLabel})`);
    const pos = worldDropPos ? worldDropPos.clone() : parentBox.m.position.clone();
    const isRawEmpty = shape === 'none';
    const sz = isRawEmpty ? 1 : 1.5;
    const chBox = addSceneBlock({
      x: pos.x,
      y: pos.y + sz * 0.5,
      z: pos.z,
      w: sz, h: sz, d: sz,
      colorHex: '#f1f5f9',
      shape: isRawEmpty ? 'box' : shape,
      label: `${shapeLabel} #${S.blockIdCounter}`,
      isRawEmpty,
      isRawPrimitive: !isRawEmpty,
      isCustom: true
    });
    chBox.m.position.copy(pos);
    chBox.m.rotation.copy(parentBox.m.rotation);
    chBox.m.updateMatrixWorld(true);
    setParentKeyOfNode(chBox, `block:${parentBox.id}`);
    parentBox.hierCollapsed = false;
    ensureNodeHierOrder(chBox);
    rebuildPhysicsArrays();
    selectEditorObject({ kind: 'block', box: chBox, inStudio: S.itemStudioOpen });
    sfx.jump();
    return;
  }

  if (!S.selectedRef || (S.selectedRef.kind !== 'world_item' && S.selectedRef.kind !== 'cosmetic')) {
    let targetWi = S.worldItems[S.worldItems.length - 1];
    if (!targetWi) {
      const itemData = createStarterItemTemplate('sword');
      itemData.name = 'Новый Предмет';
      itemData.parts = [];
      const px = S.player ? S.player.x : 0;
      const py = S.player ? S.player.y + 0.5 : 1.5;
      const pz = S.player ? S.player.z : 0;
      targetWi = spawnWorldItem(itemData, px, py, pz);
    }
    selectEditorObject({
      kind: 'world_item',
      worldEntry: targetWi,
      item: targetWi.item,
      editMode: 'part',
      partIdx: 0,
      inWorldPlacement: false
    });
  } else if (!S.itemStudioOpen) {
    S.selectedRef.inWorldPlacement = false;
    openItemStudio3D(S.selectedRef);
  }

  const ref = S.selectedRef;
  if (!ref) return;

  if (ref.kind === 'world_item' && ref.worldEntry) {
    const { worldEntry, libIdx } = ref;
    const item = normalizeItemData(worldEntry.item);
    const isEditingProj = ref.editMode === 'proj_part';
    const targetArr = isEditingProj ? item.projectileParts : item.parts;

    if (targetArr.length >= MAX_ITEM_PARTS) {
      showBanner(`Достигнут лимит: максимум ${MAX_ITEM_PARTS} примитивов!`, '#ff3e3e');
      return;
    }

    pushItemUndoState(`Добавление примитива (${shapeLabel})`);

    let localPos = new THREE.Vector3(0, 0, 0);
    if (worldDropPos) {
      const holder = isEditingProj
        ? (ref.projPreviewGroup?.userData?.partsHolder || ref.projPreviewGroup)
        : (worldEntry.group?.userData?.partsHolder || worldEntry.group);
      if (holder) {
        holder.updateMatrixWorld(true);
        localPos.copy(worldDropPos);
        holder.worldToLocal(localPos);
      }
    }

    if (S.snapEnabled && worldDropPos) {
      localPos.x = Math.round(localPos.x * 4) / 4;
      localPos.y = Math.round(localPos.y * 4) / 4;
      localPos.z = Math.round(localPos.z * 4) / 4;
    }

    const resolvedParentPartId = parentPartIdOverride !== undefined
      ? parentPartIdOverride
      : ((ref.editMode === 'part' || ref.editMode === 'proj_part') && ref.part ? ref.part.id : null);
    const parentPtObj = resolvedParentPartId ? targetArr.find(p => p && p.id === resolvedParentPartId) : null;
    if (!worldDropPos && parentPtObj) {
      localPos.set(parentPtObj.x || 0, parentPtObj.y || 0, parentPtObj.z || 0);
    }

    const newPart = normalizePartEffects({
      id: 'ipt_' + Date.now() + '_' + Math.floor(Math.random() * 999),
      name: `${shapeLabel} #${targetArr.length + 1}`,
      shape,
      parentPartId: resolvedParentPartId || null,
      x: Number(localPos.x.toFixed(2)),
      y: Number(localPos.y.toFixed(2)),
      z: Number(localPos.z.toFixed(2)),
      rx: parentPtObj ? (parentPtObj.rx || 0) : 0,
      ry: parentPtObj ? (parentPtObj.ry || 0) : 0,
      rz: parentPtObj ? (parentPtObj.rz || 0) : 0,
      sx: 0.5,
      sy: 0.5,
      sz: 0.5,
      color: '#f1f5f9',
      texDataURL: null
    }, isEditingProj, false);
    newPart.components = { visual: false };

    targetArr.push(newPart);
    syncLibraryItemIfEditing(ref);
    selectEditorObject(
      {
        kind: 'world_item',
        worldEntry,
        item,
        editMode: isEditingProj ? 'proj_part' : 'part',
        partIdx: targetArr.length - 1,
        inWorldPlacement: false,
        libIdx
      },
      true
    );
    syncItemStudioPreview();
    sfx.jump();
    showBanner(
      worldDropPos
        ? `🧩 Примитив «${shapeLabel}» размещён в точке курсора!`
        : `🧩 Примитив «${shapeLabel}» создан в центре подиума 3D Студии!`,
      '#00e676'
    );
    return;
  }

  if (ref.kind === 'cosmetic' && ref.item) {
    const { ent, item, libIdx } = ref;
    normalizeCosmeticItem(item);
    if (item.parts.length >= MAX_COSMETIC_PARTS) {
      showBanner(`Достигнут лимит: максимум ${MAX_COSMETIC_PARTS} примитивов!`, '#ff3e3e');
      return;
    }

    pushCosmeticUndoState(`Добавление примитива (${shapeLabel})`);

    let localPos = new THREE.Vector3(0, 0, 0);
    if (worldDropPos && ref.group) {
      const holder = ref.group.userData?.partsHolder || ref.group;
      holder.updateMatrixWorld(true);
      localPos.copy(worldDropPos);
      holder.worldToLocal(localPos);
    }

    if (S.snapEnabled && worldDropPos) {
      localPos.x = Math.round(localPos.x * 4) / 4;
      localPos.y = Math.round(localPos.y * 4) / 4;
      localPos.z = Math.round(localPos.z * 4) / 4;
    }

    const resolvedParentPartId = parentPartIdOverride !== undefined
      ? parentPartIdOverride
      : (ref.editMode === 'part' && ref.part ? ref.part.id : null);
    const parentPtObj = resolvedParentPartId ? item.parts.find(p => p && p.id === resolvedParentPartId) : null;
    if (!worldDropPos && parentPtObj) {
      localPos.set(parentPtObj.x || 0, parentPtObj.y || 0, parentPtObj.z || 0);
    }

    const isPet = item.parentSlot === 'pet';
    const newPart = normalizePartEffects({
      id: 'pt_' + Date.now() + '_' + Math.floor(Math.random() * 999),
      name: `${shapeLabel} #${item.parts.length + 1}`,
      shape,
      parentPartId: resolvedParentPartId || null,
      x: Number(localPos.x.toFixed(2)),
      y: Number(localPos.y.toFixed(2)),
      z: Number(localPos.z.toFixed(2)),
      rx: parentPtObj ? (parentPtObj.rx || 0) : 0,
      ry: parentPtObj ? (parentPtObj.ry || 0) : 0,
      rz: parentPtObj ? (parentPtObj.rz || 0) : 0,
      sx: 0.48,
      sy: 0.48,
      sz: 0.48,
      color: '#f1f5f9',
      texDataURL: null
    }, isPet, false);
    newPart.components = { visual: false };

    item.parts.push(newPart);
    syncLibraryItemIfEditing(ref);
    if (ent && ent.rig) {
      ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
      attachRigToEntity(ent);
    }
    const newGroup = ent?.rig?.customCosMeshes?.find(g => g.userData.cosmeticItem === item);
    selectEditorObject(
      {
        kind: 'cosmetic',
        ent,
        item,
        group: newGroup,
        editMode: 'part',
        partIdx: item.parts.length - 1,
        inWorldPlacement: false,
        libIdx
      },
      true
    );
    syncItemStudioPreview();
    sfx.jump();
    showBanner(
      worldDropPos
        ? `🧩 Примитив «${shapeLabel}» добавлен в точку курсора!`
        : `🧩 Примитив «${shapeLabel}» создан в центре 3D Студии!`,
      '#00e676'
    );
  }
}

export function spawnPrefabFromCard(st, dropWorldPos = null, openForEdit = false) {
  if (!st || isPaintModalOpen() || S.scriptModalOpen) return;

  // Строгая изоляция 3D Студии: внутри 3D Студии разрешены ТОЛЬКО примитивы и .bbmodel-детали, но НЕ мировые префабы/NPC!
  if (S.itemStudioOpen) {
    if (
      S.selectedRef &&
      (S.selectedRef.kind === 'world_item' || S.selectedRef.kind === 'cosmetic' || S.selectedRef.kind === 'block') &&
      (st === 'prim_empty' || st.startsWith('prim_'))
    ) {
      const primShape = st === 'prim_empty' ? 'none' : st.replace('prim_', '');
      spawnPrimitiveInEditor(primShape === 'wedge' ? 'box' : primShape, dropWorldPos);
      return;
    }
    if (!st.startsWith('lib_bbm_')) {
      sfx.oof?.();
      showBanner('🛠️ В 3D Студии нельзя спавнить префабы мира и NPC! Выйди из 3D Студии (✅ Готово), чтобы размещать объекты на карте.', '#ffce3a');
      return;
    }
  }

  let sp;
  const isSurfaceDrop = !!dropWorldPos;
  if (dropWorldPos) {
    sp = dropWorldPos.clone();
  } else {
    const fwd = new THREE.Vector3(
      -Math.sin(S.edYaw) * Math.cos(S.edPitch),
      Math.sin(S.edPitch),
      -Math.cos(S.edYaw) * Math.cos(S.edPitch)
    );
    sp = S.edCamPos.clone().addScaledVector(fwd, 8);
    sp.x = Math.round(sp.x * 2) / 2;
    sp.y = Math.max(0.5, Math.round(sp.y * 2) / 2);
    sp.z = Math.round(sp.z * 2) / 2;
  }

  if (st.startsWith('lib_item_')) {
    const libIdx = +st.replace('lib_item_', '');
    const libItem = S.savedItemsLibrary[libIdx];
    if (!libItem) return;
    pushUndoState('Спавн предмета из Арсенала');
    const wi = spawnWorldItem(libItem, sp.x, sp.y + 0.4, sp.z);
    selectEditorObject({
      kind: 'world_item',
      worldEntry: wi,
      item: wi.item,
      editMode: openForEdit ? 'part' : 'root',
      partIdx: 0,
      libIdx,
      inWorldPlacement: !openForEdit
    });
    sfx.coil();
    return;
  }

  if (st.startsWith('lib_bbm_')) {
    const libIdx = +st.replace('lib_bbm_', '');
    const modelData = (S.customModelsLibrary || [])[libIdx];
    if (!modelData) return;

    // Если открыта 3D Студия предмета или аксессуара — добавляем .bbmodel как деталь внутрь него
    if (S.itemStudioOpen && S.selectedRef && (S.selectedRef.kind === 'world_item' || S.selectedRef.kind === 'cosmetic')) {
      spawnPrimitiveInEditor('bbmodel', dropWorldPos);
      if (S.selectedRef.part) {
        const nat = buildBBModelGroup(modelData)?.userData?.naturalSize || { w: 1, h: 1, d: 1 };
        S.selectedRef.part.shape = 'bbmodel';
        S.selectedRef.part.name = modelData.name || 'BBModel';
        S.selectedRef.part.bbmodelData = JSON.parse(JSON.stringify(modelData));
        S.selectedRef.part.sx = nat.w;
        S.selectedRef.part.sy = nat.h;
        S.selectedRef.part.sz = nat.d;
        selectEditorObject(S.selectedRef, true);
      }
      return;
    }

    pushUndoState(`Спавн 3D-модели «${modelData.name}»`);
    const extracted = extractBBModelParts(modelData, 8);
    const nat = extracted.totalSize;
    const rootCenterY = isSurfaceDrop ? sp.y + nat.h * 0.5 : sp.y;

    if (extracted.parts.length > 1) {
      const rootBox = addSceneBlock({
        x: sp.x, y: rootCenterY + nat.h * 0.5, z: sp.z,
        w: nat.w, h: nat.h, d: nat.d,
        shape: 'none',
        colorHex: '#ffffff',
        label: modelData.name || 'BBModel',
        isRawEmpty: true,
        isCustom: true
      });
      rootBox.m.position.set(sp.x, rootCenterY, sp.z);
      rootBox.m.updateMatrixWorld(true);
      rootBox.hierCollapsed = false;

      for (const ep of extracted.parts) {
        const chBox = addSceneBlock({
          x: sp.x + ep.dx,
          y: rootCenterY + ep.dy + ep.h * 0.5,
          z: sp.z + ep.dz,
          w: ep.w, h: ep.h, d: ep.d,
          shape: 'bbmodel',
          bbmodelData: ep.bbmodelData,
          colorHex: '#ffffff',
          label: ep.name,
          isCustom: true
        });
        chBox.m.position.set(sp.x + ep.dx, rootCenterY + ep.dy, sp.z + ep.dz);
        chBox.m.rotation.set(ep.rx, ep.ry, ep.rz);
        chBox.m.updateMatrixWorld(true);
        setParentKeyOfNode(chBox, `block:${rootBox.id}`);
        chBox.weldToParent = true;
        syncBlockComponentsState(chBox);
      }
      rebuildPhysicsArrays();
      selectEditorObject({ kind: 'block', box: rootBox, inStudio: openForEdit });
      if (!openForEdit) focusOnSelected();
      sfx.jump();
      return;
    }

    const topYVal = isSurfaceDrop ? sp.y + nat.h : sp.y + nat.h * 0.5;
    const box = addSceneBlock({
      x: sp.x, y: topYVal, z: sp.z,
      w: nat.w, h: nat.h, d: nat.d,
      shape: 'bbmodel',
      bbmodelData: modelData,
      colorHex: '#ffffff',
      label: modelData.name || 'BBModel',
      isCustom: true
    });
    rebuildPhysicsArrays();
    selectEditorObject({ kind: 'block', box, inStudio: openForEdit });
    if (!openForEdit) focusOnSelected();
    sfx.jump();
    return;
  }

  if (st.startsWith('lib_cos_')) {
    const libIdx = +st.replace('lib_cos_', '');
    const libCos = S.savedCosmeticsLibrary[libIdx];
    if (!libCos) return;
    const targetEnt = (S.selectedRef?.kind === 'char' && S.selectedRef.ent) || S.player;
    if (!targetEnt) return;
    pushUndoState('Добавление аксессуара из Гардероба');
    const copy = normalizeCosmeticItem(JSON.parse(JSON.stringify(libCos)));
    copy.id = 'cos_' + Date.now();
    if (!targetEnt.preset.customCosmetics) targetEnt.preset.customCosmetics = [];
    targetEnt.preset.customCosmetics.push(copy);
    targetEnt.rig.syncCustomCosmetics(targetEnt.preset.customCosmetics);
    attachRigToEntity(targetEnt);
    const group = targetEnt.rig.customCosMeshes[targetEnt.rig.customCosMeshes.length - 1];
    selectEditorObject({
      kind: 'cosmetic',
      ent: targetEnt,
      item: copy,
      group,
      editMode: openForEdit ? 'part' : 'root',
      partIdx: 0,
      libIdx,
      inWorldPlacement: !openForEdit
    });
    sfx.coil();
    return;
  }

  if (st.startsWith('custom_prefab_')) {
    const pid = st.replace('custom_prefab_', '');
    const cp = (S.customPrefabsLibrary || []).find(p => p.id === pid);
    if (!cp || !cp.data) return;
    pushUndoState(`Спавн префаба «${cp.title}»`);

    if (cp.kind === 'block') {
      if (S.itemStudioOpen) closeItemStudio3D(false);
      const d = cp.data;
      const rootCenterY = isSurfaceDrop ? sp.y + (d.h || 1) * 0.5 : sp.y;
      const box = addSceneBlock(Object.assign({}, JSON.parse(JSON.stringify(d)), {
        x: sp.x,
        y: rootCenterY + (d.h || 1) * 0.5,
        z: sp.z,
        isCustom: true
      }));
      box.m.position.set(sp.x, rootCenterY, sp.z);
      box.m.rotation.set(d.rx || 0, d.ry || 0, d.rz || 0);
      box.m.updateMatrixWorld(true);
      syncBlockComponentsState(box);
      if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
        window.__debixSyncBlockUpsert(box, false);
      }

      // Если префаб содержит дочерние блоки — спавним всю иерархию!
      if (Array.isArray(d.childrenBlocks)) {
        const rootKey = `block:${box.id}`;
        for (const chSnap of d.childrenBlocks) {
          const chCx = sp.x + (Number(chSnap.dx) || 0);
          const chCy = rootCenterY + (Number(chSnap.dy) || 0);
          const chCz = sp.z + (Number(chSnap.dz) || 0);
          const chBox = addSceneBlock(Object.assign({}, JSON.parse(JSON.stringify(chSnap)), {
            x: chCx,
            y: chCy + (chSnap.h || 1) * 0.5,
            z: chCz,
            isCustom: true
          }));
          chBox.m.position.set(chCx, chCy, chCz);
          chBox.m.rotation.set(chSnap.rx || 0, chSnap.ry || 0, chSnap.rz || 0);
          chBox.m.updateMatrixWorld(true);
          setParentKeyOfNode(chBox, rootKey);
          syncBlockComponentsState(chBox);
          if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
            window.__debixSyncBlockUpsert(chBox, false);
          }
        }
      }

      rebuildPhysicsArrays();
      selectEditorObject({ kind: 'block', box });
      if (openForEdit) focusOnSelected();
      sfx.jump();
      return;
    }
    if (cp.kind === 'world_item') {
      const wi = spawnWorldItem(cp.data, sp.x, sp.y + 0.4, sp.z);
      if (window.__debixSyncWorldItemUpsert && !S.isApplyingRemoteSync) {
        window.__debixSyncWorldItemUpsert(wi, false);
      }
      selectEditorObject({
        kind: 'world_item',
        worldEntry: wi,
        item: wi.item,
        editMode: openForEdit ? 'part' : 'root',
        partIdx: 0,
        inWorldPlacement: !openForEdit
      });
      sfx.coil();
      return;
    }
    if (cp.kind === 'cosmetic') {
      const targetEnt = (S.selectedRef?.kind === 'char' && S.selectedRef.ent) || S.player;
      if (!targetEnt) return;
      const copy = normalizeCosmeticItem(JSON.parse(JSON.stringify(cp.data)));
      copy.id = 'cos_' + Date.now();
      if (!targetEnt.preset.customCosmetics) targetEnt.preset.customCosmetics = [];
      targetEnt.preset.customCosmetics.push(copy);
      targetEnt.rig.syncCustomCosmetics(targetEnt.preset.customCosmetics);
      attachRigToEntity(targetEnt);
      const group = targetEnt.rig.customCosMeshes[targetEnt.rig.customCosMeshes.length - 1];
      selectEditorObject({
        kind: 'cosmetic',
        ent: targetEnt,
        item: copy,
        group,
        editMode: openForEdit ? 'part' : 'root',
        partIdx: 0,
        inWorldPlacement: !openForEdit
      });
      sfx.coil();
      return;
    }
    if (cp.kind === 'npc') {
      const npc = spawnCustomNPC(Object.assign({}, JSON.parse(JSON.stringify(cp.data)), {
        x: sp.x,
        y: sp.y,
        z: sp.z
      }));
      selectEditorObject({ kind: 'char', ent: npc, editMode: 'root', inStudio: openForEdit });
      if (!openForEdit) focusOnSelected();
      sfx.coil();
      return;
    }
  }

  const isItemSpawn = st.startsWith('item_');
  if (!openForEdit && S.itemStudioOpen) {
    closeItemStudio3D(false);
  } else if (openForEdit && S.itemStudioOpen && !isItemSpawn && st !== 'npc') {
    closeItemStudio3D(false);
  }

  pushUndoState('Спавн объекта');

  if (st === 'npc') {
    const npc = spawnCustomNPC({ x: sp.x, y: sp.y, z: sp.z });
    selectEditorObject({
      kind: 'char',
      ent: npc,
      editMode: 'root',
      inStudio: openForEdit
    });
    if (!openForEdit) focusOnSelected();
    sfx.coil();
    showBanner(
      openForEdit
        ? '🛠️ NPC открыт в 3D Студии для редактирования!'
        : '🤖 NPC размещён на карте!',
      '#00e676'
    );
    return;
  }

  if (isItemSpawn) {
    const presetKey = st.replace('item_', '');
    const itemData = createStarterItemTemplate(presetKey);
    const spawnY = isSurfaceDrop ? sp.y + 0.35 : sp.y + 0.5;
    const worldEntry = spawnWorldItem(itemData, sp.x, spawnY, sp.z);
    selectEditorObject({
      kind: 'world_item',
      worldEntry,
      item: worldEntry.item,
      editMode: openForEdit ? 'part' : 'root',
      partIdx: 0,
      inWorldPlacement: !openForEdit
    });
    sfx.coil();
    showBanner(
      openForEdit
        ? `🛠️ «${itemData.name}» открыт в 3D Студии для редактирования!`
        : `${itemData.icon} «${itemData.name}» размещён в мире!`,
      '#00e676'
    );
    return;
  }

  const topY = h => (isSurfaceDrop ? sp.y + h : sp.y + h * 0.5);
  let box;
  if (st === 'prim_empty') {
    box = addSceneBlock({
      x: sp.x, y: topY(1), z: sp.z,
      w: 1, h: 1, d: 1,
      colorHex: '#f1f5f9',
      label: `Пустышка #${S.blockIdCounter}`,
      shape: 'box',
      isRawEmpty: true,
      isCustom: true
    });
  } else if (st.startsWith('prim_')) {
    const shape = st.replace('prim_', '');
    const shapeRu = PRIMITIVE_LABELS_RU[shape] || 'Примитив';
    box = addSceneBlock({
      x: sp.x, y: topY(2), z: sp.z,
      w: 2, h: 2, d: 2,
      colorHex: '#f1f5f9',
      label: `${shapeRu} #${S.blockIdCounter}`,
      shape,
      isRawPrimitive: true,
      isCustom: true
    });
  } else
  if (st === 'solid') {
    box = addSceneBlock({
      x: sp.x, y: topY(4), z: sp.z,
      w: 4, h: 4, d: 4,
      colorHex: '#56f0ff',
      matterState: 'solid',
      label: 'Лего-Блок',
      isCustom: true
    });
  } else if (st === 'liquid') {
    box = addSceneBlock({
      x: sp.x, y: topY(3.5), z: sp.z,
      w: 6, h: 3.5, d: 6,
      colorHex: '#00a8ff',
      matterState: 'liquid',
      label: 'Бассейн Воды',
      isCustom: true
    });
  } else if (st === 'gas') {
    box = addSceneBlock({
      x: sp.x, y: topY(2.5), z: sp.z,
      w: 8, h: 2.5, d: 6,
      colorHex: '#ffffff',
      matterState: 'gas',
      label: 'Пушистое Облако',
      isCustom: true
    });
  } else if (st === 'checkpoint') {
    const nextStg = S.allBlocks.filter(b => b.checkpointData && b.checkpointData.enabled).length + 1;
    box = addCheckpointBlock(sp.x, topY(0.8), sp.z, nextStg, `Чекпоинт #${nextStg}`, 50, 2);
    box.isCustom = true;
  } else if (st === 'door') {
    const doorNum = S.allBlocks.filter(b => b.logicData && b.logicData.tag && b.logicData.tag.startsWith('door_')).length + 1;
    const doorTag = `door_${doorNum}`;
    box = addSceneBlock({
      x: sp.x, y: topY(5), z: sp.z,
      w: 5, h: 5, d: 0.8,
      colorHex: '#f39c12',
      gold: true,
      label: `Раздвижная Дверь #${doorNum}`,
      logicData: {
        tag: doorTag,
        trigger: 'keyE',
        action: 'door_slide',
        targetTag: '',
        cost: 0,
        oneTimeBuy: true,
        moveX: 0,
        moveY: 5.2,
        moveZ: 0,
        speed: 5.5,
        stayTime: 4.0,
        cooldown: 1.0,
        showBadge: true,
        promptText: `🚪 Открыть Дверь #${doorNum} [E]`
      },
      isCustom: true
    });
  } else if (st === 'button') {
    const targetDoor = findLatestDoorTag();
    box = addSceneBlock({
      x: sp.x, y: topY(2.2), z: sp.z,
      w: 1.4, h: 2.2, d: 1.4,
      colorHex: '#00e676',
      lightData: { mode: 'visual', color: '#00e676', intensity: 1.4, distance: 10, pulseSpeed: 1.5 },
      label: `Кнопка [E] → #${targetDoor}`,
      logicData: {
        tag: '',
        trigger: 'keyE',
        action: 'door_slide',
        targetTag: targetDoor,
        cost: 0,
        oneTimeBuy: true,
        moveX: 0,
        moveY: 5.2,
        moveZ: 0,
        speed: 5.5,
        stayTime: 4.5,
        cooldown: 0.8,
        showBadge: true,
        promptText: `🔘 Кнопка (Откр. #${targetDoor}) [E]`
      },
      isCustom: true
    });
  } else if (st === 'plate') {
    const targetDoor = findLatestDoorTag();
    box = addSceneBlock({
      x: sp.x, y: topY(0.35), z: sp.z,
      w: 3.2, h: 0.35, d: 3.2,
      colorHex: '#ffce3a',
      lightData: { mode: 'visual', color: '#ffce3a', intensity: 1.2, distance: 8, pulseSpeed: 0 },
      label: `Нажимная Плита → #${targetDoor}`,
      logicData: {
        tag: '',
        trigger: 'touch',
        action: 'door_slide',
        targetTag: targetDoor,
        cost: 0,
        oneTimeBuy: true,
        moveX: 0,
        moveY: 5.2,
        moveZ: 0,
        speed: 6.0,
        stayTime: 5.0,
        cooldown: 1.2,
        showBadge: true,
        promptText: `👟 Наступи (Откр. #${targetDoor})`
      },
      isCustom: true
    });
  } else if (st === 'teleport') {
    const tpPairNum = Math.floor(S.allBlocks.filter(b => b.logicData && b.logicData.action === 'teleport').length / 2) + 1;
    const tagA = `tp_${tpPairNum}_A`;
    const tagB = `tp_${tpPairNum}_B`;

    box = addSceneBlock({
      x: sp.x - 3, y: topY(0.5), z: sp.z,
      w: 3.2, h: 0.5, d: 3.2,
      shape: 'cylinder',
      colorHex: '#00d2ff',
      lightData: { mode: 'point', color: '#00d2ff', intensity: 1.8, distance: 14, pulseSpeed: 2.0 },
      particleData: { enabled: true, preset: 'spark', color: '#56f0ff', rate: 14, lifetime: 1.2, sizeStart: 0.35, sizeEnd: 0, speed: 2.5, spread: 0.8, dirX: 0, dirY: 1, dirZ: 0, gravity: 0, rotSpeed: 2, fadeOut: true, flicker: 0.2 },
      label: `Телепорт #${tpPairNum} (Вход А)`,
      logicData: {
        tag: tagA,
        trigger: 'touch',
        action: 'teleport',
        targetTag: tagB,
        cost: 0,
        cooldown: 1.5,
        showBadge: true,
        promptText: `🌀 Портал А → Б`
      },
      isCustom: true
    });

    addSceneBlock({
      x: sp.x + 3, y: topY(0.5), z: sp.z,
      w: 3.2, h: 0.5, d: 3.2,
      shape: 'cylinder',
      colorHex: '#a29bfe',
      lightData: { mode: 'point', color: '#a29bfe', intensity: 1.8, distance: 14, pulseSpeed: 2.0 },
      particleData: { enabled: true, preset: 'star', color: '#d6a2e8', rate: 14, lifetime: 1.2, sizeStart: 0.35, sizeEnd: 0, speed: 2.5, spread: 0.8, dirX: 0, dirY: 1, dirZ: 0, gravity: 0, rotSpeed: 2, fadeOut: true, flicker: 0.2 },
      label: `Телепорт #${tpPairNum} (Выход Б)`,
      logicData: {
        tag: tagB,
        trigger: 'touch',
        action: 'teleport',
        targetTag: tagA,
        cost: 0,
        cooldown: 1.5,
        showBadge: true,
        promptText: `🌀 Портал Б → А`
      },
      isCustom: true
    });
  } else if (st === 'vip_gate') {
    box = addSceneBlock({
      x: sp.x, y: topY(5), z: sp.z,
      w: 6, h: 5, d: 0.7,
      colorHex: '#ffce3a',
      gold: true,
      lightData: { mode: 'visual', color: '#ffce3a', intensity: 1.1, distance: 12, pulseSpeed: 1.0 },
      label: 'VIP-Ворота (100 R$)',
      logicData: {
        tag: 'vip_gate_' + S.blockIdCounter,
        trigger: 'keyE',
        action: 'door_ghost',
        targetTag: '',
        cost: 100,
        oneTimeBuy: true,
        stayTime: 0,
        cooldown: 0.8,
        showBadge: true,
        promptText: '🔓 Открыть VIP-Проход [E]'
      },
      isCustom: true
    });
  } else if (st === 'shop_pad') {
    box = addSceneBlock({
      x: sp.x, y: topY(0.7), z: sp.z,
      w: 3.4, h: 0.7, d: 3.4,
      colorHex: '#00e676',
      gold: true,
      lightData: { mode: 'visual', color: '#00e676', intensity: 1.3, distance: 10, pulseSpeed: 1.2 },
      label: 'Магазин: Пружина Скорости',
      logicData: {
        tag: '',
        trigger: 'keyE',
        action: 'buy_perk',
        perkType: 'speed',
        cost: 75,
        oneTimeBuy: true,
        cooldown: 1.0,
        showBadge: true,
        promptText: '🛒 Купить Скорость [E]'
      },
      isCustom: true
    });
  } else if (st === 'kill') {
    box = addSceneBlock({
      x: sp.x, y: topY(0.4), z: sp.z,
      w: 4.6, h: 0.4, d: 0.8,
      colorHex: '#ff1e1e',
      damageOnContact: 35,
      teleportToCheckpoint: false,
      label: 'Урон-Лазер',
      isCustom: true
    });
  } else if (st === 'trampoline') {
    box = addSceneBlock({
      x: sp.x, y: topY(0.8), z: sp.z,
      w: 4, h: 0.8, d: 4,
      colorHex: '#00e676',
      bounciness: 16,
      label: 'Прыгучий Батут',
      isCustom: true
    });
  } else if (st === 'spawner') {
    box = addSceneBlock({
      x: sp.x, y: topY(0.8), z: sp.z,
      w: 3.5, h: 0.8, d: 3.5,
      colorHex: '#9b59b6',
      gold: true,
      label: 'Спавнер Объектов',
      spawnerData: { mode: 'timer', interval: 5, timer: 2, spawnType: 'coin' },
      isCustom: true
    });
  } else if (st === 'media_screen') {
    const scrNum = S.allBlocks.filter(b => b.components?.mediaScreen?.enabled).length + 1;
    box = addSceneBlock({
      x: sp.x, y: topY(4.5), z: sp.z,
      w: 8.0, h: 4.5, d: 0.4,
      colorHex: '#111827',
      surfaceType: 'smooth',
      label: `Видео-Экран #${scrNum}`,
      mediaScreenData: createDefaultMediaScreenData(),
      isCustom: true
    });
  } else if (st === 'media_speaker') {
    const spkNum = S.allBlocks.filter(b => b.components?.soundEmitter?.enabled).length + 1;
    box = addSceneBlock({
      x: sp.x, y: topY(2.2), z: sp.z,
      w: 1.4, h: 2.2, d: 1.4,
      colorHex: '#1e293b',
      surfaceType: 'smooth',
      label: `3D-Колонка #${spkNum}`,
      soundEmitterData: createDefaultSoundEmitterData(),
      isCustom: true
    });
  }

  if (box) {
    rebuildPhysicsArrays();
    selectEditorObject({ kind: 'block', box });
    if (openForEdit) {
      focusOnSelected();
      showBanner(`🛠️ Объект «${box.label}» открыт для редактирования в Инспекторе!`, '#56f0ff');
    } else {
      showBanner(`✨ Объект «${box.label}» размещён в мире!`, '#00e676');
    }
    sfx.jump();
  }
}

/* ---------- СИСТЕМА DRAG-AND-DROP (ПРЕФАБЫ, ПРИМИТИВЫ И ВЛОЖЕННОСТЬ ИЕРАРХИИ) ---------- */

const _groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const _studioPlane = new THREE.Plane();
const _hitVec = new THREE.Vector3();

function computeWorldDropPoint(clientX, clientY) {
  const rect = cv.getBoundingClientRect();
  mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);

  const targets = [];
  for (const b of S.allBlocks) {
    if (b.m && b.m.visible) targets.push(b.m);
  }
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length > 0) {
    const pt = hits[0].point.clone();
    if (S.snapEnabled) {
      pt.x = Math.round(pt.x * 2) / 2;
      pt.y = Math.round(pt.y * 2) / 2;
      pt.z = Math.round(pt.z * 2) / 2;
    }
    return pt;
  }

  if (raycaster.ray.intersectPlane(_groundPlane, _hitVec)) {
    const pt = _hitVec.clone();
    if (S.snapEnabled) {
      pt.x = Math.round(pt.x * 2) / 2;
      pt.z = Math.round(pt.z * 2) / 2;
    }
    return pt;
  }

  const fwd = new THREE.Vector3();
  camera.getWorldDirection(fwd);
  return camera.position.clone().addScaledVector(fwd, 8);
}

function computeStudioPrimitiveDropPoint(clientX, clientY) {
  const rect = cv.getBoundingClientRect();
  mouseNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouseNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(mouseNDC, camera);

  const targets = [];
  if (S.selectedRef?.kind === 'world_item' && S.selectedRef.worldEntry?.group) {
    const partMeshes = S.selectedRef.worldEntry.group.userData?.partMeshes || [];
    for (const pm of partMeshes) targets.push(pm);
  } else if (S.selectedRef?.kind === 'cosmetic' && S.selectedRef.group) {
    const partMeshes = S.selectedRef.group.userData?.partMeshes || [];
    for (const pm of partMeshes) targets.push(pm);
  }
  if (S.studioMannequinRig && S.itemStudioShowMannequin !== false) {
    targets.push(S.studioMannequinRig.g);
  }

  const hits = raycaster.intersectObjects(targets, true).filter(
    h => !h.object.userData?.isCharPickMesh
  );
  if (hits.length > 0) {
    return hits[0].point.clone();
  }

  const podiumCenter = new THREE.Vector3(ITEM_STUDIO_ORIGIN.x, ITEM_STUDIO_ORIGIN.y + 1.25, ITEM_STUDIO_ORIGIN.z);
  if (S.selectedRef?.kind === 'cosmetic' && S.selectedRef.group) {
    S.selectedRef.group.getWorldPosition(podiumCenter);
  }
  const camDir = new THREE.Vector3();
  camera.getWorldDirection(camDir);
  _studioPlane.setFromNormalAndCoplanarPoint(camDir.negate(), podiumCenter);

  if (raycaster.ray.intersectPlane(_studioPlane, _hitVec)) {
    return _hitVec.clone();
  }
  return podiumCenter;
}

function applyGhostAppearance(rootObj, colorHex = 0x56f0ff, opacity = 0.45) {
  const ghostMat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  rootObj.traverse(o => {
    o.userData.noCollider = true;
    o.castShadow = false;
    o.receiveShadow = false;
    if (o.isMesh && !o.userData?.isCharPickMesh) {
      o.material = ghostMat;
    }
  });
  rootObj.userData._ghostMaterials = [ghostMat];
}

function addGhostBoxWithOutline(parent, geo, w, h, d, colorHex = 0x56f0ff, posX = 0, posY = 0, posZ = 0) {
  const mat = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.36,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(w, h, d);
  mesh.position.set(posX, posY, posZ);
  mesh.userData.noCollider = true;

  const wireMat = new THREE.LineBasicMaterial({
    color: 0x56f0ff,
    transparent: true,
    opacity: 0.85,
    depthWrite: false
  });
  const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo), wireMat);
  wire.scale.set(w, h, d);
  wire.position.set(posX, posY, posZ);
  wire.userData.noCollider = true;

  parent.add(mesh, wire);
}

function createPreviewGhost3D(dragState) {
  if (dragState.kind === 'hier_item') return null;
  const st = dragState.key;

  // Примитивы в 3D Студии
  if (dragState.kind === 'primitive') {
    const grp = new THREE.Group();
    const shape = st === 'none' ? 'box' : (st || 'box');
    const geo = shape === 'wedge' ? createBlockGeometryByShape('wedge') : getSharedPrimitiveGeo(shape);
    addGhostBoxWithOutline(grp, geo, 0.5, 0.5, 0.5, 0x56f0ff);
    grp.userData.groundOffsetY = 0;
    scene.add(grp);
    return grp;
  }

  // Блокировка превью мировых префабов внутри 3D Студии
  if (S.itemStudioOpen && !st.startsWith('prim_') && !st.startsWith('lib_bbm_')) {
    return null;
  }

  // 1. Встроенное или сохранённое оружие / предмет
  if (st.startsWith('item_') || st.startsWith('lib_item_')) {
    const itemData = st.startsWith('item_')
      ? createStarterItemTemplate(st.replace('item_', ''))
      : S.savedItemsLibrary[+st.replace('lib_item_', '')];
    if (itemData) {
      const grp = buildItemGroup(itemData, { isProjectile: false, showMarkers: false, applyGripOffset: false });
      applyGhostAppearance(grp, 0x56f0ff, 0.55);
      grp.userData.groundOffsetY = 0.4;
      scene.add(grp);
      return grp;
    }
  }

  // 2. NPC-Бот (точный силуэт R6)
  if (st === 'npc') {
    const rig = createRobloxRig({}, 1, false);
    applyGhostAppearance(rig.g, 0x56f0ff, 0.45);
    rig.g.userData.groundOffsetY = 0;
    scene.add(rig.g);
    return rig.g;
  }

  // 3. 3D-модель Blockbench (.bbmodel)
  if (st.startsWith('lib_bbm_')) {
    const modelData = (S.customModelsLibrary || [])[+st.replace('lib_bbm_', '')];
    if (modelData) {
      const bbm = buildBBModelGroup(modelData, '#56f0ff');
      if (bbm) {
        const nat = bbm.userData?.naturalSize || { w: 2, h: 2, d: 2 };
        const grp = new THREE.Group();
        bbm.scale.set(nat.w, nat.h, nat.d);
        applyGhostAppearance(bbm, 0x56f0ff, 0.48);
        grp.add(bbm);
        grp.userData.groundOffsetY = nat.h * 0.5;
        scene.add(grp);
        return grp;
      }
    }
  }

  // 4. Пользовательский сохранённый префаб (блок + все его дочерние части, NPC или предмет)
  if (st.startsWith('custom_prefab_')) {
    const cp = (S.customPrefabsLibrary || []).find(p => p.id === st.replace('custom_prefab_', ''));
    if (cp && cp.data) {
      if (cp.kind === 'npc') {
        const rig = createRobloxRig(cp.data, cp.data.scale || 1, false);
        applyGhostAppearance(rig.g, 0x00e676, 0.46);
        rig.g.userData.groundOffsetY = 0;
        scene.add(rig.g);
        return rig.g;
      }
      if (cp.kind === 'world_item') {
        const grp = buildItemGroup(cp.data, { isProjectile: false, showMarkers: false, applyGripOffset: false });
        applyGhostAppearance(grp, 0x00e676, 0.55);
        grp.userData.groundOffsetY = 0.4;
        scene.add(grp);
        return grp;
      }
      if (cp.kind === 'block') {
        const d = cp.data;
        const grp = new THREE.Group();
        const rootGeo = createBlockGeometryByShape(d.shape || 'box');
        addGhostBoxWithOutline(grp, rootGeo, d.w || 2, d.h || 2, d.d || 2, 0x00e676, 0, 0, 0);
        if (Array.isArray(d.childrenBlocks)) {
          for (const ch of d.childrenBlocks) {
            const cGeo = createBlockGeometryByShape(ch.shape || 'box');
            addGhostBoxWithOutline(grp, cGeo, ch.w || 1, ch.h || 1, ch.d || 1, 0x56f0ff, ch.dx || 0, ch.dy || 0, ch.dz || 0);
          }
        }
        grp.userData.groundOffsetY = (d.h || 1) * 0.5;
        scene.add(grp);
        return grp;
      }
    }
  }

  // 5. Точные размеры и формы всех встроенных блоков / логических префабов
  const grp = new THREE.Group();
  const BUILTIN_SPECS = {
    prim_empty: { shape: 'box', w: 1, h: 1, d: 1, col: 0x56f0ff },
    solid:      { shape: 'box', w: 4, h: 4, d: 4, col: 0x56f0ff },
    liquid:     { shape: 'box', w: 6, h: 3.5, d: 6, col: 0x00a8ff },
    gas:        { shape: 'box', w: 8, h: 2.5, d: 6, col: 0xe2e8f0 },
    checkpoint: { shape: 'box', w: 6.4, h: 0.8, d: 6.4, col: 0xffeaa7 },
    door:       { shape: 'box', w: 5, h: 5, d: 0.8, col: 0xf39c12 },
    button:     { shape: 'box', w: 1.4, h: 2.2, d: 1.4, col: 0x00e676 },
    plate:      { shape: 'box', w: 3.2, h: 0.35, d: 3.2, col: 0xffce3a },
    vip_gate:   { shape: 'box', w: 6, h: 5, d: 0.7, col: 0xffce3a },
    shop_pad:   { shape: 'box', w: 3.4, h: 0.7, d: 3.4, col: 0x00e676 },
    kill:       { shape: 'box', w: 4.6, h: 0.4, d: 0.8, col: 0xff3e3e },
    trampoline: { shape: 'box', w: 4, h: 0.8, d: 4, col: 0x00e676 },
    spawner:    { shape: 'box', w: 3.5, h: 0.8, d: 3.5, col: 0x9b59b6 },
    media_screen:  { shape: 'box', w: 8.0, h: 4.5, d: 0.4, col: 0x00d2ff },
    media_speaker: { shape: 'box', w: 1.4, h: 2.2, d: 1.4, col: 0x00e676 }
  };

  if (st === 'teleport') {
    const cylGeo = createBlockGeometryByShape('cylinder');
    addGhostBoxWithOutline(grp, cylGeo, 3.2, 0.5, 3.2, 0x00d2ff, -3, 0, 0);
    addGhostBoxWithOutline(grp, cylGeo, 3.2, 0.5, 3.2, 0xa29bfe, 3, 0, 0);
    grp.userData.groundOffsetY = 0.25;
  } else if (st && st.startsWith('prim_')) {
    const sh = st.replace('prim_', '');
    const geo = createBlockGeometryByShape(sh);
    addGhostBoxWithOutline(grp, geo, 2, 2, 2, 0x56f0ff);
    grp.userData.groundOffsetY = 1.0;
  } else {
    const spec = BUILTIN_SPECS[st] || { shape: 'box', w: 4, h: 4, d: 4, col: 0x56f0ff };
    const geo = createBlockGeometryByShape(spec.shape);
    addGhostBoxWithOutline(grp, geo, spec.w, spec.h, spec.d, spec.col);
    grp.userData.groundOffsetY = spec.h * 0.5;
  }

  scene.add(grp);
  return grp;
}

function getOrderedSiblingNodes(parentKey) {
  const list = [];
  const checkAndPush = (obj, key) => {
    if (!obj) return;
    if ((getParentKeyOfNode(obj) || null) === (parentKey || null)) {
      ensureNodeHierOrder(obj);
      list.push({ obj, key });
    }
  };

  for (const sf of S.sceneFolders || []) checkAndPush(sf, `folder:${sf.id}`);
  for (const emp of S.emptyObjects || []) checkAndPush(emp, `empty:${emp.id}`);
  if (S.player) checkAndPush(S.player, 'char:player');
  if (S.archangelEnt) checkAndPush(S.archangelEnt, 'char:archangel');
  for (const npc of S.customNPCs) checkAndPush(npc, `char:${npc.id}`);
  for (let i = 0; i < S.queueLine.length; i++) {
    const e = S.queueLine[i];
    if (!e.isP) checkAndPush(e, `char:${e.id}`);
  }
  for (const wi of S.worldItems) checkAndPush(wi, `world_item:${wi.id}`);
  for (const b of S.allBlocks) checkAndPush(b, `block:${b.id}`);

  list.sort((a, b) => (a.obj.hierOrder || 0) - (b.obj.hierOrder || 0));
  return list;
}

function handleHierarchyReparentDrop(draggedKey, targetKey, dropPosition = 'inside') {
  if (!draggedKey || draggedKey === targetKey) return;

  // 1. Вложенность и смена порядка примитивов внутри одного предмета (item_part)
  if (draggedKey.startsWith('item_part:')) {
    const [, wiId, ptIdxStr] = draggedKey.split(':');
    const wi = S.worldItems.find(w => w.id === wiId) || (S.selectedRef?.worldEntry?.id === wiId ? S.selectedRef.worldEntry : null);
    if (!wi || !wi.item) return;
    const parts = wi.item.parts;
    const fromIdx = +ptIdxStr;
    const childPt = parts[fromIdx];
    if (!childPt) return;

    const finishItemPartReorder = () => {
      const newIdx = Math.max(0, parts.indexOf(childPt));
      selectEditorObject({
        kind: 'world_item',
        worldEntry: wi,
        item: wi.item,
        editMode: 'part',
        partIdx: newIdx,
        inWorldPlacement: !S.itemStudioOpen,
        libIdx: S.selectedRef?.libIdx
      }, true);
      if (S.itemStudioOpen) syncItemStudioPreview();
      sfx.jump();
    };

    if (!targetKey || targetKey === `world_item:${wiId}`) {
      childPt.parentPartId = null;
      finishItemPartReorder();
      return;
    }
    if (targetKey.startsWith(`item_part:${wiId}:`)) {
      const targetPtIdx = +targetKey.split(':')[2];
      const targetPt = parts[targetPtIdx];
      if (!targetPt || targetPt === childPt) return;

      if (dropPosition === 'inside') {
        if (!isPartDescendantOf(parts, targetPt.id, childPt.id)) {
          childPt.parentPartId = targetPt.id;
          finishItemPartReorder();
          showBanner(`🧩 «${childPt.name}» вложен в «${targetPt.name}»!`, '#00e676');
        }
      } else {
        if (!isPartDescendantOf(parts, targetPt.parentPartId, childPt.id)) {
          childPt.parentPartId = targetPt.parentPartId || null;
        }
        parts.splice(fromIdx, 1);
        const newTargetIdx = parts.indexOf(targetPt);
        const insertIdx = dropPosition === 'before' ? newTargetIdx : newTargetIdx + 1;
        parts.splice(insertIdx, 0, childPt);
        finishItemPartReorder();
      }
    }
    return;
  }

  // 2. Вложенность и смена порядка примитивов внутри одного аксессуара (cos_part)
  if (draggedKey.startsWith('cos_part:')) {
    const [, charId, cosIdxStr, ptIdxStr] = draggedKey.split(':');
    const entInfo = getSceneNodeByKey(`char:${charId}`);
    const ent = entInfo?.obj;
    const cos = ent?.preset?.customCosmetics?.[+cosIdxStr];
    if (!cos) return;
    const parts = cos.parts;
    const fromIdx = +ptIdxStr;
    const childPt = parts[fromIdx];
    if (!childPt) return;

    const finishCosPartReorder = () => {
      const newIdx = Math.max(0, parts.indexOf(childPt));
      if (ent?.rig) {
        ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
        attachRigToEntity(ent);
      }
      const newGroup = ent?.rig?.customCosMeshes?.find(g => g.userData?.cosmeticItem === cos);
      selectEditorObject({
        kind: 'cosmetic',
        ent,
        item: cos,
        group: newGroup,
        editMode: 'part',
        partIdx: newIdx,
        inWorldPlacement: !S.itemStudioOpen,
        libIdx: S.selectedRef?.libIdx
      }, true);
      if (S.itemStudioOpen) syncItemStudioPreview();
      sfx.jump();
    };

    if (!targetKey || targetKey === `cosmetic:${charId}:${cosIdxStr}`) {
      childPt.parentPartId = null;
      finishCosPartReorder();
      return;
    }
    if (targetKey.startsWith(`cos_part:${charId}:${cosIdxStr}:`)) {
      const targetPtIdx = +targetKey.split(':')[3];
      const targetPt = parts[targetPtIdx];
      if (!targetPt || targetPt === childPt) return;

      if (dropPosition === 'inside') {
        if (!isPartDescendantOf(parts, targetPt.id, childPt.id)) {
          childPt.parentPartId = targetPt.id;
          finishCosPartReorder();
          showBanner(`🧩 «${childPt.name}» вложен в «${targetPt.name}»!`, '#00e676');
        }
      } else {
        if (!isPartDescendantOf(parts, targetPt.parentPartId, childPt.id)) {
          childPt.parentPartId = targetPt.parentPartId || null;
        }
        parts.splice(fromIdx, 1);
        const newTargetIdx = parts.indexOf(targetPt);
        const insertIdx = dropPosition === 'before' ? newTargetIdx : newTargetIdx + 1;
        parts.splice(insertIdx, 0, childPt);
        finishCosPartReorder();
      }
    }
    return;
  }

  // 3. Объекты сцены (block, world_item, char, empty, folder): смена порядка (before/after) или вложение (inside)
  const draggedInfo = getSceneNodeByKey(draggedKey);
  if (!draggedInfo || !draggedInfo.obj) return;

  if (!targetKey) {
    setParentKeyOfNode(draggedInfo.obj, null);
    const roots = getOrderedSiblingNodes(null);
    draggedInfo.obj.hierOrder = (roots.length + 1) * 10;
    sfx.jump();
    refreshHierarchyUI();
    showBanner(`⤴ Объект вынесен в корень сцены`, '#56f0ff');
    return;
  }

  const targetInfo = getSceneNodeByKey(targetKey);
  if (!targetInfo || !targetInfo.obj) return;

  if (dropPosition === 'inside') {
    if (isDescendantOf(targetKey, draggedKey)) {
      showBanner('Нельзя вложить родительский объект внутрь его собственного дочернего элемента!', '#ffce3a');
      return;
    }
    setParentKeyOfNode(draggedInfo.obj, targetKey);
    if (targetInfo.kind === 'folder') targetInfo.obj.collapsed = false;
    else targetInfo.obj.hierCollapsed = false;

    const children = getOrderedSiblingNodes(targetKey);
    draggedInfo.obj.hierOrder = (children.length + 1) * 10;
    sfx.jump();
    refreshHierarchyUI();
    showBanner(`🔗 Установлен родитель! Двигая родителя, ты двигаешь всю структуру целиком.`, '#00e676');
    return;
  }

  // Режим 'before' или 'after' (перестановка объектов местами на одном уровне как в Unity)
  const newParentKey = getParentKeyOfNode(targetInfo.obj) || null;
  if (newParentKey && isDescendantOf(newParentKey, draggedKey)) {
    showBanner('Нельзя переместить родителя внутрь собственной ветки!', '#ffce3a');
    return;
  }

  setParentKeyOfNode(draggedInfo.obj, newParentKey);
  const siblings = getOrderedSiblingNodes(newParentKey).filter(s => s.key !== draggedKey);
  const targetIdx = siblings.findIndex(s => s.key === targetKey);
  const insertIdx = dropPosition === 'before'
    ? Math.max(0, targetIdx)
    : (targetIdx >= 0 ? targetIdx + 1 : siblings.length);

  siblings.splice(insertIdx, 0, { obj: draggedInfo.obj, key: draggedKey });
  for (let i = 0; i < siblings.length; i++) {
    siblings[i].obj.hierOrder = (i + 1) * 10;
  }

  sfx.jump();
  refreshHierarchyUI();
}

/* ---------- КОНТЕКСТНОЕ МЕНЮ ИЕРАРХИИ (ПКМ НА ПК / ДОЛГИЙ ТАП НА ТЕЛЕФОНЕ) ---------- */

let activeCtxMenuEl = null;

export function closeHierarchyContextMenu() {
  if (activeCtxMenuEl && activeCtxMenuEl.parentNode) {
    activeCtxMenuEl.parentNode.removeChild(activeCtxMenuEl);
  }
  activeCtxMenuEl = null;
}

export function openHierarchyContextMenu(clientX, clientY, targetNodeKey = null) {
  closeHierarchyContextMenu();
  if (S.state !== 'edit') return;

  // Определяем, кликнули ли по предмету/аксессуару или его детали (либо открыта 3D Студия предмета/аксессуара)
  let itemOrCosPartContext = null;
  if (targetNodeKey && (targetNodeKey.startsWith('world_item:') || targetNodeKey.startsWith('item_part:'))) {
    const parts = targetNodeKey.split(':');
    const wiId = parts[1];
    const wi = S.worldItems.find(w => w.id === wiId) || (S.selectedRef?.worldEntry?.id === wiId ? S.selectedRef.worldEntry : null);
    if (wi && wi.item) {
      const ptIdx = targetNodeKey.startsWith('item_part:') ? +parts[2] : -1;
      const ptObj = ptIdx >= 0 ? wi.item.parts[ptIdx] : null;
      itemOrCosPartContext = { kind: 'world_item', wi, item: wi.item, part: ptObj, partIdx: ptIdx };
    }
  } else if (targetNodeKey && (targetNodeKey.startsWith('cosmetic:') || targetNodeKey.startsWith('cos_part:'))) {
    const parts = targetNodeKey.split(':');
    const charId = parts[1];
    const cIdx = +parts[2];
    const entInfo = getSceneNodeByKey(`char:${charId}`);
    const ent = entInfo?.obj;
    const cos = ent?.preset?.customCosmetics?.[cIdx];
    if (ent && cos) {
      const ptIdx = targetNodeKey.startsWith('cos_part:') ? +parts[3] : -1;
      const ptObj = ptIdx >= 0 ? cos.parts[ptIdx] : null;
      itemOrCosPartContext = { kind: 'cosmetic', ent, item: cos, part: ptObj, partIdx: ptIdx };
    }
  } else if (!targetNodeKey && S.itemStudioOpen && S.selectedRef && (S.selectedRef.kind === 'world_item' || S.selectedRef.kind === 'cosmetic')) {
    itemOrCosPartContext = {
      kind: S.selectedRef.kind,
      wi: S.selectedRef.worldEntry,
      ent: S.selectedRef.ent,
      item: S.selectedRef.item,
      part: null,
      partIdx: -1
    };
  }

  let resolvedParentKey = targetNodeKey;
  if (resolvedParentKey && resolvedParentKey.startsWith('item_part:')) {
    const wiId = resolvedParentKey.split(':')[1];
    resolvedParentKey = `world_item:${wiId}`;
  } else if (resolvedParentKey && (resolvedParentKey.startsWith('cos_part:') || resolvedParentKey.startsWith('cosmetic:'))) {
    const charId = resolvedParentKey.split(':')[1];
    resolvedParentKey = `char:${charId}`;
  }

  const targetInfo = resolvedParentKey ? getSceneNodeByKey(resolvedParentKey) : null;
  const targetTitle = targetInfo
    ? (targetInfo.obj.name || targetInfo.obj.label || (targetInfo.obj.item && targetInfo.obj.item.name) || 'Объект')
    : 'Корень сцены';

  const menu = document.createElement('div');
  menu.className = 'hier-ctx-menu';

  if (targetInfo) {
    const hasParent = !!getParentKeyOfNode(targetInfo.obj);
    const isProtectedChar = targetInfo.kind === 'char' && (targetInfo.obj.isP || (!targetInfo.obj.isCustomNPC && !targetInfo.obj.isArchangel));
    menu.innerHTML = `
      <div class="hier-ctx-title">🎯 ${targetTitle}</div>
      <button class="hier-ctx-btn" data-ctx-act="create_empty_child" type="button">🎯 Дочерняя пустышка (0,0,0)</button>
      <button class="hier-ctx-btn" data-ctx-act="create_prim_child" data-shape="box" type="button">🧊 Дочерний Куб (Белый примитив)</button>
      <button class="hier-ctx-btn" data-ctx-act="create_prim_child" data-shape="cylinder" type="button">🛢️ Дочерний Цилиндр</button>
      <button class="hier-ctx-btn" data-ctx-act="create_prim_child" data-shape="sphere" type="button">⚪ Дочерняя Сфера</button>
      <button class="hier-ctx-btn" data-ctx-act="create_prim_child" data-shape="wedge" type="button">📐 Дочерний Клин / Лезвие</button>
      <div class="hier-ctx-sep"></div>
      <button class="hier-ctx-btn" data-ctx-act="upload_hub" type="button" style="color:#00e676">☁️ Загрузить в библиотеку (UGC)</button>
      ${hasParent ? `<button class="hier-ctx-btn" data-ctx-act="unparent" type="button">⤴ Вынести в корень сцены</button>` : ''}
      <button class="hier-ctx-btn" data-ctx-act="focus" type="button">👁️ Сфокусировать камеру (F)</button>
      ${!isProtectedChar ? `<div class="hier-ctx-sep"></div><button class="hier-ctx-btn" data-ctx-act="delete_node" type="button" style="color:#ff4757">🗑️ Удалить (и дочерние объекты)</button>` : ''}
    `;
  } else {
    menu.innerHTML = `
      <div class="hier-ctx-title">📂 Иерархия Сцены</div>
      <button class="hier-ctx-btn" data-ctx-act="create_empty_root" type="button">🎯 Создать пустой объект (Пустышку)</button>
      <button class="hier-ctx-btn" data-ctx-act="create_prim_root" data-shape="box" type="button">🧊 Создать Примитив: Куб</button>
      <button class="hier-ctx-btn" data-ctx-act="create_prim_root" data-shape="cylinder" type="button">🛢️ Создать Примитив: Цилиндр</button>
      <button class="hier-ctx-btn" data-ctx-act="create_prim_root" data-shape="sphere" type="button">⚪ Создать Примитив: Сфера</button>
      <button class="hier-ctx-btn" data-ctx-act="create_prim_root" data-shape="wedge" type="button">📐 Создать Примитив: Клин</button>
      <div class="hier-ctx-sep"></div>
      ${!S.itemStudioOpen || targetInfo ? `<button class="hier-ctx-btn" data-ctx-act="create_folder" type="button">📁 Создать группу / папку</button>` : ''}
    `;
  }

  document.body.appendChild(menu);
  activeCtxMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, clientX));
  const top = Math.min(window.innerHeight - rect.height - 8, Math.max(8, clientY));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  const selectTargetNodeRef = () => {
    if (!targetInfo) return null;
    let ref = null;
    if (targetInfo.kind === 'block') ref = { kind: 'block', box: targetInfo.obj };
    else if (targetInfo.kind === 'world_item') ref = { kind: 'world_item', worldEntry: targetInfo.obj, item: targetInfo.obj.item, editMode: 'root', inWorldPlacement: !S.itemStudioOpen };
    else if (targetInfo.kind === 'char') ref = { kind: 'char', ent: targetInfo.obj, editMode: 'root' };
    else if (targetInfo.kind === 'empty') ref = { kind: 'empty', emptyObj: targetInfo.obj };
    else if (targetInfo.kind === 'folder') ref = { kind: 'folder', folder: targetInfo.obj };
    if (ref) selectEditorObject(ref);
    return ref;
  };

  const spawnModularNodeFromCtx = (isRawEmpty, shape, parentKey) => {
    let x = 0, y = 2, z = 0, rx = 0, ry = 0, rz = 0;
    if (parentKey) {
      const pInfo = getSceneNodeByKey(parentKey);
      if (pInfo && pInfo.mesh) {
        pInfo.mesh.updateMatrixWorld(true);
        const wp = new THREE.Vector3();
        const wq = new THREE.Quaternion();
        const ws = new THREE.Vector3();
        pInfo.mesh.matrixWorld.decompose(wp, wq, ws);
        const we = new THREE.Euler().setFromQuaternion(wq);
        x = Number(wp.x.toFixed(3));
        y = Number(wp.y.toFixed(3));
        z = Number(wp.z.toFixed(3));
        rx = we.x; ry = we.y; rz = we.z;
      }
      if (pInfo && pInfo.obj) {
        if (pInfo.kind === 'folder') pInfo.obj.collapsed = false;
        else pInfo.obj.hierCollapsed = false;
      }
    } else {
      const fwd = new THREE.Vector3(
        -Math.sin(S.edYaw) * Math.cos(S.edPitch),
        Math.sin(S.edPitch),
        -Math.cos(S.edYaw) * Math.cos(S.edPitch)
      );
      const sp = S.edCamPos.clone().addScaledVector(fwd, 7);
      x = Math.round(sp.x * 2) / 2;
      y = Math.max(1, Math.round(sp.y * 2) / 2);
      z = Math.round(sp.z * 2) / 2;
    }

    const sz = isRawEmpty ? 1 : (parentKey ? 1 : 2);
    const shapeRu = PRIMITIVE_LABELS_RU[shape] || 'Куб';
    const box = addSceneBlock({
      x, y: y + sz * 0.5, z,
      w: sz, h: sz, d: sz,
      colorHex: '#f1f5f9',
      shape: shape || 'box',
      label: isRawEmpty ? `Пустышка #${S.blockIdCounter}` : `${shapeRu} #${S.blockIdCounter}`,
      isRawEmpty,
      isRawPrimitive: !isRawEmpty,
      isCustom: true
    });
    box.m.position.set(x, y, z);
    box.m.rotation.set(rx, ry, rz);
    box.m.updateMatrixWorld(true);
    setParentKeyOfNode(box, parentKey || null);
    ensureNodeHierOrder(box);
    rebuildPhysicsArrays();
    selectEditorObject({ kind: 'block', box, inStudio: S.itemStudioOpen });
    sfx.jump();
  };

  menu.querySelectorAll('[data-ctx-act]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const act = btn.dataset.ctxAct;
      const shape = btn.dataset.shape || 'box';
      closeHierarchyContextMenu();

      if (
        itemOrCosPartContext &&
        (act === 'create_empty_root' || act === 'create_empty_child' || act === 'create_prim_root' || act === 'create_prim_child')
      ) {
        const isEmpty = act === 'create_empty_root' || act === 'create_empty_child';
        const targetShape = isEmpty ? 'none' : (shape === 'wedge' ? 'box' : shape);
        const parentPtId = (act === 'create_empty_child' || act === 'create_prim_child') && itemOrCosPartContext.part
          ? itemOrCosPartContext.part.id
          : null;

        if (itemOrCosPartContext.kind === 'world_item') {
          selectEditorObject({
            kind: 'world_item',
            worldEntry: itemOrCosPartContext.wi,
            item: itemOrCosPartContext.item,
            editMode: 'part',
            partIdx: Math.max(0, itemOrCosPartContext.partIdx),
            inWorldPlacement: !S.itemStudioOpen
          }, true);
        } else {
          const grp = itemOrCosPartContext.ent.rig?.customCosMeshes?.find(g => g.userData?.cosmeticItem === itemOrCosPartContext.item);
          selectEditorObject({
            kind: 'cosmetic',
            ent: itemOrCosPartContext.ent,
            item: itemOrCosPartContext.item,
            group: grp,
            editMode: 'part',
            partIdx: Math.max(0, itemOrCosPartContext.partIdx),
            inWorldPlacement: !S.itemStudioOpen
          }, true);
        }
        spawnPrimitiveInEditor(targetShape, null, parentPtId);
        return;
      }

      if (act === 'create_empty_root') {
        pushUndoState('Создание пустого объекта');
        spawnModularNodeFromCtx(true, 'box', null);
        showBanner('🎯 Пустой объект создан! Добавляй ему свойства через «+» в Инспекторе.', '#00e676');
      } else if (act === 'create_empty_child' && resolvedParentKey) {
        pushUndoState('Создание дочерней пустышки');
        spawnModularNodeFromCtx(true, 'box', resolvedParentKey);
        showBanner(`🎯 Дочерняя пустышка создана в (0, 0, 0) объекта «${targetTitle}»!`, '#00e676');
      } else if (act === 'create_prim_root') {
        pushUndoState('Создание примитива');
        spawnModularNodeFromCtx(false, shape, null);
        showBanner(`🧊 Белый примитив создан! Добавь «Визуал» или «Физику» через «+» в Инспекторе.`, '#00e676');
      } else if (act === 'create_prim_child' && resolvedParentKey) {
        pushUndoState('Создание дочернего примитива');
        spawnModularNodeFromCtx(false, shape, resolvedParentKey);
        showBanner(`🧊 Дочерний примитив создан внутри «${targetTitle}»!`, '#00e676');
      } else if (act === 'unparent' && targetInfo?.obj) {
        setParentKeyOfNode(targetInfo.obj, null);
        sfx.jump();
        refreshHierarchyUI();
      } else if (act === 'focus' && targetInfo) {
        selectTargetNodeRef();
        focusOnSelected();
      } else if (act === 'upload_hub' && targetInfo) {
        const ref = selectTargetNodeRef();
        if (ref && window.__debixPublishSelectedToHub) {
          window.__debixPublishSelectedToHub(ref);
        }
      } else if (act === 'delete_node' && targetInfo) {
        selectTargetNodeRef();
        deleteSelected();
      } else if (act === 'create_folder') {
        $('btnAddHierFolder')?.click();
      }
    };
  });
}

// Контекстное меню ПКМ для карточек префабов в нижней панели (#studioBottomDock)
export function openPrefabDockContextMenu(clientX, clientY, cardId, spawnKey) {
  closeHierarchyContextMenu();
  if (S.state !== 'edit') return;

  const allCards = getAllAvailablePrefabCards();
  const card = allCards.find(c => c.id === cardId || c.spawnKey === spawnKey);
  if (!card) return;

  const activeCustomFolder = (S.prefabFolders || []).find(f => f.id === S.activePrefabFolderId);
  const canDelete = Boolean(activeCustomFolder || card.isCustom);

  const menu = document.createElement('div');
  menu.className = 'hier-ctx-menu';
  menu.innerHTML = `
    <div class="hier-ctx-title">📦 ${card.title}</div>
    <button class="hier-ctx-btn" data-pctx="upload" type="button" style="color:#00e676">☁️ Загрузить в библиотеку (UGC)</button>
    <button class="hier-ctx-btn" data-pctx="spawn" type="button">➕ Разместить на сцене</button>
    <button class="hier-ctx-btn" data-pctx="edit3d" type="button">🛠️ Открыть в 3D Студии</button>
    ${canDelete ? `<div class="hier-ctx-sep"></div><button class="hier-ctx-btn" data-pctx="delete" type="button" style="color:#ff4757">🗑️ ${activeCustomFolder ? 'Убрать из папки' : 'Удалить префаб'}</button>` : ''}
  `;

  document.body.appendChild(menu);
  activeCtxMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const left = Math.min(window.innerWidth - rect.width - 8, Math.max(8, clientX));
  const top = Math.min(window.innerHeight - rect.height - 8, Math.max(8, clientY));
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';

  menu.querySelectorAll('[data-pctx]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const act = btn.dataset.pctx;
      closeHierarchyContextMenu();

      if (act === 'upload') {
        if (card.isCustom && window.__debixPublishDockCardToHub) {
          window.__debixPublishDockCardToHub(card);
        } else {
          spawnPrefabFromCard(card.spawnKey, null, false);
          if (window.__debixPublishSelectedToHub && S.selectedRef) {
            window.__debixPublishSelectedToHub(S.selectedRef);
          }
        }
      } else if (act === 'spawn') {
        spawnPrefabFromCard(card.spawnKey, null, false);
      } else if (act === 'edit3d') {
        spawnPrefabFromCard(card.spawnKey, null, true);
      } else if (act === 'delete') {
        const cid = card.id;
        if (activeCustomFolder) {
          activeCustomFolder.items = (activeCustomFolder.items || []).filter(x => x !== cid);
          refreshPrefabDockUI();
          return;
        }
        if (cid.startsWith('cpref_')) {
          const idx = (S.customPrefabsLibrary || []).findIndex(p => p.id === cid);
          if (idx >= 0) S.customPrefabsLibrary.splice(idx, 1);
        } else if (cid.startsWith('lib_item_')) {
          const idx = +cid.replace('lib_item_', '');
          if (S.savedItemsLibrary[idx]) S.savedItemsLibrary.splice(idx, 1);
        } else if (cid.startsWith('lib_cos_')) {
          const idx = +cid.replace('lib_cos_', '');
          if (S.savedCosmeticsLibrary[idx]) S.savedCosmeticsLibrary.splice(idx, 1);
        } else if (cid.startsWith('lib_bbm_')) {
          const idx = +cid.replace('lib_bbm_', '');
          if (S.customModelsLibrary && S.customModelsLibrary[idx]) S.customModelsLibrary.splice(idx, 1);
        }
        sfx.oof();
        refreshPrefabDockUI();
      }
    };
  });
}

export function initHierarchyAndSpawn() {
  if ($('hierFilter')) $('hierFilter').onchange = refreshHierarchyUI;
  if ($('hierSearchInp')) $('hierSearchInp').oninput = refreshHierarchyUI;

  // Добавим в шапку Иерархии быструю кнопку "+ Пустышка" (удобно в 1 тап на телефоне и ПК)
  const addFolderBtn = $('btnAddHierFolder');
  if (addFolderBtn && !$('btnAddEmptyObj')) {
    const emptyBtn = document.createElement('button');
    emptyBtn.className = 'ed-btn';
    emptyBtn.id = 'btnAddEmptyObj';
    emptyBtn.type = 'button';
    emptyBtn.style.cssText = 'padding:2px 7px;font-size:10px;border-color:#56f0ff;color:#56f0ff';
    emptyBtn.title = 'Создать пустышку (если выбран объект — создастся внутри него в 0,0,0)';
    emptyBtn.textContent = '🎯+ Пустышка';
    addFolderBtn.parentNode.insertBefore(emptyBtn, addFolderBtn);

    emptyBtn.onclick = () => {
      if (S.selectedRef && (S.selectedRef.kind === 'world_item' || S.selectedRef.kind === 'cosmetic')) {
        const parentPtId = (S.selectedRef.editMode === 'part' || S.selectedRef.editMode === 'proj_part') && S.selectedRef.part
          ? S.selectedRef.part.id
          : null;
        spawnPrimitiveInEditor('none', null, parentPtId);
        return;
      }
      if (S.selectedRef && S.selectedRef.kind === 'block' && S.itemStudioOpen) {
        spawnPrimitiveInEditor('none', null);
        return;
      }
      const parentKey = getKeyFromEditorRef(S.selectedRef);
      pushUndoState('Создание пустышки');
      let x = 0, y = 2, z = 0, rx = 0, ry = 0, rz = 0;
      if (parentKey) {
        const pInfo = getSceneNodeByKey(parentKey);
        if (pInfo && pInfo.mesh) {
          pInfo.mesh.updateMatrixWorld(true);
          const wp = new THREE.Vector3(), wq = new THREE.Quaternion(), ws = new THREE.Vector3();
          pInfo.mesh.matrixWorld.decompose(wp, wq, ws);
          const we = new THREE.Euler().setFromQuaternion(wq);
          x = Number(wp.x.toFixed(3)); y = Number(wp.y.toFixed(3)); z = Number(wp.z.toFixed(3));
          rx = we.x; ry = we.y; rz = we.z;
        }
        if (pInfo && pInfo.obj) {
          if (pInfo.kind === 'folder') pInfo.obj.collapsed = false;
          else pInfo.obj.hierCollapsed = false;
        }
      } else {
        const fwd = new THREE.Vector3(
          -Math.sin(S.edYaw) * Math.cos(S.edPitch),
          Math.sin(S.edPitch),
          -Math.cos(S.edYaw) * Math.cos(S.edPitch)
        );
        const sp = S.edCamPos.clone().addScaledVector(fwd, 7);
        x = Math.round(sp.x * 2) / 2;
        y = Math.max(0.5, Math.round(sp.y * 2) / 2);
        z = Math.round(sp.z * 2) / 2;
      }
      const box = addSceneBlock({
        x, y: y + 0.5, z,
        w: 1, h: 1, d: 1,
        colorHex: '#f1f5f9',
        label: `Пустышка #${S.blockIdCounter}`,
        shape: 'box',
        isRawEmpty: true,
        isCustom: true
      });
      box.m.position.set(x, y, z);
      box.m.rotation.set(rx, ry, rz);
      box.m.updateMatrixWorld(true);
      setParentKeyOfNode(box, parentKey || null);
      ensureNodeHierOrder(box);
      rebuildPhysicsArrays();
      selectEditorObject({ kind: 'block', box });
      sfx.jump();
      showBanner(
        parentKey
          ? `🎯 Дочерняя пустышка «${box.label}» создана в (0, 0, 0) родителя!`
          : `🎯 Пустышка «${box.label}» создана! Нажми «+ Добавить свойство» справа.`,
        '#00e676'
      );
    };
  }

  if ($('btnAddHierFolder')) {
    $('btnAddHierFolder').onclick = () => {
      const name = prompt('Название новой родительской группы в сцене:', `Группа #${(S.sceneFolders?.length || 0) + 1}`);
      if (!name || !name.trim()) return;
      if (!Array.isArray(S.sceneFolders)) S.sceneFolders = [];
      S.sceneFolders.push({
        id: 'sf_' + Date.now(),
        name: name.trim(),
        collapsed: false,
        hierOrder: ensureNodeHierOrder({})
      });
      sfx.jump();
      refreshHierarchyUI();
    };
  }

  // ПКМ в окне иерархии (по объекту или в пустом месте)
  const hierCont = $('hierContainer');
  if (hierCont) {
    hierCont.addEventListener('contextmenu', e => {
      if (isPaintModalOpen() || S.scriptModalOpen) return;
      if (S.state !== 'edit') return;
      e.preventDefault();
      e.stopPropagation();
      const row = e.target.closest('.hier-item[data-hkey]');
      openHierarchyContextMenu(e.clientX, e.clientY, row ? row.dataset.hkey : null);
    });
  }

  if ($('btnNewPrefabFolder')) {
    $('btnNewPrefabFolder').onclick = () => {
      const name = prompt('Введите название новой папки префабов:', `Моя папка #${(S.prefabFolders?.length || 0) + 1}`);
      if (!name || !name.trim()) return;
      if (!Array.isArray(S.prefabFolders)) S.prefabFolders = [];
      const newFolder = {
        id: 'uf_' + Date.now(),
        name: name.trim(),
        items: []
      };
      S.prefabFolders.push(newFolder);
      S.activePrefabFolderId = newFolder.id;
      sfx.jump();
      refreshPrefabDockUI();
      showBanner(`📁 Создана папка «${newFolder.name}»! Перетаскивай на неё карточки префабов.`, '#56f0ff');
    };
  }

  if ($('btnSaveSelectedAsPrefab')) {
    $('btnSaveSelectedAsPrefab').onclick = () => saveSelectedObjectAsPrefab();
    // Добавляем рядом с кнопкой сохранения префаба быструю кнопку открытия Мастерской UGC (не меняя вёрстку дока!)
    if (!$('btnOpenUgcHubDock')) {
      const hubBtn = document.createElement('button');
      hubBtn.type = 'button';
      hubBtn.id = 'btnOpenUgcHubDock';
      hubBtn.className = 'ed-btn apply-oneclick';
      hubBtn.style.cssText = 'padding:4px 9px;font-size:10.5px;background:linear-gradient(135deg,#00a2ff,#0066ff);border-color:#56f0ff;color:#fff';
      hubBtn.title = 'Открыть общую Мастерскую префабов, карт, оружия, аксессуаров и NPC';
      hubBtn.innerHTML = '📚 Мастерская UGC';
      $('btnSaveSelectedAsPrefab').parentNode.insertBefore(hubBtn, $('btnSaveSelectedAsPrefab').nextSibling);
      hubBtn.onclick = e => {
        e.stopPropagation();
        if (window.__debixOpenUgcHub) window.__debixOpenUgcHub();
      };
    }
  }

  if ($('prefabSearchInp')) {
    $('prefabSearchInp').oninput = () => refreshPrefabDockUI();
  }

  if ($('prefabScaleSlider')) {
    $('prefabScaleSlider').value = S.prefabCardSize || 96;
    $('prefabScaleSlider').oninput = e => {
      S.prefabCardSize = +e.target.value || 96;
      const gridEl = $('prefabGridContainer');
      if (gridEl) gridEl.style.setProperty('--card-size', S.prefabCardSize + 'px');
    };
  }

  if ($('btnToggleBottomDock')) {
    $('btnToggleBottomDock').onclick = () => {
      const dock = $('studioBottomDock');
      if (!dock) return;
      S.bottomDockCollapsed = !S.bottomDockCollapsed;
      dock.classList.toggle('collapsed', S.bottomDockCollapsed);
      $('btnToggleBottomDock').textContent = S.bottomDockCollapsed ? '▲' : '▼';
    };
  }

  populateStudioCardThumbnails();

  let activeDrag = null;
  let longPressTimer = null;

  const cancelLongPress = () => {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  };

  const clearFolderDragHighlights = () => {
    document
      .querySelectorAll('.folder-item.drag-over,.hier-item.drag-over-parent,.hier-item.drop-before,.hier-item.drop-after,.hier-root-dropzone.drag-over-parent')
      .forEach(el => {
        el.classList.remove('drag-over', 'drag-over-parent', 'drop-before', 'drop-after');
      });
    document.querySelectorAll('[data-screen-speaker-drop]').forEach(el => {
      el.style.borderColor = '#38bdf8';
      el.style.background = 'rgba(16,24,42,0.75)';
    });
  };

  const clearActiveDrag = () => {
    cancelLongPress();
    if (!activeDrag) return;
    if (activeDrag.el) activeDrag.el.classList.remove('dragging');
    if (activeDrag.badgeEl && activeDrag.badgeEl.parentNode) {
      activeDrag.badgeEl.parentNode.removeChild(activeDrag.badgeEl);
    }
    if (activeDrag.preview3D) {
      scene.remove(activeDrag.preview3D);
    }
    clearFolderDragHighlights();
    activeDrag = null;
  };

  document.addEventListener('pointerdown', e => {
    if (isPaintModalOpen() || S.scriptModalOpen) return;
    if (!e.target.closest('.hier-ctx-menu')) {
      closeHierarchyContextMenu();
    }
    if (e.button !== 0 || S.state !== 'edit') return;
    if (e.target.closest('button.card-del-btn,button.hier-qbtn,button.hier-exp-btn')) return;

    // Долгое нажатие пальцем (Long-Press ~450 мс) в окне иерархии на телефоне/планшете открывает контекстное меню
    const inHierContainer = e.target.closest('#hierContainer');
    const hierItem = e.target.closest('.hier-item[data-hkey]');
    if (inHierContainer && (e.pointerType === 'touch' || e.pointerType === 'pen')) {
      const touchX = e.clientX;
      const touchY = e.clientY;
      const targetKey = hierItem ? hierItem.dataset.hkey : null;
      cancelLongPress();
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        clearActiveDrag();
        openHierarchyContextMenu(touchX, touchY, targetKey);
      }, 450);
    }

    const spawnCard = e.target.closest('.spawn-card[data-spawn]');
    const primCard = e.target.closest('.prim-card[data-prim]');
    if (!spawnCard && !primCard && !hierItem) return;

    if (spawnCard || primCard) e.preventDefault();
    const el = spawnCard || primCard || hierItem;
    const kind = primCard ? 'primitive' : (spawnCard ? 'prefab' : 'hier_item');
    const key = primCard
      ? primCard.dataset.prim
      : (spawnCard ? spawnCard.dataset.spawn : hierItem.dataset.hkey);
    const cardId = spawnCard ? spawnCard.dataset.cardId : null;
    const label = spawnCard
      ? (spawnCard.querySelector('.card-title')?.textContent.trim() || spawnCard.textContent.trim())
      : (primCard ? primCard.textContent.trim() : (hierItem.querySelector('.hier-item-main')?.textContent.trim() || 'Объект'));
    const imgEl = el.querySelector('img');
    const thumbSrc = imgEl ? imgEl.src : '';

    activeDrag = {
      kind,
      key,
      cardId,
      label,
      thumbSrc,
      el,
      startX: e.clientX,
      startY: e.clientY,
      isDragging: false,
      dropMode: 'inside',
      badgeEl: null,
      preview3D: null
    };
  });

  document.addEventListener('pointermove', e => {
    if (!activeDrag) {
      if (longPressTimer) cancelLongPress();
      return;
    }
    const dist = Math.hypot(e.clientX - activeDrag.startX, e.clientY - activeDrag.startY);
    if (dist > 6) cancelLongPress();

    if (!activeDrag.isDragging && dist > 7) {
      activeDrag.isDragging = true;
      activeDrag.el.classList.add('dragging');

      const badge = document.createElement('div');
      badge.className = 'studio-drag-ghost';
      badge.innerHTML = `${activeDrag.thumbSrc ? `<img src="${activeDrag.thumbSrc}" alt="">` : '🔗'}<span>${activeDrag.label}</span>`;
      document.body.appendChild(badge);
      activeDrag.badgeEl = badge;

      activeDrag.preview3D = createPreviewGhost3D(activeDrag);
    }

    if (activeDrag.isDragging) {
      if (activeDrag.badgeEl) {
        activeDrag.badgeEl.style.left = e.clientX + 'px';
        activeDrag.badgeEl.style.top = e.clientY + 'px';
      }

      clearFolderDragHighlights();
      const underEl = document.elementFromPoint(e.clientX, e.clientY);

      if (activeDrag.kind === 'prefab') {
        const dropFolderEl = underEl && underEl.closest('.folder-item[data-custom-folder="1"]');
        if (dropFolderEl) dropFolderEl.classList.add('drag-over');
      } else if (activeDrag.kind === 'hier_item') {
        const dropScreenZone = underEl && underEl.closest('[data-screen-speaker-drop]');
        const dropHierItem = underEl && underEl.closest('.hier-item[data-hkey]');
        const dropRootZone = underEl && underEl.closest('#hierRootDropZone');
        if (dropScreenZone) {
          dropScreenZone.style.borderColor = '#00e676';
          dropScreenZone.style.background = 'rgba(0,230,118,0.18)';
        } else if (dropHierItem && dropHierItem !== activeDrag.el) {
          const rect = dropHierItem.getBoundingClientRect();
          const relY = (e.clientY - rect.top) / Math.max(1, rect.height);
          // Верхние 28% -> синяя линия СВЕРХУ (before), нижние 28% -> синяя линия СНИЗУ (after), середина -> ВЛОЖЕНИЕ В РОДИТЕЛЯ (inside)
          if (relY < 0.28) {
            activeDrag.dropMode = 'before';
            dropHierItem.classList.add('drop-before');
          } else if (relY > 0.72) {
            activeDrag.dropMode = 'after';
            dropHierItem.classList.add('drop-after');
          } else {
            activeDrag.dropMode = 'inside';
            dropHierItem.classList.add('drag-over-parent');
          }
        } else if (dropRootZone) {
          activeDrag.dropMode = 'inside';
          dropRootZone.classList.add('drag-over-parent');
        }
      }

      const overViewport = underEl === cv || Boolean(underEl && underEl.closest('#itemStudioOverlay'));

      if (activeDrag.preview3D) {
        activeDrag.preview3D.visible = overViewport;
        if (overViewport) {
          if (activeDrag.kind === 'primitive' && S.itemStudioOpen) {
            const pt = computeStudioPrimitiveDropPoint(e.clientX, e.clientY);
            activeDrag.preview3D.position.copy(pt);
          } else {
            const pt = computeWorldDropPoint(e.clientX, e.clientY);
            const yOff = activeDrag.preview3D.userData?.groundOffsetY ?? 0.5;
            activeDrag.preview3D.position.set(pt.x, pt.y + yOff, pt.z);
          }
        }
      }
    }
  });

  const finishPointerDrag = e => {
    cancelLongPress();
    if (!activeDrag) return;
    const state = activeDrag;
    const underEl = document.elementFromPoint(e.clientX, e.clientY);
    clearActiveDrag();

    if (!state.isDragging) {
      if (state.kind === 'hier_item') return;
      if (state.kind === 'primitive') {
        spawnPrimitiveInEditor(state.key, null);
      } else {
        spawnPrefabFromCard(state.key, null, true);
      }
      return;
    }

    // 1. Привязка колонки к Видео-Экрану (Drag & Drop из Иерархии в Инспектор) или перестановка в Иерархии
    if (state.kind === 'hier_item') {
      const dropScreenZone = underEl && underEl.closest('[data-screen-speaker-drop]');
      if (dropScreenZone) {
        const screenId = dropScreenZone.dataset.screenSpeakerDrop;
        if (!state.key || !state.key.startsWith('block:')) {
          sfx.oof?.();
          showBanner('⚠️ К экрану можно привязать только 3D-Колонку или блок из Иерархии!', '#ffce3a');
          return;
        }
        const speakerId = state.key.slice(6);
        const screenBox = S.allBlocks.find(b => b && b.id === screenId);
        const speakerBox = S.allBlocks.find(b => b && b.id === speakerId);
        if (!screenBox || !speakerBox) return;
        if (speakerBox === screenBox) {
          sfx.oof?.();
          showBanner('⚠️ Нельзя привязать экран к самому себе!', '#ffce3a');
          return;
        }
        pushUndoState('Привязка колонки к экрану');
        ensureBlockComponents(speakerBox);
        speakerBox.components.soundEmitter.enabled = true;
        if (!speakerBox.soundEmitterData) speakerBox.soundEmitterData = createDefaultSoundEmitterData();
        speakerBox.soundEmitterData.mode = 'screen_link';
        speakerBox.soundEmitterData.linkedScreenId = screenBox.id;
        speakerBox.soundEmitterData.playing = true;
        syncBlockComponentsState(speakerBox);
        syncBlockMediaVisuals(speakerBox);
        syncBlockMediaVisuals(screenBox);
        syncStudioMotionAndSignalHelpers();
        if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncBlockUpsert(speakerBox, false);
        }
        sfx.coil?.();
        refreshHierarchyUI();
        renderInspectorUI();
        showBanner(`🔗 Источник «${speakerBox.label}» привязан к экрану «${screenBox.label}»!`, '#00e676');
        return;
      }

      const dropHierItem = underEl && underEl.closest('.hier-item[data-hkey]');
      const dropRootZone = underEl && underEl.closest('#hierRootDropZone,.ed-sec-title');
      if (dropHierItem && dropHierItem.dataset.hkey !== state.key) {
        handleHierarchyReparentDrop(state.key, dropHierItem.dataset.hkey, state.dropMode || 'inside');
      } else if (dropRootZone) {
        handleHierarchyReparentDrop(state.key, null, 'inside');
      }
      return;
    }

    // 2. Перетаскивание карточки префаба в пользовательскую папку
    if (state.kind === 'prefab' && state.cardId) {
      const dropFolderEl = underEl && underEl.closest('.folder-item[data-custom-folder="1"]');
      if (dropFolderEl) {
        const fid = dropFolderEl.dataset.pfolder;
        const uf = S.prefabFolders.find(f => f.id === fid);
        if (uf) {
          if (!Array.isArray(uf.items)) uf.items = [];
          if (!uf.items.includes(state.cardId)) {
            uf.items.push(state.cardId);
          }
          sfx.jump();
          refreshPrefabDockUI();
          showBanner(`📂 «${state.label}» добавлен в папку «${uf.name}»!`, '#00e676');
        }
        return;
      }
    }

    // 3. Перетаскивание префаба или примитива на 3D-сцену
    const overViewport = underEl === cv || Boolean(underEl && underEl.closest('#itemStudioOverlay'));
    if (!overViewport) return;

    if (state.kind === 'primitive') {
      const dropPos = S.itemStudioOpen
        ? computeStudioPrimitiveDropPoint(e.clientX, e.clientY)
        : computeWorldDropPoint(e.clientX, e.clientY);
      spawnPrimitiveInEditor(state.key, dropPos);
    } else {
      const dropPos = computeWorldDropPoint(e.clientX, e.clientY);
      spawnPrefabFromCard(state.key, dropPos, false);
    }
  };

  document.addEventListener('pointerup', finishPointerDrag);
  document.addEventListener('pointercancel', clearActiveDrag);

  // ПКМ по карточке префаба в нижней панели (#studioBottomDock) -> «Загрузить в библиотеку» / «Удалить»
  const prefabGridEl = $('prefabGridContainer');
  if (prefabGridEl) {
    prefabGridEl.addEventListener('contextmenu', e => {
      if (S.state !== 'edit') return;
      const cardEl = e.target.closest('.spawn-card[data-spawn]');
      if (!cardEl) return;
      e.preventDefault();
      e.stopPropagation();
      openPrefabDockContextMenu(e.clientX, e.clientY, cardEl.dataset.cardId, cardEl.dataset.spawn);
    });
  }
}
