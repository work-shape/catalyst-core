import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { signedInRequest, smokeConsumer, step } from "./fresh-consumer-smoke.mjs";

async function fixture(t, { signInStatus = 200, meStatus = 200, issueCookie = true } = {}) {
  const calls = [];
  const server = createServer((request, response) => {
    calls.push(request.url);
    if (request.url === "/api/auth/sign-in/email") {
      response.writeHead(
        signInStatus,
        issueCookie ? { "set-cookie": "session=fixture; HttpOnly" } : {}
      );
      response.end("{}");
      return;
    }
    assert.equal(request.url, "/api/v1/me");
    response.writeHead(request.headers.cookie === "session=fixture" ? meStatus : 401);
    response.end(JSON.stringify({ email: "release-smoke@example.test" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, calls };
}

test("the probe carries the sign-in cookie into an authenticated API request", async (t) => {
  const { baseUrl, calls } = await fixture(t);
  await signedInRequest(baseUrl, "fixture-password");
  assert.deepEqual(calls, ["/api/v1/me", "/api/auth/sign-in/email", "/api/v1/me"]);
});

test("a sign-in 500 (the better-auth float regression) fails before the authenticated request", async (t) => {
  const { baseUrl, calls } = await fixture(t, { signInStatus: 500 });
  await assert.rejects(signedInRequest(baseUrl, "fixture-password"), /sign-in returned 500/u);
  assert.equal(calls.length, 2);
});

test("an API 500 after sign-in also fails the probe", async (t) => {
  const { baseUrl } = await fixture(t, { meStatus: 500 });
  await assert.rejects(
    signedInRequest(baseUrl, "fixture-password"),
    /authenticated .* returned 500/u
  );
});

test("a sign-in without a session cookie fails the probe", async (t) => {
  const { baseUrl } = await fixture(t, { issueCookie: false });
  await assert.rejects(signedInRequest(baseUrl, "fixture-password"), /no session cookie/u);
});

function fakeConsumer(t, entries) {
  const consumer = mkdtempSync(join(tmpdir(), "fresh-consumer-smoke-"));
  t.after(() => rmSync(consumer, { recursive: true, force: true }));
  mkdirSync(join(consumer, "dist"));
  for (const [entry, source] of Object.entries(entries)) {
    writeFileSync(join(consumer, "dist", entry), source);
  }
  return consumer;
}

// The entries are stand-ins that never connect; the hosted job's real URL is restored after.
function fixtureDatabase(t) {
  const previous = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
  process.env.POSTGRES_STORE_TEST_DATABASE_URL = "postgresql://fixture";
  t.after(() => {
    if (previous === undefined) delete process.env.POSTGRES_STORE_TEST_DATABASE_URL;
    else process.env.POSTGRES_STORE_TEST_DATABASE_URL = previous;
  });
}

const record = (name) => `require("node:fs").appendFileSync("order.txt", "${name}\\n");`;

test("the smoke migrates, then seeds through the deployment entry, then starts the server", async (t) => {
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const consumer = fakeConsumer(t, {
    "migrate.js": record("migrate"),
    "seed-auth.js": record("seed"),
    "server.js": `${record("server")} console.log("fixture server says why"); process.exit(3);`
  });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "commonjs" }));
  fixtureDatabase(t);
  const failure = await smokeConsumer(consumer).then(
    () => assert.fail("the exiting server passed the smoke"),
    (error) => error
  );
  assert.match(failure.message, /exited before readiness/u);
  assert.equal(failure.step, "Start dist/server.js until /ready answers 200");
  assert.equal(readFileSync(join(consumer, "order.txt"), "utf8"), "migrate\nseed\nserver\n");
  const printed = console.error.mock.calls.map(({ arguments: [line] }) => line);
  assert.ok(printed.includes("fixture server says why"), "the server log is printed on failure");
});

test("a failing seed entry names its step and never starts the server", async (t) => {
  t.mock.method(console, "log", () => {});
  const consumer = fakeConsumer(t, {
    "migrate.js": "",
    "seed-auth.js": "process.exit(1);",
    "server.js": 'require("node:fs").writeFileSync("started", "");'
  });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "commonjs" }));
  fixtureDatabase(t);
  await assert.rejects(smokeConsumer(consumer), (error) => {
    assert.equal(error.step, "Seed the sign-in user with dist/seed-auth.js");
    return true;
  });
  assert.equal(existsSync(join(consumer, "started")), false);
});

test("a step keeps the first failing phase and the original message", async (t) => {
  t.mock.method(console, "log", () => {});
  const error = await step("outer", () =>
    step("inner", () => {
      throw new Error("fresh-resolution: sign-in returned 500 (expected 200)");
    })
  ).catch((caught) => caught);
  assert.equal(error.step, "inner");
  assert.equal(error.message, "fresh-resolution: sign-in returned 500 (expected 200)");
});

test("generated values are masked before any entry runs and redacted from the failure tail", async (t) => {
  const previous = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  t.after(() => {
    if (previous === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previous;
  });
  const consumer = fakeConsumer(t, {
    // The entries record the generated values so the test can look for them in the output.
    "migrate.js": `require("node:fs").writeFileSync("values.json", JSON.stringify([process.env.BETTER_AUTH_SECRET, process.env.RELEASE_SMOKE_PASSWORD]));`,
    "seed-auth.js": "",
    "server.js":
      "console.log(`secret=${process.env.BETTER_AUTH_SECRET}`);" +
      "console.error(`password=${process.env.RELEASE_SMOKE_PASSWORD}`);" +
      "process.exit(3);"
  });
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ type: "commonjs" }));
  fixtureDatabase(t);
  const masksBeforeEntries = [];
  t.mock.method(console, "log", (line = "") => {
    if (String(line).startsWith("::add-mask::")) {
      assert.equal(existsSync(join(consumer, "values.json")), false, "masked before any entry");
      masksBeforeEntries.push(String(line).slice("::add-mask::".length));
    }
  });
  t.mock.method(console, "error", () => {});
  await assert.rejects(smokeConsumer(consumer), /exited before readiness/u);
  const values = JSON.parse(readFileSync(join(consumer, "values.json"), "utf8"));
  for (const value of values) {
    assert.ok(value && masksBeforeEntries.includes(value), "every generated value is masked");
  }
  const printed = console.error.mock.calls.map(({ arguments: [line] }) => String(line)).join("\n");
  assert.match(printed, /secret=\*\*\*/u, "the tail is printed");
  assert.match(printed, /password=\*\*\*/u, "the tail is printed");
  for (const value of values) assert.equal(printed.includes(value), false, "value redacted");
});
