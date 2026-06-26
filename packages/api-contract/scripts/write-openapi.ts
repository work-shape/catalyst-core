import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../src/index";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = resolve(packageDir, "openapi.json");

await writeFile(outputPath, `${JSON.stringify(openApiDocument, null, 2)}\n`);
