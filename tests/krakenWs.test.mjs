/**
 * Faz D testleri (sahte WebSocket — ağ erişimi yok):
 *   - KrakenWsProvider: abonelik mesajları, trade/ticker ayrıştırma,
 *     sembol eşlemesi, yeniden bağlanma planlaması
 *   - FeedManager push modu: WS tick → sanitasyon → onQuote/onBar;
 *     bayat doğrulama fiyatında kuorum devre dışı
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KrakenWsProvider } from '../src/data/providers/krakenWsProvider.mjs';
import { FeedManager } from '../src/data/feedManager.mjs';
import { Sanitizer } from '../src/data/sanitizer.mjs';
import { ProtocolBus } from '../src/core/protocolBus.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** addEventListener tabanlı sahte WebSocket (Node yerleşik API yüzeyi). */
class FakeWebSocket {
  static instances = [];
  sent = [];
  #listeners = new Map();

  constructor(url) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, fn) {
    if (!this.#listeners.has(type)) this.#listeners.set(type, []);
    this.#listeners.get(type).push(fn);
  }

  send(data) { this.sent.push(JSON.parse(data)); }
  close() { this.emit('close', {}); }
  emit(type, event) {
    for (const fn of this.#listeners.get(type) ?? []) fn(event);
  }
  message(obj) { this.emit('message', { data: JSON.stringify(obj) }); }
}

function makeProvider({ onTick = () => {} } = {}) {
  FakeWebSocket.instances = [];
  const provider = new KrakenWsProvider({
    symbols: ['BTCUSD', 'XRPUSD'],
    onTick,
    logger: silentLogger,
    WebSocketImpl: FakeWebSocket,
    config: { url: 'wss://test', reconnectBaseMs: 1, reconnectMaxMs: 4 },
  });
  provider.start();
  const ws = FakeWebSocket.instances.at(-1);
  ws.emit('open', {});
  return { provider, ws };
}

test('kraken-ws: açılışta trade + ticker aboneliği gönderilir', () => {
  const { provider, ws } = makeProvider();
  assert.equal(ws.sent.length, 2);
  const channels = ws.sent.map((m) => m.params.channel).sort();
  assert.deepEqual(channels, ['ticker', 'trade']);
  assert.deepEqual(ws.sent[0].params.symbol, ['BTC/USD', 'XRP/USD']);
  provider.stop();
});

test('kraken-ws: trade mesajı sistem sembolüyle tick üretir, ticker spread sağlar', () => {
  const ticks = [];
  const { provider, ws } = makeProvider({ onTick: (t) => ticks.push(t) });

  // Önce ticker → bid/ask bilinir
  ws.message({ channel: 'ticker', data: [{ symbol: 'BTC/USD', bid: 61729.1, ask: 61729.3 }] });
  // Sonra trade → tick
  ws.message({
    channel: 'trade',
    data: [{ symbol: 'BTC/USD', price: 61729.2, qty: 0.01, timestamp: '2026-06-10T12:00:00.000000Z' }],
  });

  assert.equal(ticks.length, 1);
  assert.equal(ticks[0].symbol, 'BTCUSD');
  assert.equal(ticks[0].price, 61729.2);
  assert.equal(ticks[0].bid, 61729.1);
  assert.equal(ticks[0].ask, 61729.3);
  assert.equal(ticks[0].timestamp, Date.parse('2026-06-10T12:00:00.000Z'));
  assert.equal(provider.telemetry.trades, 1);
  provider.stop();
});

test('kraken-ws: heartbeat/status/bilinmeyen sembol sessizce yutulur', () => {
  const ticks = [];
  const { provider, ws } = makeProvider({ onTick: (t) => ticks.push(t) });
  ws.message({ channel: 'heartbeat' });
  ws.message({ channel: 'status', data: [{ system: 'online' }] });
  ws.message({ channel: 'trade', data: [{ symbol: 'DOGE/USD', price: 0.1 }] });
  ws.emit('message', { data: 'bozuk json{{' });
  assert.equal(ticks.length, 0);
  assert.equal(provider.telemetry.parseErrors, 1);
  provider.stop();
});

test('kraken-ws: kopuşta yeniden bağlanır (stop sonrası bağlanmaz)', async () => {
  const { provider, ws } = makeProvider();
  const before = FakeWebSocket.instances.length;
  ws.emit('close', {});
  await new Promise((r) => setTimeout(r, 20)); // backoff 1-4ms + jitter
  assert.equal(FakeWebSocket.instances.length, before + 1, 'yeni bağlantı denenmiş olmalı');
  assert.equal(provider.telemetry.reconnects, 1);

  provider.stop();
  const after = FakeWebSocket.instances.length;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(FakeWebSocket.instances.length, after, 'stop sonrası yeni bağlantı yok');
});

function makePushFeed() {
  const clock = { t: Date.UTC(2026, 5, 10, 12, 0) };
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  const busEvents = [];
  bus.subscribe('DATA_QUARANTINE', (e) => busEvents.push(e));
  const sanitizer = new Sanitizer({ bus, now: () => clock.t });
  const verification = {
    name: 'fake-verify',
    quotes: {},
    async getQuotes() { return structuredClone(this.quotes); },
  };
  const hooks = { quotes: [], bars: [] };
  const feed = new FeedManager({
    primary: { name: 'unused', getQuotes: async () => ({}) },
    verification,
    sanitizer,
    symbols: ['BTCUSD'],
    mode: 'push',
    config: { pollIntervalMs: 5000, pollIntervalPushModeMs: 10_000, barIntervalMs: 180_000 },
    now: () => clock.t,
    logger: silentLogger,
    onQuote: (q) => hooks.quotes.push(q),
    onBar: (b) => hooks.bars.push(b),
  });
  return { clock, feed, verification, hooks, busEvents };
}

test('push modu: WS tick sanitasyondan geçip onQuote/onBar üretir', async () => {
  const { clock, feed, verification, hooks } = makePushFeed();
  verification.quotes = { BTCUSD: { bid: 61000, ask: 61001, price: 61000.5, timestamp: clock.t } };
  await feed.poll(); // doğrulama fiyatı tazelenir

  clock.t = Math.floor(clock.t / 180_000) * 180_000; // bar hizası
  for (let i = 0; i < 5; i += 1) {
    await feed.ingestPush({
      symbol: 'BTCUSD', price: 61000 + i, bid: 60999 + i, ask: 61001 + i,
      timestamp: clock.t,
    });
    clock.t += 45_000;
  }

  assert.equal(hooks.quotes.length, 5);
  assert.equal(feed.getTelemetry().pushTicks, 5);
  assert.equal(hooks.bars.length, 1, '4 tick sonrası 5.si yeni 3m slotunda bar kapatır');
  assert.equal(hooks.bars[0].ticks, 4);
});

test('push modu: doğrulama fiyatı bayatsa kuorum kullanılmaz (iğne BAD_TICK olur)', async () => {
  const { clock, feed, verification, hooks } = makePushFeed();
  verification.quotes = { BTCUSD: { bid: 61000, ask: 61001, price: 61000.5, timestamp: clock.t } };
  await feed.poll();

  // Pencereyi doldur
  for (let i = 0; i < 30; i += 1) {
    clock.t += 1000;
    await feed.ingestPush({ symbol: 'BTCUSD', price: 61000 + (i % 3), bid: 61000, ask: 61001, timestamp: clock.t });
  }
  // Doğrulama fiyatı bayatlasın (>2×10sn), iğne gelsin
  clock.t += 25_000;
  const result = await feed.ingestPush({ symbol: 'BTCUSD', price: 64000, bid: 61000, ask: 61001, timestamp: clock.t });
  assert.equal(result.verdict, 'BAD_TICK', 'kuorumsuz iğne muhafazakâr tarafta imha edilir');
  const clean = hooks.quotes.filter((q) => q.price === 64000);
  assert.equal(clean.length, 0);
});
