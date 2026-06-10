/**
 * Setup İstatistik Motoru — aile × rejim × killzone kırılımı (E3, E6).
 *
 * Overfit disiplini görselleştirilir: her hücre kademeli örnek eşiğine göre
 * etiketlenir (<30 yetersiz, <100 ön gösterge, <300 doğrulama, ≥300 güvenilir).
 * Eşiği geçmeyen hücre üzerinden HİÇBİR iddia/karar kurulamaz — dashboard'da
 * gri/sarı gösterim bu disiplinin günlük hatırlatıcısıdır.
 *
 * Killzone hipotezi: killzone içi sinyaller ile killzone dışı "gözlem"
 * adayları (killzone='DIŞI') aynı tabloda yan yana ölçülür — doğal A/B.
 *
 * Veri kaynakları: canlıda SignalHub sink'i; restart'ta journal replay.
 * Gerçek sonuç (CLOSED) ile hipotetik sonuç (veto/gözlem akıbeti) ayrı sayılır.
 */

import { CONFIG } from '../config/defaults.mjs';

export class SetupStats {
  #cells = new Map(); // 'family|regime|killzone' -> sayaçlar
  #tiers;

  constructor({ tiers = CONFIG.metacognition.sampleTiers } = {}) {
    this.#tiers = tiers;
  }

  #cell(family, regime, killzone) {
    const key = `${family}|${regime}|${killzone}`;
    if (!this.#cells.has(key)) {
      this.#cells.set(key, {
        family, regime, killzone,
        wins: 0, losses: 0,           // gerçek (gölge defter) sonuçlar
        hypoWins: 0, hypoLosses: 0,   // hipotetik (veto/gözlem) akıbetler
        vetoed: 0, observed: 0, expired: 0, invalidated: 0,
      });
    }
    return this.#cells.get(key);
  }

  #keyOf(signal) {
    const q = signal.quality ?? {};
    return [signal.setupFamily ?? 'UNKNOWN', q.regime ?? 'UNKNOWN', q.killzone ?? 'NONE'];
  }

  /** SignalHub sink arayüzü (canlı akış). */
  onSignalEvent(eventType, signal) {
    const cell = this.#cell(...this.#keyOf(signal));
    switch (eventType) {
      case 'CLOSED':
        if (signal.outcome === 'WIN') cell.wins += 1;
        else if (signal.outcome === 'LOSS') cell.losses += 1;
        break;
      case 'VETOED': cell.vetoed += 1; break;
      case 'EXPIRED': cell.expired += 1; break;
      case 'INVALIDATED': cell.invalidated += 1; break;
      case 'HYPOTHETICAL':
        if (signal.hypotheticalOutcome === 'WOULD_HAVE_WON') cell.hypoWins += 1;
        else if (signal.hypotheticalOutcome === 'WOULD_HAVE_LOST') cell.hypoLosses += 1;
        break;
      default: break; // NEW/APPROVED/VOTE sayım dışı
    }
  }

  /** Killzone-dışı gözlem adayı (Structurer onObservation kancasından). */
  recordObservation(obs) {
    const q = obs.quality ?? {};
    const cell = this.#cell(obs.setupFamily ?? 'UNKNOWN', q.regime ?? 'UNKNOWN', 'DIŞI');
    cell.observed += 1;
  }

  /** Gözlem adayının hipotetik akıbeti. */
  recordObservationOutcome(obs, outcome) {
    const q = obs.quality ?? {};
    const cell = this.#cell(obs.setupFamily ?? 'UNKNOWN', q.regime ?? 'UNKNOWN', 'DIŞI');
    if (outcome === 'WOULD_HAVE_WON') cell.hypoWins += 1;
    else if (outcome === 'WOULD_HAVE_LOST') cell.hypoLosses += 1;
  }

  /** Journal replay yolu (restart dayanıklılığı). */
  ingestJournalRecord(record) {
    if (record.kind === 'signal') this.onSignalEvent(record.event, record.signal);
    else if (record.kind === 'observation') this.recordObservation(record.observation);
    else if (record.kind === 'observationOutcome') this.recordObservationOutcome(record.observation, record.outcome);
  }

  tierOf(samples) {
    const t = this.#tiers;
    if (samples < t.floor) return { tier: 'veri yetersiz', tierClass: 'yetersiz' };
    if (samples < t.validation) return { tier: 'ön gösterge', tierClass: 'on' };
    if (samples < t.promotion) return { tier: 'doğrulama', tierClass: 'dogrulama' };
    return { tier: 'güvenilir', tierClass: 'guvenilir' };
  }

  /** Dashboard tablosu: hücre başına özet satır. */
  breakdown() {
    return [...this.#cells.values()]
      .map((c) => {
        const real = c.wins + c.losses;
        const hypo = c.hypoWins + c.hypoLosses;
        const samples = real + hypo;
        const winRate = samples > 0 ? (c.wins + c.hypoWins) / samples : null;
        return {
          family: c.family,
          regime: c.regime,
          killzone: c.killzone,
          samples,
          realSamples: real,
          hypoSamples: hypo,
          winRate,
          vetoed: c.vetoed,
          observed: c.observed,
          ...this.tierOf(samples),
        };
      })
      .sort((a, b) => b.samples - a.samples);
  }
}

export default SetupStats;
