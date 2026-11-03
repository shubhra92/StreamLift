/**
 * Only allow same-origin, relative redirect targets.
 * Rejects protocol-relative URLs (`//evil.com`) and backslash tricks.
 */
export function safeNextPath(value: string | null | undefined): string {
  if (!value) return "/";
  if (!value.startsWith("/")) return "/";
  if (value.startsWith("//") || value.includes("\\")) return "/";
  return value;
}
