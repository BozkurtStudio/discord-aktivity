import express from 'express';
import http from 'http';
import https from 'https';
import { Readable } from 'stream';
import { URL } from 'url';
import { Server } from 'socket.io';
import { buildProxyHeaders, assertSafeUrl, USER_AGENT, isRelayEnabled, relayFetch, relayInfo } from './server/net.js';
import { resolveVideoUrl, ResolveError } from './server/resolve.js';
import { listSources, getSource, resolveDescriptor } from './server/sources/index.js';

const app = express();
app.use(express.json({ limit: '100kb' }));
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Vite build çıktılarını statik olarak sun.
// index.html önbelleğe alınmasın; aksi halde eski (silinmiş) JS paketine
// işaret eden bayat sayfa tarayıcıda takılı kalabiliyor.
app.use(express.static('dist', {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
            res.setHeader('Cache-Control', 'no-store, must-revalidate');
        }
    },
}));

// ============================================================
// SAYDAM (TRANSPARENT) PROXY KÖPRÜSÜ
// Diski doldurmaz. Tarayıcının 'Range' isteklerini doğrudan kaynağa yollar.
// ============================================================
function proxyRequest(targetUrl, reqHeaders, res, referer = null, maxRedirects = 5) {
    // Relay açıksa video baytlarını da relay üzerinden akıt. Aksi halde bazı
    // CDN'ler barındırma sağlayıcısının (ör. Render) doğrudan IP'sini 403 ile
    // engelliyor; relay bu engeli aşar.
    if (isRelayEnabled()) {
        proxyRequestViaRelay(targetUrl, reqHeaders, res, referer);
        return;
    }

    let parsedUrl;
    let options;

    try {
        parsedUrl = assertSafeUrl(targetUrl);
        options = {
            headers: buildProxyHeaders(targetUrl, {
                range: reqHeaders.range,
                referer,
            }),
        };
    } catch (err) {
        if (!res.headersSent) res.status(400).send(err.message);
        return;
    }

    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const proxyReq = protocol.get(targetUrl, options, (proxyRes) => {
        // Yönlendirme (Redirect) takibi
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location && maxRedirects > 0) {
            let nextUrl = proxyRes.headers.location;
            if (!nextUrl.startsWith('http')) {
                nextUrl = new URL(nextUrl, targetUrl).href;
            }
            proxyReq.destroy();
            proxyRequest(nextUrl, reqHeaders, res, referer, maxRedirects - 1);
        } else {
            // Hedef sunucudan gelen header'ları temizleyip bizim tarayıcıya aktar
            const safeHeaders = {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                'Access-Control-Allow-Origin': '*'
            };

            if (proxyRes.headers['content-length']) safeHeaders['Content-Length'] = proxyRes.headers['content-length'];
            if (proxyRes.headers['content-range']) safeHeaders['Content-Range'] = proxyRes.headers['content-range'];
            if (proxyRes.headers['accept-ranges']) safeHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];
            if (proxyRes.headers['cache-control']) safeHeaders['Cache-Control'] = proxyRes.headers['cache-control'];

            res.writeHead(proxyRes.statusCode, safeHeaders);

            // Veriyi diske yazmadan doğrudan tarayıcıya borula (pipe)
            proxyRes.pipe(res);
        }
    });

    proxyReq.on('error', (err) => {
        console.error("Proxy Bağlantı Hatası:", err.message);
        if (!res.headersSent) res.status(502).send("Bad Gateway");
    });
    
    // Kullanıcı videoyu durdurursa veya çıkarsa bağlantıyı kopar ki veri harcanmasın
    res.on('close', () => {
        proxyReq.destroy();
    });
}

// Relay üzerinden saydam proxy. Aralık (Range) başlıkları ve 206 yanıtı
// olduğu gibi korunur; gövde diske yazılmadan doğrudan tarayıcıya akıtılır.
async function proxyRequestViaRelay(targetUrl, reqHeaders, res, referer = null) {
    let headers;
    try {
        assertSafeUrl(targetUrl);
        headers = buildProxyHeaders(targetUrl, {
            range: reqHeaders.range,
            referer,
        });
    } catch (err) {
        if (!res.headersSent) res.status(400).send(err.message);
        return;
    }

    let response;
    try {
        response = await relayFetch(targetUrl, { method: 'GET', headers });
    } catch (err) {
        console.error('Proxy (relay) Bağlantı Hatası:', err.message);
        if (!res.headersSent) res.status(502).send('Bad Gateway');
        return;
    }

    const safeHeaders = {
        'Content-Type': response.headers.get('content-type') || 'video/mp4',
        'Access-Control-Allow-Origin': '*',
    };
    for (const header of ['content-length', 'content-range', 'accept-ranges', 'cache-control']) {
        const value = response.headers.get(header);
        if (value) safeHeaders[header] = value;
    }

    res.writeHead(response.status, safeHeaders);

    if (!response.body) {
        res.end();
        return;
    }

    const stream = Readable.fromWeb(response.body);
    stream.on('error', err => {
        console.error('Proxy (relay) akış hatası:', err.message);
        res.destroy(err);
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
}

app.get('/proxy/stream', (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : null;
    const referer = typeof req.query.ref === 'string' ? req.query.ref : null;
    if (!url) return res.status(400).send("URL belirtilmedi.");

    try {
        assertSafeUrl(url);
        if (referer) assertSafeUrl(referer);
    } catch (err) {
        return res.status(400).send(err.message);
    }

    proxyRequest(url, req.headers, res, referer);
});

// ============================================================
// EMBED ÇÖZÜMLEYİCİ
// Host'un yapıştırdığı embed/izleme linkini doğrudan mp4/m3u8 adresine çevirir.
// ============================================================
app.get('/api/resolve', async (req, res) => {
    const url = typeof req.query.url === 'string' ? req.query.url : '';

    if (!url.trim()) {
        return res.status(400).json({ error: 'URL belirtilmedi.' });
    }

    try {
        const result = await resolveVideoUrl(url);
        console.log(`[Resolve] ${url} -> ${result.url} (${result.source})`);
        res.json(result);
    } catch (err) {
        console.error('[Resolve] Hata:', err.message);
        res.status(422).json({
            error: err instanceof ResolveError
                ? err.message
                : 'Embed adresi çözümlenemedi. Linki kontrol edin.',
        });
    }
});


// ============================================================
// KÜTÜPHANE / KAYNAK API'LERİ
// ============================================================
function sendApiError(res, err, fallback) {
    const status = err?.statusCode || 422;
    console.error('[API]', err?.message || err);
    res.status(status).json({ error: err?.message || fallback });
}

app.get('/api/sources', (req, res) => {
    res.json({ sources: listSources() });
});

// Teşhis: sunucunun kaynak sitelere erişip erişemediğini, hangi çıkış IP'siyle
// çıktığını ve engellenme yanıtının başlık/gövdesini gösterir. Gizli bilgi
// döndürmez; bir sorun giderme aracıdır.
const DIAG_TARGETS = [
    { name: 'sezonlukdizi-home', url: 'https://sezonlukdizi.cc/', method: 'GET' },
    {
        name: 'sezonlukdizi-search',
        url: 'https://sezonlukdizi.cc/ajax/arama.asp',
        method: 'POST',
        body: 'q=test',
    },
    { name: 'jetfilmizle-search', url: 'https://jetfilmizle.app/arama-json?q=test', method: 'GET' },
    { name: 'jetfilmizle-home', url: 'https://jetfilmizle.app/', method: 'GET' },
    { name: 'videopark-home', url: 'https://videopark.top/', method: 'GET' },
];

const DIAG_HEADER_KEYS = [
    'server',
    'cf-mitigated',
    'cf-ray',
    'cf-cache-status',
    'location',
    'content-type',
    'x-powered-by',
    'x-relay-via',
];

async function diagProbe(target) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
        const headers = {
            'User-Agent': USER_AGENT,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7',
        };
        if (target.body) headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=UTF-8';

        const response = isRelayEnabled()
            ? await relayFetch(target.url, {
                  method: target.method,
                  headers,
                  body: target.method === 'GET' || target.method === 'HEAD' ? undefined : target.body,
                  signal: controller.signal,
              })
            : await fetch(target.url, {
                  method: target.method,
                  headers,
                  body: target.method === 'GET' || target.method === 'HEAD' ? undefined : target.body,
                  redirect: 'manual',
                  signal: controller.signal,
              });

        const picked = {};
        for (const key of DIAG_HEADER_KEYS) {
            const value = response.headers.get(key);
            if (value) picked[key] = value;
        }

        let snippet = '';
        try {
            snippet = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 240);
        } catch {
            /* gövde okunamadıysa önemli değil */
        }

        return { ok: response.status < 400, status: response.status, headers: picked, snippet };
    } catch (err) {
        return { ok: false, error: err?.name === 'AbortError' ? 'timeout' : err?.message || String(err) };
    } finally {
        clearTimeout(timer);
    }
}

async function diagEgressIp(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        const response = isRelayEnabled()
            ? await relayFetch(url, { method: 'GET', headers: {}, signal: controller.signal })
            : await fetch(url, { signal: controller.signal });
        const data = await response.json().catch(() => null);
        return data?.ip || null;
    } catch (err) {
        return err?.name === 'AbortError' ? 'timeout' : 'unavailable';
    } finally {
        clearTimeout(timer);
    }
}

// Relay Worker'ın kendi teşhisini (hangi yürütme yolu + hangi çıkış bölgesi)
// Render'dan sorar; böylece engelin nedenini kesin görürüz.
async function diagRelayProbe() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const response = await fetch(`${relayInfo().url}/?diag=1`, { signal: controller.signal });
        return await response.json();
    } catch (err) {
        return { error: err?.name === 'AbortError' ? 'timeout' : err?.message || String(err) };
    } finally {
        clearTimeout(timer);
    }
}

app.get('/api/diag', async (req, res) => {
    const [egressV4, egressV6] = await Promise.all([
        diagEgressIp('https://api.ipify.org?format=json'),
        diagEgressIp('https://api64.ipify.org?format=json'),
    ]);

    const results = [];
    for (const target of DIAG_TARGETS) {
        results.push({ name: target.name, ...(await diagProbe(target)) });
    }

    const relayProbe = isRelayEnabled() ? await diagRelayProbe() : null;

    res.json({
        when: new Date().toISOString(),
        relay: relayInfo(),
        relayProbe,
        egress: { ipv4: egressV4, ipv6: egressV6 },
        results,
    });
});

app.get('/api/search', async (req, res) => {
    const sourceId = typeof req.query.source === 'string' ? req.query.source : '';
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';

    if (!sourceId) return res.status(400).json({ error: 'Kaynak belirtilmedi.' });
    if (query.length < 2) return res.status(400).json({ error: 'En az 2 karakterlik bir arama girin.' });

    try {
        const source = getSource(sourceId);
        const result = await source.search(query);
        res.json({
            source: source.id,
            sourceLabel: source.label,
            query,
            results: result.results || [],
            note: result.note || null,
        });
    } catch (err) {
        sendApiError(res, err, 'Arama yapılamadı.');
    }
});

app.get('/api/details', async (req, res) => {
    const sourceId = typeof req.query.source === 'string' ? req.query.source : '';
    if (!sourceId) return res.status(400).json({ error: 'Kaynak belirtilmedi.' });

    try {
        const source = getSource(sourceId);
        const details = await source.details({
            id: req.query.id,
            url: req.query.url,
            slug: req.query.slug,
            type: req.query.type,
        });
        res.json(details);
    } catch (err) {
        sendApiError(res, err, 'İçerik bilgileri alınamadı.');
    }
});

app.post('/api/play', async (req, res) => {
    const body = req.body || {};
    let descriptor = body.descriptor;

    if (!descriptor || typeof descriptor !== 'object') {
        const { source, ...rest } = body;
        descriptor = {
            kind: source || rest.kind,
            ...rest,
        };
    }

    try {
        const result = await resolveDescriptor(descriptor);
        console.log(`[Play] ${descriptor.kind} -> ${result.url} (${result.source})`);
        res.json(result);
    } catch (err) {
        sendApiError(res, err, 'Video oynatma adresi alınamadı.');
    }
});


// --- ODA DURUMU YÖNETİMİ ---
const roomState = new Map();

function createRoomState(hostSocketId) {
    return {
        hostSocketId,
        videoUrl: null,
        videoType: null,
        referer: null,
        title: null,
        descriptor: null,
        resolvedAt: 0,
        resolving: null,
        isPlaying: false,
        currentTime: 0,
        lastUpdateTimestamp: Date.now()
    };
}

// İmzalı oynatma adresleri süreli oluyor. Geç katılan izleyiciye
// bayatlamış bir URL göndermek yerine seçimi yeniden çözümle.
const RESOLVE_MAX_AGE_MS = 3.5 * 60_000;

async function refreshRoomVideo(state) {
    if (!state?.descriptor) return false;
    if (state.videoUrl && Date.now() - state.resolvedAt < RESOLVE_MAX_AGE_MS) return false;

    if (!state.resolving) {
        state.resolving = (async () => {
            try {
                const result = await resolveDescriptor(state.descriptor);
                state.videoUrl = result.url;
                state.videoType = result.type || null;
                state.referer = result.referer || null;
                state.title = result.title || state.title;
                state.resolvedAt = Date.now();
            } catch (err) {
                console.error('[Room] Oynatma adresi yenilenemedi:', err.message);
            }
        })();
    }

    try {
        await state.resolving;
    } finally {
        state.resolving = null;
    }

    return true;
}

function broadcastHostStatus(channelId) {
    const state = roomState.get(channelId);
    if (!state) return;
    const room = io.sockets.adapter.rooms.get(channelId);
    if (!room) return;
    for (const socketId of room) {
        io.to(socketId).emit('hostStatus', socketId === state.hostSocketId);
    }
}

function getEstimatedCurrentTime(state) {
    if (!state || !state.isPlaying) return state ? state.currentTime : 0;
    const elapsed = (Date.now() - state.lastUpdateTimestamp) / 1000;
    return state.currentTime + elapsed;
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
    const userChannels = new Set();

    socket.on('joinRoom', async (channelId) => {
        if (typeof channelId !== 'string' || !channelId) return;

        socket.join(channelId);
        userChannels.add(channelId);
        let state = roomState.get(channelId);

        if (!state) {
            state = createRoomState(socket.id);
            roomState.set(channelId, state);
        } else {
            await refreshRoomVideo(state);

            // Yenileme sırasında oda silinmiş olabilir.
            if (roomState.get(channelId) !== state) return;

            const estimatedTime = getEstimatedCurrentTime(state);
            socket.emit('onSyncState', {
                videoUrl: state.videoUrl,
                videoType: state.videoType,
                referer: state.referer,
                currentTime: estimatedTime,
                isPlaying: state.isPlaying,
                title: state.title,
                descriptor: state.descriptor
            });
        }
        broadcastHostStatus(channelId);
    });

    socket.on('videoLoad', ({ channelId, url, referer, type, descriptor, title }) => {
        if (typeof channelId !== 'string' || typeof url !== 'string' || !url) return;

        const state = roomState.get(channelId);
        if (!state || state.hostSocketId !== socket.id) return;

        state.videoUrl = url;
        state.videoType = type || null;
        state.referer = referer || null;
        state.title = title || descriptor?.title || null;
        state.descriptor = descriptor && typeof descriptor === 'object' ? descriptor : null;
        state.resolvedAt = Date.now();
        state.currentTime = 0;
        state.isPlaying = true;
        state.lastUpdateTimestamp = Date.now();

        io.to(channelId).emit('onVideoLoad', {
            url,
            referer: state.referer,
            type: state.videoType,
            title: state.title,
            descriptor: state.descriptor
        });
    });

    socket.on('videoState', ({ channelId, action, currentTime }) => {
        const state = roomState.get(channelId);
        if (!state || state.hostSocketId !== socket.id) return;

        state.currentTime = currentTime;
        state.lastUpdateTimestamp = Date.now();
        if (action === 'play') state.isPlaying = true;
        else if (action === 'pause') state.isPlaying = false;

        socket.to(channelId).emit('onVideoStateChange', { action, currentTime });
    });

    socket.on('heartbeat', ({ channelId, currentTime, isPlaying }) => {
        const state = roomState.get(channelId);
        if (!state || state.hostSocketId !== socket.id) return;
        state.currentTime = currentTime;
        state.isPlaying = isPlaying;
        state.lastUpdateTimestamp = Date.now();

        socket.to(channelId).emit('onHeartbeat', { currentTime, isPlaying });
    });

    socket.on('disconnect', () => {
        for (const channelId of userChannels) {
            const state = roomState.get(channelId);
            if (!state) continue;

            const room = io.sockets.adapter.rooms.get(channelId);
            if (!room || room.size === 0) {
                roomState.delete(channelId);
                continue;
            }

            if (state.hostSocketId === socket.id) {
                const nextHostId = room.values().next().value;
                state.hostSocketId = nextHostId;
                broadcastHostStatus(channelId);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Sunucu ve Soket ${PORT} portunda aktif!`));