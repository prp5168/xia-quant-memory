// Debug pipeline for Shanghai PVG max temp market (13°C on 2026-03-17)
// Data sources:
// - Polymarket Gamma API (market prices)
// - wttr.in (fallback forecast proxy; NOT the settlement source)

const MARKET_SLUG = "highest-temperature-in-shanghai-on-march-17-2026-13c";
const WTTR_URL = "https://wttr.in/PVG?2"; // PVG = Shanghai Pudong Intl

function parseYesNoPrices(mkt) {
  const outcomes = JSON.parse(mkt.outcomes);
  const prices = JSON.parse(mkt.outcomePrices);
  const map = Object.fromEntries(outcomes.map((o, i) => [o, Number(prices[i]) ]));
  return map;
}

function stripAnsi(s) {
  // Remove ANSI escape sequences like \x1b[38;5;250m
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function parseWttrTable(text) {
  // Look for the "Tue 17 Mar" block and grab all "+<n>(" temperatures.
  const clean = stripAnsi(text);
  const idx = clean.indexOf("Tue 17 Mar");
  if (idx === -1) return null;
  const block = clean.slice(idx, idx + 900);
  const temps = [...block.matchAll(/\+(\d+)\(/g)].map(m => Number(m[1]));
  return { block, temps, max: temps.length ? Math.max(...temps) : null };
}

async function main() {
  // 1) market
  const gammaUrl = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(MARKET_SLUG)}`;
  const gammaRes = await fetch(gammaUrl);
  if (!gammaRes.ok) throw new Error(`Gamma API failed: ${gammaRes.status}`);
  const markets = await gammaRes.json();
  const mkt = markets[0];
  if (!mkt) throw new Error("Market not found");
  const px = parseYesNoPrices(mkt);

  // 2) wttr
  const wttrRes = await fetch(WTTR_URL, { headers: { "User-Agent": "curl/8" } });
  if (!wttrRes.ok) throw new Error(`wttr failed: ${wttrRes.status}`);
  const wttrText = await wttrRes.text();
  const wttr = parseWttrTable(wttrText);

  // 3) naive probability model (placeholder)
  // If forecast max is below 13 by >=2°C, set P(=13) low.
  const forecastMax = wttr?.max;
  let pYes;
  if (forecastMax == null) pYes = null;
  else if (forecastMax >= 13) pYes = 0.35; // placeholder
  else if (forecastMax === 12) pYes = 0.18;
  else if (forecastMax === 11) pYes = 0.10;
  else if (forecastMax === 10) pYes = 0.05;
  else pYes = 0.02;

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    market: {
      id: mkt.id,
      question: mkt.question,
      endDate: mkt.endDate,
      resolutionSource: mkt.resolutionSource,
      prices: px,
      liquidity: Number(mkt.liquidityNum ?? mkt.liquidity),
      volume24hr: Number(mkt.volume24hr),
    },
    wttr: wttr ? { forecastMax, temps: wttr.temps } : null,
    model: pYes == null ? null : {
      pYes,
      pNo: 1 - pYes,
      fairYes: pYes,
      edgeYes: pYes - px.Yes,
      edgeNo: (1 - pYes) - px.No,
    }
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
