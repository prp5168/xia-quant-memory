// 回测：TWC 预报准确度 vs WU 结算实测
// 用 TWC historical observations 作为"实测值"（和 WU History 同源）
// 对比我们 observe-log.jsonl 里记录的 mu 值

import { readFile } from 'node:fs/promises';

const TWC_API_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';

async function getHistMax(lat, lon, dateStr){
  const url = `https://api.weather.com/v1/geocode/${lat}/${lon}/observations/historical.json?apiKey=${TWC_API_KEY}&startDate=${dateStr.replace(/-/g,'')}&endDate=${dateStr.replace(/-/g,'')}&units=m`;
  const r = await fetch(url);
  if(!r.ok) return null;
  const data = await r.json();
  if(!data?.observations?.length) return null;
  let max = -999;
  for(const o of data.observations){
    if(o.temp != null && o.temp > max) max = o.temp;
  }
  return max === -999 ? null : max;
}

// Also check: what does NOAA METAR say?
async function getMetarMax(icao, dateStr){
  try{
    const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${icao}&hours=48&format=json`);
    if(!r.ok) return null;
    const data = await r.json();
    let max = -999;
    for(const m of data){
      const obsTime = m.obsTime || m.reportTime || '';
      if(!obsTime.startsWith(dateStr)) continue;
      if(m.temp != null && m.temp > max) max = m.temp;
    }
    return max === -999 ? null : max;
  }catch{ return null; }
}

const CITY_GEO = {
  'Shanghai': {lat:'31.15', lon:'121.803', icao:'ZSPD'},
  'Seoul': {lat:'37.469', lon:'126.451', icao:'RKSI'},
  'NYC': {lat:'40.641', lon:'-73.778', icao:'KJFK'},
  'London': {lat:'51.470', lon:'-0.454', icao:'EGLL'},
  'Dallas': {lat:'32.899', lon:'-97.040', icao:'KDFW'},
  'Chicago': {lat:'41.974', lon:'-87.907', icao:'KORD'},
  'Miami': {lat:'25.795', lon:'-80.287', icao:'KMIA'},
  'Toronto': {lat:'43.677', lon:'-79.624', icao:'CYYZ'},
  'Wellington': {lat:'-41.327', lon:'174.805', icao:'NZWN'},
  'Paris': {lat:'49.009', lon:'2.547', icao:'LFPG'},
  'Warsaw': {lat:'52.166', lon:'20.967', icao:'EPWA'},
  'Madrid': {lat:'40.472', lon:'-3.561', icao:'LEMD'},
  'Lucknow': {lat:'26.761', lon:'80.889', icao:'VILK'},
};

async function main(){
  // Read observe-log to get our model predictions
  const logRaw = await readFile('data/observe-log.jsonl', 'utf8');
  const logs = logRaw.trim().split('\n').map(l => JSON.parse(l));
  
  // Group by city+date, take the earliest prediction (most advance notice = hardest test)
  const predictions = {};
  for(const entry of logs){
    const key = entry.city + '|' + entry.date;
    if(!predictions[key] || entry.ts < predictions[key].ts){
      predictions[key] = entry;
    }
  }
  
  // Only check dates that have already passed (before today)
  const today = new Date().toISOString().slice(0,10);
  const settled = Object.values(predictions).filter(p => p.date < today);
  
  console.log(`Found ${settled.length} settled predictions to backtest\n`);
  
  const results = [];
  for(const pred of settled){
    const geo = CITY_GEO[pred.city];
    if(!geo) continue;
    
    const actual = await getHistMax(geo.lat, geo.lon, pred.date);
    if(actual == null) continue;
    
    const err = pred.mu - actual;
    const forecastErr = pred.forecastMax - actual;
    
    // Check which bin the actual temp fell in, and what our model said vs market
    const actualBin = pred.bins[actual];
    
    results.push({
      city: pred.city,
      date: pred.date,
      forecastMax: pred.forecastMax,
      mu: pred.mu,
      sigma: pred.sigma,
      actual,
      muError: Math.round(err * 10) / 10,
      forecastError: Math.round(forecastErr * 10) / 10,
      actualBinModel: actualBin?.model || 'N/A',
      actualBinMarket: actualBin?.market || 'N/A',
      actualBinEdge: actualBin?.edge || 'N/A',
    });
    
    console.log(`${pred.city} ${pred.date}: forecast=${pred.forecastMax} mu=${pred.mu} actual=${actual} | forecast_err=${forecastErr>0?'+':''}${forecastErr} mu_err=${err>0?'+':''}${err}`);
    if(actualBin){
      console.log(`  实际温度${actual}°C bin: model=${(actualBin.model*100).toFixed(1)}% market=${(actualBin.market*100).toFixed(1)}% edge=${(actualBin.edge*100).toFixed(1)}%`);
    } else {
      console.log(`  实际温度${actual}°C 不在观察bins中`);
    }
  }
  
  if(results.length){
    console.log('\n=== 汇总 ===');
    const muErrs = results.map(r => r.muError);
    const fcErrs = results.map(r => r.forecastError);
    const absMuErrs = muErrs.map(Math.abs);
    const absFcErrs = fcErrs.map(Math.abs);
    
    console.log(`样本数: ${results.length}`);
    console.log(`forecast_max 误差: 均值=${(fcErrs.reduce((a,b)=>a+b,0)/fcErrs.length).toFixed(2)} MAE=${(absFcErrs.reduce((a,b)=>a+b,0)/absFcErrs.length).toFixed(2)} 最大=${Math.max(...absFcErrs)}`);
    console.log(`mu(加权) 误差: 均值=${(muErrs.reduce((a,b)=>a+b,0)/muErrs.length).toFixed(2)} MAE=${(absMuErrs.reduce((a,b)=>a+b,0)/absMuErrs.length).toFixed(2)} 最大=${Math.max(...absMuErrs)}`);
    
    // 按城市分组
    const byCity = {};
    for(const r of results){
      if(!byCity[r.city]) byCity[r.city] = [];
      byCity[r.city].push(r);
    }
    console.log('\n--- 按城市 ---');
    for(const [city, rs] of Object.entries(byCity)){
      const me = rs.map(r=>r.muError);
      const mae = me.map(Math.abs);
      console.log(`${city}: n=${rs.length} mu偏差均值=${(me.reduce((a,b)=>a+b,0)/me.length).toFixed(2)} MAE=${(mae.reduce((a,b)=>a+b,0)/mae.length).toFixed(2)}`);
    }
  }
}
main().catch(e=>console.error(e));
