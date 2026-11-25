// src/studio/InspectorPanel.js
import { S, $, clamp, showBanner } from '../core/State.js';
import { promptUploadBBModel, buildBBModelGroup, extractBBModelParts } from '../core/BBModelLoader.js';
import { updateSkybox } from '../core/SceneManager.js';
import { createBlockMaterial, setMeshFrontSprite, flipImageURLHorizontally } from '../core/TextureFactory.js';
import {
  sfx,
  MUSIC_PRESETS,
  AMBIENCE_PRESETS,
  BUILTIN_SFX_LIST,
  setWorldMusic,
  setWorldAmbience,
  syncVolumesFromSettings,
  promptUploadCustomAudio,
  playSoundId,
  createDefaultSoundData
} from '../core/AudioEngine.js';
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
  createStarterItemTemplate,
  createStarterPetItem,
  createDefaultPartParticleData,
  normalizePartEffects
} from '../core/CharacterRig.js';
import {
  addSceneBlock,
  createDefaultLightData,
  createDefaultLogicData,
  createDefaultInteractionData,
  createDefaultMotionData,
  createDefaultSignalData,
  createDefaultCostData,
  syncBlockLightVisuals,
  syncBlockSpecialVisuals,
  rebuildPhysicsArrays,
  updateBlockOBB,
  ensureBlockComponents,
  syncBlockComponentsState,
  evaluateBlockMotionAtProgress,
  syncStudioMotionAndSignalHelpers
} from '../core/WorldRegistry.js';
import { createDefaultParticleData } from '../core/ParticleSystem.js';
import {
  attachRigToEntity,
  ensureNpcModules,
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
  MIN_ROTATION_STEP_DEG,
  snapAngleRad,
  snapAngleDeg,
  selBoxHelper,
  selectEditorObject,
  focusOnSelected,
  pushUndoState,
  pushCosmeticUndoState,
  undoLastCosmeticAction,
  pushItemUndoState,
  undoLastItemAction,
  openItemStudio3D,
  closeItemStudio3D,
  syncItemStudioPreview,
  makeNextNumberedCopyName
} from './StudioController.js';
import {
  refreshHierarchyUI,
  refreshPrefabDockUI,
  getItem3DThumbnail,
  getCosmetic3DThumbnail,
  recordHierarchyBaseline,
  propagateHierarchyTransform,
  convertEmptyObjToModularBlock,
  compileSceneHierarchyToItemData,
  saveSelectedObjectAsPrefab
} from './HierarchyAndSpawn.js';
import { openPaintModal } from './PaintStudio2D.js';
import {
  createDefaultScriptData,
  renderScriptAddonInspectorCardHTML,
  bindScriptAddonInspectorEvents,
  openScriptStudioModal
} from '../core/ScriptEngine.js';
import { WORLD_TEMPERATURE_PROFILES } from '../core/StatusEffects.js';
import { WEATHER_PROFILES, normalizeWeatherSubstance } from '../core/WeatherAndClouds.js';

function normalizeInspectorWindowKey(rawTitle, idx = 0) {
  const scope = !S.selectedRef ? 'world' : (S.selectedRef.kind || 'obj');
  const clean = String(rawTitle || '')
    .replace(/[▼▶]/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return `${scope}::${clean || ('sec_' + idx)}`;
}

export function enhanceAllInspectorCollapsibleWindows(cont = $('inspectorContent')) {
  if (!cont) return;
  if (!S.inspectorCollapsedState || typeof S.inspectorCollapsedState !== 'object') {
    S.inspectorCollapsedState = {};
  }

  // Делегированный клик и MutationObserver привязываются к #inspectorContent один раз навсегда
  if (!cont._collapsibleObserverBound) {
    cont._collapsibleObserverBound = true;

    cont.addEventListener('click', e => {
      if (e.target.closest('button, input, select, textarea, a, label')) return;

      const h5 = e.target.closest('.prop-group > h5, .insp-sec > .insp-sec-title');
      if (h5 && cont.contains(h5)) {
        const box = h5.parentElement;
        const key = box.dataset.collapsibleKey || normalizeInspectorWindowKey(h5.textContent, 0);
        box.dataset.collapsibleKey = key;
        const nextCollapsed = !box.classList.contains('is-collapsed');
        box.classList.toggle('is-collapsed', nextCollapsed);
        S.inspectorCollapsedState[key] = nextCollapsed;
        const arrow = h5.querySelector('.ecs-arrow');
        if (arrow) arrow.textContent = nextCollapsed ? '▶' : '▼';
        return;
      }

      const compHead = e.target.closest('.ecs-comp-card > .ecs-comp-head');
      if (compHead && cont.contains(compHead)) {
        if (
          compHead.dataset.compToggle ||
          compHead.dataset.npcmodToggle ||
          compHead.dataset.scrRootToggle ||
          compHead.dataset.scrItemToggle
        ) {
          return;
        }
        const card = compHead.parentElement;
        const body = card.querySelector(':scope > .ecs-comp-body');
        const key = card.dataset.collapsibleKey || normalizeInspectorWindowKey(compHead.textContent, 100);
        card.dataset.collapsibleKey = key;
        const nextCollapsed = body ? !body.hidden : !card.classList.contains('is-collapsed');
        if (body) body.hidden = nextCollapsed;
        card.classList.toggle('is-collapsed', nextCollapsed);
        S.inspectorCollapsedState[key] = nextCollapsed;
        const arrow = compHead.querySelector('.ecs-arrow');
        if (arrow) arrow.textContent = nextCollapsed ? '▶' : '▼';
      }
    });

    const obs = new MutationObserver(() => {
      enhanceAllInspectorCollapsibleWindows(cont);
    });
    obs.observe(cont, { childList: true });
  }

  // Кнопка быстрого сворачивания/разворачивания всех окон в шапке Инспектора
  const secHeader = document.querySelector('.ed-sidebar.right .ed-sec-title');
  if (secHeader && !$('btnToggleAllInspectorSecs')) {
    const toggleAllBtn = document.createElement('button');
    toggleAllBtn.type = 'button';
    toggleAllBtn.id = 'btnToggleAllInspectorSecs';
    toggleAllBtn.className = 'ed-btn';
    toggleAllBtn.style.cssText = 'padding:1px 6px;font-size:10px;margin-left:auto;margin-right:6px';
    toggleAllBtn.title = 'Свернуть / Развернуть все окна в Инспекторе';
    toggleAllBtn.textContent = '⊟ Все';
    const badge = $('inspTypeBadge');
    if (badge) secHeader.insertBefore(toggleAllBtn, badge);
    else secHeader.appendChild(toggleAllBtn);

    toggleAllBtn.onclick = () => {
      const boxes = cont.querySelectorAll('.prop-group, .insp-sec, .ecs-comp-card');
      const anyOpen = Array.from(boxes).some(b => {
        const body = b.querySelector(':scope > .ecs-comp-body');
        return body ? !body.hidden : !b.classList.contains('is-collapsed');
      });
      boxes.forEach((b, idx) => {
        const head = b.querySelector(':scope > h5, :scope > .insp-sec-title, :scope > .ecs-comp-head');
        if (!head) return;
        const k = b.dataset.collapsibleKey || normalizeInspectorWindowKey(head.textContent, idx);
        b.dataset.collapsibleKey = k;
        S.inspectorCollapsedState[k] = anyOpen;
        b.classList.toggle('is-collapsed', anyOpen);
        const body = b.querySelector(':scope > .ecs-comp-body');
        if (body) body.hidden = anyOpen;
        const arr = head.querySelector('.ecs-arrow');
        if (arr) arr.textContent = anyOpen ? '▶' : '▼';
      });
      toggleAllBtn.textContent = anyOpen ? '⊞ Все' : '⊟ Все';
    };
  }

  // Маркируем все .prop-group и .insp-sec стрелками и восстанавливаем состояние
  cont.querySelectorAll('.prop-group, .insp-sec').forEach((grp, idx) => {
    const head = grp.querySelector(':scope > h5, :scope > .insp-sec-title');
    if (!head) return;
    const key = grp.dataset.collapsibleKey || normalizeInspectorWindowKey(head.textContent, idx);
    grp.dataset.collapsibleKey = key;
    head.classList.add('prop-group-collapsible-head');

    const isCollapsed = Boolean(S.inspectorCollapsedState[key]);
    grp.classList.toggle('is-collapsed', isCollapsed);

    let arrow = head.querySelector(':scope > .ecs-arrow');
    if (!arrow) {
      arrow = document.createElement('span');
      arrow.className = 'ecs-arrow';
      arrow.style.marginRight = '5px';
      head.prepend(arrow);
    }
    arrow.textContent = isCollapsed ? '▶' : '▼';
  });

  // Маркируем все карточки .ecs-comp-card без собственных стрелок
  cont.querySelectorAll('.ecs-comp-card').forEach((card, idx) => {
    const head = card.querySelector(':scope > .ecs-comp-head');
    const body = card.querySelector(':scope > .ecs-comp-body');
    if (!head || !body) return;
    if (
      head.dataset.compToggle ||
      head.dataset.npcmodToggle ||
      head.dataset.scrRootToggle ||
      head.dataset.scrItemToggle
    ) {
      return;
    }
    const key = card.dataset.collapsibleKey || normalizeInspectorWindowKey(head.textContent, 100 + idx);
    card.dataset.collapsibleKey = key;
    const isCollapsed = Boolean(S.inspectorCollapsedState[key]);
    body.hidden = isCollapsed;
    card.classList.toggle('is-collapsed', isCollapsed);

    const titleBox = head.querySelector('.ecs-comp-title') || head;
    let arrow = titleBox.querySelector('.ecs-arrow');
    if (!arrow) {
      arrow = document.createElement('span');
      arrow.className = 'ecs-arrow';
      titleBox.prepend(arrow);
    }
    arrow.textContent = isCollapsed ? '▶' : '▼';
  });
}

function formatSnapDeg(rad) {
  const deg = snapAngleDeg(THREE.MathUtils.radToDeg(Number(rad) || 0));
  return Number(deg.toFixed(1));
}

function buildCustomFactionsEditorHTML() {
  if (!Array.isArray(S.worldSettings.factions)) S.worldSettings.factions = [];
  const facs = S.worldSettings.factions;

  const listHTML = facs.length > 0
    ? facs.map((f, idx) => {
        const otherRelationsHTML = facs
          .filter(other => other.id !== f.id)
          .map(other => {
            const rel = (f.relations && f.relations[other.id]) || 'neutral';
            return `
              <div class="prop-row" style="margin-top:2px">
                <label style="display:flex;align-items:center;gap:4px;overflow:hidden;text-overflow:ellipsis">
                  <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${other.color || '#56f0ff'}"></span>
                  <span>к «${other.name}»</span>
                </label>
                <select class="ed-inp" data-fac-rel-src="${f.id}" data-fac-rel-tgt="${other.id}" style="flex:1;padding:2px 5px;font-size:10px">
                  <option value="ally" ${rel === 'ally' ? 'selected' : ''}>🤝 Союз (Помогают и не бьют)</option>
                  <option value="neutral" ${rel === 'neutral' ? 'selected' : ''}>😐 Нейтралитет (Не трогают)</option>
                  <option value="hostile" ${rel === 'hostile' ? 'selected' : ''}>⚔️ Война / Вражда (Атакуют)</option>
                </select>
              </div>
            `;
          }).join('');

        return `
          <div style="background:#101420;border:1px solid ${f.color || '#283147'};border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:4px">
            <div style="display:flex;align-items:center;gap:5px">
              <input type="color" class="ed-color" data-fac-col="${idx}" value="${f.color || '#ff3e3e'}" style="width:22px;height:22px">
              <input class="ed-inp" data-fac-name="${idx}" value="${f.name}" style="flex:1;font-weight:800;font-size:10.5px;padding:3px 6px">
              <button class="ed-btn danger" data-fac-del="${idx}" type="button" style="padding:2px 6px;font-size:10px" title="Удалить фракцию">🗑️</button>
            </div>
            <div class="prop-row">
              <label>К 👑 Игрокам</label>
              <select class="ed-inp" data-fac-plr="${idx}" style="flex:1;padding:2px 5px;font-size:10px">
                <option value="ally" ${f.playerRelation === 'ally' ? 'selected' : ''}>🤝 Союзники Игрока (Защищают)</option>
                <option value="neutral" ${f.playerRelation === 'neutral' ? 'selected' : ''}>😐 Нейтралы к Игроку</option>
                <option value="hostile" ${(!f.playerRelation || f.playerRelation === 'hostile') ? 'selected' : ''}>⚔️ Враги Игрока (Атакуют)</option>
              </select>
            </div>
            ${otherRelationsHTML}
          </div>
        `;
      }).join('')
    : `<div style="font-size:10px;color:#64748b;text-align:center;padding:4px">Пока нет созданных фракций. Создай первую фракцию ниже!</div>`;

  return `
    <div style="display:flex;gap:4px;align-items:center;margin-bottom:4px">
      <input type="color" class="ed-color" id="newFacColorInp" value="#ff3e3e" title="Цвет новой фракции">
      <input class="ed-inp" id="newFacNameInp" placeholder="Название фракции..." style="flex:1">
      <button class="ed-btn apply-oneclick" id="btnCreateCustomFaction" type="button" style="padding:4px 8px;font-size:10px">➕ Создать</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:5px;max-height:220px;overflow-y:auto">
      ${listHTML}
    </div>
  `;
}

function bindCustomFactionsEditorEvents(cont, onCreatedCallback = null) {
  if (!Array.isArray(S.worldSettings.factions)) S.worldSettings.factions = [];
  const facs = S.worldSettings.factions;

  const btnCreate = $('btnCreateCustomFaction');
  if (btnCreate) {
    btnCreate.onclick = () => {
      const nameInp = $('newFacNameInp');
      const colInp = $('newFacColorInp');
      const rawName = (nameInp?.value || '').trim() || `Фракция #${facs.length + 1}`;
      const newFac = {
        id: 'fac_' + Date.now() + '_' + Math.floor(Math.random() * 999),
        name: rawName,
        color: colInp?.value || '#ff3e3e',
        playerRelation: 'hostile',
        selfRelation: 'ally',
        relations: {}
      };
      for (const other of facs) {
        newFac.relations[other.id] = 'neutral';
        if (!other.relations) other.relations = {};
        other.relations[newFac.id] = 'neutral';
      }
      facs.push(newFac);
      if (onCreatedCallback) onCreatedCallback(newFac);
      sfx.jump?.();
      showBanner(`🚩 Создана фракция «${newFac.name}»!`, newFac.color);
      _renderInspectorUICore();
    };
  }

  cont.querySelectorAll('[data-fac-name]').forEach(inp => {
    inp.oninput = e => {
      const idx = +inp.dataset.facName;
      if (facs[idx]) facs[idx].name = e.target.value || 'Фракция';
    };
    inp.onchange = () => _renderInspectorUICore();
  });

  cont.querySelectorAll('[data-fac-col]').forEach(inp => {
    inp.oninput = e => {
      const idx = +inp.dataset.facCol;
      if (facs[idx]) facs[idx].color = e.target.value;
    };
    inp.onchange = () => _renderInspectorUICore();
  });

  cont.querySelectorAll('[data-fac-plr]').forEach(sel => {
    sel.onchange = e => {
      const idx = +sel.dataset.facPlr;
      if (facs[idx]) facs[idx].playerRelation = e.target.value;
    };
  });

  cont.querySelectorAll('[data-fac-rel-src]').forEach(sel => {
    sel.onchange = e => {
      const srcId = sel.dataset.facRelSrc;
      const tgtId = sel.dataset.facRelTgt;
      const val = e.target.value;
      const srcFac = facs.find(f => f.id === srcId);
      const tgtFac = facs.find(f => f.id === tgtId);
      if (srcFac) {
        if (!srcFac.relations) srcFac.relations = {};
        srcFac.relations[tgtId] = val;
      }
      if (tgtFac) {
        if (!tgtFac.relations) tgtFac.relations = {};
        tgtFac.relations[srcId] = val;
      }
      _renderInspectorUICore();
    };
  });

  cont.querySelectorAll('[data-fac-del]').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.facDel;
      const removed = facs[idx];
      if (!removed) return;
      facs.splice(idx, 1);
      for (const n of S.customNPCs) {
        if (n.aiModules?.combat?.faction === removed.id) {
          n.aiModules.combat.faction = '';
        }
      }
      sfx.oof?.();
      _renderInspectorUICore();
    };
  });
}

// Синхронизирует редактируемый аксессуар или предмет с библиотекой Гардероба / Арсенала
export function syncLibraryItemIfEditing(ref = S.selectedRef) {
  if (!ref) return;
  if (ref.kind === 'cosmetic' && ref.libIdx !== undefined && S.savedCosmeticsLibrary[ref.libIdx]) {
    S.savedCosmeticsLibrary[ref.libIdx] = JSON.parse(JSON.stringify(ref.item));
  } else if (ref.kind === 'world_item' && ref.libIdx !== undefined && S.savedItemsLibrary[ref.libIdx]) {
    S.savedItemsLibrary[ref.libIdx] = JSON.parse(JSON.stringify(ref.item));
  }
}

function _renderInspectorUICore() {
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

      <div class="prop-group" style="border-color:#ffce3a">
        <h5>☀️ Глобальный Свет и 🪐 Небесные Тела</h5>
        ${(() => {
          if (!S.worldSettings.sunSettings) {
            S.worldSettings.sunSettings = { enabled: true, color: '#fff6dd', intensity: 1.25, hemiIntensity: 0.9, x: 45, y: 85, z: 35, shellShape: 'sphere', shellSize: 14, shellColor: '#ffea79', shellGlow: true };
          }
          const ss = S.worldSettings.sunSettings;
          const bodies = S.worldSettings.celestialBodies || [];
          return `
            <div class="prop-row">
              <label>Светило ВКЛ</label>
              <input type="checkbox" id="wSunOn" ${ss.enabled !== false ? 'checked' : ''}>
              <label style="flex:1;text-align:right">Цвет / Яркость</label>
              <input type="color" class="ed-color" id="wSunCol" value="${ss.color || '#fff6dd'}">
              <input type="number" step="0.1" min="0" max="5" class="ed-inp" id="wSunInt" value="${ss.intensity ?? 1.25}" style="width:58px">
            </div>
            <div class="prop-row">
              <label>Позиция X/Y/Z</label>
              <div class="vec3">
                <input type="number" step="5" class="ed-inp" id="wSunX" value="${ss.x ?? 45}">
                <input type="number" step="5" class="ed-inp" id="wSunY" value="${ss.y ?? 85}">
                <input type="number" step="5" class="ed-inp" id="wSunZ" value="${ss.z ?? 35}">
              </div>
            </div>
            <div class="prop-row">
              <label>3D-Оболочка</label>
              <select class="ed-inp" id="wSunShellShape" style="flex:1">
                <option value="none" ${ss.shellShape === 'none' ? 'selected' : ''}>🔴 Без оболочки</option>
                <option value="sphere" ${ss.shellShape === 'sphere' ? 'selected' : ''}>⚪ Сфера (Солнце)</option>
                <option value="box" ${ss.shellShape === 'box' ? 'selected' : ''}>🧊 Кубическое Солнце</option>
                <option value="octahedron" ${ss.shellShape === 'octahedron' ? 'selected' : ''}>✨ Кристалл / Звезда</option>
              </select>
              <input type="color" class="ed-color" id="wSunShellCol" value="${ss.shellColor || '#ffea79'}" title="Цвет оболочки">
              <input type="number" step="2" min="2" max="120" class="ed-inp" id="wSunShellSize" value="${ss.shellSize ?? 14}" style="width:52px" title="Размер оболочки">
            </div>
            <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
              <div style="display:flex;justify-content:space-between;align-items:center">
                <span style="font:800 9.5px var(--f);color:#ffce3a;text-transform:uppercase">🪐 Небесные тела на скайбоксе (${bodies.length}):</span>
                <button class="ed-btn apply-oneclick" id="btnAddCelestialBody" type="button" style="padding:2px 8px;font-size:10px">➕ Добавить тело</button>
              </div>
              <div style="display:flex;flex-direction:column;gap:5px;max-height:190px;overflow-y:auto">
                ${bodies.map((cb, idx) => `
                  <div style="background:#101420;border:1px solid #283147;border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:4px">
                    <div style="display:flex;align-items:center;gap:4px">
                      <input type="color" class="ed-color" data-cb-col="${idx}" value="${cb.color || '#70a1ff'}">
                      <select class="ed-inp" data-cb-shape="${idx}" style="flex:1;padding:2px 4px;font-size:10px">
                        <option value="sphere" ${cb.shape === 'sphere' ? 'selected' : ''}>🪐 Сфера (Планета)</option>
                        <option value="box" ${cb.shape === 'box' ? 'selected' : ''}>🧊 Куб-Планета</option>
                        <option value="octahedron" ${cb.shape === 'octahedron' ? 'selected' : ''}>⭐ Звезда / Кристалл</option>
                        <option value="torus" ${cb.shape === 'torus' ? 'selected' : ''}>🍩 Кольцо / Станция</option>
                      </select>
                      <input type="number" step="2" min="2" max="150" class="ed-inp" data-cb-size="${idx}" value="${cb.size ?? 22}" style="width:48px" title="Размер">
                      <button class="ed-btn danger" data-cb-del="${idx}" type="button" style="padding:2px 5px;font-size:10px">🗑️</button>
                    </div>
                    <div class="prop-row">
                      <label>Поз. X/Y/Z</label>
                      <div class="vec3">
                        <input type="number" step="10" class="ed-inp" data-cb-x="${idx}" value="${cb.x ?? -120}">
                        <input type="number" step="10" class="ed-inp" data-cb-y="${idx}" value="${cb.y ?? 180}">
                        <input type="number" step="10" class="ed-inp" data-cb-z="${idx}" value="${cb.z ?? -160}">
                      </div>
                    </div>
                    <div class="prop-row">
                      <label style="display:flex;align-items:center;gap:4px;cursor:pointer"><input type="checkbox" data-cb-glow="${idx}" ${cb.glow !== false ? 'checked' : ''}> ✨ Светится</label>
                      <label style="display:flex;align-items:center;gap:4px;cursor:pointer;margin-left:auto"><input type="checkbox" data-cb-ring="${idx}" ${cb.hasRing ? 'checked' : ''}> 🪐 Кольцо</label>
                    </div>
                  </div>
                `).join('')}
              </div>
            </div>
          `;
        })()}
      </div>

      <div class="prop-group" style="border-color:#38bdf8">
        <h5>🌡️ Температура Мира, ☁️ Облака и 🌦️ Погода</h5>
        ${(() => {
          if (!S.worldSettings.cloudsSettings) {
            S.worldSettings.cloudsSettings = {
              enabled: true, color: '#ffffff', coverage: 0.35, height: 72, dynamicCoverage: false, dynamicSpeed: 0.04
            };
          }
          if (!S.worldSettings.weatherSettings) {
            S.worldSettings.weatherSettings = {
              type: 'none',
              intensity: 0.75,
              affectTemperature: true,
              accumulateSurface: true,
              growLiquids: true
            };
          }
          const cs = S.worldSettings.cloudsSettings;
          const ws = S.worldSettings.weatherSettings;
          ws.type = normalizeWeatherSubstance(ws.type);
          const curTemp = S.worldSettings.worldTemperature || 'normal';
          const phasePreview = S.weatherRuntime?.phase && S.weatherRuntime.phase !== 'none'
            ? S.weatherRuntime.phaseLabel
            : '';
          const covPct = Math.round((Number(cs.coverage) ?? 0.35) * 100);
          const covLabel = covPct === 0 ? 'Безоблачно' : (covPct >= 95 ? 'Сплошная' : `${covPct}%`);

          return `
            <div class="prop-row">
              <label>🌡️ Температура</label>
              <select class="ed-inp" id="wTempSelect" style="flex:1">
                ${Object.values(WORLD_TEMPERATURE_PROFILES).map(tp =>
                  `<option value="${tp.id}" ${curTemp === tp.id ? 'selected' : ''}>${tp.label}</option>`
                ).join('')}
              </select>
            </div>

            <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
              <div class="prop-row">
                <label style="flex:1;color:#bae6fd;font-weight:800">☁️ Облака ВКЛ</label>
                <input type="checkbox" id="wCloudOn" ${cs.enabled !== false ? 'checked' : ''}>
                <label style="margin-left:8px">Цвет</label>
                <input type="color" class="ed-color" id="wCloudCol" value="${cs.color || '#ffffff'}">
              </div>
              <div class="prop-row">
                <label title="0% — безоблачно, 100% — полностью закрытое небо">Кучность</label>
                <input type="range" min="0" max="1" step="0.02" id="wCloudCov" value="${cs.coverage ?? 0.35}" style="flex:1">
                <span id="wCloudCovTxt" style="font-size:10px;width:62px;text-align:right;color:#56f0ff">${covLabel}</span>
              </div>
              <div class="prop-row">
                <label>Высота (м)</label>
                <input type="number" step="4" min="16" max="260" class="ed-inp" id="wCloudHeight" value="${cs.height ?? 72}" style="width:74px">
                <label style="flex:1;text-align:right" title="Автоматическая плавная смена кучности облаков">Динам. смена</label>
                <input type="checkbox" id="wCloudDyn" ${cs.dynamicCoverage ? 'checked' : ''}>
              </div>
              <div class="prop-row" id="wCloudDynSpdRow" ${cs.dynamicCoverage ? '' : 'hidden'}>
                <label>Скорость смены</label>
                <input type="range" min="0.005" max="0.25" step="0.005" id="wCloudDynSpd" value="${cs.dynamicSpeed ?? 0.04}" style="flex:1">
              </div>
            </div>

              <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
                <div class="prop-row">
                  <label>🌦️ Осадки</label>
                  <select class="ed-inp" id="wWeatherType" style="flex:1">
                    ${Object.values(WEATHER_PROFILES).map(wp =>
                      `<option value="${wp.id}" ${ws.type === wp.id ? 'selected' : ''}>${wp.label}</option>`
                    ).join('')}
                  </select>
                </div>
                <div id="wWeatherIntRow" ${ws.type && ws.type !== 'none' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px">
                  <div class="prop-row">
                    <label>Интенсивность</label>
                    <input type="range" min="0.1" max="1.0" step="0.05" id="wWeatherInt" value="${ws.intensity ?? 0.75}" style="flex:1">
                    <span id="wWeatherIntTxt" style="font-size:10px;width:36px;text-align:right">${Math.round((ws.intensity ?? 0.75) * 100)}%</span>
                  </div>
                  ${phasePreview ? `
                    <div style="font:700 10px var(--f);color:#7dd3fc;background:rgba(56,189,248,0.1);border:1px solid rgba(56,189,248,0.28);border-radius:6px;padding:4px 7px">
                      Активная фаза: <b>${phasePreview}</b>
                    </div>
                  ` : ''}
                  <div class="prop-row">
                    <label title="Водяные осадки постепенно охлаждают мир, лавовые — нагревать">Влияют на t°</label>
                    <input type="checkbox" id="wWeatherTempShift" ${ws.affectTemperature !== false ? 'checked' : ''}>
                    <label style="flex:1;text-align:right" title="Лужи, сугробы, сток в ямы и обледенение">Лужи и снег</label>
                    <input type="checkbox" id="wWeatherAccum" ${ws.accumulateSurface !== false ? 'checked' : ''}>
                  </div>
                  <div class="prop-row">
                    <label style="flex:1" title="Водоёмы под открытым небом поднимаются вверх от осадков и стока">🌊 Рост уровня жидкостей</label>
                    <input type="checkbox" id="wWeatherGrowLiq" ${ws.growLiquids !== false ? 'checked' : ''}>
                  </div>
                </div>
              </div>
          `;
        })()}
      </div>

      <div class="prop-group">
        <h5>🌍 Физика Мира, Смерть и Респавн</h5>
        <div class="prop-row">
          <label title="Глобальная сила притяжения: влияет на игрока, NPC, снаряды и все физические блоки">Сила гравитации</label>
          <input type="range" min="1" max="60" step="1" id="wGravRange" value="${S.worldSettings.gravity ?? 22}" style="flex:1">
          <input type="number" step="1" min="0" max="100" class="ed-inp" id="wGrav" value="${S.worldSettings.gravity ?? 22}" style="width:58px">
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-bottom:4px">
          <button class="ed-btn" data-grav-preset="4" type="button" style="justify-content:center;font-size:9.5px;padding:3px">🛰️ Космос (4)</button>
          <button class="ed-btn" data-grav-preset="9" type="button" style="justify-content:center;font-size:9.5px;padding:3px">🌙 Луна (9)</button>
          <button class="ed-btn" data-grav-preset="22" type="button" style="justify-content:center;font-size:9.5px;padding:3px">🌍 Норма (22)</button>
          <button class="ed-btn" data-grav-preset="45" type="button" style="justify-content:center;font-size:9.5px;padding:3px">🪐 Тяж. (45)</button>
        </div>
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
        <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
          <div style="font:800 9.5px var(--f);color:#56f0ff;text-transform:uppercase">🏃 Глобальные правила Бега и Стамины:</div>
          <div class="prop-row">
            <label title="Разрешить бег на Shift для игроков и спринт для NPC">Разрешить бег</label>
            <input type="checkbox" id="wAllowSprint" ${S.worldSettings.allowSprint !== false ? 'checked' : ''}>
            <label style="flex:1;text-align:right" title="Расходовать шкалу выносливости при беге">Тратить стамину</label>
            <input type="checkbox" id="wStaminaDrain" ${S.worldSettings.staminaDrainOnSprint !== false ? 'checked' : ''}>
          </div>
          <div class="prop-row">
            <label>Множ. бега / Трата</label>
            <div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="0.05" min="1.1" max="2.5" class="ed-inp" id="wSprintMult" value="${S.worldSettings.sprintSpeedMultiplier ?? 1.48}" title="Во сколько раз бег быстрее шага">
              <input type="number" step="2" min="2" max="60" class="ed-inp" id="wStamDrainRate" value="${S.worldSettings.staminaDrainRate ?? 18}" title="Расход стамины в секунду">
            </div>
          </div>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:2px">
          <button class="ed-btn" id="btnAllHpOn" type="button" style="flex:1;justify-content:center">❤️ HP всем: 🟢</button>
          <button class="ed-btn" id="btnAllHpOff" type="button" style="flex:1;justify-content:center">🛡️ HP всем: 🔴</button>
        </div>
      </div>

      <div class="prop-group" style="border-color:#ff6b6b">
        <h5>🚩 Конструктор Фракций и Отношений (${(S.worldSettings.factions || []).length})</h5>
        <div style="font-size:10px;color:#cbd5e1;margin-bottom:4px">
          Создавай свои фракции для NPC и настраивай, кто с кем дружит (🤝 Союз), держит нейтралитет (😐) или воюет (⚔️ Война).
        </div>
        ${buildCustomFactionsEditorHTML()}
      </div>

      <div class="prop-group" style="border-color:#56f0ff">
        <h5>🎵 Фоновая Музыка, Эмбиент Локации и Свои Звуки</h5>
        <div class="prop-row">
          <label>🎼 Музыка мира</label>
          <select class="ed-inp" id="wMusicPreset">
            ${MUSIC_PRESETS.map(m => `<option value="${m.id}" ${S.worldSettings.musicPreset === m.id ? 'selected' : ''}>${m.name}</option>`).join('')}
            ${(S.customAudioLibrary || []).filter(a => a.category === 'music').map(a => `<option value="custom:${a.id}" ${S.worldSettings.musicPreset === 'custom:' + a.id ? 'selected' : ''}>🎵 [Своя] ${a.name}</option>`).join('')}
          </select>
        </div>
        <div class="prop-row">
          <label>🌲 Фон локации</label>
          <select class="ed-inp" id="wAmbiencePreset">
            ${AMBIENCE_PRESETS.map(a => `<option value="${a.id}" ${S.worldSettings.ambiencePreset === a.id ? 'selected' : ''}>${a.name}</option>`).join('')}
            ${(S.customAudioLibrary || []).filter(a => a.category === 'ambience').map(a => `<option value="custom:${a.id}" ${S.worldSettings.ambiencePreset === 'custom:' + a.id ? 'selected' : ''}>🌲 [Свой] ${a.name}</option>`).join('')}
          </select>
        </div>
        <div class="prop-row">
          <label>Громк. Импактов</label>
          <input type="range" min="0" max="1.4" step="0.05" id="wVolSfx" value="${S.worldSettings.sfxVolume ?? 0.85}" style="flex:1">
        </div>
        <div class="prop-row">
          <label>Громк. Музыки</label>
          <input type="range" min="0" max="1.2" step="0.05" id="wVolMusic" value="${S.worldSettings.musicVolume ?? 0.42}" style="flex:1">
        </div>
        <div class="prop-row">
          <label>Громк. Эмбиента</label>
          <input type="range" min="0" max="1.2" step="0.05" id="wVolAmb" value="${S.worldSettings.ambienceVolume ?? 0.45}" style="flex:1">
        </div>

        <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
          <div style="font:800 9.5px var(--f);color:#8fa0bd;text-transform:uppercase">📥 Загрузить свои аудиофайлы (.MP3 / .WAV / .OGG):</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px">
            <button class="ed-btn apply-oneclick" id="btnUploadCustomSfx" type="button" style="justify-content:center;font-size:10px">➕ Свой Звук</button>
            <button class="ed-btn" id="btnUploadCustomMusic" type="button" style="justify-content:center;font-size:10px;border-color:#56f0ff">➕ Своя Музыка</button>
            <button class="ed-btn" id="btnUploadCustomAmb" type="button" style="justify-content:center;font-size:10px;border-color:#00e676">➕ Свой Фон</button>
          </div>
          ${(S.customAudioLibrary || []).length > 0 ? `
            <div style="display:flex;flex-direction:column;gap:4px;max-height:130px;overflow-y:auto;margin-top:3px">
              ${S.customAudioLibrary.map((aud, idx) => `
                <div style="display:flex;align-items:center;gap:4px;background:#101420;padding:4px 6px;border-radius:6px;border:1px solid #252f48">
                  <span style="flex:1;font:700 10px var(--f);color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
                    ${aud.category === 'music' ? '🎵' : (aud.category === 'ambience' ? '🌲' : '🔊')} ${aud.name}
                  </span>
                  <button class="ed-btn" data-aud-play="${aud.id}" type="button" style="padding:2px 6px;font-size:10px" title="Прослушать">▶</button>
                  <button class="ed-btn danger" data-aud-del="${idx}" type="button" style="padding:2px 6px;font-size:10px" title="Удалить">🗑️</button>
                </div>
              `).join('')}
            </div>
          ` : `<div style="font-size:10px;color:#64748b;text-align:center">Нет загруженных пользовательских аудиофайлов</div>`}
        </div>
      </div>
      <div style="font-size:11px;color:#8fa0bd;line-height:1.4;padding:4px">
        💡 <b>Оружие, Снаряды и Bricks Logic:</b><br>
        • В левой панели создавай <b>Мечи, Бластеры, Посохи, Бомбы, Аптечки, Факелы и 2-ручные Контейнеры</b>.<br>
        • У каждого оружия настраивается до <b>16 примитивов корпуса</b>, до <b>16 примитивов снаряда</b>, <b>Точка хвата (🤚)</b> и <b>Точка вылета (🎯)</b>!
      </div>

      <!-- 🧩 ГЛОБАЛЬНЫЙ СКРИПТ ПРАВИЛ МИРА -->
      <div class="insp-sec">
        <div class="insp-sec-title">🧩 ГЛОБАЛЬНЫЙ СКРИПТ ПРАВИЛ МИРА</div>
        ${renderScriptAddonInspectorCardHTML(
          S.worldSettings.worldScriptData || (S.worldSettings.worldScriptData = createDefaultScriptData('world')),
          'world',
          false
        )}
      </div>
    `;

    $('studioProjTitleInp').oninput = e => {
      S.currentProjectTitle = e.target.value;
    };
    $('wBtnImportJson').onclick = () => promptImportJsonFile(() => _renderInspectorUICore());
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
        _renderInspectorUICore();
      };
    });

    const syncWorldGrav = val => {
      const g = clamp(Number(val) || 22, 0, 100);
      S.worldSettings.gravity = g;
      if ($('wGrav')) $('wGrav').value = g;
      if ($('wGravRange')) $('wGravRange').value = g;
    };
    if ($('wGrav')) $('wGrav').oninput = e => syncWorldGrav(e.target.value);
    if ($('wGravRange')) $('wGravRange').oninput = e => syncWorldGrav(e.target.value);
    cont.querySelectorAll('[data-grav-preset]').forEach(btn => {
      btn.onclick = () => syncWorldGrav(+btn.dataset.gravPreset);
    });
    $('wRespMode').onchange = e => {
      S.worldSettings.respawnMode = e.target.value;
      $('wRespDelayRow').hidden = S.worldSettings.respawnMode !== 'timer';
    };
    $('wRespDelay').oninput = e => {
      S.worldSettings.respawnDelay = clamp(+e.target.value || 3.5, 1, 30);
    };
    if ($('wAllowSprint')) {
      $('wAllowSprint').onchange = e => {
        S.worldSettings.allowSprint = e.target.checked;
        updateShopUI();
      };
    }
    if ($('wStaminaDrain')) {
      $('wStaminaDrain').onchange = e => {
        S.worldSettings.staminaDrainOnSprint = e.target.checked;
        updateShopUI();
      };
    }
    if ($('wSprintMult')) {
      $('wSprintMult').oninput = e => {
        S.worldSettings.sprintSpeedMultiplier = clamp(+e.target.value || 1.48, 1.1, 2.5);
      };
    }
    if ($('wStamDrainRate')) {
      $('wStamDrainRate').oninput = e => {
        S.worldSettings.staminaDrainRate = clamp(+e.target.value || 18, 2, 60);
      };
    }

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

    // Обработчики глобального светила и небесных тел
    const applySunSettings = () => {
      const ss = S.worldSettings.sunSettings;
      if ($('wSunOn')) ss.enabled = $('wSunOn').checked;
      if ($('wSunCol')) ss.color = $('wSunCol').value;
      if ($('wSunInt')) ss.intensity = Math.max(0, +$('wSunInt').value || 0);
      if ($('wSunX')) ss.x = +$('wSunX').value || 0;
      if ($('wSunY')) ss.y = +$('wSunY').value || 0;
      if ($('wSunZ')) ss.z = +$('wSunZ').value || 0;
      if ($('wSunShellShape')) ss.shellShape = $('wSunShellShape').value;
      if ($('wSunShellCol')) ss.shellColor = $('wSunShellCol').value;
      if ($('wSunShellSize')) ss.shellSize = Math.max(1, +$('wSunShellSize').value || 14);
      updateSkybox();
    };
    ['wSunOn', 'wSunCol', 'wSunInt', 'wSunX', 'wSunY', 'wSunZ', 'wSunShellShape', 'wSunShellCol', 'wSunShellSize'].forEach(id => {
      if ($(id)) {
        $(id).oninput = applySunSettings;
        $(id).onchange = applySunSettings;
      }
    });

    if ($('btnAddCelestialBody')) {
      $('btnAddCelestialBody').onclick = () => {
        if (!Array.isArray(S.worldSettings.celestialBodies)) S.worldSettings.celestialBodies = [];
        S.worldSettings.celestialBodies.push({
          id: 'cb_' + Date.now(),
          shape: 'sphere',
          color: '#70a1ff',
          size: 24,
          x: -140 + (S.worldSettings.celestialBodies.length * 55) % 280,
          y: 190,
          z: -180,
          glow: false,
          hasRing: true,
          ringColor: '#ffce3a'
        });
        updateSkybox();
        _renderInspectorUICore();
      };
    }

    if ($('wTempSelect')) {
      $('wTempSelect').onchange = e => {
        S.worldSettings.worldTemperature = e.target.value;
        if (S.weatherRuntime) {
          S.weatherRuntime.tempOffset = 0;
          S.weatherRuntime.effectiveTemp = e.target.value;
        }
        if (window.__debixSyncWorldSettings) window.__debixSyncWorldSettings(false);
      };
    }
    const syncCloudsInputs = () => {
      const cs = S.worldSettings.cloudsSettings;
      if ($('wCloudOn')) cs.enabled = $('wCloudOn').checked;
      if ($('wCloudCol')) cs.color = $('wCloudCol').value;
      if ($('wCloudCov')) {
        cs.coverage = clamp(+$('wCloudCov').value || 0, 0, 1);
        const pct = Math.round(cs.coverage * 100);
        if ($('wCloudCovTxt')) {
          $('wCloudCovTxt').textContent = pct === 0 ? 'Безоблачно' : (pct >= 95 ? 'Сплошная' : `${pct}%`);
        }
      }
      if ($('wCloudHeight')) cs.height = clamp(+$('wCloudHeight').value || 72, 16, 260);
      if ($('wCloudDyn')) {
        cs.dynamicCoverage = $('wCloudDyn').checked;
        if ($('wCloudDynSpdRow')) $('wCloudDynSpdRow').hidden = !cs.dynamicCoverage;
      }
      if ($('wCloudDynSpd')) cs.dynamicSpeed = clamp(+$('wCloudDynSpd').value || 0.04, 0.005, 0.5);
    };
    ['wCloudOn', 'wCloudCol', 'wCloudCov', 'wCloudHeight', 'wCloudDyn', 'wCloudDynSpd'].forEach(id => {
      if ($(id)) {
        $(id).oninput = syncCloudsInputs;
        $(id).onchange = syncCloudsInputs;
      }
    });

    const syncWeatherInputs = (rerender = false) => {
      const ws = S.worldSettings.weatherSettings;
      if ($('wWeatherType')) {
        ws.type = normalizeWeatherSubstance($('wWeatherType').value);
        if ($('wWeatherIntRow')) $('wWeatherIntRow').hidden = ws.type === 'none';
      }
      if ($('wWeatherInt')) {
        ws.intensity = clamp(+$('wWeatherInt').value || 0.75, 0.1, 1.0);
        if ($('wWeatherIntTxt')) $('wWeatherIntTxt').textContent = `${Math.round(ws.intensity * 100)}%`;
      }
      if ($('wWeatherTempShift')) ws.affectTemperature = $('wWeatherTempShift').checked;
      if ($('wWeatherAccum')) ws.accumulateSurface = $('wWeatherAccum').checked;
      if ($('wWeatherGrowLiq')) ws.growLiquids = $('wWeatherGrowLiq').checked;
      if (window.__debixSyncWorldSettings) window.__debixSyncWorldSettings(false);
      if (rerender) _renderInspectorUICore();
    };
    if ($('wWeatherType')) $('wWeatherType').onchange = () => syncWeatherInputs(true);
    if ($('wWeatherInt')) $('wWeatherInt').oninput = () => syncWeatherInputs(false);
    ['wWeatherTempShift', 'wWeatherAccum', 'wWeatherGrowLiq'].forEach(id => {
      if ($(id)) $(id).onchange = () => syncWeatherInputs(false);
    });

    const bindCbUpdate = (sel, fn) => {
      cont.querySelectorAll(sel).forEach(el => {
        el.oninput = () => { fn(el); updateSkybox(); };
        el.onchange = () => { fn(el); updateSkybox(); };
      });
    };
    bindCbUpdate('[data-cb-col]', el => { S.worldSettings.celestialBodies[+el.dataset.cbCol].color = el.value; });
    bindCbUpdate('[data-cb-shape]', el => { S.worldSettings.celestialBodies[+el.dataset.cbShape].shape = el.value; });
    bindCbUpdate('[data-cb-size]', el => { S.worldSettings.celestialBodies[+el.dataset.cbSize].size = Math.max(1, +el.value || 16); });
    bindCbUpdate('[data-cb-x]', el => { S.worldSettings.celestialBodies[+el.dataset.cbX].x = +el.value || 0; });
    bindCbUpdate('[data-cb-y]', el => { S.worldSettings.celestialBodies[+el.dataset.cbY].y = +el.value || 0; });
    bindCbUpdate('[data-cb-z]', el => { S.worldSettings.celestialBodies[+el.dataset.cbZ].z = +el.value || 0; });
    bindCbUpdate('[data-cb-glow]', el => { S.worldSettings.celestialBodies[+el.dataset.cbGlow].glow = el.checked; });
    bindCbUpdate('[data-cb-ring]', el => { S.worldSettings.celestialBodies[+el.dataset.cbRing].hasRing = el.checked; });
    cont.querySelectorAll('[data-cb-del]').forEach(btn => {
      btn.onclick = () => {
        S.worldSettings.celestialBodies.splice(+btn.dataset.cbDel, 1);
        updateSkybox();
        _renderInspectorUICore();
      };
    });

    if ($('wMusicPreset')) {
      $('wMusicPreset').onchange = e => {
        setWorldMusic(e.target.value);
        if (window.__debixSyncWorldSettings) window.__debixSyncWorldSettings(false);
      };
    }
    if ($('wAmbiencePreset')) {
      $('wAmbiencePreset').onchange = e => {
        setWorldAmbience(e.target.value);
        if (window.__debixSyncWorldSettings) window.__debixSyncWorldSettings(false);
      };
    }
    ['wVolSfx', 'wVolMusic', 'wVolAmb'].forEach(id => {
      if ($(id)) {
        $(id).oninput = () => {
          S.worldSettings.sfxVolume = +$('wVolSfx').value;
          S.worldSettings.musicVolume = +$('wVolMusic').value;
          S.worldSettings.ambienceVolume = +$('wVolAmb').value;
          syncVolumesFromSettings();
        };
      }
    });
    if ($('btnUploadCustomSfx')) {
      $('btnUploadCustomSfx').onclick = () => promptUploadCustomAudio('sfx', entry => {
        if (window.__debixSyncCustomAsset) window.__debixSyncCustomAsset('audio', entry);
        _renderInspectorUICore();
      });
    }
    if ($('btnUploadCustomMusic')) {
      $('btnUploadCustomMusic').onclick = () => promptUploadCustomAudio('music', entry => {
        if (window.__debixSyncCustomAsset) window.__debixSyncCustomAsset('audio', entry);
        setWorldMusic('custom:' + entry.id);
        if (window.__debixSyncWorldSettings) window.__debixSyncWorldSettings(false);
        _renderInspectorUICore();
      });
    }
    if ($('btnUploadCustomAmb')) {
      $('btnUploadCustomAmb').onclick = () => promptUploadCustomAudio('ambience', entry => {
        if (window.__debixSyncCustomAsset) window.__debixSyncCustomAsset('audio', entry);
        setWorldAmbience('custom:' + entry.id);
        if (window.__debixSyncWorldSettings) window.__debixSyncWorldSettings(false);
        _renderInspectorUICore();
      });
    }
    cont.querySelectorAll('[data-aud-play]').forEach(btn => {
      btn.onclick = () => playSoundId('custom:' + btn.dataset.audPlay, { pitchVar: 0 });
    });
    cont.querySelectorAll('[data-aud-del]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.audDel;
        S.customAudioLibrary.splice(idx, 1);
        sfx.oof();
        _renderInspectorUICore();
      };
    });
    bindCustomFactionsEditorEvents(cont);

    if (!S.worldSettings.worldScriptData) {
      S.worldSettings.worldScriptData = createDefaultScriptData('world');
    }
    bindScriptAddonInspectorEvents(
      cont,
      S.worldSettings.worldScriptData,
      'world',
      (needFullRefresh) => {
        if (needFullRefresh) _renderInspectorUICore();
      }
    );
    return;
  }

  if (selectedRef.kind === 'empty' && selectedRef.emptyObj) {
    // Автоматически переводим пустышку на единое модульное ядро компонентов с сохранением пивота и иерархии
    const upgradedBox = convertEmptyObjToModularBlock(selectedRef.emptyObj);
    if (upgradedBox) {
      S.selectedRef = { kind: 'block', box: upgradedBox };
      selectEditorObject(S.selectedRef, true);
      return;
    }
  }

  // 2. ИНСПЕКТОР ПРЕДМЕТА / ОРУЖИЯ / СНАРЯДА / 2-РУЧНОГО КОНТЕЙНЕРА
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
    if (!part.components) {
      const isWhiteDefault = (part.color || '').toLowerCase() === '#f1f5f9' && !part.texDataURL && !part.realLight && !part.pseudoLight && !part.particleData?.enabled;
      part.components = { visual: !isWhiteDefault };
    }
    const partHasVisual = Boolean(part.components.visual);
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
            <button class="ed-btn ${editMode === 'root' ? 'active' : ''}" data-imode="root" type="button" style="justify-content:center;border-color:#00f2fe">📦 Весь предмет целиком</button>
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
            <label>🧊 Форма</label>
            <select class="ed-inp" id="inpItmPtShape" style="flex:1">
              <option value="none" ${part.shape === 'none' ? 'selected' : ''}>🎯 Пустышка (Пивот / Группа)</option>
              <option value="box" ${part.shape === 'box' ? 'selected' : ''}>🧊 Куб (Box)</option>
              <option value="sphere" ${part.shape === 'sphere' ? 'selected' : ''}>⚪ Сфера (Sphere)</option>
              <option value="cylinder" ${part.shape === 'cylinder' ? 'selected' : ''}>🛢️ Цилиндр (Cylinder)</option>
              <option value="cone" ${part.shape === 'cone' ? 'selected' : ''}>🔺 Конус / Остриё (Cone)</option>
              <option value="torus" ${part.shape === 'torus' ? 'selected' : ''}>🍩 Кольцо (Torus)</option>
              <option value="plane" ${part.shape === 'plane' ? 'selected' : ''}>▭ Плоскость (Plane)</option>
              <option value="bbmodel" ${part.shape === 'bbmodel' ? 'selected' : ''}>📦 3D-Модель (.bbmodel)</option>
            </select>
            <button class="ed-btn" id="btnUploadItmPtBBM" type="button" title="Загрузить .bbmodel в эту деталь">📥 .bbmodel</button>
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
            <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpItmRX" value="${formatSnapDeg(part.rx)}">
            <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpItmRY" value="${formatSnapDeg(part.ry)}">
            <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpItmRZ" value="${formatSnapDeg(part.rz)}">
          </div></div>

          ${!partHasVisual ? `
            <button class="ecs-add-btn" id="btnAddItmPtVisual" type="button" style="margin-top:4px">
              ➕ Добавить свойство: 🎨 Визуал и Эффекты
            </button>
          ` : `
            <div class="ecs-comp-card" style="margin-top:4px;border-color:#56f0ff">
              <div class="ecs-comp-head">
                <div class="ecs-comp-title"><span>🎨 Визуал, Принт, Свет и Частицы</span></div>
                <div class="ecs-comp-actions">
                  <button class="ecs-comp-del" id="btnRemoveItmPtVisual" type="button" title="Сбросить визуал до белой фигуры">🗑️</button>
                </div>
              </div>
              <div class="ecs-comp-body">
                <div class="prop-row">
                  <label>Цвет и Принт</label>
                  <input type="color" class="ed-color" id="inpItmPtCol" value="${part.color || '#56f0ff'}">
                  <button class="ed-btn" id="btnPaintItmPart" type="button" style="flex:1">🎨 Нарисовать Принт</button>
                  ${part.texDataURL ? `<button class="ed-btn danger" id="btnClearItmPartSpr" type="button" title="Убрать спрайт">✕</button>` : ''}
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
                  <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
                    <input type="checkbox" id="inpItmPtRealLgt" ${part.realLight ? 'checked' : ''}> 💡 Реал. свет
                  </label>
                  <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
                    <input type="checkbox" id="inpItmPtPseudoLgt" ${part.pseudoLight ? 'checked' : ''}> ✨ Неон/Гало
                  </label>
                  <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#56f0ff;cursor:pointer">
                    <input type="checkbox" id="inpItmPtEmit" ${ptData.enabled ? 'checked' : ''}> 🎆 Частицы
                  </label>
                </div>

                <div id="itmPtLightRows" ${(part.realLight || part.pseudoLight) ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:4px;background:rgba(255,213,79,0.06);padding:6px;border-radius:7px;border:1px solid rgba(255,213,79,0.28)">
                  <div class="prop-row">
                    <label>Цвет / Яркость</label>
                    <input type="color" class="ed-color" id="inpItmPtLCol" value="${part.lightColor || part.color || '#56f0ff'}">
                    <input type="number" step="0.2" min="0.2" max="5" class="ed-inp" id="inpItmPtLInt" value="${part.lightIntensity ?? 1.4}" style="width:65px">
                    <label style="flex:1;text-align:right">Радиус</label>
                    <input type="number" step="1" min="2" max="50" class="ed-inp" id="inpItmPtLDist" value="${part.lightDistance ?? 12}" style="width:60px">
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
                    <input type="number" min="1" max="60" step="1" class="ed-inp" id="inpItmPtPRate" value="${ptData.rate ?? 10}" style="width:70px">
                  </div>
                  <div class="prop-row">
                    <label>Размер / Скор. / Y</label>
                    <div class="vec3">
                      <input type="number" step="0.05" min="0.05" max="3" class="ed-inp" id="inpItmPtPSize" value="${ptData.sizeStart ?? 0.28}">
                      <input type="number" step="0.2" min="0" max="20" class="ed-inp" id="inpItmPtPSpd" value="${ptData.speed ?? 1.6}">
                      <input type="number" step="0.5" class="ed-inp" id="inpItmPtPGrav" value="${ptData.gravity ?? 1.5}">
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `}
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
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpGripRX" value="${formatSnapDeg(item.gripPoint.rx)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpGripRY" value="${formatSnapDeg(item.gripPoint.ry)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpGripRZ" value="${formatSnapDeg(item.gripPoint.rz)}">
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
          <div style="font:800 9.5px var(--f);color:#fbbf24;text-transform:uppercase">🧪 Эффекты и Горючесть предмета:</div>
          <div class="prop-row">
            <label>Источник эффекта</label>
            <select class="ed-inp" id="inpItmEffSrc" style="flex:1">
              <option value="none" ${(item.effectSource || 'none') === 'none' ? 'selected' : ''}>⚪ Нет (Обычный)</option>
              <option value="poison" ${item.effectSource === 'poison' ? 'selected' : ''}>☠️ Источник Отравления (Макс.)</option>
              <option value="burn" ${item.effectSource === 'burn' ? 'selected' : ''}>🔥 Источник Горения (Макс.)</option>
              <option value="freeze" ${item.effectSource === 'freeze' ? 'selected' : ''}>❄️ Источник Заморозки (Макс.)</option>
            </select>
          </div>
          <div class="prop-row">
            <label>Может гореть</label>
            <input type="checkbox" id="inpItmFlammable" ${item.isFlammable ? 'checked' : ''}>
            <label style="flex:1;text-align:right">Урон от огня</label>
            <input type="checkbox" id="inpItmFireDmg" ${item.takesFireDamage ? 'checked' : ''}>
          </div>
        </div>
        <div style="margin-top:4px;padding-top:6px;border-top:1px dashed #283147;display:flex;flex-direction:column;gap:5px">
          <div style="font:800 9.5px var(--f);color:#94a3b8;text-transform:uppercase">Свечение и частицы предмета:</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
              <input type="checkbox" id="inpItmRealLgt" ${item.lightData.realLight ? 'checked' : ''}> 💡 Настоящий свет + Гало
            </label>
            <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
              <input type="checkbox" id="inpItmPseudoLgt" ${item.lightData.pseudoLight ? 'checked' : ''}> ✨ Псевдо-свет (Яркий + Гало)
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

      <!-- 🧩 СКРИПТ-АДДОН ПРЕДМЕТА -->
      ${renderScriptAddonInspectorCardHTML(
        item.scriptData || (item.scriptData = createDefaultScriptData('item')),
        'item',
        false
      )}

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

    bindScriptAddonInspectorEvents(
      cont,
      item.scriptData,
      'item',
      (needFullRefresh) => {
        if (needFullRefresh) _renderInspectorUICore();
      }
    );

    cont.querySelectorAll('[data-imode]').forEach(btn => {
      btn.onclick = () => {
        const m = btn.dataset.imode;
        refreshItemEditor(m, partIdx, Boolean(selectedRef.inWorldPlacement) && !S.itemStudioOpen);
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
        y: 0,
        z: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        sx: 0.4,
        sy: 0.4,
        sz: 0.4,
        color: '#f1f5f9',
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
      // 0-offset: спавним дубликат строго внутри исходной детали
      const copyP = normalizePartEffects(Object.assign({}, JSON.parse(JSON.stringify(part)), {
        id: 'ipt_' + Date.now(),
        name: `${part.name || 'Часть'}_Копия`,
        x: part.x || 0,
        y: part.y || 0,
        z: part.z || 0
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
      const removedPt = activePartsArr[partIdx];
      if (removedPt && removedPt.id) {
        for (const pt of activePartsArr) {
          if (pt && pt.parentPartId === removedPt.id) {
            pt.parentPartId = removedPt.parentPartId || null;
          }
        }
      }
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
    if ($('btnUploadItmPtBBM')) {
      $('btnUploadItmPtBBM').onclick = () => {
        promptUploadBBModel(modelData => {
          pushItemUndoState('Загрузка .bbmodel в предмет');
          const extracted = extractBBModelParts(modelData, 12);
          if (extracted.parts.length > 1) {
            if (activePartsArr.length === 1 && !activePartsArr[0].bbmodelData) {
              activePartsArr.length = 0;
            }
            for (const ep of extracted.parts) {
              if (activePartsArr.length >= MAX_ITEM_PARTS) break;
              const np = normalizePartEffects({
                id: 'ipt_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
                name: ep.name,
                shape: 'bbmodel',
                bbmodelData: ep.bbmodelData,
                x: ep.dx, y: ep.dy, z: ep.dz,
                rx: ep.rx, ry: ep.ry, rz: ep.rz,
                sx: ep.w, sy: ep.h, sz: ep.d,
                color: '#ffffff',
                texDataURL: null
              }, isEditingProj, false);
              np.components = { visual: true };
              activePartsArr.push(np);
            }
            item.name = modelData.name || item.name;
          } else {
            part.shape = 'bbmodel';
            part.name = modelData.name || part.name;
            part.bbmodelData = JSON.parse(JSON.stringify(modelData));
            const nat = buildBBModelGroup(modelData)?.userData?.naturalSize;
            if (nat) { part.sx = nat.w; part.sy = nat.h; part.sz = nat.d; }
          }
          refreshPrefabDockUI();
          refreshItemEditor(isEditingProj ? 'proj_part' : 'part', 0, false);
        });
      };
    }
    if ($('btnAddItmPtVisual')) {
      $('btnAddItmPtVisual').onclick = () => {
        pushItemUndoState('Добавление свойства Визуал детали');
        part.components = { visual: true };
        refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
      };
    }
    if ($('btnRemoveItmPtVisual')) {
      $('btnRemoveItmPtVisual').onclick = () => {
        pushItemUndoState('Удаление свойства Визуал детали');
        part.components = { visual: false };
        part.color = '#f1f5f9';
        part.texDataURL = null;
        part.realLight = false;
        part.pseudoLight = false;
        if (part.particleData) part.particleData.enabled = false;
        refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
      };
    }
    if ($('inpItmPtCol')) {
      $('inpItmPtCol').onfocus = () => pushItemUndoState('Смена цвета детали');
      $('inpItmPtCol').oninput = e => {
        part.color = e.target.value;
        refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
      };
    }
    if ($('btnPaintItmPart')) {
      $('btnPaintItmPart').onclick = () => openPaintModal('cosmetic');
    }
    if ($('btnClearItmPartSpr')) {
      $('btnClearItmPartSpr').onclick = () => {
        pushItemUndoState('Удаление спрайта детали');
        part.texDataURL = null;
        refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
      };
    }
    if ($('inpItmPtRealLgt')) {
      $('inpItmPtRealLgt').onchange = e => {
        pushItemUndoState('Настоящий свет детали');
        part.realLight = e.target.checked;
        if (part.realLight && !part.lightColor) part.lightColor = part.color || '#56f0ff';
        refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
      };
    }
    if ($('inpItmPtPseudoLgt')) {
      $('inpItmPtPseudoLgt').onchange = e => {
        pushItemUndoState('Псевдо-свет детали');
        part.pseudoLight = e.target.checked;
        if (part.pseudoLight && !part.lightColor) part.lightColor = part.color || '#56f0ff';
        refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
      };
    }
    if ($('inpItmPtEmit')) {
      $('inpItmPtEmit').onchange = e => {
        pushItemUndoState('Частицы детали');
        ptData.enabled = e.target.checked;
        refreshItemEditor(isEditingProj ? 'proj_part' : 'part', partIdx, false);
      };
    }
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
      part.rx = snapAngleRad(THREE.MathUtils.degToRad(+$('inpItmRX').value || 0));
      part.ry = snapAngleRad(THREE.MathUtils.degToRad(+$('inpItmRY').value || 0));
      part.rz = snapAngleRad(THREE.MathUtils.degToRad(+$('inpItmRZ').value || 0));

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
      item.gripPoint.rx = snapAngleRad(THREE.MathUtils.degToRad(+$('inpGripRX').value || 0));
      item.gripPoint.ry = snapAngleRad(THREE.MathUtils.degToRad(+$('inpGripRY').value || 0));
      item.gripPoint.rz = snapAngleRad(THREE.MathUtils.degToRad(+$('inpGripRZ').value || 0));

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

      if ($('inpItmEffSrc')) {
        item.effectSource = $('inpItmEffSrc').value;
        worldEntry.effectSource = item.effectSource;
      }
      if ($('inpItmFlammable')) {
        item.isFlammable = $('inpItmFlammable').checked;
        worldEntry.isFlammable = item.isFlammable;
      }
      if ($('inpItmFireDmg')) {
        item.takesFireDamage = $('inpItmFireDmg').checked;
        worldEntry.takesFireDamage = item.takesFireDamage;
      }

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
      'inpItmDecay', 'inpItmFallMult',       'inpEqArmor', 'inpEqHp', 'inpEqDmg', 'inpEqInv',
      'inpItmEffSrc', 'inpItmFlammable', 'inpItmFireDmg',
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
        _renderInspectorUICore();
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
        <div class="prop-row">
          <label>Надето (Активно)</label>
          <input type="checkbox" id="cosEnabledChk" ${item.enabled !== false ? 'checked' : ''}>
          <span style="font-size:10px;color:${item.enabled !== false ? '#00e676' : '#ff6b6b'}">${item.enabled !== false ? '🟢 Надето на персонаже' : '🔴 Снято (Скрыто в мире)'}</span>
        </div>
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
        <div style="display:flex;gap:4px;margin-bottom:5px">
          <button class="ed-btn ${(selectedRef.editMode || 'part') === 'root' ? 'active' : ''}" id="btnCosModeRoot" type="button" style="flex:1;justify-content:center;border-color:#00f2fe">📦 Весь аксессуар целиком</button>
          <button class="ed-btn ${(selectedRef.editMode || 'part') === 'part' ? 'active' : ''}" id="btnCosModePart" type="button" style="flex:1;justify-content:center">🧩 По деталям (${item.parts.length})</button>
        </div>
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
              <option value="none" ${part.shape === 'none' ? 'selected' : ''}>🎯 Пустышка (Пивот / Группа)</option>
              <option value="box" ${part.shape === 'box' ? 'selected' : ''}>Куб (Box)</option>
              <option value="sphere" ${part.shape === 'sphere' ? 'selected' : ''}>Сфера (Sphere)</option>
              <option value="cylinder" ${part.shape === 'cylinder' ? 'selected' : ''}>Цилиндр (Cylinder)</option>
              <option value="cone" ${part.shape === 'cone' ? 'selected' : ''}>Конус / Рог (Cone)</option>
              <option value="torus" ${part.shape === 'torus' ? 'selected' : ''}>Кольцо / Нимб (Torus)</option>
              <option value="plane" ${part.shape === 'plane' ? 'selected' : ''}>Плоскость / Крыло (Plane)</option>
              <option value="bbmodel" ${part.shape === 'bbmodel' ? 'selected' : ''}>📦 3D-Модель (.bbmodel)</option>
            </select>
            <button class="ed-btn" id="btnUploadCosPtBBM" type="button" title="Загрузить .bbmodel в эту деталь аксессуара">📥 .bbmodel</button>
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
            <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpCosRX" value="${formatSnapDeg(part.rx)}">
            <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpCosRY" value="${formatSnapDeg(part.ry)}">
            <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpCosRZ" value="${formatSnapDeg(part.rz)}">
          </div></div>

          <!-- Эффекты выбранной детали аксессуара: Настоящий свет, Псевдо-свет, Источать частицы -->
          <div style="margin-top:4px;padding-top:6px;border-top:1px dashed #283147;display:flex;flex-direction:column;gap:5px">
            <div style="font:800 9.5px var(--f);color:#94a3b8;text-transform:uppercase">Эффекты детали #${partIdx + 1}:</div>
            <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;background:#101420;padding:6px;border-radius:7px;border:1px solid #252f48">
              <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#ffd54f;cursor:pointer">
                <input type="checkbox" id="inpCosPtRealLgt" ${part.realLight ? 'checked' : ''}> 💡 Настоящий свет + Гало
              </label>
              <label style="display:flex;align-items:center;gap:4px;font:700 10px var(--f);color:#e2e8f0;cursor:pointer">
                <input type="checkbox" id="inpCosPtPseudoLgt" ${part.pseudoLight ? 'checked' : ''}> ✨ Псевдо-свет (Яркий + Гало)
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
          editMode: selectedRef.editMode || 'part',
          partIdx: clamp(newPartIdx, 0, item.parts.length - 1),
          inWorldPlacement: Boolean(selectedRef.inWorldPlacement) && !S.itemStudioOpen,
          libIdx
        },
        true
      );
      if (S.itemStudioOpen) {
        syncItemStudioPreview();
      }
    };

    if ($('btnCosModeRoot')) {
      $('btnCosModeRoot').onclick = () => {
        selectedRef.editMode = 'root';
        rebuildAndReselect(partIdx);
      };
    }
    if ($('btnCosModePart')) {
      $('btnCosModePart').onclick = () => {
        selectedRef.editMode = 'part';
        rebuildAndReselect(partIdx);
      };
    }

    if ($('btnCosOpenStudio3D')) {
      $('btnCosOpenStudio3D').onclick = () => {
        selectedRef.inWorldPlacement = false;
        selectEditorObject(selectedRef, true);
        openItemStudio3D(selectedRef);
        _renderInspectorUICore();
      };
    }
    if ($('btnCosExitStudio3D')) {
      $('btnCosExitStudio3D').onclick = () => {
        closeItemStudio3D(true);
        _renderInspectorUICore();
      };
    }

    $('btnBackToChar').onclick = () => {
      syncLibraryItemIfEditing(selectedRef);
      closeItemStudio3D(false);
      selectEditorObject({ kind: 'char', ent });
    };
    $('btnUndoCosLocal').onclick = () => undoLastCosmeticAction();
    if ($('cosEnabledChk')) {
      $('cosEnabledChk').onchange = e => {
        const nextOn = e.target.checked;
        if (nextOn && countActiveItemsInSlot(ent, item.parentSlot, item) >= MAX_ACTIVE_PER_SLOT) {
          e.target.checked = false;
          showBanner(`Слот «${SLOT_LABELS_RU[item.parentSlot] || item.parentSlot}» уже занят (${MAX_ACTIVE_PER_SLOT}/${MAX_ACTIVE_PER_SLOT})!`, '#ffce3a');
          return;
        }
        item.enabled = nextOn;
        rebuildAndReselect(partIdx);
      };
    }
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
        y: 0,
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
      // 0-offset: спавним дубликат строго внутри исходной детали
      const copyP = normalizePartEffects(Object.assign({}, JSON.parse(JSON.stringify(part)), {
        id: 'pt_' + Date.now(),
        name: (part.name || 'Часть') + '_Копия',
        x: part.x || 0,
        y: part.y || 0,
        z: part.z || 0
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
    if ($('btnUploadCosPtBBM')) {
      $('btnUploadCosPtBBM').onclick = () => {
        promptUploadBBModel(modelData => {
          pushCosmeticUndoState('Загрузка .bbmodel в аксессуар');
          const extracted = extractBBModelParts(modelData, 14);
          if (extracted.parts.length > 1) {
            if (item.parts.length === 1 && !item.parts[0].bbmodelData) {
              item.parts.length = 0;
            }
            for (const ep of extracted.parts) {
              if (item.parts.length >= MAX_COSMETIC_PARTS) break;
              item.parts.push(normalizePartEffects({
                id: 'pt_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
                name: ep.name,
                shape: 'bbmodel',
                bbmodelData: ep.bbmodelData,
                x: ep.dx, y: ep.dy, z: ep.dz,
                rx: ep.rx, ry: ep.ry, rz: ep.rz,
                sx: ep.w, sy: ep.h, sz: ep.d,
                color: '#ffffff',
                texDataURL: null
              }, isPet, false));
            }
            item.name = modelData.name || item.name;
          } else {
            part.shape = 'bbmodel';
            part.name = modelData.name || part.name;
            part.bbmodelData = JSON.parse(JSON.stringify(modelData));
            const nat = buildBBModelGroup(modelData)?.userData?.naturalSize;
            if (nat) { part.sx = nat.w * 0.5; part.sy = nat.h * 0.5; part.sz = nat.d * 0.5; }
          }
          refreshPrefabDockUI();
          rebuildAndReselect(0);
        });
      };
    }
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
        _renderInspectorUICore();
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
      part.rx = snapAngleRad(THREE.MathUtils.degToRad(+$('inpCosRX').value || 0));
      part.ry = snapAngleRad(THREE.MathUtils.degToRad(+$('inpCosRY').value || 0));
      part.rz = snapAngleRad(THREE.MathUtils.degToRad(+$('inpCosRZ').value || 0));

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
        _renderInspectorUICore();
      }
    };
    return;
  }

// 4. МОДУЛЬНЫЙ ИНСПЕКТОР ОБЪЕКТА СЦЕНЫ В СТИЛЕ UNITY (Трансформ + Независимые Свойства через «+»)
  if (selectedRef.kind === 'block') {
    const box = selectedRef.box;
    if (!box.particleData) box.particleData = createDefaultParticleData();
    if (!box.lightData) box.lightData = createDefaultLightData(box.colorHex, false);
    if (!box.logicData) box.logicData = createDefaultLogicData();
    const comps = ensureBlockComponents(box);

    const p = box.m.position;
    const r = box.m.rotation;
    const s = box.m.scale;
    const cs = box.colliderScale || { x: 1, y: 1, z: 1 };
    const sd = box.spawnerData;
    const pd = box.particleData;
    const ld = box.lightData;
    const it = box.interactionData;
    const md = box.motionData;
    const sg = box.signalData;
    const ct = box.costData;
    if (!box.soundData) box.soundData = createDefaultSoundData();
    const snd = box.soundData;

    if (!Array.isArray(md.waypoints) || md.waypoints.length === 0) {
      md.waypoints = [
        {
          id: 'wp_' + Date.now(),
          name: 'Точка #1',
          dx: 0, dy: 0, dz: 0,
          rx: 0, ry: 90, rz: 0,
          sx: box.w || 4, sy: box.h || 1, sz: box.d || 4
        }
      ];
    }
    const wpIdx = clamp(md.activeWaypointIdx || 0, 0, md.waypoints.length - 1);
    md.activeWaypointIdx = wpIdx;
    const curWp = md.waypoints[wpIdx];
    const isEditingWpIn3D = selectedRef.editMode === 'motion_wp';

    const otherBlocksOptionsHTML = S.allBlocks
      .filter(b => b !== box)
      .map(b => {
        const keyVal = (b.signalData && b.signalData.tag) ? b.signalData.tag : b.id;
        const isSelSig = sg.targetTag === keyVal || sg.targetTag === b.id;
        return `<option value="${keyVal}" ${isSelSig ? 'selected' : ''}>🎯 ${b.label} (${keyVal})</option>`;
      })
      .join('');

    if (comps.item?.enabled && !comps.item.itemData) {
      comps.item.itemData = createStarterItemTemplate('sword');
      comps.item.itemData.name = box.label || 'Мой Меч';
    }
    const itm = comps.item?.itemData ? normalizeItemData(comps.item.itemData) : null;
    const itmHasProj = itm && (itm.useType === 'ranged' || itm.useType === 'throwable');

    const CATALOG_COMPONENTS = [
      { key: 'geometry', icon: '🧊', title: 'Геометрия (3D-Фигура)', desc: 'Куб, Сфера, Цилиндр, Конус, Клин/Рампа, Кольцо, Плоскость' },
      { key: 'visual', icon: '🎨', title: 'Визуал и Эффекты', desc: 'Цвет, поверхность, 2D-Принт, настоящий/псевдо-свет и генератор частиц' },
      { key: 'physics', icon: '🧱', title: 'Физика и Коллайдер', desc: 'Форма коллайдера, состояние (Твёрдое / Жидкое / Газ), батут и конвейер' },
      { key: 'interaction', icon: '💥', title: 'Взаимодействие (Что делает)', desc: 'Касание / Радиус / [E] / Удар → Урон, Хил, Телепорт, Чекпоинт, Заряды и Уничтожение' },
      { key: 'motion', icon: '⚙️', title: 'Движение и Траектория', desc: 'Дверные петли (края), многоточечный маршрут (Позиция + Градусы + Размер) и 3D-маркеры' },
      { key: 'signal', icon: '🔗', title: 'Связи и Активатор (Триггер)', desc: 'Ручки дверей, рычаги, кнопки и передача сигнала другим объектам (пипетка 🎯 в 3D)' },
      { key: 'cost', icon: '💰', title: 'Плата / Цена (R$)', desc: 'Требовать монеты R$ за активацию объекта, двери, телепорта или покупку' },
      { key: 'item', icon: '⚔️', title: 'Предмет / Оружие', desc: 'Сделать этот объект и его дочерние примитивы удерживаемым оружием или предметом' },
      { key: 'spawner', icon: '🏭', title: 'Спавнер Объектов', desc: 'Генерация NPC, монет или физических кубов по таймеру или действию' },
      { key: 'sound', icon: '🔊', title: '3D Звук и Импакт', desc: 'Привязка встроенного или своего звука к активации объекта или 3D-зоне вокруг него' },
      { key: 'script', icon: '🧩', title: 'Скрипт-Аддон (DebiX Script)', desc: 'Кастомный код на JS: физика, магниты, логика и свои ползунки params' }
    ];

    const unaddedComps = CATALOG_COMPONENTS.filter(c => !comps[c.key]?.enabled);
    const activeCount = CATALOG_COMPONENTS.length - unaddedComps.length;

    const addMenuHTML = unaddedComps.length > 0
      ? `
        <div class="ecs-add-wrap">
          <button class="ecs-add-btn" id="btnToggleAddCompMenu" type="button">
            ➕ Добавить свойство (${unaddedComps.length})
          </button>
          <div class="ecs-add-menu" id="ecsAddCompMenu" hidden>
            ${unaddedComps.map(c => `
              <button class="ecs-add-item" data-add-comp="${c.key}" type="button">
                <div class="ecs-add-item-top">
                  <span>${c.icon} ${c.title}</span>
                  <span style="color:#56f0ff">＋</span>
                </div>
                <div class="ecs-add-item-desc">${c.desc}</div>
              </button>
            `).join('')}
          </div>
        </div>
      `
      : `<div style="text-align:center;font:700 10px var(--f);color:#69f0ae;padding:4px">✓ Все доступные свойства подключены к объекту</div>`;

    const wpTabsHTML = md.waypoints
      .map((w, idx) => `
        <button class="ed-btn ${idx === wpIdx ? 'active' : ''}" data-sel-wp="${idx}" type="button" style="padding:3px 7px;font-size:10px">
          📍 Точка #${idx + 1}
        </button>
      `)
      .join('');

    cont.innerHTML = `
      <!-- БАЗОВЫЙ БЛОК: ИМЯ И ТРАНСФОРМ -->
      <div class="prop-group" style="border-color:#56f0ff">
        <h5>
          <span>📐 Объект и Трансформ</span>
          <button class="ed-btn" id="btnQuickSavePrefab" type="button" style="padding:2px 6px;font-size:9.5px" title="Сохранить этот объект в нижнюю панель префабов">💾 В префаб</button>
        </h5>
        ${S.itemStudioOpen ? `
          <button class="ed-btn" id="btnBlkExitStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:5px;background:rgba(255,179,0,0.16);border-color:#ffb300;color:#ffe082">📍 Вернуть на карту (Выйти из 3D STUDIO)</button>
        ` : `
          <button class="ed-btn apply-oneclick" id="btnBlkOpenStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:5px;background:rgba(86,240,255,0.16);border-color:#56f0ff;color:#56f0ff">🛠️ Открыть объект в 3D STUDIO</button>
        `}
        <div class="prop-row"><label>Название</label><input class="ed-inp" id="inpBlkName" value="${box.label}"></div>
        <div class="prop-row"><label>Позиция</label><div class="vec3">
          <input type="number" step="0.5" class="ed-inp" id="inpPX" value="${p.x.toFixed(2)}">
          <input type="number" step="0.5" class="ed-inp" id="inpPY" value="${p.y.toFixed(2)}">
          <input type="number" step="0.5" class="ed-inp" id="inpPZ" value="${p.z.toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Размер</label><div class="vec3">
          <input type="number" step="0.25" min="0.1" class="ed-inp" id="inpSX" value="${s.x.toFixed(2)}">
          <input type="number" step="0.25" min="0.1" class="ed-inp" id="inpSY" value="${s.y.toFixed(2)}">
          <input type="number" step="0.25" min="0.1" class="ed-inp" id="inpSZ" value="${s.z.toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот°</label><div class="vec3">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpRX" value="${formatSnapDeg(r.x)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpRY" value="${formatSnapDeg(r.y)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpRZ" value="${formatSnapDeg(r.z)}">
        </div></div>
      </div>

      ${activeCount === 0 ? `
        <div class="ecs-empty-hint">
          🎯 Сейчас это <b>Пустой объект (Empty Pivot)</b>.<br>
          Нажми <b>«➕ Добавить свойство»</b> ниже, чтобы добавить ему Геометрию, Визуал, Физику, Взаимодействие, Движение, Связи или сделать его Оружием!
        </div>
      ` : ''}

      <!-- 1. КОМПОНЕНТ: 🧊 ГЕОМЕТРИЯ -->
      ${comps.geometry?.enabled ? `
        <div class="ecs-comp-card">
          <div class="ecs-comp-head" data-comp-toggle="geometry">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.geometry.collapsed ? '▶' : '▼'}</span>
              <span>🧊 Геометрия (3D-Форма)</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="geometry" type="button" title="Удалить геометрию (превратить объект в Пустышку)">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.geometry.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label>Тип фигуры</label>
              <select class="ed-inp" id="inpBlkShape">
                <option value="box" ${box.shape === 'box' ? 'selected' : ''}>🧊 Куб / Прямоугольник (Box)</option>
                <option value="sphere" ${box.shape === 'sphere' ? 'selected' : ''}>⚪ Сфера / Шар (Sphere)</option>
                <option value="cylinder" ${box.shape === 'cylinder' ? 'selected' : ''}>🛢️ Цилиндр / Колонна (Cylinder)</option>
                <option value="cone" ${box.shape === 'cone' ? 'selected' : ''}>🔺 Конус / Остриё (Cone)</option>
                <option value="wedge" ${box.shape === 'wedge' ? 'selected' : ''}>📐 Клин / Рампа (Wedge)</option>
                <option value="torus" ${box.shape === 'torus' ? 'selected' : ''}>🍩 Кольцо / Тор (Torus)</option>
                <option value="plane" ${box.shape === 'plane' ? 'selected' : ''}>▭ Плоскость / Пластина (Plane)</option>
                <option value="bbmodel" ${box.shape === 'bbmodel' ? 'selected' : ''}>📦 Своя 3D-Модель (.bbmodel)</option>
              </select>
            </div>
            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:4px">
              <button class="ed-btn apply-oneclick" id="btnUploadBBModel" type="button" style="flex:1;justify-content:center">📥 Загрузить .bbmodel</button>
              ${box.shape === 'bbmodel' && box.bbmodelGroup?.userData?.naturalSize ? `
                <button class="ed-btn" id="btnFitBBModelSize" type="button" title="Выставить родные пропорции модели Blockbench">📐 Пропорции</button>
              ` : ''}
            </div>
            ${(S.customModelsLibrary || []).length > 0 ? `
              <div class="prop-row" style="margin-top:4px">
                <label>Из библиотеки</label>
                <select class="ed-inp" id="selBBModelLib" style="flex:1">
                  <option value="">-- Выбрать загруженную модель (${S.customModelsLibrary.length}) --</option>
                  ${S.customModelsLibrary.map((m, idx) => `<option value="${idx}" ${box.bbmodelData?.id === m.id ? 'selected' : ''}>📦 ${m.name}</option>`).join('')}
                </select>
              </div>
            ` : ''}
          </div>
        </div>
      ` : ''}

      <!-- 2. КОМПОНЕНТ: 🎨 ВИЗУАЛ И ЭФФЕКТЫ -->
      ${comps.visual?.enabled ? `
        <div class="ecs-comp-card" style="border-color:#00a2ff">
          <div class="ecs-comp-head" data-comp-toggle="visual">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.visual.collapsed ? '▶' : '▼'}</span>
              <span>🎨 Визуал, Свет и Частицы</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="visual" type="button" title="Удалить визуал">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.visual.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label>Цвет и Поверхн.</label>
              <input type="color" class="ed-color" id="inpBlkCol" value="${box.colorHex}">
              <select class="ed-inp" id="inpBlkSurface" style="flex:1">
                <option value="studs" ${box.surfaceType === 'studs' ? 'selected' : ''}>🧱 Лего-пупырышки (Studs)</option>
                <option value="smooth" ${box.surfaceType === 'smooth' ? 'selected' : ''}>✨ Гладкий пластик (Smooth)</option>
                <option value="metal" ${box.surfaceType === 'metal' ? 'selected' : ''}>🪙 Металл / Золото (Metal)</option>
                <option value="neon" ${box.surfaceType === 'neon' ? 'selected' : ''}>💡 Неон (Светящийся материал)</option>
                <option value="glass" ${box.surfaceType === 'glass' ? 'selected' : ''}>🪟 Стекло (Полупрозрачное)</option>
              </select>
            </div>
            <div class="prop-row">
              <label>2D Принт</label>
              <button class="ed-btn" id="btnEditBlockStuds" type="button" style="flex:1">🎨 Нарисовать принт / руны</button>
              ${box.customTexDataURL ? `<button class="ed-btn danger" id="btnClearBlockSpr" type="button" title="Убрать лицевой спрайт">✕</button>` : ''}
            </div>

            <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:2px;display:flex;flex-direction:column;gap:5px">
              <div class="prop-row">
                <label>💡 Свечение</label>
                <select class="ed-inp" id="inpLightMode">
                  <option value="none" ${ld.mode === 'none' ? 'selected' : ''}>🔴 Нет свечения</option>
                  <option value="visual" ${ld.mode === 'visual' ? 'selected' : ''}>✨ Только вид свечения (Псевдо-свет)</option>
                  <option value="point" ${ld.mode === 'point' ? 'selected' : ''}>💡 Настоящий свет (PointLight)</option>
                </select>
              </div>
              <div id="lightFields" ${ld.mode !== 'none' ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px;background:rgba(255,213,79,0.06);padding:6px;border-radius:7px;border:1px solid rgba(255,213,79,0.25)">
                <div class="prop-row">
                  <label>Цвет свечения</label>
                  <input type="color" class="ed-color" id="inpLightCol" value="${ld.color || box.colorHex}">
                  <button class="ed-btn" id="btnLightMatchBlk" type="button" style="flex:1;justify-content:center">🎨 В цвет объекта</button>
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

            <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:2px;display:flex;flex-direction:column;gap:5px">
              <div class="prop-row">
                <label style="flex:1;color:#56f0ff;font-weight:800">🎆 Источать частицы (Партиклы)</label>
                <input type="checkbox" id="inpPtOn" ${pd.enabled ? 'checked' : ''}>
              </div>
              <div id="ptFields" ${pd.enabled ? '' : 'hidden'} style="display:flex;flex-direction:column;gap:5px;background:rgba(86,240,255,0.06);padding:6px;border-radius:7px;border:1px solid rgba(86,240,255,0.25)">
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
          </div>
        </div>
      ` : ''}

      <!-- 3. КОМПОНЕНТ: 🧱 ФИЗИКА И КОЛЛАЙДЕР -->
      ${comps.physics?.enabled ? `
        <div class="ecs-comp-card" style="border-color:#00e676">
          <div class="ecs-comp-head" data-comp-toggle="physics">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.physics.collapsed ? '▶' : '▼'}</span>
              <span>🧱 Физика и Коллайдер</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="physics" type="button" title="Удалить физику">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.physics.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label>Состояние</label>
              <select class="ed-inp" id="inpMatter">
                <option value="solid" ${box.matterState === 'solid' ? 'selected' : ''}>🧱 Твёрдое (Держит игрока)</option>
                <option value="liquid" ${box.matterState === 'liquid' ? 'selected' : ''}>💧 Жидкое (Вода/Лава — плавание)</option>
                <option value="gas" ${box.matterState === 'gas' ? 'selected' : ''}>☁️ Газообразное (Сквозное прохождение)</option>
              </select>
            </div>

            ${box.matterState !== 'liquid' ? `
              <div style="background:rgba(0,230,118,0.07);border:1px solid rgba(0,230,118,0.32);border-radius:8px;padding:7px;margin:3px 0;display:flex;flex-direction:column;gap:5px">
                <div class="prop-row">
                  <label style="flex:1;color:#00e676;font-weight:800;cursor:pointer" for="inpBlkDynPhys">📦 Физический объект (Rigidbody)</label>
                  <input type="checkbox" id="inpBlkDynPhys" ${box.isDynamicPhysics ? 'checked' : ''}>
                </div>
                ${box.parentKey && box.parentKey.startsWith('block:') ? `
                  <div class="prop-row">
                    <label style="flex:1;color:#ffce3a" title="В редакторе дочерние объекты по умолчанию приварены к родителю">🔥 Приварен к родителю (Weld)</label>
                    <input type="checkbox" id="inpBlkWeldParent" ${box.weldToParent !== false ? 'checked' : ''}>
                  </div>
                ` : ''}
                ${box.isDynamicPhysics ? `
                  <div class="prop-row">
                    <label title="Положительный вес тянет вниз, а отрицательный (напр. -15 кг) тянет вверх и держит плоты на плаву!">⚖️ Вес (кг, можно &lt; 0)</label>
                    <input type="number" step="1" min="-5000" max="10000" class="ed-inp" id="inpBlkWeight" value="${box.weight ?? 15}" style="flex:1;font-weight:800;color:#ffce3a">
                  </div>
                  <div style="display:grid;grid-template-columns:repeat(5,1fr);gap:3px">
                    <button class="ed-btn" data-w-preset="-18" type="button" style="justify-content:center;font-size:9px;padding:3px;border-color:#56f0ff" title="Отрицательный вес: тянет вверх, идеально для поплавков плота и воздушных шаров">🎈 -18кг</button>
                    <button class="ed-btn" data-w-preset="1" type="button" style="justify-content:center;font-size:9px;padding:3px" title="Сверхлёгкий">🪶 1кг</button>
                    <button class="ed-btn" data-w-preset="12" type="button" style="justify-content:center;font-size:9px;padding:3px" title="Лёгкий">📦 12кг</button>
                    <button class="ed-btn" data-w-preset="55" type="button" style="justify-content:center;font-size:9px;padding:3px" title="Средне-тяжёлый">🛢️ 55кг</button>
                    <button class="ed-btn" data-w-preset="250" type="button" style="justify-content:center;font-size:9px;padding:3px" title="Очень тяжёлый">🪨 250кг</button>
                  </div>
                  <div style="font-size:9.5px;color:#cbd5e1;line-height:1.3">
                    ${(box.weight ?? 15) < 0
                      ? '🎈 <b>Отрицательный вес:</b> взмывает вверх и компенсирует тяжесть приваренных/привязанных плит (позволяет строить плоты и дирижабли!).'
                      : (box.weight ?? 15) <= 3.5
                      ? '🪶 <b>Сверхлёгкий:</b> легко опрокидывается, далеко летит, всплывает на воде.'
                      : '⚖️ <b>Физический вес:</b> плавное сопротивление толканию, крутящий момент при толчке в край и учёт веса игрока сверху.'}
                  </div>

                  <!-- КОНСТРУКТОР СВАРКИ И ВЕРЁВОК (GARRY'S MOD / S&BOX) -->
                  <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:3px;display:flex;flex-direction:column;gap:5px">
                    <div style="font:800 9.5px var(--f);color:#56f0ff;text-transform:uppercase">🔗 Физические Связи (Верёвка / Сварка):</div>
                    <div style="display:flex;gap:4px">
                      <button class="ed-btn apply-oneclick" id="btnPickRope3D" type="button" style="flex:1;justify-content:center;font-size:10px">🔗 Привязать верёвкой в 3D</button>
                      <button class="ed-btn" id="btnPickWeld3D" type="button" style="flex:1;justify-content:center;font-size:10px;border-color:#00e676">🔥 Приварить в 3D</button>
                    </div>
                    ${(() => {
                      const myLinks = (S.physicsConstraints || []).filter(c => c && (c.blockAId === box.id || c.blockBId === box.id));
                      if (myLinks.length === 0) {
                        return `<div style="font-size:9.5px;color:#64748b">Нет привязанных верёвок/сварки (в игре также доступен инструмент на клавишу <b>[T]</b>)</div>`;
                      }
                      return myLinks.map(c => {
                        const otherId = c.blockAId === box.id ? c.blockBId : c.blockAId;
                        const otherBlk = S.allBlocks.find(x => x.id === otherId);
                        const otherName = otherBlk ? otherBlk.label : otherId;
                        return `
                          <div style="background:#101420;border:1px solid #252f48;border-radius:6px;padding:5px;display:flex;flex-direction:column;gap:4px">
                            <div style="display:flex;align-items:center;justify-content:space-between">
                              <span style="font:800 10px var(--f);color:${c.type === 'weld' ? '#00e676' : '#ffce3a'}">
                                ${c.type === 'weld' ? '🔥 Сварка' : '🔗 Верёвка'} ➔ «${otherName}»
                              </span>
                              <button class="ed-btn danger" data-del-cstr="${c.id}" type="button" style="padding:1px 6px;font-size:9.5px">✕</button>
                            </div>
                            ${c.type === 'rope' ? `
                            <div class="prop-row">
                              <label>Длина / Пруж.</label>
                              <div class="vec3" style="grid-template-columns:1fr 1fr">
                                <input type="number" step="0.5" min="0.2" max="50" class="ed-inp" data-cstr-len="${c.id}" value="${c.maxLength ?? 4}" title="Длина верёвки (м)">
                                <input type="number" step="0.05" min="0" max="1" class="ed-inp" data-cstr-spr="${c.id}" value="${c.springiness ?? 0.25}" title="Пружинность (0 = жёсткий трос, 1 = пружина)">
                              </div>
                            </div>
                            <div class="prop-row">
                              <label>Цвет / Толщина</label>
                              <input type="color" class="ed-color" data-cstr-col="${c.id}" value="${c.color || '#ffce3a'}" title="Косметический цвет верёвки">
                              <input type="number" step="0.02" min="0.02" max="0.6" class="ed-inp" data-cstr-thk="${c.id}" value="${c.thickness ?? 0.08}" style="flex:1" title="Косметическая толщина верёвки (м)">
                            </div>
                          ` : ''}
                          </div>
                        `;
                      }).join('');
                    })()}
                  </div>
                ` : ''}
              </div>
            ` : `
              <div style="background:rgba(0,162,255,0.09);border:1px solid rgba(86,240,255,0.35);border-radius:8px;padding:7px;margin:3px 0;display:flex;flex-direction:column;gap:5px">
                <div class="prop-row">
                  <label style="flex:1;color:#56f0ff;font-weight:800;cursor:pointer" for="inpLiqPhysOn">🌊 Физическое поведение жидкости</label>
                  <input type="checkbox" id="inpLiqPhysOn" ${box.liquidPhysicsEnabled !== false ? 'checked' : ''}>
                </div>
                ${box.liquidPhysicsEnabled !== false ? `
                  <div class="prop-row">
                    <label title="Архимедова сила выталкивания стандартного куба (кг). Если суммарный вес блока и стоящего на нём игрока превышает подъёмную силу — плот начинает тонуть!">Выталкивание (кг)</label>
                    <input type="number" step="5" min="1" max="5000" class="ed-inp" id="inpLiqBuoyancy" value="${box.liquidBuoyancy ?? 85}">
                  </div>
                  <div class="prop-row">
                    <label title="Сопротивление / густота жидкости">Вязкость среды</label>
                    <input type="number" step="0.5" min="0.2" max="25" class="ed-inp" id="inpLiqDrag" value="${box.liquidDrag ?? 3.5}">
                  </div>
                ` : ''}
                <div class="prop-row">
                  <label title="Холодная и нейтральная тушат огонь и замерзают; нейтральная отравляется; горячая растапливает лёд">🌡️ Температура</label>
                  <select class="ed-inp" id="inpLiqTemp" style="flex:1">
                    <option value="cold" ${box.liquidTemp === 'cold' ? 'selected' : ''}>❄️ Холодная (Быстро замерзает, тушит огонь)</option>
                    <option value="neutral" ${(!box.liquidTemp || box.liquidTemp === 'neutral') ? 'selected' : ''}>💧 Нейтральная (Замерзает, травится, тушит)</option>
                    <option value="hot" ${box.liquidTemp === 'hot' ? 'selected' : ''}>🔥 Горячая (Снимает заморозку, не замерзает)</option>
                  </select>
                </div>
              </div>
            `}
            <div class="prop-row">
              <label>Форма коллайд.</label>
              <select class="ed-inp" id="inpColliderShape">
                <option value="auto" ${(!box.colliderShape || box.colliderShape === 'auto') ? 'selected' : ''}>🔄 По форме фигуры (${box.shape || 'box'})</option>
                <option value="box" ${box.colliderShape === 'box' ? 'selected' : ''}>🧊 Куб / Бокс (OBB Box)</option>
                <option value="sphere" ${box.colliderShape === 'sphere' ? 'selected' : ''}>⚪ Сфера / Шар (Sphere)</option>
                <option value="cylinder" ${box.colliderShape === 'cylinder' ? 'selected' : ''}>🛢️ Цилиндр (Cylinder)</option>
                <option value="wedge" ${box.colliderShape === 'wedge' ? 'selected' : ''}>📐 Клин / Склон (Wedge)</option>
                <option value="capsule" ${box.colliderShape === 'capsule' ? 'selected' : ''}>💊 Капсула (Capsule)</option>
              </select>
            </div>
            <div class="prop-row"><label>Множ. Коллайд.</label><div class="vec3">
              <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpCX" value="${cs.x}">
              <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpCY" value="${cs.y}">
              <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpCZ" value="${cs.z}">
            </div></div>
            <div class="prop-row"><label>Прыгучесть</label><input type="number" step="1" min="0" class="ed-inp" id="inpBounce" value="${box.bounciness}" title="Упругость поверхности (батут)"></div>
            <div class="prop-row"><label>Конвейер Z/X</label><div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="0.5" class="ed-inp" id="inpConvZ" value="${box.conveyorVz}" title="Скорость тяги по оси Z">
              <input type="number" step="0.5" class="ed-inp" id="inpConvX" value="${box.conveyorVx}" title="Скорость тяги по оси X">
            </div></div>
            <div class="prop-row"><label>Вращение Y</label><input type="number" step="0.5" class="ed-inp" id="inpSpin" value="${box.spinSpeed}" title="Постоянное осевое вращение"></div>
            <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:4px;display:flex;flex-direction:column;gap:5px">
              <div style="font:800 9.5px var(--f);color:#fbbf24;text-transform:uppercase">🧪 Эффекты, Источник и Горючесть:</div>
              <div class="prop-row">
                <label title="Постоянный источник держит макс. стаки, не гаснет и не получает урона">Источник эффекта</label>
                <select class="ed-inp" id="inpBlkEffSrc" style="flex:1">
                  <option value="none" ${(!box.effectSource || box.effectSource === 'none') ? 'selected' : ''}>⚪ Нет (Обычный)</option>
                  <option value="poison" ${box.effectSource === 'poison' ? 'selected' : ''}>☠️ Источник Отравления (Макс.)</option>
                  <option value="burn" ${box.effectSource === 'burn' ? 'selected' : ''}>🔥 Источник Горения (Макс.)</option>
                  <option value="freeze" ${box.effectSource === 'freeze' ? 'selected' : ''}>❄️ Источник Заморозки (Макс.)</option>
                </select>
              </div>
              <div class="prop-row">
                <label>Может гореть</label>
                <input type="checkbox" id="inpBlkFlammable" ${box.isFlammable ? 'checked' : ''}>
                <label style="flex:1;text-align:right">Сгорает от огня</label>
                <input type="checkbox" id="inpBlkFireDmg" ${box.takesFireDamage ? 'checked' : ''}>
              </div>
              <div class="prop-row" id="rowBlkFireHp" ${box.takesFireDamage ? '' : 'hidden'}>
                <label>Запас прочн. (огонь)</label>
                <input type="number" step="10" min="10" max="5000" class="ed-inp" id="inpBlkFireHp" value="${box.maxFireHp ?? 100}">
              </div>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- 4. КОМПОНЕНТ: 💥 ВЗАИМОДЕЙСТВИЕ И ПОВЕДЕНИЕ («ЧТО ДЕЛАЕТ») -->
      ${comps.interaction?.enabled ? `
        <div class="ecs-comp-card" style="border-color:#ff6b6b">
          <div class="ecs-comp-head" data-comp-toggle="interaction">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.interaction.collapsed ? '▶' : '▼'}</span>
              <span>💥 Взаимодействие (Что делает)</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="interaction" type="button" title="Удалить взаимодействие">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.interaction.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label>Как активир.</label>
              <select class="ed-inp" id="inpItTrig">
                <option value="none" ${it.trigger === 'none' ? 'selected' : ''}>🔴 Никак (Только по сигналу извне)</option>
                <option value="touch" ${it.trigger === 'touch' ? 'selected' : ''}>👟 При прямом контакте (Наступить / Коснуться)</option>
                <option value="radius" ${it.trigger === 'radius' ? 'selected' : ''}>📡 В радиусе вокруг объекта (Стоять рядом)</option>
                <option value="keyE" ${it.trigger === 'keyE' ? 'selected' : ''}>🔘 По нажатию кнопки взаимодействия [E]</option>
                <option value="hit" ${it.trigger === 'hit' ? 'selected' : ''}>🥊 При ударе рукой или оружием (ЛКМ)</option>
              </select>
            </div>

            ${it.trigger === 'radius' ? `
              <div class="prop-row">
                <label>Радиус (м)</label>
                <input type="number" step="0.5" min="0.5" max="50" class="ed-inp" id="inpItRadDist" value="${it.radiusDist ?? 3.5}">
              </div>
            ` : ''}

            <div class="prop-row">
              <label>Что делает</label>
              <select class="ed-inp" id="inpItAct">
                <option value="none" ${it.actionType === 'none' ? 'selected' : ''}>⚪ Ничего (Чистый триггер для связей / траты)</option>
                <option value="health" ${it.actionType === 'health' ? 'selected' : ''}>❤️ Здоровье (Наносит урон / Восстанавливает HP)</option>
                <option value="teleport" ${it.actionType === 'teleport' ? 'selected' : ''}>🌀 Телепортирует игрока</option>
                <option value="checkpoint" ${it.actionType === 'checkpoint' ? 'selected' : ''}>⭐ Чекпоинт (Сохраняет точку респавна)</option>
                <option value="impulse" ${it.actionType === 'impulse' ? 'selected' : ''}>🚀 Подбрасывает / Толкает игрока (Импульс)</option>
                <option value="reward" ${it.actionType === 'reward' ? 'selected' : ''}>🎁 Выдаёт Перк / Усиление или Монеты R$</option>
                <option value="ghost_pass" ${it.actionType === 'ghost_pass' ? 'selected' : ''}>👻 Делает объект прозрачным проходом</option>
              </select>
            </div>

            ${it.actionType === 'health' ? `
              <div style="background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.3);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
                <div class="prop-row">
                  <label>Режим HP</label>
                  <select class="ed-inp" id="inpItHpMode">
                    <option value="damage" ${it.healthMode === 'damage' ? 'selected' : ''}>💔 Отнимает здоровье (Урон)</option>
                    <option value="heal" ${it.healthMode === 'heal' ? 'selected' : ''}>💚 Восстанавливает здоровье (Лечение)</option>
                    <option value="kill" ${it.healthMode === 'kill' ? 'selected' : ''}>💀 Мгновенная смерть (Kill)</option>
                  </select>
                </div>
                ${it.healthMode !== 'kill' ? `
                  <div class="prop-row">
                    <label>Кол-во HP</label>
                    <input type="number" step="5" min="1" class="ed-inp" id="inpItHpAmt" value="${it.healthAmount ?? 25}" style="width:75px">
                    <label style="flex:1;text-align:right">Интервал(с)</label>
                    <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpItHpTick" value="${it.healthTick ?? 0.5}" style="width:65px">
                  </div>
                ` : ''}
              </div>
            ` : ''}

            ${it.actionType === 'teleport' ? `
              <div style="background:rgba(86,240,255,0.08);border:1px solid rgba(86,240,255,0.3);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
                <div class="prop-row">
                  <label>Куда телепорт.</label>
                  <select class="ed-inp" id="inpItTpMode">
                    <option value="coords" ${it.tpMode === 'coords' ? 'selected' : ''}>📍 В координаты пространства (X, Y, Z)</option>
                    <option value="target" ${it.tpMode === 'target' ? 'selected' : ''}>🎯 К другому объекту сцены</option>
                    <option value="checkpoint" ${it.tpMode === 'checkpoint' ? 'selected' : ''}>⭐ На активный чекпоинт игрока</option>
                  </select>
                </div>
                ${it.tpMode === 'coords' ? `
                  <div class="prop-row"><label>Коорд. X/Y/Z</label><div class="vec3">
                    <input type="number" step="1" class="ed-inp" id="inpItTpX" value="${it.tpX ?? 0}">
                    <input type="number" step="1" class="ed-inp" id="inpItTpY" value="${it.tpY ?? 6}">
                    <input type="number" step="1" class="ed-inp" id="inpItTpZ" value="${it.tpZ ?? 0}">
                  </div></div>
                  <button class="ed-btn" id="btnItCaptureCamPos" type="button" style="justify-content:center">📍 Взять текущие координаты камеры</button>
                ` : ''}
                ${it.tpMode === 'target' ? `
                  <div class="prop-row">
                    <label>Объект-цель</label>
                    <input class="ed-inp" id="inpItTpTarget" placeholder="ID или #тег объекта" value="${it.tpTargetTag || ''}" style="flex:1">
                    <button class="ed-btn apply-oneclick" id="btnPickTpTarget3D" type="button" title="Кликнуть по объекту-цели в 3D сцене">🎯 В 3D</button>
                  </div>
                  ${otherBlocksOptionsHTML ? `
                    <div class="prop-row">
                      <label>Из списка</label>
                      <select class="ed-inp" id="selItTpTargetList">
                        <option value="">Выбрать объект сцены...</option>
                        ${otherBlocksOptionsHTML}
                      </select>
                    </div>
                  ` : ''}
                ` : ''}
              </div>
            ` : ''}

            ${it.actionType === 'checkpoint' ? `
              <div style="background:rgba(255,234,167,0.08);border:1px solid rgba(255,234,167,0.35);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
                <div class="prop-row"><label>Этап # / Имя</label>
                  <input type="number" min="1" class="ed-inp" id="inpItCpStg" value="${it.cpStage || 1}" style="width:55px">
                  <input class="ed-inp" id="inpItCpTitle" value="${it.cpTitle || 'Чекпоинт'}" style="flex:1">
                </div>
                <div class="prop-row"><label>Награда R$ / Мест</label><div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="10" class="ed-inp" id="inpItCpCash" value="${it.cpCash ?? 50}" title="Награда монет R$">
                  <input type="number" min="0" class="ed-inp" id="inpItCpSkip" value="${it.cpSkip ?? 2}" title="Продвижение в очереди">
                </div></div>
              </div>
            ` : ''}

            ${it.actionType === 'impulse' ? `
              <div style="background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.3);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
                <div class="prop-row"><label>Толчок X/Y/Z</label><div class="vec3">
                  <input type="number" step="1" class="ed-inp" id="inpItImpX" value="${it.impulseX ?? 0}">
                  <input type="number" step="1" class="ed-inp" id="inpItImpY" value="${it.impulseY ?? 16}">
                  <input type="number" step="1" class="ed-inp" id="inpItImpZ" value="${it.impulseZ ?? 0}">
                </div></div>
              </div>
            ` : ''}

            ${it.actionType === 'reward' ? `
              <div style="background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.3);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
                <div class="prop-row">
                  <label>Что выдаёт</label>
                  <select class="ed-inp" id="inpItRewardType">
                    <option value="cash" ${it.rewardType === 'cash' ? 'selected' : ''}>🪙 Монеты (+R$)</option>
                    <option value="speed" ${it.rewardType === 'speed' ? 'selected' : ''}>🌀 Пружина Скорости (+55% бег)</option>
                    <option value="grav" ${it.rewardType === 'grav' ? 'selected' : ''}>🚀 Пружина Прыжка (Gravity)</option>
                    <option value="halo" ${it.rewardType === 'halo' ? 'selected' : ''}>😇 VIP Нимб (x2 R$)</option>
                    <option value="heal" ${it.rewardType === 'heal' ? 'selected' : ''}>❤️ Полное лечение (+25 Макс. HP)</option>
                    <option value="damage" ${it.rewardType === 'damage' ? 'selected' : ''}>🥊 Сила удара (+15 урона)</option>
                  </select>
                </div>
                ${it.rewardType === 'cash' ? `
                  <div class="prop-row">
                    <label>Сумма (+R$)</label>
                    <input type="number" step="5" min="1" class="ed-inp" id="inpItRewardCash" value="${it.rewardCash ?? 25}">
                  </div>
                ` : ''}
              </div>
            ` : ''}

            ${it.actionType === 'ghost_pass' ? `
              <div class="prop-row">
                <label>Время прохода(с)</label>
                <input type="number" step="0.5" min="0" class="ed-inp" id="inpItGhostT" value="${it.ghostTime ?? 4.0}">
              </div>
            ` : ''}

            <div style="border-top:1px dashed #283147;padding-top:6px;margin-top:2px;display:flex;flex-direction:column;gap:5px">
              <div class="prop-row">
                <label>Расходуемость</label>
                <select class="ed-inp" id="inpItConsume">
                  <option value="infinite" ${it.consumeMode === 'infinite' ? 'selected' : ''}>♾️ Не тратится (Бесконечный)</option>
                  <option value="charges" ${it.consumeMode === 'charges' ? 'selected' : ''}>🔋 Тратится частично (По зарядам)</option>
                  <option value="destroy_instant" ${it.consumeMode === 'destroy_instant' ? 'selected' : ''}>💥 Уничтожается сразу (Одноразовый)</option>
                </select>
              </div>

              ${it.consumeMode === 'charges' ? `
                <div class="prop-row">
                  <label>Зарядов / Трата</label>
                  <div class="vec3" style="grid-template-columns:1fr 1fr">
                    <input type="number" step="1" min="1" class="ed-inp" id="inpItMaxChg" value="${it.maxCharges ?? 3}" title="Всего зарядов у объекта">
                    <input type="number" step="1" min="1" class="ed-inp" id="inpItCostChg" value="${it.costPerUse ?? 1}" title="Сколько тратится за 1 срабатывание">
                  </div>
                </div>
              ` : ''}

              ${it.consumeMode !== 'infinite' ? `
                <div class="prop-row">
                  <label>После траты</label>
                  <select class="ed-inp" id="inpItDeplete">
                    <option value="respawn" ${it.depleteAction === 'respawn' ? 'selected' : ''}>🔄 Восстановиться через N сек (Респавн)</option>
                    <option value="destroy" ${it.depleteAction === 'destroy' ? 'selected' : ''}>🗑️ Уничтожиться полностью</option>
                    <option value="disable" ${it.depleteAction === 'disable' ? 'selected' : ''}>🔒 Отключиться (остаться декорацией)</option>
                  </select>
                </div>
                ${it.depleteAction === 'respawn' ? `
                  <div class="prop-row">
                    <label>Респавн (сек)</label>
                    <input type="number" step="0.5" min="0.5" class="ed-inp" id="inpItRespT" value="${it.respawnTime ?? 5.0}">
                  </div>
                ` : ''}
              ` : ''}

              <div class="prop-row">
                <label>Кулдаун (сек)</label>
                <input type="number" step="0.2" min="0.1" class="ed-inp" id="inpItCd" value="${it.cooldown ?? 0.8}" style="width:75px">
                <label style="flex:1;text-align:right">3D-Вывеска</label>
                <input type="checkbox" id="inpItBadge" ${it.showBadge !== false ? 'checked' : ''}>
              </div>
              <div class="prop-row">
                <label>Текст подсказки</label>
                <input class="ed-inp" id="inpItPrompt" placeholder="Авто-надпись..." value="${it.promptText || ''}">
              </div>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- 5. КОМПОНЕНТ: ⚙️ ДВИЖЕНИЕ И ТРАЕКТОРИЯ (ПЕТЛИ + МНОГОТОЧЕЧНЫЙ ПУТЬ + 3D-МАРКЕРЫ) -->
      ${comps.motion?.enabled ? `
        <div class="ecs-comp-card" style="border-color:#00d2ff">
          <div class="ecs-comp-head" data-comp-toggle="motion">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.motion.collapsed ? '▶' : '▼'}</span>
              <span>⚙️ Движение и Траектория (${md.waypoints.length} точ.)</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="motion" type="button" title="Удалить движение">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.motion.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label title="Вокруг какого края или точки вращается/масштабируется объект">Точка опоры (Петли)</label>
              <select class="ed-inp" id="inpMotPivot">
                <option value="center" ${md.pivotMode === 'center' ? 'selected' : ''}>🎯 Центр объекта (0, 0, 0)</option>
                <option value="left" ${md.pivotMode === 'left' ? 'selected' : ''}>🚪 Левый край (-X) — Дверная петля слева</option>
                <option value="right" ${md.pivotMode === 'right' ? 'selected' : ''}>🚪 Правый край (+X) — Дверная петля справа</option>
                <option value="bottom" ${md.pivotMode === 'bottom' ? 'selected' : ''}>📐 Нижний край (-Y) — Откидной мост / Люк</option>
                <option value="top" ${md.pivotMode === 'top' ? 'selected' : ''}>📐 Верхний край (+Y) — Подъёмные ворота</option>
                <option value="front" ${md.pivotMode === 'front' ? 'selected' : ''}>📐 Передний край (+Z)</option>
                <option value="back" ${md.pivotMode === 'back' ? 'selected' : ''}>📐 Задний край (-Z)</option>
                <option value="custom" ${md.pivotMode === 'custom' ? 'selected' : ''}>⚙️ Свой отступ пивота (X, Y, Z)</option>
              </select>
            </div>

            ${md.pivotMode === 'custom' ? `
              <div class="prop-row"><label>Пивот X/Y/Z</label><div class="vec3">
                <input type="number" step="0.25" class="ed-inp" id="inpMotPivX" value="${md.pivotX || 0}">
                <input type="number" step="0.25" class="ed-inp" id="inpMotPivY" value="${md.pivotY || 0}">
                <input type="number" step="0.25" class="ed-inp" id="inpMotPivZ" value="${md.pivotZ || 0}">
              </div></div>
            ` : ''}

            <div class="prop-row">
              <label>Запуск движ.</label>
              <select class="ed-inp" id="inpMotTrig">
                <option value="signal" ${md.triggerMode === 'signal' ? 'selected' : ''}>🔗 По сигналу (от ручки / кнопки / связи)</option>
                <option value="self" ${md.triggerMode === 'self' ? 'selected' : ''}>🖐️ При взаимодействии с самим объектом</option>
                <option value="auto_loop" ${md.triggerMode === 'auto_loop' ? 'selected' : ''}>🔄 Автоматически со старта игры</option>
              </select>
            </div>

            <div class="prop-row">
              <label title="Страховка от прокрутки двери по кругу: как объект возвращается назад">Режим цикла</label>
              <select class="ed-inp" id="inpMotLoop">
                <option value="toggle" ${md.loopMode === 'toggle' ? 'selected' : ''}>⇄ Переключатель (1-й раз Туда, 2-й Обратно в старт)</option>
                <option value="auto_return" ${md.loopMode === 'auto_return' ? 'selected' : ''}>⏱️ С авто-возвратом в старт через паузу</option>
                <option value="step" ${md.loopMode === 'step' ? 'selected' : ''}>👣 Пошагово по точкам (затем возврат в старт)</option>
                <option value="one_shot" ${md.loopMode === 'one_shot' ? 'selected' : ''}>1️⃣ Одноразово (остаётся в конечной точке)</option>
                <option value="ping_pong" ${md.loopMode === 'ping_pong' ? 'selected' : ''}>♾️ Вечный Пинг-Понг (Туда-Обратно)</option>
                <option value="loop" ${md.loopMode === 'loop' ? 'selected' : ''}>🔄 Вечный цикл по кругу</option>
              </select>
            </div>

            <div style="background:rgba(0,210,255,0.07);border:1px solid rgba(0,210,255,0.3);border-radius:8px;padding:7px;display:flex;flex-direction:column;gap:6px">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:4px">
                <span style="font:800 9.5px var(--f);color:#56f0ff;text-transform:uppercase">📍 Точки маршрута (${md.waypoints.length}):</span>
                <div style="display:flex;gap:4px">
                  <button class="ed-btn apply-oneclick" id="btnAddWaypoint" type="button" style="padding:2px 7px;font-size:10px">➕ Точка</button>
                  ${md.waypoints.length > 1 ? `<button class="ed-btn danger" id="btnDelWaypoint" type="button" style="padding:2px 6px;font-size:10px" title="Удалить выбранную точку">🗑️</button>` : ''}
                </div>
              </div>

              <div style="display:flex;gap:4px;flex-wrap:wrap">
                ${wpTabsHTML}
              </div>

              <div style="display:flex;gap:4px">
                <button class="ed-btn ${isEditingWpIn3D ? 'active' : ''}" id="btnToggleWpGizmo3D" type="button" style="flex:1;justify-content:center;border-color:#ffce3a">
                  ${isEditingWpIn3D ? '📦 Вернуть Гизмо на сам объект' : `📍 Двигать маркер Точки #${wpIdx + 1} в 3D`}
                </button>
              </div>

              <div class="prop-row">
                <label>Смещение ΔX/Y/Z</label>
                <div class="vec3">
                  <input type="number" step="0.5" class="ed-inp" id="inpWpDX" value="${Number(curWp.dx || 0).toFixed(2)}" title="Смещение по X от старта">
                  <input type="number" step="0.5" class="ed-inp" id="inpWpDY" value="${Number(curWp.dy || 0).toFixed(2)}" title="Смещение по Y от старта">
                  <input type="number" step="0.5" class="ed-inp" id="inpWpDZ" value="${Number(curWp.dz || 0).toFixed(2)}" title="Смещение по Z от старта">
                </div>
              </div>
              <div class="prop-row">
                <label>Поворот Δ° X/Y/Z</label>
                <div class="vec3">
                  <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpWpRX" value="${Number(curWp.rx || 0).toFixed(1)}" title="Поворот по X в градусах">
                  <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpWpRY" value="${Number(curWp.ry || 0).toFixed(1)}" title="Поворот по Y в градусах (напр. 90 для двери)">
                  <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpWpRZ" value="${Number(curWp.rz || 0).toFixed(1)}" title="Поворот по Z в градусах">
                </div>
              </div>
              <div class="prop-row">
                <label>Размер Ш/В/Г</label>
                <div class="vec3">
                  <input type="number" step="0.25" min="0.1" class="ed-inp" id="inpWpSX" value="${Number(curWp.sx ?? box.w).toFixed(2)}" title="Ширина X в этой точке">
                  <input type="number" step="0.25" min="0.1" class="ed-inp" id="inpWpSY" value="${Number(curWp.sy ?? box.h).toFixed(2)}" title="Высота Y в этой точке">
                  <input type="number" step="0.25" min="0.1" class="ed-inp" id="inpWpSZ" value="${Number(curWp.sz ?? box.d).toFixed(2)}" title="Глубина Z в этой точке">
                </div>
              </div>
            </div>

            <div class="prop-row">
              <label>Скорость / Кулд.</label>
              <div class="vec3" style="grid-template-columns:1fr 1fr">
                <input type="number" step="0.2" min="0.1" max="20" class="ed-inp" id="inpMotSpd" value="${md.speed ?? 1.5}" title="Скорость воспроизведения">
                <input type="number" step="0.2" min="0" class="ed-inp" id="inpMotCd" value="${md.cooldown ?? 0.4}" title="Кулдаун между запусками (сек)">
              </div>
            </div>

            ${md.loopMode === 'auto_return' ? `
              <div class="prop-row">
                <label>Пауза до возвр.(с)</label>
                <input type="number" step="0.5" min="0.2" class="ed-inp" id="inpMotStay" value="${md.stayTime ?? 3.0}">
              </div>
            ` : ''}

            <button class="ed-btn apply-oneclick" id="btnPreviewMotionPath" type="button" style="justify-content:center">
              ▶ Проверить движение по точкам в Studio
            </button>
          </div>
        </div>
      ` : ''}

      <!-- 6. КОМПОНЕНТ: 🔗 СВЯЗИ И СИГНАЛЫ (РУЧКА ДВЕРИ / РЫЧАГ / КНОПКА) -->
      ${comps.signal?.enabled ? `
        <div class="ecs-comp-card" style="border-color:#ffce3a">
          <div class="ecs-comp-head" data-comp-toggle="signal">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.signal.collapsed ? '▶' : '▼'}</span>
              <span>🔗 Связи и Сигналы (Триггер)</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="signal" type="button" title="Удалить связи">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.signal.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label title="Имя/тег этого объекта, чтобы на него могли ссылаться другие">Свой тег (#)</label>
              <input class="ed-inp" id="inpSigTag" placeholder="напр. door_1" value="${sg.tag || ''}">
            </div>

            <div class="prop-row">
              <label>Связанный объект</label>
              <input class="ed-inp" id="inpSigTarget" placeholder="ID или #тег цели" value="${sg.targetTag || ''}" style="flex:1">
              <button class="ed-btn apply-oneclick" id="btnPickSigTarget3D" type="button" title="Кликнуть по целевому объекту (например, двери) прямо в 3D-сцене">🎯 В 3D</button>
            </div>

            ${otherBlocksOptionsHTML ? `
              <div class="prop-row">
                <label>Выбрать из сцены</label>
                <select class="ed-inp" id="selSigTargetList">
                  <option value="">-- Выбери объект на сцене --</option>
                  ${otherBlocksOptionsHTML}
                </select>
              </div>
            ` : ''}

            <div class="prop-row">
              <label>Сигнал цели</label>
              <select class="ed-inp" id="inpSigAct">
                <option value="toggle_motion" ${sg.signalAction === 'toggle_motion' ? 'selected' : ''}>⇄ Движение цели: Переключить (Туда / Обратно)</option>
                <option value="forward_motion" ${sg.signalAction === 'forward_motion' ? 'selected' : ''}>▶ Движение цели: Запустить вперёд (Открыть)</option>
                <option value="reverse_motion" ${sg.signalAction === 'reverse_motion' ? 'selected' : ''}>◀ Движение цели: Вернуть в старт (Закрыть)</option>
                <option value="trigger_target" ${sg.signalAction === 'trigger_target' ? 'selected' : ''}>⚡ Сработать эффект взаимодействия цели</option>
              </select>
            </div>

            <div class="prop-row">
              <label>Отклик триггера</label>
              <select class="ed-inp" id="inpSigSelfAnim">
                <option value="none" ${sg.selfAnim === 'none' ? 'selected' : ''}>🔴 Без анимации</option>
                <option value="lever_tilt" ${sg.selfAnim === 'lever_tilt' ? 'selected' : ''}>🕹️ Ручка двери / Рычаг (Дёргается при нажатии)</option>
                <option value="button_press" ${sg.selfAnim === 'button_press' ? 'selected' : ''}>🔘 Кнопка / Плита (Вдавливается при нажатии)</option>
              </select>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- 7. КОМПОНЕНТ: 💰 ПЛАТА / ЦЕНА (ОТДЕЛЬНОЕ СВОЙСТВО) -->
      ${comps.cost?.enabled ? `
        <div class="ecs-comp-card" style="border-color:#00e676">
          <div class="ecs-comp-head" data-comp-toggle="cost">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.cost.collapsed ? '▶' : '▼'}</span>
              <span>💰 Плата за активацию (${ct.amount || 0} R$)</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="cost" type="button" title="Удалить плату">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.cost.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label>Цена (R$)</label>
              <input type="number" min="1" step="10" class="ed-inp" id="inpCostAmt" value="${ct.amount ?? 50}" style="width:90px">
              <label style="flex:1;text-align:right">Платить 1 раз</label>
              <input type="checkbox" id="inpCostOneTime" ${ct.oneTimeBuy !== false ? 'checked' : ''}>
            </div>
            <div style="font-size:10px;color:#8fa0bd">
              Пока цена не оплачена, игрок не сможет активировать движение, связь, телепорт или бонус этого объекта.
            </div>
          </div>
        </div>
      ` : ''}

      <!-- 8. КОМПОНЕНТ: ⚔️ ПРЕДМЕТ / ОРУЖИЕ -->
      ${comps.item?.enabled && itm ? `
        <div class="ecs-comp-card" style="border-color:#ff9f43">
          <div class="ecs-comp-head" data-comp-toggle="item">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.item.collapsed ? '▶' : '▼'}</span>
              <span>⚔️ Предмет / Оружие (${itm.icon || '🗡️'})</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="item" type="button" title="Удалить свойство Предмета">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.item.collapsed ? 'hidden' : ''}>
            <div style="font-size:10px;color:#ffd54f;line-height:1.35;background:rgba(255,159,67,0.1);padding:6px;border-radius:6px;border:1px solid rgba(255,159,67,0.3)">
              💡 Все дочерние примитивы этого объекта в Иерархии (например: лезвие, гарда, рукоять) автоматически собираются в единый предмет!
            </div>
            <div class="prop-row">
              <label>Хват в руках</label>
              <select class="ed-inp" id="inpCompItmHold">
                <option value="held" ${itm.holdMode === 'held' ? 'selected' : ''}>🤚 Удерживаемый (1 рука, в Хотбар)</option>
                <option value="carried" ${itm.holdMode === 'carried' ? 'selected' : ''}>📦 Переносимый (2 руки перед собой)</option>
              </select>
            </div>
            <div class="prop-row">
              <label>Роль / Тип</label>
              <select class="ed-inp" id="inpCompItmUse">
                <option value="melee" ${itm.useType === 'melee' ? 'selected' : ''}>🗡️ Оружие ближнего боя (Меч, Нож, Молот)</option>
                <option value="ranged" ${itm.useType === 'ranged' ? 'selected' : ''}>🔫 Оружие дальнего боя (Бластер, Посох)</option>
                <option value="throwable" ${itm.useType === 'throwable' ? 'selected' : ''}>💣 Метательный снаряд (Граната, Бомба)</option>
                <option value="consumable" ${itm.useType === 'consumable' ? 'selected' : ''}>🍗 Хилка / Еда / Зелье (HP и баффы)</option>
                <option value="shield" ${itm.useType === 'shield' ? 'selected' : ''}>🛡️ Щит / Экипировка (+HP и Броня)</option>
                <option value="torch" ${itm.useType === 'torch' ? 'selected' : ''}>🔦 Факел / Фонарь (Свет вокруг)</option>
                <option value="none" ${itm.useType === 'none' ? 'selected' : ''}>📦 Обычный предмет / Декор в руке</option>
              </select>
            </div>
            <div class="prop-row">
              <label>Иконка слота</label>
              <input class="ed-inp" id="inpCompItmIco" value="${itm.icon || '🗡️'}" style="width:48px;text-align:center">
              <span style="font-size:10px;color:#94a3b8">Эмодзи в хотбаре</span>
            </div>

            ${itm.useType === 'melee' ? `
              <div style="background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.3);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
                <div style="font:800 9.5px var(--f);color:#ff8787;text-transform:uppercase">🗡️ Настройки Оружия Ближнего Боя:</div>
                <div class="prop-row"><label>Урон удара</label><input type="number" step="5" min="0" class="ed-inp" id="inpCompItmDmg" value="${itm.damage}"></div>
                <div class="prop-row"><label>Дальн. / Радиус</label><div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="0.2" min="1.5" max="15" class="ed-inp" id="inpCompItmRng" value="${itm.range}">
                  <input type="number" step="0.2" min="0.5" max="8" class="ed-inp" id="inpCompItmRad" value="${itm.radius}">
                </div></div>
                <div class="prop-row"><label>Отдача / Кулд.</label><div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="1" min="0" class="ed-inp" id="inpCompItmKb" value="${itm.knockback}">
                  <input type="number" step="0.05" min="0.1" class="ed-inp" id="inpCompItmCd" value="${itm.cooldown}">
                </div></div>
              </div>
            ` : ''}

            ${itmHasProj ? `
              <div style="background:rgba(255,107,107,0.08);border:1px solid rgba(255,107,107,0.3);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
                <div style="font:800 9.5px var(--f);color:#ff8787;text-transform:uppercase">🔫 Баллистика и Урон Снаряда:</div>
                <div class="prop-row"><label>Урон / Взрыв(м)</label><div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="5" min="0" class="ed-inp" id="inpCompItmDmg" value="${itm.damage}">
                  <input type="number" step="0.5" min="0" class="ed-inp" id="inpCompItmBlast" value="${itm.blastRadius}">
                </div></div>
                <div class="prop-row"><label>Скор. / Темп(с)</label><div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="2" min="4" class="ed-inp" id="inpCompItmPrjSpd" value="${itm.projSpeed}">
                  <input type="number" step="0.05" min="0.05" class="ed-inp" id="inpCompItmCd" value="${itm.cooldown}">
                </div></div>
              </div>
            ` : ''}

            ${itm.useType === 'consumable' ? `
              <div style="background:rgba(0,230,118,0.08);border:1px solid rgba(0,230,118,0.3);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:5px">
                <div style="font:800 9.5px var(--f);color:#69f0ae;text-transform:uppercase">🍗 Эффект Хилки / Зелья:</div>
                <div class="prop-row"><label>Эффект HP (+/-)</label><input type="number" step="10" class="ed-inp" id="inpCompItmHeal" value="${itm.healAmount}"></div>
                <div class="prop-row"><label>+Бег / +Прыжок</label><div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="0.5" class="ed-inp" id="inpCompItmBfSpd" value="${itm.buffSpeed}">
                  <input type="number" step="0.5" class="ed-inp" id="inpCompItmBfJmp" value="${itm.buffJump}">
                </div></div>
              </div>
            ` : ''}

            <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:3px">
              <button class="ed-btn apply-oneclick" id="btnCompGivePlayer" type="button" style="flex:1;justify-content:center">🎒 Выдать игроку</button>
              <button class="ed-btn" id="btnCompOpenInStudio3D" type="button" style="flex:1;justify-content:center;border-color:#56f0ff;color:#56f0ff">🛠️ Открыть в 3D Студии</button>
            </div>
          </div>
        </div>
      ` : ''}

      <!-- 9. КОМПОНЕНТ: 🏭 СПАВНЕР ОБЪЕКТОВ -->
      ${comps.spawner?.enabled ? `
        <div class="ecs-comp-card" style="border-color:#9b59b6">
          <div class="ecs-comp-head" data-comp-toggle="spawner">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.spawner.collapsed ? '▶' : '▼'}</span>
              <span>🏭 Спавнер Объектов</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="spawner" type="button" title="Удалить спавнер">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.spawner.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label>Условие</label>
              <select class="ed-inp" id="inpSpMode">
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
        </div>
      ` : ''}

      <!-- 10. КОМПОНЕНТ: 🔊 3D ЗВУК И ИМПАКТ -->
      ${comps.sound?.enabled ? `
        <div class="ecs-comp-card" style="border-color:#56f0ff">
          <div class="ecs-comp-head" data-comp-toggle="sound">
            <div class="ecs-comp-title">
              <span class="ecs-arrow">${comps.sound.collapsed ? '▶' : '▼'}</span>
              <span>🔊 3D Звук и Импакт</span>
            </div>
            <div class="ecs-comp-actions">
              <button class="ecs-comp-del" data-comp-remove="sound" type="button" title="Удалить звук">🗑️</button>
            </div>
          </div>
          <div class="ecs-comp-body" ${comps.sound.collapsed ? 'hidden' : ''}>
            <div class="prop-row">
              <label>Выбор звука</label>
              <select class="ed-inp" id="inpSndId" style="flex:1">
                ${BUILTIN_SFX_LIST.map(s => `<option value="${s.id}" ${snd.soundId === s.id ? 'selected' : ''}>${s.name}</option>`).join('')}
                ${(S.customAudioLibrary || []).map(a => `<option value="custom:${a.id}" ${snd.soundId === 'custom:' + a.id ? 'selected' : ''}>🔊 [Свой] ${a.name}</option>`).join('')}
              </select>
              <button class="ed-btn" id="btnTestObjSnd" type="button" title="Прослушать звук с вариацией питча">▶</button>
            </div>
            <div class="prop-row">
              <label>Когда звучит</label>
              <select class="ed-inp" id="inpSndMode">
                <option value="trigger" ${snd.mode === 'trigger' ? 'selected' : ''}>⚡ При активации / взаимодействии / движении</option>
                <option value="zone_loop" ${snd.mode === 'zone_loop' ? 'selected' : ''}>📡 Постоянно в 3D-радиусе вокруг объекта</option>
              </select>
            </div>
            <div class="prop-row">
              <label>3D Радиус (м)</label>
              <input type="number" min="2" max="100" step="1" class="ed-inp" id="inpSndRad" value="${snd.radius ?? 18}" style="width:70px">
              <label style="flex:1;text-align:right">Вариация питча</label>
              <input type="number" min="0" max="0.4" step="0.02" class="ed-inp" id="inpSndPitchVar" value="${snd.pitchVar ?? 0.1}" style="width:65px" title="Случайный разброс высоты тона (0.1 = ±10%)">
            </div>
            ${snd.mode === 'zone_loop' ? `
              <div class="prop-row">
                <label>Интервал (сек)</label>
                <input type="number" min="0.4" max="30" step="0.2" class="ed-inp" id="inpSndInt" value="${snd.interval ?? 2.5}">
              </div>
            ` : ''}
            <button class="ed-btn apply-oneclick" id="btnUploadObjCustomSnd" type="button" style="justify-content:center">📥 Загрузить свой .MP3/.WAV для этого объекта</button>
          </div>
        </div>
      ` : ''}

      <!-- 11. КОМПОНЕНТ: 🧩 СКРИПТ-АДДОН -->
      ${comps.script?.enabled ? renderScriptAddonInspectorCardHTML(
        box.scriptData || (box.scriptData = createDefaultScriptData('block')),
        'block',
        true
      ) : ''}

      ${addMenuHTML}
    `;

    if ($('btnQuickSavePrefab')) {
      $('btnQuickSavePrefab').onclick = () => saveSelectedObjectAsPrefab();
    }

    if ($('btnToggleAddCompMenu')) {
      $('btnToggleAddCompMenu').onclick = () => {
        const m = $('ecsAddCompMenu');
        if (m) m.hidden = !m.hidden;
      };
    }

    cont.querySelectorAll('[data-add-comp]').forEach(btn => {
      btn.onclick = () => {
        const key = btn.dataset.addComp;
        pushUndoState(`Добавление свойства: ${key}`);
        if (!comps[key]) comps[key] = { enabled: true, collapsed: false };
        comps[key].enabled = true;
        comps[key].collapsed = false;

        if (key === 'visual') {
          if (!box.surfaceType) box.surfaceType = 'smooth';
          comps.visual.surfaceType = box.surfaceType;
        } else if (key === 'spawner') {
          if (!box.spawnerData.mode || box.spawnerData.mode === 'none') {
            box.spawnerData.mode = 'timer';
          }
        } else if (key === 'motion') {
          if (!box.motionData || !Array.isArray(box.motionData.waypoints) || box.motionData.waypoints.length === 0) {
            box.motionData = createDefaultMotionData(box);
          }
        } else if (key === 'signal') {
          if (!box.signalData.tag) {
            box.signalData.tag = 'obj_' + box.id.replace('blk_', '');
          }
        } else if (key === 'item') {
          if (!comps.item.itemData) {
            comps.item.itemData = createStarterItemTemplate('sword');
            comps.item.itemData.name = box.label || 'Мой Меч';
          }
        } else if (key === 'sound') {
          if (!box.soundData) box.soundData = createDefaultSoundData();
          comps.sound.soundData = box.soundData;
        } else if (key === 'script') {
          if (!box.scriptData) box.scriptData = createDefaultScriptData('block');
          box.scriptData.enabled = true;
          comps.script.enabled = true;
        }

        sfx.jump();
        syncBlockComponentsState(box);
        rebuildPhysicsArrays();
        if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncBlockUpsert(box, false);
        }
        refreshHierarchyUI();
        _renderInspectorUICore();
      };
    });

    cont.querySelectorAll('[data-comp-toggle]').forEach(head => {
      head.onclick = e => {
        if (e.target.closest('button')) return;
        const key = head.dataset.compToggle;
        if (comps[key]) {
          comps[key].collapsed = !comps[key].collapsed;
          _renderInspectorUICore();
        }
      };
    });

    cont.querySelectorAll('[data-comp-remove]').forEach(btn => {
      btn.onclick = e => {
        e.stopPropagation();
        const key = btn.dataset.compRemove;
        pushUndoState(`Удаление свойства: ${key}`);
        if (comps[key]) comps[key].enabled = false;

        if (key === 'visual') {
          box.particleData.enabled = false;
          box.lightData.mode = 'none';
        } else if (key === 'spawner') {
          box.spawnerData.mode = 'none';
        } else if (key === 'motion' && selectedRef.editMode === 'motion_wp') {
          selectedRef.editMode = 'root';
          selectEditorObject({ kind: 'block', box }, true);
          return;
        } else if (key === 'sound') {
          box.soundData = null;
        }

        sfx.oof();
        syncBlockComponentsState(box);
        rebuildPhysicsArrays();
        if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncBlockUpsert(box, false);
        }
        refreshHierarchyUI();
        _renderInspectorUICore();
      };
    });

    $('inpBlkName').oninput = e => {
      box.label = e.target.value;
      if (comps.item?.itemData) comps.item.itemData.name = box.label;
      syncBlockSpecialVisuals(box);
      refreshHierarchyUI();
    };

    const applyVec = () => {
      recordHierarchyBaseline(selectedRef);
      box.m.position.set(+$('inpPX').value || 0, +$('inpPY').value || 0, +$('inpPZ').value || 0);
      box.m.scale.set(
        Math.max(0.1, +$('inpSX').value || 1),
        Math.max(0.1, +$('inpSY').value || 1),
        Math.max(0.1, +$('inpSZ').value || 1)
      );
      box.m.rotation.set(
        snapAngleRad(THREE.MathUtils.degToRad(+$('inpRX').value || 0)),
        snapAngleRad(THREE.MathUtils.degToRad(+$('inpRY').value || 0)),
        snapAngleRad(THREE.MathUtils.degToRad(+$('inpRZ').value || 0))
      );
      if (box.logicRuntime) {
        box.logicRuntime.basePos = box.m.position.clone();
        box.logicRuntime.baseQuat = box.m.quaternion.clone();
        box.logicRuntime.baseScale = box.m.scale.clone();
      }
      box.w = box.m.scale.x;
      box.h = box.m.scale.y;
      box.d = box.m.scale.z;
      box.cx = box.m.position.x;
      box.cy = box.m.position.y;
      box.cz = box.m.position.z;
      box.x = box.m.position.x;
      box.y = box.m.position.y + box.h / 2;
      box.z = box.m.position.z;
      box.rx = box.m.rotation.x;
      box.ry = box.m.rotation.y;
      box.rz = box.m.rotation.z;
      if ($('inpCX')) {
        box.colliderScale = {
          x: Math.max(0.1, +$('inpCX').value || 1),
          y: Math.max(0.1, +$('inpCY').value || 1),
          z: Math.max(0.1, +$('inpCZ').value || 1)
        };
      }
      if (box.cpVisualGroup) {
        box.cpVisualGroup.position.copy(box.m.position);
        if (box.checkpointData?.enabled) box.cpVisualGroup.rotation.copy(box.m.rotation);
      }
      if (box.haloSprite) box.haloSprite.position.copy(box.m.position);
      box.m.updateMatrixWorld(true);
      rebuildPhysicsArrays();
      selBoxHelper.setFromObject(box.m);
      propagateHierarchyTransform(selectedRef);
    };
    ['inpPX', 'inpPY', 'inpPZ', 'inpSX', 'inpSY', 'inpSZ', 'inpRX', 'inpRY', 'inpRZ', 'inpCX', 'inpCY', 'inpCZ'].forEach(id => {
      if (!$(id)) return;
      $(id).onfocus = () => {
        pushUndoState('Трансформация объекта');
        recordHierarchyBaseline(selectedRef);
      };
      $(id).oninput = applyVec;
    });

    if ($('inpBlkShape')) {
      $('inpBlkShape').onchange = e => {
        pushUndoState('Смена геометрической формы');
        box.shape = e.target.value;
        syncBlockComponentsState(box);
        rebuildPhysicsArrays();
        if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncBlockUpsert(box, false);
        }
        selBoxHelper.setFromObject(box.m);
        refreshHierarchyUI();
        _renderInspectorUICore();
      };
    }

    const applyLoadedBBModelToBox = modelData => {
      pushUndoState('Установка 3D-модели .bbmodel');
      const extracted = extractBBModelParts(modelData, 8);
      box.label = modelData.name || box.label;

      if (extracted.parts.length > 1) {
        const rootPos = box.m.position.clone();
        const rootQuat = box.m.quaternion.clone();
        box.shape = 'none';
        box.bbmodelData = null;
        ensureBlockComponents(box);
        box.components.geometry.enabled = false;
        box.components.visual.enabled = false;
        box.m.scale.set(extracted.totalSize.w, extracted.totalSize.h, extracted.totalSize.d);
        box.w = extracted.totalSize.w;
        box.h = extracted.totalSize.h;
        box.d = extracted.totalSize.d;
        syncBlockComponentsState(box);

        for (const ep of extracted.parts) {
          const offset = new THREE.Vector3(ep.dx, ep.dy, ep.dz).applyQuaternion(rootQuat);
          const childPos = rootPos.clone().add(offset);
          const childQuat = rootQuat.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(ep.rx, ep.ry, ep.rz)));
          const childEuler = new THREE.Euler().setFromQuaternion(childQuat);

          const chBox = addSceneBlock({
            x: childPos.x,
            y: childPos.y + ep.h * 0.5,
            z: childPos.z,
            w: ep.w,
            h: ep.h,
            d: ep.d,
            shape: 'bbmodel',
            bbmodelData: ep.bbmodelData,
            colorHex: '#ffffff',
            label: ep.name,
            isCustom: true
          });
          chBox.m.position.copy(childPos);
          chBox.m.rotation.copy(childEuler);
          chBox.m.updateMatrixWorld(true);
          chBox.parentKey = `block:${box.id}`;
          chBox.weldToParent = true;
          syncBlockComponentsState(chBox);
        }
        box.hierCollapsed = false;
      } else {
        box.shape = 'bbmodel';
        box.bbmodelData = JSON.parse(JSON.stringify(modelData));
        ensureBlockComponents(box);
        box.components.geometry.enabled = true;
        syncBlockComponentsState(box);
        const nat = box.bbmodelGroup?.userData?.naturalSize;
        if (nat) {
          box.m.scale.set(nat.w, nat.h, nat.d);
          box.w = nat.w; box.h = nat.h; box.d = nat.d;
        }
      }

      rebuildPhysicsArrays();
      refreshPrefabDockUI();
      selectEditorObject({ kind: 'block', box });
    };

    if ($('btnUploadBBModel')) {
      $('btnUploadBBModel').onclick = () => promptUploadBBModel(applyLoadedBBModelToBox);
    }
    if ($('selBBModelLib')) {
      $('selBBModelLib').onchange = e => {
        const m = (S.customModelsLibrary || [])[+e.target.value];
        if (m) applyLoadedBBModelToBox(m);
      };
    }
    if ($('btnFitBBModelSize')) {
      $('btnFitBBModelSize').onclick = () => {
        const nat = box.bbmodelGroup?.userData?.naturalSize;
        if (!nat) return;
        pushUndoState('Пропорции .bbmodel');
        box.m.scale.set(nat.w, nat.h, nat.d);
        box.w = nat.w; box.h = nat.h; box.d = nat.d;
        rebuildPhysicsArrays();
        selBoxHelper.setFromObject(box.m);
        renderInspectorUI();
      };
    }

    if ($('inpBlkCol')) {
      $('inpBlkCol').onfocus = () => pushUndoState('Смена цвета объекта');
      $('inpBlkCol').oninput = e => {
        box.colorHex = e.target.value;
        if (box.m.material && box.m.material.color) {
          box.m.material.color.set(box.colorHex);
        }
        syncBlockLightVisuals(box);
      };
    }
    if ($('inpBlkSurface')) {
      $('inpBlkSurface').onchange = e => {
        pushUndoState('Смена материала поверхности');
        box.surfaceType = e.target.value;
        comps.visual.surfaceType = box.surfaceType;
        syncBlockComponentsState(box);
      };
    }
    if ($('btnEditBlockStuds')) $('btnEditBlockStuds').onclick = () => openPaintModal('block');
    if ($('btnClearBlockSpr')) {
      $('btnClearBlockSpr').onclick = () => {
        pushUndoState('Удаление принта');
        box.customTexDataURL = null;
        setMeshFrontSprite(box.m, null);
        _renderInspectorUICore();
      };
    }
    if ($('inpLightMode')) {
      $('inpLightMode').onchange = e => {
        pushUndoState('Смена режима свечения');
        ld.mode = e.target.value;
        if (!ld.color) ld.color = box.colorHex;
        syncBlockLightVisuals(box);
        _renderInspectorUICore();
      };
    }
    if ($('inpLightCol')) {
      $('inpLightCol').onfocus = () => pushUndoState('Смена цвета свечения');
      $('inpLightCol').oninput = e => {
        ld.color = e.target.value;
        syncBlockLightVisuals(box);
      };
    }
    if ($('btnLightMatchBlk')) {
      $('btnLightMatchBlk').onclick = () => {
        ld.color = box.colorHex;
        $('inpLightCol').value = box.colorHex;
        syncBlockLightVisuals(box);
      };
    }
    if ($('inpLightInt')) {
      $('inpLightInt').oninput = e => {
        ld.intensity = clamp(+e.target.value || 1.2, 0.1, 5.0);
        if ($('txtLightInt')) $('txtLightInt').textContent = ld.intensity.toFixed(1);
        syncBlockLightVisuals(box);
      };
    }
    if ($('inpLightDist')) $('inpLightDist').oninput = e => { ld.distance = clamp(+e.target.value || 14, 2, 80); };
    if ($('inpLightPulse')) {
      $('inpLightPulse').oninput = e => {
        ld.pulseSpeed = clamp(+e.target.value || 0, 0, 5);
        if ($('txtLightPulse')) $('txtLightPulse').textContent = ld.pulseSpeed.toFixed(1);
        syncBlockLightVisuals(box);
      };
    }
    if ($('inpPtOn')) {
      const syncPt = () => {
        pd.enabled = $('inpPtOn').checked;
        if ($('ptFields')) $('ptFields').hidden = !pd.enabled;
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
      ].forEach(id => {
        if ($(id)) $(id).oninput = syncPt;
      });
      if ($('btnPaintParticle')) $('btnPaintParticle').onclick = () => openPaintModal('particle');
    }

    if ($('inpMatter')) {
      $('inpMatter').onchange = e => {
        pushUndoState('Смена состояния материи');
        box.matterState = e.target.value;
        syncBlockComponentsState(box);
        rebuildPhysicsArrays();
        if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncBlockUpsert(box, false);
        }
        refreshHierarchyUI();
        _renderInspectorUICore();
      };
    }
    if ($('inpBlkDynPhys')) {
      $('inpBlkDynPhys').onchange = e => {
        pushUndoState('Переключение динамической физики блока');
        box.isDynamicPhysics = e.target.checked;
        if (box.components?.physics) box.components.physics.isDynamicPhysics = box.isDynamicPhysics;
        box.physVx = 0;
        box.physVy = 0;
        box.physVz = 0;
        if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncBlockUpsert(box, false);
        }
        _renderInspectorUICore();
      };
    }
    if ($('inpBlkWeldParent')) {
      $('inpBlkWeldParent').onchange = e => {
        box.weldToParent = e.target.checked;
        if (box.components?.physics) box.components.physics.weldToParent = box.weldToParent;
      };
    }
    if ($('inpBlkWeight')) {
      $('inpBlkWeight').oninput = e => {
        const val = Number(e.target.value);
        box.weight = clamp(Number.isNaN(val) ? 15 : val, -5000, 10000);
        if (box.components?.physics) box.components.physics.weight = box.weight;
      };
      $('inpBlkWeight').onchange = () => _renderInspectorUICore();
    }
    cont.querySelectorAll('[data-w-preset]').forEach(btn => {
      btn.onclick = () => {
        box.weight = +btn.dataset.wPreset;
        if (box.components?.physics) box.components.physics.weight = box.weight;
        _renderInspectorUICore();
      };
    });
    const startPickConstraintIn3D = cType => {
      showBanner(
        cType === 'rope'
          ? `🔗 Кликни мышкой по другому блоку в 3D-сцене, чтобы связать его верёвкой с «${box.label}»!`
          : `🔥 Кликни мышкой по другому блоку в 3D-сцене, чтобы намертво приварить его к «${box.label}»!`,
        '#ffce3a'
      );
      S.pickingTargetCallback = targetBox => {
        S.pickingTargetCallback = null;
        if (!targetBox || targetBox === box) return;
        if (!Array.isArray(S.physicsConstraints)) S.physicsConstraints = [];
        const dist = Math.max(0.5, Number(box.m.position.distanceTo(targetBox.m.position).toFixed(2)));
        S.physicsConstraints.push({
          id: 'cstr_' + Date.now() + '_' + Math.floor(Math.random() * 999),
          type: cType,
          blockAId: box.id,
          blockBId: targetBox.id,
          localAnchorA: { x: 0, y: 0, z: 0 },
          localAnchorB: { x: 0, y: 0, z: 0 },
          maxLength: dist,
          springiness: 0.25,
          thickness: 0.08,
          color: '#ffce3a'
        });
        sfx.coil?.();
        showBanner(
          cType === 'rope'
            ? `🔗 Верёвка создана: «${box.label}» ⇄ «${targetBox.label}» (${dist}м)`
            : `🔥 Сварка создана: «${box.label}» ➕ «${targetBox.label}»`,
          '#00e676'
        );
        _renderInspectorUICore();
      };
    };
    if ($('btnPickRope3D')) $('btnPickRope3D').onclick = () => startPickConstraintIn3D('rope');
    if ($('btnPickWeld3D')) $('btnPickWeld3D').onclick = () => startPickConstraintIn3D('weld');

    cont.querySelectorAll('[data-del-cstr]').forEach(btn => {
      btn.onclick = () => {
        const cid = btn.dataset.delCstr;
        S.physicsConstraints = (S.physicsConstraints || []).filter(c => c.id !== cid);
        sfx.oof?.();
        _renderInspectorUICore();
      };
    });
    cont.querySelectorAll('[data-cstr-len]').forEach(inp => {
      inp.oninput = e => {
        const c = (S.physicsConstraints || []).find(x => x.id === inp.dataset.cstrLen);
        if (c) c.maxLength = Math.max(0.2, +e.target.value || 4);
      };
    });
    cont.querySelectorAll('[data-cstr-spr]').forEach(inp => {
      inp.oninput = e => {
        const c = (S.physicsConstraints || []).find(x => x.id === inp.dataset.cstrSpr);
        if (c) c.springiness = clamp(+e.target.value || 0, 0, 1);
      };
    });
    cont.querySelectorAll('[data-cstr-col]').forEach(inp => {
      inp.oninput = e => {
        const c = (S.physicsConstraints || []).find(x => x.id === inp.dataset.cstrCol);
        if (c) c.color = e.target.value || '#ffce3a';
      };
    });
    cont.querySelectorAll('[data-cstr-thk]').forEach(inp => {
      inp.oninput = e => {
        const c = (S.physicsConstraints || []).find(x => x.id === inp.dataset.cstrThk);
        if (c) c.thickness = clamp(+e.target.value || 0.08, 0.015, 0.6);
      };
    });
    if ($('inpLiqPhysOn')) {
      $('inpLiqPhysOn').onchange = e => {
        box.liquidPhysicsEnabled = e.target.checked;
        if (box.components?.physics) box.components.physics.liquidPhysicsEnabled = box.liquidPhysicsEnabled;
        _renderInspectorUICore();
      };
    }
    if ($('inpLiqBuoyancy')) {
      $('inpLiqBuoyancy').oninput = e => {
        box.liquidBuoyancy = clamp(+e.target.value || 45, 1, 5000);
        if (box.components?.physics) box.components.physics.liquidBuoyancy = box.liquidBuoyancy;
      };
    }
    if ($('inpLiqDrag')) {
      $('inpLiqDrag').oninput = e => {
        box.liquidDrag = clamp(+e.target.value || 3.5, 0.2, 25);
        if (box.components?.physics) box.components.physics.liquidDrag = box.liquidDrag;
      };
    }
    if ($('inpColliderShape')) {
      $('inpColliderShape').onchange = e => {
        pushUndoState('Смена формы коллайдера');
        box.colliderShape = e.target.value;
        rebuildPhysicsArrays();
      };
    }
    if ($('inpBounce')) $('inpBounce').oninput = e => { box.bounciness = Math.max(0, +e.target.value || 0); };
    if ($('inpConvZ')) $('inpConvZ').oninput = e => { box.conveyorVz = +e.target.value || 0; };
    if ($('inpConvX')) $('inpConvX').oninput = e => { box.conveyorVx = +e.target.value || 0; };
    if ($('inpSpin')) $('inpSpin').oninput = e => { box.spinSpeed = +e.target.value || 0; };

    if ($('inpLiqTemp')) {
      $('inpLiqTemp').onchange = e => { box.liquidTemp = e.target.value; };
    }
    if ($('inpBlkEffSrc')) {
      $('inpBlkEffSrc').onchange = e => { box.effectSource = e.target.value; };
    }
    if ($('inpBlkFlammable')) {
      $('inpBlkFlammable').onchange = e => { box.isFlammable = e.target.checked; };
    }
    if ($('inpBlkFireDmg')) {
      $('inpBlkFireDmg').onchange = e => {
        box.takesFireDamage = e.target.checked;
        if ($('rowBlkFireHp')) $('rowBlkFireHp').hidden = !box.takesFireDamage;
      };
    }
    if ($('inpBlkFireHp')) {
      $('inpBlkFireHp').oninput = e => {
        const v = Math.max(10, +e.target.value || 100);
        box.maxFireHp = v;
        box.fireHp = v;
      };
    }

    if (comps.interaction?.enabled) {
      const syncInteract = (rerender = false) => {
        if ($('inpItTrig')) it.trigger = $('inpItTrig').value;
        if ($('inpItRadDist')) it.radiusDist = Math.max(0.5, +$('inpItRadDist').value || 3.5);
        if ($('inpItAct')) it.actionType = $('inpItAct').value;

        if ($('inpItHpMode')) it.healthMode = $('inpItHpMode').value;
        if ($('inpItHpAmt')) it.healthAmount = Math.max(1, +$('inpItHpAmt').value || 25);
        if ($('inpItHpTick')) it.healthTick = Math.max(0.1, +$('inpItHpTick').value || 0.5);

        if ($('inpItTpMode')) it.tpMode = $('inpItTpMode').value;
        if ($('inpItTpX')) it.tpX = +$('inpItTpX').value || 0;
        if ($('inpItTpY')) it.tpY = +$('inpItTpY').value || 6;
        if ($('inpItTpZ')) it.tpZ = +$('inpItTpZ').value || 0;
        if ($('inpItTpTarget')) it.tpTargetTag = ($('inpItTpTarget').value || '').trim();

        if ($('inpItCpStg')) it.cpStage = Math.max(1, +$('inpItCpStg').value || 1);
        if ($('inpItCpTitle')) it.cpTitle = $('inpItCpTitle').value || 'Чекпоинт';
        if ($('inpItCpCash')) it.cpCash = +$('inpItCpCash').value || 50;
        if ($('inpItCpSkip')) it.cpSkip = Math.max(0, +$('inpItCpSkip').value || 0);

        if ($('inpItImpX')) it.impulseX = +$('inpItImpX').value || 0;
        if ($('inpItImpY')) it.impulseY = +$('inpItImpY').value || 16;
        if ($('inpItImpZ')) it.impulseZ = +$('inpItImpZ').value || 0;

        if ($('inpItRewardType')) it.rewardType = $('inpItRewardType').value;
        if ($('inpItRewardCash')) it.rewardCash = Math.max(1, +$('inpItRewardCash').value || 25);
        if ($('inpItGhostT')) it.ghostTime = Math.max(0.2, +$('inpItGhostT').value || 4.0);

        if ($('inpItConsume')) it.consumeMode = $('inpItConsume').value;
        if ($('inpItMaxChg')) {
          it.maxCharges = Math.max(1, +$('inpItMaxChg').value || 3);
          it.chargesLeft = it.maxCharges;
        }
        if ($('inpItCostChg')) it.costPerUse = Math.max(1, +$('inpItCostChg').value || 1);
        if ($('inpItDeplete')) it.depleteAction = $('inpItDeplete').value;
        if ($('inpItRespT')) it.respawnTime = Math.max(0.5, +$('inpItRespT').value || 5.0);

        if ($('inpItCd')) it.cooldown = Math.max(0.1, +$('inpItCd').value || 0.8);
        if ($('inpItBadge')) it.showBadge = $('inpItBadge').checked;
        if ($('inpItPrompt')) it.promptText = $('inpItPrompt').value;

        syncBlockComponentsState(box);
        rebuildPhysicsArrays();
        if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncBlockUpsert(box, false);
        }
        refreshHierarchyUI();
        if (rerender) _renderInspectorUICore();
      };

      ['inpItTrig', 'inpItAct', 'inpItHpMode', 'inpItTpMode', 'inpItRewardType', 'inpItConsume', 'inpItDeplete'].forEach(id => {
        if ($(id)) $(id).onchange = () => syncInteract(true);
      });

      [
        'inpItRadDist', 'inpItHpAmt', 'inpItHpTick', 'inpItTpX', 'inpItTpY', 'inpItTpZ', 'inpItTpTarget',
        'inpItCpStg', 'inpItCpTitle', 'inpItCpCash', 'inpItCpSkip', 'inpItImpX', 'inpItImpY', 'inpItImpZ',
        'inpItRewardCash', 'inpItGhostT', 'inpItMaxChg', 'inpItCostChg', 'inpItRespT', 'inpItCd', 'inpItBadge', 'inpItPrompt'
      ].forEach(id => {
        if ($(id)) $(id).oninput = () => syncInteract(false);
      });

      if ($('btnItCaptureCamPos')) {
        $('btnItCaptureCamPos').onclick = () => {
          it.tpX = Math.round(S.edCamPos.x * 10) / 10;
          it.tpY = Math.round(S.edCamPos.y * 10) / 10;
          it.tpZ = Math.round(S.edCamPos.z * 10) / 10;
          syncInteract(true);
          showBanner(`📍 Координаты телепорта: (${it.tpX}, ${it.tpY}, ${it.tpZ})`, '#56f0ff');
        };
      }

      if ($('selItTpTargetList')) {
        $('selItTpTargetList').onchange = e => {
          if (!e.target.value) return;
          it.tpTargetTag = e.target.value;
          syncInteract(true);
        };
      }

      if ($('btnPickTpTarget3D')) {
        $('btnPickTpTarget3D').onclick = () => {
          showBanner('🎯 Кликни мышкой по любому объекту в 3D-сцене, чтобы сделать его целью телепорта!', '#ffce3a');
          S.pickingTargetCallback = targetBox => {
            if (!targetBox || targetBox === box) return;
            const tKey = (targetBox.signalData && targetBox.signalData.tag) ? targetBox.signalData.tag : targetBox.id;
            it.tpTargetTag = tKey;
            sfx.coil();
            showBanner(`🎯 Цель телепорта выбрана: «${targetBox.label}»`, '#00e676');
            syncInteract(true);
          };
        };
      }
    }

    if (comps.motion?.enabled) {
      const syncMotion = (rerender = false) => {
        if ($('inpMotPivot')) md.pivotMode = $('inpMotPivot').value;
        if ($('inpMotPivX')) md.pivotX = +$('inpMotPivX').value || 0;
        if ($('inpMotPivY')) md.pivotY = +$('inpMotPivY').value || 0;
        if ($('inpMotPivZ')) md.pivotZ = +$('inpMotPivZ').value || 0;
        if ($('inpMotTrig')) md.triggerMode = $('inpMotTrig').value;
        if ($('inpMotLoop')) md.loopMode = $('inpMotLoop').value;

        if ($('inpWpDX')) curWp.dx = +$('inpWpDX').value || 0;
        if ($('inpWpDY')) curWp.dy = +$('inpWpDY').value || 0;
        if ($('inpWpDZ')) curWp.dz = +$('inpWpDZ').value || 0;
        if ($('inpWpRX')) curWp.rx = +$('inpWpRX').value || 0;
        if ($('inpWpRY')) curWp.ry = +$('inpWpRY').value || 0;
        if ($('inpWpRZ')) curWp.rz = +$('inpWpRZ').value || 0;
        if ($('inpWpSX')) curWp.sx = Math.max(0.1, +$('inpWpSX').value || box.w);
        if ($('inpWpSY')) curWp.sy = Math.max(0.1, +$('inpWpSY').value || box.h);
        if ($('inpWpSZ')) curWp.sz = Math.max(0.1, +$('inpWpSZ').value || box.d);

        if ($('inpMotSpd')) md.speed = Math.max(0.1, +$('inpMotSpd').value || 1.5);
        if ($('inpMotCd')) md.cooldown = Math.max(0, +$('inpMotCd').value || 0.4);
        if ($('inpMotStay')) md.stayTime = Math.max(0.2, +$('inpMotStay').value || 3.0);

        syncBlockComponentsState(box);
        rebuildPhysicsArrays();
        if (window.__debixSyncBlockUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncBlockUpsert(box, false);
        }
        if (selectedRef.editMode === 'motion_wp') {
          selectEditorObject({ kind: 'block', box, editMode: 'motion_wp', wpIdx }, true);
        }
        if (rerender) _renderInspectorUICore();
      };

      ['inpMotPivot', 'inpMotTrig', 'inpMotLoop'].forEach(id => {
        if ($(id)) $(id).onchange = () => syncMotion(true);
      });
      [
        'inpMotPivX', 'inpMotPivY', 'inpMotPivZ',
        'inpWpDX', 'inpWpDY', 'inpWpDZ', 'inpWpRX', 'inpWpRY', 'inpWpRZ',
        'inpWpSX', 'inpWpSY', 'inpWpSZ', 'inpMotSpd', 'inpMotCd', 'inpMotStay'
      ].forEach(id => {
        if ($(id)) $(id).oninput = () => syncMotion(false);
      });

      cont.querySelectorAll('[data-sel-wp]').forEach(btn => {
        btn.onclick = () => {
          md.activeWaypointIdx = +btn.dataset.selWp;
          if (selectedRef.editMode === 'motion_wp') {
            selectEditorObject({ kind: 'block', box, editMode: 'motion_wp', wpIdx: md.activeWaypointIdx }, true);
          } else {
            rebuildPhysicsArrays();
            _renderInspectorUICore();
          }
        };
      });

      if ($('btnAddWaypoint')) {
        $('btnAddWaypoint').onclick = () => {
          pushUndoState('Добавление точки маршрута');
          const prev = md.waypoints[md.waypoints.length - 1] || {
            dx: 0, dy: 0, dz: 0, rx: 0, ry: 0, rz: 0, sx: box.w, sy: box.h, sz: box.d
          };
          md.waypoints.push({
            id: 'wp_' + Date.now(),
            name: `Точка #${md.waypoints.length + 1}`,
            dx: (Number(prev.dx) || 0) + 2,
            dy: Number(prev.dy) || 0,
            dz: Number(prev.dz) || 0,
            rx: Number(prev.rx) || 0,
            ry: Number(prev.ry) || 0,
            rz: Number(prev.rz) || 0,
            sx: Number(prev.sx) || box.w,
            sy: Number(prev.sy) || box.h,
            sz: Number(prev.sz) || box.d
          });
          md.activeWaypointIdx = md.waypoints.length - 1;
          sfx.jump();
          rebuildPhysicsArrays();
          _renderInspectorUICore();
        };
      }

      if ($('btnDelWaypoint')) {
        $('btnDelWaypoint').onclick = () => {
          if (md.waypoints.length <= 1) return;
          pushUndoState('Удаление точки маршрута');
          md.waypoints.splice(wpIdx, 1);
          md.activeWaypointIdx = Math.max(0, wpIdx - 1);
          sfx.oof();
          rebuildPhysicsArrays();
          _renderInspectorUICore();
        };
      }

      if ($('btnToggleWpGizmo3D')) {
        $('btnToggleWpGizmo3D').onclick = () => {
          if (selectedRef.editMode === 'motion_wp') {
            selectEditorObject({ kind: 'block', box, editMode: 'root' }, true);
          } else {
            selectEditorObject({ kind: 'block', box, editMode: 'motion_wp', wpIdx }, true);
            showBanner(`📍 Гизмо прикреплено к Точке #${wpIdx + 1}! Двигай (W), вращай (E) или меняй размер (R) прямо в 3D.`, '#ffce3a');
          }
        };
      }

      if ($('btnPreviewMotionPath')) {
        $('btnPreviewMotionPath').onclick = () => {
          if (box._isPreviewingMotion) return;
          if (selectedRef.editMode === 'motion_wp') {
            selectEditorObject({ kind: 'block', box, editMode: 'root' }, true);
          }
          box._isPreviewingMotion = true;
          if (!box.logicRuntime) box.logicRuntime = {};
          box.logicRuntime.basePos = box.m.position.clone();
          box.logicRuntime.baseQuat = box.m.quaternion.clone();
          box.logicRuntime.baseScale = box.m.scale.clone();

          sfx.gate();
          const maxU = md.waypoints.length;
          const speed = Math.max(0.2, Number(md.speed) || 1.5);
          let u = 0;
          let dir = 1;
          let lastT = performance.now();

          const stepPreview = now => {
            if (!box || !box.m || S.state !== 'edit') {
              if (box) box._isPreviewingMotion = false;
              return;
            }
            const dt = Math.min(0.05, (now - lastT) * 0.001);
            lastT = now;
            u += dir * speed * dt;

            if (dir > 0 && u >= maxU) {
              u = maxU;
              dir = -1;
            } else if (dir < 0 && u <= 0) {
              u = 0;
              box._isPreviewingMotion = false;
              recordHierarchyBaseline({ kind: 'block', box });
              box.m.position.copy(box.logicRuntime.basePos);
              box.m.quaternion.copy(box.logicRuntime.baseQuat);
              box.m.scale.copy(box.logicRuntime.baseScale);
              box.m.rotation.setFromQuaternion(box.m.quaternion);
              box.w = box.m.scale.x;
              box.h = box.m.scale.y;
              box.d = box.m.scale.z;
              box.m.updateMatrixWorld(true);
              propagateHierarchyTransform({ kind: 'block', box });
              updateBlockOBB(box);
              selBoxHelper.setFromObject(box.m);
              return;
            }

            recordHierarchyBaseline({ kind: 'block', box });
            const st = evaluateBlockMotionAtProgress(box, u);
            box.m.position.copy(st.pos);
            box.m.quaternion.copy(st.quat);
            box.m.scale.copy(st.scale);
            box.m.rotation.setFromQuaternion(box.m.quaternion);
            box.w = st.scale.x;
            box.h = st.scale.y;
            box.d = st.scale.z;
            box.m.updateMatrixWorld(true);
            propagateHierarchyTransform({ kind: 'block', box });
            updateBlockOBB(box);
            if (box.cpVisualGroup) box.cpVisualGroup.position.copy(box.m.position);
            selBoxHelper.setFromObject(box.m);

            requestAnimationFrame(stepPreview);
          };
          requestAnimationFrame(stepPreview);
        };
      }
    }

    if (comps.signal?.enabled) {
      const syncSig = (rerender = false) => {
        if ($('inpSigTag')) sg.tag = ($('inpSigTag').value || '').trim();
        if ($('inpSigTarget')) sg.targetTag = ($('inpSigTarget').value || '').trim();
        if ($('inpSigAct')) sg.signalAction = $('inpSigAct').value;
        if ($('inpSigSelfAnim')) sg.selfAnim = $('inpSigSelfAnim').value;
        syncBlockComponentsState(box);
        syncStudioMotionAndSignalHelpers();
        refreshHierarchyUI();
        if (rerender) _renderInspectorUICore();
      };

      ['inpSigTag', 'inpSigTarget'].forEach(id => {
        if ($(id)) $(id).oninput = () => syncSig(false);
      });
      ['inpSigAct', 'inpSigSelfAnim'].forEach(id => {
        if ($(id)) $(id).onchange = () => syncSig(false);
      });

      if ($('selSigTargetList')) {
        $('selSigTargetList').onchange = e => {
          if (!e.target.value) return;
          sg.targetTag = e.target.value;
          syncSig(true);
        };
      }

      if ($('btnPickSigTarget3D')) {
        $('btnPickSigTarget3D').onclick = () => {
          showBanner('🎯 Кликни мышкой по объекту в 3D-сцене (например, по Двери), чтобы связать его с этим триггером!', '#ffce3a');
          S.pickingTargetCallback = targetBox => {
            if (!targetBox || targetBox === box) return;
            ensureBlockComponents(targetBox);
            if (!targetBox.signalData.tag) {
              targetBox.signalData.tag = 'door_' + targetBox.id.replace('blk_', '');
            }
            sg.targetTag = targetBox.signalData.tag;
            syncBlockComponentsState(targetBox);
            sfx.coil();
            showBanner(`🔗 Связь установлена: «${box.label}» ➔ «${targetBox.label}» (#${sg.targetTag})!`, '#00e676');
            syncSig(true);
          };
        };
      }
    }

    if (comps.cost?.enabled) {
      const syncCost = () => {
        if ($('inpCostAmt')) ct.amount = Math.max(1, +$('inpCostAmt').value || 50);
        if ($('inpCostOneTime')) ct.oneTimeBuy = $('inpCostOneTime').checked;
        ct.unlocked = false;
        syncBlockComponentsState(box);
        refreshHierarchyUI();
      };
      if ($('inpCostAmt')) $('inpCostAmt').oninput = syncCost;
      if ($('inpCostOneTime')) $('inpCostOneTime').onchange = syncCost;
    }

    if (comps.item?.enabled && itm) {
      if ($('inpCompItmHold')) {
        $('inpCompItmHold').onchange = e => {
          itm.holdMode = e.target.value;
          comps.item.itemData = itm;
          _renderInspectorUICore();
        };
      }
      if ($('inpCompItmUse')) {
        $('inpCompItmUse').onchange = e => {
          itm.useType = e.target.value;
          comps.item.itemData = itm;
          _renderInspectorUICore();
        };
      }
      if ($('inpCompItmIco')) {
        $('inpCompItmIco').oninput = e => {
          itm.icon = e.target.value || '🗡️';
          comps.item.itemData = itm;
          refreshHierarchyUI();
        };
      }
      const syncCompItmStats = () => {
        if ($('inpCompItmDmg')) itm.damage = Math.max(0, +$('inpCompItmDmg').value || 0);
        if ($('inpCompItmRng')) itm.range = Math.max(1, +$('inpCompItmRng').value || 4);
        if ($('inpCompItmRad')) itm.radius = Math.max(0.5, +$('inpCompItmRad').value || 2);
        if ($('inpCompItmKb')) itm.knockback = Math.max(0, +$('inpCompItmKb').value || 8);
        if ($('inpCompItmCd')) itm.cooldown = Math.max(0.05, +$('inpCompItmCd').value || 0.3);
        if ($('inpCompItmBlast')) itm.blastRadius = Math.max(0, +$('inpCompItmBlast').value || 0);
        if ($('inpCompItmPrjSpd')) itm.projSpeed = Math.max(2, +$('inpCompItmPrjSpd').value || 30);
        if ($('inpCompItmHeal')) itm.healAmount = +$('inpCompItmHeal').value || 0;
        if ($('inpCompItmBfSpd')) itm.buffSpeed = +$('inpCompItmBfSpd').value || 0;
        if ($('inpCompItmBfJmp')) itm.buffJump = +$('inpCompItmBfJmp').value || 0;
        comps.item.itemData = itm;
      };
      [
        'inpCompItmDmg', 'inpCompItmRng', 'inpCompItmRad', 'inpCompItmKb', 'inpCompItmCd',
        'inpCompItmBlast', 'inpCompItmPrjSpd', 'inpCompItmHeal', 'inpCompItmBfSpd', 'inpCompItmBfJmp'
      ].forEach(id => {
        if ($(id)) $(id).oninput = syncCompItmStats;
      });

      if ($('btnCompGivePlayer')) {
        $('btnCompGivePlayer').onclick = () => {
          if (!S.player) return;
          const compiled = compileSceneHierarchyToItemData(box);
          const copy = normalizeItemData(JSON.parse(JSON.stringify(compiled)));
          if (copy.holdMode === 'carried') {
            S.player.carriedItem = copy;
            syncEntityHeldItemMesh(S.player);
            renderHotbarUI();
            sfx.coil();
            showBanner(`📦 Собранный предмет «${copy.name}» (${copy.parts.length} дет.) выдан в 2 руки игрока!`, '#00e676');
          } else {
            if (!Array.isArray(S.player.inventory)) S.player.inventory = [null, null, null, null, null, null];
            let slot = S.player.inventory.findIndex((x, idx) => idx > 0 && !x);
            if (slot === -1) slot = 1;
            S.player.inventory[slot] = copy;
            S.activeSlot = slot;
            syncEntityHeldItemMesh(S.player);
            renderHotbarUI();
            sfx.coil();
            showBanner(`${copy.icon} Собранный «${copy.name}» (${copy.parts.length} дет.) выдан в Слот #${slot + 1}!`, '#00e676');
          }
        };
      }

      if ($('btnCompOpenInStudio3D')) {
        $('btnCompOpenInStudio3D').onclick = () => {
          selectEditorObject({
            kind: 'block',
            box,
            editMode: 'root',
            inStudio: true
          }, true);
          sfx.coil?.();
          showBanner(`🛠️ Объект «${box.label}» открыт на подиуме 3D STUDIO!`, '#56f0ff');
        };
      }
    }

    if ($('btnBlkOpenStudio3D')) {
      $('btnBlkOpenStudio3D').onclick = () => {
        selectEditorObject({
          kind: 'block',
          box,
          editMode: 'root',
          inStudio: true
        }, true);
      };
    }
    if ($('btnBlkExitStudio3D')) {
      $('btnBlkExitStudio3D').onclick = () => {
        closeItemStudio3D(true);
      };
    }

    if (comps.spawner?.enabled) {
      if ($('inpSpMode')) {
        $('inpSpMode').onchange = e => {
          sd.mode = e.target.value;
          sd.timer = sd.interval;
        };
      }
      if ($('inpSpType')) $('inpSpType').onchange = e => { sd.spawnType = e.target.value; };
      if ($('inpSpInt')) {
        $('inpSpInt').oninput = e => {
          sd.interval = Math.max(0.5, +e.target.value || 5);
          sd.timer = sd.interval;
        };
      }
    }

    if (comps.sound?.enabled) {
      const syncSnd = (rerender = false) => {
        if ($('inpSndId')) snd.soundId = $('inpSndId').value;
        if ($('inpSndMode')) snd.mode = $('inpSndMode').value;
        if ($('inpSndRad')) snd.radius = Math.max(2, +$('inpSndRad').value || 18);
        if ($('inpSndPitchVar')) snd.pitchVar = clamp(+$('inpSndPitchVar').value || 0, 0, 0.5);
        if ($('inpSndInt')) snd.interval = Math.max(0.4, +$('inpSndInt').value || 2.5);
        if (rerender) _renderInspectorUICore();
      };
      if ($('inpSndId')) $('inpSndId').onchange = () => syncSnd(false);
      if ($('inpSndMode')) $('inpSndMode').onchange = () => syncSnd(true);
      ['inpSndRad', 'inpSndPitchVar', 'inpSndInt'].forEach(id => {
        if ($(id)) $(id).oninput = () => syncSnd(false);
      });
      if ($('btnTestObjSnd')) {
        $('btnTestObjSnd').onclick = () => playSoundId(snd.soundId, { pitchVar: snd.pitchVar ?? 0.1 });
      }
      if ($('btnUploadObjCustomSnd')) {
        $('btnUploadObjCustomSnd').onclick = () => {
          promptUploadCustomAudio('sfx', entry => {
            snd.soundId = 'custom:' + entry.id;
            _renderInspectorUICore();
          });
        };
      }
    }

    if (comps.script?.enabled) {
      if (!box.scriptData) box.scriptData = createDefaultScriptData('block');
      bindScriptAddonInspectorEvents(
        cont,
        box.scriptData,
        'block',
        (needFullRefresh) => {
          syncBlockComponentsState(box);
          if (needFullRefresh) _renderInspectorUICore();
        },
        () => {
          box.components.script.enabled = false;
          box.scriptData.enabled = false;
          syncBlockComponentsState(box);
          _renderInspectorUICore();
        }
      );
    }
    return;
  }

  // 5. ИНСПЕКТОР ПАПКИ ИЕРАРХИИ (kind === 'folder')
  if (selectedRef.kind === 'folder' && selectedRef.folder) {
    const folder = selectedRef.folder;
    const m = selectedRef.mesh;
    const p = m ? m.position : { x: 0, y: 0, z: 0 };
    const r = m ? m.rotation : { x: 0, y: 0, z: 0 };
    const s = m ? m.scale : { x: 1, y: 1, z: 1 };

    cont.innerHTML = `
      <div class="prop-group" style="border-color:#ffce3a">
        <h5>📁 Папка Иерархии (Группа)</h5>
        <div class="prop-row"><label>Название</label><input class="ed-inp" id="inpFldName" value="${folder.name || 'Папка'}"></div>
        <div class="prop-row"><label>Позиция</label><div class="vec3">
          <input type="number" step="0.5" class="ed-inp" id="inpFldPX" value="${p.x.toFixed(2)}">
          <input type="number" step="0.5" class="ed-inp" id="inpFldPY" value="${p.y.toFixed(2)}">
          <input type="number" step="0.5" class="ed-inp" id="inpFldPZ" value="${p.z.toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Масштаб</label><div class="vec3">
          <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpFldSX" value="${s.x.toFixed(2)}">
          <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpFldSY" value="${s.y.toFixed(2)}">
          <input type="number" step="0.1" min="0.1" class="ed-inp" id="inpFldSZ" value="${s.z.toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>Поворот°</label><div class="vec3">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpFldRX" value="${formatSnapDeg(r.x)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpFldRY" value="${formatSnapDeg(r.y)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpFldRZ" value="${formatSnapDeg(r.z)}">
        </div></div>
        <button class="ed-btn apply-oneclick" id="btnSaveFolderPrefab" type="button" style="justify-content:center;margin-top:4px">💾 Сохранить группу в Префаб</button>
      </div>
    `;

    $('inpFldName').oninput = e => {
      folder.name = e.target.value || 'Папка';
      refreshHierarchyUI();
    };
    if ($('btnSaveFolderPrefab')) {
      $('btnSaveFolderPrefab').onclick = () => saveSelectedObjectAsPrefab();
    }
    const applyFolderTransform = () => {
      if (!m) return;
      recordHierarchyBaseline(selectedRef);
      m.position.set(+$('inpFldPX').value || 0, +$('inpFldPY').value || 0, +$('inpFldPZ').value || 0);
      m.scale.set(
        Math.max(0.1, +$('inpFldSX').value || 1),
        Math.max(0.1, +$('inpFldSY').value || 1),
        Math.max(0.1, +$('inpFldSZ').value || 1)
      );
      m.rotation.set(
        snapAngleRad(THREE.MathUtils.degToRad(+$('inpFldRX').value || 0)),
        snapAngleRad(THREE.MathUtils.degToRad(+$('inpFldRY').value || 0)),
        snapAngleRad(THREE.MathUtils.degToRad(+$('inpFldRZ').value || 0))
      );
      m.updateMatrixWorld(true);
      propagateHierarchyTransform(selectedRef);
    };
    ['inpFldPX', 'inpFldPY', 'inpFldPZ', 'inpFldSX', 'inpFldSY', 'inpFldSZ', 'inpFldRX', 'inpFldRY', 'inpFldRZ'].forEach(id => {
      if ($(id)) {
        $(id).onfocus = () => {
          pushUndoState('Трансформация группы');
          recordHierarchyBaseline(selectedRef);
        };
        $(id).oninput = applyFolderTransform;
      }
    });
    return;
  }

  // 6. ИНСПЕКТОР ПЕРСОНАЖА (ИГРОКА ИЛИ МОДУЛЬНОГО NPC R6)
  if (selectedRef.kind === 'char' && selectedRef.ent) {
    const ent = selectedRef.ent;
    if (!ent.preset) ent.preset = {};
    if (!Array.isArray(ent.preset.customCosmetics)) ent.preset.customCosmetics = [];
    normalizeCharacterGripPoints(ent.preset);

    const npcMods = !ent.isP ? ensureNpcModules(ent) : null;
    const editMode = selectedRef.editMode || 'root';
    const hp = ent.preset.handGripPoint || DEFAULT_HAND_GRIP_POINT;
    const cp = ent.preset.carryGripPoint || DEFAULT_CARRY_GRIP_POINT;

    const toHexStr = val => {
      if (typeof val === 'string' && val.startsWith('#')) return val;
      return '#' + new THREE.Color(val ?? 0xffffff).getHexString();
    };

    const headHex = toHexStr(ent.preset.head ?? 0xf3d2b3);
    const torsoHex = toHexStr(ent.preset.torso ?? 0x2563eb);
    const armLHex = toHexStr(ent.preset.armL ?? ent.preset.arms ?? 0xf3d2b3);
    const armRHex = toHexStr(ent.preset.armR ?? ent.preset.arms ?? 0xf3d2b3);
    const legLHex = toHexStr(ent.preset.legL ?? ent.preset.legs ?? 0x1e293b);
    const legRHex = toHexStr(ent.preset.legR ?? ent.preset.legs ?? 0x1e293b);

    const cosListHTML = ent.preset.customCosmetics.length > 0
      ? ent.preset.customCosmetics.map((cos, idx) => {
          normalizeCosmeticItem(cos);
          const ico = cos.parentSlot === 'pet' ? '🐾' : '🎩';
          const on = cos.enabled !== false;
          return `
            <div style="display:flex;align-items:center;gap:4px;background:#101420;padding:4px 6px;border-radius:6px;border:1px solid #252f48">
              <button class="ed-btn ${on ? 'active' : ''}" data-cos-toggle="${idx}" type="button" style="padding:2px 6px;font-size:10px" title="Включить / Скрыть">${on ? '🟢' : '🔴'}</button>
              <span style="flex:1;font:700 10.5px var(--f);color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${ico} ${cos.name || 'Аксессуар'} (${cos.parts?.length || 1})</span>
              <button class="ed-btn" data-cos-edit="${idx}" type="button" style="padding:2px 6px;font-size:10px" title="Редактировать в 3D">✏️</button>
              <button class="ed-btn danger" data-cos-del="${idx}" type="button" style="padding:2px 6px;font-size:10px" title="Удалить">🗑️</button>
            </div>
          `;
        }).join('')
      : `<div style="font-size:10px;color:#64748b;text-align:center;padding:4px">Нет надетых 3D-аксессуаров или питомцев</div>`;

    let npcModulesHTML = '';
    if (!ent.isP && npcMods) {
      const NPC_MOD_CATALOG = [
        { key: 'worldPhysics', icon: '🧱', title: 'Физика и Взаимодействие с миром', desc: 'Гравитация, коллизии со стенами, падение в ямы, урон от высоты и ловушек/лавы' },
        { key: 'navigation', icon: '🧭', title: 'Движение, Паркур и Поиск пути (A*)', desc: 'Блуждание / Патруль / Следование, прыжки через ямы и преграды, кратчайший маршрут' },
        { key: 'humanError', icon: '🎲', title: 'Модуль Ошибок и «Человечности»', desc: 'Бот может ошибиться в расчёте прыжка через яму, выбрать неточный путь или замешкаться' },
        { key: 'combat', icon: '⚔️', title: 'Боевой модуль и Сенсорика', desc: 'Мирный / Страж (бьёт в ответ) / Враждебный, стрельба и удары оружием из рук, побег' },
        { key: 'dialogue', icon: '💬', title: 'Диалог по [E] и Лут после смерти', desc: 'Реплики при разговоре по [E], крики при падении и выпадение монет R$ / оружия' },
        { key: 'customScript', icon: '🧩', title: 'Скрипт-Аддон ИИ (DebiX Script)', desc: 'Кастомный JS-код для NPC: поведение, реакция на урон, диалоги и свои ползунки params' }
      ];
      const unaddedNpcMods = NPC_MOD_CATALOG.filter(m => !npcMods[m.key]?.enabled);

      const addNpcModMenuHTML = unaddedNpcMods.length > 0
        ? `
          <div class="ecs-add-wrap" style="margin-top:4px">
            <button class="ecs-add-btn" id="btnToggleAddNpcMod" type="button">
              ➕ Подключить модуль NPC (${unaddedNpcMods.length})
            </button>
            <div class="ecs-add-menu" id="ecsAddNpcModMenu" hidden>
              ${unaddedNpcMods.map(m => `
                <button class="ecs-add-item" data-add-npcmod="${m.key}" type="button">
                  <div class="ecs-add-item-top">
                    <span>${m.icon} ${m.title}</span>
                    <span style="color:#56f0ff">＋</span>
                  </div>
                  <div class="ecs-add-item-desc">${m.desc}</div>
                </button>
              `).join('')}
            </div>
          </div>
        `
        : `<div style="text-align:center;font:700 10px var(--f);color:#69f0ae;padding:4px">✓ Все 6 модуля поведения подключены к NPC</div>`;

      const wpListHTML = (npcMods.navigation.waypoints || []).map((wp, wIdx) => `
        <div style="display:flex;align-items:center;gap:4px;background:#101420;padding:3px 6px;border-radius:5px;border:1px solid #252f48;font-size:10px">
          <span style="flex:1;color:#cbd5e1">📍 #${wIdx + 1}: (${Number(wp.x).toFixed(1)}, ${Number(wp.z).toFixed(1)})</span>
          <button class="ed-btn danger" data-npc-wp-del="${wIdx}" type="button" style="padding:1px 5px;font-size:9px">✕</button>
        </div>
      `).join('');

      const savedWeaponsOpts = (S.savedItemsLibrary || []).map((it, idx) =>
        `<option value="lib:${idx}">${it.icon || '🗡️'} [Арсенал] ${it.name}</option>`
      ).join('');

      npcModulesHTML = `
        <!-- ОРУЖИЕ В РУКАХ NPC -->
        <div class="prop-group" style="border-color:#ff9f43">
          <h5>🗡️ Экипировка в руках NPC</h5>
          <div class="prop-row">
            <label>Сейчас в руке</label>
            <span style="flex:1;font:800 11px var(--f);color:${ent.equippedItem ? '#00e676' : '#94a3b8'}">
              ${ent.equippedItem ? `${ent.equippedItem.icon || '🗡️'} ${ent.equippedItem.name}` : '🥊 Пустые руки (Кулак)'}
            </span>
            ${ent.equippedItem ? `<button class="ed-btn danger" id="btnNpcUnequipItem" type="button" style="padding:3px 7px;font-size:10px">Убрать</button>` : ''}
          </div>
          <div class="prop-row">
            <label>Выдать</label>
            <select class="ed-inp" id="selNpcEquipPreset" style="flex:1">
              <option value="">-- Выбрать оружие для NPC --</option>
              <option value="tpl:sword">🗡️ Рыцарский Меч (Ближний бой)</option>
              <option value="tpl:blaster">🔫 Плазменный Бластер (Стреляет)</option>
              <option value="tpl:bomb">💣 Бомба (Метательный снаряд)</option>
              <option value="tpl:torch">🔦 Горящий Факел</option>
              ${savedWeaponsOpts}
            </select>
          </div>
        </div>

        ${!npcMods.worldPhysics?.enabled ? `
          <div style="background:rgba(255,206,58,0.1);border:1px dashed #ffce3a;border-radius:8px;padding:7px;font-size:10px;color:#ffe082;line-height:1.35">
            👻 <b>Классический режим (Без физики мира):</b> сейчас NPC ходит на фиксированной высоте, проходя сквозь препятствия и паря над ямами. Подключи модуль <b>«🧱 Физика и Взаимодействие с миром»</b> ниже, чтобы он падал, врезался и получал урон как игрок!
          </div>
        ` : ''}

        <!-- МОДУЛЬ 1: 🧱 ФИЗИКА И ВЗАИМОДЕЙСТВИЕ С МИРОМ -->
        ${npcMods.worldPhysics?.enabled ? `
          <div class="ecs-comp-card" style="border-color:#00e676">
            <div class="ecs-comp-head" data-npcmod-toggle="worldPhysics">
              <div class="ecs-comp-title">
                <span class="ecs-arrow">${npcMods.worldPhysics.collapsed ? '▶' : '▼'}</span>
                <span>🧱 Физика и Взаимодействие с миром</span>
              </div>
              <div class="ecs-comp-actions">
                <button class="ecs-comp-del" data-npcmod-remove="worldPhysics" type="button" title="Отключить физику (вернуть хождение сквозь стены и ямы)">🗑️</button>
              </div>
            </div>
            <div class="ecs-comp-body" ${npcMods.worldPhysics.collapsed ? 'hidden' : ''}>
              <div style="font-size:10px;color:#8fa0bd;margin-bottom:2px">
                Бот подчиняется гравитации, падает в ямы, врезается в стены, открывает двери и подбирает оружие.
              </div>
              <div class="prop-row">
                <label>Множ. гравитации</label>
                <input type="number" step="0.1" min="0.2" max="3.0" class="ed-inp" id="inpNpcGravScale" value="${npcMods.worldPhysics.gravityScale ?? 1.0}" style="width:70px">
                <label style="flex:1;text-align:right">Умеет плавать</label>
                <input type="checkbox" id="inpNpcCanSwim" ${npcMods.worldPhysics.canSwim !== false ? 'checked' : ''}>
              </div>
              <div class="prop-row">
                <label>Урон от падения</label>
                <input type="checkbox" id="inpNpcFallDmg" ${npcMods.worldPhysics.fallDamage !== false ? 'checked' : ''}>
                <label style="flex:1;text-align:right" title="Урон от лавы, лазеров и опасных блоков">Урон от ловушек</label>
                <input type="checkbox" id="inpNpcHazardDmg" ${npcMods.worldPhysics.hazardDamage !== false ? 'checked' : ''}>
              </div>
              <div class="prop-row">
                <label title="Бот подбирает лежащее оружие с земли, если у него пустые руки">Подбирать оружие</label>
                <input type="checkbox" id="inpNpcPickupItm" ${npcMods.worldPhysics.canPickupItems !== false ? 'checked' : ''}>
                <label style="flex:1;text-align:right" title="Бот сам открывает двери и нажимает кнопки на пути">Открывать двери</label>
                <input type="checkbox" id="inpNpcInteractBlk" ${npcMods.worldPhysics.canInteractBlocks !== false ? 'checked' : ''}>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- МОДУЛЬ 2: 🧭 ДВИЖЕНИЕ, ПОХОДКА, ПАРКУР И ПОИСК ПУТИ (A*) -->
        ${npcMods.navigation?.enabled ? `
          <div class="ecs-comp-card" style="border-color:#00d2ff">
            <div class="ecs-comp-head" data-npcmod-toggle="navigation">
              <div class="ecs-comp-title">
                <span class="ecs-arrow">${npcMods.navigation.collapsed ? '▶' : '▼'}</span>
                <span>🧭 Движение, Паркур и Поиск пути</span>
              </div>
              <div class="ecs-comp-actions">
                <button class="ecs-comp-del" data-npcmod-remove="navigation" type="button" title="Отключить движение">🗑️</button>
              </div>
            </div>
            <div class="ecs-comp-body" ${npcMods.navigation.collapsed ? 'hidden' : ''}>
              <div class="prop-row">
                <label>Режим</label>
                <select class="ed-inp" id="inpNpcNavMode">
                  <option value="wander" ${npcMods.navigation.mode === 'wander' ? 'selected' : ''}>🚶 Свободное блуждание (Wander)</option>
                  <option value="waypoints" ${npcMods.navigation.mode === 'waypoints' ? 'selected' : ''}>📍 Патруль по точкам маршрута</option>
                  <option value="follow" ${npcMods.navigation.mode === 'follow' ? 'selected' : ''}>🐾 Следовать за игроком (Компаньон)</option>
                  <option value="stand" ${npcMods.navigation.mode === 'stand' ? 'selected' : ''}>🧍 Стоять на посту (Охрана точки)</option>
                </select>
              </div>
              <div class="prop-row">
                <label title="Умный: ищет подъёмы на возвышенности, строит ряды (танки спереди, дальники сзади), помогает своим, лечится и бережёт стамину. Глупый: бежит напролом, ждёт под стеной, тратит всю стамину и не помогает своим.">🧠 Интеллект</label>
                <select class="ed-inp" id="inpNpcIntel">
                  <option value="smart" ${npcMods.navigation.intelligence !== 'dumb' ? 'selected' : ''}>🧠 Умный (Тактика, обход высот, строй, помощь)</option>
                  <option value="dumb" ${npcMods.navigation.intelligence === 'dumb' ? 'selected' : ''}>🤪 Глупый (Напролом, ждёт под стеной, эгоист)</option>
                </select>
              </div>
              <div class="prop-row">
                <label>Тип походки</label>
                <select class="ed-inp" id="inpNpcGait">
                  <option value="normal" ${(npcMods.navigation.gait || 'normal') === 'normal' ? 'selected' : ''}>🚶 Обычный (Классический шаг R6)</option>
                  <option value="monster" ${npcMods.navigation.gait === 'monster' ? 'selected' : ''}>🧟 Монстр / Зомби (Руки вперёд, наклон тела)</option>
                  <option value="levitate" ${npcMods.navigation.gait === 'levitate' ? 'selected' : ''}>🧞 Левитирующий (Парит, руки назад)</option>
                </select>
              </div>
              <div class="prop-row">
                <label>Шаг / Прыжок</label>
                <div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="0.5" min="1.5" max="24" class="ed-inp" id="inpNpcWalkSpd" value="${npcMods.navigation.walkSpeed ?? 5.4}" title="Базовая скорость шага NPC">
                  <input type="number" step="0.5" min="4" max="30" class="ed-inp" id="inpNpcJumpPwr" value="${npcMods.navigation.jumpPower ?? 10.2}" title="Сила прыжка NPC">
                </div>
              </div>
              <div class="prop-row">
                <label title="Разрешить этому NPC переходить на бег (спринт)">Умеет спринтовать</label>
                <input type="checkbox" id="inpNpcCanSprint" ${npcMods.navigation.canSprint !== false ? 'checked' : ''}>
                <label style="flex:1;text-align:right">Множ. спринта</label>
                <input type="number" step="0.05" min="1.1" max="2.5" class="ed-inp" id="inpNpcSprintMult" value="${npcMods.navigation.sprintMultiplier ?? 1.48}" style="width:65px">
              </div>
              ${npcMods.navigation.mode === 'wander' ? `
                <div class="prop-row">
                  <label>Радиус прогулки</label>
                  <input type="number" step="1" min="2" max="60" class="ed-inp" id="inpNpcWanderRad" value="${npcMods.navigation.wanderRadius ?? 8.0}">
                </div>
              ` : ''}
              ${npcMods.navigation.mode === 'follow' ? `
                <div class="prop-row">
                  <label>Дистанция (м)</label>
                  <input type="number" step="0.5" min="1.5" max="15" class="ed-inp" id="inpNpcFollowDist" value="${npcMods.navigation.followDist ?? 3.2}">
                </div>
              ` : ''}
              ${npcMods.navigation.mode === 'waypoints' ? `
                <div style="background:rgba(0,210,255,0.06);border:1px solid rgba(0,210,255,0.28);border-radius:7px;padding:6px;display:flex;flex-direction:column;gap:4px">
                  <div style="display:flex;justify-content:space-between;align-items:center">
                    <span style="font:800 9.5px var(--f);color:#56f0ff">ТОЧКИ ПАТРУЛЯ (${npcMods.navigation.waypoints.length}):</span>
                    <button class="ed-btn apply-oneclick" id="btnNpcAddCurPosWp" type="button" style="padding:2px 6px;font-size:9.5px">➕ Добавить текущую X/Z</button>
                  </div>
                  ${wpListHTML || `<div style="font-size:9.5px;color:#64748b">Перемести NPC и нажми «➕ Добавить текущую X/Z»</div>`}
                </div>
              ` : ''}
              <div class="prop-row">
                <label title="Бот умеет прыгать на уступы и преграды">Прыжки (Паркур)</label>
                <input type="checkbox" id="inpNpcCanJump" ${npcMods.navigation.canJump !== false ? 'checked' : ''}>
                <label style="flex:1;text-align:right" title="Перепрыгивать ямы и пропасти, если видит берег">Прыгать через ямы</label>
                <input type="checkbox" id="inpNpcJumpGaps" ${npcMods.navigation.jumpGaps !== false ? 'checked' : ''}>
              </div>
              <div class="prop-row">
                <label title="Просчитывать кратчайший маршрут вокруг стен и пропастей (A*)">Поиск пути (A*)</label>
                <input type="checkbox" id="inpNpcPathfind" ${npcMods.navigation.usePathfinding !== false ? 'checked' : ''}>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- МОДУЛЬ 3: 🎲 МОДУЛЬ ОШИБОК И «ЧЕЛОВЕЧНОСТИ» -->
        ${npcMods.humanError?.enabled ? `
          <div class="ecs-comp-card" style="border-color:#ffce3a">
            <div class="ecs-comp-head" data-npcmod-toggle="humanError">
              <div class="ecs-comp-title">
                <span class="ecs-arrow">${npcMods.humanError.collapsed ? '▶' : '▼'}</span>
                <span>🎲 Модуль Ошибок («Человечность»)</span>
              </div>
              <div class="ecs-comp-actions">
                <button class="ecs-comp-del" data-npcmod-remove="humanError" type="button" title="Отключить модуль ошибок (сделать бота безошибочным)">🗑️</button>
              </div>
            </div>
            <div class="ecs-comp-body" ${npcMods.humanError.collapsed ? 'hidden' : ''}>
              <div style="font-size:10px;color:#ffe082;line-height:1.3">
                Бот может переоценить длину прыжка через пропасть и упасть, проложить неидеальный маршрут или задуматься.
              </div>
              <div class="prop-row">
                <label>Уровень хаоса</label>
                <input type="range" min="0.05" max="1.0" step="0.05" id="inpNpcErrLevel" value="${npcMods.humanError.mistakeLevel ?? 0.25}" style="flex:1">
                <span id="txtNpcErrLevel" style="font-size:10px;width:36px;text-align:right">${Math.round((npcMods.humanError.mistakeLevel ?? 0.25) * 100)}%</span>
              </div>
              <div class="prop-row">
                <label title="Вероятность неверно рассчитать прыжок через яму или стену">Ошибка прыжка</label>
                <input type="number" step="0.05" min="0" max="1" class="ed-inp" id="inpNpcJumpErr" value="${npcMods.humanError.jumpMistakeChance ?? 0.22}" style="width:65px">
                <label style="flex:1;text-align:right" title="Отклонение от кратчайшего пути">Кривой маршрут</label>
                <input type="number" step="0.05" min="0" max="1" class="ed-inp" id="inpNpcPathErr" value="${npcMods.humanError.pathNoise ?? 0.3}" style="width:65px">
              </div>
              <div class="prop-row">
                <label title="Шанс остановиться и задуматься">Замешательство</label>
                <input type="number" step="0.05" min="0" max="1" class="ed-inp" id="inpNpcHesitate" value="${npcMods.humanError.hesitationChance ?? 0.15}" style="width:65px">
                <label style="flex:1;text-align:right" title="Разброс прицела при стрельбе">Косой прицел</label>
                <input type="number" step="0.05" min="0" max="1" class="ed-inp" id="inpNpcAimErr" value="${npcMods.humanError.aimError ?? 0.2}" style="width:65px">
              </div>
            </div>
          </div>
        ` : ''}

        <!-- МОДУЛЬ 4: ⚔️ БОЕВОЙ МОДУЛЬ И СЕНСОРИКА -->
        ${npcMods.combat?.enabled ? `
          <div class="ecs-comp-card" style="border-color:#ff6b6b">
            <div class="ecs-comp-head" data-npcmod-toggle="combat">
              <div class="ecs-comp-title">
                <span class="ecs-arrow">${npcMods.combat.collapsed ? '▶' : '▼'}</span>
                <span>⚔️ Боевой модуль и Агро</span>
              </div>
              <div class="ecs-comp-actions">
                <button class="ecs-comp-del" data-npcmod-remove="combat" type="button" title="Отключить боевой модуль">🗑️</button>
              </div>
            </div>
            <div class="ecs-comp-body" ${npcMods.combat.collapsed ? 'hidden' : ''}>
              <div class="prop-row">
                <label>Характер</label>
                <select class="ed-inp" id="inpNpcStance">
                  <option value="hostile" ${npcMods.combat.stance === 'hostile' ? 'selected' : ''}>😡 Враждебный (Атакует врагов в радиусе)</option>
                  <option value="guard" ${npcMods.combat.stance === 'guard' ? 'selected' : ''}>🛡️ Страж (Защищает порядок и бьёт врагов)</option>
                  <option value="neutral" ${npcMods.combat.stance === 'neutral' ? 'selected' : ''}>🕊️ Пацифист (Никогда не дерётся)</option>
                </select>
              </div>
              <div class="prop-row">
                <label title="Выбери созданную тобой фракцию или оставь бота одиночкой">🚩 Фракция NPC</label>
                <select class="ed-inp" id="inpNpcFaction">
                  <option value="" ${!npcMods.combat.faction ? 'selected' : ''}>⚪ Без фракции (Сам по себе)</option>
                  ${(S.worldSettings.factions || []).map(f => `<option value="${f.id}" ${npcMods.combat.faction === f.id ? 'selected' : ''}>🚩 ${f.name}</option>`).join('')}
                </select>
              </div>
              <div style="background:rgba(255,107,107,0.06);border:1px dashed rgba(255,107,107,0.35);border-radius:7px;padding:6px;margin:2px 0">
                <div style="font:800 9.5px var(--f);color:#ff8787;text-transform:uppercase;margin-bottom:4px">🚩 Управление фракциями и отношениями:</div>
                ${buildCustomFactionsEditorHTML()}
              </div>
              <div class="prop-row">
                <label title="Умные союзники по фракции спешат на помощь своим (глупые игнорируют)">Звать союзников</label>
                <input type="checkbox" id="inpNpcCallHelp" ${npcMods.combat.callForHelp !== false ? 'checked' : ''}>
              </div>
              <div class="prop-row">
                <label>Обзор / Урон</label>
                <div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="1" min="2" max="50" class="ed-inp" id="inpNpcAggroRad" value="${npcMods.combat.aggroRadius ?? 13}" title="Радиус обнаружения цели (м)">
                  <input type="number" step="5" min="1" class="ed-inp" id="inpCharMeleeDmg" value="${ent.meleeDamage ?? 15}" title="Базовый урон удара">
                </div>
              </div>
              <div class="prop-row">
                <label title="Базовая меткость стрельбы (шанс плавающий в бою)">🎯 Меткость (стрельба)</label>
                <input type="range" min="0.05" max="1.0" step="0.05" id="inpNpcAccuracy" value="${npcMods.combat.accuracy ?? 0.75}" style="flex:1">
                <span id="txtNpcAccuracy" style="font-size:10px;width:36px;text-align:right">${Math.round((npcMods.combat.accuracy ?? 0.75) * 100)}%</span>
              </div>
              <div class="prop-row">
                <label title="NPC тратит магазин оружия и перезаряжается">Перезарядка обойм</label>
                <input type="checkbox" id="inpNpcRespectReload" ${npcMods.combat.respectAmmoReload !== false ? 'checked' : ''}>
              </div>
              <div class="prop-row">
                <label>Побег при лоу-HP</label>
                <input type="checkbox" id="inpNpcFleeLow" ${npcMods.combat.fleeLowHp ? 'checked' : ''}>
                <label style="flex:1;text-align:right">Порог HP (%)</label>
                <input type="number" step="5" min="5" max="80" class="ed-inp" id="inpNpcFleePct" value="${npcMods.combat.fleeHpPct ?? 20}" style="width:65px">
              </div>
            </div>
          </div>
        ` : ''}

        <!-- МОДУЛЬ 5: 💬 ДИАЛОГИ ПО [E] И НАГРАДА (ЛУТ) -->
        ${npcMods.dialogue?.enabled ? `
          <div class="ecs-comp-card" style="border-color:#9b59b6">
            <div class="ecs-comp-head" data-npcmod-toggle="dialogue">
              <div class="ecs-comp-title">
                <span class="ecs-arrow">${npcMods.dialogue.collapsed ? '▶' : '▼'}</span>
                <span>💬 Диалог [E] и Лут после смерти</span>
              </div>
              <div class="ecs-comp-actions">
                <button class="ecs-comp-del" data-npcmod-remove="dialogue" type="button" title="Отключить диалоги и лут">🗑️</button>
              </div>
            </div>
            <div class="ecs-comp-body" ${npcMods.dialogue.collapsed ? 'hidden' : ''}>
              <div class="prop-row">
                <label>Говорить по [E]</label>
                <input type="checkbox" id="inpNpcDlgKeyE" ${npcMods.dialogue.interactKeyE !== false ? 'checked' : ''}>
              </div>
              <div class="prop-row">
                <label title="Фразы через вертикальную черту |">Фразы (через |)</label>
                <input class="ed-inp" id="inpNpcDlgLines" value="${(npcMods.dialogue.lines || []).join(' | ')}">
              </div>
              <div class="prop-row">
                <label>Крик при падении</label>
                <input class="ed-inp" id="inpNpcOopsChat" value="${npcMods.dialogue.oopsChat || 'Ой, я падаю! 😱'}">
              </div>
              <div class="prop-row">
                <label>Дроп R$ / Респ.(с)</label>
                <div class="vec3" style="grid-template-columns:1fr 1fr">
                  <input type="number" step="5" min="0" class="ed-inp" id="inpNpcDropCoins" value="${npcMods.dialogue.dropCoins ?? 15}" title="Награда монетами R$ за победу над NPC">
                  <input type="number" step="0.5" min="0.5" class="ed-inp" id="inpNpcRespTime" value="${npcMods.dialogue.respawnTime ?? 3.5}" title="Время возрождения NPC (сек)">
                </div>
              </div>
              <div class="prop-row">
                <label>Ронять оружие</label>
                <input type="checkbox" id="inpNpcDropItem" ${npcMods.dialogue.dropEquippedItem ? 'checked' : ''}>
                <label style="flex:1;text-align:right;color:#ff6b6b" title="Если включено — после гибели этот NPC не возрождается до перезапуска">💀 Умирать навсегда</label>
                <input type="checkbox" id="inpNpcPermDeath" ${npcMods.dialogue.permanentDeath ? 'checked' : ''}>
              </div>
            </div>
          </div>
        ` : ''}

        <!-- МОДУЛЬ 6: 🧩 СКРИПТ-АДДОН ИИ (DEBIX SCRIPT) -->
        ${npcMods.customScript?.enabled ? renderScriptAddonInspectorCardHTML(
          npcMods.customScript,
          'npc',
          true
        ) : ''}

        ${addNpcModMenuHTML}
      `;
    }

    cont.innerHTML = `
      <div class="prop-group" style="border-color:${ent.isP ? '#ffce3a' : '#56f0ff'}">
        <h5>
          <span>${ent.isP ? '👑 Игрок (Player R6)' : '🤖 Модульный NPC R6'}</span>
          <button class="ed-btn" id="btnCharSavePrefab" type="button" style="padding:2px 6px;font-size:9.5px" title="Сохранить персонажа в нижнюю панель префабов">💾 В префаб</button>
        </h5>
        ${S.itemStudioOpen ? `
          <button class="ed-btn" id="btnCharExitStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:5px;background:rgba(255,179,0,0.16);border-color:#ffb300;color:#ffe082">📍 Вернуться на карту (Выйти из 3D STUDIO)</button>
        ` : `
          <button class="ed-btn apply-oneclick" id="btnCharOpenStudio3D" type="button" style="width:100%;justify-content:center;margin-bottom:5px;background:rgba(86,240,255,0.16);border-color:#56f0ff;color:#56f0ff">🛠️ Открыть персонажа в 3D STUDIO</button>
        `}

        <div class="prop-row"><label>Имя</label><input class="ed-inp" id="inpCharName" value="${ent.name || 'NPC'}"></div>
        ${!ent.isP ? `
          <div class="prop-row"><label>Реплика / Чат</label><input class="ed-inp" id="inpCharChat" placeholder="Фраза над головой..." value="${ent.chat || ''}"></div>
        ` : ''}

        <div class="prop-row"><label>Позиция X/Y/Z</label><div class="vec3">
          <input type="number" step="0.5" class="ed-inp" id="inpCharPX" value="${(ent.x || 0).toFixed(2)}">
          <input type="number" step="0.5" class="ed-inp" id="inpCharPY" value="${(ent.y || 0).toFixed(2)}">
          <input type="number" step="0.5" class="ed-inp" id="inpCharPZ" value="${(ent.z || 0).toFixed(2)}">
        </div></div>
        <div class="prop-row">
          <label>Поворот Y° / Рост</label>
          <div class="vec3" style="grid-template-columns:1fr 1fr">
            <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpCharRotY" value="${formatSnapDeg(ent.rot || ent.yaw || 0)}" title="Поворот вокруг оси Y">
            <input type="number" step="0.1" min="0.4" max="5" class="ed-inp" id="inpCharScale" value="${(ent.rig?.g?.scale?.x || ent.scale || 1).toFixed(2)}" title="Масштаб персонажа">
          </div>
        </div>
      </div>

      <!-- ЗДОРОВЬЕ И БАЗОВЫЕ СТАТЫ -->
      <div class="prop-group" style="border-color:#00e676">
        <h5>❤️ Здоровье и Характеристики</h5>
        <div class="prop-row">
          <label>Уязвимость (HP)</label>
          <input type="checkbox" id="inpCharHpOn" ${ent.hpEnabled ? 'checked' : ''}>
          <label style="flex:1;text-align:right">HP / Макс.HP</label>
          <input type="number" step="10" min="1" class="ed-inp" id="inpCharHp" value="${ent.hp ?? 100}" style="width:58px">
          <input type="number" step="10" min="1" class="ed-inp" id="inpCharMaxHp" value="${ent.maxHp ?? 100}" style="width:58px">
        </div>
        ${ent.isP ? `
          <div class="prop-row">
            <label>Тип походки</label>
            <select class="ed-inp" id="inpPlayerGait">
              <option value="normal" ${(ent.gait || 'normal') === 'normal' ? 'selected' : ''}>🚶 Обычный (Классический R6)</option>
              <option value="monster" ${ent.gait === 'monster' ? 'selected' : ''}>🧟 Монстр (Руки вперёд + удар 2 руками)</option>
              <option value="levitate" ${ent.gait === 'levitate' ? 'selected' : ''}>🧞 Левитация (Парение над землёй)</option>
            </select>
          </div>
          <div class="prop-row">
            <label>Бег / Прыжок</label>
            <div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="0.5" min="2" max="30" class="ed-inp" id="inpCharWalkSpd" value="${ent.walkSpeed ?? 7.6}" title="Скорость бега">
              <input type="number" step="0.5" min="4" max="35" class="ed-inp" id="inpCharJumpPwr" value="${ent.jumpPower ?? 10.2}" title="Сила прыжка">
            </div>
          </div>
          <div class="prop-row">
            <label>Урон руки / R$</label>
            <div class="vec3" style="grid-template-columns:1fr 1fr">
              <input type="number" step="5" min="0" class="ed-inp" id="inpCharMeleeDmg" value="${ent.meleeDamage ?? 25}" title="Базовый урон ударом руки">
              <input type="number" step="25" min="0" class="ed-inp" id="inpCharCash" value="${ent.cash ?? 0}" title="Баланс монет R$">
            </div>
          </div>
        ` : ''}
          <div class="prop-row">
            <label title="Вес влияет на гравитацию персонажа, плавучесть в воде и способность толкать/поднимать тяжёлые физические блоки">⚖️ Вес (кг)</label>
            <input type="number" step="5" min="5" max="2000" class="ed-inp" id="inpCharWeight" value="${ent.weight ?? 70}" style="width:80px;font-weight:800;color:#ffce3a">
            <span style="font-size:10px;color:#94a3b8">Подымает до ${Math.round((ent.weight ?? 70) * 0.9)} кг</span>
          </div>
          <div class="prop-row">
            <label title="Постоянная аура эффекта на персонаже (макс. стак, иммунитет к урону от своего эффекта)">🧪 Источник эффекта</label>
            <select class="ed-inp" id="inpCharEffSrc" style="flex:1">
              <option value="none" ${(!ent.effectSource || ent.effectSource === 'none') ? 'selected' : ''}>⚪ Нет</option>
              <option value="poison" ${ent.effectSource === 'poison' ? 'selected' : ''}>☠️ Источник Отравления</option>
              <option value="burn" ${ent.effectSource === 'burn' ? 'selected' : ''}>🔥 Источник Горения</option>
              <option value="freeze" ${ent.effectSource === 'freeze' ? 'selected' : ''}>❄️ Источник Заморозки</option>
            </select>
          </div>
        ${!ent.isP && npcMods ? `
          <div class="prop-row" style="border-top:1px dashed #283147;padding-top:5px;margin-top:2px">
            <label style="flex:1;color:#ff6b6b" title="Если включено — после гибели NPC исчезает навсегда (не возрождается)">💀 Умирать навсегда</label>
            <input type="checkbox" id="inpNpcBasePermDeath" ${(ent.permanentDeath || npcMods.dialogue?.permanentDeath) ? 'checked' : ''}>
            <label style="margin-left:8px;color:#94a3b8" title="Через сколько секунд NPC возродится, если смерть не навсегда">Респ.(с)</label>
            <input type="number" step="0.5" min="0.5" max="120" class="ed-inp" id="inpNpcBaseRespTime" value="${npcMods.dialogue?.respawnTime ?? 3.5}" style="width:58px" ${(ent.permanentDeath || npcMods.dialogue?.permanentDeath) ? 'disabled' : ''}>
          </div>
        ` : ''}
      </div>

      ${npcModulesHTML}

      <!-- ВНЕШНИЙ ВИД И ЦВЕТА КОНЕЧНОСТЕЙ R6 -->
      <div class="prop-group" style="border-color:#00a2ff">
        <h5>🎨 Цвета частей тела (R6) и Лицо</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px">
          <label style="display:flex;align-items:center;gap:5px;font:700 10px var(--f)"><input type="color" class="ed-color" id="inpColHead" value="${headHex}"> Голова</label>
          <label style="display:flex;align-items:center;gap:5px;font:700 10px var(--f)"><input type="color" class="ed-color" id="inpColTorso" value="${torsoHex}"> Торс</label>
          <label style="display:flex;align-items:center;gap:5px;font:700 10px var(--f)"><input type="color" class="ed-color" id="inpColArmL" value="${armLHex}"> Л.Рука</label>
          <label style="display:flex;align-items:center;gap:5px;font:700 10px var(--f)"><input type="color" class="ed-color" id="inpColArmR" value="${armRHex}"> П.Рука</label>
          <label style="display:flex;align-items:center;gap:5px;font:700 10px var(--f)"><input type="color" class="ed-color" id="inpColLegL" value="${legLHex}"> Л.Нога</label>
          <label style="display:flex;align-items:center;gap:5px;font:700 10px var(--f)"><input type="color" class="ed-color" id="inpColLegR" value="${legRHex}"> П.Нога</label>
        </div>
        <div style="display:flex;gap:5px;margin-top:5px">
          <button class="ed-btn" id="btnPaintCharFace" type="button" style="flex:1;justify-content:center">😊 Нарисовать лицо</button>
          <button class="ed-btn" id="btnPaintCharShirt" type="button" style="flex:1;justify-content:center">👕 Принт на торс</button>
        </div>
      </div>

      <!-- 3D АКСЕССУАРЫ И ПИТОМЦЫ ПЕРСОНАЖА -->
      <div class="prop-group" style="border-color:#ff9f43">
        <h5>🎩 3D Аксессуары и Питомцы (${ent.preset.customCosmetics.length})</h5>
        <div style="display:flex;gap:5px;margin-bottom:5px">
          <button class="ed-btn apply-oneclick" id="btnAddNewHat" type="button" style="flex:1;justify-content:center">➕ Создать Аксессуар</button>
          <button class="ed-btn apply-oneclick" id="btnAddNewPet" type="button" style="flex:1;justify-content:center">🐾 Создать Питомца</button>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${cosListHTML}
        </div>
      </div>

      <!-- ТОЧКИ ХВАТА 1 И 2 РУК -->
      <div class="prop-group">
        <h5>🤚 Сокеты Хвата (1 рука и 2 руки)</h5>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-bottom:5px">
          <button class="ed-btn ${editMode === 'root' ? 'active' : ''}" data-chmode="root" type="button" style="justify-content:center">🧍 Персонаж</button>
          <button class="ed-btn ${editMode === 'hand_grip' ? 'active' : ''}" data-chmode="hand_grip" type="button" style="justify-content:center;border-color:#00e676">🤚 Хват 1 руки</button>
          <button class="ed-btn ${editMode === 'carry_grip' ? 'active' : ''}" data-chmode="carry_grip" type="button" style="justify-content:center;border-color:#00d2ff">📦 Хват 2 рук</button>
        </div>
        <div class="prop-row"><label>1 Рука X/Y/Z</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip1X" value="${(hp.x || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip1Y" value="${(hp.y || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip1Z" value="${(hp.z || 0).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>1 Рука Пов°</label><div class="vec3">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpChGrip1RX" value="${formatSnapDeg(hp.rx)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpChGrip1RY" value="${formatSnapDeg(hp.ry)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpChGrip1RZ" value="${formatSnapDeg(hp.rz)}">
        </div></div>
        <div class="prop-row"><label>2 Руки X/Y/Z</label><div class="vec3">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip2X" value="${(cp.x || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip2Y" value="${(cp.y || 0).toFixed(2)}">
          <input type="number" step="0.05" class="ed-inp" id="inpChGrip2Z" value="${(cp.z || 0).toFixed(2)}">
        </div></div>
        <div class="prop-row"><label>2 Руки Пов°</label><div class="vec3">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpChGrip2RX" value="${formatSnapDeg(cp.rx)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpChGrip2RY" value="${formatSnapDeg(cp.ry)}">
          <input type="number" step="${MIN_ROTATION_STEP_DEG}" class="ed-inp" id="inpChGrip2RZ" value="${formatSnapDeg(cp.rz)}">
        </div></div>
      </div>
    `;

    if ($('btnCharSavePrefab')) {
      $('btnCharSavePrefab').onclick = () => saveSelectedObjectAsPrefab();
    }
    if ($('btnCharOpenStudio3D')) {
      $('btnCharOpenStudio3D').onclick = () => {
        selectEditorObject({ kind: 'char', ent, editMode, inStudio: true }, true);
      };
    }
    if ($('btnCharExitStudio3D')) {
      $('btnCharExitStudio3D').onclick = () => {
        closeItemStudio3D(true);
      };
    }

    $('inpCharName').oninput = e => {
      ent.name = e.target.value || 'NPC';
      refreshEntityTagWithHP(ent);
      refreshHierarchyUI();
    };
    if ($('inpCharChat')) {
      $('inpCharChat').oninput = e => {
        ent.chat = e.target.value;
        if (npcMods?.dialogue) {
          npcMods.dialogue.lines[0] = ent.chat;
        }
        refreshEntityTagWithHP(ent);
      };
    }

    const applyCharTransform = () => {
      ent.x = +$('inpCharPX').value || 0;
      ent.y = +$('inpCharPY').value || 0;
      ent.z = +$('inpCharPZ').value || 0;
      ent.rot = snapAngleRad(THREE.MathUtils.degToRad(+$('inpCharRotY').value || 0));
      ent.yaw = ent.rot;
      if (ent.isCustomNPC) {
        ent.homeX = ent.x;
        ent.homeY = ent.y;
        ent.homeZ = ent.z;
      }
      const sc = clamp(+$('inpCharScale').value || 1, 0.4, 5);
      ent.scale = sc;
      if (ent.rig && ent.rig.g) {
        if (!S.itemStudioOpen) {
          ent.rig.g.position.set(ent.x, ent.y, ent.z);
          ent.rig.g.rotation.y = ent.rot;
        }
        ent.rig.g.scale.setScalar(sc);
        ent.rig.g.updateMatrixWorld(true);
        selBoxHelper.setFromObject(ent.rig.g);
      }
      if (ent.tag && !S.itemStudioOpen) {
        ent.tag.position.set(ent.x, ent.y + (ent.isArchangel ? 4.5 : 3.35), ent.z);
      }
      if (S.itemStudioOpen) syncItemStudioPreview();
      if (ent.isCustomNPC && window.__debixSyncNpcUpsert && !S.isApplyingRemoteSync) {
        window.__debixSyncNpcUpsert(ent, true);
      }
    };
    ['inpCharPX', 'inpCharPY', 'inpCharPZ', 'inpCharRotY', 'inpCharScale'].forEach(id => {
      if ($(id)) {
        $(id).onfocus = () => pushUndoState('Трансформация персонажа');
        $(id).oninput = applyCharTransform;
      }
    });

    const syncCharStats = () => {
      ent.hpEnabled = $('inpCharHpOn').checked;
      ent.maxHp = Math.max(1, +$('inpCharMaxHp').value || 100);
      ent.hp = clamp(+$('inpCharHp').value || ent.maxHp, 1, ent.maxHp);
      if ($('inpCharWeight')) ent.weight = clamp(+$('inpCharWeight').value || 70, 5, 2000);
      if ($('inpCharEffSrc')) ent.effectSource = $('inpCharEffSrc').value;
      if (ent.isP) {
        ent.baseMaxHp = ent.maxHp;
        if ($('inpPlayerGait')) ent.gait = $('inpPlayerGait').value;
        if ($('inpCharWalkSpd')) ent.walkSpeed = clamp(+$('inpCharWalkSpd').value || 7.6, 2, 30);
        if ($('inpCharJumpPwr')) ent.jumpPower = clamp(+$('inpCharJumpPwr').value || 10.2, 4, 35);
        if ($('inpCharMeleeDmg')) ent.meleeDamage = Math.max(0, +$('inpCharMeleeDmg').value || 25);
        if ($('inpCharCash')) ent.cash = Math.max(0, +$('inpCharCash').value || 0);
        updateShopUI();
      } else if (npcMods) {
        if ($('inpCharMeleeDmg')) ent.meleeDamage = Math.max(1, +$('inpCharMeleeDmg').value || 15);
      }
      refreshEntityTagWithHP(ent);
    };
    ['inpCharHpOn', 'inpCharHp', 'inpCharMaxHp', 'inpCharWeight', 'inpCharEffSrc', 'inpPlayerGait', 'inpCharWalkSpd', 'inpCharJumpPwr', 'inpCharMeleeDmg', 'inpCharCash'].forEach(id => {
      if ($(id)) {
        $(id).oninput = syncCharStats;
        $(id).onchange = syncCharStats;
      }
    });

    if ($('inpNpcBasePermDeath') && npcMods) {
      $('inpNpcBasePermDeath').onchange = e => {
        const perm = e.target.checked;
        ent.permanentDeath = perm;
        if (npcMods.dialogue) npcMods.dialogue.permanentDeath = perm;
        if ($('inpNpcPermDeath')) $('inpNpcPermDeath').checked = perm;
        if ($('inpNpcBaseRespTime')) $('inpNpcBaseRespTime').disabled = perm;
        if (ent.isCustomNPC && window.__debixSyncNpcUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncNpcUpsert(ent, true);
        }
      };
    }
    if ($('inpNpcBaseRespTime') && npcMods) {
      $('inpNpcBaseRespTime').oninput = e => {
        const sec = Math.max(0.5, +e.target.value || 3.5);
        if (npcMods.dialogue) npcMods.dialogue.respawnTime = sec;
        if ($('inpNpcRespTime')) $('inpNpcRespTime').value = sec;
      };
    }

    // Обработчики модулей NPC
    if (!ent.isP && npcMods) {
      bindCustomFactionsEditorEvents(cont, newFac => {
        npcMods.combat.faction = newFac.id;
      });
      if ($('btnToggleAddNpcMod')) { 
        $('btnToggleAddNpcMod').onclick = () => {
          const m = $('ecsAddNpcModMenu');
          if (m) m.hidden = !m.hidden;
        };
      }

      cont.querySelectorAll('[data-add-npcmod]').forEach(btn => {
        btn.onclick = () => {
          const key = btn.dataset.addNpcmod;
          pushUndoState(`Включение модуля NPC: ${key}`);
          if (key === 'customScript' && (!npcMods.customScript || !npcMods.customScript.scripts)) {
            npcMods.customScript = createDefaultScriptData('npc');
          }
          if (npcMods[key]) {
            npcMods[key].enabled = true;
            npcMods[key].collapsed = false;
            if (key === 'customScript' && Array.isArray(npcMods.customScript.scripts) && npcMods.customScript.scripts[0]) {
              npcMods.customScript.scripts[0].enabled = true;
            }
          }
          ensureNpcModules(ent);
          refreshEntityTagWithHP(ent);
          sfx.jump();
          _renderInspectorUICore();
        };
      });

      cont.querySelectorAll('[data-npcmod-toggle]').forEach(head => {
        head.onclick = e => {
          if (e.target.closest('button')) return;
          const key = head.dataset.npcmodToggle;
          if (npcMods[key]) {
            npcMods[key].collapsed = !npcMods[key].collapsed;
            _renderInspectorUICore();
          }
        };
      });

      cont.querySelectorAll('[data-npcmod-remove]').forEach(btn => {
        btn.onclick = e => {
          e.stopPropagation();
          const key = btn.dataset.npcmodRemove;
          pushUndoState(`Отключение модуля NPC: ${key}`);
          if (npcMods[key]) npcMods[key].enabled = false;
          ensureNpcModules(ent);
          refreshEntityTagWithHP(ent);
          sfx.oof();
          _renderInspectorUICore();
        };
      });

      if ($('selNpcEquipPreset')) {
        $('selNpcEquipPreset').onchange = e => {
          const val = e.target.value;
          if (!val) return;
          pushUndoState('Экипировка оружия NPC');
          if (val.startsWith('tpl:')) {
            const tplKey = val.replace('tpl:', '');
            ent.equippedItem = normalizeItemData(createStarterItemTemplate(tplKey));
          } else if (val.startsWith('lib:')) {
            const idx = +val.replace('lib:', '');
            if (S.savedItemsLibrary[idx]) {
              ent.equippedItem = normalizeItemData(JSON.parse(JSON.stringify(S.savedItemsLibrary[idx])));
            }
          }
          syncEntityHeldItemMesh(ent);
          sfx.coil();
          _renderInspectorUICore();
        };
      }

      if ($('btnNpcUnequipItem')) {
        $('btnNpcUnequipItem').onclick = () => {
          pushUndoState('Снятие оружия NPC');
          ent.equippedItem = null;
          syncEntityHeldItemMesh(ent);
          sfx.oof();
          _renderInspectorUICore();
        };
      }

      if ($('btnNpcAddCurPosWp')) {
        $('btnNpcAddCurPosWp').onclick = () => {
          pushUndoState('Добавление точки патруля NPC');
          npcMods.navigation.waypoints.push({ x: Number(ent.x.toFixed(2)), y: Number(ent.y.toFixed(2)), z: Number(ent.z.toFixed(2)) });
          sfx.jump();
          _renderInspectorUICore();
        };
      }

      cont.querySelectorAll('[data-npc-wp-del]').forEach(btn => {
        btn.onclick = () => {
          const wIdx = +btn.dataset.npcWpDel;
          npcMods.navigation.waypoints.splice(wIdx, 1);
          _renderInspectorUICore();
        };
      });

      const syncNpcModulesInputs = (rerender = false) => {
        if ($('inpNpcGravScale')) npcMods.worldPhysics.gravityScale = clamp(+$('inpNpcGravScale').value || 1.0, 0.2, 3.0);
        if ($('inpNpcCanSwim')) npcMods.worldPhysics.canSwim = $('inpNpcCanSwim').checked;
        if ($('inpNpcFallDmg')) npcMods.worldPhysics.fallDamage = $('inpNpcFallDmg').checked;
        if ($('inpNpcHazardDmg')) npcMods.worldPhysics.hazardDamage = $('inpNpcHazardDmg').checked;
        if ($('inpNpcPickupItm')) npcMods.worldPhysics.canPickupItems = $('inpNpcPickupItm').checked;
        if ($('inpNpcInteractBlk')) npcMods.worldPhysics.canInteractBlocks = $('inpNpcInteractBlk').checked;

        if ($('inpNpcNavMode')) npcMods.navigation.mode = $('inpNpcNavMode').value;
        if ($('inpNpcIntel')) npcMods.navigation.intelligence = $('inpNpcIntel').value;
        if ($('inpNpcGait')) npcMods.navigation.gait = $('inpNpcGait').value;
        if ($('inpNpcCanSprint')) npcMods.navigation.canSprint = $('inpNpcCanSprint').checked;
        if ($('inpNpcSprintMult')) npcMods.navigation.sprintMultiplier = clamp(+$('inpNpcSprintMult').value || 1.48, 1.1, 2.5);
        if ($('inpNpcWalkSpd')) npcMods.navigation.walkSpeed = clamp(+$('inpNpcWalkSpd').value || 5.4, 1.5, 24);
        if ($('inpNpcJumpPwr')) npcMods.navigation.jumpPower = clamp(+$('inpNpcJumpPwr').value || 10.2, 4, 30);
        if ($('inpNpcWanderRad')) npcMods.navigation.wanderRadius = Math.max(1.5, +$('inpNpcWanderRad').value || 10.0);
        if ($('inpNpcFollowDist')) npcMods.navigation.followDist = Math.max(1.5, +$('inpNpcFollowDist').value || 3.2);
        if ($('inpNpcCanJump')) npcMods.navigation.canJump = $('inpNpcCanJump').checked;
        if ($('inpNpcJumpGaps')) npcMods.navigation.jumpGaps = $('inpNpcJumpGaps').checked;
        if ($('inpNpcPathfind')) npcMods.navigation.usePathfinding = $('inpNpcPathfind').checked;

        if ($('inpNpcErrLevel')) {
          npcMods.humanError.mistakeLevel = clamp(+$('inpNpcErrLevel').value || 0.25, 0.05, 1.0);
          if ($('txtNpcErrLevel')) $('txtNpcErrLevel').textContent = `${Math.round(npcMods.humanError.mistakeLevel * 100)}%`;
        }
        if ($('inpNpcJumpErr')) npcMods.humanError.jumpMistakeChance = clamp(+$('inpNpcJumpErr').value || 0, 0, 1);
        if ($('inpNpcPathErr')) npcMods.humanError.pathNoise = clamp(+$('inpNpcPathErr').value || 0, 0, 1);
        if ($('inpNpcHesitate')) npcMods.humanError.hesitationChance = clamp(+$('inpNpcHesitate').value || 0, 0, 1);
        if ($('inpNpcAimErr')) npcMods.humanError.aimError = clamp(+$('inpNpcAimErr').value || 0, 0, 1);

        if ($('inpNpcStance')) npcMods.combat.stance = $('inpNpcStance').value;
        if ($('inpNpcFaction')) npcMods.combat.faction = $('inpNpcFaction').value;
        if ($('inpNpcAtkFactions')) npcMods.combat.attackOtherFactions = $('inpNpcAtkFactions').checked;
        if ($('inpNpcCallHelp')) npcMods.combat.callForHelp = $('inpNpcCallHelp').checked;
        if ($('inpNpcAggroRad')) npcMods.combat.aggroRadius = Math.max(2, +$('inpNpcAggroRad').value || 14);
        if ($('inpNpcAccuracy')) {
          npcMods.combat.accuracy = clamp(+$('inpNpcAccuracy').value || 0.75, 0.05, 1.0);
          if ($('txtNpcAccuracy')) $('txtNpcAccuracy').textContent = `${Math.round(npcMods.combat.accuracy * 100)}%`;
        }
        if ($('inpNpcRespectReload')) npcMods.combat.respectAmmoReload = $('inpNpcRespectReload').checked;
        if ($('inpNpcFleeLow')) npcMods.combat.fleeLowHp = $('inpNpcFleeLow').checked;
        if ($('inpNpcFleePct')) npcMods.combat.fleeHpPct = clamp(+$('inpNpcFleePct').value || 20, 5, 80);

        if ($('inpNpcDlgKeyE')) npcMods.dialogue.interactKeyE = $('inpNpcDlgKeyE').checked;
        if ($('inpNpcDlgLines')) {
          npcMods.dialogue.lines = $('inpNpcDlgLines').value.split('|').map(s => s.trim()).filter(Boolean);
          if (npcMods.dialogue.lines.length > 0) ent.chat = npcMods.dialogue.lines[0];
        }
        if ($('inpNpcOopsChat')) npcMods.dialogue.oopsChat = $('inpNpcOopsChat').value;
        if ($('inpNpcDropCoins')) npcMods.dialogue.dropCoins = Math.max(0, +$('inpNpcDropCoins').value || 0);
        if ($('inpNpcRespTime')) {
          npcMods.dialogue.respawnTime = Math.max(0.5, +$('inpNpcRespTime').value || 3.5);
          if ($('inpNpcBaseRespTime')) $('inpNpcBaseRespTime').value = npcMods.dialogue.respawnTime;
        }
        if ($('inpNpcDropItem')) npcMods.dialogue.dropEquippedItem = $('inpNpcDropItem').checked;
        if ($('inpNpcPermDeath')) {
          const perm = $('inpNpcPermDeath').checked;
          npcMods.dialogue.permanentDeath = perm;
          ent.permanentDeath = perm;
          if ($('inpNpcBasePermDeath')) $('inpNpcBasePermDeath').checked = perm;
          if ($('inpNpcBaseRespTime')) $('inpNpcBaseRespTime').disabled = perm;
        }

        ensureNpcModules(ent);
        refreshEntityTagWithHP(ent);
        if (ent.isCustomNPC && window.__debixSyncNpcUpsert && !S.isApplyingRemoteSync) {
          window.__debixSyncNpcUpsert(ent, true);
        }
        if (rerender) _renderInspectorUICore();
      };

      if (ent.aiModules?.customScript?.enabled) {
        bindScriptAddonInspectorEvents(
          cont,
          ent.aiModules.customScript,
          'npc',
          (needFullRefresh) => {
            if (needFullRefresh) _renderInspectorUICore();
          },
          () => {
            ent.aiModules.customScript.enabled = false;
            if (Array.isArray(ent.aiModules.customScript.scripts)) {
              ent.aiModules.customScript.scripts.forEach(s => { if (s) s.enabled = false; });
            }
            _renderInspectorUICore();
          }
        );
      }

      ['inpNpcNavMode', 'inpNpcStance', 'inpNpcIntel', 'inpNpcFaction', 'inpNpcAtkFactions', 'inpNpcCallHelp'].forEach(id => {
        if ($(id)) $(id).onchange = () => syncNpcModulesInputs(true);
      });

      [
        'inpNpcGravScale', 'inpNpcCanSwim', 'inpNpcFallDmg', 'inpNpcHazardDmg',
        'inpNpcPickupItm', 'inpNpcInteractBlk', 'inpNpcIntel', 'inpNpcGait',
        'inpNpcCanSprint', 'inpNpcSprintMult',
        'inpNpcWalkSpd', 'inpNpcJumpPwr', 'inpNpcWanderRad', 'inpNpcFollowDist',
        'inpNpcCanJump', 'inpNpcJumpGaps', 'inpNpcPathfind',
        'inpNpcErrLevel', 'inpNpcJumpErr', 'inpNpcPathErr', 'inpNpcHesitate', 'inpNpcAimErr',
        'inpNpcFaction', 'inpNpcAtkFactions', 'inpNpcCallHelp',
        'inpNpcAggroRad', 'inpNpcAccuracy', 'inpNpcRespectReload', 'inpNpcFleeLow', 'inpNpcFleePct',
        'inpNpcDlgKeyE', 'inpNpcDlgLines', 'inpNpcOopsChat', 'inpNpcDropCoins', 'inpNpcRespTime', 'inpNpcDropItem', 'inpNpcPermDeath'
      ].forEach(id => {
        if ($(id)) {
          $(id).oninput = () => syncNpcModulesInputs(false);
          $(id).onchange = () => syncNpcModulesInputs(false);
        }
      });
    }

    const applyLimbColors = () => {
      ent.preset.head = $('inpColHead').value;
      ent.preset.torso = $('inpColTorso').value;
      ent.preset.armL = $('inpColArmL').value;
      ent.preset.armR = $('inpColArmR').value;
      ent.preset.arms = ent.preset.armL;
      ent.preset.legL = $('inpColLegL').value;
      ent.preset.legR = $('inpColLegR').value;
      ent.preset.legs = ent.preset.legL;
      attachRigToEntity(ent);
      if (S.itemStudioOpen) syncItemStudioPreview();
      if (ent.isCustomNPC && window.__debixSyncNpcUpsert && !S.isApplyingRemoteSync) {
        window.__debixSyncNpcUpsert(ent, true);
      }
    };
    ['inpColHead', 'inpColTorso', 'inpColArmL', 'inpColArmR', 'inpColLegL', 'inpColLegR'].forEach(id => {
      if ($(id)) {
        $(id).onfocus = () => pushUndoState('Смена цвета персонажа');
        $(id).oninput = applyLimbColors;
      }
    });

    if ($('btnPaintCharFace')) $('btnPaintCharFace').onclick = () => openPaintModal('face');
    if ($('btnPaintCharShirt')) $('btnPaintCharShirt').onclick = () => openPaintModal('shirt');

    $('btnAddNewHat').onclick = () => {
      pushUndoState('Создание 3D аксессуара');
      const newCos = normalizeCosmeticItem({
        id: 'cos_' + Date.now(),
        name: 'Новый Аксессуар',
        parentSlot: 'head',
        enabled: true,
        parts: [
          {
            id: 'pt_' + Date.now(),
            name: 'Основа #1',
            shape: 'box',
            x: 0, y: 0.55, z: 0,
            rx: 0, ry: 0, rz: 0,
            sx: 0.9, sy: 0.35, sz: 0.9,
            color: '#ffce3a'
          }
        ]
      });
      ent.preset.customCosmetics.push(newCos);
      ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
      attachRigToEntity(ent);
      const grp = ent.rig.customCosMeshes.find(g => g.userData?.cosmeticItem === newCos);
      selectEditorObject({ kind: 'cosmetic', ent, item: newCos, group: grp, partIdx: 0, inWorldPlacement: false });
      sfx.jump();
    };

    $('btnAddNewPet').onclick = () => {
      pushUndoState('Создание 3D питомца');
      const newPet = createStarterPetItem();
      ent.preset.customCosmetics.push(newPet);
      ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
      attachRigToEntity(ent);
      const grp = ent.rig.customCosMeshes.find(g => g.userData?.cosmeticItem === newPet);
      selectEditorObject({ kind: 'cosmetic', ent, item: newPet, group: grp, partIdx: 0, inWorldPlacement: false });
      sfx.jump();
    };

    cont.querySelectorAll('[data-cos-toggle]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.cosToggle;
        const cos = ent.preset.customCosmetics[idx];
        if (!cos) return;
        cos.enabled = cos.enabled === false;
        ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
        attachRigToEntity(ent);
        if (S.itemStudioOpen) syncItemStudioPreview();
        _renderInspectorUICore();
      };
    });

    cont.querySelectorAll('[data-cos-edit]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.cosEdit;
        const cos = ent.preset.customCosmetics[idx];
        if (!cos) return;
        const grp = ent.rig.customCosMeshes.find(g => g.userData?.cosmeticItem === cos);
        selectEditorObject({ kind: 'cosmetic', ent, item: cos, group: grp, partIdx: 0, inWorldPlacement: false });
      };
    });

    cont.querySelectorAll('[data-cos-del]').forEach(btn => {
      btn.onclick = () => {
        const idx = +btn.dataset.cosDel;
        pushUndoState('Удаление аксессуара');
        ent.preset.customCosmetics.splice(idx, 1);
        ent.rig.syncCustomCosmetics(ent.preset.customCosmetics);
        attachRigToEntity(ent);
        if (S.itemStudioOpen) syncItemStudioPreview();
        sfx.oof();
        _renderInspectorUICore();
      };
    });

    cont.querySelectorAll('[data-chmode]').forEach(btn => {
      btn.onclick = () => {
        selectEditorObject({
          kind: 'char',
          ent,
          editMode: btn.dataset.chmode,
          inStudio: S.itemStudioOpen
        }, true);
      };
    });

    const applyCharGripSockets = () => {
      ent.preset.handGripPoint.x = +$('inpChGrip1X').value || 0;
      ent.preset.handGripPoint.y = +$('inpChGrip1Y').value || 0;
      ent.preset.handGripPoint.z = +$('inpChGrip1Z').value || 0;
      ent.preset.handGripPoint.rx = snapAngleRad(THREE.MathUtils.degToRad(+$('inpChGrip1RX').value || 0));
      ent.preset.handGripPoint.ry = snapAngleRad(THREE.MathUtils.degToRad(+$('inpChGrip1RY').value || 0));
      ent.preset.handGripPoint.rz = snapAngleRad(THREE.MathUtils.degToRad(+$('inpChGrip1RZ').value || 0));

      ent.preset.carryGripPoint.x = +$('inpChGrip2X').value || 0;
      ent.preset.carryGripPoint.y = +$('inpChGrip2Y').value || 0;
      ent.preset.carryGripPoint.z = +$('inpChGrip2Z').value || 0;
      ent.preset.carryGripPoint.rx = snapAngleRad(THREE.MathUtils.degToRad(+$('inpChGrip2RX').value || 0));
      ent.preset.carryGripPoint.ry = snapAngleRad(THREE.MathUtils.degToRad(+$('inpChGrip2RY').value || 0));
      ent.preset.carryGripPoint.rz = snapAngleRad(THREE.MathUtils.degToRad(+$('inpChGrip2RZ').value || 0));

      if (ent.rig?.syncGripSockets) ent.rig.syncGripSockets(ent.preset);
      if (S.studioMannequinRig?.syncGripSockets && S.itemStudioOpen) {
        S.studioMannequinRig.syncGripSockets(ent.preset);
      }
    };
    [
      'inpChGrip1X', 'inpChGrip1Y', 'inpChGrip1Z', 'inpChGrip1RX', 'inpChGrip1RY', 'inpChGrip1RZ',
      'inpChGrip2X', 'inpChGrip2Y', 'inpChGrip2Z', 'inpChGrip2RX', 'inpChGrip2RY', 'inpChGrip2RZ'
    ].forEach(id => {
      if ($(id)) $(id).oninput = applyCharGripSockets;
    });
    return;
  }
}

export function syncInspectorInputsFromObject() {
  if (!S.selectedRef) return;
  if (S.selectedRef.kind === 'block' && $('inpPX')) {
    const box = S.selectedRef.box;
    if (S.selectedRef.editMode === 'motion_wp' && box.motionData) {
      const wp = box.motionData.waypoints[S.selectedRef.wpIdx ?? box.motionData.activeWaypointIdx ?? 0];
      if (wp && $('inpWpDX')) {
        $('inpWpDX').value = Number(wp.dx || 0).toFixed(2);
        $('inpWpDY').value = Number(wp.dy || 0).toFixed(2);
        $('inpWpDZ').value = Number(wp.dz || 0).toFixed(2);
        $('inpWpRX').value = Number(wp.rx || 0).toFixed(1);
        $('inpWpRY').value = Number(wp.ry || 0).toFixed(1);
        $('inpWpRZ').value = Number(wp.rz || 0).toFixed(1);
        $('inpWpSX').value = Number(wp.sx ?? box.w).toFixed(2);
        $('inpWpSY').value = Number(wp.sy ?? box.h).toFixed(2);
        $('inpWpSZ').value = Number(wp.sz ?? box.d).toFixed(2);
      }
      return;
    }
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
    $('inpRX').value = formatSnapDeg(m.rotation.x);
    $('inpRY').value = formatSnapDeg(m.rotation.y);
    $('inpRZ').value = formatSnapDeg(m.rotation.z);
  } else if (S.selectedRef.kind === 'char' && $('inpCharScale')) {
    const ent = S.selectedRef.ent;
    if ($('inpCharPX')) $('inpCharPX').value = (ent.x || 0).toFixed(2);
    if ($('inpCharPY')) $('inpCharPY').value = (ent.y || 0).toFixed(2);
    if ($('inpCharPZ')) $('inpCharPZ').value = (ent.z || 0).toFixed(2);
    if ($('inpCharRotY')) $('inpCharRotY').value = formatSnapDeg(ent.rot || ent.yaw || 0);
    $('inpCharScale').value = ent.rig.g.scale.x.toFixed(1);
    if (ent.isCustomNPC && window.__debixSyncNpcUpsert && !S.isApplyingRemoteSync) {
      window.__debixSyncNpcUpsert(ent, true);
    }
    if (ent.preset && ent.preset.handGripPoint && $('inpChGrip1X')) {
      const hp = ent.preset.handGripPoint;
      $('inpChGrip1X').value = (hp.x || 0).toFixed(2);
      $('inpChGrip1Y').value = (hp.y || 0).toFixed(2);
      $('inpChGrip1Z').value = (hp.z || 0).toFixed(2);
      $('inpChGrip1RX').value = formatSnapDeg(hp.rx);
      $('inpChGrip1RY').value = formatSnapDeg(hp.ry);
      $('inpChGrip1RZ').value = formatSnapDeg(hp.rz);
    }
    if (ent.preset && ent.preset.carryGripPoint && $('inpChGrip2X')) {
      const cp = ent.preset.carryGripPoint;
      $('inpChGrip2X').value = (cp.x || 0).toFixed(2);
      $('inpChGrip2Y').value = (cp.y || 0).toFixed(2);
      $('inpChGrip2Z').value = (cp.z || 0).toFixed(2);
      $('inpChGrip2RX').value = formatSnapDeg(cp.rx);
      $('inpChGrip2RY').value = formatSnapDeg(cp.ry);
      $('inpChGrip2RZ').value = formatSnapDeg(cp.rz);
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
    $('inpCosRX').value = formatSnapDeg(m.rotation.x);
    $('inpCosRY').value = formatSnapDeg(m.rotation.y);
    $('inpCosRZ').value = formatSnapDeg(m.rotation.z);
  } else if (S.selectedRef.kind === 'world_item') {
    const { item, editMode, mesh } = S.selectedRef;
    if ((editMode === 'part' || editMode === 'proj_part') && mesh && $('inpItmPX')) {
      $('inpItmPX').value = mesh.position.x.toFixed(2);
      $('inpItmPY').value = mesh.position.y.toFixed(2);
      $('inpItmPZ').value = mesh.position.z.toFixed(2);
      $('inpItmSX').value = mesh.scale.x.toFixed(2);
      $('inpItmSY').value = mesh.scale.y.toFixed(2);
      $('inpItmSZ').value = mesh.scale.z.toFixed(2);
      $('inpItmRX').value = formatSnapDeg(mesh.rotation.x);
      $('inpItmRY').value = formatSnapDeg(mesh.rotation.y);
      $('inpItmRZ').value = formatSnapDeg(mesh.rotation.z);
    } else if (editMode === 'grip' && item && $('inpGripX')) {
      $('inpGripX').value = (item.gripPoint.x || 0).toFixed(2);
      $('inpGripY').value = (item.gripPoint.y || 0).toFixed(2);
      $('inpGripZ').value = (item.gripPoint.z || 0).toFixed(2);
      $('inpGripRX').value = formatSnapDeg(item.gripPoint.rx);
      $('inpGripRY').value = formatSnapDeg(item.gripPoint.ry);
      $('inpGripRZ').value = formatSnapDeg(item.gripPoint.rz);
    } else if (editMode === 'muzzle' && item && $('inpMuzX')) {
      $('inpMuzX').value = (item.muzzlePoint.x || 0).toFixed(2);
      $('inpMuzY').value = (item.muzzlePoint.y || 0).toFixed(2);
      $('inpMuzZ').value = (item.muzzlePoint.z || 0).toFixed(2);
    }
  } else if (S.selectedRef.kind === 'empty' && S.selectedRef.emptyObj && $('inpEmpPX')) {
    const g = S.selectedRef.emptyObj.group;
    $('inpEmpPX').value = g.position.x.toFixed(2);
    $('inpEmpPY').value = g.position.y.toFixed(2);
    $('inpEmpPZ').value = g.position.z.toFixed(2);
    $('inpEmpSX').value = g.scale.x.toFixed(2);
    $('inpEmpSY').value = g.scale.y.toFixed(2);
    $('inpEmpSZ').value = g.scale.z.toFixed(2);
    $('inpEmpRX').value = formatSnapDeg(g.rotation.x);
    $('inpEmpRY').value = formatSnapDeg(g.rotation.y);
    $('inpEmpRZ').value = formatSnapDeg(g.rotation.z);
  }

  if ($('openScriptStudioTopBtn')) {
    $('openScriptStudioTopBtn').onclick = () => {
      openScriptStudioModal(null, 'block', () => {
        _renderInspectorUICore();
      });
    };
  }
}

export function renderInspectorUI() {
  _renderInspectorUICore();
  const cont = $('inspectorContent');
  enhanceAllInspectorCollapsibleWindows(cont);

  if ($('openScriptStudioTopBtn')) {
    $('openScriptStudioTopBtn').onclick = () => {
      openScriptStudioModal(null, 'block', () => {
        renderInspectorUI();
      });
    };
  }
}
