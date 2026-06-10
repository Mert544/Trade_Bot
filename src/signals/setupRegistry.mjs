/**
 * Setup Kayıt Defteri — aile tanımları (setup bazlı gelişim disiplini).
 *
 * "Tek Adım, Sağlam Adım" ilkesi: yeni aile eklemek = bu dosyada tanım +
 * mtfEngine'de tarayıcı + yeterli örnek birikene kadar gölge izleme.
 * Tanımsız setupFamily ile sinyal üretilemez (Structurer payload denetimine
 * ek belge niteliğinde tek gerçek kaynak).
 */

export const SETUP_REGISTRY = Object.freeze({
  SWEEP_MSS_FVG: {
    description: 'Likidite süpürmesi → MSS teyidi → FVG geri testi (reversal ailesi)',
    direction: 'reversal',
    preconditions: [
      '4H bias yönlü ve süpürülmemiş DOL hedefi var',
      '15M MMXM fazı MANIPULATION veya DISTRIBUTION (bias ile hizalı)',
      '3m: havuz süpürmesi + kapanışla MSS + asgari boyutlu FVG',
      'Aktif killzone (dışındakiler gözlem grubuna düşer)',
    ],
    qualityComponents: ['sweepDepthPct', 'poolStrength', 'fvgSizePct', 'mssToFvgBars', 'phase', 'regime', 'killzone'],
    preferredRegimes: ['RANGE', 'HIGH_VOL'], // sweep-reversal yatay/oynak rejimde güçlü (HRL ön bilgisi)
  },

  // Gelecek aile adayları (henüz tarayıcısı YOK — önce SWEEP_MSS_FVG örneklem doldurmalı):
  // FVG_RETEST: continuation ailesi, TREND rejiminde; NEWS_SWEEP_REVERSAL: Oracle NEWS_SWEEP_TAG tetikli.
});

export function describeSetup(family) {
  return SETUP_REGISTRY[family] ?? null;
}

export default SETUP_REGISTRY;
