/**
 * Bölüm 4.3 — Zaman Senkronizasyonu.
 *
 * Killzone ve True Day Open hesaplamaları New York saatine
 * (America/New_York, DST farkındalıklı) sabitlenir. ICT metodolojisinde
 * yanlış saat, yanlış stratejiyle eşdeğerdir — tüm zaman matematiği
 * Intl üzerinden gerçek IANA dilimiyle yapılır, sabit ofset YASAKTIR.
 */

const NY_TZ = 'America/New_York';

const partsFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

/** Verilen UTC anının New York duvar saati bileşenlerini döner. */
export function nyParts(date = new Date()) {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24, // Intl bazı ortamlarda 24 dönebilir
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** NY duvar saatini dakika cinsinden döner (gün içi konum). */
export function nyMinutesOfDay(date = new Date()) {
  const { hour, minute } = nyParts(date);
  return hour * 60 + minute;
}

/**
 * True Day Open (00:00 NY) — verilen anın ait olduğu NY gününün
 * başlangıcını UTC epoch ms olarak döner. DST geçişlerinde de doğrudur:
 * NY duvar saati geriye sarılarak 00:00'a denk gelen UTC anı bulunur.
 */
export function trueDayOpen(date = new Date()) {
  const { hour, minute, second } = nyParts(date);
  const elapsedMs = ((hour * 60 + minute) * 60 + second) * 1000 + date.getMilliseconds();
  return date.getTime() - elapsedMs;
}

/**
 * Killzone tanımları (NY saatiyle, dakika cinsinden [başlangıç, bitiş)).
 * Asya: 20:00–00:00 (önceki gün akşamı), Londra: 02:00–05:00,
 * NY AM: 08:30–11:00, NY PM: 13:30–16:00.
 */
export const KILLZONES = Object.freeze({
  ASIA: { startMin: 20 * 60, endMin: 24 * 60 },
  LONDON: { startMin: 2 * 60, endMin: 5 * 60 },
  NY_AM: { startMin: 8 * 60 + 30, endMin: 11 * 60 },
  NY_PM: { startMin: 13 * 60 + 30, endMin: 16 * 60 },
});

/** Verilen anda aktif killzone'u döner; yoksa null. */
export function activeKillzone(date = new Date()) {
  const mins = nyMinutesOfDay(date);
  for (const [zone, { startMin, endMin }] of Object.entries(KILLZONES)) {
    if (mins >= startMin && mins < endMin) return zone;
  }
  return null;
}

/** Tüm killzone'ların aktiflik durumunu döner. */
export function killzoneStates(date = new Date()) {
  const mins = nyMinutesOfDay(date);
  const tdo = trueDayOpen(date);
  return Object.entries(KILLZONES).map(([zone, { startMin, endMin }]) => ({
    zone,
    active: mins >= startMin && mins < endMin,
    trueDayOpen: tdo,
  }));
}

export { NY_TZ };
