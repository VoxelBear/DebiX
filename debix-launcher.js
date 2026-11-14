/**
 * ФАЙЛ: debix-launcher.js
 * Назначение: Автономный лаунчер DebiX с криптографической верификацией Ed25519,
 * дельта-скачиванием только игровых файлов по SHA-256 и управлением lan-server.js.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');

const LAUNCHER_PORT = 8760;
const GAME_SERVER_PORT = 8765;

// Внутри .exe (__dirname) лежит виртуальный снэпшот, а реальная папка на диске рядом с .exe
const IS_PACKAGED_EXE = Boolean(process.pkg);
const SNAPSHOT_DIR = __dirname;
const ROOT_DIR = IS_PACKAGED_EXE ? path.dirname(process.execPath) : __dirname;

// Если .exe запущен с флагом --run-lan-server, он работает как движок для внешнего lan-server.js
if (process.argv.includes('--run-lan-server')) {
    const Module = require('module');
    const bundledWs = require('ws'); // Вшиваем ws в .exe при компиляции
    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'ws') return bundledWs;
        return origLoad.apply(this, arguments);
    };

    process.chdir(ROOT_DIR);
    const serverScriptPath = path.join(ROOT_DIR, 'lan-server.js');
    const serverModule = new Module(serverScriptPath, module);
    serverModule.filename = serverScriptPath;
    serverModule.paths = Module._nodeModulePaths(ROOT_DIR);
    serverModule._compile(fs.readFileSync(serverScriptPath, 'utf8'), serverScriptPath);
    return;
}

const STAGING_DIR = path.join(ROOT_DIR, '.launcher_staging');
const LOCAL_MANIFEST_CACHE = path.join(ROOT_DIR, 'release-manifest.json');
const LOCAL_VERSION_FILE = path.join(ROOT_DIR, 'local-version.json');

// ============================================================================
// 1. НАСТРОЙКИ GIT-РЕПОЗИТОРИЯ И ПУБЛИЧНОГО КЛЮЧА ED25519 (ТОЛЬКО ТВОЙ КЛЮЧ)
// ============================================================================
const LAUNCHER_CONFIG = {
    // Укажи свой GitHub / GitLab репозиторий:
    gitOwner: 'VoxelBear',
    gitRepo: 'DebiX',
    // Лаунчер смотрит ТОЛЬКО в ветку 'release' (обычные коммиты в main игнорируются!)
    releaseBranch: 'release',

    // Вставь сюда публичный ключ, который выдаст команда: node tools/publish-release.js --keygen
    PUBLIC_KEY_PEM: `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAiUxjledhctwPMU/rz0Zz7JZovFzPCgkcR24zpNPJbIs=
-----END PUBLIC KEY-----`
};

// Состояние лаунчера и процесса игры
const launcherState = {
    status: 'idle', // 'idle' | 'checking' | 'update_available' | 'updating' | 'ready' | 'error'
    statusText: 'Готов к проверке обновлений',
    localVersion: '0.0.0',
    remoteVersion: null,
    remoteCommit: null,
    remoteNotes: '',
    signatureVerified: false,
    progressPercent: 0,
    currentFile: '',
    downloadedFilesCount: 0,
    totalFilesToDownload: 0,
    pendingChanges: [], // [{ path, reason: 'missing' | 'outdated' | 'tampered', size }]
    lastError: null,
    gameServerRunning: false,
    gameServerPid: null
};

let gameServerProcess = null;

// ============================================================================
// 2. КРИПТОГРАФИЯ И ЗАЩИТА ОТ ПОДМЕНЫ (Ed25519 + SHA-256 + Path Sanitizer)
// ============================================================================

/**
 * Защита от Path Traversal: запрещает запись вне директории игры (никаких ../ или абсолютных путей)
 */
function sanitizeRelativePath(relPath) {
    if (typeof relPath !== 'string' || !relPath.trim()) {
        throw new Error('Некорректный путь файла в манифесте');
    }
    const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    if (clean.includes('..') || path.isAbsolute(clean)) {
        throw new Error(`Попытка обхода директории заблокирована: ${relPath}`);
    }
    // Разрешаем обновлять только игровые папки и файлы
    const allowedTop = ['index.html', 'lan-server.js', 'launcher.html', 'package.json', 'css/', 'src/'];
    const isAllowed = allowedTop.some(prefix => clean === prefix || clean.startsWith(prefix));
    if (!isAllowed) {
        throw new Error(`Файл не входит в белый список игровых ресурсов: ${clean}`);
    }
    return clean;
}

function buildCanonicalSigningString(manifestData) {
    if (!manifestData || typeof manifestData.files !== 'object') {
        throw new Error('Повреждённая структура манифеста');
    }
    const sortedFilesKeys = Object.keys(manifestData.files).sort();
    const sortedFilesEntries = sortedFilesKeys.map(relPath => {
        const f = manifestData.files[relPath];
        return `${relPath}:${f.sha256}:${f.size}`;
    });

    return JSON.stringify({
        app: 'DebiX',
        version: String(manifestData.version),
        commitSha: String(manifestData.commitSha),
        timestamp: Number(manifestData.timestamp),
        notes: String(manifestData.notes || ''),
        files: sortedFilesEntries
    });
}

/**
 * Проверяет цифровую подпись Ed25519 манифеста публичным ключом разработчика
 */
function verifyManifestSignature(manifest) {
    try {
        if (!manifest || !manifest.signature || !manifest.version || !manifest.commitSha || !manifest.files) {
            return false;
        }
        if (!/^[0-9a-f]{40}$/i.test(manifest.commitSha)) {
            return false;
        }
        const canonical = buildCanonicalSigningString(manifest);
        const sigBuf = Buffer.from(manifest.signature, 'base64');
        return crypto.verify(
            null,
            Buffer.from(canonical, 'utf8'),
            LAUNCHER_CONFIG.PUBLIC_KEY_PEM.trim(),
            sigBuf
        );
    } catch (err) {
        console.error('[Security] Ошибка проверки подписи Ed25519:', err.message);
        return false;
    }
}

function computeFileSha256(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

function computeBufferSha256(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex');
}

// ============================================================================
// 3. СЕТЕВЫЕ ЗАПРОСЫ К GIT (RAW GITHUB С ПОДДЕРЖКОЙ РЕДИРЕКТОВ)
// ============================================================================

function httpsGetBuffer(url, redirectsLeft = 3) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, {
            headers: {
                'User-Agent': 'DebiX-Standalone-Launcher/1.0',
                'Cache-Control': 'no-cache'
            },
            timeout: 15000
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                if (redirectsLeft <= 0) return reject(new Error('Слишком много редиректов'));
                return resolve(httpsGetBuffer(res.headers.location, redirectsLeft - 1));
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} при загрузке ${url}`));
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });

        req.on('error', reject);
        req.on('timeout', () => {
            req.destroy();
            reject(new Error(`Таймаут запроса: ${url}`));
        });
    });
}

function getRemoteManifestUrl() {
    const { gitOwner, gitRepo, releaseBranch } = LAUNCHER_CONFIG;
    return `https://raw.githubusercontent.com/${gitOwner}/${gitRepo}/${releaseBranch}/release-manifest.json?t=${Date.now()}`;
}

function getRemoteFileUrl(commitSha, relPath) {
    const { gitOwner, gitRepo } = LAUNCHER_CONFIG;
    // Скачиваем строго из подписанного иммутабельного commitSha, а не из ветки main!
    return `https://raw.githubusercontent.com/${gitOwner}/${gitRepo}/${commitSha}/${relPath}`;
}

// ============================================================================
// 4. СВЕРКА ФАЙЛОВ И АТОМАРНОЕ ДЕЛЬТА-ОБНОВЛЕНИЕ
// ============================================================================

function readLocalVersionInfo() {
    try {
        if (fs.existsSync(LOCAL_VERSION_FILE)) {
            const data = JSON.parse(fs.readFileSync(LOCAL_VERSION_FILE, 'utf8'));
            launcherState.localVersion = data.version || '0.0.0';
            return data;
        }
        if (fs.existsSync(LOCAL_MANIFEST_CACHE)) {
            const cached = JSON.parse(fs.readFileSync(LOCAL_MANIFEST_CACHE, 'utf8'));
            if (verifyManifestSignature(cached)) {
                launcherState.localVersion = cached.version;
                return cached;
            }
        }
    } catch (e) {}
    return { version: '0.0.0' };
}

/**
 * Сравнивает локальные файлы игры с подписанным манифестом.
 * Возвращает список ТОЛЬКО тех файлов, которые нужно докачать или восстановить.
 */
function calculateDeltaFiles(signedManifest) {
    const changes = [];
    const entries = Object.entries(signedManifest.files);

    for (const [rawRelPath, meta] of entries) {
        const cleanRelPath = sanitizeRelativePath(rawRelPath);
        const absPath = path.join(ROOT_DIR, cleanRelPath);

        if (!fs.existsSync(absPath)) {
            changes.push({
                path: cleanRelPath,
                expectedSha256: meta.sha256,
                size: meta.size,
                reason: 'missing'
            });
            continue;
        }

        const localHash = computeFileSha256(absPath);
        if (localHash !== meta.sha256) {
            const isSameVersion = launcherState.localVersion === signedManifest.version;
            changes.push({
                path: cleanRelPath,
                expectedSha256: meta.sha256,
                size: meta.size,
                reason: isSameVersion ? 'tampered' : 'outdated'
            });
        }
    }

    return changes;
}

async function checkForUpdates() {
    readLocalVersionInfo();
    launcherState.status = 'checking';
    launcherState.statusText = 'Подключение к Git и проверка цифровой подписи Ed25519...';
    launcherState.lastError = null;
    launcherState.signatureVerified = false;

    try {
        const manifestBuf = await httpsGetBuffer(getRemoteManifestUrl());
        const remoteManifest = JSON.parse(manifestBuf.toString('utf8'));

        // КРИТИЧЕСКАЯ ПРОВЕРКА: Валидация подписи Ed25519
        const isValidSig = verifyManifestSignature(remoteManifest);
        if (!isValidSig) {
            launcherState.status = 'error';
            launcherState.signatureVerified = false;
            launcherState.lastError = 'КРИТИЧЕСКАЯ УГРОЗА: Цифровая подпись Ed25519 манифеста недействительна! Обновление заблокировано защитой от подмены.';
            launcherState.statusText = 'Ошибка проверки подписи Ed25519!';
            return launcherState;
        }

        launcherState.signatureVerified = true;
        launcherState.remoteVersion = remoteManifest.version;
        launcherState.remoteCommit = remoteManifest.commitSha;
        launcherState.remoteNotes = remoteManifest.notes || '';

        // Сохраняем проверенный манифест локально для офлайн-проверки целостности
        fs.writeFileSync(LOCAL_MANIFEST_CACHE, JSON.stringify(remoteManifest, null, 2), 'utf8');

        // Вычисляем дельту (только изменившиеся или повреждённые игровые файлы)
        const delta = calculateDeltaFiles(remoteManifest);
        launcherState.pendingChanges = delta;
        launcherState.totalFilesToDownload = delta.length;
        launcherState.downloadedFilesCount = 0;

        if (delta.length > 0 || launcherState.localVersion !== remoteManifest.version) {
            launcherState.status = 'update_available';
            const totalKB = (delta.reduce((s, f) => s + f.size, 0) / 1024).toFixed(1);
            launcherState.statusText = delta.length > 0
                ? `Доступно обновление v${remoteManifest.version} (изменено файлов: ${delta.length}, ${totalKB} KB)`
                : `Доступна версия v${remoteManifest.version} (файлы актуальны)`;
        } else {
            launcherState.status = 'ready';
            launcherState.progressPercent = 100;
            launcherState.statusText = `Установлена актуальная версия v${remoteManifest.version}. Все файлы прошли проверку SHA-256.`;
        }
    } catch (err) {
        // Если нет интернета или ещё не настроен Git, проверяем по локальному подписанному манифесту
        if (fs.existsSync(LOCAL_MANIFEST_CACHE)) {
            try {
                const cachedManifest = JSON.parse(fs.readFileSync(LOCAL_MANIFEST_CACHE, 'utf8'));
                if (verifyManifestSignature(cachedManifest)) {
                    const localDelta = calculateDeltaFiles(cachedManifest);
                    if (localDelta.length === 0) {
                        launcherState.signatureVerified = true;
                        launcherState.status = 'ready';
                        launcherState.statusText = `Офлайн-режим (v${cachedManifest.version}): локальная подпись и файлы целы.`;
                        return launcherState;
                    } else {
                        launcherState.status = 'error';
                        launcherState.lastError = `Офлайн-режим: обнаружено повреждение или модификация ${localDelta.length} файлов (${localDelta.map(d => d.path).join(', ')}). Подключитесь к сети для восстановления.`;
                        launcherState.statusText = 'Нарушена целостность локальных файлов!';
                        return launcherState;
                    }
                }
            } catch (e) {}
        }

        launcherState.status = 'error';
        launcherState.lastError = `Не удалось получить подписанный манифест: ${err.message}`;
        launcherState.statusText = 'Ошибка соединения с сервером обновлений';
    }

    return launcherState;
}

function cleanStagingDir() {
    if (fs.existsSync(STAGING_DIR)) {
        fs.rmSync(STAGING_DIR, { recursive: true, force: true });
    }
}

async function performDeltaUpdate() {
    if (launcherState.status === 'updating') return launcherState;

    launcherState.status = 'updating';
    launcherState.lastError = null;
    launcherState.progressPercent = 0;

    try {
        // 1. Заново загружаем и проверяем подпись манифеста перед скачиванием
        const manifestBuf = await httpsGetBuffer(getRemoteManifestUrl());
        const remoteManifest = JSON.parse(manifestBuf.toString('utf8'));

        if (!verifyManifestSignature(remoteManifest)) {
            throw new Error('Подпись Ed25519 не прошла верификацию перед установкой!');
        }

        const delta = calculateDeltaFiles(remoteManifest);
        launcherState.pendingChanges = delta;
        launcherState.totalFilesToDownload = delta.length;
        launcherState.downloadedFilesCount = 0;

        cleanStagingDir();
        fs.mkdirSync(STAGING_DIR, { recursive: true });

        // 2. Скачиваем ТОЛЬКО нужные файлы во временную папку .launcher_staging и сверяем SHA-256
        for (let i = 0; i < delta.length; i++) {
            const item = delta[i];
            const cleanRelPath = sanitizeRelativePath(item.path);
            launcherState.currentFile = cleanRelPath;
            launcherState.statusText = `Загрузка [${i + 1}/${delta.length}]: ${cleanRelPath}`;

            const fileUrl = getRemoteFileUrl(remoteManifest.commitSha, cleanRelPath);
            const fileBuffer = await httpsGetBuffer(fileUrl);

            // Строгая проверка SHA-256 скачанного буфера до записи на диск
            const actualSha256 = computeBufferSha256(fileBuffer);
            if (actualSha256 !== item.expectedSha256) {
                throw new Error(
                    `Нарушение целостности файла ${cleanRelPath}! Ожидался SHA-256: ${item.expectedSha256.slice(0, 12)}..., получен: ${actualSha256.slice(0, 12)}... Обновление отменено.`
                );
            }

            const stagingFilePath = path.join(STAGING_DIR, cleanRelPath);
            fs.mkdirSync(path.dirname(stagingFilePath), { recursive: true });
            fs.writeFileSync(stagingFilePath, fileBuffer);

            launcherState.downloadedFilesCount = i + 1;
            launcherState.progressPercent = Math.round(((i + 1) / delta.length) * 100);
        }

        // 3. Все файлы прошли проверку SHA-256 — атомарно переносим их в рабочую директорию
        for (const item of delta) {
            const cleanRelPath = sanitizeRelativePath(item.path);
            const stagingFilePath = path.join(STAGING_DIR, cleanRelPath);
            const targetFilePath = path.join(ROOT_DIR, cleanRelPath);

            fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });
            fs.copyFileSync(stagingFilePath, targetFilePath);
        }

        cleanStagingDir();

        // 4. Фиксируем новую версию
        const versionInfo = {
            version: remoteManifest.version,
            commitSha: remoteManifest.commitSha,
            updatedAt: new Date().toISOString()
        };
        fs.writeFileSync(LOCAL_VERSION_FILE, JSON.stringify(versionInfo, null, 2), 'utf8');
        fs.writeFileSync(LOCAL_MANIFEST_CACHE, JSON.stringify(remoteManifest, null, 2), 'utf8');

        launcherState.localVersion = remoteManifest.version;
        launcherState.pendingChanges = [];
        launcherState.currentFile = '';
        launcherState.progressPercent = 100;
        launcherState.status = 'ready';
        launcherState.statusText = `Обновление до v${remoteManifest.version} успешно установлено!`;
    } catch (err) {
        cleanStagingDir();
        launcherState.status = 'error';
        launcherState.lastError = err.message;
        launcherState.statusText = 'Ошибка при установке обновления';
    }

    return launcherState;
}

// ============================================================================
// 5. ЗАПУСК И КОНТРОЛЬ ИГРОВОГО СЕРВЕРА (lan-server.js) С ПРОВЕРКОЙ ЦЕЛОСТНОСТИ
// ============================================================================

function openUrlInBrowser(url) {
    const platform = process.platform;
    if (platform === 'win32') {
        exec(`start "" "${url}"`);
    } else if (platform === 'darwin') {
        exec(`open "${url}"`);
    } else {
        exec(`xdg-open "${url}"`);
    }
}

function startGameServerAndLaunch() {
    // Перед запуском игры проверяем целостность локальных файлов по подписанному кэшу
    if (fs.existsSync(LOCAL_MANIFEST_CACHE)) {
        const cached = JSON.parse(fs.readFileSync(LOCAL_MANIFEST_CACHE, 'utf8'));
        if (!verifyManifestSignature(cached)) {
            throw new Error('Локальный манифест повреждён или подделан. Запустите проверку обновлений.');
        }
        const tampered = calculateDeltaFiles(cached);
        if (tampered.length > 0) {
            launcherState.pendingChanges = tampered;
            launcherState.status = 'update_available';
            throw new Error(
                `Запуск заблокирован: обнаружена модификация или отсутствие ${tampered.length} игровых файлов (${tampered[0].path}). Нажмите «Восстановить / Обновить».`
            );
        }
    }

    const lanServerPath = path.join(ROOT_DIR, 'lan-server.js');
    if (!fs.existsSync(lanServerPath)) {
        throw new Error('Файл lan-server.js не найден!');
    }

    // Если в проекте есть package.json, но ещё нет node_modules — ставим зависимости автоматически
    const pkgPath = path.join(ROOT_DIR, 'package.json');
    const nodeModulesPath = path.join(ROOT_DIR, 'node_modules');
    if (!IS_PACKAGED_EXE && fs.existsSync(pkgPath) && !fs.existsSync(nodeModulesPath)) {
        console.log('📦 Установка зависимостей из package.json...');
        execSync('npm install --omit=dev', { cwd: ROOT_DIR, stdio: 'inherit' });
        console.log('✅ Зависимости установлены.');
    }

    if (!gameServerProcess) {
        // В режиме .exe вызываем сам DebiX-Launcher.exe с флагом --run-lan-server
        const spawnArgs = IS_PACKAGED_EXE ? ['--run-lan-server'] : [lanServerPath];
        gameServerProcess = spawn(process.execPath, spawnArgs, {
            cwd: ROOT_DIR,
            stdio: 'inherit'
        });

        launcherState.gameServerRunning = true;
        launcherState.gameServerPid = gameServerProcess.pid;

        gameServerProcess.on('exit', () => {
            gameServerProcess = null;
            launcherState.gameServerRunning = false;
            launcherState.gameServerPid = null;
        });
    }

    const gameUrl = `http://localhost:${GAME_SERVER_PORT}`;
    setTimeout(() => openUrlInBrowser(gameUrl), 450);

    return { ok: true, gameUrl, pid: launcherState.gameServerPid };
}

function stopGameServer() {
    if (gameServerProcess) {
        gameServerProcess.kill();
        gameServerProcess = null;
    }
    launcherState.gameServerRunning = false;
    launcherState.gameServerPid = null;
}

// ============================================================================
// 6. ЛОКАЛЬНЫЙ HTTP API ЛАУНЧЕРА (Порт 8760)
// ============================================================================

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, `http://localhost:${LAUNCHER_PORT}`);
    const pathname = parsedUrl.pathname;

    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET' && (pathname === '/' || pathname === '/launcher.html')) {
        const externalHtmlPath = path.join(ROOT_DIR, 'launcher.html');
        const bundledHtmlPath = path.join(SNAPSHOT_DIR, 'launcher.html');
        const htmlPath = fs.existsSync(externalHtmlPath) ? externalHtmlPath : bundledHtmlPath;

        if (!fs.existsSync(htmlPath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            return res.end('Файл launcher.html не найден');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(htmlPath));
    }

    if (req.method === 'GET' && pathname === '/api/launcher/status') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({
            ...launcherState,
            repo: `${LAUNCHER_CONFIG.gitOwner}/${LAUNCHER_CONFIG.gitRepo}`,
            branch: LAUNCHER_CONFIG.releaseBranch
        }));
    }

    if (req.method === 'POST' && pathname === '/api/launcher/check') {
        const state = await checkForUpdates();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(state));
    }

    if (req.method === 'POST' && pathname === '/api/launcher/update') {
        performDeltaUpdate(); // Асинхронный запуск, прогресс опрашивается через /api/launcher/status
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ started: true }));
    }

    if (req.method === 'POST' && pathname === '/api/launcher/play') {
        try {
            const result = startGameServerAndLaunch();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify(result));
        } catch (err) {
            res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: false, error: err.message }));
        }
    }

    if (req.method === 'POST' && pathname === '/api/launcher/stop-server') {
        stopGameServer();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify({ ok: true }));
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(LAUNCHER_PORT, () => {
    readLocalVersionInfo();
    const launcherUrl = `http://localhost:${LAUNCHER_PORT}`;
    console.log('==============================================================');
    console.log(`🛡️  DebiX Secure Standalone Launcher запущен: ${launcherUrl}`);
    console.log(`📦 Локальная версия: v${launcherState.localVersion}`);
    console.log('==============================================================');
    openUrlInBrowser(launcherUrl);
    checkForUpdates();
});

process.on('SIGINT', () => {
    stopGameServer();
    process.exit(0);
});