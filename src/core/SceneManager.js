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

export function updateSkybox() {
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
}
updateSkybox();