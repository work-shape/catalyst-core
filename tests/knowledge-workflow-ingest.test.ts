import { describe, expect, it } from "vitest";
import {
  asUserId,
  createPlatformId,
  KNOWLEDGE_BASE_ASSET_KIND,
  knowledgeIngestOutputSchema,
  LEGACY_LIST_GRANTOR,
  type WorkflowRunPrincipal,
  type WorkflowStepRunId
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { eventually, required } from "./support/assertions";

// KBW-1: a Workflow puts documents into a Knowledge Base through `ingest`, one Operation Run
// per call with an outcome per item, and a complete pass withdraws what it did not name only
// once its run ended done, above the share only after a person confirmed it.

const KB = "sync-test";
const WORKFLOW = "nightly-import";
const SOURCE = `workflow:${WORKFLOW}`;
/** Moderate on purpose: the 10,000-item volume is the scale suite's, not a unit test's. */
const ITEMS = 200;

const item = (n: number, version = "1") => ({
  itemId: `doc-${String(n).padStart(4, "0")}`,
  version,
  name: `doc-${String(n).padStart(4, "0")}.md`,
  path: `/import/doc-${n}.md`,
  text: `# Document ${n}\n\nContent of document number ${n}, marked zq${n}x.`
});

describe("a Workflow puts documents into a Knowledge Base (KBW-1)", { timeout: 600_000 }, () => {
  const { setup } = useKnowledgeSync();

  async function world() {
    const world = await setup();
    const { instance } = world;
    const stores = instance.stores;
    const kb = required(
      await stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: KNOWLEDGE_BASE_ASSET_KIND,
        name: KB
      })
    );
    const principal = await stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      name: WORKFLOW,
      displayLabel: "Nightly import"
    });
    await stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action: "knowledge_base.write",
      effect: "allow",
      scopeKind: "asset",
      scopeId: kb.id,
      grantedBy: asUserId(LEGACY_LIST_GRANTOR)
    });
    const parsed = parseWorkflowManifest({
      id: WORKFLOW,
      name: "Nightly import",
      kind: "data",
      runAs: principal.name,
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        {
          id: "ingest",
          name: "Ingest",
          type: "operation",
          operation: `knowledge.${KB}.ingest`,
          input: { items: { value: [] } }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    });
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const definition = parsed.manifest;

    /** A running Workflow run of the import, as its engine would have started it. */
    async function startRun() {
      const now = new Date().toISOString();
      const runId = createPlatformId<"WorkflowRunId">("wfr");
      await stores.workflowRuns.createRun({
        id: runId,
        clientInstanceId,
        workflow: definition.id,
        definitionRevisionId: "kbw-1-fixture",
        limits: { durationMs: 3_600_000, stepRuns: 20_000, loopItems: 10_000 },
        mode: "live",
        trigger: "manual",
        principal,
        startedBy: { kind: "user", id: "publisher", label: "Publisher" },
        deadlineAt: new Date(Date.now() + 3_600_000).toISOString(),
        correlationId: "kbw-1",
        createdAt: now,
        definition,
        input: {}
      });
      await stores.workflowRuns.markRunRunning({ clientInstanceId, id: runId, startedAt: now });
      const actor: WorkflowRunPrincipal = {
        kind: "service",
        id: principal.id,
        displayLabel: principal.displayLabel,
        permissionRefs: principal.permissionRefs,
        permissions: principal.permissions,
        clientInstanceId,
        authSource: "workflow",
        scopes: [],
        workflowRunId: runId
      };
      let steps = 0;
      async function stepRun(stepId: string) {
        const id = createPlatformId<"WorkflowStepRunId">("wfs");
        const at = new Date().toISOString();
        await stores.workflowRuns.createStepRun({
          id,
          clientInstanceId,
          runId,
          stepId,
          stepType: "operation",
          key: `${stepId}-${++steps}`,
          createdAt: at
        });
        await stores.workflowRuns.markStepRunRunning({
          clientInstanceId,
          id,
          attempt: 1,
          startedAt: at
        });
        return id;
      }
      /** Ends a step run done with its datasets, as the engine does. */
      async function endStep(id: WorkflowStepRunId) {
        await stores.workflowRuns.endStepRun({
          clientInstanceId,
          id,
          status: "done",
          finishedAt: new Date().toISOString()
        });
        await stores.workflowRunDatasets.completeStep({ clientInstanceId, stepRunId: id });
      }
      /** Items written by a mapping step, as the dataset `ingest` reads. */
      async function dataset(rows: readonly unknown[]) {
        const id = await stepRun("map");
        const run = required(await stores.workflowRuns.readRun({ clientInstanceId, id: runId }));
        const step = required(await stores.workflowRuns.getStepRun({ clientInstanceId, id }));
        const reference = await world.datasets.write({
          run,
          stepRun: step,
          field: "items",
          rowSchema: { type: "object" },
          rows: (async function* () {
            yield* rows;
          })()
        });
        await endStep(id);
        return reference;
      }
      async function call(operation: "ingest" | "withdraw", input: unknown) {
        const stepRunId = await stepRun(operation);
        last = stepRunId;
        return runOperation(
          {
            operation: `knowledge.${KB}.${operation}`,
            effect: "changing",
            input,
            actor,
            origin: { kind: "workflow", workflowRunId: runId, stepRunId },
            correlationId: "kbw-1",
            idempotencyKey: stepRunId
          },
          instance.execution.operationCalls.deps
        );
      }
      async function end(status: "done" | "failed") {
        await stores.workflowRuns.endRun({
          clientInstanceId,
          id: runId,
          status,
          finishedAt: new Date().toISOString()
        });
      }
      let last: WorkflowStepRunId | undefined;
      return { runId, dataset, call, end, endStep, lastStep: () => required(last) };
    }

    /** Runs the source jobs until the ingest Operation Run ends, and answers its output. */
    async function settle(operationRunId: string) {
      return eventually(async () => {
        await world.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
        await world.worker.runDue();
        const run = await stores.operationRuns.get({ clientInstanceId, id: operationRunId });
        expect(run?.status, JSON.stringify(run?.error)).toBe("done");
        return required(run);
      }, 180_000);
    }
    /** Runs the source jobs until every complete pass of the source has been decided. */
    async function settlePasses() {
      await eventually(async () => {
        await world.platform`update platform_jobs set run_after = now() where status = 'queued' and kind like 'knowledge_base.%'`;
        await world.worker.runDue();
        const open =
          await world.sql`select id from catalyst_kb.sync_runs where source_id=${SOURCE} and pass_state in ('awaiting_run')`;
        expect(open).toEqual([]);
      }, 180_000);
    }
    async function states() {
      const rows =
        await world.sql`select state, count(*)::int as n from catalyst_kb.source_items where source_id=${SOURCE} group by state order by state`;
      return Object.fromEntries(rows.map((row) => [String(row.state), Number(row.n)]));
    }
    return { ...world, kb, principal, startRun, settle, settlePasses, states };
  }

  function operationRunOf(outcome: Awaited<ReturnType<typeof runOperation>>) {
    expect(outcome.result.status, JSON.stringify(outcome.result)).toBe("running");
    return String(outcome.run.id);
  }

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
