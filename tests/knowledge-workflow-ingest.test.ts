import { describe, expect, it } from "vitest";
import {
  asUserId,
  knowledgeIngestOutputSchema,
  LEGACY_LIST_GRANTOR
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { clientInstanceId } from "./support/data-store-instance";
import { eventually, required } from "./support/assertions";
import {
  item,
  KB,
  operationRunOf,
  SOURCE,
  useKnowledgeWorkflow,
  WORKFLOW
} from "./support/knowledge-workflow";

// KBW-1: a Workflow puts documents into a Knowledge Base through `ingest`, one Operation Run
// per call with an outcome per item, and a complete pass withdraws what it did not name only
// once its run ended done, above the share only after a person confirmed it.

/** Moderate on purpose: the 10,000-item volume is the scale suite's, not a unit test's. */
const ITEMS = 200;

describe("a Workflow puts documents into a Knowledge Base (KBW-1)", { timeout: 600_000 }, () => {
  const { world } = useKnowledgeWorkflow();

  it("takes a dataset in one Operation Run, every item indexed or failed, one bad item failing alone", async () => {
    const w = await world();
    const run = await w.startRun();
    const rows: unknown[] = Array.from({ length: ITEMS }, (_, n) => item(n));
    // One item without content, one whose fetch names a Connection the account may not use.
    rows[17] = { itemId: "broken", version: "1", name: "broken.md" };
    rows[42] = {
      itemId: "fetched",
      version: "1",
      name: "fetched.pdf",
      fetch: { connection: "fixture", operation: "download", input: {} }
    };
    const dataset = await run.dataset(rows);
    const operationRunId = operationRunOf(await run.call("ingest", { dataset }));
    const ended = await w.settle(operationRunId);
    const output = knowledgeIngestOutputSchema.parse(ended.output?.value);
    expect(output).toMatchObject({
      accepted: ITEMS - 2,
      done: ITEMS - 2,
      failed: 2,
      withdrawn: 0,
      failures: { rowCount: 2 }
    });
    await run.endStep(run.lastStep());
    const failures = [];
    for await (const row of (
      await w.datasets.reader({
        id: output.failures.$dataset,
        runId: run.runId,
        reference: output.failures
      })
    ).rows)
      failures.push(row);
    expect(failures).toEqual([
      expect.objectContaining({
        code: "knowledge_item_invalid",
        item: expect.objectContaining({ itemId: "broken" })
      }),
      expect.objectContaining({
        code: "knowledge_fetch_not_allowed",
        item: expect.objectContaining({ itemId: "fetched" })
      })
    ]);
    // Failure rows carry the item's identity, never its content.
    expect(JSON.stringify(failures)).not.toContain("Content of document");
    expect(await w.states()).toEqual({ fetched: ITEMS - 2 });

    // The page lists the source as the Workflow's, with its last run.
    const sources = await w.instance.api.call("knowledge_bases.sources", {
      params: { knowledgeBase: KB }
    });
    expect(sources.statusCode, sources.body).toBe(200);
    expect(sources.json().sources).toContainEqual(
      expect.objectContaining({
        id: SOURCE,
        kind: "workflow",
        workflowId: WORKFLOW,
        items: expect.objectContaining({ indexed: ITEMS - 2 }),
        last: expect.objectContaining({ mode: "ingest", state: "done" })
      })
    );

    // The same items again at the same version cost nothing and change nothing.
    const again = await w.startRun();
    const repeated = await again.call("ingest", { items: [item(1), item(2)] });
    const repeatedRun = await w.settle(operationRunOf(repeated));
    expect(repeatedRun.output?.value).toMatchObject({ accepted: 2, done: 2, failed: 0 });
  });

  it("lets a second pass of the same source wait for the first, and ends both", async () => {
    const w = await world();
    const first = await w.startRun();
    const second = await w.startRun();
    const [a, b] = await Promise.all([
      first.call("ingest", { items: [item(1), item(2)] }),
      second.call("ingest", { items: [item(300), item(301), item(302)] })
    ]);
    const [endedA, endedB] = await Promise.all([
      w.settle(operationRunOf(a)),
      w.settle(operationRunOf(b))
    ]);
    expect(endedA.output?.value).toMatchObject({ accepted: 2, done: 2, failed: 0 });
    expect(endedB.output?.value).toMatchObject({ accepted: 3, done: 3, failed: 0 });
    expect(await w.states()).toEqual({ fetched: 5 });
    expect(await w.sql`select sync_run_id from catalyst_kb.ingest_waiting`).toEqual([]);
  });

  it("withdraws what a complete pass did not name once the run ended done, and nothing from a failed run", async () => {
    const w = await world();
    const first = await w.startRun();
    await w.settle(
      operationRunOf(
        await first.call("ingest", {
          dataset: await first.dataset(Array.from({ length: ITEMS }, (_, n) => item(n)))
        })
      )
    );
    await first.end("done");

    // A failed run withdraws nothing, though its pass promised to be complete.
    const failed = await w.startRun();
    const failedPass = await w.settle(
      operationRunOf(
        await failed.call("ingest", {
          dataset: await failed.dataset(Array.from({ length: ITEMS - 10 }, (_, n) => item(n))),
          complete: true
        })
      )
    );
    expect(failedPass.output?.value).toMatchObject({ withdrawn: 10 });
    await failed.end("failed");
    await w.settlePasses();
    expect(await w.states()).toEqual({ fetched: ITEMS });

    // A run that ends done withdraws the ten it did not name, and search leaves them out.
    const done = await w.startRun();
    await w.settle(
      operationRunOf(
        await done.call("ingest", {
          dataset: await done.dataset(Array.from({ length: ITEMS - 10 }, (_, n) => item(n))),
          complete: true
        })
      )
    );
    expect(await w.states()).toEqual({ fetched: ITEMS });
    await done.end("done");
    await w.settlePasses();
    expect(await w.states()).toEqual({ fetched: ITEMS - 10, withdrawn: 10 });
    const withdrawnIds =
      await w.sql`select item_id from catalyst_kb.source_items where source_id=${SOURCE} and state='withdrawn' order by item_id`;
    expect(withdrawnIds.map((row) => row.item_id)).toEqual(
      Array.from({ length: 10 }, (_, n) => item(ITEMS - 10 + n).itemId)
    );
    const search = async (marker: number) => {
      const answer = await w.instance.api.call("knowledge_bases.search", {
        params: { knowledgeBase: KB },
        payload: { query: `zq${marker}x` }
      });
      expect(answer.statusCode, answer.body).toBe(200);
      return JSON.stringify(answer.json());
    };
    expect(await search(5)).toContain(item(5).name);
    expect(await search(ITEMS - 1)).not.toContain(item(ITEMS - 1).name);

    // `withdraw` takes named items out at once.
    const withdraw = await done.call("withdraw", { itemIds: [item(0).itemId, "never-named"] });
    expect(withdraw.result, JSON.stringify(withdraw.result)).toMatchObject({
      status: "done",
      output: { withdrawn: 1 }
    });
    expect(await w.states()).toEqual({ fetched: ITEMS - 11, withdrawn: 11 });
  });

  it("keeps a document whose new version the pass could not take, and withdraws nothing after a pass of the run failed", async () => {
    const w = await world();
    const first = await w.startRun();
    await w.settle(
      operationRunOf(
        await first.call("ingest", {
          dataset: await first.dataset(Array.from({ length: ITEMS }, (_, n) => item(n)))
        })
      )
    );
    await first.end("done");

    // The new version of one document is invalid: the pass named it, so it keeps its old one.
    const second = await w.startRun();
    const rows: unknown[] = Array.from({ length: ITEMS }, (_, n) => item(n));
    rows[5] = { ...item(5, "2"), originLink: "ftp://dms.example.test/doc-5" };
    const pass = await w.settle(
      operationRunOf(
        await second.call("ingest", { dataset: await second.dataset(rows), complete: true })
      )
    );
    expect(pass.output?.value).toMatchObject({ failed: 1, withdrawn: 0 });
    await second.end("done");
    await w.settlePasses();
    expect(await w.states()).toEqual({ fetched: ITEMS });
    const [kept] =
      await w.sql`select version from catalyst_kb.source_items where source_id=${SOURCE} and item_id=${item(5).itemId}`;
    expect(kept?.version).toBe("1");

    // A run that went on after one of its passes failed promises no complete listing.
    const third = await w.startRun();
    const partial = operationRunOf(
      await third.call("ingest", {
        dataset: await third.dataset(Array.from({ length: 10 }, (_, n) => item(n)))
      })
    );
    await w.settle(partial);
    await w.sql`update catalyst_kb.sync_runs set state='failed', failure_code='knowledge_source_unreachable' where operation_run_id=${partial}`;
    await w.settle(
      operationRunOf(
        await third.call("ingest", {
          dataset: await third.dataset(Array.from({ length: 10 }, (_, n) => item(10 + n))),
          complete: true
        })
      )
    );
    await third.end("done");
    await w.settlePasses();
    expect(await w.states()).toEqual({ fetched: ITEMS });
    const [dropped] =
      await w.sql`select pass_state from catalyst_kb.sync_runs where source_id=${SOURCE} and workflow_run_id=${third.runId} and complete`;
    expect(dropped?.pass_state).toBe("dropped");
  });

  it("ends a waiting call whose run ended before its turn, leaving no rows", async () => {
    const w = await world();
    const first = await w.startRun();
    const second = await w.startRun();
    const a = operationRunOf(await first.call("ingest", { items: [item(1)] }));
    const b = operationRunOf(await second.call("ingest", { items: [item(2)], complete: true }));
    expect(await w.sql`select sync_run_id from catalyst_kb.ingest_waiting`).toHaveLength(1);
    await second.end("failed");
    await w.settle(a);
    await eventually(async () => {
      await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
      await w.worker.runDue();
      const run = await w.instance.stores.operationRuns.get({ clientInstanceId, id: b });
      expect(run).toMatchObject({
        status: "failed",
        error: { code: "knowledge_ingest_cancelled" }
      });
    }, 180_000);
    expect(await w.sql`select sync_run_id from catalyst_kb.ingest_waiting`).toEqual([]);
    expect(await w.sql`select sync_run_id from catalyst_kb.ingest_items`).toEqual([]);
    expect(await w.sql`select sync_run_id from catalyst_kb.ingest_failures`).toEqual([]);
    expect(await w.states()).toEqual({ fetched: 1 });
  });

  it("refuses a Workflow whose account may not feed the Knowledge Base, even holding write (KBW-3)", async () => {
    const w = await world();
    await w.instance.stores.access.deleteGrant({ clientInstanceId, grantId: w.grant.id });
    // `write` changes the draft and adds files by hand; it never stands for `ingest`.
    await w.instance.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: w.principal.id,
      action: "knowledge_base.write",
      effect: "allow",
      scopeKind: "asset",
      scopeId: w.kb.id,
      grantedBy: asUserId(LEGACY_LIST_GRANTOR)
    });
    const run = await w.startRun();
    const ingest = await run.call("ingest", { items: [item(1)] });
    expect(ingest.result, JSON.stringify(ingest.result)).toMatchObject({
      status: "denied",
      reason: { action: "knowledge_base.ingest" }
    });
    const withdraw = await run.call("withdraw", { itemIds: [item(1).itemId] });
    expect(withdraw.result, JSON.stringify(withdraw.result)).toMatchObject({
      status: "denied",
      reason: { action: "knowledge_base.ingest" }
    });
    expect(await w.sql`select id from catalyst_kb.sync_runs where source_id=${SOURCE}`).toEqual([]);
  });

  it("waits for a confirmation in the Inbox above the share, and withdraws once it is given", async () => {
    const w = await world();
    const first = await w.startRun();
    await w.settle(
      operationRunOf(
        await first.call("ingest", {
          dataset: await first.dataset(Array.from({ length: ITEMS }, (_, n) => item(n)))
        })
      )
    );
    await first.end("done");
    const kept = Math.round(ITEMS * 0.3);
    const second = await w.startRun();
    await w.settle(
      operationRunOf(
        await second.call("ingest", {
          dataset: await second.dataset(Array.from({ length: kept }, (_, n) => item(n))),
          complete: true
        })
      )
    );
    await second.end("done");
    const pass = await eventually(async () => {
      await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
      await w.worker.runDue();
      const [row] =
        await w.sql`select pass_state, approval_request_id from catalyst_kb.sync_runs where source_id=${SOURCE} and complete`;
      expect(row?.pass_state).toBe("confirming");
      return required(row);
    }, 180_000);
    expect(await w.states()).toEqual({ fetched: ITEMS });
    const request = required(
      await w.instance.stores.approvals.getApprovalRequest({
        clientInstanceId,
        requestId: String(pass.approval_request_id)
      })
    );
    expect(request).toMatchObject({
      status: "pending",
      payload: expect.objectContaining({ withdrawn: ITEMS - kept, total: ITEMS })
    });
    const decision = await w.instance.api.call("approval_requests.decide", {
      params: { requestId: String(pass.approval_request_id) },
      payload: { decision: "approve" }
    });
    expect(decision.statusCode, decision.body).toBe(200);
    await eventually(async () => {
      await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
      await w.worker.runDue();
      expect(await w.states()).toEqual({ fetched: kept, withdrawn: ITEMS - kept });
    }, 180_000);
  });

  it("refuses a call that is no step of a Workflow run", async () => {
    const w = await world();
    const actor = {
      id: "publisher",
      externalUserId: "publisher",
      displayLabel: "Publisher",
      roles: ["superadmin"],
      permissionRefs: [],
      clientInstanceId,
      authSource: "test" as const
    };
    const outcome = await runOperation(
      {
        operation: `knowledge.${KB}.ingest`,
        effect: "changing",
        input: { items: [item(1)] },
        actor,
        origin: { kind: "user" },
        correlationId: "kbw-1"
      },
      w.instance.execution.operationCalls.deps
    );
    expect(outcome.result).toMatchObject({
      status: "failed",
      error: { details: { reason: "workflow_origin_required" } }
    });
  });
});
