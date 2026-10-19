import { requireIdle } from "./idle.mjs";
import { randomBytes } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  open,
  rm,
  readdir,
  realpath,
  cp
} from "node:fs/promises";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";
import postgres from "postgres";
import { execFileSync } from "node:child_process";
import { sourceFingerprint, treeHash } from "./fingerprints.mjs";
import { hash, LIMITS, validateReceipt, parsePinnedImage } from "./safety.mjs";
import { until } from "./processes.mjs";
import {
  testPostgresDockerOptions,
  testPostgresServerArguments
} from "../test-postgres-server.mjs";

const RESERVED_PORTS = new Set([
  4100, 4101, 4111, 5174, 5373, 5374, 4373, 4374, 55373, 55374, 55434, 9091
]);
const SERVER_FILES = [
  "server",
  "workspace-command-worker",
  "knowledge-worker",
  "sample-mcp-server"
];
// Readiness includes worker heartbeats; a healthy API alone is insufficient.
const WORKER_FRESH_MS = 30_000;
export const ENTRYPOINT = "clients/demo/dist/server.js";
const random = () => randomBytes(32).toString("base64url");
function command(command, args, root) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 10000
  }).trim();
}
export async function port() {
  const server = createServer();
  await new Promise((ok, no) => {
    server.once("error", no);
    server.listen(0, "127.0.0.1", ok);
  });
  const chosen = server.address().port;
  await new Promise((ok) => server.close(ok));
  return RESERVED_PORTS.has(chosen) ? port() : chosen;
}
export function minimalEnv() {
  return Object.fromEntries(
    [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "PNPM_HOME",
      "DOCKER_CONFIG",
      "DOCKER_HOST",
      "DOCKER_CONTEXT"
    ]
      .filter((k) => process.env[k])
      .map((k) => [k, process.env[k]])
  );
}
export async function fingerprint(root, configPath) {
  return {
    ...(await sourceFingerprint(root)),
    builds: await treeHash(
      root,
      [
        (await readdir(resolve(root, "packages"))).map((name) => `packages/${name}/dist`),
        "clients/demo/dist"
      ].flat()
    ),
    config: hash(await readFile(configPath)),
    migrations: await treeHash(root, ["packages/postgres-store/migrations"])
  };
}
// The source key is required only for service processes, never browser or build environments.
export async function modelKey(root) {
  const env = await readFile(resolve(root, "clients/demo/.env"), "utf8").catch(() => {
    throw new Error("Missing private demo .env model-key prerequisite");
  });
  const line = env.split(/\r?\n/u).find((l) => /^\s*(?:export\s+)?OPENAI_API_KEY\s*=/u.test(l));
  if (!line) throw new Error("OPENAI_API_KEY missing from demo .env");
  let value = line.slice(line.indexOf("=") + 1).trim();
  if ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))
    value = value.slice(1, -1);
  else value = value.replace(/\s+#.*$/u, "");
  if (!value) throw new Error("Empty model-key prerequisite");
  return value;
}
// Change the setup sign-in, while preserving the demo's actual administrative rights.
export function isolatedSetupUser(users) {
  const shipped = users.find((user) => user.roles.includes("superadmin"));
  if (!shipped) throw new Error("Demo has no setup superadmin");
  return {
    ...shipped,
    displayLabel: "Story setup",
    email: "setup@example.test",
    emailEnvName: undefined,
    passwordEnvName: "STORY_SETUP_PASSWORD",
    developmentPassword: undefined
  };
}
/**
 * Points the owned config copy's agents at the story model. Every shipped and generated agent
 * names `primary`, so `primary` takes the chosen binding's model at the chosen effort; the demo's
 * own config is never edited. Returns what the stack's agents run on.
 */
export function storyModel(config, { bindingId, reasoningEffort }) {
  const chosen = config.modelBindings.find((b) => b.id === bindingId);
  if (!chosen || chosen.kind === "embedding" || chosen.agentSelectable === false)
    throw new Error(`Unknown agent model binding '${bindingId}'`);
  const provider = config.infrastructure.models[chosen.providerId];
  const primary = config.modelBindings.find((b) => b.id === "primary");
  primary.providerId = chosen.providerId;
  primary.model = chosen.model ?? provider.model;
  primary.reasoningEffort = reasoningEffort;
  return { provider: provider.provider, model: primary.model, reasoningEffort, bindingId };
}
/**
 * A copy of the demo's own agents and skills for the seed. An agent's own effort would outrank
 * its binding's, so the copy carries the story effort instead.
 */
export async function stageInstanceAssets(root, dir, reasoningEffort) {
  const source = resolve(root, "clients/demo");
  await mkdir(resolve(dir, "agents"), { recursive: true, mode: 0o700 });
  await cp(resolve(source, "catalyst.yaml"), resolve(dir, "catalyst.yaml"));
  await cp(resolve(source, "skills"), resolve(dir, "skills"), { recursive: true });
  for (const name of await readdir(resolve(source, "agents"))) {
    const agent = parse(await readFile(resolve(source, "agents", name), "utf8"));
    if (agent.reasoningEffort) agent.reasoningEffort = reasoningEffort;
    await writeFile(resolve(dir, "agents", name), stringify(agent), { mode: 0o600 });
  }
}
export async function coldStack(root, folder, supervisor, deadline, choice) {
  const privateDir = resolve(folder, ".private");
  await mkdir(privateDir, { recursive: true, mode: 0o700 });
  const owner = random();
  const worktree = dirname(root).split("/").at(-1);
  const runId = folder.split("/").at(-1).toLowerCase();
  const ports = {
    api: await port(),
    ui: await port(),
    postgres: await port(),
    sample: await port(),
    sampleBackend: await port()
  };
  const image = parsePinnedImage(
    await readFile(resolve(root, "docker/postgres/pinned-image"), "utf8")
  );
  const runnerImage = `catalyst-agent-stories-${runId}:local`;
  const container = `catalyst-agent-stories-${runId}`;
  const configPath = resolve(privateDir, "app.yaml");
  const source = await sourceFingerprint(root);
  if (command("git", ["status", "--porcelain", "--", "packages/postgres-store/migrations"], root))
    throw new Error("Refusing uncommitted migrations");
  const key = await modelKey(root);
  const secrets = {
    owner,
    password: random(),
    postgres: random(),
    auth: random(),
    store: randomBytes(32).toString("base64"),
    session: random(),
    server: random(),
    service: random(),
    sample: random(),
    seed: random()
  };
  const api = `http://127.0.0.1:${ports.api}`,
    ui = `http://127.0.0.1:${ports.ui}`;
  const config = parse(await readFile(resolve(root, "clients/demo/config/app.yaml"), "utf8"));
  config.clientInstance.id = `agent-stories-${runId}`;
  config.auth.standalone.baseUrl = `${api}/api/auth`;
  config.auth.standalone.trustedOrigins = [ui];
  config.auth.standalone.seedUsers = [isolatedSetupUser(config.auth.standalone.seedUsers)];
  config.infrastructure.mail.appUrl = ui;
  if (config.infrastructure.mail.provider !== "capture")
    throw new Error("Demo mail must remain capture-only");
  config.usage.budget.dailySpendLimit = Math.min(
    config.usage.budget.dailySpendLimit,
    LIMITS.micros / 1e6
  );
  config.usage.budget.monthlySpendLimit = Math.min(
    config.usage.budget.monthlySpendLimit,
    LIMITS.micros / 1e6
  );
  for (const [name, storage] of Object.entries(config.infrastructure.objectStorage))
    storage.root = resolve(privateDir, "objects", name);
  config.infrastructure.sandbox.image = runnerImage;
  config.uiFile = resolve(root, "clients/demo/config/ui.yaml");
  const model = storyModel(config, choice);
  config.egress.allow = [
    {
      protocol: "http",
      host: "127.0.0.1",
      port: ports.sample,
      network: "private",
      cidrs: ["127.0.0.0/8"]
    }
  ];
  for (const connection of Object.values(config.connections)) {
    for (const field of ["url", "baseUrl"])
      if (connection.settings[field])
        connection.settings[field] = connection.settings[field].replace(
          "http://sample-mcp:8787",
          `http://127.0.0.1:${ports.sample}`
        );
  }
  await writeFile(configPath, stringify(config), { mode: 0o600 });
  const env = {
    ...minimalEnv(),
    CLIENT_CONFIG_PATH: configPath,
    DATABASE_URL: `postgres://story:${secrets.postgres}@127.0.0.1:${ports.postgres}/story`,
    HOST: "127.0.0.1",
    PORT: String(ports.api),
    CHAT_UI_ORIGIN: ui,
    BETTER_AUTH_URL: `${api}/api/auth`,
    BETTER_AUTH_SECRET: secrets.auth,
    STORY_SETUP_PASSWORD: secrets.password,
    DEMO_SECRET_STORE_KEY: secrets.store,
    CHAT_SESSION_TOKEN_SECRET: secrets.session,
    CHAT_SERVER_CREDENTIAL: secrets.server,
    SERVICE_ACCESS_TOKEN_SECRET: secrets.service,
    DEMO_SAMPLE_MCP_KEY: secrets.sample,
    DEMO_SEED_PASSWORD: secrets.seed,
    OPENAI_API_KEY: key,
    EXECUTION_WORKSPACE_RUNNER_IMAGE: runnerImage,
    WORKSPACE_COMMAND_TEMP_ROOT: resolve(privateDir, "commands"),
    WORKSPACE_COMMAND_WORKER_ID: `${runId}-workspace`,
    KNOWLEDGE_WORKER_ID: `${runId}-knowledge`
  };
  const stack = {
    owner,
    uid: process.getuid(),
    host: hostname(),
    root,
    folder,
    privateDir,
    configPath,
    ports,
    image,
    runnerImage,
    container,
    api,
    ui,
    env,
    secrets,
    worktree,
    pids: [],
    created: true,
    resources: []
  };
  // Register cleanup before the first build or Docker mutation.
  supervisor.stack = stack;
  await writeFile(
    resolve(folder, "resources.json"),
    JSON.stringify({ owner, worktree, root, container, runnerImage, ports, pids: stack.pids }),
    { mode: 0o600 }
  );
  const builds = [
    "--workspace-concurrency=1",
    "-r",
    "--filter",
    "@work-shape/catalyst-demo...",
    "--filter",
    "@work-shape/catalyst-cli...",
    "build"
  ];
  await supervisor.run("pnpm", builds, "normal demo build", {
    ...minimalEnv(),
    VITE_CHAT_API_URL: api,
    VITE_CHAT_API_PORT: String(ports.api)
  });
  await supervisor.run(
    "docker",
    [
      "build",
      "--label",
      `catalyst.worktree=${worktree}`,
      "--label",
      `catalyst.agent-stories=${owner}`,
      "--target",
      "workspace-command-runner",
      "-t",
      runnerImage,
      "-f",
      "docker/vivd-client.Dockerfile",
      "."
    ],
    "Docker command runner",
    minimalEnv()
  );
  stack.resources.push("image");
  await supervisor.run(
    "docker",
    [
      "run",
      "-d",
      "--name",
      container,
      "--label",
      `catalyst.worktree=${worktree}`,
      "--label",
      `catalyst.agent-stories=${owner}`,
      "-e",
      "POSTGRES_USER=story",
      "-e",
      "POSTGRES_DB=story",
      "-e",
      "POSTGRES_PASSWORD",
      "-p",
      `127.0.0.1:${ports.postgres}:5432`,
      ...testPostgresDockerOptions(),
      image,
      "-c",
      "max_connections=618",
      ...testPostgresServerArguments()
    ],
    "pinned Postgres",
    { ...minimalEnv(), POSTGRES_PASSWORD: secrets.postgres }
  );
  stack.resources.push("container");
  await until(
    async () => {
      try {
        return command(
          "docker",
          ["exec", container, "pg_isready", "-U", "story", "-d", "story"],
          root
        ).includes("accepting");
      } catch {
        return false;
      }
    },
    Boolean,
    deadline,
    () => supervisor.check()
  );
  await supervisor.run(
    process.execPath,
    ["clients/demo/dist/migrate.js"],
    "committed migrations",
    env
  );
  await supervisor.run(process.execPath, ["clients/demo/dist/seed-auth.js"], "setup auth", env);
  for (const file of SERVER_FILES) {
    const args = [`clients/demo/dist/${file}.js`];
    const service = supervisor.start(
      process.execPath,
      args,
      file,
      file === "sample-mcp-server" ? { ...env, PORT: String(ports.sampleBackend) } : env
    );
    stack.pids.push({ pid: service.child.pid, label: file });
    service.completion.then(
      () => {
        if (!supervisor.stopping) supervisor.failure = new Error(`${file}: exited unexpectedly`);
      },
      () => {}
    );
  }
  const proxy = supervisor.start(
    process.execPath,
    ["scripts/agent-stories/sample-proxy.mjs"],
    "sample-proxy",
    {
      ...minimalEnv(),
      STORY_SAMPLE_PORT: String(ports.sample),
      STORY_SAMPLE_UPSTREAM: `http://127.0.0.1:${ports.sampleBackend}`
    }
  );
  stack.pids.push({ pid: proxy.child.pid, label: "sample-proxy" });
  proxy.completion.then(
    () => {
      if (!supervisor.stopping) supervisor.failure = new Error("sample proxy exited");
    },
    () => {}
  );
  const uiChild = supervisor.start(
    resolve(root, "node_modules/.bin/vite"),
    ["preview", "--host", "127.0.0.1", "--port", String(ports.ui), "--strictPort"],
    "UI",
    { ...minimalEnv(), VITE_CHAT_API_URL: api, VITE_CHAT_API_PORT: String(ports.api) },
    resolve(root, "clients/demo")
  );
  stack.pids.push({ pid: uiChild.child.pid, label: "UI" });
  uiChild.completion.then(
    () => {
      if (!supervisor.stopping) supervisor.failure = new Error("UI exited");
    },
    () => {}
  );
  stack.sql = postgres(env.DATABASE_URL, { max: 2, connect_timeout: 5, onnotice() {} });
  await supervisor.onDatabase?.(stack);
  await writeFile(
    resolve(folder, "resources.json"),
    JSON.stringify({ owner, worktree, root, container, runnerImage, ports, pids: stack.pids }),
    { mode: 0o600 }
  );
  await ready(stack, deadline, () => supervisor.check());
  await bundleCommittedSeed(root, supervisor);
  const instanceAssets = resolve(privateDir, "instance-assets");
  await stageInstanceAssets(root, instanceAssets, model.reasoningEffort);
  await supervisor.run(
    process.execPath,
    [
      resolve(root, "clients/demo/dist/agent-stories-seed.mjs"),
      api,
      configPath,
      root,
      privateDir,
      resolve(folder, "seed.json"),
      instanceAssets
    ],
    "committed seedDemo",
    env
  );
  await rm(resolve(root, "clients/demo/dist/agent-stories-seed.mjs"), { force: true });
  stack.seededIds = (await stack.sql`select id from config_assets`).map((r) => r.id);
  stack.seedHash = await treeHash(root, [
    "clients/demo/src/seed",
    "clients/demo/seed",
    "clients/demo/agents",
    "clients/demo/skills"
  ]);
  stack.model = model;
  stack.fingerprint = await fingerprint(root, configPath);
  if (source.head !== stack.fingerprint.head || source.dirty !== stack.fingerprint.dirty)
    throw new Error("Source changed during build");
  stack.fingerprint.capabilities = await sourceFingerprint(resolve(root, "../capabilities"));
  stack.imageId = command("docker", ["image", "inspect", runnerImage, "--format", "{{.Id}}"], root);
  stack.migrationRows =
    await stack.sql`select hash,created_at from drizzle.__drizzle_migrations order by id`;
  await writeFile(
    resolve(privateDir, "stack-auth.json"),
    JSON.stringify({ env: { ...env, OPENAI_API_KEY: undefined }, secrets, ports }),
    { mode: 0o600 }
  );
  return stack;
}
export async function bundleCommittedSeed(root, supervisor) {
  await supervisor.run(
    resolve(root, "node_modules/.bin/esbuild"),
    [
      "clients/demo/scripts/agent-stories-seed.mjs",
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--packages=external",
      "--external:@work-shape/*",
      `--outfile=${root}/clients/demo/dist/agent-stories-seed.mjs`
    ],
    "bundle committed seed",
    minimalEnv()
  );
}
export async function ready(stack, deadline, check) {
  await until(
    async () => {
      try {
        return (
          (await fetch(`${stack.api}/ready`, { signal: AbortSignal.timeout(5_000) })).ok &&
          (await fetch(stack.ui, { signal: AbortSignal.timeout(5_000) })).ok
        );
      } catch {
        return false;
      }
    },
    Boolean,
    deadline,
    check
  );
  await until(
    async () => {
      const rows =
        await stack.sql`select kind from job_worker_reports where seen_at > now() - ${WORKER_FRESH_MS} * interval '1 millisecond'`;
      return ["workspace.command", "page.bundle", "workflow_run.execute_step"].every((kind) =>
        rows.some((r) => r.kind === kind)
      );
    },
    Boolean,
    deadline,
    check
  );
}
export async function receipt(stack, status = "idle") {
  return {
    owner: stack.owner,
    uid: stack.uid,
    host: stack.host,
    root: stack.root,
    ...stack.fingerprint,
    entrypoint: ENTRYPOINT,
    image: stack.image,
    imageId: stack.imageId,
    ports: stack.ports,
    modules: hash(await readFile(stack.configPath)),
    workers: SERVER_FILES,
    status,
    pids: stack.pids,
    container: stack.container,
    runnerImage: stack.runnerImage,
    seededIds: stack.seededIds,
    seedHash: stack.seedHash,
    model: stack.model,
    migrationRows: stack.migrationRows
  };
}
export async function reuseStack(root, file, supervisor, deadline) {
  // Validate the local file and fingerprints before connecting or mutating the stack.
  const path = await realpath(resolve(file));
  const allowed = resolve(root, "../tmp/agent-stories") + "/";
  if (!path.startsWith(allowed) || path.split("/").includes(".."))
    throw new Error("Reuse receipt must be under this workspace tmp/agent-stories");
  const info = await stat(path);
  if (info.uid !== process.getuid() || info.mode & 0o077)
    throw new Error("Reuse receipt is not private and owned");
  const held = JSON.parse(await readFile(path, "utf8"));
  const authPath = resolve(dirname(path), ".private/stack-auth.json");
  if ((await realpath(authPath)) !== authPath) throw new Error("Refusing linked stack credentials");
  const authInfo = await stat(authPath);
  if (authInfo.uid !== process.getuid() || authInfo.mode & 0o077)
    throw new Error("Refusing shared stack credentials");
  const auth = JSON.parse(await readFile(authPath, "utf8"));
  if (auth.secrets.owner !== held.owner) throw new Error("Stack owner proof mismatch");
  const key = await modelKey(root);

  const folder = dirname(path),
    privateDir = resolve(folder, ".private"),
    configPath = resolve(privateDir, "app.yaml");
  const expected = {
    ...held,
    ...(await fingerprint(root, configPath)),
    capabilities: await sourceFingerprint(resolve(root, "../capabilities")),
    ports: auth.ports,
    root,
    uid: process.getuid(),
    host: hostname(),
    entrypoint: ENTRYPOINT,
    workers: SERVER_FILES,
    modules: hash(await readFile(configPath)),
    image: parsePinnedImage(await readFile(resolve(root, "docker/postgres/pinned-image"), "utf8"))
  };
  expected.imageId = command(
    "docker",
    ["image", "inspect", held.runnerImage, "--format", "{{.Id}}"],
    root
  );
  validateReceipt(held, expected);
  for (const value of Object.values(held.ports))
    if (!Number.isInteger(value) || value < 1024 || RESERVED_PORTS.has(value))
      throw new Error("Refusing unsafe reuse port");
  const container = JSON.parse(command("docker", ["inspect", held.container], root))[0];
  if (
    container.Config.Labels["catalyst.agent-stories"] !== held.owner ||
    container.Config.Image !== held.image ||
    !container.State.Running
  )
    throw new Error("Refusing unowned Postgres");
  for (const item of held.pids ?? []) {
    if (!Number.isInteger(item.pid) || item.pid <= 0) throw new Error("Refusing invalid owned PID");
    const args = command("ps", ["-p", String(item.pid), "-o", "args="], root);
    const expectedEntry =
      item.label === "UI"
        ? "vite"
        : item.label === "sample-proxy"
          ? "scripts/agent-stories/sample-proxy.mjs"
          : `clients/demo/dist/${item.label}.js`;
    if (!args.includes(expectedEntry)) throw new Error("Refusing drifted service entrypoint");
    const cwd = command("lsof", ["-a", "-p", String(item.pid), "-d", "cwd", "-Fn"], root)
      .split("\n")
      .find((line) => line.startsWith("n"))
      ?.slice(1);
    if (cwd !== (item.label === "UI" ? resolve(root, "clients/demo") : root))
      throw new Error("Refusing service from another worktree");
  }
  const lock = await open(resolve(folder, "reuse.lock"), "wx", 0o600).catch(() => {
    throw new Error("Stack is already exclusively leased");
  });
  const env = { ...auth.env, OPENAI_API_KEY: key };
  const stack = {
    ...held,
    root,
    folder,
    privateDir,
    configPath,
    env,
    secrets: auth.secrets,
    api: `http://127.0.0.1:${held.ports.api}`,
    ui: `http://127.0.0.1:${held.ports.ui}`,
    created: false,
    lock,
    sql: postgres(env.DATABASE_URL, { max: 2, connect_timeout: 5, onnotice() {} }),
    fingerprint: expected
  };
  supervisor.stack = stack;
  // Attribute only new calls even when an idle/readiness check refuses reuse.
  await supervisor.onDatabase?.(stack);
  const [active] =
    await stack.sql`select (select count(*) from agent_runs where status not in ('completed','failed','cancelled')) as runs,(select count(*) from model_usage_events where status in ('pending','abandoned')) as pending`;
  const jobs =
    await stack.sql`select kind,status,dedupe_key,run_after from platform_jobs where status in ('queued','running')`;
  requireIdle({ runs: Number(active.runs), pending: Number(active.pending), jobs });
  const migrations =
    await stack.sql`select hash,created_at from drizzle.__drizzle_migrations order by id`;
  if (JSON.stringify(migrations) !== JSON.stringify(held.migrationRows))
    throw new Error("Refusing stale migration state");
  await ready(stack, deadline, () => supervisor.check());
  return stack;
}
export async function cleanStack(stack, supervisor, keep = false, beforeRemove = async () => {}) {
  if (!stack) return;
  if (stack.created && !keep) {
    await supervisor.stop();
    await beforeRemove();
    const errors = [];
    try {
      const ids = command(
        "docker",
        ["ps", "-aq", "--filter", `ancestor=${stack.runnerImage}`],
        stack.root
      )
        .split("\n")
        .filter(Boolean);
      if (ids.length) command("docker", ["rm", "-f", ...ids], stack.root);
    } catch {
      errors.push("sandbox containers");
    }
    for (const resource of stack.resources.slice().reverse()) {
      try {
        if (resource === "container")
          command("docker", ["rm", "-f", "-v", stack.container], stack.root);
        if (resource === "image") command("docker", ["image", "rm", stack.runnerImage], stack.root);
      } catch {
        errors.push(resource);
      }
    }
    await rm(stack.privateDir, { recursive: true, force: true });
    if (errors.length) throw new Error("Owned resource cleanup incomplete");
  } else if (stack.created && keep) supervisor.release();
  if (stack.created)
    await rm(resolve(stack.root, "clients/demo/dist/agent-stories-seed.mjs"), { force: true });
  if (stack.sql) await stack.sql.end({ timeout: 5 });
  if (stack.lock) {
    await stack.lock.close();
    await rm(resolve(stack.folder, "reuse.lock"), { force: true });
  }
}
