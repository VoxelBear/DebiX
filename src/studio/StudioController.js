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
  buildItemGroup
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
      editMode: editMode || 'root',
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
  if (S.selectedRef && S.selectedRef.kind === 'world_item' && S.selectedRef.editMode !== 'root') {
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
      if (foundWi) restoredRef = { kind: 'world_item', worldEntry: foundWi, item: foundWi.item, editMode: 'root', partIdx: 0 };
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
        selBoxHelper.setFromObject(m);
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
        selBoxHelper.setFromObject(m);
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

      if (!editMode || editMode === 'root') {
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
      } else if (editMode === 'grip' && mesh) {
        item.gripPoint.x = -mesh.position.x;
        item.gripPoint.y = -mesh.position.y;
        item.gripPoint.z = -mesh.position.z;
        item.gripPoint.rx = mesh.rotation.x;
        item.gripPoint.ry = mesh.rotation.y;
        item.gripPoint.rz = mesh.rotation.z;
        mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(mesh);
      } else if (editMode === 'muzzle' && mesh) {
        item.muzzlePoint.x = mesh.position.x;
        item.muzzlePoint.y = mesh.position.y;
        item.muzzlePoint.z = mesh.position.z;
        mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(mesh);
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
      rebuildWorldItemVisual(wi, true);
    }

    if (S.selectedRef && S.selectedRef.kind === 'char' && S.selectedRef.ent?.rig?.setGripMarkersVisible) {
      S.selectedRef.ent.rig.setGripMarkersVisible(true);
    }

    if (S.player) {
      S.edCamPos.set(S.player.x + 8, S.player.y + 7, S.player.z + 12);
      S.edYaw = 0.55;
      S.edPitch = -0.35;
    }
    refreshHierarchyUI();
    renderInspectorUI();
    showBanner('🛠️ DebiX Studio 3D! СКМ — панорама, ПКМ+WASD — полёт, Ctrl+Z — контекстная отмена.', '#56f0ff');
  } else {
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
    } else if (ref.editMode === 'carry_grip' && ent.rig.carryGripMarker) {
      ent.rig.armL.rotation.set(-1.35, 0.28, -0.08);
      ent.rig.armR.rotation.set(-1.35, -0.28, 0.08);
      ent.rig.g.updateMatrixWorld(true);
      ref.mesh = ent.rig.carryGripMarker;
    } else {
      ent.rig.armL.rotation.set(0, 0, 0);
      ent.rig.armR.rotation.set(0, 0, 0);
      ent.rig.g.updateMatrixWorld(true);
      ref.mesh = ent.rig.g;
    }

    tControls.attach(ref.mesh);
    selBoxHelper.setFromObject(ref.mesh);
    selBoxHelper.visible = true;
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
    if (!ref.editMode) ref.editMode = 'root';

    rebuildWorldItemVisual(worldEntry, true);
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
      selBoxHelper.setFromObject(ref.mesh);
      selBoxHelper.visible = true;
    }
    $('inspTypeBadge').textContent = `${item.icon || '🗡️'} Предмет / Оружие`;
  }
  refreshHierarchyUI();
  renderInspectorUI();
}

export function focusOnSelected() {
  if (!S.selectedRef) return;
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
    selectEditorObject({ kind: 'world_item', worldEntry: newWi, item: newWi.item, editMode: 'root', partIdx: 0 });
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