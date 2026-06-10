/**
 * Merkezi Konfigürasyon — Ek C: Başlangıç Değerleri.
 *
 * Anayasal kural: Bu değerler yalnızca Meta-Biliş katmanı tarafından,
 * doğrulama kapılarından (purged K-Fold + Monte Carlo) geçen güncellemelerle
 * değiştirilebilir. Çalışma anında başka hiçbir bileşen yazamaz.
 * Her değişiklik versiyonlanır (bkz. stateManager.saveConfigVersion).
 */

export const CONFIG = Object.freeze({
  version: '5.0.0',

  time: {
    timezone: 'America/New_York', // Killzone + True Day Open referansı (DST farkındalıklı)
    maxClockDriftMs: 1500,        // Broker/yerel saat ofseti eşiği; aşılırsa güvenli mod
  },

  embargo: {
    // Etki sınıfına göre T-/T+ pencereleri (dakika)
    HIGH: { beforeMin: 30, afterMin: 15 },   // NFP, CPI, FOMC, PPI
    MEDIUM: { beforeMin: 10, afterMin: 5 },
    // Takvim kaynağı erişilemezse fail-closed: bilinmeyen gün = yüksek etkili gün
    failClosed: true,
    failClosedWindow: { beforeMin: 30, afterMin: 15 },
  },

  risk: {
    maxTotalDrawdownPct: 10.0,   // FTMO sert limiti
    maxDailyDrawdownPct: 5.0,    // FTMO sert limiti
    softLockDailyPct: 3.5,       // Yeni giriş kilidi (tampon)
    hardLockDailyPct: 4.5,       // Tüm pozisyonlar kapanır, gün sonu kilidi
    totalKillswitchPct: 8.0,     // FTMO %10 limitine 2 puan tampon
    baseRiskPerTradePct: 0.5,    // Asimetrik lot fonksiyonunun tabanı
    maxRiskPerTradePct: 1.0,     // Tavan
    lossStreakMultiplier: 0.5,   // Ardışık kayıp başına lot çarpanı (anti-martingale)
    winStreakIncrement: 0.1,     // Kazanç serisinde doğrusal artış adımı (tavanlı)
  },

  execution: {
    spreadGateMultiplier: 3,     // Kayan medyan spread'in katı; aşılırsa emir reddedilir
    spreadMedianWindowMs: 60 * 60 * 1000, // 1 saatlik kayan medyan penceresi
    signalTtlMs: 90 * 1000,      // 3m pariteler: doğumdan icraya azami süre
    maxLatencyMs: 2000,          // Sinyal→fill toplam gecikme bütçesi
    defaultMaxSlippagePips: 1.5,
  },

  debate: {
    windowMs: 500,               // OBJECTION/ENDORSE toplama süresi
    consensusThreshold: 0.6,     // Ağırlıklı güven skoru onay eşiği
  },

  heartbeat: {
    intervalMs: 5000,
    missThreshold: 3,            // 3 kaçırma = ajan ölü, circuitBreaker izole eder
    errorRateThreshold: 0.2,     // Hata oranı eşiği (ajan hasta)
  },

  sanitizer: {
    hampelWindow: 50,            // Hampel filtresi tick penceresi
    madZScoreThreshold: 6.0,     // Bad tick MAD z-skor eşiği
    crossSourceDeviationSpreadMult: 3, // Kaynaklar arası sapma > 3×spread → karantina
    // Borsalar arası doğal fiyat farkı spread'i aşabilir; tolerans tabanı
    // fiyatın yüzdesi olarak: tolerans = max(3×spread, fiyat × %0,15)
    crossSourceMinTolerancePct: 0.15,
    staleFeedTimeoutMs: 15000,   // Beklenen tick frekansı altı → FEED_STALE
  },

  feed: {
    pollIntervalMs: 5000,        // Kaynak yoklama aralığı (kamu API limitlerine saygılı)
    barIntervalMs: 3 * 60 * 1000, // 3m bar agregasyonu (watchlist temposu)
    requestTimeoutMs: 8000,
    // Push (WebSocket) modu: WS birincil olur, REST yoklama yalnız doğrulama
    // kaynağını tazeler — aralık gevşetilir (kuorum için 10sn yeterli)
    pollIntervalPushModeMs: 10_000,
    ws: {
      url: 'wss://ws.kraken.com/v2',
      reconnectBaseMs: 1000,
      reconnectMaxMs: 60_000,
    },
  },

  analysis: {
    swingK: 2,                  // Fraktal swing tespiti: her iki yanda k bar
    eqTolerancePct: 0.08,       // Eşit yüksek/düşük kümeleme toleransı (% fiyat)
    sweepLookbackBars: 12,      // Süpürme arama penceresi (bar)
    displacementFactor: 1.6,    // Displacement: bar genliği > ortalama × faktör
    fvgMinSizePct: 0.05,        // FVG asgari boşluk (% fiyat) — mikro boşluk elenir
    consolidationRangePct: 0.6, // 15M konsolidasyon eşiği (pencere genliği % fiyat)
    biasSwingCount: 6,          // Bias sınıflandırmasında bakılan son swing sayısı
    maxSeriesLength: 500,       // Zaman dilimi başına tutulan azami bar
    warmupBars4h: 240,          // Açılışta çekilen 4H tarihsel bar (Kraken ücretsiz)
    warmupBars15m: 400,         // Açılışta çekilen 15M tarihsel bar
  },

  calendar: {
    // ForexFactory halka açık haftalık takvim beslemesi
    url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    countries: ['USD', 'All'],   // USD pariteleri için yüksek etkili olaylar
    resyncIntervalMs: 6 * 60 * 60 * 1000, // günlük senkron + 6 saatte bir tazeleme
  },

  metacognition: {
    minSamplesForWeightUpdate: 30,  // İşlem/kurulum; altında parametre değişmez
    // Kademeli doğrulama eşikleri (araştırma: 30 taban / 100+ ilk doğrulama /
    // 200-300+ terfi standardı). Örnek sayısı eşiği geçmeden bir üst iddia yok.
    sampleTiers: { floor: 30, validation: 100, promotion: 300 },
    monteCarloRuns: 5000,
    monteCarloP95DailyDDLimitPct: 5.0, // P95 günlük DD < %5 değilse terfi yok
    attentionLearningRate: 0.05,       // Küçük adım boyutu
  },

  signals: {
    // Bot işlem AÇMAZ; sinyal iletir. Telegram env yoksa sessiz devre dışı.
    telegram: {
      minIntervalMs: 1100,        // Telegram ~1 msg/sn limiti; kuyruk aralığı
      maxQueue: 50,
    },
    expirySweepMs: 10_000,        // Yaşam döngüsü TTL süpürme aralığı
    maxLiveSignals: 200,          // Bellekte tutulan son sinyal sayısı
  },

  dashboard: {
    port: 8717,                   // ICT_DASHBOARD_PORT ile ezilebilir
    snapshotIntervalMs: 5000,     // SSE durum özeti aralığı
    keepAliveMs: 15_000,          // SSE yorum satırı keep-alive
    maxEventLog: 100,
  },

  ws: {
    url: 'wss://ws.kraken.com/v2',
    reconnectBaseMs: 1000,        // Üstel geri çekilme tabanı
    reconnectMaxMs: 60_000,       // Tavan + jitter
    pollIntervalWithWsMs: 10_000, // WS aktifken REST doğrulama yoklaması
  },

  symbols: {
    // Faz 3 bağlamı: XRP/SOL/BTC 3m
    watchlist: ['XRPUSD', 'SOLUSD', 'BTCUSD'],
    baseTimeframe: '3m',
    fractalHierarchy: ['4H', '15M', '5M', '1M'],
  },
});

export default CONFIG;
