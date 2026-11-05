// Build-time settings. On GitHub these come from repository variables (Settings › Secrets and
// variables › Actions › Variables), so switching a feature on needs no code change.

/** Address of the vehicle lookup service (Cloudflare Worker). Empty = lookup switched off. */
export const VEHICLE_LOOKUP_URL = process.env.EXPO_PUBLIC_VEHICLE_LOOKUP_URL || '';
