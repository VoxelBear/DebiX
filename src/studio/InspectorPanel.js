// src/studio/InspectorPanel.js
import {
  S,
  $,
  showBanner,
  createDefaultParticleData,
  createDefaultLightData,
  createDefaultLogicData
} from '../core/State.js';
import { sfx } from '../core/AudioEngine.js';
import {
  COSMETIC_SLOTS,
  COSMETIC_SHAPES,
  ITEM_HOLD_MODES,
  ITEM_USE_TYPES,
  rebuildCharacterCosmetics,
  setMeshFrontSprite,
  rebuildWorldItemVisuals,
  normalizeItemData,
  createDefaultPartParticleData,
  normalizePartEffects
} from '../core/CharacterRig.js';
import {
  createBlockMaterial,
  syncBlockSpecialVisuals,
  syncBlockLightVisuals,
  rebuildPhysicsArrays,
  spawnWorldItemEntry,
  removeWorldItemEntry
} from '../core/WorldRegistry.js';
import {
  equipItemToCharacterSlot,
  removeCharacterSlotItem,
  syncPlayerHotbarUI,
  syncEntityHeldItemMesh
} from '../core/EntityManager.js';
import { triggerBlockLogic } from '../player/PhysicsAndCombat.js';
import {
  selectedRef,
  tControls,
  selBoxHelper,
  selectEditorObject,
  pushUndoState,
  pushCosmeticUndoState,
  syncLibraryItemIfEditing,
  syncLibraryWorldItemIfEditing,
  ensureItemEditorMarkers,
  ensureCharGripMarkers,
  openItemStudio3D,
  closeItemStudio3D,
  syncItemStudioPreview
} from './StudioController.js';
import {
  refreshHierarchyUI,
  spawnStudioAccessory,
  spawnStudioItem
} from './HierarchyAndSpawn.js';
import { openPaintModal } from './PaintStudio2D.js';

export function syncActivePartMeshEmissive(mesh, part) {
  if (!mesh || !mesh.material) return;
  const hasLight = Boolean(part.pseudoLight || part.realLight);
  if (hasLight) {
    mesh.material.emissive = new THREE.Color(part.lightColor || part.color || '#56f0ff');
    mesh.material.emissiveIntensity = (part.lightIntensity ?? 1.4) * (part.realLight ? 0.85 : 0.65);
  } else {
    mesh.material.emissive = new THREE.Color(0x000000);
    mesh.material.emissiveIntensity = 0;
  }
  mesh.material.needsUpdate = true;
}

export function renderInspectorUI() {
  const cont = $('inspectorContent');
  if (!selectedRef) {
    cont.innerHTML = `<div class="empty-hint">Кликните по объекту на сцене или в списке слева, чтобы настроить его физику, логику (Дверь/Кнопка/Телепорт/Магазин), партиклы, свечение, оружие или гардероб аксессуаров.</div>`;
    return;
  }

  // 1. ИНСПЕКТОР НАСТРОЕК МИРА
  if (selectedRef.kind === 'world') {
    const ws = S.worldSettings;
    cont.innerHTML = `
      <div class="prop-group">
        <h5>🌍 Глобальные Правила Игры</h5>
        <div class="prop-row"><label>Название мира</label><input class="ed-inp" id="inpWTitle" value="${ws.worldTitle}"></div>
        <div class="prop-row"><label>Победа (Этап #)</label><input type="number" min="1" max="50" class="ed-inp" id="inpWWinStg" value="${ws.winStage}"></div>
        <div class="prop-row"><label>Награда победы</label><input type="number" step="50" class="ed-inp" id="inpWWinCash" value="${ws.winRewardCash}"></div>
        <div class="prop-row"><label>За 1 сек в очереди</label><input type="number" step="1" class="ed-inp" id="inpWQRate" value="${ws.queueCashPerSec}"></div>
        <div class="prop-row"><label>Стартовые R$</label><input type="number" step="50" class="ed-inp" id="inpWStartCash" value="${ws.startCash}"></div>
        <div class="prop-row">
          <label>После смерти (0 HP)</label>
          <select class="ed-inp" id="inpWRespawn">
            <option value="checkpoint" ${ws.respawnMode !== 'spectator' ? 'selected' : ''}>🔄 Возрождение на чекпоинте</option>
            <option value="spectator" ${ws.respawnMode === 'spectator' ? 'selected' : ''}>👻 Режим Наблюдателя (Полёт)</option>
          </select>
        </div>
      </div>
      <div class="prop-group">
        <h5>🏃 Физика Игрока</h5>
        <div class="prop-row"><label>Гравитация</label><input type="number" step="2" min="5" max="120" class="ed-inp" id="inpWGrav" value="${ws.gravity}"></div>
        <div class="prop-row"><label>Скорость бега</label><input type="number" step="1" min="4" max="50" class="ed-inp" id="inpWSpd" value="${ws.walkSpeed}"></div>
        <div class="prop-row"><label>Сила прыжка</label><input type="number" step="1" min="4" max="60" class="ed-inp" id="inpWJmp" value="${ws.jumpPower}"></div>
        <div class="prop-row"><label>Урон с руки</label><input type="number" step="5" min="1" max="500" class="ed-inp" id="inpWMelee" value="${ws.meleeDamage}"></div>
      </div>
      <div class="prop-group">
        <h5>🛒 Цены в Магазине</h5>
        <div class="prop-row"><label>Прыжок Иисуса</label><input type="number" step="10" class="ed-inp" id="inpC4" value="${ws.shopCosts.cut1}"></div>
        <div class="prop-row"><label>Подкуп Ангела</label><input type="number" step="50" class="ed-inp" id="inpC5" value="${ws.shopCosts.cut5}"></div>
        <div class="prop-row"><label>VIP Нимб (x2)</label><input type="number" step="50" class="ed-inp" id="inpCHalo" value="${ws.shopCosts.halo}"></div>
        <div class="prop-row"><label>Пружина Скор.</label><input type="number" step="20" class="ed-inp" id="inpCSpd" value="${ws.shopCosts.speed}"></div>
        <div class="prop-row"><label>Пружина Прыж.</label><input type="number" step="20" class="ed-inp" id="inpCGrv" value="${ws.shopCosts.grav}"></div>
      </div>
    `;
    $('inpWTitle').oninput = e => {
      ws.worldTitle = e.target.value;
      refreshHierarchyUI();
    };
    $('inpWWinStg').oninput = e => { ws.winStage = Math.max(1, +e.target.value || 4); };
    $('inpWWinCash').oninput = e => { ws.winRewardCash = +e.target.value || 0; };
    $('inpWQRate').oninput = e => { ws.queueCashPerSec = +e.target.value || 0; };
    $('inpWStartCash').oninput = e => { ws.startCash = +e.target.value || 0; };
    $('inpWRespawn').onchange = e => { ws.respawnMode = e.target.value; };
    $('inpWGrav').oninput = e => { ws.gravity = Math.max(5, +e.target.value || 38); };
    $('inpWSpd').oninput = e => { ws.walkSpeed = Math.max(4, +e.target.value || 15); };
    $('inpWJmp').oninput = e => { ws.jumpPower = Math.max(4, +e.target.value || 17); };
    $('inpWMelee').oninput = e => { ws.meleeDamage = Math.max(1, +e.target.value || 25); };
    $('inpC4').oninput = e => { ws.shopCosts.cut1 = +e.target.value || 0; };
    $('inpC5').oninput = e => { ws.shopCosts.cut5 = +e.target.value || 0; };
    $('inpCHalo').oninput = e => { ws.shopCosts.halo = +e.target.value || 0; };
    $('inpCSpd').oninput = e => { ws.shopCosts.speed = +e.target.value || 0; };
    $('inpCGrv').oninput = e => { ws.shopCosts.grav = +e.target.value || 0; };
    return;
  }

  // 2. ИНСПЕКТОР 3D-ПРЕДМЕТА / ОРУЖИЯ / КОНТЕЙНЕРА НА СЦЕНЕ И В 3D STUDIO (selectedRef.kind === 'world_item')
  if (selectedRef.kind === 'world_item') {
    const wi = selectedRef.worldEntry;
    const item = normalizeItemData(wi.item);
    wi.item = item;
    const editMode = selectedRef.editMode || 'part';
    const isProjMode = editMode === 'proj_part';
    const activePartsList = isProjMode ? item.projectileParts : item.parts;
    const partIdx = Math.min(Math.max(0, selectedRef.partIdx ?? 0), activePartsList.length - 1);
    const part = activePartsList[partIdx] || activePartsList[0];
    normalizePartEffects(part, false, false);

    if (!item.lightData) {
      item.lightData = {
        enabled: false,
        realLight: false,
        pseudoLight: false,
        active: true,
        color: '#ff9100',
        intensity: 1.8,
        distance: 18,
        toggleByLMB: true
      };
    }
    if (!item.particleData) {
      item.particleData = createDefaultPartParticleData();
    }

    const ptData = part.particleData;
    const itemLd = item.lightData;
    const itemPd = item.particleData;

    const holdOptsHTML = Object.entries(ITEM_HOLD_MODES)
      .map(([k, v]) => `<option value="${k}" ${item.holdMode === k ? 'selected' : ''}>${v.label}</option>`)
      .join('');
    const useOptsHTML = Object.entries(ITEM_USE_TYPES)
      .map(([k, v]) => `<option value="${k}" ${item.useType === k ? 'selected' : ''}>${v.label}</option>`)
      .join('');
    const shapeOptsHTML = Object.entries(COSMETIC_SHAPES)
      .map(([k, lbl]) => `<option value="${k}" ${part.shape === k ? 'selected' : ''}>${lbl}</option>`)
      .join('');
    const wearSlotOptsHTML = Object.entries(COSMETIC_SLOTS)
      .map(([k, v]) => `<option value="${k}" ${item.wearSlot === k ? 'selected' : ''}>${v.label}</option>`)
      .join('');

    const partChipsHTML = activePartsList
      .map((pt, idx) => {
        const isSel = idx === partIdx && (editMode === 'part' || editMode === 'proj_part');
        const fxBadge = (pt.realLight ? '💡' : (pt.pseudoLight ? '✨' : '')) + (pt.particleData?.enabled ? '🎆' : '');
        return `<button class="ed-btn ${isSel ? 'active' : ''}" data-wipart="${idx}" type="button" style="padding:3px 7px;font-size:10px">${idx + 1}. ${pt.name || pt.shape}${fxBadge ? ' ' + fxBadge : ''}</button>`;
      })
      .join('');

    const isEditingFromLib = Boolean(
      selectedRef.libraryItemRef || S.savedItemsLibrary.some(l => l.id === item.id)
    );

    const containerItems = item.containerItems || [];
    const containerRowsHTML = containerItems.length === 0
      ? `<div style="font:600 10px var(--f);color:#94a3b8;padding:4px">Контейнер пуст. Добавьте предметы из библиотеки ниже:</div>`
      : containerItems.map((ci, cIdx) => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:#141824;padding:4px 7px;border-radius:6px;border:1px solid #283147;gap:5px">
            <span style="font:700 11px var(--f);color:#e2e8f0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ci.icon || '📦'} ${ci.name}</span>
            <button class="ed-btn danger" data-delcontitem="${cIdx}" type="button" style="padding:2px 6px">✕</button>
          </div>
        `).join('');

    const libAddSelectHTML = S.savedItemsLibrary
      .map((li, lIdx) => `<option value="${lIdx}">${li.icon || '🗡️'} ${li.name}</option>`)
      .join('');

    const rebuildAndReselectWi = (newEditMode = editMode, newPartIdx = partIdx) => {
      rebuildWorldItemVisuals(wi);
      const markers = ensureItemEditorMarkers(wi);
      let targetMesh = wi.group;
      const list = newEditMode === 'proj_part' ? item.projectileParts : item.parts;
      const safeIdx = Math.min(Math.max(0, newPartIdx), list.length - 1);

      if (newEditMode === 'grip') {
        targetMesh = markers.gripMarker;
      } else if (newEditMode === 'muzzle') {
        targetMesh = markers.muzzleMarker;
      } else if (newEditMode === 'proj_part') {
        if (markers.projPreviewGroup && markers.projPreviewGroup.children[safeIdx]) {
          targetMesh = markers.projPreviewGroup.children[safeIdx];
        }
      } else if (newEditMode === 'part') {
        const meshes = wi.group.children.filter(c => c.userData && c.userData.isItemPart);
        if (meshes[safeIdx]) targetMesh = meshes[safeIdx];
      }

      if (S.player) syncEntityHeldItemMesh(S.player);
      syncLibraryWorldItemIfEditing(selectedRef);
      syncItemStudioPreview();

      selectEditorObject({
        kind: 'world_item',
        worldEntry: wi,
        item,
        partIdx: safeIdx,
        editMode: newEditMode,
        inWorldPlacement: Boolean(selectedRef.inWorldPlacement),
        mesh: targetMesh,
        libraryItemRef: selectedRef.libraryItemRef || null
      });
    };

    const gPos = item.gripPos || { x: 0, y: 0, z: 0 };
    const gRot = item.gripRot || { x: 0, y: 0, z: 0 };
    const mPos = item.muzzlePos || { x: 0, y: 0.2, z: -0.9 };

    cont.innerHTML = `
      <div class="prop-group" style="border:1.5px solid #ffb300;background:rgba(255,179,0,0.06)">
        <h5 style="color:#ffd54f">
          <span>🗡️ Предмет / Оружие и Режим Правки</span>
        </h5>
        ${S.itemStudioOpen ? `
          <button class="ed-btn" id="btnWiPlaceOnMap" type="button" style="width:100%;justify-content:center;margin-bottom:6px;background:rgba(255,179,0,0.16);border-color:#ffb300;color:#ffe082">📍 Переместить на карте (Выйти из 3D STUDIO)</button>
        ` : `
          <button class="ed-btn apply-oneclick" id="btnWiOpenStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:6px;background:rgba(86,240,255,0.16);border-color:#56f0ff;color:#56f0ff">🛠️ Открыть в 3D STUDIO (Изолированный верстак)</button>
        `}
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px">
          <button class="ed-btn ${editMode === 'part' ? 'active' : ''}" id="btnWiModePart" type="button" style="justify-content:center">🎨 Внешний вид</button>
          <button class="ed-btn ${editMode === 'root' && !S.itemStudioOpen ? 'active' : ''}" id="btnWiModeRoot" type="button" style="justify-content:center">📍 Позиция в мире</button>
          <button class="ed-btn ${editMode === 'grip' ? 'active' : ''}" id="btnWiModeGrip" type="button" style="justify-content:center">✋ Точка Хвата</button>
          <button class="ed-btn ${editMode === 'muzzle' ? 'active' : ''}" id="btnWiModeMuzzle" type="button" style="justify-content:center">🔫 Точка Выстрела</button>
          ${(item.useType === 'ranged' || item.useType === 'throwable') ? `
            <button class="ed-btn ${editMode === 'proj_part' ? 'active' : ''}" id="btnWiModeProj" type="button" style="grid-column:1 / -1;justify-content:center">🚀 Внешний вид Снаряда (${item.projectileParts.length} прим.)</button>
          ` : ''}
        </div>
        <div class="prop-row"><label>Название</label><input class="ed-inp" id="wiName" value="${item.name}"></div>
        <div class="prop-row"><label>Иконка (Эмодзи)</label><input class="ed-inp" id="wiIcon" value="${item.icon || '🗡️'}" style="width:65px"></div>
        <div class="prop-row"><label>Как держать</label><select class="ed-inp" id="wiHoldMode">${holdOptsHTML}</select></div>
        <div class="prop-row"><label>Тип действия</label><select class="ed-inp" id="wiUseType">${useOptsHTML}</select></div>
        <div class="prop-row" id="rowWiPosition" ${S.itemStudioOpen ? 'hidden' : ''}><label>Координаты в мире</label><div class="vec3">
          <input type="number" step="0.5" class="ed-inp" id="inpWiRootX" value="${wi.x.toFixed(1)}">
          <input type="number" step="0.5" class="ed-inp" id="inpWiRootY" value="${wi.y.toFixed(1)}">
          <input type="number" step="0.5" class="ed-inp" id="inpWiRootZ" value="${wi.z.toFixed(1)}">
        </div></div>
      </div>

      <div class="prop-group" style="border:1px solid #00e676">
        <h5 style="color:#69f0ae">
          <span>🎨 Внешний вид ${isProjMode ? 'Снаряда' : 'Предмета'} (${activePartsList.length})</span>
          <div style="display:flex;gap:4px">
            <button class="ed-btn apply-oneclick" id="btnAddWiPart" type="button" style="padding:2px 7px;font-size:10px">➕ Деталь</button>
            <button class="ed-btn" id="btnDupWiPart" type="button" style="padding:2px 7px;font-size:10px" title="Дублировать деталь">📋</button>
            ${activePartsList.length > 1 ? `<button class="ed-btn danger" id="btnDelWiPart" type="button" style="padding:2px 7px;font-size:10px" title="Удалить деталь">🗑️</button>` : ''}
          </div>
        </h5>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${partChipsHTML}</div>
        <div class="prop-row"><label>Имя детали</label><input class="ed-inp" id="wiPartName" value="${part.name || 'Деталь'}"></div>
        <div class="prop-row"><label>Форма 3D</label><select class="ed-inp" id="wiPartShape">${shapeOptsHTML}</select></div>
        <div class="prop-row">
          <label>Цвет и 2D</label>
          <input type="color" class="ed-color" id="wiPartCol" value="${part.color || '#56f0ff'}">
          <button class="ed-btn apply-oneclick" id="btnPaintWiPart" type="button" style="flex:1;justify-content:center">🎨 Спрайт спереди</button>
          ${part.texDataURL ? `<button class="ed-btn danger" id="btnClearWiPartSpr" type="button" title="Очистить спрайт">✕</button>` : ''}
        </div>
        <div class="prop-row"><label>Смещение</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpWiPX" value="${Number(part.x || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpWiPY" value="${Number(part.y || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpWiPZ" value="${Number(part.z || 0).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Размер</label><div class="vec3">
          <input type="number" step="0.05" min="0.04" class="ed-inp" id="inpWiSX" value="${Number(part.sx || 0.3).toFixed(2)}">
          <input type="number" step="0.05" min="0.04" class="ed-inp" id="inpWiSY" value="${Number(part.sy || 0.3).toFixed(2)}">
          <input type="number" step="0.05" min="0.04" class="ed-inp" id="inpWiSZ" value="${Number(part.sz || 0.3).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот°</label><div class="vec3">
          <input type="number" step="10" class="ed-inp" id="inpWiRX" value="${Math.round(THREE.MathUtils.radToDeg(part.rx || 0))}">
          <input type="number" step="10" class="ed-inp" id="inpWiRY" value="${Math.round(THREE.MathUtils.radToDeg(part.ry || 0))}">
          <input type="number" step="10" class="ed-inp" id="inpWiRZ" value="${Math.round(THREE.MathUtils.radToDeg(part.rz || 0))}">
        </div></div>

        <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #283147;display:flex;flex-direction:column;gap:5px">
          <div style="font:800 10px var(--f);color:#94a3b8;text-transform:uppercase">Эффекты выбранной детали («${part.name || 'Деталь'}»):</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
              <input type="checkbox" id="inpWiPartPseudo" ${part.pseudoLight ? 'checked' : ''}> ✨ Псевдо-свет
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
              <input type="checkbox" id="inpWiPartReal" ${part.realLight ? 'checked' : ''}> 💡 Настоящий свет
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#56f0ff;cursor:pointer">
              <input type="checkbox" id="inpWiPartPtOn" ${ptData.enabled ? 'checked' : ''}> 🎆 Частицы
            </label>
          </div>

          <div id="wiPartLightFields" ${(part.pseudoLight || part.realLight) ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(255,213,79,0.06);padding:6px;border-radius:7px;border:1px solid rgba(255,213,79,0.28)">
            <div class="prop-row">
              <label>Цвет свечения</label>
              <input type="color" class="ed-color" id="inpWiPartLCol" value="${part.lightColor || part.color || '#56f0ff'}">
              <button class="ed-btn" id="btnWiPartLMatch" type="button" style="flex:1;justify-content:center">🎨 В цвет детали</button>
            </div>
            <div class="prop-row">
              <label>Яркость</label>
              <input type="range" min="0.2" max="4.0" step="0.1" id="inpWiPartLInt" value="${part.lightIntensity ?? 1.4}" style="flex:1">
              <span id="txtWiPartLInt" style="font-size:10px;width:30px;text-align:right">${Number(part.lightIntensity ?? 1.4).toFixed(1)}</span>
            </div>
            <div class="prop-row" id="rowWiPartLDist" ${part.realLight ? '' : 'hidden'}>
              <label>Радиус света (м)</label>
              <input type="number" min="2" max="60" step="1" class="ed-inp" id="inpWiPartLDist" value="${part.lightDistance ?? 12}">
            </div>
          </div>

          <div id="wiPartPtFields" ${ptData.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(86,240,255,0.06);padding:6px;border-radius:7px;border:1px solid rgba(86,240,255,0.28)">
            <div class="prop-row">
              <label>Шаблон частицы</label>
              <select class="ed-inp" id="inpWiPartPtPreset" style="flex:1">
                <option value="spark" ${ptData.preset === 'spark' ? 'selected' : ''}>💠 Искра (Spark)</option>
                <option value="fire" ${ptData.preset === 'fire' ? 'selected' : ''}>🔥 Огонь (Fire)</option>
                <option value="heart" ${ptData.preset === 'heart' ? 'selected' : ''}>❤️ Сердечко (Heart)</option>
                <option value="star" ${ptData.preset === 'star' ? 'selected' : ''}>⭐ Звезда (Star)</option>
                <option value="smoke" ${ptData.preset === 'smoke' ? 'selected' : ''}>💨 Дым (Smoke)</option>
                <option value="hit" ${ptData.preset === 'hit' ? 'selected' : ''}>💥 Всплеск (Hit)</option>
                <option value="custom" ${ptData.preset === 'custom' ? 'selected' : ''}>🎨 Свой 16×16</option>
              </select>
              <button class="ed-btn apply-oneclick" id="btnPaintWiPartPt" type="button">🖌️ 16×16</button>
            </div>
            <div class="prop-row">
              <label>Оттенок и Кол/с</label>
              <input type="color" class="ed-color" id="inpWiPartPtCol" value="${ptData.color || '#ffffff'}">
              <input type="number" min="1" max="60" step="1" class="ed-inp" id="inpWiPartPtRate" value="${ptData.rate ?? 10}" style="width:70px" title="Частиц в секунду">
            </div>
            <div class="prop-row">
              <label>Размер / Скор. / Y</label>
              <div class="vec3">
                <input type="number" step="0.05" min="0.05" max="3" class="ed-inp" id="inpWiPartPtSize" value="${ptData.sizeStart ?? 0.28}" title="Начальный размер">
                <input type="number" step="0.2" min="0" max="20" class="ed-inp" id="inpWiPartPtSpd" value="${ptData.speed ?? 1.6}" title="Скорость разлёта">
                <input type="number" step="0.5" class="ed-inp" id="inpWiPartPtGrav" value="${ptData.gravity ?? 1.5}" title="Всплытие (+Y) / Гравитация (-Y)">
              </div>
            </div>
          </div>
        </div>
      </div>

      ${(item.useType === 'melee' || item.useType === 'ranged' || item.useType === 'throwable') ? `
      <div class="prop-group">
        <h5>⚔️ Боевые параметры (Урон / Выстрел / Бросок)</h5>
        <div class="prop-row"><label>Урон (HP)</label><input type="number" step="5" min="0" class="ed-inp" id="inpWiDmg" value="${item.damage}"></div>
        <div class="prop-row"><label>Кулдаун (сек)</label><input type="number" step="0.05" min="0.08" class="ed-inp" id="inpWiCd" value="${item.cooldown}"></div>
        <div class="prop-row"><label>Дальность / Импульс</label><div class="vec3" style="grid-template-columns:1fr 1fr">
          <input type="number" step="0.5" min="1" class="ed-inp" id="inpWiRange" value="${item.range}" title="Дальность удара">
          <input type="number" step="1" min="0" class="ed-inp" id="inpWiKnock" value="${item.knockback}" title="Отбрасывание">
        </div></div>
        ${(item.useType === 'ranged' || item.useType === 'throwable') ? `
          <div class="prop-row"><label>Макс. скор. / Грав.</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="2" min="4" class="ed-inp" id="inpWiProjSpd" value="${item.projSpeed}" title="Максимальная скорость снаряда">
            <input type="number" step="2" min="0" class="ed-inp" id="inpWiProjGrv" value="${item.projGravity}" title="Гравитация снаряда (0 = лазер по прямой)">
          </div></div>
          <div class="prop-row"><label>Радиус взрыва</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.5" min="0" class="ed-inp" id="inpWiSplash" value="${item.splashRadius}" title="0 = без взрыва">
            <input type="color" class="ed-color" id="inpWiProjCol" value="${item.projColor || '#ffeb3b'}" style="width:100%">
          </div></div>
        ` : ''}
        ${item.useType === 'throwable' ? `
          <div class="prop-row"><label>Мин. скор. / Замах(с)</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="1" min="2" class="ed-inp" id="inpWiMinThrow" value="${item.minThrowSpeed ?? 8}" title="Начальная (минимальная) скорость при коротком клике">
            <input type="number" step="0.1" min="0.2" max="4" class="ed-inp" id="inpWiMaxChg" value="${item.maxChargeTime ?? 1.15}" title="Время удержания ЛКМ до полного броска">
          </div></div>
          <div class="prop-row">
            <label>Упругость отскока</label>
            <input type="number" step="0.05" min="0" max="0.95" class="ed-inp" id="inpWiProjBounce" value="${item.projBounce ?? 0.35}" style="width:80px">
            <label style="flex:1;text-align:right">Расходовать (Стак)</label>
            <input type="checkbox" id="inpWiConsumeThrow" ${item.consumeOnThrow !== false ? 'checked' : ''}>
          </div>
          <div class="prop-row">
            <label>Количество в стаке</label>
            <input type="number" step="1" min="1" max="99" class="ed-inp" id="inpWiStackCount" value="${item.stackCount ?? 3}" style="width:80px">
            <label style="flex:1;text-align:right">Макс. стак</label>
            <input type="number" step="1" min="1" max="99" class="ed-inp" id="inpWiMaxStackThrow" value="${item.maxStack ?? 5}" style="width:70px">
          </div>
        ` : ''}
        ${item.useType === 'ranged' ? `
          <div class="prop-row">
            <label>Патроны / Обойма</label>
            <div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="1" min="0" class="ed-inp" id="inpWiAmmo" value="${item.ammo ?? 12}" title="Текущие патроны">
              <input type="number" step="1" min="0" class="ed-inp" id="inpWiMaxAmmo" value="${item.maxAmmo ?? 12}" title="Размер магазина (0 = бесконечные)">
            </div>
          </div>
          <div class="prop-row">
            <label>Перезарядка [R] (с)</label>
            <input type="number" step="0.1" min="0.2" max="10" class="ed-inp" id="inpWiReloadTime" value="${item.reloadTime ?? 1.4}" style="width:80px">
            <label style="flex:1;text-align:right">Удерж. [R]</label>
            <input type="checkbox" id="inpWiReloadHold" ${item.reloadHold !== false ? 'checked' : ''} title="Требовать удержание клавиши [R] для перезарядки">
          </div>
        ` : ''}
      </div>
      ` : ''}

      <div class="prop-group" style="border:1px solid #38bdf8">
        <h5 style="color:#7dd3fc">⚙️ Свойства предмета</h5>

        ${item.useType === 'consumable' ? `
          <div style="background:rgba(0,230,118,0.06);border:1px solid rgba(0,230,118,0.28);border-radius:7px;padding:6px;margin-bottom:6px;display:flex;flex-direction:column;gap:5px">
            <div style="font:800 10px var(--f);color:#69f0ae;text-transform:uppercase">🍗 Расходуемое (Еда / Зелье / Аптечка):</div>
            <div class="prop-row"><label>Лечение (+HP)</label><input type="number" step="5" class="ed-inp" id="inpWiHeal" value="${item.healAmount}"></div>
            <div class="prop-row"><label>Бонус скор. / Время</label><div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="1" class="ed-inp" id="inpWiBuffSpd" value="${item.speedBoost}" title="+к скорости бега">
              <input type="number" step="1" min="0" class="ed-inp" id="inpWiBuffDur" value="${item.buffDuration}" title="Длительность баффа (сек)">
            </div></div>
            <div class="prop-row"><label>Бонус прыжка</label><input type="number" step="1" class="ed-inp" id="inpWiBuffJmp" value="${item.jumpBoost || 0}"></div>
          </div>
        ` : ''}

        <div class="prop-row">
          <label>Прочность (Тек/Макс)</label>
          <div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="5" min="0" class="ed-inp" id="inpWiDurCur" value="${item.durability ?? 0}" title="Текущая прочность">
            <input type="number" step="10" min="0" class="ed-inp" id="inpWiDurMax" value="${item.maxDurability ?? 0}" title="0 = Вечный предмет (не ломается)">
          </div>
        </div>
        <div class="prop-row">
          <label>Носить на теле</label>
          <input type="checkbox" id="inpWiCanWear" ${item.canWearAsArmor ? 'checked' : ''}>
          <select class="ed-inp" id="inpWiWearSlot" style="flex:1">${wearSlotOptsHTML}</select>
        </div>
        <div class="prop-row">
          <label>Бонус брони (%)</label>
          <input type="number" step="5" min="0" max="85" class="ed-inp" id="inpWiArmor" value="${item.armorBonus ?? 0}" style="width:80px">
          <label style="flex:1;text-align:right">Макс. стак</label>
          <input type="number" step="1" min="1" max="99" class="ed-inp" id="inpWiMaxStackGen" value="${item.maxStack || 1}" style="width:70px">
        </div>

        <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #283147;display:flex;flex-direction:column;gap:5px">
          <div style="font:800 10px var(--f);color:#94a3b8;text-transform:uppercase">Свечение и частицы всего предмета:</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
              <input type="checkbox" id="inpWiItemRealLight" ${itemLd.realLight ? 'checked' : ''}> 💡 Настоящий свет
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
              <input type="checkbox" id="inpWiItemPseudoLight" ${itemLd.pseudoLight ? 'checked' : ''}> ✨ Псевдо-свет
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#56f0ff;cursor:pointer">
              <input type="checkbox" id="inpWiItemPtOn" ${itemPd.enabled ? 'checked' : ''}> 🎆 Частицы
            </label>
          </div>

          <div id="wiItemLightFields" ${(itemLd.realLight || itemLd.pseudoLight) ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(255,213,79,0.06);padding:6px;border-radius:7px;border:1px solid rgba(255,213,79,0.28)">
            <div class="prop-row">
              <label>Вкл/Выкл по ЛКМ</label>
              <input type="checkbox" id="inpWiLightToggleLMB" ${itemLd.toggleByLMB !== false ? 'checked' : ''}>
              <label style="flex:1;text-align:right">Горит сейчас</label>
              <input type="checkbox" id="inpWiLightActive" ${itemLd.active !== false ? 'checked' : ''}>
            </div>
            <div class="prop-row">
              <label>Цвет / Радиус / Ярк.</label>
              <input type="color" class="ed-color" id="inpWiLightCol" value="${itemLd.color || '#ff9100'}">
              <input type="number" step="2" min="3" max="60" class="ed-inp" id="inpWiLightDist" value="${itemLd.distance ?? 18}" style="width:62px" title="Радиус освещения">
              <input type="number" step="0.2" min="0.2" max="5" class="ed-inp" id="inpWiLightInt" value="${itemLd.intensity ?? 1.8}" style="width:62px" title="Яркость света">
            </div>
          </div>

          <div id="wiItemPtFields" ${itemPd.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(86,240,255,0.06);padding:6px;border-radius:7px;border:1px solid rgba(86,240,255,0.28)">
            <div class="prop-row">
              <label>Шаблон 16×16</label>
              <select class="ed-inp" id="inpWiItemPtPreset" style="flex:1">
                <option value="spark" ${itemPd.preset === 'spark' ? 'selected' : ''}>💠 Искра (Spark)</option>
                <option value="fire" ${itemPd.preset === 'fire' ? 'selected' : ''}>🔥 Огонь (Fire)</option>
                <option value="heart" ${itemPd.preset === 'heart' ? 'selected' : ''}>❤️ Сердечко (Heart)</option>
                <option value="star" ${itemPd.preset === 'star' ? 'selected' : ''}>⭐ Звезда (Star)</option>
                <option value="smoke" ${itemPd.preset === 'smoke' ? 'selected' : ''}>💨 Дым (Smoke)</option>
                <option value="hit" ${itemPd.preset === 'hit' ? 'selected' : ''}>💥 Всплеск (Hit)</option>
                <option value="custom" ${itemPd.preset === 'custom' ? 'selected' : ''}>🎨 Свой 16×16</option>
              </select>
              <button class="ed-btn apply-oneclick" id="btnPaintWiItemPt" type="button">🖌️ 16×16</button>
            </div>
            <div class="prop-row">
              <label>Оттенок и Кол/с</label>
              <input type="color" class="ed-color" id="inpWiItemPtCol" value="${itemPd.color || '#ffffff'}">
              <input type="number" min="1" max="60" step="1" class="ed-inp" id="inpWiItemPtRate" value="${itemPd.rate ?? 10}" style="width:70px">
            </div>
            <div class="prop-row">
              <label>Размер / Скор. / Y</label>
              <div class="vec3">
                <input type="number" step="0.05" min="0.05" max="3" class="ed-inp" id="inpWiItemPtSize" value="${itemPd.sizeStart ?? 0.28}">
                <input type="number" step="0.2" min="0" max="20" class="ed-inp" id="inpWiItemPtSpd" value="${itemPd.speed ?? 1.6}">
                <input type="number" step="0.5" class="ed-inp" id="inpWiItemPtGrav" value="${itemPd.gravity ?? 1.5}">
              </div>
            </div>
          </div>
        </div>
      </div>

      ${(item.useType === 'container' || item.holdMode === 'two_handed_box') ? `
      <div class="prop-group" style="border:1px solid #ffd54f">
        <h5 style="color:#ffe082">📦 Свойства Контейнера (Лут внутри: ${containerItems.length}/${item.containerCapacity || 6})</h5>
        <div class="prop-row"><label>Вместимость</label><input type="number" min="1" max="16" class="ed-inp" id="inpWiContCap" value="${item.containerCapacity || 6}"></div>
        <div class="prop-row">
          <label>При разбитии (0 HP)</label>
          <input type="checkbox" id="inpWiDropBreak" ${item.dropItemsOnBreak !== false ? 'checked' : ''}>
          <span>Выбрасывать предметы наружу</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;margin:4px 0">${containerRowsHTML}</div>
        <div style="display:flex;gap:4px">
          <select class="ed-inp" id="selAddContLib" style="flex:1">${libAddSelectHTML}</select>
          <button class="ed-btn apply-oneclick" id="btnAddContItem" type="button">➕ Положить</button>
        </div>
      </div>
      ` : ''}

      <div class="prop-group">
        <h5>✋ Калибровка Точки Хвата и 🔫 Точки Выстрела</h5>
        <div class="prop-row"><label>Точка Хвата XYZ</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpGripX" value="${Number(gPos.x).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpGripY" value="${Number(gPos.y).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpGripZ" value="${Number(gPos.z).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот Хвата°</label><div class="vec3">
          <input type="number" step="10" class="ed-inp" id="inpGripRX" value="${Math.round(THREE.MathUtils.radToDeg(gRot.x || 0))}">
          <input type="number" step="10" class="ed-inp" id="inpGripRY" value="${Math.round(THREE.MathUtils.radToDeg(gRot.y || 0))}">
          <input type="number" step="10" class="ed-inp" id="inpGripRZ" value="${Math.round(THREE.MathUtils.radToDeg(gRot.z || 0))}">
        </div></div>
        <div class="prop-row"><label>Дуло (Выстрел)</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpMuzX" value="${Number(mPos.x).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpMuzY" value="${Number(mPos.y).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpMuzZ" value="${Number(mPos.z).toFixed(2)}">
        </div></div>
      </div>

      <div class="prop-group">
        <h5>⭐ Библиотека и Быстрая Выдача</h5>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="ed-btn apply-oneclick" id="btnSaveItemLib" type="button" style="flex:1;justify-content:center">
            ${isEditingFromLib ? '💾 Обновить в Библиотеке' : '⭐ Сохранить в Библиотеку'}
          </button>
          <button class="ed-btn" id="btnGiveToPlayerNow" type="button" style="justify-content:center">🎒 Выдать Игроку</button>
        </div>
      </div>
    `;

    if ($('btnWiOpenStudio3D')) {
      $('btnWiOpenStudio3D').onclick = () => {
        selectedRef.inWorldPlacement = false;
        rebuildAndReselectWi('part', partIdx);
      };
    }
    if ($('btnWiPlaceOnMap')) {
      $('btnWiPlaceOnMap').onclick = () => {
        selectedRef.inWorldPlacement = true;
        closeItemStudio3D(false);
        selectEditorObject({
          kind: 'world_item',
          worldEntry: wi,
          item,
          partIdx,
          editMode: 'root',
          inWorldPlacement: true,
          mesh: wi.group,
          libraryItemRef: selectedRef.libraryItemRef || null
        });
        showBanner('📍 Предмет перенесён на карту. Перемещайте его стрелками Гизмо!', '#ffd54f');
      };
    }

    $('btnWiModeRoot').onclick = () => {
      selectedRef.inWorldPlacement = true;
      closeItemStudio3D(false);
      selectEditorObject({
        kind: 'world_item',
        worldEntry: wi,
        item,
        partIdx,
        editMode: 'root',
        inWorldPlacement: true,
        mesh: wi.group,
        libraryItemRef: selectedRef.libraryItemRef || null
      });
    };
    $('btnWiModePart').onclick = () => {
      selectedRef.inWorldPlacement = false;
      rebuildAndReselectWi('part', 0);
    };
    $('btnWiModeGrip').onclick = () => {
      selectedRef.inWorldPlacement = false;
      rebuildAndReselectWi('grip', partIdx);
    };
    $('btnWiModeMuzzle').onclick = () => {
      selectedRef.inWorldPlacement = false;
      rebuildAndReselectWi('muzzle', partIdx);
    };
    if ($('btnWiModeProj')) {
      $('btnWiModeProj').onclick = () => {
        selectedRef.inWorldPlacement = false;
        rebuildAndReselectWi('proj_part', 0);
      };
    }

    $('wiName').oninput = e => {
      item.name = e.target.value;
      syncLibraryWorldItemIfEditing(selectedRef);
      if (S.player) syncPlayerHotbarUI();
      if ($('itemStudioSubjectTitle') && S.itemStudioOpen) {
        $('itemStudioSubjectTitle').textContent = `🗡️ 3D STUDIO: ${item.name || 'Предмет'}`;
      }
      refreshHierarchyUI();
    };
    $('wiIcon').oninput = e => {
      item.icon = e.target.value || '🗡️';
      syncLibraryWorldItemIfEditing(selectedRef);
      if (S.player) syncPlayerHotbarUI();
      refreshHierarchyUI();
    };
    $('wiHoldMode').onchange = e => {
      item.holdMode = e.target.value;
      syncLibraryWorldItemIfEditing(selectedRef);
      syncItemStudioPreview();
      renderInspectorUI();
    };
    $('wiUseType').onchange = e => {
      item.useType = e.target.value;
      rebuildAndReselectWi(editMode === 'proj_part' ? 'part' : editMode, 0);
    };

    const applyRootPos = () => {
      wi.x = +$('inpWiRootX').value || 0;
      wi.y = +$('inpWiRootY').value || 0;
      wi.z = +$('inpWiRootZ').value || 0;
      wi.baseY = wi.y;
      if (!S.itemStudioOpen) {
        wi.group.position.set(wi.x, wi.y, wi.z);
        selBoxHelper.setFromObject(wi.group);
      }
    };
    ['inpWiRootX', 'inpWiRootY', 'inpWiRootZ'].forEach(id => {
      if ($(id)) $(id).oninput = applyRootPos;
    });

    cont.querySelectorAll('[data-wipart]').forEach(btn => {
      btn.onclick = () => rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', +btn.dataset.wipart);
    });

    $('btnAddWiPart').onclick = () => {
      activePartsList.push(normalizePartEffects({
        name: `Деталь ${activePartsList.length + 1}`,
        shape: 'box',
        color: '#56f0ff',
        x: 0,
        y: 0.25,
        z: 0,
        sx: 0.25,
        sy: 0.25,
        sz: 0.25,
        rx: 0,
        ry: 0,
        rz: 0,
        texDataURL: null
      }, false, false));
      rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', activePartsList.length - 1);
    };

    $('btnDupWiPart').onclick = () => {
      const clone = JSON.parse(JSON.stringify(part));
      clone.name = (clone.name || 'Деталь') + ' (копия)';
      clone.y = +(Number(clone.y || 0) + 0.15).toFixed(2);
      activePartsList.push(normalizePartEffects(clone, false, false));
      rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', activePartsList.length - 1);
    };

    if ($('btnDelWiPart')) {
      $('btnDelWiPart').onclick = () => {
        if (activePartsList.length <= 1) return;
        activePartsList.splice(partIdx, 1);
        rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', Math.max(0, partIdx - 1));
      };
    }

    $('wiPartName').oninput = e => {
      part.name = e.target.value;
      syncLibraryWorldItemIfEditing(selectedRef);
    };
    $('wiPartShape').onchange = e => {
      part.shape = e.target.value;
      rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', partIdx);
    };
    $('wiPartCol').oninput = e => {
      part.color = e.target.value;
      if (selectedRef.mesh && selectedRef.mesh.material && (editMode === 'part' || editMode === 'proj_part')) {
        selectedRef.mesh.material.color.set(e.target.value);
        syncActivePartMeshEmissive(selectedRef.mesh, part);
      } else {
        rebuildWorldItemVisuals(wi);
      }
      syncLibraryWorldItemIfEditing(selectedRef);
      syncItemStudioPreview();
    };
    $('btnPaintWiPart').onclick = () => openPaintModal('world_item');
    if ($('btnClearWiPartSpr')) {
      $('btnClearWiPartSpr').onclick = () => {
        part.texDataURL = null;
        if (selectedRef.mesh) setMeshFrontSprite(selectedRef.mesh, null);
        rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', partIdx);
      };
    }

    const applyWiPartVec = () => {
      part.x = +$('inpWiPX').value || 0;
      part.y = +$('inpWiPY').value || 0;
      part.z = +$('inpWiPZ').value || 0;
      part.sx = Math.max(0.04, +$('inpWiSX').value || 0.25);
      part.sy = Math.max(0.04, +$('inpWiSY').value || 0.25);
      part.sz = Math.max(0.04, +$('inpWiSZ').value || 0.25);
      part.rx = THREE.MathUtils.degToRad(+$('inpWiRX').value || 0);
      part.ry = THREE.MathUtils.degToRad(+$('inpWiRY').value || 0);
      part.rz = THREE.MathUtils.degToRad(+$('inpWiRZ').value || 0);

      if (selectedRef.mesh && (editMode === 'part' || editMode === 'proj_part')) {
        const m = selectedRef.mesh;
        m.position.set(part.x, part.y, part.z);
        m.scale.set(part.sx, part.sy, part.sz);
        m.rotation.set(part.rx, part.ry, part.rz);
        m.updateMatrixWorld(true);
        selBoxHelper.setFromObject(m);
      }
      syncLibraryWorldItemIfEditing(selectedRef);
      syncItemStudioPreview();
    };
    ['inpWiPX', 'inpWiPY', 'inpWiPZ', 'inpWiSX', 'inpWiSY', 'inpWiSZ', 'inpWiRX', 'inpWiRY', 'inpWiRZ'].forEach(id => {
      $(id).oninput = applyWiPartVec;
    });

    // Обработчики свечения и частиц выбранной детали (в разделе «🎨 Внешний вид»)
    $('inpWiPartPseudo').onchange = e => {
      part.pseudoLight = e.target.checked;
      if (part.pseudoLight && !part.lightColor) part.lightColor = part.color || '#56f0ff';
      rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', partIdx);
    };
    $('inpWiPartReal').onchange = e => {
      part.realLight = e.target.checked;
      if (part.realLight && !part.lightColor) part.lightColor = part.color || '#56f0ff';
      rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', partIdx);
    };
    $('inpWiPartPtOn').onchange = e => {
      ptData.enabled = e.target.checked;
      rebuildAndReselectWi(isProjMode ? 'proj_part' : 'part', partIdx);
    };

    if ($('inpWiPartLCol')) {
      $('inpWiPartLCol').oninput = e => {
        part.lightColor = e.target.value;
        if (selectedRef.mesh) syncActivePartMeshEmissive(selectedRef.mesh, part);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('btnWiPartLMatch')) {
      $('btnWiPartLMatch').onclick = () => {
        part.lightColor = part.color || '#56f0ff';
        if ($('inpWiPartLCol')) $('inpWiPartLCol').value = part.lightColor;
        if (selectedRef.mesh) syncActivePartMeshEmissive(selectedRef.mesh, part);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiPartLInt')) {
      $('inpWiPartLInt').oninput = e => {
        part.lightIntensity = +e.target.value || 1.4;
        if ($('txtWiPartLInt')) $('txtWiPartLInt').textContent = part.lightIntensity.toFixed(1);
        if (selectedRef.mesh) syncActivePartMeshEmissive(selectedRef.mesh, part);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiPartLDist')) {
      $('inpWiPartLDist').oninput = e => {
        part.lightDistance = Math.max(2, +e.target.value || 12);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }

    if ($('inpWiPartPtPreset')) {
      $('inpWiPartPtPreset').onchange = e => {
        ptData.preset = e.target.value;
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('btnPaintWiPartPt')) {
      $('btnPaintWiPartPt').onclick = () => {
        S.paintParticleScope = 'part';
        openPaintModal('particle');
      };
    }
    if ($('inpWiPartPtCol')) {
      $('inpWiPartPtCol').oninput = e => {
        ptData.color = e.target.value;
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiPartPtRate')) {
      $('inpWiPartPtRate').oninput = e => {
        ptData.rate = Math.max(1, +e.target.value || 10);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiPartPtSize')) {
      $('inpWiPartPtSize').oninput = e => {
        ptData.sizeStart = Math.max(0.05, +e.target.value || 0.28);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiPartPtSpd')) {
      $('inpWiPartPtSpd').oninput = e => {
        ptData.speed = Math.max(0, +e.target.value || 1.6);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiPartPtGrav')) {
      $('inpWiPartPtGrav').oninput = e => {
        ptData.gravity = +e.target.value || 0;
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }

    if ($('inpWiDmg')) $('inpWiDmg').oninput = e => { item.damage = Math.max(0, +e.target.value || 0); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiCd')) $('inpWiCd').oninput = e => { item.cooldown = Math.max(0.08, +e.target.value || 0.35); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiRange')) $('inpWiRange').oninput = e => { item.range = Math.max(1, +e.target.value || 4.2); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiKnock')) $('inpWiKnock').oninput = e => { item.knockback = Math.max(0, +e.target.value || 0); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiProjSpd')) $('inpWiProjSpd').oninput = e => { item.projSpeed = Math.max(4, +e.target.value || 36); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiProjGrv')) $('inpWiProjGrv').oninput = e => { item.projGravity = Math.max(0, +e.target.value || 0); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiSplash')) $('inpWiSplash').oninput = e => { item.splashRadius = Math.max(0, +e.target.value || 0); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiProjCol')) $('inpWiProjCol').oninput = e => { item.projColor = e.target.value; syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiMinThrow')) $('inpWiMinThrow').oninput = e => { item.minThrowSpeed = Math.max(2, +e.target.value || 8); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiMaxChg')) $('inpWiMaxChg').oninput = e => { item.maxChargeTime = Math.max(0.2, +e.target.value || 1.15); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiProjBounce')) $('inpWiProjBounce').oninput = e => { item.projBounce = Math.min(0.95, Math.max(0, +e.target.value || 0)); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiConsumeThrow')) $('inpWiConsumeThrow').onchange = e => { item.consumeOnThrow = e.target.checked; syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiStackCount')) $('inpWiStackCount').oninput = e => { item.stackCount = Math.max(1, +e.target.value || 1); syncLibraryWorldItemIfEditing(selectedRef); if (S.player) syncPlayerHotbarUI(); };
    if ($('inpWiMaxStackThrow')) $('inpWiMaxStackThrow').oninput = e => { item.maxStack = Math.max(1, +e.target.value || 5); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiAmmo')) $('inpWiAmmo').oninput = e => { item.ammo = Math.max(0, +e.target.value || 0); syncLibraryWorldItemIfEditing(selectedRef); if (S.player) syncPlayerHotbarUI(); };
    if ($('inpWiMaxAmmo')) $('inpWiMaxAmmo').oninput = e => { item.maxAmmo = Math.max(0, +e.target.value || 0); syncLibraryWorldItemIfEditing(selectedRef); if (S.player) syncPlayerHotbarUI(); };
    if ($('inpWiReloadTime')) $('inpWiReloadTime').oninput = e => { item.reloadTime = Math.max(0.2, +e.target.value || 1.4); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiReloadHold')) $('inpWiReloadHold').onchange = e => { item.reloadHold = e.target.checked; syncLibraryWorldItemIfEditing(selectedRef); };

    if ($('inpWiHeal')) $('inpWiHeal').oninput = e => { item.healAmount = +e.target.value || 0; syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiBuffSpd')) $('inpWiBuffSpd').oninput = e => { item.speedBoost = +e.target.value || 0; syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiBuffDur')) $('inpWiBuffDur').oninput = e => { item.buffDuration = Math.max(0, +e.target.value || 0); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiBuffJmp')) $('inpWiBuffJmp').oninput = e => { item.jumpBoost = +e.target.value || 0; syncLibraryWorldItemIfEditing(selectedRef); };

    if ($('inpWiDurCur')) $('inpWiDurCur').oninput = e => { item.durability = Math.max(0, +e.target.value || 0); syncLibraryWorldItemIfEditing(selectedRef); if (S.player) syncPlayerHotbarUI(); };
    if ($('inpWiDurMax')) $('inpWiDurMax').oninput = e => { item.maxDurability = Math.max(0, +e.target.value || 0); if (item.maxDurability > 0 && !item.durability) item.durability = item.maxDurability; syncLibraryWorldItemIfEditing(selectedRef); if (S.player) syncPlayerHotbarUI(); };
    if ($('inpWiCanWear')) $('inpWiCanWear').onchange = e => { item.canWearAsArmor = e.target.checked; syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiWearSlot')) $('inpWiWearSlot').onchange = e => { item.wearSlot = e.target.value; syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiArmor')) $('inpWiArmor').oninput = e => { item.armorBonus = Math.min(85, Math.max(0, +e.target.value || 0)); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiMaxStackGen')) $('inpWiMaxStackGen').oninput = e => { item.maxStack = Math.max(1, +e.target.value || 1); syncLibraryWorldItemIfEditing(selectedRef); };

    // Обработчики свечения и частиц всего предмета (в разделе «⚙️ Свойства предмета»)
    if ($('inpWiItemRealLight')) {
      $('inpWiItemRealLight').onchange = e => {
        itemLd.realLight = e.target.checked;
        itemLd.enabled = Boolean(itemLd.realLight || itemLd.pseudoLight);
        rebuildAndReselectWi(editMode, partIdx);
      };
    }
    if ($('inpWiItemPseudoLight')) {
      $('inpWiItemPseudoLight').onchange = e => {
        itemLd.pseudoLight = e.target.checked;
        itemLd.enabled = Boolean(itemLd.realLight || itemLd.pseudoLight);
        rebuildAndReselectWi(editMode, partIdx);
      };
    }
    if ($('inpWiItemPtOn')) {
      $('inpWiItemPtOn').onchange = e => {
        itemPd.enabled = e.target.checked;
        rebuildAndReselectWi(editMode, partIdx);
      };
    }
    if ($('inpWiLightToggleLMB')) {
      $('inpWiLightToggleLMB').onchange = e => {
        itemLd.toggleByLMB = e.target.checked;
        syncLibraryWorldItemIfEditing(selectedRef);
      };
    }
    if ($('inpWiLightActive')) {
      $('inpWiLightActive').onchange = e => {
        itemLd.active = e.target.checked;
        rebuildAndReselectWi(editMode, partIdx);
      };
    }
    if ($('inpWiLightCol')) {
      $('inpWiLightCol').oninput = e => {
        itemLd.color = e.target.value;
        rebuildWorldItemVisuals(wi);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiLightDist')) {
      $('inpWiLightDist').oninput = e => {
        itemLd.distance = Math.max(3, +e.target.value || 18);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiLightInt')) {
      $('inpWiLightInt').oninput = e => {
        itemLd.intensity = Math.max(0.2, +e.target.value || 1.8);
        rebuildWorldItemVisuals(wi);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }

    if ($('inpWiItemPtPreset')) {
      $('inpWiItemPtPreset').onchange = e => {
        itemPd.preset = e.target.value;
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('btnPaintWiItemPt')) {
      $('btnPaintWiItemPt').onclick = () => {
        S.paintParticleScope = 'item';
        openPaintModal('particle');
      };
    }
    if ($('inpWiItemPtCol')) {
      $('inpWiItemPtCol').oninput = e => {
        itemPd.color = e.target.value;
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiItemPtRate')) {
      $('inpWiItemPtRate').oninput = e => {
        itemPd.rate = Math.max(1, +e.target.value || 10);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiItemPtSize')) {
      $('inpWiItemPtSize').oninput = e => {
        itemPd.sizeStart = Math.max(0.05, +e.target.value || 0.28);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiItemPtSpd')) {
      $('inpWiItemPtSpd').oninput = e => {
        itemPd.speed = Math.max(0, +e.target.value || 1.6);
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpWiItemPtGrav')) {
      $('inpWiItemPtGrav').oninput = e => {
        itemPd.gravity = +e.target.value || 0;
        syncLibraryWorldItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }

    if ($('inpWiContCap')) $('inpWiContCap').oninput = e => { item.containerCapacity = Math.max(1, +e.target.value || 6); syncLibraryWorldItemIfEditing(selectedRef); };
    if ($('inpWiDropBreak')) $('inpWiDropBreak').onchange = e => { item.dropItemsOnBreak = e.target.checked; syncLibraryWorldItemIfEditing(selectedRef); };

    if ($('btnAddContItem')) {
      $('btnAddContItem').onclick = () => {
        const libIdx = +$('selAddContLib').value;
        const tpl = S.savedItemsLibrary[libIdx];
        if (!tpl) return;
        if (!item.containerItems) item.containerItems = [];
        if (item.containerItems.length >= (item.containerCapacity || 6)) {
          showBanner('📦 Контейнер уже заполнен до предела!', '#ff5252');
          return;
        }
        item.containerItems.push(normalizeItemData(JSON.parse(JSON.stringify(tpl))));
        syncLibraryWorldItemIfEditing(selectedRef);
        renderInspectorUI();
      };
    }
    cont.querySelectorAll('[data-delcontitem]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.delcontitem;
        item.containerItems.splice(idx, 1);
        syncLibraryWorldItemIfEditing(selectedRef);
        renderInspectorUI();
      };
    });

    const applyGripMuzzleVec = () => {
      item.gripPos = {
        x: +$('inpGripX').value || 0,
        y: +$('inpGripY').value || 0,
        z: +$('inpGripZ').value || 0
      };
      item.gripRot = {
        x: THREE.MathUtils.degToRad(+$('inpGripRX').value || 0),
        y: THREE.MathUtils.degToRad(+$('inpGripRY').value || 0),
        z: THREE.MathUtils.degToRad(+$('inpGripRZ').value || 0)
      };
      item.muzzlePos = {
        x: +$('inpMuzX').value || 0,
        y: +$('inpMuzY').value || 0,
        z: +$('inpMuzZ').value || 0
      };
      const markers = ensureItemEditorMarkers(wi);
      if (markers.gripMarker) {
        markers.gripMarker.position.set(item.gripPos.x, item.gripPos.y, item.gripPos.z);
        markers.gripMarker.rotation.set(item.gripRot.x, item.gripRot.y, item.gripRot.z);
      }
      if (markers.muzzleMarker) {
        markers.muzzleMarker.position.set(item.muzzlePos.x, item.muzzlePos.y, item.muzzlePos.z);
      }
      if (S.player) syncEntityHeldItemMesh(S.player);
      syncLibraryWorldItemIfEditing(selectedRef);
      syncItemStudioPreview();
    };
    ['inpGripX', 'inpGripY', 'inpGripZ', 'inpGripRX', 'inpGripRY', 'inpGripRZ', 'inpMuzX', 'inpMuzY', 'inpMuzZ'].forEach(id => {
      $(id).oninput = applyGripMuzzleVec;
    });

    $('btnSaveItemLib').onclick = () => {
      const existingIdx = S.savedItemsLibrary.findIndex(l => l.id === item.id);
      if (existingIdx !== -1) {
        S.savedItemsLibrary[existingIdx] = JSON.parse(JSON.stringify(item));
        sfx.cash();
        showBanner(`💾 Предмет «${item.name}» обновлён в Библиотеке Предметов!`, '#00e676');
      } else {
        S.savedItemsLibrary.push(JSON.parse(JSON.stringify(item)));
        sfx.cash();
        showBanner(`⭐ Предмет «${item.name}» добавлен в Библиотеку Предметов!`, '#00e676');
        renderInspectorUI();
      }
    };

    $('btnGiveToPlayerNow').onclick = () => {
      if (!S.player) return;
      const freeSlot = S.player.inventory.findIndex(s => !s);
      const slotIdx = freeSlot !== -1 ? freeSlot : S.player.activeSlot || 0;
      equipItemToCharacterSlot(S.player, slotIdx, item);
      sfx.buy();
      showBanner(`🎒 «${item.name}» выдан Игроку в слот [${slotIdx + 1}]!`, '#00e676');
    };
    return;
  }

  // 3. ИНСПЕКТОР КАСТОМНОГО АКСЕССУАРА / ПИТОМЦА (Многосоставная группа примитивов)
  if (selectedRef.kind === 'cosmetic') {
    const ent = selectedRef.ent;
    const item = selectedRef.item;
    if (!Array.isArray(item.parts) || item.parts.length === 0) {
      rebuildCharacterCosmetics(ent);
    }
    const partIdx = Math.min(Math.max(0, selectedRef.partIdx ?? 0), item.parts.length - 1);
    const part = item.parts[partIdx];
    normalizePartEffects(part, item.slot === 'pet', false);
    const ptData = part.particleData;
    const isEditingFromLib = Boolean(selectedRef.libraryItemRef);

    const slotOpts = Object.entries(COSMETIC_SLOTS)
      .map(([k, v]) => `<option value="${k}" ${item.slot === k ? 'selected' : ''}>${v.label}</option>`)
      .join('');
    const shapeOpts = Object.entries(COSMETIC_SHAPES)
      .map(([k, lbl]) => `<option value="${k}" ${part.shape === k ? 'selected' : ''}>${lbl}</option>`)
      .join('');

    const partChipsHTML = item.parts
      .map((pt, idx) => {
        const isSel = idx === partIdx;
        const fxBadge = (pt.realLight ? '💡' : (pt.pseudoLight ? '✨' : '')) + (pt.particleData?.enabled ? '🎆' : '');
        return `<button class="ed-btn ${isSel ? 'active' : ''}" data-cospart="${idx}" type="button" style="padding:3px 7px;font-size:10px">${idx + 1}. ${pt.name || pt.shape}${fxBadge ? ' ' + fxBadge : ''}</button>`;
      })
      .join('');

    cont.innerHTML = `
      <div class="prop-group" style="border:1.5px solid #ffd54f;background:rgba(255,213,79,0.06)">
        <h5 style="color:#ffd54f">
          <span>🎩 Кастомный Аксессуар / Питомец</span>
          <button class="ed-btn" id="btnBackToChar" type="button" style="padding:2px 7px;font-size:10px">⬅ К Персонажу</button>
        </h5>
        ${S.itemStudioOpen ? `
          <button class="ed-btn" id="btnCosExitStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:6px;background:rgba(255,179,0,0.16);border-color:#ffb300;color:#ffe082">📍 Вернуть камеру на карту (Выйти из 3D STUDIO)</button>
        ` : `
          <button class="ed-btn apply-oneclick" id="btnCosOpenStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:6px;background:rgba(86,240,255,0.16);border-color:#56f0ff;color:#56f0ff">🛠️ Открыть в 3D STUDIO</button>
        `}
        ${isEditingFromLib ? `<div style="font:800 10px var(--f);color:#00e676;background:rgba(0,230,118,0.12);border:1px solid #00e676;border-radius:6px;padding:4px 7px">✏️ Режим правки шаблона из Гардероба (сохраняется автоматически)</div>` : ''}
        <div class="prop-row"><label>Название</label><input class="ed-inp" id="cosName" value="${item.name}"></div>
        <div class="prop-row"><label>Куда крепить</label><select class="ed-inp" id="cosSlot">${slotOpts}</select></div>
      </div>

      <div class="prop-group" style="border:1px solid #38bdf8">
        <h5 style="color:#7dd3fc">
          <span>🎨 Внешний вид (${item.parts.length})</span>
          <div style="display:flex;gap:4px">
            <button class="ed-btn apply-oneclick" id="btnAddCosPart" type="button" style="padding:2px 7px;font-size:10px">➕ Деталь</button>
            <button class="ed-btn" id="btnDupCosPart" type="button" style="padding:2px 7px;font-size:10px" title="Дублировать деталь">📋</button>
            ${item.parts.length > 1 ? `<button class="ed-btn danger" id="btnDelCosPart" type="button" style="padding:2px 7px;font-size:10px" title="Удалить деталь">🗑️</button>` : ''}
          </div>
        </h5>
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px">${partChipsHTML}</div>

        <div class="prop-row"><label>Имя детали</label><input class="ed-inp" id="cosPartName" value="${part.name || 'Деталь'}"></div>
        <div class="prop-row"><label>Форма 3D</label><select class="ed-inp" id="cosShape">${shapeOpts}</select></div>
        <div class="prop-row">
          <label>Цвет и 2D</label>
          <input type="color" class="ed-color" id="cosCol" value="${part.color}">
          <button class="ed-btn apply-oneclick" id="btnPaintCos" type="button" style="flex:1;justify-content:center">🎨 Спрайт спереди</button>
          ${part.texDataURL ? `<button class="ed-btn danger" id="btnClearCosSpr" type="button" title="Убрать спрайт">✕</button>` : ''}
        </div>

        <div class="prop-row"><label>Смещение</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpCosPX" value="${Number(part.x).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpCosPY" value="${Number(part.y).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpCosPZ" value="${Number(part.z).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Размер</label><div class="vec3">
          <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpCosSX" value="${Number(part.sx).toFixed(2)}">
          <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpCosSY" value="${Number(part.sy).toFixed(2)}">
          <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpCosSZ" value="${Number(part.sz).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот°</label><div class="vec3">
          <input type="number" step="10" class="ed-inp" id="inpCosRX" value="${Math.round(THREE.MathUtils.radToDeg(part.rx || 0))}">
          <input type="number" step="10" class="ed-inp" id="inpCosRY" value="${Math.round(THREE.MathUtils.radToDeg(part.ry || 0))}">
          <input type="number" step="10" class="ed-inp" id="inpCosRZ" value="${Math.round(THREE.MathUtils.radToDeg(part.rz || 0))}">
        </div></div>

        <div style="margin-top:6px;padding-top:6px;border-top:1px dashed #283147;display:flex;flex-direction:column;gap:5px">
          <div style="font:800 10px var(--f);color:#94a3b8;text-transform:uppercase">Свечение и частицы детали («${part.name || 'Деталь'}»):</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
              <input type="checkbox" id="inpCosPartPseudo" ${part.pseudoLight ? 'checked' : ''}> ✨ Псевдо-свет
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
              <input type="checkbox" id="inpCosPartReal" ${part.realLight ? 'checked' : ''}> 💡 Настоящий свет
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#56f0ff;cursor:pointer">
              <input type="checkbox" id="inpCosPartPtOn" ${ptData.enabled ? 'checked' : ''}> 🎆 Частицы
            </label>
          </div>

          <div id="cosPartLightFields" ${(part.pseudoLight || part.realLight) ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(255,213,79,0.06);padding:6px;border-radius:7px;border:1px solid rgba(255,213,79,0.28)">
            <div class="prop-row">
              <label>Цвет свечения</label>
              <input type="color" class="ed-color" id="inpCosPartLCol" value="${part.lightColor || part.color || '#56f0ff'}">
              <button class="ed-btn" id="btnCosPartLMatch" type="button" style="flex:1;justify-content:center">🎨 В цвет детали</button>
            </div>
            <div class="prop-row">
              <label>Яркость</label>
              <input type="range" min="0.2" max="4.0" step="0.1" id="inpCosPartLInt" value="${part.lightIntensity ?? 1.4}" style="flex:1">
              <span id="txtCosPartLInt" style="font-size:10px;width:30px;text-align:right">${Number(part.lightIntensity ?? 1.4).toFixed(1)}</span>
            </div>
            <div class="prop-row" id="rowCosPartLDist" ${part.realLight ? '' : 'hidden'}>
              <label>Радиус света (м)</label>
              <input type="number" min="2" max="60" step="1" class="ed-inp" id="inpCosPartLDist" value="${part.lightDistance ?? 12}">
            </div>
          </div>

          <div id="cosPartPtFields" ${ptData.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(86,240,255,0.06);padding:6px;border-radius:7px;border:1px solid rgba(86,240,255,0.28)">
            <div class="prop-row">
              <label>Шаблон частицы</label>
              <select class="ed-inp" id="inpCosPartPtPreset" style="flex:1">
                <option value="spark" ${ptData.preset === 'spark' ? 'selected' : ''}>💠 Искра (Spark)</option>
                <option value="fire" ${ptData.preset === 'fire' ? 'selected' : ''}>🔥 Огонь (Fire)</option>
                <option value="heart" ${ptData.preset === 'heart' ? 'selected' : ''}>❤️ Сердечко (Heart)</option>
                <option value="star" ${ptData.preset === 'star' ? 'selected' : ''}>⭐ Звезда (Star)</option>
                <option value="smoke" ${ptData.preset === 'smoke' ? 'selected' : ''}>💨 Дым (Smoke)</option>
                <option value="hit" ${ptData.preset === 'hit' ? 'selected' : ''}>💥 Всплеск (Hit)</option>
                <option value="custom" ${ptData.preset === 'custom' ? 'selected' : ''}>🎨 Свой 16×16</option>
              </select>
              <button class="ed-btn apply-oneclick" id="btnPaintCosPartPt" type="button">🖌️ 16×16</button>
            </div>
            <div class="prop-row">
              <label>Оттенок и Кол/с</label>
              <input type="color" class="ed-color" id="inpCosPartPtCol" value="${ptData.color || '#ffffff'}">
              <input type="number" min="1" max="60" step="1" class="ed-inp" id="inpCosPartPtRate" value="${ptData.rate ?? 10}" style="width:70px">
            </div>
            <div class="prop-row">
              <label>Размер / Скор. / Y</label>
              <div class="vec3">
                <input type="number" step="0.05" min="0.05" max="3" class="ed-inp" id="inpCosPartPtSize" value="${ptData.sizeStart ?? 0.28}">
                <input type="number" step="0.2" min="0" max="20" class="ed-inp" id="inpCosPartPtSpd" value="${ptData.speed ?? 1.6}">
                <input type="number" step="0.5" class="ed-inp" id="inpCosPartPtGrav" value="${ptData.gravity ?? 1.5}">
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="prop-group">
        <h5>⭐ Гардероб (Библиотека) и Быстрые действия</h5>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="ed-btn apply-oneclick" id="btnSaveCosLib" type="button" style="flex:1;justify-content:center">
            ${isEditingFromLib ? '💾 Сохранить изменения в Гардероб' : '⭐ Сохранить как новый в Гардероб'}
          </button>
        </div>
      </div>
    `;

    const rebuildAndReselect = (newPartIdx = partIdx) => {
      rebuildCharacterCosmetics(ent);
      const foundGroup = (ent.rig.customCosMeshes || []).find(
        g => g.userData && g.userData.cosmeticItem === item
      );
      if (foundGroup) {
        const safeIdx = Math.min(Math.max(0, newPartIdx), foundGroup.children.length - 1);
        const childMesh = foundGroup.children[safeIdx] || foundGroup;
        selectEditorObject({
          kind: 'cosmetic',
          ent,
          item,
          group: foundGroup,
          partIdx: safeIdx,
          part: item.parts[safeIdx],
          mesh: childMesh,
          libraryItemRef: selectedRef.libraryItemRef || null
        });
      }
      syncLibraryItemIfEditing(selectedRef);
      syncItemStudioPreview();
    };

    $('btnBackToChar').onclick = () => {
      closeItemStudio3D(false);
      selectEditorObject({ kind: 'char', ent });
    };
    if ($('btnCosOpenStudio3D')) {
      $('btnCosOpenStudio3D').onclick = () => {
        openItemStudio3D(selectedRef);
        renderInspectorUI();
      };
    }
    if ($('btnCosExitStudio3D')) {
      $('btnCosExitStudio3D').onclick = () => {
        closeItemStudio3D(false);
        renderInspectorUI();
      };
    }

    $('cosName').oninput = e => {
      item.name = e.target.value;
      if ($('itemStudioSubjectTitle') && S.itemStudioOpen) {
        $('itemStudioSubjectTitle').textContent = `🎩 3D STUDIO: ${item.name || 'Аксессуар'}`;
      }
      syncLibraryItemIfEditing(selectedRef);
    };
    $('cosSlot').onchange = e => {
      pushCosmeticUndoState('Смена слота аксессуара');
      item.slot = e.target.value;
      rebuildAndReselect(partIdx);
    };

    cont.querySelectorAll('[data-cospart]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.cospart;
        rebuildAndReselect(idx);
      };
    });

    $('btnAddCosPart').onclick = () => {
      pushCosmeticUndoState('Добавление детали аксессуара');
      const newPart = normalizePartEffects({
        name: `Деталь ${item.parts.length + 1}`,
        shape: 'box',
        color: '#56f0ff',
        x: 0,
        y: (part.y || 0) + 0.35,
        z: 0,
        sx: 0.4,
        sy: 0.4,
        sz: 0.4,
        rx: 0,
        ry: 0,
        rz: 0,
        texDataURL: null
      }, item.slot === 'pet', false);
      item.parts.push(newPart);
      rebuildAndReselect(item.parts.length - 1);
    };

    $('btnDupCosPart').onclick = () => {
      pushCosmeticUndoState('Дублирование детали аксессуара');
      const clone = JSON.parse(JSON.stringify(part));
      clone.name = (clone.name || 'Деталь') + ' (копия)';
      clone.x = +(Number(clone.x || 0) + 0.25).toFixed(2);
      item.parts.push(normalizePartEffects(clone, item.slot === 'pet', false));
      rebuildAndReselect(item.parts.length - 1);
    };

    if ($('btnDelCosPart')) {
      $('btnDelCosPart').onclick = () => {
        if (item.parts.length <= 1) return;
        pushCosmeticUndoState('Удаление детали аксессуара');
        item.parts.splice(partIdx, 1);
        rebuildAndReselect(Math.max(0, partIdx - 1));
      };
    }

    $('cosPartName').oninput = e => {
      part.name = e.target.value;
      syncLibraryItemIfEditing(selectedRef);
    };
    $('cosShape').onchange = e => {
      pushCosmeticUndoState('Смена формы детали');
      part.shape = e.target.value;
      rebuildAndReselect(partIdx);
    };
    $('cosCol').onfocus = () => pushCosmeticUndoState('Смена цвета детали');
    $('cosCol').oninput = e => {
      part.color = e.target.value;
      if (selectedRef.mesh && selectedRef.mesh.material) {
        selectedRef.mesh.material.color.set(e.target.value);
        syncActivePartMeshEmissive(selectedRef.mesh, part);
      }
      syncLibraryItemIfEditing(selectedRef);
    };
    $('btnPaintCos').onclick = () => openPaintModal('cosmetic');
    if ($('btnClearCosSpr')) {
      $('btnClearCosSpr').onclick = () => {
        pushCosmeticUndoState('Удаление спрайта детали');
        part.texDataURL = null;
        if (selectedRef.mesh) setMeshFrontSprite(selectedRef.mesh, null);
        syncLibraryItemIfEditing(selectedRef);
        renderInspectorUI();
      };
    }

    const applyPartVec = () => {
      part.x = +$('inpCosPX').value || 0;
      part.y = +$('inpCosPY').value || 0;
      part.z = +$('inpCosPZ').value || 0;
      part.sx = Math.max(0.05, +$('inpCosSX').value || 0.5);
      part.sy = Math.max(0.05, +$('inpCosSY').value || 0.5);
      part.sz = Math.max(0.05, +$('inpCosSZ').value || 0.5);
      part.rx = THREE.MathUtils.degToRad(+$('inpCosRX').value || 0);
      part.ry = THREE.MathUtils.degToRad(+$('inpCosRY').value || 0);
      part.rz = THREE.MathUtils.degToRad(+$('inpCosRZ').value || 0);

      if (selectedRef.mesh) {
        const m = selectedRef.mesh;
        m.position.set(part.x, part.y, part.z);
        m.scale.set(part.sx, part.sy, part.sz);
        m.rotation.set(part.rx, part.ry, part.rz);
        m.updateMatrixWorld(true);
        selBoxHelper.setFromObject(m);
      }
      syncLibraryItemIfEditing(selectedRef);
    };
    ['inpCosPX', 'inpCosPY', 'inpCosPZ', 'inpCosSX', 'inpCosSY', 'inpCosSZ', 'inpCosRX', 'inpCosRY', 'inpCosRZ'].forEach(id => {
      $(id).onfocus = () => pushCosmeticUndoState('Трансформация детали');
      $(id).oninput = applyPartVec;
    });

    // Обработчики свечения и частиц детали аксессуара
    $('inpCosPartPseudo').onchange = e => {
      pushCosmeticUndoState('Псевдо-свет детали аксессуара');
      part.pseudoLight = e.target.checked;
      if (part.pseudoLight && !part.lightColor) part.lightColor = part.color || '#56f0ff';
      rebuildAndReselect(partIdx);
    };
    $('inpCosPartReal').onchange = e => {
      pushCosmeticUndoState('Настоящий свет детали аксессуара');
      part.realLight = e.target.checked;
      if (part.realLight && !part.lightColor) part.lightColor = part.color || '#56f0ff';
      rebuildAndReselect(partIdx);
    };
    $('inpCosPartPtOn').onchange = e => {
      pushCosmeticUndoState('Частицы детали аксессуара');
      ptData.enabled = e.target.checked;
      rebuildAndReselect(partIdx);
    };

    if ($('inpCosPartLCol')) {
      $('inpCosPartLCol').oninput = e => {
        part.lightColor = e.target.value;
        if (selectedRef.mesh) syncActivePartMeshEmissive(selectedRef.mesh, part);
        syncLibraryItemIfEditing(selectedRef);
      };
    }
    if ($('btnCosPartLMatch')) {
      $('btnCosPartLMatch').onclick = () => {
        part.lightColor = part.color || '#56f0ff';
        if ($('inpCosPartLCol')) $('inpCosPartLCol').value = part.lightColor;
        if (selectedRef.mesh) syncActivePartMeshEmissive(selectedRef.mesh, part);
        syncLibraryItemIfEditing(selectedRef);
      };
    }
    if ($('inpCosPartLInt')) {
      $('inpCosPartLInt').oninput = e => {
        part.lightIntensity = +e.target.value || 1.4;
        if ($('txtCosPartLInt')) $('txtCosPartLInt').textContent = part.lightIntensity.toFixed(1);
        if (selectedRef.mesh) syncActivePartMeshEmissive(selectedRef.mesh, part);
        syncLibraryItemIfEditing(selectedRef);
      };
    }
    if ($('inpCosPartLDist')) {
      $('inpCosPartLDist').oninput = e => {
        part.lightDistance = Math.max(2, +e.target.value || 12);
        syncLibraryItemIfEditing(selectedRef);
      };
    }

    if ($('inpCosPartPtPreset')) {
      $('inpCosPartPtPreset').onchange = e => {
        ptData.preset = e.target.value;
        syncLibraryItemIfEditing(selectedRef);
      };
    }
    if ($('btnPaintCosPartPt')) {
      $('btnPaintCosPartPt').onclick = () => {
        S.paintParticleScope = 'part';
        openPaintModal('particle');
      };
    }
    if ($('inpCosPartPtCol')) {
      $('inpCosPartPtCol').oninput = e => {
        ptData.color = e.target.value;
        syncLibraryItemIfEditing(selectedRef);
      };
    }
    if ($('inpCosPartPtRate')) {
      $('inpCosPartPtRate').oninput = e => {
        ptData.rate = Math.max(1, +e.target.value || 10);
        syncLibraryItemIfEditing(selectedRef);
      };
    }
    if ($('inpCosPartPtSize')) {
      $('inpCosPartPtSize').oninput = e => {
        ptData.sizeStart = Math.max(0.05, +e.target.value || 0.28);
        syncLibraryItemIfEditing(selectedRef);
      };
    }
    if ($('inpCosPartPtSpd')) {
      $('inpCosPartPtSpd').oninput = e => {
        ptData.speed = Math.max(0, +e.target.value || 1.6);
        syncLibraryItemIfEditing(selectedRef);
      };
    }
    if ($('inpCosPartPtGrav')) {
      $('inpCosPartPtGrav').oninput = e => {
        ptData.gravity = +e.target.value || 0;
        syncLibraryItemIfEditing(selectedRef);
      };
    }

    $('btnSaveCosLib').onclick = () => {
      if (isEditingFromLib) {
        syncLibraryItemIfEditing(selectedRef);
        sfx.cash();
        showBanner(`💾 Изменения «${item.name}» сохранены в Гардеробе!`, '#00e676');
      } else {
        S.savedCosmeticsLibrary.push(JSON.parse(JSON.stringify(item)));
        sfx.cash();
        showBanner(`⭐ «${item.name}» (${item.parts.length} дет.) сохранён в общий Гардероб!`, '#00e676');
        renderInspectorUI();
      }
    };
    return;
  }

  // 4. ИНСПЕКТОР БЛОКА СЦЕНЫ (Быстрые роли Bricks Logic, Свечение, Партиклы, Физика)
  if (selectedRef.kind === 'block') {
    const box = selectedRef.box;
    if (!box.particleData) box.particleData = createDefaultParticleData();
    if (!box.lightData) box.lightData = createDefaultLightData(box.colorHex, false);
    if (!box.logicData) box.logicData = createDefaultLogicData();

    const p = box.m.position;
    const r = box.m.rotation;
    const s = box.m.scale;
    const cs = box.colliderScale || { x: 1, y: 1, z: 1 };
    const cd = box.checkpointData;
    const sd = box.spawnerData;
    const pd = box.particleData;
    const ld = box.lightData;
    const lg = box.logicData;

    const existingTags = [];
    for (const b of S.allBlocks) {
      if (b !== box && b.logicData && b.logicData.tag && !existingTags.includes(b.logicData.tag)) {
        existingTags.push(b.logicData.tag);
      }
    }
    const tagOptionsHTML = existingTags
      .map(t => `<option value="${t}" ${lg.targetTag === t ? 'selected' : ''}>🎯 #${t}</option>`)
      .join('');

    cont.innerHTML = `
      <div class="prop-group">
        <h5>🧱 Основное и Агрегатное Состояние</h5>
        <div class="prop-row"><label>Название</label><input class="ed-inp" id="inpBlkName" value="${box.label}"></div>
        <div class="prop-row">
          <label>Состояние</label>
          <select class="ed-inp" id="inpMatter">
            <option value="solid" ${box.matterState === 'solid' ? 'selected' : ''}>🧱 Твёрдое (3D OBB Коллизия)</option>
            <option value="liquid" ${box.matterState === 'liquid' ? 'selected' : ''}>💧 Жидкое (Вода/Лава — плавание)</option>
            <option value="gas" ${box.matterState === 'gas' ? 'selected' : ''}>☁️ Газообразное (Облако — сквозь него)</option>
          </select>
        </div>
        <div class="prop-row">
          <label>Цвет и Спрайт</label>
          <input type="color" class="ed-color" id="inpBlkCol" value="${box.colorHex}">
          <button class="ed-btn" id="btnEditBlockStuds" type="button" style="flex:1">🎨 Спрайт спереди</button>
          ${box.customTexDataURL ? `<button class="ed-btn danger" id="btnClearBlockSpr" type="button" title="Убрать лицевой спрайт">✕</button>` : ''}
        </div>
      </div>

      <div class="prop-group" style="border:1.5px solid ${lg.trigger !== 'none' || lg.tag ? '#00e676' : '#3d5afe'};background:rgba(16,22,36,0.92)">
        <h5 style="color:#69f0ae">
          <span>⚡ Логика / Сделать из куба... (${lg.trigger !== 'none' ? '🟢 АКТИВЕН' : (lg.tag ? '🎯 ЦЕЛЬ #' + lg.tag : '🔴 ОБЫЧНЫЙ КУБ')})</span>
        </h5>

        <div style="background:rgba(8,10,16,0.75);border:1px solid #283147;border-radius:8px;padding:6px;margin-bottom:4px">
          <div style="font:800 9.5px var(--f);color:#94a3b8;margin-bottom:5px;text-transform:uppercase">Превратить выбранный блок в 1 клик:</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
            <button class="ed-btn" data-qrole="door" type="button" style="justify-content:flex-start">🚪 Дверь / Лифт</button>
            <button class="ed-btn" data-qrole="button" type="button" style="justify-content:flex-start">🔘 Кнопка [E]</button>
            <button class="ed-btn" data-qrole="lever" type="button" style="justify-content:flex-start">🕹️ Рычаг (Вкл/Выкл)</button>
            <button class="ed-btn" data-qrole="plate" type="button" style="justify-content:flex-start">👟 Нажимная Плита</button>
            <button class="ed-btn" data-qrole="portal" type="button" style="justify-content:flex-start">🌀 Телепорт / Портал</button>
            <button class="ed-btn" data-qrole="vip_door" type="button" style="justify-content:flex-start">🔓 Проход за R$</button>
            <button class="ed-btn" data-qrole="shop" type="button" style="justify-content:flex-start">🛒 Магазин Перка</button>
            <button class="ed-btn" data-qrole="clicker" type="button" style="justify-content:flex-start">🪙 Кликер (+R$)</button>
          </div>
          ${(lg.trigger !== 'none' || lg.tag) ? `
            <button class="ed-btn danger" id="btnResetRole" type="button" style="width:100%;justify-content:center;margin-top:5px">✕ Сбросить логику (Сделать обычным кубом)</button>
          ` : ''}
        </div>

        <div class="prop-row">
          <label>Свой тег (#)</label>
          <input class="ed-inp" id="inpLgTag" placeholder="напр. door_1 или tp_2" value="${lg.tag || ''}">
        </div>

        <div class="prop-row">
          <label>Как срабатывает</label>
          <select class="ed-inp" id="inpLgTrig">
            <option value="none" ${lg.trigger === 'none' ? 'selected' : ''}>🔴 Только по сигналу от кнопки (Пассивный)</option>
            <option value="keyE" ${lg.trigger === 'keyE' ? 'selected' : ''}>🔘 По нажатию клавиши [E] рядом</option>
            <option value="touch" ${lg.trigger === 'touch' ? 'selected' : ''}>👟 При касании / наступании (Touch)</option>
            <option value="hit" ${lg.trigger === 'hit' ? 'selected' : ''}>🥊 При ударе оружием / рукой (ЛКМ / Снаряд)</option>
          </select>
        </div>

        <div id="lgActiveFields" ${lg.trigger !== 'none' || lg.tag ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px;margin-top:2px">
          <div class="prop-row">
            <label>Что делает</label>
            <select class="ed-inp" id="inpLgAct">
              <option value="door_slide" ${lg.action === 'door_slide' ? 'selected' : ''}>🚪 Двигает Дверь / Лифт (Slide)</option>
              <option value="door_ghost" ${lg.action === 'door_ghost' ? 'selected' : ''}>👻 Делает проход прозрачным (Ghost)</option>
              <option value="teleport" ${lg.action === 'teleport' ? 'selected' : ''}>🌀 Телепортирует игрока</option>
              <option value="buy_perk" ${lg.action === 'buy_perk' ? 'selected' : ''}>🛒 Выдаёт Перк / Оружие / HP</option>
              <option value="give_cash" ${lg.action === 'give_cash' ? 'selected' : ''}>🪙 Даёт монеты (+R$)</option>
              <option value="bounce_pad" ${lg.action === 'bounce_pad' ? 'selected' : ''}>🚀 Подбрасывает как катапульта</option>
            </select>
          </div>

          <div class="prop-row">
            <label>Цель (#тег)</label>
            <input class="ed-inp" id="inpLgTarget" placeholder="Пусто = сам этот блок" value="${lg.targetTag || ''}" style="flex:1">
            ${existingTags.length > 0 ? `
              <select class="ed-inp" id="selExistingTag" style="width:92px">
                <option value="">На сцене...</option>
                <option value="__self__">Сам блок</option>
                ${tagOptionsHTML}
              </select>
            ` : ''}
          </div>

          <div class="prop-row">
            <label>Цена (R$)</label>
            <input type="number" min="0" step="10" class="ed-inp" id="inpLgCost" value="${lg.cost || 0}" style="width:75px">
            <label style="flex:1;text-align:right">Платить 1 раз</label>
            <input type="checkbox" id="inpLgOneTime" ${lg.oneTimeBuy !== false ? 'checked' : ''}>
          </div>

          <div id="lgDoorSlideRows" ${lg.action === 'door_slide' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
            <div class="prop-row"><label>Куда сдвигать</label><div class="vec3">
              <input type="number" step="1" class="ed-inp" id="inpLgMX" value="${lg.moveX ?? 0}">
              <input type="number" step="1" class="ed-inp" id="inpLgMY" value="${lg.moveY ?? 5}">
              <input type="number" step="1" class="ed-inp" id="inpLgMZ" value="${lg.moveZ ?? 0}">
            </div></div>
            <div class="prop-row"><label>Скор. / Таймер</label><div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="0.5" min="0.5" class="ed-inp" id="inpLgSpd" value="${lg.speed ?? 4.5}">
              <input type="number" step="0.5" min="0" class="ed-inp" id="inpLgStay" value="${lg.stayTime ?? 4.0}">
            </div></div>
            <button class="ed-btn apply-oneclick" id="btnPreviewDoorMove" type="button" style="justify-content:center">▶ Проверить открытие двери в Studio</button>
          </div>

          <div id="lgDoorGhostRows" ${lg.action === 'door_ghost' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
            <div class="prop-row">
              <label>Таймер (сек)</label>
              <input type="number" step="0.5" min="0" class="ed-inp" id="inpLgGhostStay" value="${lg.stayTime ?? 4.0}">
            </div>
          </div>

          <div id="lgTeleportRows" ${lg.action === 'teleport' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
            <div class="prop-row"><label>Точка X/Y/Z</label><div class="vec3">
              <input type="number" step="1" class="ed-inp" id="inpLgTpX" value="${lg.tpX ?? 0}">
              <input type="number" step="1" class="ed-inp" id="inpLgTpY" value="${lg.tpY ?? 6}">
              <input type="number" step="1" class="ed-inp" id="inpLgTpZ" value="${lg.tpZ ?? 0}">
            </div></div>
            <button class="ed-btn" id="btnLgCaptureCamPos" type="button" style="justify-content:center">📍 Взять текущую позицию камеры редактора</button>
          </div>

          <div id="lgPerkRows" ${lg.action === 'buy_perk' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
            <div class="prop-row">
              <label>Выдать перк</label>
              <select class="ed-inp" id="inpLgPerk">
                <option value="speed" ${lg.perkType === 'speed' ? 'selected' : ''}>🌀 Пружина Скорости (+55% бег)</option>
                <option value="grav" ${lg.perkType === 'grav' ? 'selected' : ''}>🚀 Пружина Прыжка (Gravity)</option>
                <option value="halo" ${lg.perkType === 'halo' ? 'selected' : ''}>😇 VIP Нимб (x2 R$)</option>
                <option value="heal" ${lg.perkType === 'heal' ? 'selected' : ''}>❤️ Полное лечение (+25 Макс. HP)</option>
                <option value="damage" ${lg.perkType === 'damage' ? 'selected' : ''}>🥊 Сила удара (+15 урона)</option>
              </select>
            </div>
          </div>

          <div id="lgCashRows" ${lg.action === 'give_cash' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
            <div class="prop-row">
              <label>Награда (R$)</label>
              <input type="number" step="5" min="1" class="ed-inp" id="inpLgReward" value="${lg.rewardCash ?? 25}">
            </div>
          </div>

          <div class="prop-row">
            <label>Кулдаун (сек)</label>
            <input type="number" step="0.2" min="0.2" class="ed-inp" id="inpLgCd" value="${lg.cooldown ?? 1.0}" style="width:75px">
            <label style="flex:1;text-align:right">3D-Вывеска</label>
            <input type="checkbox" id="inpLgBadge" ${lg.showBadge !== false ? 'checked' : ''}>
          </div>
          <div class="prop-row">
            <label>Текст вывески</label>
            <input class="ed-inp" id="inpLgPrompt" placeholder="Авто-надпись..." value="${lg.promptText || ''}">
          </div>
        </div>
      </div>

      <div class="prop-group">
        <h5>
          <span>💡 Свечение и Источник Света (${ld.mode !== 'none' ? '🟢' : '🔴'})</span>
        </h5>
        <div class="prop-row">
          <label>Тип света</label>
          <select class="ed-inp" id="inpLightMode">
            <option value="none" ${ld.mode === 'none' ? 'selected' : ''}>🔴 Нет свечения</option>
            <option value="visual" ${ld.mode === 'visual' ? 'selected' : ''}>✨ Визуальный Неон (Emissive)</option>
            <option value="point" ${ld.mode === 'point' ? 'selected' : ''}>💡 Источник света (Освещает мир)</option>
          </select>
        </div>
        <div id="lightFields" ${ld.mode !== 'none' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
          <div class="prop-row">
            <label>Цвет свечения</label>
            <input type="color" class="ed-color" id="inpLightCol" value="${ld.color || box.colorHex}">
            <button class="ed-btn" id="btnLightMatchBlk" type="button" style="flex:1;justify-content:center">🎨 В цвет блока</button>
          </div>
          <div class="prop-row">
            <label>Яркость</label>
            <input type="range" min="0.1" max="4.0" step="0.1" id="inpLightInt" value="${ld.intensity ?? 1.4}" style="flex:1">
            <span id="txtLightInt" style="font-size:10px;width:32px;text-align:right">${Number(ld.intensity ?? 1.4).toFixed(1)}</span>
          </div>
          <div class="prop-row" id="rowLightDist" ${ld.mode === 'point' ? '' : 'hidden'}>
            <label>Радиус света</label>
            <input type="number" min="2" max="80" step="1" class="ed-inp" id="inpLightDist" value="${ld.distance ?? 14}">
          </div>
          <div class="prop-row">
            <label>Пульсация</label>
            <input type="range" min="0" max="5" step="0.2" id="inpLightPulse" value="${ld.pulseSpeed || 0}" style="flex:1">
            <span id="txtLightPulse" style="font-size:10px;width:32px;text-align:right">${Number(ld.pulseSpeed || 0).toFixed(1)}</span>
          </div>
        </div>
      </div>

      <div class="prop-group">
        <h5>
          <span>✨ Генератор Партиклов (${pd.enabled ? '🟢' : '🔴'})</span>
          <input type="checkbox" id="inpPtOn" ${pd.enabled ? 'checked' : ''}>
        </h5>
        <div id="ptFields" ${pd.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
          <div class="prop-row">
            <label>Шаблон 16×16</label>
            <select class="ed-inp" id="inpPtPreset" style="flex:1">
              <option value="spark" ${pd.preset === 'spark' ? 'selected' : ''}>💠 Искра (Spark)</option>
              <option value="fire" ${pd.preset === 'fire' ? 'selected' : ''}>🔥 Огонь (Fire)</option>
              <option value="heart" ${pd.preset === 'heart' ? 'selected' : ''}>❤️ Сердечко (Heart)</option>
              <option value="star" ${pd.preset === 'star' ? 'selected' : ''}>⭐ Звезда (Star)</option>
              <option value="smoke" ${pd.preset === 'smoke' ? 'selected' : ''}>💨 Дым / Пар (Smoke)</option>
              <option value="hit" ${pd.preset === 'hit' ? 'selected' : ''}>💥 Урон (Hit)</option>
              <option value="custom" ${pd.preset === 'custom' ? 'selected' : ''}>🎨 Свой рисунок 16×16</option>
            </select>
            <button class="ed-btn apply-oneclick" id="btnPaintParticle" type="button">🖌️ 16×16</button>
          </div>
          <div class="prop-row">
            <label>Оттенок</label>
            <input type="color" class="ed-color" id="inpPtCol" value="${pd.color || '#ffffff'}">
            <label style="flex:1;text-align:right">Угасание</label>
            <input type="checkbox" id="inpPtFade" ${pd.fadeOut !== false ? 'checked' : ''}>
          </div>
          <div class="prop-row"><label>Кол-во/сек и Срок</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="2" min="1" max="100" class="ed-inp" id="inpPtRate" value="${pd.rate}">
            <input type="number" step="0.2" min="0.2" max="10" class="ed-inp" id="inpPtLife" value="${pd.lifetime}">
          </div></div>
          <div class="prop-row"><label>Размер Нач/Кон</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.05" min="0.05" max="5" class="ed-inp" id="inpPtS0" value="${pd.sizeStart}">
            <input type="number" step="0.05" min="0" max="5" class="ed-inp" id="inpPtS1" value="${pd.sizeEnd}">
          </div></div>
          <div class="prop-row"><label>Скор. и Разброс</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.5" min="0" max="25" class="ed-inp" id="inpPtSpd" value="${pd.speed}">
            <input type="number" step="0.1" min="0" max="3.14" class="ed-inp" id="inpPtSpr" value="${pd.spread}">
          </div></div>
          <div class="prop-row"><label>Направл. X/Y/Z</label><div class="vec3">
            <input type="number" step="0.2" class="ed-inp" id="inpPtDX" value="${pd.dirX}">
            <input type="number" step="0.2" class="ed-inp" id="inpPtDY" value="${pd.dirY}">
            <input type="number" step="0.2" class="ed-inp" id="inpPtDZ" value="${pd.dirZ}">
          </div></div>
          <div class="prop-row"><label>Движ.Y / Вращ.</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.5" class="ed-inp" id="inpPtGrav" value="${pd.gravity}">
            <input type="number" step="0.5" class="ed-inp" id="inpPtRot" value="${pd.rotSpeed}">
          </div></div>
          <div class="prop-row">
            <label>Мерцание</label>
            <input type="range" min="0" max="1" step="0.05" id="inpPtFlk" value="${pd.flicker || 0}" style="flex:1">
          </div>
        </div>
      </div>

      <div class="prop-group">
        <h5>📐 Трансформация и Коллайдер</h5>
        <div class="prop-row"><label>Позиция</label><div class="vec3">
          <input type="number" step="0.5" class="ed-inp" id="inpPX" value="${p.x.toFixed(1)}">
          <input type="number" step="0.5" class="ed-inp" id="inpPY" value="${p.y.toFixed(1)}">
          <input type="number" step="0.5" class="ed-inp" id="inpPZ" value="${p.z.toFixed(1)}">
        </div></div>
        <div class="prop-row"><label>Размер</label><div class="vec3">
          <input type="number" step="0.5" min="0.2" class="ed-inp" id="inpSX" value="${s.x.toFixed(1)}">
          <input type="number" step="0.2" min="0.1" class="ed-inp" id="inpSY" value="${s.y.toFixed(1)}">
          <input type="number" step="0.5" min="0.2" class="ed-inp" id="inpSZ" value="${s.z.toFixed(1)}">
        </div></div>
        <div class="prop-row"><label>Поворот°</label><div class="vec3">
          <input type="number" step="15" class="ed-inp" id="inpRX" value="${Math.round(THREE.MathUtils.radToDeg(r.x))}">
          <input type="number" step="15" class="ed-inp" id="inpRY" value="${Math.round(THREE.MathUtils.radToDeg(r.y))}">
          <input type="number" step="15" class="ed-inp" id="inpRZ" value="${Math.round(THREE.MathUtils.radToDeg(r.z))}">
        </div></div>
        <div class="prop-row"><label>Множ. Коллайд.</label><div class="vec3">
          <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpCX" value="${cs.x}">
          <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpCY" value="${cs.y}">
          <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpCZ" value="${cs.z}">
        </div></div>
      </div>

      <div class="prop-group">
        <h5>⚡ Физические Свойства При Контакте</h5>
        <div class="prop-row"><label>Урон (HP)</label><input type="number" step="5" min="0" class="ed-inp" id="inpDmg" value="${box.damageOnContact}"></div>
        <div class="prop-row"><label>На чекпоинт</label><input type="checkbox" id="inpTpCp" ${box.teleportToCheckpoint ? 'checked' : ''}> <span>Телепорт при касании</span></div>
        <div class="prop-row"><label>Прыгучесть</label><input type="number" step="1" min="0" class="ed-inp" id="inpBounce" value="${box.bounciness}"></div>
        <div class="prop-row"><label>Конвейер Z/X</label><div class="vec3" style="grid-template-columns:1fr 1fr">
          <input type="number" step="0.5" class="ed-inp" id="inpConvZ" value="${box.conveyorVz}">
          <input type="number" step="0.5" class="ed-inp" id="inpConvX" value="${box.conveyorVx}">
        </div></div>
        <div class="prop-row"><label>Вращение Y</label><input type="number" step="0.5" class="ed-inp" id="inpSpin" value="${box.spinSpeed}"></div>
      </div>

      <div class="prop-group">
        <h5>
          <span>⭐ Свойства Чекпоинта (${cd.enabled ? '🟢' : '🔴'})</span>
          <input type="checkbox" id="inpCpOn" ${cd.enabled ? 'checked' : ''}>
        </h5>
        <div id="cpFields" ${cd.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
          <div class="prop-row"><label>Этап #</label><input type="number" min="1" class="ed-inp" id="inpCpStg" value="${cd.stage}"></div>
          <div class="prop-row"><label>Название</label><input class="ed-inp" id="inpCpTitle" value="${cd.title}"></div>
          <div class="prop-row"><label>Награда R$</label><input type="number" step="10" class="ed-inp" id="inpCpCash" value="${cd.rewardCash}"></div>
          <div class="prop-row"><label>Пропуск мест</label><input type="number" min="0" class="ed-inp" id="inpCpSkip" value="${cd.skipSpots}"></div>
        </div>
      </div>

      <div class="prop-group">
        <h5>⚙️ Спавнер на Блоке</h5>
        <div class="prop-row">
          <label>Условие</label>
          <select class="ed-inp" id="inpSpMode">
            <option value="none" ${sd.mode === 'none' ? 'selected' : ''}>🔴 (Не активен)</option>
            <option value="timer" ${sd.mode === 'timer' ? 'selected' : ''}>⏱️ По таймеру (каждые N сек)</option>
            <option value="contact" ${sd.mode === 'contact' ? 'selected' : ''}>👟 При контакте с игроком</option>
            <option value="hit" ${sd.mode === 'hit' ? 'selected' : ''}>🥊 При ударе рукой (ЛКМ)</option>
            <option value="keyE" ${sd.mode === 'keyE' ? 'selected' : ''}>🔘 По нажатию клавиши [E]</option>
          </select>
        </div>
        <div class="prop-row">
          <label>Кого спавнить</label>
          <select class="ed-inp" id="inpSpType">
            <option value="npc" ${sd.spawnType === 'npc' ? 'selected' : ''}>🤖 NPC-Бота</option>
            <option value="coin" ${sd.spawnType === 'coin' ? 'selected' : ''}>🪙 Монетку (+25 R$)</option>
            <option value="cube" ${sd.spawnType === 'cube' ? 'selected' : ''}>🧱 Цветной Лего-Куб</option>
          </select>
        </div>
        <div class="prop-row"><label>Таймер (сек)</label><input type="number" min="1" step="0.5" class="ed-inp" id="inpSpInt" value="${sd.interval || 5}"></div>
      </div>
    `;

    $('inpBlkName').oninput = e => {
      box.label = e.target.value;
      syncBlockSpecialVisuals(box);
      refreshHierarchyUI();
    };
    $('inpMatter').onchange = e => {
      pushUndoState('Смена состояния блока');
      box.matterState = e.target.value;
      box.m.material = createBlockMaterial(box.colorHex, box.w / 2.2, box.d / 2.2, box.gold, null, box.matterState);
      syncBlockLightVisuals(box);
      rebuildPhysicsArrays();
      refreshHierarchyUI();
    };
    $('inpBlkCol').onfocus = () => pushUndoState('Смена цвета блока');
    $('inpBlkCol').oninput = e => {
      box.colorHex = e.target.value;
      box.m.material.color.set(box.colorHex);
      syncBlockLightVisuals(box);
    };
    $('btnEditBlockStuds').onclick = () => openPaintModal('block');
    if ($('btnClearBlockSpr')) {
      $('btnClearBlockSpr').onclick = () => {
        pushUndoState('Удаление спрайта блока');
        box.customTexDataURL = null;
        setMeshFrontSprite(box.m, null);
        renderInspectorUI();
      };
    }

    cont.querySelectorAll('[data-qrole]').forEach(btn => {
      btn.onclick = () => {
        pushUndoState('Назначение роли блоку');
        const role = btn.dataset.qrole;
        const firstDoorTag = existingTags[0] || 'door_1';

        if (role === 'door') {
          if (!lg.tag) lg.tag = 'door_' + box.id.replace('blk_', '');
          lg.trigger = 'keyE';
          lg.action = 'door_slide';
          lg.targetTag = '';
          lg.moveX = 0;
          lg.moveY = Math.max(4, Math.round(box.h + 1));
          lg.moveZ = 0;
          lg.speed = 5.0;
          lg.stayTime = 4.0;
          lg.cost = 0;
          lg.showBadge = true;
          lg.promptText = `🚪 Открыть «${box.label}» [E]`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Дверь (#${lg.tag})`;
          showBanner(`🚪 Блок превращён в Раздвижную Дверь (тег #${lg.tag})!`, '#00e676');
        } else if (role === 'button') {
          lg.trigger = 'keyE';
          lg.action = 'door_slide';
          lg.targetTag = firstDoorTag;
          lg.moveX = 0;
          lg.moveY = 5;
          lg.moveZ = 0;
          lg.stayTime = 4.5;
          lg.cost = 0;
          lg.showBadge = true;
          lg.promptText = `🔘 Кнопка → #${firstDoorTag} [E]`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Кнопка [E] → #${firstDoorTag}`;
          showBanner(`🔘 Блок стал Кнопкой [E]! Цель: #${firstDoorTag}`, '#56f0ff');
        } else if (role === 'lever') {
          lg.trigger = 'keyE';
          lg.action = 'door_slide';
          lg.targetTag = firstDoorTag;
          lg.moveX = 0;
          lg.moveY = 5;
          lg.moveZ = 0;
          lg.stayTime = 0;
          lg.cost = 0;
          lg.showBadge = true;
          lg.promptText = `🕹️ Рычаг Вкл/Выкл (#${firstDoorTag}) [E]`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Рычаг → #${firstDoorTag}`;
          showBanner(`🕹️ Блок стал Рычагом (Toggle)!`, '#00e676');
        } else if (role === 'plate') {
          lg.trigger = 'touch';
          lg.action = 'door_slide';
          lg.targetTag = firstDoorTag;
          lg.moveX = 0;
          lg.moveY = 5;
          lg.moveZ = 0;
          lg.stayTime = 5.0;
          lg.cost = 0;
          lg.showBadge = true;
          lg.promptText = `👟 Нажимная плита → #${firstDoorTag}`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Плита → #${firstDoorTag}`;
          showBanner(`👟 Блок стал Нажимной Плитой!`, '#00e676');
        } else if (role === 'portal') {
          lg.trigger = 'touch';
          lg.action = 'teleport';
          lg.targetTag = '';
          lg.tpX = Math.round(box.x);
          lg.tpY = Math.round(box.y + 12);
          lg.tpZ = Math.round(box.z - 25);
          lg.cost = 0;
          lg.showBadge = true;
          lg.promptText = `🌀 Портал Телепорта`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Портал Телепорта`;
          showBanner(`🌀 Блок превращён в Портал Телепорта!`, '#e040fb');
        } else if (role === 'vip_door') {
          lg.trigger = 'keyE';
          lg.action = 'door_ghost';
          lg.targetTag = '';
          lg.cost = 100;
          lg.oneTimeBuy = true;
          lg.stayTime = 5.0;
          lg.showBadge = true;
          lg.promptText = `🔓 Проход VIP (100 R$) [E]`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Проход за 100 R$`;
          showBanner(`🔓 Блок стал Платным Проходом за 100 R$!`, '#ffd54f');
        } else if (role === 'shop') {
          lg.trigger = 'keyE';
          lg.action = 'buy_perk';
          lg.perkType = 'speed';
          lg.cost = 150;
          lg.oneTimeBuy = true;
          lg.showBadge = true;
          lg.promptText = `🛒 Купить Пружину Скорости (150 R$) [E]`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Магазин Скорости`;
          showBanner(`🛒 Блок стал Магазином Перка!`, '#ffd54f');
        } else if (role === 'clicker') {
          lg.trigger = 'hit';
          lg.action = 'give_cash';
          lg.rewardCash = 25;
          lg.cost = 0;
          lg.cooldown = 0.35;
          lg.showBadge = true;
          lg.promptText = `🥊 Бей кулаком / оружием! (+25 R$)`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Денежный Куб (+25 R$)`;
          showBanner(`🪙 Блок стал Денежным Кликером (Удар ЛКМ = +25 R$)!`, '#00e676');
        }

        syncBlockSpecialVisuals(box);
        renderInspectorUI();
        refreshHierarchyUI();
      };
    });

    if ($('btnResetRole')) {
      $('btnResetRole').onclick = () => {
        pushUndoState('Сброс логики блока');
        box.logicData = createDefaultLogicData();
        syncBlockSpecialVisuals(box);
        renderInspectorUI();
        refreshHierarchyUI();
        showBanner('Блок снова стал обычным строительным кубом', '#94a3b8');
      };
    }

    $('inpLgTag').oninput = e => {
      lg.tag = e.target.value.trim();
      $('lgActiveFields').hidden = !(lg.trigger !== 'none' || lg.tag);
      syncBlockSpecialVisuals(box);
      refreshHierarchyUI();
    };
    $('inpLgTrig').onchange = e => {
      pushUndoState('Смена триггера блока');
      lg.trigger = e.target.value;
      syncBlockSpecialVisuals(box);
      renderInspectorUI();
      refreshHierarchyUI();
    };
    $('inpLgAct').onchange = e => {
      pushUndoState('Смена действия блока');
      lg.action = e.target.value;
      syncBlockSpecialVisuals(box);
      renderInspectorUI();
      refreshHierarchyUI();
    };
    $('inpLgTarget').oninput = e => {
      lg.targetTag = e.target.value.trim();
      syncBlockSpecialVisuals(box);
    };
    if ($('selExistingTag')) {
      $('selExistingTag').onchange = e => {
        const val = e.target.value;
        if (val === '__self__') lg.targetTag = '';
        else if (val) lg.targetTag = val;
        $('inpLgTarget').value = lg.targetTag;
        syncBlockSpecialVisuals(box);
      };
    }
    $('inpLgCost').oninput = e => {
      lg.cost = Math.max(0, +e.target.value || 0);
      syncBlockSpecialVisuals(box);
    };
    $('inpLgOneTime').onchange = e => { lg.oneTimeBuy = e.target.checked; };
    $('inpLgMX').oninput = e => { lg.moveX = +e.target.value || 0; };
    $('inpLgMY').oninput = e => { lg.moveY = +e.target.value || 0; };
    $('inpLgMZ').oninput = e => { lg.moveZ = +e.target.value || 0; };
    $('inpLgSpd').oninput = e => { lg.speed = Math.max(0.5, +e.target.value || 4.5); };
    $('inpLgStay').oninput = e => { lg.stayTime = Math.max(0, +e.target.value || 0); };
    if ($('inpLgGhostStay')) {
      $('inpLgGhostStay').oninput = e => { lg.stayTime = Math.max(0, +e.target.value || 4); };
    }
    if ($('btnPreviewDoorMove')) {
      $('btnPreviewDoorMove').onclick = () => {
        triggerBlockLogic(box, 'studio_preview');
      };
    }
    $('inpLgTpX').oninput = e => { lg.tpX = +e.target.value || 0; };
    $('inpLgTpY').oninput = e => { lg.tpY = +e.target.value || 0; };
    $('inpLgTpZ').oninput = e => { lg.tpZ = +e.target.value || 0; };
    if ($('btnLgCaptureCamPos')) {
      $('btnLgCaptureCamPos').onclick = () => {
        lg.tpX = +S.edCamPos.x.toFixed(1);
        lg.tpY = +S.edCamPos.y.toFixed(1);
        lg.tpZ = +S.edCamPos.z.toFixed(1);
        $('inpLgTpX').value = lg.tpX;
        $('inpLgTpY').value = lg.tpY;
        $('inpLgTpZ').value = lg.tpZ;
        showBanner(`📍 Координаты телепорта записаны: (${lg.tpX}, ${lg.tpY}, ${lg.tpZ})`, '#56f0ff');
      };
    }
    $('inpLgPerk').onchange = e => {
      lg.perkType = e.target.value;
      syncBlockSpecialVisuals(box);
    };
    $('inpLgReward').oninput = e => {
      lg.rewardCash = Math.max(1, +e.target.value || 25);
      syncBlockSpecialVisuals(box);
    };
    $('inpLgCd').oninput = e => { lg.cooldown = Math.max(0.1, +e.target.value || 1.0); };
    $('inpLgBadge').onchange = e => {
      lg.showBadge = e.target.checked;
      syncBlockSpecialVisuals(box);
    };
    $('inpLgPrompt').oninput = e => {
      lg.promptText = e.target.value;
      syncBlockSpecialVisuals(box);
    };

    $('inpLightMode').onchange = e => {
      pushUndoState('Смена режима свечения блока');
      ld.mode = e.target.value;
      if (ld.mode !== 'none' && !ld.color) ld.color = box.colorHex;
      syncBlockLightVisuals(box);
      renderInspectorUI();
      refreshHierarchyUI();
    };
    $('inpLightCol').oninput = e => {
      ld.color = e.target.value;
      syncBlockLightVisuals(box);
    };
    $('btnLightMatchBlk').onclick = () => {
      ld.color = box.colorHex;
      $('inpLightCol').value = box.colorHex;
      syncBlockLightVisuals(box);
    };
    $('inpLightInt').oninput = e => {
      ld.intensity = +e.target.value;
      $('txtLightInt').textContent = ld.intensity.toFixed(1);
      syncBlockLightVisuals(box);
    };
    $('inpLightDist').oninput = e => {
      ld.distance = Math.max(2, +e.target.value || 14);
    };
    $('inpLightPulse').oninput = e => {
      ld.pulseSpeed = +e.target.value || 0;
      $('txtLightPulse').textContent = ld.pulseSpeed.toFixed(1);
    };

    $('inpPtOn').onchange = e => {
      pushUndoState('Переключение партиклов блока');
      pd.enabled = e.target.checked;
      $('ptFields').hidden = !pd.enabled;
      renderInspectorUI();
      refreshHierarchyUI();
    };
    $('inpPtPreset').onchange = e => { pd.preset = e.target.value; };
    $('btnPaintParticle').onclick = () => openPaintModal('particle');
    $('inpPtCol').oninput = e => { pd.color = e.target.value; };
    $('inpPtFade').onchange = e => { pd.fadeOut = e.target.checked; };
    $('inpPtRate').oninput = e => { pd.rate = Math.max(1, +e.target.value || 12); };
    $('inpPtLife').oninput = e => { pd.lifetime = Math.max(0.1, +e.target.value || 1.2); };
    $('inpPtS0').oninput = e => { pd.sizeStart = Math.max(0.05, +e.target.value || 0.35); };
    $('inpPtS1').oninput = e => { pd.sizeEnd = Math.max(0, +e.target.value || 0); };
    $('inpPtSpd').oninput = e => { pd.speed = Math.max(0, +e.target.value || 2); };
    $('inpPtSpr').oninput = e => { pd.spread = Math.max(0, +e.target.value || 0.6); };
    $('inpPtDX').oninput = e => { pd.dirX = +e.target.value || 0; };
    $('inpPtDY').oninput = e => { pd.dirY = +e.target.value || 0; };
    $('inpPtDZ').oninput = e => { pd.dirZ = +e.target.value || 0; };
    $('inpPtGrav').oninput = e => { pd.gravity = +e.target.value || 0; };
    $('inpPtRot').oninput = e => { pd.rotSpeed = +e.target.value || 0; };
    $('inpPtFlk').oninput = e => { pd.flicker = +e.target.value || 0; };

    const applyBlockTransform = () => {
      box.m.position.set(+$('inpPX').value || 0, +$('inpPY').value || 0, +$('inpPZ').value || 0);
      box.m.scale.set(
        Math.max(0.2, +$('inpSX').value || 1),
        Math.max(0.1, +$('inpSY').value || 1),
        Math.max(0.2, +$('inpSZ').value || 1)
      );
      box.m.rotation.set(
        THREE.MathUtils.degToRad(+$('inpRX').value || 0),
        THREE.MathUtils.degToRad(+$('inpRY').value || 0),
        THREE.MathUtils.degToRad(+$('inpRZ').value || 0)
      );
      box.colliderScale = {
        x: Math.max(0.1, +$('inpCX').value || 1),
        y: Math.max(0.1, +$('inpCY').value || 1),
        z: Math.max(0.1, +$('inpCZ').value || 1)
      };
      box.x = box.m.position.x;
      box.y = box.m.position.y;
      box.z = box.m.position.z;
      box.w = box.m.scale.x;
      box.h = box.m.scale.y;
      box.d = box.m.scale.z;
      box.rx = box.m.rotation.x;
      box.ry = box.m.rotation.y;
      box.rz = box.m.rotation.z;
      if (box.logicRuntime) {
        box.logicRuntime.basePos = { x: box.x, y: box.y, z: box.z };
      }
      box.m.updateMatrixWorld(true);
      selBoxHelper.setFromObject(box.m);
      rebuildPhysicsArrays();
    };
    ['inpPX', 'inpPY', 'inpPZ', 'inpSX', 'inpSY', 'inpSZ', 'inpRX', 'inpRY', 'inpRZ', 'inpCX', 'inpCY', 'inpCZ'].forEach(id => {
      $(id).onfocus = () => pushUndoState('Трансформация блока');
      $(id).oninput = applyBlockTransform;
    });

    $('inpDmg').oninput = e => {
      box.damageOnContact = Math.max(0, +e.target.value || 0);
      syncBlockSpecialVisuals(box);
      refreshHierarchyUI();
    };
    $('inpTpCp').onchange = e => { box.teleportToCheckpoint = e.target.checked; };
    $('inpBounce').oninput = e => { box.bounciness = Math.max(0, +e.target.value || 0); };
    $('inpConvZ').oninput = e => { box.conveyorVz = +e.target.value || 0; };
    $('inpConvX').oninput = e => { box.conveyorVx = +e.target.value || 0; };
    $('inpSpin').oninput = e => { box.spinSpeed = +e.target.value || 0; };

    $('inpCpOn').onchange = e => {
      pushUndoState('Переключение чекпоинта');
      cd.enabled = e.target.checked;
      $('cpFields').hidden = !cd.enabled;
      syncBlockSpecialVisuals(box);
      rebuildPhysicsArrays();
      refreshHierarchyUI();
    };
    $('inpCpStg').oninput = e => {
      cd.stage = Math.max(1, +e.target.value || 1);
      syncBlockSpecialVisuals(box);
      rebuildPhysicsArrays();
    };
    $('inpCpTitle').oninput = e => {
      cd.title = e.target.value;
      syncBlockSpecialVisuals(box);
      rebuildPhysicsArrays();
    };
    $('inpCpCash').oninput = e => { cd.rewardCash = +e.target.value || 0; rebuildPhysicsArrays(); };
    $('inpCpSkip').oninput = e => { cd.skipSpots = Math.max(0, +e.target.value || 0); rebuildPhysicsArrays(); };

    $('inpSpMode').onchange = e => {
      sd.mode = e.target.value;
      syncBlockSpecialVisuals(box);
      refreshHierarchyUI();
    };
    $('inpSpType').onchange = e => {
      sd.spawnType = e.target.value;
      syncBlockSpecialVisuals(box);
    };
    $('inpSpInt').oninput = e => { sd.interval = Math.max(1, +e.target.value || 5); };
    return;
  }

  // 5. ИНСПЕКТОР ПЕРСОНАЖА + ГАРДЕРОБ АКСЕССУАРОВ И БИБЛИОТЕКА ОРУЖИЯ/ПРЕДМЕТОВ
  if (selectedRef.kind === 'char') {
    const ent = selectedRef.ent;
    const p = ent.rig.g.position;
    const s = ent.rig.g.scale;
    const cs = ent.colliderScale || { x: 1, y: 1, z: 1 };
    const charEditMode = selectedRef.editMode || 'root';
    const hgPos = ent.handGripPos || { x: 0, y: -0.58, z: -0.1 };
    const hgRot = ent.handGripRot || { x: 0, y: 0, z: 0 };
    const cgPos = ent.carryGripPos || { x: 0, y: 0.15, z: -0.95 };

    const cosList = ent.customCosmetics || [];
    const cosHTML = cosList.length === 0
      ? `<div style="font:600 10px var(--f);color:#94a3b8;padding:4px">Нет надетых кастомных аксессуаров или питомцев</div>`
      : cosList.map((ci, idx) => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:#141824;padding:4px 7px;border-radius:6px;border:1px solid #283147;gap:4px">
            <span style="font:700 11px var(--f);color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${COSMETIC_SLOTS[ci.slot]?.label || ci.slot}">${ci.slot === 'pet' ? '🐾' : '🎩'} ${ci.name} <small style="color:#64748b">(${(ci.parts || []).length} дет.)</small></span>
            <div style="display:flex;gap:3px">
              <button class="ed-btn" data-selcos="${idx}" type="button" style="padding:2px 6px" title="Редактировать в 3D STUDIO">🛠️</button>
              <button class="ed-btn danger" data-delcos="${idx}" type="button" style="padding:2px 6px" title="Снять аксессуар">✕</button>
            </div>
          </div>
        `).join('');

    const libList = S.savedCosmeticsLibrary || [];
    const libHTML = libList.length === 0
      ? `<div style="font:600 10px var(--f);color:#64748b;padding:4px">Гардероб пуст. Наденьте или сохраните аксессуар!</div>`
      : libList.map((li, idx) => `
          <div style="display:flex;align-items:center;justify-content:space-between;background:#111520;padding:4px 7px;border-radius:6px;border:1px solid #252f48;gap:4px">
            <span style="font:700 10.5px var(--f);color:#ffd54f;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${li.slot === 'pet' ? '🐾' : '⭐'} ${li.name} <small style="color:#94a3b8">(${(li.parts || []).length})</small></span>
            <div style="display:flex;gap:3px">
              <button class="ed-btn apply-oneclick" data-equiplib="${idx}" type="button" style="padding:2px 6px" title="Надеть на этого персонажа">Надеть</button>
              <button class="ed-btn" data-editlib="${idx}" type="button" style="padding:2px 6px" title="Редактировать шаблон в 3D STUDIO">🛠️</button>
              <button class="ed-btn danger" data-dellib="${idx}" type="button" style="padding:2px 6px" title="Удалить из Гардероба">✕</button>
            </div>
          </div>
        `).join('');

    const invSlots = ent.inventory || [null, null, null, null, null, null];
    const invHTML = invSlots.map((slotItem, sIdx) => `
      <div style="display:flex;align-items:center;justify-content:space-between;background:#141824;padding:4px 7px;border-radius:6px;border:1px solid ${ent.activeSlot === sIdx ? '#00e676' : '#283147'};gap:5px">
        <span style="font:800 10px var(--f);color:#94a3b8;width:18px">[${sIdx + 1}]</span>
        <span style="font:700 11px var(--f);color:${slotItem ? '#e2e8f0' : '#64748b'};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          ${slotItem ? `${slotItem.icon || '🗡️'} ${slotItem.name}` : '— Пусто —'}
        </span>
        <div style="display:flex;gap:3px">
          <button class="ed-btn ${ent.activeSlot === sIdx ? 'active' : ''}" data-charactslot="${sIdx}" type="button" style="padding:2px 6px;font-size:10px" title="Взять в ведущую правую руку">✋</button>
          ${slotItem ? `<button class="ed-btn danger" data-chardelslot="${sIdx}" type="button" style="padding:2px 6px;font-size:10px" title="Очистить слот">✕</button>` : ''}
        </div>
      </div>
    `).join('');

    const itemsLib = S.savedItemsLibrary || [];
    const itemsLibHTML = itemsLib.map((it, idx) => `
      <div style="display:flex;align-items:center;justify-content:space-between;background:#111520;padding:4px 7px;border-radius:6px;border:1px solid #252f48;gap:4px">
        <span style="font:700 10.5px var(--f);color:#56f0ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${it.icon || '🗡️'} ${it.name}</span>
        <div style="display:flex;gap:3px">
          <button class="ed-btn apply-oneclick" data-giveitemchar="${idx}" type="button" style="padding:2px 6px;font-size:10px" title="Выдать в активный/свободный слот">🎒 В слот</button>
          <button class="ed-btn" data-editlibitem="${idx}" type="button" style="padding:2px 6px;font-size:10px" title="Редактировать в 3D STUDIO">🛠️</button>
          <button class="ed-btn" data-spawnitemlib="${idx}" type="button" style="padding:2px 6px;font-size:10px" title="Создать копию предмета в 3D STUDIO">📍</button>
        </div>
      </div>
    `).join('');

    cont.innerHTML = `
      <div class="prop-group">
        <h5>🧑 Личность и Характеристики (HP / Бой)</h5>
        <div class="prop-row"><label>Имя</label><input class="ed-inp" id="inpChName" value="${ent.name}"></div>
        <div class="prop-row"><label>Роль / Статус</label><input class="ed-inp" id="inpChRole" value="${ent.role}"></div>
        <div class="prop-row"><label>Здоровье / Макс</label><div class="vec3" style="grid-template-columns:1fr 1fr">
          <input type="number" step="10" min="1" class="ed-inp" id="inpChHp" value="${Math.round(ent.hp ?? 100)}">
          <input type="number" step="10" min="10" class="ed-inp" id="inpChMaxHp" value="${Math.round(ent.maxHp ?? 100)}">
        </div></div>
        <div class="prop-row">
          <label>ИИ Поведение</label>
          <select class="ed-inp" id="inpChCombat">
            <option value="peaceful" ${ent.combatBehavior === 'peaceful' ? 'selected' : ''}>🕊️ Мирный (Не дерётся)</option>
            <option value="neutral" ${(!ent.combatBehavior || ent.combatBehavior === 'neutral') ? 'selected' : ''}>🛡️ Нейтральный (Даёт сдачи)</option>
            <option value="aggressive" ${ent.combatBehavior === 'aggressive' ? 'selected' : ''}>😡 Агрессивный Враг (Атакует сам)</option>
          </select>
        </div>
        <div class="prop-row"><label>Урон удара</label><input type="number" step="5" min="1" class="ed-inp" id="inpChAtk" value="${ent.attackDamage ?? 15}"></div>
        <div class="prop-row"><label>Фраза 1</label><input class="ed-inp" id="inpChQ0" value="${ent.quotes?.[0] || 'Привет!'}"></div>
        <div class="prop-row"><label>Фраза 2</label><input class="ed-inp" id="inpChQ1" value="${ent.quotes?.[1] || 'Как дела?'}"></div>
      </div>

      <div class="prop-group" style="border:1.5px solid #00e676;background:rgba(0,230,118,0.05)">
        <h5 style="color:#69f0ae">
          <span>🎒 Стартовый Инвентарь и Арсенал Предметов</span>
        </h5>
        <div style="display:flex;flex-direction:column;gap:3px;margin-bottom:6px">${invHTML}</div>
        <div style="font:800 9.5px var(--f);color:#94a3b8;text-transform:uppercase;margin-bottom:4px">Создать новый предмет в 3D STUDIO:</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px;margin-bottom:6px">
          <button class="ed-btn" id="btnNewItemSword" type="button">🗡️ Меч</button>
          <button class="ed-btn" id="btnNewItemGun" type="button">🔫 Бластер</button>
          <button class="ed-btn" id="btnNewItemGrenade" type="button">💣 Граната</button>
          <button class="ed-btn" id="btnNewItemFood" type="button">🍔 Еда / Хилка</button>
          <button class="ed-btn" id="btnNewItemCrate" type="button" style="grid-column:1 / -1;justify-content:center">📦 Коробка в 2 руки (Контейнер)</button>
        </div>
        <div style="font:800 9.5px var(--f);color:#94a3b8;text-transform:uppercase;margin-bottom:4px">Библиотека предметов (${itemsLib.length}):</div>
        <div style="display:flex;flex-direction:column;gap:4px;max-height:145px;overflow-y:auto">${itemsLibHTML}</div>
      </div>

      <div class="prop-group">
        <h5>🎨 Внешность, Одежда и Лицо (2D Studio)</h5>
        <div class="prop-row"><label>Кожа / Рубашка</label>
          <input type="color" class="ed-color" id="inpChSkin" value="${ent.appearance.skin}">
          <input type="color" class="ed-color" id="inpChShirt" value="${ent.appearance.shirt}">
          <button class="ed-btn apply-oneclick" id="btnShirtAll" type="button" style="flex:1;justify-content:center">🌍 Всем</button>
        </div>
        <div class="prop-row"><label>Штаны / Волосы</label>
          <input type="color" class="ed-color" id="inpChPants" value="${ent.appearance.pants}">
          <input type="color" class="ed-color" id="inpChHairC" value="${ent.appearance.hairColor}">
        </div>
        <div class="prop-row"><label>Причёска</label>
          <select class="ed-inp" id="inpChHairS">
            <option value="0" ${ent.appearance.hairStyle === 0 ? 'selected' : ''}>0 - Лысый</option>
            <option value="1" ${ent.appearance.hairStyle === 1 ? 'selected' : ''}>1 - Короткая</option>
            <option value="2" ${ent.appearance.hairStyle === 2 ? 'selected' : ''}>2 - Ирокез / Шипы</option>
            <option value="3" ${ent.appearance.hairStyle === 3 ? 'selected' : ''}>3 - Длинные волосы</option>
            <option value="4" ${ent.appearance.hairStyle === 4 ? 'selected' : ''}>4 - Кепка с козырьком</option>
            <option value="5" ${ent.appearance.hairStyle === 5 ? 'selected' : ''}>5 - Цилиндр</option>
          </select>
        </div>
        <div class="prop-row">
          <label>Лицо и Торс</label>
          <button class="ed-btn" id="btnPaintFace" type="button" style="flex:1">😀 Рисовать Лицо</button>
          <button class="ed-btn" id="btnPaintTorso" type="button" style="flex:1">👕 Спрайт Торса</button>
          ${ent.appearance.customTorsoDataURL ? `<button class="ed-btn danger" id="btnClearTorsoSpr" type="button" title="Убрать спрайт торса">✕</button>` : ''}
        </div>
        <div class="prop-row"><label>Встроенные</label>
          <label style="width:auto"><input type="checkbox" id="inpChWings" ${ent.appearance.wings ? 'checked' : ''}> Крылья</label>
          <label style="width:auto"><input type="checkbox" id="inpChHalo" ${ent.appearance.halo ? 'checked' : ''}> Нимб</label>
        </div>
      </div>

      <div class="prop-group">
        <h5>
          <span>🎩 Кастомные Аксессуары и Питомцы (${cosList.length})</span>
          <div style="display:flex;gap:3px">
            <button class="ed-btn apply-oneclick" id="btnCharAddAcc" type="button">+ Аксессуар</button>
            <button class="ed-btn apply-oneclick" id="btnCharAddPet" type="button">+ Питомец</button>
          </div>
        </h5>
        <div style="display:flex;flex-direction:column;gap:4px">${cosHTML}</div>
      </div>

      <div class="prop-group">
        <h5>⭐ Гардероб сохранённых аксессуаров (${libList.length})</h5>
        <div style="display:flex;flex-direction:column;gap:4px">${libHTML}</div>
      </div>

      <div class="prop-group" style="border:1px solid #00e5ff">
        <h5 style="color:#56f0ff">✋ Точки Хвата Рук Персонажа (Правая рука / Коробка)</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:6px">
          <button class="ed-btn ${charEditMode === 'root' ? 'active' : ''}" id="btnChModeRoot" type="button" style="justify-content:center">🧍 Персонаж</button>
          <button class="ed-btn ${charEditMode === 'hand_grip' ? 'active' : ''}" id="btnChModeHandGrip" type="button" style="justify-content:center">✋ Хват Правой Руки</button>
          <button class="ed-btn ${charEditMode === 'carry_grip' ? 'active' : ''}" id="btnChModeCarryGrip" type="button" style="justify-content:center">📦 Хват в 2 руки</button>
        </div>
        <div class="prop-row"><label>Хват правой руки</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpChHGX" value="${Number(hgPos.x).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChHGY" value="${Number(hgPos.y).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChHGZ" value="${Number(hgPos.z).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот руки°</label><div class="vec3">
          <input type="number" step="10" class="ed-inp" id="inpChHGRX" value="${Math.round(THREE.MathUtils.radToDeg(hgRot.x || 0))}">
          <input type="number" step="10" class="ed-inp" id="inpChHGRY" value="${Math.round(THREE.MathUtils.radToDeg(hgRot.y || 0))}">
          <input type="number" step="10" class="ed-inp" id="inpChHGRZ" value="${Math.round(THREE.MathUtils.radToDeg(hgRot.z || 0))}">
        </div></div>
        <div class="prop-row"><label>Хват коробки XYZ</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpChCGX" value="${Number(cgPos.x).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChCGY" value="${Number(cgPos.y).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChCGZ" value="${Number(cgPos.z).toFixed(2)}">
        </div></div>
      </div>

      <div class="prop-group">
        <h5>📐 Позиция, Размер и Коллайдер</h5>
        <div class="prop-row"><label>Позиция</label><div class="vec3">
          <input type="number" step="0.5" class="ed-inp" id="inpChX" value="${p.x.toFixed(1)}">
          <input type="number" step="0.5" class="ed-inp" id="inpChY" value="${p.y.toFixed(1)}">
          <input type="number" step="0.5" class="ed-inp" id="inpChZ" value="${p.z.toFixed(1)}">
        </div></div>
        <div class="prop-row"><label>Поворот Y°</label>
          <input type="number" step="15" class="ed-inp" id="inpChRotY" value="${Math.round(THREE.MathUtils.radToDeg(ent.rig.g.rotation.y))}">
        </div>
        <div class="prop-row"><label>Масштаб тела</label><div class="vec3">
          <input type="number" step="0.1" min="0.3" max="5" class="ed-inp" id="inpChSX" value="${s.x.toFixed(2)}">
          <input type="number" step="0.1" min="0.3" max="5" class="ed-inp" id="inpChSY" value="${s.y.toFixed(2)}">
          <input type="number" step="0.1" min="0.3" max="5" class="ed-inp" id="inpChSZ" value="${s.z.toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Множ. Коллайд.</label><div class="vec3">
          <input type="number" step="0.1" min="0.2" max="5" class="ed-inp" id="inpChCX" value="${cs.x}">
          <input type="number" step="0.1" min="0.2" max="5" class="ed-inp" id="inpChCY" value="${cs.y}">
          <input type="number" step="0.1" min="0.2" max="5" class="ed-inp" id="inpChCZ" value="${cs.z}">
        </div></div>
      </div>
    `;

    $('inpChName').oninput = e => {
      ent.name = e.target.value;
      ent.rig.updateTag(ent.name, ent.role, ent.isPlayer, ent.hp, ent.maxHp);
      refreshHierarchyUI();
    };
    $('inpChRole').oninput = e => {
      ent.role = e.target.value;
      ent.rig.updateTag(ent.name, ent.role, ent.isPlayer, ent.hp, ent.maxHp);
      refreshHierarchyUI();
    };
    $('inpChHp').oninput = e => {
      ent.hp = Math.max(1, +e.target.value || 100);
      ent.rig.updateTag(ent.name, ent.role, ent.isPlayer, ent.hp, ent.maxHp);
    };
    $('inpChMaxHp').oninput = e => {
      ent.maxHp = Math.max(10, +e.target.value || 100);
      if (ent.hp > ent.maxHp) ent.hp = ent.maxHp;
      ent.rig.updateTag(ent.name, ent.role, ent.isPlayer, ent.hp, ent.maxHp);
    };
    $('inpChCombat').onchange = e => {
      ent.combatBehavior = e.target.value;
      ent.rig.updateTag(ent.name, ent.role, ent.isPlayer, ent.hp, ent.maxHp);
      refreshHierarchyUI();
    };
    $('inpChAtk').oninput = e => { ent.attackDamage = Math.max(1, +e.target.value || 15); };
    $('inpChQ0').oninput = e => { if (!ent.quotes) ent.quotes = []; ent.quotes[0] = e.target.value; };
    $('inpChQ1').oninput = e => { if (!ent.quotes) ent.quotes = []; ent.quotes[1] = e.target.value; };

    // Слоты инвентаря персонажа
    cont.querySelectorAll('[data-charactslot]').forEach(btn => {
      btn.onclick = () => {
        ent.activeSlot = +btn.dataset.charactslot;
        syncEntityHeldItemMesh(ent);
        if (ent.isPlayer) syncPlayerHotbarUI();
        renderInspectorUI();
      };
    });
    cont.querySelectorAll('[data-chardelslot]').forEach(btn => {
      btn.onclick = () => {
        removeCharacterSlotItem(ent, +btn.dataset.chardelslot);
        renderInspectorUI();
      };
    });
    cont.querySelectorAll('[data-giveitemchar]').forEach(btn => {
      btn.onclick = () => {
        const tpl = S.savedItemsLibrary[+btn.dataset.giveitemchar];
        if (!tpl) return;
        const targetSlot = !ent.inventory[ent.activeSlot || 0]
          ? (ent.activeSlot || 0)
          : (ent.inventory.findIndex(s => !s) !== -1 ? ent.inventory.findIndex(s => !s) : (ent.activeSlot || 0));
        equipItemToCharacterSlot(ent, targetSlot, tpl);
        ent.activeSlot = targetSlot;
        syncEntityHeldItemMesh(ent);
        sfx.buy();
        showBanner(`🎒 «${tpl.name}» экипирован персонажу «${ent.name}» в слот [${targetSlot + 1}]!`, '#00e676');
        renderInspectorUI();
      };
    });
    cont.querySelectorAll('[data-editlibitem]').forEach(btn => {
      btn.onclick = () => {
        const libItem = S.savedItemsLibrary[+btn.dataset.editlibitem];
        if (!libItem) return;
        // Проверяем, есть ли уже этот предмет на сцене; если нет — создаём экземпляр и открываем в 3D STUDIO
        let wi = S.worldItems.find(w => w.item && w.item.id === libItem.id);
        if (!wi) {
          wi = spawnWorldItemEntry(libItem, ent.x + 1.5, ent.y + 0.5, ent.z - 1.5);
        }
        const partMeshes = wi.group.children.filter(c => c.userData && c.userData.isItemPart);
        selectEditorObject({
          kind: 'world_item',
          worldEntry: wi,
          item: wi.item,
          partIdx: 0,
          editMode: 'part',
          mesh: partMeshes[0] || wi.group,
          libraryItemRef: libItem
        });
        showBanner(`🛠️ Шаблон «${libItem.name}» открыт в 3D STUDIO!`, '#56f0ff');
      };
    });
    cont.querySelectorAll('[data-spawnitemlib]').forEach(btn => {
      btn.onclick = () => {
        const tpl = S.savedItemsLibrary[+btn.dataset.spawnitemlib];
        if (!tpl) return;
        const clone = normalizeItemData(JSON.parse(JSON.stringify(tpl)));
        clone.id = 'item_' + Math.random().toString(36).slice(2, 8);
        const wi = spawnWorldItemEntry(clone, ent.x + 1.8, ent.y + 0.6, ent.z);
        const partMeshes = wi.group.children.filter(c => c.userData && c.userData.isItemPart);
        selectEditorObject({
          kind: 'world_item',
          worldEntry: wi,
          item: wi.item,
          partIdx: 0,
          editMode: 'part',
          mesh: partMeshes[0] || wi.group
        });
        refreshHierarchyUI();
      };
    });

    $('btnNewItemSword').onclick = () => spawnStudioItem('sword');
    $('btnNewItemGun').onclick = () => spawnStudioItem('blaster');
    $('btnNewItemGrenade').onclick = () => spawnStudioItem('grenade');
    $('btnNewItemFood').onclick = () => spawnStudioItem('burger');
    $('btnNewItemCrate').onclick = () => spawnStudioItem('crate');

    const updateApp = () => {
      ent.appearance.skin = $('inpChSkin').value;
      ent.appearance.shirt = $('inpChShirt').value;
      ent.appearance.pants = $('inpChPants').value;
      ent.appearance.hairColor = $('inpChHairC').value;
      ent.appearance.hairStyle = +$('inpChHairS').value;
      ent.appearance.wings = $('inpChWings').checked;
      ent.appearance.halo = $('inpChHalo').checked;
      ent.rig.applyAppearance(ent.appearance);
    };
    ['inpChSkin', 'inpChShirt', 'inpChPants', 'inpChHairC'].forEach(id => {
      $(id).onfocus = () => pushUndoState('Смена внешности персонажа');
      $(id).oninput = updateApp;
    });
    ['inpChHairS', 'inpChWings', 'inpChHalo'].forEach(id => {
      $(id).onchange = () => {
        pushUndoState('Смена внешности персонажа');
        updateApp();
      };
    });

    $('btnShirtAll').onclick = () => {
      pushUndoState('Применение цвета рубашки всем');
      const col = $('inpChShirt').value;
      for (const q of S.queueLine) {
        q.appearance.shirt = col;
        q.rig.applyAppearance(q.appearance);
      }
      for (const n of S.customNPCs) {
        n.appearance.shirt = col;
        n.rig.applyAppearance(n.appearance);
      }
      showBanner('👕 Цвет рубашки применён ко всем персонажам!', '#56f0ff');
    };

    $('btnPaintFace').onclick = () => openPaintModal('face');
    $('btnPaintTorso').onclick = () => openPaintModal('torso');
    if ($('btnClearTorsoSpr')) {
      $('btnClearTorsoSpr').onclick = () => {
        pushUndoState('Удаление спрайта торса');
        ent.appearance.customTorsoDataURL = null;
        ent.rig.applyAppearance(ent.appearance);
        renderInspectorUI();
      };
    }

    $('btnCharAddAcc').onclick = () => spawnStudioAccessory('hat');
    $('btnCharAddPet').onclick = () => spawnStudioAccessory('pet');

    cont.querySelectorAll('[data-selcos]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.selcos;
        const ci = ent.customCosmetics[idx];
        const group = ent.rig.customCosMeshes[idx];
        if (ci && group) {
          const firstMesh = group.children[0] || group;
          selectEditorObject({
            kind: 'cosmetic',
            ent,
            item: ci,
            group,
            partIdx: 0,
            part: ci.parts[0],
            mesh: firstMesh
          });
        }
      };
    });

    cont.querySelectorAll('[data-delcos]').forEach(btn => {
      btn.onclick = () => {
        pushUndoState('Снятие аксессуара с персонажа');
        const idx = +btn.dataset.delcos;
        ent.customCosmetics.splice(idx, 1);
        rebuildCharacterCosmetics(ent);
        renderInspectorUI();
      };
    });

    cont.querySelectorAll('[data-equiplib]').forEach(btn => {
      btn.onclick = () => {
        pushUndoState('Надевание аксессуара из Гардероба');
        const libItem = S.savedCosmeticsLibrary[+btn.dataset.equiplib];
        if (!libItem) return;
        const clone = JSON.parse(JSON.stringify(libItem));
        clone.id = 'cos_' + Math.random().toString(36).slice(2, 7);
        ent.customCosmetics.push(clone);
        rebuildCharacterCosmetics(ent);
        renderInspectorUI();
        sfx.buy();
        showBanner(`🎩 «${clone.name}» надет на персонажа «${ent.name}»!`, '#00e676');
      };
    });

    cont.querySelectorAll('[data-editlib]').forEach(btn => {
      btn.onclick = () => {
        const libItem = S.savedCosmeticsLibrary[+btn.dataset.editlib];
        if (!libItem) return;
        let existingIdx = ent.customCosmetics.findIndex(c => c.name === libItem.name);
        if (existingIdx === -1) {
          const clone = JSON.parse(JSON.stringify(libItem));
          ent.customCosmetics.push(clone);
          rebuildCharacterCosmetics(ent);
          existingIdx = ent.customCosmetics.length - 1;
        }
        const ci = ent.customCosmetics[existingIdx];
        const group = ent.rig.customCosMeshes[existingIdx];
        if (ci && group) {
          selectEditorObject({
            kind: 'cosmetic',
            ent,
            item: ci,
            group,
            partIdx: 0,
            part: ci.parts[0],
            mesh: group.children[0] || group,
            libraryItemRef: libItem
          });
          showBanner(`🛠️ Шаблон «${libItem.name}» открыт в 3D STUDIO!`, '#00e676');
        }
      };
    });

    cont.querySelectorAll('[data-dellib]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.dellib;
        S.savedCosmeticsLibrary.splice(idx, 1);
        renderInspectorUI();
      };
    });

    $('btnChModeRoot').onclick = () => selectEditorObject({ kind: 'char', ent, editMode: 'root' });
    $('btnChModeHandGrip').onclick = () => selectEditorObject({ kind: 'char', ent, editMode: 'hand_grip' });
    $('btnChModeCarryGrip').onclick = () => selectEditorObject({ kind: 'char', ent, editMode: 'carry_grip' });

    const applyCharGripVec = () => {
      ent.handGripPos = {
        x: +$('inpChHGX').value || 0,
        y: +$('inpChHGY').value || 0,
        z: +$('inpChHGZ').value || 0
      };
      ent.handGripRot = {
        x: THREE.MathUtils.degToRad(+$('inpChHGRX').value || 0),
        y: THREE.MathUtils.degToRad(+$('inpChHGRY').value || 0),
        z: THREE.MathUtils.degToRad(+$('inpChHGRZ').value || 0)
      };
      ent.carryGripPos = {
        x: +$('inpChCGX').value || 0,
        y: +$('inpChCGY').value || 0,
        z: +$('inpChCGZ').value || 0
      };
      const m = ensureCharGripMarkers(ent);
      m.handMarker.position.set(ent.handGripPos.x, ent.handGripPos.y, ent.handGripPos.z);
      m.handMarker.rotation.set(ent.handGripRot.x, ent.handGripRot.y, ent.handGripRot.z);
      m.carryMarker.position.set(ent.carryGripPos.x, ent.carryGripPos.y, ent.carryGripPos.z);
      syncEntityHeldItemMesh(ent);
    };
    ['inpChHGX', 'inpChHGY', 'inpChHGZ', 'inpChHGRX', 'inpChHGRY', 'inpChHGRZ', 'inpChCGX', 'inpChCGY', 'inpChCGZ'].forEach(id => {
      $(id).oninput = applyCharGripVec;
    });

    const applyCharPos = () => {
      ent.x = +$('inpChX').value || 0;
      ent.y = +$('inpChY').value || 0;
      ent.z = +$('inpChZ').value || 0;
      ent.baseY = ent.y;
      ent.rig.g.position.set(ent.x, ent.y, ent.z);
      ent.rig.g.rotation.y = THREE.MathUtils.degToRad(+$('inpChRotY').value || 0);
      ent.rig.g.scale.set(
        Math.max(0.3, +$('inpChSX').value || 1),
        Math.max(0.3, +$('inpChSY').value || 1),
        Math.max(0.3, +$('inpChSZ').value || 1)
      );
      ent.colliderScale = {
        x: Math.max(0.2, +$('inpChCX').value || 1),
        y: Math.max(0.2, +$('inpChCY').value || 1),
        z: Math.max(0.2, +$('inpChCZ').value || 1)
      };
      ent.rig.g.updateMatrixWorld(true);
      selBoxHelper.setFromObject(ent.rig.g);
    };
    ['inpChX', 'inpChY', 'inpChZ', 'inpChRotY', 'inpChSX', 'inpChSY', 'inpChSZ', 'inpChCX', 'inpChCY', 'inpChCZ'].forEach(id => {
      $(id).onfocus = () => pushUndoState('Трансформация персонажа');
      $(id).oninput = applyCharPos;
    });
  }
}
