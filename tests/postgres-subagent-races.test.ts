import { describe, expect, it } from "vitest";
import {
  ACTIVE_AGENT_RUN_STATUSES,
  executeAgentRunJob,
  type PlatformStores
} from "@work-shape/catalyst-core";
import { orderedStoreCalls } from "./support/postgres-concurrency-harness";
import { usePostgresSuite } from "./support/postgres-suite";
import { createSubagentFixture, type ClaimedTestRun } from "./support/subagent-runs";

describe("Postgres wake of a parent run by its subagents", () => {
  // The first pool ends a run or pauses the parent and holds its transaction open; the second
  // waits for the parent's locks. Postgres reports the wait before the first side commits.
  const db = usePostgresSuite("subagents");

  /** Runs `first` on the first pool and holds it until `second` waits for its locks. */
  function ordered<A, B>(first: (stores: PlatformStores) => Promise<A>, second: () => Promise<B>) {
    return orderedStoreCalls(
      db.sql,
      { first: db.store, firstName: db.first, secondName: db.second },
      first,
      second
    );
  }

  /** A parent that started two subagents, both claimed by their jobs; the first one ended. */
  async function arrangeOneChildLeft(label: string) {
    const fixture = await createSubagentFixture(db, label);
    const conversation = await fixture.createConversation("split");
    const parent = await fixture.startParent(conversation);
    const first = await fixture.startChild(parent.run, "first half");
    const last = await fixture.startChild(parent.run, "second half");
    const claimedFirst = await fixture.claim(first.run);
    const claimedLast = await fixture.claim(last.run);
    await fixture.complete(db.store, claimedFirst, "the first answer");
    return { fixture, parent, children: [first, last], claimedLast };
  }

  /** The parent is queued once with one wake job of its own, and no child is open. */
  async function expectOneWake(
    fixture: Awaited<ReturnType<typeof createSubagentFixture>>,
    parent: ClaimedTestRun
  ) {
    await expect(fixture.statusOf(parent.run)).resolves.toBe("queued");
    const jobs = await fixture.executeJobsOf(parent.run);
    // The job that held the parent while it ran stays as its worker left it.
    expect(jobs.filter((job) => job.id === parent.lease.jobId)).toEqual([
      expect.objectContaining({ status: "running" })
    ]);
    expect(jobs.filter((job) => job.id !== parent.lease.jobId)).toEqual([
      {
        id: expect.any(String),
        status: "queued",
        dedupe_key: `${executeAgentRunJob.kind}:${parent.run.id}:subagents:${parent.run.lastSequence}`
      }
    ]);
    await expect(
      db.sql`
        select count(*)::int as open from agent_runs
        where parent_run_id = ${parent.run.id}
          and status = any(${[...ACTIVE_AGENT_RUN_STATUSES]})`
    ).resolves.toEqual([{ open: 0 }]);
  }

  it("reads an open subagent as open and an ended one by how it ended", async () => {
    const { fixture, parent, children } = await arrangeOneChildLeft("outcomes");
    const [first, last] = children;
    if (!first || !last) throw new Error("Two subagents were started");

    await expect(
      db.store.childAgentRuns.readSubagentOutcomes({
        ...fixture.scope,
        parentRunId: parent.run.id,
        runIds: [first.run.id, last.run.id]
      })
    ).resolves.toEqual([
      {
        runId: first.run.id,
        status: "completed",
        agent: "test_agent",
        answer: "the first answer"
      },
      { runId: last.run.id, status: "open" }
    ]);
  });

  it("queues the parent once when the last subagent ends before the pause commits", async () => {
    const { fixture, parent, children, claimedLast } = await arrangeOneChildLeft("child_first");

    const [ended, paused] = await ordered(
      (stores) => fixture.complete(stores, claimedLast, "the second answer"),
      () => fixture.pause(db.secondStore, parent, children)
    );

    expect(ended).toMatchObject({ status: "fulfilled" });
    // The pause read the children after the end committed: it did not wait, it queued itself.
    expect(paused).toEqual({ status: "fulfilled", value: { status: "queued" } });
    await expectOneWake(fixture, parent);
  });

  it("queues the parent once when the last subagent ends after the pause commits", async () => {
    const { fixture, parent, children, claimedLast } = await arrangeOneChildLeft("pause_first");

    const [paused, ended] = await ordered(
      (stores) => fixture.pause(stores, parent, children),
      () => fixture.complete(db.secondStore, claimedLast, "the second answer")
    );

    expect(paused).toEqual({ status: "fulfilled", value: { status: "waiting_for_subagents" } });
    // The end found the parent waiting with no other child open, and woke it.
    expect(ended).toMatchObject({ status: "fulfilled" });
    await expectOneWake(fixture, parent);
  });

  it("queues the parent once when its two subagents end at the same moment", async () => {
    const fixture = await createSubagentFixture(db, "together");
    const conversation = await fixture.createConversation("split");
    const parent = await fixture.startParent(conversation);
    const first = await fixture.startChild(parent.run, "first half");
    const last = await fixture.startChild(parent.run, "second half");
    const claimedFirst = await fixture.claim(first.run);
    const claimedLast = await fixture.claim(last.run);
    await expect(fixture.pause(db.store, parent, [first, last])).resolves.toEqual({
      status: "waiting_for_subagents"
    });
    await expect(fixture.executeJobsOf(parent.run)).resolves.toEqual([
      expect.objectContaining({ id: parent.lease.jobId })
    ]);

    const [firstEnd, lastEnd] = await ordered(
      (stores) => fixture.complete(stores, claimedFirst, "the first answer"),
      () => fixture.complete(db.secondStore, claimedLast, "the second answer")
    );

    expect(firstEnd).toMatchObject({ status: "fulfilled" });
    expect(lastEnd).toMatchObject({ status: "fulfilled" });
    await expectOneWake(fixture, parent);
  });

  it("queues the parent once when one subagent is stopped while the other ends", async () => {
    const fixture = await createSubagentFixture(db, "two_writers");
    const conversation = await fixture.createConversation("split");
    const parent = await fixture.startParent(conversation);
    const first = await fixture.startChild(parent.run, "first half");
    const last = await fixture.startChild(parent.run, "second half");
    const claimedLast = await fixture.claim(last.run);
    await fixture.pause(db.store, parent, [first, last]);

    // The first child was never claimed: Stop ends it within the request while the other
    // child's worker stores its answer.
    const [stopped, ended] = await ordered(
      (stores) => fixture.stop(stores, first.run),
      () => fixture.complete(db.secondStore, claimedLast, "the second answer")
    );

    expect(stopped).toMatchObject({ status: "fulfilled" });
    expect(ended).toMatchObject({ status: "fulfilled" });
    await expect(fixture.statusOf(first.run)).resolves.toBe("cancelled");
    await expectOneWake(fixture, parent);
  });
});
