import { UsageWatchdog } from "./watchdog.mjs";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { plan, exitCode } from "./catalog.mjs";
import { Processes } from "./processes.mjs";
import { coldStack, reuseStack, cleanStack, receipt, minimalEnv } from "./stack.mjs";
import { usageTotal, LIMITS, evidence } from "./safety.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const selection = plan(process.argv.slice(2));
const startedAt = new Date().toISOString(),
  started = Date.now(),
  deadline = started + LIMITS.totalMs;
const folder = resolve(
  root,
  "../tmp/agent-stories",
  `${startedAt.replaceAll(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`
);
await mkdir(folder, { recursive: true, mode: 0o700 });
await mkdir(resolve(folder, ".private"), { mode: 0o700 });
const supervisor = new Processes(root, minimalEnv());
let stack,
  stopped,
  watcher,
  baseline = [],
  usage = usageTotal([]),
  peak = { tokens: 0, micros: 0 },
  usageEvents = [],
  inheritedMicros = 0,
  cleaning = false;
const results = [];
const accounting = new UsageWatchdog({ deadline, cancel: stop, limits: LIMITS });
async function write(name, value) {
  await writeFile(
    resolve(folder, name),
    JSON.stringify(
      evidence(value, stack ? [...Object.values(stack.secrets), stack.env.OPENAI_API_KEY] : []),
      null,
      2
    ) + "\n",
    { mode: 0o600 }
  );
}
async function stop(reason) {
  if (stopped) return;
  stopped = reason;
  supervisor.stopping = true;
  await writeFile(resolve(folder, "STOP"), reason, { mode: 0o600 });
  // The browser's ephemeral actor file enables cancellation as the actor, never as setup.
  const owned = supervisor.stack;
  if (owned) {
    const actor = await readFile(resolve(folder, ".private/actor.json"), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    if (actor) {
      const response = await fetch(`${owned.api}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { Origin: owned.ui, "content-type": "application/json" },
        body: JSON.stringify({ email: actor.email, password: actor.password }),
        signal: AbortSignal.timeout(5_000)
      }).catch(() => null);
      const cookie = response?.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
      if (cookie) {
        const runs =
          await owned.sql`select id,conversation_id from agent_runs where owner_user_id=${actor.id} and status not in ('completed','failed','cancelled')`;
        for (const run of runs)
          await fetch(
            `${owned.api}/api/v1/conversations/${run.conversation_id}/runs/${run.id}/cancel`,
            {
              method: "POST",
              headers: { Origin: owned.ui, cookie, "content-type": "application/json" },
              body: "{}",
              signal: AbortSignal.timeout(5_000)
            }
          ).catch(() => {});
        const workflows =
          await owned.sql`select id from workflow_runs where started_by->>'id'=${actor.id} and status in ('queued','running','waiting')`;
        for (const workflow of workflows)
          await fetch(`${owned.api}/api/v1/workflow-runs/${workflow.id}/cancel`, {
            method: "POST",
            headers: { Origin: owned.ui, cookie, "content-type": "application/json" },
            body: "{}",
            signal: AbortSignal.timeout(5000)
          }).catch(() => {});
      }
    }
  }
  await supervisor.stop();
}
async function measure() {
  const owned = supervisor.stack;
  if (!owned?.sql) return;
  const rows =
    await owned.sql`select id,status,agent_run_id,provider_id,model,purpose,total_tokens,counted_tokens,counted_cost_micros,customer_billable_cost from model_usage_events`;
  usage = await accounting.sample(rows);
  usageEvents = rows
    .filter((row) => !accounting.baseline.has(row.id))
    .map((row) => ({
      id: row.id,
      runId: row.agent_run_id,
      provider: row.provider_id,
      model: row.model,
      purpose: row.purpose,
      status: row.status,
      tokens: Number(row.counted_tokens ?? row.total_tokens),
      micros: row.counted_cost_micros == null ? null : Number(row.counted_cost_micros)
    }));
  peak = accounting.peak;
}
// Single serial watchdog; invocation totals never reset on UTC day/month changes.
async function watch() {
  if (cleaning || stopped) return;
  try {
    if (supervisor.failure) {
      await stop("child_failure");
      return;
    }
    await measure();
  } catch {
    await stop("usage_accounting_unavailable");
  }
  if (!cleaning && !stopped) watcher = setTimeout(watch, 500);
}
supervisor.onDatabase = async (owned) => {
  if (!owned.created) {
    baseline = (await owned.sql`select id from model_usage_events`).map((r) => r.id);
    const counters =
      await owned.sql`select cost_micros from model_usage_counters where scope_kind='instance' and ((period_kind='day' and period_start=(now() at time zone 'UTC')::date) or (period_kind='month' and period_start=date_trunc('month',now() at time zone 'UTC')::date))`;
    inheritedMicros = Math.max(0, ...counters.map((r) => Number(r.cost_micros)));
  }
  accounting.baseline = new Set(baseline);
  accounting.inheritedMicros = inheritedMicros;
  await watch();
};
const totalTimer = setTimeout(() => void stop("deadline"), LIMITS.totalMs);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void stop(sig));
try {
  const startupTimer = setTimeout(() => void stop("startup_deadline"), LIMITS.startupMs);
  try {
    stack = selection.reuse
      ? await reuseStack(root, selection.reuse, supervisor, started + LIMITS.startupMs)
      : await coldStack(root, folder, supervisor, started + LIMITS.startupMs);
  } finally {
    clearTimeout(startupTimer);
  }
  if (stopped) throw new Error("Invocation stopped during startup");
  const manifest = {
    id: folder.split("/").at(-1),
    startedAt,
    ...stack.fingerprint,
    model: stack.model,
    stories: selection.stories,
    coverage: selection.coverage,
    cases: selection.cases.map((c) => c.id),
    seed: { hash: stack.seedHash, seededIds: stack.seededIds },
    differences: [
      "owned ports/object stores/database/config/auth",
      "capture-only synthetic sample endpoint",
      "daily/monthly spend capped at EUR 10"
    ],
    budget: LIMITS,
    baseline: { calls: baseline.length, micros: inheritedMicros },
    prerequisites: selection.cases.map((c) => c.prerequisite)
  };
  await write("manifest.json", manifest);
  // A private adapter file is consumed by Playwright; receipts never contain credentials.
  const adapter = {
    api: stack.api,
    ui: stack.ui,
    privateDir: stack.privateDir,
    seededIds: stack.seededIds
  };
  const adapterPath = resolve(folder, "browser.json");
  await writeFile(adapterPath, JSON.stringify(adapter), { mode: 0o600 });
  await supervisor.run(
    resolve(root, "node_modules/.bin/playwright"),
    [
      "test",
      "--config",
      "agent-stories/playwright.config.mjs",
      "--grep",
      `(${selection.cases.map((c) => c.id).join("|")})$`
    ],
    "three story cases",
    {
      ...minimalEnv(),
      AGENT_STORIES_OUTPUT: folder,
      AGENT_STORIES_STACK: adapterPath,
      AGENT_STORIES_UI: stack.ui,
      AGENT_STORIES_SAMPLE_PORT: String(stack.ports.sample),
      AGENT_STORIES_CASES: selection.cases.map((c) => c.id).join(","),
      AGENT_STORIES_ACTOR_FILE: resolve(folder, ".private/actor.json")
    }
  );
} catch (error) {
  const reason =
    stopped ??
    (error.message.startsWith("three story cases:") ? "case_failure" : "tooling_or_prerequisite");
  await write("failure.json", {
    code: reason,
    message: `Invocation ended during ${supervisor.phase ?? "stack setup"}; see prerequisite plan and per-case state observations`
  });
} finally {
  cleaning = true;
  clearTimeout(watcher);
  clearTimeout(totalTimer);
  stack ??= supervisor.stack;
  if (stack?.sql)
    await measure().catch(() => {
      stopped ??= "usage_accounting_unavailable";
    });
  for (const item of selection.cases) {
    const result = await readFile(resolve(folder, `${item.id}.json`), "utf8")
      .then(JSON.parse)
      .catch(() => null);
    results.push(
      result ?? {
        scenario: item.id,
        status: "blocked",
        code: stopped ?? "startup_or_fixture_failure"
      }
    );
  }
  let cleanup = "removed owned resources";
  const keep = Boolean(stack?.created && selection.keep && !stopped && stack.fingerprint);
  try {
    if (keep)
      await writeFile(resolve(stack.folder, "stack.json"), JSON.stringify(await receipt(stack)), {
        mode: 0o600
      });
    await cleanStack(stack, supervisor, keep, measure);
    if (!stack) await supervisor.stop();
    if (stack && !stack.created)
      cleanup = "reused services retained; fixture cleanup status is in case results";
    else if (keep)
      cleanup = "owned stack retained explicitly; private setup auth retained for reuse";
  } catch {
    stopped ??= "cleanup_failure";
    cleanup = "cleanup incomplete: inspect owned receipt";
    // A failed debug receipt must never strand the services whose credentials it lost.
    if (keep) {
      try {
        await cleanStack(stack, supervisor, false, measure);
        cleanup = "removed owned resources after debug retention failed";
      } catch {
        await supervisor.stop();
      }
    }
  }
  await rm(resolve(folder, ".private/actor.json"), { force: true });

  if (Date.now() >= deadline) stopped ??= "cleanup_deadline";
  const code = stopped ? 2 : exitCode(selection, results);
  const runLine = `${startedAt.slice(0, 10)} | ${folder.split("/").at(-1)} | automated trial | ${stack?.fingerprint?.head ?? "startup blocked"} | ${stack?.model?.model ?? "model unavailable"} | ${selection.stories.join(",")} (${results.map((r) => `${r.scenario}:${r.status}`).join(", ")}) | partial coverage; manual clauses retained | EUR ${(usage.micros / 1e6).toFixed(6)} including unsettled reserves; ${usage.tokens} tokens; ${Math.round((Date.now() - started) / 1000)}s | ${folder}/report.md`;
  const summary = {
    id: folder.split("/").at(-1),
    startedAt,
    endedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    results,
    coverage: selection.coverage,
    usage,
    usageEvents,
    peak,
    overshootTokens: Math.max(0, usage.tokens - LIMITS.tokens),
    overshootMicros: Math.max(0, usage.micros + inheritedMicros - LIMITS.micros),
    cleanup,
    exitCode: code,
    runLine
  };
  await write("summary.json", summary);
  await writeFile(
    resolve(folder, "report.md"),
    `# Agent stories: partial automation\n\n${results.map((r) => `- ${r.scenario}: ${r.status}`).join("\n")}\n\nUnautomated clauses:\n${selection.coverage.map((c) => `- ${c.id}: ${c.manual.join("; ")}`).join("\n")}\n\nUsage: ${usage.tokens} tokens / EUR ${(usage.micros / 1e6).toFixed(6)}, including unsettled reservations. Demo EUR accounting, not an invoice.\n\nCleanup: ${cleanup}. Exit ${code}.\n\nRuns line:\n\n${runLine}\n`,
    { mode: 0o600 }
  );
  console.log(`Agent stories report: ${folder}/report.md (exit ${code})`);
  process.exitCode = code;
}
