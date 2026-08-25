// Intraday level-touch watcher for the Sweep & Reclaim / Break & Hold setups.
// Runs every ~5 minutes (via GitHub Actions, which has real internet access)
// during the 9:30-11:30 AM ET window. Compares live ES=F price against
// today's PDH/PDL/ONH/ONL (written this morning by generate_report.js into
// alert_state.json) and emails Kevin the FIRST time price crosses beyond
// each level -- a heads-up to go watch for the reclaim/structure/retest
// himself, not an entry signal.
//
// Usage: node check_levels.js
// Reads/writes alert_state.json. Sends via the Resend HTTP API directly
// (RESEND_API_KEY env var) since this always runs somewhere with real
// internet access (GitHub Actions), unlike the Claude cloud routine sandbox.

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

async function fetchCurrentPrice() {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(SYMBOL)}?interval=1m&range=1d`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Yahoo fetch failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error("No chart result in Yahoo response");
  const meta = result.meta;
  const closes = result.indicators?.quote?.[0]?.close || [];
  return meta.regularMarketPrice ?? closes.filter(c => c != null).pop();
}

async function sendAlert({ levelKey, levelValue, currentPrice, timeLabel, direction }) {
  const watchFor = direction === "above"
    ? `a reclaim back below ${levelValue} for a possible Sweep & Reclaim short (or continued acceptance above it for Break & Hold long)`
    : `a reclaim back above ${levelValue} for a possible Sweep & Reclaim long (or continued acceptance below it for Break & Hold short)`;

  const subject = `⚠ ES swept ${levelKey} (${levelValue}) — ${timeLabel}`;
  const text = `ES just traded ${direction} ${levelKey} (${levelValue}). Current price: ${currentPrice}.\n\nThis is a level-touch alert only -- it does NOT confirm either setup. Watch for ${watchFor}.\n\nDashboard: ${DASHBOARD_URL}\n\n(Level-touch alert -- not a trade signal. Verify on your own chart.)`;
  const html = `<p>ES just traded <strong>${direction}</strong> <strong>${levelKey}</strong> (${levelValue}). Current price: <strong>${currentPrice}</strong>.</p><p>This is a level-touch alert only — it does NOT confirm either setup. Watch for ${watchFor}.</p><p><a href="${DASHBOARD_URL}">Open the dashboard</a></p><p style="color:#888;font-size:12px;">Level-touch alert only — not a trade signal. Verify on your own chart.</p>`;

  if (!RESEND_API_KEY) {
    console.error(`RESEND_API_KEY not set -- would have sent: ${subject}`);
    return;
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from: FROM, to: [TO], subject, text, html }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend send failed: ${res.status} ${body}`);
  console.log(`Alert sent for ${levelKey}: ${body}`);
}

async function main() {
  const now = etParts(Math.floor(Date.now() / 1000));
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

  const currentPrice = await fetchCurrentPrice();
  console.log(`Current ES price: ${currentPrice} at ${now.timeLabel}`);

  const checks = [
    { key: "ONH", direction: "above", cross: (p, l) => p > l },
    { key: "PDH", direction: "above", cross: (p, l) => p > l },
    { key: "ONL", direction: "below", cross: (p, l) => p < l },
    { key: "PDL", direction: "below", cross: (p, l) => p < l },
  ];

  let changed = false;
  for (const c of checks) {
    const levelValue = state.levels[c.key];
    if (levelValue == null || state.alerted[c.key]) continue;
    if (c.cross(currentPrice, levelValue)) {
      await sendAlert({ levelKey: c.key, levelValue, currentPrice, timeLabel: now.timeLabel, direction: c.direction });
      state.alerted[c.key] = true;
      changed = true;
    }
  }

  if (changed) {
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
    console.log("alert_state.json updated.");
  } else {
    console.log("No new level crosses.");
  }
}

main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
