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
import { KrakenWsProvider } from '../data/providers/krakenWsProvider.mjs';
import { MTFEngine } from '../analysis/mtfEngine.mjs';
import { trueDayOpen } from '../time/nyClock.mjs';
import { Journal } from '../persistence/journal.mjs';
import { SetupStats } from '../signals/setupStats.mjs';
import { TelegramNotifier } from '../signals/telegramNotifier.mjs';
import { DashboardServer } from '../dashboard/server.mjs';
import { PO3Tracker } from '../analysis/po3.mjs';
import { CorrelationMatrix, SMTDetector } from '../analysis/smt.mjs';
import { SymbolProfile } from '../analysis/symbolProfile.mjs';
import { AttentionModel } from '../metacognition/attentionWeights.mjs';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';

const STATUS_INTERVAL_MS = 60_000;

export async function runShadowLive({
  logger = console,
  statusIntervalMs = STATUS_INTERVAL_MS,
  dashboardPort = undefined,
} = {}) {
  // Kalıcılık + istatistik önce kurulur; journal replay ile restart'a dayanıklı
  const journal = new Journal({ logger });
  const stats = new SetupStats();
  const equityCurve = []; // restart'a dayanıklı equity eğrisi (journal'dan)
  journal.replay((record) => {
    stats.ingestJournalRecord(record);
    if (record.kind === 'equity') equityCurve.push({ at: record.at, equity: record.equity });
  });

  // Killzone-dışı gözlem adayları (E6): bus'a çıkmaz, ama journal + istatistik +
  // hipotetik akıbet izlemesine girer — killzone etkisinin doğal A/B verisi.
  let ecoRef = null;
  const onObservation = (obs) => {
    const observation = { ...obs, correlationId: randomUUID() };
    journal.append({ kind: 'observation', observation });
    stats.recordObservation(observation);
    ecoRef?.shadowLedger.recordRejection(
      { msgId: observation.correlationId, correlationId: observation.correlationId, payload: obs },
      'gözlem: killzone dışı',
    );
  };

  // Dikkat ağırlığı modeli: terfi edilmiş ağırlık dosyası varsa yüklenir,
  // yoksa sabit önsel (0.6) — davranış değişmez, öğrenme açıkça çalıştırılır
  // (npm run learn) ve CV kapısından geçmeden devreye giremez.
  let attentionModel = new AttentionModel(CONFIG.metacognition.attention);
  if (existsSync(CONFIG.metacognition.attention.weightsPath)) {
    try {
      attentionModel = AttentionModel.fromJSON(
        JSON.parse(readFileSync(CONFIG.metacognition.attention.weightsPath, 'utf8')),
        CONFIG.metacognition.attention,
      );
      if (attentionModel.promoted) {
        logger.info(`[attention] terfi edilmiş ağırlıklar yüklendi (CV ort. ${attentionModel.metrics?.cvMean?.toFixed(3)})`);
      }
    } catch (err) {
      logger.warn(`[attention] ağırlık dosyası okunamadı, önsel kullanılıyor: ${err.message}`);
    }
  }

  const eco = createEcosystem({
    mode: 'shadow',
    calendarProvider: new ForexFactoryCalendar(),
    logger,
    onObservation,
    confidenceFn: (quality) => attentionModel.score(quality),
    persistPath: 'state/state.json', // bakiye/DD restart'a dayanıklı (journal ile tutarlı)
  });
  ecoRef = eco;

  // Equity eğrisi: her kapanan gölge işlemde nokta (dashboard + journal)
  if (equityCurve.length === 0) {
    equityCurve.push({ at: Date.now(), equity: eco.stateManager.get('equity') });
  }
  eco.bus.subscribe('TRADE_POSTMORTEM', () => {
    const point = { at: Date.now(), equity: eco.stateManager.get('equity') };
    equityCurve.push(point);
    if (equityCurve.length > 2000) equityCurve.shift();
    journal.append({ kind: 'equity', equity: point.equity, dailyPnl: eco.stateManager.get('dailyPnl') });
  });

  // Sinyal sink zinciri: journal (kalıcı) + istatistik + Telegram (varsa)
  eco.signalHub.addSink(journal);
  eco.signalHub.addSink(stats);
  const telegram = new TelegramNotifier({ logger });
  if (telegram.enabled) {
    eco.signalHub.addSink(telegram);
    logger.info('[telegram] bildirimler aktif');
  }

  // Derinleştirme katmanları: PO3, korelasyon/SMT, parite karakter profili
  const po3 = new PO3Tracker(CONFIG.analysis.po3);
  const matrix = new CorrelationMatrix({ window: CONFIG.analysis.smt.correlationWindow });
  const smt = new SMTDetector({
    matrix,
    minCorrelation: CONFIG.analysis.smt.minCorrelation,
    windowMs: CONFIG.analysis.smt.divergenceWindowMs,
  });
  const profile = new SymbolProfile(CONFIG.analysis.profile);

  const mtfEngine = new MTFEngine({
    structurer: eco.structurer,
    logger,
    po3,
    smt,
    matrix,
    profile,
    contextProviders: {
      regime: (symbol) => eco.stateManager.get(`regime.${symbol}`)?.regime ?? null,
      killzone: () => {
        const kz = eco.stateManager.get('killzone');
        return kz?.active ? kz.zone : null;
      },
    },
  });

  // Faz D: WS varsa push modu (gerçek fitiller), yoksa klasik REST polling.
  // ICT_WS=off ile polling'e zorlanabilir (sorun ayıklama).
  const wsEnabled = process.env.ICT_WS !== 'off' && typeof globalThis.WebSocket === 'function';
  const feed = new FeedManager({
    primary: new KrakenProvider(),
    verification: new CoinbaseProvider(),
    sanitizer: eco.sanitizer,
    symbols: CONFIG.symbols.watchlist,
    mode: wsEnabled ? 'push' : 'poll',
    logger,

    onQuote: (q) => {
      eco.broker.setQuote(q.symbol, { bid: q.bid, ask: q.ask });
      eco.sniper.recordSpread(q.symbol, q.spread);
      // Bekleyen limit dolum/TTL denetimi (kotasyon güncel olduktan sonra)
      eco.sniper.onQuote(q.symbol, q).catch((err) => logger.error(`[sniper] onQuote hatası: ${err.message}`));
      eco.shadowLedger.onPrice(q.symbol, q.price);
      profile.onSpread(q.symbol, (q.spread / q.price) * 100);
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
      const [bars4h, bars15m, bars5m] = await Promise.all([
        history.fetchBars(symbol, '4H', CONFIG.analysis.warmupBars4h),
        history.fetchBars(symbol, '15M', CONFIG.analysis.warmupBars15m),
        history.fetchBars(symbol, '5M', 300), // PO3 + korelasyon tohumu (~25 saat)
      ]);
      await mtfEngine.warmup(symbol, { bars4h, bars15m });

      // Korelasyon matrisi 15M kapanışlarla tanımlı → ısınma barlarıyla tohumla
      for (const b of bars15m) matrix.onClose(symbol, b.close);
      // PO3 bugünün gün-içi barlarıyla kurulur (birikim penceresi + Judas tespiti)
      for (const b of bars5m) po3.onBar(symbol, b);

      const ctx = eco.structurer.contextOf(symbol);
      const po3Ctx = po3.context(symbol);
      logger.info(`[mtf] ${symbol} başlangıç: bias=${ctx.htfBias} dol=${ctx.dolLevel ?? '—'} faz=${ctx.phase} po3=${po3Ctx.phase}${po3Ctx.expectedDelivery ? `→${po3Ctx.expectedDelivery}` : ''}`);
    } catch (err) {
      logger.warn(`[mtf] ${symbol} ısınma başarısız (soğuk başlangıç): ${err.message}`);
    }
  }

  feed.start();

  let krakenWs = null;
  if (wsEnabled) {
    krakenWs = new KrakenWsProvider({
      symbols: CONFIG.symbols.watchlist,
      logger,
      onTick: (tick) => {
        feed.ingestPush(tick).catch((err) => logger.error(`[feed] push hatası: ${err.message}`));
      },
      // İşlem sessizliği ≠ feed ölümü: ticker aktıkça bayatlık saati tazelenir
      onLiveness: (symbol) => eco.sanitizer.touch('kraken-ws', symbol),
    });
    krakenWs.start();
    logger.info('[feed] PUSH modu: Kraken WS birincil, Coinbase REST doğrulama');
  } else {
    logger.info('[feed] POLL modu: Kraken REST birincil');
  }

  // Dashboard: anlık görüntü sağlayıcı tüm katmanları tek JSON'da toplar
  const snapshotProvider = () => {
    const snap = eco.stateManager.snapshot();
    return {
      time: Date.now(),
      mode: eco.mode,
      state: { killzone: snap.killzone, embargo: snap.embargo, riskLock: snap.riskLock, equity: snap.equity },
      symbols: CONFIG.symbols.watchlist.map((symbol) => {
        const q = feed.lastQuote(symbol);
        return {
          symbol,
          price: q?.price ?? null,
          spread: q?.spread ?? null,
          regime: snap.regime?.[symbol]?.regime ?? null,
          mtf: mtfEngine.snapshot(symbol),
        };
      }),
      feed: feed.getTelemetry(),
      bus: eco.bus.getTelemetry(),
      shadow: eco.shadowLedger.stats(),
      vetoAccuracy: eco.shadowLedger.vetoAccuracy(),
      signals: eco.signalHub.list(40),
      setupStats: stats.breakdown(),
      correlations: mtfEngine.correlationMatrix(),
      attention: { promoted: attentionModel.promoted, metrics: attentionModel.metrics },
      account: {
        startingEquity: CONFIG.account.startingEquity,
        equity: snap.equity,
        dailyPnl: snap.dailyPnl,
        dailyDDPct: eco.stateManager.dailyDrawdownPct(),
        totalDDPct: eco.stateManager.totalDrawdownPct(),
        ...eco.shadowLedger.stats(),
      },
      equityCurve: equityCurve.slice(-300),
    };
  };
  const dashboard = new DashboardServer({
    snapshotProvider,
    barsProvider: (symbol, tf) => mtfEngine.series(symbol, tf),
    logger,
  });
  eco.signalHub.addSink(dashboard);
  await dashboard.start(dashboardPort);

  // NY gün dönüşü bekçisi: drawdown sayaçları + takvim yenileme
  let currentDayOpen = trueDayOpen(new Date());
  const dayWatch = setInterval(async () => {
    const nowDayOpen = trueDayOpen(new Date());
    if (nowDayOpen !== currentDayOpen) {
      currentDayOpen = nowDayOpen;
      // Günlük rapor: sıfırlamadan ÖNCE gönderilir (Ek D — Patron raporu)
      if (telegram.enabled) {
        const sh = eco.shadowLedger.stats();
        const equity = eco.stateManager.get('equity');
        const dayPnl = eco.stateManager.get('dailyPnl');
        telegram.sendText([
          '📊 <b>GÜNLÜK RAPOR</b>',
          `Bakiye: <b>${equity.toFixed(2)}$</b> (gün: ${dayPnl >= 0 ? '+' : ''}${dayPnl.toFixed(2)}$)`,
          `İşlem: ${sh.total} (${sh.wins}K/${sh.losses}Z) | Toplam R: ${sh.totalR} | Ort R: ${sh.avgR ?? '—'}`,
          `Günlük DD: %${eco.stateManager.dailyDrawdownPct().toFixed(2)} | Veto kaydı: ${sh.rejectedCount}`,
        ].join('\n'));
      }
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
    logger.info('[ict-bot] kapanış: feed, dashboard ve ajanlar durduruluyor');
    feed.stop();
    krakenWs?.stop();
    dashboard.stop();
    eco.stop();
    clearInterval(dayWatch);
    clearInterval(calendarRefresh);
    clearInterval(status);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { eco, feed, mtfEngine, dashboard, journal, stats, telegram, krakenWs, shutdown };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runShadowLive().catch((err) => {
    console.error(`[ict-bot] gölge mod başlatma hatası: ${err.message}`);
    process.exit(1);
  });
}

export default runShadowLive;
