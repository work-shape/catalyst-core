import config from "@work-shape/catalyst-quality-config";

// Only the test seam may depend on chat-ui's folder layout.
const privateChatUi = String.raw`(?:^|/)packages/chat-ui/src(?:/|$)|^@work-shape/catalyst-chat-ui/src(?:/|$)`;
const message = "Use a public chat-ui subpath or tests/support/chat-ui.ts.";

export default [
  ...config,
  {
    files: ["tests/**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
    ignores: ["tests/support/chat-ui.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [{ regex: privateChatUi, message }] }],
      // no-restricted-imports covers static imports and re-exports; cover runtime/type loads too.
      "no-restricted-syntax": [
        "error",
        ...[
          "ImportExpression > Literal.source",
          "TSImportType > Literal.source",
          "CallExpression[callee.name='require'] > Literal.arguments"
        ].map((selector) => ({
          selector: `${selector}[value=/${privateChatUi.replaceAll("/", "\\/")}/]`,
          message
        }))
      ]
    }
  },
  {
    // The sole private chat-ui test seam is allowed to cross this package boundary.
    files: ["tests/support/chat-ui.ts"],
    rules: { "import-x/no-relative-packages": "off" }
  },
  { rules: { "catalyst/retired-terms": "error" } },
  {
    // Release tooling reuses the kit in this checkout before its package is published.
    files: ["scripts/release/check-fresh-resolution.mjs"],
    rules: { "import-x/no-relative-packages": "off" }
  },
  {
    // The rule's vocabulary and its negative fixtures must keep naming the terms they reject.
    // The tests of the migrations that brought a term in and took it out seed and read the
    // tables that name it. A moved page keeps its old address.
    files: [
      "packages/docs/astro.config.mjs",
      "packages/quality-config/retired-terms-rule.mjs",
      "tests/access-legacy-equivalence.test.ts",
      "tests/ns-retire-migration.test.ts",
      "tests/quality-collector.test.ts",
      "tests/support/quality-lint-fixtures.ts"
    ],
    rules: { "catalyst/retired-terms": "off" }
  }
];
