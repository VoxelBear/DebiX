// src/core/SurfaceWeatherVisuals.js
import { S, clamp } from './State.js';
import { scene } from './SceneManager.js';
import { WEATHER_PHASES, isPointExposedToSky } from './WeatherAndClouds.js';

const SWV_MAX_PUDDLE_QUADS = 1800;
const SWV_MAX_SNOW_QUADS = 3000;
const SWV_MAX_COAT_QUADS = 2200;
const SWV_MAX_FOOTPRINTS = 280;
const SWV_ATLAS_TILE = 64;
const SWV_ATLAS_SIZE = SWV_ATLAS_TILE * 4; // 256x256 (16 бесшовных масок связности)
const SWV_COAT_STEP = 2.2;                 // Шаг сетки покрытия для мягких границ под крышами

let _swvInited = false;
let _swvPuddleFieldTex = null;

let _swvPuddleBatch = null;
let _swvLavaBatch = null;
let _swvSnowBatch = null;
let _swvCoatWetBatch = null;
let _swvCoatSnowBatch = null;
let _swvFootprintBatch = null;

// Единые uniforms времени и цвета неба для отражения в лужах и влажных поверхностях
const _swvTimeUniform = { value: 0 };
const _swvSkyColorUniform = { value: new THREE.Color('#88ccff') };
const _swvSkyHorizonUniform = { value: new THREE.Color('#88ccff') };
const _swvFootprints = [];

const _swvColor = new THREE.Color();
const _swvIceColor = new THREE.Color();
const _swvCrustColor = new THREE.Color('#30323c');
const _swvV0 = new THREE.Vector3();
const _swvV1 = new THREE.Vector3();
const _swvV2 = new THREE.Vector3();
const _swvV3 = new THREE.Vector3();
const _swvB0 = new THREE.Vector3();
const _swvB1 = new THREE.Vector3();
const _swvB2 = new THREE.Vector3();
const _swvB3 = new THREE.Vector3();
const _swvNorm = new THREE.Vector3();
const _swvSideNorm = new THREE.Vector3();
const _swvEdgeA = new THREE.Vector3();
const _swvEdgeB = new THREE.Vector3();
const _swvTmp = new THREE.Vector3();

// Состояние постепенного покрытия секций блоков: "blkId_ix_iz" -> CoatState
const _swvBlockCoats = new Map();

/* ---------- 1. ГЕНЕРАЦИЯ ГЛАДКОГО ПОЛЯ СВЯЗНОСТИ (16 ТАЙЛОВ 4×4 ДЛЯ СЛИЯНИЯ ЛУЖ) ---------- */

function createPuddleConnectivityFieldTexture() {
  const cv = document.createElement('canvas');
  cv.width = SWV_ATLAS_SIZE;
  cv.height = SWV_ATLAS_SIZE;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(SWV_ATLAS_SIZE, SWV_ATLAS_SIZE);
  const data = img.data;
  const cr = 0.44;

  for (let mask = 0; mask < 16; mask++) {
    const hasN = (mask & 1) !== 0;
    const hasE = (mask & 2) !== 0;
    const hasS = (mask & 4) !== 0;
    const hasW = (mask & 8) !== 0;

    const col = mask & 3;
    const row = mask >> 2;
    const ox = col * SWV_ATLAS_TILE;
    const oy = row * SWV_ATLAS_TILE;

    for (let py = 0; py < SWV_ATLAS_TILE; py++) {
      const v = (py + 0.5) / SWV_ATLAS_TILE;
      for (let px = 0; px < SWV_ATLAS_TILE; px++) {
        const u = (px + 0.5) / SWV_ATLAS_TILE;

        let dx = 0;
        if (!hasW && u < cr) dx = cr - u;
        else if (!hasE && (1 - u) < cr) dx = cr - (1 - u);

        let dy = 0;
        if (!hasN && v < cr) dy = cr - v;
        else if (!hasS && (1 - v) < cr) dy = cr - (1 - v);

        // Гладкое поле расстояния (1.0 внутри и на стыках с соседями, плавно к 0 на открытом краю)
        const dist = Math.hypot(dx, dy);
        const field = clamp(1.0 - dist / cr, 0, 1);
        const aByte = clamp(Math.round(field * 255), 0, 255);

        const idx = ((oy + py) * SWV_ATLAS_SIZE + (ox + px)) * 4;
        data[idx] = 255;
        data[idx + 1] = 255;
        data[idx + 2] = 255;
        data[idx + 3] = aByte;
      }
    }
  }

  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(cv);
  tex.flipY = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/* ---------- 2. GLSL-ФУНКЦИИ МИРОВОГО ШУМА И LEGO-СТИЛИЗАЦИИ (WEBGL1 / THREE.JS r128) ---------- */

const GLSL_SWV_NOISE_COMMON = `
uniform float uSwvTime;
uniform vec3 uSwvSkyColor;
varying float vSwvAlpha;
varying vec3 vSwvWorldPos;
varying float vSwvNormalY;
varying vec2 vSwvUv;

float swvHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float swvNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = swvHash(i);
  float b = swvHash(i + vec2(1.0, 0.0));
  float c = swvHash(i + vec2(0.0, 1.0));
  float d = swvHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

// Неповторяющийся многочастотный мировой шум с поворотом октав
float swvFbm(vec2 p) {
  float v = 0.0;
  float amp = 0.52;
  mat2 rot = mat2(0.80, -0.60, 0.60, 0.80);
  v += amp * swvNoise(p);
  p = rot * p * 2.07 + vec2(17.3, 9.1);
  amp *= 0.5;
  v += amp * swvNoise(p);
  p = rot * p * 2.13 + vec2(5.7, 23.4);
  amp *= 0.5;
  v += amp * swvNoise(p);
  return v;
}

// Стилизованный рельеф квадратных лего-пупырышек (1 пупырышка = 1.0м, совпадает с блоками)
float swvLegoStudMask(vec2 xz) {
  vec2 cell = fract(xz) - 0.5;
  vec2 a = abs(cell);
  float box = max(a.x, a.y);
  float rim = smoothstep(0.21, 0.235, box) * (1.0 - smoothstep(0.265, 0.29, box));
  float topHi = (1.0 - smoothstep(0.19, 0.22, box)) * step(cell.y, 0.0) * 0.28;
  return rim - topHi;
}
`;

function patchSwvMaterial(mat, mode, cacheKey) {
  mat.customProgramCacheKey = () => cacheKey;
  mat.onBeforeCompile = shader => {
    shader.uniforms.uSwvTime = _swvTimeUniform;
    shader.uniforms.uSwvSkyColor = _swvSkyColorUniform;

    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float aAlpha;\nvarying float vSwvAlpha;\nvarying vec3 vSwvWorldPos;\nvarying float vSwvNormalY;\nvarying vec2 vSwvUv;'
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvSwvAlpha = aAlpha;\nvSwvWorldPos = position;\nvSwvNormalY = normal.y;\nvSwvUv = uv;'
      );

    let fragBody = '';

    if (mode === 'puddle') {
      // Стилизованная полупрозрачная глянцевая жидкость с Френель-отражением неба, мениском и рябью
      fragBody = `
        #include <color_fragment>
        float conn = diffuseColor.a;
        vec2 wp = vSwvWorldPos.xz;
        float org = (swvFbm(wp * 0.72) - 0.5) * 0.34;
        float field = conn + org * (1.0 - smoothstep(0.75, 0.98, conn));

        // Чёткий стилизованный край лужи (без размытой «кляксы»)
        float shape = smoothstep(0.42, 0.49, field);
        if (shape < 0.02) discard;

        // Тонкая светлая кромка мениска по периметру жидкости
        float rim = smoothstep(0.42, 0.49, field) * (1.0 - smoothstep(0.51, 0.60, field));

        // Лёгкая анимированная водная рябь и стилизованные блики
        float r1 = swvNoise(wp * 2.1 + vec2(uSwvTime * 0.45, -uSwvTime * 0.32));
        float r2 = swvNoise(wp * 3.4 - vec2(uSwvTime * 0.35, uSwvTime * 0.48));
        float glint = smoothstep(0.68, 0.80, (r1 + r2) * 0.5);

        // Тонкий намёк на квадратные пупырышки под прозрачной лужей
        float stud = swvLegoStudMask(wp);

        // Отражение цвета неба под углом взгляда (Френель)
        vec3 viewToCam = normalize(cameraPosition - vSwvWorldPos);
        float fresnel = pow(1.0 - clamp(abs(viewToCam.y), 0.0, 1.0), 2.1);
        float skyRefl = mix(0.24, 0.68, fresnel);

        vec3 baseCol = mix(diffuseColor.rgb, uSwvSkyColor, skyRefl);
        vec3 rimCol = mix(baseCol * 1.35, mix(vec3(0.95, 0.98, 1.0), uSwvSkyColor, 0.45), 0.52);
        diffuseColor.rgb = mix(baseCol, rimCol, rim * 0.60);
        diffuseColor.rgb += mix(vec3(0.25, 0.28, 0.32), uSwvSkyColor * 0.55, 0.5) * glint * (0.45 + vSwvAlpha * 0.5);
        diffuseColor.rgb -= vec3(0.05) * max(0.0, stud);

        diffuseColor.a = shape * clamp(vSwvAlpha + rim * 0.16 + glint * 0.10 + fresnel * 0.12, 0.0, 0.86);
        if (diffuseColor.a < 0.02) discard;
      `;
    } else if (mode === 'lava') {
      // Раскалённая лава с тёмными прожилками и ярким ядром
      fragBody = `
        #include <color_fragment>
        float conn = diffuseColor.a;
        vec2 wp = vSwvWorldPos.xz;
        float org = (swvFbm(wp * 0.68) - 0.5) * 0.32;
        float field = conn + org * (1.0 - smoothstep(0.75, 0.98, conn));

        float shape = smoothstep(0.42, 0.49, field);
        if (shape < 0.02) discard;

        float flow = swvFbm(wp * 1.35 + vec2(uSwvTime * 0.16, uSwvTime * 0.11));
        float hotCore = smoothstep(0.46, 0.72, flow);
        float crustRim = 1.0 - smoothstep(0.45, 0.62, field);

        vec3 darkMagma = vec3(0.32, 0.08, 0.03);
        vec3 brightLava = vec3(1.0, 0.42, 0.06);
        vec3 yellowCore = vec3(1.0, 0.84, 0.25);

        vec3 lavaCol = mix(brightLava, yellowCore, hotCore * 0.78);
        lavaCol = mix(lavaCol, darkMagma, crustRim * 0.55);

        diffuseColor.rgb = lavaCol;
        diffuseColor.a = shape * clamp(vSwvAlpha + 0.12, 0.0, 0.94);
        if (diffuseColor.a < 0.02) discard;
      `;
    } else if (mode === 'snow_volume') {
      // Настоящий объёмный 3D-сугроб в стиле LEGO: чёткие грани, пупырышки сверху и мягкая тень на боках
      fragBody = `
        #include <color_fragment>
        vec2 wp = vSwvWorldPos.xz;
        float grain = swvNoise(wp * 3.8) * 0.05;
        float stud = swvLegoStudMask(wp);
        float isTop = smoothstep(0.45, 0.75, vSwvNormalY);

        // На верхней поверхности — аккуратный рельеф лего-пупырышек и искры снега
        vec3 topTint = diffuseColor.rgb * (0.96 + grain) - vec3(0.055, 0.045, 0.03) * max(0.0, stud);
        // Боковые стенки сугроба — чуть прохладнее и темнее, чтобы 3D-объём сразу читался
        vec3 sideTint = diffuseColor.rgb * vec3(0.84, 0.88, 0.94);

        diffuseColor.rgb = mix(sideTint, topTint, isTop);
        diffuseColor.a = 1.0;
      `;
    } else if (mode === 'coat_wet') {
      // Деликатное влажное покрытие блоков: НЕ «кетчуп/васаби», а тонкий блеск + органические брызги
      fragBody = `
        #include <color_fragment>
        vec2 wp = vSwvWorldPos.xz;
        float nLarge = swvFbm(wp * 0.31);
        float nFine = swvNoise(wp * 2.6 + vec2(uSwvTime * 0.08, -uSwvTime * 0.06));
        float stud = swvLegoStudMask(wp);

        // Органическое проявление влажности с плавным переходом под крышами
        float mask = nLarge * 0.78 + nFine * 0.22;
        float reveal = smoothstep(1.04 - vSwvAlpha * 1.16, 1.08 - vSwvAlpha * 0.82, mask);

        // Влага чуть охотнее собирается вокруг швов лего-пупырышек
        float studCollect = clamp(reveal + max(0.0, stud) * vSwvAlpha * 0.22, 0.0, 1.0);
        float speck = smoothstep(0.76, 0.86, nFine) * 0.22;

        diffuseColor.rgb = mix(diffuseColor.rgb, uSwvSkyColor, 0.38) + mix(vec3(0.20, 0.23, 0.26), uSwvSkyColor * 0.45, 0.55) * speck;
        diffuseColor.a = studCollect * clamp(vSwvAlpha * 0.44, 0.0, 0.44);
        if (diffuseColor.a < 0.015) discard;
      `;
    } else if (mode === 'footprint') {
      // Отпечаток квадратной/прямоугольной ноги R6 на снегу с мягкой тенью глубины и тонким валиком
      fragBody = `
        #include <color_fragment>
        vec2 p = vSwvUv - 0.5;
        vec2 q = abs(p) - vec2(0.38, 0.38);
        float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.045;

        // Чёткая вмятина ровно по контуру блока ноги R6
        float innerMask = 1.0 - smoothstep(-0.035, 0.012, sd);
        float bevelWall = smoothstep(-0.075, -0.005, sd) * innerMask;
        float outerRim = smoothstep(0.0, 0.03, sd) * (1.0 - smoothstep(0.03, 0.085, sd));

        float grain = swvNoise(vSwvWorldPos.xz * 8.0) * 0.06;
        // Направленный объёмный градиент внутри ямки (имитирует реальную глубину вмятины)
        float shadeGrad = clamp(0.5 + (p.x + p.y) * 0.75, 0.2, 0.95);
        vec3 floorCol = diffuseColor.rgb * mix(vec3(0.60, 0.67, 0.78), vec3(0.76, 0.82, 0.90), shadeGrad) * (1.0 - grain);
        vec3 wallCol = diffuseColor.rgb * vec3(0.50, 0.58, 0.70);
        vec3 rimCol = diffuseColor.rgb * 1.08;

        vec3 insideCol = mix(floorCol, wallCol, bevelWall * 0.65);
        float mask = max(innerMask * 0.88, outerRim * 0.36);
        if (mask < 0.02) discard;

        diffuseColor.rgb = mix(rimCol, insideCol, clamp(innerMask * 1.2, 0.0, 1.0));
        diffuseColor.a = mask * clamp(vSwvAlpha, 0.0, 0.88);
        if (diffuseColor.a < 0.02) discard;
      `;
    } else if (mode === 'coat_snow') {
      // Стилизованное снежное/пепельное покрытие с мягкой границей под крышами и LEGO-пупырышками
      fragBody = `
        #include <color_fragment>
        vec2 wp = vSwvWorldPos.xz;
        float nLarge = swvFbm(wp * 0.28);
        float nDetail = swvNoise(wp * 1.85);
        float stud = swvLegoStudMask(wp);

        float mask = nLarge * 0.74 + nDetail * 0.26;
        // Стилизованный чуть более чёткий (не мыльный) край снежных островков
        float reveal = smoothstep(1.02 - vSwvAlpha * 1.15, 1.09 - vSwvAlpha * 0.92, mask);

        diffuseColor.rgb = diffuseColor.rgb * (0.96 + nDetail * 0.04) - vec3(0.06, 0.05, 0.035) * max(0.0, stud);
        diffuseColor.a = reveal * clamp(vSwvAlpha * 1.15, 0.0, 0.92);
        if (diffuseColor.a < 0.02) discard;
      `;
    }

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${GLSL_SWV_NOISE_COMMON}`)
      .replace('#include <color_fragment>', fragBody);
  };
  return mat;
}

/* ---------- 3. ОБЪЕДИНЁННЫЕ МЕШИ (MERGED DYNAMIC BUFFERGEOMETRY) ---------- */

function createMergedQuadBatch(maxQuads, material, renderOrder = 2, castShadow = false) {
  const maxVerts = maxQuads * 4;
  const maxIdx = maxQuads * 6;

  const pos = new Float32Array(maxVerts * 3);
  const norm = new Float32Array(maxVerts * 3);
  const uv = new Float32Array(maxVerts * 2);
  const col = new Float32Array(maxVerts * 3);
  const alpha = new Float32Array(maxVerts);
  const indices = new Uint16Array(maxIdx);

  for (let q = 0; q < maxQuads; q++) {
    const v = q * 4;
    const i = q * 6;
    indices[i] = v;
    indices[i + 1] = v + 3;
    indices[i + 2] = v + 1;
    indices[i + 3] = v + 1;
    indices[i + 4] = v + 3;
    indices[i + 5] = v + 2;
  }

  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  const normAttr = new THREE.BufferAttribute(norm, 3);
  const uvAttr = new THREE.BufferAttribute(uv, 2);
  const colAttr = new THREE.BufferAttribute(col, 3);
  const alphaAttr = new THREE.BufferAttribute(alpha, 1);

  posAttr.setUsage(THREE.DynamicDrawUsage);
  normAttr.setUsage(THREE.DynamicDrawUsage);
  uvAttr.setUsage(THREE.DynamicDrawUsage);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);

  geo.setAttribute('position', posAttr);
  geo.setAttribute('normal', normAttr);
  geo.setAttribute('uv', uvAttr);
  geo.setAttribute('color', colAttr);
  geo.setAttribute('aAlpha', alphaAttr);
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  geo.setDrawRange(0, 0);

  const mesh = new THREE.Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  mesh.renderOrder = renderOrder;
  mesh.visible = false;
  mesh.userData.noCollider = true;
  scene.add(mesh);

  return {
    mesh,
    geo,
    maxQuads,
    quadCount: 0,
    pos,
    norm,
    uv,
    col,
    alpha,
    posAttr,
    normAttr,
    uvAttr,
    colAttr,
    alphaAttr
  };
}

function resetBatch(batch) {
  batch.quadCount = 0;
}

function pushQuadToBatch(batch, v0, v1, v2, v3, n, u0, v0Uv, u1, v1Uv, r, g, b, a0, a1, a2, a3) {
  if (batch.quadCount >= batch.maxQuads) return;
  const vBase = batch.quadCount * 4;
  const p3 = vBase * 3;
  const p2 = vBase * 2;
  const pos = batch.pos;
  const norm = batch.norm;
  const uv = batch.uv;
  const col = batch.col;
  const al = batch.alpha;

  pos[p3] = v0.x; pos[p3 + 1] = v0.y; pos[p3 + 2] = v0.z;
  pos[p3 + 3] = v1.x; pos[p3 + 4] = v1.y; pos[p3 + 5] = v1.z;
  pos[p3 + 6] = v2.x; pos[p3 + 7] = v2.y; pos[p3 + 8] = v2.z;
  pos[p3 + 9] = v3.x; pos[p3 + 10] = v3.y; pos[p3 + 11] = v3.z;

  for (let k = 0; k < 4; k++) {
    const o = p3 + k * 3;
    norm[o] = n.x; norm[o + 1] = n.y; norm[o + 2] = n.z;
    col[o] = r; col[o + 1] = g; col[o + 2] = b;
  }

  uv[p2] = u0; uv[p2 + 1] = v0Uv;
  uv[p2 + 2] = u1; uv[p2 + 3] = v0Uv;
  uv[p2 + 4] = u1; uv[p2 + 5] = v1Uv;
  uv[p2 + 6] = u0; uv[p2 + 7] = v1Uv;

  al[vBase] = a0;
  al[vBase + 1] = a1;
  al[vBase + 2] = a2;
  al[vBase + 3] = a3;

  batch.quadCount++;
}

function flushBatch(batch) {
  if (batch.quadCount <= 0) {
    batch.geo.setDrawRange(0, 0);
    batch.mesh.visible = false;
    return;
  }
  batch.geo.setDrawRange(0, batch.quadCount * 6);
  batch.posAttr.needsUpdate = true;
  batch.normAttr.needsUpdate = true;
  batch.uvAttr.needsUpdate = true;
  batch.colAttr.needsUpdate = true;
  batch.alphaAttr.needsUpdate = true;
  batch.mesh.visible = true;
}

function ensureVisualBatches() {
  if (_swvInited) return;
  _swvInited = true;

  _swvPuddleFieldTex = createPuddleConnectivityFieldTexture();

  // 1. Объединённый меш стилизованных полупрозрачных луж
  const puddleMat = patchSwvMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      map: _swvPuddleFieldTex,
      vertexColors: true,
      roughness: 0.06,
      metalness: 0.24,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4
    }),
    'puddle',
    'debix_swv_puddle_v2'
  );
  _swvPuddleBatch = createMergedQuadBatch(SWV_MAX_PUDDLE_QUADS, puddleMat, 3, false);

  // 2. Объединённый меш лавовых луж
  const lavaMat = patchSwvMaterial(
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      map: _swvPuddleFieldTex,
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4
    }),
    'lava',
    'debix_swv_lava_v2'
  );
  _swvLavaBatch = createMergedQuadBatch(SWV_MAX_PUDDLE_QUADS, lavaMat, 3, false);

  // 3. Настоящие объёмные 3D-сугробы (твёрдый рендер с боковыми стенками и LEGO-пупырышками)
  const snowMat = patchSwvMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.02,
      transparent: false,
      depthWrite: true
    }),
    'snow_volume',
    'debix_swv_snowvol_v2'
  );
  _swvSnowBatch = createMergedQuadBatch(SWV_MAX_SNOW_QUADS, snowMat, 4, true);

  // 4. Постепенное влажное покрытие поверхности блоков (глянец + лёгкие разводы)
  const coatWetMat = patchSwvMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.06,
      metalness: 0.26,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2
    }),
    'coat_wet',
    'debix_swv_coatwet_v2'
  );
  _swvCoatWetBatch = createMergedQuadBatch(SWV_MAX_COAT_QUADS, coatWetMat, 1, false);

  // 5. Постепенное снежное / пепельное покрытие поверхности блоков (LEGO-стиль)
  const coatSnowMat = patchSwvMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.86,
      metalness: 0.02,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -2
    }),
    'coat_snow',
    'debix_swv_coatsnow_v2'
  );
  _swvCoatSnowBatch = createMergedQuadBatch(SWV_MAX_COAT_QUADS, coatSnowMat, 2, false);

  // 6. Объединённый меш следов ног на снегу
  const footprintMat = patchSwvMaterial(
    new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.92,
      metalness: 0.0,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -6
    }),
    'footprint',
    'debix_swv_footprint_v1'
  );
  _swvFootprintBatch = createMergedQuadBatch(SWV_MAX_FOOTPRINTS, footprintMat, 5, false);
}

export function tickSurfaceWeatherVisualsTime(timeSec) {
  _swvTimeUniform.value = Number(timeSec) || 0;
}

export function setSurfaceWeatherSkyColors(skyColor, horizonColor) {
  if (skyColor) _swvSkyColorUniform.value.copy(skyColor);
  if (horizonColor) _swvSkyHorizonUniform.value.copy(horizonColor);
  else if (skyColor) _swvSkyHorizonUniform.value.copy(skyColor);
}

export function setSurfaceWeatherSkyColor(skyColor) {
  setSurfaceWeatherSkyColors(skyColor, skyColor);
}

/**
 * Патчит материал жидкого блока для попиксельного Френель-отражения неба с рябью.
 * Совместим с Three.js r128 (WebGL1) и массивами 6-гранных материалов.
 */
export function patchLiquidBlockReflectionMaterial(matOrArr) {
  if (!matOrArr) return null;
  const mats = Array.isArray(matOrArr) ? matOrArr : [matOrArr];
  let sharedUniforms = null;

  for (let i = 0; i < mats.length; i++) {
    const mat = mats[i];
    if (!mat || !mat.isMaterial) continue;
    if (mat.userData && mat.userData._liqReflUniforms) {
      sharedUniforms = mat.userData._liqReflUniforms;
      continue;
    }
    if (!sharedUniforms) {
      sharedUniforms = {
        uLiqSkyStrength: { value: 0.85 },
        uLiqFresnelMin: { value: 0.16 }
      };
    }
    if (!mat.userData) mat.userData = {};
    mat.userData._liqReflUniforms = sharedUniforms;

    mat.customProgramCacheKey = () => 'debix_liq_skyrefl_v2';
    mat.onBeforeCompile = shader => {
      shader.uniforms.uSwvTime = _swvTimeUniform;
      shader.uniforms.uSwvSkyColor = _swvSkyColorUniform;
      shader.uniforms.uSwvSkyHorizon = _swvSkyHorizonUniform;
      shader.uniforms.uLiqSkyStrength = sharedUniforms.uLiqSkyStrength;
      shader.uniforms.uLiqFresnelMin = sharedUniforms.uLiqFresnelMin;

      const hasNormalChunk = shader.vertexShader.indexOf('#include <beginnormal_vertex>') !== -1;

      shader.vertexShader = shader.vertexShader.replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vLiqWorldPos;\nvarying vec3 vLiqWorldNorm;'
      );

      if (hasNormalChunk) {
        shader.vertexShader = shader.vertexShader.replace(
          '#include <beginnormal_vertex>',
          `#include <beginnormal_vertex>
          vec3 _liqWn = (modelMatrix * vec4(objectNormal, 0.0)).xyz;
          vLiqWorldNorm = length(_liqWn) > 0.0001 ? normalize(_liqWn) : vec3(0.0, 1.0, 0.0);`
        );
      }

      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vLiqWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        ${hasNormalChunk ? '' : 'vLiqWorldNorm = vec3(0.0, 1.0, 0.0);'}`
      );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
uniform float uSwvTime;
uniform vec3 uSwvSkyColor;
uniform vec3 uSwvSkyHorizon;
uniform float uLiqSkyStrength;
uniform float uLiqFresnelMin;
varying vec3 vLiqWorldPos;
varying vec3 vLiqWorldNorm;`
        )
        .replace(
          '#include <tonemapping_fragment>',
          `
          if (uLiqSkyStrength > 0.005) {
            vec3 toCam = cameraPosition - vLiqWorldPos;
            float camDist = length(toCam);
            vec3 viewDir = toCam / max(camDist, 0.001);
            vec3 baseN = length(vLiqWorldNorm) > 0.0001 ? normalize(vLiqWorldNorm) : vec3(0.0, 1.0, 0.0);

            // Живая рябь волн, преломляющая отражение неба
            float topMask = smoothstep(0.35, 0.85, baseN.y);
            float w1 = sin(vLiqWorldPos.x * 1.15 + uSwvTime * 1.75 + cos(vLiqWorldPos.z * 0.72)) * 0.055;
            float w2 = cos(vLiqWorldPos.z * 1.35 - uSwvTime * 1.45 + sin(vLiqWorldPos.x * 0.85)) * 0.055;
            vec3 rippleN = normalize(baseN + vec3(w1, 0.0, w2) * topMask);

            float ndotv = clamp(abs(dot(rippleN, viewDir)), 0.0, 1.0);
            float fresnel = clamp(uLiqFresnelMin + (1.0 - uLiqFresnelMin) * pow(max(0.0001, 1.0 - ndotv), 2.35), 0.0, 0.96);
            float distFade = smoothstep(18.0, 165.0, camDist) * 0.62;
            float reflFactor = clamp(max(fresnel, distFade) * uLiqSkyStrength * mix(0.45, 1.0, topMask), 0.0, 0.95);

            // Ближе к зениту отражается верх неба, ближе к горизонту — цвет горизонта
            vec3 skyRefl = mix(uSwvSkyColor, uSwvSkyHorizon, smoothstep(0.12, 0.82, fresnel));
            float shimmer = smoothstep(0.055, 0.095, abs(w1 + w2)) * 0.14 * topMask * uLiqSkyStrength;

            gl_FragColor.rgb = mix(gl_FragColor.rgb, skyRefl, reflFactor) + skyRefl * shimmer;
            gl_FragColor.a = clamp(gl_FragColor.a + reflFactor * 0.24, 0.0, 0.98);
          }
          #include <tonemapping_fragment>
          `
        );
    };
    mat.needsUpdate = true;
  }

  return sharedUniforms;
}

/* ---------- 4. ОБРЕЗКА ПО КРАЮ БЛОКОВ И ПОСТРОЕНИЕ 3D-СУГРОБОВ И ЛУЖ ---------- */

function hasCoplanarSolidContinuation(wx, wz, baseY, excludeBlock) {
  const blocks = S.allBlocks;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b === excludeBlock || b.isDisabled || b._depletedDisabled || b._isCarriedByPlayer) continue;
    if (b.matterState !== 'solid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (b.components && !b.components.physics?.enabled) continue;
    if (Math.abs(b.y1 - baseY) > 0.14) continue;
    if (wx >= b.x0 && wx <= b.x1 && wz >= b.z0 && wz <= b.z1) return true;
  }
  return false;
}

function getAtlasTileUV(mask) {
  const col = mask & 3;
  const row = mask >> 2;
  const pad = 0.75 / SWV_ATLAS_SIZE;
  return {
    u0: col * 0.25 + pad,
    v0: row * 0.25 + pad,
    u1: (col + 1) * 0.25 - pad,
    v1: (row + 1) * 0.25 - pad
  };
}

/**
 * Вычисляет углы ячейки (верхние _swvV0..3 и опционально нижние на уровне пола _swvB0..3),
 * жёстко обрезанные по границам опорного блока, чтобы осадки никогда не свисали в воздух.
 */
function computeClippedCellQuad(cell, cellSize, hasN, hasE, hasS, hasW, y0, y1, y2, y3, withBase = false) {
  const b = cell.block;
  if (!b || !b.m) return false;

  const rawX0 = cell.gx * cellSize;
  const rawX1 = rawX0 + cellSize;
  const rawZ0 = cell.gz * cellSize;
  const rawZ1 = rawZ0 + cellSize;
  const edgeInset = 0.03;

  if (!b.isRotated) {
    let x0 = rawX0;
    let x1 = rawX1;
    let z0 = rawZ0;
    let z1 = rawZ1;

    if (!hasW && x0 < b.x0 && !hasCoplanarSolidContinuation(b.x0 - 0.12, cell.wz, cell.baseY, b)) {
      x0 = Math.max(x0, b.x0 + edgeInset);
    }
    if (!hasE && x1 > b.x1 && !hasCoplanarSolidContinuation(b.x1 + 0.12, cell.wz, cell.baseY, b)) {
      x1 = Math.min(x1, b.x1 - edgeInset);
    }
    if (!hasN && z0 < b.z0 && !hasCoplanarSolidContinuation(cell.wx, b.z0 - 0.12, cell.baseY, b)) {
      z0 = Math.max(z0, b.z0 + edgeInset);
    }
    if (!hasS && z1 > b.z1 && !hasCoplanarSolidContinuation(cell.wx, b.z1 + 0.12, cell.baseY, b)) {
      z1 = Math.min(z1, b.z1 - edgeInset);
    }

    if (x1 - x0 < 0.14 || z1 - z0 < 0.14) return false;

    _swvV0.set(x0, y0, z0);
    _swvV1.set(x1, y1, z0);
    _swvV2.set(x1, y2, z1);
    _swvV3.set(x0, y3, z1);
    _swvNorm.set(0, 1, 0);

    if (withBase) {
      const by = cell.baseY - 0.01;
      _swvB0.set(x0, by, z0);
      _swvB1.set(x1, by, z0);
      _swvB2.set(x1, by, z1);
      _swvB3.set(x0, by, z1);
    }
    return true;
  }

  const bx = b.m.position.x;
  const by = b.m.position.y;
  const bz = b.m.position.z;
  const maxX = Math.max(0.05, b.hx - edgeInset);
  const maxZ = Math.max(0.05, b.hz - edgeInset);
  const corners = [
    [rawX0, rawZ0, y0 - cell.baseY, _swvV0, _swvB0],
    [rawX1, rawZ0, y1 - cell.baseY, _swvV1, _swvB1],
    [rawX1, rawZ1, y2 - cell.baseY, _swvV2, _swvB2],
    [rawX0, rawZ1, y3 - cell.baseY, _swvV3, _swvB3]
  ];

  for (let i = 0; i < 4; i++) {
    const [wx, wz, liftY, outV, outB] = corners[i];
    _swvTmp.set(wx - bx, 0, wz - bz).applyQuaternion(b.invQuat);
    const cx = clamp(_swvTmp.x, -maxX, maxX);
    const cz = clamp(_swvTmp.z, -maxZ, maxZ);

    _swvTmp.set(cx, b.hy + liftY, cz).applyQuaternion(b.m.quaternion);
    outV.set(bx + _swvTmp.x, by + _swvTmp.y, bz + _swvTmp.z);

    if (withBase) {
      _swvTmp.set(cx, b.hy - 0.01, cz).applyQuaternion(b.m.quaternion);
      outB.set(bx + _swvTmp.x, by + _swvTmp.y, bz + _swvTmp.z);
    }
  }
  _swvNorm.copy(b.axisY);
  return _swvV0.distanceToSquared(_swvV2) > 0.04;
}

function pushVolumetricSideWall(batch, topA, topB, botB, botA, r, g, b) {
  // Проверяем, что стенка имеет ощутимую высоту
  if ((topA.y - botA.y) < 0.015 && (topB.y - botB.y) < 0.015) return;
  _swvEdgeA.subVectors(botA, topA);
  _swvEdgeB.subVectors(topB, topA);
  _swvSideNorm.crossVectors(_swvEdgeA, _swvEdgeB);
  const len = _swvSideNorm.length();
  if (len < 0.0001) return;
  _swvSideNorm.divideScalar(len);
  pushQuadToBatch(batch, topA, topB, botB, botA, _swvSideNorm, 0, 0, 1, 1, r, g, b, 1, 1, 1, 1);
}

// Сбалансированная палитра для стилизованных жидкостей (без «кетчупа» и «васаби»)
function swvSubstancePalette(substance, solidType) {
  if (solidType === 'ash') return { solid: '#676c78', liquid: '#ff6a1a', ice: '#94a3b8', wetCoat: '#3f434d' };
  if (solidType === 'obsidian') return { solid: '#2b265e', liquid: '#ff6a1a', ice: '#4338ca', wetCoat: '#1e1b4b' };
  if (substance === 'blood') return { solid: '#f5b5b5', liquid: '#7c131d', ice: '#e18b96', wetCoat: '#6e1019' };
  if (substance === 'acid') return { solid: '#a7f3c2', liquid: '#16a34a', ice: '#86efac', wetCoat: '#15803d' };
  if (substance === 'lava') return { solid: '#676c78', liquid: '#ff6a1a', ice: '#3f3f46', wetCoat: '#c2410c' };
  return { solid: '#f1f6fc', liquid: '#2ca9e8', ice: '#bae6fd', wetCoat: '#0f2740' };
}

function getNeighborCell(cellsMap, gx, gz, baseY) {
  const nb = cellsMap.get(`${gx},${gz}`);
  if (!nb || Math.abs(nb.baseY - baseY) > 0.24) return null;
  return nb;
}

function computeSnowCornerLift(cellsMap, gx, gz, dxCorner, dzCorner, baseY) {
  let sum = 0;
  let cnt = 0;
  const xs = dxCorner < 0 ? [gx - 1, gx] : [gx, gx + 1];
  const zs = dzCorner < 0 ? [gz - 1, gz] : [gz, gz + 1];
  for (let ix = 0; ix < 2; ix++) {
    for (let iz = 0; iz < 2; iz++) {
      const c = getNeighborCell(cellsMap, xs[ix], zs[iz], baseY);
      if (c && c.snowDepth > 0.03) {
        // Рельефная высота настоящего 3D-сугроба с учётом проминания от шагов (snowCompress)
        const rawLift = clamp(c.snowDepth * (0.58 + c.noise * 0.28), 0.04, 0.56);
        const comp = clamp(c.snowCompress || 0, 0, 0.78);
        sum += Math.max(0.015, rawLift * (1.0 - comp));
        cnt++;
      }
    }
  }
  if (cnt === 0) return 0.02;
  const avg = sum / cnt;
  // Мягкий ступенчатый склон по краю сугроба (в духе LEGO)
  const edgeTaper = cnt === 4 ? 1.0 : (cnt === 3 ? 0.78 : (cnt === 2 ? 0.54 : 0.34));
  return 0.02 + avg * edgeTaper;
}

export function rebuildSurfacePrecipitationMeshes(cellsMap, cellSize) {
  ensureVisualBatches();

  resetBatch(_swvPuddleBatch);
  resetBatch(_swvLavaBatch);
  resetBatch(_swvSnowBatch);

  if (S.itemStudioOpen || !cellsMap || cellsMap.size === 0) {
    flushBatch(_swvPuddleBatch);
    flushBatch(_swvLavaBatch);
    flushBatch(_swvSnowBatch);
    return;
  }

  for (const cell of cellsMap.values()) {
    if (!cell.block || cell.block.isDisabled || cell.block._depletedDisabled) continue;

    // --- А. СЛИТНЫЕ СТИЛИЗОВАННЫЕ ЛУЖИ (Вода / Кровь / Кислота / Лёд / Лава) ---
    const hasPuddle = cell.liquidDepth > 0.012;
    const isLavaPuddle = hasPuddle && cell.liquidSubstance === 'lava';
    if (hasPuddle) {
      const nbN = getNeighborCell(cellsMap, cell.gx, cell.gz - 1, cell.baseY);
      const nbE = getNeighborCell(cellsMap, cell.gx + 1, cell.gz, cell.baseY);
      const nbS = getNeighborCell(cellsMap, cell.gx, cell.gz + 1, cell.baseY);
      const nbW = getNeighborCell(cellsMap, cell.gx - 1, cell.gz, cell.baseY);

      const matchLiq = nb => Boolean(nb && nb.liquidDepth > 0.012 && (nb.liquidSubstance === 'lava') === isLavaPuddle);
      const hasN = matchLiq(nbN);
      const hasE = matchLiq(nbE);
      const hasS = matchLiq(nbS);
      const hasW = matchLiq(nbW);
      const mask = (hasN ? 1 : 0) | (hasE ? 2 : 0) | (hasS ? 4 : 0) | (hasW ? 8 : 0);

      const lift = cell.baseY + clamp(0.016 + cell.liquidDepth * 0.09, 0.016, 0.048);
      if (computeClippedCellQuad(cell, cellSize, hasN, hasE, hasS, hasW, lift, lift, lift, lift, false)) {
        const uv = getAtlasTileUV(mask);
        const pal = swvSubstancePalette(cell.liquidSubstance, 'snow');
        _swvColor.set(pal.liquid);
        if (!isLavaPuddle && cell.frozenRatio > 0.05) {
          _swvIceColor.set(pal.ice);
          _swvColor.lerp(_swvIceColor, clamp(cell.frozenRatio, 0, 1));
        }

        const targetBatch = isLavaPuddle ? _swvLavaBatch : _swvPuddleBatch;
        // Полупрозрачная лёгкая жидкость (сквозь лужу просвечивают лего-пупырышки!)
        const baseAlpha = isLavaPuddle
          ? clamp(0.62 + cell.liquidDepth * 1.4, 0.58, 0.92)
          : cell.liquidSubstance === 'water'
            ? clamp(0.28 + cell.liquidDepth * 0.85 + cell.frozenRatio * 0.28, 0.26, 0.72)
            : clamp(0.36 + cell.liquidDepth * 0.95 + cell.frozenRatio * 0.22, 0.34, 0.68);

        pushQuadToBatch(
          targetBatch,
          _swvV0, _swvV1, _swvV2, _swvV3,
          _swvNorm,
          uv.u0, uv.v0, uv.u1, uv.v1,
          _swvColor.r, _swvColor.g, _swvColor.b,
          baseAlpha, baseAlpha, baseAlpha, baseAlpha
        );
      }
    }

    // --- Б. НАСТОЯЩИЕ ОБЪЁМНЫЕ 3D-СУГРОБЫ / ПЕПЕЛ / ОБСИДИАН / БАЗАЛЬТОВАЯ КОРКА ---
    const hasSnowDrift = cell.snowDepth > 0.03;
    const showCrust = !hasSnowDrift && cell.crustDepth > 0.02 && cell.liquidDepth <= 0.015;
    if (hasSnowDrift || showCrust) {
      const nbN = getNeighborCell(cellsMap, cell.gx, cell.gz - 1, cell.baseY);
      const nbE = getNeighborCell(cellsMap, cell.gx + 1, cell.gz, cell.baseY);
      const nbS = getNeighborCell(cellsMap, cell.gx, cell.gz + 1, cell.baseY);
      const nbW = getNeighborCell(cellsMap, cell.gx - 1, cell.gz, cell.baseY);

      const matchSol = nb => Boolean(nb && (hasSnowDrift ? nb.snowDepth > 0.03 : nb.crustDepth > 0.02));
      const hasN = matchSol(nbN);
      const hasE = matchSol(nbE);
      const hasS = matchSol(nbS);
      const hasW = matchSol(nbW);

      let y0, y1, y2, y3;
      if (hasSnowDrift) {
        y0 = cell.baseY + computeSnowCornerLift(cellsMap, cell.gx, cell.gz, -1, -1, cell.baseY);
        y1 = cell.baseY + computeSnowCornerLift(cellsMap, cell.gx, cell.gz, 1, -1, cell.baseY);
        y2 = cell.baseY + computeSnowCornerLift(cellsMap, cell.gx, cell.gz, 1, 1, cell.baseY);
        y3 = cell.baseY + computeSnowCornerLift(cellsMap, cell.gx, cell.gz, -1, 1, cell.baseY);
      } else {
        const cl = cell.baseY + clamp(0.03 + cell.crustDepth * 0.25, 0.03, 0.09);
        y0 = y1 = y2 = y3 = cl;
      }

      if (computeClippedCellQuad(cell, cellSize, hasN, hasE, hasS, hasW, y0, y1, y2, y3, true)) {
        if (showCrust) {
          _swvColor.copy(_swvCrustColor);
        } else {
          const pal = swvSubstancePalette(cell.snowSubstance, cell.solidType);
          _swvColor.set(pal.solid);
        }
        const cr = _swvColor.r;
        const cg = _swvColor.g;
        const cb = _swvColor.b;

        // Верхняя грань сугроба (сшивается без швов с соседями по общим углам)
        pushQuadToBatch(
          _swvSnowBatch,
          _swvV0, _swvV1, _swvV2, _swvV3,
          _swvNorm,
          0, 0, 1, 1,
          cr, cg, cb,
          1, 1, 1, 1
        );

        // Внешние 3D-стенки (юбка) — ставятся ТОЛЬКО по периметру объединённого сугроба!
        if (!hasN) pushVolumetricSideWall(_swvSnowBatch, _swvV1, _swvV0, _swvB0, _swvB1, cr, cg, cb);
        if (!hasE) pushVolumetricSideWall(_swvSnowBatch, _swvV2, _swvV1, _swvB1, _swvB2, cr, cg, cb);
        if (!hasS) pushVolumetricSideWall(_swvSnowBatch, _swvV3, _swvV2, _swvB2, _swvB3, cr, cg, cb);
        if (!hasW) pushVolumetricSideWall(_swvSnowBatch, _swvV0, _swvV3, _swvB3, _swvB0, cr, cg, cb);
      }
    }
  }

  flushBatch(_swvPuddleBatch);
  flushBatch(_swvLavaBatch);
  flushBatch(_swvSnowBatch);
}

/* ---------- 5. ПОСТЕПЕННОЕ ПОКРЫТИЕ БЛОКОВ С МЯГКИМИ КРАЯМИ ПОД КРЫШАМИ ---------- */

function applyBlockWetRoughness(box, wetAmt) {
  if (!box || !box.m || !box.m.material) return;
  if (box.surfaceType === 'glass' || box.surfaceType === 'neon') return;

  const mats = Array.isArray(box.m.material) ? [box.m.material[2]] : [box.m.material];
  for (let i = 0; i < mats.length; i++) {
    const mat = mats[i];
    if (!mat || mat.roughness === undefined) continue;
    if (mat.userData._swvOrigRoughness === undefined) {
      mat.userData._swvOrigRoughness = mat.roughness;
    }
    const baseR = mat.userData._swvOrigRoughness;
    const targetR = baseR * (1 - wetAmt * 0.82) + 0.06 * (wetAmt * 0.82);
    if (Math.abs(mat.roughness - targetR) > 0.015) {
      mat.roughness = targetR;
    }
  }
}

function restoreAllBlockRoughness() {
  const blocks = S.allBlocks || [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || !b.m || !b.m.material) continue;
    const mats = Array.isArray(b.m.material) ? b.m.material : [b.m.material];
    for (let k = 0; k < mats.length; k++) {
      const m = mats[k];
      if (m && m.userData && m.userData._swvOrigRoughness !== undefined) {
        m.roughness = m.userData._swvOrigRoughness;
        delete m.userData._swvOrigRoughness;
      }
    }
  }
}

// Усредняет степень покрытия в узле сетки (cornerX, cornerZ) по 4 примыкающим секциям -> мягкая граница под крышей!
function sampleSmoothCornerCoat(blockId, cornerIx, cornerIz, segX, segZ, field) {
  let sum = 0;
  let cnt = 0;
  for (let dx = -1; dx <= 0; dx++) {
    const cx = cornerIx + dx;
    if (cx < 0 || cx >= segX) continue;
    for (let dz = -1; dz <= 0; dz++) {
      const cz = cornerIz + dz;
      if (cz < 0 || cz >= segZ) continue;
      const st = _swvBlockCoats.get(`${blockId}_${cx}_${cz}`);
      sum += st ? (st[field] || 0) : 0;
      cnt++;
    }
  }
  return cnt > 0 ? (sum / cnt) : 0;
}

export function updateBlockSurfaceCoatings(stepDt, substance, phase, intensity, effTemp, anchorPos) {
  ensureVisualBatches();
  resetBatch(_swvCoatWetBatch);
  resetBatch(_swvCoatSnowBatch);

  if (S.itemStudioOpen || S.state === 'menu') {
    flushBatch(_swvCoatWetBatch);
    flushBatch(_swvCoatSnowBatch);
    return;
  }

  const ws = S.worldSettings?.weatherSettings;
  const allowAccum = ws?.accumulateSurface !== false;
  const pInfo = WEATHER_PHASES[phase] || WEATHER_PHASES.none;
  const activeR = 40;
  const meltRates = { freezing: 0, cold: 0, cool: 0.018, normal: 0.042, warm: 0.085, hot: 0.16, hell: 0.34 };
  const dryRates = { freezing: 0.004, cold: 0.008, cool: 0.014, normal: 0.025, warm: 0.048, hot: 0.095, hell: 0.22 };
  const meltRate = meltRates[effTemp] ?? 0.04;
  const dryRate = dryRates[effTemp] ?? 0.025;

  const blocks = S.allBlocks;
  const activeKeys = new Set();

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || b.isDisabled || b._depletedDisabled || b._isCarriedByPlayer || !b.m) continue;
    if (b.matterState !== 'solid') continue;
    if (b.logicRuntime && b.logicRuntime.ghostOpen) continue;
    if (b.components && (!b.components.physics?.enabled || !b.components.geometry?.enabled)) continue;
    const shp = b.shape || 'box';
    if (shp !== 'box' && shp !== 'plane' && shp !== 'wedge') continue;

    const dxB = Math.max(b.x0 - anchorPos.x, 0, anchorPos.x - b.x1);
    const dzB = Math.max(b.z0 - anchorPos.z, 0, anchorPos.z - b.z1);
    if (dxB * dxB + dzB * dzB > activeR * activeR) continue;

    // Мелкая стабильная сетка 2.2м в локальных координатах блока (без растягивания на гигантских плитах)
    const segX = Math.max(1, Math.ceil(b.w / SWV_COAT_STEP));
    const segZ = Math.max(1, Math.ceil(b.d / SWV_COAT_STEP));
    const stepLX = (b.hx * 2) / segX;
    const stepLZ = (b.hz * 2) / segZ;

    // Ограничиваем цикл только видимой областью вокруг игрока/камеры
    let ixMin = 0, ixMax = segX - 1;
    let izMin = 0, izMax = segZ - 1;
    if (!b.isRotated && (segX > 12 || segZ > 12)) {
      const locAncX = anchorPos.x - b.m.position.x + b.hx;
      const locAncZ = anchorPos.z - b.m.position.z + b.hz;
      ixMin = clamp(Math.floor((locAncX - activeR) / stepLX), 0, segX - 1);
      ixMax = clamp(Math.ceil((locAncX + activeR) / stepLX), 0, segX - 1);
      izMin = clamp(Math.floor((locAncZ - activeR) / stepLZ), 0, segZ - 1);
      izMax = clamp(Math.ceil((locAncZ + activeR) / stepLZ), 0, segZ - 1);
    }

    let maxWetOnBlock = 0;

    // Проход 1: обновление состояния wet/snow каждой секции
    for (let iz = izMin; iz <= izMax; iz++) {
      const lz0 = -b.hz + iz * stepLZ;
      const lcz = lz0 + stepLZ * 0.5;
      for (let ix = ixMin; ix <= ixMax; ix++) {
        const lx0 = -b.hx + ix * stepLX;
        const lcx = lx0 + stepLX * 0.5;

        if (!b.isRotated) {
          _swvTmp.set(b.m.position.x + lcx, b.y1, b.m.position.z + lcz);
        } else {
          _swvTmp.set(lcx, b.hy, lcz).applyQuaternion(b.m.quaternion).add(b.m.position);
        }

        const sdx = _swvTmp.x - anchorPos.x;
        const sdz = _swvTmp.z - anchorPos.z;
        if (sdx * sdx + sdz * sdz > activeR * activeR) continue;

        const key = `${b.id}_${ix}_${iz}`;
        let st = _swvBlockCoats.get(key);
        const exposed = allowAccum && substance !== 'none' && phase !== 'none'
          ? isPointExposedToSky(_swvTmp.x, _swvTmp.y + 0.12, _swvTmp.z)
          : false;

        if (!st && !exposed) continue;
        if (!st) {
          st = { wet: 0, wetType: 'water', snow: 0, snowType: 'snow', frost: 0 };
          _swvBlockCoats.set(key, st);
        }

        if (exposed) {
          const rate = intensity * stepDt;
          if (phase === 'lava_rain') {
            if (st.snow > 0) st.snow = Math.max(0, st.snow - 0.22 * rate);
            if (st.wetType !== 'lava' && st.wet > 0) {
              st.wet = Math.max(0, st.wet - 0.25 * rate);
            } else {
              st.wetType = 'lava';
              st.wet = clamp(st.wet + 0.055 * rate, 0, 0.7);
            }
          } else if (phase === 'ash' || phase === 'obsidian_hail') {
            st.snowType = phase === 'ash' ? 'ash' : 'obsidian';
            st.snow = clamp(st.snow + 0.045 * rate, 0, 0.85);
          } else if (pInfo.kind === 'snow') {
            st.snowType = substance === 'blood' ? 'blood_snow' : (substance === 'acid' ? 'acid_snow' : 'snow');
            st.snow = clamp(st.snow + 0.055 * rate, 0, 1.0);
          } else if (pInfo.isHail) {
            st.snowType = substance === 'blood' ? 'blood_snow' : (substance === 'acid' ? 'acid_snow' : 'snow');
            st.snow = clamp(st.snow + 0.036 * rate, 0, 0.78);
            st.wetType = substance;
            st.wet = clamp(st.wet + 0.048 * rate, 0, 0.95);
          } else if (pInfo.kind === 'rain') {
            if (st.snow > 0) st.snow = Math.max(0, st.snow - 0.06 * rate);
            st.wetType = substance;
            st.wet = clamp(st.wet + 0.064 * rate, 0, 1.0);
          } else if (pInfo.kind === 'mist') {
            st.wetType = substance;
            st.wet = clamp(st.wet + 0.025 * rate, 0, 0.5);
          }
        }

        if (st.snow > 0) {
          if (st.snowType === 'ash' || st.snowType === 'obsidian') {
            if (!exposed || phase !== 'ash') st.snow = Math.max(0, st.snow - 0.012 * stepDt);
          } else if (meltRate > 0) {
            const m = Math.min(st.snow, meltRate * stepDt);
            st.snow -= m;
            st.wetType = st.snowType === 'blood_snow' ? 'blood' : (st.snowType === 'acid_snow' ? 'acid' : 'water');
            st.wet = clamp(st.wet + m * 0.75, 0, 1.0);
          }
        }

        if (st.wet > 0) {
          if (effTemp === 'freezing' && st.wetType !== 'lava') {
            st.frost = clamp(st.frost + 0.09 * stepDt, 0, 1.0);
          } else {
            st.frost = Math.max(0, st.frost - 0.14 * stepDt);
            if (!exposed || pInfo.kind === 'evaporate') {
              st.wet = Math.max(0, st.wet - dryRate * stepDt);
            }
          }
        }

        if (st.wet <= 0.008 && st.snow <= 0.008) {
          _swvBlockCoats.delete(key);
        } else {
          activeKeys.add(key);
          if (st.wet > maxWetOnBlock) maxWetOnBlock = st.wet;
        }
      }
    }

    // Проход 2: генерация квадов с ПЛАВНОЙ вершиннной интерполяцией между открытыми и перекрытыми зонами!
    for (let iz = izMin; iz <= izMax; iz++) {
      const lz0 = -b.hz + iz * stepLZ;
      const lz1 = lz0 + stepLZ;
      for (let ix = ixMin; ix <= ixMax; ix++) {
        const lx0 = -b.hx + ix * stepLX;
        const lx1 = lx0 + stepLX;

        const w0 = sampleSmoothCornerCoat(b.id, ix, iz, segX, segZ, 'wet');
        const w1 = sampleSmoothCornerCoat(b.id, ix + 1, iz, segX, segZ, 'wet');
        const w2 = sampleSmoothCornerCoat(b.id, ix + 1, iz + 1, segX, segZ, 'wet');
        const w3 = sampleSmoothCornerCoat(b.id, ix, iz + 1, segX, segZ, 'wet');

        const s0 = sampleSmoothCornerCoat(b.id, ix, iz, segX, segZ, 'snow');
        const s1 = sampleSmoothCornerCoat(b.id, ix + 1, iz, segX, segZ, 'snow');
        const s2 = sampleSmoothCornerCoat(b.id, ix + 1, iz + 1, segX, segZ, 'snow');
        const s3 = sampleSmoothCornerCoat(b.id, ix, iz + 1, segX, segZ, 'snow');

        const maxW = Math.max(w0, w1, w2, w3);
        const maxS = Math.max(s0, s1, s2, s3);
        if (maxW <= 0.015 && maxS <= 0.015) continue;

        // Определяем тип вещества по самой ячейке или ближайшему мокрому соседу (для мягкого шлейфа под крышей)
        const refSt =
          _swvBlockCoats.get(`${b.id}_${ix}_${iz}`) ||
          _swvBlockCoats.get(`${b.id}_${ix - 1}_${iz}`) ||
          _swvBlockCoats.get(`${b.id}_${ix + 1}_${iz}`) ||
          _swvBlockCoats.get(`${b.id}_${ix}_${iz - 1}`) ||
          _swvBlockCoats.get(`${b.id}_${ix}_${iz + 1}`);

        const liftY = 0.008;
        if (!b.isRotated) {
          const wx0 = b.m.position.x + lx0;
          const wx1 = b.m.position.x + lx1;
          const wz0 = b.m.position.z + lz0;
          const wz1 = b.m.position.z + lz1;
          if (shp === 'wedge') {
            const yLeft = b.m.position.y + b.hy + liftY;
            const yRight = b.m.position.y - b.hy + liftY;
            const yL = yLeft + (yRight - yLeft) * ((lx0 + b.hx) / (b.hx * 2));
            const yR = yLeft + (yRight - yLeft) * ((lx1 + b.hx) / (b.hx * 2));
            _swvV0.set(wx0, yL, wz0);
            _swvV1.set(wx1, yR, wz0);
            _swvV2.set(wx1, yR, wz1);
            _swvV3.set(wx0, yL, wz1);
            _swvNorm.set(b.hy, b.hx, 0).normalize();
          } else {
            const wy = b.y1 + liftY;
            _swvV0.set(wx0, wy, wz0);
            _swvV1.set(wx1, wy, wz0);
            _swvV2.set(wx1, wy, wz1);
            _swvV3.set(wx0, wy, wz1);
            _swvNorm.set(0, 1, 0);
          }
        } else {
          const cornersL = [
            [lx0, lz0, _swvV0],
            [lx1, lz0, _swvV1],
            [lx1, lz1, _swvV2],
            [lx0, lz1, _swvV3]
          ];
          for (let c = 0; c < 4; c++) {
            const [cx, cz, outV] = cornersL[c];
            const cy = shp === 'wedge'
              ? (b.hy * (1 - 2 * ((cx + b.hx) / (b.hx * 2))) + liftY)
              : (b.hy + liftY);
            outV.set(cx, cy, cz).applyQuaternion(b.m.quaternion).add(b.m.position);
          }
          _swvNorm.copy(b.axisY);
        }

        if (maxW > 0.015) {
          const wt = refSt?.wetType || 'water';
          const pal = swvSubstancePalette(wt, 'snow');
          const wCol = (refSt?.frost || 0) > 0.35 && wt !== 'lava' ? pal.ice : pal.wetCoat;
          _swvColor.set(wCol);
          pushQuadToBatch(
            _swvCoatWetBatch,
            _swvV0, _swvV1, _swvV2, _swvV3,
            _swvNorm,
            0, 0, 1, 1,
            _swvColor.r, _swvColor.g, _swvColor.b,
            w0, w1, w2, w3
          );
        }

        if (maxS > 0.015) {
          _swvV0.y += 0.005; _swvV1.y += 0.005; _swvV2.y += 0.005; _swvV3.y += 0.005;
          const stType = refSt?.snowType || 'snow';
          const sCol = stType === 'blood_snow' ? '#f5b5b5'
            : stType === 'acid_snow' ? '#a7f3c2'
            : stType === 'ash' ? '#676c78'
            : stType === 'obsidian' ? '#2b265e'
            : '#f1f6fc';
          _swvColor.set(sCol);
          pushQuadToBatch(
            _swvCoatSnowBatch,
            _swvV0, _swvV1, _swvV2, _swvV3,
            _swvNorm,
            0, 0, 1, 1,
            _swvColor.r, _swvColor.g, _swvColor.b,
            s0, s1, s2, s3
          );
        }
      }
    }

    applyBlockWetRoughness(b, maxWetOnBlock);
  }

  if (_swvBlockCoats.size > activeKeys.size + 180) {
    for (const k of _swvBlockCoats.keys()) {
      if (!activeKeys.has(k)) _swvBlockCoats.delete(k);
    }
  }

  flushBatch(_swvCoatWetBatch);
  flushBatch(_swvCoatSnowBatch);
}

/**
 * Проверяет толщину тонкого снежного покрытия на блоке в точке (wx, wy, wz).
 */
export function sampleBlockSnowCoatAt(wx, wy, wz, supportBlock = null) {
  if (_swvBlockCoats.size === 0) return null;
  const checkBlock = b => {
    if (!b || b.isDisabled || b._depletedDisabled || b.matterState !== 'solid' || !b.m) return null;
    if (wx < b.x0 - 0.1 || wx > b.x1 + 0.1 || wz < b.z0 - 0.1 || wz > b.z1 + 0.1) return null;
    if (Math.abs(wy - b.y1) > 0.65) return null;

    const segX = Math.max(1, Math.ceil(b.w / SWV_COAT_STEP));
    const segZ = Math.max(1, Math.ceil(b.d / SWV_COAT_STEP));
    const stepLX = (b.hx * 2) / segX;
    const stepLZ = (b.hz * 2) / segZ;

    let lx, lz;
    if (!b.isRotated) {
      lx = wx - b.m.position.x + b.hx;
      lz = wz - b.m.position.z + b.hz;
    } else {
      _swvTmp.set(wx - b.m.position.x, 0, wz - b.m.position.z).applyQuaternion(b.invQuat);
      lx = _swvTmp.x + b.hx;
      lz = _swvTmp.z + b.hz;
    }
    const ix = clamp(Math.floor(lx / stepLX), 0, segX - 1);
    const iz = clamp(Math.floor(lz / stepLZ), 0, segZ - 1);
    const st = _swvBlockCoats.get(`${b.id}_${ix}_${iz}`);
    if (!st || (st.snow || 0) < 0.12) return null;
    return { snow: st.snow, snowType: st.snowType || 'snow', block: b, surfaceY: b.y1 };
  };

  if (supportBlock) {
    const res = checkBlock(supportBlock);
    if (res) return res;
  }
  const blocks = S.allBlocks || [];
  for (let i = 0; i < blocks.length; i++) {
    const res = checkBlock(blocks[i]);
    if (res) return res;
  }
  return null;
}

export function rebuildSnowFootprintsMesh() {
  ensureVisualBatches();
  resetBatch(_swvFootprintBatch);

  if (S.itemStudioOpen || _swvFootprints.length === 0) {
    flushBatch(_swvFootprintBatch);
    return;
  }

  _swvNorm.set(0, 1, 0);
  for (let i = 0; i < _swvFootprints.length; i++) {
    const fp = _swvFootprints[i];
    if (!fp || fp.alpha <= 0.02) continue;
    if (fp.block && (fp.block.isDisabled || fp.block._depletedDisabled)) continue;

    const sinY = Math.sin(fp.yaw);
    const cosY = Math.cos(fp.yaw);
    const fx = sinY * fp.halfL;
    const fz = cosY * fp.halfL;
    const rx = cosY * fp.halfW;
    const rz = -sinY * fp.halfW;

    const cx = fp.x;
    const cy = fp.y;
    const cz = fp.z;

    _swvV0.set(cx - rx - fx, cy, cz - rz - fz);
    _swvV1.set(cx + rx - fx, cy, cz + rz - fz);
    _swvV2.set(cx + rx + fx, cy, cz + rz + fz);
    _swvV3.set(cx - rx + fx, cy, cz - rz + fz);

    _swvColor.set(fp.color || '#f1f6fc');
    pushQuadToBatch(
      _swvFootprintBatch,
      _swvV0, _swvV1, _swvV2, _swvV3,
      _swvNorm,
      0, 0, 1, 1,
      _swvColor.r, _swvColor.g, _swvColor.b,
      fp.alpha, fp.alpha, fp.alpha, fp.alpha
    );
  }

  flushBatch(_swvFootprintBatch);
}

export function addSnowFootprintStamp({ x, y, z, yaw = 0, halfW = 0.26, halfL = 0.26, color = '#f1f6fc', alpha = 0.88, block = null, cellKey = null }) {
  ensureVisualBatches();
  if (_swvFootprints.length >= SWV_MAX_FOOTPRINTS) {
    _swvFootprints.shift();
  }
  _swvFootprints.push({
    x,
    y,
    z,
    yaw,
    halfW: clamp(Number(halfW) || 0.26, 0.12, 1.8),
    halfL: clamp(Number(halfL) || 0.26, 0.12, 1.8),
    color,
    alpha: clamp(alpha, 0.25, 0.92),
    age: 0,
    maxAge: 42,
    block,
    cellKey
  });
  rebuildSnowFootprintsMesh();
}

export function updateSnowFootprints(stepDt, substance, phase, intensity, effTemp, cellsMap) {
  if (_swvFootprints.length === 0) return;

  const pInfo = WEATHER_PHASES[phase] || WEATHER_PHASES.none;
  const isSnowing = substance !== 'none' && (pInfo.kind === 'snow' || pInfo.isHail);
  const meltRates = { freezing: 0, cold: 0, cool: 0.03, normal: 0.08, warm: 0.16, hot: 0.32, hell: 0.6 };
  const meltFade = meltRates[effTemp] ?? 0.05;

  for (let i = _swvFootprints.length - 1; i >= 0; i--) {
    const fp = _swvFootprints[i];
    fp.age += stepDt;

    if (fp.cellKey && cellsMap) {
      const c = cellsMap.get(fp.cellKey);
      if (c && c.snowDepth > 0.03) {
        const rawLift = clamp(c.snowDepth * (0.58 + c.noise * 0.28), 0.04, 0.56);
        const comp = clamp(c.snowCompress || 0, 0, 0.78);
        fp.y = c.baseY + Math.max(0.015, rawLift * (1.0 - comp)) + 0.018;
      } else {
        fp.alpha -= stepDt * 0.45;
      }
    }

    const snowFillFade = isSnowing ? (0.042 * intensity * stepDt) : 0;
    const ageFade = fp.age > fp.maxAge * 0.72 ? (stepDt * 0.12) : 0;
    fp.alpha -= (snowFillFade + meltFade * stepDt + ageFade);

    if (fp.alpha <= 0.02 || fp.age >= fp.maxAge || (fp.block && (fp.block.isDisabled || fp.block._depletedDisabled))) {
      _swvFootprints.splice(i, 1);
    }
  }

  rebuildSnowFootprintsMesh();
}

export function clearSurfaceWeatherVisuals() {
  _swvBlockCoats.clear();
  _swvFootprints.length = 0;
  restoreAllBlockRoughness();
  if (!_swvInited) return;
  for (const batch of [_swvPuddleBatch, _swvLavaBatch, _swvSnowBatch, _swvCoatWetBatch, _swvCoatSnowBatch, _swvFootprintBatch]) {
    if (batch) {
      batch.quadCount = 0;
      batch.geo.setDrawRange(0, 0);
      batch.mesh.visible = false;
    }
  }
}