// src/studio/PaintStudio2D.js
import { S, $, clamp, SWATCH_COLORS, showBanner } from '../core/State.js';
import {
  drawStudPatternOnCtx,
  createBlockMaterial,
  drawFacePresetOnCtx,
  defaultFaceURL,
  setMeshFrontSprite,
  drawParticlePreset16,
  flipCanvasHorizontally
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

// Режим сглаживания в стиле Adobe Flash
let flashSmoothEnabled = true;
let flashSmoothStrength = 70; // 0..100
let flashTaperEnabled = true;
let flashStraightenEnabled = true;
let strokeStartSnapshot = null;
let currentStrokePoints = [];

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

export function setCanvasResolution(newRes) {
  if (!paintCv || !paintCtx) return;
  const currentRes = getCanvasRes();
  if (currentRes === newRes) return;
  if (newRes === 16) return;

  pushPaintUndoSnapshot();
  const tempCv = document.createElement('canvas');
  tempCv.width = currentRes;
  tempCv.height = currentRes;
  const tempCtx = tempCv.getContext('2d');
  tempCtx.drawImage(paintCv, 0, 0);

  paintCv.width = newRes;
  paintCv.height = newRes;
  paintCtx.clearRect(0, 0, newRes, newRes);
  paintCtx.imageSmoothingEnabled = true;
  paintCtx.drawImage(tempCv, 0, 0, newRes, newRes);

  if ($('btnRes128')) $('btnRes128').classList.toggle('active', newRes === 128);
  if ($('btnRes256')) $('btnRes256').classList.toggle('active', newRes === 256);
  if ($('paintCanvasResTxt')) {
    $('paintCanvasResTxt').textContent = `Холст ${newRes}×${newRes} ${newRes === 256 ? '(HD Flash Режим)' : ''} (Ctrl+Z отменяет только рисунок)`;
  }
  showBanner(`📐 Разрешение 2D Студии переключено на ${newRes}×${newRes}!`, '#56f0ff');
}

export function smoothCanvasEdges() {
  if (!paintCtx || !paintCv) return;
  const res = getCanvasRes();
  if (res === 16) {
    showBanner('⚠️ 16×16 партиклы используют пиксель-арт без размытия', '#ffce3a');
    return;
  }
  pushPaintUndoSnapshot();
  const imgData = paintCtx.getImageData(0, 0, res, res);
  const data = imgData.data;
  const copy = new Uint8ClampedArray(data);

  // 3x3 сглаживающий фильтр для смягчения резких ступенчатых границ
  for (let y = 1; y < res - 1; y++) {
    for (let x = 1; x < res - 1; x++) {
      const idx = (y * res + x) * 4;
      if (copy[idx + 3] === 0) continue;

      let rSum = copy[idx] * 4;
      let gSum = copy[idx + 1] * 4;
      let bSum = copy[idx + 2] * 4;
      let aSum = copy[idx + 3] * 4;
      let weight = 4;

      const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]];
      for (const [dx, dy] of neighbors) {
        const ni = ((y + dy) * res + (x + dx)) * 4;
        rSum += copy[ni];
        gSum += copy[ni + 1];
        bSum += copy[ni + 2];
        aSum += copy[ni + 3];
        weight += 1;
      }
      data[idx] = Math.round(rSum / weight);
      data[idx + 1] = Math.round(gSum / weight);
      data[idx + 2] = Math.round(bSum / weight);
      data[idx + 3] = Math.round(aSum / weight);
    }
  }
  paintCtx.putImageData(imgData, 0, 0);
  sfx.jump();
  showBanner('🌊 2D Студия: Сглаживание краёв холста применено!', '#56f0ff');
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
  const res = isParticle ? 16 : (paintCv && paintCv.width === 256 ? 256 : 128);
  paintCv.width = res;
  paintCv.height = res;

  if (isParticle) {
    paintCv.classList.add('pixel-art');
    $('paintSize').value = 1;
    if ($('paintSizeTxt')) $('paintSizeTxt').textContent = '1px';
    if ($('paintResGroup')) $('paintResGroup').style.display = 'none';
  } else {
    paintCv.classList.remove('pixel-art');
    if (+$('paintSize').value < 3) {
      $('paintSize').value = res === 256 ? 10 : 6;
    }
    if ($('paintSizeTxt')) $('paintSizeTxt').textContent = $('paintSize').value + 'px';
    if ($('paintResGroup')) $('paintResGroup').style.display = 'flex';
  }

  if ($('paintCanvasResTxt')) {
    $('paintCanvasResTxt').textContent = isParticle
      ? 'Холст 16×16 (Пиксель-Арт партикл)'
      : `Холст ${res}×${res} ${res === 256 ? '(HD Flash Режим)' : ''} (Ctrl+Z отменяет только рисунок)`;
  }
  if ($('btnRes128')) $('btnRes128').classList.toggle('active', res === 128);
  if ($('btnRes256')) $('btnRes256').classList.toggle('active', res === 256);

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

// =========================================================================
// МАТЕМАТИЧЕСКИЙ ДВИЖОК СГЛАЖИВАНИЯ КРИВЫХ В СТИЛЕ ADOBE FLASH
// =========================================================================

function perpendicularDistance(p, p1, p2) {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const dSq = dx * dx + dy * dy;
  if (dSq === 0) return Math.hypot(p.x - p1.x, p.y - p1.y);
  const t = Math.max(0, Math.min(1, ((p.x - p1.x) * dx + (p.y - p1.y) * dy) / dSq));
  const projX = p1.x + t * dx;
  const projY = p1.y + t * dy;
  return Math.hypot(p.x - projX, p.y - projY);
}

// Алгоритм Рамера-Дугласа-Пекера: отсекает дрожание и шум руки
function simplifyDouglasPeucker(points, tolerance) {
  if (points.length <= 2) return points;
  let dmax = 0;
  let index = 0;
  const end = points.length - 1;
  for (let i = 1; i < end; i++) {
    const d = perpendicularDistance(points[i], points[0], points[end]);
    if (d > dmax) {
      index = i;
      dmax = d;
    }
  }
  if (dmax > tolerance) {
    const rec1 = simplifyDouglasPeucker(points.slice(0, index + 1), tolerance);
    const rec2 = simplifyDouglasPeucker(points.slice(index), tolerance);
    return rec1.slice(0, -1).concat(rec2);
  }
  return [points[0], points[end]];
}

// Алгоритм Чайкина (Corner-Cutting Subdivision): превращает угловатости в гармоничные B-сплайны
function chaikinSmooth(pts, iterations = 1) {
  if (pts.length < 3 || iterations <= 0) return pts;
  let current = pts;
  for (let it = 0; it < iterations; it++) {
    if (current.length < 3) break;
    const next = [current[0]];
    for (let i = 0; i < current.length - 1; i++) {
      const p0 = current[i];
      const p1 = current[i + 1];
      next.push({
        x: 0.75 * p0.x + 0.25 * p1.x,
        y: 0.75 * p0.y + 0.25 * p1.y
      });
      next.push({
        x: 0.25 * p0.x + 0.75 * p1.x,
        y: 0.25 * p0.y + 0.75 * p1.y
      });
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
}

// Распознавание намеренных острых углов (сохраняет форму углов вместо размытия в овал)
function findCornerIndices(pts, minDist = 3.5) {
  const corners = [0];
  for (let i = 1; i < pts.length - 1; i++) {
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) >= minDist) {
        prev = pts[j];
        break;
      }
    }
    let next = null;
    for (let j = i + 1; j < pts.length; j++) {
      if (Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y) >= minDist) {
        next = pts[j];
        break;
      }
    }
    if (prev && next) {
      const v1x = pts[i].x - prev.x;
      const v1y = pts[i].y - prev.y;
      const v2x = next.x - pts[i].x;
      const v2y = next.y - pts[i].y;
      const l1 = Math.hypot(v1x, v1y);
      const l2 = Math.hypot(v2x, v2y);
      if (l1 > 0.001 && l2 > 0.001) {
        const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
        if (dot < 0.35) {
          const lastC = corners[corners.length - 1];
          if (Math.hypot(pts[i].x - pts[lastC].x, pts[i].y - pts[lastC].y) >= minDist * 1.5) {
            corners.push(i);
          }
        }
      }
    }
  }
  if (corners[corners.length - 1] !== pts.length - 1) {
    corners.push(pts.length - 1);
  }
  return corners;
}

// Отрисовка сглаженной кривой Безье с поддержкой Flash Taper (заострения) и симметрии
function renderSmoothedPath(ctx, pts, brushSize, r, g, b, a, isEraser, taperOn, symmetry, res) {
  if (pts.length < 2) return;

  function drawStrokePath(points) {
    ctx.save();
    if (isEraser) {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.fillStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = `rgba(${r},${g},${b},${a / 255})`;
      ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    if (taperOn && points.length >= 4 && brushSize >= 3) {
      // Художественное сужение концов (как у мультяшных линий во Flash)
      const total = points.length - 1;
      for (let i = 0; i < total; i++) {
        const p0 = points[i];
        const p1 = points[i + 1];
        const t = (i + 0.5) / total;
        let factor = 1.0;
        if (t < 0.2) {
          factor = 0.25 + 0.75 * Math.sin((t / 0.2) * (Math.PI / 2));
        } else if (t > 0.8) {
          factor = 0.25 + 0.75 * Math.sin(((1 - t) / 0.2) * (Math.PI / 2));
        }
        ctx.lineWidth = Math.max(1, brushSize * factor);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.stroke();
      }
    } else {
      // Идеально плавная кривая Безье постоянной толщины
      ctx.lineWidth = brushSize;
      ctx.beginPath();
      ctx.moveTo(points[0].x, points[0].y);
      if (points.length === 2) {
        ctx.lineTo(points[1].x, points[1].y);
      } else {
        for (let i = 1; i < points.length - 1; i++) {
          const midX = (points[i].x + points[i + 1].x) / 2;
          const midY = (points[i].y + points[i + 1].y) / 2;
          ctx.quadraticCurveTo(points[i].x, points[i].y, midX, midY);
        }
        ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  drawStrokePath(pts);
  if (symmetry) {
    const mirrored = pts.map(p => ({ x: res - p.x, y: p.y }));
    drawStrokePath(mirrored);
  }
}

// Главный алгоритм Flash-сглаживания после завершения мазка
function applyFlashSmoothing(points, ctx, isEraser, symmetry, res) {
  if (points.length < 2) return;

  const smoothStrength = +$('flashSmoothStrength').value || 70;
  const taperOn = $('flashTaperCheck') ? $('flashTaperCheck').checked : true;
  const straightenOn = $('flashStraightenCheck') ? $('flashStraightenCheck').checked : true;
  const brushSize = +$('paintSize').value || 6;
  const [r, g, b, a] = hexToRgba($('paintColor').value, +$('paintAlpha').value);

  // 1. Фильтр плотности (убираем частотный шум курсора ближе 1.2px)
  const filtered = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = filtered[filtered.length - 1];
    const cur = points[i];
    if (Math.hypot(cur.x - prev.x, cur.y - prev.y) >= 1.2) {
      filtered.push(cur);
    }
  }
  if (filtered[filtered.length - 1] !== points[points.length - 1]) {
    filtered.push(points[points.length - 1]);
  }

  if (filtered.length <= 1) {
    drawLivePoint(points[0].x, points[0].y);
    return;
  }

  // 2. Распознавание прямых линий (Flash "Straighten")
  if (straightenOn) {
    const pStart = filtered[0];
    const pEnd = filtered[filtered.length - 1];
    const chordLen = Math.hypot(pEnd.x - pStart.x, pEnd.y - pStart.y);
    const straightTolerance = 1.0 + (smoothStrength / 100) * 2.2;
    let isStraight = chordLen > 8;
    if (isStraight) {
      for (let i = 1; i < filtered.length - 1; i++) {
        if (perpendicularDistance(filtered[i], pStart, pEnd) > straightTolerance) {
          isStraight = false;
          break;
        }
      }
    }
    if (isStraight) {
      renderSmoothedPath(ctx, [pStart, pEnd], brushSize, r, g, b, a, isEraser, taperOn, symmetry, res);
      return;
    }
  }

  // 3. Выявление намеренных углов
  const cornerIndices = findCornerIndices(filtered, 3.5);

  // 4. Упрощение Дугласа-Пекера + сабдивижн Чайкина для каждого участка между углами
  const dpTolerance = 0.4 + (smoothStrength / 100) * 2.6;
  const chaikinIters = smoothStrength > 65 ? 2 : (smoothStrength > 30 ? 1 : 0);

  const fullSmoothedPath = [];

  for (let c = 0; c < cornerIndices.length - 1; c++) {
    const startIdx = cornerIndices[c];
    const endIdx = cornerIndices[c + 1];
    const subPts = filtered.slice(startIdx, endIdx + 1);

    if (subPts.length <= 2) {
      for (const p of subPts) fullSmoothedPath.push(p);
      continue;
    }

    const simplified = simplifyDouglasPeucker(subPts, dpTolerance);
    const smoothed = chaikinSmooth(simplified, chaikinIters);

    if (fullSmoothedPath.length > 0) {
      smoothed.shift();
    }
    for (const p of smoothed) fullSmoothedPath.push(p);
  }

  // 5. Отрисовка финальной гладкой кривой
  renderSmoothedPath(ctx, fullSmoothedPath, brushSize, r, g, b, a, isEraser, taperOn, symmetry, res);
}

// =========================================================================
// ЖИВОЙ СТИЛЬ И ОТРИСОВКА В РЕАЛЬНОМ ВРЕМЕНИ
// =========================================================================

function setupLiveStyle(ctx) {
  const [r, g, b, a] = hexToRgba($('paintColor').value, +$('paintAlpha').value);
  if (activePaintTool === 'eraser') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = 'rgba(0,0,0,1)';
    ctx.fillStyle = 'rgba(0,0,0,1)';
  } else {
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(${r},${g},${b},${a / 255})`;
    ctx.fillStyle = `rgba(${r},${g},${b},${a / 255})`;
  }
  ctx.lineWidth = +$('paintSize').value;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
}

function drawLivePoint(cx, cy) {
  const res = getCanvasRes();
  const radius = Math.max(0.5, (+$('paintSize').value) / 2);
  paintCtx.save();
  setupLiveStyle(paintCtx);
  paintCtx.beginPath();
  paintCtx.arc(cx, cy, radius, 0, Math.PI * 2);
  paintCtx.fill();
  if (symmetryOn) {
    paintCtx.beginPath();
    paintCtx.arc(res - cx, cy, radius, 0, Math.PI * 2);
    paintCtx.fill();
  }
  paintCtx.restore();
}

function drawLiveSegment(x0, y0, x1, y1) {
  const res = getCanvasRes();
  paintCtx.save();
  setupLiveStyle(paintCtx);
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

function drawLiveQuadratic(x0, y0, cx, cy, x1, y1) {
  const res = getCanvasRes();
  paintCtx.save();
  setupLiveStyle(paintCtx);
  paintCtx.beginPath();
  paintCtx.moveTo(x0, y0);
  paintCtx.quadraticCurveTo(cx, cy, x1, y1);
  paintCtx.stroke();
  if (symmetryOn) {
    paintCtx.beginPath();
    paintCtx.moveTo(res - x0, y0);
    paintCtx.quadraticCurveTo(res - cx, cy, res - x1, y1);
    paintCtx.stroke();
  }
  paintCtx.restore();
}

// Стандартный попиксельный мазок для 16×16 и режима без сглаживания
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
  paintCtx.lineJoin = 'round';
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

  if ($('paintSize')) {
    $('paintSize').oninput = e => {
      if ($('paintSizeTxt')) $('paintSizeTxt').textContent = e.target.value + 'px';
    };
  }

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

  if ($('toolSmoothCanvas')) {
    $('toolSmoothCanvas').onclick = () => smoothCanvasEdges();
  }

  // Flash Smoothing controls
  if ($('toolFlashSmooth')) {
    $('toolFlashSmooth').onclick = () => {
      flashSmoothEnabled = !flashSmoothEnabled;
      $('toolFlashSmooth').classList.toggle('active', flashSmoothEnabled);
      $('toolFlashSmooth').textContent = flashSmoothEnabled ? '⚡ Flash: ВКЛ' : '⚪ Flash: ВЫКЛ';
      showBanner(
        flashSmoothEnabled
          ? '⚡ Adobe Flash сглаживание ВКЛЮЧЕНО (плавные векторные линии)!'
          : '⚪ Flash сглаживание выключено (прямой ввод без сглаживания)',
        '#56f0ff'
      );
    };
  }

  if ($('flashSmoothStrength')) {
    $('flashSmoothStrength').oninput = e => {
      flashSmoothStrength = +e.target.value;
      if ($('flashSmoothTxt')) $('flashSmoothTxt').textContent = e.target.value + '%';
    };
  }

  const updateFlashPresetUI = (val, btn) => {
    flashSmoothStrength = val;
    if ($('flashSmoothStrength')) $('flashSmoothStrength').value = val;
    if ($('flashSmoothTxt')) $('flashSmoothTxt').textContent = val + '%';
    ['flashPresetSoft', 'flashPresetClassic', 'flashPresetMax'].forEach(id => {
      if ($(id)) $(id).classList.remove('active');
    });
    if (btn) btn.classList.add('active');
    if (!flashSmoothEnabled && $('toolFlashSmooth')) {
      $('toolFlashSmooth').click();
    }
  };

  if ($('flashPresetSoft')) $('flashPresetSoft').onclick = e => updateFlashPresetUI(40, e.currentTarget);
  if ($('flashPresetClassic')) $('flashPresetClassic').onclick = e => updateFlashPresetUI(70, e.currentTarget);
  if ($('flashPresetMax')) $('flashPresetMax').onclick = e => updateFlashPresetUI(95, e.currentTarget);

  // Переключение разрешения 128 / 256 HD
  if ($('btnRes128')) $('btnRes128').onclick = () => setCanvasResolution(128);
  if ($('btnRes256')) $('btnRes256').onclick = () => setCanvasResolution(256);

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
    const res = getCanvasRes();

    if (res === 16 || !flashSmoothEnabled) {
      strokeSegment(lastPX, lastPY, lastPX, lastPY);
    } else {
      strokeStartSnapshot = paintCtx.getImageData(0, 0, res, res);
      currentStrokePoints = [{ x: cx, y: cy, t: performance.now() }];
      drawLivePoint(cx, cy);
    }
  });

  paintCv.addEventListener('pointermove', e => {
    if (!painting) return;
    const [nx, ny] = getCanvasCoords(e);
    const res = getCanvasRes();

    if (res === 16 || !flashSmoothEnabled) {
      strokeSegment(lastPX, lastPY, nx, ny);
      lastPX = nx;
      lastPY = ny;
      return;
    }

    const last = currentStrokePoints[currentStrokePoints.length - 1];
    if (Math.hypot(nx - last.x, ny - last.y) < 0.5) return;

    currentStrokePoints.push({ x: nx, y: ny, t: performance.now() });

    // Живая сглаженная отрисовка в реальном времени при ведении курсора
    const len = currentStrokePoints.length;
    if (len === 2) {
      const p0 = currentStrokePoints[0];
      const p1 = currentStrokePoints[1];
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      drawLiveSegment(p0.x, p0.y, mid.x, mid.y);
    } else if (len >= 3) {
      const p0 = currentStrokePoints[len - 3];
      const p1 = currentStrokePoints[len - 2];
      const p2 = currentStrokePoints[len - 1];
      const mid0 = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const mid1 = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      drawLiveQuadratic(mid0.x, mid0.y, p1.x, p1.y, mid1.x, mid1.y);
    }

    lastPX = nx;
    lastPY = ny;
  });

  addEventListener('pointerup', () => {
    if (!painting) return;
    painting = false;
    const res = getCanvasRes();

    if (res > 16 && flashSmoothEnabled && currentStrokePoints.length >= 2 && strokeStartSnapshot) {
      paintCtx.putImageData(strokeStartSnapshot, 0, 0);
      applyFlashSmoothing(currentStrokePoints, paintCtx, activePaintTool === 'eraser', symmetryOn, res);
    }
    currentStrokePoints = [];
    strokeStartSnapshot = null;
  });

  addEventListener('pointercancel', () => {
    painting = false;
    currentStrokePoints = [];
    strokeStartSnapshot = null;
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
      const limbMesh = ent.rig.sockets ? ent.rig.sockets[target] : ent.rig[target];
      if (limbMesh) setMeshFrontSprite(limbMesh, dataURL);
      showBanner(`👕 Спрайт (${target}) наложен на лицевую грань «${ent.name}» с сохранением цвета тела!`, '#00e676');

      // Автоматическое зеркалирование принта конечностей при активном буле
      if ((target === 'armL' || target === 'armR') && ent.preset.mirrorArms) {
        const otherTarget = target === 'armL' ? 'armR' : 'armL';
        const flippedURL = flipCanvasHorizontally(paintCv);
        ent.preset.limbTex[otherTarget] = flippedURL;
        const otherMesh = ent.rig.sockets ? ent.rig.sockets[otherTarget] : ent.rig[otherTarget];
        if (otherMesh) setMeshFrontSprite(otherMesh, flippedURL);
        showBanner(`🪞 Спрайт руки зеркально наложен на противоположную сторону!`, '#00e676');
      } else if ((target === 'legL' || target === 'legR') && ent.preset.mirrorLegs) {
        const otherTarget = target === 'legL' ? 'legR' : 'legL';
        const flippedURL = flipCanvasHorizontally(paintCv);
        ent.preset.limbTex[otherTarget] = flippedURL;
        const otherMesh = ent.rig.sockets ? ent.rig.sockets[otherTarget] : ent.rig[otherTarget];
        if (otherMesh) setMeshFrontSprite(otherMesh, flippedURL);
        showBanner(`🪞 Спрайт ноги зеркально наложен на противоположную сторону!`, '#00e676');
      }
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
