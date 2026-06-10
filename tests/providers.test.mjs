/**
 * Veri sağlayıcı adaptör testleri (mock fetch — ağ erişimi yok):
 *   - Kraken: kanonik parite eşlemesi (XXBTZUSD → BTCUSD), API hata yayılımı
 *   - Coinbase: ürün eşlemesi, kısmi başarı, tam başarısızlıkta kaynak hatası
 *   - ForexFactory: etki eşlemesi, NY günü filtresi, ülke filtresi, fail-closed
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KrakenProvider } from '../src/data/providers/krakenProvider.mjs';
import { CoinbaseProvider } from '../src/data/providers/coinbaseProvider.mjs';
import { ForexFactoryCalendar } from '../src/data/providers/forexFactoryCalendar.mjs';

const jsonResponse = (body, ok = true, status = 200) => ({
  ok, status, json: async () => body,
});

test('Kraken: kanonik parite adları sistem sembollerine eşlenir', async () => {
  const provider = new KrakenProvider({
    now: () => 1000,
    fetchImpl: async (url) => {
      assert.ok(url.includes('pair=XBTUSD,XRPUSD,SOLUSD'));
      return jsonResponse({
        error: [],
        result: {
          XXBTZUSD: { a: ['61729.2', '1', '1'], b: ['61729.1', '1', '1'], c: ['61729.2', '0.5'] },
          XXRPZUSD: { a: ['1.136', '1', '1'], b: ['1.135', '1', '1'], c: ['1.1357', '34'] },
          SOLUSD: { a: ['65.0', '1', '1'], b: ['64.99', '1', '1'], c: ['64.99', '0.5'] },
        },
      });
    },
  });
  const quotes = await provider.getQuotes(['BTCUSD', 'XRPUSD', 'SOLUSD']);
  assert.equal(quotes.BTCUSD.price, 61729.2);
  assert.equal(quotes.BTCUSD.bid, 61729.1);
  assert.equal(quotes.XRPUSD.price, 1.1357);
  assert.equal(quotes.SOLUSD.ask, 65.0);
  assert.equal(quotes.BTCUSD.timestamp, 1000);
});

test('Kraken: API hatası fırlatılır (kaynak sağlığı izlenebilir)', async () => {
  const provider = new KrakenProvider({
    fetchImpl: async () => jsonResponse({ error: ['EService:Unavailable'], result: {} }),
  });
  await assert.rejects(() => provider.getQuotes(['BTCUSD']), /EService/);
});

test('Kraken: geçersiz fiyatlı sembol sonuçta yer almaz', async () => {
  const provider = new KrakenProvider({
    fetchImpl: async () => jsonResponse({
      error: [],
      result: {
        XXBTZUSD: { a: ['61729.2', '1', '1'], b: ['61729.1', '1', '1'], c: ['61729.2', '0.5'] },
        SOLUSD: { a: ['0', '1', '1'], b: ['64.99', '1', '1'], c: ['64.99', '0.5'] }, // bozuk ask
      },
    }),
  });
  const quotes = await provider.getQuotes(['BTCUSD', 'SOLUSD']);
  assert.ok(quotes.BTCUSD);
  assert.equal(quotes.SOLUSD, undefined);
});

test('Coinbase: ürün eşlemesi ve zaman damgası ayrıştırma', async () => {
  const provider = new CoinbaseProvider({
    fetchImpl: async (url) => {
      if (url.includes('BTC-USD')) {
        return jsonResponse({ bid: '61739.7', ask: '61739.71', price: '61739.7', time: '2026-06-10T00:17:20.929Z' });
      }
      return jsonResponse({ bid: '1.135', ask: '1.136', price: '1.1355', time: '2026-06-10T00:17:21.000Z' });
    },
  });
  const quotes = await provider.getQuotes(['BTCUSD', 'XRPUSD']);
  assert.equal(quotes.BTCUSD.price, 61739.7);
  assert.equal(quotes.BTCUSD.timestamp, Date.parse('2026-06-10T00:17:20.929Z'));
  assert.equal(quotes.XRPUSD.ask, 1.136);
});

test('Coinbase: kısmi başarı tolere edilir, tam başarısızlık fırlatır', async () => {
  const partial = new CoinbaseProvider({
    fetchImpl: async (url) => {
      if (url.includes('BTC-USD')) {
        return jsonResponse({ bid: '61739.7', ask: '61739.71', price: '61739.7', time: '2026-06-10T00:17:20.929Z' });
      }
      return jsonResponse({ message: 'NotFound' }, false, 404);
    },
  });
  const quotes = await partial.getQuotes(['BTCUSD', 'XRPUSD']);
  assert.ok(quotes.BTCUSD);
  assert.equal(quotes.XRPUSD, undefined);

  const allDown = new CoinbaseProvider({
    fetchImpl: async () => jsonResponse({}, false, 503),
  });
  await assert.rejects(() => allDown.getQuotes(['BTCUSD']), /tüm semboller başarısız/);
});

test('ForexFactory: etki eşlemesi + NY günü filtresi + ülke filtresi', async () => {
  // "Bugün" = 2026-06-10 NY (EDT): gün 04:00 UTC'de başlar
  const now = Date.UTC(2026, 5, 10, 14, 0); // 10:00 NY
  const calendar = new ForexFactoryCalendar({
    now: () => now,
    fetchImpl: async () => jsonResponse([
      { title: 'CPI m/m', country: 'USD', date: '2026-06-10T08:30:00-04:00', impact: 'High' },
      { title: 'Crude Oil Inventories', country: 'USD', date: '2026-06-10T10:30:00-04:00', impact: 'Medium' },
      { title: 'Bank Lending y/y', country: 'JPY', date: '2026-06-10T19:50:00-04:00', impact: 'High' }, // ülke dışı
      { title: 'Bank Holiday', country: 'USD', date: '2026-06-10T09:00:00-04:00', impact: 'Holiday' },  // etki dışı
      { title: 'FOMC Statement', country: 'USD', date: '2026-06-11T14:00:00-04:00', impact: 'High' },   // yarın
      { title: 'OPEC Meetings', country: 'All', date: '2026-06-10T06:15:00-04:00', impact: 'Medium' },  // 'All' dahil
    ]),
  });
  const events = await calendar.fetchToday();
  const names = events.map((e) => e.eventName).sort();
  assert.deepEqual(names, ['All OPEC Meetings', 'USD CPI m/m', 'USD Crude Oil Inventories']);
  const cpi = events.find((e) => e.eventName === 'USD CPI m/m');
  assert.equal(cpi.impact, 'HIGH');
  assert.equal(cpi.scheduledAt, Date.parse('2026-06-10T08:30:00-04:00'));
});

test('ForexFactory: HTTP hatası fırlatılır (Oracle fail-closed devralır)', async () => {
  const calendar = new ForexFactoryCalendar({
    fetchImpl: async () => jsonResponse({}, false, 503),
  });
  await assert.rejects(() => calendar.fetchToday(), /HTTP 503/);
});
