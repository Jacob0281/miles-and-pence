import { useCallback, useEffect, useRef, useState } from 'react';
import * as Location from 'expo-location';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { haversine, METRES_PER_MILE } from './fuel';

const MAX_ACCURACY_M = 35; // ignore fixes worse than this
const MIN_STEP_M = 6; // ignore GPS jitter smaller than this
const MAX_SPEED_MS = 70; // ~155 mph: anything faster is a GPS jump
const STOP_RADIUS_M = 30; // still "stopped" if within this of where you stopped
const STOP_SECONDS = 60; // stopped this long near a saved station → ask about fuel
const SPOT_RADIUS_M = 80; // how close counts as "at" a saved station
const KEEP_AWAKE_TAG = 'trip';

/**
 * Tracks one trip with the phone's GPS while the app is open.
 * spots: saved fuel stations [{id, name, latitude, longitude}]
 */
export function useTripTracker(spots) {
  const [status, setStatus] = useState('idle'); // idle | starting | tracking | denied | error
  const [error, setError] = useState(null);
  const [miles, setMiles] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [speedMph, setSpeedMph] = useState(0);
  const [accuracy, setAccuracy] = useState(null);
  const [atSpot, setAtSpot] = useState(null);

  const sub = useRef(null);
  const timer = useRef(null);
  const last = useRef(null);
  const metres = useRef(0);
  const startedAt = useRef(0);
  const startPoint = useRef(null);
  const anchor = useRef(null);
  const promptedSpot = useRef(null);
  const awake = useRef(false);
  const spotsRef = useRef(spots);
  spotsRef.current = spots;

  const cleanup = useCallback(() => {
    if (sub.current) sub.current.remove();
    sub.current = null;
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    if (awake.current) {
      awake.current = false;
      try {
        Promise.resolve(deactivateKeepAwake(KEEP_AWAKE_TAG)).catch(() => {});
      } catch (e) {}
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const onFix = useCallback((loc) => {
    const c = loc.coords;
    const p = { latitude: c.latitude, longitude: c.longitude, t: loc.timestamp || Date.now() };
    setAccuracy(c.accuracy != null ? Math.round(c.accuracy) : null);
    if (c.accuracy != null && c.accuracy > MAX_ACCURACY_M) return;
    if (!startPoint.current) startPoint.current = p;

    if (c.speed != null && c.speed >= 0) setSpeedMph(c.speed * 2.23694);

    if (last.current) {
      const d = haversine(last.current, p);
      const dt = Math.max(1, (p.t - last.current.t) / 1000);
      if (d / dt > MAX_SPEED_MS) return; // GPS jump
      if (d >= MIN_STEP_M) {
        metres.current += d;
        setMiles(metres.current / METRES_PER_MILE);
        last.current = p;
        if (c.speed == null) setSpeedMph((d / dt) * 2.23694);
      }
    } else {
      last.current = p;
    }

    // Stop detection near a saved fuel station.
    if (!anchor.current || haversine(anchor.current, p) > STOP_RADIUS_M) {
      anchor.current = p;
      promptedSpot.current = null;
      setAtSpot(null);
      return;
    }
    const stoppedFor = (p.t - anchor.current.t) / 1000;
    if (stoppedFor >= STOP_SECONDS && !promptedSpot.current) {
      const near = (spotsRef.current || []).find((s) => haversine(s, p) <= SPOT_RADIUS_M);
      if (near) {
        promptedSpot.current = near.id;
        setAtSpot(near);
      }
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStatus('starting');
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setStatus('denied');
        return false;
      }
      metres.current = 0;
      last.current = null;
      anchor.current = null;
      startPoint.current = null;
      promptedSpot.current = null;
      setMiles(0);
      setElapsed(0);
      setSpeedMph(0);
      setAtSpot(null);
      startedAt.current = Date.now();
      try {
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
        awake.current = true;
      } catch (e) {}
      timer.current = setInterval(() => setElapsed(Math.round((Date.now() - startedAt.current) / 1000)), 1000);
      sub.current = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 },
        onFix,
        (reason) => setError(String(reason))
      );
      setStatus('tracking');
      return true;
    } catch (e) {
      cleanup();
      setError(e && e.message ? e.message : String(e));
      setStatus('error');
      return false;
    }
  }, [onFix, cleanup]);

  /** Stops tracking and returns the trip so far. */
  const stop = useCallback(() => {
    cleanup();
    const result = {
      miles: Math.round((metres.current / METRES_PER_MILE) * 100) / 100,
      seconds: Math.round((Date.now() - startedAt.current) / 1000),
      startedAt: startedAt.current,
      start: startPoint.current,
      end: last.current,
    };
    setStatus('idle');
    setAtSpot(null);
    return result;
  }, [cleanup]);

  const dismissSpot = useCallback(() => setAtSpot(null), []);

  return { status, error, miles, elapsed, speedMph, accuracy, atSpot, start, stop, dismissSpot };
}

/** One-off position, e.g. to save a fuel station. */
export async function currentPosition() {
  const perm = await Location.requestForegroundPermissionsAsync();
  if (perm.status !== 'granted') throw new Error('Location permission was not given');
  const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
  return { latitude: loc.coords.latitude, longitude: loc.coords.longitude, accuracy: loc.coords.accuracy };
}
