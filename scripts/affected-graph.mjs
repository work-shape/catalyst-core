import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

/**
 * The suffix of a barrel's own node. A named import through a barrel depends on the barrel's
 * text (which names it re-exports from where) and on the files that define those names, not on
 * every other module the barrel re-exports.
 */
export const BARREL_NODE = "#barrel";

/**
 * Which files each test reaches, as `file -> files it depends on`, starting from `tests`. The
 * map also holds every module those files name without loading it (type-only imports, the
 * other modules of a barrel), with its own edges, so a file outside the map is one no module
 * names at all: SQL, a template, a worker started by its path.
 *
 * - A type-only import adds no edge: Vitest erases it, and typecheck:tests covers the types.
 * - A named import from a barrel (a module of nothing but `export … from` statements) goes to
 *   the barrel's own node and to the files that define the imported names, following re-exports
 *   and `export *` through further barrels. A default, namespace or side-effect import, an
 *   import of anything that is not a barrel, `import()` and `require` go to the whole module.
 *   Accepted risk: a module that a barrel re-exports and a test does not import by name runs
 *   when the barrel loads, so a side effect at its top level is not followed.
 * - A test's text naming `packages/<x>` or `clients/<x>` adds the edge `<dir>/`, for contract
 *   tests that read a package with fs or run its CLI; one naming quality-baseline.json depends
 *   on that file.
 *
 * @param {{ root: string, tests: string[], packageDirs: string[], options: ts.CompilerOptions }} input
 * @returns {Map<string, string[]>}
 */
export function testImportGraph({ root, tests, packageDirs, options }) {
  /** @type {Map<string, ts.SourceFile>} */
  const parsed = new Map();
  const sourceOf = (file) => {
    let source = parsed.get(file);
    if (!source) {
      source = ts.createSourceFile(
        file,
        readFileSync(resolve(root, file), "utf8"),
        ts.ScriptTarget.Latest,
        false
      );
      parsed.set(file, source);
    }
    return source;
  };
  /** @type {Map<string, string | null>} */
  const resolved = new Map();
  const resolveFrom = (specifier, file) => {
    const key = `${file}\0${specifier}`;
    if (!resolved.has(key)) {
      const found = ts.resolveModuleName(
        specifier,
        resolve(root, file),
        options,
        ts.sys
      ).resolvedModule;
      const path = found && relative(root, found.resolvedFileName).replaceAll("\\", "/");
      resolved.set(
        key,
        path && !path.startsWith("../") && !path.includes("node_modules/") ? path : null
      );
    }
    return resolved.get(key) ?? undefined;
  };
  const isCode = (file) => /\.(?:[cm]?[jt]sx?)$/u.test(file);

  /** @type {Map<string, boolean>} */
  const barrels = new Map();
  const isBarrel = (file) => {
    if (!barrels.has(file))
      barrels.set(
        file,
        isCode(file) &&
          existsSync(resolve(root, file)) &&
          sourceOf(file).statements.every(
            (statement) =>
              ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined
          )
      );
    return barrels.get(file) ?? false;
  };
  const hasExportModifier = (node) =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const bindingNames = (name) =>
    ts.isIdentifier(name)
      ? [name.text]
      : name.elements.flatMap((element) =>
          ts.isOmittedExpression(element) ? [] : bindingNames(element.name)
        );

  /**
   * Whether `file` exports `name`, read from its syntax. `undefined` where it cannot tell: a
   * module it cannot resolve or read.
   * @type {(file: string, name: string, seen?: Set<string>) => boolean | undefined}
   */
  const exportsName = (file, name, seen = new Set()) => {
    if (seen.has(file)) return false;
    seen.add(file);
    if (!isCode(file) || !existsSync(resolve(root, file))) return undefined;
    let unknown = false;
    for (const statement of sourceOf(file).statements) {
      if (ts.isExportDeclaration(statement)) {
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          if (clause.elements.some((element) => element.name.text === name)) return true;
        } else if (clause) {
          // `export * as name from`
          if (clause.name.text === name) return true;
        } else if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
          const target = resolveFrom(statement.moduleSpecifier.text, file);
          const found = target === undefined ? undefined : exportsName(target, name, seen);
          if (found) return true;
          if (found === undefined) unknown = true;
        }
      } else if (ts.isExportAssignment(statement)) {
        if (name === "default") return true;
      } else if (hasExportModifier(statement)) {
        if (ts.isVariableStatement(statement)) {
          if (
            statement.declarationList.declarations.some((declaration) =>
              bindingNames(declaration.name).includes(name)
            )
          )
            return true;
        } else if ("name" in statement && statement.name && ts.isIdentifier(statement.name)) {
          if (statement.name.text === name) return true;
        } else if (name === "default") return true;
      }
    }
    return unknown ? undefined : false;
  };

  /**
   * The nodes a named import of `name` from `file` depends on, or `undefined` where the name
   * cannot be followed and the whole module stands for it.
   * @type {(file: string, name: string, seen?: Set<string>) => string[] | undefined}
   */
  const definers = (file, name, seen = new Set()) => {
    if (!isBarrel(file)) return [file];
    if (seen.has(file)) return [];
    seen.add(file);
    const found = [`${file}${BARREL_NODE}`];
    for (const statement of sourceOf(file).statements) {
      if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) return undefined;
      const target = resolveFrom(statement.moduleSpecifier.text, file);
      const clause = statement.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          if (element.name.text !== name) continue;
          if (target === undefined) return undefined;
          const next = definers(target, (element.propertyName ?? element.name).text, seen);
          if (next === undefined) return undefined;
          found.push(...next);
        }
      } else if (clause) {
        if (clause.name.text !== name) continue;
        if (target === undefined) return undefined;
        found.push(target);
      } else {
        if (target === undefined) return undefined;
        const exported = exportsName(target, name);
        if (exported === undefined) return undefined;
        if (!exported) continue;
        const next = definers(target, name, seen);
        if (next === undefined) return undefined;
        found.push(...next);
      }
    }
    return found;
  };

  /** The edges of one file: every module it loads, narrowed through barrels where it can be. */
  const edgesOf = (file) => {
    const source = sourceOf(file);
    /** @type {Map<string, Set<string> | "whole">} */
    const named = new Map();
    /** @type {Map<string, number>} */
    const declared = new Map();
    const use = (specifier, names) => {
      const before = named.get(specifier);
      if (before === "whole" || names === "whole") named.set(specifier, "whole");
      else named.set(specifier, new Set([...(before ?? []), ...names]));
    };
    for (const statement of source.statements) {
      const specifier =
        (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : undefined;
      if (specifier === undefined) continue;
      declared.set(specifier, (declared.get(specifier) ?? 0) + 1);
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) use(specifier, "whole");
        else if (clause.isTypeOnly) continue;
        else if (clause.name) use(specifier, "whole");
        else if (clause.namedBindings && !ts.isNamedImports(clause.namedBindings))
          use(specifier, "whole"); // `import * as name from`
        else {
          const values = (clause.namedBindings?.elements ?? []).filter(
            (element) => !element.isTypeOnly
          );
          // Every name type-only: the import is erased, as `import type` is.
          if (values.length === 0) continue;
          use(
            specifier,
            values.map((element) => (element.propertyName ?? element.name).text)
          );
        }
      } else if (ts.isExportDeclaration(statement)) {
        if (statement.isTypeOnly) continue;
        const clause = statement.exportClause;
        if (clause && ts.isNamedExports(clause)) {
          const values = clause.elements.filter((element) => !element.isTypeOnly);
          if (values.length === 0) continue;
          use(
            specifier,
            values.map((element) => (element.propertyName ?? element.name).text)
          );
        } else use(specifier, "whole");
      }
    }
    // What the declarations above do not cover: `import()`, `require`, `import x = require()`.
    // preProcessFile lists every load, declarations included, so a specifier listed more often
    // than it has declarations is also loaded whole.
    const listed = new Map();
    for (const { fileName } of ts.preProcessFile(source.text, true, true).importedFiles) {
      const count = (listed.get(fileName) ?? 0) + 1;
      listed.set(fileName, count);
      if (count > (declared.get(fileName) ?? 0)) use(fileName, "whole");
    }
    const edges = [];
    // Every module the file names, loaded or type-only, is known to the graph without being an
    // edge, so that a change to one no test loads is not taken for a file outside the graph.
    const known = [...listed.keys()].flatMap((specifier) => resolveFrom(specifier, file) ?? []);
    for (const [specifier, names] of named) {
      const target = resolveFrom(specifier, file);
      if (target === undefined) continue;
      if (names === "whole") {
        edges.push(target);
        continue;
      }
      for (const name of names) {
        const nodes = definers(target, name);
        edges.push(...(nodes ?? [target]));
      }
    }
    return { edges: [...new Set(edges)], known };
  };

  /** @type {Map<string, string[]>} */
  const dependencies = new Map();
  const visit = (start) => {
    const open = [start];
    for (let file = open.pop(); file !== undefined; file = open.pop()) {
      if (file.endsWith("/") || dependencies.has(file)) continue;
      if (file.endsWith(BARREL_NODE)) {
        dependencies.set(file, []);
        continue;
      }
      if (!existsSync(resolve(root, file))) continue;
      const { edges, known } = isCode(file) ? edgesOf(file) : { edges: [], known: [] };
      if (file.startsWith("tests/")) {
        const text = sourceOf(file).text;
        for (const match of text.matchAll(/\b(?:packages|clients)\/[A-Za-z0-9._-]+/gu))
          if (packageDirs.includes(match[0])) edges.push(`${match[0]}/`);
        // A baseline edit still affects contracts that read it, without widening package checks.
        if (text.includes("quality-baseline.json")) edges.push("quality-baseline.json");
      }
      dependencies.set(file, edges);
      open.push(...edges, ...known);
    }
  };
  for (const test of tests) visit(test);
  return dependencies;
}
