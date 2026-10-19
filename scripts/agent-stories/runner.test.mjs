import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import {
  bundleCommittedSeed,
  minimalEnv,
  isolatedSetupUser,
  storyModel,
  stageInstanceAssets
} from "./stack.mjs";
import { requireIdle } from "./idle.mjs";
import { UsageWatchdog } from "./watchdog.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { plan, exitCode } from "./catalog.mjs";
import {
  LIMITS,
  usageTotal,
  budgetStop,
  evidence,
  validateReceipt,
  parsePinnedImage
} from "./safety.mjs";
import { appOracle, workflowOracle, consentOracle, createdOracle } from "./oracles.mjs";
import { Processes } from "./processes.mjs";

test("selection is validated before effects; union is exactly three fresh cases", () => {
  const p = plan(["--stories", "S2,S5,S14,S2"]);
  assert.equal(p.cases.length, 3);
  assert.equal(new Set(p.cases.map((c) => c.id)).size, 3);
  for (const input of ["", ",", "S18", "S1,,S2", "tool:"])
    assert.throws(() => plan(["--stories", input]));
  assert.equal(plan(["--stories", "S1"]).cases.length, 0);
  const mixed = plan(["--stories", "S1,S2"]);
  assert.equal(mixed.cases.length, 1);
  assert.equal(exitCode(mixed, [{ status: "pass" }]), 2);
  assert.equal(
    exitCode(
      p,
      p.cases.map(() => ({ status: "pass" }))
    ),
    0
  );
  assert.equal(exitCode(p, [{ status: "fail" }]), 1);
  assert.ok(p.coverage.every((c) => c.manual.length > 0));
});
test("owner/code/build/config/migration/module/worker/entrypoint/ports drift refuses before caller mutation", () => {
  const receipt = {
    owner: "owned",
    uid: 1,
    host: "host",
    root: "/private",
    head: "sha",
    dirty: "sha",
    builds: "sha",
    capabilities: { head: "sha", dirty: "sha" },
    config: "sha",
    migrations: "sha",
    modules: "sha",
    workers: ["worker"],
    entrypoint: "normal server",
    image: "pinned",
    imageId: "sha",
    ports: { api: 30000 },
    status: "idle"
  };
  for (const key of Object.keys(receipt).filter((k) => k !== "status")) {
    let mutations = 0;
    assert.throws(() => {
      validateReceipt({ ...receipt, [key]: "changed" }, receipt);
      mutations++;
    });
    assert.equal(mutations, 0);
  }
  for (const changed of [{ status: "busy" }, { activeJobs: 1 }, { activeRuns: 1 }, { pending: 1 }])
    assert.throws(() => validateReceipt({ ...receipt, ...changed }, receipt));
  validateReceipt(receipt, receipt);
});
test("all-call accounting keeps unsettled reservation and immutable invocation totals over midnight", () => {
  const rows = [
    {
      status: "settled",
      total_tokens: 5,
      counted_tokens: 5,
      customer_billable_cost: { status: "settled", totalCostMicros: 20 }
    },
    { status: "pending", total_tokens: 0, counted_tokens: 200, counted_cost_micros: 300 },
    { status: "abandoned", total_tokens: 0, counted_tokens: 100, counted_cost_micros: 150 }
  ];
  const total = usageTotal(rows);
  assert.equal(total.tokens, 305);
  assert.equal(total.micros, 470);
  assert.equal(total.pending, 2);
  assert.equal(budgetStop(total, 10, 10), "deadline");
  assert.equal(budgetStop(total, 0, 10, 0, { tokens: 300, micros: 1000 }), "tokens");
  assert.equal(budgetStop(total, 0, 10, 600, { tokens: 1000, micros: 1000 }), "spend");
  assert.equal(budgetStop({ ...total, missingCosts: true }, 0, 10), "missing_cost");
  assert.equal(usageTotal([{ status: "settled", total_tokens: 2 }]).missingCosts, true);
  assert.equal(usageTotal([{ status: "pending", total_tokens: 0 }]).missingCosts, true);
  assert.equal(budgetStop({ ...total, tokens: LIMITS.tokens }, 0, 10), "tokens");
});
test("allowlist drops auth and raw events and removes a canary even from allowed text", () => {
  const secret = "synthetic-CANARY-credential-4938";
  const encoded = JSON.stringify(
    evidence(
      {
        id: "safe",
        headers: { cookie: secret },
        env: { key: secret },
        rawSSE: secret,
        config: { password: secret },
        prompt: `synthetic ${secret}`,
        message: secret,
        tokens: 3
      },
      [secret]
    )
  );
  assert.ok(!encoded.includes(secret));
  assert.ok(!encoded.includes("headers"));
  assert.ok(!encoded.includes("password"));
  assert.equal(JSON.parse(encoded).tokens, 3);
});
test("supervisor removes its own child on failure", async () => {
  const p = new Processes(process.cwd());
  const held = p.start(process.execPath, ["-e", "setInterval(()=>{},1000)"], "held");
  await assert.rejects(() => p.run(process.execPath, ["-e", "process.exit(9)"], "failed"));
  await p.stop();
  assert.throws(() => process.kill(held.child.pid, 0));
});
test("SIGTERM cleanup drains owned child without touching a neighbouring process", async () => {
  const folder = await mkdtemp(resolve(tmpdir(), "agent-stories-process-"));
  const probe = resolve(folder, "probe.mjs");
  const pidFile = resolve(folder, "pid");
  const moduleUrl = new URL("./processes.mjs", import.meta.url).href;
  await writeFile(
    probe,
    `import {Processes} from ${JSON.stringify(moduleUrl)};import {writeFileSync} from 'node:fs';const p=new Processes(process.cwd());const h=p.start(process.execPath,['-e','setInterval(()=>{},1000)'],'held');writeFileSync(${JSON.stringify(pidFile)},String(h.child.pid));process.on('SIGTERM',()=>{void p.stop().then(()=>process.exit(143));});`
  );
  const neighbour = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    stdio: "ignore"
  });
  const child = spawn(process.execPath, [probe], { stdio: "ignore" });
  try {
    let pid;
    while (!pid) {
      pid = await readFile(pidFile, "utf8").catch(() => null);
      if (!pid) await new Promise((r) => setTimeout(r, 10));
    }
    const done = once(child, "exit");
    child.kill("SIGTERM");
    await done;
    assert.throws(() => process.kill(Number(pid), 0));
    process.kill(neighbour.pid, 0);
  } finally {
    child.kill();
    neighbour.kill();
    await rm(folder, { recursive: true, force: true });
  }
});
const app = {
  invalidRows: 0,
  validRows: 1,
  reloadedRows: 1,
  freshRows: 1,
  otherRows: 0,
  storageCommitted: true,
  errors: 0
};
const workflow = {
  status: "done",
  mode: "test",
  revision: "r",
  expectedRevision: "r",
  tester: "u",
  expectedTester: "u",
  total: 42,
  notify: [{ status: "done", target: "dry_run", operation: "notify" }],
  deliveries: 0,
  published: false,
  liveRuns: 0
};
const consent = {
  beforeAssets: 0,
  beforeRevisions: 0,
  beforeFiles: 0,
  reconnectAssets: 0,
  reconnectRevisions: 0,
  reconnectFiles: 0,
  deniedAssets: 0,
  deniedRevisions: 0,
  deniedFiles: 0,
  pendingStatus: "pending_confirmation",
  deniedStatus: "denied",
  allowedAssets: 1,
  allowedRevisions: 1,
  allowedExecutions: 1,
  replayRevisions: 1,
  replayExecutions: 1,
  instructionMatches: true,
  ownerMatches: true
};
test("App oracle consumes broken form/persistence/privacy observations as failures", () => {
  appOracle(app);
  for (const broken of [
    { invalidRows: 1 },
    { validRows: 0 },
    { reloadedRows: 0 },
    { freshRows: 0 },
    { otherRows: 1 },
    { errors: 1 },
    { storageCommitted: false }
  ])
    assert.throws(() => appOracle({ ...app, ...broken }));
});
test("Workflow oracle consumes delivery, missing notify and nonexistent principal failures", () => {
  workflowOracle(workflow);
  for (const broken of [
    { deliveries: 1 },
    { notify: [] },
    { status: "failed" },
    { mode: "live" },
    { total: 0 },
    { notify: [{ status: "done", target: "live", operation: "notify" }] }
  ])
    assert.throws(() => workflowOracle({ ...workflow, ...broken }));
});
test("consent oracle consumes bypass and duplicate-execution observations as failures", () => {
  consentOracle(consent);
  for (const broken of [
    { beforeAssets: 1 },
    { beforeFiles: 1 },
    { reconnectRevisions: 1 },
    { deniedAssets: 1 },
    { allowedRevisions: 2 },
    { replayExecutions: 2 },
    { replayRevisions: 2 }
  ])
    assert.throws(() => consentOracle({ ...consent, ...broken }));
});
test("seeded asset and wrong actor/run cannot masquerade as generated work", () => {
  const row = {
    id: "asset",
    kind: "app",
    actorId: "user",
    conversationId: "conversation",
    runId: "run",
    createdAt: "2026-10-19T12:00:01Z"
  };
  const expected = {
    actorId: "user",
    conversationId: "conversation",
    runId: "run",
    startedAt: "2026-10-19T12:00:00Z",
    seededIds: [],
    kind: "app"
  };
  createdOracle(row, expected);
  for (const change of [
    { actorId: "setup" },
    { runId: "old" },
    { createdAt: "2020-01-01T00:00:00Z" }
  ])
    assert.throws(() => createdOracle({ ...row, ...change }, expected));
  assert.throws(() => createdOracle(row, { ...expected, seededIds: ["asset"] }));
});

test("deadline/token/spend stops cancel exactly once and retain unsettled usage", async () => {
  for (const [kind, now, row] of [
    ["deadline", 10, { tokens: 1, micros: 1 }],
    ["tokens", 0, { tokens: 300, micros: 1 }],
    ["spend", 0, { tokens: 1, micros: 500 }]
  ]) {
    const cancellations = [];
    const w = new UsageWatchdog({
      deadline: 10,
      limits: { tokens: 300, micros: 500 },
      cancel: async (reason) => {
        cancellations.push(reason);
      }
    });
    const rows = [
      {
        id: "new",
        status: "pending",
        total_tokens: 0,
        counted_tokens: row.tokens,
        counted_cost_micros: row.micros
      }
    ];
    await w.sample(rows, now);
    await w.sample(rows, now + 1);
    assert.deepEqual(cancellations, [kind]);
    assert.equal(w.usage.reservedTokens, row.tokens);
    assert.equal(w.usage.reservedMicros, row.micros);
  }
});

test("ordinary Playwright discovery stays isolated even with a key", async () => {
  const child = spawn(
    resolve("node_modules/.bin/playwright"),
    ["test", "--list", "e2e/app-sandbox.spec.ts"],
    {
      env: { ...process.env, OPENAI_API_KEY: "synthetic-canary-never-call" },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  child.stdout.on("data", (c) => {
    output += c;
  });
  child.stderr.on("data", (c) => {
    output += c;
  });
  const [code] = await once(child, "exit");
  assert.equal(code, 0, output);
  assert.ok(!output.includes(".story.mjs"));
  assert.ok(!output.includes("live-skill-consent"));
  assert.match(output, /app-sandbox.spec.ts/u);
});

test("warm reuse permits a future passive tick but refuses future model jobs and unknown work", () => {
  const job = {
    kind: "usage.reconcile",
    status: "queued",
    dedupe_key: "schedule:usage.reconcile",
    run_after: "2026-12-01T00:00:00Z"
  };
  for (const kind of [
    "usage.reconcile",
    "agent_run.adopt",
    "workspace_command.adopt_legacy",
    "workspace_command.clean_temp_state",
    "connection_bindings.keep_alive",
    "notice.deliver_mail",
    "data_store.measure_size_tick",
    "data_store.upgrade_owned_tick"
  ])
    requireIdle(
      { runs: 0, pending: 0, jobs: [{ ...job, kind, dedupe_key: `schedule:${kind}` }] },
      0
    );
  for (const change of [
    { kind: "conversation.generate_title" },
    { kind: "agent_run.execute" },
    { kind: "unknown" },
    { status: "running" },
    { run_after: "1970-01-01T00:00:00Z" }
  ]) {
    const candidate = { ...job, ...change };
    if (change.kind) candidate.dedupe_key = `schedule:${change.kind}`;
    assert.throws(() => requireIdle({ runs: 0, pending: 0, jobs: [candidate] }, 0));
  }
  assert.throws(() => requireIdle({ runs: 1, pending: 0, jobs: [] }, 0));
  assert.throws(() => requireIdle({ runs: 0, pending: 1, jobs: [] }, 0));
});

test("the commented Postgres pin becomes exactly one Docker digest, and malformed pins refuse", async () => {
  const source = await readFile(
    new URL("../../docker/postgres/pinned-image", import.meta.url),
    "utf8"
  );
  const image = source.split("\n").find((line) => line.startsWith("ghcr.io/"));
  assert.equal(parsePinnedImage(source), image);
  for (const invalid of [
    "",
    "# no image",
    "postgres:17",
    source + "\nother:tag",
    "image@sha256:short"
  ])
    assert.throws(() => parsePinnedImage(invalid));
});

// A loader failure happens before the adapter's catch or any network request.
test("the committed seed adapter loads its dependencies before stack or model access", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = resolve(root, "clients/demo/dist/agent-stories-seed.mjs");
  await mkdir(resolve(root, "clients/demo/dist"), { recursive: true });
  try {
    await bundleCommittedSeed(root, new Processes(root, minimalEnv()));
    const result = spawnSync(process.execPath, [output], { env: minimalEnv(), encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Expected six owned-stack seed arguments/u);
    assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND/u);
  } finally {
    await rm(output, { force: true });
  }
});

test("owned setup keeps the shipped superadmin tool references needed to seed ordinary people", async () => {
  const config = parse(
    await readFile(new URL("../../clients/demo/config/app.yaml", import.meta.url), "utf8")
  );
  const shipped = config.auth.standalone.seedUsers.find((user) =>
    user.roles.includes("superadmin")
  );
  const owned = isolatedSetupUser(config.auth.standalone.seedUsers);
  assert.deepEqual(owned.roles, shipped.roles);
  assert.deepEqual(owned.permissionRefs, shipped.permissionRefs);
  assert.equal(owned.passwordEnvName, "STORY_SETUP_PASSWORD");
  assert.ok(owned.developmentPassword === undefined);
  assert.ok(owned.emailEnvName === undefined);
  assert.throws(() => isolatedSetupUser([]));
});

test("Playwright cleanup cannot erase its sibling stack credentials, manifest or ownership receipt", async () => {
  const folder = await mkdtemp(resolve(tmpdir(), "story-output-"));
  try {
    const program = `const config = (await import('./agent-stories/playwright.config.mjs')).default; process.stdout.write(config.outputDir);`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      env: { ...minimalEnv(), AGENT_STORIES_OUTPUT: folder },
      encoding: "utf8"
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, resolve(folder, "playwright"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("warm baseline retains inherited spend without rebilling old calls when readiness refuses", async () => {
  const cancelled = [];
  const watcher = new UsageWatchdog({
    deadline: 10,
    limits: { tokens: 1000, micros: 50 },
    cancel: async (reason) => cancelled.push(reason)
  });
  watcher.baseline = new Set(["earlier"]);
  watcher.inheritedMicros = 50;
  const usage = await watcher.sample(
    [
      {
        id: "earlier",
        status: "settled",
        total_tokens: 99,
        customer_billable_cost: { status: "settled", totalCostMicros: 50 }
      }
    ],
    0
  );
  assert.equal(usage.tokens, 0);
  assert.equal(usage.micros, 0);
  assert.deepEqual(cancelled, ["spend"]);
});

test("story agents default to Luna at xhigh; a rerun can choose another binding and effort", () => {
  assert.deepEqual(plan(["--stories", "S2"]).model, {
    bindingId: "gpt56Luna",
    reasoningEffort: "xhigh"
  });
  assert.deepEqual(plan(["--stories", "S2", "--model", "primary", "--reasoning", "high"]).model, {
    bindingId: "primary",
    reasoningEffort: "high"
  });
  for (const args of [
    ["--model"],
    ["--model", ""],
    ["--reasoning", "extreme"],
    ["--reuse", "/x/stack.json", "--model", "primary"],
    ["--reuse", "/x/stack.json", "--reasoning", "low"]
  ])
    assert.throws(() => plan(["--stories", "S2", ...args]));
  assert.equal(plan(["--stories", "S2", "--reuse", "/x/stack.json"]).model, undefined);
});

test("the owned config copy runs every primary agent on the chosen model; the demo's own stays", async () => {
  const source = await readFile(
    new URL("../../clients/demo/config/app.yaml", import.meta.url),
    "utf8"
  );
  const config = parse(source);
  assert.deepEqual(storyModel(config, plan(["--stories", "S2"]).model), {
    provider: "openai-compatible",
    model: "gpt-5.6-luna",
    reasoningEffort: "xhigh",
    bindingId: "gpt56Luna"
  });
  const primary = config.modelBindings.find((b) => b.id === "primary");
  assert.equal(primary.model, "gpt-5.6-luna");
  assert.equal(primary.reasoningEffort, "xhigh");
  assert.equal(
    storyModel(parse(source), { bindingId: "primary", reasoningEffort: "high" }).model,
    "gpt-5.5"
  );
  for (const bindingId of ["missing", "guardrailCheck"])
    assert.throws(() => storyModel(parse(source), { bindingId, reasoningEffort: "xhigh" }));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const dir = await mkdtemp(resolve(tmpdir(), "story-assets-"));
  try {
    await stageInstanceAssets(root, dir, "xhigh");
    const agent = parse(
      await readFile(resolve(dir, "agents/workflow-assistant.agent.yaml"), "utf8")
    );
    assert.equal(agent.modelBindingId, "primary");
    assert.equal(agent.reasoningEffort, "xhigh");
    const shipped = parse(
      await readFile(resolve(root, "clients/demo/agents/workflow-assistant.agent.yaml"), "utf8")
    );
    assert.equal(shipped.reasoningEffort, "high");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
