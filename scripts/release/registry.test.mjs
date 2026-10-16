import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { waitForPackages } from "./registry.mjs";

const version = "0.8.0-rc.1";
const packages = [{ name: "@work-shape/catalyst-api-contract", version }];
const visible = () => Response.json({ version });

function clock(t, fetch) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options, at: Date.now() });
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return fetch(calls.length, url, options);
  });
  return {
    calls,
    async tick(ms) {
      t.mock.timers.tick(ms);
      await setImmediate();
    }
  };
}

for (const status of [404, 429, 500, 502, 503, 599]) {
  test(`wait retries HTTP ${status}, retaining the package until its version is visible`, async (t) => {
    const { calls, tick } = clock(t, (attempt) =>
      attempt === 1 ? new Response(null, { status }) : visible()
    );
    const done = waitForPackages(packages);
    await tick(0);
    assert.equal(calls.length, 1);
    await tick(14_999);
    assert.equal(calls.length, 1);
    await tick(1);
    await done;
    assert.deepEqual(
      calls.map(({ at }) => at),
      [0, 15_000]
    );
    assert.equal(
      calls[0].url,
      "https://registry.npmjs.org/%40work-shape%2Fcatalyst-api-contract/0.8.0-rc.1"
    );
  });
}

test("wait retries network failures and backs off from 15 to 30 to 60 seconds", async (t) => {
  const { calls, tick } = clock(t, (attempt) => {
    if (attempt < 5) throw new TypeError("fetch failed: private server text");
    return visible();
  });
  const done = waitForPackages(packages);
  await tick(0);
  for (const delay of [15_000, 30_000, 60_000, 60_000]) {
    const before = calls.length;
    await tick(delay - 1);
    assert.equal(calls.length, before);
    await tick(1);
  }
  await done;
  assert.deepEqual(
    calls.map(({ at }) => at),
    [0, 15_000, 45_000, 105_000, 165_000]
  );
});

for (const status of [301, 400, 401, 403, 409, 422, 499, 600]) {
  test(`wait refuses HTTP ${status} immediately and preserves its status`, async (t) => {
    const { calls } = clock(t, () => ({ ok: false, status }));
    await assert.rejects(waitForPackages(packages), (error) => {
      assert.match(
        error.message,
        new RegExp(`HTTP ${status}; refusing to treat it as absent`, "u")
      );
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(Date.now(), 0);
  });
}

for (const failure of [404, 429, 503, "network error"]) {
  test(`wait exhausts exactly its 20-minute budget with the last ${failure} diagnostic`, async (t) => {
    const { calls, tick } = clock(t, () => {
      if (typeof failure === "string") throw new TypeError("private server text");
      return new Response(null, { status: failure });
    });
    const done = assert.rejects(waitForPackages(packages), (error) => {
      assert.match(error.message, /Timed out waiting for @work-shape\/catalyst-api-contract/u);
      assert.ok(error.message.includes(typeof failure === "number" ? `HTTP ${failure}` : failure));
      assert.doesNotMatch(error.message, /private server text/u);
      return true;
    });
    await tick(0);
    for (const delay of [15_000, 30_000, ...Array(19).fill(60_000), 15_000]) await tick(delay);
    await done;
    assert.equal(Date.now(), 20 * 60_000);
    assert.ok(calls.every(({ at }) => at < 20 * 60_000));
  });
}

test("an in-flight request uses the remaining total budget and cannot hang the wait", async (t) => {
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (ms) => {
    timeouts.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const { calls, tick } = clock(
    t,
    (_attempt, _url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason))
      )
  );
  const done = assert.rejects(waitForPackages(packages), /Timed out waiting.*network error/u);
  for (let step = 0; step < 100; step += 1) await tick(15_000);
  await done;
  assert.ok(timeouts.every((ms) => ms <= 30_000));
  assert.ok(timeouts.includes(15_000));
  assert.ok(calls.every(({ at }, index) => at + timeouts[index] <= 20 * 60_000));
});

test("all four packages must match; visible packages are not polled again", async (t) => {
  const all = Array.from({ length: 4 }, (_, index) => ({ name: `public-${index}`, version }));
  const { calls, tick } = clock(t, (attempt) => {
    if (attempt === 4) return Response.json({ version: "0.7.0" });
    return visible();
  });
  const done = waitForPackages(all);
  await tick(0);
  assert.equal(calls.length, 4);
  await tick(15_000);
  await done;
  assert.equal(calls.length, 5);
  assert.match(calls[4].url, /public-3/u);
});

test("malformed successful responses are refused without retry", async (t) => {
  const { calls } = clock(t, () => new Response("not json"));
  await assert.rejects(waitForPackages(packages), /Invalid registry response/u);
  assert.equal(calls.length, 1);
});

test("wait retries a network failure while reading the response body", async (t) => {
  const { calls, tick } = clock(t, (attempt) => {
    if (attempt > 1) return visible();
    return {
      ok: true,
      status: 200,
      json: async () => {
        throw new TypeError("terminated");
      }
    };
  });
  const done = waitForPackages(packages);
  await tick(0);
  await tick(15_000);
  await done;
  assert.equal(calls.length, 2);
});
