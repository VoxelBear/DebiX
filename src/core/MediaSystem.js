// src/core/MediaSystem.js
import { S, clamp, showBanner } from './State.js';
import { camera } from './SceneManager.js';
import {
  sfx,
  initAudio,
  getAudioBuses,
  isMasterSoundOn,
  getMediaProxyBaseUrl
} from './AudioEngine.js';
import { updateMediaScreenUI, disposeScreenUI } from './MediaScreenUI.js';

const _msScreenRuntimes = new Map();  // blockId -> ScreenRuntime
const _msSpeakerRuntimes = new Map(); // blockId -> SpeakerRuntime

const _msCamPos = new THREE.Vector3();
const _msCamFwd = new THREE.Vector3();
const _msCamUp = new THREE.Vector3();
const _msTmpPos = new THREE.Vector3();
const _msTmpDir = new THREE.Vector3();
const _msLightPos = new THREE.Vector3();
const _msFrustum = new THREE.Frustum();
const _msProjScreenMat = new THREE.Matrix4();
const _msOccRaycaster = new THREE.Raycaster();
const _msSolidOccluders = [];
const _msFftBuf = new Uint8Array(64);

let _msAmbiCanvas = null;
let _msAmbiCtx = null;
let _msSharedPlaneGeo = null;
let _msSharedReactRingGeo = null;
let _msUnlockBound = false;
let _msUnlockedOnce = false;

/* ---------- БАЗОВЫЕ ДАННЫЕ КОМПОНЕНТОВ ---------- */

export function createDefaultMediaScreenData() {
  return {
    sourceType: 'url',          // 'url' | 'library'
    url: '',                    // прямая ссылка на видео или YouTube
    videoId: '',                // id из S.customVideoLibrary
    autoplay: true,
    loop: true,
    playing: true,
    fitMode: 'stretch',         // 'stretch' | 'contain' | 'cover'
    face: 'front',              // 'front' | 'back' | 'front_back' | 'top' | 'all'
    audioOutputMode: 'auto',    // 'auto' (сам экран, если нет колонок) | 'speakers_only' | 'always_screen'
    builtInVolume: 0.9,
    builtInRefDist: 4,
    builtInMaxDist: 32,
    brightness: 1.0,
    playbackRate: 1.0,
    interactKeyE: true,
    masterVolume: 1.0,
    muted: false,
    loopMode: 'queue',          // 'none' | 'queue' | 'one'
    shuffle: false,
    queueIndex: 0,
    queue: [],                  // [{ id, title, sourceType: 'url'|'library', url, videoId, duration }]
    ambilight: true,            // Динамический цветной PointLight от картинки видео
    ambilightIntensity: 1.8,
    ambilightDistance: 22,
    hostOnly: false,            // Только Хост может управлять экраном в мультиплеере
    queueCost: 0                // Цена в R$ за добавление видео в очередь (Jukebox)
  };
}

export function createDefaultSoundEmitterData() {
  return {
    mode: 'standalone',         // 'standalone' | 'screen_link'
    linkedScreenId: '',         // id блока-экрана (к одному экрану можно привязать сколько угодно колонок)
    sourceType: 'url',          // 'url' | 'library'
    url: '',                    // прямая ссылка или YouTube
    audioId: '',                // id из S.customAudioLibrary
    autoplay: true,
    loop: true,
    playing: true,
    volume: 1.0,
    refDistance: 4,
    maxDistance: 36,
    rolloff: 1.35,
    spatial3D: true,
    occlusion: true,            // Заглушение звука за стенами (lowpass-фильтр)
    audioReactive: true,        // Пульсация кольца/подсветки колонки в такт басам
    playbackRate: 1.0,
    interactKeyE: true,
    loopMode: 'queue',          // 'none' | 'queue' | 'one' (для самостоятельной колонки-радио)
    shuffle: false,
    queueIndex: 0,
    queue: []                   // [{ id, title, sourceType: 'url'|'library', url, audioId, duration }]
  };
}

/* ---------- ПОМОЩНИКИ ССЫЛОК, ПРОКСИ И ЗАГРУЗКИ ВИДЕО ---------- */

export function isYouTubeOrStreamPageUrl(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const h = new URL(s).hostname.toLowerCase();
    return (
      h.includes('youtube.com') ||
      h.includes('youtu.be') ||
      h.includes('soundcloud.com') ||
      h.includes('twitch.tv') ||
      h.includes('vimeo.com') ||
      h.includes('rutube.ru') ||
      h.includes('vk.com') ||
      h.includes('vkvideo.ru')
    );
  } catch (_) {
    return false;
  }
}

export function resolveMediaPlaybackUrl(rawUrl, kind = 'video') {
  const s = String(rawUrl || '').trim();
  if (!s) return '';
  if (s.startsWith('data:') || s.startsWith('blob:')) return s;
  if (!/^https?:\/\//i.test(s)) return s;

  const base = getMediaProxyBaseUrl();
  if (isYouTubeOrStreamPageUrl(s)) {
    return `${base}/api/media/stream?kind=${kind === 'audio' ? 'audio' : 'video'}&url=${encodeURIComponent(s)}`;
  }
  return `${base}/api/media/proxy?url=${encodeURIComponent(s)}`;
}

export function promptUploadCustomVideo(onLoaded = null) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'video/*,.mp4,.webm,.ogv,.mov,.mkv';
  inp.onchange = e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const cleanName = file.name.replace(/\.[^.]+$/, '').slice(0, 38) || 'Видео';
    if (!Array.isArray(S.customVideoLibrary)) S.customVideoLibrary = [];

    // Небольшие видео (<= 10 МБ) сохраняем в DataURL (переживают сохранение проекта), крупные — через Blob URL в сессии
    if (file.size <= 10 * 1024 * 1024) {
      const reader = new FileReader();
      reader.onload = ev => {
        const entry = {
          id: 'vid_' + Date.now() + '_' + Math.floor(Math.random() * 999),
          name: cleanName,
          sourceType: 'file',
          dataURL: ev.target.result,
          url: ''
        };
        S.customVideoLibrary.push(entry);
        sfx.cash?.();
        showBanner(`🎬 Видео «${entry.name}» добавлено в библиотеку проекта!`, '#00e676');
        if (onLoaded) onLoaded(entry);
      };
      reader.readAsDataURL(file);
    } else {
      const blobUrl = URL.createObjectURL(file);
      const entry = {
        id: 'vid_' + Date.now() + '_' + Math.floor(Math.random() * 999),
        name: `${cleanName} (Лок. файл)`,
        sourceType: 'blob',
        dataURL: null,
        url: blobUrl,
        isSessionOnly: true
      };
      S.customVideoLibrary.push(entry);
      sfx.cash?.();
      showBanner(`🎬 Большое видео «${cleanName}» загружено на сессию! (Для сохранения в .JSON используй ссылку или файл <10 МБ)`, '#56f0ff');
      if (onLoaded) onLoaded(entry);
    }
  };
  inp.click();
}

export function promptAddStreamVideo(onLoaded = null) {
  const rawUrl = prompt(
    'Вставь ссылку на YouTube или прямой видеофайл (.mp4 / .webm):',
    'https://'
  );
  if (!rawUrl || !rawUrl.trim() || rawUrl.trim() === 'https://') return;
  const cleanUrl = rawUrl.trim();
  if (!/^https?:\/\//i.test(cleanUrl)) {
    showBanner('⚠️ Ссылка должна начинаться с http:// или https://', '#ffce3a');
    return;
  }
  const defTitle = cleanUrl.includes('youtu')
    ? 'YouTube Видео'
    : (cleanUrl.split('/').pop()?.split('?')[0]?.slice(0, 32) || 'Видео по ссылке');
  const title = (prompt('Название видео в библиотеке:', defTitle) || defTitle).trim().slice(0, 38);

  if (!Array.isArray(S.customVideoLibrary)) S.customVideoLibrary = [];
  const entry = {
    id: 'vid_' + Date.now() + '_' + Math.floor(Math.random() * 999),
    name: title,
    sourceType: 'url',
    url: cleanUrl,
    dataURL: null
  };
  S.customVideoLibrary.push(entry);
  sfx.cash?.();
  showBanner(`🌐 Видео-ссылка «${entry.name}» добавлена!`, '#00e676');
  if (onLoaded) onLoaded(entry);
}

/* ---------- АВТОРАЗБЛОКИРОВКА АВТОПЛЕЯ ПОСЛЕ ПЕРВОГО КЛИКА ---------- */

function ensureAutoplayUnlockHook() {
  if (_msUnlockBound) return;
  _msUnlockBound = true;
  const onFirstGesture = () => {
    _msUnlockedOnce = true;
    initAudio();
    for (const rt of _msScreenRuntimes.values()) {
      if (rt.wantPlay && rt.videoEl && rt.videoEl.paused && rt.resolvedSrc) {
        rt.videoEl.play().catch(() => {});
      }
    }
    for (const spk of _msSpeakerRuntimes.values()) {
      if (spk.wantPlay && spk.audioEl && spk.audioEl.paused && spk.resolvedSrc) {
        spk.audioEl.play().catch(() => {});
      }
    }
  };
  window.addEventListener('pointerdown', onFirstGesture, { passive: true });
  window.addEventListener('keydown', onFirstGesture, { passive: true });
}

/* ---------- ЗАГЛУШКА ЭКРАНА (СТАТУС / ОЖИДАНИЕ ПОТОКА) ---------- */

function createStatusScreenTexture(title, sub = '', accentHex = '#56f0ff') {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 288;
  const ctx = c.getContext('2d');

  const grd = ctx.createLinearGradient(0, 0, 512, 288);
  grd.addColorStop(0, '#0a0f1c');
  grd.addColorStop(1, '#141e33');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, 512, 288);

  ctx.strokeStyle = accentHex;
  ctx.lineWidth = 6;
  ctx.strokeRect(10, 10, 492, 268);

  ctx.fillStyle = '#ffffff';
  ctx.font = '800 30px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, 256, sub ? 124 : 144);

  if (sub) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 18px Montserrat, sans-serif';
    ctx.fillText(sub.slice(0, 46), 256, 174);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

function getSharedPlaneGeo() {
  if (!_msSharedPlaneGeo) {
    _msSharedPlaneGeo = new THREE.PlaneGeometry(1, 1);
  }
  return _msSharedPlaneGeo;
}

/* ---------- ПОСТРОЕНИЕ 3D-ПОВЕРХНОСТИ ЭКРАНА И АВТО-СКЕЙЛ ---------- */

function getFaceSpecsForMode(faceMode) {
  if (faceMode === 'back') {
    return [{ id: 'back', axis: 'z', sign: -1, rot: [0, Math.PI, 0] }];
  }
  if (faceMode === 'front_back') {
    return [
      { id: 'front', axis: 'z', sign: 1, rot: [0, 0, 0] },
      { id: 'back', axis: 'z', sign: -1, rot: [0, Math.PI, 0] }
    ];
  }
  if (faceMode === 'top') {
    return [{ id: 'top', axis: 'y', sign: 1, rot: [-Math.PI / 2, 0, 0] }];
  }
  if (faceMode === 'all') {
    return [
      { id: 'front', axis: 'z', sign: 1, rot: [0, 0, 0] },
      { id: 'back', axis: 'z', sign: -1, rot: [0, Math.PI, 0] },
      { id: 'right', axis: 'x', sign: 1, rot: [0, Math.PI / 2, 0] },
      { id: 'left', axis: 'x', sign: -1, rot: [0, -Math.PI / 2, 0] },
      { id: 'top', axis: 'y', sign: 1, rot: [-Math.PI / 2, 0, 0] },
      { id: 'bottom', axis: 'y', sign: -1, rot: [Math.PI / 2, 0, 0] }
    ];
  }
  return [{ id: 'front', axis: 'z', sign: 1, rot: [0, 0, 0] }];
}

function getFaceWorldDimensions(box, faceId) {
  const w = Math.max(0.1, box.w || box.m?.scale?.x || 1);
  const h = Math.max(0.1, box.h || box.m?.scale?.y || 1);
  const d = Math.max(0.1, box.d || box.m?.scale?.z || 1);
  if (faceId === 'top' || faceId === 'bottom') return { fw: w, fh: d, depth: h };
  if (faceId === 'left' || faceId === 'right') return { fw: d, fh: h, depth: w };
  return { fw: w, fh: h, depth: d };
}

function rebuildScreenOverlayGroup(box, rt, faceMode) {
  if (rt.screenGroup && rt.screenGroup.parent) {
    rt.screenGroup.parent.remove(rt.screenGroup);
  }
  if (rt.screenGroup) {
    rt.screenGroup.traverse(o => {
      if (o.isMesh && o.material && o.material !== rt.videoMat && o.material !== rt.backMat) {
        o.material.dispose?.();
      }
    });
  }

  const grp = new THREE.Group();
  grp.name = 'DebiXMediaScreenGroup';
  grp.userData.noCollider = true;

  if (!rt.backMat) {
    rt.backMat = new THREE.MeshBasicMaterial({ color: 0x05070e, toneMapped: false });
  }
  if (!rt.videoMat) {
    rt.videoMat = new THREE.MeshBasicMaterial({
      map: rt.placeholderTex,
      color: 0xffffff,
      toneMapped: false
    });
  }

  const planeGeo = getSharedPlaneGeo();
  const specs = getFaceSpecsForMode(faceMode);
  rt.faceEntries = [];

  for (const sp of specs) {
    const faceWrap = new THREE.Group();
    faceWrap.rotation.set(sp.rot[0], sp.rot[1], sp.rot[2]);

    const backMesh = new THREE.Mesh(planeGeo, rt.backMat);
    backMesh.userData.noCollider = true;
    backMesh.userData.editorRef = { kind: 'block', box };

    const vidMesh = new THREE.Mesh(planeGeo, rt.videoMat);
    vidMesh.position.z = 0.001;
    vidMesh.userData.noCollider = true;
    vidMesh.userData.editorRef = { kind: 'block', box };

    const uiMesh = new THREE.Mesh(planeGeo, rt.uiMat || new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
    uiMesh.position.z = 0.002;
    uiMesh.visible = false;
    uiMesh.renderOrder = 5;
    uiMesh.userData.noCollider = true;
    uiMesh.userData.isMediaScreenUI = true;
    uiMesh.userData.screenBlockId = box.id;
    uiMesh.userData.faceId = sp.id;
    uiMesh.userData.editorRef = { kind: 'block', box };

    faceWrap.add(backMesh, vidMesh, uiMesh);
    grp.add(faceWrap);
    rt.faceEntries.push({ spec: sp, wrap: faceWrap, backMesh, vidMesh, uiMesh });
  }

  rt.screenGroup = grp;
  rt.appliedFaceMode = faceMode;
  box._screenGroup = grp;
  if (box.m) box.m.add(grp);
}

function updateScreenSurfaceScaling(box, rt) {
  if (!rt || !rt.faceEntries || !box || !box.m) return;
  const sd = box.mediaScreenData || createDefaultMediaScreenData();
  const fitMode = sd.fitMode || 'stretch';
  const vw = rt.videoEl?.videoWidth || 16;
  const vh = rt.videoEl?.videoHeight || 9;
  const vidAspect = vw > 0 && vh > 0 ? vw / vh : (16 / 9);

  // Сбрасываем UV-повтор для текстуры (если cover — настраиваем ниже)
  const activeTex = rt.videoMat?.map;

  for (let i = 0; i < rt.faceEntries.length; i++) {
    const fe = rt.faceEntries[i];
    const { fw, fh, depth } = getFaceWorldDimensions(box, fe.spec.id);
    const surfAspect = fw / fh;

    // Небольшой физический отступ наружу (не зависит от толщины блока, без z-fighting)
    const eps = Math.min(0.025, 0.014 / Math.max(0.1, depth));
    const offset = 0.5 + eps;
    fe.wrap.position.set(
      fe.spec.axis === 'x' ? fe.spec.sign * offset : 0,
      fe.spec.axis === 'y' ? fe.spec.sign * offset : 0,
      fe.spec.axis === 'z' ? fe.spec.sign * offset : 0
    );
    const vidEps = Math.min(0.01, 0.004 / Math.max(0.1, depth));
    fe.vidMesh.position.z = vidEps;
    if (fe.uiMesh) {
      fe.uiMesh.position.z = vidEps * 2.1;
      fe.uiMesh.userData.faceWorldW = fw;
      fe.uiMesh.userData.faceWorldH = fh;
    }

    if (fitMode === 'contain' && rt.hasVideoFrame) {
      if (surfAspect > vidAspect) {
        fe.vidMesh.scale.set(vidAspect / surfAspect, 1, 1);
      } else {
        fe.vidMesh.scale.set(1, surfAspect / vidAspect, 1);
      }
      if (activeTex && i === 0) {
        activeTex.repeat.set(1, 1);
        activeTex.offset.set(0, 0);
      }
    } else if (fitMode === 'cover' && rt.hasVideoFrame) {
      fe.vidMesh.scale.set(1, 1, 1);
      if (activeTex && i === 0) {
        if (surfAspect > vidAspect) {
          const sy = vidAspect / surfAspect;
          activeTex.repeat.set(1, sy);
          activeTex.offset.set(0, (1 - sy) * 0.5);
        } else {
          const sx = surfAspect / vidAspect;
          activeTex.repeat.set(sx, 1);
          activeTex.offset.set((1 - sx) * 0.5, 0);
        }
      }
    } else {
      // 'stretch' — скейл 1:1 по текущим размерам поверхности
      fe.vidMesh.scale.set(1, 1, 1);
      if (activeTex && i === 0) {
        activeTex.repeat.set(1, 1);
        activeTex.offset.set(0, 0);
      }
    }
  }

  const br = clamp(Number(sd.brightness) ?? 1.0, 0.15, 2.5);
  if (rt.videoMat) {
    rt.videoMat.color.setRGB(br, br, br);
  }
}

/* ---------- ПОЛУЧЕНИЕ ИСТОЧНИКОВ ИЗ НАСТРОЕК БЛОКА ---------- */

function resolveScreenRawSource(sd) {
  if (!sd) return '';
  if (Array.isArray(sd.queue) && sd.queue.length > 0) {
    const idx = clamp(sd.queueIndex || 0, 0, sd.queue.length - 1);
    sd.queueIndex = idx;
    const item = sd.queue[idx];
    if (item) {
      if (item.sourceType === 'library' && item.videoId) {
        const entry = (S.customVideoLibrary || []).find(v => v && v.id === item.videoId);
        return entry ? (entry.dataURL || entry.url || '') : '';
      }
      return String(item.url || '').trim();
    }
  }
  if (sd.sourceType === 'library' && sd.videoId) {
    const entry = (S.customVideoLibrary || []).find(v => v && v.id === sd.videoId);
    if (!entry) return '';
    return entry.dataURL || entry.url || '';
  }
  return String(sd.url || '').trim();
}

function resolveSpeakerRawSource(ed) {
  if (!ed) return '';
  if (Array.isArray(ed.queue) && ed.queue.length > 0) {
    const idx = clamp(ed.queueIndex || 0, 0, ed.queue.length - 1);
    ed.queueIndex = idx;
    const item = ed.queue[idx];
    if (item) {
      if (item.sourceType === 'library' && item.audioId) {
        const cleanId = String(item.audioId).replace(/^custom:/, '');
        const entry = (S.customAudioLibrary || []).find(a => a && a.id === cleanId);
        return entry ? (entry.dataURL || entry.url || '') : '';
      }
      return String(item.url || '').trim();
    }
  }
  if (ed.sourceType === 'library' && ed.audioId) {
    const cleanId = String(ed.audioId).replace(/^custom:/, '');
    const entry = (S.customAudioLibrary || []).find(a => a && a.id === cleanId);
    if (!entry) return '';
    return entry.dataURL || entry.url || '';
  }
  return String(ed.url || '').trim();
}

/* ---------- СОЗДАНИЕ И ОБНОВЛЕНИЕ ПРОСТРАНСТВЕННОГО УЗЛА (3D PANNER) ---------- */

function createSpatialChain(AC, mediaBus, spatial3D = true) {
  const gainNode = AC.createGain();
  gainNode.gain.value = 0;

  const filterNode = AC.createBiquadFilter();
  filterNode.type = 'lowpass';
  filterNode.frequency.value = 20000;
  filterNode.Q.value = 0.7;

  const pannerNode = AC.createPanner();
  pannerNode.panningModel = 'equalpower';
  pannerNode.distanceModel = 'inverse';
  pannerNode.refDistance = 1;
  pannerNode.maxDistance = 10000;
  // Затуханием по дистанции управляем точно сами через gainNode (строго до 0 на maxDistance),
  // а PannerNode даёт чистую 3D-панораму (лево/право/фронт/тыл)
  pannerNode.rolloffFactor = 0;

  gainNode.connect(filterNode);
  filterNode.connect(pannerNode);
  pannerNode.connect(mediaBus);

  return { gainNode, filterNode, pannerNode };
}

function sampleBassFromAnalyser(analyser) {
  if (!analyser) return 0;
  try {
    analyser.getByteFrequencyData(_msFftBuf);
    let sum = 0;
    const bins = Math.min(7, analyser.frequencyBinCount || 7);
    for (let i = 0; i < bins; i++) sum += _msFftBuf[i];
    return clamp((sum / Math.max(1, bins)) / 255, 0, 1);
  } catch (_) {
    return 0;
  }
}

function sampleAmbilightColorFromVideo(videoEl, outColor) {
  if (!videoEl || videoEl.readyState < 2 || videoEl.videoWidth <= 0) return 0;
  if (!_msAmbiCanvas) {
    _msAmbiCanvas = document.createElement('canvas');
    _msAmbiCanvas.width = 8;
    _msAmbiCanvas.height = 8;
    _msAmbiCtx = _msAmbiCanvas.getContext('2d', { willReadFrequently: true });
  }
  try {
    _msAmbiCtx.drawImage(videoEl, 0, 0, 8, 8);
    const data = _msAmbiCtx.getImageData(0, 0, 8, 8).data;
    let r = 0, g = 0, b = 0;
    const px = 64;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    r = r / (px * 255);
    g = g / (px * 255);
    b = b / (px * 255);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    const sat = 1.35;
    outColor.setRGB(
      clamp(lum + (r - lum) * sat, 0, 1),
      clamp(lum + (g - lum) * sat, 0, 1),
      clamp(lum + (b - lum) * sat, 0, 1)
    );
    return lum;
  } catch (_) {
    return 0;
  }
}

function evaluateAudioOcclusion(sourcePos, dist, ignoreIdA, ignoreIdB = '') {
  if (dist < 1.5 || dist > 55 || _msSolidOccluders.length === 0) return 0;
  _msTmpDir.subVectors(sourcePos, _msCamPos).divideScalar(dist);
  _msOccRaycaster.near = 0.25;
  _msOccRaycaster.far = Math.max(0.3, dist - 0.45);
  _msOccRaycaster.set(_msCamPos, _msTmpDir);

  const hits = _msOccRaycaster.intersectObjects(_msSolidOccluders, false);
  let wallCount = 0;
  for (let i = 0; i < hits.length; i++) {
    const b = hits[i].object?.userData?.editorRef?.box;
    if (!b || b.id === ignoreIdA || b.id === ignoreIdB) continue;
    wallCount++;
    if (wallCount >= 2) break;
  }
  return wallCount;
}

function updateSpeakerAudioReactiveVisual(box, spk, bassLevel, enabled) {
  if (!box || !box.m) return;
  if (!enabled || !box.m.visible) {
    if (spk.reactRing) spk.reactRing.visible = false;
    return;
  }
  if (!spk.reactRing) {
    if (!_msSharedReactRingGeo) {
      _msSharedReactRingGeo = new THREE.TorusGeometry(0.34, 0.045, 10, 28);
    }
    const mat = new THREE.MeshBasicMaterial({
      color: 0x00e676,
      transparent: true,
      opacity: 0.78,
      toneMapped: false
    });
    const ring = new THREE.Mesh(_msSharedReactRingGeo, mat);
    ring.userData.noCollider = true;
    ring.userData.editorRef = { kind: 'block', box };
    box.m.add(ring);
    spk.reactRing = ring;
  }
  const depth = Math.max(0.1, box.d || box.m.scale.z || 1);
  spk.reactRing.visible = true;
  spk.reactRing.position.set(0, 0, 0.5 + Math.min(0.03, 0.015 / depth));
  const pulse = 0.85 + bassLevel * 0.42;
  spk.reactRing.scale.set(pulse, pulse, 1);
  spk.reactRing.material.opacity = clamp(0.35 + bassLevel * 0.65, 0.25, 1.0);
  spk.reactRing.material.color.setHSL(0.42 - bassLevel * 0.34, 0.95, 0.55 + bassLevel * 0.12);
}

function setPannerWorldPos(panner, pos, spatial3D = true) {
  if (!panner || !pos) return;
  const x = spatial3D ? pos.x : _msCamPos.x;
  const y = spatial3D ? pos.y : _msCamPos.y;
  const z = spatial3D ? pos.z : _msCamPos.z;
  if (panner.positionX) {
    panner.positionX.value = x;
    panner.positionY.value = y;
    panner.positionZ.value = z;
  } else if (typeof panner.setPosition === 'function') {
    panner.setPosition(x, y, z);
  }
}

function computeDistanceGain(dist, refDist, maxDist, rolloff = 1.35) {
  const r = Math.max(0.5, Number(refDist) || 4);
  const m = Math.max(r + 1, Number(maxDist) || 32);
  if (dist <= r) return 1.0;
  if (dist >= m) return 0.0;
  const t = 1 - (dist - r) / (m - r);
  return clamp(Math.pow(t, clamp(Number(rolloff) || 1.35, 0.3, 4.0)), 0, 1);
}

/* ---------- УПРАВЛЕНИЕ РАНТАЙМОМ ЭКРАНА ---------- */

function ensureScreenRuntime(box) {
  ensureAutoplayUnlockHook();
  let rt = _msScreenRuntimes.get(box.id);
  if (rt) {
    rt.box = box;
    return rt;
  }

  const videoEl = document.createElement('video');
  videoEl.crossOrigin = 'anonymous';
  videoEl.playsInline = true;
  videoEl.preload = 'auto';
  videoEl.muted = false;
  videoEl.loop = true;

  const placeholderTex = createStatusScreenTexture('📺 ВИДЕО-ЭКРАН', 'Укажи ссылку или выбери видео в Инспекторе', '#56f0ff');

  rt = {
    blockId: box.id,
    box,
    videoEl,
    placeholderTex,
    videoTex: null,
    videoMat: null,
    backMat: null,
    screenGroup: null,
    faceEntries: [],
    appliedFaceMode: null,
    lastRawSrc: null,
    resolvedSrc: '',
    hasVideoFrame: false,
    wantPlay: false,
    sourceNode: null,
    screenBusGain: null,
    builtInChain: null,
    analyser: null,
    linkedSpeakers: new Set(), // Set<SpeakerRuntime> — без ограничений по количеству!
    lastScaleSig: '',
    ambiColor: new THREE.Color(0x000000),
    ambiTargetColor: new THREE.Color(0x000000),
    ambiTimer: 0,
    ambiLum: 0,
    bassLevel: 0,
    occTimer: 0,
    occWalls: 0,
    distToCam: 0,
    inFrustum: true,
    isScreenShare: false,
    isRemoteShare: false,
    shareStream: null
  };

  videoEl.addEventListener('loadeddata', () => {
    if (!_msScreenRuntimes.has(box.id)) return;
    rt.hasVideoFrame = true;
    if (!rt.videoTex) {
      rt.videoTex = new THREE.VideoTexture(videoEl);
      rt.videoTex.minFilter = THREE.LinearFilter;
      rt.videoTex.magFilter = THREE.LinearFilter;
      rt.videoTex.generateMipmaps = false;
    }
    if (rt.videoMat) {
      rt.videoMat.map = rt.videoTex;
      rt.videoMat.needsUpdate = true;
    }
    updateScreenSurfaceScaling(rt.box, rt);
  });

  videoEl.addEventListener('ended', () => {
    if (!_msScreenRuntimes.has(box.id)) return;
    const sd = rt.box?.mediaScreenData;
    if (!sd) return;
    const loopMode = sd.loopMode || (sd.loop !== false ? 'queue' : 'none');
    const q = Array.isArray(sd.queue) ? sd.queue : [];

    if (loopMode === 'one') {
      try { videoEl.currentTime = 0; videoEl.play().catch(() => {}); } catch (_) {}
      return;
    }
    if (q.length > 0) {
      if (sd.shuffle && q.length > 1) {
        let nextIdx = sd.queueIndex || 0;
        while (nextIdx === (sd.queueIndex || 0)) {
          nextIdx = Math.floor(Math.random() * q.length);
        }
        sd.queueIndex = nextIdx;
        sd.playing = true;
        syncSingleScreen(rt.box, !rt.box.isDisabled);
        return;
      }
      const nextIdx = (sd.queueIndex || 0) + 1;
      if (nextIdx < q.length) {
        sd.queueIndex = nextIdx;
        sd.playing = true;
        syncSingleScreen(rt.box, !rt.box.isDisabled);
      } else if (loopMode === 'queue') {
        sd.queueIndex = 0;
        sd.playing = true;
        syncSingleScreen(rt.box, !rt.box.isDisabled);
      } else {
        sd.playing = false;
      }
    } else if (loopMode === 'queue') {
      try { videoEl.currentTime = 0; videoEl.play().catch(() => {}); } catch (_) {}
    } else {
      sd.playing = false;
    }
  });

  videoEl.addEventListener('error', () => {
    if (!_msScreenRuntimes.has(box.id) || !rt.resolvedSrc) return;
    rt.hasVideoFrame = false;
    if (rt.placeholderTex) rt.placeholderTex.dispose();
    rt.placeholderTex = createStatusScreenTexture('⚠️ ОШИБКА ПОТОКА', 'Проверь ссылку или lan-server.js / yt-dlp', '#ff4757');
    if (rt.videoMat) {
      rt.videoMat.map = rt.placeholderTex;
      rt.videoMat.needsUpdate = true;
    }
  });

  _msScreenRuntimes.set(box.id, rt);
  return rt;
}

function ensureScreenAudioGraph(rt) {
  if (!rt || rt.screenBusGain) return true;
  const { AC, mediaGain, masterGain } = getAudioBuses();
  if (!AC) return false;
  try {
    rt.sourceNode = AC.createMediaElementSource(rt.videoEl);
    rt.screenBusGain = AC.createGain();
    rt.screenBusGain.gain.value = 1.0;
    rt.sourceNode.connect(rt.screenBusGain);

    rt.analyser = AC.createAnalyser();
    rt.analyser.fftSize = 128;
    rt.analyser.smoothingTimeConstant = 0.72;
    rt.screenBusGain.connect(rt.analyser);

    // Встроенный 3D-динамик самого экрана (работает в режиме 'auto' при 0 колонках или 'always_screen')
    rt.builtInChain = createSpatialChain(AC, mediaGain || masterGain, true);
    rt.screenBusGain.connect(rt.builtInChain.gainNode);
    return true;
  } catch (err) {
    console.warn('Screen WebAudio graph error:', err);
    return false;
  }
}

function syncSingleScreen(box, isActiveInWorld, dt = 0.016) {
  const sd = box.mediaScreenData || (box.mediaScreenData = createDefaultMediaScreenData());
  const rt = ensureScreenRuntime(box);

  const desiredFace = sd.face || 'front';
  if (!rt.screenGroup || rt.appliedFaceMode !== desiredFace || rt.screenGroup.parent !== box.m) {
    rebuildScreenOverlayGroup(box, rt, desiredFace);
  }
  if (rt.screenGroup) {
    rt.screenGroup.visible = Boolean(box.m && box.m.visible);
  }

  box.m.getWorldPosition(_msTmpPos);
  rt.distToCam = _msTmpPos.distanceTo(_msCamPos);
  rt.inFrustum = _msFrustum.containsPoint(_msTmpPos) || rt.distToCam < (Math.max(box.w, box.h, box.d) + 8);

  const isLiveStream = Boolean(rt.isScreenShare || rt.isRemoteShare);
  if (!isLiveStream) {
    const rawSrc = resolveScreenRawSource(sd);
  if (rawSrc !== rt.lastRawSrc) {
    rt.lastRawSrc = rawSrc;
    rt.hasVideoFrame = false;
    if (!rawSrc) {
      rt.resolvedSrc = '';
      try { rt.videoEl.pause(); rt.videoEl.removeAttribute('src'); rt.videoEl.load(); } catch (_) {}
      if (rt.placeholderTex) rt.placeholderTex.dispose();
      rt.placeholderTex = createStatusScreenTexture('📺 ВИДЕО-ЭКРАН', 'Добавь видеофайл или ссылку (YouTube / MP4)', '#56f0ff');
      if (rt.videoMat) {
        rt.videoMat.map = rt.placeholderTex;
        rt.videoMat.needsUpdate = true;
      }
    } else {
      rt.resolvedSrc = resolveMediaPlaybackUrl(rawSrc, 'video');
      if (rt.placeholderTex) rt.placeholderTex.dispose();
      rt.placeholderTex = createStatusScreenTexture('⏳ ЗАГРУЗКА ВИДЕО...', rawSrc.slice(0, 42), '#ffce3a');
      if (rt.videoMat) {
        rt.videoMat.map = rt.placeholderTex;
        rt.videoMat.needsUpdate = true;
      }
      rt.videoEl.src = rt.resolvedSrc;
      rt.videoEl.load();
    }
    }
  }

  const hasQueue = Array.isArray(sd.queue) && sd.queue.length > 0;
  const effLoopMode = sd.loopMode || (sd.loop !== false ? 'queue' : 'none');
  // При непустой очереди loop отключаем, чтобы срабатывало событие 'ended' для перехода к следующему видео
  rt.videoEl.loop = !isLiveStream && !hasQueue && effLoopMode !== 'none';
  const targetRate = clamp(Number(sd.playbackRate) || 1.0, 0.25, 3.0);
  if (!isLiveStream && Math.abs(rt.videoEl.playbackRate - targetRate) > 0.02) {
    try { rt.videoEl.playbackRate = targetRate; } catch (_) {}
  }

  const shouldPlay = isActiveInWorld && (isLiveStream || (Boolean(rt.resolvedSrc) && Boolean(sd.playing)));
  rt.wantPlay = shouldPlay;

  if (shouldPlay) {
    if (_msUnlockedOnce || S.state === 'play') {
      ensureScreenAudioGraph(rt);
    }
    if (rt.videoEl.paused && !rt._playPending) {
      rt._playPending = true;
      rt.videoEl.play()
        .catch(() => {})
        .finally(() => { rt._playPending = false; });
    }
  } else if (!rt.videoEl.paused) {
    try { rt.videoEl.pause(); } catch (_) {}
  }

  // Пересчёт скейла при изменении габаритов поверхности или режима заполнения
  const scaleSig = `${box.w.toFixed(3)}|${box.h.toFixed(3)}|${box.d.toFixed(3)}|${sd.fitMode}|${sd.brightness}|${rt.hasVideoFrame ? 1 : 0}`;
  if (scaleSig !== rt.lastScaleSig) {
    rt.lastScaleSig = scaleSig;
    updateScreenSurfaceScaling(box, rt);
  }

  // Анализ басов и Ambilight (оптимизировано: только для видимых экранов в радиусе 55м)
  rt.bassLevel = (shouldPlay && rt.analyser && rt.distToCam < 55) ? sampleBassFromAnalyser(rt.analyser) : 0;

  if (shouldPlay && rt.hasVideoFrame && sd.ambilight !== false && rt.inFrustum && rt.distToCam < 55) {
    rt.ambiTimer += dt;
    if (rt.ambiTimer >= 0.12) {
      rt.ambiTimer = 0;
      rt.ambiLum = sampleAmbilightColorFromVideo(rt.videoEl, rt.ambiTargetColor);
    }
    rt.ambiColor.lerp(rt.ambiTargetColor, clamp(dt * 8, 0.05, 1));
  } else {
    rt.ambiLum = Math.max(0, rt.ambiLum - dt * 3);
    rt.ambiColor.multiplyScalar(Math.max(0, 1 - dt * 4));
  }

  // Пространственный расчёт встроенного динамика экрана + Occlusion за стенами
  if (rt.builtInChain && rt.screenBusGain) {
    const { AC } = getAudioBuses();
    const outMode = sd.audioOutputMode || 'auto';
    const hasActiveLinkedSpeakers = rt.linkedSpeakers.size > 0;
    const builtInAllowed =
      outMode === 'always_screen' ||
      (outMode === 'auto' && !hasActiveLinkedSpeakers);

    if (shouldPlay && builtInAllowed && isMasterSoundOn() && AC && S.state !== 'menu') {
      box.m.getWorldPosition(_msTmpPos);
      setPannerWorldPos(rt.builtInChain.pannerNode, _msTmpPos, true);
      const dist = _msTmpPos.distanceTo(_msCamPos);
      const atten = computeDistanceGain(dist, sd.builtInRefDist ?? 4, sd.builtInMaxDist ?? 32, 1.35);

      rt.occTimer -= dt;
      if (rt.occTimer <= 0) {
        rt.occTimer = 0.18;
        rt.occWalls = evaluateAudioOcclusion(_msTmpPos, dist, box.id);
      }
      const occGain = rt.occWalls >= 2 ? 0.32 : (rt.occWalls === 1 ? 0.52 : 1.0);
      const occFreq = rt.occWalls >= 2 ? 420 : (rt.occWalls === 1 ? 750 : 20000);

      const screenMaster = sd.muted ? 0 : clamp(Number(sd.masterVolume ?? 1.0), 0, 1.5);
      const vol = clamp(Number(sd.builtInVolume) ?? 0.9, 0, 2.0) * screenMaster * atten * occGain;
      rt.builtInChain.gainNode.gain.setTargetAtTime(vol, AC.currentTime, 0.04);
      rt.builtInChain.filterNode?.frequency.setTargetAtTime(occFreq, AC.currentTime, 0.08);
    } else if (AC) {
      rt.builtInChain.gainNode.gain.setTargetAtTime(0, AC.currentTime, 0.04);
    }
  }
}

/* ---------- УПРАВЛЕНИЕ РАНТАЙМОМ 3D-КОЛОНКИ ---------- */

function detachSpeakerFromScreen(spk) {
  if (!spk || !spk.attachedScreenRt) return;
  const scr = spk.attachedScreenRt;
  scr.linkedSpeakers.delete(spk);
  if (scr.screenBusGain && spk.screenLinkChain?.gainNode) {
    try { scr.screenBusGain.disconnect(spk.screenLinkChain.gainNode); } catch (_) {}
  }
  if (spk.screenLinkChain) {
    try { spk.screenLinkChain.gainNode.disconnect(); } catch (_) {}
    try { spk.screenLinkChain.pannerNode.disconnect(); } catch (_) {}
    spk.screenLinkChain = null;
  }
  spk.attachedScreenRt = null;
  spk.attachedScreenId = '';
}

function stopStandaloneSpeakerAudio(spk) {
  if (!spk) return;
  if (spk.audioEl) {
    try { spk.audioEl.pause(); spk.audioEl.removeAttribute('src'); spk.audioEl.load(); } catch (_) {}
  }
  spk.lastRawSrc = null;
  spk.resolvedSrc = '';
}

function ensureSpeakerRuntime(box) {
  ensureAutoplayUnlockHook();
  let spk = _msSpeakerRuntimes.get(box.id);
  if (spk) {
    spk.box = box;
    return spk;
  }
  spk = {
    blockId: box.id,
    box,
    // Ветка для режима 'screen_link'
    attachedScreenId: '',
    attachedScreenRt: null,
    screenLinkChain: null,
    // Ветка для режима 'standalone'
    audioEl: null,
    audioSourceNode: null,
    standaloneChain: null,
    analyser: null,
    bassLevel: 0,
    occTimer: 0,
    occWalls: 0,
    reactRing: null,
    lastRawSrc: null,
    resolvedSrc: '',
    wantPlay: false
  };
  _msSpeakerRuntimes.set(box.id, spk);
  return spk;
}

function ensureStandaloneAudioGraph(spk) {
  const { AC, mediaGain, masterGain } = getAudioBuses();
  if (!AC) return false;
  if (!spk.audioEl) {
    const el = document.createElement('audio');
    el.crossOrigin = 'anonymous';
    el.preload = 'auto';
    el.loop = true;

    el.addEventListener('ended', () => {
      if (!_msSpeakerRuntimes.has(spk.blockId)) return;
      const ed = spk.box?.soundEmitterData;
      if (!ed || ed.mode === 'screen_link') return;
      const q = Array.isArray(ed.queue) ? ed.queue : [];
      const lm = ed.loopMode || (ed.loop !== false ? 'queue' : 'none');
      if (lm === 'one') {
        try { el.currentTime = 0; el.play().catch(() => {}); } catch (_) {}
        return;
      }
      if (q.length > 0) {
        if (ed.shuffle && q.length > 1) {
          let ni = ed.queueIndex || 0;
          while (ni === (ed.queueIndex || 0)) ni = Math.floor(Math.random() * q.length);
          ed.queueIndex = ni;
          ed.playing = true;
          syncSingleSpeaker(spk.box, !spk.box.isDisabled);
          return;
        }
        const ni = (ed.queueIndex || 0) + 1;
        if (ni < q.length) {
          ed.queueIndex = ni;
          ed.playing = true;
          syncSingleSpeaker(spk.box, !spk.box.isDisabled);
        } else if (lm === 'queue') {
          ed.queueIndex = 0;
          ed.playing = true;
          syncSingleSpeaker(spk.box, !spk.box.isDisabled);
        } else {
          ed.playing = false;
        }
      } else if (lm === 'queue') {
        try { el.currentTime = 0; el.play().catch(() => {}); } catch (_) {}
      } else {
        ed.playing = false;
      }
    });
    el.addEventListener('error', () => {
      if (spk.lastRawSrc && !spk._directFallbackTried && !isYouTubeOrStreamPageUrl(spk.lastRawSrc) && spk.resolvedSrc !== spk.lastRawSrc) {
        spk._directFallbackTried = true;
        spk.resolvedSrc = spk.lastRawSrc;
        el.src = spk.resolvedSrc;
        el.load();
        if (spk.wantPlay) el.play().catch(() => {});
      }
    });
    spk.audioEl = el;
  }
  if (!spk.standaloneChain) {
    try {
      spk.audioSourceNode = AC.createMediaElementSource(spk.audioEl);
      spk.analyser = AC.createAnalyser();
      spk.analyser.fftSize = 128;
      spk.analyser.smoothingTimeConstant = 0.72;
      spk.audioSourceNode.connect(spk.analyser);

      spk.standaloneChain = createSpatialChain(AC, mediaGain || masterGain, true);
      spk.audioSourceNode.connect(spk.standaloneChain.gainNode);
    } catch (err) {
      console.warn('Speaker standalone WebAudio error:', err);
      return false;
    }
  }
  return true;
}

function syncSingleSpeaker(box, isActiveInWorld, dt = 0.016) {
  const ed = box.soundEmitterData || (box.soundEmitterData = createDefaultSoundEmitterData());
  const spk = ensureSpeakerRuntime(box);
  const { AC, mediaGain, masterGain } = getAudioBuses();

  const isLinkedMode = ed.mode === 'screen_link';

  // 1. РЕЖИМ ПРИВЯЗКИ К ЭКРАНУ (неограниченное число колонок на 1 экран!)
  if (isLinkedMode) {
    if (spk.audioEl && !spk.audioEl.paused) {
      try { spk.audioEl.pause(); } catch (_) {}
    }
    if (spk.standaloneChain && AC) {
      spk.standaloneChain.gainNode.gain.setTargetAtTime(0, AC.currentTime, 0.04);
    }

    const targetScreenId = ed.linkedScreenId || '';
    const screenRt = targetScreenId ? _msScreenRuntimes.get(targetScreenId) : null;

    if (!screenRt || !isActiveInWorld) {
      detachSpeakerFromScreen(spk);
      return;
    }

    // Если экран поменялся — переподключаем ветку Web Audio
    if (spk.attachedScreenRt !== screenRt) {
      detachSpeakerFromScreen(spk);
    }

    if (AC && (_msUnlockedOnce || S.state === 'play')) {
      ensureScreenAudioGraph(screenRt);
      if (screenRt.screenBusGain && !spk.screenLinkChain) {
        spk.screenLinkChain = createSpatialChain(AC, mediaGain || masterGain, ed.spatial3D !== false);
        screenRt.screenBusGain.connect(spk.screenLinkChain.gainNode);
        spk.attachedScreenRt = screenRt;
        spk.attachedScreenId = targetScreenId;
        screenRt.linkedSpeakers.add(spk);
      }
    }

    if (spk.screenLinkChain && AC) {
      const canHear = isActiveInWorld && screenRt.wantPlay && Boolean(ed.playing) && isMasterSoundOn() && S.state !== 'menu';
      if (canHear) {
        box.m.getWorldPosition(_msTmpPos);
        setPannerWorldPos(spk.screenLinkChain.pannerNode, _msTmpPos, ed.spatial3D !== false);
        const dist = _msTmpPos.distanceTo(_msCamPos);
        const atten = computeDistanceGain(dist, ed.refDistance ?? 4, ed.maxDistance ?? 36, ed.rolloff ?? 1.35);

        let occGain = 1.0;
        let occFreq = 20000;
        if (ed.occlusion !== false) {
          spk.occTimer -= dt;
          if (spk.occTimer <= 0) {
            spk.occTimer = 0.18;
            spk.occWalls = evaluateAudioOcclusion(_msTmpPos, dist, box.id, targetScreenId);
          }
          occGain = spk.occWalls >= 2 ? 0.3 : (spk.occWalls === 1 ? 0.5 : 1.0);
          occFreq = spk.occWalls >= 2 ? 420 : (spk.occWalls === 1 ? 750 : 20000);
        }

        const scrSd = screenRt.box?.mediaScreenData;
        const screenMaster = scrSd?.muted ? 0 : clamp(Number(scrSd?.masterVolume ?? 1.0), 0, 1.5);
        const vol = clamp(Number(ed.volume) ?? 1.0, 0, 2.0) * screenMaster * atten * occGain;
        spk.screenLinkChain.gainNode.gain.setTargetAtTime(vol, AC.currentTime, 0.04);
        spk.screenLinkChain.filterNode?.frequency.setTargetAtTime(occFreq, AC.currentTime, 0.08);
        spk.bassLevel = screenRt.bassLevel || 0;
      } else {
        spk.screenLinkChain.gainNode.gain.setTargetAtTime(0, AC.currentTime, 0.04);
        spk.bassLevel = 0;
      }
    }
    updateSpeakerAudioReactiveVisual(box, spk, spk.bassLevel, Boolean(ed.audioReactive && isActiveInWorld));
    return;
  }

  // 2. САМОСТОЯТЕЛЬНЫЙ РЕЖИМ (свой звук — файл из библиотеки или ссылка / YouTube)
  detachSpeakerFromScreen(spk);

  const rawSrc = resolveSpeakerRawSource(ed);
  if (rawSrc !== spk.lastRawSrc) {
    spk.lastRawSrc = rawSrc;
    if (!rawSrc) {
      stopStandaloneSpeakerAudio(spk);
    } else if (AC) {
      ensureStandaloneAudioGraph(spk);
      spk.resolvedSrc = resolveMediaPlaybackUrl(rawSrc, 'audio');
      if (spk.audioEl) {
        spk.audioEl.src = spk.resolvedSrc;
        spk.audioEl.load();
      }
    }
  }

  const shouldPlay = isActiveInWorld && Boolean(spk.resolvedSrc) && Boolean(ed.playing) && S.state !== 'menu';
  spk.wantPlay = shouldPlay;

  if (spk.audioEl) {
    const hasSpkQueue = Array.isArray(ed.queue) && ed.queue.length > 0;
    const effLm = ed.loopMode || (ed.loop !== false ? 'queue' : 'none');
    spk.audioEl.loop = !hasSpkQueue && effLm !== 'none';
    const rate = clamp(Number(ed.playbackRate) || 1.0, 0.25, 3.0);
    if (Math.abs(spk.audioEl.playbackRate - rate) > 0.02) {
      try { spk.audioEl.playbackRate = rate; } catch (_) {}
    }

    if (shouldPlay) {
      if (spk.audioEl.paused && !spk._playPending) {
        spk._playPending = true;
        spk.audioEl.play()
          .catch(() => {})
          .finally(() => { spk._playPending = false; });
      }
    } else if (!spk.audioEl.paused) {
      try { spk.audioEl.pause(); } catch (_) {}
    }
  }

  if (spk.standaloneChain && AC) {
    if (shouldPlay && isMasterSoundOn()) {
      box.m.getWorldPosition(_msTmpPos);
      setPannerWorldPos(spk.standaloneChain.pannerNode, _msTmpPos, ed.spatial3D !== false);
      const dist = _msTmpPos.distanceTo(_msCamPos);
      const atten = computeDistanceGain(dist, ed.refDistance ?? 4, ed.maxDistance ?? 36, ed.rolloff ?? 1.35);

      let occGain = 1.0;
      let occFreq = 20000;
      if (ed.occlusion !== false) {
        spk.occTimer -= dt;
        if (spk.occTimer <= 0) {
          spk.occTimer = 0.18;
          spk.occWalls = evaluateAudioOcclusion(_msTmpPos, dist, box.id);
        }
        occGain = spk.occWalls >= 2 ? 0.3 : (spk.occWalls === 1 ? 0.5 : 1.0);
        occFreq = spk.occWalls >= 2 ? 420 : (spk.occWalls === 1 ? 750 : 20000);
      }

      const vol = clamp(Number(ed.volume) ?? 1.0, 0, 2.0) * atten * occGain;
      spk.standaloneChain.gainNode.gain.setTargetAtTime(vol, AC.currentTime, 0.04);
      spk.standaloneChain.filterNode?.frequency.setTargetAtTime(occFreq, AC.currentTime, 0.08);
      spk.bassLevel = dist < 45 ? sampleBassFromAnalyser(spk.analyser) : 0;
    } else {
      spk.standaloneChain.gainNode.gain.setTargetAtTime(0, AC.currentTime, 0.04);
      spk.bassLevel = 0;
    }
  }
  updateSpeakerAudioReactiveVisual(box, spk, spk.bassLevel, Boolean(ed.audioReactive && isActiveInWorld));
}

/* ---------- ОБНОВЛЕНИЕ СЛУШАТЕЛЯ И ОБЩИЙ ЦИКЛ ---------- */

function syncWebAudioListenerToCamera() {
  const { AC } = getAudioBuses();
  if (!AC || !AC.listener || !camera) return;

  camera.getWorldPosition(_msCamPos);
  camera.getWorldDirection(_msCamFwd);
  _msCamUp.set(0, 1, 0).applyQuaternion(camera.quaternion).normalize();

  const L = AC.listener;
  if (L.positionX) {
    L.positionX.value = _msCamPos.x;
    L.positionY.value = _msCamPos.y;
    L.positionZ.value = _msCamPos.z;
    L.forwardX.value = _msCamFwd.x;
    L.forwardY.value = _msCamFwd.y;
    L.forwardZ.value = _msCamFwd.z;
    L.upX.value = _msCamUp.x;
    L.upY.value = _msCamUp.y;
    L.upZ.value = _msCamUp.z;
  } else if (typeof L.setPosition === 'function') {
    L.setPosition(_msCamPos.x, _msCamPos.y, _msCamPos.z);
    if (typeof L.setOrientation === 'function') {
      L.setOrientation(_msCamFwd.x, _msCamFwd.y, _msCamFwd.z, _msCamUp.x, _msCamUp.y, _msCamUp.z);
    }
  }
}

export function updateMediaSystem(dt) {
  if (!Array.isArray(S.allBlocks)) return;
  syncWebAudioListenerToCamera();

  // Обновляем frustum камеры и список твёрдых стен для Audio Occlusion один раз на кадр
  if (camera) {
    camera.updateMatrixWorld();
    _msProjScreenMat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    _msFrustum.setFromProjectionMatrix(_msProjScreenMat);
  }
  _msSolidOccluders.length = 0;
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || !b.m || !b.m.visible || b.isDisabled || b._depletedDisabled) continue;
    if (b.matterState === 'solid' && b.components?.physics?.enabled !== false) {
      _msSolidOccluders.push(b.m);
    }
  }

  const activeScreenIds = new Set();
  const activeSpeakerIds = new Set();

  // Проход 1: экраны (обновляются раньше колонок, чтобы колонки сразу видели их шину screenBusGain)
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || !b.m || !b.components?.mediaScreen?.enabled) continue;
    activeScreenIds.add(b.id);
    const isOff = Boolean(b.isDisabled || (S.state === 'play' && b._depletedDisabled));
    syncSingleScreen(b, !isOff && S.state !== 'menu', dt);
  }

  // Проход 2: 3D-колонки (как привязанные к экранам, так и самостоятельные)
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || !b.m || !b.components?.soundEmitter?.enabled) continue;
    activeSpeakerIds.add(b.id);
    const isOff = Boolean(b.isDisabled || (S.state === 'play' && b._depletedDisabled));
    syncSingleSpeaker(b, !isOff && S.state !== 'menu', dt);
  }

  // Очистка осиротевших рантаймов (если компонент отключили или блок удалили)
  for (const [id] of _msSpeakerRuntimes.entries()) {
    if (!activeSpeakerIds.has(id)) disposeSpeakerById(id);
  }
  for (const [id] of _msScreenRuntimes.entries()) {
    if (!activeScreenIds.has(id)) disposeScreenById(id);
  }
  updateMediaScreenUI(dt);
}

/* ---------- УПРАВЛЕНИЕ ВОСПРОИЗВЕДЕНИЕМ И ОЧИСТКА ПАМЯТИ ---------- */

export function toggleBlockMediaPlayback(box, broadcastNet = true) {
  if (!box) return false;
  initAudio();
  _msUnlockedOnce = true;

  if (box.components?.mediaScreen?.enabled && box.mediaScreenData) {
    box.mediaScreenData.playing = !box.mediaScreenData.playing;
    syncSingleScreen(box, !box.isDisabled);
    sfx.click?.();
    showBanner(
      box.mediaScreenData.playing ? `▶️ Экран «${box.label}»: воспроизведение` : `⏸️ Экран «${box.label}»: пауза`,
      '#56f0ff'
    );
    if (broadcastNet && window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
      window.__debixSyncBlockUpsert(box, false);
    }
    return true;
  }

  if (box.components?.soundEmitter?.enabled && box.soundEmitterData) {
    box.soundEmitterData.playing = !box.soundEmitterData.playing;
    syncSingleSpeaker(box, !box.isDisabled);
    sfx.click?.();
    showBanner(
      box.soundEmitterData.playing ? `🔊 Колонка «${box.label}»: вкл` : `🔇 Колонка «${box.label}»: пауза`,
      '#56f0ff'
    );
    if (broadcastNet && window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
      window.__debixSyncBlockUpsert(box, false);
    }
    return true;
  }
  return false;
}

export function reloadBlockMedia(box) {
  if (!box) return;
  initAudio();
  _msUnlockedOnce = true;
  const scr = _msScreenRuntimes.get(box.id);
  if (scr) {
    scr.lastRawSrc = null;
    syncSingleScreen(box, !box.isDisabled);
  }
  const spk = _msSpeakerRuntimes.get(box.id);
  if (spk) {
    spk.lastRawSrc = null;
    syncSingleSpeaker(box, !box.isDisabled);
  }
}

export function syncBlockMediaVisuals(box) {
  if (!box) return;
  if (box.components?.mediaScreen?.enabled) {
    syncSingleScreen(box, !box.isDisabled && S.state !== 'menu');
  } else if (_msScreenRuntimes.has(box.id)) {
    disposeScreenById(box.id);
  }
  if (box.components?.soundEmitter?.enabled) {
    syncSingleSpeaker(box, !box.isDisabled && S.state !== 'menu');
  } else if (_msSpeakerRuntimes.has(box.id)) {
    disposeSpeakerById(box.id);
  }
}

export function getLinkedSpeakersForScreen(screenBlockId) {
  if (!screenBlockId) return [];
  const res = [];
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (
      b &&
      b.components?.soundEmitter?.enabled &&
      b.soundEmitterData?.mode === 'screen_link' &&
      b.soundEmitterData.linkedScreenId === screenBlockId
    ) {
      res.push(b);
    }
  }
  return res;
}

export function getLinkedSpeakersCountForScreen(screenBlockId) {
  return getLinkedSpeakersForScreen(screenBlockId).length;
}

function disposeSpeakerById(blockId) {
  const spk = _msSpeakerRuntimes.get(blockId);
  if (!spk) return;
  detachSpeakerFromScreen(spk);
  stopStandaloneSpeakerAudio(spk);
  try { spk.audioSourceNode?.disconnect(); } catch (_) {}
  try { spk.analyser?.disconnect(); } catch (_) {}
  try { spk.standaloneChain?.gainNode?.disconnect(); } catch (_) {}
  try { spk.standaloneChain?.filterNode?.disconnect(); } catch (_) {}
  try { spk.standaloneChain?.pannerNode?.disconnect(); } catch (_) {}
  if (spk.reactRing) {
    if (spk.reactRing.parent) spk.reactRing.parent.remove(spk.reactRing);
    spk.reactRing.material?.dispose?.();
    spk.reactRing = null;
  }
  _msSpeakerRuntimes.delete(blockId);
}

function disposeScreenById(blockId) {
  const rt = _msScreenRuntimes.get(blockId);
  if (!rt) return;
  disposeScreenUI(rt);
  for (const spk of Array.from(rt.linkedSpeakers)) {
    detachSpeakerFromScreen(spk);
  }
  if (rt.shareStream) {
    try { rt.shareStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    rt.shareStream = null;
  }
  try { rt.videoEl.pause(); rt.videoEl.srcObject = null; rt.videoEl.removeAttribute('src'); rt.videoEl.load(); } catch (_) {}
  try { rt.sourceNode?.disconnect(); } catch (_) {}
  try { rt.analyser?.disconnect(); } catch (_) {}
  try { rt.screenBusGain?.disconnect(); } catch (_) {}
  try { rt.builtInChain?.gainNode?.disconnect(); } catch (_) {}
  try { rt.builtInChain?.filterNode?.disconnect(); } catch (_) {}
  try { rt.builtInChain?.pannerNode?.disconnect(); } catch (_) {}
  if (rt.screenGroup && rt.screenGroup.parent) {
    rt.screenGroup.parent.remove(rt.screenGroup);
  }
  if (rt.box) rt.box._screenGroup = null;
  rt.videoTex?.dispose?.();
  rt.placeholderTex?.dispose?.();
  rt.videoMat?.dispose?.();
  rt.backMat?.dispose?.();
  _msScreenRuntimes.delete(blockId);
}

export function disposeBlockMedia(box) {
  if (!box || !box.id) return;
  disposeSpeakerById(box.id);
  disposeScreenById(box.id);
}

export function clearAllMediaRuntime() {
  for (const id of Array.from(_msSpeakerRuntimes.keys())) disposeSpeakerById(id);
  for (const id of Array.from(_msScreenRuntimes.keys())) disposeScreenById(id);
}

export function resetAllMediaRuntime() {
  for (const b of S.allBlocks) {
    if (!b) continue;
    if (b.components?.mediaScreen?.enabled && b.mediaScreenData) {
      b.mediaScreenData.playing = b.mediaScreenData.autoplay !== false;
    }
    if (b.components?.soundEmitter?.enabled && b.soundEmitterData) {
      b.soundEmitterData.playing = b.soundEmitterData.autoplay !== false;
    }
  }
}

/* ---------- API ОЧЕРЕДЕЙ, ПЛЕЙЛИСТОВ И УПРАВЛЕНИЯ ПЛЕЕРОМ ---------- */

export function getActiveScreenRuntimes() {
  return _msScreenRuntimes;
}

export function getCurrentScreenTrackInfo(box) {
  const sd = box?.mediaScreenData;
  if (!sd) return { title: 'Видео-Экран', index: 0, total: 0 };
  const q = Array.isArray(sd.queue) ? sd.queue : [];
  if (q.length > 0) {
    const idx = clamp(sd.queueIndex || 0, 0, q.length - 1);
    const it = q[idx];
    return {
      title: it?.title || it?.url || `Видео #${idx + 1}`,
      index: idx,
      total: q.length
    };
  }
  if (sd.sourceType === 'library' && sd.videoId) {
    const v = (S.customVideoLibrary || []).find(x => x && x.id === sd.videoId);
    return { title: v?.name || 'Видео из библиотеки', index: 0, total: 0 };
  }
  return {
    title: sd.url ? sd.url.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 48) : (box.label || 'Видео-Экран'),
    index: 0,
    total: 0
  };
}

export async function fetchMediaPlaylistInfo(rawUrl) {
  const cleanUrl = String(rawUrl || '').trim();
  if (!cleanUrl) throw new Error('Пустая ссылка');
  const base = getMediaProxyBaseUrl();
  const resp = await fetch(`${base}/api/media/playlist?url=${encodeURIComponent(cleanUrl)}`);
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.ok) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }
  return data;
}

export async function addUrlOrPlaylistToScreenQueue(box, rawUrl, opts = {}) {
  if (!box) return 0;
  const sd = box.mediaScreenData || (box.mediaScreenData = createDefaultMediaScreenData());
  if (!Array.isArray(sd.queue)) sd.queue = [];

  const wasEmpty = sd.queue.length === 0;
  const info = await fetchMediaPlaylistInfo(rawUrl);
  const incoming = Array.isArray(info.items) ? info.items : [];
  if (incoming.length === 0) return 0;

  if (opts.replaceQueue) {
    sd.queue = [];
    sd.queueIndex = 0;
  }

  // Если до этого стояла одиночная ссылка и пользователь просто добавляет в очередь (без replace), сохраняем её первым элементом
  if (!opts.replaceQueue && wasEmpty && !opts.playNow) {
    const legacySrc = sd.sourceType === 'library' ? sd.videoId : (sd.url || '').trim();
    if (legacySrc) {
      const prevInfo = getCurrentScreenTrackInfo(box);
      sd.queue.push({
        id: 'qi_' + Date.now() + '_0',
        title: prevInfo.title,
        sourceType: sd.sourceType === 'library' ? 'library' : 'url',
        url: sd.sourceType === 'library' ? '' : legacySrc,
        videoId: sd.sourceType === 'library' ? legacySrc : '',
        duration: 0
      });
    }
  }

  const startOffset = sd.queue.length;
  let startKeyIdx = -1;

  for (let i = 0; i < incoming.length; i++) {
    const item = incoming[i];
    if (info.startVideoId && item.videoKey === info.startVideoId && startKeyIdx === -1) {
      startKeyIdx = startOffset + i;
    }
    sd.queue.push({
      id: 'qi_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 999),
      title: item.title || item.url || `Видео #${i + 1}`,
      sourceType: 'url',
      url: item.url,
      videoId: '',
      duration: Number(item.duration) || 0
    });
  }

  if (opts.replaceQueue || opts.playNow || wasEmpty) {
    sd.queueIndex = startKeyIdx >= 0 ? startKeyIdx : startOffset;
    sd.playing = true;
  }

  syncSingleScreen(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.cash?.();
  showBanner(
    info.isPlaylist
      ? `📋 Плейлист «${info.title}» (${incoming.length} видео) добавлен в очередь!`
      : `🎬 «${incoming[0].title}» добавлено в очередь!`,
    '#00e676'
  );
  return incoming.length;
}

export function addLibraryVideoToScreenQueue(box, videoId, playNow = false) {
  if (!box || !videoId) return false;
  const entry = (S.customVideoLibrary || []).find(v => v && v.id === videoId);
  if (!entry) return false;
  const sd = box.mediaScreenData || (box.mediaScreenData = createDefaultMediaScreenData());
  if (!Array.isArray(sd.queue)) sd.queue = [];
  const wasEmpty = sd.queue.length === 0;
  sd.queue.push({
    id: 'qi_' + Date.now() + '_' + Math.floor(Math.random() * 999),
    title: entry.name || 'Видео',
    sourceType: 'library',
    url: '',
    videoId: entry.id,
    duration: 0
  });
  if (playNow || wasEmpty) {
    sd.queueIndex = sd.queue.length - 1;
    sd.playing = true;
  }
  syncSingleScreen(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.click?.();
  return true;
}

export function playScreenQueueIndex(box, idx) {
  const sd = box?.mediaScreenData;
  if (!sd || !Array.isArray(sd.queue) || sd.queue.length === 0) return;
  sd.queueIndex = clamp(Number(idx) || 0, 0, sd.queue.length - 1);
  sd.playing = true;
  const rt = _msScreenRuntimes.get(box.id);
  if (rt) rt.lastRawSrc = null;
  syncSingleScreen(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.click?.();
}

export function nextScreenTrack(box) {
  const sd = box?.mediaScreenData;
  if (!sd || !Array.isArray(sd.queue) || sd.queue.length === 0) return;
  if (sd.shuffle && sd.queue.length > 1) {
    let nextIdx = sd.queueIndex || 0;
    while (nextIdx === (sd.queueIndex || 0)) {
      nextIdx = Math.floor(Math.random() * sd.queue.length);
    }
    playScreenQueueIndex(box, nextIdx);
    return;
  }
  const nextIdx = ((sd.queueIndex || 0) + 1) % sd.queue.length;
  playScreenQueueIndex(box, nextIdx);
}

export function prevScreenTrack(box) {
  const sd = box?.mediaScreenData;
  const rt = _msScreenRuntimes.get(box?.id);
  if (rt?.videoEl && rt.videoEl.currentTime > 3.5) {
    seekScreenTime(box, 0);
    return;
  }
  if (!sd || !Array.isArray(sd.queue) || sd.queue.length === 0) {
    seekScreenTime(box, 0);
    return;
  }
  const prevIdx = ((sd.queueIndex || 0) - 1 + sd.queue.length) % sd.queue.length;
  playScreenQueueIndex(box, prevIdx);
}

export function removeScreenQueueItem(box, idx) {
  const sd = box?.mediaScreenData;
  if (!sd || !Array.isArray(sd.queue) || idx < 0 || idx >= sd.queue.length) return;
  const wasCurrent = idx === (sd.queueIndex || 0);
  sd.queue.splice(idx, 1);
  if (sd.queue.length === 0) {
    sd.queueIndex = 0;
  } else if (idx < (sd.queueIndex || 0)) {
    sd.queueIndex = Math.max(0, (sd.queueIndex || 0) - 1);
  } else if ((sd.queueIndex || 0) >= sd.queue.length) {
    sd.queueIndex = sd.queue.length - 1;
  }
  if (wasCurrent) {
    const rt = _msScreenRuntimes.get(box.id);
    if (rt) rt.lastRawSrc = null;
  }
  syncSingleScreen(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.oof?.();
}

export function clearScreenQueue(box) {
  const sd = box?.mediaScreenData;
  if (!sd) return;
  sd.queue = [];
  sd.queueIndex = 0;
  const rt = _msScreenRuntimes.get(box.id);
  if (rt) rt.lastRawSrc = null;
  syncSingleScreen(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.oof?.();
}

export function seekScreenTime(box, targetSec) {
  const rt = _msScreenRuntimes.get(box?.id);
  if (!rt?.videoEl || !Number.isFinite(rt.videoEl.duration) || rt.videoEl.duration <= 0) return;
  try {
    rt.videoEl.currentTime = clamp(Number(targetSec) || 0, 0, Math.max(0, rt.videoEl.duration - 0.1));
  } catch (_) {}
}

export function setScreenMasterVolume(box, vol) {
  const sd = box?.mediaScreenData;
  if (!sd) return;
  sd.masterVolume = clamp(Number(vol) || 0, 0, 1.5);
  sd.muted = sd.masterVolume <= 0.001;
}

export function toggleScreenMute(box) {
  const sd = box?.mediaScreenData;
  if (!sd) return;
  sd.muted = !sd.muted;
  if (!sd.muted && (sd.masterVolume ?? 1) <= 0.01) sd.masterVolume = 1.0;
  sfx.click?.();
}

export function cycleScreenLoopMode(box) {
  const sd = box?.mediaScreenData;
  if (!sd) return;
  const order = ['queue', 'one', 'none'];
  const cur = sd.loopMode || (sd.loop !== false ? 'queue' : 'none');
  sd.loopMode = order[(order.indexOf(cur) + 1) % order.length];
  sd.loop = sd.loopMode !== 'none';
  sfx.click?.();
}

export function toggleScreenShuffle(box) {
  const sd = box?.mediaScreenData;
  if (!sd) return;
  sd.shuffle = !sd.shuffle;
  sfx.click?.();
}

export function cycleScreenPlaybackRate(box, steps = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]) {
  const sd = box?.mediaScreenData;
  if (!sd) return;
  const cur = Number(sd.playbackRate) || 1.0;
  const idx = steps.findIndex(v => Math.abs(v - cur) < 0.05);
  sd.playbackRate = steps[(idx + 1) % steps.length];
  sfx.click?.();
}

/* ---------- ПОИСК YOUTUBE, AMBILIGHT, БАСЫ, СТРИМ ЭКРАНА ПК И ОЧЕРЕДИ КОЛОНОК ---------- */

export async function searchYouTubeVideos(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return [];
  const base = getMediaProxyBaseUrl();
  const resp = await fetch(`${base}/api/media/search?limit=${limit}&q=${encodeURIComponent(q)}`);
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.ok) {
    throw new Error(data?.error || `HTTP ${resp.status}`);
  }
  return Array.isArray(data.items) ? data.items : [];
}

export function collectMediaAmbilightCandidates(pushRealLightCandidate) {
  if (typeof pushRealLightCandidate !== 'function') return;
  for (const rt of _msScreenRuntimes.values()) {
    const box = rt.box;
    const sd = box?.mediaScreenData;
    if (!box || !box.m || !box.m.visible || !sd || sd.ambilight === false) continue;
    if (!rt.wantPlay || rt.ambiLum < 0.03 || !rt.inFrustum || rt.distToCam > 55) continue;

    // Ставим источник света чуть перед лицевой стороной экрана, чтобы он мягко освещал комнату
    const faceSign = sd.face === 'back' ? -1 : 1;
    const fwdOff = (box.d || 0.4) * 0.5 + 1.1;
    _msLightPos.set(0, 0, faceSign * fwdOff).applyQuaternion(box.m.quaternion).add(box.m.position);

    const baseInt = clamp(Number(sd.ambilightIntensity) || 1.8, 0.2, 5.0);
    const intensity = baseInt * clamp(rt.ambiLum * 1.65, 0.25, 1.35);
    const dist = clamp(Number(sd.ambilightDistance) || 22, 4, 65);
    pushRealLightCandidate(_msLightPos, '#' + rt.ambiColor.getHexString(), intensity, dist, 1.0);
  }
}

export function getBlockAudioLevel(blockId) {
  const scr = _msScreenRuntimes.get(blockId);
  if (scr) return scr.bassLevel || 0;
  const spk = _msSpeakerRuntimes.get(blockId);
  if (spk) {
    if (spk.attachedScreenRt) return spk.attachedScreenRt.bassLevel || 0;
    return spk.bassLevel || 0;
  }
  return 0;
}

export function canLocalPlayerControlScreen(box) {
  if (!box || !box.mediaScreenData) return true;
  if (S.state === 'edit') return true;
  if (!box.mediaScreenData.hostOnly) return true;
  if (S.mpState?.isHost) return true;
  if (Object.keys(S.remotePlayers || {}).length === 0) return true;
  return false;
}

export function tryPayScreenQueueCost(box) {
  if (!box || S.state !== 'play' || !S.player) return true;
  const sdCost = Math.max(0, Number(box.mediaScreenData?.queueCost) || 0);
  const compCost = (box.components?.cost?.enabled && box.costData) ? Math.max(0, Number(box.costData.amount) || 0) : 0;
  const price = sdCost > 0 ? sdCost : compCost;
  if (price <= 0) return true;

  if ((S.player.cash || 0) < price) {
    sfx.oof?.();
    showBanner(`💰 Нужно ${price} R$, чтобы добавить видео в очередь!`, '#ffce3a');
    return false;
  }
  S.player.cash -= price;
  sfx.cash?.();
  if (window.__debixUpdateShopUI) window.__debixUpdateShopUI();
  showBanner(`🎵 Оплачено ${price} R$ за заказ видео!`, '#00e676');
  return true;
}

export async function startScreenShareForBlock(box) {
  if (!box || !box.components?.mediaScreen?.enabled) return false;
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    showBanner('⚠️ Браузер не поддерживает трансляцию экрана (нужен localhost или HTTPS).', '#ffce3a');
    return false;
  }
  initAudio();
  _msUnlockedOnce = true;
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always' },
      audio: true
    });
    const rt = ensureScreenRuntime(box);
    stopScreenShareForBlock(box, false);

    rt.isScreenShare = true;
    rt.isRemoteShare = false;
    rt.shareStream = stream;
    rt.videoEl.srcObject = stream;
    rt.videoEl.muted = false;
    rt.hasVideoFrame = true;
    box.mediaScreenData.playing = true;
    ensureScreenAudioGraph(rt);
    rt.videoEl.play().catch(() => {});

    const vTrack = stream.getVideoTracks()[0];
    if (vTrack) {
      vTrack.onended = () => stopScreenShareForBlock(box, true);
    }

    if (window.__debixBroadcastScreenShare) {
      window.__debixBroadcastScreenShare(box.id, stream);
    }
    sfx.coil?.();
    showBanner(`🖥️ Трансляция экрана ПК запущена на «${box.label}»!`, '#00e676');
    return true;
  } catch (err) {
    if (err && err.name !== 'NotAllowedError') {
      showBanner('❌ Не удалось запустить трансляцию: ' + err.message, '#ff4757');
    }
    return false;
  }
}

export function stopScreenShareForBlock(box, notifyNet = true) {
  if (!box) return;
  const rt = _msScreenRuntimes.get(box.id);
  if (!rt || (!rt.isScreenShare && !rt.isRemoteShare)) return;
  const wasLocal = rt.isScreenShare;
  if (rt.shareStream) {
    try { rt.shareStream.getTracks().forEach(t => t.stop()); } catch (_) {}
    rt.shareStream = null;
  }
  rt.isScreenShare = false;
  rt.isRemoteShare = false;
  rt.videoEl.srcObject = null;
  rt.lastRawSrc = null;
  syncSingleScreen(box, !box.isDisabled);
  if (notifyNet && wasLocal && window.__debixStopScreenShare) {
    window.__debixStopScreenShare(box.id);
  }
}

export function attachRemoteMediaStreamToScreen(blockId, mediaStream) {
  const box = S.allBlocks.find(b => b && b.id === blockId && b.components?.mediaScreen?.enabled);
  if (!box) return false;
  const rt = ensureScreenRuntime(box);
  rt.isRemoteShare = true;
  rt.isScreenShare = false;
  rt.shareStream = mediaStream;
  rt.videoEl.srcObject = mediaStream;
  rt.hasVideoFrame = true;
  box.mediaScreenData.playing = true;
  ensureScreenAudioGraph(rt);
  rt.videoEl.play().catch(() => {});
  showBanner(`🖥️ Подключена трансляция экрана на «${box.label}»!`, '#56f0ff');
  return true;
}

export function getScreenSyncState(box) {
  const rt = _msScreenRuntimes.get(box?.id);
  const sd = box?.mediaScreenData;
  if (!rt || !sd || rt.isScreenShare || rt.isRemoteShare) return null;
  return {
    blockId: box.id,
    playing: Boolean(sd.playing),
    time: Number((rt.videoEl?.currentTime || 0).toFixed(2)),
    rate: Number(sd.playbackRate) || 1.0,
    queueIndex: sd.queueIndex || 0,
    queueLen: Array.isArray(sd.queue) ? sd.queue.length : 0,
    url: sd.url || ''
  };
}

export function applyScreenSyncState(box, st) {
  if (!box || !st || !box.mediaScreenData) return;
  const sd = box.mediaScreenData;
  const rt = _msScreenRuntimes.get(box.id);
  if (!rt || rt.isScreenShare || rt.isRemoteShare) return;

  if (typeof st.queueIndex === 'number' && st.queueIndex !== sd.queueIndex) {
    sd.queueIndex = st.queueIndex;
    rt.lastRawSrc = null;
  }
  if (typeof st.playing === 'boolean') sd.playing = st.playing;
  if (typeof st.rate === 'number') sd.playbackRate = clamp(st.rate, 0.25, 3.0);

  if (rt.videoEl && Number.isFinite(st.time) && rt.videoEl.readyState >= 1) {
    const diff = Math.abs((rt.videoEl.currentTime || 0) - st.time);
    if (diff > 1.2) {
      try { rt.videoEl.currentTime = st.time; } catch (_) {}
    }
  }
  syncSingleScreen(box, !box.isDisabled);
}

/* ---------- ОЧЕРЕДИ И ПЛЕЙЛИСТЫ ДЛЯ САМОСТОЯТЕЛЬНЫХ 3D-КОЛОНОК (БУМБОКС / РАДИО) ---------- */

export async function addUrlOrPlaylistToSpeakerQueue(box, rawUrl, opts = {}) {
  if (!box) return 0;
  const ed = box.soundEmitterData || (box.soundEmitterData = createDefaultSoundEmitterData());
  if (!Array.isArray(ed.queue)) ed.queue = [];

  const wasEmpty = ed.queue.length === 0;
  const info = await fetchMediaPlaylistInfo(rawUrl);
  const incoming = Array.isArray(info.items) ? info.items : [];
  if (incoming.length === 0) return 0;

  if (opts.replaceQueue) {
    ed.queue = [];
    ed.queueIndex = 0;
  }

  const startOffset = ed.queue.length;
  for (let i = 0; i < incoming.length; i++) {
    const it = incoming[i];
    ed.queue.push({
      id: 'sq_' + Date.now() + '_' + i + '_' + Math.floor(Math.random() * 999),
      title: it.title || it.url || `Трек #${i + 1}`,
      sourceType: 'url',
      url: it.url,
      audioId: '',
      duration: Number(it.duration) || 0
    });
  }

  if (opts.replaceQueue || opts.playNow || wasEmpty) {
    ed.queueIndex = startOffset;
    ed.playing = true;
  }

  syncSingleSpeaker(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.cash?.();
  showBanner(
    info.isPlaylist
      ? `📻 В колонку добавлен плейлист «${info.title}» (${incoming.length} треков)!`
      : `📻 Трек «${incoming[0].title}» добавлен в колонку!`,
    '#00e676'
  );
  return incoming.length;
}

export function playSpeakerQueueIndex(box, idx) {
  const ed = box?.soundEmitterData;
  if (!ed || !Array.isArray(ed.queue) || ed.queue.length === 0) return;
  ed.queueIndex = clamp(Number(idx) || 0, 0, ed.queue.length - 1);
  ed.playing = true;
  const spk = _msSpeakerRuntimes.get(box.id);
  if (spk) spk.lastRawSrc = null;
  syncSingleSpeaker(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.click?.();
}

export function nextSpeakerTrack(box) {
  const ed = box?.soundEmitterData;
  if (!ed || !Array.isArray(ed.queue) || ed.queue.length === 0) return;
  if (ed.shuffle && ed.queue.length > 1) {
    let ni = ed.queueIndex || 0;
    while (ni === (ed.queueIndex || 0)) ni = Math.floor(Math.random() * ed.queue.length);
    playSpeakerQueueIndex(box, ni);
    return;
  }
  playSpeakerQueueIndex(box, ((ed.queueIndex || 0) + 1) % ed.queue.length);
}

export function prevSpeakerTrack(box) {
  const ed = box?.soundEmitterData;
  if (!ed || !Array.isArray(ed.queue) || ed.queue.length === 0) return;
  playSpeakerQueueIndex(box, ((ed.queueIndex || 0) - 1 + ed.queue.length) % ed.queue.length);
}

export function removeSpeakerQueueItem(box, idx) {
  const ed = box?.soundEmitterData;
  if (!ed || !Array.isArray(ed.queue) || idx < 0 || idx >= ed.queue.length) return;
  const wasCur = idx === (ed.queueIndex || 0);
  ed.queue.splice(idx, 1);
  if (ed.queue.length === 0) ed.queueIndex = 0;
  else if (idx < (ed.queueIndex || 0)) ed.queueIndex = Math.max(0, (ed.queueIndex || 0) - 1);
  else if ((ed.queueIndex || 0) >= ed.queue.length) ed.queueIndex = ed.queue.length - 1;
  if (wasCur) {
    const spk = _msSpeakerRuntimes.get(box.id);
    if (spk) spk.lastRawSrc = null;
  }
  syncSingleSpeaker(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.oof?.();
}

export function clearSpeakerQueue(box) {
  const ed = box?.soundEmitterData;
  if (!ed) return;
  ed.queue = [];
  ed.queueIndex = 0;
  const spk = _msSpeakerRuntimes.get(box.id);
  if (spk) spk.lastRawSrc = null;
  syncSingleSpeaker(box, !box.isDisabled);
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(box, false);
  }
  sfx.oof?.();
}