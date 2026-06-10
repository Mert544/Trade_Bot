/**
 * FeedManager — Katman 1 orkestratörü: çoklu kaynak → sanitasyon → temiz akış.
 *
 * Her yoklama turunda birincil ve doğrulama kaynağını PARALEL çeker,
 * birincil tick'i çapraz fiyatla birlikte sanitasyon hattına verir ve
 * yalnızca CLEAN / REAL_SWEEP kararlı tick'leri yukarı katmanlara iletir:
 *
 *   onQuote(q)  — temiz kotasyon (PaperBroker fiyatı, Sniper spread geçmişi)
 *   onBar(bar)  — kapanan 3m bar (rejim dedektörü)
 *   onSweep(s)  — çapraz teyitli likidite süpürmesi (Structurer bağlamı)
 *
 * Doğrulama kaynağı düşerse kuorum yok sayılır (iğneler BAD_TICK'e düşer —
 * muhafazakâr taraf); birincil kaynak sessiz kalırsa staleness bekçisi
 * FEED_STALE yayınlar ve Governor yeni girişleri askıya alır.
 */

import { CONFIG } from '../config/defaults.mjs';
import { TICK_VERDICT } from './sanitizer.mjs';
import { BarAggregator } from './barAggregator.mjs';

export class FeedManager {
  telemetry = {
    polls: 0,
    primaryErrors: 0,
    verificationErrors: 0,
    verdicts: { CLEAN: 0, BAD_TICK: 0, REAL_SWEEP: 0, QUARANTINED: 0 },
    barsClosed: 0,
  };

  #primary;
  #verification;
  #sanitizer;
  #symbols;
  #config;
  #now;
  #logger;
  #hooks;
  #aggregator;
  #timer = null;
  #lastQuotes = new Map(); // symbol -> son temiz kotasyon

  constructor({
    primary,
    verification = null,
    sanitizer,
    symbols = CONFIG.symbols.watchlist,
    config = CONFIG.feed,
    now = () => Date.now(),
    logger = console,
    onQuote = () => {},
    onBar = () => {},
    onSweep = () => {},
  }) {
    this.#primary = primary;
    this.#verification = verification;
    this.#sanitizer = sanitizer;
    this.#symbols = symbols;
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
    this.#hooks = { onQuote, onBar, onSweep };
    this.#aggregator = new BarAggregator({ intervalMs: config.barIntervalMs });
  }

  async poll() {
    this.telemetry.polls += 1;

    const [primResult, verResult] = await Promise.allSettled([
      this.#primary.getQuotes(this.#symbols),
      this.#verification ? this.#verification.getQuotes(this.#symbols) : Promise.resolve({}),
    ]);

    if (primResult.status === 'rejected') {
      this.telemetry.primaryErrors += 1;
      this.#logger.warn(`[feed] birincil kaynak (${this.#primary.name}) hatası: ${primResult.reason?.message}`);
      // Birincil yoksa tur boş geçer; uzayan sessizliği staleness bekçisi yakalar
      await this.#sanitizer.checkStaleness();
      return;
    }
    const primQuotes = primResult.value;

    let verQuotes = {};
    if (verResult.status === 'rejected') {
      this.telemetry.verificationErrors += 1;
      this.#logger.warn(`[feed] doğrulama kaynağı (${this.#verification?.name}) hatası: ${verResult.reason?.message}`);
    } else {
      verQuotes = verResult.value;
    }

    for (const symbol of this.#symbols) {
      const quote = primQuotes[symbol];
      if (!quote) continue;
      const crossSourcePrice = verQuotes[symbol]?.price ?? null;
      const spread = Math.max(quote.ask - quote.bid, quote.price * 1e-6);

      const result = await this.#sanitizer.ingestTick({
        source: this.#primary.name,
        symbol,
        price: quote.price,
        timestamp: quote.timestamp,
        crossSourcePrice,
        spread,
      });
      this.telemetry.verdicts[result.verdict] = (this.telemetry.verdicts[result.verdict] ?? 0) + 1;

      if (result.verdict === TICK_VERDICT.REAL_SWEEP) {
        this.#hooks.onSweep({ symbol, price: quote.price, zScore: result.zScore, timestamp: quote.timestamp });
      }
      if (result.verdict !== TICK_VERDICT.CLEAN && result.verdict !== TICK_VERDICT.REAL_SWEEP) {
        continue; // kirli tick yukarı katmanlara sızamaz
      }

      const clean = { symbol, bid: quote.bid, ask: quote.ask, price: quote.price, spread, timestamp: quote.timestamp };
      this.#lastQuotes.set(symbol, clean);
      this.#hooks.onQuote(clean);

      const closedBar = this.#aggregator.push(symbol, quote.price, quote.timestamp);
      if (closedBar) {
        this.telemetry.barsClosed += 1;
        await this.#hooks.onBar(closedBar);
      }
    }

    await this.#sanitizer.checkStaleness();
  }

  start() {
    if (this.#timer) return;
    const loop = () => {
      this.poll().catch((err) => this.#logger.error(`[feed] yoklama hatası: ${err.message}`));
    };
    loop(); // ilk tur hemen
    this.#timer = setInterval(loop, this.#config.pollIntervalMs);
    this.#timer.unref?.();
  }

  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  lastQuote(symbol) {
    return this.#lastQuotes.get(symbol) ?? null;
  }

  getTelemetry() {
    return structuredClone(this.telemetry);
  }
}

export default FeedManager;
