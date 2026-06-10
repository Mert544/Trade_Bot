/**
 * Faz E — Overfit disiplin paketi testleri:
 *   - Post-mortem taksonomisi (8.2 v1): dört kök neden sınıfı + WIN/sınıflandırılamayan
 *   - 15M faz histerezisi: tek seferlik sınıflandırma değişimi Structurer'a inmez
 *   - Look-ahead koruması: oluşmakta olan bar HİÇBİR analiz yoluna sızamaz
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPostMortem, ROOT_CAUSE } from '../src/metacognition/postMortem.mjs';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { Structurer, MMXM_PHASE, BIAS } from '../src/agents/structurer.mjs';
import { MTFEngine, TimeframeSeries } from '../src/analysis/mtfEngine.mjs';
import { BarAggregator } from '../src/data/barAggregator.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

const baseTrade = {
  outcome: 'LOSS', side: 'BUY', symbol: 'BTCUSD',
  grossPnl: -50, netPnl: -53, commission: 3, openedAt: 10_000,
};
const baseCandidate = {
  timestamp: 0,
  payload: { quality: { sweepDepthPct: 0.5, poolStrength: 3 } },
};

test('post-mortem: WIN → NONE; bias dönmüş → MAKRO_KARSITLIGI', () => {
  assert.equal(classifyPostMortem({ trade: { ...baseTrade, outcome: 'WIN' } }).rootCause, ROOT_CAUSE.NONE);

  const r = classifyPostMortem({ trade: baseTrade, candidate: baseCandidate, biasNow: 'SHORT_BIAS' });
  assert.equal(r.rootCause, ROOT_CAUSE.MAKRO_KARSITLIGI);
  assert.ok(r.diagnosis.includes('SHORT_BIAS'));
});

test('post-mortem: zayıf sweep kanıtı → SAHTE_SUPURME', () => {
  const weak = { timestamp: 0, payload: { quality: { sweepDepthPct: 0.01, poolStrength: 3 } } };
  assert.equal(
    classifyPostMortem({ trade: baseTrade, candidate: weak, biasNow: 'LONG_BIAS' }).rootCause,
    ROOT_CAUSE.SAHTE_SUPURME,
  );
  const singleTouch = { timestamp: 0, payload: { quality: { sweepDepthPct: 0.5, poolStrength: 1 } } };
  assert.equal(
    classifyPostMortem({ trade: baseTrade, candidate: singleTouch, biasNow: 'LONG_BIAS' }).rootCause,
    ROOT_CAUSE.SAHTE_SUPURME,
  );
});

test('post-mortem: geç fill → ZAMANLAMA_HATASI; yüksek maliyet → ICRA_MALIYETI; aksi → SINIFLANDIRILMADI', () => {
  const late = classifyPostMortem({
    trade: { ...baseTrade, openedAt: 80_000 }, candidate: baseCandidate,
    biasNow: 'LONG_BIAS', ttlMs: 90_000,
  });
  assert.equal(late.rootCause, ROOT_CAUSE.ZAMANLAMA_HATASI);

  const costly = classifyPostMortem({
    trade: { ...baseTrade, grossPnl: -4, netPnl: -7, commission: 3, openedAt: 5000 },
    candidate: baseCandidate, biasNow: 'LONG_BIAS',
  });
  assert.equal(costly.rootCause, ROOT_CAUSE.ICRA_MALIYETI);

  const normal = classifyPostMortem({
    trade: { ...baseTrade, openedAt: 5000 }, candidate: baseCandidate, biasNow: 'LONG_BIAS',
  });
  assert.equal(normal.rootCause, ROOT_CAUSE.SINIFLANDIRILMADI);
});

test('post-mortem: weightDeltas kavramsal olarak v1 dışında (yalnız sınıflandırma döner)', () => {
  const r = classifyPostMortem({ trade: baseTrade, candidate: baseCandidate, biasNow: 'LONG_BIAS' });
  assert.deepEqual(Object.keys(r).sort(), ['diagnosis', 'rootCause'], 'v1 ağırlık önerisi üretmez');
});

// --- Histerezis ---

function makeHysteresisRig({ phaseHysteresis = 2 } = {}) {
  const bus = new ProtocolBus({ logger: silentLogger });
  const structurer = new Structurer({ bus });
  const phaseUpdates = [];
  const origUpdate = structurer.updateNarrativePhase.bind(structurer);
  structurer.updateNarrativePhase = async (symbol, args) => {
    phaseUpdates.push(args.phase);
    return origUpdate(symbol, args);
  };
  const engine = new MTFEngine({
    structurer,
    logger: silentLogger,
    config: {
      swingK: 2, eqTolerancePct: 0.08, sweepLookbackBars: 12, displacementFactor: 1.6,
      consolidationRangePct: 0.6, biasSwingCount: 6, fvgMinSizePct: 0.05,
      maxSeriesLength: 500, phaseHysteresis,
    },
  });
  return { engine, structurer, phaseUpdates };
}

/** 15M barları: ilk N bar konsolidasyon, opsiyonel sweep barı sonda. */
function bars15(withSweep, t0 = 0) {
  const M15 = 15 * 60 * 1000;
  const closes = [113.0, 113.1, 113.05, 113.15, 113.1, 113.2, 113.1, 113.0, 113.1, 113.05, 113.1];
  const out = closes.map((c, i) => {
    const o = i === 0 ? c : closes[i - 1];
    return { openTime: t0 + i * M15, open: o, high: Math.max(o, c) + 0.05, low: Math.min(o, c) - 0.05, close: c };
  });
  out.push(withSweep
    ? { openTime: t0 + closes.length * M15, open: 113.1, high: 113.15, low: 112.4, close: 113.05 }  // sweep
    : { openTime: t0 + closes.length * M15, open: 113.1, high: 113.15, low: 113.05, close: 113.1 }); // sakin
  return out;
}

test('histerezis: tek seferlik faz değişimi Structurer\'a inmez, ardışık teyit iner', async () => {
  const { engine, structurer, phaseUpdates } = makeHysteresisRig({ phaseHysteresis: 2 });
  // 4H LONG bağlamı kur (histerezis 15M'de; bias'ı doğrudan ver)
  await structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 115 });

  // Isınma: sweep'li seri → MANIPULATION ilk teyitte geçer (confirmedPhase null)
  await engine.warmup('BTCUSD', { bars4h: [], bars15m: bars15(true) });
  assert.deepEqual(phaseUpdates, [MMXM_PHASE.MANIPULATION]);
  assert.equal(structurer.contextOf('BTCUSD').narrativeConfirmed, true);

  // Tek seferlik UNKNOWN sınıflandırması (flap) → İNMEMELİ
  await engine.warmup('BTCUSD', { bars4h: [], bars15m: bars15(false) });
  assert.equal(phaseUpdates.length, 1, 'tek flap histerezise takılır');
  assert.equal(structurer.contextOf('BTCUSD').narrativeConfirmed, true, 'anlatı korunur');

  // İkinci ardışık aynı sonuç → artık iner
  await engine.warmup('BTCUSD', { bars4h: [], bars15m: bars15(false) });
  assert.equal(phaseUpdates.length, 2);
  assert.equal(structurer.contextOf('BTCUSD').narrativeConfirmed, false);
});

// --- Look-ahead koruması ---

test('look-ahead: BarAggregator oluşmakta olan barı asla yayınlamaz', () => {
  const agg = new BarAggregator({ intervalMs: 180_000 });
  // Aynı slot içinde 10 tick: hiçbiri bar döndürmemeli
  for (let i = 0; i < 10; i += 1) {
    assert.equal(agg.push('X', 100 + i, i * 1000), null);
  }
  // inProgress görünür ama akışa girmez
  assert.ok(agg.inProgress('X'));
});

test('look-ahead: TimeframeSeries.bars yalnız KAPANMIŞ barları içerir', () => {
  const series = new TimeframeSeries({ intervalMs: 15 * 60 * 1000 });
  const M3 = 3 * 60 * 1000;
  // 7 × 3m bar: ilk 5 → ilk 15M slotu, 6-7. bar ikinci slot (henüz açık)
  for (let i = 0; i < 7; i += 1) {
    series.merge({ openTime: i * M3, open: 100, high: 101 + i, low: 99, close: 100.5 });
  }
  assert.equal(series.bars.length, 1, 'yalnız 1 kapanmış 15M bar olmalı');
  assert.equal(series.bars[0].high, 105, 'kapanan bar yalnız kendi slotunun uçlarını taşır (6-7. bar dahil değil)');
});

test('look-ahead: mtfEngine analizi son kapanmış bar setiyle sınırlı (oluşan 15M bar analize girmez)', async () => {
  const { engine, structurer } = makeHysteresisRig();
  await structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 115 });
  await engine.warmup('BTCUSD', { bars4h: [], bars15m: bars15(true) });
  const before = engine.snapshot('BTCUSD').bars15m;

  // Tek 3m bar gönder: 15M sınırı geçilmediği sürece bars15m DEĞİŞMEZ
  const t0 = 12 * 15 * 60 * 1000;
  await engine.onBar3m({ symbol: 'BTCUSD', openTime: t0, open: 113.1, high: 113.2, low: 113.0, close: 113.15 });
  assert.equal(engine.snapshot('BTCUSD').bars15m, before, 'oluşmakta olan 15M bar seride görünmez');
});
