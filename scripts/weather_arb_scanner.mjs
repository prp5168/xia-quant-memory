// Weather Arbitrage Scanner
// Scans WU(TWC) forecast + PM markets for Shanghai & Seoul
// Finds edge >= threshold and alerts via console (to be wired to Telegram)
//
// Usage:
//   node scripts/weather_arb_scanner.mjs
// Env:
//   EDGE_THRESHOLD=0.15   (minimum edge to alert, default 15%)
//   SIGMA=1.5             (forecast error std dev in °C)

const EDGE_THRESHOLD = Number(process.env.EDGE_THRESHOLD || '0.15');
const SIGMA = Number(process.env.SIGMA || '1.5');

const TWC_API_KEY = 'e1f10a1e78da46f5b10a1e78da96f525';

const STATIONS = [
  {
    name: 'Shanghai',
    icao: 'ZSPD',
    geocode: '31.15,121.803',
    metarId: 'ZSPD',
    pmSeriesSlug: 'shanghai-daily-weather',
    pmSlugPrefix: 'highest-temperature-in-shanghai-on-',
  },
  {
    name: 'Seoul',
    icao: 'RKSI',
    geocode: '37.469,126.451',
    metarId: 'RKSI',
    pmSeriesSlug: 'seoul-daily-weather',
    pmSlugPrefix: 'highest-temperature-in-seoul-on-',
  },
];

// ─── TWC API ───────────────────────────────────────────────

async function fetchTWC10DayForecast(geocode) {
  const url = `https://api.weather.com/v3/wx/forecast/daily/10day?apiKey=${TWC_API_KEY}&geocode=${encodeURIComponent(geocode)}&units=m&language=en-US&format=json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!r.ok) throw new Error(`TWC forecast failed: ${r.status}`);
  return r.json();
}

async function fetchTWCHourly(geocode) {
  const url = `https://api.weather.com/v3/wx/forecast/hourly/15day?apiKey=${TWC_API_KEY}&geocode=${encodeURIComponent(geocode)}&units=m&language=en-US&format=json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!r.ok) throw new Error(`TWC hourly failed: ${r.status}`);
  return r.json();
}

async function fetchTWCHistorical(icao) {
  const url = `https://api.weather.com/v3/wx/conditions/historical/dailysummary/30day?apiKey=${TWC_API_KEY}&icaoCode=${icao}&units=m&language=EN&format=json`;
  const r = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!r.ok) throw new Error(`TWC historical failed: ${r.status}`);
  return r.json();
}

// ─── Enhanced probability model ────────────────────────────

function normCdf(x) {
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429;
  const erf = 1 - ((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return 0.5 * (1 + sign * erf);
}

function pIntBin(mu, sigma, k) {
  // P(T rounds to integer k) = P(k-0.5 <= T < k+0.5)
  return Math.max(0, normCdf((k+0.5-mu)/sigma) - normCdf((k-0.5-mu)/sigma));
}

function buildProbDist(forecastMaxC, hourlyTemps, daypartData, sigma) {
  // Enhanced: adjust mu based on multiple signals
  let mu = forecastMaxC;

  // Factor 1: hourly max (if available, might differ from daily max)
  if (hourlyTemps && hourlyTemps.length > 0) {
    const hourlyMax = Math.max(...hourlyTemps);
    // Blend: 70% daily forecast, 30% hourly max
    mu = mu * 0.7 + hourlyMax * 0.3;
  }

  // Factor 2: wind chill / humidity adjustment
  // High wind + rain tends to suppress actual max slightly
  if (daypartData) {
    const windSpeed = daypartData.windSpeed; // km/h
    const precip = daypartData.qpf; // mm
    const humidity = daypartData.relativeHumidity;
    const cloudCover = daypartData.cloudCover;

    // Heavy rain + high cloud cover → actual max often slightly below forecast
    if (precip > 5 && cloudCover > 80) {
      mu -= 0.3;
    }
    // Strong wind → sensor reads accurately but can suppress warming
    if (windSpeed > 30) {
      mu -= 0.2;
    }
    // Very low humidity + clear sky → can overshoot forecast
    if (humidity < 40 && cloudCover < 30) {
      mu += 0.3;
    }
  }

  // Factor 3: adjust sigma based on forecast horizon
  // (could be passed in; for now use default)

  // Build distribution over reasonable range
  const probs = {};
  let total = 0;
  for (let k = Math.floor(mu - 6); k <= Math.ceil(mu + 6); k++) {
    const p = pIntBin(mu, sigma, k);
    if (p > 0.001) {
      probs[k] = p;
      total += p;
    }
  }
  // Normalize
  for (const k of Object.keys(probs)) {
    probs[k] /= total;
  }
  return { mu: Math.round(mu * 10) / 10, sigma, probs };
}

// ─── Polymarket ────────────────────────────────────────────

async function fetchPMEventMarkets(eventSlug) {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(eventSlug)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!r.ok) throw new Error(`Gamma events failed: ${r.status}`);
  const arr = await r.json();
  if (!arr.length) return null;
  return arr[0];
}

async function fetchBook(tokenId) {
  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!r.ok) return null;
  return r.json();
}

function bestBidAsk(book) {
  const bids = (book?.bids || []).map(x => Number(x.price)).filter(Number.isFinite);
  const asks = (book?.asks || []).map(x => Number(x.price)).filter(Number.isFinite);
  const bestBid = bids.length ? Math.max(...bids) : null;
  const bestAsk = asks.length ? Math.min(...asks) : null;
  const mid = (bestBid != null && bestAsk != null) ? (bestBid + bestAsk) / 2 : null;
  const spread = (bestBid != null && bestAsk != null) ? bestAsk - bestBid : null;
  const bidSize = bids.length ? (book.bids || []).reduce((s,x) => s + Number(x.size || 0), 0) : 0;
  const askSize = asks.length ? (book.asks || []).reduce((s,x) => s + Number(x.size || 0), 0) : 0;
  return { bestBid, bestAsk, mid, spread, bidSize: Math.round(bidSize), askSize: Math.round(askSize), last: book?.last_trade_price != null ? Number(book.last_trade_price) : null };
}

// ─── Date helpers ──────────────────────────────────────────

function dateSlug(dateStr, city) {
  // dateStr like "2026-03-19"
  const d = new Date(dateStr + 'T00:00:00Z');
  const months = ['january','february','march','april','may','june','july','august','september','october','november','december'];
  const month = months[d.getUTCMonth()];
  const day = d.getUTCDate();
  const year = d.getUTCFullYear();
  // e.g. "highest-temperature-in-shanghai-on-march-19-2026"
  return `highest-temperature-in-${city.toLowerCase()}-on-${month}-${day}-${year}`;
}

// ─── Main scan ─────────────────────────────────────────────

async function scanStation(station) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Scanning: ${station.name} (${station.icao})`);
  console.log(`${'='.repeat(60)}`);

  // 1) Get TWC 10-day forecast
  const forecast = await fetchTWC10DayForecast(station.geocode);
  const maxTemps = forecast.calendarDayTemperatureMax;
  const minTemps = forecast.calendarDayTemperatureMin;
  const dates = forecast.validTimeLocal.map(d => d.slice(0, 10));
  const dayNames = forecast.dayOfWeek;

  // 2) Get hourly forecast
  const hourly = await fetchTWCHourly(station.geocode);

  // 3) Get daypart data
  const daypart = forecast.daypart?.[0] || {};

  const results = [];

  // Scan each upcoming day (skip today index 0, focus on tomorrow+)
  for (let i = 0; i < Math.min(maxTemps.length, 5); i++) {
    const date = dates[i];
    const dayName = dayNames[i];
    const forecastMax = maxTemps[i];
    const forecastMin = minTemps[i];

    // Get hourly temps for this date
    const dayHourlyTemps = [];
    if (hourly?.validTimeLocal && hourly?.temperature) {
      for (let h = 0; h < hourly.validTimeLocal.length; h++) {
        if (hourly.validTimeLocal[h]?.startsWith(date)) {
          dayHourlyTemps.push(hourly.temperature[h]);
        }
      }
    }

    // Get daypart data for daytime of this date (index i*2)
    const dpIdx = i * 2;
    const dpData = {
      windSpeed: daypart.windSpeed?.[dpIdx],
      qpf: daypart.qpf?.[dpIdx],
      relativeHumidity: daypart.relativeHumidity?.[dpIdx],
      cloudCover: daypart.cloudCover?.[dpIdx],
      precipChance: daypart.precipChance?.[dpIdx],
      narrative: daypart.narrative?.[dpIdx],
    };

    // Build probability distribution
    const dist = buildProbDist(forecastMax, dayHourlyTemps, dpData, SIGMA);

    // Find PM event for this date
    const eventSlug = dateSlug(date, station.name);
    let event;
    try {
      event = await fetchPMEventMarkets(eventSlug);
    } catch (e) {
      // Event might not exist yet
    }

    if (!event || !event.markets?.length) {
      console.log(`\n${date} (${dayName}): forecast max=${forecastMax}°C, no PM event found`);
      continue;
    }

    console.log(`\n${date} (${dayName}): forecast max=${forecastMax}°C (adjusted mu=${dist.mu}°C)`);
    console.log(`  Weather: ${dpData.narrative || 'N/A'}`);
    console.log(`  Factors: wind=${dpData.windSpeed}km/h, precip=${dpData.qpf}mm(${dpData.precipChance}%), cloud=${dpData.cloudCover}%, humidity=${dpData.relativeHumidity}%`);

    // Compare each market
    for (const mkt of event.markets) {
      if (mkt.closed) continue;
      const prices = JSON.parse(mkt.outcomePrices || '[]');
      const yesPrice = Number(prices[0] || 0);
      const title = mkt.groupItemTitle || '';

      // Extract temperature from title (e.g. "13°C" or "12°C or higher")
      const tempMatch = title.match(/(\d+)/);
      if (!tempMatch) continue;
      const tempK = Number(tempMatch[1]);
      const isOrHigher = title.toLowerCase().includes('or higher');
      const isOrBelow = title.toLowerCase().includes('or below');

      // Get model probability
      let modelP;
      if (isOrHigher) {
        modelP = Object.entries(dist.probs).filter(([k]) => Number(k) >= tempK).reduce((s, [, v]) => s + v, 0);
      } else if (isOrBelow) {
        modelP = Object.entries(dist.probs).filter(([k]) => Number(k) <= tempK).reduce((s, [, v]) => s + v, 0);
      } else {
        modelP = dist.probs[tempK] || 0;
      }

      const edge = modelP - yesPrice;

      // Get orderbook
      const tokenIds = JSON.parse(mkt.clobTokenIds || '[]');
      const yesTokenId = tokenIds[0];
      let book = null;
      let ba = {};
      if (yesTokenId && Math.abs(edge) >= EDGE_THRESHOLD * 0.5) {
        // Only fetch book for interesting markets
        try {
          book = await fetchBook(yesTokenId);
          ba = bestBidAsk(book);
        } catch {}
      }

      const r = {
        date,
        dayName,
        station: station.name,
        tempLabel: title,
        tempK,
        isOrHigher,
        isOrBelow,
        forecastMax,
        adjustedMu: dist.mu,
        modelP: Math.round(modelP * 1000) / 1000,
        yesPrice,
        edge: Math.round(edge * 1000) / 1000,
        edgePct: Math.round(edge * 100 * 10) / 10,
        slug: mkt.slug,
        volume24h: Number(mkt.volume24hr || 0),
        book: ba,
      };

      if (Math.abs(edge) >= EDGE_THRESHOLD) {
        results.push(r);
        const dir = edge > 0 ? '🟢 BUY Yes' : '🔴 BUY No';
        console.log(`  ${dir} | ${title} | model=${(modelP*100).toFixed(1)}% vs market=${(yesPrice*100).toFixed(1)}% | edge=${(edge*100).toFixed(1)}%`);
        if (ba.bestBid != null) {
          console.log(`    Book: bid=${ba.bestBid} ask=${ba.bestAsk} spread=${ba.spread?.toFixed(3)} mid=${ba.mid?.toFixed(3)} bidSz=$${ba.bidSize} askSz=$${ba.askSize}`);
        }
      }
    }
  }

  return results;
}

// ─── Entry ─────────────────────────────────────────────────

async function main() {
  console.log(`Weather Arb Scanner | ${new Date().toISOString()}`);
  console.log(`Edge threshold: ${(EDGE_THRESHOLD * 100).toFixed(0)}% | Sigma: ${SIGMA}°C`);

  const allResults = [];
  for (const station of STATIONS) {
    try {
      const results = await scanStation(station);
      allResults.push(...results);
    } catch (e) {
      console.error(`Error scanning ${station.name}:`, e.message);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`SUMMARY: Found ${allResults.length} opportunities with edge >= ${(EDGE_THRESHOLD*100).toFixed(0)}%`);
  console.log(`${'='.repeat(60)}`);

  if (allResults.length) {
    // Sort by absolute edge descending
    allResults.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
    for (const r of allResults) {
      const dir = r.edge > 0 ? 'BUY YES' : 'BUY NO';
      console.log(`\n📊 ${r.station} ${r.date} ${r.tempLabel}`);
      console.log(`   ${dir} | model ${(r.modelP*100).toFixed(1)}% vs mkt ${(r.yesPrice*100).toFixed(1)}% | edge ${r.edgePct}%`);
      console.log(`   Forecast: max=${r.forecastMax}°C (adj ${r.adjustedMu}°C)`);
      if (r.book.bestBid != null) {
        console.log(`   Book: bid=${r.book.bestBid} ask=${r.book.bestAsk} spread=${r.book.spread?.toFixed(3)} | depth bid=$${r.book.bidSize} ask=$${r.book.askSize}`);
      }
      console.log(`   24h vol: $${Math.round(r.volume24h)} | slug: ${r.slug}`);
    }
  }

  // Output JSON for programmatic use
  console.log('\n--- JSON ---');
  console.log(JSON.stringify(allResults, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
