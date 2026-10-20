import { spawnSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const path = "../packages/chat-ui/src/__private_probe__/theme";
const fixtures = [
  [`import { resolveThemeModePreference } from "${path}";`, "no-restricted-imports"],
  [`import type { ThemeModePreference } from "${path}";`, "no-restricted-imports"],
  [`export { resolveThemeModePreference } from "${path}";`, "no-restricted-imports"],
  [`export * from "${path}";`, "no-restricted-imports"],
  ['import "../../packages/chat-ui/src/__private_probe__/theme";', "no-restricted-imports"],
  ['import "@work-shape/catalyst-chat-ui/src/__private_probe__/theme";', "no-restricted-imports"],
  [`export const load = () => import("${path}");`, "no-restricted-syntax"],
  [`export const load = () => require("${path}");`, "no-restricted-syntax"],
  [`export type Module = typeof import("${path}");`, "no-restricted-syntax"],
  ['import { resolveThemeModePreference } from "./support/chat-ui";', undefined],
  ['import { createTranslationContext } from "@work-shape/catalyst-chat-ui";', undefined],
  ['import { AccessPage } from "@work-shape/catalyst-chat-ui/access";', undefined],
  [
    'export { ConversationPalette } from "../../../packages/chat-ui/src/chat/workspace/conversation-palette";',
    undefined,
    "tests/support/chat-ui/chat-workspace.ts"
  ],
  [`import "${path}";`, "no-restricted-imports"]
] as const;
let results: string[] = [];

beforeAll(() => {
  // Unique files keep the typed parser's CI cache from reusing another fixture's source.
  // The real repository configuration still checks the sole named exception. The files live in
  // a dot directory that Git ignores, with a project of their own, so the lint, format and type
  // checks that `pnpm check:local` runs beside the tests never list them.
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "./packages/quality-config/node_modules/eslint/lib/api.js";
const directory = mkdtempSync("tests/support/.chat-ui-imports-");
try {
  const project = join(directory, "tsconfig.json");
  writeFileSync(project, JSON.stringify({ extends: "../../../tsconfig.lint.json", include: ["*.ts", "../chat-ui/*.ts"] }));
  const fixtures = JSON.parse(readFileSync(0, "utf8")).map(([source, rule, file], index) => {
    const path = file ?? join(directory, index + ".ts");
    if (!file) writeFileSync(path, source);
    return { source, rule, path };
  });
  const eslint = new ESLint({
    overrideConfig: [{ files: ["**/*.ts"], languageOptions: { parserOptions: { project: [project] } } }]
  });
  const results = [];
  for (const { source, path } of fixtures) {
    results.push(JSON.stringify(await eslint.lintText(source, { filePath: path })));
  }
  process.stdout.write(JSON.stringify(results));
} finally {
  rmSync(directory, { recursive: true, force: true });
}`
    ],
    { input: JSON.stringify(fixtures), encoding: "utf8" }
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  results = z.array(z.string()).parse(JSON.parse(result.stdout));
});

describe("chat-ui test import boundary", () => {
  it.each(fixtures.map((fixture, index) => ({ fixture, index, source: fixture[0] })))(
    "checks the import boundary: $source",
    ({ fixture: [, rule, file], index }) => {
      const result = results[index];
      expect(result).toBeDefined();
      expect(result).not.toContain('"fatal":true');
      if (rule) {
        expect(result).toContain(`"ruleId":"${rule}"`);
      } else {
        expect(result).not.toContain('"ruleId":"no-restricted-imports"');
        expect(result).not.toContain('"ruleId":"no-restricted-syntax"');
        if (file === "tests/support/chat-ui/chat-workspace.ts") {
          expect(result).not.toContain('"ruleId":"import-x/no-relative-packages"');
        }
      }
    }
  );
});
