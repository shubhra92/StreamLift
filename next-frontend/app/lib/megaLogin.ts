/**
 * Browser-side MEGA login.
 *
 * Faithful TypeScript port of the login flow from the `mega.py` Python
 * package (which itself mirrors megajs). All crypto runs in the browser via
 * WebCrypto (`crypto.subtle`) and native `BigInt`, so the password never
 * leaves the client.
 *
 * Returns the same session shape that megajs `Storage.toJSON()` and mega.py
 * `Mega.to_json()` produce:
 *
 *     { key: <e64 master key>, sid, name, user, options: { email } }
 *
 * which the Python worker restores with `Mega().login(session=...)`.
 */

import { aes128EcbDecrypt, aes128EcbEncrypt } from "./aesEcb.ts";

export interface MegaLoginSession {
  key: string;
  sid: string;
  name: string | null;
  user: string | null;
  options: { email: string };
}

const MEGA_API = "https://g.api.mega.co.nz/cs?";
const HASH_RETRIES = 3;
const HASHCASH_REPLICATIONS = 262144;
const HASHCASH_TOKEN_LEN = 48;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ── base64url (MEGA e64 / d64) ───────────────────────────────────────────────

export function e64(buf: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function d64(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── tiny byte / int helpers ──────────────────────────────────────────────────

const encoder = new TextEncoder();

function enc(s: string): Uint8Array {
  return encoder.encode(s);
}

function makeId(length = 10): string {
  const abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < length; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function bytesToBigInt(u: Uint8Array): bigint {
  let n = 0n;
  for (let i = 0; i < u.length; i++) n = (n << 8n) | BigInt(u[i]);
  return n;
}

function bigIntToBytesMinimal(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(1);
  const hex = n.toString(16);
  const padded = hex.length % 2 ? `0${hex}` : hex;
  const out = new Uint8Array(padded.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ── MEGA AES-ECB (pure JS — crypto.subtle has no AES-ECB in Node) ─────────────

async function aesEcbDecrypt(data: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  return aes128EcbDecrypt(data, key);
}

// ── key derivation (login) ───────────────────────────────────────────────────

/** V1: 65536 rounds of AES-ECB (legacy accounts only). */
async function prepareKeyV1(pw: Uint8Array): Promise<Uint8Array> {
  let pkey: Uint8Array = Uint8Array.from([147, 196, 103, 227, 125, 176, 199, 164, 209, 190, 63, 129, 1, 82, 203, 86]);
  const block = new Uint8Array(16);
  for (let i = 0; i < 65536; i++) {
    for (let j = 0; j < pw.length; j += 16) {
      const slice = pw.subarray(j, j + 16);
      block.fill(0);
      block.set(slice, 0);
      pkey = aes128EcbEncrypt(block, pkey);
    }
  }
  return pkey;
}

/** V2: PBKDF2-HMAC-SHA512, 100000 iterations, 32 byte output. */
async function prepareKeyV2(pw: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey("raw", pw as BufferSource, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-512", iterations: 100000, salt: salt as BufferSource },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

/** MEGA string hash: XOR 4-byte words, then 16384 AES-ECB rounds. (v1 only) */
async function stringhash(data: Uint8Array, aesKey: Uint8Array): Promise<Uint8Array> {
  const h32 = [0, 0, 0, 0];
  for (let i = 0; i < data.length; i += 4) {
    const chunk = data.subarray(i, i + 4);
    let val = 0;
    for (let j = 0; j < chunk.length; j++) val = (val << 8) | chunk[j];
    if (chunk.length < 4) val <<= (4 - chunk.length) * 8;
    h32[Math.floor(i / 4) % 4] ^= val >>> 0;
  }

  let hashBytes: Uint8Array = new Uint8Array(16);
  for (let i = 0; i < 4; i++) {
    hashBytes.set([(h32[i] >> 24) & 0xff, (h32[i] >> 16) & 0xff, (h32[i] >> 8) & 0xff, h32[i] & 0xff], i * 4);
  }

  for (let i = 0; i < 16384; i++) hashBytes = aes128EcbEncrypt(hashBytes, aesKey);

  const out = new Uint8Array(8);
  out.set(hashBytes.subarray(0, 4), 0);
  out.set(hashBytes.subarray(8, 12), 4);
  return out;
}

// ── RSA-CRT (session id decryption) ──────────────────────────────────────────

function parseMpi(data: Uint8Array): [Uint8Array, Uint8Array] | null {
  if (data.length < 2) return null;
  const bitLen = (data[0] << 8) | data[1];
  const byteLen = (bitLen + 7) >> 3;
  if (data.length < 2 + byteLen) return null;
  return [data.subarray(2, 2 + byteLen), data.subarray(2 + byteLen)];
}

function decodePrivKey(privk: Uint8Array): Uint8Array[] | null {
  const components: Uint8Array[] = [];
  let data = privk;
  for (let i = 0; i < 4; i++) {
    if (data.length < 2) return null;
    const mpi = parseMpi(data);
    if (!mpi) return null;
    const [value, rest] = mpi;
    components.push(value);
    data = rest;
  }
  return components.length === 4 ? components : null;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  if (mod === 1n) return 0n;
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

/** Port of mega.py `_crt_decrypt` / megajs `RSAdecrypt`. */
function crtDecryptToSid(c: bigint, p: bigint, q: bigint, d: bigint, u: bigint): Uint8Array {
  const m1 = modPow(c % p, d % (p - 1n), p);
  const m2 = modPow(c % q, d % (q - 1n), q);
  let t = m2 - m1;
  if (t < 0n) {
    t = ((((m1 - m2) % q) + q) % q) * u % q;
    t = q - t;
  } else {
    t = (t * u) % q;
  }
  const n = p * q;
  const plain = (t * p + m1) % n;
  return bigIntToBytesMinimal(plain);
}

function decryptRsa(ciphertext: Uint8Array, privkey: Uint8Array[]): Uint8Array {
  const [pBytes, qBytes, dBytes, uBytes] = privkey.map(bytesToBigInt) as [bigint, bigint, bigint, bigint];
  const p = pBytes;
  const q = qBytes;
  const d = dBytes;
  const u = uBytes;
  const n = p * q;
  const modulusBytes = Math.ceil(n.toString(16).length / 2);

  const mpi = parseMpi(ciphertext);
  let cInt: bigint;
  if (mpi) {
    const [cBytes, rest] = mpi;
    if (cBytes.length === modulusBytes) {
      cInt = bytesToBigInt(cBytes);
    } else {
      void rest;
      cInt = bytesToBigInt(ciphertext);
    }
  } else {
    cInt = bytesToBigInt(ciphertext);
  }

  return crtDecryptToSid(cInt, p, q, d, u);
}

// ── hashcash proof-of-work ────────────────────────────────────────────────────

function solveHashcash(challenge: string): Promise<string> {
  return (async () => {
    const parts = challenge.split(":");
    if (parts.length !== 4) throw new Error(`Malformed MEGA hashcash challenge: ${challenge}`);
    const [versionStr, easinessStr, , tokenStr] = parts;
    if (versionStr !== "1") throw new Error(`Unsupported MEGA hashcash challenge version: ${versionStr}`);

    const easiness = parseInt(easinessStr, 10);
    const base = ((easiness & 63) << 1) + 1;
    const shifts = (easiness >> 6) * 7 + 3;
    const threshold = BigInt(base) << BigInt(shifts);

    const token = d64(tokenStr);
    if (token.length !== HASHCASH_TOKEN_LEN) throw new Error("Invalid MEGA hashcash token length");

    const buffer = new Uint8Array(4 + HASHCASH_REPLICATIONS * HASHCASH_TOKEN_LEN);
    for (let i = 0; i < HASHCASH_REPLICATIONS; i++) buffer.set(token, 4 + i * HASHCASH_TOKEN_LEN);

    for (;;) {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", buffer as BufferSource));
      const head = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
      if (BigInt(head) <= threshold) return `1:${tokenStr}:${e64(buffer.subarray(0, 4))}`;
      for (let j = 3; j >= 0; j--) {
        const value = buffer[j] + 1;
        buffer[j] = value & 0xff;
        if (value & 0xff) break;
      }
    }
  })();
}

// ── API transport (with hashcash retry loop) ─────────────────────────────────

const MEGA_ERRORS: Record<number, string> = {
  [-1]: "internal error",
  [-2]: "invalid email or password",
  [-3]: "try again later",
  [-4]: "rate limit exceeded",
  [-5]: "request failed",
  [-6]: "too many requests",
  [-7]: "invalid range",
  [-8]: "expired",
  [-9]: "not found",
  [-11]: "access denied",
  [-13]: "incomplete upload",
  [-14]: "invalid key",
  [-15]: "invalid session",
  [-16]: "account blocked",
  [-17]: "storage quota exceeded",
  [-18]: "temporarily unavailable",
  [-19]: "too many connections",
  [-20]: "write too large",
};

async function apiRequest(body: Record<string, unknown>, sid?: string): Promise<any> {
  const payload: Record<string, string> = { id: makeId() };
  if (sid) payload.sid = sid;
  const url = `${MEGA_API}${new URLSearchParams(payload).toString()}`;
  const jsonBody = JSON.stringify([body]);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": USER_AGENT,
  };

  let hashcash: string | null = null;
  let remaining = HASH_RETRIES;

  for (;;) {
    if (hashcash) headers["X-Hashcash"] = hashcash;
    else delete headers["X-Hashcash"];

    const resp = await fetch(url, { method: "POST", headers, body: jsonBody });

    const challenge = resp.headers.get("X-Hashcash");
    if (challenge) {
      if (remaining <= 0) throw new Error("MEGA hashcash challenge failed after retries");
      hashcash = await solveHashcash(challenge);
      remaining -= 1;
      await sleep(2 ** (HASH_RETRIES - remaining + 1));
      continue;
    }

    if (resp.status === 503 || resp.status === 429) {
      await sleep(2 ** (HASH_RETRIES - remaining + 1));
      continue;
    }

    if (!resp.ok) {
      throw new Error(`MEGA returned HTTP ${resp.status}`);
    }

    const data = await resp.json();
    const item = Array.isArray(data) && data.length ? data[0] : data;
    if (typeof item === "number" && item < 0) {
      if (item === -3) continue;
      const detail = MEGA_ERRORS[item] ?? `error ${item}`;
      throw new Error(`MEGA request failed: ${detail} (${item})`);
    }
    return item;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── login ────────────────────────────────────────────────────────────────────

/**
 * Login to MEGA entirely in the browser and return a session that can be
 * restored later by the Python worker (`Mega().login(session=...)`).
 */
export async function megaLogin(email: string, password: string): Promise<MegaLoginSession> {
  if (!email?.trim() || !password) throw new Error("Email and password are required");
  const normalizedEmail = email.trim().toLowerCase();
  const mailBytes = enc(normalizedEmail);
  const pwBytes = enc(password);

  // 1) Detect account version
  const us0 = await apiRequest({ a: "us0", user: normalizedEmail });
  const version = us0?.v;

  let aesKey: Uint8Array;
  let uh: string;
  if (version === 2) {
    const salt = d64(typeof us0?.s === "string" ? us0.s : "");
    if (!salt.length) throw new Error("MEGA did not return a salt for this account");
    const derived = await prepareKeyV2(pwBytes, salt); // 32 bytes
    aesKey = derived.subarray(0, 16);
    uh = e64(derived.subarray(16, 32));
  } else if (version === 1) {
    const pw = await prepareKeyV1(pwBytes);
    aesKey = pw.subarray(0, 16);
    uh = e64(await stringhash(mailBytes, aesKey));
  } else {
    throw new Error(`Unsupported MEGA account version: ${version}`);
  }

  // 2) Authenticate
  const us = await apiRequest({ a: "us", user: normalizedEmail, uh });

  // 3) Decrypt the master key with the password-derived key
  const masterKey = await aesEcbDecrypt(d64(String(us.k)), aesKey);

  // 4) Decrypt the RSA private key with the master key
  const privkBlob = d64(String(us.privk));
  const privkPlain = await aesEcbDecrypt(privkBlob, masterKey);
  const privkey = decodePrivKey(privkPlain);
  if (!privkey) throw new Error("Invalid credentials: could not decode RSA private key");

  // 5) RSA-decrypt the session id
  const csid = d64(String(us.csid));
  const sidBytes = decryptRsa(csid, privkey).subarray(0, 43);
  const sid = e64(sidBytes);

  // 6) Load user info
  let name: string | null = null;
  let user: string | null = null;
  try {
    const ug = await apiRequest({ a: "ug" }, sid);
    name = typeof ug?.name === "string" ? ug.name : null;
    user = typeof ug?.u === "string" ? ug.u : null;
  } catch {
    // ug is optional — the session itself is already valid
  }

  return { key: e64(masterKey), sid, name, user, options: { email: normalizedEmail } };
}