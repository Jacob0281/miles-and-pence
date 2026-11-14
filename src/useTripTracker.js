import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { requestPermission, watchPosition } from './geo';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { band, haversine, idleLitres, METRES_PER_MILE, segmentLitres } from './fuel';
import { fetchStations } from './stations';

const MAX_ACCURACY_M = 35; // ignore fixes worse than this
const MIN_STEP_M = 6; // ignore GPS jitter smaller than this
const MAX_SPEED_MS = 70; // ~155 mph: anything faster is a GPS jump
const STILL_MS = 0.9; // below ~2 mph counts as stopped
const STOP_RADIUS_M = 25; // still "stopped" while within this of where you stopped
const STOP_SECONDS = 40; // stopped this long at a station → ask about fuel
const STATION_RADIUS_M = 60; // how close counts as "at" a station
const STATION_REFRESH_M = 2500; // reload nearby stations after moving this far
const KEEP_AWAKE_TAG = 'trip';
const STILL_JITTER_M = 3; // without a reported speed, moving less than this between fixes = stopped
// Sharp changes of speed. Starting points (about 0.3 g); the test data will tell us if they need tuning.
const HARSH_ACCEL_MS2 = 2.8;
const HARSH_BRAKE_MS2 = 3.2;
const EVENT_COOLDOWN_MS = 4000;
// When GPS pauses (screen locked, app in the background) and later resumes somewhere else,
// fill the gap with the straight-line distance scaled up for real roads.
const GAP_SECONDS = 20; // a pause longer than this counts as a gap
const GAP_MIN_M = 100; // ...if you moved at least this far
const ROAD_FACTOR = 1.25; // roads are ~25% longer than a straight line on average

/**
 * Tracks one trip with the phone's GPS while the app is open.
 * model: { baseMpg, fuel } — used to estimate litres from speed as you drive.
 */
export function useTripTracker(model) {
  const [status, setStatus] = useState('idle'); // idle | starting | tracking | denied | error
  const [error, setError] = useState(null);
  const [gpsError, setGpsError] = useState(null); // { kind: 'denied'|'unavailable'|'timeout'|'other', message }
  const gpsErrorRef = useRef(null);
  const onGeoError = useCallback((e) => { gpsErrorRef.current = e; setGpsError(e); }, []);
  const [miles, setMiles] = useState(0);
  const [litres, setLitres] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [speedMph, setSpeedMph] = useState(0);
  const [accuracy, setAccuracy] = useState(null);
  const [station, setStation] = useState(null); // station you seem to be stopped at
  const [stationCount, setStationCount] = useState(null);
  const [stationError, setStationError] = useState(null);
  const [stationSource, setStationSource] = useState(null); // 'fuelfinder' (live prices) | 'osm'
  const [gapMiles, setGapMiles] = useState(0); // miles estimated across GPS pauses
  const [lastGap, setLastGap] = useState(null); // { miles, minutes } of the most recent gap

  const r = useRef({});
  const modelRef = useRef(model);
  modelRef.current = model;
  const sub = useRef(null);
  const timer = useRef(null);
  const awake = useRef(false);

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

  const loadStations = useCallback(async (p) => {
    const s = r.current;
    if (s.stationsLoading) return;
    s.stationsLoading = true;
    s.stationsAt = p;
    try {
      const res = await fetchStations(p);
      s.stations = res.stations;
      setStationCount(res.stations.length);
      setStationSource(res.source);
      setStationError(null);
    } catch (e) {
      s.stationsAt = null; // try again on a later fix
      setStationError('Couldn’t load nearby fuel stations');
    } finally {
      s.stationsLoading = false;
    }
  }, []);

  const onFix = useCallback((loc) => {
    const s = r.current;
    const c = loc.coords;
    const p = { latitude: c.latitude, longitude: c.longitude, t: loc.timestamp || Date.now() };
    setAccuracy(c.accuracy != null ? Math.round(c.accuracy) : null);
    if (gpsErrorRef.current) { gpsErrorRef.current = null; setGpsError(null); }
    if (c.accuracy != null && c.accuracy > MAX_ACCURACY_M) return;
    const m = modelRef.current || {};
    if (!s.startPoint) s.startPoint = p;
    if (!s.stationsAt || haversine(s.stationsAt, p) > STATION_REFRESH_M) loadStations(p);

    const prev = s.prevFix;
    s.prevFix = p;
    const reported = c.speed != null && c.speed >= 0 ? c.speed : null;

    // Driving style: sharp acceleration / braking from the change in speed between fixes.
    const sample = (v, okForEvents) => {
      // Without a reported speed, speeds worked out from position are too rough at a crawl.
      const tooRough = reported == null && Math.max(v, s.v) < 8;
      if (okForEvents && !tooRough && s.vT != null) {
        const dtv = (p.t - s.vT) / 1000;
        if (dtv >= 0.8 && dtv <= 3 && p.t - (s.lastEventT || 0) > EVENT_COOLDOWN_MS) {
          const a = (v - s.v) / dtv;
          if (a >= HARSH_ACCEL_MS2) { s.harshAccel += 1; s.lastEventT = p.t; }
          else if (a <= -HARSH_BRAKE_MS2) { s.harshBrake += 1; s.lastEventT = p.t; }
        }
      }
      s.v = v;
      s.vT = okForEvents ? p.t : null;
    };

    if (s.lastPos) {
      const d = haversine(s.lastPos, p);
      const dt = Math.max(1, (p.t - s.lastPos.t) / 1000);
      if (d / dt > MAX_SPEED_MS) return; // GPS jump
      if (d >= MIN_STEP_M) {
        const pause = prev ? (p.t - prev.t) / 1000 : 0;
        const gap = pause > GAP_SECONDS && d >= GAP_MIN_M;
        const dist = gap ? d * ROAD_FACTOR : d;
        const ms = gap ? dist / dt : reported != null ? reported : d / dt;
        const mph = ms * 2.23694;
        s.metres += dist;
        s.litres += segmentLitres(dist, mph, m.baseMpg);
        s.bands[band(mph)] += dist / METRES_PER_MILE;
        s.lastPos = p;
        if (gap) {
          s.gapMetres += dist;
          setGapMiles(s.gapMetres / METRES_PER_MILE);
          setLastGap({ miles: dist / METRES_PER_MILE, minutes: Math.round(pause / 60), at: Date.now() });
          sample(reported != null ? reported : 0, false); // speed across a gap is unknown
        } else {
          sample(ms, true);
          if (dt <= 3 && mph > s.maxMph) s.maxMph = mph;
          if (mph > 70) {
            // Extra fuel this stretch used compared with doing it at 60 mph.
            s.over70Metres += dist;
            s.over70Extra += Math.max(0, segmentLitres(dist, mph, m.baseMpg) - segmentLitres(dist, 60, m.baseMpg));
          }
        }
        setMiles(s.metres / METRES_PER_MILE);
        setLitres(s.litres);
        setSpeedMph(gap ? (reported != null ? reported * 2.23694 : mph) : mph);
      } else if (prev && (reported != null ? reported < STILL_MS : haversine(prev, p) < STILL_JITTER_M)) {
        const idle = Math.min(30, (p.t - prev.t) / 1000);
        s.idleSeconds += idle;
        s.litres += idleLitres(idle, m.fuel);
        setLitres(s.litres);
        setSpeedMph(reported != null ? reported * 2.23694 : 0);
        sample(reported != null ? reported : 0, true);
      }
    } else {
      s.lastPos = p;
    }

    // Are we stopped at a fuel station?
    if (!s.anchor || haversine(s.anchor, p) > STOP_RADIUS_M) {
      s.anchor = p;
      if (s.asked && haversine(s.asked, p) > 150) s.asked = null; // left that station
      setStation(null);
      return;
    }
    const stoppedFor = (p.t - s.anchor.t) / 1000;
    if (stoppedFor >= STOP_SECONDS && !s.asked && s.stations) {
      let best = null, bestD = Infinity;
      for (const st of s.stations) {
        const d = haversine(st, p);
        if (d < bestD) { best = st; bestD = d; }
      }
      if (best && bestD <= STATION_RADIUS_M) {
        s.asked = best;
        setStation(best);
      }
    }
  }, [loadStations]);

  const start = useCallback(async () => {
    setError(null);
    setStatus('starting');
    try {
      setGpsError(null);
      if (!(await requestPermission())) {
        setStatus('denied');
        return false;
      }
      const keepStations = r.current.stations;
      const keepAt = r.current.stationsAt;
      r.current = { metres: 0, litres: 0, idleSeconds: 0, gapMetres: 0, bands: { town: 0, aroad: 0, motorway: 0 },
        harshAccel: 0, harshBrake: 0, maxMph: 0, over70Metres: 0, over70Extra: 0, v: 0, vT: null, lastEventT: 0,
        stations: keepStations, stationsAt: keepAt, startedAt: Date.now() };
      setMiles(0); setLitres(0); setElapsed(0); setSpeedMph(0); setStation(null); setGapMiles(0); setLastGap(null); setAccuracy(null);
      try {
        await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
        awake.current = true;
      } catch (e) {}
      timer.current = setInterval(() => setElapsed(Math.round((Date.now() - r.current.startedAt) / 1000)), 1000);
      sub.current = await watchPosition(onFix, onGeoError);
      setStatus('tracking');
      return true;
    } catch (e) {
      cleanup();
      setError(e && e.message ? e.message : String(e));
      setStatus('error');
      return false;
    }
  }, [onFix, onGeoError, cleanup]);

  /** Stops tracking and returns the trip. */
  const stop = useCallback(() => {
    cleanup();
    const s = r.current;
    const round = (n, d = 100) => Math.round(n * d) / d;
    const result = {
      miles: round(s.metres / METRES_PER_MILE),
      litres: round(s.litres, 1000),
      seconds: Math.round((Date.now() - s.startedAt) / 1000),
      idleSeconds: Math.round(s.idleSeconds),
      gapMiles: round(s.gapMetres / METRES_PER_MILE),
      bands: { town: round(s.bands.town), aroad: round(s.bands.aroad), motorway: round(s.bands.motorway) },
      behaviour: {
        v: 1,
        harshAccel: s.harshAccel,
        harshBrake: s.harshBrake,
        maxMph: Math.round(s.maxMph),
        over70Miles: round(s.over70Metres / METRES_PER_MILE),
        over70ExtraLitres: round(s.over70Extra, 1000),
      },
      start: s.startPoint || null,
      end: s.lastPos || null,
    };
    setStatus('idle');
    setStation(null);
    return result;
  }, [cleanup]);

  // Coming back to the app mid-trip: the browser may have dropped GPS and the screen-awake
  // lock while it was hidden, so start both again. The next fix fills the gap.
  const statusRef = useRef(status);
  statusRef.current = status;
  const resume = useCallback(async () => {
    if (statusRef.current !== 'tracking') return;
    try {
      if (sub.current) sub.current.remove();
      sub.current = await watchPosition(onFix, onGeoError);
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    }
    try {
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
      awake.current = true;
    } catch (e) {}
  }, [onFix, onGeoError]);
  useEffect(() => {
    const subApp = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
    });
    return () => subApp.remove();
  }, [resume]);

  const dismissStation = useCallback(() => setStation(null), []);

  /** Closest known station to where you are now (within `max` metres), or null. */
  const nearestStation = useCallback((max = 150) => {
    const s = r.current;
    const here = s.prevFix || s.lastPos;
    if (!here || !s.stations) return null;
    let best = null, bestD = Infinity;
    for (const st of s.stations) {
      const d = haversine(st, here);
      if (d < bestD) { best = st; bestD = d; }
    }
    return bestD <= max ? best : null;
  }, []);

  return { status, error, gpsError, miles, litres, elapsed, speedMph, accuracy, station, gapMiles, lastGap, stationCount, stationSource, stationError, start, stop, dismissStation, nearestStation };
}
