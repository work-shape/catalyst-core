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
  { rules: { "catalyst/retired-terms": "error" } },
  {
    // Release tooling reuses the kit in this checkout before its package is published.
    files: ["scripts/release/check-fresh-resolution.mjs"],
    rules: { "import-x/no-relative-packages": "off" }
  },
  {
    // The rule's vocabulary and its negative fixtures must keep naming the terms they reject.
    files: [
      "packages/quality-config/retired-terms-rule.mjs",
      "tests/quality-collector.test.ts",
      "tests/support/quality-lint-fixtures.ts"
    ],
    rules: { "catalyst/retired-terms": "off" }
  }
];
