/**
 * Faz 2 — The Governor (Bölüm 5.3).
 *
 * Sistemin anayasa mahkemesi; vetosu temyiz edilemez. İki sorumluluk:
 *   1. Kural uygulama — FTMO sert limitleri, tampon bölge mantığı:
 *      günlük %3,5 → SOFT_LOCK (yeni giriş yok),
 *      günlük %4,5 → HARD_LOCK (tüm pozisyonlar kapanır, gün sonu kilidi),
 *      toplam %8  → KILLSWITCH (K3).
 *   2. Sermaye optimizasyonu — asimetrik lot fonksiyonu:
 *      f(volatilite rejimi, ardışık sonuç serisi, kalan DD tamponu).
 *      Kayıpta geometrik küçülme (anti-martingale), kazançta doğrusal ve tavanlı artış.
 *
 * Onay protokolü: her SETUP_CANDIDATE, RISK_APPROVAL almadan Sniper'a ulaşamaz.
 */

import { CONFIG } from '../config/defaults.mjs';

const AGENT_ID = 'governor';
const AGENT_VERSION = '1.0.0';

export class Governor {
  #bus;
  #state;
  #config;
  #now;
  #logger;

  #embargoActive = false;
  #streak = 0; // pozitif = ardışık kazanç, negatif = ardışık kayıp
  #unsubscribers = [];

  constructor({ bus, stateManager, config = CONFIG, now = () => Date.now(), logger = console } = {}) {
    this.#bus = bus;
    this.#state = stateManager;
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
  }

  start() {
    this.#unsubscribers = [
      this.#bus.subscribe('EMBARGO_ON', (env) => this.#onEmbargo(env, true)),
      this.#bus.subscribe('EMBARGO_OFF', (env) => this.#onEmbargo(env, false)),
      this.#bus.subscribe('SETUP_CANDIDATE', (env) => this.evaluateCandidate(env)),
      this.#bus.subscribe('EXECUTION_REPORT', (env) => this.#onExecutionReport(env)),
      this.#bus.subscribe('FEED_STALE', (env) => this.#onFeedStale(env)),
    ];
  }

  stop() {
    for (const unsub of this.#unsubscribers) unsub();
    this.#unsubscribers = [];
  }

  // --- Drawdown durum makinesi ---

  /** Her PnL değişiminde / periyodik olarak çağrılır; kilit kademesini günceller. */
  async assessRiskState() {
    const dailyDD = this.#state.dailyDrawdownPct();
    const totalDD = this.#state.totalDrawdownPct();
    const current = this.#state.get('riskLock');
    const r = this.#config.risk;

    let next = 'NONE';
    if (totalDD >= r.totalKillswitchPct) next = 'KILLSWITCH';
    else if (dailyDD >= r.hardLockDailyPct) next = 'HARD_LOCK';
    else if (dailyDD >= r.softLockDailyPct) next = 'SOFT_LOCK';

    // Kilit yalnızca sıkılaşır; gevşeme gün dönüşünde (rolloverDay) olur.
    const order = ['NONE', 'SOFT_LOCK', 'HARD_LOCK', 'KILLSWITCH'];
    if (order.indexOf(next) <= order.indexOf(current)) return current;

    this.#state.set('riskLock', next, { source: AGENT_ID });
    const level = next === 'KILLSWITCH' ? 'K3' : 'K2';
    await this.#publish('KILLSWITCH', {
      level,
      trigger: next === 'KILLSWITCH'
        ? `toplam DD %${totalDD.toFixed(2)} ≥ %${r.totalKillswitchPct}`
        : `günlük DD %${dailyDD.toFixed(2)}`,
      scope: next,
    }, {
      evidence: [`Günlük DD: %${dailyDD.toFixed(2)} | Toplam DD: %${totalDD.toFixed(2)} | Kilit: ${current} → ${next}`],
    });
    return next;
  }

  // --- Asimetrik Lot Optimizasyonu ---

  /**
   * Risk tutarı sabit kalır; lot, stop mesafesi ve rejime göre türetilir.
   * @returns {{ lotSize, riskPct, riskAmount }}
   */
  computeLotSize({ entry, stop, equity = this.#state.get('equity'), regime = 'RANGE', pipValue = 1, symbol = null }) {
    const r = this.#config.risk;
    let riskPct = r.baseRiskPerTradePct;

    // Ardışık kayıplarda geometrik küçülme (anti-martingale)
    if (this.#streak < 0) {
      riskPct *= r.lossStreakMultiplier ** Math.abs(this.#streak);
    } else if (this.#streak > 0) {
      // Kazanç serisinde yalnızca doğrusal ve tavanlı artış
      riskPct = Math.min(r.maxRiskPerTradePct, riskPct + this.#streak * r.winStreakIncrement);
    }

    // Kalan drawdown tamponu daraldıkça risk orantılı kısılır
    const dailyDD = this.#state.dailyDrawdownPct();
    const bufferRatio = Math.max(0, (r.softLockDailyPct - dailyDD) / r.softLockDailyPct);
    riskPct *= bufferRatio;

    // Yüksek volatilite rejiminde stop zaten geniştir; lot otomatik daralır
    // (riskAmount sabit, stopDistance büyük). Ek güvenlik çarpanı:
    if (regime === 'HIGH_VOL') riskPct *= 0.75;

    const riskAmount = equity * (riskPct / 100);
    const stopDistance = Math.abs(entry - stop);
    if (stopDistance <= 0) return { lotSize: 0, riskPct: 0, riskAmount: 0 };
    let lotSize = riskAmount / (stopDistance * pipValue);

    // Hesap kısıtları (bakiye gerçekçiliği):
    // 1. Nominal tavan: spot hesapta pozisyon değeri bakiyeyi aşamaz
    const account = this.#config.account ?? {};
    if (account.maxLeverage && entry > 0) {
      const notionalCap = (equity * account.maxLeverage) / entry;
      lotSize = Math.min(lotSize, notionalCap);
    }
    // 2. Borsa asgari emir boyutu: altında kalan sinyal bu hesapla UYGULANAMAZ.
    //    Sinyal yanlış değil, hesap küçük — gerekçe asgari bakiyeyi söyler.
    const minOrder = symbol ? account.minOrderSize?.[symbol] ?? 0 : 0;
    if (minOrder > 0 && lotSize < minOrder) {
      const minRequiredEquity = riskPct > 0
        ? Math.ceil((minOrder * stopDistance * pipValue) / (riskPct / 100))
        : null;
      return {
        lotSize: 0,
        riskPct,
        riskAmount,
        infeasible: 'MIN_ORDER',
        minOrder,
        minRequiredEquity,
      };
    }

    return { lotSize: Math.max(0, Number(lotSize.toFixed(6))), riskPct, riskAmount };
  }

  recordTradeOutcome(pnl) {
    if (pnl > 0) this.#streak = this.#streak >= 0 ? this.#streak + 1 : 1;
    else if (pnl < 0) this.#streak = this.#streak <= 0 ? this.#streak - 1 : -1;
  }

  get streak() {
    return this.#streak;
  }

  // --- Onay Protokolü ---

  /** SETUP_CANDIDATE zarfını değerlendirir; RISK_APPROVAL veya RISK_VETO yayınlar. */
  async evaluateCandidate(envelope) {
    const candidate = envelope.payload;
    const candidateId = envelope.msgId;
    const veto = async (vetoReason) => {
      await this.#publish('RISK_VETO', { candidateId, vetoReason }, {
        correlationId: envelope.correlationId,
        evidence: [vetoReason],
      });
      return { approved: false, vetoReason };
    };

    if (this.#embargoActive) {
      return veto('Ambargo penceresi aktif (Oracle zaman vetosu altında yeni giriş yok)');
    }
    const lock = this.#state.get('riskLock');
    if (lock !== 'NONE') {
      return veto(`Risk kilidi aktif: ${lock}`);
    }
    await this.assessRiskState();
    if (this.#state.get('riskLock') !== 'NONE') {
      return veto(`Risk kilidi değerlendirme sırasında devreye girdi: ${this.#state.get('riskLock')}`);
    }

    const regime = this.#state.get(`regime.${candidate.symbol}`)?.regime ?? 'RANGE';
    const sizing = this.computeLotSize({
      entry: candidate.entry, stop: candidate.stop, regime, symbol: candidate.symbol,
    });
    const { lotSize, riskPct } = sizing;
    if (sizing.infeasible === 'MIN_ORDER') {
      return veto(`Hesap için uygulanamaz: lot < borsa asgarisi ${sizing.minOrder}`
        + (sizing.minRequiredEquity ? ` (bu sinyal ~${sizing.minRequiredEquity}$ altı hesapta uygulanamaz)` : ''));
    }
    if (lotSize <= 0) {
      return veto('Lot fonksiyonu sıfır döndü (DD tamponu tükenmiş veya geçersiz stop)');
    }

    await this.#publish('RISK_APPROVAL', {
      candidateId,
      lotSize,
      maxSlippage: this.#config.execution.defaultMaxSlippagePips,
      ttl: this.#config.execution.signalTtlMs,
    }, {
      correlationId: envelope.correlationId,
      confidence: envelope.confidence,
      evidence: [
        `Risk %${riskPct.toFixed(3)} | streak=${this.#streak} | rejim=${regime}`,
        `Günlük DD %${this.#state.dailyDrawdownPct().toFixed(2)} / SOFT %${this.#config.risk.softLockDailyPct}`,
      ],
    });
    return { approved: true, lotSize };
  }

  // --- Olay işleyicileri ---

  async #onEmbargo(envelope, on) {
    this.#embargoActive = on;
    this.#state.set('embargo', {
      active: on,
      eventName: envelope.payload.eventName,
      windowEnd: envelope.payload.windowEnd,
    }, { source: AGENT_ID, correlationId: envelope.correlationId });
    this.#logger.info(`[governor] ambargo ${on ? 'AÇIK' : 'KAPALI'}: ${envelope.payload.eventName}`);
  }

  async #onExecutionReport(envelope) {
    await this.assessRiskState();
  }

  async #onFeedStale(envelope) {
    // Feed donması: yeni pozisyon açılışı otomatik askıya alınır (Bölüm 4.2)
    if (this.#state.get('riskLock') === 'NONE') {
      this.#state.set('riskLock', 'SOFT_LOCK', { source: AGENT_ID, correlationId: envelope.correlationId });
      this.#logger.warn(`[governor] FEED_STALE → SOFT_LOCK (${envelope.payload.source}/${envelope.payload.symbol})`);
    }
  }

  async #publish(type, payload, { evidence = [], confidence = 1.0, correlationId = null } = {}) {
    return this.#bus.publish({
      type, source: AGENT_ID, version: AGENT_VERSION,
      payload, evidence, confidence, correlationId,
      ttlMs: 60_000, timestamp: this.#now(),
    });
  }
}

export default Governor;
