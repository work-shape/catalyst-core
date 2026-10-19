import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { CHAT_RUNTIME, checkRuntimePins, resolvedVersions } from "./check-runtime-pins.mjs";

const tested = {
  "@assistant-ui/react": "0.14.26",
  "@assistant-ui/core": "0.2.20",
  "@assistant-ui/store": "0.2.19",
  "@assistant-ui/tap": "0.9.3",
  ai: "6.0.224",
  "@ai-sdk/react": "3.0.226"
};

function lock(t, versions) {
  const dir = mkdtempSync(join(tmpdir(), "runtime-pins-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const packages = {};
  for (const [name, list] of Object.entries(versions)) {
    for (const version of [list].flat()) packages[`${name}@${version}`] = { resolution: {} };
  }
  const path = join(dir, "pnpm-lock.yaml");
  writeFileSync(path, stringify({ lockfileVersion: "9.0", packages }));
  return path;
}

test("the checked list is the chat runtime chat-ui pins exactly", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../packages/chat-ui/package.json", import.meta.url), "utf8")
  );
  for (const name of CHAT_RUNTIME) {
    assert.match(manifest.dependencies[name] ?? "", /^\d+\.\d+\.\d+$/u, name);
  }
});

test("core's own lock resolves one version of each pinned runtime package, the pinned one", () => {
  const core = fileURLToPath(new URL("../../pnpm-lock.yaml", import.meta.url));
  checkRuntimePins(core, core);
  const manifest = JSON.parse(
    readFileSync(new URL("../../packages/chat-ui/package.json", import.meta.url), "utf8")
  );
  const lockText = parse(readFileSync(core, "utf8"));
  for (const name of CHAT_RUNTIME) {
    assert.deepEqual(resolvedVersions(lockText, name), [manifest.dependencies[name]], name);
  }
});

test("a consumer on core's versions passes", (t) => {
  checkRuntimePins(lock(t, tested), lock(t, tested));
});

test("a consumer that floats the runtime fails and names each drifted package", (t) => {
  const floated = {
    ...tested,
    "@assistant-ui/react": "0.14.29",
    "@assistant-ui/tap": "0.9.23",
    ai: "6.0.308"
  };
  assert.throws(
    () => checkRuntimePins(lock(t, floated), lock(t, tested)),
    (error) => {
      assert.match(
        error.message,
        /@assistant-ui\/react: consumer resolves 0\.14\.29, core tested 0\.14\.26/u
      );
      assert.match(
        error.message,
        /@assistant-ui\/tap: consumer resolves 0\.9\.23, core tested 0\.9\.3/u
      );
      assert.match(error.message, /ai: consumer resolves 6\.0\.308, core tested 6\.0\.224/u);
      assert.doesNotMatch(error.message, /@assistant-ui\/core/u);
      return true;
    }
  );
});

test("a second copy beside the tested version fails", (t) => {
  const duplicate = { ...tested, "@assistant-ui/tap": ["0.9.3", "0.9.23"] };
  assert.throws(
    () => checkRuntimePins(lock(t, duplicate), lock(t, tested)),
    /@assistant-ui\/tap: consumer resolves 0\.9\.23, 0\.9\.3, core tested 0\.9\.3/u
  );
});

test("resolvedVersions reads peer-qualified keys and ignores packages sharing a prefix", () => {
  const versions = resolvedVersions(
    {
      packages: {
        "@assistant-ui/react@0.14.26": {},
        "@assistant-ui/react-ai-sdk@1.3.40": {},
        "ai@6.0.224": {}
      }
    },
    "@assistant-ui/react"
  );
  assert.deepEqual(versions, ["0.14.26"]);
});
