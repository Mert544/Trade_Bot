/**
 * İcra arabirimi soyutlaması (Bölüm 5.4).
 *
 * cTrader Open API ve MetaApi bağlantılarını soyutlayan TEK arayüz;
 * platform değişikliği Sniper'ın mantığını etkilemez.
 *
 * Anayasal kural (6.3): her pozisyon, SUNUCU TARAFI stop-loss olmadan
 * asla açılmaz — submitOrder stopLoss alanı zorunludur.
 */

export class BrokerInterface {
  /** @returns {Promise<{ spread: number, bid: number, ask: number }>} */
  async getQuote(_symbol) { throw new Error('getQuote uygulanmadı'); }

  /**
   * @param {{ symbol, side, volume, type, price, stopLoss, takeProfit }} order
   * @returns {Promise<{ brokerOrderId, fillPrice, filledAt }>}
   */
  async submitOrder(order) {
    if (order.stopLoss === undefined || order.stopLoss === null) {
      throw new Error('ANAYASA İHLALİ: sunucu tarafı stop-loss olmadan pozisyon açılamaz (Bölüm 6.3)');
    }
    return this._submit(order);
  }

  async _submit(_order) { throw new Error('_submit uygulanmadı'); }

  async cancelOrder(_brokerOrderId) { throw new Error('cancelOrder uygulanmadı'); }

  async closePosition(_brokerOrderId) { throw new Error('closePosition uygulanmadı'); }

  /** Recovery-from-scratch mutabakatı için (Bölüm 9). */
  async fetchOpenPositions() { throw new Error('fetchOpenPositions uygulanmadı'); }
}

/**
 * PaperBroker — gölge mod / test icra arka ucu.
 * Maliyetsiz simülasyon YASAKTIR (7.1): spread, komisyon ve modellenmiş
 * slippage her fill'e dahil edilir.
 */
export class PaperBroker extends BrokerInterface {
  #quotes = new Map(); // symbol -> { bid, ask }
  #positions = new Map();
  #orderSeq = 0;
  #costModel;

  constructor({ costModel = { commissionPerLot: 3.0, slippageModel: () => 0.0001 } } = {}) {
    super();
    this.#costModel = costModel;
  }

  setQuote(symbol, { bid, ask }) {
    this.#quotes.set(symbol, { bid, ask });
  }

  async getQuote(symbol) {
    const q = this.#quotes.get(symbol);
    if (!q) throw new Error(`kotasyon yok: ${symbol}`);
    return { ...q, spread: q.ask - q.bid };
  }

  async _submit(order) {
    const q = await this.getQuote(order.symbol);
    const slippage = this.#costModel.slippageModel(order);
    const base = order.side === 'BUY' ? q.ask : q.bid;
    const fillPrice = order.side === 'BUY' ? base + slippage : base - slippage;
    const brokerOrderId = `paper-${++this.#orderSeq}`;
    this.#positions.set(brokerOrderId, {
      brokerOrderId,
      symbol: order.symbol,
      side: order.side,
      volume: order.volume,
      entryPrice: fillPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit ?? null,
      commission: this.#costModel.commissionPerLot * order.volume,
      openedAt: Date.now(),
    });
    return { brokerOrderId, fillPrice, filledAt: Date.now() };
  }

  async cancelOrder(brokerOrderId) {
    this.#positions.delete(brokerOrderId);
  }

  async closePosition(brokerOrderId) {
    const pos = this.#positions.get(brokerOrderId);
    if (!pos) throw new Error(`pozisyon yok: ${brokerOrderId}`);
    const q = await this.getQuote(pos.symbol);
    const exitPrice = pos.side === 'BUY' ? q.bid : q.ask;
    this.#positions.delete(brokerOrderId);
    const direction = pos.side === 'BUY' ? 1 : -1;
    const grossPnl = (exitPrice - pos.entryPrice) * direction * pos.volume;
    return { exitPrice, grossPnl, netPnl: grossPnl - pos.commission, closedAt: Date.now() };
  }

  async fetchOpenPositions() {
    return [...this.#positions.values()];
  }
}

export default BrokerInterface;
