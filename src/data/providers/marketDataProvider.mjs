/**
 * Bölüm 4.1 — Çoklu Kaynak Mimarisi: piyasa verisi sağlayıcı arayüzü.
 *
 * Tek veri sağlayıcıya bağımlılık tek nokta hatasıdır. Her sağlayıcı bu
 * arayüzü uygular; FeedManager birincil + doğrulama kaynağını paralel yoklar
 * ve sanitasyon hattına çapraz fiyatla birlikte verir.
 *
 * Sözleşme: getQuotes(symbols) → { [symbol]: { bid, ask, price, timestamp } }
 * Erişilemeyen sembol sonuçta YER ALMAZ; sağlayıcı düzeyi hata FIRLATILIR
 * (çağıran kaynak sağlığını buradan izler).
 */

export class MarketDataProvider {
  /** Telemetri ve loglarda kaynak kimliği. */
  get name() { throw new Error('name uygulanmadı'); }

  /**
   * @param {string[]} _symbols Sistem sembolleri (örn. ['BTCUSD', 'XRPUSD'])
   * @returns {Promise<Record<string, { bid: number, ask: number, price: number, timestamp: number }>>}
   */
  async getQuotes(_symbols) { throw new Error('getQuotes uygulanmadı'); }
}

/** Zaman aşımı ve HTTP durum denetimi olan ortak fetch yardımcısı. */
export async function fetchJson(url, { fetchImpl = fetch, timeoutMs = 8000, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'ict-bot/5.0', Accept: 'application/json', ...headers },
  });
  if (!res.ok) {
    // GÜVENLİK: hata mesajındaki URL'den API anahtarı temizlenir —
    // loglar paylaşılabilir, anahtar asla log'a sızmamalı
    const redacted = url.replace(/apikey=[^&]+/i, 'apikey=***');
    throw new Error(`HTTP ${res.status} — ${redacted}`);
  }
  return res.json();
}

export default MarketDataProvider;
