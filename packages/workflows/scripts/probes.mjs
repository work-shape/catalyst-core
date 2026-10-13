#!/usr/bin/env node
// The probes of the Workflow engine, which the suite does not run: a worker process that is
// killed in the middle of a run, and a loop over 10,000 items (tests/probes). They need the
// test Postgres of the suite in POSTGRES_STORE_TEST_DATABASE_URL. Arguments go to Vitest, so
// one probe is run by its file name. WORKFLOW_PROBE_REAL_TIME=1 lets the kill probe wait out
// the lease of a killed step and the wait for a changing call, ten minutes each, instead of
// moving the two times in the database. WORKFLOW_PROBE_BUILT=1 runs the loop on a server from
// the built packages (`pnpm build` first), which says what memory it holds as the loop goes;
// WORKFLOW_PROBE_NODE_ARGS names arguments of Node for it, such as --max-old-space-size=256.
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// Where a probe keeps what it measured (tests/probes/support/workflow-probe-world.ts).
const records = join(tmpdir(), "catalyst-workflow-probes");
const recorded = () => readdirSync(records).filter((file) => file.endsWith("-probe.json"));

mkdirSync(records, { recursive: true });
for (const name of recorded()) rmSync(join(records, name));

const result = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "--config", "vitest.probes.config.ts", ...process.argv.slice(2)],
  { cwd: root, stdio: "inherit" }
);

// After the lines of the processes the probes started.
for (const name of recorded()) {
  console.log(`\n${join(records, name)}\n${readFileSync(join(records, name), "utf8")}`);
}
process.exit(result.status ?? 1);
