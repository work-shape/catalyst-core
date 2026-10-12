import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { waitUntil } from "./support/assertions";
import { databaseUrlFor } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { killTestProcess, startTestProcess } from "./support/test-process";

// Bounds on a hang, never pauses. The process is started through the TypeScript loader, which
// takes most of the first one on a loaded machine.
const STARTED_WITHIN_MS = 90_000;
const RECONNECTED_WITHIN_MS = 60_000;

describe("an idle job worker in a process of its own", () => {
  const db = usePostgresSuite("idle_worker");
  const processes: ChildProcess[] = [];

  afterEach(async () => {
    for (const child of processes.splice(0)) await killTestProcess(child);
  });

  // Fails without the change: the sleep between two passes did not hold the process, so the
  // process ended with code 13 at the moment the driver closed its last connection.
  it(
    "stays up when the lifetime of its database connection ends",
    async () => {
      const applicationName = `${db.first}_process`;
      const url = new URL(databaseUrlFor(db.databaseUrl, applicationName));
      // Seconds. The driver's own choice is 30 to 60 minutes.
      url.searchParams.set("max_lifetime", "4");
      const child = startTestProcess(
        new URL("./support/idle-job-worker-process.ts", import.meta.url),
        {
          env: {
            ...process.env,
            IDLE_WORKER_TEST_DATABASE_URL: url.toString(),
            IDLE_WORKER_TEST_CLIENT_INSTANCE_ID: db.clientInstance("idle")
          },
          stdio: ["ignore", "ignore", "inherit"]
        }
      );
      processes.push(child);
      let ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      child.once("exit", (code, signal) => {
        ended = { code, signal };
      });
      const connections = async () => {
        const rows = await db.sql<{ pid: number }[]>`
          select pid from pg_stat_activity where application_name = ${applicationName}
        `;
        return rows.map((row) => row.pid);
      };

      let first: number[] = [];
      await waitUntil(
        async () => {
          first = await connections();
          return ended !== undefined || first.length > 0;
        },
        "the worker process has connected",
        STARTED_WITHIN_MS
      );
      await waitUntil(
        async () => {
          const now = await connections();
          return ended !== undefined || (now.length > 0 && !now.some((pid) => first.includes(pid)));
        },
        "the worker polls on a connection it opened after its first one ended",
        RECONNECTED_WITHIN_MS
      );

      expect(ended).toBeUndefined();
    },
    STARTED_WITHIN_MS + RECONNECTED_WITHIN_MS
  );
});
