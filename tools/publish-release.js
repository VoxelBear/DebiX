/**
 * ФАЙЛ: tools/publish-release.js
 * Назначение: Генерация ключей Ed25519, сборка белого списка игровых файлов,
 * расчёт SHA-256 и криптографическая подпись релиза DebiX.
 *
 * КОМАНДЫ:
 * 1) Сгенерировать ключи (один раз):
 *    node tools/publish-release.js --keygen
 *
 * 2) Выпустить подписанное обновление:
 *    node tools/publish-release.js --version 1.0.1 --notes "Новые блоки и исправление физики" --push
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const PRIVATE_KEY_PATH = path.join(__dirname, '.private_key.pem');
const PUBLIC_KEY_PATH = path.join(__dirname, 'public_key.pem');
const MANIFEST_OUTPUT_PATH = path.join(ROOT_DIR, 'release-manifest.json');

// СТРОГИЙ БЕЛЫЙ СПИСОК: в обновление попадают ТОЛЬКО файлы, необходимые для работы игры
const GAME_FILES_WHITELIST = {
    exactFiles: [
        'index.html',
        'lan-server.js',
        'launcher.html',
        'package.json'
    ],
    directories: [
        'css',
        'src'
    ],
    allowedExtensions: ['.html', '.css', '.js', '.json', '.png', '.jpg', '.ogg', '.mp3', '.wav']
};

// Файлы, которые НИКОГДА не должны перезаписываться или попадать в манифест
const EXCLUDED_PATHS = new Set([
    'shared_hub_data.json',
    'local-version.json',
    'release-manifest.json',
    'package-lock.json',
    '.gitignore'
]);

function normalizeRelPath(p) {
    return p.split(path.sep).join('/');
}

function sha256File(filePath) {
    const buf = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * Каноническая сериализация данных манифеста для подписи Ed25519.
 * Должна быть абсолютно идентичной в publish-release.js и debix-launcher.js.
 */
function buildCanonicalSigningString(manifestData) {
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

function ensureGitignoreHasPrivateKey() {
    const gitignorePath = path.join(ROOT_DIR, '.gitignore');
    const ignoreRules = [
        '# DebiX Release Signer Private Key & Staging',
        'tools/.private_key.pem',
        '.launcher_staging/',
        'local-version.json'
    ];

    let content = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
    let changed = false;

    for (const rule of ignoreRules) {
        if (!content.includes(rule)) {
            content += (content.endsWith('\n') || content.length === 0 ? '' : '\n') + rule + '\n';
            changed = true;
        }
    }

    if (changed) {
        fs.writeFileSync(gitignorePath, content, 'utf8');
        console.log('[Gitignore] Правила безопасности добавлены в .gitignore');
    }
}

function generateKeyPair() {
    ensureGitignoreHasPrivateKey();

    if (fs.existsSync(PRIVATE_KEY_PATH)) {
        console.error('[ОШИБКА] Закрытый ключ уже существует в tools/.private_key.pem!');
        console.error('Удалите его вручную, если действительно хотите перевыпустить ключи.');
        process.exit(1);
    }

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    fs.writeFileSync(PRIVATE_KEY_PATH, privateKey, { encoding: 'utf8', mode: 0o600 });
    fs.writeFileSync(PUBLIC_KEY_PATH, publicKey, 'utf8');

    console.log('==============================================================');
    console.log('✅ КЛЮЧИ ED25519 УСПЕШНО СГЕНЕРИРОВАНЫ!');
    console.log('==============================================================');
    console.log('🔒 Закрытый ключ (НИКОМУ НЕ ПЕРЕДАВАТЬ): tools/.private_key.pem');
    console.log('🔑 Публичный ключ (скопируй в debix-launcher.js в PUBLIC_KEY_PEM):\n');
    console.log(publicKey);
    console.log('==============================================================');
}

function collectDirectoryFiles(dirAbsPath, fileMap) {
    if (!fs.existsSync(dirAbsPath)) return;
    const entries = fs.readdirSync(dirAbsPath, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dirAbsPath, entry.name);
        const relPath = normalizeRelPath(path.relative(ROOT_DIR, fullPath));

        if (EXCLUDED_PATHS.has(relPath) || entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
            collectDirectoryFiles(fullPath, fileMap);
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (!GAME_FILES_WHITELIST.allowedExtensions.includes(ext)) continue;

            const stat = fs.statSync(fullPath);
            fileMap[relPath] = {
                sha256: sha256File(fullPath),
                size: stat.size
            };
        }
    }
}

function scanRequiredGameFiles() {
    const fileMap = {};

    // 1. Точные корневые файлы
    for (const relFile of GAME_FILES_WHITELIST.exactFiles) {
        const fullPath = path.join(ROOT_DIR, relFile);
        if (!fs.existsSync(fullPath)) {
            console.warn(`[ВНИМАНИЕ] Пропущен отсутствующий файл из белого списка: ${relFile}`);
            continue;
        }
        const stat = fs.statSync(fullPath);
        fileMap[normalizeRelPath(relFile)] = {
            sha256: sha256File(fullPath),
            size: stat.size
        };
    }

    // 2. Игровые директории (css/, src/)
    for (const dirName of GAME_FILES_WHITELIST.directories) {
        collectDirectoryFiles(path.join(ROOT_DIR, dirName), fileMap);
    }

    return fileMap;
}

function getCurrentGitCommitSha() {
    try {
        return execSync('git rev-parse HEAD', { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch (e) {
        console.error('[ОШИБКА] Не удалось получить хэш коммита Git. Убедитесь, что проект инициализирован в Git и изменения закоммичены.');
        process.exit(1);
    }
}

function parseArgs() {
    const args = process.argv.slice(2);
    const parsed = { keygen: false, version: null, notes: '', push: false };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--keygen') parsed.keygen = true;
        else if (args[i] === '--version' && args[i + 1]) parsed.version = args[++i];
        else if (args[i] === '--notes' && args[i + 1]) parsed.notes = args[++i];
        else if (args[i] === '--push') parsed.push = true;
    }
    return parsed;
}

function publishRelease() {
    const args = parseArgs();

    if (args.keygen) {
        generateKeyPair();
        return;
    }

    if (!args.version) {
        console.error('Использование:');
        console.error('  node tools/publish-release.js --keygen');
        console.error('  node tools/publish-release.js --version 1.0.2 --notes "Описание обновления" [--push]');
        process.exit(1);
    }

    if (!fs.existsSync(PRIVATE_KEY_PATH)) {
        console.error('[ОШИБКА] Закрытый ключ tools/.private_key.pem не найден! Сначала выполните: node tools/publish-release.js --keygen');
        process.exit(1);
    }

    ensureGitignoreHasPrivateKey();

    const commitSha = getCurrentGitCommitSha();
    const files = scanRequiredGameFiles();
    const fileCount = Object.keys(files).length;

    if (fileCount === 0) {
        console.error('[ОШИБКА] Не найдено ни одного игрового файла для релиза.');
        process.exit(1);
    }

    const manifestPayload = {
        app: 'DebiX',
        version: args.version,
        commitSha: commitSha,
        timestamp: Date.now(),
        notes: args.notes || `Обновление DebiX v${args.version}`,
        files: files
    };

    // Подписываем каноническое представление закрытым ключом Ed25519
    const privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8');
    const canonicalString = buildCanonicalSigningString(manifestPayload);
    const signatureBuffer = crypto.sign(null, Buffer.from(canonicalString, 'utf8'), privateKeyPem);
    const signatureBase64 = signatureBuffer.toString('base64');

    // Проверяем подпись публичным ключом перед сохранением
    if (fs.existsSync(PUBLIC_KEY_PATH)) {
        const publicKeyPem = fs.readFileSync(PUBLIC_KEY_PATH, 'utf8');
        const verified = crypto.verify(null, Buffer.from(canonicalString, 'utf8'), publicKeyPem, signatureBuffer);
        if (!verified) {
            console.error('[КРИТИЧЕСКАЯ ОШИБКА] Самопроверка подписи Ed25519 не прошла!');
            process.exit(1);
        }
    }

    const finalManifest = {
        ...manifestPayload,
        signature: signatureBase64
    };

    fs.writeFileSync(MANIFEST_OUTPUT_PATH, JSON.stringify(finalManifest, null, 2), 'utf8');

    const totalBytes = Object.values(files).reduce((acc, f) => acc + f.size, 0);
    console.log('==============================================================');
    console.log(`🚀 РЕЛИЗ DebiX v${args.version} УСПЕШНО ПОДПИСАН (Ed25519)`);
    console.log('==============================================================');
    console.log(`📌 Привязанный коммит (commitSha): ${commitSha}`);
    console.log(`📦 Игровых файлов в манифесте:    ${fileCount} (${(totalBytes / 1024).toFixed(1)} KB)`);
    console.log(`🔏 Подпись (Ed25519):             ${signatureBase64.slice(0, 32)}...`);
    console.log(`📄 Файл манифеста:                release-manifest.json`);
    console.log('==============================================================');

    if (args.push) {
        try {
            console.log('[Git] Публикация манифеста в релизную ветку "release"...');
            execSync('git add release-manifest.json', { cwd: ROOT_DIR, stdio: 'inherit' });
            execSync(`git commit -m "Release v${args.version}" --allow-empty`, { cwd: ROOT_DIR, stdio: 'inherit' });
            execSync('git push origin HEAD', { cwd: ROOT_DIR, stdio: 'inherit' });
            execSync('git push origin HEAD:refs/heads/release --force', { cwd: ROOT_DIR, stdio: 'inherit' });
            console.log('✅ Ветка "release" обновлена! Теперь лаунчеры игроков увидят обновление v' + args.version);
        } catch (err) {
            console.error('[ОШИБКА Git Push] Не удалось автоматически запушить ветку release:', err.message);
        }
    } else {
        console.log('💡 Чтобы опубликовать это обновление для лаунчеров, выполни:');
        console.log('   git add release-manifest.json && git commit -m "Release v' + args.version + '"');
        console.log('   git push origin HEAD && git push origin HEAD:refs/heads/release --force');
    }
}

publishRelease();