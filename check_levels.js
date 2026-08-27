// Intraday setup-forming watcher for the Sweep & Reclaim / Break & Hold setups.
// Runs every ~5 minutes (via GitHub Actions, real internet access) during
// the 9:30-11:30 AM ET window. Tracks each of today's 4 levels through an
// objective state machine and emails Kevin at each stage:
//
//   none -> broken (price crosses beyond the level -- Stage 1: "swept")
//   broken -> reclaimed (price crosses back -- Stage 2: "Sweep & Reclaim may
//             be forming")
//        OR -> accepted (a completed 5-min candle closes beyond the level --
//             Stage 2: "Break & Hold may be forming")
//
// Both Stage 2 branches are still purely mechanical (two price crossings, or
// one candle close) -- NOT an attempt to detect the structure break/retest,
// which is a judgment call left to Kevin. This tells him a setup MAY be
// forming and which one, not that it has triggered.
//
// Usage: node check_levels.js
// Reads/writes alert_state.json. Sends via the Resend HTTP API directly
// (RESEND_API_KEY env var).

const fs = require("fs");
const path = require("path");

const SYMBOL = "ES=F";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const STATE_PATH = path.join(__dirname, "alert_state.json");
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = "S&P Pre-Market Board <premarket@velora.builders>";
const TO = "kevinmfitz7@gmail.com";
const DASHBOARD_URL = "https://claude.ai/code/artifact/f12bab78-1b44-4432-b897-39b0cde313f2";

function etParts(unixSec) {
  const d = new Date(unixSec * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(d).map(p => [p.type, p.value]));
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: parseInt(parts.hour, 10) % 24,
    minute: parseInt(parts.minute, 10),
    weekday: parts.weekday,
    timeLabel: `${((parseInt(parts.hour, 10) % 12) || 12)}:${parts.minute} ${parseInt(parts.hour,10) < 12 ? "AM" : "PM"} ET`,
  };
}

async function fetchIntraday() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=5m&range=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No chart result in Yahoo response");

  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};
  const candles = ts.map((t, i) => ({
    t,
    open: q.open?.[i], high: q.high?.[i], low: q.low?.[i], close: q.close?.[i],
  })).filter(c => c.close != null);

  const currentPrice = result.meta.regularMarketPrice ?? candles[candles.length - 1]?.close;
  return { currentPrice, candles };
}

// A 5-min candle is "completed" once its 5-min window has fully elapsed.
function completedCandlesAfter(candles, afterUnixSec, nowUnixSec) {
  return candles.filter(c => c.t >= afterUnixSec && (c.t + 5 * 60) <= nowUnixSec);
}

async function sendEmail(subject, text, html) {
  if (!RESEND_API_KEY) {
    console.error(`RESEND_API_KEY not set -- would have sent: ${subject}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [TO], subject, text, html }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${body}`);
  console.log(`Sent: ${subject} -- ${body}`);
}

async function sendSweepAlert({ levelKey, levelValue, currentPrice, timeLabel, direction }) {
  const subject = `⚠ ES swept ${levelKey} (${levelValue}) — ${timeLabel}`;
  const text = `ES just traded ${direction} ${levelKey} (${levelValue}). Current price: ${currentPrice}.\n\nThis is a level-touch alert only -- it does NOT confirm either setup. Watch for a reclaim (Sweep & Reclaim) or an accepted break (Break & Hold).\n\nDashboard: ${DASHBOARD_URL}\n\n(Level-touch alert -- not a trade signal. Verify on your own chart.)`;
  const html = `<p>ES just traded <strong>${direction}</strong> <strong>${levelKey}</strong> (${levelValue}). Current price: <strong>${currentPrice}</strong>.</p><p>This is a level-touch alert only — it does NOT confirm either setup. Watch for a reclaim (Sweep &amp; Reclaim) or an accepted break (Break &amp; Hold).</p><p><a href="${DASHBOARD_URL}">Open the dashboard</a></p><p style="color:#888;font-size:12px;">Level-touch alert only — not a trade signal. Verify on your own chart.</p>`;
  await sendEmail(subject, text, html);
}

async function sendReclaimAlert({ levelKey, levelValue, currentPrice, timeLabel, direction }) {
  const shortSide = direction === "above"; // swept above then reclaimed back below -> short bias
  const subject = `🟡 Sweep & Reclaim may be forming at ${levelKey} — ${timeLabel}`;
  const structureDir = shortSide ? "bearish" : "bullish";
  const retestNote = shortSide
    ? `a ${structureDir} structure break, then a retest of ${levelValue} holding as resistance`
    : `a ${structureDir} structure break, then a retest of ${levelValue} holding as support`;
  const text = `ES swept ${levelKey} (${levelValue}) and has now reclaimed back ${shortSide ? "below" : "above"} it. Current price: ${currentPrice}.\n\nThis is the SWEEP + RECLAIM part of the sequence -- purely mechanical, not the full setup. Next, watch for ${retestNote}. Only the full sequence (sweep -> reclaim -> structure break -> retest) makes this a trade.\n\nDashboard: ${DASHBOARD_URL}\n\n(Not a trade signal -- confirm structure break and retest yourself.)`;
  const html = `<p>ES swept <strong>${levelKey}</strong> (${levelValue}) and has now reclaimed back ${shortSide ? "below" : "above"} it. Current price: <strong>${currentPrice}</strong>.</p><p>This is the <strong>sweep + reclaim</strong> part of the sequence — purely mechanical, not the full setup. Next, watch for ${retestNote}. Only the full sequence (sweep → reclaim → structure break → retest) makes this a trade.</p><p><a href="${DASHBOARD_URL}">Open the dashboard</a></p><p style="color:#888;font-size:12px;">Not a trade signal — confirm structure break and retest yourself.</p>`;
  await sendEmail(subject, text, html);
}

async function sendAcceptanceAlert({ levelKey, levelValue, currentPrice, timeLabel, direction }) {
  const longSide = direction === "above"; // broke and held above -> long bias
  const subject = `🟢 Break & Hold may be forming at ${levelKey} — ${timeLabel}`;
  const structureDir = longSide ? "bullish" : "bearish";
  const retestNote = longSide
    ? `a pullback to ${levelValue} holding as support, then a ${structureDir} structure confirmation`
    : `a pullback to ${levelValue} holding as resistance, then a ${structureDir} structure confirmation`;
  const text = `ES broke ${levelKey} (${levelValue}) and a 5-min candle has closed ${longSide ? "above" : "below"} it (acceptance). Current price: ${currentPrice}.\n\nThis is the BREAK + ACCEPTANCE part of the sequence -- purely mechanical, not the full setup. Next, watch for ${retestNote}. Only the full sequence (break -> acceptance -> retest -> hold -> structure) makes this a trade.\n\nDashboard: ${DASHBOARD_URL}\n\n(Not a trade signal -- confirm the retest and structure yourself.)`;
  const html = `<p>ES broke <strong>${levelKey}</strong> (${levelValue}) and a 5-min candle has closed ${longSide ? "above" : "below"} it (acceptance). Current price: <strong>${currentPrice}</strong>.</p><p>This is the <strong>break + acceptance</strong> part of the sequence — purely mechanical, not the full setup. Next, watch for ${retestNote}. Only the full sequence (break → acceptance → retest → hold → structure) makes this a trade.</p><p><a href="${DASHBOARD_URL}">Open the dashboard</a></p><p style="color:#888;font-size:12px;">Not a trade signal — confirm the retest and structure yourself.</p>`;
  await sendEmail(subject, text, html);
}

async function main() {
  const now = etParts(Math.floor(Date.now() / 1000));
  const nowUnixSec = Math.floor(Date.now() / 1000);
  const isWeekday = !["Sat", "Sun"].includes(now.weekday);
  const minutesOfDay = now.hour * 60 + now.minute;
  const inWindow = minutesOfDay >= (9 * 60 + 30) && minutesOfDay <= (11 * 60 + 30);

  if ((!isWeekday || !inWindow) && process.env.FORCE_WINDOW !== "1") {
    console.log(`Outside watch window (${now.weekday} ${now.timeLabel}) -- skipping.`);
    return;
  }

  if (!fs.existsSync(STATE_PATH)) {
    console.log("No alert_state.json yet -- morning report hasn't run. Skipping.");
    return;
  }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  if (state.sessionDate !== now.dateStr) {
    console.log(`alert_state.json is for ${state.sessionDate}, not today (${now.dateStr}) -- skipping.`);
    return;
  }

  const { currentPrice, candles } = await fetchIntraday();
  console.log(`Current ES price: ${currentPrice} at ${now.timeLabel} (${candles.length} candles fetched)`);

  const checks = [
    { key: "ONH", direction: "above" },
    { key: "PDH", direction: "above" },
    { key: "ONL", direction: "below" },
    { key: "PDL", direction: "below" },
  ];

  let changed = false;
  for (const c of checks) {
    const levelValue = state.levels[c.key];
    if (levelValue == null) continue;
    const st = state.state[c.key];
    const beyond = c.direction === "above" ? currentPrice > levelValue : currentPrice < levelValue;
    const back = c.direction === "above" ? currentPrice <= levelValue : currentPrice >= levelValue;

    if (st.status === "none") {
      if (beyond) {
        st.status = "broken";
        st.brokenAt = nowUnixSec;
        await sendSweepAlert({ levelKey: c.key, levelValue, currentPrice, timeLabel: now.timeLabel, direction: c.direction });
        changed = true;
      }
    } else if (st.status === "broken") {
      if (back) {
        st.status = "reclaimed";
        await sendReclaimAlert({ levelKey: c.key, levelValue, currentPrice, timeLabel: now.timeLabel, direction: c.direction });
        changed = true;
      } else {
        const afterBreak = completedCandlesAfter(candles, st.brokenAt, nowUnixSec);
        const accepted = afterBreak.some(cd => c.direction === "above" ? cd.close > levelValue : cd.close < levelValue);
        if (accepted) {
          st.status = "accepted";
          await sendAcceptanceAlert({ levelKey: c.key, levelValue, currentPrice, timeLabel: now.timeLabel, direction: c.direction });
          changed = true;
        }
      }
    }
    // "reclaimed" and "accepted" are terminal for the day -- no more alerts for this level.
  }

  if (changed) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log("alert_state.json updated.");
  } else {
    console.log("No state changes.");
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
