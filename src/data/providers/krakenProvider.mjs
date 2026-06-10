/**
 * Kraken kamu Ticker API adaptörü (birincil kaynak).
 * Anahtarsız; tek istekte tüm watchlist çekilir.
 *
 * Kraken pariteleri kendi kanonik adlarıyla döner (BTC → XXBTZUSD gibi);
 * eşleme tablosu sistem sembollerine çevirir.
 */

import { MarketDataProvider, fetchJson } from './marketDataProvider.mjs';

const PAIRS = {
  BTCUSD: { query: 'XBTUSD', aliases: ['XXBTZUSD', 'XBTUSD', 'BTCUSD'] },
  XRPUSD: { query: 'XRPUSD', aliases: ['XXRPZUSD', 'XRPUSD'] },
  SOLUSD: { query: 'SOLUSD', aliases: ['SOLUSD'] },
  ETHUSD: { query: 'ETHUSD', aliases: ['XETHZUSD', 'ETHUSD'] },
};

export class KrakenProvider extends MarketDataProvider {
  #baseUrl;
  #fetchImpl;
  #timeoutMs;
  #now;

  constructor({
    baseUrl = 'https://api.kraken.com/0/public',
    fetchImpl = fetch,
    timeoutMs = 8000,
    now = () => Date.now(),
  } = {}) {
    super();
    this.#baseUrl = baseUrl;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
  }

  get name() { return 'kraken'; }

  async getQuotes(symbols) {
    const supported = symbols.filter((s) => PAIRS[s]);
    if (supported.length === 0) return {};
    const pairQuery = supported.map((s) => PAIRS[s].query).join(',');
    const data = await fetchJson(`${this.#baseUrl}/Ticker?pair=${pairQuery}`, {
      fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs,
    });
    if (Array.isArray(data.error) && data.error.length > 0) {
      throw new Error(`kraken API hatası: ${data.error.join('; ')}`);
    }

    const quotes = {};
    const timestamp = this.#now();
    for (const symbol of supported) {
      const key = PAIRS[symbol].aliases.find((a) => data.result?.[a]);
      const t = key ? data.result[key] : null;
      if (!t) continue; // erişilemeyen sembol sonuçta yer almaz
      const bid = Number(t.b?.[0]);
      const ask = Number(t.a?.[0]);
      const price = Number(t.c?.[0]); // son işlem fiyatı
      if (![bid, ask, price].every((v) => Number.isFinite(v) && v > 0)) continue;
      quotes[symbol] = { bid, ask, price, timestamp };
    }
    return quotes;
  }
}

export default KrakenProvider;
