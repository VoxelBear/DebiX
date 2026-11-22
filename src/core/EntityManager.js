// src/core/EntityManager.js
import { S, $, rnd, showBanner, ITEM_STUDIO_ORIGIN } from './State.js';
import { scene } from './SceneManager.js';
import { sfx } from './AudioEngine.js';
import {
  createRobloxRig,
  makeTagSprite,
  updateTag,
  normalizeItemData,
  normalizeCharacterGripPoints,
  buildItemGroup,
  updateGroupRootHitbox
} from './CharacterRig.js';

export function attachRigToEntity(ent) {
  ent.rig.g.traverse(o => {
    if (!o.userData.editorRef) {
      o.userData.editorRef = { kind: 'char', ent };
    }
  });
  if (ent.tag) {
    ent.tag.userData.editorRef = { kind: 'char', ent };
  }
}

/* ---------- УПРАВЛЕНИЕ ПРЕДМЕТАМИ В МИРЕ И В РУКАХ ИГРОКА / NPC ---------- */

export function clearWorldItems() {
  for (const wi of S.worldItems) {
    if (wi.group) scene.remove(wi.group);
    if (wi.tag) scene.remove(wi.tag);
  }
  S.worldItems.length = 0;

  for (const p of S.activeProjectiles) {
    if (p.group) scene.remove(p.group);
  }
  S.activeProjectiles.length = 0;
}

export function spawnWorldItem(itemData, x = 0, y = 2, z = 0, vx = 0, vy = 0, vz = 0, opts = {}) {
  const data = normalizeItemData(JSON.parse(JSON.stringify(itemData)));
  const wid = opts.id || ('witem_' + S.itemIdCounter++);
  const group = buildItemGroup(data, { isProjectile: false, showMarkers: false, applyGripOffset: false });

  const rotX = Number(opts.rotX) || 0;
  const rotY = Number(opts.rotY) || 0;
  const rotZ = Number(opts.rotZ) || 0;
  const scaleX = Math.max(0.1, Number(opts.scaleX) || 1);
  const scaleY = Math.max(0.1, Number(opts.scaleY) || 1);
  const scaleZ = Math.max(0.1, Number(opts.scaleZ) || 1);

  group.position.set(x, y, z);
  group.rotation.set(rotX, rotY, rotZ);
  group.scale.set(scaleX, scaleY, scaleZ);
  updateGroupRootHitbox(group);
  scene.add(group);

  const tag = makeTagSprite(280, 90, 2.8, 0.95);
  const modeTxt = data.holdMode === 'carried' ? '📦 Взять в 2 руки [E]' : `${data.icon || '🗡️'} Подобрать [E]`;
  const subTxt = !data.infiniteDurability
    ? `Прочность: ${Math.ceil(data.durability)}/${data.maxDurability}`
    : (data.useType === 'ranged' ? `Боезапас: ${data.ammo}/${data.magSize}` : data.useType);
  updateTag(tag, modeTxt, data.name, subTxt);
  tag.position.set(x, y + 1.65 * Math.max(1, scaleY), z);
  scene.add(tag);

  const worldEntry = {
    id: wid,
    item: data,
    group,
    tag,
    x,
    y,
    z,
    vx,
    vy,
    vz,
    rotX,
    rotY,
    rotZ,
    scaleX,
    scaleY,
    scaleZ,
    grounded: false,
    pickupCooldown: 0.35
  };

  group.traverse(o => {
    o.userData.editorRef = { kind: 'world_item', worldEntry };
  });
  tag.userData.editorRef = { kind: 'world_item', worldEntry };

  S.worldItems.push(worldEntry);
  return worldEntry;
}

export function rebuildWorldItemVisual(
  worldEntry,
  showMarkers = S.state === 'edit' && S.selectedRef?.kind === 'world_item' && S.selectedRef.worldEntry === worldEntry
) {
  if (!worldEntry) return;
  if (worldEntry.group) scene.remove(worldEntry.group);
  const group = buildItemGroup(worldEntry.item, {
    isProjectile: false,
    showMarkers,
    applyGripOffset: false
  });

  if (S.itemStudioOpen && S.selectedRef?.worldEntry === worldEntry) {
    group.position.set(ITEM_STUDIO_ORIGIN.x, ITEM_STUDIO_ORIGIN.y + 1.25, ITEM_STUDIO_ORIGIN.z);
    group.rotation.set(0, 0, 0);
    group.scale.set(1, 1, 1);
  } else {
    group.position.set(worldEntry.x, worldEntry.y, worldEntry.z);
    group.rotation.set(
      worldEntry.rotX || 0,
      worldEntry.rotY || 0,
      worldEntry.rotZ || 0
    );
    group.scale.set(
      Math.max(0.1, worldEntry.scaleX || 1),
      Math.max(0.1, worldEntry.scaleY || 1),
      Math.max(0.1, worldEntry.scaleZ || 1)
    );
  }

  updateGroupRootHitbox(group);

  group.traverse(o => {
    o.userData.editorRef = { kind: 'world_item', worldEntry };
  });
  scene.add(group);
  worldEntry.group = group;

  if (worldEntry.tag) {
    const data = worldEntry.item;
    const modeTxt = data.holdMode === 'carried' ? '📦 Взять в 2 руки [E]' : `${data.icon || '🗡️'} Подобрать [E]`;
    const subTxt = !data.infiniteDurability
      ? `Прочность: ${Math.ceil(data.durability)}/${data.maxDurability}`
      : (data.useType === 'ranged' ? `Боезапас: ${data.ammo}/${data.magSize}` : data.useType);
    updateTag(worldEntry.tag, modeTxt, data.name, subTxt);
    const sy = Math.max(1, worldEntry.scaleY || 1);
    worldEntry.tag.position.set(worldEntry.x, worldEntry.y + 1.65 * sy, worldEntry.z);
  }
}

export function getActiveHeldItem(ent = S.player) {
  if (!ent) return null;
  if (ent.carriedItem) return null;
  if (!ent.isP) {
    if (ent.isCustomNPC && ent.aiModules?.worldPhysics?.canHoldItems === false) {
      return null;
    }
    return ent.equippedItem || null;
  }
  if (!Array.isArray(ent.inventory)) return null;
  return ent.inventory[S.activeSlot] || null;
}

export function syncEntityHeldItemMesh(ent = S.player) {
  if (!ent || !ent.rig) return;
  const { handGripSocket, carrySocket } = ent.rig;
  if (!handGripSocket || !carrySocket) return;

  if (ent.rig.syncGripSockets && ent.preset) {
    ent.rig.syncGripSockets(ent.preset);
  }

  while (handGripSocket.children.length > 0) {
    handGripSocket.remove(handGripSocket.children[0]);
  }
  while (carrySocket.children.length > 0) {
    carrySocket.remove(carrySocket.children[0]);
  }

  // 1. Если персонаж несёт 2-ручный объект (carriedItem)
  if (ent.carriedItem) {
    const cItem = normalizeItemData(ent.carriedItem);
    const meshGroup = buildItemGroup(cItem, { isProjectile: false, showMarkers: false, applyGripOffset: true });
    meshGroup.traverse(o => {
      if (!o.userData.editorRef) o.userData.editorRef = { kind: 'char', ent };
    });
    carrySocket.add(meshGroup);
    ent.rig.activeItemGroup = meshGroup;
    ent.holdPose = 'carried';
    return;
  }

  // 2. Если персонаж держит 1-ручный предмет из активного слота
  const heldItem = getActiveHeldItem(ent);
  if (heldItem) {
    normalizeItemData(heldItem);
    const meshGroup = buildItemGroup(heldItem, { isProjectile: false, showMarkers: false, applyGripOffset: true });
    meshGroup.traverse(o => {
      if (!o.userData.editorRef) o.userData.editorRef = { kind: 'char', ent };
    });
    handGripSocket.add(meshGroup);
    ent.rig.activeItemGroup = meshGroup;
    if (heldItem.useType === 'shield') {
      ent.holdPose = 'shield';
    } else if (heldItem.useType === 'ranged' || (ent.isP && S.isAimingRMB && heldItem.canAim)) {
      ent.holdPose = 'aim';
    } else {
      ent.holdPose = 'weapon';
    }
  } else {
    ent.rig.activeItemGroup = null;
    ent.holdPose = null;
  }
}

export function pickupWorldItem(ent, worldEntry) {
  if (!ent || !worldEntry) return false;
  const idx = S.worldItems.indexOf(worldEntry);
  if (idx < 0) return false;

  const pickedWorldId = worldEntry.id;
  const item = normalizeItemData(worldEntry.item);

  const removeWorldEntryAndSync = () => {
    scene.remove(worldEntry.group);
    scene.remove(worldEntry.tag);
    S.worldItems.splice(idx, 1);
    if (window.__debixSyncWorldItemDelete && !S.isApplyingRemoteSync) {
      window.__debixSyncWorldItemDelete(pickedWorldId);
    }
  };

  if (item.holdMode === 'carried') {
    if (ent.carriedItem) {
      dropHeldOrCarriedItem(ent, 2.5);
    }
    ent.carriedItem = item;
    removeWorldEntryAndSync();
    syncEntityHeldItemMesh(ent);
    renderHotbarUI();
    if (ent.isP && window.__debixSendImmediateFullState) {
      window.__debixSendImmediateFullState();
    }
    sfx.jump();
    showBanner(`📦 Ты взял в руки «${item.name}»! [ЛКМ] — бросить, [G/E] — поставить.`, '#ffce3a');
    return true;
  }

  if (!Array.isArray(ent.inventory)) {
    ent.inventory = [null, null, null, null, null, null];
  }

  if (item.useType === 'throwable') {
    const existingIdx = ent.inventory.findIndex(it => it && it.name === item.name && it.useType === 'throwable');
    if (existingIdx >= 0) {
      ent.inventory[existingIdx].stackCount = (ent.inventory[existingIdx].stackCount || 1) + (item.stackCount || 1);
      removeWorldEntryAndSync();
      selectSlot(existingIdx);
      renderHotbarUI();
      sfx.cash();
      showBanner(`${item.icon} Подобрано: ${item.name} (Всего: x${ent.inventory[existingIdx].stackCount})`, '#00e676');
      return true;
    }
  }

  if (item.useType === 'ranged') {
    const existingIdx = ent.inventory.findIndex(it => it && it.name === item.name && it.useType === 'ranged');
    if (existingIdx >= 0) {
      ent.inventory[existingIdx].reserveAmmo = (ent.inventory[existingIdx].reserveAmmo || 0) + (item.ammo || item.magSize || 12);
      removeWorldEntryAndSync();
      selectSlot(existingIdx);
      renderHotbarUI();
      sfx.cash();
      showBanner(`🔫 +Патроны для «${item.name}» (Запас: ${ent.inventory[existingIdx].reserveAmmo})`, '#56f0ff');
      return true;
    }
  }

  let targetSlot = -1;
  for (let s = 1; s < 6; s++) {
    if (!ent.inventory[s]) {
      targetSlot = s;
      break;
    }
  }
  if (targetSlot === -1) {
    targetSlot = S.activeSlot > 0 ? S.activeSlot : 4;
    if (ent.inventory[targetSlot]) {
      const old = ent.inventory[targetSlot];
      ent.inventory[targetSlot] = null;
      const droppedOld = spawnWorldItem(old, ent.x + Math.sin(ent.rot) * 1.2, ent.y + 1.2, ent.z + Math.cos(ent.rot) * 1.2, 0, 2, 0);
      if (droppedOld && window.__debixSyncWorldItemUpsert && !S.isApplyingRemoteSync) {
        window.__debixSyncWorldItemUpsert(droppedOld, false);
      }
    }
  }

  ent.inventory[targetSlot] = item;
  removeWorldEntryAndSync();

  selectSlot(targetSlot);
  renderHotbarUI();
  updateShopUI();
  sfx.coil();
  showBanner(`${item.icon || '🗡️'} Подобран предмет «${item.name}» (Слот ${targetSlot + 1})!`, '#00e676');
  return true;
}

export function dropHeldOrCarriedItem(ent = S.player, throwSpeed = 3.5, reasonMsg = null) {
  if (!ent) return false;
  if (ent.isP) {
    S.isChargingThrow = false;
    S.throwChargeT = 0;
    S.isReloadingHold = false;
    S.reloadHoldT = 0;
    ent.reloadTimer = 0;
  }
  const fx = -Math.sin(ent.isP ? S.yaw : ent.rot);
  const fz = -Math.cos(ent.isP ? S.yaw : ent.rot);

  if (ent.carriedItem) {
    const item = ent.carriedItem;
    ent.carriedItem = null;
    syncEntityHeldItemMesh(ent);
    renderHotbarUI();
    const wi = spawnWorldItem(
      item,
      ent.x + fx * 1.35,
      ent.y + 1.35,
      ent.z + fz * 1.35,
      fx * throwSpeed,
      Math.max(1.5, throwSpeed * 0.45),
      fz * throwSpeed
    );
    if (wi) {
      wi._thrownBy = ent;
      wi._throwGrace = 0.28;
      wi._physSleep = false;
    }
    if (wi && window.__debixSyncWorldItemUpsert && !S.isApplyingRemoteSync) {
      window.__debixSyncWorldItemUpsert(wi, false);
    }
    if (ent.isP && window.__debixSendImmediateFullState) {
      window.__debixSendImmediateFullState();
    }
    sfx.slap();
    if (reasonMsg) showBanner(reasonMsg, '#ff3e3e');
    else showBanner(`📦 Предмет «${item.name}» опущен на землю.`, '#ffce3a');
    return true;
  }

  const held = getActiveHeldItem(ent);
  if (held && ent.isP) {
    ent.inventory[S.activeSlot] = null;
    syncEntityHeldItemMesh(ent);
    renderHotbarUI();
    updateShopUI();
    const wi = spawnWorldItem(
      held,
      ent.x + fx * 1.2,
      ent.y + 1.35,
      ent.z + fz * 1.2,
      fx * throwSpeed,
      Math.max(2.0, throwSpeed * 0.45),
      fz * throwSpeed
    );
    if (wi) {
      wi._thrownBy = ent;
      wi._throwGrace = 0.28;
      wi._physSleep = false;
    }
    if (wi && window.__debixSyncWorldItemUpsert && !S.isApplyingRemoteSync) {
      window.__debixSyncWorldItemUpsert(wi, false);
    }
    if (window.__debixSendImmediateFullState) {
      window.__debixSendImmediateFullState();
    }
    sfx.slap();
    if (reasonMsg) showBanner(reasonMsg, '#ff3e3e');
    else showBanner(`📤 Выброшен предмет «${held.name}» [G]`, '#8fa0bd');
    return true;
  }
  return false;
}

export function renderHotbarUI() {
  const hb = $('hotbar');
  const player = S.player;
  if (!hb || !player) return;

  if (!Array.isArray(player.inventory)) {
    player.inventory = [null, null, null, null, null, null];
  }

  const isHeavenQueue = S.gameMode && S.gameMode.id === 'heaven_queue';
  let html = '';

  for (let i = 0; i < 6; i++) {
    const item = player.inventory[i];
    const isAct = S.activeSlot === i && !player.carriedItem;

    if (item) {
      let badge = '';
      if (item.useType === 'ranged') {
        badge = item.infiniteAmmo ? '∞' : `${item.ammo}/${item.reserveAmmo ?? item.magSize}`;
      } else if (item.useType === 'throwable') {
        badge = item.infiniteAmmo ? '∞' : `x${item.stackCount ?? 1}`;
      } else if (!item.infiniteDurability) {
        badge = `${Math.ceil((item.durability / Math.max(1, item.maxDurability)) * 100)}%`;
      }
      html += `
        <div class="slot ${isAct ? 'active' : ''}" data-slot="${i}" title="${item.name}">
          <span class="num">${i + 1}</span>
          <span class="ico">${item.icon || '🗡️'}</span>
          <span style="max-width:58px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${item.name}</span>
          ${badge ? `<small style="font-size:9px;color:#ffce3a">${badge}</small>` : ''}
        </div>
      `;
    } else if (i === 0) {
      html += `<div class="slot ${isAct ? 'active' : ''}" data-slot="0"><span class="num">1</span><span class="ico">🥊</span>Кулак</div>`;
    } else if (i === 1 && (isHeavenQueue || player.hasSpeed)) {
      html += `<div class="slot ${isAct ? 'active' : ''}" data-slot="1"><span class="num">2</span><span class="ico">🌀</span>Speed</div>`;
    } else if (i === 2 && (isHeavenQueue || player.hasGrav)) {
      html += `<div class="slot ${isAct ? 'active' : ''}" data-slot="2"><span class="num">3</span><span class="ico">🚀</span>Gravity</div>`;
    } else if (i === 3 && isHeavenQueue) {
      html += `<div class="slot ${isAct ? 'active' : ''}" data-slot="3"><span class="num">4</span><span class="ico">☁️</span>Очередь</div>`;
    } else {
      html += `<div class="slot ${isAct ? 'active' : ''}" data-slot="${i}" style="opacity:0.55"><span class="num">${i + 1}</span><span class="ico">▫️</span>Пусто</div>`;
    }
  }

  hb.innerHTML = html;
  hb.querySelectorAll('.slot').forEach(el => {
    el.onclick = () => selectSlot(+el.dataset.slot);
  });
}

export function clearEntities() {
  for (const ent of S.queueLine) {
    if (ent && ent.rig) {
      scene.remove(ent.rig.g);
      scene.remove(ent.tag);
    }
  }
  S.queueLine.length = 0;

  for (const npc of S.customNPCs) {
    if (npc && npc.rig) {
      scene.remove(npc.rig.g);
      scene.remove(npc.tag);
    }
  }
  S.customNPCs.length = 0;

  if (S.archangelEnt && S.archangelEnt.rig) {
    scene.remove(S.archangelEnt.rig.g);
    scene.remove(S.archangelEnt.tag);
  }
  S.archangelEnt = null;

  if (S.player && S.player.rig) {
    scene.remove(S.player.rig.g);
    scene.remove(S.player.tag);
  }
  S.player = null;
}

export function spawnPlayer(opts = {}) {
  if (S.player && S.player.rig) {
    scene.remove(S.player.rig.g);
    scene.remove(S.player.tag);
  }

  const basePreset = opts.preset || {
    head: 0xf5cd30,
    torso: 0x00a2ff,
    armL: 0xf5cd30,
    armR: 0xf5cd30,
    legL: 0x2ecc71,
    legR: 0x2ecc71,
    hair: null,
    hat: null,
    limbTex: {},
    customCosmetics: []
  };
  normalizeCharacterGripPoints(basePreset, opts);

  const rig = createRobloxRig(basePreset, opts.scale || 1, false);
  const tag = makeTagSprite(280, 105, 3.0, 1.1);
  const x = opts.x ?? 0;
  const y = opts.y ?? 1.0;
  const z = opts.z ?? 8;
  rig.g.position.set(x, y, z);
  scene.add(rig.g, tag);

  const player = {
    id: 'player',
    isP: true,
    isCustomNPC: false,
    name: S.playerName || opts.name || 'Игрок',
    qIdx: opts.qIdx ?? 0,
    x,
    y,
    z,
    vxKnock: 0,
    vzKnock: 0,
    vy: 0,
    rot: opts.rot ?? Math.PI,
    grounded: true,
    hpEnabled: true,
    hp: 100,
    maxHp: 100,
    baseMaxHp: 100,
    hpBarTimer: 0,
    stamina: 100,
    maxStamina: 100,
    staminaExhausted: false,
    isSprinting: false,
    meleeDamage: 25,
    aggressive: false,
    attackCooldown: 0,
    kickCooldown: 0,
    ragdoll: null,
    reloadTimer: 0,
    colliderRadius: 0.42,
    colliderHeight: 2.5,
    walkSpeed: 7.6,
    jumpPower: 10.2,
    gait: opts.gait || 'normal',
    isFlying: false,
    rig,
    tag,
    chat: '',
    chatT: 0,
    step: 0,
    preset: basePreset,
    inventory: opts.inventory || [null, null, null, null, null, null],
    carriedItem: null,
    cash: opts.cash ?? 25,
    rebirths: 0,
    hasSpeed: false,
    hasGrav: false,
    hasHalo: false,
    bestObby: 0,
    inHeaven: false,
    respawnX: x,
    respawnY: y,
    respawnZ: z
  };

  attachRigToEntity(player);
  S.player = player;
  syncEntityHeldItemMesh(player);
  renderHotbarUI();
  refreshEntityTagWithHP(player);
  tag.position.set(x, y + 3.35, z);
  return player;
}

export function createDefaultNpcModules(opts = {}) {
  const hasLegacyWander = opts.wander !== undefined ? !!opts.wander : true;
  const hasLegacyAggr = !!opts.aggressive;

  return {
    worldPhysics: {
      enabled: opts.worldPhysicsEnabled !== undefined ? !!opts.worldPhysicsEnabled : true,
      collapsed: false,
      gravityScale: 1.0,
      fallDamage: true,
      fallDamageThreshold: 16.5,
      hazardDamage: true,
      canSwim: true,
      canHoldItems: true,
      canPickupItems: true,
      canInteractBlocks: true
    },
    navigation: {
      enabled: true,
      collapsed: false,
      mode: hasLegacyWander ? 'wander' : 'stand',
      gait: opts.gait || 'normal',
      intelligence: (opts.intelligence === 'dumb' || opts.intelligence === 'low') ? 'dumb' : 'smart', // 'dumb' | 'smart'
      walkSpeed: opts.walkSpeed ?? 5.4,
      canSprint: true,
      sprintMultiplier: 1.48,
      jumpPower: opts.jumpPower ?? 10.2,
      wanderRadius: 10.0,
      followDist: 3.2,
      canJump: true,
      jumpGaps: true,
      usePathfinding: true,
      patrolLoop: 'loop',
      waypoints: []
    },
    humanError: {
      enabled: false,
      collapsed: false,
      mistakeLevel: 0.25,
      jumpMistakeChance: 0.22,
      pathNoise: 0.3,
      hesitationChance: 0.15,
      aimError: 0.2
    },
    combat: {
      enabled: hasLegacyAggr,
      collapsed: false,
      stance: hasLegacyAggr ? 'hostile' : 'guard',
      faction: opts.faction || '', // ID пользовательской фракции из S.worldSettings.factions (или '' = без фракции)
      attackOtherFactions: true,
      callForHelp: true,
      aggroRadius: 14.0,
      loseAggroRadius: 24.0,
      attackRange: 2.3,
      attackCooldown: 1.1,
      accuracy: 0.75,
      respectAmmoReload: true,
      useEquippedWeapon: true,
      fleeLowHp: false,
      fleeHpPct: 20
    },
    dialogue: {
      enabled: false,
      collapsed: false,
      interactKeyE: true,
      lines: [
        opts.chat || 'Привет! Я модульный NPC!',
        'Осторожнее возле пропастей и лавы!',
        'Удачи в приключениях!'
      ],
      aggroChat: 'Эй! Сейчас ты получишь! 😡',
      oopsChat: 'Ой-ой, кажется я не рассчитал прыжок! 😱',
      dropCoins: 15,
      dropEquippedItem: true,
      respawnTime: 3.5,
      permanentDeath: !!opts.permanentDeath
    },
    customScript: {
      enabled: false,
      collapsed: false,
      targetType: 'npc',
      name: 'Скрипт Бота',
      code: '',
      paramValues: {}
    }
  };
}

export function ensureNpcModules(npc) {
  if (!npc) return null;
  const defs = createDefaultNpcModules(npc);
  if (!npc.aiModules || typeof npc.aiModules !== 'object') {
    npc.aiModules = defs;
  } else {
    for (const key of Object.keys(defs)) {
      if (!npc.aiModules[key] || typeof npc.aiModules[key] !== 'object') {
        npc.aiModules[key] = defs[key];
      } else {
        npc.aiModules[key] = Object.assign({}, defs[key], npc.aiModules[key]);
      }
    }
    if (!Array.isArray(npc.aiModules.navigation.waypoints)) {
      npc.aiModules.navigation.waypoints = [];
    }
    if (!Array.isArray(npc.aiModules.dialogue.lines) || npc.aiModules.dialogue.lines.length === 0) {
      npc.aiModules.dialogue.lines = [npc.chat || 'Привет!'];
    }
  }
  if (npc.aiModules.worldPhysics.canHoldItems === false) {
    npc.aiModules.worldPhysics.canPickupItems = false;
  }
  const rawInt = npc.aiModules.navigation.intelligence;
  npc.aiModules.navigation.intelligence = (rawInt === 'dumb' || rawInt === 'low') ? 'dumb' : 'smart';
  if (npc.maxStamina === undefined) npc.maxStamina = 100;
  if (npc.stamina === undefined) npc.stamina = npc.maxStamina;
  npc.wander = Boolean(npc.aiModules.navigation?.enabled && npc.aiModules.navigation.mode !== 'stand');
  npc.aggressive = Boolean(npc.aiModules.combat?.enabled && npc.aiModules.combat.stance === 'hostile');
  npc.walkSpeed = Number(npc.aiModules.navigation?.walkSpeed) || 5.4;
  npc.jumpPower = Number(npc.aiModules.navigation?.jumpPower) || 10.2;
  // Единый источник правды для permanentDeath (по умолчанию false — NPC возрождается)
  const permFlag = npc.permanentDeath !== undefined
    ? Boolean(npc.permanentDeath)
    : Boolean(npc.aiModules.dialogue?.permanentDeath);
  npc.permanentDeath = permFlag;
  if (npc.aiModules.dialogue) npc.aiModules.dialogue.permanentDeath = permFlag;
  return npc.aiModules;
}

export function spawnCustomNPC(opts = {}) {
  const preset = Object.assign({
    head: opts.head ?? 0xf5cd30,
    torso: opts.torso ?? 0xe74c3c,
    armL: opts.armL ?? (opts.head ?? 0xf5cd30),
    armR: opts.armR ?? (opts.head ?? 0xf5cd30),
    legL: opts.legL ?? 0x2c3e50,
    legR: opts.legR ?? 0x2c3e50,
    hair: opts.hair || null,
    hat: opts.hat || null,
    crown: !!opts.crown,
    glasses: !!opts.glasses,
    backpack: !!opts.backpack,
    sword: !!opts.sword,
    halo: !!opts.halo,
    wings: !!opts.wings,
    coil: !!opts.coil,
    faceDataURL: opts.faceDataURL || null,
    limbTex: opts.limbTex || {},
    customCosmetics: opts.customCosmetics || [],
    handGripPoint: opts.handGripPoint || null,
    carryGripPoint: opts.carryGripPoint || null
  });
  normalizeCharacterGripPoints(preset, opts);

  const rig = createRobloxRig(preset, opts.scale || 1, false);
  const tag = makeTagSprite(280, 105, 3.0, 1.1);
  const x = opts.x !== undefined ? opts.x : (S.player ? S.player.x + rnd(-3, 3) : 0);
  const y = opts.y !== undefined ? opts.y : (S.player ? S.player.y : 0.5);
  const z = opts.z !== undefined ? opts.z : (S.player ? S.player.z + rnd(-3, 3) : 6);
  rig.g.position.set(x, y, z);
  rig.g.rotation.y = opts.rot || 0;
  scene.add(rig.g, tag);

  const npc = {
    id: opts.id || ('cnpc_' + (Date.now() + Math.floor(Math.random() * 9999))),
    isP: false,
    isCustomNPC: true,
    name: opts.name || ('NPC_' + (S.customNPCs.length + 1)),
    chat: opts.chat !== undefined ? opts.chat : '',
    wander: opts.wander !== undefined ? opts.wander : true,
    aggressive: !!opts.aggressive,
    hpEnabled: opts.hpEnabled !== undefined ? opts.hpEnabled : true,
    permanentDeath: Boolean(opts.permanentDeath || opts.aiModules?.dialogue?.permanentDeath),
    _permanentlyDead: false,
    _deadCooldown: 0,
    ragdoll: null,
    hp: opts.hp ?? 100,
    maxHp: opts.maxHp ?? 100,
    hpBarTimer: 0,
    meleeDamage: opts.meleeDamage ?? 15,
    attackCooldown: 0,
    colliderRadius: opts.colliderRadius || 0.42,
    colliderHeight: opts.colliderHeight || 2.5,
    walkSpeed: opts.walkSpeed || 5.4,
    jumpPower: opts.jumpPower || 10.2,
    equippedItem: opts.equippedItem ? normalizeItemData(opts.equippedItem) : null,
    carriedItem: null,
    aiModules: opts.aiModules ? JSON.parse(JSON.stringify(opts.aiModules)) : null,
    homeX: opts.homeX !== undefined ? opts.homeX : x,
    homeY: opts.homeY !== undefined ? opts.homeY : y,
    homeZ: opts.homeZ !== undefined ? opts.homeZ : z,
    x,
    y,
    z,
    vy: 0,
    grounded: true,
    inLiquid: false,
    vxKnock: 0,
    vzKnock: 0,
    rot: opts.rot || 0,
    step: 0,
    wTimer: rnd(0.5, 2.5),
    tx: x,
    tz: z,
    rig,
    tag,
    preset
  };

  ensureNpcModules(npc);
  attachRigToEntity(npc);
  syncEntityHeldItemMesh(npc);
  refreshEntityTagWithHP(npc);
  tag.position.set(x, y + 3.35, z);
  S.customNPCs.push(npc);
  if (window.__debixSyncNpcUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncNpcUpsert(npc, false);
  }
  return npc;
}

export function refreshEntityTagWithHP(e) {
  if (!e || !e.tag) return;
  const hpInfo = { show: e.hpEnabled && e.hpBarTimer > 0, hp: e.hp, maxHp: e.maxHp };
  if (e.isArchangel) {
    updateTag(e.tag, '', e.name, e.chat, false, hpInfo, e);
  } else if (e.isRemotePlayer || e.isCustomNPC) {
    updateTag(e.tag, '', e.name, e.chat, false, hpInfo, e);
  } else if (S.gameMode?.id === 'heaven_queue' && S.queueLine.length > 0 && e.qIdx !== undefined) {
    updateTag(e.tag, `#${e.qIdx + 1}`, e.name, e.chat, e.isP, hpInfo, e);
  } else {
    updateTag(e.tag, '', e.name, e.chat, e.isP, hpInfo, e);
  }
}

export function updateShopUI() {
  const player = S.player;
  if (!player) return;

  const cashEl = $('cashTxt');
  if (cashEl) {
    const cashPill = cashEl.parentElement;
    if (cashPill && cashPill.firstChild && cashPill.firstChild.nodeType === 3) {
      if (cashPill.firstChild.textContent.includes('КАРМА')) {
        cashPill.firstChild.textContent = '💰 БАЛАНС:';
      }
    }
    cashEl.textContent = `${player.cash} R$`;
  }

  if ($('hpPill')) $('hpPill').hidden = !player.hpEnabled;
  if ($('hpTxt')) $('hpTxt').textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;

  const stamPill = $('staminaPill');
  const stamTxt = $('staminaTxt');
  if (stamPill && stamTxt) {
    const allowSpr = S.worldSettings.allowSprint !== false;
    stamPill.hidden = !allowSpr;
    if (allowSpr) {
      const curStam = Math.ceil(player.stamina ?? 100);
      const maxStam = player.maxStamina || 100;
      stamTxt.textContent = S.worldSettings.staminaDrainOnSprint === false
        ? '∞ (БЕЗ ТРАТЫ)'
        : `${curStam} / ${maxStam}`;
      stamTxt.style.color = player.staminaExhausted ? '#ff3e3e' : (curStam < 30 ? '#ffce3a' : '#56f0ff');
    }
  }

  const rebEl = $('rebTxt');
  if (rebEl) {
    rebEl.textContent = player.rebirths || 0;
    const rebPill = rebEl.closest('.pill');
    if (rebPill) {
      const isHeavenQueue = S.gameMode && S.gameMode.id === 'heaven_queue';
      rebPill.hidden = !isHeavenQueue;
    }
  }

  renderHotbarUI();

  if (S.gameMode && S.gameMode.onUpdateHUD) {
    S.gameMode.onUpdateHUD();
  }
}

export function selectSlot(idx) {
  S.activeSlot = idx;
  S.isChargingThrow = false;
  S.throwChargeT = 0;
  S.isReloadingHold = false;
  S.reloadHoldT = 0;

  const player = S.player;
  if (!player) return;
  player.reloadTimer = 0;

  const slotItem = Array.isArray(player.inventory) ? player.inventory[idx] : null;
  if (!slotItem && S.gameMode && S.gameMode.onSelectSlot) {
    const handled = S.gameMode.onSelectSlot(idx);
    if (handled) {
      syncEntityHeldItemMesh(player);
      renderHotbarUI();
      return;
    }
  }

  player.rig.coil.visible = !slotItem && ((idx === 1 && player.hasSpeed) || (idx === 2 && player.hasGrav));
  if (player.rig.coil.visible) {
    player.rig.coil.material.color.setHex(idx === 1 ? 0xff3e3e : 0x00a2ff);
    sfx.coil();
  }

  syncEntityHeldItemMesh(player);
  renderHotbarUI();
  if (window.__debixSendImmediateFullState && !S.isApplyingRemoteSync) {
    window.__debixSendImmediateFullState();
  }
}