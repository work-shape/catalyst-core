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

/**
 * The JSX nodes the literal-text rule reads. The estree types end before JSX.
 * @typedef {{ loc: import("estree").SourceLocation }} Located
 * @typedef {{ type: "JSXText", value: string }} JsxText
 * @typedef {{ type: "JSXExpressionContainer", expression: AnyNode | { type: "JSXEmptyExpression" } }} JsxExpression
 * @typedef {{ type: "JSXAttribute", value: AnyNode | JsxExpression | null }} JsxAttribute
 * @typedef {{ type: "TSAsExpression" | "TSSatisfiesExpression" | "TSNonNullExpression" | "TSTypeAssertion", expression: AnyNode }} TypeWrapper
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
 * The property names read from an object by static member access or by destructuring.
 * Undefined when the object is used in any other way: aliased, passed on, compared or read
 * with a computed key. No rule can follow the object after that.
 * @param {AnyNode} object
 * @returns {string[] | undefined}
 */
const staticReads = (object) => {
  const { parent } = /** @type {Node} */ (object);
  if (!parent) return undefined;
  // A `typeof` test and a name in a type read nothing from the object and cannot pass it on.
  if (
    (parent.type === "UnaryExpression" && parent.operator === "typeof") ||
    ["TSTypeQuery", "TSQualifiedName"].includes(parent.type)
  )
    return [];
  if (parent.type === "MemberExpression" && parent.object === object) {
    const name = keyName(parent.property, parent.computed);
    return name === undefined ? undefined : [name];
  }
  const pattern =
    parent.type === "VariableDeclarator" && parent.init === object
      ? parent.id
      : parent.type === "AssignmentExpression" &&
          parent.operator === "=" &&
          parent.right === object &&
          parent.parent?.type === "ExpressionStatement"
        ? parent.left
        : undefined;
  if (pattern?.type !== "ObjectPattern") return undefined;
  /** @type {string[]} */
  const names = [];
  for (const item of pattern.properties) {
    const name = item.type === "Property" ? keyName(item.key, item.computed) : undefined;
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names;
};

const hostObjects = ["globalThis", "global", "window", "self"];

/**
 * The references to a host object that statically read one of `members` from it, such as
 * `globalThis.fetch` or `const { console } = window`.
 * @param {Context} context
 * @param {string[]} members
 */
const hostMemberUses = (context, members) =>
  [...globalUses(context, hostObjects)].filter((host) =>
    staticReads(host)?.some((name) => members.includes(name))
  );

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

const letter = /\p{L}/u;

/**
 * Whether an expression is text written in the source: a string, a template with words in
 * it, or a condition or concatenation that yields one, with or without a type written around
 * it. A call such as `t("key")` is not, whatever it is given.
 * @param {AnyNode | JsxExpression | TypeWrapper | { type: "JSXEmptyExpression" } | null} node
 * @returns {boolean}
 */
const isLiteralText = (node) => {
  switch (node?.type) {
    case "JSXExpressionContainer":
    case "TSAsExpression":
    case "TSSatisfiesExpression":
    case "TSNonNullExpression":
    case "TSTypeAssertion":
      return isLiteralText(node.expression);
    case "Literal":
      return typeof node.value === "string" && letter.test(node.value);
    case "TemplateLiteral":
      return node.quasis.some((quasi) => letter.test(quasi.value.raw));
    case "ConditionalExpression":
      return isLiteralText(node.consequent) || isLiteralText(node.alternate);
    case "LogicalExpression":
      return isLiteralText(node.left) || isLiteralText(node.right);
    case "BinaryExpression":
      return node.operator === "+" && (isLiteralText(node.left) || isLiteralText(node.right));
    default:
      return false;
  }
};

/** @param {string} filename */
const isTestCaller = (filename) => {
  const path = relative(root, filename).replaceAll("\\", "/");
  return path.startsWith("tests/") && !path.startsWith("tests/support/");
};

/** @type {import("eslint").ESLint.Plugin} */
const plugin = {
  rules: {
    // ESLint's no-restricted-globals and no-restricted-properties would cover these three,
    // but under one rule name. The baseline counts by rule and each boundary has its own owner.
    "console-boundary": rule(
      "Console belongs in a CLI entry file",
      (filename) => packageAt(filename) !== undefined && !isCliEntry(filename),
      (context, report) => ({
        "Program:exit": () =>
          [...globalUses(context, ["console"]), ...hostMemberUses(context, ["console"])].forEach(
            report
          )
      })
    ),
    "env-boundary": rule(
      "Environment reads belong in the package's src/env.ts",
      (filename) => packageAt(filename) !== undefined && !isPackageFile(filename, "src/env.ts"),
      (context, report) => {
        /** @param {AnyNode} node */
        const check = (node) => {
          const loaded = loadedModule(node);
          if (loaded === "process" || loaded === "node:process") report(node);
        };
        return {
          // `process` may only be the object of a static read of something other than `env`.
          // Any other use, and any `process` taken from a host object, could reach `env`.
          "Program:exit": () =>
            [
              ...[...globalUses(context, ["process"])].filter(
                (process) => staticReads(process)?.includes("env") ?? true
              ),
              ...hostMemberUses(context, ["process"])
            ].forEach(report),
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
      (context, report) => ({
        "Program:exit": () =>
          [...globalUses(context, ["fetch"]), ...hostMemberUses(context, ["fetch"])].forEach(report)
      })
    ),
    // The three rules above follow a host object only through its named members. This rule
    // reports every other use of one, so that no alias reaches console, process or fetch.
    "host-object-boundary": rule(
      "globalThis, global, window and self are only read through named members",
      (filename) => packageAt(filename) !== undefined,
      (context, report) => ({
        "Program:exit": () =>
          [
            ...[...globalUses(context, hostObjects)].filter(
              (host) => staticReads(host) === undefined
            ),
            ...hostMemberUses(context, hostObjects)
          ].forEach(report)
      })
    ),
    "literal-text": {
      meta: {
        type: "problem",
        schema: [],
        messages: { violation: "Interface text belongs in the translations" }
      },
      create: (context) => {
        if (!packageAt(context.filename)) return {};
        /** @param {Located} node */
        const report = (node) => context.report({ loc: node.loc, messageId: "violation" });
        return {
          /** @param {JsxText & Located} node */
          JSXText: (node) => {
            if (letter.test(node.value)) report(node);
          },
          /** @param {JsxExpression & Located} node */
          ":matches(JSXElement, JSXFragment) > JSXExpressionContainer": (node) => {
            if (isLiteralText(node)) report(node);
          },
          /** @param {JsxAttribute & Located} node */
          "JSXAttribute[name.name=/^(aria-label|aria-description|aria-roledescription|title|placeholder|alt)$/]":
            (node) => {
              if (isLiteralText(node.value)) report(node);
            }
        };
      }
    },
    "test-api-path": rule(
      "Test callers name catalog operations; API paths belong in tests/support",
      isTestCaller,
      (_context, report) => ({
        Literal: (node) => {
          if (typeof node.value === "string" && node.value.startsWith("/api/")) report(node);
        },
        TemplateElement: (node) => {
          if (node.value.raw.startsWith("/api/")) report(node);
        }
      })
    ),
    "test-injection": rule(
      "HTTP injection belongs in tests/support; use instance.call",
      isTestCaller,
      (_context, report) => ({
        MemberExpression: (node) => {
          if (keyName(node.property, node.computed) === "inject") report(node);
        },
        VariableDeclarator: (node) => {
          if (
            node.id.type === "ObjectPattern" &&
            node.id.properties.some(
              (item) => item.type === "Property" && keyName(item.key, item.computed) === "inject"
            )
          )
            report(node);
        }
      })
    ),
    "test-store": rule(
      "Platform store classes belong in tests/support; use createTestInstance().stores",
      isTestCaller,
      (_context, report) => ({
        ImportSpecifier: (node) => {
          if (
            /^(?:InMemoryPlatformStore|PostgresPlatformStore)$/.test(
              keyName(node.imported, false) ?? ""
            )
          )
            report(node);
        },
        NewExpression: (node) => {
          if (
            node.callee.type === "Identifier" &&
            /^(?:InMemoryPlatformStore|PostgresPlatformStore)$/.test(node.callee.name)
          )
            report(node);
        },
        MemberExpression: (node) => {
          if (
            /^(?:InMemoryPlatformStore|PostgresPlatformStore)$/.test(
              keyName(node.property, node.computed) ?? ""
            )
          )
            report(node);
        }
      })
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
      "packages/api-client/src/generated/**",
      "packages/postgres-store/migrations/**",
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
