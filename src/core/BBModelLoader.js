// src/core/BBModelLoader.js
import { S, showBanner } from './State.js';
import { sfx } from './AudioEngine.js';

const _textureCache = new Map();

function getPixelTexture(dataURL) {
  if (!dataURL || typeof dataURL !== 'string') return null;
  if (_textureCache.has(dataURL)) return _textureCache.get(dataURL);

  const img = new Image();
  const tex = new THREE.Texture(img);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.encoding = THREE.sRGBEncoding;

  img.onload = () => {
    tex.needsUpdate = true;
  };
  img.src = dataURL;

  _textureCache.set(dataURL, tex);
  return tex;
}

function resolveFaceTexture(faceTexRef, texturesArr) {
  if (faceTexRef === null || faceTexRef === false || faceTexRef === undefined) return null;
  if (!Array.isArray(texturesArr) || texturesArr.length === 0) return null;

  let texEntry = null;
  if (typeof faceTexRef === 'number') {
    texEntry = texturesArr[faceTexRef];
  } else {
    const refStr = String(faceTexRef).replace(/^#/, '');
    texEntry =
      texturesArr.find(t => String(t.id) === refStr || String(t.uuid) === refStr) ||
      texturesArr[parseInt(refStr, 10)];
  }
  if (!texEntry) texEntry = texturesArr[0];
  return texEntry && texEntry.source ? getPixelTexture(texEntry.source) : null;
}

function makeFaceMaterial(tex, fallbackColor = '#ffffff') {
  if (!tex) {
    return new THREE.MeshStandardMaterial({
      color: fallbackColor,
      roughness: 0.55,
      metalness: 0.05,
      side: THREE.DoubleSide
    });
  }
  return new THREE.MeshStandardMaterial({
    map: tex,
    roughness: 0.6,
    metalness: 0.05,
    alphaTest: 0.08,
    transparent: true,
    side: THREE.DoubleSide
  });
}

function applyCubeFaceUVs(geo, facesObj, resW, resH) {
  const uvAttr = geo.attributes.uv;
  if (!uvAttr || !facesObj) return;

  const faceOrder = ['east', 'west', 'up', 'down', 'south', 'north'];

  for (let fIdx = 0; fIdx < 6; fIdx++) {
    const faceKey = faceOrder[fIdx];
    const fData = facesObj[faceKey];
    if (!fData || !Array.isArray(fData.uv) || fData.uv.length < 4) continue;

    const u1 = fData.uv[0] / resW;
    const v1 = 1 - fData.uv[1] / resH;
    const u2 = fData.uv[2] / resW;
    const v2 = 1 - fData.uv[3] / resH;

    let corners = [
      [u1, v1],
      [u2, v1],
      [u2, v2],
      [u1, v2]
    ];

    const rotSteps = (((Number(fData.rotation) || 0) / 90) | 0) % 4;
    for (let r = 0; r < rotSteps; r++) {
      corners.unshift(corners.pop());
    }

    const baseVert = fIdx * 4;
    uvAttr.setXY(baseVert + 0, corners[0][0], corners[0][1]);
    uvAttr.setXY(baseVert + 1, corners[1][0], corners[1][1]);
    uvAttr.setXY(baseVert + 2, corners[3][0], corners[3][1]);
    uvAttr.setXY(baseVert + 3, corners[2][0], corners[2][1]);
  }
  uvAttr.needsUpdate = true;
}

function buildCubeElementMesh(el, texturesArr, resW, resH, parentOrigin, fallbackColor) {
  const from = el.from || [0, 0, 0];
  const to = el.to || [1, 1, 1];
  const inflate = Number(el.inflate) || 0;

  const dx = Math.max(0.001, (to[0] - from[0]) + inflate * 2);
  const dy = Math.max(0.001, (to[1] - from[1]) + inflate * 2);
  const dz = Math.max(0.001, (to[2] - from[2]) + inflate * 2);

  const cx = (from[0] + to[0]) * 0.5;
  const cy = (from[1] + to[1]) * 0.5;
  const cz = (from[2] + to[2]) * 0.5;

  const origin = el.origin || [cx, cy, cz];

  const geo = new THREE.BoxGeometry(dx, dy, dz);
  geo.translate(cx - origin[0], cy - origin[1], cz - origin[2]);
  applyCubeFaceUVs(geo, el.faces, resW, resH);

  const faceOrder = ['east', 'west', 'up', 'down', 'south', 'north'];
  const materials = faceOrder.map(fKey => {
    const fData = el.faces ? el.faces[fKey] : null;
    if (!fData || fData.texture === null || fData.texture === false) {
      return new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false });
    }
    const tex = resolveFaceTexture(fData.texture, texturesArr);
    return makeFaceMaterial(tex, fallbackColor);
  });

  const mesh = new THREE.Mesh(geo, materials);
  mesh.position.set(
    origin[0] - parentOrigin[0],
    origin[1] - parentOrigin[1],
    origin[2] - parentOrigin[2]
  );

  if (Array.isArray(el.rotation)) {
    mesh.rotation.order = 'ZYX';
    mesh.rotation.set(
      THREE.MathUtils.degToRad(Number(el.rotation[0]) || 0),
      THREE.MathUtils.degToRad(Number(el.rotation[1]) || 0),
      THREE.MathUtils.degToRad(Number(el.rotation[2]) || 0)
    );
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.bbElement = el;
  return mesh;
}

function sortQuadVertices(vKeys, vertsMap) {
  if (vKeys.length !== 4) return vKeys;
  const pts = vKeys.map(k => ({
    key: k,
    v: new THREE.Vector3(...(vertsMap[k] || [0, 0, 0]))
  }));
  const center = new THREE.Vector3();
  pts.forEach(p => center.add(p.v));
  center.multiplyScalar(0.25);

  const e1 = pts[1].v.clone().sub(pts[0].v);
  const e2 = pts[2].v.clone().sub(pts[0].v);
  const normal = new THREE.Vector3().crossVectors(e1, e2).normalize();
  if (normal.lengthSq() < 0.0001) return vKeys;

  const axisU = pts[0].v.clone().sub(center).normalize();
  const axisV = new THREE.Vector3().crossVectors(normal, axisU).normalize();

  pts.sort((a, b) => {
    const da = a.v.clone().sub(center);
    const db = b.v.clone().sub(center);
    const angA = Math.atan2(da.dot(axisV), da.dot(axisU));
    const angB = Math.atan2(db.dot(axisV), db.dot(axisU));
    return angA - angB;
  });
  return pts.map(p => p.key);
}

function buildFreeMeshElement(el, texturesArr, resW, resH, parentOrigin, fallbackColor) {
  const vertsMap = el.vertices || {};
  const facesMap = el.faces || {};
  const origin = el.origin || [0, 0, 0];

  const posArr = [];
  const uvArr = [];
  let chosenTex = null;

  for (const fKey of Object.keys(facesMap)) {
    const f = facesMap[fKey];
    if (!f || !Array.isArray(f.vertices) || f.vertices.length < 3) continue;
    if (!chosenTex && f.texture !== undefined && f.texture !== null && f.texture !== false) {
      chosenTex = resolveFaceTexture(f.texture, texturesArr);
    }

    const vKeys = f.vertices.length === 4 ? sortQuadVertices(f.vertices, vertsMap) : f.vertices;
    const tris = vKeys.length === 4
      ? [[vKeys[0], vKeys[1], vKeys[2]], [vKeys[0], vKeys[2], vKeys[3]]]
      : [[vKeys[0], vKeys[1], vKeys[2]]];

    for (const tri of tris) {
      for (const vk of tri) {
        const vp = vertsMap[vk] || [0, 0, 0];
        posArr.push(vp[0], vp[1], vp[2]);
        const uv = (f.uv && f.uv[vk]) || [0, 0];
        uvArr.push(uv[0] / resW, 1 - uv[1] / resH);
      }
    }
  }

  if (posArr.length === 0) return null;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(posArr, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvArr, 2));
  geo.computeVertexNormals();

  if (!chosenTex && texturesArr.length > 0) {
    chosenTex = resolveFaceTexture(0, texturesArr);
  }

  const mesh = new THREE.Mesh(geo, makeFaceMaterial(chosenTex, fallbackColor));
  mesh.position.set(
    origin[0] - parentOrigin[0],
    origin[1] - parentOrigin[1],
    origin[2] - parentOrigin[2]
  );

  if (Array.isArray(el.rotation)) {
    mesh.rotation.order = 'ZYX';
    mesh.rotation.set(
      THREE.MathUtils.degToRad(Number(el.rotation[0]) || 0),
      THREE.MathUtils.degToRad(Number(el.rotation[1]) || 0),
      THREE.MathUtils.degToRad(Number(el.rotation[2]) || 0)
    );
  }
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData.bbElement = el;
  return mesh;
}

function buildRawBBModelHierarchy(bbmodelData, fallbackColor = '#ffffff') {
  const resW = Number(bbmodelData.resolution?.width) || 16;
  const resH = Number(bbmodelData.resolution?.height) || 16;
  const texturesArr = Array.isArray(bbmodelData.textures) ? bbmodelData.textures : [];
  const elementsArr = Array.isArray(bbmodelData.elements) ? bbmodelData.elements : [];

  const elByUuid = new Map();
  for (const el of elementsArr) {
    if (el && el.uuid) elByUuid.set(el.uuid, el);
  }

  const usedUuids = new Set();
  const rawRoot = new THREE.Group();
  const builtElementMeshes = [];

  const buildNodeList = (nodes, parentGroup, parentOrigin) => {
    for (const node of nodes) {
      if (!node) continue;
      if (typeof node === 'string') {
        const el = elByUuid.get(node);
        if (!el || el.visibility === false) continue;
        usedUuids.add(node);
        const m = el.type === 'mesh'
          ? buildFreeMeshElement(el, texturesArr, resW, resH, parentOrigin, fallbackColor)
          : buildCubeElementMesh(el, texturesArr, resW, resH, parentOrigin, fallbackColor);
        if (m) {
          parentGroup.add(m);
          builtElementMeshes.push({ el, mesh: m });
        }
      } else if (typeof node === 'object') {
        if (node.visibility === false) continue;
        const gOrigin = node.origin || [0, 0, 0];
        const grp = new THREE.Group();
        grp.position.set(
          gOrigin[0] - parentOrigin[0],
          gOrigin[1] - parentOrigin[1],
          gOrigin[2] - parentOrigin[2]
        );
        if (Array.isArray(node.rotation)) {
          grp.rotation.order = 'ZYX';
          grp.rotation.set(
            THREE.MathUtils.degToRad(Number(node.rotation[0]) || 0),
            THREE.MathUtils.degToRad(Number(node.rotation[1]) || 0),
            THREE.MathUtils.degToRad(Number(node.rotation[2]) || 0)
          );
        }
        parentGroup.add(grp);
        if (Array.isArray(node.children)) {
          buildNodeList(node.children, grp, gOrigin);
        }
      }
    }
  };

  if (Array.isArray(bbmodelData.outliner) && bbmodelData.outliner.length > 0) {
    buildNodeList(bbmodelData.outliner, rawRoot, [0, 0, 0]);
  }

  for (const el of elementsArr) {
    if (!el || el.visibility === false || (el.uuid && usedUuids.has(el.uuid))) continue;
    const m = el.type === 'mesh'
      ? buildFreeMeshElement(el, texturesArr, resW, resH, [0, 0, 0], fallbackColor)
      : buildCubeElementMesh(el, texturesArr, resW, resH, [0, 0, 0], fallbackColor);
    if (m) {
      rawRoot.add(m);
      builtElementMeshes.push({ el, mesh: m });
    }
  }

  rawRoot.updateMatrixWorld(true);
  return { rawRoot, builtElementMeshes };
}

export function buildBBModelGroup(bbmodelData, fallbackColor = '#ffffff') {
  if (!bbmodelData || typeof bbmodelData !== 'object') return null;

  const { rawRoot } = buildRawBBModelHierarchy(bbmodelData, fallbackColor);

  const bbox = new THREE.Box3().setFromObject(rawRoot);
  const size = new THREE.Vector3(1, 1, 1);
  const center = new THREE.Vector3(0, 0, 0);

  if (!bbox.isEmpty()) {
    bbox.getSize(size);
    bbox.getCenter(center);
  }

  const sx = Math.max(0.001, Number.isFinite(size.x) ? size.x : 1);
  const sy = Math.max(0.001, Number.isFinite(size.y) ? size.y : 1);
  const sz = Math.max(0.001, Number.isFinite(size.z) ? size.z : 1);
  const cx = Number.isFinite(center.x) ? center.x : 0;
  const cy = Number.isFinite(center.y) ? center.y : 0;
  const cz = Number.isFinite(center.z) ? center.z : 0;

  const normalizedWrapper = new THREE.Group();
  normalizedWrapper.name = 'BBModelNormalizedRoot';
  rawRoot.scale.set(1 / sx, 1 / sy, 1 / sz);
  rawRoot.position.set(-cx / sx, -cy / sy, -cz / sz);
  rawRoot.traverse(o => {
    if (o.isMesh) o.frustumCulled = false;
  });
  normalizedWrapper.add(rawRoot);

  normalizedWrapper.userData.naturalSize = {
    w: Number(Math.max(0.08, sx / 8).toFixed(3)),
    h: Number(Math.max(0.08, sy / 8).toFixed(3)),
    d: Number(Math.max(0.08, sz / 8).toFixed(3))
  };

  return normalizedWrapper;
}

// Разбивает .bbmodel на отдельные части (каждый куб/меш со своей текстурой, позицией, поворотом и размером)
export function extractBBModelParts(bbmodelData, unitDivisor = 8) {
  if (!bbmodelData || typeof bbmodelData !== 'object') return { parts: [], totalSize: { w: 1, h: 1, d: 1 } };

  const { rawRoot, builtElementMeshes } = buildRawBBModelHierarchy(bbmodelData, '#ffffff');
  const totalBBox = new THREE.Box3().setFromObject(rawRoot);
  const totalCenter = new THREE.Vector3();
  const totalSizeRaw = new THREE.Vector3(8, 8, 8);
  if (!totalBBox.isEmpty()) {
    totalBBox.getCenter(totalCenter);
    totalBBox.getSize(totalSizeRaw);
  }

  const div = Math.max(1, Number(unitDivisor) || 8);
  const parts = [];

  for (let i = 0; i < builtElementMeshes.length; i++) {
    const { el, mesh } = builtElementMeshes[i];
    if (!mesh || !mesh.geometry) continue;

    mesh.geometry.computeBoundingBox();
    const localGeoBox = mesh.geometry.boundingBox
      ? mesh.geometry.boundingBox.clone()
      : new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));

    const localGeoSize = new THREE.Vector3();
    const localGeoCenter = new THREE.Vector3();
    localGeoBox.getSize(localGeoSize);
    localGeoBox.getCenter(localGeoCenter);

    const worldPos = new THREE.Vector3();
    const worldQuat = new THREE.Quaternion();
    const worldScale = new THREE.Vector3();
    mesh.matrixWorld.decompose(worldPos, worldQuat, worldScale);

    // Геометрический центр детали в мировых координатах Blockbench
    const worldGeoCenter = localGeoCenter.clone().multiply(worldScale).applyQuaternion(worldQuat).add(worldPos);
    const euler = new THREE.Euler().setFromQuaternion(worldQuat, 'XYZ');

    // Создаём изолированный mini-bbmodel для этой одной детали (без вращения, т.к. вращение передаётся самому объекту DebiX)
    const singleEl = JSON.parse(JSON.stringify(el));
    singleEl.rotation = [0, 0, 0];

    const singleBBModel = {
      id: `${bbmodelData.id || 'bbm'}_pt_${i}`,
      name: el.name || `${bbmodelData.name || 'Деталь'} #${i + 1}`,
      resolution: bbmodelData.resolution || { width: 16, height: 16 },
      elements: [singleEl],
      outliner: [],
      textures: bbmodelData.textures || []
    };

    parts.push({
      name: el.name || `Деталь #${i + 1}`,
      dx: Number(((worldGeoCenter.x - totalCenter.x) / div).toFixed(3)),
      dy: Number(((worldGeoCenter.y - totalCenter.y) / div).toFixed(3)),
      dz: Number(((worldGeoCenter.z - totalCenter.z) / div).toFixed(3)),
      rx: euler.x,
      ry: euler.y,
      rz: euler.z,
      w: Number(Math.max(0.05, (localGeoSize.x * Math.abs(worldScale.x)) / div).toFixed(3)),
      h: Number(Math.max(0.05, (localGeoSize.y * Math.abs(worldScale.y)) / div).toFixed(3)),
      d: Number(Math.max(0.05, (localGeoSize.z * Math.abs(worldScale.z)) / div).toFixed(3)),
      bbmodelData: singleBBModel
    });
  }

  return {
    parts,
    totalSize: {
      w: Number(Math.max(0.2, totalSizeRaw.x / div).toFixed(3)),
      h: Number(Math.max(0.2, totalSizeRaw.y / div).toFixed(3)),
      d: Number(Math.max(0.2, totalSizeRaw.z / div).toFixed(3))
    }
  };
}

export function sanitizeBBModelJson(rawJson, fileName = 'Model') {
  if (!rawJson || (!Array.isArray(rawJson.elements) && !Array.isArray(rawJson.outliner))) {
    throw new Error('В файле нет элементов геометрии Blockbench (elements).');
  }
  return {
    id: 'bbm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    name: String(rawJson.name || fileName.replace(/\.bbmodel$/i, '') || 'BBModel').slice(0, 48),
    resolution: {
      width: Number(rawJson.resolution?.width) || 16,
      height: Number(rawJson.resolution?.height) || 16
    },
    elements: rawJson.elements || [],
    outliner: rawJson.outliner || [],
    textures: (rawJson.textures || []).map((t, i) => ({
      id: t.id ?? String(i),
      uuid: t.uuid || String(i),
      name: t.name || `tex_${i}`,
      source: t.source || null
    }))
  };
}

export function promptUploadBBModel(onLoadedCallback) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = '.bbmodel,.json,application/json';
  inp.onchange = e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        const cleanModel = sanitizeBBModelJson(parsed, file.name);
        if (!Array.isArray(S.customModelsLibrary)) S.customModelsLibrary = [];
        S.customModelsLibrary.push(cleanModel);
        sfx.coil?.();
        const ptCount = Array.isArray(cleanModel.elements) ? cleanModel.elements.length : 1;
        showBanner(`📦 3D-модель «${cleanModel.name}» (${ptCount} ч.) успешно загружена!`, '#00e676');
        if (onLoadedCallback) onLoadedCallback(cleanModel);
      } catch (err) {
        showBanner('❌ Ошибка чтения .bbmodel: ' + err.message, '#ff3e3e');
      }
    };
    reader.readAsText(file);
  };
  inp.click();
}