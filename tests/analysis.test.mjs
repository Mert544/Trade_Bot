/**
 * Analiz çekirdeği testleri (sentetik bar dizileriyle):
 *   - Fraktal swing tespiti ve likidite havuzu kümeleme
 *   - Bias sınıflandırması (HH/HL → LONG, DOL seçimi, hedefsiz bias = NEUTRAL)
 *   - Sweep / MSS / FVG tespiti
 *   - MMXM faz sınıflandırması
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSwings, findLiquidityPools, markSweptPools } from '../src/analysis/swings.mjs';
import { classifyBias, detectSweep, detectMSS, detectFVG, classifyMMXM } from '../src/analysis/structure.mjs';
import { BIAS, MMXM_PHASE } from '../src/agents/structurer.mjs';

/** Kapanışlardan bar üretir; high/low gövdeye küçük fitil ekler. */
function bars(closes, { wick = 0.1, t0 = 0, intervalMs = 180_000 } = {}) {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return {
      openTime: t0 + i * intervalMs,
      open,
      high: Math.max(open, close) + wick,
      low: Math.min(open, close) - wick,
      close,
    };
  });
}

test('detectSwings: zigzag dizisinde tepe ve dipler bulunur', () => {
  const series = bars([100, 102, 104, 102, 100, 98, 100, 102, 104, 106, 104, 102]);
  const swings = detectSwings(series, 2);
  const types = swings.map((s) => s.type);
  assert.ok(types.includes('HIGH'), 'tepe bulunmalı');
  assert.ok(types.includes('LOW'), 'dip bulunmalı');
  const top = swings.find((s) => s.type === 'HIGH');
  assert.equal(top.index, 2, '104 tepesi index 2');
});

test('findLiquidityPools: eşit yüksekler tek BUYSIDE havuzunda kümelenir', () => {
  // İki tepe neredeyse aynı seviyede (eşit yüksekler), bir dip
  const swings = [
    { index: 2, type: 'HIGH', price: 110.0, time: 200 },
    { index: 6, type: 'LOW', price: 100.0, time: 600 },
    { index: 10, type: 'HIGH', price: 110.05, time: 1000 },
  ];
  const pools = findLiquidityPools(swings, { tolerancePct: 0.08 });
  const buyside = pools.filter((p) => p.side === 'BUYSIDE');
  assert.equal(buyside.length, 1, 'eşit yüksekler tek havuz olmalı');
  assert.equal(buyside[0].strength, 2);
  assert.equal(buyside[0].level, 110.05, 'havuz seviyesi kümenin tepesi');
});

test('markSweptPools: sonradan aşılan havuz süpürülmüş işaretlenir', () => {
  const series = bars([100, 102, 100, 98, 100, 103]); // son bar 103: 102 tepesini aşar
  const swings = detectSwings(series, 1);
  const pools = markSweptPools(findLiquidityPools(swings), series);
  const sweptBuyside = pools.find((p) => p.side === 'BUYSIDE' && p.swept);
  assert.ok(sweptBuyside, 'aşılan buyside havuzu swept olmalı');
});

test('classifyBias: HH/HL dizisi LONG + üstteki en yakın havuz DOL', () => {
  const swings = [
    { index: 2, type: 'LOW', price: 100, time: 1 },
    { index: 5, type: 'HIGH', price: 105, time: 2 },
    { index: 8, type: 'LOW', price: 102, time: 3 },
    { index: 11, type: 'HIGH', price: 108, time: 4 },
    { index: 14, type: 'LOW', price: 104, time: 5 },
    { index: 17, type: 'HIGH', price: 111, time: 6 },
  ];
  const pools = [
    { side: 'BUYSIDE', level: 115, strength: 2, lastTouchTime: 9, swept: false },
    { side: 'BUYSIDE', level: 120, strength: 1, lastTouchTime: 9, swept: false },
    { side: 'SELLSIDE', level: 98, strength: 1, lastTouchTime: 9, swept: false },
  ];
  const { bias, dol } = classifyBias(swings, pools, 110, { swingCount: 6 });
  assert.equal(bias, BIAS.LONG);
  assert.equal(dol, 115, 'en yakın süpürülmemiş buyside havuzu');
});

test('classifyBias: yön var ama süpürülmemiş DOL yoksa NEUTRAL', () => {
  const swings = [
    { index: 2, type: 'LOW', price: 100, time: 1 },
    { index: 5, type: 'HIGH', price: 105, time: 2 },
    { index: 8, type: 'LOW', price: 102, time: 3 },
    { index: 11, type: 'HIGH', price: 108, time: 4 },
  ];
  const pools = [{ side: 'BUYSIDE', level: 115, strength: 1, lastTouchTime: 9, swept: true }];
  const { bias } = classifyBias(swings, pools, 110, { swingCount: 6 });
  assert.equal(bias, BIAS.NEUTRAL, 'hedefsiz bias işlem üretmemeli');
});

test('detectSweep: dip havuzu delinip kapanış üstte → BULLISH sweep', () => {
  const series = bars([100, 99.5, 99.2, 99.4, 100.2]);
  // 99.0 sellside havuzunun altına inen ama üstünde kapanan bar ekle
  series.push({ openTime: 5 * 180_000, open: 99.4, high: 99.6, low: 98.7, close: 99.3 });
  const pools = [{ side: 'SELLSIDE', level: 99.0, strength: 2, lastTouchTime: 0, swept: false }];
  const sweep = detectSweep(series, pools, { lookback: 12 });
  assert.ok(sweep);
  assert.equal(sweep.direction, 'BULLISH');
  assert.equal(sweep.extreme, 98.7, 'stop referansı süpürme ucu');
});

test('detectMSS: sweep sonrası son swing HIGH kapanışla kırılır', () => {
  // tepe 102 (index 2), sonra dip süpürmesi, sonra 102 üstü kapanış
  const series = [
    ...bars([100, 101, 102, 101, 100]),
    { openTime: 5 * 180_000, open: 100, high: 100.2, low: 98.5, close: 99.8 },  // sweep barı (idx 5)
    ...bars([100.5, 101.5, 102.6], { t0: 6 * 180_000 }),                         // MSS: 102.6 > 102+fitil
  ];
  const swings = detectSwings(series, 2);
  const sweep = { direction: 'BULLISH', level: 99, extreme: 98.5, barIndex: 5, time: 5 * 180_000 };
  const mss = detectMSS(series, swings, sweep);
  assert.equal(mss.confirmed, true);
  assert.equal(mss.direction, 'BULLISH');
});

test('detectFVG: üç bar boşluğu giriş bölgesi olarak bulunur', () => {
  const series = [
    { openTime: 0, open: 100, high: 100.5, low: 99.8, close: 100.3 },
    { openTime: 1, open: 100.3, high: 102.0, low: 100.2, close: 101.8 }, // displacement
    { openTime: 2, open: 101.8, high: 102.5, low: 101.2, close: 102.2 }, // low 101.2 > ilk barın high 100.5 → FVG
  ];
  const fvg = detectFVG(series, 'BULLISH', { minSizePct: 0.05 });
  assert.ok(fvg);
  assert.equal(fvg.low, 100.5);
  assert.equal(fvg.high, 101.2);
  assert.ok(Math.abs(fvg.mid - 100.85) < 1e-9);
});

test('detectFVG: mikro boşluk asgari boyut eşiğine takılır', () => {
  const series = [
    { openTime: 0, open: 100, high: 100.50, low: 99.8, close: 100.3 },
    { openTime: 1, open: 100.3, high: 100.6, low: 100.2, close: 100.55 },
    { openTime: 2, open: 100.55, high: 100.7, low: 100.51, close: 100.6 }, // boşluk 0.01 ≈ %0.01
  ];
  assert.equal(detectFVG(series, 'BULLISH', { minSizePct: 0.05 }), null);
});

test('classifyMMXM: LONG bias + sellside süpürmesi → MANIPULATION, displacement → DISTRIBUTION', () => {
  const base = bars([100, 100.2, 100.1, 100.3, 100.2, 100.4, 100.3, 100.2, 100.3, 100.1, 100.2]);
  const sweepBar = { openTime: 11 * 180_000, open: 100.2, high: 100.3, low: 99.5, close: 100.1 };
  const pools = [{ side: 'SELLSIDE', level: 99.8, strength: 2, lastTouchTime: 0, swept: false }];

  const manipulation = classifyMMXM([...base, sweepBar], pools, BIAS.LONG, { lookback: 12 });
  assert.equal(manipulation.phase, MMXM_PHASE.MANIPULATION);
  assert.equal(manipulation.alignedWithBias, true);

  // Süpürme sonrası güçlü yönlü bar → DISTRIBUTION
  const displacement = { openTime: 12 * 180_000, open: 100.1, high: 102.0, low: 100.0, close: 101.9 };
  const distribution = classifyMMXM([...base, sweepBar, displacement], pools, BIAS.LONG, { lookback: 12 });
  assert.equal(distribution.phase, MMXM_PHASE.DISTRIBUTION);
});

test('classifyMMXM: süpürme yok + dar genlik → CONSOLIDATION; NEUTRAL bias → UNKNOWN', () => {
  const flat = bars([100, 100.1, 100.05, 100.12, 100.08, 100.1, 100.06, 100.11, 100.09, 100.1, 100.07, 100.1], { wick: 0.02 });
  const range = classifyMMXM(flat, [], BIAS.LONG, { lookback: 12, consolidationRangePct: 0.6 });
  assert.equal(range.phase, MMXM_PHASE.CONSOLIDATION);

  const unknown = classifyMMXM(flat, [], BIAS.NEUTRAL, { lookback: 12 });
  assert.equal(unknown.phase, MMXM_PHASE.UNKNOWN);
});
