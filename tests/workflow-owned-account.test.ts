import { prepareSyncPrefix, syncAssetsAtPrefix } from "./support/asset-operations";
import { z } from "zod";
import { workflowRunPrincipal } from "@work-shape/catalyst-workflows";
import { afterEach, describe, expect, it } from "vitest";
import { type OperationDefinition, type WorkflowManifest } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { runSchema, workflowFixture, type WorkflowFixture } from "./support/workflow-instance";

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});
const address = { kind: "workflow", name: "own-account" };
const manifest = (read = true): WorkflowManifest => ({
  id: address.name,
  name: "Read customers",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
    ...(read
      ? [
          {
            id: "read",
            name: "Read CRM",
            type: "operation" as const,
            operation: "connection.crm.echo",
            input: { text: { value: "customers" } }
          }
        ]
      : []),
    { id: "result", name: "Result", type: "output", input: {} }
  ]
});
async function ready() {
  const t = await workflowFixture({ definitions: "assets" });
  open = t;
  await t.seedCrm();
  t.setBehaviour(async () => ({ value: "customers" }));
  for (const action of ["workflow.read", "workflow.write", "workflow.publish", "workflow.use"])
    await t.allow({ kind: "user", id: t.kai.id }, action);
  return t;
}
async function save(
  t: WorkflowFixture,
  definition = manifest(),
  expectedRevision: number | null = null
) {
  return t.expectOk(t.kai.id, "assets.put", {
    params: address,
    payload: { config: { name: address.name, manifest: definition }, expectedRevision }
  });
}
function publish(t: WorkflowFixture, revision = 1) {
  return t.call(t.kai.id, "assets.publish", { params: address, payload: { revision } });
}
async function owned(t: WorkflowFixture) {
  const assetId = await t.assetId("workflow", address.name);
  return t.stores.apiAccess.findServicePrincipalByOwner({
    clientInstanceId,
    owner: { kind: "workflow", assetId }
  });
}
async function grants(t: WorkflowFixture, id: string) {
  return t.stores.access.listGrants({
    clientInstanceId,
    holderKind: "service_principal",
    holderId: id
  });
}

describe("the Workflow's own account (LIVE-1)", () => {
  it("a member publishes and runs without creating an account; republish removes unneeded grants", async () => {
    const t = await ready();
    const crm = await t.assetId("connection", "crm");
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await save(t);
    expect(await owned(t)).toBeUndefined();
    const draftView = await t.expectOk(t.kai.id, "assets.get", { params: address });
    expect(draftView.json()).toMatchObject({ runsAs: manifest().name });
    expect((await publish(t)).statusCode).toBe(200);
    const principal = await owned(t);
    expect(principal).toBeDefined();
    if (!principal) throw new Error("missing owned account");
    expect(await grants(t, principal.id)).toMatchObject([
      { action: "connection.use", effect: "allow", scopeKind: "asset", scopeId: crm }
    ]);
    expect(await grants(t, principal.id)).toHaveLength(1);
    const accounts = await t.expectOk(t.root.id, "service_principals.list");
    expect(JSON.stringify(accounts.json())).not.toContain(principal.id);
    const response = await t.expectOk(t.kai.id, "workflows.start", {
      params: { workflow: address.name },
      payload: { input: {} }
    });
    const run = runSchema.parse(response.json());
    expect(run.principal.id).toBe(principal.id);
    expect((await t.finish(run.id)).status).toBe("done");
    await save(t, manifest(false), 1);
    expect((await publish(t, 2)).statusCode).toBe(200);
    expect((await owned(t))?.id).toBe(principal.id);
    expect(await grants(t, principal.id)).toEqual([]);
    await save(t, manifest(), 2);
    expect((await publish(t, 3)).statusCode).toBe(200);
    expect(await grants(t, principal.id)).toHaveLength(1);
  });

  it("refuses a publisher who lacks the transferable right and creates nothing", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "connection.read");
    await save(t);
    const refused = await publish(t);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { details: { action: "connection.use" } } });
    expect(await owned(t)).toBeUndefined();
    expect(
      (await t.stores.configAssets.getConfigAsset({ clientInstanceId, ...address }))
        ?.publishedRevision
    ).toBeUndefined();
  });

  it("refuses an administration right on the owned account even when the publisher holds it", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "connection.read");
    await t.allow({ kind: "user", id: t.kai.id }, "connection.write");
    const base = await t.operationCalls.registry.resolve("connection.crm.echo");
    if (!base) throw new Error("missing CRM operation");
    const { authorize: _authorize, ...definition } = base;
    const operation: OperationDefinition = {
      ...definition,
      name: "test.manage_crm",
      action: "connection.write"
    };
    t.operationCalls.registry.addSource({
      resolve: (name) => Promise.resolve(name === operation.name ? operation : undefined),
      list: () => Promise.resolve({ operations: [operation], truncated: [] })
    });
    const draft = manifest();
    draft.steps = draft.steps.map((step) =>
      step.type === "operation" ? { ...step, operation: operation.name } : step
    );
    await save(t, draft);
    const refused = await publish(t);
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({
      error: {
        details: { reason: "action_not_grantable_to_principal", action: "connection.write" }
      }
    });
    expect(await owned(t)).toBeUndefined();
  });

  it("does not lend an owned account's run data without its source rights", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await save(t);
    expect((await publish(t)).statusCode).toBe(200);
    const assetId = await t.assetId("workflow", address.name);
    const manager = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Dataset manager",
      roles: ["user"],
      permissions: ["users.manage"]
    });
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: manager.id,
      action: "workflow.read_run_data",
      effect: "allow",
      scopeKind: "asset",
      scopeId: assetId,
      grantedBy: t.root.id
    });
    const grant = {
      payload: {
        holderKind: "user",
        holderId: t.lena.id,
        action: "workflow.read_run_data",
        effect: "allow",
        scopeKind: "asset",
        scopeId: assetId
      }
    };
    const refused = await t.call(manager.id, "permissions.grant", grant);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { details: { action: "connection.use" } } });
    await t.allow({ kind: "user", id: manager.id }, "connection.use");
    await t.expectOk(manager.id, "permissions.grant", grant);
    await t.expectOk(t.kai.id, "workflows.unpublish", { params: { workflow: address.name } });
    const afterWithdrawal = await t.call(manager.id, "permissions.grant", {
      payload: { ...grant.payload, holderId: t.kai.id }
    });
    expect(afterWithdrawal.statusCode).toBe(403);
    expect(afterWithdrawal.json()).toMatchObject({
      error: { details: { action: "workflow.read_run_data" } }
    });
  });

  it("unpublishes without deleting the datasets of previous runs", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await save(t);
    expect((await publish(t)).statusCode).toBe(200);
    const started = runSchema.parse(
      (
        await t.expectOk(t.kai.id, "workflows.start", {
          params: { workflow: address.name },
          payload: { input: {} }
        })
      ).json()
    );
    const run = await t.stores.workflowRuns.readRun({ clientInstanceId, id: started.id });
    if (!run) throw new Error("missing run");
    const [step] = await t.stores.workflowRuns.listStepRuns({ clientInstanceId, runId: run.id });
    if (!step) throw new Error("missing step");
    await t.stores.workflowRuns.markStepRunRunning({
      clientInstanceId,
      id: step.id,
      attempt: 1,
      startedAt: new Date().toISOString()
    });
    const dataset = await t.stores.workflowRunDatasets.create({
      clientInstanceId,
      id: "historic-rows",
      runId: run.id,
      stepRunId: step.id,
      field: "rows",
      rowSchema: { type: "object" }
    });
    await t.stores.workflowRuns.endStepRun({
      clientInstanceId,
      id: step.id,
      status: "done",
      finishedAt: new Date().toISOString()
    });
    await t.stores.workflowRunDatasets.completeStep({ clientInstanceId, stepRunId: step.id });
    await t.stores.workflowRuns.endRun({
      clientInstanceId,
      id: run.id,
      status: "done",
      finishedAt: new Date().toISOString()
    });
    const before = await t.stores.workflowRunDatasets.get({ clientInstanceId, id: dataset.id });
    expect(before?.state).toBe("complete");
    await t.expectOk(t.kai.id, "workflows.unpublish", { params: { workflow: address.name } });
    expect(await t.stores.workflowRunDatasets.get({ clientInstanceId, id: dataset.id })).toEqual(
      before
    );
  });

  it("never shares an asset-owned account through explicit runAs", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await save(t);
    expect((await publish(t)).statusCode).toBe(200);
    const principal = await owned(t);
    if (!principal) throw new Error("missing principal");
    const borrowed = { ...manifest(), id: "borrowed-account", runAs: principal.name };
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: "workflow", name: borrowed.id },
      payload: { config: { name: borrowed.id, manifest: borrowed }, expectedRevision: null }
    });
    const refused = await t.call(t.root.id, "assets.publish", {
      params: { kind: "workflow", name: borrowed.id },
      payload: { revision: 1 }
    });
    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "run_as_owned" } } });
    expect(
      await workflowRunPrincipal(
        t.stores.apiAccess,
        clientInstanceId,
        borrowed,
        t.stores.configAssets
      )
    ).toBeUndefined();
    const test = await t.call(t.root.id, "workflows.test", {
      params: { workflow: borrowed.id },
      payload: { input: {} }
    });
    expect(test.statusCode).toBe(422);
  });

  it("switches from an owned account to the explicit shared account and removes the old grants", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await save(t);
    expect((await publish(t)).statusCode).toBe(200);
    const principal = await owned(t);
    if (!principal) throw new Error("missing principal");
    await save(t, { ...manifest(), runAs: t.principal.name }, 1);
    expect((await publish(t, 2)).statusCode).toBe(200);
    expect(await owned(t)).toBeUndefined();
    expect(await grants(t, principal.id)).toEqual([]);
  });

  it.each(["workflows.unpublish", "assets.delete", "assets.sync"] as const)(
    "%s removes the principal and all its grants",
    async (operation) => {
      const t = await ready();
      if (operation === "assets.sync") await prepareSyncPrefix(t, "own-");
      await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
      await save(t);
      expect((await publish(t)).statusCode).toBe(200);
      const principal = await owned(t);
      if (!principal) throw new Error("missing owned account");
      if (operation === "assets.sync") {
        const response = await syncAssetsAtPrefix(t, t.root.id, "own-", [
          { type: "delete", ...address, expectedRevision: 1 }
        ]);
        expect(response.statusCode, response.body).toBe(200);
      } else
        await t.expectOk(
          t.root.id,
          operation,
          operation === "assets.delete"
            ? { params: address, payload: { expectedRevision: 1 } }
            : { params: { workflow: address.name } }
        );
      expect(await owned(t)).toBeUndefined();
      expect(await grants(t, principal.id)).toEqual([]);
      expect(
        (
          await t.call(t.kai.id, "workflows.start", {
            params: { workflow: address.name },
            payload: { input: {} }
          })
        ).statusCode
      ).toBe(404);
    }
  );

  it("tests an unpublished draft under derived grants and refuses a dynamic target outside them", async () => {
    const t = await ready();
    await t.allow({ kind: "user", id: t.kai.id }, "connection.use");
    await save(t);
    const response = await t.expectOk(t.kai.id, "workflows.test", {
      params: { workflow: address.name },
      payload: { input: {} }
    });
    expect((await t.finish(runSchema.parse(response.json()).id)).status).toBe("done");
    expect(await owned(t)).toBeUndefined();
    // A resource chosen from a reference cannot receive a derived asset grant. The tester
    // holds CRM use, so only the draft ceiling can refuse this actual dispatch.
    const base = await t.operationCalls.registry.resolve("connection.crm.echo");
    if (!base) throw new Error("missing CRM operation");
    const { authorize: _authorize, ...baseDefinition } = base;
    const dynamicOperation: OperationDefinition = {
      ...baseDefinition,
      name: "test.dynamic_read",
      action: "connection.use",
      inputSchema: z.object({ connection: z.string() }).loose(),
      execute: async () => ({ value: "customers" }),
      resource: (input: unknown) => {
        const { connection } = z.object({ connection: z.string() }).parse(input);
        return {
          kind: "connection",
          id: connection,
          name: connection,
          assetId: connection === "crm" ? base.resource({ text: "customers" })?.assetId : undefined
        };
      }
    };
    t.operationCalls.registry.addSource({
      resolve: (name) =>
        Promise.resolve(name === dynamicOperation.name ? dynamicOperation : undefined),
      list: () => Promise.resolve({ operations: [dynamicOperation], truncated: [] })
    });
    const draft = manifest();
    draft.inputs = {
      type: "object",
      properties: { connection: { type: "string" } },
      required: ["connection"]
    };
    draft.steps = draft.steps.map((step, index) =>
      index === 1
        ? {
            id: "read",
            name: "Dynamic read",
            type: "operation",
            operation: "test.dynamic_read",
            input: {
              connection: { ref: { step: "start", path: "input.connection" } },
              operation: { value: "echo" },
              input: { value: { text: "customers" } }
            }
          }
        : step
    );
    await save(t, draft, 1);
    const dynamic = await t.expectOk(t.kai.id, "workflows.test", {
      params: { workflow: address.name },
      payload: { input: { connection: "crm" } }
    });
    const ended = await t.finish(runSchema.parse(dynamic.json()).id);
    expect(ended.status).toBe("failed");
    expect(ended.error, JSON.stringify(ended)).toMatchObject({ action: "connection.use" });
  });
});
