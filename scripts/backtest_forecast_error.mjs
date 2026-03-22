// 回测：预报误差 = 预报值 - 实测值
// 数据源：
// - Open-Meteo historical forecast API（过去的预报存档）
// - TWC historical observations（WU同源实测）
// 
// 思路：对每一天，拉"提前1天的预报"和"提前2天的预报"，对比实测

import { readFile, writeFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';

const TWC_API_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';

const CITIES = [
  {name:'Shanghai', lat:31.15, lon:121.803, twcLat:'31.15', twcLon:'121.803'},
  {name:'Seoul', lat:37.469, lon:126.451, twcLat:'37.469', twcLon:'126.451'},
  {name:'NYC', lat:40.641, lon:-73.778, twcLat:'40.641', twcLon:'-73.778'},
  {name:'London', lat:51.470, lon:-0.454, twcLat:'51.470', twcLon:'-0.454'},
  {name:'Chicago', lat:41.974, lon:-87.907, twcLat:'41.974', twcLon:'-87.907'},
  {name:'Dallas', lat:32.899, lon:-97.040, twcLat:'32.899', twcLon:'-97.040'},
  {name:'Miami', lat:25.795, lon:-80.287, twcLat:'25.795', twcLon:'-80.287'},
  {name:'Toronto', lat:43.677, lon:-79.624, twcLat:'43.677', twcLon:'-79.624'},
  {name:'Paris', lat:49.009, lon:2.547, twcLat:'49.009', twcLon:'2.547'},
  {name:'Warsaw', lat:52.166, lon:20.967, twcLat:'52.166', twcLon:'20.967'},
  {name:'Madrid', lat:40.472, lon:-3.561, twcLat:'40.472', twcLon:'-3.561'},
  {name:'Wellington', lat:-41.327, lon:174.805, twcLat:'-41.327', twcLon:'174.805'},
  {name:'Lucknow', lat:26.761, lon:80.889, twcLat:'26.761', twcLon:'80.889'},
];

// Open-Meteo: 拉某天的预报（这是那天发出的预报，不是实测）
function curlJSON(url){
  try{
    const out = execSync(`curl -s "${url}"`, {timeout:10000}).toString();
    return JSON.parse(out);
  }catch{ return null; }
}

async function getActualMax(lat, lon, dateStr){
  const url = `https://api.weather.com/v1/geocode/${lat}/${lon}/observations/historical.json?apiKey=${TWC_API_KEY}&startDate=${dateStr.replace(/-/g,'')}&endDate=${dateStr.replace(/-/g,'')}&units=m`;
  const r = await fetch(url);
  if(!r.ok) return null;
  const data = await r.json();
  let max = -999;
  for(const o of (data.observations||[])) if(o.temp!=null&&o.temp>max) max=o.temp;
  return max===-999?null:max;
}

async function main(){
  // 目标日期：过去30天中已结算的
  const targetDates = [];
  for(let i=30; i>=2; i--){
    targetDates.push(new Date(Date.now() - i*86400000).toISOString().slice(0,10));
  }
  
  console.log(`回测 ${targetDates[0]} ~ ${targetDates[targetDates.length-1]} (${targetDates.length}天)`);
  
  // 加载已有实测数据
  let hist90d = {};
  try{ hist90d = JSON.parse(await readFile('data/hist_90d_maxtemps.json','utf8')); }catch{}
  
  const allErrors = {};
  
  for(const city of CITIES){
    process.stdout.write(`\n${city.name}: `);
    const errors1d = []; // 提前1天预报误差
    const errors2d = []; // 提前2天预报误差
    
    for(const targetDate of targetDates){
      // 实测值
      let actual = hist90d[city.name]?.[targetDate];
      if(actual == null){
        actual = await getActualMax(city.twcLat, city.twcLon, targetDate);
        await new Promise(r=>setTimeout(r,50));
      }
      if(actual == null) continue;
      
      // Open-Meteo: 提前1天的预报（forecast_date = targetDate-1）
      const d1 = new Date(new Date(targetDate+'T00:00:00Z').getTime() - 86400000).toISOString().slice(0,10);
      const d2 = new Date(new Date(targetDate+'T00:00:00Z').getTime() - 2*86400000).toISOString().slice(0,10);
      
      // Open-Meteo historical forecast: 在d1那天发出的、对targetDate的预报
      const om1 = curlJSON(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&start_date=${targetDate}&end_date=${targetDate}&daily=temperature_2m_max&timezone=auto&forecast_days=1&past_days=0&start_hour=0&end_hour=23`);
      // 用更简单的方式：拉d1那天的10天预报，找targetDate
      const omFull1 = curlJSON(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&start_date=${d1}&end_date=${targetDate}&daily=temperature_2m_max&timezone=auto`);
      const omFull2 = curlJSON(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${city.lat}&longitude=${city.lon}&start_date=${d2}&end_date=${targetDate}&daily=temperature_2m_max&timezone=auto`);
      
      let fc1 = null, fc2 = null;
      if(omFull1?.daily?.time && omFull1?.daily?.temperature_2m_max){
        const idx = omFull1.daily.time.indexOf(targetDate);
        if(idx >= 0) fc1 = Math.round(omFull1.daily.temperature_2m_max[idx]);
      }
      if(omFull2?.daily?.time && omFull2?.daily?.temperature_2m_max){
        const idx = omFull2.daily.time.indexOf(targetDate);
        if(idx >= 0) fc2 = Math.round(omFull2.daily.temperature_2m_max[idx]);
      }
      
      if(fc1 != null) errors1d.push({date: targetDate, forecast: fc1, actual, err: fc1 - actual});
      if(fc2 != null) errors2d.push({date: targetDate, forecast: fc2, actual, err: fc2 - actual});
      
      process.stdout.write('.');
    }
    
    const bias1 = errors1d.length ? errors1d.reduce((a,b)=>a+b.err,0)/errors1d.length : 0;
    const mae1 = errors1d.length ? errors1d.map(e=>Math.abs(e.err)).reduce((a,b)=>a+b,0)/errors1d.length : 0;
    const std1 = errors1d.length ? Math.sqrt(errors1d.reduce((a,b)=>a+(b.err-bias1)**2,0)/errors1d.length) : 0;
    
    const bias2 = errors2d.length ? errors2d.reduce((a,b)=>a+b.err,0)/errors2d.length : 0;
    const mae2 = errors2d.length ? errors2d.map(e=>Math.abs(e.err)).reduce((a,b)=>a+b,0)/errors2d.length : 0;
    const std2 = errors2d.length ? Math.sqrt(errors2d.reduce((a,b)=>a+(b.err-bias2)**2,0)/errors2d.length) : 0;
    
    allErrors[city.name] = {
      n1d: errors1d.length, bias1d: Math.round(bias1*10)/10, mae1d: Math.round(mae1*10)/10, std1d: Math.round(std1*10)/10,
      n2d: errors2d.length, bias2d: Math.round(bias2*10)/10, mae2d: Math.round(mae2*10)/10, std2d: Math.round(std2*10)/10,
      errors1d, errors2d,
    };
    
    console.log(` n=${errors1d.length}`);
    console.log(`  提前1天: bias=${bias1.toFixed(1)} MAE=${mae1.toFixed(1)} σ=${std1.toFixed(1)}`);
    console.log(`  提前2天: bias=${bias2.toFixed(1)} MAE=${mae2.toFixed(1)} σ=${std2.toFixed(1)}`);
  }
  
  // 保存结果
  const summary = {};
  for(const [city, data] of Object.entries(allErrors)){
    summary[city] = {
      n1d: data.n1d, bias1d: data.bias1d, mae1d: data.mae1d, sigma1d: data.std1d,
      n2d: data.n2d, bias2d: data.bias2d, mae2d: data.mae2d, sigma2d: data.std2d,
    };
  }
  await writeFile('data/forecast_error_30d.json', JSON.stringify(summary, null, 2));
  
  console.log('\n=== 汇总：预报误差σ（用于替换脚本sigma）===');
  console.log('城市 | 提前1天σ | 提前2天σ | 建议sigma_d1 | 建议sigma_d2');
  for(const [city, s] of Object.entries(summary)){
    console.log(`${city.padEnd(12)} | ${String(s.sigma1d).padEnd(8)} | ${String(s.sigma2d).padEnd(8)} | ${s.sigma1d} | ${s.sigma2d}`);
  }
}
main().catch(e=>console.error(e));
