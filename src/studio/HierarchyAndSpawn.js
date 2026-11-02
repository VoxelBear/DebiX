// src/studio/HierarchyAndSpawn.js
import { S, $, showBanner } from '../core/State.js';
import { sfx } from '../core/AudioEngine.js';
import { createStarterItemTemplate } from '../core/CharacterRig.js';
import { addSceneBlock, addCheckpointBlock, rebuildPhysicsArrays } from '../core/WorldRegistry.js';
import { spawnCustomNPC, spawnWorldItem } from '../core/EntityManager.js';
import { selectEditorObject, focusOnSelected, pushUndoState, closeItemStudio3D } from './StudioController.js';

function getBlockHierarchyIcon(b) {
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
  if (b.matterState === 'liquid') return '💧';
  if (b.matterState === 'gas') return '☁️';
  if (b.damageOnContact > 0) return '🚨';
  if (b.bounciness > 0) return '🟢';
  return '🧱';
}

export function refreshHierarchyUI() {
  const filter = $('hierFilter').value;
  const cont = $('hierContainer');
  let html = '';

  if (filter === 'all' || filter === 'chars') {
    if (S.player) {
      const isSel = S.selectedRef && S.selectedRef.kind === 'char' && S.selectedRef.ent === S.player;
      html += `<div class="hier-item ${isSel ? 'sel' : ''}" data-hkind="char" data-hid="player"><span>👑 ${S.player.name}</span><small>Игрок</small></div>`;
    }
    if (S.archangelEnt) {
      const isSel = S.selectedRef && S.selectedRef.kind === 'char' && S.selectedRef.ent === S.archangelEnt;
      html += `<div class="hier-item ${isSel ? 'sel' : ''}" data-hkind="char" data-hid="archangel"><span>😇 ${S.archangelEnt.name}</span><small>Судья</small></div>`;
    }
    for (const npc of S.customNPCs) {
      const isSel = S.selectedRef && S.selectedRef.kind === 'char' && S.selectedRef.ent === npc;
      html += `<div class="hier-item ${isSel ? 'sel' : ''}" data-hkind="char" data-hid="${npc.id}"><span>🤖 ${npc.name}</span><small>NPC</small></div>`;
    }
    for (let i = 0; i < S.queueLine.length; i++) {
      const e = S.queueLine[i];
      if (e.isP) continue;
      const isSel = S.selectedRef && S.selectedRef.kind === 'char' && S.selectedRef.ent === e;
      html += `<div class="hier-item ${isSel ? 'sel' : ''}" data-hkind="char" data-hid="${e.id}"><span>🧍 #${i + 1} ${e.name}</span><small>Очередь</small></div>`;
    }
  }

  // Предметы, оружие и переносимых контейнеры в мире
  if (filter === 'all' || filter === 'items') {
    for (let i = S.worldItems.length - 1; i >= 0; i--) {
      const wi = S.worldItems[i];
      const isSel = S.selectedRef && S.selectedRef.kind === 'world_item' && S.selectedRef.worldEntry === wi;
      const ico = wi.item.icon || (wi.item.holdMode === 'carried' ? '📦' : '🗡️');
      const sub = wi.item.holdMode === 'carried' ? '2 руки' : wi.item.useType;
      html += `<div class="hier-item ${isSel ? 'sel' : ''}" data-hkind="world_item" data-hid="${wi.id}"><span>${ico} ${wi.item.name}</span><small>${sub}</small></div>`;
    }
  }

  if (filter !== 'items') {
    for (let i = S.allBlocks.length - 1; i >= 0; i--) {
      const b = S.allBlocks[i];
      if (filter === 'chars') continue;
      const hasLogic = b.logicData && (b.logicData.trigger !== 'none' || !!b.logicData.tag);
      if (filter === 'logic' && !hasLogic) continue;
      if (filter === 'checkpoints' && (!b.checkpointData || !b.checkpointData.enabled)) continue;
      if (filter === 'clouds' && b.matterState !== 'gas') continue;
      if (filter === 'blocks' && b.matterState === 'gas') continue;

      const isSel = S.selectedRef && S.selectedRef.kind === 'block' && S.selectedRef.box === b;
      const ico = getBlockHierarchyIcon(b);
      const badgeRight = b.logicData && b.logicData.tag
        ? `#${b.logicData.tag}`
        : (b.logicData && b.logicData.targetTag ? `→#${b.logicData.targetTag}` : b.matterState);

      html += `<div class="hier-item ${isSel ? 'sel' : ''}" data-hkind="block" data-hid="${b.id}"><span>${ico} ${b.label}</span><small>${badgeRight}</small></div>`;
    }
  }

  cont.innerHTML = html;
  cont.querySelectorAll('.hier-item').forEach(el => {
    el.onclick = () => {
      const kind = el.dataset.hkind;
      const hid = el.dataset.hid;
      if (kind === 'block') {
        const box = S.allBlocks.find(b => b.id === hid);
        if (box) {
          selectEditorObject({ kind: 'block', box });
          focusOnSelected();
        }
      } else if (kind === 'world_item') {
        const worldEntry = S.worldItems.find(w => w.id === hid);
        if (worldEntry) {
          selectEditorObject({
            kind: 'world_item',
            worldEntry,
            item: worldEntry.item,
            editMode: 'part',
            partIdx: 0
          });
        }
      } else {
        const ent = hid === 'player'
          ? S.player
          : (hid === 'archangel'
              ? S.archangelEnt
              : (S.customNPCs.find(n => n.id === hid) || S.queueLine.find(n => n.id === hid)));
        if (ent) {
          selectEditorObject({ kind: 'char', ent });
          focusOnSelected();
        }
      }
    };
  });
}

function findLatestDoorTag() {
  for (let i = S.allBlocks.length - 1; i >= 0; i--) {
    const b = S.allBlocks[i];
    if (b.logicData && b.logicData.tag && (b.logicData.action === 'door_slide' || b.logicData.action === 'door_ghost')) {
      return b.logicData.tag;
    }
  }
  return 'door_1';
}

export function initHierarchyAndSpawn() {
  $('hierFilter').onchange = refreshHierarchyUI;

  document.querySelectorAll('.spawn-card').forEach(card => {
    card.addEventListener('click', () => {
      const st = card.dataset.spawn;
      const isItemSpawn = !!(st && st.startsWith('item_'));

      // Если мы были в 3D STUDIO и спавним обычный блок/NPC — сначала закрываем 3D STUDIO, чтобы заспавнить на карте
      if (S.itemStudioOpen && !isItemSpawn) {
        closeItemStudio3D(false);
      }

      pushUndoState('Спавн объекта');

      let sp;
      if (S.itemStudioOpen && S.player) {
        sp = new THREE.Vector3(
          Math.round((S.player.x + 2.2) * 2) / 2,
          Math.max(1.0, Math.round((S.player.y + 0.5) * 2) / 2),
          Math.round(S.player.z * 2) / 2
        );
      } else {
        const fwd = new THREE.Vector3(
          -Math.sin(S.edYaw) * Math.cos(S.edPitch),
          Math.sin(S.edPitch),
          -Math.cos(S.edYaw) * Math.cos(S.edPitch)
        );
        sp = S.edCamPos.clone().addScaledVector(fwd, 8);
        sp.x = Math.round(sp.x * 2) / 2;
        sp.y = Math.max(1.0, Math.round(sp.y * 2) / 2);
        sp.z = Math.round(sp.z * 2) / 2;
      }

      if (st === 'npc') {
        const npc = spawnCustomNPC({ x: sp.x, y: sp.y, z: sp.z });
        selectEditorObject({ kind: 'char', ent: npc });
        sfx.coil();
        showBanner('🤖 Заспавнен новый NPC! Настрой его части тела, здоровье и косметику справа.', '#00e676');
        return;
      }

      // Спавн предметов, оружия и переносимых контейнеров прямо в мир на карту
      if (isItemSpawn) {
        const presetKey = st.replace('item_', '');
        const itemData = createStarterItemTemplate(presetKey);
        const worldEntry = spawnWorldItem(itemData, sp.x, sp.y + 0.5, sp.z);
        // Выбираем созданный предмет в режиме размещения на карте (inWorldPlacement: true),
        // чтобы игрок мог сразу подвинуть его стрелками Гизмо, не улетая в 3D STUDIO
        selectEditorObject({
          kind: 'world_item',
          worldEntry,
          item: worldEntry.item,
          editMode: 'root',
          partIdx: 0,
          inWorldPlacement: true
        });
        sfx.coil();
        showBanner(`${itemData.icon} Создан «${itemData.name}»! Двигай стрелками Гизмо или нажми «🛠️ Открыть в 3D STUDIO» в инспекторе.`, '#00e676');
        return;
      }

      let box;
      if (st === 'solid') {
        box = addSceneBlock({
          x: sp.x, y: sp.y, z: sp.z,
          w: 4, h: 1, d: 4,
          colorHex: '#56f0ff',
          matterState: 'solid',
          label: 'Лего-Блок',
          isCustom: true
        });
      } else if (st === 'liquid') {
        box = addSceneBlock({
          x: sp.x, y: sp.y, z: sp.z,
          w: 6, h: 3.5, d: 6,
          colorHex: '#00a8ff',
          matterState: 'liquid',
          label: 'Бассейн Воды',
          isCustom: true
        });
      } else if (st === 'gas') {
        box = addSceneBlock({
          x: sp.x, y: sp.y, z: sp.z,
          w: 8, h: 2.5, d: 6,
          colorHex: '#ffffff',
          matterState: 'gas',
          label: 'Пушистое Облако',
          isCustom: true
        });
      } else if (st === 'checkpoint') {
        const nextStg = S.allBlocks.filter(b => b.checkpointData && b.checkpointData.enabled).length + 1;
        box = addCheckpointBlock(sp.x, sp.y, sp.z, nextStg, `Чекпоинт #${nextStg}`, 50, 2);
        box.isCustom = true;
      } else if (st === 'door') {
        const doorNum = S.allBlocks.filter(b => b.logicData && b.logicData.tag && b.logicData.tag.startsWith('door_')).length + 1;
        const doorTag = `door_${doorNum}`;
        box = addSceneBlock({
          x: sp.x, y: sp.y + 2.5, z: sp.z,
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
        rebuildPhysicsArrays();
        selectEditorObject({ kind: 'block', box });
        sfx.gate();
        showBanner(`🚪 Создана Дверь (тег #${doorTag})! Открывается на [E] или от кнопки с целью #${doorTag}.`, '#00e676');
        return;
      } else if (st === 'button') {
        const targetDoor = findLatestDoorTag();
        box = addSceneBlock({
          x: sp.x, y: sp.y, z: sp.z,
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
        rebuildPhysicsArrays();
        selectEditorObject({ kind: 'block', box });
        sfx.coil();
        showBanner(`🔘 Создана Кнопка [E]! Она управляет объектом с тегом #${targetDoor}.`, '#56f0ff');
        return;
      } else if (st === 'plate') {
        const targetDoor = findLatestDoorTag();
        box = addSceneBlock({
          x: sp.x, y: sp.y - 0.3, z: sp.z,
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
        rebuildPhysicsArrays();
        selectEditorObject({ kind: 'block', box });
        sfx.jump();
        showBanner(`👟 Создана Нажимная Плита! Наступи на неё в игре, чтобы открыть #${targetDoor}.`, '#00e676');
        return;
      } else if (st === 'teleport') {
        const tpPairNum = Math.floor(S.allBlocks.filter(b => b.logicData && b.logicData.action === 'teleport').length / 2) + 1;
        const tagA = `tp_${tpPairNum}_A`;
        const tagB = `tp_${tpPairNum}_B`;

        const padA = addSceneBlock({
          x: sp.x - 4, y: sp.y, z: sp.z,
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
          x: sp.x + 6, y: sp.y, z: sp.z,
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

        rebuildPhysicsArrays();
        selectEditorObject({ kind: 'block', box: padA });
        sfx.checkpoint();
        showBanner(`🌀 Создана пара связанных Телепортов (#${tagA} ⇄ #${tagB})!`, '#56f0ff');
        return;
      } else if (st === 'vip_gate') {
        box = addSceneBlock({
          x: sp.x, y: sp.y + 2.5, z: sp.z,
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
        rebuildPhysicsArrays();
        selectEditorObject({ kind: 'block', box });
        sfx.cash();
        showBanner('🔓 Созданы платные VIP-Ворота (100 R$)!', '#ffce3a');
        return;
      } else if (st === 'shop_pad') {
        box = addSceneBlock({
          x: sp.x, y: sp.y, z: sp.z,
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
        rebuildPhysicsArrays();
        selectEditorObject({ kind: 'block', box });
        sfx.cash();
        showBanner('🛒 Создан Магазин за R$!', '#00e676');
        return;
      } else if (st === 'kill') {
        box = addSceneBlock({
          x: sp.x, y: sp.y, z: sp.z,
          w: 4.6, h: 0.4, d: 0.8,
          colorHex: '#ff1e1e',
          damageOnContact: 35,
          teleportToCheckpoint: false,
          label: 'Урон-Лазер',
          isCustom: true
        });
      } else if (st === 'trampoline') {
        box = addSceneBlock({
          x: sp.x, y: sp.y, z: sp.z,
          w: 4, h: 0.8, d: 4,
          colorHex: '#00e676',
          bounciness: 16,
          label: 'Прыгучий Батут',
          isCustom: true
        });
      } else if (st === 'spawner') {
        box = addSceneBlock({
          x: sp.x, y: sp.y, z: sp.z,
          w: 3.5, h: 0.8, d: 3.5,
          colorHex: '#9b59b6',
          gold: true,
          label: 'Спавнер Объектов',
          spawnerData: { mode: 'timer', interval: 5, timer: 2, spawnType: 'coin' },
          isCustom: true
        });
      }

      if (box) {
        rebuildPhysicsArrays();
        selectEditorObject({ kind: 'block', box });
        sfx.jump();
        showBanner(`✨ Создан объект «${box.label}»!`, '#00e676');
      }
    });
  });
}
