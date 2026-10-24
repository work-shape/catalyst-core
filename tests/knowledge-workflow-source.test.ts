import { describe, expect, it, vi } from "vitest";
import {
  asUserId,
  knowledgeIngestOutputSchema,
  LEGACY_LIST_GRANTOR
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/data-store-instance";
import { eventually, required } from "./support/assertions";
import { item, operationRunOf, SOURCE, useKnowledgeWorkflow } from "./support/knowledge-workflow";

// KBW-2: the Workflow-fed source after KBW-1's review. A pass asks its account afresh before
// every page (KB check 110).

describe("the Workflow-fed source (KBW-2)", { timeout: 600_000 }, () => {
  const { world } = useKnowledgeWorkflow();

  /** Takes the account's grant away once the pass has written its first page. */
  function revokeAfterFirstPage(
    w: Awaited<ReturnType<typeof world>>,
    grantId: string,
    sourceId = SOURCE
  ) {
    const access = w.instance.stores.access;
    const load = access.loadPersistedAccess.bind(access);
    let revoked = false;
    return vi.spyOn(access, "loadPersistedAccess").mockImplementation(async (input) => {
      if (!revoked && input.holder.id === w.principal.id) {
        const [written] =
          await w.sql`select count(*)::int as n from catalyst_kb.source_items where source_id=${sourceId} and item_id like 'new-%'`;
        if ((written?.n ?? 0) > 0) {
          revoked = true;
          await access.deleteGrant({ clientInstanceId, grantId });
        }
      }
      return load(input);
    });
  }

  it("stops a pass whose account loses knowledge_base.write after its first page, and withdraws nothing (check 110)", async () => {
    const w = await world();
    const first = await w.startRun();
    await w.settle(
      operationRunOf(
        await first.call("ingest", {
          dataset: await first.dataset(Array.from({ length: 50 }, (_, n) => item(n)))
        })
      )
    );
    await first.end("done");

    // A complete pass of 3,000 items that names none of the 50: the right goes after page one.
    const run = await w.startRun();
    const rows = Array.from({ length: 3_000 }, (_, n) => ({
      ...item(1_000 + n),
      itemId: `new-${String(n).padStart(4, "0")}`
    }));
    const operationRunId = operationRunOf(
      await run.call("ingest", { dataset: await run.dataset(rows), complete: true })
    );
    const spy = revokeAfterFirstPage(w, w.grant.id);
    try {
      await eventually(async () => {
        await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
        await w.worker.runDue();
        const ended = await w.instance.stores.operationRuns.get({
          clientInstanceId,
          id: operationRunId
        });
        expect(ended).toMatchObject({
          status: "failed",
          error: { code: "knowledge_source_refused" }
        });
      }, 180_000);
    } finally {
      spy.mockRestore();
    }
    // The first page stays; no later page was written.
    const [written] =
      await w.sql`select count(*)::int as n from catalyst_kb.source_items where source_id=${SOURCE} and item_id like 'new-%'`;
    expect(written?.n).toBe(100);
    const [pass] =
      await w.sql`select state, failure_code, pass_state from catalyst_kb.sync_runs where operation_run_id=${operationRunId}`;
    expect(pass).toMatchObject({
      state: "failed",
      failure_code: "knowledge_source_refused",
      pass_state: "dropped"
    });
    // Even a run that the engine let end done withdraws nothing of the 50 it did not name.
    await run.end("done");
    await w.settlePasses();
    expect(await w.states()).toEqual({ fetched: 150 });
  });

  it("withdraws nothing where the account lost the right between its pass and the run's end (check 110)", async () => {
    const w = await world();
    const first = await w.startRun();
    await w.settle(
      operationRunOf(
        await first.call("ingest", { items: Array.from({ length: 20 }, (_, n) => item(n)) })
      )
    );
    await first.end("done");
    // Below the share: the pass would withdraw the two it did not name once the run ended done.
    const run = await w.startRun();
    await w.settle(
      operationRunOf(
        await run.call("ingest", {
          items: Array.from({ length: 18 }, (_, n) => item(n)),
          complete: true
        })
      )
    );
    await w.instance.stores.access.deleteGrant({ clientInstanceId, grantId: w.grant.id });
    await run.end("done");
    await eventually(async () => {
      await w.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
      await w.worker.runDue();
      const [pass] =
        await w.sql`select pass_state from catalyst_kb.sync_runs where workflow_run_id=${run.runId} and complete`;
      expect(pass?.pass_state).toBe("dropped");
    }, 180_000);
    expect(await w.states()).toEqual({ fetched: 20 });
  });

  it("fails the fetch items of a Connection whose use was taken away mid-pass (check 110)", async () => {
    const w = await world();
    const connection = required(
      await w.instance.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "connection",
        name: "fixture"
      })
    );
    const use = await w.instance.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: w.principal.id,
      action: "connection.use",
      effect: "allow",
      scopeKind: "asset",
      scopeId: connection.id,
      grantedBy: asUserId(LEGACY_LIST_GRANTOR)
    });
    const fetch = (n: number) => ({
      itemId: `fetch-${n}`,
      version: "1",
      name: `fetch-${n}.pdf`,
      fetch: { connection: "fixture", operation: "download", input: {} }
    });
    const rows: unknown[] = Array.from({ length: 300 }, (_, n) => ({
      ...item(n),
      itemId: `new-${String(n).padStart(4, "0")}`
    }));
    rows[10] = fetch(1);
    rows[250] = fetch(2);
    const run = await w.startRun();
    const operationRunId = operationRunOf(
      await run.call("ingest", { dataset: await run.dataset(rows) })
    );
    const spy = revokeAfterFirstPage(w, use.id);
    let ended;
    try {
      ended = await w.settle(operationRunId);
    } finally {
      spy.mockRestore();
    }
    await run.endStep(run.lastStep());
    const output = knowledgeIngestOutputSchema.parse(ended.output?.value);
    const failures = [];
    for await (const row of (
      await w.datasets.reader({
        id: output.failures.$dataset,
        runId: run.runId,
        reference: output.failures
      })
    ).rows)
      failures.push(row);
    // On the first page the account still used the Connection; on the third it no longer did.
    expect(failures).toEqual([
      expect.objectContaining({
        code: "knowledge_item_invalid",
        item: expect.objectContaining({ itemId: "fetch-1" })
      }),
      expect.objectContaining({
        code: "knowledge_fetch_not_allowed",
        item: expect.objectContaining({ itemId: "fetch-2" })
      })
    ]);
  });
});
