import { workspaceDependencyFixtures } from "./quality-dependency-fixtures";

export const source = "packages/alpha/src";
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

export const project: Record<string, string> = {
  ".gitignore": "node_modules\n",
  "package.json": JSON.stringify({
    name: "fixture",
    private: true,
    workspaces: ["packages/*", "clients/*"]
  }),
  "eslint.config.mjs": `import config from "@work-shape/catalyst-quality-config";
export default [...config, { rules: { "catalyst/retired-terms": "error" } }, { files: ["**/warned.ts"], rules: { "no-debugger": "warn" } }];
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
    include: ["packages", "clients", "tests"]
  }),
  "tsconfig.tests.json": JSON.stringify({ extends: "./tsconfig.lint.json", include: ["tests"] }),
  "quality-baseline.json": JSON.stringify({ version: 1, entries: [] }),
  // Beta and gamma depend on each other in their manifests.
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
    type: "module",
    exports: { ".": "./src/index.ts" },
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
  [`${source}/inline-config.ts`]: `// eslint-disable-next-line no-debugger
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
  "packages/server/package.json": JSON.stringify({ name: "@fixture/chat-server" }),
  "packages/server/src/http/route.ts": `${httpServer}export const register = (url: string) => app.route({ method: "GET", url, handler });\n`,
  "packages/server/src/routes/better-auth-routes.ts": `${httpServer}app.route({ method: "GET", url: "/api/auth/*", handler });
app.route({ method: "GET", url: "/api/users", handler });
`,
  // The module switches: refused however a server source reads them from the config, and
  // allowed in the package that parses and resolves them.
  "packages/server/src/module-member.ts": `declare const options: { config: { modules: object } };
export const switches = options.config.modules;
`,
  "packages/server/src/module-destructured.ts": `declare const config: { modules: object };
export const { modules } = config;
`,
  "packages/server/src/module-snapshot.ts": `declare const options: { modules: object };
export const snapshot = options.modules;
`,
  "packages/config-schema/package.json": JSON.stringify({ name: "@fixture/config-schema" }),
  "packages/config-schema/src/normalization.ts": `declare const config: { modules: object };
export const normalized = config.modules;
`,
  "packages/document-worker/package.json": JSON.stringify({ name: "@fixture/document-worker" }),
  "packages/document-worker/src/index.ts": `${httpServer}app.get("/health", handler);
app.get("/ready", handler);
app.get("/internal/pages", handler);
app.get("/api/pages", handler);
export const register = (path: string) => app.get(path, handler);
`,

  // The model gateway: who calls an adapter, who writes usage, who knows a provider type
  "packages/model-provider/package.json": JSON.stringify({ name: "@fixture/model-provider" }),
  "packages/model-provider/src/types.ts": `export interface ModelAdapter {
  complete(): void;
  stream(): void;
}
export interface ModelGateway {
  complete(): void;
}
`,
  "packages/model-provider/src/adapters/openai.ts": `export const adapter = 1;\n`,
  // The gateway calls the adapter, registration loads it, and anyone may call the gateway.
  "packages/model-provider/src/gateway.ts": `import type { ModelAdapter } from "./types";
export const send = (adapter: ModelAdapter) => adapter.complete();
`,
  "packages/model-provider/src/registration.ts": `export { adapter } from "./adapters/openai";\n`,
  "packages/model-provider/src/gateway-caller.ts": `import type { ModelGateway } from "./types";
export const send = (gateway: ModelGateway) => gateway.complete();
`,
  "packages/model-provider/src/adapter-call.ts": `import type { ModelAdapter } from "./types";
export const send = (adapter: ModelAdapter) => adapter.complete();
`,
  "packages/model-provider/src/adapter-destructured.ts": `import type { ModelAdapter } from "./types";
export const read = (adapter: ModelAdapter) => {
  const { stream } = adapter;
  return stream;
};
`,
  "packages/model-provider/src/adapter-picked.ts": `import type { ModelAdapter } from "./types";
export const send = (provider: Pick<ModelAdapter, "complete">) => provider.complete();
`,
  "packages/model-provider/src/adapter-load.ts": `export { adapter } from "./adapters/openai";\n`,
  // Inside model-provider a provider type may be named.
  "packages/model-provider/src/provider-type.ts": `declare const type: string;
export const openAi = type === "openai-compatible";
`,
  [`${source}/usage-write.ts`]: `declare const store: Record<string, () => void>;
store.appendModelUsageEvent?.();
`,
  [`${source}/usage-record.ts`]: `declare const governance: Record<string, () => void>;
export const { recordModelUsage } = governance;
`,
  [`${source}/usage-picked.ts`]: `declare const governance: Record<"recordModelUsage", () => void>;
export const recorder = governance;
`,
  [`${source}/usage-insert.ts`]: `export const text = "insert into model_usage_events (id) values ($1)";\n`,
  [`${source}/usage-table.ts`]: `declare const db: { insert(table: unknown): void };
declare const modelUsageEvents: unknown;
db.insert(modelUsageEvents);
`,
  [`${source}/provider-type.ts`]: `declare const type: string;
export const openAi = type === "openai-compatible";
`,
  [`${source}/provider-type-list.ts`]: `declare const type: string;
export const known = ["openai-compatible"].includes(type);
`,
  [`${source}/provider-type-switch.ts`]: `declare const type: string;
export function streams() {
  switch (type) {
    case "openai-compatible":
      return true;
    default:
      return false;
  }
}
`,
  [`${source}/provider-type-read.ts`]: `interface ModelProviderConfig {
  type: string;
}
declare const provider: ModelProviderConfig;
declare const other: string;
export const same = provider.type === other;
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
  // The command lease left the list with the move onto the executor: put back, it is a finding.
  "packages/tool-execution/src/workspace-command-worker.ts": `export class WorkspaceCommandWorker {
  runClaimedCommand() {
    return setInterval(() => {}, 1000);
  }
}
`,
  "packages/postgres-store/src/postgres-execution-workspace-operations.ts": `
export const claimNextWorkspaceCommand = () => "select id from c for update skip locked";
export const recoverStaleWorkspaceCommands = () => "select id from c for update skip locked";
`,
  "packages/agent-runtime/package.json": JSON.stringify({ name: "@fixture/agent-runtime" }),
  // The run lease left the list last, with the list itself: every timer here is a finding.
  "packages/agent-runtime/src/agent-run-worker.ts": `export class AgentRunWorker {
  runClaimed() {
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
  // The command queue outside its client: a tool that queues, and one that reads the row. The
  // client itself is where both belong.
  "packages/tool-execution/src/workspace-tools/queue-member.ts": `declare const store: { enqueueWorkspaceCommand(): void };
export const queued = store.enqueueWorkspaceCommand();
`,
  "packages/tool-execution/src/workspace-tools/queue-destructured.ts": `declare const store: { getWorkspaceCommand(): void };
export const { getWorkspaceCommand } = store;
`,
  "packages/tool-execution/src/workspace-command-client.ts": `declare const store: { requestWorkspaceCommandCancellation(): void };
export const cancelled = store.requestWorkspaceCommandCancellation();
`,

  // Retired stores and database skips
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
  "tests/type-error.test.ts": `export const wrong: number = "text";\n`,
  ...workspaceDependencyFixtures
};

// Files added after the formatter has run once over the project.
export const unformatted: Record<string, string> = {
  [`${source}/unformatted.ts`]: `export   const spaced = 1;\n`,
  [`${source}/format-ignored.ts`]: `// ${formatIgnore}
export   const spaced = 1;
`
};
