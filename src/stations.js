// Nearby fuel stations.
// 1st choice: the live Fuel Finder list (with prices) that the site publishes as prices.json.
// Fallback: OpenStreetMap (Overpass API) — station locations only, no prices.
import { Platform } from 'react-native';
import { haversine } from './fuel';

const PRICES_URL = Platform.OS === 'web' ? 'prices.json' : 'https://jacob0281.github.io/miles-and-pence/prices.json';
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const REFRESH_MS = 20 * 60 * 1000;

let cache = null; // { at, data }

/** The full Fuel Finder list, or null if it isn't published yet. */
export async function loadPriceList(force = false) {
  if (!force && cache && Date.now() - cache.at < REFRESH_MS) return cache.data;
  try {
    const res = await fetch(PRICES_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    const data = {
      fetchedAt: json.fetchedAt,
      stations: (json.stations || []).map((s) => ({
        id: 'ff-' + s.id, name: [s.n, s.t && s.t.split(' ')[0]].filter(Boolean).join(', '),
        latitude: s.la, longitude: s.lo, prices: s.p || {}, updated: s.u || json.fetchedAt, closed: !!s.x,
      })),
    };
    cache = { at: Date.now(), data };
    return data;
  } catch (e) {
    cache = { at: Date.now(), data: null };
    return null;
  }
}

/** Which Fuel Finder fuel code matches the car. */
export function fuelCodeFor(car) {
  const diesel = car && car.fuel === 'diesel';
  const premium = car && car.grade === 'premium';
  if (diesel) return premium ? ['SDV', 'SUPER_DIESEL', 'B7_PREMIUM'] : ['B7', 'B7_STANDARD', 'DIESEL'];
  return premium ? ['E5', 'SUPER_UNLEADED'] : ['E10', 'UNLEADED', 'E5'];
}

/** Live price (p/L) for this car at a station, or null. */
export function livePrice(station, car) {
  if (!station || !station.prices) return null;
  const keys = Object.keys(station.prices);
  for (const code of fuelCodeFor(car)) {
    const k = keys.find((x) => x.toUpperCase() === code || x.toUpperCase().startsWith(code + '_'));
    if (k && station.prices[k] > 0) return station.prices[k];
  }
  return null;
}

function osmLabel(tags = {}) {
  const brand = tags.brand || tags.operator;
  const name = tags.name;
  let base = name || brand || 'Fuel station';
  if (brand && name && !name.toLowerCase().includes(brand.toLowerCase())) base = brand + ' ' + name;
  const place = tags['addr:city'] || tags['addr:town'] || tags['addr:suburb'] || tags['addr:village'];
  return place && !base.includes(place) ? base + ', ' + place : base;
}

async function fetchOsm({ latitude, longitude }, radius) {
  const q = `[out:json][timeout:20];nwr["amenity"="fuel"](around:${radius},${latitude.toFixed(5)},${longitude.toFixed(5)});out center tags;`;
  let lastErr;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return (json.elements || []).map((el) => {
        const lat = el.lat != null ? el.lat : el.center && el.center.lat;
        const lon = el.lon != null ? el.lon : el.center && el.center.lon;
        if (lat == null || lon == null) return null;
        return { id: 'osm-' + el.type + '-' + el.id, name: osmLabel(el.tags), latitude: lat, longitude: lon };
      }).filter(Boolean);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not load fuel stations');
}

/**
 * Fuel stations within `radius` metres: [{id, name, latitude, longitude, prices?, updated?}].
 * Also reports where the list came from.
 */
export async function fetchStations(p, radius = 4000) {
  const list = await loadPriceList();
  if (list && list.stations.length) {
    const near = list.stations.filter((s) => !s.closed && haversine(s, p) <= radius);
    return { source: 'fuelfinder', fetchedAt: list.fetchedAt, stations: near };
  }
  return { source: 'osm', stations: await fetchOsm(p, radius) };
}
