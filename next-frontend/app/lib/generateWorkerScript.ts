import { readFileSync } from "fs";
import { join } from "path";
import type { Worker } from "../db/schema";
import { decryptCredentials } from "./crypto";

const WORKER_VERSION = "1.1.0";

export function generateWorkerScript(worker: Worker, apiBaseUrl: string): string {
  const templatePath = join(process.cwd(), "app/lib/workerScriptTemplate.py");
  let script = readFileSync(templatePath, "utf-8");

  // Decrypt Mega password server-side before embedding.
  // The worker receives plaintext credentials — it no longer needs to decrypt.
  const megaEmail    = worker.megaEmail ?? "";
  const megaPassword = worker.megaPassword
    ? decryptCredentials(worker.megaPassword)
    : "";

  // Build timestamp so you can tell which generated version is running
  const scriptBuild = new Date().toISOString().slice(0, 16).replace("T", " ");

  script = script.replaceAll("{{WORKER_ID}}",         worker.id);
  script = script.replaceAll("{{AUTH_TOKEN}}",         worker.authToken);
  script = script.replaceAll("{{API_BASE_URL}}",       apiBaseUrl.replace(/\/$/, ""));
  script = script.replaceAll("{{COMPUTE_TYPE}}",       worker.computeType);
  script = script.replaceAll("{{DOWNLOAD_LOCATION}}", worker.downloadLocation);
  script = script.replaceAll("{{MEGA_EMAIL}}",         megaEmail);
  script = script.replaceAll("{{MEGA_PASSWORD}}",      megaPassword);
  script = script.replaceAll("{{WORKER_VERSION}}",     WORKER_VERSION);
  script = script.replaceAll("{{SCRIPT_BUILD}}",       scriptBuild);

  return script;
}
