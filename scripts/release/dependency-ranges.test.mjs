import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

// The small risk-based list is explained in README.md. Everything else keeps its normal range.
const exact = new Set([
  "better-auth",
  "zod",
  "drizzle-orm",
  "react",
  "react-dom",
  "fastify",
  "@fastify/cors",
  "@fastify/multipart"
]);
const patch = new Set([
  "postgres",
  "ajv",
  "re2js",
  "js-yaml",
  "@tanstack/react-query",
  "@tanstack/react-router",
  "@assistant-ui/react",
  "ai"
]);

test("published runtime dependencies and peers stay on the tested auth, data, validation and UI lines", () => {
  const root = new URL("../../", import.meta.url);
  const lock = parse(readFileSync(new URL("pnpm-lock.yaml", root), "utf8"));
  for (const dir of readdirSync(new URL("packages/", root))) {
    const manifest = JSON.parse(
      readFileSync(new URL(`packages/${dir}/package.json`, root), "utf8")
    );
    if (manifest.private) continue;
    for (const section of ["dependencies", "peerDependencies"]) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (!exact.has(name) && !patch.has(name) && !name.startsWith("@better-auth/")) continue;
        const label = `${manifest.name} ${section}.${name}`;
        const pinned = exact.has(name) || name.startsWith("@better-auth/");
        assert.match(range, pinned ? /^\d+\.\d+\.\d+$/u : /^~?\d+\.\d+\.\d+$/u, label);
        const tested =
          lock.importers[join("packages", dir)]?.[section]?.[name]?.version ??
          lock.importers["."]?.devDependencies?.[name]?.version;
        assert.ok(tested, `${label}: no tested version in core lock`);
        assert.equal(
          range.replace(/^~/u, ""),
          tested.split("(")[0],
          `${label}: range must start at core's tested version`
        );
      }
    }
  }
});
