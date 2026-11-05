#!/usr/bin/env node
/**
 * Tek komutla barındırma:   npm run host
 * ---------------------------------------------------------------
 * Yaptıkları:
 *   1. Discord uygulama kimliğini çözer (--client-id / .env / DISCORD_CLIENT_ID)
 *   2. İstemciyi derler (vite build)
 *   3. Yerel sunucuyu başlatır (server.js)
 *   4. cloudflared yoksa indirir ve GİRİŞSİZ (quick) bir tünel açar
 *   5. Herkese açık https adresini ve Developer Portal'a yapıştırılacak
 *      URL eşlemesini ekrana yazar
 *
 * Gereksinim: Node.js 20+  (cloudflared kurmana gerek yok, otomatik iner)
 *
 * Seçenekler:
 *   --client-id <id>   Discord uygulama kimliği
 *   --port <port>      Yerel port (varsayılan 3000)
 *   --no-build         Derlemeyi atla (dist zaten varsa)
 *   --open             Developer Portal'ı tarayıcıda aç
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = path.join(ROOT, '.tools');
const DEFAULT_CLIENT_ID = '1518311302097797233';
const isWindows = process.platform === 'win32';
const isTty = Boolean(process.stdout.isTTY);

// Windows konsolunu UTF-8'e al; yoksa Türkçe karakterler bozuk görünür.
if (isWindows && isTty) {
    spawnSync('cmd', ['/c', 'chcp', '65001'], { stdio: 'ignore' });
}

const C = isTty
    ? { cyan: '\x1b[36m', green: '\x1b[32m', red: '\x1b[31m', bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m' }
    : { cyan: '', green: '', red: '', bold: '', dim: '', reset: '' };

// ---------------------------------------------------------------- argümanlar
const args = process.argv.slice(2);
function argValue(name) {
    const withEq = args.find((a) => a.startsWith(`${name}=`));
    if (withEq) return withEq.slice(name.length + 1);
    const idx = args.indexOf(name);
    if (idx !== -1 && args[idx + 1] && !args[idx + 1].startsWith('--')) return args[idx + 1];
    return null;
}
const hasFlag = (name) => args.includes(name);

const port = Number(argValue('--port') || process.env.PORT || 3000);
const shouldBuild = !hasFlag('--no-build');

// ------------------------------------------------------------------ .env oku
function readDotEnv() {
    const envPath = path.join(ROOT, '.env');
    const out = {};
    if (!fs.existsSync(envPath)) return out;
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
        if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
}
const dotEnv = readDotEnv();
const clientId =
    argValue('--client-id') ||
    process.env.DISCORD_CLIENT_ID ||
    process.env.VITE_DISCORD_CLIENT_ID ||
    dotEnv.VITE_DISCORD_CLIENT_ID ||
    dotEnv.DISCORD_CLIENT_ID ||
    DEFAULT_CLIENT_ID;

// ------------------------------------------------------------------- araçlar
const log = (msg = '') => process.stdout.write(`${msg}\n`);
const step = (msg) => log(`${C.cyan}▶${C.reset} ${msg}`);

function copyToClipboard(text) {
    try {
        if (isWindows) {
            spawnSync('cmd', ['/c', 'clip'], { input: text });
        } else if (process.platform === 'darwin') {
            spawnSync('pbcopy', { input: text });
        } else {
            spawnSync('sh', ['-c', 'xclip -selection clipboard 2>/dev/null || wl-copy 2>/dev/null'], {
                input: text,
            });
        }
        return true;
    } catch {
        return false;
    }
}

function findCloudflared() {
    const exe = isWindows ? 'cloudflared.exe' : 'cloudflared';
    const candidates = [
        process.env.CLOUDFLARED,
        path.join(TOOLS_DIR, exe),
        isWindows ? 'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe' : null,
        isWindows ? 'C:\\Program Files\\cloudflared\\cloudflared.exe' : null,
        path.join(os.homedir(), '.cloudflared', exe),
    ].filter(Boolean);
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    const which = spawnSync(isWindows ? 'where' : 'which', ['cloudflared'], { encoding: 'utf8' });
    if (which.status === 0) {
        const first = which.stdout.split(/\r?\n/).find(Boolean);
        if (first && fs.existsSync(first.trim())) return first.trim();
    }
    return null;
}

async function downloadCloudflared() {
    const release = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
    let url;
    let asset;
    if (isWindows) {
        asset = 'cloudflared-windows-amd64.exe';
        url = `${release}/${asset}`;
    } else if (process.platform === 'darwin') {
        asset = `cloudflared-darwin-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.tgz`;
        url = `${release}/${asset}`;
    } else {
        asset = `cloudflared-linux-${process.arch === 'arm64' ? 'arm64' : 'amd64'}`;
        url = `${release}/${asset}`;
    }

    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    const dest = path.join(TOOLS_DIR, isWindows ? 'cloudflared.exe' : 'cloudflared');

    step(`cloudflared indiriliyor: ${asset}`);
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`indirilemedi (HTTP ${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());

    if (asset.endsWith('.tgz')) {
        const tgz = path.join(TOOLS_DIR, asset);
        fs.writeFileSync(tgz, buf);
        const ex = spawnSync('tar', ['-xzf', tgz, '-C', TOOLS_DIR], { stdio: 'inherit' });
        fs.rmSync(tgz, { force: true });
        if (ex.status !== 0) throw new Error('arşiv açılamadı (tar)');
    } else {
        fs.writeFileSync(dest, buf);
    }
    if (!isWindows) fs.chmodSync(dest, 0o755);
    return dest;
}

function run(cmd, cmdArgs, opts = {}) {
    return spawnSync(cmd, cmdArgs, { cwd: ROOT, shell: isWindows, stdio: 'inherit', ...opts });
}

function build() {
    step(`İstemci derleniyor (client id: ${clientId})...`);
    const r = run('npm', ['run', 'build'], {
        env: { ...process.env, VITE_DISCORD_CLIENT_ID: clientId },
    });
    if (r.status !== 0) {
        log(`${C.red}✖ Derleme başarısız.${C.reset}`);
        process.exit(1);
    }
}

// ----------------------------------------------------------------- ana akış
const children = [];
function shutdown(code = 0) {
    for (const c of children) {
        try {
            c.kill();
        } catch {
            /* yok say */
        }
    }
    process.exit(code);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

function main() {
    if (!/^\d+$/.test(String(clientId))) {
        log(`${C.red}✖ Geçersiz Discord uygulama kimliği.${C.reset}`);
        log('  --client-id <id> ver ya da .env dosyasına VITE_DISCORD_CLIENT_ID yaz.');
        process.exit(1);
    }

    if (shouldBuild) build();
    else step('Derleme atlandı (--no-build).');

    step(`Sunucu başlatılıyor (port ${port})...`);
    const server = spawn(process.execPath, ['server.js'], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(server);
    server.stdout.on('data', (d) => process.stdout.write(`${C.dim}[server]${C.reset} ${d}`));
    server.stderr.on('data', (d) => process.stderr.write(`${C.dim}[server]${C.reset} ${d}`));
    server.on('exit', (code) => {
        log(`${C.red}Sunucu durdu (kod ${code}).${C.reset}`);
        shutdown(1);
    });

    const startTunnel = (bin) => {
        step('cloudflared tüneli açılıyor (giriş gerekmez; adres her açılışta değişir)...');
        const cf = spawn(bin, ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'], {
            cwd: ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        children.push(cf);

        let announced = false;
        const handle = (chunk) => {
            const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString());
            if (m && !announced) {
                announced = true;
                onTunnelReady(m[0]);
            }
        };
        cf.stdout.on('data', handle);
        cf.stderr.on('data', handle);
        cf.on('exit', (code) => {
            log(`${C.red}cloudflared durdu (kod ${code}).${C.reset}`);
            shutdown(1);
        });
    };

    const bin = findCloudflared();
    if (bin) {
        startTunnel(bin);
    } else {
        downloadCloudflared()
            .then(startTunnel)
            .catch((err) => {
                log(`${C.red}✖ cloudflared alınamadı: ${err.message}${C.reset}`);
                log('  Elle kurabilirsin:  winget install Cloudflare.cloudflared');
                shutdown(1);
            });
    }
}

function onTunnelReady(publicUrl) {
    const copied = copyToClipboard(publicUrl);
    const line = '─'.repeat(66);
    log('');
    log(`${C.green}${line}${C.reset}`);
    log(`  ${C.bold}AKTİVİTE HAZIR${C.reset}`);
    log(`  Herkese açık adres:  ${C.bold}${publicUrl}${C.reset}`);
    if (copied) log('  (adres panoya kopyalandı)');
    log('');
    log('  Discord Developer Portal → uygulaman → Activities → URL Mappings:');
    log(`     Prefix  /          →  ${publicUrl}`);
    log(`     Prefix  /api       →  ${publicUrl}`);
    log(`     Prefix  /proxy     →  ${publicUrl}`);
    log(`     Prefix  /socket.io →  ${publicUrl}`);
    log('');
    log("  Sonra Discord'da bir ses kanalında aktiviteyi başlat.");
    log('  Kapatmak için: Ctrl+C');
    log(`${C.green}${line}${C.reset}`);
    log('');
    if (hasFlag('--open')) {
        const portal = `https://discord.com/developers/applications/${clientId}/activities`;
        if (isWindows) spawnSync('cmd', ['/c', 'start', '', portal], { stdio: 'ignore' });
        else spawnSync('open', [portal], { stdio: 'ignore' });
    }
}

main();
