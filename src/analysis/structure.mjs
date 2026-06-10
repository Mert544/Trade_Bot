/**
 * ICT yapı analizi: bias/DOL, süpürme, MSS, FVG, MMXM faz sınıflandırması.
 *
 * Bölüm 5.2'nin analiz matematiği. Tüm fonksiyonlar saf (pure) ve bar
 * dizileri üzerinde çalışır — durum tutmaz, mtfEngine orkestre eder.
 */

import { BIAS, MMXM_PHASE } from '../agents/structurer.mjs';

/**
 * 4H Yön Katmanı: son swing dizisinden yapısal eğilim + DOL hedefi.
 *
 * HH/HL dizisi → LONG (fiyat üstteki buyside havuzuna çekiliyor),
 * LH/LL dizisi → SHORT, karışık → NEUTRAL.
 */
export function classifyBias(swings, pools, currentPrice, { swingCount = 6 } = {}) {
  const recent = swings.slice(-swingCount);
  const highs = recent.filter((s) => s.type === 'HIGH');
  const lows = recent.filter((s) => s.type === 'LOW');
  if (highs.length < 2 || lows.length < 2) {
    return { bias: BIAS.NEUTRAL, dol: null, evidence: ['yetersiz swing verisi'] };
  }

  // Klasik HH/HL tanımı: son swing çiftleri kıyaslanır. "Tüm dizi adım adım
  // yükselsin" şartı gerçek veride aşırı kırılgandır (her düzeltme bias'ı bozar).
  const hh = highs.at(-1).price > highs.at(-2).price;
  const hl = lows.at(-1).price > lows.at(-2).price;
  const lh = highs.at(-1).price < highs.at(-2).price;
  const ll = lows.at(-1).price < lows.at(-2).price;

  const unswept = pools.filter((p) => !p.swept);
  let bias = BIAS.NEUTRAL;
  let dol = null;
  const evidence = [];

  if (hh && hl) {
    bias = BIAS.LONG;
    // DOL: fiyatın üzerindeki en yakın süpürülmemiş buyside havuzu
    const above = unswept.filter((p) => p.side === 'BUYSIDE' && p.level > currentPrice);
    dol = above.length ? above.reduce((a, b) => (a.level < b.level ? a : b)) : null;
    evidence.push(`HH/HL: yüksek ${highs.at(-2).price}→${highs.at(-1).price}, düşük ${lows.at(-2).price}→${lows.at(-1).price}`);
  } else if (lh && ll) {
    bias = BIAS.SHORT;
    const below = unswept.filter((p) => p.side === 'SELLSIDE' && p.level < currentPrice);
    dol = below.length ? below.reduce((a, b) => (a.level > b.level ? a : b)) : null;
    evidence.push(`LH/LL: yüksek ${highs.at(-2).price}→${highs.at(-1).price}, düşük ${lows.at(-2).price}→${lows.at(-1).price}`);
  } else {
    evidence.push('swing dizisi karışık — yapısal eğilim yok');
  }

  if (bias !== BIAS.NEUTRAL && !dol) {
    // Yön var ama hedef likidite yok: hedefsiz bias işlem üretmemeli
    evidence.push('uyarı: yönlü yapı var ama süpürülmemiş DOL havuzu yok');
    return { bias: BIAS.NEUTRAL, dol: null, evidence };
  }
  if (dol) evidence.push(`DOL: ${dol.level} (${dol.side}, güç ${dol.strength})`);
  return { bias, dol: dol?.level ?? null, evidence };
}

/**
 * Likidite süpürmesi: bar ucu havuz seviyesini deler ama kapanış geri döner.
 * BULLISH sweep = sellside alındı, kapanış üstte (long manipülasyonu);
 * BEARISH sweep = buyside alındı, kapanış altta.
 */
export function detectSweep(bars, pools, { lookback = 12 } = {}) {
  const start = Math.max(0, bars.length - lookback);
  let latest = null;
  for (let i = start; i < bars.length; i += 1) {
    const bar = bars[i];
    for (const pool of pools) {
      if (pool.side === 'SELLSIDE' && bar.low < pool.level && bar.close > pool.level) {
        latest = { direction: 'BULLISH', level: pool.level, extreme: bar.low, barIndex: i, time: bar.openTime, poolStrength: pool.strength };
      } else if (pool.side === 'BUYSIDE' && bar.high > pool.level && bar.close < pool.level) {
        latest = { direction: 'BEARISH', level: pool.level, extreme: bar.high, barIndex: i, time: bar.openTime, poolStrength: pool.strength };
      }
    }
  }
  return latest;
}

/**
 * MSS (Market Structure Shift): süpürme sonrası, karşı yöndeki son swing
 * seviyesinin KAPANIŞLA kırılması.
 * Bullish MSS: sweep barından önceki son swing HIGH üstünde kapanış.
 */
export function detectMSS(bars, swings, sweep) {
  if (!sweep) return { confirmed: false };
  const wantType = sweep.direction === 'BULLISH' ? 'HIGH' : 'LOW';
  const refSwings = swings.filter((s) => s.type === wantType && s.index <= sweep.barIndex);
  if (refSwings.length === 0) return { confirmed: false };
  const ref = refSwings.at(-1);

  for (let i = sweep.barIndex + 1; i < bars.length; i += 1) {
    if (sweep.direction === 'BULLISH' && bars[i].close > ref.price) {
      return { confirmed: true, level: ref.price, barIndex: i, direction: 'BULLISH' };
    }
    if (sweep.direction === 'BEARISH' && bars[i].close < ref.price) {
      return { confirmed: true, level: ref.price, barIndex: i, direction: 'BEARISH' };
    }
  }
  return { confirmed: false };
}

/**
 * FVG (Fair Value Gap): üç bar boşluğu. Bullish: bar[i-2].high < bar[i].low —
 * displacement bacağındaki dengesizlik, geri test giriş bölgesidir.
 * sinceIndex'ten itibaren aranır (MSS bacağı), en yeni uygun boşluk döner.
 */
export function detectFVG(bars, direction, { sinceIndex = 0, minSizePct = 0.05 } = {}) {
  let found = null;
  for (let i = Math.max(2, sinceIndex); i < bars.length; i += 1) {
    const first = bars[i - 2];
    const third = bars[i];
    if (direction === 'BULLISH' && third.low > first.high) {
      const size = third.low - first.high;
      if (size / third.low * 100 >= minSizePct) {
        found = { low: first.high, high: third.low, mid: (first.high + third.low) / 2, barIndex: i, direction };
      }
    } else if (direction === 'BEARISH' && third.high < first.low) {
      const size = first.low - third.high;
      if (size / third.high * 100 >= minSizePct) {
        found = { low: third.high, high: first.low, mid: (third.high + first.low) / 2, barIndex: i, direction };
      }
    }
  }
  return found;
}

/**
 * 15M Anlatı Katmanı — MMXM faz sınıflandırması.
 *
 * LONG bias bağlamında: sellside süpürmesi (BULLISH sweep) = MANIPULATION;
 * süpürme sonrası bias yönünde displacement = DISTRIBUTION.
 * Süpürme yok + dar pencere genliği = CONSOLIDATION.
 */
export function classifyMMXM(bars, pools, bias, {
  lookback = 12,
  displacementFactor = 1.6,
  consolidationRangePct = 0.6,
} = {}) {
  if (bars.length < lookback || bias === BIAS.NEUTRAL) {
    return { phase: MMXM_PHASE.UNKNOWN, alignedWithBias: false, sweep: null };
  }
  const window = bars.slice(-lookback);
  const sweep = detectSweep(bars, pools, { lookback });
  const expectedSweepDir = bias === BIAS.LONG ? 'BULLISH' : 'BEARISH';

  if (sweep && sweep.direction === expectedSweepDir) {
    // Süpürme sonrası displacement var mı? (ortalama genliğin üstünde yönlü bar)
    const avgRange = window.reduce((a, b) => a + (b.high - b.low), 0) / window.length;
    let displaced = false;
    for (let i = sweep.barIndex + 1; i < bars.length; i += 1) {
      const bar = bars[i];
      const directional = bias === BIAS.LONG ? bar.close > bar.open : bar.close < bar.open;
      if (directional && (bar.high - bar.low) > avgRange * displacementFactor) {
        displaced = true;
        break;
      }
    }
    return {
      phase: displaced ? MMXM_PHASE.DISTRIBUTION : MMXM_PHASE.MANIPULATION,
      alignedWithBias: true,
      sweep,
    };
  }

  const hi = Math.max(...window.map((b) => b.high));
  const lo = Math.min(...window.map((b) => b.low));
  if ((hi - lo) / lo * 100 <= consolidationRangePct) {
    return { phase: MMXM_PHASE.CONSOLIDATION, alignedWithBias: false, sweep: null };
  }
  return { phase: MMXM_PHASE.UNKNOWN, alignedWithBias: false, sweep: sweep ?? null };
}

export default classifyBias;
