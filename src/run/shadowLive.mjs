/**
 * Gölge Mod — Gerçek Veri Çalıştırıcısı.
 *
 * Kademeli Evrim ilkesi: sistem önce gölge modda, gerçek piyasa verisiyle
 * ama sanal defterle yaşar. Bu çalıştırıcı:
 *   - Kraken (birincil) + Coinbase (doğrulama) gerçek zamanlı akışını bağlar
 *   - ForexFactory gerçek ekonomik takvimini Oracle'a verir
 *   - Temiz kotasyonları PaperBroker + Sniper spread geçmişine işler
 *   - Kapanan 3m barları rejim dedektörüne verir
 *   - NY gün dönüşünde drawdown sayaçlarını sıfırlar, takvimi yeniler
 *   - Periyodik sağlık raporu basar (Ek D KPI'ları)
 */

import { CONFIG } from '../config/defaults.mjs';
import { createEcosystem } from '../index.mjs';
import { KrakenProvider } from '../data/providers/krakenProvider.mjs';
import { CoinbaseProvider } from '../data/providers/coinbaseProvider.mjs';
import { KrakenHistory } from '../data/providers/krakenHistory.mjs';
import { ForexFactoryCalendar } from '../data/providers/forexFactoryCalendar.mjs';
import { FeedManager } from '../data/feedManager.mjs';
import { MTFEngine } from '../analysis/mtfEngine.mjs';
import { trueDayOpen } from '../time/nyClock.mjs';

const STATUS_INTERVAL_MS = 60_000;

export async function runShadowLive({
  logger = console,
  statusIntervalMs = STATUS_INTERVAL_MS,
} = {}) {
  const eco = createEcosystem({
    mode: 'shadow',
    calendarProvider: new ForexFactoryCalendar(),
    logger,
  });

  const mtfEngine = new MTFEngine({ structurer: eco.structurer, logger });

  const feed = new FeedManager({
    primary: new KrakenProvider(),
    verification: new CoinbaseProvider(),
    sanitizer: eco.sanitizer,
    symbols: CONFIG.symbols.watchlist,
    logger,

    onQuote: (q) => {
      eco.broker.setQuote(q.symbol, { bid: q.bid, ask: q.ask });
      eco.sniper.recordSpread(q.symbol, q.spread);
      eco.shadowLedger.onPrice(q.symbol, q.price);
    },

    onBar: async (bar) => {
      await eco.regimeDetector.onClose(bar.symbol, bar.close);
      await mtfEngine.onBar3m(bar);
      logger.info(`[bar] ${bar.symbol} 3m O=${bar.open} H=${bar.high} L=${bar.low} C=${bar.close} (${bar.ticks} tick)`);
    },

    onSweep: (s) => {
      // Çapraz teyitli süpürme: Structurer için bağlam (v1: log + gelecekte tetik girdisi)
      logger.info(`[sweep] ${s.symbol} GERÇEK SWEEP teyitli @ ${s.price} (z=${s.zScore === Infinity ? '∞' : s.zScore.toFixed(1)})`);
    },
  });

  await eco.start();

  // Analiz ısınması: Kraken ücretsiz OHLC geçmişiyle 4H/15M bağlamı kur.
  // Kaynak erişilemezse soğuk başlanır — bias canlı barlarla zamanla oluşur.
  const history = new KrakenHistory();
  for (const symbol of CONFIG.symbols.watchlist) {
    try {
      const [bars4h, bars15m] = await Promise.all([
        history.fetchBars(symbol, '4H', CONFIG.analysis.warmupBars4h),
        history.fetchBars(symbol, '15M', CONFIG.analysis.warmupBars15m),
      ]);
      await mtfEngine.warmup(symbol, { bars4h, bars15m });
      const ctx = eco.structurer.contextOf(symbol);
      logger.info(`[mtf] ${symbol} başlangıç bağlamı: bias=${ctx.htfBias} dol=${ctx.dolLevel ?? '—'} faz=${ctx.phase}`);
    } catch (err) {
      logger.warn(`[mtf] ${symbol} ısınma başarısız (soğuk başlangıç): ${err.message}`);
    }
  }

  feed.start();

  // NY gün dönüşü bekçisi: drawdown sayaçları + takvim yenileme
  let currentDayOpen = trueDayOpen(new Date());
  const dayWatch = setInterval(async () => {
    const nowDayOpen = trueDayOpen(new Date());
    if (nowDayOpen !== currentDayOpen) {
      currentDayOpen = nowDayOpen;
      eco.stateManager.rolloverDay();
      logger.info('[rollover] NY gün dönüşü: günlük DD sayaçları sıfırlandı, takvim yenileniyor');
      await eco.oracle.syncCalendar();
    }
  }, 30_000);
  dayWatch.unref();

  // Takvim periyodik tazeleme (gün içi revizyonlar için)
  const calendarRefresh = setInterval(() => {
    eco.oracle.syncCalendar().catch(() => {}); // hata zaten fail-closed işlenir
  }, CONFIG.calendar.resyncIntervalMs);
  calendarRefresh.unref();

  // Sağlık raporu (Ek D)
  const status = setInterval(() => {
    const busT = eco.bus.getTelemetry();
    const feedT = feed.getTelemetry();
    const shadow = eco.shadowLedger.stats();
    const snap = eco.stateManager.snapshot();
    const quotes = CONFIG.symbols.watchlist
      .map((s) => {
        const q = feed.lastQuote(s);
        return q ? `${s}=${q.price}` : `${s}=—`;
      })
      .join(' ');
    logger.info(
      `[durum] ${quotes} | killzone=${snap.killzone.zone ?? 'NONE'} ambargo=${snap.embargo.active} kilit=${snap.riskLock} | `
      + `feed: ${feedT.polls} tur, temiz=${feedT.verdicts.CLEAN} bad=${feedT.verdicts.BAD_TICK} sweep=${feedT.verdicts.REAL_SWEEP} karantina=${feedT.verdicts.QUARANTINED}, bar=${feedT.barsClosed} | `
      + `bus: ${busT.published} yayın, ${busT.rejectedInvalid} ret | gölge: ${shadow.total} işlem, ${shadow.rejectedCount} veto kaydı`,
    );
  }, statusIntervalMs);
  status.unref();

  const shutdown = () => {
    logger.info('[ict-bot] kapanış: feed ve ajanlar durduruluyor');
    feed.stop();
    eco.stop();
    clearInterval(dayWatch);
    clearInterval(calendarRefresh);
    clearInterval(status);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { eco, feed, mtfEngine, shutdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runShadowLive().catch((err) => {
    console.error(`[ict-bot] gölge mod başlatma hatası: ${err.message}`);
    process.exit(1);
  });
}

export default runShadowLive;
