/**
 * Dikkat Ağırlığı Eğitimi — açık, denetimli, kapılı (npm run learn).
 *
 * Akış: journal dosyalarından sonuçlanmış sinyalleri (gerçek CLOSED +
 * hipotetik akıbet) zaman sıralı toplar → örnek eşiği denetimi →
 * purged K-Fold CV kapısı → geçerse ağırlıkları state/'e yazar.
 *
 * Gölge sistem ağırlıkları bir SONRAKİ açılışta yükler (Kademeli Evrim:
 * çalışan sürece sıcak ağırlık enjeksiyonu yok). Kapı geçilmezse hiçbir
 * dosya yazılmaz ve mevcut davranış değişmez.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { CONFIG } from '../config/defaults.mjs';
import { AttentionModel, FEATURE_NAMES } from '../metacognition/attentionWeights.mjs';

/** Journal dizininden sonuçlanmış sinyal örneklerini zaman sıralı toplar. */
export function collectSamples(stateDir = 'state') {
  if (!existsSync(stateDir)) return [];
  const samples = [];
  const files = readdirSync(stateDir).filter((f) => f.startsWith('journal-') && f.endsWith('.jsonl')).sort();
  for (const file of files) {
    for (const line of readFileSync(join(stateDir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // bozuk satır (yarım yazım) atlanır
      }
      // Gerçek sonuç: kapanan gölge işlem
      if (record.kind === 'signal' && record.event === 'CLOSED' && record.signal?.outcome) {
        samples.push({ at: record.at ?? 0, quality: record.signal.quality ?? {}, outcome: record.signal.outcome });
      }
      // Hipotetik sonuç: veto/gözlem akıbeti — öğrenme verisi olarak değerli
      if (record.kind === 'signal' && record.event === 'HYPOTHETICAL' && record.signal?.hypotheticalOutcome) {
        samples.push({
          at: record.at ?? 0,
          quality: record.signal.quality ?? {},
          outcome: record.signal.hypotheticalOutcome === 'WOULD_HAVE_WON' ? 'WIN' : 'LOSS',
        });
      }
      if (record.kind === 'observationOutcome' && record.outcome) {
        samples.push({
          at: record.at ?? 0,
          quality: record.observation?.quality ?? {},
          outcome: record.outcome === 'WOULD_HAVE_WON' ? 'WIN' : 'LOSS',
        });
      }
    }
  }
  return samples.sort((a, b) => a.at - b.at);
}

export async function trainAndMaybePromote({ stateDir = 'state', logger = console } = {}) {
  const cfg = CONFIG.metacognition.attention;
  const samples = collectSamples(stateDir);
  logger.info(`[learn] ${samples.length} sonuçlanmış örnek toplandı (gerçek + hipotetik)`);

  const model = new AttentionModel(cfg);
  const result = model.trainWithValidation(samples, {
    tiers: CONFIG.metacognition.sampleTiers,
    k: cfg.kFolds,
    purge: cfg.purgeGap,
    minLift: cfg.minLift,
  });

  logger.info(`[learn] sonuç: ${result.promoted ? 'TERFİ' : 'RED'} — ${result.reason}`);
  logger.info(`[learn] metrikler: ${JSON.stringify(result.metrics)}`);

  if (result.promoted) {
    mkdirSync(dirname(cfg.weightsPath), { recursive: true });
    writeFileSync(cfg.weightsPath, JSON.stringify(model.toJSON(), null, 2));
    const named = Object.fromEntries(FEATURE_NAMES.map((name, i) => [name, Number(model.weights[i].toFixed(4))]));
    logger.info(`[learn] ağırlıklar kaydedildi → ${cfg.weightsPath}`);
    logger.info(`[learn] dikkat ağırlıkları: ${JSON.stringify(named)}`);
  } else {
    logger.info('[learn] hiçbir dosya yazılmadı; canlı davranış değişmedi (sabit önsel sürer)');
  }
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  trainAndMaybePromote({}).catch((err) => {
    console.error(`[learn] hata: ${err.message}`);
    process.exit(1);
  });
}
