// Backtest METAR events vs Orderbook mid (CLOB /book) rather than sparse price history.
//
// Usage:
//   node scripts/backtest_metar_vs_orderbook_mid.mjs
// Env:
//   STATION=RKSI
//   MARKET_SLUG=highest-temperature-in-seoul-on-march-16-2026-10c
//   HOURS=72 WINDOW_MIN=5 THRESHOLD=10
//
// Method:
// - Pull METAR history for last HOURS via NOAA AWC.
// - Identify METAR event times (tmax_new_high, threshold_reached).
// - For each event time, approximate mid-price using current orderbook snapshot.
//   IMPORTANT LIMITATION: CLOB /book has no historical snapshots, only current state.
//   Therefore this script can only be used in REAL-TIME collection mode.
//
// This file exists to make the limitation explicit and provide the real-time collector.

import { appendFile, mkdir } from 'node:fs/promises';

const STATION = process.env.STATION || 'RKSI';
const MARKET_SLUG = process.env.MARKET_SLUG || 'highest-temperature-in-seoul-on-march-16-2026-10c';
const HOURS = Number(process.env.HOURS || '72');
const WINDOW_MIN = Number(process.env.WINDOW_MIN || '5');
const THRESHOLD = process.env.THRESHOLD != null ? Number(process.env.THRESHOLD) : null;
const INTERVAL_SEC = Number(process.env.INTERVAL_SEC || '30');

const outDir = 'data';
await mkdir(outDir, { recursive: true });

async function getYesTokenId() {
  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(MARKET_SLUG)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!r.ok) throw new Error(`Gamma failed: ${r.status}`);
  const arr = await r.json();
  const m = arr[0];
  if (!m) throw new Error('market not found');
  const tokenIds = JSON.parse(m.clobTokenIds);
  const outcomes = JSON.parse(m.outcomes);
  const idxYes = outcomes.findIndex(o => o.toLowerCase() === 'yes');
  const yesTokenId = idxYes >= 0 ? tokenIds[idxYes] : tokenIds[0];
  return { yesTokenId, marketId: m.id };
}

async function fetchMetarSnapshot() {
  const url = new URL('https://aviationweather.gov/api/data/metar');
  url.searchParams.set('ids', STATION);
  url.searchParams.set('hours', String(HOURS));
  url.searchParams.set('format', 'json');
  const r = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!r.ok) throw new Error(`NOAA AWC failed: ${r.status}`);
  const arr = await r.json();
  const metars = arr.map(x => ({
    obsTime: Number(x.obsTime),
    reportTime: x.reportTime,
    temp: x.temp != null ? Number(x.temp) : null,
    raw: x.rawOb ?? null,
  })).filter(x => Number.isFinite(x.obsTime)).sort((a,b)=>a.obsTime-b.obsTime);

  let tmax = null;
  for (const m of metars) {
    if (Number.isFinite(m.temp)) tmax = (tmax == null ? m.temp : Math.max(tmax, m.temp));
  }
  return { ts: new Date().toISOString(), latest: metars[metars.length-1] ?? null, tmax_so_far: tmax, count: metars.length };
}

function bestBidAsk(book) {
  const bids = (book.bids || []).map(x => ({ p: Number(x.price), s: Number(x.size) })).filter(x => Number.isFinite(x.p));
  const asks = (book.asks || []).map(x => ({ p: Number(x.price), s: Number(x.size) })).filter(x => Number.isFinite(x.p));
  const bestBid = bids.length ? Math.max(...bids.map(x=>x.p)) : null;
  const bestAsk = asks.length ? Math.min(...asks.map(x=>x.p)) : null;
  return { bestBid, bestAsk };
}

function midPrice(bestBid, bestAsk, lastTrade) {
  if (bestBid != null && bestAsk != null) return (bestBid + bestAsk) / 2;
  // If one side missing, fallback to last_trade_price (still informative)
  if (lastTrade != null) return Number(lastTrade);
  return null;
}

async function fetchBookMid(tokenId) {
  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!r.ok) throw new Error(`CLOB book failed: ${r.status}`);
  const book = await r.json();
  const { bestBid, bestAsk } = bestBidAsk(book);
  const mid = midPrice(bestBid, bestAsk, book.last_trade_price);
  return { book_ts: Number(book.timestamp), bestBid, bestAsk, mid, last_trade_price: book.last_trade_price ?? null };
}

console.log('NOTE: orderbook-mid requires REAL-TIME logging because /book has no history.');
console.log(`Polling STATION=${STATION} MARKET_SLUG=${MARKET_SLUG} every ${INTERVAL_SEC}s`);

const { yesTokenId } = await getYesTokenId();

while (true) {
  try {
    const [metar, book] = await Promise.all([fetchMetarSnapshot(), fetchBookMid(yesTokenId)]);
    const row = { ts: new Date().toISOString(), station: STATION, market_slug: MARKET_SLUG, yesTokenId, metar, book };
    await appendFile(`${outDir}/orderbookmid_${STATION}_${MARKET_SLUG}.jsonl`, JSON.stringify(row)+'\n', 'utf8');
    console.log(`${row.ts} tmax=${metar.tmax_so_far} latest=${metar.latest?.temp}C@${metar.latest?.reportTime} mid=${book.mid} bid=${book.bestBid} ask=${book.bestAsk} last=${book.last_trade_price}`);
  } catch (e) {
    console.error('tick_error', e?.message || e);
  }
  await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000));
}
