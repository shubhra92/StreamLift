import type { NextResponse } from "next/server";
import {
  LEGACY_SESSION_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE,
} from "./sessionConstants";

const BASE_COOKIE = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

/**
 * Issue or refresh the session cookie.
 *
 * For one release we also write the old `guestToken` cookie. This keeps any
 * open tab that still sends the legacy cookie working during the migration.
 * The next release will stop writing it.
 */
export function setSessionCookie(
  res: NextResponse,
  token: string,
  maxAge: number = SESSION_MAX_AGE,
): void {
  res.cookies.set(SESSION_COOKIE_NAME, token, { ...BASE_COOKIE, maxAge });
  res.cookies.set(LEGACY_SESSION_COOKIE_NAME, token, { ...BASE_COOKIE, maxAge });
}

/** Remove both the canonical and legacy cookies. */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, "", { ...BASE_COOKIE, maxAge: 0 });
  res.cookies.set(LEGACY_SESSION_COOKIE_NAME, "", { ...BASE_COOKIE, maxAge: 0 });
}
