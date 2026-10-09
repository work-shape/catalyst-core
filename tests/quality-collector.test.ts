import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The real collector runs over a small project that breaks every rule once, including each
// way a rule used to be bypassed. Weakening a rule or the collection fails this test.

const qualityConfig = fileURLToPath(new URL("../packages/quality-config", import.meta.url));
const source = "packages/alpha/src";
// Written in two parts so that this file does not carry the comment it tests.
const formatIgnore = ["prettier", "ignore"].join("-");

const project: Record<string, string> = {
  ".gitignore": "node_modules\n",
  "package.json": JSON.stringify({ name: "fixture", private: true, workspaces: ["packages/*"] }),
  "eslint.config.mjs": `import config from "@vivd-catalyst/quality-config";
export default [...config, { files: ["**/warned.ts"], rules: { "no-debugger": "warn" } }];
`,
  "knip.json": JSON.stringify({
    workspaces: {
      "packages/*": {
        entry: ["src/*.{ts,mts,cjs}", "src/adapters/*.ts"],
        project: ["src/**/*.{ts,mts,cjs}"]
      },
      ".": { entry: ["tests/*.ts", "eslint.config.mjs"], project: ["tests/*.ts"] }
    }
  }),
  "tsconfig.lint.json": JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      target: "ES2023",
      module: "ESNext",
      moduleResolution: "Bundler",
      noUncheckedIndexedAccess: true,
      types: [],
      paths: { "@fixture/beta": ["./packages/beta/src/index.ts"] }
    },
    include: ["packages", "tests"]
  }),
  "tsconfig.tests.json": JSON.stringify({ extends: "./tsconfig.lint.json", include: ["tests"] }),
  "quality-baseline.json": JSON.stringify({ version: 1, entries: [] }),
  // Beta and gamma depend on each other. Delta's manifest has an edge the graph lacks, and
  // the graph names a package that no manifest has.
  "quality-package-graph.json": JSON.stringify({
    "@fixture/alpha": [],
    "@fixture/beta": ["@fixture/gamma"],
    "@fixture/gamma": ["@fixture/beta"],
    "@fixture/delta": [],
    "@fixture/ghost": []
  }),
  "packages/alpha/package.json": JSON.stringify({
    name: "@fixture/alpha",
    type: "module",
    bin: { alpha: "./dist/cli.js" },
    scripts: { typecheck: "tsc -p tsconfig.json" },
    dependencies: { "left-pad": "1.3.0" }
  }),
  "packages/alpha/tsconfig.json": JSON.stringify({
    extends: "../../tsconfig.lint.json",
    include: ["src"]
  }),
  "packages/beta/package.json": JSON.stringify({
    name: "@fixture/beta",
    type: "module",
    main: "./src/index.ts",
    exports: { ".": "./src/index.ts" },
    dependencies: { "@fixture/gamma": "workspace:*" }
  }),
  "packages/beta/src/index.ts": `export const value = 1;\n`,
  "packages/beta/src/internal.ts": `export const hidden = 1;\n`,
  "packages/gamma/package.json": JSON.stringify({
    name: "@fixture/gamma",
    dependencies: { "@fixture/beta": "workspace:*" }
  }),
  "packages/delta/package.json": JSON.stringify({
    name: "@fixture/delta",
    devDependencies: { "@fixture/alpha": "workspace:*" }
  }),

  // Allowed: the CLI entry, the environment module, an adapter and a root test file.
  [`${source}/cli.ts`]: `console.log("started");\n`,
  [`${source}/env.ts`]: `export const mode = process.env.MODE;\n`,
  [`${source}/adapters/http.ts`]: `export const load = () => fetch("https://example.test");\n`,
  "tests/setup.test.ts": `console.log(process.env.MODE);\n`,
  // Also allowed: named members other than console, process, env and fetch, a `typeof` test
  // and a name in a type.
  [`${source}/host-allowed.ts`]: `export const inBrowser = typeof window !== "undefined" && typeof process === "undefined";
export const arch = process.arch;
export const { platform } = process;
export const address = globalThis.location;
export type Handler = (event: globalThis.Event) => void;
`,

  // typescript-eslint
  [`${source}/floating.ts`]: `Promise.resolve(1);\n`,
  [`${source}/misused.ts`]: `export const callback: () => void = async () => {};\n`,
  [`${source}/return-await.ts`]: `export async function execute() {
  try {
    return Promise.resolve(1);
  } finally {
    await Promise.resolve();
  }
}
`,
  [`${source}/non-null.ts`]: `const values: string[] = [];
export const first = values[0]!;
`,
  [`${source}/any.ts`]: `export const explicit: any = 1;\n`,
  [`${source}/any-module.mts`]: `export const explicit: any = 1;\n`,
  [`${source}/unsafe-assertion.ts`]: `const input: unknown = 1;
export const narrowed = input as number;
`,
  [`${source}/unnecessary-assertion.ts`]: `const count: number = 1;
export const same = count as number;
`,

  // Suppressions
  [`${source}/ts-comment.ts`]: `// @ts-expect-error fixture
export const wrong: number = "text";
`,
  [`${source}/inline-config.ts`]: `// eslint-disable-next-line max-lines
export const quiet = 1;
`,
  [`${source}/warned.ts`]: `debugger;\n`,

  // Console, environment and fetch boundaries, with each bypass
  [`${source}/console-member.ts`]: `console.log("example");\n`,
  [`${source}/console-destructured.ts`]: `const { log } = console;
log("example");
`,
  [`${source}/console-alias.ts`]: `export const logger = console;\n`,
  [`${source}/console-host.ts`]: `globalThis.console.log("example");\n`,
  [`${source}/env-member.ts`]: `export const mode = process.env.MODE;\n`,
  [`${source}/env-computed.ts`]: `export const mode = process["env"].MODE;\n`,
  [`${source}/env-destructured.ts`]: `const { env } = process;
export const mode = env.MODE;
`,
  [`${source}/env-import.ts`]: `import process from "node:process";
export const mode = process.arch;
`,
  [`${source}/env-named-import.ts`]: `import { env } from "node:process";
export const mode = env.MODE;
`,
  [`${source}/env-alias.ts`]: `const p = process;
export const mode = p.env.MODE;
`,
  [`${source}/env-host.ts`]: `export const mode = globalThis.process.env.MODE;\n`,
  [`${source}/env-require.cjs`]: `module.exports = require("node:process").arch;\n`,
  [`${source}/fetch-call.ts`]: `export const response = fetch("https://example.test");\n`,
  [`${source}/fetch-alias.ts`]: `export const transport = fetch;\n`,
  [`${source}/fetch-member.ts`]: `export const transport = globalThis.fetch;\n`,
  [`${source}/fetch-destructured.ts`]: `const { fetch: send } = globalThis;
export const transport = send;
`,
  [`${source}/host-alias.ts`]: `const g = globalThis;
export const response = g.fetch("https://example.test");
`,
  [`${source}/host-nested.ts`]: `export const response = window.self.fetch("https://example.test");\n`,
  [`${source}/host-computed.ts`]: `const name = "fetch" as string;
export const transport: unknown = Reflect.get(self, name);
`,

  // Package boundaries, with each bypass
  [`${source}/deep-import.ts`]: `export { hidden } from "@fixture/beta/src/internal";\n`,
  [`${source}/deep-dynamic-import.ts`]: `export const hidden = import("@fixture/beta/src/internal");\n`,
  [`${source}/deep-require.cjs`]: `module.exports = require("@fixture/beta/src/internal");\n`,
  [`${source}/relative-file.ts`]: `export { value } from "../../beta/src/index";\n`,
  [`${source}/relative-package.ts`]: `export { value } from "../../beta";\n`,
  [`${source}/relative-require.cjs`]: `module.exports = require("../../beta/src/index.ts");\n`,
  [`${source}/undeclared-edge.ts`]: `export { value } from "@fixture/beta";\n`,
  [`${source}/cycle-a.ts`]: `import { b } from "./cycle-b";
export const a: number = b;
`,
  [`${source}/cycle-b.ts`]: `import { a } from "./cycle-a";
export const b: number = a;
`,

  // Size, retired stores and database skips
  [`${source}/large.ts`]: `export const large = 1;\n${"//\n".repeat(800)}`,
  [`${source}/limit.ts`]: `export const limit = 1;\n${"//\n".repeat(799)}`,
  [`${source}/memory-store.ts`]: `declare const settings: { STORE?: string };
export const inMemory = settings.STORE === "memory";
`,
  "tests/database.test.ts": `declare const describe: { skip(name: string, run: () => void): void };
const url = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
describe.skip(String(url), () => {});
`,

  // Knip
  [`${source}/index.ts`]: `export { used } from "./lib/values";\n`,
  [`${source}/lib/values.ts`]: `export const used = 1;
export const unusedExport = 2;
export type UnusedType = string;
`,
  [`${source}/lib/orphan.ts`]: `export const orphan = 1;\n`,

  // Compiler
  [`${source}/type-error.ts`]: `export const wrong: number = "text";\n`,
  [`${source}/unused-local.ts`]: `const unused = 1;
export {};
`,
  "tests/type-error.test.ts": `export const wrong: number = "text";\n`
};

// Files added after the formatter has run once over the project.
const unformatted: Record<string, string> = {
  [`${source}/unformatted.ts`]: `export   const spaced = 1;\n`,
  [`${source}/format-ignored.ts`]: `// ${formatIgnore}
export   const spaced = 1;
`
};

let directory = "";

function write(files: Record<string, string>) {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
}

function link(target: string, path: string) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  symlinkSync(target, join(directory, path), "dir");
}

function collect(...args: string[]) {
  return spawnSync(process.execPath, [join(qualityConfig, "check.mjs"), ...args], {
    cwd: directory,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
}

/** The measured findings of one target as sorted "rule file" lines. */
function measure(target: string) {
  const result = collect(target, "--measure");
  expect(result.stderr).toBe("");
  const findings: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(findings)) throw new Error("The collector did not print a list");
  return findings.map((finding) => `${finding.rule} ${finding.file}`).sort();
}

beforeAll(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "catalyst-quality-")));
  write(project);
  link(qualityConfig, "node_modules/@vivd-catalyst/quality-config");
  link(join(directory, "packages/beta"), "node_modules/@fixture/beta");
  expect(spawnSync("git", ["init", "--quiet"], { cwd: directory }).status).toBe(0);
});

afterAll(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe("quality collector", { timeout: 180_000 }, () => {
  it("reports unformatted files and formatting suppressions against the baseline", () => {
    expect(collect("format", "--write").status).toBe(0);
    expect(measure("format")).toEqual([]);
    expect(collect("format").status).toBe(0);

    write(unformatted);
    expect(measure("format")).toEqual([
      `prettier ${source}/unformatted.ts`,
      `prettier/ignore-comment ${source}/format-ignored.ts`
    ]);
    const unbaselined = collect("format");
    expect(unbaselined.status).toBe(1);
    expect(unbaselined.stderr).toContain("measured 1, baseline 0; repair the increase");

    const entry = { target: "format", scope: "packages/alpha", owner: "CB-1a" };
    write({
      "quality-baseline.json": `${JSON.stringify(
        {
          version: 1,
          entries: [
            { ...entry, rule: "prettier", count: 1 },
            { ...entry, rule: "prettier/ignore-comment", count: 2 }
          ]
        },
        null,
        2
      )}\n`
    });
    const stale = collect("format");
    expect(stale.status).toBe(1);
    expect(stale.stderr).toBe(
      "format|prettier/ignore-comment|packages/alpha: measured 1, baseline 2; lower the baseline\n"
    );
  });

  it("reports every lint rule once per violating file, including the bypasses", () => {
    const findings = measure("lint");
    expect(findings.filter((finding) => !finding.startsWith("knip/"))).toEqual(
      [
        `@typescript-eslint/no-floating-promises ${source}/floating.ts`,
        `@typescript-eslint/no-misused-promises ${source}/misused.ts`,
        `@typescript-eslint/return-await ${source}/return-await.ts`,
        `@typescript-eslint/no-non-null-assertion ${source}/non-null.ts`,
        `@typescript-eslint/no-explicit-any ${source}/any.ts`,
        `@typescript-eslint/no-explicit-any ${source}/any-module.mts`,
        `@typescript-eslint/no-unsafe-type-assertion ${source}/unsafe-assertion.ts`,
        `@typescript-eslint/no-unnecessary-type-assertion ${source}/unnecessary-assertion.ts`,
        `@typescript-eslint/ban-ts-comment ${source}/ts-comment.ts`,
        `eslint/inline-config ${source}/inline-config.ts`,
        `no-debugger ${source}/warned.ts`,
        `catalyst/console-boundary ${source}/console-member.ts`,
        `catalyst/console-boundary ${source}/console-destructured.ts`,
        `catalyst/console-boundary ${source}/console-alias.ts`,
        `catalyst/console-boundary ${source}/console-host.ts`,
        `catalyst/env-boundary ${source}/env-member.ts`,
        `catalyst/env-boundary ${source}/env-computed.ts`,
        `catalyst/env-boundary ${source}/env-destructured.ts`,
        `catalyst/env-boundary ${source}/env-import.ts`,
        `catalyst/env-boundary ${source}/env-named-import.ts`,
        `catalyst/env-boundary ${source}/env-require.cjs`,
        `catalyst/env-boundary ${source}/env-alias.ts`,
        `catalyst/env-boundary ${source}/env-host.ts`,
        `catalyst/fetch-boundary ${source}/fetch-call.ts`,
        `catalyst/fetch-boundary ${source}/fetch-alias.ts`,
        `catalyst/fetch-boundary ${source}/fetch-member.ts`,
        `catalyst/fetch-boundary ${source}/fetch-destructured.ts`,
        `catalyst/host-object-boundary ${source}/host-alias.ts`,
        `catalyst/host-object-boundary ${source}/host-nested.ts`,
        `catalyst/host-object-boundary ${source}/host-computed.ts`,
        `import-x/no-unresolved ${source}/deep-import.ts`,
        `import-x/no-unresolved ${source}/deep-dynamic-import.ts`,
        `import-x/no-unresolved ${source}/deep-require.cjs`,
        `import-x/no-relative-packages ${source}/relative-file.ts`,
        `import-x/no-relative-packages ${source}/relative-package.ts`,
        `import-x/no-relative-packages ${source}/relative-require.cjs`,
        `catalyst/module-cycle ${source}/cycle-a.ts`,
        `max-lines ${source}/large.ts`,
        `catalyst/memory-store ${source}/memory-store.ts`,
        `catalyst/database-skip tests/database.test.ts`,
        "catalyst/package-cycle quality-package-graph.json",
        "catalyst/package-cycle quality-package-graph.json",
        "catalyst/package-graph packages/delta/package.json",
        "catalyst/package-graph quality-package-graph.json"
      ].sort()
    );
    expect(findings).toEqual(
      expect.arrayContaining([
        `knip/unlisted ${source}/undeclared-edge.ts`,
        `knip/files ${source}/lib/orphan.ts`,
        `knip/exports ${source}/lib/values.ts`,
        `knip/types ${source}/lib/values.ts`,
        "knip/dependencies packages/alpha/package.json"
      ])
    );
  });

  it("reports compiler errors and unused declarations in packages and tests", () => {
    expect(measure("types:packages")).toEqual(
      expect.arrayContaining([
        `typescript/package-errors ${source}/type-error.ts`,
        `typescript/unused ${source}/unused-local.ts`
      ])
    );
    expect(measure("types:tests")).toContain("typescript/test-errors tests/type-error.test.ts");
  });
});
