// Analyze real-time JSONL log from backtest_metar_vs_orderbook_mid.mjs
//
// Usage:
//   WINDOW_MIN=5 THRESHOLD=10 node scripts/analyze_orderbookmid_log.mjs <jsonl>

import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/analyze_orderbookmid_log.mjs <jsonl-file>');
  process.exit(2);
}

const WINDOW_MIN = Number(process.env.WINDOW_MIN || '5');
const THRESHOLD = process.env.THRESHOLD != null ? Number(process.env.THRESHOLD) : null;

function toMs(iso) { return new Date(iso).getTime(); }

function mean(arr){ return arr.length ? arr.reduce((s,x)=>s+x,0)/arr.length : null; }
function median(arr){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y); const m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
function pct(arr,p){ if(!arr.length) return null; const a=[...arr].sort((x,y)=>x-y); const idx=Math.min(a.length-1,Math.max(0,Math.floor((p/100)*a.length))); return a[idx]; }

function nearest(rows, tMs, field) {
  // rows sorted by tsMs
  let lo=0, hi=rows.length-1;
  while (lo<=hi){
    const mid=(lo+hi)>>1;
    const v=rows[mid].tsMs;
    if(v===tMs) return rows[mid][field];
    if(v<tMs) lo=mid+1; else hi=mid-1;
  }
  const a=rows[Math.max(0,Math.min(rows.length-1,hi))];
  const b=rows[Math.max(0,Math.min(rows.length-1,lo))];
  if(!a) return b?.[field] ?? null;
  if(!b) return a?.[field] ?? null;
  const pick = (Math.abs(a.tsMs-tMs) <= Math.abs(b.tsMs-tMs)) ? a : b;
  return pick?.[field] ?? null;
}

const text = await readFile(file, 'utf8');
const lines = text.split(/\n/).filter(Boolean);
const rows = [];
for (const line of lines) {
  try {
    const o = JSON.parse(line);
    const tsMs = toMs(o.ts);
    const mid = o?.book?.mid;
    const tmax = o?.metar?.tmax_so_far;
    const latestObsMs = o?.metar?.latest?.reportTime ? toMs(o.metar.latest.reportTime) : null;
    rows.push({ ts: o.ts, tsMs, mid: (mid!=null?Number(mid):null), tmax: (tmax!=null?Number(tmax):null), latestObsMs });
  } catch {}
}
rows.sort((a,b)=>a.tsMs-b.tsMs);

// Detect METAR events from tmax series over time (as observed in logs)
const events = [];
let prevTmax = null;
let thresholdSeen = false;
let lastEventTsMs = -Infinity;

for (const r of rows) {
  if (!Number.isFinite(r.tmax)) continue;
  if (prevTmax == null) {
    prevTmax = r.tmax;
  } else if (r.tmax > prevTmax) {
    // de-dup if multiple polls before metar changes stabilize
    if (r.tsMs - lastEventTsMs > 60_000) {
      events.push({ kind: 'tmax_new_high', ts: r.ts, tsMs: r.tsMs, from: prevTmax, to: r.tmax });
      lastEventTsMs = r.tsMs;
    }
    prevTmax = r.tmax;
  }
  if (THRESHOLD != null && !thresholdSeen && r.tmax >= THRESHOLD) {
    events.push({ kind: 'threshold_reached', ts: r.ts, tsMs: r.tsMs, threshold: THRESHOLD, tmax: r.tmax });
    thresholdSeen = true;
  }
}

const winMs = WINDOW_MIN * 60_000;

function dpsFor(kind) {
  const ds = [];
  for (const e of events.filter(x=>x.kind===kind)) {
    const p0 = nearest(rows, e.tsMs, 'mid');
    const p1 = nearest(rows, e.tsMs + winMs, 'mid');
    if (!Number.isFinite(p0) || !Number.isFinite(p1)) continue;
    ds.push({ e, p0, p1, dp: p1 - p0 });
  }
  return ds;
}

function summarize(name, ds) {
  const dps = ds.map(x=>x.dp);
  return {
    name,
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

const dsHigh = dpsFor('tmax_new_high');
const dsThr = dpsFor('threshold_reached');

console.log(JSON.stringify({
  file,
  rows: rows.length,
  windowMin: WINDOW_MIN,
  threshold: THRESHOLD,
  events: {
    total: events.length,
    tmax_new_high: events.filter(e=>e.kind==='tmax_new_high').length,
    threshold_reached: events.filter(e=>e.kind==='threshold_reached').length,
  },
  summary: {
    tmax_new_high: summarize('tmax_new_high', dsHigh),
    threshold_reached: summarize('threshold_reached', dsThr),
  },
  preview: {
    tmax_new_high: dsHigh.slice(0, 10),
    threshold_reached: dsThr.slice(0, 10),
  }
}, null, 2));
