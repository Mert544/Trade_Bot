/**
 * Twelve Data Bar Beslemesi — FX/metal hattı (F2).
 *
 * Ücretsiz katman gerçeği: 8 kredi/dk, 800/gün, bid/ask yok, WS yok.
 * Tasarım buna göre: time_series ucundan GERÇEK 15M OHLC barları (fitiller
 * dahil — borsadan agregre, örnekleme değil) 10 dakikada bir tazelenir.
 * 3 sembol × 6 yoklama/saat × 24 ≈ 432 kredi/gün — bütçenin içinde.
 *
 * Kurallar:
 *   - Oluşmakta olan bar ASLA yayılmaz (TD ilk satırı forming bar olabilir;
 *     kapanış zamanı geçmemiş bar atlanır — look-ahead anayasal yasak)
 *   - Kapalı seansta (hafta sonu) yoklama durur (kredi + gürültü tasarrufu)
 *   - Bar dedupe: openTime bazlı; restart'ta warmup tarihçesiyle dikişsiz
 *
 * Bu hat cTrader tick akışı bağlanana kadar BİRİNCİL, sonra doğrulama olur.
 */

import { fetchJson } from './marketDataProvider.mjs';
import { instrumentSpec } from '../../config/instruments.mjs';
import { isMarketOpen } from '../../time/marketHours.mjs';

const TF_MIN = { '15M': 15, '1H': 60, '4H': 240 };

export class TwelveDataBars {
  #apiKey;
  #baseUrl;
  #symbols;
  #fetchImpl;
  #now;
  #logger;
  #onBar;
  #intervalMs;
  #pollMs;
  #timer = null;
  #lastEmitted = new Map(); // symbol -> son yayılan bar openTime

  telemetry = { polls: 0, barsEmitted: 0, errors: 0, skippedClosed: 0 };

  constructor({
    apiKey = process.env.TWELVEDATA_API_KEY,
    symbols,
    interval = '15M',
    pollMs = 10 * 60 * 1000,
    baseUrl = 'https://api.twelvedata.com',
    fetchImpl = fetch,
    now = () => Date.now(),
    logger = console,
    onBar = () => {},
  } = {}) {
    if (!apiKey) throw new Error('TwelveDataBars için TWELVEDATA_API_KEY gerekli');
    this.#apiKey = apiKey;
    this.#symbols = symbols.filter((s) => instrumentSpec(s)?.tdSymbol);
    this.#intervalMs = TF_MIN[interval] * 60 * 1000;
    this.#pollMs = pollMs;
    this.#baseUrl = baseUrl;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#logger = logger;
    this.#onBar = onBar;
    this.interval = interval;
  }

  get name() { return 'twelvedata-bars'; }

  /** Açılış ısınması: sembol başına tarihsel bar (1 kredi/çağrı). */
  async fetchHistory(symbol, interval, outputsize) {
    const spec = instrumentSpec(symbol);
    const tdInterval = { '15M': '15min', '1H': '1h', '4H': '4h' }[interval];
    const data = await fetchJson(
      `${this.#baseUrl}/time_series?symbol=${encodeURIComponent(spec.tdSymbol)}`
      + `&interval=${tdInterval}&outputsize=${outputsize}&timezone=UTC&apikey=${this.#apiKey}`,
      { fetchImpl: this.#fetchImpl },
    );
    if (data.status === 'error') throw new Error(`twelvedata: ${data.message}`);
    return this.#parseValues(data.values, interval).reverse(); // eski → yeni
  }

  #parseValues(values, interval) {
    const intervalMs = TF_MIN[interval] * 60 * 1000;
    return (values ?? [])
      .map((v) => ({
        openTime: Date.parse(`${v.datetime.replace(' ', 'T')}Z`),
        open: Number(v.open), high: Number(v.high), low: Number(v.low), close: Number(v.close),
        intervalMs,
      }))
      .filter((b) => Number.isFinite(b.openTime) && [b.open, b.high, b.low, b.close].every((x) => x > 0));
  }

  /** Periyodik yoklama: yeni KAPANMIŞ barları yayar. */
  async poll() {
    this.telemetry.polls += 1;
    const now = this.#now();
    const open = this.#symbols.filter((s) => isMarketOpen(s, new Date(now)));
    if (open.length === 0) {
      this.telemetry.skippedClosed += 1;
      return; // hafta sonu: kredi harcama
    }
    const tdInterval = { '15M': '15min', '1H': '1h', '4H': '4h' }[this.interval];
    const query = open.map((s) => instrumentSpec(s).tdSymbol).join(',');
    let data;
    try {
      data = await fetchJson(
        `${this.#baseUrl}/time_series?symbol=${encodeURIComponent(query)}`
        + `&interval=${tdInterval}&outputsize=4&timezone=UTC&apikey=${this.#apiKey}`,
        { fetchImpl: this.#fetchImpl },
      );
    } catch (err) {
      this.telemetry.errors += 1;
      this.#logger.warn(`[td-bars] yoklama hatası: ${err.message}`);
      return;
    }

    for (const symbol of open) {
      const tdSymbol = instrumentSpec(symbol).tdSymbol;
      // Tek sembollü yanıt düz nesne, çoklu yanıt sembol-anahtarlı gelir
      const entry = open.length === 1 ? data : data[tdSymbol];
      if (!entry || entry.status === 'error' || !Array.isArray(entry.values)) {
        if (entry?.status === 'error') this.telemetry.errors += 1;
        continue;
      }
      const bars = this.#parseValues(entry.values, this.interval).reverse(); // eski → yeni
      for (const bar of bars) {
        const closeTime = bar.openTime + this.#intervalMs;
        if (closeTime > now) continue; // oluşmakta olan bar: yayılMAZ (look-ahead)
        if (bar.openTime <= (this.#lastEmitted.get(symbol) ?? 0)) continue; // dedupe
        this.#lastEmitted.set(symbol, bar.openTime);
        this.telemetry.barsEmitted += 1;
        await this.#onBar({ symbol, ...bar });
      }
    }
  }

  /** Isınma sonrası dedupe başlangıcı: tarihçenin son barını işaretle. */
  seedLastEmitted(symbol, lastOpenTime) {
    this.#lastEmitted.set(symbol, lastOpenTime);
  }

  start() {
    if (this.#timer) return;
    const loop = () => {
      this.poll().catch((err) => this.#logger.error(`[td-bars] hata: ${err.message}`));
    };
    loop();
    this.#timer = setInterval(loop, this.#pollMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}

export default TwelveDataBars;
