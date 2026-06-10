/**
 * Katman 1 — Veri Bütünlüğü ve Zehirlenme Savunması (Bölüm 4).
 *
 * Her gelen tick/bar dört filtreden geçmeden K2'ye ulaşamaz:
 *   1. Yapısal doğrulama (OHLC tutarlılığı, negatif fiyat, timestamp monotonluğu)
 *   2. İstatistiksel aykırılık (Hampel + MAD z-skoru) — işaretler, SİLMEZ
 *   3. Çapraz kaynak kuorumu — BAD_TICK vs GERÇEK SWEEP ayrımı
 *   4. Bayatlık bekçisi (Staleness Watchdog) — FEED_STALE
 *
 * Kritik mimari karar (4.2): ICT mantığında gerçek likidite süpürmeleri de
 * iğne gibi görünür. İşaretlenen iğne ikinci kaynakta da varsa REAL_SWEEP
 * olarak Structurer'a fırsat sinyali olur; tek kaynaktaysa BAD_TICK olarak imha edilir.
 */

import { CONFIG } from '../config/defaults.mjs';

const SOURCE_ID = 'dataLayer';
const VERSION = '1.0.0';

export const TICK_VERDICT = Object.freeze({
  CLEAN: 'CLEAN',
  BAD_TICK: 'BAD_TICK',
  REAL_SWEEP: 'REAL_SWEEP',
  QUARANTINED: 'QUARANTINED',
});

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median Absolute Deviation tabanlı sağlam z-skoru.
 *
 * MAD=0 durumu (durgun piyasada pencere fiyatları özdeş) bölme patlaması
 * yaratır; medyana göre %0,1 altındaki sapma gürültü sayılır — aksi halde
 * her mikro hareket sahte "sweep" üretir (canlı akışta gözlendi).
 */
export function madZScore(value, window, { quietNoiseFloorPct = 0.1 } = {}) {
  if (window.length < 5) return 0;
  const med = median(window);
  const mad = median(window.map((v) => Math.abs(v - med)));
  if (mad === 0) {
    const relDeviation = Math.abs(value - med) / med;
    return relDeviation < quietNoiseFloorPct / 100 ? 0 : Infinity;
  }
  return Math.abs(value - med) / (1.4826 * mad);
}

/** Filtre 1: yapısal doğrulama. Dönüş: hata listesi (boş = geçerli). */
export function validateBarStructure(bar, lastTimestamp = null) {
  const errors = [];
  const { open, high, low, close, timestamp } = bar;
  for (const [name, v] of Object.entries({ open, high, low, close })) {
    if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${name} sayısal değil`);
    else if (v <= 0) errors.push(`${name} negatif/sıfır fiyat`);
  }
  if (errors.length === 0) {
    if (high < Math.max(open, close)) errors.push('OHLC tutarsız: High < max(Open, Close)');
    if (low > Math.min(open, close)) errors.push('OHLC tutarsız: Low > min(Open, Close)');
  }
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) errors.push('timestamp eksik/geçersiz');
  else if (lastTimestamp !== null && timestamp <= lastTimestamp) errors.push('timestamp monoton değil');
  return errors;
}

export class Sanitizer {
  #bus;
  #config;
  #now;
  #windows = new Map();       // `${source}:${symbol}` -> son N fiyat
  #lastTimestamps = new Map();
  #lastTickAt = new Map();    // staleness izleme
  #staleFlagged = new Set();

  constructor({ bus, config = CONFIG.sanitizer, now = () => Date.now() } = {}) {
    this.#bus = bus;
    this.#config = config;
    this.#now = now;
  }

  /**
   * Tek kaynaktan gelen tick'i işler.
   * @returns {{ verdict, zScore?, errors? }}
   */
  async ingestTick({ source, symbol, price, timestamp, crossSourcePrice = null, spread = 0.0001 }) {
    const key = `${source}:${symbol}`;
    this.#lastTickAt.set(key, this.#now());
    this.#staleFlagged.delete(key);

    // Filtre 1 (tick düzeyi): pozitif fiyat + monoton timestamp
    if (typeof price !== 'number' || price <= 0 || !Number.isFinite(price)) {
      await this.#quarantine(source, symbol, 'geçersiz fiyat', { price, timestamp });
      return { verdict: TICK_VERDICT.QUARANTINED, errors: ['geçersiz fiyat'] };
    }
    // Tick düzeyinde EŞİT zaman damgası meşrudur: borsa aynı milisaniyede
    // birden çok işlem eşleştirebilir (WS trade yığınları). Yalnız geriye
    // gidiş reddedilir; bar düzeyinde katı monotonluk validateBarStructure'da.
    const lastTs = this.#lastTimestamps.get(key);
    if (lastTs !== undefined && timestamp < lastTs) {
      await this.#quarantine(source, symbol, 'timestamp geriye gitti', { price, timestamp });
      return { verdict: TICK_VERDICT.QUARANTINED, errors: ['timestamp geriye gitti'] };
    }
    this.#lastTimestamps.set(key, timestamp);

    // Filtre 2: Hampel penceresi üzerinde MAD z-skoru.
    // Önce aykırılık sınıflandırılır; çapraz kaynak sapma karantinası yalnızca
    // aykırı OLMAYAN tick'lere uygulanır — iğnelerin kaderini kuorum belirler (4.2).
    const window = this.#windows.get(key) ?? [];
    const zScore = madZScore(price, window);

    if (zScore > this.#config.madZScoreThreshold) {
      // Filtre 3: çapraz kaynak kuorumu — iğne ikinci kaynakta da var mı?
      if (crossSourcePrice !== null) {
        const crossDeviation = Math.abs(price - crossSourcePrice);
        const confirmedByCross = crossDeviation <= this.#crossTolerance(price, spread);
        if (confirmedByCross) {
          // GERÇEK SWEEP — veri temizliği değil, fırsat tespiti.
          // Gerçek hareket pencereye dahil edilir (medyan yeni seviyeyi öğrenir).
          this.#pushWindow(key, window, price);
          return { verdict: TICK_VERDICT.REAL_SWEEP, zScore };
        }
      }
      // Bad tick pencereye ALINMAZ — medyanı zehirlemesin.
      await this.#quarantine(source, symbol,
        `bad tick: MAD z-skoru ${zScore === Infinity ? '∞' : zScore.toFixed(2)} > ${this.#config.madZScoreThreshold}, çapraz teyit yok`,
        { price, timestamp });
      return { verdict: TICK_VERDICT.BAD_TICK, zScore };
    }

    // Çapraz kaynak fiyat sapması (Bölüm 4.1): sapma toleransı aşarsa karantina.
    // Tolerans = max(3×spread, fiyat × yüzdesel taban) — borsalar arası doğal fark payı.
    if (crossSourcePrice !== null) {
      const deviation = Math.abs(price - crossSourcePrice);
      if (deviation > this.#crossTolerance(price, spread)) {
        await this.#quarantine(source, symbol,
          `kaynaklar arası sapma ${deviation.toFixed(6)} > tolerans ${this.#crossTolerance(price, spread).toFixed(6)}`,
          { price, crossSourcePrice, timestamp });
        return { verdict: TICK_VERDICT.QUARANTINED, errors: ['çapraz kaynak sapması'] };
      }
    }

    this.#pushWindow(key, window, price);
    return { verdict: TICK_VERDICT.CLEAN, zScore };
  }

  /**
   * Canlılık dokunuşu: fiyat işlemeden bayatlık saatini tazeler.
   * Kullanım: WS ticker güncellemeleri — sakin paritede dakikalarca işlem
   * olmayabilir ama ticker akıyorsa feed CANLIDIR (işlem sessizliği ≠ feed ölümü).
   */
  touch(source, symbol) {
    const key = `${source}:${symbol}`;
    this.#lastTickAt.set(key, this.#now());
    this.#staleFlagged.delete(key);
  }

  /** Filtre 4: Bayatlık bekçisi — periyodik çağrılır. */
  async checkStaleness() {
    const now = this.#now();
    const staleEvents = [];
    for (const [key, lastAt] of this.#lastTickAt) {
      if (this.#staleFlagged.has(key)) continue;
      if (now - lastAt > this.#config.staleFeedTimeoutMs) {
        this.#staleFlagged.add(key);
        const [source, symbol] = key.split(':');
        await this.#bus.publish({
          type: 'FEED_STALE',
          source: SOURCE_ID,
          version: VERSION,
          payload: { source, symbol, reason: `feed ${now - lastAt}ms sessiz (eşik ${this.#config.staleFeedTimeoutMs}ms)` },
          evidence: [`Son tick: ${new Date(lastAt).toISOString()}`],
          ttlMs: 60_000,
          timestamp: now,
        });
        staleEvents.push(key);
      }
    }
    return staleEvents;
  }

  #crossTolerance(price, spread) {
    return Math.max(
      this.#config.crossSourceDeviationSpreadMult * spread,
      price * ((this.#config.crossSourceMinTolerancePct ?? 0) / 100),
    );
  }

  #pushWindow(key, window, price) {
    window.push(price);
    if (window.length > this.#config.hampelWindow) window.shift();
    this.#windows.set(key, window);
  }

  async #quarantine(source, symbol, reason, sample) {
    await this.#bus.publish({
      type: 'DATA_QUARANTINE',
      source: SOURCE_ID,
      version: VERSION,
      payload: { source, symbol, reason, sample },
      evidence: [reason],
      ttlMs: 60_000,
      timestamp: this.#now(),
    });
  }
}

export default Sanitizer;
