// src/core/SceneManager.js
import { $, coarse, S } from './State.js';

export const cv = $('c');
export const renderer = new THREE.WebGLRenderer({
  canvas: cv,
  antialias: !coarse,
  powerPreference: 'high-performance'
});
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;

export const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x88ccff, 0.0038);

export const camera = new THREE.PerspectiveCamera(65, 1, 0.1, 700);

export function resize() {
  S.SW = innerWidth;
  S.SH = innerHeight;
  renderer.setSize(S.SW, S.SH);
  camera.aspect = S.SW / S.SH;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

export const hemi = new THREE.HemisphereLight(0xffffff, 0x5588bb, 0.9);
scene.add(hemi);

export const sun = new THREE.DirectionalLight(0xfff6dd, 1.25);
sun.position.set(45, 85, 35);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
{
  const sc = sun.shadow.camera;
  sc.left = -90;
  sc.right = 90;
  sc.top = 90;
  sc.bottom = -90;
  sc.near = 5;
  sc.far = 250;
}
sun.shadow.bias = -0.0005;
scene.add(sun);

/* ---------- Gradient Skybox System ---------- */
const skyCanvas = document.createElement('canvas');
skyCanvas.width = 64;
skyCanvas.height = 256;
const skyCtx = skyCanvas.getContext('2d');
const skyTex = new THREE.CanvasTexture(skyCanvas);
const skyGeo = new THREE.SphereGeometry(500, 32, 24);
const skyMat = new THREE.MeshBasicMaterial({
  map: skyTex,
  side: THREE.BackSide,
  depthWrite: false,
  fog: false
});
export const skyDome = new THREE.Mesh(skyGeo, skyMat);
skyDome.renderOrder = -2;
scene.add(skyDome);

/* ---------- Atmospheric Weather Skybox Overlay ---------- */
const atmoSkyCanvas = document.createElement('canvas');
atmoSkyCanvas.width = 64;
atmoSkyCanvas.height = 256;
const atmoSkyCtx = atmoSkyCanvas.getContext('2d');
const atmoSkyTex = new THREE.CanvasTexture(atmoSkyCanvas);
const atmoSkyGeo = new THREE.SphereGeometry(492, 32, 24);
const atmoSkyMat = new THREE.MeshBasicMaterial({
  map: atmoSkyTex,
  side: THREE.BackSide,
  transparent: true,
  opacity: 0,
  depthWrite: false,
  fog: false
});
export const atmoSkyDome = new THREE.Mesh(atmoSkyGeo, atmoSkyMat);
atmoSkyDome.renderOrder = -1;
atmoSkyDome.visible = false;
atmoSkyDome.frustumCulled = false;
atmoSkyDome.userData.noCollider = true;
skyDome.add(atmoSkyDome);

let atmoSkyPaletteSig = '';
let _atmoSkyMidHex = '#475569';
let _atmoSkyBotHex = '#64748b';
let _atmoSkyOpacity = 0;

const _skyBaseMidTmp = new THREE.Color();
const _skyBaseBotTmp = new THREE.Color();
const _skyAtmoMidTmp = new THREE.Color();
const _skyAtmoBotTmp = new THREE.Color();

export function setAtmosphericSkybox(topHex, midHex, botHex, opacity = 0) {
  const op = Math.max(0, Math.min(1, Number(opacity) || 0));
  _atmoSkyOpacity = op;
  if (midHex) _atmoSkyMidHex = midHex;
  if (botHex) _atmoSkyBotHex = botHex;

  if (op <= 0.004) {
    atmoSkyMat.opacity = 0;
    atmoSkyDome.visible = false;
    return;
  }

  const sig = `${topHex}|${midHex}|${botHex}`;
  if (sig !== atmoSkyPaletteSig) {
    atmoSkyPaletteSig = sig;
    const grad = atmoSkyCtx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0.0, topHex || '#1f2937');
    grad.addColorStop(0.52, midHex || '#475569');
    grad.addColorStop(1.0, botHex || '#64748b');
    atmoSkyCtx.fillStyle = grad;
    atmoSkyCtx.fillRect(0, 0, 64, 256);
    atmoSkyTex.needsUpdate = true;
  }

  atmoSkyMat.opacity = op;
  atmoSkyDome.visible = true;
}

/**
 * Возвращает итоговый цвет отражения неба (основной скайбокс + атмосферный слой погоды).
 */
export function getEffectiveSkyColors(outMid = new THREE.Color(), outHorizon = new THREE.Color()) {
  const ws = S.worldSettings || {};
  _skyBaseMidTmp.set(ws.skyMid || '#62b6ff');
  _skyBaseBotTmp.set(ws.skyBot || '#dff4ff');

  outMid.copy(_skyBaseMidTmp);
  outHorizon.copy(_skyBaseMidTmp).lerp(_skyBaseBotTmp, 0.65);

  if (_atmoSkyOpacity > 0.004) {
    _skyAtmoMidTmp.set(_atmoSkyMidHex || '#475569');
    _skyAtmoBotTmp.set(_atmoSkyBotHex || '#64748b');
    outMid.lerp(_skyAtmoMidTmp, _atmoSkyOpacity);
    _skyAtmoMidTmp.lerp(_skyAtmoBotTmp, 0.55);
    outHorizon.lerp(_skyAtmoMidTmp, _atmoSkyOpacity);
  }
  return outMid;
}

export function getEffectiveSkyColor(outColor = new THREE.Color()) {
  return getEffectiveSkyColors(outColor, _skyBaseBotTmp);
}

export const celestialGroup = new THREE.Group();
skyDome.add(celestialGroup);

let sunShellMesh = null;
let sunShellSignature = '';
let moonShellMesh = null;
let moonShellSignature = '';
let customBodiesGroup = new THREE.Group();
celestialGroup.add(customBodiesGroup);
let customBodiesSignature = '';

function buildCelestialShapeGeo(shape = 'sphere', size = 12) {
  const r = Math.max(0.5, Number(size) || 12);
  if (shape === 'box') return new THREE.BoxGeometry(r * 1.4, r * 1.4, r * 1.4);
  if (shape === 'octahedron' || shape === 'star') return new THREE.OctahedronGeometry(r, 0);
  if (shape === 'cylinder') return new THREE.CylinderGeometry(r, r, r * 1.4, 20);
  if (shape === 'torus') return new THREE.TorusGeometry(r, r * 0.28, 12, 32);
  return new THREE.SphereGeometry(r, 24, 18);
}

function disposeObject3D(obj) {
  if (!obj) return;
  obj.traverse(ch => {
    if (ch.geometry) ch.geometry.dispose();
    if (ch.material) {
      if (Array.isArray(ch.material)) ch.material.forEach(m => m.dispose());
      else ch.material.dispose();
    }
  });
}

export function syncSunAndCelestialBodies() {
  const ws = S.worldSettings;
  if (!ws.sunSettings) {
    ws.sunSettings = {
      enabled: true,
      color: '#fff6dd',
      intensity: 1.25,
      hemiIntensity: 0.9,
      x: 45,
      y: 85,
      z: 35,
      shellShape: 'sphere',
      shellSize: 14,
      shellColor: '#ffea79',
      shellGlow: true
    };
  }
  const ss = ws.sunSettings;

  // 1. Обновляем глобальный источник света (DirectionalLight + HemisphereLight)
  const sunEnabled = ss.enabled !== false;
  sun.visible = sunEnabled;
  sun.color.set(ss.color || '#fff6dd');
  sun.intensity = !sunEnabled ? 0 : (Number(ss.intensity) ?? 1.25);
  sun.position.set(Number(ss.x) ?? 45, Number(ss.y) ?? 85, Number(ss.z) ?? 35);
  hemi.intensity = Number(ss.hemiIntensity) ?? 0.9;
  if (ss.hemiSkyColor) hemi.color.set(ss.hemiSkyColor);
  if (ss.hemiGroundColor) hemi.groundColor.set(ss.hemiGroundColor);

  // 2. Физическая 3D-оболочка Солнца (без пересоздания геометрии каждый кадр)
  const wantSunShell = sunEnabled && ss.shellShape && ss.shellShape !== 'none';
  const nextSunSig = wantSunShell
    ? `${ss.shellShape}|${Number(ss.shellSize) || 14}|${ss.shellGlow !== false}`
    : 'none';

  if (nextSunSig !== sunShellSignature) {
    if (sunShellMesh) {
      celestialGroup.remove(sunShellMesh);
      disposeObject3D(sunShellMesh);
      sunShellMesh = null;
    }
    sunShellSignature = nextSunSig;
    if (wantSunShell) {
      const sGeo = buildCelestialShapeGeo(ss.shellShape, Number(ss.shellSize) || 14);
      const sMat = ss.shellGlow !== false
        ? new THREE.MeshBasicMaterial({ color: ss.shellColor || ss.color || '#ffea79', fog: false })
        : new THREE.MeshStandardMaterial({ color: ss.shellColor || ss.color || '#ffea79', roughness: 0.4, metalness: 0.1, fog: false });
      sunShellMesh = new THREE.Mesh(sGeo, sMat);
      sunShellMesh.userData.noCollider = true;
      celestialGroup.add(sunShellMesh);
    }
  }

  if (sunShellMesh && wantSunShell) {
    sunShellMesh.visible = true;
    if (sunShellMesh.material && sunShellMesh.material.color) {
      sunShellMesh.material.color.set(ss.shellColor || ss.color || '#ffea79');
    }
    const dir = new THREE.Vector3(Number(ss.x) ?? 45, Number(ss.y) ?? 85, Number(ss.z) ?? 35);
    if (dir.lengthSq() < 0.001) dir.set(45, 85, 35);
    dir.normalize().multiplyScalar(380);
    sunShellMesh.position.copy(dir);
  } else if (sunShellMesh) {
    sunShellMesh.visible = false;
  }

  // 3. Встроенная 3D-оболочка Луны (управляется скриптами смены суток или настройками мира)
  const ms = ws.moonSettings;
  const wantMoon = Boolean(ms && ms.enabled);
  const nextMoonSig = wantMoon
    ? `${ms.shape || 'sphere'}|${Number(ms.size) || 13}|${ms.glow !== false}`
    : 'none';

  if (nextMoonSig !== moonShellSignature) {
    if (moonShellMesh) {
      celestialGroup.remove(moonShellMesh);
      disposeObject3D(moonShellMesh);
      moonShellMesh = null;
    }
    moonShellSignature = nextMoonSig;
    if (wantMoon) {
      const mGeo = buildCelestialShapeGeo(ms.shape || 'sphere', Number(ms.size) || 13);
      const mMat = ms.glow !== false
        ? new THREE.MeshBasicMaterial({ color: ms.color || '#dbeafe', fog: false })
        : new THREE.MeshStandardMaterial({ color: ms.color || '#dbeafe', roughness: 0.5, metalness: 0.1, fog: false });
      moonShellMesh = new THREE.Mesh(mGeo, mMat);
      moonShellMesh.userData.noCollider = true;
      celestialGroup.add(moonShellMesh);
    }
  }

  if (moonShellMesh && wantMoon) {
    moonShellMesh.visible = true;
    if (moonShellMesh.material && moonShellMesh.material.color) {
      moonShellMesh.material.color.set(ms.color || '#dbeafe');
    }
    const mDir = new THREE.Vector3(Number(ms.x) ?? -45, Number(ms.y) ?? 75, Number(ms.z) ?? -35);
    if (mDir.lengthSq() < 0.001) mDir.set(-45, 75, -35);
    mDir.normalize().multiplyScalar(375);
    moonShellMesh.position.copy(mDir);
  } else if (moonShellMesh) {
    moonShellMesh.visible = false;
  }

  // 4. Дополнительные небесные тела (планеты, звёзды, спутники)
  const bodiesArr = Array.isArray(ws.celestialBodies) ? ws.celestialBodies : [];
  const nextBodiesSig = JSON.stringify(bodiesArr);
  if (nextBodiesSig !== customBodiesSignature) {
    customBodiesSignature = nextBodiesSig;
    while (customBodiesGroup.children.length > 0) {
      const ch = customBodiesGroup.children[0];
      customBodiesGroup.remove(ch);
      disposeObject3D(ch);
    }

    for (let i = 0; i < bodiesArr.length; i++) {
      const cb = bodiesArr[i];
      if (!cb || cb.enabled === false) continue;
      const sz = Math.max(1, Number(cb.size) || 16);
      const geo = buildCelestialShapeGeo(cb.shape || 'sphere', sz);
      const isGlow = cb.glow !== false;
      const mat = isGlow
        ? new THREE.MeshBasicMaterial({ color: cb.color || '#ffffff', fog: false })
        : new THREE.MeshStandardMaterial({
            color: cb.color || '#70a1ff',
            roughness: 0.65,
            metalness: 0.1,
            fog: false
          });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.set(Number(cb.x) || -120, Number(cb.y) ?? 180, Number(cb.z) || -160);
      mesh.rotation.set(
        THREE.MathUtils.degToRad(Number(cb.rx) || 0),
        THREE.MathUtils.degToRad(Number(cb.ry) || 0),
        THREE.MathUtils.degToRad(Number(cb.rz) || 0)
      );
      mesh.userData.noCollider = true;

      if (cb.hasRing) {
        const ringGeo = new THREE.RingGeometry(sz * 1.35, sz * 2.15, 32);
        const ringMat = new THREE.MeshBasicMaterial({
          color: cb.ringColor || '#ffce3a',
          side: THREE.DoubleSide,
          transparent: true,
          opacity: 0.78,
          fog: false
        });
        const ringMesh = new THREE.Mesh(ringGeo, ringMat);
        ringMesh.rotation.x = Math.PI / 2.3;
        ringMesh.userData.noCollider = true;
        mesh.add(ringMesh);
      }

      customBodiesGroup.add(mesh);
    }
  }
}

export function updateSkybox(syncNetwork = true) {
  const ws = S.worldSettings;
  const grad = skyCtx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, ws.skyTop || '#1565c0');
  grad.addColorStop(0.52, ws.skyMid || '#62b6ff');
  grad.addColorStop(1.0, ws.skyBot || '#dff4ff');
  skyCtx.fillStyle = grad;
  skyCtx.fillRect(0, 0, 64, 256);
  skyTex.needsUpdate = true;
  scene.fog.color.set(ws.fogColor || '#88ccff');
  scene.fog.density = ws.fogDensity ?? 0.0038;

  syncSunAndCelestialBodies();

  if (syncNetwork && window.__debixSyncWorldSettings && !S.isApplyingRemoteSync) {
    window.__debixSyncWorldSettings(true);
  }
}
updateSkybox();