import { readFileSync } from "fs";
import { join } from "path";
import type { Worker } from "../db/schema";

export function generateWorkerScript(worker: Worker, apiBaseUrl: string): string {
  const templatePath = join(process.cwd(), "app/lib/workerScriptTemplate.py");
  let script = readFileSync(templatePath, "utf-8");

  script = script.replaceAll("{{WORKER_ID}}",                  worker.id);
  script = script.replaceAll("{{AUTH_TOKEN}}",                  worker.authToken);
  script = script.replaceAll("{{API_BASE_URL}}",                apiBaseUrl.replace(/\/$/, ""));

  return script;
}
