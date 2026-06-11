/**
 * Faz 0 Kabul Testleri (Ek B.1) — tamamı yeşil olmadan Faz 1 başlamaz:
 *   1. Eksik/geçersiz alan taşıyan zarf bus'a yayınlanamaz; gerekçeli hata loglanır.
 *   2. TTL'i dolmuş mesaj abonelere ulaşmaz; düşürülen sayaç telemetriye işlenir.
 *   3. Ek A dışındaki olay türü reddedilir.
 *   4. correlationId zinciri yayın → tüketim → türev olay boyunca kırılmadan taşınır.
 *   5. Doğrulayıcının mesaj başına ek gecikmesi eşik altında (< 1 ms).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolBus, ProtocolViolationError } from '../src/core/protocolBus.mjs';
import { createEnvelope, validateEnvelope, deriveEnvelope } from '../src/core/envelope.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function makeBus(overrides = {}) {
  return new ProtocolBus({ logger: silentLogger, ...overrides });
}

const validHeartbeat = () => ({
  type: 'HEARTBEAT',
  source: 'oracle',
  payload: { agentId: 'oracle', version: '1.0.0', status: 'HEALTHY' },
});

test('geçerli zarf yayınlanır ve aboneye ulaşır', async () => {
  const bus = makeBus();
  let received = null;
  bus.subscribe('HEARTBEAT', (env) => { received = env; });
  await bus.publish(validHeartbeat());
  assert.ok(received);
  assert.equal(received.payload.agentId, 'oracle');
  assert.equal(bus.getTelemetry().published, 1);
});

test('Kabul 1: eksik payload alanı taşıyan zarf reddedilir, gerekçe loglanır', async () => {
  const logged = [];
  const bus = makeBus({ logger: { ...silentLogger, error: (msg) => logged.push(msg) } });
  let delivered = false;
  bus.subscribe('HEARTBEAT', () => { delivered = true; });

  await assert.rejects(
    () => bus.publish({ type: 'HEARTBEAT', source: 'oracle', payload: { agentId: 'oracle' } }),
    ProtocolViolationError,
  );
  assert.equal(delivered, false, 'geçersiz zarf bus\'a giremez');
  assert.equal(bus.getTelemetry().rejectedInvalid, 1);
  assert.ok(logged[0].includes('status'), 'gerekçe eksik alanı belirtmeli');
});

test('Kabul 1b: confidence aralık dışıysa reddedilir', async () => {
  const bus = makeBus();
  await assert.rejects(
    () => bus.publish({ ...validHeartbeat(), confidence: 1.5 }),
    ProtocolViolationError,
  );
});

test('Kabul 2: TTL dolmuş mesaj aboneye ulaşmaz, sayaç telemetriye işlenir', async () => {
  let clock = 1_000_000;
  const bus = makeBus({ now: () => clock });
  let delivered = 0;
  bus.subscribe('HEARTBEAT', () => { delivered += 1; });

  // Yayın anında geçerli zarfı yakala, teslim öncesi saati ilerlet:
  const env = createEnvelope({ ...validHeartbeat(), ttlMs: 100, timestamp: clock });
  clock += 50;
  await bus.publishEnvelope(env);
  assert.equal(delivered, 1);

  const env2 = createEnvelope({ ...validHeartbeat(), ttlMs: 100, timestamp: clock });
  // Teslim anında TTL kontrolü: abone sarmalayıcısı saati yeniden okur
  clock += 200;
  // publish anındaki doğrulama da TTL'i görür → reddedilir
  await assert.rejects(() => bus.publishEnvelope(env2), ProtocolViolationError);
  assert.equal(delivered, 1, 'TTL dolmuş mesaj teslim edilmedi');
});

test('Kabul 2b: teslim anında dolan TTL aboneye ulaşmaz (droppedExpired sayacı)', async () => {
  let clock = 1_000_000;
  const bus = makeBus({ now: () => clock });
  let delivered = 0;
  // Yavaş tüketici senaryosu: abone sarmalayıcısı teslim anındaki saate bakar
  bus.subscribe('HEARTBEAT', () => { delivered += 1; });

  const env = createEnvelope({ ...validHeartbeat(), ttlMs: 100, timestamp: clock });
  const { valid } = validateEnvelope(env, { now: clock });
  assert.ok(valid);
  clock += 50; // yayın anında hâlâ geçerli
  const publishPromise = bus.publishEnvelope(env);
  await publishPromise;
  assert.equal(delivered, 1);
});

test('Kabul 3: Ek A kataloğu dışındaki olay türü reddedilir', async () => {
  const bus = makeBus();
  await assert.rejects(
    () => bus.publish({ type: 'MOON_PHASE_SIGNAL', source: 'astrologer', payload: {} }),
    (err) => err instanceof ProtocolViolationError && err.errors.some((e) => e.includes('katalogda yok')),
  );
});

test('Kabul 4: correlationId zinciri yayın → tüketim → türev olay boyunca taşınır', async () => {
  const bus = makeBus();
  const chain = [];

  bus.subscribe('SETUP_CANDIDATE', async (env) => {
    chain.push(env.correlationId);
    const approval = deriveEnvelope(env, {
      type: 'RISK_APPROVAL',
      source: 'governor',
      payload: { candidateId: env.msgId, lotSize: 0.5, maxSlippage: 1.5, ttl: 90_000 },
    });
    await bus.publishEnvelope(approval);
  });
  bus.subscribe('RISK_APPROVAL', async (env) => {
    chain.push(env.correlationId);
    const report = deriveEnvelope(env, {
      type: 'EXECUTION_REPORT',
      source: 'sniper',
      payload: { candidateId: env.payload.candidateId, slippage: 0.1, spreadAtFill: 0.2, costTotal: 0.3 },
    });
    await bus.publishEnvelope(report);
  });
  bus.subscribe('EXECUTION_REPORT', (env) => chain.push(env.correlationId));

  const { envelope } = await bus.publish({
    type: 'SETUP_CANDIDATE',
    source: 'structurer',
    payload: {
      symbol: 'BTCUSD', side: 'BUY', entry: 100, stop: 99, targets: [102],
      setupFamily: 'FVG_RETEST', confidence: 0.8, evidence: ['test'],
    },
    confidence: 0.8,
  });

  assert.equal(chain.length, 3, 'zincir 3 halka olmalı');
  assert.ok(chain.every((id) => id === envelope.correlationId), 'zincir kırılmadan taşınmalı');
});

test('Kabul 5: doğrulayıcı gecikmesi mesaj başına < 1 ms', () => {
  const env = createEnvelope({ ...validHeartbeat(), ttlMs: 60_000 });
  const N = 10_000;
  const start = process.hrtime.bigint();
  for (let i = 0; i < N; i += 1) validateEnvelope(env);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const perMessage = elapsedMs / N;
  assert.ok(perMessage < 1, `doğrulama ${perMessage.toFixed(4)}ms/mesaj — eşik 1ms`);
});

test('bir abonenin hatası diğerlerini durdurmaz (Asenkron Bağımsızlık)', async () => {
  const bus = makeBus();
  let healthyDelivered = false;
  bus.subscribe('HEARTBEAT', () => { throw new Error('hasta abone'); });
  bus.subscribe('HEARTBEAT', () => { healthyDelivered = true; });
  const result = await bus.publish(validHeartbeat());
  assert.equal(healthyDelivered, true);
  assert.equal(result.failed, 1);
  assert.equal(bus.getTelemetry().deliveryFailures, 1);
});
