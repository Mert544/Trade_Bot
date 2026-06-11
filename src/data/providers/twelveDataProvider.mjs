/**
 * Twelve Data adaptörü (opsiyonel — API anahtarı gerektirir).
 *
 * Doküman 4.1'de birincil kaynak örneği olarak anılır; anahtar TWELVEDATA_API_KEY
 * ortam değişkeniyle verilirse kullanılabilir. Ücretsiz planda /price ucu
 * bid/ask vermez; spread için kayan tahmin kullanılır (fiyatın %0,02'si) —
 * bu nedenle Twelve Data tek başına değil, bid/ask veren bir kaynakla
 * eşleştirilerek kullanılmalıdır.
 */

import { MarketDataProvider, fetchJson } from './marketDataProvider.mjs';

const SYMBOL_MAP = {
  BTCUSD: 'BTC/USD',
  XRPUSD: 'XRP/USD',
  SOLUSD: 'SOL/USD',
  ETHUSD: 'ETH/USD',
};

export class TwelveDataProvider extends MarketDataProvider {
  #baseUrl;
  #apiKey;
  #fetchImpl;
  #timeoutMs;
  #now;
  #syntheticSpreadPct;

  constructor({
    apiKey = process.env.TWELVEDATA_API_KEY,
    baseUrl = 'https://api.twelvedata.com',
    fetchImpl = fetch,
    timeoutMs = 8000,
    now = () => Date.now(),
    syntheticSpreadPct = 0.02,
  } = {}) {
    super();
    if (!apiKey) throw new Error('TwelveDataProvider için TWELVEDATA_API_KEY gerekli');
    this.#apiKey = apiKey;
    this.#baseUrl = baseUrl;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
    this.#syntheticSpreadPct = syntheticSpreadPct;
  }

  get name() { return 'twelvedata'; }

  async getQuotes(symbols) {
    const supported = symbols.filter((s) => SYMBOL_MAP[s]);
    if (supported.length === 0) return {};
    const query = supported.map((s) => SYMBOL_MAP[s]).join(',');
    const data = await fetchJson(
      `${this.#baseUrl}/price?symbol=${encodeURIComponent(query)}&apikey=${this.#apiKey}`,
      { fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs },
    );
    if (data.status === 'error') throw new Error(`twelvedata API hatası: ${data.message}`);

    const quotes = {};
    const timestamp = this.#now();
    for (const symbol of supported) {
      // Tek sembol istenirse düz nesne, çoklu istekte sembol-anahtarlı nesne döner
      const entry = supported.length === 1 ? data : data[SYMBOL_MAP[symbol]];
      const price = Number(entry?.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const halfSpread = price * (this.#syntheticSpreadPct / 100) / 2;
      quotes[symbol] = { bid: price - halfSpread, ask: price + halfSpread, price, timestamp };
    }
    return quotes;
  }
}

export default TwelveDataProvider;
