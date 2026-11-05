// Pure fuel maths. No React, no storage — easy to test and reuse in the native app.

export const LITRES_PER_GALLON = 4.54609; // UK gallon
export const METRES_PER_MILE = 1609.344;

// Grams of CO2 released per litre burned (approximate, UK DfT conversion factors).
const CO2_G_PER_LITRE = { petrol: 2320, diesel: 2640 };

/** Official mpg (UK) from a CO2 figure in g/km. */
export function mpgFromCo2(co2, fuel = 'petrol') {
  if (!co2 || co2 <= 0) return null;
  const litresPer100km = co2 / (CO2_G_PER_LITRE[fuel] / 100);
  return 282.481 / litresPer100km;
}

export function officialMpg(car) {
  if (!car) return null;
  if (car.mpg > 0) return car.mpg;
  return mpgFromCo2(car.co2, car.fuel);
}

// ---------- speed model ----------
// How much more (or less) fuel a mile takes at a given speed, relative to the car's
// official combined figure. Shape follows typical speed–fuel curves: worst in slow
// stop-start traffic, best around 45–60 mph, rising again with motorway speed (drag).
const SPEED_CURVE = [
  [3, 2.2], [10, 1.6], [20, 1.25], [30, 1.05], [40, 0.93], [50, 0.88],
  [58, 0.88], [65, 0.95], [70, 1.02], [80, 1.2], [90, 1.42],
];
export function speedFactor(mph) {
  if (mph <= SPEED_CURVE[0][0]) return SPEED_CURVE[0][1];
  for (let i = 1; i < SPEED_CURVE.length; i++) {
    const [x1, y1] = SPEED_CURVE[i];
    if (mph <= x1) {
      const [x0, y0] = SPEED_CURVE[i - 1];
      return y0 + ((mph - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return SPEED_CURVE[SPEED_CURVE.length - 1][1];
}
/** Litres burned per hour while stopped with the engine running. */
export const IDLE_LITRES_PER_HOUR = { petrol: 0.8, diesel: 0.7 };

/** Modelled litres for one moving GPS segment. */
export function segmentLitres(metres, mph, baseMpg) {
  if (!baseMpg || metres <= 0) return 0;
  return ((metres / METRES_PER_MILE) / baseMpg) * LITRES_PER_GALLON * speedFactor(mph);
}
export function idleLitres(seconds, fuel = 'petrol') {
  return (seconds / 3600) * (IDLE_LITRES_PER_HOUR[fuel] || 0.8);
}
/** Instant economy at a steady speed, in mpg. */
export function mpgAtSpeed(mph, baseMpg, k = 1) {
  if (!baseMpg) return null;
  return baseMpg / (speedFactor(mph) * k);
}
/** Which kind of road a speed suggests. */
export function band(mph) {
  return mph < 30 ? 'town' : mph < 55 ? 'aroad' : 'motorway';
}

// ---------- entries ----------
export function sortEntries(entries) {
  return entries.slice().sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)
  );
}
function after(t, a) {
  return t.date > a.date || (t.date === a.date && (t.createdAt || 0) > (a.createdAt || 0));
}
function between(t, a, b) {
  return after(t, a) && after(b, t);
}

/** Raw model litres for a trip (before calibration). */
export function rawTripLitres(trip, car) {
  if (trip.litres != null) return trip.litres;
  const m = officialMpg(car);
  return m ? (trip.miles / m) * LITRES_PER_GALLON : 0;
}

/**
 * Compares fuel actually bought between full fill-ups with what the model predicted for the
 * trips in between. k > 1 means the car uses more than the model says. Also returns the real mpg
 * (odometer miles where available, else logged trip miles).
 */
export function calibrate(car, entries) {
  const all = sortEntries(entries);
  const fills = all.filter((e) => e.kind === 'fill');
  let actual = 0, model = 0, miles = 0, mpgLitres = 0;
  let lastFull = null, since = 0;
  for (const f of fills) {
    if (!lastFull) {
      if (f.full) lastFull = f;
      continue;
    }
    since += f.litres || 0;
    if (f.full) {
      const trips = all.filter((t) => t.kind === 'trip' && between(t, lastFull, f));
      const tripMiles = trips.reduce((s, t) => s + (t.miles || 0), 0);
      const odoMiles = lastFull.odo > 0 && f.odo > lastFull.odo ? f.odo - lastFull.odo : null;
      const m = odoMiles || tripMiles;
      if (m > 0 && since > 0) {
        miles += m;
        mpgLitres += since;
      }
      // Only calibrate the model when the trips cover most of the distance driven.
      const modelL = trips.reduce((s, t) => s + rawTripLitres(t, car), 0);
      const covered = odoMiles ? tripMiles / odoMiles : 1;
      if (modelL > 0 && since > 0 && covered > 0.85) {
        actual += since * Math.min(1, tripMiles / (odoMiles || tripMiles));
        model += modelL;
      }
      lastFull = f;
      since = 0;
    }
  }
  const k = model > 0 ? Math.max(0.6, Math.min(1.6, actual / model)) : 1;
  return {
    k,
    calibrated: model > 0,
    realMpg: mpgLitres > 0 ? miles / (mpgLitres / LITRES_PER_GALLON) : null,
    realMiles: miles,
  };
}

/** Best current mpg: real if known, else official. */
export function currentMpg(car, entries) {
  const c = calibrate(car, entries);
  return c.realMpg || officialMpg(car);
}

/** Latest price paid (p/L), falling back to the car's usual price. */
export function currentPrice(car, entries) {
  const fills = sortEntries(entries).filter((e) => e.kind === 'fill' && e.price > 0);
  if (fills.length) return fills[fills.length - 1].price;
  return car && car.price > 0 ? car.price : null;
}

/** Calibrated litres and cost (£) of a logged trip. */
export function tripFuel(trip, car, entries, cal = calibrate(car, entries), price = currentPrice(car, entries)) {
  const litres = rawTripLitres(trip, car) * cal.k;
  return { litres, cost: price ? (litres * price) / 100 : null };
}

export function litresFor(miles, mpg) {
  if (!miles || !mpg) return 0;
  return (miles / mpg) * LITRES_PER_GALLON;
}
export function costFor(miles, mpg, pencePerLitre) {
  if (!mpg || !pencePerLitre) return null;
  return (litresFor(miles, mpg) * pencePerLitre) / 100;
}
export function pencePerMile(mpg, pencePerLitre) {
  if (!mpg || !pencePerLitre) return null;
  return (LITRES_PER_GALLON / mpg) * pencePerLitre;
}

export function monthSummary(car, entries, monthKey) {
  const cal = calibrate(car, entries);
  const price = currentPrice(car, entries);
  let miles = 0, est = 0, bought = 0, litres = 0;
  for (const e of entries) {
    if ((e.date || '').slice(0, 7) !== monthKey) continue;
    if (e.kind === 'trip') {
      const f = tripFuel(e, car, entries, cal, price);
      miles += e.miles || 0;
      litres += f.litres;
      est += f.cost || 0;
    } else if (e.kind === 'fill') bought += e.spend || 0;
  }
  return { miles, est, bought, litres, mpg: litres > 0 ? miles / (litres / LITRES_PER_GALLON) : null, price, cal };
}

// ---------- odometer ----------
/** All odometer readings (check-ins and fill-ups that recorded one), oldest first. */
export function odoReadings(entries) {
  return sortEntries(entries).filter((e) => (e.kind === 'odo' || e.kind === 'fill') && e.odo > 0);
}
export function needsOdoThisMonth(entries, monthKey) {
  return !odoReadings(entries).some((e) => e.date.slice(0, 7) === monthKey);
}
/**
 * Between the last two odometer readings: real miles vs GPS/logged miles.
 * Returns null until there are two readings.
 */
export function odoCheck(car, entries) {
  const r = odoReadings(entries);
  if (r.length < 2) return null;
  const a = r[r.length - 2], b = r[r.length - 1];
  const actual = b.odo - a.odo;
  if (actual <= 0) return { error: 'The latest reading is lower than the one before. Check for a typo.', a, b };
  const trips = entries.filter((t) => t.kind === 'trip' && between(t, a, b));
  const logged = trips.reduce((s, t) => s + (t.miles || 0), 0);
  const untracked = Math.max(0, actual - logged);
  const mpg = currentMpg(car, entries);
  const price = currentPrice(car, entries);
  return { a, b, actual, logged, coverage: logged / actual, untracked, untrackedCost: costFor(untracked, mpg, price) };
}

// ---------- GPS helpers ----------
/** Distance in metres between two {latitude, longitude} points. */
export function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const gbp = (n) => '£' + (Math.round((n || 0) * 100) / 100).toFixed(2);

export function todayKey(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
