import { describe, expect, it } from "vitest";
import { createClientInstanceKnowledgeWorker } from "@work-shape/catalyst-client-assembly";
import { createPlatformId, operationWakeKey } from "@work-shape/catalyst-core";
import { connectionConfigSchema } from "@work-shape/catalyst-config-schema";
import { parseWorkflowManifest } from "@work-shape/catalyst-workflows";
import { clientInstanceId } from "./support/data-store-instance";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { eventually, required } from "./support/assertions";

// Both terminal outcomes must wake an asynchronous Workflow waiter exactly once,
// from the production knowledge-worker assembly on its independent pool.
describe("Knowledge Base completion from the knowledge worker", () => {
  const { setup } = useKnowledgeSync();

  it.each(["failed", "done"] as const)(
    "ends a %s sync and queues the waiting step once",
    async (outcome) => {
      const world = await setup();
      const started = await world.instance.api.call("knowledge_bases.sync", {
        params: { knowledgeBase: "sync-test" },
        payload: { source: "source", mode: "full" },
        headers: { "idempotency-key": "knowledge-worker-wake" }
      });
      expect(started.statusCode, started.body).toBe(202);
      const [sync] = await world.sql`select operation_run_id from catalyst_kb.sync_runs`;
      const operation = required(
        await world.instance.stores.operationRuns.get({
          clientInstanceId,
          id: String(required(sync).operation_run_id)
        })
      );
      expect(operation.status).toBe("running");
      const stores = world.instance.stores;
      const principal = await stores.apiAccess.createServicePrincipal({
        clientInstanceId,
        name: "wake-observer",
        displayLabel: "Wake observer"
      });
      const parsed = parseWorkflowManifest({
        id: "wake-observer",
        name: "Wait for source",
        runAs: principal.name,
        inputs: { type: "object" },
        outputs: { type: "object" },
        steps: [
          { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
          {
            id: "sync",
            name: "Sync",
            type: "operation",
            operation: "knowledge.sync-test.sync",
            input: { source: { value: "source" }, mode: { value: "full" } }
          },
          { id: "result", name: "Result", type: "output", input: {} }
        ]
      });
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
      const definition = parsed.manifest;
      const now = new Date().toISOString();
      const runId = createPlatformId<"WorkflowRunId">("wfr");
      const stepId = createPlatformId<"WorkflowStepRunId">("wfs");
      await stores.workflowRuns.createRun({
        id: runId,
        clientInstanceId,
        workflow: definition.id,
        definitionRevisionId: "wake-fixture",
        mode: "live",
        trigger: "manual",
        principal,
        startedBy: operation.actor,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
        correlationId: "knowledge-worker-wake",
        createdAt: now,
        definition,
        input: {}
      });
      await stores.workflowRuns.markRunRunning({ clientInstanceId, id: runId, startedAt: now });
      await stores.workflowRuns.createStepRun({
        id: stepId,
        clientInstanceId,
        runId,
        stepId: "sync",
        stepType: "operation",
        key: "sync",
        createdAt: now
      });
      await stores.workflowRuns.markStepRunRunning({
        clientInstanceId,
        id: stepId,
        attempt: 1,
        startedAt: now
      });
      expect(
        await stores.workflowRuns.waitForOperation({
          clientInstanceId,
          id: stepId,
          operationRunId: operation.id
        })
      ).toBe(true);
      const wakeKey = operationWakeKey(stepId);
      expect(
        await world.platform`select id from platform_jobs where dedupe_key = ${wakeKey}`
      ).toEqual([]);

      if (outcome === "done") {
        const connection = required(
          await stores.configAssets.getConfigAsset({
            clientInstanceId,
            kind: "connection",
            name: "fixture"
          })
        );
        // The shared source-engine fixture bypasses the Connection opener and holds
        // only a stub config. The production assembly needs a complete Connection.
        const config = {
          name: "fixture",
          displayName: "Fixture",
          connectorType: "fixture",
          ownerPrincipalId: principal.id,
          authScheme: "none",
          credentialMode: "shared",
          enabled: true,
          origin: "runtime",
          settings: {},
          operations: []
        };
        connectionConfigSchema.parse(config);
        await stores.configAssets.applyConfigAssetMutations({
          clientInstanceId,
          baseRevisions: { "connection:fixture": connection.revision },
          mutations: [
            {
              type: "upsert",
              kind: "connection",
              name: "fixture",
              config
            }
          ]
        });
      }

      const worker = await createClientInstanceKnowledgeWorker({
        config: {
          ...world.instance.execution.config,
          modules: { ...world.instance.execution.config.modules, connections: { enabled: true } },
          egress: {
            allow: [
              { protocol: "https", host: "93.184.216.34", port: 443, network: "public", cidrs: [] }
            ]
          }
        },
        // A public literal target needs no DNS; the empty fixture source makes no network calls.
        // No connector in the failure case deliberately leaves the source unavailable.
        connectorTypes:
          outcome === "failed"
            ? []
            : [
                {
                  ...world.connectorType,
                  authSchemes: ["none"],
                  target: () => ({ protocol: "https", host: "93.184.216.34", port: 443 }),
                  documentSource: {
                    ...world.capability,
                    list: async () => ({ items: [] }),
                    changes: async () => ({ kind: "not_offered" })
                  }
                }
              ],
        env: { ...world.instance.execution.env, KNOWLEDGE_WORKER_POOL_SIZE: "2" },
        tools: [],
        capabilities: [],
        knowledgeWorker: "separate"
      });
      try {
        await eventually(async () => {
          await worker.worker.runDue();
          const ended = await stores.operationRuns.get({ clientInstanceId, id: operation.id });
          expect(ended?.status, JSON.stringify(ended?.error)).toBe(outcome);
        });
        expect(
          await world.platform`select status from platform_jobs where dedupe_key = ${wakeKey}`
        ).toEqual([{ status: "queued" }]);
        // A later pass cannot emit a second wake for a terminal sync.
        await worker.worker.runDue();
        expect(
          await world.platform`select status from platform_jobs where dedupe_key = ${wakeKey}`
        ).toEqual([{ status: "queued" }]);
      } finally {
        await worker.close();
      }
    }
  );
});
