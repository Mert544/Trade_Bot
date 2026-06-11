/**
 * Enstrüman Spesifikasyonları — varlık sınıfı katmanı.
 *
 * Kripto varsayımları (USD spot, kaldıraçsız, yüzdesel ücret) artık genel
 * geçer değil: her sembolün pip/kontrat/kaldıraç/maliyet/seans karakteri
 * burada tanımlanır; Governor, PaperBroker, ShadowLedger ve MTF motoru
 * kripto varsayımı yerine bu tabloyu okur.
 *
 * NOT (v1 kasıtlı sınırı): yalnız USD kotasyonlu enstrümanlar — PnL
 * matematiği (fiyat farkı × birim) dönüşümsüz USD verir. USDJPY gibi
 * çapraz kotasyonlar kur dönüşümü ister; tablo dışında tutuldu.
 *
 * volume birimi HER ZAMAN baz varlık adedidir (BTC adedi, EUR adedi, ons).
 * FX'te 1 standart lot = 100.000 birim; minOrder 1.000 (mikro lot).
 */

export const ASSET_CLASS = Object.freeze({
  CRYPTO: 'CRYPTO',
  FX: 'FX',       // forex + spot metal (XAU)
  INDEX: 'INDEX', // endeks CFD (cTrader demo ile aktifleşir)
});

export const SESSION = Object.freeze({
  ALWAYS: 'ALWAYS', // 7/24 (kripto)
  FX: 'FX',         // Paz 17:00 NY → Cum 17:00 NY
});

const SPEC = {
  // --- Kripto (Kraken WS birincil) ---
  BTCUSD: {
    assetClass: ASSET_CLASS.CRYPTO, session: SESSION.ALWAYS, source: 'kraken-ws',
    pipSize: 1, minOrder: 0.0001, lotStep: 0.0001, maxLeverage: 1,
    feeTakerPct: 0.26, feeMakerPct: 0.16, slippagePct: 0.02,
    tfProfile: { narrative: '15M', trigger: '3m' },
  },
  SOLUSD: {
    assetClass: ASSET_CLASS.CRYPTO, session: SESSION.ALWAYS, source: 'kraken-ws',
    pipSize: 0.01, minOrder: 0.02, lotStep: 0.01, maxLeverage: 1,
    feeTakerPct: 0.26, feeMakerPct: 0.16, slippagePct: 0.02,
    tfProfile: { narrative: '15M', trigger: '3m' },
  },
  XRPUSD: {
    assetClass: ASSET_CLASS.CRYPTO, session: SESSION.ALWAYS, source: 'kraken-ws',
    pipSize: 0.0001, minOrder: 5, lotStep: 1, maxLeverage: 1,
    feeTakerPct: 0.26, feeMakerPct: 0.16, slippagePct: 0.02,
    tfProfile: { narrative: '15M', trigger: '3m' },
  },

  // --- FX + metal (Twelve Data 15M barları; cTrader gelince tick'e terfi) ---
  // Maliyet modeli spread-temelli: CFD/FX'te komisyon yüzdesi yok,
  // typicalSpread sentetik kotasyon ve maliyet gerçekçiliği için.
  EURUSD: {
    assetClass: ASSET_CLASS.FX, session: SESSION.FX, source: 'twelvedata',
    pipSize: 0.0001, minOrder: 1000, lotStep: 1000, maxLeverage: 30,
    feeTakerPct: 0, feeMakerPct: 0, slippagePct: 0.002, typicalSpread: 0.00012,
    tdSymbol: 'EUR/USD',
    tfProfile: { narrative: '1H', trigger: '15M' },
  },
  GBPUSD: {
    assetClass: ASSET_CLASS.FX, session: SESSION.FX, source: 'twelvedata',
    pipSize: 0.0001, minOrder: 1000, lotStep: 1000, maxLeverage: 30,
    feeTakerPct: 0, feeMakerPct: 0, slippagePct: 0.002, typicalSpread: 0.00018,
    tdSymbol: 'GBP/USD',
    tfProfile: { narrative: '1H', trigger: '15M' },
  },
  XAUUSD: {
    assetClass: ASSET_CLASS.FX, session: SESSION.FX, source: 'twelvedata',
    pipSize: 0.1, minOrder: 0.1, lotStep: 0.01, maxLeverage: 20,
    feeTakerPct: 0, feeMakerPct: 0, slippagePct: 0.005, typicalSpread: 0.35,
    tdSymbol: 'XAU/USD',
    tfProfile: { narrative: '1H', trigger: '15M' },
  },

  // --- Endeks CFD (cTrader demo bağlanınca aktif; TD ücretsiz planda yok) ---
  US500: {
    assetClass: ASSET_CLASS.INDEX, session: SESSION.FX, source: 'ctrader',
    pipSize: 0.25, minOrder: 0.1, lotStep: 0.1, maxLeverage: 20,
    feeTakerPct: 0, feeMakerPct: 0, slippagePct: 0.005, typicalSpread: 0.5,
    tfProfile: { narrative: '1H', trigger: '15M' },
    pending: true, // veri kaynağı hazır olana dek watchlist'e girmez
  },
  US100: {
    assetClass: ASSET_CLASS.INDEX, session: SESSION.FX, source: 'ctrader',
    pipSize: 0.25, minOrder: 0.1, lotStep: 0.1, maxLeverage: 20,
    feeTakerPct: 0, feeMakerPct: 0, slippagePct: 0.005, typicalSpread: 1.2,
    tfProfile: { narrative: '1H', trigger: '15M' },
    pending: true,
  },
};

export function instrumentSpec(symbol) {
  return SPEC[symbol] ?? null;
}

export function symbolsByClass(assetClass, { includePending = false } = {}) {
  return Object.entries(SPEC)
    .filter(([, s]) => s.assetClass === assetClass && (includePending || !s.pending))
    .map(([sym]) => sym);
}

export function allActiveSymbols() {
  return Object.entries(SPEC).filter(([, s]) => !s.pending).map(([sym]) => sym);
}

export default instrumentSpec;
