/**
 * Çoklu varlık sınıfı testleri (F1-F4):
 *   - marketHours: FX haftalık penceresi (Cum 17:00 NY kapanış, Paz 17:00 açılış, DST)
 *   - Governor: enstrüman farkındalıklı lot (kaldıraç, lot adımı, min emir)
 *   - TwelveDataBars: gerçek OHLC ayrıştırma, forming bar atlama, dedupe, kapalı seans
 *   - MTFEngine: FX hiyerarşisi (15M tetik → 1H anlatı → 4H bias)
 *   - SetupStats: varlık sınıfı boyutu ayrımı
 *   - CTraderProvider: token blob çözümü + hazırlık teşhisi
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isFxOpen, isMarketOpen, nyWeekday } from '../src/time/marketHours.mjs';
import { instrumentSpec, symbolsByClass, ASSET_CLASS } from '../src/config/instruments.mjs';
import { Governor } from '../src/agents/governor.mjs';
import { StateManager } from '../src/core/stateManager.mjs';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { TwelveDataBars } from '../src/data/providers/twelveDataBars.mjs';
import { CTraderProvider } from '../src/data/providers/ctraderProvider.mjs';
import { MTFEngine } from '../src/analysis/mtfEngine.mjs';
import { Structurer, BIAS } from '../src/agents/structurer.mjs';
import { SetupStats } from '../src/signals/setupStats.mjs';
import { Sanitizer } from '../src/data/sanitizer.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// --- marketHours ---

test('marketHours: FX haftalık penceresi NY saatiyle (yaz saati)', () => {
  // 2026-06-12 Cuma: 16:59 NY (20:59 UTC EDT) açık, 17:00 NY kapalı
  assert.equal(isFxOpen(new Date(Date.UTC(2026, 5, 12, 20, 59))), true, 'Cuma 16:59 NY açık');
  assert.equal(isFxOpen(new Date(Date.UTC(2026, 5, 12, 21, 0))), false, 'Cuma 17:00 NY kapalı');
  // Cumartesi tamamen kapalı
  assert.equal(isFxOpen(new Date(Date.UTC(2026, 5, 13, 12, 0))), false);
  // Pazar: 16:59 NY kapalı, 17:00 NY açık
  assert.equal(isFxOpen(new Date(Date.UTC(2026, 5, 14, 20, 59))), false, 'Pazar 16:59 NY kapalı');
  assert.equal(isFxOpen(new Date(Date.UTC(2026, 5, 14, 21, 0))), true, 'Pazar 17:00 NY açık');
  // Hafta içi gece açık
  assert.equal(isFxOpen(new Date(Date.UTC(2026, 5, 10, 3, 0))), true);
});

test('marketHours: kış saatinde (EST) sınırlar kaymaz', () => {
  // 2026-01-16 Cuma: 17:00 NY = 22:00 UTC (EST)
  assert.equal(isFxOpen(new Date(Date.UTC(2026, 0, 16, 21, 59))), true);
  assert.equal(isFxOpen(new Date(Date.UTC(2026, 0, 16, 22, 0))), false);
  assert.equal(nyWeekday(new Date(Date.UTC(2026, 0, 16, 22, 0))), 5, 'Cuma');
});

test('marketHours: kripto her zaman açık, EURUSD seansa tabi', () => {
  const saturday = new Date(Date.UTC(2026, 5, 13, 12, 0));
  assert.equal(isMarketOpen('BTCUSD', saturday), true);
  assert.equal(isMarketOpen('EURUSD', saturday), false);
});

// --- Enstrüman farkındalıklı Governor ---

function makeGovernor(equity) {
  const bus = new ProtocolBus({ logger: silentLogger });
  const stateManager = new StateManager({ initialEquity: equity });
  return new Governor({ bus, stateManager, logger: silentLogger });
}

test('governor: EURUSD lot — risk bazlı boyut, lot adımına aşağı yuvarlama', () => {
  const gov = makeGovernor(10_000);
  // risk %0,5 = 50$; stop 20 pip = 0.0020 → ham lot 25.000 birim
  const r = gov.computeLotSize({ entry: 1.1540, stop: 1.1520, symbol: 'EURUSD' });
  assert.equal(r.lotSize, 25_000);
  assert.equal(r.lotSize % 1000, 0, 'lot adımı 1000 birime yuvarlanır');
});

test('governor: kaldıraç tavanı FX icin nominal sınırı genişletir, küçük hesapta min emir vetosu', () => {
  // 1000$ hesap: risk 5$, stop 20 pip → ham lot 2500; kaldıraç 30 → tavan ~26.000 ✓
  const small = makeGovernor(1000);
  const ok = small.computeLotSize({ entry: 1.1540, stop: 1.1520, symbol: 'EURUSD' });
  assert.equal(ok.lotSize, 2000, '2500 → adım yuvarlama 2000');

  // 100$ hesap: risk 0,5$ → ham lot 250 < minOrder 1000 → uygulanamaz
  const tiny = makeGovernor(100);
  const veto = tiny.computeLotSize({ entry: 1.1540, stop: 1.1520, symbol: 'EURUSD' });
  assert.equal(veto.infeasible, 'MIN_ORDER');
  assert.ok(veto.minRequiredEquity > 100, 'asgari bakiye raporlanır');
});

test('governor: kripto spot kaldıraç 1 — nominal bakiyeyi aşamaz', () => {
  const gov = makeGovernor(1000);
  // BTC: stop çok yakın → risk bazlı lot nominali aşardı; tavan devreye girer
  const r = gov.computeLotSize({ entry: 60_000, stop: 59_940, symbol: 'BTCUSD' });
  assert.ok(r.lotSize * 60_000 <= 1000 + 1e-6, `nominal ${r.lotSize * 60_000} ≤ bakiye`);
});

// --- TwelveDataBars ---

function tdResponse(values) {
  return { ok: true, status: 200, json: async () => ({ meta: {}, values, status: 'ok' }) };
}

test('td-bars: gerçek OHLC ayrıştırma + forming bar atlanır + dedupe', async () => {
  // Pazartesi 12:00 UTC (FX açık)
  let now = Date.UTC(2026, 5, 8, 12, 7);
  const emitted = [];
  const td = new TwelveDataBars({
    apiKey: 'test', symbols: ['EURUSD'], interval: '15M', logger: silentLogger,
    now: () => now,
    onBar: (b) => emitted.push(b),
    fetchImpl: async () => tdResponse([
      { datetime: '2026-06-08 12:00:00', open: '1.1540', high: '1.1551', low: '1.1538', close: '1.1547' }, // forming (kapanış 12:15 > now)
      { datetime: '2026-06-08 11:45:00', open: '1.1532', high: '1.1542', low: '1.1530', close: '1.1540' },
      { datetime: '2026-06-08 11:30:00', open: '1.1525', high: '1.1535', low: '1.1522', close: '1.1532' },
    ]),
  });
  await td.poll();
  assert.equal(emitted.length, 2, 'forming bar yayılmaz (look-ahead yasak)');
  assert.equal(emitted[0].openTime, Date.UTC(2026, 5, 8, 11, 30), 'eski → yeni sıra');
  assert.equal(emitted[0].high, 1.1535, 'gerçek fitil verisi');

  await td.poll(); // aynı veri tekrar gelirse
  assert.equal(emitted.length, 2, 'dedupe: aynı bar ikinci kez yayılmaz');

  now = Date.UTC(2026, 5, 8, 12, 16); // 12:00 barı artık kapanmış
  await td.poll();
  assert.equal(emitted.length, 3);
  assert.equal(emitted[2].openTime, Date.UTC(2026, 5, 8, 12, 0));
});

test('td-bars: kapalı seansta (Cumartesi) yoklama kredi harcamaz', async () => {
  let fetchCount = 0;
  const td = new TwelveDataBars({
    apiKey: 'test', symbols: ['EURUSD'], logger: silentLogger,
    now: () => Date.UTC(2026, 5, 13, 12, 0), // Cumartesi
    fetchImpl: async () => { fetchCount += 1; return tdResponse([]); },
  });
  await td.poll();
  assert.equal(fetchCount, 0);
  assert.equal(td.telemetry.skippedClosed, 1);
});

// --- MTF FX hiyerarşisi ---

test('mtfEngine: EURUSD 15M tetik barları 1H anlatıya ve 4H bias seviyesine birleşir', async () => {
  const bus = new ProtocolBus({ logger: silentLogger });
  const structurer = new Structurer({ bus });
  const engine = new MTFEngine({ structurer, logger: silentLogger });

  const M15 = 15 * 60 * 1000;
  const t0 = Date.UTC(2026, 5, 8, 8, 0); // Pazartesi 08:00 UTC — FX açık
  // 8 × 15M bar = 2 × 1H bar kapanmalı (3.tetik barda 1H sınır aşımı yok; 5.de ilk 1H kapanır)
  for (let i = 0; i < 9; i += 1) {
    await engine.onTriggerBar({
      symbol: 'EURUSD', openTime: t0 + i * M15,
      open: 1.15, high: 1.151 + i * 0.0001, low: 1.149, close: 1.1505,
    });
  }
  const snap = engine.snapshot('EURUSD');
  assert.deepEqual(snap.tfs, { trigger: '15M', narrative: '1H', bias: '4H' });
  assert.equal(snap.bars3m, 9, 'tetik serisi 15M barları tutar');
  assert.equal(snap.bars15m, 2, '1H anlatı serisi: 8×15M → 2 kapanmış 1H');
});

test('mtfEngine: kapalı seansta tetik taraması sinyal üretmez', async () => {
  const bus = new ProtocolBus({ logger: silentLogger });
  const events = [];
  bus.subscribe('SETUP_CANDIDATE', (e) => events.push(e));
  const structurer = new Structurer({ bus });
  structurer.start();
  await bus.publish({ type: 'KILLZONE_STATE', source: 'oracle', payload: { zone: 'NY_AM', active: true, trueDayOpen: 0 } });
  await structurer.updateHtfBias('EURUSD', { htfBias: BIAS.LONG, dolLevel: 1.2 });

  const engine = new MTFEngine({ structurer, logger: silentLogger });
  // Cumartesi tarihli barlar (teorik): tarama isMarketOpen kapısına takılmalı
  const M15 = 15 * 60 * 1000;
  const sat = Date.UTC(2026, 5, 13, 10, 0);
  for (let i = 0; i < 12; i += 1) {
    await engine.onTriggerBar({ symbol: 'EURUSD', openTime: sat + i * M15, open: 1.15, high: 1.151, low: 1.149, close: 1.15 });
  }
  assert.equal(events.length, 0, 'kapalı seansta aday yok');
});

// --- SetupStats sınıf boyutu ---

test('setupStats: aynı aile farklı varlık sınıfında ayrı hücrede birikir', () => {
  const stats = new SetupStats({ tiers: { floor: 1, validation: 2, promotion: 3 } });
  stats.onSignalEvent('CLOSED', {
    setupFamily: 'SWEEP_MSS_FVG', outcome: 'WIN', rMultiple: 2,
    quality: { assetClass: 'CRYPTO', regime: 'RANGE', killzone: 'NY_AM' },
  });
  stats.onSignalEvent('CLOSED', {
    setupFamily: 'SWEEP_MSS_FVG', outcome: 'LOSS', rMultiple: -1,
    quality: { assetClass: 'FX', regime: 'RANGE', killzone: 'NY_AM' },
  });
  const rows = stats.breakdown();
  assert.equal(rows.length, 2, 'sınıflar karışmaz');
  const crypto = rows.find((r) => r.assetClass === 'CRYPTO');
  const fx = rows.find((r) => r.assetClass === 'FX');
  assert.equal(crypto.winRate, 1);
  assert.equal(fx.winRate, 0);
});

// --- Sanitizer seans bekçisi ---

test('sanitizer: kapalı piyasada sessizlik FEED_STALE üretmez', async () => {
  const clock = { t: Date.UTC(2026, 5, 12, 20, 0) }; // Cuma 16:00 NY — açık
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  const staleEvents = [];
  bus.subscribe('FEED_STALE', (e) => staleEvents.push(e));
  const sanitizer = new Sanitizer({
    bus, now: () => clock.t,
    isMarketOpen: (symbol, d) => isMarketOpen(symbol, d),
  });
  await sanitizer.ingestTick({ source: 'td', symbol: 'EURUSD', price: 1.154, timestamp: clock.t });

  clock.t = Date.UTC(2026, 5, 13, 12, 0); // Cumartesi: 16 saat sessizlik
  await sanitizer.checkStaleness();
  assert.equal(staleEvents.length, 0, 'hafta sonu sessizliği feed ölümü değildir');

  clock.t = Date.UTC(2026, 5, 14, 21, 30); // Pazar 17:30 NY: piyasa açıldı
  await sanitizer.checkStaleness(); // açılışta saat tazelenmişti, henüz stale değil
  assert.equal(staleEvents.length, 0);
  clock.t += 60_000; // açık piyasada 60sn sessizlik → şimdi gerçek stale
  await sanitizer.checkStaleness();
  assert.equal(staleEvents.length, 1, 'açık piyasada sessizlik yakalanır');
});

// --- cTrader hazırlık ---

test('ctrader: token blob çözümü + eksik kimlik teşhisi', () => {
  const blob = Buffer.from(JSON.stringify({ plant: 'pepperstone', environment: 'demo', token: 'abc123' })).toString('base64');
  const provider = new CTraderProvider({
    tokenB64: blob, clientId: undefined, clientSecret: undefined, accessToken: undefined, accountId: undefined,
    logger: silentLogger,
  });
  const r = provider.readiness();
  assert.equal(r.ready, false);
  assert.equal(r.hasToken, true, 'blob icindeki token erisim tokeni olarak çözülür');
  assert.equal(r.environment, 'demo');
  assert.equal(r.plant, 'pepperstone');
  assert.equal(r.endpoint, 'demo.ctraderapi.com:5035');
  assert.ok(r.missing.some((m) => m.includes('CTRADER_CLIENT_ID')));
  assert.ok(!r.missing.some((m) => m.includes('ACCESS_TOKEN')), 'token blob varken access token eksik sayılmaz');
  assert.equal(provider.start(), false, 'tel protokolü olmadan bağlanmaz');

  assert.equal(CTraderProvider.decodeTokenBlob('geçersiz!!!'), null, 'bozuk blob sessizce null');
});
