// src/studio/InspectorPanel.js
import { S, $, clamp, showBanner } from '../core/State.js';
import { updateSkybox } from '../core/SceneManager.js';
import { createBlockMaterial, setMeshFrontSprite } from '../core/TextureFactory.js';
import { sfx } from '../core/AudioEngine.js';
import {
  MAX_COSMETIC_PARTS,
  MAX_ITEM_PARTS,
  MAX_ACTIVE_PER_SLOT,
  SLOT_LABELS_RU,
  BUILTIN_COS_SLOT,
  DEFAULT_HAND_GRIP_POINT,
  DEFAULT_CARRY_GRIP_POINT,
  countActiveItemsInSlot,
  normalizeCosmeticItem,
  normalizeItemData,
  normalizeCharacterGripPoints,
  createStarterPetItem,
  createDefaultPartParticleData,
  normalizePartEffects
} from '../core/CharacterRig.js';
import {
  createDefaultLightData,
  createDefaultLogicData,
  syncBlockLightVisuals,
  syncBlockSpecialVisuals,
  rebuildPhysicsArrays,
  updateBlockOBB
} from '../core/WorldRegistry.js';
import { createDefaultParticleData } from '../core/ParticleSystem.js';
import {
  attachRigToEntity,
  refreshEntityTagWithHP,
  updateShopUI,
  pickupWorldItem,
  spawnWorldItem,
  rebuildWorldItemVisual,
  syncEntityHeldItemMesh,
  renderHotbarUI
} from '../core/EntityManager.js';
import {
  serializeSceneState,
  exportProjectToJsonFile,
  promptImportJsonFile,
  exportFullStudioHtml,
  exportPlayOnlyBuild,
  createNewBlankSandboxMap,
  resetAllSavedProjects
} from '../core/Serializer.js';
import {
  selBoxHelper,
  selectEditorObject,
  pushUndoState,
  pushCosmeticUndoState,
  undoLastCosmeticAction,
  pushItemUndoState,
  undoLastItemAction,
  openItemStudio3D,
  closeItemStudio3D,
  syncItemStudioPreview
} from './StudioController.js';
import { refreshHierarchyUI } from './HierarchyAndSpawn.js';
import { openPaintModal } from './PaintStudio2D.js';

// Синхронизирует редактируемый аксессуар или предмет с библиотекой Гардероба / Арсенала
export function syncLibraryItemIfEditing(ref = S.selectedRef) {
  if (!ref) return;
  if (ref.kind === 'cosmetic' && ref.libIdx !== undefined && S.savedCosmeticsLibrary[ref.libIdx]) {
    S.savedCosmeticsLibrary[ref.libIdx] = JSON.parse(JSON.stringify(ref.item));
  } else if (ref.kind === 'world_item' && ref.libIdx !== undefined && S.savedItemsLibrary[ref.libIdx]) {
    S.savedItemsLibrary[ref.libIdx] = JSON.parse(JSON.stringify(ref.item));
  }
}

export function renderInspectorUI() {
  const cont = $('inspectorContent');
  const selectedRef = S.selectedRef;

  // 1. ВКЛАДКА «🌤️ МИР» (Проект, Импорт/Экспорт, Билд игры, Скайбокс, Гравитация и Респавн)
  if (!selectedRef) {
    cont.innerHTML = `
      <div class="prop-group">
        <h5>🗂️ Проект, Файлы и Сборка</h5>
        <div class="prop-row">
          <label>Название мира</label>
          <input class="ed-inp" id="studioProjTitleInp" placeholder="Название мира..." value="${S.currentProjectTitle || 'Мой Мир'}">
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-top:2px">
          <button class="ed-btn" id="wBtnImportJson" type="button" style="justify-content:center" title="Загрузить мир из .JSON">📂 Импорт</button>
          <button class="ed-btn" id="wBtnExportJson" type="button" style="justify-content:center" title="Скачать файл мира .JSON">📤 .JSON</button>
          <button class="ed-btn" id="wBtnExportHtml" type="button" style="justify-content:center" title="Скачать проект вместе с редактором">📥 Скачать .HTML</button>
          <button class="ed-btn" id="wBtnBlankMap" type="button" style="justify-content:center" title="Создать пустую Sandbox карту">🌱 Пустая карта</button>
          <button class="ed-btn danger" id="wBtnResetSaved" type="button" style="justify-content:center" title="Очистить сохранения в браузере">♻️ Сброс</button>
          <button class="ed-btn apply-oneclick" id="wBtnBuildGame" type="button" style="justify-content:center;background:linear-gradient(135deg,#f39c12,#d35400);border-color:#ffce3a" title="Собрать чистый автономный билд игры без кода Studio">📦 Билд Игры</button>
        </div>
      </div>

      <div class="prop-group">
        <h5>🌤️ Скайбокс</h5>
        <div class="prop-row"><label>Верх неба</label><input type="color" class="ed-color" id="wSkyTop" value="${S.worldSettings.skyTop}"></div>
        <div class="prop-row"><label>Горизонт</label><input type="color" class="ed-color" id="wSkyMid" value="${S.worldSettings.skyMid}"></div>
        <div class="prop-row"><label>Низ неба</label><input type="color" class="ed-color" id="wSkyBot" value="${S.worldSettings.skyBot}"></div>
        <div class="prop-row"><label>Цвет тумана</label><input type="color" class="ed-color" id="wFogCol" value="${S.worldSettings.fogColor}"></div>
        <div class="prop-row"><label>Плотн. тумана</label><input type="range" min="0" max="0.015" step="0.0005" id="wFogDens" value="${S.worldSettings.fogDensity}" style="flex:1"></div>

        <div style="background:rgba(10,12,18,0.68);border:1.5px solid #161a24;border-radius:8px;padding:7px;margin-top:4px;box-shadow:inset 0 2px 6px rgba(0,0,0,0.45)">
          <div style="font:800 9.5px var(--f);color:#8fa0bd;text-transform:uppercase;letter-spacing:.05em;margin-bottom:5px">Префабы неба</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:5px">
            <button class="ed-btn" data-sky="day" type="button" style="justify-content:center">☀️ День</button>
            <button class="ed-btn" data-sky="sunset" type="button" style="justify-content:center">🌇 Закат</button>
            <button class="ed-btn" data-sky="night" type="button" style="justify-content:center">🌌 Кибер-Ночь</button>
            <button class="ed-btn" data-sky="heaven" type="button" style="justify-content:center">😇 Золотой Рай</button>
          </div>
        </div>
      </div>

      <div class="prop-group">
        <h5>🌍 Физика Мира, Смерть и Респавн</h5>
        <div class="prop-row"><label>Гравитация</label><input type="number" step="1" class="ed-inp" id="wGrav" value="${S.worldSettings.gravity}"></div>
        <div class="prop-row">
          <label>После смерти</label>
          <select class="ed-inp" id="wRespMode">
            <option value="instant" ${S.worldSettings.respawnMode === 'instant' ? 'selected' : ''}>⚡ Мгновенно на чекпоинте</option>
            <option value="timer" ${S.worldSettings.respawnMode === 'timer' ? 'selected' : ''}>⏱️ Экран смерти с таймером</option>
            <option value="spectator" ${S.worldSettings.respawnMode === 'spectator' ? 'selected' : ''}>👻 Спектатор до рестарта игры</option>
          </select>
        </div>
        <div class="prop-row" id="wRespDelayRow" ${S.worldSettings.respawnMode === 'timer' ? '' : 'hidden'}>
          <label>Таймер (сек)</label>
          <input type="number" step="0.5" min="1" max="30" class="ed-inp" id="wRespDelay" value="${S.worldSettings.respawnDelay || 3.5}">
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:2px">
          <button class="ed-btn" id="btnAllHpOn" type="button" style="flex:1;justify-content:center">❤️ HP всем: 🟢</button>
          <button class="ed-btn" id="btnAllHpOff" type="button" style="flex:1;justify-content:center">🛡️ HP всем: 🔴</button>
        </div>
      </div>
      <div style="font-size:11px;color:#8fa0bd;line-height:1.4;padding:4px">
        💡 <b>Оружие, Снаряды и Bricks Logic:</b><br>
        • В левой панели создавай <b>Мечи, Бластеры, Посохи, Бомбы, Аптечки, Факелы и 2-ручные Контейнеры</b>.<br>
        • У каждого оружия настраивается до <b>16 примитивов корпуса</b>, до <b>16 примитивов снаряда</b>, <b>Точка хвата (🤚)</b> и <b>Точка вылета (🎯)</b>!
      </div>
    `;

    $('studioProjTitleInp').oninput = e => {
      S.currentProjectTitle = e.target.value;
    };
    $('wBtnImportJson').onclick = () => promptImportJsonFile(() => renderInspectorUI());
    $('wBtnExportJson').onclick = () => {
      rebuildPhysicsArrays();
      exportProjectToJsonFile(serializeSceneState(), S.currentProjectTitle);
    };
    $('wBtnExportHtml').onclick = exportFullStudioHtml;
    $('wBtnBlankMap').onclick = createNewBlankSandboxMap;
    $('wBtnResetSaved').onclick = resetAllSavedProjects;
    $('wBtnBuildGame').onclick = exportPlayOnlyBuild;

    const applySky = () => {
      S.worldSettings.skyTop = $('wSkyTop').value;
      S.worldSettings.skyMid = $('wSkyMid').value;
      S.worldSettings.skyBot = $('wSkyBot').value;
      S.worldSettings.fogColor = $('wFogCol').value;
      S.worldSettings.fogDensity = +$('wFogDens').value;
      updateSkybox();
    };
    ['wSkyTop', 'wSkyMid', 'wSkyBot', 'wFogCol', 'wFogDens'].forEach(id => $(id).oninput = applySky);

    cont.querySelectorAll('[data-sky]').forEach(btn => {
      btn.onclick = () => {
        pushUndoState('Смена пресета неба');
        const s = btn.dataset.sky;
        if (s === 'day') Object.assign(S.worldSettings, { skyTop: '#1565c0', skyMid: '#62b6ff', skyBot: '#dff4ff', fogColor: '#88ccff' });
        if (s === 'sunset') Object.assign(S.worldSettings, { skyTop: '#2c1654', skyMid: '#ff5e62', skyBot: '#ff9966', fogColor: '#ff7e5f' });
        if (s === 'night') Object.assign(S.worldSettings, { skyTop: '#050714', skyMid: '#141e30', skyBot: '#243b55', fogColor: '#141e30' });
        if (s === 'heaven') Object.assign(S.worldSettings, { skyTop: '#f39c12', skyMid: '#ffeaa7', skyBot: '#ffffff', fogColor: '#fff3c4' });
        updateSkybox();
        renderInspectorUI();
      };
    });

    $('wGrav').oninput = e => {
      S.worldSettings.gravity = +e.target.value || 22;
    };
    $('wRespMode').onchange = e => {
      S.worldSettings.respawnMode = e.target.value;
      $('wRespDelayRow').hidden = S.worldSettings.respawnMode !== 'timer';
    };
    $('wRespDelay').oninput = e => {
      S.worldSettings.respawnDelay = clamp(+e.target.value || 3.5, 1, 30);
    };
    $('btnAllHpOn').onclick = () => {
      if (S.player) S.player.hpEnabled = true;
      S.queueLine.forEach(e => e.hpEnabled = true);
      S.customNPCs.forEach(e => e.hpEnabled = true);
      updateShopUI();
      showBanner('❤️ Здоровье и урон: 🟢 (для всех)!', '#00e676');
    };
    $('btnAllHpOff').onclick = () => {
      if (S.player) S.player.hpEnabled = false;
      S.queueLine.forEach(e => e.hpEnabled = false);
      S.customNPCs.forEach(e => e.hpEnabled = false);
      updateShopUI();
      showBanner('🛡️ Здоровье и урон: 🔴 (бессмертие)!', '#56f0ff');
    };
    return;
  }

  // 2. ИНСПЕКТОР ПРЕДМЕТА / ОРУЖИЯ / СНАРЯДА / 2-РУЧНОГО КОНТЕЙНЕРА (Этап 4)
  if (selectedRef.kind === 'world_item') {
    const { worldEntry, libIdx } = selectedRef;
    const item = normalizeItemData(worldEntry.item);
    const editMode = selectedRef.editMode || 'part';
    const hasProjectile = item.useType === 'ranged' || item.useType === 'throwable';
    const isEditingProj = editMode === 'proj_part';
    const activePartsArr = isEditingProj ? item.projectileParts : item.parts;
    const partIdx = clamp(selectedRef.partIdx || 0, 0, activePartsArr.length - 1);
    const part = activePartsArr[partIdx];
    normalizePartEffects(part, false, false);
    const ptData = part.particleData;
    const isEditingFromLib = libIdx !== undefined && !!S.savedItemsLibrary[libIdx];

    if (!item.lightData) {
      item.lightData = {
        enabled: false,
        realLight: false,
        pseudoLight: false,
        color: '#ff9f43',
        intensity: 1.8,
        distance: 16
      };
    }
    if (!item.particleData) {
      item.particleData = createDefaultPartParticleData();
    }

    const partsChipsHTML = activePartsArr
      .map((pt, idx) => {
        const fx = (pt.realLight ? '💡' : (pt.pseudoLight ? '✨' : '')) + (pt.particleData?.enabled ? '🎆' : '');
        return `
        <button class="ed-btn ${idx === partIdx && (editMode === 'part' || editMode === 'proj_part') ? 'active' : ''}" data-selipt="${idx}" type="button" style="padding:4px 7px;font-size:10px">
          #${idx + 1} ${pt.name || pt.shape}${fx ? ' ' + fx : ''}
        </button>
      `;
      })
      .join('');

    cont.innerHTML = `
      <div class="prop-group" style="border-color:#ff9f43">
        <h5>${item.icon || '🗡️'} Конструктор Предмета и Оружия</h5>
        ${S.itemStudioOpen ? `
          <button class="ed-btn" id="btnItmPlaceInWorld" type="button" style="width:100%;justify-content:center;margin-bottom:5px;background:rgba(255,179,0,0.16);border-color:#ffb300;color:#ffe082">📍 Переместить на карте (Выйти из 3D STUDIO)</button>
        ` : `
          <button class="ed-btn apply-oneclick" id="btnItmOpenStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:5px;background:rgba(86,240,255,0.16);border-color:#56f0ff;color:#56f0ff">🛠️ Открыть в 3D STUDIO (Верстак предмета)</button>
        `}
        <div style="display:flex;gap:5px">
          <button class="ed-btn apply-oneclick" id="btnGiveItemToPlayer" type="button" style="flex:1;justify-content:center" title="Сразу положить предмет в хотбар или в руки игрока">🎒 Выдать игроку</button>
          <button class="ed-btn" id="btnUndoItemLocal" type="button" title="Отменить действие внутри этого предмета (Ctrl+Z)">↩️ Отмена</button>
        </div>

        <!-- Переключатель режима Гизмо: что именно сейчас двигаем в 3D-окне -->
        <div style="background:rgba(8,10,16,0.78);border:1px solid #283147;border-radius:8px;padding:6px;margin-top:4px">
          <div style="font:800 9.5px var(--f);color:#8fa0bd;margin-bottom:5px;text-transform:uppercase">Режим 3D-Гизмо (Что двигаем мышкой):</div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:4px">
            <button class="ed-btn ${editMode === 'part' ? 'active' : ''}" data-imode="part" type="button" style="justify-content:center">🎨 Внешний вид (${item.parts.length}/16)</button>
            <button class="ed-btn ${editMode === 'root' && !S.itemStudioOpen ? 'active' : ''}" data-imode="root" type="button" style="justify-content:center">📍 Позиция на карте</button>
            <button class="ed-btn ${editMode === 'grip' ? 'active' : ''}" data-imode="grip" type="button" style="justify-content:center;border-color:#00e676">🤚 Точка Хвата (Grip)</button>
            ${hasProjectile ? `
              <button class="ed-btn ${editMode === 'muzzle' ? 'active' : ''}" data-imode="muzzle" type="button" style="justify-content:center;border-color:#ff3e3e">🎯 Точка Вылета</button>
              <button class="ed-btn ${editMode === 'proj_part' ? 'active' : ''}" data-imode="proj_part" type="button" style="grid-column:span 2;justify-content:center;border-color:#ffce3a">🚀 Внешний вид Снаряда (${item.projectileParts.length}/16)</button>
            ` : ''}
          </div>
        </div>

        <div class="prop-row" style="margin-top:4px">
          <label>Иконка / Имя</label>
          <input class="ed-inp" id="inpItmIco" value="${item.icon || '🗡️'}" style="width:42px;text-align:center" title="Эмодзи-иконка для хотбара">
          <input class="ed-inp" id="inpItmName" value="${item.name}" style="flex:1">
        </div>

        <div class="prop-row">
          <label>Хват в руках</label>
          <select class="ed-inp" id="inpItmHold">
            <option value="held" ${item.holdMode === 'held' ? 'selected' : ''}>🤚 Удерживаемый (1 рука, лежит в Хотбаре)</option>
            <option value="carried" ${item.holdMode === 'carried' ? 'selected' : ''}>📦 Переносимый (2 руки перед собой, крупный)</option>
          </select>
        </div>

        <div class="prop-row">
          <label>Тип / Тег</label>
          <select class="ed-inp" id="inpItmUse">
            <option value="melee" ${item.useType === 'melee' ? 'selected' : ''}>🗡️ Оружие ближнего боя (Меч, Дубинка, Нож)</option>
            <option value="ranged" ${item.useType === 'ranged' ? 'selected' : ''}>🔫 Оружие дальнего боя / Огнестрел / Магия</option>
            <option value="throwable" ${item.useType === 'throwable' ? 'selected' : ''}>💣 Метательный снаряд (Замах удержанием ЛКМ)</option>
            <option value="consumable" ${item.useType === 'consumable' ? 'selected' : ''}>🍗 Хилка / Еда / Зелье (HP и баффы)</option>
            <option value="shield" ${item.useType === 'shield' ? 'selected' : ''}>🛡️ Экипировка / Броня / Щит (+HP и Защита)</option>
            <option value="torch" ${item.useType === 'torch' ? 'selected' : ''}>🔦 Факел / Фонарь (Освещает мир вокруг)</option>
            <option value="none" ${item.useType === 'none' ? 'selected' : ''}>📦 Декор / Контейнер (Только носить/бросать)</option>
          </select>
        </div>
      </div>

      <!-- СЕКЦИЯ ВНЕШНЕГО ВИДА ПРЕДМЕТА ИЛИ СНАРЯДА (ДО 16 ДЕТАЛЕЙ + СВЕТ И ЧАСТИЦЫ) -->
      <div class="prop-group" style="border-color:${isEditingProj ? '#ffce3a' : '#56f0ff'}">
        <h5>
          <span>${isEditingProj ? `🚀 Внешний вид Снаряда (${item.projectileParts.length}/${MAX_ITEM_PARTS})` : `🎨 Внешний вид (${item.parts.length}/${MAX_ITEM_PARTS})`}</span>
        </h5>
        ${hasProjectile ? `
          <div style="display:flex;gap:4px;margin-bottom:4px">
            <button class="ed-btn ${!isEditingProj ? 'active' : ''}" id="btnTabItemParts" type="button" style="flex:1;justify-content:center">🎨 Внешний вид предмета</button>
            <button class="ed-btn ${isEditingProj ? 'active' : ''}" id="btnTabProjParts" type="button" style="flex:1;justify-content:center">🚀 Внешний вид снаряда</button>
          </div>
        ` : ''}
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${partsChipsHTML}
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">
          <button class="ed-btn apply-oneclick" id="btnAddItmPart" type="button" style="flex:1">➕ Добавить деталь</button>
          <button class="ed-btn icon-only" id="btnDupItmPart" type="button" title="Дублировать деталь">📋</button>
          <button class="ed-btn danger icon-only" id="btnDelItmPart" type="button" title="Удалить деталь">🗑️</button>
        </div>

        <div style="border-top:1px solid #262c3d;padding-top:6px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
          <div class="prop-row"><label>Деталь #${partIdx + 1}</label><input class="ed-inp" id="inpItmPtName" value="${part.name || ('Часть #' + (partIdx + 1))}"></div>
          <div class="prop-row">
            <label>Форма и Цвет</label>
            <select class="ed-inp" id="inpItmPtShape" style="flex:1">
              <option value="box" ${part.shape === 'box' ? 'selected' : ''}>Куб (Box)</option>
              <option value="sphere" ${part.shape === 'sphere' ? 'selected' : ''}>Сфера (Sphere)</option>
              <option value="cylinder" ${part.shape === 'cylinder' ? 'selected' : ''}>Цилиндр (Cylinder)</option>
              <option value="cone" ${part.shape === 'cone' ? 'selected' : ''}>Конус / Остриё (Cone)</option>
              <option value="torus" ${part.shape === 'torus' ? 'selected' : ''}>Кольцо (Torus)</option>
              <option value="plane" ${part.shape === 'plane' ? 'selected' : ''}>Плоскость (Plane)</option>
            </select>
            <input type="color" class="ed-color" id="inpItmPtCol" value="${part.color || '#56f0ff'}">
          </div>
          <div class="prop-row">
            <label>2D Принт</label>
            <button class="ed-btn" id="btnPaintItmPart" type="button" style="flex:1">🎨 Спрайт спереди</button>
            ${part.texDataURL ? `<button class="ed-btn danger" id="btnClearItmPartSpr" type="button" title="Убрать спрайт">✕</button>` : ''}
          </div>
          <div class="prop-row"><label>Позиция</label><div class="vec3">
            <input type="number" step="0.05" class="ed-inp" id="inpItmPX" value="${(part.x || 0).toFixed(2)}">
            <input type="number" step="0.05" class="ed-inp" id="inpItmPY" value="${(part.y || 0).toFixed(2)}">
            <input type="number" step="0.05" class="ed-inp" id="inpItmPZ" value="${(part.z || 0).toFixed(2)}">
          </div></div>
          <div class="prop-row"><label>Размер</label><div class="vec3">
            <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpItmSX" value="${(part.sx ?? 1).toFixed(2)}">
            <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpItmSY" value="${(part.sy ?? 1).toFixed(2)}">
            <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpItmSZ" value="${(part.sz ?? 1).toFixed(2)}">
          </div></div>
          <div class="prop-row"><label>Поворот°</label><div class="vec3">
            <input type="number" step="15" class="ed-inp" id="inpItmRX" value="${Math.round(THREE.MathUtils.radToDeg(part.rx || 0))}">
            <input type="number" step="15" class="ed-inp" id="inpItmRY" value="${Math.round(THREE.MathUtils.radToDeg(part.ry || 0))}">
            <input type="number" step="15" class="ed-inp" id="inpItmRZ" value="${Math.round(THREE.MathUtils.radToDeg(part.rz || 0))}">
          </div></div>

          <!-- Эффекты выбранной детали: Настоящий свет, Псевдо-свет, Источать частицы -->
          <div style="margin-top:4px;padding-top:6px;border-top:1px dashed #283147;display:flex;flex-direction:column;gap:5px">
            <div style="font:800 9.5px var(--f);color:#94a3b8;text-transform:uppercase">Эффекты детали #${partIdx + 1}:</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
              <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
                <input type="checkbox" id="inpItmPtRealLgt" ${part.realLight ? 'checked' : ''}> 💡 Настоящий свет
              </label>
              <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
                <input type="checkbox" id="inpItmPtPseudoLgt" ${part.pseudoLight ? 'checked' : ''}> ✨ Псевдо-свет
              </label>
              <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#56f0ff;cursor:pointer">
                <input type="checkbox" id="inpItmPtEmit" ${ptData.enabled ? 'checked' : ''}> 🎆 Источать частицы
              </label>
            </div>

            <div id="itmPtLightRows" ${(part.realLight || part.pseudoLight) ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(255,213,79,0.06);padding:6px;border-radius:7px;border:1px solid rgba(255,213,79,0.28)">
              <div class="prop-row">
                <label>Цвет / Яркость</label>
                <input type="color" class="ed-color" id="inpItmPtLCol" value="${part.lightColor || part.color || '#56f0ff'}">
                <input type="number" step="0.2" min="0.2" max="5" class="ed-inp" id="inpItmPtLInt" value="${part.lightIntensity ?? 1.4}" style="width:65px" title="Яркость свечения">
                <label style="flex:1;text-align:right">Радиус</label>
                <input type="number" step="1" min="2" max="50" class="ed-inp" id="inpItmPtLDist" value="${part.lightDistance ?? 12}" style="width:60px" title="Радиус настоящего света">
              </div>
            </div>

            <div id="itmPtEmitRows" ${ptData.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(86,240,255,0.06);padding:6px;border-radius:7px;border:1px solid rgba(86,240,255,0.28)">
              <div class="prop-row">
                <label>Частица 16×16</label>
                <select class="ed-inp" id="inpItmPtPreset" style="flex:1">
                  <option value="spark" ${ptData.preset === 'spark' ? 'selected' : ''}>💠 Искра (Spark)</option>
                  <option value="fire" ${ptData.preset === 'fire' ? 'selected' : ''}>🔥 Огонь (Fire)</option>
                  <option value="heart" ${ptData.preset === 'heart' ? 'selected' : ''}>❤️ Сердечко (Heart)</option>
                  <option value="star" ${ptData.preset === 'star' ? 'selected' : ''}>⭐ Звезда (Star)</option>
                  <option value="smoke" ${ptData.preset === 'smoke' ? 'selected' : ''}>💨 Дым (Smoke)</option>
                  <option value="hit" ${ptData.preset === 'hit' ? 'selected' : ''}>💥 Всплеск (Hit)</option>
                  <option value="custom" ${ptData.preset === 'custom' ? 'selected' : ''}>🎨 Свой 16×16</option>
                </select>
                <button class="ed-btn apply-oneclick" id="btnPaintItmPtSpr" type="button">🖌️ 16×16</button>
              </div>
              <div class="prop-row">
                <label>Оттенок и Кол/с</label>
                <input type="color" class="ed-color" id="inpItmPtPCol" value="${ptData.color || '#ffffff'}">
                <input type="number" min="1" max="60" step="1" class="ed-inp" id="inpItmPtPRate" value="${ptData.rate ?? 10}" style="width:70px" title="Частиц в секунду">
              </div>
              <div class="prop-row">
                <label>Размер / Скор. / Y</label>
                <div class="vec3">
                  <input type="number" step="0.05" min="0.05" max="3" class="ed-inp" id="inpItmPtPSize" value="${ptData.sizeStart ?? 0.28}" title="Размер частицы">
                  <input type="number" step="0.2" min="0" max="20" class="ed-inp" id="inpItmPtPSpd" value="${ptData.speed ?? 1.6}" title="Скорость разлёта">
                  <input type="number" step="0.5" class="ed-inp" id="inpItmPtPGrav" value="${ptData.gravity ?? 1.5}" title="Движение по Y">
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- ТОЧКА ДЕРЖАНИЯ (GRIP POINT) И ТОЧКА ВЫЛЕТА СНАРЯДА (MUZZLE POINT) -->
      <div class="prop-group">
        <h5>🤚 Точка Держания и 🎯 Точка Вылета</h5>
        <div style="font-size:10px;color:#8fa0bd;margin-bottom:3px">
          🟢 Зелёная рукоятка в 3D — место хвата правой руки. 🟠 Прицел-воронка — откуда вылетают снаряды.
        </div>
        <div class="prop-row"><label>Хват X/Y/Z</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpGripX" value="${(item.gripPoint.x || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpGripY" value="${(item.gripPoint.y || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpGripZ" value="${(item.gripPoint.z || 0).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот хвата°</label><div class="vec3">
          <input type="number" step="15" class="ed-inp" id="inpGripRX" value="${Math.round(THREE.MathUtils.radToDeg(item.gripPoint.rx || 0))}">
          <input type="number" step="15" class="ed-inp" id="inpGripRY" value="${Math.round(THREE.MathUtils.radToDeg(item.gripPoint.ry || 0))}">
          <input type="number" step="15" class="ed-inp" id="inpGripRZ" value="${Math.round(THREE.MathUtils.radToDeg(item.gripPoint.rz || 0))}">
        </div></div>
        ${hasProjectile ? `
          <div class="prop-row"><label>Дуло X/Y/Z</label><div class="vec3">
            <input type="number" step="0.05" class="ed-inp" id="inpMuzX" value="${(item.muzzlePoint.x || 0).toFixed(2)}">
            <input type="number" step="0.05" class="ed-inp" id="inpMuzY" value="${(item.muzzlePoint.y || 0).toFixed(2)}">
            <input type="number" step="0.05" class="ed-inp" id="inpMuzZ" value="${(item.muzzlePoint.z ?? -0.8).toFixed(2)}">
          </div></div>
        ` : ''}
      </div>

      <!-- НАСТРОЙКИ БОЯ: БЛИЖНИЙ БОЙ / СТРЕЛЬБА / МЕТАНИЕ -->
      ${item.useType === 'melee' ? `
        <div class="prop-group">
          <h5>🗡️ Параметры Оружия Ближнего Боя</h5>
          <div class="prop-row">
            <label title="Поставь 0 для нелетального / игрушечного оружия">Урон (0=Игрушка)</label>
            <input type="number" step="5" min="0" class="ed-inp" id="inpItmDmg" value="${item.damage}">
          </div>
          <div class="prop-row"><label>Дальн. / Радиус</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.2" min="1.5" max="15" class="ed-inp" id="inpItmRng" value="${item.range}" title="Дальность доставания удара">
            <input type="number" step="0.2" min="0.5" max="8" class="ed-inp" id="inpItmRad" value="${item.radius}" title="Ширина/радиус захвата цели">
          </div></div>
          <div class="prop-row"><label>Отдача / Кулдаун</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="1" min="0" class="ed-inp" id="inpItmKb" value="${item.knockback}" title="Сила отталкивания врага">
            <input type="number" step="0.05" min="0.1" class="ed-inp" id="inpItmCd" value="${item.cooldown}" title="Время между ударами (сек)">
          </div></div>
        </div>
      ` : ''}

      ${hasProjectile ? `
        <div class="prop-group" style="border-color:#ff6b6b">
          <h5>${item.useType === 'throwable' ? '💣 Баллистика и Замах Метательного' : '🔫 Баллистика, Магазин и Прицел'}</h5>
          <div class="prop-row">
            <label title="Поставь 0 для нелетального / игрушечного оружия">Урон снаряда</label>
            <input type="number" step="5" min="0" class="ed-inp" id="inpItmDmg" value="${item.damage}" style="width:70px">
            <label style="flex:1;text-align:right" title="Радиус взрыва при попадании (0 = точечное попадание)">Взрыв (м)</label>
            <input type="number" step="0.5" min="0" max="20" class="ed-inp" id="inpItmBlast" value="${item.blastRadius}" style="width:65px">
          </div>
          <div class="prop-row"><label>Скорость / Дальн.</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="2" min="4" max="120" class="ed-inp" id="inpItmPrjSpd" value="${item.projSpeed}" title="Максимальная скорость полёта снаряда">
            <input type="number" step="5" min="10" max="200" class="ed-inp" id="inpItmMaxRng" value="${item.maxRange}" title="Максимальная дальность полёта">
          </div></div>
          <div class="prop-row"><label>Баллистика / Разбр.</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.05" min="0" max="3" class="ed-inp" id="inpItmGrav" value="${item.gravityFactor}" title="Гравитация снаряда: 0 = летит прямо как лазер, 1 = парабола">
            <input type="number" step="0.01" min="0" max="0.5" class="ed-inp" id="inpItmSprd" value="${item.spread}" title="Разброс при стрельбе (0 = идеальная точность)">
          </div></div>
          <div class="prop-row">
            <label>Прицел ПКМ</label>
            <input type="checkbox" id="inpItmAim" ${item.canAim !== false ? 'checked' : ''}>
            <span style="font-size:10.5px;color:#cbd5e1">Зум камеры + 3D-траектория</span>
          </div>

          ${item.useType === 'ranged' ? `
            <div class="prop-row">
              <label>Бескон. патроны</label>
              <input type="checkbox" id="inpItmInfAmmo" ${item.infiniteAmmo ? 'checked' : ''}>
              <label style="flex:1;text-align:right">Авто-огонь</label>
              <input type="checkbox" id="inpItmAuto" ${item.autoFire !== false ? 'checked' : ''}>
            </div>
            <div class="prop-row"><label>Магазин / Запас</label><div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="1" min="1" class="ed-inp" id="inpItmMag" value="${item.magSize}" title="Патронов в 1 обойме">
              <input type="number" step="5" min="0" class="ed-inp" id="inpItmRes" value="${item.reserveAmmo}" title="Запас патронов с собой">
            </div></div>
            <div class="prop-row"><label>Перезар. / Темп</label><div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="0.1" min="0.2" class="ed-inp" id="inpItmRel" value="${item.reloadTime}" title="Время перезарядки [R] (сек)">
              <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpItmCd" value="${item.cooldown}" title="Пауза между выстрелами (сек)">
            </div></div>
          ` : `
            <div class="prop-row">
              <label>Бескон. снаряды</label>
              <input type="checkbox" id="inpItmInfAmmo" ${item.infiniteAmmo ? 'checked' : ''}>
              <label style="flex:1;text-align:right">Кол-во (Стак)</label>
              <input type="number" step="1" min="1" class="ed-inp" id="inpItmStack" value="${item.stackCount}" style="width:65px">
            </div>
            <div class="prop-row"><label>Мин.Скор / Замах(с)</label><div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="1" min="2" class="ed-inp" id="inpItmMinSpd" value="${item.minThrowSpeed}" title="Начальная (минимальная) скорость при прицеливании ПКМ">
              <input type="number" step="0.1" min="0.2" class="ed-inp" id="inpItmChgT" value="${item.maxChargeTime}" title="Время удержания ЛКМ для 100% броска">
            </div></div>
          `}
        </div>
      ` : ''}

      <!-- ЕДИНЫЙ ОБЪЕДИНЁННЫЙ РАЗДЕЛ «⚙️ СВОЙСТВА ПРЕДМЕТА» -->
      <div class="prop-group" style="border-color:#00e676">
        <h5>⚙️ Свойства предмета</h5>

        ${item.useType === 'consumable' ? `
          <div style="background:rgba(0,230,118,0.06);border:1px solid rgba(0,230,118,0.28);border-radius:7px;padding:6px;margin-bottom:5px;display:flex;flex-direction:column;gap:5px">
            <div style="font:800 9.5px var(--f);color:#69f0ae;text-transform:uppercase">🍗 Эффект Еды / Аптечки / Зелья:</div>
            <div class="prop-row">
              <label title="Плюс восстанавливает HP, минус отнимает (яд)">Эффект HP (+/-)</label>
              <input type="number" step="10" class="ed-inp" id="inpItmHeal" value="${item.healAmount}">
            </div>
            <div class="prop-row"><label>Бафф Бег / Прыжок</label><div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="0.5" class="ed-inp" id="inpItmBfSpd" value="${item.buffSpeed}" title="Прибавка к скорости бега">
              <input type="number" step="0.5" class="ed-inp" id="inpItmBfJmp" value="${item.buffJump}" title="Прибавка к высоте прыжка">
            </div></div>
            <div class="prop-row"><label>Бафф Урон / Рост</label><div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="5" class="ed-inp" id="inpItmBfDmg" value="${item.buffDamage}" title="Прибавка к урону с руки">
              <input type="number" step="0.1" class="ed-inp" id="inpItmBfScl" value="${item.buffScale}" title="Изменение размера персонажа (например +0.3)">
            </div></div>
          </div>
        ` : ''}

        <div class="prop-row">
          <label>Бескон. прочн.</label>
          <input type="checkbox" id="inpItmInfDur" ${item.infiniteDurability ? 'checked' : ''}>
          <label style="flex:1;text-align:right">Ронять от удара</label>
          <input type="checkbox" id="inpItmDropHit" ${item.dropOnHit ? 'checked' : ''}>
        </div>
        <div id="itmDurRows" ${item.infiniteDurability ? 'hidden' : ''} style="display:flex;flex-direction:column;gap:5px">
          <div class="prop-row"><label>Прочн. / Трата</label><div class="vec3">
            <input type="number" step="1" min="1" class="ed-inp" id="inpItmDur" value="${item.durability}" title="Текущая прочность">
            <input type="number" step="5" min="1" class="ed-inp" id="inpItmMaxDur" value="${item.maxDurability}" title="Макс. прочность">
            <input type="number" step="1" min="0" class="ed-inp" id="inpItmDurCost" value="${item.durabilityCostPerUse}" title="Расход прочности за 1 использование">
          </div></div>
          <div class="prop-row"><label>Расход/с и Падение</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.5" min="0" class="ed-inp" id="inpItmDecay" value="${item.passiveDecayPerSec}" title="Пассивное сгорание в секунду (для факела)">
            <input type="number" step="1" min="0" class="ed-inp" id="inpItmFallMult" value="${item.fallDamageMult}" title="Урон предмету при падении о землю (для хрупких ящиков)">
          </div></div>
        </div>

        <div class="prop-row"><label>Броня% / +Макс.HP</label><div class="vec3" style="grid-template-columns:1fr 1fr">
          <input type="number" step="5" min="0" max="90" class="ed-inp" id="inpEqArmor" value="${item.equipStats.armorPct}" title="% снижения входящего урона">
          <input type="number" step="10" min="0" class="ed-inp" id="inpEqHp" value="${item.equipStats.maxHpBonus}" title="Бонус к максимальному здоровью">
        </div></div>
        <div class="prop-row">
          <label>+Урон / Неуязвим.</label>
          <input type="number" step="5" class="ed-inp" id="inpEqDmg" value="${item.equipStats.damageBonus}" style="width:75px" title="Бонус к исходящему урону">
          <label style="flex:1;text-align:right">Бессмертие в руке</label>
          <input type="checkbox" id="inpEqInv" ${item.equipStats.invulnerable ? 'checked' : ''}>
        </div>

        <!-- Булевы свойства свечения и частиц предмета -->
        <div style="margin-top:4px;padding-top:6px;border-top:1px dashed #283147;display:flex;flex-direction:column;gap:5px">
          <div style="font:800 9.5px var(--f);color:#94a3b8;text-transform:uppercase">Свечение и частицы предмета:</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
              <input type="checkbox" id="inpItmRealLgt" ${item.lightData.realLight ? 'checked' : ''}> 💡 Настоящий свет
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
              <input type="checkbox" id="inpItmPseudoLgt" ${item.lightData.pseudoLight ? 'checked' : ''}> ✨ Псевдо-свет
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#56f0ff;cursor:pointer">
              <input type="checkbox" id="inpItmEmitAll" ${item.particleData.enabled ? 'checked' : ''}> 🎆 Источать частицы
            </label>
          </div>

          <div id="itmGlobalLightRows" ${(item.lightData.realLight || item.lightData.pseudoLight) ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(255,213,79,0.06);padding:6px;border-radius:7px;border:1px solid rgba(255,213,79,0.28)">
            <div class="prop-row">
              <label>Цвет / Ярк. / Рад.</label>
              <input type="color" class="ed-color" id="inpItmLgtCol" value="${item.lightData.color || '#ff9f43'}">
              <input type="number" step="0.2" min="0.2" max="5" class="ed-inp" id="inpItmLgtInt" value="${item.lightData.intensity ?? 1.8}" style="width:60px" title="Яркость свечения">
              <input type="number" step="2" min="4" max="50" class="ed-inp" id="inpItmLgtDist" value="${item.lightData.distance || 16}" style="width:62px" title="Радиус освещения вокруг предмета">
            </div>
          </div>

          <div id="itmGlobalEmitRows" ${item.particleData.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(86,240,255,0.06);padding:6px;border-radius:7px;border:1px solid rgba(86,240,255,0.28)">
            <div class="prop-row">
              <label>Шаблон 16×16</label>
              <select class="ed-inp" id="inpItmEmitPreset" style="flex:1">
                <option value="spark" ${item.particleData.preset === 'spark' ? 'selected' : ''}>💠 Искра (Spark)</option>
                <option value="fire" ${item.particleData.preset === 'fire' ? 'selected' : ''}>🔥 Огонь (Fire)</option>
                <option value="heart" ${item.particleData.preset === 'heart' ? 'selected' : ''}>❤️ Сердечко (Heart)</option>
                <option value="star" ${item.particleData.preset === 'star' ? 'selected' : ''}>⭐ Звезда (Star)</option>
                <option value="smoke" ${item.particleData.preset === 'smoke' ? 'selected' : ''}>💨 Дым (Smoke)</option>
                <option value="hit" ${item.particleData.preset === 'hit' ? 'selected' : ''}>💥 Всплеск (Hit)</option>
                <option value="custom" ${item.particleData.preset === 'custom' ? 'selected' : ''}>🎨 Свой 16×16</option>
              </select>
              <button class="ed-btn apply-oneclick" id="btnPaintItmGlobalPt" type="button">🖌️ 16×16</button>
            </div>
            <div class="prop-row">
              <label>Цвет / Кол/с / Разм.</label>
              <input type="color" class="ed-color" id="inpItmEmitCol" value="${item.particleData.color || '#ffffff'}">
              <input type="number" min="1" max="60" step="1" class="ed-inp" id="inpItmEmitRate" value="${item.particleData.rate ?? 10}" style="width:60px" title="Частиц в секунду">
              <input type="number" step="0.05" min="0.05" max="3" class="ed-inp" id="inpItmEmitSize" value="${item.particleData.sizeStart ?? 0.28}" style="width:60px" title="Размер частицы">
            </div>
          </div>
        </div>
      </div>

      <button class="ed-btn apply-oneclick" id="btnSaveItemToLib" type="button" style="justify-content:center;padding:8px">
        ${isEditingFromLib ? '💾 Обновить предмет в Арсенале' : '⭐ Сохранить предмет в Арсенал (Библиотеку)'}
      </button>
    `;

    const refreshItemEditor = (nextMode = editMode, nextPartIdx = partIdx, inWorldPlacement = Boolean(selectedRef.inWorldPlacement)) => {
      syncLibraryItemIfEditing(selectedRef);
      selectEditorObject(
        {
          kind: 'world_item',
          worldEntry,
          item,
          editMode: nextMode,
          partIdx: nextPartIdx,
          inWorldPlacement,
          libIdx
        },
        true
      );
      syncItemStudioPreview();
    };

    if ($('btnItmOpenStudio3D')) {
      $('btnItmOpenStudio3D').onclick = () => {
        refreshItemEditor('part', partIdx, false);
      };
    }
    if ($('btnItmPlaceInWorld')) {
      $('btnItmPlaceInWorld').onclick = () => {
        closeItemStudio3D(false);
        refreshItemEditor('root', partIdx, true);
        showBanner('📍 Предмет перенесён на карту. Двигайте его стрелками Гизмо!', '#ffce3a');
      };
    }

    $('btnGiveItemToPlayer').onclick = () => {
      if (!S.player) return;
      const copy = normalizeItemData(JSON.parse(JSON.stringify(item)));
      if (copy.holdMode === 'carried') {
        S.player.carriedItem = copy;
        syncEntityHeldItemMesh(S.player);
        renderHotbarUI();
        sfx.coil();
        showBanner(`📦 «${copy.name}» вложен в 2 руки игрока! Нажми F2 для теста.`, '#00e676');
      } else {
        if (!Array.isArray(S.player.inventory)) S.player.inventory = [null, null, null, null, null, null];
        let slot = S.player.inventory.findIndex((x, idx) => idx > 0 && !x);
        if (slot === -1) slot = 1;
        S.player.inventory[slot] = copy;
        S.activeSlot = slot;
        syncEntityHeldItemMesh(S.player);
        renderHotbarUI();
        sfx.coil();
        showBanner(`${copy.icon} «${copy.name}» выдан игроку в Слот #${slot + 1}!`, '#00e676');
      }
    };

    $('btnUndoItemLocal').onclick = () => undoLastItemAction();

    cont.querySelectorAll('[data-imode]').forEach(btn => {
      btn.onclick = () => {
        const m = btn.dataset.imode;
        if (m === 'root') {
          closeItemStudio3D(false);
          refreshItemEditor('root', partIdx, true);
        } else {
          refreshItemEditor(m, partIdx, false);
        }
      };
    });

    if ($('btnTabItemParts')) {
      $('btnTabItemParts').onclick = () => refreshItemEditor('part', 0, false);
    }
    if ($('btnTabProjParts')) {
      $('btnTabProjParts').onclick = () => refreshItemEditor('proj_part', 0, false);
    }

    $('inpItmIco').oninput = e => {
      item.icon = e.target.value || '🗡️';
      rebuildWorldItemVisual(worldEntry, true);
      refreshHierarchyUI();
    };
    $('inpItmName').oninput = e => {
      item.name = e.target.value;
      if ($('itemStudioSubjectTitle') && S.itemStudioOpen) {
        $('itemStudioSubjectTitle').textContent = `🗡️ 3D STUDIO: ${item.name || 'Предмет'}`;
      }
      rebuildWorldItemVisual(worldEntry, true);
      refreshHierarchyUI();
    };
    $('inpItmHold').onchange = e => {
      pushItemUndoState('Смена режима хвата предмета');
      item.holdMode = e.target.value;
      if (item.holdMode === 'carried') {
        item.dropOnHit = true;
        if (!item.fallDamageMult) item.fallDamageMult = 4.5;
      }
      refreshItemEditor(editMode, partIdx);
    };
    $('inpItmUse').onchange = e => {
      pushItemUndoState('Смена типа предмета');
      item.useType = e.target.value;
      if (item.useType === 'torch') {
        item.lightData.realLight = true;
        item.lightData.pseudoLight = true;
        item.lightData.enabled = true;
      }
      refreshItemEditor('part', 0, false);
    };

    cont.querySelectorAll('[data-selipt]').forEach(btn => {
      btn.onclick = () => {
        const targetMode = isEditingProj ? 'proj_part' : 'part';
        refreshItemEditor(targetMode, +btn.dataset.selipt, false);
      };
    });

    $('btnAddItmPart').onclick = () => {
      if (activePartsArr.length >= MAX_ITEM_PARTS) {
        showBanner(`Максимум ${MAX_ITEM_PARTS} деталей!`, '#ff3e3e');
        return;
      }
      pushItemUndoState('Добавление детали');
      activePartsArr.push(normalizePartEffects({
        id: 'ipt_' + Date.now(),
        name: `Часть #${activePartsArr.length + 1}`,
        shape: isEditingProj ? 'sphere' : 'box',
        x: 0,
        y: (part.y || 0) + 0.2,
        z: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        sx: 0.4,
        sy: 0.4,
        sz: 0.4,
        color: isEditingProj ? '#ff3e3e' : '#56f0ff',
        texDataURL: null
      }, false, false));
      sfx.jump();
      refreshItemEditor(isEditingProj ? 'proj_part' : 'part', activePartsArr.length - 1, false);
    };

    $('btnDupItmPart').onclick = () => {
      if (activePartsArr.length >= MAX_ITEM_PARTS) {
        showBanner(`Максимум ${MAX_ITEM_PARTS} деталей!`, '#ff3e3e');
        return;
      }
      pushItemUndoState('Дублирование детали');
      const copyP = normalizePartEffects(Object.assign({}, JSON.parse(JSON.stringify(part)), {
        id: 'ipt_' + Date.now(),
        name: `${part.name || 'Часть'}_Копия`,
        x: (part.x || 0) + 0.15
      }), false, false);
      activePartsArr.push(copyP);
      sfx.jump();
      refreshItemEditor(isEditingProj ? 'proj_part' : 'part', activePartsArr.length - 1, false);
    };

    $('btnDelItmPart').onclick = () => {
      if (activePartsArr.length <= 1) {
        showBanner('В предмете/снаряде должна оставаться хотя бы 1 деталь!', '#ffce3a');
        return;
      }
      pushItemUndoState('Удаление детали');
      activePartsArr.splice(partIdx, 1);
      sfx.oof();
      refreshItemEditor(isEditingProj ? 'proj_part' : 'part', Math.max(0, partIdx - 1), false);
    };

    $('inpItmPtName').oninput = e => {
      part.name = e.target.value;
      syncLibraryItemIfEditing(selectedRef);
    };
    $('inpItmPtShape').onchange = e => {
      pushItemUndoState('Смена формы детали');
      part.shape = e.target.value;
      refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
    };
    $('inpItmPtCol').onfocus = () => pushItemUndoState('Смена цвета детали');
    $('inpItmPtCol').oninput = e => {
      part.color = e.target.value;
      refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
    };
    $('btnPaintItmPart').onclick = () => openPaintModal('cosmetic');
    if ($('btnClearItmPartSpr')) {
      $('btnClearItmPartSpr').onclick = () => {
        pushItemUndoState('Удаление спрайта детали');
        part.texDataURL = null;
        refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
      };
    }

    // События свечения и частиц выбранной детали
    $('inpItmPtRealLgt').onchange = e => {
      pushItemUndoState('Настоящий свет детали');
      part.realLight = e.target.checked;
      if (part.realLight && !part.lightColor) part.lightColor = part.color || '#56f0ff';
      refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
    };
    $('inpItmPtPseudoLgt').onchange = e => {
      pushItemUndoState('Псевдо-свет детали');
      part.pseudoLight = e.target.checked;
      if (part.pseudoLight && !part.lightColor) part.lightColor = part.color || '#56f0ff';
      refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
    };
    $('inpItmPtEmit').onchange = e => {
      pushItemUndoState('Частицы детали');
      ptData.enabled = e.target.checked;
      refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
    };
    if ($('inpItmPtLCol')) {
      $('inpItmPtLCol').oninput = e => {
        part.lightColor = e.target.value;
        rebuildWorldItemVisual(worldEntry, true);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpItmPtLInt')) {
      $('inpItmPtLInt').oninput = e => {
        part.lightIntensity = Math.max(0.2, +e.target.value || 1.4);
        rebuildWorldItemVisual(worldEntry, true);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpItmPtLDist')) {
      $('inpItmPtLDist').oninput = e => {
        part.lightDistance = Math.max(2, +e.target.value || 12);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpItmPtPreset')) {
      $('inpItmPtPreset').onchange = e => {
        ptData.preset = e.target.value;
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('btnPaintItmPtSpr')) {
      $('btnPaintItmPtSpr').onclick = () => {
        S.paintParticleScope = 'part';
        openPaintModal('particle');
      };
    }
    if ($('inpItmPtPCol')) {
      $('inpItmPtPCol').oninput = e => {
        ptData.color = e.target.value;
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpItmPtPRate')) {
      $('inpItmPtPRate').oninput = e => {
        ptData.rate = Math.max(1, +e.target.value || 10);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpItmPtPSize')) {
      $('inpItmPtPSize').oninput = e => {
        ptData.sizeStart = Math.max(0.05, +e.target.value || 0.28);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpItmPtPSpd')) {
      $('inpItmPtPSpd').oninput = e => {
        ptData.speed = Math.max(0, +e.target.value || 1.6);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpItmPtPGrav')) {
      $('inpItmPtPGrav').oninput = e => {
        ptData.gravity = +e.target.value || 0;
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }

    const applyItmPartVec = () => {
      part.x = +$('inpItmPX').value || 0;
      part.y = +$('inpItmPY').value || 0;
      part.z = +$('inpItmPZ').value || 0;
      part.sx = Math.max(0.05, +$('inpItmSX').value || 0.4);
      part.sy = Math.max(0.05, +$('inpItmSY').value || 0.4);
      part.sz = Math.max(0.05, +$('inpItmSZ').value || 0.4);
      part.rx = THREE.MathUtils.degToRad(+$('inpItmRX').value || 0);
      part.ry = THREE.MathUtils.degToRad(+$('inpItmRY').value || 0);
      part.rz = THREE.MathUtils.degToRad(+$('inpItmRZ').value || 0);

      if ((editMode === 'part' || editMode === 'proj_part') && selectedRef.mesh) {
        const m = selectedRef.mesh;
        m.position.set(part.x, part.y, part.z);
        m.scale.set(part.sx, part.sy, part.sz);
        m.rotation.set(part.rx, part.ry, part.rz);
        m.updateMatrixWorld(true);
        selBoxHelper.setFromObject(m);
      } else {
        rebuildWorldItemVisual(worldEntry, true);
      }
      syncLibraryItemIfEditing(selectedRef);
      syncItemStudioPreview();
    };
    ['inpItmPX', 'inpItmPY', 'inpItmPZ', 'inpItmSX', 'inpItmSY', 'inpItmSZ', 'inpItmRX', 'inpItmRY', 'inpItmRZ'].forEach(id => {
      $(id).onfocus = () => pushItemUndoState('Трансформация детали');
      $(id).oninput = applyItmPartVec;
    });

    const applyGripAndMuzzle = () => {
      item.gripPoint.x = +$('inpGripX').value || 0;
      item.gripPoint.y = +$('inpGripY').value || 0;
      item.gripPoint.z = +$('inpGripZ').value || 0;
      item.gripPoint.rx = THREE.MathUtils.degToRad(+$('inpGripRX').value || 0);
      item.gripPoint.ry = THREE.MathUtils.degToRad(+$('inpGripRY').value || 0);
      item.gripPoint.rz = THREE.MathUtils.degToRad(+$('inpGripRZ').value || 0);

      if ($('inpMuzX')) {
        item.muzzlePoint.x = +$('inpMuzX').value || 0;
        item.muzzlePoint.y = +$('inpMuzY').value || 0;
        item.muzzlePoint.z = +$('inpMuzZ').value || 0;
      }

      if (editMode === 'grip' && selectedRef.mesh) {
        selectedRef.mesh.position.set(-item.gripPoint.x, -item.gripPoint.y, -item.gripPoint.z);
        selectedRef.mesh.rotation.set(item.gripPoint.rx, item.gripPoint.ry, item.gripPoint.rz);
        selectedRef.mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(selectedRef.mesh);
      } else if (editMode === 'muzzle' && selectedRef.mesh) {
        selectedRef.mesh.position.set(item.muzzlePoint.x, item.muzzlePoint.y, item.muzzlePoint.z);
        selectedRef.mesh.updateMatrixWorld(true);
        selBoxHelper.setFromObject(selectedRef.mesh);
      } else {
        rebuildWorldItemVisual(worldEntry, true);
      }
      syncLibraryItemIfEditing(selectedRef);
      syncItemStudioPreview();
    };
    ['inpGripX', 'inpGripY', 'inpGripZ', 'inpGripRX', 'inpGripRY', 'inpGripRZ', 'inpMuzX', 'inpMuzY', 'inpMuzZ'].forEach(id => {
      if ($(id)) $(id).oninput = applyGripAndMuzzle;
    });

    const syncStats = () => {
      if ($('inpItmDmg')) item.damage = Math.max(0, +$('inpItmDmg').value || 0);
      if ($('inpItmRng')) item.range = Math.max(1, +$('inpItmRng').value || 4);
      if ($('inpItmRad')) item.radius = Math.max(0.5, +$('inpItmRad').value || 2);
      if ($('inpItmKb')) item.knockback = Math.max(0, +$('inpItmKb').value || 8);
      if ($('inpItmCd')) item.cooldown = Math.max(0.05, +$('inpItmCd').value || 0.3);

      if ($('inpItmBlast')) item.blastRadius = Math.max(0, +$('inpItmBlast').value || 0);
      if ($('inpItmPrjSpd')) item.projSpeed = Math.max(2, +$('inpItmPrjSpd').value || 30);
      if ($('inpItmMaxRng')) item.maxRange = Math.max(5, +$('inpItmMaxRng').value || 65);
      if ($('inpItmGrav')) item.gravityFactor = Math.max(0, +$('inpItmGrav').value || 0);
      if ($('inpItmSprd')) item.spread = Math.max(0, +$('inpItmSprd').value || 0);
      if ($('inpItmAim')) item.canAim = $('inpItmAim').checked;
      if ($('inpItmInfAmmo')) item.infiniteAmmo = $('inpItmInfAmmo').checked;
      if ($('inpItmAuto')) item.autoFire = $('inpItmAuto').checked;
      if ($('inpItmMag')) {
        item.magSize = Math.max(1, +$('inpItmMag').value || 12);
        item.ammo = item.magSize;
      }
      if ($('inpItmRes')) item.reserveAmmo = Math.max(0, +$('inpItmRes').value || 0);
      if ($('inpItmRel')) item.reloadTime = Math.max(0.1, +$('inpItmRel').value || 1.2);
      if ($('inpItmStack')) item.stackCount = Math.max(1, +$('inpItmStack').value || 1);
      if ($('inpItmMinSpd')) item.minThrowSpeed = Math.max(1, +$('inpItmMinSpd').value || 8);
      if ($('inpItmChgT')) item.maxChargeTime = Math.max(0.2, +$('inpItmChgT').value || 1.1);

      if ($('inpItmHeal')) item.healAmount = +$('inpItmHeal').value || 0;
      if ($('inpItmBfSpd')) item.buffSpeed = +$('inpItmBfSpd').value || 0;
      if ($('inpItmBfJmp')) item.buffJump = +$('inpItmBfJmp').value || 0;
      if ($('inpItmBfDmg')) item.buffDamage = +$('inpItmBfDmg').value || 0;
      if ($('inpItmBfScl')) item.buffScale = +$('inpItmBfScl').value || 0;

      item.infiniteDurability = $('inpItmInfDur').checked;
      $('itmDurRows').hidden = item.infiniteDurability;
      item.dropOnHit = $('inpItmDropHit').checked;
      item.durability = Math.max(1, +$('inpItmDur').value || 100);
      item.maxDurability = Math.max(1, +$('inpItmMaxDur').value || 100);
      item.durabilityCostPerUse = Math.max(0, +$('inpItmDurCost').value || 0);
      item.passiveDecayPerSec = Math.max(0, +$('inpItmDecay').value || 0);
      item.fallDamageMult = Math.max(0, +$('inpItmFallMult').value || 0);

      item.equipStats.armorPct = clamp(+$('inpEqArmor').value || 0, 0, 90);
      item.equipStats.maxHpBonus = Math.max(0, +$('inpEqHp').value || 0);
      item.equipStats.damageBonus = +$('inpEqDmg').value || 0;
      item.equipStats.invulnerable = $('inpEqInv').checked;

      item.lightData.realLight = $('inpItmRealLgt').checked;
      item.lightData.pseudoLight = $('inpItmPseudoLgt').checked;
      item.lightData.enabled = Boolean(item.lightData.realLight || item.lightData.pseudoLight);
      if ($('itmGlobalLightRows')) $('itmGlobalLightRows').hidden = !item.lightData.enabled;
      if ($('inpItmLgtCol')) item.lightData.color = $('inpItmLgtCol').value;
      if ($('inpItmLgtInt')) item.lightData.intensity = Math.max(0.2, +$('inpItmLgtInt').value || 1.8);
      if ($('inpItmLgtDist')) item.lightData.distance = Math.max(2, +$('inpItmLgtDist').value || 16);

      item.particleData.enabled = $('inpItmEmitAll').checked;
      if ($('itmGlobalEmitRows')) $('itmGlobalEmitRows').hidden = !item.particleData.enabled;
      if ($('inpItmEmitPreset')) item.particleData.preset = $('inpItmEmitPreset').value;
      if ($('inpItmEmitCol')) item.particleData.color = $('inpItmEmitCol').value;
      if ($('inpItmEmitRate')) item.particleData.rate = Math.max(1, +$('inpItmEmitRate').value || 10);
      if ($('inpItmEmitSize')) item.particleData.sizeStart = Math.max(0.05, +$('inpItmEmitSize').value || 0.28);

      rebuildWorldItemVisual(worldEntry, true);
      syncLibraryItemIfEditing(selectedRef);
      syncItemStudioPreview();
    };

    if ($('btnPaintItmGlobalPt')) {
      $('btnPaintItmGlobalPt').onclick = () => {
        S.paintParticleScope = 'item';
        openPaintModal('particle');
      };
    }

    [
      'inpItmDmg', 'inpItmRng', 'inpItmRad', 'inpItmKb', 'inpItmCd',
      'inpItmBlast', 'inpItmPrjSpd', 'inpItmMaxRng', 'inpItmGrav', 'inpItmSprd',
      'inpItmAim', 'inpItmInfAmmo', 'inpItmAuto', 'inpItmMag', 'inpItmRes',
      'inpItmRel', 'inpItmStack', 'inpItmMinSpd', 'inpItmChgT',
      'inpItmHeal', 'inpItmBfSpd', 'inpItmBfJmp', 'inpItmBfDmg', 'inpItmBfScl',
      'inpItmInfDur', 'inpItmDropHit', 'inpItmDur', 'inpItmMaxDur', 'inpItmDurCost',
      'inpItmDecay', 'inpItmFallMult', 'inpEqArmor', 'inpEqHp', 'inpEqDmg', 'inpEqInv',
      'inpItmRealLgt', 'inpItmPseudoLgt', 'inpItmLgtCol', 'inpItmLgtInt', 'inpItmLgtDist',
      'inpItmEmitAll', 'inpItmEmitPreset', 'inpItmEmitCol', 'inpItmEmitRate', 'inpItmEmitSize'
    ].forEach(id => {
      if ($(id)) {
        $(id).oninput = syncStats;
        $(id).onchange = syncStats;
      }
    });

    $('btnSaveItemToLib').onclick = () => {
      if (isEditingFromLib) {
        syncLibraryItemIfEditing(selectedRef);
        sfx.cash();
        showBanner(`💾 Предмет «${item.name}» обновлён в Арсенале!`, '#00e676');
      } else {
        S.savedItemsLibrary.push(JSON.parse(JSON.stringify(item)));
        sfx.cash();
        showBanner(`⭐ «${item.name}» сохранён в Арсенал! Теперь его можно выдавать игроку и спавнить в 1 клик.`, '#00e676');
        renderInspectorUI();
      }
    };
    return;
  }

  // 3. ИНСПЕКТОР СОСТАВНОГО 3D-АКСЕССУАРА ИЛИ ПИТОМЦА (до 16 примитивов, без коллайдеров)
  if (selectedRef.kind === 'cosmetic') {
    const { ent, item, libIdx } = selectedRef;
    normalizeCosmeticItem(item);
    const partIdx = clamp(selectedRef.partIdx || 0, 0, item.parts.length - 1);
    const part = item.parts[partIdx];
    const isPet = item.parentSlot === 'pet';
    normalizePartEffects(part, isPet, false);
    const ptData = part.particleData;
    const isEditingFromLib = libIdx !== undefined && !!S.savedCosmeticsLibrary[libIdx];

    const partsChipsHTML = item.parts
      .map((pt, idx) => {
        const fx = (pt.realLight ? '💡' : (pt.pseudoLight ? '✨' : '')) + (pt.particleData?.enabled ? '🎆' : '');
        return `
        <button class="ed-btn ${idx === partIdx ? 'active' : ''}" data-selpt="${idx}" type="button" style="padding:4px 7px;font-size:10px">
          #${idx + 1} ${pt.name || pt.shape}${fx ? ' ' + fx : ''}
        </button>
      `;
      })
      .join('');

    cont.innerHTML = `
      <div class="prop-group">
        <h5>${isPet ? '🐾 Настройка 3D-Питомца' : '🎩 Настройка 3D-Аксессуара'}</h5>
        ${S.itemStudioOpen ? `
          <button class="ed-btn" id="btnCosExitStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:5px;background:rgba(255,179,0,0.16);border-color:#ffb300;color:#ffe082">📍 Вернуть камеру на карту (Выйти из 3D STUDIO)</button>
        ` : `
          <button class="ed-btn apply-oneclick" id="btnCosOpenStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:5px;background:rgba(86,240,255,0.16);border-color:#56f0ff;color:#56f0ff">🛠️ Открыть в 3D STUDIO</button>
        `}
        <div style="display:flex;gap:5px">
          <button class="ed-btn" id="btnBackToChar" type="button" style="flex:1">⬅ К персонажу (${ent.name})</button>
          <button class="ed-btn" id="btnUndoCosLocal" type="button" title="Отменить действие внутри этого аксессуара (Ctrl+Z)">↩️ Отмена</button>
        </div>
        ${isEditingFromLib ? `<div style="font-size:10px;color:#ffce3a">🛠️ Редактирование предмета из сохранённого Гардероба</div>` : ''}
        <div class="prop-row"><label>Название</label><input class="ed-inp" id="cosName" value="${item.name}"></div>
        <div class="prop-row">
          <label>Тип / Слот</label>
          <select class="ed-inp" id="cosSlot">
            <option value="pet" ${item.parentSlot === 'pet' ? 'selected' : ''}>🐾 Питомец (Pet — летает/следует)</option>
            <option value="head" ${item.parentSlot === 'head' ? 'selected' : ''}>🎩 Голова (Head)</option>
            <option value="torso" ${item.parentSlot === 'torso' ? 'selected' : ''}>👕 Торс / Спина (Torso)</option>
            <option value="armL" ${item.parentSlot === 'armL' ? 'selected' : ''}>💪 Левая рука (ArmL)</option>
            <option value="armR" ${item.parentSlot === 'armR' ? 'selected' : ''}>💪 Правая рука (ArmR)</option>
            <option value="legL" ${item.parentSlot === 'legL' ? 'selected' : ''}>👖 Левая нога (LegL)</option>
            <option value="legR" ${item.parentSlot === 'legR' ? 'selected' : ''}>👖 Правая нога (LegR)</option>
          </select>
        </div>
        <div style="font-size:10px;color:#69f0ae">✓ Изолированный Ctrl+Z: отмена меняет только этот аксессуар</div>
      </div>

      ${isPet ? `
        <div class="prop-group">
          <h5>🐾 Поведение Питомца</h5>
          <div class="prop-row">
            <label>Режим</label>
            <select class="ed-inp" id="inpPetBeh">
              <option value="orbit" ${item.petBehavior === 'orbit' ? 'selected' : ''}>🔄 Вращение вокруг игрока (Orbit)</option>
              <option value="follow" ${item.petBehavior === 'follow' ? 'selected' : ''}>🐾 Следование за игроком (Follow)</option>
            </select>
          </div>
          <div class="prop-row"><label>Дист. / Высота</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.2" min="0.8" max="10" class="ed-inp" id="inpPetDist" value="${item.petDistance ?? 2.2}" title="Радиус орбиты или дистанция следования">
            <input type="number" step="0.2" min="0" max="8" class="ed-inp" id="inpPetHeight" value="${item.petHeight ?? 1.5}" title="Высота над землёй">
          </div></div>
          <div class="prop-row"><label>Скорость</label><input type="number" step="0.2" min="0.2" max="15" class="ed-inp" id="inpPetSpd" value="${item.petSpeed ?? 2.4}"></div>
        </div>
      ` : ''}

      <div class="prop-group">
        <h5>🎨 Внешний вид (${item.parts.length} / ${MAX_COSMETIC_PARTS})</h5>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${partsChipsHTML}
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">
          <button class="ed-btn apply-oneclick" id="btnAddCosPart" type="button" style="flex:1">➕ Деталь</button>
          <button class="ed-btn icon-only" id="btnDupCosPart" type="button" title="Дублировать деталь">📋</button>
          <button class="ed-btn danger icon-only" id="btnDelCosPart" type="button" title="Удалить деталь">🗑️</button>
        </div>

        <div style="border-top:1px solid #262c3d;padding-top:6px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
          <div class="prop-row"><label>Деталь #${partIdx + 1}</label><input class="ed-inp" id="cosPartName" value="${part.name || ('Часть #' + (partIdx + 1))}"></div>
          <div class="prop-row">
            <label>Форма</label>
            <select class="ed-inp" id="cosShape">
              <option value="box" ${part.shape === 'box' ? 'selected' : ''}>Куб (Box)</option>
              <option value="sphere" ${part.shape === 'sphere' ? 'selected' : ''}>Сфера (Sphere)</option>
              <option value="cylinder" ${part.shape === 'cylinder' ? 'selected' : ''}>Цилиндр (Cylinder)</option>
              <option value="cone" ${part.shape === 'cone' ? 'selected' : ''}>Конус / Рог (Cone)</option>
              <option value="torus" ${part.shape === 'torus' ? 'selected' : ''}>Кольцо / Нимб (Torus)</option>
              <option value="plane" ${part.shape === 'plane' ? 'selected' : ''}>Плоскость / Крыло (Plane)</option>
            </select>
          </div>
          <div class="prop-row">
            <label>Цвет и Спрайт</label>
            <input type="color" class="ed-color" id="cosCol" value="${part.color || '#ffce3a'}">
            <button class="ed-btn" id="btnPaintCos" type="button" style="flex:1">🎨 Спрайт спереди</button>
            ${part.texDataURL ? `<button class="ed-btn danger" id="btnClearCosSpr" type="button" title="Убрать спрайт">✕</button>` : ''}
          </div>
          <div class="prop-row"><label>Позиция</label><div class="vec3">
            <input type="number" step="0.05" class="ed-inp" id="inpCosPX" value="${(part.x || 0).toFixed(2)}">
            <input type="number" step="0.05" class="ed-inp" id="inpCosPY" value="${(part.y || 0).toFixed(2)}">
            <input type="number" step="0.05" class="ed-inp" id="inpCosPZ" value="${(part.z || 0).toFixed(2)}">
          </div></div>
          <div class="prop-row"><label>Размер</label><div class="vec3">
            <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpCosSX" value="${(part.sx ?? 1).toFixed(2)}">
            <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpCosSY" value="${(part.sy ?? 1).toFixed(2)}">
            <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpCosSZ" value="${(part.sz ?? 1).toFixed(2)}">
          </div></div>
          <div class="prop-row"><label>Поворот°</label><div class="vec3">
            <input type="number" step="15" class="ed-inp" id="inpCosRX" value="${Math.round(THREE.MathUtils.radToDeg(part.rx || 0))}">
            <input type="number" step="15" class="ed-inp" id="inpCosRY" value="${Math.round(THREE.MathUtils.radToDeg(part.ry || 0))}">
            <input type="number" step="15" class="ed-inp" id="inpCosRZ" value="${Math.round(THREE.MathUtils.radToDeg(part.rz || 0))}">
          </div></div>

          <!-- Эффекты выбранной детали аксессуара: Настоящий свет, Псевдо-свет, Источать частицы -->
          <div style="margin-top:4px;padding-top:6px;border-top:1px dashed #283147;display:flex;flex-direction:column;gap:5px">
            <div style="font:800 9.5px var(--f);color:#94a3b8;text-transform:uppercase">Эффекты детали #${partIdx + 1}:</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
              <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
                <input type="checkbox" id="inpCosPtRealLgt" ${part.realLight ? 'checked' : ''}> 💡 Настоящий свет
              </label>
              <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
                <input type="checkbox" id="inpCosPtPseudoLgt" ${part.pseudoLight ? 'checked' : ''}> ✨ Псевдо-свет
              </label>
              <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#56f0ff;cursor:pointer">
                <input type="checkbox" id="inpCosPtEmit" ${ptData.enabled ? 'checked' : ''}> 🎆 Источать частицы
              </label>
            </div>

            <div id="cosPtLightRows" ${(part.realLight || part.pseudoLight) ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(255,213,79,0.06);padding:6px;border-radius:7px;border:1px solid rgba(255,213,79,0.28)">
              <div class="prop-row">
                <label>Цвет / Яркость</label>
                <input type="color" class="ed-color" id="inpCosPtLCol" value="${part.lightColor || part.color || '#ffce3a'}">
                <input type="number" step="0.2" min="0.2" max="5" class="ed-inp" id="inpCosPtLInt" value="${part.lightIntensity ?? 1.4}" style="width:65px" title="Яркость свечения">
                <label style="flex:1;text-align:right">Радиус</label>
                <input type="number" step="1" min="2" max="50" class="ed-inp" id="inpCosPtLDist" value="${part.lightDistance ?? 12}" style="width:60px" title="Радиус настоящего света">
              </div>
            </div>

            <div id="cosPtEmitRows" ${ptData.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(86,240,255,0.06);padding:6px;border-radius:7px;border:1px solid rgba(86,240,255,0.28)">
              <div class="prop-row">
                <label>Частица 16×16</label>
                <select class="ed-inp" id="inpCosPtPreset" style="flex:1">
                  <option value="spark" ${ptData.preset === 'spark' ? 'selected' : ''}>💠 Искра (Spark)</option>
                  <option value="fire" ${ptData.preset === 'fire' ? 'selected' : ''}>🔥 Огонь (Fire)</option>
                  <option value="heart" ${ptData.preset === 'heart' ? 'selected' : ''}>❤️ Сердечко (Heart)</option>
                  <option value="star" ${ptData.preset === 'star' ? 'selected' : ''}>⭐ Звезда (Star)</option>
                  <option value="smoke" ${ptData.preset === 'smoke' ? 'selected' : ''}>💨 Дым (Smoke)</option>
                  <option value="hit" ${ptData.preset === 'hit' ? 'selected' : ''}>💥 Всплеск (Hit)</option>
                  <option value="custom" ${ptData.preset === 'custom' ? 'selected' : ''}>🎨 Свой 16×16</option>
                </select>
                <button class="ed-btn apply-oneclick" id="btnPaintCosPtSpr" type="button">🖌️ 16×16</button>
              </div>
              <div class="prop-row">
                <label>Оттенок и Кол/с</label>
                <input type="color" class="ed-color" id="inpCosPtPCol" value="${ptData.color || '#ffffff'}">
                <input type="number" min="1" max="60" step="1" class="ed-inp" id="inpCosPtPRate" value="${ptData.rate ?? 10}" style="width:70px" title="Частиц в секунду">
              </div>
              <div class="prop-row">
                <label>Размер / Скор. / Y</label>
                <div class="vec3">
                  <input type="number" step="0.05" min="0.05" max="3" class="ed-inp" id="inpCosPtPSize" value="${ptData.sizeStart ?? 0.28}" title="Размер частицы">
                  <input type="number" step="0.2" min="0" max="20" class="ed-inp" id="inpCosPtPSpd" value="${ptData.speed ?? 1.6}" title="Скорость разлёта">
                  <input type="number" step="0.5" class="ed-inp" id="inpCosPtPGrav" value="${ptData.gravity ?? 1.5}" title="Движение по Y">
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <button class="ed-btn apply-oneclick" id="btnSaveCosLib" type="button" style="justify-content:center;padding:8px">
        ${isEditingFromLib ? '💾 Обновить предмет в Гардеробе' : `⭐ Сохранить ${isPet ? 'питомца' : 'аксессуар'} в Гардероб`}
      </button>
    `;

    const rebuildAndReselect = (newPartIdx = partIdx) => {
      syncLibraryItemIfEditing(selectedRef);
      ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
      attachRigToEntity(ent);
      const newGroup = ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === item);
      selectEditorObject(
        {
          kind: 'cosmetic',
          ent,
          item,
          group: newGroup,
          partIdx: clamp(newPartIdx, 0, item.parts.length - 1),
          inWorldPlacement: Boolean(selectedRef.inWorldPlacement),
          libIdx
        },
        true
      );
      if (S.itemStudioOpen) {
        syncItemStudioPreview();
      }
    };

    if ($('btnCosOpenStudio3D')) {
      $('btnCosOpenStudio3D').onclick = () => {
        selectedRef.inWorldPlacement = false;
        selectEditorObject(selectedRef, true);
        openItemStudio3D(selectedRef);
        renderInspectorUI();
      };
    }
    if ($('btnCosExitStudio3D')) {
      $('btnCosExitStudio3D').onclick = () => {
        closeItemStudio3D(true);
        renderInspectorUI();
      };
    }

    $('btnBackToChar').onclick = () => {
      syncLibraryItemIfEditing(selectedRef);
      closeItemStudio3D(false);
      selectEditorObject({ kind: 'char', ent });
    };
    $('btnUndoCosLocal').onclick = () => undoLastCosmeticAction();
    $('cosName').oninput = e => {
      item.name = e.target.value;
      if ($('itemStudioSubjectTitle') && S.itemStudioOpen) {
        $('itemStudioSubjectTitle').textContent = `${isPet ? '🐾' : '🎩'} 3D STUDIO: ${item.name || 'Аксессуар'}`;
      }
      syncLibraryItemIfEditing(selectedRef);
    };
    $('cosSlot').onchange = e => {
      const targetSlot = e.target.value;
      if (item.enabled !== false && countActiveItemsInSlot(ent, targetSlot, item) >= MAX_ACTIVE_PER_SLOT) {
        item.enabled = false;
        showBanner(`Слот «${SLOT_LABELS_RU[targetSlot] || targetSlot}» уже занят (${MAX_ACTIVE_PER_SLOT}/${MAX_ACTIVE_PER_SLOT}) — предмет переведён в 🔴`, '#ffce3a');
      }
      pushCosmeticUndoState('Смена слота аксессуара');
      item.parentSlot = targetSlot;
      rebuildAndReselect(partIdx);
    };

    if (isPet) {
      $('inpPetBeh').onchange = e => {
        pushCosmeticUndoState('Смена режима питомца');
        item.petBehavior = e.target.value;
        syncLibraryItemIfEditing(selectedRef);
      };
      $('inpPetDist').oninput = e => {
        item.petDistance = clamp(+e.target.value || 2.2, 0.8, 12);
        syncLibraryItemIfEditing(selectedRef);
      };
      $('inpPetHeight').oninput = e => {
        item.petHeight = clamp(+e.target.value || 1.5, -2, 10);
        syncLibraryItemIfEditing(selectedRef);
      };
      $('inpPetSpd').oninput = e => {
        item.petSpeed = clamp(+e.target.value || 2.4, 0.2, 15);
        syncLibraryItemIfEditing(selectedRef);
      };
    }

    cont.querySelectorAll('[data-selpt]').forEach(btn => {
      btn.onclick = () => {
        rebuildAndReselect(+btn.dataset.selpt);
      };
    });

    $('btnAddCosPart').onclick = () => {
      if (item.parts.length >= MAX_COSMETIC_PARTS) {
        showBanner(`Максимум ${MAX_COSMETIC_PARTS} деталей на один аксессуар/питомца!`, '#ff3e3e');
        return;
      }
      pushCosmeticUndoState('Добавление детали');
      item.parts.push(normalizePartEffects({
        id: 'pt_' + Date.now(),
        name: `Деталь #${item.parts.length + 1}`,
        shape: 'box',
        x: 0,
        y: (part.y || 0) + 0.25,
        z: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        sx: 0.45,
        sy: 0.45,
        sz: 0.45,
        color: '#56f0ff',
        texDataURL: null
      }, isPet, false));
      sfx.jump();
      rebuildAndReselect(item.parts.length - 1);
    };

    $('btnDupCosPart').onclick = () => {
      if (item.parts.length >= MAX_COSMETIC_PARTS) {
        showBanner(`Максимум ${MAX_COSMETIC_PARTS} деталей на один аксессуар/питомца!`, '#ff3e3e');
        return;
      }
      pushCosmeticUndoState('Дублирование детали');
      const copyP = normalizePartEffects(Object.assign({}, JSON.parse(JSON.stringify(part)), {
        id: 'pt_' + Date.now(),
        name: (part.name || 'Часть') + '_Копия',
        x: (part.x || 0) + 0.18
      }), isPet, false);
      item.parts.push(copyP);
      sfx.jump();
      rebuildAndReselect(item.parts.length - 1);
    };

    $('btnDelCosPart').onclick = () => {
      if (item.parts.length > 1) {
        pushCosmeticUndoState('Удаление детали');
        item.parts.splice(partIdx, 1);
        sfx.oof();
        rebuildAndReselect(Math.max(0, partIdx - 1));
      } else {
        S.selectedRef = { kind: 'char', ent };
        pushUndoState('Удаление аксессуара');
        const arr = ent.preset.customCosmetics || [];
        const idx = arr.indexOf(item);
        if (idx >= 0) arr.splice(idx, 1);
        ent.rig.syncCustomCosmetics(arr);
        attachRigToEntity(ent);
        closeItemStudio3D(false);
        selectEditorObject({ kind: 'char', ent });
        sfx.oof();
      }
    };

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

    // События свечения и частиц детали аксессуара
    $('inpCosPtRealLgt').onchange = e => {
      pushCosmeticUndoState('Настоящий свет детали аксессуара');
      part.realLight = e.target.checked;
      if (part.realLight && !part.lightColor) part.lightColor = part.color || '#ffce3a';
      rebuildAndReselect(partIdx);
    };
    $('inpCosPtPseudoLgt').onchange = e => {
      pushCosmeticUndoState('Псевдо-свет детали аксессуара');
      part.pseudoLight = e.target.checked;
      if (part.pseudoLight && !part.lightColor) part.lightColor = part.color || '#ffce3a';
      rebuildAndReselect(partIdx);
    };
    $('inpCosPtEmit').onchange = e => {
      pushCosmeticUndoState('Частицы детали аксессуара');
      ptData.enabled = e.target.checked;
      rebuildAndReselect(partIdx);
    };
    if ($('inpCosPtLCol')) {
      $('inpCosPtLCol').oninput = e => {
        part.lightColor = e.target.value;
        rebuildAndReselect(partIdx);
      };
    }
    if ($('inpCosPtLInt')) {
      $('inpCosPtLInt').oninput = e => {
        part.lightIntensity = Math.max(0.2, +e.target.value || 1.4);
        rebuildAndReselect(partIdx);
      };
    }
    if ($('inpCosPtLDist')) {
      $('inpCosPtLDist').oninput = e => {
        part.lightDistance = Math.max(2, +e.target.value || 12);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpCosPtPreset')) {
      $('inpCosPtPreset').onchange = e => {
        ptData.preset = e.target.value;
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('btnPaintCosPtSpr')) {
      $('btnPaintCosPtSpr').onclick = () => {
        S.paintParticleScope = 'part';
        openPaintModal('particle');
      };
    }
    if ($('inpCosPtPCol')) {
      $('inpCosPtPCol').oninput = e => {
        ptData.color = e.target.value;
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpCosPtPRate')) {
      $('inpCosPtPRate').oninput = e => {
        ptData.rate = Math.max(1, +e.target.value || 10);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpCosPtPSize')) {
      $('inpCosPtPSize').oninput = e => {
        ptData.sizeStart = Math.max(0.05, +e.target.value || 0.28);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpCosPtPSpd')) {
      $('inpCosPtPSpd').oninput = e => {
        ptData.speed = Math.max(0, +e.target.value || 1.6);
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
      };
    }
    if ($('inpCosPtPGrav')) {
      $('inpCosPtPGrav').oninput = e => {
        ptData.gravity = +e.target.value || 0;
        syncLibraryItemIfEditing(selectedRef);
        syncItemStudioPreview();
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
          showBanner(`👟 Блок стал Нажимной Плитой!`, '#ffce3a');
        } else if (role === 'portal') {
          if (!lg.tag) lg.tag = 'tp_' + box.id.replace('blk_', '');
          lg.trigger = 'touch';
          lg.action = 'teleport';
          lg.targetTag = existingTags.find(t => t.startsWith('tp_')) || '';
          lg.tpX = 0;
          lg.tpY = 8;
          lg.tpZ = 0;
          lg.cost = 0;
          lg.showBadge = true;
          lg.promptText = `🌀 Телепорт`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Телепорт (#${lg.tag})`;
          showBanner(`🌀 Блок превращён в Телепорт!`, '#56f0ff');
        } else if (role === 'vip_door') {
          if (!lg.tag) lg.tag = 'vip_' + box.id.replace('blk_', '');
          lg.trigger = 'keyE';
          lg.action = 'door_ghost';
          lg.targetTag = '';
          lg.cost = 100;
          lg.oneTimeBuy = true;
          lg.stayTime = 0;
          lg.showBadge = true;
          lg.promptText = `🔓 Открыть проход [E]`;
          if (box.label.startsWith('Лего-Блок')) box.label = `VIP-Барьер (100 R$)`;
          showBanner(`🔓 Блок стал Платным VIP-Проходом за 100 R$!`, '#ffce3a');
        } else if (role === 'shop') {
          lg.trigger = 'keyE';
          lg.action = 'buy_perk';
          lg.perkType = 'speed';
          lg.cost = 80;
          lg.oneTimeBuy = true;
          lg.showBadge = true;
          lg.promptText = `🛒 Купить Перк [E]`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Магазин Перков`;
          showBanner(`🛒 Блок стал Магазином Перков за R$!`, '#00e676');
        } else if (role === 'clicker') {
          lg.trigger = 'keyE';
          lg.action = 'give_cash';
          lg.rewardCash = 25;
          lg.cost = 0;
          lg.cooldown = 0.8;
          lg.showBadge = true;
          lg.promptText = `🪙 Получить +25 R$ [E]`;
          if (box.label.startsWith('Лего-Блок')) box.label = `Кнопка +25 R$`;
          showBanner(`🪙 Блок стал Кнопкой выдачи R$!`, '#ffce3a');
        }

        sfx.coil();
        syncBlockSpecialVisuals(box);
        refreshHierarchyUI();
        renderInspectorUI();
      };
    });

    if ($('btnResetRole')) {
      $('btnResetRole').onclick = () => {
        pushUndoState('Сброс логики блока');
        box.logicData = createDefaultLogicData();
        syncBlockSpecialVisuals(box);
        refreshHierarchyUI();
        renderInspectorUI();
      };
    }

    if ($('selExistingTag')) {
      $('selExistingTag').onchange = e => {
        const val = e.target.value;
        if (!val) return;
        $('inpLgTarget').value = val === '__self__' ? '' : val;
        lg.targetTag = $('inpLgTarget').value;
        syncBlockSpecialVisuals(box);
        refreshHierarchyUI();
      };
    }

    if ($('btnPreviewDoorMove')) {
      $('btnPreviewDoorMove').onclick = () => {
        const base = (box.logicRuntime && box.logicRuntime.basePos) ? box.logicRuntime.basePos.clone() : box.m.position.clone();
        if (box.logicRuntime) box.logicRuntime.basePos = base.clone();
        const mx = Number(lg.moveX) || 0;
        const my = Number(lg.moveY) ?? 5;
        const mz = Number(lg.moveZ) || 0;

        sfx.gate();
        box.m.position.set(base.x + mx, base.y + my, base.z + mz);
        updateBlockOBB(box);
        if (box.cpVisualGroup) box.cpVisualGroup.position.copy(box.m.position);
        selBoxHelper.setFromObject(box.m);

        setTimeout(() => {
          if (!box || !box.m) return;
          box.m.position.copy(base);
          updateBlockOBB(box);
          if (box.cpVisualGroup) box.cpVisualGroup.position.copy(box.m.position);
          if (S.selectedRef && S.selectedRef.box === box) selBoxHelper.setFromObject(box.m);
        }, 1200);
      };
    }

    const syncLogicUI = (rerender = false) => {
      lg.tag = ($('inpLgTag').value || '').trim();
      lg.trigger = $('inpLgTrig').value;
      lg.action = $('inpLgAct').value;
      lg.targetTag = ($('inpLgTarget').value || '').trim();
      lg.cost = Math.max(0, +$('inpLgCost').value || 0);
      lg.oneTimeBuy = $('inpLgOneTime').checked;
      lg.unlocked = false;

      if (lg.action === 'door_slide') {
        lg.moveX = +$('inpLgMX').value || 0;
        lg.moveY = +$('inpLgMY').value || 0;
        lg.moveZ = +$('inpLgMZ').value || 0;
        lg.speed = Math.max(0.5, +$('inpLgSpd').value || 4.5);
        lg.stayTime = Math.max(0, +$('inpLgStay').value || 0);
      } else if (lg.action === 'door_ghost') {
        lg.stayTime = Math.max(0, +$('inpLgGhostStay').value || 0);
      } else if (lg.action === 'teleport') {
        lg.tpX = +$('inpLgTpX').value || 0;
        lg.tpY = +$('inpLgTpY').value || 6;
        lg.tpZ = +$('inpLgTpZ').value || 0;
      } else if (lg.action === 'buy_perk') {
        lg.perkType = $('inpLgPerk').value;
      } else if (lg.action === 'give_cash') {
        lg.rewardCash = Math.max(1, +$('inpLgReward').value || 25);
      }

      lg.cooldown = Math.max(0.2, +$('inpLgCd').value || 1.0);
      lg.showBadge = $('inpLgBadge').checked;
      lg.promptText = $('inpLgPrompt').value;

      syncBlockSpecialVisuals(box);
      refreshHierarchyUI();
      if (rerender) renderInspectorUI();
    };

    $('inpLgTrig').onchange = () => {
      pushUndoState('Настройка триггера Bricks Logic');
      syncLogicUI(true);
    };
    $('inpLgAct').onchange = () => {
      pushUndoState('Смена действия Bricks Logic');
      syncLogicUI(true);
    };
    [
      'inpLgTag', 'inpLgTarget', 'inpLgCost', 'inpLgOneTime',
      'inpLgMX', 'inpLgMY', 'inpLgMZ', 'inpLgSpd', 'inpLgStay',
      'inpLgGhostStay', 'inpLgTpX', 'inpLgTpY', 'inpLgTpZ',
      'inpLgPerk', 'inpLgReward', 'inpLgCd', 'inpLgBadge', 'inpLgPrompt'
    ].forEach(id => {
      const el = $(id);
      if (el) el.oninput = () => syncLogicUI(false);
    });

    if ($('btnLgCaptureCamPos')) {
      $('btnLgCaptureCamPos').onclick = () => {
        lg.tpX = Math.round(S.edCamPos.x * 10) / 10;
        lg.tpY = Math.round(S.edCamPos.y * 10) / 10;
        lg.tpZ = Math.round(S.edCamPos.z * 10) / 10;
        $('inpLgTpX').value = lg.tpX;
        $('inpLgTpY').value = lg.tpY;
        $('inpLgTpZ').value = lg.tpZ;
        showBanner(`📍 Координаты телепорта: (${lg.tpX}, ${lg.tpY}, ${lg.tpZ})`, '#56f0ff');
      };
    }

    $('inpLightMode').onchange = e => {
      pushUndoState('Смена режима свечения блока');
      ld.mode = e.target.value;
      if (!ld.color) ld.color = box.colorHex;
      syncBlockLightVisuals(box);
      renderInspectorUI();
    };
    $('inpLightCol').onfocus = () => pushUndoState('Смена цвета свечения');
    $('inpLightCol').oninput = e => {
      ld.color = e.target.value;
      syncBlockLightVisuals(box);
    };
    $('btnLightMatchBlk').onclick = () => {
      pushUndoState('Цвет свечения в цвет блока');
      ld.color = box.colorHex;
      $('inpLightCol').value = box.colorHex;
      syncBlockLightVisuals(box);
    };
    $('inpLightInt').oninput = e => {
      ld.intensity = clamp(+e.target.value || 1.2, 0.1, 5.0);
      $('txtLightInt').textContent = ld.intensity.toFixed(1);
      syncBlockLightVisuals(box);
    };
    $('inpLightDist').oninput = e => {
      ld.distance = clamp(+e.target.value || 14, 2, 80);
    };
    $('inpLightPulse').oninput = e => {
      ld.pulseSpeed = clamp(+e.target.value || 0, 0, 5);
      $('txtLightPulse').textContent = ld.pulseSpeed.toFixed(1);
      syncBlockLightVisuals(box);
    };

    const syncPt = () => {
      pd.enabled = $('inpPtOn').checked;
      $('ptFields').hidden = !pd.enabled;
      pd.preset = $('inpPtPreset').value;
      if (pd.preset !== 'custom') pd.texDataURL = null;
      pd.color = $('inpPtCol').value;
      pd.fadeOut = $('inpPtFade').checked;
      pd.rate = clamp(+$('inpPtRate').value || 12, 1, 120);
      pd.lifetime = clamp(+$('inpPtLife').value || 1.5, 0.2, 10);
      pd.sizeStart = Math.max(0.05, +$('inpPtS0').value || 0.4);
      pd.sizeEnd = Math.max(0, +$('inpPtS1').value || 0);
      pd.speed = Math.max(0, +$('inpPtSpd').value || 3);
      pd.spread = Math.max(0, +$('inpPtSpr').value || 0.5);
      pd.dirX = +$('inpPtDX').value || 0;
      pd.dirY = +$('inpPtDY').value || 0;
      pd.dirZ = +$('inpPtDZ').value || 0;
      pd.gravity = +$('inpPtGrav').value || 0;
      pd.rotSpeed = +$('inpPtRot').value || 0;
      pd.flicker = +$('inpPtFlk').value || 0;
    };
    [
      'inpPtOn', 'inpPtPreset', 'inpPtCol', 'inpPtFade',
      'inpPtRate', 'inpPtLife', 'inpPtS0', 'inpPtS1',
      'inpPtSpd', 'inpPtSpr', 'inpPtDX', 'inpPtDY',
      'inpPtDZ', 'inpPtGrav', 'inpPtRot', 'inpPtFlk'
    ].forEach(id => $(id).oninput = syncPt);
    $('btnPaintParticle').onclick = () => openPaintModal('particle');

    const applyVec = () => {
      box.m.position.set(+$('inpPX').value || 0, +$('inpPY').value || 0, +$('inpPZ').value || 0);
      if (box.logicRuntime) box.logicRuntime.basePos = box.m.position.clone();
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
      box.m.updateMatrixWorld(true);
      rebuildPhysicsArrays();
      selBoxHelper.setFromObject(box.m);
    };
    ['inpPX', 'inpPY', 'inpPZ', 'inpSX', 'inpSY', 'inpSZ', 'inpRX', 'inpRY', 'inpRZ', 'inpCX', 'inpCY', 'inpCZ'].forEach(id => {
      $(id).onfocus = () => pushUndoState('Трансформация блока');
      $(id).oninput = applyVec;
    });

    $('inpDmg').oninput = e => {
      box.damageOnContact = Math.max(0, +e.target.value || 0);
      syncBlockLightVisuals(box);
    };
    $('inpTpCp').onchange = e => {
      box.teleportToCheckpoint = e.target.checked;
    };
    $('inpBounce').oninput = e => {
      box.bounciness = Math.max(0, +e.target.value || 0);
    };
    $('inpConvZ').oninput = e => {
      box.conveyorVz = +e.target.value || 0;
    };
    $('inpConvX').oninput = e => {
      box.conveyorVx = +e.target.value || 0;
    };
    $('inpSpin').oninput = e => {
      box.spinSpeed = +e.target.value || 0;
    };

    const syncCp = () => {
      cd.enabled = $('inpCpOn').checked;
      $('cpFields').hidden = !cd.enabled;
      cd.stage = +$('inpCpStg').value || 1;
      cd.title = $('inpCpTitle').value || 'Чекпоинт';
      cd.rewardCash = +$('inpCpCash').value || 50;
      cd.skipSpots = +$('inpCpSkip').value || 2;
      syncBlockSpecialVisuals(box);
      refreshHierarchyUI();
    };
    ['inpCpOn', 'inpCpStg', 'inpCpTitle', 'inpCpCash', 'inpCpSkip'].forEach(id => $(id).oninput = syncCp);

    $('inpSpMode').onchange = e => {
      sd.mode = e.target.value;
      sd.timer = sd.interval;
    };
    $('inpSpType').onchange = e => {
      sd.spawnType = e.target.value;
    };
    $('inpSpInt').oninput = e => {
      sd.interval = Math.max(0.5, +e.target.value || 5);
      sd.timer = sd.interval;
    };
    return;
  }

  // 5. ИНСПЕКТОР ИГРОКА ИЛИ NPC (включая Хотбар, Арсенал и Точки Хвата 1 и 2 руками)
  if (selectedRef.kind === 'char') {
    const ent = selectedRef.ent;
    const rig = ent.rig;
    const charEditMode = selectedRef.editMode || 'root';
    normalizeCharacterGripPoints(ent.preset);
    const hpPt = ent.preset.handGripPoint;
    const cpPt = ent.preset.carryGripPoint;
    const hexOf = m => '#' + (m.userData.baseColor ? new THREE.Color(m.userData.baseColor).getHexString() : m.color.getHexString());

    const customList = ent.preset.customCosmetics || [];

    const customCosHTML = customList.map((c, idx) => {
      normalizeCosmeticItem(c);
      const isPet = c.parentSlot === 'pet';
      const isOn = c.enabled !== false;
      const ico = isPet ? '🐾' : '🎩';
      const slotNameRu = SLOT_LABELS_RU[c.parentSlot] || c.parentSlot;
      const subTxt = isPet ? (c.petBehavior === 'follow' ? 'Следует' : 'Орбита') : slotNameRu;
      return `
        <div style="display:flex;align-items:center;gap:4px">
          <div class="cos-chip ${isOn ? 'on' : ''}" data-ctoggle="${idx}" style="flex:1;justify-content:space-between;cursor:pointer" title="Включить / выключить">
            <span style="overflow:hidden;text-overflow:ellipsis">${isOn ? '🟢' : '🔴'} ${ico} ${c.name}</span>
            <small style="color:#8fa0bd;font-size:9.5px;flex-shrink:0">${subTxt}</small>
          </div>
          <button class="ed-btn icon-only" data-cedit="${idx}" type="button" title="Редактировать аксессуар в 3D">🛠️</button>
          <button class="ed-btn danger icon-only" data-cdel="${idx}" type="button" title="Удалить предмет">🗑️</button>
        </div>
      `;
    }).join('');

    const libHTML = S.savedCosmeticsLibrary.map((c, idx) => {
      normalizeCosmeticItem(c);
      const isPet = c.parentSlot === 'pet';
      const ico = isPet ? '🐾' : '🎩';
      const slotNameRu = SLOT_LABELS_RU[c.parentSlot] || c.parentSlot;
      return `
        <div style="display:flex;align-items:center;gap:4px">
          <button class="ed-btn" data-libidx="${idx}" type="button" style="flex:1;justify-content:space-between;overflow:hidden">
            <span style="overflow:hidden;text-overflow:ellipsis">➕ ${ico} ${c.name}</span>
            <small style="color:#8fa0bd;font-size:9.5px">${slotNameRu}</small>
          </button>
          <button class="ed-btn icon-only" data-libedit="${idx}" type="button" title="Редактировать в 3D">🛠️</button>
          <button class="ed-btn danger icon-only" data-libdel="${idx}" type="button" title="Удалить">🗑️</button>
        </div>
      `;
    }).join('');

    const invSlotsHTML = ent.isP && Array.isArray(ent.inventory)
      ? ent.inventory.map((it, sIdx) => {
          if (!it) return `<div style="font-size:10px;color:#64748b">Слот #${sIdx + 1}: Пусто</div>`;
          return `
            <div style="display:flex;align-items:center;justify-content:space-between;gap:4px;background:rgba(15,20,32,0.7);padding:3px 6px;border-radius:6px">
              <span style="font-size:10.5px;color:#fff">#${sIdx + 1} ${it.icon || '🗡️'} ${it.name}</span>
              <button class="ed-btn danger icon-only" data-clrslot="${sIdx}" type="button" title="Очистить слот">✕</button>
            </div>
          `;
        }).join('')
      : '';

    const itemsLibHTML = (S.savedItemsLibrary || []).map((it, idx) => {
      normalizeItemData(it);
      return `
        <div style="display:flex;align-items:center;gap:4px">
          <button class="ed-btn" data-giveitm="${idx}" type="button" style="flex:1;justify-content:space-between;overflow:hidden" title="Выдать в руки / хотбар">
            <span style="overflow:hidden;text-overflow:ellipsis">🎒 ${it.icon || '🗡️'} ${it.name}</span>
            <small style="color:#ffce3a;font-size:9.5px">${it.useType}</small>
          </button>
          <button class="ed-btn icon-only" data-spawnitm="${idx}" type="button" title="Заспавнить рядом в мире для редактирования">🌍</button>
          <button class="ed-btn danger icon-only" data-delitm="${idx}" type="button" title="Удалить из Арсенала">🗑️</button>
        </div>
      `;
    }).join('');

    const slotCountsSummary = ['head', 'torso', 'pet', 'armL', 'armR', 'legL', 'legR']
      .map(sl => `${SLOT_LABELS_RU[sl]}: ${countActiveItemsInSlot(ent, sl)}/${MAX_ACTIVE_PER_SLOT}`)
      .join(' · ');

    cont.innerHTML = `
      <div class="prop-group">
        <div style="display:flex;gap:6px;margin-bottom:8px">
          <button class="ed-btn ${S.itemStudioOpen ? 'active' : ''}" id="btnCharOpenStudio3D" type="button" style="flex:1;justify-content:center" title="Открыть персонажа в изолированной 3D Студии">🛠️ 3D Студия</button>
          <button class="ed-btn ${!S.itemStudioOpen ? 'active' : ''}" id="btnCharPlaceInWorld" type="button" style="flex:1;justify-content:center" title="Редактировать персонажа на карте мира">📍 На карте</button>
        </div>
        <h5>👤 Персонаж и Здоровье (HP)</h5>
        <div class="prop-row"><label>Никнейм</label><input class="ed-inp" id="inpCharName" value="${ent.name}"></div>
        <div class="prop-row"><label>Чат-баббл</label><input class="ed-inp" id="inpCharChat" value="${ent.chat || ''}"></div>
        <div class="prop-row">
          <label>Здоровье ${ent.hpEnabled ? '🟢' : '🔴'}</label>
          <input type="checkbox" id="inpHpOn" ${ent.hpEnabled ? 'checked' : ''}>
          <input type="number" step="10" min="1" class="ed-inp" id="inpHpVal" value="${Math.ceil(ent.hp)}" style="width:60px">
          <span>/</span>
          <input type="number" step="10" min="10" class="ed-inp" id="inpMaxHp" value="${ent.maxHp}" style="width:60px">
        </div>
        <div class="prop-row"><label>Урон руки</label><input type="number" step="5" min="0" class="ed-inp" id="inpMeleeDmg" value="${ent.meleeDamage || 20}"></div>
        ${!ent.isP ? `
          <div class="prop-row"><label>Поведение</label>
            <label style="flex:1"><input type="checkbox" id="inpCharWander" ${ent.wander ? 'checked' : ''}> Гуляет</label>
            <label style="flex:1"><input type="checkbox" id="inpCharAggr" ${ent.aggressive ? 'checked' : ''}> 🥊 Драчун (Бьёт)</label>
          </div>
        ` : ''}
      </div>

      ${ent.isP ? `
        <div class="prop-group" style="border-color:#ff9f43">
          <h5>🎒 Хотбар Игрока и Сохранённый Арсенал</h5>
          <div style="display:flex;flex-direction:column;gap:3px">${invSlotsHTML}</div>
          ${itemsLibHTML ? `<div style="font-size:10px;color:#ffce3a;margin-top:5px">Сохранённый Арсенал (🎒 — выдать, 🌍 — в мир):</div><div style="display:flex;flex-direction:column;gap:4px">${itemsLibHTML}</div>` : `<div style="font-size:10px;color:#8fa0bd;margin-top:4px">Создай оружие в левой панели и сохрани его в Арсенал!</div>`}
        </div>
      ` : ''}

      <div class="prop-group" style="border-color:#00e676">
        <h5>🖐️ Точки Хвата Персонажа (1 Рука и 2 Руки)</h5>
        <div style="font-size:10px;color:#8fa0bd;margin-bottom:4px">
          Переключи режим 3D-Гизмо или кликни по сквозному X-Ray маркеру на персонаже:
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px">
          <button class="ed-btn ${charEditMode === 'root' ? 'active' : ''}" id="btnChModeRoot" type="button" style="justify-content:center;font-size:10px">📍 Персонаж</button>
          <button class="ed-btn ${charEditMode === 'hand_grip' ? 'active' : ''}" id="btnChModeHand" type="button" style="justify-content:center;font-size:10px">🟢 1 Рука</button>
          <button class="ed-btn ${charEditMode === 'carry_grip' ? 'active' : ''}" id="btnChModeCarry" type="button" style="justify-content:center;font-size:10px">🟠 2 Руки</button>
        </div>

        <div style="font-size:10px;color:#00e676;margin-top:5px">🟢 1 Рука (Ладонь правой руки — сокет оружия):</div>
        <div class="prop-row"><label>Позиция 1Р</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip1X" value="${(hpPt.x || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip1Y" value="${(hpPt.y || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip1Z" value="${(hpPt.z || 0).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот° 1Р</label><div class="vec3">
          <input type="number" step="15" class="ed-inp" id="inpChGrip1RX" value="${Math.round(THREE.MathUtils.radToDeg(hpPt.rx || 0))}">
          <input type="number" step="15" class="ed-inp" id="inpChGrip1RY" value="${Math.round(THREE.MathUtils.radToDeg(hpPt.ry || 0))}">
          <input type="number" step="15" class="ed-inp" id="inpChGrip1RZ" value="${Math.round(THREE.MathUtils.radToDeg(hpPt.rz || 0))}">
        </div></div>

        <div style="font-size:10px;color:#ff9f43;margin-top:5px">🟠 2 Руки (Перед грудью — сокет контейнеров):</div>
        <div class="prop-row"><label>Позиция 2Р</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip2X" value="${(cpPt.x || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip2Y" value="${(cpPt.y || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip2Z" value="${(cpPt.z || 0).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот° 2Р</label><div class="vec3">
          <input type="number" step="15" class="ed-inp" id="inpChGrip2RX" value="${Math.round(THREE.MathUtils.radToDeg(cpPt.rx || 0))}">
          <input type="number" step="15" class="ed-inp" id="inpChGrip2RY" value="${Math.round(THREE.MathUtils.radToDeg(cpPt.ry || 0))}">
          <input type="number" step="15" class="ed-inp" id="inpChGrip2RZ" value="${Math.round(THREE.MathUtils.radToDeg(cpPt.rz || 0))}">
        </div></div>

        <button class="ed-btn" id="btnResetCharGrips" type="button" style="justify-content:center;margin-top:4px;font-size:10px">
          🔄 Сбросить точки хвата по умолчанию
        </button>
      </div>

      <div class="prop-group">
        <h5>📐 Коллайдер и Физика Персонажа</h5>
        <div class="prop-row"><label>Масштаб 3D</label><input type="number" step="0.1" min="0.4" max="5" class="ed-inp" id="inpCharScale" value="${rig.g.scale.x.toFixed(1)}"></div>
        <div class="prop-row"><label>Коллайдер Ш/В</label><div class="vec3" style="grid-template-columns:1fr 1fr">
          <input type="number" step="0.05" min="0.2" class="ed-inp" id="inpColR" value="${ent.colliderRadius || 0.42}">
          <input type="number" step="0.1" min="1.0" class="ed-inp" id="inpColH" value="${ent.colliderHeight || 2.5}">
        </div></div>
        ${ent.isP ? `
          <div class="prop-row"><label>Бег / Прыжок</label><div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="0.5" min="2" class="ed-inp" id="inpWalkSpd" value="${ent.walkSpeed || 7.6}">
            <input type="number" step="0.5" min="4" class="ed-inp" id="inpJumpPwr" value="${ent.jumpPower || 10.2}">
          </div></div>
        ` : ''}
      </div>

      <div class="prop-group">
        <h5>🎨 Цвета и Лицевые Спрайты (R6 Alpha)</h5>
        <button class="ed-btn apply-oneclick" id="btnCharFacePaint" type="button" style="justify-content:center">😀 Рисовать Спрайт Лица / Части Тела</button>
        <div class="limb-grid">
          <div class="limb-card"><span>Голова</span><input type="color" class="ed-color" id="cLimbHead" value="${hexOf(rig.mHead)}"><button class="ed-btn" data-plimb="face" type="button">🖌️</button></div>
          <div class="limb-card"><span>Торс</span><input type="color" class="ed-color" id="cLimbTorso" value="${hexOf(rig.mTorso)}"><button class="ed-btn" data-plimb="torso" type="button">🖌️</button></div>
          <div class="limb-card"><span>Л. Рука</span><input type="color" class="ed-color" id="cLimbArmL" value="${hexOf(rig.mArmL)}"><button class="ed-btn" data-plimb="armL" type="button">🖌️</button></div>
          <div class="limb-card"><span>П. Рука</span><input type="color" class="ed-color" id="cLimbArmR" value="${hexOf(rig.mArmR)}"><button class="ed-btn" data-plimb="armR" type="button">🖌️</button></div>
          <div class="limb-card"><span>Л. Нога</span><input type="color" class="ed-color" id="cLimbLegL" value="${hexOf(rig.mLegL)}"><button class="ed-btn" data-plimb="legL" type="button">🖌️</button></div>
          <div class="limb-card"><span>П. Нога</span><input type="color" class="ed-color" id="cLimbLegR" value="${hexOf(rig.mLegR)}"><button class="ed-btn" data-plimb="legR" type="button">🖌️</button></div>
        </div>
      </div>

      <div class="prop-group">
        <h5>🎩🐾 Аксессуары и Питомцы (Лимит: ${MAX_ACTIVE_PER_SLOT} на слот)</h5>
        <div style="font-size:9.5px;color:#8fa0bd;background:rgba(10,12,18,0.55);padding:4px 6px;border-radius:5px;line-height:1.35">
          ${slotCountsSummary}
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          <button class="ed-btn apply-oneclick" id="btnCreateCustomCos" type="button" style="flex:1;justify-content:center">➕ 3D-Аксессуар</button>
          <button class="ed-btn" id="btnCreateCustomPet" type="button" style="flex:1;justify-content:center;background:linear-gradient(135deg,#8e44ad,#00a2ff);border-color:#70cfff;color:#fff">🐾 Создать Питомца</button>
        </div>
        ${customCosHTML ? `<div style="display:flex;flex-direction:column;gap:4px;margin-top:4px">${customCosHTML}</div>` : `<div style="font-size:10px;color:#8fa0bd">На персонаже нет кастомных аксессуаров или питомцев.</div>`}
        ${libHTML ? `<div style="font-size:10px;color:#ffce3a;margin-top:6px">Сохранённый Гардероб:</div><div style="display:flex;flex-direction:column;gap:4px">${libHTML}</div>` : ''}
      </div>

      <div class="prop-group">
        <h5>👑 Готовые Косметические Предметы</h5>
        <div class="cos-grid">
          <div class="cos-chip ${rig.hatGroup.visible ? 'on' : ''}" data-cos="hat">${rig.hatGroup.visible ? '🟢' : '🔴'} 🎩 Цилиндр</div>
          <div class="cos-chip ${rig.crown.visible ? 'on' : ''}" data-cos="crown">${rig.crown.visible ? '🟢' : '🔴'} 👑 Корона</div>
          <div class="cos-chip ${rig.hair.visible ? 'on' : ''}" data-cos="hair">${rig.hair.visible ? '🟢' : '🔴'} 💇 Волосы</div>
          <div class="cos-chip ${rig.glasses.visible ? 'on' : ''}" data-cos="glasses">${rig.glasses.visible ? '🟢' : '🔴'} 🕶️ Очки</div>
          <div class="cos-chip ${rig.halo.visible ? 'on' : ''}" data-cos="halo">${rig.halo.visible ? '🟢' : '🔴'} 😇 VIP Нимб</div>
          <div class="cos-chip ${rig.wings.visible ? 'on' : ''}" data-cos="wings">${rig.wings.visible ? '🟢' : '🔴'} 🪽 Крылья</div>
          <div class="cos-chip ${rig.backpack.visible ? 'on' : ''}" data-cos="backpack">${rig.backpack.visible ? '🟢' : '🔴'} 🎒 Рюкзак</div>
          <div class="cos-chip ${rig.sword.visible ? 'on' : ''}" data-cos="sword">${rig.sword.visible ? '🟢' : '🔴'} 🗡️ Меч</div>
          <div class="cos-chip ${rig.coil.visible ? 'on' : ''}" data-cos="coil">${rig.coil.visible ? '🟢' : '🔴'} 🌀 Пружина</div>
        </div>
      </div>
    `;

    $('inpCharName').oninput = e => {
      ent.name = e.target.value;
      refreshEntityTagWithHP(ent);
      refreshHierarchyUI();
    };
    $('inpCharChat').oninput = e => {
      ent.chat = e.target.value;
      ent.chatT = 999;
      refreshEntityTagWithHP(ent);
    };
    $('inpHpOn').onchange = e => {
      ent.hpEnabled = e.target.checked;
      ent.hpBarTimer = 3.0;
      refreshEntityTagWithHP(ent);
      if (ent.isP) updateShopUI();
      renderInspectorUI();
    };
    $('inpHpVal').oninput = e => {
      ent.hp = clamp(+e.target.value || 100, 1, ent.maxHp);
      ent.hpBarTimer = 3.0;
      refreshEntityTagWithHP(ent);
      if (ent.isP) updateShopUI();
    };
    $('inpMaxHp').oninput = e => {
      ent.maxHp = Math.max(10, +e.target.value || 100);
      ent.baseMaxHp = ent.maxHp;
      ent.hp = Math.min(ent.hp, ent.maxHp);
      ent.hpBarTimer = 3.0;
      refreshEntityTagWithHP(ent);
      if (ent.isP) updateShopUI();
    };
    $('inpMeleeDmg').oninput = e => {
      ent.meleeDamage = Math.max(0, +e.target.value || 20);
    };
    if ($('inpCharWander')) {
      $('inpCharWander').onchange = e => {
        ent.wander = e.target.checked;
      };
    }
    if ($('inpCharAggr')) {
      $('inpCharAggr').onchange = e => {
        ent.aggressive = e.target.checked;
      };
    }

    cont.querySelectorAll('[data-clrslot]').forEach(btn => {
      btn.onclick = () => {
        const sIdx = +btn.dataset.clrslot;
        if (ent.inventory) ent.inventory[sIdx] = null;
        syncEntityHeldItemMesh(ent);
        renderHotbarUI();
        renderInspectorUI();
      };
    });

    cont.querySelectorAll('[data-giveitm]').forEach(btn => {
      btn.onclick = () => {
        const libItm = S.savedItemsLibrary[+btn.dataset.giveitm];
        if (!libItm) return;
        const copy = normalizeItemData(JSON.parse(JSON.stringify(libItm)));
        if (copy.holdMode === 'carried') {
          ent.carriedItem = copy;
        } else {
          if (!Array.isArray(ent.inventory)) ent.inventory = [null, null, null, null, null, null];
          let slot = ent.inventory.findIndex((x, idx) => idx > 0 && !x);
          if (slot === -1) slot = 1;
          ent.inventory[slot] = copy;
          S.activeSlot = slot;
        }
        syncEntityHeldItemMesh(ent);
        renderHotbarUI();
        renderInspectorUI();
        sfx.coil();
      };
    });

    cont.querySelectorAll('[data-spawnitm]').forEach(btn => {
      btn.onclick = () => {
        const libIdx = +btn.dataset.spawnitm;
        const libItm = S.savedItemsLibrary[libIdx];
        if (!libItm) return;
        const wi = spawnWorldItem(libItm, ent.x + 2.2, ent.y + 0.6, ent.z);
        selectEditorObject({
          kind: 'world_item',
          worldEntry: wi,
          item: wi.item,
          editMode: 'root',
          partIdx: 0,
          libIdx
        });
        sfx.jump();
      };
    });

    cont.querySelectorAll('[data-delitm]').forEach(btn => {
      btn.onclick = () => {
        S.savedItemsLibrary.splice(+btn.dataset.delitm, 1);
        sfx.oof();
        renderInspectorUI();
      };
    });

    $('inpCharScale').onfocus = () => pushUndoState('Масштаб персонажа');
    $('inpCharScale').oninput = e => {
      const sc = clamp(+e.target.value || 1, 0.4, 5);
      rig.g.scale.setScalar(sc);
      rig.g.updateMatrixWorld(true);
      selBoxHelper.setFromObject(rig.g);
    };

    $('btnChModeRoot').onclick = () => selectEditorObject({ kind: 'char', ent, editMode: 'root' }, true);
    $('btnChModeHand').onclick = () => selectEditorObject({ kind: 'char', ent, editMode: 'hand_grip' }, true);
    $('btnChModeCarry').onclick = () => selectEditorObject({ kind: 'char', ent, editMode: 'carry_grip' }, true);

    const applyCharGripsFromInputs = () => {
      normalizeCharacterGripPoints(ent.preset);
      ent.preset.handGripPoint.x = +$('inpChGrip1X').value || 0;
      ent.preset.handGripPoint.y = +$('inpChGrip1Y').value || 0;
      ent.preset.handGripPoint.z = +$('inpChGrip1Z').value || 0;
      ent.preset.handGripPoint.rx = THREE.MathUtils.degToRad(+$('inpChGrip1RX').value || 0);
      ent.preset.handGripPoint.ry = THREE.MathUtils.degToRad(+$('inpChGrip1RY').value || 0);
      ent.preset.handGripPoint.rz = THREE.MathUtils.degToRad(+$('inpChGrip1RZ').value || 0);

      ent.preset.carryGripPoint.x = +$('inpChGrip2X').value || 0;
      ent.preset.carryGripPoint.y = +$('inpChGrip2Y').value || 0;
      ent.preset.carryGripPoint.z = +$('inpChGrip2Z').value || 0;
      ent.preset.carryGripPoint.rx = THREE.MathUtils.degToRad(+$('inpChGrip2RX').value || 0);
      ent.preset.carryGripPoint.ry = THREE.MathUtils.degToRad(+$('inpChGrip2RY').value || 0);
      ent.preset.carryGripPoint.rz = THREE.MathUtils.degToRad(+$('inpChGrip2RZ').value || 0);

      if (rig.syncGripSockets) rig.syncGripSockets(ent.preset);
      rig.g.updateMatrixWorld(true);
      if (selectedRef.mesh) selBoxHelper.setFromObject(selectedRef.mesh);
    };

    [
      'inpChGrip1X', 'inpChGrip1Y', 'inpChGrip1Z', 'inpChGrip1RX', 'inpChGrip1RY', 'inpChGrip1RZ',
      'inpChGrip2X', 'inpChGrip2Y', 'inpChGrip2Z', 'inpChGrip2RX', 'inpChGrip2RY', 'inpChGrip2RZ'
    ].forEach(id => {
      if ($(id)) {
        $(id).onfocus = () => pushUndoState('Изменение точки хвата персонажа');
        $(id).oninput = applyCharGripsFromInputs;
      }
    });

    $('btnResetCharGrips').onclick = () => {
      pushUndoState('Сброс точек хвата персонажа');
      ent.preset.handGripPoint = Object.assign({}, DEFAULT_HAND_GRIP_POINT);
      ent.preset.carryGripPoint = Object.assign({}, DEFAULT_CARRY_GRIP_POINT);
      if (rig.syncGripSockets) rig.syncGripSockets(ent.preset);
      rig.g.updateMatrixWorld(true);
      if (selectedRef.mesh) selBoxHelper.setFromObject(selectedRef.mesh);
      renderInspectorUI();
      sfx.jump();
      showBanner('🖐️ Точки хвата персонажа (1 и 2 руки) сброшены к эталонным!', '#00e676');
    };
    $('inpColR').oninput = e => {
      ent.colliderRadius = Math.max(0.2, +e.target.value || 0.42);
      if (S.showColliders) rebuildPhysicsArrays();
    };
    $('inpColH').oninput = e => {
      ent.colliderHeight = Math.max(1.0, +e.target.value || 2.5);
      if (S.showColliders) rebuildPhysicsArrays();
    };
    if ($('inpWalkSpd')) {
      $('inpWalkSpd').oninput = e => {
        ent.walkSpeed = Math.max(2, +e.target.value || 7.6);
      };
    }
    if ($('inpJumpPwr')) {
      $('inpJumpPwr').oninput = e => {
        ent.jumpPower = Math.max(4, +e.target.value || 10.2);
      };
    }

    const bindLimbCol = (id, matKey, presetKey) => {
      $(id).onfocus = () => pushUndoState('Цвет части тела');
      $(id).oninput = e => {
        const m = rig[matKey];
        m.color.set(e.target.value);
        m.userData.baseColor = m.color.getHex();
        ent.preset[presetKey] = m.color.getHex();
      };
    };
    bindLimbCol('cLimbHead', 'mHead', 'head');
    bindLimbCol('cLimbTorso', 'mTorso', 'torso');
    bindLimbCol('cLimbArmL', 'mArmL', 'armL');
    bindLimbCol('cLimbArmR', 'mArmR', 'armR');
    bindLimbCol('cLimbLegL', 'mLegL', 'legL');
    bindLimbCol('cLimbLegR', 'mLegR', 'legR');

    if ($('btnCharOpenStudio3D')) {
      $('btnCharOpenStudio3D').onclick = () => {
        selectEditorObject({ kind: 'char', ent, inStudio: true }, true);
      };
    }
    if ($('btnCharPlaceInWorld')) {
      $('btnCharPlaceInWorld').onclick = () => {
        closeItemStudio3D(false);
        selectEditorObject({ kind: 'char', ent, inStudio: false }, true);
        focusOnSelected();
      };
    }

    $('btnCharFacePaint').onclick = () => openPaintModal('face');
    cont.querySelectorAll('[data-plimb]').forEach(btn => {
      btn.onclick = () => openPaintModal(btn.dataset.plimb);
    });

    $('btnCreateCustomCos').onclick = () => {
      pushUndoState('Создание 3D-аксессуара');
      if (!ent.preset.customCosmetics) ent.preset.customCosmetics = [];
      const activeHeadCount = countActiveItemsInSlot(ent, 'head');
      const canEnable = activeHeadCount < MAX_ACTIVE_PER_SLOT;
      const newItem = normalizeCosmeticItem({
        id: 'cos_' + Date.now(),
        name: 'Аксессуар #' + (ent.preset.customCosmetics.length + 1),
        parentSlot: 'head',
        enabled: canEnable,
        parts: [
          {
            id: 'pt_' + Date.now(),
            name: 'Основа',
            shape: 'box',
            x: 0, y: 0.55, z: 0,
            rx: 0, ry: 0, rz: 0,
            sx: 0.6, sy: 0.4, sz: 0.6,
            color: '#ffce3a',
            texDataURL: null
          }
        ]
      });
      ent.preset.customCosmetics.push(newItem);
      ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
      attachRigToEntity(ent);
      const group = ent.rig.customCosMeshes[ent.rig.customCosMeshes.length - 1];
      selectEditorObject({ kind: 'cosmetic', ent, item: newItem, group, partIdx: 0 });
      sfx.coil();
    };

    $('btnCreateCustomPet').onclick = () => {
      pushUndoState('Создание 3D-питомца');
      if (!ent.preset.customCosmetics) ent.preset.customCosmetics = [];
      const activePetCount = countActiveItemsInSlot(ent, 'pet');
      const newPet = createStarterPetItem(ent.preset.customCosmetics.length + 1);
      newPet.enabled = activePetCount < MAX_ACTIVE_PER_SLOT;
      ent.preset.customCosmetics.push(newPet);
      ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
      attachRigToEntity(ent);
      const group = ent.rig.customCosMeshes[ent.rig.customCosMeshes.length - 1];
      selectEditorObject({ kind: 'cosmetic', ent, item: newPet, group, partIdx: 0 });
      sfx.coil();
    };

    cont.querySelectorAll('[data-ctoggle]').forEach(el => {
      el.onclick = () => {
        const idx = +el.dataset.ctoggle;
        const item = ent.preset.customCosmetics[idx];
        if (!item) return;
        normalizeCosmeticItem(item);
        const turningOn = item.enabled === false;
        if (turningOn) {
          const used = countActiveItemsInSlot(ent, item.parentSlot, item);
          if (used >= MAX_ACTIVE_PER_SLOT) {
            showBanner(`Слот «${SLOT_LABELS_RU[item.parentSlot] || item.parentSlot}» переполнен!`, '#ff3e3e');
            return;
          }
        }
        pushUndoState('Переключение аксессуара');
        item.enabled = turningOn;
        ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
        attachRigToEntity(ent);
        renderInspectorUI();
        sfx.jump();
      };
    });

    cont.querySelectorAll('[data-cedit]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const idx = +btn.dataset.cedit;
        const item = ent.preset.customCosmetics[idx];
        if (!item) return;
        normalizeCosmeticItem(item);
        const group = ent.rig?.customCosMeshes?.find(g => g.userData?.cosmeticItem === item);
        selectEditorObject({
          kind: 'cosmetic',
          ent,
          item,
          group,
          partIdx: 0,
          inWorldPlacement: false
        });
        sfx.coil();
      };
    });

    cont.querySelectorAll('[data-cdel]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const idx = +btn.dataset.cdel;
        ent.preset.customCosmetics.splice(idx, 1);
        ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
        attachRigToEntity(ent);
        renderInspectorUI();
        sfx.oof();
      };
    });

    cont.querySelectorAll('[data-libidx]').forEach(btn => {
      btn.onclick = () => {
        const libItem = S.savedCosmeticsLibrary[+btn.dataset.libidx];
        if (!libItem) return;
        const copy = normalizeCosmeticItem(JSON.parse(JSON.stringify(libItem)));
        copy.id = 'cos_' + Date.now();
        const used = countActiveItemsInSlot(ent, copy.parentSlot);
        copy.enabled = used < MAX_ACTIVE_PER_SLOT;
        pushUndoState('Добавление предмета из гардероба');
        if (!ent.preset.customCosmetics) ent.preset.customCosmetics = [];
        ent.preset.customCosmetics.push(copy);
        ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
        attachRigToEntity(ent);
        renderInspectorUI();
        sfx.jump();
      };
    });

    cont.querySelectorAll('[data-libedit]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const libIdx = +btn.dataset.libedit;
        const libItem = S.savedCosmeticsLibrary[libIdx];
        if (!libItem) return;
        normalizeCosmeticItem(libItem);

        if (!ent.preset.customCosmetics) ent.preset.customCosmetics = [];
        let targetItem = ent.preset.customCosmetics.find(c => c.id === libItem.id || c.name === libItem.name);
        if (!targetItem) {
          targetItem = normalizeCosmeticItem(JSON.parse(JSON.stringify(libItem)));
          targetItem.enabled = countActiveItemsInSlot(ent, targetItem.parentSlot) < MAX_ACTIVE_PER_SLOT;
          ent.preset.customCosmetics.push(targetItem);
        } else {
          Object.assign(targetItem, JSON.parse(JSON.stringify(libItem)), { id: targetItem.id, enabled: targetItem.enabled });
        }

        ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
        attachRigToEntity(ent);
        const group = ent.rig.customCosMeshes.find(g => g.userData.cosmeticItem === targetItem);
        selectEditorObject({
          kind: 'cosmetic',
          ent,
          item: targetItem,
          group,
          partIdx: 0,
          libIdx
        });
        sfx.coil();
      };
    });

    cont.querySelectorAll('[data-libdel]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        S.savedCosmeticsLibrary.splice(+btn.dataset.libdel, 1);
        sfx.oof();
        renderInspectorUI();
      };
    });

    cont.querySelectorAll('.cos-chip[data-cos]').forEach(chip => {
      chip.onclick = () => {
        const c = chip.dataset.cos;
        const targetObj = c === 'hat' ? rig.hatGroup : rig[c];
        if (!targetObj) return;

        const turningOn = !targetObj.visible;
        const slotName = BUILTIN_COS_SLOT[c] || 'head';
        if (turningOn) {
          const used = countActiveItemsInSlot(ent, slotName, null, c);
          if (used >= MAX_ACTIVE_PER_SLOT) {
            showBanner(`Слот «${SLOT_LABELS_RU[slotName] || slotName}» переполнен!`, '#ff3e3e');
            return;
          }
        }

        pushUndoState('Переключение косметики');
        if (c === 'hat') {
          rig.hatGroup.visible = turningOn;
          ent.preset.hat = turningOn ? rig.hatMat.color.getHex() : null;
        }
        if (c === 'crown') {
          rig.crown.visible = turningOn;
          ent.preset.crown = turningOn;
        }
        if (c === 'hair') {
          rig.hair.visible = turningOn;
          ent.preset.hair = turningOn ? rig.hairMat.color.getHex() : null;
        }
        if (c === 'glasses') {
          rig.glasses.visible = turningOn;
          ent.preset.glasses = turningOn;
        }
        if (c === 'halo') {
          rig.halo.visible = turningOn;
          ent.preset.halo = turningOn;
          if (ent.isP) ent.hasHalo = turningOn;
        }
        if (c === 'wings') {
          rig.wings.visible = turningOn;
          ent.preset.wings = turningOn;
        }
        if (c === 'backpack') {
          rig.backpack.visible = turningOn;
          ent.preset.backpack = turningOn;
        }
        if (c === 'sword') {
          rig.sword.visible = turningOn;
          ent.preset.sword = turningOn;
        }
        if (c === 'coil') {
          rig.coil.visible = turningOn;
          ent.preset.coil = turningOn;
        }
        renderInspectorUI();
        sfx.jump();
      };
    });
  }
}

export function syncInspectorInputsFromObject() {
  if (!S.selectedRef) return;
  if (S.selectedRef.kind === 'block' && $('inpPX')) {
    const box = S.selectedRef.box;
    const m = box.m;
    if (box.logicRuntime) {
      box.logicRuntime.basePos = m.position.clone();
    }
    $('inpPX').value = m.position.x.toFixed(1);
    $('inpPY').value = m.position.y.toFixed(1);
    $('inpPZ').value = m.position.z.toFixed(1);
    $('inpSX').value = m.scale.x.toFixed(1);
    $('inpSY').value = m.scale.y.toFixed(1);
    $('inpSZ').value = m.scale.z.toFixed(1);
    $('inpRX').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.x));
    $('inpRY').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.y));
    $('inpRZ').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.z));
  } else if (S.selectedRef.kind === 'char' && $('inpCharScale')) {
    const ent = S.selectedRef.ent;
    $('inpCharScale').value = ent.rig.g.scale.x.toFixed(1);
    if (ent.preset && ent.preset.handGripPoint && $('inpChGrip1X')) {
      const hp = ent.preset.handGripPoint;
      $('inpChGrip1X').value = (hp.x || 0).toFixed(2);
      $('inpChGrip1Y').value = (hp.y || 0).toFixed(2);
      $('inpChGrip1Z').value = (hp.z || 0).toFixed(2);
      $('inpChGrip1RX').value = Math.round(THREE.MathUtils.radToDeg(hp.rx || 0));
      $('inpChGrip1RY').value = Math.round(THREE.MathUtils.radToDeg(hp.ry || 0));
      $('inpChGrip1RZ').value = Math.round(THREE.MathUtils.radToDeg(hp.rz || 0));
    }
    if (ent.preset && ent.preset.carryGripPoint && $('inpChGrip2X')) {
      const cp = ent.preset.carryGripPoint;
      $('inpChGrip2X').value = (cp.x || 0).toFixed(2);
      $('inpChGrip2Y').value = (cp.y || 0).toFixed(2);
      $('inpChGrip2Z').value = (cp.z || 0).toFixed(2);
      $('inpChGrip2RX').value = Math.round(THREE.MathUtils.radToDeg(cp.rx || 0));
      $('inpChGrip2RY').value = Math.round(THREE.MathUtils.radToDeg(cp.ry || 0));
      $('inpChGrip2RZ').value = Math.round(THREE.MathUtils.radToDeg(cp.rz || 0));
    }
  } else if (S.selectedRef.kind === 'cosmetic' && $('inpCosPX')) {
    const m = S.selectedRef.mesh;
    if (!m) return;
    $('inpCosPX').value = m.position.x.toFixed(2);
    $('inpCosPY').value = m.position.y.toFixed(2);
    $('inpCosPZ').value = m.position.z.toFixed(2);
    $('inpCosSX').value = m.scale.x.toFixed(2);
    $('inpCosSY').value = m.scale.y.toFixed(2);
    $('inpCosSZ').value = m.scale.z.toFixed(2);
    $('inpCosRX').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.x));
    $('inpCosRY').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.y));
    $('inpCosRZ').value = Math.round(THREE.MathUtils.radToDeg(m.rotation.z));
  } else if (S.selectedRef.kind === 'world_item') {
    const { item, editMode, mesh } = S.selectedRef;
    if ((editMode === 'part' || editMode === 'proj_part') && mesh && $('inpItmPX')) {
      $('inpItmPX').value = mesh.position.x.toFixed(2);
      $('inpItmPY').value = mesh.position.y.toFixed(2);
      $('inpItmPZ').value = mesh.position.z.toFixed(2);
      $('inpItmSX').value = mesh.scale.x.toFixed(2);
      $('inpItmSY').value = mesh.scale.y.toFixed(2);
      $('inpItmSZ').value = mesh.scale.z.toFixed(2);
      $('inpItmRX').value = Math.round(THREE.MathUtils.radToDeg(mesh.rotation.x));
      $('inpItmRY').value = Math.round(THREE.MathUtils.radToDeg(mesh.rotation.y));
      $('inpItmRZ').value = Math.round(THREE.MathUtils.radToDeg(mesh.rotation.z));
    } else if (editMode === 'grip' && item && $('inpGripX')) {
      $('inpGripX').value = (item.gripPoint.x || 0).toFixed(2);
      $('inpGripY').value = (item.gripPoint.y || 0).toFixed(2);
      $('inpGripZ').value = (item.gripPoint.z || 0).toFixed(2);
      $('inpGripRX').value = Math.round(THREE.MathUtils.radToDeg(item.gripPoint.rx || 0));
      $('inpGripRY').value = Math.round(THREE.MathUtils.radToDeg(item.gripPoint.ry || 0));
      $('inpGripRZ').value = Math.round(THREE.MathUtils.radToDeg(item.gripPoint.rz || 0));
    } else if (editMode === 'muzzle' && item && $('inpMuzX')) {
      $('inpMuzX').value = (item.muzzlePoint.x || 0).toFixed(2);
      $('inpMuzY').value = (item.muzzlePoint.y || 0).toFixed(2);
      $('inpMuzZ').value = (item.muzzlePoint.z || 0).toFixed(2);
    }
  }
}