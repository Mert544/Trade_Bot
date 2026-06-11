/**
 * Piyasa Saatleri — varlık sınıfı seans takvimi (F1).
 *
 * Kripto 7/24; FX/metal/endeks CFD haftalık döngüsü: Pazar 17:00 NY açılış,
 * Cuma 17:00 NY kapanış (DST farkındalıklı — nyClock üzerinden).
 *
 * Kritik tüketiciler:
 *   - Staleness bekçisi: kapalı piyasada FEED_STALE üretilmez (aksi halde
 *     tüm hafta sonu sahte SOFT_LOCK — SOL sessizliği hatasının büyüğü)
 *   - MTF motoru: kapalı piyasada tetik taraması durur
 *   - TD bar beslemesi: kapalı piyasada yoklama durur (kredi tasarrufu)
 */

import { nyParts } from './nyClock.mjs';
import { SESSION, instrumentSpec } from '../config/instruments.mjs';

const weekdayFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'short',
});
const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** NY duvar saati haftanın günü (0=Pazar … 6=Cumartesi), DST farkındalıklı. */
export function nyWeekday(date = new Date()) {
  return WEEKDAY[weekdayFormatter.format(date)] ?? 0;
}

/** FX haftalık penceresi: Paz 17:00 NY → Cum 17:00 NY. */
export function isFxOpen(date = new Date()) {
  const day = nyWeekday(date);
  const { hour } = nyParts(date);
  if (day === 6) return false;                 // Cumartesi tamamen kapalı
  if (day === 0) return hour >= 17;            // Pazar 17:00 NY'den itibaren açık
  if (day === 5) return hour < 17;             // Cuma 17:00 NY'de kapanır
  return true;                                  // Pzt-Per açık
}

export function isSessionOpen(session, date = new Date()) {
  if (session === SESSION.ALWAYS) return true;
  if (session === SESSION.FX) return isFxOpen(date);
  return true; // bilinmeyen seans tipi: muhafazakâr taraf AÇIK varsaymak değil —
               // ama kapalı varsaymak sinyal akışını sessizce öldürür; bilinen
               // tipler dışına sembol eklemek tabloda seans tanımı gerektirir.
}

/** Sembol bazlı kısayol (instruments tablosundan). */
export function isMarketOpen(symbol, date = new Date()) {
  const spec = instrumentSpec(symbol);
  return spec ? isSessionOpen(spec.session, date) : true;
}

export default isMarketOpen;
