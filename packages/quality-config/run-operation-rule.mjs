/**
 * @typedef {import("eslint").Rule.RuleContext} Context
 * @typedef {import("estree").Node} AnyNode
 * @typedef {{
 *   rule: (
 *     message: string,
 *     inScope: (filename: string) => boolean,
 *     visit: (context: Context, report: (node: AnyNode) => void) => import("eslint").Rule.RuleListener
 *   ) => import("eslint").Rule.RuleModule,
 *   isServerSource: (filename: string) => boolean,
 *   packageAt: (filename: string) => { directory: string } | undefined,
 *   isPackageFile: (filename: string, path: string) => boolean,
 *   keyName: (key: AnyNode, computed: boolean) => string | undefined,
 *   staticReads: (object: AnyNode) => string[] | undefined
 * }} Helpers
 */

const runner = "@vivd-catalyst/tool-execution";

/**
 * The files that may import `runOperation`, each as its package and the path inside it. A
 * second caller is a second place that decides how an operation is authorized, recorded and
 * replayed, so a file is added here only with the ticket that makes it one.
 */
const runOperationCallers = [
  { package: "packages/chat-server", path: "src/operations/operation-face.ts" }
];

/**
 * `catalyst/run-operation-boundary`. A route that calls `runOperation` itself, or a module
 * that passes it on, is a way around the operation face. The package that defines it is
 * outside the rule.
 * @param {Helpers} helpers
 */
export const runOperationBoundaryRule = ({
  rule,
  isServerSource,
  packageAt,
  isPackageFile,
  keyName,
  staticReads
}) =>
  rule(
    "runOperation is imported by chat-server/src/operations/operation-face.ts only; register the operation with route.operation",
    (filename) =>
      isServerSource(filename) &&
      packageAt(filename)?.directory !== "packages/tool-execution" &&
      !runOperationCallers.some(
        (caller) =>
          packageAt(filename)?.directory === caller.package && isPackageFile(filename, caller.path)
      ),
    (context, report) => ({
      ImportDeclaration: (node) => {
        if (node.source.value !== runner) return;
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            keyName(specifier.imported, false) === "runOperation"
          )
            report(specifier);
          // A namespace is followed to its reads; one that is passed on could hide the call.
          if (specifier.type === "ImportNamespaceSpecifier")
            for (const variable of context.sourceCode.getDeclaredVariables(specifier))
              for (const { identifier } of variable.references)
                if (staticReads(identifier)?.includes("runOperation") ?? true) report(identifier);
        }
      },
      ExportNamedDeclaration: (node) => {
        if (node.source?.value !== runner) return;
        for (const specifier of node.specifiers)
          if (keyName(specifier.local, false) === "runOperation") report(specifier);
      },
      ExportAllDeclaration: (node) => {
        if (node.source.value === runner) report(node);
      }
    })
  );
