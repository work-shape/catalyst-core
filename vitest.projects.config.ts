import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";

// Keep persistence and instance fixtures in fresh workers. Follow runtime imports through
// test support, including re-exports, so a new test cannot silently join the pure pool by
// hiding its database access behind a helper. Type-only imports are erased by Vitest.
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

export function testProjects(root: string) {
  const modules = new Map<string, { isolate: boolean; imports: string[] }>();
  function module(file: string) {
    const cached = modules.get(file);
    if (cached) return cached;
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false);
    const result = { isolate: false, imports: [] as string[] };
    modules.set(file, result);
    function dependency(specifier: string) {
      if (specifier === "postgres" || specifier.startsWith("@work-shape/catalyst-postgres-store"))
        result.isolate = true;
      if (!specifier.startsWith(".")) return;
      const target = resolve(dirname(file), specifier);
      if (target.startsWith(resolve(root, "packages/postgres-store") + "/")) result.isolate = true;
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
        result.isolate = true;
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteralLike(node.argumentExpression) &&
        node.argumentExpression.text === "POSTGRES_STORE_TEST_DATABASE_URL"
      )
        result.isolate = true;
      if (
        ts.isBindingElement(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "POSTGRES_STORE_TEST_DATABASE_URL"
      )
        result.isolate = true;
      ts.forEachChild(node, runtimeEffects);
    }
    runtimeEffects(source);
    return result;
  }
  function needsIsolation(file: string, seen = new Set<string>()): boolean {
    if (isolatedPureFiles.has(relative(root, file).replaceAll("\\", "/"))) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    const { isolate, imports } = module(file);
    return isolate || imports.some((dependency) => needsIsolation(dependency, seen));
  }
  const files = readdirSync(resolve(root, "tests"), { recursive: true })
    .filter((file): file is string => typeof file === "string" && file.endsWith(".test.ts"))
    .map((file) => relative(root, resolve(root, "tests", file)).replaceAll("\\", "/"));
  return {
    pure: files.filter((file) => !needsIsolation(resolve(root, file))),
    isolated: files.filter((file) => needsIsolation(resolve(root, file)))
  };
}
