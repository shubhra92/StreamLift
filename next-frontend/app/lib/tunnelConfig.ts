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
 *     tunnlgg?: { sshKeyPath?: string },   // path on the worker machine, NOT the key itself
 *     zrok?:    { token: string },
 *   }
 *
 * Adding a new provider:
 *   1. Add its key to TunnelConfigMap below.
 *   2. Add a row to TUNNEL_PROVIDER_META.
 *   3. Add it to TUNNEL_PROVIDERS.
 *   Nothing else needs to change.
 */

export const TUNNEL_PROVIDERS = ["pinggy", "serveo", "tunnlgg", "zrok"] as const;
export type TunnelProvider = (typeof TUNNEL_PROVIDERS)[number];

export interface PinggyConfig  { token: string }
export interface ServeoConfig  {}
export interface TunnlGgConfig { sshKeyPath?: string }  // optional stable-URL key path
export interface ZrokConfig    { token: string }

export interface TunnelConfigMap {
  pinggy?:  PinggyConfig;
  serveo?:  ServeoConfig;
  tunnlgg?: TunnlGgConfig;
  zrok?:    ZrokConfig;
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

export function getTunnlGgSshKeyPath(cfg: TunnelConfigMap): string {
  return cfg.tunnlgg?.sshKeyPath ?? "";
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
  /** Secondary optional credential (e.g. SSH key path for tunnl.gg) */
  hasOptionalField?:      boolean;
  optionalFieldLabel?:    string;
  optionalFieldHint?:     string;
  optionalFieldPlaceholder?: string;
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
  tunnlgg: {
    label:       "tunnl.gg",
    description: "Free SSH tunnel via tunnl.gg — no account needed for a random URL. Provide an SSH key path for a stable URL that stays the same on reconnect. HTTPS only. Uses SSH port 22.",
    needsToken:  false,
    hasOptionalField:       true,
    optionalFieldLabel:     "SSH key path (optional — for stable URL)",
    optionalFieldHint:      "Leave blank for a random URL each restart. Enter the path to your SSH key for a stable URL.",
    optionalFieldPlaceholder: "e.g. ~/.ssh/id_ed25519",
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
