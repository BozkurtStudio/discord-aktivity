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
const viewerProgressContainer = document.getElementById('viewer-progress-container');
const viewerProgressBar = document.getElementById('viewer-progress-bar');
const viewerTime = document.getElementById('viewer-time');

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

  // 1.3 saniye hareketsizlik sonrası, eğer video oynuyorsa arayüzü gizle
  idleTimeout = setTimeout(() => {
    if (!videoPlayer.paused) {
      appContainer.classList.add('idle');
    }
  }, 1300);
}

// Fare hareketi veya tuşa basıldığında sayacı sıfırla
window.addEventListener('mousemove', resetIdleTimer);
window.addEventListener('mousedown', resetIdleTimer);
window.addEventListener('keydown', resetIdleTimer);

// --- DISCORD SDK KURULUMU ---
async function setupDiscordSdk() {
  await discordSdk.ready();
  currentChannelId = discordSdk.channelId;
  console.log("[SDK] Discord SDK hazır, channelId:", currentChannelId);

  // Group DM'de guildId null olur - bunu handle etmek gerekiyor
  const isGDM = discordSdk.guildId === null;

  // Odaya katıl (socket hazırsa hemen, değilse bağlanınca)
  joinRoomWhenReady();

  // Authorize'da GDM için doğru scope'ları gönder
  const { code } = await discordSdk.commands.authorize({
    client_id: "1518311302097797233",
    response_type: "code",
    state: "",
    prompt: "none",
    scope: [
      "identify",
      "guilds",
      "applications.commands",
    ].filter(scope => {
      if (scope === "guilds" && isGDM) return false;
      return true;
    }),
  });
}

// Socket hazır olduğunda odaya katıl
function joinRoomWhenReady() {
  if (!currentChannelId) return;

  if (socket.connected) {
    console.log("[Socket] Odaya katılınıyor:", currentChannelId);
    socket.emit('joinRoom', currentChannelId);
  } else {
    console.log("[Socket] Bağlantı bekleniyor...");
    // Socket henüz bağlanmadıysa, bağlandığında otomatik katıl
    socket.once('connect', () => {
      console.log("[Socket] Bağlantı kuruldu, odaya katılınıyor:", currentChannelId);
      socket.emit('joinRoom', currentChannelId);
    });
  }
}

// Socket.io yeniden bağlantı kurduğunda odaya tekrar katıl
// (İnternet kesintisi, uyku modu vb. durumlardan sonra)
socket.on('connect', () => {
  if (currentChannelId) {
    console.log("[Socket] Yeniden bağlandı, odaya tekrar katılınıyor...");
    socket.emit('joinRoom', currentChannelId);
  }
});

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

  // Güvenli Oynatma Denemesi:
  // 1) Önce sesli dene
  // 2) Tarayıcı engellerse → sessiz (muted) başlat + overlay göster
  // 3) O da olmazsa → overlay göster, kullanıcı tıklasın
  const attemptPlay = () => {
    if (!shouldPlay) return;

    videoPlayer.muted = false;
    videoPlayer.play().then(() => {
      // Sesli oynatma başarılı
      hideAutoplayOverlay();
    }).catch(() => {
      // Sesli engellendi → sessiz dene (en azından görüntü gelsin)
      videoPlayer.muted = true;
      videoPlayer.play().then(() => {
        // Sessiz oynatma başarılı, kullanıcıya sesi açması için overlay göster
        showAutoplayOverlay();
      }).catch(e2 => {
        // Her şey engellendi — kullanıcı tıklamalı
        console.warn("Tamamen engellendi:", e2.message);
        showAutoplayOverlay();
      });
    });
  };

  // Ortak "video hazır" callback'i
  const onVideoReady = () => {
    videoPlayer.currentTime = startTime;
    attemptPlay();
  };

  if (isHls) {
    // HLS Proxy (M3U8)
    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: function (xhr, url) {
          const proxiedUrl = `/proxy/stream?url=${encodeURIComponent(url)}`;
          xhr.open('GET', proxiedUrl, true);
        }
      });
      currentHls = hls;
      hls.loadSource(originalUrl);
      hls.attachMedia(videoPlayer);
      hls.on(Hls.Events.MANIFEST_PARSED, onVideoReady);
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.error("HLS Hatası:", data);
        if (data.fatal) {
          // Fatal hatalarda HLS'yi yeniden başlatmayı dene
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            console.log("Ağ hatası, yeniden deneniyor...");
            hls.startLoad();
          } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            console.log("Medya hatası, kurtarılıyor...");
            hls.recoverMediaError();
          }
        }
      });
    } else if (videoPlayer.canPlayType('application/vnd.apple.mpegurl')) {
      videoPlayer.src = proxyUrl;
      videoPlayer.addEventListener('canplay', function onReady() {
        videoPlayer.removeEventListener('canplay', onReady);
        onVideoReady();
      });
    }
  } else {
    // MP4/WebM vb.
    videoPlayer.src = proxyUrl;

    // canplay: Video oynatılabilecek kadar buffer doldu
    videoPlayer.addEventListener('canplay', function onReady() {
      videoPlayer.removeEventListener('canplay', onReady);
      onVideoReady();
    });

    // Güvenlik ağı: 8 saniye içinde canplay gelmezse yine de dene
    setTimeout(() => {
      if (videoPlayer.readyState < 3 && videoPlayer.src) {
        console.warn("canplay zaman aşımı, zorla deneniyor...");
        onVideoReady();
      }
    }, 8000);

    videoPlayer.onerror = () => {
      const err = videoPlayer.error;
      console.error(`Video yükleme hatası: code=${err ? err.code : '?'}, message=${err ? err.message : '?'}`);
    };
  }
}

// --- OVERLAY ETKİLEŞİMLERİ ---

// Autoplay overlay gösterildiğinde spinner'ı gizle (üst üste binmesin)
function showAutoplayOverlay() {
  bufferingOverlay.classList.add('hidden');
  autoplayOverlay.classList.remove('hidden');
}

function hideAutoplayOverlay() {
  autoplayOverlay.classList.add('hidden');
}

// "Videoya Katıl" butonuna tıklama
forcePlayBtn.addEventListener('click', () => {
  hideAutoplayOverlay();
  videoPlayer.muted = false;
  videoPlayer.play().catch(e => console.error("Oynatma başarısız:", e));
});

// Ekranın herhangi bir yerine tıklayınca da videoyu başlat
// (Bazı kullanıcılar butonu göremeyebilir veya mobilde olabilir)
videoPlayer.addEventListener('click', () => {
  if (!autoplayOverlay.classList.contains('hidden')) {
    hideAutoplayOverlay();
    videoPlayer.muted = false;
    videoPlayer.play().catch(e => console.error("Oynatma başarısız:", e));
  }
});

videoPlayer.addEventListener('waiting', () => {
  if (isHost) return;
  // Autoplay overlay açıksa spinner gösterme (üst üste binmesin)
  if (!autoplayOverlay.classList.contains('hidden')) return;
  bufferingOverlay.classList.remove('hidden');
});

videoPlayer.addEventListener('playing', () => {
  bufferingOverlay.classList.add('hidden');
  hideAutoplayOverlay();
});

// --- İZLEYİCİ PROGRESS BAR YÖNETİMİ ---
function formatTime(seconds) {
  if (isNaN(seconds) || !isFinite(seconds)) return "00:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

videoPlayer.addEventListener('timeupdate', () => {
  // Sadece izleyicilere gösterilecek, Host'un kendi çubuğu var
  if (isHost || !videoPlayer.duration) return;

  if (viewerProgressContainer.classList.contains('hidden')) {
    viewerProgressContainer.classList.remove('hidden');
  }

  const percent = (videoPlayer.currentTime / videoPlayer.duration) * 100;
  viewerProgressBar.style.width = `${percent}%`;
  viewerTime.textContent = `${formatTime(videoPlayer.currentTime)} / ${formatTime(videoPlayer.duration)}`;
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
    statusLabel.textContent = '🎬Host — videoyu kontrol edebilirsin';
    statusLabel.className = 'status-label host';
    videoPlayer.controls = true;
  } else {
    hostPanel.classList.add('hidden');
    statusLabel.textContent = '👁 İzleyici — Video başlamadıysa ekrana 1-2 kez tıkla';
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
        if (e.name === 'NotAllowedError') showAutoplayOverlay();
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
      if (e.name === 'NotAllowedError') showAutoplayOverlay();
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