import config from "@work-shape/catalyst-quality-config";

export default [
  ...config,
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
