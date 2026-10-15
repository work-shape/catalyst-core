import {
  createJobWorker,
  createSandbox,
  createSandboxCheckJobs
} from "@work-shape/catalyst-client-assembly";
import { getClientInstanceId } from "@work-shape/catalyst-config-schema";
import { JOB_WORKER_SILENT_MS } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { required } from "./support/assertions";
import {
  administrator,
  recordingLogger,
  createServer,
  stubProviders,
  read,
  byId
} from "./support/infrastructure-world";
import { withTestSql } from "./support/test-sql";

// Instance > Infrastructure: what the page shows of the sandbox, which the workspace command
// worker checks, when that worker stops reporting, and when one is back.

describe("Instance > Infrastructure: a sandbox whose worker stopped reporting", () => {
  it("shows the sandbox as failed, with the time of its last result, once two checks were missed", async () => {
    stubProviders();
    const { server, config, infrastructure, advance } = await createServer();
    const worker = createJobWorker({
      stores: server.stores,
      clientInstanceId: getClientInstanceId(config),
      logger: recordingLogger().logger,
      ...createSandboxCheckJobs({
        config,
        infrastructure,
        sandbox: await createSandbox(config, infrastructure),
        stores: server.stores,
        now: () => new Date("2026-10-10T08:03:00.000Z")
      })
    });
    await worker.runDue();
    await worker.stop();
    const get = async () =>
      read(await server.call("instance.infrastructure.get", {}, administrator));

    // 08:12:41, nine minutes and 41 seconds after the result: one check may still be late.
    advance(12 * 60_000 + 41_000);
    const late = await get();
    expect(byId(late).sandbox?.check).toEqual({
      status: "ok",
      checkedAt: "2026-10-10T08:03:00.000Z"
    });
    expect(late.codeExecution).toMatchObject({ available: true });

    // 08:13:19: two intervals of five minutes have passed without a result.
    advance(38_000);
    const stale = await get();
    expect(byId(stale).sandbox?.check).toEqual({
      status: "failed",
      checkedAt: "2026-10-10T08:03:00.000Z",
      errorClass: "no_report"
    });
    expect(stale.codeExecution).toEqual({ available: false, since: "2026-10-10T08:03:00.000Z" });
  });

  it("shows the sandbox as failed when its worker went silent, and as answering again when a worker is back", async () => {
    stubProviders();
    const { server, config, infrastructure, setNow } = await createServer();
    const clientInstanceId = getClientInstanceId(config);
    const startWorker = async (checkedAt: Date) =>
      createJobWorker({
        stores: server.stores,
        clientInstanceId,
        logger: recordingLogger().logger,
        ...createSandboxCheckJobs({
          config,
          infrastructure,
          sandbox: await createSandbox(config, infrastructure),
          stores: server.stores,
          now: () => checkedAt
        })
      });
    const get = async () =>
      read(await server.call("instance.infrastructure.get", {}, administrator));
    // The workers report on the clock of the database, so this test reads on the real clock.
    const now = new Date();
    const checkedAt = new Date(now.getTime() - 47_000);
    setNow(now);
    const first = await startWorker(checkedAt);
    await first.runDue();
    await first.stop();
    const running = await get();
    expect(byId(running).sandbox?.check).toEqual({
      status: "ok",
      checkedAt: checkedAt.toISOString()
    });
    expect(running.codeExecution).toMatchObject({ available: true });

    // 47 seconds pass in which no worker of the kind reports: more than three missed reports.
    const [silent] = await withTestSql(
      (sql) => sql<{ seen_at: Date }[]>`
        update job_worker_reports
        set seen_at = seen_at - interval '47 seconds',
            alive_since = alive_since - interval '47 seconds'
        where client_instance_id = ${clientInstanceId}
        returning seen_at`
    );
    const silentSince = required(silent).seen_at.toISOString();
    const stopped = await get();
    expect(byId(stopped).sandbox?.check).toEqual({
      status: "failed",
      checkedAt: silentSince,
      errorClass: "no_report"
    });
    expect(stopped.codeExecution).toEqual({ available: false, since: silentSince });

    // A worker is back and checks the sandbox as it starts.
    const second = await startWorker(now);
    await second.runDue();
    await second.stop();
    const back = await get();
    expect(byId(back).sandbox?.check).toEqual({ status: "ok", checkedAt: now.toISOString() });
    expect(back.codeExecution?.available).toBe(true);
    // Code runs since the worker that is up now came, not since the result of the one before.
    expect(Date.parse(required(back.codeExecution?.since))).toBeGreaterThan(
      Date.parse(silentSince) + JOB_WORKER_SILENT_MS
    );
  });

  it("shows the sandbox as failed when its worker reported and went silent before its first result", async () => {
    stubProviders();
    const { server, config, entry, setNow } = await createServer();
    const clientInstanceId = getClientInstanceId(config);
    const get = async () =>
      read(await server.call("instance.infrastructure.get", {}, administrator));
    setNow(new Date());
    await get();
    const reportedAgo = (seconds: number) =>
      withTestSql(
        (sql) => sql<{ seen_at: Date }[]>`
          insert into job_worker_reports (client_instance_id, kind, alive_since, seen_at)
          values (
            ${clientInstanceId}, ${required(entry("sandbox").checkedByJobKind)},
            now() - make_interval(secs => ${seconds}), now() - make_interval(secs => ${seconds})
          )
          on conflict (client_instance_id, kind) do update set seen_at = excluded.seen_at
          returning seen_at`
      );

    // 13 seconds after its report the worker may still be at its first check.
    await reportedAgo(13);
    const starting = await get();
    expect(byId(starting).sandbox?.check).toEqual({ status: "not_checked" });
    expect(starting.codeExecution).toEqual({ available: false });

    const [silent] = await reportedAgo(47);
    const silentSince = required(silent).seen_at.toISOString();
    const gone = await get();
    expect(byId(gone).sandbox?.check).toEqual({
      status: "failed",
      checkedAt: silentSince,
      errorClass: "no_report"
    });
    expect(gone.codeExecution).toEqual({ available: false, since: silentSince });
  });

  it("goes by the age of a result that is newer than the last report: a worker of the release before", async () => {
    stubProviders();
    const { server, config, entry, setNow } = await createServer();
    const clientInstanceId = getClientInstanceId(config);
    const now = new Date();
    setNow(now);
    await server.call("instance.infrastructure.get", {}, administrator);
    const checkedAt = new Date(now.getTime() - 20_000).toISOString();
    await withTestSql(
      (sql) => sql`
        insert into job_worker_reports (client_instance_id, kind, alive_since, seen_at)
        values (
          ${clientInstanceId}, ${required(entry("sandbox").checkedByJobKind)},
          now() - interval '5 minutes', now() - interval '5 minutes'
        )`
    );
    await server.stores.infrastructureChecks.recordOutcomes({
      clientInstanceId,
      outcomes: { [entry("sandbox").id]: { ok: true, checkedAt } }
    });

    const shown = read(await server.call("instance.infrastructure.get", {}, administrator));

    // The report is five minutes old, the result 20 seconds: whoever wrote it reports nothing.
    expect(byId(shown).sandbox?.check).toEqual({ status: "ok", checkedAt });
    expect(shown.codeExecution).toEqual({ available: true, since: checkedAt });
  });
});
