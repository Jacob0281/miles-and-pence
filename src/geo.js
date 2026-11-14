// Talks to the phone's location.
// On the website we use the browser's geolocation directly: expo-location's web version
// (SDK 58) asks for low accuracy only, hides errors, and matches updates by watch ID,
// which never matches in Safari (WebKit gives watches random IDs), so every update was dropped.
// The native app keeps using expo-location.
import { Platform } from 'react-native';
import * as Location from 'expo-location';

const NATIVE_OPTIONS = { accuracy: Location.Accuracy.BestForNavigation, timeInterval: 1000, distanceInterval: 0 };
const WEB_OPTIONS = { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 };
const WEB_ERRORS = { 1: 'denied', 2: 'unavailable', 3: 'timeout' };

const web = Platform.OS === 'web';
const geolocation = () => (typeof navigator !== 'undefined' ? navigator.geolocation : null);

/** false only when location is known to be blocked; on the web the first watch shows the browser's own prompt. */
export async function requestPermission() {
  if (!web) {
    const p = await Location.requestForegroundPermissionsAsync();
    return p.status === 'granted';
  }
  if (!geolocation()) throw new Error('This browser can’t share your location');
  try {
    const q = navigator.permissions && (await navigator.permissions.query({ name: 'geolocation' }));
    if (q && q.state === 'denied') return false;
  } catch (e) {
    // Some browsers can't report the permission state; the watch will tell us.
  }
  return true;
}

/**
 * Calls onFix({coords, timestamp}) for every position and onError({kind, message}) for problems.
 * kind: 'denied' | 'unavailable' | 'timeout' | 'other'. Resolves to { remove() }.
 */
export async function watchPosition(onFix, onError) {
  if (!web) {
    return Location.watchPositionAsync(NATIVE_OPTIONS, onFix, (reason) => onError({ kind: 'other', message: String(reason) }));
  }
  const geo = geolocation();
  const id = geo.watchPosition(
    (pos) => {
      const c = pos.coords;
      onFix({
        coords: { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, speed: c.speed, heading: c.heading, altitude: c.altitude },
        timestamp: pos.timestamp || Date.now(),
      });
    },
    (err) => onError({ kind: WEB_ERRORS[err && err.code] || 'other', message: (err && err.message) || 'Location error' }),
    WEB_OPTIONS
  );
  return { remove: () => geo.clearWatch(id) };
}
