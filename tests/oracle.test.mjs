/**
 * Faz 1 Kabul Testleri (Ek B.2):
 *   - Killzone geçişleri doğru NY saatlerinde, sıfır kaçırma + sıfır mükerrer yayın.
 *   - Takvim kaynağı erişilemezse fail-closed: geniş ambargo yayını.
 *   - DST geçiş günleri için sentetik saat testleri.
 *   - Tüm yayınlar Faz 0 doğrulayıcısından geçer; Oracle özel yol kullanmaz.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolBus } from '../src/core/protocolBus.mjs';
import { Oracle } from '../src/agents/oracle.mjs';
import { activeKillzone, trueDayOpen, nyParts } from '../src/time/nyClock.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

// NY duvar saatine denk gelen UTC anı üretir (yaz saati: UTC-4, kış: UTC-5)
function nyTime(isoUtc) {
  return Date.parse(isoUtc);
}

test('nyClock: yaz saatinde (EDT, UTC-4) NY duvar saati doğru', () => {
  // 2026-06-10 14:30 UTC = 10:30 NY (EDT)
  const parts = nyParts(new Date(Date.UTC(2026, 5, 10, 14, 30)));
  assert.equal(parts.hour, 10);
  assert.equal(parts.minute, 30);
});

test('nyClock: kış saatinde (EST, UTC-5) NY duvar saati doğru', () => {
  // 2026-01-15 14:30 UTC = 09:30 NY (EST)
  const parts = nyParts(new Date(Date.UTC(2026, 0, 15, 14, 30)));
  assert.equal(parts.hour, 9);
  assert.equal(parts.minute, 30);
});

test('DST geçiş günü (2026-03-08, saat ileri): killzone sınırları kaymaz', () => {
  // 08 Mart 2026 02:00 EST → 03:00 EDT. NY_AM killzone 08:30 NY.
  // EDT'de 08:30 NY = 12:30 UTC
  const inKz = new Date(Date.UTC(2026, 2, 8, 12, 45)); // 08:45 NY EDT
  assert.equal(activeKillzone(inKz), 'NY_AM');
  // EST varsayan hatalı kod 13:30 UTC'yi 08:30 sanırdı; gerçekte 09:30 NY'dir — hâlâ NY_AM içi
  const stillIn = new Date(Date.UTC(2026, 2, 8, 13, 30));
  assert.equal(activeKillzone(stillIn), 'NY_AM');
  // 15:00 UTC = 11:00 NY EDT → NY_AM bitti
  const after = new Date(Date.UTC(2026, 2, 8, 15, 0));
  assert.equal(activeKillzone(after), null);
});

test('DST geçiş günü (2026-11-01, saat geri): EST dönüşü doğru', () => {
  // 01 Kasım 2026 02:00 EDT → 01:00 EST. Akşam: 20:30 NY EST = 01:30 UTC (+1 gün)
  const asia = new Date(Date.UTC(2026, 10, 2, 1, 30));
  assert.equal(activeKillzone(asia), 'ASIA');
});

test('trueDayOpen: 00:00 NY referansı DST farkındalıklı', () => {
  // 2026-06-10 10:30 NY → TDO = 2026-06-10 00:00 EDT = 04:00 UTC
  const now = new Date(Date.UTC(2026, 5, 10, 14, 30));
  const tdo = trueDayOpen(now);
  assert.equal(tdo, Date.UTC(2026, 5, 10, 4, 0, 0));
  // Kışın: 2026-01-15 09:30 NY → TDO = 05:00 UTC
  const winter = new Date(Date.UTC(2026, 0, 15, 14, 30));
  assert.equal(trueDayOpen(winter), Date.UTC(2026, 0, 15, 5, 0, 0));
});

function makeOracle({ clock, calendarProvider }) {
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  const events = [];
  bus.subscribe('KILLZONE_STATE', (env) => events.push(env));
  bus.subscribe('EMBARGO_ON', (env) => events.push(env));
  bus.subscribe('EMBARGO_OFF', (env) => events.push(env));
  const oracle = new Oracle({
    bus,
    calendarProvider: calendarProvider ?? { fetchToday: async () => [] },
    now: () => clock.t,
    logger: silentLogger,
  });
  return { bus, oracle, events };
}

test('killzone geçişleri: sıfır kaçırma, sıfır mükerrer yayın', async () => {
  // 2026-06-10 08:00 NY (12:00 UTC) → 11:30 NY arası, dakikalık tick
  const clock = { t: Date.UTC(2026, 5, 10, 12, 0) };
  const { oracle, events } = makeOracle({ clock });

  const end = Date.UTC(2026, 5, 10, 15, 30); // 11:30 NY
  while (clock.t <= end) {
    await oracle.tick();
    clock.t += 60_000;
  }

  const kzEvents = events.filter((e) => e.type === 'KILLZONE_STATE');
  // Beklenen: başlangıç durumu (NONE), 08:30 NY_AM açılış, 11:00 kapanış = 3 yayın
  assert.equal(kzEvents.length, 3, `mükerrer/kaçırılmış yayın var: ${kzEvents.map((e) => e.payload.zone)}`);
  assert.equal(kzEvents[0].payload.zone, 'NONE');
  assert.deepEqual(
    [kzEvents[1].payload.zone, kzEvents[1].payload.active],
    ['NY_AM', true],
  );
  assert.deepEqual(
    [kzEvents[2].payload.zone, kzEvents[2].payload.active],
    ['NONE', false],
  );
});

test('ambargo penceresi: HIGH etki T-30/T+15 doğru anlarda EMBARGO_ON/OFF', async () => {
  const newsAt = Date.UTC(2026, 5, 10, 12, 30); // 08:30 NY — NFP anı
  const clock = { t: newsAt - 60 * 60_000 };    // 1 saat önce başla
  const { oracle, events } = makeOracle({
    clock,
    calendarProvider: {
      fetchToday: async () => [{ eventName: 'NFP', impact: 'HIGH', scheduledAt: newsAt }],
    },
  });
  await oracle.syncCalendar();

  const end = newsAt + 30 * 60_000;
  while (clock.t <= end) {
    await oracle.tick();
    clock.t += 60_000;
  }

  const on = events.find((e) => e.type === 'EMBARGO_ON');
  const off = events.find((e) => e.type === 'EMBARGO_OFF');
  assert.ok(on, 'EMBARGO_ON yayınlanmalı');
  assert.ok(off, 'EMBARGO_OFF yayınlanmalı');
  assert.equal(on.payload.windowStart, newsAt - 30 * 60_000);
  assert.equal(on.payload.windowEnd, newsAt + 15 * 60_000);
  assert.ok(on.timestamp <= newsAt - 29 * 60_000, 'ambargo T-30 civarında açılmalı');
  assert.ok(off.timestamp > newsAt + 15 * 60_000, 'ambargo T+15 sonrasında kapanmalı');
});

test('fail-closed: takvim kaynağı erişilemezse geniş ambargo yayınlanır', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 12, 0) };
  const { oracle, events } = makeOracle({
    clock,
    calendarProvider: { fetchToday: async () => { throw new Error('API down'); } },
  });
  await oracle.syncCalendar();

  const on = events.find((e) => e.type === 'EMBARGO_ON');
  assert.ok(on, 'fail-closed ambargo yayınlanmalı');
  assert.equal(on.payload.eventName, 'CALENDAR_UNAVAILABLE');
  assert.equal(on.payload.impact, 'HIGH');
  assert.ok(oracle.isEmbargoActive());
});

test('Oracle özel yol kullanmaz: tüm yayınlar Faz 0 doğrulayıcısından geçer', async () => {
  const clock = { t: Date.UTC(2026, 5, 10, 12, 45) }; // killzone içi
  const bus = new ProtocolBus({ logger: silentLogger, now: () => clock.t });
  let validated = 0;
  const origPublish = bus.publishEnvelope.bind(bus);
  bus.publishEnvelope = async (env) => { validated += 1; return origPublish(env); };

  const oracle = new Oracle({
    bus, calendarProvider: { fetchToday: async () => [] },
    now: () => clock.t, logger: silentLogger,
  });
  await oracle.tick();
  assert.ok(validated >= 1, 'yayın protocolBus üzerinden geçmeli');
});
