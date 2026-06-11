/**
 * Faz 2 Kabul Testleri:
 *   - Oracle ambargosu Governor kilidini tetikler; veto zinciri uçtan uca loglanır.
 *   - Drawdown durum makinesi: %3,5 SOFT_LOCK, %4,5 HARD_LOCK, toplam %8 KILLSWITCH.
 *   - Asimetrik lot: kayıpta geometrik küçülme, kazançta doğrusal tavanlı artış.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { StateManager } from '../src/core/stateManager.mjs';
import { Governor } from '../src/agents/governor.mjs';
import { createEnvelope } from '../src/core/envelope.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function setup({ equity = 100_000 } = {}) {
  const bus = new ProtocolBus({ logger: silentLogger });
  const stateManager = new StateManager({ initialEquity: equity });
  const governor = new Governor({ bus, stateManager, logger: silentLogger });
  governor.start();
  const events = [];
  bus.subscribe('RISK_APPROVAL', (e) => events.push(e));
  bus.subscribe('RISK_VETO', (e) => events.push(e));
  bus.subscribe('KILLSWITCH', (e) => events.push(e));
  return { bus, stateManager, governor, events };
}

const candidateEnvelope = (overrides = {}) => createEnvelope({
  type: 'SETUP_CANDIDATE',
  source: 'structurer',
  confidence: 0.8,
  payload: {
    symbol: 'BTCUSD', side: 'BUY', entry: 100_000, stop: 99_000, targets: [102_000],
    setupFamily: 'FVG_RETEST', confidence: 0.8, evidence: ['test kanıtı'],
    ...overrides,
  },
});

test('temiz durumda aday RISK_APPROVAL alır; lot ve TTL onay mesajında', async () => {
  const { governor, events } = setup();
  const result = await governor.evaluateCandidate(candidateEnvelope());
  assert.equal(result.approved, true);
  const approval = events.find((e) => e.type === 'RISK_APPROVAL');
  assert.ok(approval);
  assert.ok(approval.payload.lotSize > 0);
  assert.ok(approval.payload.ttl > 0);
  assert.ok(approval.payload.maxSlippage > 0);
});

test('ambargo aktifken aday veto edilir; correlationId zinciri korunur', async () => {
  const { bus, governor, events } = setup();
  await bus.publish({
    type: 'EMBARGO_ON', source: 'oracle',
    payload: { eventName: 'NFP', impact: 'HIGH', windowStart: 0, windowEnd: 9e15 },
  });
  const candidate = candidateEnvelope();
  const result = await governor.evaluateCandidate(candidate);
  assert.equal(result.approved, false);
  const veto = events.find((e) => e.type === 'RISK_VETO');
  assert.ok(veto.payload.vetoReason.includes('Ambargo'));
  assert.equal(veto.correlationId, candidate.correlationId, 'veto zinciri correlationId taşımalı');
});

test('EMBARGO_OFF sonrası onay yeniden mümkün', async () => {
  const { bus, governor } = setup();
  const window = { eventName: 'NFP', impact: 'HIGH', windowStart: 0, windowEnd: 9e15 };
  await bus.publish({ type: 'EMBARGO_ON', source: 'oracle', payload: window });
  await bus.publish({ type: 'EMBARGO_OFF', source: 'oracle', payload: window });
  const result = await governor.evaluateCandidate(candidateEnvelope());
  assert.equal(result.approved, true);
});

test('drawdown durum makinesi: %3,5 → SOFT_LOCK, %4,5 → HARD_LOCK', async () => {
  const { stateManager, governor, events } = setup();

  stateManager.recordPnl(-3600); // %3,6 günlük kayıp
  assert.equal(await governor.assessRiskState(), 'SOFT_LOCK');
  let ks = events.filter((e) => e.type === 'KILLSWITCH');
  assert.equal(ks.at(-1).payload.level, 'K2');
  assert.equal(ks.at(-1).payload.scope, 'SOFT_LOCK');

  const vetoed = await governor.evaluateCandidate(candidateEnvelope());
  assert.equal(vetoed.approved, false, 'SOFT_LOCK altında yeni giriş yok');

  stateManager.recordPnl(-1000); // toplam %4,6
  assert.equal(await governor.assessRiskState(), 'HARD_LOCK');
});

test('toplam DD %8 → K3 KILLSWITCH', async () => {
  const { stateManager, governor, events } = setup();
  stateManager.recordPnl(-4900);
  stateManager.rolloverDay(); // günlük sayaç sıfırlanır, toplam DD kalır
  stateManager.recordPnl(-3500); // toplam %8,4
  assert.equal(await governor.assessRiskState(), 'KILLSWITCH');
  const ks = events.filter((e) => e.type === 'KILLSWITCH').at(-1);
  assert.equal(ks.payload.level, 'K3');
});

test('kilit yalnızca sıkılaşır; gevşeme gün dönüşünde olur', async () => {
  const { stateManager, governor } = setup();
  stateManager.recordPnl(-3600);
  await governor.assessRiskState();
  assert.equal(stateManager.get('riskLock'), 'SOFT_LOCK');
  stateManager.recordPnl(+2000); // kayıp kısmen telafi
  await governor.assessRiskState();
  assert.equal(stateManager.get('riskLock'), 'SOFT_LOCK', 'gün içinde kilit gevşemez');
  stateManager.rolloverDay();
  assert.equal(stateManager.get('riskLock'), 'NONE');
});

test('asimetrik lot: ardışık kayıplarda geometrik küçülme (0,5 çarpan)', () => {
  const { governor } = setup();
  const base = governor.computeLotSize({ entry: 100, stop: 99 });
  governor.recordTradeOutcome(-1);
  const after1 = governor.computeLotSize({ entry: 100, stop: 99 });
  governor.recordTradeOutcome(-1);
  const after2 = governor.computeLotSize({ entry: 100, stop: 99 });
  assert.ok(Math.abs(after1.riskPct - base.riskPct * 0.5) < 1e-9, '1 kayıp → risk yarıya');
  assert.ok(Math.abs(after2.riskPct - base.riskPct * 0.25) < 1e-9, '2 kayıp → risk dörtte bire (Ek C)');
});

test('asimetrik lot: kazanç serisinde doğrusal ve tavanlı artış', () => {
  const { governor } = setup();
  for (let i = 0; i < 20; i += 1) governor.recordTradeOutcome(+1);
  const { riskPct } = governor.computeLotSize({ entry: 100, stop: 99 });
  assert.ok(riskPct <= 1.0, `risk tavanı %1,0 aşılamaz (gerçekleşen ${riskPct})`);
});

test('yüksek volatilite rejiminde risk kısılır', () => {
  const { governor } = setup();
  const normal = governor.computeLotSize({ entry: 100, stop: 99, regime: 'RANGE' });
  const highVol = governor.computeLotSize({ entry: 100, stop: 99, regime: 'HIGH_VOL' });
  assert.ok(highVol.riskPct < normal.riskPct);
});

test('FEED_STALE → SOFT_LOCK (yeni pozisyon açılışı askıya alınır)', async () => {
  const { bus, stateManager } = setup();
  await bus.publish({
    type: 'FEED_STALE', source: 'dataLayer',
    payload: { source: 'twelvedata', symbol: 'BTCUSD', reason: 'feed donması' },
  });
  assert.equal(stateManager.get('riskLock'), 'SOFT_LOCK');
});

test('broker mutabakatı: uyuşmazlık raporlanır, broker gerçeği kazanır', () => {
  const stateManager = new StateManager({});
  stateManager.set('positions', {
    'ghost-1': { brokerOrderId: 'ghost-1', symbol: 'BTCUSD', side: 'BUY', volume: 1 },
  }, { source: 'test' });
  const mismatches = stateManager.reconcile([
    { brokerOrderId: 'real-1', symbol: 'SOLUSD', side: 'SELL', volume: 2 },
  ]);
  const kinds = mismatches.map((m) => m.kind).sort();
  assert.deepEqual(kinds, ['LOCAL_GHOST_POSITION', 'UNKNOWN_BROKER_POSITION']);
  assert.deepEqual(Object.keys(stateManager.get('positions')), ['real-1'], 'yerel defter broker durumuna eşitlenir');
});
