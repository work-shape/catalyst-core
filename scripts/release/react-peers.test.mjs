import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkReactPeers } from "./check-react-peers.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "react-peers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package.json"), "{}");
  const module = (name, base = root) => {
    const dir = join(base, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        name,
        main: "index.js",
        ...(name.startsWith("@work-shape/")
          ? { type: "module", exports: { ".": { import: "./index.js" } } }
          : {})
      })
    );
    for (const file of ["index.js", "jsx-runtime.js", "client.js"])
      writeFileSync(join(dir, file), "");
    return dir;
  };
  module("react");
  module("react-dom");
  for (const name of ["@work-shape/catalyst-chat-ui", "@work-shape/catalyst-ui"]) module(name);
  return { root, module };
}

test("packed UI packages use host React and reject a nested runtime copy", (t) => {
  const { root } = fixture(t);
  checkReactPeers(root);
  for (const name of ["@work-shape/catalyst-chat-ui", "@work-shape/catalyst-ui"]) {
    for (const runtime of ["react", "react-dom"]) {
      const duplicate = fixture(t);
      duplicate.module(runtime, join(duplicate.root, "node_modules", name));
      assert.throws(() => checkReactPeers(duplicate.root), /resolves a different react/u);
    }
  }
});
