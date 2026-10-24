import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// Discover persistence and module-lifetime requirements separately. Follow runtime imports through
// test support, including re-exports, so a new test cannot silently join the pure pool by
// hiding its database access behind a helper. Type-only imports are erased by Vitest.
export const toolingFiles = [
  "tests/check-names.test.ts",
  "tests/ci-check-results.test.ts",
  "tests/config-cli-pty.test.ts",
  "tests/docs-commit-stamp.test.ts",
  "tests/migration-policy.test.ts",
  "tests/quality-asset-boundaries.test.ts",
  "tests/quality-baseline.test.ts",
  "tests/quality-collector.test.ts",
  "tests/quality-scoped-collector.test.ts",
  "tests/quality-sorted-barrel.test.ts",
  "tests/release-changelog.test.ts",
  "tests/release-cut.test.ts",
  "tests/release-public-tarball.test.ts",
  "tests/release-rename-scope.test.ts",
  "tests/resolve-only-run.test.ts",
  "tests/source-aliases.test.ts",
  "tests/suite-time.test.ts",
  "tests/vitest-configs.test.ts",
  "tests/vitest-projects.test.ts"
];

// These files failed when run together in one worker. They assert cold module state or
// replace DOM prototypes/observers that other render tests have already loaded. The timezone
// case also fails in a UTC thread, where setting process.env.TZ does not change Date.
const isolatedPureFiles = new Set([
  "tests/chat-ui-connection-typed.test.ts",
  "tests/chat-ui-connection-create.test.ts",
  "tests/chat-ui-thread-time.test.ts",
  "tests/chat-ui-workflow-fix-with-agent.test.ts",
  "tests/chat-ui-workflow-rights.test.ts",
  "tests/ui-chart.test.ts",
  "tests/ui-library-page-head-fold.test.ts",
  "tests/ui-table-fold.test.ts",
  "tests/ui-tabs-scroll.test.ts"
]);

// Shared-worker failures are documented in tests/support/test-projects.md.
const isolatedPostgresFiles = new Set([
  // Active-send and cancellation assertions require the deterministic model's real pacing.
  "tests/chat-server-agent-runs.test.ts",
  // Earlier files mutate administration defaults used by these pristine-default assertions.
  "tests/guardrail-config.test.ts",
  "tests/module-registry.test.ts",
  "tests/module-off.test.ts",
  "tests/skill-change-workflow.test.ts",
  // Rootless provider checks require the world's per-test real-timer cleanup.
  "tests/infrastructure.test.ts"
]);

export function testProjects(root: string) {
  const modules = new Map<string, { isolate: boolean; postgres: boolean; imports: string[] }>();
  function module(file: string) {
    const cached = modules.get(file);
    if (cached) return cached;
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    const result = { isolate: false, postgres: false, imports: [] as string[] };
    modules.set(file, result);
    function dependency(specifier: string) {
      if (specifier === "postgres" || specifier.startsWith("@work-shape/catalyst-postgres-store"))
        result.postgres = true;
      if (!specifier.startsWith(".")) return;
      const target = resolve(dirname(file), specifier);
      if (target.startsWith(resolve(root, "packages/postgres-store") + "/")) result.postgres = true;
      const found = [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`].find(
        (candidate) => existsSync(candidate) && /\.[cm]?[jt]sx?$/.test(candidate)
      );
      if (found?.startsWith(resolve(root, "tests") + "/")) result.imports.push(found);
    }
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (clause?.isTypeOnly) continue;
        if (
          clause?.namedBindings &&
          ts.isNamedImports(clause.namedBindings) &&
          !clause.name &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly)
        )
          continue;
        if (ts.isStringLiteralLike(statement.moduleSpecifier))
          dependency(statement.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.every((element) => element.isTypeOnly)
        )
          continue;
        if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier))
          dependency(statement.moduleSpecifier.text);
      }
    }
    function runtimeEffects(node: ts.Node) {
      // SSR cannot consume a requested connection draft through React effects. Its writers
      // must not leave that handoff in a shared worker for another file to render.
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "openConnectionDraft"
      )
        result.isolate = true;
      // Module mocks replace cached imports for the rest of a non-isolated worker.
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "vi" &&
        ["mock", "doMock"].includes(node.expression.name.text)
      )
        result.isolate = true;
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))
      ) {
        const specifier = node.arguments[0];
        if (specifier && ts.isStringLiteralLike(specifier)) dependency(specifier.text);
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "POSTGRES_STORE_TEST_DATABASE_URL"
      )
        result.postgres = true;
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "POSTGRES_STORE_TEST_DATABASE_URL"
      )
        result.postgres = true;
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "POSTGRES_STORE_TEST_DATABASE_URL"
      )
        result.postgres = true;
      ts.forEachChild(node, runtimeEffects);
    }
    runtimeEffects(source);
    return result;
  }
  function requirements(
    file: string,
    seen = new Set<string>()
  ): { postgres: boolean; isolate: boolean } {
    if (seen.has(file)) return { postgres: false, isolate: false };
    seen.add(file);
    const result = module(file);
    const children = result.imports.map((dependency) => requirements(dependency, seen));
    return {
      postgres: result.postgres || children.some((child) => child.postgres),
      isolate:
        isolatedPureFiles.has(relative(root, file).replaceAll("\\", "/")) ||
        isolatedPostgresFiles.has(relative(root, file).replaceAll("\\", "/")) ||
        result.isolate ||
        children.some((child) => child.isolate)
    };
  }
  const files = readdirSync(resolve(root, "tests"), { recursive: true })
    .filter((file): file is string => typeof file === "string" && file.endsWith(".test.ts"))
    .map((file) => relative(root, resolve(root, "tests", file)).replaceAll("\\", "/"));
  const classified = files.map((file) => ({ file, ...requirements(resolve(root, file)) }));
  return {
    pure: classified.filter((file) => !file.postgres && !file.isolate).map(({ file }) => file),
    postgres: classified.filter((file) => file.postgres && !file.isolate).map(({ file }) => file),
    isolated: classified.filter((file) => file.isolate).map(({ file }) => file)
  };
}
