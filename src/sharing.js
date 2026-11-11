// Test data sharing: sends a summary of a tester's car, trips and fill-ups to the Miles & Pence
// service under a random tester code. Never sends GPS routes, start or end points, trip names
// or the registration number.
import { Platform } from 'react-native';
import { API_URL, APP_VERSION, NOTICE_VERSION } from './config';
import { calibrate, currentPrice, monthSummary, odoCheck, officialMpg, sortEntries, todayKey, tripFuel } from './fuel';
import { driverScore, hasScore, scoreTrip } from './score';

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomString(n, chars) {
  const bytes = new Uint8Array(n);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < n; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/** A new tester identity: a short code to quote, and a secret that stays on this phone. */
export function newTester() {
  return {
    testerId: 'T-' + randomString(6, CHARS),
    secret: randomString(48, CHARS + 'abcdefghijkmnpqrstuvwxyz'),
    agreedAt: new Date().toISOString(),
    noticeVersion: NOTICE_VERSION,
  };
}

function platformName() {
  if (Platform.OS !== 'web') return Platform.OS;
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /iPhone|iPad/.test(ua) ? 'iPhone (web)' : /Android/.test(ua) ? 'Android (web)' : 'other (web)';
}

/** What gets shared. Kept deliberately small. */
export function buildSnapshot(data) {
  const car = data.car || {};
  const entries = data.entries || [];
  const cal = calibrate(car, entries);
  const price = currentPrice(car, entries);
  const trips = sortEntries(entries).filter((e) => e.kind === 'trip');
  const fills = entries.filter((e) => e.kind === 'fill');
  const month = monthSummary(car, entries, todayKey().slice(0, 7));
  const odo = odoCheck(car, entries);
  let est = 0;
  for (const t of trips) est += tripFuel(t, car, entries, cal, price).cost || 0;
  const ctx = { car, cal, price };
  const ds = driverScore(entries, ctx);
  // Driving style shared as scores and counts only. Speeds (including time above 70 mph) stay on the phone.
  const styleOf = (t) => {
    if (!hasScore(t)) return null;
    const s = scoreTrip(t, ctx);
    const part = (k) => s.parts.find((p) => p.key === k).score;
    return { score: s.score, smooth: part('smooth'), idle: part('idle'),
      sharpStarts: t.behaviour.harshAccel || 0, sharpStops: t.behaviour.harshBrake || 0 };
  };
  return {
    appVersion: APP_VERSION,
    platform: platformName(),
    car: {
      make: car.make || null, model: car.model || null, year: car.year || null, engineCc: car.engineCc || null,
      fuel: car.fuel || null, grade: car.grade || null, co2: car.co2 || null, mpg: car.mpg || null, price: car.price || null,
    },
    summary: {
      trips: trips.length,
      gpsTrips: trips.filter((t) => t.source === 'gps').length,
      miles: Math.round(trips.reduce((s, t) => s + (t.miles || 0), 0) * 10) / 10,
      gapMiles: Math.round(trips.reduce((s, t) => s + (t.gapMiles || 0), 0) * 10) / 10,
      fills: fills.length,
      fillsDetected: fills.filter((f) => f.stationId).length,
      est: Math.round(est * 100) / 100,
      bought: Math.round(fills.reduce((s, f) => s + (f.spend || 0), 0) * 100) / 100,
      monthEst: Math.round(month.est * 100) / 100,
      monthBought: Math.round(month.bought * 100) / 100,
      officialMpg: officialMpg(car),
      realMpg: cal.realMpg,
      k: cal.calibrated ? Math.round(cal.k * 1000) / 1000 : null,
      odoCoverage: odo && !odo.error ? Math.round(odo.coverage * 100) / 100 : null,
      lastTripDate: trips.length ? trips[trips.length - 1].date : null,
      driverScore: ds ? ds.score : null,
    },
    // Entries without anything that could reveal where someone lives or works.
    entries: entries.map((e) => {
      if (e.kind === 'trip') {
        return { kind: 'trip', date: e.date, miles: e.miles, litres: e.litres ?? null, seconds: e.seconds ?? null,
          idleSeconds: e.idleSeconds ?? null, bands: e.bands || null, gapMiles: e.gapMiles || 0, source: e.source || null,
          style: styleOf(e) };
      }
      if (e.kind === 'fill') {
        return { kind: 'fill', date: e.date, spend: e.spend, price: e.price, litres: e.litres, full: !!e.full,
          odo: e.odo ?? null, station: e.station || null, detected: !!e.stationId };
      }
      return { kind: e.kind, date: e.date, odo: e.odo ?? null };
    }),
  };
}

async function post(path, body) {
  const res = await fetch(API_URL + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
  return json;
}

export const sharingAvailable = () => !!API_URL;

/** Sends the latest snapshot. Resolves to the server time of the sync. */
export async function shareNow(data) {
  const t = data.test;
  if (!API_URL || !t || !t.testerId || t.left) return null;
  const r = await post('/share', {
    testerId: t.testerId, secret: t.secret, agreedAt: t.agreedAt, noticeVersion: t.noticeVersion,
    consent: { insights: !!t.insights, insightsAt: t.insightsAt || null },
    snapshot: buildSnapshot(data),
  });
  return r.lastSync;
}

/** Deletes this tester's shared data. */
export async function leaveTest(data) {
  const t = data.test;
  if (!API_URL || !t || !t.testerId) return true; // nothing was ever shared
  await post('/leave', { testerId: t.testerId, secret: t.secret });
  return true;
}
