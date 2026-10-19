import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { serveBuiltUi, typeInComposer } from "./composer-probe.mjs";
import { freePort } from "./fresh-consumer-smoke.mjs";

test("the built UI is served like the deployments' nginx: files, then the SPA for any route", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "composer-probe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "client", "assets"), { recursive: true });
  writeFileSync(join(root, "client", "index.html"), "<html>spa</html>");
  writeFileSync(join(root, "client", "assets", "app.js"), "export {};");
  writeFileSync(join(root, "secret.txt"), "outside");
  const port = await freePort();
  const stop = await serveBuiltUi(join(root, "client"), port);
  t.after(stop);
  const get = async (path) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return [response.headers.get("content-type"), await response.text()];
  };
  assert.deepEqual(await get("/assets/app.js"), ["text/javascript; charset=utf-8", "export {};"]);
  assert.deepEqual(await get("/w/cws_1"), ["text/html; charset=utf-8", "<html>spa</html>"]);
  assert.equal((await get("/../secret.txt"))[1], "<html>spa</html>");
  assert.equal((await get("/%2e%2e/secret.txt"))[1], "<html>spa</html>");
});

/** A stand-in for Playwright's chromium: a page whose composer keeps or loses the text. */
function fakeBrowser({ pageErrors = [], keepsText = true }) {
  const handlers = {};
  let typed = "";
  const page = {
    on: (event, handler) => (handlers[event] = handler),
    goto: async () => {},
    locator: () => ({ fill: async () => {} }),
    keyboard: {
      press: async () => {},
      type: async (text) => {
        typed += text;
        for (const message of pageErrors) handlers.pageerror?.(new Error(message));
      }
    },
    waitForURL: async () => {},
    waitForTimeout: async () => {},
    getByRole: () => ({
      click: async () => {},
      isVisible: async () => keepsText,
      inputValue: async () => typed
    })
  };
  return { launch: async () => ({ newPage: async () => page, close: async () => {} }) };
}

test("typing passes when the composer keeps the text without a page error", async () => {
  assert.deepEqual(await typeInComposer("http://ui", "a@b.test", "pw", fakeBrowser({})), []);
});

test("a page error while typing or a composer that disappears is reported", async () => {
  const loop = "Maximum update depth exceeded. The result of getSnapshot should be cached";
  assert.deepEqual(
    await typeInComposer("http://ui", "a@b.test", "pw", fakeBrowser({ pageErrors: [loop] })),
    [loop]
  );
  assert.deepEqual(
    await typeInComposer("http://ui", "a@b.test", "pw", fakeBrowser({ keepsText: false })),
    ["the composer disappeared while typing"]
  );
});
