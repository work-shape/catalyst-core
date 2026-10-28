import { build } from "esbuild";
await build({
  entryPoints: ["../chat-ui/src/studio/pages/capture-host.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  outfile: "dist/host.js",
  minify: true
});
