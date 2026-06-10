/**
 * Kraken WebSocket v2 sağlayıcısı (Faz D — E4 kör nokta düzeltmesi).
 *
 * 5sn REST polling bar fitillerini kaçırır: gerçek likidite süpürmelerinin
 * çoğu iki yoklama arasında olup biter. Bu sağlayıcı wss://ws.kraken.com/v2
 * (anahtarsız, ücretsiz) üzerinden GERÇEK işlem akışını dinler:
 *   - trade kanalı  → her gerçekleşen işlem = gerçek fitil verisi
 *   - ticker kanalı → güncel bid/ask (spread bağlamı)
 *
 * Dayanıklılık: üstel geri çekilme + jitter ile yeniden bağlanma; uzayan
 * sessizlikte mevcut staleness bekçisi FEED_STALE üretir (güvenlik ağı).
 * Node ≥22 yerleşik WebSocket kullanılır — npm bağımlılığı yok.
 */

import { CONFIG } from '../../config/defaults.mjs';

const WS_SYMBOLS = {
  BTCUSD: 'BTC/USD',
  XRPUSD: 'XRP/USD',
  SOLUSD: 'SOL/USD',
  ETHUSD: 'ETH/USD',
};
const REVERSE = Object.fromEntries(Object.entries(WS_SYMBOLS).map(([k, v]) => [v, k]));

export class KrakenWsProvider {
  #url;
  #symbols;
  #onTick;
  #logger;
  #now;
  #WebSocketImpl;
  #config;

  #ws = null;
  #stopped = true;
  #reconnectAttempt = 0;
  #lastBidAsk = new Map(); // sistem sembolü -> { bid, ask }

  telemetry = { trades: 0, tickers: 0, reconnects: 0, parseErrors: 0 };

  constructor({
    symbols = CONFIG.symbols.watchlist,
    onTick,
    url = CONFIG.feed.ws.url,
    config = CONFIG.feed.ws,
    logger = console,
    now = () => Date.now(),
    WebSocketImpl = globalThis.WebSocket,
  } = {}) {
    if (!WebSocketImpl) throw new Error('WebSocket desteği yok (Node ≥22 gerekli)');
    this.#symbols = symbols.filter((s) => WS_SYMBOLS[s]);
    this.#onTick = onTick;
    this.#url = url;
    this.#config = config;
    this.#logger = logger;
    this.#now = now;
    this.#WebSocketImpl = WebSocketImpl;
  }

  get name() { return 'kraken-ws'; }

  start() {
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    try { this.#ws?.close(); } catch { /* kapanışta hata önemsiz */ }
    this.#ws = null;
  }

  #connect() {
    if (this.#stopped) return;
    const ws = new this.#WebSocketImpl(this.#url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      this.#reconnectAttempt = 0;
      const pairs = this.#symbols.map((s) => WS_SYMBOLS[s]);
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: pairs } }));
      ws.send(JSON.stringify({ method: 'subscribe', params: { channel: 'ticker', symbol: pairs } }));
      this.#logger.info(`[kraken-ws] bağlandı, abone: ${pairs.join(', ')}`);
    });

    ws.addEventListener('message', (event) => this.#onMessage(event.data));

    ws.addEventListener('close', () => {
      if (this.#stopped) return;
      this.#scheduleReconnect('bağlantı kapandı');
    });

    ws.addEventListener('error', () => {
      // close olayı da gelir; reconnect oradan tetiklenir
    });
  }

  #scheduleReconnect(reason) {
    this.#reconnectAttempt += 1;
    this.telemetry.reconnects += 1;
    const base = Math.min(
      this.#config.reconnectMaxMs,
      this.#config.reconnectBaseMs * 2 ** (this.#reconnectAttempt - 1),
    );
    const delay = base + Math.random() * base * 0.3; // jitter: sürü etkisini kır
    this.#logger.warn(`[kraken-ws] ${reason}; ${Math.round(delay)}ms sonra yeniden bağlanılacak (deneme ${this.#reconnectAttempt})`);
    const t = setTimeout(() => this.#connect(), delay);
    t.unref?.();
  }

  #onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.telemetry.parseErrors += 1;
      return;
    }
    if (msg.channel === 'heartbeat' || msg.channel === 'status' || msg.method) return;

    if (msg.channel === 'ticker' && Array.isArray(msg.data)) {
      for (const t of msg.data) {
        const symbol = REVERSE[t.symbol];
        if (!symbol) continue;
        const bid = Number(t.bid);
        const ask = Number(t.ask);
        if (bid > 0 && ask > 0) this.#lastBidAsk.set(symbol, { bid, ask });
        this.telemetry.tickers += 1;
      }
      return;
    }

    if (msg.channel === 'trade' && Array.isArray(msg.data)) {
      for (const trade of msg.data) {
        const symbol = REVERSE[trade.symbol];
        const price = Number(trade.price);
        if (!symbol || !(price > 0)) continue;
        const ba = this.#lastBidAsk.get(symbol);
        const timestamp = trade.timestamp ? Date.parse(trade.timestamp) : this.#now();
        this.telemetry.trades += 1;
        this.#onTick({
          symbol,
          price,
          bid: ba?.bid ?? price,
          ask: ba?.ask ?? price,
          timestamp: Number.isFinite(timestamp) ? timestamp : this.#now(),
        });
      }
    }
  }
}

export default KrakenWsProvider;
