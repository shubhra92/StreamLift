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
 *   If the provider also redirects browser CORS preflights (so a bypass header
 *   cannot be sent), add it to ``requiresSameOriginProxy`` as well.
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

  if (host.endsWith(".tunnl.gg")) {
    // Free tunnl.gg tunnels redirect browser CORS preflights (OPTIONS) to
    // their warning page, and a preflight cannot carry this header. The web
    // client therefore uses the same-origin proxy (requiresSameOriginProxy
    // below); non-browser callers can still call the tunnel directly.
    return { "tunnl-skip-browser-warning": "1" };
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

/**
 * Returns true when the web client must route worker traffic through the
 * same-origin Next.js proxy instead of calling the tunnel directly.
 *
 * Free tunnl.gg tunnels redirect every browser-user-agent OPTIONS request to
 * their warning page before the worker's CORS layer sees it. Browsers cannot
 * attach ``tunnl-skip-browser-warning`` to a preflight, so the only free-tier
 * fix is to proxy the request server-side (see
 * ``app/api/worker/[workerId]/proxy/[...path]/route.ts``). tunnl.gg Pro's
 * ``cors=*`` option answers preflights at the edge and removes the need for
 * this proxy.
 */
export function requiresSameOriginProxy(tunnelUrl: string): boolean {
  try {
    return new URL(tunnelUrl).hostname.toLowerCase().endsWith(".tunnl.gg");
  } catch {
    return false;
  }
}
