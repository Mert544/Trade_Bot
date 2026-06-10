/**
 * Faz 3 — The Structurer v1 (Bölüm 5.2).
 *
 * Çoklu zaman dilimi hiyerarşisini durum makinesi olarak yönetir.
 * Bilgi akışı TEK YÖNLÜdür: üst zaman dilimi alta bağlam verir, asla tersi olmaz.
 *
 *   4H  — Yön Katmanı:   DOL hedefi → LONG_BIAS / SHORT_BIAS / NEUTRAL
 *   15M — Anlatı Katmanı: MMXM fazları (konsolidasyon/manipülasyon/dağıtım)
 *   5M/1M — Tetik Katmanı: yalnızca üst iki katman hizalıyken aktif;
 *           MSS teyidi + FVG/OB giriş bölgesi → SETUP_CANDIDATE
 *
 * Killzone kuralı (5.1): aktif killzone dışında üretilen adaylar otomatik
 * "gözlem" statüsünde kalır; yalnızca killzone içindekiler oylamaya girer.
 * Her senkron kırılması STRUCTURE_INVALIDATED üretir ve bekleyen adayları iptal eder.
 */

import { CONFIG } from '../config/defaults.mjs';

const AGENT_ID = 'structurer';
const AGENT_VERSION = '1.0.0';

export const BIAS = Object.freeze({ LONG: 'LONG_BIAS', SHORT: 'SHORT_BIAS', NEUTRAL: 'NEUTRAL' });
export const MMXM_PHASE = Object.freeze({
  CONSOLIDATION: 'CONSOLIDATION',
  MANIPULATION: 'MANIPULATION',
  DISTRIBUTION: 'DISTRIBUTION',
  UNKNOWN: 'UNKNOWN',
});

export class Structurer {
  #bus;
  #config;
  #now;

  // symbol -> { htfBias, dolLevel, phase, narrativeConfirmed }
  #context = new Map();
  // symbol -> pending candidate msgIds
  #pendingCandidates = new Map();
  #killzoneActive = false;
  #newsSweepTags = new Map(); // symbol -> son NEWS_SWEEP_TAG payload
  #unsubscribers = [];
  #onObservation;

  constructor({ bus, config = CONFIG, now = () => Date.now(), onObservation = null } = {}) {
    this.#bus = bus;
    this.#config = config;
    this.#now = now;
    this.#onObservation = onObservation;
  }

  start() {
    this.#unsubscribers = [
      this.#bus.subscribe('KILLZONE_STATE', (env) => {
        this.#killzoneActive = env.payload.active;
      }),
      this.#bus.subscribe('NEWS_SWEEP_TAG', (env) => {
        // Oracle etiketi: yüksek olasılıklı tersine dönüş bağlamı
        this.#newsSweepTags.set(env.payload.symbol, { ...env.payload, correlationId: env.correlationId });
      }),
    ];
  }

  stop() {
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers = [];
  }

  #ctx(symbol) {
    if (!this.#context.has(symbol)) {
      this.#context.set(symbol, {
        htfBias: BIAS.NEUTRAL, dolLevel: null,
        phase: MMXM_PHASE.UNKNOWN, narrativeConfirmed: false,
      });
    }
    return this.#context.get(symbol);
  }

  // --- 4H Yön Katmanı ---

  /** 4H analiz sonucu dışarıdan/analiz motorundan beslenir. Bias değişimi alt katmanları sıfırlar. */
  async updateHtfBias(symbol, { htfBias, dolLevel, evidence = [] }) {
    const ctx = this.#ctx(symbol);
    const changed = ctx.htfBias !== htfBias;
    ctx.htfBias = htfBias;
    ctx.dolLevel = dolLevel;

    if (changed) {
      // Senkron kırılması: bayat sinyallerin icraya sızması yapısal olarak imkânsız
      ctx.phase = MMXM_PHASE.UNKNOWN;
      ctx.narrativeConfirmed = false;
      await this.#invalidate(symbol, `4H bias değişimi → ${htfBias}`);
    }

    await this.#publish('BIAS_UPDATE', { symbol, htfBias, dolLevel, tf: '4H' }, {
      evidence: evidence.length ? evidence : [`4H DOL hedefi: ${dolLevel} (${htfBias})`],
    });
  }

  // --- 15M Anlatı Katmanı ---

  /** 15M MMXM faz sınıflandırması. 4H bias ile uyumsuzsa sistem bekler. */
  async updateNarrativePhase(symbol, { phase, alignedWithBias }) {
    const ctx = this.#ctx(symbol);
    ctx.phase = phase;
    const wasConfirmed = ctx.narrativeConfirmed;
    ctx.narrativeConfirmed = alignedWithBias && ctx.htfBias !== BIAS.NEUTRAL
      && (phase === MMXM_PHASE.MANIPULATION || phase === MMXM_PHASE.DISTRIBUTION);
    if (wasConfirmed && !ctx.narrativeConfirmed) {
      await this.#invalidate(symbol, `15M anlatı bozuldu (faz: ${phase})`);
    }
    return ctx.narrativeConfirmed;
  }

  // --- 5M/1M Tetik Katmanı ---

  /**
   * MSS teyidi + FVG/OB bölgesi tespitiyle çağrılır.
   * Üst katman hizası yoksa hiçbir şey üretmez (tek yönlü bilgi akışı).
   * Killzone dışındaysa aday "gözlem" statüsünde kalır, yayınlanmaz.
   */
  async proposeSetup(symbol, { side, entry, stop, targets, setupFamily, mssConfirmed, quality = {}, evidence = [] }) {
    const ctx = this.#ctx(symbol);

    if (!mssConfirmed) return { proposed: false, reason: 'MSS teyidi yok' };
    if (ctx.htfBias === BIAS.NEUTRAL || !ctx.narrativeConfirmed) {
      return { proposed: false, reason: 'üst katman hizası yok (4H bias / 15M anlatı)' };
    }
    const expectedSide = ctx.htfBias === BIAS.LONG ? 'BUY' : 'SELL';
    if (side !== expectedSide) {
      return { proposed: false, reason: `aday yönü (${side}) 4H bias (${ctx.htfBias}) ile çelişiyor` };
    }
    if (!this.#killzoneActive) {
      // Killzone hipotez verisi (E6): gözlem adayı bus'a ÇIKMAZ (anayasal kural)
      // ama karşılaştırma grubu olarak dış gözlemciye raporlanır — killzone'un
      // kriptodaki etkisi varsayımla değil veriyle ölçülür.
      this.#onObservation?.({
        symbol, side, entry, stop, targets, setupFamily, quality,
        evidence, observedAt: this.#now(), reason: 'killzone dışı',
      });
      return { proposed: false, reason: 'killzone dışı — aday gözlem statüsünde', observed: true };
    }

    // Güven skoru: kanıt bileşenlerinin ağırlıklı birleşimi (v1: basit taban + bonuslar)
    let confidence = 0.6;
    const evidenceChain = [
      `4H ${ctx.htfBias}, DOL: ${ctx.dolLevel}`,
      `15M faz: ${ctx.phase} (anlatı teyitli)`,
      `Tetik: MSS teyitli, ${setupFamily}`,
      ...evidence,
    ];
    const sweepTag = this.#newsSweepTags.get(symbol);
    if (sweepTag) {
      confidence = Math.min(1, confidence + 0.15);
      evidenceChain.push(`Oracle NEWS_SWEEP_TAG: ${sweepTag.direction} @ ${sweepTag.sweptLevel}`);
    }

    const { envelope } = await this.#publish('SETUP_CANDIDATE', {
      symbol, side, entry, stop, targets, setupFamily, confidence, quality,
      evidence: evidenceChain,
    }, {
      confidence,
      evidence: evidenceChain,
      ttlMs: this.#config.execution.signalTtlMs,
      correlationId: sweepTag?.correlationId ?? null,
    });

    const pending = this.#pendingCandidates.get(symbol) ?? [];
    pending.push(envelope.msgId);
    this.#pendingCandidates.set(symbol, pending);
    return { proposed: true, candidateId: envelope.msgId, confidence };
  }

  async #invalidate(symbol, reason) {
    const invalidatedCandidates = this.#pendingCandidates.get(symbol) ?? [];
    this.#pendingCandidates.set(symbol, []);
    await this.#publish('STRUCTURE_INVALIDATED', { symbol, reason, invalidatedCandidates }, {
      evidence: [reason, `${invalidatedCandidates.length} bekleyen aday iptal edildi`],
    });
  }

  contextOf(symbol) {
    return { ...this.#ctx(symbol) };
  }

  async #publish(type, payload, { evidence = [], confidence = 1.0, ttlMs = 5 * 60_000, correlationId = null } = {}) {
    return this.#bus.publish({
      type, source: AGENT_ID, version: AGENT_VERSION,
      payload, evidence, confidence, correlationId, ttlMs,
      timestamp: this.#now(),
    });
  }
}

export default Structurer;
