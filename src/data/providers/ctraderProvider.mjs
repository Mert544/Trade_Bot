/**
 * cTrader Open API Sağlayıcısı — F5 (iskelet + yapılandırma katmanı).
 *
 * Hedef mimari: demo hesap üzerinden gerçek bid/ask tick akışı
 * (forex + metal + endeks CFD) — FX hattının tick kalitesine terfisi.
 * Bağlantı: demo.ctraderapi.com:5035 (TLS) üzerinde Protobuf çerçeveleme
 * (4 bayt uzunluk + ProtoMessage zarfı). Sıfır bağımlılık ilkesi gereği
 * protobuf kodlayıcı elle yazılacak (yalnız gereken ~8 mesaj türü).
 *
 * BU SÜRÜMÜN DÜRÜST SINIRI: tel protokolü implementasyonu henüz YOK —
 * geliştirme ortamından 5035 portuna çıkış kapalı olduğundan tel kodu
 * burada doğrulanamaz; doğrulanmamış protokol kodu teslim edilmez
 * ("Tek Adım, Sağlam Adım"). Bu katman şimdilik: kimlik çözümleme,
 * eksik yapılandırma teşhisi ve bağlantı hazırlık denetimi sunar.
 *
 * GEREKLİ KİMLİKLER (cTrader Open API klasik OAuth akışı):
 *   1. CTRADER_CLIENT_ID + CTRADER_CLIENT_SECRET
 *      → https://openapi.ctrader.com → "Applications" → ücretsiz kayıt
 *   2. CTRADER_ACCESS_TOKEN  → aynı portalda "Playground" ile demo
 *      hesabına erişim izni verilince üretilir (veya paylaşılan
 *      cTrader ID token'ı — CTRADER_TOKEN_B64 olarak çözümlenir)
 *   3. CTRADER_ACCOUNT_ID    → ctidTraderAccountId (Playground'da görünür)
 */

export class CTraderProvider {
  #config;
  #logger;

  constructor({
    tokenB64 = process.env.CTRADER_TOKEN_B64,
    clientId = process.env.CTRADER_CLIENT_ID,
    clientSecret = process.env.CTRADER_CLIENT_SECRET,
    accessToken = process.env.CTRADER_ACCESS_TOKEN,
    accountId = process.env.CTRADER_ACCOUNT_ID,
    logger = console,
  } = {}) {
    this.#logger = logger;
    const decoded = CTraderProvider.decodeTokenBlob(tokenB64);
    this.#config = {
      clientId,
      clientSecret,
      // Açık env değişkeni öncelikli; yoksa blob'daki token kullanılır
      accessToken: accessToken ?? decoded?.token ?? null,
      accountId,
      environment: decoded?.environment ?? 'demo',
      plant: decoded?.plant ?? null,
      host: (decoded?.environment ?? 'demo') === 'live' ? 'live.ctraderapi.com' : 'demo.ctraderapi.com',
      port: 5035,
    };
  }

  /** cTrader uygulamalarının paylaştığı base64 kimlik blob'unu çözer. */
  static decodeTokenBlob(blob) {
    if (!blob) return null;
    try {
      const parsed = JSON.parse(Buffer.from(blob, 'base64').toString('utf8'));
      return typeof parsed === 'object' && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }

  get name() { return 'ctrader'; }

  /**
   * Yapılandırma teşhisi: neyin hazır, neyin eksik olduğunu raporlar.
   * Tel protokolü geldiğinde start() bu denetimi geçmeden bağlanmayacak.
   */
  readiness() {
    const c = this.#config;
    const missing = [];
    if (!c.clientId) missing.push('CTRADER_CLIENT_ID (openapi.ctrader.com → Applications)');
    if (!c.clientSecret) missing.push('CTRADER_CLIENT_SECRET');
    if (!c.accessToken) missing.push('CTRADER_ACCESS_TOKEN (veya CTRADER_TOKEN_B64)');
    if (!c.accountId) missing.push('CTRADER_ACCOUNT_ID (ctidTraderAccountId)');
    return {
      ready: missing.length === 0,
      missing,
      environment: c.environment,
      plant: c.plant,
      endpoint: `${c.host}:${c.port}`,
      hasToken: Boolean(c.accessToken),
    };
  }

  start() {
    const r = this.readiness();
    if (!r.ready) {
      this.#logger.info(`[ctrader] beklemede — eksik: ${r.missing.join(' · ')}`
        + (r.hasToken ? ` (token hazır: ${r.plant ?? '?'} ${r.environment})` : ''));
      return false;
    }
    this.#logger.warn('[ctrader] kimlikler tam — tel protokolü (protobuf) bir sonraki '
      + 'sürümde bağlanacak; FX hattı o zamana dek Twelve Data barlarıyla sürer');
    return false;
  }

  stop() {}
}

export default CTraderProvider;
