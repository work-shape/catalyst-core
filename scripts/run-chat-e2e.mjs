#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

const requiredBuilds = [
  ["packages/core", "build"],
  ["packages/config-schema", "build"],
  ["packages/api-contract", "build"],
  ["packages/auth", "build"],
  ["packages/capability-sdk", "build"],
  ["packages/tool-sdk", "build"],
  ["packages/model-provider", "build"],
  ["packages/usage-governance", "build"],
  ["packages/data-source", "build"],
  ["packages/tool-execution", "build"],
  ["packages/postgres-store", "build"],
  ["packages/agent-runtime", "build"],
  ["packages/chat-server", "build"],
  ["packages/client-assembly", "build"],
  ["packages/api-client", "build"],
  ["packages/chat-ui", "build"],
  ["packages/config-cli", "build"],
  ["clients/demo", "build:server"]
];

const defaultStateGrep = "@chat-state";

const options = parseArgs(process.argv.slice(2));
const e2eHost = process.env.E2E_HOST ?? "127.0.0.1";
const e2eApiPort = process.env.E2E_API_PORT ?? "4210";
const e2eUiPort = process.env.E2E_UI_PORT ?? "5273";
const e2ePostgresPort = process.env.E2E_POSTGRES_PORT ?? "55433";
const e2eComposeProject = process.env.E2E_COMPOSE_PROJECT ?? "agent-chat-e2e";
const e2eApiUrl = process.env.E2E_API_URL ?? `http://${e2eHost}:${e2eApiPort}`;
const e2eUiUrl = process.env.E2E_UI_URL ?? `http://${e2eHost}:${e2eUiPort}`;
const generatedConfigPath = resolve(repoRoot, ".tmp/e2e/e2e-app.yaml");
const e2eConfigPath = resolve(repoRoot, process.env.E2E_CONFIG_PATH ?? generatedConfigPath);
const e2eSessionTokenSecret = "e2e-session-token-secret-with-at-least-24-characters";
const e2eServerCredential = "e2e-server-to-server-credential";

const children = new Set();
let cleanupStarted = false;
let serverExitError;
let rejectServerExit;
const serverExitPromise = new Promise((_, reject) => {
  rejectServerExit = reject;
});
serverExitPromise.catch(() => undefined);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    void cleanup()
      .finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  });
}

try {
  await prepareConfig();
  if (options.build) {
    await buildRequiredPackages();
  }
  await assertTcpPortAvailable(e2eApiPort, "API");
  await assertTcpPortAvailable(e2eUiPort, "UI");
  await startPostgres();
  startApiServer();
  startUiServer();
  await withServerMonitoring(
    Promise.all([
      waitForUrl(`${e2eApiUrl}/health`, { label: "API health" }),
      waitForUrl(e2eUiUrl, { label: "Vite UI" })
    ])
  );
  await withServerMonitoring(pushConfigAssets());
  await withServerMonitoring(waitForAuthReady());
  await withServerMonitoring(runPlaywright());
  await cleanup();
} catch (error) {
  await cleanup();
  throw error;
}

function parseArgs(args) {
  const options = {
    build: process.env.E2E_SKIP_BUILD !== "1",
    keep: process.env.E2E_KEEP_STACK === "1",
    mode: "all",
    playwrightArgs: []
  };

  let passthrough = false;
  for (const arg of args) {
    if (passthrough) {
      options.playwrightArgs.push(arg);
      continue;
    }
    if (arg === "--") {
      passthrough = true;
      continue;
    }
    if (arg === "--state") {
      options.mode = "state";
      continue;
    }
    if (arg === "--all") {
      options.mode = "all";
      continue;
    }
    if (arg === "--no-build") {
      options.build = false;
      continue;
    }
    if (arg === "--keep-stack") {
      options.keep = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    options.playwrightArgs.push(arg);
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/run-chat-e2e.mjs [--state|--all] [--no-build] [--keep-stack] [-- <playwright args>]

Environment:
  E2E_HOST              Host for API and UI servers, default 127.0.0.1
  E2E_API_PORT          API port, default 4210
  E2E_UI_PORT           UI port, default 5273
  E2E_POSTGRES_PORT     Postgres host port, default 55433
  E2E_COMPOSE_PROJECT   Docker Compose project name, default agent-chat-e2e
  E2E_SKIP_BUILD=1      Skip package/server builds
  E2E_KEEP_STACK=1      Leave services running for debugging

Examples:
  node scripts/run-chat-e2e.mjs --state
  node scripts/run-chat-e2e.mjs --state -- --headed
  E2E_UI_PORT=5274 node scripts/run-chat-e2e.mjs --all
`);
}

async function prepareConfig() {
  await mkdir(dirname(e2eConfigPath), { recursive: true });
  const fixturePath = resolve(repoRoot, "tests/fixtures/e2e-app.yaml");
  const fixture = await readFile(fixturePath, "utf8");
  const generated = fixture
    .replaceAll("http://127.0.0.1:4210", e2eApiUrl)
    .replaceAll("http://127.0.0.1:5273", e2eUiUrl);
  await writeFile(e2eConfigPath, generated);
}

async function buildRequiredPackages() {
  for (const [relativePackageDir, scriptName] of requiredBuilds) {
    const packageDir = resolve(repoRoot, relativePackageDir);
    const packageJson = JSON.parse(await readFile(resolve(packageDir, "package.json"), "utf8"));
    const script = packageJson.scripts?.[scriptName];
    if (typeof script !== "string") {
      throw new Error(`Missing ${scriptName} script in ${relativePackageDir}`);
    }

    const [command, ...args] = script.trim().split(/\s+/u);
    if (command !== "tsup") {
      throw new Error(`Expected ${relativePackageDir} ${scriptName} to use tsup, got: ${script}`);
    }

    await run(localBin(command), args, { cwd: packageDir, label: `${relativePackageDir}:${scriptName}` });
  }
}

async function startPostgres() {
  const composeEnv = {
    ...process.env,
    COMPOSE_PROJECT_NAME: e2eComposeProject,
    POSTGRES_HOST_PORT: e2ePostgresPort
  };
  await run("docker", ["compose", "-f", "clients/demo/docker-compose.yml", "down", "-v", "--remove-orphans"], {
    cwd: repoRoot,
    env: composeEnv,
    label: "docker compose down"
  });
  await run("docker", ["compose", "-f", "clients/demo/docker-compose.yml", "up", "-d", "--wait", "postgres"], {
    cwd: repoRoot,
    env: composeEnv,
    label: "docker compose up postgres"
  });
}

function startApiServer() {
  return spawnManaged(process.execPath, ["clients/demo/dist/server.js"], {
    cwd: repoRoot,
    label: "chat api",
    env: {
      ...process.env,
      HOST: e2eHost,
      PORT: e2eApiPort,
      CLIENT_CONFIG_PATH: e2eConfigPath,
      DATABASE_URL: `postgres://agent_chat:agent_chat@${e2eHost}:${e2ePostgresPort}/agent_chat`,
      RUN_MIGRATIONS: "true",
      CHAT_UI_ORIGIN: e2eUiUrl,
      BETTER_AUTH_URL: `${e2eApiUrl}/api/auth`,
      BETTER_AUTH_SECRET: "e2e-better-auth-secret-with-at-least-32-characters",
      E2E_SUPERADMIN_EMAIL: "e2e-superadmin@example.test",
      E2E_USER_EMAIL: "e2e-user@example.test",
      CHAT_SESSION_TOKEN_SECRET: e2eSessionTokenSecret,
      CHAT_SERVER_CREDENTIAL: e2eServerCredential
    }
  });
}

async function pushConfigAssets() {
  await run(
    process.execPath,
    [
      "packages/config-cli/dist/index.js",
      "config",
      "push",
      "--force",
      "--dir",
      "tests/fixtures/e2e-assets",
      "--instance",
      e2eApiUrl
    ],
    {
      cwd: repoRoot,
      label: "config asset push",
      env: {
        ...process.env,
        CATALYST_SERVER_CREDENTIAL: e2eServerCredential
      }
    }
  );
}

function startUiServer() {
  return spawnManaged(localBin("vite"), ["--host", e2eHost, "--port", e2eUiPort], {
    cwd: resolve(repoRoot, "clients/demo"),
    label: "chat ui",
    env: {
      ...process.env,
      VITE_CHAT_API_PORT: e2eApiPort,
      VITE_CHAT_API_URL: e2eApiUrl
    }
  });
}

async function runPlaywright() {
  const args = ["test", "e2e/chat-standalone.spec.ts"];
  if (options.mode === "state") {
    args.push("--grep", defaultStateGrep);
  }
  args.push(...options.playwrightArgs);

  await run(localBin("playwright"), args, {
    cwd: repoRoot,
    label: options.mode === "state" ? "playwright chat state" : "playwright chat",
    env: {
      ...process.env,
      E2E_USE_EXTERNAL_SERVERS: "1",
      E2E_HOST: e2eHost,
      E2E_API_PORT: e2eApiPort,
      E2E_UI_PORT: e2eUiPort,
      E2E_POSTGRES_PORT: e2ePostgresPort,
      E2E_COMPOSE_PROJECT: e2eComposeProject,
      E2E_API_URL: e2eApiUrl,
      E2E_UI_URL: e2eUiUrl,
      E2E_CONFIG_PATH: e2eConfigPath
    }
  });
}

async function assertTcpPortAvailable(port, label) {
  await new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.once("error", (error) => {
      const message =
        error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE"
          ? `${label} port ${port} is already in use. Set E2E_${label.toUpperCase()}_PORT to use another port.`
          : `${label} port ${port} is not available: ${error.message}`;
      rejectPromise(new Error(message));
    });
    server.once("listening", () => {
      server.close(() => resolvePromise());
    });
    server.listen(Number(port), e2eHost);
  });
}

async function withServerMonitoring(work) {
  if (serverExitError) {
    throw serverExitError;
  }
  return Promise.race([work, serverExitPromise]);
}

async function waitForUrl(url, { label }) {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
      lastError = new Error(`${label} returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${label} at ${url}: ${lastError?.message ?? "unknown error"}`);
}

async function waitForAuthReady() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${e2eApiUrl}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "origin": e2eUiUrl,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          email: "e2e-user@example.test",
          password: "e2e-user-password",
          rememberMe: true
        })
      });
      if (response.ok) {
        return;
      }
      lastError = new Error(`auth sign-in returned ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for auth/database readiness: ${lastError?.message ?? "unknown error"}`);
}

function spawnManaged(command, args, { cwd, env, label }) {
  console.log(`\n[e2e] starting ${label}`);
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: "inherit"
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (!cleanupStarted) {
      serverExitError = new Error(`${label} exited unexpectedly with ${signal ?? `exit code ${code}`}`);
      rejectServerExit(serverExitError);
    }
  });
  return child;
}

async function run(command, args, { cwd, env = process.env, label }) {
  console.log(`\n[e2e] ${label}`);
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit"
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      rejectPromise(new Error(`${label} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}

async function cleanup() {
  if (cleanupStarted) {
    return;
  }
  cleanupStarted = true;

  await Promise.all([...children].map((child) => stopChild(child)));

  if (options.keep) {
    console.log("\n[e2e] keeping docker stack because --keep-stack/E2E_KEEP_STACK is set");
    return;
  }

  await run("docker", ["compose", "-f", "clients/demo/docker-compose.yml", "down", "-v", "--remove-orphans"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      COMPOSE_PROJECT_NAME: e2eComposeProject,
      POSTGRES_HOST_PORT: e2ePostgresPort
    },
    label: "docker compose cleanup"
  }).catch((error) => {
    console.error(`[e2e] cleanup failed: ${error.message}`);
  });
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    delay(3_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    })
  ]);
}

function localBin(name) {
  const suffix = process.platform === "win32" ? ".cmd" : "";
  const path = resolve(repoRoot, "node_modules/.bin", `${name}${suffix}`);
  if (!existsSync(path)) {
    throw new Error(`Missing local binary: ${path}`);
  }
  return path;
}

function delay(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}
