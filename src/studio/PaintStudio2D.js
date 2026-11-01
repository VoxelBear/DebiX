// src/studio/PaintStudio2D.js
import { S, $, clamp, SWATCH_COLORS, showBanner } from '../core/State.js';
import {
  drawStudPatternOnCtx,
  createBlockMaterial,
  drawFacePresetOnCtx,
  defaultFaceURL,
  setMeshFrontSprite,
  drawParticlePreset16
} from '../core/TextureFactory.js';
import { sfx } from '../core/AudioEngine.js';
import { rebuildPhysicsArrays } from '../core/WorldRegistry.js';
import { rebuildWorldItemVisual } from '../core/EntityManager.js';
import { renderInspectorUI, syncLibraryItemIfEditing } from './InspectorPanel.js';
import { pushUndoState, pushCosmeticUndoState, pushItemUndoState } from './StudioController.js';

let paintCv = null;
let paintCtx = null;
let activePaintTool = 'brush'; // 'brush' | 'bucket' | 'picker' | 'eraser'
let painting = false;
let symmetryOn = false;
let lastPX = 0;
let lastPY = 0;

// Изолированный стек Undo для 2D Студии (до 30 шагов рисования)
const MAX_PAINT_UNDO = 30;
const paintUndoStack = [];

function getCanvasRes() {
  return paintCv ? paintCv.width : 128;
}

export function isPaintModalOpen() {
  const modal = $('paintModal');
  return !!(modal && !modal.hidden);
}

export function pushPaintUndoSnapshot() {
  if (!paintCtx || !paintCv) return;
  const res = getCanvasRes();
  try {
    const snap = paintCtx.getImageData(0, 0, res, res);
    paintUndoStack.push({ res, imageData: snap });
    if (paintUndoStack.length > MAX_PAINT_UNDO) {
      paintUndoStack.shift();
    }
  } catch (e) {
    console.warn('Paint undo snapshot failed:', e);
  }
}

export function undoPaintAction() {
  if (!paintCtx || !paintCv || paintUndoStack.length === 0) {
    showBanner('↩️ В 2D Студии нет мазков для отмены', '#ffce3a');
    return false;
  }
  const prev = paintUndoStack.pop();
  if (paintCv.width !== prev.res) {
    paintCv.width = prev.res;
    paintCv.height = prev.res;
  }
  paintCtx.putImageData(prev.imageData, 0, 0);
  sfx.jump();
  showBanner(`↩️ 2D Студия: мазок отменён (осталось шагов: ${paintUndoStack.length})`, '#56f0ff');
  return true;
}

export function setPaintTool(tool) {
  activePaintTool = tool;
  $('toolBrush').classList.toggle('active', tool === 'brush');
  $('toolBucket').classList.toggle('active', tool === 'bucket');
  $('toolPicker').classList.toggle('active', tool === 'picker');
  $('toolEraser').classList.toggle('active', tool === 'eraser');
}

export function hexToRgba(hex, alphaPct = 100) {
  const v = parseInt(hex.replace('#', ''), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  const a = Math.round((clamp(alphaPct, 0, 100) / 100) * 255);
  return [r, g, b, a];
}

export function floodFillCanvas(startX, startY, fillR, fillG, fillB, fillA) {
  const res = getCanvasRes();
  const x0 = clamp(Math.floor(startX), 0, res - 1);
  const y0 = clamp(Math.floor(startY), 0, res - 1);
  const imgData = paintCtx.getImageData(0, 0, res, res);
  const data = imgData.data;
  const startIdx = (y0 * res + x0) * 4;
  const sr = data[startIdx];
  const sg = data[startIdx + 1];
  const sb = data[startIdx + 2];
  const sa = data[startIdx + 3];
  if (sr === fillR && sg === fillG && sb === fillB && sa === fillA) return;

  const visited = new Uint8Array(res * res);
  const queue = [x0 + (y0 << 8)];
  visited[y0 * res + x0] = 1;

  const match = idx =>
    Math.abs(data[idx] - sr) <= 12 &&
    Math.abs(data[idx + 1] - sg) <= 12 &&
    Math.abs(data[idx + 2] - sb) <= 12 &&
    Math.abs(data[idx + 3] - sa) <= 18;

  while (queue.length > 0) {
    const cur = queue.pop();
    const cx = cur & 255;
    const cy = cur >> 8;
    const pi = (cy * res + cx) * 4;
    data[pi] = fillR;
    data[pi + 1] = fillG;
    data[pi + 2] = fillB;
    data[pi + 3] = fillA;

    const neighbors = [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]];
    for (const [nx, ny] of neighbors) {
      if (nx >= 0 && nx < res && ny >= 0 && ny < res) {
        const ni = ny * res + nx;
        if (!visited[ni] && match(ni * 4)) {
          visited[ni] = 1;
          queue.push(nx + (ny << 8));
        }
      }
    }
  }
  paintCtx.putImageData(imgData, 0, 0);
}

export function pickColorFromCanvas(x, y) {
  const res = getCanvasRes();
  const px = clamp(Math.floor(x), 0, res - 1);
  const py = clamp(Math.floor(y), 0, res - 1);
  const d = paintCtx.getImageData(px, py, 1, 1).data;
  const hex = '#' + [d[0], d[1], d[2]].map(v => v.toString(16).padStart(2, '0')).join('');
  const alphaPct = Math.round((d[3] / 255) * 100);
  $('paintColor').value = hex;
  $('paintAlpha').value = alphaPct;
  $('paintAlphaTxt').textContent = alphaPct + '%';
  setPaintTool('brush');
  showBanner(`💧 Пипетка выбрала цвет ${hex.toUpperCase()} (Альфа: ${alphaPct}%)`, '#56f0ff');
}

export function openPaintModal(defaultTarget = 'face') {
  const sel = $('paintTargetSelect');
  if (sel && !sel.querySelector('option[value="particle"]')) {
    const opt = document.createElement('option');
    opt.value = 'particle';
    opt.textContent = '✨ Спрайт Партикла 16×16 (Блок / Часть предмета)';
    sel.appendChild(opt);
  }
  $('paintModal').hidden = false;
  $('paintTargetSelect').value = defaultTarget;
  loadTargetTextureIntoCanvas(defaultTarget);
}

function getActiveParticleDataForPainter() {
  if (!S.selectedRef) return null;
  if (S.selectedRef.kind === 'block') return S.selectedRef.box.particleData;
  if (S.selectedRef.kind === 'cosmetic') {
    const pt = S.selectedRef.part || (S.selectedRef.item && S.selectedRef.item.parts[0]);
    return pt ? pt.particleData : null;
  }
  if (S.selectedRef.kind === 'world_item') {
    if (S.paintParticleScope === 'item') {
      return S.selectedRef.item ? S.selectedRef.item.particleData : null;
    }
    const pt = S.selectedRef.part || (S.selectedRef.item && S.selectedRef.item.parts[S.selectedRef.partIdx || 0]);
    return pt ? pt.particleData : (S.selectedRef.item ? S.selectedRef.item.particleData : null);
  }
  return null;
}

export function loadTargetTextureIntoCanvas(target) {
  paintUndoStack.length = 0;
  const isParticle = target === 'particle';
  const res = isParticle ? 16 : 128;
  paintCv.width = res;
  paintCv.height = res;
  if (isParticle) {
    $('paintSize').value = 1;
  } else if (+$('paintSize').value < 3) {
    $('paintSize').value = 6;
  }

  paintCtx.clearRect(0, 0, res, res);
  const ent = (S.selectedRef && S.selectedRef.kind === 'char')
    ? S.selectedRef.ent
    : (S.selectedRef && S.selectedRef.kind === 'cosmetic' ? S.selectedRef.ent : S.player);

  let url = null;
  if (target === 'particle') {
    const pd = getActiveParticleDataForPainter();
    if (pd) {
      url = pd.texDataURL;
      if (!url) {
        drawParticlePreset16(paintCtx, pd.preset === 'custom' ? 'spark' : (pd.preset || 'spark'));
        return;
      }
    } else {
      drawParticlePreset16(paintCtx, 'spark');
      return;
    }
  } else if (target === 'face' && ent) {
    url = ent.preset.faceDataURL || defaultFaceURL;
  } else if (['head', 'torso', 'armL', 'armR', 'legL', 'legR'].includes(target) && ent) {
    url = (ent.preset.limbTex && ent.preset.limbTex[target]) || null;
  } else if (target === 'cosmetic' && S.selectedRef && (S.selectedRef.kind === 'cosmetic' || S.selectedRef.kind === 'world_item')) {
    const activePart = S.selectedRef.part || (S.selectedRef.item && S.selectedRef.item.parts && S.selectedRef.item.parts[S.selectedRef.partIdx || 0]);
    url = activePart ? activePart.texDataURL : null;
  } else if (target === 'block' && S.selectedRef && S.selectedRef.kind === 'block') {
    url = S.selectedRef.box.customTexDataURL;
  } else if (target === 'globalStuds') {
    drawStudPatternOnCtx(paintCtx, '#f2f6ff', 'rgba(160,185,220,.4)', 'round');
    return;
  }

  if (url) {
    const img = new Image();
    img.onload = () => {
      paintCtx.clearRect(0, 0, res, res);
      paintCtx.imageSmoothingEnabled = !isParticle;
      paintCtx.drawImage(img, 0, 0, res, res);
    };
    img.src = url;
  }
}

function getCanvasCoords(e) {
  const res = getCanvasRes();
  const rect = paintCv.getBoundingClientRect();
  return [
    clamp(((e.clientX - rect.left) / rect.width) * res, 0, res),
    clamp(((e.clientY - rect.top) / rect.height) * res, 0, res)
  ];
}

function strokeSegment(x0, y0, x1, y1) {
  const res = getCanvasRes();
  const [r, g, b, a] = hexToRgba($('paintColor').value, +$('paintAlpha').value);

  // Точное попиксельное рисование для 16x16 партиклов
  if (res === 16) {
    const sz = Math.max(1, Math.round(+$('paintSize').value / 4));
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const px = clamp(Math.floor(x0 + (x1 - x0) * t), 0, 15);
      const py = clamp(Math.floor(y0 + (y1 - y0) * t), 0, 15);
      if (activePaintTool === 'eraser') {
        paintCtx.clearRect(px, py, sz, sz);
        if (symmetryOn) paintCtx.clearRect(15 - px, py, sz, sz);
      } else {
        paintCtx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
        paintCtx.fillRect(px, py, sz, sz);
        if (symmetryOn) paintCtx.fillRect(15 - px, py, sz, sz);
      }
    }
    return;
  }

  paintCtx.save();
  if (activePaintTool === 'eraser') {
    paintCtx.globalCompositeOperation = 'destination-out';
    paintCtx.strokeStyle = 'rgba(0,0,0,1)';
  } else {
    paintCtx.globalCompositeOperation = 'source-over';
    paintCtx.strokeStyle = `rgba(${r},${g},${b},${a / 255})`;
  }
  paintCtx.lineWidth = +$('paintSize').value;
  paintCtx.lineCap = 'round';
  paintCtx.beginPath();
  paintCtx.moveTo(x0, y0);
  paintCtx.lineTo(x1, y1);
  paintCtx.stroke();

  if (symmetryOn) {
    paintCtx.beginPath();
    paintCtx.moveTo(res - x0, y0);
    paintCtx.lineTo(res - x1, y1);
    paintCtx.stroke();
  }
  paintCtx.restore();
}

export function initPaintStudio2D() {
  paintCv = $('paintCv');
  paintCtx = paintCv.getContext('2d', { willReadFrequently: true });

  if ($('paintUndoBtn')) {
    $('paintUndoBtn').onclick = () => undoPaintAction();
  }

  $('paintSwatches').innerHTML = SWATCH_COLORS
    .map(c => `<div class="swatch" style="background:${c}" data-col="${c}"></div>`)
    .join('');
  $('paintSwatches').querySelectorAll('.swatch').forEach(s => {
    s.onclick = () => {
      $('paintColor').value = s.dataset.col;
    };
  });

  // Добавляем кнопки 16x16 шаблонов партиклов в блок шаблонов
  const presetRow = document.querySelector('[data-fpreset]')?.parentElement;
  if (presetRow && !presetRow.querySelector('[data-ppreset]')) {
    const pPresets = [
      { id: 'spark', label: '💠 Искра 16×16' },
      { id: 'fire', label: '🔥 Огонь 16×16' },
      { id: 'heart', label: '❤️ Сердце 16×16' },
      { id: 'smoke', label: '💨 Дым 16×16' }
    ];
    for (const pp of pPresets) {
      const b = document.createElement('button');
      b.className = 'ed-btn';
      b.type = 'button';
      b.dataset.ppreset = pp.id;
      b.textContent = pp.label;
      b.onclick = () => {
        pushPaintUndoSnapshot();
        drawParticlePreset16(paintCtx, pp.id);
      };
      presetRow.appendChild(b);
    }
  }

  $('paintAlpha').oninput = e => {
    $('paintAlphaTxt').textContent = e.target.value + '%';
  };

  $('toolBrush').onclick = () => setPaintTool('brush');
  $('toolBucket').onclick = () => setPaintTool('bucket');
  $('toolPicker').onclick = () => setPaintTool('picker');
  $('toolEraser').onclick = () => setPaintTool('eraser');

  $('toolSym').onclick = () => {
    symmetryOn = !symmetryOn;
    $('toolSym').classList.toggle('active', symmetryOn);
  };
  $('toolClearAlpha').onclick = () => {
    pushPaintUndoSnapshot();
    const res = getCanvasRes();
    paintCtx.clearRect(0, 0, res, res);
  };

  $('paintTargetSelect').onchange = e => loadTargetTextureIntoCanvas(e.target.value);
  $('openFacePaintBtn').onclick = () => {
    if (S.selectedRef && S.selectedRef.kind === 'block') openPaintModal('block');
    else if (S.selectedRef && (S.selectedRef.kind === 'cosmetic' || S.selectedRef.kind === 'world_item')) openPaintModal('cosmetic');
    else openPaintModal('face');
  };
  $('closePaintBtn').onclick = () => {
    $('paintModal').hidden = true;
  };

  document.querySelectorAll('[data-fpreset]').forEach(btn => {
    btn.onclick = () => {
      pushPaintUndoSnapshot();
      drawFacePresetOnCtx(paintCtx, null, btn.dataset.fpreset);
    };
  });
  document.querySelectorAll('[data-spreset]').forEach(btn => {
    btn.onclick = () => {
      pushPaintUndoSnapshot();
      drawStudPatternOnCtx(paintCtx, $('paintColor').value, 'rgba(0,0,0,.3)', btn.dataset.spreset);
    };
  });

  paintCv.addEventListener('pointerdown', e => {
    const [cx, cy] = getCanvasCoords(e);
    if (activePaintTool === 'picker') {
      pickColorFromCanvas(cx, cy);
      return;
    }
    pushPaintUndoSnapshot();
    if (activePaintTool === 'bucket') {
      const [r, g, b, a] = hexToRgba($('paintColor').value, +$('paintAlpha').value);
      floodFillCanvas(cx, cy, r, g, b, a);
      return;
    }
    painting = true;
    lastPX = cx;
    lastPY = cy;
    strokeSegment(lastPX, lastPY, lastPX, lastPY);
  });

  paintCv.addEventListener('pointermove', e => {
    if (!painting) return;
    const [nx, ny] = getCanvasCoords(e);
    strokeSegment(lastPX, lastPY, nx, ny);
    lastPX = nx;
    lastPY = ny;
  });

  addEventListener('pointerup', () => {
    painting = false;
  });

  $('applyPaintBtn').onclick = () => {
    const dataURL = paintCv.toDataURL();
    const target = $('paintTargetSelect').value;
    const ent = (S.selectedRef && S.selectedRef.kind === 'char')
      ? S.selectedRef.ent
      : (S.selectedRef && S.selectedRef.kind === 'cosmetic' ? S.selectedRef.ent : S.player);

    if (target === 'particle') {
      const pd = getActiveParticleDataForPainter();
      if (pd) {
        if (S.selectedRef.kind === 'block') pushUndoState('Применение 16x16 партикла');
        else if (S.selectedRef.kind === 'cosmetic') pushCosmeticUndoState('Применение 16x16 партикла');
        else if (S.selectedRef.kind === 'world_item') pushItemUndoState('Применение 16x16 партикла');

        pd.enabled = true;
        pd.preset = 'custom';
        pd.texDataURL = dataURL;
        syncLibraryItemIfEditing(S.selectedRef);
        renderInspectorUI();
        showBanner('✨ Пиксельный 16×16 партикл успешно применён!', '#00e676');
      } else {
        showBanner('Выбери блок, предмет или аксессуар, чтобы применить к нему 16×16 партикл!', '#ffce3a');
      }
    } else if (target === 'face' && ent) {
      pushUndoState('Применение спрайта лица');
      ent.preset.faceDataURL = dataURL;
      setMeshFrontSprite(ent.rig.head, dataURL);
      showBanner(`😀 Прозрачный спрайт лица наложен на переднюю грань «${ent.name}»!`, '#00e676');
    } else if (['head', 'torso', 'armL', 'armR', 'legL', 'legR'].includes(target) && ent) {
      pushUndoState(`Применение принта (${target})`);
      if (!ent.preset.limbTex) ent.preset.limbTex = {};
      ent.preset.limbTex[target] = dataURL;
      const limbMesh = ent.rig.sockets[target];
      setMeshFrontSprite(limbMesh, dataURL);
      showBanner(`👕 Спрайт (${target}) наложен на лицевую грань «${ent.name}» с сохранением цвета тела!`, '#00e676');
    } else if (target === 'cosmetic' && S.selectedRef && S.selectedRef.kind === 'cosmetic') {
      pushCosmeticUndoState('Наложение спрайта на примитив');
      const activePart = S.selectedRef.part || S.selectedRef.item.parts[0];
      activePart.texDataURL = dataURL;
      if (S.selectedRef.mesh) setMeshFrontSprite(S.selectedRef.mesh, dataURL);
      syncLibraryItemIfEditing(S.selectedRef);
      renderInspectorUI();
      showBanner(`🎩 Спрайт наложен на лицевую грань примитива «${activePart.name || S.selectedRef.item.name}»!`, '#00e676');
    } else if (target === 'cosmetic' && S.selectedRef && S.selectedRef.kind === 'world_item') {
      pushItemUndoState('Наложение спрайта на часть предмета');
      const activeArr = S.selectedRef.editMode === 'proj_part' ? S.selectedRef.item.projectileParts : S.selectedRef.item.parts;
      const activePart = S.selectedRef.part || activeArr[S.selectedRef.partIdx || 0];
      if (activePart) {
        activePart.texDataURL = dataURL;
        rebuildWorldItemVisual(S.selectedRef.worldEntry, true);
        syncLibraryItemIfEditing(S.selectedRef);
        renderInspectorUI();
        showBanner(`🎨 Спрайт наложен на лицевую грань «${activePart.name || S.selectedRef.item.name}»!`, '#00e676');
      }
    } else if (target === 'block' && S.selectedRef && S.selectedRef.kind === 'block') {
      pushUndoState('Наложение спрайта на блок');
      const box = S.selectedRef.box;
      box.customTexDataURL = dataURL;
      setMeshFrontSprite(box.m, dataURL);
      showBanner(`🧱 Лицевой спрайт с альфой наложен на переднюю грань «${box.label}»!`, '#00e676');
    } else if (target === 'globalStuds') {
      pushUndoState('Смена глобального принта платформ');
      S.customDefaultStudDataURL = dataURL;
      for (const b of S.allBlocks) {
        if (!b.gold && b.damageOnContact === 0) {
          b.m.material = createBlockMaterial(b.colorHex, b.w / 2.2, b.d / 2.2, false, null, b.matterState);
        }
      }
      rebuildPhysicsArrays();
      showBanner('🌍 Новый принт кирпичиков применён ко всем платформам!', '#00e676');
    }
    sfx.cash();
    $('paintModal').hidden = true;
  };
}
