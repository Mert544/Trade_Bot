/**
 * Sembol Karakter Profili — parite başına davranışsal istatistik.
 *
 * Her paritenin karakteri farklıdır: XRP'nin "derin" süpürmesi BTC için
 * gürültüdür. Global sabit eşikler (FVG min boyutu, sweep derinliği,
 * manipülasyon eşiği) tek beden herkese uymaz — bu da gizli bir overfit
 * kaynağıdır (eşikler hangi pariteyle ayarlandıysa ona uyar).
 *
 * Profil, kayan pencerede parite başına ölçer:
 *   - ADR (ortalama günlük genlik, % olarak) ve bar başına tipik genlik
 *   - tipik spread
 *   - sweep sıklığı ve MSS takip oranı (sweep → MSS dönüşümü)
 *
 * normalize(): global eşikleri paritenin volatilite karakterine ölçekler.
 * Referans volatiliteye (varsayılan %0,15 bar genliği) göre oran kurulur;
 * yüksek volatiliteli parite daha derin sweep / daha büyük FVG bekler.
 */

export class SymbolProfile {
  #profiles = new Map();
  #config;

  constructor({
    barWindow = 480,           // 480 × 3m = 24 saat bar genlik penceresi
    referenceBarRangePct = 0.15, // normalizasyon referansı
    minSamples = 60,           // altında normalizasyon uygulanmaz (1.0 çarpan)
  } = {}) {
    this.#config = { barWindow, referenceBarRangePct, minSamples };
  }

  #sym(symbol) {
    if (!this.#profiles.has(symbol)) {
      this.#profiles.set(symbol, {
        barRanges: [],      // % cinsinden bar genlikleri
        spreads: [],
        sweeps: 0,
        mssFollowThrough: 0,
        dayHigh: null, dayLow: null, dayOpenTime: null,
        dailyRanges: [],    // % ADR örnekleri
      });
    }
    return this.#profiles.get(symbol);
  }

  onBar(symbol, bar) {
    const p = this.#sym(symbol);
    const rangePct = ((bar.high - bar.low) / bar.close) * 100;
    p.barRanges.push(rangePct);
    if (p.barRanges.length > this.#config.barWindow) p.barRanges.shift();

    // Günlük genlik takibi (UTC gün yeterli — ADR karakter ölçümüdür)
    const day = Math.floor(bar.openTime / 86_400_000);
    if (p.dayOpenTime !== day) {
      if (p.dayHigh !== null && p.dayLow > 0) {
        p.dailyRanges.push(((p.dayHigh - p.dayLow) / p.dayLow) * 100);
        if (p.dailyRanges.length > 20) p.dailyRanges.shift();
      }
      p.dayOpenTime = day;
      p.dayHigh = bar.high;
      p.dayLow = bar.low;
    } else {
      p.dayHigh = Math.max(p.dayHigh, bar.high);
      p.dayLow = Math.min(p.dayLow, bar.low);
    }
  }

  onSpread(symbol, spreadPct) {
    const p = this.#sym(symbol);
    p.spreads.push(spreadPct);
    if (p.spreads.length > 200) p.spreads.shift();
  }

  recordSweep(symbol, { followedByMss = false } = {}) {
    const p = this.#sym(symbol);
    p.sweeps += 1;
    if (followedByMss) p.mssFollowThrough += 1;
  }

  #median(xs) {
    if (xs.length === 0) return null;
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /** Paritenin karakter özeti (dashboard + kalite bileşeni). */
  profile(symbol) {
    const p = this.#sym(symbol);
    return {
      symbol,
      samples: p.barRanges.length,
      medianBarRangePct: this.#median(p.barRanges),
      adrPct: this.#median(p.dailyRanges),
      medianSpreadPct: this.#median(p.spreads),
      sweepCount: p.sweeps,
      mssFollowThroughRate: p.sweeps > 0 ? p.mssFollowThrough / p.sweeps : null,
    };
  }

  /**
   * Volatilite ölçekleme çarpanı: paritenin tipik bar genliği / referans.
   * Eşik kullanımı: efektifEşik = globalEşik × scale(symbol).
   * Yetersiz örnekte 1.0 (global eşik aynen geçerli — muhafazakâr taraf).
   */
  scale(symbol) {
    const p = this.#sym(symbol);
    if (p.barRanges.length < this.#config.minSamples) return 1.0;
    const median = this.#median(p.barRanges);
    if (!median || median <= 0) return 1.0;
    // 0.5×–3× bandında sınırla: aşırı ölçekleme eşikleri anlamsızlaştırır
    return Math.min(3, Math.max(0.5, median / this.#config.referenceBarRangePct));
  }
}

export default SymbolProfile;
