/**
 * Tick → bar agregasyonu (3m varsayılan).
 *
 * Sanitasyondan geçen temiz tick'lerden OHLC barları üretir; bar kapanışı
 * algı katmanını (rejim dedektörü) besler. Bar sınırları epoch'a hizalıdır
 * (3m: :00/:03/:06...), böylece yeniden başlatmada sınırlar kaymaz.
 */

export class BarAggregator {
  #intervalMs;
  #current = new Map(); // symbol -> { slot, open, high, low, close, openTime, ticks }

  constructor({ intervalMs = 3 * 60 * 1000 } = {}) {
    this.#intervalMs = intervalMs;
  }

  /**
   * @returns {object|null} Yeni tick önceki barı kapattıysa kapanan bar, yoksa null.
   */
  push(symbol, price, timestamp) {
    const slot = Math.floor(timestamp / this.#intervalMs);
    const current = this.#current.get(symbol);

    if (!current) {
      this.#current.set(symbol, this.#newBar(slot, price));
      return null;
    }
    if (current.slot === slot) {
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
      current.ticks += 1;
      return null;
    }

    // Yeni slot: önceki bar kapandı
    const closed = {
      symbol,
      open: current.open,
      high: current.high,
      low: current.low,
      close: current.close,
      openTime: current.slot * this.#intervalMs,
      closeTime: (current.slot + 1) * this.#intervalMs,
      ticks: current.ticks,
    };
    this.#current.set(symbol, this.#newBar(slot, price));
    return closed;
  }

  #newBar(slot, price) {
    return { slot, open: price, high: price, low: price, close: price, ticks: 1 };
  }

  /** Oluşmakta olan barın anlık görüntüsü (telemetri için). */
  inProgress(symbol) {
    const c = this.#current.get(symbol);
    if (!c) return null;
    return { open: c.open, high: c.high, low: c.low, close: c.close, ticks: c.ticks };
  }
}

export default BarAggregator;
