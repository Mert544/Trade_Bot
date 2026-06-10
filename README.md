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
| MTF motoru (4H→15M→3m otomatik Structurer beslemesi) | `src/analysis/mtfEngine.mjs` | ✅ |

### Henüz uygulanmayan (sonraki adımlar)
- cTrader/MetaApi canlı icra adaptörü (`BrokerInterface` soyutlaması hazır)
- 8.1 HRL hiyerarşisi ve 8.2 nedensel post-mortem otomasyonu (gölge defter karşı-olgusal veriyi topluyor)
- 7.3 Purged K-Fold doğrulayıcısı ve dikkat ağırlığı optimizasyonu
- Champion-challenger terfi orkestrasyonu (stateManager versiyonlama + rollback hazır)

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

## Test Kapsamı

## Maliyet Notu

Sistem bilinçli olarak **sıfır bütçeyle** çalışacak şekilde kuruludur:
tüm veri kaynakları anahtarsız ve ücretsizdir (Kraken fiyat + OHLC geçmişi,
Coinbase doğrulama, ForexFactory takvim), harici npm paketi yoktur ve gölge
mod gerçek sermaye riski taşımaz. Canlı icra aşamasına gelindiğinde de demo
hesap (cTrader/MetaApi demo, ücretsiz) ile devam edilebilir; ödeme gerektiren
tek adım, isteğe bağlı prop firm challenge ücretidir — o karar da gölge defter
Monte Carlo kapısından geçtikten sonra verilir.

## Test Kapsamı

`tests/` altında 74 kabul testi, Ek B'deki Definition of Done maddelerini birebir izler:

- `protocolBus.test.mjs` — Faz 0 kabul testleri (5 madde + dayanıklılık)
- `oracle.test.mjs` — Faz 1: killzone sıfır kaçırma/mükerrer, ambargo pencereleri, DST sentetik saat testleri, fail-closed
- `governor.test.mjs` — Faz 2: ambargo→kilit zinciri, drawdown makinesi, asimetrik lot, broker mutabakatı
- `sanitizer.test.mjs` — Faz 3: bad tick / gerçek sweep ayrımı, OHLC doğrulama, staleness
- `pipeline.test.mjs` — Faz 3–4: uçtan uca gölge zinciri, veto isabet ölçümü, müzakere hiyerarşisi, Monte Carlo kapısı
- `providers.test.mjs` — Kraken/Coinbase parite eşlemeleri, ForexFactory etki + NY günü filtresi (mock fetch)
- `feedManager.test.mjs` — çoklu kaynak orkestrasyonu, karantina yalıtımı, bar agregasyonu, kaynak düşme senaryoları
- `analysis.test.mjs` — swing/havuz tespiti, bias/DOL, sweep/MSS/FVG, MMXM fazları (sentetik barlar)
- `mtfEngine.test.mjs` — uçtan uca sentetik ICT senaryosu: ısınma → sweep → MSS → FVG → SETUP_CANDIDATE
