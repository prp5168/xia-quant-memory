// Simulated Portfolio Scanner
// - Reads portfolio.json
// - Scans markets for buy/sell/stop-loss signals
// - Executes simulated trades
// - Writes back to portfolio.json
// - Outputs actions for Telegram notification

import { readFile, writeFile } from 'node:fs/promises';

const TWC_API_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';
const PORTFOLIO_PATH = 'data/portfolio.json';

// MODE: "full" (today+tomorrow+day-after) or "today-only" (only today's markets, for intraday intensive scan)
// Hard rule: NEVER open new positions on today's contracts in any mode
// today-only mode: ONLY check existing positions for stop-loss/take-profit, NO new buys
// full mode: check existing positions + scan only tomorrow/day-after for NEW buys
// Rationale: we earn from "uncertainty premium decay" — buy a day early, sell as odds converge
const SCAN_MODE = process.env.SCAN_MODE || 'full';

function getLocalHour(utcOffset) {
  const now = new Date();
  return (now.getUTCHours() + utcOffset + 24) % 24;
}

function getLocalDateStr(utcOffset) {
  const now = new Date();
  const local = new Date(now.getTime() + utcOffset * 3600000);
  return local.toISOString().slice(0, 10);
}

function isInPeakHours(station) {
  const localHour = getLocalHour(station.utcOffset);
  return localHour >= station.peakStartLocal && localHour < station.peakEndLocal;
}

function getScanDaysForStation(station) {
  if (SCAN_MODE === 'full') return 3;
  // today-only: only scan if this city is currently in its peak hours
  if (isInPeakHours(station)) return 1;
  return 0; // skip this city entirely if outside peak hours
}

function getLocalDayDiff(targetDateStr, station){
  const todayStr = getLocalDateStr(station.utcOffset);
  const a = new Date(todayStr + 'T00:00:00Z');
  const b = new Date(targetDateStr + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

function getSigmaForDate(targetDateStr, station, baseSigma){
  const dayDiff = getLocalDayDiff(targetDateStr, station);
  if(dayDiff <= 0) return 0.8;  // 当天
  if(dayDiff === 1) return 1.0; // 明天
  return 1.5;                   // 后天及更远
}

const STATIONS = [
  { name: 'Shanghai', icao: 'ZSPD', geocode: '31.15,121.803', metarId: 'ZSPD', tz: 'Asia/Shanghai', utcOffset: 8, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'shanghai-daily-weather' },
  { name: 'Dallas', icao: 'KDFW', geocode: '32.899,-97.040', metarId: 'KDFW', tz: 'America/Chicago', utcOffset: -5, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'dallas-daily-weather' },
  { name: 'London', icao: 'EGLL', geocode: '51.470,-0.454', metarId: 'EGLL', tz: 'Europe/London', utcOffset: 0, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'london-daily-weather' },
  { name: 'Seoul', icao: 'RKSI', geocode: '37.469,126.451', metarId: 'RKSI', tz: 'Asia/Seoul', utcOffset: 9, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'seoul-daily-weather' },
  { name: 'Wellington', icao: 'NZWN', geocode: '-41.327,174.805', metarId: 'NZWN', tz: 'Pacific/Auckland', utcOffset: 13, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'wellington-daily-weather' },
  { name: 'Milan', icao: 'LIMC', geocode: '45.630,8.723', metarId: 'LIMC', tz: 'Europe/Rome', utcOffset: 1, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'milan-daily-weather' },
  { name: 'Tel Aviv', icao: 'LLBG', geocode: '32.011,34.886', metarId: 'LLBG', tz: 'Asia/Jerusalem', utcOffset: 2, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'tel-aviv-daily-weather' },
  { name: 'Hong Kong', icao: 'VHHH', geocode: '22.308,113.918', metarId: 'VHHH', tz: 'Asia/Hong_Kong', utcOffset: 8, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'hong-kong-daily-weather' },
  { name: 'Chicago', icao: 'KORD', geocode: '41.974,-87.907', metarId: 'KORD', tz: 'America/Chicago', utcOffset: -5, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'chicago-daily-weather' },
  { name: 'NYC', icao: 'KJFK', geocode: '40.641,-73.778', metarId: 'KJFK', tz: 'America/New_York', utcOffset: -4, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'nyc-daily-weather' },
  { name: 'Lucknow', icao: 'VILK', geocode: '26.761,80.889', metarId: 'VILK', tz: 'Asia/Kolkata', utcOffset: 5.5, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'lucknow-daily-weather' },
  { name: 'Paris', icao: 'LFPG', geocode: '49.009,2.547', metarId: 'LFPG', tz: 'Europe/Paris', utcOffset: 1, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'paris-daily-weather' },
  { name: 'Miami', icao: 'KMIA', geocode: '25.795,-80.287', metarId: 'KMIA', tz: 'America/New_York', utcOffset: -4, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'miami-daily-weather' },
  { name: 'Toronto', icao: 'CYYZ', geocode: '43.677,-79.624', metarId: 'CYYZ', tz: 'America/Toronto', utcOffset: -4, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'toronto-daily-weather' },
  { name: 'Seattle', icao: 'KSEA', geocode: '47.450,-122.309', metarId: 'KSEA', tz: 'America/Los_Angeles', utcOffset: -7, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'seattle-daily-weather' },
  { name: 'Warsaw', icao: 'EPWA', geocode: '52.166,20.967', metarId: 'EPWA', tz: 'Europe/Warsaw', utcOffset: 1, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'warsaw-daily-weather' },
  { name: 'Madrid', icao: 'LEMD', geocode: '40.472,-3.561', metarId: 'LEMD', tz: 'Europe/Madrid', utcOffset: 1, peakStartLocal: 6, peakEndLocal: 14, seriesSlug: 'madrid-daily-weather' },
];

// ─── Math ──────────────────────────────────────────────────
function normCdf(x){const s=x<0?-1:1;x=Math.abs(x)/Math.SQRT2;const t=1/(1+0.3275911*x);const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429;return 0.5*(1+s*(1-((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x)));}
function pBin(mu,sig,k){return Math.max(0,normCdf((k+0.5-mu)/sig)-normCdf((k-0.5-mu)/sig));}
function buildDist(mu,sigma){const p={};let t=0;for(let k=Math.floor(mu-5);k<=Math.ceil(mu+5);k++){const v=pBin(mu,sigma,k);if(v>0.001){p[k]=v;t+=v;}}for(const k of Object.keys(p))p[k]/=t;return p;}

// ─── API helpers ───────────────────────────────────────────
async function fetchJSON(url){const r=await fetch(url,{headers:{'User-Agent':'openclaw-weather-arb/0.1'}});if(!r.ok)throw new Error(`${r.status} ${url.slice(0,80)}`);return r.json();}

async function getTWCForecast(geocode){
  return fetchJSON(`https://api.weather.com/v3/wx/forecast/daily/10day?apiKey=${TWC_API_KEY}&geocode=${encodeURIComponent(geocode)}&units=m&language=en-US&format=json`);
}
async function getTWCHourly(geocode){
  return fetchJSON(`https://api.weather.com/v3/wx/forecast/hourly/15day?apiKey=${TWC_API_KEY}&geocode=${encodeURIComponent(geocode)}&units=m&language=en-US&format=json`);
}
async function getMETAR(icao){
  return fetchJSON(`https://aviationweather.gov/api/data/metar?ids=${icao}&hours=6&format=json`);
}
async function getPMEvent(slug){
  const arr=await fetchJSON(`https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}`);
  return arr[0]||null;
}
async function getBook(tokenId){
  return fetchJSON(`https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`);
}

function parseBook(book){
  const bids=(book?.bids||[]).map(x=>({p:Number(x.price),s:Number(x.size)})).filter(x=>Number.isFinite(x.p)&&x.p>0).sort((a,b)=>b.p-a.p);
  const asks=(book?.asks||[]).map(x=>({p:Number(x.price),s:Number(x.size)})).filter(x=>Number.isFinite(x.p)&&x.p>0).sort((a,b)=>a.p-b.p);
  const bestBid=bids[0]?.p??null;
  const bestAsk=asks[0]?.p??null;
  const mid=(bestBid!=null&&bestAsk!=null)?(bestBid+bestAsk)/2:null;
  const spread=(bestBid!=null&&bestAsk!=null)?bestAsk-bestBid:null;

  // Simulate eating the book: given a USD budget, walk levels and return fills
  // side='ask' → buying YES (eat asks); side='bid' → selling YES / buying NO (eat bids)
  function simulateFill(side, budgetUsd){
    const levels=side==='ask'?asks:bids;
    if(!levels.length) return{filled:false,shares:0,cost:0,avgPrice:null,fills:[],worstPrice:null};
    let remaining=budgetUsd;
    let totalShares=0;
    let totalCost=0;
    const fills=[];
    let worst=null;
    for(const lv of levels){
      if(remaining<=0) break;
      const maxSharesAtLevel=lv.s;
      const costPerShare=lv.p;
      const affordShares=Math.floor(remaining/costPerShare);
      const takeShares=Math.min(affordShares, maxSharesAtLevel);
      if(takeShares<=0) break;
      const takeCost=takeShares*costPerShare;
      totalShares+=takeShares;
      totalCost+=takeCost;
      remaining-=takeCost;
      worst=lv.p;
      fills.push({price:lv.p, shares:takeShares, cost:Math.round(takeCost*100)/100});
    }
    return{
      filled:totalShares>0,
      shares:totalShares,
      cost:Math.round(totalCost*100)/100,
      avgPrice:totalShares>0?Math.round(totalCost/totalShares*10000)/10000:null,
      worstPrice:worst,
      fills,
      remainingBudget:Math.round(remaining*100)/100,
    };
  }

  function capWithin(side,pct){
    const arr2=side==='ask'?asks:bids;
    if(!arr2.length)return{shares:0,usd:0};
    const ref=arr2[0].p;
    const lim=side==='ask'?ref*(1+pct):ref*(1-pct);
    let sh=0,usd=0;
    for(const x of arr2){
      if(side==='ask'&&x.p>lim)break;
      if(side==='bid'&&x.p<lim)break;
      sh+=x.s;usd+=x.s*x.p;
    }
    return{shares:Math.round(sh),usd:Math.round(usd)};
  }
  return{bestBid,bestAsk,mid,spread,bids,asks,simulateFill,askCap5:capWithin('ask',0.05),bidCap5:capWithin('bid',0.05),askCap10:capWithin('ask',0.10),bidCap10:capWithin('bid',0.10)};
}

function dateSlug(dateStr,city){
  const d=new Date(dateStr+'T00:00:00Z');
  const months=['january','february','march','april','may','june','july','august','september','october','november','december'];
  return`highest-temperature-in-${city.toLowerCase()}-on-${months[d.getUTCMonth()]}-${d.getUTCDate()}-${d.getUTCFullYear()}`;
}

async function getTopStationsByEventVolume(targetDate, heldStationNames = new Set(), topN = 10){
  const ranked = [];
  for(const st of STATIONS){
    try{
      const event = await getPMEvent(dateSlug(targetDate, st.name));
      if(event?.markets?.length){
        ranked.push({ station: st, volume: Number(event.volume || event.volume24hr || 0), event });
      }
    }catch{}
  }
  ranked.sort((a,b)=>b.volume-a.volume);
  const chosen = ranked.slice(0, topN).map(x=>x.station);
  for(const name of heldStationNames){
    const st = STATIONS.find(s=>s.name===name);
    if(st && !chosen.some(x=>x.name===st.name)) chosen.push(st);
  }
  return chosen;
}

function getCityExposure(pf, city){
  return pf.positions.filter(p=>p.station===city).reduce((s,p)=>s+(Number(p.cost)||0),0);
}

function isExactTempTitle(title=''){
  const t=title.toLowerCase();
  return /\d+/.test(t) && !t.includes('or higher') && !t.includes('or below');
}

async function estimateLiquidationValue(pos){
  try{
    const mkt=await fetchJSON(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(pos.slug)}`);
    const m=mkt[0];
    if(!m) return pos.cost;
    const tokenIds=JSON.parse(m.clobTokenIds||'[]');
    if(pos.dir==='BUY_YES'){
      const bk=await getBook(tokenIds[0]);
      const ba=parseBook(bk);
      const px=ba.bestBid ?? ba.mid ?? 0;
      return Math.round(pos.shares * px * 100)/100;
    }
    const bkNo=await getBook(tokenIds[1]);
    const baNo=parseBook(bkNo);
    const px=baNo.bestBid ?? baNo.mid ?? 0;
    return Math.round(pos.shares * px * 100)/100;
  }catch{
    return Math.round((Number(pos.cost)||0)*100)/100;
  }
}

function getCorrectedClosedTradePnl(trade){
  const oldPnl = Number(trade.pnl || 0);
  if(trade.dir !== 'BUY_NO') return Math.round(oldPnl * 100) / 100;
  const entryYes = Number(trade.entryPrice || 0);
  const exitYes = Number(trade.exitPrice || 0);
  const cost = Number(trade.cost || 0);
  if(!(entryYes >= 0 && entryYes < 1) || !(exitYes >= 0 && exitYes <= 1) || cost < 0) return Math.round(oldPnl * 100) / 100;
  const noEntry = 1 - entryYes;
  const noExit = 1 - exitYes;
  if(noEntry <= 0) return Math.round(oldPnl * 100) / 100;
  const correctedShares = cost / noEntry;
  const correctedExitVal = correctedShares * noExit;
  return Math.round((correctedExitVal - cost) * 100) / 100;
}

function getCorrectedSummaryAccounting(pf){
  const correctedClosedPnl = pf.closedTrades.reduce((sum, t) => sum + getCorrectedClosedTradePnl(t), 0);
  const openCost = pf.positions.reduce((sum, p) => sum + Number(p.cost || 0), 0);
  const correctedCash = pf.initialCapital + correctedClosedPnl - openCost;
  return {
    correctedClosedPnl: Math.round(correctedClosedPnl * 100) / 100,
    correctedCash: Math.round(correctedCash * 100) / 100,
  };
}

// ─── Main ──────────────────────────────────────────────────
async function main(){
  const now=new Date();
  const pf=JSON.parse(await readFile(PORTFOLIO_PATH,'utf8'));
  const rules=pf.rules;
  const actions=[]; // will be output as notifications

  // Initialize stoppedToday tracker (resets daily)
  if(!pf.stoppedToday) pf.stoppedToday = {};
  const todayStr = now.toISOString().slice(0,10);
  // Clean old entries (only keep today's)
  for(const key of Object.keys(pf.stoppedToday)){
    if(!key.startsWith(todayStr)) delete pf.stoppedToday[key];
  }

  actions.push(`🎲 模拟盘扫描 | ${now.toISOString()} | 资金$${pf.cash.toFixed(2)}/${pf.initialCapital} | 模式:${SCAN_MODE}`);
  if(pf.positions.length) actions.push(`📦 持仓${pf.positions.length}个`);

  // ─── Phase 1: Check existing positions for SELL/STOP-LOSS ───
  const prevForecastCache={};

  for(let pi=pf.positions.length-1;pi>=0;pi--){
    const pos=pf.positions[pi];
    // Get current market price
    let currentYesP=null, currentNoP=null, book=null, bookNo=null, ba={}, baNo={};
    try{
      const mkt=await fetchJSON(`https://gamma-api.polymarket.com/markets?slug=${encodeURIComponent(pos.slug)}`);
      const m=mkt[0];
      if(m){
        const px=JSON.parse(m.outcomePrices||'[]');
        currentYesP=Number(px[0]||0);
        currentNoP=Number(px[1]|| (1-currentYesP) || 0);
        if(m.closed){
          // Market closed/resolved
          const resolved=currentYesP>0.95?1:(currentYesP<0.05?0:currentYesP);
          const pnl=pos.dir==='BUY_YES'?(resolved-pos.entryPrice)*pos.shares:(pos.entryPrice-resolved)*pos.shares;
          // Actually for NO: pnl = shares * ((1-resolved) - (1-entryPrice)) if bought No
          // Simplified: 
          let exitVal;
          if(pos.dir==='BUY_YES') exitVal=resolved*pos.shares;
          else exitVal=((1-resolved))*pos.shares;
          const cost=pos.cost;
          const realPnl=exitVal-cost;
          pf.cash+=exitVal;
          pf.totalPnl+=realPnl;
          pf.closedTrades.push({...pos, exitPrice:resolved, exitTime:now.toISOString(), pnl:Math.round(realPnl*100)/100, reason:'resolved'});
          pf.positions.splice(pi,1);
          actions.push(`🏁 结算: ${pos.station} ${pos.tempLabel} ${pos.dir} | 成本$${cost.toFixed(2)} 回收$${exitVal.toFixed(2)} PnL=$${realPnl.toFixed(2)}`);
          continue;
        }
        const tokenIds=JSON.parse(m.clobTokenIds||'[]');
        try{book=await getBook(tokenIds[0]);ba=parseBook(book);}catch{}
        try{if(tokenIds[1]){bookNo=await getBook(tokenIds[1]);baNo=parseBook(bookNo);}}catch{}
      }
    }catch{}

    if(currentYesP==null) continue;

    // Get current model probability
    const st=STATIONS.find(s=>s.name===pos.station);
    if(!st) continue;

    let modelP=null;
    try{
      const daily=await getTWCForecast(st.geocode);
      const hourly=await getTWCHourly(st.geocode);
      const dates=daily.validTimeLocal.map(d=>d.slice(0,10));
      const idx=dates.indexOf(pos.date);
      if(idx>=0){
        const fMax=daily.calendarDayTemperatureMax[idx];
        const hTemps=[];
        for(let h=0;h<(hourly.validTimeLocal||[]).length;h++){
          if(hourly.validTimeLocal[h]?.startsWith(pos.date)) hTemps.push(hourly.temperature[h]);
        }
        const hMax=hTemps.length?Math.max(...hTemps):fMax;
        let mu=fMax*0.7+hMax*0.3;
        const dp=daily.daypart?.[0]||{};
        const dpi=idx*2;
        if((dp.qpf?.[dpi]||0)>5&&(dp.cloudCover?.[dpi]||0)>80) mu-=0.3;
        if((dp.windSpeed?.[dpi]||0)>30) mu-=0.2;
        if((dp.relativeHumidity?.[dpi]||0)<40&&(dp.cloudCover?.[dpi]||0)<30) mu+=0.3;
        const sigma = getSigmaForDate(pos.date, st, rules.sigma);
        const dist=buildDist(mu,sigma);
        modelP=dist[pos.k]||0;

        // Check for forecast shift (stop-loss trigger)
        const forecastShift=Math.abs(fMax-(pos.forecastMaxAtEntry||fMax));
        if(forecastShift>=2){
          // STOP LOSS: forecast shifted by >=2C — MUST use market order (eat whatever is on book)
          const slBook = pos.dir==='BUY_YES' ? ba : baNo;
          const slSide = 'bid';
          const slBudget = pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP||0.01) : (baNo.bestBid||currentNoP||0.01));
          const slFill = slBook.simulateFill ? slBook.simulateFill(slSide, slBudget) : null;
          
          let exitVal, exitPrice;
          if(slFill && slFill.filled){
            const exitShares = Math.min(slFill.shares, pos.shares);
            exitPrice = slFill.avgPrice;
            if(pos.dir==='BUY_YES') exitVal = exitShares * exitPrice;
            else exitVal = exitShares * exitPrice;
          } else {
            // No liquidity at all — worst case assume 0 recovery
            exitPrice = 0;
            exitVal = 0;
          }
          const realPnl=exitVal-pos.cost;
          pf.cash+=exitVal;
          pf.totalPnl+=realPnl;
          pf.closedTrades.push({...pos, exitPrice, exitTime:now.toISOString(), pnl:Math.round(realPnl*100)/100, reason:`stop_loss_forecast_shift_${forecastShift}C`, orderType:'市价(强制)'});
          pf.stoppedToday[`${todayStr}:${pos.slug}`] = now.toISOString();
          pf.positions.splice(pi,1);
          actions.push(`🚨 止损(市价): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 预报偏移${forecastShift}°C | 成交@${(exitPrice*100).toFixed(1)}% | 成本$${pos.cost.toFixed(2)} 回收$${exitVal.toFixed(2)} PnL=$${realPnl.toFixed(2)}`);
          continue;
        }

        // ─── 硬止损 B: 盘口极端化 (BUY_NO but Yes>90%, or BUY_YES but Yes<10%) ───
        const extremeStop = (pos.dir==='BUY_NO' && currentYesP > 0.90) || (pos.dir==='BUY_YES' && currentYesP < 0.10);
        if(extremeStop){
          const slBook2 = pos.dir==='BUY_YES' ? ba : baNo;
          const slSide2 = 'bid';
          const slBudget2 = pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP||0.01) : (baNo.bestBid||currentNoP||0.01));
          const slFill2 = slBook2.simulateFill ? slBook2.simulateFill(slSide2, slBudget2) : null;
          let exitVal2, exitPrice2;
          if(slFill2 && slFill2.filled){
            exitPrice2 = slFill2.avgPrice;
            const exitShares2 = Math.min(slFill2.shares, pos.shares);
            if(pos.dir==='BUY_YES') exitVal2 = exitShares2 * exitPrice2;
            else exitVal2 = exitShares2 * (1 - exitPrice2);
          } else { exitPrice2=pos.dir==='BUY_YES'?0:1; exitVal2=0; }
          const realPnl2=exitVal2-pos.cost;
          pf.cash+=exitVal2;
          pf.totalPnl+=realPnl2;
          pf.closedTrades.push({...pos, exitPrice:exitPrice2, exitTime:now.toISOString(), pnl:Math.round(realPnl2*100)/100, reason:`stop_loss_extreme_price_yes${Math.round(currentYesP*100)}pct`, orderType:'市价(强制)'});
          pf.stoppedToday[`${todayStr}:${pos.slug}`] = now.toISOString();
          pf.positions.splice(pi,1);
          actions.push(`🚨 止损(盘口极端): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | Yes已到${(currentYesP*100).toFixed(1)}% | 成本$${pos.cost.toFixed(2)} 回收$${exitVal2.toFixed(2)} PnL=$${realPnl2.toFixed(2)}`);
          continue;
        }

        // ─── 硬止损 C: METAR实测已达到对赌阈值 ───
        try{
          const metarArr = await getMETAR(st.metarId);
          const todayMetars = metarArr.filter(m => m.reportTime?.startsWith(pos.date));
          const metarTemps = todayMetars.map(m => m.temp).filter(Number.isFinite);
          if(metarTemps.length > 0){
            const metarMax = Math.max(...metarTemps);
            // BUY_NO on k°C: if METAR already hit k, we're wrong
            // BUY_YES on k°C: if METAR already exceeded k (max > k), then k won't be the final max (maybe higher)
            const metarContradict = (pos.dir==='BUY_NO' && metarMax === pos.k) || (pos.dir==='BUY_YES' && metarMax > pos.k + 1);
            if(metarContradict){
              const slBook3 = pos.dir==='BUY_YES' ? ba : baNo;
              const slSide3 = 'bid';
              const slBudget3 = pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP||0.01) : (baNo.bestBid||currentNoP||0.01));
              const slFill3 = slBook3.simulateFill ? slBook3.simulateFill(slSide3, slBudget3) : null;
              let exitVal3, exitPrice3;
              if(slFill3 && slFill3.filled){
                exitPrice3 = slFill3.avgPrice;
                const exitShares3 = Math.min(slFill3.shares, pos.shares);
                if(pos.dir==='BUY_YES') exitVal3 = exitShares3 * exitPrice3;
                else exitVal3 = exitShares3 * (1 - exitPrice3);
              } else { exitPrice3=0; exitVal3=0; }
              const realPnl3=exitVal3-pos.cost;
              pf.cash+=exitVal3;
              pf.totalPnl+=realPnl3;
              pf.closedTrades.push({...pos, exitPrice:exitPrice3, exitTime:now.toISOString(), pnl:Math.round(realPnl3*100)/100, reason:`stop_loss_metar_confirmed_${metarMax}C`, orderType:'市价(强制)'});
              pf.stoppedToday[`${todayStr}:${pos.slug}`] = now.toISOString();
              pf.positions.splice(pi,1);
              actions.push(`🚨 止损(METAR确认): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | METAR已测到${metarMax}°C | 成本$${pos.cost.toFixed(2)} 回收$${exitVal3.toFixed(2)} PnL=$${realPnl3.toFixed(2)}`);
              continue;
            }
          }
        }catch{}

        // ─── 硬止损 A: 浮亏超过50% ───
        {
          let currentVal;
          if(pos.dir==='BUY_YES') currentVal = pos.shares * currentYesP;
          else currentVal = pos.shares * (1 - currentYesP);
          const drawdown = (pos.cost - currentVal) / pos.cost;
          if(drawdown >= 0.5){
            const slBook4 = pos.dir==='BUY_YES' ? ba : baNo;
            const slSide4 = 'bid';
            const slBudget4 = pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP||0.01) : (baNo.bestBid||currentNoP||0.01));
            const slFill4 = slBook4.simulateFill ? slBook4.simulateFill(slSide4, slBudget4) : null;
            let exitVal4, exitPrice4;
            if(slFill4 && slFill4.filled){
              exitPrice4 = slFill4.avgPrice;
              const exitShares4 = Math.min(slFill4.shares, pos.shares);
              if(pos.dir==='BUY_YES') exitVal4 = exitShares4 * exitPrice4;
              else exitVal4 = exitShares4 * (1 - exitPrice4);
            } else { exitPrice4=0; exitVal4=0; }
            const realPnl4=exitVal4-pos.cost;
            pf.cash+=exitVal4;
            pf.totalPnl+=realPnl4;
            pf.closedTrades.push({...pos, exitPrice:exitPrice4, exitTime:now.toISOString(), pnl:Math.round(realPnl4*100)/100, reason:`stop_loss_drawdown_${Math.round(drawdown*100)}pct`, orderType:'市价(强制)'});
            pf.stoppedToday[`${todayStr}:${pos.slug}`] = now.toISOString();
            pf.positions.splice(pi,1);
            actions.push(`🚨 止损(浮亏${Math.round(drawdown*100)}%): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 成本$${pos.cost.toFixed(2)} 现值$${currentVal.toFixed(2)} 回收$${exitVal4.toFixed(2)} PnL=$${realPnl4.toFixed(2)}`);
            continue;
          }
        }
      }
    }catch{}

    if(modelP==null) continue;

    // Check sell condition
    const currentEdge = pos.dir==='BUY_YES' ? (modelP - currentYesP) : ((1 - modelP) - currentNoP);

    // ─── 第二轮优化: 模型翻转止损（模型已明显站到对面） ───
    if(currentEdge < -0.10){
      const sellBook0 = pos.dir==='BUY_YES' ? ba : baNo;
      const sellSide0 = 'bid';
      const sellFill0 = sellBook0.simulateFill ? sellBook0.simulateFill(sellSide0, pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP) : (baNo.bestBid||currentNoP))) : null;
      let exitVal0, exitPrice0;
      if(sellFill0 && sellFill0.filled){
        const exitShares0 = Math.min(sellFill0.shares, pos.shares);
        exitPrice0 = sellFill0.avgPrice;
        if(pos.dir==='BUY_YES') exitVal0 = exitShares0 * exitPrice0;
        else exitVal0 = exitShares0 * (1 - exitPrice0);
      } else {
        exitPrice0 = ba.mid || currentYesP;
        if(pos.dir==='BUY_YES') exitVal0 = pos.shares * exitPrice0;
        else exitVal0 = pos.shares * (1 - exitPrice0);
      }
      const realPnl0 = exitVal0 - pos.cost;
      pf.cash += exitVal0;
      pf.totalPnl += realPnl0;
      pf.closedTrades.push({...pos, exitPrice:exitPrice0, exitTime:now.toISOString(), pnl:Math.round(realPnl0*100)/100, reason:`stop_loss_model_flip_${Math.round((-currentEdge)*100)}pct`});
      pf.positions.splice(pi,1);
      actions.push(`🚨 止损(模型翻转): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 当前edge=${(currentEdge*100).toFixed(1)}% | 成本$${pos.cost.toFixed(2)} 回收$${exitVal0.toFixed(2)} PnL=$${realPnl0.toFixed(2)}`);
      continue;
    }

    // ─── 优化: edge 连续两轮为负 或 单轮低于 -8% 时更快退出 ───
    if(currentEdge < 0){
      pos.negativeEdgeCount = (pos.negativeEdgeCount || 0) + 1;
    } else {
      pos.negativeEdgeCount = 0;
    }
    if(currentEdge < -0.08 || (pos.negativeEdgeCount || 0) >= 2){
      const sellSideN = pos.dir==='BUY_YES' ? 'bid' : 'ask';
      const sellFillN = ba.simulateFill ? ba.simulateFill(sellSideN, pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP) : (ba.bestAsk||currentYesP))) : null;
      let exitValN, exitPriceN;
      if(sellFillN && sellFillN.filled){
        const exitSharesN = Math.min(sellFillN.shares, pos.shares);
        exitPriceN = sellFillN.avgPrice;
        if(pos.dir==='BUY_YES') exitValN = exitSharesN * exitPriceN;
        else exitValN = exitSharesN * (1 - exitPriceN);
      } else {
        exitPriceN = ba.mid || currentYesP;
        if(pos.dir==='BUY_YES') exitValN = pos.shares * exitPriceN;
        else exitValN = pos.shares * (1 - exitPriceN);
      }
      const realPnlN = exitValN - pos.cost;
      pf.cash += exitValN;
      pf.totalPnl += realPnlN;
      pf.closedTrades.push({...pos, exitPrice:exitPriceN, exitTime:now.toISOString(), pnl:Math.round(realPnlN*100)/100, reason:`stop_loss_negative_edge_${Math.round((-currentEdge)*100)}pct_${pos.negativeEdgeCount||1}x`});
      pf.stoppedToday[`${todayStr}:${pos.slug}`] = now.toISOString();
      pf.positions.splice(pi,1);
      actions.push(`🚨 止损(edge转负): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 当前edge=${(currentEdge*100).toFixed(1)}% | 成本$${pos.cost.toFixed(2)} 回收$${exitValN.toFixed(2)} PnL=$${realPnlN.toFixed(2)}`);
      continue;
    }

    // ─── 鱼身v3: 结算日早晨分层止盈 ───
    // First trigger on settlement morning sells ~50%, then later rules can handle the rest
    if(pos.date === getLocalDateStr(st?.utcOffset||8)){
      const localH = getLocalHour(st?.utcOffset||8);
      if(localH >= 6 && localH <= 14 && !pos.partialTpDone){
        let currentVal;
        if(pos.dir==='BUY_YES') currentVal = pos.shares * currentYesP;
        else currentVal = pos.shares * (1 - currentYesP);
        const floatPnl = currentVal - pos.cost;
        if(floatPnl > 0){
          const targetShares = Math.max(1, pos.shares * 0.5);
          const tpBook2 = pos.dir==='BUY_YES' ? ba : baNo;
      const tpSide = 'bid';
          const tpBudget = targetShares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP) : (baNo.bestBid||currentNoP));
          const tpFill = tpBook2.simulateFill ? tpBook2.simulateFill(tpSide, tpBudget) : null;
          let exitVal, exitPrice, exitShares;
          if(tpFill && tpFill.filled){
            exitShares = Math.min(tpFill.shares, targetShares, pos.shares);
            exitPrice = tpFill.avgPrice;
            if(pos.dir==='BUY_YES') exitVal = exitShares * exitPrice;
            else exitVal = exitShares * exitPrice;
          } else {
            exitShares = Math.min(targetShares, pos.shares);
            exitPrice = ba.mid || currentYesP;
            if(pos.dir==='BUY_YES') exitVal = exitShares * exitPrice;
            else exitVal = exitShares * exitPrice;
          }
          const costPortion = pos.cost * (exitShares / pos.shares);
          const realPnl = exitVal - costPortion;
          if(realPnl > 0 && exitShares > 0){
            pf.cash += exitVal;
            pf.totalPnl += realPnl;
            pf.closedTrades.push({...pos, exitPrice, exitTime:now.toISOString(), shares:exitShares, cost:Math.round(costPortion*100)/100, pnl:Math.round(realPnl*100)/100, reason:`time_tp_partial_settlement_day_${localH}h`});
            pos.shares = Math.round((pos.shares - exitShares) * 10000) / 10000;
            pos.cost = Math.round((pos.cost - costPortion) * 100) / 100;
            pos.partialTpDone = true;
            actions.push(`⏰ 分层止盈(结算日): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 当地${localH}时先卖一半 | 成交${exitShares}股@${(exitPrice*100).toFixed(1)}% | PnL=$${realPnl.toFixed(2)}`);
            if(pos.shares <= 0.0001){
              pf.positions.splice(pi,1);
            }
            continue;
          }
        }
      }
    }

    // We bought because edge was positive. Now check if it reversed.
    // For BUY_YES: we want modelP > yesPrice. Sell if yesPrice > modelP by >=20%
    // For BUY_NO: we want modelP < yesPrice. Sell if modelP > yesPrice by >=20%  
    const reverseEdge = -currentEdge; // how much the edge has flipped against us
    
    if(reverseEdge >= rules.sellEdgeReverse){
      // SELL: edge reversed — simulate actual fill against book
      const sellBook = pos.dir==='BUY_YES' ? ba : baNo;
      const sellSide = 'bid'; // sell token into bids
      const sellFill = sellBook.simulateFill ? sellBook.simulateFill(sellSide, pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP) : (baNo.bestBid||currentNoP))) : null;
      
      let exitVal, exitPrice, orderType, exitShares;
      if(sellFill && sellFill.filled && sellFill.shares >= pos.shares * 0.5){
        // Can fill at market — use actual fill
        exitShares = Math.min(sellFill.shares, pos.shares);
        exitPrice = sellFill.avgPrice;
        if(pos.dir==='BUY_YES') exitVal = exitShares * exitPrice;
        else exitVal = exitShares * exitPrice;
        orderType = '市价';
      } else {
        // Thin book — use limit order at mid
        exitPrice = ba.mid || currentYesP;
        exitShares = pos.shares;
        if(pos.dir==='BUY_YES') exitVal = exitShares * exitPrice;
        else exitVal = exitShares * exitPrice;
        orderType = '限价(mid)';
      }
      const realPnl = exitVal - pos.cost;
      pf.cash += exitVal;
      pf.totalPnl += realPnl;
      pf.closedTrades.push({...pos, exitPrice, exitShares, exitTime:now.toISOString(), pnl:Math.round(realPnl*100)/100, reason:`sell_edge_reversed_${Math.round(reverseEdge*100)}pct`, orderType});
      pf.positions.splice(pi,1);
      actions.push(`💰 卖出(${orderType}): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 模型${(modelP*100).toFixed(1)}% vs 盘口${(currentYesP*100).toFixed(1)}% | 成交${exitShares}股@${(exitPrice*100).toFixed(1)}% | 成本$${pos.cost.toFixed(2)} 回收$${exitVal.toFixed(2)} PnL=$${realPnl.toFixed(2)}`);
      continue;
    }

    // Also check: if position is profitable and edge decayed significantly, take profit
    const initialEdge = Math.abs(pos.edgeAtEntry||0);
    const priceMove = pos.dir==='BUY_YES' ? (currentYesP - pos.entryPrice) : (pos.entryPrice - currentYesP);

    // ─── 第二轮优化: edge 衰减止盈（只剩入场edge的40%以下就兑现） ───
    let currentValForTp;
    if(pos.dir==='BUY_YES') currentValForTp = pos.shares * currentYesP;
    else currentValForTp = pos.shares * (1 - currentYesP);
    const floatingPnlForTp = currentValForTp - pos.cost;
    if(initialEdge > 0 && currentEdge > 0 && currentEdge <= initialEdge * 0.4 && floatingPnlForTp > 0){
      const tpBook0 = pos.dir==='BUY_YES' ? ba : baNo;
      const tpSide0 = 'bid';
      const tpBudget0 = pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP) : (baNo.bestBid||currentNoP));
      const tpFill0 = tpBook0.simulateFill ? tpBook0.simulateFill(tpSide0, tpBudget0) : null;
      let exitVal0, exitPrice0;
      if(tpFill0 && tpFill0.filled){
        const exitShares0 = Math.min(tpFill0.shares, pos.shares);
        exitPrice0 = tpFill0.avgPrice;
        if(pos.dir==='BUY_YES') exitVal0 = exitShares0 * exitPrice0;
        else exitVal0 = exitShares0 * (1 - exitPrice0);
      } else {
        exitPrice0 = ba.mid || currentYesP;
        if(pos.dir==='BUY_YES') exitVal0 = pos.shares * exitPrice0;
        else exitVal0 = pos.shares * (1 - exitPrice0);
      }
      const realPnl0 = exitVal0 - pos.cost;
      if(realPnl0 > 0){
        pf.cash += exitVal0;
        pf.totalPnl += realPnl0;
        pf.closedTrades.push({...pos, exitPrice:exitPrice0, exitTime:now.toISOString(), pnl:Math.round(realPnl0*100)/100, reason:'take_profit_edge_decay_40pct'});
        pf.stoppedToday[`${todayStr}:${pos.slug}`] = now.toISOString();
        pf.positions.splice(pi,1);
        actions.push(`🎯 止盈(edge衰减): ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 入场edge=${(initialEdge*100).toFixed(1)}% 当前edge=${(currentEdge*100).toFixed(1)}% | PnL=$${realPnl0.toFixed(2)}`);
        continue;
      }
    }

    // "sell before settlement" strategy: if we captured >60% of initial edge, take profit
    if(initialEdge > 0 && priceMove/initialEdge > 0.6 && priceMove > 0.05){
      // Take profit — simulate fill
      const tpBook2 = pos.dir==='BUY_YES' ? ba : baNo;
      const tpSide = 'bid';
      const tpBudget = pos.shares * (pos.dir==='BUY_YES' ? (ba.bestBid||currentYesP) : (baNo.bestBid||currentNoP));
      const tpFill = tpBook2.simulateFill ? tpBook2.simulateFill(tpSide, tpBudget) : null;
      
      let exitVal, exitPrice;
      if(tpFill && tpFill.filled){
        const exitShares = Math.min(tpFill.shares, pos.shares);
        exitPrice = tpFill.avgPrice;
        if(pos.dir==='BUY_YES') exitVal = exitShares * exitPrice;
        else exitVal = exitShares * exitPrice;
      } else {
        exitPrice = ba.mid || currentYesP;
        if(pos.dir==='BUY_YES') exitVal = pos.shares * exitPrice;
        else exitVal = pos.shares * (1 - exitPrice);
      }
      const realPnl=exitVal-pos.cost;
      if(realPnl > 0){
        pf.cash+=exitVal;
        pf.totalPnl+=realPnl;
        pf.closedTrades.push({...pos, exitPrice, exitTime:now.toISOString(), pnl:Math.round(realPnl*100)/100, reason:'take_profit_60pct_edge_captured'});
        pf.stoppedToday[`${todayStr}:${pos.slug}`] = now.toISOString();
        pf.positions.splice(pi,1);
        actions.push(`🎯 止盈: ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 已吃到${Math.round(priceMove/initialEdge*100)}%的edge | 成交@${(exitPrice*100).toFixed(1)}% | PnL=$${realPnl.toFixed(2)}`);
        continue;
      }
    }

    // ─── Check for averaging down (补仓) ───
    // 第二轮优化: 模型不能明显恶化，且距离结算至少24小时，补仓比例降到33%
    const isSameDayPos = pos.date === getLocalDateStr(st?.utcOffset||8);
    const priceDropped = pos.dir==='BUY_YES' ? (currentYesP < pos.entryPrice * 0.9) : (currentYesP > pos.entryPrice * 1.1);
    const edgeStillValid = currentEdge >= rules.minEdge;
    const notAlreadyToppedUp = !pos.toppedUp;
    const maxTopup = Math.min(pos.cost * 0.33, rules.maxSingleTrade - pos.cost);
    const modelNotWorse = pos.dir==='BUY_YES' ? (modelP >= (pos.modelPAtEntry ?? modelP) - 0.05) : (modelP <= (pos.modelPAtEntry ?? modelP) + 0.05);
    const hoursToSettlement = (new Date(pos.date + 'T23:59:59Z') - now) / 3600000;

    if(priceDropped && edgeStillValid && notAlreadyToppedUp && !isSameDayPos && modelNotWorse && hoursToSettlement >= 24 && maxTopup >= 2 && pf.cash >= 2){
      const topupBudget = Math.min(maxTopup, pf.cash * 0.1); // conservative: max 10% of cash
      if(topupBudget >= 2){
        const topBook = pos.dir==='BUY_YES' ? ba : baNo;
        const topSide = 'ask';
        const topFill = topBook.simulateFill ? topBook.simulateFill(topSide, topupBudget) : null;
        if(topFill && topFill.filled && topFill.shares >= 1){
          // Execute topup
          const oldCost = pos.cost;
          const oldShares = pos.shares;
          pos.shares += topFill.shares;
          pos.cost += topFill.cost;
          pos.cost = Math.round(pos.cost * 100) / 100;
          pos.entryPrice = Math.round(pos.cost / pos.shares * 10000) / 10000; // new avg price
          pos.toppedUp = true;
          pos.topupTime = now.toISOString();
          pos.topupFills = topFill.fills;
          pf.cash -= topFill.cost;
          pf.cash = Math.round(pf.cash * 100) / 100;

          actions.push(`\n📥 补仓: ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir}`);
          actions.push(`   💡 逻辑: 价格下跌但edge仍有${(currentEdge*100).toFixed(1)}%(≥20%), 补仓拉低均价`);
          actions.push(`   💵 补入$${topFill.cost} | ${topFill.shares}股 | 均价${(topFill.avgPrice*100).toFixed(2)}%`);
          if(topFill.fills.length>1){
            actions.push(`   📖 逐档: ${topFill.fills.map(f=>`${f.shares}股@${(f.price*100).toFixed(1)}%=$${f.cost}`).join(' → ')}`);
          }
          actions.push(`   📊 仓位更新: ${oldShares.toFixed(1)}→${pos.shares.toFixed(1)}股 | 均价${(oldCost/oldShares*100).toFixed(1)}%→${(pos.entryPrice*100).toFixed(1)}% | 总成本$${pos.cost}`);
          continue; // skip normal status line
        }
      }
    }

    actions.push(`📊 持仓: ${pos.station} ${pos.date} ${pos.tempLabel} ${pos.dir} | 入${(pos.entryPrice*100).toFixed(1)}% 现${(currentYesP*100).toFixed(1)}% 模型${(modelP*100).toFixed(1)}% | edge=${(currentEdge*100).toFixed(1)}%`);
  }

  // ─── Phase 2: Scan for new BUY opportunities ────────────
  const heldStationNames = new Set(pf.positions.map(p => p.station));
  const targetScanDates = new Set();
  if(SCAN_MODE === 'full'){
    for(const st of STATIONS.slice(0,1)){
      for(let i=1;i<3;i++){
        const d = (() => {
          const nowLocal = new Date(now.getTime() + st.utcOffset * 3600000);
          nowLocal.setUTCHours(0,0,0,0);
          nowLocal.setUTCDate(nowLocal.getUTCDate() + i);
          return nowLocal.toISOString().slice(0,10);
        })();
        targetScanDates.add(d);
      }
      break;
    }
  }
  const topStationsByDate = {};
  for(const date of targetScanDates){
    topStationsByDate[date] = await getTopStationsByEventVolume(date, heldStationNames, 10);
  }
  const selectedStationNames = new Set(Object.values(topStationsByDate).flat().map(s => s.name));
  for(const name of heldStationNames) selectedStationNames.add(name);
  const stationsToScan = STATIONS.filter(st => selectedStationNames.has(st.name));
  for(const [date, sts] of Object.entries(topStationsByDate)){
    actions.push(`📈 ${date} 成交量前10城市: ${sts.map(s => s.name).join(', ')}`);
  }
  actions.push(`🧭 去重后扫描城市: ${stationsToScan.map(s => s.name).join(', ')}`);

  for(const st of stationsToScan){
    let daily,hourly;
    try{
      daily=await getTWCForecast(st.geocode);
      hourly=await getTWCHourly(st.geocode);
    }catch(e){actions.push(`⚠️ ${st.name} TWC获取失败: ${e.message}`);continue;}

    const daypart=daily.daypart?.[0]||{};

    // Check METAR for stop-loss context
    let metarTmax=null;
    try{
      const metars=await getMETAR(st.metarId);
      const temps=metars.map(m=>m.temp).filter(Number.isFinite);
      if(temps.length) metarTmax=Math.max(...temps);
    }catch{}

    // Track scan stats per city
    let cityScanned=0, citySkippedPrice=0, citySkippedEdge=0, citySkippedDepth=0, cityBought=0;
    let cityMaxEdge=0, cityMaxEdgeLabel='';
    const cityDaySummaries=[];

    const stScanDays = getScanDaysForStation(st);
    if(stScanDays === 0 && SCAN_MODE === 'today-only'){
      const localHour = getLocalHour(st.utcOffset);
      actions.push(`\n⏸️ ${st.name}: 当地${localHour}时, 不在升温时段(${st.peakStartLocal}-${st.peakEndLocal}), 跳过`);
      continue;
    }

    // Determine which days to scan for NEW positions
    // today-only mode: no new buys at all (only position checks above)
    // full mode: skip day 0 (today), only scan day 1+ (tomorrow, day-after)
    const scanStartDay = SCAN_MODE === 'today-only' ? 999 : 1; // today-only → skip all new buys
    const scanEndDay = SCAN_MODE === 'today-only' ? 0 : 3;

    if(SCAN_MODE === 'today-only'){
      actions.push(`\n🔍 ${st.name}: 加密扫描模式, 仅监控持仓止损/止盈, 不建新仓`);
    }

    for(let i=scanStartDay;i<scanEndDay;i++){
      const date=daily.validTimeLocal[i]?.slice(0,10);
      const dayName=daily.dayOfWeek[i];
      const forecastMax=daily.calendarDayTemperatureMax[i];
      if(!date) continue;
      const topForDate = topStationsByDate[date] || [];
      const isHeldCity = heldStationNames.has(st.name);
      if(SCAN_MODE === 'full' && !isHeldCity && !topForDate.some(x => x.name === st.name)) continue;

      // Fish-body hard rule: never open new positions on the station's local "today"
      const localToday = getLocalDateStr(st.utcOffset);
      if(date === localToday) {
        continue;
      }

      const hTemps=[];
      for(let h=0;h<(hourly.validTimeLocal||[]).length;h++){
        if(hourly.validTimeLocal[h]?.startsWith(date)) hTemps.push(hourly.temperature[h]);
      }
      const hourlyMax=hTemps.length?Math.max(...hTemps):forecastMax;
      let mu=forecastMax*0.7+hourlyMax*0.3;
      const dpIdx=i*2;
      const precip=daypart.qpf?.[dpIdx]||0;
      const cloud=daypart.cloudCover?.[dpIdx]||0;
      const wind=daypart.windSpeed?.[dpIdx]||0;
      const humid=daypart.relativeHumidity?.[dpIdx]||0;
      if(precip>5&&cloud>80) mu-=0.3;
      if(wind>30) mu-=0.2;
      if(humid<40&&cloud<30) mu+=0.3;

      const sigma = getSigmaForDate(date, st, rules.sigma);
      const dist=buildDist(mu,sigma);
      const eventSlug=dateSlug(date,st.name);
      let event;
      try{event=await getPMEvent(eventSlug);}catch{}
      if(!event?.markets?.length) continue;

      let dayScanned=0, dayMaxEdge=0, dayMaxEdgeLabel='';

      const exactMarkets = event.markets.filter(m=>!m.closed && isExactTempTitle(m.groupItemTitle||''));
      let peakK = null;
      let peakYes = -1;
      for(const em of exactMarkets){
        try{
          const px = JSON.parse(em.outcomePrices||'[]');
          const yes = Number(px[0]||0);
          const tm = (em.groupItemTitle||'').match(/(\d+)/);
          if(tm && yes > peakYes){ peakYes = yes; peakK = Number(tm[1]); }
        }catch{}
      }

      for(const mkt of event.markets){
        if(mkt.closed) continue;
        const px=JSON.parse(mkt.outcomePrices||'[]');
        const yesP=Number(px[0]||0);
        cityScanned++;
        dayScanned++;
        if(yesP>rules.priceCap||yesP<(1-rules.priceCap)){ citySkippedPrice++; continue; }

        const title=mkt.groupItemTitle||'';
        const tempMatch=title.match(/(\d+)/);
        if(!tempMatch) continue;
        const k=Number(tempMatch[1]);
        const isHigh=title.toLowerCase().includes('or higher');
        const isLow=title.toLowerCase().includes('or below');
        let modelP;
        if(isHigh) modelP=Object.entries(dist).filter(([kk])=>Number(kk)>=k).reduce((s,[,v])=>s+v,0);
        else if(isLow) modelP=Object.entries(dist).filter(([kk])=>Number(kk)<=k).reduce((s,[,v])=>s+v,0);
        else modelP=dist[k]||0;

        const noP = Number(px[1] || (1-yesP) || 0);
        const edgeYes = modelP - yesP;
        const edgeNo = (1 - modelP) - noP;
        const dir = edgeYes > edgeNo ? 'BUY_YES' : 'BUY_NO';
        const edge = dir==='BUY_YES' ? edgeYes : edgeNo;
        const absEdge=Math.abs(edge);

        if(absEdge>dayMaxEdge){dayMaxEdge=absEdge;dayMaxEdgeLabel=`${title}(${(edge*100).toFixed(1)}%)`;}
        if(absEdge>cityMaxEdge){cityMaxEdge=absEdge;cityMaxEdgeLabel=`${date} ${title}(${(edge*100).toFixed(1)}%)`;}

        if(absEdge<rules.minEdge){ citySkippedEdge++; continue; }

        // Skip if already have position in this slug
        if(pf.positions.some(p=>p.slug===mkt.slug)) continue;

        // 优化: 同城市+同日期最多2笔，避免相关性过高
        const sameCityDateCount = pf.positions.filter(p=>p.station===st.name && p.date===date).length;
        if(sameCityDateCount >= 2){
          actions.push(`   ⏭️ 跳过 ${st.name} ${date} ${title} ${dir}: 同城同日持仓已达2笔上限`);
          continue;
        }

        // ─── 鱼身v2: 止损/平仓后当天禁止重入 ───
        if(pf.stoppedToday[`${todayStr}:${mkt.slug}`]){
          actions.push(`   ⛔ 禁止重入 ${st.name} ${date} ${title} ${dir}: 今天已平过该标的`);
          continue;
        }

        // ─── 鱼身v3: 超大edge风控 ───
        // 后天/更远标的如果edge大到离谱，优先视为模型可能过度自信，先跳过而不是直接建仓
        const dayDiff = getLocalDayDiff(date, st);
        if(dayDiff >= 2 && absEdge > 0.50){
          actions.push(`   ⛔ 跳过 ${st.name} ${date} ${title} ${dir}: edge=${(absEdge*100).toFixed(1)}% 过大，疑似模型过度自信，等待下轮确认`);
          continue;
        }

        // ─── 鱼身v2: 赔率位置过滤 ───
        if(dir==='BUY_YES'){
          if(yesP < 0.10 || yesP > 0.40){
            actions.push(`   ⏭️ 跳过 ${st.name} ${date} ${title} BUY_YES: 赔率位置${(yesP*100).toFixed(0)}%不在舒适区(10-40%)`);
            continue;
          }
        } else { // BUY_NO
          if(noP < 0.10 || noP > 0.40){
            actions.push(`   ⏭️ 跳过 ${st.name} ${date} ${title} BUY_NO: 赔率位置NO=${(noP*100).toFixed(0)}%不在舒适区(10-40%)`);
            continue;
          }
        }

        // ─── 第一轮优化: 单城市暴露上限 ───
        const cityExposure = getCityExposure(pf, st.name);
        const cityExposureLimit = pf.initialCapital * 0.6;
        if(cityExposure >= cityExposureLimit){
          actions.push(`   ⏭️ 跳过 ${st.name} ${date} ${title} ${dir}: 城市暴露已达上限$${cityExposureLimit.toFixed(2)}`);
          continue;
        }

        // ─── 第一轮优化: 主峰拥挤点过滤（精确温度主峰默认不做，除非edge≥30%） ───
        if(isExactTempTitle(title) && peakK != null && k === peakK && absEdge < 0.30){
          actions.push(`   ⏭️ 跳过 ${st.name} ${date} ${title} ${dir}: 属于市场主峰拥挤点`);
          continue;
        }

        // ─── 修复1: 建仓前检查METAR, 如果实测已确认则禁止建仓 ───
        if(metarTmax != null){
          // BUY_NO on k°C: METAR已测到k°C → 禁止(人家都量到了你还赌"不是")
          if(dir==='BUY_NO' && metarTmax === k){
            actions.push(`   ⛔ 禁止建仓 ${st.name} ${date} ${title} BUY_NO: METAR已测到${metarTmax}°C, 不能赌"不是${k}°C"`);
            continue;
          }
          // BUY_YES on k°C: METAR已超过k+1°C → 禁止(最高温肯定不止k°C了)
          if(dir==='BUY_YES' && metarTmax > k + 1){
            actions.push(`   ⛔ 禁止建仓 ${st.name} ${date} ${title} BUY_YES: METAR已测到${metarTmax}°C, 最高温已超过${k}°C`);
            continue;
          }
        }

        // Fetch book
        const tokenIds=JSON.parse(mkt.clobTokenIds||'[]');
        let ba={}, baNo={};
        try{const bk=await getBook(tokenIds[0]);ba=parseBook(bk);}catch{}
        try{if(tokenIds[1]){const bkNo=await getBook(tokenIds[1]);baNo=parseBook(bkNo);}}catch{}

        // Position sizing: max 15% of initial capital, max $15
        const cityRemaining = Math.max(0, cityExposureLimit - cityExposure);
        const budgetWant=Math.min(rules.maxSingleTrade, pf.cash*rules.maxPositionPct, cityRemaining);
        if(budgetWant<2) continue;

        // Simulate actual fill against real orderbook
        const entryBook = dir==='BUY_YES' ? ba : baNo;
        const fillSide = 'ask';
        const fill = entryBook.simulateFill ? entryBook.simulateFill(fillSide, budgetWant) : null;
        if(!fill || !fill.filled || fill.shares<1) {
          actions.push(`   ⏭️ 跳过 ${st.name} ${date} ${title} ${dir}: 盘口无法成交(深度不足)`);
          continue;
        }

        // BUY_YES uses YES ask book; BUY_NO uses NO ask book directly from PM
        const cost = fill.cost;
        const shares = fill.shares;
        const avgPrice = fill.avgPrice;

        if(cost < 1) continue; // too tiny

        const position={
          slug:mkt.slug, station:st.name, date, dayName, tempLabel:title, k,
          dir, entryPrice:avgPrice,
          shares, cost, entryTime:now.toISOString(),
          modelPAtEntry:Math.round(modelP*1000)/1000,
          yesPAtEntry:yesP,
          noPAtEntry:noP,
          edgeAtEntry:Math.round(Math.abs(edge)*1000)/1000,
          forecastMaxAtEntry:forecastMax,
          muAtEntry:Math.round(mu*10)/10,
          fills:fill.fills, // detailed fill record
        };
        pf.positions.push(position);
        pf.cash-=cost;
        pf.cash=Math.round(pf.cash*100)/100;

        const reason=dir==='BUY_YES'
          ?`模型${(modelP*100).toFixed(1)}%远高于盘口${(yesP*100).toFixed(1)}%`
          :`模型${(modelP*100).toFixed(1)}%远低于盘口${(yesP*100).toFixed(1)}%`;

        actions.push(`\n🛒 买入: ${st.name} ${date}(${dayName}) ${title} ${dir}`);
        actions.push(`   💡 逻辑: WU预报max=${forecastMax}°C(调整${Math.round(mu*10)/10}°C), ${reason}, edge=${(Math.abs(edge)*100).toFixed(1)}%`);
        actions.push(`   📊 天气: 风${wind}km/h 降水${precip}mm 云${cloud}% 湿度${humid}%`);
        actions.push(`   💵 实际成交: $${cost} | ${shares}股 | 均价${(avgPrice*100).toFixed(2)}%`);
        if(fill.fills.length>1){
          actions.push(`   📖 逐档吃单: ${fill.fills.map(f=>`${f.shares}股@${(f.price*100).toFixed(1)}%=$${f.cost}`).join(' → ')}`);
        }
        if(fill.worstPrice!==fill.fills[0]?.price){
          actions.push(`   ⚠️ 滑点: 最优${(fill.fills[0]?.price*100).toFixed(1)}% → 最差${(fill.worstPrice*100).toFixed(1)}%`);
        }
        actions.push(`   📈 盘口: 买一${ba.bestBid} 卖一${ba.bestAsk} 价差${ba.spread?.toFixed(3)}`);
        cityBought++;
      }

      // Day summary
      cityDaySummaries.push(`${date}(${dayName}) max=${forecastMax}°C(adj${Math.round(mu*10)/10}) 扫${dayScanned}个 最大edge=${dayMaxEdge>0?(dayMaxEdgeLabel):'无'}`);
    }

    // City summary (always output, even if no buys)
    if(cityBought===0){
      actions.push(`\n🔍 ${st.name}: 扫描${cityScanned}个标的, 无机会 (跳过: ${citySkippedPrice}个盘口超限, ${citySkippedEdge}个edge不足)`);
      for(const ds of cityDaySummaries) actions.push(`   ${ds}`);
      if(cityMaxEdge>0) actions.push(`   最接近的机会: ${cityMaxEdgeLabel}`);
    }
  }

  // ─── Save & Output ──────────────────────────────────────
  pf.updatedAt=now.toISOString();
  await writeFile(PORTFOLIO_PATH, JSON.stringify(pf,null,2),'utf8');

  // Summary (use orderbook liquidation value)
  let posVal = 0;
  for(const p of pf.positions){
    posVal += await estimateLiquidationValue(p);
  }
  posVal = Math.round(posVal * 100) / 100;
  const { correctedClosedPnl, correctedCash } = getCorrectedSummaryAccounting(pf);

  const actionKeywords = ['🛒 买入', '🚨 止损', '💰 卖出', '🎯 止盈', '⏰ 分层止盈', '🏁 结算', '📥 补仓'];
  const compactActionLines = actions.filter(line => actionKeywords.some(k => line.includes(k)) || line.includes('💡 逻辑:'));
  const summaryLine = `📌 ${SCAN_MODE}｜持仓${pf.positions.length}个｜现金$${correctedCash.toFixed(2)}｜可平总资产$${(correctedCash+posVal).toFixed(2)}｜已平仓${pf.closedTrades.length}笔｜累计PnL $${correctedClosedPnl.toFixed(2)}`;

  if(compactActionLines.length === 0){
    console.log(`无动作｜${summaryLine}`);
  } else {
    console.log([summaryLine, ...compactActionLines].join('\n'));
  }
}

main().catch(e=>{console.error(e);process.exit(1);});
