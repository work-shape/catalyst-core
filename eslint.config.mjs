import config from "@work-shape/catalyst-quality-config";

export default [
  ...config,
  { rules: { "catalyst/retired-terms": "error" } },
  {
    // The rule's vocabulary and its negative fixtures must keep naming the terms they reject.
    files: ["packages/quality-config/retired-terms-rule.mjs", "tests/quality-collector.test.ts"],
    rules: { "catalyst/retired-terms": "off" }
  }
];
