// Fetch METARs from NOAA Aviation Weather Center (ADDS Data Server)
// Docs-ish: aviationweather.gov/dataserver

const STATION = process.env.STATION || 'ZSPD';
const HOURS = process.env.HOURS || '12';

const url = new URL('https://aviationweather.gov/api/data/metar');
url.searchParams.set('ids', STATION);
url.searchParams.set('hours', String(HOURS));
url.searchParams.set('format', 'json');

function normalize(m) {
  return {
    raw_text: m.rawOb ?? null,
    observation_time: m.reportTime ?? null, // ISO8601
    obsTime: m.obsTime ?? null,             // epoch seconds
    temp_c: (m.temp != null ? Number(m.temp) : null),
    dewpoint_c: (m.dewp != null ? Number(m.dewp) : null),
    wind_dir_degrees: (m.wdir != null ? Number(m.wdir) : null),
    wind_speed_kt: (m.wspd != null ? Number(m.wspd) : null),
  };
}

async function main() {
  const res = await fetch(url, { headers: { 'User-Agent': 'openclaw-weather-odds-bot/0.1' } });
  if (!res.ok) throw new Error(`NOAA AWC failed: ${res.status}`);
  const arr = await res.json();
  const metars = arr.map(normalize).filter(m => m.observation_time);
  metars.sort((a,b) => (a.obsTime ?? 0) - (b.obsTime ?? 0));

  const temps = metars.map(m => m.temp_c).filter(t => Number.isFinite(t));
  const tmax = temps.length ? Math.max(...temps) : null;

  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    station: STATION,
    count: metars.length,
    tmax,
    latest: metars.length ? metars[metars.length-1] : null,
    metars
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
