import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

const qualityConfig = fileURLToPath(new URL("../packages/quality-config", import.meta.url));

// Use the shipped plugin. Only the receiver-type route guard needs a TS program.
const probe = `
import { Linter } from "eslint";
import { resolve, dirname } from "node:path";
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import tseslint from "typescript-eslint";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const fixtures = JSON.parse(input);
const root = realpathSync(mkdtempSync(resolve(tmpdir(), "catalyst-boundary-fixtures-")));
try {
  // Each typed fixture has its own on-disk file. CI's single-run TS programs read these
  // bytes; they must never type a synthetic replacement against a real product file.
  fixtures.forEach((fixture, index) => {
    fixture.file = resolve(root, "packages/quality-config", fixture.file);
    if (fixture.typed) {
      fixture.file = fixture.file.replace(/\\.ts$/, "-" + index + ".ts");
      fixture.source += "\\nexport {};";
    }
    mkdirSync(dirname(fixture.file), { recursive: true });
    writeFileSync(fixture.file, fixture.source);
  });
  for (const name of ["server", "ui", "chat-ui", "tool-execution"]) {
    const directory = resolve(root, "packages", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(resolve(directory, "package.json"), JSON.stringify({ name: "fixture-" + name }));
  }
  writeFileSync(resolve(root, "tsconfig.lint.json"), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, target: "ES2023", module: "ESNext" },
    include: ["packages/**/*.ts", "packages/**/*.tsx"]
  }));
  process.chdir(root);
  const { default: config } = await import("./eslint.config.mjs");
  const plugin = config.find(entry => entry.plugins?.catalyst).plugins.catalyst;
  const linter = new Linter();
  const results = fixtures.map(({ file, source, rule, typed }) => linter.verify(source, [{
    files: ["**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser, parserOptions: {
      ecmaFeatures: { jsx: true },
      ...(typed ? { project: resolve("tsconfig.lint.json"), tsconfigRootDir: root } : {})
    } },
    plugins: { catalyst: plugin },
    rules: { [rule]: "error" }
  }], { filename: file }));
  process.stdout.write(JSON.stringify(results));
} finally {
  process.chdir(tmpdir());
  rmSync(root, { recursive: true, force: true });
}
`;

const messages = z.array(z.array(z.object({ ruleId: z.string().nullable() })));
type Fixture = { file: string; source: string; typed?: boolean };
const probes: (Fixture & { rule: string })[] = [];
let results: (string | null)[][] = [];
// Register fixture batches while the suite is collected, then lint all of them once.
function findings(rule: string, fixtures: Fixture[]): () => (string | null)[][] {
  const offset = probes.length;
  probes.push(...fixtures.map((fixture) => ({ ...fixture, rule })));
  return () => results.slice(offset, offset + fixtures.length);
}
beforeAll(() => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: qualityConfig,
    input: JSON.stringify(probes),
    encoding: "utf8"
  });
  expect(result.status, result.stderr).toBe(0);
  results = messages.parse(JSON.parse(result.stdout)).map((rows) => rows.map((row) => row.ruleId));
});

const workspace = (file: string, source: string) => ({
  file: `../tool-execution/src/${file}`,
  source
});

describe("asset boundary lint fixtures", () => {
  {
    const rule = "catalyst/asset-head-description";
    const fixture = (source: string) => ({ file: "../chat-ui/src/feature/page.tsx", source });
    const invalid = [
      "asset.name",
      "name",
      "id",
      "assetId",
      "asset.id",
      "<code>{asset.id}</code>",
      '"<code>id</code>"'
    ];
    const headers = ["PageHeader", "AppHeader"].flatMap((tag) =>
      invalid.map((value) => fixture(`<${tag} description={\n${value}\n} />`))
    );
    const invalidHeaders = findings(rule, headers);
    const validHeaders = findings(rule, [
      fixture("<AppHeader description={asset.description} />"),
      fixture("<PageHeader description={t.description} />"),
      { file: "../ui/src/page.tsx", source: "<PageHeader description={id} />" }
    ]);
    it("rejects ids, names and code in an asset header, regardless of line breaks", () => {
      expect(headers.length).toBeGreaterThan(10);
      expect(invalidHeaders()).toEqual(headers.map(() => [rule]));
      expect(validHeaders()).toEqual([[], [], []]);
    });
  }

  {
    const rule = "catalyst/asset-head-description";
    const invalid = [
      "`${asset.id}`",
      "`Name: ${asset.name}`",
      "`${assetId}`",
      "`${name} (${id})`",
      '`${asset["id"]}`',
      "`${`nested ${asset.id}`}`"
    ];
    const fixtures = (values: string[]) =>
      ["PageHeader", "AppHeader"].flatMap((tag) =>
        values.map((value) => ({
          file: "../chat-ui/src/feature/page.tsx",
          source: `<${tag} description={${value}} />`
        }))
      );
    const headers = fixtures(invalid);
    const descriptions = fixtures([
      "`${asset.description}`",
      "`Purpose: ${description}`",
      "`Helpful text`"
    ]);
    const identityTemplates = findings(rule, headers);
    const descriptionTemplates = findings(rule, descriptions);
    it("rejects identity interpolations in header templates while allowing descriptions", () => {
      expect(identityTemplates()).toEqual(headers.map(() => [rule]));
      expect(descriptionTemplates()).toEqual(descriptions.map(() => []));
    });
  }

  {
    const rule = "catalyst/route-registration";
    const declaration =
      "interface FastifyInstance { get(path: string, handler: () => void): void; } declare const app: FastifyInstance;";
    const routeRegistrations = findings(rule, [
      {
        file: "../server/src/routes/config-routes.ts",
        typed: true,
        source: declaration + 'app.get("/private", () => {});'
      },
      { file: "../server/src/routes/config-routes.ts", typed: true, source: declaration }
    ]);
    it("rejects a planted route registration outside the catalog helper", () => {
      expect(routeRegistrations()).toEqual([[rule], []]);
    });
  }

  {
    const rule = "catalyst/chart-engine-import";
    const sources = [
      'import { init } from "echarts/core";',
      'import("echarts")',
      'require("echarts/charts")',
      'export { init } from "echarts/core";',
      'export * from "echarts/core";'
    ];
    const outsideChartImports = findings(
      rule,
      sources.map((source) => ({ file: "../ui/src/data/other.ts", source }))
    );
    const chartEngineImports = findings(rule, [
      { file: "../ui/src/data/chart-engine.ts", source: sources[0] ?? "" }
    ]);
    it("rejects ECharts imports outside the engine", () => {
      expect(outsideChartImports()).toEqual(sources.map(() => [rule]));
      expect(chartEngineImports()).toEqual([[]]);
    });
  }

  {
    const rule = "catalyst/workspace-handle-boundary";
    const sources = [
      "context.toolRequest.conversationId",
      "context.toolRequest?.conversationId",
      "context.toolRequest ?. conversationId",
      "const { conversationId } = context.toolRequest;",
      "const { conversationId: attribution, toolCallId } = context.toolRequest;",
      "const { conversationId } =\n context.toolRequest ?? {};",
      "({ conversationId } = context.toolRequest);",
      "const request = context.toolRequest;",
      "const { toolRequest } = context;",
      "const { toolRequest: request } = context;",
      'context["toolRequest"].conversationId',
      "context.toolRequest[key]",
      'const key = "toolRequest"; context[key].conversationId'
    ];
    const workspaceReads = findings(
      rule,
      sources.map((source) => workspace("workspace-tools/read.ts", source))
    );
    const workspaceOpenReads = findings(rule, [
      workspace("workspace-open-tool.ts", sources[0] ?? "")
    ]);
    const allowedWorkspaceReads = findings(rule, [
      workspace(
        "workspace-tools/workspace-handle-resolver.ts",
        "const conversationId =\n context.toolRequest ?. conversationId;"
      ),
      workspace(
        "workspace-tools/exec.ts",
        "({ agentRunId: context.toolRequest?.agentRunId, toolCallId: context.toolRequest?.toolCallId })"
      ),
      workspace("workspace-preview-images.ts", "if (!context.toolRequest) {}"),
      workspace(
        "workspace-tools/workspace-handle-resolver.ts",
        "const request = context.toolRequest;"
      ),
      workspace("workspace-tools/exec.ts", "context.toolRequest.conversationId"),
      workspace("workspace-preview-images.ts", "context.toolRequest.conversationId")
    ]);
    it("rejects workspace conversation reads, aliases and destructures, including workspace.open", () => {
      expect(workspaceReads()).toEqual(sources.map(() => [rule]));
      expect(workspaceOpenReads()).toEqual([[rule]]);
      expect(allowedWorkspaceReads()).toEqual([[], [], [], [rule], [rule], [rule]]);
    });
  }
});
