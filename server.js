import express from 'express';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Server } from 'socket.io';
import { buildProxyHeaders, assertSafeUrl } from './server/net.js';
import { resolveVideoUrl, ResolveError } from './server/resolve.js';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Vite build çıktılarını statik olarak sun
app.use(express.static('dist'));

// ============================================================
// SAYDAM (TRANSPARENT) PROXY KÖPRÜSÜ
// Diski doldurmaz. Tarayıcının 'Range' isteklerini doğrudan kaynağa yollar.
// ============================================================
function proxyRequest(targetUrl, reqHeaders, res, referer = null, maxRedirects = 5) {
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


// --- ODA DURUMU YÖNETİMİ ---
const roomState = new Map();

function createRoomState(hostSocketId) {
    return {
        hostSocketId,
        videoUrl: null,
        videoType: null,
        referer: null,
        isPlaying: false,
        currentTime: 0,
        lastUpdateTimestamp: Date.now()
    };
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

    socket.on('joinRoom', (channelId) => {
        socket.join(channelId);
        userChannels.add(channelId);
        let state = roomState.get(channelId);

        if (!state) {
            state = createRoomState(socket.id);
            roomState.set(channelId, state);
        } else {
            const estimatedTime = getEstimatedCurrentTime(state);
            socket.emit('onSyncState', {
                videoUrl: state.videoUrl,
                videoType: state.videoType,
                referer: state.referer,
                currentTime: estimatedTime,
                isPlaying: state.isPlaying
            });
        }
        broadcastHostStatus(channelId);
    });

    socket.on('videoLoad', ({ channelId, url, referer, type }) => {
        const state = roomState.get(channelId);
        if (!state || state.hostSocketId !== socket.id) return;

        state.videoUrl = url;
        state.videoType = type || null;
        state.referer = referer || null;
        state.currentTime = 0;
        state.isPlaying = true;
        state.lastUpdateTimestamp = Date.now();
        io.to(channelId).emit('onVideoLoad', { url, referer: state.referer, type: state.videoType });
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