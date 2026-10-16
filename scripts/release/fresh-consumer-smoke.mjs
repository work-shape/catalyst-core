import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// A stalled consumer fails the release gate rather than holding publication indefinitely.
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const EMAIL = "release-smoke@example.test";

async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return port;
}

function expectStatus(response, expected, step) {
  if (response.status !== expected) {
    throw new Error(`fresh-resolution: ${step} returned ${response.status} (expected ${expected})`);
  }
}

/** Real HTTP, including the cookie issued by better-auth; never log credentials or bodies. */
export async function signedInRequest(baseUrl, password) {
  const request = (path, options = {}) =>
    fetch(`${baseUrl}${path}`, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
  expectStatus(await request("/api/v1/me"), 401, "anonymous /api/v1/me");
  const signIn = await request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl },
    body: JSON.stringify({ email: EMAIL, password })
  });
  expectStatus(signIn, 200, "sign-in");
  const cookie = signIn.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("fresh-resolution: sign-in issued no session cookie");
  const me = await request("/api/v1/me", { headers: { cookie } });
  expectStatus(me, 200, "authenticated /api/v1/me");
  if ((await me.json()).email !== EMAIL) {
    throw new Error("fresh-resolution: authenticated /api/v1/me returned a different user");
  }
}

export async function smokeConsumer(consumer) {
  const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
  if (!databaseUrl)
    throw new Error("fresh-resolution: POSTGRES_STORE_TEST_DATABASE_URL is required");
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const configPath = join(consumer, "smoke-config.json");
  const password = randomBytes(24).toString("base64url");
  // JSON is valid YAML. This assembly needs no model key, Docker sandbox or customer assets.
  writeFileSync(
    configPath,
    JSON.stringify({
      version: 1,
      clientInstance: {
        id: "release-smoke",
        displayName: "Release smoke",
        environment: "development"
      },
      auth: {
        standalone: {
          enabled: true,
          baseUrl: `${baseUrl}/api/auth`,
          trustedOrigins: [baseUrl],
          seedUsers: [
            {
              email: EMAIL,
              displayLabel: "Release smoke",
              passwordEnvName: "RELEASE_SMOKE_PASSWORD",
              roles: ["user"]
            }
          ]
        }
      },
      infrastructure: { models: { local: { provider: "deterministic" } } },
      modelBindings: [{ id: "primary", providerId: "local", model: "deterministic-local" }]
    })
  );
  const env = {
    ...process.env,
    NODE_PATH: "",
    HOST: "127.0.0.1",
    PORT: String(port),
    CLIENT_CONFIG_PATH: configPath,
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
    RELEASE_SMOKE_PASSWORD: password
  };
  execFileSync(process.execPath, ["dist/migrate.js"], {
    cwd: consumer,
    env,
    stdio: "inherit",
    timeout: STARTUP_TIMEOUT_MS
  });
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: consumer,
    env,
    stdio: ["ignore", "ignore", "inherit"]
  });
  const exited = once(child, "exit");
  try {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error("fresh-resolution: consumer exited before readiness");
      }
      try {
        const ready = await fetch(`${baseUrl}/ready`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (ready.status === 200) break;
      } catch {
        /* The socket does not listen until startup completes. */
      }
      if (Date.now() >= deadline) throw new Error("fresh-resolution: consumer readiness timed out");
      await delay(POLL_INTERVAL_MS);
    }
    await signedInRequest(baseUrl, password);
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
    }
  }
}
