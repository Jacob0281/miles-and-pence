// Driver score, per-journey feedback and fuel-saving tips.
// Pure functions: a trip's raw measurements are stored, the score is worked out when shown,
// so the formula can be tuned from test data and every past trip updates with it.
import { gbp, idleLitres } from './fuel';

const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const DAY = 864e5;

export function scoreLabel(s) {
  if (s == null) return '';
  return s >= 85 ? 'Excellent' : s >= 70 ? 'Good' : s >= 55 ? 'Fair' : 'Room to improve';
}

/** Only GPS trips long enough to judge, with driving-style data, get a score. */
export function hasScore(trip) {
  return !!(trip && trip.kind === 'trip' && trip.source === 'gps' && trip.behaviour && trip.miles >= 0.5);
}

function money(litres, ctx) {
  if (!ctx.price || !litres) return 0;
  return (litres * (ctx.cal ? ctx.cal.k : 1) * ctx.price) / 100;
}

/**
 * Scores one trip, or an aggregate of trips shaped like one.
 * ctx: { car, cal, price }
 */
export function scoreTrip(trip, ctx, opts = {}) {
  if (!trip || !trip.behaviour) return null;
  const b = trip.behaviour;
  const miles = trip.miles || 0;
  const seconds = Math.max(1, trip.seconds || 1);
  const idleSeconds = trip.idleSeconds || 0;
  const fuel = (ctx.car && ctx.car.fuel) || 'petrol';

  // Smooth driving: sharp starts and stops per 10 miles (short trips judged as if 2 miles).
  const events = (b.harshAccel || 0) + (b.harshBrake || 0);
  const per10 = (events / Math.max(miles, 2)) * 10;
  const smooth = clamp(100 * Math.exp(-per10 / 8)); // 1 per 10 mi ≈ 88, 2 ≈ 78, 5 ≈ 54

  // Speed: share of the distance above 70 mph, with a further knock above 80.
  const over70 = b.over70Miles || 0;
  const share70 = miles > 0 ? over70 / miles : 0;
  const speed = over70 < 0.1 ? 100 : clamp(100 - share70 * 150 - ((b.maxMph || 0) >= 80 ? 10 : 0));

  // Idling: time stopped with the engine running, beyond a normal amount for lights and junctions.
  const idleShare = idleSeconds / seconds;
  const idle = clamp(100 - Math.max(0, idleShare - 0.12) * 180);

  const score = clamp(0.45 * smooth + 0.3 * speed + 0.25 * idle);
  const idleCost = money(idleLitres(idleSeconds, fuel), ctx);
  const speedCost = money(b.over70ExtraLitres || 0, ctx);
  const idleMin = Math.round(idleSeconds / 60);

  const parts = [
    { key: 'smooth', label: 'Smooth driving', score: smooth,
      detail: events === 0 ? 'No sharp starts or stops' : plural(b.harshAccel, 'sharp start') + ', ' + plural(b.harshBrake, 'sharp stop') },
    { key: 'speed', label: 'Speed', score: speed,
      detail: over70 < 0.1 ? 'Nothing above 70 mph' : over70.toFixed(1) + ' mi above 70 mph' + (speedCost >= 0.01 ? ', ' + gbp(speedCost) + ' extra' : '') },
    { key: 'idle', label: 'Idling', score: idle,
      detail: idleSeconds < 30 ? 'Hardly any' : (idleMin ? idleMin + ' min' : Math.round(idleSeconds) + ' sec') + ' stationary' + (idleCost >= 0.01 ? ', ' + gbp(idleCost) : '') },
  ];

  // Tips for this trip, most valuable first.
  const tips = [];
  if (over70 >= 0.5) {
    tips.push({ id: 'speed', weight: speedCost + 0.2, title: 'Ease off on fast roads',
      body: over70.toFixed(1) + ' miles above 70 mph used about ' + gbp(speedCost) + ' more fuel than the same stretch at 60 mph' +
        (opts.aggregate ? ' over the last 30 days' : '') + '. Air resistance climbs quickly with speed. Many roads have lower limits than 70.' });
  }
  if (idleSeconds >= 180 && idleShare > 0.12) {
    tips.push({ id: 'idle', weight: idleCost + 0.1, title: 'Idling cost ' + gbp(idleCost),
      body: idleMin + ' minutes stationary with the engine running' + (opts.aggregate ? ' over the last 30 days' : '') +
        '. Some is traffic you can’t avoid. When parked or waiting for someone, switch off.' });
  }
  if (events >= 2 && per10 >= 2) {
    tips.push({ id: 'smooth', weight: 0.15 + per10 / 100, title: 'Smoother starts and stops',
      body: plural(b.harshAccel, 'sharp start') + ' and ' + plural(b.harshBrake, 'sharp stop') + (opts.aggregate ? ' in the last 30 days' : '') +
        '. Looking further ahead and easing off early to roll up to junctions saves fuel and brakes.' });
  }
  if (!opts.aggregate && miles > 0 && miles < 2) {
    tips.push({ id: 'short', weight: 0.08, title: 'Short trips cost more per mile',
      body: 'An engine uses most fuel in the first few miles from cold. Could a trip like this be walked, cycled or combined with another errand?' });
  }
  if (!opts.aggregate && miles >= 2 && trip.bands && trip.bands.town / miles > 0.7 && smooth >= 70) {
    tips.push({ id: 'town', weight: 0.05, title: 'Town driving: change up early',
      body: 'Most of this trip was in town. In a manual, changing up early and keeping a steady pace helps; in an automatic, a light right foot does the same.' });
  }
  tips.sort((x, y) => y.weight - x.weight);
  if (!tips.length && score >= 85) {
    tips.push({ id: 'good', weight: 0, title: 'Efficient drive',
      body: 'Smooth, steady and little idling. That’s the way to get the most miles from every litre.' });
  }

  return { score, label: scoreLabel(score), parts, tips, idleCost, speedCost, events, per10 };
}

function plural(n, word) {
  n = n || 0;
  return n + ' ' + word + (n === 1 ? '' : 's');
}

/** Adds up scorable trips into one trip-shaped total. */
function aggregate(trips) {
  const t = { kind: 'trip', source: 'gps', miles: 0, seconds: 0, idleSeconds: 0,
    behaviour: { harshAccel: 0, harshBrake: 0, maxMph: 0, over70Miles: 0, over70ExtraLitres: 0 } };
  for (const x of trips) {
    t.miles += x.miles || 0;
    t.seconds += x.seconds || 0;
    t.idleSeconds += x.idleSeconds || 0;
    const b = x.behaviour;
    t.behaviour.harshAccel += b.harshAccel || 0;
    t.behaviour.harshBrake += b.harshBrake || 0;
    t.behaviour.over70Miles += b.over70Miles || 0;
    t.behaviour.over70ExtraLitres += b.over70ExtraLitres || 0;
    t.behaviour.maxMph = Math.max(t.behaviour.maxMph, b.maxMph || 0);
  }
  return t;
}

/** Mile-weighted score of a set of trips. */
function weighted(trips, ctx) {
  let total = 0, miles = 0;
  const parts = { smooth: 0, speed: 0, idle: 0 };
  for (const t of trips) {
    const s = scoreTrip(t, ctx);
    const w = Math.max(t.miles, 0.5);
    total += s.score * w;
    for (const p of s.parts) parts[p.key] += p.score * w;
    miles += w;
  }
  if (!miles) return null;
  return { score: Math.round(total / miles), parts: { smooth: Math.round(parts.smooth / miles), speed: Math.round(parts.speed / miles), idle: Math.round(parts.idle / miles) } };
}

/** Driver score over the last 30 days, with the 30 days before for comparison. */
export function driverScore(entries, ctx, now = Date.now()) {
  const trips = entries.filter(hasScore);
  const at = (t) => new Date(t.date + 'T12:00:00').getTime();
  const recent = trips.filter((t) => now - at(t) <= 30 * DAY);
  const before = trips.filter((t) => now - at(t) > 30 * DAY && now - at(t) <= 60 * DAY);
  if (!recent.length) return null;
  const cur = weighted(recent, ctx);
  const prev = weighted(before, ctx);
  const agg = scoreTrip(aggregate(recent), ctx, { aggregate: true });
  const tips = agg.tips.filter((t) => t.id !== 'good');
  const shortShare = recent.filter((t) => t.miles < 2).length / recent.length;
  if (recent.length >= 4 && shortShare >= 0.3) {
    tips.push({ id: 'short', weight: 0.08, title: 'Lots of short trips',
      body: Math.round(shortShare * 100) + '% of your trips were under 2 miles. Engines use most fuel from cold, so combining errands into one round trip saves money.' });
  }
  const weakest = Object.entries(cur.parts).sort((a, b) => a[1] - b[1])[0];
  return {
    score: cur.score,
    label: scoreLabel(cur.score),
    parts: cur.parts,
    trips: recent.length,
    miles: recent.reduce((s, t) => s + t.miles, 0),
    trend: prev ? cur.score - prev.score : null,
    weakest: weakest && weakest[1] < 85 ? weakest[0] : null,
    savings: { idle: agg.idleCost, speed: agg.speedCost },
    tips,
  };
}

/** General fuel-saving advice, grouped. */
export const TIP_LIBRARY = [
  { group: 'Before you set off', tips: [
    { title: 'Check your tyre pressures', body: 'Under-inflated tyres grip the road harder and use more fuel. Check monthly; the right pressures are in your handbook or inside the driver’s door.' },
    { title: 'Take off empty roof boxes and racks', body: 'They add drag, which costs most at motorway speeds.' },
    { title: 'Clear out the boot', body: 'Extra weight takes more fuel to get moving, especially in stop-start driving.' },
    { title: 'Combine short trips', body: 'Engines use most fuel in the first few miles from cold. One round trip beats several short ones.' },
  ] },
  { group: 'On the road', tips: [
    { title: 'Look ahead and keep rolling', body: 'Easing off early and coasting up to lights and junctions saves fuel and wear on brakes.' },
    { title: 'Change up early', body: 'In a manual, change up at around 2,000 rpm in a diesel or 2,500 rpm in a petrol. In an automatic, accelerate gently.' },
    { title: 'Keep fast-road speeds steady', body: 'Fuel use climbs quickly above 60 mph because of air resistance. Cruise control helps on clear, flat roads.' },
    { title: 'Air con or windows?', body: 'Air con uses fuel. Around town, open windows are usually cheaper; at motorway speeds, closed windows and air con are usually better.' },
    { title: 'Don’t idle when parked', body: 'If you’re waiting for someone, switch off. Engines also warm up faster by driving gently than by idling on the drive.' },
  ] },
  { group: 'At the pump', tips: [
    { title: 'Compare nearby prices', body: 'Prices can differ by several pence a litre between stations a mile apart. The app shows live prices for stations near you.' },
    { title: 'Standard fuel is usually best value', body: 'Premium fuel costs more. Unless your handbook recommends it, standard fuel is normally the better buy.' },
  ] },
];
