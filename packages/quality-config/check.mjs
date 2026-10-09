#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import { getFileInfo } from "prettier";
import ts from "typescript";
import { compareBaseline } from "./baseline.mjs";

/** @typedef {import("./baseline.mjs").Finding & { file: string, detail: string }} Finding */

const root = process.cwd();
const target = process.argv[2] ?? "";
const here = dirname(fileURLToPath(import.meta.url));
const formatted = "js,jsx,mjs,cjs,ts,tsx,mts,cts,json,css,scss,html,yml,yaml".split(",");

/**
 * Runs a tool and returns its output. A status outside `accepted` is a tool failure,
 * which no baseline can cover.
 * @param {string} command
 * @param {string[]} args
 * @param {number[]} accepted
 */
const run = (command, args, accepted) => {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  });
  if (result.status === null || !accepted.includes(result.status))
    throw new Error(
      `${command} ${args[0]} failed: ${result.error?.message ?? result.stderr + result.stdout}`
    );
  return result;
};
/** @param {string} stdout */
const lines = (stdout) => stdout.split("\n").filter(Boolean);
/** @param {string} path */
const readJson = (path) => JSON.parse(readFileSync(resolve(root, path), "utf8"));

// Git decides which files belong to the repository; each tool's own ignore list narrows it.
const files = lines(run("git", ["ls-files", "-co", "--exclude-standard"], [0]).stdout).filter(
  (file) => existsSync(resolve(root, file))
);

/** @type {Finding[]} */
const findings = [];
/**
 * @param {string} rule
 * @param {string} file
 * @param {string} detail
 */
const report = (rule, file, detail) => {
  const path = relative(root, resolve(root, file)).replaceAll("\\", "/");
  // Large files are counted per file; everything else per package.
  const scope =
    rule === "max-lines"
      ? path
      : (path.match(/^(?:packages|clients)\/[^/]+/)?.[0] ??
        (path.startsWith("../")
          ? "platform-source"
          : path.includes("/")
            ? path.slice(0, path.indexOf("/"))
            : "root"));
  findings.push({ target, rule, scope, file: path, detail });
};

/** @param {string} config */
const parseProject = (config) => {
  const result = ts.readConfigFile(resolve(root, config), ts.sys.readFile);
  if (result.error)
    throw new Error(ts.flattenDiagnosticMessageText(result.error.messageText, "\n"));
  return ts.parseJsonConfigFileContent(result.config, ts.sys, dirname(resolve(root, config)));
};

if (target === "format") {
  const patterns = [`**/*.{${formatted.join(",")}}`];
  const prettier = [resolve(here, "node_modules/prettier/bin/prettier.cjs")];
  if (process.argv.includes("--write")) {
    run(process.execPath, [...prettier, "--write", "--log-level", "warn", ...patterns], [0]);
  } else {
    const unformatted = run(
      process.execPath,
      [...prettier, "--list-different", ...patterns],
      [0, 1]
    );
    for (const file of lines(unformatted.stdout)) report("prettier", file, "File needs formatting");
    // An ignore comment would hide new formatting violations, so it is a violation itself.
    const comment = ["prettier", "ignore"].join("-");
    const suppressed = run(
      "git",
      ["grep", "--untracked", "-lIF", comment, "--", ...formatted.map((ext) => `*.${ext}`)],
      [0, 1]
    );
    for (const file of lines(suppressed.stdout)) {
      const info = await getFileInfo(resolve(root, file), {
        ignorePath: [resolve(root, ".gitignore"), resolve(root, ".prettierignore")]
      });
      if (!info.ignored) report("prettier/ignore-comment", file, "Formatting is suppressed");
    }
  }
} else if (target === "lint") {
  const eslint = new ESLint({ cwd: root, warnIgnored: false });
  const results = await eslint.lintFiles(
    files.filter((file) => /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file))
  );
  for (const result of results) {
    // Every message counts, whatever its severity: a rule set to "warn" still fails.
    for (const message of [...result.messages, ...result.suppressedMessages]) {
      const rule =
        message.ruleId ??
        (message.message.includes("noInlineConfig") ? "eslint/inline-config" : undefined);
      if (message.fatal || !rule)
        throw new Error(`${relative(root, result.filePath)}: ${message.message}`);
      report(rule, result.filePath, `${message.line}:${message.column} ${message.message}`);
    }
  }

  // Knip owns unused files, exports and dependencies, and imports that no manifest declares.
  // It exits with 1 when it has findings.
  const knip = run(
    process.execPath,
    [resolve(here, "node_modules/knip/bin/knip.js"), "--reporter", "json", "--no-progress"],
    [0, 1]
  );
  const knipReport = JSON.parse(knip.stdout);
  for (const file of knipReport.files ?? [])
    report("knip/files", typeof file === "string" ? file : file.file, "Unused file");
  for (const issue of knipReport.issues ?? []) {
    for (const [kind, values] of Object.entries(issue)) {
      if (kind === "file" || !Array.isArray(values)) continue;
      for (const value of values)
        report(
          `knip/${kind}`,
          issue.file,
          typeof value === "string" ? value : JSON.stringify(value)
        );
    }
  }

  // The declared package graph and the manifests must describe the same packages and edges.
  /** @type {Record<string, string[]>} */
  const graph = readJson("quality-package-graph.json");
  /** @type {Map<string, { file: string, edges: string[] }>} */
  const manifests = new Map();
  for (const file of files.filter((path) =>
    /^(?:packages|clients)\/[^/]+\/package\.json$/.test(path)
  )) {
    const manifest = readJson(file);
    const edges = ["dependencies", "peerDependencies", "devDependencies"].flatMap((key) =>
      Object.entries(manifest[key] ?? {})
        .filter(([, version]) => String(version).startsWith("workspace:"))
        .map(([name]) => name)
    );
    manifests.set(manifest.name, { file, edges: [...new Set(edges)].sort() });
  }
  for (const name of new Set([...Object.keys(graph), ...manifests.keys()])) {
    const manifest = manifests.get(name);
    const declared = graph[name] && [...graph[name]].sort();
    if (JSON.stringify(manifest?.edges) !== JSON.stringify(declared))
      report(
        "catalyst/package-graph",
        manifest?.file ?? "quality-package-graph.json",
        `${name}: manifest ${JSON.stringify(manifest?.edges)}, declared graph ${JSON.stringify(declared)}`
      );
  }
  /**
   * @param {string} from
   * @param {string} to
   * @param {Set<string>} seen
   * @returns {boolean}
   */
  const reaches = (from, to, seen) =>
    (graph[from] ?? []).some(
      (next) => next === to || (!seen.has(next) && reaches(next, to, seen.add(next)))
    );
  for (const name of Object.keys(graph))
    if (reaches(name, name, new Set()))
      report("catalyst/package-cycle", "quality-package-graph.json", `${name} depends on itself`);

  // Source-module cycles among the files ESLint linted, resolved by TypeScript with the lint
  // project's own options so that package aliases count. Modules that reach each other form
  // a group, and every member is one finding, so a module that joins a group raises the count.
  const sources = new Set(results.map((result) => result.filePath));
  const { options } = parseProject("tsconfig.lint.json");
  /** @type {Map<string, string[]>} */
  const imports = new Map();
  for (const file of sources) {
    const { importedFiles } = ts.preProcessFile(readFileSync(file, "utf8"), true, true);
    /** @type {string[]} */
    const edges = [];
    for (const { fileName } of importedFiles) {
      const module = ts.resolveModuleName(fileName, file, { ...options, allowJs: true }, ts.sys);
      const resolved = module.resolvedModule && resolve(module.resolvedModule.resolvedFileName);
      if (resolved && sources.has(resolved)) edges.push(resolved);
    }
    imports.set(file, edges);
  }
  // Tarjan's algorithm: `low` is the earliest module on the stack a module can reach.
  /** @type {Map<string, number>} */
  const order = new Map();
  /** @type {Map<string, number>} */
  const low = new Map();
  /** @type {string[]} */
  const stack = [];
  /** @param {string} file */
  const visit = (file) => {
    const index = order.size;
    order.set(file, index);
    low.set(file, index);
    stack.push(file);
    for (const next of imports.get(file) ?? []) {
      if (!order.has(next)) visit(next);
      if (stack.includes(next))
        low.set(file, Math.min(low.get(file) ?? index, low.get(next) ?? index));
    }
    if (low.get(file) !== index) return;
    const group = stack.splice(stack.indexOf(file)).sort();
    if (group.length === 1 && !imports.get(file)?.includes(file)) return;
    const members = group.map((member) => relative(root, member).replaceAll("\\", "/"));
    for (const member of group)
      report(
        "catalyst/module-cycle",
        member,
        `One of ${group.length} modules that import each other: ${members.join(", ")}`
      );
  };
  for (const file of sources) if (!order.has(file)) visit(file);
} else if (target === "types:packages" || target === "types:tests") {
  const configs =
    target === "types:tests"
      ? ["tsconfig.tests.json"]
      : files.filter(
          (file) =>
            /^(?:packages|clients)\/[^/]+\/tsconfig\.json$/.test(file) &&
            readJson(`${dirname(file)}/package.json`).scripts?.typecheck?.startsWith("tsc ")
        );
  const seen = new Set();
  for (const config of configs) {
    const parsed = parseProject(config);
    const program = ts.createProgram(parsed.fileNames, {
      ...parsed.options,
      noEmit: true,
      noUnusedLocals: true,
      noUnusedParameters: true
    });
    for (const diagnostic of [...parsed.errors, ...ts.getPreEmitDiagnostics(program)]) {
      const file = diagnostic.file?.fileName ?? config;
      const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const place = position ? `${position.line + 1}:${position.character + 1} ` : "";
      const detail = `${place}TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`;
      // A file shared by several compiler projects reports its findings once.
      const key = `${file}:${detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const rule = [6133, 6138, 6192, 6196].includes(diagnostic.code)
        ? "typescript/unused"
        : target === "types:tests"
          ? "typescript/test-errors"
          : "typescript/package-errors";
      report(rule, file, detail);
    }
  }
} else throw new Error(`Unknown quality target: ${target}`);

if (process.argv.includes("--measure")) console.log(JSON.stringify(findings, null, 2));
else if (!process.argv.includes("--write")) {
  const errors = compareBaseline(findings, readJson("quality-baseline.json"), target);
  console.log(
    `${target}: ${findings.length} measured findings; ${errors.length} baseline differences`
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  }
}
