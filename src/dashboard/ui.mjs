/**
 * Dashboard UI — tek dosya, sıfır bağımlılık, profesyonel dark tema.
 *
 * Mum grafiği: vanilla <canvas> (devicePixelRatio farkındalıklı), DOL ve
 * son fiyat çizgileriyle. Veri /api/bars'tan; durum /api/snapshot + SSE.
 * Görsel dil: cam kartlar (backdrop blur), katmanlı gölgeler (derinlik),
 * neon vurgular — harici font/kütüphane YOK (hotspot'ta da anında açılır).
 */

export const DASHBOARD_HTML = /* html */ `<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ICT BOT V5 — Komuta Merkezi</title>
<style>
  :root {
    --bg0: #070b14; --bg1: #0b1120; --panel: rgba(17, 25, 40, 0.72);
    --border: rgba(120, 150, 200, 0.14); --border-hi: rgba(120, 180, 255, 0.35);
    --text: #d7e1f0; --muted: #74819c; --accent: #38bdf8;
    --green: #34d399; --red: #f87171; --amber: #fbbf24;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font: 13px/1.5 'SF Mono', 'Cascadia Code', Consolas, monospace;
    color: var(--text); min-height: 100vh;
    background:
      radial-gradient(1200px 600px at 15% -10%, rgba(56,189,248,.10), transparent 60%),
      radial-gradient(900px 500px at 90% 0%, rgba(52,211,153,.07), transparent 55%),
      linear-gradient(180deg, var(--bg0), var(--bg1) 40%, var(--bg0));
    background-attachment: fixed;
  }
  header {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 14px 20px; position: sticky; top: 0; z-index: 10;
    background: rgba(7, 11, 20, 0.82); backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--border);
  }
  h1 {
    font-size: 17px; letter-spacing: 2.5px; color: #fff;
    text-shadow: 0 0 18px rgba(56,189,248,.65);
  }
  h1 b { color: var(--accent); }
  .chip {
    padding: 3px 12px; border-radius: 999px; font-size: 11px; letter-spacing: .5px;
    border: 1px solid var(--border); background: rgba(255,255,255,.03); color: var(--muted);
  }
  .chip.ok { color: var(--green); border-color: rgba(52,211,153,.45); box-shadow: 0 0 12px rgba(52,211,153,.18); }
  .chip.warn { color: var(--amber); border-color: rgba(251,191,36,.45); box-shadow: 0 0 12px rgba(251,191,36,.18); }
  .chip.bad { color: var(--red); border-color: rgba(248,113,113,.5); box-shadow: 0 0 12px rgba(248,113,113,.22); }
  .grid {
    display: grid; gap: 14px; padding: 16px 20px 28px;
    grid-template-columns: repeat(12, 1fr);
  }
  .panel {
    background: var(--panel); backdrop-filter: blur(10px);
    border: 1px solid var(--border); border-radius: 14px; padding: 14px 16px;
    box-shadow: 0 10px 30px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.04);
    transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
  }
  .panel:hover {
    transform: translateY(-2px); border-color: var(--border-hi);
    box-shadow: 0 16px 40px rgba(0,0,0,.55), 0 0 24px rgba(56,189,248,.06), inset 0 1px 0 rgba(255,255,255,.05);
  }
  .panel h2 {
    font-size: 11px; letter-spacing: 2px; text-transform: uppercase;
    color: var(--accent); margin-bottom: 10px; display: flex; align-items: center; gap: 8px;
  }
  .panel h2::before { content: ''; width: 7px; height: 7px; border-radius: 50%;
    background: var(--accent); box-shadow: 0 0 8px var(--accent); }
  .span6 { grid-column: span 6; } .span4 { grid-column: span 4; }
  .span8 { grid-column: span 8; } .span12 { grid-column: span 12; }
  @media (max-width: 1100px) { .span6, .span4, .span8 { grid-column: span 12; } }
  .muted { color: var(--muted); }
  .long { color: var(--green); } .short { color: var(--red); } .neutral { color: var(--muted); }
  .kv { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0;
    border-bottom: 1px dashed rgba(120,150,200,.08); }
  .kv:last-child { border-bottom: none; }
  .tabs { display: flex; gap: 6px; margin-left: auto; }
  .tab {
    padding: 3px 12px; border-radius: 8px; cursor: pointer; font-size: 11px;
    border: 1px solid var(--border); color: var(--muted); background: transparent;
    font-family: inherit; transition: all .15s;
  }
  .tab:hover { color: var(--text); border-color: var(--border-hi); }
  .tab.on { color: #06121f; background: var(--accent); border-color: var(--accent);
    box-shadow: 0 0 14px rgba(56,189,248,.4); font-weight: 700; }
  canvas { width: 100%; display: block; border-radius: 10px; }
  .sym { display: flex; justify-content: space-between; gap: 8px; padding: 9px 10px;
    border: 1px solid var(--border); border-radius: 10px; margin-bottom: 8px;
    background: rgba(255,255,255,.02); }
  .price { font-size: 15px; font-weight: 700; color: #fff; }
  .meta { font-size: 11px; color: var(--muted); text-align: right; }
  table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
  th { text-align: left; color: var(--muted); font-weight: 400; padding: 3px 8px 6px 0;
    border-bottom: 1px solid var(--border); letter-spacing: .5px; }
  td { padding: 4px 8px 4px 0; border-bottom: 1px dashed rgba(120,150,200,.07); }
  .tier-yetersiz { color: var(--muted); } .tier-on { color: var(--amber); }
  .tier-dogrulama { color: var(--accent); } .tier-guvenilir { color: var(--green); }
  .signal { border: 1px solid var(--border); border-left: 3px solid var(--muted);
    border-radius: 10px; padding: 9px 12px; margin-bottom: 8px; cursor: pointer;
    background: rgba(255,255,255,.02); transition: border-color .15s; }
  .signal:hover { border-color: var(--border-hi); }
  .signal.APPROVED { border-left-color: var(--green); }
  .signal.VETOED { border-left-color: var(--red); }
  .signal.CLOSED { border-left-color: var(--accent); }
  .signal.INVALIDATED, .signal.EXPIRED { border-left-color: var(--amber); }
  .signal .head { display: flex; justify-content: space-between; margin-bottom: 3px; }
  .signal .evidence { display: none; margin-top: 6px; padding-top: 6px;
    border-top: 1px dashed var(--border); color: var(--muted); font-size: 11px; }
  .signal.open .evidence { display: block; }
  #log { max-height: 200px; overflow-y: auto; font-size: 11px; color: var(--muted); }
</style>
</head>
<body>
<header>
  <h1>ICT <b>BOT</b> V5</h1>
  <span class="chip" id="mode">—</span>
  <span class="chip" id="killzone">killzone: —</span>
  <span class="chip" id="embargo">ambargo: —</span>
  <span class="chip" id="riskLock">kilit: —</span>
  <span class="chip" id="conn">bağlanıyor…</span>
  <span class="muted" id="updated" style="margin-left:auto"></span>
</header>
<div class="grid">
  <div class="panel span8">
    <h2>Grafik <span id="chartTitle" class="muted" style="text-transform:none;letter-spacing:0"></span>
      <span class="tabs" id="symTabs"></span>
      <span class="tabs" id="tfTabs"></span>
    </h2>
    <canvas id="chart" height="380"></canvas>
  </div>
  <div class="panel span4"><h2>Semboller</h2><div id="symbols" class="muted">veri bekleniyor…</div></div>
  <div class="panel span4" style="grid-row:span 2"><h2>Sinyal Akışı</h2><div id="signals" class="muted">henüz sinyal yok</div></div>
  <div class="panel span4"><h2>Gölge Defter</h2><div id="shadow"></div></div>
  <div class="panel span4"><h2>Setup İstatistikleri <span class="muted" style="text-transform:none;letter-spacing:0">(&lt;30 yetersiz · &lt;100 ön · &lt;300 doğrulama · ≥300 güvenilir)</span></h2><div id="stats" class="muted">veri birikiyor…</div></div>
  <div class="panel span4"><h2>Veri Sağlığı</h2><div id="health"></div></div>
  <div class="panel span4"><h2>Olay Günlüğü</h2><div id="log"></div></div>
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
    return b === 'LONG_BIAS' ? 'long' : b === 'SHORT_BIAS' ? 'short' : 'neutral';
  }

  // --- Mum grafiği (vanilla canvas) ---
  var chart = { symbol: null, tf: '15M', symbols: [], dol: null, lastPrice: null };

  function drawCandles(bars) {
    var canvas = $('chart');
    var dpr = window.devicePixelRatio || 1;
    var W = canvas.clientWidth, H = 380;
    canvas.width = W * dpr; canvas.height = H * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, W, H);
    if (!bars || bars.length < 2) {
      ctx.fillStyle = '#74819c'; ctx.font = '13px monospace';
      ctx.fillText('bar verisi bekleniyor… (3m barlar canlı akışla birikir)', 20, H / 2);
      return;
    }
    var padL = 8, padR = 64, padT = 14, padB = 22;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var lo = Infinity, hi = -Infinity;
    bars.forEach(function (b) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; });
    if (chart.dol != null) { lo = Math.min(lo, chart.dol); hi = Math.max(hi, chart.dol); }
    var span = (hi - lo) || 1; lo -= span * 0.04; hi += span * 0.04; span = hi - lo;
    var y = function (p) { return padT + (1 - (p - lo) / span) * plotH; };
    var slot = plotW / bars.length;
    var cw = Math.max(1.5, Math.min(11, slot * 0.62));

    // Izgara + fiyat etiketleri
    ctx.strokeStyle = 'rgba(120,150,200,.08)'; ctx.fillStyle = '#74819c';
    ctx.font = '10px monospace'; ctx.textAlign = 'left';
    for (var g = 0; g <= 4; g++) {
      var gy = padT + (plotH * g) / 4;
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(W - padR, gy); ctx.stroke();
      ctx.fillText(fmtPrice(hi - (span * g) / 4), W - padR + 6, gy + 3);
    }
    // Zaman etiketleri (ilk/orta/son)
    [0, Math.floor(bars.length / 2), bars.length - 1].forEach(function (i) {
      var t = new Date(bars[i].openTime);
      ctx.fillText(t.getHours().toString().padStart(2, '0') + ':' + t.getMinutes().toString().padStart(2, '0'),
        padL + i * slot, H - 7);
    });

    // Mumlar
    bars.forEach(function (b, i) {
      var x = padL + i * slot + slot / 2;
      var up = b.close >= b.open;
      var color = up ? '#34d399' : '#f87171';
      ctx.strokeStyle = color; ctx.fillStyle = color;
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y(b.high)); ctx.lineTo(x, y(b.low)); ctx.stroke();
      var top = y(Math.max(b.open, b.close)), bot = y(Math.min(b.open, b.close));
      ctx.fillRect(x - cw / 2, top, cw, Math.max(1, bot - top));
    });

    // DOL çizgisi (4H hedef likidite)
    if (chart.dol != null && chart.dol >= lo && chart.dol <= hi) {
      ctx.strokeStyle = '#fbbf24'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(padL, y(chart.dol)); ctx.lineTo(W - padR, y(chart.dol)); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#fbbf24'; ctx.fillText('DOL ' + fmtPrice(chart.dol), W - padR + 6, y(chart.dol) + 3);
    }
    // Son fiyat çizgisi
    var last = bars[bars.length - 1].close;
    var lp = chart.lastPrice != null ? chart.lastPrice : last;
    ctx.strokeStyle = '#38bdf8'; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(padL, y(lp)); ctx.lineTo(W - padR, y(lp)); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#38bdf8'; ctx.fillText(fmtPrice(lp), W - padR + 6, y(lp) + 3);
  }
  function fmtPrice(p) {
    return p >= 1000 ? p.toFixed(1) : p >= 10 ? p.toFixed(2) : p.toFixed(5);
  }

  function loadBars() {
    if (!chart.symbol) return;
    fetch('/api/bars?symbol=' + chart.symbol + '&tf=' + chart.tf)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        $('chartTitle').textContent = '— ' + chart.symbol + ' · ' + chart.tf + ' (' + d.bars.length + ' bar)';
        drawCandles(d.bars);
      })
      .catch(function () {});
  }

  function renderTabs() {
    $('symTabs').innerHTML = chart.symbols.map(function (s) {
      return '<button class="tab' + (s === chart.symbol ? ' on' : '') + '" data-sym="' + esc(s) + '">' + esc(s.replace('USD', '')) + '</button>';
    }).join('');
    var tfs = ['3m', '15M', '4H'];
    $('tfTabs').innerHTML = tfs.map(function (t) {
      return '<button class="tab' + (t === chart.tf ? ' on' : '') + '" data-tf="' + t + '">' + t + '</button>';
    }).join('');
  }
  document.addEventListener('click', function (e) {
    if (e.target.dataset && e.target.dataset.sym) { chart.symbol = e.target.dataset.sym; renderTabs(); loadBars(); }
    if (e.target.dataset && e.target.dataset.tf) { chart.tf = e.target.dataset.tf; renderTabs(); loadBars(); }
  });

  // --- Durum render ---
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

    var syms = (s.symbols || []).map(function (r) { return r.symbol; });
    if (syms.length && !chart.symbol) { chart.symbols = syms; chart.symbol = syms[0]; renderTabs(); loadBars(); }
    chart.symbols = syms;

    var html = '';
    (s.symbols || []).forEach(function (row) {
      var mtf = row.mtf || {}; var st = mtf.structurer || {};
      if (row.symbol === chart.symbol) {
        chart.dol = st.dolLevel != null ? st.dolLevel : null;
        chart.lastPrice = row.price != null ? row.price : null;
      }
      html += '<div class="sym"><div><div class="price">' + esc(row.symbol) + ' ' + (row.price != null ? row.price : '—') + '</div>'
        + '<div class="' + biasClass(st.htfBias) + '">' + esc(st.htfBias || '—') + (st.dolLevel != null ? ' → DOL ' + st.dolLevel : '') + '</div></div>'
        + '<div class="meta">faz: ' + esc(st.phase || '—') + (st.narrativeConfirmed ? ' ✓' : '')
        + (mtf.po3 && mtf.po3.phase && mtf.po3.phase !== 'UNKNOWN'
          ? '<br>PO3: ' + esc(mtf.po3.phase) + (mtf.po3.expectedDelivery ? ' → ' + esc(mtf.po3.expectedDelivery) : '') : '')
        + '<br>rejim: ' + esc(row.regime || '—') + ' · spread: ' + (row.spread != null ? row.spread.toFixed(6) : '—')
        + '<br>bar: ' + (mtf.bars3m || 0) + '×3m ' + (mtf.bars15m || 0) + '×15M ' + (mtf.bars4h || 0) + '×4H</div></div>';
    });
    if (s.correlations && s.correlations.length) {
      html += '<div class="meta" style="padding:6px 4px 0;text-align:left">korelasyon: ' + s.correlations.map(function (c) {
        return esc(c.pair) + ' r=' + (c.r != null ? c.r : '—')
          + (c.leader && c.leader.lag > 0 ? ' (öncü: ' + esc(c.leader.symbol) + ' +' + c.leader.lag + ')' : '');
      }).join(' · ') + '</div>';
    }
    if (s.attention) {
      html += '<div class="meta" style="padding:2px 4px 0;text-align:left">dikkat modeli: '
        + (s.attention.promoted ? 'TERFİ EDİLMİŞ (CV ' + (s.attention.metrics && s.attention.metrics.cvMean ? s.attention.metrics.cvMean.toFixed(3) : '—') + ')' : 'önsel (0.6) — veri birikiyor') + '</div>';
    }
    $('symbols').innerHTML = html || '<span class="muted">veri bekleniyor…</span>';

    var f = s.feed || {}; var v = f.verdicts || {}; var b = s.bus || {};
    $('health').innerHTML =
      '<div class="kv"><span>Yoklama / birincil / doğrulama hatası</span><b>' + (f.polls||0) + ' / ' + (f.primaryErrors||0) + ' / ' + (f.verificationErrors||0) + '</b></div>'
      + '<div class="kv"><span>WS tick (push)</span><b>' + (f.pushTicks||0) + '</b></div>'
      + '<div class="kv"><span>Temiz / bad / sweep / karantina</span><b>' + (v.CLEAN||0) + ' / ' + (v.BAD_TICK||0) + ' / ' + (v.REAL_SWEEP||0) + ' / ' + (v.QUARANTINED||0) + '</b></div>'
      + '<div class="kv"><span>Kapanan 3m bar</span><b>' + (f.barsClosed||0) + '</b></div>'
      + '<div class="kv"><span>Bus: yayın / ret / TTL düşen</span><b>' + (b.published||0) + ' / ' + (b.rejectedInvalid||0) + ' / ' + (b.droppedExpired||0) + '</b></div>';

    var sh = s.shadow || {}; var va = s.vetoAccuracy || {}; var ac = s.account || {};
    var pnlClass = (ac.equity || 0) >= (ac.startingEquity || 0) ? 'long' : 'short';
    $('shadow').innerHTML =
      (ac.equity != null
        ? '<div class="kv"><span>Bakiye (sanal)</span><b class="' + pnlClass + '">' + ac.equity.toFixed(2) + '$ <span class="muted">(başlangıç ' + ac.startingEquity + '$)</span></b></div>'
        + '<div class="kv"><span>Gün PnL / Günlük DD / Toplam DD</span><b>' + (ac.dailyPnl||0).toFixed(2) + '$ / %' + (ac.dailyDDPct||0).toFixed(2) + ' / %' + (ac.totalDDPct||0).toFixed(2) + '</b></div>'
        + equitySparkline(s.equityCurve || [])
        : '')
      + '<div class="kv"><span>İşlem (K/Z)</span><b>' + (sh.total||0) + ' (' + (sh.wins||0) + '/' + (sh.losses||0) + ')</b></div>'
      + '<div class="kv"><span>Kazanma / Toplam R / Ort R</span><b>' + (sh.winRate != null ? (sh.winRate*100).toFixed(1) + '%' : '—') + ' / ' + (sh.totalR != null ? sh.totalR : '—') + ' / ' + (sh.avgR != null ? sh.avgR : '—') + '</b></div>'
      + '<div class="kv"><span>Net PnL (sanal)</span><b>' + (sh.netPnl != null ? sh.netPnl.toFixed(2) : '0') + '</b></div>'
      + '<div class="kv"><span>Açık / veto kaydı</span><b>' + (sh.openCount||0) + ' / ' + (sh.rejectedCount||0) + '</b></div>'
      + '<div class="kv"><span>Veto isabeti</span><b>' + (va.accuracy != null ? (va.accuracy*100).toFixed(0) + '% (' + va.resolved + ' çözüldü)' : 'veri yok') + '</b></div>';

    if (s.setupStats && s.setupStats.length) {
      var rows = s.setupStats.map(function (r) {
        return '<tr><td>' + esc(r.family) + '</td><td>' + esc(r.regime) + '</td><td>' + esc(r.killzone) + '</td>'
          + '<td>' + r.samples + '</td><td>' + (r.winRate != null ? (r.winRate*100).toFixed(0) + '%' : '—') + '</td>'
          + '<td>' + (r.avgR != null ? r.avgR : '—') + '</td><td>' + (r.fillRate != null ? (r.fillRate*100).toFixed(0) + '%' : '—') + '</td>'
          + '<td class="tier-' + r.tierClass + '">' + esc(r.tier) + '</td></tr>';
      }).join('');
      $('stats').innerHTML = '<table><tr><th>Aile</th><th>Rejim</th><th>KZ</th><th>n</th><th>Kazanç</th><th>Ort R</th><th>Fill</th><th>Güven</th></tr>' + rows + '</table>';
    }
    renderSignals(s.signals || []);
  }

  /** Equity eğrisi: mini SVG çizgi grafiği. */
  function equitySparkline(points) {
    if (!points || points.length < 2) return '<div class="muted" style="padding:4px 0">equity eğrisi: ilk işlem kapanışını bekliyor</div>';
    var w = 280, h = 48;
    var vals = points.map(function (p) { return p.equity; });
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = (max - min) || 1;
    var path = points.map(function (p, i) {
      var x = (i / (points.length - 1)) * w;
      var yy = h - ((p.equity - min) / span) * (h - 4) - 2;
      return (i ? 'L' : 'M') + x.toFixed(1) + ',' + yy.toFixed(1);
    }).join(' ');
    var up = vals[vals.length - 1] >= vals[0];
    return '<svg width="' + w + '" height="' + h + '" style="display:block;margin:6px 0">'
      + '<path d="' + path + '" fill="none" stroke="' + (up ? '#34d399' : '#f87171') + '" stroke-width="1.5"/></svg>';
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
      if (sg.unfilled) extra = '<div class="muted">⏱ fill olmadı: ' + esc(sg.unfilledReason || '') + '</div>';
      if (sg.outcome) extra = '<div>' + (sg.outcome === 'WIN' ? '🎯 HEDEF' : '🛑 STOP') + ' @ ' + sg.exit + (sg.rMultiple != null ? ' · ' + sg.rMultiple + 'R' : '') + '</div>';
      if (sg.hypotheticalOutcome) extra += '<div class="muted">hipotetik: ' + esc(sg.hypotheticalOutcome) + '</div>';
      return '<div class="signal ' + esc(sg.status) + '" onclick="this.classList.toggle(\\'open\\')">'
        + '<div class="head"><span><b>' + esc(sg.symbol) + '</b> ' + side + ' <span class="muted">' + esc(sg.setupFamily) + '</span></span>'
        + '<span>' + esc(sg.status) + '</span></div>'
        + '<div>giriş ' + sg.entry + ' · stop ' + sg.stop + ' · hedef ' + esc((sg.targets||[]).join(', ')) + ' · RR ' + sg.rr + ' · güven ' + Math.round((sg.confidence||0)*100) + '%</div>'
        + extra
        + '<div class="evidence">' + (sg.evidence||[]).map(esc).join('<br>') + '</div></div>';
    }).join('');
  }

  // --- Veri akışı: snapshot + SSE ---
  function refresh() {
    fetch('/api/snapshot').then(function (r) { return r.json(); }).then(renderStatus).catch(function () {});
  }
  refresh();
  setInterval(refresh, 10000);
  setInterval(loadBars, 15000);

  var es = new EventSource('/events');
  es.onopen = function () { $('conn').textContent = 'canlı'; $('conn').className = 'chip ok'; };
  es.onerror = function () { $('conn').textContent = 'koptu — yeniden bağlanıyor'; $('conn').className = 'chip bad'; };
  es.addEventListener('status', function (e) {
    try { renderStatus(JSON.parse(e.data)); } catch (err) {}
  });
  es.addEventListener('signal', function (e) {
    try {
      var d = JSON.parse(e.data);
      addLog('[sinyal] ' + d.type + ' ' + (d.signal && d.signal.symbol ? d.signal.symbol : ''));
      if (d.signal) renderSignals([d.signal]);
    } catch (err) {}
  });
})();
</script>
</body>
</html>`;

export default DASHBOARD_HTML;
