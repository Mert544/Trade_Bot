/**
 * Bölüm 7.3 — Monte Carlo Stres Testi (terfi kapısı).
 *
 * Geçmiş işlem dizisi binlerce kez yeniden örneklenir (sıra karıştırma +
 * slippage/spread şoku enjeksiyonu). Çıktı tek getiri eğrisi değil:
 *   - maksimum drawdown dağılımı
 *   - risk-of-ruin olasılığı
 *   - FTMO günlük limit ihlali olasılığı
 *
 * Anayasal kural: %95 persentilde günlük %5 limitini ihlal eden hiçbir
 * konfigürasyon canlıya alınamaz.
 */

import { CONFIG } from '../config/defaults.mjs';

function shuffle(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Deterministik test için tohumlanabilir basit LCG. */
export function makeRng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * @param {Array<{ netPnlPct: number, day?: number }>} trades — işlem başına getiri (% equity)
 * @param {object} opts
 * @returns {{ passed, p95MaxDD, p95DailyDD, riskOfRuin, dailyLimitBreachProb, runs }}
 */
export function runMonteCarloGate(trades, {
  runs = CONFIG.metacognition.monteCarloRuns,
  dailyDDLimitPct = CONFIG.metacognition.monteCarloP95DailyDDLimitPct,
  ruinThresholdPct = CONFIG.risk.maxTotalDrawdownPct,
  costShockPct = 0.05,  // her işleme rastgele ek maliyet şoku (getirinin %5'ine kadar)
  tradesPerDay = 3,
  rng = Math.random,
} = {}) {
  if (trades.length < CONFIG.metacognition.minSamplesForWeightUpdate) {
    return {
      passed: false,
      reason: `yetersiz örnek: ${trades.length} < ${CONFIG.metacognition.minSamplesForWeightUpdate} (Ek C)`,
      runs: 0,
    };
  }

  const maxDDs = [];
  const worstDailyDDs = [];
  let ruinCount = 0;
  let dailyBreachCount = 0;

  for (let run = 0; run < runs; run += 1) {
    const sequence = shuffle(trades, rng);
    let equity = 100;
    let peak = 100;
    let maxDD = 0;
    let worstDailyDD = 0;
    let dayPnl = 0;
    let dayStart = 100;
    let ruined = false;

    for (let i = 0; i < sequence.length; i += 1) {
      // Slippage/spread şoku enjeksiyonu: getiri kötüleştirilir
      const shock = Math.abs(sequence[i].netPnlPct) * costShockPct * rng();
      const pnlPct = sequence[i].netPnlPct - shock;
      const pnl = equity * (pnlPct / 100);
      equity += pnl;
      dayPnl += pnl;

      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
      if (dd >= ruinThresholdPct) ruined = true;

      const dailyDD = Math.max(0, (-dayPnl / dayStart) * 100);
      if (dailyDD > worstDailyDD) worstDailyDD = dailyDD;

      if ((i + 1) % tradesPerDay === 0) {
        dayStart = equity;
        dayPnl = 0;
      }
    }

    maxDDs.push(maxDD);
    worstDailyDDs.push(worstDailyDD);
    if (ruined) ruinCount += 1;
    if (worstDailyDD >= dailyDDLimitPct) dailyBreachCount += 1;
  }

  const percentile = (arr, p) => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  };

  const p95DailyDD = percentile(worstDailyDDs, 0.95);
  return {
    passed: p95DailyDD < dailyDDLimitPct,
    p95MaxDD: percentile(maxDDs, 0.95),
    p95DailyDD,
    riskOfRuin: ruinCount / runs,
    dailyLimitBreachProb: dailyBreachCount / runs,
    runs,
  };
}

export default runMonteCarloGate;
