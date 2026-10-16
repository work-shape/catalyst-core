#!/usr/bin/env node
// URL tarball resolutions can lose their integrity during lockfile regeneration.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDocument } from "yaml";

const XLSX_TARBALL = "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz";
// Pinned from a fresh pnpm fetch of the upstream tarball; also matches the capabilities lock.
const XLSX_INTEGRITY =
  "sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==";

/** @param {string} content */
export function checkXlsxIntegrity(content) {
  const lock = parseDocument(content);
  if (lock.errors.length) throw new Error("Cannot verify integrity: invalid pnpm lockfile");
  const integrity = lock.getIn(["packages", `xlsx@${XLSX_TARBALL}`, "resolution", "integrity"]);
  if (integrity !== XLSX_INTEGRITY)
    throw new Error(
      "SheetJS lock integrity is missing or changed; fetch and verify the upstream tarball"
    );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  checkXlsxIntegrity(readFileSync(resolve("pnpm-lock.yaml"), "utf8"));
  console.log("SheetJS lock integrity verified");
}
