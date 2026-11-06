/**
 * Copy megajs' browser UMD bundle into public/ so the cloud-media service
 * worker can import it with importScripts(). The bundle is generated, not
 * committed.
 */
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "node_modules/megajs/dist/main.browser-umd.js");
const target = resolve(root, "public/vendor/megajs.browser-umd.js");

await mkdir(dirname(target), { recursive: true });
await copyFile(source, target);
console.log("Copied megajs browser bundle to public/vendor/megajs.browser-umd.js");
