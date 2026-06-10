/**
 * Faz 3 Kabul Testleri — Veri sanitasyon hattı:
 *   - Bad tick / gerçek sweep ayrımı çapraz kaynakla çalışır.
 *   - OHLC yapısal doğrulama ve karantina.
 *   - Bayatlık bekçisi FEED_STALE yayınlar.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { Sanitizer, TICK_VERDICT, validateBarStructure, madZScore } from '../src/data/sanitizer.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function setup() {
  const clock = { t: 1_000_000_000 };
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  const events = [];
  bus.subscribe('DATA_QUARANTINE', (e) => events.push(e));
  bus.subscribe('FEED_STALE', (e) => events.push(e));
  const sanitizer = new Sanitizer({ bus, now: () => clock.t });
  return { clock, bus, events, sanitizer };
}

async function warmUp(sanitizer, clock, { source = 'primary', symbol = 'BTCUSD', base = 100, n = 30 } = {}) {
  for (let i = 0; i < n; i += 1) {
    clock.t += 100;
    await sanitizer.ingestTick({
      source, symbol,
      price: base + Math.sin(i) * 0.01, // küçük doğal salınım
      timestamp: clock.t,
      crossSourcePrice: base + Math.sin(i) * 0.01,
    });
  }
}

test('yapısal doğrulama: OHLC tutarsızlığı yakalanır', () => {
  assert.deepEqual(validateBarStructure({ open: 100, high: 101, low: 99, close: 100.5, timestamp: 1 }), []);
  assert.ok(validateBarStructure({ open: 100, high: 99.5, low: 99, close: 100, timestamp: 1 })
    .some((e) => e.includes('High')));
  assert.ok(validateBarStructure({ open: 100, high: 101, low: 100.5, close: 101, timestamp: 1 })
    .some((e) => e.includes('Low')));
  assert.ok(validateBarStructure({ open: -5, high: 101, low: 99, close: 100, timestamp: 1 })
    .some((e) => e.includes('negatif')));
  assert.ok(validateBarStructure({ open: 100, high: 101, low: 99, close: 100, timestamp: 5 }, 10)
    .some((e) => e.includes('monoton')));
});

test('madZScore: medyandan aşırı sapan değer yüksek skor alır', () => {
  const window = [100, 100.1, 99.9, 100.05, 99.95, 100.02, 99.98, 100.01];
  assert.ok(madZScore(100.0, window) < 1);
  assert.ok(madZScore(150, window) > 6);
});

test('bad tick: tek kaynaktaki iğne imha edilir (BAD_TICK + karantina)', async () => {
  const { clock, events, sanitizer } = setup();
  await warmUp(sanitizer, clock);

  clock.t += 100;
  const result = await sanitizer.ingestTick({
    source: 'primary', symbol: 'BTCUSD',
    price: 150,                 // iğne
    timestamp: clock.t,
    crossSourcePrice: 100.0,    // ikinci kaynak görmüyor
    spread: 0.01,
  });
  assert.equal(result.verdict, TICK_VERDICT.BAD_TICK);
  assert.ok(events.some((e) => e.type === 'DATA_QUARANTINE' && e.payload.reason.includes('bad tick')));
});

test('gerçek sweep: iğne ikinci kaynakta da varsa REAL_SWEEP (fırsat sinyali)', async () => {
  const { clock, sanitizer } = setup();
  await warmUp(sanitizer, clock);

  clock.t += 100;
  const result = await sanitizer.ingestTick({
    source: 'primary', symbol: 'BTCUSD',
    price: 103,                  // sert hareket (likidite süpürmesi)
    timestamp: clock.t,
    crossSourcePrice: 103.005,   // broker feed'i de aynı hareketi görüyor
    spread: 0.01,
  });
  assert.equal(result.verdict, TICK_VERDICT.REAL_SWEEP, 'çapraz teyitli iğne fırsat olarak etiketlenmeli');
});

test('kaynaklar arası sapma > 3×spread → karantina', async () => {
  const { clock, events, sanitizer } = setup();
  await warmUp(sanitizer, clock);
  clock.t += 100;
  const result = await sanitizer.ingestTick({
    source: 'primary', symbol: 'BTCUSD',
    price: 100.0,
    timestamp: clock.t,
    crossSourcePrice: 100.2, // sapma 0.2 > 3×0.01
    spread: 0.01,
  });
  assert.equal(result.verdict, TICK_VERDICT.QUARANTINED);
  assert.ok(events.some((e) => e.payload.reason.includes('sapma')));
});

test('monoton olmayan timestamp karantinaya alınır', async () => {
  const { clock, sanitizer } = setup();
  clock.t += 100;
  await sanitizer.ingestTick({ source: 'p', symbol: 'X', price: 100, timestamp: 1000 });
  const result = await sanitizer.ingestTick({ source: 'p', symbol: 'X', price: 100, timestamp: 999 });
  assert.equal(result.verdict, TICK_VERDICT.QUARANTINED);
});

test('bayatlık bekçisi: sessiz feed FEED_STALE üretir (tek sefer)', async () => {
  const { clock, events, sanitizer } = setup();
  clock.t += 100;
  await sanitizer.ingestTick({ source: 'primary', symbol: 'BTCUSD', price: 100, timestamp: clock.t });

  clock.t += 20_000; // 15sn eşiğin üstü
  await sanitizer.checkStaleness();
  await sanitizer.checkStaleness(); // ikinci kontrol mükerrer yayın üretmemeli

  const stale = events.filter((e) => e.type === 'FEED_STALE');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].payload.symbol, 'BTCUSD');
});
