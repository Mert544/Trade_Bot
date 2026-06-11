/**
 * Coinbase Exchange kamu Ticker API adaptörü (doğrulama kaynağı).
 * Anahtarsız; sembol başına bir istek, paralel çekilir.
 */

import { MarketDataProvider, fetchJson } from './marketDataProvider.mjs';

const PRODUCTS = {
  BTCUSD: 'BTC-USD',
  XRPUSD: 'XRP-USD',
  SOLUSD: 'SOL-USD',
  ETHUSD: 'ETH-USD',
};

export class CoinbaseProvider extends MarketDataProvider {
  #baseUrl;
  #fetchImpl;
  #timeoutMs;
  #now;

  constructor({
    baseUrl = 'https://api.exchange.coinbase.com',
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

  get name() { return 'coinbase'; }

  async getQuotes(symbols) {
    const supported = symbols.filter((s) => PRODUCTS[s]);
    const results = await Promise.allSettled(supported.map(async (symbol) => {
      const data = await fetchJson(`${this.#baseUrl}/products/${PRODUCTS[symbol]}/ticker`, {
        fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs,
      });
      const bid = Number(data.bid);
      const ask = Number(data.ask);
      const price = Number(data.price);
      const timestamp = data.time ? Date.parse(data.time) : this.#now();
      if (![bid, ask, price].every((v) => Number.isFinite(v) && v > 0)) {
        throw new Error(`coinbase geçersiz kotasyon: ${symbol}`);
      }
      return [symbol, { bid, ask, price, timestamp }];
    }));

    const quotes = Object.fromEntries(
      results.filter((r) => r.status === 'fulfilled').map((r) => r.value),
    );
    // Tüm semboller başarısızsa kaynak düzeyi hata: sağlayıcı sağlıksız
    if (supported.length > 0 && Object.keys(quotes).length === 0) {
      const firstErr = results.find((r) => r.status === 'rejected');
      throw new Error(`coinbase tüm semboller başarısız: ${firstErr?.reason?.message}`);
    }
    return quotes;
  }
}

export default CoinbaseProvider;
