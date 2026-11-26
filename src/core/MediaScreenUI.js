// src/core/MediaScreenUI.js
import { S, $, clamp, showBanner } from './State.js';
import { cv, camera } from './SceneManager.js';
import { sfx } from './AudioEngine.js';
import {
  getActiveScreenRuntimes,
  toggleBlockMediaPlayback,
  seekScreenTime,
  setScreenMasterVolume,
  toggleScreenMute,
  nextScreenTrack,
  prevScreenTrack,
  playScreenQueueIndex,
  removeScreenQueueItem,
  clearScreenQueue,
  cycleScreenLoopMode,
  toggleScreenShuffle,
  cycleScreenPlaybackRate,
  addUrlOrPlaylistToScreenQueue,
  getCurrentScreenTrackInfo
} from './MediaSystem.js';

const _msuiRaycaster = new THREE.Raycaster();
const _msuiNdc = new THREE.Vector2();
const _msuiSpeeds = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];

let _msuiEventsBound = false;
let _msuiHoveredRt = null;
let _msuiHoverUvX = 0.5;
let _msuiHoverUvY = 0.5;
let _msuiHoverFaceW = 8;
let _msuiHoverFaceH = 4.5;
let _msuiPointerClientX = -9999;
let _msuiPointerClientY = -9999;
let _msuiDragMode = null; // null | 'seek' | 'vol'
let _msuiDragRt = null;
let _msuiCursorHidden = false;
let _msuiRedrawAccum = 0;

function formatMediaTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const total = Math.floor(sec);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = n => (n < 10 ? '0' + n : String(n));
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function drawRoundedRect(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w * 0.5, h * 0.5);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function truncateCanvasText(ctx, text, maxW) {
  const s = String(text || '');
  if (ctx.measureText(s).width <= maxW) return s;
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return s.slice(0, Math.max(1, lo)) + '…';
}

/* ---------- МОДАЛЬНОЕ ОКНО ДОБАВЛЕНИЯ ВИДЕО / ПЛЕЙЛИСТА В ИГРЕ ---------- */

function openScreenAddQueueModal(box) {
  if (!box || !box.mediaScreenData) return;
  let modal = $('debixMediaAddModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'debixMediaAddModal';
    modal.style.cssText =
      'position:fixed;inset:0;z-index:9995;background:rgba(6,10,20,0.78);backdrop-filter:blur(5px);display:flex;align-items:center;justify-content:center;font-family:Montserrat,sans-serif;color:#fff';
    document.body.appendChild(modal);
  }

  modal.hidden = false;
  modal.innerHTML = `
    <div style="width:min(490px,92vw);background:#101726;border:2px solid #56f0ff;border-radius:14px;padding:16px 18px;box-shadow:0 18px 48px rgba(0,0,0,0.78);display:flex;flex-direction:column;gap:10px">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <b style="font-size:14px;color:#56f0ff">📺 ${box.label || 'Видео-Экран'} — Добавить видео или плейлист</b>
        <button type="button" id="btnCloseMediaAddModal" style="background:#ef4444;color:#fff;border:none;border-radius:7px;padding:4px 9px;font:800 12px Montserrat,sans-serif;cursor:pointer">✕</button>
      </div>
      <div style="font-size:11.5px;color:#94a3b8;line-height:1.4">
        Вставь ссылку на <b>видео YouTube</b>, целый <b>плейлист YouTube</b> (<code>list=...</code>) или прямой <code>.mp4/.webm</code> файл:
      </div>
      <input type="text" id="inpMediaAddModalUrl" placeholder="https://www.youtube.com/playlist?list=... или https://youtu.be/..."
             style="width:100%;box-sizing:border-box;background:#0b101c;border:1.5px solid #38bdf8;border-radius:8px;color:#fff;padding:9px 11px;font:700 12px Montserrat,sans-serif;outline:none">
      <div id="txtMediaAddModalStatus" style="font-size:11px;color:#fbbf24;min-height:16px"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
        <button type="button" id="btnMediaAddQueueEnd" style="background:linear-gradient(135deg,#00a2ff,#0066ff);color:#fff;border:none;border-radius:9px;padding:9px;font:800 12px Montserrat,sans-serif;cursor:pointer">➕ Добавить в очередь</button>
        <button type="button" id="btnMediaAddPlayNow" style="background:linear-gradient(135deg,#00e676,#00b862);color:#062012;border:none;border-radius:9px;padding:9px;font:900 12px Montserrat,sans-serif;cursor:pointer">▶ Играть сейчас</button>
      </div>
    </div>
  `;

  const inp = $('inpMediaAddModalUrl');
  const statusEl = $('txtMediaAddModalStatus');
  const close = () => { modal.hidden = true; };

  $('btnCloseMediaAddModal').onclick = close;
  modal.onclick = e => { if (e.target === modal) close(); };

  const submit = async playNow => {
    const rawUrl = (inp.value || '').trim();
    if (!/^https?:\/\//i.test(rawUrl)) {
      statusEl.textContent = '⚠️ Ссылка должна начинаться с http:// или https://';
      return;
    }
    statusEl.textContent = '⏳ Загружаем видео / плейлист с сервера...';
    $('btnMediaAddQueueEnd').disabled = true;
    $('btnMediaAddPlayNow').disabled = true;
    try {
      const added = await addUrlOrPlaylistToScreenQueue(box, rawUrl, { playNow, replaceQueue: false });
      if (added > 0) {
        close();
      } else {
        statusEl.textContent = '⚠️ Не удалось получить видео по этой ссылке.';
      }
    } catch (err) {
      statusEl.textContent = '❌ ' + (err.message || 'Ошибка загрузки');
    } finally {
      if ($('btnMediaAddQueueEnd')) $('btnMediaAddQueueEnd').disabled = false;
      if ($('btnMediaAddPlayNow')) $('btnMediaAddPlayNow').disabled = false;
    }
  };

  $('btnMediaAddQueueEnd').onclick = () => submit(false);
  $('btnMediaAddPlayNow').onclick = () => submit(true);
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') submit(false);
    else if (e.key === 'Escape') close();
  });
  setTimeout(() => inp.focus(), 20);
}

/* ---------- УПРАВЛЕНИЕ CANVAS / TEXTURE НА ЭКРАНЕ ---------- */

function ensureScreenUICanvas(rt, faceW, faceH) {
  const aspect = clamp((faceW || 8) / Math.max(0.1, faceH || 4.5), 0.45, 3.2);
  const targetW = 960;
  const targetH = clamp(Math.round(targetW / aspect), 360, 1280);

  if (!rt.uiCanvas) {
    rt.uiCanvas = document.createElement('canvas');
    rt.uiCanvas.width = targetW;
    rt.uiCanvas.height = targetH;
    rt.uiCtx = rt.uiCanvas.getContext('2d');
    rt.uiTex = new THREE.CanvasTexture(rt.uiCanvas);
    rt.uiTex.minFilter = THREE.LinearFilter;
    rt.uiTex.magFilter = THREE.LinearFilter;
    rt.uiTex.generateMipmaps = false;
    rt.uiMat = new THREE.MeshBasicMaterial({
      map: rt.uiTex,
      transparent: true,
      depthWrite: false,
      toneMapped: false
    });
    if (rt.faceEntries) {
      for (const fe of rt.faceEntries) {
        if (fe.uiMesh) fe.uiMesh.material = rt.uiMat;
      }
    }
    return;
  }

  if (Math.abs(rt.uiCanvas.width - targetW) > 24 || Math.abs(rt.uiCanvas.height - targetH) > 24) {
    rt.uiCanvas.width = targetW;
    rt.uiCanvas.height = targetH;
    if (rt.uiTex) rt.uiTex.dispose();
    rt.uiTex = new THREE.CanvasTexture(rt.uiCanvas);
    rt.uiTex.minFilter = THREE.LinearFilter;
    rt.uiTex.magFilter = THREE.LinearFilter;
    rt.uiTex.generateMipmaps = false;
    if (rt.uiMat) {
      rt.uiMat.map = rt.uiTex;
      rt.uiMat.needsUpdate = true;
    }
  }
}

export function disposeScreenUI(rt) {
  if (!rt) return;
  if (_msuiHoveredRt === rt) _msuiHoveredRt = null;
  if (_msuiDragRt === rt) {
    _msuiDragRt = null;
    _msuiDragMode = null;
    S._isDraggingMediaScreenUI = false;
  }
  rt.uiTex?.dispose?.();
  rt.uiMat?.dispose?.();
  rt.uiTex = null;
  rt.uiMat = null;
  rt.uiCanvas = null;
  rt.uiCtx = null;
  rt.uiZones = null;
}

/* ---------- ОТРИСОВКА ИНТЕРФЕЙСА ПЛЕЕРА (АНАЛОГ YOUTUBE) ---------- */

function drawScreenPlayerUI(rt, uvX, uvY, faceW, faceH) {
  if (!rt || !rt.box) return;
  ensureScreenUICanvas(rt, faceW, faceH);

  const ctx = rt.uiCtx;
  const W = rt.uiCanvas.width;
  const H = rt.uiCanvas.height;
  const box = rt.box;
  const sd = box.mediaScreenData || {};
  const vid = rt.videoEl;

  const cx = clamp(uvX * W, 0, W);
  const cy = clamp((1 - uvY) * H, 0, H);

  ctx.clearRect(0, 0, W, H);

  const zones = [];
  const pushZone = (id, x, y, w, h, extra = null) => {
    zones.push({ id, x, y, w, h, extra });
  };
  const isHit = (x, y, w, h) => cx >= x && cx <= x + w && cy >= y && cy <= y + h;

  // Верхний и нижний градиенты (как в YouTube)
  const topH = 68;
  const botH = 98;
  const topGrad = ctx.createLinearGradient(0, 0, 0, topH + 22);
  topGrad.addColorStop(0, 'rgba(6, 10, 18, 0.88)');
  topGrad.addColorStop(1, 'rgba(6, 10, 18, 0)');
  ctx.fillStyle = topGrad;
  ctx.fillRect(0, 0, W, topH + 22);

  const botGrad = ctx.createLinearGradient(0, H - botH - 36, 0, H);
  botGrad.addColorStop(0, 'rgba(6, 10, 18, 0)');
  botGrad.addColorStop(0.45, 'rgba(6, 10, 18, 0.72)');
  botGrad.addColorStop(1, 'rgba(6, 10, 18, 0.94)');
  ctx.fillStyle = botGrad;
  ctx.fillRect(0, H - botH - 36, W, botH + 36);

  // --- ВЕРХНЯЯ ПАНЕЛЬ ---
  const info = getCurrentScreenTrackInfo(box);
  const queue = Array.isArray(sd.queue) ? sd.queue : [];
  const qLen = queue.length;

  const btnAddW = 166;
  const btnQueueW = 136;
  const topBtnY = 14;
  const topBtnH = 36;
  const btnQueueX = W - 18 - btnQueueW;
  const btnAddX = btnQueueX - 10 - btnAddW;

  // Название текущего видео
  ctx.font = '800 21px Montserrat, sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const titlePrefix = qLen > 0 ? `[${(sd.queueIndex || 0) + 1}/${qLen}] ` : '';
  const maxTitleW = Math.max(120, btnAddX - 32);
  ctx.fillText(truncateCanvasText(ctx, titlePrefix + info.title, maxTitleW), 20, 32);

  // Кнопка «➕ URL / Плейлист»
  const addHover = isHit(btnAddX, topBtnY, btnAddW, topBtnH);
  drawRoundedRect(ctx, btnAddX, topBtnY, btnAddW, topBtnH, 9);
  ctx.fillStyle = addHover ? '#00a2ff' : 'rgba(15, 23, 42, 0.85)';
  ctx.fill();
  ctx.strokeStyle = addHover ? '#ffffff' : '#56f0ff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = '800 13px Montserrat, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('➕ Видео / Плейлист', btnAddX + btnAddW * 0.5, topBtnY + topBtnH * 0.5 + 1);
  pushZone('add_modal', btnAddX, topBtnY, btnAddW, topBtnH);

  // Кнопка «📋 Очередь»
  const qHover = isHit(btnQueueX, topBtnY, btnQueueW, topBtnH);
  drawRoundedRect(ctx, btnQueueX, topBtnY, btnQueueW, topBtnH, 9);
  ctx.fillStyle = rt.uiQueueOpen ? '#ff2e4c' : (qHover ? 'rgba(56, 189, 248, 0.35)' : 'rgba(15, 23, 42, 0.85)');
  ctx.fill();
  ctx.strokeStyle = rt.uiQueueOpen ? '#ff8a9b' : '#56f0ff';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`📋 Очередь (${qLen})`, btnQueueX + btnQueueW * 0.5, topBtnY + topBtnH * 0.5 + 1);
  pushZone('toggle_queue', btnQueueX, topBtnY, btnQueueW, topBtnH);

  // --- ЦЕНТРАЛЬНАЯ КНОПКА PLAY ПРИ ПАУЗЕ ---
  const isPlaying = Boolean(sd.playing) && vid && !vid.paused;
  if (!isPlaying && !rt.uiQueueOpen) {
    const rad = 42;
    const midX = W * 0.5;
    const midY = H * 0.5 - 10;
    const cHover = Math.hypot(cx - midX, cy - midY) <= rad + 8;
    ctx.beginPath();
    ctx.arc(midX, midY, rad, 0, Math.PI * 2);
    ctx.fillStyle = cHover ? 'rgba(255, 46, 76, 0.92)' : 'rgba(10, 15, 28, 0.72)';
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 3;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(midX - 12, midY - 18);
    ctx.lineTo(midX + 20, midY);
    ctx.lineTo(midX - 12, midY + 18);
    ctx.closePath();
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }

  // --- ВЫДВИЖНАЯ ПАНЕЛЬ ОЧЕРЕДИ СПРАВА ---
  if (rt.uiQueueOpen) {
    const drW = Math.min(370, Math.floor(W * 0.44));
    const drX = W - drW - 14;
    const drY = topH - 6;
    const drH = Math.max(120, H - botH - drY - 8);

    drawRoundedRect(ctx, drX, drY, drW, drH, 12);
    ctx.fillStyle = 'rgba(10, 15, 28, 0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(86, 240, 255, 0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Шапка очереди
    ctx.fillStyle = '#56f0ff';
    ctx.font = '800 14px Montserrat, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(`📋 ОЧЕРЕДЬ (${qLen})`, drX + 12, drY + 22);

    const clrW = 84;
    const clrX = drX + drW - clrW - 10;
    const clrY = drY + 8;
    const clrH = 26;
    const clrHover = isHit(clrX, clrY, clrW, clrH);
    drawRoundedRect(ctx, clrX, clrY, clrW, clrH, 6);
    ctx.fillStyle = clrHover ? '#ef4444' : 'rgba(239, 68, 68, 0.25)';
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 11px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('🗑️ Очистить', clrX + clrW * 0.5, clrY + 14);
    pushZone('clear_queue', clrX, clrY, clrW, clrH);

    // Список видео с прокруткой
    const listX = drX + 8;
    const listY = drY + 42;
    const listW = drW - 16;
    const listH = Math.max(40, drH - 50);
    const rowH = 42;
    const maxScroll = Math.max(0, qLen * (rowH + 4) - listH);
    rt.uiQueueScroll = clamp(rt.uiQueueScroll || 0, 0, maxScroll);

    ctx.save();
    ctx.beginPath();
    ctx.rect(listX, listY, listW, listH);
    ctx.clip();

    if (qLen === 0) {
      ctx.fillStyle = '#94a3b8';
      ctx.font = '700 13px Montserrat, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Очередь пуста', listX + listW * 0.5, listY + 34);
      ctx.font = '600 11px Montserrat, sans-serif';
      ctx.fillText('Нажми «➕ Видео / Плейлист» выше', listX + listW * 0.5, listY + 56);
    } else {
      for (let i = 0; i < qLen; i++) {
        const ry = listY + i * (rowH + 4) - rt.uiQueueScroll;
        if (ry + rowH < listY || ry > listY + listH) continue;

        const item = queue[i];
        const isAct = i === (sd.queueIndex || 0);
        const delW = 28;
        const delX = listX + listW - delW - 4;
        const delY = ry + 7;
        const delH = rowH - 14;
        const rowHover = isHit(listX, Math.max(listY, ry), listW, Math.min(rowH, listY + listH - ry));
        const delHover = rowHover && isHit(delX, delY, delW, delH);

        drawRoundedRect(ctx, listX, ry, listW, rowH, 8);
        ctx.fillStyle = isAct
          ? 'rgba(255, 46, 76, 0.34)'
          : (rowHover ? 'rgba(56, 189, 248, 0.24)' : 'rgba(255, 255, 255, 0.06)');
        ctx.fill();
        if (isAct) {
          ctx.strokeStyle = '#ff2e4c';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        ctx.fillStyle = isAct ? '#ffce3a' : '#e2e8f0';
        ctx.font = isAct ? '800 13px Montserrat, sans-serif' : '700 12.5px Montserrat, sans-serif';
        ctx.textAlign = 'left';
        const label = `${isAct ? '▶ ' : (i + 1) + '. '}${item.title || item.url || 'Видео'}`;
        ctx.fillText(truncateCanvasText(ctx, label, listW - 88), listX + 10, ry + rowH * 0.5 + 1);

        if (item.duration > 0) {
          ctx.fillStyle = '#94a3b8';
          ctx.font = '700 11px Montserrat, sans-serif';
          ctx.textAlign = 'right';
          ctx.fillText(formatMediaTime(item.duration), delX - 8, ry + rowH * 0.5 + 1);
        }

        drawRoundedRect(ctx, delX, delY, delW, delH, 6);
        ctx.fillStyle = delHover ? '#ef4444' : 'rgba(255,255,255,0.12)';
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = '800 12px Montserrat, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('✕', delX + delW * 0.5, delY + delH * 0.5 + 1);

        const visTop = Math.max(listY, ry);
        const visH = Math.min(ry + rowH, listY + listH) - visTop;
        if (visH > 4) {
          pushZone('queue_del', delX, visTop, delW, visH, i);
          pushZone('queue_play', listX, visTop, delX - listX - 2, visH, i);
        }
      }
    }
    ctx.restore();
    // Поглощаем клики внутри фона панели, чтобы они не ставили видео на паузу
    pushZone('queue_panel_bg', drX, drY, drW, drH);
  }

  // --- ПОЛОСА ПРОГРЕССА (SEEKBAR) ---
  const barX = 22;
  const barW = W - 44;
  const barY = H - 72;
  const barH = 8;
  const seekHitY = barY - 14;
  const seekHitH = 34;

  const duration = (vid && Number.isFinite(vid.duration) && vid.duration > 0) ? vid.duration : 0;
  const curTime = (vid && Number.isFinite(vid.currentTime)) ? vid.currentTime : 0;
  const progress = duration > 0 ? clamp(curTime / duration, 0, 1) : 0;
  const seekHover = isHit(barX - 6, seekHitY, barW + 12, seekHitH) || _msuiDragMode === 'seek';

  // Фон трека
  drawRoundedRect(ctx, barX, barY, barW, seekHover ? 11 : barH, 5);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.24)';
  ctx.fill();

  // Буферизованная часть
  if (vid && duration > 0 && vid.buffered && vid.buffered.length > 0) {
    try {
      const bufEnd = vid.buffered.end(vid.buffered.length - 1);
      const bufFrac = clamp(bufEnd / duration, 0, 1);
      drawRoundedRect(ctx, barX, barY, barW * bufFrac, seekHover ? 11 : barH, 5);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.42)';
      ctx.fill();
    } catch (_) {}
  }

  // Проигранная часть (фирменный красный YouTube)
  const fillW = Math.max(0, barW * progress);
  if (fillW > 0) {
    drawRoundedRect(ctx, barX, barY, fillW, seekHover ? 11 : barH, 5);
    ctx.fillStyle = '#ff2e4c';
    ctx.fill();
  }

  // Ползунок прогресса
  const thumbX = barX + fillW;
  const thumbY = barY + (seekHover ? 5.5 : 4);
  ctx.beginPath();
  ctx.arc(thumbX, thumbY, seekHover ? 10 : 7, 0, Math.PI * 2);
  ctx.fillStyle = '#ff2e4c';
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2.5;
  ctx.stroke();

  // Подсказка времени при наведении на полосу перемотки
  if (seekHover && duration > 0) {
    const hoverFrac = clamp((cx - barX) / barW, 0, 1);
    const hoverSec = hoverFrac * duration;
    const tipTxt = formatMediaTime(hoverSec);
    ctx.font = '800 13px Montserrat, sans-serif';
    const tipW = ctx.measureText(tipTxt).width + 18;
    const tipX = clamp(cx - tipW * 0.5, barX, barX + barW - tipW);
    const tipY = barY - 34;
    drawRoundedRect(ctx, tipX, tipY, tipW, 24, 6);
    ctx.fillStyle = 'rgba(10, 15, 28, 0.92)';
    ctx.fill();
    ctx.strokeStyle = '#ff2e4c';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.fillText(tipTxt, tipX + tipW * 0.5, tipY + 13);
  }
  pushZone('seekbar', barX - 6, seekHitY, barW + 12, seekHitH, { barX, barW });

  // --- НИЖНИЕ КНОПКИ УПРАВЛЕНИЯ ---
  const rowY = H - 46;
  const btnH = 34;
  let lx = 22;

  const drawIconBtn = (id, label, w, active = false) => {
    const hov = isHit(lx, rowY, w, btnH);
    drawRoundedRect(ctx, lx, rowY, w, btnH, 8);
    ctx.fillStyle = active
      ? 'rgba(255, 46, 76, 0.85)'
      : (hov ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)');
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 15px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, lx + w * 0.5, rowY + btnH * 0.5 + 1);
    pushZone(id, lx, rowY, w, btnH);
    lx += w + 8;
  };

  drawIconBtn('prev', '⏮', 40);
  drawIconBtn('play_pause', isPlaying ? '⏸' : '▶', 46, !isPlaying);
  drawIconBtn('next', '⏭', 40);

  const isMuted = Boolean(sd.muted) || (Number(sd.masterVolume ?? 1) <= 0.001);
  drawIconBtn('mute', isMuted ? '🔇' : '🔊', 42, isMuted);

  // Слайдер громкости (управляет masterVolume экрана и всех привязанных колонок)
  const volW = 96;
  const volX = lx;
  const volBarY = rowY + btnH * 0.5 - 3;
  const curVol = isMuted ? 0 : clamp(Number(sd.masterVolume ?? 1.0), 0, 1.5);
  const volFrac = clamp(curVol / 1.5, 0, 1);
  const volHov = isHit(volX - 4, rowY, volW + 8, btnH) || _msuiDragMode === 'vol';

  drawRoundedRect(ctx, volX, volBarY, volW, 6, 3);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fill();
  drawRoundedRect(ctx, volX, volBarY, volW * volFrac, 6, 3);
  ctx.fillStyle = '#56f0ff';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(volX + volW * volFrac, volBarY + 3, volHov ? 8 : 6, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  pushZone('volbar', volX - 4, rowY, volW + 8, btnH, { volX, volW });
  lx += volW + 16;

  // Время воспроизведения
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '700 14px Montserrat, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${formatMediaTime(curTime)} / ${duration > 0 ? formatMediaTime(duration) : '--:--'}`, lx, rowY + btnH * 0.5 + 1);

  // Правая группа кнопок: Повтор, Перемешать, Скорость
  let rx = W - 22;
  const drawRightBtn = (id, label, w, active = false) => {
    rx -= w;
    const hov = isHit(rx, rowY, w, btnH);
    drawRoundedRect(ctx, rx, rowY, w, btnH, 8);
    ctx.fillStyle = active
      ? 'rgba(0, 230, 118, 0.32)'
      : (hov ? 'rgba(255, 255, 255, 0.22)' : 'rgba(255, 255, 255, 0.08)');
    ctx.fill();
    if (active) {
      ctx.strokeStyle = '#00e676';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 13px Montserrat, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(label, rx + w * 0.5, rowY + btnH * 0.5 + 1);
    pushZone(id, rx, rowY, w, btnH);
    rx -= 8;
  };

  const rateVal = Number(sd.playbackRate) || 1.0;
  drawRightBtn('speed', `${rateVal}x`, 54, Math.abs(rateVal - 1.0) > 0.05);

  const loopMode = sd.loopMode || (sd.loop !== false ? 'queue' : 'none');
  const loopLabel = loopMode === 'one' ? '🔂 1' : (loopMode === 'queue' ? '🔁 Все' : '➡ Выкл');
  drawRightBtn('loop', loopLabel, 78, loopMode !== 'none');

  drawRightBtn('shuffle', '🔀', 42, Boolean(sd.shuffle));

  // Поглощаем клики в нижней полосе, чтобы случайный промах рядом с кнопкой не ставил видео на паузу
  pushZone('bottom_bar_bg', 0, H - botH, W, botH);
  // Клик по самой области видео — пауза/плей
  pushZone('video_area', 0, 0, W, H);

  rt.uiZones = zones;

  // --- ВИРТУАЛЬНЫЙ КУРСОР НА САМОЙ ПОВЕРХНОСТИ 3D-ЭКРАНА ---
  const activeZone = zones.find(z => isHit(z.x, z.y, z.w, z.h));
  const isInteractive = activeZone && activeZone.id !== 'video_area' && activeZone.id !== 'bottom_bar_bg' && activeZone.id !== 'queue_panel_bg';

  ctx.save();
  ctx.translate(cx, cy);
  ctx.shadowColor = isInteractive ? 'rgba(86, 240, 255, 0.9)' : 'rgba(0, 0, 0, 0.85)';
  ctx.shadowBlur = 8;

  // Острый курсор-стрелка прямо на текстуре экрана
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 22);
  ctx.lineTo(6, 17);
  ctx.lineTo(11, 26);
  ctx.lineTo(15, 24);
  ctx.lineTo(10, 15);
  ctx.lineTo(17, 14);
  ctx.closePath();
  ctx.fillStyle = isInteractive ? '#56f0ff' : '#ffffff';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#090d16';
  ctx.stroke();
  ctx.restore();

  rt.uiTex.needsUpdate = true;
}

/* ---------- РЕЙКАСТИНГ КУРСОРА ПО 3D-ЭКРАНАМ ---------- */

function raycastMediaScreenAtClient(clientX, clientY) {
  if (S.state !== 'play' || !S.cursorUnlockedByTab || document.pointerLockElement === cv) {
    return null;
  }
  const addModal = $('debixMediaAddModal');
  if (addModal && !addModal.hidden) return null;

  const rect = cv.getBoundingClientRect();
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
    return null;
  }

  const runtimes = getActiveScreenRuntimes();
  if (runtimes.size === 0) return null;

  const targets = [];
  const screenIds = new Set();
  for (const rt of runtimes.values()) {
    if (!rt.box?.m?.visible || !rt.faceEntries) continue;
    screenIds.add(rt.blockId);
    for (const fe of rt.faceEntries) {
      if (fe.uiMesh) targets.push(fe.uiMesh);
    }
  }
  if (targets.length === 0) return null;

  // Добавляем твёрдые блоки для проверки перекрытия стенами (чтобы нельзя было кликать сквозь стены)
  for (let i = 0; i < S.allBlocks.length; i++) {
    const b = S.allBlocks[i];
    if (!b || !b.m || !b.m.visible || b.isDisabled || b._depletedDisabled) continue;
    if (b.matterState !== 'solid' || screenIds.has(b.id)) continue;
    targets.push(b.m);
  }

  _msuiNdc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  _msuiNdc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  _msuiRaycaster.near = 0.1;
  _msuiRaycaster.far = 48;
  _msuiRaycaster.setFromCamera(_msuiNdc, camera);

  const hits = _msuiRaycaster.intersectObjects(targets, false);
  if (hits.length === 0) return null;

  const first = hits[0];
  if (!first.object?.userData?.isMediaScreenUI || !first.uv) return null;

  const rt = runtimes.get(first.object.userData.screenBlockId);
  if (!rt) return null;

  return {
    rt,
    uvX: first.uv.x,
    uvY: first.uv.y,
    faceW: first.object.userData.faceWorldW || rt.box.w || 8,
    faceH: first.object.userData.faceWorldH || rt.box.h || 4.5
  };
}

function setCanvasCursorHidden(hidden) {
  if (_msuiCursorHidden === hidden) return;
  _msuiCursorHidden = hidden;
  if (cv) cv.style.cursor = hidden ? 'none' : '';
}

function applyDragValue(rt, uvX) {
  if (!rt || !rt.uiCanvas || !rt.uiZones) return;
  const cx = clamp(uvX * rt.uiCanvas.width, 0, rt.uiCanvas.width);
  if (_msuiDragMode === 'seek') {
    const z = rt.uiZones.find(zz => zz.id === 'seekbar');
    if (z && z.extra && rt.videoEl && Number.isFinite(rt.videoEl.duration) && rt.videoEl.duration > 0) {
      const frac = clamp((cx - z.extra.barX) / Math.max(1, z.extra.barW), 0, 1);
      seekScreenTime(rt.box, frac * rt.videoEl.duration);
    }
  } else if (_msuiDragMode === 'vol') {
    const z = rt.uiZones.find(zz => zz.id === 'volbar');
    if (z && z.extra) {
      const frac = clamp((cx - z.extra.volX) / Math.max(1, z.extra.volW), 0, 1);
      setScreenMasterVolume(rt.box, frac * 1.5);
    }
  }
}

function handleZoneClick(rt, zone, uvX) {
  if (!rt || !zone) return;
  const box = rt.box;
  if (zone.id === 'seekbar') {
    _msuiDragMode = 'seek';
    _msuiDragRt = rt;
    S._isDraggingMediaScreenUI = true;
    applyDragValue(rt, uvX);
    sfx.gizmoTick?.();
    return;
  }
  if (zone.id === 'volbar') {
    _msuiDragMode = 'vol';
    _msuiDragRt = rt;
    S._isDraggingMediaScreenUI = true;
    applyDragValue(rt, uvX);
    return;
  }
  if (zone.id === 'play_pause' || zone.id === 'video_area') {
    toggleBlockMediaPlayback(box, true);
  } else if (zone.id === 'prev') {
    prevScreenTrack(box);
  } else if (zone.id === 'next') {
    nextScreenTrack(box);
  } else if (zone.id === 'mute') {
    toggleScreenMute(box);
  } else if (zone.id === 'loop') {
    cycleScreenLoopMode(box);
  } else if (zone.id === 'shuffle') {
    toggleScreenShuffle(box);
  } else if (zone.id === 'speed') {
    cycleScreenPlaybackRate(box, _msuiSpeeds);
  } else if (zone.id === 'toggle_queue') {
    rt.uiQueueOpen = !rt.uiQueueOpen;
    sfx.click?.();
  } else if (zone.id === 'add_modal') {
    sfx.click?.();
    openScreenAddQueueModal(box);
  } else if (zone.id === 'clear_queue') {
    clearScreenQueue(box);
  } else if (zone.id === 'queue_play') {
    playScreenQueueIndex(box, zone.extra);
  } else if (zone.id === 'queue_del') {
    removeScreenQueueItem(box, zone.extra);
  }
}

function ensureScreenPointerHooks() {
  if (_msuiEventsBound) return;
  _msuiEventsBound = true;

  document.addEventListener('pointermove', e => {
    _msuiPointerClientX = e.clientX;
    _msuiPointerClientY = e.clientY;
    if (_msuiDragMode && _msuiDragRt) {
      const hit = raycastMediaScreenAtClient(e.clientX, e.clientY);
      if (hit && hit.rt === _msuiDragRt) {
        _msuiHoverUvX = hit.uvX;
        _msuiHoverUvY = hit.uvY;
        applyDragValue(_msuiDragRt, hit.uvX);
        drawScreenPlayerUI(_msuiDragRt, _msuiHoverUvX, _msuiHoverUvY, _msuiHoverFaceW, _msuiHoverFaceH);
      }
    }
  }, { passive: true });

  // Capture-фаза перехватывает клик по 3D-экрану до PlayerController
  document.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    if (S.state !== 'play' || !S.cursorUnlockedByTab || document.pointerLockElement === cv) return;
    if (e.target !== cv) return;

    const hit = raycastMediaScreenAtClient(e.clientX, e.clientY);
    if (!hit) return;

    _msuiHoveredRt = hit.rt;
    _msuiHoverUvX = hit.uvX;
    _msuiHoverUvY = hit.uvY;
    _msuiHoverFaceW = hit.faceW;
    _msuiHoverFaceH = hit.faceH;

    // Свежая перерисовка гарантирует актуальность координат кнопок
    drawScreenPlayerUI(hit.rt, hit.uvX, hit.uvY, hit.faceW, hit.faceH);

    const cx = clamp(hit.uvX * hit.rt.uiCanvas.width, 0, hit.rt.uiCanvas.width);
    const cy = clamp((1 - hit.uvY) * hit.rt.uiCanvas.height, 0, hit.rt.uiCanvas.height);
    const zone = (hit.rt.uiZones || []).find(z => cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h);
    if (zone) {
      e.preventDefault();
      e.stopPropagation();
      handleZoneClick(hit.rt, zone, hit.uvX);
      drawScreenPlayerUI(hit.rt, hit.uvX, hit.uvY, hit.faceW, hit.faceH);
    }
  }, true);

  document.addEventListener('pointerup', () => {
    if (_msuiDragMode) {
      _msuiDragMode = null;
      _msuiDragRt = null;
      S._isDraggingMediaScreenUI = false;
    }
  }, true);

  cv.addEventListener('wheel', e => {
    if (S.state !== 'play' || !S.cursorUnlockedByTab || document.pointerLockElement === cv) return;
    const hit = raycastMediaScreenAtClient(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    e.stopPropagation();

    const rt = hit.rt;
    if (rt.uiQueueOpen) {
      rt.uiQueueScroll = Math.max(0, (rt.uiQueueScroll || 0) + Math.sign(e.deltaY) * 46);
    } else {
      const cur = Number(rt.box.mediaScreenData?.masterVolume ?? 1.0);
      setScreenMasterVolume(rt.box, cur - Math.sign(e.deltaY) * 0.08);
    }
    drawScreenPlayerUI(rt, hit.uvX, hit.uvY, hit.faceW, hit.faceH);
  }, { passive: false });
}

/* ---------- ОБНОВЛЕНИЕ КАЖДЫЙ КАДР ---------- */

export function updateMediaScreenUI(dt) {
  ensureScreenPointerHooks();
  const runtimes = getActiveScreenRuntimes();
  const freeCursorPlay = S.state === 'play' && Boolean(S.cursorUnlockedByTab) && document.pointerLockElement !== cv;

  if (!freeCursorPlay) {
    if (_msuiDragMode) {
      _msuiDragMode = null;
      _msuiDragRt = null;
      S._isDraggingMediaScreenUI = false;
    }
    _msuiHoveredRt = null;
    setCanvasCursorHidden(false);
    for (const rt of runtimes.values()) {
      if (rt.faceEntries) {
        for (const fe of rt.faceEntries) {
          if (fe.uiMesh) fe.uiMesh.visible = false;
        }
      }
    }
    return;
  }

  const hit = _msuiDragRt
    ? (raycastMediaScreenAtClient(_msuiPointerClientX, _msuiPointerClientY) || {
        rt: _msuiDragRt,
        uvX: _msuiHoverUvX,
        uvY: _msuiHoverUvY,
        faceW: _msuiHoverFaceW,
        faceH: _msuiHoverFaceH
      })
    : raycastMediaScreenAtClient(_msuiPointerClientX, _msuiPointerClientY);

  const prevHovered = _msuiHoveredRt;
  _msuiHoveredRt = hit ? hit.rt : null;
  setCanvasCursorHidden(Boolean(_msuiHoveredRt));

  for (const rt of runtimes.values()) {
    const show = rt === _msuiHoveredRt;
    if (rt.faceEntries) {
      for (const fe of rt.faceEntries) {
        if (fe.uiMesh) fe.uiMesh.visible = show && Boolean(rt.box?.m?.visible);
      }
    }
  }

  if (hit) {
    const uvMoved = Math.abs(hit.uvX - _msuiHoverUvX) > 0.0005 || Math.abs(hit.uvY - _msuiHoverUvY) > 0.0005;
    _msuiHoverUvX = hit.uvX;
    _msuiHoverUvY = hit.uvY;
    _msuiHoverFaceW = hit.faceW;
    _msuiHoverFaceH = hit.faceH;

    _msuiRedrawAccum += dt;
    if (uvMoved || prevHovered !== _msuiHoveredRt || _msuiRedrawAccum >= 0.08) {
      _msuiRedrawAccum = 0;
      drawScreenPlayerUI(hit.rt, hit.uvX, hit.uvY, hit.faceW, hit.faceH);
    }
  }
}