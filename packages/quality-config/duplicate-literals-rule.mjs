import ts from "typescript";

/** @typedef {{ file: string, text: string }} Source */
/** @typedef {{ file: string, detail: string }} Finding */

/**
 * Repeated allowed-value definitions drift even when they live in different packages. Compare
 * value sets, retaining order in the diagnostic: ordering exceptions remain measured debt.
 * Defaults, operation error declarations and discriminated object branches are not lists.
 * The dependency-free Page kit, sandbox command and domain-free UI library stay independent.
 *
 * @param {Source[]} sources All source files, including those outside a scoped lint run.
 * @returns {Finding[]}
 */
export function duplicateLiteralLists(sources) {
  /** @type {Map<string, (Finding & { canonical: boolean })[]>} */
  const lists = new Map();
  for (const { file, text } of sources) {
    if (
      !/^packages\/[^/]+\/src\/.*\.tsx?$/u.test(file) ||
      /^packages\/(?:app-kit|asset-repo|ui)\//u.test(file)
    )
      continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    /** @param {ts.Node} node */
    const visit = (node) => {
      /** @type {string[] | undefined} */
      let values;
      let canonical = false;
      if (ts.isArrayLiteralExpression(node) && node.elements.every(ts.isStringLiteral)) {
        /** @type {ts.Node} */
        let wrapper = node;
        while (ts.isAsExpression(wrapper.parent) || ts.isSatisfiesExpression(wrapper.parent))
          wrapper = wrapper.parent;
        const parent = wrapper.parent;
        const definition =
          ts.isVariableDeclaration(parent) ||
          (ts.isNewExpression(parent) && parent.expression.getText(source) === "Set") ||
          (ts.isCallExpression(parent) &&
            /^(?:z\.enum|inArray|notInArray)$/u.test(
              parent.expression.getText(source).replace(/\s/gu, "")
            ));
        canonical =
          ts.isVariableDeclaration(parent) &&
          /^packages\/asset-schemas\/src\/(?:contract-values|asset-types)\.ts$/u.test(file);
        if (definition)
          values = node.elements.flatMap((element) =>
            ts.isStringLiteral(element) ? [element.text] : []
          );
      } else if (
        ts.isUnionTypeNode(node) &&
        (ts.isTypeAliasDeclaration(node.parent) ||
          ts.isPropertySignature(node.parent) ||
          ts.isParameter(node.parent)) &&
        node.types.every((part) => ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal))
      ) {
        // A branch's discriminant constrains that branch; it is not another contract list.
        /** @type {ts.Node} */
        let parent = node.parent;
        while (
          parent &&
          !ts.isTypeAliasDeclaration(parent) &&
          !ts.isInterfaceDeclaration(parent) &&
          !ts.isUnionTypeNode(parent)
        )
          parent = parent.parent;
        if (!parent || !ts.isUnionTypeNode(parent))
          values = node.types.flatMap((part) =>
            ts.isLiteralTypeNode(part) && ts.isStringLiteral(part.literal)
              ? [part.literal.text]
              : []
          );
      }
      if (values && values.length > 1 && new Set(values).size === values.length) {
        const key = JSON.stringify([...values].sort());
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        lists.set(key, [
          ...(lists.get(key) ?? []),
          {
            file,
            canonical,
            detail: `${line}: Repeated allowed values ${JSON.stringify(values)}; use a shared list or a typed named subset`
          }
        ]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...lists.values()]
    .filter((copies) => copies.length > 1)
    .flat()
    .filter(({ canonical }) => !canonical)
    .map(({ file, detail }) => ({ file, detail }));
}
