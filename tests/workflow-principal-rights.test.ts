import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { workflowPrincipalRightsSchema } from "@work-shape/catalyst-api-contract";
import type { WorkflowManifest } from "@work-shape/catalyst-core";
import { child, parent } from "./support/workflow-children";
import { workflowFixture, type WorkflowFixture } from "./support/workflow-instance";

// The publish screen's read of what the accounts of a parent and its child need, and the grant
// an administrator gives from it: one confirmed step through the ordinary grant write.

let open: WorkflowFixture | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

async function chain() {
  const t = await workflowFixture({ definitions: "assets" });
  open = t;
  const crm = await t.seedCrm();
  t.setBehaviour((_operation, input) =>
    Promise.resolve({ value: z.object({ text: z.string() }).parse(input).text })
  );
  await put(t, child());
  // The child publishes without `connection.use`: its step fails when it runs, not before.
  expect((await publish(t, "child")).statusCode).toBe(200);
  await put(t, parent());
  return { t, crm, childId: await t.assetId("workflow", "child") };
}

async function put(t: WorkflowFixture, manifest: WorkflowManifest) {
  await t.expectOk(t.root.id, "assets.put", {
    params: { kind: "workflow", name: manifest.id },
    payload: { expectedRevision: null, config: { name: manifest.id, manifest } }
  });
}

function publish(t: WorkflowFixture, workflow: string, userId = t.root.id) {
  return t.call(userId, "assets.publish", {
    params: { kind: "workflow", name: workflow },
    payload: { revision: 1 }
  });
}

async function rightsOf(t: WorkflowFixture, userId: string) {
  const response = await t.expectOk(userId, "workflows.principal_rights", {
    params: { workflow: "parent" }
  });
  return workflowPrincipalRightsSchema.parse(response.json());
}

/** Gives every right the screen offers, as the screen does: one grant write per right. */
async function grantOffered(t: WorkflowFixture, userId: string) {
  const answer = await rightsOf(t, userId);
  const offered = answer.workflows.flatMap((entry) =>
    entry.rights.flatMap((right) => (right.grant ? [{ ...right.grant, action: right.action }] : []))
  );
  return Promise.all(
    offered.map((grant) =>
      t.call(userId, "permissions.grant", {
        payload: {
          holderKind: "service_principal",
          holderId: grant.holderId,
          action: grant.action,
          effect: "allow",
          scopeKind: "asset",
          scopeId: grant.scopeId
        }
      })
    )
  );
}

describe("the rights the accounts of a Workflow publish need", () => {
  it("lists what the parent and its child lack, and an administrator gives it in one step so the publish passes", async () => {
    const { t, crm, childId } = await chain();
    expect((await publish(t, "parent", t.admin.id)).json()).toMatchObject({
      error: { details: { reason: "child_use_forbidden", workflow: "child" } }
    });
    const before = await rightsOf(t, t.admin.id);
    expect(before).toEqual({
      administers: true,
      hiddenWorkflows: 0,
      workflows: [
        {
          workflow: "parent",
          revision: "draft",
          runAs: "workflow-runner",
          account: { label: t.principal.displayLabel, status: "active" },
          rights: [
            {
              action: "workflow.use",
              asset: { kind: "workflow", name: "child" },
              steps: ["child"],
              neededFor: "publish",
              held: false,
              grant: { holderId: t.principal.id, scopeId: childId }
            }
          ]
        },
        {
          workflow: "child",
          revision: "published",
          runAs: "workflow-runner",
          account: { label: t.principal.displayLabel, status: "active" },
          rights: [
            {
              action: "connection.use",
              asset: { kind: "connection", name: "crm" },
              steps: ["read"],
              neededFor: "run",
              held: false,
              grant: { holderId: t.principal.id, scopeId: crm }
            }
          ]
        }
      ]
    });
    const written = await grantOffered(t, t.admin.id);
    expect(written.map((response) => response.statusCode)).toEqual([200, 200]);
    const after = await rightsOf(t, t.admin.id);
    expect(after.workflows.flatMap((entry) => entry.rights.map((right) => right.held))).toEqual([
      true,
      true
    ]);
    expect(after.workflows.flatMap((entry) => entry.rights.map((right) => right.grant))).toEqual([
      undefined,
      undefined
    ]);
    expect((await publish(t, "parent", t.admin.id)).statusCode).toBe(200);
    // Each grant is the ordinary write, with its one minimized audit event.
    const granted = await t.stores.audit.listAuditEvents({
      clientInstanceId: t.principal.clientInstanceId,
      type: "permission.granted",
      page: { limit: 100 }
    });
    expect(granted.map((event) => event.metadata)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ servicePrincipalId: t.principal.id, scopeId: childId }),
        expect.objectContaining({ servicePrincipalId: t.principal.id, scopeId: crm })
      ])
    );
  });

  it("shows a person who may publish but administers no account what is missing, and they cannot give it", async () => {
    const { t, childId } = await chain();
    for (const action of ["workflow.read", "workflow.write", "workflow.publish"])
      await t.allow({ kind: "user", id: t.kai.id }, action);
    const answer = await rightsOf(t, t.kai.id);
    expect(answer.administers).toBe(false);
    expect(answer.workflows.flatMap((entry) => entry.rights)).toEqual([
      expect.objectContaining({
        action: "workflow.use",
        held: false,
        refusal: "not_administrator"
      }),
      // The Connection is one this person may not read: named by its kind alone.
      {
        action: "connection.use",
        asset: { kind: "connection" },
        steps: ["read"],
        neededFor: "run",
        held: false,
        refusal: "not_visible"
      }
    ]);
    // No id of the account or of an asset reaches whoever cannot give the right.
    expect(JSON.stringify(answer)).not.toContain(t.principal.id);
    expect(JSON.stringify(answer)).not.toContain(childId);
    const refused = await t.call(t.kai.id, "permissions.grant", {
      payload: {
        holderKind: "service_principal",
        holderId: t.principal.id,
        action: "workflow.use",
        effect: "allow",
        scopeKind: "asset",
        scopeId: childId
      }
    });
    expect(refused.statusCode).toBe(403);
    expect((await publish(t, "parent", t.kai.id)).json()).toMatchObject({
      error: { details: { reason: "child_use_forbidden" } }
    });
    // Whoever may not publish the Workflow reads nothing of it.
    expect(
      (await t.call(t.lena.id, "workflows.principal_rights", { params: { workflow: "parent" } }))
        .statusCode
    ).toBe(403);
  });

  it("counts a child the publisher of only the parent may not read, and says nothing else of it", async () => {
    const { t, childId } = await chain();
    const parentId = await t.assetId("workflow", "parent");
    for (const action of ["workflow.read", "workflow.publish"])
      await t.grant(t.kai.id, action, { assetId: parentId });
    const childRead = await t.call(t.kai.id, "assets.get", {
      params: { kind: "workflow", name: "child" }
    });
    expect(childRead.statusCode).toBe(403);
    const answer = await rightsOf(t, t.kai.id);
    expect(answer).toEqual({
      administers: false,
      hiddenWorkflows: 1,
      workflows: [
        {
          workflow: "parent",
          revision: "draft",
          runAs: "workflow-runner",
          account: { label: t.principal.displayLabel, status: "active" },
          rights: [
            {
              action: "workflow.use",
              asset: { kind: "workflow" },
              steps: ["child"],
              neededFor: "publish",
              held: false,
              refusal: "not_visible"
            }
          ]
        }
      ]
    });
    // The child's name only as the parent's own step id, which the parent's reader sees anyway.
    const text = JSON.stringify(answer);
    for (const hidden of ['"name":"child"', '"workflow":"child"', "crm", "connection", childId])
      expect(text).not.toContain(hidden);
  });

  it("refuses a right on a resource the administrator may not read, at the grant as on the screen", async () => {
    const { t, crm, childId } = await chain();
    // The administrator holds connection.use by role, and is denied reading the Connection.
    await t.grant(t.admin.id, "connection.read", { assetId: crm }, "deny");
    expect(
      (await t.call(t.admin.id, "assets.get", { params: { kind: "connection", name: "crm" } }))
        .statusCode
    ).toBe(403);
    const answer = await rightsOf(t, t.admin.id);
    const [use, connection] = answer.workflows.flatMap((entry) => entry.rights);
    expect(connection).toEqual({
      action: "connection.use",
      asset: { kind: "connection" },
      steps: ["read"],
      neededFor: "run",
      held: false,
      refusal: "not_visible"
    });
    const give = (action: string, scopeId: string) =>
      t.call(t.admin.id, "permissions.grant", {
        payload: {
          holderKind: "service_principal",
          holderId: t.principal.id,
          action,
          effect: "allow",
          scopeKind: "asset",
          scopeId
        }
      });
    const refused = await give("connection.use", crm);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { details: { reason: "not_visible" } } });
    const held = () =>
      t.stores.access
        .listGrants({ clientInstanceId: t.principal.clientInstanceId, holderId: t.principal.id })
        .then((rows) => rows.map((row) => [row.action, row.scopeId]));
    expect(await held()).toEqual([]);
    // A resource the administrator may read is given as before.
    expect(use).toMatchObject({ action: "workflow.use", grant: { scopeId: childId } });
    expect((await give("workflow.use", childId)).statusCode).toBe(200);
    expect(await held()).toEqual([["workflow.use", childId]]);
  });

  it("refuses a right the administrator does not hold, on the screen and at the grant", async () => {
    const { t, crm } = await chain();
    await t.grant(t.admin.id, "connection.use", { assetId: crm }, "deny");
    const answer = await rightsOf(t, t.admin.id);
    const [use, connection] = answer.workflows.flatMap((entry) => entry.rights);
    expect(use).toMatchObject({ action: "workflow.use", grant: { holderId: t.principal.id } });
    expect(connection).toMatchObject({ action: "connection.use", refusal: "not_held" });
    expect(connection?.grant).toBeUndefined();
    const refused = await t.call(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "service_principal",
        holderId: t.principal.id,
        action: "connection.use",
        effect: "allow",
        scopeKind: "asset",
        scopeId: crm
      }
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { details: { action: "connection.use" } } });
    // What the administrator may give is given, and the publish needs nothing more.
    const written = await grantOffered(t, t.admin.id);
    expect(written.map((response) => response.statusCode)).toEqual([200]);
    expect((await publish(t, "parent", t.admin.id)).statusCode).toBe(200);
  });
});
