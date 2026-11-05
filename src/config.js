// Build-time settings. On GitHub these come from repository variables (Settings › Secrets and
// variables › Actions › Variables), so switching a feature on needs no code change.

/** Shown in feedback messages so we know which version a tester had. */
export const APP_VERSION = '0.5 (test)';

/** Address of the vehicle lookup service (Cloudflare Worker). Empty = lookup switched off. */
export const VEHICLE_LOOKUP_URL = process.env.EXPO_PUBLIC_VEHICLE_LOOKUP_URL || '';
