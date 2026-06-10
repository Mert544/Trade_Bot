/**
 * MTF Engine — Bölüm 5.2'nin canlı orkestratörü.
 *
 * Görevi: gerçek 3m barlardan fraktal hiyerarşiyi otomatik beslemek.
 * Bilgi akışı tek yönlüdür (anayasal kural): 4H analizi bias'ı,
 * 15M analizi anlatıyı, 3m analizi tetiği üretir; her katman yalnızca
 * Structurer durum makinesine rapor verir, karar Structurer + kuruldadır.
 *
 *   3m bar kapanışı ─→ 15M serisine birleşir ─→ 4H serisine birleşir
 *        │                    │                       │
 *   tetik taraması       MMXM faz analizi        bias/DOL analizi
 *   (sweep→MSS→FVG)      updateNarrativePhase    updateHtfBias
 *        │
 *   structurer.proposeSetup (killzone + hiza şartları Structurer'da)
 */

import { CONFIG } from '../config/defaults.mjs';
import { detectSwings, findLiquidityPools, markSweptPools } from './swings.mjs';
import { classifyBias, classifyMMXM, detectSweep, detectMSS, detectFVG } from './structure.mjs';

const TF_MS = { '15M': 15 * 60 * 1000, '4H': 4 * 60 * 60 * 1000 };

/** Küçük barları epoch hizalı büyük barlara birleştirir. */
export class TimeframeSeries {
  bars = [];
  #intervalMs;
  #maxLength;
  #current = null;

  constructor({ intervalMs, maxLength = 500 }) {
    this.#intervalMs = intervalMs;
    this.#maxLength = maxLength;
  }

  /** Isınma: kapanmış tarihsel barlar (eski → yeni). */
  seed(bars) {
    this.bars = bars.slice(-this.#maxLength).map((b) => ({ ...b }));
  }

  /** @returns {object|null} alt bar bu serinin barını kapattıysa kapanan bar */
  merge(smallBar) {
    const slot = Math.floor(smallBar.openTime / this.#intervalMs);
    if (!this.#current) {
      this.#current = this.#newBar(slot, smallBar);
      return null;
    }
    if (this.#current.slot === slot) {
      this.#current.high = Math.max(this.#current.high, smallBar.high);
      this.#current.low = Math.min(this.#current.low, smallBar.low);
      this.#current.close = smallBar.close;
      return null;
    }
    const closed = {
      openTime: this.#current.slot * this.#intervalMs,
      open: this.#current.open,
      high: this.#current.high,
      low: this.#current.low,
      close: this.#current.close,
    };
    this.bars.push(closed);
    if (this.bars.length > this.#maxLength) this.bars.shift();
    this.#current = this.#newBar(slot, smallBar);
    return closed;
  }

  #newBar(slot, b) {
    return { slot, open: b.open, high: b.high, low: b.low, close: b.close };
  }
}

export class MTFEngine {
  #structurer;
  #config;
  #logger;
  #state = new Map(); // symbol -> { s15, s4h, bars3m, lastMssBarTime }

  constructor({ structurer, config = CONFIG.analysis, logger = console } = {}) {
    this.#structurer = structurer;
    this.#config = config;
    this.#logger = logger;
  }

  #sym(symbol) {
    if (!this.#state.has(symbol)) {
      this.#state.set(symbol, {
        s15: new TimeframeSeries({ intervalMs: TF_MS['15M'], maxLength: this.#config.maxSeriesLength }),
        s4h: new TimeframeSeries({ intervalMs: TF_MS['4H'], maxLength: this.#config.maxSeriesLength }),
        bars3m: [],
        lastMssBarTime: 0,
      });
    }
    return this.#state.get(symbol);
  }

  /** Açılış ısınması: tarihsel barlarla bağlam kur ve ilk analizi çalıştır. */
  async warmup(symbol, { bars4h = [], bars15m = [] }) {
    const st = this.#sym(symbol);
    st.s4h.seed(bars4h);
    st.s15.seed(bars15m);
    if (bars4h.length) await this.#analyze4H(symbol);
    if (bars15m.length) await this.#analyze15M(symbol);
    this.#logger.info(`[mtf] ${symbol} ısınma: ${bars4h.length}×4H, ${bars15m.length}×15M bar`);
  }

  /** FeedManager onBar kancası: her kapanan 3m bar buraya gelir. */
  async onBar3m(bar) {
    const st = this.#sym(bar.symbol);
    const b = { openTime: bar.openTime, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
    st.bars3m.push(b);
    if (st.bars3m.length > this.#config.maxSeriesLength) st.bars3m.shift();

    const closed15 = st.s15.merge(b);
    if (closed15) {
      const closed4h = st.s4h.merge(closed15);
      if (closed4h) await this.#analyze4H(bar.symbol);
      await this.#analyze15M(bar.symbol);
    }
    await this.#scanTrigger(bar.symbol);
  }

  // --- 4H: bias + DOL ---

  async #analyze4H(symbol) {
    const { s4h } = this.#sym(symbol);
    if (s4h.bars.length < this.#config.swingK * 2 + 3) return;
    const swings = detectSwings(s4h.bars, this.#config.swingK);
    const pools = markSweptPools(
      findLiquidityPools(swings, { tolerancePct: this.#config.eqTolerancePct }),
      s4h.bars,
    );
    const price = s4h.bars.at(-1).close;
    const { bias, dol, evidence } = classifyBias(swings, pools, price, { swingCount: this.#config.biasSwingCount });
    await this.#structurer.updateHtfBias(symbol, { htfBias: bias, dolLevel: dol, evidence });
  }

  // --- 15M: MMXM anlatısı ---

  async #analyze15M(symbol) {
    const { s15 } = this.#sym(symbol);
    if (s15.bars.length < this.#config.sweepLookbackBars) return;
    const ctx = this.#structurer.contextOf(symbol);
    const swings = detectSwings(s15.bars, this.#config.swingK);
    const pools = findLiquidityPools(swings, { tolerancePct: this.#config.eqTolerancePct });
    const { phase, alignedWithBias } = classifyMMXM(s15.bars, pools, ctx.htfBias, {
      lookback: this.#config.sweepLookbackBars,
      displacementFactor: this.#config.displacementFactor,
      consolidationRangePct: this.#config.consolidationRangePct,
    });
    await this.#structurer.updateNarrativePhase(symbol, { phase, alignedWithBias });
  }

  // --- 3m: tetik taraması (sweep → MSS → FVG) ---

  async #scanTrigger(symbol) {
    const st = this.#sym(symbol);
    const bars = st.bars3m;
    if (bars.length < this.#config.swingK * 2 + 5) return;

    const ctx = this.#structurer.contextOf(symbol);
    if (!ctx.narrativeConfirmed) return; // üst katman hizası yoksa tarama bile yok

    const swings = detectSwings(bars, this.#config.swingK);
    const pools = findLiquidityPools(swings, { tolerancePct: this.#config.eqTolerancePct });
    const sweep = detectSweep(bars, pools, { lookback: this.#config.sweepLookbackBars });
    if (!sweep) return;

    const mss = detectMSS(bars, swings, sweep);
    if (!mss.confirmed) return;

    const mssBarTime = bars[mss.barIndex].openTime;
    if (mssBarTime <= st.lastMssBarTime) return; // aynı MSS'ten mükerrer aday üretme

    const fvg = detectFVG(bars, mss.direction, {
      sinceIndex: sweep.barIndex,
      minSizePct: this.#config.fvgMinSizePct,
    });
    if (!fvg) return;

    st.lastMssBarTime = mssBarTime;
    const side = mss.direction === 'BULLISH' ? 'BUY' : 'SELL';
    const entry = fvg.mid;
    const stop = mss.direction === 'BULLISH' ? sweep.extreme : sweep.extreme;
    const targets = ctx.dolLevel !== null ? [ctx.dolLevel] : [];

    // Kalite bileşen vektörü (E3): bugün loglanır, yarın dikkat ağırlıkları
    // bu bileşenlerden öğrenilir (§7.3). Bileşensiz sinyal = öğrenilemez sinyal.
    const quality = {
      sweepDepthPct: Number((Math.abs(sweep.level - sweep.extreme) / sweep.level * 100).toFixed(4)),
      poolStrength: sweep.poolStrength,
      fvgSizePct: Number(((fvg.high - fvg.low) / fvg.mid * 100).toFixed(4)),
      mssToFvgBars: fvg.barIndex - mss.barIndex,
      phase: ctx.phase,
      htfBias: ctx.htfBias,
    };

    const result = await this.#structurer.proposeSetup(symbol, {
      side,
      entry,
      stop,
      targets,
      setupFamily: 'SWEEP_MSS_FVG',
      mssConfirmed: true,
      quality,
      evidence: [
        `3m sweep: ${sweep.direction} @ ${sweep.level} (havuz gücü ${sweep.poolStrength})`,
        `MSS teyidi: ${mss.level} kapanışla kırıldı`,
        `FVG: ${fvg.low.toFixed(6)}–${fvg.high.toFixed(6)}, giriş ${entry.toFixed(6)}`,
      ],
    });
    if (result.proposed) {
      this.#logger.info(`[mtf] ${symbol} SETUP_CANDIDATE: ${side} @ ${entry.toFixed(4)} stop=${stop} hedef=${targets[0] ?? '—'}`);
    } else if (!result.observed) {
      this.#logger.info(`[mtf] ${symbol} aday elendi: ${result.reason}`);
    }
  }

  /** Telemetri: sembolün anlık analiz bağlamı. */
  snapshot(symbol) {
    const st = this.#sym(symbol);
    return {
      bars3m: st.bars3m.length,
      bars15m: st.s15.bars.length,
      bars4h: st.s4h.bars.length,
      structurer: this.#structurer.contextOf(symbol),
    };
  }
}

export default MTFEngine;
