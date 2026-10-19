import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pushSmokeAgent, serveBuiltUi, typeInComposer } from "./composer-probe.mjs";

// A stalled consumer fails the release gate rather than holding publication indefinitely.
const STARTUP_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 5_000;
const POLL_INTERVAL_MS = 100;
const SERVER_LOG_LINES = 200;
const EMAIL = "release-smoke@example.test";
const ADMIN_EMAIL = "release-smoke-admin@example.test";

/**
 * Runs one named phase of the gate. A failure keeps its message (the auth drift proof matches
 * it) and carries the first failing phase, which the command line prints as the run's error.
 */
export async function step(name, action) {
  console.log(`\n==> ${name}`);
  try {
    return await action();
  } catch (error) {
    if (error instanceof Error && error.step === undefined) error.step = name;
    throw error;
  }
}

export async function freePort() {
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
  await step("Anonymous GET /api/v1/me answers 401", async () =>
    expectStatus(await request("/api/v1/me"), 401, "anonymous /api/v1/me")
  );
  const cookie = await step("Sign in over HTTP as the seeded user", async () => {
    const signIn = await request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl },
      body: JSON.stringify({ email: EMAIL, password })
    });
    expectStatus(signIn, 200, "sign-in");
    const value = signIn.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    if (!value) throw new Error("fresh-resolution: sign-in issued no session cookie");
    return value;
  });
  await step("Signed-in GET /api/v1/me answers 200 for that user", async () => {
    const me = await request("/api/v1/me", { headers: { cookie } });
    expectStatus(me, 200, "authenticated /api/v1/me");
    if ((await me.json()).email !== EMAIL) {
      throw new Error("fresh-resolution: authenticated /api/v1/me returned a different user");
    }
  });
}

/** Keeps the server's last lines so a failed start or request shows why, never more. */
function captureLog(child, redact) {
  const lines = [];
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    let partial = "";
    stream.on("data", (chunk) => {
      const parts = (partial + chunk).split("\n");
      partial = parts.pop();
      lines.push(...parts);
      if (lines.length > SERVER_LOG_LINES) lines.splice(0, lines.length - SERVER_LOG_LINES);
    });
  }
  return () => {
    console.error(`\n---- consumer server log, last ${lines.length} lines ----`);
    for (const line of lines) console.error(redact(line));
    console.error("---- end of consumer server log ----");
  };
}

/**
 * `apiPort` is the port the UI was built against (VITE_CHAT_API_URL); without a built UI the
 * smoke stops after the HTTP probe.
 */
export async function smokeConsumer(consumer, { apiPort, browser } = {}) {
  const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
  if (!databaseUrl)
    throw new Error("fresh-resolution: POSTGRES_STORE_TEST_DATABASE_URL is required");
  const port = apiPort ?? (await freePort());
  const baseUrl = `http://127.0.0.1:${port}`;
  const uiOrigin = `http://127.0.0.1:${await freePort()}`;
  const configPath = join(consumer, "smoke-config.json");
  const password = randomBytes(24).toString("base64url");
  // Signs in only to create the API key that makes the composer probe's agent available.
  const adminPassword = randomBytes(24).toString("base64url");
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
          trustedOrigins: [baseUrl, uiOrigin],
          seedUsers: [
            {
              email: EMAIL,
              displayLabel: "Release smoke",
              passwordEnvName: "RELEASE_SMOKE_PASSWORD",
              roles: ["user"]
            },
            {
              email: ADMIN_EMAIL,
              displayLabel: "Release smoke administrator",
              passwordEnvName: "RELEASE_SMOKE_ADMIN_PASSWORD",
              roles: ["user", "admin", "superadmin"]
            }
          ]
        }
      },
      infrastructure: { models: { local: { provider: "deterministic" } } },
      modelBindings: [{ id: "primary", providerId: "local", model: "deterministic-local" }]
    })
  );
  const secret = randomBytes(32).toString("base64url");
  // Exchanges the probe agent's API key for the access token the config CLI sends.
  const serviceTokenSecret = randomBytes(32).toString("base64url");
  // Register every generated value with the runner before any entry can print it. The log
  // tail below also redacts them and the database URL, should an entry echo its environment.
  if (process.env.GITHUB_ACTIONS) {
    for (const value of [secret, serviceTokenSecret, password, adminPassword]) {
      console.log(`::add-mask::${value}`);
    }
  }
  const hidden = [secret, serviceTokenSecret, password, adminPassword, databaseUrl];
  const redact = (line) => hidden.reduce((text, value) => text.replaceAll(value, "***"), line);
  const env = {
    ...process.env,
    NODE_PATH: "",
    HOST: "127.0.0.1",
    PORT: String(port),
    CLIENT_CONFIG_PATH: configPath,
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: secret,
    SERVICE_ACCESS_TOKEN_SECRET: serviceTokenSecret,
    RELEASE_SMOKE_PASSWORD: password,
    RELEASE_SMOKE_ADMIN_PASSWORD: adminPassword
  };
  // The deployments' own entries: compose's `migrate` service and their `seed:auth` script.
  const runEntry = (entry) =>
    execFileSync(process.execPath, [entry], {
      cwd: consumer,
      env,
      stdio: "inherit",
      timeout: STARTUP_TIMEOUT_MS
    });
  await step("Migrate the throwaway Postgres with dist/migrate.js", () =>
    runEntry("dist/migrate.js")
  );
  await step("Seed the sign-in user with dist/seed-auth.js", () => runEntry("dist/seed-auth.js"));
  const child = spawn(process.execPath, ["dist/server.js"], {
    cwd: consumer,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const printLog = captureLog(child, redact);
  // "close" follows the last output line, so a failure prints the complete log.
  const exited = once(child, "close");
  let failed = false;
  try {
    await step("Start dist/server.js until /ready answers 200", async () => {
      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      for (;;) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error("fresh-resolution: consumer exited before readiness");
        }
        try {
          const ready = await fetch(`${baseUrl}/ready`, {
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
          });
          if (ready.status === 200) return;
        } catch {
          /* The socket does not listen until startup completes. */
        }
        if (Date.now() >= deadline) {
          throw new Error("fresh-resolution: consumer readiness timed out");
        }
        await delay(POLL_INTERVAL_MS);
      }
    });
    await signedInRequest(baseUrl, password);
    const ui = join(consumer, "dist/client");
    if (existsSync(join(ui, "index.html"))) {
      await step("Make one agent available with the consumer's config push", () =>
        pushSmokeAgent(consumer, baseUrl, configPath, env)
      );
      await step("Type in the start-page composer of the built UI in Chromium", async () => {
        const stopUi = await serveBuiltUi(ui, Number(new URL(uiOrigin).port));
        try {
          const errors = await typeInComposer(uiOrigin, EMAIL, password, browser);
          if (errors.length > 0) {
            throw new Error(
              `fresh-resolution: the start-page composer failed: ${[...new Set(errors)].join(" | ")}`
            );
          }
        } finally {
          await stopUi();
        }
      });
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), STOP_TIMEOUT_MS);
    try {
      await exited;
    } finally {
      clearTimeout(killTimer);
      if (failed) printLog();
    }
  }
}
