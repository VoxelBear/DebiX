// src/player/PhysicsAndCombat.js
import { S, $, clamp, rnd, pick, showBanner } from '../core/State.js';
import {
  updateMultiplayerRuntime,
  broadcastMultiplayerPacket,
  isLocalNpcAuthority,
  syncNpcUpsertToNetwork,
  syncWorldItemUpsertToNetwork,
  syncWorldItemDeleteToNetwork
} from '../core/MultiplayerManager.js';
import { cv, scene, camera } from '../core/SceneManager.js';
import { sfx, playSoundId, updateAudioEngineRuntime } from '../core/AudioEngine.js';
import {
  triggerEntityAttack,
  updateEntityAnimation,
  buildItemGroup,
  updateTag
} from '../core/CharacterRig.js';
import {
  addSceneBlock,
  updateBlockOBB,
  rebuildPhysicsArrays,
  syncBlockSpecialVisuals,
  getLogicBadgeStrings,
  ensureBlockComponents,
  evaluateBlockMotionAtProgress
} from '../core/WorldRegistry.js';
import {
  spawnDamageParticles,
  spawnDeathShatter,
  emitParticleBurst
} from '../core/ParticleSystem.js';
import {
  spawnCustomNPC,
  ensureNpcModules,
  spawnWorldItem,
  refreshEntityTagWithHP,
  updateShopUI,
  getActiveHeldItem,
  syncEntityHeldItemMesh,
  dropHeldOrCarriedItem,
  renderHotbarUI
} from '../core/EntityManager.js';
import {
  isNpcSmart,
  areEntitiesAllied,
  broadcastFactionCallForHelp,
  acquireBestTargetForNpc,
  computeSmartNpcSubgoalAStar,
  computeSmartTacticalCombatPlan,
  updateEntityStaminaAndSprint,
  decideNpcSprintIntent
} from './NpcTacticalAI.js';
import {
  updateAllScriptsRuntime,
  runBlockScriptHook,
  runNpcScriptHook,
  runItemScriptHook,
  runWorldScriptHook
} from '../core/ScriptEngine.js';
import {
  registerStatusEffectsHooks,
  updateStatusEffectsRuntime,
  transferEffectsOnContact,
  interactTargetWithLiquid,
  clearTargetStatusEffects,
  isEntityFrozen,
  isItemFrozen,
  isBlockSlippery,
  getWetWeightMultiplier,
  getWetStaminaDrainMultiplier,
  isEntitySoaked
} from '../core/StatusEffects.js';
import {
  registerSurfaceWeatherHooks,
  sampleSurfaceWeatherAt,
  stampSnowFootprint
} from '../core/SurfaceWeatherLayer.js';
import {
  toggleBlockMediaPlayback,
  syncBlockMediaVisuals,
  nextScreenTrack,
  prevScreenTrack,
  nextSpeakerTrack,
  prevSpeakerTrack
} from '../core/MediaSystem.js';

const _vLocal = new THREE.Vector3();
const _vNormal = new THREE.Vector3();
const _vMuzzleWorld = new THREE.Vector3();
const _vAimDir = new THREE.Vector3();
const _vCamFwd = new THREE.Vector3();
const _vTargetPt = new THREE.Vector3();
const _vDashP0 = new THREE.Vector3();
const _vDashP1 = new THREE.Vector3();
const _aimRaycaster = new THREE.Raycaster();
const _camRaycaster = new THREE.Raycaster();
const _vCamPivot = new THREE.Vector3();
const _vCamDir = new THREE.Vector3();
const _nearbySolidMeshes = [];
let smoothedCamDist = 6.8;
let smoothedPlayerCamY = null;

let camAdsBlend = 0;
let camShoulderBlend = 0;

// Динамический источник света для удерживаемого факела и объёмный 3D-пунктир траектории броска
let heldTorchLight = null;
let trajectoryGroup = null;
const TRAJ_DASH_COUNT = 28;
const TRAJ_SIM_STEPS = 60;
const _trajPts = Array.from({ length: TRAJ_SIM_STEPS + 1 }, () => new THREE.Vector3());
const _trajArcLens = new Float32Array(TRAJ_SIM_STEPS + 1);

function ensureHeldTorchLight() {
  if (heldTorchLight) return heldTorchLight;
  heldTorchLight = new THREE.PointLight(0xff9f43, 0, 16, 1.5);
  heldTorchLight.position.set(0, -9999, 0);
  scene.add(heldTorchLight);
  return heldTorchLight;
}

function ensureTrajectoryVisuals() {
  if (trajectoryGroup) return trajectoryGroup;
  trajectoryGroup = new THREE.Group();
  trajectoryGroup.visible = false;

  const dashGeo = new THREE.CylinderGeometry(0.065, 0.065, 1.0, 10);
  dashGeo.rotateX(Math.PI / 2);

  const dashMat = new THREE.MeshBasicMaterial({
    color: 0x00f5a0,
    transparent: true,
    opacity: 0.92,
    depthWrite: false
  });

  const dashes = [];
  for (let i = 0; i < TRAJ_DASH_COUNT; i++) {
    const m = new THREE.Mesh(dashGeo, dashMat);
    m.visible = false;
    m.frustumCulled = false;
    m.userData.noCollider = true;
    trajectoryGroup.add(m);
    dashes.push(m);
  }

  // Светящееся кольцо точки падения снаряда
  const impactGroup = new THREE.Group();
  const ringGeo = new THREE.TorusGeometry(0.44, 0.045, 10, 28);
  ringGeo.rotateX(Math.PI / 2);
  const ringMesh = new THREE.Mesh(ringGeo, dashMat);
  ringMesh.userData.noCollider = true;

  const discGeo = new THREE.RingGeometry(0.1, 0.24, 24);
  discGeo.rotateX(-Math.PI / 2);
  const discMesh = new THREE.Mesh(discGeo, dashMat);
  discMesh.userData.noCollider = true;

  impactGroup.add(ringMesh, discMesh);
  impactGroup.position.y = 0.05;
  trajectoryGroup.add(impactGroup);

  trajectoryGroup.userData = {
    dashes,
    dashMat,
    impactGroup,
    ringMesh,
    discMesh
  };

  scene.add(trajectoryGroup);
  return trajectoryGroup;
}

// Плавное позиционирование камеры от 3-го лица с физической коллизией стен и защитой от прохождения сквозь пол
export function syncPlayCameraToPlayer(player, dt = 0) {
  if (!player) return 6.8;
  const held = getActiveHeldItem(player);
  const isRangedOrThrow = !!(held && (held.useType === 'ranged' || held.useType === 'throwable'));
  const isADS = !!(
    !S.playerDead &&
    held &&
    ((S.isAimingRMB && held.canAim) || S.isChargingThrow)
  );

  if (dt > 0) {
    const rate = 1 - Math.exp(-14 * dt);
    camAdsBlend += ((isADS ? 1 : 0) - camAdsBlend) * rate;
    camShoulderBlend += ((isRangedOrThrow ? 1 : 0) - camShoulderBlend) * rate;
  } else {
    camAdsBlend = isADS ? 1 : camAdsBlend;
    camShoulderBlend = isRangedOrThrow ? 1 : camShoulderBlend;
  }

  const cp = Math.cos(S.pitch);
  const fwdX = -Math.sin(S.yaw) * cp;
  const fwdY = Math.sin(S.pitch);
  const fwdZ = -Math.cos(S.yaw) * cp;

  const rightX = Math.cos(S.yaw);
  const rightZ = -Math.sin(S.yaw);

  // Смещение камеры вправо за ведущую правую руку, чтобы голова персонажа никогда не закрывала прицел в центре экрана
  const shoulderOffset = 0.48 * camShoulderBlend + 0.62 * camAdsBlend;
  const pivotHeight = 2.02 + 0.16 * camAdsBlend;
  const maxDist = 6.8 - 3.45 * camAdsBlend;

  if (smoothedPlayerCamY === null || Math.abs(player.y - smoothedPlayerCamY) > 6.0) {
    smoothedPlayerCamY = player.y;
  } else if (dt > 0) {
    // Мягкое сглаживание вертикальной координаты камеры: полностью убирает резкие скачки для глаз и вестибулярного аппарата!
    const yLerp = 1 - Math.exp(-20 * dt);
    smoothedPlayerCamY += (player.y - smoothedPlayerCamY) * yLerp;
  } else {
    smoothedPlayerCamY = player.y;
  }

  const pivotX = player.x + rightX * shoulderOffset;
  const pivotY = smoothedPlayerCamY + pivotHeight;
  const pivotZ = player.z + rightZ * shoulderOffset;

  // Вектор от точки обзора (плеча/головы) назад к камере
  const dirX = -fwdX;
  const dirY = -fwdY;
  const dirZ = -fwdZ;

  _vCamPivot.set(pivotX, pivotY, pivotZ);
  _vCamDir.set(dirX, dirY, dirZ);

  // Сбор твердых блоков вокруг игрока для быстрой и точной проверки препятствий
  const checkR = maxDist + 1.2;
  _nearbySolidMeshes.length = 0;
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (b.isDisabled || b.matterState !== 'solid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (
      b.x1 < pivotX - checkR || b.x0 > pivotX + checkR ||
      b.y1 < pivotY - checkR || b.y0 > pivotY + checkR ||
      b.z1 < pivotZ - checkR || b.z0 > pivotZ + checkR
    ) {
      continue;
    }
    if (b.m) _nearbySolidMeshes.push(b.m);
  }

  let allowedDist = maxDist;

  // 1. Трассировка луча камеры (Camera Raycast) против стен, потолков и пола
  if (_nearbySolidMeshes.length > 0) {
    _camRaycaster.camera = camera;
    _camRaycaster.set(_vCamPivot, _vCamDir);
    _camRaycaster.near = 0.15;
    _camRaycaster.far = maxDist;
    const hits = _camRaycaster.intersectObjects(_nearbySolidMeshes, false);
    if (hits.length > 0) {
      const hitDist = hits[0].distance;
      // Комфортный отступ от препятствия без просвечивания текстур
      const safeDist = Math.max(0.45, hitDist - 0.28);
      allowedDist = Math.min(allowedDist, safeDist);
    }
  }

  // Мягкая упругая пружина камеры (Spring Damping): быстрое, но плавное сжатие у стены без резких рывков
  if (dt > 0) {
    if (allowedDist < smoothedCamDist) {
      const compressRate = 1 - Math.exp(-22 * dt);
      smoothedCamDist += (allowedDist - smoothedCamDist) * compressRate;
    } else {
      const restoreRate = 1 - Math.exp(-9 * dt);
      smoothedCamDist += (allowedDist - smoothedCamDist) * restoreRate;
    }
  } else {
    smoothedCamDist = allowedDist;
  }

  let camX = pivotX + dirX * smoothedCamDist;
  let camY = pivotY + dirY * smoothedCamDist;
  let camZ = pivotZ + dirZ * smoothedCamDist;

  // 2. Защита от проваливания сквозь пол (применяется ТОЛЬКО к полу под ногами, а не к стенам!)
  let floorYUnderCam = -Infinity;
  const playerFeetY = player.y;

  for (let i = 0; i < _nearbySolidMeshes.length; i++) {
    const b = _nearbySolidMeshes[i].userData?.editorRef?.box;
    if (!b) continue;
    // Блок является полом ТОЛЬКО если его верхняя поверхность на уровне или ниже ступней игрока!
    // Любые стены выше ступней игрока (b.y1 > playerFeetY + 0.45) никогда не поднимают камеру!
    if (b.y1 <= playerFeetY + 0.45) {
      if (
        camX >= b.x0 - 0.25 && camX <= b.x1 + 0.25 &&
        camZ >= b.z0 - 0.25 && camZ <= b.z1 + 0.25
      ) {
        if (b.y1 > floorYUnderCam) {
          floorYUnderCam = b.y1;
        }
      }
    }
  }

  // Если игрок стоит на земле, пол под ногами игрока как минимум на уровне playerFeetY
  if (player.grounded) {
    const dx = camX - player.x;
    const dz = camZ - player.z;
    if (dx * dx + dz * dz < (maxDist + 1.2) * (maxDist + 1.2)) {
      floorYUnderCam = Math.max(floorYUnderCam, playerFeetY);
    }
  }

  // Базовый уровень пола сцены
  if (playerFeetY >= -0.5) {
    floorYUnderCam = Math.max(floorYUnderCam, 0);
  }

  if (floorYUnderCam !== -Infinity) {
    const minSafeY = floorYUnderCam + 0.26;
    if (camY < minSafeY) {
      camY = minSafeY;
    }
  }

  camera.position.set(camX, camY, camZ);
  camera.lookAt(
    pivotX + fwdX * 60,
    pivotY + fwdY * 60,
    pivotZ + fwdZ * 60
  );

  // Адаптивная прозрачность персонажа при сильном сближении камеры (Roblox-style proximity transparency)
  if (player.rig && player.rig.g) {
    const charAlpha = clamp((smoothedCamDist - 0.45) / 0.85, 0.15, 1.0);
    if (charAlpha < 0.98) {
      player.rig.g.traverse(obj => {
        if (
          obj.isMesh &&
          obj.material &&
          !obj.userData?.isCharPickMesh &&
          obj.material.colorWrite !== false &&
          !obj.userData?.isGripMarker &&
          !obj.userData?.isMuzzleMarker &&
          !obj.userData?.isHaloSprite
        ) {
          if (!Array.isArray(obj.material)) {
            obj.material.transparent = true;
            obj.material.opacity = charAlpha;
          }
        }
      });
    } else {
      player.rig.g.traverse(obj => {
        if (
          obj.isMesh &&
          obj.material &&
          !obj.userData?.isCharPickMesh &&
          obj.material.colorWrite !== false &&
          !obj.userData?.isTransparentDefault &&
          !obj.userData?.isGripMarker &&
          !obj.userData?.isMuzzleMarker &&
          !obj.userData?.isHaloSprite
        ) {
          if (!Array.isArray(obj.material)) {
            obj.material.opacity = 1.0;
          }
        }
      });
    }
  }

  return smoothedCamDist;
}

function ensureThrowChargeHUD() {
  let el = $('throwChargeHUD');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'throwChargeHUD';
  el.hidden = true;
  el.style.cssText =
    'position:fixed;left:50%;bottom:98px;transform:translateX(-50%);width:210px;background:rgba(12,16,24,0.88);border:2px solid #56f0ff;border-radius:10px;padding:5px 8px;z-index:18;pointer-events:none;text-align:center';
  el.innerHTML = `
    <div id="throwChargeLbl" style="font:900 10.5px var(--f);color:#fff;margin-bottom:3px">СИЛА БРОСКА: 0%</div>
    <div style="height:8px;background:#1e2638;border-radius:5px;overflow:hidden">
      <div id="throwChargeFill" style="height:100%;width:0%;background:linear-gradient(90deg,#00e676,#ffce3a,#ff3e3e)"></div>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

function ensureReloadHoldHUD() {
  let el = $('reloadHoldHUD');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'reloadHoldHUD';
  el.hidden = true;
  el.style.cssText =
    'position:fixed;left:50%;top:calc(50% + 34px);transform:translateX(-50%);width:186px;background:rgba(12,16,24,0.92);border:2px solid #56f0ff;border-radius:10px;padding:5px 9px;z-index:19;pointer-events:none;text-align:center;box-shadow:0 6px 18px rgba(0,0,0,0.55)';
  el.innerHTML = `
    <div id="reloadHoldLbl" style="font:900 10px var(--f);color:#56f0ff;margin-bottom:3px;letter-spacing:.03em">🔄 УДЕРЖИВАЙ [R]: 0%</div>
    <div style="height:7px;background:#1e2638;border-radius:4px;overflow:hidden">
      <div id="reloadHoldFill" style="height:100%;width:0%;background:linear-gradient(90deg,#56f0ff,#00e676)"></div>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

function ensureCrosshairHUD() {
  let el = $('crosshairHUD');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'crosshairHUD';
  el.hidden = true;
  el.innerHTML = `
    <div class="ch-ring"></div>
    <div class="ch-dot"></div>
    <div class="ch-line top"></div>
    <div class="ch-line bottom"></div>
    <div class="ch-line left"></div>
    <div class="ch-line right"></div>
  `;
  document.body.appendChild(el);
  return el;
}

function ensureDeathOverlay() {
  let el = $('deathOverlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'deathOverlay';
  el.hidden = true;
  el.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:22;display:flex;flex-direction:column;align-items:center;justify-content:center;background:radial-gradient(circle,rgba(180,20,20,0.18),rgba(10,12,18,0.68));backdrop-filter:blur(2px);text-align:center;padding:20px';
  el.innerHTML = `
    <div style="background:rgba(18,20,28,0.94);border:2.5px solid #ff3e3e;border-radius:18px;padding:20px 28px;max-width:460px;box-shadow:0 16px 45px rgba(0,0,0,0.65);pointer-events:auto">
      <div id="deathBadge" style="display:inline-block;background:#ff3e3e;color:#fff;font:900 10.5px var(--f);padding:4px 10px;border-radius:6px;letter-spacing:.08em;margin-bottom:8px">ВЫ ПОГИБЛИ</div>
      <h2 id="deathTitle" style="margin:0 0 8px;font:900 24px var(--f);color:#fff">💀 ПЕРСОНАЖ РАЗБИЛСЯ!</h2>
      <p id="deathSub" style="margin:0 0 14px;font:700 13px var(--f);color:#cbd5e1"></p>
      <div id="deathTimerBox" style="font:900 28px var(--f);color:#ffce3a;margin-bottom:10px">3.5 сек</div>
      <button class="play-btn" id="spectatorRestartBtn" type="button" hidden style="padding:11px 18px;font-size:13px">🔄 РЕСТАРТ ИГРЫ (ВОЗРОДИТЬСЯ)</button>
    </div>
  `;
  document.body.appendChild(el);
  $('spectatorRestartBtn').onclick = () => {
    completePlayerRespawn(true);
  };
  return el;
}

export function completePlayerRespawn(isFullRestart = false) {
  const player = S.player;
  if (!player) return;
  if (player.carriedPhysicsBlock) {
    player.carriedPhysicsBlock._isCarriedByPlayer = false;
    player.carriedPhysicsBlock = null;
  }
  S.playerDead = false;
  S.deathTimer = 0;
  S.isChargingThrow = false;
  S.throwChargeT = 0;
  S.isReloadingHold = false;
  S.reloadHoldT = 0;
  player.reloadTimer = 0;
  const ov = ensureDeathOverlay();
  ov.hidden = true;
  if ($('reloadHoldHUD')) $('reloadHoldHUD').hidden = true;

  player.hp = player.maxHp;
  player.stamina = player.maxStamina || 100;
  player.staminaExhausted = false;
  player.isSprinting = false;
  player.hpBarTimer = 0;
  player.vxKnock = 0;
  player.vzKnock = 0;
  player.vy = 0;
  player.inLiquid = false;
  player.attackAnimT = 0;
  player.ragdoll = null;
  clearTargetStatusEffects(player);
  player._iceSlideVx = 0;
  player._iceSlideVz = 0;
  player.kickCooldown = 0;
  player._ropePullX = 0;
  player._ropePullZ = 0;
  player._ropeResistDirX = 0;
  player._ropeResistDirZ = 0;
  player._ropeResistStrength = 0;
  if (player.rig?.g) player.rig.g.rotation.set(0, player.rot || 0, 0);
  player.rig.g.visible = true;
  player.tag.visible = true;

  if (isFullRestart && S.gameMode && S.gameMode.init) {
    S.gameMode.init();
    showBanner('🔄 Игра перезапущена!', '#00e676');
    return;
  }

  if (S.gameMode && S.gameMode.getRespawnPoint) {
    const pt = S.gameMode.getRespawnPoint(player);
    player.x = pt.x;
    player.y = pt.y;
    player.z = pt.z;
  } else {
    player.x = player.respawnX;
    player.y = player.respawnY + 1;
    player.z = player.respawnZ;
  }

  player.rig.g.position.set(player.x, player.y, player.z);
  player.tag.position.set(player.x, player.y + 3.35, player.z);
  refreshEntityTagWithHP(player);
  updateShopUI();
}

function testPlayerOBB(px, py, pz, pr, ph, box) {
  if (box.isDisabled || box._depletedDisabled) return null;
  const hh = ph * 0.5;
  const pcy = py + hh;
  const pos = box.m.position;

  if (
    px + pr < box.x0 ||
    px - pr > box.x1 ||
    pz + pr < box.z0 ||
    pz - pr > box.z1 ||
    py + ph < box.y0 ||
    py > box.y1
  ) {
    return null;
  }

  _vLocal.set(px - pos.x, pcy - pos.y, pz - pos.z);
  if (box.isRotated) {
    _vLocal.applyQuaternion(box.invQuat);
  }

  const ax = box.axisX;
  const ay = box.axisY;
  const az = box.axisZ;

  const colShape = (!box.colliderShape || box.colliderShape === 'auto')
    ? (box.shape || 'box')
    : box.colliderShape;

  // 1. СФЕРИЧЕСКИЙ КОЛЛАЙДЕР (Sphere)
  if (colShape === 'sphere') {
    const rx = box.hx + pr;
    const ry = box.hy + hh;
    const rz = box.hz + pr;
    const nx = _vLocal.x / Math.max(0.05, rx);
    const ny = _vLocal.y / Math.max(0.05, ry);
    const nz = _vLocal.z / Math.max(0.05, rz);
    const distSq = nx * nx + ny * ny + nz * nz;
    if (distSq >= 1.0) return null;

    const dist = Math.sqrt(distSq);
    const avgR = (rx + ry + rz) / 3;
    const pen = (1.0 - dist) * avgR;
    if (dist > 0.0001) {
      _vNormal.set(nx / rx, ny / ry, nz / rz).normalize();
    } else {
      _vNormal.set(0, 1, 0);
    }
    if (box.isRotated) _vNormal.applyQuaternion(box.m.quaternion).normalize();
    return {
      pen,
      nx: _vNormal.x,
      ny: _vNormal.y,
      nz: _vNormal.z,
      penY: pen,
      topFactor: _vNormal.y
    };
  }

  // 2. ЦИЛИНДРИЧЕСКИЙ / КАПСУЛЬНЫЙ КОЛЛАЙДЕР (Cylinder / Capsule)
  if (colShape === 'cylinder' || colShape === 'capsule') {
    const extY = box.hy + hh;
    const penY = extY - Math.abs(_vLocal.y);
    if (penY <= 0) return null;

    const rx = box.hx + pr;
    const rz = box.hz + pr;
    const dx = _vLocal.x / Math.max(0.05, rx);
    const dz = _vLocal.z / Math.max(0.05, rz);
    const radDistSq = dx * dx + dz * dz;
    if (radDistSq >= 1.0) return null;

    const radDist = Math.sqrt(radDistSq);
    const penRad = (1.0 - radDist) * Math.min(rx, rz);

    if (penY < penRad) {
      const signY = _vLocal.y >= 0 ? 1 : -1;
      _vNormal.copy(ay).multiplyScalar(signY);
      return {
        pen: penY,
        nx: _vNormal.x,
        ny: _vNormal.y,
        nz: _vNormal.z,
        penY,
        topFactor: ay.y
      };
    } else {
      if (radDist > 0.0001) {
        _vNormal.set(dx / rx, 0, dz / rz).normalize();
      } else {
        _vNormal.set(1, 0, 0);
      }
      if (box.isRotated) _vNormal.applyQuaternion(box.m.quaternion).normalize();
      return {
        pen: penRad,
        nx: _vNormal.x,
        ny: _vNormal.y,
        nz: _vNormal.z,
        penY,
        topFactor: ay.y
      };
    }
  }

  // 3. НАКЛОННЫЙ КЛИН / РАМПА (Wedge)
  if (colShape === 'wedge') {
    const extX = box.hx + pr;
    const extY = box.hy + hh;
    const extZ = box.hz + pr;
    const penX = extX - Math.abs(_vLocal.x);
    const penY = extY - Math.abs(_vLocal.y);
    const penZ = extZ - Math.abs(_vLocal.z);
    if (penX <= 0 || penY <= 0 || penZ <= 0) return null;

    // Верхняя грань клина идёт от (-hx, +hy) к (+hx, -hy)
    const tSlope = clamp((_vLocal.x + box.hx) / Math.max(0.05, box.hx * 2), 0, 1);
    const slopeTopY = box.hy * (1 - 2 * tSlope);
    const playerBottomLocalY = _vLocal.y - hh;
    const penSlope = (slopeTopY + 0.08) - playerBottomLocalY;
    if (penSlope <= 0) return null;

    const minSidePen = Math.min(penX, penZ);
    if (penSlope <= minSidePen + 0.35 && _vLocal.y >= -box.hy * 0.6) {
      _vNormal.set(box.hy, box.hx, 0).normalize();
      if (box.isRotated) _vNormal.applyQuaternion(box.m.quaternion).normalize();
      return {
        pen: penSlope,
        nx: _vNormal.x,
        ny: Math.max(0.55, _vNormal.y),
        nz: _vNormal.z,
        penY: penSlope,
        topFactor: 0.9
      };
    }
  }

  // 3.5. КОЛЛАЙДЕР БУБЛИКА / КОЛЬЦА С ОТВЕРСТИЕМ ВНУТРИ (Torus)
  if (colShape === 'torus') {
    const sx = Math.max(0.15, box.w);
    const sy = Math.max(0.15, box.h);
    const sz = Math.max(0.15, box.d);
    const ringScale = (sx + sy) * 0.5;
    const majorR = 0.36 * ringScale;
    const tubeR = 0.14 * ringScale;
    const tubeHalfZ = 0.14 * sz;

    const penZ = (tubeHalfZ + pr) - Math.abs(_vLocal.z);
    if (penZ <= 0) return null;

    const radialDist = Math.hypot(_vLocal.x, _vLocal.y);
    const distFromTubeCenter = Math.abs(radialDist - majorR);
    const effTubeR = tubeR + pr;

    if (distFromTubeCenter >= effTubeR) return null;

    const penTube = effTubeR - distFromTubeCenter;
    if (penZ < penTube) {
      const signZ = _vLocal.z >= 0 ? 1 : -1;
      _vNormal.copy(az).multiplyScalar(signZ);
      return {
        pen: penZ,
        nx: _vNormal.x,
        ny: _vNormal.y,
        nz: _vNormal.z,
        penY: penZ,
        topFactor: Math.abs(_vNormal.y)
      };
    } else {
      const dirSign = radialDist >= majorR ? 1 : -1;
      if (radialDist > 0.0001) {
        _vNormal.set((_vLocal.x / radialDist) * dirSign, (_vLocal.y / radialDist) * dirSign, 0).normalize();
      } else {
        _vNormal.set(1, 0, 0);
      }
      if (box.isRotated) _vNormal.applyQuaternion(box.m.quaternion).normalize();
      return {
        pen: penTube,
        nx: _vNormal.x,
        ny: _vNormal.y,
        nz: _vNormal.z,
        penY: penTube,
        topFactor: Math.max(0, _vNormal.y)
      };
    }
  }

  // 4. СТАНДАРТНЫЙ БОКС (Box OBB)
  const extX = box.hx + pr * Math.hypot(ax.x, ax.z) + hh * Math.abs(ax.y);
  const extY = box.hy + pr * Math.hypot(ay.x, ay.z) + hh * Math.abs(ay.y);
  const extZ = box.hz + pr * Math.hypot(az.x, az.z) + hh * Math.abs(az.y);

  const penX = extX - Math.abs(_vLocal.x);
  if (penX <= 0) return null;

  const penY = extY - Math.abs(_vLocal.y);
  if (penY <= 0) return null;

  const penZ = extZ - Math.abs(_vLocal.z);
  if (penZ <= 0) return null;

  let minPen = penY;
  const signY = _vLocal.y >= 0 ? 1 : -1;
  _vNormal.copy(ay).multiplyScalar(signY);

  if (penX < minPen) {
    minPen = penX;
    const signX = _vLocal.x >= 0 ? 1 : -1;
    _vNormal.copy(ax).multiplyScalar(signX);
  }
  if (penZ < minPen) {
    minPen = penZ;
    const signZ = _vLocal.z >= 0 ? 1 : -1;
    _vNormal.copy(az).multiplyScalar(signZ);
  }

  return {
    pen: minPen,
    nx: _vNormal.x,
    ny: _vNormal.y,
    nz: _vNormal.z,
    penY,
    topFactor: ay.y
  };
}

/* ---------- МОДУЛЬНАЯ СИСТЕМА ВЗАИМОДЕЙСТВИЯ, ДВИЖЕНИЯ, ПЕТЕЛЬ, СВЯЗЕЙ И ПЛАТЫ ---------- */

function ensureBoxRuntime(box) {
  if (!box.logicRuntime) {
    box.logicRuntime = {
      basePos: box.m.position.clone(),
      baseQuat: box.m.quaternion.clone(),
      baseScale: box.m.scale.clone(),
      openT: 0,
      targetU: 0,
      pingPongDir: 1,
      targetOpen: false,
      stayTimer: 0,
      cdTimer: 0,
      ghostOpen: false,
      animT: 0,
      animActive: false,
      respawnTimer: 0
    };
  }
  const rt = box.logicRuntime;
  if (!rt.basePos) rt.basePos = box.m.position.clone();
  if (!rt.baseQuat) rt.baseQuat = box.m.quaternion.clone();
  if (!rt.baseScale) rt.baseScale = box.m.scale.clone();
  return rt;
}

function findTargetBlocksByTag(sourceBox, targetTag) {
  const cleanTag = (targetTag || '').trim();
  if (!cleanTag) return [sourceBox];
  const low = cleanTag.toLowerCase();
  const matches = S.allBlocks.filter(b => {
    if (!b || b._depletedDisabled) return false;
    if (b.id && b.id.toLowerCase() === low) return true;
    if (b.signalData?.tag && b.signalData.tag.trim().toLowerCase() === low) return true;
    if (b.logicData?.tag && b.logicData.tag.trim().toLowerCase() === low) return true;
    if (b.label && b.label.trim().toLowerCase() === low) return true;
    return false;
  });
  return matches.length > 0 ? matches : [sourceBox];
}

// Сдвигает и вращает все дочерние объекты (ручку на двери, декор и т.д.) вслед за родителем в режиме Игры
const _playStepQuat = new THREE.Quaternion();
const _playInvPrevQuat = new THREE.Quaternion();
const _playChildOffset = new THREE.Vector3();

function propagateBlockChildrenInPlay(parentBox, prevPos, prevQuat, newPos, newQuat, player) {
  const rootKey = `block:${parentBox.id}`;
  _playInvPrevQuat.copy(prevQuat).invert();
  _playStepQuat.copy(newQuat).multiply(_playInvPrevQuat);

  const visited = new Set([rootKey]);
  const queue = [rootKey];

  while (queue.length > 0) {
    const curParentKey = queue.shift();
    for (let i = 0; i < S.allBlocks.length; i++) {
      const ch = S.allBlocks[i];
      if (!ch || !ch.m || ch.parentKey !== curParentKey) continue;
      const chKey = `block:${ch.id}`;
      if (visited.has(chKey)) continue;
      visited.add(chKey);
      queue.push(chKey);

      const chPrevX = ch.m.position.x;
      const chPrevY = ch.m.position.y;
      const chPrevZ = ch.m.position.z;

      _playChildOffset.subVectors(ch.m.position, prevPos).applyQuaternion(_playStepQuat);
      ch.m.position.copy(newPos).add(_playChildOffset);
      ch.m.quaternion.premultiply(_playStepQuat);
      ch.m.rotation.setFromQuaternion(ch.m.quaternion);
      ch.m.updateMatrixWorld();

      if (ch.logicRuntime) {
        if (ch.logicRuntime.basePos) {
          _playChildOffset.subVectors(ch.logicRuntime.basePos, prevPos).applyQuaternion(_playStepQuat);
          ch.logicRuntime.basePos.copy(newPos).add(_playChildOffset);
        }
        if (ch.logicRuntime.baseQuat) {
          ch.logicRuntime.baseQuat.premultiply(_playStepQuat);
        }
      }

      updateBlockOBB(ch);
      if (ch.cpVisualGroup) ch.cpVisualGroup.position.copy(ch.m.position);
      if (ch.haloSprite) ch.haloSprite.position.copy(ch.m.position);

      if (player && !S.playerDead && ch.matterState === 'solid') {
        const dx = ch.m.position.x - chPrevX;
        const dy = ch.m.position.y - chPrevY;
        const dz = ch.m.position.z - chPrevZ;
        if (
          player.x + 0.4 >= ch.x0 && player.x - 0.4 <= ch.x1 &&
          player.z + 0.4 >= ch.z0 && player.z - 0.4 <= ch.z1 &&
          Math.abs(player.y - ch.y1) < 0.45
        ) {
          player.x += dx;
          player.y += dy;
          player.z += dz;
        }
      }
    }
  }
}

// Запускает или переключает движение на целевом блоке со страховкой от прокрутки по кругу
export function activateBlockMotion(targetBox, command = 'toggle_motion', ignoreCooldown = false) {
  if (!targetBox) return false;
  ensureBlockComponents(targetBox);
  const comps = targetBox.components;
  const rt = ensureBoxRuntime(targetBox);
  if (!ignoreCooldown && rt.cdTimer > 0) return false;

  if (comps.motion?.enabled && targetBox.motionData) {
    const md = targetBox.motionData;
    const maxU = Math.max(1, Array.isArray(md.waypoints) ? md.waypoints.length : 1);
    rt.cdTimer = Math.max(0.1, Number(md.cooldown) || 0.35);

    if (command === 'forward_motion') {
      rt.targetU = maxU;
      rt.targetOpen = true;
      if (md.loopMode === 'auto_return') rt.stayTimer = Math.max(0.2, Number(md.stayTime) || 3.0);
    } else if (command === 'reverse_motion') {
      rt.targetU = 0;
      rt.targetOpen = false;
      rt.stayTimer = 0;
    } else {
      // Режим переключения со страховкой от прокрутки по кругу
      if (md.loopMode === 'step') {
        const nextStep = Math.round(rt.targetU ?? rt.openT ?? 0) + 1;
        rt.targetU = nextStep > maxU ? 0 : nextStep;
        rt.targetOpen = rt.targetU > 0;
      } else if (md.loopMode === 'one_shot') {
        rt.targetU = maxU;
        rt.targetOpen = true;
      } else if (md.loopMode === 'auto_return') {
        rt.targetU = maxU;
        rt.targetOpen = true;
        rt.stayTimer = Math.max(0.2, Number(md.stayTime) || 3.0);
      } else {
        // 'toggle': если уже не в начальной точке (открыта) -> строго возвращаем в 0 (закрываем)
        const isCurrentlyOpen = (rt.targetU ?? 0) > 0.01 || (rt.openT ?? 0) > 0.25;
        rt.targetU = isCurrentlyOpen ? 0 : maxU;
        rt.targetOpen = !isCurrentlyOpen;
        rt.stayTimer = 0;
      }
    }
    if (comps.sound?.enabled && targetBox.soundData?.soundId && targetBox.soundData.soundId !== 'none') {
      playSoundId(targetBox.soundData.soundId, {
        pos: targetBox.m.position,
        maxDist: targetBox.soundData.radius || 22,
        pitchVar: targetBox.soundData.pitchVar ?? 0.1
      });
    } else {
      try { (sfx.gate || sfx.coil)?.(); } catch (_) {}
    }
    return true;
  }

  // Фоллбэк для legacy двери
  if (targetBox.logicData && targetBox.logicData.action === 'door_slide') {
    const stay = Number(targetBox.logicData.stayTime) ?? 4.0;
    if (stay <= 0) {
      rt.targetOpen = !rt.targetOpen;
      rt.targetU = rt.targetOpen ? 1 : 0;
    } else {
      rt.targetOpen = true;
      rt.targetU = 1;
      rt.stayTimer = stay;
    }
    try { (sfx.gate || sfx.coil)?.(); } catch (_) {}
    return true;
  }
  return false;
}

export function triggerBlockMediaSignal(targetBox, command = 'media_toggle') {
  if (!targetBox || targetBox.isDisabled || targetBox._depletedDisabled) return false;
  const hasScr = Boolean(targetBox.components?.mediaScreen?.enabled && targetBox.mediaScreenData);
  const hasSpk = Boolean(targetBox.components?.soundEmitter?.enabled && targetBox.soundEmitterData);
  if (!hasScr && !hasSpk) return false;

  const cmd = String(command || 'media_toggle');
  if (cmd === 'media_next') {
    if (hasScr) nextScreenTrack(targetBox);
    else nextSpeakerTrack(targetBox);
  } else if (cmd === 'media_prev') {
    if (hasScr) prevScreenTrack(targetBox);
    else prevSpeakerTrack(targetBox);
  } else if (cmd === 'media_play') {
    if (hasScr) targetBox.mediaScreenData.playing = true;
    if (hasSpk) targetBox.soundEmitterData.playing = true;
    syncBlockMediaVisuals(targetBox);
    sfx.click?.();
  } else if (cmd === 'media_pause') {
    if (hasScr) targetBox.mediaScreenData.playing = false;
    if (hasSpk) targetBox.soundEmitterData.playing = false;
    syncBlockMediaVisuals(targetBox);
    sfx.click?.();
  } else {
    toggleBlockMediaPlayback(targetBox, true);
  }

  if (hasScr && window.__debixBroadcastMediaSync) {
    window.__debixBroadcastMediaSync(targetBox);
  }
  return true;
}

window.__debixActivateBlockMotionByTag = (sourceBox, targetTag, action) => {
  const targets = findTargetBlocksByTag(sourceBox, targetTag);
  const act = action || 'toggle_motion';
  for (const tb of targets) {
    if (act.startsWith('media_')) {
      triggerBlockMediaSignal(tb, act);
    } else if (!activateBlockMotion(tb, act)) {
      triggerBlockMediaSignal(tb, 'media_toggle');
    }
  }
};
window.__debixScriptDealDamage = (target, amount) => {
  dealDamage(target, amount, null, 4);
};
registerStatusEffectsHooks({
  dealDamage: (target, amount, attacker, kb, opts) => dealDamage(target, amount, attacker, kb, opts),
  updateBlockOBB: box => updateBlockOBB(box),
  triggerStagger: (target, dirX, dirZ, strength) => triggerEntityStagger(target, dirX, dirZ, strength, 4.2)
});
registerSurfaceWeatherHooks({
  updateBlockOBB: box => updateBlockOBB(box)
});

function applyBlockConsumableDepletion(box) {
  const it = box.interactionData;
  if (!it || it.consumeMode === 'infinite') return;
  const rt = ensureBoxRuntime(box);

  if (it.consumeMode === 'charges') {
    if (it.chargesLeft === undefined) it.chargesLeft = it.maxCharges || 3;
    it.chargesLeft -= Math.max(1, Number(it.costPerUse) || 1);
    syncBlockSpecialVisuals(box);
    if (it.chargesLeft > 0) return;
  }

  // Заряды кончились или режим 'destroy_instant'
  const dep = it.depleteAction || 'respawn';
  if (dep === 'disable') {
    box._interactionDisabled = true;
    syncBlockSpecialVisuals(box);
    showBanner(`🔒 «${box.label}» полностью израсходован!`, '#94a3b8');
  } else if (dep === 'destroy') {
    box._depletedDisabled = true;
    box.m.visible = false;
    if (box.cpVisualGroup) box.cpVisualGroup.visible = false;
    if (box.haloSprite) box.haloSprite.visible = false;
    updateBlockOBB(box);
    emitParticleBurst(box.m.position.x, box.m.position.y, box.m.position.z, 16, {
      preset: 'hit',
      color: box.colorHex || '#ff9f43',
      sizeStart: 0.45,
      sizeEnd: 0.05,
      speed: 5.5,
      spread: 1.2,
      gravity: -9,
      lifetime: 0.8
    });
  } else {
    // 'respawn'
    box._depletedDisabled = true;
    box.m.visible = false;
    if (box.cpVisualGroup) box.cpVisualGroup.visible = false;
    if (box.haloSprite) box.haloSprite.visible = false;
    rt.respawnTimer = Math.max(0.5, Number(it.respawnTime) || 5.0);
    updateBlockOBB(box);
  }
}

const _activeLogicCallStack = new Set();

export function triggerBlockLogic(box, triggerSource = 'keyE', actor = S.player) {
  const ent = actor || S.player;
  if (!ent || !box || box._depletedDisabled || box._interactionDisabled) return false;
  const isPlayer = !!ent.isP;
  // Защита от взаимной рекурсии сигналов (A -> B -> A)
  if (_activeLogicCallStack.has(box)) return false;

  if (triggerSource === 'keyE' || triggerSource === 'hit' || triggerSource === 'touch' || triggerSource === 'signal') {
    runBlockScriptHook(box, 'onInteract', { actor: ent, triggerSource });
  }

  ensureBlockComponents(box);
  const comps = box.components;
  const it = box.interactionData;
  const md = box.motionData;
  const sg = box.signalData;
  const ct = box.costData;

  const hasInteract = Boolean(comps.interaction?.enabled && it);
  const hasSelfMotion = Boolean(comps.motion?.enabled && md && md.triggerMode === 'self');
  const hasSignal = Boolean(comps.signal?.enabled && sg);

  // Проверяем, подходит ли источник активации (keyE, touch, radius, hit, signal)
  if (triggerSource !== 'signal') {
    const expectedTrigger = hasInteract
      ? it.trigger
      : (hasSelfMotion ? 'keyE' : (box.logicData?.trigger || 'none'));
    if (expectedTrigger !== triggerSource) return false;
  }

  const rt = ensureBoxRuntime(box);
  if (rt.cdTimer > 0) return false;

  _activeLogicCallStack.add(box);
  try {
    // 1. Проверка компонента «💰 Плата / Цена (cost)»
    const costVal = comps.cost?.enabled
      ? Math.max(0, Number(ct?.amount) || 0)
      : Math.max(0, Number(box.logicData?.cost) || 0);
    const oneTime = comps.cost?.enabled ? (ct?.oneTimeBuy !== false) : (box.logicData?.oneTimeBuy !== false);
    const isUnlocked = comps.cost?.enabled ? !!ct?.unlocked : !!box.logicData?.unlocked;
    const needsPayment = costVal > 0 && !(oneTime && isUnlocked);

    if (needsPayment) {
      if (!isPlayer) return false; // NPC не может покупать платные двери за R$
      if (ent.cash < costVal) {
        rt.cdTimer = 1.0;
        sfx.oof();
        showBanner(`❌ Не хватает R$! Нужно ${costVal} R$ (у тебя ${ent.cash} R$)`, '#ff3e3e');
        return false;
      }
      ent.cash -= costVal;
      if (oneTime) {
        if (ct) ct.unlocked = true;
        if (box.logicData) box.logicData.unlocked = true;
        syncBlockSpecialVisuals(box);
      }
      sfx.cash();
      updateShopUI();
    }

    rt.cdTimer = hasInteract
      ? Math.max(0.15, Number(it.cooldown) || 0.6)
      : Math.max(0.25, Number(box.logicData?.cooldown) || 0.6);

    let didAnything = false;

    // 2. Выполнение действия из компонента «💥 Взаимодействие (Что делает)»
    if (hasInteract) {
      const act = it.actionType || 'none';

      if (act === 'health') {
        const amt = Math.max(1, Number(it.healthAmount) || 25);
        if (it.healthMode === 'heal') {
          if (ent.hp < ent.maxHp) {
            ent.hp = Math.min(ent.maxHp, ent.hp + amt);
            ent.hpBarTimer = 3.5;
            refreshEntityTagWithHP(ent);
            if (isPlayer) {
              updateShopUI();
              sfx.cash();
              showBanner(`💚 +${amt} HP (${box.label})!`, '#00e676');
            }
          }
        } else if (it.healthMode === 'kill') {
          if (isPlayer) {
            oofRespawn(`💀 Смертельная ловушка: «${box.label}»!`);
          } else {
            dealDamage(ent, (ent.maxHp || 100) * 10);
          }
        } else {
          rt.cdTimer = Math.max(0.1, Number(it.healthTick) || 0.5);
          dealDamage(ent, amt);
        }
        didAnything = true;
      } else if (act === 'teleport') {
        let destX = Number(it.tpX) || 0;
        let destY = Number(it.tpY) || 6;
        let destZ = Number(it.tpZ) || 0;
        let destLabel = `${destX.toFixed(0)}, ${destY.toFixed(0)}, ${destZ.toFixed(0)}`;

        if (it.tpMode === 'checkpoint') {
          destX = isPlayer ? (ent.respawnX ?? 0) : (ent.homeX ?? 0);
          destY = (isPlayer ? (ent.respawnY ?? 2) : (ent.homeY ?? 2)) + 0.8;
          destZ = isPlayer ? (ent.respawnZ ?? 0) : (ent.homeZ ?? 0);
          destLabel = 'Чекпоинт';
        } else if (it.tpMode === 'target' && it.tpTargetTag) {
          const targets = findTargetBlocksByTag(box, it.tpTargetTag);
          const targetBlk = targets.find(b => b !== box) || targets[0];
          if (targetBlk && targetBlk !== box) {
            destX = targetBlk.m.position.x;
            destY = targetBlk.y1 > -90000 ? targetBlk.y1 : targetBlk.m.position.y + targetBlk.h * 0.5;
            destZ = targetBlk.m.position.z;
            destLabel = targetBlk.label;
            const trt = ensureBoxRuntime(targetBlk);
            trt.cdTimer = 1.4;
          }
        }

        ent.x = destX;
        ent.y = destY;
        ent.z = destZ;
        ent.vy = 0;
        ent.vxKnock = 0;
        ent.vzKnock = 0;
        if (ent.rig?.g) ent.rig.g.position.set(ent.x, ent.y, ent.z);
        if (ent.tag) ent.tag.position.set(ent.x, ent.y + 3.35, ent.z);
        if (isPlayer) {
          sfx.checkpoint();
          showBanner(`🌀 Телепортация: ${destLabel}!`, '#56f0ff');
        }
        didAnything = true;
      } else if (act === 'checkpoint') {
        if (isPlayer) {
          const cx = box.m.position.x;
          const cz = box.m.position.z;
          const topY = box.y1 > -90000 ? box.y1 : box.m.position.y + box.h * 0.5;
          ent.respawnX = cx;
          ent.respawnY = topY + 0.5;
          ent.respawnZ = cz;
          const stage = Number(it.cpStage) || 1;
          if (stage > (ent.bestObby || 0)) {
            ent.bestObby = stage;
            const mult = ((ent.rebirths || 0) + 1) * (ent.hasHalo ? 2 : 1);
            const earned = (Number(it.cpCash) ?? 50) * mult;
            ent.cash += earned;
            sfx.checkpoint();
            if (S.gameMode && S.gameMode.onCheckpointReached) {
              S.gameMode.onCheckpointReached({ stage, title: it.cpTitle || 'Чекпоинт', rewardCash: it.cpCash, skipSpots: it.cpSkip || 0 }, earned);
            } else {
              updateShopUI();
              showBanner(`⭐ ${it.cpTitle || 'Чекпоинт'}! +${earned} R$!`, '#00e676');
            }
          }
          didAnything = true;
        }
      } else if (act === 'impulse') {
        const ix = Number(it.impulseX) || 0;
        const iy = Number(it.impulseY) ?? 16;
        const iz = Number(it.impulseZ) || 0;
        if (iy !== 0) {
          ent.vy = iy;
          ent.grounded = false;
        }
        if (ix !== 0 || iz !== 0) {
          ent.vxKnock = (ent.vxKnock || 0) + ix;
          ent.vzKnock = (ent.vzKnock || 0) + iz;
        }
        if (isPlayer) sfx.coil();
        didAnything = true;
      } else if (act === 'reward') {
        const rType = it.rewardType || 'cash';
        if (isPlayer) {
          if (rType === 'cash') {
            const baseReward = Number(it.rewardCash) || 25;
            const earned = baseReward * (ent.hasHalo ? 2 : 1);
            ent.cash += earned;
            sfx.cash();
            updateShopUI();
            showBanner(`🪙 +${earned} R$ (${box.label})!`, '#ffce3a');
          } else if (rType === 'speed') {
            ent.hasSpeed = true;
            ent.preset.coil = true;
            if (ent.rig?.coil) ent.rig.coil.visible = true;
            sfx.coil();
            showBanner('🌀 Получена Пружина Скорости (+55% к бегу)!', '#56f0ff');
          } else if (rType === 'grav') {
            ent.hasGrav = true;
            ent.preset.coil = true;
            if (ent.rig?.coil) ent.rig.coil.visible = true;
            sfx.coil();
            showBanner('🚀 Получена Пружина Прыжка (Gravity Coil)!', '#a29bfe');
          } else if (rType === 'halo') {
            ent.hasHalo = true;
            ent.preset.halo = true;
            if (ent.rig?.halo) ent.rig.halo.visible = true;
            sfx.coil();
            showBanner('😇 Получен VIP Нимб (x2 R$)!', '#ffce3a');
          } else if (rType === 'heal') {
            ent.maxHp += 25;
            ent.hp = ent.maxHp;
            ent.hpBarTimer = 3.5;
            refreshEntityTagWithHP(ent);
            sfx.coil();
            showBanner(`❤️ Здоровье увеличено до ${ent.maxHp} HP!`, '#00e676');
          } else if (rType === 'damage') {
            ent.meleeDamage = (ent.meleeDamage || 25) + 15;
            sfx.coil();
            showBanner(`🥊 Сила удара увеличена до ${ent.meleeDamage} ед.!`, '#ff6b6b');
          }
          updateShopUI();
        } else {
          if (rType === 'heal') {
            ent.maxHp += 25;
            ent.hp = ent.maxHp;
            refreshEntityTagWithHP(ent);
          } else if (rType === 'damage') {
            ent.meleeDamage = (ent.meleeDamage || 15) + 15;
          }
        }
        didAnything = true;
      } else if (act === 'ghost_pass') {
        const stay = Number(it.ghostTime) ?? 4.0;
        const nextGhost = stay <= 0 ? !rt.ghostOpen : true;
        rt.ghostOpen = nextGhost;
        rt.stayTimer = stay > 0 ? stay : 0;
        if (box.m.material) {
          box.m.material.transparent = true;
          box.m.material.opacity = nextGhost ? 0.25 : (box.matterState === 'solid' ? 1.0 : 0.72);
        }
        if (isPlayer) {
          sfx.coil();
          showBanner(`👻 Проход «${box.label}» открыт!`, '#56f0ff');
        }
        didAnything = true;
      } else if (act === 'none') {
        didAnything = true;
      }
    }

    // 3. Если на самом этом объекте есть «⚙️ Движение (motion)» с запуском от себя (или нет внешних связей)
    if (comps.motion?.enabled && (md.triggerMode === 'self' || triggerSource === 'signal' || !hasSignal || !sg.targetTag)) {
      if (activateBlockMotion(box, 'toggle_motion')) {
        didAnything = true;
      }
    }

    // 3.2. Если сигнал пришёл на Видео-Экран или 3D-Колонку — переключаем воспроизведение
    if (triggerSource === 'signal' && (comps.mediaScreen?.enabled || comps.soundEmitter?.enabled)) {
      if (triggerBlockMediaSignal(box, 'media_toggle')) {
        didAnything = true;
      }
    }

    // 3.5. Если к объекту подключён компонент «🔊 3D Звук (sound)» в режиме триггера
    if (comps.sound?.enabled && box.soundData?.mode !== 'zone_loop' && box.soundData?.soundId) {
      playSoundId(box.soundData.soundId, {
        pos: box.m.position,
        maxDist: box.soundData.radius || 22,
        pitchVar: box.soundData.pitchVar ?? 0.1
      });
      didAnything = true;
    }

    // 4. Выполнение компонента «🔗 Связи и Сигналы (signal)» (например, ручка двери -> сама дверь)
    if (hasSignal) {
      if (sg.selfAnim && sg.selfAnim !== 'none') {
        rt.animActive = true;
        rt.animT = 0.001;
        if (sg.selfAnim === 'lever_tilt') sfx.leverPull();
        else if (sg.selfAnim === 'button_press') sfx.buttonPress();
        else sfx.click();
      }
      if (sg.targetTag) {
        const targets = findTargetBlocksByTag(box, sg.targetTag);
        const sigAct = sg.signalAction || 'toggle_motion';
        for (const tb of targets) {
          if (tb === box || _activeLogicCallStack.has(tb)) continue;
          if (sigAct.startsWith('media_')) {
            triggerBlockMediaSignal(tb, sigAct);
          } else if (sigAct === 'trigger_target') {
            triggerBlockLogic(tb, 'signal', ent);
          } else if (!activateBlockMotion(tb, sigAct)) {
            // Если у целевого блока нет Движения, но это Экран/Колонка — кнопка всё равно переключит воспроизведение
            triggerBlockMediaSignal(tb, 'media_toggle');
          }
          didAnything = true;
        }
      }
    }

    if (didAnything && hasInteract) {
      applyBlockConsumableDepletion(box);
    }

    if (didAnything && !box._fromNetworkSync && box.id) {
      broadcastMultiplayerPacket({
        type: 'block_logic',
        blockId: box.id,
        triggerSource
      });
    }

    return didAnything;
  } finally {
    _activeLogicCallStack.delete(box);
  }
}

window.__debixTriggerBlockFromNet = (blk, src) => {
  if (!blk) return;
  blk._fromNetworkSync = true;
  try {
    triggerBlockLogic(blk, src);
  } finally {
    blk._fromNetworkSync = false;
  }
};

export function getEntityWeight(ent) {
  if (!ent) return 70;
  return clamp(Number(ent.weight) || 70, 5, 5000);
}

export function getMaxLiftableBlockWeight(player) {
  return Math.round(getEntityWeight(player) * 0.9);
}

export function findNearestCarryablePhysicsBlock(player, maxDist = 4.2) {
  if (!player) return null;
  let best = null;
  let bestDist = maxDist;
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b.isDisabled || b._depletedDisabled || b._isCarriedByPlayer) continue;
    if (!b.components?.physics?.enabled || !b.isDynamicPhysics) continue;
    if (b.matterState !== 'solid') continue;

    const cx = b.m.position.x;
    const cy = b.m.position.y;
    const cz = b.m.position.z;
    const dx = Math.max((cx - b.hx) - player.x, 0, player.x - (cx + b.hx));
    const dy = Math.max((cy - b.hy) - (player.y + 1.1), 0, (player.y + 1.1) - (cy + b.hy));
    const dz = Math.max((cz - b.hz) - player.z, 0, player.z - (cz + b.hz));
    const d = Math.hypot(dx, dy, dz);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

export function pickupPhysicsBlock(player, box) {
  if (!player || !box || !box.isDynamicPhysics || box.matterState !== 'solid') return false;
  const w = clamp(Number(box.weight) || 15, 0.1, 10000);
  const maxLift = getMaxLiftableBlockWeight(player);
  if (w > maxLift) {
    sfx.oof?.();
    showBanner(`🪨 «${box.label}» весит ${w} кг! Игрок (${getEntityWeight(player)} кг) поднимает максимум до ${maxLift} кг.`, '#ff3e3e');
    return false;
  }
  if (player.carriedItem) {
    dropHeldOrCarriedItem(player, 1.5);
  }
  if (player.carriedPhysicsBlock) {
    dropCarriedPhysicsBlock(player, 1.5);
  }
  player.carriedPhysicsBlock = box;
  player._carryLastYaw = S.yaw;
  player._ropePullX = 0;
  player._ropePullZ = 0;
  player._ropeResistStrength = 0;
  box._isCarriedByPlayer = true;
  box.physVx = 0;
  box.physVy = 0;
  box.physVz = 0;
  player.holdPose = 'carry';
  sfx.pickup?.() || sfx.coil?.();
  showBanner(`📦 Взято в руки: «${box.label}» (${w} кг) · [ЛКМ] Бросить · [E / G] Опустить`, '#00e676');
  return true;
}

export function dropCarriedPhysicsBlock(player, baseImpulse = 2.0, customMsg = null) {
  if (!player || !player.carriedPhysicsBlock) return false;
  const box = player.carriedPhysicsBlock;
  player.carriedPhysicsBlock = null;
  box._isCarriedByPlayer = false;
  box._thrownBy = player;
  box._throwGrace = 0.28;

  const held = getActiveHeldItem(player);
  player.holdPose = held ? (S.isAimingRMB && held.canAim ? 'aim' : 'weapon') : null;

  const w = clamp(Number(box.weight) || 15, 0.1, 10000);
  const pWeight = getEntityWeight(player);
  const cp = Math.cos(S.pitch);
  const fwdX = -Math.sin(S.yaw) * cp;
  const fwdY = Math.sin(S.pitch);
  const fwdZ = -Math.cos(S.yaw) * cp;

  const flatFx = -Math.sin(S.yaw);
  const flatFz = -Math.cos(S.yaw);
  const holdDist = Math.min(3.2, 1.15 + Math.max(box.hx, box.hz));
  box.m.position.set(
    player.x + flatFx * holdDist,
    Math.max(player.y + 0.8 + box.hy * 0.5, box.m.position.y),
    player.z + flatFz * holdDist
  );

  const weightThrowFactor = clamp(Math.pow(14 / Math.max(0.4, w), 0.52) * Math.sqrt(pWeight / 70), 0.18, 2.85);
  const finalSpeed = baseImpulse * weightThrowFactor;

  box.physVx = (baseImpulse > 4 ? fwdX : flatFx) * finalSpeed;
  box.physVz = (baseImpulse > 4 ? fwdZ : flatFz) * finalSpeed;
  if (baseImpulse > 4) {
    const upBoost = w <= 2.5 ? 5.8 : clamp(3.4 * weightThrowFactor, 0.8, 7.5);
    box.physVy = Math.max(1.2, fwdY * finalSpeed + upBoost);
  } else {
    box.physVy = 1.0;
  }
  box.physGrounded = false;
  updateBlockOBB(box);

  if (baseImpulse > 4) sfx.slap?.();
  else sfx.click?.();

  if (customMsg) {
    showBanner(customMsg, '#56f0ff');
  }
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, true);
  }
  return true;
}

const _vTmp1 = new THREE.Vector3();
const _vTmp2 = new THREE.Vector3();
const _vTmp3 = new THREE.Vector3();
const _qStep = new THREE.Quaternion();
const _qInv = new THREE.Quaternion();
let _ropeVisualGroup = null;

function getInertialMass(w) {
  return Math.max(0.5, Math.abs(Number(w) || 15));
}

const _vWorldUp = new THREE.Vector3(0, 1, 0);
const _vTargetUp = new THREE.Vector3(0, 1, 0);
const _vTiltAxis = new THREE.Vector3();
const _vLocalUp = new THREE.Vector3();

function computeAlignmentToTargetUp(box, targetUpVec, outAxis, outAngleContainer) {
  const ax = box.axisX;
  const ay = box.axisY;
  const az = box.axisZ;

  if (ay.y > 0.78) {
    _vLocalUp.copy(ay);
  } else {
    let bestDot = -2;
    _vLocalUp.copy(ay);
    const candidates = [
      [ax.x, ax.y, ax.z], [-ax.x, -ax.y, -ax.z],
      [ay.x, ay.y, ay.z], [-ay.x, -ay.y, -ay.z],
      [az.x, az.y, az.z], [-az.x, -az.z, -az.z]
    ];
    candidates[5][1] = -az.y;
    for (let i = 0; i < 6; i++) {
      const c = candidates[i];
      const dot = c[0] * targetUpVec.x + c[1] * targetUpVec.y + c[2] * targetUpVec.z;
      if (dot > bestDot) {
        bestDot = dot;
        _vLocalUp.set(c[0], c[1], c[2]);
      }
    }
  }

  outAxis.crossVectors(_vLocalUp, targetUpVec);
  const sinA = outAxis.length();
  const cosA = clamp(_vLocalUp.dot(targetUpVec), -1, 1);
  outAngleContainer.angle = Math.atan2(sinA, cosA);
  if (sinA > 0.0001) {
    outAxis.divideScalar(sinA);
  } else {
    outAxis.set(0, 0, 0);
  }
}

export function applyImpulseToDynamicBlock(box, ix, iy, iz, worldHitPoint = null, isPlayerWalkPush = false) {
  if (!box || !box.isDynamicPhysics || box._isCarriedByPlayer || box.matterState === 'liquid') return;
  const cluster = box._physCluster;
  if (cluster && cluster.isStaticAnchored) return;

  const w = Number.isNaN(Number(box.weight)) ? 15 : Number(box.weight);
  const mass = cluster ? cluster.totalInertialMass : getInertialMass(w);
  const invMass = clamp(18 / mass, 0.002, 4.5);

  let dvx = ix * invMass;
  let dvy = iy * invMass;
  let dvz = iz * invMass;

  if (!isPlayerWalkPush && w >= 0 && w <= 3.5 && Math.hypot(ix, iz) > 0.8) {
    dvy = Math.max(dvy, clamp((4.2 - w) * 1.4, 1.2, 5.5));
  }

  let dwx = 0;
  let dwy = 0;
  let dwz = 0;

  const curHeight =
    Math.abs(box.axisX.y) * box.w +
    Math.abs(box.axisY.y) * box.h +
    Math.abs(box.axisZ.y) * box.d;
  const curBaseWidth = Math.max(
    0.2,
    Math.min(
      Math.abs(box.axisX.x) * box.w + Math.abs(box.axisY.x) * box.h + Math.abs(box.axisZ.x) * box.d,
      Math.abs(box.axisX.z) * box.w + Math.abs(box.axisY.z) * box.h + Math.abs(box.axisZ.z) * box.d
    )
  );
  const isTallColumn = curHeight > curBaseWidth * 1.35 && curHeight >= 2.2;

  if (worldHitPoint && (!isPlayerWalkPush || isTallColumn)) {
    const com = cluster ? cluster.com : box.m.position;
    const pivotY = box.physGrounded ? box.y0 : com.y;
    const ry = worldHitPoint.y - pivotY;
    const rx = worldHitPoint.x - com.x;
    const rz = worldHitPoint.z - com.z;

    const tx = ry * iz - rz * iy;
    const ty = (rz * ix - rx * iz) * 0.25;
    const tz = rx * iy - ry * ix;

    const inertia = cluster ? cluster.momentOfInertia : Math.max(1.2, mass * (curHeight * curHeight + curBaseWidth * curBaseWidth) * 0.25);
    const invInertia = clamp(18 / inertia, 0.002, 4.0);

    dwx = tx * invInertia;
    dwy = ty * invInertia;
    dwz = tz * invInertia;

    if (isTallColumn && box.physGrounded) {
      dvx *= 0.25;
      dvz *= 0.25;
      dwx *= 1.65;
      dwz *= 1.65;
    }
  }

  const members = cluster ? cluster.members : [box];
  for (let i = 0; i < members.length; i++) {
    const mb = members[i];
    mb.physVx = (mb.physVx || 0) + dvx;
    mb.physVy = (mb.physVy || 0) + dvy;
    mb.physVz = (mb.physVz || 0) + dvz;
    mb.physWx = clamp((mb.physWx || 0) + dwx, -7, 7);
    mb.physWy = clamp((mb.physWy || 0) + dwy, -7, 7);
    mb.physWz = clamp((mb.physWz || 0) + dwz, -7, 7);
  }
}

function resolveTorusVsBlockCollision(torusBox, otherBox) {
  const sx = Math.max(0.15, torusBox.w);
  const sy = Math.max(0.15, torusBox.h);
  const sz = Math.max(0.15, torusBox.d);
  const ringScale = (sx + sy) * 0.5;
  const majorR = 0.36 * ringScale;
  const tubeR = 0.14 * ringScale;
  const innerHoleR = Math.max(0.05, majorR - tubeR);
  const outerR = majorR + tubeR;
  const tubeHalfZ = 0.14 * sz;

  _vTmp1.subVectors(otherBox.m.position, torusBox.m.position);
  if (torusBox.isRotated) _vTmp1.applyQuaternion(torusBox.invQuat);

  const poleRadXZ = Math.max(otherBox.hx, otherBox.hz);
  const poleRadXY = Math.max(otherBox.hx, otherBox.hy);
  const poleRadius = Math.min(poleRadXZ, poleRadXY);

  _vTmp2.copy(otherBox.axisY);
  if (torusBox.isRotated) _vTmp2.applyQuaternion(torusBox.invQuat);

  let holeLocalX = _vTmp1.x;
  let holeLocalY = _vTmp1.y;
  let axisCrossingValid = false;

  if (Math.abs(_vTmp2.z) > 0.25) {
    const tCross = -_vTmp1.z / _vTmp2.z;
    if (Math.abs(tCross) <= otherBox.hy + tubeHalfZ) {
      holeLocalX = _vTmp1.x + _vTmp2.x * tCross;
      holeLocalY = _vTmp1.y + _vTmp2.y * tCross;
      axisCrossingValid = true;
    }
  }

  if (axisCrossingValid && poleRadius < innerHoleR * 0.96) {
    const radialDist = Math.hypot(holeLocalX, holeLocalY);
    const maxFreeMove = innerHoleR - poleRadius;

    if (radialDist <= maxFreeMove) {
      return null;
    }
    if (radialDist < majorR + poleRadius) {
      const pen = radialDist - maxFreeMove;
      const nxL = -(holeLocalX / (radialDist || 1));
      const nyL = -(holeLocalY / (radialDist || 1));
      _vTmp3.set(nxL, nyL, 0);
      if (torusBox.isRotated) _vTmp3.applyQuaternion(torusBox.m.quaternion);
      _vTmp3.normalize();
      return {
        pen,
        nx: _vTmp3.x,
        ny: _vTmp3.y,
        nz: _vTmp3.z
      };
    }
  }

  const overlapX = Math.min(torusBox.x1, otherBox.x1) - Math.max(torusBox.x0, otherBox.x0);
  const overlapY = Math.min(torusBox.y1, otherBox.y1) - Math.max(torusBox.y0, otherBox.y0);
  const overlapZ = Math.min(torusBox.z1, otherBox.z1) - Math.max(torusBox.z0, otherBox.z0);
  if (overlapX <= 0 || overlapY <= 0 || overlapZ <= 0) return null;

  const clampedX = clamp(_vTmp1.x, -otherBox.hx, otherBox.hx);
  const clampedY = clamp(_vTmp1.y, -otherBox.hy, otherBox.hy);
  const dxR = _vTmp1.x - clampedX;
  const dyR = _vTmp1.y - clampedY;
  const radDist = Math.hypot(dxR, dyR);
  if (radDist > outerR + Math.max(otherBox.hx, otherBox.hz)) return null;

  const dx = torusBox.m.position.x - otherBox.m.position.x;
  const dy = torusBox.m.position.y - otherBox.m.position.y;
  const dz = torusBox.m.position.z - otherBox.m.position.z;

  if (overlapY <= overlapX && overlapY <= overlapZ) {
    return { pen: overlapY, nx: 0, ny: dy >= 0 ? 1 : -1, nz: 0 };
  }
  if (overlapX <= overlapZ) {
    return { pen: overlapX, nx: dx >= 0 ? 1 : -1, ny: 0, nz: 0 };
  }
  return { pen: overlapZ, nx: 0, ny: 0, nz: dz >= 0 ? 1 : -1 };
}

function buildWeldedPhysicsClusters() {
  const all = S.allBlocks;
  const byId = new Map();
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    if (!b || b.isDisabled || b._depletedDisabled) continue;
    byId.set(b.id, b);
    b._physCluster = null;
  }

  const adj = new Map();
  const addEdge = (a, b) => {
    if (!a || !b || a === b) return;
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b);
    adj.get(b).add(a);
  };

  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    if (!b || b.isDisabled || b._depletedDisabled || b.weldToParent === false) continue;
    if (b.parentKey && b.parentKey.startsWith('block:')) {
      const parentId = b.parentKey.slice(6);
      const pBox = byId.get(parentId);
      if (pBox && !pBox.isDisabled && !pBox._depletedDisabled) {
        addEdge(b, pBox);
      }
    }
  }

  if (Array.isArray(S.physicsConstraints)) {
    for (let i = 0; i < S.physicsConstraints.length; i++) {
      const c = S.physicsConstraints[i];
      if (!c || c.type !== 'weld') continue;
      const bA = byId.get(c.blockAId);
      const bB = byId.get(c.blockBId);
      if (bA && bB && !bA.isDisabled && !bB.isDisabled && !bA._depletedDisabled && !bB._depletedDisabled) {
        addEdge(bA, bB);
      }
    }
  }

  const visited = new Set();
  const clusters = [];

  for (let i = 0; i < all.length; i++) {
    const start = all[i];
    if (!start || start.isDisabled || start._depletedDisabled || visited.has(start)) continue;

    const comp = [];
    const queue = [start];
    visited.add(start);

    while (queue.length > 0) {
      const cur = queue.shift();
      comp.push(cur);
      const neighbors = adj.get(cur);
      if (neighbors) {
        for (const nb of neighbors) {
          if (!visited.has(nb)) {
            visited.add(nb);
            queue.push(nb);
          }
        }
      }
    }

    const hasAnyDynamic = comp.some(x => x.components?.physics?.enabled && x.isDynamicPhysics && x.matterState !== 'liquid');
    if (!hasAnyDynamic) continue;

    let rootBox = comp.find(x => !x.parentKey || !x.parentKey.startsWith('block:') || !comp.includes(byId.get(x.parentKey.slice(6)))) || comp[0];

    let isStaticAnchored = false;
    if (!rootBox.isDynamicPhysics || !rootBox.components?.physics?.enabled) {
      isStaticAnchored = true;
    } else {
      for (const mb of comp) {
        const isChildOfDynamic = mb.parentKey && mb.parentKey.startsWith('block:') && byId.get(mb.parentKey.slice(6))?.isDynamicPhysics;
        if (!isChildOfDynamic && (!mb.isDynamicPhysics || !mb.components?.physics?.enabled)) {
          isStaticAnchored = true;
          break;
        }
      }
    }

    let totalInertialMass = 0;
    let totalNetWeight = 0;
    const com = new THREE.Vector3();

    for (const mb of comp) {
      if (mb.isDynamicPhysics && mb.components?.physics?.enabled) {
        const w = Number.isNaN(Number(mb.weight)) ? 15 : Number(mb.weight);
        const im = getInertialMass(w);
        totalInertialMass += im;
        totalNetWeight += w;
        com.addScaledVector(mb.m.position, im);
      }
    }
    if (totalInertialMass > 0) {
      com.divideScalar(totalInertialMass);
    } else {
      com.copy(rootBox.m.position);
      totalInertialMass = 15;
    }

    let momentOfInertia = 0;
    for (const mb of comp) {
      if (mb.isDynamicPhysics && mb.components?.physics?.enabled) {
        const im = getInertialMass(mb.weight);
        const distSq = mb.m.position.distanceToSquared(com);
        const boxSpanSq = (mb.w * mb.w + mb.h * mb.h + mb.d * mb.d) / 6;
        momentOfInertia += im * (boxSpanSq + distSq);
      }
    }
    momentOfInertia = Math.max(2.0, momentOfInertia);

    const clusterObj = {
      root: rootBox,
      members: comp,
      isStaticAnchored,
      totalInertialMass,
      totalNetWeight,
      momentOfInertia,
      com,
      vx: rootBox.physVx || 0,
      vy: rootBox.physVy || 0,
      vz: rootBox.physVz || 0,
      wx: rootBox.physWx || 0,
      wy: rootBox.physWy || 0,
      wz: rootBox.physWz || 0,
      anyInLiquid: false,
      anyGrounded: false,
      waterTiltX: 0,
      waterTiltZ: 0
    };
    for (const mb of comp) {
      mb._physCluster = clusterObj;
    }
    clusters.push(clusterObj);
  }

  return clusters;
}

// Вычисляет точную мировую высоту Y верхней (опорной) грани блока в точке (wx, wz) с учётом его 3D-наклона
export function sampleBlockTopSurfaceYAtPoint(box, wx, wz) {
  if (!box || !box.m) return box ? box.y1 : 0;
  if (!box.isRotated) return box.y1;

  _vTmp1.set(wx - box.m.position.x, 0, wz - box.m.position.z);
  const ax = box.axisX;
  const ay = box.axisY;
  const az = box.axisZ;

  let upAxis = ay;
  let upHalf = box.hy;
  let uAxis1 = ax;
  let uHalf1 = box.hx;
  let uAxis2 = az;
  let uHalf2 = box.hz;

  const absX = Math.abs(ax.y);
  const absY = Math.abs(ay.y);
  const absZ = Math.abs(az.y);
  if (absX > absY && absX > absZ) {
    upAxis = ax; upHalf = box.hx;
    uAxis1 = ay; uHalf1 = box.hy;
    uAxis2 = az; uHalf2 = box.hz;
  } else if (absZ > absY && absZ > absX) {
    upAxis = az; upHalf = box.hz;
    uAxis1 = ax; uHalf1 = box.hx;
    uAxis2 = ay; uHalf2 = box.hy;
  }

  const upSign = upAxis.y >= 0 ? 1 : -1;
  const topCenterX = box.m.position.x + upAxis.x * upHalf * upSign;
  const topCenterY = box.m.position.y + upAxis.y * upHalf * upSign;
  const topCenterZ = box.m.position.z + upAxis.z * upHalf * upSign;

  const ny = upAxis.y * upSign;
  if (ny < 0.25) return box.y1;

  const nx = upAxis.x * upSign;
  const nz = upAxis.z * upSign;
  const dx = clamp(wx - topCenterX, -Math.max(uHalf1, uHalf2), Math.max(uHalf1, uHalf2));
  const dz = clamp(wz - topCenterZ, -Math.max(uHalf1, uHalf2), Math.max(uHalf1, uHalf2));

  return topCenterY - (nx * dx + nz * dz) / ny;
}

function areBlocksLinkedByConstraint(bA, bB) {
  const list = S.physicsConstraints;
  if (!Array.isArray(list) || list.length === 0) return false;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c) continue;
    if (
      (c.blockAId === bA.id && c.blockBId === bB.id) ||
      (c.blockAId === bB.id && c.blockBId === bA.id)
    ) {
      return true;
    }
  }
  return false;
}

function transformWeldedCluster(cluster, dx, dy, dz, rotQuat, pivotPt) {
  if (!cluster || cluster.isStaticAnchored) return;
  const members = cluster.members;
  const hasRot = rotQuat && (Math.abs(rotQuat.x) > 0.00001 || Math.abs(rotQuat.y) > 0.00001 || Math.abs(rotQuat.z) > 0.00001);

  for (let i = 0; i < members.length; i++) {
    const mb = members[i];
    if (!mb || !mb.m) continue;

    if (hasRot && pivotPt) {
      _vTmp1.subVectors(mb.m.position, pivotPt).applyQuaternion(rotQuat);
      mb.m.position.copy(pivotPt).add(_vTmp1);
      mb.m.quaternion.premultiply(rotQuat).normalize();
      mb.m.rotation.setFromQuaternion(mb.m.quaternion);
    }
    mb.m.position.x += dx;
    mb.m.position.y += dy;
    mb.m.position.z += dz;

    mb.m.updateMatrixWorld();
    updateBlockOBB(mb);
    if (mb.cpVisualGroup) {
      mb.cpVisualGroup.position.copy(mb.m.position);
      mb.cpVisualGroup.rotation.copy(mb.m.rotation);
    }
    if (mb.haloSprite) mb.haloSprite.position.copy(mb.m.position);
  }

  cluster.com.x += dx;
  cluster.com.y += dy;
  cluster.com.z += dz;
}

const _ropeUnitCylGeo = new THREE.CylinderGeometry(1, 1, 1, 8);
_ropeUnitCylGeo.rotateX(Math.PI / 2);
const _vSegStart = new THREE.Vector3();
const _vSegEnd = new THREE.Vector3();

export function renderPhysicsConstraintsVisuals() {
  if (!_ropeVisualGroup) {
    _ropeVisualGroup = new THREE.Group();
    _ropeVisualGroup.name = 'PhysicsConstraintsVisuals';
    scene.add(_ropeVisualGroup);
  }
  while (_ropeVisualGroup.children.length > 0) {
    const ch = _ropeVisualGroup.children.pop();
    if (ch.geometry && ch.geometry !== _ropeUnitCylGeo) ch.geometry.dispose();
    if (ch.material) ch.material.dispose();
  }

  const list = S.physicsConstraints || [];
  if (list.length === 0 && !S.gmodTool?.firstHit) return;

  const byId = new Map();
  for (let i = 0; i < S.allBlocks.length; i++) {
    byId.set(S.allBlocks[i].id, S.allBlocks[i]);
  }

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c) continue;
    const bA = byId.get(c.blockAId);
    const bB = byId.get(c.blockBId);
    if (!bA || !bB || bA._depletedDisabled || bB._depletedDisabled) continue;

    const pA = new THREE.Vector3(c.localAnchorA?.x || 0, c.localAnchorA?.y || 0, c.localAnchorA?.z || 0);
    bA.m.localToWorld(pA);
    const pB = new THREE.Vector3(c.localAnchorB?.x || 0, c.localAnchorB?.y || 0, c.localAnchorB?.z || 0);
    bB.m.localToWorld(pB);

    if (c.type === 'rope') {
      const dist = pA.distanceTo(pB);
      const maxL = Math.max(0.2, Number(c.maxLength) || 4.0);
      const sag = Math.max(0, (maxL - dist) * 0.32);
      const mid = pA.clone().lerp(pB, 0.5);
      mid.y -= sag;

      const curve = new THREE.QuadraticBezierCurve3(pA, mid, pB);
      const segs = 8;
      const radius = clamp(Number(c.thickness) || 0.08, 0.015, 0.6) * 0.5;
      const ropeHex = c.color || '#ffce3a';
      const mat = new THREE.MeshBasicMaterial({ color: ropeHex });

      for (let s = 0; s < segs; s++) {
        curve.getPoint(s / segs, _vSegStart);
        curve.getPoint((s + 1) / segs, _vSegEnd);
        const segLen = _vSegStart.distanceTo(_vSegEnd);
        if (segLen < 0.005) continue;
        const segMesh = new THREE.Mesh(_ropeUnitCylGeo, mat);
        segMesh.position.lerpVectors(_vSegStart, _vSegEnd, 0.5);
        segMesh.lookAt(_vSegEnd);
        segMesh.scale.set(radius, radius, segLen * 1.04);
        segMesh.userData.noCollider = true;
        _ropeVisualGroup.add(segMesh);
      }
    } else if (c.type === 'weld' && S.state === 'edit') {
      const geo = new THREE.BufferGeometry().setFromPoints([pA, pB]);
      const mat = new THREE.LineBasicMaterial({ color: 0x00e676, depthTest: false });
      const line = new THREE.Line(geo, mat);
      line.renderOrder = 995;
      line.userData.noCollider = true;
      _ropeVisualGroup.add(line);
    }
  }
}

export function updateDynamicBlocksPhysics(dt, player) {
  const worldGrav = S.worldSettings.gravity ?? 22;
  const all = S.allBlocks;

  // Сброс сил натяжения верёвок на игрока в начале кадра
  if (player) {
    player._ropePullX = 0;
    player._ropePullZ = 0;
    player._ropeResistDirX = 0;
    player._ropeResistDirZ = 0;
    player._ropeResistStrength = 0;
  }

  // 1. Переноска физического блока в руках игрока (вращается вместе с игроком как дочерний объект!)
  if (player && player.carriedPhysicsBlock) {
    const cb = player.carriedPhysicsBlock;
    if (S.playerDead || player.ragdoll?.active || !cb.isDynamicPhysics || cb._depletedDisabled) {
      cb._isCarriedByPlayer = false;
      player.carriedPhysicsBlock = null;
    } else {
      const prevYaw = player._carryLastYaw !== undefined ? player._carryLastYaw : S.yaw;
      let deltaYaw = S.yaw - prevYaw;
      while (deltaYaw > Math.PI) deltaYaw -= Math.PI * 2;
      while (deltaYaw < -Math.PI) deltaYaw += Math.PI * 2;
      player._carryLastYaw = S.yaw;

      const fx = -Math.sin(S.yaw);
      const fz = -Math.cos(S.yaw);
      const holdDist = Math.min(3.2, 1.15 + Math.max(cb.hx, cb.hz));
      const targetX = player.x + fx * holdDist;
      const targetY = player.y + 1.25 + Math.min(1.2, cb.hy * 0.45);
      const targetZ = player.z + fz * holdDist;

      const dx = targetX - cb.m.position.x;
      const dy = targetY - cb.m.position.y;
      const dz = targetZ - cb.m.position.z;

      const hasYawStep = Math.abs(deltaYaw) > 0.00001;
      if (hasYawStep) _qStep.setFromAxisAngle(_vWorldUp, deltaYaw);

      if (cb._physCluster && !cb._physCluster.isStaticAnchored) {
        transformWeldedCluster(cb._physCluster, dx, dy, dz, hasYawStep ? _qStep : null, cb.m.position);
      } else {
        cb.m.position.set(targetX, targetY, targetZ);
        if (hasYawStep) {
          cb.m.quaternion.premultiply(_qStep).normalize();
          cb.m.rotation.setFromQuaternion(cb.m.quaternion);
        }
        cb.m.updateMatrixWorld();
        updateBlockOBB(cb);
        if (cb.cpVisualGroup) {
          cb.cpVisualGroup.position.copy(cb.m.position);
          cb.cpVisualGroup.rotation.copy(cb.m.rotation);
        }
        if (cb.haloSprite) cb.haloSprite.position.copy(cb.m.position);
      transferEffectsOnContact(cb, player, dt, true, 1.0);
      }
    }
  }

  // 2. Сборка сваренных кластеров
  const clusters = buildWeldedPhysicsClusters();
  if (clusters.length === 0) {
    renderPhysicsConstraintsVisuals();
    return;
  }

  const byId = new Map();
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    if (!b) continue;
    byId.set(b.id, b);
    b._externalLoadWeight = 0;
    b._riderOffsetX = 0;
    b._riderOffsetZ = 0;
    b._riderIsPlayer = false;
    b._frameStartX = b.m.position.x;
    b._frameStartY = b.m.position.y;
    b._frameStartZ = b.m.position.z;
  }

  // 3. Определение веса стоящего сверху игрока / NPC
  const registerRiderOnBlock = (ent, entWeight, isPlayerRider) => {
    if (isPlayerRider && ((ent._jumpGraceTimer || 0) > 0 || S.keys.Space || S.btnJump)) return;
    if (isPlayerRider && !ent.grounded && (ent._groundedAnimTimer || 0) <= 0) return;
    const entX = ent.x;
    const entY = ent.y;
    const entZ = ent.z;
    const entR = ent.colliderRadius || 0.42;

    let bestBlk = null;
    let bestArea = -1;

    if (
      isPlayerRider &&
      ent._supportBlock &&
      !ent._supportBlock._depletedDisabled &&
      entX + entR >= ent._supportBlock.x0 - 0.15 &&
      entX - entR <= ent._supportBlock.x1 + 0.15 &&
      entZ + entR >= ent._supportBlock.z0 - 0.15 &&
      entZ - entR <= ent._supportBlock.z1 + 0.15
    ) {
      bestBlk = ent._supportBlock;
    } else {
      for (let i = 0; i < all.length; i++) {
        const b = all[i];
        if (!b || b._depletedDisabled || b.matterState !== 'solid' || b._isCarriedByPlayer) continue;
        if (
          entX + entR >= b.x0 && entX - entR <= b.x1 &&
          entZ + entR >= b.z0 && entZ - entR <= b.z1 &&
          entY >= b.y1 - 0.22 && entY <= b.y1 + 0.18
        ) {
          const area = b.w * b.d;
          if (!bestBlk || area > bestArea) {
            bestBlk = b;
            bestArea = area;
          }
        }
      }
    }

    if (bestBlk) {
      bestBlk._externalLoadWeight += entWeight;
      if (isPlayerRider) bestBlk._riderIsPlayer = true;
      const com = bestBlk._physCluster ? bestBlk._physCluster.com : bestBlk.m.position;
      bestBlk._riderOffsetX += (entX - com.x) * entWeight;
      bestBlk._riderOffsetZ += (entZ - com.z) * entWeight;
    }
  };

  if (player && !S.playerDead && !player.isFlying) {
    registerRiderOnBlock(player, getEntityWeight(player), true);
  }
  for (let ni = 0; ni < S.customNPCs.length; ni++) {
    const npc = S.customNPCs[ni];
    if (npc && !(npc._deadCooldown > 0)) {
      registerRiderOnBlock(npc, getEntityWeight(npc), false);
    }
  }

  for (let i = 0; i < all.length; i++) {
    const topB = all[i];
    if (!topB || topB._depletedDisabled || !topB.isDynamicPhysics || topB.matterState !== 'solid') continue;
    const topW = Number(topB.weight) || 15;
    if (topW <= 0) continue;
    for (let j = 0; j < all.length; j++) {
      const botB = all[j];
      if (botB === topB || botB._depletedDisabled || botB.matterState !== 'solid') continue;
      if (topB._physCluster && topB._physCluster === botB._physCluster) continue;
      if (
        topB.x1 > botB.x0 && topB.x0 < botB.x1 &&
        topB.z1 > botB.z0 && topB.z0 < botB.z1 &&
        Math.abs(topB.y0 - botB.y1) <= 0.25
      ) {
        botB._externalLoadWeight += topW;
        const com = botB._physCluster ? botB._physCluster.com : botB.m.position;
        botB._riderOffsetX += (topB.m.position.x - com.x) * topW;
        botB._riderOffsetZ += (topB.m.position.z - com.z) * topW;
        break;
      }
    }
  }

  // 3.5. Сборка графа верёвок
  const activeRopes = [];
  const linkedGraph = new Map();
  const addGraphLink = (c1, c2) => {
    if (!c1 || !c2 || c1 === c2) return;
    if (!linkedGraph.has(c1)) linkedGraph.set(c1, new Set());
    if (!linkedGraph.has(c2)) linkedGraph.set(c2, new Set());
    linkedGraph.get(c1).add(c2);
    linkedGraph.get(c2).add(c1);
  };

  for (let ci = 0; ci < clusters.length; ci++) {
    clusters[ci]._hasRopeLink = false;
  }

  if (Array.isArray(S.physicsConstraints)) {
    for (let ri = 0; ri < S.physicsConstraints.length; ri++) {
      const c = S.physicsConstraints[ri];
      if (!c || c.type !== 'rope') continue;
      const bA = byId.get(c.blockAId);
      const bB = byId.get(c.blockBId);
    if (!bA || !bB || bA.isDisabled || bB.isDisabled || bA._depletedDisabled || bB._depletedDisabled) continue;
      const clA = bA._physCluster;
      const clB = bB._physCluster;
      if (!clA && !clB) continue;
      if (clA && clA === clB) continue;
      if (clA) clA._hasRopeLink = true;
      if (clB) clB._hasRopeLink = true;
      activeRopes.push({ c, bA, bB, clA, clB });
      if (clA && clB) addGraphLink(clA, clB);
    }
  }

  for (let i = 0; i < clusters.length; i++) {
    const cA = clusters[i];
    for (let j = i + 1; j < clusters.length; j++) {
      const cB = clusters[j];
      let touching = false;
      for (let ma = 0; ma < cA.members.length && !touching; ma++) {
        const ba = cA.members[ma];
        for (let mb = 0; mb < cB.members.length; mb++) {
          const bb = cB.members[mb];
          if (
            ba.x1 + 0.35 >= bb.x0 && ba.x0 - 0.35 <= bb.x1 &&
            ba.y1 + 0.35 >= bb.y0 && ba.y0 - 0.35 <= bb.y1 &&
            ba.z1 + 0.35 >= bb.z0 && ba.z0 - 0.35 <= bb.z1
          ) {
            touching = true;
            break;
          }
        }
      }
      if (touching) addGraphLink(cA, cB);
    }
  }

  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci];
    cl.anyInLiquid = false;
    cl._suppressAntiGravOnLand = false;
    for (let mi = 0; mi < cl.members.length; mi++) {
      const mb = cl.members[mi];
      for (let li = 0; li < all.length; li++) {
        const liq = all[li];
        if (liq === mb || liq._depletedDisabled || liq.matterState !== 'liquid') continue;
        if (liq.components && !liq.components.physics?.enabled) continue;
        if (liq.liquidPhysicsEnabled === false) continue;
        if (mb.x1 > liq.x0 && mb.x0 < liq.x1 && mb.z1 > liq.z0 && mb.z0 < liq.z1 && mb.y1 > liq.y0 && mb.y0 < liq.y1) {
          cl.anyInLiquid = true;
          break;
        }
      }
    }
  }

  const visitedPre = new Set();
  for (let ci = 0; ci < clusters.length; ci++) {
    const startCl = clusters[ci];
    if (visitedPre.has(startCl)) continue;
    const comp = [];
    const q = [startCl];
    visitedPre.add(startCl);
    while (q.length > 0) {
      const cur = q.shift();
      comp.push(cur);
      const nbSet = linkedGraph.get(cur);
      if (nbSet) {
        for (const nb of nbSet) {
          if (!visitedPre.has(nb)) {
            visitedPre.add(nb);
            q.push(nb);
          }
        }
      }
    }
    let totalGroupNetWeight = 0;
    let groupInWater = false;
    for (const g of comp) {
      totalGroupNetWeight += g.totalNetWeight;
      for (const m of g.members) totalGroupNetWeight += (m._externalLoadWeight || 0);
      if (g.anyInLiquid) groupInWater = true;
    }
    if (!groupInWater && totalGroupNetWeight > 0) {
      for (const g of comp) {
        g._suppressAntiGravOnLand = true;
      }
    }
  }

  // 4. Интеграция сил
  const _angleBox = { angle: 0 };

  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci];
    if (cl.isStaticAnchored || cl.members.some(m => m._isCarriedByPlayer)) {
      cl.vx = 0; cl.vy = 0; cl.vz = 0;
      cl.wx = 0; cl.wy = 0; cl.wz = 0;
      continue;
    }

    let forceX = 0;
    let forceY = 0;
    let forceZ = 0;
    let maxLiqDrag = 0;
    let anyInLiquid = false;
    let totalRiderMomentX = 0;
    let totalRiderMomentZ = 0;
    let totalBuoyancyMomentX = 0;
    let totalBuoyancyMomentZ = 0;
    let maxSpanXZ = 1.0;

    const totalRiderMass = cl.members.reduce((acc, m) => acc + (m._externalLoadWeight || 0), 0);
    const clusterNetWeightWithLoad = cl.totalNetWeight + totalRiderMass;
    const suppressNegLift = cl._suppressAntiGravOnLand || (!cl.anyInLiquid && clusterNetWeightWithLoad > 0);

    for (let mi = 0; mi < cl.members.length; mi++) {
      const mb = cl.members[mi];
      if (!mb.components?.physics?.enabled || !mb.isDynamicPhysics || mb.matterState === 'liquid') continue;

      const w = Number.isNaN(Number(mb.weight)) ? 15 : Number(mb.weight);
      const externalLoad = mb._externalLoadWeight || 0;
      const rx = mb.m.position.x - cl.com.x;
      const rz = mb.m.position.z - cl.com.z;
      maxSpanXZ = Math.max(maxSpanXZ, Math.hypot(rx, rz) + Math.max(mb.w, mb.d) * 0.5);

      totalRiderMomentX += mb._riderOffsetX || 0;
      totalRiderMomentZ += mb._riderOffsetZ || 0;

      let memberVertForce = 0;
      if (w < 0) {
        if (suppressNegLift) {
          memberVertForce -= (Math.abs(w) * 0.5 + externalLoad) * worldGrav;
        } else {
          const antiGravLift = Math.abs(w) * worldGrav;
          const heavyWorldSuppression = Math.max(0, worldGrav - 28) * 0.65 * Math.abs(w);
          memberVertForce += (antiGravLift - heavyWorldSuppression) - externalLoad * worldGrav;
        }
      } else {
        const lowGravFloat = worldGrav < 9 ? (9 - worldGrav) * 1.4 : 0;
        const effectiveW = Math.max(-2.5, w - lowGravFloat) + externalLoad;
        memberVertForce -= effectiveW * worldGrav;
      }

      let inLiq = false;
      for (let li = 0; li < all.length; li++) {
        const liq = all[li];
        if (liq === mb || liq._depletedDisabled || liq.matterState !== 'liquid') continue;
        if (liq.components && !liq.components.physics?.enabled) continue;
        if (liq.liquidPhysicsEnabled === false) continue;

        if (
          mb.x1 > liq.x0 && mb.x0 < liq.x1 &&
          mb.z1 > liq.z0 && mb.z0 < liq.z1 &&
          mb.y1 > liq.y0 && mb.y0 < liq.y1
        ) {
          inLiq = true;
          anyInLiquid = true;
          interactTargetWithLiquid(mb, liq, dt);
          maxLiqDrag = Math.max(maxLiqDrag, clamp(Number(liq.liquidDrag) || 4.2, 1.5, 25));

          const subH = clamp(liq.y1 - mb.y0, 0, mb.h);
          const subRatio = clamp(subH / Math.max(0.15, mb.h), 0, 1.0);
          const maxBuoyancyKg = clamp(Number(liq.liquidBuoyancy) || 85, 1, 5000);

          const archimedesForce = subRatio * maxBuoyancyKg * worldGrav;
          memberVertForce += archimedesForce;

          if (liq.conveyorVx || liq.conveyorVz) {
            forceX += (liq.axisX.x * (liq.conveyorVx || 0) + liq.axisZ.x * (liq.conveyorVx || 0)) * 32 * subRatio;
            forceZ += (liq.axisX.z * (liq.conveyorVx || 0) + liq.axisZ.z * (liq.conveyorVz || 0)) * 32 * subRatio;
          }
          break;
        }
      }
      mb.physInLiquid = inLiq;
      forceY += memberVertForce;

      totalBuoyancyMomentX += rx * (memberVertForce / Math.max(1, worldGrav));
      totalBuoyancyMomentZ += rz * (memberVertForce / Math.max(1, worldGrav));
    }

    cl.anyInLiquid = anyInLiquid;
    cl.netForceY = forceY;
    const invM = 1 / Math.max(0.5, cl.totalInertialMass + totalRiderMass);
    cl.vx = clamp(cl.vx + forceX * invM * dt, -28, 28);
    cl.vy = clamp(cl.vy + forceY * invM * dt, -35, 14);
    cl.vz = clamp(cl.vz + forceZ * invM * dt, -28, 28);

    if (anyInLiquid) {
      const linDamp = Math.exp(-maxLiqDrag * dt);
      cl.vx *= linDamp;
      cl.vy *= Math.exp(-maxLiqDrag * 1.35 * dt);
      cl.vz *= linDamp;

      const effectiveStiffness = Math.max(40, cl.totalInertialMass * 0.75) * Math.max(1.1, maxSpanXZ * 0.5);
      const netTiltX = (totalRiderMomentX - totalBuoyancyMomentX * 0.35) / effectiveStiffness;
      const netTiltZ = (totalRiderMomentZ - totalBuoyancyMomentZ * 0.35) / effectiveStiffness;

      const waveX = Math.sin(S.time * 2.2 + cl.com.x * 0.4) * 0.02;
      const waveZ = Math.cos(S.time * 1.9 + cl.com.z * 0.4) * 0.02;

      cl.waterTiltX = clamp(netTiltX * 0.72 + waveX, -0.44, 0.44);
      cl.waterTiltZ = clamp(netTiltZ * 0.72 + waveZ, -0.44, 0.44);

      _vTargetUp.set(cl.waterTiltX, 1.0, cl.waterTiltZ).normalize();
      computeAlignmentToTargetUp(cl.root, _vTargetUp, _vTiltAxis, _angleBox);

      const springK = 18.0;
      const dampK = 5.5;
      cl.wx += (_vTiltAxis.x * _angleBox.angle * springK - cl.wx * dampK) * dt;
      cl.wy += (_vTiltAxis.y * _angleBox.angle * springK - cl.wy * dampK) * dt;
      cl.wz += (_vTiltAxis.z * _angleBox.angle * springK - cl.wz * dampK) * dt;
    } else {
      if (cl.vy > 0) {
        const airDragUp = 0.16 * cl.vy * cl.vy;
        cl.vy = Math.max(0, cl.vy - airDragUp * dt);
      }
      cl.vy = clamp(cl.vy, -35, 11.0);
      const airDamp = Math.pow(cl._hasRopeLink ? 0.25 : 0.82, dt);
      cl.vx *= airDamp;
      cl.vz *= airDamp;

      computeAlignmentToTargetUp(cl.root, _vWorldUp, _vTiltAxis, _angleBox);
      if (_angleBox.angle > 0.003) {
        const airRestore = 10.5;
        cl.wx += (_vTiltAxis.x * _angleBox.angle * airRestore - cl.wx * 6.0) * dt;
        cl.wy += (_vTiltAxis.y * _angleBox.angle * airRestore - cl.wy * 6.0) * dt;
        cl.wz += (_vTiltAxis.z * _angleBox.angle * airRestore - cl.wz * 6.0) * dt;
      } else {
        cl.wx *= Math.pow(0.08, dt);
        cl.wy *= Math.pow(0.08, dt);
        cl.wz *= Math.pow(0.08, dt);
      }
    }
  }

  // 5. ПЕРЕДАЧА ИМПУЛЬСА ПО ВЕРЁВКАМ
  if (activeRopes.length > 0) {
    const visitedRopeComp = new Set();
    for (let ci = 0; ci < clusters.length; ci++) {
      const startCl = clusters[ci];
      if (visitedRopeComp.has(startCl) || !linkedGraph.has(startCl)) continue;

      const group = [];
      const q = [startCl];
      visitedRopeComp.add(startCl);
      while (q.length > 0) {
        const cur = q.shift();
        group.push(cur);
        const nbSet = linkedGraph.get(cur);
        if (nbSet) {
          for (const nb of nbSet) {
            if (!visitedRopeComp.has(nb)) {
              visitedRopeComp.add(nb);
              q.push(nb);
            }
          }
        }
      }

      if (group.length > 1 && !group.some(g => g.isStaticAnchored)) {
        let sumNetForceY = 0;
        let sumInertialMass = 0;
        for (const g of group) {
          sumNetForceY += g.netForceY || 0;
          sumInertialMass += g.totalInertialMass;
        }
        if (sumNetForceY > 0) {
          const sharedVyAccel = (sumNetForceY / Math.max(1, sumInertialMass)) * dt;
          let avgVy = 0;
          for (const g of group) avgVy += g.vy * g.totalInertialMass;
          avgVy = clamp(avgVy / Math.max(1, sumInertialMass) + sharedVyAccel * 0.5, -30, 10.5);
          for (const g of group) {
            g.vy = g.vy * 0.25 + avgVy * 0.75;
          }
        }
      }
    }

    for (let iter = 0; iter < 8; iter++) {
      for (let ri = 0; ri < activeRopes.length; ri++) {
        const { c, bA, bB, clA, clB } = activeRopes[ri];
        const aMovable = Boolean(clA && !clA.isStaticAnchored && !clA.members.some(m => m._isCarriedByPlayer));
        const bMovable = Boolean(clB && !clB.isStaticAnchored && !clB.members.some(m => m._isCarriedByPlayer));
        if (!aMovable && !bMovable) continue;

        const pA = new THREE.Vector3(c.localAnchorA?.x || 0, c.localAnchorA?.y || 0, c.localAnchorA?.z || 0);
        bA.m.localToWorld(pA);
        const pB = new THREE.Vector3(c.localAnchorB?.x || 0, c.localAnchorB?.y || 0, c.localAnchorB?.z || 0);
        bB.m.localToWorld(pB);

        const dx = pB.x - pA.x;
        const dy = pB.y - pA.y;
        const dz = pB.z - pA.z;
        const dist = Math.hypot(dx, dy, dz);
        const maxL = Math.max(0.15, Number(c.maxLength) || 4.0);
        const maxAllowed = maxL * (1.0 + (Number(c.springiness) || 0) * 0.35);

        if (dist >= maxAllowed * 0.98 && dist > 0.0001) {
          const nx = dx / dist;
          const ny = dy / dist;
          const nz = dz / dist;

          const wA = aMovable ? (1 / Math.max(1, clA.totalInertialMass)) : 0;
          const wB = bMovable ? (1 / Math.max(1, clB.totalInertialMass)) : 0;
          const wSum = wA + wB;
          if (wSum <= 0) continue;

          const shareA = wA / wSum;
          const shareB = wB / wSum;

          const rvx = (bMovable ? clB.vx : 0) - (aMovable ? clA.vx : 0);
          const rvy = (bMovable ? clB.vy : 0) - (aMovable ? clA.vy : 0);
          const rvz = (bMovable ? clB.vz : 0) - (aMovable ? clA.vz : 0);
          const sepVel = rvx * nx + rvy * ny + rvz * nz;

          if (sepVel > 0) {
            if (aMovable) {
              clA.vx += nx * sepVel * shareA;
              clA.vy += ny * sepVel * shareA;
              clA.vz += nz * sepVel * shareA;
            }
            if (bMovable) {
              clB.vx -= nx * sepVel * shareB;
              clB.vy -= ny * sepVel * shareB;
              clB.vz -= nz * sepVel * shareB;
            }
          }
        }
      }
    }
  }

  // 6. Применение скоростей и разрешение коллизий с миром
  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci];
    if (cl.isStaticAnchored || cl.members.some(m => m._isCarriedByPlayer)) continue;

    cl.wx = clamp(cl.wx, -5.5, 5.5);
    cl.wy = clamp(cl.wy, -5.5, 5.5);
    cl.wz = clamp(cl.wz, -5.5, 5.5);

    const angLen = Math.hypot(cl.wx, cl.wy, cl.wz);
    let rotQ = null;
    if (angLen > 0.001) {
      _vTmp2.set(cl.wx / angLen, cl.wy / angLen, cl.wz / angLen);
      _qStep.setFromAxisAngle(_vTmp2, angLen * dt);
      rotQ = _qStep;
    }

    transformWeldedCluster(cl, cl.vx * dt, cl.vy * dt, cl.vz * dt, rotQ, cl.com);

    let anyGrounded = false;

    for (let mi = 0; mi < cl.members.length; mi++) {
      const b = cl.members[mi];
      if (!b.components?.physics?.enabled || b.matterState !== 'solid') continue;
      b.physGrounded = false;

      for (let j = 0; j < all.length; j++) {
        const other = all[j];
        if (other === b || other._depletedDisabled || other._isCarriedByPlayer) continue;
        if (cl.members.includes(other)) continue;
        if (areBlocksLinkedByConstraint(b, other)) continue;
        if (other.components && !other.components.physics?.enabled) continue;
        if (other.matterState !== 'solid') continue;
        if (other.logicRuntime && other.logicRuntime.ghostOpen) continue;

        let colHit = null;
        const bShape = (!b.colliderShape || b.colliderShape === 'auto') ? (b.shape || 'box') : b.colliderShape;
        const oShape = (!other.colliderShape || other.colliderShape === 'auto') ? (other.shape || 'box') : other.colliderShape;

        if (bShape === 'torus') {
          colHit = resolveTorusVsBlockCollision(b, other);
        } else if (oShape === 'torus') {
          const rev = resolveTorusVsBlockCollision(other, b);
          if (rev) colHit = { pen: rev.pen, nx: -rev.nx, ny: -rev.ny, nz: -rev.nz };
        } else {
          const overlapX = Math.min(b.x1, other.x1) - Math.max(b.x0, other.x0);
          if (overlapX <= 0) continue;
          const overlapY = Math.min(b.y1, other.y1) - Math.max(b.y0, other.y0);
          if (overlapY <= 0) continue;
          const overlapZ = Math.min(b.z1, other.z1) - Math.max(b.z0, other.z0);
          if (overlapZ <= 0) continue;

          const dx = b.m.position.x - other.m.position.x;
          const dy = b.m.position.y - other.m.position.y;
          const dz = b.m.position.z - other.m.position.z;

          if (overlapY <= overlapX && overlapY <= overlapZ) {
            colHit = { pen: overlapY, nx: 0, ny: dy >= 0 ? 1 : -1, nz: 0 };
          } else if (overlapX <= overlapZ) {
            colHit = { pen: overlapX, nx: dx >= 0 ? 1 : -1, ny: 0, nz: 0 };
          } else {
            colHit = { pen: overlapZ, nx: 0, ny: 0, nz: dz >= 0 ? 1 : -1 };
          }
        }

        if (!colHit || colHit.pen <= 0) continue;

        transferEffectsOnContact(b, other, dt, true, 0.85);

        const otherCl = other._physCluster;
        const otherMovable = Boolean(other.isDynamicPhysics && (!otherCl || !otherCl.isStaticAnchored));

        if (Math.abs(colHit.ny) > 0.5) {
          if (colHit.ny > 0) {
            if (otherMovable && otherCl) {
              const m1 = cl.totalInertialMass;
              const m2 = otherCl.totalInertialMass;
              const tot = m1 + m2;
              transformWeldedCluster(cl, 0, colHit.pen * (m2 / tot), 0, null, null);
              transformWeldedCluster(otherCl, 0, -colHit.pen * (m1 / tot), 0, null, null);
              if (cl.vy < otherCl.vy) {
                const avgVy = (cl.vy * m1 + otherCl.vy * m2) / tot;
                cl.vy = avgVy;
                otherCl.vy = avgVy;
              }
            } else {
              transformWeldedCluster(cl, 0, colHit.pen, 0, null, null);
              if (cl.vy < 0) {
                const bounce = Math.max(b.bounciness || 0, other.bounciness || 0);
                cl.vy = bounce > 0 ? Math.min(14, Math.max(bounce * 0.7, -cl.vy * 0.5)) : 0;
              }
            }
            b.physGrounded = true;
            anyGrounded = true;

            const iceSlip = isBlockSlippery(b) || isBlockSlippery(other);
            const floorFric = iceSlip ? 0.72 : 0.015;
            cl.vx *= Math.pow(floorFric, dt);
            cl.vz *= Math.pow(floorFric, dt);
          } else {
            transformWeldedCluster(cl, 0, -colHit.pen, 0, null, null);
            if (cl.vy > 0) cl.vy = 0;
          }
        } else {
          if (otherMovable && otherCl) {
            const m1 = cl.totalInertialMass;
            const m2 = otherCl.totalInertialMass;
            const tot = m1 + m2;
            const s1 = m2 / tot;
            const s2 = m1 / tot;
            transformWeldedCluster(cl, colHit.nx * colHit.pen * s1, 0, colHit.nz * colHit.pen * s1, null, null);
            transformWeldedCluster(otherCl, -colHit.nx * colHit.pen * s2, 0, -colHit.nz * colHit.pen * s2, null, null);

            const relVx = cl.vx - otherCl.vx;
            const relVz = cl.vz - otherCl.vz;
            const closingSpd = -(relVx * colHit.nx + relVz * colHit.nz);

            if (closingSpd > 0) {
              const restitution = clamp(Math.max(b.bounciness || 0, other.bounciness || 0) * 0.05 + 0.28, 0.2, 0.75);
              const jImpulse = ((1 + restitution) * closingSpd) / (1 / m1 + 1 / m2);
              const ix = colHit.nx * jImpulse;
              const iz = colHit.nz * jImpulse;

              cl.vx = clamp(cl.vx + ix / m1, -26, 26);
              cl.vz = clamp(cl.vz + iz / m1, -26, 26);
              otherCl.vx = clamp(otherCl.vx - ix / m2, -26, 26);
              otherCl.vz = clamp(otherCl.vz - iz / m2, -26, 26);
            }
          } else {
            transformWeldedCluster(cl, colHit.nx * colHit.pen, 0, colHit.nz * colHit.pen, null, null);
            cl.vx *= -0.2;
            cl.vz *= -0.2;
          }
        }
      }

      if (b._throwGrace > 0) b._throwGrace = Math.max(0, b._throwGrace - dt);
      const horizSpd = Math.hypot(cl.vx, cl.vz);
      const spd3D = Math.hypot(cl.vx, cl.vy, cl.vz);
      if (spd3D > 4.2 && (b._hitEntCd || 0) <= 0) {
        const mBlk = cl.totalInertialMass;
        const targets = [...S.customNPCs];
        if (player && !S.playerDead && !b._riderIsPlayer && player._supportBlock !== b) {
          targets.push(player);
        }

        for (let ti = 0; ti < targets.length; ti++) {
          const ent = targets[ti];
          if (!ent || ent.isDisabled || ent._deadCooldown > 0 || ent._permanentlyDead) continue;
          if (ent === b._thrownBy && (b._throwGrace || 0) > 0) continue;

          const er = ent.colliderRadius || 0.42;
          const eh = ent.colliderHeight || 2.5;
          const isFallingOnHead = cl.vy < -5.2 && b.y0 >= ent.y + eh * 0.4;
          if (!isFallingOnHead && ent.y >= b.y1 - 0.35) continue;
          if (!testPlayerOBB(ent.x, ent.y, ent.z, er + 0.1, eh, b)) continue;

          const mEnt = getEntityWeight(ent);
          // Сила сбивания с ног зависит от скорости полёта и соотношения весов (тяжёлый медленный или средний быстрый объект роняет цель)
          const weightFactor = Math.pow(mBlk / Math.max(15, mEnt), 0.62);
          const impactPower = spd3D * weightFactor;

          if (impactPower > 2.4) {
            b._hitEntCd = 0.48;
            transferEffectsOnContact(b, ent, 0, true, 1.1);
            let nxI, nzI;
            if (horizSpd > 0.6) {
              nxI = cl.vx / horizSpd;
              nzI = cl.vz / horizSpd;
            } else {
              const ddx = ent.x - b.m.position.x;
              const ddz = ent.z - b.m.position.z;
              const ddl = Math.hypot(ddx, ddz) || 1;
              nxI = ddx / ddl;
              nzI = ddz / ddl;
            }
            const kbForce = clamp(impactPower * 1.45, 4.0, 20.0);

            if (impactPower > 4.2 && ent.hpEnabled) {
              const dmg = Math.round(clamp((impactPower - 3.4) * 4.5, 4, 85));
              dealDamage(ent, dmg, b._thrownBy || null, 0, { skipAutoRagdoll: true });
            } else {
              sfx.hit?.();
              spawnDamageParticles(ent);
            }

            if (!(ent._deadCooldown > 0) && !ent._permanentlyDead && !(ent.isP && S.playerDead)) {
              const knockChance = clamp(((impactPower - 2.4) / 4.8) * rnd(0.85, 1.15), 0, 0.96);
              if (Math.random() < knockChance) {
                triggerEntityRagdoll(
                  ent,
                  nxI * kbForce,
                  clamp(3.2 + impactPower * 0.25, 3.0, 6.8),
                  nzI * kbForce,
                  clamp(1.4 + impactPower * 0.12, 1.4, 2.8)
                );
                applyEntityStun(ent, 0.85);
              } else {
                triggerEntityStagger(ent, nxI, nzI, clamp(impactPower / 4.5, 0.5, 1.3), clamp(kbForce * 0.6, 3.0, 9.5));
                applyEntityStun(ent, 0.65);
              }
            }

            // Передача импульса обратно на блок (отскок/торможение)
            const slowFactor = clamp(1 - (mEnt / (mBlk + mEnt)) * 0.72, 0.2, 0.9);
            cl.vx *= slowFactor;
            cl.vz *= slowFactor;
            if (isFallingOnHead) cl.vy = Math.max(1.5, -cl.vy * 0.25);
            break;
          }
        }
      }

      if (b._hitEntCd > 0) b._hitEntCd = Math.max(0, b._hitEntCd - dt);
    }

    if (anyGrounded && !cl.anyInLiquid) {
      computeAlignmentToTargetUp(cl.root, _vWorldUp, _vTiltAxis, _angleBox);
      if (_angleBox.angle > 0.004) {
        const pullTorque = worldGrav * 0.55 * Math.sin(_angleBox.angle * 1.8);
        cl.wx = (cl.wx + _vTiltAxis.x * pullTorque * dt) * Math.pow(0.02, dt);
        cl.wy = (cl.wy + _vTiltAxis.y * pullTorque * dt) * Math.pow(0.02, dt);
        cl.wz = (cl.wz + _vTiltAxis.z * pullTorque * dt) * Math.pow(0.02, dt);
      } else {
        cl.wx = 0; cl.wy = 0; cl.wz = 0;
      }
    }

    cl.anyGrounded = anyGrounded;

    for (let mi = 0; mi < cl.members.length; mi++) {
      const mb = cl.members[mi];
      mb.physVx = cl.vx;
      mb.physVy = cl.vy;
      mb.physVz = cl.vz;
      mb.physWx = cl.wx;
      mb.physWy = cl.wy;
      mb.physWz = cl.wz;
      if (cl.anyGrounded) mb.physGrounded = true;
    }
  }

  // 7. Финальная позиционная коррекция верёвок С ГАШЕНИЕМ СКОРОСТИ РАСТЯЖЕНИЯ (убирает вибрацию мостов!)
  for (let iter = 0; iter < 8; iter++) {
    for (let ri = 0; ri < activeRopes.length; ri++) {
      const { c, bA, bB, clA, clB } = activeRopes[ri];
      const aMovable = Boolean(clA && !clA.isStaticAnchored && !clA.members.some(m => m._isCarriedByPlayer));
      const bMovable = Boolean(clB && !clB.isStaticAnchored && !clB.members.some(m => m._isCarriedByPlayer));
      if (!aMovable && !bMovable) continue;

      const pA = new THREE.Vector3(c.localAnchorA?.x || 0, c.localAnchorA?.y || 0, c.localAnchorA?.z || 0);
      bA.m.localToWorld(pA);
      const pB = new THREE.Vector3(c.localAnchorB?.x || 0, c.localAnchorB?.y || 0, c.localAnchorB?.z || 0);
      bB.m.localToWorld(pB);

      const dx = pB.x - pA.x;
      let dy = pB.y - pA.y;
      const dz = pB.z - pA.z;
      const dist = Math.hypot(dx, dy, dz);
      const maxL = Math.max(0.15, Number(c.maxLength) || 4.0);
      const maxAllowed = maxL * (1.0 + (Number(c.springiness) || 0) * 0.35);

      if (dist > maxAllowed && dist > 0.001) {
        const excess = dist - maxAllowed;
        let wA = aMovable ? (1 / Math.max(1, clA.totalInertialMass)) : 0;
        let wB = bMovable ? (1 / Math.max(1, clB.totalInertialMass)) : 0;

        if ((clA && clA._suppressAntiGravOnLand && clA.anyGrounded) || (clB && clB._suppressAntiGravOnLand && clB.anyGrounded)) {
          dy = 0;
        }

        const wSum = wA + wB;
        if (wSum <= 0) continue;

        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;
        const sA = wA / wSum;
        const sB = wB / wSum;

        if (aMovable && wA > 0) {
          transformWeldedCluster(clA, nx * excess * sA, ny * excess * sA, nz * excess * sA, null, null);
        }
        if (bMovable && wB > 0) {
          transformWeldedCluster(clB, -nx * excess * sB, -ny * excess * sB, -nz * excess * sB, null, null);
        }

        // Гасим скорость, направленную на растяжение троса, чтобы доска моста не падала и не дёргалась каждый кадр
        const rvx = (bMovable ? clB.vx : 0) - (aMovable ? clA.vx : 0);
        const rvy = (bMovable ? clB.vy : 0) - (aMovable ? clA.vy : 0);
        const rvz = (bMovable ? clB.vz : 0) - (aMovable ? clA.vz : 0);
        const sepVel = rvx * nx + rvy * ny + rvz * nz;
        if (sepVel > 0) {
          if (aMovable && wA > 0) {
            clA.vx = (clA.vx + nx * sepVel * sA) * 0.92;
            clA.vy = (clA.vy + ny * sepVel * sA) * 0.92;
            clA.vz = (clA.vz + nz * sepVel * sA) * 0.92;
          }
          if (bMovable && wB > 0) {
            clB.vx = (clB.vx - nx * sepVel * sB) * 0.92;
            clB.vy = (clB.vy - ny * sepVel * sB) * 0.92;
            clB.vz = (clB.vz - nz * sepVel * sB) * 0.92;
          }
        }
      }
    }
  }

  // 7.5. Физическое натяжение и жёсткий предел верёвок для объекта в руках игрока
  if (player && !S.playerDead && player.carriedPhysicsBlock && activeRopes.length > 0) {
    const cb = player.carriedPhysicsBlock;
    const carriedCl = cb._physCluster;
    const pWeight = getEntityWeight(player);
    const carriedMass = pWeight + (carriedCl ? carriedCl.totalInertialMass : getInertialMass(cb.weight));

    for (let iter = 0; iter < 5; iter++) {
      for (let ri = 0; ri < activeRopes.length; ri++) {
        const { c, bA, bB, clA, clB } = activeRopes[ri];
        const aCarried = Boolean(bA === cb || (carriedCl && clA === carriedCl));
        const bCarried = Boolean(bB === cb || (carriedCl && clB === carriedCl));
        if (!aCarried && !bCarried) continue;
        if (aCarried && bCarried) continue;

        const carriedBlk = aCarried ? bA : bB;
        const otherBlk = aCarried ? bB : bA;
        const otherCl = aCarried ? clB : clA;
        const anchorC = aCarried ? c.localAnchorA : c.localAnchorB;
        const anchorO = aCarried ? c.localAnchorB : c.localAnchorA;

        const pCar = _vTmp1.set(anchorC?.x || 0, anchorC?.y || 0, anchorC?.z || 0);
        carriedBlk.m.localToWorld(pCar);
        const pOth = _vTmp2.set(anchorO?.x || 0, anchorO?.y || 0, anchorO?.z || 0);
        otherBlk.m.localToWorld(pOth);

        const dx = pCar.x - pOth.x;
        const dy = pCar.y - pOth.y;
        const dz = pCar.z - pOth.z;
        const dist = Math.hypot(dx, dy, dz);
        const maxL = Math.max(0.15, Number(c.maxLength) || 4.0);
        if (dist <= maxL || dist < 0.0001) continue;

        const spr = clamp(Number(c.springiness) ?? 0.25, 0, 1);
        const stiffness = 1.0 - spr * 0.85; // 1.0 (жёсткий трос) .. 0.15 (мягкая пружина)
        const maxElasticStretch = maxL * (0.04 + spr * 0.55);
        const hardMaxLen = maxL + maxElasticStretch;

        const nx = dx / dist;
        const ny = dy / dist;
        const nz = dz / dist;

        const otherMovable = Boolean(otherCl && !otherCl.isStaticAnchored);
        const otherMass = otherMovable ? Math.max(1, otherCl.totalInertialMass) : Infinity;

        // Доля нагрузки на игрока vs второй объект
        const playerShare = otherMovable ? (otherMass / (carriedMass + otherMass)) : 1.0;
        const otherShare = 1.0 - playerShare;

        const stretch = dist - maxL;
        const tensionRatio = clamp(stretch / Math.max(0.05, maxElasticStretch), 0, 1.4);

        // Накопление сопротивления движению игрока и упругой тяги назад (на 1-й итерации)
        if (iter === 0) {
          const resist = clamp(tensionRatio * (0.45 + stiffness * 0.55) * Math.pow(playerShare, 0.55), 0, 0.98);
          if (resist > (player._ropeResistStrength || 0)) {
            const hLen = Math.hypot(nx, nz) || 1;
            player._ropeResistStrength = resist;
            player._ropeResistDirX = nx / hLen;
            player._ropeResistDirZ = nz / hLen;
          }
          // Упругая сила возврата пружины/троса на игрока и второй блок
          const pullAccel = stretch * (4.5 + stiffness * 14.0);
          player._ropePullX = (player._ropePullX || 0) - nx * pullAccel * playerShare;
          player._ropePullZ = (player._ropePullZ || 0) - nz * pullAccel * playerShare;

          if (otherMovable && otherShare > 0.001) {
            const othPull = pullAccel * otherShare * dt;
            otherCl.vx = clamp(otherCl.vx + nx * othPull, -24, 24);
            otherCl.vy = clamp(otherCl.vy + ny * othPull, -24, 14);
            otherCl.vz = clamp(otherCl.vz + nz * othPull, -24, 24);
          }
        }

        // Жёсткий предел растяжения: верёвка физически не пускает игрока дальше!
        if (dist > hardMaxLen) {
          const excess = dist - hardMaxLen;
          const pBackX = -nx * excess * playerShare;
          const pBackY = -ny * excess * playerShare;
          const pBackZ = -nz * excess * playerShare;

          player.x += pBackX;
          player.z += pBackZ;
          if (pBackY < -0.001 && !player.grounded) {
            player.y += pBackY;
            if (player.vy > 0) player.vy *= 0.5;
          }

          if (carriedCl && !carriedCl.isStaticAnchored) {
            transformWeldedCluster(carriedCl, pBackX, pBackY, pBackZ, null, null);
          } else {
            cb.m.position.x += pBackX;
            cb.m.position.y += pBackY;
            cb.m.position.z += pBackZ;
            cb.m.updateMatrixWorld();
            updateBlockOBB(cb);
          }

          if (otherMovable && otherShare > 0.001) {
            transformWeldedCluster(otherCl, nx * excess * otherShare, ny * excess * otherShare, nz * excess * otherShare, null, null);
          }
        }
      }
    }
  }

  for (let ci = 0; ci < clusters.length; ci++) {
    const cl = clusters[ci];
    for (let mi = 0; mi < cl.members.length; mi++) {
      const mb = cl.members[mi];
      mb.physVx = cl.vx;
      mb.physVy = cl.vy;
      mb.physVz = cl.vz;
      mb.physWx = cl.wx;
      mb.physWy = cl.wy;
      mb.physWz = cl.wz;
      if (cl.anyGrounded) mb.physGrounded = true;
    }
  }

  // 8. Единовременный перенос игрока на итоговую дельту смещения опорного блока за кадр (без масштабно-искажённого localToWorld!)
  if (
    player &&
    !S.playerDead &&
    !player.isFlying &&
    (player.grounded || (player._groundedAnimTimer || 0) > 0) &&
    (player._jumpGraceTimer || 0) <= 0 &&
    !(S.keys.Space || S.btnJump)
  ) {
    const sup = player._supportBlock;
    if (sup && !sup._depletedDisabled && sup.isDynamicPhysics && sup._frameStartX !== undefined) {
      player.x += sup.m.position.x - sup._frameStartX;
      player.y += sup.m.position.y - sup._frameStartY;
      player.z += sup.m.position.z - sup._frameStartZ;
      player.grounded = true;
      player._groundedAnimTimer = 0.18;
    }
  }

  renderPhysicsConstraintsVisuals();
} 

export function findNearestWorldItem(player, maxDist = 4.2) {
  if (!player) return null;
  let best = null;
  let bestDist = maxDist;
  for (const wi of S.worldItems) {
    if (!wi || wi.isDisabled || wi.pickupCooldown > 0) continue;
    const d = Math.hypot(wi.x - player.x, wi.y - (player.y + 1.0), wi.z - player.z);
    if (d < bestDist) {
      bestDist = d;
      best = wi;
    }
  }
  return best;
}

export function findNearestKeyEBlock(player, maxDist = 5.0) {
  if (!player) return null;
  let best = null;
  let bestDist = maxDist;
  for (const b of S.allBlocks) {
    if (b.isDisabled || b._depletedDisabled || b._interactionDisabled) continue;
    const comps = b.components;
    const hasInteractE = comps?.interaction?.enabled && b.interactionData?.trigger === 'keyE';
    const hasSelfMotionE = comps?.motion?.enabled && b.motionData?.triggerMode === 'self' && (!comps?.interaction?.enabled || b.interactionData?.trigger === 'keyE');
    const hasModularItem = Boolean(comps?.item?.enabled);
    const hasLegacyLogicE = !comps && b.logicData && b.logicData.trigger === 'keyE';
    const hasSpawnerE = (!comps || comps.spawner?.enabled) && b.spawnerData && b.spawnerData.mode === 'keyE';
    const hasScriptE = Boolean(comps?.script?.enabled && b.scriptData?.enabled && b.scriptData?.hasInteractHook);
    if (!hasInteractE && !hasSelfMotionE && !hasModularItem && !hasLegacyLogicE && !hasSpawnerE && !hasScriptE) continue;

    const cx = b.m.position.x;
    const cy = b.m.position.y;
    const cz = b.m.position.z;
    const hw = (b.w || 1) * 0.5;
    const hh = (b.h || 1) * 0.5;
    const hd = (b.d || 1) * 0.5;

    const dx = Math.max((cx - hw) - player.x, 0, player.x - (cx + hw));
    const dy = Math.max((cy - hh) - (player.y + 1.2), 0, (player.y + 1.2) - (cy + hh));
    const dz = Math.max((cz - hd) - player.z, 0, player.z - (cz + hd));
    const d = Math.hypot(dx, dy, dz);
    if (d < bestDist) {
      bestDist = d;
      best = b;
    }
  }
  return best;
}

export function updateBlocksLogicRuntime(dt, player) {
  for (const b of S.allBlocks) {
    if (b.isDisabled) continue;
    const rt = ensureBoxRuntime(b);
    const comps = b.components;

    if (rt.cdTimer > 0) rt.cdTimer = Math.max(0, rt.cdTimer - dt);

    // 1. Таймер респавна для израсходованных / уничтоженных объектов
    if (b._depletedDisabled && rt.respawnTimer > 0) {
      rt.respawnTimer -= dt;
      if (rt.respawnTimer <= 0) {
        rt.respawnTimer = 0;
        b._depletedDisabled = false;
        b._interactionDisabled = false;
        if (b.interactionData && b.interactionData.maxCharges) {
          b.interactionData.chargesLeft = b.interactionData.maxCharges;
        }
        b.m.visible = !b.editorHidden;
        if (b.cpVisualGroup) b.cpVisualGroup.visible = true;
        if (b.haloSprite) b.haloSprite.visible = true;
        syncBlockSpecialVisuals(b);
        updateBlockOBB(b);
      }
      continue;
    }

    if (b._depletedDisabled) continue;

    // 2. Проверка активации «В радиусе (radius)» из блока Взаимодействие (для Игрока и для NPC с физикой)
    if (
      comps?.interaction?.enabled &&
      b.interactionData?.trigger === 'radius' &&
      rt.cdTimer <= 0
    ) {
      const rDist = Math.max(0.5, Number(b.interactionData.radiusDist) || 3.5);
      let triggeredByAnyone = false;
      if (player && !S.playerDead) {
        const d = Math.hypot(
          b.m.position.x - player.x,
          b.m.position.y - (player.y + 1.1),
          b.m.position.z - player.z
        );
        if (d <= rDist) {
          triggerBlockLogic(b, 'radius', player);
          triggeredByAnyone = true;
        }
      }
      if (!triggeredByAnyone && S.customNPCs.length > 0) {
        for (let ni = 0; ni < S.customNPCs.length; ni++) {
          const npc = S.customNPCs[ni];
          if (!npc || npc._deadCooldown > 0 || !npc.aiModules?.worldPhysics?.enabled) continue;
          const dN = Math.hypot(
            b.m.position.x - npc.x,
            b.m.position.y - (npc.y + 1.1),
            b.m.position.z - npc.z
          );
          if (dN <= rDist) {
            triggerBlockLogic(b, 'radius', npc);
            break;
          }
        }
      }
    }

    // 3. Таймер призрачного прохода (Ghost Pass)
    if (rt.ghostOpen && rt.stayTimer > 0) {
      rt.stayTimer -= dt;
      if (rt.stayTimer <= 0) {
        rt.ghostOpen = false;
        if (b.m.material) {
          b.m.material.transparent = b.matterState !== 'solid';
          b.m.material.opacity = b.matterState === 'solid' ? 1.0 : 0.72;
        }
      }
    }

    // 4. Микро-анимация ручки двери / рычага / кнопки при нажатии
    if (rt.animActive && comps?.signal?.enabled && b.signalData) {
      rt.animT += dt * 4.5;
      const sg = b.signalData;
      const pulse = Math.sin(Math.min(1, rt.animT) * Math.PI);
      const prevPos = b.m.position.clone();
      const prevQuat = b.m.quaternion.clone();

      if (sg.selfAnim === 'lever_tilt') {
        const tiltRad = THREE.MathUtils.degToRad((Number(sg.animAngle) || 35) * pulse);
        const tiltQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tiltRad);
        b.m.quaternion.copy(rt.baseQuat).multiply(tiltQ);
        b.m.rotation.setFromQuaternion(b.m.quaternion);
      } else if (sg.selfAnim === 'button_press') {
        const pressDepth = (Number(sg.animOffset) || 0.15) * pulse;
        b.m.position.set(rt.basePos.x, rt.basePos.y - pressDepth, rt.basePos.z);
      }

      if (rt.animT >= 1.0) {
        rt.animActive = false;
        rt.animT = 0;
        b.m.position.copy(rt.basePos);
        b.m.quaternion.copy(rt.baseQuat);
        b.m.rotation.setFromQuaternion(b.m.quaternion);
      }
      b.m.updateMatrixWorld();
      updateBlockOBB(b);
      propagateBlockChildrenInPlay(b, prevPos, prevQuat, b.m.position, b.m.quaternion, player);
    }

    // 5. Многоточечное движение с дверными петлями и изменением Позиции, Вращения и Размера
    if (comps?.motion?.enabled && b.motionData) {
      const md = b.motionData;
      const maxU = Math.max(1, Array.isArray(md.waypoints) ? md.waypoints.length : 1);
      const speed = Math.max(0.1, Number(md.speed) || 1.5);

      // Режимы автоматического цикла
      if (md.triggerMode === 'auto_loop' || md.loopMode === 'ping_pong' || md.loopMode === 'loop') {
        if (md.loopMode === 'loop') {
          rt.openT += speed * dt;
          if (rt.openT > maxU) rt.openT = 0;
          rt.targetU = rt.openT;
        } else {
          if (rt.pingPongDir === undefined) rt.pingPongDir = 1;
          rt.openT += rt.pingPongDir * speed * dt;
          if (rt.openT >= maxU) {
            rt.openT = maxU;
            rt.pingPongDir = -1;
          } else if (rt.openT <= 0) {
            rt.openT = 0;
            rt.pingPongDir = 1;
          }
          rt.targetU = rt.openT;
        }
      } else {
        // Авто-возврат по таймеру после достижения конечной точки
        if (md.loopMode === 'auto_return' && rt.targetU >= maxU && Math.abs(rt.openT - maxU) < 0.01 && rt.stayTimer > 0) {
          rt.stayTimer -= dt;
          if (rt.stayTimer <= 0) {
            rt.targetU = 0;
            rt.targetOpen = false;
            sfx.gate();
          }
        }

        const desiredU = rt.targetU ?? (rt.targetOpen ? maxU : 0);
        if (Math.abs(rt.openT - desiredU) > 0.0001) {
          if (rt.openT < desiredU) {
            rt.openT = Math.min(desiredU, rt.openT + speed * dt);
          } else {
            rt.openT = Math.max(desiredU, rt.openT - speed * dt);
          }
        } else {
          continue;
        }
      }

      const prevPos = b.m.position.clone();
      const prevQuat = b.m.quaternion.clone();

      const st = evaluateBlockMotionAtProgress(b, rt.openT);
      b.m.position.copy(st.pos);
      b.m.quaternion.copy(st.quat);
      b.m.scale.copy(st.scale);
      b.m.rotation.setFromQuaternion(b.m.quaternion);
      b.w = st.scale.x;
      b.h = st.scale.y;
      b.d = st.scale.z;
      b.m.updateMatrixWorld();
      updateBlockOBB(b);

      if (b.cpVisualGroup) b.cpVisualGroup.position.copy(b.m.position);
      if (b.haloSprite) b.haloSprite.position.copy(b.m.position);

      // Перемещаем и вращаем все дочерние объекты (например, ручку двери) синхронно с родителем
      propagateBlockChildrenInPlay(b, prevPos, prevQuat, b.m.position, b.m.quaternion, player);

      // Перенос игрока, стоящего на движущейся платформе / мосту
      if (player && !S.playerDead && b.matterState === 'solid') {
        const dx = b.m.position.x - prevPos.x;
        const dy = b.m.position.y - prevPos.y;
        const dz = b.m.position.z - prevPos.z;
        if (
          player.x + 0.4 >= b.x0 &&
          player.x - 0.4 <= b.x1 &&
          player.z + 0.4 >= b.z0 &&
          player.z - 0.4 <= b.z1 &&
          Math.abs(player.y - b.y1) < 0.45
        ) {
          player.x += dx;
          player.y += dy;
          player.z += dz;
        }
      }
    }
  }
}

// ЯКОРЬ ПОСЛЕ: /* ---------- УРОН, БРОНЯ, РОНЯНИЕ КОНТЕЙНЕРОВ И БОЕВАЯ СИСТЕМА ПРЕДМЕТОВ ---------- */

/* ---------- УРОН, БРОНЯ, РОaaНЯНИЕ КОНТЕЙНЕРОВ И БОЕВАЯ СИСТЕМА ПРЕДМЕТОВ ---------- */

const MAX_NPC_DROPPED_ITEMS = 45;
const NPC_DROP_DESPAWN_SEC = 60;

function spawnOptimizedDroppedItem(itemData, x, y, z, vx = 0, vy = 3.2, vz = 0) {
  if (!itemData) return null;
  const nameKey = itemData.name || '';
  const typeKey = itemData.useType || 'melee';
  let sameClusterCount = 0;
  let oldestSameInCluster = null;

  // 1. Слияние одинаковых расходуемых/стрелковых/метательных предметов в радиусе 2.4м
  for (let i = 0; i < S.worldItems.length; i++) {
    const wi = S.worldItems[i];
    if (!wi || wi.isDisabled || !wi._isNpcDrop) continue;
    const d = Math.hypot(wi.x - x, wi.z - z);
    if (d <= 2.4 && wi.item?.name === nameKey && wi.item?.useType === typeKey) {
      if (typeKey === 'throwable') {
        wi.item.stackCount = (wi.item.stackCount || 1) + (itemData.stackCount || 1);
        wi._dropAge = 0;
        if (wi.tag) {
          updateTag(wi.tag, `${wi.item.icon || '💣'} Подобрать [E]`, `${wi.item.name} (x${wi.item.stackCount})`, 'Стак лута');
        }
        return wi;
      }
      if (typeKey === 'ranged' && !wi.item.infiniteAmmo) {
        wi.item.reserveAmmo = (wi.item.reserveAmmo || 0) + (itemData.ammo || itemData.magSize || 12);
        wi._dropAge = 0;
        if (wi.tag) {
          updateTag(wi.tag, `${wi.item.icon || '🔫'} Подобрать [E]`, wi.item.name, `Боезапас: ${wi.item.ammo}/${wi.item.reserveAmmo}`);
        }
        return wi;
      }
      sameClusterCount++;
      if (!oldestSameInCluster || (wi._dropAge || 0) > (oldestSameInCluster._dropAge || 0)) {
        oldestSameInCluster = wi;
      }
    }
  }

  // Не плодим больше 2 одинаковых мечей/предметов в одной куче — обновляем самый старый
  if (sameClusterCount >= 2 && oldestSameInCluster) {
    oldestSameInCluster._dropAge = 0;
    oldestSameInCluster._physSleep = false;
    oldestSameInCluster.vy = 2.6;
    return oldestSameInCluster;
  }

  // 2. Глобальный лимит выпавших предметов в мире (удаляем самый старый/дальний дроп)
  const droppedList = S.worldItems.filter(w => w && w._isNpcDrop);
  if (droppedList.length >= MAX_NPC_DROPPED_ITEMS) {
    droppedList.sort((a, b) => (b._dropAge || 0) - (a._dropAge || 0));
    const victim = droppedList[0];
    const vIdx = S.worldItems.indexOf(victim);
    if (vIdx >= 0) {
      if (victim.group) scene.remove(victim.group);
      if (victim.tag) scene.remove(victim.tag);
      S.worldItems.splice(vIdx, 1);
      syncWorldItemDeleteToNetwork(victim.id);
    }
  }

  const wi = spawnWorldItem(itemData, x, y, z, vx, vy, vz);
  if (wi) {
    wi._isNpcDrop = true;
    wi._dropAge = 0;
    wi._dropMaxAge = NPC_DROP_DESPAWN_SEC;
    wi._physSleep = false;
    syncWorldItemUpsertToNetwork(wi, false);
  }
  return wi;
}

export function dealDamage(target, amount, attacker = null, customKnockback = 8, opts = null) {
  if (!target || target.isDisabled || !target.hpEnabled || amount <= 0) return false;
  if (target.isP && S.playerDead) return false;
  if (target._deadCooldown > 0 || target._permanentlyDead) return false;

  // Если атакуемая цель — удалённый игрок, сразу обновляем его полоску HP локально и отправляем пакет урона ему!
  if (target.isRemotePlayer) {
    const dx = target.x - (attacker ? attacker.x : target.x);
    const dz = target.z - (attacker ? attacker.z : target.z);
    const d = Math.hypot(dx, dz) || 1;
    const vxK = attacker ? (dx / d) * customKnockback : 0;
    const vzK = attacker ? (dz / d) * customKnockback : 0;
    target.hp = Math.max(0, (target.hp ?? 100) - amount);
    target.hpBarTimer = 3.5;
    sfx.hit();
    spawnDamageParticles(target);
    refreshEntityTagWithHP(target);
    if (!attacker || attacker === S.player || isLocalNpcAuthority()) {
      broadcastMultiplayerPacket({
        type: 'hit_player',
        targetPeerId: target.peerId,
        damage: amount,
        vxKnock: vxK,
        vzKnock: vzK,
        attackerName: attacker?.name || S.playerName || 'Игрок'
      });
    }
    return true;
  }

  // Если мы Гость (не авторитет NPC) и бьём кастомного NPC — отправляем запрос урона Хосту
  if (target.isCustomNPC && !isLocalNpcAuthority() && !target._fromNetDamage) {
    let vxK = 0;
    let vzK = 0;
    if (attacker) {
      const dx = target.x - attacker.x;
      const dz = target.z - attacker.z;
      const d = Math.hypot(dx, dz) || 1;
      vxK = (dx / d) * customKnockback;
      vzK = (dz / d) * customKnockback;
    }
    if (attacker === S.player) {
      sfx.hit();
      spawnDamageParticles(target);
      target.hpBarTimer = 3.5;
      refreshEntityTagWithHP(target);
      broadcastMultiplayerPacket({
        type: 'npc_damage',
        npcId: target.id,
        damage: amount,
        vxKnock: vxK,
        vzKnock: vzK
      });
    }
    return true;
  }

  // Учёт экипированного предмета (Броня / Неуязвимость / Роняние 2-ручного предмета при ударе)
  if (target.isP) {
    if (target.carriedItem && target.carriedItem.dropOnHit !== false) {
      dropHeldOrCarriedItem(target, 3.8, `💥 Ты получил урон и выронил «${target.carriedItem.name}»!`);
    }
    const held = getActiveHeldItem(target);
    if (held && !isItemFrozen(held)) {
      if (held.equipStats && held.equipStats.invulnerable) {
        sfx.shieldBlock();
        showBanner(`🛡️ «${held.name}» полностью заблокировал урон!`, '#56f0ff');
        return false;
      }
      const armorPct = clamp(Number(held.equipStats?.armorPct) || 0, 0, 90);
      if (armorPct > 0) {
        amount = Math.max(1, amount * (1 - armorPct / 100));
      }
    }
  }

  target.hp = Math.max(0, target.hp - amount);
  target.hpBarTimer = 3.5;
  target._lastCombatTime = S.time || 0;
  if (attacker) attacker._lastCombatTime = S.time || 0;
  if (target.isCustomNPC) {
    runNpcScriptHook(target, 'onDamaged', { amount, attacker });
  }
  sfx.hit();
  spawnDamageParticles(target);

  if (attacker) {
    const dx = target.x - attacker.x;
    const dz = target.z - attacker.z;
    const d = Math.hypot(dx, dz) || 1;
    target.vxKnock = (dx / d) * customKnockback;
    target.vzKnock = (dz / d) * customKnockback;
    if (target.isCustomNPC) {
      const mods = ensureNpcModules(target);
      if (mods.combat?.enabled && mods.combat.stance !== 'neutral') {
        target._aggroTarget = attacker;
        target._aggroTimer = 14.0;
        broadcastFactionCallForHelp(target, attacker, 28);
      }
      target.chat = (mods.dialogue?.enabled && mods.dialogue.aggroChat)
        ? mods.dialogue.aggroChat
        : 'АЙ! За что?! 😡';
      target.chatT = 3.5;
    } else if (target.isP) {
      // Если атаковали игрока — умные NPC из фракции Союзников ('allies') сразу вступаются за него!
      broadcastFactionCallForHelp(target, attacker, 28);
    } else if (!target.isP && !target.isArchangel) {
      target.chat = 'АЙ! За что?! 😡';
      target.chatT = 3.5;
    }
  }

  const isFatal = target.hp <= 0;

  if (!isFatal && !opts?.skipAutoRagdoll && !target.isRemotePlayer) {
    let impDirX = opts?.impDirX ?? 0;
    let impDirZ = opts?.impDirZ ?? 0;
    if (impDirX === 0 && impDirZ === 0 && attacker) {
      const adx = target.x - attacker.x;
      const adz = target.z - attacker.z;
      const al = Math.hypot(adx, adz) || 1;
      impDirX = adx / al;
      impDirZ = adz / al;
    }
    const hasDir = Math.hypot(impDirX, impDirZ) > 0.05;
    if (evaluateRagdollChance(target, amount, Boolean(opts?.isKick))) {
      const kbMag = clamp(Math.max(5.5, Number(customKnockback) || 8), 5.5, 20);
      const dxR = hasDir ? impDirX : -Math.sin(target.rot || 0);
      const dzR = hasDir ? impDirZ : -Math.cos(target.rot || 0);
      triggerEntityRagdoll(target, dxR * kbMag, clamp(3.4 + kbMag * 0.16, 3.2, 6.8), dzR * kbMag, 1.8);
    } else if (hasDir && customKnockback >= 4) {
      // Лёгкое пошатывание при сильном ударе, если рэгдолл не сработал
      triggerEntityStagger(target, impDirX, impDirZ, clamp(amount / Math.max(1, target.maxHp || 100) * 1.4, 0.35, 1.0), 0);
    }
  }

  if (target.isCustomNPC && isFatal) {
    runNpcScriptHook(target, 'onDeath', { attacker });
  } else if (target.isP && isFatal) {
    runWorldScriptHook('onPlayerDeath', {});
  }

  // Если мы авторитет NPC и в комнате есть другие игроки — рассылаем визуальный отклик попадания / смерти NPC
  if (target.isCustomNPC && isLocalNpcAuthority() && Object.keys(S.remotePlayers || {}).length > 0) {
    broadcastMultiplayerPacket({
      type: 'npc_hit_fx',
      npcId: target.id,
      hp: target.hp,
      maxHp: target.maxHp,
      fatal: isFatal,
      chat: target.chat
    });
  }

  refreshEntityTagWithHP(target);
  if (target.isP) updateShopUI();

  if (isFatal) {
    if (target.isP) {
      if (target.carriedItem) dropHeldOrCarriedItem(target, 2.0);
      oofRespawn('💀 Твоё здоровье упало до 0!');
    } else {
      sfx.oof();
      spawnDeathShatter(target);

      let respawnDelaySec = 3.5;
      let isPermanentDeath = false;
      if (target.isCustomNPC) {
        const mods = ensureNpcModules(target);
        isPermanentDeath = Boolean(target.permanentDeath || mods.dialogue?.permanentDeath);
        respawnDelaySec = Math.max(0.5, Number(mods.dialogue?.respawnTime) || 3.5);
        if (mods.dialogue?.enabled) {
          const dropCoins = Math.max(0, Number(mods.dialogue.dropCoins) || 0);
          if (dropCoins > 0 && attacker) {
            if (attacker.isP) {
              const earned = dropCoins * (attacker.hasHalo ? 2 : 1);
              attacker.cash = (attacker.cash || 0) + earned;
              sfx.cash();
              updateShopUI();
              showBanner(`🪙 +${earned} R$ за победу над «${target.name}»!`, '#ffce3a');
            } else if (attacker.isRemotePlayer && attacker.peerId) {
              broadcastMultiplayerPacket({
                type: 'npc_kill_reward',
                targetPeerId: attacker.peerId,
                coins: dropCoins,
                npcName: target.name
              });
            }
          }
        // NPC всегда выбрасывает экипированный предмет после смерти (если явно не снята галочка dropEquippedItem)
        if (mods.dialogue?.dropEquippedItem !== false && target.equippedItem) {
          spawnOptimizedDroppedItem(target.equippedItem, target.x, target.y + 1.2, target.z, rnd(-2.2, 2.2), 3.8, rnd(-2.2, 2.2));
        }
        }
      }

      target.hp = 0;
      target.hpBarTimer = 0;
      target.ragdoll = null;
      target._permanentlyDead = isPermanentDeath;
      target._deadCooldown = isPermanentDeath ? Infinity : respawnDelaySec;
      target._aggroTarget = null;
      target._aggroTimer = 0;
      target.vxKnock = 0;
      target.vzKnock = 0;
      target.vy = 0;
      if (target.rig?.g) target.rig.g.visible = false;
      if (target.tag) target.tag.visible = false;

      if (S.gameMode && S.gameMode.onEntityKnockout) {
        S.gameMode.onEntityKnockout(target, attacker);
      }

      if (isPermanentDeath) {
        return true;
      }

      // Для кастомных NPC респавн обрабатывается строго по dt в updateCustomNPCsRuntime
      if (!target.isCustomNPC) {
        setTimeout(() => {
          if (!target || !target.rig || target._permanentlyDead) return;
          target._deadCooldown = 0;
          target.hp = target.maxHp || 100;
          target.rig.g.rotation.set(0, target.rot || 0, 0);
          target.rig.g.visible = true;
          if (target.tag) target.tag.visible = true;
          refreshEntityTagWithHP(target);
        }, Math.round(respawnDelaySec * 1000));
      }
    }
    if (target.isP) updateShopUI();
  }
  return true;
}

window.__debixApplyRemoteNpcDamage = (npc, pkt, remoteAttacker) => {
  if (!npc || !pkt) return;
  npc._fromNetDamage = true;
  try {
    dealDamage(npc, Number(pkt.damage) || 15, remoteAttacker || null, 8);
    if (pkt.vxKnock !== undefined) npc.vxKnock = Number(pkt.vxKnock) || 0;
    if (pkt.vzKnock !== undefined) npc.vzKnock = Number(pkt.vzKnock) || 0;
  } finally {
    npc._fromNetDamage = false;
  }
};

window.__debixApplyRemotePlayerHit = pkt => {
  const p = S.player;
  if (!p || S.playerDead || !pkt) return;
  const dmg = Math.max(0, Number(pkt.damage) || 0);
  if (dmg > 0) {
    dealDamage(p, dmg, null, 0);
  }
  if (!S.playerDead) {
    p.vxKnock = (p.vxKnock || 0) + (Number(pkt.vxKnock) || 0);
    p.vzKnock = (p.vzKnock || 0) + (Number(pkt.vzKnock) || 0);
  }
};

// Вычисляет мировую точку вылета снаряда (Muzzle / Throw Point) и точный вектор в центр прицела (Crosshair)
export function computeMuzzleAndAim(player, item) {
  if (player.rig && player.rig.activeItemGroup) {
    if (player.isP) {
      player.rot = S.yaw + Math.PI;
      player.rig.g.rotation.set(0, player.rot, 0);
    }
    player.rig.g.updateMatrixWorld(true);
    const holder = player.rig.activeItemGroup.userData.partsHolder || player.rig.activeItemGroup;
    _vMuzzleWorld.set(
      item.muzzlePoint?.x || 0,
      item.muzzlePoint?.y || 0.15,
      item.muzzlePoint?.z ?? -0.8
    );
    holder.localToWorld(_vMuzzleWorld);
  } else {
    const yawAngle = player.isP ? S.yaw : (player.rot + Math.PI);
    const fx = -Math.sin(yawAngle);
    const fz = -Math.cos(yawAngle);
    _vMuzzleWorld.set(player.x + fx * 0.9, player.y + 1.65, player.z + fz * 0.9);
  }

  // Если стреляет или бросает NPC — прицеливаемся в его цель с плавающим шансом меткости
  if (!player.isP) {
    const tgt = player._aggroTarget || S.player;
    if (tgt && !(tgt.isP && S.playerDead)) {
      _vTargetPt.set(tgt.x, tgt.y + 1.25, tgt.z);
    } else {
      _vTargetPt.set(
        player.x + Math.sin(player.rot) * 15,
        player.y + 1.25,
        player.z + Math.cos(player.rot) * 15
      );
    }

    const mods = player.aiModules;
    const baseAcc = clamp(Number(mods?.combat?.accuracy ?? 0.75), 0.05, 1.0);
    const distToTgt = _vTargetPt.distanceTo(_vMuzzleWorld);

    // Плавающий шанс меткости: волнообразное колебание во времени + случайный сдвиг + штраф за дистанцию и модуль ошибок
    const waveDrift = Math.sin(S.time * 2.1 + (player.homeX || 0)) * 0.12 + rnd(-0.14, 0.14);
    const distPenalty = clamp((distToTgt - 6) * 0.012, 0, 0.25);
    const humanPenalty = mods?.humanError?.enabled
      ? (Number(mods.humanError.aimError) || 0.2) * (Number(mods.humanError.mistakeLevel) || 0.25) * 0.65
      : 0;
    const floatingAcc = clamp(baseAcc + waveDrift - distPenalty - humanPenalty, 0.05, 0.99);

    const isAccurateHit = Math.random() < floatingAcc;
    if (!isAccurateHit) {
      // Промах по плавающему шансу: заметное отклонение мимо цели
      const missMag = (1.15 - floatingAcc) * clamp(distToTgt * 0.22, 1.2, 4.8);
      const sideSign = Math.random() < 0.5 ? -1 : 1;
      _vTargetPt.x += sideSign * rnd(0.65, 1.25) * missMag;
      _vTargetPt.y += rnd(-0.45, 0.65) * missMag;
      _vTargetPt.z += (Math.random() < 0.5 ? -1 : 1) * rnd(0.65, 1.25) * missMag;
    } else {
      // Попадание в створ цели с естественным микро-разбросом
      const tightJitter = (1.0 - floatingAcc) * 0.75;
      _vTargetPt.x += rnd(-tightJitter, tightJitter);
      _vTargetPt.y += rnd(-tightJitter * 0.5, tightJitter * 0.5);
      _vTargetPt.z += rnd(-tightJitter, tightJitter);
    }

    _vAimDir.subVectors(_vTargetPt, _vMuzzleWorld);
    const dist = _vAimDir.length() || 1;
    const g = (S.worldSettings.gravity || 22) * (Number(item.gravityFactor) ?? (item.useType === 'throwable' ? 1 : 0));
    if (g > 0.001) {
      const spd = Math.max(6, Number(item.projSpeed) || 26);
      const tFlight = Math.min(1.5, dist / spd);
      _vAimDir.y += 0.5 * g * tFlight * tFlight;
    }
    _vAimDir.normalize();
    return { origin: _vMuzzleWorld, dir: _vAimDir };
  }

  const cp = Math.cos(S.pitch);
  _vCamFwd.set(-Math.sin(S.yaw) * cp, Math.sin(S.pitch), -Math.cos(S.yaw) * cp).normalize();

  // Для метательных снарядов — навесная парабола по направлению взгляда
  if (item.useType === 'throwable') {
    _vAimDir.set(_vCamFwd.x, _vCamFwd.y + 0.22, _vCamFwd.z).normalize();
    return { origin: _vMuzzleWorld, dir: _vAimDir };
  }

  // Для стрелкового оружия — сведение луча из дула ровно в точку под 2D-перекрестием в центре экрана
  const camDist = player.isP ? syncPlayCameraToPlayer(player, 0) : 6.0;
  _aimRaycaster.set(camera.position, _vCamFwd);
  _aimRaycaster.near = Math.max(0.5, camDist - 0.25);
  const maxR = Math.max(60, Number(item.maxRange) || 85);
  _aimRaycaster.far = maxR * 1.4;

  const targets = [];
  for (const b of S.allBlocks) {
    if (b.matterState === 'solid' && !(b.logicRuntime && b.logicRuntime.ghostOpen)) {
      targets.push(b.m);
    }
  }
  const extraTargets = (S.gameMode && S.gameMode.getExtraTargets) ? S.gameMode.getExtraTargets() : [];
  for (const t of [...S.customNPCs, ...extraTargets]) {
    if (t && t !== player && !(t._deadCooldown > 0) && t.rig && t.rig.g) {
      targets.push(t.rig.g);
    }
  }

  const hits = _aimRaycaster.intersectObjects(targets, true);
  if (hits.length > 0) {
    _vTargetPt.copy(hits[0].point);
  } else {
    _vTargetPt.copy(camera.position).addScaledVector(_vCamFwd, maxR);
  }

  _vAimDir.subVectors(_vTargetPt, _vMuzzleWorld);
  const distToTarget = _vAimDir.length();

  // Если цель слишком близко к камере/спине, стреляем строго параллельно взгляду камеры
  if (distToTarget < 0.8 || _vAimDir.dot(_vCamFwd) <= 0.1) {
    _vAimDir.copy(_vCamFwd);
  } else {
    // Компенсация гравитационного падения снаряда на дистанции полёта, чтобы попадать точно в перекрестие
    const g = (S.worldSettings.gravity || 22) * (Number(item.gravityFactor) ?? 0);
    if (g > 0.001) {
      const spd = Math.max(6, Number(item.projSpeed) || 38);
      const tFlight = Math.min(1.6, distToTarget / spd);
      _vAimDir.y += 0.5 * g * tFlight * tFlight;
    }
    _vAimDir.normalize();
  }

  return { origin: _vMuzzleWorld, dir: _vAimDir };
}

export function consumeItemDurability(player, item, costAmount) {
  if (!item || item.infiniteDurability) return false;
  item.durability = Math.max(0, (item.durability ?? item.maxDurability) - costAmount);
  if (item.durability <= 0) {
    const brokenName = item.name;
    if (player.inventory && player.inventory[S.activeSlot] === item) {
      player.inventory[S.activeSlot] = null;
    }
    syncEntityHeldItemMesh(player);
    renderHotbarUI();
    updateShopUI();
    sfx.oof();
    showBanner(`💔 Предмет «${brokenName}» израсходован / сломался!`, '#ffce3a');
    return true;
  }
  renderHotbarUI();
  return false;
}

export function spawnProjectile(owner, item, speedMult = 1.0) {
  if (S.activeProjectiles.length >= 64) {
    const oldest = S.activeProjectiles.shift();
    if (oldest && oldest.group) scene.remove(oldest.group);
  }

  const { origin, dir } = computeMuzzleAndAim(owner, item);
  const baseSpread = Number(item.spread) || 0;
  const spread = owner && owner.isP && S.isAimingRMB ? baseSpread * 0.15 : baseSpread * 0.5;
  const dx = dir.x + (spread > 0 ? rnd(-spread, spread) : 0);
  const dy = dir.y + (spread > 0 ? rnd(-spread, spread) : 0);
  const dz = dir.z + (spread > 0 ? rnd(-spread, spread) : 0);
  const len = Math.hypot(dx, dy, dz) || 1;

  const spd = Math.max(4, (Number(item.projSpeed) || 30) * speedMult);
  const vx = (dx / len) * spd;
  const vy = (dy / len) * spd;
  const vz = (dz / len) * spd;

  const group = buildItemGroup(item, { isProjectile: true, showMarkers: false, applyGripOffset: false });
  group.position.copy(origin);
  group.lookAt(origin.x + dx, origin.y + dy, origin.z + dz);
  scene.add(group);

  const projEntry = {
    owner,
    item,
    group,
    x: origin.x,
    y: origin.y,
    z: origin.z,
    vx,
    vy,
    vz,
    gravity: (S.worldSettings.gravity || 22) * (Number(item.gravityFactor) ?? 0),
    damage: Number(item.damage) ?? 25,
    blastRadius: Number(item.blastRadius) || 0,
    knockback: Number(item.knockback) || 9,
    distTraveled: 0,
    maxRange: Math.max(10, Number(item.maxRange) || 65),
    age: 0
  };
  S.activeProjectiles.push(projEntry);

  if (Object.keys(S.remotePlayers || {}).length > 0) {
    const netProj = {
      x: Math.round(origin.x * 100) / 100,
      y: Math.round(origin.y * 100) / 100,
      z: Math.round(origin.z * 100) / 100,
      vx: Math.round(vx * 100) / 100,
      vy: Math.round(vy * 100) / 100,
      vz: Math.round(vz * 100) / 100,
      item
    };
    if (owner && owner.isP) {
      broadcastMultiplayerPacket({
        type: 'player_projectile',
        projectile: netProj
      });
    } else if (owner && owner.isCustomNPC && isLocalNpcAuthority()) {
      broadcastMultiplayerPacket({
        type: 'npc_action_fx',
        npcId: owner.id,
        rot: owner.rot,
        style: item.useType === 'throwable' ? 'punch' : 'shoot',
        projectile: netProj
      });
    }
  }

  return projEntry;
}

window.__debixSpawnVisualProjectileFromNet = (owner, netProj) => {
  if (!netProj || !netProj.item) return;
  if (S.activeProjectiles.length >= 64) {
    const oldest = S.activeProjectiles.shift();
    if (oldest && oldest.group) scene.remove(oldest.group);
  }
  const item = netProj.item;
  const group = buildItemGroup(item, { isProjectile: true, showMarkers: false, applyGripOffset: false });
  group.position.set(netProj.x, netProj.y, netProj.z);
  group.lookAt(netProj.x + netProj.vx, netProj.y + netProj.vy, netProj.z + netProj.vz);
  scene.add(group);

  S.activeProjectiles.push({
    owner: owner || null,
    item,
    group,
    x: netProj.x,
    y: netProj.y,
    z: netProj.z,
    vx: netProj.vx,
    vy: netProj.vy,
    vz: netProj.vz,
    gravity: (S.worldSettings.gravity || 22) * (Number(item.gravityFactor) ?? 0),
    damage: Number(item.damage) ?? 25,
    blastRadius: Number(item.blastRadius) || 0,
    knockback: Number(item.knockback) || 9,
    distTraveled: 0,
    maxRange: Math.max(10, Number(item.maxRange) || 65),
    age: 0,
    isRemoteVisual: true
  });
};

export function cancelReloadHold(showCancelMsg = false) {
  const rHud = ensureReloadHoldHUD();
  rHud.hidden = true;
  const wasReloading = S.isReloadingHold;
  S.isReloadingHold = false;
  S.reloadHoldT = 0;
  if (S.player) {
    S.player.reloadTimer = 0;
  }
  if (wasReloading && showCancelMsg) {
    showBanner('⚠️ Перезарядка прервана! Удерживай [R] до заполнения шкалы.', '#ffce3a');
  }
}

export function reloadActiveWeapon() {
  const player = S.player;
  if (!player || S.state !== 'play' || S.playerDead) return false;
  const item = getActiveHeldItem(player);
  if (!item || item.useType !== 'ranged') return false;
  if (isItemFrozen(item)) {
    showBanner(`❄️ Предмет «${item.name}» заморожен и не работает!`, '#56f0ff');
    return false;
  }
  if (item.infiniteAmmo || item.ammo >= item.magSize) return false;
  if ((item.reserveAmmo ?? 0) <= 0) {
    sfx.oof();
    showBanner(`❌ Нет запасных снарядов для «${item.name}»!`, '#ff3e3e');
    return false;
  }
  if (S.isReloadingHold) return true;

  const totalRel = Math.max(0.3, Number(item.reloadTime) || 1.2);
  S.isReloadingHold = true;
  S.reloadHoldT = 0;
  player.reloadTimer = totalRel;
  const rHud = ensureReloadHoldHUD();
  rHud.hidden = false;
  $('reloadHoldLbl').textContent = `🔄 УДЕРЖИВАЙ [R]: 0% (${totalRel.toFixed(1)}с)`;
  $('reloadHoldFill').style.width = '0%';
  sfx.coil();
  return true;
}

export function releaseChargedThrow() {
  const player = S.player;
  const hud = ensureThrowChargeHUD();
  hud.hidden = true;
  if (!S.isChargingThrow) return;
  S.isChargingThrow = false;

  if (!player || S.state !== 'play' || S.playerDead) return;
  const item = getActiveHeldItem(player);
  if (!item || item.useType !== 'throwable') return;
  if (isEntityFrozen(player) || isItemFrozen(item)) return;

  const maxChg = Math.max(0.25, Number(item.maxChargeTime) || 1.1);
  const ratio = clamp(S.throwChargeT / maxChg, 0.0, 1.0);
  S.throwChargeT = 0;

  const minSpd = Number(item.minThrowSpeed) || 8;
  const maxSpd = Math.max(minSpd + 2, Number(item.projSpeed) || 26);
  const finalSpd = minSpd + (maxSpd - minSpd) * ratio;
  const speedMult = finalSpd / maxSpd;

  player.rot = S.yaw + Math.PI;
  if (player.rig) player.rig.g.rotation.set(0, player.rot, 0);

  triggerEntityAttack(player, 'punch');
  sfx.slap();
  spawnProjectile(player, item, speedMult);
  player.attackCooldown = Math.max(0.2, Number(item.cooldown) || 0.4);

  if (!item.infiniteAmmo) {
    item.stackCount = Math.max(0, (item.stackCount ?? 1) - 1);
    if (item.stackCount <= 0) {
      player.inventory[S.activeSlot] = null;
      syncEntityHeldItemMesh(player);
      showBanner(`${item.icon || '💣'} Запас «${item.name}» закончился!`, '#ffce3a');
    }
  }
  renderHotbarUI();
}

/* ---------- ФИЗИКА РЭГДОЛА (ИГРОК И NPC) И ПИНОК DARK MESSIAH [Q] ---------- */

/* ---------- ПЛАВАЮЩИЙ ШАНС РЭГДОЛА, ПОШАТЫВАНИЕ И ТОЧНАЯ ФИЗИКА ПАДЕНИЯ ---------- */

export function evaluateRagdollChance(target, damageAmount, isKick = false) {
  if (!target || damageAmount <= 0) return false;
  const maxHp = Math.max(1, Number(target.maxHp) || 100);
  // Базовый шанс равен доле урона от HP (1/100 -> ~1%, 80/100 -> ~80%) с плавающим разбросом ±15%
  const baseRatio = Math.max(0, Number(damageAmount) || 0) / maxHp;
  let floatingChance = baseRatio * rnd(0.85, 1.15);
  if (isKick) {
    floatingChance *= 1.5;
  }
  return Math.random() < clamp(floatingChance, 0, 0.98);
}

export function triggerEntityStagger(ent, dirX = 0, dirZ = 0, strength = 1.0, pushSpeed = 5.5) {
  if (!ent || ent.isDisabled || ent._deadCooldown > 0 || ent._permanentlyDead) return false;
  if (ent.isP && S.playerDead) return false;
  if (ent.ragdoll && ent.ragdoll.active) return false;

  const hLen = Math.hypot(dirX, dirZ) || 1;
  const nx = dirX / hLen;
  const nz = dirZ / hLen;

  ent.stagger = {
    timer: 0.46,
    duration: 0.46,
    dirX: nx,
    dirZ: nz,
    strength: clamp(strength, 0.4, 1.6)
  };
  ent.vxKnock = (ent.vxKnock || 0) + nx * pushSpeed;
  ent.vzKnock = (ent.vzKnock || 0) + nz * pushSpeed;
  if (ent.isCustomNPC) {
    ent.attackCooldown = Math.max(ent.attackCooldown || 0, 0.48);
  }
  sfx.stagger?.();
  return true;
}

export function applyEntityStun(ent, duration = 1.25) {
  if (!ent || ent.isDisabled || ent._deadCooldown > 0 || ent._permanentlyDead) return false;
  if (ent.isP && S.playerDead) return false;
  if (ent.isRemotePlayer) return false;

  const d = clamp(Number(duration) || 1.2, 0.25, 5.0);
  ent.stunTimer = Math.max(ent.stunTimer || 0, d);
  ent.attackCooldown = Math.max(ent.attackCooldown || 0, d * 0.85);
  if (ent.isP) {
    S.isChargingThrow = false;
    S.throwChargeT = 0;
    if (S.isReloadingHold) cancelReloadHold(false);
  } else {
    ent.reloadTimer = 0;
  }
  return true;
}

export function registerPlayerRagdollStruggle(power = 1.0) {
  const p = S.player;
  if (!p || S.playerDead || !p.ragdoll || !p.ragdoll.active) return false;
  const rd = p.ragdoll;
  const now = performance.now() * 0.001;
  // Защита от дребезга и автоповтора — засчитываются живые нажатия клавиш и клики
  if (now - (rd._lastStruggleAt || 0) < 0.085) return false;
  rd._lastStruggleAt = now;
  rd.struggleCount = (rd.struggleCount || 0) + 1;

  const cut = 0.26 * clamp(power, 0.5, 1.5);
  rd.timer = Math.max(0, rd.timer - cut);
  rd.maxTime = Math.max(rd.elapsed + 0.35, rd.maxTime - cut * 0.85);

  // Визуальный рывок тела и конечностей при попытке подняться
  rd.vWobble = clamp((rd.vWobble || 0) + (rd.struggleCount % 2 === 0 ? 1 : -1) * 3.8, -6.5, 6.5);
  if (rd.limbs) {
    rd.limbs.armL.vrx -= 5.2;
    rd.limbs.armR.vrx -= 5.2;
    rd.limbs.legL.vrx += 4.0;
    rd.limbs.legR.vrx -= 4.0;
  }
  if (rd.grounded) {
    rd.vx *= 0.72;
    rd.vz *= 0.72;
  }
  sfx.gizmoTick?.(0.6);
  return true;
}

// Проверка прямой видимости между атакующим и целью (защита от ударов сквозь глухие стены)
function isMeleeLineOfSightClear(originX, originY, originZ, targetX, targetY, targetZ) {
  const dx = targetX - originX;
  const dy = targetY - originY;
  const dz = targetZ - originZ;
  const dist = Math.hypot(dx, dy, dz);
  if (dist < 0.45) return true;

  _vTmp1.set(originX, originY, originZ);
  _vTmp2.set(dx / dist, dy / dist, dz / dist);
  _aimRaycaster.set(_vTmp1, _vTmp2);
  _aimRaycaster.near = 0.15;
  _aimRaycaster.far = dist - 0.2;

  const minX = Math.min(originX, targetX) - 0.5;
  const maxX = Math.max(originX, targetX) + 0.5;
  const minY = Math.min(originY, targetY) - 0.5;
  const maxY = Math.max(originY, targetY) + 0.5;
  const minZ = Math.min(originZ, targetZ) - 0.5;
  const maxZ = Math.max(originZ, targetZ) + 0.5;

  _nearbySolidMeshes.length = 0;
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b.isDisabled || b._depletedDisabled || b._isCarriedByPlayer) continue;
    if (b.matterState !== 'solid' || (b.logicRuntime && b.logicRuntime.ghostOpen)) continue;
    if (b.components && !b.components.physics?.enabled) continue;
    if (b.x1 < minX || b.x0 > maxX || b.y1 < minY || b.y0 > maxY || b.z1 < minZ || b.z0 > maxZ) continue;
    if (b.m) _nearbySolidMeshes.push(b.m);
  }
  if (_nearbySolidMeshes.length === 0) return true;
  return _aimRaycaster.intersectObjects(_nearbySolidMeshes, false).length === 0;
}

const _rdFallAxis = new THREE.Vector3();
const _rdQuatYaw = new THREE.Quaternion();
const _rdQuatTip = new THREE.Quaternion();
const _rdQuatWobble = new THREE.Quaternion();

export function triggerEntityRagdoll(ent, impX = 0, impY = 4.5, impZ = 0, duration = 2.0) {
  if (!ent || ent.isDisabled || ent._deadCooldown > 0 || ent._permanentlyDead) return false;
  if (ent.isP && S.playerDead) return false;
  if (ent.isRemotePlayer) return false;

  if (ent.isP) {
    ent.isFlying = false;
    S.isChargingThrow = false;
    S.throwChargeT = 0;
    if (S.isReloadingHold) cancelReloadHold(false);
    if (ent.carriedPhysicsBlock) dropCarriedPhysicsBlock(ent, 2.2);
    if (ent.carriedItem) dropHeldOrCarriedItem(ent, 3.0);
  }

  const spdXZ = Math.hypot(impX, impZ);
  let dirX, dirZ;
  if (spdXZ > 0.08) {
    dirX = impX / spdXZ;
    dirZ = impZ / spdXZ;
  } else {
    // Если удар строго вертикальный (падение сверху) — валим по текущему направлению лица
    dirX = Math.sin(ent.rot || 0);
    dirZ = Math.cos(ent.rot || 0);
  }

  const wasActive = Boolean(ent.ragdoll && ent.ragdoll.active);
  const rndLimb = (scale = 6) => ({
    rx: rnd(-0.55, 0.55),
    rz: rnd(-0.45, 0.45),
    vrx: rnd(-scale, scale),
    vrz: rnd(-scale, scale)
  });

  if (wasActive) {
    const rd = ent.ragdoll;
    rd.vx = clamp(rd.vx + impX, -28, 28);
    rd.vy = clamp(Math.max(rd.vy, impY), -25, 16);
    rd.vz = clamp(rd.vz + impZ, -28, 28);
    rd.timer = Math.max(rd.timer, duration);
    rd.maxTime = Math.max(rd.maxTime, rd.elapsed + duration + 1.5);
    // Плавный доворот оси падения к новому импульсу
    rd.fallDirX = dirX;
    rd.fallDirZ = dirZ;
    rd.vFallAngle = clamp(rd.vFallAngle + rnd(2.5, 5.0), -10, 10);
    rd.vWobble += rnd(-3.2, 3.2);
  } else {
    ent.stagger = null;
    ent.ragdoll = {
      active: true,
      timer: clamp(duration, 0.9, 5.0),
      maxTime: clamp(duration + 1.8, 2.2, 6.5),
      elapsed: 0,
      recoverTimer: 0,
      vx: clamp((ent.vxKnock || 0) * 0.35 + impX, -28, 28),
      vy: clamp(Math.max(ent.vy || 0, impY), -25, 16),
      vz: clamp((ent.vzKnock || 0) * 0.35 + impZ, -28, 28),
      // Направление падения в мире (голова падает строго по направлению толчка!)
      fallDirX: dirX,
      fallDirZ: dirZ,
      fallAngle: 0,
      vFallAngle: clamp(4.6 + spdXZ * 0.32, 3.8, 10.0),
      wobble: 0,
      vWobble: rnd(-2.2, 2.2),
      vYaw: rnd(-1.4, 1.4),
      grounded: false,
      bounces: 0,
      limbs: {
        torso: { rx: 0, rz: 0, vrx: rnd(-2.5, 2.5), vrz: rnd(-2.5, 2.5) },
        head: rndLimb(6),
        armL: rndLimb(8),
        armR: rndLimb(8),
        legL: rndLimb(7),
        legR: rndLimb(7)
      }
    };
  }

  ent.vxKnock = 0;
  ent.vzKnock = 0;
  ent.grounded = false;
  ent._supportBlock = null;
  ent.activeEmote = null;
  return true;
}

function applyRagdollRigPose(ent, rd) {
  if (!ent?.rig?.g || !rd) return;
  const fLen = Math.hypot(rd.fallDirX, rd.fallDirZ) || 1;
  const dx = rd.fallDirX / fLen;
  const dz = rd.fallDirZ / fLen;
  // Мировая ось опрокидывания: up (0,1,0) × fallDir (dx,0,dz) = (dz, 0, -dx)
  _rdFallAxis.set(dz, 0, -dx).normalize();
  _rdQuatTip.setFromAxisAngle(_rdFallAxis, rd.fallAngle);
  _rdQuatWobble.setFromAxisAngle(_vTmp3.set(dx, 0, dz), rd.wobble || 0);
  _rdQuatYaw.setFromAxisAngle(_vWorldUp, ent.rot || 0);

  ent.rig.g.quaternion.copy(_rdQuatTip).multiply(_rdQuatWobble).multiply(_rdQuatYaw).normalize();
  ent.rig.g.rotation.setFromQuaternion(ent.rig.g.quaternion);

  const sinA = Math.sin(clamp(rd.fallAngle, 0, Math.PI * 0.55));
  const layLift = sinA * 0.34;
  // Центрируем лежащее тело вокруг коллайдера, чтобы голова не уходила в стену
  const centerShift = sinA * 0.92;
  ent.rig.g.position.set(
    ent.x - dx * centerShift,
    ent.y + layLift,
    ent.z - dz * centerShift
  );
  if (ent.tag) {
    ent.tag.position.set(ent.x, ent.y + (3.35 - sinA * 1.45), ent.z);
  }
}

export function updateEntityRagdollPhysics(ent, dt) {
  const rd = ent?.ragdoll;
  if (!rd) return false;

  // Фаза плавного вставания на ноги из точного направления падения
  if (!rd.active) {
    if (rd.recoverTimer > 0) {
      rd.recoverTimer = Math.max(0, rd.recoverTimer - dt);
      const t = 1 - Math.exp(-16 * dt);
      rd.fallAngle += (0 - rd.fallAngle) * t;
      rd.wobble += (0 - rd.wobble) * t;
      applyRagdollRigPose(ent, rd);
      if (rd.recoverTimer <= 0) {
        ent.ragdoll = null;
        if (ent.rig?.g) {
          ent.rig.g.position.set(ent.x, ent.y, ent.z);
          ent.rig.g.rotation.set(0, ent.rot || 0, 0);
          ent.rig.g.quaternion.setFromEuler(ent.rig.g.rotation);
        }
      }
      return true;
    }
    ent.ragdoll = null;
    if (ent.rig?.g) {
      ent.rig.g.position.set(ent.x, ent.y, ent.z);
      ent.rig.g.rotation.set(0, ent.rot || 0, 0);
      ent.rig.g.quaternion.setFromEuler(ent.rig.g.rotation);
    }
    return false;
  }

  rd.elapsed += dt;
  rd.timer -= dt;

  const grav = S.worldSettings.gravity ?? 22;
  const pr = 0.54;
  const ph = 0.92;

  let inLiq = false;
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b.isDisabled || b._depletedDisabled || b.matterState !== 'liquid') continue;
    if (testPlayerOBB(ent.x, ent.y, ent.z, pr, ph, b)) {
      inLiq = true;
      if (b.damageOnContact > 0 && (ent._hazardDamageCd || 0) <= 0) {
        ent._hazardDamageCd = 0.55;
        dealDamage(ent, b.damageOnContact, null, 2, { skipAutoRagdoll: true });
      }
      if (b.teleportToCheckpoint) {
        if (ent.isP) oofRespawn('🌊 Водоворот поглотил тебя!');
        else dealDamage(ent, (ent.maxHp || 100) * 10, null, 0, { skipAutoRagdoll: true });
        return true;
      }
      break;
    }
  }
  ent.inLiquid = inLiq;

  if (inLiq) {
    rd.vy = clamp(rd.vy - grav * 0.22 * dt, -5, 4);
    const wDamp = Math.exp(-4.5 * dt);
    rd.vx *= wDamp;
    rd.vz *= wDamp;
    rd.timer -= dt * 0.7;
  } else {
    rd.vy = Math.max(-34, rd.vy - grav * dt);
    const airDamp = Math.pow(0.75, dt);
    rd.vx *= airDamp;
    rd.vz *= airDamp;
  }

  const prevVy = rd.vy;
  ent.x += rd.vx * dt;
  ent.y += rd.vy * dt;
  ent.z += rd.vz * dt;
  rd.grounded = false;

  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || b.isDisabled || b._depletedDisabled || b._isCarriedByPlayer || b.matterState === 'liquid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (b.components && !b.components.physics?.enabled) continue;

    const hit = testPlayerOBB(ent.x, ent.y, ent.z, pr, ph, b);
    if (!hit) continue;

    if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'touch') || (b.logicData && b.logicData.trigger === 'touch')) {
      triggerBlockLogic(b, 'touch', ent);
    }
    if (b.matterState === 'gas') {
      if (b.bounciness > 0) rd.vy = b.bounciness;
      if (b.teleportToCheckpoint) {
        if (ent.isP) oofRespawn('☁️ Газовая ловушка уничтожила тебя!');
        else dealDamage(ent, (ent.maxHp || 100) * 10, null, 0, { skipAutoRagdoll: true });
        return true;
      }
      continue;
    }

    if (b.matterState === 'solid') {
      if (b.damageOnContact > 0 && (ent._hazardDamageCd || 0) <= 0) {
        ent._hazardDamageCd = 0.5;
        dealDamage(ent, b.damageOnContact, null, 2, { skipAutoRagdoll: true });
        if (ent._deadCooldown > 0 || (ent.isP && S.playerDead)) return true;
      }
      if (b.teleportToCheckpoint) {
        if (ent.isP) oofRespawn('💥 Тебя отбросило в смертельную ловушку!');
        else dealDamage(ent, (ent.maxHp || 100) * 10, null, 0, { skipAutoRagdoll: true });
        return true;
      }

      if (hit.ny > 0.45) {
        // Контакт с полом
        ent.y += hit.pen / Math.max(0.45, hit.ny);
        const impactY = Math.abs(prevVy);
        if (impactY > 5.0 && rd.bounces < 3) {
          rd.vy = impactY * (b.bounciness > 0 ? 0.65 : 0.25);
          rd.bounces++;
          rd.vWobble += rnd(-2.5, 2.5);
          for (const k of Object.keys(rd.limbs)) {
            rd.limbs[k].vrx += rnd(-4.5, 4.5);
            rd.limbs[k].vrz += rnd(-4.5, 4.5);
          }
          sfx.hit?.();
          if (impactY > 14.5 && ent.hpEnabled) {
            const fallDmg = Math.round((impactY - 12.5) * 3.8);
            if (fallDmg > 0) dealDamage(ent, fallDmg, null, 0, { skipAutoRagdoll: true });
          }
        } else {
          rd.vy = b.bounciness > 0 ? b.bounciness * 0.7 : 0;
          rd.grounded = true;
          const floorFriction = Math.exp(-7.5 * dt);
          rd.vx *= floorFriction;
          rd.vz *= floorFriction;
        }
        if (b.conveyorVx) ent.x += b.axisX.x * b.conveyorVx * dt;
        if (b.conveyorVz) ent.z += b.axisZ.z * b.conveyorVz * dt;
      } else if (hit.ny < -0.45) {
        ent.y += hit.ny * hit.pen;
        if (rd.vy > 0) rd.vy = -rd.vy * 0.3;
      } else {
        // Удар об стену / колонну / ящик
        const hLen = Math.hypot(hit.nx, hit.nz) || 1;
        const nx = hit.nx / hLen;
        const nz = hit.nz / hLen;
        ent.x += nx * hit.pen;
        ent.z += nz * hit.pen;

        const closing = -(rd.vx * nx + rd.vz * nz);
        if (closing > 1.2) {
          if (b.isDynamicPhysics) {
            // Летящее тело сносит физические ящики (эффект домино!)
            const entW = getEntityWeight(ent);
            const pushK = clamp(entW / 55, 0.5, 2.5);
            applyImpulseToDynamicBlock(
              b,
              -nx * closing * 0.9 * pushK,
              Math.max(1.5, closing * 0.25),
              -nz * closing * 0.9 * pushK,
              new THREE.Vector3(ent.x - nx * pr, ent.y + 0.5, ent.z - nz * pr)
            );
            rd.vx *= 0.65;
            rd.vz *= 0.65;
          } else {
            // Жёсткий отскок от стены + урон при сильном ударе (Dark Messiah!)
            rd.vx += nx * closing * 1.35;
            rd.vz += nz * closing * 1.35;
            rd.vWobble += rnd(-3, 3);
            if (closing > 8.0) {
              sfx.hit?.();
              spawnDamageParticles(ent);
              if (ent.hpEnabled) {
                const wallDmg = Math.round(clamp((closing - 6.5) * 2.8, 5, 45));
                dealDamage(ent, wallDmg, null, 0, { skipAutoRagdoll: true });
                if (ent._deadCooldown > 0 || (ent.isP && S.playerDead)) return true;
              }
            }
          }
        }
      }
    }
  }

  // Цепная реакция: летящий в рэгдоле персонаж сбивает других NPC с ног по направлению полёта
  const flySpd = Math.hypot(rd.vx, rd.vz);
  if (flySpd > 6.5) {
    for (let ni = 0; ni < S.customNPCs.length; ni++) {
      const other = S.customNPCs[ni];
      if (!other || other.isDisabled || other === ent || other._deadCooldown > 0 || other._permanentlyDead || other.ragdoll?.active) continue;
      if (Math.hypot(other.x - ent.x, other.z - ent.z) < 1.1 && Math.abs(other.y - ent.y) < 1.8) {
        triggerEntityRagdoll(other, rd.vx * 0.72, 3.6, rd.vz * 0.72, 1.8);
        rd.vx *= 0.55;
        rd.vz *= 0.55;
        sfx.hit?.();
      }
    }
  }

  // Падение в бездну
  if (ent.y < -18) {
    if (ent.isP && !S.playerDead) {
      oofRespawn('☁️ Ты улетел в бездну!');
    } else if (!ent.isP && !(ent._deadCooldown > 0)) {
      dealDamage(ent, (ent.maxHp || 100) * 10, null, 0, { skipAutoRagdoll: true });
    }
    return true;
  }

  // Пружинно-демпферное падение строго вдоль fallDir до PI/2 (лежа на полу)
  const targetAngle = Math.PI * 0.5;
  if (rd.grounded) {
    rd.vFallAngle += (targetAngle - rd.fallAngle) * 36 * dt;
    rd.vFallAngle *= Math.exp(-10 * dt);
    rd.vWobble += (0 - rd.wobble) * 18 * dt;
    rd.vWobble *= Math.exp(-9 * dt);
    rd.vYaw *= Math.exp(-8 * dt);
  } else {
    rd.vFallAngle += (targetAngle - rd.fallAngle) * 6 * dt;
    rd.vFallAngle *= Math.exp(-2.2 * dt);
    rd.vWobble *= Math.exp(-2.0 * dt);
    rd.vYaw *= Math.exp(-2.0 * dt);
  }

  rd.fallAngle = clamp(rd.fallAngle + rd.vFallAngle * dt, 0.05, Math.PI * 0.62);
  rd.wobble = clamp(rd.wobble + rd.vWobble * dt, -0.5, 0.5);
  ent.rot = (ent.rot || 0) + rd.vYaw * dt;

  const limbs = rd.limbs;
  for (const key of Object.keys(limbs)) {
    const lm = limbs[key];
    const restX = rd.grounded ? (key.startsWith('arm') ? -0.35 : 0.08) : 0;
    const restZ = key === 'armL' ? 0.55 : (key === 'armR' ? -0.55 : (key === 'legL' ? 0.18 : (key === 'legR' ? -0.18 : 0)));
    const stiff = rd.grounded ? 14 : 6;
    const damp = rd.grounded ? 6.5 : 2.5;
    lm.vrx += ((restX - lm.rx) * stiff - lm.vrx * damp) * dt;
    lm.vrz += ((restZ - lm.rz) * stiff - lm.vrz * damp) * dt;
    lm.rx = clamp(lm.rx + lm.vrx * dt, -2.1, 2.1);
    lm.rz = clamp(lm.rz + lm.vrz * dt, -1.5, 1.5);
  }

  applyRagdollRigPose(ent, rd);

  const struggleBonus = ent.isP && (rd.struggleCount || 0) >= 3;
  const maxSettleSpd = struggleBonus ? 3.5 : 1.6;
  const settled = rd.grounded && Math.hypot(rd.vx, rd.vz) < maxSettleSpd;
  const minGracePassed = !ent.isP || rd.elapsed >= 0.38;
  if ((rd.timer <= 0 && minGracePassed && (settled || inLiq)) || rd.elapsed >= rd.maxTime) {
    rd.active = false;
    rd.recoverTimer = struggleBonus ? 0.24 : 0.34;
    ent.vy = 0;
    ent.grounded = rd.grounded;
  }
  return true;
}

export function performPlayerKick() {
  const player = S.player;
  if (S.state !== 'play' || !player || S.playerDead || player.isFlying) return false;
  if (player.ragdoll?.active) return false;
  if (isEntityFrozen(player)) return false;
  if ((player.kickCooldown || 0) > 0) return false;

  // Небольшой расход стамины (если система стамины включена)
  const drainStamina = S.worldSettings.allowSprint !== false && S.worldSettings.staminaDrainOnSprint !== false;
  if (drainStamina) {
    if ((player.stamina ?? 100) < 10) {
      sfx.oof?.();
      showBanner('⚡ Не хватает стамины для пинка!', '#ffce3a');
      return false;
    }
    player.stamina = Math.max(0, (player.stamina ?? 100) - 12);
    player._staminaRegenDelay = 0.7;
    updateShopUI();
  }

  player.kickCooldown = 0.72;
  player.attackCooldown = Math.max(player.attackCooldown || 0, 0.32);
  player.rot = S.yaw + Math.PI;
  if (player.rig?.g) player.rig.g.rotation.set(0, player.rot, 0);

  triggerEntityAttack(player, 'kick');
  sfx.swing?.() || sfx.slap?.();

  const fx = -Math.sin(S.yaw);
  const fz = -Math.cos(S.yaw);
  const kickReach = 3.6;
  const kickDamage = 22;
  const pWeight = getEntityWeight(player);
  let hitAnything = false;

  // 1. Пинок по NPC и удалённым игрокам (шанс рэгдола = плавающий % от урона/HP * 1.5, иначе пошатывание!)
  const extraTargets = (S.gameMode && S.gameMode.getExtraTargets) ? S.gameMode.getExtraTargets() : [];
  const allTargets = [...S.customNPCs, ...Object.values(S.remotePlayers || {}), ...extraTargets];

  for (const t of allTargets) {
    if (!t || t === player || t.isDisabled || t._deadCooldown > 0 || t._permanentlyDead) continue;
    const toX = t.x - player.x;
    const toZ = t.z - player.z;
    const dist = Math.hypot(toX, toZ);
    if (dist <= kickReach && Math.abs(t.y - player.y) < 2.6) {
      const dot = dist > 0.1 ? (toX / dist) * fx + (toZ / dist) * fz : 1;
      if (dot > 0.25 || dist <= 1.3) {
        hitAnything = true;
        transferEffectsOnContact(player, t, 0, true, 1.0);
        // Вектор импульса от точки удара (игрок -> цель)
        const dirLen = dist > 0.05 ? dist : 1;
        const impDirX = dist > 0.05 ? (toX / dirLen) : fx;
        const impDirZ = dist > 0.05 ? (toZ / dirLen) : fz;

        const tWeight = getEntityWeight(t);
        const weightRatio = clamp(pWeight / Math.max(20, tWeight), 0.45, 2.2);
        const kickHoriz = 14.5 * weightRatio;
        const kickUp = 5.2 * Math.sqrt(weightRatio);

        if (t.isRemotePlayer) {
          dealDamage(t, kickDamage, player, kickHoriz, { skipAutoRagdoll: true });
        } else {
          if (t.hpEnabled) {
            dealDamage(t, kickDamage, player, 0, { skipAutoRagdoll: true });
          } else {
            sfx.kick?.() || sfx.hit?.();
            spawnDamageParticles(t);
          }

          if (!(t._deadCooldown > 0) && !t._permanentlyDead) {
            // Если уже лежит в рэгдоле — всегда поддаём импульс, иначе бросаем плавающий шанс с модификатором x1.5
            const shouldRagdoll = Boolean(t.ragdoll?.active) || evaluateRagdollChance(t, kickDamage, true);
            if (shouldRagdoll) {
              triggerEntityRagdoll(t, impDirX * kickHoriz, kickUp, impDirZ * kickHoriz, 2.1);
              // Короткий оглушающий стан сохраняется на момент подъёма после падения
              applyEntityStun(t, 2.35);
              if (t.isCustomNPC) {
                t.chat = 'ААА! Не пинайся!! 🦵💥';
                t.chatT = 2.6;
                refreshEntityTagWithHP(t);
              }
            } else {
              // Противник устоял на ногах, но пошатнулся и получил оглушение (Стан 1.35с)
              triggerEntityStagger(t, impDirX, impDirZ, 1.2, clamp(6.8 * weightRatio, 3.5, 10));
              applyEntityStun(t, 1.35);
              if (t.isCustomNPC) {
                t.chat = '😵 Оглушён пинком!';
                t.chatT = 1.8;
                refreshEntityTagWithHP(t);
              }
              emitParticleBurst(t.x, t.y + 2.55, t.z, 6, {
                preset: 'star',
                color: '#ffce3a',
                sizeStart: 0.28,
                sizeEnd: 0.05,
                speed: 2.2,
                spread: 1.2,
                gravity: 0.4,
                lifetime: 0.65
              });
            }
          }
        }
      }
    }
  }

  // 2. Пинок по физическим блокам и объектам с hit-триггерами
  const blocksSnap = S.allBlocks.slice();
  for (let bi = 0; bi < blocksSnap.length; bi++) {
    const b = blocksSnap[bi];
    if (!b || b.isDisabled || b._depletedDisabled || !b.m || b._isCarriedByPlayer) continue;
    const bx0 = b.x0 > -90000 ? b.x0 : b.m.position.x - (b.w || 1) * 0.5;
    const bx1 = b.x1 > -90000 ? b.x1 : b.m.position.x + (b.w || 1) * 0.5;
    const bz0 = b.z0 > -90000 ? b.z0 : b.m.position.z - (b.d || 1) * 0.5;
    const bz1 = b.z1 > -90000 ? b.z1 : b.m.position.z + (b.d || 1) * 0.5;
    const dx = Math.max(bx0 - player.x, 0, player.x - bx1);
    const dz = Math.max(bz0 - player.z, 0, player.z - bz1);
    const dist = Math.hypot(dx, dz);
    if (dist < kickReach && Math.abs(player.y + 1.0 - b.m.position.y) < (b.hy || 1) + 2.2) {
      const toBX = b.m.position.x - player.x;
      const toBZ = b.m.position.z - player.z;
      const bLen = Math.hypot(toBX, toBZ) || 1;
      if ((toBX / bLen) * fx + (toBZ / bLen) * fz < 0.2 && dist > 1.2) continue;

      if ((!b.components || b.components.spawner?.enabled) && b.spawnerData?.mode === 'hit') {
        triggerBlockSpawner(b);
        hitAnything = true;
      }
      if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'hit') || b.logicData?.trigger === 'hit') {
        triggerBlockLogic(b, 'hit', player);
        hitAnything = true;
      }
      if (b.isDynamicPhysics && b.matterState !== 'liquid') {
        const hitPt = new THREE.Vector3(player.x + fx * Math.min(dist + 0.4, 1.8), player.y + 0.9, player.z + fz * Math.min(dist + 0.4, 1.8));
        const kickPower = 22.0 * clamp(pWeight / 70, 0.5, 2.5);
        applyImpulseToDynamicBlock(b, fx * kickPower, 4.8, fz * kickPower, hitPt, false);
        transferEffectsOnContact(player, b, 0, true, 1.0);
        hitAnything = true;
      }
    }
  }

  if (hitAnything) {
    sfx.kick?.() || sfx.hit?.();
    emitParticleBurst(player.x + fx * 1.4, player.y + 0.95, player.z + fz * 1.4, 8, {
      preset: 'hit',
      color: '#ffce3a',
      sizeStart: 0.35,
      sizeEnd: 0.05,
      speed: 4.5,
      spread: 1.0,
      gravity: -8,
      lifetime: 0.45
    });
  }
  return true;
}

export function performPlayerMeleeAttack(isSpecialKey = false) {
  const player = S.player;
  if (S.state !== 'play' || !player || S.playerDead) return;
  if (player.attackCooldown > 0) return;
  if (isEntityFrozen(player)) return;

  // 0. Если игрок несёт физический блок (Rigidbody) — ЛКМ бросает его вперёд с учётом веса!
  if (player.carriedPhysicsBlock) {
    const blkName = player.carriedPhysicsBlock.label;
    const blkW = player.carriedPhysicsBlock.weight || 15;
    player.rot = S.yaw + Math.PI;
    if (player.rig) player.rig.g.rotation.set(0, player.rot, 0);
    triggerEntityAttack(player, 'push');
    dropCarriedPhysicsBlock(player, 15.5, `🚀 Ты метнул «${blkName}» (${blkW} кг)!`);
    player.attackCooldown = 0.35;
    return;
  }

  // 1. Если игрок несёт 2-ручный контейнер — ЛКМ бросает его вперёд!
  if (player.carriedItem) {
    player.rot = S.yaw + Math.PI;
    if (player.rig) player.rig.g.rotation.set(0, player.rot, 0);
    triggerEntityAttack(player, 'push');
    dropHeldOrCarriedItem(player, 9.5, `📦 Ты метнул «${player.carriedItem.name}»!`);
    player.attackCooldown = 0.35;
    return;
  }

  const item = !isSpecialKey ? getActiveHeldItem(player) : null;
  if (item && isItemFrozen(item)) {
    sfx.oof?.();
    showBanner(`❄️ «${item.name}» заморожен — его нельзя использовать!`, '#56f0ff');
    player.attackCooldown = 0.3;
    return;
  }
  if (item && item.scriptData?.enabled) {
    runItemScriptHook(item, 'onUse', { holder: player });
  }

  // 2. Использование расходуемого предмета (Аптечка / Еда / Зелье)
  if (item && item.useType === 'consumable') {
    triggerEntityAttack(player, 'punch');
    const heal = Number(item.healAmount) || 0;
    if (heal >= 0) {
      player.hp = Math.min(player.maxHp, player.hp + heal);
      sfx.cash();
      showBanner(`${item.icon || '🍗'} Использовано «${item.name}»: +${heal} HP!`, '#00e676');
    } else {
      dealDamage(player, Math.abs(heal));
      showBanner(`${item.icon || '🧪'} «${item.name}» отняло ${Math.abs(heal)} HP!`, '#ff3e3e');
    }

    if (item.buffSpeed) player.walkSpeed = clamp((player.walkSpeed || 7.6) + Number(item.buffSpeed), 3, 22);
    if (item.buffJump) player.jumpPower = clamp((player.jumpPower || 10.2) + Number(item.buffJump), 4, 28);
    if (item.buffDamage) player.meleeDamage = Math.max(5, (player.meleeDamage || 25) + Number(item.buffDamage));
    if (item.buffScale && player.rig) {
      const nextSc = clamp(player.rig.g.scale.x + Number(item.buffScale), 0.4, 3.5);
      player.rig.g.scale.setScalar(nextSc);
    }

    player.hpBarTimer = 3.5;
    refreshEntityTagWithHP(player);
    updateShopUI();
    player.attackCooldown = Math.max(0.25, Number(item.cooldown) || 0.5);
    consumeItemDurability(player, item, Number(item.durabilityCostPerUse) || 1);
    return;
  }

  // 3. Факел (включение/выключение свечения)
  if (item && item.useType === 'torch') {
    const nextState = !(item.lightData && (item.lightData.realLight || item.lightData.pseudoLight || item.lightData.enabled));
    if (!item.lightData) item.lightData = {};
    item.lightData.enabled = nextState;
    item.lightData.realLight = nextState;
    item.lightData.pseudoLight = nextState;
    syncEntityHeldItemMesh(player);
    sfx.jump();
    showBanner(`🔦 Факел «${item.name}»: ${nextState ? 'Включён 💡' : 'Погашен'}`, '#ffce3a');
    player.attackCooldown = 0.25;
    if (nextState) {
      consumeItemDurability(player, item, Number(item.durabilityCostPerUse) || 2);
    }
    return;
  }

  // 4. Дальний бой / Огнестрел / Магический посох
  if (item && item.useType === 'ranged') {
    if (S.isReloadingHold || player.reloadTimer > 0) return;
    if (!item.infiniteAmmo && item.ammo <= 0) {
      sfx.oof();
      if ((item.reserveAmmo ?? 0) > 0) {
        showBanner(`🔄 Магазин пуст! Зажми и удерживай [R] для перезарядки «${item.name}»!`, '#ffce3a');
      } else {
        showBanner(`❌ Патроны для «${item.name}» полностью закончились!`, '#ff3e3e');
      }
      player.attackCooldown = 0.25;
      return;
    }
    if (!item.infiniteAmmo) item.ammo--;

    player.rot = S.yaw + Math.PI;
    if (player.rig) player.rig.g.rotation.set(0, player.rot, 0);

    triggerEntityAttack(player, 'shoot');
    sfx.zap();
    spawnProjectile(player, item, 1.0);
    player.attackCooldown = Math.max(0.08, Number(item.cooldown) || 0.25);
    consumeItemDurability(player, item, Number(item.durabilityCostPerUse) || 0);
    renderHotbarUI();
    return;
  }

  // 5. Направленный ближний бой (3D-конус перед игроком + проверка стен + разворот по взгляду)
  if ((player.stunTimer || 0) > 0 || player.ragdoll?.active) return;

  const isMeleeItem = Boolean(item && item.useType === 'melee');
  const reach = isMeleeItem ? (Number(item.range) || 4.4) : 3.4;
  const hitRadius = isMeleeItem ? (Number(item.radius) || 2.2) : 1.5;
  const equipBonus = Number(item?.equipStats?.damageBonus) || 0;
  const dmg = isMeleeItem
    ? Math.max(0, Number(item.damage) + equipBonus)
    : (player.meleeDamage || 25) + equipBonus;
  const kb = isMeleeItem ? (Number(item.knockback) || 10) : 8;

  // Разворачиваем персонажа по направлению удара (взгляда камеры)
  player.rot = S.yaw + Math.PI;
  if (player.rig?.g) player.rig.g.rotation.set(0, player.rot, 0);

  triggerEntityAttack(player, isSpecialKey ? 'push' : 'punch');
  if (isMeleeItem) sfx.swing();
  else sfx.slap();
  player.attackCooldown = item ? Math.max(0.15, Number(item.cooldown) || 0.35) : 0.3;

  const fx = -Math.sin(S.yaw);
  const fz = -Math.cos(S.yaw);
  const cp = Math.cos(S.pitch);
  const aimY = Math.sin(S.pitch);
  const eyeY = player.y + 1.45;

  // Ширина переднего сектора: для кулака ~92° (dot >= 0.69), для широкого меча ~110°–130° (но никогда за спиной!)
  const minFrontDot = isMeleeItem
    ? clamp(0.72 - (hitRadius - 1.4) * 0.16, 0.38, 0.72)
    : 0.68;

  // 5.1. Удар по блокам строго перед игроком (в передней полусфере)
  const blocksSnap = S.allBlocks.slice();
  for (let bi = 0; bi < blocksSnap.length; bi++) {
    const b = blocksSnap[bi];
    if (!b || b.isDisabled || b._depletedDisabled || !b.m || b._isCarriedByPlayer) continue;
    const bx0 = b.x0 > -90000 ? b.x0 : b.m.position.x - (b.w || 1) * 0.5;
    const bx1 = b.x1 > -90000 ? b.x1 : b.m.position.x + (b.w || 1) * 0.5;
    const bz0 = b.z0 > -90000 ? b.z0 : b.m.position.z - (b.d || 1) * 0.5;
    const bz1 = b.z1 > -90000 ? b.z1 : b.m.position.z + (b.d || 1) * 0.5;

    const closestX = clamp(player.x, bx0, bx1);
    const closestZ = clamp(player.z, bz0, bz1);
    const dx = closestX - player.x;
    const dz = closestZ - player.z;
    const dist = Math.hypot(dx, dz);

    if (dist < reach && Math.abs(eyeY + aimY * Math.min(dist, 2.2) - b.m.position.y) < (b.hy || 1) + 2.0) {
      const bDot = dist > 0.08 ? (dx / dist) * fx + (dz / dist) * fz : ((b.m.position.x - player.x) * fx + (b.m.position.z - player.z) * fz);
      if (bDot < 0.35) continue;

      if ((!b.components || b.components.spawner?.enabled) && b.spawnerData && b.spawnerData.mode === 'hit') {
        triggerBlockSpawner(b);
      }
      if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'hit') || (b.logicData && b.logicData.trigger === 'hit')) {
        triggerBlockLogic(b, 'hit', player);
      }
      if (b.isDynamicPhysics && b.matterState !== 'liquid') {
        const hitPt = new THREE.Vector3(closestX, clamp(eyeY, b.y0 + 0.1, b.y1 - 0.1), closestZ);
        applyImpulseToDynamicBlock(b, fx * kb * 1.15, 2.2, fz * kb * 1.15, hitPt, false);
      }
    }
  }

  // 5.2. Удар по NPC / игрокам строго в направленном 3D-конусе + проверка отсутствия стены
  const extraTargets = (S.gameMode && S.gameMode.getExtraTargets) ? S.gameMode.getExtraTargets() : [];
  const allTargets = [...S.customNPCs, ...Object.values(S.remotePlayers || {}), ...extraTargets];

  let hitAnyone = false;
  for (const t of allTargets) {
    if (!t || t === player || t.isDisabled || t._deadCooldown > 0 || t._permanentlyDead) continue;

    const toX = t.x - player.x;
    const toZ = t.z - player.z;
    const distXZ = Math.hypot(toX, toZ);
    const tCenterY = t.y + (t.ragdoll?.active ? 0.55 : 1.3);
    const expectedHitY = eyeY + aimY * Math.min(distXZ, reach * 0.75);
    const vertDiff = Math.abs(tCenterY - expectedHitY);

    if (distXZ > reach || vertDiff > 2.2) continue;

    const dirX = distXZ > 0.05 ? toX / distXZ : fx;
    const dirZ = distXZ > 0.05 ? toZ / distXZ : fz;
    const dot = dirX * fx + dirZ * fz;

    // В упор (< 0.85м) допускается чуть более широкий угол, но спина (dot <= 0.15) полностью исключена
    const inFrontArc = dot >= minFrontDot || (distXZ <= 0.85 && dot > 0.15);
    if (!inFrontArc) continue;

    // Не бьём сквозь глухие стены
    if (!isMeleeLineOfSightClear(player.x, eyeY, player.z, t.x, tCenterY, t.z)) continue;

    hitAnyone = true;
    transferEffectsOnContact(player, t, 0, true, 1.0);
    if (item) transferEffectsOnContact(item, t, 0, true, 1.15);
    const centerFocusMult = dot > 0.88 ? 1.1 : 1.0;
    const finalKb = kb * centerFocusMult;

    if (dmg > 0) {
      if (t.hpEnabled) {
        dealDamage(t, dmg, player, finalKb, { impDirX: dirX, impDirZ: dirZ });
        if (item && item.scriptData?.enabled) {
          runItemScriptHook(item, 'onHit', { holder: player, target: t, damage: dmg });
        }
      } else {
        t.chat = 'У меня отключён урон (Бессмертие)! 🛡️';
        t.chatT = 3.0;
        refreshEntityTagWithHP(t);
      }
    } else {
      t.vxKnock = dirX * finalKb;
      t.vzKnock = dirZ * finalKb;
      triggerEntityStagger(t, dirX, dirZ, 0.75, 0);
      sfx.jump();
    }
  }

  if (hitAnyone && item && item.useType === 'melee') {
    consumeItemDurability(player, item, Number(item.durabilityCostPerUse) || 0);
  }

  if (S.gameMode && S.gameMode.onMeleeAttack) {
    S.gameMode.onMeleeAttack(isSpecialKey, hitAnyone);
  }
}

function detonateProjectile(proj, hitX, hitY, hitZ, directTarget = null, directHitBlock = null) {
  if (proj.isRemoteVisual) {
    if (proj.blastRadius > 0.2) {
      sfx.explosion();
      try {
        emitParticleBurst(hitX, hitY, hitZ, 16, {
          preset: 'hit',
          color: '#ff6b6b',
          sizeStart: 0.45,
          sizeEnd: 0.08,
          speed: 5.5,
          spread: 1.3,
          gravity: -9,
          lifetime: 0.7
        });
      } catch (_) {}
    }
    return;
  }
  const extraTargets = (S.gameMode && S.gameMode.getExtraTargets) ? S.gameMode.getExtraTargets() : [];
  const allTargets = [
    ...(S.player && !S.playerDead ? [S.player] : []),
    ...S.customNPCs,
    ...Object.values(S.remotePlayers || {}),
    ...extraTargets
  ].filter(t => t && t !== proj.owner);

  if (proj.blastRadius > 0.2) {
    sfx.explosion();
    try {
      emitParticleBurst(hitX, hitY, hitZ, 18, {
        preset: 'hit',
        color: '#ff6b6b',
        sizeStart: 0.48,
        sizeEnd: 0.08,
        speed: 6.0,
        spread: 1.35,
        gravity: -9,
        lifetime: 0.75
      });
    } catch (_) {}

    // Активируем все блоки с триггером «При ударе (hit)», попавшие в радиус взрыва метательного снаряда
    const blocksSnap = S.allBlocks.slice();
    for (let bi = 0; bi < blocksSnap.length; bi++) {
      const b = blocksSnap[bi];
      if (!b || b._depletedDisabled || !b.m || b === directHitBlock) continue;
      const bx0 = b.x0 > -90000 ? b.x0 : b.m.position.x - (b.w || 1) * 0.5;
      const bx1 = b.x1 > -90000 ? b.x1 : b.m.position.x + (b.w || 1) * 0.5;
      const by0 = b.y0 > -90000 ? b.y0 : b.m.position.y - (b.h || 1) * 0.5;
      const by1 = b.y1 > -90000 ? b.y1 : b.m.position.y + (b.h || 1) * 0.5;
      const bz0 = b.z0 > -90000 ? b.z0 : b.m.position.z - (b.d || 1) * 0.5;
      const bz1 = b.z1 > -90000 ? b.z1 : b.m.position.z + (b.d || 1) * 0.5;

      const dx = Math.max(bx0 - hitX, 0, hitX - bx1);
      const dy = Math.max(by0 - hitY, 0, hitY - by1);
      const dz = Math.max(bz0 - hitZ, 0, hitZ - bz1);
      if (Math.hypot(dx, dy, dz) <= proj.blastRadius) {
        if ((!b.components || b.components.spawner?.enabled) && b.spawnerData && b.spawnerData.mode === 'hit') {
          triggerBlockSpawner(b);
        }
        if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'hit') || (b.logicData && b.logicData.trigger === 'hit')) {
          triggerBlockLogic(b, 'hit');
        }
        if (b.isDynamicPhysics && b.matterState !== 'liquid') {
          const bdx = b.m.position.x - hitX;
          const bdy = (b.m.position.y + 0.5) - hitY;
          const bdz = b.m.position.z - hitZ;
          const bLen = Math.hypot(bdx, bdy, bdz) || 1;
          const blastForce = proj.knockback * 1.6 * Math.max(0.3, 1 - Math.hypot(dx, dy, dz) / proj.blastRadius);
          applyImpulseToDynamicBlock(b, (bdx / bLen) * blastForce, Math.max(3.5, (bdy / bLen) * blastForce), (bdz / bLen) * blastForce);
        }
        if (proj.item) transferEffectsOnContact(proj.item, b, 0, false, 1.0);
      }
    }

    for (const t of allTargets) {
      if (t._deadCooldown > 0) continue;
      if (proj.owner?.isCustomNPC && areEntitiesAllied(proj.owner, t)) continue;
      const d = Math.hypot(t.x - hitX, (t.y + 1.2) - hitY, t.z - hitZ);
      if (d <= proj.blastRadius) {
        const falloff = 1 - (d / (proj.blastRadius * 1.25));
        const dmg = Math.round(proj.damage * Math.max(0.35, falloff));
        const bdx = t.x - hitX;
        const bdz = t.z - hitZ;
        const bh = Math.hypot(bdx, bdz) || 1;
        if (dmg > 0) {
          dealDamage(t, dmg, proj.owner, proj.knockback * 1.25, {
            impDirX: bdx / bh,
            impDirZ: bdz / bh
          });
        } else {
          const dx = t.x - hitX;
          const dz = t.z - hitZ;
          const h = Math.hypot(dx, dz) || 1;
          t.vxKnock = (dx / h) * proj.knockback;
          t.vzKnock = (dz / h) * proj.knockback;
        }
        if (proj.item) transferEffectsOnContact(proj.item, t, 0, false, 1.15);
      }
    }
  } else if (directTarget) {
    if (proj.item) transferEffectsOnContact(proj.item, directTarget, 0, false, 1.2);
    const pHoriz = Math.hypot(proj.vx, proj.vz) || 1;
    if (proj.damage > 0) {
      dealDamage(directTarget, proj.damage, proj.owner, proj.knockback, {
        impDirX: proj.vx / pHoriz,
        impDirZ: proj.vz / pHoriz
      });
    } else {
      directTarget.vxKnock = (proj.vx / 25) * proj.knockback;
      directTarget.vzKnock = (proj.vz / 25) * proj.knockback;
    }
  }
}

function updateProjectilesAndWorldItems(dt) {
  // 1. Обновление летящих снарядов
  const extraTargets = (S.gameMode && S.gameMode.getExtraTargets) ? S.gameMode.getExtraTargets() : [];
  const allTargets = [
    ...(S.player && !S.playerDead ? [S.player] : []),
    ...S.customNPCs,
    ...Object.values(S.remotePlayers || {}),
    ...extraTargets
  ];

  for (let i = S.activeProjectiles.length - 1; i >= 0; i--) {
    const pr = S.activeProjectiles[i];
    pr.age += dt;
    pr.vy -= pr.gravity * dt;

    const stepX = pr.vx * dt;
    const stepY = pr.vy * dt;
    const stepZ = pr.vz * dt;
    pr.x += stepX;
    pr.y += stepY;
    pr.z += stepZ;
    pr.distTraveled += Math.hypot(stepX, stepY, stepZ);

    pr.group.position.set(pr.x, pr.y, pr.z);
    pr.group.lookAt(pr.x + pr.vx, pr.y + pr.vy, pr.z + pr.vz);

    let hitSomething = false;
    let directEnt = null;
    let directBlock = null;

    // Проверка попадания в NPC и игроков (снаряды дальников пролетают сквозь союзных танков в строю)
    for (const t of allTargets) {
      if (t._deadCooldown > 0 || t === pr.owner) continue;
      if (pr.owner?.isCustomNPC && areEntitiesAllied(pr.owner, t)) continue;
      if (Math.hypot(t.x - pr.x, t.z - pr.z) < 0.85 && pr.y >= t.y && pr.y <= t.y + 2.6) {
        hitSomething = true;
        directEnt = t;
        break;
      }
    }

    // Проверка попадания в блоки и объекты с триггером «При ударе (hit)»
    if (!hitSomething) {
      const blocksSnap = S.allBlocks.slice();
      for (let bi = 0; bi < blocksSnap.length; bi++) {
        const b = blocksSnap[bi];
        if (!b || b._depletedDisabled || !b.m) continue;
        if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;

        const isHitTrigger =
          (b.components?.interaction?.enabled && b.interactionData?.trigger === 'hit') ||
          (b.logicData && b.logicData.trigger === 'hit') ||
          ((!b.components || b.components.spawner?.enabled) && b.spawnerData && b.spawnerData.mode === 'hit');

        const isSolid = (!b.components || b.components.physics?.enabled) && b.matterState === 'solid';
        if (!isSolid && !isHitTrigger) continue;

        let hitThisBlock = false;
        if (isSolid) {
          hitThisBlock = Boolean(testPlayerOBB(pr.x, pr.y - 0.15, pr.z, 0.2, 0.3, b));
        } else {
          // Если у объекта-мишени отключена твёрдая физика, проверяем попадание по его габаритам
          const hw = (b.w || 1) * 0.5 + 0.25;
          const hh = (b.h || 1) * 0.5 + 0.25;
          const hd = (b.d || 1) * 0.5 + 0.25;
          hitThisBlock =
            Math.abs(pr.x - b.m.position.x) <= hw &&
            Math.abs(pr.y - b.m.position.y) <= hh &&
            Math.abs(pr.z - b.m.position.z) <= hd;
        }

        if (hitThisBlock) {
          hitSomething = true;
          directBlock = b;
          if (pr.item) transferEffectsOnContact(pr.item, b, 0, false, 1.1);
          try {
            if ((!b.components || b.components.spawner?.enabled) && b.spawnerData && b.spawnerData.mode === 'hit') {
              triggerBlockSpawner(b);
            }
            if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'hit') || (b.logicData && b.logicData.trigger === 'hit')) {
              triggerBlockLogic(b, 'hit');
            }
            if (b.isDynamicPhysics && b.matterState !== 'liquid') {
              const pSpd = Math.hypot(pr.vx, pr.vy, pr.vz) || 1;
              applyImpulseToDynamicBlock(
                b,
                (pr.vx / pSpd) * pr.knockback,
                Math.max(1.5, (pr.vy / pSpd) * pr.knockback * 0.5),
                (pr.vz / pSpd) * pr.knockback
              );
            }
          } catch (err) {
            console.error('Ошибка при срабатывании hit-триггера блока:', err);
          }
          break;
        }
      }
    }

    if (hitSomething || pr.distTraveled >= pr.maxRange || pr.y < -25 || pr.age > 6.5) {
      if (hitSomething) {
        try {
          detonateProjectile(pr, pr.x, pr.y, pr.z, directEnt, directBlock);
        } catch (err) {
          console.error('Ошибка при детонации снаряда:', err);
        }
      }
      if (pr.group) scene.remove(pr.group);
      S.activeProjectiles.splice(i, 1);
    }
  }

  // 2. Физика лежащих и брошенных предметов / контейнеров (worldItems)
  const grav = S.worldSettings.gravity || 22;
  for (let i = S.worldItems.length - 1; i >= 0; i--) {
    const wi = S.worldItems[i];
    if (!wi || wi.isDisabled) continue;

    // Таймер исчезновения дропа NPC + LOD скрытие далёких 3D-тегов
    if (wi._isNpcDrop) {
      wi._dropAge = (wi._dropAge || 0) + dt;
      const maxAge = wi._dropMaxAge || NPC_DROP_DESPAWN_SEC;
      if (wi._dropAge >= maxAge) {
        if (wi.group) scene.remove(wi.group);
        if (wi.tag) scene.remove(wi.tag);
        S.worldItems.splice(i, 1);
        syncWorldItemDeleteToNetwork(wi.id);
        continue;
      }
      if (wi._dropAge > maxAge - 5 && wi.group) {
        wi.group.visible = Math.floor(wi._dropAge * 8) % 2 === 0;
      }
    }

    if (wi.tag && S.player) {
      const distToP = Math.hypot(wi.x - S.player.x, wi.z - S.player.z);
      wi.tag.visible = distToP <= 14.0;
    }

    if (wi.pickupCooldown > 0) wi.pickupCooldown = Math.max(0, wi.pickupCooldown - dt);

    // Спящий режим для неподвижно лежащих предметов (пропускаем OBB-коллизии по всем блокам сцены!)
    if (wi._physSleep) {
      if (wi.item.holdMode === 'held' && wi.group) {
        wi.rotY += dt * 1.4;
        wi.group.rotation.y = wi.rotY;
      }
      continue;
    }

    const prevVy = wi.vy;
    wi.vy = Math.max(-28, wi.vy - grav * dt);
    wi.x += wi.vx * dt;
    wi.y += wi.vy * dt;
    wi.z += wi.vz * dt;

    const wiSlip = isItemFrozen(wi) || isBlockSlippery(wi._supportBlock);
    wi.vx *= Math.pow(wiSlip ? 0.78 : 0.08, dt);
    wi.vz *= Math.pow(wiSlip ? 0.78 : 0.08, dt);

    if (wi._throwGrace > 0) wi._throwGrace = Math.max(0, wi._throwGrace - dt);
    if (wi._hitEntCd > 0) wi._hitEntCd = Math.max(0, wi._hitEntCd - dt);

    const rad = wi.item.holdMode === 'carried' ? 0.65 : 0.35;
    const h = wi.item.holdMode === 'carried' ? 1.1 : 0.55;
    const wiSpd3D = Math.hypot(wi.vx, wi.vy, wi.vz);
    if (!wi.grounded && wiSpd3D > 4.2 && (wi._hitEntCd || 0) <= 0) {
      const itemWeight = clamp(
        Number(wi.item?.weight) || (wi.item?.holdMode === 'carried' ? 24 : 5),
        1,
        500
      );
      const hitList = [...S.customNPCs];
      if (S.player && !S.playerDead) hitList.push(S.player);

      for (let ti = 0; ti < hitList.length; ti++) {
        const ent = hitList[ti];
        if (!ent || ent.isDisabled || ent._deadCooldown > 0 || ent._permanentlyDead) continue;
        if (ent === wi._thrownBy && (wi._throwGrace || 0) > 0) continue;

        const er = (ent.colliderRadius || 0.42) + rad + 0.15;
        const eh = ent.colliderHeight || 2.5;
        if (Math.hypot(ent.x - wi.x, ent.z - wi.z) > er) continue;
        if (wi.y + h < ent.y || wi.y > ent.y + eh) continue;

        const mEnt = getEntityWeight(ent);
        const impactPower = wiSpd3D * Math.pow(itemWeight / Math.max(15, mEnt), 0.62);
        if (impactPower > 2.2) {
          wi._hitEntCd = 0.45;
          transferEffectsOnContact(wi, ent, 0, true, 1.1);
          const hSpd = Math.hypot(wi.vx, wi.vz) || 1;
          const nxI = wi.vx / hSpd;
          const nzI = wi.vz / hSpd;
          const kbForce = clamp(impactPower * 1.35, 3.5, 16.0);

          if (impactPower > 4.0 && ent.hpEnabled) {
            const dmg = Math.round(clamp((impactPower - 3.2) * 4.0, 4, 55));
            dealDamage(ent, dmg, wi._thrownBy || null, 0, { skipAutoRagdoll: true });
          } else {
            sfx.hit?.();
            spawnDamageParticles(ent);
          }

          if (!(ent._deadCooldown > 0) && !ent._permanentlyDead && !(ent.isP && S.playerDead)) {
            const dropChance = clamp(((impactPower - 2.2) / 4.5) * rnd(0.85, 1.15), 0, 0.94);
            if (Math.random() < dropChance) {
              triggerEntityRagdoll(ent, nxI * kbForce, clamp(3.0 + impactPower * 0.2, 2.8, 5.8), nzI * kbForce, 1.7);
              applyEntityStun(ent, 0.7);
            } else {
              triggerEntityStagger(ent, nxI, nzI, clamp(impactPower / 4.2, 0.45, 1.2), clamp(kbForce * 0.55, 2.8, 8.0));
              applyEntityStun(ent, 0.55);
            }
          }

          // Отскок брошенного контейнера/предмета после попадания
          wi.vx *= -0.35;
          wi.vz *= -0.35;
          wi.vy = Math.max(2.0, wi.vy * 0.4);
          break;
        }
      }
    }

    wi.grounded = false;

    wi._supportBlock = null;
    for (const b of S.allBlocks) {
      if (b.isDisabled || b._depletedDisabled) continue;
      if (b.matterState === 'liquid') {
        if (testPlayerOBB(wi.x, wi.y, wi.z, rad, h, b)) {
          interactTargetWithLiquid(wi, b, dt);
        }
        continue;
      }
      if (b.matterState !== 'solid' || (b.logicRuntime && b.logicRuntime.ghostOpen)) continue;
      const hit = testPlayerOBB(wi.x, wi.y, wi.z, rad, h, b);
      if (!hit) continue;

      transferEffectsOnContact(wi, b, dt, true, 0.9);

      if (hit.ny > 0.45 && wi.vy <= 0.5) {
        const impactSpeed = Math.abs(prevVy);
        wi.y += hit.pen / Math.max(0.45, hit.ny);
        wi.vy = 0;
        wi.grounded = true;
        wi._supportBlock = b;

        // Проверка урона от падения для хрупких переносимых контейнеров (яиц, ящиков и т.д.)
        if (impactSpeed > 9.5 && !wi.item.infiniteDurability && (wi.item.fallDamageMult || 0) > 0) {
          const dmg = Math.round((impactSpeed - 8.5) * wi.item.fallDamageMult);
          wi.item.durability = Math.max(0, (wi.item.durability ?? wi.item.maxDurability) - dmg);
          sfx.hit();
          if (wi.item.durability <= 0) {
            emitParticleBurst(wi.x, wi.y + 0.55, wi.z, 22, {
              preset: 'hit',
              color: '#f39c12',
              sizeStart: 0.52,
              sizeEnd: 0.08,
              speed: 6.5,
              spread: 1.4,
              gravity: -11,
              lifetime: 0.9
            });
            emitParticleBurst(wi.x, wi.y + 0.55, wi.z, 14, {
              preset: 'spark',
              color: '#00e676',
              sizeStart: 0.42,
              sizeEnd: 0.06,
              speed: 5.5,
              spread: 1.3,
              gravity: -8,
              lifetime: 1.05
            });
            sfx.oof();
            showBanner(`💥 Контейнер «${wi.item.name}» разбился вдребезги при падении!`, '#ff3e3e');
            scene.remove(wi.group);
            scene.remove(wi.tag);
            S.worldItems.splice(i, 1);
            break;
          } else if (wi.tag) {
            updateTag(
              wi.tag,
              wi.item.holdMode === 'carried' ? '📦 Взять в 2 руки [E]' : `${wi.item.icon || '🗡️'} Подобрать [E]`,
              wi.item.name,
              `Прочность: ${Math.ceil(wi.item.durability)}/${wi.item.maxDurability}`
            );
          }
        }
      } else {
        wi.x += hit.nx * hit.pen;
        wi.z += hit.nz * hit.pen;
      }
    }

    if (!S.worldItems[i]) continue;

    if (wi.item.holdMode === 'held') {
      wi.rotY += dt * 1.4;
      wi.group.rotation.y = wi.rotY;
    }
    wi.group.position.set(wi.x, wi.y + (wi.item.holdMode === 'held' ? 0.35 : 0.55), wi.z);
    if (wi.tag) wi.tag.position.set(wi.x, wi.y + 1.65, wi.z);

    if (wi.grounded && Math.abs(wi.vx) < 0.04 && Math.abs(wi.vz) < 0.04 && Math.abs(wi.vy) < 0.04) {
      wi.vx = 0;
      wi.vy = 0;
      wi.vz = 0;
      wi._physSleep = true;
    }
  }
}

function sampleTrajectoryPointAtArcLen(s, maxIdx, outVec) {
  if (s <= 0 || maxIdx <= 0) return outVec.copy(_trajPts[0]);
  const total = _trajArcLens[maxIdx];
  if (s >= total) return outVec.copy(_trajPts[maxIdx]);
  for (let i = 1; i <= maxIdx; i++) {
    const s1 = _trajArcLens[i];
    if (s <= s1) {
      const s0 = _trajArcLens[i - 1];
      const frac = s1 > s0 ? (s - s0) / (s1 - s0) : 0;
      return outVec.lerpVectors(_trajPts[i - 1], _trajPts[i], frac);
    }
  }
  return outVec.copy(_trajPts[maxIdx]);
}

function updateAimTrajectoryAndTorch(player, dt) {
  const tLight = ensureHeldTorchLight();
  const tGroup = ensureTrajectoryVisuals();
  const hud = ensureThrowChargeHUD();
  const ch = ensureCrosshairHUD();

  const rawHeld = getActiveHeldItem(player);
  const held = (rawHeld && !isItemFrozen(rawHeld)) ? rawHeld : null;

  // Пассивное расходование прочности и работа света (Факел / Светящийся предмет)
  if (held && !S.playerDead && S.state === 'play') {
    const BaseMax = player.baseMaxHp || 100;
    const bonusHp = Number(held.equipStats?.maxHpBonus) || 0;
    if (player.maxHp !== BaseMax + bonusHp) {
      player.maxHp = BaseMax + bonusHp;
      player.hp = Math.min(player.hp, player.maxHp);
      updateShopUI();
    }

    const isLightActive = !!(held.lightData && (held.lightData.realLight || held.lightData.pseudoLight || held.lightData.enabled));
    if ((held.passiveDecayPerSec || 0) > 0 && isLightActive) {
      consumeItemDurability(player, held, held.passiveDecayPerSec * dt);
    }

    const hasRealLight = !!(held.lightData && (held.lightData.realLight || held.lightData.enabled));
    if (hasRealLight) {
      tLight.color.set(held.lightData.color || '#ff9f43');
      tLight.intensity = Number(held.lightData.intensity) || 2.2;
      tLight.distance = Number(held.lightData.distance) || 16;
      tLight.position.set(player.x, player.y + 2.1, player.z);
    } else {
      tLight.intensity = 0;
    }
  } else {
    tLight.intensity = 0;
  }

  // 2D Экранный прицел (Crosshair) в центре экрана для стрелкового и метательного оружия
  const showCrosshair =
    S.state === 'play' &&
    !S.playerDead &&
    !!held &&
    (held.useType === 'ranged' || held.useType === 'throwable');
  ch.hidden = !showCrosshair;
  if (showCrosshair) {
    ch.classList.toggle('aiming', !!(S.isAimingRMB && held.canAim) || !!S.isChargingThrow);
    ch.classList.toggle('firing', !!(player.attackAnimT > 0.1 && player.attackStyle === 'shoot'));
  }

  // Шкала замаха метательного предмета: изначально 0% (минимальная траектория), растёт при удержании ЛКМ
  let chargeRatio = 0.0;
  if (S.isChargingThrow && held && held.useType === 'throwable' && S.state === 'play' && !S.playerDead) {
    S.throwChargeT += dt;
    const maxChg = Math.max(0.25, Number(held.maxChargeTime) || 1.1);
    chargeRatio = clamp(S.throwChargeT / maxChg, 0.0, 1.0);
    const pct = Math.min(100, Math.round((S.throwChargeT / maxChg) * 100));
    hud.hidden = false;
    $('throwChargeLbl').textContent = `🎯 СИЛА БРОСКА: ${pct}%`;
    $('throwChargeFill').style.width = `${pct}%`;
    player.holdPose = 'throw_charge';
  } else {
    hud.hidden = true;
    if (player && player.holdPose === 'throw_charge') {
      player.holdPose = held ? (S.isAimingRMB && held.canAim ? 'aim' : 'weapon') : null;
    }
  }

  // Отрисовка объёмного анимированного 3D-пунктира траектории ТОЛЬКО для метательных предметов (throwable)
  const showArc =
    S.state === 'play' &&
    !S.playerDead &&
    held &&
    held.useType === 'throwable' &&
    ((S.isAimingRMB && held.canAim) || S.isChargingThrow);

  if (!showArc) {
    tGroup.visible = false;
    return;
  }

  const { origin, dir } = computeMuzzleAndAim(player, held);
  const minSpd = Number(held.minThrowSpeed) || 8;
  const maxSpd = Math.max(minSpd + 2, Number(held.projSpeed) || 26);
  const spd = minSpd + (maxSpd - minSpd) * chargeRatio;

  const vx = dir.x * spd;
  const vy = dir.y * spd;
  const vz = dir.z * spd;
  const g = (S.worldSettings.gravity || 22) * (Number(held.gravityFactor) ?? 1.0);

  // Симуляция баллистической дуги с остановкой при столкновении с твёрдым блоком
  const maxSimTime = 1.85;
  let lastIdx = 0;
  _trajPts[0].copy(origin);
  _trajArcLens[0] = 0;

  for (let i = 1; i <= TRAJ_SIM_STEPS; i++) {
    const t = (i / TRAJ_SIM_STEPS) * maxSimTime;
    const px = origin.x + vx * t;
    const py = origin.y + vy * t - 0.5 * g * t * t;
    const pz = origin.z + vz * t;

    _trajPts[i].set(px, py, pz);
    _trajArcLens[i] = _trajArcLens[i - 1] + _trajPts[i - 1].distanceTo(_trajPts[i]);
    lastIdx = i;

    let hitBlock = false;
    if (i > 2) {
      for (const b of S.allBlocks) {
        if (b.matterState !== 'solid' || (b.logicRuntime && b.logicRuntime.ghostOpen)) continue;
        if (testPlayerOBB(px, py - 0.1, pz, 0.16, 0.25, b)) {
          hitBlock = true;
          break;
        }
      }
    }
    if (hitBlock || py < -15) break;
  }

  const totalArcLen = _trajArcLens[lastIdx];
  const { dashes, dashMat, impactGroup } = tGroup.userData;

  // Динамический цвет пунктира (бирюзово-зелёный при прицеле ПКМ, от зелёного к огненному при зарядке ЛКМ)
  if (S.isChargingThrow) {
    if (chargeRatio < 0.5) dashMat.color.setHex(0x00e676);
    else if (chargeRatio < 0.85) dashMat.color.setHex(0xffce3a);
    else dashMat.color.setHex(0xff3e3e);
  } else {
    dashMat.color.setHex(0x00f5a0);
  }

  const dashLen = 0.54;
  const gapLen = 0.36;
  const period = dashLen + gapLen;
  const phase = (performance.now() * 0.0042) % period;

  for (let k = 0; k < TRAJ_DASH_COUNT; k++) {
    const dash = dashes[k];
    const sStart = (k - 1) * period + phase;
    const sEnd = sStart + dashLen;
    const a = Math.max(0.12, sStart);
    const b = Math.min(totalArcLen, sEnd);

    if (b - a > 0.06) {
      sampleTrajectoryPointAtArcLen(a, lastIdx, _vDashP0);
      sampleTrajectoryPointAtArcLen(b, lastIdx, _vDashP1);
      const segLen = _vDashP0.distanceTo(_vDashP1);
      if (segLen > 0.04) {
        dash.visible = true;
        dash.position.lerpVectors(_vDashP0, _vDashP1, 0.5);
        dash.lookAt(_vDashP1);
        dash.scale.set(1, 1, segLen);
        continue;
      }
    }
    dash.visible = false;
  }

  // Кольцо приземления снаряда в конечной точке дуги
  const endPt = _trajPts[lastIdx];
  impactGroup.position.set(endPt.x, endPt.y + 0.05, endPt.z);
  const pulse = 1.0 + Math.sin(performance.now() * 0.008) * 0.14;
  impactGroup.scale.setScalar(pulse);
  impactGroup.rotation.y = (performance.now() * 0.0025) % (Math.PI * 2);

  tGroup.visible = true;
}

export function triggerBlockSpawner(box) {
  const sd = box.spawnerData;
  if (!sd || sd.mode === 'none') return;
  const cx = box.m.position.x;
  const cy = box.y1 + 1.2;
  const cz = box.m.position.z;

  if (sd.spawnType === 'npc') {
    spawnCustomNPC({
      x: cx + rnd(-1.5, 1.5),
      y: cy,
      z: cz + rnd(-1.5, 1.5),
      name: 'SpawnBot_' + (S.customNPCs.length + 1)
    });
    sfx.coil();
  } else if (sd.spawnType === 'coin') {
    const coin = new THREE.Mesh(
      new THREE.CylinderGeometry(0.55, 0.55, 0.16, 16),
      new THREE.MeshStandardMaterial({ color: 0xffd700, metalness: 0.7, roughness: 0.2 })
    );
    coin.rotation.x = Math.PI / 2;
    coin.position.set(cx + rnd(-1.5, 1.5), cy + 0.5, cz + rnd(-1.5, 1.5));
    scene.add(coin);
    S.spawnedCoins.push({
      m: coin,
      x: coin.position.x,
      y: coin.position.y,
      z: coin.position.z,
      val: 25
    });
    sfx.cash();
  } else if (sd.spawnType === 'cube') {
    addSceneBlock({
      x: cx + rnd(-1, 1),
      y: cy + 1,
      z: cz + rnd(-1, 1),
      w: 1.8,
      h: 1.8,
      d: 1.8,
      colorHex: pick(['#ff6b6b', '#56f0ff', '#00e676', '#ffce3a']),
      label: 'Спавн-Куб',
      isCustom: true
    });
    rebuildPhysicsArrays();
    sfx.jump();
  }
}

export function oofRespawn(msg) {
  const player = S.player;
  if (!player || S.playerDead) return;
  if (player.carriedPhysicsBlock) {
    dropCarriedPhysicsBlock(player, 1.5);
  }
  sfx.oof();

  spawnDeathShatter(player);

  const mode = S.worldSettings.respawnMode || 'instant';
  if (mode === 'instant') {
    showBanner(msg, '#ff3e3e');
    completePlayerRespawn(false);
    return;
  }

  S.playerDead = true;
  S.deathReason = msg;
  player.rig.g.visible = false;
  player.tag.visible = false;

  const ov = ensureDeathOverlay();
  ov.hidden = false;
  $('deathSub').textContent = msg;

  if (mode === 'timer') {
    S.deathTimer = Math.max(1, Number(S.worldSettings.respawnDelay) || 3.5);
    $('deathBadge').textContent = 'ОЖИДАНИЕ РЕСПАВНА';
    $('deathTitle').textContent = '💀 ПЕРСОНАЖ РАЗВАЛИЛСЯ!';
    $('deathTimerBox').hidden = false;
    $('deathTimerBox').textContent = `${S.deathTimer.toFixed(1)} сек`;
    $('spectatorRestartBtn').hidden = true;
  } else if (mode === 'spectator') {
    try {
      if (document.pointerLockElement === cv) document.exitPointerLock();
    } catch (_) {}
    S.spectatorPos.set(player.x, Math.max(4, player.y + 5), player.z + 8);
    S.spectatorYaw = S.yaw;
    S.spectatorPitch = -0.35;
    $('deathBadge').textContent = 'РЕЖИМ НАБЛЮДАТЕЛЯ (SPECTATOR)';
    $('deathTitle').textContent = '👻 ТЫ В РЕЖИМЕ СПЕКТАТОРА';
    $('deathSub').textContent = `${msg} Летай по карте (WASD / QE + ПКМ) или нажми кнопку ниже для рестарта.`;
    $('deathTimerBox').hidden = true;
    $('spectatorRestartBtn').hidden = false;
  }
}

let _lastPhysErrLogAt = 0;
function runSafeSubsystem(label, fn) {
  try {
    fn();
  } catch (err) {
    const now = performance.now();
    if (now - _lastPhysErrLogAt > 2000) {
      _lastPhysErrLogAt = now;
      console.error(`[DebiX:${label}]`, err);
    }
  }
}

export function update(dt) {
  S.time += dt;
  if (S.contactDamageCooldown > 0) S.contactDamageCooldown -= dt;
  updateAudioEngineRuntime(dt);
  updateMultiplayerRuntime(dt);

  // Обновление глобального скрипта мира, скриптов блоков и ИИ NPC
  if (!S.studioMode || S.studioPlaytest) {
    runSafeSubsystem('scripts', () => updateAllScriptsRuntime(dt, S.player));
    runSafeSubsystem('statusEffects', () => updateStatusEffectsRuntime(dt));
  }

  const p = S.player;
  if (!p) return;

  if (p.attackCooldown > 0) p.attackCooldown = Math.max(0, p.attackCooldown - dt);
  if (p.kickCooldown > 0) p.kickCooldown = Math.max(0, p.kickCooldown - dt);
  if (p.stunTimer > 0) p.stunTimer = Math.max(0, p.stunTimer - dt);

  const activeHeld = getActiveHeldItem(p);
  const playerFrozen = isEntityFrozen(p);
  if (activeHeld) transferEffectsOnContact(activeHeld, p, dt, true, 0.8);
  if (p.carriedItem) transferEffectsOnContact(p.carriedItem, p, dt, true, 0.85);

  // Перезарядка оружия по УДЕРЖАНИЮ клавиши [R]
  if (S.isReloadingHold) {
    const canKeepReloading =
      S.state === 'play' &&
      !S.playerDead &&
      !!S.keys.KeyR &&
      !!activeHeld &&
      activeHeld.useType === 'ranged' &&
      !activeHeld.infiniteAmmo &&
      activeHeld.ammo < activeHeld.magSize &&
      (activeHeld.reserveAmmo ?? 0) > 0;

    if (!canKeepReloading) {
      cancelReloadHold(true);
    } else {
      const totalRel = Math.max(0.3, Number(activeHeld.reloadTime) || 1.2);
      S.reloadHoldT += dt;
      p.reloadTimer = Math.max(0.01, totalRel - S.reloadHoldT);
      const pct = Math.min(100, Math.round((S.reloadHoldT / totalRel) * 100));
      const rHud = ensureReloadHoldHUD();
      rHud.hidden = false;
      $('reloadHoldLbl').textContent = `🔄 УДЕРЖИВАЙ [R]: ${pct}% (${Math.max(0, totalRel - S.reloadHoldT).toFixed(1)}с)`;
      $('reloadHoldFill').style.width = `${pct}%`;

      if (S.reloadHoldT >= totalRel) {
        S.isReloadingHold = false;
        S.reloadHoldT = 0;
        p.reloadTimer = 0;
        rHud.hidden = true;
        const needed = activeHeld.magSize - activeHeld.ammo;
        const take = activeHeld.infiniteAmmo ? needed : Math.min(needed, activeHeld.reserveAmmo || 0);
        activeHeld.ammo += take;
        if (!activeHeld.infiniteAmmo) activeHeld.reserveAmmo = Math.max(0, (activeHeld.reserveAmmo || 0) - take);
        sfx.cash();
        renderHotbarUI();
        showBanner(`✅ «${activeHeld.name}» перезаряжен (${activeHeld.ammo}/${activeHeld.magSize})!`, '#00e676');
      }
    }
  } else {
    p.reloadTimer = 0;
    if ($('reloadHoldHUD') && !$('reloadHoldHUD').hidden) {
      $('reloadHoldHUD').hidden = true;
    }
  }

  // Автоматическая стрельба при удержании ЛКМ (в том числе при зажатом ПКМ прицеле!)
  if (
    S.lmbDown &&
    !playerFrozen &&
    activeHeld &&
    !isItemFrozen(activeHeld) &&
    activeHeld.useType === 'ranged' &&
    activeHeld.autoFire &&
    p.attackCooldown <= 0 &&
    !S.isReloadingHold &&
    p.reloadTimer <= 0
  ) {
    performPlayerMeleeAttack(false);
  }

  if (p._jumpGraceTimer > 0) p._jumpGraceTimer = Math.max(0, p._jumpGraceTimer - dt);
  updateBlocksLogicRuntime(dt, p);
  runSafeSubsystem('projectiles', () => updateProjectilesAndWorldItems(dt));
  updateAimTrajectoryAndTorch(p, dt);

  if (S.playerDead) {
    const mode = S.worldSettings.respawnMode || 'timer';
    if (mode === 'timer') {
      S.deathTimer -= dt;
      const tBox = $('deathTimerBox');
      if (tBox) tBox.textContent = `${Math.max(0, S.deathTimer).toFixed(1)} сек`;
      if (S.deathTimer <= 0) {
        completePlayerRespawn(false);
        showBanner('✨ Ты возродился на чекпоинте!', '#00e676');
      }
    } else if (mode === 'spectator') {
      const spd = (S.keys.ShiftLeft || S.keys.ShiftRight) ? 28 : 14;
      const fwd = new THREE.Vector3(
        -Math.sin(S.spectatorYaw) * Math.cos(S.spectatorPitch),
        Math.sin(S.spectatorPitch),
        -Math.cos(S.spectatorYaw) * Math.cos(S.spectatorPitch)
      );
      const right = new THREE.Vector3(Math.cos(S.spectatorYaw), 0, -Math.sin(S.spectatorYaw));
      if (S.keys.KeyW || S.keys.ArrowUp) S.spectatorPos.addScaledVector(fwd, spd * dt);
      if (S.keys.KeyS || S.keys.ArrowDown) S.spectatorPos.addScaledVector(fwd, -spd * dt);
      if (S.keys.KeyD || S.keys.ArrowRight) S.spectatorPos.addScaledVector(right, spd * dt);
      if (S.keys.KeyA || S.keys.ArrowLeft) S.spectatorPos.addScaledVector(right, -spd * dt);
      if (S.keys.Space || S.keys.KeyE) S.spectatorPos.y += spd * dt;
      if (S.keys.KeyQ) S.spectatorPos.y -= spd * dt;
    }

    if (S.gameMode && S.gameMode.onUpdate) {
      S.gameMode.onUpdate(dt, 0);
    }
    return;
  }

  // Если живой игрок сейчас в рэгдоле — симулируем физику падения до подъёма на ноги
  if (p.ragdoll && (p.ragdoll.active || p.ragdoll.recoverTimer > 0)) {
    const stillInRagdoll = updateEntityRagdollPhysics(p, dt);
    runSafeSubsystem('dynamicBlocks', () => updateDynamicBlocksPhysics(dt, p));
    updateEntityAnimation(p, dt, { moving: false, grounded: false, inLiquid: !!p.inLiquid });
    if (p.hpBarTimer > 0) {
      p.hpBarTimer -= dt;
      if (p.hpBarTimer <= 0) refreshEntityTagWithHP(p);
    }
    runSafeSubsystem('npcs', () => updateCustomNPCsRuntime(dt, p));
    if (S.gameMode && S.gameMode.onUpdate) S.gameMode.onUpdate(dt, 0);
    if (stillInRagdoll) {
      const hintEl = $('hint');
      if (hintEl && p.ragdoll?.active) {
        const rdHint = '⚡ НОКАУТ! Быстро жми [WASD / Пробел / ЛКМ], чтобы быстрее встать!';
        if (hintEl.textContent !== rdHint) {
          hintEl.textContent = rdHint;
          hintEl.hidden = false;
        }
      }
      return;
    }
  }

  const pr = p.colliderRadius || 0.42;
  const ph = p.colliderHeight || 2.5;

  if (S.keys.ArrowLeft) S.yaw += dt * 2.4;
  if (S.keys.ArrowRight) S.yaw -= dt * 2.4;

  let f = 0;
  let s = 0;
  if (S.keys.KeyW || S.keys.ArrowUp) f++;
  if (S.keys.KeyS || S.keys.ArrowDown) f--;
  if (S.keys.KeyA) s--;
  if (S.keys.KeyD) s++;
  if (S.joy.id !== null) {
    f -= S.joy.vy;
    s += S.joy.vx;
  }
  let len = Math.hypot(f, s);
  if (len > 1) {
    f /= len;
    s /= len;
    len = 1;
  }

  if (playerFrozen) {
    f = 0;
    s = 0;
    len = 0;
    p.isFlying = false;
  }

  let inLiquid = false;
  let activeLiqBlock = null;
  for (const b of S.allBlocks) {
    if (b.matterState === 'liquid') {
      if (b.m.material && b.m.material.map) {
        b.m.material.map.offset.y = (S.time * 0.25) % 1;
      }
      if (testPlayerOBB(p.x, p.y, p.z, pr, ph, b)) {
        inLiquid = true;
        activeLiqBlock = b;
        interactTargetWithLiquid(p, b, dt);
        if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'touch') || (b.logicData && b.logicData.trigger === 'touch')) {
          triggerBlockLogic(b, 'touch', p);
        }
        if (b.damageOnContact > 0 && S.contactDamageCooldown <= 0) {
          S.contactDamageCooldown = 0.55;
          dealDamage(p, b.damageOnContact);
        }
        if (b.teleportToCheckpoint) {
          oofRespawn('🌊 Водоворот поглотил тебя!');
        }
      }
    }
  }
  p.inLiquid = inLiquid;
  p.currentLiquidBlock = activeLiqBlock;

  const playerWeight = getEntityWeight(p);
  const carriedPhysW = p.carriedPhysicsBlock ? (Number(p.carriedPhysicsBlock.weight) || 15) : 0;
  const carryPhysPenalty = p.carriedPhysicsBlock
    ? clamp(1.0 - (carriedPhysW / Math.max(20, playerWeight * 1.25)) * 0.55, 0.38, 0.94)
    : 1.0;

  const equipSpdBonus = (activeHeld && !isItemFrozen(activeHeld)) ? (Number(activeHeld.equipStats?.speedBonus) || 0) : 0;
  const carryPenalty = (p.carriedItem ? 0.78 : 1.0) * carryPhysPenalty;
  const spdBoost = (p.hasSpeed || (S.activeSlot === 1 && p.hasSpeed)) ? 1.55 : 1.0;
  const stunMoveMult = (p.stunTimer || 0) > 0 ? 0.25 : 1.0;
  const playerWantsSprint = !!(S.keys.ShiftLeft || S.keys.ShiftRight) && !S.isAimingRMB && !S.isChargingThrow;
  const prevStamInt = Math.ceil(p.stamina ?? 100);
  const prevExh = !!p.staminaExhausted;
  const sprintMult = updateEntityStaminaAndSprint(p, dt, playerWantsSprint, len > 0.1);
  const playerSoaked = isEntitySoaked(p);
  if (p.isSprinting && playerSoaked && S.worldSettings.staminaDrainOnSprint !== false) {
    const extraStamMult = Math.max(0, getWetStaminaDrainMultiplier(p) - 1);
    const baseDrain = Number(S.worldSettings.staminaDrainRate) || 18;
    p.stamina = Math.max(0, (p.stamina ?? 100) - baseDrain * extraStamMult * dt);
  }
  if (Math.ceil(p.stamina ?? 100) !== prevStamInt || !!p.staminaExhausted !== prevExh) {
    updateShopUI();
  }
  const wetSpdMult = playerSoaked ? 0.92 : 1.0;
  const spd = ((p.walkSpeed || 7.6) + equipSpdBonus) * spdBoost * sprintMult * carryPenalty * stunMoveMult * wetSpdMult * (inLiquid ? 0.65 : 1.0);
  const fx = -Math.sin(S.yaw);
  const fz = -Math.cos(S.yaw);
  const rx = -fz;
  const rz = fx;

  let vx = p.vxKnock || 0;
  let vz = p.vzKnock || 0;
  p.vxKnock = (p.vxKnock || 0) * Math.pow(0.05, dt);
  p.vzKnock = (p.vzKnock || 0) * Math.pow(0.05, dt);

  const lockFaceToCamera =
    !playerFrozen &&
    (S.isAimingRMB ||
      S.isChargingThrow ||
      !!p.carriedPhysicsBlock ||
      !!(activeHeld && !isItemFrozen(activeHeld) && activeHeld.useType === 'ranged'));

  if (p.isFlying) {
    // Удобный отзывчивый режим полёта [V] в Песочнице: мгновенный отклик без заносов и гравитации
    const flyFast = (S.keys.ShiftLeft || S.keys.ShiftRight) ? 2.15 : 1.0;
    const flySpd = Math.max(12.5, (p.walkSpeed || 7.6) * 1.65) * flyFast;
    const cp = Math.cos(S.pitch);
    const camFwdX = -Math.sin(S.yaw) * cp;
    const camFwdY = Math.sin(S.pitch);
    const camFwdZ = -Math.cos(S.yaw) * cp;

    let flyVx = 0;
    let flyVy = 0;
    let flyVz = 0;

    if (len > 0.05) {
      flyVx = (camFwdX * f + rx * s) * flySpd;
      flyVz = (camFwdZ * f + rz * s) * flySpd;
      // При движении вперёд/назад плавно летим также по вертикальному углу камеры
      flyVy += camFwdY * f * flySpd;
      p.rot = lockFaceToCamera ? S.yaw + Math.PI : Math.atan2(flyVx, flyVz);
      p.step += flySpd * dt * 0.65;
    } else if (lockFaceToCamera) {
      p.rot = S.yaw + Math.PI;
    }

    if (S.keys.Space || S.btnJump) flyVy += flySpd * 0.85;
    if (S.keys.KeyQ || S.keys.KeyC || S.keys.ControlLeft || S.keys.ControlRight) flyVy -= flySpd * 0.85;

    p.vxKnock = 0;
    p.vzKnock = 0;
    p.vy = 0;
    p.x += flyVx * dt;
    p.y += flyVy * dt;
    p.z += flyVz * dt;
    p.grounded = false;
  } else {
    const surfSample = p._wasGroundedPrev ? sampleSurfaceWeatherAt(p.x, p.y, p.z) : null;
    const onSlipperyIce = playerFrozen || (p._supportBlock && isBlockSlippery(p._supportBlock)) || Boolean(surfSample?.onFrozenPuddle);
    let moveVx = 0;
    let moveVz = 0;

    if (!playerFrozen && len > 0.1) {
      moveVx = (fx * f + rx * s) * spd;
      moveVz = (fz * f + rz * s) * spd;

      // Если игрок несёт привязанный верёвкой объект — чем сильнее натяжение, тем тяжелее идти от якоря
      if (p.carriedPhysicsBlock && (p._ropeResistStrength || 0) > 0.01) {
        const outDot = moveVx * (p._ropeResistDirX || 0) + moveVz * (p._ropeResistDirZ || 0);
        if (outDot > 0) {
          const cut = outDot * clamp(p._ropeResistStrength, 0, 0.98);
          moveVx -= (p._ropeResistDirX || 0) * cut;
          moveVz -= (p._ropeResistDirZ || 0) * cut;
        }
      }

      p.rot = lockFaceToCamera ? S.yaw + Math.PI : Math.atan2(moveVx, moveVz);
      p.step += Math.hypot(moveVx, moveVz) * dt;
    } else if (lockFaceToCamera) {
      p.rot = S.yaw + Math.PI;
    }

    if (onSlipperyIce && !inLiquid) {
      // Инерционное скольжение по льду / в замороженном состоянии
      const iceAccel = playerFrozen ? 0.55 : 2.3;
      const blend = 1 - Math.exp(-iceAccel * dt);
      p._iceSlideVx = (p._iceSlideVx || 0) + (moveVx - (p._iceSlideVx || 0)) * blend;
      p._iceSlideVz = (p._iceSlideVz || 0) + (moveVz - (p._iceSlideVz || 0)) * blend;
      vx += p._iceSlideVx;
      vz += p._iceSlideVz;
    } else {
      p._iceSlideVx = moveVx;
      p._iceSlideVz = moveVz;
      vx += moveVx;
      vz += moveVz;
    }

    // Упругая оттяжка игрока натянутой верёвкой
    if (!playerFrozen && p.carriedPhysicsBlock && (p._ropePullX || p._ropePullZ)) {
      vx += clamp((p._ropePullX || 0) * dt * 1.4, -10, 10);
      vz += clamp((p._ropePullZ || 0) * dt * 1.4, -10, 10);
    }

    p.x += vx * dt;
    p.z += vz * dt;

    // Течение в физической жидкости двигает игрока
    if (inLiquid && activeLiqBlock && activeLiqBlock.liquidPhysicsEnabled !== false) {
      if (activeLiqBlock.conveyorVx) vx += activeLiqBlock.axisX.x * activeLiqBlock.conveyorVx;
      if (activeLiqBlock.conveyorVz) vz += activeLiqBlock.axisZ.z * activeLiqBlock.conveyorVz;
    }

    const totalEffectiveWeight = playerWeight * getWetWeightMultiplier(p) + carriedPhysW * 0.65;
    const weightGravMult = clamp(Math.pow(totalEffectiveWeight / 70, 0.35), 0.45, 2.2);
    const weightJumpMult = clamp(Math.pow(70 / totalEffectiveWeight, 0.22), 0.55, 1.35);
    const gravBoost = (p.hasGrav ? 0.62 : 1.0) * weightGravMult;
    const baseJump = (p.jumpPower || 10.2) * weightJumpMult;

    const canCoyoteJump = p.grounded || (p._groundedAnimTimer || 0) > 0;
    if (!playerFrozen && (S.keys.Space || S.btnJump)) {
      if (inLiquid) {
        p.vy = clamp(6.4 * weightJumpMult, 3.2, 8.5);
      } else if (canCoyoteJump && (p._jumpGraceTimer || 0) <= 0) {
        const supportUpVy = (p._supportBlock && p._supportBlock.isDynamicPhysics)
          ? clamp(p._supportBlock.physVy || 0, 0, 7.5)
          : 0;
        p.vy = (p.hasGrav ? baseJump * 1.32 : baseJump) + supportUpVy;
        p.grounded = false;
        p._groundedAnimTimer = 0;
        p._supportBlock = null;
        p._jumpGraceTimer = 0.22;
        sfx.jump();
      }
    }

    if (inLiquid) {
      if (activeLiqBlock && activeLiqBlock.liquidPhysicsEnabled !== false) {
        const liqBuoy = Number(activeLiqBlock.liquidBuoyancy) || 45;
        if (totalEffectiveWeight < liqBuoy * 1.35 && !(S.keys.Space || S.btnJump)) {
          const floatUp = clamp((liqBuoy * 1.35 - totalEffectiveWeight) * 0.12, 0.5, 5.5);
          if (p.y + ph * 0.72 < activeLiqBlock.y1) {
            p.vy = clamp(p.vy + floatUp * dt * 4.0, -3.5, 5.2);
          } else {
            p.vy = clamp(p.vy - S.worldSettings.gravity * 0.2 * dt, -2.0, 2.0);
          }
        } else {
          const sinkRate = clamp(0.22 * (totalEffectiveWeight / Math.max(20, liqBuoy)), 0.15, 0.85);
          p.vy = clamp(p.vy - S.worldSettings.gravity * sinkRate * dt, -9.5, 6.8);
        }
      } else {
        p.vy = clamp(p.vy - S.worldSettings.gravity * 0.25 * dt, -4.5, 6.8);
      }
    } else {
      p.vy = Math.max(-34, p.vy - S.worldSettings.gravity * gravBoost * dt);
    }
    p.y += p.vy * dt;
    p._wasGroundedPrev = p.grounded || (p._groundedAnimTimer || 0) > 0;
    p.grounded = false;
  }

  // Когда игрок уже шёл/стоял по поверхности (и не прыгает), проверяем контакт на 16 см вниз,
  // чтобы на наклонных досках моста и качающихся плотах контакт с полом никогда не прерывался!
  const probeDepth = 0.05;
  const blocksList = S.allBlocks.slice();
  for (const b of blocksList) {
    if (b.spawnerData && b.spawnerData.mode === 'timer') {
      b.spawnerData.timer -= dt;
      if (b.spawnerData.timer <= 0) {
        b.spawnerData.timer = b.spawnerData.interval || 5;
        triggerBlockSpawner(b);
      }
    }

    if (b.spinSpeed !== 0) {
      b.m.rotation.y += b.spinSpeed * dt;
      updateBlockOBB(b);
    }

    if (b.matterState === 'liquid') continue;
    if (b._isCarriedByPlayer) continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;

    const hit = testPlayerOBB(p.x, p.y - probeDepth, p.z, pr, ph + probeDepth, b);
    if (!hit) continue;

    transferEffectsOnContact(b, p, dt, true, 1.0);

    if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'touch') || (b.logicData && b.logicData.trigger === 'touch')) {
      triggerBlockLogic(b, 'touch', p);
      if (b.components?.script?.enabled && b.scriptData?.enabled) {
        runBlockScriptHook(b, 'onCollide', { entity: p });
      }
      if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    }

    if (b.matterState === 'gas') {
      if (b.bounciness > 0) p.vy = b.bounciness;
      if (b.damageOnContact > 0 && S.contactDamageCooldown <= 0) {
        S.contactDamageCooldown = 0.6;
        dealDamage(p, b.damageOnContact);
      }
      if (b.teleportToCheckpoint) {
        oofRespawn('☁️ Газовая ловушка уничтожила тебя!');
        break;
      }
      continue;
    }

    if (b.matterState === 'solid') {
      if (b.damageOnContact > 0 && S.contactDamageCooldown <= 0) {
        S.contactDamageCooldown = 0.55;
        dealDamage(p, b.damageOnContact);
        if (S.playerDead) break;
      }
      if (b.teleportToCheckpoint) {
        oofRespawn(b.spinSpeed !== 0 ? '🌀 Тебя сбила вращающаяся балка!' : '💥 Смертельный контакт с ловушкой!');
        break;
      }
      if (b.spawnerData && b.spawnerData.mode === 'contact' && S.contactDamageCooldown <= 0) {
        S.contactDamageCooldown = 1.2;
        triggerBlockSpawner(b);
      }

      if (hit.ny > 0.42) {
        const blockVertVel = b.isDynamicPhysics ? (b.physVy || 0) : 0;
        if ((p._jumpGraceTimer || 0) <= 0 && p.vy <= blockVertVel + 1.2) {
          // Точная проекция подушки probeDepth на нормаль наклонной грани (hit.ny):
          // никогда не тянет игрока вниз сквозь доску моста, но держит стопы строго на поверхности!
          const realPen = hit.pen - probeDepth * hit.ny;
          if (realPen > 0) {
            p.y += realPen / Math.max(0.42, hit.ny);
          } else if (realPen < -0.002 && p._wasGroundedPrev && b.isDynamicPhysics) {
            // Мягко опускаем стопы на миллиметры вслед за наклонной гранью без отрыва от палубы
            p.y += realPen / Math.max(0.42, hit.ny);
          }
          const landingVy = p.vy;
          p.vy = blockVertVel > 0.05 ? blockVertVel : 0;
          p.grounded = true;
          p._groundedAnimTimer = 0.2;
          p._supportBlock = b;
          if (!p._supportNormal) p._supportNormal = new THREE.Vector3(0, 1, 0);
          p._supportNormal.set(hit.nx, hit.ny, hit.nz).normalize();

          const slopeSin = Math.hypot(hit.nx, hit.nz);
          if (slopeSin > 0.46 && len < 0.1) {
            const slideSpeed = (slopeSin - 0.46) * 8.5;
            p.x += hit.nx * slideSpeed * dt;
            p.z += hit.nz * slideSpeed * dt;
          }

          if (landingVy < -17.5 && !b.bounciness && !p.inLiquid) {
            const fallImp = Math.min(8, Math.abs(landingVy) * 0.25);
            triggerEntityRagdoll(p, -Math.sin(S.yaw) * fallImp, 2.2, -Math.cos(S.yaw) * fallImp, 1.5);
          }

          if (b.conveyorVz) {
            p.x += b.axisZ.x * b.conveyorVz * dt;
            p.z += b.axisZ.z * b.conveyorVz * dt;
          }
          if (b.conveyorVx) {
            p.x += b.axisX.x * b.conveyorVx * dt;
            p.z += b.axisX.z * b.conveyorVx * dt;
          }

          if (b.bounciness > 0) {
            p.vy = b.bounciness * hit.ny;
            p.vxKnock = (p.vxKnock || 0) + b.bounciness * hit.nx * 0.8;
            p.vzKnock = (p.vzKnock || 0) + b.bounciness * hit.nz * 0.8;
            p.grounded = false;
            sfx.coil();
          }
        }
      } else if (hit.ny < -0.45) {
        p.x += hit.nx * hit.pen;
        p.y += hit.ny * hit.pen;
        p.z += hit.nz * hit.pen;
        if (p.vy > 0) p.vy = 0;
      } else {
        const stepHeight = b.y1 - p.y;
        // Для статичных ступенек шаг до 0.62м, а для досок подвесного моста (isDynamicPhysics) — мягкий заход до 0.35м,
        // чтобы игрок свободно перешагивал со звена на звено моста и не упирался в края досок!
        const canStepDynamic = b.isDynamicPhysics && p._wasGroundedPrev && (p._jumpGraceTimer || 0) <= 0;
        const maxStepH = b.isDynamicPhysics ? 0.35 : 0.62;
        if (
          (!b.isDynamicPhysics || canStepDynamic) &&
          b.spinSpeed === 0 &&
          hit.topFactor > 0.65 &&
          stepHeight > 0.01 &&
          stepHeight <= maxStepH &&
          p.vy <= 0.5
        ) {
          p.y = b.isDynamicPhysics ? Math.min(b.y1, p.y + Math.max(0.06, stepHeight * 0.6)) : b.y1;
          p.vy = 0;
          p.grounded = true;
          p._groundedAnimTimer = 0.2;
          p._supportBlock = b;
          if (!p._supportNormal) p._supportNormal = new THREE.Vector3(0, 1, 0);
          p._supportNormal.copy(b.axisY);
        } else {
          const hLen = Math.hypot(hit.nx, hit.nz) || 1;
          const nx = hit.nx / hLen;
          const nz = hit.nz / hLen;

          const cl = b._physCluster;
          // Запрещаем ногам игрока толкать вбок тот куб, на котором игрок сейчас стоит или с которого прыгает (защита от выброса на кубе 2×2×2!)
          const isStandingOnThis = p._supportBlock === b || (cl && cl.members.includes(p._supportBlock)) || p.y >= b.y1 - 0.38;
          const canMoveCluster = b.isDynamicPhysics && !isStandingOnThis && (!cl || !cl.isStaticAnchored);
          if (canMoveCluster) {
            const effMass = cl ? cl.totalInertialMass : getInertialMass(b.weight);
            const pW = Math.max(5, playerWeight);
            const pushMobility = (pW * pW) / (pW * pW + (effMass * 1.35) * (effMass * 1.35));

            const blockPushDist = hit.pen * pushMobility;
            const playerPushBack = hit.pen * (1 - pushMobility);

            if (cl) {
              transformWeldedCluster(cl, -nx * blockPushDist, 0, -nz * blockPushDist, null, null, null);
            } else {
              b.m.position.x -= nx * blockPushDist;
              b.m.position.z -= nz * blockPushDist;
              updateBlockOBB(b);
            }
            p.x += nx * playerPushBack;
            p.z += nz * playerPushBack;

            const contactY = clamp(p.y + ph * 0.58, b.y0 + 0.1, b.y1 - 0.1);
            const hitWorldPt = new THREE.Vector3(p.x - nx * pr, contactY, p.z - nz * pr);
            const pushForce = spd * pushMobility * 1.35;
            applyImpulseToDynamicBlock(b, -nx * pushForce, 0, -nz * pushForce, hitWorldPt);
          } else {
            p.x += nx * hit.pen;
            p.z += nz * hit.pen;
          }

          if (b.spinSpeed !== 0) {
            p.vxKnock = nx * 9;
            p.vzKnock = nz * 9;
          }
        }
      }

      if (b.checkpointData && b.checkpointData.enabled && p.grounded && hit.ny > 0.45) {
        const cd = b.checkpointData;
        const cx = b.m.position.x;
        const cz = b.m.position.z;
        p.respawnX = cx;
        p.respawnY = b.y1 + 0.5;
        p.respawnZ = cz;
        if (cd.stage > p.bestObby) {
          p.bestObby = cd.stage;
          const mult = (p.rebirths + 1) * (p.hasHalo ? 2 : 1);
          const earned = cd.rewardCash * mult;
          p.cash += earned;
          sfx.checkpoint();
          if (S.gameMode && S.gameMode.onCheckpointReached) {
            S.gameMode.onCheckpointReached(cd, earned);
          } else {
            updateShopUI();
            showBanner(`⭐ ${cd.title}! +${earned} R$!`, '#00e676');
          }
        }
      }
    }
  }

  for (let i = S.spawnedCoins.length - 1; i >= 0; i--) {
    const c = S.spawnedCoins[i];
    c.m.rotation.z += 3 * dt;
    if (Math.hypot(p.x - c.x, p.z - c.z) < 1.6 && Math.abs(p.y - c.y) < 2.2) {
      p.cash += c.val * (p.hasHalo ? 2 : 1);
      scene.remove(c.m);
      S.spawnedCoins.splice(i, 1);
      sfx.cash();
      updateShopUI();
    }
  }

  runSafeSubsystem('dynamicBlocks', () => updateDynamicBlocksPhysics(dt, p));

  if (p.y < -18 && !S.playerDead) {
    oofRespawn('☁️ Ты упал с облаков в бездну!');
  }

  if (S.gameMode && S.gameMode.onUpdate) {
    S.gameMode.onUpdate(dt, len);
  }

  if (p.grounded) {
    p._groundedAnimTimer = 0.18;
  } else if (p._groundedAnimTimer > 0) {
    p._groundedAnimTimer = Math.max(0, p._groundedAnimTimer - dt);
  }
  const isStableGrounded = p.grounded || (p._groundedAnimTimer || 0) > 0;
  if (!isStableGrounded) {
    p._supportBlock = null;
  }

  // Следы и проминание снега под ногами игрока (шаги + приземление)
  if (p.grounded && !p.isFlying && !p.inLiquid && !playerFrozen) {
    const pScale = Math.abs(p.rig?.g?.scale?.y || 1);
    const stepStride = clamp(0.66 * pScale, 0.35, 1.8);
    if (!p._wasGroundedPrev) {
      stampSnowFootprint(p.x, p.y, p.z, p.rot || 0, -1, p._supportBlock, p);
      stampSnowFootprint(p.x, p.y, p.z, p.rot || 0, 1, p._supportBlock, p);
      p._snowStepDist = 0;
    } else if (len > 0.1) {
      p._snowStepDist = (p._snowStepDist || 0) + Math.hypot(vx, vz) * dt;
      if (p._snowStepDist >= stepStride) {
        p._snowStepDist -= stepStride;
        p._snowFootSide = -(p._snowFootSide || 1);
        stampSnowFootprint(p.x, p.y, p.z, p.rot || 0, p._snowFootSide, p._supportBlock, p);
      }
    }
  }

  // Гарантированное обновление процедурной анимации и 15 жестов R6 со стабилизацией на наклонных мостах и плотах
  if (!playerFrozen) {
    updateEntityAnimation(p, dt, {
      moving: len > 0.1,
      grounded: isStableGrounded,
      inLiquid: p.inLiquid
    });
  }
  if (p.rig && p.rig.g) {
    p.rig.g.position.set(p.x, p.y, p.z);

    // Плавный наклон модели игрока относительно наклона физического объекта под ногами (плота, моста, рампы)
    if (!p._visualUp) p._visualUp = new THREE.Vector3(0, 1, 0);
    if (isStableGrounded && p._supportBlock && p._supportBlock.isDynamicPhysics && p._supportNormal) {
      _vTmp1.set(
        clamp(p._supportNormal.x, -0.55, 0.55),
        Math.max(0.78, p._supportNormal.y),
        clamp(p._supportNormal.z, -0.55, 0.55)
      ).normalize();
    } else {
      _vTmp1.set(0, 1, 0);
    }
    p._visualUp.lerp(_vTmp1, 1 - Math.exp(-14 * dt)).normalize();

    if (p._visualUp.y < 0.9995) {
      _qStep.setFromUnitVectors(_vWorldUp, p._visualUp);
      _qInv.setFromAxisAngle(_vWorldUp, p.rot);
      p.rig.g.quaternion.copy(_qStep).multiply(_qInv);
      p.rig.g.rotation.setFromQuaternion(p.rig.g.quaternion);
    } else {
      p.rig.g.rotation.set(0, p.rot, 0);
    }
  }
  if (p.tag) {
    p.tag.position.set(p.x, p.y + 3.35, p.z);
  }

  // Плавное обновление и угасание облачков чата и полоски HP над головой игрока
  if (p.hpBarTimer > 0) {
    p.hpBarTimer -= dt;
    if (p.hpBarTimer <= 0) refreshEntityTagWithHP(p);
  }
  if ((p.chatQueue && p.chatQueue.length > 0) || p.chatT > 0) {
    if (p.chatT > 0) {
      p.chatT -= dt;
      if (p.chatT <= 0) p.chat = '';
    }
    refreshEntityTagWithHP(p);
  }

  // Пассивный авто-реген HP игрока: если стоит на месте, вне боя >= 4 сек и никто из NPC его не преследует
  if (p.hpEnabled && !S.playerDead && p.hp > 0 && p.hp < p.maxHp && len <= 0.08 && p.grounded) {
    const timeSinceCombat = (S.time || 0) - (p._lastCombatTime || -99);
    const isPursuedByNpc = S.customNPCs.some(
      n => n && !(n._deadCooldown > 0) && n._aggroTarget === p && Math.hypot(n.x - p.x, n.z - p.z) < 20
    );
    if (timeSinceCombat >= 4.0 && !isPursuedByNpc) {
      const prevCeil = Math.ceil(p.hp);
      p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.08 * dt);
      p.hpBarTimer = 1.5;
      if (Math.ceil(p.hp) !== prevCeil || p.hp >= p.maxHp) {
        refreshEntityTagWithHP(p);
        updateShopUI();
      }
    }
  }

  runSafeSubsystem('npcs', () => updateCustomNPCsRuntime(dt, p));

  // Обработка диалога с NPC по нажатию [E] без дублирования с предметами и кнопками
  const nearItem = findNearestWorldItem(p, 4.2);
  const nearPhysBlk = (!p.carriedItem && !p.carriedPhysicsBlock && !nearItem) ? findNearestCarryablePhysicsBlock(p, 4.2) : null;
  const nearKeyE = findNearestKeyEBlock(p, 5.0);
  const nearNpc = (!p.carriedItem && !p.carriedPhysicsBlock && !nearItem && !nearPhysBlk && !nearKeyE) ? findNearestDialogueNPC(p, 4.4) : null;

  if (S.keys.KeyE && !S._prevNpcKeyE) {
    S._prevNpcKeyE = true;
    if (nearNpc) {
      triggerNpcDialogue(p, nearNpc);
    }
  } else if (!S.keys.KeyE) {
    S._prevNpcKeyE = false;
  }

  // Подсказка внизу экрана (Предметы в мире / Физический блок / Контейнер в руках / Кнопки [E] / Диалог NPC / Подсказка режима)
  let h = '';

  if (p.carriedPhysicsBlock) {
    h = `📦 В руках: «${p.carriedPhysicsBlock.label}» (${p.carriedPhysicsBlock.weight || 15} кг) · [ЛКМ] — Бросить · [E / G] — Опустить`;
  } else if (p.carriedItem) {
    h = `📦 В руках: «${p.carriedItem.name}» · [ЛКМ] — Бросить · [E / G] — Поставить на землю`;
  } else if (nearItem) {
    h = nearItem.item.holdMode === 'carried'
      ? `📦 Нажми [E] — Взять в 2 руки «${nearItem.item.name}»`
      : `${nearItem.item.icon || '🗡️'} Нажми [E] — Подобрать «${nearItem.item.name}»`;
  } else if (nearPhysBlk) {
    const maxLift = getMaxLiftableBlockWeight(p);
    const bw = nearPhysBlk.weight || 15;
    h = bw <= maxLift
      ? `📦 Нажми [E] — Поднять «${nearPhysBlk.label}» (Вес: ${bw} кг)`
      : `🪨 «${nearPhysBlk.label}» слишком тяжёлый для подъёма (${bw} кг > макс. ${maxLift} кг)`;
  } else if (nearKeyE) {
    if (nearKeyE.logicData && nearKeyE.logicData.trigger === 'keyE') {
      const info = getLogicBadgeStrings(nearKeyE);
      h = `🔘 Нажми [E] — ${info ? info.title : nearKeyE.label}${info && info.sub ? ' (' + info.sub + ')' : ''}`;
    } else if (nearKeyE.spawnerData && nearKeyE.spawnerData.mode === 'keyE') {
      h = `🔘 Нажми [E] — Активировать спавнер «${nearKeyE.label}»`;
    }
  } else if (nearNpc) {
    h = `💬 Нажми [E] — Поговорить с «${nearNpc.name}»`;
  } else if (activeHeld) {
    if (activeHeld.useType === 'ranged') {
      h = `${activeHeld.icon} ${activeHeld.name}: [ЛКМ] Огонь · [ПКМ] Прицел · Зажми [R] Перезарядка · [G] Выбросить`;
    } else if (activeHeld.useType === 'throwable') {
      h = `${activeHeld.icon} ${activeHeld.name}: Зажми [ЛКМ] для силы броска · [ПКМ] Траектория · [G] Выбросить`;
    } else {
      h = `${activeHeld.icon} ${activeHeld.name}: [ЛКМ] Использовать · [G] Выбросить`;
    }
  } else if (S.gameMode && S.gameMode.getHintText) {
    h = S.gameMode.getHintText(p);
  }

  const hintEl = $('hint');
  if (hintEl && hintEl.textContent !== h) {
    hintEl.textContent = h;
    hintEl.hidden = !h;
  }
}

/* ============================================================================
   МОДУЛЬНАЯ СИСТЕМА ИИ, ФИЗИКИ, ПАРКУРА, ПОИСКА ПУТИ (A*), ПОХОДКИ И ОШИБОК NPC
   (Zero-Allocation пулы для высокой производительности при больших толпах)
   ============================================================================ */

const _npcNearbyBlocks = [];
const _npcProbeResult = {
  wallBlocked: false,
  needsJumpUp: false,
  climbH: 0,
  isSafeDrop: false,
  surfaceY: -Infinity,
  obstacleTopY: -Infinity,
  hasHazard: false,
  isPit: false,
  interactBlock: null
};

// Статические буферы локальной сетки A* (9x9 = 81 узел, шаг 1.5м) — 0 аллокаций в секунду
const ASTAR_GRID_R = 4;
const ASTAR_GRID_SIDE = ASTAR_GRID_R * 2 + 1; // 9
const ASTAR_TOTAL_CELLS = ASTAR_GRID_SIDE * ASTAR_GRID_SIDE; // 81
const ASTAR_CELL_SIZE = 1.5;
const _astarG = new Float32Array(ASTAR_TOTAL_CELLS);
const _astarF = new Float32Array(ASTAR_TOTAL_CELLS);
const _astarParent = new Int16Array(ASTAR_TOTAL_CELLS);
const _astarState = new Uint8Array(ASTAR_TOTAL_CELLS); // 0=unvisited, 1=open, 2=closed

// Кешированный поиск конечностей R6 для процедурных походок (Обычная / Монстр / Левитирующий)
function resolveEntityRigParts(ent) {
  if (!ent || !ent.rig || !ent.rig.g) return null;
  if (ent._cachedRigParts && ent._cachedRigRef === ent.rig) return ent._cachedRigParts;

  const r = ent.rig;
  const parts = {
    head: r.head || null,
    torso: r.torso || r.body || null,
    armL: r.armL || r.leftArm || r.lArm || null,
    armR: r.armR || r.rightArm || r.rArm || (r.handGripSocket ? r.handGripSocket.parent : null),
    legL: r.legL || r.leftLeg || r.lLeg || null,
    legR: r.legR || r.rightLeg || r.rLeg || null
  };

  for (const ch of r.g.children) {
    if (!ch || ch === r.carrySocket || ch === r.handGripSocket || ch.userData?.isCharPickMesh) continue;
    const py = ch.position.y;
    const px = ch.position.x;
    if (!parts.head && py > 1.95 && Math.abs(px) < 0.25) parts.head = ch;
    else if (!parts.torso && py >= 1.15 && py <= 1.95 && Math.abs(px) < 0.25) parts.torso = ch;
    else if (!parts.armL && py >= 1.15 && py <= 1.98 && px < -0.35) parts.armL = ch;
    else if (!parts.armR && py >= 1.15 && py <= 1.98 && px > 0.35) parts.armR = ch;
    else if (!parts.legL && py < 1.15 && px < -0.05) parts.legL = ch;
    else if (!parts.legR && py < 1.15 && px > 0.05) parts.legR = ch;
  }

  ent._cachedRigRef = r;
  ent._cachedRigParts = parts;
  return parts;
}

export function applyEntityGaitStyle(ent, dt, moving) {
  return 0;
}

export function findNearestDialogueNPC(player, maxDist = 4.4) {
  if (!player) return null;
  let best = null;
  let bestDist = maxDist;
  for (let i = 0; i < S.customNPCs.length; i++) {
    const npc = S.customNPCs[i];
    if (!npc || npc.isDisabled || npc._deadCooldown > 0 || npc._permanentlyDead) continue;
    const mods = npc.aiModules;
    if (!mods?.dialogue?.enabled || !mods.dialogue.interactKeyE) continue;
    const d = Math.hypot(npc.x - player.x, (npc.y - player.y) * 0.7, npc.z - player.z);
    if (d < bestDist) {
      bestDist = d;
      best = npc;
    }
  }
  return best;
}

// Поиск ближайшего живого игрока (среди локального игрока и всех подключённых гостей)
function findNearestPlayerForNpc(npc, maxRadius = Infinity) {
  let best = null;
  let bestDist = maxRadius;

  if (S.player && !S.playerDead) {
    const d = Math.hypot(S.player.x - npc.x, S.player.z - npc.z);
    if (d <= bestDist) {
      bestDist = d;
      best = S.player;
    }
  }
  const remotes = Object.values(S.remotePlayers || {});
  for (let i = 0; i < remotes.length; i++) {
    const rp = remotes[i];
    if (!rp || !rp.rig?.g?.visible) continue;
    const d = Math.hypot(rp.x - npc.x, rp.z - npc.z);
    if (d <= bestDist) {
      bestDist = d;
      best = rp;
    }
  }
  return best;
}

export function triggerNpcDialogue(player, npc) {
  if (!npc || npc._deadCooldown > 0) return;
  if (npc.aiModules?.customScript?.enabled) {
    runNpcScriptHook(npc, 'onDialogue', { player });
  }
  const mods = ensureNpcModules(npc);
  const lines = (mods.dialogue?.lines && mods.dialogue.lines.length > 0)
    ? mods.dialogue.lines
    : [npc.chat || 'Привет!'];
  npc._dlgIdx = ((npc._dlgIdx ?? -1) + 1) % lines.length;
  const line = lines[npc._dlgIdx];
  npc.chat = line;
  npc.chatT = 5.0;
  npc._hesitateTimer = Math.max(npc._hesitateTimer || 0, 1.8);
  if (player) {
    npc.rot = Math.atan2(player.x - npc.x, player.z - npc.z);
    npc.netRot = npc.rot;
  }
  sfx.click?.();
  refreshEntityTagWithHP(npc);
  showBanner(`💬 ${npc.name}: «${line}»`, '#56f0ff');
  broadcastMultiplayerPacket({
    type: 'npc_dialogue',
    npcId: npc.id,
    line,
    rot: npc.rot
  });
}

function gatherNpcNearbyBlocks(x, y, z, radiusXZ = 12.0, radiusY = 14.0) {
  _npcNearbyBlocks.length = 0;
  const minX = x - radiusXZ;
  const maxX = x + radiusXZ;
  const minZ = z - radiusXZ;
  const maxZ = z + radiusXZ;
  const minY = y - radiusY;
  const maxY = y + radiusY;

  const all = S.allBlocks;
  for (let i = 0; i < all.length; i++) {
    const b = all[i];
    if (!b || b.isDisabled || b._depletedDisabled) continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (b.x1 < minX || b.x0 > maxX || b.z1 < minZ || b.z0 > maxZ || b.y1 < minY || b.y0 > maxY) {
      continue;
    }
    _npcNearbyBlocks.push(b);
  }
}

function isBlockHazardous(b) {
  if (!b) return false;
  if (b.damageOnContact > 0 || b.teleportToCheckpoint) return true;
  if (
    b.components?.interaction?.enabled &&
    b.interactionData &&
    (b.interactionData.trigger === 'touch' || b.interactionData.trigger === 'radius') &&
    b.interactionData.actionType === 'health' &&
    (b.interactionData.healthMode === 'damage' || b.interactionData.healthMode === 'kill')
  ) {
    return true;
  }
  return false;
}

function isBlockNpcInteractableDoorOrSwitch(b) {
  if (!b || b._depletedDisabled || b._interactionDisabled) return false;
  const comps = b.components;
  if (comps?.motion?.enabled && b.motionData?.triggerMode === 'self') return true;
  if (comps?.signal?.enabled && b.signalData?.targetTag) return true;
  if (comps?.interaction?.enabled && (b.interactionData?.trigger === 'keyE' || b.interactionData?.trigger === 'hit') && b.interactionData?.actionType === 'ghost_pass') return true;
  if (b.logicData && (b.logicData.trigger === 'keyE' || b.logicData.trigger === 'hit')) return true;
  return false;
}

// Умный анализ колонки мира (wx, wz) для NPC: распознаёт уступы для запрыгивания, безопасные спуски вниз, двери и настоящие пропасти
function probeWorldColumnForNPC(wx, refY, wz, rad = 0.36, ph = 2.4, maxClimbH = 2.6, maxSafeDrop = 7.5) {
  _npcProbeResult.wallBlocked = false;
  _npcProbeResult.needsJumpUp = false;
  _npcProbeResult.climbH = 0;
  _npcProbeResult.isSafeDrop = false;
  _npcProbeResult.surfaceY = -Infinity;
  _npcProbeResult.obstacleTopY = -Infinity;
  _npcProbeResult.hasHazard = false;
  _npcProbeResult.isPit = false;
  _npcProbeResult.interactBlock = null;

  // 1. Ищем лучшую опорную поверхность (пол, возвышенность до maxClimbH или безопасный спуск до -maxSafeDrop)
  let bestFloorY = -Infinity;
  let bestFloorDist = Infinity;

  for (let i = 0; i < _npcNearbyBlocks.length; i++) {
    const b = _npcNearbyBlocks[i];
    if (wx + rad < b.x0 || wx - rad > b.x1 || wz + rad < b.z0 || wz - rad > b.z1) continue;

    if (b.isRotated && b.m) {
      _vLocal.set(wx - b.m.position.x, refY - b.m.position.y, wz - b.m.position.z).applyQuaternion(b.invQuat);
      if (Math.abs(_vLocal.x) > b.hx + rad || Math.abs(_vLocal.z) > b.hz + rad) continue;
    }

    const hazard = isBlockHazardous(b);
    if (hazard && b.y1 >= refY - maxSafeDrop && b.y0 <= refY + ph) {
      _npcProbeResult.hasHazard = true;
    }

    if (b.matterState !== 'solid') continue;

    const topY = b.y1;
    // Может ли персонаж встать на верхнюю грань этого блока (спуск до -maxSafeDrop или подъём до +maxClimbH)?
    if (topY >= refY - maxSafeDrop && topY <= refY + maxClimbH) {
      // Проверяем, свободно ли пространство для тела НАД этой гранью (соседние сбоку высокие ступеньки не считаются потолком!)
      let headroomClear = true;
      for (let j = 0; j < _npcNearbyBlocks.length; j++) {
        const ob = _npcNearbyBlocks[j];
        if (ob === b || ob.matterState !== 'solid') continue;
        if (wx <= ob.x0 + 0.08 || wx >= ob.x1 - 0.08 || wz <= ob.z0 + 0.08 || wz >= ob.z1 - 0.08) continue;
        if (ob.y0 < topY + ph - 0.15 && ob.y1 > topY + 0.42) {
          if (!isBlockNpcInteractableDoorOrSwitch(ob)) {
            headroomClear = false;
            break;
          }
        }
      }

      if (headroomClear) {
        // Предпочитаем самую высокую доступную поверхность в пределах прыжка, чтобы боты охотно забирались на платформы
        const vertDist = Math.abs(topY - refY);
        if (bestFloorY === -Infinity || topY > bestFloorY || vertDist < bestFloorDist) {
          bestFloorY = topY;
          bestFloorDist = vertDist;
          if (hazard) _npcProbeResult.hasHazard = true;
        }
      }
    }
  }

  _npcProbeResult.surfaceY = bestFloorY;

  if (bestFloorY === -Infinity) {
    _npcProbeResult.isPit = true;
  } else {
    const dy = bestFloorY - refY;
    if (dy > 0.62) {
      _npcProbeResult.needsJumpUp = true;
      _npcProbeResult.climbH = dy;
    } else if (dy < -0.65) {
      _npcProbeResult.isSafeDrop = true;
    }
  }

  // 2. Проверяем, не перегораживает ли саму точку (wx, wz) высокая глухая стена или закрытая дверь
  const checkBaseY = bestFloorY !== -Infinity ? Math.min(refY, bestFloorY) : refY;
  const wallRad = _npcProbeResult.needsJumpUp ? 0.08 : Math.min(rad, 0.24);
  for (let i = 0; i < _npcNearbyBlocks.length; i++) {
    const b = _npcNearbyBlocks[i];
    if (b.matterState !== 'solid') continue;
    if (wx + wallRad < b.x0 || wx - wallRad > b.x1 || wz + wallRad < b.z0 || wz - wallRad > b.z1) continue;
    if (b.isRotated && b.m) {
      _vLocal.set(wx - b.m.position.x, checkBaseY + 1.0 - b.m.position.y, wz - b.m.position.z).applyQuaternion(b.invQuat);
      if (Math.abs(_vLocal.x) > b.hx + wallRad || Math.abs(_vLocal.z) > b.hz + wallRad) continue;
    }

    // Если блок выше уровня доступного запрыгивания и перекрывает проход
    if (b.y1 > refY + maxClimbH && b.y0 < refY + ph - 0.15) {
      if (isBlockNpcInteractableDoorOrSwitch(b)) {
        _npcProbeResult.interactBlock = b;
      } else {
        _npcProbeResult.wallBlocked = true;
        if (b.y1 > _npcProbeResult.obstacleTopY) _npcProbeResult.obstacleTopY = b.y1;
      }
    } else if (bestFloorY !== -Infinity && Math.abs(b.y1 - bestFloorY) < 0.05) {
      // Это сам блок нашей опорной платформы или ступеньки — не стена
      continue;
    } else if (!_npcProbeResult.needsJumpUp && b.y1 > refY + 0.62 && b.y0 < refY + ph - 0.15 && bestFloorY < b.y1 - 0.1) {
      if (isBlockNpcInteractableDoorOrSwitch(b)) {
        _npcProbeResult.interactBlock = b;
      } else {
        _npcProbeResult.wallBlocked = true;
        if (b.y1 > _npcProbeResult.obstacleTopY) _npcProbeResult.obstacleTopY = b.y1;
      }
    }
  }

  return _npcProbeResult;
}

// Локальный поиск пути A* с поддержкой подъёма на возвышенности, спуска вниз и прыжков через ямы
function computeNpcSubgoalAStar(npc, tx, tz, perceivedJumpH, maxSafeDrop, canJump, jumpGaps, pathNoise) {
  const dxTotal = tx - npc.x;
  const dzTotal = tz - npc.z;
  const distTotal = Math.hypot(dxTotal, dzTotal);
  if (distTotal < 0.4) return { x: tx, z: tz };

  const climbLim = canJump ? perceivedJumpH : 0.62;
  const dirX = dxTotal / distTotal;
  const dirZ = dzTotal / distTotal;

  // Если прямая траектория на 2.2м вперёд проходима (ровно, безопасный спуск или запрыгиваемый уступ) — идём прямо
  const pr1 = probeWorldColumnForNPC(npc.x + dirX * 1.15, npc.y, npc.z + dirZ * 1.15, 0.36, 2.4, climbLim, maxSafeDrop);
  const pr2 = probeWorldColumnForNPC(npc.x + dirX * 2.25, npc.y, npc.z + dirZ * 2.25, 0.36, 2.4, climbLim, maxSafeDrop);
  if (!pr1.wallBlocked && !pr1.isPit && !pr1.hasHazard && !pr2.wallBlocked && !pr2.isPit && !pr2.hasHazard) {
    return { x: tx, z: tz };
  }

  _astarState.fill(0);
  _astarParent.fill(-1);

  const startIdx = ASTAR_GRID_R * ASTAR_GRID_SIDE + ASTAR_GRID_R;
  _astarG[startIdx] = 0;
  _astarF[startIdx] = distTotal;
  _astarState[startIdx] = 1;

  let bestIdx = startIdx;
  let bestH = distTotal;
  let iterations = 0;

  while (iterations++ < 48) {
    let cur = -1;
    let minF = Infinity;
    for (let i = 0; i < ASTAR_TOTAL_CELLS; i++) {
      if (_astarState[i] === 1 && _astarF[i] < minF) {
        minF = _astarF[i];
        cur = i;
      }
    }
    if (cur === -1) break;
    _astarState[cur] = 2;

    const cz = Math.floor(cur / ASTAR_GRID_SIDE) - ASTAR_GRID_R;
    const cx = (cur % ASTAR_GRID_SIDE) - ASTAR_GRID_R;
    const wx = npc.x + cx * ASTAR_CELL_SIZE;
    const wz = npc.z + cz * ASTAR_CELL_SIZE;

    const hToGoal = Math.hypot(tx - wx, tz - wz);
    if (hToGoal < bestH) {
      bestH = hToGoal;
      bestIdx = cur;
    }
    if (hToGoal <= ASTAR_CELL_SIZE * 1.1) {
      bestIdx = cur;
      break;
    }

    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const nx = cx + dx;
        const nz = cz + dz;
        if (nx < -ASTAR_GRID_R || nx > ASTAR_GRID_R || nz < -ASTAR_GRID_R || nz > ASTAR_GRID_R) continue;

        const nIdx = (nz + ASTAR_GRID_R) * ASTAR_GRID_SIDE + (nx + ASTAR_GRID_R);
        if (_astarState[nIdx] === 2) continue;

        const nwx = npc.x + nx * ASTAR_CELL_SIZE;
        const nwz = npc.z + nz * ASTAR_CELL_SIZE;
        const pr = probeWorldColumnForNPC(nwx, npc.y, nwz, 0.36, 2.4, climbLim, maxSafeDrop);

        if (pr.wallBlocked) continue;

        let stepCost = (dx !== 0 && dz !== 0) ? 1.42 : 1.0;

        if (pr.hasHazard) {
          stepCost += 15.0;
        }
        if (pr.needsJumpUp) {
          if (!canJump) continue;
          stepCost += 0.45 + pr.climbH * 0.25; // Небольшая цена прыжка, чтобы боты охотно забирались на возвышенности
        } else if (pr.isSafeDrop) {
          stepCost += 0.25; // Свободный спуск на безопасную высоту
        } else if (pr.isPit) {
          if (canJump && jumpGaps) {
            const landX = nwx + dx * ASTAR_CELL_SIZE;
            const landZ = nwz + dz * ASTAR_CELL_SIZE;
            const landPr = probeWorldColumnForNPC(landX, npc.y, landZ, 0.36, 2.4, climbLim, maxSafeDrop);
            if (!landPr.isPit && !landPr.wallBlocked && !landPr.hasHazard) {
              stepCost += 2.2;
            } else {
              continue;
            }
          } else {
            continue;
          }
        }

        const noisePenalty = pathNoise > 0 ? (((nIdx * 17 + Math.floor(S.time * 2)) % 7) * 0.22 * pathNoise) : 0;
        const tentativeG = _astarG[cur] + stepCost + noisePenalty;

        if (_astarState[nIdx] !== 1 || tentativeG < _astarG[nIdx]) {
          _astarParent[nIdx] = cur;
          _astarG[nIdx] = tentativeG;
          _astarF[nIdx] = tentativeG + Math.hypot(tx - nwx, tz - nwz) / ASTAR_CELL_SIZE;
          _astarState[nIdx] = 1;
        }
      }
    }
  }

  if (bestIdx === startIdx) {
    return { x: tx, z: tz };
  }

  let trace = bestIdx;
  let prev = bestIdx;
  while (_astarParent[trace] !== -1 && _astarParent[trace] !== startIdx) {
    prev = trace;
    trace = _astarParent[trace];
  }
  const pickCell = prev !== startIdx ? prev : trace;
  const gz = Math.floor(pickCell / ASTAR_GRID_SIDE) - ASTAR_GRID_R;
  const gx = (pickCell % ASTAR_GRID_SIDE) - ASTAR_GRID_R;
  return {
    x: npc.x + gx * ASTAR_CELL_SIZE,
    z: npc.z + gz * ASTAR_CELL_SIZE
  };
}

// Подбор лежащего в мире оружия/предмета ботом и взаимодействие с дверями/кнопками
function handleNpcWorldInteractions(npc, physMod, desiredMoveX, desiredMoveZ) {
  if (!physMod.enabled) return;

  // 1. Авто-подбор лежащего оружия/предмета, если у NPC пустые руки
  if (physMod.canPickupItems !== false && !npc.equippedItem && S.worldItems.length > 0) {
    for (let i = S.worldItems.length - 1; i >= 0; i--) {
      const wi = S.worldItems[i];
      if (!wi || wi.pickupCooldown > 0 || wi.item.holdMode === 'carried') continue;
      const d = Math.hypot(wi.x - npc.x, wi.y - (npc.y + 0.8), wi.z - npc.z);
      if (d < 2.2) {
        const pickedId = wi.id;
        npc.equippedItem = JSON.parse(JSON.stringify(wi.item));
        npc._magAmmo = npc.equippedItem.magSize || npc.equippedItem.ammo || 12;
        npc.reloadTimer = 0;
        if (wi.group) scene.remove(wi.group);
        if (wi.tag) scene.remove(wi.tag);
        S.worldItems.splice(i, 1);
        syncEntityHeldItemMesh(npc);
        sfx.coil?.();
        npc.chat = `О, подобрал «${npc.equippedItem.name}»! ${npc.equippedItem.icon || '🗡️'}`;
        npc.chatT = 3.0;
        refreshEntityTagWithHP(npc);
        syncWorldItemDeleteToNetwork(pickedId);
        syncNpcUpsertToNetwork(npc, false);
        break;
      }
    }
  }

  // 2. Открытие дверей, нажатие кнопок [E] и ударных переключателей перед собой
  if (physMod.canInteractBlocks !== false && (npc._interactCd || 0) <= 0) {
    const checkX = npc.x + desiredMoveX * 1.4;
    const checkZ = npc.z + desiredMoveZ * 1.4;
    for (let i = 0; i < _npcNearbyBlocks.length; i++) {
      const b = _npcNearbyBlocks[i];
      if (!isBlockNpcInteractableDoorOrSwitch(b)) continue;

      const rt = b.logicRuntime;
      // Если дверь уже открыта — не закрываем её перед своим носом
      if (rt && ((rt.openT || 0) > 0.25 || (rt.targetU || 0) > 0.25 || rt.ghostOpen)) continue;

      const dx = Math.max(b.x0 - checkX, 0, checkX - b.x1);
      const dz = Math.max(b.z0 - checkZ, 0, checkZ - b.z1);
      if (Math.hypot(dx, dz) < 1.35 && npc.y + 2.2 >= b.y0 && npc.y <= b.y1 + 0.5) {
        npc._interactCd = 1.6;
        const trigType = (b.components?.interaction?.enabled && b.interactionData?.trigger === 'hit') || (b.logicData?.trigger === 'hit')
          ? 'hit'
          : 'keyE';
        if (trigType === 'hit') triggerEntityAttack(npc, 'punch');
        triggerBlockLogic(b, trigType, npc);
        break;
      }
    }
  }
}

export function updateCustomNPCsRuntime(dt, player) {
  const grav = S.worldSettings.gravity || 22;
  const isAuthority = isLocalNpcAuthority();
  const netLerp = 1 - Math.exp(-14 * dt);

  for (let idx = 0; idx < S.customNPCs.length; idx++) {
    const npc = S.customNPCs[idx];
    if (!npc) continue;
    if (npc.isDisabled) {
      if (npc.rig?.g && npc.rig.g.visible) npc.rig.g.visible = false;
      if (npc.tag && npc.tag.visible) npc.tag.visible = false;
      continue;
    }

    // 0. Обработка окончательной смерти и кадрового таймера возрождения NPC
    if (npc._permanentlyDead) {
      if (npc.rig?.g && npc.rig.g.visible) npc.rig.g.visible = false;
      if (npc.tag && npc.tag.visible) npc.tag.visible = false;
      continue;
    }
    if (npc._deadCooldown > 0) {
      if (npc.rig?.g && npc.rig.g.visible) npc.rig.g.visible = false;
      if (npc.tag && npc.tag.visible) npc.tag.visible = false;
      if (isAuthority) {
        npc._deadCooldown -= dt;
        if (npc._deadCooldown <= 0) {
          npc._deadCooldown = 0;
          npc.hp = npc.maxHp || 100;
          npc.stamina = npc.maxStamina || 100;
          npc.staminaExhausted = false;
          npc.ragdoll = null;
          clearTargetStatusEffects(npc);
          npc.x = npc.homeX ?? npc.x;
          npc.y = npc.homeY ?? npc.y;
          npc.z = npc.homeZ ?? npc.z;
          npc.vy = 0;
          npc.vxKnock = 0;
          npc.vzKnock = 0;
          npc.tx = npc.x;
          npc.tz = npc.z;
          npc._aggroTarget = null;
          npc._aggroTimer = 0;
          npc.chat = 'Уф, меня собрали заново... 💫';
          npc.chatT = 3.5;
          if (npc.rig?.g) {
            npc.rig.g.position.set(npc.x, npc.y, npc.z);
            npc.rig.g.rotation.set(0, npc.rot || 0, 0);
            npc.rig.g.visible = true;
          }
          if (npc.tag) {
            npc.tag.position.set(npc.x, npc.y + 3.35, npc.z);
            npc.tag.visible = true;
          }
          refreshEntityTagWithHP(npc);
          syncNpcUpsertToNetwork(npc, false);
        }
      }
      continue;
    }

    // 0.5. Если NPC сейчас в рэгдоле — симулируем физику падения вместо ИИ-ходьбы
    if (isAuthority && npc.ragdoll && (npc.ragdoll.active || npc.ragdoll.recoverTimer > 0)) {
      const busyRagdoll = updateEntityRagdollPhysics(npc, dt);
      updateEntityAnimation(npc, dt, { moving: false, grounded: false, inLiquid: !!npc.inLiquid });
      if (busyRagdoll) continue;
    }

    const mods = ensureNpcModules(npc);

    // КЛИЕНТСКАЯ ИНТЕРПОЛЯЦИЯ НА ГОСТЕ (когда физику и ИИ считает Хост)
    if (!isAuthority) {
      if (npc.hpBarTimer > 0) {
        npc.hpBarTimer -= dt;
        if (npc.hpBarTimer <= 0) refreshEntityTagWithHP(npc);
      }
      if (npc.chatT > 0) {
        npc.chatT -= dt;
        if (npc.chatT <= 0) {
          npc.chat = '';
          refreshEntityTagWithHP(npc);
        }
      }

      const targetX = npc.netX !== undefined ? npc.netX : npc.x;
      const targetY = npc.netY !== undefined ? npc.netY : npc.y;
      const targetZ = npc.netZ !== undefined ? npc.netZ : npc.z;
      const targetRot = npc.netRot !== undefined ? npc.netRot : npc.rot;

      const dx = targetX - npc.x;
      const dy = targetY - npc.y;
      const dz = targetZ - npc.z;
      const distXZ = Math.hypot(dx, dz);

      if (distXZ > 25) {
        npc.x = targetX;
        npc.y = targetY;
        npc.z = targetZ;
      } else {
        npc.x += dx * netLerp;
        npc.y += dy * netLerp;
        npc.z += dz * netLerp;
      }

      let dRot = ((targetRot - npc.rot + Math.PI) % (Math.PI * 2)) - Math.PI;
      if (dRot < -Math.PI) dRot += Math.PI * 2;
      npc.rot += dRot * netLerp;

      const isMoving = !!npc._netMoving || distXZ > 0.035;
      if (isMoving) {
        npc.step = (npc.step || 0) + Math.max(distXZ * 12, (npc.walkSpeed || 5.4) * 2.2) * dt;
      }

      updateEntityAnimation(npc, dt, {
        moving: isMoving,
        grounded: npc.grounded !== false,
        inLiquid: !!npc.inLiquid
      });

      const hoverYOffset = applyEntityGaitStyle(npc, dt, isMoving);
      if (npc.rig?.g) {
        npc.rig.g.position.set(npc.x, npc.y + hoverYOffset, npc.z);
        npc.rig.g.rotation.set(0, npc.rot, 0);
      }
      if (npc.tag) {
        npc.tag.position.set(npc.x, npc.y + hoverYOffset + 3.35, npc.z);
      }
      continue;
    }

    const physMod = mods.worldPhysics;
    const navMod = mods.navigation;
    const errMod = mods.humanError;
    const cmbMod = mods.combat;
    const dlgMod = mods.dialogue;

    const npcFrozen = isEntityFrozen(npc);
    if (npc.equippedItem) transferEffectsOnContact(npc.equippedItem, npc, dt, true, 0.8);

    if (npc.hpBarTimer > 0) {
      npc.hpBarTimer -= dt;
      if (npc.hpBarTimer <= 0) refreshEntityTagWithHP(npc);
    }
    if (npc.chatT > 0) {
      npc.chatT -= dt;
    }
    if (npc.attackCooldown > 0) npc.attackCooldown = Math.max(0, npc.attackCooldown - dt);
    if (npc.stunTimer > 0) npc.stunTimer = Math.max(0, npc.stunTimer - dt);
    if (npc._hazardDamageCd > 0) npc._hazardDamageCd = Math.max(0, npc._hazardDamageCd - dt);
    if (npc._interactCd > 0) npc._interactCd = Math.max(0, npc._interactCd - dt);
    if (npc._edgeAvoidTimer > 0) npc._edgeAvoidTimer = Math.max(0, npc._edgeAvoidTimer - dt);

    // Обработка перезарядки стрелкового оружия у NPC
    if (npc.reloadTimer > 0) {
      npc.reloadTimer -= dt;
      if (npc.reloadTimer <= 0) {
        npc.reloadTimer = 0;
        const mag = Number(npc.equippedItem?.magSize) || 12;
        npc._magAmmo = mag;
        if (npc.chat === '🔄 Перезарядка...') {
          npc.chat = '';
          refreshEntityTagWithHP(npc);
        }
      }
    }

    if (npc._aggroTimer > 0) {
      npc._aggroTimer -= dt;
      if (npc._aggroTimer <= 0) npc._aggroTarget = null;
    }

    // Применение отдачи (knockback) с учётом скользкости льда и обледенелых луж
    const npcSurfSample = npc.grounded ? sampleSurfaceWeatherAt(npc.x, npc.y, npc.z) : null;
    const npcOnIce = isEntityFrozen(npc) || Boolean(npcSurfSample?.onFrozenPuddle);
    npc.x += (npc.vxKnock || 0) * dt;
    npc.z += (npc.vzKnock || 0) * dt;
    npc.vxKnock = (npc.vxKnock || 0) * Math.pow(npcOnIce ? 0.65 : 0.05, dt);
    npc.vzKnock = (npc.vzKnock || 0) * Math.pow(npcOnIce ? 0.65 : 0.05, dt);

    const npcSoaked = isEntitySoaked(npc);
    const npcWetWeightMult = getWetWeightMultiplier(npc);
    const walkSpd = clamp(Number(navMod.walkSpeed) || 5.4, 1.5, 24) * (npcSoaked ? 0.92 : 1.0);
    const jumpPwr = clamp(Number(navMod.jumpPower) || 10.2, 4.0, 30) / Math.pow(npcWetWeightMult, 0.28);
    const effGrav = grav * clamp(Number(physMod.gravityScale) || 1.0, 0.2, 3.0);

    if (npc.grounded || npc._supportY === undefined) {
      npc._supportY = npc.y;
    }

    // Истинные физические возможности прыжка с учётом авто-зашагивания (+0.58м на пике прыжка)
    const trueMaxJumpH = (jumpPwr * jumpPwr) / (2 * effGrav) + 0.58;
    const trueMaxJumpDist = Math.min(9.0, walkSpd * ((2 * jumpPwr) / effGrav) * 0.88);
    const fallThresh = Number(physMod.fallDamageThreshold) || 16.5;
    const maxSafeDrop = physMod.fallDamage
      ? Math.max(4.5, ((fallThresh - 2.0) * (fallThresh - 2.0)) / (2 * effGrav))
      : 22.0;

    // Модуль ошибок: раз в 2.5 сек обновляем коэффициент «самоуверенности» бота
    if (npc._errRollTimer === undefined || (npc._errRollTimer -= dt) <= 0) {
      npc._errRollTimer = rnd(1.8, 3.2);
      if (errMod.enabled && Math.random() < (Number(errMod.jumpMistakeChance) || 0.22) * (Number(errMod.mistakeLevel) || 0.25) * 2.2) {
        npc._jumpOverestimate = rnd(1.35, 1.72);
        npc._lateJumpMistake = Math.random() < 0.45;
      } else {
        npc._jumpOverestimate = 1.0;
        npc._lateJumpMistake = false;
      }

      if (
        errMod.enabled &&
        !npc._aggroTarget &&
        Math.random() < (Number(errMod.hesitationChance) || 0.15) * (Number(errMod.mistakeLevel) || 0.25)
      ) {
        npc._hesitateTimer = rnd(0.45, 1.15);
      }
    }

    const perceivedJumpH = (navMod.canJump ? trueMaxJumpH : 0.62) * (npc._jumpOverestimate || 1.0);
    const perceivedJumpDist = trueMaxJumpDist * (npc._jumpOverestimate || 1.0);

    const smartBot = isNpcSmart(npc);
    if (physMod.enabled || navMod.usePathfinding) {
      gatherNpcNearbyBlocks(npc.x, npc.y, npc.z, smartBot ? 22.0 : 12.0, 16.0);
    } else {
      _npcNearbyBlocks.length = 0;
    }

    // 1. СЕНСОРИКА, ФРАКЦИИ И ВЫБОР ЦЕЛИ (Игроки + Враждебные фракции NPC + Помощь своим у умных ботов)
    const hadTargetBefore = !!npc._hadActiveTarget;
    const activeTarget = acquireBestTargetForNpc(npc);

    // Если бот только что убил или потерял цель — мгновенно сбрасываем паузу раздумий и выбираем новый маршрут!
    if (hadTargetBefore && !activeTarget) {
      npc.wTimer = 0;
      npc._aiTickTimer = 0;
      npc._hesitateTimer = 0;
      npc._subgoal = null;
      npc._elevPathCache = null;
      npc.attackCooldown = 0;
    }
    npc._hadActiveTarget = !!activeTarget;

    let moving = false;
    let desiredMoveX = 0;
    let desiredMoveZ = 0;
    let tacticalState = 'idle';

    // Если у NPC пустые руки, а рядом лежит бесхозное оружие — бежим за ним!
    let nearbyFreeItem = null;
    if (physMod.enabled && physMod.canPickupItems !== false && !npc.equippedItem && S.worldItems.length > 0) {
      let bestItmDist = 8.5;
      for (let i = 0; i < S.worldItems.length; i++) {
        const wi = S.worldItems[i];
        if (!wi || wi.pickupCooldown > 0 || wi.item.holdMode === 'carried') continue;
        if (wi.item.useType === 'consumable') continue;
        const dItm = Math.hypot(wi.x - npc.x, wi.z - npc.z);
        if (dItm < bestItmDist && Math.abs(wi.y - npc.y) <= perceivedJumpH + 2.0) {
          bestItmDist = dItm;
          nearbyFreeItem = wi;
        }
      }
    }

    if (npcFrozen) {
      moving = false;
    } else if ((npc.stunTimer || 0) > 0) {
      moving = false;
      if (Math.random() < dt * 5.0) {
        emitParticleBurst(npc.x, npc.y + 2.55, npc.z, 1, {
          preset: 'star',
          color: '#ffce3a',
          sizeStart: 0.24,
          sizeEnd: 0.04,
          speed: 1.4,
          spread: 1.0,
          gravity: 0.3,
          lifetime: 0.55
        });
      }
    } else if (npc._hesitateTimer > 0 && !activeTarget) {
      npc._hesitateTimer -= dt;
    } else if (nearbyFreeItem && !activeTarget) {
      npc.tx = nearbyFreeItem.x;
      npc.tz = nearbyFreeItem.z;
      const dx = npc.tx - npc.x;
      const dz = npc.tz - npc.z;
      const d = Math.hypot(dx, dz) || 1;
      desiredMoveX = dx / d;
      desiredMoveZ = dz / d;
      moving = true;
    } else if (activeTarget) {
      const dx = activeTarget.x - npc.x;
      const dz = activeTarget.z - npc.z;
      const d = Math.hypot(dx, dz) || 0.001;
      const rawNpcWeapon = (cmbMod.useEquippedWeapon !== false && npc.equippedItem) ? npc.equippedItem : null;
      const heldWeapon = (rawNpcWeapon && !isItemFrozen(rawNpcWeapon)) ? rawNpcWeapon : null;
      const isRangedWeapon = heldWeapon && (heldWeapon.useType === 'ranged' || heldWeapon.useType === 'throwable');
      const attackDist = isRangedWeapon
        ? Math.min(Number(heldWeapon.maxRange) || 22, 16.0)
        : (heldWeapon && heldWeapon.useType === 'melee' ? (Number(heldWeapon.range) || 2.8) : (Number(cmbMod.attackRange) || 2.2));

      let shouldMoveInCombat = false;
      let canAttackInPlan = true;
      let goalY = activeTarget.y;

      if (smartBot) {
        // УМНЫЙ ИИ: оценка угрозы, построение (танки спереди / стрелки сзади), уход раненых на задний фланг и лечение
        const plan = computeSmartTacticalCombatPlan(npc, activeTarget, attackDist, isRangedWeapon, dt);
        npc.tx = plan.tx;
        goalY = plan.ty ?? activeTarget.y;
        npc.tz = plan.tz;
        shouldMoveInCombat = plan.shouldMove;
        canAttackInPlan = plan.canAttackNow;
        tacticalState = plan.tacticalState || 'engage';
      } else {
        // ГЛУПЫЙ ИИ: бежит напролом к цели, под высокой стеной стоит и ждёт, своих не прикрывает
        const lowHpFlee = cmbMod.fleeLowHp && npc.hpEnabled && (npc.hp / Math.max(1, npc.maxHp)) * 100 <= (Number(cmbMod.fleeHpPct) || 20);
        if (lowHpFlee) {
          npc.tx = npc.x - (dx / d) * 7.0;
          npc.tz = npc.z - (dz / d) * 7.0;
        } else {
          npc.tx = activeTarget.x;
          npc.tz = activeTarget.z;
        }
        shouldMoveInCombat = lowHpFlee || d > (isRangedWeapon ? attackDist * 0.72 : attackDist * 0.85);
        canAttackInPlan = !lowHpFlee;
        tacticalState = 'dumb_rush';
      }

      if (shouldMoveInCombat) {
        if (navMod.usePathfinding && physMod.enabled) {
          npc._aiTickTimer = (npc._aiTickTimer || 0) - dt;
          if (npc._aiTickTimer <= 0 || !npc._subgoal) {
            npc._aiTickTimer = 0.16 + (idx % 5) * 0.02;
            if (smartBot) {
              npc._subgoal = computeSmartNpcSubgoalAStar(
                npc,
                npc.tx,
                goalY,
                npc.tz,
                probeWorldColumnForNPC,
                perceivedJumpH,
                maxSafeDrop,
                navMod.canJump,
                navMod.jumpGaps
              );
            } else {
              const pNoise = errMod.enabled ? (Number(errMod.pathNoise) || 0.3) * (Number(errMod.mistakeLevel) || 0.25) : 0;
              npc._subgoal = computeNpcSubgoalAStar(npc, npc.tx, npc.tz, perceivedJumpH, maxSafeDrop, navMod.canJump, navMod.jumpGaps, pNoise);
            }
          }
          const sgx = npc._subgoal.x - npc.x;
          const sgz = npc._subgoal.z - npc.z;
          const sgd = Math.hypot(sgx, sgz) || 1;
          desiredMoveX = sgx / sgd;
          desiredMoveZ = sgz / sgd;
        } else {
          const gdx = npc.tx - npc.x;
          const gdz = npc.tz - npc.z;
          const gd = Math.hypot(gdx, gdz) || 1;
          desiredMoveX = gdx / gd;
          desiredMoveZ = gdz / gd;
        }
        moving = true;
      } else {
        npc.rot = Math.atan2(dx, dz);
      }

      // Выполнение атаки с учётом кулдауна, обоймы и перезарядки оружия
      if (
        canAttackInPlan &&
        d <= attackDist &&
        npc.attackCooldown <= 0 &&
        (npc.reloadTimer || 0) <= 0 &&
        Math.abs(activeTarget.y - npc.y) < (isRangedWeapon ? 14 : 3.2)
      ) {
        npc.rot = Math.atan2(dx, dz);

        if (isRangedWeapon) {
          const magSize = Math.max(1, Number(heldWeapon.magSize) || 12);
          if (npc._magAmmo === undefined) npc._magAmmo = magSize;

          // Если включён учёт магазина и патроны кончились — уходим на перезарядку
          if (cmbMod.respectAmmoReload !== false && heldWeapon.useType === 'ranged' && npc._magAmmo <= 0) {
            npc.reloadTimer = Math.max(0.6, Number(heldWeapon.reloadTime) || 1.4);
            npc.chat = '🔄 Перезарядка...';
            npc.chatT = npc.reloadTimer;
            refreshEntityTagWithHP(npc);
            sfx.coil?.();
          } else {
            if (heldWeapon.useType === 'ranged') npc._magAmmo--;
            const weaponCd = Number(heldWeapon.cooldown) || 0.45;
            const minNpcFireInterval = heldWeapon.autoFire ? Math.max(0.22, weaponCd) : Math.max(0.55, weaponCd);
            npc.attackCooldown = minNpcFireInterval;

            triggerEntityAttack(npc, heldWeapon.useType === 'throwable' ? 'punch' : 'shoot');
            if (heldWeapon.useType === 'throwable') sfx.slap();
            else sfx.zap();
            spawnProjectile(npc, heldWeapon, 0.92);

            // Если это был последний патрон в магазине — сразу запускаем перезарядку
            if (cmbMod.respectAmmoReload !== false && heldWeapon.useType === 'ranged' && npc._magAmmo <= 0) {
              npc.reloadTimer = Math.max(0.6, Number(heldWeapon.reloadTime) || 1.4);
              npc.chat = '🔄 Перезарядка...';
              npc.chatT = npc.reloadTimer;
              refreshEntityTagWithHP(npc);
            }
          }
        } else {
          const baseCd = heldWeapon ? (Number(heldWeapon.cooldown) || 0.7) : (Number(cmbMod.attackCooldown) || 1.0);
          npc.attackCooldown = Math.max(0.3, baseCd);
          triggerEntityAttack(npc, 'punch');
          if (heldWeapon && heldWeapon.useType === 'melee') sfx.swing();
          else sfx.slap();
          if (Object.keys(S.remotePlayers || {}).length > 0) {
            broadcastMultiplayerPacket({
              type: 'npc_action_fx',
              npcId: npc.id,
              rot: npc.rot,
              style: 'punch'
            });
          }
          const dmg = (heldWeapon && heldWeapon.useType === 'melee')
            ? Number(heldWeapon.damage) || npc.meleeDamage || 15
            : (npc.meleeDamage || 15);
          const kb = (heldWeapon && heldWeapon.useType === 'melee') ? (Number(heldWeapon.knockback) || 8) : 8;
          dealDamage(activeTarget, dmg, npc, kb);
          transferEffectsOnContact(npc, activeTarget, 0, true, 1.0);
          if (heldWeapon) transferEffectsOnContact(heldWeapon, activeTarget, 0, true, 1.15);
        }
      }
    } else if (navMod.enabled && navMod.mode !== 'stand') {
      // 2. МИРНАЯ НАВИГАЦИЯ (Wander с подъёмом на возвышенности и спуском вниз / Waypoints / Follow)
      if (navMod.mode === 'follow' && player && !S.playerDead) {
        const dP = Math.hypot(player.x - npc.x, player.z - npc.z);
        const fDist = Math.max(1.5, Number(navMod.followDist) || 3.2);
        if (dP > fDist) {
          npc.tx = player.x;
          npc.tz = player.z;
        } else {
          npc.tx = npc.x;
          npc.tz = npc.z;
          npc.rot = Math.atan2(player.x - npc.x, player.z - npc.z);
        }
      } else if (navMod.mode === 'waypoints' && Array.isArray(navMod.waypoints) && navMod.waypoints.length > 0) {
        if (npc._wpIdx === undefined || npc._wpIdx >= navMod.waypoints.length) npc._wpIdx = 0;
        const wp = navMod.waypoints[npc._wpIdx];
        npc.tx = Number(wp.x) || 0;
        npc.tz = Number(wp.z) || 0;
        if (Math.hypot(npc.tx - npc.x, npc.tz - npc.z) < 0.85) {
          if (navMod.patrolLoop === 'ping_pong') {
            if (!npc._wpDir) npc._wpDir = 1;
            npc._wpIdx += npc._wpDir;
            if (npc._wpIdx >= navMod.waypoints.length) {
              npc._wpDir = -1;
              npc._wpIdx = Math.max(0, navMod.waypoints.length - 2);
            } else if (npc._wpIdx < 0) {
              npc._wpDir = 1;
              npc._wpIdx = Math.min(1, navMod.waypoints.length - 1);
            }
          } else {
            npc._wpIdx = (npc._wpIdx + 1) % navMod.waypoints.length;
          }
        }
      } else {
        // Режим 'wander' — выбираем точки, включая соседние возвышенности и безопасные ярусы ниже!
        npc.wTimer -= dt;
        if (npc.wTimer <= 0) {
          npc.wTimer = rnd(2.4, 5.2);
          const rad = Math.max(2.0, Number(navMod.wanderRadius) || 10.0);
          let chosenX = npc.x;
          let chosenZ = npc.z;

          for (let attempt = 0; attempt < 5; attempt++) {
            const anchorX = attempt < 3 ? (npc.homeX ?? npc.x) : npc.x;
            const anchorZ = attempt < 3 ? (npc.homeZ ?? npc.z) : npc.z;
            const candX = anchorX + rnd(-rad, rad);
            const candZ = anchorZ + rnd(-rad, rad);

            if (!physMod.enabled) {
              chosenX = candX;
              chosenZ = candZ;
              break;
            }

            const prCand = probeWorldColumnForNPC(candX, npc.y, candZ, 0.36, 2.4, perceivedJumpH, maxSafeDrop);
            // Разрешаем любые точки на том же уровне, на возвышенностях (до perceivedJumpH) и на нижних ярусах (до maxSafeDrop)!
            if (!prCand.isPit && !prCand.wallBlocked && !prCand.hasHazard) {
              chosenX = candX;
              chosenZ = candZ;
              break;
            }
          }
          npc.tx = chosenX;
          npc.tz = chosenZ;
          npc._subgoal = null;
        }
      }

      const dx = npc.tx - npc.x;
      const dz = npc.tz - npc.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.28) {
        if (navMod.usePathfinding && physMod.enabled && (npc._edgeAvoidTimer || 0) <= 0) {
          npc._aiTickTimer = (npc._aiTickTimer || 0) - dt;
          if (npc._aiTickTimer <= 0 || !npc._subgoal) {
            npc._aiTickTimer = 0.18 + (idx % 5) * 0.025;
            const pNoise = errMod.enabled ? (Number(errMod.pathNoise) || 0.3) * (Number(errMod.mistakeLevel) || 0.25) : 0;
            npc._subgoal = computeNpcSubgoalAStar(npc, npc.tx, npc.tz, perceivedJumpH, maxSafeDrop, navMod.canJump, navMod.jumpGaps, pNoise);
          }
          const sgx = npc._subgoal.x - npc.x;
          const sgz = npc._subgoal.z - npc.z;
          const sgd = Math.hypot(sgx, sgz) || 1;
          desiredMoveX = sgx / sgd;
          desiredMoveZ = sgz / sgd;
        } else {
          desiredMoveX = dx / d;
          desiredMoveZ = dz / d;
        }
        moving = true;
      }
    }

    // Взаимодействие с предметами и дверями/рычагами
    handleNpcWorldInteractions(npc, physMod, desiredMoveX, desiredMoveZ);

    // Расчёт спринта и стамины для NPC (глупые сжигают всю стамину сразу, умные расходуют тактически)
    const npcWantsSprint = decideNpcSprintIntent(npc, activeTarget, moving, tacticalState);
    const npcSprintMult = updateEntityStaminaAndSprint(npc, dt, npcWantsSprint, moving);
    if (npc.isSprinting && npcSoaked && S.worldSettings.staminaDrainOnSprint !== false) {
      const extraStamMult = Math.max(0, getWetStaminaDrainMultiplier(npc) - 1);
      const baseDrain = Number(S.worldSettings.staminaDrainRate) || 18;
      npc.stamina = Math.max(0, (npc.stamina ?? 100) - baseDrain * extraStamMult * dt);
    }
    const effectiveWalkSpd = walkSpd * npcSprintMult; 

    // 3. ПЕРЕМЕЩЕНИЕ, ПАРКУР-ПРЫЖКИ И ФИЗИЧЕСКОЕ ВЗАИМОДЕЙСТВИЕ С МИРОМ
    if (!physMod.enabled) {
      if (moving) {
        const step = effectiveWalkSpd * dt;
        npc.x += desiredMoveX * step;
        npc.z += desiredMoveZ * step;
        npc.rot = Math.atan2(desiredMoveX, desiredMoveZ);
        npc.step += step * 2.8;
      }
      npc.grounded = true;
      npc.inLiquid = false;
    } else {
      const nr = npc.colliderRadius || 0.42;
      const nh = npc.colliderHeight || 2.5;

      // Проверка жидкости (вода / лава / кислота) и срабатывание touch-триггеров
      let inLiquid = false;
      for (let i = 0; i < _npcNearbyBlocks.length; i++) {
        const b = _npcNearbyBlocks[i];
        if (b.matterState === 'liquid' && testPlayerOBB(npc.x, npc.y, npc.z, nr, nh, b)) {
          inLiquid = true;
          interactTargetWithLiquid(npc, b, dt);
          if (physMod.hazardDamage) {
            if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'touch') || (b.logicData && b.logicData.trigger === 'touch')) {
              triggerBlockLogic(b, 'touch', npc);
              if (b.components?.script?.enabled && b.scriptData?.enabled) {
                runBlockScriptHook(b, 'onCollide', { entity: npc });
              }
            }
            if (npc._hazardDamageCd <= 0) {
              if (b.damageOnContact > 0) {
                npc._hazardDamageCd = 0.55;
                dealDamage(npc, b.damageOnContact, null, 4);
              } else if (b.teleportToCheckpoint) {
                npc._hazardDamageCd = 0.8;
                dealDamage(npc, (npc.maxHp || 100) * 2, null, 4);
              }
            }
          }
          break;
        }
      }
      npc.inLiquid = inLiquid;

      // Оценка уступов, ступенек, спусков и обрывов по курсу движения (ближний и дальний луч)
      if (moving && npc.grounded && !inLiquid) {
        const lookDist = Math.max(0.95, Math.min(1.55, walkSpd * 0.22));
        const nearX = npc.x + desiredMoveX * 0.68;
        const nearZ = npc.z + desiredMoveZ * 0.68;
        const aheadX = npc.x + desiredMoveX * lookDist;
        const aheadZ = npc.z + desiredMoveZ * lookDist;

        const prNear = probeWorldColumnForNPC(nearX, npc.y, nearZ, nr * 0.8, nh, perceivedJumpH, maxSafeDrop);
        const prAhead = probeWorldColumnForNPC(aheadX, npc.y, aheadZ, nr * 0.85, nh, perceivedJumpH, maxSafeDrop);

        let shouldJumpNow = false;
        let requiredClimbH = 0;
        let cannotProceedPit = false;

        // 0) Если умный бот подошёл вплотную к целевой ступеньке из маршрута подъёма — сразу прыгаем на неё!
        if (smartBot && npc._targetStepBlock && navMod.canJump) {
          const sb = npc._targetStepBlock;
          const dxSb = Math.max(0, sb.x0 - npc.x, npc.x - sb.x1);
          const dzSb = Math.max(0, sb.z0 - npc.z, npc.z - sb.z1);
          const distToStepEdge = Math.hypot(dxSb, dzSb);
          const stepClimbH = sb.y1 - npc.y;
          if (distToStepEdge <= 1.15 && stepClimbH > 0.35 && stepClimbH <= perceivedJumpH + 0.25) {
            shouldJumpNow = true;
            requiredClimbH = stepClimbH;
          }
        }

        // А) Впереди (в ближнем или среднем луче) ступенька / уступ, на который можно запрыгнуть!
        if (!shouldJumpNow && (prNear.needsJumpUp || prAhead.needsJumpUp) && navMod.canJump) {
          shouldJumpNow = true;
          requiredClimbH = Math.max(prNear.climbH || 0, prAhead.climbH || 0);
        }
        // Б) Впереди стена выше обычной ступеньки, но в пределах воспринимаемой высоты прыжка
        else if (!shouldJumpNow && (prNear.wallBlocked || prAhead.wallBlocked) && navMod.canJump) {
          const obsTop = prNear.wallBlocked ? prNear.obstacleTopY : prAhead.obstacleTopY;
          const wallH = obsTop - npc.y;
          if (wallH > 0.58 && wallH <= perceivedJumpH) {
            shouldJumpNow = true;
            requiredClimbH = wallH;
          }
        }
        // В) Впереди настоящая глубокая пропасть (глубже maxSafeDrop) или лава
        else if (prAhead.isPit || prAhead.hasHazard) {
          if (navMod.canJump && navMod.jumpGaps) {
            let foundLanding = false;
            for (let testD = 2.0; testD <= perceivedJumpDist + 0.4; testD += 1.0) {
              const lx = npc.x + desiredMoveX * testD;
              const lz = npc.z + desiredMoveZ * testD;
              const prLand = probeWorldColumnForNPC(lx, npc.y, lz, nr * 0.85, nh, perceivedJumpH, maxSafeDrop);
              if (!prLand.isPit && !prLand.wallBlocked && !prLand.hasHazard) {
                foundLanding = true;
                break;
              }
            }
            if (foundLanding) {
              if (npc._lateJumpMistake && (npc._lateJumpDelay === undefined || npc._lateJumpDelay < 0.14)) {
                npc._lateJumpDelay = (npc._lateJumpDelay || 0) + dt;
              } else {
                shouldJumpNow = true;
                npc._lateJumpDelay = 0;
              }
            } else {
              cannotProceedPit = true;
            }
          } else {
            cannotProceedPit = true;
          }
        }

        if (shouldJumpNow) {
          const neededVy = requiredClimbH > 0.5
            ? Math.sqrt(2 * effGrav * Math.max(0.8, requiredClimbH - 0.15))
            : jumpPwr;
          npc.vy = Math.max(jumpPwr, Math.min(jumpPwr * 1.22, neededVy));
          npc.grounded = false;
          // Придаём горизонтальный импульс точно на ступеньку, чтобы бот уверенно залетал наверх
          npc.vxKnock = desiredMoveX * Math.min(4.2, walkSpd * 0.55);
          npc.vzKnock = desiredMoveZ * Math.min(4.2, walkSpd * 0.55);
          sfx.jump?.();
        } else if (cannotProceedPit) {
          // ИСПРАВЛЕНИЕ ЗАВИСАНИЯ И ВРАЩЕНИЯ У ОБРЫВОВ:
          // Вместо покадрового вращения на месте выбираем новую безопасную точку в сторону от обрыва!
          if (activeTarget) {
            moving = false;
            npc.rot = Math.atan2(activeTarget.x - npc.x, activeTarget.z - npc.z);
          } else {
            const awayX = -desiredMoveX;
            const awayZ = -desiredMoveZ;
            const sideAngle = (Math.random() < 0.5 ? 1 : -1) * rnd(0.35, 1.05);
            const cosA = Math.cos(sideAngle);
            const sinA = Math.sin(sideAngle);
            const newDirX = awayX * cosA - awayZ * sinA;
            const newDirZ = awayX * sinA + awayZ * cosA;
            const retreatDist = rnd(4.0, 7.5);

            npc.tx = npc.x + newDirX * retreatDist;
            npc.tz = npc.z + newDirZ * retreatDist;
            npc._subgoal = { x: npc.tx, z: npc.tz };
            npc._edgeAvoidTimer = 0.85;
            npc.wTimer = rnd(2.2, 4.0);
            desiredMoveX = newDirX;
            desiredMoveZ = newDirZ;
          }
        }
      }

      if (moving) {
        const effSpd = effectiveWalkSpd * (inLiquid ? 0.65 : 1.0);
        npc.x += desiredMoveX * effSpd * dt;
        npc.z += desiredMoveZ * effSpd * dt;
        npc.rot = Math.atan2(desiredMoveX, desiredMoveZ);
        npc.step += effSpd * dt * 2.5;
        if (npc.grounded && !inLiquid && (!player || Math.hypot(npc.x - player.x, npc.z - player.z) < 32)) {
          const nScale = Math.abs(npc.rig?.g?.scale?.y || 1);
          const nStride = clamp(0.72 * nScale, 0.35, 2.0);
          npc._snowStepDist = (npc._snowStepDist || 0) + effSpd * dt;
          if (npc._snowStepDist >= nStride) {
            npc._snowStepDist -= nStride;
            npc._snowFootSide = -(npc._snowFootSide || 1);
            stampSnowFootprint(npc.x, npc.y, npc.z, npc.rot || 0, npc._snowFootSide, null, npc);
          }
        }
      } 

      // Вертикальная физика (Гравитация и плавание)
      const prevVy = npc.vy || 0;
      if (inLiquid) {
        if (physMod.canSwim !== false) {
          npc.vy = clamp((npc.vy || 0) + 12 * dt, -3.5, 4.8);
        } else {
          npc.vy = clamp((npc.vy || 0) - effGrav * 0.3 * dt, -6.0, 4.0);
        }
      } else {
        npc.vy = Math.max(-32, (npc.vy || 0) - effGrav * dt);
      }

      if (!npc.grounded && npc.vy < -12.0 && !npc._saidOops) {
        npc._saidOops = true;
        if (dlgMod.enabled && dlgMod.oopsChat) {
          npc.chat = dlgMod.oopsChat;
          npc.chatT = 3.0;
          refreshEntityTagWithHP(npc);
        }
      }

      npc.y += npc.vy * dt;
      npc.grounded = false;

      // Разрешение OBB-коллизий с блоками мира и срабатывание всех touch-триггеров
      for (let i = 0; i < _npcNearbyBlocks.length; i++) {
        const b = _npcNearbyBlocks[i];
        if (b.matterState === 'liquid') continue;

        const hit = testPlayerOBB(npc.x, npc.y - 0.04, npc.z, nr, nh + 0.04, b);
        if (!hit) continue;

        transferEffectsOnContact(b, npc, dt, true, 1.0);

        if ((b.components?.interaction?.enabled && b.interactionData?.trigger === 'touch') || (b.logicData && b.logicData.trigger === 'touch')) {
          triggerBlockLogic(b, 'touch', npc);
          if (b.components?.script?.enabled && b.scriptData?.enabled) {
            runBlockScriptHook(b, 'onCollide', { entity: npc });
          }
          if (npc._deadCooldown > 0) break;
          if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
        }

        if (physMod.hazardDamage) {
          if (b.damageOnContact > 0 && npc._hazardDamageCd <= 0) {
            npc._hazardDamageCd = 0.55;
            dealDamage(npc, b.damageOnContact, null, 5);
            if (npc._deadCooldown > 0) break;
          }
          if (b.teleportToCheckpoint && npc._hazardDamageCd <= 0) {
            npc._hazardDamageCd = 0.8;
            dealDamage(npc, (npc.maxHp || 100) * 2, null, 6);
            if (npc._deadCooldown > 0) break;
          }
        }

        if (b.matterState === 'gas') {
          if (b.bounciness > 0) npc.vy = b.bounciness;
          continue;
        }

        if (b.matterState === 'solid') {
          if (hit.ny > 0.45) {
            if (npc.vy <= 0.5) {
              const impactSpeed = Math.abs(prevVy);
              const pushUp = Math.max(0, (hit.pen - 0.03) / Math.max(0.45, hit.ny));
              npc.y += pushUp;
              npc.vy = 0;
              npc.grounded = true;
              npc._saidOops = false;

              if (physMod.fallDamage && impactSpeed > fallThresh) {
                const fallDmg = Math.round((impactSpeed - (fallThresh - 1.5)) * 5.0);
                if (fallDmg > 0) {
                  dealDamage(npc, fallDmg, null, 2);
                  if (!(npc._deadCooldown > 0) && !npc._permanentlyDead) {
                    triggerEntityRagdoll(npc, Math.sin(npc.rot || 0) * 3.5, 2.0, Math.cos(npc.rot || 0) * 3.5, 1.6);
                  }
                  if (npc._deadCooldown > 0) break;
                }
              }

              if (b.conveyorVz) {
                npc.x += b.axisZ.x * b.conveyorVz * dt;
                npc.z += b.axisZ.z * b.conveyorVz * dt;
              }
              if (b.conveyorVx) {
                npc.x += b.axisX.x * b.conveyorVx * dt;
                npc.z += b.axisX.z * b.conveyorVx * dt;
              }

              if (b.bounciness > 0) {
                npc.vy = b.bounciness * hit.ny;
                npc.vxKnock = (npc.vxKnock || 0) + b.bounciness * hit.nx * 0.8;
                npc.vzKnock = (npc.vzKnock || 0) + b.bounciness * hit.nz * 0.8;
                npc.grounded = false;
              }
            }
          } else if (hit.ny < -0.45) {
            npc.x += hit.nx * hit.pen;
            npc.y += hit.ny * hit.pen;
            npc.z += hit.nz * hit.pen;
            if (npc.vy > 0) npc.vy = 0;
          } else {
            const stepHeight = b.y1 - npc.y;
            if (
              b.spinSpeed === 0 &&
              hit.topFactor > 0.75 &&
              stepHeight > 0.02 &&
              stepHeight <= 0.62 &&
              npc.vy <= 0.5
            ) {
              npc.y = b.y1;
              npc.vy = 0;
              npc.grounded = true;
            } else {
              const hLen = Math.hypot(hit.nx, hit.nz) || 1;
              const nx = hit.nx / hLen;
              const nz = hit.nz / hLen;
              npc.x += nx * hit.pen;
              npc.z += nz * hit.pen;

              if (b.spinSpeed !== 0) {
                npc.vxKnock = nx * 9;
                npc.vzKnock = nz * 9;
              } else if (moving && npc.grounded && navMod.canJump) {
                if (stepHeight > 0.62 && stepHeight <= perceivedJumpH) {
                  npc.vy = jumpPwr;
                  npc.grounded = false;
                  npc.vxKnock = desiredMoveX * Math.min(3.0, walkSpd * 0.4);
                  npc.vzKnock = desiredMoveZ * Math.min(3.0, walkSpd * 0.4);
                }
              }
            }
          }
        }
      }

      if (npc.y < -18 && !(npc._deadCooldown > 0)) {
        if (npc.hpEnabled) {
          dealDamage(npc, (npc.maxHp || 100) * 10, null, 0);
        } else {
          npc.x = npc.homeX ?? 0;
          npc.y = (npc.homeY ?? 2) + 1;
          npc.z = npc.homeZ ?? 0;
          npc.vy = 0;
        }
      }
    }

    // Пассивный авто-реген HP для NPC: если бот стоит на месте, вне боя >= 4 сек и ни за кем не гонится
    if (npc.hpEnabled && npc.hp > 0 && npc.hp < npc.maxHp && !moving && !activeTarget) {
      const timeSinceHit = (S.time || 0) - (npc._lastCombatTime || -99);
      if (timeSinceHit >= 4.0) {
        const prevHp = Math.ceil(npc.hp);
        npc.hp = Math.min(npc.maxHp, npc.hp + npc.maxHp * 0.08 * dt);
        npc.hpBarTimer = 1.5;
        if (Math.ceil(npc.hp) !== prevHp) {
          refreshEntityTagWithHP(npc);
        }
      }
    }

    if ((npc.chatQueue && npc.chatQueue.length > 0) || npc.chatT > 0) {
      refreshEntityTagWithHP(npc);
    }

    npc._netMoving = moving && !npcFrozen;
    if (!npcFrozen) {
      updateEntityAnimation(npc, dt, {
        moving,
        grounded: npc.grounded !== false,
        inLiquid: !!npc.inLiquid
      });
    }

    const hoverYOffset = applyEntityGaitStyle(npc, dt, moving);

    if (npc.rig && npc.rig.g) {
      npc.rig.g.position.set(npc.x, npc.y + hoverYOffset, npc.z);
      npc.rig.g.rotation.set(0, npc.rot, 0);
    }
    if (npc.tag) {
      npc.tag.position.set(npc.x, npc.y + hoverYOffset + 3.35, npc.z);
    }
  }
}
