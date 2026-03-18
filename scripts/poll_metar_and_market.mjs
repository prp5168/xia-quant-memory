// Poll NOAA ADDS METAR + Polymarket Gamma market prices into local JSONL logs.
// Usage:
//   node scripts/poll_metar_and_market.mjs
// Env:
//   STATION=ZSPD
//   MARKET_SLUG=highest-temperature-in-shanghai-on-march-17-2026-13c
//   INTERVAL_SEC=60

import { appendFile, mkdir } from 'node:fs/promises';

const STATION = process.env.STATION || 'ZSPD';
const MARKET_SLUG = process.env.MARKET_SLUG || 'highest-temperature-in-shanghai-on-march-17-2026-13c';
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || '60');
const HOURS = process.env.HOURS || '6';

const outDir = 'data';
await mkdir(outDir, { recursive: true });

function normalize(m) {
  return {
    raw_text: m.rawOb ?? null,
    observation_time: m.reportTime ?? null,
    obsTime: m.obsTime ?? null,
    temp_c: (m.temp != null ? Number(m.temp) : null),
  };
}

async function fetchMetarSnapshot() {
  const url = new URL('https://aviationweather.gov/api/data/metar');
  url.searchParams.set('ids', STATION);
  url.searchParams.set('hours', String(HOURS));
  url.searchParams.set('format', 'json');

  const res = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!res.ok) throw new Error(`NOAA AWC failed: ${res.status}`);
  const arr = await res.json();
  const metars = arr.map(normalize).filter(m => m.observation_time);
  metars.sort((a,b) => (a.obsTime ?? 0) - (b.obsTime ?? 0));
  const temps = metars.map(m => m.temp_c).filter(t => Number.isFinite(t));
  return {
    metar_ts: new Date().toISOString(),
    station: STATION,
    latest: metars.length ? metars[metars.length-1] : null,
    tmax_so_far: temps.length ? Math.max(...temps) : null,
    metars_count: metars.length,
  };
}

function parseYesNoPrices(mkt) {
  const outcomes = JSON.parse(mkt.outcomes);
  const prices = JSON.parse(mkt.outcomePrices);
  return Object.fromEntries(outcomes.map((o, i) => [o, Number(prices[i]) ]));
}

async function fetchMarketSnapshot() {
  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(MARKET_SLUG)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!res.ok) throw new Error(`Gamma failed: ${res.status}`);
  const arr = await res.json();
  const m = arr[0];
  if (!m) throw new Error('market not found');
  const px = parseYesNoPrices(m);
  return {
    mkt_ts: new Date().toISOString(),
    market_id: m.id,
    market_slug: m.slug,
    prices: px,
    liquidity: Number(m.liquidityNum ?? m.liquidity),
    volume24hr: Number(m.volume24hr),
  };
}

async function tick() {
  const [metar, market] = await Promise.all([fetchMetarSnapshot(), fetchMarketSnapshot()]);
  const row = { ts: new Date().toISOString(), metar, market };
  const line = JSON.stringify(row) + '\n';
  await appendFile(`${outDir}/zspd_${MARKET_SLUG}.jsonl`, line, 'utf8');
  // minimal console
  console.log(`${row.ts} METAR tmax_so_far=${metar.tmax_so_far} latest=${metar.latest?.temp_c}C@${metar.latest?.observation_time} | pxYes=${market.prices?.Yes}`);
}

console.log(`Polling STATION=${STATION} MARKET_SLUG=${MARKET_SLUG} every ${INTERVAL_SEC}s`);
while (true) {
  try {
    await tick();
  } catch (e) {
    console.error('tick_error', e?.message || e);
  }
  await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
}
