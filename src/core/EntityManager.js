// src/core/EntityManager.js
import { S, $, rnd, showBanner } from './State.js';
import { scene } from './SceneManager.js';
import { sfx } from './AudioEngine.js';
import {
  createRobloxRig,
  makeTagSprite,
  updateTag,
  normalizeItemData,
  normalizeCharacterGripPoints,
  buildItemGroup
} from './CharacterRig.js';

export function attachRigToEntity(ent) {
  ent.rig.g.traverse(o => {
    if (!o.userData.editorRef) {
      o.userData.editorRef = { kind: 'char', ent };
    }
  });
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

export function spawnWorldItem(itemData, x = 0, y = 2, z = 0, vx = 0, vy = 0, vz = 0) {
  const data = normalizeItemData(JSON.parse(JSON.stringify(itemData)));
  const wid = 'witem_' + S.itemIdCounter++;
  const group = buildItemGroup(data, { isProjectile: false, showMarkers: false, applyGripOffset: false });
  group.position.set(x, y, z);
  scene.add(group);

  const tag = makeTagSprite(280, 90, 2.8, 0.95);
  const modeTxt = data.holdMode === 'carried' ? '📦 Взять в 2 руки [E]' : `${data.icon || '🗡️'} Подобрать [E]`;
  const subTxt = !data.infiniteDurability
    ? `Прочность: ${Math.ceil(data.durability)}/${data.maxDurability}`
    : (data.useType === 'ranged' ? `Боезапас: ${data.ammo}/${data.magSize}` : data.useType);
  updateTag(tag, modeTxt, data.name, subTxt);
  tag.position.set(x, y + 1.65, z);
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
    rotY: 0,
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
  group.position.set(worldEntry.x, worldEntry.y, worldEntry.z);
  group.rotation.y = worldEntry.rotY || 0;
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
    worldEntry.tag.position.set(worldEntry.x, worldEntry.y + 1.65, worldEntry.z);
  }
}

export function getActiveHeldItem(ent = S.player) {
  if (!ent) return null;
  if (ent.carriedItem) return null; // Когда в 2 руках контейнер, одноручный предмет убран
  if (!ent.isP) return ent.equippedItem || null;
  if (!Array.isArray(ent.inventory)) return null;
  // Слот 0 — кулак, слоты 1..3 в режиме очереди зарезервированы под спид/грав/спавн, если там нет кастомного предмета
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

  const item = normalizeItemData(worldEntry.item);

  // Если это 2-ручный переносимый контейнер (carried)
  if (item.holdMode === 'carried') {
    if (ent.carriedItem) {
      dropHeldOrCarriedItem(ent, 2.5);
    }
    ent.carriedItem = item;
    scene.remove(worldEntry.group);
    scene.remove(worldEntry.tag);
    S.worldItems.splice(idx, 1);
    syncEntityHeldItemMesh(ent);
    renderHotbarUI();
    sfx.jump();
    showBanner(`📦 Ты взял в руки «${item.name}»! [ЛКМ] — бросить, [G/E] — поставить.`, '#ffce3a');
    return true;
  }

  // Одноручный предмет (held)
  if (!Array.isArray(ent.inventory)) {
    ent.inventory = [null, null, null, null, null, null];
  }

  // Если у игрока уже есть такой же метательный предмет — суммируем стак снарядов!
  if (item.useType === 'throwable') {
    const existingIdx = ent.inventory.findIndex(it => it && it.name === item.name && it.useType === 'throwable');
    if (existingIdx >= 0) {
      ent.inventory[existingIdx].stackCount = (ent.inventory[existingIdx].stackCount || 1) + (item.stackCount || 1);
      scene.remove(worldEntry.group);
      scene.remove(worldEntry.tag);
      S.worldItems.splice(idx, 1);
      selectSlot(existingIdx);
      renderHotbarUI();
      sfx.cash();
      showBanner(`${item.icon} Подобрано: ${item.name} (Всего: x${ent.inventory[existingIdx].stackCount})`, '#00e676');
      return true;
    }
  }

  // Если у игрока уже есть такое же стрелковое оружие — пополняем патроны в запасе!
  if (item.useType === 'ranged') {
    const existingIdx = ent.inventory.findIndex(it => it && it.name === item.name && it.useType === 'ranged');
    if (existingIdx >= 0) {
      ent.inventory[existingIdx].reserveAmmo = (ent.inventory[existingIdx].reserveAmmo || 0) + (item.ammo || item.magSize || 12);
      scene.remove(worldEntry.group);
      scene.remove(worldEntry.tag);
      S.worldItems.splice(idx, 1);
      selectSlot(existingIdx);
      renderHotbarUI();
      sfx.cash();
      showBanner(`🔫 +Патроны для «${item.name}» (Запас: ${ent.inventory[existingIdx].reserveAmmo})`, '#56f0ff');
      return true;
    }
  }

  // Ищем свободный слот в хотбаре (слоты 1..5, а слот 0 оставляем под Кулак)
  let targetSlot = -1;
  for (let s = 1; s < 6; s++) {
    if (!ent.inventory[s]) {
      targetSlot = s;
      break;
    }
  }
  if (targetSlot === -1) {
    // Если все слоты заняты — заменяем текущий активный слот (или слот 4)
    targetSlot = S.activeSlot > 0 ? S.activeSlot : 4;
    if (ent.inventory[targetSlot]) {
      const old = ent.inventory[targetSlot];
      ent.inventory[targetSlot] = null;
      spawnWorldItem(old, ent.x + Math.sin(ent.rot) * 1.2, ent.y + 1.2, ent.z + Math.cos(ent.rot) * 1.2, 0, 2, 0);
    }
  }

  ent.inventory[targetSlot] = item;
  scene.remove(worldEntry.group);
  scene.remove(worldEntry.tag);
  S.worldItems.splice(idx, 1);

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
    spawnWorldItem(
      item,
      ent.x + fx * 1.35,
      ent.y + 1.35,
      ent.z + fz * 1.35,
      fx * throwSpeed,
      Math.max(1.5, throwSpeed * 0.45),
      fz * throwSpeed
    );
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
    spawnWorldItem(
      held,
      ent.x + fx * 1.2,
      ent.y + 1.35,
      ent.z + fz * 1.2,
      fx * throwSpeed,
      Math.max(2.0, throwSpeed * 0.45),
      fz * throwSpeed
    );
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
    name: opts.name || 'ТЫ (Игрок)',
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
    meleeDamage: 25,
    aggressive: false,
    attackCooldown: 0,
    reloadTimer: 0,
    colliderRadius: 0.42,
    colliderHeight: 2.5,
    walkSpeed: 7.6,
    jumpPower: 10.2,
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
    id: 'cnpc_' + (Date.now() + Math.floor(Math.random() * 9999)),
    isP: false,
    isCustomNPC: true,
    name: opts.name || ('NPC_' + (S.customNPCs.length + 1)),
    chat: opts.chat !== undefined ? opts.chat : 'Привет! Я бот из 3D Студии!',
    wander: opts.wander !== undefined ? opts.wander : true,
    aggressive: !!opts.aggressive,
    hpEnabled: opts.hpEnabled !== undefined ? opts.hpEnabled : true,
    hp: opts.hp || 100,
    maxHp: opts.maxHp || 100,
    hpBarTimer: 0,
    meleeDamage: opts.meleeDamage || 15,
    attackCooldown: 0,
    equippedItem: opts.equippedItem ? normalizeItemData(opts.equippedItem) : null,
    carriedItem: null,
    homeX: x,
    homeZ: z,
    x,
    y,
    z,
    vxKnock: 0,
    vzKnock: 0,
    rot: opts.rot || 0,
    step: 0,
    wTimer: rnd(1, 4),
    tx: x,
    tz: z,
    rig,
    tag,
    preset
  };

  attachRigToEntity(npc);
  syncEntityHeldItemMesh(npc);
  updateTag(npc.tag, '🤖 NPC', npc.name, npc.chat, false, { show: false, hp: npc.hp, maxHp: npc.maxHp });
  tag.position.set(x, y + 3.35, z);
  S.customNPCs.push(npc);
  return npc;
}

export function refreshEntityTagWithHP(e) {
  const hpInfo = { show: e.hpEnabled && e.hpBarTimer > 0, hp: e.hp, maxHp: e.maxHp };
  if (e.isArchangel) {
    updateTag(e.tag, '👑 СУДЬЯ', e.name, e.chat, false, hpInfo);
  } else if (e.isCustomNPC) {
    updateTag(e.tag, '🤖 NPC', e.name, e.chat, false, hpInfo);
  } else if (S.queueLine.length > 0 && e.qIdx !== undefined) {
    updateTag(e.tag, `#${e.qIdx + 1}`, e.name, e.chat, e.isP, hpInfo);
  } else {
    updateTag(e.tag, '🎮', e.name, e.chat, e.isP, hpInfo);
  }
}

export function updateShopUI() {
  const player = S.player;
  if (!player) return;
  if ($('cashTxt')) $('cashTxt').textContent = `${player.cash} R$`;
  if ($('hpPill')) $('hpPill').hidden = !player.hpEnabled;
  if ($('hpTxt')) $('hpTxt').textContent = `${Math.ceil(player.hp)} / ${player.maxHp}`;
  if ($('rebTxt')) $('rebTxt').textContent = player.rebirths || 0;

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

  // Если в слоте нет кастомного предмета, проверяем стандартное поведение режима
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
}