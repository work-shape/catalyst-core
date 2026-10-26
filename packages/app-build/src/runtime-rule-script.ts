import ts from "typescript";
import { RULES, runtimeRuleError, type RuntimeRuleId } from "./runtime-rules";
import type { PageBuildError } from "./errors";

/**
 * Parse without resolving imports, reading libraries or evaluating author code. TypeScript is
 * already part of app-build's toolchain; esbuild's parser exposes no AST or scope information.
 * The checker binds local names (including hoisted declarations and imports) without any libs,
 * so an unresolved reference denotes a browser global rather than a same-named local.
 */
export function scriptRuntimeErrors(input: {
  file: string;
  text: string;
  externalHosts: boolean;
  line?: number;
}): PageBuildError[] {
  const source = ts.createSourceFile(
    input.file,
    input.text,
    ts.ScriptTarget.Latest,
    true,
    /\.ts$/iu.test(input.file) ? ts.ScriptKind.TS : ts.ScriptKind.TSX
  );
  const program = ts.createProgram(
    [input.file],
    { noLib: true, noResolve: true, allowJs: true },
    {
      getSourceFile: (file) => (file === input.file ? source : undefined),
      getDefaultLibFileName: () => "",
      writeFile() {},
      getCurrentDirectory: () => "",
      getDirectories: () => [],
      fileExists: (file) => file === input.file,
      readFile: () => undefined,
      getCanonicalFileName: (file) => file,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n"
    }
  );
  const checker = program.getTypeChecker();
  const errors: PageBuildError[] = [];
  const unbound = (node: ts.Identifier): boolean => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    return (
      !symbol ||
      (node.text === "globalThis" && !symbol.declarations?.length) ||
      !(symbol.flags & (ts.SymbolFlags.Value | ts.SymbolFlags.Alias))
    );
  };
  const global = (node: ts.Node, names: readonly string[]): boolean => {
    if (
      ts.isParenthesizedExpression(node) ||
      ts.isAsExpression(node) ||
      ts.isTypeAssertionExpression(node) ||
      ts.isNonNullExpression(node) ||
      ts.isSatisfiesExpression(node)
    )
      return global(node.expression, names);
    return ts.isIdentifier(node) && names.includes(node.text) && unbound(node);
  };
  const root = (node: ts.Node): boolean => global(node, ["window", "globalThis", "self"]);
  const member = (node: ts.Node): { object: ts.Expression; name: string } | undefined => {
    if (ts.isPropertyAccessExpression(node))
      return { object: node.expression, name: node.name.text };
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)
    )
      return { object: node.expression, name: node.argumentExpression.text };
    return undefined;
  };
  const report = (node: ts.Node, id: RuntimeRuleId) => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    errors.push({
      file: input.file,
      line: position.line + (input.line ?? 1),
      ...(input.line !== undefined && position.line === 0
        ? {}
        : { column: position.character + 1 }),
      ...runtimeRuleError(id)
    });
  };
  const visit = (node: ts.Node): void => {
    // Type names, property names, labels and JSX tag/attribute names are not runtime globals.
    if (
      ts.isTypeAliasDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeNode(node) ||
      ts.isImportDeclaration(node) ||
      ts.isExportDeclaration(node)
    )
      return;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (ts.isIdentifier(node.tagName) && node.tagName.text === "a") {
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute) || attribute.name.getText(source) !== "target")
            continue;
          const value = attribute.initializer;
          const text = value && ts.isJsxExpression(value) ? value.expression : value;
          if (text && ts.isStringLiteralLike(text) && text.text.toLowerCase() === "_blank")
            report(attribute, "new_window");
        }
      }
      // Visit expressions in props, not the tag or attribute names.
      for (const attribute of node.attributes.properties) {
        if (ts.isJsxSpreadAttribute(attribute)) visit(attribute.expression);
        else if (
          attribute.initializer &&
          ts.isJsxExpression(attribute.initializer) &&
          attribute.initializer.expression
        )
          visit(attribute.initializer.expression);
      }
      return;
    }
    if (ts.isJsxClosingElement(node)) return;
    const access = member(node);
    if (access) {
      if (root(access.object)) {
        for (const rule of RULES) {
          if (rule.id === "direct_network" && input.externalHosts) continue;
          if ((rule.match as readonly string[]).includes(access.name)) report(node, rule.id);
        }
      } else if (
        access.name === "cookie" &&
        (global(access.object, ["document"]) ||
          (() => {
            const object = member(access.object);
            return object?.name === "document" && root(object.object);
          })())
      )
        report(node, "browser_storage");
      // The name in obj.confirm is never a reference. Still inspect obj and computed keys.
      visit(access.object);
      if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        !ts.isStringLiteralLike(node.argumentExpression)
      )
        visit(node.argumentExpression);
      return;
    }
    if (ts.isIdentifier(node) && unbound(node)) {
      for (const rule of RULES) {
        if (rule.id === "new_window" || (rule.id === "direct_network" && input.externalHosts))
          continue;
        if ((rule.match as readonly string[]).includes(node.text)) report(node, rule.id);
      }
      return;
    }
    if (ts.isBindingElement(node)) {
      if (node.propertyName && ts.isComputedPropertyName(node.propertyName))
        visit(node.propertyName.expression);
      if (node.initializer) visit(node.initializer);
      return;
    }
    if (ts.isPropertyAssignment(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      visit(node.initializer);
      return;
    }
    if (ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node)) {
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      if (ts.isMethodDeclaration(node)) {
        node.parameters.forEach(visit);
        if (node.body) visit(node.body);
      } else if (node.initializer) visit(node.initializer);
      return;
    }
    if (ts.isLabeledStatement(node)) {
      visit(node.statement);
      return;
    }
    if (ts.isBreakOrContinueStatement(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(source);
  return errors;
}
