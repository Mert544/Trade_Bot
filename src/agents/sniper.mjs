/**
 * Faz 4 — The Sniper (Bölüm 5.4).
 *
 * Kararı maliyet-farkındalıklı icraya çevirir. Üç savunma hattı:
 *   1. Spread Kapısı — anlık spread > kayan medyanın N katı → emir reddedilir
 *      ("doğru sinyal, yanlış maliyet" işlemi reddedilir; icra vetosu budur)
 *   2. Slippage Bütçesi — Governor onayındaki maxSlippage limit emirle korunur
 *   3. Gecikme Bütçesi — sinyal doğumu → fill toplam süresi eşiği aşarsa
 *      sinyal bayat sayılır; geç giriş, hatalı giriştir.
 *
 * Gerçekleşen maliyet her işlemde EXECUTION_REPORT ile Meta-Biliş'e raporlanır.
 */

import { CONFIG } from '../config/defaults.mjs';

const AGENT_ID = 'sniper';
const AGENT_VERSION = '1.0.0';

export class Sniper {
  #bus;
  #broker;
  #config;
  #now;
  #logger;

  #approvals = new Map();   // candidateId -> { approval payload, correlationId, receivedAt }
  #candidates = new Map();  // candidateId -> SETUP_CANDIDATE zarfı
  #pendingOrders = new Map(); // brokerOrderId -> bekleyen limit takibi
  #spreadHistory = new Map(); // symbol -> [{ at, spread }]
  #embargoActive = false;
  #unsubscribers = [];
  #onOrderExpired;

  constructor({ bus, broker, config = CONFIG, now = () => Date.now(), logger = console, onOrderExpired = null } = {}) {
    this.#bus = bus;
    this.#broker = broker;
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
    // Kapalı olay kataloğu korunur: emir iptali bus olayı değil, gözlemci
    // kancasıdır (onObservation emsali) — signalHub UNFILLED'i buradan öğrenir
    this.#onOrderExpired = onOrderExpired;
  }

  start() {
    this.#unsubscribers = [
      this.#bus.subscribe('SETUP_CANDIDATE', (env) => {
        this.#candidates.set(env.msgId, env);
      }),
      this.#bus.subscribe('RISK_APPROVAL', (env) => this.#onApproval(env)),
      this.#bus.subscribe('EMBARGO_ON', async () => {
        this.#embargoActive = true;
        // Anayasa 5.1: ambargo penceresi açılınca bekleyen emirler iptal edilir
        for (const [brokerOrderId, tracked] of this.#pendingOrders) {
          this.#pendingOrders.delete(brokerOrderId);
          await this.#broker.cancelOrder(brokerOrderId);
          this.#cleanup(tracked.candidateId);
          this.#onOrderExpired?.({
            candidateId: tracked.candidateId,
            correlationId: tracked.correlationId,
            symbol: tracked.candidate.symbol,
            entry: tracked.candidate.entry,
            reason: 'ambargo: bekleyen emir iptal edildi (K1)',
          });
        }
      }),
      this.#bus.subscribe('EMBARGO_OFF', () => { this.#embargoActive = false; }),
      this.#bus.subscribe('STRUCTURE_INVALIDATED', (env) => {
        for (const id of env.payload.invalidatedCandidates) {
          this.#candidates.delete(id);
          this.#approvals.delete(id);
        }
      }),
    ];
  }

  stop() {
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers = [];
  }

  /** Kayan medyan spread referansı (1 saatlik pencere). */
  recordSpread(symbol, spread) {
    const history = this.#spreadHistory.get(symbol) ?? [];
    const now = this.#now();
    history.push({ at: now, spread });
    const cutoff = now - this.#config.execution.spreadMedianWindowMs;
    while (history.length && history[0].at < cutoff) history.shift();
    this.#spreadHistory.set(symbol, history);
  }

  medianSpread(symbol) {
    const history = this.#spreadHistory.get(symbol) ?? [];
    if (history.length === 0) return null;
    const sorted = history.map((h) => h.spread).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  async #onApproval(envelope) {
    const { candidateId } = envelope.payload;
    this.#approvals.set(candidateId, {
      ...envelope.payload,
      correlationId: envelope.correlationId,
      receivedAt: this.#now(),
    });
    await this.execute(candidateId);
  }

  /**
   * Onaylı adayı icra eder. Tüm kapılardan geçemeyen emir gerekçeli reddedilir.
   * @returns {{ executed: boolean, reason?: string, report?: object }}
   */
  async execute(candidateId) {
    const approval = this.#approvals.get(candidateId);
    const candidateEnv = this.#candidates.get(candidateId);
    if (!approval || !candidateEnv) {
      return { executed: false, reason: 'aday veya onay bulunamadı' };
    }
    const candidate = candidateEnv.payload;
    const correlationId = approval.correlationId;

    // K0 — Sinyal iptali: gecikme bütçesi (sinyal doğumundan itibaren)
    const signalAge = this.#now() - candidateEnv.timestamp;
    if (signalAge > approval.ttl) {
      this.#cleanup(candidateId);
      return { executed: false, reason: `sinyal bayat: yaş ${signalAge}ms > TTL ${approval.ttl}ms` };
    }
    if (this.#embargoActive) {
      this.#cleanup(candidateId);
      return { executed: false, reason: 'ambargo aktif: bekleyen emir iptal edildi (K1)' };
    }

    // Spread kapısı
    const quote = await this.#broker.getQuote(candidate.symbol);
    this.recordSpread(candidate.symbol, quote.spread);
    const median = this.medianSpread(candidate.symbol);
    if (median !== null && quote.spread > median * this.#config.execution.spreadGateMultiplier) {
      return {
        executed: false,
        reason: `spread kapısı: ${quote.spread.toFixed(6)} > ${this.#config.execution.spreadGateMultiplier}×medyan(${median.toFixed(6)})`,
      };
    }

    // İcra: limit emir + sunucu tarafı stop (anayasal zorunluluk)
    const submittedAt = this.#now();
    await this.#publish('ORDER_SUBMITTED', {
      candidateId, requestedPrice: candidate.entry,
    }, { correlationId });

    const fill = await this.#broker.submitOrder({
      symbol: candidate.symbol,
      side: candidate.side,
      volume: approval.lotSize,
      type: 'LIMIT',
      price: candidate.entry,
      stopLoss: candidate.stop,
      takeProfit: candidate.targets?.[0] ?? null,
    });

    // Limit pazarlanabilir değil: emir bekler. Dolum onQuote'ta, iptal
    // TTL'de — anında dolum varsayımı (eski davranış) hayalet işlemler
    // üretiyordu (fiyat giriş bölgesine hiç dönmeyebilir).
    if (fill.pending) {
      this.#pendingOrders.set(fill.brokerOrderId, {
        brokerOrderId: fill.brokerOrderId,
        candidateId,
        correlationId,
        candidate,
        approval,
        submittedAt,
        signalBornAt: candidateEnv.timestamp,
        expiresAt: candidateEnv.timestamp + approval.ttl,
      });
      return { executed: false, pending: true, brokerOrderId: fill.brokerOrderId };
    }

    await this.#reportFill({ fill, candidate, candidateId, correlationId, approval, quote, submittedAt, signalBornAt: candidateEnv.timestamp });
    this.#cleanup(candidateId);
    return { executed: true, brokerOrderId: fill.brokerOrderId };
  }

  /**
   * Temiz kotasyon akışı (FeedManager onQuote → buraya):
   *   1. Bekleyen limitlerin dolumu denetlenir (tick gerçekçiliği)
   *   2. TTL'i dolan bekleyen emirler iptal edilir → sinyal "FILL YOK"
   */
  async onQuote(symbol, _quote) {
    const fills = this.#broker.checkPendingFills?.(symbol) ?? [];
    for (const fill of fills) {
      const tracked = this.#pendingOrders.get(fill.brokerOrderId);
      if (!tracked) continue;
      this.#pendingOrders.delete(fill.brokerOrderId);
      const quote = await this.#broker.getQuote(symbol);
      await this.#reportFill({
        fill,
        candidate: tracked.candidate,
        candidateId: tracked.candidateId,
        correlationId: tracked.correlationId,
        approval: tracked.approval,
        quote,
        submittedAt: tracked.submittedAt,
        signalBornAt: tracked.signalBornAt,
      });
      this.#cleanup(tracked.candidateId);
    }

    // TTL süpürmesi: dolmayan emir iptal edilir; "fill olmadı" ayrı ve
    // değerli bir sonuçtur (sinyallerin kaçı uygulanabilirdi?)
    const now = this.#now();
    for (const [brokerOrderId, tracked] of this.#pendingOrders) {
      if (now <= tracked.expiresAt) continue;
      this.#pendingOrders.delete(brokerOrderId);
      await this.#broker.cancelOrder(brokerOrderId);
      this.#cleanup(tracked.candidateId);
      this.#onOrderExpired?.({
        candidateId: tracked.candidateId,
        correlationId: tracked.correlationId,
        symbol: tracked.candidate.symbol,
        entry: tracked.candidate.entry,
        reason: `TTL doldu, giriş fiyatı ${tracked.candidate.entry} görülmedi`,
      });
    }
  }

  async #reportFill({ fill, candidate, candidateId, correlationId, approval, quote, submittedAt, signalBornAt }) {
    const latencyMs = this.#now() - submittedAt;
    const totalLatencyMs = this.#now() - signalBornAt;
    const slippage = Math.abs(fill.fillPrice - candidate.entry);

    await this.#publish('ORDER_FILLED', {
      candidateId,
      brokerOrderId: fill.brokerOrderId,
      requestedPrice: candidate.entry,
      fillPrice: fill.fillPrice,
      latencyMs,
      commission: fill.commission ?? 0,
      maker: fill.maker ?? false,
    }, { correlationId });

    // Slippage bütçesi denetimi (post-fill ölçüm + alarm)
    if (slippage > approval.maxSlippage) {
      await this.#publish('SLIPPAGE_ALERT', { candidateId, slippage }, { correlationId });
    }

    await this.#publish('EXECUTION_REPORT', {
      candidateId,
      slippage,
      spreadAtFill: quote.spread,
      costTotal: slippage + quote.spread + (fill.commission ?? 0),
    }, {
      correlationId,
      evidence: [
        `Fill: ${fill.fillPrice} (istenen ${candidate.entry}), ${fill.maker ? 'maker' : 'taker'}, komisyon ${(fill.commission ?? 0).toFixed(6)}`,
        `Toplam gecikme: ${totalLatencyMs}ms (bütçe ${this.#config.execution.maxLatencyMs}ms)`,
      ],
    });
  }

  #cleanup(candidateId) {
    this.#approvals.delete(candidateId);
    this.#candidates.delete(candidateId);
  }

  async #publish(type, payload, { correlationId = null, evidence = [] } = {}) {
    return this.#bus.publish({
      type, source: AGENT_ID, version: AGENT_VERSION,
      payload, evidence, correlationId,
      ttlMs: 60_000, timestamp: this.#now(),
    });
  }
}

export default Sniper;
