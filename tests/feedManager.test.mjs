/**
 * FeedManager testleri (sahte sağlayıcılarla):
 *   - Temiz tick onQuote'a akar; kirli tick yukarı sızamaz.
 *   - Çapraz kaynak sapması karantinaya düşer.
 *   - 3m bar agregasyonu kapanışta onBar tetikler.
 *   - Birincil kaynak hatası turu boş geçirir, çökertmez; sessizlik FEED_STALE üretir.
 *   - Doğrulama kaynağı hatası kuorumsuz devam eder.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { Sanitizer } from '../src/data/sanitizer.mjs';
import { FeedManager } from '../src/data/feedManager.mjs';
import { BarAggregator } from '../src/data/barAggregator.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

class FakeProvider {
  constructor(name) { this.name = name; this.quotes = {}; this.fail = false; }
  async getQuotes() {
    if (this.fail) throw new Error(`${this.name} down`);
    return structuredClone(this.quotes);
  }
}

function setup() {
  const clock = { t: Date.UTC(2026, 5, 10, 12, 0) };
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  const busEvents = [];
  bus.subscribe('DATA_QUARANTINE', (e) => busEvents.push(e));
  bus.subscribe('FEED_STALE', (e) => busEvents.push(e));
  const sanitizer = new Sanitizer({ bus, now: () => clock.t });
  const primary = new FakeProvider('fake-primary');
  const verification = new FakeProvider('fake-verify');
  const hooks = { quotes: [], bars: [], sweeps: [] };
  const feed = new FeedManager({
    primary, verification, sanitizer,
    symbols: ['BTCUSD'],
    now: () => clock.t,
    logger: silentLogger,
    onQuote: (q) => hooks.quotes.push(q),
    onBar: (b) => hooks.bars.push(b),
    onSweep: (s) => hooks.sweeps.push(s),
  });
  const setPrice = (price, { crossPrice = price } = {}) => {
    primary.quotes = { BTCUSD: { bid: price - 0.5, ask: price + 0.5, price, timestamp: clock.t } };
    verification.quotes = { BTCUSD: { bid: crossPrice - 0.5, ask: crossPrice + 0.5, price: crossPrice, timestamp: clock.t } };
  };
  return { clock, feed, primary, verification, hooks, busEvents, setPrice };
}

test('temiz tick onQuote\'a akar; spread ve fiyat taşınır', async () => {
  const { clock, feed, hooks, setPrice } = setup();
  setPrice(61000);
  await feed.poll();
  clock.t += 5000;
  setPrice(61010);
  await feed.poll();

  assert.equal(hooks.quotes.length, 2);
  assert.equal(hooks.quotes[1].price, 61010);
  assert.ok(Math.abs(hooks.quotes[1].spread - 1.0) < 1e-9);
  assert.equal(feed.getTelemetry().verdicts.CLEAN, 2);
});

test('çapraz kaynak sapması: tick karantinaya düşer, yukarı sızmaz', async () => {
  const { clock, feed, hooks, busEvents, setPrice } = setup();
  // Pencere oluştur
  for (let i = 0; i < 10; i += 1) {
    setPrice(61000 + i);
    await feed.poll();
    clock.t += 5000;
  }
  const cleanCount = hooks.quotes.length;
  // Birincil 61010 derken doğrulama 62000 diyor (sapma > tolerans)
  setPrice(61010, { crossPrice: 62000 });
  await feed.poll();

  assert.equal(hooks.quotes.length, cleanCount, 'karantinalı tick onQuote tetiklemez');
  assert.equal(feed.getTelemetry().verdicts.QUARANTINED, 1);
  assert.ok(busEvents.some((e) => e.type === 'DATA_QUARANTINE'));
});

test('3m bar agregasyonu: sınır geçişinde bar kapanır ve onBar tetiklenir', async () => {
  const { clock, feed, hooks, setPrice } = setup();
  // 3m hizalı başlangıç
  clock.t = Math.floor(clock.t / 180_000) * 180_000;
  const prices = [61000, 61020, 60990, 61015];
  for (const p of prices) {
    setPrice(p);
    await feed.poll();
    clock.t += 45_000; // 4 tick = 180s → bir sonraki poll yeni slotta
  }
  setPrice(61030); // yeni 3m slotu: önceki bar kapanır
  await feed.poll();

  assert.equal(hooks.bars.length, 1);
  const bar = hooks.bars[0];
  assert.equal(bar.open, 61000);
  assert.equal(bar.high, 61020);
  assert.equal(bar.low, 60990);
  assert.equal(bar.close, 61015);
  assert.equal(bar.ticks, 4);
  assert.equal(bar.closeTime - bar.openTime, 180_000);
});

test('birincil kaynak hatası: tur boş geçer, uzayan sessizlik FEED_STALE üretir', async () => {
  const { clock, feed, primary, busEvents, setPrice } = setup();
  setPrice(61000);
  await feed.poll(); // sağlıklı tur — staleness saati işlemeye başlar

  primary.fail = true;
  clock.t += 20_000; // staleFeedTimeoutMs (15s) üstü
  await feed.poll(); // hata turu — çökmez

  assert.equal(feed.getTelemetry().primaryErrors, 1);
  assert.ok(busEvents.some((e) => e.type === 'FEED_STALE'), 'sessiz feed FEED_STALE üretmeli');
});

test('doğrulama kaynağı hatası: kuorumsuz devam, temiz tick yine akar', async () => {
  const { clock, feed, verification, hooks, setPrice } = setup();
  setPrice(61000);
  verification.fail = true;
  await feed.poll();

  assert.equal(feed.getTelemetry().verificationErrors, 1);
  assert.equal(hooks.quotes.length, 1, 'doğrulama düşse de birincil temiz akış sürer');
});

test('BarAggregator: epoch hizalı sınırlar, ilerleyen bar görünümü', () => {
  const agg = new BarAggregator({ intervalMs: 180_000 });
  const t0 = 1_800_000; // tam slot sınırı
  assert.equal(agg.push('X', 100, t0), null);
  assert.equal(agg.push('X', 105, t0 + 60_000), null);
  assert.deepEqual(agg.inProgress('X'), { open: 100, high: 105, low: 100, close: 105, ticks: 2 });
  const closed = agg.push('X', 103, t0 + 180_000);
  assert.equal(closed.open, 100);
  assert.equal(closed.close, 105);
  assert.equal(closed.openTime, t0);
});
