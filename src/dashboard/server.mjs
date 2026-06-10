/**
 * Dashboard sunucusu — Node yerleşik http, sıfır bağımlılık.
 *
 *   GET /              → gömülü tek sayfa UI
 *   GET /api/snapshot  → tam durum anlık görüntüsü (JSON)
 *   GET /events        → SSE: sinyal yaşam döngüsü + periyodik durum özeti
 *
 * Hacim kontrolü: ham bus akışı ASLA istemciye gitmez; yalnız signalHub
 * olayları (zaten süzülmüş) ve aralıklı durum özetleri yayınlanır.
 * SignalHub sink arayüzünü uygular: onSignalEvent(type, signal).
 */

import { createServer } from 'node:http';
import { CONFIG } from '../config/defaults.mjs';
import { DASHBOARD_HTML } from './ui.mjs';

export class DashboardServer {
  #server = null;
  #clients = new Set(); // SSE yanıt nesneleri
  #snapshotProvider;
  #config;
  #logger;
  #timers = [];

  constructor({ snapshotProvider, config = CONFIG.dashboard, logger = console } = {}) {
    this.#snapshotProvider = snapshotProvider;
    this.#config = config;
    this.#logger = logger;
  }

  async start(port = Number(process.env.ICT_DASHBOARD_PORT ?? this.#config.port)) {
    this.#server = createServer((req, res) => this.#handle(req, res));
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(port, () => resolve());
    });

    const status = setInterval(async () => {
      try {
        this.broadcast('status', await this.#snapshotProvider());
      } catch (err) {
        this.#logger.error(`[dashboard] snapshot hatası: ${err.message}`);
      }
    }, this.#config.snapshotIntervalMs);
    status.unref?.();

    const keepAlive = setInterval(() => {
      for (const res of this.#clients) res.write(':ka\n\n');
    }, this.#config.keepAliveMs);
    keepAlive.unref?.();

    this.#timers = [status, keepAlive];
    // listen(0) rastgele port atar; istemciye GERÇEK port dönmeli
    const actualPort = this.#server.address().port;
    this.#logger.info(`[dashboard] http://localhost:${actualPort} hazır`);
    return actualPort;
  }

  stop() {
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    for (const res of this.#clients) res.end();
    this.#clients.clear();
    // close() yeni bağlantıyı reddeder ama boştaki keep-alive soketleri bekler;
    // süreç çıkışını (ve testleri) asmaması için tümü koparılır.
    this.#server?.closeAllConnections?.();
    this.#server?.close();
    this.#server = null;
  }

  async #handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
      } else if (url.pathname === '/api/snapshot') {
        const snapshot = await this.#snapshotProvider();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(snapshot));
      } else if (url.pathname === '/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(':bağlandı\n\n');
        this.#clients.add(res);
        req.on('close', () => this.#clients.delete(res));
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('bulunamadı');
      }
    } catch (err) {
      this.#logger.error(`[dashboard] istek hatası ${url.pathname}: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.#clients) {
      try {
        res.write(frame);
      } catch {
        this.#clients.delete(res);
      }
    }
  }

  /** SignalHub sink arayüzü. */
  onSignalEvent(type, signal) {
    this.broadcast('signal', { type, signal });
  }

  get clientCount() {
    return this.#clients.size;
  }
}

export default DashboardServer;
