import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** What the guard counts. The library categories apply inside `packages/ui/src` only. */
export type UiGuardCategory =
  | "elements"
  | "roles"
  | "palette"
  | "hex"
  | "font-size"
  | "radius"
  | "overlay-imports"
  | "library-imports"
  | "library-storage"
  | "library-text";

export interface UiGuardFinding {
  file: string;
  line: number;
  category: UiGuardCategory;
  found: string;
}

export const uiGuardHints: Record<UiGuardCategory, string> = {
  elements:
    "Use Button, IconButton, Input, Textarea, Select or Dialog from @vivd-catalyst/ui in place of the raw element.",
  roles:
    "Use the library's Dialog, Picker, DropdownMenu or Tabs; they own these roles and their keyboard handling.",
  palette: "Use a theme token (for example text-success-soft-foreground), not a palette colour.",
  hex: "Use a theme token. Only packages/ui/src/theme may hold colour values.",
  "font-size": "Use one of the nine type styles (text-title … text-code), not an arbitrary size.",
  radius: "Use rounded-sm, -md, -lg, -xl or -full, not an arbitrary radius.",
  "overlay-imports":
    "Import the component from @vivd-catalyst/ui. Only the library imports radix-ui and cmdk.",
  "library-imports":
    "The library imports only react, react-dom, radix-ui, cmdk, lucide-react, class-variance-authority, clsx, tailwind-merge and its own files. Only data/chart-engine.ts imports echarts.",
  "library-storage": "The library keeps nothing in storage and loads nothing.",
  "library-text":
    "The library shows no text of its own: take it as a prop or from the UiRoot labels."
};

const LIBRARY_ROOT = "packages/ui/src/";
const LIBRARY_THEME_ROOT = "packages/ui/src/theme/";
const RAW_ELEMENTS = new Set(["button", "input", "select", "textarea", "dialog"]);
const OWNED_ROLES = new Set(["dialog", "listbox", "menu", "tab", "tablist"]);
const LIBRARY_IMPORTS = new Set([
  "react",
  "react-dom",
  "radix-ui",
  "cmdk",
  "lucide-react",
  "class-variance-authority",
  "clsx",
  "tailwind-merge"
]);
/** A package one library file wraps, so that no other file and no caller sees it. */
const LIBRARY_ENGINE_IMPORTS: Readonly<Record<string, string>> = {
  "packages/ui/src/data/chart-engine.ts": "echarts"
};
const STORAGE_NAMES = new Set([
  "localStorage",
  "sessionStorage",
  "indexedDB",
  "fetch",
  "XMLHttpRequest"
]);
const TEXT_ATTRIBUTES = new Set(["aria-label", "title", "placeholder", "alt"]);

const PALETTE =
  /(?<![\w-])(?:bg|text|border|ring|outline|fill|stroke|from|via|to|divide|decoration|shadow|accent|caret|placeholder)-(?:(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}|white|black)(?![\w-])/gu;
const HEX = /(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/gu;
const FONT_SIZE = /(?<![\w-])text-\[\d[^\]]*\]/gu;
const RADIUS = /(?<![\w-])rounded(?:-[a-z]{1,2})?-\[[^\]]+\]/gu;

/** Every finding under `packages/<name>/src` and `clients/<name>` of the platform at `root`. */
export function scanUiGuard(root: string): UiGuardFinding[] {
  const findings: UiGuardFinding[] = [];
  for (const path of sourceFiles(root)) {
    const file = relative(root, path).split(sep).join("/");
    const text = readFileSync(path, "utf8");
    if (file.endsWith(".css")) {
      if (!file.startsWith(LIBRARY_ROOT)) {
        scanStylesheet(file, text, findings);
      }
    } else {
      scanSource(file, text, findings);
    }
  }
  return findings;
}

function sourceFiles(root: string): string[] {
  const roots = [
    ...childDirectories(join(root, "packages")).map((directory) => join(directory, "src")),
    ...childDirectories(join(root, "clients"))
  ];
  return roots.flatMap((directory) => walk(directory)).sort();
}

function childDirectories(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name));
}

function walk(directory: string): string[] {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return ["node_modules", "dist", "generated"].includes(entry.name) ? [] : walk(path);
    }
    return /\.(?:tsx?|css)$/u.test(entry.name) && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

function scanStylesheet(file: string, text: string, findings: UiGuardFinding[]): void {
  // A comment keeps its line breaks so the line numbers after it stay right.
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replace(/[^\n]/gu, " "));
  for (const match of code.matchAll(HEX)) {
    findings.push({
      file,
      line: code.slice(0, match.index).split("\n").length,
      category: "hex",
      found: match[0]
    });
  }
}

function scanSource(file: string, text: string, findings: UiGuardFinding[]): void {
  const inLibrary = file.startsWith(LIBRARY_ROOT);
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const add = (node: ts.Node, category: UiGuardCategory, found: string) => {
    findings.push({
      file,
      line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
      category,
      found
    });
  };
  const scanText = (node: ts.Node, value: string) => {
    for (const match of value.matchAll(PALETTE)) {
      add(node, "palette", match[0]);
    }
    if (!file.startsWith(LIBRARY_THEME_ROOT)) {
      for (const match of value.matchAll(HEX)) {
        add(node, "hex", match[0]);
      }
    }
    for (const match of value.matchAll(FONT_SIZE)) {
      add(node, "font-size", match[0]);
    }
    for (const match of value.matchAll(RADIUS)) {
      add(node, "radius", match[0]);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (specifier && ts.isStringLiteral(specifier)) {
        scanImport(node, specifier.text);
      }
      // An import holds no class names, so its strings are not scanned.
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      scanImport(node, node.arguments[0].text);
      return;
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const name = node.tagName.getText(source);
      if (!inLibrary && RAW_ELEMENTS.has(name)) {
        add(node, "elements", `<${name}>`);
      }
    }
    if (ts.isJsxAttribute(node)) {
      const name = node.name.getText(source);
      const value = literalAttributeValue(node);
      if (!inLibrary && name === "role" && value !== undefined && OWNED_ROLES.has(value)) {
        add(node, "roles", `role="${value}"`);
      }
      if (inLibrary && TEXT_ATTRIBUTES.has(name) && value !== undefined && /\p{L}/u.test(value)) {
        add(node, "library-text", `${name}="${value}"`);
      }
    }
    if (inLibrary && ts.isJsxText(node) && /\p{L}/u.test(node.text)) {
      add(node, "library-text", node.text.trim());
    }
    if (inLibrary && ts.isIdentifier(node) && STORAGE_NAMES.has(node.text)) {
      add(node, "library-storage", node.text);
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) {
      scanText(node, node.text);
    }
    ts.forEachChild(node, visit);
  };

  const scanImport = (node: ts.Node, specifier: string) => {
    const isOverlayPackage =
      specifier === "radix-ui" || specifier.startsWith("@radix-ui/") || specifier === "cmdk";
    if (!inLibrary && isOverlayPackage) {
      add(node, "overlay-imports", specifier);
    }
    const packageName = specifier.split("/")[0] ?? specifier;
    const isAllowed =
      LIBRARY_IMPORTS.has(packageName) || LIBRARY_ENGINE_IMPORTS[file] === packageName;
    if (inLibrary && !specifier.startsWith(".") && !isAllowed) {
      add(node, "library-imports", specifier);
    }
  };

  visit(source);
}

function literalAttributeValue(attribute: ts.JsxAttribute): string | undefined {
  const initializer = attribute.initializer;
  if (!initializer) {
    return undefined;
  }
  if (ts.isStringLiteral(initializer)) {
    return initializer.text;
  }
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    ts.isStringLiteralLike(initializer.expression)
  ) {
    return initializer.expression.text;
  }
  return undefined;
}

/** Counts per file and category, with files and categories in a fixed order. */
export function countUiGuardFindings(
  findings: readonly UiGuardFinding[]
): Record<string, Partial<Record<UiGuardCategory, number>>> {
  const counts: Record<string, Partial<Record<UiGuardCategory, number>>> = {};
  for (const finding of [...findings].sort(
    (a, b) => a.file.localeCompare(b.file) || a.category.localeCompare(b.category)
  )) {
    const fileCounts = (counts[finding.file] ??= {});
    fileCounts[finding.category] = (fileCounts[finding.category] ?? 0) + 1;
  }
  return counts;
}

export function isLibraryFile(file: string): boolean {
  return file.startsWith(LIBRARY_ROOT);
}
