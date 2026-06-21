import { DiscordSDK } from "@discord/embedded-app-sdk";
import { io } from "socket.io-client";
import Hls from "hls.js";

// Developer Portal'dan aldığın Client ID
const discordSdk = new DiscordSDK("1518311302097797233");
const socket = io();

const appContainer = document.getElementById('app');
const videoPlayer = document.getElementById('video-player');
const videoUrlInput = document.getElementById('video-url');
const playBtn = document.getElementById('play-btn');
const hostPanel = document.getElementById('host-panel');
const statusLabel = document.getElementById('status-label');
const bufferingOverlay = document.getElementById('buffering-overlay');
const autoplayOverlay = document.getElementById('autoplay-overlay');
const forcePlayBtn = document.getElementById('force-play-btn');

let currentChannelId = null;
let isHost = false;
let isSyncing = false;
let syncCounter = 0;
let currentHls = null;
let heartbeatInterval = null;

// --- IDLE (BOŞTA) ARAYÜZ GİZLEME MANTIĞI ---
let idleTimeout = null;

function resetIdleTimer() {
  appContainer.classList.remove('idle');
  clearTimeout(idleTimeout);
  
  // 2.5 saniye hareketsizlik sonrası, eğer video oynuyorsa arayüzü gizle
  idleTimeout = setTimeout(() => {
    if (!videoPlayer.paused) {
      appContainer.classList.add('idle');
    }
  }, 2500);
}

// Fare hareketi veya tuşa basıldığında sayacı sıfırla
window.addEventListener('mousemove', resetIdleTimer);
window.addEventListener('mousedown', resetIdleTimer);
window.addEventListener('keydown', resetIdleTimer);

// --- DISCORD SDK KURULUMU ---
async function setupDiscordSdk() {
  await discordSdk.ready();
  currentChannelId = discordSdk.channelId;

  if (currentChannelId) {
    socket.emit('joinRoom', currentChannelId);
  }
}

// --- VIDEO YÜKLEME ---
// Tüm videolar kendi backend proxy'miz üzerinden yüklenir
function loadAndPlayVideo(originalUrl, startTime = 0, shouldPlay = true) {
  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }

  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.load();

  const proxyUrl = `/proxy/stream?url=${encodeURIComponent(originalUrl)}`;
  const isHls = originalUrl.includes('.m3u8');

  // Ortak Oynatma Denemesi (Autoplay kontrolü)
  const attemptPlay = () => {
    if (!shouldPlay) return;
    videoPlayer.play().catch(e => {
      console.warn("Otomatik oynatma engellendi:", e.message);
      if (e.name === 'NotAllowedError') {
        autoplayOverlay.classList.remove('hidden');
      }
    });
  };

  if (isHls) {
    // HLS Proxy
    if (Hls.isSupported()) {
      const hls = new Hls();
      currentHls = hls;
      hls.loadSource(proxyUrl);
      hls.attachMedia(videoPlayer);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        videoPlayer.currentTime = startTime;
        attemptPlay();
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error("HLS Hatası:", data);
      });
    } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      videoPlayer.src = proxyUrl;
      videoPlayer.addEventListener('loadedmetadata', function onLoaded() {
        videoPlayer.removeEventListener('loadedmetadata', onLoaded);
        videoPlayer.currentTime = startTime;
        attemptPlay();
      });
    }
  } else {
    // MP4/WebM vb.
    videoPlayer.src = proxyUrl;
    videoPlayer.addEventListener('loadedmetadata', function onLoaded() {
      videoPlayer.removeEventListener('loadedmetadata', onLoaded);
      videoPlayer.currentTime = startTime;
      attemptPlay();
    });

    videoPlayer.onerror = () => {
      const err = videoPlayer.error;
      console.error(`Video yükleme hatası: code=${err ? err.code : '?'}, message=${err ? err.message : '?'}`);
    };
  }
}

// --- OVERLAY ETKİLEŞİMLERİ ---
forcePlayBtn.addEventListener('click', () => {
  autoplayOverlay.classList.add('hidden');
  videoPlayer.play().catch(e => console.error("Oynatma başarısız:", e));
});

videoPlayer.addEventListener('waiting', () => {
  if (isHost) return; // Host kullanıcıda özel buffer gösterme
  bufferingOverlay.classList.remove('hidden');
});

videoPlayer.addEventListener('playing', () => {
  bufferingOverlay.classList.add('hidden');
});

// --- isSyncing KİLİT MEKANİZMASI ---
function startSync() {
  syncCounter++;
  isSyncing = true;
}

function endSync() {
  syncCounter--;
  if (syncCounter <= 0) {
    syncCounter = 0;
    requestAnimationFrame(() => {
      if (syncCounter === 0) isSyncing = false;
    });
  }
}

function seekAndWait(time) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      videoPlayer.removeEventListener('seeked', onSeeked);
      resolve();
    };
    videoPlayer.addEventListener('seeked', onSeeked);
    videoPlayer.currentTime = time;
    setTimeout(() => {
      videoPlayer.removeEventListener('seeked', onSeeked);
      resolve();
    }, 500);
  });
}

// --- UI ---
function updateUI() {
  if (isHost) {
    hostPanel.classList.remove('hidden');
    statusLabel.textContent = '🎬 Sen Host\'sun — videoyu kontrol edebilirsin';
    statusLabel.className = 'status-label host';
    videoPlayer.controls = true;
  } else {
    hostPanel.classList.add('hidden');
    statusLabel.textContent = '👁 İzleyici modu — sadece host videoyu kontrol edebilir';
    statusLabel.className = 'status-label viewer';
    videoPlayer.controls = false;
  }
}

// --- HEARTBEAT ---
function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (isHost && currentChannelId && !videoPlayer.paused) {
      socket.emit('heartbeat', {
        channelId: currentChannelId,
        currentTime: videoPlayer.currentTime,
        isPlaying: !videoPlayer.paused
      });
    }
  }, 5000);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

// =============================================
// 1. KULLANICI ETKİLEŞİMLERİ
// =============================================

playBtn.addEventListener('click', () => {
  if (!isHost) return;
  const url = videoUrlInput.value.trim();
  if (!url) return alert("Lütfen bir video URL'si girin!");

  socket.emit('videoLoad', { channelId: currentChannelId, url });
});

videoPlayer.addEventListener('play', () => {
  resetIdleTimer();
  if (isSyncing || !isHost) return;
  socket.emit('videoState', {
    channelId: currentChannelId,
    action: 'play',
    currentTime: videoPlayer.currentTime
  });
});

videoPlayer.addEventListener('pause', () => {
  resetIdleTimer();
  if (isSyncing || !isHost) return;
  socket.emit('videoState', {
    channelId: currentChannelId,
    action: 'pause',
    currentTime: videoPlayer.currentTime
  });
});

videoPlayer.addEventListener('seeked', () => {
  if (isSyncing || !isHost) return;
  socket.emit('videoState', {
    channelId: currentChannelId,
    action: 'seek',
    currentTime: videoPlayer.currentTime
  });
});

// =============================================
// 2. SUNUCUDAN GELEN KOMUTLAR
// =============================================

socket.on('hostStatus', (status) => {
  isHost = status;
  updateUI();
  if (isHost) startHeartbeat();
  else stopHeartbeat();
});

socket.on('onVideoLoad', (data) => {
  startSync();
  loadAndPlayVideo(data.url);
  setTimeout(() => endSync(), 1500);
});

socket.on('onSyncState', (data) => {
  if (data.videoUrl) {
    startSync();
    loadAndPlayVideo(data.videoUrl, data.currentTime, data.isPlaying);
    setTimeout(() => endSync(), 1500);
  }
});

socket.on('onVideoStateChange', async (data) => {
  startSync();
  if (data.action === 'seek') {
    await seekAndWait(data.currentTime);
  } else {
    videoPlayer.currentTime = data.currentTime;
    if (data.action === 'play') {
      await videoPlayer.play().catch(e => {
        if (e.name === 'NotAllowedError') autoplayOverlay.classList.remove('hidden');
      });
    } else if (data.action === 'pause') {
      videoPlayer.pause();
    }
  }
  setTimeout(() => endSync(), 300);
});

socket.on('onHeartbeat', (data) => {
  if (isHost) return;

  const diff = Math.abs(videoPlayer.currentTime - data.currentTime);
  if (diff > 2) {
    startSync();
    videoPlayer.currentTime = data.currentTime;
    setTimeout(() => endSync(), 300);
  }

  if (data.isPlaying && videoPlayer.paused) {
    startSync();
    videoPlayer.play().catch(e => {
      if (e.name === 'NotAllowedError') autoplayOverlay.classList.remove('hidden');
    });
    setTimeout(() => endSync(), 300);
  } else if (!data.isPlaying && !videoPlayer.paused) {
    startSync();
    videoPlayer.pause();
    setTimeout(() => endSync(), 300);
  }
});

// --- BAŞLAT ---
setupDiscordSdk();