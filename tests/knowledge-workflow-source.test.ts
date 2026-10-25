import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asConversationId,
  asUserId,
  KNOWLEDGE_BASE_ACTIONS,
  knowledgeIngestOutputSchema,
  LEGACY_LIST_GRANTOR
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/data-store-instance";
import { eventually, required } from "./support/assertions";
import { asMember, developmentAuth } from "./support/knowledge-files";
import {
  item,
  KB,
  operationRunOf,
  SOURCE,
  useKnowledgeWorkflow
} from "./support/knowledge-workflow";

// KBW-2: the Workflow-fed source after KBW-1's review. A pass asks its account afresh before
// every page (KB check 110); a document a person removes stays out until a publisher lets it
// back (111).

describe("the Workflow-fed source (KBW-2)", { timeout: 600_000 }, () => {
  const { world } = useKnowledgeWorkflow();

  /** The failures a pass reported, from its output's dataset. */
  async function failuresOf(
    w: Awaited<ReturnType<typeof world>>,
    runId: string,
    output: unknown
  ): Promise<unknown[]> {
    const parsed = knowledgeIngestOutputSchema.parse(output);
    const rows = [];
    for await (const row of (
      await w.datasets.reader({
        id: parsed.failures.$dataset,
        runId,
        reference: parsed.failures
      })
    ).rows)
      rows.push(row);
    return rows;
  }

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

  it("holds a Workflow-fed document a person removed out of every later pass until a publisher lets it back (check 111)", async () => {
    const w = await world(developmentAuth);
    const first = await w.startRun();
    await w.settle(
      operationRunOf(
        await first.call("ingest", { items: [item(0), item(1), item(2)], complete: true })
      )
    );
    await first.end("done");
    await w.settlePasses();
    const search = async (marker: number) => {
      const answer = await w.instance.api.call("knowledge_bases.search", {
        params: { knowledgeBase: KB },
        payload: { query: `zq${marker}x` }
      });
      expect(answer.statusCode, answer.body).toBe(200);
      return JSON.stringify(answer.json());
    };
    await eventually(async () => {
      await w.worker.runDue();
      expect(await search(1)).toContain(item(1).name);
    }, 60_000);
    const [removedRow] =
      await w.sql`select d.id as document_id, i.id as item from catalyst_kb.documents d join catalyst_kb.source_items i on i.id=d.source_item_id where i.item_id=${item(1).itemId}`;
    const { document_id: documentId, item: sourceItemId } = z
      .object({ document_id: z.string(), item: z.string() })
      .parse(removedRow);

    // A member who holds knowledge_base.write, and not publish.
    const conversation = await w.instance.api.call("conversations.create", {
      payload: { title: "Member" },
      headers: asMember
    });
    expect(conversation.statusCode, conversation.body).toBe(200);
    const member = required(
      await w.instance.stores.conversations.getConversation(
        clientInstanceId,
        asConversationId(z.object({ id: z.string() }).parse(conversation.json()).id)
      )
    ).createdByUserId;
    await w.instance.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: member,
      action: KNOWLEDGE_BASE_ACTIONS.write,
      effect: "allow",
      scopeKind: "asset",
      scopeId: w.kb.id,
      grantedBy: asUserId(LEGACY_LIST_GRANTOR)
    });

    const removed = await w.instance.api.call("knowledge_bases.remove_documents", {
      params: { knowledgeBase: KB },
      payload: { documentIds: [documentId] },
      headers: asMember
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(removed.json()).toEqual({ removed: 1 });
    // Search leaves it out at once; locate shows it removed.
    expect(await search(1)).not.toContain(item(1).name);
    const located = await w.instance.api.call("knowledge_bases.locate", {
      params: { knowledgeBase: KB },
      query: { sourceItemId }
    });
    expect(located.statusCode, located.body).toBe(200);
    expect(located.json()).toMatchObject({
      source: SOURCE,
      state: "withdrawn",
      removedAt: expect.any(String)
    });
    // The audit event holds the source and the count, and no name.
    const removal = (
      await w.instance.stores.audit.listAuditEvents({
        clientInstanceId,
        type: "knowledge_base.documents_removed",
        page: { limit: 10 }
      })
    ).at(0);
    expect(removal?.metadata).toEqual({
      documentIds: [documentId],
      documents: 1,
      held: [{ source: SOURCE, count: 1 }],
      operationRunId: expect.any(String)
    });
    expect(JSON.stringify(removal)).not.toContain(item(1).name);

    // The next complete pass names it at a new version: it is reported and left out, and not
    // withdrawn again as unnamed.
    const second = await w.startRun();
    const operationRunId = operationRunOf(
      await second.call("ingest", {
        items: [item(0), item(1, "2"), item(2)],
        complete: true
      })
    );
    const ended = await w.settle(operationRunId);
    await second.endStep(second.lastStep());
    expect(await failuresOf(w, second.runId, ended.output?.value)).toEqual([
      expect.objectContaining({
        code: "knowledge_item_removed",
        item: expect.objectContaining({ itemId: item(1).itemId })
      })
    ]);
    await second.end("done");
    await w.settlePasses();
    expect(await w.states()).toEqual({ fetched: 2, withdrawn: 1 });
    const [pass] =
      await w.sql`select withdrawn from catalyst_kb.sync_runs where workflow_run_id=${second.runId}`;
    expect(pass?.withdrawn).toBe(0);
    expect(await search(1)).not.toContain(item(1).name);
    const status = await w.instance.api.call("knowledge_bases.sources", {
      params: { knowledgeBase: KB }
    });
    expect(status.statusCode, status.body).toBe(200);
    expect(JSON.stringify(status.json())).toContain('"code":"knowledge_item_removed","count":1');

    // Neither the Workflow's account nor a holder of write alone lifts the hold.
    const byAccount = await second.call("retry", { source: SOURCE, sourceItemIds: [sourceItemId] });
    expect(byAccount.result.status, JSON.stringify(byAccount.result)).not.toBe("done");
    const byMember = await w.instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, sourceItemIds: [sourceItemId] },
      headers: asMember
    });
    expect(byMember.statusCode, byMember.body).toBe(403);
    const third = await w.startRun();
    await w.settle(operationRunOf(await third.call("ingest", { items: [item(1, "3")] })));
    await third.end("done");
    expect(await w.states()).toEqual({ fetched: 2, withdrawn: 1 });

    // A holder of knowledge_base.publish lifts it, and the next pass takes the item.
    const lifted = await w.instance.api.call("knowledge_bases.retry_documents", {
      params: { knowledgeBase: KB },
      payload: { source: SOURCE, failureCode: "knowledge_item_removed" }
    });
    expect(lifted.statusCode, lifted.body).toBe(200);
    expect(lifted.json()).toEqual({ queued: 0, released: 1 });
    const liftedEvent = (
      await w.instance.stores.audit.listAuditEvents({
        clientInstanceId,
        type: "knowledge_base.removal_hold_lifted",
        page: { limit: 10 }
      })
    ).at(0);
    expect(liftedEvent?.metadata).toEqual({
      source: SOURCE,
      count: 1,
      operationRunId: expect.any(String)
    });
    const fourth = await w.startRun();
    await w.settle(operationRunOf(await fourth.call("ingest", { items: [item(1, "4")] })));
    await fourth.end("done");
    expect(await w.states()).toEqual({ fetched: 3 });
    await eventually(async () => {
      await w.worker.runDue();
      expect(await search(1)).toContain(item(1).name);
    }, 60_000);
  });
});
