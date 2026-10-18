import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ASSET_KIND,
  WORKFLOW_RUN_JOB_KINDS,
  type JsonObject
} from "@work-shape/catalyst-core";
import { workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import { clientInstanceId } from "./support/access-instance";
import { discoveryNames, seedDiscoveryAssets } from "./support/discovery-assets";

const names = discoveryNames("paging", 501);
const listedSchema = z.object({
  items: z.array(z.object({ id: z.string() })),
  nextCursor: z.string().optional()
});

describe("published Workflow discovery beyond the former 500 total", () => {
  let t: WorkflowFixture;
  beforeAll(async () => {
    t = await workflowFixture({
      definitions: "assets",
      now: () => new Date("2030-01-01T00:00:00.000Z")
    });
    await seedDiscoveryAssets(
      t.stores.configAssets,
      WORKFLOW_ASSET_KIND,
      names,
      (name): JsonObject => ({
        name,
        manifest: {
          id: name,
          name,
          runAs: "workflow-runner",
          inputs: { type: "object" },
          outputs: { type: "object" },
          steps: [
            {
              id: "start",
              name: "Start",
              type: "trigger",
              triggers: [{ kind: "manual" }, { kind: "schedule", cron: "0 * * * *" }]
            },
            { id: "result", name: "Result", type: "output", input: {} }
          ]
        }
      })
    );
  });
  afterAll(async () => {
    await t?.instance.close();
  });

  it("reaches all 501 published Workflows through bounded API cursor pages", async () => {
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const response = await t.expectOk(t.root.id, "workflows.list", {
        query: { limit: 200, ...(cursor ? { cursor } : {}) }
      });
      const page = listedSchema.parse(response.json());
      expect(page.items.length).toBeLessThanOrEqual(200);
      found.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(found).toEqual(names);
    // A reader of only the last Workflow must cross hidden pages without receiving hidden keys.
    const last = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: names[500] ?? "missing"
    });
    if (!last) throw new Error("Last Workflow is missing");
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "workflow.read",
      effect: "allow",
      scopeKind: "asset",
      scopeId: last.id,
      grantedBy: t.root.id
    });
    const visible = listedSchema.parse(
      (await t.expectOk(t.kai.id, "workflows.list", { query: { limit: 200 } })).json()
    );
    expect(visible).toEqual({ items: [{ id: last.name }] });
    expect(
      (await t.call(t.root.id, "workflows.list", { query: { cursor: "invalid" } })).statusCode
    ).toBe(422);
  });

  it("discovers the agent start operation of every one of 501 Workflows", async () => {
    const listed = await t.operationCalls.registry.list();
    const starts = listed.operations
      .map((entry) => entry.name)
      .filter((name) => name.startsWith("workflow.paging-"));
    expect(starts.sort()).toEqual(names.map((name) => `workflow.${name}.start`));
  });

  it("repairs schedules for all 501 through durable successors after the first page", async () => {
    await t.workflows.planSchedules();
    const pending = await t.stores.jobs.listOverview({
      clientInstanceId,
      filters: { kind: WORKFLOW_RUN_JOB_KINDS.repairSchedules, statuses: ["queued"] }
    });
    expect(pending).toHaveLength(1);
    // A newly constructed worker reads the cursor from persistence, without the startup call stack.
    const worker = t.worker(
      t.workflows.jobHandlers.filter(
        (handler) => handler.kind.kind === WORKFLOW_RUN_JOB_KINDS.repairSchedules
      )
    );
    await worker.runDue();
    await worker.runDue();
    const scheduled = await t.stores.jobs.listOverview({
      clientInstanceId,
      filters: { kind: WORKFLOW_RUN_JOB_KINDS.fireSchedule, statuses: ["queued"] },
      page: { limit: 502 }
    });
    expect(scheduled.map((job) => job.subject).sort()).toEqual(names);
  });
});

it("refuses Workflow discovery whose source repeats its exclusive cursor", async () => {
  let reads = 0;
  const list = vi.fn(async () => {
    if (++reads > 2) throw new Error("Discovery read past a repeated cursor");
    return Array.from({ length: 200 }, (_, index) => ({
      id: `repeat-${String(index).padStart(3, "0")}`,
      name: "Repeated"
    }));
  });
  const t = await workflowFixture({ definitions: { read: async () => undefined, list } });
  try {
    await expect(t.operationCalls.registry.list()).rejects.toThrow(
      "Workflow definition discovery cursor did not advance"
    );
    expect(list).toHaveBeenCalledTimes(2);
  } finally {
    await t.instance.close();
  }
});
