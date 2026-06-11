/**
 * SMT (Smart Money Technique) Diverjansı + Korelasyon/Lead-Lag Matrisi.
 *
 * SMT: korele iki varlıktan biri likidite ucunu süpürürken diğerinin
 * süpürememesi — "akıllı para" tek varlıkta tuzak kuruyor demektir ve
 * süpürmeyen varlığın yönü gerçek yön kabul edilir. ICT'de en güçlü
 * tersine dönüş teyitlerinden biridir.
 *
 * Korelasyon matrisi: kayan Pearson korelasyonu (15M kapanış getirileri).
 * SMT yalnız |r| eşik üstü çiftlerde anlamlıdır; ters korele çiftlerde
 * diverjans tanımı ayna görüntüsüyle değerlendirilir.
 *
 * Lead-Lag (nedensellik-lite): gecikmeli çapraz korelasyon — hangi parite
 * diğerini k bar önden öngörüyor? Granger nedenselliğinin bağımlılıksız,
 * mütevazı v1'i: yön iddiası değil, ÖNCÜLLÜK ölçümü. Sinyal kalitesine
 * "öncü parite teyidi" bileşeni olarak girer.
 */

export class CorrelationMatrix {
  #returns = new Map(); // symbol -> son N getiri
  #lastClose = new Map();
  #window;

  constructor({ window = 96 } = {}) { // 96 × 15M = 24 saat
    this.#window = window;
  }

  onClose(symbol, close) {
    const last = this.#lastClose.get(symbol);
    this.#lastClose.set(symbol, close);
    if (last === undefined || last <= 0) return;
    const series = this.#returns.get(symbol) ?? [];
    series.push(Math.log(close / last));
    if (series.length > this.#window) series.shift();
    this.#returns.set(symbol, series);
  }

  /** Pearson korelasyonu; hizalı son n ortak getiri üzerinden. */
  correlation(symA, symB, { lag = 0 } = {}) {
    const a = this.#returns.get(symA) ?? [];
    const b = this.#returns.get(symB) ?? [];
    // lag > 0: A, B'yi lag bar önden öngörüyor mu? (A[t-lag] ↔ B[t])
    const n = Math.min(a.length - lag, b.length);
    if (n < 20) return null; // istatistiksel taban
    const aSlice = a.slice(a.length - lag - n, a.length - lag);
    const bSlice = b.slice(b.length - n);
    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const ma = mean(aSlice);
    const mb = mean(bSlice);
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < n; i += 1) {
      const da = aSlice[i] - ma;
      const db = bSlice[i] - mb;
      cov += da * db;
      va += da * da;
      vb += db * db;
    }
    if (va === 0 || vb === 0) return null;
    return cov / Math.sqrt(va * vb);
  }

  /**
   * Lead-lag profili: A'nın B'yi 1..maxLag bar önden öngörme gücü.
   * En güçlü |korelasyonlu| gecikme döner.
   */
  leadLag(symA, symB, { maxLag = 3 } = {}) {
    let best = { lag: 0, r: this.correlation(symA, symB) ?? 0 };
    for (let lag = 1; lag <= maxLag; lag += 1) {
      const r = this.correlation(symA, symB, { lag });
      if (r !== null && Math.abs(r) > Math.abs(best.r)) best = { lag, r };
    }
    return best;
  }

  /** Tüm çiftlerin anlık matrisi (dashboard/telemetri). */
  matrix(symbols) {
    const out = [];
    for (let i = 0; i < symbols.length; i += 1) {
      for (let j = i + 1; j < symbols.length; j += 1) {
        const r = this.correlation(symbols[i], symbols[j]);
        const ll = this.leadLag(symbols[i], symbols[j]);
        const llRev = this.leadLag(symbols[j], symbols[i]);
        out.push({
          pair: `${symbols[i]}/${symbols[j]}`,
          r: r === null ? null : Number(r.toFixed(3)),
          // pozitif lead: ilk sembol öncü; negatif: ikinci öncü
          leader: Math.abs(ll.r) >= Math.abs(llRev.r)
            ? { symbol: symbols[i], lag: ll.lag, r: Number(ll.r.toFixed(3)) }
            : { symbol: symbols[j], lag: llRev.lag, r: Number(llRev.r.toFixed(3)) },
        });
      }
    }
    return out;
  }
}

export class SMTDetector {
  #matrix;
  #recentExtremes = new Map(); // symbol -> { swingLow, swingHigh, sweptLowAt, sweptHighAt }
  #config;

  constructor({ matrix, minCorrelation = 0.6, windowMs = 60 * 60 * 1000 } = {}) {
    this.#matrix = matrix;
    this.#config = { minCorrelation, windowMs };
  }

  /**
   * Sembolün son swing uçları ve süpürme olayları bildirilir
   * (mtfEngine 15M analizinden beslenir).
   */
  updateExtremes(symbol, { swingLow = null, swingHigh = null, sweptLow = null, sweptHigh = null, at }) {
    const rec = this.#recentExtremes.get(symbol) ?? {};
    if (swingLow !== null) rec.swingLow = { price: swingLow, at };
    if (swingHigh !== null) rec.swingHigh = { price: swingHigh, at };
    if (sweptLow) rec.sweptLowAt = at;
    if (sweptHigh) rec.sweptHighAt = at;
    this.#recentExtremes.set(symbol, rec);
  }

  /**
   * SMT sorgusu: `symbol` dip süpürdü — korele eşlerden süpürMEyen var mı?
   * Varsa bullish SMT diverjansı (gerçek yön yukarı) döner.
   *
   * @param {'LOW'|'HIGH'} side süpürülen uç
   * @returns {{ divergent: boolean, confirmingSymbol?, correlation?, kind? }}
   */
  query(symbol, side, peers, at = Date.now()) {
    const windowMs = this.#config.windowMs;
    for (const peer of peers) {
      if (peer === symbol) continue;
      const r = this.#matrix.correlation(symbol, peer);
      if (r === null || Math.abs(r) < this.#config.minCorrelation) continue;

      const rec = this.#recentExtremes.get(peer);
      if (!rec) continue;

      // Pozitif korelasyon: eş AYNI ucu süpürmediyse diverjans.
      // Negatif korelasyon: eşin AYNA ucu (LOW↔HIGH) süpürmemesi aranır.
      const mirrorSide = r >= 0 ? side : (side === 'LOW' ? 'HIGH' : 'LOW');
      const sweptAt = mirrorSide === 'LOW' ? rec.sweptLowAt : rec.sweptHighAt;
      const peerSweptRecently = sweptAt !== undefined && at - sweptAt <= windowMs;

      if (!peerSweptRecently) {
        return {
          divergent: true,
          confirmingSymbol: peer,
          correlation: Number(r.toFixed(3)),
          kind: side === 'LOW' ? 'BULLISH_SMT' : 'BEARISH_SMT',
        };
      }
    }
    return { divergent: false };
  }
}

export default CorrelationMatrix;
