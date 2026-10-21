/**
 * @typedef {import("eslint").Rule.RuleContext} Context
 * @typedef {import("estree").Node} AnyNode
 * @typedef {{
 *   rule: (
 *     message: string,
 *     inScope: (filename: string) => boolean,
 *     visit: (context: Context, report: (node: AnyNode) => void) => import("eslint").Rule.RuleListener
 *   ) => import("eslint").Rule.RuleModule,
 *   packageAt: (filename: string) => { directory: string } | undefined,
 *   isPackageFile: (filename: string, path: string) => boolean,
 *   globalUses: (context: Context, names: string[]) => Set<AnyNode>,
 *   staticReads: (object: AnyNode) => string[] | undefined,
 *   hostMemberUses: (context: Context, members: string[]) => AnyNode[],
 *   loadedModule: (node: AnyNode) => string | undefined
 * }} Helpers
 */

/**
 * The one module of a package that may read the environment is `src/env.ts`. These packages
 * keep theirs elsewhere: the Vite plugin of chat-ui is plain JavaScript that loads without a
 * build, the artifact helpers keep their library under `src/lib`, and the deployment kit is
 * plain JavaScript and shell under `lib`.
 * @type {Record<string, string>}
 */
const ENV_MODULE_ELSEWHERE = {
  "packages/chat-ui": "src/env.js",
  "packages/artifact-helpers": "src/lib/env.ts",
  "packages/deployment-kit": "lib/env.mjs"
};

/**
 * `catalyst/env-boundary`: the environment is read in one module per package.
 * @param {Helpers} helpers
 */
export const envBoundaryRule = ({
  rule,
  packageAt,
  isPackageFile,
  globalUses,
  staticReads,
  hostMemberUses,
  loadedModule
}) =>
  rule(
    "Environment reads belong in the package's src/env.ts",
    (filename) => {
      const pkg = packageAt(filename);
      return (
        pkg !== undefined &&
        !isPackageFile(filename, ENV_MODULE_ELSEWHERE[pkg.directory] ?? "src/env.ts")
      );
    },
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
        // Vite injects these values into the explicitly named frontend entry files.
        MetaProperty: (node) => {
          if (node.meta.name !== "import" || node.property.name !== "meta") return;
          const frontendEntries = [
            "/clients/chat-standalone/src/main.tsx",
            "/clients/demo/src/chat-main.tsx"
          ];
          const filename = context.filename.replaceAll("\\", "/");
          if (
            !frontendEntries.some((entry) => filename.endsWith(entry)) &&
            (staticReads(node)?.includes("env") ?? true)
          )
            report(node);
        },
        // The global `process` keeps environment reads visible to this rule.
        ImportDeclaration: check,
        ImportExpression: check,
        CallExpression: check
      };
    }
  );
