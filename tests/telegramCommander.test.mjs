/**
 * TelegramCommander testleri (mock fetch — ağ yok):
 *   - İlk /start otomatik bağlar, dosyaya yazar, notifier'a chat ID verir
 *   - Bağsızken /start dışındaki mesajlar bağlamaz
 *   - Yabancı sohbet sessizce yok sayılır
 *   - /durum ve /bakiye snapshot'tan doğru render edilir
 *   - Offset ilerler (aynı güncelleme iki kez işlenmez)
 *   - Kalıcı dosyadan yeniden bağlanma (restart dayanıklılığı)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramCommander } from '../src/signals/telegramCommander.mjs';

const silentLogger = { info: () => {}, warn: () => {}, error: () => {} };

class FakeNotifier {
  chatId = null;
  sent = [];
  setChatId(id) { this.chatId = id; }
  sendText(text) { this.sent.push(text); }
}

function makeRig({ updatesQueue = [], statusProvider } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-'));
  const chatStorePath = join(dir, 'chat.json');
  const notifier = new FakeNotifier();
  let offsetSeen = [];
  const fetchImpl = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    offsetSeen.push(offset);
    const batch = updatesQueue.shift() ?? [];
    return { ok: true, json: async () => ({ ok: true, result: batch }) };
  };
  const commander = new TelegramCommander({
    token: 'test-token',
    notifier,
    statusProvider: statusProvider ?? (() => ({
      mode: 'shadow',
      state: { killzone: { zone: 'LONDON', active: true }, embargo: {}, riskLock: 'NONE' },
      symbols: [{
        symbol: 'GBPUSD', marketOpen: true,
        mtf: { structurer: { htfBias: 'LONG_BIAS', phase: 'MANIPULATION', narrativeConfirmed: true } },
      }],
      account: { equity: 1012.5, startingEquity: 1000, dailyPnl: 12.5, dailyDDPct: 0, totalDDPct: 0, total: 3, wins: 2, losses: 1, totalR: 2.4, avgR: 0.8, openCount: 0, rejectedCount: 1 },
      signals: [],
      feed: { verdicts: {} },
    })),
    chatStorePath,
    fetchImpl,
    logger: silentLogger,
  });
  return { commander, notifier, chatStorePath, offsetSeen: () => offsetSeen };
}

const msg = (updateId, chatId, text, extra = {}) => ({
  update_id: updateId,
  message: { chat: { id: chatId, username: 'mert', ...extra }, text },
});

test('ilk /start bağlar: dosya yazılır, notifier chat alır, karşılama gider', async () => {
  const { commander, notifier, chatStorePath } = makeRig({
    updatesQueue: [[msg(1, 777, '/start')]],
  });
  assert.equal(commander.boundChatId, null);
  await commander.pollOnce();

  assert.equal(commander.boundChatId, '777');
  assert.equal(notifier.chatId, '777');
  assert.ok(existsSync(chatStorePath));
  assert.equal(JSON.parse(readFileSync(chatStorePath, 'utf8')).chatId, 777);
  assert.ok(notifier.sent[0].includes('ICT BOT V5'), 'karşılama mesajı');
});

test('bağsızken /start dışındaki mesaj bağlamaz', async () => {
  const { commander, notifier } = makeRig({
    updatesQueue: [[msg(1, 777, 'merhaba'), msg(2, 777, '/durum')]],
  });
  await commander.pollOnce();
  assert.equal(commander.boundChatId, null);
  assert.equal(notifier.sent.length, 0);
});

test('yabancı sohbet yok sayılır; bağlı sohbet komut alır', async () => {
  const { commander, notifier } = makeRig({
    updatesQueue: [
      [msg(1, 777, '/start')],
      [msg(2, 999, '/bakiye'), msg(3, 777, '/bakiye')], // 999 yabancı
    ],
  });
  await commander.pollOnce();
  await commander.pollOnce();

  assert.equal(commander.telemetry.foreignIgnored, 1);
  const balanceMsgs = notifier.sent.filter((t) => t.includes('BAKİYE'));
  assert.equal(balanceMsgs.length, 1, 'yalnız bağlı sohbete yanıt');
  assert.ok(balanceMsgs[0].includes('1012.50'), 'equity render');
  assert.ok(balanceMsgs[0].includes('Toplam R: 2.4'));
});

test('/durum: killzone + sembol bias/faz + tarama işareti', async () => {
  const { commander, notifier } = makeRig({
    updatesQueue: [[msg(1, 777, '/start'), msg(2, 777, '/durum')]],
  });
  await commander.pollOnce();
  const durum = notifier.sent.find((t) => t.includes('DURUM'));
  assert.ok(durum.includes('LONDON'));
  assert.ok(durum.includes('GBPUSD: LONG MANIPULATION ✓TARAMADA'));
});

test('offset ilerler: işlenen güncelleme tekrar istenmez', async () => {
  const { commander, offsetSeen } = makeRig({
    updatesQueue: [[msg(5, 777, '/start')], []],
  });
  await commander.pollOnce();
  await commander.pollOnce();
  assert.deepEqual(offsetSeen(), [0, 6], 'ikinci tur offset=update_id+1');
});

test('restart dayanıklılığı: kayıtlı dosyadan bağ yeniden kurulur', async () => {
  const first = makeRig({ updatesQueue: [[msg(1, 777, '/start')]] });
  await first.commander.pollOnce();

  // Aynı dosyayla yeni komutçu (restart simülasyonu)
  const notifier2 = new FakeNotifier();
  const commander2 = new TelegramCommander({
    token: 'test-token',
    notifier: notifier2,
    chatStorePath: first.chatStorePath,
    fetchImpl: async () => ({ ok: true, json: async () => ({ ok: true, result: [] }) }),
    logger: silentLogger,
  });
  assert.equal(commander2.boundChatId, '777');
  assert.equal(notifier2.chatId, '777', 'notifier restart sonrası da bağlı');
});
