import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../workflows/check.yml", import.meta.url), "utf8");

test("hosted Check triggers only nightly and on release pushes or manual dispatch", () => {
  const triggers = workflow.match(/^on:\n([\s\S]*?)^permissions:/mu)?.[1];
  assert.equal(
    triggers,
    '  workflow_dispatch:\n  schedule:\n    - cron: "17 3 * * *"\n  push:\n    branches: ["release/**"]\n    tags: ["v*"]\n'
  );
  assert.doesNotMatch(workflow, /github\.event\.label/u);
});

test("the first job rejects disallowed dispatches before checkout within one minute", () => {
  assert.match(workflow, /^jobs:\n  paths:\n/mu);
  const firstStep = workflow.match(/    steps:\n([\s\S]*?)      - uses:/u)?.[1];
  assert.match(firstStep, /^      - name: Enforce hosted Check policy\n/u);
  assert.match(firstStep, /^        if: github.event_name == 'workflow_dispatch'$/mu);
  assert.match(firstStep, /^        timeout-minutes: 1$/mu);
  const script = firstStep.split("        run: |\n")[1].replace(/^ {10}/gmu, "");
  for (const [ref, allowed] of [
    ["refs/heads/release/0.8.0", true],
    ["refs/heads/release/0.8.0/rc.1", true],
    ["refs/tags/v0.8.0", true],
    ["refs/tags/v0.8.0-rc.1", true],
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
      assert.match(result.stdout, /::error::Hosted Check runs nightly and for releases only/u);
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
    ["push", "refs/tags/v0.8.0"],
    ["schedule", "refs/heads/main"],
    ["workflow_dispatch", "refs/tags/v0.8.0"],
    ["workflow_dispatch", "refs/heads/main"],
    ["workflow_dispatch", "refs/heads/feature/example"]
  ]) {
    const run = concurrency(event, runRef);
    assert.equal(run.cancel, false, `${event} ${runRef}`);
    assert.notEqual(run.group, concurrency(event, runRef, 2).group);
    assert.notEqual(run.group, concurrency(event, runRef, 1, 2).group);
  }
});
