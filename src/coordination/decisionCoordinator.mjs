/**
 * Bölüm 6.2 — Karar Akışı ve Müzakere (Debate) Protokolü.
 *
 * Bir işlemin doğumu beş adımlık deterministik el sıkışmadır:
 *   1. Bağlam yayını (Oracle/Structurer durum olayları)
 *   2. Aday önerisi (SETUP_CANDIDATE)
 *   3. Müzakere turu: sabit süreli pencere (500ms) içinde OBJECTION/ENDORSE
 *      toplanır; itiraz GEREKÇE taşımak zorundadır.
 *   4. Hüküm: veto hiyerarşisi — Governor (mutlak) > Oracle (zaman) >
 *      Sniper (maliyet, erteleyebilir). Veto yoksa ağırlıklı güven skoru
 *      eşiği aşan aday onaya gider.
 *   5. İcra ve rapor (correlationId zinciriyle arşiv).
 */

import { CONFIG } from '../config/defaults.mjs';

export const VERDICT = Object.freeze({
  APPROVED: 'APPROVED',
  VETOED: 'VETOED',
  DEFERRED: 'DEFERRED',     // Sniper maliyet vetosu: erteleme
  BELOW_THRESHOLD: 'BELOW_THRESHOLD',
});

// Veto hiyerarşisi: küçük sayı = yüksek öncelik
const VETO_PRIORITY = { governor: 0, oracle: 1, sniper: 2 };

export class DecisionCoordinator {
  #bus;
  #config;
  #now;
  #debates = new Map(); // candidateId -> { envelope, responses[], resolve }
  #archive = [];        // tüm hükümler (correlationId zinciri için)
  #unsubscribers = [];

  constructor({ bus, config = CONFIG.debate, now = () => Date.now() } = {}) {
    this.#bus = bus;
    this.#config = config;
    this.#now = now;
  }

  start() {
    this.#unsubscribers = [
      this.#bus.subscribe('OBJECTION', (env) => this.#onResponse(env)),
      this.#bus.subscribe('ENDORSE', (env) => this.#onResponse(env)),
    ];
  }

  stop() {
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers = [];
  }

  #onResponse(envelope) {
    const debate = this.#debates.get(envelope.payload.candidateId);
    if (!debate) return;
    // İtiraz gerekçe taşımak zorundadır (anayasal kural)
    if (envelope.type === 'OBJECTION' && !envelope.payload.reason) return;
    debate.responses.push({
      agent: envelope.source,
      verdict: envelope.payload.verdict, // OBJECTION'da: VETO | DEFER; ENDORSE'da: ENDORSE
      type: envelope.type,
      reason: envelope.payload.reason,
      confidence: envelope.payload.confidence ?? envelope.confidence,
    });
  }

  /**
   * Müzakere turunu açar, pencere kapanınca hüküm verir.
   * @param {object} candidateEnvelope SETUP_CANDIDATE zarfı
   * @returns {Promise<{ verdict, reason, weightedConfidence, responses }>}
   */
  async deliberate(candidateEnvelope) {
    const candidateId = candidateEnvelope.msgId;
    const debate = { envelope: candidateEnvelope, responses: [] };
    this.#debates.set(candidateId, debate);

    await new Promise((resolve) => {
      setTimeout(resolve, this.#config.windowMs);
    });

    this.#debates.delete(candidateId);
    const ruling = this.#rule(candidateEnvelope, debate.responses);
    this.#archive.push({
      at: this.#now(),
      correlationId: candidateEnvelope.correlationId,
      candidateId,
      ...ruling,
    });
    return ruling;
  }

  #rule(candidateEnvelope, responses) {
    // Veto hiyerarşisi: en yüksek öncelikli itiraz hükmü belirler
    const objections = responses
      .filter((r) => r.type === 'OBJECTION')
      .sort((a, b) => (VETO_PRIORITY[a.agent] ?? 99) - (VETO_PRIORITY[b.agent] ?? 99));

    if (objections.length > 0) {
      const top = objections[0];
      if (top.agent === 'sniper' && top.verdict === 'DEFER') {
        return { verdict: VERDICT.DEFERRED, reason: top.reason, weightedConfidence: 0, responses };
      }
      return {
        verdict: VERDICT.VETOED,
        reason: `${top.agent}: ${top.reason}`,
        vetoAgent: top.agent,
        weightedConfidence: 0,
        responses,
      };
    }

    // Ağırlıklı güven skoru: aday güveni + destek güvenlerinin ortalaması
    const endorsements = responses.filter((r) => r.type === 'ENDORSE');
    const scores = [candidateEnvelope.confidence, ...endorsements.map((e) => e.confidence)];
    const weightedConfidence = scores.reduce((a, b) => a + b, 0) / scores.length;

    if (weightedConfidence < this.#config.consensusThreshold) {
      return {
        verdict: VERDICT.BELOW_THRESHOLD,
        reason: `ağırlıklı güven ${weightedConfidence.toFixed(3)} < eşik ${this.#config.consensusThreshold}`,
        weightedConfidence,
        responses,
      };
    }
    return { verdict: VERDICT.APPROVED, reason: 'konsensüs sağlandı', weightedConfidence, responses };
  }

  /** Post-mortem zinciri: correlationId üzerinden hüküm arşivi. */
  archiveByCorrelation(correlationId) {
    return this.#archive.filter((entry) => entry.correlationId === correlationId);
  }
}

export default DecisionCoordinator;
