// Source-only runtime checks complement Knip: tests and the bundled CLI may use dev deps.
const source = "packages/alpha/src";
export const workspaceDependencyFixtures: Record<string, string> = {
  "packages/alpha/package.json": JSON.stringify({
    name: "@fixture/alpha",
    type: "module",
    bin: { alpha: "./dist/cli.js" },
    scripts: { typecheck: "tsc -p tsconfig.json" },
    dependencies: { "left-pad": "1.3.0" },
    devDependencies: { "@fixture/gamma": "1.0.0" }
  }),
  ...Object.fromEntries(
    ["peer", "optional"].flatMap((kind) => [
      [
        `packages/${kind}/package.json`,
        JSON.stringify({
          name: `@fixture/${kind}`,
          [`${kind}Dependencies`]: { "@fixture/gamma": "workspace:*" },
          devDependencies: { "@fixture/gamma": "workspace:*" }
        })
      ],
      [`packages/${kind}/src/index.ts`, `export { value } from "@fixture/gamma";\n`]
    ])
  ),
  "packages/config-cli/package.json": JSON.stringify({
    name: "@work-shape/catalyst-cli",
    devDependencies: { "@fixture/gamma": "workspace:*" }
  }),
  "packages/config-cli/src/bundled.ts": `export { value } from "@fixture/gamma";\n`,
  [`${source}/dev-only-import.ts`]: `import { value } from "@fixture/gamma"; export { value };\n`,
  [`${source}/dev-only-type.ts`]: `export type Value = typeof import("@fixture/gamma").value;\n`,
  [`${source}/dev-only-dynamic.ts`]: `export const loaded = import("@fixture/gamma");\n`,
  [`${source}/dev-only-require.cjs`]: `module.exports = require("@fixture/gamma");\n`,
  [`${source}/allowed.test.ts`]: `export { value } from "@fixture/gamma";\n`,
  [`${source}/test-support/allowed.ts`]: `export { value } from "@fixture/gamma";\n`,
  [`${source}/dev-only-edge.ts`]: `export { value } from "@fixture/gamma";\n`,
  "packages/gamma/src/index.ts": `export const value = 2;\n`
};
