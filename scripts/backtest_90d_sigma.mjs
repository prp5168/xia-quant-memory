import { writeFile } from 'node:fs/promises';

const TWC_API_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';

async function getHistMaxSingleDay(lat, lon, dateStr){
  const url = `https://api.weather.com/v1/geocode/${lat}/${lon}/observations/historical.json?apiKey=${TWC_API_KEY}&startDate=${dateStr.replace(/-/g,'')}&endDate=${dateStr.replace(/-/g,'')}&units=m`;
  const r = await fetch(url);
  if(!r.ok) return null;
  const data = await r.json();
  let max = -999;
  for(const o of (data.observations||[])) if(o.temp!=null&&o.temp>max) max=o.temp;
  return max===-999?null:max;
}

const CITIES = [
  {name:'Shanghai', lat:'31.15', lon:'121.803'},
  {name:'Seoul', lat:'37.469', lon:'126.451'},
  {name:'NYC', lat:'40.641', lon:'-73.778'},
  {name:'London', lat:'51.470', lon:'-0.454'},
  {name:'Chicago', lat:'41.974', lon:'-87.907'},
  {name:'Dallas', lat:'32.899', lon:'-97.040'},
  {name:'Miami', lat:'25.795', lon:'-80.287'},
  {name:'Toronto', lat:'43.677', lon:'-79.624'},
  {name:'Paris', lat:'49.009', lon:'2.547'},
  {name:'Warsaw', lat:'52.166', lon:'20.967'},
  {name:'Madrid', lat:'40.472', lon:'-3.561'},
  {name:'Wellington', lat:'-41.327', lon:'174.805'},
  {name:'Lucknow', lat:'26.761', lon:'80.889'},
];

async function main(){
  // 过去90天
  const days = [];
  for(let i=90; i>=1; i--){
    const d = new Date(Date.now() - i*86400000);
    days.push(d.toISOString().slice(0,10));
  }
  
  console.log('拉取 ' + days[0] + ' 到 ' + days[days.length-1] + ' (' + days.length + '天) ...');
  
  const allData = {};
  for(const city of CITIES){
    process.stdout.write(city.name + '... ');
    allData[city.name] = {};
    for(const d of days){
      const max = await getHistMaxSingleDay(city.lat, city.lon, d);
      allData[city.name][d] = max;
      await new Promise(r=>setTimeout(r,50));
    }
    const temps = Object.values(allData[city.name]).filter(v=>v!=null);
    console.log(temps.length + ' days OK');
  }
  
  // 保存原始数据
  await writeFile('data/hist_90d_maxtemps.json', JSON.stringify(allData, null, 2));
  
  console.log('\n=== 90天统计 ===\n');
  
  const results = {};
  for(const city of CITIES){
    const sorted = Object.entries(allData[city.name])
      .filter(([,v])=>v!=null)
      .sort((a,b)=>a[0].localeCompare(b[0]));
    const temps = sorted.map(([,v])=>v);
    
    // 日间变化（相邻天差值）
    const diffs = [];
    for(let i=1;i<sorted.length;i++){
      diffs.push(sorted[i][1] - sorted[i-1][1]);
    }
    
    const mean = temps.reduce((a,b)=>a+b,0)/temps.length;
    const std = Math.sqrt(temps.reduce((a,b)=>a+(b-mean)**2,0)/temps.length);
    const diffMean = diffs.reduce((a,b)=>a+b,0)/diffs.length;
    const diffStd = Math.sqrt(diffs.reduce((a,b)=>a+(b-diffMean)**2,0)/diffs.length);
    
    // 最近30天 vs 全90天
    const recent30 = sorted.slice(-30);
    const r30temps = recent30.map(([,v])=>v);
    const r30mean = r30temps.reduce((a,b)=>a+b,0)/r30temps.length;
    const r30diffs = [];
    for(let i=1;i<recent30.length;i++) r30diffs.push(recent30[i][1]-recent30[i-1][1]);
    const r30diffStd = r30diffs.length ? Math.sqrt(r30diffs.reduce((a,b)=>a+(b-r30diffs.reduce((x,y)=>x+y,0)/r30diffs.length)**2,0)/r30diffs.length) : 0;
    
    results[city.name] = {
      n: temps.length,
      mean90d: Math.round(mean*10)/10,
      std90d: Math.round(std*10)/10,
      diffStd90d: Math.round(diffStd*10)/10,
      mean30d: Math.round(r30mean*10)/10,
      diffStd30d: Math.round(r30diffStd*10)/10,
      min: Math.min(...temps),
      max: Math.max(...temps),
    };
    
    console.log(`${city.name}: n=${temps.length} | 90d均值=${mean.toFixed(1)} 波动std=${std.toFixed(1)} 日间变化std=${diffStd.toFixed(1)} | 30d均值=${r30mean.toFixed(1)} 日间std=${r30diffStd.toFixed(1)} | range=${Math.min(...temps)}~${Math.max(...temps)}`);
  }
  
  await writeFile('data/city_sigma_90d.json', JSON.stringify(results, null, 2));
  console.log('\n数据已保存到 data/hist_90d_maxtemps.json 和 data/city_sigma_90d.json');
}
main().catch(e=>console.error(e));
