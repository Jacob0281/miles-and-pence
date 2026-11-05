// Nearby fuel stations from OpenStreetMap (Overpass API): free, no key, works from a browser.
// Swap for the government Fuel Finder feed (which also has prices) once a backend exists.

const ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

function label(tags = {}) {
  const brand = tags.brand || tags.operator;
  const name = tags.name;
  let base = name || brand || 'Fuel station';
  if (brand && name && !name.toLowerCase().includes(brand.toLowerCase())) base = brand + ' ' + name;
  const place = tags['addr:city'] || tags['addr:town'] || tags['addr:suburb'] || tags['addr:village'];
  return place && !base.includes(place) ? base + ', ' + place : base;
}

/** Fuel stations within `radius` metres of a point: [{id, name, latitude, longitude}]. */
export async function fetchStations({ latitude, longitude }, radius = 4000) {
  const q = `[out:json][timeout:20];nwr["amenity"="fuel"](around:${radius},${latitude.toFixed(5)},${longitude.toFixed(5)});out center tags;`;
  let lastErr;
  for (const url of ENDPOINTS) {
    try {
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = ctrl ? setTimeout(() => ctrl.abort(), 20000) : null;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(q),
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (t) clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const json = await res.json();
      return (json.elements || [])
        .map((el) => {
          const lat = el.lat != null ? el.lat : el.center && el.center.lat;
          const lon = el.lon != null ? el.lon : el.center && el.center.lon;
          if (lat == null || lon == null) return null;
          return { id: 'osm-' + el.type + '-' + el.id, name: label(el.tags), latitude: lat, longitude: lon };
        })
        .filter(Boolean);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Could not load fuel stations');
}
