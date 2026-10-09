import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";
import { importX } from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

/**
 * @typedef {import("eslint").Rule.RuleContext} Context
 * @typedef {import("eslint").Rule.Node} Node
 * @typedef {import("estree").Node} AnyNode
 * @typedef {import("estree").Identifier} Identifier
 * @typedef {{ directory: string, bins: string[] }} WorkspacePackage
 */

const root = process.cwd();

/** @type {Map<string, WorkspacePackage>} */
const workspacePackages = new Map();

/**
 * The workspace package that owns a file. Root files (tests, scripts) have none.
 * @param {string} filename
 * @returns {WorkspacePackage | undefined}
 */
const packageAt = (filename) => {
  const directory = relative(root, filename)
    .replaceAll("\\", "/")
    .match(/^(?:packages|clients)\/[^/]+(?=\/)/)?.[0];
  if (!directory) return undefined;
  let found = workspacePackages.get(directory);
  if (!found) {
    const { bin } = JSON.parse(readFileSync(resolve(root, directory, "package.json"), "utf8"));
    found = { directory, bins: typeof bin === "string" ? [bin] : Object.values(bin ?? {}) };
    workspacePackages.set(directory, found);
  }
  return found;
};

/**
 * @param {string} filename
 * @param {string} path Path inside the owning package.
 */
const isPackageFile = (filename, path) => {
  const pkg = packageAt(filename);
  return pkg !== undefined && resolve(root, pkg.directory, path) === filename;
};

/**
 * A rule with one message. `inScope` decides per file whether the rule applies.
 * @param {string} message
 * @param {(filename: string) => boolean} inScope
 * @param {(context: Context, report: (node: AnyNode) => void) => import("eslint").Rule.RuleListener} visit
 * @returns {import("eslint").Rule.RuleModule}
 */
const rule = (message, inScope, visit) => ({
  meta: { type: "problem", schema: [], messages: { violation: message } },
  create: (context) =>
    inScope(context.filename)
      ? visit(context, (node) => context.report({ node, messageId: "violation" }))
      : {}
});

/**
 * Every reference to a global that the file does not declare itself. Scope analysis finds
 * them however they are used, so destructuring and aliasing cannot hide a reference.
 * @param {Context} context
 * @param {string[]} names
 * @returns {Set<AnyNode>}
 */
const globalUses = (context, names) => {
  const scope = context.sourceCode.scopeManager.globalScope;
  if (!scope) return new Set();
  const references = [
    ...scope.through,
    ...scope.variables
      .filter((variable) => variable.defs.length === 0)
      .flatMap((variable) => variable.references)
  ];
  return new Set(
    references
      .map((reference) => reference.identifier)
      .filter((identifier) => names.includes(identifier.name))
  );
};

/**
 * @param {AnyNode} key
 * @param {boolean} computed
 */
const keyName = (key, computed) =>
  key.type === "Identifier" && !computed
    ? key.name
    : key.type === "Literal" && typeof key.value === "string"
      ? key.value
      : undefined;

/**
 * Whether a node reads `property` from one of `objects`, by member access or by destructuring.
 * @param {AnyNode} node
 * @param {Set<AnyNode>} objects
 * @param {string} property
 */
const readsProperty = (node, objects, property) => {
  if (node.type === "MemberExpression")
    return objects.has(node.object) && keyName(node.property, node.computed) === property;
  if (node.type !== "VariableDeclarator" && node.type !== "AssignmentExpression") return false;
  const [pattern, source] =
    node.type === "VariableDeclarator" ? [node.id, node.init] : [node.left, node.right];
  return (
    !!source &&
    objects.has(source) &&
    pattern.type === "ObjectPattern" &&
    pattern.properties.some(
      /** @param {AnyNode} item */
      (item) => item.type !== "Property" || keyName(item.key, item.computed) === property
    )
  );
};

/**
 * The module a node loads, for static imports, dynamic imports and `require` calls.
 * @param {AnyNode} node
 */
const loadedModule = (node) => {
  const source =
    node.type === "ImportDeclaration" || node.type === "ImportExpression"
      ? node.source
      : node.type === "CallExpression" &&
          node.callee.type === "Identifier" &&
          node.callee.name === "require"
        ? node.arguments[0]
        : undefined;
  return source?.type === "Literal" && typeof source.value === "string" ? source.value : undefined;
};

/** @param {string} filename */
const isCliEntry = (filename) =>
  packageAt(filename)?.bins.some((bin) =>
    isPackageFile(
      filename,
      bin
        .replace(/^\.\//, "")
        .replace(/^dist\//, "src/")
        .replace(/\.js$/, ".ts")
    )
  ) ?? false;

/** @param {string} filename */
const mayFetch = (filename) =>
  packageAt(filename)?.directory === "packages/api-client" ||
  /[\\/](?:adapters|providers|connectors)[\\/]/.test(filename);

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  rules: {
    // ESLint's no-restricted-globals and no-restricted-properties would cover these three,
    // but under one rule name. The baseline counts by rule and each boundary has its own owner.
    "console-boundary": rule(
      "Console belongs in a CLI entry file",
      (filename) => packageAt(filename) !== undefined && !isCliEntry(filename),
      (context, report) => ({
        Program: () => globalUses(context, ["console"]).forEach(report)
      })
    ),
    "env-boundary": rule(
      "Environment reads belong in the package's src/env.ts",
      (filename) => packageAt(filename) !== undefined && !isPackageFile(filename, "src/env.ts"),
      (context, report) => {
        /** @type {Set<AnyNode>} */
        let processes = new Set();
        /** @param {AnyNode} node */
        const check = (node) => {
          const loaded = loadedModule(node);
          if (
            loaded === "process" ||
            loaded === "node:process" ||
            readsProperty(node, processes, "env")
          )
            report(node);
        };
        return {
          Program: () => void (processes = globalUses(context, ["process"])),
          MemberExpression: check,
          VariableDeclarator: check,
          AssignmentExpression: check,
          // The global `process` keeps environment reads visible to this rule.
          ImportDeclaration: check,
          ImportExpression: check,
          CallExpression: check
        };
      }
    ),
    "fetch-boundary": rule(
      "Fetch belongs in api-client or a provider or connector adapter",
      (filename) => packageAt(filename) !== undefined && !mayFetch(filename),
      (context, report) => {
        /** @type {Set<AnyNode>} */
        let hosts = new Set();
        /** @param {AnyNode} node */
        const check = (node) => {
          if (readsProperty(node, hosts, "fetch")) report(node);
        };
        return {
          Program: () => {
            globalUses(context, ["fetch"]).forEach(report);
            hosts = globalUses(context, ["globalThis", "window", "self"]);
          },
          MemberExpression: check,
          VariableDeclarator: check,
          AssignmentExpression: check
        };
      }
    ),
    "memory-store": rule(
      "CB-3b removes STORE=memory and the in-memory platform store",
      () => true,
      (_context, report) => ({
        /** @param {AnyNode} node */
        ":matches(BinaryExpression[operator=/^===?$/], LogicalExpression)": (node) => {
          if (
            (node.type === "BinaryExpression" || node.type === "LogicalExpression") &&
            node.left.type === "MemberExpression" &&
            keyName(node.left.property, node.left.computed) === "STORE" &&
            node.right.type === "Literal" &&
            node.right.value === "memory"
          )
            report(node);
        },
        "ClassDeclaration[id.name='InMemoryPlatformStore']": report,
        "NewExpression[callee.name='InMemoryPlatformStore']": report
      })
    ),
    "database-skip": rule(
      "CB-3b removes conditional database skips",
      () => true,
      (context, report) =>
        context.sourceCode.text.includes("POSTGRES_STORE_TEST_DATABASE_URL")
          ? { "MemberExpression[property.name=/^(skip|skipIf|runIf)$/]": report }
          : {}
    )
  }
};

const scripts = "js,jsx,mjs,cjs";
const typed = "ts,tsx,mts,cts";

/** @type {import("eslint").Linter.Config[]} */
const config = [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/vendor/**",
      "**/generated/**",
      "**/migrations/**",
      "**/.astro/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**"
    ]
  },
  {
    files: [`**/*.{${scripts},${typed}}`],
    // One parser for every source file lets the import rules follow imports across both kinds.
    languageOptions: { parser: tseslint.parser },
    // Inline directives never suppress a finding. ESLint warns about each one it meets, and
    // the collector counts that warning, so a directive is itself a baselined violation.
    linterOptions: { noInlineConfig: true },
    plugins: { catalyst: plugin, "import-x": importX },
    settings: {
      "import-x/extensions": [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      "import-x/resolver-next": [
        createTypeScriptImportResolver({ project: resolve(root, "tsconfig.lint.json") })
      ]
    },
    rules: {
      "max-lines": ["error", { max: 800 }],
      // Sibling packages are reached through their package name, never by a relative path.
      "import-x/no-relative-packages": ["error", { commonjs: true }],
      // A path that a package does not export does not resolve: no deep imports.
      // Astro supplies its `astro:` modules at build time.
      "import-x/no-unresolved": ["error", { commonjs: true, ignore: ["^astro:"] }],
      ...Object.fromEntries(
        Object.keys(plugin.rules ?? {}).map((name) => [`catalyst/${name}`, "error"])
      )
    }
  },
  {
    files: [`**/*.{${typed}}`],
    languageOptions: {
      parserOptions: { project: ["tsconfig.lint.json"], tsconfigRootDir: root }
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: false }],
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/return-await": ["error", "in-try-catch"],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/ban-ts-comment": [
        "error",
        { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true }
      ]
    }
  }
];

export default config;
