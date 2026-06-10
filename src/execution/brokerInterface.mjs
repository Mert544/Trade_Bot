/**
 * İcra arabirimi soyutlaması (Bölüm 5.4).
 *
 * cTrader Open API ve MetaApi bağlantılarını soyutlayan TEK arayüz;
 * platform değişikliği Sniper'ın mantığını etkilemez.
 *
 * Anayasal kural (6.3): her pozisyon, SUNUCU TARAFI stop-loss olmadan
 * asla açılmaz — submitOrder stopLoss alanı zorunludur.
 */

import { CONFIG } from '../config/defaults.mjs';

export class BrokerInterface {
  /** @returns {Promise<{ spread: number, bid: number, ask: number }>} */
  async getQuote(_symbol) { throw new Error('getQuote uygulanmadı'); }

  /**
   * @param {{ symbol, side, volume, type, price, stopLoss, takeProfit }} order
   * @returns {Promise<{ brokerOrderId, pending: boolean, fillPrice?, filledAt?, commission? }>}
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
 * PaperBroker — gölge mod icra arka ucu.
 *
 * GERÇEKÇİLİK KURALLARI (bakiye turu):
 *   1. Limit emir ANINDA DOLMAZ: fiyat limite değene kadar bekler
 *      (eski davranış hayalet işlemler üretiyordu — sinyal FVG geri test
 *      fiyatına konur, fiyat oraya hiç dönmeyebilir).
 *   2. Ücretler yüzdeseldir (kripto gerçeği): pazarlanabilir dolum = taker,
 *      bekleyen limit dolumu = maker. Sabit $/lot komisyon FX kafasıydı.
 *   3. Slippage fiyat oranlıdır ve limit fiyatını ASLA aşamaz
 *      (limit emrin tanımı: bu fiyattan kötüsü kabul edilmez).
 */
export class PaperBroker extends BrokerInterface {
  #quotes = new Map();       // symbol -> { bid, ask }
  #positions = new Map();    // brokerOrderId -> pozisyon
  #pendingOrders = new Map();// brokerOrderId -> bekleyen limit emri
  #orderSeq = 0;
  #fees;
  #now;

  constructor({
    feeTakerPct = CONFIG.account.feeTakerPct,
    feeMakerPct = CONFIG.account.feeMakerPct,
    slippagePct = CONFIG.account.slippagePct,
    now = () => Date.now(),
  } = {}) {
    super();
    this.#fees = { feeTakerPct, feeMakerPct, slippagePct };
    this.#now = now;
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
    const brokerOrderId = `paper-${++this.#orderSeq}`;

    if (order.type === 'LIMIT') {
      const marketable = order.side === 'BUY' ? q.ask <= order.price : q.bid >= order.price;
      if (!marketable) {
        this.#pendingOrders.set(brokerOrderId, { ...order, brokerOrderId, placedAt: this.#now() });
        return { brokerOrderId, pending: true };
      }
    }
    return this.#fill({ ...order, brokerOrderId }, q, { maker: false });
  }

  #fill(order, q, { maker }) {
    let fillPrice;
    if (maker) {
      // Bekleyen limit dolumu: tam limit fiyatından (maker)
      fillPrice = order.price;
    } else {
      const base = order.side === 'BUY' ? q.ask : q.bid;
      const slip = base * (this.#fees.slippagePct / 100);
      const raw = order.side === 'BUY' ? base + slip : base - slip;
      // Limit fiyatı slippage ile bile aşılamaz
      fillPrice = order.type === 'LIMIT'
        ? (order.side === 'BUY' ? Math.min(raw, order.price) : Math.max(raw, order.price))
        : raw;
    }
    const feePct = maker ? this.#fees.feeMakerPct : this.#fees.feeTakerPct;
    const commission = fillPrice * order.volume * (feePct / 100);
    this.#positions.set(order.brokerOrderId, {
      brokerOrderId: order.brokerOrderId,
      symbol: order.symbol,
      side: order.side,
      volume: order.volume,
      entryPrice: fillPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit ?? null,
      commission,
      maker,
      openedAt: this.#now(),
    });
    return { brokerOrderId: order.brokerOrderId, pending: false, fillPrice, commission, maker, filledAt: this.#now() };
  }

  /**
   * Fiyat güncellemesi: bekleyen limitler dolar mı? Dolumlar listesi döner.
   * Sniper her temiz kotasyonda çağırır (tick-seviyesi gerçekçilik).
   */
  checkPendingFills(symbol) {
    const q = this.#quotes.get(symbol);
    if (!q) return [];
    const fills = [];
    for (const [id, order] of this.#pendingOrders) {
      if (order.symbol !== symbol) continue;
      const touched = order.side === 'BUY' ? q.ask <= order.price : q.bid >= order.price;
      if (touched) {
        this.#pendingOrders.delete(id);
        fills.push(this.#fill(order, q, { maker: true }));
      }
    }
    return fills;
  }

  async cancelOrder(brokerOrderId) {
    return this.#pendingOrders.delete(brokerOrderId);
  }

  pendingOrders(symbol = null) {
    const all = [...this.#pendingOrders.values()];
    return symbol ? all.filter((o) => o.symbol === symbol) : all;
  }

  /** Sanal defter pozisyonu kapattığında broker kaydı bırakılır (PnL'siz). */
  releasePosition(brokerOrderId) {
    return this.#positions.delete(brokerOrderId);
  }

  async closePosition(brokerOrderId) {
    const pos = this.#positions.get(brokerOrderId);
    if (!pos) throw new Error(`pozisyon yok: ${brokerOrderId}`);
    const q = await this.getQuote(pos.symbol);
    const exitPrice = pos.side === 'BUY' ? q.bid : q.ask;
    this.#positions.delete(brokerOrderId);
    const direction = pos.side === 'BUY' ? 1 : -1;
    const exitFee = exitPrice * pos.volume * (this.#fees.feeTakerPct / 100);
    const grossPnl = (exitPrice - pos.entryPrice) * direction * pos.volume;
    return { exitPrice, grossPnl, netPnl: grossPnl - pos.commission - exitFee, closedAt: this.#now() };
  }

  async fetchOpenPositions() {
    return [...this.#positions.values()];
  }
}

export default BrokerInterface;
