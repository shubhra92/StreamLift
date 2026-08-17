/**
 * Resolve the country for a worker's public tunnel IP at registration time.
 * This deliberately runs on the server and only when an IP changes, never in
 * the browser or during normal worker-list rendering.
 */

const IPINFO_TOKEN = process.env.IPINFO_TOKEN;
const LOOKUP_TIMEOUT_MS = 2_500;

function normalizeCountryCode(value: unknown): string | null {
  if (typeof value !== "string" || !/^[A-Za-z]{2}$/.test(value)) return null;
  return value.toUpperCase();
}

export async function resolveIpCountryCode(ipAddress: unknown): Promise<string | null> {
  if (typeof ipAddress !== "string" || !ipAddress.trim() || !IPINFO_TOKEN) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://ipinfo.io/${encodeURIComponent(ipAddress.trim())}/json?token=${encodeURIComponent(IPINFO_TOKEN)}`,
      { cache: "no-store", signal: controller.signal },
    );
    if (!response.ok) return null;

    const data = await response.json() as { country?: unknown; country_code?: unknown };
    return normalizeCountryCode(data.country_code) ?? normalizeCountryCode(data.country);
  } catch {
    // A tunnel should still register if the optional geo-IP service is unavailable.
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
