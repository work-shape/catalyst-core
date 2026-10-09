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

// The rule reads the receiver's type, so the fixture needs the type's name and nothing else.
const httpServer = `interface FastifyInstance {
  get(path: string, handler: () => void): void;
  post(path: string, handler: () => void): void;
  route(options: { method: string; url: string; handler: () => void }): void;
}
declare const app: FastifyInstance;
const handler = () => {};
`;

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
    "@fixture/config-cli": [],
    "@fixture/ghost": [],
    "@fixture/chat-server": [],
    "@fixture/document-worker": [],
    "@fixture/postgres-store": [],
    "@fixture/tool-execution": [],
    "@fixture/auth": []
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
  "packages/config-cli/package.json": JSON.stringify({ name: "@fixture/config-cli" }),
  "packages/config-cli/src/cli.ts": `console.log("started");\n`,
  [`${source}/env.ts`]: `export const mode = process.env.MODE;\n`,
  [`${source}/adapters/http.ts`]: `export const load = () => fetch("https://example.test");\n`,
  // An adapter is loaded by the package's registration and by a sibling adapter, and by no
  // other file, however it is loaded.
  [`${source}/registration.ts`]: `export { load } from "./adapters/http";\n`,
  [`${source}/adapters/sibling.ts`]: `export { load as reload } from "./http";\n`,
  [`${source}/adapter-import.ts`]: `import { load } from "./adapters/http"; export const loaded = load;\n`,
  [`${source}/adapter-export.ts`]: `export * from "./adapters/http";\n`,
  [`${source}/adapter-dynamic.ts`]: `export const loading = import("./adapters/http");\n`,
  [`${source}/lib/adapter-type.ts`]: `export type Load = typeof import("../adapters/http").load;\n`,
  "tests/setup.test.ts": `console.log(process.env.MODE);\n`,
  // Also allowed: named members other than console, process, env and fetch, a `typeof` test
  // and a name in a type.
  [`${source}/host-allowed.ts`]: `export const inBrowser = typeof window !== "undefined" && typeof process === "undefined";
export const arch = process.arch;
export const { platform } = process;
export const address = globalThis.location;
export type Handler = (event: globalThis.Event) => void;
`,

  // Test callers cannot hide HTTP paths, injection or store construction behind aliases.
  "tests/api-path.test.ts": `const path = "/api/conversations"; export { path };\n`,
  "tests/api-template.test.ts": "export const path = `/api/conversations/${String(1)}`;\n",
  "tests/injection.test.ts": `declare const server: { inject(): void }; server.inject();\n`,
  "tests/computed-injection.test.ts": `declare const server: { inject(): void }; server["inject"]();\n`,
  "tests/aliased-injection.test.ts": `declare const server: { inject(): void }; const { inject: send } = server; send();\n`,
  "tests/store-class.test.ts": `declare function createPostgresStores(): void; createPostgresStores();\n`,
  "tests/store-alias.test.ts": `import { createPostgresStores as Store } from "@fixture/beta"; export { Store };\n`,
  "tests/support/allowed.ts": `declare const server: { inject(): void }; server.inject(); export const path = "/api/conversations"; declare function createPostgresStores(): void; createPostgresStores();\n`,

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
  [`${source}/console-member.ts`]: `console.warn("example");\n`,
  [`${source}/console-destructured.ts`]: `const { log } = console;
log("example");
`,
  [`${source}/logger-interface.ts`]: `export interface OtherLogger { warn(input: unknown): void; }\n`,
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
  [`${source}/global-console.ts`]: `global.console.log("example");\n`,
  [`${source}/global-env.ts`]: `export const mode = global.process.env.MODE;\n`,
  [`${source}/global-fetch.ts`]: `export const response = global.fetch("https://example.test");\n`,
  [`${source}/global-alias.ts`]: `export const g = global;\n`,
  [`${source}/host-nested.ts`]: `export const response = window.self.fetch("https://example.test");\n`,
  [`${source}/host-computed.ts`]: `const name = "fetch" as string;
export const transport: unknown = Reflect.get(self, name);
`,

  // SQL imports are allowed only in the three persistence adapters.
  [`${source}/sql-import.ts`]: `import type { SQL } from "drizzle-orm"; export type Query = SQL;\n`,
  [`${source}/sql-dynamic.ts`]: `export const driver = import("postgres");\n`,
  [`${source}/sql-require.cjs`]: `module.exports = require("pg");\n`,
  [`${source}/sql-export.ts`]: `export * from "drizzle-orm/pg-core";\n`,
  [`${source}/sql-import-type.ts`]: `export type Query = import("drizzle-orm").SQL;\n`,
  "packages/auth/package.json": JSON.stringify({ name: "@fixture/auth" }),
  "packages/auth/src/allowed.ts": `import type { SQL } from "drizzle-orm"; export type Query = SQL;\n`,

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

  // Route registration: refused wherever the server is reached, however it is reached, and
  // allowed in the route helper and, for their own paths only, in the two exemptions.
  [`${source}/route-direct.ts`]: `${httpServer}app.get("/api/things", handler);\n`,
  [`${source}/route-options.ts`]: `${httpServer}app.route({ method: "GET", url: "/health", handler });\n`,
  [`${source}/route-alias.ts`]: `${httpServer}export const register = app.post;\n`,
  [`${source}/route-destructured.ts`]: `${httpServer}export const { route } = app;\n`,
  [`${source}/route-computed.ts`]: `${httpServer}app["get"]("/api/things", handler);\n`,
  [`${source}/route-renamed.ts`]: `${httpServer}const server = app;\nserver.get("/api/things", handler);\n`,
  "packages/chat-server/package.json": JSON.stringify({ name: "@fixture/chat-server" }),
  "packages/chat-server/src/http/route.ts": `${httpServer}export const register = (url: string) => app.route({ method: "GET", url, handler });\n`,
  "packages/chat-server/src/routes/better-auth-routes.ts": `${httpServer}app.route({ method: "GET", url: "/api/auth/*", handler });
app.route({ method: "GET", url: "/api/users", handler });
`,
  "packages/document-worker/package.json": JSON.stringify({ name: "@fixture/document-worker" }),
  "packages/document-worker/src/index.ts": `${httpServer}app.get("/health", handler);
app.get("/ready", handler);
app.get("/internal/pages", handler);
app.get("/api/pages", handler);
export const register = (path: string) => app.get(path, handler);
`,

  // Claim queries and interval timers outside the job executor
  [`${source}/claim-query.ts`]: "export const claim = `select 1 for update skip locked`;\n",
  [`${source}/claim-text.ts`]: `export const claim = "for update SKIP  LOCKED";\n`,
  [`${source}/claim-option.ts`]: `export const lock = { skipLocked: true };\n`,
  [`${source}/interval.ts`]: `export const timer = setInterval(() => {}, 1000);\n`,
  [`${source}/interval-host.ts`]: `export const timer = globalThis.setInterval(() => {}, 1000);\n`,
  [`${source}/interval-alias.ts`]: `const every = setInterval;\nexport const timer = every(() => {}, 1000);\n`,
  "packages/postgres-store/package.json": JSON.stringify({ name: "@fixture/postgres-store" }),
  // The executor's folder is where both belong.
  "packages/postgres-store/src/jobs/worker.ts": `export const claim = "for update skip locked";
export const heartbeat = setInterval(() => {}, 1000);
`,
  "packages/tool-execution/package.json": JSON.stringify({ name: "@fixture/tool-execution" }),
  // The preview lease left the exemption list when previews moved onto the executor: its
  // timer and its claim query are findings when they are put back.
  "packages/tool-execution/src/artifact-preview-worker.ts": `export class ArtifactPreviewWorker {
  startLeaseRenewal() {
    return setInterval(() => {}, 1000);
  }
}
`,
  "packages/postgres-store/src/postgres-artifact-preview-operations.ts": `export function claimNextArtifactPreviewJob() {
  return "select id from artifact_preview_jobs for update skip locked";
}
export function recoverStaleArtifactPreviewJobs() {
  return "select id from artifact_preview_jobs for update skip locked";
}
`,
  "packages/postgres-store/src/postgres-file-store.ts": `export function claimNextQueuedConversationAttachment() {
  return "select id from conversation_attachments for update skip locked";
}
`,
  // Two timers in this method are a named exemption. The third is the ninth occurrence. The
  // same timer under another name is not the exempted one.
  "packages/tool-execution/src/workspace-command-worker.ts": `export class WorkspaceCommandWorker {
  runClaimedCommand() {
    return [
      setInterval(() => {}, 1000),
      setInterval(() => {}, 1000),
      setInterval(() => {}, 1000)
    ];
  }
  runAnother() {
    return setInterval(() => {}, 1000);
  }
}
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

  // Literal interface text, in each place the rule reads, and what it leaves alone
  [`${source}/screens/text.tsx`]: `export const view = <p>Save changes</p>;\n`,
  [`${source}/screens/expression.tsx`]: `export const view = <p>{"Save changes"}</p>;\n`,
  [`${source}/screens/condition.tsx`]: `declare const saved: boolean;
declare const label: string;
export const view = <p>{saved ? "Saved" : label}</p>;
`,
  [`${source}/screens/fallback.tsx`]: `declare const label: string | undefined;
export const view = <>{label ?? "Untitled"}</>;
`,
  [`${source}/screens/template.tsx`]: `declare const count: number;
export const view = <p>{\`\${count} files\`}</p>;
`,
  [`${source}/screens/aria-label.tsx`]: `export const view = <button aria-label="Close" />;\n`,
  [`${source}/screens/title.tsx`]: `export const view = <button title={"Close"} />;\n`,
  [`${source}/screens/placeholder.tsx`]: `declare const scope: string;
export const view = <input placeholder={\`Search \${scope}\`} />;
`,
  [`${source}/screens/alt.tsx`]: `export const view = <img alt="Company logo" />;\n`,
  [`${source}/screens/aria-description.tsx`]: `export const view = <button aria-description="Closes the dialog" />;
`,
  [`${source}/screens/aria-roledescription.tsx`]: `export const view = <div aria-roledescription="slide" />;
`,
  [`${source}/screens/concatenation.tsx`]: `declare const count: number;
export const view = <p>{count + " files"}</p>;
`,
  [`${source}/screens/typed.tsx`]: `declare const wide: boolean;
export const view = <p title={"Close" satisfies string}>{(wide ? "Wide" : "Narrow") as string}</p>;
`,
  // The assertion is a finding of its own rules as well.
  [`${source}/screens/asserted.tsx`]: `export const view = <p>{"Saved"!}</p>;\n`,
  [`${source}/screens/translated.tsx`]: `declare const t: (key: string) => string;
declare const count: number;
export const view = (
  <label className="grid gap-1" title={t("save")} aria-label={t(count > 1 ? "saveAll" : "save")}>
    {t("save")} · {count} {\`\${count}/3\`} {count + 1} {t("unit") + ":"}
    <img alt="" src="logo.svg" />
    <input placeholder={t("name")} type="text" />
  </label>
);
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

// pnpm starts vitest with a NODE_PATH that reaches the packages hoisted by the surrounding
// install, and the import resolver follows it. Which packages are hoisted depends on the
// install, so the collector runs without it and the fixture resolves nothing but itself.
const { NODE_PATH: _hoisted, ...hermeticEnv } = process.env;

function collect(...args: string[]) {
  return spawnSync(process.execPath, [join(qualityConfig, "check.mjs"), ...args], {
    cwd: directory,
    env: hermeticEnv,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
}

/** The measured findings of one target as sorted "rule file" lines, or "rule scope" lines. */
function measure(target: string, place: "file" | "scope" = "file") {
  const result = collect(target, "--measure");
  expect(result.stderr).toBe("");
  const findings: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(findings)) throw new Error("The collector did not print a list");
  return findings.map((finding) => `${finding.rule} ${finding[place]}`).sort();
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
    expect(unbaselined.stderr).toContain(
      `format|prettier|packages/alpha: measured 1, baseline 0; repair the increase. Findings are in ${source}/unformatted.ts (1)\n`
    );
    expect(unbaselined.stderr).toContain(
      "After a repair, run `pnpm exec catalyst-quality format` again"
    );

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
        `catalyst/sql-boundary ${source}/sql-import.ts`,
        `catalyst/sql-boundary ${source}/sql-dynamic.ts`,
        `catalyst/sql-boundary ${source}/sql-require.cjs`,
        `catalyst/sql-boundary ${source}/sql-export.ts`,
        `catalyst/sql-boundary ${source}/sql-import-type.ts`,
        `import-x/no-unresolved ${source}/sql-dynamic.ts`,
        `import-x/no-unresolved ${source}/sql-require.cjs`,
        `import-x/no-unresolved ${source}/sql-export.ts`,
        `catalyst/logger-boundary ${source}/logger-interface.ts`,
        `catalyst/console-boundary ${source}/console-member.ts`,
        `catalyst/console-boundary ${source}/console-destructured.ts`,
        `catalyst/console-boundary ${source}/console-alias.ts`,
        `catalyst/console-boundary ${source}/console-host.ts`,
        `catalyst/console-boundary ${source}/global-console.ts`,
        `catalyst/env-boundary ${source}/global-env.ts`,
        `catalyst/fetch-boundary ${source}/global-fetch.ts`,
        `catalyst/host-object-boundary ${source}/global-alias.ts`,
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
        `catalyst/adapter-import ${source}/adapter-import.ts`,
        `catalyst/adapter-import ${source}/adapter-export.ts`,
        `catalyst/adapter-import ${source}/adapter-dynamic.ts`,
        `catalyst/adapter-import ${source}/lib/adapter-type.ts`,
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
        `catalyst/module-cycle ${source}/cycle-b.ts`,
        `catalyst/literal-text ${source}/screens/text.tsx`,
        `catalyst/literal-text ${source}/screens/expression.tsx`,
        `catalyst/literal-text ${source}/screens/condition.tsx`,
        `catalyst/literal-text ${source}/screens/fallback.tsx`,
        `catalyst/literal-text ${source}/screens/template.tsx`,
        `catalyst/literal-text ${source}/screens/aria-label.tsx`,
        `catalyst/literal-text ${source}/screens/title.tsx`,
        `catalyst/literal-text ${source}/screens/placeholder.tsx`,
        `catalyst/literal-text ${source}/screens/alt.tsx`,
        `catalyst/literal-text ${source}/screens/aria-description.tsx`,
        `catalyst/literal-text ${source}/screens/aria-roledescription.tsx`,
        `catalyst/literal-text ${source}/screens/concatenation.tsx`,
        `catalyst/literal-text ${source}/screens/typed.tsx`,
        `catalyst/literal-text ${source}/screens/typed.tsx`,
        `catalyst/literal-text ${source}/screens/asserted.tsx`,
        `@typescript-eslint/no-non-null-assertion ${source}/screens/asserted.tsx`,
        `@typescript-eslint/no-unnecessary-type-assertion ${source}/screens/asserted.tsx`,
        `catalyst/route-registration ${source}/route-direct.ts`,
        `catalyst/route-registration ${source}/route-options.ts`,
        `catalyst/route-registration ${source}/route-alias.ts`,
        `catalyst/route-registration ${source}/route-destructured.ts`,
        `catalyst/route-registration ${source}/route-computed.ts`,
        `catalyst/route-registration ${source}/route-renamed.ts`,
        "catalyst/route-registration packages/chat-server/src/routes/better-auth-routes.ts",
        "catalyst/route-registration packages/document-worker/src/index.ts",
        "catalyst/route-registration packages/document-worker/src/index.ts",
        `max-lines ${source}/large.ts`,
        `catalyst/job-executor-boundary ${source}/claim-query.ts`,
        `catalyst/job-executor-boundary ${source}/claim-text.ts`,
        `catalyst/job-executor-boundary ${source}/claim-option.ts`,
        `catalyst/job-executor-boundary ${source}/interval.ts`,
        `catalyst/job-executor-boundary ${source}/interval-host.ts`,
        `catalyst/job-executor-boundary ${source}/interval-alias.ts`,
        "catalyst/job-executor-boundary packages/postgres-store/src/postgres-artifact-preview-operations.ts",
        "catalyst/job-executor-boundary packages/postgres-store/src/postgres-artifact-preview-operations.ts",
        "catalyst/job-executor-boundary packages/postgres-store/src/postgres-file-store.ts",
        "catalyst/job-executor-boundary packages/tool-execution/src/artifact-preview-worker.ts",
        "catalyst/job-executor-boundary packages/tool-execution/src/workspace-command-worker.ts",
        "catalyst/job-executor-boundary packages/tool-execution/src/workspace-command-worker.ts",
        `catalyst/memory-store ${source}/memory-store.ts`,
        "catalyst/test-api-path tests/api-path.test.ts",
        "catalyst/test-api-path tests/api-template.test.ts",
        "catalyst/test-injection tests/injection.test.ts",
        "catalyst/test-injection tests/computed-injection.test.ts",
        "catalyst/test-injection tests/aliased-injection.test.ts",
        "catalyst/test-store tests/store-class.test.ts",
        "catalyst/test-store tests/store-alias.test.ts",
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

  it("counts literal interface text per folder and large files per file", () => {
    const scopes = measure("lint", "scope");
    expect(scopes.filter((scope) => scope.startsWith("catalyst/literal-text "))).toEqual(
      Array.from({ length: 15 }, () => `catalyst/literal-text ${source}/screens`)
    );
    expect(scopes).toContain(`max-lines ${source}/large.ts`);
    expect(scopes).toContain("catalyst/console-boundary packages/alpha");
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
