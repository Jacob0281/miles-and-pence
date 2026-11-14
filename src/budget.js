// Monthly fuel budget: will this month's fuel come in on budget?
// Forecast = spent so far this month + your recent daily rate × the days left.
// The daily rate comes from the last 28 days (spilling into last month), so it is steady
// from the 1st of the month rather than swinging on the first trip or two.
import { calibrate, currentPrice, monthSummary, pencePerMile, todayKey, tripFuel } from './fuel';

const DAY = 864e5;
const WINDOW_DAYS = 28;
const MIN_TRIPS = 3;

const at = (dateKey) => new Date(dateKey + 'T12:00:00').getTime();

/**
 * Returns null without a budget. Otherwise:
 * { budget, spent, forecast, onTrack, close, over, left, daysLeft, perDay, ready, alreadyOver, milesLeft }
 */
export function budgetForecast(car, entries, budget, mpg, now = new Date()) {
  if (!budget || budget <= 0) return null;
  const monthKey = todayKey(now).slice(0, 7);
  const s = monthSummary(car, entries, monthKey);
  const cal = calibrate(car, entries);
  const price = currentPrice(car, entries);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = daysInMonth - now.getDate();

  // Daily rate from the last 28 days of trips, or since the first trip if that is more recent (at least a week).
  const today = at(todayKey(now));
  const trips = entries.filter((e) => e.kind === 'trip' && e.date && today - at(e.date) < WINDOW_DAYS * DAY);
  const allTrips = entries.filter((e) => e.kind === 'trip' && e.date);
  const first = allTrips.reduce((m, e) => Math.min(m, at(e.date)), today);
  const span = Math.max(7, Math.min(WINDOW_DAYS, Math.round((today - first) / DAY) + 1));
  const recentCost = trips.reduce((sum, e) => sum + (tripFuel(e, car, entries, cal, price).cost || 0), 0);
  const perDay = recentCost / span;
  const ready = trips.length >= MIN_TRIPS;

  const spent = s.est;
  const forecast = spent + perDay * daysLeft;
  const left = budget - spent;
  const ppm = pencePerMile(mpg, price);
  return {
    budget,
    spent,
    forecast,
    ready,
    daysLeft,
    perDay,
    onTrack: forecast <= budget,
    close: forecast <= budget && forecast > budget * 0.95,
    over: Math.max(0, forecast - budget),
    alreadyOver: spent > budget,
    left,
    perWeekLeft: daysLeft > 0 ? (Math.max(0, left) / daysLeft) * 7 : 0,
    milesLeft: ppm && left > 0 ? (left * 100) / ppm : 0,
  };
}
