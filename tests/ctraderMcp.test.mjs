/**
 * cTrader MCP istemci testleri (mock fetch — ağ erişimi yok):
 *   - SSE / düz JSON gövde ayrıştırma
 *   - 10⁵ fiyat ölçeği çözümü (spot + trendbar)
 *   - Oturum düşmesinde şeffaf yeniden başlatma + tekrar
 *   - Feed: forming bar atlama, dedupe, kapalı seans, sembol çözümleme
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CTraderMcp, CTraderMcpFeed } from '../src/data/providers/ctraderMcp.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function sse(obj) {
  return `event: message\ndata: ${JSON.stringify(obj)}\n\n`;
}
function toolResult(id, payload, isError = false) {
  return sse({
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], isError },
  });
}

/** Sahte MCP sunucusu: initialize + tools/call senaryoları. */
function makeFetch({ tools = {}, failFirstSession = false } = {}) {
  let sessionCount = 0;
  const calls = [];
  const fetchImpl = async (url, { headers, body }) => {
    const req = JSON.parse(body);
    calls.push(req);
    if (req.method === 'initialize') {
      sessionCount += 1;
      return {
        ok: true, status: 200,
        headers: { get: (h) => (h === 'mcp-session-id' ? `oturum-${sessionCount}` : null) },
        text: async () => sse({ jsonrpc: '2.0', id: req.id, result: { serverInfo: { name: 'test' } } }),
      };
    }
    if (req.method === 'notifications/initialized') {
      return { ok: true, status: 202, headers: { get: () => null }, text: async () => '' };
    }
    // İlk oturum düşmüş senaryosu: eski oturumla gelen çağrıya 404
    if (failFirstSession && headers['mcp-session-id'] === 'oturum-1') {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => '' };
    }
    const handler = tools[req.params?.name];
    if (!handler) {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => toolResult(req.id, 'bilinmeyen araç', true) };
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      text: async () => toolResult(req.id, handler(req.params.arguments ?? {})),
    };
  };
  return { fetchImpl, calls };
}

test('parseBody: SSE ve düz JSON gövdeleri çözülür', () => {
  assert.deepEqual(CTraderMcp.parseBody('{"a":1}'), { a: 1 });
  assert.deepEqual(CTraderMcp.parseBody('event: message\ndata: {"b":2}\n\n'), { b: 2 });
  assert.throws(() => CTraderMcp.parseBody('event: message\n\n'), /çözülemedi/);
});

test('spotPrices: 10⁵ ölçek çözümü + geçersiz fiyat elenir', async () => {
  const { fetchImpl } = makeFetch({
    tools: {
      get_spot_prices: () => ({
        prices: [
          { symbolId: 1, bid: 115456, ask: 115466, timestamp: 1000 },
          { symbolId: 10013, bid: 728670000, ask: 728710000, timestamp: 2000 },
          { symbolId: 99, bid: 0, ask: 100 }, // geçersiz: elenmeli
        ],
      }),
    },
  });
  const mcp = new CTraderMcp({ tokenB64: 'test', fetchImpl, logger: silentLogger });
  const prices = await mcp.spotPrices([1, 10013, 99]);
  assert.equal(prices.size, 2);
  assert.ok(Math.abs(prices.get(1).bid - 1.15456) < 1e-9);
  assert.ok(Math.abs(prices.get(10013).ask - 7287.1) < 1e-9);
});

test('trendbars: ölçek + sıralama + 720h aralık kısıtlaması', async () => {
  let seenArgs = null;
  const { fetchImpl } = makeFetch({
    tools: {
      get_trendbars: (args) => {
        seenArgs = args;
        return {
          trendbars: [
            { timestamp: 2000, open: 728000000, high: 729000000, low: 727000000, close: 728500000, volume: 10 },
            { timestamp: 1000, open: 727000000, high: 728200000, low: 726800000, close: 728000000, volume: 8 },
          ],
        };
      },
    },
  });
  const mcp = new CTraderMcp({ tokenB64: 'test', fetchImpl, logger: silentLogger });
  const toMs = 1000 * 60 * 60 * 1000;
  const bars = await mcp.trendbars(10013, 'M_15', { fromMs: 0, toMs }); // 1000h > 720h
  assert.equal(bars.length, 2);
  assert.ok(bars[0].openTime < bars[1].openTime, 'eski → yeni sıralanır');
  assert.ok(Math.abs(bars[0].open - 7270) < 1e-9);
  assert.equal(Number(seenArgs.fromTimestamp), toMs - 720 * 60 * 60 * 1000, 'aralık 720h ile sınırlanır');
});

test('oturum düşmesi: 404 → şeffaf yeniden başlatma + tekrar (tek sefer)', async () => {
  const { fetchImpl, calls } = makeFetch({
    failFirstSession: true,
    tools: { get_balance: () => ({ balance: 60000 }) },
  });
  const mcp = new CTraderMcp({ tokenB64: 'test', fetchImpl, logger: silentLogger });
  const result = await mcp.balance();
  assert.equal(result.balance, 60000);
  assert.equal(mcp.telemetry.sessionRestarts, 1);
  assert.equal(calls.filter((c) => c.method === 'initialize').length, 2, 'iki oturum açılışı');
});

test('callTool: isError yanıtı fırlatılır', async () => {
  const { fetchImpl } = makeFetch({ tools: {} });
  const mcp = new CTraderMcp({ tokenB64: 'test', fetchImpl, logger: silentLogger });
  await assert.rejects(() => mcp.callTool('olmayan_arac'), /bilinmeyen araç/);
});

test('feed: sembol çözümleme + forming bar atlama + dedupe + kapalı seans', async () => {
  // Pazartesi 12:07 UTC — FX açık
  let now = Date.UTC(2026, 5, 8, 12, 7);
  const M15 = 15 * 60 * 1000;
  const mkBar = (t, base) => ({
    timestamp: t, open: base, high: base + 50000, low: base - 50000, close: base + 20000, volume: 5,
  });
  const { fetchImpl } = makeFetch({
    tools: {
      get_symbols: () => [
        { symbolId: 1, symbolName: 'EURUSD' },
        { symbolId: 10013, symbolName: 'US500' },
      ],
      get_trendbars: () => ({
        trendbars: [
          mkBar(Date.UTC(2026, 5, 8, 11, 30), 115400),
          mkBar(Date.UTC(2026, 5, 8, 11, 45), 115420),
          mkBar(Date.UTC(2026, 5, 8, 12, 0), 115440), // forming: kapanışı 12:15 > now
        ],
      }),
      get_spot_prices: (args) => ({
        prices: args.symbolId.map((id) => ({ symbolId: id, bid: 115456, ask: 115466, timestamp: now })),
      }),
    },
  });
  const mcp = new CTraderMcp({ tokenB64: 'test', fetchImpl, logger: silentLogger, now: () => now });
  const bars = [];
  const quotes = [];
  const feed = new CTraderMcpFeed({
    mcp, symbols: ['EURUSD', 'US500'], logger: silentLogger, now: () => now,
    config: { spotPollMs: 10_000, barPollMs: 60_000 },
    onBar: (b) => bars.push(b),
    onQuote: (q) => quotes.push(q),
  });
  const ids = await feed.resolveSymbols();
  assert.equal(ids.get('EURUSD'), 1);
  assert.equal(ids.get('US500'), 10013);

  await feed.pollBars();
  const eurBars = bars.filter((b) => b.symbol === 'EURUSD');
  assert.equal(eurBars.length, 2, 'forming bar yayılmaz');
  await feed.pollBars();
  assert.equal(bars.filter((b) => b.symbol === 'EURUSD').length, 2, 'dedupe');

  await feed.pollSpot();
  assert.equal(quotes.length, 2, 'iki sembol için spot kotasyonu');
  assert.ok(Math.abs(quotes[0].bid - 1.15456) < 1e-9);

  // Cumartesi: hem bar hem spot yoklaması susar
  now = Date.UTC(2026, 5, 13, 12, 0);
  const beforeBars = bars.length;
  const beforeQuotes = quotes.length;
  await feed.pollBars();
  await feed.pollSpot();
  assert.equal(bars.length, beforeBars, 'kapalı seansta bar yok');
  assert.equal(quotes.length, beforeQuotes, 'kapalı seansta spot yok');
});

test('warmup: oluşmakta olan son bar ısınmaya girmez', async () => {
  const now = Date.UTC(2026, 5, 8, 12, 7);
  const H4 = 4 * 60 * 60 * 1000;
  const { fetchImpl } = makeFetch({
    tools: {
      get_symbols: () => [{ symbolId: 1, symbolName: 'EURUSD' }],
      get_trendbars: (args) => ({
        trendbars: args.period === 'H_4'
          ? [
            { timestamp: Date.UTC(2026, 5, 8, 4, 0), open: 115000, high: 115500, low: 114800, close: 115300, volume: 1 },
            { timestamp: Date.UTC(2026, 5, 8, 8, 0), open: 115300, high: 115600, low: 115200, close: 115400, volume: 1 }, // forming: 12:00 kapanışı... 8+4=12:00 <= 12:07 KAPANMIŞ
            { timestamp: Date.UTC(2026, 5, 8, 12, 0), open: 115400, high: 115600, low: 115300, close: 115500, volume: 1 }, // forming: kapanış 16:00 > now
          ]
          : [],
      }),
    },
  });
  const mcp = new CTraderMcp({ tokenB64: 'test', fetchImpl, logger: silentLogger, now: () => now });
  const feed = new CTraderMcpFeed({
    mcp, symbols: ['EURUSD'], logger: silentLogger, now: () => now,
    config: { spotPollMs: 10_000, barPollMs: 60_000 },
  });
  await feed.resolveSymbols();
  const { bars4h } = await feed.fetchWarmup('EURUSD');
  assert.equal(bars4h.length, 2, 'son (oluşmakta olan) 4H bar elenir');
  assert.equal(bars4h.at(-1).openTime, Date.UTC(2026, 5, 8, 8, 0));
});
