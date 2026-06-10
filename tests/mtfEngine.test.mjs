/**
 * MTF Engine uçtan uca testi: sentetik ICT senaryosu.
 *
 * Kurgu: 4H ısınma barları LONG yapı (HH/HL) + üstte süpürülmemiş eşit
 * yüksekler (DOL) kurar; 15M barları sellside süpürmesi (manipülasyon)
 * gösterir; canlı 3m barlar sweep→MSS→FVG tetiğini oluşturur.
 * Beklenen: killzone içindeyken SETUP_CANDIDATE yayını, kanıt zinciriyle.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { Structurer } from '../src/agents/structurer.mjs';
import { MTFEngine, TimeframeSeries } from '../src/analysis/mtfEngine.mjs';
import { BIAS, MMXM_PHASE } from '../src/agents/structurer.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };
const H4 = 4 * 60 * 60 * 1000;
const M15 = 15 * 60 * 1000;
const M3 = 3 * 60 * 1000;

function bar(openTime, open, high, low, close) {
  return { openTime, open, high, low, close };
}

/**
 * 4H LONG yapı (elle kurgulanmış OHLC):
 *  - bar 6 ve 10: 115.0'a çift fitil → eşit yüksekler (DOL havuzu, süpürülmemiş)
 *  - sonrası: HH (110.3→112.3) + HL (103.8→105.8) yükselen yapı
 *  - bar 24: 112.3 swing tepesini süpürür → tek kalan üst havuz 115.0
 */
function make4hBars() {
  const rows = [
    [100.0, 101.7, 99.8, 101.5],
    [101.5, 103.2, 101.3, 103.0],
    [103.0, 105.2, 102.8, 105.0],
    [105.0, 107.7, 104.8, 107.5],
    [107.5, 110.1, 107.3, 109.9],
    [109.9, 112.1, 109.7, 112.0],
    [112.0, 115.0, 111.8, 113.0],  // eşit yüksek #1 (swing HIGH)
    [113.0, 113.1, 110.8, 111.0],
    [111.0, 111.2, 107.8, 108.0],  // swing LOW 107.8
    [108.0, 109.7, 107.9, 109.5],
    [109.5, 115.0, 109.3, 112.0],  // eşit yüksek #2 (swing HIGH)
    [112.0, 112.2, 107.7, 108.0],
    [108.0, 108.2, 103.8, 104.0],  // swing LOW 103.8
    [104.0, 106.2, 103.9, 106.0],
    [106.0, 108.2, 105.9, 108.0],
    [108.0, 110.3, 107.9, 110.0],  // swing HIGH 110.3
    [110.0, 110.1, 108.3, 108.5],
    [108.5, 108.7, 106.8, 107.0],
    [107.0, 107.2, 105.8, 106.2],  // swing LOW 105.8 (HL: 103.8→105.8)
    [106.2, 108.2, 106.0, 108.0],
    [108.0, 110.7, 107.85, 110.5],
    [110.5, 112.3, 110.2, 112.0],  // swing HIGH 112.3 (HH: 110.3→112.3)
    [112.0, 112.1, 110.7, 111.0],
    [111.0, 112.0, 110.8, 111.8],
    [111.8, 112.8, 111.5, 112.0],  // 112.3 havuzunu süpürür; 115 dokunulmamış
  ];
  return rows.map(([o, h, l, c], i) => bar(i * H4, o, h, l, c));
}

/** 15M manipülasyon: dar konsolidasyon + sellside süpürmesi (kapanış üstte) */
function make15mBars(t0) {
  const out = [];
  const closes = [113.0, 113.1, 113.05, 113.15, 113.1, 113.2, 113.1, 113.0, 113.1, 113.05, 113.1];
  closes.forEach((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    out.push(bar(t0 + i * M15, o, Math.max(o, c) + 0.05, Math.min(o, c) - 0.05, c));
  });
  // Eşit düşükler ~112.95 altına iğne, kapanış üstte → BULLISH sweep (manipülasyon)
  out.push(bar(t0 + closes.length * M15, 113.1, 113.15, 112.4, 113.05));
  return out;
}

function setup() {
  const clock = { t: 0 };
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  const events = [];
  for (const type of ['BIAS_UPDATE', 'SETUP_CANDIDATE', 'STRUCTURE_INVALIDATED']) {
    bus.subscribe(type, (e) => events.push(e));
  }
  const structurer = new Structurer({ bus, now: () => clock.t });
  structurer.start();
  const engine = new MTFEngine({ structurer, logger: silentLogger });
  return { clock, bus, events, structurer, engine };
}

test('TimeframeSeries: 3m barlar 15M bara doğru birleşir', () => {
  const series = new TimeframeSeries({ intervalMs: M15 });
  const closes = [100, 101, 99, 102, 100.5];
  let closed = null;
  closes.forEach((c, i) => {
    const b = bar(i * M3, c - 0.5, c + 1, c - 1, c);
    const result = series.merge(b);
    if (result) closed = result;
  });
  // 5 × 3m = 15m: 6. bar yeni slota düşmeli
  assert.equal(closed, null, 'ilk 5 bar aynı 15M slotunda');
  const next = series.merge(bar(5 * M3, 100.5, 101, 100, 100.8));
  assert.ok(next, '6. barda 15M bar kapanır');
  assert.equal(next.open, 99.5);
  assert.equal(next.high, 103, 'en yüksek 3m high taşınır');
  assert.equal(next.low, 98, 'en düşük 3m low taşınır');
  assert.equal(next.close, 100.5);
});

test('ısınma: 4H barlardan LONG bias + DOL otomatik kurulur', async () => {
  const { clock, events, structurer, engine } = setup();
  clock.t = 31 * H4;
  await engine.warmup('BTCUSD', { bars4h: make4hBars(), bars15m: [] });

  const ctx = structurer.contextOf('BTCUSD');
  assert.equal(ctx.htfBias, BIAS.LONG);
  assert.equal(ctx.dolLevel, 115.0, 'eşit yüksekler havuzu DOL hedefi');
  const biasEvent = events.find((e) => e.type === 'BIAS_UPDATE');
  assert.ok(biasEvent.payload.dolLevel === 115.0);
  assert.ok(biasEvent.evidence.some((s) => s.includes('HH/HL')), 'kanıt zinciri insan-okunur');
});

test('ısınma: 15M manipülasyon fazı anlatıyı teyit eder', async () => {
  const { clock, structurer, engine } = setup();
  const t15 = 31 * H4;
  clock.t = t15 + 13 * M15;
  await engine.warmup('BTCUSD', { bars4h: make4hBars(), bars15m: make15mBars(t15) });

  const ctx = structurer.contextOf('BTCUSD');
  assert.equal(ctx.htfBias, BIAS.LONG);
  assert.ok(
    ctx.phase === MMXM_PHASE.MANIPULATION || ctx.phase === MMXM_PHASE.DISTRIBUTION,
    `manipülasyon bekleniyordu, gelen: ${ctx.phase}`,
  );
  assert.equal(ctx.narrativeConfirmed, true);
});

test('uçtan uca: 3m sweep→MSS→FVG zinciri SETUP_CANDIDATE üretir (killzone içinde)', async () => {
  const { clock, bus, events, structurer, engine } = setup();
  const t15 = 31 * H4;
  clock.t = t15 + 13 * M15;
  await engine.warmup('BTCUSD', { bars4h: make4hBars(), bars15m: make15mBars(t15) });
  assert.equal(structurer.contextOf('BTCUSD').narrativeConfirmed, true, 'ön koşul: anlatı teyitli');

  // Killzone aç (Structurer kuralı: killzone dışı aday gözlemde kalır)
  await bus.publish({
    type: 'KILLZONE_STATE', source: 'oracle',
    payload: { zone: 'NY_AM', active: true, trueDayOpen: 0 },
  });

  // 3m senaryo: eşit dipler kur → süpür → MSS → FVG'li displacement
  const t3 = t15 + 13 * M15;
  let i = 0;
  const push = async (o, h, l, c) => {
    const b = { symbol: 'BTCUSD', openTime: t3 + i * M3, open: o, high: h, low: l, close: c };
    i += 1;
    clock.t = b.openTime + M3;
    await engine.onBar3m(b);
  };

  // Konsolidasyon + eşit dipler ~112.9 (iki dip swing'i, k=2 fraktal için yeterli yan bar)
  await push(113.05, 113.10, 112.95, 113.00);
  await push(113.00, 113.08, 112.96, 113.04);
  await push(113.04, 113.12, 112.90, 113.02); // dip 112.90 (swing LOW adayı)
  await push(113.02, 113.15, 112.98, 113.10);
  await push(113.10, 113.20, 113.00, 113.12); // tepe bölgesi (swing HIGH ~113.20)
  await push(113.12, 113.18, 112.91, 113.00); // ikinci dip 112.91 → eşit dipler havuzu
  await push(113.00, 113.10, 112.99, 113.05);
  await push(113.05, 113.12, 113.01, 113.08);
  // SWEEP: eşit diplerin (≈112.90) altına iğne, kapanış üstte
  await push(113.08, 113.10, 112.70, 113.02);
  // MSS + FVG: displacement ile 113.20 swing tepesinin üstünde kapanış
  await push(113.02, 113.30, 113.01, 113.28);
  await push(113.28, 113.60, 113.26, 113.55); // FVG: bar[-2].high=113.10 < bu barın low=113.26
  await push(113.55, 113.70, 113.50, 113.65);

  const candidate = events.find((e) => e.type === 'SETUP_CANDIDATE');
  assert.ok(candidate, 'SETUP_CANDIDATE yayınlanmalı');
  assert.equal(candidate.payload.side, 'BUY');
  assert.equal(candidate.payload.setupFamily, 'SWEEP_MSS_FVG');
  assert.equal(candidate.payload.stop, 112.70, 'stop süpürme ucu');
  assert.deepEqual(candidate.payload.targets, [115.0], 'hedef 4H DOL');
  assert.ok(candidate.payload.entry > 112.70 && candidate.payload.entry < 113.6, 'giriş FVG içinde');
  assert.ok(candidate.payload.evidence.some((s) => s.includes('MSS')), 'kanıt zinciri MSS içermeli');

  // Aynı MSS'ten mükerrer aday üretilmez
  const before = events.filter((e) => e.type === 'SETUP_CANDIDATE').length;
  await push(113.65, 113.75, 113.60, 113.70);
  const after = events.filter((e) => e.type === 'SETUP_CANDIDATE').length;
  assert.equal(after, before, 'mükerrer aday yok');
});
