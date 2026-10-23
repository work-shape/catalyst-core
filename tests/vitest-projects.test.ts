import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { testProjects } from "../vitest.projects.config";

it("separates shared persistence from module mocks through runtime imports while erasing type imports", () => {
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
    const { pure, postgres, isolated } = testProjects(root);
    expect(pure.sort()).toEqual([
      "tests/cycle.test.ts",
      "tests/export-types.test.ts",
      "tests/mixed-types.test.ts",
      "tests/pure.test.ts"
    ]);
    expect(postgres.sort()).toEqual([
      "tests/database.test.ts",
      "tests/dynamic.test.ts",
      "tests/environment.test.ts",
      "tests/nested/scale.scale.test.ts",
      "tests/require.test.ts",
      "tests/template-import.test.ts",
      "tests/transitive.test.ts"
    ]);
    expect(isolated.sort()).toEqual([
      "tests/do-mock.test.ts",
      "tests/draft.test.ts",
      "tests/mock.test.ts"
    ]);
    expect(new Set([...pure, ...postgres, ...isolated]).size).toBe(14);
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
      vi.spyOn(Math, "random").mockReturnValue(0.123);
      vi.useFakeTimers();
      vi.stubEnv("CATALYST_PURE_LIFETIME", "present");
      for (const name of ["first", "second"]) it(name, () => {
        expect(globalThis.__catalystPureLifetime).toBe("present");
        expect(Math.random()).toBe(0.123);
        expect(vi.isFakeTimers()).toBe(true);
        expect(process.env.CATALYST_PURE_LIFETIME).toBe("present");
      });
    `
    );
    writeFileSync(
      join(root, "b.test.ts"),
      `
      import { expect, it, vi } from "vitest";
      it("starts clean", () => {
        expect(globalThis.__catalystPureLifetime).toBeUndefined();
        expect(vi.isMockFunction(Math.random)).toBe(false);
        expect(vi.isFakeTimers()).toBe(false);
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

it("re-registers Postgres cleanup and resets suite retention in a reused fork", () => {
  const parent = join(process.cwd(), ".tmp");
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, "postgres-lifetime-"));
  const support = join(process.cwd(), "tests/support");
  try {
    writeFileSync(
      join(root, "vitest.config.mjs"),
      `
      import { defineConfig } from "vitest/config";
      import { BaseSequencer } from "vitest/node";
      import { sourceAliases } from "@work-shape/catalyst-quality-config/source-aliases";
      class ByName extends BaseSequencer {
        sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
      }
      export default defineConfig({
        root: ${JSON.stringify(root)},
        resolve: { alias: sourceAliases(${JSON.stringify(process.cwd())}) },
        test: {
          include: ["*.test.ts"], pool: "forks", isolate: false, maxWorkers: 1,
          provide: { sharedPostgresHooks: true },
          globalSetup: [${JSON.stringify(join(support, "postgres-global-setup.ts"))}],
          setupFiles: [${JSON.stringify(join(support, "pure-file-cleanup.ts"))}, ${JSON.stringify(join(support, "postgres-file-hooks.ts"))}],
          sequence: { hooks: "stack", setupFiles: "list", sequencer: ByName }
        }
      });
    `
    );
    const imports = `
      import { beforeAll, expect, it } from "vitest";
      import { asClientInstanceId } from "@work-shape/catalyst-core";
      import { createTestInstance } from ${JSON.stringify(join(support, "test-instance.ts"))};
      const clientInstanceId = asClientInstanceId("file-lifetime");
    `;
    writeFileSync(
      join(root, "a.test.ts"),
      imports +
        `
      let instance;
      beforeAll(async () => {
        instance = await createTestInstance({ postgres: {} });
        globalThis.__catalystPriorInstance = instance;
      });
      it("writes suite state", async () => {
        await instance.stores.users.createUser({ clientInstanceId, displayLabel: "retained" });
      });
      it("retains it within the file", async () => {
        expect(await instance.stores.users.listUsers({ clientInstanceId })).toHaveLength(1);
      });
    `
    );
    writeFileSync(
      join(root, "b.test.ts"),
      imports +
        `
      it("streams identical deterministic events without scheduling a timer", async () => {
        const { vi } = await import("vitest");
        const { DeterministicModelProvider } = await import("@work-shape/catalyst-model-provider");
        const provider = new DeterministicModelProvider();
        const request = { messages: [{ role: "user", content: "Hello" }], tools: [] };
        const completion = await provider.complete(request);
        const timer = vi.spyOn(globalThis, "setTimeout");
        try {
          const events = [];
          for await (const event of provider.stream(request)) events.push(event);
          expect(events).toEqual([
            ...completion.text.match(/\\S+\\s*/gu).map((delta) => ({ type: "text_delta", delta })),
            { type: "completed", completion }
          ]);
          expect(timer).not.toHaveBeenCalled();
        } finally { timer.mockRestore(); }
      });
      it("closes the prior file's instance and writes test state", async () => {
        expect(() => globalThis.__catalystPriorInstance.signIn("user")).toThrow("Test instance is closed");
        delete globalThis.__catalystPriorInstance;
        const instance = await createTestInstance({ postgres: {} });
        expect(await instance.stores.users.listUsers({ clientInstanceId })).toEqual([]);
        await instance.stores.users.createUser({ clientInstanceId, displayLabel: "test-only" });
      });
      it("starts the next test without the prior test's rows", async () => {
        const instance = await createTestInstance({ postgres: {} });
        expect(await instance.stores.users.listUsers({ clientInstanceId })).toEqual([]);
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
