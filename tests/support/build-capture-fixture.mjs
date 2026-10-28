import { build } from "esbuild";
await build({
  entryPoints: ["tests/fixtures/preview-capture-api.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile: ".capture-fixture.mjs",
  alias: {
    "@work-shape/catalyst-server": "./packages/server/src/capture-content.ts",
    "@work-shape/catalyst-app-build/build": "./packages/app-build/src/html.ts"
  }
});
