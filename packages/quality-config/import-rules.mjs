import { resolve } from "node:path";
import { createTypeScriptImportResolver } from "eslint-import-resolver-typescript";

/**
 * The import rules and the resolver they share.
 * @param {string} root the repository the lint runs in
 * @returns {Pick<import("eslint").Linter.Config, "settings" | "rules">}
 */
export const importRules = (root) => ({
  settings: {
    "import-x/extensions": [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    "import-x/resolver-next": [
      createTypeScriptImportResolver({
        project: resolve(root, "tsconfig.lint.json"),
        // Without the "types" condition. A package whose wildcard export maps types to
        // "./dist/*.d.ts" (the MCP SDK) names no file for "x.js" there; TypeScript then goes on
        // to the "import" target, and this resolver does not. Whether a path resolves is all
        // the rules ask, so the "import" target answers it.
        conditionNames: ["import", "require", "node", "default"]
      })
    ]
  },
  rules: {
    // Sibling packages are reached through their package name, never by a relative path.
    "import-x/no-relative-packages": ["error", { commonjs: true }],
    // A path that a package does not export does not resolve: no deep imports.
    // Astro supplies its `astro:` modules at build time.
    "import-x/no-unresolved": ["error", { commonjs: true, ignore: ["^astro:"] }]
  }
});
