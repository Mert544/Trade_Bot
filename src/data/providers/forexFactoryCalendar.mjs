/**
 * ForexFactory ekonomik takvim adaptörü (Oracle calendarProvider sözleşmesi).
 *
 * Halka açık haftalık JSON beslemesini çeker, etki sınıflarını sistem
 * etiketlerine eşler (High → HIGH, Medium → MEDIUM; Low/Holiday elenir)
 * ve yalnızca içinde bulunulan NY gününün olaylarını döner — Oracle'ın
 * günlük senkron sözleşmesi budur (Ek B.2).
 *
 * Hata durumunda FIRLATIR: Oracle fail-closed davranır (bilinmeyen gün =
 * yüksek etkili gün varsayımıyla geniş ambargo). Burada hata yutmak,
 * anayasanın fail-closed garantisini bozar.
 */

import { fetchJson } from './marketDataProvider.mjs';
import { trueDayOpen } from '../../time/nyClock.mjs';
import { CONFIG } from '../../config/defaults.mjs';

const IMPACT_MAP = { High: 'HIGH', Medium: 'MEDIUM' };
const DAY_MS = 24 * 60 * 60 * 1000;

export class ForexFactoryCalendar {
  #url;
  #countries;
  #fetchImpl;
  #timeoutMs;
  #now;

  constructor({
    url = CONFIG.calendar.url,
    countries = CONFIG.calendar.countries,
    fetchImpl = fetch,
    timeoutMs = 10_000,
    now = () => Date.now(),
  } = {}) {
    this.#url = url;
    this.#countries = new Set(countries);
    this.#fetchImpl = fetchImpl;
    this.#timeoutMs = timeoutMs;
    this.#now = now;
  }

  /** @returns {Promise<Array<{ eventName, impact, scheduledAt }>>} */
  async fetchToday() {
    const raw = await fetchJson(this.#url, { fetchImpl: this.#fetchImpl, timeoutMs: this.#timeoutMs });
    if (!Array.isArray(raw)) throw new Error('takvim beslemesi dizi değil');

    const dayStart = trueDayOpen(new Date(this.#now()));
    const dayEnd = dayStart + DAY_MS;

    return raw
      .map((e) => ({
        eventName: `${e.country} ${e.title}`.trim(),
        impact: IMPACT_MAP[e.impact] ?? null,
        scheduledAt: Date.parse(e.date),
        country: e.country,
      }))
      .filter((e) => e.impact !== null
        && Number.isFinite(e.scheduledAt)
        && this.#countries.has(e.country)
        && e.scheduledAt >= dayStart && e.scheduledAt < dayEnd)
      .map(({ eventName, impact, scheduledAt }) => ({ eventName, impact, scheduledAt }));
  }
}

export default ForexFactoryCalendar;
