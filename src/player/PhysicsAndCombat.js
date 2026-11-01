// src/player/PhysicsAndCombat.js
import { S, $, clamp, rnd, pick, showBanner } from '../core/State.js';
import { cv, scene, camera } from '../core/SceneManager.js';
import { sfx } from '../core/AudioEngine.js';
import {
  triggerEntityAttack,
  updateEntityAnimation,
  buildItemGroup
} from '../core/CharacterRig.js';
import {
  addSceneBlock,
  updateBlockOBB,
  rebuildPhysicsArrays,
  syncBlockSpecialVisuals,
  getLogicBadgeStrings
} from '../core/WorldRegistry.js';
import {
  spawnDamageParticles,
  spawnDeathShatter
} from '../core/ParticleSystem.js';
import {
  spawnCustomNPC,
  refreshEntityTagWithHP,
  updateShopUI,
  getActiveHeldItem,
  syncEntityHeldItemMesh,
  dropHeldOrCarriedItem,
  renderHotbarUI
} from '../core/EntityManager.js';

const _vLocal = new THREE.Vector3();
const _vNormal = new THREE.Vector3();
const _vMuzzleWorld = new THREE.Vector3();
const _vAimDir = new THREE.Vector3();

// Динамический источник света для удерживаемого факела и 3D-линия траектории прицеливания
let heldTorchLight = null;
let trajectoryLine = null;
const TRAJ_SEGMENTS = 24;

function ensureHeldTorchLight() {
  if (heldTorchLight) return heldTorchLight;
  heldTorchLight = new THREE.PointLight(0xff9f43, 0, 16, 1.5);
  heldTorchLight.position.set(0, -9999, 0);
  scene.add(heldTorchLight);
  return heldTorchLight;
}

function ensureTrajectoryLine() {
  if (trajectoryLine) return trajectoryLine;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array((TRAJ_SEGMENTS + 1) * 3);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x00ff88,
    transparent: true,
    opacity: 0.85
  });
  trajectoryLine = new THREE.Line(geo, mat);
  trajectoryLine.frustumCulled = false;
  trajectoryLine.visible = false;
  scene.add(trajectoryLine);
  return trajectoryLine;
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
  player.hpBarTimer = 0;
  player.vxKnock = 0;
  player.vzKnock = 0;
  player.vy = 0;
  player.inLiquid = false;
  player.attackAnimT = 0;
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

/* ---------- СИСТЕМА ТРИГГЕРОВ И СОБЫТИЙ (BRICKS LOGIC) ---------- */

function findTargetBlocksByTag(sourceBox, targetTag) {
  const cleanTag = (targetTag || '').trim();
  if (!cleanTag) return [sourceBox];
  const matches = S.allBlocks.filter(
    b => b.logicData && (b.logicData.tag || '').trim().toLowerCase() === cleanTag.toLowerCase()
  );
  return matches.length > 0 ? matches : [sourceBox];
}

export function triggerBlockLogic(box, triggerSource = 'keyE') {
  const player = S.player;
  if (!player || !box || !box.logicData) return false;
  const lg = box.logicData;
  if (lg.trigger !== triggerSource) return false;

  if (!box.logicRuntime) {
    box.logicRuntime = {
      basePos: box.m.position.clone(),
      openT: 0,
      targetOpen: false,
      stayTimer: 0,
      cdTimer: 0,
      ghostOpen: false
    };
  }
  const rt = box.logicRuntime;
  if (rt.cdTimer > 0) return false;

  const cost = Math.max(0, Number(lg.cost) || 0);
  const needsPayment = cost > 0 && !(lg.oneTimeBuy && lg.unlocked);

  if (needsPayment) {
    if (player.cash < cost) {
      if (triggerSource !== 'touch' || rt.cdTimer <= 0) {
        rt.cdTimer = 1.1;
        sfx.oof();
        showBanner(`❌ Не хватает R$! Нужно ${cost} R$ (у тебя ${player.cash} R$)`, '#ff3e3e');
      }
      return false;
    }
    player.cash -= cost;
    if (lg.oneTimeBuy) {
      lg.unlocked = true;
      syncBlockSpecialVisuals(box);
    }
    sfx.cash();
    updateShopUI();
  }

  rt.cdTimer = Math.max(0.25, Number(lg.cooldown) || 0.8);
  const targets = findTargetBlocksByTag(box, lg.targetTag);

  if (lg.action === 'door_slide') {
    for (const tb of targets) {
      if (!tb.logicRuntime) {
        tb.logicRuntime = {
          basePos: tb.m.position.clone(),
          openT: 0,
          targetOpen: false,
          stayTimer: 0,
          cdTimer: 0,
          ghostOpen: false
        };
      }
      const trt = tb.logicRuntime;
      if (!trt.basePos) trt.basePos = tb.m.position.clone();
      trt.activeMoveX = Number(tb.logicData?.moveX) || Number(lg.moveX) || 0;
      trt.activeMoveY = (tb !== box && tb.logicData?.moveY !== undefined && tb.logicData?.trigger === 'none')
        ? Number(tb.logicData.moveY)
        : (Number(lg.moveY) ?? 5);
      trt.activeMoveZ = Number(tb.logicData?.moveZ) || Number(lg.moveZ) || 0;
      trt.activeSpeed = Math.max(0.5, Number(lg.speed) || 4.5);

      const stay = Number(lg.stayTime) ?? 4.0;
      if (stay <= 0) {
        trt.targetOpen = !trt.targetOpen;
        trt.stayTimer = 0;
      } else {
        trt.targetOpen = true;
        trt.stayTimer = stay;
      }
    }
    sfx.gate();
    if (needsPayment) {
      showBanner(`🔓 Оплачено ${cost} R$! Дверь открыта!`, '#00e676');
    } else if (triggerSource === 'keyE') {
      showBanner(`🚪 Механизм «${box.label}» активирован!`, '#56f0ff');
    }
    return true;
  }

  if (lg.action === 'door_ghost') {
    const stay = Number(lg.stayTime) ?? 4.0;
    for (const tb of targets) {
      if (!tb.logicRuntime) tb.logicRuntime = { basePos: tb.m.position.clone(), openT: 0, targetOpen: false, stayTimer: 0, cdTimer: 0, ghostOpen: false };
      const trt = tb.logicRuntime;
      const nextGhost = stay <= 0 ? !trt.ghostOpen : true;
      trt.ghostOpen = nextGhost;
      trt.stayTimer = stay > 0 ? stay : 0;
      if (tb.m.material) {
        tb.m.material.transparent = true;
        tb.m.material.opacity = nextGhost ? 0.25 : (tb.matterState === 'solid' ? 1.0 : 0.72);
      }
    }
    sfx.coil();
    showBanner(`👻 Проход «${box.label}» открыт!`, '#56f0ff');
    return true;
  }

  if (lg.action === 'teleport') {
    let destX = Number(lg.tpX) || 0;
    let destY = Number(lg.tpY) || 6;
    let destZ = Number(lg.tpZ) || 0;
    let destLabel = `${destX.toFixed(0)}, ${destY.toFixed(0)}, ${destZ.toFixed(0)}`;

    const cleanTag = (lg.targetTag || '').trim();
    if (cleanTag) {
      const targetBlk = S.allBlocks.find(
        b => b !== box && b.logicData && (b.logicData.tag || '').trim().toLowerCase() === cleanTag.toLowerCase()
      );
      if (targetBlk) {
        destX = targetBlk.m.position.x;
        destY = targetBlk.y1 + 0.8;
        destZ = targetBlk.m.position.z;
        destLabel = targetBlk.label;
        if (targetBlk.logicRuntime) targetBlk.logicRuntime.cdTimer = 1.5;
      }
    }

    player.x = destX;
    player.y = destY;
    player.z = destZ;
    player.vy = 0;
    player.vxKnock = 0;
    player.vzKnock = 0;
    player.rig.g.position.set(player.x, player.y, player.z);
    player.tag.position.set(player.x, player.y + 3.35, player.z);
    sfx.checkpoint();
    showBanner(`🌀 Телепортация: ${destLabel}!`, '#56f0ff');
    return true;
  }

  if (lg.action === 'buy_perk') {
    const perk = lg.perkType || 'speed';
    if (perk === 'speed') {
      player.hasSpeed = true;
      player.preset.coil = true;
      if (player.rig && player.rig.coil) player.rig.coil.visible = true;
      showBanner('🌀 Получена Пружина Скорости (+55% к бегу)!', '#56f0ff');
    } else if (perk === 'grav') {
      player.hasGrav = true;
      player.preset.coil = true;
      if (player.rig && player.rig.coil) player.rig.coil.visible = true;
      showBanner('🚀 Получена Пружина Прыжка (Gravity Coil)!', '#a29bfe');
    } else if (perk === 'halo') {
      player.hasHalo = true;
      player.preset.halo = true;
      if (player.rig && player.rig.halo) player.rig.halo.visible = true;
      showBanner('😇 Получен VIP Нимб (x2 R$ и защита)!', '#ffce3a');
    } else if (perk === 'heal') {
      player.maxHp += 25;
      player.hp = player.maxHp;
      player.hpBarTimer = 3.5;
      refreshEntityTagWithHP(player);
      showBanner(`❤️ Здоровье восстановлено и увеличено до ${player.maxHp} HP!`, '#00e676');
    } else if (perk === 'damage') {
      player.meleeDamage = (player.meleeDamage || 25) + 15;
      showBanner(`🥊 Сила удара увеличена до ${player.meleeDamage} ед.!`, '#ff6b6b');
    }
    sfx.coil();
    updateShopUI();

    if ((lg.targetTag || '').trim()) {
      for (const tb of targets) {
        if (tb !== box && tb.logicRuntime) {
          tb.logicRuntime.targetOpen = true;
          tb.logicRuntime.stayTimer = Number(lg.stayTime) || 0;
        }
      }
    }
    return true;
  }

  if (lg.action === 'give_cash') {
    const baseReward = Number(lg.rewardCash) || 25;
    const earned = baseReward * (player.hasHalo ? 2 : 1);
    player.cash += earned;
    sfx.cash();
    updateShopUI();
    showBanner(`🪙 +${earned} R$ (${box.label})!`, '#ffce3a');
    return true;
  }

  if (lg.action === 'bounce_pad') {
    const pwr = Math.max(12, Number(lg.speed) * 4 || 20);
    player.vy = pwr;
    player.grounded = false;
    sfx.coil();
    showBanner(`🚀 Катапульта подбросила тебя!`, '#00e676');
    return true;
  }

  return false;
}

export function findNearestWorldItem(player, maxDist = 4.2) {
  if (!player) return null;
  let best = null;
  let bestDist = maxDist;
  for (const wi of S.worldItems) {
    if (wi.pickupCooldown > 0) continue;
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
    const hasLogicE = b.logicData && b.logicData.trigger === 'keyE';
    const hasSpawnerE = b.spawnerData && b.spawnerData.mode === 'keyE';
    if (!hasLogicE && !hasSpawnerE) continue;

    const dx = Math.max(b.x0 - player.x, 0, player.x - b.x1);
    const dy = Math.max(b.y0 - (player.y + 1.2), 0, (player.y + 1.2) - b.y1);
    const dz = Math.max(b.z0 - player.z, 0, player.z - b.z1);
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
    if (!b.logicRuntime) {
      b.logicRuntime = {
        basePos: b.m.position.clone(),
        openT: 0,
        targetOpen: false,
        stayTimer: 0,
        cdTimer: 0,
        ghostOpen: false
      };
    }
    const rt = b.logicRuntime;
    if (!rt.basePos) rt.basePos = b.m.position.clone();

    if (rt.cdTimer > 0) rt.cdTimer = Math.max(0, rt.cdTimer - dt);

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

    if (rt.targetOpen && rt.stayTimer > 0 && rt.openT >= 0.99) {
      rt.stayTimer -= dt;
      if (rt.stayTimer <= 0) {
        rt.targetOpen = false;
        sfx.gate();
      }
    }

    const desiredT = rt.targetOpen ? 1 : 0;
    if (Math.abs(rt.openT - desiredT) > 0.0001) {
      const spd = Math.max(0.5, Number(rt.activeSpeed || b.logicData?.speed) || 4.5);
      const mx = rt.activeMoveX !== undefined ? rt.activeMoveX : (Number(b.logicData?.moveX) || 0);
      const my = rt.activeMoveY !== undefined ? rt.activeMoveY : (Number(b.logicData?.moveY) ?? 5);
      const mz = rt.activeMoveZ !== undefined ? rt.activeMoveZ : (Number(b.logicData?.moveZ) || 0);
      const totalDist = Math.max(0.5, Math.hypot(mx, my, mz));
      const stepT = (spd / totalDist) * dt;

      const prevX = b.m.position.x;
      const prevY = b.m.position.y;
      const prevZ = b.m.position.z;

      if (rt.openT < desiredT) rt.openT = Math.min(1, rt.openT + stepT);
      else rt.openT = Math.max(0, rt.openT - stepT);

      b.m.position.set(
        rt.basePos.x + mx * rt.openT,
        rt.basePos.y + my * rt.openT,
        rt.basePos.z + mz * rt.openT
      );
      updateBlockOBB(b);

      if (b.cpVisualGroup) {
        b.cpVisualGroup.position.copy(b.m.position);
      }

      if (player && !S.playerDead) {
        const dx = b.m.position.x - prevX;
        const dy = b.m.position.y - prevY;
        const dz = b.m.position.z - prevZ;
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

/* ---------- УРОН, БРОНЯ, РОaaНЯНИЕ КОНТЕЙНЕРОВ И БОЕВАЯ СИСТЕМА ПРЕДМЕТОВ ---------- */

export function dealDamage(target, amount, attacker = null, customKnockback = 8) {
  if (!target || !target.hpEnabled || amount <= 0) return false;
  if (target.isP && S.playerDead) return false;
  if (target._deadCooldown > 0) return false;

  // Учёт экипированного предмета (Броня / Неуязвимость / Роняние 2-ручного предмета при ударе)
  if (target.isP) {
    if (target.carriedItem && target.carriedItem.dropOnHit !== false) {
      dropHeldOrCarriedItem(target, 3.8, `💥 Ты получил урон и выронил «${target.carriedItem.name}»!`);
    }
    const held = getActiveHeldItem(target);
    if (held) {
      if (held.equipStats && held.equipStats.invulnerable) {
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
  sfx.hit();
  spawnDamageParticles(target);

  if (attacker) {
    const dx = target.x - attacker.x;
    const dz = target.z - attacker.z;
    const d = Math.hypot(dx, dz) || 1;
    target.vxKnock = (dx / d) * customKnockback;
    target.vzKnock = (dz / d) * customKnockback;
    if (!target.isP && !target.isArchangel) {
      target.chat = 'АЙ! За что?! 😡';
      target.chatT = 3.5;
    }
  }

  refreshEntityTagWithHP(target);
  if (target.isP) updateShopUI();

  if (target.hp <= 0) {
    if (target.isP) {
      if (target.carriedItem) dropHeldOrCarriedItem(target, 2.0);
      oofRespawn('💀 Твоё здоровье упало до 0!');
    } else {
      sfx.oof();
      spawnDeathShatter(target);
      target.hp = target.maxHp;
      target.hpBarTimer = 0;
      target._deadCooldown = 1.4;
      target.rig.g.visible = false;
      target.tag.visible = false;

      if (S.gameMode && S.gameMode.onEntityKnockout) {
        S.gameMode.onEntityKnockout(target, attacker);
      }

      setTimeout(() => {
        if (!target || !target.rig) return;
        target._deadCooldown = 0;
        if (target.isCustomNPC) {
          target.x = target.homeX;
          target.z = target.homeZ;
          target.chat = 'Уф, меня собрали заново... 💫';
          target.chatT = 3.5;
        }
        target.rig.g.visible = true;
        target.tag.visible = true;
        refreshEntityTagWithHP(target);
      }, 1400);
    }
    if (target.isP) updateShopUI();
  }
  return true;
}

// Вычисляет мировую точку вылета снаряда (Muzzle / Throw Point) и вектор направления выстрела
export function computeMuzzleAndAim(player, item) {
  if (player.rig && player.rig.activeItemGroup) {
    if (player.isP) {
      player.rot = S.yaw + Math.PI;
      player.rig.g.rotation.y = player.rot;
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
    const fx = -Math.sin(S.yaw);
    const fz = -Math.cos(S.yaw);
    _vMuzzleWorld.set(player.x + fx * 0.9, player.y + 1.65, player.z + fz * 0.9);
  }

  const cp = Math.cos(S.pitch);
  _vAimDir.set(
    -Math.sin(S.yaw) * cp,
    Math.sin(S.pitch) + (item.useType === 'throwable' ? 0.22 : 0.04),
    -Math.cos(S.yaw) * cp
  ).normalize();

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
  const spread = Number(item.spread) || 0;
  const dx = dir.x + (spread > 0 ? rnd(-spread, spread) : 0);
  const dy = dir.y + (spread > 0 ? rnd(-spread, spread) : 0);
  const dz = dir.z + (spread > 0 ? rnd(-spread, spread) : 0);
  const len = Math.hypot(dx, dy, dz) || 1;

  const spd = Math.max(4, (Number(item.projSpeed) || 30) * speedMult);
  const group = buildItemGroup(item, { isProjectile: true, showMarkers: false, applyGripOffset: false });
  group.position.copy(origin);
  group.lookAt(origin.x + dx, origin.y + dy, origin.z + dz);
  scene.add(group);

  S.activeProjectiles.push({
    owner,
    item,
    group,
    x: origin.x,
    y: origin.y,
    z: origin.z,
    vx: (dx / len) * spd,
    vy: (dy / len) * spd,
    vz: (dz / len) * spd,
    gravity: (S.worldSettings.gravity || 22) * (Number(item.gravityFactor) ?? 0.2),
    damage: Number(item.damage) ?? 25,
    blastRadius: Number(item.blastRadius) || 0,
    knockback: Number(item.knockback) || 9,
    distTraveled: 0,
    maxRange: Math.max(10, Number(item.maxRange) || 65),
    age: 0
  });
}

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

  const maxChg = Math.max(0.25, Number(item.maxChargeTime) || 1.1);
  const ratio = clamp(S.throwChargeT / maxChg, 0.1, 1.0);
  S.throwChargeT = 0;

  const minSpd = Number(item.minThrowSpeed) || 8;
  const maxSpd = Math.max(minSpd + 2, Number(item.projSpeed) || 26);
  const finalSpd = minSpd + (maxSpd - minSpd) * ratio;
  const speedMult = finalSpd / maxSpd;

  player.rot = S.yaw + Math.PI;
  if (player.rig) player.rig.g.rotation.y = player.rot;

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

export function performPlayerMeleeAttack(isSpecialKey = false) {
  const player = S.player;
  if (S.state !== 'play' || !player || S.playerDead) return;
  if (player.attackCooldown > 0) return;

  // 1. Если игрок несёт 2-ручный контейнер — ЛКМ бросает его вперёд!
  if (player.carriedItem) {
    player.rot = S.yaw + Math.PI;
    if (player.rig) player.rig.g.rotation.y = player.rot;
    triggerEntityAttack(player, 'push');
    dropHeldOrCarriedItem(player, 9.5, `📦 Ты метнул «${player.carriedItem.name}»!`);
    player.attackCooldown = 0.35;
    return;
  }

  const item = !isSpecialKey ? getActiveHeldItem(player) : null;

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
    item.lightData.enabled = !item.lightData.enabled;
    sfx.jump();
    showBanner(`🔦 Факел «${item.name}»: ${item.lightData.enabled ? 'Включён 💡' : 'Погашен'}`, '#ffce3a');
    player.attackCooldown = 0.25;
    if (item.lightData.enabled) {
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
    if (player.rig) player.rig.g.rotation.y = player.rot;

    triggerEntityAttack(player, 'shoot');
    sfx.zap();
    spawnProjectile(player, item, 1.0);
    player.attackCooldown = Math.max(0.08, Number(item.cooldown) || 0.25);
    consumeItemDurability(player, item, Number(item.durabilityCostPerUse) || 0);
    renderHotbarUI();
    return;
  }

  // 5. Ближний бой (Кулак или Меч / Топор / Дубинка)
  const reach = item && item.useType === 'melee' ? (Number(item.range) || 4.4) : 3.6;
  const hitRadius = item && item.useType === 'melee' ? (Number(item.radius) || 2.2) : 1.8;
  const equipBonus = Number(item?.equipStats?.damageBonus) || 0;
  const dmg = item && item.useType === 'melee'
    ? Math.max(0, Number(item.damage) + equipBonus)
    : (player.meleeDamage || 25) + equipBonus;
  const kb = item && item.useType === 'melee' ? (Number(item.knockback) || 10) : 8;

  triggerEntityAttack(player, isSpecialKey ? 'push' : 'punch');
  sfx.slap();
  player.attackCooldown = item ? Math.max(0.15, Number(item.cooldown) || 0.35) : 0.3;

  const fx = -Math.sin(S.yaw);
  const fz = -Math.cos(S.yaw);

  for (const b of S.allBlocks) {
    const dx = Math.max(b.x0 - player.x, 0, player.x - b.x1);
    const dz = Math.max(b.z0 - player.z, 0, player.z - b.z1);
    if (Math.hypot(dx, dz) < reach && Math.abs(player.y + 1.0 - b.m.position.y) < b.hy + 2.5) {
      if (b.spawnerData && b.spawnerData.mode === 'hit') {
        triggerBlockSpawner(b);
      }
      if (b.logicData && b.logicData.trigger === 'hit') {
        triggerBlockLogic(b, 'hit');
      }
    }
  }

  const extraTargets = (S.gameMode && S.gameMode.getExtraTargets) ? S.gameMode.getExtraTargets() : [];
  const allTargets = [...S.customNPCs, ...extraTargets];

  let hitAnyone = false;
  for (const t of allTargets) {
    if (t._deadCooldown > 0) continue;
    const toX = t.x - player.x;
    const toZ = t.z - player.z;
    const dist = Math.hypot(toX, toZ);
    if (dist <= reach && Math.abs(t.y - player.y) < 2.8) {
      const dot = dist > 0.1 ? (toX / dist) * fx + (toZ / dist) * fz : 1;
      if (dot > -0.25 || dist <= hitRadius) {
        hitAnyone = true;
        if (dmg > 0) {
          if (t.hpEnabled) {
            dealDamage(t, dmg, player, kb);
          } else {
            t.chat = 'У меня отключён урон (Бессмертие)! 🛡️';
            t.chatT = 3.0;
            refreshEntityTagWithHP(t);
          }
        } else {
          // Нелетальное / игрушечное оружие (урон = 0, но отталкивает)
          t.vxKnock = (toX / (dist || 1)) * kb;
          t.vzKnock = (toZ / (dist || 1)) * kb;
          sfx.jump();
        }
      }
    }
  }

  if (hitAnyone && item && item.useType === 'melee') {
    consumeItemDurability(player, item, Number(item.durabilityCostPerUse) || 0);
  }

  if (S.gameMode && S.gameMode.onMeleeAttack) {
    S.gameMode.onMeleeAttack(isSpecialKey, hitAnyone);
  }
}

function detonateProjectile(proj, hitX, hitY, hitZ, directTarget = null) {
  const extraTargets = (S.gameMode && S.gameMode.getExtraTargets) ? S.gameMode.getExtraTargets() : [];
  const allTargets = [...S.customNPCs, ...extraTargets];

  if (proj.blastRadius > 0.2) {
    sfx.oof();
    spawnDamageParticles({ x: hitX, y: hitY, z: hitZ });
    for (const t of allTargets) {
      if (t._deadCooldown > 0) continue;
      const d = Math.hypot(t.x - hitX, (t.y + 1.2) - hitY, t.z - hitZ);
      if (d <= proj.blastRadius) {
        const falloff = 1 - (d / (proj.blastRadius * 1.25));
        const dmg = Math.round(proj.damage * Math.max(0.35, falloff));
        if (dmg > 0) {
          dealDamage(t, dmg, proj.owner, proj.knockback * 1.25);
        } else {
          const dx = t.x - hitX;
          const dz = t.z - hitZ;
          const h = Math.hypot(dx, dz) || 1;
          t.vxKnock = (dx / h) * proj.knockback;
          t.vzKnock = (dz / h) * proj.knockback;
        }
      }
    }
  } else if (directTarget) {
    if (proj.damage > 0) {
      dealDamage(directTarget, proj.damage, proj.owner, proj.knockback);
    } else {
      directTarget.vxKnock = (proj.vx / 25) * proj.knockback;
      directTarget.vzKnock = (proj.vz / 25) * proj.knockback;
    }
  }
}

function updateProjectilesAndWorldItems(dt) {
  // 1. Обновление летящих снарядов
  const extraTargets = (S.gameMode && S.gameMode.getExtraTargets) ? S.gameMode.getExtraTargets() : [];
  const allTargets = [...S.customNPCs, ...extraTargets];

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

    // Проверка попадания в NPC
    for (const t of allTargets) {
      if (t._deadCooldown > 0 || t === pr.owner) continue;
      if (Math.hypot(t.x - pr.x, t.z - pr.z) < 0.85 && pr.y >= t.y && pr.y <= t.y + 2.6) {
        hitSomething = true;
        directEnt = t;
        break;
      }
    }

    // Проверка попадания в твёрдые блоки
    if (!hitSomething) {
      for (const b of S.allBlocks) {
        if (b.matterState !== 'solid' || (b.logicRuntime && b.logicRuntime.ghostOpen)) continue;
        if (testPlayerOBB(pr.x, pr.y - 0.15, pr.z, 0.2, 0.3, b)) {
          hitSomething = true;
          if (b.logicData && b.logicData.trigger === 'hit') {
            triggerBlockLogic(b, 'hit');
          }
          break;
        }
      }
    }

    if (hitSomething || pr.distTraveled >= pr.maxRange || pr.y < -25 || pr.age > 6.5) {
      if (hitSomething) {
        detonateProjectile(pr, pr.x, pr.y, pr.z, directEnt);
      }
      scene.remove(pr.group);
      S.activeProjectiles.splice(i, 1);
    }
  }

  // 2. Физика лежащих и брошенных предметов / контейнеров (worldItems)
  const grav = S.worldSettings.gravity || 22;
  for (let i = S.worldItems.length - 1; i >= 0; i--) {
    const wi = S.worldItems[i];
    if (wi.pickupCooldown > 0) wi.pickupCooldown = Math.max(0, wi.pickupCooldown - dt);

    const prevVy = wi.vy;
    wi.vy = Math.max(-28, wi.vy - grav * dt);
    wi.x += wi.vx * dt;
    wi.y += wi.vy * dt;
    wi.z += wi.vz * dt;

    wi.vx *= Math.pow(0.08, dt);
    wi.vz *= Math.pow(0.08, dt);

    const rad = wi.item.holdMode === 'carried' ? 0.65 : 0.35;
    const h = wi.item.holdMode === 'carried' ? 1.1 : 0.55;
    wi.grounded = false;

    for (const b of S.allBlocks) {
      if (b.matterState !== 'solid' || (b.logicRuntime && b.logicRuntime.ghostOpen)) continue;
      const hit = testPlayerOBB(wi.x, wi.y, wi.z, rad, h, b);
      if (!hit) continue;

      if (hit.ny > 0.45 && wi.vy <= 0.5) {
        const impactSpeed = Math.abs(prevVy);
        wi.y += hit.pen;
        wi.vy = 0;
        wi.grounded = true;

        // Проверка урона от падения для хрупких переносимых контейнеров (яиц, ящиков и т.д.)
        if (impactSpeed > 9.5 && !wi.item.infiniteDurability && (wi.item.fallDamageMult || 0) > 0) {
          const dmg = Math.round((impactSpeed - 8.5) * wi.item.fallDamageMult);
          wi.item.durability = Math.max(0, (wi.item.durability ?? wi.item.maxDurability) - dmg);
          sfx.hit();
          if (wi.item.durability <= 0) {
            spawnDeathShatter({ x: wi.x, y: wi.y, z: wi.z, preset: { head: 0xf39c12, torso: 0xd35400 } });
            sfx.oof();
            showBanner(`💥 Контейнер «${wi.item.name}» разбился вдребезги при падении!`, '#ff3e3e');
            scene.remove(wi.group);
            scene.remove(wi.tag);
            S.worldItems.splice(i, 1);
            break;
          } else {
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
    wi.tag.position.set(wi.x, wi.y + 1.65, wi.z);
  }
}

function updateAimTrajectoryAndTorch(player, dt) {
  const tLight = ensureHeldTorchLight();
  const tLine = ensureTrajectoryLine();
  const hud = ensureThrowChargeHUD();
  const ch = ensureCrosshairHUD();

  const held = getActiveHeldItem(player);

  // Пассивное расходование прочности и работа света (Факел / Светящийся предмет)
  if (held && !S.playerDead && S.state === 'play') {
    const BaseMax = player.baseMaxHp || 100;
    const bonusHp = Number(held.equipStats?.maxHpBonus) || 0;
    if (player.maxHp !== BaseMax + bonusHp) {
      player.maxHp = BaseMax + bonusHp;
      player.hp = Math.min(player.hp, player.maxHp);
      updateShopUI();
    }

    if ((held.passiveDecayPerSec || 0) > 0 && (!held.lightData || held.lightData.enabled !== false)) {
      consumeItemDurability(player, held, held.passiveDecayPerSec * dt);
    }

    if (held.lightData && held.lightData.enabled) {
      tLight.color.set(held.lightData.color || '#ff9f43');
      tLight.intensity = Number(held.lightData.intensity) || 2.0;
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

  // Шкала замаха метательного предмета при удержании ЛКМ
  if (S.isChargingThrow && held && held.useType === 'throwable' && S.state === 'play' && !S.playerDead) {
    S.throwChargeT += dt;
    const maxChg = Math.max(0.25, Number(held.maxChargeTime) || 1.1);
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

  // Отрисовка 3D-линии баллистической траектории ТОЛЬКО для метательных предметов (throwable)
  const showArc =
    S.state === 'play' &&
    !S.playerDead &&
    held &&
    held.useType === 'throwable' &&
    ((S.isAimingRMB && held.canAim) || S.isChargingThrow);

  if (!showArc) {
    tLine.visible = false;
    return;
  }

  const { origin, dir } = computeMuzzleAndAim(player, held);
  let spd = Number(held.projSpeed) || 30;
  if (held.useType === 'throwable' && S.isChargingThrow) {
    const maxChg = Math.max(0.25, Number(held.maxChargeTime) || 1.1);
    const ratio = clamp(S.throwChargeT / maxChg, 0.1, 1.0);
    const minSpd = Number(held.minThrowSpeed) || 8;
    spd = minSpd + (spd - minSpd) * ratio;
  }

  const vx = dir.x * spd;
  const vy = dir.y * spd;
  const vz = dir.z * spd;
  const g = (S.worldSettings.gravity || 22) * (Number(held.gravityFactor) ?? 0.2);

  const posAttr = tLine.geometry.attributes.position;
  const arr = posAttr.array;
  const totalTime = 1.35;

  for (let i = 0; i <= TRAJ_SEGMENTS; i++) {
    const t = (i / TRAJ_SEGMENTS) * totalTime;
    arr[i * 3] = origin.x + vx * t;
    arr[i * 3 + 1] = origin.y + vy * t - 0.5 * g * t * t;
    arr[i * 3 + 2] = origin.z + vz * t;
  }
  posAttr.needsUpdate = true;
  tLine.visible = true;
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

export function update(dt) {
  S.time += dt;
  if (S.contactDamageCooldown > 0) S.contactDamageCooldown -= dt;

  const p = S.player;
  if (!p) return;

  if (p.attackCooldown > 0) p.attackCooldown = Math.max(0, p.attackCooldown - dt);

  const activeHeld = getActiveHeldItem(p);

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
    activeHeld &&
    activeHeld.useType === 'ranged' &&
    activeHeld.autoFire &&
    p.attackCooldown <= 0 &&
    !S.isReloadingHold &&
    p.reloadTimer <= 0
  ) {
    performPlayerMeleeAttack(false);
  }

  updateBlocksLogicRuntime(dt, p);
  updateProjectilesAndWorldItems(dt);
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

  let inLiquid = false;
  for (const b of S.allBlocks) {
    if (b.matterState === 'liquid') {
      if (b.m.material && b.m.material.map) {
        b.m.material.map.offset.y = (S.time * 0.25) % 1;
      }
      if (testPlayerOBB(p.x, p.y, p.z, pr, ph, b)) {
        inLiquid = true;
        if (b.logicData && b.logicData.trigger === 'touch') {
          triggerBlockLogic(b, 'touch');
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

  const equipSpdBonus = Number(activeHeld?.equipStats?.speedBonus) || 0;
  const carryPenalty = p.carriedItem ? 0.78 : 1.0;
  const spdBoost = (p.hasSpeed || (S.activeSlot === 1 && p.hasSpeed)) ? 1.55 : 1.0;
  const spd = ((p.walkSpeed || 7.6) + equipSpdBonus) * spdBoost * carryPenalty * (inLiquid ? 0.65 : 1.0);
  const fx = -Math.sin(S.yaw);
  const fz = -Math.cos(S.yaw);
  const rx = -fz;
  const rz = fx;

  let vx = p.vxKnock || 0;
  let vz = p.vzKnock || 0;
  p.vxKnock = (p.vxKnock || 0) * Math.pow(0.05, dt);
  p.vzKnock = (p.vzKnock || 0) * Math.pow(0.05, dt);

  if (len > 0.1) {
    vx += (fx * f + rx * s) * spd;
    vz += (fz * f + rz * s) * spd;
    p.rot = S.isAimingRMB ? S.yaw + Math.PI : Math.atan2(vx, vz);
    p.step += spd * dt;
  } else if (S.isAimingRMB || S.isChargingThrow) {
    p.rot = S.yaw + Math.PI;
  }

  p.x += vx * dt;
  p.z += vz * dt;

  const gravBoost = p.hasGrav ? 0.62 : 1.0;
  const baseJump = p.jumpPower || 10.2;
  if (S.keys.Space || S.btnJump) {
    if (inLiquid) {
      p.vy = 6.2;
    } else if (p.grounded) {
      p.vy = p.hasGrav ? baseJump * 1.32 : baseJump;
      p.grounded = false;
      sfx.jump();
    }
  }

  if (inLiquid) {
    p.vy = clamp(p.vy - S.worldSettings.gravity * 0.25 * dt, -4.5, 6.8);
  } else {
    p.vy = Math.max(-28, p.vy - S.worldSettings.gravity * gravBoost * dt);
  }
  p.y += p.vy * dt;
  p.grounded = false;

  for (const b of S.allBlocks) {
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
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;

    const hit = testPlayerOBB(p.x, p.y - 0.04, p.z, pr, ph + 0.04, b);
    if (!hit) continue;

    if (b.logicData && b.logicData.trigger === 'touch') {
      triggerBlockLogic(b, 'touch');
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

      if (hit.ny > 0.45) {
        if (p.vy <= 0.5) {
          const pushUp = Math.max(0, (hit.pen - 0.03) / Math.max(0.45, hit.ny));
          p.y += pushUp;
          p.vy = 0;
          p.grounded = true;

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
        if (
          b.spinSpeed === 0 &&
          hit.topFactor > 0.75 &&
          stepHeight > 0.02 &&
          stepHeight <= 0.62 &&
          p.vy <= 0.5
        ) {
          p.y = b.y1;
          p.vy = 0;
          p.grounded = true;
        } else {
          const hLen = Math.hypot(hit.nx, hit.nz) || 1;
          const nx = hit.nx / hLen;
          const nz = hit.nz / hLen;
          p.x += nx * hit.pen;
          p.z += nz * hit.pen;

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

  if (p.y < -18 && !S.playerDead) {
    oofRespawn('☁️ Ты упал с облаков в бездну!');
  }

  if (S.gameMode && S.gameMode.onUpdate) {
    S.gameMode.onUpdate(dt, len);
  }

  for (const npc of S.customNPCs) {
    if (npc._deadCooldown > 0) continue;
    if (npc.hpBarTimer > 0) {
      npc.hpBarTimer -= dt;
      if (npc.hpBarTimer <= 0) refreshEntityTagWithHP(npc);
    }
    if (npc.attackCooldown > 0) npc.attackCooldown -= dt;

    npc.x += (npc.vxKnock || 0) * dt;
    npc.z += (npc.vzKnock || 0) * dt;
    npc.vxKnock = (npc.vxKnock || 0) * Math.pow(0.05, dt);
    npc.vzKnock = (npc.vzKnock || 0) * Math.pow(0.05, dt);

    let moving = false;
    if (npc.aggressive && S.player && !S.playerDead) {
      const dx = S.player.x - npc.x;
      const dz = S.player.z - npc.z;
      const d = Math.hypot(dx, dz);
      if (d < 12 && d > 1.6) {
        const step = 4.2 * dt;
        npc.x += (dx / d) * step;
        npc.z += (dz / d) * step;
        npc.rot = Math.atan2(dx, dz);
        npc.step += step * 3;
        moving = true;
      } else if (d <= 2.2 && npc.attackCooldown <= 0) {
        npc.attackCooldown = 1.4;
        triggerEntityAttack(npc, 'punch');
        dealDamage(S.player, npc.meleeDamage || 15, npc);
      }
    } else if (npc.wander) {
      npc.wTimer -= dt;
      if (npc.wTimer <= 0) {
        npc.wTimer = rnd(2.5, 5.5);
        npc.tx = npc.homeX + rnd(-3.5, 3.5);
        npc.tz = npc.homeZ + rnd(-3.5, 3.5);
      }
      const dx = npc.tx - npc.x;
      const dz = npc.tz - npc.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.12) {
        const step = Math.min(d, 3.2 * dt);
        npc.x += (dx / d) * step;
        npc.z += (dz / d) * step;
        npc.rot = Math.atan2(dx, dz);
        npc.step += step * 3;
        moving = true;
      }
    }

    updateEntityAnimation(npc, dt, {
      moving,
      grounded: true,
      inLiquid: false
    });

    npc.rig.g.position.set(npc.x, npc.y, npc.z);
    npc.rig.g.rotation.y = npc.rot;
    npc.tag.position.set(npc.x, npc.y + 3.35, npc.z);
  }

  // Подсказка внизу экрана (Предметы в мире / Контейнер в руках / Кнопки [E] / Подсказка режима)
  const nearItem = findNearestWorldItem(p, 4.2);
  const nearKeyE = findNearestKeyEBlock(p, 5.0);
  let h = '';

  if (p.carriedItem) {
    h = `📦 В руках: «${p.carriedItem.name}» · [ЛКМ] — Бросить · [E / G] — Поставить на землю`;
  } else if (nearItem) {
    h = nearItem.item.holdMode === 'carried'
      ? `📦 Нажми [E] — Взять в 2 руки «${nearItem.item.name}»`
      : `${nearItem.item.icon || '🗡️'} Нажми [E] — Подобрать «${nearItem.item.name}»`;
  } else if (nearKeyE) {
    if (nearKeyE.logicData && nearKeyE.logicData.trigger === 'keyE') {
      const info = getLogicBadgeStrings(nearKeyE);
      h = `🔘 Нажми [E] — ${info ? info.title : nearKeyE.label}${info && info.sub ? ' (' + info.sub + ')' : ''}`;
    } else if (nearKeyE.spawnerData && nearKeyE.spawnerData.mode === 'keyE') {
      h = `🔘 Нажми [E] — Активировать спавнер «${nearKeyE.label}»`;
    }
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