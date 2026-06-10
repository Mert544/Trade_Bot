/**
 * circuitBreaker.mjs — Omurga bileşeni: Bölüm 6.3 Dayanıklılık.
 *
 * Üç durumu izler:
 *   1. Kaçırılan heartbeat → ajan ÖLÜ
 *   2. Hata oranı eşiği → ajan HASTA
 *   3. Çelişkili çıktı sıklığı → ajan GÜVENİLMEZ
 *
 * Tetiklenen breaker ajanı izole eder ve sistemi önceden tanımlı güvenli
 * davranışa düşürür (fail-safe politikası ajan başına tanımlanır):
 *   Oracle düşerse   → kalıcı ambargo varsayılır
 *   Structurer düşerse → yeni aday üretimi durur
 *   Governor düşerse → sistem tamamen durur (fail-closed)
 *   Sniper düşerse   → pozisyonlar broker tarafı stoplara emanet
 */

import { CONFIG } from '../config/defaults.mjs';

export const AGENT_STATUS = Object.freeze({
  HEALTHY: 'HEALTHY',
  SICK: 'SICK',
  DEAD: 'DEAD',
  UNRELIABLE: 'UNRELIABLE',
  ISOLATED: 'ISOLATED',
});

export class CircuitBreaker {
  #agents = new Map(); // agentId -> { lastHeartbeat, missed, errors, total, contradictions, status, failSafe }
  #onIsolate;
  #config;
  #now;

  constructor({ onIsolate = () => {}, config = CONFIG.heartbeat, now = () => Date.now() } = {}) {
    this.#onIsolate = onIsolate;
    this.#config = config;
    this.#now = now;
  }

  /** Ajanı izlemeye al; failSafe: izolasyonda uygulanacak güvenli davranış etiketi. */
  register(agentId, { failSafe = 'HALT' } = {}) {
    this.#agents.set(agentId, {
      lastHeartbeat: this.#now(),
      missed: 0,
      errors: 0,
      total: 0,
      contradictions: 0,
      status: AGENT_STATUS.HEALTHY,
      failSafe,
    });
  }

  recordHeartbeat(agentId) {
    const agent = this.#agents.get(agentId);
    if (!agent) return;
    agent.lastHeartbeat = this.#now();
    agent.missed = 0;
    if (agent.status === AGENT_STATUS.DEAD) agent.status = AGENT_STATUS.HEALTHY;
  }

  recordResult(agentId, { error = false, contradiction = false } = {}) {
    const agent = this.#agents.get(agentId);
    if (!agent) return;
    agent.total += 1;
    if (error) agent.errors += 1;
    if (contradiction) agent.contradictions += 1;
    if (agent.total >= 10) {
      if (agent.errors / agent.total > this.#config.errorRateThreshold) {
        this.#isolate(agentId, AGENT_STATUS.SICK, 'hata oranı eşiği aşıldı');
      } else if (agent.contradictions / agent.total > this.#config.errorRateThreshold) {
        this.#isolate(agentId, AGENT_STATUS.UNRELIABLE, 'çelişkili çıktı sıklığı');
      }
    }
  }

  /** Periyodik çağrılır (örn. heartbeat aralığında bir). */
  sweep() {
    const now = this.#now();
    for (const [agentId, agent] of this.#agents) {
      if (agent.status === AGENT_STATUS.ISOLATED) continue;
      const elapsed = now - agent.lastHeartbeat;
      agent.missed = Math.floor(elapsed / this.#config.intervalMs);
      if (agent.missed >= this.#config.missThreshold) {
        this.#isolate(agentId, AGENT_STATUS.DEAD, `${agent.missed} heartbeat kaçırıldı`);
      }
    }
  }

  #isolate(agentId, reason, detail) {
    const agent = this.#agents.get(agentId);
    if (agent.status === AGENT_STATUS.ISOLATED) return;
    agent.status = AGENT_STATUS.ISOLATED;
    this.#onIsolate({ agentId, reason, detail, failSafe: agent.failSafe, at: this.#now() });
  }

  status(agentId) {
    return this.#agents.get(agentId)?.status ?? null;
  }

  /** Manuel kurtarma sonrası ajanı yeniden devreye al. */
  reset(agentId) {
    const agent = this.#agents.get(agentId);
    if (!agent) return;
    Object.assign(agent, {
      lastHeartbeat: this.#now(), missed: 0, errors: 0, total: 0,
      contradictions: 0, status: AGENT_STATUS.HEALTHY,
    });
  }
}

export default CircuitBreaker;
