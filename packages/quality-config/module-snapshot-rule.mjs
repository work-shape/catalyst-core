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
 *   keyName: (key: AnyNode, computed: boolean) => string | undefined
 * }} Helpers
 */

/**
 * `catalyst/module-snapshot-boundary`. The switches are resolved once, with their legacy keys,
 * and validated against the registry of what this build ships. A second reader would decide
 * from raw switches.
 * @param {Helpers} helpers
 */
export const moduleSnapshotBoundaryRule = ({ rule, isServerSource, packageAt, keyName }) =>
  rule(
    "config.modules is read by config-schema only; take the ModuleSnapshot the assembly resolves",
    (filename) =>
      isServerSource(filename) && packageAt(filename)?.directory !== "packages/config-schema",
    (_context, report) => {
      /** @param {AnyNode} node */
      const isConfig = (node) =>
        (node.type === "Identifier" && node.name === "config") ||
        (node.type === "MemberExpression" && keyName(node.property, node.computed) === "config");
      return {
        /** @param {AnyNode} node */
        MemberExpression: (node) => {
          if (
            node.type === "MemberExpression" &&
            keyName(node.property, node.computed) === "modules" &&
            isConfig(node.object)
          )
            report(node);
        },
        /** @param {AnyNode} node */
        VariableDeclarator: (node) => {
          if (
            node.type === "VariableDeclarator" &&
            node.id.type === "ObjectPattern" &&
            node.init &&
            isConfig(node.init) &&
            node.id.properties.some(
              (item) => item.type === "Property" && keyName(item.key, item.computed) === "modules"
            )
          )
            report(node);
        }
      };
    }
  );
