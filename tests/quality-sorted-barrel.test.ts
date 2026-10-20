import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const qualityConfig = fileURLToPath(new URL("../packages/quality-config", import.meta.url));
const platformRoot = fileURLToPath(new URL("..", import.meta.url));
const barrel = "packages/core/src/index.ts";

// ESLint is a dependency of quality-config only, so the probe runs from there and lints the
// given text as the barrel's file; nothing is written to disk.
const probe = `
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { root, file, sources } = JSON.parse(input);
process.chdir(root);
const { default: config } = await import(pathToFileURL(resolve(${JSON.stringify(qualityConfig)}, "eslint.config.mjs")).href);
const plugin = config.find((entry) => entry.plugins?.catalyst).plugins.catalyst;
const linter = new Linter();
const results = sources.map((source) => linter.verify(source, [{
  files: ["**/*.ts"],
  languageOptions: { parser: tseslint.parser },
  plugins: { catalyst: plugin },
  rules: { "catalyst/sorted-barrel": "error" }
}], { filename: resolve(root, file) }).map((message) => message.line));
process.stdout.write(JSON.stringify(results));
`;

function findingLines(sources: string[], file = barrel): number[][] {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: qualityConfig,
    input: JSON.stringify({ root: platformRoot, file, sources }),
    encoding: "utf8"
  });
  expect(result.status, result.stderr).toBe(0);
  return z.array(z.array(z.number())).parse(JSON.parse(result.stdout));
}

describe("catalyst/sorted-barrel", () => {
  it("holds core's barrel as one sorted re-export per statement", () => {
    expect(findingLines([readFileSync(`${platformRoot}/${barrel}`, "utf8")])).toEqual([[]]);
  });

  it("refuses an export out of order, several names in one statement and a declaration", () => {
    const sorted =
      'export * from "./a";\nexport { b } from "./a";\nexport type { C } from "./c";\n';
    expect(
      findingLines([
        sorted,
        'export * from "./b";\nexport * from "./a";\n',
        'export { a } from "./x";\nexport { B } from "./x";\nexport { c } from "./x";\n',
        'export { a, b } from "./a";\n',
        'export const a = 1;\nexport { b } from "./b";\n'
      ])
    ).toEqual([[], [2], [], [1], [1]]);
  });

  it("leaves every other file alone", () => {
    expect(
      findingLines(['export * from "./b";\nexport * from "./a";\n'], "packages/ui/src/index.ts")
    ).toEqual([[]]);
  });
});
