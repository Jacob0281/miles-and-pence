// Pure fuel maths. No React, no storage — easy to test and reuse in the native app.

export const LITRES_PER_GALLON = 4.54609; // UK gallon

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

export function sortEntries(entries) {
  return entries.slice().sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdAt || 0) - (b.createdAt || 0)
  );
}

function isBetween(t, a, b) {
  const after = t.date > a.date || (t.date === a.date && t.createdAt > a.createdAt);
  const before = t.date < b.date || (t.date === b.date && t.createdAt < b.createdAt);
  return after && before;
}

/**
 * Real-world mpg using the full-tank method: between two full fill-ups, the fuel
 * bought at the second (and any partial fills in between) is what the miles used.
 * Miles come from the odometer when both readings exist, otherwise from logged trips.
 */
export function realMpg(entries) {
  const all = sortEntries(entries);
  const fills = all.filter((e) => e.kind === 'fill');
  let miles = 0;
  let litres = 0;
  let lastFull = null;
  let since = 0;
  for (const f of fills) {
    if (!lastFull) {
      if (f.full) lastFull = f;
      continue;
    }
    since += f.litres || 0;
    if (f.full) {
      let m;
      if (lastFull.odo > 0 && f.odo > lastFull.odo) m = f.odo - lastFull.odo;
      else m = all.filter((t) => t.kind === 'trip' && isBetween(t, lastFull, f)).reduce((s, t) => s + (t.miles || 0), 0);
      if (m > 0 && since > 0) {
        miles += m;
        litres += since;
      }
      lastFull = f;
      since = 0;
    }
  }
  return litres > 0 ? { mpg: miles / (litres / LITRES_PER_GALLON), miles } : null;
}

export function currentMpg(car, entries) {
  const r = realMpg(entries);
  return r ? r.mpg : officialMpg(car);
}

/** Latest price paid (p/L), falling back to the car's usual price. */
export function currentPrice(car, entries) {
  const fills = sortEntries(entries).filter((e) => e.kind === 'fill' && e.price > 0);
  if (fills.length) return fills[fills.length - 1].price;
  return car && car.price > 0 ? car.price : null;
}

export function litresFor(miles, mpg) {
  if (!miles || !mpg) return 0;
  return (miles / mpg) * LITRES_PER_GALLON;
}

/** Cost in £ of driving `miles`, or null if mpg or price is missing. */
export function costFor(miles, mpg, pencePerLitre) {
  if (!mpg || !pencePerLitre) return null;
  return (litresFor(miles, mpg) * pencePerLitre) / 100;
}

export function pencePerMile(mpg, pencePerLitre) {
  if (!mpg || !pencePerLitre) return null;
  return (LITRES_PER_GALLON / mpg) * pencePerLitre;
}

export function monthSummary(car, entries, monthKey) {
  const mpg = currentMpg(car, entries);
  const price = currentPrice(car, entries);
  let miles = 0;
  let est = 0;
  let bought = 0;
  for (const e of entries) {
    if ((e.date || '').slice(0, 7) !== monthKey) continue;
    if (e.kind === 'trip') {
      miles += e.miles || 0;
      est += costFor(e.miles, mpg, price) || 0;
    } else bought += e.spend || 0;
  }
  return { miles, est, bought, mpg, price };
}

// ---- GPS helpers ----

export const METRES_PER_MILE = 1609.344;

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
