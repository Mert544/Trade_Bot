/**
 * stateManager.mjs — Omurga bileşeni: sistemin TEK gerçeklik kaynağı
 * (single source of truth).
 *
 * Tuttuğu durum: pozisyonlar, drawdown, rejim, ambargo, killzone,
 * strateji versiyonları ve rollback noktaları (Bölüm 8.3), telemetri KPI'ları (Ek D).
 *
 * Anayasal kural (Bölüm 9): yerel durum hiçbir zaman broker gerçeğinin
 * önüne geçemez — reconcile() açılışta broker durumuyla mutabakat yapar,
 * uyuşmazlık varsa işlem öncesi raporlar.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class StateManager {
  #state;
  #persistPath;
  #auditLog = [];

  constructor({ persistPath = null, initialEquity = 100_000 } = {}) {
    this.#persistPath = persistPath;
    this.#state = {
      equity: initialEquity,
      dayStartEquity: initialEquity,
      peakEquity: initialEquity,
      dailyPnl: 0,
      positions: {},          // brokerOrderId -> position
      pendingCandidates: {},  // candidateId -> SETUP_CANDIDATE zarfı
      embargo: { active: false, eventName: null, windowEnd: null },
      killzone: { zone: null, active: false, trueDayOpen: null },
      regime: {},             // symbol -> { regime, score, updatedAt }
      bias: {},               // symbol -> { htfBias, dolLevel, updatedAt }
      riskLock: 'NONE',       // NONE | SOFT_LOCK | HARD_LOCK | KILLSWITCH
      clockOffsetMs: 0,
      strategyVersions: [],   // { version, weights, promotedAt, rollbackOf }
      activeStrategyVersion: null,
      kpi: {},                // Ek D telemetri anlık görüntüleri
    };
    if (persistPath && existsSync(persistPath)) {
      try {
        Object.assign(this.#state, JSON.parse(readFileSync(persistPath, 'utf8')));
      } catch {
        // Bozuk durum dosyası gerçeklik kaynağı olamaz; temiz başlanır,
        // reconcile() broker gerçeğini zaten yeniden kurar.
      }
    }
  }

  get(path) {
    return path.split('.').reduce((acc, key) => acc?.[key], this.#state);
  }

  /** Tüm yazımlar audit iziyle yapılır (Sembolik Şeffaflık). */
  set(path, value, { source = 'unknown', correlationId = null } = {}) {
    const keys = path.split('.');
    const last = keys.pop();
    let target = this.#state;
    for (const key of keys) {
      if (!(key in target)) target[key] = {};
      target = target[key];
    }
    target[last] = value;
    this.#auditLog.push({ at: Date.now(), path, source, correlationId });
    this.#persist();
  }

  snapshot() {
    return structuredClone(this.#state);
  }

  // --- Drawdown muhasebesi (Governor'ın tek veri kaynağı) ---

  recordPnl(amount, meta = {}) {
    this.#state.equity += amount;
    this.#state.dailyPnl += amount;
    if (this.#state.equity > this.#state.peakEquity) this.#state.peakEquity = this.#state.equity;
    this.#auditLog.push({ at: Date.now(), path: 'equity', delta: amount, ...meta });
    this.#persist();
  }

  /** Günlük kayıp yüzdesi (pozitif sayı = kayıp). */
  dailyDrawdownPct() {
    const loss = this.#state.dayStartEquity - (this.#state.dayStartEquity + this.#state.dailyPnl);
    return Math.max(0, (loss / this.#state.dayStartEquity) * 100);
  }

  /** Tepe noktasından toplam düşüş yüzdesi. */
  totalDrawdownPct() {
    return Math.max(0, ((this.#state.peakEquity - this.#state.equity) / this.#state.peakEquity) * 100);
  }

  /** Gün dönüşünde (True Day Open) çağrılır. */
  rolloverDay() {
    this.#state.dayStartEquity = this.#state.equity;
    this.#state.dailyPnl = 0;
    if (this.#state.riskLock === 'SOFT_LOCK' || this.#state.riskLock === 'HARD_LOCK') {
      this.#state.riskLock = 'NONE'; // gün sonu kilidi açılır; KILLSWITCH manuel kalır
    }
    this.#persist();
  }

  // --- Strateji versiyonlama (Bölüm 8.3 — her terfi geri alınabilir) ---

  saveStrategyVersion(version, weights, { rollbackOf = null } = {}) {
    this.#state.strategyVersions.push({ version, weights, promotedAt: Date.now(), rollbackOf });
    this.#state.activeStrategyVersion = version;
    this.#persist();
  }

  rollbackStrategy(toVersion) {
    const target = this.#state.strategyVersions.find((v) => v.version === toVersion);
    if (!target) throw new Error(`rollback hedefi bulunamadı: ${toVersion}`);
    this.saveStrategyVersion(`${toVersion}-rollback-${Date.now()}`, target.weights, { rollbackOf: toVersion });
    return target;
  }

  // --- Broker mutabakatı (Bölüm 9 — recovery-from-scratch) ---

  /**
   * Broker'daki gerçek pozisyon/emir durumuyla yerel kayıtları karşılaştırır.
   * Uyuşmazlık listesi döner; boş değilse çağıran işlem yapmadan önce raporlamalıdır.
   */
  reconcile(brokerPositions) {
    const mismatches = [];
    const localIds = new Set(Object.keys(this.#state.positions));
    for (const bp of brokerPositions) {
      const local = this.#state.positions[bp.brokerOrderId];
      if (!local) {
        mismatches.push({ kind: 'UNKNOWN_BROKER_POSITION', position: bp });
      } else if (local.volume !== bp.volume || local.side !== bp.side) {
        mismatches.push({ kind: 'POSITION_DIVERGENCE', local, broker: bp });
      }
      localIds.delete(bp.brokerOrderId);
    }
    for (const orphanId of localIds) {
      mismatches.push({ kind: 'LOCAL_GHOST_POSITION', position: this.#state.positions[orphanId] });
    }
    // Broker gerçeği kazanır: yerel defter broker durumuna eşitlenir.
    this.#state.positions = Object.fromEntries(brokerPositions.map((p) => [p.brokerOrderId, p]));
    this.#persist();
    return mismatches;
  }

  getAuditLog() {
    return [...this.#auditLog];
  }

  #persist() {
    if (!this.#persistPath) return;
    mkdirSync(dirname(this.#persistPath), { recursive: true });
    writeFileSync(this.#persistPath, JSON.stringify(this.#state, null, 2));
  }
}

export default StateManager;
