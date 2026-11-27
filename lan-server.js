// lan-server.js — запуск: node lan-server.js
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = 8765;
const HUB_STORAGE_FILE = path.join(__dirname, 'shared_hub_data.json');

const activeRooms = new Map(); // roomId -> { roomId, title, hostName, modeId, blockCount, playersCount, updatedAt }
const sharedHubItems = new Map(); // itemId -> { id, category, title, author, desc, thumb, createdAt, payload }

// Загрузка сохранённой UGC-библиотеки с диска при старте сервера
function loadHubFromDisk() {
  try {
    if (fs.existsSync(HUB_STORAGE_FILE)) {
      const raw = fs.readFileSync(HUB_STORAGE_FILE, 'utf8');
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (item && item.id) sharedHubItems.set(item.id, item);
        }
      }
      console.log(`📚 Загружено ${sharedHubItems.size} работ из общей UGC-Библиотеки (shared_hub_data.json)`);
    }
  } catch (err) {
    console.warn('⚠️ Не удалось прочитать shared_hub_data.json:', err.message);
  }
}

function saveHubToDisk() {
  try {
    const arr = Array.from(sharedHubItems.values());
    fs.writeFileSync(HUB_STORAGE_FILE, JSON.stringify(arr, null, 2), 'utf8');
  } catch (err) {
    console.warn('⚠️ Ошибка сохранения shared_hub_data.json:', err.message);
  }
}

loadHubFromDisk();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4'
};

/* ---------- МЕДИА-ПРОКСИ (CORS + RANGE) И РЕЗОЛВЕР YOUTUBE (YT-DLP) ---------- */
const mediaResolveCache = new Map(); // `${kind}|${url}` -> { streamUrl, userAgent, expiresAt }
const playlistResolveCache = new Map(); // rawUrl -> { payload, expiresAt }

function resolvePlaylistViaYtDlp(rawUrl) {
  return new Promise((resolve, reject) => {
    const cached = playlistResolveCache.get(rawUrl);
    if (cached && cached.expiresAt > Date.now()) {
      resolve(cached.payload);
      return;
    }

    // Прямые ссылки на файлы отдаём сразу без запуска yt-dlp
    if (!isYtDlpNeededUrl(rawUrl)) {
      const cleanName = decodeURIComponent((rawUrl.split('/').pop() || 'Видео').split('?')[0]).slice(0, 64) || 'Видео по ссылке';
      const payload = {
        ok: true,
        isPlaylist: false,
        title: cleanName,
        startVideoId: '',
        items: [{ url: rawUrl, title: cleanName, duration: 0 }]
      };
      resolve(payload);
      return;
    }

    let startVideoId = '';
    try {
      const u = new URL(rawUrl);
      startVideoId = u.searchParams.get('v') || '';
    } catch (_) {}

    const bin = findYtDlpBinary();
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--js-runtimes', 'node',
      '--playlist-end', '100',
      rawUrl
    ];

    execFile(bin, args, { timeout: 30000, maxBuffer: 12 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT'
          ? 'yt-dlp не найден! Положи yt-dlp.exe рядом с lan-server.js (или в tools/).'
          : (stderr || err.message || 'Ошибка чтения плейлиста').trim();
        console.warn('⚠️ [PlaylistResolve]', msg);
        reject(new Error(msg));
        return;
      }

      let data = null;
      try {
        data = JSON.parse(String(stdout || '').trim());
      } catch (parseErr) {
        reject(new Error('Не удалось разобрать JSON плейлиста: ' + parseErr.message));
        return;
      }

      const items = [];
      const isPlaylist = data._type === 'playlist' && Array.isArray(data.entries);

      if (isPlaylist) {
        for (const ent of data.entries) {
          if (!ent) continue;
          const t = String(ent.title || '').trim();
          if (t === '[Deleted video]' || t === '[Private video]') continue;
          let itemUrl = ent.webpage_url || ent.url || '';
          if (itemUrl && !/^https?:\/\//i.test(itemUrl)) {
            const vidId = ent.id || itemUrl;
            itemUrl = `https://www.youtube.com/watch?v=${vidId}`;
          } else if (!itemUrl && ent.id) {
            itemUrl = `https://www.youtube.com/watch?v=${ent.id}`;
          }
          if (!itemUrl) continue;
          items.push({
            url: itemUrl,
            videoKey: ent.id || '',
            title: (t || itemUrl).slice(0, 72),
            duration: Number(ent.duration) || 0
          });
        }
      } else {
        items.push({
          url: data.webpage_url || rawUrl,
          videoKey: data.id || startVideoId || '',
          title: String(data.title || 'Видео').slice(0, 72),
          duration: Number(data.duration) || 0
        });
      }

      const payload = {
        ok: true,
        isPlaylist,
        title: String(data.title || (isPlaylist ? 'Плейлист' : 'Видео')).slice(0, 72),
        startVideoId,
        items
      };
      playlistResolveCache.set(rawUrl, { payload, expiresAt: Date.now() + 10 * 60 * 1000 });
      console.log(`📋 [PlaylistResolve] «${payload.title}» — ${items.length} видео`);
      resolve(payload);
    });
  });
}

const searchResolveCache = new Map(); // query -> { items, expiresAt }

function searchYouTubeViaYtDlp(query, limit = 6) {
  return new Promise((resolve, reject) => {
    const cleanQ = String(query || '').trim().slice(0, 120);
    if (!cleanQ) {
      resolve([]);
      return;
    }
    const cacheKey = `${limit}|${cleanQ.toLowerCase()}`;
    const cached = searchResolveCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      resolve(cached.items);
      return;
    }

    const bin = findYtDlpBinary();
    const args = [
      '--flat-playlist',
      '--dump-single-json',
      '--no-warnings',
      '--js-runtimes', 'node',
      `ytsearch${Math.min(10, Math.max(1, limit))}:${cleanQ}`
    ];

    execFile(bin, args, { timeout: 25000, maxBuffer: 6 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT'
          ? 'yt-dlp не найден! Положи yt-dlp.exe рядом с lan-server.js.'
          : (stderr || err.message || 'Ошибка поиска YouTube').trim();
        console.warn('⚠️ [MediaSearch]', msg);
        reject(new Error(msg));
        return;
      }
      let data = null;
      try {
        data = JSON.parse(String(stdout || '').trim());
      } catch (parseErr) {
        reject(new Error('Ошибка разбора ответа поиска: ' + parseErr.message));
        return;
      }
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      const items = [];
      for (const ent of entries) {
        if (!ent) continue;
        let url = ent.webpage_url || ent.url || '';
        if (url && !/^https?:\/\//i.test(url)) {
          url = `https://www.youtube.com/watch?v=${ent.id || url}`;
        } else if (!url && ent.id) {
          url = `https://www.youtube.com/watch?v=${ent.id}`;
        }
        if (!url) continue;
        items.push({
          id: ent.id || '',
          url,
          title: String(ent.title || 'Видео').slice(0, 80),
          channel: String(ent.channel || ent.uploader || '').slice(0, 40),
          duration: Number(ent.duration) || 0
        });
      }
      searchResolveCache.set(cacheKey, { items, expiresAt: Date.now() + 10 * 60 * 1000 });
      console.log(`🔍 [MediaSearch] «${cleanQ}» -> ${items.length} результатов`);
      resolve(items);
    });
  });
}

function findYtDlpBinary() {
  const candidates = [
    path.join(__dirname, 'tools', 'yt-dlp.exe'),
    path.join(__dirname, 'yt-dlp.exe'),
    path.join(__dirname, 'tools', 'yt-dlp'),
    path.join(__dirname, 'yt-dlp')
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'yt-dlp';
}

function isYtDlpNeededUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const h = u.hostname.toLowerCase();
    return (
      h.includes('youtube.com') ||
      h.includes('youtu.be') ||
      h.includes('soundcloud.com') ||
      h.includes('twitch.tv') ||
      h.includes('vimeo.com') ||
      h.includes('rutube.ru') ||
      h.includes('vk.com') ||
      h.includes('vkvideo.ru')
    );
  } catch (_) {
    return false;
  }
}

function resolveStreamViaYtDlp(rawUrl, kind = 'video') {
  return new Promise((resolve, reject) => {
    const cacheKey = `${kind}|${rawUrl}`;
    const cached = mediaResolveCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      resolve(cached);
      return;
    }

    const bin = findYtDlpBinary();
    // Исключаем HLS (m3u8) и DASH-сегменты: браузерный <video>/<audio> требует прямой HTTP-поток
    const noHls = '[protocol^=http][protocol!*=m3u8][protocol!*=dash]';
    const fmt = kind === 'audio'
      ? `bestaudio${noHls}[ext=m4a]/bestaudio${noHls}[ext=webm]/bestaudio${noHls}/bestaudio/best`
      : `best${noHls}[ext=mp4][acodec!=none][vcodec!=none]/18/best${noHls}[acodec!=none][vcodec!=none]/best${noHls}[ext=mp4][vcodec!=none]/best${noHls}[vcodec!=none]`;

    const args = [
      '--no-playlist',
      '--no-warnings',
      '--js-runtimes', 'node',
      '-f', fmt,
      '--print', '%(url)s',
      '--print', '%(http_headers.User-Agent)s',
      rawUrl
    ];

    execFile(bin, args, { timeout: 25000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const msg = err.code === 'ENOENT'
          ? 'yt-dlp не найден! Положи yt-dlp.exe рядом с lan-server.js (или в tools/).'
          : (stderr || err.message || 'Ошибка yt-dlp').trim();
        console.warn(`⚠️ [MediaResolve:${kind}]`, msg);
        reject(new Error(msg));
        return;
      }
      const lines = String(stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const streamUrl = lines.find(s => /^https?:\/\//i.test(s));
      if (!streamUrl) {
        console.warn(`⚠️ [MediaResolve:${kind}] yt-dlp не вернул прямой URL:`, stdout, stderr);
        reject(new Error('yt-dlp не вернул прямую ссылку на медиапоток'));
        return;
      }
      const uaLine = lines.find(s => s !== streamUrl && s !== 'NA');
      const result = {
        streamUrl,
        userAgent: uaLine || '',
        expiresAt: Date.now() + 25 * 60 * 1000
      };
      mediaResolveCache.set(cacheKey, result);
      console.log(`🎬 [MediaResolve:${kind}] Поток готов для ${rawUrl.slice(0, 60)}`);
      resolve(result);
    });
  });
}

function proxyRemoteMedia(targetUrl, req, res, redirectCount = 0, customUA = '') {
  if (redirectCount > 5) {
    res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Too many redirects' }));
    return;
  }
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (_) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid URL' }));
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: 'Only http/https URLs are allowed' }));
    return;
  }

  const client = parsed.protocol === 'https:' ? https : http;
  const headers = {
    'User-Agent': customUA || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
  };
  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = client.request(parsed, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers }, upRes => {
    const code = upRes.statusCode || 200;
    if (code >= 400) {
      console.warn(`⚠️ [MediaProxy] Upstream вернул HTTP ${code} для ${parsed.hostname}`);
    }
    if ([301, 302, 303, 307, 308].includes(code) && upRes.headers.location) {
      upRes.resume();
      const nextUrl = new URL(upRes.headers.location, parsed).toString();
      proxyRemoteMedia(nextUrl, req, res, redirectCount + 1, customUA);
      return;
    }

    const outHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
      'Cache-Control': 'no-store'
    };
    if (upRes.headers['content-type']) outHeaders['Content-Type'] = upRes.headers['content-type'];
    if (upRes.headers['content-length']) outHeaders['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range']) outHeaders['Content-Range'] = upRes.headers['content-range'];
    outHeaders['Accept-Ranges'] = upRes.headers['accept-ranges'] || 'bytes';

    res.writeHead(code, outHeaders);
    if (req.method === 'HEAD') {
      upRes.resume();
      res.end();
      return;
    }
    upRes.pipe(res);
  });

  upstream.on('error', err => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    } else {
      res.end();
    }
  });

  req.on('close', () => {
    try { upstream.destroy(); } catch (_) {}
  });
  upstream.end();
}

function readJsonBody(req, callback) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
    if (body.length > 50 * 1024 * 1024) {
      req.destroy();
    }
  });
  req.on('end', () => {
    try {
      callback(null, JSON.parse(body || '{}'));
    } catch (err) {
      callback(err, null);
    }
  });
}

const httpServer = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Прямой CORS-прокси для видео/аудио ссылок с поддержкой Range (перемотки)
  if (pathname === '/api/media/proxy' && (req.method === 'GET' || req.method === 'HEAD')) {
    const rawUrl = parsedUrl.searchParams.get('url');
    if (!rawUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Missing url param' }));
      return;
    }
    proxyRemoteMedia(rawUrl, req, res);
    return;
  }

  // Потоковый резолвер YouTube и медиа-платформ (через yt-dlp) + прокси для прямых ссылок
  if (pathname === '/api/media/stream' && (req.method === 'GET' || req.method === 'HEAD')) {
    const rawUrl = parsedUrl.searchParams.get('url');
    const kind = parsedUrl.searchParams.get('kind') === 'audio' ? 'audio' : 'video';
    if (!rawUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Missing url param' }));
      return;
    }
    if (!isYtDlpNeededUrl(rawUrl)) {
      proxyRemoteMedia(rawUrl, req, res);
      return;
    }
    resolveStreamViaYtDlp(rawUrl, kind)
      .then(resolved => proxyRemoteMedia(resolved.streamUrl, req, res, 0, resolved.userAgent))
      .catch(err => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
    return;
  }

  // Разбор плейлиста YouTube или метаданных одиночного видео в очередь
  if (pathname === '/api/media/playlist' && req.method === 'GET') {
    const rawUrl = parsedUrl.searchParams.get('url');
    if (!rawUrl) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Missing url param' }));
      return;
    }
    resolvePlaylistViaYtDlp(rawUrl)
      .then(payload => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(payload));
      })
      .catch(err => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  // Поиск видео на YouTube прямо из игры (ytsearch)
  if (pathname === '/api/media/search' && req.method === 'GET') {
    const q = parsedUrl.searchParams.get('q');
    const limit = parseInt(parsedUrl.searchParams.get('limit') || '6', 10) || 6;
    if (!q || !q.trim()) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'Missing q param' }));
      return;
    }
    searchYouTubeViaYtDlp(q, limit)
      .then(items => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, items }));
      })
      .catch(err => {
        res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      });
    return;
  }

  if (pathname === '/api/servers' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(Array.from(activeRooms.values())));
    return;
  }

  // API получения списка всех опубликованных объектов Мастерской
  if (pathname === '/api/hub' && req.method === 'GET') {
    const list = Array.from(sharedHubItems.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(list));
    return;
  }

  // API публикации нового префаба / карты / оружия / NPC / аксессуара
  if (pathname === '/api/hub/publish' && req.method === 'POST') {
    readJsonBody(req, (err, data) => {
      if (err || !data || !data.item || !data.item.id) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: 'Invalid item payload' }));
        return;
      }
      const item = data.item;
      item.createdAt = item.createdAt || Date.now();
      sharedHubItems.set(item.id, item);
      saveHubToDisk();
      broadcastHubCatalog();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, id: item.id }));
    });
    return;
  }

  // API удаления работы из Мастерской
  if (pathname === '/api/hub/delete' && req.method === 'POST') {
    readJsonBody(req, (err, data) => {
      if (!err && data && data.id && sharedHubItems.has(data.id)) {
        sharedHubItems.delete(data.id);
        saveHubToDisk();
        broadcastHubCatalog();
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  let safeUrl = decodeURIComponent(pathname);
  if (safeUrl === '/') safeUrl = '/index.html';
  const filePath = path.join(__dirname, safeUrl);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 50 * 1024 * 1024 });

function broadcastRoomList() {
  const now = Date.now();
  for (const [id, r] of activeRooms.entries()) {
    if (now - r.updatedAt > 25000) activeRooms.delete(id);
  }
  const msg = JSON.stringify({
    type: 'server_list_update',
    servers: Array.from(activeRooms.values())
  });
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(msg); } catch (_) {}
    }
  }
}

function broadcastHubCatalog(targetClient = null) {
  const items = Array.from(sharedHubItems.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const msg = JSON.stringify({
    type: 'hub_catalog_update',
    items
  });
  if (targetClient) {
    if (targetClient.readyState === 1) {
      try { targetClient.send(msg); } catch (_) {}
    }
    return;
  }
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try { client.send(msg); } catch (_) {}
    }
  }
}

wss.on('connection', ws => {
  ws.peerId = null;
  ws.hostedRoomId = null;

  // Отправляем новому клиенту список серверов и каталог UGC-Мастерской
  try {
    ws.send(JSON.stringify({
      type: 'server_list_update',
      servers: Array.from(activeRooms.values())
    }));
    broadcastHubCatalog(ws);
  } catch (_) {}

  ws.on('message', raw => {
    const str = raw.toString();
    let pkt = null;
    try { pkt = JSON.parse(str); } catch (_) { return; }
    if (!pkt) return;

    if (pkt.senderId) ws.peerId = pkt.senderId;

    if (pkt.type === 'register_server' && pkt.serverInfo) {
      const info = pkt.serverInfo;
      ws.hostedRoomId = info.roomId;
      activeRooms.set(info.roomId, Object.assign({}, info, { updatedAt: Date.now() }));
      broadcastRoomList();
      return;
    }

    if (pkt.type === 'unregister_server' && pkt.roomId) {
      activeRooms.delete(pkt.roomId);
      broadcastRoomList();
      return;
    }

    if (pkt.type === 'get_servers') {
      try {
        ws.send(JSON.stringify({
          type: 'server_list_update',
          servers: Array.from(activeRooms.values())
        }));
      } catch (_) {}
      return;
    }

    if (pkt.type === 'get_hub_catalog') {
      broadcastHubCatalog(ws);
      return;
    }

    if (pkt.type === 'publish_hub_item' && pkt.item && pkt.item.id) {
      const item = pkt.item;
      item.createdAt = item.createdAt || Date.now();
      sharedHubItems.set(item.id, item);
      saveHubToDisk();
      broadcastHubCatalog();
      return;
    }

    if (pkt.type === 'delete_hub_item' && pkt.id) {
      if (sharedHubItems.has(pkt.id)) {
        sharedHubItems.delete(pkt.id);
        saveHubToDisk();
        broadcastHubCatalog();
      }
      return;
    }

    // Пересылаем пакеты другим игрокам (если указан targetPeerId — только адресату, иначе всем)
    for (const client of wss.clients) {
      if (client !== ws && client.readyState === 1) {
        if (pkt.targetPeerId && client.peerId && client.peerId !== pkt.targetPeerId) continue;
        try { client.send(str); } catch (_) {}
      }
    }
  });

  ws.on('close', () => {
    if (ws.hostedRoomId && activeRooms.has(ws.hostedRoomId)) {
      activeRooms.delete(ws.hostedRoomId);
      broadcastRoomList();
    }
  });
});

setInterval(broadcastRoomList, 10000);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Сервер DebiX (HTTP + WebSocket + Серверы + Мастерская UGC) запущен на порту ${PORT}!`);
  console.log(`🌐 Друзья в Radmin VPN могут ввести твой IP (26.x.x.x) или открыть http://ТВОЙ_IP_RADMIN:${PORT} в браузере!`);
});