// src/player/PlayerController.js
import { S, $, clamp, coarse, showBanner } from '../core/State.js';
import { cv, renderer, scene, camera, skyDome } from '../core/SceneManager.js';
import { initAudio, sfx, syncAudioWithWorldSettings } from '../core/AudioEngine.js';
import { updateParticles } from '../core/ParticleSystem.js';
import { updateWorldLights, resetAllLogicRuntime } from '../core/WorldRegistry.js';
import { initSerializerEvents, loadSavedStateOnBoot, switchGameTemplate } from '../core/Serializer.js';
import {
  selectSlot,
  updateShopUI,
  getActiveHeldItem,
  pickupWorldItem,
  dropHeldOrCarriedItem,
  syncEntityHeldItemMesh,
  refreshEntityTagWithHP
} from '../core/EntityManager.js';
import {
  update,
  performPlayerMeleeAttack,
  triggerBlockSpawner,
  triggerBlockLogic,
  findNearestKeyEBlock,
  findNearestWorldItem,
  findNearestCarryablePhysicsBlock,
  pickupPhysicsBlock,
  dropCarriedPhysicsBlock,
  reloadActiveWeapon,
  cancelReloadHold,
  releaseChargedThrow,
  syncPlayCameraToPlayer,
  renderPhysicsConstraintsVisuals
} from './PhysicsAndCombat.js';
import { updateLiquidCameraFilter, resetLiquidCameraFilter } from './LiquidCameraFilter.js';
import {
  tControls,
  raycaster,
  mouseNDC,
  initStudioController,
  toggleStudioMode,
  cleanupStudioVisualsForPlay,
  setGizmoMode,
  toggleGizmoSpace,
  focusOnSelected,
  deleteSelected,
  duplicateSelected,
  selectEditorObject,
  undoLastStudioAction,
  toggleGridSnap,
  updateStudioGrid
} from '../studio/StudioController.js';
import {
  initHierarchyAndSpawn,
  getTopMostParentEditorRef,
  getKeyFromEditorRef,
  isDescendantOf,
  compileSceneHierarchyToItemData,
  getAllSceneDescendants
} from '../studio/HierarchyAndSpawn.js';
import {
  updateAllPets,
  normalizeItemData,
  EMOTES_CATALOG,
  triggerEntityEmote,
  stopEntityEmote
} from '../core/CharacterRig.js';
import { initPaintStudio2D, isPaintModalOpen } from '../studio/PaintStudio2D.js';
import {
  initMultiplayerSystem,
  toggleMultiplayerModal,
  broadcastMultiplayerPacket
} from '../core/MultiplayerManager.js';

let menuAngle = 0;

export function syncCursorToggleUI() {
  const btn = $('cursorToggleBtn');
  if (!btn) return;
  const isLocked = document.pointerLockElement === cv;
  btn.textContent = isLocked ? '🖱️ КУРСОР [TAB]' : '🖱️ КУРСОР: СВОБОДЕН [TAB]';
  btn.classList.toggle('cursor-free', !isLocked);
}

export function togglePlayCursorLock(forceUnlock = null) {
  if (S.state !== 'play') return;
  const isLocked = document.pointerLockElement === cv;
  const shouldUnlock = forceUnlock !== null ? forceUnlock : isLocked;

  if (shouldUnlock) {
    S.cursorUnlockedByTab = true;
    S.lmbDown = false;
    S.isAimingRMB = false;
    try {
      if (document.pointerLockElement === cv) document.exitPointerLock();
    } catch (_) {}
    sfx.click?.();
  } else {
    S.cursorUnlockedByTab = false;
    try {
      cv.requestPointerLock();
    } catch (_) {}
    sfx.gizmoTick?.();
  }
  setTimeout(syncCursorToggleUI, 30);
}

export function syncEmotesPanelActiveState() {
  const grid = $('emotesGrid');
  const stopBtn = $('stopEmoteBtn');
  const activeId = S.player?.activeEmote || null;
  if (grid) {
    grid.querySelectorAll('.emote-card').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.emote === activeId);
    });
  }
  if (stopBtn) {
    stopBtn.hidden = !activeId;
  }
}

export function playPlayerEmote(emoteId) {
  if (S.state !== 'play' || !S.player || S.playerDead) return;
  initAudio();
  const prevEmote = S.player.activeEmote;
  const def = triggerEntityEmote(S.player, emoteId);
  broadcastMultiplayerPacket({ type: 'emote', emoteId: S.player.activeEmote || null });

  if (!def) {
    if (prevEmote === 'fake_die') sfx.coil?.();
    else sfx.click?.();
    syncEmotesPanelActiveState();
    return;
  }

  if (def.chat) {
    S.player.chat = def.chat;
    S.player.chatT = 3.2;
    refreshEntityTagWithHP(S.player);
  }

  if (emoteId === 'fake_die') sfx.oof?.();
  else if (emoteId === 'yes') sfx.pickup?.();
  else if (emoteId === 'no') sfx.emoteNo?.();
  else if (emoteId === 'wave') sfx.emoteWave?.();
  else if (emoteId === 'shrug') sfx.jump?.();
  else if (emoteId === 'clap') sfx.clap?.();
  else if (emoteId === 'laugh') sfx.laugh?.();
  else if (emoteId === 'dab') sfx.slap?.();
  else if (emoteId === 'cry') sfx.emoteNo?.();
  else if (emoteId === 'angry') sfx.hit?.();
  else if (emoteId.startsWith('dance')) sfx.coil?.();
  else sfx.spawnPop?.();

  syncEmotesPanelActiveState();
}

export function toggleEmotesPanel(forceOpen = null) {
  const panel = $('emotesPanel');
  if (!panel || S.state !== 'play') return;
  const nextOpen = forceOpen !== null ? forceOpen : panel.hidden;
  panel.hidden = !nextOpen;
  sfx.click?.();

  if (nextOpen) {
    if (document.pointerLockElement === cv) {
      togglePlayCursorLock(true);
    }
    syncEmotesPanelActiveState();
  }
}

export function initEmotesHUD() {
  const grid = $('emotesGrid');
  if (grid && !grid.dataset.inited) {
    grid.dataset.inited = '1';
    grid.innerHTML = EMOTES_CATALOG.map(em => `
      <button class="emote-card" data-emote="${em.id}" type="button" title="${em.name}">
        <span class="em-ico">${em.icon}</span>
        <span>${em.name}</span>
      </button>
    `).join('');

    grid.querySelectorAll('.emote-card').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        playPlayerEmote(btn.dataset.emote);
      };
    });
  }

  $('emotesToggleBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    toggleEmotesPanel();
  });
  $('closeEmotesBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    toggleEmotesPanel(false);
  });
  $('stopEmoteBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    if (S.player) {
      const wasFakeDie = S.player.activeEmote === 'fake_die';
      stopEntityEmote(S.player);
      if (wasFakeDie) sfx.coil?.();
      else sfx.click?.();
      syncEmotesPanelActiveState();
    }
  });
  $('cursorToggleBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    togglePlayCursorLock();
  });

  document.addEventListener('pointerlockchange', () => {
    syncCursorToggleUI();
  });
}

function ensureGmodToolHUD() {
  let el = $('gmodToolHUD');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'gmodToolHUD';
  el.hidden = true;
  el.style.cssText =
    'position:fixed;left:50%;bottom:136px;transform:translateX(-50%);background:rgba(12,16,26,0.94);border:2px solid #56f0ff;border-radius:12px;padding:8px 14px;z-index:20;color:#fff;font:700 11px var(--f);display:flex;flex-direction:column;gap:5px;min-width:320px;box-shadow:0 8px 24px rgba(0,0,0,0.6)';
  el.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span id="gmToolModeTitle" style="font-weight:900;color:#56f0ff">🔧 ИНСТРУМЕНТ: 🔗 ВЕРЁВКА (ROPE)</span>
      <span style="font-size:10px;color:#ffce3a">[ПКМ] Сменить режим · [T] Закрыть</span>
    </div>
    <div id="gmToolRopeParams" style="display:flex;align-items:center;gap:7px;flex-wrap:wrap;font-size:10.5px;color:#cbd5e1">
      <label>Длина: <input type="number" id="gmRopeLenInp" step="0.5" min="0" max="50" value="0" style="width:44px;background:#1a2234;color:#fff;border:1px solid #3b4d6b;border-radius:4px;padding:2px 4px" title="0 = Авто по текущему расстоянию"></label>
      <label>Пруж: <input type="number" id="gmRopeSpringInp" step="0.1" min="0" max="1" value="0.25" style="width:44px;background:#1a2234;color:#fff;border:1px solid #3b4d6b;border-radius:4px;padding:2px 4px"></label>
      <label>Толщ: <input type="number" id="gmRopeThickInp" step="0.02" min="0.02" max="0.6" value="${S.gmodTool.ropeThickness ?? 0.08}" style="width:46px;background:#1a2234;color:#fff;border:1px solid #3b4d6b;border-radius:4px;padding:2px 4px"></label>
      <label style="display:flex;align-items:center;gap:3px">Цвет: <input type="color" id="gmRopeColInp" value="${S.gmodTool.ropeColor || '#ffce3a'}" style="width:22px;height:20px;border:none;background:none;cursor:pointer"></label>
    </div>
    <div id="gmToolStatusTxt" style="font-size:10.5px;color:#00e676">[ЛКМ] Выбери 1-й объект · [R] Удалить связи с объекта</div>
  `;
  document.body.appendChild(el);

  $('gmRopeLenInp').oninput = e => { S.gmodTool.ropeLength = Math.max(0, +e.target.value || 0); };
  $('gmRopeSpringInp').oninput = e => { S.gmodTool.springiness = clamp(+e.target.value || 0, 0, 1); };
  $('gmRopeThickInp').oninput = e => { S.gmodTool.ropeThickness = clamp(+e.target.value || 0.08, 0.015, 0.6); };
  $('gmRopeColInp').oninput = e => { S.gmodTool.ropeColor = e.target.value || '#ffce3a'; };
  return el;
}

export function syncGmodToolHUD() {
  const el = ensureGmodToolHUD();
  if (!S.gmodTool?.active || S.state !== 'play') {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const gt = S.gmodTool;
  const isRope = gt.mode === 'rope';
  $('gmToolModeTitle').textContent = isRope
    ? '🔧 ИНСТРУМЕНТ: 🔗 ВЕРЁВКА (ROPE)'
    : '🔧 ИНСТРУМЕНТ: 🔥 СВАРКА (WELD)';
  $('gmToolModeTitle').style.color = isRope ? '#ffce3a' : '#00e676';
  $('gmToolRopeParams').style.display = isRope ? 'flex' : 'none';
  if ($('gmRopeLenInp')) $('gmRopeLenInp').value = S.gmodTool.ropeLength;
  if ($('gmRopeSpringInp')) $('gmRopeSpringInp').value = S.gmodTool.springiness;
  if ($('gmRopeThickInp')) $('gmRopeThickInp').value = S.gmodTool.ropeThickness;
  if ($('gmRopeColInp')) $('gmRopeColInp').value = S.gmodTool.ropeColor;
  if (gt.firstHit?.box) {
    $('gmToolStatusTxt').textContent = `🎯 Выбран #1: «${gt.firstHit.box.label}» ➔ Нажми [ЛКМ] по 2-му объекту!`;
    $('gmToolStatusTxt').style.color = '#ffce3a';
  } else {
    $('gmToolStatusTxt').textContent = '[ЛКМ] Выбери 1-й объект · [ПКМ] Верёвка/Сварка · [R] Разъединить объект';
    $('gmToolStatusTxt').style.color = '#00e676';
  }
}

const _gmodRaycaster = new THREE.Raycaster();

function raycastBlockFromPlayCamera(maxDist = 28) {
  const cp = Math.cos(S.pitch);
  const fwd = new THREE.Vector3(-Math.sin(S.yaw) * cp, Math.sin(S.pitch), -Math.cos(S.yaw) * cp).normalize();
  _gmodRaycaster.set(camera.position, fwd);
  _gmodRaycaster.near = 0.2;
  _gmodRaycaster.far = maxDist;

  const meshes = [];
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (b && b.m && !b._depletedDisabled && b.matterState !== 'liquid') {
      meshes.push(b.m);
    }
  }
  const hits = _gmodRaycaster.intersectObjects(meshes, false);
  if (hits.length === 0) return null;
  const hit = hits[0];
  const box = hit.object?.userData?.editorRef?.box;
  if (!box) return null;
  const localPt = hit.point.clone();
  box.m.worldToLocal(localPt);
  return { box, worldPoint: hit.point.clone(), localPoint: { x: localPt.x, y: localPt.y, z: localPt.z } };
}

function handleGmodToolTrigger(action = 'lmb') {
  const gt = S.gmodTool;
  if (!gt || !gt.active || S.state !== 'play') return false;

  if (action === 'rmb') {
    gt.mode = gt.mode === 'rope' ? 'weld' : 'rope';
    gt.firstHit = null;
    sfx.gizmoTick?.();
    syncGmodToolHUD();
    return true;
  }

  const hit = raycastBlockFromPlayCamera(28);
  if (action === 'clear') {
    if (!hit) {
      gt.firstHit = null;
      syncGmodToolHUD();
      return true;
    }
    const targetBox = hit.box;
    let removed = 0;
    if (Array.isArray(S.physicsConstraints)) {
      for (let i = S.physicsConstraints.length - 1; i >= 0; i--) {
        const c = S.physicsConstraints[i];
        if (c.blockAId === targetBox.id || c.blockBId === targetBox.id) {
          S.physicsConstraints.splice(i, 1);
          removed++;
        }
      }
    }
    if (targetBox.parentKey && targetBox.weldToParent !== false) {
      targetBox.weldToParent = false;
      removed++;
    }
    gt.firstHit = null;
    sfx.oof?.();
    showBanner(`🔓 Удалено связей/сварки с «${targetBox.label}»: ${removed}`, '#ff9f43');
    syncGmodToolHUD();
    return true;
  }

  if (!hit) {
    sfx.oof?.();
    showBanner('⚠️ Наведи прицел на любой блок!', '#ffce3a');
    return true;
  }

  if (!gt.firstHit || gt.firstHit.box._depletedDisabled) {
    gt.firstHit = hit;
    sfx.click?.();
    syncGmodToolHUD();
    return true;
  }

  const hitA = gt.firstHit;
  const hitB = hit;
  gt.firstHit = null;

  if (hitA.box === hitB.box) {
    showBanner('⚠️ Выбери два разных объекта для соединения!', '#ffce3a');
    syncGmodToolHUD();
    return true;
  }

  if (!Array.isArray(S.physicsConstraints)) S.physicsConstraints = [];
  const dist = hitA.worldPoint.distanceTo(hitB.worldPoint);
  const ropeLen = gt.ropeLength > 0.1 ? gt.ropeLength : Math.max(0.5, Number(dist.toFixed(2)));

  S.physicsConstraints.push({
    id: 'cstr_' + Date.now() + '_' + Math.floor(Math.random() * 999),
    type: gt.mode,
    blockAId: hitA.box.id,
    blockBId: hitB.box.id,
    localAnchorA: hitA.localPoint,
    localAnchorB: hitB.localPoint,
    maxLength: ropeLen,
    springiness: clamp(Number(gt.springiness) ?? 0.25, 0, 1),
    thickness: clamp(Number(gt.ropeThickness) || 0.08, 0.015, 0.6),
    color: gt.ropeColor || '#ffce3a',
    _createdInPlay: true
  });

  sfx.coil?.();
  showBanner(
    gt.mode === 'rope'
      ? `🔗 Связано верёвкой: «${hitA.box.label}» ⇄ «${hitB.box.label}» (Длина: ${ropeLen}м, Пруж: ${gt.springiness})`
      : `🔥 Приварено намертво: «${hitA.box.label}» ➕ «${hitB.box.label}»!`,
    '#00e676'
  );
  syncGmodToolHUD();
  return true;
}

export function handleActionKeyE() { 
  if (S.state !== 'play' || !S.player || S.playerDead) return;
  const player = S.player;

  // 0. Если игрок несёт физический блок — клавиша [E] аккуратно опускает его на землю
  if (player.carriedPhysicsBlock) {
    dropCarriedPhysicsBlock(player, 1.8);
    return;
  }

  // 1. Если игрок несёт 2-ручный объект — клавиша [E] аккуратно ставит его на землю
  if (player.carriedItem) {
    dropHeldOrCarriedItem(player, 1.4);
    return;
  }

  // 2. Подбор ближайшего предмета / контейнера с земли
  const nearItem = findNearestWorldItem(player, 4.2);
  if (nearItem) {
    pickupWorldItem(player, nearItem);
    return;
  }

  // 2.5. Захват ближайшего физического блока (Rigidbody) по весу
  const nearPhysBlk = findNearestCarryablePhysicsBlock(player, 4.2);
  if (nearPhysBlk) {
    pickupPhysicsBlock(player, nearPhysBlk);
    return;
  }

  // 3. Интерактивные объекты сцены (Взаимодействие [E], Движение, Связи, Модульный Предмет или Спавнер)
  const nearest = findNearestKeyEBlock(player, 5.0);
  if (nearest) {
    // Если на объекте сцены висит компонент «⚔️ Предмет / Оружие» — подбираем его в хотбар или в 2 руки!
    if (nearest.components?.item?.enabled) {
      const compiled = compileSceneHierarchyToItemData(nearest);
      const copy = normalizeItemData(JSON.parse(JSON.stringify(compiled)));
      if (copy.holdMode === 'carried') {
        player.carriedItem = copy;
        syncEntityHeldItemMesh(player);
        renderHotbarUI();
        showBanner(`📦 Подобрано в 2 руки: «${copy.name}»!`, '#00e676');
      } else {
        if (!Array.isArray(player.inventory)) player.inventory = [null, null, null, null, null, null];
        let slot = player.inventory.findIndex((x, idx) => idx > 0 && !x);
        if (slot === -1) slot = 1;
        player.inventory[slot] = copy;
        S.activeSlot = slot;
        syncEntityHeldItemMesh(player);
        renderHotbarUI();
        showBanner(`${copy.icon || '🗡️'} Подобрано «${copy.name}» (Слот #${slot + 1})!`, '#00e676');
      }
      // Скрываем объект и его дочерние части в мире на время игровой сессии и синхронизируем экипировку по сети
      nearest._depletedDisabled = true;
      nearest.m.visible = false;
      for (const d of getAllSceneDescendants(`block:${nearest.id}`)) {
        if (d.kind === 'block' && d.obj?.m) {
          d.obj._depletedDisabled = true;
          d.obj.m.visible = false;
        }
      }
      if (window.__debixSendImmediateFullState) {
        window.__debixSendImmediateFullState();
      }
      return;
    }

    if (triggerBlockLogic(nearest, 'keyE')) {
      return;
    }
    if (nearest.spawnerData && nearest.spawnerData.mode === 'keyE') {
      triggerBlockSpawner(nearest);
      showBanner(`⚙️ Активирован спавнер «${nearest.label}»!`, '#56f0ff');
      return;
    }
  }

  if (S.gameMode && S.gameMode.onActionKeyE) {
    S.gameMode.onActionKeyE();
  }
}

export function updateEditorCamera(dt) {
  if (!S.rmbDown) return;
  const spd = (S.keys.ShiftLeft || S.keys.ShiftRight) ? 34 : 15;
  const fwd = new THREE.Vector3(
    -Math.sin(S.edYaw) * Math.cos(S.edPitch),
    Math.sin(S.edPitch),
    -Math.cos(S.edYaw) * Math.cos(S.edPitch)
  );
  const right = new THREE.Vector3(Math.cos(S.edYaw), 0, -Math.sin(S.edYaw));

  if (S.keys.KeyW || S.keys.ArrowUp) S.edCamPos.addScaledVector(fwd, spd * dt);
  if (S.keys.KeyS || S.keys.ArrowDown) S.edCamPos.addScaledVector(fwd, -spd * dt);
  if (S.keys.KeyD || S.keys.ArrowRight) S.edCamPos.addScaledVector(right, spd * dt);
  if (S.keys.KeyA || S.keys.ArrowLeft) S.edCamPos.addScaledVector(right, -spd * dt);
  if (S.keys.KeyE || S.keys.Space) S.edCamPos.y += spd * dt;
  if (S.keys.KeyQ) S.edCamPos.y -= spd * dt;
}

export function render(dt) {
  const player = S.player;
  if (S.state === 'play' && player) {
    if (S.playerDead && S.worldSettings.respawnMode === 'spectator') {
      const cp = Math.cos(S.spectatorPitch);
      const lookTarget = new THREE.Vector3(
        S.spectatorPos.x - Math.sin(S.spectatorYaw) * cp,
        S.spectatorPos.y + Math.sin(S.spectatorPitch),
        S.spectatorPos.z - Math.cos(S.spectatorYaw) * cp
      );
      camera.position.copy(S.spectatorPos);
      camera.lookAt(lookTarget);
    } else {
      syncPlayCameraToPlayer(player, dt);
    }
    updateLiquidCameraFilter(player, dt);
  } else if (S.state === 'edit') {
    resetLiquidCameraFilter();
    updateEditorCamera(dt);
    const cp = Math.cos(S.edPitch);
    const lookTarget = new THREE.Vector3(
      S.edCamPos.x - Math.sin(S.edYaw) * cp,
      S.edCamPos.y + Math.sin(S.edPitch),
      S.edCamPos.z - Math.cos(S.edYaw) * cp
    );
    camera.position.copy(S.edCamPos);
    camera.lookAt(lookTarget);
    updateStudioGrid(dt);
  } else {
    resetLiquidCameraFilter();
    menuAngle += dt * 0.18;
    camera.position.set(
      Math.cos(menuAngle) * 26,
      14,
      -35 + Math.sin(menuAngle) * 18
    );
    camera.lookAt(0, 6, -40);
  }
  skyDome.position.copy(camera.position);
  updateWorldLights(camera.position);
  renderer.render(scene, camera);
  renderPhysicsConstraintsVisuals();
  if (S.state === 'play') {
    syncGmodToolHUD();
  }
}

export function initInputControls() {
  const stick = $('stick');
  const knob = $('knob');

  addEventListener('keydown', e => {
    if (e.target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    S.keys[e.code] = true;
    if (e.code === 'F2') {
      e.preventDefault();
      resetAllLogicRuntime(false);
      toggleStudioMode();
      return;
    }

    if (e.code === 'Tab' && S.state === 'play' && !e.repeat) {
      e.preventDefault();
      togglePlayCursorLock();
      return;
    }

    if (e.code === 'KeyB' && S.state === 'play' && !e.repeat) {
      e.preventDefault();
      toggleEmotesPanel();
      return;
    }

    if (e.code === 'KeyM' && S.state === 'play' && !e.repeat) {
      e.preventDefault();
      if (document.pointerLockElement === cv) togglePlayCursorLock(true);
      toggleMultiplayerModal();
      return;
    }

    if (S.state === 'edit') {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        undoLastStudioAction();
        return;
      }
      if (isPaintModalOpen()) return;

      if (!S.rmbDown && !S.mmbDown) {
        if (e.code === 'KeyW') { sfx.gizmoTick(); setGizmoMode('translate'); }
        if (e.code === 'KeyE') { sfx.gizmoTick(); setGizmoMode('rotate'); }
        if (e.code === 'KeyR') { sfx.gizmoTick(); setGizmoMode('scale'); }
        if (e.code === 'KeyX') { sfx.gizmoTick(); toggleGizmoSpace(); }
        if (e.code === 'KeyG') { sfx.gizmoTick(); toggleGridSnap(); }
        if (e.code === 'KeyF') { sfx.click(); focusOnSelected(); }
        if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected();
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') {
          e.preventDefault();
          sfx.spawnPop();
          duplicateSelected();
        }
      }
      return;
    }

    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && S.state === 'play') {
      e.preventDefault();
    }
    if (e.code === 'KeyE') handleActionKeyE();
    if (e.code === 'KeyV' && !e.repeat && S.state === 'play' && S.player && !S.playerDead) {
      const isSandbox = !S.gameMode || S.gameMode.id === 'sandbox_template' || S.worldSettings.allowFlight;
      if (isSandbox) {
        S.player.isFlying = !S.player.isFlying;
        S.player.vy = 0;
        sfx.coil?.();
        showBanner(
          S.player.isFlying
            ? '🕊️ Режим полёта ВКЛ [V]! WASD — лететь · Пробел — вверх · Q/C — вниз · Shift — ускорение'
            : '👟 Режим полёта ВЫКЛ [V]',
          S.player.isFlying ? '#56f0ff' : '#ffce3a'
        );
      } else {
        showBanner('⚠️ Полёт на [V] доступен только в режиме «Песочница»!', '#ffce3a');
      }
    }
    if (e.code === 'KeyG') {
      if (S.player && !S.playerDead) {
        if (S.player.carriedPhysicsBlock) dropCarriedPhysicsBlock(S.player, 4.2);
        else dropHeldOrCarriedItem(S.player, 3.8);
      }
    } 
    if (e.code === 'KeyT' && !e.repeat && S.state === 'play' && S.player && !S.playerDead) {
      if (!S.gmodTool) {
        S.gmodTool = { active: false, mode: 'rope', ropeLength: 4.5, springiness: 0.25, firstHit: null };
      }
      S.gmodTool.active = !S.gmodTool.active;
      S.gmodTool.firstHit = null;
      const ch = $('crosshairHUD');
      if (ch) ch.hidden = !S.gmodTool.active && !getActiveHeldItem(S.player);
      sfx.coil?.();
      syncGmodToolHUD();
      showBanner(
        S.gmodTool.active
          ? '🔧 Инструмент Сварки и Верёвок ВКЛ [T]! [ЛКМ] Соединить · [ПКМ] Режим · [R] Разъединить'
          : '🔧 Инструмент Сварки и Верёвок ВЫКЛ [T]',
        S.gmodTool.active ? '#56f0ff' : '#ffce3a'
      );
    }
    if (e.code === 'KeyF') performPlayerMeleeAttack(true);
    if (e.code === 'KeyR' && !e.repeat) {
      if (S.gmodTool?.active && S.player && !S.playerDead) {
        handleGmodToolTrigger('clear');
      } else {
        const held = S.player ? getActiveHeldItem(S.player) : null;
        if (held && held.useType === 'ranged') {
          reloadActiveWeapon();
        } else {
          selectSlot(3);
        }
      }
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
    if (e.code === 'KeyR' && S.isReloadingHold) {
      cancelReloadHold(true);
    }
  });

  // Идемпотентные переключатели ЛКМ и ПКМ в режиме Игры:
  // позволяют стрелять и заряжать броски по ЛКМ во время удержания ПКМ (прицеливания),
  // обходя ограничение PointerEvents, когда второй клик мыши не генерирует новый pointerdown.
  const setPlayLMBState = isDown => {
    if (isDown) {
      if (S.lmbDown) return;
      S.lmbDown = true;
      if (S.state !== 'play' || !S.player || S.playerDead) return;
      if (S.gmodTool?.active) {
        handleGmodToolTrigger('lmb');
        return;
      }
      const held = getActiveHeldItem(S.player);
      if (held && held.useType === 'throwable' && !S.player.carriedItem) {
        if ((S.player.attackCooldown || 0) <= 0) {
          S.isChargingThrow = true;
          S.throwChargeT = 0;
        }
      } else {
        performPlayerMeleeAttack(false);
      }
    } else {
      if (!S.lmbDown && !S.isChargingThrow) return;
      S.lmbDown = false;
      if (S.isChargingThrow) {
        releaseChargedThrow();
      }
    }
  };

  const setPlayRMBState = isDown => {
    if (isDown && S.state === 'play' && S.gmodTool?.active) {
      handleGmodToolTrigger('rmb');
      return;
    }
    if (isDown) {
      if (S.isAimingRMB) return;
      S.isAimingRMB = true;
      if (S.player) syncEntityHeldItemMesh(S.player);
      if (window.__debixSendImmediateFullState) window.__debixSendImmediateFullState();
    } else {
      if (!S.isAimingRMB) return;
      S.isAimingRMB = false;
      if (S.player) syncEntityHeldItemMesh(S.player);
      if (window.__debixSendImmediateFullState) window.__debixSendImmediateFullState();
    }
  };

  cv.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('mousedown', e => {
    if (e.button === 1 && e.target === cv) e.preventDefault();
    if (S.state !== 'play') return;
    if (document.pointerLockElement !== cv) {
      if (e.target === cv) {
        initAudio();
        syncAudioWithWorldSettings();
        // Если курсор разблокирован через TAB: ПКМ вращает камеру (как в Roblox), а ЛКМ по сцене закрывает панель жестов
        if (S.cursorUnlockedByTab) {
          if (e.button === 2) S.rmbDown = true;
          else if (e.button === 0 && $('emotesPanel') && !$('emotesPanel').hidden) {
            toggleEmotesPanel(false);
          }
          return;
        }
        try {
          cv.requestPointerLock();
        } catch (_) {}
      }
      return;
    }
    if (e.button === 2 || (e.buttons & 2)) {
      if (S.gmodTool?.active && S.player && !S.playerDead) {
        e.preventDefault();
        handleGmodToolTrigger('rmb');
      } else {
        setPlayRMBState(true);
      }
    }
    if (e.button === 0 || (e.buttons & 1)) {
      if (S.gmodTool?.active && S.player && !S.playerDead) {
        e.preventDefault();
        handleGmodToolTrigger('lmb');
      } else {
        setPlayLMBState(true);
      }
    }
  });

  document.addEventListener('mouseup', e => {
    if (e.button === 0 || !(e.buttons & 1)) {
      setPlayLMBState(false);
    }
    if (e.button === 2 || !(e.buttons & 2)) {
      S.rmbDown = false;
      setPlayRMBState(false);
    }
    if (e.button === 1) {
      S.mmbDown = false;
    }
  });

  cv.addEventListener('wheel', e => {
    if (S.gmodTool?.active && S.gmodTool.mode === 'rope' && S.state === 'play') {
      e.preventDefault();
      S.gmodTool.ropeLength = clamp((S.gmodTool.ropeLength || 4.5) - Math.sign(e.deltaY) * 0.5, 0, 50);
      if ($('gmRopeLenInp')) $('gmRopeLenInp').value = S.gmodTool.ropeLength;
      syncGmodToolHUD();
      return;
    }
    if (S.state !== 'edit') return;
    const fwd = new THREE.Vector3(
      -Math.sin(S.edYaw) * Math.cos(S.edPitch),
      Math.sin(S.edPitch),
      -Math.cos(S.edYaw) * Math.cos(S.edPitch)
    );
    S.edCamPos.addScaledVector(fwd, -Math.sign(e.deltaY) * 2.8);
  }, { passive: true });

  const isObjVisibleInHierarchy = obj => {
    let cur = obj;
    while (cur) {
      if (cur.visible === false) return false;
      cur = cur.parent;
    }
    return true;
  };

  let editPointerDownPos = { x: 0, y: 0 };
  let editPointerDownBtn = -1;
  let isGizmoDragging = false;

  tControls.addEventListener('dragging-changed', e => {
    isGizmoDragging = !!e.value;
  });

  function handleStudioSelectionClick(e) {
    const rect = cv.getBoundingClientRect();
    mouseNDC.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    mouseNDC.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.near = 0.05;
    raycaster.far = Infinity;
    raycaster.setFromCamera(mouseNDC, camera);

    const pickables = [];
    for (const b of S.allBlocks) {
      pickables.push(b.m);
      if (Array.isArray(b._motionWaypointProxies)) {
        for (const wpProxy of b._motionWaypointProxies) {
          pickables.push(wpProxy);
        }
      }
    }
    for (const wi of S.worldItems) pickables.push(wi.group);
    if (S.player) {
      if (!S.queueLine.includes(S.player)) pickables.push(S.player.rig.g);
      if (S.player.tag) pickables.push(S.player.tag);
    }
    for (const ent of S.queueLine) {
      pickables.push(ent.rig.g);
      if (ent.tag) pickables.push(ent.tag);
    }
    for (const n of S.customNPCs) {
      pickables.push(n.rig.g);
      if (n.tag) pickables.push(n.tag);
    }
    if (S.archangelEnt) {
      pickables.push(S.archangelEnt.rig.g);
      if (S.archangelEnt.tag) pickables.push(S.archangelEnt.tag);
    }
    if (S.studioMannequinRig && S.itemStudioOpen) {
      pickables.push(S.studioMannequinRig.g);
    }
    for (const emp of S.emptyObjects || []) {
      if (emp.group) pickables.push(emp.group);
    }

    const rawHits = raycaster.intersectObjects(pickables, true);
    const hits = rawHits.filter(h => {
      if (!isObjVisibleInHierarchy(h.object)) return false;
      let cur = h.object;
      while (cur) {
        if (cur.userData?.editorLocked) return false;
        cur = cur.parent;
      }
      return true;
    });

    if (hits.length > 0) {
      const markerHit = hits.find(
        h =>
          (h.object.userData?.isGripMarker ||
           h.object.userData?.isMuzzleMarker ||
           h.object.userData?.isCharHandGripMarker ||
           h.object.userData?.isCharCarryGripMarker) &&
          h.object.visible !== false &&
          h.distance <= hits[0].distance + 0.45
      );

      const cosmeticHit = hits.find(h => {
        let cur = h.object;
        while (cur) {
          if (cur.userData && cur.userData.cosmeticItem) return true;
          cur = cur.parent;
        }
        return false;
      });

      let obj;
      if (markerHit) {
        obj = markerHit.object;
      } else if (cosmeticHit && cosmeticHit.distance <= hits[0].distance + 0.6) {
        obj = cosmeticHit.object;
      } else {
        obj = hits[0].object;
      }

      if (obj.userData?.isCharHandGripMarker || obj.userData?.isCharCarryGripMarker) {
        let p = obj;
        while (p && !(p.userData && p.userData.editorRef && p.userData.editorRef.kind === 'char')) {
          p = p.parent;
        }
        if (p && p.userData.editorRef) {
          selectEditorObject({
            kind: 'char',
            ent: p.userData.editorRef.ent,
            editMode: obj.userData.isCharHandGripMarker ? 'hand_grip' : 'carry_grip',
            inStudio: S.itemStudioOpen
          });
          return;
        }
      }

      // Клик по аксессуару: в мире 1-й клик выбирает весь аксессуар (root), повторный или в 3D Студии — конкретную деталь
      let cosObj = obj;
      while (cosObj && !(cosObj.userData && cosObj.userData.cosmeticItem)) {
        cosObj = cosObj.parent;
      }
      if (cosObj && cosObj.userData && cosObj.userData.cosmeticItem) {
        let p = cosObj;
        while (p && !(p.userData && p.userData.editorRef)) p = p.parent;
        const ownerEnt = (p && p.userData?.editorRef?.ent) || (S.selectedRef && S.selectedRef.ent) || S.player;
        if (ownerEnt) {
          const item = cosObj.userData.cosmeticItem;
          const group = cosObj.userData.cosmeticGroup || cosObj;
          const alreadyThisCos = S.selectedRef?.kind === 'cosmetic' && S.selectedRef.item === item;
          const selectRootFirst = !S.itemStudioOpen && !alreadyThisCos;
          selectEditorObject({
            kind: 'cosmetic',
            ent: ownerEnt,
            item,
            group,
            editMode: selectRootFirst ? 'root' : 'part',
            partIdx: cosObj.userData.cosmeticPartIdx ?? 0,
            part: cosObj.userData.cosmeticPart,
            mesh: selectRootFirst ? (group.userData?.partsHolder || group) : cosObj,
            inWorldPlacement: !S.itemStudioOpen
          });
          return;
        }
      }

      let hitMesh = obj.userData?.markerGroup || obj;
      while (obj && !obj.userData.editorRef) obj = obj.parent;
      if (obj && obj.userData.editorRef) {
        let targetRef = obj.userData.editorRef;

        if (targetRef.kind === 'world_item') {
          const worldEntry = targetRef.worldEntry;
          const alreadyThisWi = S.selectedRef?.kind === 'world_item' && S.selectedRef.worldEntry === worldEntry;

          if (!S.itemStudioOpen && !alreadyThisWi && !hitMesh.userData?.isGripMarker && !hitMesh.userData?.isMuzzleMarker) {
            targetRef = {
              kind: 'world_item',
              worldEntry,
              item: worldEntry.item,
              editMode: 'root',
              partIdx: 0,
              mesh: worldEntry.group,
              inWorldPlacement: true
            };
          } else {
            const partIdx = hitMesh.userData?.itemPartIdx ?? 0;
            const isProjPart = !!hitMesh.userData?.isProjectilePart;
            const editMode = hitMesh.userData?.isGripMarker
              ? 'grip'
              : (hitMesh.userData?.isMuzzleMarker ? 'muzzle' : (isProjPart ? 'proj_part' : 'part'));

            selectEditorObject({
              kind: 'world_item',
              worldEntry,
              item: worldEntry.item,
              partIdx,
              editMode,
              mesh: hitMesh,
              inWorldPlacement: !S.itemStudioOpen
            });
            return;
          }
        }

        // Логика Unity:
        // Если у объекта есть родитель в иерархии (папка, пустышка, блок, предмет, NPC):
        // 1-й клик в 3D мире выбирает самого верхнего родителя всей структуры (topRef),
        // чтобы перемещать, вращать и масштабировать всю структуру целиком!
        // Повторный клик (когда структура уже выбрана) — выбирает конкретный дочерний элемент.
        // Если кликнули по 3D-маркеру точки траектории (motion_wp) или работает 3D-пипетка 🎯 — выбираем напрямую без перехода к родителю
        if (targetRef.editMode === 'motion_wp' || S.pickingTargetCallback) {
          selectEditorObject(targetRef);
          return;
        }

        const topRef = getTopMostParentEditorRef(targetRef);
        const topKey = getKeyFromEditorRef(topRef);
        const targetKey = getKeyFromEditorRef(targetRef);
        const curSelKey = getKeyFromEditorRef(S.selectedRef);

        if (topKey && topKey !== targetKey) {
          const isTreeAlreadySelected = curSelKey && (curSelKey === topKey || isDescendantOf(curSelKey, topKey));
          if (!isTreeAlreadySelected) {
            selectEditorObject(topRef);
            return;
          }
        }

        selectEditorObject(targetRef);
        return;
      }
    }
    if (!S.itemStudioOpen) {
      selectEditorObject(null);
    }
  }

  document.addEventListener('pointerdown', e => {
    initAudio();
    syncAudioWithWorldSettings();
    if (S.state === 'edit') {
      if (e.target !== cv) return;
      if (e.button === 2) {
        S.rmbDown = true;
        return;
      }
      if (e.button === 1) {
        e.preventDefault();
        S.mmbDown = true;
        return;
      }
      if (e.button === 0) {
        editPointerDownPos = { x: e.clientX, y: e.clientY };
        editPointerDownBtn = 0;
        return;
      }
      return;
    }

    if (e.pointerType === 'mouse') {
      if (S.state !== 'play' || e.target !== cv) return;
      if (document.pointerLockElement !== cv) {
        if (S.cursorUnlockedByTab) {
          if (e.button === 2) S.rmbDown = true;
          return;
        }
        try {
          cv.requestPointerLock();
        } catch (_) {}
        return;
      }

      if (e.button === 2 || (e.buttons & 2)) {
        setPlayRMBState(true);
      }
      if (e.button === 0 || (e.buttons & 1)) {
        setPlayLMBState(true);
      }
      return;
    }

    if (S.state !== 'play' || e.target.closest('button,.slot,#shopPanel,#topbar,#deathOverlay') || !$('menu').hidden) return;
    if (S.joy.id === null && e.clientX < S.SW * 0.45) {
      S.joy.id = e.pointerId;
      S.joy.ox = e.clientX;
      S.joy.oy = e.clientY;
      S.joy.vx = S.joy.vy = 0;
      stick.hidden = false;
      stick.style.left = S.joy.ox + 'px';
      stick.style.top = S.joy.oy + 'px';
      knob.style.transform = '';
    } else if (S.look.id === null) {
      S.look.id = e.pointerId;
      S.look.lx = e.clientX;
      S.look.ly = e.clientY;
    }
  });

  document.addEventListener('pointermove', e => {
    if (S.state === 'edit') {
      if (S.mmbDown || (e.buttons & 4)) {
        const panSpeed = 0.024;
        const fwd = new THREE.Vector3(
          -Math.sin(S.edYaw) * Math.cos(S.edPitch),
          Math.sin(S.edPitch),
          -Math.cos(S.edYaw) * Math.cos(S.edPitch)
        );
        const right = new THREE.Vector3(Math.cos(S.edYaw), 0, -Math.sin(S.edYaw));
        const up = new THREE.Vector3().crossVectors(right, fwd).normalize();

        S.edCamPos.addScaledVector(right, -(e.movementX || 0) * panSpeed);
        S.edCamPos.addScaledVector(up, (e.movementY || 0) * panSpeed);
        return;
      }
      if (S.rmbDown || (e.buttons & 2)) {
        S.edYaw -= (e.movementX || 0) * 0.0032;
        S.edPitch = clamp(S.edPitch - (e.movementY || 0) * 0.0032, -1.45, 1.45);
      }
      return;
    }
    if (e.pointerType === 'mouse') {
      if (S.state !== 'play') return;
      if (document.pointerLockElement === cv) {
        if ((e.buttons & 2) && !S.isAimingRMB) {
          if (!S.gmodTool?.active) setPlayRMBState(true);
        } else if (!(e.buttons & 2) && S.isAimingRMB) {
          setPlayRMBState(false);
        }

        if ((e.buttons & 1) && !S.lmbDown) setPlayLMBState(true);
        else if (!(e.buttons & 1) && (S.lmbDown || S.isChargingThrow)) setPlayLMBState(false);
      }
      if (document.pointerLockElement === cv || e.buttons) {
        if (S.playerDead && S.worldSettings.respawnMode === 'spectator') {
          S.spectatorYaw -= (e.movementX || 0) * 0.003;
          S.spectatorPitch = clamp(S.spectatorPitch - (e.movementY || 0) * 0.003, -1.45, 1.45);
        } else {
          const sens = S.isAimingRMB ? 0.0018 : 0.0028;
          S.yaw -= (e.movementX || 0) * sens;
          S.pitch = clamp(S.pitch - (e.movementY || 0) * sens, -1.15, 0.65);
        }
      }
      return;
    }
    if (e.pointerId === S.joy.id) {
      let dx = e.clientX - S.joy.ox;
      let dy = e.clientY - S.joy.oy;
      const d = Math.hypot(dx, dy);
      const max = 50;
      if (d > max) {
        dx = (dx / d) * max;
        dy = (dy / d) * max;
      }
      S.joy.vx = dx / max;
      S.joy.vy = dy / max;
      knob.style.transform = `translate(${dx}px,${dy}px)`;
    } else if (e.pointerId === S.look.id) {
      S.yaw -= (e.clientX - S.look.lx) * 0.006;
      S.pitch = clamp(S.pitch - (e.clientY - S.look.ly) * 0.005, -1.15, 0.55);
      S.look.lx = e.clientX;
      S.look.ly = e.clientY;
    }
  });

  const endPtr = e => {
    if (S.state === 'edit') {
      if (e.button === 2 || !(e.buttons & 2)) S.rmbDown = false;
      if (e.button === 1 || !(e.buttons & 4)) S.mmbDown = false;

      if (e.button === 0) {
        const wasDown = editPointerDownBtn === 0;
        editPointerDownBtn = -1;

        if (wasDown && (e.target === cv || e.target === document.body) && !isGizmoDragging && !tControls.dragging) {
          const moveDist = Math.hypot(e.clientX - editPointerDownPos.x, e.clientY - editPointerDownPos.y);
          if (moveDist <= 6) {
            handleStudioSelectionClick(e);
          }
        }
        isGizmoDragging = false;
        return;
      }
    }

    if (e.button === 0 || !(e.buttons & 1)) {
      setPlayLMBState(false);
    }
    if (e.button === 2 || !(e.buttons & 2)) {
      S.rmbDown = false;
      setPlayRMBState(false);
    }
    if (e.button === 1) S.mmbDown = false;
    if (e.pointerId === S.joy.id) {
      S.joy.id = null;
      S.joy.vx = S.joy.vy = 0;
      stick.hidden = true;
    }
    if (e.pointerId === S.look.id) S.look.id = null;
  };
  document.addEventListener('pointerup', endPtr);
  document.addEventListener('pointercancel', endPtr);

  $('bJump').addEventListener('pointerdown', e => {
    e.preventDefault();
    S.btnJump = true;
  });
  $('bJump').addEventListener('pointerup', () => {
    S.btnJump = false;
  });

  $('bCut')?.addEventListener('pointerdown', e => {
    const nearestItem = S.player ? findNearestWorldItem(S.player, 4.2) : null;
    const nearestBlk = S.player ? findNearestKeyEBlock(S.player, 5.0) : null;
    if (nearestItem || nearestBlk || (S.player && S.player.carriedItem)) {
      e.preventDefault();
      e.stopPropagation();
      handleActionKeyE();
    }
  });

  $('startBtn')?.addEventListener('click', () => {
    initAudio();
    syncAudioWithWorldSettings();
    resetAllLogicRuntime(true);
    S.state = 'play';
    cleanupStudioVisualsForPlay();
    $('menu').hidden = true;
    $('topbar').hidden = false;
    $('hotbar').hidden = false;
    $('emotesPanel')?.classList.remove('cursor-free');
    initEmotesHUD();
    syncEmotesPanelActiveState();
    if (coarse) $('touch').hidden = false;
    if (S.gameMode && S.gameMode.onEnterPlay) {
      S.gameMode.onEnterPlay();
    }
    updateShopUI();
  });
}

let lastTime = performance.now();

export function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  try {
    if (S.state === 'play') {
      const prevEmote = S.player?.activeEmote;
      update(dt);
      // Ритмичные звуки хлопков точно в момент соприкосновения ладоней
      if (S.player?.activeEmote === 'clap') {
        const clapIdx = Math.floor((S.player.emoteTimer || 0) * 7.8 / Math.PI);
        if (clapIdx !== S.player._lastClapStep) {
          S.player._lastClapStep = clapIdx;
          sfx.clap?.(0.75);
        }
      }
      if (prevEmote !== S.player?.activeEmote) {
        if (prevEmote === 'fake_die' && !S.player?.activeEmote) sfx.coil?.();
        syncEmotesPanelActiveState();
      }
    } else if ($('emotesPanel') && !$('emotesPanel').hidden) {
      $('emotesPanel').hidden = true;
    }
    updateParticles(dt);
    updateAllPets(dt);
  } catch (err) {
    console.error('Ошибка в игровом цикле update:', err);
  }
  render(dt);
}

export function bootstrapGame(defaultTemplateId = 'heaven_queue') {
  const fill = document.getElementById('loaderFill');
  const status = document.getElementById('loaderStatus');
  const screen = document.getElementById('loadingScreen');

  const setProgress = (pct, text) => {
    if (fill) fill.style.width = pct + '%';
    if (status) status.textContent = text;
  };

  setProgress(15, 'Инициализация 3D сцены...');
  switchGameTemplate(defaultTemplateId);

  setTimeout(() => {
    setProgress(45, 'Загрузка компонентов 3D Студии...');
    initStudioController();
    initHierarchyAndSpawn();
    initPaintStudio2D();

    setTimeout(() => {
      setProgress(75, 'Настройка физики и сохранений...');
      initSerializerEvents();
      initInputControls();
      initEmotesHUD();
      initMultiplayerSystem();
      loadSavedStateOnBoot();

      setTimeout(() => {
        setProgress(100, 'Готово!');
        setTimeout(() => {
          if (screen) screen.classList.add('fade-out');
          setTimeout(() => {
            if (screen) screen.hidden = true;
          }, 450);
        }, 220);
      }, 220);
    }, 220);
  }, 180);

  lastTime = performance.now();
  requestAnimationFrame(loop);
}
