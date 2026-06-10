/**
 * Faz 1 — The Oracle v1 (Bölüm 5.1, Ek B.2).
 *
 * Sistemin takvim bilinci ve zaman kapısı. İşlem yetkisi YOKTUR;
 * yalnızca zaman ve takvim olayları yayınlar. Üç alt modül:
 *   1. Takvim İzleyici  — ekonomik takvim kaynağından olay çekimi, etki sınıflandırma
 *   2. Ambargo Yöneticisi — T-/T+ pencereleri, EMBARGO_ON/OFF yayını
 *   3. Killzone Saat Makinesi — NY saatine sabit, DST farkındalıklı durum yayını
 *
 * Fail-closed (Ek B.2): takvim kaynağı erişilemezse bilinmeyen gün =
 * yüksek etkili gün varsayılır ve geniş ambargo yayınlanır.
 * Tüm yayınlar Faz 0 doğrulayıcısından geçer; Oracle özel yol KULLANMAZ.
 */

import { CONFIG } from '../config/defaults.mjs';
import { activeKillzone, trueDayOpen, KILLZONES } from '../time/nyClock.mjs';

const AGENT_ID = 'oracle';
const AGENT_VERSION = '1.0.0';

export class Oracle {
  #bus;
  #calendarProvider;
  #now;
  #logger;
  #config;

  #calendarEvents = [];      // { eventName, impact: HIGH|MEDIUM|LOW, scheduledAt }
  #calendarHealthy = false;
  #activeEmbargoes = new Map(); // eventName -> { windowStart, windowEnd, impact }
  #lastKillzone = undefined; // undefined = henüz yayın yok (null'dan farklı)
  #timer = null;

  /**
   * @param {object} deps
   * @param {import('../core/protocolBus.mjs').ProtocolBus} deps.bus
   * @param {{ fetchToday: () => Promise<Array> }} deps.calendarProvider
   */
  constructor({ bus, calendarProvider, now = () => Date.now(), logger = console, config = CONFIG } = {}) {
    this.#bus = bus;
    this.#calendarProvider = calendarProvider;
    this.#now = now;
    this.#logger = logger;
    this.#config = config;
  }

  /** Günlük takvim senkronu. Hata = fail-closed geniş ambargo. */
  async syncCalendar() {
    try {
      const events = await this.#calendarProvider.fetchToday();
      this.#calendarEvents = events
        .filter((e) => e.impact === 'HIGH' || e.impact === 'MEDIUM')
        .map((e) => ({ ...e, scheduledAt: typeof e.scheduledAt === 'number' ? e.scheduledAt : Date.parse(e.scheduledAt) }));
      this.#calendarHealthy = true;
      this.#logger.info(`[oracle] takvim senkronu: ${this.#calendarEvents.length} etkili olay`);
    } catch (err) {
      this.#calendarHealthy = false;
      this.#logger.error(`[oracle] takvim kaynağı erişilemez, FAIL-CLOSED: ${err.message}`);
      if (this.#config.embargo.failClosed) {
        await this.#publishFailClosedEmbargo();
      }
    }
  }

  /** Periyodik tick — killzone geçişlerini ve ambargo pencerelerini değerlendirir. */
  async tick() {
    await this.#evaluateKillzone();
    await this.#evaluateEmbargoes();
  }

  start({ tickIntervalMs = 1000 } = {}) {
    this.#timer = setInterval(() => {
      this.tick().catch((err) => this.#logger.error(`[oracle] tick hatası: ${err.message}`));
    }, tickIntervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // --- Killzone Saat Makinesi ---

  async #evaluateKillzone() {
    const nowDate = new Date(this.#now());
    const zone = activeKillzone(nowDate);
    if (zone === this.#lastKillzone) return; // sıfır mükerrer yayın garantisi
    this.#lastKillzone = zone;
    await this.#publish('KILLZONE_STATE', {
      zone: zone ?? 'NONE',
      active: zone !== null,
      trueDayOpen: trueDayOpen(nowDate),
    }, {
      evidence: zone
        ? [`NY saatiyle ${zone} killzone aktif (${this.#fmtZone(zone)})`]
        : ['Aktif killzone yok; adaylar gözlem statüsünde kalır'],
    });
  }

  #fmtZone(zone) {
    const { startMin, endMin } = KILLZONES[zone];
    const fmt = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    return `${fmt(startMin)}–${fmt(endMin)} NY`;
  }

  // --- Ambargo Yöneticisi (Killswitch K1) ---

  async #evaluateEmbargoes() {
    const now = this.#now();
    for (const event of this.#calendarEvents) {
      const window = this.#config.embargo[event.impact];
      if (!window) continue;
      const windowStart = event.scheduledAt - window.beforeMin * 60_000;
      const windowEnd = event.scheduledAt + window.afterMin * 60_000;
      const inWindow = now >= windowStart && now <= windowEnd;
      const active = this.#activeEmbargoes.has(event.eventName);

      if (inWindow && !active) {
        this.#activeEmbargoes.set(event.eventName, { windowStart, windowEnd, impact: event.impact });
        await this.#publish('EMBARGO_ON', {
          eventName: event.eventName, impact: event.impact, windowStart, windowEnd,
        }, {
          evidence: [`${event.eventName} (${event.impact}) T-${window.beforeMin}dk penceresi açıldı`],
        });
      } else if (!inWindow && active) {
        this.#activeEmbargoes.delete(event.eventName);
        await this.#publish('EMBARGO_OFF', {
          eventName: event.eventName, impact: event.impact, windowStart, windowEnd,
        }, {
          evidence: [`${event.eventName} T+${window.afterMin}dk penceresi kapandı`],
        });
      }
    }
  }

  async #publishFailClosedEmbargo() {
    const now = this.#now();
    const { beforeMin, afterMin } = this.#config.embargo.failClosedWindow;
    const windowStart = now;
    const windowEnd = now + (beforeMin + afterMin) * 60_000;
    this.#activeEmbargoes.set('CALENDAR_UNAVAILABLE', { windowStart, windowEnd, impact: 'HIGH' });
    await this.#publish('EMBARGO_ON', {
      eventName: 'CALENDAR_UNAVAILABLE', impact: 'HIGH', windowStart, windowEnd,
    }, {
      evidence: ['Takvim kaynağı erişilemez; bilinmeyen gün = yüksek etkili gün varsayımı (fail-closed)'],
    });
  }

  // --- News Sweep Etiketleyici (v1: dışarıdan beslenen teyit) ---

  /**
   * Haber sonrası manipülatif hareket (süpürme + geri dönüş) teyit edildiğinde
   * çağrılır; haber riski etiketlenmiş fırsata dönüşür.
   */
  async tagNewsSweep({ symbol, direction, sweptLevel, confirmedAt, correlationId = null }) {
    await this.#publish('NEWS_SWEEP_TAG', { symbol, direction, sweptLevel, confirmedAt }, {
      correlationId,
      confidence: 0.8,
      evidence: [`${symbol} haber süpürmesi: ${direction} yönlü, seviye ${sweptLevel}, yapı yeniden teyitli`],
    });
  }

  isEmbargoActive() {
    return this.#activeEmbargoes.size > 0;
  }

  async #publish(type, payload, { evidence = [], confidence = 1.0, correlationId = null } = {}) {
    return this.#bus.publish({
      type,
      source: AGENT_ID,
      version: AGENT_VERSION,
      payload,
      evidence,
      confidence,
      correlationId,
      ttlMs: 5 * 60_000,
      timestamp: this.#now(),
    });
  }
}

export default Oracle;
