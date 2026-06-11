/**
 * Kraken kamu OHLC geçmiş adaptörü (ücretsiz, anahtarsız).
 *
 * Analiz motorunun açılış ısınması için tarihsel bar çeker: 4H bias ve
 * 15M anlatı katmanları, sistem açılır açılmaz bağlam sahibi olur —
 * soğuk başlangıçta günlerce bar biriktirmek gerekmez.
 *
 * Kraken ücretsiz uçta interval başına son ~720 barı verir
 * (4H × 720 ≈ 120 gün, 15M × 720 ≈ 7,5 gün) — ısınma için fazlasıyla yeterli.
 */

import { fetchJson } from './marketDataProvider.mjs';
import { PAIRS } from './krakenProvider.mjs';

/** Sistem zaman dilimi etiketi → Kraken interval (dakika) */
export const KRAKEN_INTERVALS = Object.freeze({ '1M': 1, '5M': 5, '15M': 15, '1H': 60, '4H': 240, '1D': 1440 });

export class KrakenHistory {
  #baseUrl;
  #fetchImpl;
  #timeoutMs;

  constructor({
    baseUrl = 'https://api.kraken.com/0/public',
    fetchImpl = fetch,
    timeoutMs = 10_000,
  } = {}) {
    this.#baseUrl = baseUrl;
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  /**
   * @param {string} symbol Sistem sembolü (BTCUSD vb.)
   * @param {string} tf Zaman dilimi etiketi ('4H', '15M' vb.)
   * @param {number} [limit] Dönen son bar sayısı sınırı
   * @returns {Promise<Array<{ openTime, open, high, low, close, volume }>>} eski → yeni sıralı
   */
  async fetchBars(symbol, tf, limit = Infinity) {
    const pair = PAIRS[symbol];
    const interval = KRAKEN_INTERVALS[tf];
    if (!pair) throw new Error(`desteklenmeyen sembol: ${symbol}`);
    if (!interval) throw new Error(`desteklenmeyen zaman dilimi: ${tf}`);

    const data = await fetchJson(`${this.#baseUrl}/OHLC?pair=${pair.query}&interval=${interval}`, {
      fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs,
    });
    if (Array.isArray(data.error) && data.error.length > 0) {
      throw new Error(`kraken OHLC hatası: ${data.error.join('; ')}`);
    }
    const key = pair.aliases.find((a) => data.result?.[a]);
    if (!key) throw new Error(`kraken OHLC sonucu boş: ${symbol}`);

    const bars = data.result[key]
      .map((row) => ({
        openTime: Number(row[0]) * 1000,
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[6]),
      }))
      .filter((b) => [b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0));

    // Son bar henüz kapanmamış olabilir; analiz yalnızca kapanmış bar kullanır
    bars.pop();
    return Number.isFinite(limit) ? bars.slice(-limit) : bars;
  }
}

export default KrakenHistory;
