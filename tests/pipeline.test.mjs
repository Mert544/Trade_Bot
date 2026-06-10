/**
 * Faz 3–4 Uçtan Uca Testleri:
 *   - Structurer: tek yönlü fraktal hiyerarşi, killzone kuralı, STRUCTURE_INVALIDATED.
 *   - Tam karar zinciri gölge modda uçtan uca: bağlam → aday → onay → fill →
 *     EXECUTION_REPORT, tek correlationId zinciriyle.
 *   - Sniper spread kapısı ve anayasal stop-loss zorunluluğu.
 *   - Müzakere protokolü: veto hiyerarşisi ve konsensüs eşiği.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEcosystem } from '../src/index.mjs';
import { BIAS, MMXM_PHASE } from '../src/agents/structurer.mjs';
import { DecisionCoordinator, VERDICT } from '../src/coordination/decisionCoordinator.mjs';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { PaperBroker } from '../src/execution/brokerInterface.mjs';
import { createEnvelope } from '../src/core/envelope.mjs';
import { runMonteCarloGate, makeRng } from '../src/metacognition/monteCarloGate.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeEco(clock) {
  const eco = createEcosystem({
    mode: 'shadow',
    logger: silentLogger,
    now: () => clock.t,
    calendarProvider: { fetchToday: async () => [] },
  });
  eco.governor.start();
  eco.structurer.start();
  eco.sniper.start();
  return eco;
}

test('Structurer: üst katman hizası olmadan tetik katmanı aday üretmez', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 13, 0) }; // 09:00 NY — killzone içi
  const eco = makeEco(clock);
  await eco.oracle.tick(); // killzone yayını

  const result = await eco.structurer.proposeSetup('BTCUSD', {
    side: 'BUY', entry: 100, stop: 99, targets: [102],
    setupFamily: 'FVG_RETEST', mssConfirmed: true,
  });
  assert.equal(result.proposed, false);
  assert.ok(result.reason.includes('üst katman'));
});

test('Structurer: killzone dışında aday gözlem statüsünde kalır', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 16, 0) }; // 12:00 NY — killzone dışı
  const eco = makeEco(clock);
  await eco.oracle.tick();
  await eco.structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 105 });
  await eco.structurer.updateNarrativePhase('BTCUSD', { phase: MMXM_PHASE.MANIPULATION, alignedWithBias: true });

  const result = await eco.structurer.proposeSetup('BTCUSD', {
    side: 'BUY', entry: 100, stop: 99, targets: [102],
    setupFamily: 'SWEEP_REVERSAL', mssConfirmed: true,
  });
  assert.equal(result.proposed, false);
  assert.equal(result.observed, true, 'killzone dışı aday gözlemde kalmalı');
});

test('Structurer: 4H bias değişimi bekleyen adayları iptal eder (STRUCTURE_INVALIDATED)', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 13, 0) };
  const eco = makeEco(clock);
  const invalidations = [];
  eco.bus.subscribe('STRUCTURE_INVALIDATED', (e) => invalidations.push(e));

  await eco.oracle.tick();
  await eco.structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 105 });
  await eco.structurer.updateNarrativePhase('BTCUSD', { phase: MMXM_PHASE.MANIPULATION, alignedWithBias: true });
  eco.broker.setQuote('BTCUSD', { bid: 99.99, ask: 100.01 });

  const proposal = await eco.structurer.proposeSetup('BTCUSD', {
    side: 'BUY', entry: 100, stop: 99, targets: [102],
    setupFamily: 'FVG_RETEST', mssConfirmed: true,
  });
  assert.equal(proposal.proposed, true);

  await eco.structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.SHORT, dolLevel: 95 });
  const inv = invalidations.at(-1);
  assert.ok(inv, 'STRUCTURE_INVALIDATED yayınlanmalı');
  assert.ok(inv.payload.invalidatedCandidates.includes(proposal.candidateId));
});

test('uçtan uca gölge zinciri: aday → onay → fill → rapor, tek correlationId', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 13, 0) }; // 09:00 NY
  const eco = makeEco(clock);
  const chain = [];
  eco.bus.subscribe('*', () => {}); // no-op
  for (const type of ['SETUP_CANDIDATE', 'RISK_APPROVAL', 'ORDER_SUBMITTED', 'ORDER_FILLED', 'EXECUTION_REPORT']) {
    eco.bus.subscribe(type, (env) => chain.push({ type, correlationId: env.correlationId }));
  }

  await eco.oracle.tick();
  eco.broker.setQuote('BTCUSD', { bid: 99.99, ask: 100.01 });
  await eco.structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 105 });
  await eco.structurer.updateNarrativePhase('BTCUSD', { phase: MMXM_PHASE.MANIPULATION, alignedWithBias: true });

  const proposal = await eco.structurer.proposeSetup('BTCUSD', {
    side: 'BUY', entry: 100, stop: 99, targets: [102],
    setupFamily: 'FVG_RETEST', mssConfirmed: true,
    evidence: ['1M MSS + FVG 99.95-100.05'],
  });
  assert.equal(proposal.proposed, true);

  // Gerçekçi limit akışı: emir BEKLER (ask 100.01 > limit 100) —
  // anında dolum yok. Fiyat giriş bölgesine dönünce dolar.
  assert.deepEqual(chain.map((c) => c.type), ['SETUP_CANDIDATE', 'RISK_APPROVAL', 'ORDER_SUBMITTED']);
  assert.equal((await eco.broker.fetchOpenPositions()).length, 0, 'fiyat dönmeden pozisyon açılamaz');

  eco.broker.setQuote('BTCUSD', { bid: 99.97, ask: 99.99 }); // FVG geri testi
  await eco.sniper.onQuote('BTCUSD', {});

  const types = chain.map((c) => c.type);
  assert.deepEqual(types, ['SETUP_CANDIDATE', 'RISK_APPROVAL', 'ORDER_SUBMITTED', 'ORDER_FILLED', 'EXECUTION_REPORT']);
  assert.equal(new Set(chain.map((c) => c.correlationId)).size, 1, 'tüm zincir tek correlationId taşımalı');

  const positions = await eco.broker.fetchOpenPositions();
  assert.equal(positions.length, 1);
  assert.equal(positions[0].stopLoss, 99, 'sunucu tarafı stop zorunlu');
  assert.equal(positions[0].entryPrice, 100, 'bekleyen limit tam limit fiyatından dolar (maker)');
});

test('veto edilen aday gölge deftere kaydedilir (veto isabet ölçümü)', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 13, 0) };
  const eco = makeEco(clock);
  await eco.oracle.tick();
  // Ambargo aç → Governor veto edecek
  await eco.bus.publish({
    type: 'EMBARGO_ON', source: 'oracle',
    payload: { eventName: 'CPI', impact: 'HIGH', windowStart: clock.t, windowEnd: clock.t + 45 * 60_000 },
  });
  await eco.structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 105 });
  await eco.structurer.updateNarrativePhase('BTCUSD', { phase: MMXM_PHASE.MANIPULATION, alignedWithBias: true });
  const proposal = await eco.structurer.proposeSetup('BTCUSD', {
    side: 'BUY', entry: 100, stop: 99, targets: [102],
    setupFamily: 'FVG_RETEST', mssConfirmed: true,
  });
  assert.equal(proposal.proposed, true, 'aday yayınlanır ama veto edilir');
  assert.equal(eco.shadowLedger.stats().rejectedCount, 1);

  // Hipotetik akıbet: fiyat hedefe gitti → veto YANLIŞTI (kaydedilir, suçlanmaz)
  eco.shadowLedger.onPrice('BTCUSD', 102.5);
  const acc = eco.shadowLedger.vetoAccuracy();
  assert.equal(acc.resolved, 1);
  assert.equal(acc.accuracy, 0, 'fırsat kaçırıldı olarak ölçülmeli');
});

test('Sniper spread kapısı: anormal spread emri reddeder', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 13, 0) };
  const eco = makeEco(clock);
  await eco.oracle.tick();
  // Medyan spread geçmişi oluştur (dar spread)
  for (let i = 0; i < 20; i += 1) eco.sniper.recordSpread('BTCUSD', 0.02);
  // Anlık spread 3×medyanın üstü
  eco.broker.setQuote('BTCUSD', { bid: 99.9, ask: 100.1 }); // spread 0.2 > 3×0.02

  await eco.structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 105 });
  await eco.structurer.updateNarrativePhase('BTCUSD', { phase: MMXM_PHASE.MANIPULATION, alignedWithBias: true });
  await eco.structurer.proposeSetup('BTCUSD', {
    side: 'BUY', entry: 100, stop: 99, targets: [102],
    setupFamily: 'FVG_RETEST', mssConfirmed: true,
  });

  const positions = await eco.broker.fetchOpenPositions();
  assert.equal(positions.length, 0, 'spread kapısı emri engellemiş olmalı');
});

test('anayasal kural: stop-loss olmadan emir reddedilir', async () => {
  const broker = new PaperBroker();
  broker.setQuote('BTCUSD', { bid: 99.99, ask: 100.01 });
  await assert.rejects(
    () => broker.submitOrder({ symbol: 'BTCUSD', side: 'BUY', volume: 1, type: 'LIMIT', price: 100 }),
    /ANAYASA İHLALİ/,
  );
});

test('müzakere: Governor vetosu mutlaktır, Sniper DEFER erteler, konsensüs eşiği uygulanır', async () => {
  const bus = new ProtocolBus({ logger: silentLogger });
  const coordinator = new DecisionCoordinator({ bus, config: { windowMs: 30, consensusThreshold: 0.6 } });
  coordinator.start();

  const candidate = createEnvelope({
    type: 'SETUP_CANDIDATE', source: 'structurer', confidence: 0.9,
    payload: {
      symbol: 'BTCUSD', side: 'BUY', entry: 100, stop: 99, targets: [102],
      setupFamily: 'FVG_RETEST', confidence: 0.9, evidence: ['x'],
    },
  });

  // Tur 1: Governor itirazı her şeyi geçersiz kılar
  const respond = (source, type, verdict, confidence = 0.9) => bus.publish({
    type, source,
    payload: { candidateId: candidate.msgId, verdict, reason: 'gerekçe', confidence },
    confidence,
  });
  const debate1 = coordinator.deliberate(candidate);
  await respond('sniper', 'ENDORSE', 'ENDORSE');
  await respond('governor', 'OBJECTION', 'VETO');
  const r1 = await debate1;
  assert.equal(r1.verdict, VERDICT.VETOED);
  assert.equal(r1.vetoAgent, 'governor');

  // Tur 2: Sniper DEFER → erteleme
  const debate2 = coordinator.deliberate(candidate);
  await respond('sniper', 'OBJECTION', 'DEFER');
  const r2 = await debate2;
  assert.equal(r2.verdict, VERDICT.DEFERRED);

  // Tur 3: itiraz yok, yüksek güven → onay
  const debate3 = coordinator.deliberate(candidate);
  await respond('oracle', 'ENDORSE', 'ENDORSE', 0.8);
  const r3 = await debate3;
  assert.equal(r3.verdict, VERDICT.APPROVED);
  assert.ok(r3.weightedConfidence >= 0.6);
  coordinator.stop();
});

test('Monte Carlo kapısı: yetersiz örnek reddedilir; sağlıklı seri geçer; toksik seri kalır', () => {
  const few = runMonteCarloGate([{ netPnlPct: 0.5 }], { rng: makeRng(1) });
  assert.equal(few.passed, false);
  assert.ok(few.reason.includes('yetersiz örnek'));

  const healthy = Array.from({ length: 60 }, (_, i) => ({ netPnlPct: i % 3 === 0 ? -0.4 : 0.6 }));
  const pass = runMonteCarloGate(healthy, { runs: 500, rng: makeRng(7) });
  assert.equal(pass.passed, true, `P95 günlük DD ${pass.p95DailyDD}`);

  const toxic = Array.from({ length: 60 }, (_, i) => ({ netPnlPct: i % 2 === 0 ? -2.5 : 1.0 }));
  const fail = runMonteCarloGate(toxic, { runs: 500, rng: makeRng(7) });
  assert.equal(fail.passed, false, 'P95 günlük DD %5 ihlali terfi edemez');
});
