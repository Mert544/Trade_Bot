/**
 * Bölüm 7.1 — Gölge Modu (Shadow Mode) Defteri.
 *
 * Canlı sistemle aynı veri akışını tüketir, emirleri sanal defterde tutar.
 * İki iş görür:
 *   1. Challenger strateji versiyonlarını gerçek piyasa koşullarında,
 *      sermaye riski olmadan test eder.
 *   2. Canlı sistemin ALMADIĞI işlemleri de kaydeder — reddedilen adayların
 *      akıbeti, veto mekanizmasının isabetini ölçmenin tek yoludur.
 *
 * Maliyetsiz simülasyon YASAKTIR: spread, komisyon ve modellenmiş slippage dahildir.
 */

export class ShadowLedger {
  #trades = [];          // kapanan sanal işlemler
  #open = new Map();     // candidateId -> açık sanal pozisyon
  #rejected = new Map(); // candidateId -> { candidate, vetoReason, hypothetical }
  #costModel;
  #now;
  #onClose;
  #onHypothetical;

  constructor({
    costModel = { spread: 0.0002, commissionPerLot: 3.0, slippage: 0.0001 },
    now = () => Date.now(),
    onClose = null,        // (trade) => void — kapanan sanal işlem geri beslemesi
    onHypothetical = null, // (record) => void — reddedilen adayın akıbeti çözüldü
  } = {}) {
    this.#costModel = costModel;
    this.#now = now;
    this.#onClose = onClose;
    this.#onHypothetical = onHypothetical;
  }

  /** Onaylanan (veya challenger'ın alacağı) adayı sanal olarak açar. */
  openVirtual(candidateEnvelope, { lotSize, strategyVersion = 'champion' }) {
    const c = candidateEnvelope.payload;
    const direction = c.side === 'BUY' ? 1 : -1;
    const entryWithCosts = c.entry + direction * (this.#costModel.slippage + this.#costModel.spread / 2);
    this.#open.set(candidateEnvelope.msgId, {
      candidateId: candidateEnvelope.msgId,
      correlationId: candidateEnvelope.correlationId,
      strategyVersion,
      symbol: c.symbol,
      side: c.side,
      entry: entryWithCosts,
      stop: c.stop,
      targets: c.targets,
      lotSize,
      commission: this.#costModel.commissionPerLot * lotSize,
      openedAt: this.#now(),
    });
  }

  /** Reddedilen adayı kaydeder; akıbeti fiyat akışıyla izlenir (veto isabeti ölçümü). */
  recordRejection(candidateEnvelope, vetoReason) {
    const c = candidateEnvelope.payload;
    this.#rejected.set(candidateEnvelope.msgId, {
      candidateId: candidateEnvelope.msgId,
      correlationId: candidateEnvelope.correlationId,
      candidate: { ...c },
      vetoReason,
      rejectedAt: this.#now(),
      hypothetical: { status: 'TRACKING', outcome: null },
    });
  }

  /** Her fiyat güncellemesinde açık sanal pozisyonları ve reddedilen adayları işler. */
  onPrice(symbol, price) {
    for (const [id, pos] of this.#open) {
      if (pos.symbol !== symbol) continue;
      const direction = pos.side === 'BUY' ? 1 : -1;
      const hitStop = direction === 1 ? price <= pos.stop : price >= pos.stop;
      const hitTarget = pos.targets?.length
        && (direction === 1 ? price >= pos.targets[0] : price <= pos.targets[0]);
      if (hitStop || hitTarget) {
        const exit = hitStop ? pos.stop : pos.targets[0];
        const grossPnl = (exit - pos.entry) * direction * pos.lotSize;
        const trade = {
          ...pos,
          exit,
          outcome: hitStop ? 'LOSS' : 'WIN',
          grossPnl,
          netPnl: grossPnl - pos.commission,
          closedAt: this.#now(),
        };
        this.#trades.push(trade);
        this.#open.delete(id);
        this.#onClose?.(trade); // geri besleme: drawdown makinesi + sinyal sonucu + post-mortem
      }
    }
    // Reddedilen adayların hipotetik akıbeti (karşı-olgusal veri — Bölüm 8.2)
    for (const rec of this.#rejected.values()) {
      if (rec.candidate.symbol !== symbol || rec.hypothetical.status !== 'TRACKING') continue;
      const direction = rec.candidate.side === 'BUY' ? 1 : -1;
      const hitStop = direction === 1 ? price <= rec.candidate.stop : price >= rec.candidate.stop;
      const hitTarget = rec.candidate.targets?.length
        && (direction === 1 ? price >= rec.candidate.targets[0] : price <= rec.candidate.targets[0]);
      if (hitStop) rec.hypothetical = { status: 'RESOLVED', outcome: 'WOULD_HAVE_LOST' };
      else if (hitTarget) rec.hypothetical = { status: 'RESOLVED', outcome: 'WOULD_HAVE_WON' };
      if (rec.hypothetical.status === 'RESOLVED') this.#onHypothetical?.(structuredClone(rec));
    }
  }

  /** Veto isabet oranı: reddedilenlerin kaçı gerçekten kaybedecekti? */
  vetoAccuracy() {
    const resolved = [...this.#rejected.values()].filter((r) => r.hypothetical.status === 'RESOLVED');
    if (resolved.length === 0) return { resolved: 0, accuracy: null };
    const correctVetoes = resolved.filter((r) => r.hypothetical.outcome === 'WOULD_HAVE_LOST').length;
    return { resolved: resolved.length, accuracy: correctVetoes / resolved.length };
  }

  stats(strategyVersion = null) {
    const trades = strategyVersion
      ? this.#trades.filter((t) => t.strategyVersion === strategyVersion)
      : this.#trades;
    const wins = trades.filter((t) => t.outcome === 'WIN').length;
    const netPnl = trades.reduce((sum, t) => sum + t.netPnl, 0);
    return {
      total: trades.length,
      wins,
      losses: trades.length - wins,
      winRate: trades.length ? wins / trades.length : null,
      netPnl,
      openCount: this.#open.size,
      rejectedCount: this.#rejected.size,
    };
  }

  closedTrades() {
    return [...this.#trades];
  }
}

export default ShadowLedger;
