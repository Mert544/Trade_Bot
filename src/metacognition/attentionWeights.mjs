/**
 * Bölüm 7.3 — Dikkat Ağırlığı Modeli (öğrenen güven skoru).
 *
 * Kalite bileşen vektörü → P(kazanç) eşlemesi: L2 düzenlileştirmeli lojistik
 * regresyon (bağımlılıksız, ~60 satır). Derin ağ DEĞİL — bilinçli tercih:
 * örneklem yüzlerle ölçülürken parametre sayısı düşük tutulur, aksi overfit
 * makinesidir. Model "dikkat"i bileşen ağırlıklarıyla temsil eder: hangi
 * kanıt bileşeni kazançla ne kadar ilişkili?
 *
 * TERFİ DİSİPLİNİ (anayasa 7.3 + 8.3):
 *   1. Örnek eşiği: tiers.validation altında eğitim bile yapılmaz.
 *   2. Purged K-Fold: CV ortalama doğruluğu saf taban oranını (çoğunluk
 *      sınıfı) anlamlı geçmeli; min fold skoru taban altına düşmemeli.
 *   3. Terfi edilmemiş model SABİT ÖNSEL döner (0.6) — canlı davranış
 *      değişmez. Öğrenme "sessizce" devreye giremez.
 */

import { runPurgedCV } from './purgedKFold.mjs';

/** Kalite vektörünü sabit sıralı sayısal özniteliklere kodlar. */
export function encodeQuality(q = {}) {
  return [
    Math.min(2, (q.sweepDepthNorm ?? q.sweepDepthPct ?? 0)),  // 0-2 bandı
    Math.min(5, q.poolStrength ?? 0) / 5,
    Math.min(2, q.fvgSizePct ?? 0),
    Math.min(10, q.mssToFvgBars ?? 0) / 10,
    q.pdAligned ? 1 : 0,        // PREMIUM'da satış / DISCOUNT'ta alış
    q.oteHit ? 1 : 0,           // giriş OTE bölgesinde
    q.obConfluence ? 1 : 0,     // FVG ∩ OrderBlock
    q.po3Aligned ? 1 : 0,       // PO3 beklenen teslim yönü ile uyum
    q.smtDivergent ? 1 : 0,     // korele eş süpürmedi (SMT teyidi)
    q.phase === 'MANIPULATION' ? 1 : 0,
    q.regime === 'RANGE' || q.regime === 'HIGH_VOL' ? 1 : 0, // sweep-reversal dostu rejim
  ];
}

export const FEATURE_NAMES = [
  'sweepDepth', 'poolStrength', 'fvgSize', 'mssToFvgBars',
  'pdAligned', 'oteHit', 'obConfluence', 'po3Aligned', 'smtDivergent',
  'phaseManipulation', 'regimeFit',
];

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

export class AttentionModel {
  weights = null;   // null = terfi edilmemiş (önsel kullanılır)
  bias = 0;
  promoted = false;
  metrics = null;

  #config;

  constructor({ basePrior = 0.6, lr = 0.1, epochs = 300, l2 = 0.05 } = {}) {
    this.#config = { basePrior, lr, epochs, l2 };
  }

  /** Canlı güven skoru: terfi yoksa sabit önsel (davranış değişmez). */
  score(quality) {
    if (!this.promoted || !this.weights) return this.#config.basePrior;
    const x = encodeQuality(quality);
    const z = this.bias + x.reduce((s, xi, i) => s + xi * this.weights[i], 0);
    return sigmoid(z);
  }

  /** Saf eğitim (CV içinde de kullanılır). records: { quality, outcome: 1|0 } */
  static fit(records, { lr = 0.1, epochs = 300, l2 = 0.05 } = {}) {
    const X = records.map((r) => encodeQuality(r.quality));
    const y = records.map((r) => r.outcome);
    const dim = X[0]?.length ?? 0;
    let w = new Array(dim).fill(0);
    let b = 0;
    const n = X.length;
    for (let e = 0; e < epochs; e += 1) {
      let gb = 0;
      const gw = new Array(dim).fill(0);
      for (let i = 0; i < n; i += 1) {
        const err = sigmoid(b + X[i].reduce((s, xi, j) => s + xi * w[j], 0)) - y[i];
        gb += err;
        for (let j = 0; j < dim; j += 1) gw[j] += err * X[i][j];
      }
      b -= lr * (gb / n);
      for (let j = 0; j < dim; j += 1) {
        w[j] -= lr * (gw[j] / n + l2 * w[j]); // L2: ağırlıkları sıfıra çeker
      }
    }
    return { weights: w, bias: b };
  }

  /**
   * Journal kayıtlarından eğitim + purged K-Fold doğrulama + terfi kararı.
   * @param {Array<{ quality, outcome: 'WIN'|'LOSS' }>} samples ZAMAN SIRALI
   * @param {{ validation: number }} tiers Örnek eşiği
   * @returns {{ promoted, reason, metrics }}
   */
  trainWithValidation(samples, { tiers = { validation: 100 }, k = 5, purge = 5, minLift = 0.02 } = {}) {
    const records = samples
      .filter((s) => s.outcome === 'WIN' || s.outcome === 'LOSS')
      .map((s) => ({ quality: s.quality ?? {}, outcome: s.outcome === 'WIN' ? 1 : 0 }));

    if (records.length < tiers.validation) {
      return {
        promoted: false,
        reason: `örnek yetersiz: ${records.length} < ${tiers.validation} (doğrulama eşiği)`,
        metrics: { samples: records.length },
      };
    }

    // Taban oran: çoğunluk sınıfı doğruluğu — modelin geçmesi gereken çıta
    const winRate = records.reduce((s, r) => s + r.outcome, 0) / records.length;
    const baseline = Math.max(winRate, 1 - winRate);

    const cv = runPurgedCV(
      records,
      (train) => AttentionModel.fit(train, this.#config),
      (model, test) => {
        let correct = 0;
        for (const r of test) {
          const x = encodeQuality(r.quality);
          const p = sigmoid(model.bias + x.reduce((s, xi, j) => s + xi * model.weights[j], 0));
          if ((p >= 0.5 ? 1 : 0) === r.outcome) correct += 1;
        }
        return test.length ? correct / test.length : 0;
      },
      { k, purge },
    );

    const metrics = { samples: records.length, baseline, cvMean: cv.mean, cvMin: cv.min, folds: cv.folds };

    if (cv.folds < k || cv.mean === null || cv.mean < baseline + minLift || cv.min < baseline - 0.05) {
      return {
        promoted: false,
        reason: `CV kapısı geçilemedi: ortalama ${cv.mean?.toFixed(3)} vs taban ${baseline.toFixed(3)} (+${minLift} gerek)`,
        metrics,
      };
    }

    // Kapı geçildi: tüm veriyle nihai eğitim ve terfi
    const final = AttentionModel.fit(records, this.#config);
    this.weights = final.weights;
    this.bias = final.bias;
    this.promoted = true;
    this.metrics = metrics;
    return { promoted: true, reason: 'CV kapısı geçildi', metrics };
  }

  toJSON() {
    return {
      promoted: this.promoted,
      weights: this.weights,
      bias: this.bias,
      featureNames: FEATURE_NAMES,
      metrics: this.metrics,
      savedAt: Date.now(),
    };
  }

  static fromJSON(json, config = {}) {
    const model = new AttentionModel(config);
    if (json?.promoted && Array.isArray(json.weights)) {
      model.weights = json.weights;
      model.bias = json.bias ?? 0;
      model.promoted = true;
      model.metrics = json.metrics ?? null;
    }
    return model;
  }
}

export default AttentionModel;
