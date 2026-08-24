// Fetches ES=F (E-mini S&P 500 futures) intraday data from Yahoo Finance
// and computes the pre-market conditions report inputs:
//   PDH/PDL (previous RTH session high/low, 9:30-16:00 ET)
//   ONH/ONL (overnight session high/low, 18:00 ET prior day - 09:30 ET today)
//   current price, gap vs previous RTH close
//   overnight range vs its recent 20-session average
//   level confluence (levels that sit close together)
//
// Usage: node fetch_and_compute.js

const SYMBOL = "ES=F";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

async function fetchChart(interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=${interval}&range=${range}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No chart result in Yahoo response: " + JSON.stringify(json).slice(0, 300));
  return result;
}

// Convert a unix timestamp (seconds) to a { etHour, etMinute, etDateStr, etWeekday } breakdown
// using America/New_York civil time, DST-aware, via Intl.
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

async function main() {
  // 15m bars over the last month gives enough history to compute the
  // last ~20 overnight ranges for a "normal" baseline, plus current levels.
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

  // Group bars by ET "session date" where a session runs 18:00 ET (prior calendar day) -> 17:00 ET next.
  // We define: RTH = 9:30-16:00 ET on a given weekday. Overnight = 18:00 ET (day-1) -> 09:30 ET (day).
  const RTH_START = 9 * 60 + 30, RTH_END = 16 * 60;
  const ON_START = 18 * 60; // 18:00 ET

  // Bucket bars into RTH sessions keyed by their ET date, and overnight sessions keyed by the
  // ET date of the *morning* they lead into (so ON bars from previous evening + today's premarket
  // both key to today's date).
  const rthByDate = new Map();
  const onByDate = new Map();

  for (const b of bars) {
    const mod = minutesOfDay(b);
    if (mod >= RTH_START && mod < RTH_END) {
      if (!rthByDate.has(b.dateStr)) rthByDate.set(b.dateStr, []);
      rthByDate.get(b.dateStr).push(b);
    } else {
      // Overnight bar: belongs to the NEXT session date if it's evening (>=18:00),
      // or to its own date if it's early morning (<9:30).
      let sessionDate = b.dateStr;
      if (mod >= ON_START) {
        // advance date by 1 day
        const d = new Date(b.dateStr + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() + 1);
        sessionDate = d.toISOString().slice(0, 10);
      }
      if (!onByDate.has(sessionDate)) onByDate.set(sessionDate, []);
      onByDate.get(sessionDate).push(b);
    }
  }

  const dates = [...rthByDate.keys()].sort();
  const today = dates[dates.length - 1];
  // "Previous day" RTH session = the last complete RTH session before today.
  // If today's RTH hasn't started yet (pre-market run), rthByDate might already
  // only contain fully completed days plus maybe a partial "today" if any RTH bars exist.
  const now = etParts(Math.floor(Date.now() / 1000));
  const nowMod = minutesOfDay(now);
  const todayIsRTHOpen = nowMod >= RTH_START && nowMod < RTH_END && now.dateStr === today;

  let prevDate;
  if (rthByDate.has(now.dateStr) && !todayIsRTHOpen) {
    // today's RTH bars exist but market isn't currently in RTH -> today's session already closed, so "previous day" = today
    prevDate = now.dateStr;
  } else if (rthByDate.has(now.dateStr) && todayIsRTHOpen) {
    // mid-session; shouldn't happen for a 9am run, but handle gracefully
    const idx = dates.indexOf(now.dateStr);
    prevDate = dates[idx - 1];
  } else {
    // today's RTH hasn't happened yet (normal case for a 9am pre-market run)
    prevDate = dates[dates.length - 1];
  }

  const prevBars = rthByDate.get(prevDate) || [];
  const PDH = Math.max(...prevBars.map(b => b.high));
  const PDL = Math.min(...prevBars.map(b => b.low));
  const prevClose = prevBars.length ? prevBars[prevBars.length - 1].close : null;

  // Overnight session leading into "today" (the next trading day after prevDate)
  const onDates = [...onByDate.keys()].sort();
  const targetOnDate = onDates[onDates.length - 1];
  const onBars = onByDate.get(targetOnDate) || [];
  const ONH = onBars.length ? Math.max(...onBars.map(b => b.high)) : null;
  const ONL = onBars.length ? Math.min(...onBars.map(b => b.low)) : null;

  // Historical overnight ranges (last 20 sessions) for a "normal" baseline
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

  const out = {
    symbol: SYMBOL,
    asOf: new Date().toISOString(),
    currentPrice,
    prevDate,
    PDH, PDL, prevClose,
    targetOnDate,
    ONH, ONL,
    currentOnRange,
    avgOnRange20: avgOnRange,
    onRangeSampleSize: onRanges.length,
    gapPoints: currentPrice != null && prevClose != null ? +(currentPrice - prevClose).toFixed(2) : null,
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
