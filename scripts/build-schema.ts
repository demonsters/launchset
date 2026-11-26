/**
 * Writes `dist/launchset.schema.json` from the zod config schema.
 * Run with `node scripts/build-schema.ts` (Node 24 runs erasable TypeScript directly).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configJsonSchema } from "../src/core/config/json-schema.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "dist/launchset.schema.json");

await mkdir(dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify(configJsonSchema(), null, 2)}\n`);
console.log(`wrote ${out}`);
