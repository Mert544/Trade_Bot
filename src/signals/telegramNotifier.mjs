/**
 * Telegram sinyal bildirimi (ücretsiz — api.telegram.org, bağımlılıksız fetch).
 *
 * TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID env yoksa sessizce devre dışı kalır;
 * kullanıcı token'ı sonradan eklediğinde otomatik devreye girer.
 *
 * Dayanıklılık: mesaj kuyruğu + asgari gönderim aralığı (~1 msg/sn limiti),
 * 429 yanıtında retry_after'a uyum, ağ hatasında mesajı düşürüp loglama
 * (sinyal kaybolmaz — journal ve dashboard'da durur; Telegram en iyi-çaba kanaldır).
 *
 * Kullanıcı kararı: onaylılar tam detay, vetolular tek satır özet,
 * iptal/sonuç güncellemeleri ayrı mesaj.
 */

import { CONFIG } from '../config/defaults.mjs';
import { SIGNAL_EVENT } from './signalHub.mjs';

export class TelegramNotifier {
  #token;
  #chatId;
  #fetchImpl;
  #config;
  #now;
  #logger;
  #queue = [];
  #sending = false;
  #nextAllowedAt = 0;

  telemetry = { sent: 0, dropped: 0, rateLimited: 0, errors: 0 };

  constructor({
    token = process.env.TELEGRAM_BOT_TOKEN,
    chatId = process.env.TELEGRAM_CHAT_ID,
    fetchImpl = fetch,
    config = CONFIG.signals.telegram,
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.#token = token;
    this.#chatId = chatId;
    this.#fetchImpl = fetchImpl;
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
    if (!this.#token) {
      logger.info('[telegram] TELEGRAM_BOT_TOKEN yok — bildirim devre dışı (dashboard + journal çalışmaya devam eder)');
    }
    // Token var ama chat yok: commander /start ile geç-bağlar, burada log gereksiz
  }

  get enabled() {
    return Boolean(this.#token && this.#chatId);
  }

  get hasToken() {
    return Boolean(this.#token);
  }

  /**
   * Geç bağlama: TelegramCommander /start aldığında chat ID'yi buraya
   * yazar — kullanıcının elle getUpdates kazısı yapması gerekmez.
   */
  setChatId(chatId) {
    this.#chatId = String(chatId);
  }

  /** Serbest metin (günlük rapor vb.) — aynı kuyruk/limit disiplinine tabi. */
  sendText(text) {
    if (!this.enabled || !text) return;
    if (this.#queue.length >= this.#config.maxQueue) {
      this.telemetry.dropped += 1;
      return;
    }
    this.#queue.push(text);
    this.#drain();
  }

  /** SignalHub sink arayüzü. */
  onSignalEvent(eventType, signal) {
    if (!this.enabled) return;
    const text = this.format(eventType, signal);
    if (!text) return; // bu olay türü Telegram'a gitmiyor
    if (this.#queue.length >= this.#config.maxQueue) {
      this.telemetry.dropped += 1;
      return;
    }
    this.#queue.push(text);
    this.#drain();
  }

  /** Olay türü → Türkçe mesaj. null = gönderilmez (VOTE gibi gürültülü olaylar). */
  format(eventType, s) {
    const fiyat = (v) => (typeof v === 'number' ? String(v) : '—');
    const yon = s.side === 'BUY' ? '🟢 ALIŞ' : '🔴 SATIŞ';
    switch (eventType) {
      case SIGNAL_EVENT.APPROVED: {
        const hedefler = (s.targets ?? []).map(fiyat).join(', ');
        const kanit = (s.evidence ?? []).map((e) => `• ${e}`).join('\n');
        const gecerli = Math.max(0, Math.round((s.expiresAt - s.updatedAt) / 1000));
        return [
          `✅ <b>SİNYAL — ${s.symbol}</b> ${yon}`,
          `Kurulum: ${s.setupFamily} | Güven: ${(s.confidence * 100).toFixed(0)}% | RR: ${s.rr}`,
          `Giriş: <b>${fiyat(s.entry)}</b> | Stop: <b>${fiyat(s.stop)}</b> | Hedef: <b>${hedefler}</b>`,
          `Geçerlilik: ~${gecerli} sn`,
          `<i>Kanıt zinciri:</i>\n${kanit}`,
        ].join('\n');
      }
      case SIGNAL_EVENT.VETOED:
        return `❌ <b>${s.symbol}</b> ${yon} ${fiyat(s.entry)} — veto: <i>${s.vetoReason}</i>`;
      case SIGNAL_EVENT.INVALIDATED:
        return `⚠️ <b>SİNYAL GERİ ÇEKİLDİ — ${s.symbol}</b>\nGerekçe: ${s.invalidationReason}\n(Giriş ${fiyat(s.entry)} artık geçersiz)`;
      case SIGNAL_EVENT.EXPIRED:
        return s.status === 'EXPIRED' && s.lotSize !== undefined
          ? `⏱ <b>${s.symbol}</b> sinyali süre doldu — ${s.unfilledReason ?? `giriş ${fiyat(s.entry)} gerçekleşmedi`}`
          : null; // onaylanmamış adayın süresi sessiz dolar
      case SIGNAL_EVENT.CLOSED: {
        const emoji = s.outcome === 'WIN' ? '🎯' : '🛑';
        return `${emoji} <b>${s.symbol}</b> gölge sonuç: <b>${s.outcome === 'WIN' ? 'HEDEF' : 'STOP'}</b> @ ${fiyat(s.exit)} (net ${s.netPnl?.toFixed(2)})`;
      }
      default:
        return null; // NEW (onay öncesi), VOTE, HYPOTHETICAL → yalnız dashboard/journal
    }
  }

  async #drain() {
    if (this.#sending) return;
    this.#sending = true;
    try {
      while (this.#queue.length > 0) {
        const wait = this.#nextAllowedAt - this.#now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const text = this.#queue[0];
        const ok = await this.#send(text);
        if (ok) this.#queue.shift();
        // ok=false ve 429 ise nextAllowedAt güncellendi, döngü bekleyip dener;
        // kalıcı hata ise #send mesajı düşürmüştür (shift orada yapılır).
      }
    } finally {
      this.#sending = false;
    }
  }

  async #send(text) {
    try {
      const res = await this.#fetchImpl(`https://api.telegram.org/bot${this.#token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.#chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        const retryAfter = body?.parameters?.retry_after ?? 5;
        this.#nextAllowedAt = this.#now() + retryAfter * 1000;
        this.telemetry.rateLimited += 1;
        return false; // kuyrukta kalır, bekleyip yeniden denenir
      }
      if (!res.ok) {
        // Kalıcı hata (geçersiz chat_id vb.): mesaj düşürülür, akış tıkanmaz
        this.telemetry.errors += 1;
        this.#queue.shift();
        this.#logger.error(`[telegram] sendMessage HTTP ${res.status} — mesaj düşürüldü`);
        return false;
      }
      this.telemetry.sent += 1;
      this.#nextAllowedAt = this.#now() + this.#config.minIntervalMs;
      return true;
    } catch (err) {
      this.telemetry.errors += 1;
      this.#queue.shift(); // ağ hatası: en iyi-çaba kanal, journal kalıcı kayıttır
      this.#logger.error(`[telegram] gönderim hatası: ${err.message}`);
      return false;
    }
  }
}

export default TelegramNotifier;
