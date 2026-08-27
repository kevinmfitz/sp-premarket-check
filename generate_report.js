// Generates the morning S&P (ES/MES) pre-market conditions report:
// key levels (PDH/PDL/ONH/ONL), level confluence, overnight range read,
// gap read, and today's relevant economic calendar events.
//
// This is informational context only for the Sweep & Reclaim and
// Break & Hold setups (9:30-11:30 ET). It does NOT generate a trade
// signal -- both setups still require their full live price-action
// sequence to confirm.
//
// Usage: node generate_report.js
// Writes report.md and report.json in the same directory.

const fs = require("fs");
const path = require("path");
const { buildDashboardHtml } = require("./render_html");

const SYMBOL = "ES=F";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const CALENDAR_PATH = path.join(__dirname, "econ_calendar_2026.json");

async function fetchChart(interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No chart result in Yahoo response");
  return result;
}

function etParts(unixSec) {
  const d = new Date(unixSec * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    weekday: parts.weekday,
  };
}
function minutesOfDay(p) { return p.hour * 60 + p.minute; }

async function computeLevels() {
  const chart = await fetchChart("15m", "1mo");
  const ts = chart.timestamp || [];
  const q = chart.indicators.quote[0];
  const meta = chart.meta;

  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
    const p = etParts(ts[i]);
    bars.push({ t: ts[i], high: q.high[i], low: q.low[i], close: q.close[i], open: q.open[i], ...p });
  }

  const RTH_START = 9 * 60 + 30, RTH_END = 16 * 60;
  const ON_START = 18 * 60;

  const rthByDate = new Map();
  const onByDate = new Map();

  for (const b of bars) {
    const mod = minutesOfDay(b);
    if (mod >= RTH_START && mod < RTH_END) {
      if (!rthByDate.has(b.dateStr)) rthByDate.set(b.dateStr, []);
      rthByDate.get(b.dateStr).push(b);
    } else {
      let sessionDate = b.dateStr;
      if (mod >= ON_START) {
        const d = new Date(b.dateStr + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() + 1);
        sessionDate = d.toISOString().slice(0, 10);
      }
      if (!onByDate.has(sessionDate)) onByDate.set(sessionDate, []);
      onByDate.get(sessionDate).push(b);
    }
  }

  const dates = [...rthByDate.keys()].sort();
  const now = etParts(Math.floor(Date.now() / 1000));
  const nowMod = minutesOfDay(now);
  const todayIsRTHOpen = nowMod >= RTH_START && nowMod < RTH_END && rthByDate.has(now.dateStr);

  let prevDate;
  if (rthByDate.has(now.dateStr) && !todayIsRTHOpen) {
    prevDate = now.dateStr;
  } else if (todayIsRTHOpen) {
    const idx = dates.indexOf(now.dateStr);
    prevDate = dates[idx - 1];
  } else {
    prevDate = dates[dates.length - 1];
  }

  const prevBars = rthByDate.get(prevDate) || [];
  const PDH = Math.max(...prevBars.map(b => b.high));
  const PDL = Math.min(...prevBars.map(b => b.low));
  const prevClose = prevBars.length ? prevBars[prevBars.length - 1].close : null;

  const onDates = [...onByDate.keys()].sort();
  const targetOnDate = onDates[onDates.length - 1];
  const onBars = onByDate.get(targetOnDate) || [];
  const ONH = onBars.length ? Math.max(...onBars.map(b => b.high)) : null;
  const ONL = onBars.length ? Math.min(...onBars.map(b => b.low)) : null;

  const onRanges = onDates
    .filter(d => d !== targetOnDate)
    .slice(-20)
    .map(d => {
      const bs = onByDate.get(d);
      return Math.max(...bs.map(b => b.high)) - Math.min(...bs.map(b => b.low));
    });
  const avgOnRange = onRanges.length ? onRanges.reduce((a, b) => a + b, 0) / onRanges.length : null;
  const currentOnRange = ONH != null && ONL != null ? ONH - ONL : null;

  const currentPrice = meta.regularMarketPrice ?? bars[bars.length - 1]?.close;

  return {
    symbol: SYMBOL,
    asOfUTC: new Date().toISOString(),
    currentPrice,
    prevDate, PDH, PDL, prevClose,
    sessionDate: targetOnDate,
    ONH, ONL,
    currentOnRange,
    avgOnRange20: avgOnRange,
    onRangeSampleSize: onRanges.length,
    gapPoints: currentPrice != null && prevClose != null ? +(currentPrice - prevClose).toFixed(2) : null,
  };
}

function loadCalendarEvents(sessionDate) {
  const cal = JSON.parse(fs.readFileSync(CALENDAR_PATH, "utf8"));
  return cal.events.filter(e => e.date === sessionDate);
}

function findConfluence(levels) {
  const named = [
    ["PDH", levels.PDH], ["PDL", levels.PDL],
    ["ONH", levels.ONH], ["ONL", levels.ONL],
  ].filter(([, v]) => v != null);

  const threshold = Math.max(5, Math.round((levels.avgOnRange20 || 40) * 0.15));
  const clusters = [];
  for (let i = 0; i < named.length; i++) {
    for (let j = i + 1; j < named.length; j++) {
      const [nameA, valA] = named[i];
      const [nameB, valB] = named[j];
      const dist = Math.abs(valA - valB);
      if (dist <= threshold) {
        clusters.push({ a: nameA, b: nameB, distance: +dist.toFixed(2) });
      }
    }
  }
  return { threshold, clusters };
}

function classifyRange(current, avg) {
  if (current == null || avg == null || avg === 0) return "Unknown";
  const ratio = current / avg;
  if (ratio < 0.6) return "Tight";
  if (ratio > 1.4) return "Wide";
  return "Normal";
}

function levelsBeyondPrice(levels) {
  // Which levels has price already broken through, pre-market?
  const { currentPrice, PDH, PDL, ONH, ONL } = levels;
  const notes = [];
  if (ONH != null && currentPrice > ONH) notes.push(`Trading ABOVE Overnight High (${ONH})`);
  if (ONL != null && currentPrice < ONL) notes.push(`Trading BELOW Overnight Low (${ONL})`);
  if (PDH != null && currentPrice > PDH) notes.push(`Trading ABOVE Previous Day High (${PDH})`);
  if (PDL != null && currentPrice < PDL) notes.push(`Trading BELOW Previous Day Low (${PDL})`);
  return notes;
}

function fmt(n) { return n == null ? "n/a" : n.toFixed(2); }

// Synthesizes the individual factors into one explicit read: FAVORABLE /
// MIXED / LOW QUALITY, plus the 2-4 reasons behind it. This is a transparent
// heuristic (not a backtested signal) meant to save the 30 seconds of
// mentally combining the sections below -- it is never a substitute for the
// live sequence confirming during the 9:30-11:30 window.
function computeVerdict({ clusters, rangeRead, breakoutNotes, events }) {
  const notes = [];
  let score = 0;

  if (clusters.length) {
    score += 1;
    notes.push(`Confluence: ${clusters.map(c => `${c.a}/${c.b}`).join(", ")} clustered — stronger, higher-conviction zone(s) today.`);
  } else {
    notes.push("No confluence — all four levels stand alone, each a bit weaker individually.");
  }

  if (rangeRead === "Tight") {
    score -= 1;
    notes.push("Overnight range is tight — levels are bunched close together, higher chop/false-sweep risk.");
  } else if (rangeRead === "Wide") {
    notes.push("Overnight range is wide — a lot already moved overnight; edge may favor Sweep & Reclaim (fade) over fresh Break & Hold continuation.");
  } else {
    score += 0.5;
    notes.push("Overnight range is normal — no unusual skew toward either setup from range alone.");
  }

  if (breakoutNotes.length) {
    notes.push(`Pre-market: ${breakoutNotes.join("; ")} — that level's sweep/break may already be in motion before the open.`);
  }

  const highImpact = events.filter(e => e.impact === "high");
  if (highImpact.length) {
    notes.push(`High-impact release(s) today (${highImpact.map(e => e.event).join(", ")}) — expect sharper, noisier moves; often the catalyst for the opening sweep, not a reason to skip.`);
  }

  let verdict, verdictClass;
  if (rangeRead === "Tight" && !clusters.length) {
    verdict = "LOW QUALITY"; verdictClass = "low";
  } else if (score >= 1) {
    verdict = "FAVORABLE"; verdictClass = "favorable";
  } else {
    verdict = "MIXED"; verdictClass = "mixed";
  }

  return { verdict, verdictClass, notes };
}

async function main() {
  const levels = await computeLevels();
  const events = loadCalendarEvents(levels.sessionDate);
  const { threshold, clusters } = findConfluence(levels);
  const rangeRead = classifyRange(levels.currentOnRange, levels.avgOnRange20);
  const breakoutNotes = levelsBeyondPrice(levels);
  const verdict = computeVerdict({ clusters, rangeRead, breakoutNotes, events });

  const distTo = (lvl) => (lvl == null ? null : +(levels.currentPrice - lvl).toFixed(2));

  const lines = [];
  lines.push(`# S&P (ES/MES) Pre-Market Conditions — ${levels.sessionDate}`);
  lines.push("");
  lines.push(`_Generated ${new Date().toLocaleString("en-US", { timeZone: "America/New_York" })} ET · data as of last Yahoo Finance print, informational only, not a trade signal._`);
  lines.push("");
  lines.push(`## Today's Read: ${verdict.verdict}`);
  lines.push("");
  for (const n of verdict.notes) lines.push(`- ${n}`);
  lines.push("");
  lines.push("_This is an environment read, not a trade call — both setups still require their full live sequence to confirm._");
  lines.push("");
  lines.push("## Key Levels");
  lines.push("");
  lines.push("| Level | Price | Distance from current |");
  lines.push("|---|---|---|");
  lines.push(`| Current (ES) | ${fmt(levels.currentPrice)} | — |`);
  lines.push(`| Previous Day High (PDH) | ${fmt(levels.PDH)} | ${fmt(distTo(levels.PDH))} |`);
  lines.push(`| Previous Day Low (PDL) | ${fmt(levels.PDL)} | ${fmt(distTo(levels.PDL))} |`);
  lines.push(`| Overnight High (ONH) | ${fmt(levels.ONH)} | ${fmt(distTo(levels.ONH))} |`);
  lines.push(`| Overnight Low (ONL) | ${fmt(levels.ONL)} | ${fmt(distTo(levels.ONL))} |`);
  lines.push("");

  lines.push("## Level Confluence");
  lines.push("");
  if (clusters.length) {
    lines.push(`Levels within ${threshold} pts of each other (stronger, higher-conviction zones):`);
    lines.push("");
    for (const c of clusters) {
      lines.push(`- **${c.a} & ${c.b}** are only ${c.distance} pts apart — a cluster worth weighting more.`);
    }
  } else {
    lines.push(`No levels within ${threshold} pts of each other — all four levels are distinct today (no confluence zone).`);
  }
  lines.push("");

  lines.push("## Overnight Range");
  lines.push("");
  lines.push(`Overnight range: **${fmt(levels.currentOnRange)} pts** vs. ${levels.onRangeSampleSize}-session average of **${fmt(levels.avgOnRange20)} pts** → **${rangeRead}**.`);
  if (rangeRead === "Tight") lines.push("_Tight range = levels are bunched close together; watch for lower-quality/choppy sweeps._");
  if (rangeRead === "Wide") lines.push("_Wide range = a lot has already happened overnight; a reversal (Sweep & Reclaim) may be more likely than fresh continuation._");
  lines.push("");

  lines.push("## Gap");
  lines.push("");
  lines.push(`Current price is **${levels.gapPoints >= 0 ? "+" : ""}${fmt(levels.gapPoints)} pts** vs. previous RTH close (${fmt(levels.prevClose)}).`);
  if (breakoutNotes.length) {
    lines.push("");
    for (const n of breakoutNotes) lines.push(`- ${n}`);
  } else {
    lines.push("- Price is currently inside all four levels (no level broken pre-market).");
  }
  lines.push("");

  lines.push("## Economic Calendar Today");
  lines.push("");
  if (events.length) {
    for (const e of events) {
      lines.push(`- **${e.time}** — ${e.event} (${e.impact} impact)`);
    }
    lines.push("");
    lines.push("_High-impact releases at/near 8:30 ET often ARE the catalyst for the initial ONH/ONL sweep right at the open — expect more noise, not necessarily a reason to skip._");
  } else {
    lines.push("- No high-impact scheduled releases today.");
  }
  lines.push("");

  lines.push("---");
  lines.push("_Reminder: this is pre-market context only. Neither Sweep & Reclaim nor Break & Hold is confirmed until its full live sequence plays out (sweep→reclaim→structure break→retest, or break→acceptance→retest→hold→structure) during the 9:30-11:30 ET window. Trade only if the sequence actually shows up._");

  const md = lines.join("\n");
  const reportData = { levels, events, clusters, threshold, rangeRead, breakoutNotes, verdict };
  fs.writeFileSync(path.join(__dirname, "report.md"), md);
  fs.writeFileSync(path.join(__dirname, "report.json"), JSON.stringify(reportData, null, 2));
  fs.writeFileSync(path.join(__dirname, "report.html"), buildDashboardHtml(reportData));

  // Reset today's intraday setup-forming watcher state so check_levels.js
  // (run every ~5 min by a separate GitHub Actions workflow) starts fresh.
  // Each level tracks: none -> broken -> reclaimed | accepted (see
  // check_levels.js for what each status means and when it's emailed).
  const freshLevelState = () => ({ status: "none", brokenAt: null });
  const alertState = {
    sessionDate: levels.sessionDate,
    levels: { PDH: levels.PDH, PDL: levels.PDL, ONH: levels.ONH, ONL: levels.ONL },
    state: { PDH: freshLevelState(), PDL: freshLevelState(), ONH: freshLevelState(), ONL: freshLevelState() },
  };
  fs.writeFileSync(path.join(__dirname, "alert_state.json"), JSON.stringify(alertState, null, 2));

  console.log(md);
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
