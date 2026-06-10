/**
 * Bölüm 7.2 — Rejim Tespiti (Algı Katmanı / K2).
 *
 * Piyasayı dört rejim etiketinden biriyle sınıflandırır:
 * TREND / RANGE / HIGH_VOL / LOW_VOL.
 * Girdi: gerçekleşen volatilite oranları + yapısal salınım metrikleri.
 * Çıktı: REGIME_UPDATE olayı — Governor lot fonksiyonu ve HRL
 * meta-kontrolcüsünün strateji seçimi tarafından tüketilir.
 */

const SOURCE_ID = 'perception';
const VERSION = '1.0.0';

export const REGIME = Object.freeze({
  TREND: 'TREND', RANGE: 'RANGE', HIGH_VOL: 'HIGH_VOL', LOW_VOL: 'LOW_VOL',
});

export class RegimeDetector {
  #bus;
  #now;
  #closes = new Map();   // symbol -> kapanış serisi
  #lastRegime = new Map();
  #window;

  constructor({ bus, window = 50, now = () => Date.now() } = {}) {
    this.#bus = bus;
    this.#window = window;
    this.#now = now;
  }

  /** Yeni bar kapanışı geldiğinde çağrılır; rejim değiştiyse REGIME_UPDATE yayınlar. */
  async onClose(symbol, close) {
    const closes = this.#closes.get(symbol) ?? [];
    closes.push(close);
    if (closes.length > this.#window) closes.shift();
    this.#closes.set(symbol, closes);
    if (closes.length < 20) return null;

    const { regime, score } = classify(closes);
    if (this.#lastRegime.get(symbol) === regime) return regime;
    this.#lastRegime.set(symbol, regime);

    await this.#bus.publish({
      type: 'REGIME_UPDATE',
      source: SOURCE_ID,
      version: VERSION,
      payload: { symbol, regime, score },
      evidence: [`${symbol}: ${closes.length} bar üzerinden rejim sınıflandırması → ${regime} (skor ${score.toFixed(3)})`],
      ttlMs: 10 * 60_000,
      timestamp: this.#now(),
    });
    return regime;
  }

  current(symbol) {
    return this.#lastRegime.get(symbol) ?? null;
  }
}

/**
 * Basit ama sağlam v1 sınıflandırıcı:
 *  - Volatilite: log-getiri std sapmasının tarihsel medyana oranı
 *  - Trend gücü: net yön / toplam yol (efficiency ratio)
 */
export function classify(closes) {
  const returns = [];
  for (let i = 1; i < closes.length; i += 1) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  const vol = Math.sqrt(variance);

  // Efficiency ratio (Kaufman): |net hareket| / toplam mutlak hareket
  const netMove = Math.abs(closes[closes.length - 1] - closes[0]);
  const totalPath = returns.reduce((a, r, i) => a + Math.abs(closes[i + 1] - closes[i]), 0);
  const efficiency = totalPath === 0 ? 0 : netMove / totalPath;

  // Volatiliteyi serinin kendi ölçeğine normalize et
  const annualizedish = vol / (Math.abs(mean) + 1e-9);

  if (efficiency > 0.45) return { regime: REGIME.TREND, score: efficiency };
  if (vol > 0.01) return { regime: REGIME.HIGH_VOL, score: Math.min(1, vol * 50) };
  if (vol < 0.002) return { regime: REGIME.LOW_VOL, score: Math.min(1, 1 - vol * 200) };
  return { regime: REGIME.RANGE, score: Math.min(1, 1 - efficiency), _diag: annualizedish };
}

export default RegimeDetector;
