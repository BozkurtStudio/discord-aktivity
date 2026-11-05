# Discord Aktivite — Film/Dizi İzleme

Discord ses kanalında arkadaşlarla **senkron** film/dizi izleme aktivitesi.
Kütüphaneden (Sezonluk Dizi / JetFilmizle) arama yapılır, bölüm/film seçilir ve
herkes için senkron oynatılır. Eski manuel embed/MP4/M3U8 akışı da çalışmaya
devam eder.

## Gereksinimler

- Node.js 20+
- Discord uygulaması (Activities etkin) ve `Client ID`

## 1. Hızlı başlangıç (yerel, tek komut)

```bash
npm install
npm run host
```

Bu komut sırayla:

1. İstemciyi derler (`vite build`)
2. Yerel sunucuyu çalıştırır (`server.js`)
3. `cloudflared` yoksa indirir ve **girişsiz** bir tünel açar
4. Discord Developer Portal'a yapıştırılacak URL eşlemesini ekrana yazar

Ekrana çıkan tüneline göre **Developer Portal → Activities → URL Mappings**:

| Prefix | Target |
| --- | --- |
| `/` | tünel adresi |
| `/api` | tünel adresi |
| `/proxy` | tünel adresi |
| `/socket.io` | tünel adresi |

> Tünel adresi her açılışta değişir, bu yüzden eşlemeyi her seferinde
> güncellemek gerekir. Sabit adres için aşağıdaki Render yolunu kullanın.
>
> Yerelde çalıştırırken kaynak siteler ev/ISP IP'sinden çağrıldığı için
> **tüm kaynaklar** (Sezonluk Dizi dahil) sorunsuz çalışır.

### Seçenekler

```
npm run host -- --client-id <id>   # Discord uygulama kimliği
npm run host -- --port 3100        # yerel port
npm run host -- --no-build         # derlemeyi atla
npm run host -- --open             # Developer Portal'ı aç
```

Uygulama kimliği `.env` içinde `VITE_DISCORD_CLIENT_ID=<id>` olarak da
verilebilir.

## 2. 7/24 barındırma (Render + relay)

Sunucu veri merkezinde çalıştığında bazı kaynak siteler Cloudflare WAF ile
veri merkezi IP'lerini engeller. Bu yüzden tüm dış istekler bir Cloudflare
Worker "relay"ı üzerinden geçirilir.

### 2a. Relay Worker'ı kur (bir kez)

```bash
npx -y wrangler@4 login          # tarayıcıdan Cloudflare onayı
npm run deploy:worker            # Worker'ı yayına alır
```

Deploy çıktısındaki adresi (`https://dc-relay.<hesap>.workers.dev`) not alın.

### 2b. Render Web Service

- Repo: bu depo, branch `main`
- Region: **Frankfurt (EU Central)** — ABD bölgeleri engellenebilir
- Build Command: `npm install && npm run build`
- Start Command: `node server.js`
- Environment:

| Key | Value |
| --- | --- |
| `OUTBOUND_RELAY` | `https://dc-relay.<hesap>.workers.dev` |
| `NODE_VERSION` | `20` |

### 2c. Discord URL Mappings

Sabit Render adresine (bir kez):

| Prefix | Target |
| --- | --- |
| `/`, `/api`, `/proxy`, `/socket.io` | `https://<render-servisi>.onrender.com` |

Adres sabit olduğu için bir daha değiştirmeniz gerekmez.

### Teşhis

Tarayıcıdan `https://<render-servisi>.onrender.com/api/diag` açın. Relay'in
etkin olduğunu ve tüm kaynakların `200` döndüğünü gösterir.

## Kaynaklar ve bilinen sınırlar

| Kaynak | Tür | Durum |
| --- | --- | --- |
| **JetFilmizle** (`jetfilmizle.app`) | Film + Dizi | Yerelde ve Render'da çalışır |
| **Sezonluk Dizi** (`sezonlukdizi.cc`) | Dizi | Yerelde çalışır; Render (Frankfurt) üzerinden bölüm kaynakları engellidir |

**Sezonluk Dizi neden Render'da çalışmıyor?** Bölümün oynatıcı kaynak listesini
veren `POST /ajax/dataAlternatif22.asp` ucu, Cloudflare üzerinden çağrıldığında
Amsterdam'dan `200`, Render'ın Frankfurt bölgesinden `403` dönüyor. Ayrıca
Filemoon/SprintCDN token'ları çözümlemenin yapıldığı ağa bağlı olduğundan bu
bölüm relay üzerinden de akamıyor. Bu, kaynak sitenin WAF kuralıdır; başlık
değiştirmek işe yaramaz.

Pratik sonuç: **Render'da dizi izlemek için JetFilmizle kullanın.** Sezonluk
Dizi gerekiyorsa `npm run host` ile yerelden yayın yapın.

## Test

Kaynak akışlarını uçtan uca denemek için (sunucu açıkken):

```bash
npm run smoke                                    # http://localhost:3000
SMOKE_BASE=https://<render-servisi>.onrender.com npm run smoke
```

## Mimari (özet)

- `server.js` — Express + Socket.IO; `/api/*` kaynak API'leri, `/proxy/stream`
  saydam video proxy'si (Range/206 destekli), oda durumu.
- `server/net.js` — yönlendirme/çerez/karakter kodlaması yöneten istek istemcisi;
  `OUTBOUND_RELAY` ayarlıysa tüm dış istekler relay'den geçer.
- `server/sources/*` — kaynak adaptörleri (arama, detay, oynatma) ve
  `resolve.js` embed → doğrudan MP4/M3U8 çözümleyicisi.
- `cloudflare/relay-worker.js` — Cloudflare Worker relay (isteği sabit Batı
  Avrupa'dan çıkaran Durable Object ile).
- `src/main.js` — Discord SDK, senkron oynatıcı, kütüphane arayüzü.
