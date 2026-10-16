#!/usr/bin/env node
/**
 * D3 replay: fold store factories into their query modules, without editing query bodies.
 * Run from platform: node scripts/freeze/d3-postgres-stores.mjs [--dry-run].
 * Apply the separate D3 hand-fix commit afterwards (cycle-free factory dependencies).
 * Uses the repository's TypeScript dependency; no additional dependencies.
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../../", import.meta.url));
const src = path.join(root, "packages/postgres-store/src");
const dryRun = process.argv.includes("--dry-run");
if (process.argv.slice(2).some((arg) => arg !== "--dry-run")) {
  throw new Error("Usage: node scripts/freeze/d3-postgres-stores.mjs [--dry-run]");
}

const targets = {
  access: "postgres-access-operations",
  agentRuns: "postgres-agent-run-operations",
  apiAccess: "postgres-api-access-operations",
  approvals: "postgres-approval-request-operations",
  audit: "postgres-audit-usage-operations",
  configAssets: "postgres-config-asset-operations",
  connections: "postgres-connection-operations",
  conversations: "postgres-conversation-operations",
  "data-stores": "postgres-data-store-operations",
  executionWorkspaces: "postgres-execution-workspace-operations",
  files: "postgres-file-store",
  guardrails: "postgres-guardrail-operations",
  infrastructure: "postgres-infrastructure-check-operations",
  "knowledge-bases": "postgres-knowledge-base-operations",
  liveOnceSwitches: "postgres-live-once-switch-operations",
  operationRuns: "postgres-operation-run-operations",
  pages: "postgres-page-operations",
  personalApiKeys: "postgres-personal-api-key-operations",
  structuredData: "postgres-structured-data-operations",
  usage: "postgres-usage-ledger",
  users: "postgres-user-operations",
  "workflow-runs": "postgres-workflow-run-operations",
  workspaces: "postgres-collaboration-workspace-operations"
};
const storeDirectory = path.join(src, "stores");
const expected = Object.keys(targets)
  .map((name) => `${name}.ts`)
  .sort();
const actual = fs.readdirSync(storeDirectory).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected)) {
  throw new Error("D3 store inventory changed; reconcile the explicit map before replaying");
}

const parse = (file, text) => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
const output = new Map();
const foldedBindings = new Map();
for (const [store, target] of Object.entries(targets)) {
  const destination = path.join(src, `${target}.ts`);
  if (!output.has(destination)) {
    output.set(destination, fs.existsSync(destination) ? fs.readFileSync(destination, "utf8") : "");
  }
  const original = output.get(destination);
  const base = parse(destination, original);
  const sourceFile = path.join(storeDirectory, `${store}.ts`);
  const source = parse(sourceFile, fs.readFileSync(sourceFile, "utf8"));
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text.startsWith("createPostgres") &&
      base.statements.some(
        (existing) =>
          ts.isFunctionDeclaration(existing) && existing.name?.text === statement.name.text
      )
    ) {
      throw new Error(
        `Factory already exists in ${destination}; refusing a partial or duplicate replay`
      );
    }
  }
  if (!original && !fs.existsSync(destination)) {
    // A query-bearing store has no existing query module to merge into: move it verbatim.
    let moved = source.text;
    for (const statement of [...source.statements].reverse()) {
      if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.startsWith("."))
        continue;
      const specifier = statement.moduleSpecifier;
      const relative = path.relative(
        path.dirname(destination),
        path.resolve(path.dirname(sourceFile), specifier.text)
      );
      const rewritten = relative.startsWith(".") ? relative : `./${relative}`;
      moved =
        moved.slice(0, specifier.getStart(source) + 1) + rewritten + moved.slice(specifier.end - 1);
    }
    output.set(destination, moved);
    console.log(`${dryRun ? "Would move" : "Move"} stores/${store}.ts -> ${target}.ts`);
    continue;
  }
  if (!foldedBindings.has(destination)) foldedBindings.set(destination, new Set());
  const ownBindings = foldedBindings.get(destination);
  const aliases = new Map();
  const moduleBindings = new Set();
  const imports = [];
  const importKeys = new Map();
  const bindings = new Map();

  function addImport(statement, specifier) {
    const clause = statement.importClause;
    if (!clause) throw new Error(`Unexpected side-effect import in ${sourceFile}`);
    const entries = [];
    if (clause.name) entries.push({ kind: "default", local: clause.name.text });
    if (clause.namedBindings && !("elements" in clause.namedBindings)) {
      entries.push({ kind: "module", local: clause.namedBindings.name.text });
    } else if (clause.namedBindings) {
      for (const item of clause.namedBindings.elements) {
        entries.push({
          kind: "named",
          local: item.name.text,
          imported: item.propertyName?.text ?? item.name.text,
          typeOnly: clause.isTypeOnly || item.isTypeOnly
        });
      }
    }
    for (const entry of entries) {
      const identity = `${specifier}:${entry.kind}:${entry.imported ?? ""}`;
      const previous = importKeys.get(identity);
      if (previous) {
        if (previous.local !== entry.local) aliases.set(entry.local, previous.local);
        if (!entry.typeOnly) previous.typeOnly = false;
        continue;
      }
      const binding = bindings.get(entry.local);
      if (binding && binding !== identity) {
        throw new Error(`Conflicting import ${entry.local} in ${destination}`);
      }
      const item = { ...entry, specifier };
      bindings.set(entry.local, identity);
      imports.push(item);
      importKeys.set(identity, item);
    }
  }

  for (const statement of base.statements) {
    if (ts.isImportDeclaration(statement)) addImport(statement, statement.moduleSpecifier.text);
  }
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    let specifier = statement.moduleSpecifier.text;
    if (specifier.startsWith(".")) {
      specifier = path.relative(
        path.dirname(destination),
        path.resolve(path.dirname(sourceFile), specifier)
      );
      if (!specifier.startsWith(".")) specifier = `./${specifier}`;
    }
    if (specifier === `./${target}`) {
      const named = statement.importClause?.namedBindings;
      if (named && !("elements" in named)) {
        moduleBindings.add(named.name.text);
        for (const statement of base.statements) {
          if (
            statement.name &&
            statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          )
            ownBindings.add(statement.name.text);
        }
      } else if (named) {
        for (const item of named.elements) {
          aliases.set(item.name.text, item.propertyName?.text ?? item.name.text);
          ownBindings.add(item.propertyName?.text ?? item.name.text);
        }
      }
    } else addImport(statement, specifier);
  }

  function replacement(name) {
    const seen = new Set();
    while (aliases.has(name) && aliases.get(name) !== name) {
      if (seen.has(name)) throw new Error(`Import alias cycle for ${name}`);
      seen.add(name);
      name = aliases.get(name);
    }
    return name;
  }
  function rewrite(context) {
    const visit = (node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression) &&
        moduleBindings.has(node.expression.text)
      ) {
        return ts.factory.createIdentifier(node.name.text);
      }
      if (
        ts.isQualifiedName(node) &&
        ts.isIdentifier(node.left) &&
        moduleBindings.has(node.left.text)
      ) {
        return ts.factory.createIdentifier(node.right.text);
      }
      if (ts.isIdentifier(node) && aliases.has(node.text)) {
        // A member name is not an imported binding (including shorthand store method names).
        const parent = node.parent;
        if (
          (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
          ((ts.isMethodDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
            parent.name === node)
        )
          return node;
        return ts.factory.createIdentifier(replacement(node.text));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return (node) => ts.visitNode(node, visit);
  }
  const bodies = source.statements.filter((statement) => !ts.isImportDeclaration(statement));
  const rewritten = bodies
    .map((statement) => {
      const result = ts.transform(statement, [rewrite]);
      const text = printer.printNode(ts.EmitHint.Unspecified, result.transformed[0], source);
      result.dispose();
      return text;
    })
    .join("\n\n");
  const grouped = new Map();
  for (const item of imports) {
    if (!grouped.has(item.specifier)) grouped.set(item.specifier, []);
    grouped.get(item.specifier).push(item);
  }
  const importText = [];
  for (const [specifier, items] of grouped) {
    const named = items.filter((item) => item.kind === "named");
    if (named.length)
      importText.push(
        `import { ${named
          .map(
            (item) =>
              `${item.typeOnly ? "type " : ""}${item.imported}${item.local === item.imported ? "" : ` as ${item.local}`}`
          )
          .join(", ")} } from ${JSON.stringify(specifier)};`
      );
    for (const item of items.filter((item) => item.kind !== "named")) {
      importText.push(
        `import ${item.kind === "module" ? "* as " : ""}${item.local} from ${JSON.stringify(specifier)};`
      );
    }
  }
  // Existing query declarations are copied verbatim, rather than printed by the AST printer.
  const lastImport = base.statements.filter(ts.isImportDeclaration).at(-1);
  const baseBody = original.slice(lastImport?.end ?? 0).trim();
  output.set(
    destination,
    `${importText.join("\n")}\n\n${baseBody ? `${baseBody}\n\n` : ""}${rewritten}\n`
  );
  console.log(`${dryRun ? "Would fold" : "Fold"} stores/${store}.ts -> ${target}.ts`);
}
const indexFile = path.join(src, "index.ts");
const index = fs
  .readFileSync(indexFile, "utf8")
  .replace(/(["'])\.\/stores\/([^"']+)\1/g, (_match, quote, store) => {
    if (!targets[store]) throw new Error(`Unknown store import ${store}`);
    return `${quote}./${targets[store]}${quote}`;
  });
output.set(indexFile, index);
// The folded functions become private only when no other query module imports them.
// Existing unused exports are outside this move and retain their baseline entry.
const queryFiles = fs
  .readdirSync(src, { recursive: true })
  .filter((file) => file.endsWith(".ts") && !file.startsWith("stores/"))
  .map((file) => path.join(src, file));
const sources = new Map(queryFiles.map((file) => [file, fs.readFileSync(file, "utf8")]));
for (const [file, content] of output) sources.set(file, content);
const referenced = new Map();
for (const [file, content] of sources) {
  for (const statement of parse(file, content).statements) {
    if (!ts.isImportDeclaration(statement) || !statement.moduleSpecifier.text.startsWith("."))
      continue;
    const target = path.resolve(path.dirname(file), `${statement.moduleSpecifier.text}.ts`);
    if (!referenced.has(target)) referenced.set(target, new Set());
    const used = referenced.get(target);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && !("elements" in bindings)) used.add("*");
    else if (bindings)
      for (const item of bindings.elements) used.add(item.propertyName?.text ?? item.name.text);
  }
}
for (const [file, candidates] of foldedBindings) {
  const used = referenced.get(file) ?? new Set();
  if (used.has("*")) continue;
  let content = output.get(file);
  const source = parse(file, content);
  const edits = [];
  for (const statement of source.statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      const kept = statement.exportClause.elements.filter(
        (item) => !candidates.has(item.name.text) || used.has(item.name.text)
      );
      if (kept.length === 0) edits.push([statement.getStart(source), statement.end, ""]);
      else if (kept.length !== statement.exportClause.elements.length)
        throw new Error(`Reconcile partial re-export in ${file}`);
    } else if (
      statement.name &&
      candidates.has(statement.name.text) &&
      !used.has(statement.name.text)
    ) {
      const exported = statement.modifiers?.find(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
      );
      if (exported) edits.push([exported.getStart(source), exported.end + 1, ""]);
    }
  }
  for (const [start, end, replacement] of edits.reverse())
    content = content.slice(0, start) + replacement + content.slice(end);
  output.set(file, content);
}
// All validation and rendering above finish before the first file is changed.
if (!dryRun) {
  for (const [file, content] of output) fs.writeFileSync(file, content);
  for (const file of expected) fs.unlinkSync(path.join(storeDirectory, file));
  fs.rmdirSync(storeDirectory);
  execFileSync(
    path.join(root, "packages/quality-config/node_modules/.bin/prettier"),
    ["--write", ...output.keys()],
    { stdio: "inherit" }
  );
}
