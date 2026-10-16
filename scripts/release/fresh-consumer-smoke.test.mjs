import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { signedInRequest } from "./fresh-consumer-smoke.mjs";

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
