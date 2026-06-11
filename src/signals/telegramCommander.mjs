/**
 * TelegramCommander — iki yönlü bot: komutlar + otomatik bağlanma.
 *
 * Uzun yoklama (getUpdates, 25 sn) ile dinler. İlk /start gelen sohbete
 * OTOMATİK BAĞLANIR (chat ID elle kazılmaz), kalıcı dosyaya yazar
 * (state/telegram-chat.json) — restart'ta bağ korunur.
 *
 * GÜVENLİK MODELİ: bot token'ını bilen herkes bota yazabilir; bu yüzden
 *   - bağlandıktan sonra YALNIZ bağlı sohbetin komutları işlenir,
 *   - yabancı sohbetler sessizce yok sayılır (telemetriye sayılır),
 *   - bağ yalnız İLK /start'ta kurulur; sonra değişmez (değiştirmek için
 *     state/telegram-chat.json silinir).
 *
 * Komutlar: /durum /bakiye /sinyaller /rapor /yardim
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export class TelegramCommander {
  #token;
  #notifier;
  #statusProvider;
  #chatStorePath;
  #fetchImpl;
  #logger;
  #now;
  #offset = 0;
  #chatId = null;
  #running = false;
  #firstPollOk = false;
  #pollIntervalMs;

  telemetry = { updates: 0, commands: 0, foreignIgnored: 0, pollErrors: 0 };

  constructor({
    token = process.env.TELEGRAM_BOT_TOKEN,
    notifier,
    statusProvider = () => ({}),
    chatStorePath = 'state/telegram-chat.json',
    pollIntervalMs = 2000,
    fetchImpl = fetch,
    logger = console,
    now = () => Date.now(),
  } = {}) {
    this.#pollIntervalMs = pollIntervalMs;
    this.#token = token;
    this.#notifier = notifier;
    this.#statusProvider = statusProvider;
    this.#chatStorePath = chatStorePath;
    this.#fetchImpl = fetchImpl;
    this.#logger = logger;
    this.#now = now;
    this.#loadStoredChat();
  }

  get enabled() {
    return Boolean(this.#token);
  }

  get boundChatId() {
    return this.#chatId;
  }

  #loadStoredChat() {
    try {
      if (existsSync(this.#chatStorePath)) {
        const stored = JSON.parse(readFileSync(this.#chatStorePath, 'utf8'));
        if (stored?.chatId) {
          this.#chatId = String(stored.chatId);
          this.#notifier?.setChatId(this.#chatId);
          this.#logger.info(`[telegram] kayıtlı sohbete bağlı (${stored.username ?? this.#chatId})`);
        }
      }
    } catch {
      // bozuk dosya: bağsız başlanır, ilk /start yeniden kurar
    }
  }

  #bind(chat) {
    this.#chatId = String(chat.id);
    this.#notifier?.setChatId(this.#chatId);
    mkdirSync(dirname(this.#chatStorePath), { recursive: true });
    writeFileSync(this.#chatStorePath, JSON.stringify({
      chatId: chat.id,
      username: chat.username ?? null,
      firstName: chat.first_name ?? null,
      boundAt: this.#now(),
    }, null, 2));
    this.#logger.info(`[telegram] sohbet bağlandı: ${chat.username ?? chat.id} — sinyaller artık Telegram'a akacak`);
  }

  /**
   * Tek yoklama turu (test edilebilirlik için ayrık).
   * Varsayılan KISA yoklama (timeout=0): bazı proxy'ler/kısıtlı ağlar uzun
   * yoklamayı sessizce bozar — kısa yoklama her ortamda çalışır ve token'ı
   * paylaşan başka bir tüketici varsa yarışı daha sık kazanır.
   */
  async pollOnce({ timeoutSec = 0 } = {}) {
    let data;
    try {
      const res = await this.#fetchImpl(
        `https://api.telegram.org/bot${this.#token}/getUpdates?timeout=${timeoutSec}&offset=${this.#offset}`,
        { signal: AbortSignal.timeout((timeoutSec + 10) * 1000) },
      );
      data = await res.json();
    } catch (err) {
      this.telemetry.pollErrors += 1;
      if (this.telemetry.pollErrors % 10 === 1) {
        this.#logger.warn(`[telegram] yoklama hatası (#${this.telemetry.pollErrors}): ${err.message}`);
      }
      throw err;
    }
    if (!data.ok) {
      this.telemetry.pollErrors += 1;
      if (data.error_code === 409) {
        // Aynı token'ı KULLANAN BAŞKA BİR TÜKETİCİ var (webhook veya başka
        // bir getUpdates istemcisi) — mesajları o yutuyor demektir.
        this.#logger.error('[telegram] 409 ÇAKIŞMA: bu token başka bir yerde de dinleniyor! '
          + 'BotFather /revoke ile token yenileyin ve yalnız bota verin.');
      }
      return;
    }
    if (!this.#firstPollOk) {
      this.#firstPollOk = true;
      this.#logger.info('[telegram] getUpdates kanalı doğrulandı (kısa yoklama)');
    }
    if ((data.result ?? []).length > 0) {
      this.#logger.info(`[telegram] ${data.result.length} güncelleme alındı`);
    }
    for (const update of data.result ?? []) {
      this.#offset = Math.max(this.#offset, update.update_id + 1);
      this.telemetry.updates += 1;
      await this.#handleUpdate(update).catch((err) => {
        this.#logger.error(`[telegram] komut hatası: ${err.message}`);
      });
    }
  }

  async #handleUpdate(update) {
    const msg = update.message;
    if (!msg?.chat?.id || typeof msg.text !== 'string') return;
    const command = msg.text.trim().split(/\s+/)[0].toLowerCase().replace(/@[\w_]+$/, '');
    const fromBound = this.#chatId !== null && String(msg.chat.id) === this.#chatId;

    if (this.#chatId === null) {
      // Bağsız: yalnız /start bağlar; başka her şey yok sayılır
      if (command === '/start') {
        this.#bind(msg.chat);
        this.#reply(this.#renderWelcome());
      }
      return;
    }
    if (!fromBound) {
      this.telemetry.foreignIgnored += 1; // yabancı sohbet: sessiz ret
      return;
    }

    this.telemetry.commands += 1;
    switch (command) {
      case '/start':
      case '/yardim':
      case '/help':
        this.#reply(this.#renderWelcome());
        break;
      case '/durum':
        this.#reply(this.#renderStatus());
        break;
      case '/neden':
        this.#reply(this.#renderWhy());
        break;
      case '/bakiye':
        this.#reply(this.#renderBalance());
        break;
      case '/sinyaller':
        this.#reply(this.#renderSignals());
        break;
      case '/rapor':
        this.#reply(this.#renderReport());
        break;
      default:
        this.#reply(`Bilinmeyen komut: ${command}\n${this.#renderWelcome()}`);
    }
  }

  #reply(text) {
    this.#notifier?.sendText(text);
  }

  // --- Komut görünümleri (statusProvider = dashboard snapshot'ı) ---

  #renderWelcome() {
    return [
      '🤖 <b>ICT BOT V5</b> — sinyal botu bağlı.',
      'Onaylı sinyaller, vetolar ve sonuçlar otomatik düşer.',
      '',
      '/durum — killzone, kilit, sembol bias/faz tablosu',
      '/neden — sembol başına "neden sinyal yok" kapı teşhisi',
      '/bakiye — sanal hesap, PnL, drawdown, R',
      '/sinyaller — son 5 sinyal',
      '/rapor — günlük özet',
    ].join('\n');
  }

  /** Sinyal kapı teşhisi: her sembol hangi aşamada takılı? */
  #renderWhy() {
    const s = this.#statusProvider();
    const GATE_TR = {
      YETERSIZ_BAR: '⏳ veri birikiyor',
      BIAS_YOK: '➖ 4H yapı yönsüz (HH/HL veya LH/LL dizisi yok)',
      ANLATI_TEYITSIZ: '🔍 bias var, anlatı fazı (manipülasyon) bekleniyor',
      SEANS_KAPALI: '🌙 seans kapalı',
      SWEEP_YOK: '💧 likidite süpürmesi bekleniyor',
      MSS_YOK: '⚡ sweep oldu, yapı kırılımı (MSS) bekleniyor',
      MSS_ISLENDI: '✔️ son dizilim değerlendirildi, yenisi bekleniyor',
      FVG_YOK: '📐 MSS teyitli, giriş bölgesi (FVG) bekleniyor',
      KILLZONE_DISI_GOZLEM: '👁 dizilim TAM ama killzone dışı (gözlemde)',
      ADAY_URETILDI: '✅ SİNYAL ÜRETİLDİ',
      ADAY_ELENDI: '❌ aday üretildi ama elendi',
    };
    const lines = ['🔬 <b>NEDEN SİNYAL YOK?</b> (kapı teşhisi)'];
    for (const r of s.symbols ?? []) {
      const g = r.mtf?.gate;
      const txt = g ? (GATE_TR[g.stage] ?? g.stage) + (g.detail ? ` — ${g.detail}` : '') : 'henüz tarama yok';
      lines.push(`<b>${r.symbol}</b>: ${txt}`);
    }
    lines.push('', 'Zincir: bias → anlatı → killzone → sweep → MSS → FVG → kurul onayı.');
    return lines.join('\n');
  }

  #renderStatus() {
    const s = this.#statusProvider();
    const st = s.state ?? {};
    const lines = [
      `📡 <b>DURUM</b> — ${s.mode?.toUpperCase() ?? '?'} mod`,
      `killzone: ${st.killzone?.zone ?? '—'}${st.killzone?.active ? ' (aktif)' : ''} | ambargo: ${st.embargo?.active ? 'VAR' : 'yok'} | kilit: ${st.riskLock ?? '—'}`,
      '',
    ];
    for (const r of s.symbols ?? []) {
      const stx = r.mtf?.structurer ?? {};
      const bias = (stx.htfBias ?? '—').replace('_BIAS', '');
      const tick = stx.narrativeConfirmed ? ' ✓TARAMADA' : '';
      const closed = r.marketOpen === false ? ' [seans kapalı]' : '';
      lines.push(`${r.symbol}: ${bias} ${stx.phase ?? '—'}${tick}${closed}`);
    }
    return lines.join('\n');
  }

  #renderBalance() {
    const s = this.#statusProvider();
    const a = s.account ?? {};
    return [
      `💰 <b>BAKİYE</b>: ${a.equity?.toFixed(2) ?? '—'}$ (başlangıç ${a.startingEquity ?? '—'}$)`,
      `Gün PnL: ${a.dailyPnl?.toFixed(2) ?? '0'}$ | Günlük DD: %${a.dailyDDPct?.toFixed(2) ?? '0'} | Toplam DD: %${a.totalDDPct?.toFixed(2) ?? '0'}`,
      `İşlem: ${a.total ?? 0} (${a.wins ?? 0}K/${a.losses ?? 0}Z) | Toplam R: ${a.totalR ?? 0} | Ort R: ${a.avgR ?? '—'}`,
      `Açık: ${a.openCount ?? 0} | Veto kaydı: ${a.rejectedCount ?? 0}`,
    ].join('\n');
  }

  #renderSignals() {
    const s = this.#statusProvider();
    const signals = (s.signals ?? []).slice(0, 5);
    if (signals.length === 0) return '📭 Henüz sinyal yok — kapılar hizalanınca düşecek (/durum ile kontrol et).';
    const lines = ['📋 <b>SON SİNYALLER</b>'];
    for (const sg of signals) {
      const yon = sg.side === 'BUY' ? '🟢' : '🔴';
      let sonuc = sg.status;
      if (sg.outcome) sonuc = `${sg.outcome === 'WIN' ? '🎯' : '🛑'} ${sg.rMultiple ?? ''}R`;
      lines.push(`${yon} ${sg.symbol} ${sg.entry} → ${sonuc}`);
    }
    return lines.join('\n');
  }

  #renderReport() {
    const s = this.#statusProvider();
    const a = s.account ?? {};
    const f = s.feed ?? {};
    const v = f.verdicts ?? {};
    return [
      '📊 <b>RAPOR</b>',
      `Bakiye: ${a.equity?.toFixed(2) ?? '—'}$ | Gün: ${a.dailyPnl >= 0 ? '+' : ''}${a.dailyPnl?.toFixed(2) ?? '0'}$`,
      `İşlem: ${a.total ?? 0} (${a.wins ?? 0}K/${a.losses ?? 0}Z) | Toplam R: ${a.totalR ?? 0}`,
      `Sinyal: ${s.signals?.length ?? 0} | Veto isabeti: ${s.vetoAccuracy?.accuracy != null ? (s.vetoAccuracy.accuracy * 100).toFixed(0) + '%' : 'veri yok'}`,
      `Veri: temiz=${v.CLEAN ?? 0} sweep=${v.REAL_SWEEP ?? 0} karantina=${v.QUARANTINED ?? 0}`,
      `Dikkat modeli: ${s.attention?.promoted ? 'TERFİ EDİLMİŞ' : 'önsel — veri birikiyor'}`,
    ].join('\n');
  }

  start() {
    if (!this.enabled || this.#running) return;
    this.#running = true;
    const loop = async () => {
      while (this.#running) {
        try {
          await this.pollOnce();
          await new Promise((r) => setTimeout(r, this.#pollIntervalMs));
        } catch {
          await new Promise((r) => setTimeout(r, 5000)); // ağ hatası: kısa bekle
        }
      }
    };
    loop();
    this.#logger.info(`[telegram] komut dinleyici aktif${this.#chatId ? '' : ' — bağlanmak için bota /start yazın'}`);
  }

  stop() {
    this.#running = false;
  }
}

export default TelegramCommander;
