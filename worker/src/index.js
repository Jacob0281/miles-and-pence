// Miles & Pence service (Cloudflare Worker)
// Deployed by .github/workflows/worker.yml
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
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

// ---------- test data sharing ----------
// Testers' apps send a summary snapshot (no routes, no locations, no reg) under a random tester
// code. Each tester's phone holds a secret; only that phone can update or delete its data.
// Stored in the TESTERS KV namespace. Jacob reads it at /admin with ADMIN_TOKEN.

const ID_RE = /^T-[A-Z0-9]{6}$/;
const MAX_SNAPSHOT_BYTES = 400 * 1024;

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function readJson(request) {
  const text = await request.text();
  if (text.length > MAX_SNAPSHOT_BYTES) throw new Error('too_large');
  return JSON.parse(text);
}
async function checkTester(env, body) {
  if (!body || !ID_RE.test(body.testerId || '') || typeof body.secret !== 'string' || body.secret.length < 32) return { error: 'bad_request' };
  const key = 'tester:' + body.testerId;
  const existing = await env.TESTERS.get(key, 'json');
  const hash = await sha256(body.secret);
  if (existing && existing.secretHash !== hash) return { error: 'forbidden' };
  return { key, existing, hash };
}
async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const auth = request.headers.get('Authorization') || '';
  const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return given.length > 0 && (await sha256(given)) === (await sha256(env.ADMIN_TOKEN));
}

async function handleShare(request, env, h) {
  if (!env.TESTERS) return json({ error: 'Test sharing is not set up yet' }, 503, h);
  let body;
  try { body = await readJson(request); } catch (e) { return json({ error: e.message === 'too_large' ? 'Too large' : 'Bad request' }, 400, h); }
  const c = await checkTester(env, body);
  if (c.error) return json({ error: c.error }, c.error === 'forbidden' ? 403 : 400, h);
  const now = new Date().toISOString();
  const record = {
    testerId: body.testerId,
    secretHash: c.hash,
    agreedAt: (c.existing && c.existing.agreedAt) || body.agreedAt || now,
    noticeVersion: body.noticeVersion || (c.existing && c.existing.noticeVersion) || null,
    // What the tester has agreed to, kept as a dated record. insights = optional opt-in to
    // anonymised, combined use of their data beyond the test.
    consent: body.consent && typeof body.consent === 'object'
      ? { insights: !!body.consent.insights, insightsAt: body.consent.insightsAt || null }
      : (c.existing && c.existing.consent) || { insights: false, insightsAt: null },
    firstSeen: (c.existing && c.existing.firstSeen) || now,
    lastSync: now,
    snapshot: body.snapshot || null,
  };
  await env.TESTERS.put(c.key, JSON.stringify(record));
  return json({ ok: true, lastSync: now }, 200, h);
}

async function handleLeave(request, env, h) {
  if (!env.TESTERS) return json({ error: 'Test sharing is not set up yet' }, 503, h);
  let body;
  try { body = await readJson(request); } catch (e) { return json({ error: 'Bad request' }, 400, h); }
  const c = await checkTester(env, body);
  if (c.error) return json({ error: c.error }, c.error === 'forbidden' ? 403 : 400, h);
  await env.TESTERS.delete(c.key);
  return json({ ok: true, deleted: true }, 200, h);
}

async function handleAdminData(request, env) {
  const nostore = { 'Cache-Control': 'no-store' };
  if (!(await isAdmin(request, env))) return json({ error: 'Wrong password' }, 401, nostore);
  if (!env.TESTERS) return json({ testers: [] }, 200, nostore);
  const out = [];
  let cursor;
  do {
    const page = await env.TESTERS.list({ prefix: 'tester:', cursor });
    for (const k of page.keys) {
      const r = await env.TESTERS.get(k.name, 'json');
      if (r) { delete r.secretHash; out.push(r); }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  out.sort((a, b) => (b.lastSync || '').localeCompare(a.lastSync || ''));
  return json({ testers: out, at: new Date().toISOString() }, 200, nostore);
}

const ADMIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Miles &amp; Pence test dashboard</title>
<style>
:root{--bg:#0E1A17;--surface:#16261F;--line:#26392F;--ink:#F3EFE6;--muted:#A9BBB5;--amber:#F2A93B;--good:#5BD497;--warn:#FFB4A2}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,sans-serif;padding:24px max(16px,env(safe-area-inset-left))}
.wrap{max-width:1100px;margin:0 auto;display:flex;flex-direction:column;gap:18px}h1{margin:0;font-size:26px}
.muted{color:var(--muted)}.card{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:16px}
input{font:inherit;color:var(--ink);background:#0A1411;border:1px solid var(--line);border-radius:10px;height:44px;padding:0 12px;width:100%;max-width:320px}
button{font:inherit;font-weight:700;height:44px;padding:0 16px;border-radius:12px;border:0;background:var(--amber);color:#1A1200;cursor:pointer}
button.q{background:transparent;color:var(--ink);border:1px solid var(--line)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}.kpi .v{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.tbl{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:900px;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
.ok{color:var(--good)}.bad{color:var(--warn)}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
</style></head><body><div class="wrap">
<h1>Miles &amp; Pence test dashboard</h1>
<div class="card row" id="login"><input id="pw" type="password" placeholder="Dashboard password" autocomplete="current-password" aria-label="Dashboard password"><button id="go">Show testers</button><span id="msg" class="muted"></span></div>
<div id="out" hidden>
<div class="kpis" id="kpis"></div>
<div class="card tbl"><table><thead><tr><th>Tester</th><th>Car</th><th>Phone</th><th>Trips</th><th>Miles</th><th>GPS paused</th><th>Est. trip cost</th><th>Fuel bought</th><th>Model vs real</th><th>Stops detected</th><th>Driver score</th><th>Insights opt-in</th><th>Notice</th><th>Last trip</th><th>Last sync</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="row"><button class="q" id="dl">Download all data (JSON)</button><span class="muted" id="at"></span></div>
</div></div>
<script>
const $=id=>document.getElementById(id);let data=null;
const gbp=n=>'£'+(Number(n)||0).toFixed(2);const ago=s=>{if(!s)return'–';const m=Math.round((Date.now()-new Date(s))/6e4);return m<60?m+' min ago':m<2880?Math.round(m/60)+' hr ago':Math.round(m/1440)+' days ago'};
function cell(t,cls){const td=document.createElement('td');td.textContent=t;if(cls)td.className=cls;return td}
async function load(){const pw=$('pw').value||sessionStorage.getItem('mp-admin')||'';if(!pw)return;$('msg').textContent='Loading…';
 const r=await fetch('/admin/data',{headers:{Authorization:'Bearer '+pw}});if(!r.ok){$('msg').textContent=r.status===401?'Wrong password':'Could not load ('+r.status+')';return}
 sessionStorage.setItem('mp-admin',pw);data=await r.json();$('msg').textContent='';$('login').hidden=true;$('out').hidden=false;render()}
function render(){const t=data.testers;const s=t.map(x=>(x.snapshot&&x.snapshot.summary)||{});const sum=k=>s.reduce((a,b)=>a+(Number(b[k])||0),0);
 const active=t.filter(x=>x.snapshot&&x.snapshot.summary&&x.snapshot.summary.lastTripDate&&(Date.now()-new Date(x.snapshot.summary.lastTripDate))<7*864e5).length;
 const sc=s.map(x=>x.driverScore).filter(v=>v!=null);
 const k=[['Testers',t.length],['Avg driver score',sc.length?Math.round(sc.reduce((a,b)=>a+b,0)/sc.length):'–'],['Insights opt-in',t.filter(x=>x.consent&&x.consent.insights).length],['Active this week',active],['Trips',sum('trips')],['Miles',Math.round(sum('miles'))],['Fill-ups',sum('fills')],['Stops detected',sum('fills')?Math.round(100*sum('fillsDetected')/sum('fills'))+'%':'–']];
 $('kpis').replaceChildren(...k.map(([l,v])=>{const d=document.createElement('div');d.className='card kpi';const a=document.createElement('div');a.className='muted';a.textContent=l;const b=document.createElement('div');b.className='v';b.textContent=v;d.append(a,b);return d}));
 $('rows').replaceChildren(...t.map(x=>{const c=(x.snapshot&&x.snapshot.car)||{};const m=(x.snapshot&&x.snapshot.summary)||{};const tr=document.createElement('tr');
  const kk=m.k?Math.round((m.k-1)*100):null;
  tr.append(cell(x.testerId),cell([c.make,c.model].filter(Boolean).join(' ')||(c.fuel||'–')),cell((x.snapshot&&x.snapshot.platform)||'–'),cell(m.trips||0),cell(Math.round(m.miles||0)),
   cell(m.gapMiles?m.gapMiles.toFixed(1)+' mi':'–'),cell(gbp(m.est)),cell(gbp(m.bought)),cell(kk==null?'not yet':(kk>0?'+':'')+kk+'%',kk==null?'muted':Math.abs(kk)<=10?'ok':'bad'),
   cell(m.fills?m.fillsDetected+' of '+m.fills:'–'),cell(m.driverScore==null?'–':m.driverScore,m.driverScore==null?'muted':m.driverScore>=70?'ok':'bad'),cell(x.consent&&x.consent.insights?'Yes':'No',x.consent&&x.consent.insights?'ok':'muted'),cell('v'+(x.noticeVersion||'?')),cell(m.lastTripDate||'–'),cell(ago(x.lastSync)));return tr}));
 $('at').textContent='Loaded '+new Date(data.at).toLocaleString('en-GB')}
$('go').onclick=load;$('pw').addEventListener('keydown',e=>{if(e.key==='Enter')load()});
$('dl').onclick=()=>{const b=new Blob([JSON.stringify(data,null,1)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='miles-and-pence-test-data.json';a.click()};
if(sessionStorage.getItem('mp-admin'))load();
</script></body></html>`;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const h = cors(origin, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return json({ ok: true, mot: !!env.MOT_API_KEY, dvla: !!env.DVLA_API_KEY, sharing: !!env.TESTERS }, 200, h);
    }
    if (url.pathname === '/share' && request.method === 'POST') return handleShare(request, env, h);
    if (url.pathname === '/leave' && request.method === 'POST') return handleLeave(request, env, h);
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      return new Response(ADMIN_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
    }
    if (url.pathname === '/admin/data') return handleAdminData(request, env);
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
