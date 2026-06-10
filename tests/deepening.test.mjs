/**
 * ICT Derinleştirme testleri:
 *   - PD dizileri: dealing range, premium/discount, OTE, OrderBlock/Breaker
 *   - PO3: accumulation→manipulation→distribution döngüsü, çift süpürmede UNKNOWN
 *   - Korelasyon matrisi + lead-lag + SMT diverjansı (pozitif ve negatif korelasyon)
 *   - SymbolProfile: karakter ölçümü ve eşik ölçekleme sınırları
 *   - Öğrenme: purged K-Fold sızıntı tamponu, dikkat modeli terfi disiplini
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dealingRange, classifyPDZone, oteZone, inZone, detectOrderBlock, toBreaker, zonesOverlap, PD_ZONE,
} from '../src/analysis/pdArrays.mjs';
import { PO3Tracker, PO3_PHASE } from '../src/analysis/po3.mjs';
import { CorrelationMatrix, SMTDetector } from '../src/analysis/smt.mjs';
import { SymbolProfile } from '../src/analysis/symbolProfile.mjs';
import { purgedKFoldSplit } from '../src/metacognition/purgedKFold.mjs';
import { AttentionModel } from '../src/metacognition/attentionWeights.mjs';

// --- PD Dizileri ---

const swingsFixture = [
  { index: 2, type: 'LOW', price: 100, time: 1 },
  { index: 6, type: 'HIGH', price: 110, time: 2 },
];

test('PD: dealing range + premium/discount/equilibrium sınıflandırması', () => {
  const range = dealingRange(swingsFixture);
  assert.deepEqual(range, { high: 110, low: 100, equilibrium: 105 });

  assert.equal(classifyPDZone(108, range).zone, PD_ZONE.PREMIUM);
  assert.equal(classifyPDZone(102, range).zone, PD_ZONE.DISCOUNT);
  assert.equal(classifyPDZone(105.1, range).zone, PD_ZONE.EQUILIBRIUM);
  assert.ok(classifyPDZone(108, range).position > 0);
  assert.ok(classifyPDZone(102, range).position < 0);
});

test('PD: OTE bölgesi %62-79 düzeltme (bullish bacak)', () => {
  const range = { high: 110, low: 100, equilibrium: 105 };
  const ote = oteZone(range, 'BULLISH');
  // high - 0.79×10 = 102.1, high - 0.62×10 = 103.8
  assert.ok(Math.abs(ote.low - 102.1) < 1e-9);
  assert.ok(Math.abs(ote.high - 103.8) < 1e-9);
  assert.equal(inZone(103, ote), true);
  assert.equal(inZone(106, ote), false);
});

test('PD: OrderBlock = MSS öncesi son zıt mum; ihlalde Breaker olur', () => {
  const bars = [
    { openTime: 0, open: 100, high: 101, low: 99.5, close: 100.5 },   // yükseliş
    { openTime: 1, open: 100.5, high: 100.8, low: 99.8, close: 100 }, // DÜŞÜŞ ← alış OB'si
    { openTime: 2, open: 100, high: 102.5, low: 99.9, close: 102.3 }, // displacement (MSS barı)
  ];
  const ob = detectOrderBlock(bars, { confirmed: true, barIndex: 2, direction: 'BULLISH' });
  assert.equal(ob.barIndex, 1);
  assert.equal(ob.low, 99.8);
  assert.equal(zonesOverlap({ low: 100.2, high: 100.9 }, ob), true);

  // İhlal: OB'nin altında kapanış → ters yönlü breaker
  const violated = [...bars, { openTime: 3, open: 102, high: 102.1, low: 99.0, close: 99.2 }];
  const breaker = toBreaker(ob, violated);
  assert.equal(breaker.breaker, true);
  assert.equal(breaker.direction, 'BEARISH');
});

// --- PO3 ---

const H = 60 * 60 * 1000;
const DAY0 = Date.UTC(2026, 5, 10, 4, 0); // 00:00 NY (EDT) = 04:00 UTC

function po3Bar(t, o, h, l, c) {
  return { openTime: t, open: o, high: h, low: l, close: c };
}

test('PO3: birikim → aşağı Judas → yukarı teslim döngüsü', () => {
  const po3 = new PO3Tracker({ accumulationWindowMs: 4 * H, manipulationMinPct: 0.05, displacementPct: 0.15 });

  // Birikim penceresi (ilk 4 saat): 100-101 aralığı
  for (let i = 0; i < 8; i += 1) {
    po3.onBar('X', po3Bar(DAY0 + i * 30 * 60_000, 100.5, 101, 100, 100.5));
  }
  let ctx = po3.context('X', DAY0 + 4 * H);
  assert.equal(ctx.phase, PO3_PHASE.ACCUMULATION);

  // Manipülasyon: aralık dibinin anlamlı altına iğne (Judas aşağı)
  ctx = po3.onBar('X', po3Bar(DAY0 + 4 * H, 100.5, 100.6, 99.7, 100.2));
  assert.equal(ctx.phase, PO3_PHASE.MANIPULATION);
  assert.equal(ctx.expectedDelivery, 'UP', 'Judas aşağı → gerçek teslim yukarı');
  assert.deepEqual(ctx.range, { high: 101, low: 100 });

  // Dağıtım: manipülasyon ucundan %0.15+ yukarı yol
  ctx = po3.onBar('X', po3Bar(DAY0 + 5 * H, 100.2, 101.5, 100.1, 101.4));
  assert.equal(ctx.phase, PO3_PHASE.DISTRIBUTION);
});

test('PO3: çift taraflı süpürme günü UNKNOWN yapar; yeni gün sıfırlar', () => {
  const po3 = new PO3Tracker({ accumulationWindowMs: 4 * H, manipulationMinPct: 0.05, displacementPct: 0.5 });
  for (let i = 0; i < 8; i += 1) {
    po3.onBar('X', po3Bar(DAY0 + i * 30 * 60_000, 100.5, 101, 100, 100.5));
  }
  po3.onBar('X', po3Bar(DAY0 + 4 * H, 100.5, 100.6, 99.7, 100.2));  // aşağı Judas
  const ctx = po3.onBar('X', po3Bar(DAY0 + 5 * H, 100.2, 101.8, 100.1, 101.0)); // diğer uç da süpürüldü
  assert.equal(ctx.phase, PO3_PHASE.UNKNOWN, 'çift süpürme = güvenilmez gün');
  assert.equal(ctx.expectedDelivery, null);

  // Yeni NY günü: bağlam sıfırdan
  const nextDay = DAY0 + 24 * H;
  const fresh = po3.onBar('X', po3Bar(nextDay + 10 * 60_000, 101, 101.2, 100.9, 101.1));
  assert.equal(fresh.phase, PO3_PHASE.ACCUMULATION);
});

test('PO3: gün ortası başlatma (restart) → aralık kurulamaz → UNKNOWN', () => {
  const po3 = new PO3Tracker({ accumulationWindowMs: 4 * H });
  const ctx = po3.onBar('X', po3Bar(DAY0 + 6 * H, 100, 100.5, 99.5, 100));
  assert.equal(ctx.phase, PO3_PHASE.UNKNOWN);
});

// --- Korelasyon + SMT ---

function feedCorrelated(matrix, n = 60, { invert = false, noise = 0 } = {}) {
  let a = 100;
  let b = 50;
  for (let i = 0; i < n; i += 1) {
    const step = Math.sin(i * 0.7) * 0.01 + 0.001;
    a *= 1 + step;
    b *= 1 + (invert ? -step : step) + (noise ? Math.sin(i * 13.7) * noise : 0);
    matrix.onClose('A', a);
    matrix.onClose('B', b);
  }
}

test('korelasyon matrisi: pozitif ve negatif korelasyon doğru ölçülür', () => {
  const pos = new CorrelationMatrix({ window: 96 });
  feedCorrelated(pos);
  assert.ok(pos.correlation('A', 'B') > 0.95);

  const neg = new CorrelationMatrix({ window: 96 });
  feedCorrelated(neg, 60, { invert: true });
  assert.ok(neg.correlation('A', 'B') < -0.95);

  // Yetersiz veri → null
  const empty = new CorrelationMatrix();
  assert.equal(empty.correlation('A', 'B'), null);
});

test('lead-lag: gecikmeli kopya öncül olarak tespit edilir', () => {
  const matrix = new CorrelationMatrix({ window: 96 });
  // B'nin getirisi = A'nın 2 bar önceki getirisi → A öncü, lag=2
  let a = 100;
  let b = 50;
  const aReturns = [];
  for (let i = 0; i < 80; i += 1) {
    const r = Math.sin(i * 0.9) * 0.012 + Math.cos(i * 2.3) * 0.004; // periyodikliği kır
    a *= Math.exp(r);
    aReturns.push(r);
    matrix.onClose('A', a);
    b *= Math.exp(i >= 2 ? aReturns[i - 2] : 0);
    matrix.onClose('B', b);
  }
  const ll = matrix.leadLag('A', 'B', { maxLag: 3 });
  assert.equal(ll.lag, 2, `A 2 bar öncü olmalı (lag=${ll.lag}, r=${ll.r})`);
  assert.ok(ll.r > 0.95);

  const m = matrix.matrix(['A', 'B']);
  assert.equal(m.length, 1);
  assert.equal(m[0].leader.symbol, 'A');
});

test('SMT: korele eş süpürmediyse diverjans; eş de süpürdüyse yok', () => {
  const matrix = new CorrelationMatrix({ window: 96 });
  feedCorrelated(matrix);
  const smt = new SMTDetector({ matrix, minCorrelation: 0.6, windowMs: 60 * 60_000 });
  const t = 1_000_000;

  smt.updateExtremes('A', { swingLow: 99, at: t });
  smt.updateExtremes('B', { swingLow: 49, at: t });

  // A dibini süpürdü, B süpürmedi → bullish SMT
  const div = smt.query('A', 'LOW', ['A', 'B'], t + 60_000);
  assert.equal(div.divergent, true);
  assert.equal(div.confirmingSymbol, 'B');
  assert.equal(div.kind, 'BULLISH_SMT');

  // B de aynı pencerede süpürdüyse diverjans YOK
  smt.updateExtremes('B', { sweptLow: true, at: t + 30_000 });
  assert.equal(smt.query('A', 'LOW', ['A', 'B'], t + 60_000).divergent, false);
});

test('SMT: zayıf korelasyonda diverjans iddiası üretilmez', () => {
  const matrix = new CorrelationMatrix({ window: 96 });
  feedCorrelated(matrix, 60, { noise: 0.05 }); // gürültüyle korelasyonu boz
  const r = matrix.correlation('A', 'B');
  assert.ok(Math.abs(r) < 0.6, `korelasyon zayıf olmalı (r=${r})`);
  const smt = new SMTDetector({ matrix, minCorrelation: 0.6 });
  smt.updateExtremes('B', { swingLow: 49, at: 1000 });
  assert.equal(smt.query('A', 'LOW', ['A', 'B'], 2000).divergent, false);
});

// --- SymbolProfile ---

test('profil: volatilite ölçekleme — oynak parite eşiği büyütür, sınırlar uygulanır', () => {
  const profile = new SymbolProfile({ referenceBarRangePct: 0.15, minSamples: 10 });
  // Sakin parite: %0.075 bar genliği → scale 0.5 (taban)
  for (let i = 0; i < 20; i += 1) {
    profile.onBar('CALM', { openTime: i * 180_000, high: 100.075, low: 100, close: 100.05 });
  }
  // Oynak parite: %0.45 → scale 3'e dayanır (tavan)
  for (let i = 0; i < 20; i += 1) {
    profile.onBar('WILD', { openTime: i * 180_000, high: 100.9, low: 100, close: 100.2 });
  }
  assert.equal(profile.scale('CALM'), 0.5);
  assert.equal(profile.scale('WILD'), 3);
  assert.equal(profile.scale('UNSEEN'), 1.0, 'örneksiz sembol 1.0 (muhafazakâr)');

  profile.recordSweep('WILD', { followedByMss: true });
  profile.recordSweep('WILD', { followedByMss: false });
  assert.equal(profile.profile('WILD').mssFollowThroughRate, 0.5);
});

// --- Öğrenme: purged K-Fold + dikkat modeli ---

test('purged K-Fold: test bloğu çevresindeki tampon eğitime giremez', () => {
  const folds = purgedKFoldSplit(100, { k: 5, purge: 5 });
  assert.equal(folds.length, 5);
  for (const { trainIdx, testIdx } of folds) {
    const testStart = Math.min(...testIdx);
    const testEnd = Math.max(...testIdx);
    for (const i of trainIdx) {
      assert.ok(i < testStart - 5 || i > testEnd + 5, `sızıntı: eğitim indeksi ${i} tamponda`);
    }
  }
  assert.deepEqual(purgedKFoldSplit(5, { k: 5 }), [], 'yetersiz veri bölünmez');
});

test('dikkat modeli: örnek eşiği altında eğitim reddedilir, önsel korunur', () => {
  const model = new AttentionModel({ basePrior: 0.6 });
  const few = Array.from({ length: 50 }, (_, i) => ({
    quality: { oteHit: i % 2 === 0 }, outcome: i % 2 === 0 ? 'WIN' : 'LOSS',
  }));
  const result = model.trainWithValidation(few, { tiers: { validation: 100 } });
  assert.equal(result.promoted, false);
  assert.ok(result.reason.includes('örnek yetersiz'));
  assert.equal(model.score({ oteHit: true }), 0.6, 'terfi yoksa sabit önsel');
});

test('dikkat modeli: gerçek sinyalli veride CV kapısını geçer ve ayrım yapar', () => {
  // Sentetik gerçeklik: oteHit + smtDivergent kazançla güçlü ilişkili
  const samples = Array.from({ length: 200 }, (_, i) => {
    const good = i % 3 !== 0; // 2/3 iyi kurulum
    return {
      quality: {
        oteHit: good, smtDivergent: good, obConfluence: good && i % 2 === 0,
        sweepDepthNorm: good ? 0.4 : 0.1, poolStrength: good ? 3 : 1,
      },
      outcome: (good ? i % 10 < 8 : i % 10 < 3) ? 'WIN' : 'LOSS', // iyi: %80, kötü: %30
    };
  });
  const model = new AttentionModel({ basePrior: 0.6, epochs: 400 });
  const result = model.trainWithValidation(samples, { tiers: { validation: 100 }, minLift: 0.02 });
  assert.equal(result.promoted, true, result.reason);
  assert.ok(model.score({ oteHit: true, smtDivergent: true, sweepDepthNorm: 0.4, poolStrength: 3 })
    > model.score({ oteHit: false, smtDivergent: false, sweepDepthNorm: 0.1, poolStrength: 1 }),
  'iyi kurulum kötüden yüksek skor almalı');
});

test('dikkat modeli: rastgele etikette CV kapısı terfiyi reddeder (overfit freni)', () => {
  let seed = 7;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
  const samples = Array.from({ length: 200 }, () => ({
    quality: { oteHit: rand() > 0.5, smtDivergent: rand() > 0.5, sweepDepthNorm: rand() },
    outcome: rand() > 0.5 ? 'WIN' : 'LOSS',
  }));
  const model = new AttentionModel({ basePrior: 0.6 });
  const result = model.trainWithValidation(samples, { tiers: { validation: 100 }, minLift: 0.02 });
  assert.equal(result.promoted, false, 'gürültüden öğrenilmez — kapı reddetmeli');
  assert.equal(model.score({}), 0.6);
});

test('dikkat modeli: JSON gidiş-dönüş terfi durumunu korur', () => {
  const model = new AttentionModel();
  model.weights = [0.1, 0.2, 0, 0, 0.5, 0, 0, 0, 0, 0, 0];
  model.bias = 0.3;
  model.promoted = true;
  const restored = AttentionModel.fromJSON(JSON.parse(JSON.stringify(model.toJSON())));
  assert.equal(restored.promoted, true);
  assert.ok(Math.abs(restored.score({ pdAligned: true }) - model.score({ pdAligned: true })) < 1e-12);
});
