#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { getHeapStatistics } from "node:v8";
import { ESLint } from "eslint";
import { getFileInfo } from "prettier";
import ts from "typescript";
import { compareBaseline } from "./baseline.mjs";
import { syncSourcePaths } from "./source-aliases.mjs";

/** @typedef {import("./baseline.mjs").Finding & { file: string, detail: string }} Finding */

const root = process.cwd();
const target = process.argv[2] ?? "";
const staleAliases =
  "Source aliases differ from local or sibling platform package exports; run `pnpm exec catalyst-quality aliases --write` in this repository.";
const here = dirname(fileURLToPath(import.meta.url));
// Whole package scopes keep baseline counts exact. Children inherit the same selection.
const scopeFlag = process.argv.find((argument) => argument.startsWith("--scope-file="));
/** @type {string[] | undefined} */
const scopes = scopeFlag ? JSON.parse(readFileSync(scopeFlag.slice(13), "utf8")) : undefined;
/** @param {string} file */
const inScope = (file) =>
  !scopes || scopes.some((scope) => file === scope || file.startsWith(`${scope}/`));
const formatted = "js,jsx,mjs,cjs,ts,tsx,mts,cts,json,css,scss,html,yml,yaml".split(",");

// The type checks and each part of the lint keep whole TypeScript programs in memory. Measured
// on 12 October 2026: the type check of the tests needs 2.2 GB, the largest part of the lint
// and the type check of the packages 1.5 GB each. Node sizes its heap by the machine: 4 GB on
// a runner with 16 GB of memory, 2 GB on one with 8 GB, where first the lint and later the
// type check of the tests ran out of memory. On a smaller heap than this every target starts
// itself again with this one, so no caller has to set it and no target is left on the
// machine's default. It is the ceiling: a target that nears it is split, as the lint was.
const heapMegabytes = 4096;
if (
  getHeapStatistics().heap_size_limit < heapMegabytes * 1024 * 1024 &&
  !process.execArgv.some((argument) => argument.startsWith("--max-old-space-size"))
) {
  const again = spawnSync(
    process.execPath,
    [`--max-old-space-size=${heapMegabytes}`, ...process.execArgv, ...process.argv.slice(1)],
    { stdio: "inherit" }
  );
  if (again.error) throw again.error;
  process.exit(again.status ?? 1);
}

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
  // Literal interface text is counted per folder, so that a folder
  // with an owner cannot cover new text elsewhere in its package. Everything else per package.
  const scope =
    rule === "catalyst/literal-text"
      ? dirname(path)
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

// The typed lint needs a TypeScript program. One program for the whole repository, checked in
// one process, needed 3.2 GB. The lint therefore runs in parts: each process takes this many
// files in the order Git lists them, which keeps a package together, and builds a program from
// those files and what they import. The largest part needs under half of `heapMegabytes`.
const lintFilesPerProcess = 150;
const partFlag = "--lint-part=";
/** @typedef {{ messages: { rule: string, file: string, detail: string }[], files: string[] }} LintPart */

/**
 * Lints one part in this process.
 * @param {string[]} part
 * @returns {Promise<LintPart>}
 */
const lintPart = async (part) => {
  const parsed = parseProject("tsconfig.lint.json");
  // A declaration file and a file that declares globals or adds to another module change types
  // in files that never import them, so every part's program has all of them.
  const ambient = parsed.fileNames.filter(
    (file) =>
      file.endsWith(".d.ts") || /\bdeclare\s+(?:global|module)\b/.test(readFileSync(file, "utf8"))
  );
  const typed = part.filter((file) => /\.[cm]?tsx?$/.test(file)).map((file) => resolve(root, file));
  const program = ts.createProgram([...typed, ...ambient], parsed.options);
  const eslint = new ESLint({
    cwd: root,
    warnIgnored: false,
    overrideConfig: [
      {
        files: ["**/*.{ts,tsx,mts,cts}"],
        languageOptions: { parserOptions: { project: null, programs: [program] } }
      }
    ]
  });
  const results = await eslint.lintFiles(part);
  /** @type {LintPart} */
  const found = { messages: [], files: results.map((result) => result.filePath) };
  for (const result of results) {
    // Every message counts, whatever its severity: a rule set to "warn" still fails.
    for (const message of [...result.messages, ...result.suppressedMessages]) {
      const rule =
        message.ruleId ??
        (message.message.includes("noInlineConfig") ? "eslint/inline-config" : undefined);
      if (message.fatal || !rule)
        throw new Error(`${relative(root, result.filePath)}: ${message.message}`);
      found.messages.push({
        rule,
        file: result.filePath,
        detail: `${message.line}:${message.column} ${message.message}`
      });
    }
  }
  return found;
};

/**
 * Starts this program again for one part and returns what it printed.
 * @param {number} index
 * @returns {Promise<LintPart>}
 */
const startPart = (index) =>
  new Promise((done, failed) => {
    const child = spawn(
      process.execPath,
      [
        ...process.execArgv,
        process.argv[1] ?? "",
        "lint",
        `${partFlag}${index}`,
        ...(scopeFlag ? [scopeFlag] : [])
      ],
      { cwd: root, stdio: ["ignore", "pipe", "inherit"] }
    );
    /** @type {Buffer[]} */
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.on("error", failed);
    child.on("close", (status) => {
      if (status === 0) done(JSON.parse(Buffer.concat(output).toString("utf8")));
      else failed(new Error(`lint part ${index} failed with status ${status}`));
    });
  });

if (target === "aliases") {
  if (
    !(await syncSourcePaths(root, process.argv.includes("--write"))) &&
    !process.argv.includes("--write")
  ) {
    console.error(staleAliases);
    process.exitCode = 1;
  }
} else if (target === "format") {
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
  if (!(await syncSourcePaths(root))) {
    console.error(staleAliases);
    process.exit(1);
  }
  const lintable = files.filter((file) => inScope(file) && /\.(?:[cm]?[jt]s|[jt]sx)$/.test(file));
  const parts = Math.ceil(lintable.length / lintFilesPerProcess);
  const own = process.argv.find((argument) => argument.startsWith(partFlag));
  if (own) {
    // One part of the lint, started by the run below: it prints what it found and stops here.
    const index = Number(own.slice(partFlag.length));
    const part = await lintPart(
      lintable.slice(index * lintFilesPerProcess, (index + 1) * lintFilesPerProcess)
    );
    await new Promise((done) => process.stdout.write(JSON.stringify(part), done));
    process.exit(0);
  }
  /** @type {LintPart[]} */
  const linted = Array.from({ length: parts });
  let next = 0;
  const worker = async () => {
    for (let index = next++; index < parts; index = next++) linted[index] = await startPart(index);
  };
  await Promise.all(Array.from({ length: Math.min(3, availableParallelism(), parts) }, worker));
  for (const part of linted)
    for (const message of part.messages) report(message.rule, message.file, message.detail);
  const results = linted.flatMap((part) => part.files.map((filePath) => ({ filePath })));

  // Knip owns unused files, exports and dependencies. The collector below checks workspace
  // import declarations too, including clients, scripts and MDX that Knip does not cover.
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

  // Manifests are the only package graph. Every workspace import needs a declaration:
  // runtime source needs a runtime dependency; tests, scripts and config may use dev deps.
  /** @type {Record<string, string[]>} */
  const graph = {};
  /** @type {Map<string, { name: string, file: string, development: Set<string>, workspaceDevelopment: Set<string>, runtime: Set<string> }>} */
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
    graph[manifest.name] = [...new Set(edges)].sort();
    manifests.set(dirname(file), {
      name: manifest.name,
      file,
      development: new Set(Object.keys(manifest.devDependencies ?? {})),
      workspaceDevelopment: new Set(
        Object.entries(manifest.devDependencies ?? {})
          .filter(([, version]) => String(version).startsWith("workspace:"))
          .map(([name]) => name)
      ),
      runtime: new Set(
        ["dependencies", "peerDependencies", "optionalDependencies"].flatMap((key) =>
          Object.keys(manifest[key] ?? {})
        )
      )
    });
  }
  for (const file of files.filter(
    (path) =>
      inScope(path) &&
      /^(?:packages|clients)\/[^/]+\//.test(path) &&
      /\.(?:[cm]?[jt]sx?|astro|mdx)$/.test(path) &&
      !path.startsWith("clients/demo/seed/apps/")
  )) {
    const directory = file.split("/").slice(0, 2).join("/");
    const manifest = manifests.get(directory);
    if (!manifest) continue;
    const path = relative(directory, file);
    const inSource =
      path.startsWith("src/") &&
      !/(?:\.(?:test|spec|stories)\.[cm]?[jt]sx?$)|(?:^|\/)(?:tests?|__tests__|e2e|scripts|test-support)\//.test(
        path
      );
    // config-cli bundles declared dev dependencies into its public standalone executable.
    const devIsEnough = !inSource || manifest.name === "@work-shape/catalyst-cli";
    const imports = ts.preProcessFile(readFileSync(file, "utf8"), true, true).importedFiles;
    for (const name of new Set(
      imports.map(({ fileName }) => fileName.match(/^@[\w.-]+\/[\w.-]+/)?.[0])
    )) {
      if (
        !name ||
        name === manifest.name ||
        (!(name in graph) && !manifest.workspaceDevelopment.has(name)) ||
        manifest.runtime.has(name) ||
        (devIsEnough && manifest.development.has(name))
      )
        continue;
      report(
        inSource ? "catalyst/runtime-dependency" : "catalyst/workspace-dependency",
        file,
        `${name} ${manifest.development.has(name) ? "is only in devDependencies" : "is undeclared"}; imports need dependencies, peerDependencies or optionalDependencies${devIsEnough ? ", or devDependencies" : ""}`
      );
    }
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
      report(
        "catalyst/package-cycle",
        [...manifests.values()].find((manifest) => manifest.name === name)?.file ?? "package.json",
        `${name} depends on itself`
      );

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
            inScope(file) &&
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
  /** @type {import("./baseline.mjs").Baseline} */
  const baseline = readJson("quality-baseline.json");
  // Knip still resolves the complete workspace, then reports only selected package scopes.
  // Per-file and literal-text scopes are descendants of those package paths.
  const scopedFindings = findings.filter((finding) => inScope(finding.scope));
  const errors = compareBaseline(
    scopedFindings,
    {
      ...baseline,
      entries: baseline.entries.filter((entry) => inScope(entry.scope))
    },
    target
  );
  console.log(
    `${target}: ${findings.length} measured findings; ${errors.length} baseline differences`
  );
  if (errors.length) {
    console.error(errors.join("\n"));
    if (errors.some((error) => error.includes("repair the increase")))
      console.error(
        `Counts may only fall. After a repair, run \`pnpm exec catalyst-quality ${target}\` again until it reports 0 baseline differences; add \`--measure\` to list every finding with its file and position.`
      );
    process.exitCode = 1;
  }
}
