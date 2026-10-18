import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const mutations = [
  {
    label: "answered-confirmation guard",
    file: "packages/data-stores/src/knowledge/builtin/source-supersession.ts",
    before: '  else if (request?.status !== "superseded") return undefined;',
    after: "",
    test: "tests/knowledge-source-confirmation.test.ts",
    pattern: "an approved confirmation is never replaced"
  },
  {
    label: "person-only rule",
    file: "packages/data-stores/src/knowledge/source-operations.ts",
    before: `parsed.mode === "full" &&
              !isAuthenticatedServicePrincipal(context.actor) &&
              (context.origin.kind === "user" ||
                (context.origin.kind === "cli" && !context.origin.unattended))`,
    after: "true",
    test: "tests/knowledge-source-confirmation.test.ts",
    pattern: "full.*from.*workflow.*joins"
  },
  {
    label: "upgrade null-key trust",
    file: "packages/data-stores/src/knowledge/builtin/source-search-visibility.ts",
    before: "? changed.has(row.source_id)",
    after: "? true",
    test: "tests/knowledge-source-upgrade.test.ts",
    pattern: "search still finds pre-upgrade synced documents"
  }
];
for (const [index, mutation] of mutations.entries()) {
  const original = readFileSync(mutation.file, "utf8");
  assert.equal(original.split(mutation.before).length, 2, mutation.label);
  try {
    writeFileSync(mutation.file, original.replace(mutation.before, mutation.after));
    const output = `/tmp/src3b-mutation-${index}.json`;
    const result = spawnSync("pnpm", ["exec", "vitest", "run", mutation.test, "-t", mutation.pattern,
      "--reporter=default", "--reporter=json", `--outputFile=${output}`], { stdio: "inherit" });
    assert.equal(result.status, 1, `${mutation.label} must fail`);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.numFailedTests, 1, `${mutation.label}: exactly the regression must fail`);
    const failed = report.testResults.flatMap((suite) => suite.assertionResults).filter((test) => test.status === "failed");
    assert.equal(failed.length, 1);
    assert.ok(failed[0].failureMessages.some((message) => message.includes("AssertionError")), "test must reach its assertion");
    console.log(`MUTATION KILLED: ${mutation.label}: ${failed[0].fullName}`);
  } finally {
    writeFileSync(mutation.file, original);
  }
}
