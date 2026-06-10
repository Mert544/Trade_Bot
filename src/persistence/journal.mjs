/**
 * Journal — JSONL kalıcılık katmanı (E1).
 *
 * Sinyal yaşam döngüsü olayları ve post-mortem kayıtları günlük dosyalara
 * append edilir: state/journal-YYYY-MM-DD.jsonl. Günlük dosya = doğal
 * rotasyon; restart'ta replay ile istatistikler yeniden kurulur.
 *
 * Öğrenme verisi bugünden birikmeye başlar — ağırlık öğrenme, veto isabeti
 * ve killzone hipotez testi bu kayıtlar olmadan imkânsız.
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export class Journal {
  #dir;
  #now;
  #logger;

  telemetry = { written: 0, replayErrors: 0 };

  constructor({ dir = 'state', now = () => Date.now(), logger = console } = {}) {
    this.#dir = dir;
    this.#now = now;
    this.#logger = logger;
    mkdirSync(dir, { recursive: true });
  }

  #fileFor(ts) {
    const d = new Date(ts);
    const name = `journal-${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}.jsonl`;
    return join(this.#dir, name);
  }

  /** Genel kayıt: { kind, ...veri } şeklinde tek satır JSON. */
  append(record) {
    const at = this.#now();
    appendFileSync(this.#fileFor(at), `${JSON.stringify({ at, ...record })}\n`);
    this.telemetry.written += 1;
  }

  /** SignalHub sink arayüzü. */
  onSignalEvent(eventType, signal) {
    this.append({ kind: 'signal', event: eventType, signal });
  }

  /**
   * Tüm journal dosyalarını kronolojik okur, her kaydı handler'a verir.
   * Bozuk satır atlanır ve sayılır (kalıcı veri asla boot'u engellemez).
   */
  replay(handler) {
    if (!existsSync(this.#dir)) return 0;
    const files = readdirSync(this.#dir)
      .filter((f) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    let count = 0;
    for (const file of files) {
      const lines = readFileSync(join(this.#dir, file), 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          handler(JSON.parse(line));
          count += 1;
        } catch {
          this.telemetry.replayErrors += 1;
        }
      }
    }
    if (count > 0) this.#logger.info(`[journal] replay: ${count} kayıt (${files.length} dosya)`);
    return count;
  }
}

export default Journal;
