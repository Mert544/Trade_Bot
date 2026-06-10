/**
 * PD Dizileri (Premium/Discount Arrays) — ICT fiyat teslim çerçevesi.
 *
 * Dealing range: son anlamlı swing low ↔ swing high arası. Denge (equilibrium)
 * %50'dir; üstü PREMIUM (satış için adil), altı DISCOUNT (alış için adil).
 * OTE (Optimal Trade Entry): %62-%79 düzeltme bölgesi — girişin "keskin" alanı.
 *
 * Order Block: yapıyı kıran displacement bacağından önceki son zıt mum —
 * kurumsal emir izi. Breaker: süpürülüp başarısız olan OB'nin ters yönde
 * destek/dirence dönüşmüş hali.
 *
 * Tüm fonksiyonlar saf; mtfEngine kalite bileşeni ve yumuşak filtre olarak
 * tüketir (sert kapı DEĞİL — bileşenler önce veri biriktirir, ağırlıkları
 * öğrenme katmanı belirler).
 */

export const PD_ZONE = Object.freeze({
  PREMIUM: 'PREMIUM',
  DISCOUNT: 'DISCOUNT',
  EQUILIBRIUM: 'EQUILIBRIUM',
});

/**
 * Dealing range: verilen swinglerden son geçerli high/low çifti.
 * Yön bilgisi gerekmez; en güncel HIGH ve LOW swing uçları alınır.
 */
export function dealingRange(swings) {
  const highs = swings.filter((s) => s.type === 'HIGH');
  const lows = swings.filter((s) => s.type === 'LOW');
  if (highs.length === 0 || lows.length === 0) return null;
  const high = highs.at(-1).price;
  const low = lows.at(-1).price;
  if (high <= low) {
    // Son swingler ters sıradaysa bir önceki uçla genişlet
    const altHigh = Math.max(...highs.slice(-2).map((s) => s.price));
    const altLow = Math.min(...lows.slice(-2).map((s) => s.price));
    if (altHigh <= altLow) return null;
    return { high: altHigh, low: altLow, equilibrium: (altHigh + altLow) / 2 };
  }
  return { high, low, equilibrium: (high + low) / 2 };
}

/** Fiyatın PD bölgesi + denge mesafesi (−1 dip … 0 denge … +1 tepe). */
export function classifyPDZone(price, range, { equilibriumBandPct = 5 } = {}) {
  if (!range) return { zone: null, position: null };
  const span = range.high - range.low;
  if (span <= 0) return { zone: null, position: null };
  const position = ((price - range.equilibrium) / (span / 2));
  const band = equilibriumBandPct / 100 * 2; // dengenin ±%5'i
  let zone = PD_ZONE.EQUILIBRIUM;
  if (position > band) zone = PD_ZONE.PREMIUM;
  else if (position < -band) zone = PD_ZONE.DISCOUNT;
  return { zone, position: Number(position.toFixed(4)) };
}

/**
 * OTE bölgesi: yönlü bacağın %62-%79 düzeltmesi.
 * BUY için: low→high bacağında geri çekilme bölgesi.
 * @returns {{ low, high } | null} fiyat bölgesi
 */
export function oteZone(range, direction, { fibLow = 0.62, fibHigh = 0.79 } = {}) {
  if (!range) return null;
  const span = range.high - range.low;
  if (span <= 0) return null;
  if (direction === 'BULLISH') {
    // Tepe sonrası düzeltme: high - fib × span
    return { low: range.high - fibHigh * span, high: range.high - fibLow * span };
  }
  return { low: range.low + fibLow * span, high: range.low + fibHigh * span };
}

export function inZone(price, zone) {
  return zone !== null && price >= zone.low && price <= zone.high;
}

/**
 * Order Block tespiti: MSS'i üreten displacement bacağından önceki son zıt mum.
 * BULLISH MSS için: kırılım barından geriye doğru ilk düşüş mumu (close<open).
 *
 * @param {Array} bars
 * @param {{ barIndex: number, direction: string }} mss detectMSS çıktısı
 * @returns {{ low, high, barIndex, direction } | null}
 */
export function detectOrderBlock(bars, mss, { maxLookback = 10 } = {}) {
  if (!mss?.confirmed) return null;
  const wantBearishCandle = mss.direction === 'BULLISH'; // alış OB'si = son satış mumu
  for (let i = mss.barIndex - 1; i >= Math.max(0, mss.barIndex - maxLookback); i -= 1) {
    const bar = bars[i];
    const isBearish = bar.close < bar.open;
    if (wantBearishCandle === isBearish) {
      return { low: bar.low, high: bar.high, barIndex: i, direction: mss.direction };
    }
  }
  return null;
}

/**
 * Breaker tespiti: önceki OB ihlal edildiyse (fiyat tamamen içinden geçtiyse)
 * blok ters yönde breaker olur. v1: ihlal kontrolü + ters yön etiketi.
 */
export function toBreaker(orderBlock, bars) {
  if (!orderBlock) return null;
  for (let i = orderBlock.barIndex + 1; i < bars.length; i += 1) {
    const bar = bars[i];
    const violated = orderBlock.direction === 'BULLISH'
      ? bar.close < orderBlock.low   // alış OB'sinin altında kapanış → ihlal
      : bar.close > orderBlock.high;
    if (violated) {
      return {
        low: orderBlock.low,
        high: orderBlock.high,
        barIndex: orderBlock.barIndex,
        direction: orderBlock.direction === 'BULLISH' ? 'BEARISH' : 'BULLISH',
        breaker: true,
      };
    }
  }
  return null;
}

/** İki bölgenin kesişimi (FVG ∩ OB = yüksek kaliteli giriş). */
export function zonesOverlap(a, b) {
  if (!a || !b) return false;
  return a.low <= b.high && b.low <= a.high;
}

export default dealingRange;
