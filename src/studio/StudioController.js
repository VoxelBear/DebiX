// src/studio/StudioController.js
import { S, $, coarse, showBanner, ITEM_STUDIO_ORIGIN, clamp } from '../core/State.js';
import { cv, scene, camera } from '../core/SceneManager.js';
import { initAudio, sfx } from '../core/AudioEngine.js';
import {
  MAX_COSMETIC_PARTS,
  MAX_ITEM_PARTS,
  normalizeCosmeticItem,
  normalizeItemData,
  normalizeCharacterGripPoints,
  buildItemGroup,
  createRobloxRig,
  createStarterItemTemplate,
  syncBuiltinCosmetics,
  syncRigAppearanceFromPreset,
  updateGroupRootHitbox
} from '../core/CharacterRig.js';
import {
  addSceneBlock,
  rebuildPhysicsArrays,
  removeBlockHalo,
  syncStudioMotionAndSignalHelpers,
  clearStudioMotionHelpers,
  getBlockLocalPivotOffset
} from '../core/WorldRegistry.js';
import {
  spawnCustomNPC,
  attachRigToEntity,
  updateShopUI,
  spawnWorldItem,
  rebuildWorldItemVisual
} from '../core/EntityManager.js';
import { serializeSceneState, loadSceneState } from '../core/Serializer.js';
import { completePlayerRespawn } from '../player/PhysicsAndCombat.js';
import {
  refreshHierarchyUI,
  recordHierarchyBaseline,
  propagateHierarchyTransform,
  syncFolderPivotToChildren,
  getAllSceneDescendants,
  spawnEmptyObject,
  setEmptyObjectsHelperVisible,
  compileSceneHierarchyToItemData
} from './HierarchyAndSpawn.js';
import { renderInspectorUI, syncInspectorInputsFromObject, syncLibraryItemIfEditing } from './InspectorPanel.js';
import { isPaintModalOpen, undoPaintAction } from './PaintStudio2D.js';
import {
  initStudioGrid,
  createItemStudioPedestalGrid,
  updateStudioGrid
} from './StudioGrid.js';

export function toggleGridSnap(forceVal) {
  S.snapEnabled = forceVal !== undefined ? forceVal : !S.snapEnabled;
  tControls.setTranslationSnap(S.snapEnabled ? 0.5 : null);
  tControls.setRotationSnap(MIN_ROTATION_STEP_RAD);
  tControls.setScaleSnap(S.snapEnabled ? 0.25 : null);

  if ($('btnSnapToggle')) {
    $('btnSnapToggle').textContent = S.snapEnabled ? '🧲 Сетка: 🟢' : '🧲 Сетка: 🔴';
    $('btnSnapToggle').classList.toggle('active', S.snapEnabled);
  }
  updateStudioGrid();
  showBanner(
    S.snapEnabled ? '🧲 Сетка и привязка включены (Шаг: 0.5м)' : '🧲 Сетка и привязка выключены',
    S.snapEnabled ? '#00e676' : '#ff4757'
  );
  try { sfx.click(); } catch (_) {}
}

export { updateStudioGrid };

export const MIN_ROTATION_STEP_DEG = 22.5;
export const MIN_ROTATION_STEP_RAD = THREE.MathUtils.degToRad(MIN_ROTATION_STEP_DEG);

export function snapAngleRad(rad) {
  return Math.round((Number(rad) || 0) / MIN_ROTATION_STEP_RAD) * MIN_ROTATION_STEP_RAD;
}

export function snapAngleDeg(deg) {
  return Math.round((Number(deg) || 0) / MIN_ROTATION_STEP_DEG) * MIN_ROTATION_STEP_DEG;
}

export function snapEulerToStep(euler) {
  if (!euler) return;
  euler.x = snapAngleRad(euler.x);
  euler.y = snapAngleRad(euler.y);
  euler.z = snapAngleRad(euler.z);
}

function mergeBufferGeosSimple(geos) {
  const nonIndexed = geos.map(g => (g.index ? g.toNonIndexed() : g.clone()));
  let totalVerts = 0;
  for (const g of nonIndexed) totalVerts += g.attributes.position.count;
  const posArr = new Float32Array(totalVerts * 3);
  const normArr = new Float32Array(totalVerts * 3);
  let offset = 0;
  for (const g of nonIndexed) {
    posArr.set(g.attributes.position.array, offset);
    if (g.attributes.normal) normArr.set(g.attributes.normal.array, offset);
    offset += g.attributes.position.count * 3;
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
  return merged;
}

function applyCartoonGizmoStyle(tc) {
  const gizmo = tc._gizmo || tc.children[0];
  if (!gizmo || !gizmo.gizmo) return;

  const mkMat = (hex, opacity = 0.96) => {
    const m = new THREE.MeshBasicMaterial({
      color: hex,
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity,
      side: THREE.DoubleSide
    });
    m._color = m.color.clone();
    m._opacity = opacity;
    return m;
  };

  const mkPickerMat = () => {
    const m = new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide
    });
    m._color = new THREE.Color(0xffffff);
    m._opacity = 0.0;
    return m;
  };

  const COL_X = 0xff4757;   // Сочный красный (X)
  const COL_Y = 0x00e676;   // Сочный зелёный (Y)
  const COL_Z = 0x00d2ff;   // Сочный голубой (Z)
  const COL_XYZ = 0xffce3a; // Золотой пивот / центр

  const addHandle = (group, name, geo, hex, opacity = 0.96) => {
    const mesh = new THREE.Mesh(geo, mkMat(hex, opacity));
    mesh.name = name;
    mesh.renderOrder = 999;
    mesh.userData.noCollider = true;
    group.add(mesh);
    return mesh;
  };

  const addPicker = (group, name, geo) => {
    const mesh = new THREE.Mesh(geo, mkPickerMat());
    mesh.name = name;
    mesh.renderOrder = Infinity;
    mesh.userData.noCollider = true;
    mesh.userData.isPicker = true;
    group.add(mesh);
    return mesh;
  };

  // 1. ПЕРЕМЕЩЕНИЕ (TRANSLATE) — острые мультяшные стрелы + центральный кристалл с кольцом
  const gTrans = gizmo.gizmo.translate;
  const pTrans = gizmo.picker && gizmo.picker.translate;
  if (gTrans) {
    gTrans.clear();

    const makeArrowGeo = axis => {
      const shaft = new THREE.CylinderGeometry(0.026, 0.026, 0.52, 14);
      shaft.translate(0, 0.26, 0);
      const collar = new THREE.TorusGeometry(0.044, 0.011, 10, 20);
      collar.rotateX(Math.PI / 2);
      collar.translate(0, 0.52, 0);
      const tip = new THREE.ConeGeometry(0.076, 0.34, 18);
      tip.translate(0, 0.52 + 0.17, 0);

      const merged = mergeBufferGeosSimple([shaft, collar, tip]);
      if (axis === 'X') merged.rotateZ(-Math.PI / 2);
      else if (axis === 'Z') merged.rotateX(Math.PI / 2);
      return merged;
    };

    addHandle(gTrans, 'X', makeArrowGeo('X'), COL_X);
    addHandle(gTrans, 'Y', makeArrowGeo('Y'), COL_Y);
    addHandle(gTrans, 'Z', makeArrowGeo('Z'), COL_Z);

    // Центральный кристалл и кольцо в стиле маркеров хвата рук
    const centerCore = new THREE.OctahedronGeometry(0.105, 0);
    const centerRing = new THREE.TorusGeometry(0.155, 0.02, 10, 32);
    addHandle(gTrans, 'XYZ', mergeBufferGeosSimple([centerCore, centerRing]), COL_XYZ, 0.95);

    // Площадки двух-осевого перемещения
    const pXY = new THREE.BoxGeometry(0.15, 0.15, 0.025);
    pXY.translate(0.26, 0.26, 0);
    addHandle(gTrans, 'XY', pXY, COL_XYZ, 0.55);

    const pYZ = new THREE.BoxGeometry(0.025, 0.15, 0.15);
    pYZ.translate(0, 0.26, 0.26);
    addHandle(gTrans, 'YZ', pYZ, COL_X, 0.55);

    const pXZ = new THREE.BoxGeometry(0.15, 0.025, 0.15);
    pXZ.translate(0.26, 0, 0.26);
    addHandle(gTrans, 'XZ', pXZ, COL_Y, 0.55);
  }

  // Обновляем хитбоксы перемещения в picker
  if (pTrans) {
    pTrans.clear();

    const makePickCyl = axis => {
      const g = new THREE.CylinderGeometry(0.08, 0.08, 0.86, 12);
      g.translate(0, 0.43, 0);
      if (axis === 'X') g.rotateZ(-Math.PI / 2);
      else if (axis === 'Z') g.rotateX(Math.PI / 2);
      return g;
    };

    addPicker(pTrans, 'X', makePickCyl('X'));
    addPicker(pTrans, 'Y', makePickCyl('Y'));
    addPicker(pTrans, 'Z', makePickCyl('Z'));
    addPicker(pTrans, 'XYZ', new THREE.SphereGeometry(0.16, 10, 8));

    const pickXY = new THREE.BoxGeometry(0.22, 0.22, 0.06);
    pickXY.translate(0.26, 0.26, 0);
    addPicker(pTrans, 'XY', pickXY);

    const pickYZ = new THREE.BoxGeometry(0.06, 0.22, 0.22);
    pickYZ.translate(0, 0.26, 0.26);
    addPicker(pTrans, 'YZ', pickYZ);

    const pickXZ = new THREE.BoxGeometry(0.22, 0.06, 0.22);
    pickXZ.translate(0.26, 0, 0.26);
    addPicker(pTrans, 'XZ', pickXZ);
  }

  // 2. ВРАЩЕНИЕ (ROTATE) — кольца вращения с четкими неконфликтующими хитбоксами
  const gRot = gizmo.gizmo.rotate;
  const pRot = gizmo.picker && gizmo.picker.rotate;
  const ROT_RADIUS = 0.70;
  const ROT_TUBE = 0.038;
  const ROT_E_RADIUS = 0.88;

  const makeRingGeo = (axis, radius = ROT_RADIUS, tube = ROT_TUBE) => {
    const torus = new THREE.TorusGeometry(radius, tube, 14, 52);
    if (axis === 'X') torus.rotateY(Math.PI / 2);
    else if (axis === 'Y') torus.rotateX(Math.PI / 2);
    return torus;
  };

  if (gRot) {
    gRot.clear();
    addHandle(gRot, 'X', makeRingGeo('X', ROT_RADIUS, ROT_TUBE), COL_X);
    addHandle(gRot, 'Y', makeRingGeo('Y', ROT_RADIUS, ROT_TUBE), COL_Y);
    addHandle(gRot, 'Z', makeRingGeo('Z', ROT_RADIUS, ROT_TUBE), COL_Z);
    addHandle(gRot, 'E', makeRingGeo('E', ROT_E_RADIUS, 0.024), COL_XYZ, 0.75);
    addHandle(gRot, 'XYZE', new THREE.OctahedronGeometry(0.095, 0), COL_XYZ, 0.92);
  }

  // Пикер вращения: четкие торусы без гигантской сферы, блокирующей оси
  if (pRot) {
    pRot.clear();
    const PICK_TUBE = 0.085;
    addPicker(pRot, 'X', makeRingGeo('X', ROT_RADIUS, PICK_TUBE));
    addPicker(pRot, 'Y', makeRingGeo('Y', ROT_RADIUS, PICK_TUBE));
    addPicker(pRot, 'Z', makeRingGeo('Z', ROT_RADIUS, PICK_TUBE));
    addPicker(pRot, 'E', makeRingGeo('E', ROT_E_RADIUS, 0.075));
    // Сфера свободного вращения XYZE теперь только в самом центре (не заслоняет кольца)
    addPicker(pRot, 'XYZE', new THREE.SphereGeometry(0.12, 10, 8));
  }

  // 3. МАСШТАБ (SCALE) — штанги с кубиками
  const gScale = gizmo.gizmo.scale;
  const pScale = gizmo.picker && gizmo.picker.scale;
  if (gScale) {
    gScale.clear();

    const makeScaleGeo = axis => {
      const shaft = new THREE.CylinderGeometry(0.028, 0.028, 0.54, 14);
      shaft.translate(0, 0.27, 0);
      const knob = new THREE.BoxGeometry(0.16, 0.16, 0.16);
      knob.translate(0, 0.62, 0);

      const merged = mergeBufferGeosSimple([shaft, knob]);
      if (axis === 'X') merged.rotateZ(-Math.PI / 2);
      else if (axis === 'Z') merged.rotateX(Math.PI / 2);
      return merged;
    };

    addHandle(gScale, 'X', makeScaleGeo('X'), COL_X);
    addHandle(gScale, 'Y', makeScaleGeo('Y'), COL_Y);
    addHandle(gScale, 'Z', makeScaleGeo('Z'), COL_Z);
    addHandle(gScale, 'XYZ', new THREE.BoxGeometry(0.18, 0.18, 0.18), COL_XYZ, 0.95);
  }

  if (pScale) {
    pScale.clear();
    const makeScalePick = axis => {
      const g = new THREE.CylinderGeometry(0.08, 0.08, 0.76, 12);
      g.translate(0, 0.38, 0);
      if (axis === 'X') g.rotateZ(-Math.PI / 2);
      else if (axis === 'Z') g.rotateX(Math.PI / 2);
      return g;
    };
    addPicker(pScale, 'X', makeScalePick('X'));
    addPicker(pScale, 'Y', makeScalePick('Y'));
    addPicker(pScale, 'Z', makeScalePick('Z'));
    addPicker(pScale, 'XYZ', new THREE.BoxGeometry(0.22, 0.22, 0.22));
  }

  // Прячем тонкие вспомогательные линии стандартного хелпера и группы пикеров
  if (gizmo.helper) {
    for (const k of ['translate', 'rotate', 'scale']) {
      if (gizmo.helper[k]) gizmo.helper[k].visible = false;
    }
  }
  if (gizmo.picker) {
    for (const k of ['translate', 'rotate', 'scale']) {
      if (gizmo.picker[k]) gizmo.picker[k].visible = false;
    }
  }

  // Переопределяем updateMatrixWorld гизмо:
  // 1. Исправляем баг Three.js r128 (в режиме translate не переключался space на world)
  // 2. Исправляем подсветку: выбранная ось светится СТАНДАРТНЫМ чистым цветом, остальные затухают
  const _identityQuaternion = new THREE.Quaternion();
  const _tempQuaternion = new THREE.Quaternion();
  const _tempQuaternion2 = new THREE.Quaternion();
  const _alignVector = new THREE.Vector3();
  const _zeroVector = new THREE.Vector3(0, 0, 0);
  const _unitX = new THREE.Vector3(1, 0, 0);
  const _unitY = new THREE.Vector3(0, 1, 0);
  const _unitZ = new THREE.Vector3(0, 0, 1);
  const _lookAtMatrix = new THREE.Matrix4();

  gizmo.updateMatrixWorld = function (force) {
    // В scale всегда local; в translate и rotate используем выбранный this.space ('world' или 'local')
    const space = this.mode === 'scale' ? 'local' : this.space;
    const quaternion = space === 'local' ? this.worldQuaternion : _identityQuaternion;

    if (this.gizmo['translate']) this.gizmo['translate'].visible = this.mode === 'translate';
    if (this.gizmo['rotate']) this.gizmo['rotate'].visible = this.mode === 'rotate';
    if (this.gizmo['scale']) this.gizmo['scale'].visible = this.mode === 'scale';

    if (this.helper['translate']) this.helper['translate'].visible = false;
    if (this.helper['rotate']) this.helper['rotate'].visible = false;
    if (this.helper['scale']) this.helper['scale'].visible = false;

    if (this.picker['translate']) this.picker['translate'].visible = false;
    if (this.picker['rotate']) this.picker['rotate'].visible = false;
    if (this.picker['scale']) this.picker['scale'].visible = false;

    let handles = [];
    if (this.picker[this.mode]) handles = handles.concat(this.picker[this.mode].children);
    if (this.gizmo[this.mode]) handles = handles.concat(this.gizmo[this.mode].children);

    for (let i = 0; i < handles.length; i++) {
      const handle = handles[i];
      handle.visible = true;
      handle.rotation.set(0, 0, 0);
      handle.position.copy(this.worldPosition);

      let factor;
      if (this.camera.isOrthographicCamera) {
        factor = (this.camera.top - this.camera.bottom) / this.camera.zoom;
      } else {
        factor =
          this.worldPosition.distanceTo(this.cameraPosition) *
          Math.min((1.9 * Math.tan((Math.PI * this.camera.fov) / 360)) / this.camera.zoom, 7);
      }
      handle.scale.set(1, 1, 1).multiplyScalar((factor * this.size) / 7);

      if (handle.tag === 'helper') {
        handle.visible = false;
        continue;
      }

      handle.quaternion.copy(quaternion);

      if (this.mode === 'translate' || this.mode === 'scale') {
        const AXIS_HIDE_TRESHOLD = 0.99;
        const PLANE_HIDE_TRESHOLD = 0.2;
        const AXIS_FLIP_TRESHOLD = 0.0;

        if (handle.name === 'X' || handle.name === 'XYZX') {
          if (Math.abs(_alignVector.copy(_unitX).applyQuaternion(quaternion).dot(this.eye)) > AXIS_HIDE_TRESHOLD) {
            handle.scale.set(1e-10, 1e-10, 1e-10);
            handle.visible = false;
          }
        }
        if (handle.name === 'Y' || handle.name === 'XYZY') {
          if (Math.abs(_alignVector.copy(_unitY).applyQuaternion(quaternion).dot(this.eye)) > AXIS_HIDE_TRESHOLD) {
            handle.scale.set(1e-10, 1e-10, 1e-10);
            handle.visible = false;
          }
        }
        if (handle.name === 'Z' || handle.name === 'XYZZ') {
          if (Math.abs(_alignVector.copy(_unitZ).applyQuaternion(quaternion).dot(this.eye)) > AXIS_HIDE_TRESHOLD) {
            handle.scale.set(1e-10, 1e-10, 1e-10);
            handle.visible = false;
          }
        }
        if (handle.name === 'XY') {
          if (Math.abs(_alignVector.copy(_unitZ).applyQuaternion(quaternion).dot(this.eye)) < PLANE_HIDE_TRESHOLD) {
            handle.scale.set(1e-10, 1e-10, 1e-10);
            handle.visible = false;
          }
        }
        if (handle.name === 'YZ') {
          if (Math.abs(_alignVector.copy(_unitX).applyQuaternion(quaternion).dot(this.eye)) < PLANE_HIDE_TRESHOLD) {
            handle.scale.set(1e-10, 1e-10, 1e-10);
            handle.visible = false;
          }
        }
        if (handle.name === 'XZ') {
          if (Math.abs(_alignVector.copy(_unitY).applyQuaternion(quaternion).dot(this.eye)) < PLANE_HIDE_TRESHOLD) {
            handle.scale.set(1e-10, 1e-10, 1e-10);
            handle.visible = false;
          }
        }

        if (handle.name.search('X') !== -1) {
          if (_alignVector.copy(_unitX).applyQuaternion(quaternion).dot(this.eye) < AXIS_FLIP_TRESHOLD) {
            if (handle.tag === 'fwd') handle.visible = false;
            else handle.scale.x *= -1;
          } else if (handle.tag === 'bwd') {
            handle.visible = false;
          }
        }
        if (handle.name.search('Y') !== -1) {
          if (_alignVector.copy(_unitY).applyQuaternion(quaternion).dot(this.eye) < AXIS_FLIP_TRESHOLD) {
            if (handle.tag === 'fwd') handle.visible = false;
            else handle.scale.y *= -1;
          } else if (handle.tag === 'bwd') {
            handle.visible = false;
          }
        }
        if (handle.name.search('Z') !== -1) {
          if (_alignVector.copy(_unitZ).applyQuaternion(quaternion).dot(this.eye) < AXIS_FLIP_TRESHOLD) {
            if (handle.tag === 'fwd') handle.visible = false;
            else handle.scale.z *= -1;
          } else if (handle.tag === 'bwd') {
            handle.visible = false;
          }
        }
      } else if (this.mode === 'rotate') {
        _tempQuaternion2.copy(quaternion);
        _alignVector.copy(this.eye).applyQuaternion(_tempQuaternion.copy(quaternion).invert());

        if (handle.name.search('E') !== -1) {
          handle.quaternion.setFromRotationMatrix(_lookAtMatrix.lookAt(this.eye, _zeroVector, _unitY));
        }
        if (handle.name === 'X') {
          _tempQuaternion.setFromAxisAngle(_unitX, Math.atan2(-_alignVector.y, _alignVector.z));
          _tempQuaternion.multiplyQuaternions(_tempQuaternion2, _tempQuaternion);
          handle.quaternion.copy(_tempQuaternion);
        }
        if (handle.name === 'Y') {
          _tempQuaternion.setFromAxisAngle(_unitY, Math.atan2(_alignVector.x, _alignVector.z));
          _tempQuaternion.multiplyQuaternions(_tempQuaternion2, _tempQuaternion);
          handle.quaternion.copy(_tempQuaternion);
        }
        if (handle.name === 'Z') {
          _tempQuaternion.setFromAxisAngle(_unitZ, Math.atan2(_alignVector.y, _alignVector.x));
          _tempQuaternion.multiplyQuaternions(_tempQuaternion2, _tempQuaternion);
          handle.quaternion.copy(_tempQuaternion);
        }
      }

      handle.visible = handle.visible && (handle.name.indexOf('X') === -1 || this.showX);
      handle.visible = handle.visible && (handle.name.indexOf('Y') === -1 || this.showY);
      handle.visible = handle.visible && (handle.name.indexOf('Z') === -1 || this.showZ);
      handle.visible = handle.visible && (handle.name.indexOf('E') === -1 || (this.showX && this.showY && this.showZ));

      if (handle.userData.isPicker) continue;
      if (!handle.material) continue;

      handle.material._opacity = handle.material._opacity ?? handle.material.opacity;
      handle.material._color = handle.material._color ?? handle.material.color.clone();

      if (!this.enabled) {
        handle.material.opacity = (handle.material._opacity ?? 0.95) * 0.4;
        handle.material.color.copy(handle.material._color).multiplyScalar(0.6);
      } else if (this.axis) {
        const isSelected =
          handle.name === this.axis ||
          (this.axis.length > 1 && this.axis.split('').some(a => a && handle.name === a));
        if (isSelected) {
          handle.material.opacity = 1.0;
          handle.material.color.copy(handle.material._color);
        } else {
          handle.material.opacity = (handle.material._opacity ?? 0.95) * 0.22;
          handle.material.color.copy(handle.material._color).multiplyScalar(0.45);
        }
      } else {
        handle.material.opacity = handle.material._opacity ?? 0.96;
        handle.material.color.copy(handle.material._color);
      }
    }

    THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
  };
}

export const tControls = new THREE.TransformControls(camera, cv);
tControls.setSize(1.05);
tControls.setSpace('local');
tControls.setRotationSnap(MIN_ROTATION_STEP_RAD);
applyCartoonGizmoStyle(tControls);
scene.add(tControls);

export const raycaster = new THREE.Raycaster();
export const mouseNDC = new THREE.Vector2();

export const selBoxHelper = new THREE.BoxHelper(new THREE.Mesh(), 0x00f2fe);
selBoxHelper.visible = false;
scene.add(selBoxHelper);

const MAX_UNDO_STEPS = 25;

// Отдельные изолированные стеки отмены для конструктора аксессуаров и конструктора предметов
const cosmeticUndoStack = [];
const itemUndoStack = [];

// Изолированная 3D-Студия предметов и аксессуаров (на манер 2D STUDIO)
export { ITEM_STUDIO_ORIGIN };
let itemStudioStageGroup = null;
let studioMannequinRig = null;
let savedMapCamera = null;
let activeStudioWorldEntry = null;
let activeStudioCharEnt = null;
let activeStudioBlockState = null;

function ensureItemStudioStage() {
  if (itemStudioStageGroup) return itemStudioStageGroup;

  itemStudioStageGroup = new THREE.Group();
  itemStudioStageGroup.position.copy(ITEM_STUDIO_ORIGIN);
  itemStudioStageGroup.visible = false;

  // 1. Изолированный купол 3D-мастерской (отсекает основной мир от камеры)
  const domeGeo = new THREE.SphereGeometry(42, 28, 20);
  const domeMat = new THREE.MeshBasicMaterial({
    color: 0x0b0f19,
    side: THREE.BackSide
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.userData.noCollider = true;
  itemStudioStageGroup.add(dome);

  // 2. Подиум-пьедестал с неоновым ободом и координатной сеткой
  const pedGeo = new THREE.CylinderGeometry(3.5, 3.9, 0.36, 40);
  const pedMat = new THREE.MeshStandardMaterial({
    color: 0x151b29,
    roughness: 0.45,
    metalness: 0.25
  });
  const pedestal = new THREE.Mesh(pedGeo, pedMat);
  pedestal.position.set(0, -0.18, 0);
  pedestal.receiveShadow = true;
  pedestal.userData.noCollider = true;
  itemStudioStageGroup.add(pedestal);

  const rimGeo = new THREE.TorusGeometry(3.52, 0.045, 12, 48);
  const rimMat = new THREE.MeshBasicMaterial({ color: 0x00a2ff });
  const rim = new THREE.Mesh(rimGeo, rimMat);
  rim.rotation.x = Math.PI / 2;
  rim.position.set(0, 0.01, 0);
  rim.userData.noCollider = true;
  itemStudioStageGroup.add(rim);

  const studioGrid = createItemStudioPedestalGrid(3.52);
  itemStudioStageGroup.add(studioGrid);

  // 3. Собственное студийное освещение внутри 3D-мастерской
  const keyLight = new THREE.PointLight(0xffffff, 1.35, 34);
  keyLight.position.set(4.5, 6.5, 5.5);
  itemStudioStageGroup.add(keyLight);

  const fillLight = new THREE.PointLight(0x70cfff, 0.85, 30);
  fillLight.position.set(-4.5, 4.0, -4.5);
  itemStudioStageGroup.add(fillLight);

  // 4. Манекен R6 для наглядной примерки оружия (1 и 2 руки) на пьедестале
  studioMannequinRig = createRobloxRig(
    {
      head: 0x94a3b8,
      torso: 0x334155,
      armL: 0x94a3b8,
      armR: 0x94a3b8,
      legL: 0x1e293b,
      legR: 0x1e293b
    },
    1.0,
    false
  );
  // Клонируем материалы манекена студии для полной изоляции от кэша мира
  for (const mKey of ['mHead', 'mTorso', 'mArmL', 'mArmR', 'mLegL', 'mLegR']) {
    if (studioMannequinRig[mKey]) {
      studioMannequinRig[mKey] = studioMannequinRig[mKey].clone();
    }
  }
  studioMannequinRig.head.material = studioMannequinRig.mHead;
  studioMannequinRig.torso.material = studioMannequinRig.mTorso;
  studioMannequinRig.armL.material = studioMannequinRig.mArmL;
  studioMannequinRig.armR.material = studioMannequinRig.mArmR;
  studioMannequinRig.legL.material = studioMannequinRig.mLegL;
  studioMannequinRig.legR.material = studioMannequinRig.mLegR;

  studioMannequinRig.g.position.set(-1.95, 0.02, 0);
  studioMannequinRig.g.rotation.y = 0.25;
  studioMannequinRig.g.traverse(o => {
    o.userData.noCollider = true;
  });
  itemStudioStageGroup.add(studioMannequinRig.g);
  S.studioMannequinRig = studioMannequinRig;

  scene.add(itemStudioStageGroup);
  return itemStudioStageGroup;
}

function setMannequinBodyVisible(rig, visible) {
  if (!rig) return;
  const limbs = [rig.head, rig.torso, rig.armL, rig.armR, rig.legL, rig.legR];
  for (const limb of limbs) {
    if (limb && limb.material) limb.material.visible = visible;
  }
  if (rig.head) {
    rig.head.traverse(o => {
      if (o.userData?.isFrontSprite) o.visible = visible;
    });
  }
}

export function syncItemStudioPreview() {
  if (!S.itemStudioOpen) return;
  ensureItemStudioStage();
  const showMannequin = S.itemStudioShowMannequin !== false;
  const btnMan = $('btnISMannequin');
  if (btnMan) {
    btnMan.textContent = showMannequin ? '🧍 Манекен: 🟢' : '🧍 Манекен: 🔴';
    btnMan.classList.toggle('active', showMannequin);
  }

  if (S.workbenchPreviewGroup && S.workbenchPreviewGroup.parent) {
    S.workbenchPreviewGroup.parent.remove(S.workbenchPreviewGroup);
  }
  S.workbenchPreviewGroup = null;

  const ref = S.selectedRef;
  if (!ref) return;

  if (ref.kind === 'world_item' && ref.worldEntry) {
    const wi = ref.worldEntry;
    const item = normalizeItemData(wi.item);
    activeStudioWorldEntry = wi;

    // Центрируем редактируемый предмет на пьедестале 3D STUDIO (не меняя его мировые координаты wi.x/y/z!)
    if (wi.group) {
      wi.group.position.set(ITEM_STUDIO_ORIGIN.x, ITEM_STUDIO_ORIGIN.y + 1.25, ITEM_STUDIO_ORIGIN.z);
      wi.group.rotation.set(0, 0, 0);
      wi.group.updateMatrixWorld(true);
    }
    if (wi.tag) wi.tag.visible = false;

    if ($('itemStudioSubjectTitle')) {
      $('itemStudioSubjectTitle').textContent = `${item.icon || '🗡️'} ${item.name} — 3D STUDIO`;
    }
    if ($('btnISPlaceInWorld')) {
      $('btnISPlaceInWorld').hidden = false;
    }

    // Показываем манекен рядом с предметом с живым превью хвата в руке / 2 руках
    if (studioMannequinRig) {
      studioMannequinRig.g.position.set(-1.95, 0.02, 0);
      studioMannequinRig.g.rotation.set(0, 0.25, 0);
      studioMannequinRig.g.scale.setScalar(1);
      studioMannequinRig.g.visible = showMannequin;
      if (showMannequin) {
        if (S.player && S.player.preset) {
          syncRigAppearanceFromPreset(studioMannequinRig, S.player.preset);
        }
        const previewMesh = buildItemGroup(item, {
          isProjectile: false,
          showMarkers: false,
          applyGripOffset: true
        });
        if (item.holdMode === 'carried') {
          studioMannequinRig.armL.rotation.set(-1.35, -0.28, 0.08);
          studioMannequinRig.armR.rotation.set(-1.35, 0.28, -0.08);
          studioMannequinRig.carrySocket.add(previewMesh);
        } else {
          studioMannequinRig.armL.rotation.set(0, 0, 0);
          studioMannequinRig.armR.rotation.set(-Math.PI / 2, 0, 0);
          studioMannequinRig.handGripSocket.add(previewMesh);
        }
        studioMannequinRig.g.updateMatrixWorld(true);
        S.workbenchPreviewGroup = previewMesh;
      }
    }
  } else if (ref.kind === 'cosmetic' && ref.item) {
    const { ent, item } = ref;
    normalizeCosmeticItem(item);
    activeStudioCharEnt = ent || null;
    if ($('btnISPlaceInWorld')) {
      $('btnISPlaceInWorld').hidden = false;
      $('btnISPlaceInWorld').textContent = '📍 На карте';
    }
    if ($('itemStudioSubjectTitle')) {
      const ico = item.parentSlot === 'pet' ? '🐾' : '🎩';
      $('itemStudioSubjectTitle').textContent = `${ico} ${item.name || 'Аксессуар'}${ent ? ' (' + ent.name + ')' : ''} — 3D STUDIO`;
    }

    // Для примерки и редактирования косметики синхронизируем студийный манекен с персонажем
    if (studioMannequinRig) {
      studioMannequinRig.g.position.set(0, 0.02, 0);
      studioMannequinRig.g.rotation.set(0, 0, 0);
      studioMannequinRig.g.visible = true;

      // Отключаем невидимый бокс выбора персонажа на манекене, чтобы он не перекрывал клики по деталям аксессуара
      studioMannequinRig.g.traverse(o => {
        if (o.userData?.isCharPickMesh) o.visible = false;
      });

      if (ent && ent.preset) {
        syncRigAppearanceFromPreset(studioMannequinRig, ent.preset, ent === S.archangelEnt);
        studioMannequinRig.g.scale.setScalar(ent.scale || 1);
      }

      // Не пересоздаём меши прямо во время перетаскивания стрелок Гизмо
      if (!tControls.dragging || !studioMannequinRig.customCosMeshes[0]) {
        studioMannequinRig.syncCustomCosmetics([item]);
      }

      const studioGroup = studioMannequinRig.customCosMeshes[0];
      if (studioGroup) {
        studioGroup.visible = true;
        if (item.parentSlot === 'pet') {
          if (showMannequin) {
            const dist = Math.max(0.8, Number(item.petDistance) || 2.2);
            const height = Number(item.petHeight) || 1.5;
            studioGroup.position.set(dist, height, 0);
          } else {
            studioGroup.position.set(0, 1.25, 0);
          }
        }
        setMannequinBodyVisible(studioMannequinRig, showMannequin);

        // КРИТИЧЕСКИ ВАЖНО: сначала обновляем мировые матрицы на подиуме, чтобы синяя рамка selBoxHelper обводила деталь точно в 3D Студии!
        studioMannequinRig.g.updateMatrixWorld(true);

        const partMeshes = studioGroup.userData?.partMeshes || [];
        const holder = studioGroup.userData?.partsHolder || studioGroup;
        const partIdx = Math.min(Math.max(0, ref.partIdx ?? 0), Math.max(0, item.parts.length - 1));
        const activePart = item.parts[partIdx];
        const activeMesh = ref.editMode === 'root' ? holder : (partMeshes[partIdx] || holder);

        // Прописываем editorRef на каждую деталь аксессуара для мгновенного клика с 1 раза
        partMeshes.forEach((pm, idx) => {
          const ptObj = item.parts[idx];
          const ptRef = {
            kind: 'cosmetic',
            ent,
            item,
            group: studioGroup,
            editMode: 'part',
            partIdx: idx,
            part: ptObj,
            mesh: pm,
            inWorldPlacement: false,
            libIdx: ref.libIdx
          };
          pm.userData.editorRef = ptRef;
          pm.traverse(ch => { ch.userData.editorRef = ptRef; });
        });

        ref.group = studioGroup;
        ref.partIdx = partIdx;
        ref.part = activePart;
        ref.mesh = activeMesh;

        if (activeMesh) {
          activeMesh.updateMatrixWorld(true);
          if (tControls.object !== activeMesh) {
            tControls.detach();
            setGizmoSpace('local');
            tControls.attach(activeMesh);
          }
          selBoxHelper.setFromObject(ref.editMode === 'root' ? studioGroup : activeMesh);
          selBoxHelper.visible = true;
        }
      }
    }
  } else if (ref.kind === 'char' && ref.ent) {
    const ent = ref.ent;
    activeStudioCharEnt = ent;
    if ($('btnISPlaceInWorld')) {
      $('btnISPlaceInWorld').hidden = false;
      $('btnISPlaceInWorld').textContent = '📍 На карте';
    }
    if ($('itemStudioSubjectTitle')) {
      $('itemStudioSubjectTitle').textContent = `🧍 ${ent.name || 'Персонаж'} — 3D STUDIO`;
    }

    if (studioMannequinRig) {
      studioMannequinRig.g.position.set(0, 0.02, 0);
      studioMannequinRig.g.rotation.set(0, 0, 0);
      studioMannequinRig.g.visible = true;

      syncRigAppearanceFromPreset(studioMannequinRig, ent.preset, ent === S.archangelEnt);
      studioMannequinRig.g.scale.setScalar(ent.scale || 1);
      if (ent.preset && ent.preset.customCosmetics) {
        studioMannequinRig.syncCustomCosmetics(ent.preset.customCosmetics);
      }
      setMannequinBodyVisible(studioMannequinRig, showMannequin);

      studioMannequinRig.g.traverse(o => {
        if (!o.userData?.isCharHandGripMarker && !o.userData?.isCharCarryGripMarker && !o.userData?.cosmeticItem) {
          o.userData.editorRef = { kind: 'char', ent, inStudio: true };
        }
      });

      if (ref.editMode === 'hand_grip' && studioMannequinRig.handGripMarker) {
        studioMannequinRig.armR.rotation.set(-Math.PI / 2, 0, 0);
        studioMannequinRig.g.updateMatrixWorld(true);
        ref.mesh = studioMannequinRig.handGripMarker;
        setGizmoSpace('local');
        tControls.attach(ref.mesh);
        selBoxHelper.visible = false;
      } else if (ref.editMode === 'carry_grip' && studioMannequinRig.carryGripMarker) {
        studioMannequinRig.armL.rotation.set(-1.35, -0.28, 0.08);
        studioMannequinRig.armR.rotation.set(-1.35, 0.28, -0.08);
        studioMannequinRig.g.updateMatrixWorld(true);
        ref.mesh = studioMannequinRig.carryGripMarker;
        setGizmoSpace('local');
        tControls.attach(ref.mesh);
        selBoxHelper.visible = false;
      } else {
        studioMannequinRig.armL.rotation.set(0, 0, 0);
        studioMannequinRig.armR.rotation.set(0, 0, 0);
        studioMannequinRig.g.updateMatrixWorld(true);
        ref.mesh = studioMannequinRig.g;
        setGizmoSpace('local');
        tControls.attach(ref.mesh);
        selBoxHelper.setFromObject(ref.mesh);
        selBoxHelper.visible = true;
      }
      studioMannequinRig.g.updateMatrixWorld(true);
    }
  } else if (ref.kind === 'block' && ref.box) {
    const box = ref.box;
    // Находим корневой блок иерархии, чтобы переносить на подиум всю составную модель целиком
    let rootBox = box;
    while (rootBox.parentKey && rootBox.parentKey.startsWith('block:')) {
      const pid = rootBox.parentKey.slice(6);
      const pBox = S.allBlocks.find(b => b.id === pid);
      if (!pBox || pBox === rootBox) break;
      rootBox = pBox;
    }

    if (!activeStudioBlockState || activeStudioBlockState.rootBox !== rootBox) {
      if (activeStudioBlockState) restoreItemStudioSubjectsToWorld();
      activeStudioBlockState = {
        rootBox,
        worldPos: rootBox.m.position.clone(),
        worldQuat: rootBox.m.quaternion.clone()
      };
      recordHierarchyBaseline({ kind: 'block', box: rootBox });
      rootBox.m.position.set(ITEM_STUDIO_ORIGIN.x, ITEM_STUDIO_ORIGIN.y + Math.max(0.5, rootBox.h * 0.5), ITEM_STUDIO_ORIGIN.z);
      rootBox.m.updateMatrixWorld(true);
      propagateHierarchyTransform({ kind: 'block', box: rootBox });
      rebuildPhysicsArrays();
    }

    if ($('itemStudioSubjectTitle')) {$('itemStudioSubjectTitle').textContent = `🧱 ${rootBox.label || 'Объект'} — 3D STUDIO`;
    }
    if ($('btnISPlaceInWorld')) {$('btnISPlaceInWorld').hidden = false;
      $('btnISPlaceInWorld').textContent = '📍 На карте';
    }
    if (studioMannequinRig) {
      studioMannequinRig.g.visible = false;
    }
  }
}

export function setItemStudioCameraPreset(preset = 'iso') {
  ensureItemStudioStage();
  let focusTarget = new THREE.Vector3(ITEM_STUDIO_ORIGIN.x, ITEM_STUDIO_ORIGIN.y + 1.35, ITEM_STUDIO_ORIGIN.z);

  if (S.selectedRef && S.selectedRef.kind === 'cosmetic' && S.selectedRef.group) {
    S.selectedRef.group.updateMatrixWorld(true);
    S.selectedRef.group.getWorldPosition(focusTarget);
  }

  if (preset === 'front') {
    S.edYaw = 0;
    S.edPitch = -0.12;
    S.edCamPos.set(focusTarget.x, focusTarget.y + 0.35, focusTarget.z + 3.2);
  } else if (preset === 'side') {
    S.edYaw = Math.PI / 2;
    S.edPitch = -0.12;
    S.edCamPos.set(focusTarget.x + 3.2, focusTarget.y + 0.35, focusTarget.z);
  } else {
    S.edYaw = 0.48;
    S.edPitch = -0.26;
    const dist = 3.4;
    const fwd = new THREE.Vector3(
      -Math.sin(S.edYaw) * Math.cos(S.edPitch),
      Math.sin(S.edPitch),
      -Math.cos(S.edYaw) * Math.cos(S.edPitch)
    );
    S.edCamPos.copy(focusTarget).addScaledVector(fwd, -dist);
  }
}

export function restoreItemStudioSubjectsToWorld() {
  if (S.workbenchPreviewGroup && S.workbenchPreviewGroup.parent) {
    S.workbenchPreviewGroup.parent.remove(S.workbenchPreviewGroup);
  }
  S.workbenchPreviewGroup = null;

  if (studioMannequinRig) {
    studioMannequinRig.syncCustomCosmetics([]);
    studioMannequinRig.g.position.set(-1.95, 0.02, 0);
    studioMannequinRig.g.rotation.set(0, 0.25, 0);
    setMannequinBodyVisible(studioMannequinRig, true);
  }

  if (activeStudioWorldEntry) {
    const wi = activeStudioWorldEntry;
    activeStudioWorldEntry = null;
    if (S.worldItems.includes(wi)) {
      if (wi.tag) wi.tag.visible = true;
      rebuildWorldItemVisual(wi, false);
    }
  }

  if (activeStudioCharEnt) {
    const ent = activeStudioCharEnt;
    activeStudioCharEnt = null;
    if (ent.rig && ent.rig.g) {
      ent.rig.g.position.set(ent.x, ent.y, ent.z);
      ent.rig.g.rotation.set(0, ent.yaw || 0, 0);
      if (ent.tag) ent.tag.visible = true;
      attachRigToEntity(ent);
      if (ent.preset) {
        syncBuiltinCosmetics(ent.rig, ent.preset, ent === S.archangelEnt);
        if (ent.preset.customCosmetics) {
          ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
        }
      }
      ent.rig.g.updateMatrixWorld(true);
    }
  }

  if (activeStudioBlockState) {
    const { rootBox, worldPos } = activeStudioBlockState;
    activeStudioBlockState = null;
    if (rootBox && rootBox.m && S.allBlocks.includes(rootBox)) {
      recordHierarchyBaseline({ kind: 'block', box: rootBox });
      rootBox.m.position.copy(worldPos);
      rootBox.m.updateMatrixWorld(true);
      propagateHierarchyTransform({ kind: 'block', box: rootBox });
      rebuildPhysicsArrays();
    }
  }
}

export function openItemStudio3D(ref = S.selectedRef) {
  ensureItemStudioStage();
  if (S.itemStudioShowMannequin === undefined) {
    S.itemStudioShowMannequin = true;
  }

  const wasOpen = !!S.itemStudioOpen;
  if (!wasOpen) {
    savedMapCamera = {
      pos: S.edCamPos.clone(),
      yaw: S.edYaw,
      pitch: S.edPitch
    };
  }

  // Если меняем редактируемый объект внутри студии — возвращаем предыдущий на карту
  if (activeStudioWorldEntry && (!ref || ref.worldEntry !== activeStudioWorldEntry)) {
    restoreItemStudioSubjectsToWorld();
  }
  if (activeStudioCharEnt && (!ref || ref.ent !== activeStudioCharEnt)) {
    restoreItemStudioSubjectsToWorld();
  }
  if (activeStudioBlockState && (!ref || ref.kind !== 'block' || ref.box !== activeStudioBlockState.rootBox)) {
    restoreItemStudioSubjectsToWorld();
  }

  S.itemStudioOpen = true;
  itemStudioStageGroup.visible = true;
  if ($('itemStudioOverlay')) $('itemStudioOverlay').hidden = false;
  if ($('openItemStudioBtn')) $('openItemStudioBtn').classList.add('active');

  syncItemStudioPreview();
  if (!wasOpen) {
    setItemStudioCameraPreset('iso');
  }
  refreshHierarchyUI();
}

export function closeItemStudio3D(switchToMapPlacement = false) {
  if (!S.itemStudioOpen) return;
  const prevRef = S.selectedRef;

  S.itemStudioOpen = false;
  refreshHierarchyUI();
  if (itemStudioStageGroup) itemStudioStageGroup.visible = false;
  if ($('itemStudioOverlay')) $('itemStudioOverlay').hidden = true;
  if ($('openItemStudioBtn')) $('openItemStudioBtn').classList.remove('active');

  restoreItemStudioSubjectsToWorld();

  if (savedMapCamera) {
    S.edCamPos.copy(savedMapCamera.pos);
    S.edYaw = savedMapCamera.yaw;
    S.edPitch = savedMapCamera.pitch;
    savedMapCamera = null;
  }

  if (switchToMapPlacement && prevRef && prevRef.kind === 'world_item' && prevRef.worldEntry) {
    selectEditorObject({
      kind: 'world_item',
      worldEntry: prevRef.worldEntry,
      item: prevRef.worldEntry.item,
      editMode: 'root',
      partIdx: 0,
      libIdx: prevRef.libIdx,
      inWorldPlacement: true
    });
    focusOnSelected();
    showBanner('📍 Режим размещения на карте: двигай предмет в мире стрелками Гизмо!', '#00e676');
    return;
  }

  if (switchToMapPlacement && prevRef && prevRef.kind === 'cosmetic' && prevRef.ent) {
    const ent = prevRef.ent;
    const item = prevRef.item;
    const group = ent?.rig?.customCosMeshes?.find(g => g.userData?.cosmeticItem === item);
    selectEditorObject({
      kind: 'cosmetic',
      ent,
      item,
      group,
      partIdx: prevRef.partIdx ?? 0,
      inWorldPlacement: true
    });
    focusOnSelected();
    showBanner('📍 Аксессуар редактируется прямо на персонаже в мире!', '#00e676');
    return;
  }

  if (switchToMapPlacement && prevRef && prevRef.kind === 'char' && prevRef.ent) {
    selectEditorObject({
      kind: 'char',
      ent: prevRef.ent,
      editMode: prevRef.editMode || 'root',
      inStudio: false
    });
    focusOnSelected();
    showBanner('📍 Персонаж на карте мира!', '#00e676');
    return;
  }

  if (prevRef && prevRef.kind === 'cosmetic' && prevRef.ent) {
    selectEditorObject({ kind: 'char', ent: prevRef.ent, inStudio: false });
  } else if (prevRef && prevRef.kind === 'world_item' && prevRef.worldEntry) {
    selectEditorObject({
      kind: 'world_item',
      worldEntry: prevRef.worldEntry,
      item: prevRef.worldEntry.item,
      editMode: 'root',
      partIdx: 0,
      libIdx: prevRef.libIdx,
      inWorldPlacement: true
    });
  } else if (prevRef && prevRef.kind === 'char' && prevRef.ent) {
    selectEditorObject({ kind: 'char', ent: prevRef.ent, inStudio: false });
  } else {
    selectEditorObject(null);
  }
}

export function clearCosmeticUndoStack() {
  cosmeticUndoStack.length = 0;
}

export function clearItemUndoStack() {
  itemUndoStack.length = 0;
}

export function pushCosmeticUndoState(actionLabel = 'Изменение аксессуара') {
  if (!S.selectedRef || S.selectedRef.kind !== 'cosmetic') return;
  const { ent, item, partIdx, libIdx } = S.selectedRef;
  if (!ent || !item) return;
  try {
    cosmeticUndoStack.push({
      label: actionLabel,
      ent,
      itemId: item.id,
      partIdx: partIdx || 0,
      libIdx: libIdx !== undefined ? libIdx : undefined,
      itemSnapshot: JSON.parse(JSON.stringify(item))
    });
    if (cosmeticUndoStack.length > MAX_UNDO_STEPS) {
      cosmeticUndoStack.shift();
    }
  } catch (e) {
    console.warn('Cosmetic undo snapshot failed:', e);
  }
}

export function undoLastCosmeticAction() {
  if (cosmeticUndoStack.length === 0) {
    showBanner('↩️ В конструкторе аксессуара нет действий для отмены', '#ffce3a');
    return false;
  }
  const prev = cosmeticUndoStack.pop();
  const { ent, itemId, partIdx, libIdx, itemSnapshot } = prev;
  if (!ent || !ent.preset || !Array.isArray(ent.preset.customCosmetics)) return false;

  const idx = ent.preset.customCosmetics.findIndex(c => c.id === itemId);
  const restored = normalizeCosmeticItem(JSON.parse(JSON.stringify(itemSnapshot)));
  if (idx >= 0) {
    ent.preset.customCosmetics[idx] = restored;
  } else {
    ent.preset.customCosmetics.push(restored);
  }

  if (libIdx !== undefined && S.savedCosmeticsLibrary[libIdx]) {
    S.savedCosmeticsLibrary[libIdx] = JSON.parse(JSON.stringify(restored));
  }

  ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
  attachRigToEntity(ent);
  const newGroup = ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === restored);
  selectEditorObject(
    {
      kind: 'cosmetic',
      ent,
      item: restored,
      group: newGroup,
      partIdx: Math.min(partIdx, restored.parts.length - 1),
      libIdx
    },
    true
  );
  sfx.jump();
  showBanner(`↩️ Аксессуар: отменено «${prev.label}» (осталось: ${cosmeticUndoStack.length})`, '#56f0ff');
  return true;
}

export function pushItemUndoState(actionLabel = 'Изменение предмета') {
  if (!S.selectedRef || S.selectedRef.kind !== 'world_item') return;
  const { worldEntry, editMode, partIdx, libIdx } = S.selectedRef;
  if (!worldEntry || !worldEntry.item) return;
  try {
    itemUndoStack.push({
      label: actionLabel,
      worldEntry,
      editMode: editMode || 'part',
      partIdx: partIdx || 0,
      libIdx,
      x: worldEntry.x,
      y: worldEntry.y,
      z: worldEntry.z,
      rotY: worldEntry.rotY || 0,
      itemSnapshot: JSON.parse(JSON.stringify(worldEntry.item))
    });
    if (itemUndoStack.length > MAX_UNDO_STEPS) {
      itemUndoStack.shift();
    }
  } catch (e) {
    console.warn('Item undo snapshot failed:', e);
  }
}

export function undoLastItemAction() {
  if (itemUndoStack.length === 0) {
    showBanner('↩️ В конструкторе предмета нет действий для отмены', '#ffce3a');
    return false;
  }
  const prev = itemUndoStack.pop();
  const { worldEntry, editMode, partIdx, libIdx, x, y, z, rotY, itemSnapshot } = prev;
  if (!worldEntry || !S.worldItems.includes(worldEntry)) return false;

  worldEntry.x = x;
  worldEntry.y = y;
  worldEntry.z = z;
  worldEntry.rotY = rotY;
  worldEntry.item = normalizeItemData(JSON.parse(JSON.stringify(itemSnapshot)));

  if (libIdx !== undefined && S.savedItemsLibrary[libIdx]) {
    S.savedItemsLibrary[libIdx] = JSON.parse(JSON.stringify(worldEntry.item));
  }

  rebuildWorldItemVisual(worldEntry, true);
  selectEditorObject(
    {
      kind: 'world_item',
      worldEntry,
      item: worldEntry.item,
      editMode,
      partIdx,
      libIdx
    },
    true
  );
  sfx.jump();
  showBanner(`↩️ Предмет: отменено «${prev.label}» (осталось: ${itemUndoStack.length})`, '#56f0ff');
  return true;
}

export function pushUndoState(actionLabel = 'Действие') {
  if (S.selectedRef && S.selectedRef.kind === 'cosmetic') {
    pushCosmeticUndoState(actionLabel);
    return;
  }
  if (S.selectedRef && S.selectedRef.kind === 'world_item' && (S.itemStudioOpen || S.selectedRef.editMode !== 'root')) {
    pushItemUndoState(actionLabel);
    return;
  }
  try {
    const snap = JSON.parse(JSON.stringify(serializeSceneState()));
    let selKey = null;
    if (S.selectedRef) {
      if (S.selectedRef.kind === 'block' && S.selectedRef.box) {
        selKey = { kind: 'block', id: S.selectedRef.box.id };
      } else if (S.selectedRef.kind === 'char' && S.selectedRef.ent) {
        selKey = {
          kind: 'char',
          isP: !!S.selectedRef.ent.isP,
          name: S.selectedRef.ent.name
        };
      } else if (S.selectedRef.kind === 'world_item' && S.selectedRef.worldEntry) {
        selKey = { kind: 'world_item', id: S.selectedRef.worldEntry.id };
      }
    }
    S.undoStack.push({ label: actionLabel, data: snap, selKey });
    if (S.undoStack.length > MAX_UNDO_STEPS) {
      S.undoStack.shift();
    }
  } catch (e) {
    console.warn('Undo snapshot failed:', e);
  }
}

export function undoLastStudioAction() {
  if (isPaintModalOpen()) {
    undoPaintAction();
    return;
  }

  if (S.selectedRef && S.selectedRef.kind === 'cosmetic') {
    undoLastCosmeticAction();
    return;
  }

  if (S.selectedRef && S.selectedRef.kind === 'world_item' && itemUndoStack.length > 0) {
    undoLastItemAction();
    return;
  }

  if (!S.undoStack || S.undoStack.length === 0) {
    showBanner('↩️ История действий мира пуста (нечего отменять)', '#ffce3a');
    return;
  }

  if (S.itemStudioOpen) {
    closeItemStudio3D(false);
  }

  const prev = S.undoStack.pop();
  tControls.detach();
  selBoxHelper.visible = false;
  S.selectedRef = null;

  loadSceneState(prev.data, { isUndo: true });

  let restoredRef = null;
  if (prev.selKey) {
    if (prev.selKey.kind === 'block') {
      const foundBox = S.allBlocks.find(b => b.id === prev.selKey.id);
      if (foundBox) restoredRef = { kind: 'block', box: foundBox };
    } else if (prev.selKey.kind === 'world_item') {
      const foundWi = S.worldItems.find(w => w.id === prev.selKey.id);
      if (foundWi) {
        restoredRef = {
          kind: 'world_item',
          worldEntry: foundWi,
          item: foundWi.item,
          editMode: 'root',
          partIdx: 0,
          inWorldPlacement: true
        };
      }
    } else if (prev.selKey.kind === 'char') {
      if (prev.selKey.isP && S.player) {
        restoredRef = { kind: 'char', ent: S.player };
      } else {
        const foundNpc = S.customNPCs.find(n => n.name === prev.selKey.name);
        if (foundNpc) restoredRef = { kind: 'char', ent: foundNpc };
      }
    }
  }

  selectEditorObject(restoredRef);
  sfx.jump();
  showBanner(`↩️ Отменено: ${prev.label} (осталось шагов: ${S.undoStack.length})`, '#56f0ff');
}

export function initStudioController() {
  const brandEl = document.querySelector('.ed-brand');
  if (brandEl) {
    brandEl.innerHTML = '<span>DEBIX STUDIO 3D</span> РЕДАКТОР ИГРЫ';
  }

  const helpBar = document.querySelector('.ed-helpbar');
  if (helpBar) {
    helpBar.innerHTML =
      '<b>ЛКМ</b> — выбрать · <b>СКМ (Зажать)</b> — панорама · <b>ПКМ + WASD/QE</b> — полёт · <b>W/E/R</b> — Гизмо · <b>Ctrl+Z</b> — Отмена';
  }

  const undoBtn = $('undoObjBtn');
  if (undoBtn) {
    undoBtn.onclick = undoLastStudioAction;
  }

  // Вращение всегда кратно 22.5 градусам
  tControls.setRotationSnap(MIN_ROTATION_STEP_RAD);
  tControls.setTranslationSnap(S.snapEnabled ? 0.5 : null);
  tControls.setScaleSnap(S.snapEnabled ? 0.25 : null);

  initStudioGrid();
  updateStudioGrid();

  if ($('btnSnapToggle')) {
    $('btnSnapToggle').textContent = S.snapEnabled ? '🧲 Сетка: 🟢' : '🧲 Сетка: 🔴';
  }
  if ($('btnColliderVis')) {
    $('btnColliderVis').textContent = S.showColliders ? '🔲 Коллайдеры: 🟢' : '🔲 Коллайдеры: 🔴';
  }

  // Кнопки управления изолированной 3D STUDIO предметов, аксессуаров и персонажей
  if ($('openItemStudioBtn')) {
    $('openItemStudioBtn').onclick = () => {
      if (S.itemStudioOpen) {
        closeItemStudio3D(false);
        return;
      }
      if (S.selectedRef && (S.selectedRef.kind === 'world_item' || S.selectedRef.kind === 'cosmetic')) {
        S.selectedRef.inWorldPlacement = false;
        if (S.selectedRef.kind === 'world_item' && S.selectedRef.editMode === 'root') {
          S.selectedRef.editMode = 'part';
        }
        selectEditorObject(S.selectedRef, true);
        return;
      }
      if (S.selectedRef && S.selectedRef.kind === 'char') {
        S.selectedRef.inStudio = true;
        selectEditorObject(S.selectedRef, true);
        return;
      }
      // Если выбран блок/объект сцены — открываем именно ЕГО (как собранный предмет), а НЕ создаём фантомный меч!
      if (S.selectedRef && S.selectedRef.kind === 'block' && S.selectedRef.box) {
        const box = S.selectedRef.box;
        pushUndoState('Открытие объекта в 3D STUDIO');
        const compiled = compileSceneHierarchyToItemData(box);
        const wi = spawnWorldItem(compiled, box.m.position.x, box.m.position.y + 0.4, box.m.position.z);
        selectEditorObject({
          kind: 'world_item',
          worldEntry: wi,
          item: wi.item,
          editMode: 'part',
          partIdx: 0,
          inWorldPlacement: false
        });
        showBanner(`🛠️ Объект «${box.label}» открыт на верстаке 3D STUDIO!`, '#56f0ff');
        return;
      }
      // Если ничего не выбрано — открываем Игрока на подиуме 3D STUDIO без создания лишних мечей в мире
      if (S.player) {
        selectEditorObject({
          kind: 'char',
          ent: S.player,
          editMode: 'root',
          inStudio: true
        });
        return;
      }
    };
  }

  if ($('btnCoordSpace')) {
    $('btnCoordSpace').onclick = () => toggleGizmoSpace();
  }

  if ($('btnISCamFront')) $('btnISCamFront').onclick = () => setItemStudioCameraPreset('front');
  if ($('btnISCamSide')) $('btnISCamSide').onclick = () => setItemStudioCameraPreset('side');
  if ($('btnISCamIso')) $('btnISCamIso').onclick = () => setItemStudioCameraPreset('iso');
  if ($('btnISMannequin')) {
    $('btnISMannequin').onclick = () => {
      S.itemStudioShowMannequin = S.itemStudioShowMannequin === false;
      syncItemStudioPreview();
      if (S.selectedRef && S.selectedRef.mesh) {
        selBoxHelper.setFromObject(S.selectedRef.mesh);
      }
    };
  }
  if ($('btnISPlaceInWorld')) {
    $('btnISPlaceInWorld').onclick = () => closeItemStudio3D(true);
    // Добавляем кнопку «☁️ Загрузить в библиотеку» прямо в верхнюю панель 3D STUDIO
    if (!$('btnISUploadToLibrary')) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.id = 'btnISUploadToLibrary';
      upBtn.className = 'ed-btn apply-oneclick';
      upBtn.style.cssText = 'background:linear-gradient(135deg,#00e676,#00b862);color:#062012;border-color:#00e676;font-weight:900';
      upBtn.title = 'Сохранить и опубликовать этот объект в общую библиотеку (Мастерскую UGC)';
      upBtn.innerHTML = '☁️ Загрузить в библиотеку';
      $('btnISPlaceInWorld').parentNode.insertBefore(upBtn, $('btnISPlaceInWorld'));
      upBtn.onclick = e => {
        e.stopPropagation();
        if (window.__debixPublishSelectedToHub) {
          window.__debixPublishSelectedToHub(S.selectedRef);
        }
      };
    }
  }
  if ($('btnCloseItemStudio')) {
    $('btnCloseItemStudio').onclick = () => closeItemStudio3D(false);
  }

  let _isGizmoDragging = false;
  tControls.addEventListener('dragging-changed', e => {
    _isGizmoDragging = !!e.value;
    if (e.value) {
      recordHierarchyBaseline(S.selectedRef);
      if (S.selectedRef && S.selectedRef.kind === 'world_item') {
        pushItemUndoState('Трансформация предмета');
      } else {
        pushUndoState('Трансформация объекта');
      }
    } else {
      rebuildPhysicsArrays();
      if (S.selectedRef && S.selectedRef.kind === 'folder' && S.selectedRef.folder) {
        syncFolderPivotToChildren(S.selectedRef.folder);
        recordHierarchyBaseline(S.selectedRef);
        tControls.attach(S.selectedRef.mesh);
      }
      recordHierarchyBaseline(S.selectedRef);
    }
  });

  tControls.addEventListener('change', () => {
    // ВАЖНО: Трансформируем объекты и их дочерние элементы ТОЛЬКО при реальном перетаскивании гизмо мышью!
    // Это исключает любые ложные сдвиги при клике, выделении или аттаче гизмо к объекту.
    if (!S.selectedRef || (!_isGizmoDragging && !tControls.dragging)) return;
    if (S.selectedRef.kind === 'block') {
      const box = S.selectedRef.box;

      // Если двигаем/вращаем/масштабируем 3D-маркер точки маршрута (Waypoint)
      if (S.selectedRef.editMode === 'motion_wp' && S.selectedRef.mesh && box.motionData) {
        const md = box.motionData;
        const wpIdx = clamp(S.selectedRef.wpIdx ?? md.activeWaypointIdx ?? 0, 0, md.waypoints.length - 1);
        const wp = md.waypoints[wpIdx];
        const marker = S.selectedRef.mesh;

        marker.scale.x = Math.max(0.1, marker.scale.x);
        marker.scale.y = Math.max(0.1, marker.scale.y);
        marker.scale.z = Math.max(0.1, marker.scale.z);
        snapEulerToStep(marker.rotation);

        // Компенсируем внутренние меши маркера, чтобы кристалл гизмо не искажался при масштабировании
        const invSX = 1 / marker.scale.x;
        const invSY = 1 / marker.scale.y;
        const invSZ = 1 / marker.scale.z;
        for (const ch of marker.children) {
          if (!ch.isLineSegments) ch.scale.set(invSX, invSY, invSZ);
        }

        const rt = box.logicRuntime || {};
        const bPos = rt.basePos || box.m.position;
        const bQuat = rt.baseQuat || box.m.quaternion;
        const bScale = rt.baseScale || box.m.scale;

        wp.sx = Number(marker.scale.x.toFixed(2));
        wp.sy = Number(marker.scale.y.toFixed(2));
        wp.sz = Number(marker.scale.z.toFixed(2));

        // Относительный поворот точки (Q_delta = Q_base^-1 * Q_marker)
        const invBaseQuat = bQuat.clone().invert();
        const deltaQuat = invBaseQuat.multiply(marker.quaternion);
        const deltaEuler = new THREE.Euler().setFromQuaternion(deltaQuat, 'XYZ');
        wp.rx = Math.round(THREE.MathUtils.radToDeg(deltaEuler.x) * 10) / 10;
        wp.ry = Math.round(THREE.MathUtils.radToDeg(deltaEuler.y) * 10) / 10;
        wp.rz = Math.round(THREE.MathUtils.radToDeg(deltaEuler.z) * 10) / 10;

        // Вычисляем смещение dx, dy, dz с учётом выбранной петли (pivotMode)
        const basePivotLocal = getBlockLocalPivotOffset(box, bScale);
        const curPivotLocal = getBlockLocalPivotOffset(box, marker.scale);
        const hingeStart = basePivotLocal.clone().applyQuaternion(bQuat).add(bPos);
        const hingeCur = marker.position.clone().add(curPivotLocal.clone().applyQuaternion(marker.quaternion));

        wp.dx = Number((hingeCur.x - hingeStart.x).toFixed(2));
        wp.dy = Number((hingeCur.y - hingeStart.y).toFixed(2));
        wp.dz = Number((hingeCur.z - hingeStart.z).toFixed(2));

        syncInspectorInputsFromObject();
        return;
      }

      box.m.scale.x = Math.max(0.1, box.m.scale.x);
      box.m.scale.y = Math.max(0.1, box.m.scale.y);
      box.m.scale.z = Math.max(0.1, box.m.scale.z);
      box.w = box.m.scale.x;
      box.h = box.m.scale.y;
      box.d = box.m.scale.z;
      box.cx = box.m.position.x;
      box.cy = box.m.position.y;
      box.cz = box.m.position.z;
      box.x = box.m.position.x;
      box.y = box.m.position.y + box.h / 2;
      box.z = box.m.position.z;
      snapEulerToStep(box.m.rotation);
      box.rx = box.m.rotation.x;
      box.ry = box.m.rotation.y;
      box.rz = box.m.rotation.z;
      if (box.logicRuntime) {
        box.logicRuntime.basePos = box.m.position.clone();
        box.logicRuntime.baseQuat = box.m.quaternion.clone();
        box.logicRuntime.baseScale = box.m.scale.clone();
      }
      if (box.cpVisualGroup) {
        box.cpVisualGroup.position.copy(box.m.position);
        if (box.checkpointData?.enabled) box.cpVisualGroup.rotation.copy(box.m.rotation);
      }
      if (box.haloSprite) box.haloSprite.position.copy(box.m.position);
      box.m.updateMatrixWorld(true);
      rebuildPhysicsArrays();
      
      if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
        window.__debixSyncBlockUpsert(box, true); // true = с троттлингом при перетаскивании мыши
      }

      selBoxHelper.setFromObject(box.m);
      syncInspectorInputsFromObject();
    } else if (S.selectedRef.kind === 'char') {
      const ent = S.selectedRef.ent;
      const editMode = S.selectedRef.editMode || 'root';
      const activeMesh = S.selectedRef.mesh;
      normalizeCharacterGripPoints(ent.preset);

      if (editMode === 'hand_grip' && activeMesh) {
        ent.preset.handGripPoint.x = activeMesh.position.x;
        ent.preset.handGripPoint.y = activeMesh.position.y;
        ent.preset.handGripPoint.z = activeMesh.position.z;
        ent.preset.handGripPoint.rx = activeMesh.rotation.x;
        ent.preset.handGripPoint.ry = activeMesh.rotation.y;
        ent.preset.handGripPoint.rz = activeMesh.rotation.z;
        if (ent.rig?.syncGripSockets) ent.rig.syncGripSockets(ent.preset);
        if (studioMannequinRig?.syncGripSockets && S.itemStudioOpen) {
          studioMannequinRig.syncGripSockets(ent.preset);
        }
        activeMesh.updateMatrixWorld(true);
        selBoxHelper.visible = false;
        syncInspectorInputsFromObject();
      } else if (editMode === 'carry_grip' && activeMesh) {
        ent.preset.carryGripPoint.x = activeMesh.position.x;
        ent.preset.carryGripPoint.y = activeMesh.position.y;
        ent.preset.carryGripPoint.z = activeMesh.position.z;
        ent.preset.carryGripPoint.rx = activeMesh.rotation.x;
        ent.preset.carryGripPoint.ry = activeMesh.rotation.y;
        ent.preset.carryGripPoint.rz = activeMesh.rotation.z;
        if (ent.rig?.syncGripSockets) ent.rig.syncGripSockets(ent.preset);
        if (studioMannequinRig?.syncGripSockets && S.itemStudioOpen) {
          studioMannequinRig.syncGripSockets(ent.preset);
        }
        activeMesh.updateMatrixWorld(true);
        selBoxHelper.visible = false;
        syncInspectorInputsFromObject();
      } else {
        const rigGroup = activeMesh || ent.rig.g;
        const uniformScale = Math.max(0.4, rigGroup.scale.x || 1);
        rigGroup.scale.setScalar(uniformScale);
        ent.scale = uniformScale;

        if (!S.itemStudioOpen) {
          ent.x = rigGroup.position.x;
          ent.y = rigGroup.position.y;
          ent.z = rigGroup.position.z;
          ent.rot = rigGroup.rotation.y;
          ent.yaw = rigGroup.rotation.y;
          if (ent.isCustomNPC) {
            ent.homeX = ent.x;
            ent.homeZ = ent.z;
          }
          if (ent.tag) {
            ent.tag.position.set(ent.x, ent.y + (ent.isArchangel ? 4.5 : 3.35), ent.z);
          }
        } else if (ent.rig && ent.rig.g) {
          ent.rig.g.scale.setScalar(uniformScale);
        }

        rigGroup.updateMatrixWorld(true);
        selBoxHelper.setFromObject(rigGroup);
        if (S.showColliders) rebuildPhysicsArrays();
        syncInspectorInputsFromObject();
      }
    } else if (S.selectedRef.kind === 'cosmetic') {
      const { mesh, item, group, editMode } = S.selectedRef;
      const targetPart = S.selectedRef.part || (item && Array.isArray(item.parts) ? item.parts[S.selectedRef.partIdx || 0] : null);
      if (targetPart) S.selectedRef.part = targetPart;

      if (editMode === 'root' && mesh && item) {
        mesh.scale.x = Math.max(0.1, mesh.scale.x);
        mesh.scale.y = Math.max(0.1, mesh.scale.y);
        mesh.scale.z = Math.max(0.1, mesh.scale.z);
        snapEulerToStep(mesh.rotation);
        item.rootX = mesh.position.x;
        item.rootY = mesh.position.y;
        item.rootZ = mesh.position.z;
        item.rootRX = mesh.rotation.x;
        item.rootRY = mesh.rotation.y;
        item.rootRZ = mesh.rotation.z;
        item.rootSX = mesh.scale.x;
        item.rootSY = mesh.scale.y;
        item.rootSZ = mesh.scale.z;
        if (group) updateGroupRootHitbox(group);
        mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(group || mesh);
        selBoxHelper.visible = true;
        if (S.showColliders) rebuildPhysicsArrays();
        syncInspectorInputsFromObject();
        syncLibraryItemIfEditing(S.selectedRef);
      } else if (mesh && targetPart) {
        mesh.scale.x = Math.max(0.05, mesh.scale.x);
        mesh.scale.y = Math.max(0.05, mesh.scale.y);
        mesh.scale.z = Math.max(0.05, mesh.scale.z);
        snapEulerToStep(mesh.rotation);
        targetPart.x = mesh.position.x;
        targetPart.y = mesh.position.y;
        targetPart.z = mesh.position.z;
        targetPart.rx = mesh.rotation.x;
        targetPart.ry = mesh.rotation.y;
        targetPart.rz = mesh.rotation.z;
        targetPart.sx = mesh.scale.x;
        targetPart.sy = mesh.scale.y;
        targetPart.sz = mesh.scale.z;
        if (group) updateGroupRootHitbox(group);
        mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(mesh);
        selBoxHelper.visible = true;
        if (S.showColliders) rebuildPhysicsArrays();
        syncInspectorInputsFromObject();
        syncLibraryItemIfEditing(S.selectedRef);
      }
    } else if (S.selectedRef.kind === 'world_item') {
      const { worldEntry, item, editMode, mesh, part } = S.selectedRef;
      if (!worldEntry || !item) return;

      if (!editMode || editMode === 'root') {
        if (!S.itemStudioOpen) {
          const g = worldEntry.group;
          g.scale.x = Math.max(0.1, g.scale.x);
          g.scale.y = Math.max(0.1, g.scale.y);
          g.scale.z = Math.max(0.1, g.scale.z);
          snapEulerToStep(g.rotation);
          worldEntry.x = g.position.x;
          worldEntry.y = g.position.y;
          worldEntry.z = g.position.z;
          worldEntry.rotX = g.rotation.x;
          worldEntry.rotY = g.rotation.y;
          worldEntry.rotZ = g.rotation.z;
          worldEntry.scaleX = g.scale.x;
          worldEntry.scaleY = g.scale.y;
          worldEntry.scaleZ = g.scale.z;
          if (worldEntry.tag) {
            worldEntry.tag.position.set(worldEntry.x, worldEntry.y + 1.65 * Math.max(1, g.scale.y), worldEntry.z);
          }
          updateGroupRootHitbox(g);
          g.updateMatrixWorld(true);
          selBoxHelper.setFromObject(g);
          if (S.showColliders) rebuildPhysicsArrays();
        } else if (mesh) {
          // Трансформация всего предмета целиком (Root) прямо внутри 3D STUDIO
          mesh.scale.x = Math.max(0.1, mesh.scale.x);
          mesh.scale.y = Math.max(0.1, mesh.scale.y);
          mesh.scale.z = Math.max(0.1, mesh.scale.z);
          snapEulerToStep(mesh.rotation);
          item.rootX = mesh.position.x;
          item.rootY = mesh.position.y;
          item.rootZ = mesh.position.z;
          item.rootRX = mesh.rotation.x;
          item.rootRY = mesh.rotation.y;
          item.rootRZ = mesh.rotation.z;
          item.rootSX = mesh.scale.x;
          item.rootSY = mesh.scale.y;
          item.rootSZ = mesh.scale.z;
          updateGroupRootHitbox(worldEntry.group);
          mesh.updateMatrixWorld(true);
          selBoxHelper.setFromObject(worldEntry.group);
          syncItemStudioPreview();
        }
      } else if ((editMode === 'part' || editMode === 'proj_part') && mesh && part) {
        mesh.scale.x = Math.max(0.05, mesh.scale.x);
        mesh.scale.y = Math.max(0.05, mesh.scale.y);
        mesh.scale.z = Math.max(0.05, mesh.scale.z);
        snapEulerToStep(mesh.rotation);
        part.x = mesh.position.x;
        part.y = mesh.position.y;
        part.z = mesh.position.z;
        part.rx = mesh.rotation.x;
        part.ry = mesh.rotation.y;
        part.rz = mesh.rotation.z;
        part.sx = mesh.scale.x;
        part.sy = mesh.scale.y;
        part.sz = mesh.scale.z;
        updateGroupRootHitbox(worldEntry.group);
        mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(mesh);
        if (S.itemStudioOpen) syncItemStudioPreview();
        if (S.showColliders) rebuildPhysicsArrays();
      } else if (editMode === 'grip' && mesh) {
        snapEulerToStep(mesh.rotation);
        item.gripPoint.x = -mesh.position.x;
        item.gripPoint.y = -mesh.position.y;
        item.gripPoint.z = -mesh.position.z;
        item.gripPoint.rx = mesh.rotation.x;
        item.gripPoint.ry = mesh.rotation.y;
        item.gripPoint.rz = mesh.rotation.z;
        mesh.updateMatrixWorld(true);
        selBoxHelper.visible = false;
        if (S.itemStudioOpen) syncItemStudioPreview();
      } else if (editMode === 'muzzle' && mesh) {
        item.muzzlePoint.x = mesh.position.x;
        item.muzzlePoint.y = mesh.position.y;
        item.muzzlePoint.z = mesh.position.z;
        mesh.updateMatrixWorld(true);
        selBoxHelper.visible = false;
      }

      syncInspectorInputsFromObject();
      syncLibraryItemIfEditing(S.selectedRef);
    } else if (S.selectedRef.kind === 'folder' && S.selectedRef.mesh) {
      snapEulerToStep(S.selectedRef.mesh.rotation);
      S.selectedRef.mesh.updateMatrixWorld(true);
    } else if (S.selectedRef.kind === 'empty' && S.selectedRef.emptyObj) {
      const emp = S.selectedRef.emptyObj;
      const g = emp.group;
      g.scale.x = Math.max(0.1, g.scale.x);
      g.scale.y = Math.max(0.1, g.scale.y);
      g.scale.z = Math.max(0.1, g.scale.z);
      snapEulerToStep(g.rotation);
      emp.x = g.position.x;
      emp.y = g.position.y;
      emp.z = g.position.z;
      emp.rx = g.rotation.x;
      emp.ry = g.rotation.y;
      emp.rz = g.rotation.z;
      emp.sx = g.scale.x;
      emp.sy = g.scale.y;
      emp.sz = g.scale.z;
      g.updateMatrixWorld(true);
      syncInspectorInputsFromObject();
    }

    // Трансформируем все вложенные дочерние элементы вслед за родителем (как в Unity)
    propagateHierarchyTransform(S.selectedRef);
  });

  $('openStudioBtn').addEventListener('click', () => toggleStudioMode('edit'));
  $('startEditorBtn')?.addEventListener('click', () => {
    initAudio();
    toggleStudioMode('edit');
  });
  $('openWorldSettingsBtn').addEventListener('click', () => selectEditorObject(null));

  $('gizmoMove').onclick = () => setGizmoMode('translate');
  $('gizmoRot').onclick = () => setGizmoMode('rotate');
  $('gizmoScale').onclick = () => setGizmoMode('scale');

  $('btnSnapToggle').onclick = () => {
    toggleGridSnap();
  };

  $('btnColliderVis').onclick = () => {
    S.showColliders = !S.showColliders;
    $('btnColliderVis').textContent = S.showColliders ? '🔲 Коллайдеры: 🟢' : '🔲 Коллайдеры: 🔴';
    $('btnColliderVis').classList.toggle('active', S.showColliders);
    rebuildPhysicsArrays();
  };

  $('dupObjBtn').onclick = duplicateSelected;
  $('delObjBtn').onclick = deleteSelected;
}

function hideAllCharacterGripMarkers() {
  if (S.player?.rig?.setGripMarkersVisible) S.player.rig.setGripMarkersVisible(false);
  for (const n of S.customNPCs) {
    if (n.rig?.setGripMarkersVisible) n.rig.setGripMarkersVisible(false);
  }
  for (const q of S.queueLine) {
    if (q.rig?.setGripMarkersVisible) q.rig.setGripMarkersVisible(false);
  }
  if (S.archangelEnt?.rig?.setGripMarkersVisible) {
    S.archangelEnt.rig.setGripMarkersVisible(false);
  }
}

export function enforcePlayModeCleanVisuals() {
  if (S.itemStudioOpen) {
    closeItemStudio3D(false);
  }
  setEmptyObjectsHelperVisible(false);
  clearStudioMotionHelpers();
  hideAllCharacterGripMarkers();
  for (const wi of S.worldItems) {
    rebuildWorldItemVisual(wi, false);
  }
  tControls.detach();
  tControls.visible = false;
  tControls.enabled = false;
  selBoxHelper.visible = false;
  rebuildPhysicsArrays();
  updateStudioGrid();
}

export function cleanupStudioVisualsForPlay() {
  if (S.itemStudioOpen) {
    closeItemStudio3D(false);
  }
  S.pickingTargetCallback = null;
  setEmptyObjectsHelperVisible(false);
  clearStudioMotionHelpers();
  hideAllCharacterGripMarkers();
  for (const wi of S.worldItems) {
    rebuildWorldItemVisual(wi, false);
  }
  tControls.detach();
  tControls.visible = false;
  selBoxHelper.visible = false;
  rebuildPhysicsArrays();
  updateStudioGrid();
}

export function toggleStudioMode(forceState) {
  const target = forceState || (S.state === 'edit' ? 'play' : 'edit');
  if (target === 'edit') {
    if (S.playerDead) completePlayerRespawn(false);
    if (S.player) S.player.isFlying = false;
    for (const n of S.customNPCs) {
      if (n._deadCooldown > 0 || n._permanentlyDead) {
        n._deadCooldown = 0;
        n._permanentlyDead = false;
        n.hp = n.maxHp || 100;
        if (n.rig?.g) n.rig.g.visible = true;
        if (n.tag) n.tag.visible = true;
      }
    }
    S.state = 'edit';
    tControls.visible = true;
    tControls.enabled = true;
    S.isReloadingHold = false;
    S.reloadHoldT = 0;
    try {
      if (document.pointerLockElement === cv) document.exitPointerLock();
    } catch (_) {}
    $('menu').hidden = true;
    $('topbar').hidden = true;
    $('shopPanel').hidden = true;
    $('hotbar').hidden = true;
    $('hint').hidden = true;
    $('touch').hidden = true;
    if ($('deathOverlay')) $('deathOverlay').hidden = true;
    if ($('throwChargeHUD')) $('throwChargeHUD').hidden = true;
    if ($('reloadHoldHUD')) $('reloadHoldHUD').hidden = true;
    if ($('crosshairHUD')) $('crosshairHUD').hidden = true;
    if ($('mpChatWidget')) $('mpChatWidget').hidden = true;
    if ($('mpFloatingModal')) $('mpFloatingModal').hidden = true;
    $('studioUI').hidden = false;

    for (const wi of S.worldItems) {
      const isSelWi = S.selectedRef && S.selectedRef.kind === 'world_item' && S.selectedRef.worldEntry === wi;
      rebuildWorldItemVisual(wi, !!isSelWi);
    }

    if (S.selectedRef && S.selectedRef.kind === 'char' && S.selectedRef.ent?.rig?.setGripMarkersVisible) {
      S.selectedRef.ent.rig.setGripMarkersVisible(true);
    }

    if (S.player && !S.itemStudioOpen) {
      S.edCamPos.set(S.player.x + 8, S.player.y + 7, S.player.z + 12);
      S.edYaw = 0.55;
      S.edPitch = -0.35;
    }
    if (S.selectedRef) {
      selectEditorObject(S.selectedRef, true);
    } else {
      refreshHierarchyUI();
      renderInspectorUI();
    }
    setEmptyObjectsHelperVisible(true);
    rebuildPhysicsArrays();
    updateStudioGrid();
    showBanner('🛠️ DebiX Studio 3D! СКМ — панорама, ПКМ+WASD — полёт, Ctrl+Z — контекстная отмена.', '#56f0ff');
  } else {
    S.state = 'play';
    cleanupStudioVisualsForPlay();
    $('studioUI').hidden = true;
    $('paintModal').hidden = true;
    $('topbar').hidden = false;
    $('hotbar').hidden = false;
    if ($('mpChatWidget')) $('mpChatWidget').hidden = false;
    if (coarse) $('touch').hidden = false;
    if (S.gameMode && S.gameMode.onEnterPlay) {
      S.gameMode.onEnterPlay();
    }
    updateShopUI();
  }
}

export function setGizmoMode(mode) {
  tControls.setMode(mode);
  $('gizmoMove').classList.toggle('active', mode === 'translate');
  $('gizmoRot').classList.toggle('active', mode === 'rotate');
  $('gizmoScale').classList.toggle('active', mode === 'scale');
}

export function toggleGizmoSpace() {
  const next = tControls.space === 'world' ? 'local' : 'world';
  setGizmoSpace(next);
  showBanner(next === 'world' ? '🌐 Система координат: Мировая (World)' : '📐 Система координат: Локальная (Local)', '#56f0ff');
}

export function setGizmoSpace(space) {
  tControls.setSpace(space);
  if (tControls._gizmo) {
    tControls._gizmo.space = space;
    tControls._gizmo.updateMatrixWorld(true);
  }
  const btn = $('btnCoordSpace');
  if (btn) {
    btn.textContent = space === 'world' ? '🌐 Мир (X)' : '📐 Локал (X)';
    btn.title = space === 'world'
      ? 'Система координат: Мировая (X). Нажмите для переключения на Локальную'
      : 'Система координат: Локальная (X). Нажмите для переключения на Мировую';
    btn.classList.toggle('active', space === 'local');
  }
}

export function selectEditorObject(ref, keepUndoStack = false) {
  // Если активен режим 3D-Пипетки выбора цели для Связи или Телепорта
  if (S.pickingTargetCallback && ref && ref.kind === 'block' && ref.box) {
    const cb = S.pickingTargetCallback;
    S.pickingTargetCallback = null;
    cb(ref.box);
    return;
  }
  S.pickingTargetCallback = null;

  tControls.setRotationSnap(MIN_ROTATION_STEP_RAD);

  const prevCos = S.selectedRef && S.selectedRef.kind === 'cosmetic' ? S.selectedRef.item : null;
  const nextCos = ref && ref.kind === 'cosmetic' ? ref.item : null;
  if (!keepUndoStack && (!nextCos || (prevCos && prevCos.id !== nextCos.id))) {
    clearCosmeticUndoStack();
  }

  const prevItem = S.selectedRef && S.selectedRef.kind === 'world_item' ? S.selectedRef.item : null;
  const nextItem = ref && ref.kind === 'world_item' ? ref.item : null;
  if (!keepUndoStack && (!nextItem || (prevItem && prevItem.id !== nextItem.id))) {
    clearItemUndoStack();
  }

  const prevWiEntry = S.selectedRef && S.selectedRef.kind === 'world_item' ? S.selectedRef.worldEntry : null;
  const nextWiEntry = ref && ref.kind === 'world_item' ? ref.worldEntry : null;
  if (prevWiEntry && prevWiEntry !== nextWiEntry && S.worldItems.includes(prevWiEntry)) {
    rebuildWorldItemVisual(prevWiEntry, false);
  }

  // Определяем, должно ли быть открыто изолированное окно 3D STUDIO
  const shouldOpen3DStudio =
    !!ref &&
    ((ref.kind === 'cosmetic' && !ref.inWorldPlacement) ||
     (ref.kind === 'world_item' && !ref.inWorldPlacement) ||
     (ref.kind === 'char' && ref.inStudio) ||
     (ref.kind === 'block' && ref.inStudio));

  if (!shouldOpen3DStudio && S.itemStudioOpen) {
    S.itemStudioOpen = false;
    if (itemStudioStageGroup) itemStudioStageGroup.visible = false;
    if ($('itemStudioOverlay')) $('itemStudioOverlay').hidden = true;
    if ($('openItemStudioBtn')) $('openItemStudioBtn').classList.remove('active');
    restoreItemStudioSubjectsToWorld();
    if (savedMapCamera) {
      S.edCamPos.copy(savedMapCamera.pos);
      S.edYaw = savedMapCamera.yaw;
      S.edPitch = savedMapCamera.pitch;
      savedMapCamera = null;
    }
  }

  hideAllCharacterGripMarkers();

  S.selectedRef = ref;
  const worldBtn = $('openWorldSettingsBtn');
  if (worldBtn) worldBtn.classList.toggle('active', !ref);

  if (!ref) {
    tControls.detach();
    selBoxHelper.visible = false;
    $('inspTypeBadge').textContent = '🌤️ Мир';
    refreshHierarchyUI();
    renderInspectorUI();
    return;
  }
  if (ref.kind === 'folder' && ref.folder) {
    setGizmoSpace('local');
    ref.mesh = syncFolderPivotToChildren(ref.folder);
    recordHierarchyBaseline(ref);
    tControls.attach(ref.mesh);
    selBoxHelper.visible = false;
    $('inspTypeBadge').textContent = `📁 ${ref.folder.name}`;
    refreshHierarchyUI();
    renderInspectorUI();
    return;
  }
  if (ref.kind === 'empty' && ref.emptyObj) {
    setGizmoSpace('local');
    const emp = ref.emptyObj;
    ref.mesh = emp.group;
    emp.group.updateMatrixWorld(true);
    recordHierarchyBaseline(ref);
    tControls.attach(emp.group);
    selBoxHelper.visible = false;
    $('inspTypeBadge').textContent = `🎯 ${emp.name}`;
    refreshHierarchyUI();
    renderInspectorUI();
    return;
  }
  if (ref.kind === 'block') {
    setGizmoSpace('local');
    ref.box.m.updateMatrixWorld(true);
    syncStudioMotionAndSignalHelpers();

    if (ref.editMode === 'motion_wp' && Array.isArray(ref.box._motionWaypointProxies)) {
      const wpIdx = Math.max(0, Math.min(ref.wpIdx ?? (ref.box.motionData?.activeWaypointIdx || 0), ref.box._motionWaypointProxies.length - 1));
      ref.wpIdx = wpIdx;
      if (ref.box.motionData) ref.box.motionData.activeWaypointIdx = wpIdx;
      const wpProxy = ref.box._motionWaypointProxies[wpIdx] || ref.box.m;
      ref.mesh = wpProxy;
      tControls.attach(wpProxy);
      selBoxHelper.visible = false;
      $('inspTypeBadge').textContent = `📍 Точка #${wpIdx + 1} (${ref.box.label})`;
    } else {
      ref.editMode = 'root';
      ref.mesh = ref.box.m;
      recordHierarchyBaseline(ref);
      tControls.attach(ref.box.m);
      selBoxHelper.setFromObject(ref.box.m);
      selBoxHelper.visible = true;
      $('inspTypeBadge').textContent = '🧱 Объект сцены';
    }
  } else if (ref.kind === 'char') {
    const ent = ref.ent;
    if (!ref.editMode) ref.editMode = 'root';
    normalizeCharacterGripPoints(ent.preset);
    if (ent.rig.syncGripSockets) ent.rig.syncGripSockets(ent.preset);
    if (ent.rig.setGripMarkersVisible) ent.rig.setGripMarkersVisible(!ref.inStudio);

    if (ref.inStudio) {
      openItemStudio3D(ref);
    } else {
      setGizmoSpace('local');
      if (ref.editMode === 'hand_grip' && ent.rig.handGripMarker) {
        ent.rig.armR.rotation.set(-Math.PI / 2, 0, 0);
        ent.rig.g.updateMatrixWorld(true);
        ref.mesh = ent.rig.handGripMarker;
        tControls.attach(ref.mesh);
        selBoxHelper.visible = false;
      } else if (ref.editMode === 'carry_grip' && ent.rig.carryGripMarker) {
        ent.rig.armL.rotation.set(-1.35, -0.28, 0.08);
        ent.rig.armR.rotation.set(-1.35, 0.28, -0.08);
        ent.rig.g.updateMatrixWorld(true);
        ref.mesh = ent.rig.carryGripMarker;
        tControls.attach(ref.mesh);
        selBoxHelper.visible = false;
      } else {
        ent.rig.armL.rotation.set(0, 0, 0);
        ent.rig.armR.rotation.set(0, 0, 0);
        ent.rig.g.updateMatrixWorld(true);
        ref.mesh = ent.rig.g;
        tControls.attach(ref.mesh);
        selBoxHelper.setFromObject(ref.mesh);
        selBoxHelper.visible = true;
      }
    }

    $('inspTypeBadge').textContent = ent.isP ? '👑 Игрок' : '🤖 NPC Бот';
  } else if (ref.kind === 'cosmetic') {
    const { ent, item } = ref;
    normalizeCosmeticItem(item);
    if (!ref.editMode) ref.editMode = ref.inWorldPlacement ? 'root' : 'part';
    const partIdx = Math.min(Math.max(0, ref.partIdx ?? 0), Math.max(0, item.parts.length - 1));
    ref.partIdx = partIdx;
    ref.part = item.parts[partIdx];

    if (!ref.inWorldPlacement) {
      setGizmoSpace('local');
      openItemStudio3D(ref);
    } else {
      if (ent?.rig?.g) ent.rig.g.updateMatrixWorld(true);
      const group = ref.group || ent?.rig?.customCosMeshes?.find(g => g.userData?.cosmeticItem === item);
      if (group) {
        group.visible = true;
        group.updateMatrixWorld(true);
      }
      const partMeshes = (group && group.userData?.partMeshes) || [];
      const holder = (group && group.userData?.partsHolder) || group;
      const mesh = ref.editMode === 'root' ? holder : (partMeshes[partIdx] || holder);

      ref.group = group;
      ref.mesh = mesh;

      if (mesh) {
        mesh.updateMatrixWorld(true);
        setGizmoSpace('local');
        tControls.attach(mesh);
        selBoxHelper.setFromObject(ref.editMode === 'root' ? (group || mesh) : mesh);
        selBoxHelper.visible = true;
      }
    }
    $('inspTypeBadge').textContent = item.parentSlot === 'pet' ? '🐾 3D Питомец' : '🎩 3D Аксессуар';
  } else if (ref.kind === 'world_item') {
    const { worldEntry } = ref;
    const item = normalizeItemData(worldEntry.item);
    ref.item = item;
    if (!ref.editMode) ref.editMode = ref.inWorldPlacement ? 'root' : 'part';

    rebuildWorldItemVisual(worldEntry, true);
    if (shouldOpen3DStudio) {
      openItemStudio3D(ref);
    }

    const rootGroup = worldEntry.group;
    const partsHolder = rootGroup.userData.partsHolder || rootGroup;

    if (ref.editMode === 'proj_part') {
      const projGroup = buildItemGroup(item, { isProjectile: true, showMarkers: false, applyGripOffset: false });
      projGroup.position.set(
        item.muzzlePoint.x || 0,
        (item.muzzlePoint.y || 0) + 0.45,
        (item.muzzlePoint.z ?? -0.8) - 0.55
      );
      projGroup.traverse(o => {
        o.userData.editorRef = { kind: 'world_item', worldEntry };
      });
      rootGroup.add(projGroup);
      ref.projPreviewGroup = projGroup;

      const pIdx = Math.min(Math.max(0, ref.partIdx ?? 0), Math.max(0, item.projectileParts.length - 1));
      ref.partIdx = pIdx;
      ref.part = item.projectileParts[pIdx];
      ref.mesh = projGroup.userData.partMeshes[pIdx] || projGroup;
    } else if (ref.editMode === 'part') {
      const pIdx = Math.min(Math.max(0, ref.partIdx ?? 0), Math.max(0, item.parts.length - 1));
      ref.partIdx = pIdx;
      ref.part = item.parts[pIdx];
      ref.mesh = rootGroup.userData.partMeshes[pIdx] || rootGroup;
    } else if (ref.editMode === 'grip') {
      ref.mesh = rootGroup.userData.gripMarker || rootGroup;
    } else if (ref.editMode === 'muzzle') {
      ref.mesh = rootGroup.userData.muzzleMarker || rootGroup;
    } else {
      // editMode === 'root': на карте двигаем rootGroup, в 3D Студии — partsHolder (весь предмет целиком)
      ref.mesh = S.itemStudioOpen ? partsHolder : rootGroup;
    }

    if (ref.mesh) {
      ref.mesh.updateMatrixWorld(true);
      setGizmoSpace('local');
      tControls.attach(ref.mesh);
      if (ref.editMode === 'grip' || ref.editMode === 'muzzle') {
        selBoxHelper.visible = false;
      } else {
        selBoxHelper.setFromObject(ref.editMode === 'root' ? rootGroup : ref.mesh);
        selBoxHelper.visible = true;
      }
    }
    $('inspTypeBadge').textContent = `${item.icon || '🗡️'} Предмет / Оружие`;
  }
  recordHierarchyBaseline(ref);
  refreshHierarchyUI();
  renderInspectorUI();
}

export function focusOnSelected() {
  if (!S.selectedRef) return;
  if (S.itemStudioOpen) {
    setItemStudioCameraPreset('iso');
    return;
  }
  let obj = null;
  if (S.selectedRef.kind === 'block') obj = S.selectedRef.box.m;
  else if (S.selectedRef.kind === 'char') obj = S.selectedRef.ent.rig.g;
  else if (S.selectedRef.kind === 'world_item') obj = S.selectedRef.mesh || S.selectedRef.worldEntry.group;
  else obj = S.selectedRef.mesh;

  if (!obj) return;
  const p = new THREE.Vector3();
  obj.getWorldPosition(p);
  const fwd = new THREE.Vector3(
    -Math.sin(S.edYaw) * Math.cos(S.edPitch),
    Math.sin(S.edPitch),
    -Math.cos(S.edYaw) * Math.cos(S.edPitch)
  );
  S.edCamPos.copy(p).addScaledVector(fwd, -7).add(new THREE.Vector3(0, 1.5, 0));
}

export function makeNextNumberedCopyName(rawName, existingNamesList = []) {
  const clean = String(rawName || 'Объект')
    .replace(/(?:_Copy|\s*\(Копия\))+/gi, '')
    .replace(/\s+\d+$/, '')
    .trim() || 'Объект';
  const used = new Set(existingNamesList.map(n => String(n || '').trim().toLowerCase()));
  let num = 2;
  while (used.has(`${clean} ${num}`.toLowerCase())) {
    num++;
  }
  return `${clean} ${num}`;
}

function cloneSingleSceneBlockExact(src, customLabel = null, parentKeyOverride = undefined) {
  const m = src.m;
  const nextLabel = customLabel || makeNextNumberedCopyName(src.label, S.allBlocks.map(b => b.label));
  const copy = addSceneBlock({
    x: m.position.x,
    y: m.position.y + m.scale.y / 2,
    z: m.position.z,
    w: m.scale.x,
    h: m.scale.y,
    d: m.scale.z,
    shape: src.shape,
    surfaceType: src.surfaceType || 'studs',
    colliderShape: src.colliderShape || 'auto',
    colorHex: src.colorHex,
    gold: src.gold,
    customTexDataURL: src.customTexDataURL,
    matterState: src.matterState,
    bounciness: src.bounciness,
    conveyorVz: src.conveyorVz,
    conveyorVx: src.conveyorVx,
    damageOnContact: src.damageOnContact,
    teleportToCheckpoint: src.teleportToCheckpoint,
    spinSpeed: src.spinSpeed,
    components: src.components ? JSON.parse(JSON.stringify(src.components)) : null,
    interactionData: src.interactionData ? JSON.parse(JSON.stringify(src.interactionData)) : null,
    motionData: src.motionData ? JSON.parse(JSON.stringify(src.motionData)) : null,
    signalData: src.signalData ? JSON.parse(JSON.stringify(src.signalData)) : null,
    costData: src.costData ? JSON.parse(JSON.stringify(src.costData)) : null,
    checkpointData: src.checkpointData ? JSON.parse(JSON.stringify(src.checkpointData)) : null,
    spawnerData: src.spawnerData ? JSON.parse(JSON.stringify(src.spawnerData)) : null,
    particleData: src.particleData ? JSON.parse(JSON.stringify(src.particleData)) : null,
    lightData: src.lightData ? JSON.parse(JSON.stringify(src.lightData)) : null,
    logicData: src.logicData ? JSON.parse(JSON.stringify(src.logicData)) : null,
    label: nextLabel,
    isCustom: true
  });

  if (src.soundData) copy.soundData = JSON.parse(JSON.stringify(src.soundData));
  if (src.colliderScale) copy.colliderScale = Object.assign({}, src.colliderScale);
  copy.parentKey = parentKeyOverride !== undefined ? parentKeyOverride : (src.parentKey || null);
  copy.sceneFolderId = src.sceneFolderId || null;

  copy.m.position.copy(m.position);
  copy.m.rotation.copy(m.rotation);
  copy.m.scale.copy(m.scale);
  copy.m.updateMatrixWorld(true);
  if (copy.logicRuntime) {
    copy.logicRuntime.basePos = copy.m.position.clone();
    copy.logicRuntime.baseQuat = copy.m.quaternion.clone();
    copy.logicRuntime.baseScale = copy.m.scale.clone();
  }
  if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
    window.__debixSyncBlockUpsert(copy, false);
  }
  return copy;
}

export function duplicateSelected() {
  if (!S.selectedRef) return;
  if (S.selectedRef.kind === 'block') {
    pushUndoState('Дублирование объекта');
    const src = S.selectedRef.box;
    // Спавним дубликат строго внутри дублируемого объекта (0-offset) с 100% сохранением компонентов (примитив/пустышка/блок)
    const copy = cloneSingleSceneBlockExact(src, null, src.parentKey || null);

    // Если у объекта есть дочерние блоки в иерархии — клонируем их тоже с сохранением связей
    const descendants = getAllSceneDescendants(`block:${src.id}`);
    if (descendants.length > 0) {
      const keyMap = new Map([[`block:${src.id}`, `block:${copy.id}`]]);
      for (const d of descendants) {
        if (d.kind === 'block' && d.obj) {
          const mappedParent = keyMap.get(d.obj.parentKey) || `block:${copy.id}`;
          const childCopy = cloneSingleSceneBlockExact(d.obj, null, mappedParent);
          keyMap.set(`block:${d.obj.id}`, `block:${childCopy.id}`);
        }
      }
    }

    rebuildPhysicsArrays();
    selectEditorObject({ kind: 'block', box: copy });
    sfx.jump();
  } else if (S.selectedRef.kind === 'world_item') {
    const { worldEntry, item, editMode, part, libIdx } = S.selectedRef;
    if (editMode === 'part' || editMode === 'proj_part') {
      const targetArr = editMode === 'proj_part' ? item.projectileParts : item.parts;
      if (targetArr.length >= MAX_ITEM_PARTS) {
        showBanner(`Максимум ${MAX_ITEM_PARTS} примитивов!`, '#ff3e3e');
        return;
      }
      pushItemUndoState('Дублирование примитива предмета');
      const srcPart = part || targetArr[0];
      // Спавним дубликат примитива ровно в тех же координатах (0-offset)
      const copyPart = Object.assign({}, JSON.parse(JSON.stringify(srcPart)), {
        id: 'ipt_' + Date.now(),
        name: `${srcPart.name || 'Часть'} #${targetArr.length + 1}`,
        x: srcPart.x || 0,
        y: srcPart.y || 0,
        z: srcPart.z || 0
      });
      targetArr.push(copyPart);
      syncLibraryItemIfEditing(S.selectedRef);
      selectEditorObject({
        kind: 'world_item',
        worldEntry,
        item,
        editMode,
        partIdx: targetArr.length - 1,
        libIdx
      }, true);
      sfx.jump();
      return;
    }

    pushUndoState('Дублирование предмета в мире');
    const copyData = JSON.parse(JSON.stringify(item));
    copyData.id = 'item_' + Date.now();
    // Спавним дубликат предмета строго внутри оригинала (0-offset) со всеми углами и масштабом
    const newWi = spawnWorldItem(copyData, worldEntry.x, worldEntry.y, worldEntry.z, 0, 0, 0, {
      rotX: worldEntry.rotX || 0,
      rotY: worldEntry.rotY || 0,
      rotZ: worldEntry.rotZ || 0,
      scaleX: worldEntry.scaleX || 1,
      scaleY: worldEntry.scaleY || 1,
      scaleZ: worldEntry.scaleZ || 1
    });
    newWi.parentKey = worldEntry.parentKey || null;
    if (window.__debixSyncWorldItemUpsert && !S.isApplyingRemoteSync) {
      window.__debixSyncWorldItemUpsert(newWi, false);
    }
    selectEditorObject({
      kind: 'world_item',
      worldEntry: newWi,
      item: newWi.item,
      editMode: S.itemStudioOpen ? 'part' : 'root',
      partIdx: 0,
      inWorldPlacement: !S.itemStudioOpen
    });
    sfx.jump();
  } else if (S.selectedRef.kind === 'char') {
    pushUndoState('Дублирование NPC');
    const src = S.selectedRef.ent;
    // Спавним дубликат NPC строго внутри оригинала (0-offset) со всеми модулями поведения и оружием
    const nextNpcName = makeNextNumberedCopyName(src.name, S.customNPCs.map(n => n.name));
    // Спавним дубликат NPC строго внутри оригинала (0-offset) со всеми модулями поведения и оружием
    const npc = spawnCustomNPC(Object.assign({}, JSON.parse(JSON.stringify(src.preset || {})), {
      name: nextNpcName,
      chat: src.chat,
      x: src.x,
      y: src.y,
      z: src.z,
      rot: src.rot || 0,
      scale: src.rig.g.scale.x,
      hpEnabled: src.hpEnabled,
      maxHp: src.maxHp,
      hp: src.maxHp,
      meleeDamage: src.meleeDamage,
      walkSpeed: src.walkSpeed,
      jumpPower: src.jumpPower,
      wander: src.wander,
      aggressive: src.aggressive,
      equippedItem: src.equippedItem ? JSON.parse(JSON.stringify(src.equippedItem)) : null,
      aiModules: src.aiModules ? JSON.parse(JSON.stringify(src.aiModules)) : null
    }));
    npc.parentKey = src.parentKey || null;
    npc.rot = src.rot || 0;
    npc.yaw = src.yaw || src.rot || 0;
    if (npc.rig && npc.rig.g) {
      npc.rig.g.rotation.y = npc.rot;
      npc.rig.g.updateMatrixWorld(true);
    }
    selectEditorObject({ kind: 'char', ent: npc, inStudio: Boolean(S.selectedRef.inStudio) });
    sfx.coil();
  } else if (S.selectedRef.kind === 'cosmetic') {
    const { ent, item, part, libIdx } = S.selectedRef;
    normalizeCosmeticItem(item);
    if (item.parts.length >= MAX_COSMETIC_PARTS) {
      showBanner(`Достигнут лимит: максимум ${MAX_COSMETIC_PARTS} примитивов в одном аксессуаре!`, '#ff3e3e');
      return;
    }
    pushCosmeticUndoState('Дублирование примитива');
    const srcPart = part || item.parts[0];
    // Спавним дубликат примитива аксессуара ровно в тех же координатах (0-offset)
    const copyPart = Object.assign({}, JSON.parse(JSON.stringify(srcPart)), {
      id: 'pt_' + Date.now(),
      name: `Примитив #${item.parts.length + 1}`,
      x: (srcPart && srcPart.x) || 0,
      y: (srcPart && srcPart.y) || 0,
      z: (srcPart && srcPart.z) || 0
    });
    item.parts.push(copyPart);
    syncLibraryItemIfEditing(S.selectedRef);
    ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
    attachRigToEntity(ent);
    const newGroup = ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === item);
    selectEditorObject(
      {
        kind: 'cosmetic',
        ent,
        item,
        group: newGroup,
        partIdx: item.parts.length - 1,
        libIdx,
        inWorldPlacement: Boolean(S.selectedRef.inWorldPlacement)
      },
      true
    );
    sfx.jump();
    showBanner(`📋 Примитив дублирован (${item.parts.length} /${MAX_COSMETIC_PARTS})`, '#00e676');
  } else if (S.selectedRef.kind === 'empty' && S.selectedRef.emptyObj) {
    pushUndoState('Дублирование пустышки');
    const src = S.selectedRef.emptyObj;
    const nextEmpName = makeNextNumberedCopyName(src.name, (S.emptyObjects || []).map(e => e.name));
    const copy = spawnEmptyObject({
      name: nextEmpName,
      x: src.x, y: src.y, z: src.z,
      rx: src.rx, ry: src.ry, rz: src.rz,
      sx: src.sx, sy: src.sy, sz: src.sz,
      parentKey: src.parentKey
    });
    selectEditorObject({ kind: 'empty', emptyObj: copy });
    sfx.jump();
  }
}

function removeSceneNodeByKindAndObj(kind, obj) {
  if (!obj) return;
  if (kind === 'block') {
    removeBlockHalo(obj);
    if (obj.m) scene.remove(obj.m);
    if (obj.cpVisualGroup) scene.remove(obj.cpVisualGroup);
    const idx = S.allBlocks.indexOf(obj);
    if (idx >= 0) {
      const removedId = obj.id;
      S.allBlocks.splice(idx, 1);
      if (window.__debixSyncBlockDelete && !S.isApplyingRemoteSync) {
        window.__debixSyncBlockDelete(removedId);
      }
    }
  } else if (kind === 'world_item') {
    if (obj.group) scene.remove(obj.group);
    if (obj.tag) scene.remove(obj.tag);
    const idx = S.worldItems.indexOf(obj);
    if (idx >= 0) {
      const removedId = obj.id;
      S.worldItems.splice(idx, 1);
      if (window.__debixSyncWorldItemDelete && !S.isApplyingRemoteSync) {
        window.__debixSyncWorldItemDelete(removedId);
      }
    }
  } else if (kind === 'char') {
    if (obj.isP || (!obj.isCustomNPC && !obj.isArchangel)) return;
    if (obj.rig?.g) scene.remove(obj.rig.g);
    if (obj.tag) scene.remove(obj.tag);
    const idx = S.customNPCs.indexOf(obj);
    if (idx >= 0) {
      const removedId = obj.id;
      S.customNPCs.splice(idx, 1);
      if (window.__debixSyncNpcDelete && !S.isApplyingRemoteSync) {
        window.__debixSyncNpcDelete(removedId);
      }
    }
  } else if (kind === 'empty') {
    if (obj.group) scene.remove(obj.group);
    const idx = (S.emptyObjects || []).indexOf(obj);
    if (idx >= 0) S.emptyObjects.splice(idx, 1);
  } else if (kind === 'folder') {
    const idx = (S.sceneFolders || []).indexOf(obj);
    if (idx >= 0) S.sceneFolders.splice(idx, 1);
  }
}

function cascadeDeleteHierarchyChildren(rootKey) {
  if (!rootKey) return 0;
  const descendants = getAllSceneDescendants(rootKey);
  for (let i = descendants.length - 1; i >= 0; i--) {
    const d = descendants[i];
    removeSceneNodeByKindAndObj(d.kind, d.obj);
  }
  return descendants.length;
}

export function deleteSelected() {
  if (!S.selectedRef) return;

  if (S.selectedRef.kind === 'folder' && S.selectedRef.folder) {
    pushUndoState('Удаление группы и дочерних объектов');
    const folder = S.selectedRef.folder;
    cascadeDeleteHierarchyChildren(`folder:${folder.id}`);
    removeSceneNodeByKindAndObj('folder', folder);
    rebuildPhysicsArrays();
    selectEditorObject(null);
    sfx.oof();
    return;
  }

  if (S.selectedRef.kind === 'block') {
    pushUndoState('Удаление блока');
    const box = S.selectedRef.box;
    if (S.itemStudioOpen) closeItemStudio3D(false);
    cascadeDeleteHierarchyChildren(`block:${box.id}`);
    removeSceneNodeByKindAndObj('block', box);
    rebuildPhysicsArrays();
    selectEditorObject(null);
    sfx.oof();
  } else if (S.selectedRef.kind === 'world_item') {
    const { worldEntry, item, editMode, partIdx, libIdx } = S.selectedRef;
    if (editMode === 'part' || editMode === 'proj_part') {
      const targetArr = editMode === 'proj_part' ? item.projectileParts : item.parts;
      if (targetArr.length > 1) {
        pushItemUndoState('Удаление примитива предмета');
        targetArr.splice(partIdx || 0, 1);
        syncLibraryItemIfEditing(S.selectedRef);
        selectEditorObject({
          kind: 'world_item',
          worldEntry,
          item,
          editMode,
          partIdx: Math.max(0, (partIdx || 0) - 1),
          libIdx
        }, true);
        sfx.oof();
        return;
      }
    }

    if (S.itemStudioOpen) {
      closeItemStudio3D(false);
    }
    pushUndoState('Удаление предмета со сцены');
    cascadeDeleteHierarchyChildren(`world_item:${worldEntry.id}`);
    removeSceneNodeByKindAndObj('world_item', worldEntry);
    rebuildPhysicsArrays();
    selectEditorObject(null);
    sfx.oof();
  } else if (S.selectedRef.kind === 'char') {
    const ent = S.selectedRef.ent;
    if (ent.isP || (!ent.isCustomNPC && !ent.isArchangel)) {
      showBanner('Игрока и сюжетную очередь удалять нельзя (можно двигать и менять внешность)!', '#ff3e3e');
      return;
    }
    if (S.itemStudioOpen) {
      closeItemStudio3D(false);
    }
    pushUndoState('Удаление NPC');
    cascadeDeleteHierarchyChildren(`char:${ent.id}`);
    removeSceneNodeByKindAndObj('char', ent);
    rebuildPhysicsArrays();
    selectEditorObject(null);
    sfx.oof();
  } else if (S.selectedRef.kind === 'cosmetic') {
    const { ent, item, partIdx, libIdx } = S.selectedRef;
    normalizeCosmeticItem(item);
    if (item.parts.length > 1) {
      pushCosmeticUndoState('Удаление примитива аксессуара');
      item.parts.splice(partIdx || 0, 1);
      syncLibraryItemIfEditing(S.selectedRef);
      ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
      attachRigToEntity(ent);
      const newGroup = ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === item);
      selectEditorObject(
        {
          kind: 'cosmetic',
          ent,
          item,
          group: newGroup,
          partIdx: Math.max(0, (partIdx || 0) - 1),
          libIdx
        },
        true
      );
      sfx.oof();
      return;
    }

    if (S.itemStudioOpen) {
      closeItemStudio3D(false);
    }
    S.selectedRef = { kind: 'char', ent };
    pushUndoState('Удаление аксессуара');
    const arr = ent.preset.customCosmetics || [];
    const idx = arr.indexOf(item);
    if (idx >= 0) arr.splice(idx, 1);
    ent.rig.syncCustomCosmetics(arr);
    attachRigToEntity(ent);
    selectEditorObject({ kind: 'char', ent });
    sfx.oof();
  } else if (S.selectedRef.kind === 'empty' && S.selectedRef.emptyObj) {
    pushUndoState('Удаление пустышки');
    const emp = S.selectedRef.emptyObj;
    cascadeDeleteHierarchyChildren(`empty:${emp.id}`);
    removeSceneNodeByKindAndObj('empty', emp);
    rebuildPhysicsArrays();
    selectEditorObject(null);
    sfx.oof();
  }
}