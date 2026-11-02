// src/core/State.js
export const $ = id => document.getElementById(id);
export const TAU = Math.PI * 2;
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const rnd = (a, b) => a + Math.random() * (b - a);
export const pick = a => a[(Math.random() * a.length) | 0];
export const coarse = matchMedia('(pointer:coarse)').matches;

export const TOTAL_SPOTS = 30;
export const STORAGE_KEY = 'roblox_heaven_studio_save_v2';
export const PROJECTS_STORAGE_KEY = 'roblox_ugc_projects_v1';

export const PRESETS = [
  {head:0xf5cd30,torso:0x0088dd,armL:0xf5cd30,armR:0xf5cd30,legL:0x789048,legR:0x789048,hair:null,hat:null},
  {head:0xe8b89a,torso:0x3b4d6b,armL:0xe8b89a,armR:0xe8b89a,legL:0x22252a,legR:0x22252a,hair:0x7a421d,hat:null},
  {head:0xf5cd30,torso:0xe74c3c,armL:0xf5cd30,armR:0xf5cd30,legL:0x1f242d,legR:0x1f242d,hair:null,hat:0x111111},
  {head:0xf2c9ac,torso:0xff6b9d,armL:0xf2c9ac,armR:0xf2c9ac,legL:0xecf0f1,legR:0xecf0f1,hair:0xf1c40f,hat:null},
  {head:0xf5cd30,torso:0x8e44ad,armL:0xf5cd30,armR:0xf5cd30,legL:0x2c3e50,legR:0x2c3e50,hair:null,hat:0xffd700},
  {head:0xd2996c,torso:0x27ae60,armL:0xd2996c,armR:0xd2996c,legL:0x2c3e50,legR:0x2c3e50,hair:0x1a1a1a,hat:null}
];

export const NPC_NAMES = [
  'Noobik2014','RobuxKing777','BaconHair_Pro','Masha_Cat','AdoptMePlz',
  'SigmaBoy_Rbx','Dasha_Play','CoolVanya','Kotik_YT','VIP_RichMan',
  'Bebra_228','AngelicGirl','SpeedRunner','Pudge_Roblox','Skibidi_Pro',
  'LavaJumper','ObbyMaster','KapiBara99','SlapBattles','BrookhavenRP',
  'BloxFruit_God','Glitcher_X','Dreamer_77','Troller_XD','Mimic_Fan',
  'Doors_Pro','BuildABoat','MeepCity_Old','TowerOfHell','Fisch_Lover'
];

export const CHAT_LINES = [
  'Кто крайний в Рай??',
  'Я только спросить к Петру!',
  'Опять донатер без очереди!',
  'Пж дайте 5 робуксов на пропуск',
  'Не толкайтесь, я с 2019 стою!',
  'А в Раю дают бесплатный Доминус?',
  'Смотрите, Архангел сейчас повернётся!',
  'Пойду лучше Обби пройду...',
  'Кто ударит — получит сдачи!!',
  'Ура, осталось чуть-чуть!'
];

export const SWATCH_COLORS = [
  '#111111','#ffffff','#f5cd30','#ff3e3e','#00e676','#00a2ff',
  '#9b59b6','#ff9ff3','#e67e22','#f2f6ff','#ffd24c','#2c3e50'
];

export const ITEM_STUDIO_ORIGIN = new THREE.Vector3(0, 650, 0);

// Единое реактивное состояние движка, игры и DebiX Studio 3D
export const S = {
  state: 'menu', // 'menu' | 'play' | 'edit'
  gameMode: null,
  currentProjectId: null,
  currentProjectTitle: 'Новый проект',
  time: 0,
  SW: 1,
  SH: 1,

  worldSettings: {
    skyTop: '#1565c0',
    skyMid: '#62b6ff',
    skyBot: '#dff4ff',
    fogColor: '#88ccff',
    fogDensity: 0.0038,
    gravity: 22,
    respawnMode: 'timer', // 'instant' | 'timer' | 'spectator'
    respawnDelay: 3.5     // Секунд до респавна в режиме 'timer'
  },

  customDefaultStudDataURL: null,
  savedCosmeticsLibrary: [],
  savedItemsLibrary: [],

  queueCoords: [],
  allBlocks: [],
  customNPCs: [],
  spawnedCoins: [],
  worldItems: [],        // Предметы и контейнеры, лежащие/стоящие в мире
  activeProjectiles: [], // Активные летящие снаряды в мире
  colliderHelpers: [],
  showColliders: false,
  blockIdCounter: 1,
  itemIdCounter: 1,

  queueLine: [],
  player: null,
  archangelEnt: null,
  judgeTimer: 6.5,
  eyeTimer: 4.5,
  eyeWatching: false,
  activeSlot: 0,

  // Состояние боевой системы, прицеливания, перезарядки и метания
  lmbDown: false,
  isAimingRMB: false,
  isChargingThrow: false,
  throwChargeT: 0,
  isReloadingHold: false,
  reloadHoldT: 0,

  // Состояние смерти и спектатора
  playerDead: false,
  deathTimer: 0,
  deathReason: '',
  spectatorPos: new THREE.Vector3(0, 12, 18),
  spectatorYaw: 0,
  spectatorPitch: -0.3,

  // Состояние DebiX Studio 3D и истории Ctrl+Z
  selectedRef: null,
  snapEnabled: false,
  edCamPos: new THREE.Vector3(10, 12, 18),
  edYaw: 0.35,
  edPitch: -0.35,
  rmbDown: false,
  mmbDown: false,
  undoStack: [],

  // Состояние ввода и физики
  keys: {},
  yaw: 0,
  pitch: -0.28,
  btnJump: false,
  joy: { id: null, ox: 0, oy: 0, vx: 0, vy: 0 },
  look: { id: null, lx: 0, ly: 0 },
  contactDamageCooldown: 0
};

export function showBanner(txt, col = '#ffce3a') {
  const b = $('banner');
  if (!b) return;
  b.hidden = false;
  b.style.borderColor = col;
  b.textContent = txt;
  b.style.opacity = '1';
  clearTimeout(b._t);
  b._t = setTimeout(() => {
    b.style.opacity = '0';
  }, 3400);
}