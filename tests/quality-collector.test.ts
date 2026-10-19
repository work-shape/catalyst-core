import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import qualityRules from "@work-shape/catalyst-quality-config";
import { project, source, unformatted } from "./support/quality-project";
import { lintFixtures, extraLintFiles } from "./support/quality-lint-fixtures";

// The real collector runs over a small project that breaks every rule once, including each
// way a rule used to be bypassed. Weakening a rule or the collection fails this test.

const qualityConfig = fileURLToPath(new URL("../packages/quality-config", import.meta.url));
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
  link(qualityConfig, "node_modules/@work-shape/catalyst-quality-config");
  link(join(directory, "packages/beta"), "node_modules/@fixture/beta");
  link(join(directory, "packages/gamma"), "node_modules/@fixture/gamma");
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

  it("allows environment reads only in a package's one env module and checks import.meta.env outside named frontend entries", () => {
    const read = "export const mode = process.env.MODE;\n";
    const allowed = {
      "packages/artifact-helpers/package.json": JSON.stringify({
        name: "@fixture/artifact-helpers"
      }),
      "packages/artifact-helpers/src/lib/env.ts": read,
      "packages/chat-ui/package.json": JSON.stringify({ name: "@fixture/chat-ui" }),
      "packages/chat-ui/src/env.js": read,
      "clients/chat-standalone/package.json": JSON.stringify({ name: "@fixture/chat-standalone" }),
      "clients/chat-standalone/src/main.tsx": "export const mode = import.meta.env.MODE;\n",
      // A script at the repository root belongs to no package.
      "scripts/env-script.mjs": read
    };
    const refused = {
      // A package of its own: the cleanup below removes every file written here, and the
      // project's packages are needed by the tests that follow.
      "packages/env-reader/package.json": JSON.stringify({ name: "@fixture/env-reader" }),
      "packages/env-reader/src/reader.ts": read,
      // The package root, a scripts folder and a second env module are not the one module.
      "packages/alpha/root-read.mjs": read,
      "packages/alpha/scripts/tool.mjs": read,
      [`${source}/scripts/tool.ts`]: read,
      [`${source}/nested/env.ts`]: read,
      // A package that keeps its module elsewhere has no second one at the usual path.
      "packages/artifact-helpers/src/env.ts": read,
      "packages/chat-ui/src/env.ts": read,
      [`${source}/import-meta-env.mts`]: "export const mode = import.meta.env.MODE;\n",
      [`${source}/import-meta-computed.mts`]: 'export const mode = import.meta["env"].MODE;\n',
      [`${source}/import-meta-alias.mts`]:
        "const meta = import.meta; export const mode = meta.env.MODE;\n"
    };
    const fixtures = { ...allowed, ...refused };
    try {
      write(fixtures);
      const findings = measure("lint").filter((finding) =>
        finding.startsWith("catalyst/env-boundary ")
      );
      for (const file of Object.keys(refused).filter((file) => !file.endsWith("package.json"))) {
        expect(findings).toContain(`catalyst/env-boundary ${file}`);
      }
      for (const file of Object.keys(allowed)) {
        expect(findings).not.toContain(`catalyst/env-boundary ${file}`);
      }
      write({ "clients/chat-standalone/src/main.tsx": read });
      expect(measure("lint")).toContain(
        "catalyst/env-boundary clients/chat-standalone/src/main.tsx"
      );
    } finally {
      for (const file of Object.keys(fixtures)) rmSync(join(directory, file), { force: true });
    }
  });

  let lintFindings: string[] | undefined;
  function fixtureFindings(): string[] {
    if (lintFindings) return lintFindings;
    try {
      write(extraLintFiles);
      lintFindings = measure("lint");
      return lintFindings;
    } finally {
      for (const file of Object.keys(extraLintFiles))
        rmSync(join(directory, file), { force: true });
    }
  }

  it("gives every catalyst lint rule a negative fixture", () => {
    const covered = lintFixtures.map(({ rule }) => rule);
    const rules = qualityRules.flatMap((entry) =>
      Object.keys(entry.plugins?.catalyst?.rules ?? {})
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) expect(covered).toContain(`catalyst/${rule}`);
  });

  it.each(lintFixtures)("reports $rule on its fixtures, including bypasses", ({ findings }) => {
    const measured = fixtureFindings();
    for (const finding of new Set(findings)) {
      expect(measured).toContain(finding);
      // Preserve multiplicity: two forbidden tokens in one file still count twice.
      expect(measured.filter((line) => line === finding)).toHaveLength(
        findings.filter((line) => line === finding).length
      );
    }
  });

  it("reports no lint findings on the clean fixtures", () => {
    const violating = new Set(
      lintFixtures.flatMap(({ findings }) =>
        findings.map((line) => line.slice(line.indexOf(" ") + 1))
      )
    );
    const clean = new Set(
      Object.keys({ ...project, ...unformatted }).filter((file) => !violating.has(file))
    );
    expect(
      fixtureFindings().filter(
        (line) => !line.startsWith("knip/") && clean.has(line.slice(line.indexOf(" ") + 1))
      )
    ).toEqual([]);
  });

  it("reports unused and unlisted declarations", () => {
    expect(fixtureFindings()).toEqual(
      expect.arrayContaining([
        `knip/unlisted ${source}/undeclared-edge.ts`,
        `knip/files ${source}/lib/orphan.ts`,
        `knip/exports ${source}/lib/values.ts`,
        `knip/types ${source}/lib/values.ts`,
        "knip/dependencies packages/alpha/package.json"
      ])
    );
  });

  it("fails undeclared workspace imports in client source, tools, package scripts and MDX", () => {
    const result = collect("lint");
    expect(result.status).toBe(1);
    for (const [rule, scope, file] of [
      ["runtime-dependency", "clients/demo", "src/undeclared.ts"],
      ["workspace-dependency", "clients/demo", "tools/undeclared.ts"],
      ["workspace-dependency", "packages/delta", "scripts/undeclared.mjs"],
      ["runtime-dependency", "packages/alpha", "src/undeclared.mdx"]
    ]) {
      expect(result.stderr).toContain(`lint|catalyst/${rule}|${scope}: measured`);
      expect(result.stderr).toContain(`${scope}/${file} (1)`);
    }
  });

  it("counts literal interface text per folder and other findings per package", () => {
    const scopes = measure("lint", "scope");
    expect(scopes.filter((scope) => scope.startsWith("catalyst/literal-text "))).toEqual(
      Array.from({ length: 15 }, () => `catalyst/literal-text ${source}/screens`)
    );
    expect(scopes).toContain("catalyst/console-boundary packages/alpha");
  });

  it("ratchets repeated allowed-value lists across packages", () => {
    const repeated = '["duplicate_first", "duplicate_second"]';
    const fixtures = {
      [`${source}/duplicate-values.ts`]: `declare const z: { enum(values: readonly string[]): unknown };
export const values = ${repeated} as const satisfies readonly string[];
export const schema = z
  .enum(${repeated});
`,
      "packages/beta/src/duplicate-values.ts": `export type Value = "duplicate_second" | "duplicate_first";
export const values = new Set(${repeated});
`,
      [`${source}/allowed-values.ts`]: `declare const configure: (value: string[]) => unknown;
export const defaults = configure(${repeated});
export const operation = { errors: ${repeated} };
export type Answer = { ok: true; status: "duplicate_first" | "duplicate_second" } | { ok: false };
`,
      "packages/asset-schemas/src/contract-values.ts": `export const VALUES = ${repeated} as const;\n`,
      ...Object.fromEntries(
        ["asset-schemas", "app-kit", "asset-repo", "ui"].map((name) => [
          `packages/${name}/package.json`,
          JSON.stringify({ name: `@fixture/${name}` })
        ])
      ),
      ...Object.fromEntries(
        ["app-kit", "asset-repo", "ui"].map((name) => [
          `packages/${name}/src/duplicate-values.ts`,
          `export const values = ${repeated} as const;\n`
        ])
      )
    };
    try {
      write(fixtures);
      expect(
        measure("lint").filter((finding) => finding.startsWith("catalyst/duplicate-literal-list "))
      ).toEqual([
        ...Array.from(
          { length: 2 },
          () => `catalyst/duplicate-literal-list ${source}/duplicate-values.ts`
        ),
        ...Array.from(
          { length: 2 },
          () => "catalyst/duplicate-literal-list packages/beta/src/duplicate-values.ts"
        )
      ]);
      const unbaselined = collect("lint");
      expect(unbaselined.status).toBe(1);
      expect(unbaselined.stderr).toContain(
        "lint|catalyst/duplicate-literal-list|packages/beta: measured 2, baseline 0; repair the increase"
      );
      // A selected package must still see an existing copy outside its scope.
      write({ "duplicate-scope.json": JSON.stringify(["packages/alpha"]) });
      const scoped = collect("lint", "--scope-file=duplicate-scope.json");
      expect(scoped.status).toBe(1);
      expect(scoped.stderr).toContain(
        "lint|catalyst/duplicate-literal-list|packages/alpha: measured 2, baseline 0; repair the increase"
      );
      expect(scoped.stderr).not.toContain("lint|catalyst/duplicate-literal-list|packages/beta");
    } finally {
      for (const file of [...Object.keys(fixtures), "duplicate-scope.json"])
        rmSync(join(directory, file), { force: true });
    }
  });

  it("ratchets retired terms in identifiers, strings, templates and JSX per package", () => {
    const fixtures = {
      [`${source}/retired-identifiers.ts`]: `export interface Namespace { namespaceId: string }
export const listNamespaces = (namespace: Namespace) => ({ namespace });
export const NAMESPACE_ID = "example";
`,
      [`${source}/retired-strings.ts`]:
        'export const route = "/namespaces"; export const escaped = "\\u006eamespace";\n',
      [`${source}/retired-template.ts`]: "export const route = `/namespaces/${1}`;\n",
      [`${source}/retired-jsx.tsx`]:
        'export const content = <NamespacePanel namespaceId="namespace">Namespaces</NamespacePanel>;\n',
      [`${source}/retired-private.ts`]:
        "export class Example { #namespace = 1; read() { return this.#namespace; } }\n",
      "packages/beta/src/retired-escaped.ts": 'export const names\\u0070aceId = "example";\n',
      [`${source}/retired-allowed.ts`]:
        '// Namespace retirement is tracked in NS-RETIRE.\nexport namespace Types { export type Id = string; }\nexport const space = "workspace";\n'
    };
    try {
      write(fixtures);
      const findings = measure("lint").filter((finding) =>
        finding.startsWith("catalyst/retired-terms ")
      );
      expect(findings).toEqual(
        [
          ...Array.from(
            { length: 7 },
            () => `catalyst/retired-terms ${source}/retired-identifiers.ts`
          ),
          ...Array.from({ length: 2 }, () => `catalyst/retired-terms ${source}/retired-strings.ts`),
          `catalyst/retired-terms ${source}/retired-template.ts`,
          ...Array.from({ length: 5 }, () => `catalyst/retired-terms ${source}/retired-jsx.tsx`),
          ...Array.from({ length: 2 }, () => `catalyst/retired-terms ${source}/retired-private.ts`),
          "catalyst/retired-terms packages/beta/src/retired-escaped.ts"
        ].sort()
      );
      const scopes = measure("lint", "scope").filter((finding) =>
        finding.startsWith("catalyst/retired-terms ")
      );
      expect(scopes).toEqual([
        ...Array.from({ length: 17 }, () => "catalyst/retired-terms packages/alpha"),
        "catalyst/retired-terms packages/beta"
      ]);
      const unbaselined = collect("lint");
      expect(unbaselined.status).toBe(1);
      expect(unbaselined.stderr).toContain(
        "lint|catalyst/retired-terms|packages/beta: measured 1, baseline 0; repair the increase"
      );
    } finally {
      for (const file of Object.keys(fixtures)) rmSync(join(directory, file), { force: true });
    }
  });

  it("excludes technical namespace terms while still reporting the product term", () => {
    const fixtures = {
      "packages/app-build/package.json": JSON.stringify({ name: "@fixture/app-build" }),
      "packages/app-kit/package.json": JSON.stringify({ name: "@fixture/app-kit" }),
      [`${source}/technical-terms.ts`]: `export const query = "select * from pg_namespace n join pg_class c on c.relnamespace = n.oid";
export const template = \`select namespace.nspname from pg_catalog.pg_namespace namespace where namespace.oid = \${1} and namespace.nspname = 'public'\`;
export const functionQuery = "select * from pg_proc p join pg_namespace as referenced_namespace on referenced_namespace.oid = p.pronamespace";
export const kind = "ImportNamespaceSpecifier";
export const message = "a shared process namespace";
`,
      "packages/app-build/src/bundle.ts": `const NAMESPACE = "page";
export const plugin = { namespace: NAMESPACE };
export function withoutNamespace(path: string) { return path; }
export const product = { namespaceId: "example" };
`,
      "packages/app-kit/scripts/release.mjs": 'export const plugin = { namespace: "kit-react" };\n',
      [`${source}/product-term.ts`]: 'export const namespaceId = "example";\n',
      // An exception in the same string must not hide a product reference.
      [`${source}/mixed-terms.ts`]:
        'export const query = "select namespaceId from pg_namespace namespace where namespace.nspname = public";\n',
      // The esbuild exceptions are exact identifiers in named files only.
      "packages/app-build/src/product.ts": 'export const namespace = "example";\n'
    };
    try {
      write(fixtures);
      expect(
        measure("lint").filter((finding) => finding.startsWith("catalyst/retired-terms "))
      ).toEqual(
        [
          `catalyst/retired-terms ${source}/product-term.ts`,
          `catalyst/retired-terms ${source}/mixed-terms.ts`,
          "catalyst/retired-terms packages/app-build/src/bundle.ts",
          "catalyst/retired-terms packages/app-build/src/product.ts"
        ].sort()
      );
    } finally {
      for (const file of Object.keys(fixtures)) rmSync(join(directory, file), { force: true });
    }
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

  it("checks every test group with shared ambient types and counts imported errors once", () => {
    const before = measure("types:tests");
    const fixtures: Record<string, string> = Object.fromEntries(
      Array.from({ length: 151 }, (_, index) => [
        `tests/group-${String(index).padStart(3, "0")}.ts`,
        'export { wrong } from "./type-error.test";\nexport const ambient: string = groupGlobal;\n'
      ])
    );
    fixtures["tests/zzz-ambient.ts"] =
      "export {};\ndeclare global { const groupGlobal: string; }\n";
    fixtures["tests/zzz-last.ts"] = 'export const last: boolean = "wrong";\n';
    try {
      write(fixtures);
      expect(measure("types:tests")).toEqual(
        [...before, "typescript/test-errors tests/zzz-last.ts"].sort()
      );
    } finally {
      for (const file of Object.keys(fixtures)) rmSync(join(directory, file), { force: true });
    }
  });

  it("returns every finding when a test group writes more than a pipe buffer", () => {
    const file = "tests/many-errors.test.ts";
    try {
      write({
        [file]: Array.from(
          { length: 1000 },
          (_, index) => `export const wrong${index}: number = "text";`
        ).join("\n")
      });
      expect(
        measure("types:tests").filter((finding) => finding === `typescript/test-errors ${file}`)
      ).toHaveLength(1000);
    } finally {
      rmSync(join(directory, file), { force: true });
    }
  });
});
