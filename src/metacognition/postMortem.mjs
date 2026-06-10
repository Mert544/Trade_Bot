/**
 * Bölüm 8.2 — Nedensel Post-Mortem Taksonomisi (v1).
 *
 * Her kapanan gölge işlem dört kök neden sınıfından birine atanır:
 *   MAKRO_KARSITLIGI — bias'a/bağlama karşı girilmiş (veya bias işlem
 *                      sırasında dönmüş)
 *   SAHTE_SUPURME    — likidite alımı sanılan hareket zayıf kanıtlıydı
 *   ZAMANLAMA_HATASI — kurulum doğru, giriş TTL'e göre geç
 *   ICRA_MALIYETI    — sinyal kârlıydı ama maliyet yedi
 *
 * v1 SINIRI: atama sezgisel eşiklerle yapılır ve weightDeltas HER ZAMAN
 * boştur — örnek eşiği (sampleTiers.floor) dolmadan hiçbir parametre
 * değişmez (anayasa 8.3). Karşı-olgusal tekrar oynatma (counterfactuals)
 * sonraki fazda; bu sürüm yalnızca veri biriktirir.
 */

export const ROOT_CAUSE = Object.freeze({
  NONE: 'NONE',                        // kazanç — otopsi kaydı yine tutulur
  MAKRO_KARSITLIGI: 'MAKRO_KARSITLIGI',
  SAHTE_SUPURME: 'SAHTE_SUPURME',
  ZAMANLAMA_HATASI: 'ZAMANLAMA_HATASI',
  ICRA_MALIYETI: 'ICRA_MALIYETI',
  SINIFLANDIRILMADI: 'SINIFLANDIRILMADI',
});

const DEFAULTS = {
  weakSweepDepthPct: 0.08, // bunun altı sweep derinliği "zayıf kanıt"
  weakPoolStrength: 1,     // tek dokunuşlu havuz = zayıf likidite kanıtı
  lateFillRatio: 0.75,     // sinyal yaşı / TTL bu oranı aşarak dolduysa geç giriş
  costRatio: 0.5,          // |komisyon+maliyet| / |brüt| bu oranı aşarsa maliyet sorunu
};

/**
 * @param {object} args
 * @param {object} args.trade   Gölge defter kapanış kaydı (outcome, netPnl, grossPnl, commission, side, openedAt)
 * @param {object|null} args.candidate SETUP_CANDIDATE zarfı (quality, timestamp) — bulunamayabilir
 * @param {string|null} args.biasNow   Kapanış anındaki 4H bias (stateManager'dan)
 * @param {number} args.ttlMs   Sinyal TTL'i
 * @returns {{ rootCause, diagnosis }}
 */
export function classifyPostMortem({ trade, candidate = null, biasNow = null, ttlMs = 90_000, thresholds = {} }) {
  const t = { ...DEFAULTS, ...thresholds };

  if (trade.outcome === 'WIN') {
    return { rootCause: ROOT_CAUSE.NONE, diagnosis: 'kazanç — kanıt bileşenleri arşivlendi' };
  }

  // 1) Makro karşıtlığı: kapanış anındaki bias işlem yönüyle çelişiyor
  const expectedBias = trade.side === 'BUY' ? 'LONG_BIAS' : 'SHORT_BIAS';
  if (biasNow !== null && biasNow !== expectedBias) {
    return {
      rootCause: ROOT_CAUSE.MAKRO_KARSITLIGI,
      diagnosis: `kapanışta bias ${biasNow}, işlem yönü ${trade.side} — bağlam işlem sırasında döndü`,
    };
  }

  const quality = candidate?.payload?.quality ?? {};

  // 2) Sahte süpürme: sweep kanıtı zayıftı
  if ((quality.sweepDepthPct !== undefined && quality.sweepDepthPct < t.weakSweepDepthPct)
    || (quality.poolStrength !== undefined && quality.poolStrength <= t.weakPoolStrength)) {
    return {
      rootCause: ROOT_CAUSE.SAHTE_SUPURME,
      diagnosis: `zayıf sweep kanıtı: derinlik %${quality.sweepDepthPct ?? '?'}, havuz gücü ${quality.poolStrength ?? '?'}`,
    };
  }

  // 3) Zamanlama: fill, sinyal doğumuna göre TTL'in sonuna yakın geldi
  if (candidate && trade.openedAt) {
    const ageAtFill = trade.openedAt - candidate.timestamp;
    if (ageAtFill > ttlMs * t.lateFillRatio) {
      return {
        rootCause: ROOT_CAUSE.ZAMANLAMA_HATASI,
        diagnosis: `geç giriş: sinyal yaşı ${ageAtFill}ms / TTL ${ttlMs}ms (eşik %${t.lateFillRatio * 100})`,
      };
    }
  }

  // 4) İcra maliyeti: brüt küçük kayıp/kazançken maliyet sonucu belirledi
  const gross = Math.abs(trade.grossPnl ?? 0);
  const costs = Math.abs((trade.commission ?? 0));
  if (gross > 0 && costs / gross > t.costRatio) {
    return {
      rootCause: ROOT_CAUSE.ICRA_MALIYETI,
      diagnosis: `maliyet/brüt oranı ${(costs / gross).toFixed(2)} > ${t.costRatio}`,
    };
  }

  return {
    rootCause: ROOT_CAUSE.SINIFLANDIRILMADI,
    diagnosis: 'kayıp mevcut sezgisel eşiklerin hiçbirine uymadı — stop normal çalışmış olabilir',
  };
}

export default classifyPostMortem;
