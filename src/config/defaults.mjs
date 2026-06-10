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
    staleFeedTimeoutMs: 15000,   // Beklenen tick frekansı altı → FEED_STALE
  },

  metacognition: {
    minSamplesForWeightUpdate: 30,  // İşlem/kurulum; altında parametre değişmez
    monteCarloRuns: 5000,
    monteCarloP95DailyDDLimitPct: 5.0, // P95 günlük DD < %5 değilse terfi yok
    attentionLearningRate: 0.05,       // Küçük adım boyutu
  },

  symbols: {
    // Faz 3 bağlamı: XRP/SOL/BTC 3m
    watchlist: ['XRPUSD', 'SOLUSD', 'BTCUSD'],
    baseTimeframe: '3m',
    fractalHierarchy: ['4H', '15M', '5M', '1M'],
  },
});

export default CONFIG;
