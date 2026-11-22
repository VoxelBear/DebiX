// src/core/Serializer.js
import {
  S,
  $,
  STORAGE_KEY,
  PROJECTS_STORAGE_KEY,
  coarse,
  showBanner
} from './State.js';
import { scene, updateSkybox } from './SceneManager.js';
import { initAudio, sfx, syncAudioWithWorldSettings } from './AudioEngine.js';
import { createRobloxRig, normalizeItemData, normalizeCharacterGripPoints } from './CharacterRig.js';
import {
  addSceneBlock,
  rebuildPhysicsArrays,
  syncBlockSpecialVisuals,
  syncBlockComponentsState,
  resetAllLogicRuntime,
  removeBlockHalo,
  syncSceneVisibilityForMode
} from './WorldRegistry.js';
import {
  spawnCustomNPC,
  createDefaultNpcModules,
  ensureNpcModules,
  attachRigToEntity,
  refreshEntityTagWithHP,
  updateShopUI,
  clearWorldItems,
  spawnWorldItem,
  syncEntityHeldItemMesh,
  renderHotbarUI
} from './EntityManager.js';
import { HeavenQueueGame } from '../games/HeavenQueueGame.js';
import { SandboxGame } from '../games/SandboxGame.js';
import { toggleStudioMode, selectEditorObject } from '../studio/StudioController.js';
import { spawnEmptyObject, clearEmptyObjects } from '../studio/HierarchyAndSpawn.js';

export const GAME_MODES = {
  heaven_queue: HeavenQueueGame,
  sandbox_template: SandboxGame
};

function serializeCleanScriptData(sd) {
  if (!sd) return null;
  const cleanScripts = Array.isArray(sd.scripts)
    ? sd.scripts.filter(Boolean).map(s => ({
        id: s.id || ('scr_' + Date.now()),
        enabled: Boolean(s.enabled),
        targetType: s.targetType || sd.targetType || 'block',
        name: s.name || 'Мой Скрипт',
        code: s.code || '',
        paramValues: s.paramValues ? JSON.parse(JSON.stringify(s.paramValues)) : {},
        collapsed: Boolean(s.collapsed),
        showBadge: s.showBadge !== false
      }))
    : undefined;

  return {
    enabled: Boolean(sd.enabled),
    collapsed: Boolean(sd.collapsed),
    targetType: sd.targetType || 'block',
    name: sd.name || 'Мой Скрипт',
    code: sd.code || '',
    paramValues: sd.paramValues ? JSON.parse(JSON.stringify(sd.paramValues)) : {},
    showBadge: sd.showBadge !== false,
    scripts: cleanScripts
  };
}

export function switchGameTemplate(modeId) {
  const mode = GAME_MODES[modeId] || HeavenQueueGame;
  S.gameMode = mode;
  clearWorldItems();
  mode.init();
}

/* ---------- Менеджер слотов проектов (My Places) ---------- */
export function getProjectsList() {
  let list = [];
  try {
    list = JSON.parse(localStorage.getItem(PROJECTS_STORAGE_KEY) || '[]');
    if (!Array.isArray(list)) list = [];
  } catch (_) {
    list = [];
  }

  if (list.length === 0) {
    try {
      const legacy = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (legacy && Array.isArray(legacy.blocks)) {
        const migrated = {
          id: 'proj_' + Date.now(),
          title: legacy.projectTitle || (legacy.gameModeId === 'sandbox_template' ? 'Моя Sandbox Карта #1' : 'Очередь в Рай (Мод #1)'),
          updatedAt: new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }),
          sceneData: legacy
        };
        list.push(migrated);
        localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(list));
      }
    } catch (_) {}
  }
  return list;
}

export function saveProjectsList(list) {
  try {
    localStorage.setItem(PROJECTS_STORAGE_KEY, JSON.stringify(list));
  } catch (err) {
    console.warn('Quota exceeded or storage error:', err);
  }
}

export function saveCurrentProjectSlot(customTitle = null) {
  resetAllLogicRuntime(false);
  rebuildPhysicsArrays();
  const stateObj = serializeSceneState();
  const list = getProjectsList();

  if (customTitle) {
    S.currentProjectTitle = customTitle;
  }
  if (!S.currentProjectId) {
    S.currentProjectId = 'proj_' + Date.now();
  }
  stateObj.projectTitle = S.currentProjectTitle;

  const nowStr = new Date().toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });

  const existingIdx = list.findIndex(p => p.id === S.currentProjectId);
  const entry = {
    id: S.currentProjectId,
    title: S.currentProjectTitle || 'Мой Мир',
    updatedAt: nowStr,
    sceneData: stateObj
  };

  if (existingIdx >= 0) {
    list[existingIdx] = entry;
  } else {
    list.unshift(entry);
  }

  saveProjectsList(list);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stateObj));
  } catch (_) {}

  syncProjectTitleInput();
  return entry;
}

export function exportProjectToJsonFile(sceneData, fileTitle = 'My_World') {
  const jsonStr = JSON.stringify(sceneData, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safeName = (fileTitle || 'world').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
  a.download = `${safeName}.json`;
  a.click();
  sfx.cash();
  showBanner(`📤 Карта «${fileTitle}» экспортирована в .JSON!`, '#56f0ff');
}

export function promptImportJsonFile(onLoadedCallback) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.json,application/json';
  inp.onchange = e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const data = JSON.parse(ev.target.result);
        if (!data || !Array.isArray(data.blocks)) {
          showBanner('❌ Неверный формат JSON-файла карты!', '#ff3e3e');
          return;
        }
        const cleanTitle = file.name.replace(/\.json$/i, '');
        S.currentProjectId = 'proj_' + Date.now();
        S.currentProjectTitle = data.projectTitle || cleanTitle || 'Импортированный мир';
        loadSceneState(data);
        saveCurrentProjectSlot(S.currentProjectTitle);
        sfx.gate();
        showBanner(`📂 Мир «${S.currentProjectTitle}» успешно импортирован и сохранён в слоты!`, '#00e676');
        if (onLoadedCallback) onLoadedCallback(data);
      } catch (err) {
        showBanner('❌ Ошибка чтения JSON: ' + err.message, '#ff3e3e');
      }
    };
    reader.readAsText(file);
  };
  inp.click();
}

export function serializeSceneState() {
  const player = S.player;
  if (player && player.preset) {
    normalizeCharacterGripPoints(player.preset);
  }
  return {
    projectTitle: S.currentProjectTitle || 'Мой Мир',
    gameModeId: S.gameMode ? S.gameMode.id : 'heaven_queue',
    worldSettings: JSON.parse(JSON.stringify(S.worldSettings)),
    customDefaultStudDataURL: S.customDefaultStudDataURL,
    savedCosmeticsLibrary: JSON.parse(JSON.stringify(S.savedCosmeticsLibrary || [])),
    savedItemsLibrary: JSON.parse(JSON.stringify(S.savedItemsLibrary || [])),
    customPrefabsLibrary: JSON.parse(JSON.stringify(S.customPrefabsLibrary || [])),
    customAudioLibrary: JSON.parse(JSON.stringify(S.customAudioLibrary || [])),
    customScriptsLibrary: (S.customScriptsLibrary || []).map(s => ({
      id: s.id,
      targetType: s.targetType || 'block',
      name: s.name || 'Аддон',
      code: s.code || '',
      paramValues: s.paramValues ? JSON.parse(JSON.stringify(s.paramValues)) : {}
    })),
    customModelsLibrary: JSON.parse(JSON.stringify(S.customModelsLibrary || [])),
    prefabFolders: JSON.parse(JSON.stringify(S.prefabFolders || [])),
    sceneFolders: JSON.parse(JSON.stringify(S.sceneFolders || [])),
    physicsConstraints: JSON.parse(JSON.stringify((S.physicsConstraints || []).filter(c => !c._createdInPlay))),
    emptyObjects: (S.emptyObjects || []).map(emp => ({
      id: emp.id,
      name: emp.name,
      x: emp.x, y: emp.y, z: emp.z,
      rx: emp.rx || 0, ry: emp.ry || 0, rz: emp.rz || 0,
      sx: emp.sx || 1, sy: emp.sy || 1, sz: emp.sz || 1,
      parentKey: emp.parentKey || null,
      hierOrder: emp.hierOrder || 0,
      isDisabled: !!emp.isDisabled,
      editorHidden: !!emp.editorHidden
    })),
    playerData: player
      ? {
          name: player.name,
          chat: player.chat,
          x: player.x,
          y: player.y,
          z: player.z,
          rot: player.rot || 0,
          respawnX: player.respawnX,
          respawnY: player.respawnY,
          respawnZ: player.respawnZ,
          scale: player.rig.g.scale.x,
          hpEnabled: player.hpEnabled,
          hp: player.hp,
          maxHp: player.maxHp,
          meleeDamage: player.meleeDamage,
          colliderRadius: player.colliderRadius,
          colliderHeight: player.colliderHeight,
          walkSpeed: player.walkSpeed,
          jumpPower: player.jumpPower,
          weight: player.weight ?? 70,
          inventory: JSON.parse(JSON.stringify(player.inventory || [null, null, null, null, null, null])),
          carriedItem: player.carriedItem ? JSON.parse(JSON.stringify(player.carriedItem)) : null,
          handGripPoint: player.preset?.handGripPoint ? Object.assign({}, player.preset.handGripPoint) : null,
          carryGripPoint: player.preset?.carryGripPoint ? Object.assign({}, player.preset.carryGripPoint) : null,
          preset: JSON.parse(JSON.stringify(player.preset))
        }
      : null,
    worldItems: S.worldItems.map(wi => ({
      id: wi.id,
      parentKey: wi.parentKey || null,
      hierOrder: wi.hierOrder || 0,
      x: wi.x,
      y: wi.y,
      z: wi.z,
      rotX: wi.rotX || 0,
      rotY: wi.rotY || 0,
      rotZ: wi.rotZ || 0,
      scaleX: wi.scaleX || 1,
      scaleY: wi.scaleY || 1,
      scaleZ: wi.scaleZ || 1,
      isDisabled: !!wi.isDisabled,
      editorHidden: !!wi.editorHidden,
      item: Object.assign({}, JSON.parse(JSON.stringify(wi.item)), {
        scriptData: serializeCleanScriptData(wi.item.scriptData)
      })
    })),
    blocks: S.allBlocks.map(b => {
      const basePos = (b.logicRuntime && b.logicRuntime.basePos) ? b.logicRuntime.basePos : b.m.position;
      const baseScale = (b.logicRuntime && b.logicRuntime.baseScale) ? b.logicRuntime.baseScale : b.m.scale;
      const baseEuler = (b.logicRuntime && b.logicRuntime.baseQuat)
        ? new THREE.Euler().setFromQuaternion(b.logicRuntime.baseQuat)
        : b.m.rotation;
      return {
        id: b.id,
        label: b.label,
        shape: b.shape,
        surfaceType: b.surfaceType || 'studs',
        colliderShape: b.colliderShape || 'auto',
        cx: basePos.x,
        cy: basePos.y,
        cz: basePos.z,
        x: basePos.x,
        y: basePos.y + baseScale.y / 2,
        z: basePos.z,
        w: baseScale.x,
        h: baseScale.y,
        d: baseScale.z,
        rx: baseEuler.x,
        ry: baseEuler.y,
        rz: baseEuler.z,
        colorHex: b.colorHex,
        gold: b.gold,
        customTexDataURL: b.customTexDataURL,
        matterState: b.matterState,
        isDynamicPhysics: !!b.isDynamicPhysics,
        weight: b.weight ?? 15,
        weldToParent: b.weldToParent !== false,
        liquidPhysicsEnabled: b.liquidPhysicsEnabled !== false,
        liquidBuoyancy: b.liquidBuoyancy ?? 45,
        liquidDrag: b.liquidDrag ?? 3.5,
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
        costData: b.costData ? Object.assign({}, JSON.parse(JSON.stringify(b.costData)), { unlocked: false }) : null,
        soundData: b.soundData ? JSON.parse(JSON.stringify(b.soundData)) : null,
        checkpointData: b.checkpointData ? JSON.parse(JSON.stringify(b.checkpointData)) : null,
        spawnerData: b.spawnerData ? JSON.parse(JSON.stringify(b.spawnerData)) : null,
        particleData: b.particleData ? JSON.parse(JSON.stringify(b.particleData)) : null,
        lightData: b.lightData ? JSON.parse(JSON.stringify(b.lightData)) : null,
        scriptData: serializeCleanScriptData(b.scriptData),
        bbmodelData: b.bbmodelData ? JSON.parse(JSON.stringify(b.bbmodelData)) : null,
        logicData: b.logicData ? Object.assign({}, JSON.parse(JSON.stringify(b.logicData)), { unlocked: false }) : null,
        parentKey: b.parentKey || null,
        hierOrder: b.hierOrder || 0,
        isCustom: b.isCustom,
        isDisabled: !!b.isDisabled,
        editorHidden: !!b.editorHidden
      };
    }),
    customNPCs: S.customNPCs.map(n => {
      if (n.preset) normalizeCharacterGripPoints(n.preset);
      return {
        id: n.id,
        name: n.name,
        chat: n.chat,
        wander: n.wander,
        aggressive: n.aggressive,
        hpEnabled: n.hpEnabled,
        hp: n.hp,
        maxHp: n.maxHp,
        meleeDamage: n.meleeDamage,
        walkSpeed: n.walkSpeed || 5.4,
        jumpPower: n.jumpPower || 10.2,
        weight: n.weight ?? 70,
        equippedItem: n.equippedItem ? JSON.parse(JSON.stringify(n.equippedItem)) : null,
        aiModules: n.aiModules ? JSON.parse(JSON.stringify(n.aiModules)) : null,
        homeX: n.homeX ?? n.x,
        homeY: n.homeY ?? n.y,
        homeZ: n.homeZ ?? n.z,
        x: n.x,
        y: n.y,
        z: n.z,
        rot: n.rot,
        scale: n.rig.g.scale.x,
        parentKey: n.parentKey || null,
        hierOrder: n.hierOrder || 0,
        handGripPoint: n.preset?.handGripPoint ? Object.assign({}, n.preset.handGripPoint) : null,
        carryGripPoint: n.preset?.carryGripPoint ? Object.assign({}, n.preset.carryGripPoint) : null,
        preset: JSON.parse(JSON.stringify(n.preset)),
        isDisabled: !!n.isDisabled,
        editorHidden: !!n.editorHidden,
        permanentDeath: !!n.permanentDeath
      };
    })
  };
}

export function loadSceneState(data, opts = {}) {
  if (!data) return;
  const isUndo = !!opts.isUndo;
  const targetModeId = data.gameModeId || 'heaven_queue';

  if (!isUndo && GAME_MODES[targetModeId]) {
    switchGameTemplate(targetModeId);
  } else if (isUndo && (!S.gameMode || S.gameMode.id !== targetModeId) && GAME_MODES[targetModeId]) {
    switchGameTemplate(targetModeId);
  }

  if (data.projectTitle) {
    S.currentProjectTitle = data.projectTitle;
  }

  if (data.worldSettings) {
    Object.assign(S.worldSettings, data.worldSettings);
    updateSkybox();
  }
  if (data.worldSettings?.worldScriptData) {
    S.worldSettings.worldScriptData = data.worldSettings.worldScriptData;
    S.worldSettings.worldScriptData._compiled = null;
  }
  if (data.customDefaultStudDataURL !== undefined) {
    S.customDefaultStudDataURL = data.customDefaultStudDataURL;
  }
  if (Array.isArray(data.savedCosmeticsLibrary)) {
    S.savedCosmeticsLibrary = JSON.parse(JSON.stringify(data.savedCosmeticsLibrary));
  }
  if (Array.isArray(data.savedItemsLibrary)) {
    S.savedItemsLibrary = JSON.parse(JSON.stringify(data.savedItemsLibrary));
  }
  if (Array.isArray(data.customPrefabsLibrary)) {
    S.customPrefabsLibrary = JSON.parse(JSON.stringify(data.customPrefabsLibrary));
  }
  if (Array.isArray(data.customAudioLibrary)) {
    S.customAudioLibrary = JSON.parse(JSON.stringify(data.customAudioLibrary));
  }
  if (Array.isArray(data.customScriptsLibrary)) {
    S.customScriptsLibrary = JSON.parse(JSON.stringify(data.customScriptsLibrary));
  }
  if (Array.isArray(data.customModelsLibrary)) {
    S.customModelsLibrary = JSON.parse(JSON.stringify(data.customModelsLibrary));
  }
  if (Array.isArray(data.prefabFolders)) {
    S.prefabFolders = JSON.parse(JSON.stringify(data.prefabFolders));
  }
  if (Array.isArray(data.sceneFolders)) {
    S.sceneFolders = JSON.parse(JSON.stringify(data.sceneFolders));
  }
  S.physicsConstraints = Array.isArray(data.physicsConstraints)
    ? JSON.parse(JSON.stringify(data.physicsConstraints))
    : [];

  clearEmptyObjects();
  if (Array.isArray(data.emptyObjects)) {
    for (const se of data.emptyObjects) {
      const emp = spawnEmptyObject(se);
      if (emp) {
        emp.isDisabled = Boolean(se.isDisabled);
        emp.editorHidden = Boolean(se.editorHidden);
      }
    }
  }

  if (Array.isArray(data.blocks)) {
    for (const b of S.allBlocks) {
      removeBlockHalo(b);
      scene.remove(b.m);
      if (b.cpVisualGroup) scene.remove(b.cpVisualGroup);
    }
    S.allBlocks.length = 0;
    S.blockIdCounter = 1;
    for (const sb of data.blocks) {
      const box = addSceneBlock(sb);
      box.isDisabled = Boolean(sb.isDisabled);
      box.editorHidden = Boolean(sb.editorHidden);
      if (box.scriptData) {
        box.scriptData._compiled = null;
        box.scriptData.runtimeDisabled = false;
      }
      if (sb.id) box.id = sb.id;
      if (sb.parentKey) box.parentKey = sb.parentKey;
      if (sb.weldToParent !== undefined) box.weldToParent = sb.weldToParent;
      if (sb.hierOrder !== undefined) box.hierOrder = sb.hierOrder;
      if (sb.colliderShape) box.colliderShape = sb.colliderShape;
      if (sb.surfaceType) box.surfaceType = sb.surfaceType;
      if (sb.components) box.components = JSON.parse(JSON.stringify(sb.components));
      if (sb.interactionData) box.interactionData = JSON.parse(JSON.stringify(sb.interactionData));
      if (sb.motionData) box.motionData = JSON.parse(JSON.stringify(sb.motionData));
      if (sb.signalData) box.signalData = JSON.parse(JSON.stringify(sb.signalData));
      if (sb.costData) box.costData = JSON.parse(JSON.stringify(sb.costData));
      if (sb.soundData) box.soundData = JSON.parse(JSON.stringify(sb.soundData));

      box.m.scale.set(sb.w || 1, sb.h || 1, sb.d || 1);
      if (sb.cy !== undefined) {
        box.m.position.set(sb.cx ?? sb.x ?? 0, sb.cy, sb.cz ?? sb.z ?? 0);
      } else {
        box.m.position.set(sb.x || 0, (sb.y || 0) - (sb.h || 1) / 2, sb.z || 0);
      }
      box.m.rotation.set(sb.rx || 0, sb.ry || 0, sb.rz || 0);
      box.m.updateMatrixWorld(true);
      if (sb.colliderScale) box.colliderScale = Object.assign({}, sb.colliderScale);
      if (box.logicRuntime) {
        box.logicRuntime.basePos = box.m.position.clone();
        box.logicRuntime.baseQuat = box.m.quaternion.clone();
        box.logicRuntime.baseScale = box.m.scale.clone();
      }
      syncBlockComponentsState(box);
    }
    const usedIds = new Set();
    let maxBlkNum = 0;
    for (const b of S.allBlocks) {
      if (typeof b.id === 'string' && b.id.startsWith('blk_')) {
        const n = parseInt(b.id.slice(4), 10);
        if (!Number.isNaN(n) && n > maxBlkNum) maxBlkNum = n;
      }
    }
    for (const b of S.allBlocks) {
      if (!b.id || usedIds.has(b.id)) {
        maxBlkNum++;
        b.id = 'blk_' + maxBlkNum;
      }
      usedIds.add(b.id);
    }
    S.blockIdCounter = Math.max(S.blockIdCounter, maxBlkNum + 1);
    rebuildPhysicsArrays();
  }

  // Восстановление предметов и переносимых контейнеров в мире со всеми углами и масштабом
  clearWorldItems();
  if (Array.isArray(data.worldItems)) {
    for (const sw of data.worldItems) {
      if (!sw || !sw.item) continue;
      const wi = spawnWorldItem(sw.item, sw.x ?? 0, sw.y ?? 1.5, sw.z ?? 0, 0, 0, 0, {
        id: sw.id,
        rotX: sw.rotX || 0,
        rotY: sw.rotY || 0,
        rotZ: sw.rotZ || 0,
        scaleX: sw.scaleX || 1,
        scaleY: sw.scaleY || 1,
        scaleZ: sw.scaleZ || 1
      });
      wi.isDisabled = Boolean(sw.isDisabled);
      wi.editorHidden = Boolean(sw.editorHidden);
      if (sw.parentKey) wi.parentKey = sw.parentKey;
      if (sw.hierOrder !== undefined) wi.hierOrder = sw.hierOrder;
    }
  }

  if (Array.isArray(data.customNPCs)) {
    for (const n of S.customNPCs) {
      scene.remove(n.rig.g);
      scene.remove(n.tag);
    }
    S.customNPCs.length = 0;
    for (const sn of data.customNPCs) {
      const npc = spawnCustomNPC(Object.assign({}, sn.preset, sn));
      npc.isDisabled = Boolean(sn.isDisabled);
      npc.editorHidden = Boolean(sn.editorHidden);
      npc.baseScale = npc.rig?.g?.scale?.x || sn.scale || 1;
      npc.baseGait = npc.aiModules?.navigation?.gait || 'normal';
      if (sn.parentKey) npc.parentKey = sn.parentKey;
      if (sn.hierOrder !== undefined) npc.hierOrder = sn.hierOrder;
      if (sn.rot !== undefined) {
        npc.rot = sn.rot;
        npc.rig.g.rotation.y = sn.rot;
      }
      npc.rig.g.updateMatrixWorld(true);
    }
  }

  if (data.playerData && S.player) {
    const pd = data.playerData;
    const player = S.player;
    Object.assign(player, {
      name: pd.name || player.name,
      chat: pd.chat || '',
      hpEnabled: pd.hpEnabled !== undefined ? pd.hpEnabled : true,
      hp: pd.hp || 100,
      maxHp: pd.maxHp || 100,
      baseMaxHp: pd.maxHp || 100,
      meleeDamage: pd.meleeDamage || 25,
      colliderRadius: pd.colliderRadius || 0.42,
      colliderHeight: pd.colliderHeight || 2.5,
      walkSpeed: pd.walkSpeed || 7.6,
      jumpPower: pd.jumpPower || 10.2,
      weight: pd.weight ?? 70,
      inventory: Array.isArray(pd.inventory)
        ? pd.inventory.map(it => (it ? normalizeItemData(it) : null))
        : [null, null, null, null, null, null],
      carriedItem: pd.carriedItem ? normalizeItemData(pd.carriedItem) : null
    });
    if (pd.x !== undefined) player.x = pd.x;
    if (pd.y !== undefined) player.y = pd.y;
    if (pd.z !== undefined) player.z = pd.z;
    if (pd.rot !== undefined) player.rot = pd.rot;
    if (pd.respawnX !== undefined) player.respawnX = pd.respawnX;
    if (pd.respawnY !== undefined) player.respawnY = pd.respawnY;
    if (pd.respawnZ !== undefined) player.respawnZ = pd.respawnZ;

    if (pd.preset) {
      scene.remove(player.rig.g);
      player.preset = JSON.parse(JSON.stringify(pd.preset));
      normalizeCharacterGripPoints(player.preset, pd);
      player.rig = createRobloxRig(player.preset, pd.scale || 1, false);
      player.rig.g.position.set(player.x, player.y, player.z);
      player.rig.g.rotation.y = player.rot || 0;
      player.rig.g.updateMatrixWorld(true);
      scene.add(player.rig.g);
      attachRigToEntity(player);
    } else {
      normalizeCharacterGripPoints(player.preset, pd);
      if (player.rig.syncGripSockets) player.rig.syncGripSockets(player.preset);
      player.rig.g.position.set(player.x, player.y, player.z);
      player.rig.g.rotation.y = player.rot || 0;
      player.rig.g.updateMatrixWorld(true);
    }
    syncEntityHeldItemMesh(player);
    renderHotbarUI();
    player.tag.position.set(player.x, player.y + 3.35, player.z);
    refreshEntityTagWithHP(player);
    updateShopUI();
  }
  syncSceneVisibilityForMode(S.state);
  syncProjectTitleInput();
}

export function startPlaySession() {
  initAudio();
  syncAudioWithWorldSettings();
  resetAllLogicRuntime(true);
  S.state = 'play';
  syncSceneVisibilityForMode('play');
  $('menu').hidden = true;
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

export function syncProjectTitleInput() {
  const inp = $('studioProjTitleInp');
  if (inp) inp.value = S.currentProjectTitle || 'Мой Мир';
}

export function exportFullStudioHtml() {
  resetAllLogicRuntime(false);
  rebuildPhysicsArrays();
  const stateJSON = JSON.stringify(serializeSceneState());
  let fullHtml = '<!doctype html>\n' + document.documentElement.outerHTML;
  fullHtml = fullHtml.replace(
    /<script id="bakedSceneDataScript">[\s\S]*?<\/script>/,
    `<script id="bakedSceneDataScript">\nwindow.__BAKED_SCENE_STATE__ = ${stateJSON};\n</script>`
  );
  const blob = new Blob([fullHtml], { type: 'text/html;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const safeName = (S.currentProjectTitle || 'Project').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
  a.download = `${safeName}_With_Studio.html`;
  a.click();
  sfx.cash();
  showBanner('📥 Проект с редактором (.HTML) скачан!', '#56f0ff');
}

export function createNewBlankSandboxMap() {
  if (!confirm('Создать новый чистый мир (Sandbox)? Несохранённые изменения текущей сцены будут заменены.')) return;
  initAudio();
  S.currentProjectId = 'proj_' + Date.now();
  S.currentProjectTitle = 'Новый Мир #' + (getProjectsList().length + 1);
  S.undoStack = [];
  switchGameTemplate('sandbox_template');
  syncProjectTitleInput();
  selectEditorObject(null);
  sfx.coil();
  showBanner(`🌱 Создан чистый мир «${S.currentProjectTitle}»!`, '#00e676');
}

export function resetAllSavedProjects() {
  if (!confirm('Очистить все слоты сохранённых миров в браузере?')) return;
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(PROJECTS_STORAGE_KEY);
  location.reload();
}

export function renderLauncherModal() {
  if (window.__PLAY_ONLY_BUILD__ && window.__BAKED_SCENE_STATE__) {
    loadSceneState(window.__BAKED_SCENE_STATE__);
    const mBox = $('modalBox');
    mBox.innerHTML = `
      <span class="badge" style="background:#00b06f">STANDALONE GAME BUILD</span>
      <h1>${(S.currentProjectTitle || S.gameMode?.title || 'ИГРАТЬ').toUpperCase()}</h1>
      <p style="color:#cbd5e1;font-weight:700;font-size:13px;margin-bottom:16px">
        Готовый игровой билд (${S.allBlocks.length} объектов и ${S.worldItems.length} предметов в мире). Нажми кнопку ниже, чтобы начать игру!
      </p>
      <button class="play-btn" id="btnPlayBakedNow" type="button">▶ НАЧАТЬ ИГРУ</button>
    `;
    $('menu').hidden = false;
    $('btnPlayBakedNow').onclick = () => startPlaySession();
    return;
  }

  const projects = getProjectsList();

  const projectsHTML = projects.length > 0
    ? projects.map(p => {
        const isSandbox = p.sceneData?.gameModeId === 'sandbox_template';
        const badge = isSandbox ? '🌱 Sandbox' : '😇 Очередь в Рай';
        const bCount = Array.isArray(p.sceneData?.blocks) ? p.sceneData.blocks.length : 0;
        const iCount = Array.isArray(p.sceneData?.worldItems) ? p.sceneData.worldItems.length : 0;
        const nCount = Array.isArray(p.sceneData?.customNPCs) ? p.sceneData.customNPCs.length : 0;
        return `
          <div style="background:rgba(15,20,30,.75);border:1.5px solid #383f52;border-radius:10px;padding:9px 11px;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
            <div style="min-width:160px;flex:1">
              <div style="font:800 13px var(--f);color:#fff;display:flex;align-items:center;gap:6px">
                <span>${p.title}</span>
                <span style="font-size:10px;background:#252934;color:#56f0ff;padding:2px 6px;border-radius:5px">${badge}</span>
              </div>
              <div style="font-size:10.5px;color:#94a3b8;margin-top:2px">
                🧱 ${bCount} блок. · 🗡️ ${iCount} предм. · 🤖 ${nCount} NPC · 🕒 ${p.updatedAt || ''}
              </div>
            </div>
            <div style="display:flex;gap:5px;flex-wrap:wrap">
              <button class="ed-btn apply-oneclick" data-pact="play" data-pid="${p.id}" type="button" style="padding:5px 10px">▶ Играть</button>
              <button class="ed-btn" data-pact="edit" data-pid="${p.id}" type="button">🛠️ Studio</button>
              <button class="ed-btn" data-pact="rename" data-pid="${p.id}" type="button" title="Переименовать">✏️</button>
              <button class="ed-btn" data-pact="json" data-pid="${p.id}" type="button" title="Скачать .JSON файл карты">📤 .JSON</button>
              <button class="ed-btn danger" data-pact="del" data-pid="${p.id}" type="button" title="Удалить проект">🗑️</button>
            </div>
          </div>
        `;
      }).join('')
    : `<div style="font-size:11.5px;color:#94a3b8;text-align:center;padding:12px">У тебя пока нет сохранённых миров. Создай новый мир выше или импортируй .JSON файл!</div>`;

  const mBox = $('modalBox');
  mBox.style.maxWidth = '720px';
  mBox.innerHTML = `
    <span class="badge">DEBIX STUDIO 3D & UGC PLATFORM</span>
    <h1>ВЫБЕРИ <span>ШАБЛОН</span> ИЛИ ОТКРОЙ СВОЙ МИР</h1>

    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px;margin:12px 0">
      <div style="background:rgba(255,255,255,.05);border:2px solid rgba(255,206,58,.45);border-radius:14px;padding:12px;display:flex;flex-direction:column;justify-content:space-between;gap:10px">
        <div>
          <div style="font:900 14px var(--f);color:#ffce3a;margin-bottom:4px">😇 ОЧЕРЕДЬ В РАЙ + ОББИ</div>
          <div style="font-size:11px;color:#cbd5e1;line-height:1.35">
            Оригинальная игра: 30 мест в очереди к Вратам Рая, судья Архангел Пётр, магазин пружин и 5-этапное Небесное Обби.
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="play-btn" id="launchHeavenPlay" type="button" style="padding:9px;font-size:12px;flex:1">▶ ИГРАТЬ</button>
          <button class="ed-btn" id="launchHeavenEdit" type="button" style="padding:9px;font-size:11px;justify-content:center">🛠️ Мод в Studio</button>
        </div>
      </div>

      <div style="background:rgba(0,162,255,.08);border:2px solid rgba(86,240,255,.45);border-radius:14px;padding:12px;display:flex;flex-direction:column;justify-content:space-between;gap:10px">
        <div>
          <div style="font:900 14px var(--f);color:#56f0ff;margin-bottom:4px">🌱 ЧИСТАЯ КАРТА (SANDBOX)</div>
          <div style="font-size:11px;color:#cbd5e1;line-height:1.35">
            Пустой мир с 3D OBB-физикой, Bricks Logic и Конструктором Оружия/Снарядов. Создавай свои шутеры, RPG и паркур!
          </div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="play-btn" id="launchSandboxEdit" type="button" style="padding:9px;font-size:12px;flex:1;background:linear-gradient(180deg,#00a2ff,#0066b8);box-shadow:0 4px 0 #004075">➕ НОВЫЙ МИР В STUDIO</button>
          <button class="ed-btn" id="launchSandboxPlay" type="button" style="padding:9px;font-size:11px;justify-content:center">▶ Тест</button>
        </div>
      </div>
    </div>

    <div style="background:rgba(0,0,0,.35);border:1.5px solid rgba(255,255,255,.16);border-radius:14px;padding:12px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;gap:8px;flex-wrap:wrap">
        <div style="font:900 12px var(--f);color:#69f0ae;letter-spacing:.04em">🗂️ МОИ СОХРАНЁННЫЕ МИРЫ (${projects.length})</div>
        <div style="display:flex;gap:6px">
          <button class="ed-btn" id="btnLauncherImportJson" type="button">📂 Импорт карты (.JSON)</button>
        </div>
      </div>
      <div style="max-height:190px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;padding-right:2px">
        ${projectsHTML}
      </div>
    </div>

    <div class="ctrls" style="margin-bottom:0;font-size:10.5px">
      <div><b>КОНСТРУКТОР ОРУЖИЯ И СНАРЯДОВ v4</b>Создавай мечи, огнестрел с прицелом ПКМ, метательные гранаты с замахом ЛКМ, аптечки и 2-ручные контейнеры!</div>
    </div>
  `;

  $('menu').hidden = false;
  $('topbar').hidden = true;
  $('shopPanel').hidden = true;
  $('hotbar').hidden = true;
  $('studioUI').hidden = true;
  S.state = 'menu';

  $('launchHeavenPlay').onclick = () => {
    S.currentProjectId = null;
    S.currentProjectTitle = 'Очередь в Рай (Мод)';
    S.undoStack = [];
    switchGameTemplate('heaven_queue');
    syncProjectTitleInput();
    startPlaySession();
  };

  $('launchHeavenEdit').onclick = () => {
    initAudio();
    S.currentProjectId = 'proj_' + Date.now();
    S.currentProjectTitle = 'Очередь в Рай #' + (projects.length + 1);
    S.undoStack = [];
    switchGameTemplate('heaven_queue');
    syncProjectTitleInput();
    selectEditorObject(null);
    toggleStudioMode('edit');
  };

  $('launchSandboxEdit').onclick = () => {
    initAudio();
    S.currentProjectId = 'proj_' + Date.now();
    S.currentProjectTitle = 'Мой Мир #' + (projects.length + 1);
    S.undoStack = [];
    switchGameTemplate('sandbox_template');
    syncProjectTitleInput();
    selectEditorObject(null);
    toggleStudioMode('edit');
    showBanner(`🌱 Создан проект «${S.currentProjectTitle}»!`, '#00e676');
  };

  $('launchSandboxPlay').onclick = () => {
    S.currentProjectId = null;
    S.currentProjectTitle = 'Чистая Карта';
    S.undoStack = [];
    switchGameTemplate('sandbox_template');
    syncProjectTitleInput();
    startPlaySession();
  };

  $('btnLauncherImportJson').onclick = () => {
    promptImportJsonFile(() => {
      renderLauncherModal();
    });
  };

  mBox.querySelectorAll('[data-pact]').forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.pact;
      const pid = btn.dataset.pid;
      const list = getProjectsList();
      const proj = list.find(x => x.id === pid);
      if (!proj) return;

      if (act === 'play') {
        S.currentProjectId = proj.id;
        S.currentProjectTitle = proj.title;
        S.undoStack = [];
        loadSceneState(proj.sceneData);
        startPlaySession();
      } else if (act === 'edit') {
        initAudio();
        S.currentProjectId = proj.id;
        S.currentProjectTitle = proj.title;
        S.undoStack = [];
        loadSceneState(proj.sceneData);
        selectEditorObject(null);
        toggleStudioMode('edit');
      } else if (act === 'rename') {
        const newName = prompt('Введи новое название проекта:', proj.title);
        if (newName && newName.trim()) {
          proj.title = newName.trim();
          if (proj.sceneData) proj.sceneData.projectTitle = proj.title;
          saveProjectsList(list);
          renderLauncherModal();
        }
      } else if (act === 'json') {
        exportProjectToJsonFile(proj.sceneData, proj.title);
      } else if (act === 'del') {
        if (!confirm(`Удалить проект «${proj.title}»?`)) return;
        const filtered = list.filter(x => x.id !== pid);
        saveProjectsList(filtered);
        renderLauncherModal();
      }
    };
  });
}

export function loadSavedStateOnBoot() {
  renderLauncherModal();
}

// Сборка ЧИСТОГО БИЛДА ИГРЫ (Play-Only Standalone HTML без кода src/studio/*)
export async function exportPlayOnlyBuild() {
  resetAllLogicRuntime(false);
  rebuildPhysicsArrays();
  const stateObj = serializeSceneState();
  const stateJSON = JSON.stringify(stateObj);
  const activeModeFile = stateObj.gameModeId === 'sandbox_template'
    ? './src/games/SandboxGame.js'
    : './src/games/HeavenQueueGame.js';
  const activeModeExport = stateObj.gameModeId === 'sandbox_template'
    ? 'SandboxGame'
    : 'HeavenQueueGame';

  showBanner('⏳ Сборка чистого билда игры (Tree-shaking без модулей Studio)...', '#56f0ff');

  try {
    const fetchText = async url => {
      const r = await fetch(url);
      return r.ok ? await r.text() : '';
    };

    const [
      baseCss,
      hudCss,
      stateJs,
      sceneJs,
      texJs,
      particleJs,
      audioJs,
      rigJs,
      worldJs,
      entityJs,
      tacticalAiJs,
      physJs,
      modeJs
    ] = await Promise.all([
      fetchText('./css/base.css'),
      fetchText('./css/hud.css'),
      fetchText('./src/core/State.js'),
      fetchText('./src/core/SceneManager.js'),
      fetchText('./src/core/TextureFactory.js'),
      fetchText('./src/core/ParticleSystem.js'),
      fetchText('./src/core/AudioEngine.js'),
      fetchText('./src/core/CharacterRig.js'),
      fetchText('./src/core/WorldRegistry.js'),
      fetchText('./src/core/EntityManager.js'),
      fetchText('./src/player/NpcTacticalAI.js'),
      fetchText('./src/player/PhysicsAndCombat.js'),
      fetchText(activeModeFile)
    ]);

    const stripESModules = code =>
      code
        .replace(/^\s*import\s+[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
        .replace(/^\s*export\s+default\s+/gm, '')
        .replace(/^\s*export\s+(const|let|var|function|async\s+function)\s+/gm, '$1 ')
        .replace(/^\s*export\s+\{[\s\S]*?\};?\s*$/gm, '');

    const bundledRuntimeJS = [
      stateJs,
      sceneJs,
      texJs,
      particleJs,
      audioJs,
      rigJs,
      worldJs,
      entityJs,
      tacticalAiJs,
      physJs,
      modeJs
    ].map(stripESModules).join('\n\n');

    const playOnlyBootCode = `
      (function(){
        window.__PLAY_ONLY_BUILD__ = true;
        window.__BAKED_SCENE_STATE__ = ${stateJSON};
        ${bundledRuntimeJS}

        S.gameMode = ${activeModeExport};
        S.gameMode.init();

        const data = window.__BAKED_SCENE_STATE__;
        if (data) {
          if (data.worldSettings) { Object.assign(S.worldSettings, data.worldSettings); updateSkybox(); }
          if (data.customDefaultStudDataURL) S.customDefaultStudDataURL = data.customDefaultStudDataURL;
          if (Array.isArray(data.savedCosmeticsLibrary)) S.savedCosmeticsLibrary = data.savedCosmeticsLibrary;
          if (Array.isArray(data.savedItemsLibrary)) S.savedItemsLibrary = data.savedItemsLibrary;
          if (Array.isArray(data.blocks) && data.blocks.length > 0) {
            for (const b of S.allBlocks) {
              scene.remove(b.m);
              if (b.cpVisualGroup) scene.remove(b.cpVisualGroup);
              if (b.haloSprite) scene.remove(b.haloSprite);
            }
            S.allBlocks.length = 0; S.blockIdCounter = 1;
            for (const sb of data.blocks) {
              const box = addSceneBlock(sb);
              box.m.scale.set(sb.w || 1, sb.h || 1, sb.d || 1);
              if (sb.cy !== undefined) box.m.position.set(sb.cx ?? sb.x ?? 0, sb.cy, sb.cz ?? sb.z ?? 0);
              box.m.rotation.set(sb.rx || 0, sb.ry || 0, sb.rz || 0);
              if (sb.colliderScale) box.colliderScale = sb.colliderScale;
              if (box.logicRuntime) box.logicRuntime.basePos = box.m.position.clone();
              syncBlockSpecialVisuals(box);
            }
            rebuildPhysicsArrays();
          }
          clearWorldItems();
          if (Array.isArray(data.worldItems)) {
            for (const sw of data.worldItems) {
              if (sw && sw.item) {
                spawnWorldItem(sw.item, sw.x ?? 0, sw.y ?? 1.5, sw.z ?? 0, 0, 0, 0, {
                  id: sw.id,
                  rotX: sw.rotX || 0,
                  rotY: sw.rotY || 0,
                  rotZ: sw.rotZ || 0,
                  scaleX: sw.scaleX || 1,
                  scaleY: sw.scaleY || 1,
                  scaleZ: sw.scaleZ || 1
                });
              }
            }
          }
          if (Array.isArray(data.customNPCs)) {
            for (const n of S.customNPCs) { scene.remove(n.rig.g); scene.remove(n.tag); }
            S.customNPCs.length = 0;
            for (const sn of data.customNPCs) spawnCustomNPC(Object.assign({}, sn.preset, sn));
          }
          if (data.playerData && S.player) {
            const pd = data.playerData;
            Object.assign(S.player, {
              name: pd.name || S.player.name, chat: pd.chat || '',
              hpEnabled: pd.hpEnabled !== undefined ? pd.hpEnabled : true,
              hp: pd.hp || 100, maxHp: pd.maxHp || 100, baseMaxHp: pd.maxHp || 100, meleeDamage: pd.meleeDamage || 25,
              colliderRadius: pd.colliderRadius || 0.42, colliderHeight: pd.colliderHeight || 2.5,
              walkSpeed: pd.walkSpeed || 7.6, jumpPower: pd.jumpPower || 10.2,
              inventory: Array.isArray(pd.inventory) ? pd.inventory.map(it => it ? normalizeItemData(it) : null) : [null,null,null,null,null,null],
              carriedItem: pd.carriedItem ? normalizeItemData(pd.carriedItem) : null
            });
            if (pd.x !== undefined) S.player.x = pd.x;
            if (pd.y !== undefined) S.player.y = pd.y;
            if (pd.z !== undefined) S.player.z = pd.z;
            if (pd.preset) {
              scene.remove(S.player.rig.g);
              S.player.preset = pd.preset;
              normalizeCharacterGripPoints(S.player.preset, pd);
              S.player.rig = createRobloxRig(S.player.preset, pd.scale || 1, false);
              S.player.rig.g.position.set(S.player.x, S.player.y, S.player.z);
              scene.add(S.player.rig.g);
              attachRigToEntity(S.player);
            } else {
              normalizeCharacterGripPoints(S.player.preset, pd);
              if (S.player.rig.syncGripSockets) S.player.rig.syncGripSockets(S.player.preset);
            }
            syncEntityHeldItemMesh(S.player);
            renderHotbarUI();
            refreshEntityTagWithHP(S.player);
            updateShopUI();
          }
        }

        const stick = $('stick'), knob = $('knob');
        cv.addEventListener('contextmenu', e => e.preventDefault());

        const setPlayLMBState = isDown => {
          if (isDown) {
            if (S.lmbDown) return;
            S.lmbDown = true;
            if (S.state !== 'play' || !S.player || S.playerDead) return;
            const held = getActiveHeldItem(S.player);
            if (held && held.useType === 'throwable' && !S.player.carriedItem) {
              if ((S.player.attackCooldown || 0) <= 0) { S.isChargingThrow = true; S.throwChargeT = 0; }
            } else {
              performPlayerMeleeAttack(false);
            }
          } else {
            if (!S.lmbDown && !S.isChargingThrow) return;
            S.lmbDown = false;
            if (S.isChargingThrow) releaseChargedThrow();
          }
        };

        const setPlayRMBState = isDown => {
          if (isDown) {
            if (S.isAimingRMB) return;
            S.isAimingRMB = true;
            if (S.player) syncEntityHeldItemMesh(S.player);
          } else {
            if (!S.isAimingRMB) return;
            S.isAimingRMB = false;
            if (S.player) syncEntityHeldItemMesh(S.player);
          }
        };

        addEventListener('keydown', e => {
          S.keys[e.code] = true;
          if (['Space','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.code) && S.state === 'play') e.preventDefault();
          if (e.code === 'KeyE') {
            if (S.player && S.player.carriedItem) { dropHeldOrCarriedItem(S.player, 1.4); return; }
            const nearItem = findNearestWorldItem(S.player, 4.2);
            if (nearItem) { pickupWorldItem(S.player, nearItem); return; }
            const nearest = findNearestKeyEBlock(S.player, 5.0);
            if (nearest) {
              if (nearest.logicData && nearest.logicData.trigger === 'keyE') { triggerBlockLogic(nearest, 'keyE'); return; }
              if (nearest.spawnerData && nearest.spawnerData.mode === 'keyE') { triggerBlockSpawner(nearest); return; }
            }
            if (S.gameMode && S.gameMode.onActionKeyE) S.gameMode.onActionKeyE();
          }
          if (e.code === 'KeyG' && S.player && !S.playerDead) dropHeldOrCarriedItem(S.player, 3.8);
          if (e.code === 'KeyF') performPlayerMeleeAttack(true);
          if (e.code === 'KeyR' && !e.repeat) {
            const held = S.player ? getActiveHeldItem(S.player) : null;
            if (held && held.useType === 'ranged') reloadActiveWeapon();
            else selectSlot(3);
          }
          if (e.code === 'Digit1') selectSlot(0);
          if (e.code === 'Digit2') selectSlot(1);
          if (e.code === 'Digit3') selectSlot(2);
          if (e.code === 'Digit4') selectSlot(3);
          if (e.code === 'Digit5') selectSlot(4);
          if (e.code === 'Digit6') selectSlot(5);
        });
        addEventListener('keyup', e => {
          S.keys[e.code] = false;
          if (e.code === 'KeyR' && S.isReloadingHold) cancelReloadHold(true);
        });

        document.addEventListener('mousedown', e => {
          if (S.state !== 'play') return;
          if (document.pointerLockElement !== cv) {
            if (e.target === cv) { initAudio(); try { cv.requestPointerLock(); } catch (_) {} }
            return;
          }
          if (e.button === 2 || (e.buttons & 2)) setPlayRMBState(true);
          if (e.button === 0 || (e.buttons & 1)) setPlayLMBState(true);
        });
        document.addEventListener('mouseup', e => {
          if (e.button === 0 || !(e.buttons & 1)) setPlayLMBState(false);
          if (e.button === 2 || !(e.buttons & 2)) setPlayRMBState(false);
        });

        document.addEventListener('pointerdown', e => {
          initAudio();
          if (e.pointerType === 'mouse') {
            if (S.state !== 'play' || e.target !== cv) return;
            if (document.pointerLockElement !== cv) { try { cv.requestPointerLock(); } catch (_) {} return; }
            if (e.button === 2 || (e.buttons & 2)) setPlayRMBState(true);
            if (e.button === 0 || (e.buttons & 1)) setPlayLMBState(true);
            return;
          }
          if (S.state !== 'play' || e.target.closest('button,.slot,#shopPanel,#topbar') || !$('menu').hidden) return;
          if (S.joy.id === null && e.clientX < S.SW * 0.45) {
            S.joy.id = e.pointerId; S.joy.ox = e.clientX; S.joy.oy = e.clientY; S.joy.vx = S.joy.vy = 0;
            stick.hidden = false; stick.style.left = S.joy.ox + 'px'; stick.style.top = S.joy.oy + 'px'; knob.style.transform = '';
          } else if (S.look.id === null) {
            S.look.id = e.pointerId; S.look.lx = e.clientX; S.look.ly = e.clientY;
          }
        });

        document.addEventListener('pointermove', e => {
          if (e.pointerType === 'mouse') {
            if (S.state !== 'play') return;
            if (document.pointerLockElement === cv) {
              if ((e.buttons & 2) && !S.isAimingRMB) setPlayRMBState(true);
              else if (!(e.buttons & 2) && S.isAimingRMB) setPlayRMBState(false);
              if ((e.buttons & 1) && !S.lmbDown) setPlayLMBState(true);
              else if (!(e.buttons & 1) && (S.lmbDown || S.isChargingThrow)) setPlayLMBState(false);
            }
            if (document.pointerLockElement === cv || e.buttons) {
              const sens = S.isAimingRMB ? 0.0018 : 0.0028;
              S.yaw -= (e.movementX || 0) * sens;
              S.pitch = clamp(S.pitch - (e.movementY || 0) * sens, -1.15, 0.65);
            }
            return;
          }
          if (e.pointerId === S.joy.id) {
            let dx = e.clientX - S.joy.ox, dy = e.clientY - S.joy.oy;
            const d = Math.hypot(dx, dy), max = 50;
            if (d > max) { dx = dx / d * max; dy = dy / d * max; }
            S.joy.vx = dx / max; S.joy.vy = dy / max;
            knob.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          } else if (e.pointerId === S.look.id) {
            S.yaw -= (e.clientX - S.look.lx) * 0.006;
            S.pitch = clamp(S.pitch - (e.clientY - S.look.ly) * 0.005, -1.15, 0.55);
            S.look.lx = e.clientX; S.look.ly = e.clientY;
          }
        });

        const endPtr = e => {
          if (e.button === 0 || !(e.buttons & 1)) setPlayLMBState(false);
          if (e.button === 2 || !(e.buttons & 2)) setPlayRMBState(false);
          if (e.pointerId === S.joy.id) { S.joy.id = null; S.joy.vx = S.joy.vy = 0; stick.hidden = true; }
          if (e.pointerId === S.look.id) S.look.id = null;
        };
        document.addEventListener('pointerup', endPtr);
        document.addEventListener('pointercancel', endPtr);
        $('bJump').addEventListener('pointerdown', e => { e.preventDefault(); S.btnJump = true; });
        $('bJump').addEventListener('pointerup', () => { S.btnJump = false; });

        $('startPlayOnlyBtn').onclick = () => {
          initAudio();
          resetAllLogicRuntime(true);
          S.state = 'play';
          $('menu').hidden = true;
          $('topbar').hidden = false;
          $('hotbar').hidden = false;
          if (coarse) $('touch').hidden = false;
          if (S.gameMode && S.gameMode.onEnterPlay) S.gameMode.onEnterPlay();
          updateShopUI();
        };

        let menuAngle = 0, lastTime = performance.now();
        function loop(now) {
          const dt = Math.min(0.05, (now - lastTime) / 1000); lastTime = now;
          if (S.state === 'play') update(dt);
          updateParticles(dt);
          updateAllPets(dt);
          if (S.state === 'play' && S.player) {
            syncPlayCameraToPlayer(S.player, dt);
          } else {
            menuAngle += dt * 0.18;
            camera.position.set(Math.cos(menuAngle) * 26, 14, -35 + Math.sin(menuAngle) * 18);
            camera.lookAt(0, 6, -40);
          }
          skyDome.position.copy(camera.position);
          updateWorldLights(camera.position);
          renderer.render(scene, camera);
          requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
      })();
    `;

    const gameTitle = S.currentProjectTitle || (S.gameMode ? S.gameMode.title : 'DebiX 3D Game');
    const gameHtml = `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${gameTitle} [Play-Only Build]</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Montserrat:wght@600;700;800;900&display=swap">
<style>
${baseCss}
${hudCss}
</style>
</head>
<body>
<canvas id="c"></canvas>
<div id="topbar" hidden>
  <div class="top-left">
    <div class="pill pos">ОЧЕРЕДЬ:<b id="posTxt">#30 / 30</b></div>
    <div class="pill hp" id="hpPill">❤️ HP:<b id="hpTxt">100 / 100</b></div>
    <div class="pill">💰 БАЛАНС:<b id="cashTxt">25 R$</b></div>
    <div class="pill">РЕБИРТЫ:<b id="rebTxt">0</b></div>
    <div class="pill eye-safe" id="eyePill">👁️ АРХАНГЕЛ ОТВЕРНУЛСЯ</div>
    <button class="btn-top" id="muteBtn" type="button">ЗВУК: 🟢</button>
  </div>
  <div id="leader">
    <h4><span>ОЧЕРЕДЬ В РАЙ</span><span>МЕСТО</span></h4>
    <div id="lbList"></div>
  </div>
</div>
<div id="shopPanel" hidden>
  <button class="sbtn act" id="btnCut" type="button"><span>⏩ Обогнать в очереди</span><span class="tag" id="costCut">35 R$</span></button>
  <button class="sbtn troll" id="btnPush" type="button"><span>🥊 Ударить / Толкнуть!</span><span class="tag" style="background:#111">УДАР</span></button>
  <button class="sbtn" id="buySpeed" type="button"><span>🌀 Пружина Скорости</span><span class="tag" id="costSpeed">80 R$</span></button>
  <button class="sbtn" id="buyGrav" type="button"><span>🚀 Пружина Прыжка</span><span class="tag" id="costGrav">120 R$</span></button>
  <button class="sbtn" id="buyHalo" type="button"><span>😇 VIP Нимб Донатера</span><span class="tag" id="costHalo">250 R$</span></button>
</div>
<div id="banner" hidden></div>
<div id="hint" hidden></div>
<div id="hotbar" hidden></div>
<div id="touch" hidden>
  <div id="stick" hidden><div id="knob"></div></div>
  <button class="tbtn" id="bJump" type="button">ПРЫЖОК</button>
  <button class="tbtn" id="bPush" type="button">УДАР</button>
  <button class="tbtn" id="bCut" type="button">ДЕЙСТВИЕ</button>
</div>
<div id="menu">
  <div class="modal" id="modalBox">
    <span class="badge" style="background:#00b06f">STANDALONE PLAY-ONLY GAME</span>
    <h1>${gameTitle.toUpperCase()}</h1>
    <p style="color:#cbd5e1;font-weight:700;font-size:13px;margin-bottom:16px">Автономный игровой билд (без кода 3D-Редактора).</p>
    <button class="play-btn" id="startPlayOnlyBtn" type="button">▶ ИГРАТЬ</button>
  </div>
</div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"><\/script>
<script>
${playOnlyBootCode}
<\/script>
</body>
</html>`;

    const blob = new Blob([gameHtml], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const safeName = gameTitle.replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
    a.download = `${safeName}_PlayOnly.html`;
    a.click();
    sfx.gate();
    showBanner('📦 Чистый игровой билд (без кода Studio) успешно собран и скачан!', '#00e676');
  } catch (err) {
    console.error(err);
    showBanner('Ошибка сборки билда: ' + err.message, '#ff3e3e');
  }
}

export function initSerializerEvents() {
  const studioHubBtn = $('studioHubBtn');
  if (studioHubBtn) {
    studioHubBtn.onclick = () => renderLauncherModal();
  }

  const topLeft = document.querySelector('#topbar .top-left');
  if (topLeft && !$('hubMenuBtn')) {
    const hubBtn = document.createElement('button');
    hubBtn.className = 'btn-top';
    hubBtn.id = 'hubMenuBtn';
    hubBtn.type = 'button';
    hubBtn.title = 'Вернуться в Хаб проектов';
    hubBtn.innerHTML = '🏠';
    topLeft.prepend(hubBtn);
    hubBtn.onclick = () => {
      try {
        if (document.pointerLockElement) document.exitPointerLock();
      } catch (_) {}
      renderLauncherModal();
    };
  }

  $('applyAndSaveBtn')?.addEventListener('click', () => {
    initAudio();
    const savedEntry = saveCurrentProjectSlot();
    sfx.gate();
    toggleStudioMode('play');
    showBanner(`✅ Проект «${savedEntry.title}» сохранён в слоты и применён!`, '#00e676');
  });

  $('exportHtmlBtn')?.addEventListener('click', exportFullStudioHtml);
  $('resetSavedBtn')?.addEventListener('click', resetAllSavedProjects);
}