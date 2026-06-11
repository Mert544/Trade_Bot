/**
 * cTrader Remote MCP İstemcisi — FX + Endeks veri kanalı (HTTPS, anahtarsız port yok).
 *
 * cTrader'ın resmî MCP ucu (mcp.ctrader.com) JSON-RPC/SSE üzerinden:
 *   get_symbols      → sembol adı → ID haritası
 *   get_spot_prices  → GERÇEK bid/ask (10⁵ ölçekli tamsayı)
 *   get_trendbars    → gerçek OHLCV (M_15/H_1/H_4; from/to zorunlu, ≤720h)
 *   get_balance      → demo hesap durumu
 *
 * Kimlik: Authorization Bearer <base64 blob> — CTRADER_TOKEN_B64 env'den,
 * ASLA loglanmaz/commitlenmez. Oturum: mcp-session-id başlığı; süresi
 * dolarsa şeffaf yeniden başlatma + tek tekrar.
 *
 * Bu kanal FIX tick akışına terfi edene dek FX/endeks BİRİNCİL kaynağıdır
 * (Twelve Data: token yoksa yedek). Avantajları: endeksler dahil, gerçek
 * spread, her ağdan erişim (443).
 */

import { CONFIG } from '../../config/defaults.mjs';
import { instrumentSpec } from '../../config/instruments.mjs';
import { isMarketOpen } from '../../time/marketHours.mjs';

const PRICE_SCALE = 100_000; // cTrader fiyatları 10⁵ ölçekli tamsayı (doğrulandı: FX/metal/endeks)
const PERIOD_MS = { M_15: 15 * 60 * 1000, H_1: 60 * 60 * 1000, H_4: 4 * 60 * 60 * 1000 };
const MAX_RANGE_MS = 720 * 60 * 60 * 1000; // tek çağrı sınırı (30 gün)

export class CTraderMcp {
  #token;
  #baseUrl;
  #fetchImpl;
  #now;
  #logger;
  #sessionId = null;
  #rpcId = 0;
  #symbolIdCache = null;

  telemetry = { calls: 0, errors: 0, sessionRestarts: 0 };

  constructor({
    tokenB64 = process.env.CTRADER_TOKEN_B64,
    baseUrl = 'https://mcp.ctrader.com/trading/mcp',
    fetchImpl = fetch,
    now = () => Date.now(),
    logger = console,
  } = {}) {
    this.#token = tokenB64;
    this.#baseUrl = baseUrl;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#logger = logger;
  }

  get enabled() {
    return Boolean(this.#token);
  }

  get name() { return 'ctrader-mcp'; }

  async #post(body, { withSession = true } = {}) {
    const headers = {
      Authorization: `Bearer ${this.#token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (withSession && this.#sessionId) headers['mcp-session-id'] = this.#sessionId;
    const res = await this.#fetchImpl(this.#baseUrl, {
      method: 'POST', headers, body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    return res;
  }

  /** SSE ('data: {...}') veya düz JSON gövdesini çözer. */
  static parseBody(text) {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return JSON.parse(trimmed);
    let last = null;
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('data:')) last = JSON.parse(line.slice(5).trim());
    }
    if (last === null) throw new Error('mcp yanıtı çözülemedi (SSE data satırı yok)');
    return last;
  }

  async #initialize() {
    const res = await this.#post({
      jsonrpc: '2.0', id: ++this.#rpcId, method: 'initialize',
      params: {
        protocolVersion: '2025-03-26', capabilities: {},
        clientInfo: { name: 'ict-bot', version: '5.0.0' },
      },
    }, { withSession: false });
    if (!res.ok) throw new Error(`mcp initialize HTTP ${res.status}`);
    this.#sessionId = res.headers.get('mcp-session-id');
    CTraderMcp.parseBody(await res.text()); // geçerlilik denetimi
    await this.#post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    // Sunucu oturumu kısa ömürlü tutuyor (her çağrıda tazeleme normal) —
    // yalnız ilk açılış loglanır, gerisi telemetriden izlenir
    if (this.telemetry.sessionRestarts === 0 && this.telemetry.calls <= 1) {
      this.#logger.info('[ctrader-mcp] oturum açıldı');
    }
  }

  // MCP oturumu eşzamanlı istek desteklemez: paralel çağrılar ayrı
  // initialize yarışı başlatıp birbirinin oturumunu düşürür (canlıda
  // gözlendi: HTTP 404 fırtınası). Tüm RPC'ler tek kuyrukta serileşir.
  #chain = Promise.resolve();

  async #rpc(method, params) {
    const task = () => this.#rpcSerial(method, params);
    const p = this.#chain.then(task, task);
    this.#chain = p.then(() => {}, () => {});
    return p;
  }

  async #rpcSerial(method, params) {
    this.telemetry.calls += 1;
    if (!this.#sessionId) await this.#initialize();
    let res = await this.#post({ jsonrpc: '2.0', id: ++this.#rpcId, method, params });
    if (res.status === 404 || res.status === 400) {
      // Oturum düşmüş olabilir: şeffaf yeniden başlatma + tek tekrar
      this.telemetry.sessionRestarts += 1;
      this.#sessionId = null;
      await this.#initialize();
      res = await this.#post({ jsonrpc: '2.0', id: ++this.#rpcId, method, params });
    }
    if (!res.ok) {
      this.telemetry.errors += 1;
      throw new Error(`mcp ${method} HTTP ${res.status}`);
    }
    const body = CTraderMcp.parseBody(await res.text());
    if (body.error) {
      this.telemetry.errors += 1;
      throw new Error(`mcp ${method}: ${body.error.message ?? 'bilinmeyen hata'}`);
    }
    return body.result;
  }

  /** tools/call sarmalayıcı: content[0].text JSON'unu çözer, isError'ı fırlatır. */
  async callTool(name, args = {}) {
    const result = await this.#rpc('tools/call', { name, arguments: args });
    const text = result?.content?.[0]?.text ?? '';
    if (result?.isError) {
      this.telemetry.errors += 1;
      throw new Error(`mcp aracı ${name}: ${text.slice(0, 200)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  /** Sembol adı → cTrader symbolId haritası (önbellekli; 1900+ sembol tek çağrı). */
  async symbolIds() {
    if (this.#symbolIdCache) return this.#symbolIdCache;
    const data = await this.callTool('get_symbols');
    const list = Array.isArray(data) ? data : data.symbols ?? data.symbol ?? [];
    const map = new Map();
    for (const s of list) {
      const name = s.symbolName ?? s.name;
      const id = s.symbolId ?? s.id;
      if (name && id !== undefined && !map.has(name)) map.set(name, id);
    }
    this.#symbolIdCache = map;
    return map;
  }

  /** Anlık bid/ask (gerçek spread). @returns Map<symbolId, {bid, ask, timestamp}> */
  async spotPrices(symbolIds) {
    const data = await this.callTool('get_spot_prices', { symbolId: symbolIds });
    const out = new Map();
    for (const p of data.prices ?? []) {
      if (!(p.bid > 0) || !(p.ask > 0)) continue;
      out.set(p.symbolId, {
        bid: p.bid / PRICE_SCALE,
        ask: p.ask / PRICE_SCALE,
        timestamp: p.timestamp ?? this.#now(),
      });
    }
    return out;
  }

  /**
   * Gerçek OHLCV barları (eski → yeni). Sunucu from/to ister (≤720h);
   * uzun tarihçe için aralık otomatik dilimlenmez — istenen pencere kadar.
   */
  async trendbars(symbolId, period, { fromMs, toMs }) {
    const intervalMs = PERIOD_MS[period];
    if (!intervalMs) throw new Error(`desteklenmeyen periyot: ${period}`);
    if (toMs - fromMs > MAX_RANGE_MS) fromMs = toMs - MAX_RANGE_MS;
    const data = await this.callTool('get_trendbars', {
      symbolId, period, fromTimestamp: String(fromMs), toTimestamp: String(toMs),
    });
    return (data.trendbars ?? [])
      .map((b) => ({
        openTime: b.timestamp,
        open: b.open / PRICE_SCALE,
        high: b.high / PRICE_SCALE,
        low: b.low / PRICE_SCALE,
        close: b.close / PRICE_SCALE,
        volume: b.volume ?? 0,
        intervalMs,
      }))
      .filter((b) => [b.open, b.high, b.low, b.close].every((x) => x > 0))
      .sort((a, b) => a.openTime - b.openTime);
  }

  async balance() {
    return this.callTool('get_balance');
  }
}

/**
 * MCP Besleme Orkestratörü: spot fiyat yoklaması (icra gerçekçiliği) +
 * kapanmış M_15 bar yoklaması (analiz). Oluşmakta olan bar yayılmaz.
 */
export class CTraderMcpFeed {
  #mcp;
  #symbols;       // sistem sembolleri (instruments.mcpSymbol tanımlı)
  #idBySymbol = new Map();
  #symbolById = new Map();
  #onQuote;
  #onBar;
  #now;
  #logger;
  #config;
  #spotTimer = null;
  #barTimer = null;
  #lastEmitted = new Map();

  telemetry = { spotPolls: 0, barPolls: 0, barsEmitted: 0, errors: 0 };

  constructor({
    mcp,
    symbols,
    config = CONFIG.feed.ctraderMcp,
    now = () => Date.now(),
    logger = console,
    onQuote = () => {},
    onBar = () => {},
  }) {
    this.#mcp = mcp;
    this.#symbols = symbols.filter((s) => instrumentSpec(s)?.mcpSymbol);
    this.#config = config;
    this.#now = now;
    this.#logger = logger;
    this.#onQuote = onQuote;
    this.#onBar = onBar;
  }

  get symbols() { return [...this.#symbols]; }

  /** Sembol ID çözümlemesi + tarihsel ısınma barları. */
  async resolveSymbols() {
    const ids = await this.#mcp.symbolIds();
    for (const symbol of this.#symbols) {
      const mcpName = instrumentSpec(symbol).mcpSymbol;
      const id = ids.get(mcpName);
      if (id === undefined) {
        this.#logger.warn(`[ctrader-mcp] sembol bulunamadı: ${mcpName}`);
        continue;
      }
      this.#idBySymbol.set(symbol, id);
      this.#symbolById.set(id, symbol);
    }
    return this.#idBySymbol;
  }

  async fetchWarmup(symbol) {
    const id = this.#idBySymbol.get(symbol);
    if (id === undefined) throw new Error(`sembol çözülmedi: ${symbol}`);
    const now = this.#now();
    const H = 60 * 60 * 1000;
    const [bars4h, bars1h, bars15] = await Promise.all([
      this.#mcp.trendbars(id, 'H_4', { fromMs: now - 720 * H, toMs: now }),
      this.#mcp.trendbars(id, 'H_1', { fromMs: now - 400 * H, toMs: now }),
      this.#mcp.trendbars(id, 'M_15', { fromMs: now - 100 * H, toMs: now }),
    ]);
    // Son bar oluşmakta olabilir: kapanışı gelmemiş bar ısınmaya girmez
    const closedOnly = (bars) => bars.filter((b) => b.openTime + b.intervalMs <= now);
    return { bars4h: closedOnly(bars4h), bars1h: closedOnly(bars1h), bars15: closedOnly(bars15) };
  }

  seedLastEmitted(symbol, lastOpenTime) {
    this.#lastEmitted.set(symbol, lastOpenTime);
  }

  /** Spot yoklama: gerçek bid/ask → icra hattı. */
  async pollSpot() {
    this.telemetry.spotPolls += 1;
    const now = this.#now();
    const open = this.#symbols.filter((s) => this.#idBySymbol.has(s) && isMarketOpen(s, new Date(now)));
    if (open.length === 0) return;
    try {
      const prices = await this.#mcp.spotPrices(open.map((s) => this.#idBySymbol.get(s)));
      for (const [id, q] of prices) {
        const symbol = this.#symbolById.get(id);
        if (symbol) await this.#onQuote({ symbol, ...q });
      }
    } catch (err) {
      this.telemetry.errors += 1;
      this.#logger.warn(`[ctrader-mcp] spot hatası: ${err.message}`);
    }
  }

  /** Bar yoklama: yeni KAPANMIŞ M_15 barları yayar (dedupe + forming koruması). */
  async pollBars() {
    this.telemetry.barPolls += 1;
    const now = this.#now();
    for (const symbol of this.#symbols) {
      const id = this.#idBySymbol.get(symbol);
      if (id === undefined || !isMarketOpen(symbol, new Date(now))) continue;
      try {
        const bars = await this.#mcp.trendbars(id, 'M_15', { fromMs: now - 2 * 60 * 60 * 1000, toMs: now });
        for (const bar of bars) {
          if (bar.openTime + bar.intervalMs > now) continue; // forming
          if (bar.openTime <= (this.#lastEmitted.get(symbol) ?? 0)) continue; // dedupe
          this.#lastEmitted.set(symbol, bar.openTime);
          this.telemetry.barsEmitted += 1;
          await this.#onBar({ symbol, ...bar });
        }
      } catch (err) {
        this.telemetry.errors += 1;
        this.#logger.warn(`[ctrader-mcp] bar hatası (${symbol}): ${err.message}`);
      }
    }
  }

  start() {
    if (this.#spotTimer) return;
    const spotLoop = () => { this.pollSpot().catch(() => {}); };
    const barLoop = () => { this.pollBars().catch(() => {}); };
    spotLoop();
    this.#spotTimer = setInterval(spotLoop, this.#config.spotPollMs);
    this.#spotTimer.unref?.();
    this.#barTimer = setInterval(barLoop, this.#config.barPollMs);
    this.#barTimer.unref?.();
  }

  stop() {
    if (this.#spotTimer) clearInterval(this.#spotTimer);
    if (this.#barTimer) clearInterval(this.#barTimer);
    this.#spotTimer = null;
    this.#barTimer = null;
  }
}

export default CTraderMcp;
