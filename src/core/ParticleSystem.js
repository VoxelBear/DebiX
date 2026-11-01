// src/core/ParticleSystem.js
import { S, TAU, clamp, rnd } from './State.js';
import { scene } from './SceneManager.js';
import { makeParticleTex } from './TextureFactory.js';

const activeParticles = [];
const ragdollLimbs = [];
const MAX_PARTICLES = 600;

export function createDefaultParticleData() {
  return {
    enabled: false,
    preset: 'spark',     // 'spark' | 'fire' | 'heart' | 'star' | 'smoke' | 'hit' | 'custom'
    texDataURL: null,
    color: '#ffffff',
    rate: 12,
    lifetime: 1.6,
    sizeStart: 0.45,
    sizeEnd: 0.08,
    speed: 3.2,
    dirX: 0,
    dirY: 1,
    dirZ: 0,
    spread: 0.65,
    gravity: -1.5,
    rotSpeed: 2.5,
    flicker: 0.0,
    fadeOut: true
  };
}

export function clearAllParticles() {
  for (const p of activeParticles) {
    scene.remove(p.spr);
    if (p.spr.material) p.spr.material.dispose();
  }
  activeParticles.length = 0;

  for (const limb of ragdollLimbs) {
    scene.remove(limb.mesh);
  }
  ragdollLimbs.length = 0;
}

export function spawnSingleParticle(x, y, z, cfg) {
  if (activeParticles.length >= MAX_PARTICLES) {
    const oldest = activeParticles.shift();
    scene.remove(oldest.spr);
    if (oldest.spr.material) oldest.spr.material.dispose();
  }

  const tex = makeParticleTex(cfg.texDataURL, cfg.preset || 'spark');
  const mat = new THREE.SpriteMaterial({
    map: tex,
    color: new THREE.Color(cfg.color || '#ffffff'),
    transparent: true,
    opacity: 1.0,
    depthWrite: false
  });

  const spr = new THREE.Sprite(mat);
  spr.position.set(x, y, z);
  const s0 = Math.max(0.02, Number(cfg.sizeStart) ?? 0.4);
  spr.scale.set(s0, s0, 1);
  scene.add(spr);

  let dx = Number(cfg.dirX) ?? 0;
  let dy = Number(cfg.dirY) ?? 1;
  let dz = Number(cfg.dirZ) ?? 0;
  const dLen = Math.hypot(dx, dy, dz) || 1;
  dx /= dLen;
  dy /= dLen;
  dz /= dLen;

  const spread = Number(cfg.spread) ?? 0.5;
  const spd = (Number(cfg.speed) ?? 3.0) * rnd(0.75, 1.25);

  const rx = dx + rnd(-spread, spread);
  const ry = dy + rnd(-spread, spread);
  const rz = dz + rnd(-spread, spread);
  const rLen = Math.hypot(rx, ry, rz) || 1;

  const rotSpd = (Number(cfg.rotSpeed) ?? 0) * (Math.random() < 0.5 ? -1 : 1);
  mat.rotation = rnd(0, TAU);

  activeParticles.push({
    spr,
    mat,
    vx: (rx / rLen) * spd,
    vy: (ry / rLen) * spd,
    vz: (rz / rLen) * spd,
    gravity: Number(cfg.gravity) ?? 0,
    rotSpeed: rotSpd,
    age: 0,
    maxAge: Math.max(0.15, (Number(cfg.lifetime) ?? 1.5) * rnd(0.85, 1.15)),
    sizeStart: s0,
    sizeEnd: Math.max(0, Number(cfg.sizeEnd) ?? 0.05),
    flicker: clamp(Number(cfg.flicker) ?? 0, 0, 1),
    fadeOut: cfg.fadeOut !== false
  });
}

export function emitParticleBurst(x, y, z, count = 12, customCfg = {}) {
  const cfg = Object.assign(createDefaultParticleData(), customCfg);
  for (let i = 0; i < count; i++) {
    spawnSingleParticle(
      x + rnd(-0.35, 0.35),
      y + rnd(-0.35, 0.35),
      z + rnd(-0.35, 0.35),
      cfg
    );
  }
}

export function spawnDamageParticles(target) {
  if (!target) return;
  emitParticleBurst(target.x, target.y + 1.45, target.z, 14, {
    preset: 'hit',
    color: '#ff3e3e',
    sizeStart: 0.42,
    sizeEnd: 0.08,
    speed: 4.8,
    dirX: 0,
    dirY: 1,
    dirZ: 0,
    spread: 1.35,
    gravity: -9.5,
    rotSpeed: 6.0,
    lifetime: 0.65,
    flicker: 0.25,
    fadeOut: true
  });
}

// Безопасное клонирование 3D-дерева конечности без копирования циклических ссылок в userData
function cloneVisualTreeSafe(srcObj) {
  let copy;
  if (srcObj.isMesh) {
    copy = new THREE.Mesh(srcObj.geometry, srcObj.material);
    copy.castShadow = srcObj.castShadow;
    copy.receiveShadow = srcObj.receiveShadow;
  } else {
    copy = new THREE.Group();
  }
  copy.visible = srcObj.visible;
  copy.position.copy(srcObj.position);
  copy.quaternion.copy(srcObj.quaternion);
  copy.scale.copy(srcObj.scale);

  for (const child of srcObj.children) {
    if (!child.visible) continue;
    copy.add(cloneVisualTreeSafe(child));
  }
  return copy;
}

// Рассыпание персонажа/бота на 6 отдельных физических частей тела R6 с компенсацией суставных пивотов
export function spawnDeathShatter(ent) {
  if (!ent || !ent.rig) return;

  // 1. Всплеск частиц разрушения в момент разваливания
  emitParticleBurst(ent.x, ent.y + 1.4, ent.z, 20, {
    preset: 'hit',
    color: '#ff3e3e',
    sizeStart: 0.55,
    sizeEnd: 0.1,
    speed: 6.5,
    dirX: 0,
    dirY: 1,
    dirZ: 0,
    spread: 1.5,
    gravity: -12,
    rotSpeed: 8.0,
    lifetime: 0.95,
    flicker: 0.2,
    fadeOut: true
  });

  emitParticleBurst(ent.x, ent.y + 1.5, ent.z, 14, {
    preset: 'spark',
    color: '#ffce3a',
    sizeStart: 0.48,
    sizeEnd: 0.05,
    speed: 5.5,
    dirX: 0,
    dirY: 1,
    dirZ: 0,
    spread: 1.4,
    gravity: -8,
    rotSpeed: 5.0,
    lifetime: 1.1,
    flicker: 0.35,
    fadeOut: true
  });

  // 2. Безопасно клонируем 6 конечностей R6 с центрированием вокруг их геометрического центра масс
  const partKeys = ['head', 'torso', 'armL', 'armR', 'legL', 'legR'];
  const floorY = Math.max(-15, ent.y);
  const rigScale = ent.rig.g.scale.x || 1;

  ent.rig.g.updateMatrixWorld(true);

  for (const key of partKeys) {
    const srcPart = ent.rig[key];
    if (!srcPart) continue;

    const pivotOffsetY = (srcPart.userData && srcPart.userData.pivotOffsetY) || 0;
    const worldCenter = new THREE.Vector3(0, pivotOffsetY, 0).applyMatrix4(srcPart.matrixWorld);
    const worldQuat = new THREE.Quaternion();
    srcPart.getWorldQuaternion(worldQuat);

    const innerClone = cloneVisualTreeSafe(srcPart);
    innerClone.position.set(0, -pivotOffsetY, 0);
    innerClone.rotation.set(0, 0, 0);
    innerClone.scale.set(1, 1, 1);

    const wrapper = new THREE.Group();
    wrapper.add(innerClone);
    wrapper.position.copy(worldCenter);
    wrapper.quaternion.copy(worldQuat);
    wrapper.scale.setScalar(rigScale);
    scene.add(wrapper);

    const outAngle = rnd(0, TAU);
    const outSpd = rnd(2.8, 6.8);
    ragdollLimbs.push({
      mesh: wrapper,
      vx: Math.cos(outAngle) * outSpd,
      vy: rnd(4.5, 9.2),
      vz: Math.sin(outAngle) * outSpd,
      rx: rnd(-9, 9),
      ry: rnd(-9, 9),
      rz: rnd(-9, 9),
      baseScale: rigScale,
      floorY: floorY + 0.28 * rigScale,
      age: 0,
      maxAge: 2.8
    });
  }
}

export function updateParticles(dt) {
  // 1. Спавн новых частиц из эмиттеров блоков
  for (const box of S.allBlocks) {
    const pd = box.particleData;
    if (!pd || !pd.enabled) continue;

    box._pAccum = (box._pAccum || 0) + dt * clamp(pd.rate || 10, 0.5, 120);
    while (box._pAccum >= 1) {
      box._pAccum -= 1;
      const pos = box.m.position;
      const ox = rnd(-box.w * 0.4, box.w * 0.4);
      const oy = rnd(-box.h * 0.4, box.h * 0.4);
      const oz = rnd(-box.d * 0.4, box.d * 0.4);
      spawnSingleParticle(pos.x + ox, pos.y + oy, pos.z + oz, pd);
    }
  }

  // 2. Обновление 2D-спрайтов частиц
  for (let i = activeParticles.length - 1; i >= 0; i--) {
    const p = activeParticles[i];
    p.age += dt;
    if (p.age >= p.maxAge) {
      scene.remove(p.spr);
      p.mat.dispose();
      activeParticles.splice(i, 1);
      continue;
    }

    const t = p.age / p.maxAge;
    p.vy += p.gravity * dt;
    p.spr.position.x += p.vx * dt;
    p.spr.position.y += p.vy * dt;
    p.spr.position.z += p.vz * dt;

    p.mat.rotation += p.rotSpeed * dt;

    const curSize = p.sizeStart + (p.sizeEnd - p.sizeStart) * t;
    p.spr.scale.set(curSize, curSize, 1);

    let alpha = p.fadeOut ? 1.0 - t : 1.0;
    if (p.flicker > 0) {
      const flk = 1.0 - p.flicker * (0.5 + 0.5 * Math.sin(p.age * 42 + i));
      alpha *= flk;
    }
    p.mat.opacity = clamp(alpha, 0, 1);
  }

  // 3. Физика разлетевшихся частей тела R6 (Ragdoll Shatter)
  const grav = S.worldSettings.gravity || 22;
  for (let i = ragdollLimbs.length - 1; i >= 0; i--) {
    const limb = ragdollLimbs[i];
    limb.age += dt;
    if (limb.age >= limb.maxAge) {
      scene.remove(limb.mesh);
      ragdollLimbs.splice(i, 1);
      continue;
    }

    limb.vy -= grav * dt;
    limb.mesh.position.x += limb.vx * dt;
    limb.mesh.position.y += limb.vy * dt;
    limb.mesh.position.z += limb.vz * dt;

    limb.mesh.rotation.x += limb.rx * dt;
    limb.mesh.rotation.y += limb.ry * dt;
    limb.mesh.rotation.z += limb.rz * dt;

    if (limb.mesh.position.y < limb.floorY && limb.vy < 0) {
      limb.mesh.position.y = limb.floorY;
      limb.vy = -limb.vy * 0.42;
      limb.vx *= 0.72;
      limb.vz *= 0.72;
      limb.rx *= 0.65;
      limb.ry *= 0.65;
      limb.rz *= 0.65;
    }

    if (limb.age > limb.maxAge - 0.5) {
      const shrink = Math.max(0.01, (limb.maxAge - limb.age) / 0.5);
      limb.mesh.scale.setScalar((limb.baseScale || 1) * shrink);
    }
  }
}