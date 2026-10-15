#!/usr/bin/env node
// Replay the approved D2 map from the platform root. Dry-run by default; --apply writes.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const prefix = "packages/chat-ui/src/";
const pairs = JSON.parse(readFileSync(new URL("./d2-chat-ui-moves.json", import.meta.url), "utf8"));
// Main added these after the scope branch: keep each in its existing feature area.
const laterFiles = new Set([
  "build-area/agent-unavailable.tsx",
  "assistant/message-day-marker.tsx",
  "assistant/thread-time.ts",
  "build-area/skill-files.tsx",
  "build-area/skill-form-model.ts",
  "i18n/skill-files.ts"
]);
const apply = process.argv.includes("--apply");
if (process.argv.slice(2).some((arg) => !["--apply", "--dry-run"].includes(arg))) {
  throw new Error("Usage: node scripts/freeze/d2-chat-ui.mjs [--dry-run | --apply]");
}
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);
const paths = new Set(tracked);
const moves = new Map();
for (const [from, to] of pairs) {
  if (!paths.has(prefix + from)) {
    if (laterFiles.has(from) && !paths.has(prefix + to)) continue;
    // Main replaced elapsed-time with thread-time before D2's replay.
    if (from === "assistant/elapsed-time.ts" && paths.has(prefix + "assistant/thread-time.ts"))
      continue;
    throw new Error(`Map source missing (or already moved): ${prefix + from}`);
  }
  if (existsSync(resolve(root, prefix + to))) throw new Error(`Destination exists: ${prefix + to}`);
  moves.set(resolve(root, prefix + from), resolve(root, prefix + to));
}
const destinations = new Set(moves.values());
if (destinations.size !== moves.size) throw new Error("Duplicate move destination");
const moduleOptions = { moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
const writes = new Map();
let specifiers = 0;
function targetFor(specifier, source) {
  const module = ts.resolveModuleName(specifier, source, moduleOptions, ts.sys).resolvedModule;
  if (module) return resolve(module.resolvedFileName);
  const exact = resolve(dirname(source), specifier);
  return paths.has(relative(root, exact)) ? exact : undefined;
}
function rewriteSpecifier(specifier, source, destination) {
  const target = targetFor(specifier, source);
  if (!target) throw new Error(`Cannot resolve ${specifier} in ${relative(root, source)}`);
  const nextTarget = moves.get(target) ?? target;
  if (source === destination && target === nextTarget) return specifier;
  let next = relative(dirname(destination), nextTarget);
  if (!extname(specifier)) {
    next = next.replace(/(?:\.d)?\.[cm]?[jt]sx?$/u, "");
    if (!specifier.endsWith("/index") && next.endsWith("/index")) next = next.slice(0, -6);
  } else if (/\.[cm]?js$/u.test(specifier)) {
    next = next.replace(/(?:\.d)?\.[cm]?[jt]sx?$/u, extname(specifier));
  }
  return next.startsWith(".") ? next : `./${next}`;
}

// Only D2's source and importers are parsed; unrelated package files are never rewritten.
for (const path of tracked) {
  if (!/\.[cm]?[jt]sx?$/u.test(path)) continue;
  if (
    !path.startsWith(prefix) &&
    !path.startsWith("tests/") &&
    !["vitest.config.ts"].includes(path)
  )
    continue;
  const source = resolve(root, path);
  const destination = moves.get(source) ?? source;
  let content = readFileSync(source, "utf8");
  const ast = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const edits = [];
  function visit(node) {
    if (ts.isStringLiteralLike(node) && node.text.startsWith(".")) {
      const parent = node.parent;
      const isModule =
        ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) &&
          parent.moduleSpecifier === node) ||
        (ts.isCallExpression(parent) && parent.expression.kind === ts.SyntaxKind.ImportKeyword) ||
        (ts.isExternalModuleReference(parent) && parent.expression === node) ||
        (ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent));
      const target = targetFor(node.text, source);
      const isFileUrl =
        ts.isNewExpression(parent) &&
        ts.isIdentifier(parent.expression) &&
        parent.expression.text === "URL" &&
        parent.arguments?.[0] === node;
      if (isModule || (isFileUrl && target && moves.has(target))) {
        const next = rewriteSpecifier(node.text, source, destination);
        if (next !== node.text) {
          edits.push({ start: node.getStart(ast) + 1, end: node.getEnd() - 1, next });
          specifiers++;
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(ast);
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    content = content.slice(0, edit.start) + edit.next + content.slice(edit.end);
  }
  if (edits.length) writes.set(source, content);
}

// Path-valued config, guard keys, source-reading tests and capacity references.
// Longest first preserves file-vs-folder resolution (i18n.tsx before i18n/).
const replacements = pairs
  .flatMap(([from, to]) => {
    const variants = [[from, to]];
    if (/\.[jt]sx?$/u.test(from)) {
      variants.push([from.replace(/\.[jt]sx?$/u, ""), to.replace(/\.[jt]sx?$/u, "")]);
      if (from.endsWith("/index.ts")) variants.push([from.slice(0, -9), to.slice(0, -9)]);
    }
    return variants.map(([oldPath, newPath]) => [prefix + oldPath, prefix + newPath]);
  })
  .sort(([a], [b]) => b.length - a.length);
const pathPattern = new RegExp(
  replacements.map(([from]) => from.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("|"),
  "gu"
);
const replacementMap = new Map(replacements);
for (const path of tracked) {
  if (!(
    path.startsWith("tests/") ||
    [
      "tsconfig.base.json",
      "vitest.config.ts",
      "quality-baseline.json",
      "packages/docs/src/content/docs/operate/capacity-and-limits.md"
    ].includes(path)
  ))
    continue;
  const source = resolve(root, path);
  const content = writes.get(source) ?? readFileSync(source, "utf8");
  const next = content.replace(pathPattern, (match) => replacementMap.get(match));
  if (next !== content) writes.set(source, next);
}

console.log(
  `${apply ? "Applying" : "Dry run:"} ${moves.size} moves, ${specifiers} relative specifiers, ${writes.size} rewritten files`
);
if (!apply) process.exit(0);
for (const [from, to] of moves) {
  mkdirSync(dirname(to), { recursive: true });
  execFileSync("git", ["mv", relative(root, from), relative(root, to)], { cwd: root });
}
for (const [source, content] of writes) writeFileSync(moves.get(source) ?? source, content);

// Longer module specifiers can wrap import declarations and config arrays.
execFileSync(
  process.execPath,
  [
    resolve(root, "packages/quality-config/node_modules/prettier/bin/prettier.cjs"),
    "--write",
    ...[...writes.keys()].map((source) => relative(root, moves.get(source) ?? source))
  ],
  { cwd: root, stdio: "pipe" }
);
