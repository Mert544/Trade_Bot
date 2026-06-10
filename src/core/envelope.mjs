/**
 * Bölüm 6.1 — Standart Mesaj Zarfı (Message Envelope).
 *
 * eventBus üzerinden akan her mesaj, istisnasız aynı zarf şemasını taşır.
 * Zarf doğrulaması Faz 0 sözleşme katmanının (protocolBus) kalbidir.
 */

import { randomUUID } from 'node:crypto';
import { EVENT_CATALOG, isKnownEventType } from './eventCatalog.mjs';

/**
 * Yeni bir zarf üretir. correlationId verilmezse yeni zincir başlatılır;
 * verilirse (türev olay) zincir kırılmadan taşınır.
 */
export function createEnvelope({
  type,
  source,
  version = '1.0.0',
  payload = {},
  confidence = 1.0,
  evidence = [],
  ttlMs = 60_000,
  correlationId = null,
  timestamp = Date.now(),
}) {
  return {
    msgId: randomUUID(),
    correlationId: correlationId ?? randomUUID(),
    type,
    source,
    version,
    timestamp,
    ttl: ttlMs,
    confidence,
    payload,
    evidence,
  };
}

const REQUIRED_FIELDS = ['msgId', 'correlationId', 'type', 'source', 'version', 'timestamp', 'ttl', 'confidence', 'payload', 'evidence'];

/**
 * Zarfı şemaya, olay kataloğuna ve TTL'e karşı doğrular.
 * Dönüş: { valid, errors[] } — fırlatmaz; çağıran gerekçeli loglar.
 */
export function validateEnvelope(envelope, { now = Date.now() } = {}) {
  const errors = [];

  if (envelope === null || typeof envelope !== 'object') {
    return { valid: false, errors: ['envelope nesne değil'] };
  }

  for (const field of REQUIRED_FIELDS) {
    if (!(field in envelope) || envelope[field] === undefined || envelope[field] === null) {
      errors.push(`eksik alan: ${field}`);
    }
  }
  if (errors.length > 0) return { valid: false, errors };

  if (typeof envelope.type !== 'string' || !isKnownEventType(envelope.type)) {
    errors.push(`olay türü katalogda yok (Ek A): ${envelope.type}`);
  }
  if (typeof envelope.source !== 'string' || envelope.source.length === 0) {
    errors.push('source boş olamaz');
  }
  if (typeof envelope.timestamp !== 'number' || !Number.isFinite(envelope.timestamp)) {
    errors.push('timestamp sayısal değil');
  }
  if (typeof envelope.ttl !== 'number' || envelope.ttl <= 0) {
    errors.push('ttl pozitif sayı olmalı');
  }
  if (typeof envelope.confidence !== 'number' || envelope.confidence < 0 || envelope.confidence > 1) {
    errors.push('confidence 0-1 aralığında olmalı');
  }
  if (!Array.isArray(envelope.evidence)) {
    errors.push('evidence dizi olmalı (insan-okunur kanıt listesi)');
  }
  if (typeof envelope.payload !== 'object') {
    errors.push('payload nesne olmalı');
  }

  // TTL denetimi: bayat sinyal koruması protokol seviyesindedir.
  if (typeof envelope.timestamp === 'number' && typeof envelope.ttl === 'number'
    && now > envelope.timestamp + envelope.ttl) {
    errors.push(`TTL dolmuş: yaş ${now - envelope.timestamp}ms > ttl ${envelope.ttl}ms`);
  }

  // Türe özgü payload çekirdeği (Ek A)
  const catalogEntry = EVENT_CATALOG[envelope.type];
  if (catalogEntry && envelope.payload && typeof envelope.payload === 'object') {
    for (const field of catalogEntry.requiredPayload) {
      if (!(field in envelope.payload)) {
        errors.push(`payload çekirdek alanı eksik (${envelope.type}): ${field}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function isExpired(envelope, now = Date.now()) {
  return now > envelope.timestamp + envelope.ttl;
}

/** Türev olay üretirken nedensellik zincirini taşır. */
export function deriveEnvelope(parentEnvelope, fields) {
  return createEnvelope({ ...fields, correlationId: parentEnvelope.correlationId });
}
