// Backtest last N hours: METAR (NOAA AWC) vs Polymarket CLOB price history
// Focus: event study with 5-minute window
//
// Usage:
//   HOURS=10 WINDOW_MIN=5 THRESHOLD=13 MARKET_SLUG=... node scripts/backtest_last10h_metar_vs_price.mjs
//
// Notes:
// - Uses NOAA AWC /api/data/metar (JSON)
// - Uses Polymarket CLOB /prices-history?market=<token_id>

const MARKET_SLUG = process.env.MARKET_SLUG || 'highest-temperature-in-shanghai-on-march-17-2026-13c';
const STATION = process.env.STATION || 'ZSPD';
const HOURS = Number(process.env.HOURS || '10');
const WINDOW_MIN = Number(process.env.WINDOW_MIN || '5');
const THRESHOLD = process.env.THRESHOLD != null ? Number(process.env.THRESHOLD) : null;

function mean(arr){ return arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : null; }
function median(arr){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function pct(arr,p){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y); const idx=Math.min(a.length-1,Math.max(0,Math.floor((p/100)*a.length))); return a[idx]; }

async function fetchGammaMarket() {
  const url = `https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(MARKET_SLUG)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!res.ok) throw new Error(`Gamma failed: ${res.status}`);
  const arr = await res.json();
  const m = arr[0];
  if (!m) throw new Error('market not found');
  const tokenIds = JSON.parse(m.clobTokenIds);
  const outcomes = JSON.parse(m.outcomes);
  // Assume outcomes align with tokenIds, and "Yes" is present.
  const idxYes = outcomes.findIndex(o => o.toLowerCase() === 'yes');
  const yesTokenId = idxYes >= 0 ? tokenIds[idxYes] : tokenIds[0];
  return { m, yesTokenId, outcomes, tokenIds };
}

async function fetchMetars(hours) {
  const url = new URL('https://aviationweather.gov/api/data/metar');
  url.searchParams.set('ids', STATION);
  url.searchParams.set('hours', String(hours));
  url.searchParams.set('format', 'json');
  const res = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!res.ok) throw new Error(`NOAA AWC failed: ${res.status}`);
  const arr = await res.json();
  const ms = arr.map(x => ({
    t: (x.obsTime != null ? Number(x.obsTime) : null),
    reportTime: x.reportTime ?? null,
    temp: (x.temp != null ? Number(x.temp) : null),
    raw: x.rawOb ?? null,
  })).filter(x => Number.isFinite(x.t));
  ms.sort((a,b)=>a.t-b.t);
  return ms;
}

async function fetchPriceHistory(tokenId) {
  // Request 1-minute fidelity over 1 day, then slice last N hours.
  const url = new URL('https://clob.polymarket.com/prices-history');
  url.searchParams.set('market', tokenId);
  url.searchParams.set('interval', '1d');
  url.searchParams.set('fidelity', '60');
  const res = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!res.ok) throw new Error(`CLOB price history failed: ${res.status}`);
  const o = await res.json();
  const hist = (o.history || []).map(x => ({ t: Number(x.t), p: Number(x.p) }))
    .filter(x => Number.isFinite(x.t) && Number.isFinite(x.p));
  hist.sort((a,b)=>a.t-b.t);
  return hist;
}

function nearestPrice(hist, t) {
  // hist sorted by t (epoch sec)
  let lo=0, hi=hist.length-1;
  while (lo<=hi){
    const mid=(lo+hi)>>1;
    const v=hist[mid].t;
    if (v===t) return hist[mid].p;
    if (v<t) lo=mid+1; else hi=mid-1;
  }
  const a=hist[Math.max(0,Math.min(hist.length-1,hi))];
  const b=hist[Math.max(0,Math.min(hist.length-1,lo))];
  if(!a) return b?.p ?? null;
  if(!b) return a?.p ?? null;
  return (Math.abs(a.t-t)<=Math.abs(b.t-t)) ? a.p : b.p;
}

function summarizeDps(dps){
  return {
    n: dps.length,
    mean_dp: mean(dps),
    median_dp: median(dps),
    p10: pct(dps,10),
    p90: pct(dps,90),
    up: dps.filter(x=>x>0).length,
    eq: dps.filter(x=>x===0).length,
    down: dps.filter(x=>x<0).length,
  };
}

async function main(){
  const { m, yesTokenId } = await fetchGammaMarket();
  const [metars, prices] = await Promise.all([fetchMetars(HOURS), fetchPriceHistory(yesTokenId)]);

  const now = Math.floor(Date.now()/1000);
  const start = now - HOURS*3600;
  const met = metars.filter(x => x.t >= start);
  const px = prices.filter(x => x.t >= start);

  // compute tmax_so_far at each METAR
  let tmax = null;
  const metSeries = met.map(x => {
    if (Number.isFinite(x.temp)) tmax = (tmax==null?x.temp:Math.max(tmax,x.temp));
    return { ...x, tmax_so_far: tmax };
  }).filter(x => x.tmax_so_far != null);

  // events
  const events=[];
  let prev=null;
  let thresholdSeen=false;
  for (const r of metSeries){
    if(prev==null) prev=r.tmax_so_far;
    else if(r.tmax_so_far>prev){
      events.push({kind:'tmax_new_high', t:r.t, from:prev, to:r.tmax_so_far, temp:r.temp, raw:r.raw});
      prev=r.tmax_so_far;
    }
    if(THRESHOLD!=null && !thresholdSeen && r.tmax_so_far>=THRESHOLD){
      events.push({kind:'threshold_reached', t:r.t, threshold:THRESHOLD, tmax:r.tmax_so_far, temp:r.temp, raw:r.raw});
      thresholdSeen=true;
    }
  }

  const winSec = WINDOW_MIN*60;
  const deltasByKind = { tmax_new_high: [], threshold_reached: [] };
  const previewsByKind = { tmax_new_high: [], threshold_reached: [] };

  for (const e of events){
    const p0 = nearestPrice(px, e.t);
    const p1 = nearestPrice(px, e.t + winSec);
    if(!Number.isFinite(p0) || !Number.isFinite(p1)) continue;
    const dp = p1 - p0;
    deltasByKind[e.kind].push(dp);
    if (previewsByKind[e.kind].length < 10) previewsByKind[e.kind].push({ e, p0, p1, dp });
  }

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    station: STATION,
    market: { slug: m.slug, id: m.id, yesTokenId, endDate: m.endDate },
    windowMin: WINDOW_MIN,
    threshold: THRESHOLD,
    range: { startEpoch: start, endEpoch: now, hours: HOURS },
    samples: { metars: met.length, metarsUsed: metSeries.length, prices: px.length },
    events: {
      total: events.length,
      tmax_new_high: events.filter(x=>x.kind==='tmax_new_high').length,
      threshold_reached: events.filter(x=>x.kind==='threshold_reached').length,
    },
    summary: {
      tmax_new_high: summarizeDps(deltasByKind.tmax_new_high),
      threshold_reached: summarizeDps(deltasByKind.threshold_reached),
    },
    preview: previewsByKind
  }, null, 2));
}

main().catch(e=>{ console.error(e); process.exit(1); });
