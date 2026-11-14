// src/studio/StudioGrid.js
import { S, ITEM_STUDIO_ORIGIN } from '../core/State.js';
import { scene, camera } from '../core/SceneManager.js';
import { tControls } from './StudioController.js';

/* =========================================================================
   CARTOON GIZMO STYLED 3D EDIT GRID SYSTEM
   Matches the colors and cartoon style of the DebiX Studio Gizmo:
   - X Axis: Vibrant Red (#ff4757)
   - Z Axis: Vibrant Cyan/Blue (#00d2ff)
   - Center / Pivot: Gold (#ffce3a)
   - Major Grid Lines (2.0m / 1.0m): Bright Neon Cyan (#56f0ff)
   - Minor Grid Lines (0.5m / 0.25m): Subtle Cyan Glow (#00a2ff)
   ========================================================================= */

const COL_X = new THREE.Color(0xff4757);      // Сочный красный (Ось X гизмо)
const COL_Z = new THREE.Color(0x00d2ff);      // Сочный голубой (Ось Z гизмо)
const COL_ORIGIN = new THREE.Color(0xffce3a); // Золотой пивот / центр гизмо
const COL_MAJOR = new THREE.Color(0x56f0ff);  // Яркий неоновый циан (основные секции)
const COL_MINOR = new THREE.Color(0x00a2ff);  // Неоновый синий (шаг сетки 0.5м)

// Вершинный шейдер: вычисляет мировые координаты и плоскостные XZ
const GRID_VERTEX_SHADER = `
  varying vec3 vWorldPos;
  varying vec2 vLocalPos;

  void main() {
    vLocalPos = vec2(position.x, position.z);
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
  }
`;

// Фрагментный шейдер: процедурные антиалиасинг-линии, цветные оси X/Z и радиальный fade
const GRID_FRAGMENT_SHADER = `
  varying vec3 vWorldPos;
  varying vec2 vLocalPos;

  uniform vec3 uCameraPos;
  uniform vec3 uOrigin;
  uniform float uGridStep;
  uniform float uSectionStep;
  uniform float uRadius;
  uniform vec3 uColMinor;
  uniform vec3 uColMajor;
  uniform vec3 uColX;
  uniform vec3 uColZ;
  uniform vec3 uColOrigin;
  uniform float uOpacity;
  uniform float uIsCircular;
  uniform float uUseLocalCoords;

  float getGridLine(vec2 coord, float stepVal, float widthPx) {
    vec2 f = abs(fract(coord / stepVal - 0.5) - 0.5);
    #if defined(GL_OES_standard_derivatives) || __VERSION__ >= 300
      vec2 df = max(fwidth(coord / stepVal) * widthPx, vec2(0.0001));
    #else
      vec2 df = vec2(0.02 * widthPx);
    #endif
    vec2 line = vec2(1.0) - smoothstep(vec2(0.0), df, f);
    return max(line.x, line.y);
  }

  float getAxisLine(float coord, float widthPx) {
    #if defined(GL_OES_standard_derivatives) || __VERSION__ >= 300
      float df = max(fwidth(coord) * widthPx, 0.0001);
    #else
      float df = 0.02 * widthPx;
    #endif
    return 1.0 - smoothstep(0.0, df, abs(coord));
  }

  void main() {
    vec2 rel = (uUseLocalCoords > 0.5) ? vLocalPos : (vWorldPos.xz - uOrigin.xz);
    float distFromOrigin = length(rel);

    // Круглая студийная отсечка (для пьедестала)
    if (uIsCircular > 0.5 && distFromOrigin > uRadius) {
      discard;
    }

    // Мягкое радиальное растворение
    float fade = 1.0;
    if (uUseLocalCoords > 0.5) {
      fade = 1.0 - smoothstep(uRadius * 0.48, uRadius, distFromOrigin);
      if (fade <= 0.002) discard;
    } else if (uIsCircular < 0.5) {
      float distCam = length(vWorldPos.xz - uCameraPos.xz);
      fade = 1.0 - smoothstep(uRadius * 0.42, uRadius, distCam);
      if (fade <= 0.002) discard;
    }

    // Линии шага сетки (0.5м)
    float minor = getGridLine(rel, uGridStep, 1.0);

    // Основные секции сетки (2.0м)
    float major = getGridLine(rel, uSectionStep, 1.35);

    // Ось X (rel.y == 0 -> вдоль красной стрелки гизмо)
    float isAxisX = getAxisLine(rel.y, 1.85);

    // Ось Z (rel.x == 0 -> вдоль голубой стрелки гизмо)
    float isAxisZ = getAxisLine(rel.x, 1.85);

    // Точка пивота / центра
    float isOrigin = isAxisX * isAxisZ;

    vec3 col = uColMinor;
    float alpha = minor * 0.32;

    if (major > 0.001) {
      col = mix(col, uColMajor, major);
      alpha = max(alpha, major * 0.65);
    }

    if (isAxisX > 0.001) {
      col = mix(col, uColX, isAxisX);
      alpha = max(alpha, isAxisX * 0.95);
    }

    if (isAxisZ > 0.001) {
      col = mix(col, uColZ, isAxisZ);
      alpha = max(alpha, isAxisZ * 0.95);
    }

    if (isOrigin > 0.001) {
      col = mix(col, uColOrigin, isOrigin);
      alpha = max(alpha, isOrigin * 1.0);
    }

    // Неоновое кольцо по краю для круглого пьедестала
    if (uIsCircular > 0.5) {
      float rim = smoothstep(uRadius - 0.08, uRadius, distFromOrigin);
      if (rim > 0.0) {
        col = mix(col, uColMajor, rim);
        alpha = max(alpha, rim * 0.92);
      }
    }

    float finalAlpha = alpha * fade * uOpacity;
    if (finalAlpha <= 0.015) discard;

    gl_FragColor = vec4(col, finalAlpha);
  }
`;

function createGridMaterial(params = {}) {
  return new THREE.ShaderMaterial({
    extensions: { derivatives: true },
    uniforms: {
      uCameraPos: { value: new THREE.Vector3() },
      uOrigin: { value: new THREE.Vector3() },
      uGridStep: { value: params.gridStep ?? 0.5 },
      uSectionStep: { value: params.sectionStep ?? 2.0 },
      uRadius: { value: params.radius ?? 140.0 },
      uColMinor: { value: COL_MINOR },
      uColMajor: { value: COL_MAJOR },
      uColX: { value: COL_X },
      uColZ: { value: COL_Z },
      uColOrigin: { value: COL_ORIGIN },
      uOpacity: { value: params.opacity ?? 0.88 },
      uIsCircular: { value: params.isCircular ? 1.0 : 0.0 },
      uUseLocalCoords: { value: params.useLocalCoords ? 1.0 : 0.0 }
    },
    vertexShader: GRID_VERTEX_SHADER,
    fragmentShader: GRID_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -2.0,
    polygonOffsetUnits: -2.0,
    side: THREE.DoubleSide
  });
}

// Корневые контейнеры сеток
let worldGridGroup = null;
let worldGridPlane = null;
let worldGridMat = null;
let originMarkerGroup = null;

let elevatedGridGroup = null;
let elevatedGridPlane = null;
let elevatedGridMat = null;
let dropLineMesh = null;
let dropFootprintRing = null;

let studioPedestalGrid = null;
let studioPedestalMat = null;

// Вычисляет высоту пола/стартовой платформы (Baseplate) в мире
export function getStudioGroundElevation() {
  let gY = 0.0;
  const blocks = S.allBlocks || [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b || !b.m || !b.m.visible) continue;
    const topY = (b.y || 0) + (b.h ? b.h * 0.5 : 0);
    const halfW = (b.w || 1) * 0.5;
    const halfD = (b.d || 1) * 0.5;
    if (Math.abs(b.x || 0) <= halfW && Math.abs(b.z || 0) <= halfD) {
      if (topY > gY && topY < 6.0) {
        gY = topY;
      }
    }
  }
  return gY + 0.015;
}

// Создаёт объёмный мультяшный маркер начала координат (кристалл + кольцо + стрелочки +X/+Z)
function createOrigin3DMarker(scale = 1.0) {
  const g = new THREE.Group();
  g.renderOrder = 998;

  const mkMat = (col, op = 0.95) =>
    new THREE.MeshBasicMaterial({
      color: col,
      transparent: true,
      opacity: op,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      polygonOffsetUnits: -3,
      side: THREE.DoubleSide
    });

  // Золотой кристалл пивота в центре
  const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.18 * scale, 0), mkMat(COL_ORIGIN, 0.98));
  crystal.position.y = 0.12 * scale;
  g.add(crystal);

  // Белое мультяшное кольцо вокруг кристалла
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34 * scale, 0.038 * scale, 12, 32), mkMat(0xffffff, 0.88));
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.02 * scale;
  g.add(ring);

  // Красная стрелка +X
  const arrowX = new THREE.Mesh(new THREE.ConeGeometry(0.09 * scale, 0.32 * scale, 14), mkMat(COL_X, 0.98));
  arrowX.rotation.z = -Math.PI / 2;
  arrowX.position.set(1.4 * scale, 0.04 * scale, 0);
  g.add(arrowX);

  const shaftX = new THREE.Mesh(new THREE.CylinderGeometry(0.025 * scale, 0.025 * scale, 1.0 * scale, 10), mkMat(COL_X, 0.9));
  shaftX.rotation.z = -Math.PI / 2;
  shaftX.position.set(0.85 * scale, 0.04 * scale, 0);
  g.add(shaftX);

  // Синяя/голубая стрелка +Z
  const arrowZ = new THREE.Mesh(new THREE.ConeGeometry(0.09 * scale, 0.32 * scale, 14), mkMat(COL_Z, 0.98));
  arrowZ.rotation.x = Math.PI / 2;
  arrowZ.position.set(0, 0.04 * scale, 1.4 * scale);
  g.add(arrowZ);

  const shaftZ = new THREE.Mesh(new THREE.CylinderGeometry(0.025 * scale, 0.025 * scale, 1.0 * scale, 10), mkMat(COL_Z, 0.9));
  shaftZ.rotation.x = Math.PI / 2;
  shaftZ.position.set(0, 0.04 * scale, 0.85 * scale);
  g.add(shaftZ);

  g.userData.noCollider = true;
  return g;
}

export function initStudioGrid() {
  if (worldGridGroup) return;

  // 1. ОСНОВНАЯ МИРОВАЯ СЕТКА (на уровне пола/Baseplate)
  worldGridGroup = new THREE.Group();
  worldGridGroup.name = 'WorldStudioGridGroup';
  worldGridGroup.userData.noCollider = true;

  const groundGeo = new THREE.PlaneGeometry(320, 320, 1, 1);
  groundGeo.rotateX(-Math.PI / 2);

  worldGridMat = createGridMaterial({
    gridStep: 0.5,
    sectionStep: 2.0,
    radius: 140.0,
    opacity: 0.88,
    isCircular: false,
    useLocalCoords: false
  });

  worldGridPlane = new THREE.Mesh(groundGeo, worldGridMat);
  worldGridPlane.renderOrder = 980;
  worldGridPlane.frustumCulled = false;
  worldGridPlane.userData.noCollider = true;
  worldGridGroup.add(worldGridPlane);

  originMarkerGroup = createOrigin3DMarker(1.0);
  worldGridGroup.add(originMarkerGroup);

  worldGridGroup.visible = false;
  scene.add(worldGridGroup);

  // 2. СРЕЗ СЕТКИ ВЫСОТЫ ВЫДЕЛЕННОГО ОБЪЕКТА (Elevated Grid Slice)
  elevatedGridGroup = new THREE.Group();
  elevatedGridGroup.name = 'ElevatedStudioGridGroup';
  elevatedGridGroup.userData.noCollider = true;

  const elevGeo = new THREE.PlaneGeometry(54, 54, 1, 1);
  elevGeo.rotateX(-Math.PI / 2);

  elevatedGridMat = createGridMaterial({
    gridStep: 0.5,
    sectionStep: 2.0,
    radius: 24.0,
    opacity: 0.82,
    isCircular: false,
    useLocalCoords: true
  });

  elevatedGridPlane = new THREE.Mesh(elevGeo, elevatedGridMat);
  elevatedGridPlane.renderOrder = 990;
  elevatedGridPlane.frustumCulled = false;
  elevatedGridPlane.userData.noCollider = true;
  elevatedGridGroup.add(elevatedGridPlane);

  // Вертикальный неоновый луч от объекта к полу
  const lineGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -1, 0)]);
  const lineMat = new THREE.LineBasicMaterial({
    color: 0x56f0ff,
    transparent: true,
    opacity: 0.65,
    depthTest: true,
    depthWrite: false
  });
  dropLineMesh = new THREE.Line(lineGeo, lineMat);
  dropLineMesh.frustumCulled = false;
  dropLineMesh.userData.noCollider = true;
  elevatedGridGroup.add(dropLineMesh);

  // Неоновое кольцо проекции на полу
  const footRingGeo = new THREE.RingGeometry(0.24, 0.36, 28);
  footRingGeo.rotateX(-Math.PI / 2);
  const footRingMat = new THREE.MeshBasicMaterial({
    color: 0x56f0ff,
    transparent: true,
    opacity: 0.75,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false
  });
  dropFootprintRing = new THREE.Mesh(footRingGeo, footRingMat);
  dropFootprintRing.frustumCulled = false;
  dropFootprintRing.userData.noCollider = true;
  elevatedGridGroup.add(dropFootprintRing);

  elevatedGridGroup.visible = false;
  scene.add(elevatedGridGroup);
}

// Создаёт круглую сетку в стиле гизмо для 3D Студии предметов на пьедестале
export function createItemStudioPedestalGrid(radius = 3.52) {
  const g = new THREE.Group();
  g.name = 'ItemStudioPedestalGridGroup';
  g.userData.noCollider = true;

  const geo = new THREE.PlaneGeometry(radius * 2.2, radius * 2.2, 1, 1);
  geo.rotateX(-Math.PI / 2);

  studioPedestalMat = createGridMaterial({
    gridStep: 0.25,
    sectionStep: 1.0,
    radius: radius,
    opacity: 0.95,
    isCircular: true,
    useLocalCoords: true
  });

  const mesh = new THREE.Mesh(geo, studioPedestalMat);
  mesh.position.set(0, 0.016, 0);
  mesh.renderOrder = 985;
  mesh.frustumCulled = false;
  mesh.userData.noCollider = true;
  g.add(mesh);

  // Центр пивота подиума
  const centerCrystal = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.09, 0),
    new THREE.MeshBasicMaterial({ color: COL_ORIGIN, depthTest: true })
  );
  centerCrystal.position.set(0, 0.04, 0);
  g.add(centerCrystal);

  studioPedestalGrid = g;
  return g;
}

// Обновление позиций, ориентации и видимости сеток каждый кадр
export function updateStudioGrid(dt = 0.016) {
  const isEditActive = S.state === 'edit';
  const isSnapOn = !!S.snapEnabled;
  const inStudio = !!S.itemStudioOpen;

  // 1. 3D ITEM STUDIO
  if (studioPedestalGrid && studioPedestalMat) {
    if (inStudio) {
      studioPedestalGrid.visible = true;
      studioPedestalMat.uniforms.uOpacity.value = isSnapOn ? 0.98 : 0.25;
      studioPedestalMat.uniforms.uCameraPos.value.copy(camera.position);
    } else {
      studioPedestalGrid.visible = false;
    }
  }

  // Если не в режиме редактирования или выключена сетка — прячем всё в мире
  if (!isEditActive || !isSnapOn || inStudio) {
    if (worldGridGroup) worldGridGroup.visible = false;
    if (elevatedGridGroup) elevatedGridGroup.visible = false;
    return;
  }

  // 2. ОСНОВНАЯ МИРОВАЯ СЕТКА
  if (worldGridGroup && worldGridPlane && worldGridMat) {
    const groundY = getStudioGroundElevation();
    worldGridGroup.visible = true;

    // Центрируем плоскость вокруг камеры (с привязкой к шагу 2м), чтобы сетка была "бесконечной"
    const snapCamX = Math.round(camera.position.x * 0.5) * 2;
    const snapCamZ = Math.round(camera.position.z * 0.5) * 2;
    worldGridPlane.position.set(snapCamX, groundY, snapCamZ);

    if (originMarkerGroup) {
      originMarkerGroup.position.set(0, groundY, 0);
    }

    worldGridMat.uniforms.uCameraPos.value.copy(camera.position);
    worldGridMat.uniforms.uOrigin.value.set(0, 0, 0);
    worldGridMat.uniforms.uOpacity.value = 0.90;

    // 3. СРЕЗ СЕТКИ ВЫСОТЫ ВЫДЕЛЕННОГО ОБЪЕКТА
    if (elevatedGridGroup && elevatedGridPlane && elevatedGridMat) {
      const activeObj = tControls && tControls.object && tControls.visible ? tControls.object : null;

      if (activeObj && S.selectedRef) {
        const objPos = new THREE.Vector3();
        activeObj.getWorldPosition(objPos);

        const heightDiff = objPos.y - groundY;
        const isElevated = Math.abs(heightDiff) > 0.38;

        if (isElevated) {
          elevatedGridGroup.visible = true;

          // Располагаем срез строго на уровне пивота объекта (с привязкой к 0.5м)
          const snappedY = Math.round(objPos.y * 2) * 0.5;
          elevatedGridPlane.position.set(objPos.x, snappedY + 0.005, objPos.z);

          // В локальном режиме оси сетки среза поворачиваются вместе с объектом
          if (tControls.space === 'local') {
            const rotEuler = new THREE.Euler();
            rotEuler.setFromRotationMatrix(activeObj.matrixWorld, 'YXZ');
            elevatedGridPlane.rotation.set(0, rotEuler.y, 0);
          } else {
            elevatedGridPlane.rotation.set(0, 0, 0);
          }

          elevatedGridMat.uniforms.uCameraPos.value.copy(camera.position);
          elevatedGridMat.uniforms.uOrigin.value.copy(objPos);
          elevatedGridMat.uniforms.uOpacity.value = 0.85;

          // Вертикальный направляющий луч вниз к полу
          if (dropLineMesh) {
            const posAttr = dropLineMesh.geometry.attributes.position;
            posAttr.setXYZ(0, objPos.x, snappedY, objPos.z);
            posAttr.setXYZ(1, objPos.x, groundY + 0.01, objPos.z);
            posAttr.needsUpdate = true;
          }

          // Кольцо отпечатка на полу
          if (dropFootprintRing) {
            dropFootprintRing.position.set(objPos.x, groundY + 0.015, objPos.z);
          }
        } else {
          elevatedGridGroup.visible = false;
        }
      } else {
        elevatedGridGroup.visible = false;
      }
    }
  }
}
