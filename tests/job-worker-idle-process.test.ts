import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitUntil } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";
import { databaseUrlFor } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { killTestProcess, startTestProcess } from "./support/test-process";

// Bounds on a hang, never pauses. The process is started through the TypeScript loader, which
// takes most of the first one on a loaded machine.
const STARTED_WITHIN_MS = 90_000;
const RECONNECTED_WITHIN_MS = 60_000;
const STOPPED_WITHIN_MS = 60_000;

describe("an idle job worker in a process of its own", () => {
  const db = usePostgresSuite("idle_worker");
  const processes: ChildProcess[] = [];
  const directories: string[] = [];

  afterEach(async () => {
    for (const child of processes.splice(0)) await killTestProcess(child);
    for (const directory of directories.splice(0)) {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /** How the process ended, once it has. */
  function ending(child: ChildProcess) {
    const state: { ended?: { code: number | null; signal: NodeJS.Signals | null } } = {};
    child.once("exit", (code, signal) => {
      state.ended = { code, signal };
    });
    return state;
  }

  async function connections(applicationName: string): Promise<number[]> {
    const rows = await db.sql<{ pid: number }[]>`
      select pid from pg_stat_activity where application_name = ${applicationName}
    `;
    return rows.map((row) => row.pid);
  }

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
      const state = ending(child);

      let first: number[] = [];
      await waitUntil(
        async () => {
          first = await connections(applicationName);
          return state.ended !== undefined || first.length > 0;
        },
        "the worker process has connected",
        STARTED_WITHIN_MS
      );
      await waitUntil(
        async () => {
          const now = await connections(applicationName);
          return (
            state.ended !== undefined || (now.length > 0 && !now.some((pid) => first.includes(pid)))
          );
        },
        "the worker polls on a connection it opened after its first one ended",
        RECONNECTED_WITHIN_MS
      );

      expect(state.ended).toBeUndefined();
    },
    STARTED_WITHIN_MS + RECONNECTED_WITHIN_MS
  );

  it(
    "ends with code 0 when it is told to stop",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "catalyst-idle-worker-"));
      directories.push(directory);
      const configPath = join(directory, "app.yaml");
      // JSON is YAML.
      await writeFile(
        configPath,
        JSON.stringify(
          createTestConfig({
            executionWorkspaces: { enabled: true },
            workspaceObjectRoot: join(directory, "workspace-objects")
          })
        )
      );
      const applicationName = `${db.first}_stopped`;
      // The worker of an instance, assembled as its entry point assembles it.
      const child = startTestProcess(new URL("./support/instance-process.ts", import.meta.url), {
        args: ["artifact-preview-worker", "without-capability"],
        env: {
          PATH: process.env.PATH,
          CLIENT_CONFIG_PATH: configPath,
          DATABASE_URL: databaseUrlFor(db.databaseUrl, applicationName)
        },
        stdio: ["ignore", "ignore", "inherit"]
      });
      processes.push(child);
      const state = ending(child);
      // The entry point listens for the signal before it starts the worker, so a worker that
      // has asked for its jobs can be told to stop.
      const polled = async () => {
        const rows = await db.sql`
          select 1 from pg_stat_activity
          where application_name = ${applicationName} and query like '%platform_jobs%'
        `;
        return rows.length > 0;
      };
      await waitUntil(
        async () => state.ended !== undefined || (await polled()),
        "the worker has asked for its jobs",
        STARTED_WITHIN_MS
      );

      child.kill("SIGTERM");
      await waitUntil(
        () => state.ended !== undefined,
        "the worker process has ended",
        STOPPED_WITHIN_MS
      );

      expect(state.ended).toEqual({ code: 0, signal: null });
    },
    STARTED_WITHIN_MS + STOPPED_WITHIN_MS
  );
});
