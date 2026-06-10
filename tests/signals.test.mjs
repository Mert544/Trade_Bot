/**
 * Faz A testleri — sinyal omurgası:
 *   - SignalHub yaşam döngüsü: CANDIDATE → APPROVED/VETOED → INVALIDATED/EXPIRED/CLOSED
 *   - Kalite vektörü zenginleştirme (rejim/killzone bağlamı)
 *   - TelegramNotifier: format, kuyruk, 429 retry_after, env yokken devre dışı
 *   - Journal: append + replay + bozuk satır dayanıklılığı
 *   - Uçtan uca: onaylı sinyal → fill → fiyat stop'a gelir → CLOSED + PnL döngüsü
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { StateManager } from '../src/core/stateManager.mjs';
import { SignalHub, SIGNAL_EVENT, SIGNAL_STATUS } from '../src/signals/signalHub.mjs';
import { TelegramNotifier } from '../src/signals/telegramNotifier.mjs';
import { Journal } from '../src/persistence/journal.mjs';
import { createEcosystem } from '../src/index.mjs';
import { BIAS, MMXM_PHASE } from '../src/agents/structurer.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function hubSetup() {
  const clock = { t: 1_000_000 };
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  const stateManager = new StateManager({});
  stateManager.set('regime.BTCUSD', { regime: 'TREND', score: 0.7 }, { source: 'test' });
  stateManager.set('killzone', { zone: 'NY_AM', active: true }, { source: 'test' });
  const hub = new SignalHub({ bus, stateManager, now: () => clock.t, logger: silentLogger });
  hub.start();
  const events = [];
  hub.addSink({ onSignalEvent: (type, signal) => events.push({ type, signal }) });
  return { clock, bus, hub, events };
}

const candidatePayload = {
  symbol: 'BTCUSD', side: 'BUY', entry: 100, stop: 99, targets: [103],
  setupFamily: 'SWEEP_MSS_FVG', confidence: 0.75,
  quality: { sweepDepthPct: 0.2, poolStrength: 2, fvgSizePct: 0.1 },
  evidence: ['test kanıtı'],
};

async function publishCandidate(bus, overrides = {}) {
  const { envelope } = await bus.publish({
    type: 'SETUP_CANDIDATE', source: 'structurer', confidence: 0.75,
    payload: { ...candidatePayload, ...overrides },
    ttlMs: 90_000,
  });
  return envelope;
}

test('yaşam döngüsü: aday → onay; RR ve kalite bağlamı hesaplanır', async () => {
  const { bus, hub, events } = hubSetup();
  const env = await publishCandidate(bus);
  await bus.publish({
    type: 'RISK_APPROVAL', source: 'governor', correlationId: env.correlationId,
    payload: { candidateId: env.msgId, lotSize: 0.5, maxSlippage: 1.5, ttl: 90_000 },
  });

  const signal = hub.get(env.correlationId);
  assert.equal(signal.status, SIGNAL_STATUS.APPROVED);
  assert.equal(signal.rr, 3, 'RR = |103-100|/|100-99|');
  assert.equal(signal.quality.regime, 'TREND', 'rejim bağlamı zenginleştirilir');
  assert.equal(signal.quality.killzone, 'NY_AM');
  assert.equal(signal.quality.sweepDepthPct, 0.2, 'mtf kalite bileşenleri taşınır');
  assert.deepEqual(events.map((e) => e.type), [SIGNAL_EVENT.NEW, SIGNAL_EVENT.APPROVED]);
});

test('yaşam döngüsü: veto + yapı geçersizleşmesi geri çekme üretir', async () => {
  const { bus, hub, events } = hubSetup();
  const env1 = await publishCandidate(bus);
  await bus.publish({
    type: 'RISK_VETO', source: 'governor', correlationId: env1.correlationId,
    payload: { candidateId: env1.msgId, vetoReason: 'Ambargo aktif' },
  });
  assert.equal(hub.get(env1.correlationId).status, SIGNAL_STATUS.VETOED);

  const env2 = await publishCandidate(bus);
  await bus.publish({
    type: 'STRUCTURE_INVALIDATED', source: 'structurer',
    payload: { symbol: 'BTCUSD', reason: '4H bias değişimi', invalidatedCandidates: [env2.msgId] },
  });
  const s2 = hub.get(env2.correlationId);
  assert.equal(s2.status, SIGNAL_STATUS.INVALIDATED);
  assert.ok(events.some((e) => e.type === SIGNAL_EVENT.INVALIDATED));
});

test('yaşam döngüsü: TTL dolan aday EXPIRED olur', async () => {
  const clock = { t: 1_000_000 };
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  const hub = new SignalHub({
    bus, now: () => clock.t, logger: silentLogger,
    config: { expirySweepMs: 5, maxLiveSignals: 200 }, // hızlı süpürme: deterministik test
  });
  hub.start();
  const events = [];
  hub.addSink({ onSignalEvent: (type) => events.push(type) });

  const env = await publishCandidate(bus);
  clock.t += 120_000; // ttl 90sn aşıldı
  await new Promise((r) => setTimeout(r, 30)); // 5ms süpürme aralığı birkaç kez koşar
  hub.stop();

  assert.equal(hub.get(env.correlationId).status, SIGNAL_STATUS.EXPIRED);
  assert.ok(events.includes(SIGNAL_EVENT.EXPIRED));
});

test('telegram: env yoksa devre dışı, format Türkçe ve eksiksiz', () => {
  const disabled = new TelegramNotifier({ token: null, chatId: null, logger: silentLogger });
  assert.equal(disabled.enabled, false);

  const notifier = new TelegramNotifier({ token: 'T', chatId: 'C', logger: silentLogger });
  const approved = notifier.format(SIGNAL_EVENT.APPROVED, {
    symbol: 'BTCUSD', side: 'BUY', entry: 100, stop: 99, targets: [103],
    setupFamily: 'SWEEP_MSS_FVG', confidence: 0.75, rr: 3,
    evidence: ['4H LONG', 'MSS teyitli'], expiresAt: 200_000, updatedAt: 110_000,
  });
  assert.ok(approved.includes('SİNYAL — BTCUSD'));
  assert.ok(approved.includes('ALIŞ'));
  assert.ok(approved.includes('Giriş: <b>100</b>'));
  assert.ok(approved.includes('Kanıt zinciri'));

  const vetoed = notifier.format(SIGNAL_EVENT.VETOED, {
    symbol: 'BTCUSD', side: 'SELL', entry: 100, vetoReason: 'Ambargo',
  });
  assert.ok(vetoed.startsWith('❌'), 'veto tek satır özet');
  assert.ok(vetoed.includes('Ambargo'));

  const invalidated = notifier.format(SIGNAL_EVENT.INVALIDATED, {
    symbol: 'BTCUSD', side: 'BUY', entry: 100, invalidationReason: '4H bias değişti',
  });
  assert.ok(invalidated.includes('GERİ ÇEKİLDİ'));

  assert.equal(notifier.format(SIGNAL_EVENT.VOTE, {}), null, 'oylar Telegram\'a gitmez');
});

test('telegram: kuyruk sırayla gönderir, 429 retry_after bekletir', async () => {
  let clock = 0;
  const calls = [];
  let respond429Once = true;
  const notifier = new TelegramNotifier({
    token: 'T', chatId: 'C', logger: silentLogger,
    now: () => clock,
    config: { minIntervalMs: 0, maxQueue: 10 },
    fetchImpl: async (url, opts) => {
      calls.push(JSON.parse(opts.body).text);
      if (respond429Once) {
        respond429Once = false;
        return { status: 429, ok: false, json: async () => ({ parameters: { retry_after: 0 } }) };
      }
      return { status: 200, ok: true, json: async () => ({ ok: true }) };
    },
  });
  notifier.onSignalEvent(SIGNAL_EVENT.VETOED, { symbol: 'A', side: 'BUY', entry: 1, vetoReason: 'x' });
  notifier.onSignalEvent(SIGNAL_EVENT.VETOED, { symbol: 'B', side: 'BUY', entry: 1, vetoReason: 'y' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(notifier.telemetry.rateLimited, 1);
  assert.equal(notifier.telemetry.sent, 2, '429 sonrası mesaj kuyruktan tekrar gönderilir');
  assert.ok(calls.length >= 3, 'ilk mesaj iki kez denenir (429 + başarı)');
});

test('journal: append + replay; bozuk satır boot\'u engellemez', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ict-journal-'));
  const journal = new Journal({ dir, now: () => Date.UTC(2026, 5, 10, 12, 0), logger: silentLogger });
  journal.onSignalEvent(SIGNAL_EVENT.NEW, { id: 'c1', symbol: 'BTCUSD', status: 'CANDIDATE' });
  journal.append({ kind: 'postmortem', correlationId: 'c1', outcome: 'WIN' });

  // bozuk satır enjeksiyonu
  const file = readdirSync(dir)[0];
  appendFileSync(join(dir, file), 'BOZUK SATIR {{{\n');

  const journal2 = new Journal({ dir, logger: silentLogger });
  const records = [];
  const count = journal2.replay((r) => records.push(r));
  assert.equal(count, 2, 'geçerli kayıtlar okunur');
  assert.equal(journal2.telemetry.replayErrors, 1, 'bozuk satır sayılır, fırlatılmaz');
  assert.equal(records[0].kind, 'signal');
  assert.equal(records[1].kind, 'postmortem');
});

test('uçtan uca geri besleme: onay → fill → stop vuruşu → CLOSED + Governor streak + PnL', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 13, 0) }; // killzone içi
  const eco = createEcosystem({
    mode: 'shadow', logger: silentLogger, now: () => clock.t,
    calendarProvider: { fetchToday: async () => [] },
  });
  eco.governor.start(); eco.structurer.start(); eco.sniper.start(); eco.signalHub.start();
  const hubEvents = [];
  eco.signalHub.addSink({ onSignalEvent: (type, s) => hubEvents.push({ type, status: s.status, outcome: s.outcome }) });

  await eco.oracle.tick();
  eco.broker.setQuote('BTCUSD', { bid: 99.99, ask: 100.01 });
  await eco.structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 103 });
  await eco.structurer.updateNarrativePhase('BTCUSD', { phase: MMXM_PHASE.MANIPULATION, alignedWithBias: true });
  const proposal = await eco.structurer.proposeSetup('BTCUSD', {
    side: 'BUY', entry: 100, stop: 99, targets: [103],
    setupFamily: 'SWEEP_MSS_FVG', mssConfirmed: true,
    quality: { sweepDepthPct: 0.3, poolStrength: 2, fvgSizePct: 0.1 },
  });
  assert.equal(proposal.proposed, true);

  // Gerçekçi limit akışı: fiyat giriş bölgesine dönmeden fill yok
  assert.equal(eco.shadowLedger.stats().openCount, 0, 'fill öncesi sanal pozisyon yok');
  eco.broker.setQuote('BTCUSD', { bid: 99.97, ask: 99.99 });
  await eco.sniper.onQuote('BTCUSD', {});
  assert.equal(eco.shadowLedger.stats().openCount, 1, 'geri test dolumu sanal defteri açar');

  const equityBefore = eco.stateManager.get('equity');
  eco.shadowLedger.onPrice('BTCUSD', 98.9); // stop vuruşu
  await new Promise((r) => setTimeout(r, 10)); // async onClose zinciri

  const closed = hubEvents.find((e) => e.type === 'CLOSED');
  assert.ok(closed && closed.outcome === 'LOSS', 'sinyal CLOSED/LOSS olmalı');
  assert.ok(eco.stateManager.get('equity') < equityBefore, 'kayıp equity\'e işlenir');
  assert.equal(eco.governor.streak, -1, 'Governor ardışık sonuç serisi güncellenir');
  assert.equal(eco.shadowLedger.stats().losses, 1);
  // R-multiple: stop vuruşu ≈ −1R (maliyetlerle bir miktar altında)
  const trade = eco.shadowLedger.closedTrades()[0];
  assert.ok(trade.rMultiple <= -1 && trade.rMultiple > -1.6, `stop ≈ −1R bekleniyordu: ${trade.rMultiple}`);
  eco.stop();
});

test('fill olmayan onaylı sinyal TTL sonunda UNFILLED/EXPIRED olur (uygulanabilirlik ölçüsü)', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 13, 0) };
  const eco = createEcosystem({
    mode: 'shadow', logger: silentLogger, now: () => clock.t,
    calendarProvider: { fetchToday: async () => [] },
  });
  eco.governor.start(); eco.structurer.start(); eco.sniper.start(); eco.signalHub.start();
  const hubEvents = [];
  eco.signalHub.addSink({ onSignalEvent: (type, s) => hubEvents.push({ type, unfilled: s.unfilled }) });

  await eco.oracle.tick();
  eco.broker.setQuote('BTCUSD', { bid: 99.99, ask: 100.01 });
  await eco.structurer.updateHtfBias('BTCUSD', { htfBias: BIAS.LONG, dolLevel: 103 });
  await eco.structurer.updateNarrativePhase('BTCUSD', { phase: MMXM_PHASE.MANIPULATION, alignedWithBias: true });
  await eco.structurer.proposeSetup('BTCUSD', {
    side: 'BUY', entry: 100, stop: 99, targets: [103],
    setupFamily: 'SWEEP_MSS_FVG', mssConfirmed: true,
  });

  // Fiyat girişe hiç dönmüyor; TTL (90sn) aşılıyor
  clock.t += 120_000;
  eco.broker.setQuote('BTCUSD', { bid: 100.5, ask: 100.52 });
  await eco.sniper.onQuote('BTCUSD', {});

  const expired = hubEvents.find((e) => e.type === 'EXPIRED');
  assert.ok(expired, 'EXPIRED olayı yayınlanmalı');
  assert.equal(expired.unfilled, true, 'unfilled bayrağı taşımalı');
  assert.equal(eco.shadowLedger.stats().openCount, 0, 'hayalet pozisyon yok');
  assert.equal(eco.broker.pendingOrders().length, 0, 'broker bekleyeni iptal edildi');
  eco.stop();
});
