/**
 * Faz B/C testleri:
 *   - DashboardServer: HTML, snapshot JSON, SSE akışı (signal + status + keep-alive)
 *   - SetupStats: kırılım, kademeli eşik etiketi, journal replay, gözlem grubu
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { DashboardServer } from '../src/dashboard/server.mjs';
import { SetupStats } from '../src/signals/setupStats.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

function httpGet(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('dashboard: / HTML döner, /api/snapshot JSON döner, 404 çalışır', async () => {
  const server = new DashboardServer({
    snapshotProvider: () => ({ time: 1, mode: 'shadow', symbols: [], signals: [] }),
    logger: silentLogger,
    config: { port: 0, snapshotIntervalMs: 60_000, keepAliveMs: 60_000, maxEventLog: 100 },
  });
  const port = await server.start(0);

  const html = await httpGet(port, '/');
  assert.equal(html.status, 200);
  assert.ok(html.body.includes('ICT BOT V5'));
  assert.ok(html.body.includes('Sinyal Akışı'));

  const snap = await httpGet(port, '/api/snapshot');
  assert.equal(snap.status, 200);
  assert.equal(JSON.parse(snap.body).mode, 'shadow');

  const missing = await httpGet(port, '/yok');
  assert.equal(missing.status, 404);
  server.stop();
});

test('dashboard: SSE istemcisi sinyal olayını alır', async () => {
  const server = new DashboardServer({
    snapshotProvider: () => ({ time: 1 }),
    logger: silentLogger,
    config: { port: 0, snapshotIntervalMs: 60_000, keepAliveMs: 60_000, maxEventLog: 100 },
  });
  const port = await server.start(0);

  const received = await new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port, path: '/events' }, (res) => {
      assert.equal(res.headers['content-type'], 'text/event-stream');
      let buffer = '';
      res.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('event: signal')) {
          req.destroy();
          resolve(buffer);
        }
      });
      // bağlantı kurulduktan sonra yayın yap
      setTimeout(() => {
        server.onSignalEvent('APPROVED', { id: 'x', symbol: 'BTCUSD', side: 'BUY', entry: 100 });
      }, 20);
    });
    req.on('error', reject);
    req.end();
    setTimeout(() => reject(new Error('SSE zaman aşımı')), 2000);
  });

  assert.ok(received.includes('event: signal'));
  assert.ok(received.includes('BTCUSD'));
  server.stop();
});

test('setupStats: kırılım + kademeli eşik etiketleri + hipotetik ayrımı', () => {
  const stats = new SetupStats({ tiers: { floor: 3, validation: 5, promotion: 8 } });
  const signal = (outcome) => ({
    setupFamily: 'SWEEP_MSS_FVG', outcome,
    quality: { regime: 'RANGE', killzone: 'NY_AM' },
  });
  stats.onSignalEvent('CLOSED', signal('WIN'));
  stats.onSignalEvent('CLOSED', signal('LOSS'));

  let [row] = stats.breakdown();
  assert.equal(row.samples, 2);
  assert.equal(row.tier, 'veri yetersiz', '3 altı örnek yetersiz etiketli');
  assert.equal(row.winRate, 0.5);

  stats.onSignalEvent('HYPOTHETICAL', { ...signal(null), hypotheticalOutcome: 'WOULD_HAVE_WON' });
  [row] = stats.breakdown();
  assert.equal(row.samples, 3);
  assert.equal(row.realSamples, 2);
  assert.equal(row.hypoSamples, 1);
  assert.equal(row.tier, 'ön gösterge');
});

test('setupStats: gözlem grubu DIŞI killzone hücresine düşer (A/B verisi)', () => {
  const stats = new SetupStats();
  stats.recordObservation({ setupFamily: 'SWEEP_MSS_FVG', quality: { regime: 'TREND' } });
  stats.recordObservationOutcome({ setupFamily: 'SWEEP_MSS_FVG', quality: { regime: 'TREND' } }, 'WOULD_HAVE_LOST');
  const row = stats.breakdown().find((r) => r.killzone === 'DIŞI');
  assert.ok(row);
  assert.equal(row.observed, 1);
  assert.equal(row.hypoSamples, 1);
  assert.equal(row.winRate, 0);
});

test('setupStats: journal replay aynı sayaçları kurar (restart dayanıklılığı)', () => {
  const live = new SetupStats();
  const replayed = new SetupStats();
  const records = [
    { kind: 'signal', event: 'CLOSED', signal: { setupFamily: 'SWEEP_MSS_FVG', outcome: 'WIN', quality: { regime: 'RANGE', killzone: 'LONDON' } } },
    { kind: 'signal', event: 'VETOED', signal: { setupFamily: 'SWEEP_MSS_FVG', quality: { regime: 'RANGE', killzone: 'LONDON' } } },
    { kind: 'observation', observation: { setupFamily: 'SWEEP_MSS_FVG', quality: { regime: 'RANGE' } } },
  ];
  live.onSignalEvent('CLOSED', records[0].signal);
  live.onSignalEvent('VETOED', records[1].signal);
  live.recordObservation(records[2].observation);
  for (const r of records) replayed.ingestJournalRecord(r);

  assert.deepEqual(replayed.breakdown(), live.breakdown());
});
