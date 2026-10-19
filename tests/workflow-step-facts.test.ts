import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";
import { assetSchema } from "@work-shape/catalyst-api-contract";
import type { JsonObject } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { operationDefinition } from "./support/publish-narrative";
import { readyWorkflows } from "./support/workflow-runs";
import type { WorkflowFixture } from "./support/workflow-instance";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const address = { kind: "workflow", name: "notify-clients" };
const ready = (options: Parameters<typeof readyWorkflows>[1] = {}) =>
  readyWorkflows(
    (fixture) => {
      open = fixture;
    },
    { definitions: "assets", ...options }
  );

/** Synthetic catalog records let the read contract cover every source without running one. */
async function store(
  t: WorkflowFixture,
  kind: string,
  name: string,
  config: JsonObject,
  published = false
) {
  await applyAtCurrentRevisions(t.stores.configAssets, {
    clientInstanceId,
    mutations: [
      { type: "upsert", kind, name, config, ...(kind === "workflow" ? { draft: true } : {}) }
    ]
  });
  const record = await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind, name });
  if (!record) throw new Error("Fixture asset was not stored");
  if (published)
    await t.stores.configAssets.publishConfigAssetRevision({
      clientInstanceId,
      kind,
      name,
      assetId: record.id,
      revision: record.revision,
      revisionId: record.activeRevisionId
    });
  return record;
}
const read = async (t: WorkflowFixture, userId = t.root.id, revision?: string) =>
  assetSchema.parse(
    (
      await t.expectOk(userId, "assets.get", {
        params: address,
        ...(revision ? { query: { revision } } : {})
      })
    ).json()
  );

function definition(steps: JsonObject[], tools: string[] = []): JsonObject {
  return {
    id: address.name,
    name: "Notify clients",
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    tools,
    steps: [
      { id: "start", type: "trigger", name: "Start", triggers: [{ kind: "manual" }] },
      ...steps,
      { id: "result", type: "output", name: "Result", input: {} }
    ]
  };
}

const op = (id: string, operation: string): JsonObject => ({
  id,
  type: "operation",
  name: id,
  operation,
  input: {}
});

describe("WF-PANEL-1a facts of the Workflow revision read", () => {
  it("resolves real Connection descriptors, effects and service, outside the strict manifest", async () => {
    const t = await ready();
    await t.seed("crm", { displayName: "Exampledata", service: "exampledata" });
    await store(t, "workflow", address.name, {
      name: address.name,
      manifest: definition([op("read", "connection.crm.echo")], ["connection.crm.echo"])
    });
    const asset = await read(t);
    expect(asset.stepFacts?.read).toMatchObject({
      effect: "reading",
      source: { kind: "connection", title: "Exampledata", service: "exampledata" },
      description: "Returns its input.",
      available: true,
      inputSchema: { type: "object", properties: { text: { type: "string", maxLength: 40 } } },
      outputSchema: { type: "object" }
    });
    expect(asset.stepFacts?.start?.tools).toEqual([
      expect.objectContaining({
        name: "connection.crm.echo",
        title: "echo",
        effect: "reading",
        source: { kind: "connection", title: "Exampledata", service: "exampledata" }
      })
    ]);
    expect(JSON.stringify(asset.config)).not.toContain('"effect"');
    expect(JSON.stringify(asset.config)).not.toContain('"service"');
  });

  it("marks a configured but disabled Connection operation unavailable", async () => {
    const t = await ready();
    await t.seed("disabled", {
      operations: [{ name: "echo", effect: "reading", enabled: false, exposure: ["workflow"] }]
    });
    await store(t, "workflow", address.name, {
      name: address.name,
      manifest: definition([op("read", "connection.disabled.echo")])
    });
    expect((await read(t)).stepFacts?.read).toMatchObject({
      available: false,
      source: { kind: "connection", title: "Connection disabled" }
    });
  });

  it("answers only source kind when the Workflow reader cannot read its source", async () => {
    const t = await ready();
    await store(
      t,
      "workflow",
      address.name,
      {
        name: address.name,
        manifest: definition([op("read", "connection.crm.echo")], ["connection.crm.echo"])
      },
      true
    );
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.read");
    const asset = await read(t, t.kai.id, "published");
    expect(asset.stepFacts?.read).toEqual({ source: { kind: "connection" } });
    expect(asset.stepFacts?.start?.tools).toEqual([
      { name: "connection.crm.echo", source: { kind: "connection" } }
    ]);
  });

  it("names Data Stores, Knowledge Bases and Workflow operations, and marks unknown operations", async () => {
    const t = await ready();
    await store(t, "data_store", "findings", { title: "Findings" });
    await store(t, "knowledge_base", "files", { title: "Company files" });
    await store(
      t,
      "workflow",
      "child",
      { name: "child", manifest: { ...definition([]), id: "child", name: "Child workflow" } },
      true
    );
    const definitions = new Map(
      ["data_store.findings.query", "knowledge.files.search", "workflow.child.start"].map(
        (name) => [
          name,
          {
            ...operationDefinition(name, "reading"),
            title: "Read records",
            inputSchema: z.object({ text: z.string() })
          }
        ]
      )
    );
    t.operationCalls.registry.addSource({
      resolve: async (name) => definitions.get(name),
      list: async () => ({ operations: [], truncated: [] })
    });
    await store(t, "workflow", address.name, {
      name: address.name,
      manifest: definition([
        op("store", "data_store.findings.query"),
        op("kb", "knowledge.files.search"),
        op("kb_tool", "knowledge.search"),
        op("start_child", "workflow.child.start"),
        op("missing", "connection.crm.missing"),
        op("removed", "connection.removed.missing"),
        { id: "child", type: "workflow", workflow: "child", name: "Child", input: {} }
      ])
    });
    const { stepFacts } = await read(t);
    expect(stepFacts?.store).toMatchObject({
      source: { kind: "data_store", title: "Findings" },
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      available: true
    });
    expect(stepFacts?.kb?.source).toEqual({ kind: "knowledge_base", title: "Company files" });
    // The one search tool of every Knowledge Base is an operation, and names none of them.
    expect(stepFacts?.kb_tool?.source).toEqual({ kind: "other" });
    expect(stepFacts?.start_child?.source).toEqual({ kind: "workflow", title: "Child workflow" });
    expect(stepFacts?.child).toMatchObject({ title: "Child workflow", published: true });
    expect(stepFacts?.removed).toEqual({ source: { kind: "connection" }, available: false });
    expect(stepFacts?.missing).toEqual({
      source: { kind: "connection", title: "Connection crm" },
      available: false
    });
  });

  it("uses the revision read for facts, and the published schedule across daylight saving", async () => {
    let moment = new Date("2026-10-24T06:00:00Z");
    const t = await ready({ now: () => moment, timeZone: "UTC" });
    const scheduled: JsonObject = {
      ...definition([]),
      inputs: { type: "object" },
      steps: [
        {
          id: "start",
          type: "trigger",
          name: "Start",
          triggers: [{ kind: "schedule", cron: "0 8 * * *", timeZone: "Europe/Berlin" }]
        },
        { id: "result", type: "output", name: "Result", input: {} }
      ]
    };
    await store(t, "workflow", address.name, { name: address.name, manifest: scheduled }, true);
    expect((await read(t)).stepFacts?.start).toMatchObject({
      timeZone: "Europe/Berlin",
      nextDueAt: "2026-10-25T07:00:00.000Z"
    });
    moment = new Date("2026-10-23T06:00:00Z");
    expect((await read(t)).stepFacts?.start?.nextDueAt).toBe("2026-10-24T06:00:00.000Z");
    await store(t, "workflow", address.name, {
      name: address.name,
      manifest: definition([op("draft_only", "connection.crm.echo")])
    });
    expect((await read(t, t.root.id, "published")).stepFacts?.draft_only).toBeUndefined();
    expect((await read(t)).stepFacts?.draft_only?.available).toBe(true);
    // The draft starts by hand; the zone shown is still that of the published schedule.
    expect((await read(t)).stepFacts?.start).toMatchObject({
      timeZone: "Europe/Berlin",
      nextDueAt: "2026-10-24T06:00:00.000Z"
    });
  });

  it("names no model the AI step does not declare", async () => {
    const t = await ready();
    await store(t, "workflow", address.name, {
      name: address.name,
      manifest: definition(
        [
          {
            id: "ai",
            type: "agent",
            name: "Write summary",
            instructions: "steps/ai.md",
            input: {},
            inputSchema: { type: "object" },
            outputSchema: { type: "object" }
          }
        ],
        ["connection.crm.echo"]
      )
    });
    expect((await read(t)).stepFacts?.ai).toEqual({});
  });

  it("keeps step paths on list reasons and validate/put issues", async () => {
    const t = await ready();
    const broken = definition([op("bad", "assets.get")]);
    await store(t, "workflow", address.name, { name: address.name, manifest: broken }, true);
    const listed = await t.expectOk(t.root.id, "workflows.list");
    expect(
      listed.json().items.find((item: { id: string }) => item.id === address.name)?.reasons
    ).toContainEqual(expect.objectContaining({ path: "steps.bad.operation" }));
    const validated = await t.expectOk(t.root.id, "assets.validate", {
      params: { kind: "workflow" },
      payload: { config: { name: address.name, manifest: broken } }
    });
    expect(validated.json().issues).toContainEqual(
      expect.objectContaining({ path: ["steps.bad.operation"] })
    );
    const refused = await t.expectRefused(
      t.root.id,
      "assets.put",
      {
        params: address,
        payload: { expectedRevision: 1, config: { name: address.name, manifest: broken } }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({
      issues: [expect.objectContaining({ path: "steps.bad.operation" })]
    });
  });
});
