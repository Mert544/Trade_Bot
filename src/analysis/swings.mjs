/**
 * Fraktal swing tespiti ve likidite haritası (Algı Katmanı / K2).
 *
 * ICT temel taşı: likidite, eski yüksek/düşükler ve eşit seviyelerin
 * (equal highs/lows) arkasında birikir. Bu modül ham barlardan sembolik
 * olguları çıkarır: swing noktaları ve likidite havuzları.
 */

/**
 * Fraktal swing tespiti: i indeksli bar, her iki yanındaki k barın
 * tamamından yüksekse swing HIGH, alçaksa swing LOW.
 *
 * @returns {Array<{ index, type: 'HIGH'|'LOW', price, time }>} eski → yeni
 */
export function detectSwings(bars, k = 2) {
  const swings = [];
  for (let i = k; i < bars.length - k; i += 1) {
    let isHigh = true;
    let isLow = true;
    // Sol taraf katı, sağ taraf eşitliğe toleranslı: ardışık barlar aynı ucu
    // paylaştığında (eşit yüksekler/düşükler) swing İLK oluşuma yazılır —
    // aksi halde eşit seviyeler birbirini diskalifiye eder ve ICT'nin tam
    // aradığı likidite seviyeleri görünmez olur.
    for (let j = i - k; j < i; j += 1) {
      if (bars[j].high >= bars[i].high) isHigh = false;
      if (bars[j].low <= bars[i].low) isLow = false;
    }
    for (let j = i + 1; j <= i + k; j += 1) {
      if (bars[j].high > bars[i].high) isHigh = false;
      if (bars[j].low < bars[i].low) isLow = false;
    }
    if (isHigh) swings.push({ index: i, type: 'HIGH', price: bars[i].high, time: bars[i].openTime });
    if (isLow) swings.push({ index: i, type: 'LOW', price: bars[i].low, time: bars[i].openTime });
  }
  return swings;
}

/**
 * Likidite havuzları: birbirine tolerans içinde yakın swing seviyeleri
 * kümelenir. Eşit yüksekler = BUYSIDE (üstte duran stoplar),
 * eşit düşükler = SELLSIDE. Tek dokunuşlu eski uç da havuzdur (strength=1);
 * çok dokunuşlu küme daha güçlüdür.
 *
 * @returns {Array<{ side, level, strength, lastTouchTime, swept: false }>}
 */
export function findLiquidityPools(swings, { tolerancePct = 0.08 } = {}) {
  const pools = [];
  for (const targetType of ['HIGH', 'LOW']) {
    const points = swings.filter((s) => s.type === targetType);
    const used = new Set();
    for (let i = 0; i < points.length; i += 1) {
      if (used.has(i)) continue;
      const cluster = [points[i]];
      used.add(i);
      for (let j = i + 1; j < points.length; j += 1) {
        if (used.has(j)) continue;
        const ref = cluster[0].price;
        if (Math.abs(points[j].price - ref) / ref <= tolerancePct / 100) {
          cluster.push(points[j]);
          used.add(j);
        }
      }
      // Havuz seviyesi: yüksekler için kümenin tepesi, düşükler için tabanı
      // (stoplar uç noktanın arkasındadır)
      const level = targetType === 'HIGH'
        ? Math.max(...cluster.map((p) => p.price))
        : Math.min(...cluster.map((p) => p.price));
      pools.push({
        side: targetType === 'HIGH' ? 'BUYSIDE' : 'SELLSIDE',
        level,
        strength: cluster.length,
        lastTouchTime: Math.max(...cluster.map((p) => p.time)),
        swept: false,
      });
    }
  }
  return pools.sort((a, b) => b.level - a.level);
}

/**
 * Havuzların süpürülme durumunu işaretler: sonraki barlarda seviye aşıldıysa
 * havuz tüketilmiştir; DOL hedefi yalnızca süpürülmemiş havuz olabilir.
 */
export function markSweptPools(pools, bars, swingsLastIndex = 0) {
  for (const pool of pools) {
    for (let i = swingsLastIndex; i < bars.length; i += 1) {
      const bar = bars[i];
      if (bar.openTime <= pool.lastTouchTime) continue;
      if (pool.side === 'BUYSIDE' && bar.high > pool.level) { pool.swept = true; break; }
      if (pool.side === 'SELLSIDE' && bar.low < pool.level) { pool.swept = true; break; }
    }
  }
  return pools;
}

export default detectSwings;
