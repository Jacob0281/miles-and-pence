// Miles & Pence vehicle lookup — a small Cloudflare Worker.
// GET /vehicle?reg=AB12CDE  →  { found, reg, make, model, colour, fuel, fuelLabel, engineCc, year, co2, mileage }
//
// Keeps the government API credentials secret (they live in Worker secrets, never in the app).
// Sources (used when their credentials are set):
//   - DVSA MOT History API: make, model, colour, fuel, engine size, first used date, MOT mileages
//     secrets: MOT_CLIENT_ID, MOT_CLIENT_SECRET, MOT_API_KEY
//   - DVLA Vehicle Enquiry Service: CO2 emissions, fuel, colour, engine, year
//     secret: DVLA_API_KEY
// Var: ALLOWED_ORIGINS — comma-separated list of sites allowed to call this.

const MOT_TOKEN_URL = 'https://login.microsoftonline.com/a455b827-244f-4c97-b5b4-ce5d13b4d00c/oauth2/v2.0/token';
const MOT_SCOPE = 'https://tapi.dvsa.gov.uk/.default';
const MOT_BASE = 'https://history.mot.api.gov.uk/v1/trade/vehicles/registration/';
const DVLA_URL = 'https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles';
const CACHE_SECONDS = 7 * 24 * 3600;

let motToken = null; // { value, expires }

function cors(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const ok = origin && (allowed.includes(origin) || allowed.includes('*'));
  return {
    'Access-Control-Allow-Origin': ok ? origin : allowed[0] || 'null',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}
function json(body, status, headers) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

async function getMotToken(env) {
  if (motToken && Date.now() < motToken.expires - 60000) return motToken.value;
  const res = await fetch(MOT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials', client_id: env.MOT_CLIENT_ID,
      client_secret: env.MOT_CLIENT_SECRET, scope: MOT_SCOPE,
    }),
  });
  if (!res.ok) throw new Error('MOT token HTTP ' + res.status);
  const d = await res.json();
  motToken = { value: d.access_token, expires: Date.now() + (d.expires_in || 3600) * 1000 };
  return motToken.value;
}

async function fromMot(reg, env) {
  if (!env.MOT_CLIENT_ID || !env.MOT_CLIENT_SECRET || !env.MOT_API_KEY) return null;
  const token = await getMotToken(env);
  const res = await fetch(MOT_BASE + encodeURIComponent(reg), {
    headers: { Authorization: 'Bearer ' + token, 'X-API-Key': env.MOT_API_KEY, Accept: 'application/json' },
  });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error('MOT lookup HTTP ' + res.status);
  return { found: true, data: await res.json() };
}

async function fromDvla(reg, env) {
  if (!env.DVLA_API_KEY) return null;
  const res = await fetch(DVLA_URL, {
    method: 'POST',
    headers: { 'x-api-key': env.DVLA_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ registrationNumber: reg }),
  });
  if (res.status === 404) return { found: false };
  if (!res.ok) throw new Error('DVLA lookup HTTP ' + res.status);
  return { found: true, data: await res.json() };
}

const title = (s) => (s ? String(s).toLowerCase().replace(/(^|[\s-])([a-z])/g, (m, a, b) => a + b.toUpperCase()) : null);
function fuelKind(raw) {
  const f = String(raw || '').toLowerCase();
  if (!f) return null;
  if (f.includes('electric') && !f.includes('hybrid')) return 'electric';
  if (f.includes('diesel')) return 'diesel';
  if (f.includes('hybrid')) return 'hybrid';
  if (f.includes('petrol')) return 'petrol';
  return 'other';
}
function mileageFrom(tests) {
  const pts = (tests || [])
    .map((t) => {
      let v = parseFloat(t.odometerValue);
      if (!isFinite(v) || v <= 0) return null;
      if (String(t.odometerUnit || '').toLowerCase().startsWith('k')) v = v / 1.609344;
      const d = new Date(t.completedDate || t.completedDateTime || t.testDate);
      return isNaN(d) ? null : { miles: Math.round(v), date: d };
    })
    .filter(Boolean)
    .sort((a, b) => a.date - b.date);
  if (!pts.length) return null;
  const last = pts[pts.length - 1];
  let perYear = null;
  if (pts.length >= 2) {
    const first = pts[0];
    const years = (last.date - first.date) / (365.25 * 24 * 3600 * 1000);
    if (years > 0.5 && last.miles > first.miles) perYear = Math.round((last.miles - first.miles) / years);
  }
  return { lastReading: last.miles, lastDate: last.date.toISOString().slice(0, 10), perYear };
}

function merge(reg, mot, dvla) {
  const m = mot && mot.found ? mot.data : null;
  const d = dvla && dvla.found ? dvla.data : null;
  if (!m && !d) return { found: false, reg };
  const fuelRaw = (d && d.fuelType) || (m && m.fuelType);
  const yearFromDate = (s) => (s ? parseInt(String(s).slice(0, 4), 10) || null : null);
  return {
    found: true,
    reg,
    make: title((m && m.make) || (d && d.make)),
    model: m && m.model ? title(m.model) : null,
    colour: title((m && m.primaryColour) || (d && d.colour)),
    fuel: fuelKind(fuelRaw),
    fuelLabel: title(fuelRaw),
    engineCc: parseInt((d && d.engineCapacity) || (m && m.engineSize), 10) || null,
    year: (d && d.yearOfManufacture) || yearFromDate(m && (m.manufactureDate || m.firstUsedDate || m.registrationDate)),
    co2: d && d.co2Emissions > 0 ? d.co2Emissions : null,
    mileage: m ? mileageFrom(m.motTests) : null,
    sources: [m ? 'DVSA MOT History' : null, d ? 'DVLA' : null].filter(Boolean),
  };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const h = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, mot: !!env.MOT_API_KEY, dvla: !!env.DVLA_API_KEY }, 200, h);
    }
    if (url.pathname !== '/vehicle' || request.method !== 'GET') return json({ error: 'Not found' }, 404, h);

    const reg = (url.searchParams.get('reg') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z0-9]{2,8}$/.test(reg)) return json({ error: 'That doesn’t look like a UK registration' }, 400, h);
    if (!env.MOT_API_KEY && !env.DVLA_API_KEY) return json({ error: 'Lookup not set up yet' }, 503, h);

    const cacheKey = new Request('https://cache.milesandpence/vehicle/' + reg);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) return json(await hit.json(), 200, h);

    let mot = null, dvla = null;
    const errors = [];
    await Promise.all([
      fromMot(reg, env).then((r) => (mot = r)).catch((e) => errors.push(e.message)),
      fromDvla(reg, env).then((r) => (dvla = r)).catch((e) => errors.push(e.message)),
    ]);
    if (!mot && !dvla && errors.length) return json({ error: 'Lookup failed', detail: errors }, 502, h);

    const body = merge(reg, mot, dvla);
    if (body.found) {
      ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(body), { headers: { 'Cache-Control': 'max-age=' + CACHE_SECONDS } })));
    }
    return json(body, 200, h);
  },
};
