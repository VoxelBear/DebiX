// lan-server.js — запуск: node lan-server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
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
  '.ico': 'image/x-icon'
};

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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

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