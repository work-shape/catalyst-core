import { defineJobHandler, type Logger } from "@work-shape/catalyst-core";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "./support/assertions";
import { kindOf, useJobExecutorHarness } from "./support/job-executor-harness";
import { usePostgresSuite } from "./support/postgres-suite";

// These assert evidence, not a fix for FLAKY-2: its four original failures have no proven cause.
describe("job worker claim diagnostics", () => {
  const db = usePostgresSuite("job_claim_diagnostics");
  const { worker } = useJobExecutorHarness(db);

  function logging() {
    const debug = vi.fn<Logger["debug"]>();
    const logger: Logger = {
      debug,
      info() {},
      warn() {},
      error() {},
      child: () => logger
    };
    return { debug, logger };
  }

  it("distinguishes no due kind from a due candidate skipped while its row is locked", async () => {
    const clientInstanceId = db.clientInstance("locked");
    const kind = kindOf("test.locked_candidate");
    const { debug, logger } = logging();
    let calls = 0;
    const only = worker(
      db.store,
      clientInstanceId,
      [
        defineJobHandler({
          kind,
          slots: 1,
          async run() {
            calls++;
          }
        })
      ],
      [],
      logger
    );
    await only.runDue();
    expect(debug).toHaveBeenLastCalledWith(
      expect.objectContaining({
        clientInstanceId,
        withWork: [],
        startedCount: 0,
        decisions: [expect.objectContaining({ kind: kind.kind, reason: "no_due_work" })]
      }),
      "Job worker pass ended"
    );

    const job = await db.store.jobs.enqueue(
      kind,
      { n: 1 },
      {
        clientInstanceId,
        subject: "confidential-subject"
      }
    );
    const held = await db.hold(
      (tx) => tx`select id from platform_jobs where id = ${job.id} for update`
    );
    try {
      await only.runDue();
      expect(calls).toBe(0);
      expect(debug).toHaveBeenLastCalledWith(
        expect.objectContaining({
          withWork: [kind.kind],
          startedCount: 0,
          decisions: [
            expect.objectContaining({
              kind: kind.kind,
              reason: "no_candidate",
              workFound: true,
              slots: 1,
              active: 0,
              claim: {
                requestedSlots: 1,
                availableSlots: 1,
                globalRunning: null,
                candidateExhausted: true,
                claimedJobIds: []
              }
            })
          ]
        }),
        "Job worker pass ended"
      );
      expect(JSON.stringify(debug.mock.calls)).not.toContain("confidential-subject");
    } finally {
      await held.rollback();
    }
    await only.runDue();
    expect(calls).toBe(1);
    expect(debug).toHaveBeenLastCalledWith(
      expect.objectContaining({
        startedCount: 1,
        decisions: [
          expect.objectContaining({
            reason: "claimed",
            claim: expect.objectContaining({ claimedJobIds: [job.id] })
          })
        ]
      }),
      "Job worker pass ended"
    );
  });

  it.each(["local", "global", "key"] as const)(
    "shows when the %s limit leaves a due job queued",
    async (limit) => {
      const clientInstanceId = db.clientInstance(limit);
      const kind = kindOf(`test.${limit}_limit`, {
        concurrency: limit === "global" ? { global: 1 } : { perKey: 1 }
      });
      const entered = deferred<void>();
      const release = deferred<void>();
      const { debug, logger } = logging();
      const handlers = [
        defineJobHandler({
          kind,
          slots: 1,
          async run() {
            entered.resolve();
            await release.promise;
          }
        })
      ];
      const first = worker(db.store, clientInstanceId, handlers, [], logger);
      const second =
        limit === "local" ? first : worker(db.secondStore, clientInstanceId, handlers, [], logger);
      for (const n of [1, 2])
        await db.store.jobs.enqueue(kind, { n }, { clientInstanceId, concurrencyKey: "one" });
      const running = first.runDue();
      try {
        await entered.promise;
        await second.runDue();
        expect(debug).toHaveBeenCalledWith(
          expect.objectContaining({
            withWork: [kind.kind],
            startedCount: 0,
            decisions: [
              expect.objectContaining({
                reason:
                  limit === "local"
                    ? "no_local_slots"
                    : limit === "global"
                      ? "global_limit"
                      : "no_candidate",
                active: limit === "local" ? 1 : 0,
                claim: expect.objectContaining({
                  requestedSlots: limit === "local" ? 0 : 1,
                  availableSlots: limit === "key" ? 1 : 0,
                  globalRunning: limit === "global" ? 1 : null,
                  claimedJobIds: []
                })
              })
            ]
          }),
          "Job worker pass ended"
        );
      } finally {
        release.resolve();
        await running;
      }
    }
  );
});
