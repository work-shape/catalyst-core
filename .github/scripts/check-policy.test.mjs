import { parse } from "yaml";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../workflows/check.yml", import.meta.url), "utf8");
const jobs = parse(workflow).jobs;

test("hosted Check triggers only on release pushes or a release dispatch", () => {
  const triggers = workflow.match(/^on:\n([\s\S]*?)^permissions:/mu)?.[1];
  assert.equal(triggers, '  workflow_dispatch:\n  push:\n    branches: ["release/**"]\n');
  assert.doesNotMatch(workflow, /github\.event\.label/u);
});

test("the first job rejects disallowed dispatches without a checkout within one minute", () => {
  assert.match(workflow, /^jobs:\n  policy:\n/mu);
  const [firstStep, ...rest] = jobs.policy.steps;
  assert.deepEqual(rest, []);
  assert.equal(firstStep.name, "Enforce hosted Check policy");
  assert.equal(firstStep.if, "github.event_name == 'workflow_dispatch'");
  assert.equal(firstStep["timeout-minutes"], 1);
  const script = firstStep.run;
  for (const [ref, allowed] of [
    ["refs/heads/release/0.8.0", true],
    ["refs/heads/release/0.8.0/rc.1", true],
    ["refs/tags/v0.8.0", false],
    ["refs/tags/v0.8.0-rc.1", false],
    ["refs/heads/main", false],
    ["refs/heads/feature/example", false],
    ["refs/heads/release-candidate", false],
    ["refs/heads/v0.8.0", false],
    ["refs/tags/release/0.8.0", false],
    ["refs/tags/0.8.0", false],
    ["refs/pull/42/merge", false]
  ]) {
    const result = spawnSync("bash", ["-e", "-c", script], {
      env: { ...process.env, GITHUB_REF: ref },
      encoding: "utf8",
      timeout: 1000
    });
    assert.ifError(result.error);
    assert.equal(result.status, allowed ? 0 : 1, ref);
    if (!allowed) {
      assert.match(result.stdout, /::error::Hosted Check runs for releases only/u);
      assert.ok(result.stdout.includes(ref));
    }
  }
});

// These concurrency expressions use the JS-compatible subset of Actions expressions.
function concurrency(event, ref, runId = 1, attempt = 1) {
  const context = {
    github: { workflow: "Check", event_name: event, ref, run_id: runId, run_attempt: attempt },
    startsWith: (value, prefix) => value.toLowerCase().startsWith(prefix.toLowerCase()),
    format: (template, ...args) => template.replace(/\{(\d+)\}/gu, (_, i) => args[i])
  };
  const group = workflow.match(/^  group: (.+)$/mu)[1];
  const cancel = workflow.match(/^  cancel-in-progress: \$\{\{ (.+) \}\}$/mu)[1];
  return {
    group: group.replace(/\$\{\{ (.+?) \}\}/gu, (_, expression) =>
      runInNewContext(expression, context)
    ),
    cancel: runInNewContext(cancel, context)
  };
}

test("only dispatches on the same release branch cancel each other", () => {
  const ref = "refs/heads/release/0.8.0";
  const first = concurrency("workflow_dispatch", ref);
  assert.equal(first.cancel, true);
  assert.equal(first.group, concurrency("workflow_dispatch", ref, 2).group);
  assert.notEqual(first.group, concurrency("workflow_dispatch", `${ref}-rc.1`).group);
  assert.notEqual(first.group, concurrency("push", ref).group);

  for (const [event, runRef] of [
    ["push", ref],
    ["workflow_dispatch", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/feature/example"]
  ]) {
    const run = concurrency(event, runRef);
    assert.equal(run.cancel, false, `${event} ${runRef}`);
    assert.notEqual(run.group, concurrency(event, runRef, 2).group);
    assert.notEqual(run.group, concurrency(event, runRef, 1, 2).group);
  }
});

test("browser Check runs six shards with matching labels and command", () => {
  const browser = jobs["browser-shard"];
  assert.deepEqual(browser.strategy.matrix.shard, [1, 2, 3, 4, 5, 6]);
  assert.equal(browser.name, "browser ${{ matrix.shard }}/6");
  const suite = browser.steps.find((step) => step.name === "Browser suite");
  assert.ok(suite.run.includes('--shard="$SHARD/6"'));
  assert.ok(suite.run.includes("--retries=1"));
});

test("browser Check uses the locked Playwright image and the pinned Postgres service", () => {
  const browser = jobs["browser-shard"];
  const lock = parse(readFileSync(new URL("../../pnpm-lock.yaml", import.meta.url), "utf8"));
  const version = lock.importers["."].devDependencies["@playwright/test"].version;
  assert.equal(browser.container, `mcr.microsoft.com/playwright:v${version}-noble`);
  assert.doesNotMatch(
    JSON.stringify(browser.steps),
    /playwright install|start-postgres|docker login/u
  );
  const pinned = readFileSync(
    new URL("../../docker/postgres/pinned-image", import.meta.url),
    "utf8"
  )
    .split("\n")
    .find((line) => line.startsWith("ghcr.io/"));
  const postgres = browser.services.postgres;
  assert.equal(postgres.image, pinned);
  assert.deepEqual(postgres.credentials, {
    username: "${{ github.actor }}",
    password: "${{ github.token }}"
  });
  assert.deepEqual(postgres.env, {
    POSTGRES_USER: "agent_chat",
    POSTGRES_PASSWORD: "agent_chat",
    POSTGRES_DB: "agent_chat"
  });
  assert.ok(postgres.options.includes("pg_isready --host 127.0.0.1"));
  const suite = browser.steps.find((step) => step.name === "Browser suite");
  assert.equal(suite.env.E2E_EXTERNAL_POSTGRES, "1");
  assert.equal(
    suite.env.E2E_DATABASE_URL,
    "postgres://agent_chat:agent_chat@postgres:5432/agent_chat"
  );
});

test("release Check leaves scale tests to the nightly runner", () => {
  assert.equal(jobs.tests.env.CATALYST_SCALE_TESTS, "0");
});

test("shared builds transfer across host and Playwright containers without zstd", () => {
  const saved = jobs.build.steps.find((step) => step.name === "Save this run's build");
  assert.ok(saved.uses.startsWith("actions/upload-artifact@"));
  assert.equal(saved.with.path, "/tmp/check-build.tgz");
  assert.equal(saved.with["if-no-files-found"], "error");
  assert.equal(saved.with["compression-level"], 0);
  assert.equal(saved.with.overwrite, true);
  const setup = parse(
    readFileSync(new URL("../actions/setup-check/action.yml", import.meta.url), "utf8")
  );
  const download = setup.runs.steps.find((step) =>
    step.uses?.startsWith("actions/download-artifact@")
  );
  assert.equal(saved.with.name, "check-build-${{ github.run_id }}-${{ github.sha }}");
  assert.equal(download.with.name, saved.with.name);
  assert.equal(download.with.path, "/tmp");
  assert.equal(download.if, "inputs.build == 'true'");
  assert.ok(!setup.runs.steps.some((step) => step.uses?.startsWith("actions/cache/restore@")));
  const policy = jobs.changes.steps.find((step) => step.name === "Check workflow policy");
  assert.equal(policy.run, "node --test .github/scripts/check-policy.test.mjs");
});

test("every job runs on every release run, after the dispatch policy", () => {
  for (const [name, job] of Object.entries(jobs)) {
    if (name === "policy") continue;
    assert.ok(job.needs, `${name} needs another job`);
    if (name !== "browser" && name !== "check") assert.equal(job.if, undefined, name);
  }
  assert.deepEqual(
    [...jobs.check.needs].sort(),
    Object.keys(jobs)
      .filter((name) => name !== "check" && name !== "browser")
      .sort()
  );
});
