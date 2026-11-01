// src/player/PlayerController.js
import { S, $, clamp, coarse, showBanner } from '../core/State.js';
import { cv, renderer, scene, camera, skyDome } from '../core/SceneManager.js';
import { initAudio } from '../core/AudioEngine.js';
import { updateParticles } from '../core/ParticleSystem.js';
import { updateWorldLights, resetAllLogicRuntime } from '../core/WorldRegistry.js';
import { initSerializerEvents, loadSavedStateOnBoot, switchGameTemplate } from '../core/Serializer.js';
import {
  selectSlot,
  updateShopUI,
  getActiveHeldItem,
  pickupWorldItem,
  dropHeldOrCarriedItem,
  syncEntityHeldItemMesh
} from '../core/EntityManager.js';
import {
  update,
  performPlayerMeleeAttack,
  triggerBlockSpawner,
  triggerBlockLogic,
  findNearestKeyEBlock,
  findNearestWorldItem,
  reloadActiveWeapon,
  cancelReloadHold,
  releaseChargedThrow
} from './PhysicsAndCombat.js';
import {
  tControls,
  raycaster,
  mouseNDC,
  initStudioController,
  toggleStudioMode,
  setGizmoMode,
  focusOnSelected,
  deleteSelected,
  duplicateSelected,
  selectEditorObject,
  undoLastStudioAction
} from '../studio/StudioController.js';
import { initHierarchyAndSpawn } from '../studio/HierarchyAndSpawn.js';
import { updateAllPets } from '../core/CharacterRig.js';
import { initPaintStudio2D, isPaintModalOpen } from '../studio/PaintStudio2D.js';

let menuAngle = 0;

export function handleActionKeyE() {
  if (S.state !== 'play' || !S.player || S.playerDead) return;
  const player = S.player;

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

  // 3. Интерактивные блоки Bricks Logic или Спавнер по [E]
  const nearest = findNearestKeyEBlock(player, 5.0);
  if (nearest) {
    if (nearest.logicData && nearest.logicData.trigger === 'keyE') {
      triggerBlockLogic(nearest, 'keyE');
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
      const held = getActiveHeldItem(player);
      const isADS = S.isAimingRMB && held && held.canAim;
      const cp = Math.cos(S.pitch);
      const dx = Math.sin(S.yaw) * cp;
      const dy = -Math.sin(S.pitch);
      const dz = Math.cos(S.yaw) * cp;
      const dist = isADS ? 4.2 : 7.2;
      const shoulderRightX = isADS ? Math.cos(S.yaw) * 0.85 : 0;
      const shoulderRightZ = isADS ? -Math.sin(S.yaw) * 0.85 : 0;

      camera.position.set(
        player.x + shoulderRightX + dx * dist,
        player.y + (isADS ? 2.25 : 2.4) + dy * dist,
        player.z + shoulderRightZ + dz * dist
      );
      camera.lookAt(
        player.x + shoulderRightX - dx * (isADS ? 12 : 0),
        player.y + (isADS ? 2.0 - dy * 12 : 1.8),
        player.z + shoulderRightZ - dz * (isADS ? 12 : 0)
      );
    }
  } else if (S.state === 'edit') {
    updateEditorCamera(dt);
    const cp = Math.cos(S.edPitch);
    const lookTarget = new THREE.Vector3(
      S.edCamPos.x - Math.sin(S.edYaw) * cp,
      S.edCamPos.y + Math.sin(S.edPitch),
      S.edCamPos.z - Math.cos(S.edYaw) * cp
    );
    camera.position.copy(S.edCamPos);
    camera.lookAt(lookTarget);
  } else {
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

    if (S.state === 'edit') {
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        undoLastStudioAction();
        return;
      }
      if (isPaintModalOpen()) return;

      if (!S.rmbDown && !S.mmbDown) {
        if (e.code === 'KeyW') setGizmoMode('translate');
        if (e.code === 'KeyE') setGizmoMode('rotate');
        if (e.code === 'KeyR') setGizmoMode('scale');
        if (e.code === 'KeyF') focusOnSelected();
        if (e.code === 'Delete' || e.code === 'Backspace') deleteSelected();
        if ((e.ctrlKey || e.metaKey) && e.code === 'KeyD') {
          e.preventDefault();
          duplicateSelected();
        }
      }
      return;
    }

    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code) && S.state === 'play') {
      e.preventDefault();
    }
    if (e.code === 'KeyE') handleActionKeyE();
    if (e.code === 'KeyG') {
      if (S.player && !S.playerDead) dropHeldOrCarriedItem(S.player, 3.8);
    }
    if (e.code === 'KeyF') performPlayerMeleeAttack(true);
    if (e.code === 'KeyR' && !e.repeat) {
      const held = S.player ? getActiveHeldItem(S.player) : null;
      if (held && held.useType === 'ranged') {
        reloadActiveWeapon();
      } else {
        selectSlot(3);
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

  cv.addEventListener('contextmenu', e => e.preventDefault());

  document.addEventListener('mousedown', e => {
    if (e.button === 1 && e.target === cv) e.preventDefault();
    if (S.state !== 'play') return;
    if (document.pointerLockElement !== cv) {
      if (e.target === cv) {
        initAudio();
        try {
          cv.requestPointerLock();
        } catch (_) {}
      }
      return;
    }
    if (e.button === 2 || (e.buttons & 2)) {
      setPlayRMBState(true);
    }
    if (e.button === 0 || (e.buttons & 1)) {
      setPlayLMBState(true);
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

  document.addEventListener('pointerdown', e => {
    initAudio();
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
      if (e.button === 0 && !tControls.dragging) {
        mouseNDC.x = (e.clientX / S.SW) * 2 - 1;
        mouseNDC.y = -(e.clientY / S.SH) * 2 + 1;
        raycaster.setFromCamera(mouseNDC, camera);

        const pickables = [];
        for (const b of S.allBlocks) pickables.push(b.m);
        for (const wi of S.worldItems) pickables.push(wi.group);
        if (S.player && !S.queueLine.includes(S.player)) pickables.push(S.player.rig.g);
        for (const ent of S.queueLine) pickables.push(ent.rig.g);
        for (const n of S.customNPCs) pickables.push(n.rig.g);
        if (S.archangelEnt) pickables.push(S.archangelEnt.rig.g);

        const rawHits = raycaster.intersectObjects(pickables, true);
        const hits = rawHits.filter(h => isObjVisibleInHierarchy(h.object));

        if (hits.length > 0) {
          // Приоритет сквозным X-Ray маркерам (даже если они находятся внутри корпуса оружия или руки персонажа)
          const markerHit = hits.find(
            h =>
              h.object.userData?.isGripMarker ||
              h.object.userData?.isMuzzleMarker ||
              h.object.userData?.isCharHandGripMarker ||
              h.object.userData?.isCharCarryGripMarker
          );
          let obj = markerHit ? markerHit.object : hits[0].object;

          if (obj.userData?.isCharHandGripMarker || obj.userData?.isCharCarryGripMarker) {
            let p = obj;
            while (p && !(p.userData && p.userData.editorRef && p.userData.editorRef.kind === 'char')) {
              p = p.parent;
            }
            if (p && p.userData.editorRef) {
              selectEditorObject({
                kind: 'char',
                ent: p.userData.editorRef.ent,
                editMode: obj.userData.isCharHandGripMarker ? 'hand_grip' : 'carry_grip'
              });
              return;
            }
          }

          let cosObj = obj;
          while (cosObj && !(cosObj.userData && cosObj.userData.cosmeticItem)) {
            cosObj = cosObj.parent;
          }
          if (cosObj && cosObj.userData && cosObj.userData.cosmeticItem) {
            let p = cosObj;
            while (p && !(p.userData && p.userData.editorRef)) p = p.parent;
            if (p && p.userData.editorRef && p.userData.editorRef.kind === 'char') {
              selectEditorObject({
                kind: 'cosmetic',
                ent: p.userData.editorRef.ent,
                item: cosObj.userData.cosmeticItem,
                group: cosObj.userData.cosmeticGroup || cosObj,
                partIdx: cosObj.userData.cosmeticPartIdx ?? 0,
                part: cosObj.userData.cosmeticPart,
                mesh: cosObj
              });
              return;
            }
          }

          let hitMesh = obj.userData?.markerGroup || obj;
          while (obj && !obj.userData.editorRef) obj = obj.parent;
          if (obj && obj.userData.editorRef) {
            if (obj.userData.editorRef.kind === 'world_item') {
              const worldEntry = obj.userData.editorRef.worldEntry;
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
                mesh: hitMesh
              });
              return;
            }
            selectEditorObject(obj.userData.editorRef);
            return;
          }
        }
        selectEditorObject(null);
      }
      return;
    }

    if (e.pointerType === 'mouse') {
      if (S.state !== 'play' || e.target !== cv) return;
      if (document.pointerLockElement !== cv) {
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
        if ((e.buttons & 2) && !S.isAimingRMB) setPlayRMBState(true);
        else if (!(e.buttons & 2) && S.isAimingRMB) setPlayRMBState(false);

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
    resetAllLogicRuntime(true);
    S.state = 'play';
    $('menu').hidden = true;
    $('topbar').hidden = false;
    $('hotbar').hidden = false;
    if (coarse) $('touch').hidden = false;
    if (S.gameMode && S.gameMode.onEnterPlay) {
      S.gameMode.onEnterPlay();
    }
    updateShopUI();
  });
}

let lastTime = performance.now();
export function loop(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  if (S.state === 'play') update(dt);
  updateParticles(dt);
  updateAllPets(dt);
  render(dt);
  requestAnimationFrame(loop);
}

export function bootstrapGame(defaultTemplateId = 'heaven_queue') {
  switchGameTemplate(defaultTemplateId);
  initStudioController();
  initHierarchyAndSpawn();
  initPaintStudio2D();
  initSerializerEvents();
  initInputControls();
  loadSavedStateOnBoot();

  lastTime = performance.now();
  requestAnimationFrame(loop);
}