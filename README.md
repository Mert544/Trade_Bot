# ICT Bot — V5 "Anayasa" Uygulaması

Nöro-Sembolik, Çoklu Ajanlı ve Kendi Kendini Doğrulayan ICT/SMC Ticaret Ekosistemi.
Bu repo, **ICT Bot Kurumsal Sistem Mimarisi V5** dokümanının ("Anayasa") kod uygulamasıdır.
Anayasayla çelişen kod, performansı ne olursa olsun elenir.

## Hızlı Başlangıç

```bash
npm test          # tüm kabul testleri (Faz 0–4, ağ erişimi gerektirmez)
npm run shadow    # GERÇEK VERİYLE gölge mod: Kraken + Coinbase + ForexFactory
```

Harici bağımlılık **yoktur** — Node ≥ 20 yeterlidir (`node:test`, `Intl` ile DST, yerleşik `fetch`).

## Gerçek Veri Katmanı

`npm run shadow` sistemi anahtarsız, gerçek zamanlı kaynaklarla başlatır:

| Rol | Kaynak | Not |
|---|---|---|
| Birincil fiyat | Kraken kamu Ticker API | Tek istekte tüm watchlist; bid/ask/son işlem |
| Doğrulama fiyatı | Coinbase Exchange API | Çapraz kaynak kuorumu (bad tick / gerçek sweep ayrımı) |
| Ekonomik takvim | ForexFactory haftalık JSON | NFP/CPI/FOMC; etki sınıfları HIGH/MEDIUM eşlenir |
| Opsiyonel | Twelve Data (`TWELVEDATA_API_KEY`) | bid/ask vermez; tek başına kullanılmamalı |

Akış: `FeedManager` her 5 sn'de iki kaynağı paralel yoklar → `Sanitizer`
(Hampel/MAD + çapraz kuorum + staleness) → temiz tick'ler PaperBroker
kotasyonu, Sniper spread geçmişi ve gölge defteri besler → 3m bar kapanışları
rejim dedektörüne gider. Takvim her gün NY gün dönüşünde ve 6 saatte bir
yenilenir; kaynak düşerse Oracle fail-closed geniş ambargo yayınlar.

Kalibrasyon notları (canlı akışta doğrulandı):
- Borsalar arası doğal fiyat farkı spread'i aştığı için çapraz kaynak
  toleransı `max(3×spread, fiyat×%0,15)` olarak uygulanır.
- Durgun piyasada MAD=0 bölme patlaması yapar; medyana göre %0,1 altı
  sapma gürültü sayılır (sahte sweep önlenir).

## Mimari Haritası (Doküman → Kod)

| Anayasa Bölümü | Modül | Durum |
|---|---|---|
| 6.1 Mesaj Zarfı | `src/core/envelope.mjs` | ✅ Faz 0 |
| Ek A Olay Kataloğu (kapalı liste) | `src/core/eventCatalog.mjs` | ✅ Faz 0 |
| 6 Protokol çekirdeği (şema + TTL + beyaz liste) | `src/core/protocolBus.mjs` | ✅ Faz 0 |
| Omurga: eventBus | `src/core/eventBus.mjs` | ✅ |
| Omurga: stateManager (tek gerçeklik kaynağı) | `src/core/stateManager.mjs` | ✅ |
| Omurga: circuitBreaker (6.3 heartbeat/izolasyon) | `src/core/circuitBreaker.mjs` | ✅ |
| 4.3 NY saati / DST / True Day Open | `src/time/nyClock.mjs` | ✅ |
| 5.1 The Oracle (takvim, ambargo, killzone) | `src/agents/oracle.mjs` | ✅ Faz 1 |
| 5.3 The Governor (drawdown makinesi, asimetrik lot) | `src/agents/governor.mjs` | ✅ Faz 2 |
| 4 Sanitasyon hattı (Hampel/MAD, kuorum, staleness) | `src/data/sanitizer.mjs` | ✅ Faz 3 |
| 5.2 The Structurer (4H→15M→1M fraktal makine) | `src/agents/structurer.mjs` | ✅ Faz 3 (v1) |
| 5.4 The Sniper (spread kapısı, slippage/gecikme bütçesi) | `src/agents/sniper.mjs` | ✅ Faz 4 |
| İcra soyutlaması (cTrader/MetaApi arayüzü + paper) | `src/execution/brokerInterface.mjs` | ✅ (paper) |
| 6.2 Müzakere protokolü (veto hiyerarşisi) | `src/coordination/decisionCoordinator.mjs` | ✅ |
| 7.1 Gölge defter (veto isabeti dahil) | `src/shadow/shadowLedger.mjs` | ✅ Faz 4 |
| 7.2 Rejim tespiti | `src/perception/regimeDetector.mjs` | ✅ |
| 7.3 Monte Carlo terfi kapısı | `src/metacognition/monteCarloGate.mjs` | ✅ Faz 5 (ilk kapı) |
| Ek C Konfigürasyon (versiyonlu, dondurulmuş) | `src/config/defaults.mjs` | ✅ |
| Bootstrap (tüm katmanların bağlanması) | `src/index.mjs` | ✅ |
| 4.1 Çoklu kaynak adaptörleri (Kraken/Coinbase/TwelveData) | `src/data/providers/` | ✅ |
| Gerçek ekonomik takvim (ForexFactory → Oracle) | `src/data/providers/forexFactoryCalendar.mjs` | ✅ |
| Besleme orkestratörü + 3m bar agregasyonu | `src/data/feedManager.mjs`, `src/data/barAggregator.mjs` | ✅ |
| Gerçek veri gölge çalıştırıcısı | `src/run/shadowLive.mjs` | ✅ |
| Tarihsel ısınma (Kraken OHLC, ücretsiz) | `src/data/providers/krakenHistory.mjs` | ✅ |
| Swing/likidite haritası (fraktal + eşit seviyeler) | `src/analysis/swings.mjs` | ✅ |
| Yapı analizi (bias/DOL, sweep, MSS, FVG, MMXM) | `src/analysis/structure.mjs` | ✅ |
| PD dizileri (premium/discount, OTE, OB/Breaker) | `src/analysis/pdArrays.mjs` | ✅ |
| PO3 günlük teslim döngüsü (Judas → distribution) | `src/analysis/po3.mjs` | ✅ |
| SMT diverjansı + korelasyon/lead-lag matrisi | `src/analysis/smt.mjs` | ✅ |
| Sembol karakter profili (eşik normalizasyonu) | `src/analysis/symbolProfile.mjs` | ✅ |
| 7.3 Purged K-Fold + dikkat ağırlığı modeli (`npm run learn`) | `src/metacognition/purgedKFold.mjs`, `attentionWeights.mjs` | ✅ |
| MTF motoru (4H→15M→3m otomatik Structurer beslemesi, faz histerezisi) | `src/analysis/mtfEngine.mjs` | ✅ |
| Sinyal yaşam döngüsü + Telegram + JSONL kalıcılık | `src/signals/`, `src/persistence/journal.mjs` | ✅ |
| Dashboard (SSE, tek dosya UI) | `src/dashboard/` | ✅ |
| Setup×rejim×killzone istatistikleri (kademeli eşikler) | `src/signals/setupStats.mjs` | ✅ |
| Kraken WebSocket gerçek tick akışı (push modu) | `src/data/providers/krakenWsProvider.mjs` | ✅ |
| 8.2 Post-mortem taksonomisi v1 (TRADE_POSTMORTEM) | `src/metacognition/postMortem.mjs` | ✅ |

### Henüz uygulanmayan (sonraki adımlar)
- cTrader/MetaApi canlı icra adaptörü (`BrokerInterface` soyutlaması hazır)
- 8.1 HRL hiyerarşisi; 8.2 karşı-olgusal tekrar oynatma (taksonomi v1 veri biriktiriyor)
- Champion-challenger terfi orkestrasyonu (stateManager versiyonlama + rollback hazır)
- decisionCoordinator'ın canlı hatta "ikinci görüş" olarak bağlanması (oy veren ajan yokken bilinçli ertelendi)
- Yeni setup aileleri: FVG_RETEST (continuation, TREND rejimi), NEWS_SWEEP_REVERSAL
  (Oracle etiketi tetikli) — SWEEP_MSS_FVG örneklem doldurduktan sonra

## Öğrenme Döngüsü (`npm run learn`)

Sinyal kalite bileşenleri (sweep derinliği, PD/OTE/OB uyumu, PO3 hizası, SMT
diverjansı, rejim...) her sinyalde journala yazılır. `npm run learn`:

1. Journal'dan sonuçlanmış örnekleri toplar (gerçek + hipotetik akıbet),
2. Örnek eşiğini denetler (<100 → eğitim bile yok),
3. L2'li lojistik regresyonu **purged K-Fold** kapısından geçirir
   (CV ortalaması taban oranı +%2 geçmeli — gürültüden öğrenme reddedilir),
4. Geçerse ağırlıkları `state/attention-weights.json`'a yazar; bot bir
   SONRAKİ açılışta yükler (çalışan sürece sıcak enjeksiyon yok).

Terfi edilmemiş model sabit önsel (0.6) döner — öğrenme sessizce devreye giremez.

## Sinyal Botu Kullanımı

Bot **işlem açmaz** — sinyal üretir ve iletir:

1. `npm run shadow` → dashboard `http://localhost:8717` (port: `ICT_DASHBOARD_PORT`).
   Telefondan izlemek için (hotspot/aynı ağ): açılış logundaki `http://<makine-ip>:8717`
   adresini kullan — sunucu tüm arayüzleri dinler (`ICT_DASHBOARD_HOST` ile kısıtlanabilir),
   salt-okunurdur. Grafik paneli sembol + zaman dilimi (3m/15M/4H) sekmeli mum grafiği sunar.
2. Telegram (opsiyonel): BotFather'dan bot oluştur, `TELEGRAM_BOT_TOKEN` ve
   `TELEGRAM_CHAT_ID` env değişkenlerini ver — onaylı sinyaller tam detayla
   (giriş/stop/hedef/RR/kanıt zinciri), vetolular tek satır özetle, yapı
   bozulmaları "sinyal geri çekildi" mesajıyla düşer. Token yoksa sessiz atlanır.
3. Sinyal geçmişi `state/journal-*.jsonl` dosyalarında kalıcıdır; restart
   sonrası istatistikler otomatik geri yüklenir.

### Overfit disiplini (görsel + yapısal)

- Setup×rejim×killzone hücreleri kademeli örnek eşiğiyle etiketlenir:
  <30 "veri yetersiz", <100 "ön gösterge", <300 "doğrulama", ≥300 "güvenilir".
  Eşik altı hücre üzerinden parametre kararı alınmaz.
- Killzone'lar kriptoda **hipotez** olarak ele alınır: killzone-dışı adaylar
  gözlem grubuna düşer ve hipotetik akıbetleri izlenir (doğal A/B verisi).
- Post-mortem v1 `weightDeltas` daima boş döner — örnek eşiği dolmadan
  hiçbir ağırlık değişmez; 15M faz histerezisi (2 ardışık teyit) sınıflandırma
  gürültüsünün anlatıyı bozmasını engeller.

## Anayasal Garantiler (kodda zorlanır)

- **Kapalı olay listesi:** Ek A dışındaki olay türü bus'a giremez (`ProtocolViolationError`).
- **TTL koruması:** Bayat mesaj protokol seviyesinde düşürülür; sayaç telemetriye işlenir.
- **correlationId zinciri:** Aday → onay → emir → rapor zinciri kırılmadan taşınır (post-mortem temeli).
- **Mutlak veto:** Governor `RISK_VETO` derse karar biter; ambargo Structurer'ın en güçlü sinyalini bile geçersiz kılar.
- **Tampon bölge:** Günlük DD %3,5 → SOFT_LOCK, %4,5 → HARD_LOCK, toplam %8 → K3 KILLSWITCH. Kilit gün içinde gevşemez.
- **Anti-martingale:** Ardışık kayıpta risk geometrik küçülür (2 kayıp → ¼); kazançta doğrusal ve %1,0 tavanlı.
- **Sunucu tarafı stop zorunluluğu:** Stop-loss olmadan `submitOrder` fırlatır — istisnasız.
- **Bad tick ≠ sweep:** İğne yalnızca çapraz kaynak teyidiyle REAL_SWEEP olur; tek kaynaklı iğne imha edilir.
- **Fail-closed Oracle:** Takvim erişilemezse bilinmeyen gün = yüksek etkili gün varsayılır.
- **Broker gerçeği kazanır:** Açılışta `reconcile()` uyuşmazlıkları raporlar, yerel defteri broker'a eşitler.
- **Maliyetsiz simülasyon yasak:** Gölge defter spread + komisyon + slippage içerir.
- **Terfi kapısı:** P95 günlük DD ≥ %5 olan konfigürasyon canlıya alınamaz; 30 işlem altında parametre değişmez.

## Maliyet Notu

Sistem bilinçli olarak **sıfır bütçeyle** çalışacak şekilde kuruludur:
tüm veri kaynakları anahtarsız ve ücretsizdir (Kraken fiyat + OHLC geçmişi,
Coinbase doğrulama, ForexFactory takvim), harici npm paketi yoktur ve gölge
mod gerçek sermaye riski taşımaz. Canlı icra aşamasına gelindiğinde de demo
hesap (cTrader/MetaApi demo, ücretsiz) ile devam edilebilir; ödeme gerektiren
tek adım, isteğe bağlı prop firm challenge ücretidir — o karar da gölge defter
Monte Carlo kapısından geçtikten sonra verilir.

## Test Kapsamı

`tests/` altında 100 kabul testi, Ek B'deki Definition of Done maddelerini birebir izler:

- `protocolBus.test.mjs` — Faz 0 kabul testleri (5 madde + dayanıklılık)
- `oracle.test.mjs` — Faz 1: killzone sıfır kaçırma/mükerrer, ambargo pencereleri, DST sentetik saat testleri, fail-closed
- `governor.test.mjs` — Faz 2: ambargo→kilit zinciri, drawdown makinesi, asimetrik lot, broker mutabakatı
- `sanitizer.test.mjs` — Faz 3: bad tick / gerçek sweep ayrımı, OHLC doğrulama, staleness
- `pipeline.test.mjs` — Faz 3–4: uçtan uca gölge zinciri, veto isabet ölçümü, müzakere hiyerarşisi, Monte Carlo kapısı
- `providers.test.mjs` — Kraken/Coinbase parite eşlemeleri, ForexFactory etki + NY günü filtresi (mock fetch)
- `feedManager.test.mjs` — çoklu kaynak orkestrasyonu, karantina yalıtımı, bar agregasyonu, kaynak düşme senaryoları
- `analysis.test.mjs` — swing/havuz tespiti, bias/DOL, sweep/MSS/FVG, MMXM fazları (sentetik barlar)
- `mtfEngine.test.mjs` — uçtan uca sentetik ICT senaryosu: ısınma → sweep → MSS → FVG → SETUP_CANDIDATE
- `signals.test.mjs` — sinyal yaşam döngüsü, Telegram biçimleme/429, journal append+replay
- `dashboard.test.mjs` — HTML/snapshot/SSE uçları, setup istatistik kırılımı ve eşik etiketleri
- `krakenWs.test.mjs` — WS abonelik/ayrıştırma/yeniden bağlanma (sahte WebSocket), push modu kuorum
- `discipline.test.mjs` — post-mortem taksonomisi, faz histerezisi, look-ahead korumaları

## Çoklu Varlık: Forex + Altın (+ Endeksler yolda)

FX hattı `TWELVEDATA_API_KEY` env değişkeniyle aktifleşir (ücretsiz anahtar:
twelvedata.com — **anahtarı asla repoya/commit'e yazmayın**):

```bash
TWELVEDATA_API_KEY=... npm run shadow   # kripto + EURUSD/GBPUSD/XAUUSD
```

- Veri: Twelve Data `time_series` gerçek 15M OHLC barları (fitiller dahil),
  10 dk yoklama — ücretsiz kredi bütçesinin içinde (≈432/800 gün).
- Hiyerarşi FX'te: 4H bias → 1H anlatı → 15M tetik (kripto: 4H→15M→3m).
- Seans takvimi: Cum 17:00 NY kapanış / Paz 17:00 NY açılış — kapalı seansta
  sinyal üretilmez, staleness bekçisi susar, TD kredisi harcanmaz.
- Enstrüman tablosu (`src/config/instruments.mjs`): pip/lot adımı/min emir/
  kaldıraç/maliyet profili — Governor lot hesabı ve PaperBroker ücretleri
  sınıf farkındalıklı.
- İstatistikler varlık sınıfına göre AYRI birikir (kripto ↔ FX örneklemi
  karışmaz — gizli overfit önlemi).

### cTrader Remote MCP — FX + Endeks birincil kanalı ✅

cTrader uygulamasındaki **Settings → Remote MCP** token'ı yeterlidir
(uygulama kaydı/OAuth GEREKMEZ; token'ı asla repoya yazmayın):

```bash
CTRADER_TOKEN_B64=<base64 blob> npm run shadow
# kripto + EURUSD/GBPUSD/XAUUSD + US500/US100 — gerçek bid/ask spread'lerle
```

- Kanal: https://mcp.ctrader.com (443 — her ağdan erişilir), JSON-RPC/SSE.
- get_spot_prices 10sn'de bir gerçek bid/ask (icra hattı gerçek spread görür);
  get_trendbars 60sn'de bir kapanmış M_15 barları (fitiller gerçek).
- Fiyatlar 10⁵ ölçekli tamsayıdan çözülür; oluşmakta olan bar asla yayılmaz.
- MCP oturumu eşzamanlı istek desteklemez: tüm RPC'ler kuyrukta serileşir
  (canlıda 404 fırtınası olarak tespit edildi); kısa ömürlü oturumlar
  şeffaf yeniden başlatma + tek tekrar ile telafi edilir.
- Öncelik: MCP > Twelve Data (yedek, yalnız FX) > devre dışı.

Sıradaki terfi: FIX 4.4 Price oturumu (cTrader Settings → FIX API) ile
gerçek TICK akışı — 5211 portu geliştirme ortamından kapalı olduğu için
kullanıcı makinesinde test edilecek (CTRADER_FIX_PASSWORD env ile).
