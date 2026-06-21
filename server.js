import express from 'express';
import http from 'http';
import https from 'https';
import { URL } from 'url';
import { Server } from 'socket.io';

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
function proxyRequest(targetUrl, reqHeaders, res, maxRedirects = 5) {
    const parsedUrl = new URL(targetUrl);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
            'Accept': '*/*',
            'Connection': 'keep-alive',
            'Referer': 'https://pixeldrain.com/'
        }
    };

    // Tarayıcıdan gelen 'Range' isteğini (İleri/geri sarma veya dosya sonu okuma) hedefe aynen ilet
    if (reqHeaders.range) {
        options.headers['Range'] = reqHeaders.range;
    }

    const proxyReq = protocol.get(targetUrl, options, (proxyRes) => {
        // Yönlendirme (Redirect) takibi
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location && maxRedirects > 0) {
            let nextUrl = proxyRes.headers.location;
            if (!nextUrl.startsWith('http')) {
                nextUrl = new URL(nextUrl, targetUrl).href;
            }
            proxyReq.destroy();
            proxyRequest(nextUrl, reqHeaders, res, maxRedirects - 1);
        } else {
            // Hedef sunucudan gelen header'ları temizleyip bizim tarayıcıya aktar
            const safeHeaders = {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                'Access-Control-Allow-Origin': '*'
            };

            if (proxyRes.headers['content-length']) safeHeaders['Content-Length'] = proxyRes.headers['content-length'];
            if (proxyRes.headers['content-range']) safeHeaders['Content-Range'] = proxyRes.headers['content-range'];
            if (proxyRes.headers['accept-ranges']) safeHeaders['Accept-Ranges'] = proxyRes.headers['accept-ranges'];

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
    const url = req.query.url;
    if (!url) return res.status(400).send("URL belirtilmedi.");
    proxyRequest(url, req.headers, res);
});


// --- ODA DURUMU YÖNETİMİ ---
const roomState = new Map();

function createRoomState(hostSocketId) {
    return { hostSocketId, videoUrl: null, isPlaying: false, currentTime: 0, lastUpdateTimestamp: Date.now() };
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
            socket.emit('onSyncState', { videoUrl: state.videoUrl, currentTime: estimatedTime, isPlaying: state.isPlaying });
        }
        broadcastHostStatus(channelId);
    });

    socket.on('videoLoad', ({ channelId, url }) => {
        const state = roomState.get(channelId);
        if (!state || state.hostSocketId !== socket.id) return;

        state.videoUrl = url;
        state.currentTime = 0;
        state.isPlaying = true;
        state.lastUpdateTimestamp = Date.now();
        io.to(channelId).emit('onVideoLoad', { url });
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

server.listen(3000, () => console.log('Sunucu ve Soket 3000 portunda aktif!'));