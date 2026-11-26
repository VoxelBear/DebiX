// src/core/MultiplayerManager.js
import { S, $, clamp, showBanner } from './State.js';
import { scene, updateSkybox } from './SceneManager.js';
import {
  sfx,
  syncAudioWithWorldSettings,
  setWorldMusic,
  setWorldAmbience
} from './AudioEngine.js';
import {
  createRobloxRig,
  makeTagSprite,
  pushEntityChatBubble,
  syncRigAppearanceFromPreset,
  normalizeCharacterGripPoints,
  normalizeItemData,
  normalizeCosmeticItem,
  createStarterItemTemplate,
  triggerEntityEmote,
  stopEntityEmote,
  triggerEntityAttack,
  updateEntityAnimation
} from './CharacterRig.js';
import {
  attachRigToEntity,
  ensureNpcModules,
  syncEntityHeldItemMesh,
  refreshEntityTagWithHP,
  updateShopUI,
  spawnWorldItem,
  rebuildWorldItemVisual,
  spawnCustomNPC,
  renderHotbarUI
} from './EntityManager.js';
import {
  addSceneBlock,
  removeBlockHalo,
  syncBlockComponentsState,
  rebuildPhysicsArrays
} from './WorldRegistry.js';
import {
  serializeSceneState,
  loadSceneState,
  startPlaySession,
  getProjectsList,
  saveProjectsList
} from './Serializer.js';
import { spawnDamageParticles, spawnDeathShatter } from './ParticleSystem.js';
import {
  getItem3DThumbnail,
  getCosmetic3DThumbnail,
  getPrefab3DThumbnail,
  refreshPrefabDockUI,
  refreshHierarchyUI,
  buildPrefabEntryFromSelected,
  spawnPrefabFromCard
} from '../studio/HierarchyAndSpawn.js';

const NICK_STORAGE_KEY = 'debix_player_nickname_v1';
const ROOM_STORAGE_KEY = 'debix_mp_room_v1';
const WS_URL_STORAGE_KEY = 'debix_mp_ws_url_v1';
const SNAPSHOT_CHUNK_SIZE = 48000; // ~48 KB на чанк для стабильной передачи через WebRTC и WS

const CHAT_EMOJIS = [
  '😀', '😂', '😎', '🥳', '😍', '🤔', '😭', '😡', '😱', '🤡',
  '👍', '👎', '👋', '🙏', '🤝', '💪', '👀', '❤️', '💔', '🔥',
  '⭐', '⚡', '🎉', '💀', '👑', '💎', '🪙', '🗡️', '🔫', '🛡️',
  '💣', '🍗', '🚀', '🌀', '😇', '😈', '🤖', '🐾', '🧱', '🏆'
];

let localChannel = null;
let peerInstance = null;
let peerConnections = new Map(); // peerId -> DataConnection
let wsConnection = null;
let discoveryWs = null;
let syncAccumulator = 0;
let fullSyncAccumulator = 0;
let hostBeaconAccumulator = 0;
let serverDiscoveryTimer = null;

// Реестр найденных активных серверов: roomId -> serverInfo
const discoveredServers = new Map();
let activeLauncherTab = 'worlds'; // 'worlds' | 'servers'

// Буфер сборки входящего слепка карты по чанкам
const incomingSnapshots = new Map(); // transferId -> { chunks: [], received: 0, total: 0, hostName: '' }

// Троттлинг для частых правок объектов в редакторе (Гизмо / ползунки)
const blockSyncThrottleMap = new Map();
const itemSyncThrottleMap = new Map();
const npcSyncThrottleMap = new Map();
let skySyncThrottleTimer = null;
let lastRemoteNpcBatchTime = 0;

// Определяет, является ли текущий клиент авторитетом для расчёта физики и ИИ NPC
export function isLocalNpcAuthority() {
  if (S.mpState.isHost) return true;
  const remKeys = Object.keys(S.remotePlayers || {});
  if (remKeys.length === 0) return true;
  if (performance.now() - lastRemoteNpcBatchTime < 3500) return false;
  const myId = String(S.mpState.peerId || '');
  for (let i = 0; i < remKeys.length; i++) {
    if (String(remKeys[i]) < myId) return false;
  }
  return true;
}

// История сообщений чата
const chatHistory = [];
const MAX_CHAT_HISTORY = 60;

/* ---------- НИКНЕЙМ И ПРОФИЛЬ ИГРОКА ---------- */

export function getSavedPlayerNickname() {
  try {
    const saved = localStorage.getItem(NICK_STORAGE_KEY);
    if (saved && saved.trim()) return saved.trim().slice(0, 20);
  } catch (_) {}
  return 'Player_' + Math.floor(100 + Math.random() * 899);
}

export function setPlayerNickname(newName) {
  const clean = (newName || '').trim().slice(0, 20) || 'Player';
  S.playerName = clean;
  try {
    localStorage.setItem(NICK_STORAGE_KEY, clean);
  } catch (_) {}

  if (S.player) {
    S.player.name = clean;
    refreshEntityTagWithHP(S.player);
  }

  document.querySelectorAll('.debix-nick-input').forEach(inp => {
    if (document.activeElement !== inp) inp.value = clean;
  });

  broadcastMultiplayerPacket({
    type: 'profile',
    name: clean,
    preset: S.player?.preset || null
  });

  if (S.mpState.isHost) {
    broadcastHostServerBeacon();
  }
}

function getDefaultWsUrl() {
  try {
    if (location.protocol.startsWith('http') && location.port === '8765') {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${location.host}`;
    }
  } catch (_) {}
  return localStorage.getItem(WS_URL_STORAGE_KEY) || 'ws://26.0.0.1:8765';
}

const CHAT_POS_STORAGE_KEY = 'debix_chat_pos_v1';
const CHAT_MINIMIZED_STORAGE_KEY = 'debix_chat_min_v1';

/* ---------- СТИЛИ БРАУЗЕРА СЕРВЕРОВ, ПРОГРЕСС-БАРА КАРТЫ И ЧАТА ---------- */

function ensureMultiplayerStyles() {
  if ($('debixMpStyles')) return;
  const st = document.createElement('style');
  st.id = 'debixMpStyles';
  st.textContent = `
    .mp-launcher-tabs {
      display: flex;
      gap: 6px;
      margin: 8px 0 12px 0;
      background: rgba(10, 14, 24, 0.78);
      padding: 5px;
      border-radius: 12px;
      border: 1.5px solid rgba(86, 240, 255, 0.25);
      flex-wrap: wrap;
    }
    .mp-tab-btn {
      flex: 1 1 160px;
      padding: 8px 10px;
      border-radius: 9px;
      border: none;
      background: transparent;
      color: #94a3b8;
      font: 800 12px 'Montserrat', sans-serif;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      white-space: nowrap;
      transition: all 0.15s;
    }
    .mp-tab-btn:hover {
      color: #fff;
      background: rgba(255, 255, 255, 0.06);
    }
    .mp-tab-btn.active {
      background: linear-gradient(135deg, #00a2ff, #0066ff);
      color: #fff;
      box-shadow: 0 4px 14px rgba(0, 162, 255, 0.35);
    }
    .mp-tab-pill {
      background: rgba(0, 230, 118, 0.22);
      border: 1px solid #00e676;
      color: #00e676;
      padding: 1px 7px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 900;
      box-sizing: border-box;
    }
    .mp-hub-banner {
      background: linear-gradient(135deg, rgba(16, 24, 42, 0.96), rgba(10, 15, 28, 0.96));
      border: 2px solid #00a2ff;
      border-radius: 14px;
      padding: 12px 14px;
      margin-bottom: 12px;
      color: #fff;
      font-family: 'Montserrat', sans-serif;
      box-shadow: 0 8px 26px rgba(0, 162, 255, 0.18);
      text-align: left;
      box-sizing: border-box;
      width: 100%;
      max-width: 100%;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .mp-hub-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      width: 100%;
      box-sizing: border-box;
    }
    .mp-field-group {
      display: flex;
      align-items: center;
      gap: 7px;
      width: 100%;
      min-width: 0;
    }
    .mp-field-group label {
      font-size: 11px;
      font-weight: 800;
      color: #56f0ff;
      white-space: nowrap;
      text-transform: uppercase;
      flex-shrink: 0;
      min-width: 148px;
    }
    .mp-inp {
      background: rgba(255, 255, 255, 0.08);
      border: 1.5px solid rgba(86, 240, 255, 0.4);
      border-radius: 8px;
      color: #fff;
      font: 800 12px 'Montserrat', sans-serif;
      padding: 6px 10px;
      height: 34px;
      box-sizing: border-box;
      outline: none;
      flex: 1 1 130px;
      min-width: 90px;
      max-width: 100%;
      width: auto;
      transition: border-color 0.15s;
    }
    .mp-inp:focus {
      border-color: #00e676;
      background: rgba(255, 255, 255, 0.13);
    }
    .mp-btn {
      background: linear-gradient(135deg, #00a2ff, #0066ff);
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 0 12px;
      height: 34px;
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 5px;
      font: 800 11.5px 'Montserrat', sans-serif;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
      transition: transform 0.1s, filter 0.15s;
    }
    .mp-btn:hover { filter: brightness(1.12); transform: translateY(-1px); }
    .mp-btn.host { background: linear-gradient(135deg, #00e676, #00b862); color: #062012; }
    .mp-btn.danger { background: linear-gradient(135deg, #ff4757, #c0392b); color: #fff; }
    .mp-btn.secondary { background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25); color: #e2e8f0; }
    .mp-status-line {
      margin-top: 8px;
      padding-top: 7px;
      border-top: 1px solid rgba(255,255,255,0.1);
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: #cbd5e1;
    }
    .mp-badge-online {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: rgba(0, 230, 118, 0.16);
      border: 1px solid #00e676;
      color: #00e676;
      padding: 3px 8px;
      border-radius: 999px;
      font-weight: 800;
      font-size: 10.5px;
    }
    .mp-servers-panel {
      background: rgba(10, 15, 26, 0.85);
      border: 1.5px solid rgba(86, 240, 255, 0.35);
      border-radius: 14px;
      padding: 12px;
      text-align: left;
      margin-bottom: 12px;
      box-sizing: border-box;
    }
    .mp-server-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-height: 260px;
      overflow-y: auto;
      margin-top: 10px;
      padding-right: 4px;
    }
    .mp-server-card {
      background: linear-gradient(135deg, rgba(22, 32, 54, 0.92), rgba(14, 21, 38, 0.92));
      border: 1.5px solid #2b3a55;
      border-radius: 11px;
      padding: 10px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      flex-wrap: wrap;
      transition: border-color 0.15s;
    }
    .mp-server-card:hover {
      border-color: #56f0ff;
    }
    #mpFloatingModal {
      position: fixed;
      top: 64px;
      left: 50%;
      transform: translateX(-50%);
      width: min(650px, 95vw);
      max-height: 85vh;
      overflow-y: auto;
      z-index: 45;
      background: rgba(12, 17, 30, 0.98);
      border: 2px solid #56f0ff;
      border-radius: 16px;
      padding: 16px 18px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, 0.78);
      color: #fff;
      font-family: 'Montserrat', sans-serif;
      box-sizing: border-box;
    }
    /* Оверлей скачивания карты и ассетов */
    #mpWorldSyncOverlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(7, 11, 20, 0.92);
      backdrop-filter: blur(6px);
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Montserrat', sans-serif;
      color: #fff;
    }
    #mpWorldSyncOverlay[hidden] { display: none !important; }
    .mp-sync-box {
      width: min(440px, 90vw);
      background: #111827;
      border: 2px solid #56f0ff;
      border-radius: 16px;
      padding: 22px 24px;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0, 162, 255, 0.3);
    }
    .mp-sync-track {
      width: 100%;
      height: 12px;
      background: rgba(255, 255, 255, 0.1);
      border-radius: 999px;
      overflow: hidden;
      margin: 14px 0 8px 0;
      border: 1px solid rgba(86, 240, 255, 0.35);
    }
    .mp-sync-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #00a2ff, #00e676);
      transition: width 0.12s ease;
    }
    /* Перетаскиваемый и сворачиваемый игровой чат */
    #mpChatWidget {
      position: fixed;
      left: 14px;
      bottom: 84px;
      width: min(350px, 88vw);
      z-index: 28;
      font-family: 'Montserrat', sans-serif;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      gap: 5px;
      user-select: none;
    }
    #mpChatWidget[hidden] { display: none !important; }
    #mpChatWidget.chat-minimized {
      width: auto;
    }
    #mpChatWidget.chat-minimized .mp-chat-messages,
    #mpChatWidget.chat-minimized .mp-chat-bar {
      display: none !important;
    }
    .mp-chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: rgba(12, 18, 32, 0.88);
      border: 1.5px solid rgba(86, 240, 255, 0.4);
      border-radius: 9px;
      padding: 4px 9px;
      pointer-events: auto;
      cursor: grab;
      backdrop-filter: blur(4px);
      box-shadow: 0 4px 14px rgba(0,0,0,0.45);
    }
    .mp-chat-header:active { cursor: grabbing; }
    .mp-chat-header-title {
      font-size: 11px;
      font-weight: 800;
      color: #56f0ff;
      display: flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    .mp-chat-min-btn {
      background: rgba(255, 255, 255, 0.12);
      border: 1px solid rgba(255, 255, 255, 0.22);
      color: #fff;
      border-radius: 6px;
      padding: 1px 7px;
      font: 800 10.5px 'Montserrat', sans-serif;
      cursor: pointer;
    }
    .mp-chat-min-btn:hover { background: rgba(86, 240, 255, 0.25); }
    .mp-chat-messages {
      max-height: 155px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px 10px;
      border-radius: 11px;
      background: rgba(10, 15, 26, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.12);
      backdrop-filter: blur(4px);
      pointer-events: auto;
      transition: opacity 0.25s, background 0.2s;
    }
    #mpChatWidget.chat-idle .mp-chat-messages {
      opacity: 0.68;
      background: rgba(10, 15, 26, 0.32);
    }
    #mpChatWidget:hover .mp-chat-messages,
    #mpChatWidget.chat-active .mp-chat-messages {
      opacity: 1;
      background: rgba(10, 15, 26, 0.86);
    }
    .mp-chat-line {
      font-size: 11.5px;
      line-height: 1.35;
      color: #f1f5f9;
      word-break: break-word;
      text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
    }
    .mp-chat-author {
      font-weight: 800;
      color: #56f0ff;
      margin-right: 5px;
    }
    .mp-chat-author.self { color: #00e676; }
    .mp-chat-author.sys { color: #ffce3a; }
    .mp-chat-bar {
      display: flex;
      align-items: center;
      gap: 5px;
      background: rgba(12, 18, 32, 0.92);
      border: 1.5px solid rgba(86, 240, 255, 0.45);
      border-radius: 10px;
      padding: 4px 6px;
      pointer-events: auto;
      position: relative;
    }
    .mp-chat-inp {
      flex: 1;
      background: transparent;
      border: none;
      color: #fff;
      font: 700 12px 'Montserrat', sans-serif;
      outline: none;
      padding: 4px 6px;
      min-width: 0;
    }
    .mp-chat-emoji-btn, .mp-chat-send-btn {
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 255, 255, 0.2);
      border-radius: 7px;
      color: #fff;
      font: 800 12px 'Montserrat', sans-serif;
      padding: 4px 8px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .mp-chat-send-btn {
      background: linear-gradient(135deg, #00a2ff, #0066ff);
      border: none;
    }
    .mp-emoji-popover {
      position: absolute;
      bottom: calc(100% + 6px);
      left: 0;
      width: 100%;
      box-sizing: border-box;
      background: rgba(12, 18, 32, 0.98);
      border: 1.5px solid #56f0ff;
      border-radius: 12px;
      padding: 8px;
      display: grid;
      grid-template-columns: repeat(8, 1fr);
      gap: 4px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.75);
      pointer-events: auto;
    }
    .mp-emoji-popover[hidden] { display: none !important; }
    .mp-emoji-item {
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid transparent;
      border-radius: 6px;
      font-size: 16px;
      padding: 4px 0;
      cursor: pointer;
      text-align: center;
      transition: transform 0.1s, background 0.1s;
    }
    .mp-emoji-item:hover {
      background: rgba(86, 240, 255, 0.22);
      border-color: #56f0ff;
      transform: scale(1.15);
    }
  `;
  document.head.appendChild(st);
}

/* ---------- UI ПРОГРЕСС-БАРА СКАЧИВАНИЯ КАРТЫ ---------- */

function showWorldDownloadProgress(visible, percent = 0, text = 'Загрузка мира и ассетов...') {
  ensureMultiplayerStyles();
  let ov = $('mpWorldSyncOverlay');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'mpWorldSyncOverlay';
    ov.hidden = true;
    ov.innerHTML = `
      <div class="mp-sync-box">
        <div style="font-size:11px;font-weight:900;color:#56f0ff;letter-spacing:.08em;text-transform:uppercase">DEBIX MULTIPLAYER SYNC</div>
        <h3 id="mpSyncTitle" style="margin:6px 0 4px 0;font-size:18px">📥 Загрузка карты сервера...</h3>
        <div class="mp-sync-track"><div class="mp-sync-fill" id="mpSyncFill"></div></div>
        <div id="mpSyncSub" style="font-size:12px;color:#cbd5e1;font-weight:700">0%</div>
      </div>
    `;
    document.body.appendChild(ov);
  }
  ov.hidden = !visible;
  if (visible) {
    const fill = $('mpSyncFill');
    const sub = $('mpSyncSub');
    if (fill) fill.style.width = `${clamp(percent, 0, 100)}%`;
    if (sub) sub.textContent = text;
  }
}

/* ---------- ИГРОВОЙ ЧАТ СО СМАЙЛИКАМИ ---------- */

function ensureChatWidgetDOM() {
  ensureMultiplayerStyles();
  let w = $('mpChatWidget');
  if (w) return w;

  w = document.createElement('div');
  w.id = 'mpChatWidget';
  w.className = 'chat-idle';
  w.hidden = S.state !== 'play';

  const emojisHTML = CHAT_EMOJIS.map(
    em => `<button type="button" class="mp-emoji-item" data-em="${em}">${em}</button>`
  ).join('');

  w.innerHTML = `
    <div class="mp-chat-header" id="mpChatDragHandle" title="Потяни, чтобы переместить чат в любое место экрана">
      <span class="mp-chat-header-title">⠿ 💬 Игровой чат</span>
      <button type="button" class="mp-chat-min-btn" id="mpChatMinToggleBtn" title="Свернуть / Развернуть чат">—</button>
    </div>
    <div class="mp-chat-messages" id="mpChatMessages">
      <div class="mp-chat-line"><span class="mp-chat-author sys">[Система]:</span>Чат готов! Нажми <b>Enter</b> для ввода или перетащи за шапку <b>⠿</b>.</div>
    </div>
    <div class="mp-chat-bar">
      <div class="mp-emoji-popover" id="mpEmojiPopover" hidden>${emojisHTML}</div>
      <button type="button" class="mp-chat-emoji-btn" id="mpEmojiToggleBtn" title="Смайлики">😀</button>
      <input type="text" class="mp-chat-inp" id="mpChatInput" maxlength="140" placeholder="Написать в чат... [Enter]">
      <button type="button" class="mp-chat-send-btn" id="mpChatSendBtn">➤</button>
    </div>
  `;
  document.body.appendChild(w);

  // Восстановление сохранённой позиции и состояния сворачивания чата
  try {
    const savedPos = JSON.parse(localStorage.getItem(CHAT_POS_STORAGE_KEY) || 'null');
    if (savedPos && typeof savedPos.x === 'number' && typeof savedPos.y === 'number') {
      const cx = clamp(savedPos.x, 6, Math.max(20, window.innerWidth - 180));
      const cy = clamp(savedPos.y, 6, Math.max(20, window.innerHeight - 60));
      w.style.left = cx + 'px';
      w.style.top = cy + 'px';
      w.style.bottom = 'auto';
    }
    if (localStorage.getItem(CHAT_MINIMIZED_STORAGE_KEY) === '1') {
      w.classList.add('chat-minimized');
      const minBtn = $('mpChatMinToggleBtn');
      if (minBtn) minBtn.textContent = '▢';
    }
  } catch (_) {}

  const dragHandle = $('mpChatDragHandle');
  const minBtn = $('mpChatMinToggleBtn');
  const inp = $('mpChatInput');
  const sendBtn = $('mpChatSendBtn');
  const emojiBtn = $('mpEmojiToggleBtn');
  const pop = $('mpEmojiPopover');

  // Сворачивание / Разворачивание чата
  minBtn.onclick = e => {
    e.stopPropagation();
    const isMin = w.classList.toggle('chat-minimized');
    minBtn.textContent = isMin ? '▢' : '—';
    try { localStorage.setItem(CHAT_MINIMIZED_STORAGE_KEY, isMin ? '1' : '0'); } catch (_) {}
  };

  // Полная изоляция событий мыши/тача внутри виджета чата, чтобы камера не вращалась при кликах и перетаскивании
  ['pointerdown', 'pointermove', 'mousedown', 'mousemove', 'touchstart', 'touchmove'].forEach(evName => {
    w.addEventListener(evName, ev => {
      ev.stopPropagation();
    });
  });

  // Перетаскивание чата в любое место экрана с перехватом в capture-фазе (камера остаётся неподвижной)
  let draggingChat = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  const onWindowChatMoveCapture = e => {
    if (!draggingChat) return;
    e.stopPropagation();
    e.stopImmediatePropagation();
    const rect = w.getBoundingClientRect();
    const nextX = clamp(e.clientX - dragOffsetX, 6, Math.max(10, window.innerWidth - rect.width - 6));
    const nextY = clamp(e.clientY - dragOffsetY, 6, Math.max(10, window.innerHeight - rect.height - 6));
    w.style.left = nextX + 'px';
    w.style.top = nextY + 'px';
    w.style.bottom = 'auto';
  };

  const stopChatDrag = e => {
    if (!draggingChat) return;
    draggingChat = false;
    window.removeEventListener('pointermove', onWindowChatMoveCapture, true);
    window.removeEventListener('mousemove', onWindowChatMoveCapture, true);
    window.removeEventListener('pointerup', stopChatDrag, true);
    window.removeEventListener('pointercancel', stopChatDrag, true);
    try {
      const rect = w.getBoundingClientRect();
      localStorage.setItem(CHAT_POS_STORAGE_KEY, JSON.stringify({ x: Math.round(rect.left), y: Math.round(rect.top) }));
    } catch (_) {}
  };

  dragHandle.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const rect = w.getBoundingClientRect();
    draggingChat = true;
    dragOffsetX = e.clientX - rect.left;
    dragOffsetY = e.clientY - rect.top;
    window.addEventListener('pointermove', onWindowChatMoveCapture, true);
    window.addEventListener('mousemove', onWindowChatMoveCapture, true);
    window.addEventListener('pointerup', stopChatDrag, true);
    window.addEventListener('pointercancel', stopChatDrag, true);
  });

  let idleTimer = null;
  const markChatActive = () => {
    w.classList.remove('chat-idle');
    w.classList.add('chat-active');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (document.activeElement !== inp && pop.hidden) {
        w.classList.remove('chat-active');
        w.classList.add('chat-idle');
      }
    }, 5000);
  };

  const doSend = () => {
    const txt = (inp.value || '').trim();
    if (!txt) {
      inp.blur();
      return;
    }
    inp.value = '';
    pop.hidden = true;
    sendPlayerChatMessage(txt);
    markChatActive();
  };

  sendBtn.onclick = e => {
    e.stopPropagation();
    doSend();
  };

  emojiBtn.onclick = e => {
    e.stopPropagation();
    pop.hidden = !pop.hidden;
    markChatActive();
  };

  pop.querySelectorAll('.mp-emoji-item').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const em = btn.dataset.em || '';
      inp.value = (inp.value + em).slice(0, 140);
      inp.focus();
      markChatActive();
    };
  });

  inp.addEventListener('focus', () => markChatActive());
  inp.addEventListener('blur', () => markChatActive());
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.code === 'Enter') {
      e.preventDefault();
      doSend();
    } else if (e.code === 'Escape') {
      e.preventDefault();
      pop.hidden = true;
      inp.blur();
    }
  });

  document.addEventListener('click', e => {
    if (!w.contains(e.target)) {
      pop.hidden = true;
    }
  });

  return w;
}

export function syncChatWidgetVisibility() {
  const w = ensureChatWidgetDOM();
  if (!w) return;
  // В 3D Студии (edit) и в Главном меню (menu) чат полностью скрыт, чтобы не мешать редактированию!
  w.hidden = S.state !== 'play';
}

export function appendChatMessage(author, text, kind = 'remote') {
  const w = ensureChatWidgetDOM();
  const box = $('mpChatMessages');
  if (!box || !text) return;

  chatHistory.push({ author, text, kind, ts: Date.now() });
  if (chatHistory.length > MAX_CHAT_HISTORY) chatHistory.shift();

  const line = document.createElement('div');
  line.className = 'mp-chat-line';
  const spanAuth = document.createElement('span');
  spanAuth.className = 'mp-chat-author ' + (kind === 'self' ? 'self' : kind === 'sys' ? 'sys' : '');
  spanAuth.textContent = `${author}:`;
  const spanTxt = document.createElement('span');
  spanTxt.textContent = ' ' + text;

  line.append(spanAuth, spanTxt);
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;

  w.classList.remove('chat-idle');
  w.classList.add('chat-active');
}

export function sendPlayerChatMessage(rawText) {
  const text = (rawText || '').trim().slice(0, 140);
  if (!text) return;

  const nick = S.playerName || 'Player';
  appendChatMessage(nick, text, 'self');

  if (S.player) {
    pushEntityChatBubble(S.player, text, 5.2);
    refreshEntityTagWithHP(S.player);
  }
  sfx.click?.();

  broadcastMultiplayerPacket({
    type: 'chat_msg',
    text
  });
}

/* ---------- ПОИСК И РЕГИСТРАЦИЯ АКТИВНЫХ СЕРВЕРОВ ---------- */

function getCurrentServerInfo() {
  return {
    roomId: S.mpState.roomCode || 'RADMIN-1',
    hostPeerId: S.mpState.peerId,
    title: S.currentProjectTitle || (S.gameMode?.id === 'sandbox_template' ? 'Песочница (Sandbox)' : 'Очередь в Рай'),
    hostName: S.playerName || 'Player',
    modeId: S.gameMode?.id || 'heaven_queue',
    blockCount: (S.allBlocks || []).length,
    itemCount: (S.worldItems || []).length,
    playersCount: Object.keys(S.remotePlayers || {}).length + 1,
    transport: wsConnection && wsConnection.readyState === 1 ? 'ws' : 'peer',
    wsUrl: S.mpState.wsUrl || getDefaultWsUrl(),
    updatedAt: Date.now()
  };
}

export function broadcastHostServerBeacon() {
  if (!S.mpState.isHost) return;
  const info = getCurrentServerInfo();
  discoveredServers.set(info.roomId, info);

  if (localChannel) {
    try {
      localChannel.postMessage({
        type: 'server_beacon',
        senderId: S.mpState.peerId,
        serverInfo: info
      });
    } catch (_) {}
  }

  const regMsg = JSON.stringify({
    type: 'register_server',
    senderId: S.mpState.peerId,
    serverInfo: info
  });

  if (wsConnection && wsConnection.readyState === 1) {
    try { wsConnection.send(regMsg); } catch (_) {}
  } else if (discoveryWs && discoveryWs.readyState === 1) {
    try { discoveryWs.send(regMsg); } catch (_) {}
  }
}

function pruneStaleDiscoveredServers() {
  const now = Date.now();
  let changed = false;
  for (const [id, srv] of discoveredServers.entries()) {
    if (now - (srv.updatedAt || 0) > 22000) {
      discoveredServers.delete(id);
      changed = true;
    }
  }
  if (changed) refreshServerBrowserListDOM();
}

export function requestActiveServersRefresh() {
  pruneStaleDiscoveredServers();

  // 1. Опрос открытых локальных вкладок
  if (localChannel) {
    try {
      localChannel.postMessage({
        type: 'request_beacons',
        senderId: S.mpState.peerId
      });
    } catch (_) {}
  }

  // 2. HTTP-опрос lan-server.js (/api/servers) на основе введённого WS URL
  const wsUrl = S.mpState.wsUrl || getDefaultWsUrl();
  try {
    const httpUrl = wsUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/$/, '') + '/api/servers';
    fetch(httpUrl)
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        if (Array.isArray(list)) {
          for (const srv of list) {
            if (srv && srv.roomId) {
              discoveredServers.set(srv.roomId, Object.assign({}, srv, { wsUrl, updatedAt: Date.now() }));
            }
          }
          refreshServerBrowserListDOM();
          refreshMultiplayerUI();
        }
      })
      .catch(() => {});
  } catch (_) {}

  // 3. Опрос через открытый WebSocket
  if (wsConnection && wsConnection.readyState === 1) {
    try { wsConnection.send(JSON.stringify({ type: 'get_servers', senderId: S.mpState.peerId })); } catch (_) {}
  } else {
    ensureBackgroundDiscoveryWebSocket(wsUrl);
  }
}

function ensureBackgroundDiscoveryWebSocket(wsUrl) {
  if (!wsUrl || (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://'))) return;
  if (wsConnection && wsConnection.readyState === 1) return;
  if (discoveryWs && (discoveryWs.readyState === 0 || discoveryWs.readyState === 1)) {
    if (discoveryWs.readyState === 1) {
      try { discoveryWs.send(JSON.stringify({ type: 'get_servers', senderId: S.mpState.peerId })); } catch (_) {}
    }
    return;
  }
  try {
    discoveryWs = new WebSocket(wsUrl);
    discoveryWs.onopen = () => {
      try { discoveryWs.send(JSON.stringify({ type: 'get_servers', senderId: S.mpState.peerId })); } catch (_) {}
      if (S.mpState.isHost) broadcastHostServerBeacon();
    };
    discoveryWs.onmessage = ev => {
      try {
        const pkt = JSON.parse(ev.data);
        if (pkt && pkt.type === 'server_list_update' && Array.isArray(pkt.servers)) {
          for (const srv of pkt.servers) {
            if (srv && srv.roomId) {
              discoveredServers.set(srv.roomId, Object.assign({}, srv, { wsUrl, updatedAt: Date.now() }));
            }
          }
          refreshServerBrowserListDOM();
          refreshMultiplayerUI();
        }
        if (pkt && pkt.type === 'hub_catalog_update') {
          if (Array.isArray(pkt.items)) {
            for (const it of pkt.items) {
              if (it && it.id) ugcHubItems.set(it.id, it);
            }
          } else if (pkt.item && pkt.item.id) {
            ugcHubItems.set(pkt.item.id, pkt.item);
          }
          saveLocalUgcHubCache();
          refreshUgcHubDOM();
        }
      } catch (_) {}
    };
    discoveryWs.onerror = () => {};
    discoveryWs.onclose = () => { discoveryWs = null; };
  } catch (_) {}
}

/* ---------- ПОДКЛЮЧЕНИЕ К СЕРВЕРУ В 1 КЛИК ---------- */

export function joinDiscoveredServerOneClick(roomId) {
  const srv = discoveredServers.get(roomId);
  S.mpState.roomCode = roomId;
  try { localStorage.setItem(ROOM_STORAGE_KEY, roomId); } catch (_) {}

  showWorldDownloadProgress(true, 12, `Подключение к серверу «${srv?.title || roomId}»...`);

  // Если сервер работает через lan-server.js или мы в одной локальной вкладке — подключаемся мгновенно
  const targetWsUrl = srv?.wsUrl || S.mpState.wsUrl || getDefaultWsUrl();
  if (srv?.transport === 'ws' && targetWsUrl) {
    connectDirectWebSocket(targetWsUrl, roomId, true);
  } else if (localChannel && srv?.hostPeerId) {
    S.mpState.connected = true;
    S.mpState.isHost = false;
    S.mpState.statusText = `✅ Подключено к «${srv.title}» (${srv.hostName})`;
    refreshMultiplayerUI();
    requestWorldSnapshotFromHost();
  } else {
    joinPeerRoom(roomId, true);
  }
}

/* ---------- ВКЛАДКА «🌐 СЕРВЕРЫ» И ВИДЖЕТЫ В ГЛАВНОМ МЕНЮ ---------- */

function buildServerCardsHTML() {
  pruneStaleDiscoveredServers();
  const list = Array.from(discoveredServers.values());

  if (list.length === 0) {
    return `
      <div style="text-align:center;padding:24px 12px;color:#94a3b8;font-size:12px;background:rgba(0,0,0,0.25);border-radius:10px;border:1px dashed rgba(255,255,255,0.15)">
        📡 <b>Активных серверов пока не найдено</b><br>
        <span style="font-size:11px;color:#64748b">
          Нажми <b>«👑 Создать сервер»</b> выше или введи IP друга из Radmin VPN (если запущен <code>lan-server.js</code>) и нажми <b>«🔄 Обновить»</b>.
        </span>
      </div>
    `;
  }

  return list
    .map(srv => {
      const isSandbox = srv.modeId === 'sandbox_template';
      const modeBadge = isSandbox ? '🌱 Sandbox' : '😇 Очередь в Рай';
      const isMyHost = S.mpState.isHost && srv.roomId === S.mpState.roomCode;
      return `
        <div class="mp-server-card">
          <div style="flex:1;min-width:180px">
            <div style="display:flex;align-items:center;gap:7px;flex-wrap:wrap">
              <b style="font-size:13.5px;color:#fff">🌍 ${srv.title || srv.roomId}</b>
              <span style="font-size:10px;background:#1e293b;color:#56f0ff;padding:2px 7px;border-radius:6px;font-weight:800">${modeBadge}</span>
              <span style="font-size:10px;background:rgba(0,230,118,0.16);color:#00e676;padding:2px 7px;border-radius:999px;font-weight:800">🟢 ${srv.playersCount || 1} игр.</span>
            </div>
            <div style="font-size:11px;color:#94a3b8;margin-top:4px">
              👑 Хост: <b style="color:#e2e8f0">${srv.hostName || 'Игрок'}</b> · 🔑 Код: <code>${srv.roomId}</code> · 🧱 ${srv.blockCount ?? 0} объ.
            </div>
          </div>
          <div>
            ${
              isMyHost
                ? `<span class="mp-badge-online">👑 Твой сервер активен</span>`
                : `<button type="button" class="mp-btn host" data-join-srv="${srv.roomId}" style="padding:8px 14px;font-size:12px">▶ ПОДКЛЮЧИТЬСЯ</button>`
            }
          </div>
        </div>
      `;
    })
    .join('');
}

export function refreshServerBrowserListDOM() {
  document.querySelectorAll('.debix-server-list-container').forEach(el => {
    el.innerHTML = buildServerCardsHTML();
    el.querySelectorAll('[data-join-srv]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        joinDiscoveredServerOneClick(btn.dataset.joinSrv);
      };
    });
  });

  const srvCount = discoveredServers.size;
  document.querySelectorAll('.debix-srv-count-pill').forEach(el => {
    el.textContent = String(srvCount);
  });
}

function buildMultiplayerControlsHTML(context = 'hub') {
  const nick = S.playerName || getSavedPlayerNickname();
  const roomCode = S.mpState.roomCode || localStorage.getItem(ROOM_STORAGE_KEY) || 'RADMIN-1';
  const wsUrl = S.mpState.wsUrl || getDefaultWsUrl();
  const peerCount = Object.keys(S.remotePlayers || {}).length;
  const statusTxt =
    S.mpState.statusText || 'Готов к игре · Выбери сервер из списка ниже или создай свой!';

  return `
    <div class="mp-hub-banner" data-mp-widget="${context}">
      <div class="mp-hub-row">
        <div class="mp-field-group">
          <label>👤 ТВОЙ НИК:</label>
          <input type="text" class="mp-inp debix-nick-input" maxlength="20" value="${nick}" placeholder="Твой никнейм...">
          <span class="mp-badge-online debix-mp-online-badge" style="margin-left:auto">🟢 Игроков рядом: ${peerCount}</span>
        </div>
      </div>

      <div class="mp-hub-row">
        <div class="mp-field-group">
          <label>🔑 КОМНАТА:</label>
          <input type="text" class="mp-inp debix-room-input" maxlength="24" value="${roomCode}" placeholder="Напр. RADMIN-1">
          <button type="button" class="mp-btn host debix-btn-host" title="Создать сервер и сразу войти в игру">👑 Создать сервер</button>
          <button type="button" class="mp-btn debix-btn-join" title="Подключиться и автоматически скачать карту">🔌 Войти</button>
        </div>
      </div>

      <div class="mp-hub-row">
        <div class="mp-field-group">
          <label title="Адрес lan-server.js (для Radmin VPN / LAN)">🖧 СЕРВЕР LAN / RADMIN:</label>
          <input type="text" class="mp-inp debix-ws-input" value="${wsUrl}" placeholder="ws://26.x.x.x:8765">
          <button type="button" class="mp-btn secondary debix-btn-ws">Подкл. по IP</button>
          <button type="button" class="mp-btn secondary debix-btn-refresh-srv" title="Обновить список активных серверов">🔄 Серверы</button>
          ${S.mpState.connected ? `<button type="button" class="mp-btn danger debix-btn-disc">Откл.</button>` : ''}
        </div>
      </div>

      <div class="mp-status-line" style="margin-top:2px">
        <span class="debix-mp-status-txt">${statusTxt}</span>
      </div>
    </div>
  `;
}

function buildServersTabPanelHTML() {
  return `
    <div class="mp-servers-panel" id="mpServersTabPanel">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div>
          <div style="font:900 13.5px 'Montserrat',sans-serif;color:#56f0ff">🌐 ДОСТУПНЫЕ АКТИВНЫЕ СЕРВЕРЫ</div>
          <div style="font-size:11px;color:#94a3b8">Нажми «▶ Подключиться» — карта, текстуры, звуки и префабы скачаются автоматически!</div>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="mp-btn secondary debix-btn-refresh-srv">🔄 Обновить список</button>
        </div>
      </div>
      <div class="mp-server-list debix-server-list-container">
        ${buildServerCardsHTML()}
      </div>
    </div>
  `;
}

function bindMultiplayerWidgetEvents(container) {
  if (!container) return;

  container.querySelectorAll('.debix-nick-input').forEach(inp => {
    if (inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', () => setPlayerNickname(inp.value));
    inp.addEventListener('keydown', e => e.stopPropagation());
  });

  container.querySelectorAll('.debix-room-input').forEach(inp => {
    if (inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', () => {
      S.mpState.roomCode = inp.value.trim().toUpperCase();
      try { localStorage.setItem(ROOM_STORAGE_KEY, S.mpState.roomCode); } catch (_) {}
      document.querySelectorAll('.debix-room-input').forEach(other => {
        if (other !== inp) other.value = S.mpState.roomCode;
      });
    });
    inp.addEventListener('keydown', e => e.stopPropagation());
  });

  container.querySelectorAll('.debix-ws-input').forEach(inp => {
    if (inp.dataset.bound) return;
    inp.dataset.bound = '1';
    inp.addEventListener('input', () => {
      S.mpState.wsUrl = inp.value.trim();
      try { localStorage.setItem(WS_URL_STORAGE_KEY, S.mpState.wsUrl); } catch (_) {}
    });
    inp.addEventListener('keydown', e => e.stopPropagation());
  });

  container.querySelectorAll('.debix-btn-host').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = e => {
      e.stopPropagation();
      const inp = container.querySelector('.debix-room-input');
      if (inp) S.mpState.roomCode = inp.value.trim().toUpperCase() || 'RADMIN-1';
      startPeerHost(S.mpState.roomCode, true);
    };
  });

  container.querySelectorAll('.debix-btn-join').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = e => {
      e.stopPropagation();
      const inp = container.querySelector('.debix-room-input');
      if (inp) S.mpState.roomCode = inp.value.trim().toUpperCase() || 'RADMIN-1';
      joinDiscoveredServerOneClick(S.mpState.roomCode);
    };
  });

  container.querySelectorAll('.debix-btn-ws').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = e => {
      e.stopPropagation();
      const inp = container.querySelector('.debix-ws-input');
      if (inp) S.mpState.wsUrl = inp.value.trim();
      connectDirectWebSocket(S.mpState.wsUrl, S.mpState.roomCode, true);
    };
  });

  container.querySelectorAll('.debix-btn-refresh-srv').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = e => {
      e.stopPropagation();
      requestActiveServersRefresh();
      refreshServerBrowserListDOM();
      sfx.click?.();
    };
  });

  container.querySelectorAll('.debix-btn-disc').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.onclick = e => {
      e.stopPropagation();
      disconnectMultiplayerNetwork();
    };
  });

  container.querySelectorAll('[data-join-srv]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      joinDiscoveredServerOneClick(btn.dataset.joinSrv);
    };
  });
}

export function refreshMultiplayerUI() {
  const peerCount = Object.keys(S.remotePlayers || {}).length;
  const statusTxt = S.mpState.statusText || 'Готов к игре';

  document.querySelectorAll('.debix-mp-status-txt').forEach(el => {
    el.textContent = statusTxt;
  });
  document.querySelectorAll('.debix-mp-online-badge').forEach(el => {
    el.textContent = `🟢 Игроков рядом: ${peerCount}`;
  });

  const topBtn = $('mpToggleBtn');
  if (topBtn) {
    topBtn.textContent = `🌐 СЕТЬ (${peerCount + 1}) [M]`;
  }
  syncChatWidgetVisibility();
}

// Инжекция вкладок «🏠 Мои Миры» / «🌐 Серверы Онлайн» в главное меню (#modalBox)
function injectBannerIntoModalBox() {
  const modalBox = $('modalBox');
  if (!modalBox || window.__PLAY_ONLY_BUILD__) return;
  if (modalBox.querySelector('.mp-launcher-tabs')) return;

  ensureUgcHubInitialized();

  // Оборачиваем стандартное содержимое #modalBox (кроме заголовка) в контейнер вкладки «worlds»
  const existingChildren = Array.from(modalBox.children);
  const headerElements = existingChildren.slice(0, 2); // badge + h1
  const bodyElements = existingChildren.slice(2);

  const worldsWrap = document.createElement('div');
  worldsWrap.id = 'mpLauncherWorldsWrap';
  bodyElements.forEach(el => worldsWrap.appendChild(el));

  const serversWrap = document.createElement('div');
  serversWrap.id = 'mpLauncherServersWrap';
  serversWrap.innerHTML = buildMultiplayerControlsHTML('hub') + buildServersTabPanelHTML();

  const hubWrap = document.createElement('div');
  hubWrap.id = 'mpLauncherHubWrap';
  hubWrap.innerHTML = buildUgcHubPanelHTML('launcher');

  const tabsBar = document.createElement('div');
  tabsBar.className = 'mp-launcher-tabs';
  tabsBar.innerHTML = `
    <button type="button" class="mp-tab-btn ${activeLauncherTab === 'worlds' ? 'active' : ''}" data-ltab="worlds">
      🏠 МОИ МИРЫ
    </button>
    <button type="button" class="mp-tab-btn ${activeLauncherTab === 'servers' ? 'active' : ''}" data-ltab="servers">
      🌐 АКТИВНЫЕ СЕРВЕРЫ <span class="mp-tab-pill debix-srv-count-pill">${discoveredServers.size}</span>
    </button>
    <button type="button" class="mp-tab-btn ${activeLauncherTab === 'hub' ? 'active' : ''}" data-ltab="hub">
      📚 МАСТЕРСКАЯ UGC <span class="mp-tab-pill debix-hub-count-pill">${ugcHubItems.size}</span>
    </button>
  `;

  // В режиме «Мои миры» оставляем сверху компактную строку никнейма
  const quickNickBar = document.createElement('div');
  quickNickBar.style.cssText = 'display:flex;align-items:center;gap:8px;background:rgba(16,24,42,0.85);border:1.5px solid rgba(86,240,255,0.35);border-radius:10px;padding:7px 12px;margin-bottom:10px';
  quickNickBar.innerHTML = `
    <span style="font:800 11px Montserrat,sans-serif;color:#56f0ff;white-space:nowrap">👤 НИКНЕЙМ:</span>
    <input type="text" class="mp-inp debix-nick-input" maxlength="20" value="${S.playerName || getSavedPlayerNickname()}" style="max-width:190px;padding:4px 8px">
    <span style="font-size:11px;color:#94a3b8;flex:1;text-align:right">Делись картами, префабами и NPC во вкладке <b>«📚 Мастерская UGC»</b>!</span>
  `;
  worldsWrap.insertBefore(quickNickBar, worldsWrap.firstChild);

  modalBox.innerHTML = '';
  headerElements.forEach(el => modalBox.appendChild(el));
  modalBox.appendChild(tabsBar);
  modalBox.appendChild(worldsWrap);
  modalBox.appendChild(serversWrap);
  modalBox.appendChild(hubWrap);

  const syncTabs = () => {
    worldsWrap.hidden = activeLauncherTab !== 'worlds';
    serversWrap.hidden = activeLauncherTab !== 'servers';
    hubWrap.hidden = activeLauncherTab !== 'hub';
    tabsBar.querySelectorAll('.mp-tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.ltab === activeLauncherTab);
    });
    if (activeLauncherTab === 'servers') {
      requestActiveServersRefresh();
      refreshServerBrowserListDOM();
    } else if (activeLauncherTab === 'hub') {
      requestUgcHubCatalogRefresh();
      refreshUgcHubDOM();
    }
  };
  syncTabs();

  tabsBar.querySelectorAll('.mp-tab-btn').forEach(btn => {
    btn.onclick = () => {
      activeLauncherTab = btn.dataset.ltab;
      syncTabs();
      sfx.click?.();
    };
  });

  bindMultiplayerWidgetEvents(modalBox);
  bindUgcHubEvents(hubWrap);
  requestActiveServersRefresh();
  requestUgcHubCatalogRefresh();
}

export function toggleMultiplayerModal(forceOpen = null) {
  ensureMultiplayerStyles();
  let modal = $('mpFloatingModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'mpFloatingModal';
    modal.hidden = true;
    document.body.appendChild(modal);
  }

  const nextOpen = forceOpen !== null ? forceOpen : modal.hidden;
  modal.hidden = !nextOpen;
  if (nextOpen) {
    requestActiveServersRefresh();
    modal.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <b style="font-size:14px;color:#56f0ff">🌐 СЕРВЕРЫ И СИНХРОНИЗАЦИЯ МИРА (LAN / RADMIN VPN)</b>
        <button type="button" class="mp-btn danger" id="closeMpFloatingBtn" style="padding:4px 9px">✕</button>
      </div>
      ${buildMultiplayerControlsHTML('floating')}
      ${buildServersTabPanelHTML()}
    `;
    bindMultiplayerWidgetEvents(modal);
    $('closeMpFloatingBtn').onclick = () => {
      modal.hidden = true;
    };
  }
}

/* ---------- ПЕРЕСЫЛКА КАРТЫ И АССЕТОВ ЧАНКАМИ (HOST -> CLIENT) ---------- */

export function requestWorldSnapshotFromHost() {
  broadcastMultiplayerPacket({
    type: 'request_world_snapshot'
  });
}

function sendWorldSnapshotToPeer(targetPeerId = null) {
  try {
    const stateObj = serializeSceneState();
    const jsonStr = JSON.stringify(stateObj);
    const totalChunks = Math.max(1, Math.ceil(jsonStr.length / SNAPSHOT_CHUNK_SIZE));
    const transferId = 'snap_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);

    for (let i = 0; i < totalChunks; i++) {
      const slice = jsonStr.slice(i * SNAPSHOT_CHUNK_SIZE, (i + 1) * SNAPSHOT_CHUNK_SIZE);
      broadcastMultiplayerPacket({
        type: 'world_snapshot_chunk',
        targetPeerId: targetPeerId || undefined,
        transferId,
        chunkIdx: i,
        totalChunks,
        hostTitle: S.currentProjectTitle || 'Сервер',
        data: slice
      });
    }
  } catch (err) {
    console.warn('Snapshot send error:', err);
  }
}

function handleIncomingSnapshotChunk(pkt) {
  if (pkt.targetPeerId && pkt.targetPeerId !== S.mpState.peerId) return;
  const { transferId, chunkIdx, totalChunks, data, hostTitle } = pkt;
  if (!transferId || typeof chunkIdx !== 'number' || !totalChunks) return;

  let entry = incomingSnapshots.get(transferId);
  if (!entry) {
    entry = {
      chunks: new Array(totalChunks),
      received: 0,
      total: totalChunks,
      hostTitle: hostTitle || 'Сервер'
    };
    incomingSnapshots.set(transferId, entry);
  }

  if (entry.chunks[chunkIdx] === undefined) {
    entry.chunks[chunkIdx] = data;
    entry.received++;
  }

  const pct = Math.round((entry.received / entry.total) * 100);
  showWorldDownloadProgress(
    true,
    pct,
    `Скачивание карты «${entry.hostTitle}» и материалов: ${pct}% (${entry.received}/${entry.total})`
  );

  if (entry.received >= entry.total) {
    incomingSnapshots.delete(transferId);
    const fullJson = entry.chunks.join('');
    try {
      const worldData = JSON.parse(fullJson);
      applyRemoteWorldSnapshot(worldData);
    } catch (err) {
      console.error('Failed to parse world snapshot:', err);
      showWorldDownloadProgress(false);
      showBanner('❌ Ошибка распаковки карты сервера!', '#ff3e3e');
    }
  }
}

function applyRemoteWorldSnapshot(worldData) {
  if (!worldData) return;

  // Сохраняем собственный внешний вид и имя подключающегося игрока, чтобы не перезаписать его скином Хоста
  const mySavedPreset = S.player?.preset ? JSON.parse(JSON.stringify(S.player.preset)) : null;
  const mySavedName = S.playerName || getSavedPlayerNickname();

  S.isApplyingRemoteSync = true;
  try {
    // Подменяем playerData в слепке так, чтобы позиция спавна взялась с карты сервера, а скин остался нашим
    if (worldData.playerData) {
      worldData.playerData.name = mySavedName;
      if (mySavedPreset) {
        worldData.playerData.preset = mySavedPreset;
      }
    }

    loadSceneState(worldData);
    reattachRemotePlayersToScene();
    syncAudioWithWorldSettings();

    if (S.state === 'menu') {
      startPlaySession();
    }
    const modal = $('mpFloatingModal');
    if (modal) modal.hidden = true;
  } finally {
    S.isApplyingRemoteSync = false;
  }

  showWorldDownloadProgress(false);
  sfx.gate?.();
  showBanner(`🌍 Карта «${worldData.projectTitle || 'Сервер'}» и все материалы успешно загружены!`, '#00e676');
  sendImmediateFullState();
}

/* ---------- ЖИВАЯ ДВУСТОРОННЯЯ СИНХРОНИЗАЦИЯ ИЗМЕНЕНИЙ МИРА (WORLD OPS) ---------- */

function serializeSingleBlockForNet(b) {
  if (!b || !b.m) return null;
  const basePos = b.logicRuntime && b.logicRuntime.basePos && S.state !== 'edit' ? b.logicRuntime.basePos : b.m.position;
  const baseScale = b.logicRuntime && b.logicRuntime.baseScale && S.state !== 'edit' ? b.logicRuntime.baseScale : b.m.scale;
  const baseEuler =
    b.logicRuntime && b.logicRuntime.baseQuat && S.state !== 'edit'
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
    costData: b.costData ? JSON.parse(JSON.stringify(b.costData)) : null,
    soundData: b.soundData ? JSON.parse(JSON.stringify(b.soundData)) : null,
    mediaScreenData: b.mediaScreenData ? JSON.parse(JSON.stringify(b.mediaScreenData)) : null,
    soundEmitterData: b.soundEmitterData ? JSON.parse(JSON.stringify(b.soundEmitterData)) : null,
    checkpointData: b.checkpointData ? JSON.parse(JSON.stringify(b.checkpointData)) : null,
    spawnerData: b.spawnerData ? JSON.parse(JSON.stringify(b.spawnerData)) : null,
    particleData: b.particleData ? JSON.parse(JSON.stringify(b.particleData)) : null,
    lightData: b.lightData ? JSON.parse(JSON.stringify(b.lightData)) : null,
    logicData: b.logicData ? JSON.parse(JSON.stringify(b.logicData)) : null,
    parentKey: b.parentKey || null,
    hierOrder: b.hierOrder || 0,
    isCustom: b.isCustom
  };
}

export function syncWorldSettingsToNetwork(throttled = true) {
  if (S.isApplyingRemoteSync) return;
  const sendNow = () => {
    broadcastMultiplayerPacket({
      type: 'world_op',
      op: 'world_settings',
      projectTitle: S.currentProjectTitle,
      worldSettings: JSON.parse(JSON.stringify(S.worldSettings)),
      customDefaultStudDataURL: S.customDefaultStudDataURL
    });
  };
  if (!throttled) {
    clearTimeout(skySyncThrottleTimer);
    sendNow();
    return;
  }
  clearTimeout(skySyncThrottleTimer);
  skySyncThrottleTimer = setTimeout(sendNow, 70);
}

export function syncBlockUpsertToNetwork(box, throttled = false) {
  if (S.isApplyingRemoteSync || !box || !box.id) return;
  const doSend = () => {
    blockSyncThrottleMap.delete(box.id);
    const serialized = serializeSingleBlockForNet(box);
    if (!serialized) return;
    broadcastMultiplayerPacket({
      type: 'world_op',
      op: 'block_upsert',
      block: serialized
    });
  };
  if (!throttled) {
    if (blockSyncThrottleMap.has(box.id)) {
      clearTimeout(blockSyncThrottleMap.get(box.id));
      blockSyncThrottleMap.delete(box.id);
    }
    doSend();
    return;
  }
  if (blockSyncThrottleMap.has(box.id)) return;
  blockSyncThrottleMap.set(box.id, setTimeout(doSend, 65));
}

export function syncBlockDeleteToNetwork(blockId) {
  if (S.isApplyingRemoteSync || !blockId) return;
  broadcastMultiplayerPacket({
    type: 'world_op',
    op: 'block_delete',
    blockId
  });
}

export function syncWorldItemUpsertToNetwork(wi, throttled = false) {
  if (S.isApplyingRemoteSync || !wi || !wi.id) return;
  const doSend = () => {
    itemSyncThrottleMap.delete(wi.id);
    broadcastMultiplayerPacket({
      type: 'world_op',
      op: 'world_item_upsert',
      worldItem: {
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
        item: JSON.parse(JSON.stringify(wi.item))
      }
    });
  };
  if (!throttled) {
    if (itemSyncThrottleMap.has(wi.id)) {
      clearTimeout(itemSyncThrottleMap.get(wi.id));
      itemSyncThrottleMap.delete(wi.id);
    }
    doSend();
    return;
  }
  if (itemSyncThrottleMap.has(wi.id)) return;
  itemSyncThrottleMap.set(wi.id, setTimeout(doSend, 65));
}

export function syncWorldItemDeleteToNetwork(itemId) {
  if (S.isApplyingRemoteSync || !itemId) return;
  broadcastMultiplayerPacket({
    type: 'world_op',
    op: 'world_item_delete',
    itemId
  });
}

export function serializeSingleNpcForNet(n) {
  if (!n) return null;
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
    equippedItem: n.equippedItem ? JSON.parse(JSON.stringify(n.equippedItem)) : null,
    aiModules: n.aiModules ? JSON.parse(JSON.stringify(n.aiModules)) : null,
    homeX: n.homeX ?? n.x,
    homeY: n.homeY ?? n.y,
    homeZ: n.homeZ ?? n.z,
    x: n.x,
    y: n.y,
    z: n.z,
    rot: n.rot || 0,
    scale: n.rig?.g?.scale?.x || n.scale || 1,
    parentKey: n.parentKey || null,
    hierOrder: n.hierOrder || 0,
    handGripPoint: n.preset?.handGripPoint ? Object.assign({}, n.preset.handGripPoint) : null,
    carryGripPoint: n.preset?.carryGripPoint ? Object.assign({}, n.preset.carryGripPoint) : null,
    preset: JSON.parse(JSON.stringify(n.preset || {}))
  };
}

export function syncNpcUpsertToNetwork(npc, throttled = false) {
  if (S.isApplyingRemoteSync || !npc || !npc.id) return;
  const doSend = () => {
    npcSyncThrottleMap.delete(npc.id);
    const serialized = serializeSingleNpcForNet(npc);
    if (!serialized) return;
    broadcastMultiplayerPacket({
      type: 'world_op',
      op: 'npc_upsert',
      npc: serialized
    });
  };
  if (!throttled) {
    if (npcSyncThrottleMap.has(npc.id)) {
      clearTimeout(npcSyncThrottleMap.get(npc.id));
      npcSyncThrottleMap.delete(npc.id);
    }
    doSend();
    return;
  }
  if (npcSyncThrottleMap.has(npc.id)) return;
  npcSyncThrottleMap.set(npc.id, setTimeout(doSend, 65));
}

export function syncNpcDeleteToNetwork(npcId) {
  if (S.isApplyingRemoteSync || !npcId) return;
  broadcastMultiplayerPacket({
    type: 'world_op',
    op: 'npc_delete',
    npcId
  });
}

const incomingAssetChunks = new Map();

export function syncCustomAssetToNetwork(assetType, assetData) {
  if (S.isApplyingRemoteSync || !assetData) return;
  try {
    const jsonStr = JSON.stringify(assetData);
    // Если ассет компактный (< 40 KB) — отправляем одним пакетом, иначе режем на чанки (для больших .mp3/.wav)
    if (jsonStr.length <= 40000) {
      broadcastMultiplayerPacket({
        type: 'world_op',
        op: 'asset_sync',
        assetType,
        assetData: JSON.parse(jsonStr)
      });
      return;
    }
    const totalChunks = Math.ceil(jsonStr.length / SNAPSHOT_CHUNK_SIZE);
    const transferId = 'ast_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    for (let i = 0; i < totalChunks; i++) {
      broadcastMultiplayerPacket({
        type: 'world_op',
        op: 'asset_sync_chunk',
        assetType,
        transferId,
        chunkIdx: i,
        totalChunks,
        data: jsonStr.slice(i * SNAPSHOT_CHUNK_SIZE, (i + 1) * SNAPSHOT_CHUNK_SIZE)
      });
    }
  } catch (err) {
    console.warn('Asset sync error:', err);
  }
}

function handleWorldOpPacket(pkt) {
  if (!pkt || !pkt.op) return;
  S.isApplyingRemoteSync = true;
  try {
    if (pkt.op === 'world_settings') {
      if (pkt.projectTitle) S.currentProjectTitle = pkt.projectTitle;
      if (pkt.worldSettings) {
        const prevMusic = S.worldSettings.musicPreset;
        const prevAmb = S.worldSettings.ambiencePreset;
        Object.assign(S.worldSettings, pkt.worldSettings);
        updateSkybox();
        if (S.worldSettings.musicPreset !== prevMusic) {
          setWorldMusic(S.worldSettings.musicPreset);
        }
        if (S.worldSettings.ambiencePreset !== prevAmb) {
          setWorldAmbience(S.worldSettings.ambiencePreset);
        }
      }
      if (pkt.customDefaultStudDataURL !== undefined) {
        S.customDefaultStudDataURL = pkt.customDefaultStudDataURL;
      }
    } else if (pkt.op === 'block_upsert' && pkt.block) {
      const sb = pkt.block;
      let box = S.allBlocks.find(b => b && b.id === sb.id);
      if (!box) {
        box = addSceneBlock(sb);
        box.id = sb.id;
        const numId = parseInt(String(sb.id).replace(/\D+/g, ''), 10);
        if (!isNaN(numId) && numId >= S.blockIdCounter) {
          S.blockIdCounter = numId + 1;
        }
      } else {
        Object.assign(box, {
          label: sb.label ?? box.label,
          shape: sb.shape ?? box.shape,
          surfaceType: sb.surfaceType ?? box.surfaceType,
          colliderShape: sb.colliderShape ?? box.colliderShape,
          colorHex: sb.colorHex ?? box.colorHex,
          gold: !!sb.gold,
          customTexDataURL: sb.customTexDataURL ?? null,
          matterState: sb.matterState ?? box.matterState,
          bounciness: Number(sb.bounciness) || 0,
          conveyorVz: Number(sb.conveyorVz) || 0,
          conveyorVx: Number(sb.conveyorVx) || 0,
          damageOnContact: Number(sb.damageOnContact) || 0,
          teleportToCheckpoint: !!sb.teleportToCheckpoint,
          spinSpeed: Number(sb.spinSpeed) || 0
        });
      }

      if (sb.parentKey !== undefined) box.parentKey = sb.parentKey;
      if (sb.hierOrder !== undefined) box.hierOrder = sb.hierOrder;
      if (sb.components) box.components = JSON.parse(JSON.stringify(sb.components));
      if (sb.interactionData) box.interactionData = JSON.parse(JSON.stringify(sb.interactionData));
      if (sb.motionData) box.motionData = JSON.parse(JSON.stringify(sb.motionData));
      if (sb.signalData) box.signalData = JSON.parse(JSON.stringify(sb.signalData));
      if (sb.costData) box.costData = JSON.parse(JSON.stringify(sb.costData));
      if (sb.soundData) box.soundData = JSON.parse(JSON.stringify(sb.soundData));
      if (sb.mediaScreenData !== undefined) {
        box.mediaScreenData = sb.mediaScreenData ? JSON.parse(JSON.stringify(sb.mediaScreenData)) : null;
      }
      if (sb.soundEmitterData !== undefined) {
        box.soundEmitterData = sb.soundEmitterData ? JSON.parse(JSON.stringify(sb.soundEmitterData)) : null;
      }
      if (sb.lightData) box.lightData = JSON.parse(JSON.stringify(sb.lightData));
      if (sb.particleData) box.particleData = JSON.parse(JSON.stringify(sb.particleData));
      if (sb.checkpointData) box.checkpointData = JSON.parse(JSON.stringify(sb.checkpointData));
      if (sb.spawnerData) box.spawnerData = JSON.parse(JSON.stringify(sb.spawnerData));
      if (sb.logicData) box.logicData = JSON.parse(JSON.stringify(sb.logicData));
      if (sb.colliderScale) box.colliderScale = Object.assign({}, sb.colliderScale);

      box.m.scale.set(sb.w || 1, sb.h || 1, sb.d || 1);
      if (sb.cy !== undefined) {
        box.m.position.set(sb.cx ?? sb.x ?? 0, sb.cy, sb.cz ?? sb.z ?? 0);
      } else {
        box.m.position.set(sb.x || 0, (sb.y || 0) - (sb.h || 1) / 2, sb.z || 0);
      }
      box.m.rotation.set(sb.rx || 0, sb.ry || 0, sb.rz || 0);
      box.m.updateMatrixWorld(true);

      if (box.logicRuntime) {
        box.logicRuntime.basePos = box.m.position.clone();
        box.logicRuntime.baseQuat = box.m.quaternion.clone();
        box.logicRuntime.baseScale = box.m.scale.clone();
      }
      syncBlockComponentsState(box);
      rebuildPhysicsArrays();
    } else if (pkt.op === 'block_delete' && pkt.blockId) {
      const idx = S.allBlocks.findIndex(b => b && b.id === pkt.blockId);
      if (idx >= 0) {
        const box = S.allBlocks[idx];
        removeBlockHalo(box);
        scene.remove(box.m);
        if (box.cpVisualGroup) scene.remove(box.cpVisualGroup);
        S.allBlocks.splice(idx, 1);
        rebuildPhysicsArrays();
      }
    } else if (pkt.op === 'world_item_upsert' && pkt.worldItem) {
      const sw = pkt.worldItem;
      let wi = S.worldItems.find(w => w && w.id === sw.id);
      if (!wi) {
        wi = spawnWorldItem(sw.item, sw.x ?? 0, sw.y ?? 1.5, sw.z ?? 0, 0, 0, 0, {
          id: sw.id,
          rotX: sw.rotX || 0,
          rotY: sw.rotY || 0,
          rotZ: sw.rotZ || 0,
          scaleX: sw.scaleX || 1,
          scaleY: sw.scaleY || 1,
          scaleZ: sw.scaleZ || 1
        });
      } else {
        wi.x = sw.x ?? wi.x;
        wi.y = sw.y ?? wi.y;
        wi.z = sw.z ?? wi.z;
        wi.rotX = sw.rotX ?? wi.rotX;
        wi.rotY = sw.rotY ?? wi.rotY;
        wi.rotZ = sw.rotZ ?? wi.rotZ;
        wi.scaleX = sw.scaleX ?? wi.scaleX;
        wi.scaleY = sw.scaleY ?? wi.scaleY;
        wi.scaleZ = sw.scaleZ ?? wi.scaleZ;
        wi.item = normalizeItemData(sw.item);
        rebuildWorldItemVisual(wi, false);
      }
      if (sw.parentKey !== undefined) wi.parentKey = sw.parentKey;
      if (sw.hierOrder !== undefined) wi.hierOrder = sw.hierOrder;
    } else if (pkt.op === 'world_item_delete' && pkt.itemId) {
      const idx = S.worldItems.findIndex(w => w && w.id === pkt.itemId);
      if (idx >= 0) {
        const wi = S.worldItems[idx];
        if (wi.group) scene.remove(wi.group);
        if (wi.tag) scene.remove(wi.tag);
        S.worldItems.splice(idx, 1);
      }
    } else if (pkt.op === 'npc_upsert' && pkt.npc) {
      const sn = pkt.npc;
      let npc = S.customNPCs.find(n => n && n.id === sn.id);
      if (!npc) {
        npc = spawnCustomNPC(Object.assign({}, sn.preset, sn));
      } else {
        npc.name = sn.name ?? npc.name;
        npc.chat = sn.chat ?? npc.chat;
        npc.hpEnabled = sn.hpEnabled !== undefined ? sn.hpEnabled : npc.hpEnabled;
        npc.hp = sn.hp ?? npc.hp;
        npc.maxHp = sn.maxHp ?? npc.maxHp;
        npc.meleeDamage = sn.meleeDamage ?? npc.meleeDamage;
        npc.walkSpeed = sn.walkSpeed ?? npc.walkSpeed;
        npc.jumpPower = sn.jumpPower ?? npc.jumpPower;
        npc.x = sn.x ?? npc.x;
        npc.y = sn.y ?? npc.y;
        npc.z = sn.z ?? npc.z;
        npc.netX = npc.x;
        npc.netY = npc.y;
        npc.netZ = npc.z;
        npc.rot = sn.rot ?? npc.rot;
        npc.netRot = npc.rot;
        npc.homeX = sn.homeX ?? npc.x;
        npc.homeY = sn.homeY ?? npc.y;
        npc.homeZ = sn.homeZ ?? npc.z;
        npc.equippedItem = sn.equippedItem ? normalizeItemData(sn.equippedItem) : null;
        if (sn.aiModules) {
          npc.aiModules = JSON.parse(JSON.stringify(sn.aiModules));
          ensureNpcModules(npc);
        }
        if (sn.preset) {
          npc.preset = JSON.parse(JSON.stringify(sn.preset));
          normalizeCharacterGripPoints(npc.preset, sn);
          syncRigAppearanceFromPreset(npc.rig, npc.preset, false);
          if (npc.rig.syncCustomCosmetics) {
            npc.rig.syncCustomCosmetics(npc.preset.customCosmetics || []);
          }
          if (npc.rig.syncGripSockets) {
            npc.rig.syncGripSockets(npc.preset);
          }
        }
        if (sn.scale && npc.rig?.g) {
          npc.rig.g.scale.setScalar(sn.scale);
        }
        if (npc.rig?.g) {
          npc.rig.g.position.set(npc.x, npc.y, npc.z);
          npc.rig.g.rotation.y = npc.rot;
          npc.rig.g.updateMatrixWorld(true);
        }
        if (npc.tag) {
          npc.tag.position.set(npc.x, npc.y + 3.35, npc.z);
        }
        attachRigToEntity(npc);
        syncEntityHeldItemMesh(npc);
        refreshEntityTagWithHP(npc);
      }
      if (sn.parentKey !== undefined) npc.parentKey = sn.parentKey;
      if (sn.hierOrder !== undefined) npc.hierOrder = sn.hierOrder;
    } else if (pkt.op === 'npc_delete' && pkt.npcId) {
      const idx = S.customNPCs.findIndex(n => n && n.id === pkt.npcId);
      if (idx >= 0) {
        const npc = S.customNPCs[idx];
        if (npc.rig?.g) scene.remove(npc.rig.g);
        if (npc.tag) scene.remove(npc.tag);
        S.customNPCs.splice(idx, 1);
      }
    } else if (pkt.op === 'asset_sync_chunk' && pkt.transferId) {
      let entry = incomingAssetChunks.get(pkt.transferId);
      if (!entry) {
        entry = { chunks: new Array(pkt.totalChunks), received: 0, total: pkt.totalChunks, assetType: pkt.assetType };
        incomingAssetChunks.set(pkt.transferId, entry);
      }
      if (entry.chunks[pkt.chunkIdx] === undefined) {
        entry.chunks[pkt.chunkIdx] = pkt.data;
        entry.received++;
      }
      if (entry.received >= entry.total) {
        incomingAssetChunks.delete(pkt.transferId);
        try {
          const fullAsset = JSON.parse(entry.chunks.join(''));
          handleWorldOpPacket({ op: 'asset_sync', assetType: entry.assetType, assetData: fullAsset });
        } catch (_) {}
      }
    } else if (pkt.op === 'asset_sync' && pkt.assetData) {
      const ad = pkt.assetData;
      if (pkt.assetType === 'prefab') {
        const idx = S.customPrefabsLibrary.findIndex(p => p.id === ad.id);
        if (idx >= 0) S.customPrefabsLibrary[idx] = ad;
        else S.customPrefabsLibrary.push(ad);
        refreshPrefabDockUI();
      } else if (pkt.assetType === 'video') {
        if (!Array.isArray(S.customVideoLibrary)) S.customVideoLibrary = [];
        const idx = S.customVideoLibrary.findIndex(v => v.id === ad.id);
        if (idx >= 0) S.customVideoLibrary[idx] = ad;
        else S.customVideoLibrary.push(ad);
        showBanner(`🎬 Подгружено видео в сессии: «${ad.name}»!`, '#56f0ff');
      } else if (pkt.assetType === 'audio') {
        const idx = S.customAudioLibrary.findIndex(a => a.id === ad.id);
        if (idx >= 0) S.customAudioLibrary[idx] = ad;
        else S.customAudioLibrary.push(ad);
        // Если эта загруженная музыка или эмбиент уже выбраны в мире — сразу запускаем их у игрока без перезапуска!
        if (S.worldSettings.musicPreset === 'custom:' + ad.id) {
          setWorldMusic(S.worldSettings.musicPreset);
        }
        if (S.worldSettings.ambiencePreset === 'custom:' + ad.id) {
          setWorldAmbience(S.worldSettings.ambiencePreset);
        }
        showBanner(`🎵 Подгружено новое аудио в сессии: «${ad.name}»!`, '#56f0ff');
      } else if (pkt.assetType === 'item_lib') {
        const idx = S.savedItemsLibrary.findIndex(i => i.id === ad.id);
        if (idx >= 0) S.savedItemsLibrary[idx] = ad;
        else S.savedItemsLibrary.push(ad);
        refreshPrefabDockUI();
      } else if (pkt.assetType === 'cosmetic_lib') {
        const idx = S.savedCosmeticsLibrary.findIndex(c => c.id === ad.id);
        if (idx >= 0) S.savedCosmeticsLibrary[idx] = ad;
        else S.savedCosmeticsLibrary.push(ad);
        refreshPrefabDockUI();
      }
    }
  } finally {
    S.isApplyingRemoteSync = false;
  }
}

/* ---------- СЕТЕВЫЕ ТРАНСПОРТЫ: PEERJS (WEBRTC) + WEBSOCKET + BROADCASTCHANNEL ---------- */

function toPeerIdFromRoom(roomCode) {
  const clean = (roomCode || 'RADMIN-1').trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  return 'debix-ugc-room-' + (clean || 'DEFAULT');
}

function setupPeerConnectionHandlers(conn, autoDownloadWorld = false) {
  if (!conn) return;
  conn.on('open', () => {
    peerConnections.set(conn.peer, conn);
    S.mpState.connected = true;
    S.mpState.statusText = `✅ Подключено (${peerConnections.size} соед.) · Комната: ${S.mpState.roomCode}`;
    refreshMultiplayerUI();
    sfx.coil?.();

    if (S.mpState.isHost) {
      showBanner(`🌐 Игрок подключился к серверу «${S.mpState.roomCode}»! Отправляем карту...`, '#00e676');
      sendWorldSnapshotToPeer(conn.peer);
      broadcastHostServerBeacon();
    } else if (autoDownloadWorld) {
      requestWorldSnapshotFromHost();
    }
    sendImmediateFullState();
  });

  conn.on('data', data => {
    if (!data || typeof data !== 'object') return;
    handleIncomingPacket(data, conn.peer);

    if (S.mpState.isHost) {
      for (const [pid, otherConn] of peerConnections.entries()) {
        if (pid !== conn.peer && otherConn.open) {
          if (data.targetPeerId && data.targetPeerId !== pid) continue;
          try { otherConn.send(data); } catch (_) {}
        }
      }
    }
  });

  const onCloseOrErr = () => {
    peerConnections.delete(conn.peer);
    refreshMultiplayerUI();
  };
  conn.on('close', onCloseOrErr);
  conn.on('error', onCloseOrErr);
}

export function startPeerHost(roomCode = 'RADMIN-1', autoEnterPlay = false) {
  disconnectMultiplayerNetwork(false);
  S.mpState.roomCode = (roomCode || 'RADMIN-1').trim().toUpperCase() || 'RADMIN-1';
  S.mpState.isHost = true;
  S.mpState.connected = true;

  // Если мы ещё в меню и карта не инициализирована, запускаем игровую сессию
  if (autoEnterPlay && S.state === 'menu') {
    startPlaySession();
  }

  broadcastHostServerBeacon();
  refreshServerBrowserListDOM();

  if (typeof window.Peer === 'undefined') {
    S.mpState.statusText = `👑 Локальный Хост «${S.mpState.roomCode}» активен (LAN / Вкладки)`;
    refreshMultiplayerUI();
    showBanner(`👑 Сервер «${S.mpState.roomCode}» открыт!`, '#00e676');
    return;
  }

  const hostPeerId = toPeerIdFromRoom(S.mpState.roomCode);
  S.mpState.statusText = `⏳ Запуск сервера «${S.mpState.roomCode}»...`;
  refreshMultiplayerUI();

  peerInstance = new window.Peer(hostPeerId, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    }
  });

  peerInstance.on('open', () => {
    S.mpState.connected = true;
    S.mpState.isHost = true;
    S.mpState.statusText = `👑 Ты ХОСТ сервера «${S.mpState.roomCode}»! Он виден во вкладке «Серверы».`;
    refreshMultiplayerUI();
    broadcastHostServerBeacon();
    sfx.checkpoint?.();
    showBanner(`👑 Сервер «${S.mpState.roomCode}» создан и доступен во вкладке «Серверы»!`, '#00e676');
  });

  peerInstance.on('connection', conn => {
    setupPeerConnectionHandlers(conn, false);
  });

  peerInstance.on('error', err => {
    if (err && err.type === 'unavailable-id') {
      S.mpState.isHost = false;
      S.mpState.statusText = `ℹ️ Сервер «${S.mpState.roomCode}» уже активен! Подключаемся...`;
      refreshMultiplayerUI();
      joinPeerRoom(S.mpState.roomCode, true);
    } else {
      S.mpState.statusText = `👑 Сервер «${S.mpState.roomCode}» (LAN режим)`;
      refreshMultiplayerUI();
    }
  });
}

export function joinPeerRoom(roomCode = 'RADMIN-1', autoDownloadWorld = true) {
  disconnectMultiplayerNetwork(false);
  S.mpState.roomCode = (roomCode || 'RADMIN-1').trim().toUpperCase() || 'RADMIN-1';
  S.mpState.isHost = false;

  if (typeof window.Peer === 'undefined') {
    showWorldDownloadProgress(false);
    showBanner('⚠️ PeerJS недоступен. Подключаемся через LAN WebSocket...', '#ffce3a');
    connectDirectWebSocket(S.mpState.wsUrl || getDefaultWsUrl(), S.mpState.roomCode, autoDownloadWorld);
    return;
  }

  const hostPeerId = toPeerIdFromRoom(S.mpState.roomCode);
  S.mpState.statusText = `⏳ Подключение к серверу «${S.mpState.roomCode}»...`;
  refreshMultiplayerUI();

  peerInstance = new window.Peer(undefined, {
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    }
  });

  peerInstance.on('open', () => {
    const conn = peerInstance.connect(hostPeerId, { reliable: true });
    setupPeerConnectionHandlers(conn, autoDownloadWorld);
  });

  peerInstance.on('error', err => {
    showWorldDownloadProgress(false);
    S.mpState.statusText = `❌ Сервер «${S.mpState.roomCode}» не найден (${err?.type || 'ошибка'})`;
    refreshMultiplayerUI();
    showBanner(`❌ Сервер «${S.mpState.roomCode}» не отвечает.`, '#ff3e3e');
  });
}

export function connectDirectWebSocket(url, roomCode = null, autoDownloadWorld = true) {
  const cleanUrl = (url || getDefaultWsUrl()).trim();
  if (!cleanUrl.startsWith('ws://') && !cleanUrl.startsWith('wss://')) {
    showWorldDownloadProgress(false);
    showBanner('⚠️ Адрес должен начинаться с ws:// (например ws://26.x.x.x:8765)', '#ffce3a');
    return;
  }
  if (roomCode) S.mpState.roomCode = roomCode;
  if (wsConnection) {
    try { wsConnection.close(); } catch (_) {}
    wsConnection = null;
  }

  S.mpState.wsUrl = cleanUrl;
  try { localStorage.setItem(WS_URL_STORAGE_KEY, cleanUrl); } catch (_) {}
  S.mpState.statusText = `⏳ Подключение к ${cleanUrl}...`;
  refreshMultiplayerUI();

  try {
    wsConnection = new WebSocket(cleanUrl);
    wsConnection.onopen = () => {
      S.mpState.connected = true;
      S.mpState.statusText = `🖧 Подключено к LAN/Radmin серверу (${cleanUrl})`;
      refreshMultiplayerUI();
      sfx.checkpoint?.();
      sendImmediateFullState();

      if (S.mpState.isHost) {
        broadcastHostServerBeacon();
      } else if (autoDownloadWorld) {
        requestWorldSnapshotFromHost();
      }
    };
    wsConnection.onmessage = ev => {
      try {
        const data = JSON.parse(ev.data);
        if (data.type === 'server_list_update' && Array.isArray(data.servers)) {
          for (const srv of data.servers) {
            if (srv && srv.roomId) {
              discoveredServers.set(srv.roomId, Object.assign({}, srv, { wsUrl: cleanUrl, updatedAt: Date.now() }));
            }
          }
          refreshServerBrowserListDOM();
          return;
        }
        if (data.type === 'hub_catalog_update' && Array.isArray(data.items)) {
          for (const it of data.items) {
            if (it && it.id) ugcHubItems.set(it.id, it);
          }
          saveLocalUgcHubCache();
          refreshUgcHubDOM();
          return;
        }
        handleIncomingPacket(data);
      } catch (_) {}
    };
    wsConnection.onclose = () => {
      wsConnection = null;
      showWorldDownloadProgress(false);
      S.mpState.statusText = `🔌 Соединение с ${cleanUrl} закрыто`;
      refreshMultiplayerUI();
    };
    wsConnection.onerror = () => {
      showWorldDownloadProgress(false);
      S.mpState.statusText = `❌ Не удалось подключиться к ${cleanUrl}`;
      refreshMultiplayerUI();
    };
  } catch (err) {
    showWorldDownloadProgress(false);
    showBanner(`❌ Ошибка WebSocket: ${err.message}`, '#ff3e3e');
  }
}

export function disconnectMultiplayerNetwork(clearRemotes = true) {
  if (S.mpState.isHost && S.mpState.roomCode) {
    discoveredServers.delete(S.mpState.roomCode);
    const unreg = JSON.stringify({ type: 'unregister_server', roomId: S.mpState.roomCode });
    if (wsConnection && wsConnection.readyState === 1) {
      try { wsConnection.send(unreg); } catch (_) {}
    }
    if (discoveryWs && discoveryWs.readyState === 1) {
      try { discoveryWs.send(unreg); } catch (_) {}
    }
  }

  for (const conn of peerConnections.values()) {
    try { conn.close(); } catch (_) {}
  }
  peerConnections.clear();

  if (peerInstance) {
    try { peerInstance.destroy(); } catch (_) {}
    peerInstance = null;
  }
  if (wsConnection) {
    try { wsConnection.close(); } catch (_) {}
    wsConnection = null;
  }

  S.mpState.connected = false;
  S.mpState.isHost = false;
  S.mpState.statusText = 'Отключено от внешней сети (локальные вкладки активны)';

  if (clearRemotes) {
    clearAllRemotePlayers();
  }
  refreshMultiplayerUI();
  refreshServerBrowserListDOM();
}

export function broadcastMultiplayerPacket(payload) {
  if (!payload) return;
  const packet = Object.assign({}, payload, {
    senderId: S.mpState.peerId,
    senderName: S.playerName || 'Player',
    roomCode: S.mpState.roomCode || 'RADMIN-1',
    ts: Date.now()
  });

  if (localChannel) {
    try { localChannel.postMessage(packet); } catch (_) {}
  }

  for (const [pid, conn] of peerConnections.entries()) {
    if (conn && conn.open) {
      if (packet.targetPeerId && packet.targetPeerId !== pid) continue;
      try { conn.send(packet); } catch (_) {}
    }
  }

  if (wsConnection && wsConnection.readyState === 1) {
    try { wsConnection.send(JSON.stringify(packet)); } catch (_) {}
  }
}

/* ---------- УПРАВЛЕНИЕ АВАТАРАМИ УДАЛЁННЫХ ИГРОКОВ В 3D-МИРЕ ---------- */

function getOrCreateRemotePlayer(peerId, pkt) {
  if (!peerId || peerId === S.mpState.peerId) return null;
  let rem = S.remotePlayers[peerId];
  if (rem && rem.rig && rem.rig.g) {
    if (!rem.rig.g.parent) scene.add(rem.rig.g);
    if (rem.tag && !rem.tag.parent) scene.add(rem.tag);
    return rem;
  }

  const preset = pkt.preset || {
    head: 0xf5cd30,
    torso: 0x00a2ff,
    armL: 0xf5cd30,
    armR: 0xf5cd30,
    legL: 0x2ecc71,
    legR: 0x2ecc71,
    limbTex: {},
    customCosmetics: []
  };
  normalizeCharacterGripPoints(preset);

  const rig = createRobloxRig(preset, pkt.scale || 1, false);
  const tag = makeTagSprite(280, 105, 3.0, 1.1);
  const x = Number(pkt.x) || 0;
  const y = Number(pkt.y) || 1;
  const z = Number(pkt.z) || 8;

  rig.g.position.set(x, y, z);
  scene.add(rig.g, tag);

  rem = {
    id: 'remote_' + peerId,
    peerId,
    isP: false,
    isRemotePlayer: true,
    isCustomNPC: false,
    name: pkt.senderName || pkt.name || 'Игрок',
    x,
    y,
    z,
    netX: x,
    netY: y,
    netZ: z,
    rot: Number(pkt.rot) || 0,
    netRot: Number(pkt.rot) || 0,
    pitch: Number(pkt.pitch) || 0,
    netPitch: Number(pkt.pitch) || 0,
    vxKnock: 0,
    vzKnock: 0,
    vy: 0,
    step: 0,
    moving: false,
    sprinting: false,
    grounded: true,
    inLiquid: false,
    hpEnabled: true,
    hp: Number(pkt.hp) || 100,
    maxHp: Number(pkt.maxHp) || 100,
    hpBarTimer: 0,
    chat: '',
    chatT: 0,
    preset,
    presetHash: JSON.stringify(preset),
    equippedItem: null,
    carriedItem: null,
    heldHash: '',
    rig,
    tag,
    lastSeen: performance.now()
  };

  attachRigToEntity(rem);
  S.remotePlayers[peerId] = rem;
  refreshEntityTagWithHP(rem);
  refreshMultiplayerUI();
  appendChatMessage('Система', `👋 ${rem.name} присоединился к миру!`, 'sys');
  return rem;
}

export function removeRemotePlayer(peerId) {
  const rem = S.remotePlayers[peerId];
  if (!rem) return;
  const leftName = rem.name || 'Игрок';
  if (rem.rig?.g) scene.remove(rem.rig.g);
  if (rem.tag) scene.remove(rem.tag);
  delete S.remotePlayers[peerId];
  refreshMultiplayerUI();
  appendChatMessage('Система', `🔌 ${leftName} покинул мир.`, 'sys');
}

export function clearAllRemotePlayers() {
  for (const pid of Object.keys(S.remotePlayers)) {
    removeRemotePlayer(pid);
  }
}

export function reattachRemotePlayersToScene() {
  for (const rem of Object.values(S.remotePlayers)) {
    if (rem.rig?.g && !rem.rig.g.parent) scene.add(rem.rig.g);
    if (rem.tag && !rem.tag.parent) scene.add(rem.tag);
  }
}

function handleIncomingPacket(pkt, fromConnPeerId = null) {
  if (!pkt || !pkt.senderId || pkt.senderId === S.mpState.peerId) return;

  // Системные пакеты обнаружения серверов
  if (pkt.type === 'server_beacon' && pkt.serverInfo) {
    discoveredServers.set(pkt.serverInfo.roomId, Object.assign({}, pkt.serverInfo, { updatedAt: Date.now() }));
    refreshServerBrowserListDOM();
    return;
  }
  if (pkt.type === 'request_beacons') {
    if (S.mpState.isHost) broadcastHostServerBeacon();
    return;
  }
  if (pkt.type === 'hub_item_broadcast' && pkt.item && pkt.item.id) {
    ugcHubItems.set(pkt.item.id, pkt.item);
    saveLocalUgcHubCache();
    refreshUgcHubDOM();
    return;
  }
  if (pkt.type === 'hub_item_delete' && pkt.id) {
    if (ugcHubItems.has(pkt.id)) {
      ugcHubItems.delete(pkt.id);
      saveLocalUgcHubCache();
      refreshUgcHubDOM();
    }
    return;
  }
  if (pkt.type === 'request_hub_catalog') {
    for (const item of ugcHubItems.values()) {
      broadcastMultiplayerPacket({
        type: 'hub_item_broadcast',
        targetPeerId: pkt.senderId,
        item
      });
    }
    return;
  }
  if (pkt.type === 'hub_catalog_update') {
    if (Array.isArray(pkt.items)) {
      for (const it of pkt.items) {
        if (it && it.id) ugcHubItems.set(it.id, it);
      }
    } else if (pkt.item && pkt.item.id) {
      ugcHubItems.set(pkt.item.id, pkt.item);
    }
    saveLocalUgcHubCache();
    refreshUgcHubDOM();
    return;
  }

  // Пакеты скачивания карты и синхронизации мира
  if (pkt.type === 'request_world_snapshot') {
    if (S.mpState.isHost || Object.keys(S.remotePlayers).length <= 1) {
      sendWorldSnapshotToPeer(fromConnPeerId || pkt.senderId);
    }
    return;
  }
  if (pkt.type === 'world_snapshot_chunk') {
    handleIncomingSnapshotChunk(pkt);
    return;
  }
  if (pkt.type === 'world_op') {
    handleWorldOpPacket(pkt);
    return;
  }

  if (pkt.type === 'leave') {
    removeRemotePlayer(pkt.senderId);
    return;
  }

  const rem = getOrCreateRemotePlayer(pkt.senderId, pkt);
  if (!rem) return;
  rem.lastSeen = performance.now();

  if (pkt.senderName && rem.name !== pkt.senderName) {
    rem.name = pkt.senderName;
    refreshEntityTagWithHP(rem);
  }

  if (pkt.type === 'chat_msg' && pkt.text) {
    rem.chat = pkt.text;
    rem.chatT = 4.5;
    pushEntityChatBubble(rem, pkt.text, 5.2);
    refreshEntityTagWithHP(rem);
    appendChatMessage(rem.name, pkt.text, 'remote');
    sfx.click?.();
    return;
  }

    if (pkt.type === 'state' || pkt.type === 'full_state') {
    rem.netX = Number(pkt.x) ?? rem.x;
    rem.netY = Number(pkt.y) ?? rem.y;
    rem.netZ = Number(pkt.z) ?? rem.z;
    rem.netRot = Number(pkt.rot) ?? rem.rot;
    if (pkt.pitch !== undefined) rem.netPitch = Number(pkt.pitch) || 0;
    rem.moving = !!pkt.moving;
    rem.sprinting = !!pkt.sprinting;
    if (pkt.gait) rem.gait = pkt.gait;
    rem.grounded = pkt.grounded !== undefined ? !!pkt.grounded : true;
    rem.inLiquid = !!pkt.inLiquid;
    rem.vy = Number(pkt.vy) || 0;

    if (pkt.hp !== undefined && pkt.hp !== rem.hp) {
      rem.hp = pkt.hp;
      rem.maxHp = pkt.maxHp || 100;
      refreshEntityTagWithHP(rem);
    }

    if (pkt.chat !== undefined && pkt.chat !== rem.chat) {
      rem.chat = pkt.chat;
      rem.chatT = pkt.chat ? 3.5 : 0;
      refreshEntityTagWithHP(rem);
    }

    if (pkt.activeEmote !== rem.activeEmote) {
      if (pkt.activeEmote) triggerEntityEmote(rem, pkt.activeEmote);
      else stopEntityEmote(rem);
    }

    if (pkt.preset) {
      const h = JSON.stringify(pkt.preset);
      if (h !== rem.presetHash) {
        rem.presetHash = h;
        rem.preset = pkt.preset;
        syncRigAppearanceFromPreset(rem.rig, rem.preset, false);
        if (rem.rig.syncCustomCosmetics) {
          rem.rig.syncCustomCosmetics(rem.preset.customCosmetics || []);
        }
      }
    }

    if (pkt.held !== undefined || pkt.carried !== undefined) {
      const hh = JSON.stringify({ h: pkt.held, c: pkt.carried });
      if (hh !== rem.heldHash) {
        rem.heldHash = hh;
        rem.equippedItem = pkt.held ? normalizeItemData(pkt.held) : null;
        rem.carriedItem = pkt.carried ? normalizeItemData(pkt.carried) : null;
        syncEntityHeldItemMesh(rem);
      }
    }
    if (pkt.isAiming !== undefined || pkt.isChargingThrow !== undefined) {
      if (pkt.isChargingThrow && rem.equippedItem) {
        rem.holdPose = 'throw_charge';
      } else if (pkt.isAiming && rem.equippedItem) {
        rem.holdPose = 'aim';
      } else if (rem.equippedItem && !rem.carriedItem) {
        rem.holdPose = rem.equippedItem.useType === 'shield'
          ? 'shield'
          : (rem.equippedItem.useType === 'ranged' ? 'aim' : 'weapon');
      }
    }

    if (pkt.playerDead !== undefined) {
      rem.rig.g.visible = !pkt.playerDead;
      rem.tag.visible = !pkt.playerDead;
    }
  } else if (pkt.type === 'profile') {
    if (pkt.name) rem.name = pkt.name;
    if (pkt.preset) {
      rem.preset = pkt.preset;
      syncRigAppearanceFromPreset(rem.rig, rem.preset, false);
      if (rem.rig.syncCustomCosmetics) {
        rem.rig.syncCustomCosmetics(rem.preset.customCosmetics || []);
      }
    }
    refreshEntityTagWithHP(rem);
  } else if (pkt.type === 'emote') {
    if (pkt.emoteId) {
      const def = triggerEntityEmote(rem, pkt.emoteId);
      if (def?.chat) {
        rem.chat = def.chat;
        rem.chatT = 3.2;
        refreshEntityTagWithHP(rem);
      }
    } else {
      stopEntityEmote(rem);
    }
  } else if (pkt.type === 'attack') {
    triggerEntityAttack(rem, pkt.style || 'punch');
    if (pkt.style === 'shoot') sfx.zap?.();
    else sfx.swing?.();
  } else if (pkt.type === 'hit_player') {
    if (pkt.targetPeerId === S.mpState.peerId && S.player && !S.playerDead) {
      if (window.__debixApplyRemotePlayerHit) {
        window.__debixApplyRemotePlayerHit(pkt);
      } else {
        const p = S.player;
        const dmg = Math.max(0, Number(pkt.damage) || 0);
        p.vxKnock = Number(pkt.vxKnock) || 0;
        p.vzKnock = Number(pkt.vzKnock) || 0;
        if (dmg > 0 && p.hpEnabled) {
          p.hp = Math.max(0, p.hp - dmg);
          p.hpBarTimer = 3.5;
          sfx.hit?.();
          spawnDamageParticles(p);
          refreshEntityTagWithHP(p);
          updateShopUI();
        }
      }
      sendImmediateFullState();
    } else if (S.remotePlayers[pkt.targetPeerId]) {
      const targetRem = S.remotePlayers[pkt.targetPeerId];
      const dmg = Math.max(0, Number(pkt.damage) || 0);
      if (dmg > 0) targetRem.hp = Math.max(0, (targetRem.hp ?? 100) - dmg);
      targetRem.hpBarTimer = 3.5;
      spawnDamageParticles(targetRem);
      refreshEntityTagWithHP(targetRem);
    }
  } else if (pkt.type === 'block_logic') {
    const blk = S.allBlocks.find(b => b && b.id === pkt.blockId);
    if (blk && window.__debixTriggerBlockFromNet) {
      window.__debixTriggerBlockFromNet(blk, pkt.triggerSource || 'keyE');
    }
  } else if (pkt.type === 'npc_state_batch' && Array.isArray(pkt.list)) {
    if (!S.mpState.isHost) {
      lastRemoteNpcBatchTime = performance.now();
      for (let i = 0; i < pkt.list.length; i++) {
        const st = pkt.list[i];
        const npc = S.customNPCs.find(n => n && n.id === st.id);
        if (!npc) continue;

        npc.netX = Number(st.x) ?? npc.x;
        npc.netY = Number(st.y) ?? npc.y;
        npc.netZ = Number(st.z) ?? npc.z;
        npc.netRot = Number(st.rot) ?? npc.rot;
        if (st.pitch !== undefined) npc.pitch = Number(st.pitch) || 0;
        npc.vy = Number(st.vy) || 0;
        npc._netMoving = !!st.mov;
        npc.sprinting = !!st.spr;
        npc.grounded = st.gnd !== false;
        npc.inLiquid = !!st.liq;

        const wasDead = (npc._deadCooldown || 0) > 0;
        const isDeadNow = !!st.dead;
        npc._deadCooldown = isDeadNow ? 1.0 : 0;
        if (npc.rig?.g) npc.rig.g.visible = !isDeadNow;
        if (npc.tag) npc.tag.visible = !isDeadNow;

        if (!wasDead && isDeadNow) {
          sfx.oof?.();
          spawnDeathShatter(npc);
        }

        let needTagRefresh = false;
        if (st.hp !== undefined && st.hp !== npc.hp) {
          if (st.hp < npc.hp) npc.hpBarTimer = 3.5;
          npc.hp = st.hp;
          npc.maxHp = st.mhp || npc.maxHp || 100;
          needTagRefresh = true;
        }
        if (st.chat !== undefined && st.chat !== npc.chat) {
          npc.chat = st.chat;
          npc.chatT = st.chat ? 3.5 : 0;
          needTagRefresh = true;
        }
        if (needTagRefresh) {
          refreshEntityTagWithHP(npc);
        }
      }
    }
  } else if (pkt.type === 'npc_damage' && pkt.npcId) {
    const npc = S.customNPCs.find(n => n && n.id === pkt.npcId);
    if (npc && isLocalNpcAuthority() && window.__debixApplyRemoteNpcDamage) {
      window.__debixApplyRemoteNpcDamage(npc, pkt, rem);
    }
  } else if (pkt.type === 'npc_hit_fx' && pkt.npcId) {
    const npc = S.customNPCs.find(n => n && n.id === pkt.npcId);
    if (npc) {
      npc.hp = pkt.hp ?? npc.hp;
      npc.maxHp = pkt.maxHp ?? npc.maxHp;
      npc.hpBarTimer = 3.5;
      if (pkt.chat) {
        npc.chat = pkt.chat;
        npc.chatT = 3.5;
      }
      sfx.hit?.();
      spawnDamageParticles(npc);
      if (pkt.fatal) {
        sfx.oof?.();
        spawnDeathShatter(npc);
        npc._deadCooldown = 1.5;
        if (npc.rig?.g) npc.rig.g.visible = false;
        if (npc.tag) npc.tag.visible = false;
      }
      refreshEntityTagWithHP(npc);
    }
  } else if (pkt.type === 'npc_kill_reward') {
    if (pkt.targetPeerId === S.mpState.peerId && S.player) {
      const baseCoins = Math.max(0, Number(pkt.coins) || 0);
      if (baseCoins > 0) {
        const earned = baseCoins * (S.player.hasHalo ? 2 : 1);
        S.player.cash = (S.player.cash || 0) + earned;
        sfx.cash?.();
        updateShopUI();
        showBanner(`🪙 +${earned} R$ за победу над «${pkt.npcName || 'NPC'}»!`, '#ffce3a');
      }
    }
  } else if (pkt.type === 'npc_action_fx' && pkt.npcId) {
    const npc = S.customNPCs.find(n => n && n.id === pkt.npcId);
    if (npc) {
      if (pkt.rot !== undefined) {
        npc.rot = pkt.rot;
        npc.netRot = pkt.rot;
      }
      triggerEntityAttack(npc, pkt.style || 'punch');
      if (pkt.style === 'shoot') sfx.zap?.();
      else sfx.swing?.();
      if (pkt.projectile && window.__debixSpawnVisualProjectileFromNet) {
        window.__debixSpawnVisualProjectileFromNet(npc, pkt.projectile);
      }
    }
  } else if (pkt.type === 'player_projectile' && pkt.projectile) {
    if (window.__debixSpawnVisualProjectileFromNet) {
      window.__debixSpawnVisualProjectileFromNet(rem, pkt.projectile);
    }
  } else if (pkt.type === 'npc_dialogue' && pkt.npcId) {
    const npc = S.customNPCs.find(n => n && n.id === pkt.npcId);
    if (npc) {
      npc.chat = pkt.line || npc.chat;
      npc.chatT = 5.0;
      npc._hesitateTimer = 1.8;
      if (pkt.rot !== undefined) {
        npc.rot = pkt.rot;
        npc.netRot = pkt.rot;
      }
      sfx.click?.();
      refreshEntityTagWithHP(npc);
    }
  }
}

let lastBroadcastedHeldSig = '';

export function sendImmediateFullState() {
  const p = S.player;
  if (!p) return;
  const held = p.inventory ? p.inventory[S.activeSlot] : null;
  lastBroadcastedHeldSig = `${held?.id || ''}|${held?.name || ''}|${p.carriedItem?.id || ''}|${p.carriedItem?.name || ''}`;
  broadcastMultiplayerPacket({
    type: 'full_state',
    x: p.x,
    y: p.y,
    z: p.z,
    rot: p.rot,
    pitch: Math.round((S.pitch || 0) * 100) / 100,
    vy: p.vy,
    moving: false,
    sprinting: !!p.sprinting,
    gait: p.gait || 'normal',
    grounded: p.grounded,
    inLiquid: p.inLiquid,
    hp: p.hp,
    maxHp: p.maxHp,
    chat: p.chatT > 0 ? p.chat : '',
    activeEmote: p.activeEmote || null,
    playerDead: !!S.playerDead,
    preset: p.preset,
    scale: p.rig?.g?.scale?.x || 1,
    held: held || null,
    carried: p.carriedItem || null,
    isAiming: !!S.isAimingRMB,
    isChargingThrow: !!S.isChargingThrow
  });
}

// Вызывается каждый кадр из update(dt) в PhysicsAndCombat.js
export function updateMultiplayerRuntime(dt) {
  syncChatWidgetVisibility();

  if (S.mpState.isHost) {
    hostBeaconAccumulator += dt;
    if (hostBeaconAccumulator >= 3.0) {
      hostBeaconAccumulator = 0;
      broadcastHostServerBeacon();
    }
  }

  const p = S.player;
  if (p && (S.state === 'play' || S.state === 'edit')) {
    syncAccumulator += dt;
    fullSyncAccumulator += dt;

    if (syncAccumulator >= 0.05) {
      syncAccumulator = 0;
      const isFull = fullSyncAccumulator >= 1.0;
      if (isFull) fullSyncAccumulator = 0;

      const moving =
        S.state === 'play' &&
        !!(
          S.keys.KeyW ||
          S.keys.KeyS ||
          S.keys.KeyA ||
          S.keys.KeyD ||
          S.keys.ArrowUp ||
          S.keys.ArrowDown ||
          S.joy.id !== null
        );
      const held = p.inventory ? p.inventory[S.activeSlot] : null;
      const curHeldSig = `${held?.id || ''}|${held?.name || ''}|${p.carriedItem?.id || ''}|${p.carriedItem?.name || ''}`;
      const heldChanged = curHeldSig !== lastBroadcastedHeldSig;
      if (heldChanged) lastBroadcastedHeldSig = curHeldSig;

      const pkt = {
        type: isFull ? 'full_state' : 'state',
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        z: Math.round(p.z * 100) / 100,
        rot: Math.round((p.rot || 0) * 100) / 100,
        pitch: Math.round((S.pitch || 0) * 100) / 100,
        vy: Math.round((p.vy || 0) * 10) / 10,
        moving,
        sprinting: !!p.sprinting,
        gait: p.gait || 'normal',
        grounded: p.grounded,
        inLiquid: p.inLiquid,
        hp: Math.ceil(p.hp),
        maxHp: p.maxHp,
        chat: p.chatT > 0 ? p.chat : '',
        activeEmote: p.activeEmote || null,
        playerDead: !!S.playerDead,
        isAiming: !!S.isAimingRMB,
        isChargingThrow: !!S.isChargingThrow
      };

      if (isFull || heldChanged) {
        pkt.held = held || null;
        pkt.carried = p.carriedItem || null;
      }
      if (isFull) {
        pkt.preset = p.preset;
        pkt.scale = p.rig?.g?.scale?.x || 1;
      }

      broadcastMultiplayerPacket(pkt);

      // Если мы являемся авторитетом ИИ NPC и в комнате есть другие игроки — транслируем сжатый батч координат и состояний NPC
      if (
        S.state === 'play' &&
        S.customNPCs.length > 0 &&
        Object.keys(S.remotePlayers || {}).length > 0 &&
        isLocalNpcAuthority()
      ) {
        const npcBatch = S.customNPCs.map(n => ({
          id: n.id,
          x: Math.round(n.x * 100) / 100,
          y: Math.round(n.y * 100) / 100,
          z: Math.round(n.z * 100) / 100,
          rot: Math.round((n.rot || 0) * 100) / 100,
          pitch: Math.round((n.pitch || 0) * 100) / 100,
          vy: Math.round((n.vy || 0) * 10) / 10,
          mov: !!n._netMoving,
          spr: !!n.sprinting,
          gnd: n.grounded !== false,
          liq: !!n.inLiquid,
          hp: Math.ceil(n.hp),
          mhp: n.maxHp,
          dead: (n._deadCooldown || 0) > 0,
          chat: (n.chatT || 0) > 0 ? n.chat : ''
        }));
        broadcastMultiplayerPacket({
          type: 'npc_state_batch',
          list: npcBatch
        });
      }
    }
  }

  const now = performance.now();
  const posLerp = 1 - Math.exp(-14 * dt);

  for (const [pid, rem] of Object.entries(S.remotePlayers)) {
    if (now - rem.lastSeen > 18000) {
      removeRemotePlayer(pid);
      continue;
    }

    const dx = rem.netX - rem.x;
    const dy = rem.netY - rem.y;
    const dz = rem.netZ - rem.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 25) {
      rem.x = rem.netX;
      rem.y = rem.netY;
      rem.z = rem.netZ;
    } else {
      rem.x += dx * posLerp;
      rem.y += dy * posLerp;
      rem.z += dz * posLerp;
    }

    let dRot = ((rem.netRot - rem.rot + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (dRot < -Math.PI) dRot += Math.PI * 2;
    rem.rot += dRot * posLerp;
    rem.pitch = (rem.pitch || 0) + ((rem.netPitch || 0) - (rem.pitch || 0)) * posLerp;

    const isMoving = rem.moving || dist > 0.04;
    if (isMoving) {
      const stepRate = rem.sprinting ? 9.2 : 6.5;
      rem.step += Math.max(dist * 12, stepRate) * dt;
    }

    if ((rem.chatQueue && rem.chatQueue.length > 0) || rem.chatT > 0) {
      if (rem.chatT > 0) {
        rem.chatT -= dt;
        if (rem.chatT <= 0) rem.chat = '';
      }
      refreshEntityTagWithHP(rem);
    }
    if (rem.hpBarTimer > 0) {
      rem.hpBarTimer -= dt;
      if (rem.hpBarTimer <= 0) refreshEntityTagWithHP(rem);
    }

    updateEntityAnimation(rem, dt, {
      moving: isMoving,
      sprinting: !!rem.sprinting,
      grounded: rem.grounded,
      inLiquid: rem.inLiquid
    });

    if (rem.rig?.g) {
      rem.rig.g.position.set(rem.x, rem.y, rem.z);
      rem.rig.g.rotation.y = rem.rot;
    }
    if (rem.tag) {
      rem.tag.position.set(rem.x, rem.y + 3.35, rem.z);
    }
  }
}

export function initMultiplayerSystem() {
  ensureMultiplayerStyles();
  ensureChatWidgetDOM();

  S.playerName = getSavedPlayerNickname();
  S.mpState.roomCode = localStorage.getItem(ROOM_STORAGE_KEY) || 'RADMIN-1';
  S.mpState.wsUrl = getDefaultWsUrl();

  if (typeof BroadcastChannel !== 'undefined' && !localChannel) {
    localChannel = new BroadcastChannel('debix_local_mp_v1');
    localChannel.onmessage = ev => {
      handleIncomingPacket(ev.data);
    };
  }

  // Если игра открыта напрямую с HTTP-сервера lan-server.js (порт 8765), сразу подключаемся к его WebSocket!
  try {
    if (location.protocol.startsWith('http') && location.port === '8765') {
      ensureBackgroundDiscoveryWebSocket(S.mpState.wsUrl);
    }
  } catch (_) {}

  if (!serverDiscoveryTimer) {
    serverDiscoveryTimer = setInterval(() => {
      if (S.state === 'menu' && activeLauncherTab === 'servers') {
        requestActiveServersRefresh();
      }
    }, 4000);
  }

  addEventListener('beforeunload', () => {
    broadcastMultiplayerPacket({ type: 'leave' });
    if (S.mpState.isHost && S.mpState.roomCode) {
      const unreg = JSON.stringify({ type: 'unregister_server', roomId: S.mpState.roomCode });
      if (wsConnection && wsConnection.readyState === 1) {
        try { wsConnection.send(unreg); } catch (_) {}
      }
    }
  });

  // Хоткей Enter / T для быстрого фокуса в игровой чат
  addEventListener('keydown', e => {
    if (S.state !== 'play' && S.state !== 'edit') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (S.state === 'play' && (e.code === 'Enter' || e.code === 'KeyT')) {
      const chatWidget = $('mpChatWidget');
      const chatInp = $('mpChatInput');
      if (chatWidget && chatInp && !chatWidget.hidden) {
        e.preventDefault();
        if (chatWidget.classList.contains('chat-minimized')) {
          chatWidget.classList.remove('chat-minimized');
          const minBtn = $('mpChatMinToggleBtn');
          if (minBtn) minBtn.textContent = '—';
        }
        try {
          if (document.pointerLockElement) document.exitPointerLock();
        } catch (_) {}
        chatInp.focus();
      }
    }
  });

  injectBannerIntoModalBox();
  const modalBox = $('modalBox');
  if (modalBox) {
    const obs = new MutationObserver(() => {
      injectBannerIntoModalBox();
    });
    obs.observe(modalBox, { childList: true });
  }

  $('mpToggleBtn')?.addEventListener('click', e => {
    e.stopPropagation();
    toggleMultiplayerModal();
  });

  // Экспортируем глобальные хуки для мгновенного вызова из любых модулей без циклических зависимостей
  window.__debixSendImmediateFullState = sendImmediateFullState;
  window.__debixSyncWorldSettings = syncWorldSettingsToNetwork;
  window.__debixSyncBlockUpsert = syncBlockUpsertToNetwork;
  window.__debixSyncBlockDelete = syncBlockDeleteToNetwork;
  window.__debixSyncWorldItemUpsert = syncWorldItemUpsertToNetwork;
  window.__debixSyncWorldItemDelete = syncWorldItemDeleteToNetwork;
  window.__debixSyncNpcUpsert = syncNpcUpsertToNetwork;
  window.__debixSyncNpcDelete = syncNpcDeleteToNetwork;
  window.__debixIsNpcAuthority = isLocalNpcAuthority;
  window.__debixSyncCustomAsset = syncCustomAssetToNetwork;
  window.__debixOpenUgcHub = openFloatingUgcHubModal;
  window.__debixPublishDockCardToHub = publishDockCardToUgcHub;
  window.__debixPublishSelectedToHub = publishSelectedToUgcHub;

  ensureUgcHubInitialized();
  requestUgcHubCatalogRefresh();
}

/* ============================================================================
   📚 ГЛОБАЛЬНАЯ UGC-МАСТЕРСКАЯ И ОБМЕН КОНТЕНТОМ (КАРТЫ, ПРЕФАБЫ, ОРУЖИЕ, NPC)
   ============================================================================ */

const UGC_HUB_STORAGE_KEY = 'debix_ugc_hub_catalog_v1';
const ugcHubItems = new Map(); // id -> { id, category, title, author, desc, thumb, createdAt, payload }
let activeHubCategory = 'all';
let activeHubSearch = '';
let hubInitialized = false;

const HUB_CATEGORIES = [
  { id: 'all', label: '🌟 Все', badge: 'Контент' },
  { id: 'prefab', label: '📦 Префабы', badge: '📦 Префаб' },
  { id: 'map', label: '🗺️ Карты', badge: '🗺️ Карта' },
  { id: 'weapon', label: '⚔️ Оружие', badge: '⚔️ Предмет' },
  { id: 'npc', label: '🤖 NPC-Боты', badge: '🤖 NPC' },
  { id: 'cosmetic', label: '🎩 Аксессуары', badge: '🎩 Гардероб' },
  { id: 'audio', label: '🔊 Аудио', badge: '🔊 Звук' }
];

function createStarterShowcaseHubItems() {
  const starterSword = createStarterItemTemplate('sword');
  starterSword.name = 'Неоновая Катана Кибер-Стража';
  starterSword.damage = 45;
  starterSword.lightData = { enabled: true, realLight: true, pseudoLight: true, color: '#00f2fe', intensity: 2.2, distance: 14 };

  const starterBlaster = createStarterItemTemplate('blaster');
  starterBlaster.name = 'Импульсный Карабин X-9';
  starterBlaster.damage = 28;
  starterBlaster.magSize = 18;
  starterBlaster.ammo = 18;

  return [
    {
      id: 'hub_showcase_npc_guard',
      category: 'npc',
      title: 'Кибер-Страж с Бластером (A* + Паркур)',
      author: 'DebiX Studio',
      desc: 'Умный охранник с физикой мира, прыжками через пропасти, перезарядкой обоймы и защитой территории.',
      createdAt: Date.now() - 3600000,
      payload: {
        id: 'cpref_showcase_npc_1',
        kind: 'npc',
        title: 'Кибер-Страж',
        data: {
          name: 'Кибер-Страж',
          chat: 'Сектор под охраной! Не шали! 🛡️',
          head: '#56f0ff',
          torso: '#1e293b',
          armL: '#56f0ff',
          armR: '#56f0ff',
          legL: '#0f172a',
          legR: '#0f172a',
          hpEnabled: true,
          hp: 160,
          maxHp: 160,
          meleeDamage: 25,
          walkSpeed: 6.2,
          jumpPower: 11.5,
          equippedItem: starterBlaster,
          aiModules: {
            worldPhysics: { enabled: true, gravityScale: 1, fallDamage: true, fallDamageThreshold: 16.5, hazardDamage: true, canSwim: true, canPickupItems: true, canInteractBlocks: true },
            navigation: { enabled: true, mode: 'wander', gait: 'normal', walkSpeed: 6.2, jumpPower: 11.5, wanderRadius: 12, canJump: true, jumpGaps: true, usePathfinding: true, waypoints: [] },
            humanError: { enabled: true, mistakeLevel: 0.15, jumpMistakeChance: 0.1, pathNoise: 0.15, hesitationChance: 0.1, aimError: 0.15 },
            combat: { enabled: true, stance: 'guard', aggroRadius: 16, loseAggroRadius: 26, attackRange: 2.5, accuracy: 0.8, respectAmmoReload: true, useEquippedWeapon: true, fleeLowHp: false, fleeHpPct: 20 },
            dialogue: { enabled: true, interactKeyE: true, lines: ['Сектор под охраной! 🛡️', 'Если нападёшь — отвечу из бластера!', 'Я умею перепрыгивать ямы и открывать двери!'], aggroChat: 'Тревога! Нарушитель! 🔫', oopsChat: 'Ой, не долетел! 😱', dropCoins: 50, dropEquippedItem: true, respawnTime: 4 }
          }
        }
      }
    },
    {
      id: 'hub_showcase_npc_zombie',
      category: 'npc',
      title: 'Болотный Зомби-Мутант (Походка Монстра)',
      author: 'DebiX Studio',
      desc: 'Враждебный монстр с вытянутыми вперёд руками, наклоном тела и включённым модулем человеческих ошибок.',
      createdAt: Date.now() - 3200000,
      payload: {
        id: 'cpref_showcase_npc_2',
        kind: 'npc',
        title: 'Зомби-Мутант',
        data: {
          name: 'Зомби-Мутант',
          chat: 'Мозгиии... 🧟',
          head: '#2ecc71',
          torso: '#3d3d3d',
          armL: '#2ecc71',
          armR: '#2ecc71',
          legL: '#1e272e',
          legR: '#1e272e',
          hpEnabled: true,
          hp: 120,
          maxHp: 120,
          meleeDamage: 20,
          walkSpeed: 4.8,
          jumpPower: 10.0,
          aiModules: {
            worldPhysics: { enabled: true, gravityScale: 1, fallDamage: true, fallDamageThreshold: 16.5, hazardDamage: true, canSwim: true, canPickupItems: true, canInteractBlocks: true },
            navigation: { enabled: true, mode: 'wander', gait: 'monster', walkSpeed: 4.8, jumpPower: 10.0, wanderRadius: 11, canJump: true, jumpGaps: true, usePathfinding: true, waypoints: [] },
            humanError: { enabled: true, mistakeLevel: 0.45, jumpMistakeChance: 0.35, pathNoise: 0.4, hesitationChance: 0.2, aimError: 0.3 },
            combat: { enabled: true, stance: 'hostile', aggroRadius: 14, loseAggroRadius: 22, attackRange: 2.3, accuracy: 0.65, respectAmmoReload: true, useEquippedWeapon: true, fleeLowHp: false, fleeHpPct: 20 },
            dialogue: { enabled: true, interactKeyE: false, lines: ['Уррхх... 🧟'], aggroChat: 'ГРРААА! 🧟', oopsChat: 'Уааа, яма! 😱', dropCoins: 35, dropEquippedItem: false, respawnTime: 3.5 }
          }
        }
      }
    },
    {
      id: 'hub_showcase_katana',
      category: 'weapon',
      title: 'Неоновая Катана Кибер-Стража',
      author: 'DebiX Studio',
      desc: 'Светящийся клинок ближнего боя с повышенным уроном (45 ед.) и динамическим неоновым светом.',
      createdAt: Date.now() - 2800000,
      payload: starterSword
    }
  ];
}

export function ensureUgcHubInitialized() {
  if (hubInitialized) return;
  hubInitialized = true;

  try {
    const raw = localStorage.getItem(UGC_HUB_STORAGE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        for (const it of list) {
          if (it && it.id) ugcHubItems.set(it.id, it);
        }
      }
    }
  } catch (_) {}

  if (ugcHubItems.size === 0) {
    for (const demo of createStarterShowcaseHubItems()) {
      ugcHubItems.set(demo.id, demo);
    }
    saveLocalUgcHubCache();
  }
}

function saveLocalUgcHubCache() {
  try {
    const arr = Array.from(ugcHubItems.values());
    localStorage.setItem(UGC_HUB_STORAGE_KEY, JSON.stringify(arr));
  } catch (err) {
    console.warn('Hub localStorage quota warning:', err);
  }
}

function getHubItemThumbnail(entry) {
  if (!entry) return '';
  if (entry.thumb) return entry.thumb;
  try {
    if (entry.category === 'weapon' && entry.payload) {
      entry.thumb = getItem3DThumbnail(entry.payload);
    } else if (entry.category === 'cosmetic' && entry.payload) {
      entry.thumb = getCosmetic3DThumbnail(entry.payload);
    } else if (entry.category === 'npc') {
      entry.thumb = getPrefab3DThumbnail('npc');
    } else if (entry.category === 'prefab') {
      if (entry.payload?.kind === 'world_item' && entry.payload.data) {
        entry.thumb = getItem3DThumbnail(entry.payload.data);
      } else if (entry.payload?.kind === 'cosmetic' && entry.payload.data) {
        entry.thumb = getCosmetic3DThumbnail(entry.payload.data);
      } else if (entry.payload?.kind === 'npc') {
        entry.thumb = getPrefab3DThumbnail('npc');
      } else {
        entry.thumb = getPrefab3DThumbnail('solid');
      }
    } else if (entry.category === 'map') {
      entry.thumb = getPrefab3DThumbnail('checkpoint');
    } else if (entry.category === 'audio') {
      entry.thumb = getPrefab3DThumbnail('button');
    }
  } catch (_) {}
  return entry.thumb || '';
}

export function requestUgcHubCatalogRefresh() {
  ensureUgcHubInitialized();

  // 1. Опрос открытых локальных вкладок и P2P пиров
  broadcastMultiplayerPacket({ type: 'request_hub_catalog' });

  // 2. Опрос lan-server.js по HTTP (/api/hub)
  const wsUrl = S.mpState.wsUrl || getDefaultWsUrl();
  try {
    const httpUrl = wsUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/$/, '') + '/api/hub';
    fetch(httpUrl)
      .then(r => (r.ok ? r.json() : []))
      .then(list => {
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && item.id) ugcHubItems.set(item.id, item);
          }
          saveLocalUgcHubCache();
          refreshUgcHubDOM();
        }
      })
      .catch(() => {});
  } catch (_) {}

  // 3. Опрос через WebSocket
  if (wsConnection && wsConnection.readyState === 1) {
    try { wsConnection.send(JSON.stringify({ type: 'get_hub_catalog' })); } catch (_) {}
  } else if (discoveryWs && discoveryWs.readyState === 1) {
    try { discoveryWs.send(JSON.stringify({ type: 'get_hub_catalog' })); } catch (_) {}
  }
}

export function publishItemToUgcHub({ category, title, desc, payload, thumb = '' }) {
  ensureUgcHubInitialized();
  const cleanTitle = (title || 'Моя работа').trim().slice(0, 48);
  const cleanDesc = (desc || 'Опубликовано через Мастерскую DebiX').trim().slice(0, 140);
  const author = S.playerName || getSavedPlayerNickname();

  const item = {
    id: 'hub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    category: category || 'prefab',
    title: cleanTitle,
    author,
    desc: cleanDesc,
    thumb: thumb || '',
    createdAt: Date.now(),
    payload: JSON.parse(JSON.stringify(payload))
  };

  if (!item.thumb) {
    item.thumb = getHubItemThumbnail(item);
  }

  ugcHubItems.set(item.id, item);
  saveLocalUgcHubCache();
  refreshUgcHubDOM();

  // Рассылаем всем игрокам по P2P / BroadcastChannel / WebRTC
  broadcastMultiplayerPacket({
    type: 'hub_item_broadcast',
    item
  });

  // Отправляем на сервер lan-server.js (HTTP + WS)
  const wsUrl = S.mpState.wsUrl || getDefaultWsUrl();
  try {
    const httpUrl = wsUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/$/, '') + '/api/hub/publish';
    fetch(httpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ item })
    }).catch(() => {});
  } catch (_) {}

  const wsMsg = JSON.stringify({ type: 'publish_hub_item', item });
  if (wsConnection && wsConnection.readyState === 1) {
    try { wsConnection.send(wsMsg); } catch (_) {}
  } else if (discoveryWs && discoveryWs.readyState === 1) {
    try { discoveryWs.send(wsMsg); } catch (_) {}
  }

  sfx.cash?.();
  showBanner(`☁️ «${cleanTitle}» опубликовано в общую Мастерскую UGC!`, '#00e676');
  return item;
}

export function publishDockCardToUgcHub(card) {
  if (!card) return;
  const defaultTitle = card.title || 'Мой Префаб';
  const customTitle = prompt('Название для публикации в Мастерской UGC:', defaultTitle);
  if (!customTitle) return;
  const customDesc = prompt('Краткое описание (необязательно):', 'Создано в 3D Студии DebiX') || '';

  if (card.libType === 'saved_item') {
    const it = S.savedItemsLibrary[card.libIdx];
    if (!it) return;
    publishItemToUgcHub({ category: 'weapon', title: customTitle, desc: customDesc, payload: it, thumb: card.thumb });
  } else if (card.libType === 'saved_cos') {
    const cos = S.savedCosmeticsLibrary[card.libIdx];
    if (!cos) return;
    publishItemToUgcHub({ category: 'cosmetic', title: customTitle, desc: customDesc, payload: cos, thumb: card.thumb });
  } else if (card.libType === 'custom_prefab') {
    const cp = (S.customPrefabsLibrary || []).find(p => p.id === card.customPrefabId);
    if (!cp) return;
    const cat = cp.kind === 'npc' ? 'npc' : (cp.kind === 'world_item' ? 'weapon' : (cp.kind === 'cosmetic' ? 'cosmetic' : 'prefab'));
    publishItemToUgcHub({
      category: cat,
      title: customTitle,
      desc: customDesc,
      payload: cat === 'weapon' || cat === 'cosmetic' ? cp.data : cp,
      thumb: card.thumb
    });
  }
}

export function publishSelectedToUgcHub(ref = S.selectedRef) {
  if (!ref) {
    showBanner('Сначала выбери предмет, аксессуар, блок или NPC для загрузки в библиотеку!', '#ffce3a');
    return;
  }
  const entry = buildPrefabEntryFromSelected(ref);
  if (!entry) {
    showBanner('Не удалось собрать данные объекта для публикации!', '#ff3e3e');
    return;
  }

  const customTitle = prompt('Название для публикации в библиотеке (Мастерской UGC):', entry.title || 'Моя работа');
  if (!customTitle || !customTitle.trim()) return;
  const customDesc = prompt('Краткое описание (необязательно):', 'Создано в 3D Студии DebiX') || '';

  entry.title = customTitle.trim();

  // Одновременно сохраняем и в локальную библиотеку игрока (Арсенал / Гардероб / Префабы), чтобы карточка сразу появилась внизу
  if (entry.kind === 'world_item') {
    entry.data.name = entry.title;
    if (!Array.isArray(S.savedItemsLibrary)) S.savedItemsLibrary = [];
    if (!S.savedItemsLibrary.some(x => x.id === entry.data.id)) {
      S.savedItemsLibrary.push(JSON.parse(JSON.stringify(entry.data)));
    }
  } else if (entry.kind === 'cosmetic') {
    entry.data.name = entry.title;
    if (!Array.isArray(S.savedCosmeticsLibrary)) S.savedCosmeticsLibrary = [];
    if (!S.savedCosmeticsLibrary.some(x => x.id === entry.data.id)) {
      S.savedCosmeticsLibrary.push(JSON.parse(JSON.stringify(entry.data)));
    }
  } else {
    if (!Array.isArray(S.customPrefabsLibrary)) S.customPrefabsLibrary = [];
    S.customPrefabsLibrary.push(JSON.parse(JSON.stringify(entry)));
    S.activePrefabFolderId = 'library';
  }
  refreshPrefabDockUI();

  const cat = entry.kind === 'npc'
    ? 'npc'
    : (entry.kind === 'world_item' ? 'weapon' : (entry.kind === 'cosmetic' ? 'cosmetic' : 'prefab'));

  publishItemToUgcHub({
    category: cat,
    title: entry.title,
    desc: customDesc,
    payload: cat === 'weapon' || cat === 'cosmetic' ? entry.data : entry
  });
}

export function downloadOrSpawnUgcHubItem(hubId, spawnImmediately = false) {
  const entry = ugcHubItems.get(hubId);
  if (!entry || !entry.payload) return;

  const cat = entry.category;
  const data = JSON.parse(JSON.stringify(entry.payload));

  if (cat === 'map') {
    const list = getProjectsList();
    const newProjId = 'proj_' + Date.now();
    const nowStr = new Date().toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    data.projectTitle = entry.title || data.projectTitle || 'Скачанный мир';
    list.unshift({
      id: newProjId,
      title: data.projectTitle,
      updatedAt: nowStr,
      sceneData: data
    });
    saveProjectsList(list);
    sfx.gate?.();

    if (spawnImmediately) {
      S.currentProjectId = newProjId;
      S.currentProjectTitle = data.projectTitle;
      loadSceneState(data);
      const modal = $('mpUgcHubModal');
      if (modal) modal.hidden = true;
      if (S.state === 'menu') startPlaySession();
      showBanner(`🗺️ Карта «${entry.title}» загружена и запущена!`, '#00e676');
    } else {
      showBanner(`📥 Карта «${entry.title}» сохранена в «Мои Миры»!`, '#00e676');
    }
    return;
  }

  if (cat === 'weapon') {
    if (!Array.isArray(S.savedItemsLibrary)) S.savedItemsLibrary = [];
    data.name = entry.title || data.name;
    S.savedItemsLibrary.push(data);
    const libIdx = S.savedItemsLibrary.length - 1;
    refreshPrefabDockUI();
    sfx.coil?.();

    if (spawnImmediately) {
      if (S.state === 'edit') {
        spawnPrefabFromCard(`lib_item_${libIdx}`, null, false);
      } else if (S.player) {
        if (!Array.isArray(S.player.inventory)) S.player.inventory = [null, null, null, null, null, null];
        let slot = S.player.inventory.findIndex((x, i) => i > 0 && !x);
        if (slot === -1) slot = 1;
        S.player.inventory[slot] = normalizeItemData(data);
        S.activeSlot = slot;
        syncEntityHeldItemMesh(S.player);
        renderHotbarUI();
      }
      showBanner(`⚔️ «${entry.title}» добавлено в Арсенал и выдано!`, '#00e676');
    } else {
      showBanner(`📥 Оружие «${entry.title}» скачано в твой Арсенал (#studioBottomDock → ⭐)!`, '#00e676');
    }
    return;
  }

  if (cat === 'cosmetic') {
    if (!Array.isArray(S.savedCosmeticsLibrary)) S.savedCosmeticsLibrary = [];
    data.name = entry.title || data.name;
    S.savedCosmeticsLibrary.push(data);
    const libIdx = S.savedCosmeticsLibrary.length - 1;
    refreshPrefabDockUI();
    sfx.coil?.();

    if (spawnImmediately && S.player) {
      const copy = normalizeCosmeticItem(JSON.parse(JSON.stringify(data)));
      copy.id = 'cos_' + Date.now();
      if (!S.player.preset.customCosmetics) S.player.preset.customCosmetics = [];
      S.player.preset.customCosmetics.push(copy);
      S.player.rig?.syncCustomCosmetics(S.player.preset.customCosmetics);
      attachRigToEntity(S.player);
      showBanner(`🎩 «${entry.title}» надето на персонажа и сохранено в Гардероб!`, '#00e676');
    } else {
      showBanner(`📥 Аксессуар «${entry.title}» скачан в твой Гардероб (#studioBottomDock → ⭐)!`, '#00e676');
    }
    return;
  }

  if (cat === 'npc' || cat === 'prefab') {
    if (!Array.isArray(S.customPrefabsLibrary)) S.customPrefabsLibrary = [];
    const prefEntry = data.kind ? data : {
      id: 'cpref_' + Date.now(),
      kind: cat === 'npc' ? 'npc' : 'block',
      title: entry.title,
      data
    };
    prefEntry.id = 'cpref_' + Date.now() + '_' + Math.floor(Math.random() * 999);
    prefEntry.title = entry.title || prefEntry.title;
    S.customPrefabsLibrary.push(prefEntry);
    S.activePrefabFolderId = 'library';
    refreshPrefabDockUI();
    sfx.coil?.();

    if (spawnImmediately && (S.state === 'edit' || S.state === 'play')) {
      if (S.state === 'edit') {
        spawnPrefabFromCard(`custom_prefab_${prefEntry.id}`, null, false);
      } else if (prefEntry.kind === 'npc' && S.player) {
        spawnCustomNPC(Object.assign({}, prefEntry.data, {
          x: S.player.x + 2.5,
          y: S.player.y + 0.5,
          z: S.player.z + 2.5
        }));
      }
      showBanner(`⚡ «${entry.title}» добавлен в префабы и размещён в мире!`, '#00e676');
    } else {
      showBanner(`📥 «${entry.title}» скачан в твои Префабы (#studioBottomDock → ⭐)!`, '#00e676');
    }
    return;
  }

  if (cat === 'audio') {
    if (!Array.isArray(S.customAudioLibrary)) S.customAudioLibrary = [];
    const exists = S.customAudioLibrary.some(a => a.id === data.id);
    if (!exists) S.customAudioLibrary.push(data);
    sfx.cash?.();
    showBanner(`🔊 Аудио «${entry.title}» добавлено в твою аудиотеку Студии!`, '#00e676');
  }
}

function buildPublishableLocalSourcesList() {
  const opts = [];
  opts.push({ val: 'current_map', label: `🗺️ [Текущая Карта] ${S.currentProjectTitle || 'Мой Мир'} (${S.allBlocks.length} блок., ${S.customNPCs.length} NPC)` });

  if (S.selectedRef) {
    const selEntry = buildPrefabEntryFromSelected(S.selectedRef);
    if (selEntry) {
      opts.push({ val: 'selected_obj', label: `🎯 [Выбрано в Студии] ${selEntry.title} (${selEntry.kind})` });
    }
  }

  (S.customPrefabsLibrary || []).forEach((cp, idx) => {
    opts.push({ val: `prefab:${idx}`, label: `📦 [Префаб] ${cp.title || 'Префаб'}` });
  });
  (S.savedItemsLibrary || []).forEach((it, idx) => {
    opts.push({ val: `weapon:${idx}`, label: `⚔️ [Арсенал] ${it.name || 'Предмет'}` });
  });
  (S.savedCosmeticsLibrary || []).forEach((c, idx) => {
    opts.push({ val: `cosmetic:${idx}`, label: `🎩 [Гардероб] ${c.name || 'Аксессуар'}` });
  });
  (S.customNPCs || []).forEach((n, idx) => {
    opts.push({ val: `scene_npc:${idx}`, label: `🤖 [NPC на сцене] ${n.name}` });
  });
  (S.customAudioLibrary || []).forEach((a, idx) => {
    opts.push({ val: `audio:${idx}`, label: `🔊 [Аудио] ${a.name}` });
  });
  getProjectsList().forEach((p, idx) => {
    opts.push({ val: `slot_map:${idx}`, label: `🗂️ [Слот мира] ${p.title}` });
  });

  return opts;
}

function buildUgcHubCardsHTML() {
  ensureUgcHubInitialized();
  let items = Array.from(ugcHubItems.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

  if (activeHubCategory !== 'all') {
    items = items.filter(it => it.category === activeHubCategory);
  }
  if (activeHubSearch) {
    const q = activeHubSearch.toLowerCase();
    items = items.filter(
      it =>
        (it.title || '').toLowerCase().includes(q) ||
        (it.author || '').toLowerCase().includes(q) ||
        (it.desc || '').toLowerCase().includes(q)
    );
  }

  if (items.length === 0) {
    return `
      <div style="grid-column:1/-1;text-align:center;padding:26px 12px;color:#94a3b8;font-size:12px;background:rgba(0,0,0,0.28);border-radius:10px;border:1px dashed rgba(255,255,255,0.15)">
        📭 В этой категории пока нет опубликованных работ.<br>
        <span style="font-size:11px;color:#64748b">Выбери любой свой префаб, оружие, NPC или карту выше и нажми <b>«☁️ Опубликовать»</b>!</span>
      </div>
    `;
  }

  const catBadges = Object.fromEntries(HUB_CATEGORIES.map(c => [c.id, c.badge]));

  return items
    .map(it => {
      const thumb = getHubItemThumbnail(it);
      const badge = catBadges[it.category] || '📦 Ассет';
      return `
        <div style="background:linear-gradient(145deg,rgba(20,28,46,0.95),rgba(12,17,30,0.95));border:1.5px solid #2b3a55;border-radius:12px;padding:10px;display:flex;flex-direction:column;justify-content:space-between;gap:8px">
          <div style="display:flex;gap:10px;align-items:center">
            <div style="width:62px;height:62px;border-radius:9px;background:radial-gradient(circle,rgba(86,240,255,0.18),rgba(10,14,24,0.9));border:1px solid rgba(86,240,255,0.3);display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden">
              ${thumb ? `<img src="${thumb}" alt="" style="width:100%;height:100%;object-fit:contain">` : `<span style="font-size:24px">📦</span>`}
            </div>
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap">
                <span style="font-size:9.5px;background:#1e293b;color:#56f0ff;padding:2px 6px;border-radius:5px;font-weight:800">${badge}</span>
                <span style="font-size:10px;color:#94a3b8">👤 ${it.author || 'Игрок'}</span>
              </div>
              <div style="font:800 12.5px 'Montserrat',sans-serif;color:#fff;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${it.title}">${it.title}</div>
              <div style="font-size:10.5px;color:#cbd5e1;margin-top:2px;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${it.desc || ''}</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr auto auto;gap:5px;align-items:center;padding-top:7px;border-top:1px solid rgba(255,255,255,0.08)">
            <button type="button" class="mp-btn host" data-hub-dl="${it.id}" style="height:30px;padding:0 8px;font-size:10.5px;width:100%" title="Скачать в свою Студию / Арсенал / Слоты миров">⬇️ В Студию</button>
            <button type="button" class="mp-btn" data-hub-spawn="${it.id}" style="height:30px;padding:0 8px;font-size:10.5px;width:100%" title="Скачать и сразу разместить на сцене / запустить">⚡ ${it.category === 'map' ? 'Играть' : 'В сцену'}</button>
            <button type="button" class="mp-btn secondary" data-hub-json="${it.id}" style="height:30px;padding:0 8px;font-size:10.5px" title="Скачать отдельным .JSON файлом">📤</button>
            <button type="button" class="mp-btn danger" data-hub-del="${it.id}" style="height:30px;padding:0 8px;font-size:10.5px" title="Удалить из каталога">🗑️</button>
          </div>
        </div>
      `;
    })
    .join('');
}

function buildUgcHubPanelHTML(context = 'launcher') {
  const publishOpts = buildPublishableLocalSourcesList()
    .map(o => `<option value="${o.val}">${o.label}</option>`)
    .join('');

  const catButtons = HUB_CATEGORIES.map(
    c => `<button type="button" class="mp-btn ${activeHubCategory === c.id ? '' : 'secondary'} debix-hub-cat-btn" data-hcat="${c.id}" style="padding:5px 9px;font-size:10.5px">${c.label}</button>`
  ).join('');

  return `
    <div class="mp-servers-panel debix-ugc-hub-root" data-hub-ctx="${context}">
      <!-- БЛОК ПУБЛИКАЦИИ СВОЕГО КОНТЕНТА -->
      <div style="background:rgba(0,162,255,0.08);border:1.5px solid rgba(86,240,255,0.35);border-radius:11px;padding:10px;margin-bottom:10px">
        <div style="font:900 11.5px 'Montserrat',sans-serif;color:#00e676;margin-bottom:6px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
          <span>☁️ ОПУБЛИКОВАТЬ СВОЙ ПРЕФАБ, КАРТУ, ОРУЖИЕ ИЛИ NPC</span>
          <button type="button" class="mp-btn secondary debix-hub-import-file" style="padding:4px 9px;font-size:10px">📂 Импорт ассета (.JSON)</button>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <select class="mp-inp debix-hub-pub-source" style="flex:1.4;min-width:200px">
            ${publishOpts}
          </select>
          <input type="text" class="mp-inp debix-hub-pub-desc" placeholder="Краткое описание твоей работы..." style="flex:1;min-width:160px">
          <button type="button" class="mp-btn host debix-hub-pub-btn">☁️ Опубликовать</button>
        </div>
      </div>

      <!-- ФИЛЬТРЫ КАТЕГОРИЙ И ПОИСК -->
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:8px">
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${catButtons}
        </div>
        <div style="display:flex;gap:5px;align-items:center;flex:1;min-width:170px;justify-content:flex-end">
          <input type="text" class="mp-inp debix-hub-search" placeholder="🔍 Поиск по названию/автору..." value="${activeHubSearch}" style="max-width:210px;padding:5px 9px;font-size:11px">
          <button type="button" class="mp-btn secondary debix-hub-refresh-btn" style="padding:5px 9px;font-size:11px" title="Обновить каталог с сервера">🔄</button>
        </div>
      </div>

      <!-- СЕТКА КАРТОЧЕК МАСТЕРСКОЙ -->
      <div class="debix-hub-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(265px,1fr));gap:9px;max-height:310px;overflow-y:auto;padding-right:3px">
        ${buildUgcHubCardsHTML()}
      </div>
    </div>
  `;
}

export function refreshUgcHubDOM() {
  document.querySelectorAll('.debix-hub-count-pill').forEach(el => {
    el.textContent = String(ugcHubItems.size);
  });

  document.querySelectorAll('.debix-ugc-hub-root').forEach(root => {
    const grid = root.querySelector('.debix-hub-grid');
    if (grid) {
      grid.innerHTML = buildUgcHubCardsHTML();
      bindUgcHubCardButtons(grid);
    }
    root.querySelectorAll('.debix-hub-cat-btn').forEach(btn => {
      const isAct = btn.dataset.hcat === activeHubCategory;
      btn.classList.toggle('secondary', !isAct);
    });
  });
}

function bindUgcHubCardButtons(container) {
  if (!container) return;

  container.querySelectorAll('[data-hub-dl]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      downloadOrSpawnUgcHubItem(btn.dataset.hubDl, false);
    };
  });

  container.querySelectorAll('[data-hub-spawn]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      downloadOrSpawnUgcHubItem(btn.dataset.hubSpawn, true);
    };
  });

  container.querySelectorAll('[data-hub-json]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const it = ugcHubItems.get(btn.dataset.hubJson);
      if (!it) return;
      const blob = new Blob([JSON.stringify(it, null, 2)], { type: 'application/json;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      const safe = (it.title || 'asset').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]/g, '_');
      a.download = `${safe}_${it.category}.debix.json`;
      a.click();
      sfx.cash?.();
    };
  });

  container.querySelectorAll('[data-hub-del]').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const id = btn.dataset.hubDel;
      const it = ugcHubItems.get(id);
      if (!it) return;
      ugcHubItems.delete(id);
      saveLocalUgcHubCache();
      refreshUgcHubDOM();

      broadcastMultiplayerPacket({ type: 'hub_item_delete', id });
      const wsUrl = S.mpState.wsUrl || getDefaultWsUrl();
      try {
        const httpUrl = wsUrl.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:').replace(/\/$/, '') + '/api/hub/delete';
        fetch(httpUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id })
        }).catch(() => {});
      } catch (_) {}
      sfx.oof?.();
    };
  });
}

function bindUgcHubEvents(container) {
  if (!container) return;

  container.querySelectorAll('.debix-hub-cat-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      activeHubCategory = btn.dataset.hcat || 'all';
      refreshUgcHubDOM();
      sfx.click?.();
    };
  });

  container.querySelectorAll('.debix-hub-search').forEach(inp => {
    inp.oninput = () => {
      activeHubSearch = inp.value.trim();
      refreshUgcHubDOM();
    };
    inp.addEventListener('keydown', e => e.stopPropagation());
  });

  container.querySelectorAll('.debix-hub-refresh-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      requestUgcHubCatalogRefresh();
      refreshUgcHubDOM();
      sfx.click?.();
    };
  });

  container.querySelectorAll('.debix-hub-pub-desc').forEach(inp => {
    inp.addEventListener('keydown', e => e.stopPropagation());
  });

  container.querySelectorAll('.debix-hub-pub-btn').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const root = btn.closest('.debix-ugc-hub-root') || container;
      const selEl = root.querySelector('.debix-hub-pub-source');
      const descEl = root.querySelector('.debix-hub-pub-desc');
      const srcVal = selEl ? selEl.value : 'current_map';
      const desc = descEl ? descEl.value.trim() : '';

      if (srcVal === 'current_map') {
        const snap = serializeSceneState();
        publishItemToUgcHub({
          category: 'map',
          title: S.currentProjectTitle || 'Мой Мир',
          desc: desc || `Карта (${snap.blocks?.length || 0} объектов, ${snap.customNPCs?.length || 0} NPC)`,
          payload: snap
        });
      } else if (srcVal === 'selected_obj' && S.selectedRef) {
        const entry = buildPrefabEntryFromSelected(S.selectedRef);
        if (!entry) return;
        const cat = entry.kind === 'npc' ? 'npc' : (entry.kind === 'world_item' ? 'weapon' : (entry.kind === 'cosmetic' ? 'cosmetic' : 'prefab'));
        publishItemToUgcHub({
          category: cat,
          title: entry.title,
          desc: desc || 'Опубликовано напрямую со сцены 3D Студии',
          payload: cat === 'weapon' || cat === 'cosmetic' ? entry.data : entry
        });
      } else if (srcVal.startsWith('prefab:')) {
        const cp = S.customPrefabsLibrary[+srcVal.split(':')[1]];
        if (!cp) return;
        const cat = cp.kind === 'npc' ? 'npc' : 'prefab';
        publishItemToUgcHub({ category: cat, title: cp.title, desc, payload: cp });
      } else if (srcVal.startsWith('weapon:')) {
        const it = S.savedItemsLibrary[+srcVal.split(':')[1]];
        if (!it) return;
        publishItemToUgcHub({ category: 'weapon', title: it.name, desc, payload: it });
      } else if (srcVal.startsWith('cosmetic:')) {
        const cos = S.savedCosmeticsLibrary[+srcVal.split(':')[1]];
        if (!cos) return;
        publishItemToUgcHub({ category: 'cosmetic', title: cos.name, desc, payload: cos });
      } else if (srcVal.startsWith('scene_npc:')) {
        const npc = S.customNPCs[+srcVal.split(':')[1]];
        if (!npc) return;
        const entry = buildPrefabEntryFromSelected({ kind: 'char', ent: npc });
        if (entry) publishItemToUgcHub({ category: 'npc', title: npc.name, desc, payload: entry });
      } else if (srcVal.startsWith('audio:')) {
        const aud = S.customAudioLibrary[+srcVal.split(':')[1]];
        if (!aud) return;
        publishItemToUgcHub({ category: 'audio', title: aud.name, desc, payload: aud });
      } else if (srcVal.startsWith('slot_map:')) {
        const proj = getProjectsList()[+srcVal.split(':')[1]];
        if (!proj || !proj.sceneData) return;
        publishItemToUgcHub({ category: 'map', title: proj.title, desc, payload: proj.sceneData });
      }

      if (descEl) descEl.value = '';
    };
  });

  container.querySelectorAll('.debix-hub-import-file').forEach(btn => {
    btn.onclick = e => {
      e.stopPropagation();
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = '.json,application/json';
      inp.onchange = ev => {
        const file = ev.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = rev => {
          try {
            const parsed = JSON.parse(rev.target.result);
            if (parsed && parsed.id && parsed.category && parsed.payload) {
              ugcHubItems.set(parsed.id, parsed);
              saveLocalUgcHubCache();
              refreshUgcHubDOM();
              downloadOrSpawnUgcHubItem(parsed.id, false);
            } else if (parsed && Array.isArray(parsed.blocks)) {
              publishItemToUgcHub({
                category: 'map',
                title: parsed.projectTitle || file.name.replace(/\.json$/i, ''),
                desc: 'Импортированная карта',
                payload: parsed
              });
            }
          } catch (err) {
            showBanner('❌ Ошибка чтения файла ассета: ' + err.message, '#ff3e3e');
          }
        };
        reader.readAsText(file);
      };
      inp.click();
    };
  });

  bindUgcHubCardButtons(container);
}

export function openFloatingUgcHubModal() {
  ensureMultiplayerStyles();
  ensureUgcHubInitialized();
  requestUgcHubCatalogRefresh();

  let modal = $('mpUgcHubModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'mpUgcHubModal';
    modal.style.cssText =
      'position:fixed;top:52px;left:50%;transform:translateX(-50%);width:min(760px,95vw);max-height:86vh;overflow-y:auto;z-index:55;background:rgba(12,17,30,0.98);border:2px solid #56f0ff;border-radius:16px;padding:16px 18px;box-shadow:0 20px 60px rgba(0,0,0,0.85);color:#fff;font-family:Montserrat,sans-serif';
    document.body.appendChild(modal);
  }

  modal.hidden = false;
  modal.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
      <div>
        <b style="font-size:15px;color:#56f0ff">📚 МАСТЕРСКАЯ UGC (БИБЛИОТЕКА ПРЕФАБОВ, КАРТ, ОРУЖИЯ И NPC)</b>
        <div style="font-size:11px;color:#94a3b8">Делись своими префабами и скачивай работы других игроков прямо в свою 3D Студию!</div>
      </div>
      <button type="button" class="mp-btn danger" id="closeUgcHubModalBtn" style="padding:5px 10px">✕</button>
    </div>
    ${buildUgcHubPanelHTML('studio')}
  `;

  bindUgcHubEvents(modal);
  $('closeUgcHubModalBtn').onclick = () => {
    modal.hidden = true;
  };
}