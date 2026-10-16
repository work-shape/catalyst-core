import { relative } from "node:path";

/**
 * @typedef {import("estree").Node} AnyNode
 * @typedef {import("eslint").Rule.Node} Node
 * @typedef {{ type: string, parent: JsxAncestor | null, name?: { name?: string } }} JsxAncestor
 * @typedef {{
 *   rule: (message: string, inScope: (filename: string) => boolean, visit: (context: import("eslint").Rule.RuleContext, report: (node: AnyNode) => void) => import("eslint").Rule.RuleListener) => import("eslint").Rule.RuleModule,
 *   keyName: (key: AnyNode, computed: boolean) => string | undefined,
 *   staticReads: (node: AnyNode) => string[] | undefined
 * }} Helpers
 */

/** AST guards replacing the asset-head and workspace-handle source scans. @param {Helpers} helpers */
export const assetBoundaryRules = ({ rule, keyName, staticReads }) => {
  const root = process.cwd();
  /** @param {string} filename */
  const fileOf = (filename) => relative(root, filename).replaceAll("\\", "/");
  return {
    "asset-head-description": rule(
      "Asset headers describe the asset's purpose, never its name or id",
      (filename) => fileOf(filename).startsWith("packages/chat-ui/src/"),
      (_context, report) => ({
        /** @param {AnyNode & { name: { name: string }, value: null | { type: string, expression: AnyNode }, parent: { name: { name: string } } }} node */
        "JSXAttribute[name.name='description']": (node) => {
          if (!["PageHeader", "AppHeader"].includes(node.parent.name.name)) return;
          if (node.value?.type !== "JSXExpressionContainer") return;
          const expression = node.value.expression;
          const name =
            expression.type === "Identifier"
              ? expression.name
              : expression.type === "MemberExpression"
                ? keyName(expression.property, expression.computed)
                : undefined;
          if (name && /(?:^name$|^id$|Id$)/u.test(name)) report(node);
        },
        Literal: (node) => {
          if (typeof node.value !== "string" || !node.value.includes("<code")) return;
          let ancestor = /** @type {JsxAncestor | null} */ (node.parent);
          while (ancestor && ancestor.type !== "JSXAttribute") ancestor = ancestor.parent;
          if (
            ancestor?.name?.name === "description" &&
            ["PageHeader", "AppHeader"].includes(ancestor.parent?.name?.name ?? "")
          )
            report(node);
        },
        /** @param {AnyNode & { name: { name: string }, parent: JsxAncestor | null }} node */
        "JSXOpeningElement[name.name='code']": (node) => {
          let ancestor = node.parent;
          while (ancestor && ancestor.type !== "JSXAttribute") ancestor = ancestor.parent;
          if (!ancestor) return;
          if (
            ancestor.name?.name === "description" &&
            ["PageHeader", "AppHeader"].includes(ancestor.parent?.name?.name ?? "")
          )
            report(node);
        }
      })
    ),
    "workspace-handle-boundary": rule(
      "Workspace tools address conversations through the handle resolver; toolRequest must not be aliased",
      (filename) =>
        /^packages\/tool-execution\/src\/(?:workspace-tools\/.*|(?:workspace|page)-[^/]+)\.ts$/u.test(
          fileOf(filename)
        ),
      (context, report) => {
        const file = fileOf(context.filename).replace("packages/tool-execution/src/", "");
        const allowed =
          file === "workspace-tools/workspace-handle-resolver.ts"
            ? ["conversationId"]
            : file === "workspace-tools/exec.ts"
              ? ["agentRunId", "toolCallId"]
              : [];
        /** @param {AnyNode} node */
        const check = (node) => {
          const parent = /** @type {Node} */ (node).parent;
          if (
            file === "workspace-preview-images.ts" &&
            parent?.type === "UnaryExpression" &&
            parent.operator === "!"
          )
            return;
          const reads = staticReads(node);
          if (!reads?.length || reads.some((name) => !allowed.includes(name))) report(node);
        };
        return {
          Identifier: (node) => {
            if (node.name !== "toolRequest") return;
            const parent = node.parent;
            // Member access and destructuring are checked below, once per access.
            if (
              (parent?.type === "MemberExpression" && parent.property === node) ||
              (parent?.type === "Property" && parent.parent?.type === "ObjectPattern")
            )
              return;
            report(node);
          },
          Literal: (node) => {
            if (node.value !== "toolRequest") return;
            const parent = node.parent;
            if (
              (parent?.type === "MemberExpression" && parent.property === node) ||
              (parent?.type === "Property" && parent.parent?.type === "ObjectPattern")
            )
              return;
            report(node);
          },
          MemberExpression: (node) => {
            if (keyName(node.property, node.computed) === "toolRequest") check(node);
          },
          /** @param {AnyNode} node */
          "ObjectPattern > Property": (node) => {
            if (node.type === "Property" && keyName(node.key, node.computed) === "toolRequest")
              report(node);
          }
        };
      }
    )
  };
};
