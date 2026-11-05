// Collects every UK forecourt and its current prices from the government Fuel Finder API
// and writes one compact JSON file the app can read. Runs on a schedule in GitHub Actions.
//
// Env: FUEL_FINDER_CLIENT_ID, FUEL_FINDER_CLIENT_SECRET
// Usage: node scripts/fetch-prices.mjs dist/prices.json
//
// Data: Fuel Finder scheme, Open Government Licence v3.0.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const BASE = 'https://www.fuel-finder.service.gov.uk/api/v1';
const OUT = process.argv[2] || 'dist/prices.json';
const PAUSE_MS = 700; // stay well inside the documented 100 requests/minute, one at a time
const BATCH = 500;

const id = process.env.FUEL_FINDER_CLIENT_ID;
const secret = process.env.FUEL_FINDER_CLIENT_SECRET;
if (!id || !secret) {
  console.log('No Fuel Finder credentials set; skipping price fetch.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unwrap = (j) => (j && typeof j === 'object' && 'data' in j ? j.data : j);

async function token() {
  const res = await fetch(BASE + '/oauth/generate_access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: id, client_secret: secret }),
  });
  const text = await res.text();
  if (!res.ok) {
    const h = {};
    for (const k of ['server', 'via', 'x-cache', 'x-amz-cf-pop', 'x-amzn-errortype', 'cf-ray', 'content-type', 'www-authenticate']) {
      if (res.headers.get(k)) h[k] = res.headers.get(k);
    }
    console.error('Token response headers: ' + JSON.stringify(h));
    try {
      const ip = await (await fetch('https://ipinfo.io/json')).json();
      console.error('Runner location: ' + [ip.city, ip.region, ip.country].join(', '));
    } catch (e) {}
    try {
      const home = await fetch('https://www.fuel-finder.service.gov.uk/');
      console.error('Plain GET of the Fuel Finder home page from here: HTTP ' + home.status);
    } catch (e) {}
    throw new Error(`Token request failed: HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  const d = unwrap(JSON.parse(text));
  if (!d.access_token) throw new Error('Token response had no access_token: ' + text.slice(0, 300));
  return d.access_token;
}

async function getAll(path, bearer) {
  const rows = [];
  for (let batch = 1; batch < 200; batch++) {
    let res;
    for (let attempt = 0; attempt < 4; attempt++) {
      res = await fetch(`${BASE}${path}?batch-number=${batch}`, {
        headers: { Authorization: 'Bearer ' + bearer, Accept: 'application/json' },
      });
      if (res.status !== 429 && res.status < 500) break;
      await sleep(2000 * (attempt + 1));
    }
    const text = await res.text();
    if (res.status === 404 && rows.length) break; // past the last batch
    if (!res.ok) throw new Error(`${path} batch ${batch}: HTTP ${res.status} ${text.slice(0, 300)}`);
    const page = unwrap(JSON.parse(text));
    const list = Array.isArray(page) ? page : [];
    rows.push(...list);
    if (list.length < BATCH) break;
    await sleep(PAUSE_MS);
  }
  return rows;
}

const round1 = (n) => Math.round(n * 10) / 10;

function pence(v) {
  const n = typeof v === 'string' ? parseFloat(v) : v;
  if (!isFinite(n) || n <= 0) return null;
  return round1(n < 10 ? n * 100 : n); // accept £/L or p/L
}

async function main() {
  const started = Date.now();
  const bearer = await token();
  const stations = await getAll('/pfs', bearer);
  await sleep(PAUSE_MS);
  const prices = await getAll('/pfs/fuel-prices', bearer);

  const byId = new Map();
  for (const s of stations) {
    if (s.permanent_closure) continue;
    const loc = s.location || {};
    const lat = parseFloat(loc.latitude), lon = parseFloat(loc.longitude);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    byId.set(s.node_id, {
      id: s.node_id,
      n: s.trading_name || s.brand_name || 'Fuel station',
      b: s.brand_name || null,
      t: [loc.city, loc.postcode].filter(Boolean).join(' '),
      la: Math.round(lat * 1e5) / 1e5,
      lo: Math.round(lon * 1e5) / 1e5,
      x: s.temporary_closure ? 1 : undefined,
      p: {},
    });
  }
  let priced = 0;
  for (const s of prices) {
    const row = byId.get(s.node_id);
    if (!row) continue;
    for (const fp of s.fuel_prices || []) {
      const p = pence(fp.price);
      if (p == null) continue;
      row.p[fp.fuel_type] = p;
      const ts = fp.price_last_updated || fp.price_change_effective_timestamp;
      if (ts && (!row.u || ts > row.u)) row.u = ts;
    }
    if (Object.keys(row.p).length) priced++;
  }

  const out = {
    source: 'UK Government Fuel Finder scheme (Open Government Licence v3.0)',
    fetchedAt: new Date().toISOString(),
    stations: [...byId.values()],
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out));
  const fuelTypes = new Set(out.stations.flatMap((s) => Object.keys(s.p)));
  console.log(`Wrote ${out.stations.length} stations (${priced} with prices) to ${OUT} in ${Math.round((Date.now() - started) / 1000)}s`);
  console.log('Fuel types seen: ' + [...fuelTypes].join(', '));
  if (stations[0]) console.log('Sample station keys: ' + Object.keys(stations[0]).join(', '));
  if (prices[0]) console.log('Sample price record: ' + JSON.stringify(prices[0]).slice(0, 400));
}

main().catch((e) => {
  console.error('Price fetch failed: ' + e.message);
  process.exit(1);
});
