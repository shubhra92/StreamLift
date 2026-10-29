/**
 * tunnelConfig.ts — serialise / deserialise the tunnel_config JSON blob.
 *
 * The blob is stored as AES-256-GCM encrypted text in the DB. This module
 * operates on the *decrypted* JSON string / object — encryption/decryption
 * is handled by the caller using encryptCredentials / decryptCredentials.
 *
 * Shape of the decrypted object:
 *   {
 *     pinggy?:  { token: string },
 *     serveo?:  {},
 *     zrok?:    { token: string },
 *   }
 *
 * Adding a new provider:
 *   1. Add its key to TunnelConfigMap below.
 *   2. Add a row to TUNNEL_PROVIDER_META.
 *   3. Add it to TUNNEL_PROVIDERS.
 *   Nothing else needs to change.
 */

export const TUNNEL_PROVIDERS = ["pinggy", "serveo", "zrok"] as const;
export type TunnelProvider = (typeof TUNNEL_PROVIDERS)[number];

/** Used when a stored provider is no longer supported (e.g. a removed provider). */
const FALLBACK_TUNNEL_PROVIDER: TunnelProvider = "serveo";

export interface PinggyConfig  { token: string }
export interface ServeoConfig  {}
export interface ZrokConfig    { token: string }

export interface TunnelConfigMap {
  pinggy?:  PinggyConfig;
  serveo?:  ServeoConfig;
  zrok?:    ZrokConfig;
  /**
   * Monotonic signal written when the user clicks "Restart tunnel".
   * The worker compares this value on each heartbeat and hot-swaps its
   * tunnel process when it changes. It lives inside the encrypted config
   * blob so no schema migration is required.
   */
  restartNonce?: string;
}

// ── Serialisation ─────────────────────────────────────────────────────────────

export function parseTunnelConfig(raw: string | null): TunnelConfigMap {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as TunnelConfigMap;
  } catch {
    return {};
  }
}

export function serialiseTunnelConfig(cfg: TunnelConfigMap): string {
  return JSON.stringify(cfg);
}

// ── Per-provider credential access ───────────────────────────────────────────

export function getPinggyToken(cfg: TunnelConfigMap): string {
  return cfg.pinggy?.token ?? "";
}

export function getZrokToken(cfg: TunnelConfigMap): string {
  return cfg.zrok?.token ?? "";
}

/**
 * Coerce a stored provider value into a supported provider. Stale rows that
 * still reference a removed provider fall back to serveo (no token required).
 */
export function normaliseTunnelProvider(value: unknown): TunnelProvider {
  return (TUNNEL_PROVIDERS as readonly string[]).includes(value as string)
    ? (value as TunnelProvider)
    : FALLBACK_TUNNEL_PROVIDER;
}

// ── Provider display metadata (used by UI) ───────────────────────────────────

export interface TunnelProviderMeta {
  label:            string;
  description:      string;
  /** Primary credential — token string pasted by user */
  needsToken:       boolean;
  tokenLabel?:      string;
  tokenHint?:       string;
  tokenPlaceholder?: string;
  docsUrl?:         string;
}

export const TUNNEL_PROVIDER_META: Record<TunnelProvider, TunnelProviderMeta> = {
  pinggy: {
    label:       "Pinggy",
    description: "SSH tunnel via pinggy.io — requires a free token. Provides both HTTPS and HTTP URLs.",
    needsToken:  true,
    tokenLabel:  "Pinggy token",
    tokenHint:   "Get one at pinggy.io",
    tokenPlaceholder: "Paste your Pinggy token",
    docsUrl:     "https://pinggy.io",
  },
  serveo: {
    label:       "Serveo",
    description: "Free SSH tunnel via serveo.net — no account or token needed. HTTPS only. Uses SSH port 443.",
    needsToken:  false,
  },
  zrok: {
    label:       "zrok",
    description: "Token-based tunnel via myzrok.io — requires a free account token and the zrok binary installed in your environment.",
    needsToken:  true,
    tokenLabel:  "zrok account token",
    tokenHint:   "Get one at myzrok.io",
    tokenPlaceholder: "Paste your zrok account token",
    docsUrl:     "https://myzrok.io",
  },
};
