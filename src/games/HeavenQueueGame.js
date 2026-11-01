// src/games/HeavenQueueGame.js
import {
  S,
  $,
  clamp,
  rnd,
  pick,
  TOTAL_SPOTS,
  PRESETS,
  NPC_NAMES,
  CHAT_LINES,
  showBanner
} from '../core/State.js';
import { cv, scene } from '../core/SceneManager.js';
import { sfx } from '../core/AudioEngine.js';
import {
  createRobloxRig,
  makeTagSprite,
  updateTag,
  updateEntityAnimation
} from '../core/CharacterRig.js';
import {
  clearWorld,
  addSceneBlock,
  addCheckpointBlock,
  rebuildPhysicsArrays
} from '../core/WorldRegistry.js';
import {
  clearEntities,
  attachRigToEntity,
  refreshEntityTagWithHP,
  updateShopUI,
  selectSlot
} from '../core/EntityManager.js';
import { dealDamage, performPlayerMeleeAttack } from '../player/PhysicsAndCombat.js';

let uiEventsBound = false;

export function buildHeavenQueueWorld() {
  clearWorld();

  // 1. Spawn Cloud Lobby
  addSceneBlock({
    x: 0,
    y: 0,
    z: 8,
    w: 28,
    h: 2,
    d: 18,
    colorHex: '#ecf5ff',
    label: 'Спавн-Лобби Облако'
  });

  // Editable Decorative Gas Clouds
  for (let i = 0; i < 24; i++) {
    addSceneBlock({
      x: rnd(-85, 85),
      y: rnd(-10, 30),
      z: rnd(-130, 28),
      w: rnd(8, 18),
      h: rnd(2, 4),
      d: rnd(6, 14),
      colorHex: '#ffffff',
      matterState: 'gas',
      label: `Небесное Облако #${i + 1}`
    });
  }

  // 2. Winding Golden Queue Staircase (#30 at bottom up to #1 at the Pearly Gates)
  S.queueCoords = new Array(TOTAL_SPOTS);
  for (let i = 0; i < TOTAL_SPOTS; i++) {
    const fromBottom = TOTAL_SPOTS - 1 - i;
    const y = 0.2 + fromBottom * 0.55;
    const z = -2 - fromBottom * 3.1;
    const x = Math.sin(fromBottom * 0.35) * 3.2;
    S.queueCoords[i] = { x, y, z };

    const isTop = i === 0;
    const padCol = isTop ? '#ffe64c' : i % 2 === 0 ? '#f8fbff' : '#dff2ff';
    addSceneBlock({
      x,
      y,
      z,
      w: 5.2,
      h: 0.6,
      d: 2.9,
      colorHex: padCol,
      gold: isTop,
      label: `Ступень Очереди #${i + 1}`
    });
  }

  // 3. The Pearly Gates & VIP Heaven Sanctuary at the top
  const topSpot = S.queueCoords[0];
  const gx = topSpot.x;
  const gy = topSpot.y;
  const gz = topSpot.z - 9;
  addSceneBlock({
    x: gx,
    y: gy,
    z: gz,
    w: 26,
    h: 1.5,
    d: 16,
    colorHex: '#fff5c0',
    gold: true,
    label: 'Остров VIP Рая'
  });

  for (const sx of [-4.5, 4.5]) {
    addSceneBlock({
      x: gx + sx,
      y: gy + 9,
      z: gz + 5,
      w: 1.6,
      h: 9,
      d: 1.6,
      colorHex: '#ffd24c',
      gold: true,
      label: 'Колонна Врат Рая'
    });
  }
  addSceneBlock({
    x: gx,
    y: gy + 10.2,
    z: gz + 5,
    w: 11.5,
    h: 1.4,
    d: 2.0,
    colorHex: '#ffd24c',
    gold: true,
    label: 'Арка Врат Рая'
  });
  addSceneBlock({
    x: gx,
    y: gy + 8.5,
    z: gz + 5,
    w: 7.2,
    h: 8.5,
    d: 0.25,
    colorHex: '#88ffff',
    matterState: 'gas',
    lightData: {
      mode: 'point',
      color: '#88ffff',
      intensity: 2.2,
      distance: 24,
      pulseSpeed: 1.5
    },
    label: 'Сияющий Портал Рая'
  });

  // 4. Parallel 5-Stage Sky Obby
  addSceneBlock({
    x: 12,
    y: 0,
    z: 6,
    w: 12,
    h: 1,
    d: 4,
    colorHex: '#55efc4',
    label: 'Мост на Обби'
  });

  let oz = 2;
  let oy = 0.5;
  const ox = 20;
  addCheckpointBlock(ox, oy, oz, 1, 'Этап 1: Радужные Прыжки', 30, 2);
  for (let k = 1; k <= 6; k++) {
    oz -= 4.4;
    oy += 0.5;
    const col = ['#ff6b6b', '#ffbe76', '#f6e58d', '#badc58', '#7ed6df', '#e056fd'][k - 1];
    addSceneBlock({
      x: ox + Math.sin(k) * 2.2,
      y: oy,
      z: oz,
      w: 3.2,
      h: 0.7,
      d: 3.0,
      colorHex: col,
      label: `Радужная Платформа #${k}`
    });
  }

  oz -= 5.0;
  oy += 0.5;
  addCheckpointBlock(ox, oy, oz, 2, 'Этап 2: Неоновые Лазеры', 55, 3);
  oz -= 11;
  addSceneBlock({
    x: ox,
    y: oy,
    z: oz,
    w: 4.6,
    h: 0.7,
    d: 18,
    colorHex: '#dfe6e9',
    label: 'Мост Лазеров'
  });
  for (let k = -6; k <= 6; k += 3.2) {
    addSceneBlock({
      x: ox,
      y: oy + 0.32,
      z: oz + k,
      w: 4.6,
      h: 0.28,
      d: 0.45,
      colorHex: '#ff1e1e',
      damageOnContact: 50,
      teleportToCheckpoint: true,
      lightData: {
        mode: 'visual',
        color: '#ff1e1e',
        intensity: 1.5,
        distance: 10,
        pulseSpeed: 0
      },
      label: 'Неоновый Лазер'
    });
  }

  oz -= 12;
  addCheckpointBlock(ox, oy, oz, 3, 'Этап 3: Турбо-Конвейер и Батуты', 85, 4);
  oz -= 10;
  addSceneBlock({
    x: ox,
    y: oy,
    z: oz,
    w: 4.5,
    h: 0.7,
    d: 14,
    colorHex: '#34495e',
    conveyorVz: 4.2,
    label: 'Турбо-Конвейер'
  });
  oz -= 10;
  for (let k = 0; k < 3; k++) {
    addSceneBlock({
      x: ox + (k % 2 ? 2.2 : -2.2),
      y: oy + k * 3.2,
      z: oz - k * 6.5,
      w: 3.6,
      h: 0.7,
      d: 3.6,
      colorHex: '#00e676',
      bounciness: 15.5,
      label: `Батут #${k + 1}`
    });
  }

  oy += 9.5;
  oz -= 19;
  addCheckpointBlock(ox, oy, oz, 4, 'Этап 4: Вращающиеся Балки', 120, 5);
  for (let k = 1; k <= 3; k++) {
    const pz = oz - k * 7.2;
    addSceneBlock({
      x: ox,
      y: oy,
      z: pz,
      w: 5.2,
      h: 0.7,
      d: 5.2,
      colorHex: '#74b9ff',
      label: `Арена Балки #${k}`
    });
    addSceneBlock({
      x: ox,
      y: oy + 0.75,
      z: pz,
      w: 5.6,
      h: 0.45,
      d: 0.45,
      colorHex: '#ff2a55',
      spinSpeed: k % 2 ? 2.3 : -2.6,
      damageOnContact: 40,
      teleportToCheckpoint: true,
      lightData: {
        mode: 'visual',
        color: '#ff2a55',
        intensity: 1.3,
        distance: 10,
        pulseSpeed: 0
      },
      label: `Вращающаяся Балка #${k}`
    });
  }

  oz -= 28;
  oy += 1.2;
  addCheckpointBlock(ox, oy, oz, 5, 'ФИНИШ ОББИ: Мега-Касса и +6 Мест!', 220, 6);

  rebuildPhysicsArrays();
}

export function initQueueAndPlayer() {
  clearEntities();

  const topSpot = S.queueCoords[0] || { x: 0, y: 16, z: -90 };
  const angelPreset = {
    head: 0xfff3d6,
    torso: 0xffffff,
    armL: 0xfff3d6,
    armR: 0xfff3d6,
    legL: 0xf4d068,
    legR: 0xf4d068,
    halo: true,
    wings: true,
    customCosmetics: []
  };
  const angelRig = createRobloxRig(angelPreset, 1.35, true);
  const angelTag = makeTagSprite(320, 105, 3.5, 1.15);
  const ax = topSpot.x - 3.4;
  const ay = topSpot.y;
  const az = topSpot.z - 1.6;
  angelRig.g.position.set(ax, ay, az);
  angelRig.g.rotation.y = 0.45;
  scene.add(angelRig.g, angelTag);

  S.archangelEnt = {
    id: 'archangel',
    isP: false,
    isCustomNPC: true,
    isArchangel: true,
    name: 'АРХАНГЕЛ ПЁТР',
    chat: 'Проходим по одному!',
    wander: false,
    aggressive: false,
    hpEnabled: false,
    hp: 500,
    maxHp: 500,
    hpBarTimer: 0,
    meleeDamage: 50,
    x: ax,
    y: ay,
    z: az,
    homeX: ax,
    homeZ: az,
    rot: 0.45,
    step: 0,
    rig: angelRig,
    tag: angelTag,
    preset: angelPreset
  };
  attachRigToEntity(S.archangelEnt);
  updateTag(angelTag, '👑 СУДЬЯ', S.archangelEnt.name, S.archangelEnt.chat, false);
  angelTag.position.set(ax, ay + 4.5, az);

  for (let i = 0; i < TOTAL_SPOTS; i++) {
    const isP = i === TOTAL_SPOTS - 1;
    const basePreset = isP
      ? {
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
        }
      : Object.assign({ limbTex: {}, customCosmetics: [] }, pick(PRESETS));

    const rig = createRobloxRig(basePreset, 1, false);
    const tag = makeTagSprite(280, 105, 3.0, 1.1);
    const sp = S.queueCoords[i] || { x: 0, y: 1, z: 8 };
    rig.g.position.set(sp.x, sp.y, sp.z);
    scene.add(rig.g, tag);

    const ent = {
      id: isP ? 'player' : 'qnpc_' + i,
      isP,
      isCustomNPC: false,
      name: isP ? 'ТЫ (Игрок)' : NPC_NAMES[i % NPC_NAMES.length],
      qIdx: i,
      x: sp.x,
      y: sp.y,
      z: sp.z,
      vxKnock: 0,
      vzKnock: 0,
      vy: 0,
      rot: Math.PI,
      grounded: true,
      inLiquid: false,
      hpEnabled: true,
      hp: 100,
      maxHp: 100,
      hpBarTimer: 0,
      meleeDamage: isP ? 25 : 12,
      aggressive: false,
      attackCooldown: 0,
      colliderRadius: 0.42,
      colliderHeight: 2.5,
      walkSpeed: 7.6,
      jumpPower: 10.2,
      rig,
      tag,
      chat: '',
      chatT: rnd(2, 12),
      step: 0,
      preset: basePreset
    };
    attachRigToEntity(ent);

    if (isP) {
      S.player = Object.assign(ent, {
        cash: 25,
        rebirths: 0,
        hasSpeed: false,
        hasGrav: false,
        hasHalo: false,
        bestObby: 0,
        inHeaven: false,
        respawnX: sp.x,
        respawnY: sp.y,
        respawnZ: sp.z
      });
    }
    S.queueLine.push(ent);
  }
  refreshQueueTags();
}

export function refreshQueueTags() {
  for (let i = 0; i < S.queueLine.length; i++) {
    const e = S.queueLine[i];
    e.qIdx = i;
    refreshEntityTagWithHP(e);
  }
  if (!S.player || S.queueLine.length === 0) return;

  const lb = $('lbList');
  if (lb) {
    let html = '';
    const showIdx = [0, 1, 2, 3, S.player.qIdx - 1, S.player.qIdx, S.player.qIdx + 1]
      .filter((v, idx, a) => v >= 0 && v < S.queueLine.length && a.indexOf(v) === idx)
      .sort((a, b) => a - b)
      .slice(0, 7);

    for (const idx of showIdx) {
      const e = S.queueLine[idx];
      html += `<div class="lb-row ${e.isP ? 'me' : ''}"><span>#${idx + 1} ${e.name.slice(0, 11)}</span><span>${e.isP ? S.player.cash + ' R$' : (TOTAL_SPOTS - idx) * 15 + ' R$'}</span></div>`;
    }
    lb.innerHTML = html;
  }
  if ($('posTxt')) {
    $('posTxt').textContent = S.player.inHeaven ? 'В РАЮ! 👑' : `#${S.player.qIdx + 1} / ${TOTAL_SPOTS}`;
  }
}

export function movePlayerInQueue(deltaSpots) {
  const player = S.player;
  if (!player || S.queueLine.length === 0) return;
  const oldIdx = player.qIdx;
  const newIdx = clamp(oldIdx + deltaSpots, 0, TOTAL_SPOTS - 1);
  if (newIdx === oldIdx) return;
  S.queueLine.splice(oldIdx, 1);
  S.queueLine.splice(newIdx, 0, player);
  refreshQueueTags();

  const sp = S.queueCoords[player.qIdx];
  if (sp && Math.hypot(player.x - sp.x, player.z - sp.z) < 10) {
    player.x = sp.x;
    player.y = sp.y + 0.5;
    player.z = sp.z;
  }
}

export function cutCost() {
  if (!S.player) return 15;
  return Math.max(15, Math.round((TOTAL_SPOTS - S.player.qIdx) * 12));
}

export function tryCutInLine() {
  if (S.state !== 'play' || !S.player) return;
  const player = S.player;

  if (player.qIdx === 0) {
    enterHeaven();
    return;
  }
  const cost = cutCost();
  if (player.cash < cost) {
    sfx.oof();
    showBanner(`Не хватает Карма-Робуксов! Нужно ${cost} R$ (пройди Обби справа!)`, '#ff3e3e');
    return;
  }
  player.cash -= cost;
  sfx.cash();
  movePlayerInQueue(-1);
  const sp = S.queueCoords[player.qIdx];
  if (sp) {
    player.x = sp.x;
    player.y = sp.y + 0.4;
    player.z = sp.z;
  }
  showBanner(`⏩ Ты обогнал впереди стоящего! Теперь ты #${player.qIdx + 1} в очереди`, '#00e676');
  updateShopUI();
}

export function tryPushInLine() {
  if (S.state !== 'play' || !S.player || S.queueCoords.length === 0) return;
  const player = S.player;
  if (player.qIdx === 0) {
    enterHeaven();
    return;
  }
  const sp = S.queueCoords[player.qIdx];
  if (!sp || Math.hypot(player.x - sp.x, player.z - sp.z) > 6.5) {
    return;
  }

  if (S.eyeWatching && !player.hasHalo) {
    sfx.zap();
    dealDamage(player, 30, S.archangelEnt);
    movePlayerInQueue(+4);
    const backSp = S.queueCoords[player.qIdx];
    if (backSp) {
      player.x = backSp.x;
      player.y = backSp.y + 2.5;
      player.z = backSp.z;
    }
    showBanner('⚡ АРХАНГЕЛ ЗАМЕТИЛ ТОЛЧОК! Молния отбросила тебя на 4 места назад!', '#ff3e3e');
    return;
  }

  const victim = S.queueLine[player.qIdx - 1];
  if (victim) {
    victim.chat = 'АЙ!! За что столкнул?! 😭';
    victim.chatT = 3.5;
    dealDamage(victim, player.meleeDamage || 25, player);
  }
  movePlayerInQueue(-1);
  const nextSp = S.queueCoords[player.qIdx];
  if (nextSp) {
    player.x = nextSp.x;
    player.y = nextSp.y + 0.3;
    player.z = nextSp.z;
  }
  player.cash += 10 * (player.hasHalo ? 2 : 1);
  showBanner(`🥊 Бум! Ты вытолкнул игрока и занял место #${player.qIdx + 1}!`, '#00e676');
  updateShopUI();
}

export function advanceQueueFront() {
  const player = S.player;
  if (!player || player.inHeaven || S.queueLine.length === 0) return;
  if (player.qIdx === 0) {
    showBanner('👑 ТЫ ПЕРВЫЙ (#1)! Шагни в сияющие Врата Рая или нажми E!', '#ffce3a');
    return;
  }
  const frontNPC = S.queueLine.shift();
  const approved = Math.random() < 0.72;
  if (S.archangelEnt) {
    S.archangelEnt.chat = approved
      ? `${frontNPC.name} принят в Рай! 😇`
      : `${frontNPC.name} отправлен вниз! 💀`;
    refreshEntityTagWithHP(S.archangelEnt);
  }
  frontNPC.name = pick(NPC_NAMES);
  frontNPC.hp = frontNPC.maxHp;
  frontNPC.chat = 'Опять в конец очереди...';
  frontNPC.chatT = 4;
  const backSp = S.queueCoords[TOTAL_SPOTS - 1];
  if (backSp) {
    frontNPC.x = backSp.x;
    frontNPC.y = backSp.y;
    frontNPC.z = backSp.z;
  }
  S.queueLine.push(frontNPC);
  refreshQueueTags();

  const gain = (3 + player.rebirths * 2) * (player.hasHalo ? 2 : 1);
  player.cash += gain;
  const oldSp = S.queueCoords[player.qIdx + 1];
  const newSp = S.queueCoords[player.qIdx];
  if (oldSp && newSp && Math.hypot(player.x - oldSp.x, player.z - oldSp.z) < 3.6) {
    player.x = newSp.x;
    player.y = newSp.y;
    player.z = newSp.z;
  }
  updateShopUI();
}

export function enterHeaven() {
  const player = S.player;
  if (!player || player.inHeaven) return;
  player.inHeaven = true;
  sfx.gate();
  player.rig.wings.visible = true;
  player.rig.halo.visible = true;
  const topSpot = S.queueCoords[0] || { x: 0, y: 16, z: -90 };
  player.x = topSpot.x;
  player.y = topSpot.y + 1.2;
  player.z = topSpot.z - 10;
  player.cash += 500 * (player.rebirths + 1);
  player.rebirths++;
  $('rebTxt').textContent = player.rebirths;
  updateShopUI();

  try {
    if (document.pointerLockElement === cv) document.exitPointerLock();
  } catch (_) {}

  $('modalBox').innerHTML = `
    <span class="badge" style="background:#00b06f">ТЫ ПРОШЁЛ СУД АРХАНГЕЛА!</span>
    <h1>ДОБРО ПОЖАЛОВАТЬ В <span>VIP РАЙ!</span> 😇</h1>
    <p style="font-weight:700;color:#d8e6ff;line-height:1.5">Ты дошёл до Места #1, прошёл сквозь Жемчужные Врата и получил Золотые Крылья Ангела, +500 R$ и Перерождение #${player.rebirths}!</p>
    <div style="display:flex;gap:10px;margin-top:18px;flex-wrap:wrap">
      <button class="play-btn" id="keepPlayBtn" type="button" style="flex:1">👑 ГУЛЯТЬ В РАЮ</button>
      <button class="play-btn" id="rebirthBtn" type="button" style="flex:1;background:linear-gradient(180deg,#ffce3a,#e09b00);color:#111;box-shadow:0 5px 0 #996500">🔄 НОВАЯ ОЧЕРЕДЬ (x${player.rebirths + 1} ДОХОД)</button>
    </div>
  `;
  $('menu').hidden = false;

  $('keepPlayBtn').onclick = () => {
    $('menu').hidden = true;
    showBanner('👑 Ты в VIP-Раю! Открой 3D Редактор (F2), чтобы строить свой мир!', '#ffce3a');
  };
  $('rebirthBtn').onclick = () => {
    $('menu').hidden = true;
    player.inHeaven = false;
    player.bestObby = 0;
    movePlayerInQueue(TOTAL_SPOTS);
    teleportToQueueSpot();
    showBanner(`🔄 Перерождение #${player.rebirths}! Доход повышен!`, '#00e676');
  };
}

export function teleportToQueueSpot() {
  const player = S.player;
  if (!player || S.queueCoords.length === 0) return;
  const sp = S.queueCoords[player.qIdx];
  if (!sp) return;
  player.x = sp.x;
  player.y = sp.y + 0.8;
  player.z = sp.z;
  player.vy = 0;
  sfx.coil();
  showBanner(`☁️ Телепорт на твоё место в очереди (#${player.qIdx + 1})`, '#56f0ff');
}

function bindQueueShopEventsOnce() {
  if (uiEventsBound) return;
  uiEventsBound = true;

  $('btnCut').addEventListener('click', () => {
    if (S.gameMode && S.gameMode.onActionKeyE) S.gameMode.onActionKeyE();
  });
  $('btnPush').addEventListener('click', () => performPlayerMeleeAttack(true));
  $('bCut').addEventListener('pointerdown', e => {
    e.preventDefault();
    if (S.gameMode && S.gameMode.onActionKeyE) S.gameMode.onActionKeyE();
  });
  $('bPush').addEventListener('pointerdown', e => {
    e.preventDefault();
    performPlayerMeleeAttack(true);
  });

  $('buySpeed').addEventListener('click', () => {
    const player = S.player;
    if (!player || player.hasSpeed) return;
    if (player.cash < 80) {
      sfx.oof();
      showBanner('Нужно 80 R$ для Пружины Скорости!', '#ff3e3e');
      return;
    }
    player.cash -= 80;
    player.hasSpeed = true;
    selectSlot(1);
    sfx.coil();
    updateShopUI();
    showBanner('🌀 Куплена Пружина Скорости (Speed Coil)!', '#00e676');
  });

  $('buyGrav').addEventListener('click', () => {
    const player = S.player;
    if (!player || player.hasGrav) return;
    if (player.cash < 120) {
      sfx.oof();
      showBanner('Нужно 120 R$ для Пружины Прыжка!', '#ff3e3e');
      return;
    }
    player.cash -= 120;
    player.hasGrav = true;
    selectSlot(2);
    sfx.coil();
    updateShopUI();
    showBanner('🚀 Куплена Пружина Прыжка (Gravity Coil)!', '#00e676');
  });

  $('buyHalo').addEventListener('click', () => {
    const player = S.player;
    if (!player || player.hasHalo) return;
    if (player.cash < 250) {
      sfx.oof();
      showBanner('Нужно 250 R$ для VIP Нимб!', '#ff3e3e');
      return;
    }
    player.cash -= 250;
    player.hasHalo = true;
    player.rig.halo.visible = true;
    sfx.gate();
    updateShopUI();
    showBanner('😇 VIP Нимб активирован! x2 R$ и иммунитет к молнии Петра!', '#ffce3a');
  });

  document.querySelectorAll('#hotbar .slot').forEach(el => {
    el.addEventListener('click', () => selectSlot(+el.dataset.slot));
  });
}

// Экспорт картриджа игры "Очередь в Рай + Обби"
export const HeavenQueueGame = {
  id: 'heaven_queue',
  title: 'Очередь в Рай + Обби',

  init() {
    bindQueueShopEventsOnce();
    buildHeavenQueueWorld();
    initQueueAndPlayer();
    this.syncModeUI(true);
    updateShopUI();
  },

  syncModeUI(visible) {
    const posPill = $('posTxt') ? $('posTxt').closest('.pill') : null;
    if (posPill) posPill.hidden = !visible;
    if ($('eyePill')) $('eyePill').hidden = !visible;
    if ($('leader')) $('leader').hidden = !visible;
    if ($('shopPanel')) $('shopPanel').hidden = !visible || S.state !== 'play';
    if ($('bCut')) $('bCut').hidden = !visible;
  },

  onEnterPlay() {
    this.syncModeUI(true);
    showBanner('😇 Стой в очереди, бей и толкай ботов (ЛКМ / F), проходи Обби или открой 3D Редактор (F2)!');
  },

  onUpdateHUD() {
    const player = S.player;
    if (!player) return;
    if ($('costCut')) $('costCut').textContent = player.qIdx === 0 ? 'В РАЙ!' : `${cutCost()} R$`;
    if (player.hasSpeed) {
      $('buySpeed').classList.add('owned');
      $('costSpeed').textContent = 'КУПЛЕНО';
    }
    if (player.hasGrav) {
      $('buyGrav').classList.add('owned');
      $('costGrav').textContent = 'КУПЛЕНО';
    }
    if (player.hasHalo) {
      $('buyHalo').classList.add('owned');
      $('costHalo').textContent = 'КУПЛЕНО';
    }
    refreshQueueTags();
  },

  onSelectSlot(idx) {
    if (idx === 3) {
      teleportToQueueSpot();
      setTimeout(() => selectSlot(0), 250);
      return true;
    }
    return false;
  },

  onActionKeyE() {
    tryCutInLine();
  },

  onMeleeAttack(isQueuePushKey, hitAnyone) {
    const player = S.player;
    if (!player || S.queueCoords.length === 0) return;
    const sp = S.queueCoords[player.qIdx];
    if (isQueuePushKey || (sp && Math.hypot(player.x - sp.x, player.z - sp.z) < 4.5 && !hitAnyone)) {
      tryPushInLine();
    }
  },

  onEntityKnockout(target) {
    if (S.player && !target.isCustomNPC && target.qIdx === S.player.qIdx - 1) {
      movePlayerInQueue(-1);
      showBanner(`🥊 Ты нокаутировал ${target.name} и занял место #${S.player.qIdx + 1}!`, '#00e676');
    }
  },

  onCheckpointReached(cd, earned) {
    if (cd.skipSpots > 0) movePlayerInQueue(-cd.skipSpots);
    updateShopUI();
    showBanner(`⭐ ${cd.title}! +${earned} R$ и -${cd.skipSpots} мест в очереди!`, '#00e676');
    if (cd.stage === 5) {
      setTimeout(() => {
        if (S.player) S.player.bestObby = 0;
        teleportToQueueSpot();
      }, 1100);
    }
  },

  getRespawnPoint(player) {
    if (player.bestObby > 0) {
      return { x: player.respawnX, y: player.respawnY + 1, z: player.respawnZ };
    }
    const sp = S.queueCoords[player.qIdx] || { x: 0, y: 1, z: 8 };
    return { x: sp.x, y: sp.y + 1, z: sp.z };
  },

  getExtraTargets() {
    const targets = [...S.queueLine.filter(e => !e.isP)];
    if (S.archangelEnt) targets.push(S.archangelEnt);
    return targets;
  },

  onUpdate(dt, moveLen) {
    const p = S.player;
    if (!p) return;

    // 1. Таймер Всевидящего Ока Архангела
    S.eyeTimer -= dt;
    if (S.eyeTimer <= 0) {
      S.eyeWatching = !S.eyeWatching;
      S.eyeTimer = S.eyeWatching ? rnd(2.6, 4.0) : rnd(4.5, 6.8);
      const pill = $('eyePill');
      if (pill) {
        if (S.eyeWatching) {
          pill.className = 'pill eye-warn';
          pill.textContent = '🚨 АРХАНГЕЛ СМОТРИТ! (НЕ ТОЛКАЙСЯ!)';
          if (S.archangelEnt) S.archangelEnt.rig.g.rotation.y = 0.1;
        } else {
          pill.className = 'pill eye-safe';
          pill.textContent = '👁️ АРХАНГЕЛ ОТВЕРНУЛСЯ (МОЖНО ТОЛКАТЬ — F!)';
          if (S.archangelEnt) S.archangelEnt.rig.g.rotation.y = 2.6;
        }
      }
    }

    // 2. Таймер продвижения очереди
    S.judgeTimer -= dt;
    if (S.judgeTimer <= 0) {
      S.judgeTimer = 4.8;
      advanceQueueFront();
    }

    // 3. Проверка входа во Врата Рая на #1 месте
    const topSpot = S.queueCoords[0];
    if (topSpot && p.qIdx === 0 && !p.inHeaven && Math.hypot(p.x - topSpot.x, p.z - (topSpot.z - 4)) < 4.5) {
      enterHeaven();
    }

    // 4. Таймеры полосок HP и суставная анимация Архангела и очереди
    if (S.archangelEnt) {
      if (S.archangelEnt.hpBarTimer > 0) {
        S.archangelEnt.hpBarTimer -= dt;
        if (S.archangelEnt.hpBarTimer <= 0) refreshEntityTagWithHP(S.archangelEnt);
      }
      updateEntityAnimation(S.archangelEnt, dt, {
        moving: false,
        grounded: true,
        inLiquid: false
      });
    }

    for (let i = 0; i < S.queueLine.length; i++) {
      const e = S.queueLine[i];
      if (e.hpBarTimer > 0) {
        e.hpBarTimer -= dt;
        if (e.hpBarTimer <= 0) refreshEntityTagWithHP(e);
      }

      const target = S.queueCoords[i] || { x: e.x, y: e.y, z: e.z };
      let isMoving = false;

      if (!e.isP) {
        const dx = target.x - e.x;
        const dz = target.z - e.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.08) {
          const step = Math.min(d, 5.5 * dt);
          e.x += (dx / d) * step;
          e.z += (dz / d) * step;
          e.y += (target.y - e.y) * Math.min(1, dt * 8);
          e.step += step * 3;
          e.rot = Math.atan2(dx, dz);
          isMoving = true;
        } else {
          e.rot = Math.PI;
        }
        e.chatT -= dt;
        if (e.chatT <= 0) {
          e.chat = Math.random() < 0.35 ? pick(CHAT_LINES) : '';
          e.chatT = e.chat ? rnd(3.5, 5.5) : rnd(4, 10);
          refreshEntityTagWithHP(e);
        }
      } else {
        isMoving = moveLen > 0.1;
      }

      updateEntityAnimation(e, dt, {
        moving: isMoving,
        grounded: e.isP ? e.grounded : true,
        inLiquid: e.isP ? !!e.inLiquid : false
      });

      e.rig.g.position.set(e.x, e.y, e.z);
      e.rig.g.rotation.y = e.rot;
      e.tag.position.set(e.x, e.y + 3.35, e.z);
    }
  },

  getHintText(p) {
    const qSp = S.queueCoords[p.qIdx];
    const nearSpot = qSp && Math.hypot(p.x - qSp.x, p.z - qSp.z) < 4.5;
    if (p.qIdx === 0 && !p.inHeaven) {
      return '👑 ТЫ ПЕРВЫЙ В ОЧЕРЕДИ! Шагни в сияющие Врата Рая или нажми E!';
    }
    if (nearSpot) {
      return `Очередь (#${p.qIdx + 1}) · [ЛКМ] Ударить рукой · [F] Толкнуть · [E] Обогнать (${cutCost()} R$) · [F2] 3D Редактор`;
    }
    return 'Небесное Обби! [ЛКМ] Удар рукой · [Пробел] Прыжок / Плавание · [R] В очередь · [F2] 3D Редактор';
  }
};