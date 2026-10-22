import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { testProjects } from "../vitest.projects.config";

it("isolates persistence and module mocks through runtime imports while erasing type imports", () => {
  const root = mkdtempSync(join(tmpdir(), "catalyst-test-projects-"));
  const files: Record<string, string> = {
    "tests/pure.test.ts": 'import type { Sql } from "postgres";',
    "tests/mixed-types.test.ts": 'import { type Sql } from "postgres";',
    "tests/export-types.test.ts": 'export { type Sql } from "postgres";',
    "tests/draft.test.ts": "openConnectionDraft();",
    "tests/mock.test.ts": 'vi.mock("react", () => ({}));',
    "tests/do-mock.test.ts": 'vi.doMock("react", () => ({}));',
    "tests/template-import.test.ts": "await import(`./support/database`);",
    "tests/database.test.ts": 'import postgres from "postgres";',
    "tests/transitive.test.ts": 'import { setup } from "./support/barrel";',
    "tests/dynamic.test.ts": 'await import("./support/database");',
    "tests/require.test.ts": 'require("./support/database");',
    "tests/environment.test.ts": "const url = process.env.POSTGRES_STORE_TEST_DATABASE_URL;",
    "tests/nested/scale.scale.test.ts": 'import { setup } from "../support/database";',
    "tests/support/barrel.ts": 'export * from "./database";',
    "tests/support/database.ts": 'import postgres from "postgres";',
    "tests/cycle.test.ts": 'import "./support/cycle-a";',
    "tests/support/cycle-a.ts": 'import "./cycle-b";',
    "tests/support/cycle-b.ts": 'import "./cycle-a";'
  };
  try {
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    const { pure, isolated } = testProjects(root);
    expect(pure.sort()).toEqual([
      "tests/cycle.test.ts",
      "tests/export-types.test.ts",
      "tests/mixed-types.test.ts",
      "tests/pure.test.ts"
    ]);
    expect(isolated.sort()).toEqual([
      "tests/database.test.ts",
      "tests/do-mock.test.ts",
      "tests/draft.test.ts",
      "tests/dynamic.test.ts",
      "tests/environment.test.ts",
      "tests/mock.test.ts",
      "tests/nested/scale.scale.test.ts",
      "tests/require.test.ts",
      "tests/template-import.test.ts",
      "tests/transitive.test.ts"
    ]);
    expect(new Set([...pure, ...isolated]).size).toBe(14);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("keeps file-scoped stubs for every test and restores them before the next file", () => {
  const parent = join(process.cwd(), ".tmp");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "pure-lifetime-"));
  try {
    writeFileSync(
      join(root, "vitest.config.mjs"),
      `
      import { defineConfig } from "vitest/config";
      import { BaseSequencer } from "vitest/node";
      class ByName extends BaseSequencer {
        sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
      }
      export default defineConfig({
        root: ${JSON.stringify(root)},
        test: {
          include: ["*.test.ts"], pool: "threads", isolate: false, maxWorkers: 1,
          setupFiles: [${JSON.stringify(join(process.cwd(), "tests/support/pure-file-cleanup.ts"))}],
          sequence: { hooks: "stack", sequencer: ByName }
        }
      });
    `
    );
    writeFileSync(
      join(root, "a.test.ts"),
      `
      import { expect, it, vi } from "vitest";
      vi.stubGlobal("__catalystPureLifetime", "present");
      vi.stubEnv("CATALYST_PURE_LIFETIME", "present");
      for (const name of ["first", "second"]) it(name, () => {
        expect(globalThis.__catalystPureLifetime).toBe("present");
        expect(process.env.CATALYST_PURE_LIFETIME).toBe("present");
      });
    `
    );
    writeFileSync(
      join(root, "b.test.ts"),
      `
      import { expect, it } from "vitest";
      it("starts clean", () => {
        expect(globalThis.__catalystPureLifetime).toBeUndefined();
        expect(process.env.CATALYST_PURE_LIFETIME).toBeUndefined();
      });
    `
    );
    execFileSync("pnpm", ["exec", "vitest", "run", "--config", join(root, "vitest.config.mjs")], {
      encoding: "utf8"
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
