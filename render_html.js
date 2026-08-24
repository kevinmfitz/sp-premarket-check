// Renders the pre-market conditions data into the dashboard HTML (Artifact body content —
// no <!doctype>/<html>/<head>/<body> wrapper; <title> and <style> sit at the top of the file).

function fmt(n, d = 2) { return n == null ? "—" : n.toFixed(d); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }

function buildDashboardHtml({ levels, events, clusters, threshold, rangeRead, breakoutNotes }) {
  const { currentPrice, PDH, PDL, ONH, ONL, sessionDate, gapPoints, currentOnRange, avgOnRange20, onRangeSampleSize } = levels;

  // --- Ladder positions -----------------------------------------------
  const points = [
    { key: "PDH", label: "Previous Day High", value: PDH, cls: "lvl-pdh" },
    { key: "ONH", label: "Overnight High", value: ONH, cls: "lvl-onh" },
    { key: "NOW", label: "Current (ES)", value: currentPrice, cls: "lvl-now" },
    { key: "ONL", label: "Overnight Low", value: ONL, cls: "lvl-onl" },
    { key: "PDL", label: "Previous Day Low", value: PDL, cls: "lvl-pdl" },
  ].filter(p => p.value != null);

  const vals = points.map(p => p.value);
  const rawMin = Math.min(...vals), rawMax = Math.max(...vals);
  const pad = Math.max(2, (rawMax - rawMin) * 0.18);
  const min = rawMin - pad, max = rawMax + pad;
  const pct = (v) => 100 - ((v - min) / (max - min)) * 100;

  // Collapse markers that sit within ~3.5% of vertical space to avoid label overlap
  const sorted = [...points].sort((a, b) => b.value - a.value);
  const laneOf = new Map();
  let lastPct = -999, lane = 0;
  for (const p of sorted) {
    const y = pct(p.value);
    lane = (y - lastPct < 7) ? (lane === 0 ? 1 : 0) : 0;
    laneOf.set(p.key, lane);
    lastPct = y;
  }

  const ladderMarkers = points.map(p => {
    const y = pct(p.value).toFixed(2);
    const lane = laneOf.get(p.key);
    return `
      <div class="rung ${p.cls} ${p.key === 'NOW' ? 'rung-now' : ''}" style="top:${y}%">
        <div class="rung-line"></div>
        <div class="rung-dot"></div>
        <div class="rung-tag lane-${lane}">
          <span class="rung-key">${p.key}</span>
          <span class="rung-val">${fmt(p.value)}</span>
        </div>
      </div>`;
  }).join("");

  // --- Confluence chips -------------------------------------------------
  const confluenceHtml = clusters.length
    ? clusters.map(c => `<div class="chip chip-confluence"><span class="chip-dot"></span>${c.a} &amp; ${c.b} — ${fmt(c.distance)} pts apart</div>`).join("")
    : `<div class="chip chip-muted">No levels within ${threshold} pts — no confluence zone today</div>`;

  // --- Range gauge --------------------------------------------------
  const ratio = (avgOnRange20 && currentOnRange != null) ? currentOnRange / avgOnRange20 : null;
  const gaugePct = ratio == null ? 50 : Math.min(100, Math.max(0, (ratio / 2) * 100));
  const rangeClass = rangeRead === "Tight" ? "range-tight" : rangeRead === "Wide" ? "range-wide" : "range-normal";
  const rangeNote = rangeRead === "Tight"
    ? "Levels are bunched close together — watch for lower-quality, choppy sweeps."
    : rangeRead === "Wide"
      ? "A lot has already moved overnight — a reversal (Sweep &amp; Reclaim) may be more likely than fresh continuation."
      : "Overnight range is in its normal band — no unusual skew toward either setup.";

  // --- Gap readout ----------------------------------------------------
  const gapSign = gapPoints >= 0 ? "+" : "";
  const gapDir = gapPoints > 0 ? "up" : gapPoints < 0 ? "down" : "flat";

  // --- Calendar ---------------------------------------------------
  const calendarHtml = events.length
    ? events.map(e => `
      <div class="cal-row">
        <span class="pill pill-${e.impact}">${esc(e.impact)}</span>
        <span class="cal-time">${esc(e.time)}</span>
        <span class="cal-name">${esc(e.event)}</span>
      </div>`).join("")
    : `<div class="cal-empty">No high-impact scheduled releases today.</div>`;

  const breakoutHtml = breakoutNotes.length
    ? breakoutNotes.map(n => `<div class="chip chip-breakout">${esc(n)}</div>`).join("")
    : `<div class="chip chip-muted">Price is inside all four levels — nothing broken pre-market</div>`;

  const generatedAt = new Date().toLocaleString("en-US", { timeZone: "America/New_York", dateStyle: "medium", timeStyle: "short" });
  const sessionDateLong = new Date(sessionDate + "T12:00:00Z").toLocaleDateString("en-US", { timeZone: "America/New_York", weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return `<title>S&amp;P Pre-Market Board</title>
<style>
  :root{
    --bg:#f5f1e6; --surface:#ffffff; --surface-2:#eee7d4; --border:#ddd3b8;
    --ink:#221d13; --ink-dim:#6f6650; --ink-faint:#a89d80;
    --accent:#a8641c; --accent-ink:#ffffff;
    --steel:#5d7285;
    --bull:#1f7a4d; --bull-bg:#e4f1e9;
    --bear:#b23b3b; --bear-bg:#fbe9e7;
    --warn:#a8641c; --warn-bg:#f6e9d6;
    --high:#a8341c; --high-bg:#f8e2da;
    --shadow: 0 1px 2px rgba(34,29,19,0.06), 0 8px 24px -12px rgba(34,29,19,0.18);
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --bg:#10141c; --surface:#161b25; --surface-2:#1e2430; --border:#2b3341;
      --ink:#eae6da; --ink-dim:#93a0af; --ink-faint:#5d6a7a;
      --accent:#dba54c; --accent-ink:#1a1206;
      --steel:#8ea3b8;
      --bull:#3fcb85; --bull-bg:#123423;
      --bear:#ef6a63; --bear-bg:#3a1a1a;
      --warn:#dba54c; --warn-bg:#3a2c12;
      --high:#ef7a52; --high-bg:#3a1f14;
      --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px -16px rgba(0,0,0,0.6);
    }
  }
  :root[data-theme="dark"]{
    --bg:#10141c; --surface:#161b25; --surface-2:#1e2430; --border:#2b3341;
    --ink:#eae6da; --ink-dim:#93a0af; --ink-faint:#5d6a7a;
    --accent:#dba54c; --accent-ink:#1a1206;
    --steel:#8ea3b8;
    --bull:#3fcb85; --bull-bg:#123423;
    --bear:#ef6a63; --bear-bg:#3a1a1a;
    --warn:#dba54c; --warn-bg:#3a2c12;
    --high:#ef7a52; --high-bg:#3a1f14;
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 12px 32px -16px rgba(0,0,0,0.6);
  }

  *{box-sizing:border-box;}
  body{
    margin:0; background:var(--bg); color:var(--ink);
    font-family:"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif;
    -webkit-font-smoothing:antialiased;
  }
  .wrap{ max-width:760px; margin:0 auto; padding:2.25rem 1.25rem 4rem; }

  .masthead{ display:flex; align-items:baseline; justify-content:space-between; gap:1rem; flex-wrap:wrap; margin-bottom:0.35rem; }
  .masthead h1{ font-size:1.05rem; font-weight:600; letter-spacing:0.02em; text-transform:uppercase; color:var(--ink-dim); margin:0; }
  .masthead .ticker{ font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:0.85rem; color:var(--ink-faint); }
  .session-date{ font-size:1.9rem; font-weight:600; margin:0.15rem 0 1.6rem; text-wrap:balance; }

  .summary-bar{
    display:flex; align-items:center; justify-content:space-between; gap:1rem;
    background:var(--surface); border:1px solid var(--border); border-radius:14px;
    padding:1.1rem 1.4rem; box-shadow:var(--shadow); margin-bottom:1.75rem;
  }
  .summary-price{ font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:2.1rem; font-weight:600; font-variant-numeric:tabular-nums; }
  .summary-price small{ font-size:0.95rem; font-weight:500; color:var(--ink-dim); margin-left:0.4rem; }
  .summary-gap{ text-align:right; }
  .summary-gap .gap-val{ font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:1.15rem; font-weight:600; font-variant-numeric:tabular-nums; }
  .summary-gap .gap-val.up{ color:var(--bull); }
  .summary-gap .gap-val.down{ color:var(--bear); }
  .summary-gap .gap-label{ font-size:0.72rem; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-faint); }

  section{ margin-bottom:2.1rem; }
  .section-label{ font-size:0.75rem; font-weight:600; text-transform:uppercase; letter-spacing:0.08em; color:var(--ink-faint); margin:0 0 0.7rem; }

  /* ---- Ladder ---- */
  .ladder-card{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:1.5rem 1.5rem 1.5rem 1rem; box-shadow:var(--shadow); }
  .ladder{ position:relative; height:220px; margin:0.5rem 2.6rem 0 0.75rem; }
  .ladder::before{ content:""; position:absolute; left:0; top:0; bottom:0; width:2px; background:var(--border); }
  .rung{ position:absolute; left:0; right:0; transform:translateY(-50%); }
  .rung-line{ position:absolute; left:0; right:0; top:50%; height:1px; background:var(--border); }
  .rung-dot{ position:absolute; left:-4px; top:50%; width:10px; height:10px; border-radius:50%; transform:translateY(-50%); background:var(--steel); border:2px solid var(--surface); }
  .rung-tag{ position:absolute; left:22px; top:50%; transform:translateY(-50%); display:flex; align-items:baseline; gap:0.5rem; white-space:nowrap; }
  .rung-tag.lane-1{ top:calc(50% - 1.05rem); }
  .rung-key{ font-size:0.72rem; font-weight:700; letter-spacing:0.04em; color:var(--ink-dim); }
  .rung-val{ font-family:"IBM Plex Mono", ui-monospace, monospace; font-weight:600; font-variant-numeric:tabular-nums; }
  .lvl-pdh .rung-dot, .lvl-onh .rung-dot{ background:var(--bull); }
  .lvl-pdl .rung-dot, .lvl-onl .rung-dot{ background:var(--bear); }
  .rung-now .rung-line{ background:var(--accent); height:2px; }
  .rung-now .rung-dot{ background:var(--accent); width:14px; height:14px; left:-6px; }
  .rung-now .rung-key, .rung-now .rung-val{ color:var(--accent); font-weight:700; }

  /* ---- Chips ---- */
  .chip-row{ display:flex; flex-wrap:wrap; gap:0.5rem; }
  .chip{
    display:inline-flex; align-items:center; gap:0.45rem; font-size:0.85rem;
    padding:0.45rem 0.8rem; border-radius:999px; background:var(--surface-2); border:1px solid var(--border);
  }
  .chip-dot{ width:7px; height:7px; border-radius:50%; background:var(--accent); flex:none; }
  .chip-confluence{ border-color:color-mix(in srgb, var(--accent) 40%, var(--border)); }
  .chip-muted{ color:var(--ink-dim); }
  .chip-breakout{ color:var(--accent); border-color:color-mix(in srgb, var(--accent) 40%, var(--border)); }

  /* ---- Stat grid ---- */
  .stat-grid{ display:grid; grid-template-columns:1fr 1fr; gap:1rem; }
  @media (max-width:520px){ .stat-grid{ grid-template-columns:1fr; } }
  .stat-card{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:1.1rem 1.25rem; box-shadow:var(--shadow); }
  .stat-card .stat-head{ display:flex; justify-content:space-between; align-items:baseline; margin-bottom:0.5rem; }
  .stat-title{ font-size:0.78rem; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; color:var(--ink-dim); }
  .stat-read{ font-size:0.78rem; font-weight:700; padding:0.15rem 0.55rem; border-radius:999px; }
  .read-tight, .read-wide{ background:var(--warn-bg); color:var(--warn); }
  .read-normal{ background:var(--bull-bg); color:var(--bull); }
  .gauge{ position:relative; height:8px; border-radius:999px; background:var(--surface-2); overflow:hidden; margin:0.6rem 0 0.65rem; }
  .gauge-fill{ position:absolute; inset:0 auto 0 0; background:var(--accent); border-radius:999px; }
  .gauge-avg-mark{ position:absolute; top:-3px; bottom:-3px; width:2px; background:var(--ink-faint); left:50%; }
  .stat-figures{ display:flex; justify-content:space-between; font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:0.82rem; color:var(--ink-dim); font-variant-numeric:tabular-nums; }
  .stat-note{ font-size:0.85rem; color:var(--ink-dim); margin-top:0.6rem; line-height:1.45; }

  /* ---- Calendar ---- */
  .cal-card{ background:var(--surface); border:1px solid var(--border); border-radius:14px; padding:0.4rem 1.25rem; box-shadow:var(--shadow); }
  .cal-row{ display:flex; align-items:center; gap:0.75rem; padding:0.75rem 0; border-bottom:1px solid var(--border); }
  .cal-row:last-child{ border-bottom:none; }
  .cal-time{ font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:0.85rem; color:var(--ink-dim); font-variant-numeric:tabular-nums; width:5.5rem; flex:none; }
  .cal-name{ font-size:0.92rem; }
  .cal-empty{ padding:0.9rem 0; color:var(--ink-dim); font-size:0.9rem; }
  .pill{ font-size:0.68rem; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; padding:0.2rem 0.5rem; border-radius:5px; flex:none; }
  .pill-high{ background:var(--high-bg); color:var(--high); }
  .pill-medium{ background:var(--warn-bg); color:var(--warn); }

  footer{ font-size:0.82rem; color:var(--ink-faint); line-height:1.6; border-top:1px solid var(--border); padding-top:1.25rem; }
  footer .stamp{ font-family:"IBM Plex Mono", ui-monospace, monospace; font-size:0.75rem; }
</style>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600;700&display=swap">

<div class="wrap">
  <div class="masthead">
    <h1>Pre-Market Conditions</h1>
    <span class="ticker">ES / MES · CME</span>
  </div>
  <h2 class="session-date">${esc(sessionDateLong)}</h2>

  <div class="summary-bar">
    <div>
      <div class="summary-price">${fmt(currentPrice)}<small>ES</small></div>
    </div>
    <div class="summary-gap">
      <div class="gap-val ${gapDir}">${gapSign}${fmt(gapPoints)} pts</div>
      <div class="gap-label">gap vs. prior close</div>
    </div>
  </div>

  <section>
    <p class="section-label">Key Levels</p>
    <div class="ladder-card">
      <div class="ladder">
        ${ladderMarkers}
      </div>
    </div>
  </section>

  <section>
    <p class="section-label">Level Confluence</p>
    <div class="chip-row">${confluenceHtml}</div>
  </section>

  <section>
    <p class="section-label">Pre-Market Breaks</p>
    <div class="chip-row">${breakoutHtml}</div>
  </section>

  <section>
    <p class="section-label">Session Read</p>
    <div class="stat-grid">
      <div class="stat-card">
        <div class="stat-head">
          <span class="stat-title">Overnight Range</span>
          <span class="stat-read read-${rangeRead.toLowerCase()}">${esc(rangeRead)}</span>
        </div>
        <div class="gauge"><div class="gauge-fill" style="width:${gaugePct.toFixed(1)}%"></div><div class="gauge-avg-mark"></div></div>
        <div class="stat-figures"><span>${fmt(currentOnRange)} pts tonight</span><span>${fmt(avgOnRange20)} pts avg (${onRangeSampleSize}d)</span></div>
        <p class="stat-note">${rangeNote}</p>
      </div>
      <div class="stat-card">
        <div class="stat-head"><span class="stat-title">Setup Window</span></div>
        <p class="stat-note" style="margin-top:0;">Sweep &amp; Reclaim and Break &amp; Hold both require their full live sequence during <strong>9:30–11:30 AM ET</strong>. Nothing above is a signal — it's the board to read walking in.</p>
      </div>
    </div>
  </section>

  <section>
    <p class="section-label">Economic Calendar Today</p>
    <div class="cal-card">${calendarHtml}</div>
  </section>

  <footer>
    Generated ${esc(generatedAt)} ET from delayed market data · levels use RTH 9:30–16:00 ET and overnight 18:00–09:30 ET · informational only, not a trade signal or financial advice.
  </footer>
</div>
`;
}

module.exports = { buildDashboardHtml };
