/**
 * Ek A — Olay Kataloğu (Event Catalog).
 *
 * eventBus üzerinde dolaşmasına izin verilen olay türlerinin KAPALI listesi.
 * Katalogda olmayan olay türü kodda var olamaz; yeni tür eklemek
 * anayasa (V5 dokümanı) revizyonu gerektirir.
 *
 * requiredPayload: zarfın payload alanında bulunması zorunlu çekirdek alanlar.
 */

export const EVENT_CATALOG = Object.freeze({
  // --- Oracle ---
  EMBARGO_ON: { publisher: 'oracle', requiredPayload: ['eventName', 'impact', 'windowStart', 'windowEnd'] },
  EMBARGO_OFF: { publisher: 'oracle', requiredPayload: ['eventName', 'impact', 'windowStart', 'windowEnd'] },
  KILLZONE_STATE: { publisher: 'oracle', requiredPayload: ['zone', 'active', 'trueDayOpen'] },
  NEWS_SWEEP_TAG: { publisher: 'oracle', requiredPayload: ['symbol', 'direction', 'sweptLevel', 'confirmedAt'] },

  // --- Algı Katmanı ---
  REGIME_UPDATE: { publisher: 'perception', requiredPayload: ['symbol', 'regime', 'score'] },

  // --- Structurer ---
  BIAS_UPDATE: { publisher: 'structurer', requiredPayload: ['symbol', 'htfBias', 'dolLevel', 'tf'] },
  SETUP_CANDIDATE: {
    publisher: 'structurer',
    requiredPayload: ['symbol', 'side', 'entry', 'stop', 'targets', 'setupFamily', 'confidence', 'evidence'],
  },
  STRUCTURE_INVALIDATED: { publisher: 'structurer', requiredPayload: ['symbol', 'reason', 'invalidatedCandidates'] },

  // --- Müzakere ---
  OBJECTION: { publisher: '*', requiredPayload: ['candidateId', 'verdict', 'reason', 'confidence'] },
  ENDORSE: { publisher: '*', requiredPayload: ['candidateId', 'verdict', 'reason', 'confidence'] },

  // --- Governor ---
  RISK_APPROVAL: { publisher: 'governor', requiredPayload: ['candidateId', 'lotSize', 'maxSlippage', 'ttl'] },
  RISK_VETO: { publisher: 'governor', requiredPayload: ['candidateId', 'vetoReason'] },
  KILLSWITCH: { publisher: '*', requiredPayload: ['level', 'trigger', 'scope'] },

  // --- Sniper ---
  ORDER_SUBMITTED: { publisher: 'sniper', requiredPayload: ['candidateId', 'requestedPrice'] },
  ORDER_FILLED: { publisher: 'sniper', requiredPayload: ['candidateId', 'brokerOrderId', 'requestedPrice', 'fillPrice', 'latencyMs'] },
  EXECUTION_REPORT: { publisher: 'sniper', requiredPayload: ['candidateId', 'slippage', 'spreadAtFill', 'costTotal'] },
  SLIPPAGE_ALERT: { publisher: 'sniper', requiredPayload: ['candidateId', 'slippage'] },

  // --- Veri Katmanı ---
  DATA_QUARANTINE: { publisher: 'dataLayer', requiredPayload: ['source', 'symbol', 'reason', 'sample'] },
  FEED_STALE: { publisher: 'dataLayer', requiredPayload: ['source', 'symbol', 'reason'] },

  // --- Dayanıklılık ---
  HEARTBEAT: { publisher: '*', requiredPayload: ['agentId', 'version', 'status'] },

  // --- Meta-Biliş ---
  TRADE_POSTMORTEM: {
    publisher: 'metacognition',
    requiredPayload: ['correlationId', 'outcome', 'rootCause', 'counterfactuals', 'weightDeltas'],
  },
});

export const EVENT_TYPES = Object.freeze(Object.keys(EVENT_CATALOG));

export function isKnownEventType(type) {
  return Object.prototype.hasOwnProperty.call(EVENT_CATALOG, type);
}

export default EVENT_CATALOG;
