/**
 * PO3 (Power of Three) — günlük teslim döngüsü durum makinesi.
 *
 * ICT'nin günlük şablonu, True Day Open (00:00 NY) etrafında üç fazdır:
 *   ACCUMULATION  — TDO sonrası dar aralık (Asya); emirler birikir
 *   MANIPULATION  — aralığın bir ucunun süpürülmesi (Judas swing):
 *                   gerçek yönün TERSİNE sahte hareket
 *   DISTRIBUTION  — gerçek yönde genişleme; gün bu yönde teslim edilir
 *
 * Çıktı: faz + manipülasyon yönünden türetilen günlük yön beklentisi.
 * Manipülasyon AŞAĞI süpürdüyse beklenen teslim YUKARI'dır (ve tersi).
 * MTF motoru bunu kalite bileşeni + 4H bias teyidi olarak tüketir:
 * PO3 beklentisi ile 4H bias aynı yöndeyse sinyal güçlenir.
 *
 * Faz geçişleri yalnız kapanmış 3m barlarla işlenir (look-ahead yok).
 */

import { trueDayOpen } from '../time/nyClock.mjs';

export const PO3_PHASE = Object.freeze({
  ACCUMULATION: 'ACCUMULATION',
  MANIPULATION: 'MANIPULATION',
  DISTRIBUTION: 'DISTRIBUTION',
  UNKNOWN: 'UNKNOWN',
});

export class PO3Tracker {
  #config;
  #days = new Map(); // symbol -> günlük durum

  constructor({
    accumulationWindowMs = 4 * 60 * 60 * 1000, // TDO sonrası ilk 4 saat aralığı kurar
    manipulationMinPct = 0.05,  // aralık ucunu en az bu kadar aşmalı (% fiyat)
    displacementPct = 0.15,     // ters yönde bu kadar yol = distribution teyidi
  } = {}) {
    this.#config = { accumulationWindowMs, manipulationMinPct, displacementPct };
  }

  #day(symbol, dayOpen) {
    const existing = this.#days.get(symbol);
    if (!existing || existing.dayOpen !== dayOpen) {
      this.#days.set(symbol, {
        dayOpen,
        phase: PO3_PHASE.ACCUMULATION,
        rangeHigh: null,
        rangeLow: null,
        rangeFinal: false,
        manipulation: null, // { direction: 'DOWN'|'UP', extreme, at }
        expectedDelivery: null, // 'UP' | 'DOWN'
        distributionConfirmed: false,
      });
    }
    return this.#days.get(symbol);
  }

  /**
   * Kapanmış 3m bar işler; sembolün güncel PO3 bağlamını döner.
   * @returns {{ phase, expectedDelivery, range, manipulation }}
   */
  onBar(symbol, bar) {
    const dayOpen = trueDayOpen(new Date(bar.openTime));
    const day = this.#day(symbol, dayOpen);
    const sinceOpen = bar.openTime - dayOpen;

    // 1) Birikim penceresi: aralığı kur
    if (sinceOpen < this.#config.accumulationWindowMs) {
      day.rangeHigh = day.rangeHigh === null ? bar.high : Math.max(day.rangeHigh, bar.high);
      day.rangeLow = day.rangeLow === null ? bar.low : Math.min(day.rangeLow, bar.low);
      return this.context(symbol, bar.openTime);
    }
    if (day.rangeHigh === null || day.rangeLow === null) {
      // Gün ortası başlatıldı (ısınma/restart): aralık kurulamadı, gün UNKNOWN
      day.phase = PO3_PHASE.UNKNOWN;
      return this.context(symbol, bar.openTime);
    }
    day.rangeFinal = true;

    // 2) Manipülasyon: aralık ucunun anlamlı süpürülmesi
    if (day.phase === PO3_PHASE.ACCUMULATION) {
      const minMove = bar.close * (this.#config.manipulationMinPct / 100);
      if (bar.low < day.rangeLow - minMove) {
        day.manipulation = { direction: 'DOWN', extreme: bar.low, at: bar.openTime };
        day.expectedDelivery = 'UP'; // Judas aşağı → gerçek teslim yukarı
        day.phase = PO3_PHASE.MANIPULATION;
      } else if (bar.high > day.rangeHigh + minMove) {
        day.manipulation = { direction: 'UP', extreme: bar.high, at: bar.openTime };
        day.expectedDelivery = 'DOWN';
        day.phase = PO3_PHASE.MANIPULATION;
      }
      return this.context(symbol, bar.openTime);
    }

    // 3) Dağıtım: beklenen yönde displacement teyidi.
    // ÖNCE çift taraflı SÜPÜRME denetlenir. Ayrım kapanışta: diğer uç
    // delinip kapanış aralık İÇİNE dönerse süpürmedir (güvenilmez gün);
    // kapanış dışarıda kalırsa bu süpürme değil teslimin kendisidir —
    // beklenen yönde genişleme zaten aralık ucunu aşar.
    if (day.phase === PO3_PHASE.MANIPULATION) {
      const minMove = bar.close * (this.#config.manipulationMinPct / 100);
      const otherSideSwept = day.manipulation.direction === 'DOWN'
        ? bar.high > day.rangeHigh + minMove && bar.close <= day.rangeHigh
        : bar.low < day.rangeLow - minMove && bar.close >= day.rangeLow;
      if (otherSideSwept) {
        day.phase = PO3_PHASE.UNKNOWN;
        day.expectedDelivery = null;
        return this.context(symbol, bar.openTime);
      }
      const move = day.expectedDelivery === 'UP'
        ? (bar.close - day.manipulation.extreme) / day.manipulation.extreme
        : (day.manipulation.extreme - bar.close) / day.manipulation.extreme;
      if (move * 100 >= this.#config.displacementPct) {
        day.phase = PO3_PHASE.DISTRIBUTION;
        day.distributionConfirmed = true;
      }
    }
    return this.context(symbol, bar.openTime);
  }

  /** Sembolün güncel PO3 bağlamı (kalite bileşeni olarak tüketilir). */
  context(symbol, at = Date.now()) {
    const day = this.#days.get(symbol);
    if (!day || day.dayOpen !== trueDayOpen(new Date(at))) {
      return { phase: PO3_PHASE.UNKNOWN, expectedDelivery: null, range: null, manipulation: null };
    }
    return {
      phase: day.phase,
      expectedDelivery: day.expectedDelivery,
      range: day.rangeFinal ? { high: day.rangeHigh, low: day.rangeLow } : null,
      manipulation: day.manipulation,
    };
  }
}

export default PO3Tracker;
