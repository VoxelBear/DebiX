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
scene.add(skyDome);

export const celestialGroup = new THREE.Group();
skyDome.add(celestialGroup);

let sunShellMesh = null;

function buildCelestialShapeGeo(shape = 'sphere', size = 12) {
  const r = Math.max(0.5, Number(size) || 12);
  if (shape === 'box') return new THREE.BoxGeometry(r * 1.4, r * 1.4, r * 1.4);
  if (shape === 'octahedron' || shape === 'star') return new THREE.OctahedronGeometry(r, 0);
  if (shape === 'cylinder') return new THREE.CylinderGeometry(r, r, r * 1.4, 20);
  if (shape === 'torus') return new THREE.TorusGeometry(r, r * 0.28, 12, 32);
  return new THREE.SphereGeometry(r, 24, 18);
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
  sun.visible = ss.enabled !== false;
  sun.color.set(ss.color || '#fff6dd');
  sun.intensity = ss.enabled === false ? 0 : (Number(ss.intensity) ?? 1.25);
  sun.position.set(Number(ss.x) ?? 45, Number(ss.y) ?? 85, Number(ss.z) ?? 35);
  hemi.intensity = Number(ss.hemiIntensity) ?? 0.9;

  // 2. Пересобираем небесные тела и физическую оболочку солнца внутри skyDome
  while (celestialGroup.children.length > 0) {
    const ch = celestialGroup.children[0];
    celestialGroup.remove(ch);
  }
  sunShellMesh = null;

  if (ss.enabled !== false && ss.shellShape && ss.shellShape !== 'none') {
    const sGeo = buildCelestialShapeGeo(ss.shellShape, Number(ss.shellSize) || 14);
    const sMat = ss.shellGlow !== false
      ? new THREE.MeshBasicMaterial({ color: ss.shellColor || ss.color || '#ffea79', fog: false })
      : new THREE.MeshStandardMaterial({ color: ss.shellColor || ss.color || '#ffea79', roughness: 0.4, metalness: 0.1, fog: false });
    sunShellMesh = new THREE.Mesh(sGeo, sMat);
    // Размещаем оболочку на небосводе по направлению вектора света
    const dir = new THREE.Vector3(Number(ss.x) ?? 45, Number(ss.y) ?? 85, Number(ss.z) ?? 35);
    if (dir.lengthSq() < 1) dir.set(45, 85, 35);
    dir.normalize().multiplyScalar(380);
    sunShellMesh.position.copy(dir);
    sunShellMesh.userData.noCollider = true;
    celestialGroup.add(sunShellMesh);
  }

  // 3. Дополнительные небесные тела (планеты, звёзды, спутники)
  if (Array.isArray(ws.celestialBodies)) {
    for (let i = 0; i < ws.celestialBodies.length; i++) {
      const cb = ws.celestialBodies[i];
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

      celestialGroup.add(mesh);
    }
  }
}

export function updateSkybox(syncNetwork = true) {
  const ws = S.worldSettings;
  const grad = skyCtx.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0.0, ws.skyTop);
  grad.addColorStop(0.52, ws.skyMid);
  grad.addColorStop(1.0, ws.skyBot);
  skyCtx.fillStyle = grad;
  skyCtx.fillRect(0, 0, 64, 256);
  skyTex.needsUpdate = true;
  scene.fog.color.set(ws.fogColor);
  scene.fog.density = ws.fogDensity;

  syncSunAndCelestialBodies();

  if (syncNetwork && window.__debixSyncWorldSettings && !S.isApplyingRemoteSync) {
    window.__debixSyncWorldSettings(true);
  }
}
updateSkybox();