#!/usr/bin/env node
/**
 * 回测 observe-log.jsonl：用修复后的 °C/°F 逻辑重算所有信号，
 * 对已结算日期按"首次信号建仓 $10/笔 持有到结算"计算 PnL。
 * 
 * 输出：按桶位、方向、城市类型等维度的统计。
 */

import fs from 'fs';

const actuals = JSON.parse(fs.readFileSync('data/twc_actuals_settled.json', 'utf8'));
const lines = fs.readFileSync('data/observe-log.jsonl', 'utf8').trim().split('\n');
const meta = JSON.parse(fs.readFileSync('data/city_meta.json', 'utf8'));
const CITY_SIGMA = JSON.parse(fs.readFileSync('data/forecast_error_30d.json', 'utf8'));

// °F 城市判断
function isUSCity(city) {
  for (const [slug, m] of Object.entries(meta)) {
    if (m.name === city) return m.icao?.startsWith('K') || false;
  }
  // fallback: 已知美国城市
  return ['NYC','Chicago','Dallas','Miami','Seattle','Atlanta','Houston','Denver',
          'Los Angeles','San Francisco','Austin'].includes(city);
}

function cToF(c) { return c * 9/5 + 32; }

function normCdf(x) {
  const s = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429;
  return 0.5*(1+s*(1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x)));
}

function pBin(mu, sig, k, binW) {
  return Math.max(0, normCdf((k + binW/2 - mu) / sig) - normCdf((k - binW/2 - mu) / sig));
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

// ═══ 主逻辑 ═══
const MIN_EDGE = 0.15;
const MIN_NO_PRICE = 0.60;
const PRICE_CAP = 0.90;
const TRADE_SIZE = 10;
const SIGMA_MULT = 2.0; // day1 乘数

// 收集每个 city+date+k 的首次信号
// key = city|date|k
const firstSignals = new Map();

for (const line of lines) {
  const d = JSON.parse(line);
  if (!d.bins || d.marketMissing) continue;
  if (d.isToday) continue; // 不做当天

  const city = d.city;
  const date = d.date;
  const usesF = isUSCity(city);
  
  // 重算 mu/sigma（用原始 forecastMax, 因为 observe-log 里的 mu 可能是 bug 值）
  let muC = d.muC || d.mu; // 新格式有 muC，旧格式 mu 就是 °C
  // 旧格式的 mu: 如果 usesF 且 mu < 40, 那就是 °C
  if (usesF && muC > 40) {
    // 这可能是已经转过的，但旧数据不可能 > 40
    // 新格式才有 muC（肯定是 °C）
    // 如果没有 muC，用 forecastMax 近似
    muC = d.forecastMax;
  }
  
  const mu = usesF ? cToF(muC) : muC;
  
  // sigma: 用实际记录的 sigma（已包含 day 乘数），如果太小则用默认
  let sigma = d.sigma || 1.5;
  // 旧数据的 sigma 是 °C，°F 城市需要转换
  if (usesF && sigma < 5) {
    sigma = sigma * 1.8;
  }

  // 重算概率分布
  const dist = buildDist(mu, sigma, usesF);

  for (const [kStr, binData] of Object.entries(d.bins)) {
    const k = Number(kStr);
    
    // 获取市场价
    let yesP = null;
    if (binData.yesP !== undefined) yesP = binData.yesP;
    else if (binData.market !== undefined && binData.market !== null) yesP = binData.market;
    
    if (yesP === null || yesP === undefined) continue;
    
    const noP = 1 - yesP;
    const modelP = dist[k] || 0;
    
    // 计算 edge
    const edgeYes = modelP - yesP;
    const edgeNo = (1 - modelP) - noP;
    const dir = edgeYes > edgeNo ? 'BUY_YES' : 'BUY_NO';
    const edge = dir === 'BUY_YES' ? edgeYes : edgeNo;
    
    if (Math.abs(edge) < MIN_EDGE) continue;
    
    // dist from mu
    const distFromMu = Math.abs(k - mu);
    const cThresh = usesF ? 3.6 : 2;
    const nThresh = usesF ? 1.8 : 1;
    const bucket = distFromMu > cThresh ? 'tail' : (distFromMu > nThresh ? 'near' : 'center');
    
    // 价格过滤
    if (dir === 'BUY_NO' && noP < MIN_NO_PRICE) continue;
    if (dir === 'BUY_NO' && noP > PRICE_CAP) continue;
    
    const key = `${city}|${date}|${k}`;
    
    if (!firstSignals.has(key)) {
      firstSignals.set(key, {
        city, date, k, dir, bucket, edge: Math.abs(edge),
        yesP, noP, modelP, mu, sigma, usesF,
        distFromMu: Math.round(distFromMu * 10) / 10,
        ts: d.ts,
      });
    }
  }
}

// ═══ 结算 ═══
const results = [];

for (const [key, sig] of firstSignals) {
  const actualKey = `${sig.city}|${sig.date}`;
  const actual = actuals[actualKey];
  if (!actual) continue; // 未结算
  
  const actualTemp = sig.usesF ? actual.maxF : actual.maxC;
  if (actualTemp === undefined) continue;
  
  // PM bin 判定: °F 城市 bin 是 [k, k+2)°F，°C 城市 bin 是 exactly k°C
  let yesWins;
  if (sig.usesF) {
    yesWins = (actualTemp === sig.k) || (actualTemp === sig.k + 1);
  } else {
    yesWins = (actualTemp === sig.k);
  }
  
  let pnl;
  if (sig.dir === 'BUY_NO') {
    const shares = TRADE_SIZE / sig.noP;
    pnl = yesWins ? -TRADE_SIZE : (shares - TRADE_SIZE);
  } else {
    const shares = TRADE_SIZE / sig.yesP;
    pnl = yesWins ? (shares - TRADE_SIZE) : -TRADE_SIZE;
  }
  
  results.push({
    ...sig,
    actualTemp,
    yesWins,
    win: (sig.dir === 'BUY_NO') ? !yesWins : yesWins,
    pnl,
  });
}

// ═══ 输出 ═══
console.log('=== 全量观察数据回测（修复后逻辑） ===');
console.log('observe-log 行数:', lines.length);
console.log('首次信号数:', firstSignals.size);
console.log('可结算信号:', results.length);
console.log('结算日期: 03-21 ~ 03-29');
console.log();

// 按方向+桶位
function stats(arr, label) {
  if (!arr.length) return;
  const wins = arr.filter(r => r.win).length;
  const pnl = arr.reduce((s, r) => s + r.pnl, 0);
  console.log(`${label.padEnd(25)}: ${arr.length}笔 | ${wins}赢 | WR=${(wins/arr.length*100).toFixed(1)}% | PnL=$${pnl.toFixed(2)} | 均=$${(pnl/arr.length).toFixed(2)}`);
}

console.log('--- 全部信号（含 BUY_YES） ---');
stats(results, '全部');
stats(results.filter(r => r.dir === 'BUY_NO'), 'BUY_NO');
stats(results.filter(r => r.dir === 'BUY_YES'), 'BUY_YES');

console.log('\n--- BUY_NO 按桶位 ---');
const noResults = results.filter(r => r.dir === 'BUY_NO');
stats(noResults.filter(r => r.bucket === 'tail'), 'BUY_NO tail');
stats(noResults.filter(r => r.bucket === 'near'), 'BUY_NO near');
stats(noResults.filter(r => r.bucket === 'center'), 'BUY_NO center');

console.log('\n--- BUY_YES 按桶位 ---');
const yesResults = results.filter(r => r.dir === 'BUY_YES');
stats(yesResults.filter(r => r.bucket === 'tail'), 'BUY_YES tail');
stats(yesResults.filter(r => r.bucket === 'near'), 'BUY_YES near');
stats(yesResults.filter(r => r.bucket === 'center'), 'BUY_YES center');

console.log('\n--- BUY_NO 按城市类型 ---');
stats(noResults.filter(r => r.usesF), 'BUY_NO °F城市');
stats(noResults.filter(r => !r.usesF), 'BUY_NO °C城市');

console.log('\n--- BUY_NO °F 按桶位 ---');
const noF = noResults.filter(r => r.usesF);
stats(noF.filter(r => r.bucket === 'tail'), 'BUY_NO °F tail');
stats(noF.filter(r => r.bucket === 'near'), 'BUY_NO °F near');
stats(noF.filter(r => r.bucket === 'center'), 'BUY_NO °F center');

console.log('\n--- BUY_NO °C 按桶位 ---');
const noC = noResults.filter(r => !r.usesF);
stats(noC.filter(r => r.bucket === 'tail'), 'BUY_NO °C tail');
stats(noC.filter(r => r.bucket === 'near'), 'BUY_NO °C near');
stats(noC.filter(r => r.bucket === 'center'), 'BUY_NO °C center');

// 按 NO 入场价分段
console.log('\n--- BUY_NO tail+near 按 NO 入场价 ---');
const noTailNear = noResults.filter(r => r.bucket !== 'center');
for (const [lo, hi, label] of [[0.6,0.65,'60-65%'],[0.65,0.7,'65-70%'],[0.7,0.75,'70-75%'],[0.75,0.8,'75-80%'],[0.8,0.85,'80-85%'],[0.85,0.9,'85-90%']]) {
  stats(noTailNear.filter(r => r.noP >= lo && r.noP < hi), 'NO ' + label);
}

// 按日期
console.log('\n--- 按结算日期 ---');
const dates = [...new Set(results.map(r => r.date))].sort();
for (const d of dates) {
  const dr = noResults.filter(r => r.date === d && r.bucket !== 'center');
  stats(dr, d + ' (NO tail+near)');
}

// V2.1 模拟：只做 BUY_NO tail+near
console.log('\n\n========== V2.1 策略模拟（BUY_NO tail+near only）==========');
const v21 = noResults.filter(r => r.bucket !== 'center');
stats(v21, '总计');
stats(v21.filter(r => r.bucket === 'tail'), 'tail');
stats(v21.filter(r => r.bucket === 'near'), 'near');

// 权益曲线
console.log('\n--- 权益曲线（按日期） ---');
let equity = 0;
for (const d of dates) {
  const dr = v21.filter(r => r.date === d);
  const dayPnl = dr.reduce((s, r) => s + r.pnl, 0);
  const dayWins = dr.filter(r => r.win).length;
  equity += dayPnl;
  console.log(`${d}: ${dr.length}笔 ${dayWins}赢 PnL=$${dayPnl.toFixed(2)} 累计=$${equity.toFixed(2)}`);
}

// 每城市
console.log('\n--- V2.1 策略 按城市 ---');
const cities = [...new Set(v21.map(r => r.city))].sort();
for (const c of cities) {
  stats(v21.filter(r => r.city === c), c);
}
