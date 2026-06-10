/**
 * SignalHub — sinyal yaşam döngüsü merkezi (E2).
 *
 * "Sinyal", olay kataloğunda yeni bir tür DEĞİLDİR; correlationId zinciri
 * üzerinde bir GÖRÜNÜMDÜR (kapalı katalog anayasal kısıtı korunur).
 * Hub, zincir olaylarını tekil sinyal varlığına dönüştürür ve yaşam
 * döngüsünü yönetir:
 *
 *   CANDIDATE → APPROVED | VETOED → INVALIDATED | EXPIRED | CLOSED(WIN/LOSS)
 *
 * İnsan tüketicisi için sinyalin GERİ ÇEKİLMESİ (invalidation/expiry),
 * sinyalin kendisi kadar kritiktir — tüm geçişler sink'lere yayınlanır.
 * Sink arayüzü: { onSignalEvent(eventType, signal) } — Telegram, dashboard
 * SSE ve journal aynı arayüzü kullanır.
 */

import { CONFIG } from '../config/defaults.mjs';

export const SIGNAL_STATUS = Object.freeze({
  CANDIDATE: 'CANDIDATE',
  APPROVED: 'APPROVED',
  VETOED: 'VETOED',
  INVALIDATED: 'INVALIDATED',
  EXPIRED: 'EXPIRED',
  CLOSED: 'CLOSED',
});

export const SIGNAL_EVENT = Object.freeze({
  NEW: 'NEW',
  APPROVED: 'APPROVED',
  VETOED: 'VETOED',
  INVALIDATED: 'INVALIDATED',
  EXPIRED: 'EXPIRED',
  CLOSED: 'CLOSED',
  VOTE: 'VOTE',
  HYPOTHETICAL: 'HYPOTHETICAL',
});

export class SignalHub {
  #bus;
  #state;
  #config;
  #now;
  #logger;
  #signals = new Map();       // correlationId -> signal
  #byCandidate = new Map();   // candidateId (msgId) -> correlationId
  #sinks = [];
  #timer = null;
  #unsubscribers = [];

  constructor({ bus, stateManager = null, config = CONFIG.signals, now = () => Date.now(), logger = console } = {}) {
    this.#bus = bus;
    this.#state = stateManager;
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
  }

  addSink(sink) {
    this.#sinks.push(sink);
  }

  start() {
    this.#unsubscribers = [
      this.#bus.subscribe('SETUP_CANDIDATE', (env) => this.#onCandidate(env)),
      this.#bus.subscribe('RISK_APPROVAL', (env) => this.#onApproval(env)),
      this.#bus.subscribe('RISK_VETO', (env) => this.#onVeto(env)),
      this.#bus.subscribe('STRUCTURE_INVALIDATED', (env) => this.#onInvalidated(env)),
      this.#bus.subscribe('ORDER_FILLED', (env) => this.#onFilled(env)),
      this.#bus.subscribe('EXECUTION_REPORT', (env) => this.#onExecutionReport(env)),
      this.#bus.subscribe('OBJECTION', (env) => this.#onVote(env)),
      this.#bus.subscribe('ENDORSE', (env) => this.#onVote(env)),
    ];
    this.#timer = setInterval(() => this.#sweepExpiry(), this.#config.expirySweepMs);
    this.#timer.unref?.();
  }

  stop() {
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers = [];
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  // --- Zincir olayları → yaşam döngüsü ---

  #onCandidate(env) {
    const p = env.payload;
    const rr = this.#computeRR(p);
    const signal = {
      id: env.correlationId,
      candidateId: env.msgId,
      symbol: p.symbol,
      side: p.side,
      entry: p.entry,
      stop: p.stop,
      targets: p.targets,
      setupFamily: p.setupFamily,
      confidence: p.confidence,
      evidence: p.evidence,
      quality: this.#enrichQuality(p),
      rr,
      status: SIGNAL_STATUS.CANDIDATE,
      votes: [],
      createdAt: env.timestamp,
      expiresAt: env.timestamp + env.ttl,
      updatedAt: this.#now(),
    };
    this.#signals.set(signal.id, signal);
    this.#byCandidate.set(env.msgId, signal.id);
    this.#trim();
    this.#emit(SIGNAL_EVENT.NEW, signal);
  }

  /** Kalite bileşen vektörü (E3): mtfEngine bileşenleri + bağlam zenginleştirme. */
  #enrichQuality(payload) {
    const quality = { ...(payload.quality ?? {}) };
    if (this.#state) {
      quality.regime = this.#state.get(`regime.${payload.symbol}`)?.regime ?? 'UNKNOWN';
      quality.killzone = this.#state.get('killzone')?.zone ?? 'NONE';
      quality.embargoActive = this.#state.get('embargo')?.active ?? false;
    }
    return quality;
  }

  #computeRR(p) {
    const risk = Math.abs(p.entry - p.stop);
    const reward = p.targets?.length ? Math.abs(p.targets[0] - p.entry) : 0;
    return risk > 0 ? Number((reward / risk).toFixed(2)) : 0;
  }

  #onApproval(env) {
    const signal = this.#byId(env.payload.candidateId, env.correlationId);
    if (!signal || signal.status !== SIGNAL_STATUS.CANDIDATE) return;
    signal.status = SIGNAL_STATUS.APPROVED;
    signal.lotSize = env.payload.lotSize;
    signal.maxSlippage = env.payload.maxSlippage;
    signal.updatedAt = this.#now();
    this.#emit(SIGNAL_EVENT.APPROVED, signal);
  }

  #onVeto(env) {
    const signal = this.#byId(env.payload.candidateId, env.correlationId);
    if (!signal || signal.status !== SIGNAL_STATUS.CANDIDATE) return;
    signal.status = SIGNAL_STATUS.VETOED;
    signal.vetoReason = env.payload.vetoReason;
    signal.updatedAt = this.#now();
    this.#emit(SIGNAL_EVENT.VETOED, signal);
  }

  #onInvalidated(env) {
    for (const candidateId of env.payload.invalidatedCandidates ?? []) {
      const signal = this.#byId(candidateId, null);
      if (!signal) continue;
      if (signal.status === SIGNAL_STATUS.CANDIDATE || signal.status === SIGNAL_STATUS.APPROVED) {
        signal.status = SIGNAL_STATUS.INVALIDATED;
        signal.invalidationReason = env.payload.reason;
        signal.updatedAt = this.#now();
        this.#emit(SIGNAL_EVENT.INVALIDATED, signal);
      }
    }
  }

  #onFilled(env) {
    const signal = this.#byId(env.payload.candidateId, env.correlationId);
    if (!signal) return;
    signal.fillPrice = env.payload.fillPrice;
    signal.updatedAt = this.#now();
  }

  #onExecutionReport(env) {
    const signal = this.#byId(env.payload.candidateId, env.correlationId);
    if (!signal) return;
    signal.spreadAtFill = env.payload.spreadAtFill;
    signal.slippage = env.payload.slippage;
    signal.updatedAt = this.#now();
  }

  #onVote(env) {
    const signal = this.#byId(env.payload.candidateId, env.correlationId);
    if (!signal) return;
    signal.votes.push({
      agent: env.source,
      type: env.type,
      verdict: env.payload.verdict,
      reason: env.payload.reason,
      confidence: env.payload.confidence,
    });
    signal.updatedAt = this.#now();
    this.#emit(SIGNAL_EVENT.VOTE, signal);
  }

  // --- Dış kayıtlar (gölge defter geri beslemesi) ---

  /** Gölge işlem kapanışı: sinyal sonucu bağlanır (E8 post-mortem girdisi). */
  recordOutcome(trade) {
    const signal = this.#signals.get(trade.correlationId);
    if (!signal) return;
    signal.status = SIGNAL_STATUS.CLOSED;
    signal.outcome = trade.outcome;        // WIN | LOSS
    signal.netPnl = trade.netPnl;
    signal.exit = trade.exit;
    signal.updatedAt = this.#now();
    this.#emit(SIGNAL_EVENT.CLOSED, signal);
  }

  /** Reddedilen/gözlem adayının hipotetik akıbeti (veto isabeti verisi). */
  recordHypothetical(correlationId, outcome) {
    const signal = this.#signals.get(correlationId);
    if (!signal) return;
    signal.hypotheticalOutcome = outcome;  // WOULD_HAVE_WON | WOULD_HAVE_LOST
    signal.updatedAt = this.#now();
    this.#emit(SIGNAL_EVENT.HYPOTHETICAL, signal);
  }

  // --- Süreklilik ---

  #sweepExpiry() {
    const now = this.#now();
    for (const signal of this.#signals.values()) {
      if ((signal.status === SIGNAL_STATUS.CANDIDATE || signal.status === SIGNAL_STATUS.APPROVED)
        && now > signal.expiresAt) {
        signal.status = SIGNAL_STATUS.EXPIRED;
        signal.updatedAt = now;
        this.#emit(SIGNAL_EVENT.EXPIRED, signal);
      }
    }
  }

  #byId(candidateId, correlationId) {
    const id = this.#byCandidate.get(candidateId) ?? correlationId;
    return id ? this.#signals.get(id) ?? null : null;
  }

  #trim() {
    while (this.#signals.size > this.#config.maxLiveSignals) {
      const oldest = this.#signals.keys().next().value;
      const sig = this.#signals.get(oldest);
      this.#byCandidate.delete(sig?.candidateId);
      this.#signals.delete(oldest);
    }
  }

  #emit(eventType, signal) {
    for (const sink of this.#sinks) {
      try {
        sink.onSignalEvent(eventType, structuredClone(signal));
      } catch (err) {
        this.#logger.error(`[signalHub] sink hatası (${eventType}): ${err.message}`);
      }
    }
  }

  /** Dashboard: son sinyaller (yeni → eski). */
  list(limit = 50) {
    return [...this.#signals.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((s) => structuredClone(s));
  }

  get(correlationId) {
    const s = this.#signals.get(correlationId);
    return s ? structuredClone(s) : null;
  }
}

export default SignalHub;
