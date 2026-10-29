/**
 * tunnelHeaders.ts — single source of truth for tunnel provider bypass headers.
 *
 * Every tunnel provider that shows a browser interstitial or screening page
 * needs a specific header to allow automated API access. This file maps URL
 * patterns to the required headers so no other file ever needs to know which
 * provider is in use.
 *
 * Adding a new provider:
 *   Add one `host.endsWith(...)` branch in ``getTunnelBypassHeaders`` below.
 *   Nothing else needs to change — the backend returns the headers to all clients
 *   (web frontend, sync-worker, Kotlin TV) dynamically.
 */

/**
 * Returns the HTTP headers required to bypass a tunnel provider's browser
 * interstitial page for the given worker URL.
 *
 * - Pinggy free tunnels:  ``X-Pinggy-No-Screen: 1``
 * - Serveo free tunnels:  ``Bypass-Tunnel-Reminder: true``
 * - zrok free tier:       ``skip_zrok_interstitial: 1``
 * - All other URLs:       ``{}`` (no extra headers needed)
 */
export function getTunnelBypassHeaders(
  tunnelUrl: string,
): Record<string, string> {
  let host: string;
  try {
    host = new URL(tunnelUrl).hostname.toLowerCase();
  } catch {
    return {};
  }

  if (
    host.endsWith(".pinggy-free.link") ||
    host.endsWith(".free.pinggy.net") ||
    host.endsWith(".free.pinggy.online")
  ) {
    return { "X-Pinggy-No-Screen": "1" };
  }

  if (
    host.endsWith(".serveousercontent.com") ||
    host.endsWith(".serveo.net")
  ) {
    return { "Bypass-Tunnel-Reminder": "true" };
  }

  if (
    host.endsWith(".share.zrok.io") ||
    host.endsWith(".shares.zrok.io")
  ) {
    // zrok enables the interstitial per account on free-tier public shares,
    // regardless of the share's --open permission mode. Without this header
    // zrok returns the interstitial HTML (no CORS headers) instead of proxying
    // the request to the worker.
    return { "skip_zrok_interstitial": "1" };
  }

  return {};
}

/**
 * Returns true when the URL requires tunnel bypass headers for browser requests
 * (i.e. the provider shows an interstitial that automated clients must bypass).
 *
 * Used by media-player components to decide whether hls.js / fetch need the
 * extra headers on HLS segment, subtitle, and thumbnail requests.
 */
export function isTunnelInterstitialUrl(url: string): boolean {
  return Object.keys(getTunnelBypassHeaders(url)).length > 0;
}
