/**
 * Bölüm 7.3 — Purged K-Fold Cross-Validation.
 *
 * Finansal veride klasik K-Fold bilgi sızıntısı yaratır: eğitim ve test
 * dilimleri zamanda komşuysa, örtüşen işlem ufukları test bilgisini eğitime
 * taşır. Çözüm: test bloğunun HER İKİ yanından purge kadar kayıt eğitimden
 * SİLİNİR (tampon). Kayıtlar zaman sıralı verilmek ZORUNDADIR.
 *
 * Sızıntılı doğrulamayla terfi eden ağırlık, üretimde ölür (anayasa 7.3).
 */

/**
 * @param {number} n Zaman sıralı kayıt sayısı
 * @param {{ k?: number, purge?: number }} opts
 * @returns {Array<{ trainIdx: number[], testIdx: number[] }>}
 */
export function purgedKFoldSplit(n, { k = 5, purge = 5 } = {}) {
  if (n < k * 2) return []; // anlamlı bölünme yok
  const foldSize = Math.floor(n / k);
  const folds = [];
  for (let f = 0; f < k; f += 1) {
    const testStart = f * foldSize;
    const testEnd = f === k - 1 ? n : testStart + foldSize; // son fold artığı alır
    const testIdx = [];
    for (let i = testStart; i < testEnd; i += 1) testIdx.push(i);

    const trainIdx = [];
    for (let i = 0; i < n; i += 1) {
      // Purge: test bloğunun iki yanındaki tampon eğitime giremez
      if (i >= testStart - purge && i < testEnd + purge) continue;
      trainIdx.push(i);
    }
    if (trainIdx.length > 0) folds.push({ trainIdx, testIdx });
  }
  return folds;
}

/**
 * Çapraz doğrulama koşusu: her fold'da trainFn ile eğit, evalFn ile ölç.
 * @param {Array} records Zaman sıralı kayıtlar
 * @param {(train: Array) => any} trainFn Model döner
 * @param {(model: any, test: Array) => number} evalFn Skor döner (büyük = iyi)
 * @returns {{ folds: number, scores: number[], mean: number, min: number }}
 */
export function runPurgedCV(records, trainFn, evalFn, { k = 5, purge = 5 } = {}) {
  const splits = purgedKFoldSplit(records.length, { k, purge });
  const scores = [];
  for (const { trainIdx, testIdx } of splits) {
    const model = trainFn(trainIdx.map((i) => records[i]));
    scores.push(evalFn(model, testIdx.map((i) => records[i])));
  }
  if (scores.length === 0) return { folds: 0, scores: [], mean: null, min: null };
  return {
    folds: scores.length,
    scores,
    mean: scores.reduce((a, b) => a + b, 0) / scores.length,
    min: Math.min(...scores),
  };
}

export default purgedKFoldSplit;
