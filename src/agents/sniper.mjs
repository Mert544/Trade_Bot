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
  #spreadHistory = new Map(); // symbol -> [{ at, spread }]
  #embargoActive = false;
  #unsubscribers = [];

  constructor({ bus, broker, config = CONFIG, now = () => Date.now(), logger = console } = {}) {
    this.#bus = bus;
    this.#broker = broker;
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
  }

  start() {
    this.#unsubscribers = [
      this.#bus.subscribe('SETUP_CANDIDATE', (env) => {
        this.#candidates.set(env.msgId, env);
      }),
      this.#bus.subscribe('RISK_APPROVAL', (env) => this.#onApproval(env)),
      this.#bus.subscribe('EMBARGO_ON', () => { this.#embargoActive = true; }),
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

    const latencyMs = this.#now() - submittedAt;
    const totalLatencyMs = this.#now() - candidateEnv.timestamp;
    const slippage = Math.abs(fill.fillPrice - candidate.entry);

    await this.#publish('ORDER_FILLED', {
      candidateId,
      brokerOrderId: fill.brokerOrderId,
      requestedPrice: candidate.entry,
      fillPrice: fill.fillPrice,
      latencyMs,
    }, { correlationId });

    // Slippage bütçesi denetimi (post-fill ölçüm + alarm)
    if (slippage > approval.maxSlippage) {
      await this.#publish('SLIPPAGE_ALERT', { candidateId, slippage }, { correlationId });
    }

    const report = {
      candidateId,
      slippage,
      spreadAtFill: quote.spread,
      costTotal: slippage + quote.spread,
    };
    await this.#publish('EXECUTION_REPORT', report, {
      correlationId,
      evidence: [
        `Fill: ${fill.fillPrice} (istenen ${candidate.entry}), slippage ${slippage.toFixed(6)}`,
        `Toplam gecikme: ${totalLatencyMs}ms (bütçe ${this.#config.execution.maxLatencyMs}ms)`,
      ],
    });

    this.#cleanup(candidateId);
    return { executed: true, report, brokerOrderId: fill.brokerOrderId };
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
