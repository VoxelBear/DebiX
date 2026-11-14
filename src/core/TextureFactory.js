// src/core/TextureFactory.js
import { S, TAU } from './State.js';

export function drawStudPatternOnCtx(g, bgHex, lineHex, style = 'square') {
  const w = g.canvas ? g.canvas.width : 128;
  const h = g.canvas ? g.canvas.height : 128;
  g.save();
  g.scale(w / 128, h / 128);
  g.clearRect(0, 0, 128, 128);
  g.fillStyle = bgHex;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = lineHex;
  g.lineWidth = 3;
  g.strokeRect(2, 2, 124, 124);
  for (const [x, y] of [[32, 32], [96, 32], [32, 96], [96, 96]]) {
    if (style === 'round') {
      g.beginPath();
      g.arc(x, y, 16, 0, TAU);
      g.fillStyle = 'rgba(255,255,255,.16)';
      g.fill();
      g.strokeStyle = 'rgba(0,0,0,.22)';
      g.lineWidth = 2.5;
      g.stroke();
    } else if (style === 'square') {
      g.fillStyle = 'rgba(255,255,255,.18)';
      g.fillRect(x - 15, y - 15, 30, 30);
      g.strokeStyle = 'rgba(0,0,0,.25)';
      g.lineWidth = 2.5;
      g.strokeRect(x - 15, y - 15, 30, 30);
    } else if (style === 'neonGrid') {
      g.strokeStyle = '#00f2fe';
      g.lineWidth = 2;
      g.strokeRect(x - 18, y - 18, 36, 36);
      g.beginPath();
      g.arc(x, y, 6, 0, TAU);
      g.fillStyle = '#00f2fe';
      g.fill();
    }
  }
  g.restore();
}

export function makeStudTex(bgHex, lineHex, style = 'square') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  drawStudPatternOnCtx(g, bgHex, lineHex, style);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.userData = { dataURL: c.toDataURL() };
  return t;
}

// Синхронизирует тайлинг текстуры на всех 6 сторонах куба (верх/низ: W×D, лево/право: D×H, перед/зад: W×H)
export function syncBoxMaterialTiling(mesh, w = 4, h = 4, d = 4) {
  if (!mesh || !mesh.material) return;
  const rx = Math.max(0.5, (Number(w) || 1) / 2);
  const ry = Math.max(0.5, (Number(h) || 1) / 2);
  const rz = Math.max(0.5, (Number(d) || 1) / 2);

  if (Array.isArray(mesh.material) && mesh.material.length === 6) {
    // 0: +X (d, h), 1: -X (d, h), 2: +Y (w, d), 3: -Y (w, d), 4: +Z (w, h), 5: -Z (w, h)
    const pairs = [[rz, ry], [rz, ry], [rx, rz], [rx, rz], [rx, ry], [rx, ry]];
    for (let i = 0; i < 6; i++) {
      const m = mesh.material[i];
      if (m && m.map) {
        m.map.repeat.set(pairs[i][0], pairs[i][1]);
      }
    }
    return;
  }

  // Если на кубе одиночный материал с текстурой и это форма куба — создаём 3 пары материалов (X, Y, Z) для ровного тайлинга боков
  const singleMat = mesh.material;
  if (singleMat && singleMat.map && mesh.geometry && mesh.geometry.type === 'BoxGeometry') {
    const mX = singleMat.clone();
    mX.map = singleMat.map.clone();
    mX.map.needsUpdate = true;
    mX.map.repeat.set(rz, ry);

    const mY = singleMat;
    mY.map.repeat.set(rx, rz);

    const mZ = singleMat.clone();
    mZ.map = singleMat.map.clone();
    mZ.map.needsUpdate = true;
    mZ.map.repeat.set(rx, ry);

    const multi = [mX, mX, mY, mY, mZ, mZ];
    // Проксируем свойства цвета/прозрачности/эмиссива на массив, чтобы старый код box.m.material.color.set(...) работал прозрачно!
    multi.color = {
      set: v => multi.forEach(m => m.color.set(v)),
      setHex: v => multi.forEach(m => m.color.setHex(v))
    };
    multi.emissive = {
      set: v => multi.forEach(m => m.emissive && m.emissive.set(v)),
      setHex: v => multi.forEach(m => m.emissive && m.emissive.setHex(v))
    };
    Object.defineProperty(multi, 'opacity', {
      get: () => mY.opacity,
      set: v => multi.forEach(m => { m.opacity = v; })
    });
    Object.defineProperty(multi, 'transparent', {
      get: () => mY.transparent,
      set: v => multi.forEach(m => { m.transparent = v; })
    });
    Object.defineProperty(multi, 'emissiveIntensity', {
      get: () => mY.emissiveIntensity,
      set: v => multi.forEach(m => { m.emissiveIntensity = v; })
    });
    Object.defineProperty(multi, 'map', {
      get: () => mY.map
    });
    multi.userData = singleMat.userData || {};
    mesh.material = multi;
  } else if (singleMat && singleMat.map) {
    singleMat.map.repeat.set(rx, rz);
  }
}

export function makeTexFromDataURL(dataURL, repeat = true, pixelArt = false) {
  const defaultSize = pixelArt ? 16 : 128;
  const c = document.createElement('canvas');
  c.width = c.height = defaultSize;
  const g = c.getContext('2d');
  const t = new THREE.CanvasTexture(c);
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
  }
  if (pixelArt) {
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
  }
  t.userData = { dataURL };
  const img = new Image();
  img.onload = () => {
    const w = img.width || defaultSize;
    const h = img.height || defaultSize;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = !pixelArt;
    g.drawImage(img, 0, 0, w, h);
    t.needsUpdate = true;
  };
  img.src = dataURL;
  return t;
}

export const studWhite = makeStudTex('#f2f6ff', 'rgba(160,185,220,.4)');
export const studGold = makeStudTex('#ffd24c', 'rgba(180,120,0,.45)');

export function createBlockMaterial(
  colorHex,
  repX = 2,
  repZ = 2,
  gold = false,
  customTexDataURL = null,
  matterState = 'solid'
) {
  const baseTex = gold ? studGold : studWhite;
  let t;
  if (!gold && S.customDefaultStudDataURL) {
    t = makeTexFromDataURL(S.customDefaultStudDataURL, true);
  } else {
    t = baseTex.clone();
    t.needsUpdate = true;
  }
  t.repeat.set(Math.max(0.5, repX), Math.max(0.5, repZ));
  const isLiquid = matterState === 'liquid';
  const isGas = matterState === 'gas';
  const mat = new THREE.MeshStandardMaterial({
    map: t,
    color: colorHex,
    emissive: 0x000000,
    emissiveIntensity: 0,
    roughness: isLiquid ? 0.15 : isGas ? 0.9 : 0.45,
    metalness: gold ? 0.45 : isLiquid ? 0.2 : 0.08,
    transparent: isLiquid || isGas,
    opacity: isLiquid ? 0.72 : isGas ? 0.48 : 1.0
  });
  mat.userData = { gold, customTexDataURL };
  return mat;
}

/* ---------- Прозрачные шаблоны лиц (100% Alpha фон — видна голова под лицом) ---------- */
export function drawFacePresetOnCtx(g, _unusedBgHex = null, preset = 'classic') {
  const w = g.canvas.width;
  const h = g.canvas.height;
  g.clearRect(0, 0, w, h);
  g.save();
  g.scale(w / 128, h / 128);

  g.fillStyle = '#111111';
  g.strokeStyle = '#111111';
  g.lineCap = 'round';

  if (preset === 'classic') {
    g.beginPath();
    g.arc(44, 50, 8, 0, TAU);
    g.arc(84, 50, 8, 0, TAU);
    g.fill();
    g.lineWidth = 6;
    g.beginPath();
    g.arc(64, 62, 24, 0.18 * Math.PI, 0.82 * Math.PI);
    g.stroke();
  } else if (preset === 'cool') {
    g.fillStyle = '#111111';
    g.fillRect(22, 38, 38, 20);
    g.fillRect(68, 38, 38, 20);
    g.fillRect(58, 42, 12, 6);
    g.fillStyle = '#56f0ff';
    g.fillRect(26, 42, 12, 6);
    g.fillRect(72, 42, 12, 6);
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(46, 84);
    g.quadraticCurveTo(64, 96, 86, 78);
    g.stroke();
  } else if (preset === 'angry') {
    g.beginPath();
    g.arc(44, 54, 8, 0, TAU);
    g.arc(84, 54, 8, 0, TAU);
    g.fill();
    g.lineWidth = 6;
    g.beginPath();
    g.moveTo(28, 36);
    g.lineTo(54, 46);
    g.moveTo(100, 36);
    g.lineTo(74, 46);
    g.stroke();
    g.beginPath();
    g.arc(64, 94, 20, 1.15 * Math.PI, 1.85 * Math.PI);
    g.stroke();
  } else if (preset === 'angel') {
    g.fillStyle = '#ff9ff3';
    g.beginPath();
    g.arc(30, 66, 10, 0, TAU);
    g.arc(98, 66, 10, 0, TAU);
    g.fill();
    g.fillStyle = '#111111';
    g.lineWidth = 5;
    g.beginPath();
    g.arc(44, 50, 10, Math.PI, TAU);
    g.stroke();
    g.beginPath();
    g.arc(84, 50, 10, Math.PI, TAU);
    g.stroke();
    g.beginPath();
    g.arc(64, 64, 20, 0.2 * Math.PI, 0.8 * Math.PI);
    g.stroke();
  }
  g.restore();
}

export function makeDefaultFaceDataURL() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  drawFacePresetOnCtx(c.getContext('2d'), null, 'classic');
  return c.toDataURL();
}
export const defaultFaceURL = makeDefaultFaceDataURL();

// Базовый материал части тела — всегда непрозрачный, чтобы объект был виден под прозрачным спрайтом
export function makePartMat(colorHex) {
  const m = new THREE.MeshLambertMaterial({
    color: colorHex,
    transparent: false
  });
  m.userData = { baseColor: colorHex };
  return m;
}

// Наложение 2D-спрайта с честной альфой ТОЛЬКО на переднюю сторону (+Z) любого меша (с учётом смещения пивота сустава)
export function setMeshFrontSprite(mesh, texDataURL) {
  if (!mesh) return;
  const oldDecals = mesh.children.filter(c => c.userData && c.userData.isFrontSprite);
  for (const old of oldDecals) {
    mesh.remove(old);
    if (old.material) old.material.dispose();
  }
  mesh.userData.frontSpriteURL = texDataURL || null;
  if (!texDataURL) return;

  const params = (mesh.geometry && mesh.geometry.parameters) || {};
  const w = params.width || (params.radius ? params.radius * 1.4 : 1);
  const h = params.height || (params.radius ? params.radius * 1.4 : 1);
  const d = params.depth !== undefined ? params.depth : (params.radius ? params.radius * 2 : 1);
  const pivotOffsetY = (mesh.userData && mesh.userData.pivotOffsetY) || 0;

  const planeGeo = new THREE.PlaneGeometry(w, h);
  const tex = makeTexFromDataURL(texDataURL, false, false);
  const mat = new THREE.MeshLambertMaterial({
    map: tex,
    color: 0xffffff,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1
  });

  const decal = new THREE.Mesh(planeGeo, mat);
  decal.position.set(0, pivotOffsetY, d * 0.5 + 0.0025);
  decal.castShadow = false;
  decal.receiveShadow = true;
  decal.userData = { isFrontSprite: true };
  if (mesh.userData.editorRef) {
    decal.userData.editorRef = mesh.userData.editorRef;
  }
  if (mesh.userData.cosmeticItem) {
    decal.userData.cosmeticItem = mesh.userData.cosmeticItem;
  }

  mesh.add(decal);
}

/* ---------- 16x16 Пиксельные Шаблоны Партиклов ---------- */
const particleTexCache = new Map();

export function drawParticlePreset16(g, preset = 'spark') {
  const w = g.canvas.width;
  const h = g.canvas.height;
  g.clearRect(0, 0, w, h);
  g.save();
  g.scale(w / 16, h / 16);

  const px = (x, y, col) => {
    g.fillStyle = col;
    g.fillRect(x, y, 1, 1);
  };

  if (preset === 'spark' || preset === 'star') {
    const c1 = preset === 'star' ? '#ffce3a' : '#56f0ff';
    const c2 = '#ffffff';
    for (let i = 2; i < 14; i++) {
      px(7, i, c1);
      px(8, i, c1);
      px(i, 7, c1);
      px(i, 8, c1);
    }
    for (let x = 5; x <= 10; x++) {
      for (let y = 5; y <= 10; y++) {
        if (Math.abs(x - 7.5) + Math.abs(y - 7.5) < 4) px(x, y, c2);
      }
    }
  } else if (preset === 'heart') {
    const rows = [
      '................',
      '..xxxx....xxxx..',
      '.xxxxxx..xxxxxx.',
      'xxxxxxxxxxxxxxxx',
      'xxxxxxxxxxxxxxxx',
      'xxxxxxxxxxxxxxxx',
      '.xxxxxxxxxxxxxx.',
      '..xxxxxxxxxxxx..',
      '...xxxxxxxxxx...',
      '....xxxxxxxx....',
      '.....xxxxxx.....',
      '......xxxx......',
      '.......xx.......',
      '................',
      '................',
      '................'
    ];
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        if (rows[y][x] === 'x') {
          px(x, y, (x < 6 && y < 6) ? '#ff8a80' : '#ff2a55');
        }
      }
    }
  } else if (preset === 'fire') {
    for (let y = 2; y < 15; y++) {
      const half = Math.max(1, Math.floor(Math.sin(((y - 2) / 13) * Math.PI) * 6));
      for (let x = 8 - half; x < 8 + half; x++) {
        const col = y > 10 ? '#ffce3a' : (y > 6 ? '#ff6b00' : '#ff1e1e');
        px(x, y, col);
      }
    }
  } else if (preset === 'smoke') {
    for (let y = 2; y < 14; y++) {
      for (let x = 2; x < 14; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        if (d < 5.5) {
          px(x, y, d < 3 ? 'rgba(220,230,242,0.85)' : 'rgba(160,175,195,0.45)');
        }
      }
    }
  } else if (preset === 'hit') {
    for (let i = 2; i < 14; i++) {
      px(i, i, '#ff1e1e');
      px(i, 15 - i, '#ff1e1e');
      if (i > 4 && i < 11) {
        px(i, i - 1, '#ffffff');
        px(15 - i, i - 1, '#ff9e9e');
      }
    }
    px(3, 8, '#ffce3a');
    px(12, 7, '#ffce3a');
    px(7, 3, '#ffce3a');
    px(8, 12, '#ffce3a');
  }
  g.restore();
}

export function makeParticleTex(customDataURL = null, preset = 'spark') {
  const key = customDataURL || ('preset:' + preset);
  if (particleTexCache.has(key)) {
    return particleTexCache.get(key);
  }
  if (customDataURL) {
    const t = makeTexFromDataURL(customDataURL, false, true);
    particleTexCache.set(key, t);
    return t;
  }
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  drawParticlePreset16(g, preset);
  const t = new THREE.CanvasTexture(c);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.userData = { dataURL: c.toDataURL() };
  particleTexCache.set(key, t);
  return t;
}

/* ---------- Оптическая система Гало (Световые ореолы / Light Halo Corona) ---------- */
let sharedHaloTexture = null;

export function getSharedHaloTexture() {
  if (sharedHaloTexture) return sharedHaloTexture;
  const size = 256;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  const cx = size / 2;
  const cy = size / 2;
  const radius = size / 2;

  // Радиальный градиент: сверкающее ядро -> мягкая рассеянная корона -> гладкий сход в прозрачность
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  grad.addColorStop(0.00, 'rgba(255, 255, 255, 1.0)');
  grad.addColorStop(0.08, 'rgba(255, 255, 255, 0.94)');
  grad.addColorStop(0.22, 'rgba(255, 255, 255, 0.68)');
  grad.addColorStop(0.42, 'rgba(255, 255, 255, 0.32)');
  grad.addColorStop(0.66, 'rgba(255, 255, 255, 0.11)');
  grad.addColorStop(0.86, 'rgba(255, 255, 255, 0.025)');
  grad.addColorStop(1.00, 'rgba(255, 255, 255, 0.0)');

  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  // Мягкий концентрированный центр для эффекта интенсивного источника света
  const centerGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 0.38);
  centerGrad.addColorStop(0.0, 'rgba(255, 255, 255, 0.6)');
  centerGrad.addColorStop(0.35, 'rgba(255, 255, 255, 0.22)');
  centerGrad.addColorStop(1.0, 'rgba(255, 255, 255, 0.0)');
  ctx.fillStyle = centerGrad;
  ctx.fillRect(0, 0, size, size);

  sharedHaloTexture = new THREE.CanvasTexture(cv);
  sharedHaloTexture.generateMipmaps = true;
  sharedHaloTexture.minFilter = THREE.LinearMipmapLinearFilter;
  sharedHaloTexture.magFilter = THREE.LinearFilter;
  return sharedHaloTexture;
}

export function createHaloSprite(colorHex = '#ffffff', size = 3.0, opacity = 0.75) {
  const tex = getSharedHaloTexture();
  const mat = new THREE.SpriteMaterial({
    map: tex,
    color: new THREE.Color(colorHex || '#ffffff'),
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: Math.max(0.05, Math.min(1.0, opacity)),
    depthWrite: false,
    depthTest: true
  });
  const spr = new THREE.Sprite(mat);
  spr.scale.set(size, size, 1);
  spr.userData.isHaloSprite = true;
  spr.userData.noCollider = true;
  spr.raycast = () => {}; // Полное исключение из рэйкастинга мыши и оружия
  return spr;
}

// Утилита горизонтального отзеркаливания канваса (для принтов конечностей R6)
export function flipCanvasHorizontally(sourceCanvas) {
  if (!sourceCanvas) return null;
  const c = document.createElement('canvas');
  c.width = sourceCanvas.width;
  c.height = sourceCanvas.height;
  const ctx = c.getContext('2d');
  ctx.translate(c.width, 0);
  ctx.scale(-1, 1);
  ctx.drawImage(sourceCanvas, 0, 0);
  return c.toDataURL();
}

// Асинхронное отзеркаливание DataURL изображения
export function flipImageURLHorizontally(dataURL) {
  return new Promise((resolve) => {
    if (!dataURL) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width || 128;
      c.height = img.height || 128;
      const ctx = c.getContext('2d');
      ctx.translate(c.width, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0);
      resolve(c.toDataURL());
    };
    img.onerror = () => resolve(dataURL);
    img.src = dataURL;
  });
}

