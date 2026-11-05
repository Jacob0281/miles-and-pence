// Build-time settings. On GitHub these come from repository variables (Settings › Secrets and
// variables › Actions › Variables), so switching a feature on needs no code change.

/** Shown in feedback messages so we know which version a tester had. */
export const APP_VERSION = '0.6 (test)';

/**
 * Address of the Miles & Pence service (Cloudflare Worker): reg lookup and test data sharing.
 * Empty = both switched off (sharing waits and sends everything once it's set).
 */
export const API_URL = (process.env.EXPO_PUBLIC_API_URL || process.env.EXPO_PUBLIC_VEHICLE_LOOKUP_URL ||
  'https://miles-and-pence-lookup.milesandpence.workers.dev').replace(/\/$/, '');
export const VEHICLE_LOOKUP_URL = API_URL;

/** Who testers contact about their data. Empty = "the person who invited you". */
export const CONTACT = process.env.EXPO_PUBLIC_CONTACT || '';

/** Bump when the privacy notice changes in a way testers should see again. */
export const NOTICE_VERSION = 2;
export const NOTICE_DATE = '5 November 2026';
export const TEST_END = '3 December 2026';
export const DELETE_BY = '31 March 2027';
