import { DiscordSDK } from "@discord/embedded-app-sdk";
import { io } from "socket.io-client";
import Hls from "hls.js";

// Yükleme sırasında oluşan hataları ekranda görünür kıl (test/hata ayıklama için)
window.__appBooted = true;
function showBootError(message) {
  const label = document.getElementById('status-label');
  if (!label) return;
  label.textContent = `❌ ${message}`;
  label.className = 'status-label error';
}
window.addEventListener('error', event => {
  showBootError(event?.message || 'Bilinmeyen hata');
});
window.addEventListener('unhandledrejection', event => {
  const reason = event?.reason;
  showBootError(reason?.message || String(reason || 'Bilinmeyen hata'));
});

// Developer Portal'dan aldığın Client ID. Kendi Discord uygulamanı
// kullanmak için proje köküne bir .env dosyası koy:
//   VITE_DISCORD_CLIENT_ID=1234567890
// (npm run host bunu otomatik kullanır.)
const DISCORD_CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID || "1518311302097797233";

// DiscordSDK yalnızca gerçek Discord iframe'i içinde oluşturulabilir; aksi
// halde yapıcı fonksiyon "frame_id query param is not defined" hatası atıp
// tüm betiği durduruyor. Düz tarayıcıda SDK'yı hiç oluşturmuyoruz.
const isEmbedded = window.parent !== window;
const hasFrameId = new URLSearchParams(location.search).has('frame_id');
const discordSdk = isEmbedded && hasFrameId ? new DiscordSDK(DISCORD_CLIENT_ID) : null;

const socket = io();

const appContainer = document.getElementById('app');
const videoPlayer = document.getElementById('video-player');
const videoUrlInput = document.getElementById('video-url');
const playBtn = document.getElementById('play-btn');
const hostPanel = document.getElementById('host-panel');
const statusLabel = document.getElementById('status-label');
const bufferingOverlay = document.getElementById('buffering-overlay');
const unmuteBtn = document.getElementById('unmute-btn');
const viewerProgressContainer = document.getElementById('viewer-progress-container');
const viewerProgressBar = document.getElementById('viewer-progress-bar');
const viewerTime = document.getElementById('viewer-time');

// Kütüphane
const libraryBtn = document.getElementById('library-btn');
const libraryOverlay = document.getElementById('library-overlay');
const libraryCloseBtn = document.getElementById('library-close');
const sourceTabs = document.getElementById('source-tabs');
const searchForm = document.getElementById('search-form');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const searchStatus = document.getElementById('search-status');
const resultsPanel = document.getElementById('results-panel');
const resultsGrid = document.getElementById('results-grid');
const detailsPanel = document.getElementById('details-panel');
const detailsBackBtn = document.getElementById('details-back');
const detailsPoster = document.getElementById('details-poster');
const detailsTitle = document.getElementById('details-title');
const detailsMeta = document.getElementById('details-meta');
const detailsDescription = document.getElementById('details-description');
const playerTypesEl = document.getElementById('player-types');
const seasonTabsEl = document.getElementById('season-tabs');
const episodeGridEl = document.getElementById('episode-grid');
const sourceGridEl = document.getElementById('source-grid');
const detailsMessage = document.getElementById('details-message');
const detailsPlayBtn = document.getElementById('details-play-btn');
const selectionLabel = document.getElementById('selection-label');
const nowPlayingEl = document.getElementById('now-playing');

let currentChannelId = null;
let isHost = false;
let isSyncing = false;
let syncCounter = 0;
let currentHls = null;
let heartbeatInterval = null;
let currentLoadId = 0;
let currentVideoTitle = null;

// --- IDLE (BOŞTA) ARAYÜZ GİZLEME MANTIĞI ---
let idleTimeout = null;

function resetIdleTimer() {
  appContainer.classList.remove('idle');
  clearTimeout(idleTimeout);

  // 1.3 saniye hareketsizlik sonrası, eğer video oynuyorsa arayüzü gizle
  idleTimeout = setTimeout(() => {
    if (libraryOverlay && !libraryOverlay.classList.contains('hidden')) return;
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
// Discord dışında (düz tarayıcı / yerel test sunucusu) SDK hiç hazır olmaz.
// Bu durumda odaya katılabilmek için URL'den okunan bir kanal kimliğine düşeriz:
//   http://localhost:3100/?channel=test-kanal
// Aynı adresi açan sekmeler aynı odayı paylaşır; ilk katılan host olur.
const testChannelId = new URLSearchParams(location.search).get('channel') || 'test-kanal';

async function waitForDiscordReady(timeoutMs) {
  return Promise.race([
    discordSdk.ready(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Discord SDK zaman aşımına uğradı')), timeoutMs);
    }),
  ]);
}

async function setupDiscordSdk() {
  let inDiscord = false;

  if (discordSdk) {
    try {
      await waitForDiscordReady(4000);
      inDiscord = true;
    } catch (err) {
      console.warn('[SDK] Discord bağlantısı kurulamadı, test moduna geçiliyor:', err?.message || err);
    }
  } else {
    console.log('[SDK] Discord gömülü ortamı yok, test modu kullanılıyor.');
  }

  currentChannelId = (inDiscord && discordSdk?.channelId) || testChannelId;
  console.log("[SDK] channelId:", currentChannelId);

  // Odaya katıl (socket hazırsa hemen, değilse bağlanınca)
  joinRoomWhenReady();

  if (!inDiscord || !discordSdk) return;

  // Group DM'de guildId null olur - bunu handle etmek gerekiyor
  const isGDM = discordSdk.guildId === null;

  try {
    // Authorize'da GDM için doğru scope'ları gönder
    await discordSdk.commands.authorize({
      client_id: DISCORD_CLIENT_ID,
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
  } catch (err) {
    console.warn('[SDK] authorize başarısız oldu:', err?.message || err);
  }
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

// Socket bağlantı durumunu ekranda göster (hata ayıklamayı kolaylaştırır)
socket.on('connect', () => {
  setStatus('🔗 Sunucuya bağlandı, oda bekleniyor...', 'host');
  if (currentChannelId) {
    console.log("[Socket] Yeniden bağlandı, odaya tekrar katılınıyor...");
    socket.emit('joinRoom', currentChannelId);
  }
});

socket.on('connect_error', (err) => {
  setStatus(`❌ Sunucuya bağlanılamadı: ${err?.message || 'bilinmeyen hata'}`, 'error');
});

socket.on('disconnect', (reason) => {
  setStatus(`❌ Bağlantı koptu: ${reason}`, 'error');
});

// --- VIDEO YÜKLEME ---
// Tüm videolar kendi backend proxy'miz üzerinden yüklenir.
// referer: embed sayfasının adresi (bazı kaynaklar Referer olmadan 403 veriyor)
function loadAndPlayVideo(originalUrl, startTime = 0, shouldPlay = true, referer = null, type = null) {
  const loadId = ++currentLoadId;

  if (currentHls) {
    currentHls.destroy();
    currentHls = null;
  }

  videoPlayer.pause();
  videoPlayer.removeAttribute('src');
  videoPlayer.load();

  const isHls = type ? type === 'hls' : /\.m3u8(?:$|[?#])/i.test(originalUrl);
  const ref = referer || null;

  const proxied = (targetUrl) => {
    let url = `/proxy/stream?url=${encodeURIComponent(targetUrl)}`;
    if (ref) url += `&ref=${encodeURIComponent(ref)}`;
    return url;
  };

  const proxyUrl = proxied(originalUrl);

  // Güvenli Oynatma Denemesi:
  const attemptPlay = () => {
    if (!shouldPlay) return;

    videoPlayer.play().catch(e => {
      console.warn("Otomatik oynatma engellendi (Muted başlatılmasına rağmen):", e.message);
    });
  };

  // Ortak "video hazır" callback'i
  const onVideoReady = () => {
    if (loadId !== currentLoadId) return;
    videoPlayer.currentTime = startTime;
    attemptPlay();
  };

  if (isHls) {
    // HLS Proxy (M3U8)
    if (Hls.isSupported()) {
      const hls = new Hls({
        xhrSetup: function (xhr, url) {
          // data:/blob: adresleri (ör. gömülü anahtarlar) proxy'lenmemeli
          if (/^(?:data|blob):/i.test(url)) return;
          xhr.open('GET', proxied(url), true);
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
      // ÖNEMLİ: Apple (iOS/Mac Safari) cihazları M3U8 dosyalarını kendisi çözer (Native Player).
      // ProxyUrl verirsek .ts (video parçaları) yollarını şaşırır, 404 hatası alır ve 
      // siyah ekranda (sadece spinner dönerek) takılı kalır. Bu yüzden onlara orijinal URL veriyoruz.
      videoPlayer.src = originalUrl;
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
      if (loadId !== currentLoadId) return;
      if (videoPlayer.readyState < 3 && videoPlayer.src) {
        console.warn("canplay zaman aşımı, zorla deneniyor...");
        onVideoReady();
      }
    }, 8000);

    videoPlayer.onerror = () => {
      const err = videoPlayer.error;
      console.error(`Video yükleme hatası: code=${err ? err.code : '?'}, message=${err ? err.message : '?'}`);
      if (!isHost) {
        statusLabel.textContent = `❌ Hata: Video cihazınızda oynatılamadı (Codec/Ağ).`;
        statusLabel.style.backgroundColor = "#da373c";
        bufferingOverlay.classList.add('hidden');
      }
    };
  }
}

// --- OVERLAY ETKİLEŞİMLERİ ---

// --- OVERLAY ETKİLEŞİMLERİ ---

// İzleyiciler için ses açma butonu
unmuteBtn.addEventListener('click', () => {
  videoPlayer.muted = false;
  unmuteBtn.classList.add('hidden');
});

// Eğer kullanıcı bir şekilde sesi açarsa (veya sesli oynamaya izin verilmişse) butonu gizle
videoPlayer.addEventListener('volumechange', () => {
  if (!videoPlayer.muted) unmuteBtn.classList.add('hidden');
});

videoPlayer.addEventListener('waiting', () => {
  if (isHost) return;
  if (videoPlayer.paused) return; // Duraklatmada spinner gösterme
  bufferingOverlay.classList.remove('hidden');
});

videoPlayer.addEventListener('playing', () => {
  bufferingOverlay.classList.add('hidden');
});

videoPlayer.addEventListener('pause', () => {
  bufferingOverlay.classList.add('hidden');
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
function setStatus(text, kind = 'host') {
  statusLabel.textContent = text;
  statusLabel.className = `status-label ${kind}`;
  statusLabel.style.backgroundColor = '';
}

function updateUI() {
  if (isHost) {
    hostPanel.classList.remove('hidden');
    statusLabel.textContent = currentVideoTitle
      ? `🎬 ${currentVideoTitle}`
      : '🎬Host — videoyu kontrol edebilirsin';
    statusLabel.className = 'status-label host';
    videoPlayer.controls = true;
    videoPlayer.muted = false; // Host'un sesi her zaman açık başlar
    unmuteBtn.classList.add('hidden');
  } else {
    hostPanel.classList.add('hidden');
    statusLabel.textContent = currentVideoTitle
      ? `🎬 ${currentVideoTitle}`
      : '👁 İzleyici Modu';
    statusLabel.className = 'status-label viewer';
    videoPlayer.controls = false;
    if (videoPlayer.muted) unmuteBtn.classList.remove('hidden');
  }
}

// =============================================
// KÜTÜPHANE (kaynak arama / dizi-film seçimi)
// =============================================

const library = {
  sources: [],
  activeSourceId: null,
  results: [],
  details: null,
  playerType: null,
  season: null,
  episode: null,
  sourceIndex: null,
  searchSeq: 0,
  detailsSeq: 0,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function setNowPlaying(title) {
  currentVideoTitle = title || null;

  if (!title) {
    nowPlayingEl.classList.add('hidden');
    nowPlayingEl.replaceChildren();
    return;
  }

  nowPlayingEl.classList.remove('hidden');
  nowPlayingEl.replaceChildren(
    document.createTextNode('Şu an: '),
    el('strong', null, title)
  );

  if (!isHost) {
    statusLabel.textContent = `🎬 ${title}`;
    statusLabel.className = 'status-label viewer';
  }
}

function setSearchStatus(text, isError = false) {
  searchStatus.textContent = text;
  searchStatus.classList.toggle('error', isError);
}

function setDetailsMessage(text) {
  if (!text) {
    detailsMessage.classList.add('hidden');
    detailsMessage.textContent = '';
    return;
  }
  detailsMessage.classList.remove('hidden');
  detailsMessage.textContent = text;
}

async function loadSources() {
  if (library.sources.length > 0) return;

  setSearchStatus('Kaynaklar yükleniyor...');
  const response = await fetch('/api/sources');
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Kaynaklar yüklenemedi.');

  library.sources = data.sources || [];
  if (!library.activeSourceId) {
    library.activeSourceId = library.sources[0]?.id || null;
  }
  renderSourceTabs();
  setSearchStatus('Bir kaynak seçip arama yapın.');
}

function renderSourceTabs() {
  sourceTabs.replaceChildren();

  for (const source of library.sources) {
    const button = el('button', 'source-tab', source.label || source.id);
    button.type = 'button';
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(source.id === library.activeSourceId));
    if (source.id === library.activeSourceId) button.classList.add('active');

    button.addEventListener('click', () => {
      if (library.activeSourceId === source.id) return;
      library.activeSourceId = source.id;
      renderSourceTabs();
      resultsPanel.classList.remove('hidden');
      detailsPanel.classList.add('hidden');
      if (searchInput.value.trim().length >= 2) runSearch();
      else setSearchStatus(`${source.label} seçildi. Aramak için bir ad yazın.`);
    });

    sourceTabs.appendChild(button);
  }
}

async function openLibrary() {
  if (!isHost) return;

  appContainer.classList.remove('idle');
  libraryOverlay.classList.remove('hidden');

  try {
    await loadSources();
  } catch (err) {
    setSearchStatus(err.message, true);
  }

  searchInput.focus();
}

function closeLibrary() {
  libraryOverlay.classList.add('hidden');
  appContainer.classList.remove('idle');
}

function placeholderPoster() {
  return el('div', 'result-poster placeholder', '🎬');
}

function originOf(url) {
  try {
    return `${new URL(url).origin}/`;
  } catch {
    return null;
  }
}

// Afişler kaynak sitelerin CDN'lerinden geliyor. Aynı-köken proxy sayesinde
// hem Discord CSP'si hem de hotlink korumaları sorun çıkarmıyor.
function proxiedAsset(url, referer) {
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) return url;

  let proxied = `/proxy/stream?url=${encodeURIComponent(url)}`;
  if (referer) proxied += `&ref=${encodeURIComponent(referer)}`;
  return proxied;
}

function renderResults() {
  resultsGrid.replaceChildren();

  for (const result of library.results) {
    const card = el('button', 'result-card');
    card.type = 'button';

    if (result.poster) {
      const image = el('img', 'result-poster');
      image.src = proxiedAsset(result.poster, originOf(result.url));
      image.alt = '';
      image.loading = 'lazy';
      image.addEventListener('error', () => image.replaceWith(placeholderPoster()), { once: true });
      card.appendChild(image);
    } else {
      card.appendChild(placeholderPoster());
    }

    const body = el('div', 'result-body');
    body.appendChild(el('div', 'result-title', result.title || 'İsimsiz'));

    const meta = el('div', 'result-meta');
    meta.appendChild(el('span', 'type-badge', result.type === 'series' ? 'Dizi' : 'Film'));
    if (result.year) meta.appendChild(el('span', null, result.year));
    if (result.rating) meta.appendChild(el('span', 'rating-badge', `★ ${result.rating}`));
    body.appendChild(meta);

    card.appendChild(body);
    card.addEventListener('click', () => openDetails(result));
    resultsGrid.appendChild(card);
  }
}

async function runSearch() {
  const query = searchInput.value.trim();
  if (!library.activeSourceId) {
    setSearchStatus('Önce bir kaynak seçin.', true);
    return;
  }
  if (query.length < 2) {
    setSearchStatus('En az 2 karakterlik bir arama girin.', true);
    return;
  }

  const seq = ++library.searchSeq;
  searchBtn.disabled = true;
  resultsGrid.replaceChildren();
  setSearchStatus(`"${query}" aranıyor...`);

  try {
    const response = await fetch(
      `/api/search?source=${encodeURIComponent(library.activeSourceId)}&q=${encodeURIComponent(query)}`
    );
    const data = await response.json().catch(() => ({}));

    if (seq !== library.searchSeq) return;
    if (!response.ok) throw new Error(data.error || 'Arama başarısız oldu.');

    library.results = data.results || [];
    renderResults();

    if (library.results.length === 0) {
      setSearchStatus(`"${query}" için sonuç bulunamadı.`);
    } else {
      setSearchStatus(`${library.results.length} sonuç bulundu.`);
    }
  } catch (err) {
    if (seq !== library.searchSeq) return;
    library.results = [];
    resultsGrid.replaceChildren();
    setSearchStatus(err.message, true);
  } finally {
    if (seq === library.searchSeq) searchBtn.disabled = false;
  }
}

function resetDetailsControls() {
  library.playerType = null;
  library.season = null;
  library.episode = null;
  library.sourceIndex = null;
  playerTypesEl.replaceChildren();
  seasonTabsEl.replaceChildren();
  episodeGridEl.replaceChildren();
  sourceGridEl.replaceChildren();
  detailsPlayBtn.disabled = true;
  selectionLabel.textContent = 'Yükleniyor...';
}

async function openDetails(result) {
  const seq = ++library.detailsSeq;

  resultsPanel.classList.add('hidden');
  detailsPanel.classList.remove('hidden');
  detailsPanel.scrollTop = 0;

  detailsTitle.textContent = result.title || 'Yükleniyor...';
  detailsMeta.replaceChildren();
  detailsDescription.textContent = '';
  detailsPoster.removeAttribute('src');
  detailsPoster.style.visibility = 'hidden';
  setDetailsMessage(null);
  resetDetailsControls();

  try {
    const params = new URLSearchParams({
      source: result.source,
      url: result.url || '',
      type: result.type || '',
    });
    const response = await fetch(`/api/details?${params.toString()}`);
    const data = await response.json().catch(() => ({}));

    if (seq !== library.detailsSeq) return;
    if (!response.ok) throw new Error(data.error || 'İçerik bilgileri alınamadı.');

    library.details = data;
    renderDetails();
  } catch (err) {
    if (seq !== library.detailsSeq) return;
    detailsDescription.textContent = err.message;
    selectionLabel.textContent = 'İçerik yüklenemedi';
    setDetailsMessage(err.message);
  }
}

function renderChipRow(container, items, activeValue, onSelect, valueKey = 'id', labelKey = 'label') {
  container.replaceChildren();

  for (const item of items) {
    const value = item[valueKey];
    const button = el('button', 'chip', item[labelKey] || String(value));
    button.type = 'button';
    if (String(value) === String(activeValue)) button.classList.add('active');
    button.addEventListener('click', () => onSelect(value));
    container.appendChild(button);
  }
}

function renderDetails() {
  const details = library.details;
  if (!details) return;

  if (details.poster) {
    detailsPoster.style.visibility = 'visible';
    detailsPoster.onerror = () => {
      detailsPoster.style.visibility = 'hidden';
    };
    detailsPoster.src = proxiedAsset(details.poster, originOf(details.url));
  } else {
    detailsPoster.style.visibility = 'hidden';
  }

  detailsTitle.textContent = details.title || 'İsimsiz';
  detailsDescription.textContent = details.description || 'Açıklama yok.';

  detailsMeta.replaceChildren();
  if (details.type === 'series') detailsMeta.appendChild(el('span', 'type-badge', 'Dizi'));
  else detailsMeta.appendChild(el('span', 'type-badge', 'Film'));
  if (details.year) detailsMeta.appendChild(el('span', null, details.year));
  if (details.rating) detailsMeta.appendChild(el('span', 'rating-badge', `★ ${details.rating}`));
  if (details.sourceLabel) detailsMeta.appendChild(el('span', null, details.sourceLabel));
  if (details.episodeCount) detailsMeta.appendChild(el('span', null, `${details.episodeCount} bölüm`));

  const playerTypes = Array.isArray(details.playerTypes) && details.playerTypes.length
    ? details.playerTypes
    : [{ id: 'dublaj', label: 'Türkçe Dublaj' }];

  if (!playerTypes.some(type => type.id === library.playerType)) {
    library.playerType = playerTypes[0].id;
  }

  renderChipRow(
    playerTypesEl,
    playerTypes,
    library.playerType,
    value => {
      library.playerType = value;
      library.season = null;
      library.episode = null;
      library.sourceIndex = null;
      renderDetails();
    }
  );

  if (details.type === 'series') {
    seasonTabsEl.classList.remove('hidden');
    episodeGridEl.classList.remove('hidden');
    sourceGridEl.classList.add('hidden');

    const seasons = details.source === 'sezonlukdizi'
      ? (details.seasons || [])
      : (details.seasons || []).filter(season => season.playerType === library.playerType);

    if (seasons.length === 0) {
      seasonTabsEl.replaceChildren();
      episodeGridEl.replaceChildren();
      library.episode = null;
      selectionLabel.textContent = 'Bu dil için bölüm bulunamadı';
      updatePlayButton();
      return;
    }

    if (!seasons.some(season => season.season === library.season)) {
      library.season = seasons[0].season;
      library.episode = null;
    }

    renderChipRow(
      seasonTabsEl,
      seasons,
      library.season,
      value => {
        library.season = value;
        library.episode = null;
        renderDetails();
      },
      'season',
      'label'
    );

    const currentSeason = seasons.find(season => season.season === library.season) || seasons[0];
    const episodes = currentSeason.episodes || [];

    if (!episodes.some(episode => episode.episode === library.episode?.episode)) {
      library.episode = episodes[0] || null;
    }

    episodeGridEl.replaceChildren();
    for (const episode of episodes) {
      const button = el('button', 'episode-chip', episode.label || `E${episode.episode}`);
      button.type = 'button';
      if (library.episode && episode.episode === library.episode.episode) {
        button.classList.add('active');
      }
      button.title = episode.title || episode.label || `Bölüm ${episode.episode}`;
      button.addEventListener('click', () => {
        library.episode = episode;
        renderDetails();
      });
      episodeGridEl.appendChild(button);
    }
  } else {
    seasonTabsEl.classList.add('hidden');
    episodeGridEl.classList.add('hidden');
    sourceGridEl.classList.remove('hidden');

    const sources = (details.sources || []).filter(source => source.playerType === library.playerType);

    if (sources.length === 0) {
      sourceGridEl.replaceChildren();
      library.sourceIndex = null;
      selectionLabel.textContent = 'Bu oynatıcı için kaynak bulunamadı';
      updatePlayButton();
      return;
    }

    if (!sources.some(source => source.index === library.sourceIndex)) {
      library.sourceIndex = sources[0].index;
    }

    renderChipRow(
      sourceGridEl,
      sources,
      library.sourceIndex,
      value => {
        library.sourceIndex = value;
        renderDetails();
      },
      'index',
      'label'
    );
  }

  updatePlayButton();
}

function buildDescriptor() {
  const details = library.details;
  if (!details) return null;

  if (details.type === 'series') {
    if (!library.episode) return null;

    const label = `${details.title} · S${library.episode.season}E${library.episode.episode}` +
      (library.episode.title ? ` — ${library.episode.title}` : '');

    if (details.source === 'sezonlukdizi') {
      return {
        kind: 'sezonlukdizi',
        bid: library.episode.id,
        dil: library.playerType,
        title: label,
        label,
      };
    }

    return {
      kind: 'jetfilmizle',
      filmId: details.id,
      url: details.url,
      playerType: library.playerType,
      sourceIndex: library.episode.sourceIndex,
      season: library.episode.season,
      episode: library.episode.episode,
      title: label,
      label,
    };
  }

  if (details.source === 'jetfilmizle') {
    if (library.sourceIndex === null) return null;
    const source = (details.sources || []).find(item =>
      item.playerType === library.playerType && item.index === library.sourceIndex
    );
    const label = `${details.title}${source?.label ? ` · ${source.label}` : ''}`;

    return {
      kind: 'jetfilmizle',
      filmId: details.id,
      url: details.url,
      playerType: library.playerType,
      sourceIndex: library.sourceIndex,
      title: label,
      label,
    };
  }

  return null;
}

function updatePlayButton() {
  const descriptor = buildDescriptor();
  detailsPlayBtn.disabled = !descriptor;
  if (!descriptor) {
    if (!library.details) return;
    selectionLabel.textContent = 'Bir bölüm / kaynak seçin';
    return;
  }
  selectionLabel.textContent = descriptor.label || 'Seçim hazır';
}

async function playSelection() {
  if (!isHost) return;

  const descriptor = buildDescriptor();
  if (!descriptor) return;

  const previousLabel = detailsPlayBtn.textContent;
  detailsPlayBtn.disabled = true;
  detailsPlayBtn.textContent = 'Hazırlanıyor...';
  setDetailsMessage(null);
  setStatus('🔎 Oynatma adresi hazırlanıyor...', 'host');

  try {
    const response = await fetch('/api/play', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ descriptor }),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Oynatma adresi alınamadı.');
    }

    socket.emit('videoLoad', {
      channelId: currentChannelId,
      url: data.url,
      referer: data.referer || null,
      type: data.type || null,
      descriptor,
      title: descriptor.title || data.title || null,
    });

    setNowPlaying(descriptor.title || data.title || null);
    closeLibrary();
    setStatus(`🎬 ${descriptor.title || 'Kaynak hazır'}`, 'host');
  } catch (err) {
    console.error('[Library]', err);
    setDetailsMessage(err.message);
    setStatus(`❌ ${err.message}`, 'error');
  } finally {
    detailsPlayBtn.textContent = previousLabel;
    updatePlayButton();
  }
}

// --- Kütüphane etkileşimleri ---
libraryBtn.addEventListener('click', openLibrary);
libraryCloseBtn.addEventListener('click', closeLibrary);
detailsBackBtn.addEventListener('click', () => {
  detailsPanel.classList.add('hidden');
  resultsPanel.classList.remove('hidden');
});
detailsPlayBtn.addEventListener('click', playSelection);

libraryOverlay.addEventListener('click', event => {
  if (event.target === libraryOverlay) closeLibrary();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !libraryOverlay.classList.contains('hidden')) {
    closeLibrary();
  }
});

searchForm.addEventListener('submit', event => {
  event.preventDefault();
  runSearch();
});

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

playBtn.addEventListener('click', async () => {
  if (!isHost) return;

  const input = videoUrlInput.value.trim();
  if (!input) return alert("Lütfen bir video veya embed URL'si girin!");

  const previousLabel = playBtn.textContent;
  playBtn.disabled = true;
  playBtn.textContent = 'Çözümleniyor...';
  setStatus('🔎 Kaynak çözümleniyor...', 'host');

  try {
    const response = await fetch(`/api/resolve?url=${encodeURIComponent(input)}`);
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || 'Kaynak çözümlenemedi.');
    }

    socket.emit('videoLoad', {
      channelId: currentChannelId,
      url: data.url,
      referer: data.referer || null,
      type: data.type || null,
      descriptor: null,
      title: null
    });

    setNowPlaying(null);
    setStatus(`🎬 Host — ${data.source || 'Kaynak hazır'}`, 'host');
  } catch (err) {
    console.error('[Resolve]', err);
    setStatus(`❌ ${err.message}`, 'error');
    bufferingOverlay.classList.add('hidden');
  } finally {
    playBtn.disabled = false;
    playBtn.textContent = previousLabel;
  }
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
  if (isHost) {
    startHeartbeat();
  } else {
    stopHeartbeat();
    closeLibrary();
  }
});

socket.on('onVideoLoad', (data) => {
  setNowPlaying(data.title || null);
  startSync();
  loadAndPlayVideo(data.url, 0, true, data.referer, data.type);
  setTimeout(() => endSync(), 1500);
});

socket.on('onSyncState', (data) => {
  if (data.title) setNowPlaying(data.title);
  if (data.videoUrl) {
    startSync();
    loadAndPlayVideo(data.videoUrl, data.currentTime, data.isPlaying, data.referer, data.videoType);
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
      await videoPlayer.play().catch(e => console.error(e));
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
    videoPlayer.play().catch(e => console.error(e));
    setTimeout(() => endSync(), 300);
  } else if (!data.isPlaying && !videoPlayer.paused) {
    startSync();
    videoPlayer.pause();
    setTimeout(() => endSync(), 300);
  }
});

// --- BAŞLAT ---
setupDiscordSdk();