/**
 * ICT Bot V5 — Ekosistem Bootstrap.
 *
 * Tüm katmanları omurga bileşenleri etrafında bağlar:
 *   protocolBus (Faz 0) → Oracle (Faz 1) → Governor (Faz 2) →
 *   Sanitizer + Structurer (Faz 3) → Sniper + ShadowLedger (Faz 4)
 *
 * Varsayılan mod GÖLGE'dir (Kademeli Evrim ilkesi): canlı sermaye, ancak
 * gölge defteri Monte Carlo kapısından geçtiğinde devreye girer.
 */

import { CONFIG } from './config/defaults.mjs';
import { EventBus } from './core/eventBus.mjs';
import { ProtocolBus } from './core/protocolBus.mjs';
import { StateManager } from './core/stateManager.mjs';
import { CircuitBreaker } from './core/circuitBreaker.mjs';
import { Oracle } from './agents/oracle.mjs';
import { Governor } from './agents/governor.mjs';
import { Structurer } from './agents/structurer.mjs';
import { Sniper } from './agents/sniper.mjs';
import { Sanitizer } from './data/sanitizer.mjs';
import { RegimeDetector } from './perception/regimeDetector.mjs';
import { DecisionCoordinator } from './coordination/decisionCoordinator.mjs';
import { ShadowLedger } from './shadow/shadowLedger.mjs';
import { PaperBroker } from './execution/brokerInterface.mjs';
import { SignalHub } from './signals/signalHub.mjs';

export function createEcosystem({
  mode = process.env.ICT_MODE ?? 'shadow',
  calendarProvider = { fetchToday: async () => { throw new Error('takvim sağlayıcısı yapılandırılmadı'); } },
  broker = null,
  persistPath = null,
  logger = console,
  now = () => Date.now(),
} = {}) {
  const rawBus = new EventBus();
  const bus = new ProtocolBus({ bus: rawBus, logger, now });
  const stateManager = new StateManager({ persistPath });

  // Gölge mod varsayılandır; canlı broker yalnızca açıkça enjekte edilir.
  const executionBroker = mode === 'live' && broker ? broker : new PaperBroker();

  const circuitBreaker = new CircuitBreaker({
    now,
    onIsolate: async ({ agentId, reason, detail, failSafe }) => {
      logger.error(`[circuitBreaker] ${agentId} İZOLE EDİLDİ (${reason}: ${detail}) → güvenli davranış: ${failSafe}`);
      // Bölüm 6.3 fail-safe politikaları
      if (agentId === 'governor') {
        // Governor düşerse sistem tamamen durur (fail-closed)
        await bus.publish({
          type: 'KILLSWITCH', source: 'circuitBreaker', version: '1.0.0',
          payload: { level: 'K3', trigger: `governor izole: ${detail}`, scope: 'SYSTEM' },
          evidence: [`Fail-closed: Governor olmadan risk denetimi yok`],
          ttlMs: 60_000, timestamp: now(),
        });
        stateManager.set('riskLock', 'KILLSWITCH', { source: 'circuitBreaker' });
      } else if (agentId === 'oracle') {
        // Oracle düşerse kalıcı ambargo varsayılır
        stateManager.set('embargo', { active: true, eventName: 'ORACLE_DOWN', windowEnd: null }, { source: 'circuitBreaker' });
      }
    },
  });

  const oracle = new Oracle({ bus, calendarProvider, now, logger });
  const governor = new Governor({ bus, stateManager, now, logger });
  const structurer = new Structurer({ bus, now });
  const sniper = new Sniper({ bus, broker: executionBroker, now, logger });
  const sanitizer = new Sanitizer({ bus, now });
  const regimeDetector = new RegimeDetector({ bus, now });
  const coordinator = new DecisionCoordinator({ bus, now });
  const signalHub = new SignalHub({ bus, stateManager, now, logger });

  // Gölge defter geri besleme döngüsü: kapanan sanal işlem → PnL muhasebesi →
  // drawdown makinesi → lot streak → sinyal sonucu. Bu döngü olmadan Governor
  // hiç gerçekleşmiş sonuç görmez (yapısal boşluktu, burada kapanıyor).
  const shadowLedger = new ShadowLedger({
    now,
    onClose: async (trade) => {
      stateManager.recordPnl(trade.netPnl, { source: 'shadowLedger', correlationId: trade.correlationId });
      governor.recordTradeOutcome(trade.netPnl);
      signalHub.recordOutcome(trade);
      await governor.assessRiskState();
    },
    onHypothetical: (rec) => {
      signalHub.recordHypothetical(rec.correlationId, rec.hypothetical.outcome);
    },
  });

  // Omurga abonelikleri: stateManager olay akışından beslenir (tek gerçeklik kaynağı)
  bus.subscribe('KILLZONE_STATE', (env) => {
    stateManager.set('killzone', env.payload, { source: 'oracle', correlationId: env.correlationId });
  });
  bus.subscribe('REGIME_UPDATE', (env) => {
    stateManager.set(`regime.${env.payload.symbol}`, {
      regime: env.payload.regime, score: env.payload.score, updatedAt: env.timestamp,
    }, { source: 'perception', correlationId: env.correlationId });
  });
  bus.subscribe('BIAS_UPDATE', (env) => {
    stateManager.set(`bias.${env.payload.symbol}`, {
      htfBias: env.payload.htfBias, dolLevel: env.payload.dolLevel, updatedAt: env.timestamp,
    }, { source: 'structurer', correlationId: env.correlationId });
  });
  // Gölge defter: reddedilen adayların akıbeti = veto isabet ölçümü
  const candidateCache = new Map();
  const approvalCache = new Map(); // candidateId -> lotSize
  bus.subscribe('SETUP_CANDIDATE', (env) => candidateCache.set(env.msgId, env));
  bus.subscribe('RISK_APPROVAL', (env) => approvalCache.set(env.payload.candidateId, env.payload.lotSize));
  bus.subscribe('RISK_VETO', (env) => {
    const candidateEnv = candidateCache.get(env.payload.candidateId);
    if (candidateEnv) shadowLedger.recordRejection(candidateEnv, env.payload.vetoReason);
  });
  // Fill → sanal pozisyon: fiyat akışı stop/hedefi vurduğunda onClose döngüsü kapanır
  bus.subscribe('ORDER_FILLED', (env) => {
    const candidateEnv = candidateCache.get(env.payload.candidateId);
    const lotSize = approvalCache.get(env.payload.candidateId) ?? 1;
    if (candidateEnv) shadowLedger.openVirtual(candidateEnv, { lotSize });
  });
  bus.subscribe('HEARTBEAT', (env) => circuitBreaker.recordHeartbeat(env.payload.agentId));

  // Heartbeat kayıtları + fail-safe etiketleri (Bölüm 6.3)
  circuitBreaker.register('oracle', { failSafe: 'PERMANENT_EMBARGO' });
  circuitBreaker.register('structurer', { failSafe: 'NO_NEW_CANDIDATES' });
  circuitBreaker.register('governor', { failSafe: 'FAIL_CLOSED_HALT' });
  circuitBreaker.register('sniper', { failSafe: 'BROKER_SIDE_STOPS' });

  return {
    config: CONFIG,
    mode,
    bus,
    rawBus,
    stateManager,
    circuitBreaker,
    oracle,
    governor,
    structurer,
    sniper,
    sanitizer,
    regimeDetector,
    coordinator,
    shadowLedger,
    signalHub,
    broker: executionBroker,

    async start() {
      governor.start();
      structurer.start();
      sniper.start();
      coordinator.start();
      signalHub.start();
      await oracle.syncCalendar();
      oracle.start();
      logger.info(`[ict-bot] V5 ekosistemi ${mode.toUpperCase()} modunda başladı (semboller: ${CONFIG.symbols.watchlist.join(', ')})`);
    },

    stop() {
      oracle.stop();
      governor.stop();
      structurer.stop();
      sniper.stop();
      coordinator.stop();
      signalHub.stop();
    },
  };
}

// Doğrudan çalıştırma: gölge modda boot
if (import.meta.url === `file://${process.argv[1]}`) {
  const eco = createEcosystem({});
  eco.start().catch((err) => {
    console.error(`[ict-bot] başlatma hatası: ${err.message}`);
    process.exit(1);
  });
}

export default createEcosystem;
