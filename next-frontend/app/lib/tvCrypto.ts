import crypto from "crypto";

/** Stable, non-reversible hash used for pairing codes, secrets and TV tokens. */
export function tvHash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** 32 random bytes, URL-safe. Used for the TV bearer token. */
export function tvRandomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function tvConstantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
