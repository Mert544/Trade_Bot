/**
 * eventBus.mjs — Omurga bileşeni: ajanlar arası TEK iletişim kanalı.
 *
 * İlke (Bölüm 6): ajanlar fonksiyon çağırmaz, olay yayınlar (publish/subscribe).
 * Hiçbir ajan diğerinin varlığını bilmek zorunda değildir; yalnızca mesaj
 * sözleşmesini bilir. Bu sınıf ham taşıyıcıdır; sözleşme (zarf doğrulama,
 * TTL, beyaz liste) protocolBus sarmalayıcısında uygulanır (Faz 0, Ek B.1).
 */

export class EventBus {
  #subscribers = new Map(); // type -> Set<handler>
  #wildcardSubscribers = new Set(); // tüm olayları dinleyenler (telemetri, arşiv)

  /**
   * @param {string} type Olay türü ('*' = tümü)
   * @param {(envelope: object) => void|Promise<void>} handler
   * @returns {() => void} abonelik iptal fonksiyonu
   */
  subscribe(type, handler) {
    if (typeof handler !== 'function') throw new TypeError('handler fonksiyon olmalı');
    if (type === '*') {
      this.#wildcardSubscribers.add(handler);
      return () => this.#wildcardSubscribers.delete(handler);
    }
    if (!this.#subscribers.has(type)) this.#subscribers.set(type, new Set());
    this.#subscribers.get(type).add(handler);
    return () => this.#subscribers.get(type)?.delete(handler);
  }

  /**
   * Olayı tüm abonelere asenkron dağıtır. Bir abonenin hatası diğerlerini
   * durdurmaz (Asenkron Bağımsızlık ilkesi); hata sayaçları döner.
   */
  async publish(envelope) {
    const handlers = [
      ...(this.#subscribers.get(envelope.type) ?? []),
      ...this.#wildcardSubscribers,
    ];
    const results = await Promise.allSettled(handlers.map(async (h) => h(envelope)));
    const failures = results.filter((r) => r.status === 'rejected');
    return { delivered: handlers.length - failures.length, failed: failures.length, failures };
  }

  subscriberCount(type) {
    return (this.#subscribers.get(type)?.size ?? 0) + this.#wildcardSubscribers.size;
  }

  clear() {
    this.#subscribers.clear();
    this.#wildcardSubscribers.clear();
  }
}

export default EventBus;
