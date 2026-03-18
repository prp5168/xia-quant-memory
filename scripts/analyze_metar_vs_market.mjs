// Analyze relationship: METAR -> Polymarket price movements
// Input: JSONL produced by scripts/poll_metar_and_market.mjs
// Usage:
//   node scripts/analyze_metar_vs_market.mjs data/zspd_<slug>.jsonl
// Env:
//   WINDOW_MIN=5
//   THRESHOLD=13   (optional)

import { readFile } from 'node:fs/promises';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/analyze_metar_vs_market.mjs <jsonl-file>');
  process.exit(2);
}

const WINDOW_MIN = Number(process.env.WINDOW_MIN || '5');
const THRESHOLD = process.env.THRESHOLD != null ? Number(process.env.THRESHOLD) : null;

function toMs(iso) { return new Date(iso).getTime(); }

function median(arr) {
  if (!arr.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const mid = Math.floor(a.length/2);
  return a.length % 2 ? a[mid] : (a[mid-1]+a[mid])/2;
}

function mean(arr) {
  if (!arr.length) return null;
  return arr.reduce((s,x)=>s+x,0)/arr.length;
}

function pct(arr, p) {
  if (!arr.length) return null;
  const a = [...arr].sort((x,y)=>x-y);
  const idx = Math.min(a.length-1, Math.max(0, Math.floor((p/100)*a.length)));
  return a[idx];
}

function findNearestPrice(rows, tMs) {
  // rows sorted by tsMs
  let lo = 0, hi = rows.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = rows[mid].tsMs;
    if (v === tMs) return rows[mid];
    if (v < tMs) lo = mid + 1;
    else hi = mid - 1;
  }
  // hi is last < tMs, lo is first > tMs
  const a = rows[Math.max(0, Math.min(rows.length-1, hi))];
  const b = rows[Math.max(0, Math.min(rows.length-1, lo))];
  if (!a) return b;
  if (!b) return a;
  return (Math.abs(a.tsMs - tMs) <= Math.abs(b.tsMs - tMs)) ? a : b;
}

function sampleRandomWindows(rows, windowMs, n) {
  // sample start times uniformly from existing timestamps, require end within range
  const out = [];
  if (rows.length < 2) return out;
  const minT = rows[0].tsMs;
  const maxT = rows[rows.length-1].tsMs - windowMs;
  if (maxT <= minT) return out;
  for (let i=0;i<n;i++) {
    const r = Math.random();
    const t0 = minT + Math.floor(r * (maxT - minT));
    const p0 = findNearestPrice(rows, t0)?.pxYes;
    const p1 = findNearestPrice(rows, t0 + windowMs)?.pxYes;
    if (Number.isFinite(p0) && Number.isFinite(p1)) out.push(p1 - p0);
  }
  return out;
}

const text = await readFile(file, 'utf8');
const rawLines = text.split(/\n/).filter(Boolean);
const rows = [];
for (const line of rawLines) {
  try {
    const o = JSON.parse(line);
    const tsMs = toMs(o.ts);
    const pxYes = o?.market?.prices?.Yes;
    const latestTemp = o?.metar?.latest?.temp_c;
    const tmax = o?.metar?.tmax_so_far;
    rows.push({ ts: o.ts, tsMs, pxYes, latestTemp, tmax });
  } catch {}
}
rows.sort((a,b)=>a.tsMs-b.tsMs);

// Build METAR event times from changes in tmax and threshold crossing
const events = [];
let prevTmax = null;
let seenThreshold = false;

for (const r of rows) {
  if (!Number.isFinite(r.tmax)) continue;
  if (prevTmax == null) {
    prevTmax = r.tmax;
  } else if (r.tmax > prevTmax) {
    events.push({ kind: 'tmax_new_high', ts: r.ts, tsMs: r.tsMs, from: prevTmax, to: r.tmax });
    prevTmax = r.tmax;
  }
  if (THRESHOLD != null && !seenThreshold && r.tmax >= THRESHOLD) {
    events.push({ kind: 'threshold_reached', ts: r.ts, tsMs: r.tsMs, threshold: THRESHOLD, tmax: r.tmax });
    seenThreshold = true;
  }
}

const windowMs = WINDOW_MIN * 60 * 1000;

function computeDeltas(kind) {
  const deltas = [];
  const subset = events.filter(e => e.kind === kind);
  for (const e of subset) {
    const p0 = findNearestPrice(rows, e.tsMs)?.pxYes;
    const p1 = findNearestPrice(rows, e.tsMs + windowMs)?.pxYes;
    if (Number.isFinite(p0) && Number.isFinite(p1)) deltas.push({ e, p0, p1, dp: p1 - p0 });
  }
  return deltas;
}

const deltasHigh = computeDeltas('tmax_new_high');
const deltasThr = computeDeltas('threshold_reached');

function summarize(name, deltas) {
  const dps = deltas.map(x => x.dp);
  const up = dps.filter(x => x > 0).length;
  const eq = dps.filter(x => x === 0).length;
  const down = dps.filter(x => x < 0).length;
  const sum = {
    name,
    n: dps.length,
    mean_dp: mean(dps),
    median_dp: median(dps),
    p10: pct(dps, 10),
    p90: pct(dps, 90),
    up, eq, down,
  };
  return { sum, deltas: deltas.slice(0, 10) }; // preview first 10
}

const randomDps = sampleRandomWindows(rows, windowMs, 500);
const rndSum = {
  n: randomDps.length,
  mean_dp: mean(randomDps),
  median_dp: median(randomDps),
  p10: pct(randomDps, 10),
  p90: pct(randomDps, 90),
  up: randomDps.filter(x=>x>0).length,
  eq: randomDps.filter(x=>x===0).length,
  down: randomDps.filter(x=>x<0).length,
};

console.log(JSON.stringify({
  file,
  windowMin: WINDOW_MIN,
  threshold: THRESHOLD,
  rows: rows.length,
  events: {
    total: events.length,
    tmax_new_high: events.filter(e=>e.kind==='tmax_new_high').length,
    threshold_reached: events.filter(e=>e.kind==='threshold_reached').length,
  },
  summary: {
    tmax_new_high: summarize('tmax_new_high', deltasHigh).sum,
    threshold_reached: summarize('threshold_reached', deltasThr).sum,
    random_windows: rndSum,
  },
  preview: {
    tmax_new_high: summarize('tmax_new_high', deltasHigh).deltas,
    threshold_reached: summarize('threshold_reached', deltasThr).deltas,
  }
}, null, 2));
