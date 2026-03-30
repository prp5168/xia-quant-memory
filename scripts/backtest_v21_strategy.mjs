#!/usr/bin/env node
/**
 * 回测 V2.1 现有策略：用 observe-log.jsonl 数据，完全模拟线上规则。
 *
 * 规则（读自 portfolio.json rules）：
 * - BUY_NO only
 * - tail + near only（center 禁止）
 * - minNoPrice = 0.60，priceCap = 0.90
 * - minEdge = 0.15
 * - maxCityPerDay = 3
 * - maxSingleTrade = 20（回测统一用 $10/笔）
 * - tail: 持有到结算
 * - near: 止盈 NO≥90%，止损 NO≤20%（中途观察不到盘口变化，回测简化为持有到结算）
 * - 每个 city+date+k 只建一次仓（首次信号）
 * - °C/°F 修复后逻辑
 * - 10% fee（03-30 起）按 min(p, 1-p) × shares 计算
 *
 * 输出：多维度统计 + 权益曲线 + 参数敏感度
 */

import fs from 'fs';

const actuals = JSON.parse(fs.readFileSync('data/twc_actuals_settled.json', 'utf8'));
const lines = fs.readFileSync('data/observe-log.jsonl', 'utf8').trim().split('\n');

let meta;
try { meta = JSON.parse(fs.readFileSync('data/city_meta.json', 'utf8')); } catch { meta = {}; }

const US_CITIES = new Set([
  'NYC','Chicago','Dallas','Miami','Seattle','Atlanta','Houston',
  'Denver','Los Angeles','San Francisco','Austin',
]);

function isUSCity(city) {
  if (US_CITIES.has(city)) return true;
  for (const [, m] of Object.entries(meta)) {
    if (m.name === city) return m.icao?.startsWith('K') || false;
  }
  return false;
}

function cToF(c) { return c * 9/5 + 32; }

function normCdf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  return 0.5*(1+s*(1-((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x)));
}

function pBin(mu, sig, k, bw) {
  return Math.max(0, normCdf((k + bw/2 - mu) / sig) - normCdf((k - bw/2 - mu) / sig));
}

function buildDist(mu, sigma, usesF) {
  const p = {};
  let t = 0;
  if (usesF) {
    const lo = Math.floor((mu - 12) / 2) * 2;
    const hi = Math.ceil((mu + 12) / 2) * 2;
    for (let k = lo; k <= hi; k += 2) {
      const v = pBin(mu, sigma, k, 2);
      if (v > 0.0005) { p[k] = v; t += v; }
    }
  } else {
    for (let k = Math.floor(mu - 5); k <= Math.ceil(mu + 5); k++) {
      const v = pBin(mu, sigma, k, 1);
      if (v > 0.001) { p[k] = v; t += v; }
    }
  }
  for (const k of Object.keys(p)) p[k] /= t;
  return p;
}

// ═══ 常量 ═══
const MIN_EDGE = 0.15;
const MIN_NO_PRICE = 0.60;
const PRICE_CAP = 0.90;
const TRADE_SIZE = 10;
const MAX_CITY_PER_DAY = 3;
const FEE_RATE = 0.10; // 10% fee，对 03-30+ 生效
const FEE_START_DATE = '2026-03-30'; // fee 生效日

// ═══ 收集所有信号 ═══
// 每个 city+date+k 只取首次信号
const firstSignals = new Map();

for (const line of lines) {
  const d = JSON.parse(line);
  if (!d.bins || d.marketMissing) continue;
  if (d.isToday) continue; // 不做当天

  const city = d.city;
  const date = d.date;
  const usesF = isUSCity(city);

  // 还原 muC
  let muC = d.muC || d.mu;
  if (usesF && muC > 40) muC = d.forecastMax;

  const mu = usesF ? cToF(muC) : muC;
  let sigma = d.sigma || 1.5;
  if (usesF && sigma < 5) sigma *= 1.8;

  const dist = buildDist(mu, sigma, usesF);

  for (const [kStr, binData] of Object.entries(d.bins)) {
    const k = Number(kStr);

    // 读取市场价格
    let yesP = null;
    if (binData.yesP !== undefined) yesP = binData.yesP;
    else if (binData.market !== undefined && binData.market !== null) yesP = binData.market;
    if (yesP === null || yesP === undefined) continue;

    const noP = 1 - yesP;
    const modelP = dist[k] || 0;

    // 只看 BUY_NO
    const edgeNo = (1 - modelP) - noP;
    if (edgeNo < MIN_EDGE) continue;

    // 价格过滤
    if (noP < MIN_NO_PRICE || noP > PRICE_CAP) continue;

    // 桶位
    const distFromMu = Math.abs(k - mu);
    const cThresh = usesF ? 3.6 : 2;
    const nThresh = usesF ? 1.8 : 1;
    const bucket = distFromMu > cThresh ? 'tail' : (distFromMu > nThresh ? 'near' : 'center');

    // 只做 tail + near
    if (bucket === 'center') continue;

    const key = `${city}|${date}|${k}`;
    if (!firstSignals.has(key)) {
      firstSignals.set(key, {
        city, date, k, bucket, edge: edgeNo,
        yesP, noP, modelP, mu, sigma, usesF,
        distFromMu: Math.round(distFromMu * 10) / 10,
        ts: d.ts,
      });
    }
  }
}

// ═══ 模拟建仓 ═══
// 按时间排序信号，模拟 maxCityPerDay 限制
const allSignals = [...firstSignals.values()].sort((a, b) => a.ts.localeCompare(b.ts));

// 按 city+date 计数已建仓数
const cityDateCount = new Map(); // "city|date" -> count
const positions = [];

for (const sig of allSignals) {
  const cdKey = `${sig.city}|${sig.date}`;
  const current = cityDateCount.get(cdKey) || 0;
  if (current >= MAX_CITY_PER_DAY) continue;

  cityDateCount.set(cdKey, current + 1);
  positions.push(sig);
}

// ═══ 结算 ═══
const results = [];

for (const pos of positions) {
  const actualKey = `${pos.city}|${pos.date}`;
  const actual = actuals[actualKey];
  if (!actual) continue; // 未结算

  const actualTemp = pos.usesF ? actual.maxF : actual.maxC;
  if (actualTemp === undefined) continue;

  let yesWins;
  if (pos.usesF) {
    yesWins = (actualTemp === pos.k) || (actualTemp === pos.k + 1);
  } else {
    yesWins = (actualTemp === pos.k);
  }

  const shares = TRADE_SIZE / pos.noP;

  // fee 计算
  const hasFee = pos.date >= FEE_START_DATE;
  const feeEntry = hasFee ? FEE_RATE * Math.min(pos.noP, 1 - pos.noP) * shares : 0;

  let pnl;
  if (yesWins) {
    // NO 归零，全亏
    pnl = -(TRADE_SIZE + feeEntry);
  } else {
    // NO 赢，获得 shares
    pnl = (shares - TRADE_SIZE) - feeEntry;
  }

  results.push({
    ...pos,
    actualTemp,
    yesWins,
    win: !yesWins,
    pnl,
    feeEntry,
    hasFee,
  });
}

// ═══ 输出 ═══
function stats(arr, label, indent = '') {
  if (!arr.length) { console.log(`${indent}${label.padEnd(30)}: 0笔`); return; }
  const wins = arr.filter(r => r.win).length;
  const pnl = arr.reduce((s, r) => s + r.pnl, 0);
  const fee = arr.reduce((s, r) => s + r.feeEntry, 0);
  console.log(`${indent}${label.padEnd(30)}: ${arr.length}笔 | ${wins}赢 | WR=${(wins/arr.length*100).toFixed(1)}% | PnL=$${pnl.toFixed(2)} | 均=$${(pnl/arr.length).toFixed(2)}${fee > 0 ? ` | fee=$${fee.toFixed(2)}` : ''}`);
}

console.log('╔══════════════════════════════════════════════════════════════╗');
console.log('║    V2.1 策略回测（observe-log 全量，修复后逻辑）           ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log();
console.log('规则: BUY_NO only | tail+near | NO≥60% NO≤90% | edge≥15% | maxCity/day=3');
console.log(`信号池: ${firstSignals.size} | 建仓（含maxCity限制）: ${positions.length} | 可结算: ${results.length}`);
console.log(`结算日: ${[...new Set(results.map(r=>r.date))].sort().join(', ')}`);
console.log();

// 总体
stats(results, '📊 总计');
console.log();

// 按桶位
console.log('--- 按桶位 ---');
stats(results.filter(r => r.bucket === 'tail'), 'tail');
stats(results.filter(r => r.bucket === 'near'), 'near');

// 按城市类型
console.log('\n--- 按城市类型 ---');
stats(results.filter(r => r.usesF), '°F 城市');
stats(results.filter(r => !r.usesF), '°C 城市');

// °F 按桶位
console.log('\n--- °F 城市按桶位 ---');
stats(results.filter(r => r.usesF && r.bucket === 'tail'), '°F tail');
stats(results.filter(r => r.usesF && r.bucket === 'near'), '°F near');

// °C 按桶位
console.log('\n--- °C 城市按桶位 ---');
stats(results.filter(r => !r.usesF && r.bucket === 'tail'), '°C tail');
stats(results.filter(r => !r.usesF && r.bucket === 'near'), '°C near');

// 按结算日期
console.log('\n--- 按结算日期 ---');
const dates = [...new Set(results.map(r => r.date))].sort();
let equity = 0;
for (const d of dates) {
  const dr = results.filter(r => r.date === d);
  const dayPnl = dr.reduce((s, r) => s + r.pnl, 0);
  const dayWins = dr.filter(r => r.win).length;
  equity += dayPnl;
  const feeDay = dr.reduce((s,r) => s + r.feeEntry, 0);
  console.log(`${d}: ${dr.length}笔 ${dayWins}赢 WR=${(dayWins/dr.length*100).toFixed(0)}% PnL=$${dayPnl.toFixed(2)} 累计=$${equity.toFixed(2)}${feeDay > 0 ? ` fee=$${feeDay.toFixed(2)}` : ''}`);
}

// 按城市
console.log('\n--- 按城市 ---');
const cities = [...new Set(results.map(r => r.city))].sort();
for (const c of cities) {
  stats(results.filter(r => r.city === c), c, '  ');
}

// 按 NO 入场价分段
console.log('\n--- 按 NO 入场价分段 ---');
for (const [lo, hi, label] of [
  [0.60, 0.65, '60-65%'],
  [0.65, 0.70, '65-70%'],
  [0.70, 0.75, '70-75%'],
  [0.75, 0.80, '75-80%'],
  [0.80, 0.85, '80-85%'],
  [0.85, 0.90, '85-90%'],
]) {
  stats(results.filter(r => r.noP >= lo && r.noP < hi), 'NO ' + label, '  ');
}

// ═══ 参数敏感度 ═══
console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
console.log('║    参数敏感度分析                                           ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

// minNoPrice 敏感度
console.log('\n--- minNoPrice 敏感度（对全部可结算信号，不受 maxCityPerDay 限制）---');
// 重新从 firstSignals 出发，不施加 maxCityPerDay 限制
const allSettled = [];
for (const [, sig] of firstSignals) {
  const actual = actuals[`${sig.city}|${sig.date}`];
  if (!actual) continue;
  const actualTemp = sig.usesF ? actual.maxF : actual.maxC;
  if (actualTemp === undefined) continue;
  let yesWins;
  if (sig.usesF) yesWins = (actualTemp === sig.k) || (actualTemp === sig.k + 1);
  else yesWins = (actualTemp === sig.k);
  const shares = TRADE_SIZE / sig.noP;
  const hasFee = sig.date >= FEE_START_DATE;
  const feeEntry = hasFee ? FEE_RATE * Math.min(sig.noP, 1 - sig.noP) * shares : 0;
  const pnl = yesWins ? -(TRADE_SIZE + feeEntry) : (shares - TRADE_SIZE - feeEntry);
  allSettled.push({ ...sig, actualTemp, win: !yesWins, pnl, feeEntry, hasFee });
}

for (const thr of [0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80]) {
  const arr = allSettled.filter(r => r.noP >= thr);
  stats(arr, `NO≥${(thr*100).toFixed(0)}%`, '  ');
}

// edge 敏感度
console.log('\n--- edge 敏感度（NO≥60%）---');
for (const minEdge of [0.15, 0.20, 0.25, 0.30]) {
  const arr = allSettled.filter(r => r.noP >= 0.60 && r.edge >= minEdge);
  stats(arr, `edge≥${(minEdge*100).toFixed(0)}%`, '  ');
}

// ═══ 反事实：如果 minNoPrice = 70% ═══
console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
console.log('║    反事实：如果 minNoPrice = 70%                           ║');
console.log('╚══════════════════════════════════════════════════════════════╝');

// 重新模拟建仓（70% 阈值 + maxCityPerDay）
const firstSignals70 = new Map();
for (const [key, sig] of firstSignals) {
  if (sig.noP >= 0.70) firstSignals70.set(key, sig);
}
const allSignals70 = [...firstSignals70.values()].sort((a, b) => a.ts.localeCompare(b.ts));
const cityDateCount70 = new Map();
const positions70 = [];
for (const sig of allSignals70) {
  const cdKey = `${sig.city}|${sig.date}`;
  const current = cityDateCount70.get(cdKey) || 0;
  if (current >= MAX_CITY_PER_DAY) continue;
  cityDateCount70.set(cdKey, current + 1);
  positions70.push(sig);
}

const results70 = [];
for (const pos of positions70) {
  const actual = actuals[`${pos.city}|${pos.date}`];
  if (!actual) continue;
  const actualTemp = pos.usesF ? actual.maxF : actual.maxC;
  if (actualTemp === undefined) continue;
  let yesWins;
  if (pos.usesF) yesWins = (actualTemp === pos.k) || (actualTemp === pos.k + 1);
  else yesWins = (actualTemp === pos.k);
  const shares = TRADE_SIZE / pos.noP;
  const hasFee = pos.date >= FEE_START_DATE;
  const feeEntry = hasFee ? FEE_RATE * Math.min(pos.noP, 1 - pos.noP) * shares : 0;
  const pnl = yesWins ? -(TRADE_SIZE + feeEntry) : (shares - TRADE_SIZE - feeEntry);
  results70.push({ ...pos, actualTemp, win: !yesWins, pnl, feeEntry, hasFee });
}

console.log();
stats(results70, '📊 总计（NO≥70%）');
console.log();

console.log('--- 按桶位 ---');
stats(results70.filter(r => r.bucket === 'tail'), 'tail');
stats(results70.filter(r => r.bucket === 'near'), 'near');

console.log('\n--- 按结算日期 ---');
let eq70 = 0;
for (const d of [...new Set(results70.map(r=>r.date))].sort()) {
  const dr = results70.filter(r => r.date === d);
  const dayPnl = dr.reduce((s, r) => s + r.pnl, 0);
  eq70 += dayPnl;
  console.log(`${d}: ${dr.length}笔 ${dr.filter(r=>r.win).length}赢 PnL=$${dayPnl.toFixed(2)} 累计=$${eq70.toFixed(2)}`);
}

// ═══ 直接对比两个方案 ═══
console.log('\n\n╔══════════════════════════════════════════════════════════════╗');
console.log('║    方案对比                                                  ║');
console.log('╚══════════════════════════════════════════════════════════════╝');
console.log();

function scenarioSummary(arr, label) {
  const wins = arr.filter(r => r.win).length;
  const pnl = arr.reduce((s, r) => s + r.pnl, 0);
  const fee = arr.reduce((s, r) => s + r.feeEntry, 0);
  // 最大回撤
  const sorted = [...arr].sort((a,b) => a.date.localeCompare(b.date) || a.ts.localeCompare(b.ts));
  let eq = 0, peak = 0, maxDD = 0;
  for (const r of sorted) {
    eq += r.pnl;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDD) maxDD = peak - eq;
  }
  // 盈亏比
  const avgWin = wins > 0 ? arr.filter(r=>r.win).reduce((s,r)=>s+r.pnl,0) / wins : 0;
  const losses = arr.length - wins;
  const avgLoss = losses > 0 ? Math.abs(arr.filter(r=>!r.win).reduce((s,r)=>s+r.pnl,0)) / losses : 0;
  const winLossRatio = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '∞';

  console.log(`${label}`);
  console.log(`  笔数: ${arr.length} | 赢: ${wins} | WR: ${(wins/arr.length*100).toFixed(1)}%`);
  console.log(`  PnL: $${pnl.toFixed(2)} | 均笔: $${(pnl/arr.length).toFixed(2)} | fee: $${fee.toFixed(2)}`);
  console.log(`  MaxDD: $${maxDD.toFixed(2)} | 盈亏比: ${winLossRatio} | 平均赢: $${avgWin.toFixed(2)} | 平均亏: $${avgLoss.toFixed(2)}`);
  console.log();
}

scenarioSummary(results, '方案A: 当前 V2.1（tail+near, NO≥60%）');
scenarioSummary(results70, '方案B: 收紧到 NO≥70%（tail+near）');

// 60-70% 单独看
const band60_70 = results.filter(r => r.noP >= 0.60 && r.noP < 0.70);
if (band60_70.length) {
  scenarioSummary(band60_70, '拆出: NO 60-70% 这批单子');
}

// 逐笔列出 60-70% 的输单
const losses60_70 = band60_70.filter(r => !r.win);
if (losses60_70.length) {
  console.log('--- NO 60-70% 输单详情 ---');
  for (const r of losses60_70.sort((a,b) => a.pnl - b.pnl)) {
    console.log(`  ❌ ${r.city.padEnd(14)} ${r.date} k=${r.k} mu=${r.mu.toFixed(0)}${r.usesF?'°F':'°C'} [${r.bucket}] NO=${(r.noP*100).toFixed(0)}% edge=${(r.edge*100).toFixed(0)}% → actual=${r.actualTemp} PnL=$${r.pnl.toFixed(2)}`);
  }
}
