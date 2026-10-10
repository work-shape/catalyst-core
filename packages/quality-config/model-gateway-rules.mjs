import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * @typedef {import("eslint").Rule.RuleContext} Context
 * @typedef {import("eslint").Rule.Node} Node
 * @typedef {import("estree").Node} AnyNode
 * @typedef {{ file: string, count: number, removedBy: string }} Exemption
 * @typedef {{
 *   root: string,
 *   rule: (
 *     message: string,
 *     inScope: (filename: string) => boolean,
 *     visit: (context: Context, report: (node: AnyNode) => void) => import("eslint").Rule.RuleListener
 *   ) => import("eslint").Rule.RuleModule,
 *   packageAt: (filename: string) => { directory: string } | undefined,
 *   keyName: (key: AnyNode, computed: boolean) => string | undefined,
 *   loadedModule: (node: AnyNode) => string | undefined
 * }} Helpers
 */

const modelProvider = "packages/model-provider";

/**
 * Usage writes outside the gateway that predate the rule, each with the ticket that removes
 * it. `count` is how many the file holds; one more is a finding. The list only shrinks.
 * @type {Exemption[]}
 */
const usageWriteExemptions = [];

/**
 * Comparisons against a provider type outside model-provider that predate the rule. Both
 * files ask whether a model entry is the built-in one that answers without a provider: it
 * needs no `model` and no price. They leave when the adapter declares that itself. The list
 * only shrinks.
 * @type {Exemption[]}
 */
const providerTypeExemptions = [
  { file: "packages/config-schema/src/infrastructure.ts", count: 1, removedBy: "CB-6b" },
  { file: "packages/config-schema/src/validation.ts", count: 3, removedBy: "CB-6b" }
];

/**
 * The provider types the model adapters register, read from the adapter files so that a new
 * adapter is covered on the day it is added. Empty where the adapters are not on disk; the
 * typed half of the rule does not need the list.
 * @returns {Set<string>}
 */
const registeredModelProviderTypes = () => {
  const adapters = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../model-provider/src/adapters"
  );
  /** @type {Set<string>} */
  const types = new Set();
  let files;
  try {
    files = readdirSync(adapters);
  } catch {
    return types;
  }
  for (const file of files) {
    const source = readFileSync(resolve(adapters, file), "utf8");
    for (const match of source.matchAll(/port:\s*"models",\s*type:\s*"([^"]+)"/g))
      if (match[1]) types.add(match[1]);
  }
  return types;
};

const equality = ["==", "===", "!=", "!=="];
const usageWriters = [
  "recordModelUsage",
  "appendModelUsageEvent",
  "admitModelCall",
  "settleModelCall",
  "admitModelUsageEvent",
  "settleModelUsageEvent"
];
const usageInsert = /insert\s+into\s+(?:"?\w+"?\.)?"?model_usage_events\b/iu;

/**
 * The three boundaries around the model gateway: who calls an adapter, who writes a usage
 * event, and who knows which provider type answers.
 * @param {Helpers} helpers
 * @returns {Record<string, import("eslint").Rule.RuleModule>}
 */
export const modelGatewayRules = ({ root, rule, packageAt, keyName, loadedModule }) => {
  /** @param {string} filename */
  const pathOf = (filename) => relative(root, filename).replaceAll("\\", "/");
  const adaptersDirectory = resolve(root, modelProvider, "src/adapters");
  const providerTypes = registeredModelProviderTypes();

  /**
   * Reports the findings of one file beyond what its exemption allows.
   * @param {Context} context
   * @param {Exemption[]} exemptions
   * @param {AnyNode[]} found
   * @param {(node: AnyNode) => void} report
   */
  const reportBeyondExemption = (context, exemptions, found, report) => {
    const file = pathOf(context.filename);
    const allowed = exemptions.find((entry) => entry.file === file)?.count ?? 0;
    found.slice(allowed).forEach(report);
  };

  /**
   * Tests of the adapters and of the transports behind them. They call what they test.
   * @param {string} path
   */
  const isAdapterTest = (path) =>
    /^tests\/(?:model-(?:provider|adapter)[^/]*|provider-error-redaction)\.test\.ts$/.test(path);

  /**
   * Where a type's property is declared: the interface or class and its file. A property
   * picked or inherited from one counts as declared there.
   * @param {import("typescript").Type} type
   * @param {string} name
   * @returns {{ owner: string, file: string }[]}
   */
  const declarersOf = (type, name) =>
    (type.isUnionOrIntersection() ? type.types : [type]).flatMap((part) =>
      (part.getProperty(name)?.getDeclarations() ?? []).map((declaration) => {
        const { parent } = declaration;
        return {
          owner:
            ts.isInterfaceDeclaration(parent) || ts.isClassDeclaration(parent)
              ? (parent.name?.text ?? "")
              : "",
          file: declaration.getSourceFile().fileName
        };
      })
    );

  return {
    // The gateway resolves, admits, retries and records. A call that reaches an adapter or the
    // transport behind it some other way does none of that.
    "gateway-boundary": rule(
      "Model adapters are called only by model-provider/src/gateway.ts; call the ModelGateway",
      (filename) => !isAdapterTest(pathOf(filename)),
      (context, report) => {
        const path = pathOf(context.filename);
        const insideAdapters = context.filename.startsWith(`${adaptersDirectory}${sep}`);
        const mayImport = insideAdapters || path === `${modelProvider}/src/registration.ts`;
        const mayCall = insideAdapters || path === `${modelProvider}/src/gateway.ts`;
        const services = context.sourceCode.parserServices;

        /**
         * @param {AnyNode} node
         * @param {unknown} specifier
         */
        const checkImport = (node, specifier) => {
          if (mayImport || typeof specifier !== "string") return;
          const target = specifier.startsWith(".")
            ? resolve(dirname(context.filename), specifier)
            : undefined;
          if (
            target === adaptersDirectory ||
            target?.startsWith(`${adaptersDirectory}${sep}`) ||
            /^@vivd-catalyst\/model-provider\/.*\badapters\b/.test(specifier)
          )
            report(node);
        };
        /** @param {AnyNode} node */
        const checkLoad = (node) => checkImport(node, loadedModule(node));

        /**
         * Whether `complete` or `stream` read from this object is an adapter's or a
         * transport's. The gateway's own two are the way in, and a class may call itself.
         * @param {AnyNode} object
         * @param {string | undefined} name
         */
        const reachesAdapter = (object, name) => {
          if (mayCall || !services?.program || (name !== "complete" && name !== "stream"))
            return false;
          if (object.type === "ThisExpression" || object.type === "Super") return false;
          return declarersOf(services.getTypeAtLocation(object), name).some(
            ({ owner, file }) =>
              /[\\/]model-provider[\\/](?:src|dist)[\\/]/.test(file) && owner !== "ModelGateway"
          );
        };

        return {
          ImportDeclaration: checkLoad,
          ImportExpression: checkLoad,
          CallExpression: checkLoad,
          ExportNamedDeclaration: (node) => checkImport(node, node.source?.value),
          ExportAllDeclaration: (node) => checkImport(node, node.source.value),
          /** @param {AnyNode & { source: { value?: unknown } }} node */
          TSImportType: (node) => checkImport(node, node.source.value),
          MemberExpression: (node) => {
            if (reachesAdapter(node.object, keyName(node.property, node.computed))) report(node);
          },
          VariableDeclarator: (node) => {
            const { init } = node;
            if (node.id.type !== "ObjectPattern" || !init) return;
            if (
              node.id.properties.some(
                (item) =>
                  item.type === "Property" && reachesAdapter(init, keyName(item.key, item.computed))
              )
            )
              report(node);
          }
        };
      }
    ),
    // One usage event per model call, written where the call is settled. A second writer is a
    // second count of the same call, or a call that is counted nowhere.
    "usage-write-boundary": rule(
      "Model usage is recorded by the model gateway and written by the usage store",
      (filename) => {
        const path = pathOf(filename);
        return (
          packageAt(filename) !== undefined &&
          path !== `${modelProvider}/src/gateway.ts` &&
          path !== "packages/core/src/usage.ts" &&
          !path.startsWith("packages/usage-governance/src/") &&
          path !== "packages/postgres-store/src/postgres-usage-ledger.ts" &&
          path !== "packages/postgres-store/src/stores/usage.ts"
        );
      },
      (context, report) => {
        /** @type {AnyNode[]} */
        const found = [];
        /**
         * @param {AnyNode} node
         * @param {string | undefined} name
         */
        const note = (node, name) => {
          if (name !== undefined && usageWriters.includes(name)) found.push(node);
        };
        /** @param {AnyNode & { key: AnyNode, computed: boolean }} node */
        const noteKey = (node) => note(node, keyName(node.key, node.computed));
        return {
          MemberExpression: (node) => note(node, keyName(node.property, node.computed)),
          Property: noteKey,
          MethodDefinition: noteKey,
          PropertyDefinition: noteKey,
          TSMethodSignature: noteKey,
          TSPropertySignature: noteKey,
          // A name in a type, as in `Pick<Recorder, "recordModelUsage">`, hands the writer on.
          /** @param {AnyNode & { literal: AnyNode }} node */
          TSLiteralType: (node) =>
            note(
              node,
              node.literal.type === "Literal" && typeof node.literal.value === "string"
                ? node.literal.value
                : undefined
            ),
          Literal: (node) => {
            if (typeof node.value === "string" && usageInsert.test(node.value)) found.push(node);
          },
          /** @param {AnyNode & { value: { raw: string } }} node */
          TemplateElement: (node) => {
            if (usageInsert.test(node.value.raw)) found.push(node);
          },
          CallExpression: (node) => {
            const [table] = node.arguments;
            if (
              node.callee.type === "MemberExpression" &&
              keyName(node.callee.property, node.callee.computed) === "insert" &&
              ((table?.type === "Identifier" && table.name === "modelUsageEvents") ||
                (table?.type === "MemberExpression" &&
                  keyName(table.property, table.computed) === "modelUsageEvents"))
            )
              found.push(node);
          },
          "Program:exit": () => reportBeyondExemption(context, usageWriteExemptions, found, report)
        };
      }
    ),
    // What a model can do is what its adapter declares. Code that asks for the provider type
    // instead is wrong for the next adapter.
    "provider-type-literal": rule(
      "Ask the gateway what a model can do; only model-provider knows a provider type",
      (filename) => {
        const directory = packageAt(filename)?.directory;
        return directory !== undefined && directory !== modelProvider;
      },
      (context, report) => {
        const services = context.sourceCode.parserServices;
        /** @type {AnyNode[]} */
        const found = [];

        /** @param {AnyNode | null | undefined} node */
        const isProviderTypeLiteral = (node) =>
          node?.type === "Literal" &&
          typeof node.value === "string" &&
          providerTypes.has(node.value);

        /**
         * A read of `type` from a model provider entry, whatever it is compared with.
         * @param {AnyNode | null | undefined} node
         */
        const isProviderTypeRead = (node) => {
          if (
            node?.type !== "MemberExpression" ||
            keyName(node.property, node.computed) !== "type" ||
            node.object.type === "Super" ||
            !services?.program
          )
            return false;
          return declarersOf(services.getTypeAtLocation(node.object), "type").some(
            ({ owner }) => owner === "ModelProviderConfig"
          );
        };

        /** @param {AnyNode | null | undefined} node */
        const decides = (node) => isProviderTypeLiteral(node) || isProviderTypeRead(node);

        return {
          BinaryExpression: (node) => {
            if (equality.includes(node.operator) && (decides(node.left) || decides(node.right)))
              found.push(node);
          },
          SwitchStatement: (node) => {
            if (
              isProviderTypeRead(node.discriminant) ||
              node.cases.some((item) => isProviderTypeLiteral(item.test))
            )
              found.push(node);
          },
          // `["a", "b"].includes(provider.type)` and `types.has(provider.type)`.
          CallExpression: (node) => {
            if (node.callee.type !== "MemberExpression" || node.callee.object.type === "Super")
              return;
            const method = keyName(node.callee.property, node.callee.computed);
            if (method !== "includes" && method !== "has" && method !== "indexOf") return;
            const { object } = node.callee;
            if (
              node.arguments.some((argument) => decides(argument)) ||
              (object.type === "ArrayExpression" && object.elements.some(isProviderTypeLiteral))
            )
              found.push(node);
          },
          "Program:exit": () =>
            reportBeyondExemption(context, providerTypeExemptions, found, report)
        };
      }
    )
  };
};
