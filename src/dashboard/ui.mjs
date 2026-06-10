/**
 * Dashboard UI — tek sayfa, sıfır bağımlılık, vanilla HTML/CSS/JS, Türkçe.
 * Sayfa JS'i template literal kaçış sorunlarından kaçınmak için string
 * birleştirme kullanır.
 */

export const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ICT Bot V5 — Gölge Mod</title>
<style>
  :root {
    --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#c9d1d9; --dim:#8b949e;
    --green:#3fb950; --red:#f85149; --amber:#d29922; --blue:#58a6ff; --purple:#bc8cff;
  }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--fg); font:13px/1.5 'SF Mono',Consolas,monospace; padding:12px; }
  header { display:flex; gap:16px; align-items:center; flex-wrap:wrap; padding:10px 14px;
           background:var(--panel); border:1px solid var(--border); border-radius:8px; margin-bottom:12px; }
  header h1 { font-size:15px; color:var(--blue); margin-right:8px; }
  .chip { padding:2px 10px; border-radius:12px; border:1px solid var(--border); font-size:12px; }
  .chip.ok { color:var(--green); border-color:var(--green); }
  .chip.warn { color:var(--amber); border-color:var(--amber); }
  .chip.bad { color:var(--red); border-color:var(--red); }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(340px,1fr)); gap:12px; }
  .panel { background:var(--panel); border:1px solid var(--border); border-radius:8px; padding:12px; }
  .panel h2 { font-size:12px; text-transform:uppercase; letter-spacing:1px; color:var(--dim);
              border-bottom:1px solid var(--border); padding-bottom:6px; margin-bottom:8px; }
  .sym { display:flex; justify-content:space-between; align-items:baseline; padding:6px 0;
         border-bottom:1px dashed var(--border); }
  .sym:last-child { border-bottom:none; }
  .sym .price { font-size:16px; font-weight:bold; }
  .sym .meta { font-size:11px; color:var(--dim); text-align:right; }
  .long { color:var(--green); } .short { color:var(--red); } .neutral { color:var(--dim); }
  .signal { border-left:3px solid var(--border); padding:6px 10px; margin-bottom:8px; background:rgba(255,255,255,.02); }
  .signal.APPROVED { border-color:var(--green); }
  .signal.VETOED { border-color:var(--red); }
  .signal.CANDIDATE { border-color:var(--blue); }
  .signal.INVALIDATED, .signal.EXPIRED { border-color:var(--amber); }
  .signal.CLOSED { border-color:var(--purple); }
  .signal .head { display:flex; gap:8px; justify-content:space-between; }
  .signal .evidence { color:var(--dim); font-size:11px; margin-top:4px; display:none; }
  .signal.open .evidence { display:block; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { padding:4px 8px; text-align:left; border-bottom:1px solid var(--border); }
  th { color:var(--dim); font-weight:normal; }
  .tier-yetersiz { color:var(--dim); } .tier-on { color:var(--amber); }
  .tier-dogrulama { color:var(--blue); } .tier-guvenilir { color:var(--green); }
  #log { max-height:240px; overflow-y:auto; font-size:11px; color:var(--dim); }
  #signals { max-height:420px; overflow-y:auto; }
  .kv { display:flex; justify-content:space-between; padding:2px 0; font-size:12px; }
  .kv b { color:var(--fg); font-weight:normal; }
  .muted { color:var(--dim); }
</style>
</head>
<body>
<header>
  <h1>ICT BOT V5</h1>
  <span class="chip" id="mode">—</span>
  <span class="chip" id="killzone">killzone: —</span>
  <span class="chip" id="embargo">ambargo: —</span>
  <span class="chip" id="riskLock">kilit: —</span>
  <span class="chip" id="conn">bağlanıyor…</span>
  <span class="muted" id="updated" style="margin-left:auto"></span>
</header>
<div class="grid">
  <div class="panel"><h2>Semboller</h2><div id="symbols" class="muted">veri bekleniyor…</div></div>
  <div class="panel" style="grid-row:span 2"><h2>Sinyal Akışı</h2><div id="signals" class="muted">henüz sinyal yok</div></div>
  <div class="panel"><h2>Setup İstatistikleri <span class="muted" style="text-transform:none">(örnek eşiği: &lt;30 yetersiz · &lt;100 ön · &lt;300 doğrulama · ≥300 güvenilir)</span></h2><div id="stats" class="muted">veri birikiyor…</div></div>
  <div class="panel"><h2>Veri Sağlığı</h2><div id="health"></div></div>
  <div class="panel"><h2>Gölge Defter</h2><div id="shadow"></div></div>
  <div class="panel"><h2>Olay Günlüğü</h2><div id="log"></div></div>
</div>
<script>
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c];
    });
  };
  var logLines = [];
  function addLog(line) {
    logLines.unshift(new Date().toLocaleTimeString('tr-TR') + '  ' + line);
    if (logLines.length > 100) logLines.pop();
    $('log').innerHTML = logLines.map(esc).join('<br>');
  }

  function biasClass(b) {
    if (b === 'LONG_BIAS') return 'long';
    if (b === 'SHORT_BIAS') return 'short';
    return 'neutral';
  }

  function renderStatus(s) {
    $('mode').textContent = (s.mode || 'shadow').toUpperCase() + ' MOD';
    $('mode').className = 'chip ok';
    var kz = s.state && s.state.killzone ? s.state.killzone : {};
    $('killzone').textContent = 'killzone: ' + (kz.zone || 'YOK');
    $('killzone').className = 'chip ' + (kz.active ? 'ok' : '');
    var em = s.state && s.state.embargo ? s.state.embargo : {};
    $('embargo').textContent = 'ambargo: ' + (em.active ? 'AKTİF' : 'yok');
    $('embargo').className = 'chip ' + (em.active ? 'warn' : '');
    var lock = s.state ? s.state.riskLock : 'NONE';
    $('riskLock').textContent = 'kilit: ' + lock;
    $('riskLock').className = 'chip ' + (lock === 'NONE' ? '' : 'bad');
    $('updated').textContent = 'güncelleme: ' + new Date(s.time).toLocaleTimeString('tr-TR');

    var html = '';
    (s.symbols || []).forEach(function (row) {
      var mtf = row.mtf || {}; var st = mtf.structurer || {};
      html += '<div class="sym"><div><div class="price">' + esc(row.symbol) + ' ' + (row.price != null ? row.price : '—') + '</div>'
        + '<div class="' + biasClass(st.htfBias) + '">' + esc(st.htfBias || '—') + (st.dolLevel != null ? ' → DOL ' + st.dolLevel : '') + '</div></div>'
        + '<div class="meta">faz: ' + esc(st.phase || '—') + (st.narrativeConfirmed ? ' ✓' : '')
        + (mtf.po3 && mtf.po3.phase && mtf.po3.phase !== 'UNKNOWN'
          ? '<br>PO3: ' + esc(mtf.po3.phase) + (mtf.po3.expectedDelivery ? ' → ' + esc(mtf.po3.expectedDelivery) : '') : '')
        + '<br>rejim: ' + esc(row.regime || '—') + '<br>spread: ' + (row.spread != null ? row.spread.toFixed(6) : '—')
        + '<br>bar: ' + (mtf.bars3m || 0) + '×3m ' + (mtf.bars15m || 0) + '×15M ' + (mtf.bars4h || 0) + '×4H</div></div>';
    });
    // Korelasyon/lead-lag satırı (SMT bağlamı)
    if (s.correlations && s.correlations.length) {
      html += '<div class="meta" style="padding:6px 4px 0">korelasyon: ' + s.correlations.map(function (c) {
        return esc(c.pair) + ' r=' + (c.r != null ? c.r : '—')
          + (c.leader && c.leader.lag > 0 ? ' (öncü: ' + esc(c.leader.symbol) + ' +' + c.leader.lag + ')' : '');
      }).join(' · ') + '</div>';
    }
    if (s.attention) {
      html += '<div class="meta" style="padding:2px 4px 0">dikkat modeli: '
        + (s.attention.promoted ? 'TERFİ EDİLMİŞ (CV ' + (s.attention.metrics && s.attention.metrics.cvMean ? s.attention.metrics.cvMean.toFixed(3) : '—') + ')' : 'önsel (0.6) — veri birikiyor') + '</div>';
    }
    $('symbols').innerHTML = html || '<span class="muted">veri bekleniyor…</span>';

    var f = s.feed || {}; var v = f.verdicts || {}; var b = s.bus || {};
    $('health').innerHTML =
      '<div class="kv"><span>Yoklama / birincil hata / doğrulama hatası</span><b>' + (f.polls||0) + ' / ' + (f.primaryErrors||0) + ' / ' + (f.verificationErrors||0) + '</b></div>'
      + '<div class="kv"><span>Temiz / bad tick / sweep / karantina</span><b>' + (v.CLEAN||0) + ' / ' + (v.BAD_TICK||0) + ' / ' + (v.REAL_SWEEP||0) + ' / ' + (v.QUARANTINED||0) + '</b></div>'
      + '<div class="kv"><span>Kapanan 3m bar</span><b>' + (f.barsClosed||0) + '</b></div>'
      + '<div class="kv"><span>Bus: yayın / ret / TTL düşen</span><b>' + (b.published||0) + ' / ' + (b.rejectedInvalid||0) + ' / ' + (b.droppedExpired||0) + '</b></div>'
      + (f.wsTicks != null ? '<div class="kv"><span>WS tick</span><b>' + f.wsTicks + '</b></div>' : '');

    var sh = s.shadow || {}; var va = s.vetoAccuracy || {}; var ac = s.account || {};
    var pnlClass = (ac.equity || 0) >= (ac.startingEquity || 0) ? 'long' : 'short';
    $('shadow').innerHTML =
      (ac.equity != null
        ? '<div class="kv"><span>Bakiye (sanal)</span><b class="' + pnlClass + '">' + ac.equity.toFixed(2) + '$ <span class="muted">(başlangıç ' + ac.startingEquity + '$)</span></b></div>'
        + '<div class="kv"><span>Gün PnL / Günlük DD / Toplam DD</span><b>' + (ac.dailyPnl||0).toFixed(2) + '$ / %' + (ac.dailyDDPct||0).toFixed(2) + ' / %' + (ac.totalDDPct||0).toFixed(2) + '</b></div>'
        + equitySparkline(s.equityCurve || [])
        : '')
      + '<div class="kv"><span>İşlem (K/Z)</span><b>' + (sh.total||0) + ' (' + (sh.wins||0) + '/' + (sh.losses||0) + ')</b></div>'
      + '<div class="kv"><span>Kazanma oranı / Toplam R / Ort R</span><b>' + (sh.winRate != null ? (sh.winRate*100).toFixed(1) + '%' : '—') + ' / ' + (sh.totalR != null ? sh.totalR : '—') + ' / ' + (sh.avgR != null ? sh.avgR : '—') + '</b></div>'
      + '<div class="kv"><span>Net PnL (sanal)</span><b>' + (sh.netPnl != null ? sh.netPnl.toFixed(2) : '0') + '</b></div>'
      + '<div class="kv"><span>Açık / veto kaydı</span><b>' + (sh.openCount||0) + ' / ' + (sh.rejectedCount||0) + '</b></div>'
      + '<div class="kv"><span>Veto isabeti</span><b>' + (va.accuracy != null ? (va.accuracy*100).toFixed(0) + '% (' + va.resolved + ' çözüldü)' : 'veri yok') + '</b></div>';

    if (s.setupStats && s.setupStats.length) {
      var rows = s.setupStats.map(function (r) {
        return '<tr><td>' + esc(r.family) + '</td><td>' + esc(r.regime) + '</td><td>' + esc(r.killzone) + '</td>'
          + '<td>' + r.samples + '</td><td>' + (r.winRate != null ? (r.winRate*100).toFixed(0) + '%' : '—') + '</td>'
          + '<td class="tier-' + r.tierClass + '">' + esc(r.tier) + '</td></tr>';
      }).join('');
      $('stats').innerHTML = '<table><tr><th>Aile</th><th>Rejim</th><th>Killzone</th><th>n</th><th>Kazanç</th><th>Güven katmanı</th></tr>' + rows + '</table>';
    }
    renderSignals(s.signals || []);
  }

  /** Equity eğrisi: bağımlılıksız mini SVG çizgi grafiği. */
  function equitySparkline(points) {
    if (!points || points.length < 2) return '<div class="muted" style="padding:4px 0">equity eğrisi: ilk işlem kapanışını bekliyor</div>';
    var w = 280, h = 48;
    var vals = points.map(function (p) { return p.equity; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || 1;
    var path = points.map(function (p, i) {
      var x = (i / (points.length - 1)) * w;
      var y = h - ((p.equity - min) / span) * (h - 4) - 2;
      return (i ? 'L' : 'M') + x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var up = vals[vals.length - 1] >= vals[0];
    return '<svg width="' + w + '" height="' + h + '" style="display:block;margin:6px 0">'
      + '<path d="' + path + '" fill="none" stroke="' + (up ? '#4ade80' : '#f87171') + '" stroke-width="1.5"/></svg>';
  }

  var signalMap = {};
  function renderSignals(list) {
    list.forEach(function (sg) { signalMap[sg.id] = sg; });
    var arr = Object.values(signalMap).sort(function (a, b) { return b.createdAt - a.createdAt; }).slice(0, 40);
    if (!arr.length) { $('signals').innerHTML = '<span class="muted">henüz sinyal yok</span>'; return; }
    $('signals').innerHTML = arr.map(function (sg) {
      var side = sg.side === 'BUY' ? '<span class="long">ALIŞ</span>' : '<span class="short">SATIŞ</span>';
      var extra = '';
      if (sg.vetoReason) extra = '<div class="muted">veto: ' + esc(sg.vetoReason) + '</div>';
      if (sg.invalidationReason) extra = '<div class="muted">geri çekildi: ' + esc(sg.invalidationReason) + '</div>';
      if (sg.outcome) extra = '<div>' + (sg.outcome === 'WIN' ? '🎯 HEDEF' : '🛑 STOP') + ' @ ' + sg.exit + '</div>';
      if (sg.hypotheticalOutcome) extra += '<div class="muted">hipotetik: ' + esc(sg.hypotheticalOutcome) + '</div>';
      return '<div class="signal ' + esc(sg.status) + '" onclick="this.classList.toggle(\\'open\\')">'
        + '<div class="head"><span><b>' + esc(sg.symbol) + '</b> ' + side + ' <span class="muted">' + esc(sg.setupFamily) + '</span></span>'
        + '<span>' + esc(sg.status) + '</span></div>'
        + '<div>giriş ' + sg.entry + ' · stop ' + sg.stop + ' · hedef ' + esc((sg.targets||[]).join(', ')) + ' · RR ' + sg.rr + ' · güven ' + Math.round((sg.confidence||0)*100) + '%</div>'
        + extra
        + '<div class="evidence">' + (sg.evidence||[]).map(esc).join('<br>') + '</div></div>';
    }).join('');
  }

  fetch('/api/snapshot').then(function (r) { return r.json(); }).then(renderStatus).catch(function () {});

  var es = new EventSource('/events');
  es.onopen = function () { $('conn').textContent = 'canlı'; $('conn').className = 'chip ok'; };
  es.onerror = function () { $('conn').textContent = 'bağlantı koptu'; $('conn').className = 'chip bad'; };
  es.addEventListener('status', function (e) { renderStatus(JSON.parse(e.data)); });
  es.addEventListener('signal', function (e) {
    var d = JSON.parse(e.data);
    signalMap[d.signal.id] = d.signal;
    renderSignals([]);
    addLog('[' + d.type + '] ' + d.signal.symbol + ' ' + d.signal.side + ' @ ' + d.signal.entry);
  });
})();
</script>
</body>
</html>`;

export default DASHBOARD_HTML;
