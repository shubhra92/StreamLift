import { readFileSync } from "fs";
import { join } from "path";
import type { Worker } from "../db/schema";
import { decryptCredentials } from "./crypto";

export function generateWorkerScript(worker: Worker, apiBaseUrl: string): string {
  const templatePath = join(process.cwd(), "app/lib/workerScriptTemplate.py");
  let script = readFileSync(templatePath, "utf-8");

  // Read-only PAT for the private megapy repo — server-side only, never sent to browser.
  const megapyPat = process.env.MEGAPY_GITHUB_PAT ?? "";
  if (!megapyPat) {
    console.warn("[generateWorkerScript] MEGAPY_GITHUB_PAT is not set — megapy install will fail");
  }

  // Decrypt Pinggy token stored encrypted in DB
  const pinggyToken = worker.pinggyToken ? decryptCredentials(worker.pinggyToken) : "";
  if (!pinggyToken) {
    console.warn("[generateWorkerScript] Worker has no Pinggy token configured");
  }

  // Mega flags only when download location is mega
  let megaFlags = "";
  if (worker.downloadLocation === "mega") {
    const megaEmail    = worker.megaEmail ?? "";
    const megaPassword = worker.megaPassword ? decryptCredentials(worker.megaPassword) : "";
    megaFlags = ` \\\n  --mega-email    "${megaEmail}" \\\n  --mega-password "${megaPassword}"`;
  }

  script = script.replaceAll("{{WORKER_ID}}",         worker.id);
  script = script.replaceAll("{{AUTH_TOKEN}}",         worker.authToken);
  script = script.replaceAll("{{API_BASE_URL}}",       apiBaseUrl.replace(/\/$/, ""));
  script = script.replaceAll("{{COMPUTE_TYPE}}",       worker.computeType);
  script = script.replaceAll("{{DOWNLOAD_LOCATION}}", worker.downloadLocation);
  script = script.replaceAll("{{PINGGY_TOKEN}}",       pinggyToken);
  script = script.replaceAll("{{MEGA_FLAGS}}",         megaFlags);
  script = script.replaceAll("{{MEGAPY_PAT}}",         megapyPat);

  return script;
}
