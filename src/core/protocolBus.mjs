/**
 * Faz 0 — Protokol Çekirdeği (Ek B.1).
 *
 * eventBus üzerine bina edilen ince sözleşme katmanı (envelope doğrulayıcı).
 * Sorumlulukları:
 *   1. Zarf şema doğrulaması — geçersiz zarflı mesaj bus'a giremez.
 *   2. TTL denetimi — TTL'i dolan mesaj abonelere ulaşmaz; sayaç telemetriye işlenir.
 *   3. correlationId üretimi/aktarımı — zincir kırılmadan taşınır.
 *   4. Olay türü beyaz listesi (Ek A) — katalog dışı tür reddedilir.
 *
 * Mevcut eventBus API'sine dokunulmaz; bu katman onu SARAR.
 */

import { EventBus } from './eventBus.mjs';
import { createEnvelope, validateEnvelope, isExpired } from './envelope.mjs';

export class ProtocolViolationError extends Error {
  constructor(errors, envelope) {
    super(`Protokol ihlali: ${errors.join('; ')}`);
    this.name = 'ProtocolViolationError';
    this.errors = errors;
    this.envelope = envelope;
  }
}

export class ProtocolBus {
  /** Telemetri sayaçları (Ek D — karar hattı sağlığı) */
  telemetry = {
    published: 0,
    rejectedInvalid: 0,
    droppedExpired: 0,
    deliveryFailures: 0,
    rejectionsByType: {},
  };

  #bus;
  #logger;
  #now;

  constructor({ bus = new EventBus(), logger = console, now = () => Date.now() } = {}) {
    this.#bus = bus;
    this.#logger = logger;
    this.#now = now;
  }

  /**
   * Zarf alanlarından doğrulanmış zarf üretip yayınlar.
   * Geçersiz zarf bus'a yayınlanamaz; doğrulayıcı gerekçeli hata loglar ve fırlatır.
   */
  async publish(fields) {
    const envelope = createEnvelope({ timestamp: this.#now(), ...fields });
    return this.publishEnvelope(envelope);
  }

  /** Hazır zarf yayınlar (türev olaylar / yeniden yayın için). */
  async publishEnvelope(envelope) {
    const now = this.#now();
    const { valid, errors } = validateEnvelope(envelope, { now });
    if (!valid) {
      this.telemetry.rejectedInvalid += 1;
      const typeKey = envelope?.type ?? 'UNKNOWN';
      this.telemetry.rejectionsByType[typeKey] = (this.telemetry.rejectionsByType[typeKey] ?? 0) + 1;
      this.#logger.error(`[protocolBus] REJECTED ${typeKey}: ${errors.join('; ')}`);
      throw new ProtocolViolationError(errors, envelope);
    }
    this.telemetry.published += 1;
    const result = await this.#bus.publish(envelope);
    this.telemetry.deliveryFailures += result.failed;
    return { envelope, ...result };
  }

  /**
   * Aboneliği TTL bekçisiyle sarar: teslim anında TTL'i dolmuş mesaj
   * aboneye ulaşmaz, düşürülen mesaj sayacı telemetriye işlenir.
   */
  subscribe(type, handler) {
    return this.#bus.subscribe(type, (envelope) => {
      if (isExpired(envelope, this.#now())) {
        this.telemetry.droppedExpired += 1;
        this.#logger.warn(`[protocolBus] DROPPED expired ${envelope.type} (msgId=${envelope.msgId})`);
        return undefined;
      }
      return handler(envelope);
    });
  }

  getTelemetry() {
    return structuredClone(this.telemetry);
  }
}

export default ProtocolBus;
