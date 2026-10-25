import { expect } from "vitest";
import {
  asUserId,
  createPlatformId,
  KNOWLEDGE_BASE_ASSET_KIND,
  LEGACY_LIST_GRANTOR,
  WORKFLOW_ASSET_KIND,
  type JsonObject,
  type WorkflowRunPrincipal,
  type WorkflowStepRunId
} from "@work-shape/catalyst-core";
import postgres from "postgres";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./data-store-instance";
import { useKnowledgeSync } from "./knowledge-sync";
import { eventually, required } from "./assertions";
import { fileTestDatabaseUrl } from "./test-database";
import { getTestJobs } from "./test-instance";

// A Workflow that puts documents into the Knowledge Base `sync-test` through `ingest`, run by
// hand as its engine would: its account, its runs and their steps, and the source jobs.

export const KB = "sync-test";
export const WORKFLOW = "nightly-import";
/** The import's source: its key names the revision that created the Workflow (KBW-2c). */
export const SOURCE = `workflow:${WORKFLOW}@1`;

export const item = (n: number, version = "1") => ({
  itemId: `doc-${String(n).padStart(4, "0")}`,
  version,
  name: `doc-${String(n).padStart(4, "0")}.md`,
  path: `/import/doc-${n}.md`,
  text: `# Document ${n}\n\nContent of document number ${n}, marked zq${n}x.`
});

export function operationRunOf(outcome: Awaited<ReturnType<typeof runOperation>>) {
  expect(outcome.result.status, JSON.stringify(outcome.result)).toBe("running");
  return String(outcome.run.id);
}

/** Call inside a `describe`: it registers the cleanup of each test's world. */
export function useKnowledgeWorkflow(options: { firstPassStop?: number } = {}) {
  const { setup } = useKnowledgeSync(options);
  /** `developmentAuth` names the people a test signs in as, beside the default one. */
  async function world(developmentAuth?: unknown, workflows?: true) {
    const world = await setup(
      undefined,
      undefined,
      false,
      developmentAuth,
      undefined,
      "de",
      workflows
    );
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
    const grant = await stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: principal.id,
      action: "knowledge_base.ingest",
      effect: "allow",
      scopeKind: "asset",
      scopeId: kb.id,
      grantedBy: asUserId(LEGACY_LIST_GRANTOR)
    });
    const manifest: JsonObject = {
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
    };
    const parsed = parseWorkflowManifest(manifest);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const definition = parsed.manifest;
    const key = `${WORKFLOW_ASSET_KIND}:${WORKFLOW}`;
    /** The Workflow's asset, as a write in Studio leaves it; a run names its revision. */
    async function workflowAsset() {
      return stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: WORKFLOW
      });
    }
    /** Writes the Workflow's definition: the first write, or the one after a delete, creates it. */
    async function writeWorkflow() {
      const now = await workflowAsset();
      const written = await stores.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [key]: now?.revision ?? null },
        mutations: [
          {
            type: "upsert",
            kind: WORKFLOW_ASSET_KIND,
            name: WORKFLOW,
            config: { name: WORKFLOW, manifest }
          }
        ]
      });
      return required(written.revisions[key]);
    }
    await writeWorkflow();

    /** A running Workflow run of the import, as its engine would have started it. */
    async function startRun() {
      const now = new Date().toISOString();
      const runId = createPlatformId<"WorkflowRunId">("wfr");
      await stores.workflowRuns.createRun({
        id: runId,
        clientInstanceId,
        workflow: definition.id,
        definitionRevisionId: required(await workflowAsset()).activeRevisionId,
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
      async function call(
        operation: "ingest" | "withdraw" | "retry",
        input: unknown,
        knowledgeBase = KB
      ) {
        const stepRunId = await stepRun(operation);
        last = stepRunId;
        return runOperation(
          {
            operation: `knowledge.${knowledgeBase}.${operation}`,
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
    /**
     * Another published Knowledge Base the import may write to, with its own store: answers
     * its asset and a connection to that store, which the caller ends.
     */
    async function addKnowledgeBase(name: string, title: string) {
      for (const [verb, payload] of [
        [
          "assets.put",
          {
            config: { name, title, description: `${title} documents`, methods: ["keyword"] },
            expectedRevision: null
          }
        ],
        ["assets.publish", { revision: 1 }]
      ] as const) {
        const answer = await instance.api.call(verb, {
          params: { kind: KNOWLEDGE_BASE_ASSET_KIND, name },
          payload
        });
        expect(answer.statusCode, answer.body).toBe(200);
      }
      const record = await eventually(async () => {
        await getTestJobs(instance.api).runDue();
        const row = await stores.dataStores.findDataStoreByName({
          clientInstanceId,
          name: `knowledge-base:${name}`
        });
        expect(row?.status).toBe("ready");
        expect(row?.level).toBe(15);
        return required(row);
      });
      const asset = required(
        await stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: KNOWLEDGE_BASE_ASSET_KIND,
          name
        })
      );
      await stores.access.createGrant({
        clientInstanceId,
        holderKind: "service_principal",
        holderId: principal.id,
        action: "knowledge_base.ingest",
        effect: "allow",
        scopeKind: "asset",
        scopeId: asset.id,
        grantedBy: asUserId(LEGACY_LIST_GRANTOR)
      });
      const url = new URL(await fileTestDatabaseUrl());
      url.pathname = `/${record.location.database}`;
      return { kb: asset, sql: postgres(url.toString(), { max: 1, onnotice: () => undefined }) };
    }
    return {
      ...world,
      kb,
      addKnowledgeBase,
      principal,
      grant,
      startRun,
      settle,
      settlePasses,
      states,
      workflowAsset,
      writeWorkflow
    };
  }
  return { world };
}
