// Keep the list short. Removing a concept lowers its measured baseline; it does not rename it.
const retiredTerms = ["Namespace"];

/** @type {import("eslint").Rule.RuleModule} */
export const retiredTermsRule = {
  meta: {
    type: "problem",
    schema: [],
    messages: {
      retired: "Retired product term '{{term}}'; remove it through its retirement slice."
    }
  },
  create(context) {
    /** @type {Set<string>} */
    const seen = new Set();
    /**
     * @param {import("eslint").Rule.Node | import("eslint").AST.Token} node
     * @param {string} text
     */
    const check = (node, text) => {
      for (const term of retiredTerms) {
        const key = `${node.range?.[0]}:${term}`;
        if (!text.toLowerCase().includes(term.toLowerCase()) || seen.has(key) || !node.loc)
          continue;
        // A shorthand property can visit its identifier twice. Count each token once.
        seen.add(key);
        context.report({ loc: node.loc, messageId: "retired", data: { term } });
      }
    };
    return {
      Identifier(node) {
        if (node.type === "Identifier") check(node, node.name);
      },
      PrivateIdentifier(node) {
        if (node.type === "PrivateIdentifier") check(node, node.name);
      },
      Literal(node) {
        if (node.type === "Literal" && typeof node.value === "string") check(node, node.value);
      },
      TemplateElement(node) {
        if (node.type === "TemplateElement") check(node, node.value.cooked ?? node.value.raw);
      },
      Program(node) {
        // ESTree's base node types do not include JSX. Its tokens expose names and text too.
        for (const token of context.sourceCode.getTokens(node))
          if (token.type === "JSXIdentifier" || token.type === "JSXText") check(token, token.value);
      }
    };
  }
};
