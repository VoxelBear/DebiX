// src/studio/StudioController.js
import { S, $, coarse, showBanner } from '../core/State.js';
import { cv, scene, camera } from '../core/SceneManager.js';
import { initAudio, sfx } from '../core/AudioEngine.js';
import {
  MAX_COSMETIC_PARTS,
  MAX_ITEM_PARTS,
  normalizeCosmeticItem,
  normalizeItemData,
  normalizeCharacterGripPoints,
  buildItemGroup,
  createRobloxRig,
  createStarterItemTemplate
} from '../core/CharacterRig.js';
import { addSceneBlock, rebuildPhysicsArrays } from '../core/WorldRegistry.js';
import {
  spawnCustomNPC,
  attachRigToEntity,
  updateShopUI,
  spawnWorldItem,
  rebuildWorldItemVisual
} from '../core/EntityManager.js';
import { serializeSceneState, loadSceneState } from '../core/Serializer.js';
import { completePlayerRespawn } from '../player/PhysicsAndCombat.js';
import { refreshHierarchyUI } from './HierarchyAndSpawn.js';
import { renderInspectorUI, syncInspectorInputsFromObject, syncLibraryItemIfEditing } from './InspectorPanel.js';
import { isPaintModalOpen, undoPaintAction } from './PaintStudio2D.js';

export const tControls = new THREE.TransformControls(camera, cv);
tControls.setSize(0.9);
scene.add(tControls);

export const raycaster = new THREE.Raycaster();
export const mouseNDC = new THREE.Vector2();

export const selBoxHelper = new THREE.BoxHelper(new THREE.Mesh(), 0x00f2fe);
selBoxHelper.visible = false;
scene.add(selBoxHelper);

const MAX_UNDO_STEPS = 25;

// Отдельные изолированные стеки отмены для конструктора аксессуаров и конструктора предметов
const cosmeticUndoStack = [];
const itemUndoStack = [];

// Изолированная 3D-Студия предметов и аксессуаров (на манер 2D STUDIO)
export const ITEM_STUDIO_ORIGIN = new THREE.Vector3(0, 650, 0);
let itemStudioStageGroup = null;
let studioMannequinRig = null;
let savedMapCamera = null;
let activeStudioWorldEntry = null;
let activeStudioCharEnt = null;

function ensureItemStudioStage() {
  if (itemStudioStageGroup) return itemStudioStageGroup;

  itemStudioStageGroup = new THREE.Group();
  itemStudioStageGroup.position.copy(ITEM_STUDIO_ORIGIN);
  itemStudioStageGroup.visible = false;

  // 1. Изолированный купол 3D-мастерской (отсекает основной мир от камеры)
  const domeGeo = new THREE.SphereGeometry(42, 28, 20);
  const domeMat = new THREE.MeshBasicMaterial({
    color: 0x0b0f19,
    side: THREE.BackSide
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.userData.noCollider = true;
  itemStudioStageGroup.add(dome);

  // 2. Подиум-пьедестал с неоновым ободом и координатной сеткой
  const pedGeo = new THREE.CylinderGeometry(3.5, 3.9, 0.36, 40);
  const pedMat = new THREE.MeshStandardMaterial({
    color: 0x151b29,
    roughness: 0.45,
    metalness: 0.25
  });
  const pedestal = new THREE.Mesh(pedGeo, pedMat);
  pedestal.position.set(0, -0.18, 0);
  pedestal.receiveShadow = true;
  pedestal.userData.noCollider = true;
  itemStudioStageGroup.add(pedestal);

  const rimGeo = new THREE.TorusGeometry(3.52, 0.045, 12, 48);
  const rimMat = new THREE.MeshBasicMaterial({ color: 0x00a2ff });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0, 0.01, 0);
  rim.userData.noCollider = true;
  itemStudioStageGroup.add(rim);

  const grid = new THREE.GridHelper(6.6, 16, 0x00a2ff, 0x26334d);
  grid.position.set(0, 0.015, 0);
  grid.userData.noCollider = true;
  itemStudioStageGroup.add(grid);

  // 3. Собственное студийное освещение внутри 3D-мастерской
  const keyLight = new THREE.PointLight(0xffffff, 1.35, 34);
  keyLight.position.set(4.5, 6.5, 5.5);
  itemStudioStageGroup.add(keyLight);

  const fillLight = new THREE.PointLight(0x70cfff, 0.85, 30);
  fillLight.position.set(-4.5, 4.0, -4.5);
  itemStudioStageGroup.add(fillLight);

  // 4. Манекен R6 для наглядной примерки оружия (1 и 2 руки) на пьедестале
  studioMannequinRig = createRobloxRig(
    {
      head: 0x94a3b8,
      torso: 0x334155,
      armL: 0x94a3b8,
      armR: 0x94a3b8,
      legL: 0x1e293b,
      legR: 0x1e293b
    },
    1.0,
    false
  );
  studioMannequinRig.g.position.set(-1.95, 0.02, 0);
  studioMannequinRig.g.rotation.y = 0.25;
  studioMannequinRig.g.traverse(o => {
    o.userData.noCollider = true;
  });
  itemStudioStageGroup.add(studioMannequinRig.g);

  scene.add(itemStudioStageGroup);
  return itemStudioStageGroup;
}

function setCharacterBodyMeshesVisible(rig, visible) {
  if (!rig) return;
  const limbs = [rig.head, rig.torso, rig.armL, rig.armR, rig.legL, rig.legR];
  for (const limb of limbs) {
    if (!limb) continue;
    for (const ch of limb.children) {
      // Оставляем сокеты аксессуаров видимыми, скрывая только саму геометрию тела
      if (ch.isMesh && !ch.userData?.cosmeticItem) {
        ch.visible = visible;
      }
    }
  }
}

export function syncItemStudioPreview() {
  if (!S.itemStudioOpen) return;
  ensureItemStudioStage();
  const showMannequin = S.itemStudioShowMannequin !== false;
  const btnMan = $('btnISMannequin');
  if (btnMan) {
    btnMan.textContent = showMannequin ? '🧍 Манекен: 🟢' : '🧍 Манекен: 🔴';
    btnMan.classList.toggle('active', showMannequin);
  }

  if (S.workbenchPreviewGroup && S.workbenchPreviewGroup.parent) {
    S.workbenchPreviewGroup.parent.remove(S.workbenchPreviewGroup);
  }
  S.workbenchPreviewGroup = null;

  const ref = S.selectedRef;
  if (!ref) return;

  if (ref.kind === 'world_item' && ref.worldEntry) {
    const wi = ref.worldEntry;
    const item = normalizeItemData(wi.item);
    activeStudioWorldEntry = wi;

    // Центрируем редактируемый предмет на пьедестале 3D STUDIO (не меняя его мировые координаты wi.x/y/z!)
    if (wi.group) {
      wi.group.position.set(ITEM_STUDIO_ORIGIN.x, ITEM_STUDIO_ORIGIN.y + 1.25, ITEM_STUDIO_ORIGIN.z);
      wi.group.rotation.set(0, 0, 0);
      wi.group.updateMatrixWorld(true);
    }
    if (wi.tag) wi.tag.visible = false;

    if ($('itemStudioSubjectTitle')) {
      $('itemStudioSubjectTitle').textContent = `${item.icon || '🗡️'} ${item.name} — 3D STUDIO`;
    }
    if ($('btnISPlaceInWorld')) {
      $('btnISPlaceInWorld').hidden = false;
    }

    // Показываем манекен рядом с предметом с живым превью хвата в руке / 2 руках
    if (studioMannequinRig) {
      studioMannequinRig.g.visible = showMannequin;
      if (showMannequin) {
        const previewMesh = buildItemGroup(item, {
          isProjectile: false,
          showMarkers: false,
          applyGripOffset: true
        });
        if (item.holdMode === 'carried') {
          studioMannequinRig.armL.rotation.set(-1.35, -0.28, 0.08);
          studioMannequinRig.armR.rotation.set(-1.35, 0.28, -0.08);
          studioMannequinRig.carrySocket.add(previewMesh);
        } else {
          studioMannequinRig.armL.rotation.set(0, 0, 0);
          studioMannequinRig.armR.rotation.set(-Math.PI / 2, 0, 0);
          studioMannequinRig.handSocketR.add(previewMesh);
        }
        studioMannequinRig.g.updateMatrixWorld(true);
        S.workbenchPreviewGroup = previewMesh;
      }
    }
  } else if (ref.kind === 'cosmetic' && ref.ent && ref.item) {
    const { ent, item } = ref;
    activeStudioCharEnt = ent;
    if (studioMannequinRig) studioMannequinRig.g.visible = false;
    if ($('btnISPlaceInWorld')) $('btnISPlaceInWorld').hidden = true;
    if ($('itemStudioSubjectTitle')) {
      const ico = item.parentSlot === 'pet' ? '🐾' : '🎩';
      $('itemStudioSubjectTitle').textContent = `${ico} ${item.name} (${ent.name}) — 3D STUDIO`;
    }

    if (ent.rig && ent.rig.g) {
      ent.rig.g.position.set(ITEM_STUDIO_ORIGIN.x, ITEM_STUDIO_ORIGIN.y + 0.02, ITEM_STUDIO_ORIGIN.z);
      ent.rig.g.rotation.set(0, 0, 0);
      setCharacterBodyMeshesVisible(ent.rig, showMannequin);
      if (ent.tag) ent.tag.visible = false;

      // Если редактируем питомца и манекен выключен — ставим питомца прямо в центр пьедестала
      if (item.parentSlot === 'pet' && ref.group) {
        const sc = Math.max(0.1, ent.rig.g.scale.x || 1);
        if (showMannequin) {
          const dist = Math.max(0.8, Number(item.petDistance) ?? 2.2);
          const height = Number(item.petHeight) ?? 1.5;
          ref.group.position.set(dist / sc, height / sc, 0);
        } else {
          ref.group.position.set(0, 1.25 / sc, 0);
        }
        ref.group.rotation.set(0, 0, 0);
      }
      ent.rig.g.updateMatrixWorld(true);
    }
  }
}

export function setItemStudioCameraPreset(preset = 'iso') {
  ensureItemStudioStage();
  let focusTarget = new THREE.Vector3(ITEM_STUDIO_ORIGIN.x, ITEM_STUDIO_ORIGIN.y + 1.35, ITEM_STUDIO_ORIGIN.z);

  if (S.selectedRef && S.selectedRef.kind === 'cosmetic' && S.selectedRef.group) {
    S.selectedRef.group.updateMatrixWorld(true);
    S.selectedRef.group.getWorldPosition(focusTarget);
  }

  if (preset === 'front') {
    S.edYaw = 0;
    S.edPitch = -0.12;
    S.edCamPos.set(focusTarget.x, focusTarget.y + 0.35, focusTarget.z + 3.2);
  } else if (preset === 'side') {
    S.edYaw = Math.PI / 2;
    S.edPitch = -0.12;
    S.edCamPos.set(focusTarget.x + 3.2, focusTarget.y + 0.35, focusTarget.z);
  } else {
    S.edYaw = 0.48;
    S.edPitch = -0.26;
    const dist = 3.4;
    const fwd = new THREE.Vector3(
      -Math.sin(S.edYaw) * Math.cos(S.edPitch),
      Math.sin(S.edPitch),
      -Math.cos(S.edYaw) * Math.cos(S.edPitch)
    );
    S.edCamPos.copy(focusTarget).addScaledVector(fwd, -dist);
  }
}

export function restoreItemStudioSubjectsToWorld() {
  if (S.workbenchPreviewGroup && S.workbenchPreviewGroup.parent) {
    S.workbenchPreviewGroup.parent.remove(S.workbenchPreviewGroup);
  }
  S.workbenchPreviewGroup = null;

  if (activeStudioWorldEntry) {
    const wi = activeStudioWorldEntry;
    activeStudioWorldEntry = null;
    if (S.worldItems.includes(wi)) {
      if (wi.tag) wi.tag.visible = true;
      rebuildWorldItemVisual(wi, false);
    }
  }

  if (activeStudioCharEnt) {
    const ent = activeStudioCharEnt;
    activeStudioCharEnt = null;
    if (ent.rig) {
      setCharacterBodyMeshesVisible(ent.rig, true);
      if (ent.tag) ent.tag.visible = true;
      attachRigToEntity(ent);
    }
  }
}

export function openItemStudio3D(ref = S.selectedRef) {
  ensureItemStudioStage();
  if (S.itemStudioShowMannequin === undefined) {
    S.itemStudioShowMannequin = true;
  }

  const wasOpen = !!S.itemStudioOpen;
  if (!wasOpen) {
    savedMapCamera = {
      pos: S.edCamPos.clone(),
      yaw: S.edYaw,
      pitch: S.edPitch
    };
  }

  // Если меняем редактируемый объект внутри студии — возвращаем предыдущий на карту
  if (activeStudioWorldEntry && (!ref || ref.worldEntry !== activeStudioWorldEntry)) {
    restoreItemStudioSubjectsToWorld();
  }
  if (activeStudioCharEnt && (!ref || ref.ent !== activeStudioCharEnt)) {
    restoreItemStudioSubjectsToWorld();
  }

  S.itemStudioOpen = true;
  itemStudioStageGroup.visible = true;
  if ($('itemStudioOverlay')) $('itemStudioOverlay').hidden = false;
  if ($('openItemStudioBtn')) $('openItemStudioBtn').classList.add('active');

  syncItemStudioPreview();
  if (!wasOpen) {
    setItemStudioCameraPreset('iso');
  }
}

export function closeItemStudio3D(switchToMapPlacement = false) {
  if (!S.itemStudioOpen) return;
  const prevRef = S.selectedRef;

  S.itemStudioOpen = false;
  if (itemStudioStageGroup) itemStudioStageGroup.visible = false;
  if ($('itemStudioOverlay')) $('itemStudioOverlay').hidden = true;
  if ($('openItemStudioBtn')) $('openItemStudioBtn').classList.remove('active');

  restoreItemStudioSubjectsToWorld();

  if (savedMapCamera) {
    S.edCamPos.copy(savedMapCamera.pos);
    S.edYaw = savedMapCamera.yaw;
    S.edPitch = savedMapCamera.pitch;
    savedMapCamera = null;
  }

  if (switchToMapPlacement && prevRef && prevRef.kind === 'world_item' && prevRef.worldEntry) {
    selectEditorObject({
      kind: 'world_item',
      worldEntry: prevRef.worldEntry,
      item: prevRef.worldEntry.item,
      editMode: 'root',
      partIdx: 0,
      libIdx: prevRef.libIdx,
      inWorldPlacement: true
    });
    focusOnSelected();
    showBanner('📍 Режим размещения на карте: двигай предмет в мире стрелками Гизмо!', '#00e676');
    return;
  }

  if (prevRef && prevRef.kind === 'cosmetic' && prevRef.ent) {
    selectEditorObject({ kind: 'char', ent: prevRef.ent });
  } else if (prevRef && prevRef.kind === 'world_item' && prevRef.worldEntry) {
    selectEditorObject({
      kind: 'world_item',
      worldEntry: prevRef.worldEntry,
      item: prevRef.worldEntry.item,
      editMode: 'root',
      partIdx: 0,
      libIdx: prevRef.libIdx,
      inWorldPlacement: true
    });
  } else {
    selectEditorObject(null);
  }
}

export function clearCosmeticUndoStack() {
  cosmeticUndoStack.length = 0;
}

export function clearItemUndoStack() {
  itemUndoStack.length = 0;
}

export function pushCosmeticUndoState(actionLabel = 'Изменение аксессуара') {
  if (!S.selectedRef || S.selectedRef.kind !== 'cosmetic') return;
  const { ent, item, partIdx, libIdx } = S.selectedRef;
  if (!ent || !item) return;
  try {
    cosmeticUndoStack.push({
      label: actionLabel,
      ent,
      itemId: item.id,
      partIdx: partIdx || 0,
      libIdx: libIdx !== undefined ? libIdx : undefined,
      itemSnapshot: JSON.parse(JSON.stringify(item))
    });
    if (cosmeticUndoStack.length > MAX_UNDO_STEPS) {
      cosmeticUndoStack.shift();
    }
  } catch (e) {
    console.warn('Cosmetic undo snapshot failed:', e);
  }
}

export function undoLastCosmeticAction() {
  if (cosmeticUndoStack.length === 0) {
    showBanner('↩️ В конструкторе аксессуара нет действий для отмены', '#ffce3a');
    return false;
  }
  const prev = cosmeticUndoStack.pop();
  const { ent, itemId, partIdx, libIdx, itemSnapshot } = prev;
  if (!ent || !ent.preset || !Array.isArray(ent.preset.customCosmetics)) return false;

  const idx = ent.preset.customCosmetics.findIndex(c => c.id === itemId);
  const restored = normalizeCosmeticItem(JSON.parse(JSON.stringify(itemSnapshot)));
  if (idx >= 0) {
    ent.preset.customCosmetics[idx] = restored;
  } else {
    ent.preset.customCosmetics.push(restored);
  }

  if (libIdx !== undefined && S.savedCosmeticsLibrary[libIdx]) {
    S.savedCosmeticsLibrary[libIdx] = JSON.parse(JSON.stringify(restored));
  }

  ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
  attachRigToEntity(ent);
  const newGroup = ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === restored);
  selectEditorObject(
    {
      kind: 'cosmetic',
      ent,
      item: restored,
      group: newGroup,
      partIdx: Math.min(partIdx, restored.parts.length - 1),
      libIdx
    },
    true
  );
  sfx.jump();
  showBanner(`↩️ Аксессуар: отменено «${prev.label}» (осталось: ${cosmeticUndoStack.length})`, '#56f0ff');
  return true;
}

export function pushItemUndoState(actionLabel = 'Изменение предмета') {
  if (!S.selectedRef || S.selectedRef.kind !== 'world_item') return;
  const { worldEntry, editMode, partIdx, libIdx } = S.selectedRef;
  if (!worldEntry || !worldEntry.item) return;
  try {
    itemUndoStack.push({
      label: actionLabel,
      worldEntry,
      editMode: editMode || 'part',
      partIdx: partIdx || 0,
      libIdx,
      x: worldEntry.x,
      y: worldEntry.y,
      z: worldEntry.z,
      rotY: worldEntry.rotY || 0,
      itemSnapshot: JSON.parse(JSON.stringify(worldEntry.item))
    });
    if (itemUndoStack.length > MAX_UNDO_STEPS) {
      itemUndoStack.shift();
    }
  } catch (e) {
    console.warn('Item undo snapshot failed:', e);
  }
}

export function undoLastItemAction() {
  if (itemUndoStack.length === 0) {
    showBanner('↩️ В конструкторе предмета нет действий для отмены', '#ffce3a');
    return false;
  }
  const prev = itemUndoStack.pop();
  const { worldEntry, editMode, partIdx, libIdx, x, y, z, rotY, itemSnapshot } = prev;
  if (!worldEntry || !S.worldItems.includes(worldEntry)) return false;

  worldEntry.x = x;
  worldEntry.y = y;
  worldEntry.z = z;
  worldEntry.rotY = rotY;
  worldEntry.item = normalizeItemData(JSON.parse(JSON.stringify(itemSnapshot)));

  if (libIdx !== undefined && S.savedItemsLibrary[libIdx]) {
    S.savedItemsLibrary[libIdx] = JSON.parse(JSON.stringify(worldEntry.item));
  }

  rebuildWorldItemVisual(worldEntry, true);
  selectEditorObject(
    {
      kind: 'world_item',
      worldEntry,
      item: worldEntry.item,
      editMode,
      partIdx,
      libIdx
    },
    true
  );
  sfx.jump();
  showBanner(`↩️ Предмет: отменено «${prev.label}» (осталось: ${itemUndoStack.length})`, '#56f0ff');
  return true;
}

export function pushUndoState(actionLabel = 'Действие') {
  if (S.selectedRef && S.selectedRef.kind === 'cosmetic') {
    pushCosmeticUndoState(actionLabel);
    return;
  }
  if (S.selectedRef && S.selectedRef.kind === 'world_item' && (S.itemStudioOpen || S.selectedRef.editMode !== 'root')) {
    pushItemUndoState(actionLabel);
    return;
  }
  try {
    const snap = JSON.parse(JSON.stringify(serializeSceneState()));
    let selKey = null;
    if (S.selectedRef) {
      if (S.selectedRef.kind === 'block' && S.selectedRef.box) {
        selKey = { kind: 'block', id: S.selectedRef.box.id };
      } else if (S.selectedRef.kind === 'char' && S.selectedRef.ent) {
        selKey = {
          kind: 'char',
          isP: !!S.selectedRef.ent.isP,
          name: S.selectedRef.ent.name
        };
      } else if (S.selectedRef.kind === 'world_item' && S.selectedRef.worldEntry) {
        selKey = { kind: 'world_item', id: S.selectedRef.worldEntry.id };
      }
    }
    S.undoStack.push({ label: actionLabel, data: snap, selKey });
    if (S.undoStack.length > MAX_UNDO_STEPS) {
      S.undoStack.shift();
    }
  } catch (e) {
    console.warn('Undo snapshot failed:', e);
  }
}

export function undoLastStudioAction() {
  if (isPaintModalOpen()) {
    undoPaintAction();
    return;
  }

  if (S.selectedRef && S.selectedRef.kind === 'cosmetic') {
    undoLastCosmeticAction();
    return;
  }

  if (S.selectedRef && S.selectedRef.kind === 'world_item' && itemUndoStack.length > 0) {
    undoLastItemAction();
    return;
  }

  if (!S.undoStack || S.undoStack.length === 0) {
    showBanner('↩️ История действий мира пуста (нечего отменять)', '#ffce3a');
    return;
  }

  if (S.itemStudioOpen) {
    closeItemStudio3D(false);
  }

  const prev = S.undoStack.pop();
  tControls.detach();
  selBoxHelper.visible = false;
  S.selectedRef = null;

  loadSceneState(prev.data, { isUndo: true });

  let restoredRef = null;
  if (prev.selKey) {
    if (prev.selKey.kind === 'block') {
      const foundBox = S.allBlocks.find(b => b.id === prev.selKey.id);
      if (foundBox) restoredRef = { kind: 'block', box: foundBox };
    } else if (prev.selKey.kind === 'world_item') {
      const foundWi = S.worldItems.find(w => w.id === prev.selKey.id);
      if (foundWi) {
        restoredRef = {
          kind: 'world_item',
          worldEntry: foundWi,
          item: foundWi.item,
          editMode: 'root',
          partIdx: 0,
          inWorldPlacement: true
        };
      }
    } else if (prev.selKey.kind === 'char') {
      if (prev.selKey.isP && S.player) {
        restoredRef = { kind: 'char', ent: S.player };
      } else {
        const foundNpc = S.customNPCs.find(n => n.name === prev.selKey.name);
        if (foundNpc) restoredRef = { kind: 'char', ent: foundNpc };
      }
    }
  }

  selectEditorObject(restoredRef);
  sfx.jump();
  showBanner(`↩️ Отменено: ${prev.label} (осталось шагов: ${S.undoStack.length})`, '#56f0ff');
}

export function initStudioController() {
  const brandEl = document.querySelector('.ed-brand');
  if (brandEl) {
    brandEl.innerHTML = '<span>DEBIX STUDIO 3D</span> РЕДАКТОР ИГРЫ';
  }

  const helpBar = document.querySelector('.ed-helpbar');
  if (helpBar) {
    helpBar.innerHTML =
      '<b>ЛКМ</b> — выбрать · <b>СКМ (Зажать)</b> — панорама · <b>ПКМ + WASD/QE</b> — полёт · <b>W/E/R</b> — Гизмо · <b>Ctrl+Z</b> — Отмена';
  }

  const undoBtn = $('undoObjBtn');
  if (undoBtn) {
    undoBtn.onclick = undoLastStudioAction;
  }

  if ($('btnSnapToggle')) {
    $('btnSnapToggle').textContent = S.snapEnabled ? '🧲 Сетка: 🟢' : '🧲 Сетка: 🔴';
  }
  if ($('btnColliderVis')) {
    $('btnColliderVis').textContent = S.showColliders ? '🔲 Коллайдеры: 🟢' : '🔲 Коллайдеры: 🔴';
  }

  // Кнопки управления изолированной 3D STUDIO предметов и аксессуаров
  if ($('openItemStudioBtn')) {
    $('openItemStudioBtn').onclick = () => {
      if (S.itemStudioOpen) {
        closeItemStudio3D(false);
        return;
      }
      if (S.selectedRef && (S.selectedRef.kind === 'world_item' || S.selectedRef.kind === 'cosmetic')) {
        S.selectedRef.inWorldPlacement = false;
        if (S.selectedRef.kind === 'world_item' && S.selectedRef.editMode === 'root') {
          S.selectedRef.editMode = 'part';
        }
        selectEditorObject(S.selectedRef, true);
        return;
      }
      if (S.worldItems.length > 0) {
        const lastWi = S.worldItems[S.worldItems.length - 1];
        selectEditorObject({
          kind: 'world_item',
          worldEntry: lastWi,
          item: lastWi.item,
          editMode: 'part',
          partIdx: 0
        });
        return;
      }
      // Если в сцене ещё нет предметов — создаём стартовый меч и сразу открываем в 3D STUDIO
      const itemData = createStarterItemTemplate('sword');
      const px = S.player ? S.player.x + 2.2 : 0;
      const py = S.player ? S.player.y + 0.6 : 1.5;
      const pz = S.player ? S.player.z : 0;
      const wi = spawnWorldItem(itemData, px, py, pz);
      selectEditorObject({
        kind: 'world_item',
        worldEntry: wi,
        item: wi.item,
        editMode: 'part',
        partIdx: 0
      });
    };
  }

  if ($('btnISCamFront')) $('btnISCamFront').onclick = () => setItemStudioCameraPreset('front');
  if ($('btnISCamSide')) $('btnISCamSide').onclick = () => setItemStudioCameraPreset('side');
  if ($('btnISCamIso')) $('btnISCamIso').onclick = () => setItemStudioCameraPreset('iso');
  if ($('btnISMannequin')) {
    $('btnISMannequin').onclick = () => {
      S.itemStudioShowMannequin = S.itemStudioShowMannequin === false;
      syncItemStudioPreview();
      if (S.selectedRef && S.selectedRef.mesh) {
        selBoxHelper.setFromObject(S.selectedRef.mesh);
      }
    };
  }
  if ($('btnISPlaceInWorld')) {
    $('btnISPlaceInWorld').onclick = () => closeItemStudio3D(true);
  }
  if ($('btnCloseItemStudio')) {
    $('btnCloseItemStudio').onclick = () => closeItemStudio3D(false);
  }

  tControls.addEventListener('dragging-changed', e => {
    if (e.value) {
      if (S.selectedRef && S.selectedRef.kind === 'world_item') {
        pushItemUndoState('Трансформация предмета');
      } else {
        pushUndoState('Трансформация объекта');
      }
    } else {
      rebuildPhysicsArrays();
    }
  });

  tControls.addEventListener('change', () => {
    if (!S.selectedRef) return;
    if (S.selectedRef.kind === 'block') {
      const box = S.selectedRef.box;
      box.m.updateMatrixWorld(true);
      rebuildPhysicsArrays();
      selBoxHelper.setFromObject(box.m);
      syncInspectorInputsFromObject();
    } else if (S.selectedRef.kind === 'char') {
      const ent = S.selectedRef.ent;
      const editMode = S.selectedRef.editMode || 'root';
      normalizeCharacterGripPoints(ent.preset);

      if (editMode === 'hand_grip' && ent.rig.handGripMarker) {
        const m = ent.rig.handGripMarker;
        ent.preset.handGripPoint.x = m.position.x;
        ent.preset.handGripPoint.y = m.position.y;
        ent.preset.handGripPoint.z = m.position.z;
        ent.preset.handGripPoint.rx = m.rotation.x;
        ent.preset.handGripPoint.ry = m.rotation.y;
        ent.preset.handGripPoint.rz = m.rotation.z;
        if (ent.rig.syncGripSockets) ent.rig.syncGripSockets(ent.preset);
        m.updateMatrixWorld(true);
        selBoxHelper.visible = false;
        syncInspectorInputsFromObject();
      } else if (editMode === 'carry_grip' && ent.rig.carryGripMarker) {
        const m = ent.rig.carryGripMarker;
        ent.preset.carryGripPoint.x = m.position.x;
        ent.preset.carryGripPoint.y = m.position.y;
        ent.preset.carryGripPoint.z = m.position.z;
        ent.preset.carryGripPoint.rx = m.rotation.x;
        ent.preset.carryGripPoint.ry = m.rotation.y;
        ent.preset.carryGripPoint.rz = m.rotation.z;
        if (ent.rig.syncGripSockets) ent.rig.syncGripSockets(ent.preset);
        m.updateMatrixWorld(true);
        selBoxHelper.visible = false;
        syncInspectorInputsFromObject();
      } else {
        ent.x = ent.rig.g.position.x;
        ent.y = ent.rig.g.position.y;
        ent.z = ent.rig.g.position.z;
        ent.rot = ent.rig.g.rotation.y;
        if (ent.isCustomNPC) {
          ent.homeX = ent.x;
          ent.homeZ = ent.z;
        }
        ent.tag.position.set(ent.x, ent.y + (ent.isArchangel ? 4.5 : 3.35), ent.z);
        ent.rig.g.updateMatrixWorld(true);
        selBoxHelper.setFromObject(ent.rig.g);
        if (S.showColliders) rebuildPhysicsArrays();
        syncInspectorInputsFromObject();
      }
    } else if (S.selectedRef.kind === 'cosmetic') {
      const { mesh, part } = S.selectedRef;
      if (mesh && part) {
        part.x = mesh.position.x;
        part.y = mesh.position.y;
        part.z = mesh.position.z;
        part.rx = mesh.rotation.x;
        part.ry = mesh.rotation.y;
        part.rz = mesh.rotation.z;
        part.sx = mesh.scale.x;
        part.sy = mesh.scale.y;
        part.sz = mesh.scale.z;
        mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(mesh);
        syncInspectorInputsFromObject();
        syncLibraryItemIfEditing(S.selectedRef);
      }
    } else if (S.selectedRef.kind === 'world_item') {
      const { worldEntry, item, editMode, mesh, part } = S.selectedRef;
      if (!worldEntry || !item) return;

      if ((!editMode || editMode === 'root') && !S.itemStudioOpen) {
        worldEntry.x = worldEntry.group.position.x;
        worldEntry.y = worldEntry.group.position.y;
        worldEntry.z = worldEntry.group.position.z;
        worldEntry.rotY = worldEntry.group.rotation.y;
        if (worldEntry.tag) {
          worldEntry.tag.position.set(worldEntry.x, worldEntry.y + 1.65, worldEntry.z);
        }
        worldEntry.group.updateMatrixWorld(true);
        selBoxHelper.setFromObject(worldEntry.group);
      } else if ((editMode === 'part' || editMode === 'proj_part') && mesh && part) {
        part.x = mesh.position.x;
        part.y = mesh.position.y;
        part.z = mesh.position.z;
        part.rx = mesh.rotation.x;
        part.ry = mesh.rotation.y;
        part.rz = mesh.rotation.z;
        part.sx = mesh.scale.x;
        part.sy = mesh.scale.y;
        part.sz = mesh.scale.z;
        mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(mesh);
        if (S.itemStudioOpen) syncItemStudioPreview();
      } else if (editMode === 'grip' && mesh) {
        item.gripPoint.x = -mesh.position.x;
        item.gripPoint.y = -mesh.position.y;
        item.gripPoint.z = -mesh.position.z;
        item.gripPoint.rx = mesh.rotation.x;
        item.gripPoint.ry = mesh.rotation.y;
        item.gripPoint.rz = mesh.rotation.z;
        mesh.updateMatrixWorld(true);
        selBoxHelper.visible = false;
        if (S.itemStudioOpen) syncItemStudioPreview();
      } else if (editMode === 'muzzle' && mesh) {
        item.muzzlePoint.x = mesh.position.x;
        item.muzzlePoint.y = mesh.position.y;
        item.muzzlePoint.z = mesh.position.z;
        mesh.updateMatrixWorld(true);
        selBoxHelper.visible = false;
      }

      syncInspectorInputsFromObject();
      syncLibraryItemIfEditing(S.selectedRef);
    }
  });

  $('openStudioBtn').addEventListener('click', () => toggleStudioMode('edit'));
  $('startEditorBtn')?.addEventListener('click', () => {
    initAudio();
    toggleStudioMode('edit');
  });
  $('openWorldSettingsBtn').addEventListener('click', () => selectEditorObject(null));

  $('gizmoMove').onclick = () => setGizmoMode('translate');
  $('gizmoRot').onclick = () => setGizmoMode('rotate');
  $('gizmoScale').onclick = () => setGizmoMode('scale');

  $('btnSnapToggle').onclick = () => {
    S.snapEnabled = !S.snapEnabled;
    tControls.setTranslationSnap(S.snapEnabled ? 0.5 : null);
    tControls.setRotationSnap(S.snapEnabled ? THREE.MathUtils.degToRad(15) : null);
    tControls.setScaleSnap(S.snapEnabled ? 0.25 : null);
    $('btnSnapToggle').textContent = S.snapEnabled ? '🧲 Сетка: 🟢' : '🧲 Сетка: 🔴';
    $('btnSnapToggle').classList.toggle('active', S.snapEnabled);
  };

  $('btnColliderVis').onclick = () => {
    S.showColliders = !S.showColliders;
    $('btnColliderVis').textContent = S.showColliders ? '🔲 Коллайдеры: 🟢' : '🔲 Коллайдеры: 🔴';
    $('btnColliderVis').classList.toggle('active', S.showColliders);
    rebuildPhysicsArrays();
  };

  $('dupObjBtn').onclick = duplicateSelected;
  $('delObjBtn').onclick = deleteSelected;
}

function hideAllCharacterGripMarkers() {
  if (S.player?.rig?.setGripMarkersVisible) S.player.rig.setGripMarkersVisible(false);
  for (const n of S.customNPCs) {
    if (n.rig?.setGripMarkersVisible) n.rig.setGripMarkersVisible(false);
  }
  for (const q of S.queueLine) {
    if (q.rig?.setGripMarkersVisible) q.rig.setGripMarkersVisible(false);
  }
  if (S.archangelEnt?.rig?.setGripMarkersVisible) {
    S.archangelEnt.rig.setGripMarkersVisible(false);
  }
}

export function toggleStudioMode(forceState) {
  const target = forceState || (S.state === 'edit' ? 'play' : 'edit');
  if (target === 'edit') {
    if (S.playerDead) completePlayerRespawn(false);
    S.state = 'edit';
    S.isReloadingHold = false;
    S.reloadHoldT = 0;
    try {
      if (document.pointerLockElement === cv) document.exitPointerLock();
    } catch (_) {}
    $('menu').hidden = true;
    $('topbar').hidden = true;
    $('shopPanel').hidden = true;
    $('hotbar').hidden = true;
    $('hint').hidden = true;
    $('touch').hidden = true;
    if ($('deathOverlay')) $('deathOverlay').hidden = true;
    if ($('throwChargeHUD')) $('throwChargeHUD').hidden = true;
    if ($('reloadHoldHUD')) $('reloadHoldHUD').hidden = true;
    if ($('crosshairHUD')) $('crosshairHUD').hidden = true;
    $('studioUI').hidden = false;

    for (const wi of S.worldItems) {
      const isSelWi = S.selectedRef && S.selectedRef.kind === 'world_item' && S.selectedRef.worldEntry === wi;
      rebuildWorldItemVisual(wi, !!isSelWi);
    }

    if (S.selectedRef && S.selectedRef.kind === 'char' && S.selectedRef.ent?.rig?.setGripMarkersVisible) {
      S.selectedRef.ent.rig.setGripMarkersVisible(true);
    }

    if (S.player && !S.itemStudioOpen) {
      S.edCamPos.set(S.player.x + 8, S.player.y + 7, S.player.z + 12);
      S.edYaw = 0.55;
      S.edPitch = -0.35;
    }
    refreshHierarchyUI();
    renderInspectorUI();
    showBanner('🛠️ DebiX Studio 3D! СКМ — панорама, ПКМ+WASD — полёт, Ctrl+Z — контекстная отмена.', '#56f0ff');
  } else {
    if (S.itemStudioOpen) {
      closeItemStudio3D(false);
    }
    hideAllCharacterGripMarkers();
    for (const wi of S.worldItems) {
      rebuildWorldItemVisual(wi, false);
    }
    rebuildPhysicsArrays();
    tControls.detach();
    selBoxHelper.visible = false;
    S.state = 'play';
    $('studioUI').hidden = true;
    $('paintModal').hidden = true;
    $('topbar').hidden = false;
    $('hotbar').hidden = false;
    if (coarse) $('touch').hidden = false;
    if (S.gameMode && S.gameMode.onEnterPlay) {
      S.gameMode.onEnterPlay();
    }
    updateShopUI();
  }
}

export function setGizmoMode(mode) {
  tControls.setMode(mode);
  $('gizmoMove').classList.toggle('active', mode === 'translate');
  $('gizmoRot').classList.toggle('active', mode === 'rotate');
  $('gizmoScale').classList.toggle('active', mode === 'scale');
}

export function selectEditorObject(ref, keepUndoStack = false) {
  const prevCos = S.selectedRef && S.selectedRef.kind === 'cosmetic' ? S.selectedRef.item : null;
  const nextCos = ref && ref.kind === 'cosmetic' ? ref.item : null;
  if (!keepUndoStack && (!nextCos || (prevCos && prevCos.id !== nextCos.id))) {
    clearCosmeticUndoStack();
  }

  const prevItem = S.selectedRef && S.selectedRef.kind === 'world_item' ? S.selectedRef.item : null;
  const nextItem = ref && ref.kind === 'world_item' ? ref.item : null;
  if (!keepUndoStack && (!nextItem || (prevItem && prevItem.id !== nextItem.id))) {
    clearItemUndoStack();
  }

  const prevWiEntry = S.selectedRef && S.selectedRef.kind === 'world_item' ? S.selectedRef.worldEntry : null;
  const nextWiEntry = ref && ref.kind === 'world_item' ? ref.worldEntry : null;
  if (prevWiEntry && prevWiEntry !== nextWiEntry && S.worldItems.includes(prevWiEntry)) {
    rebuildWorldItemVisual(prevWiEntry, false);
  }

  // Определяем, должно ли быть открыто изолированное окно 3D STUDIO
  const shouldOpen3DStudio =
    !!ref &&
    (ref.kind === 'cosmetic' || (ref.kind === 'world_item' && !ref.inWorldPlacement));

  if (!shouldOpen3DStudio && S.itemStudioOpen) {
    S.itemStudioOpen = false;
    if (itemStudioStageGroup) itemStudioStageGroup.visible = false;
    if ($('itemStudioOverlay')) $('itemStudioOverlay').hidden = true;
    if ($('openItemStudioBtn')) $('openItemStudioBtn').classList.remove('active');
    restoreItemStudioSubjectsToWorld();
    if (savedMapCamera) {
      S.edCamPos.copy(savedMapCamera.pos);
      S.edYaw = savedMapCamera.yaw;
      S.edPitch = savedMapCamera.pitch;
      savedMapCamera = null;
    }
  }

  hideAllCharacterGripMarkers();

  S.selectedRef = ref;
  const worldBtn = $('openWorldSettingsBtn');
  if (worldBtn) worldBtn.classList.toggle('active', !ref);

  if (!ref) {
    tControls.detach();
    selBoxHelper.visible = false;
    $('inspTypeBadge').textContent = '🌤️ Мир';
    refreshHierarchyUI();
    renderInspectorUI();
    return;
  }
  if (ref.kind === 'block') {
    ref.box.m.updateMatrixWorld(true);
    tControls.attach(ref.box.m);
    selBoxHelper.setFromObject(ref.box.m);
    selBoxHelper.visible = true;
    $('inspTypeBadge').textContent = ref.box.checkpointData.enabled ? '⭐ Чекпоинт' : '🧱 Объект сцены';
  } else if (ref.kind === 'char') {
    const ent = ref.ent;
    if (!ref.editMode) ref.editMode = 'root';
    normalizeCharacterGripPoints(ent.preset);
    if (ent.rig.syncGripSockets) ent.rig.syncGripSockets(ent.preset);
    if (ent.rig.setGripMarkersVisible) ent.rig.setGripMarkersVisible(true);

    if (ref.editMode === 'hand_grip' && ent.rig.handGripMarker) {
      ent.rig.armR.rotation.set(-Math.PI / 2, 0, 0);
      ent.rig.g.updateMatrixWorld(true);
      ref.mesh = ent.rig.handGripMarker;
      tControls.attach(ref.mesh);
      selBoxHelper.visible = false;
    } else if (ref.editMode === 'carry_grip' && ent.rig.carryGripMarker) {
      ent.rig.armL.rotation.set(-1.35, -0.28, 0.08);
      ent.rig.armR.rotation.set(-1.35, 0.28, -0.08);
      ent.rig.g.updateMatrixWorld(true);
      ref.mesh = ent.rig.carryGripMarker;
      tControls.attach(ref.mesh);
      selBoxHelper.visible = false;
    } else {
      ent.rig.armL.rotation.set(0, 0, 0);
      ent.rig.armR.rotation.set(0, 0, 0);
      ent.rig.g.updateMatrixWorld(true);
      ref.mesh = ent.rig.g;
      tControls.attach(ref.mesh);
      selBoxHelper.setFromObject(ref.mesh);
      selBoxHelper.visible = true;
    }

    $('inspTypeBadge').textContent = ent.isP ? '👑 Игрок' : '🤖 NPC Бот';
  } else if (ref.kind === 'cosmetic') {
    const { ent, item } = ref;
    normalizeCosmeticItem(item);
    const group = ref.group || ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === item);
    if (group) group.visible = true;
    const partMeshes = (group && group.userData.partMeshes) || [];
    const partIdx = Math.min(Math.max(0, ref.partIdx ?? 0), Math.max(0, item.parts.length - 1));
    const part = item.parts[partIdx];
    const mesh = ref.mesh || partMeshes[partIdx] || group;

    ref.group = group;
    ref.partIdx = partIdx;
    ref.part = part;
    ref.mesh = mesh;

    openItemStudio3D(ref);

    if (mesh) {
      mesh.updateMatrixWorld(true);
      tControls.attach(mesh);
      selBoxHelper.setFromObject(mesh);
      selBoxHelper.visible = true;
    }
    $('inspTypeBadge').textContent = item.parentSlot === 'pet' ? '🐾 3D Питомец' : '🎩 3D Аксессуар';
  } else if (ref.kind === 'world_item') {
    const { worldEntry } = ref;
    const item = normalizeItemData(worldEntry.item);
    ref.item = item;
    if (!ref.editMode) ref.editMode = ref.inWorldPlacement ? 'root' : 'part';

    rebuildWorldItemVisual(worldEntry, true);
    if (shouldOpen3DStudio) {
      openItemStudio3D(ref);
    }

    const rootGroup = worldEntry.group;

    // Если редактируем примитивы снаряда (proj_part), создаём наглядное превью снаряда перед дулом
    if (ref.editMode === 'proj_part') {
      const projGroup = buildItemGroup(item, { isProjectile: true, showMarkers: false, applyGripOffset: false });
      projGroup.position.set(
        item.muzzlePoint.x || 0,
        (item.muzzlePoint.y || 0) + 0.45,
        (item.muzzlePoint.z ?? -0.8) - 0.55
      );
      projGroup.traverse(o => {
        o.userData.editorRef = { kind: 'world_item', worldEntry };
      });
      rootGroup.add(projGroup);
      ref.projPreviewGroup = projGroup;

      const pIdx = Math.min(Math.max(0, ref.partIdx ?? 0), Math.max(0, item.projectileParts.length - 1));
      ref.partIdx = pIdx;
      ref.part = item.projectileParts[pIdx];
      ref.mesh = projGroup.userData.partMeshes[pIdx] || projGroup;
    } else if (ref.editMode === 'part') {
      const pIdx = Math.min(Math.max(0, ref.partIdx ?? 0), Math.max(0, item.parts.length - 1));
      ref.partIdx = pIdx;
      ref.part = item.parts[pIdx];
      ref.mesh = rootGroup.userData.partMeshes[pIdx] || rootGroup;
    } else if (ref.editMode === 'grip') {
      ref.mesh = rootGroup.userData.gripMarker || rootGroup;
    } else if (ref.editMode === 'muzzle') {
      ref.mesh = rootGroup.userData.muzzleMarker || rootGroup;
    } else {
      ref.mesh = rootGroup;
    }

    if (ref.mesh) {
      ref.mesh.updateMatrixWorld(true);
      tControls.attach(ref.mesh);
      if (ref.editMode === 'grip' || ref.editMode === 'muzzle') {
        selBoxHelper.visible = false;
      } else {
        selBoxHelper.setFromObject(ref.mesh);
        selBoxHelper.visible = true;
      }
    }
    $('inspTypeBadge').textContent = `${item.icon || '🗡️'} Предмет / Оружие`;
  }
  refreshHierarchyUI();
  renderInspectorUI();
}

export function focusOnSelected() {
  if (!S.selectedRef) return;
  if (S.itemStudioOpen) {
    setItemStudioCameraPreset('iso');
    return;
  }
  let obj = null;
  if (S.selectedRef.kind === 'block') obj = S.selectedRef.box.m;
  else if (S.selectedRef.kind === 'char') obj = S.selectedRef.ent.rig.g;
  else if (S.selectedRef.kind === 'world_item') obj = S.selectedRef.mesh || S.selectedRef.worldEntry.group;
  else obj = S.selectedRef.mesh;

  if (!obj) return;
  const p = new THREE.Vector3();
  obj.getWorldPosition(p);
  const fwd = new THREE.Vector3(
    -Math.sin(S.edYaw) * Math.cos(S.edPitch),
    Math.sin(S.edPitch),
    -Math.cos(S.edYaw) * Math.cos(S.edPitch)
  );
  S.edCamPos.copy(p).addScaledVector(fwd, -7).add(new THREE.Vector3(0, 1.5, 0));
}

export function duplicateSelected() {
  if (!S.selectedRef) return;
  if (S.selectedRef.kind === 'block') {
    pushUndoState('Дублирование объекта');
    const src = S.selectedRef.box;
    const m = src.m;
    const copy = addSceneBlock({
      x: m.position.x + 2,
      y: m.position.y + m.scale.y / 2,
      z: m.position.z + 2,
      w: m.scale.x,
      h: m.scale.y,
      d: m.scale.z,
      colorHex: src.colorHex,
      gold: src.gold,
      customTexDataURL: src.customTexDataURL,
      matterState: src.matterState,
      bounciness: src.bounciness,
      conveyorVz: src.conveyorVz,
      conveyorVx: src.conveyorVx,
      damageOnContact: src.damageOnContact,
      teleportToCheckpoint: src.teleportToCheckpoint,
      spinSpeed: src.spinSpeed,
      checkpointData: JSON.parse(JSON.stringify(src.checkpointData)),
      spawnerData: JSON.parse(JSON.stringify(src.spawnerData)),
      particleData: src.particleData ? JSON.parse(JSON.stringify(src.particleData)) : null,
      lightData: src.lightData ? JSON.parse(JSON.stringify(src.lightData)) : null,
      logicData: src.logicData ? JSON.parse(JSON.stringify(src.logicData)) : null,
      label: src.label + ' (Копия)',
      isCustom: true
    });
    copy.m.rotation.copy(m.rotation);
    rebuildPhysicsArrays();
    selectEditorObject({ kind: 'block', box: copy });
    sfx.jump();
  } else if (S.selectedRef.kind === 'world_item') {
    const { worldEntry, item, editMode, part, libIdx } = S.selectedRef;
    if (editMode === 'part' || editMode === 'proj_part') {
      const targetArr = editMode === 'proj_part' ? item.projectileParts : item.parts;
      if (targetArr.length >= MAX_ITEM_PARTS) {
        showBanner(`Максимум ${MAX_ITEM_PARTS} примитивов!`, '#ff3e3e');
        return;
      }
      pushItemUndoState('Дублирование примитива предмета');
      const srcPart = part || targetArr[0];
      const copyPart = Object.assign({}, JSON.parse(JSON.stringify(srcPart)), {
        id: 'ipt_' + Date.now(),
        name: `${srcPart.name || 'Часть'} #${targetArr.length + 1}`,
        x: (srcPart.x || 0) + 0.2
      });
      targetArr.push(copyPart);
      syncLibraryItemIfEditing(S.selectedRef);
      selectEditorObject({
        kind: 'world_item',
        worldEntry,
        item,
        editMode,
        partIdx: targetArr.length - 1,
        libIdx
      }, true);
      sfx.jump();
      return;
    }

    pushUndoState('Дублирование предмета в мире');
    const copyData = JSON.parse(JSON.stringify(item));
    copyData.id = 'item_' + Date.now();
    const newWi = spawnWorldItem(copyData, worldEntry.x + 1.8, worldEntry.y, worldEntry.z);
    selectEditorObject({ kind: 'world_item', worldEntry: newWi, item: newWi.item, editMode: 'part', partIdx: 0 });
    sfx.jump();
  } else if (S.selectedRef.kind === 'char') {
    pushUndoState('Дублирование NPC');
    const src = S.selectedRef.ent;
    const npc = spawnCustomNPC(Object.assign({}, JSON.parse(JSON.stringify(src.preset)), {
      name: src.name + '_Copy',
      chat: src.chat,
      x: src.x + 1.8,
      y: src.y,
      z: src.z,
      scale: src.rig.g.scale.x,
      hpEnabled: src.hpEnabled,
      maxHp: src.maxHp,
      hp: src.maxHp
    }));
    selectEditorObject({ kind: 'char', ent: npc });
    sfx.coil();
  } else if (S.selectedRef.kind === 'cosmetic') {
    const { ent, item, part, libIdx } = S.selectedRef;
    normalizeCosmeticItem(item);
    if (item.parts.length >= MAX_COSMETIC_PARTS) {
      showBanner(`Достигнут лимит: максимум ${MAX_COSMETIC_PARTS} примитивов в одном аксессуаре!`, '#ff3e3e');
      return;
    }
    pushCosmeticUndoState('Дублирование примитива');
    const copyPart = Object.assign({}, JSON.parse(JSON.stringify(part || item.parts[0])), {
      id: 'pt_' + Date.now(),
      name: `Примитив #${item.parts.length + 1}`,
      x: ((part && part.x) || 0) + 0.2,
      y: ((part && part.y) || 0) + 0.15
    });
    item.parts.push(copyPart);
    syncLibraryItemIfEditing(S.selectedRef);
    ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
    attachRigToEntity(ent);
    const newGroup = ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === item);
    selectEditorObject(
      {
        kind: 'cosmetic',
        ent,
        item,
        group: newGroup,
        partIdx: item.parts.length - 1,
        libIdx
      },
      true
    );
    sfx.jump();
    showBanner(`📋 Примитив дублирован (${item.parts.length} / ${MAX_COSMETIC_PARTS})`, '#00e676');
  }
}

export function deleteSelected() {
  if (!S.selectedRef) return;
  if (S.selectedRef.kind === 'block') {
    pushUndoState('Удаление блока');
    const box = S.selectedRef.box;
    scene.remove(box.m);
    if (box.cpVisualGroup) scene.remove(box.cpVisualGroup);
    const idx = S.allBlocks.indexOf(box);
    if (idx >= 0) S.allBlocks.splice(idx, 1);
    rebuildPhysicsArrays();
    selectEditorObject(null);
    sfx.oof();
  } else if (S.selectedRef.kind === 'world_item') {
    const { worldEntry, item, editMode, partIdx, libIdx } = S.selectedRef;
    if (editMode === 'part' || editMode === 'proj_part') {
      const targetArr = editMode === 'proj_part' ? item.projectileParts : item.parts;
      if (targetArr.length > 1) {
        pushItemUndoState('Удаление примитива предмета');
        targetArr.splice(partIdx || 0, 1);
        syncLibraryItemIfEditing(S.selectedRef);
        selectEditorObject({
          kind: 'world_item',
          worldEntry,
          item,
          editMode,
          partIdx: Math.max(0, (partIdx || 0) - 1),
          libIdx
        }, true);
        sfx.oof();
        return;
      }
    }

    if (S.itemStudioOpen) {
      closeItemStudio3D(false);
    }
    pushUndoState('Удаление предмета со сцены');
    if (worldEntry.group) scene.remove(worldEntry.group);
    if (worldEntry.tag) scene.remove(worldEntry.tag);
    const idx = S.worldItems.indexOf(worldEntry);
    if (idx >= 0) S.worldItems.splice(idx, 1);
    selectEditorObject(null);
    sfx.oof();
  } else if (S.selectedRef.kind === 'char') {
    const ent = S.selectedRef.ent;
    if (ent.isP || (!ent.isCustomNPC && !ent.isArchangel)) {
      showBanner('Игрока и сюжетную очередь удалять нельзя (можно двигать и менять внешность)!', '#ff3e3e');
      return;
    }
    pushUndoState('Удаление NPC');
    scene.remove(ent.rig.g);
    scene.remove(ent.tag);
    const idx = S.customNPCs.indexOf(ent);
    if (idx >= 0) S.customNPCs.splice(idx, 1);
    selectEditorObject(null);
    sfx.oof();
  } else if (S.selectedRef.kind === 'cosmetic') {
    const { ent, item, partIdx, libIdx } = S.selectedRef;
    normalizeCosmeticItem(item);
    if (item.parts.length > 1) {
      pushCosmeticUndoState('Удаление примитива аксессуара');
      item.parts.splice(partIdx || 0, 1);
      syncLibraryItemIfEditing(S.selectedRef);
      ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
      attachRigToEntity(ent);
      const newGroup = ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === item);
      selectEditorObject(
        {
          kind: 'cosmetic',
          ent,
          item,
          group: newGroup,
          partIdx: Math.max(0, (partIdx || 0) - 1),
          libIdx
        },
        true
      );
      sfx.oof();
      return;
    }

    if (S.itemStudioOpen) {
      closeItemStudio3D(false);
    }
    S.selectedRef = { kind: 'char', ent };
    pushUndoState('Удаление аксессуара');
    const arr = ent.preset.customCosmetics || [];
    const idx = arr.indexOf(item);
    if (idx >= 0) arr.splice(idx, 1);
    ent.rig.syncCustomCosmetics(arr);
    attachRigToEntity(ent);
    selectEditorObject({ kind: 'char', ent });
    sfx.oof();
  }
}
