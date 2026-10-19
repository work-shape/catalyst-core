import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { workflowPrincipalRightsSchema } from "@work-shape/catalyst-api-contract";
import type { WorkflowManifest } from "@work-shape/catalyst-core";
import { child, parent } from "./support/workflow-children";
import { workflowFixture, type WorkflowFixture } from "./support/workflow-instance";
import { operationOf } from "./support/connection-operations";

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

  // ACCEPT-FIX-13 C3: the publish review warns of a step's Connection its account may not use,
  // read from the same rights the screen lists, and says where an administrator allows it.
  it("warns in the publish review of a Connection the account may not use, until it may", async () => {
    const t = await workflowFixture({ definitions: "assets" });
    open = t;
    await t.seedCrm();
    await put(t, child());
    const warnings = async (userId = t.admin.id) => {
      const read = await t.expectOk(userId, "assets.get", {
        params: { kind: "workflow", name: "child" }
      });
      return z
        .object({ publishNarrative: z.object({ warnings: z.array(z.string()) }) })
        .parse(read.json()).publishNarrative.warnings;
    };
    expect(await warnings()).toEqual([
      `The account “${t.principal.displayLabel}” may not use the Connection “Connection crm”, so every run fails at the step “Read”. Allow it for the account under Settings › API access, then publish.`
    ]);
    // Someone who may change the Workflow but administers no account is told who can allow it.
    await t.allow({ kind: "user", id: t.kai.id }, "workflow.write");
    await t.allow({ kind: "user", id: t.kai.id }, "connection.read");
    await t.expectOk(t.kai.id, "me.update", { payload: { locale: "de" } });
    expect(await warnings(t.kai.id)).toEqual([
      `Das Konto „${t.principal.displayLabel}“ darf die Verbindung „Connection crm“ nicht verwenden. Deshalb schlägt jeder Lauf beim Schritt „Read“ fehl. Ein Administrator kann es dem Konto erlauben.`
    ]);
    await t.allow({ kind: "service_principal", id: t.principal.id }, "connection.use");
    expect(await warnings()).toEqual([]);
  });

  // The review of an older revision warns of that revision's account and Connection, never of
  // the newest draft's (review finding on ACCEPT-FIX-13 C3).
  it("warns of the account and Connection of the revision under review", async () => {
    const t = await workflowFixture({ definitions: "assets" });
    open = t;
    await t.seedCrm();
    await t.seed("erp", { operations: [operationOf("echo", { exposure: ["workflow"] })] });
    const erpAccount = await t.stores.apiAccess.createServicePrincipal({
      clientInstanceId: t.principal.clientInstanceId,
      displayLabel: "erp-account"
    });
    await put(t, child());
    const second = child("child", erpAccount.name);
    const read = second.steps.find((step) => step.id === "read");
    if (read?.type !== "operation") throw new Error("The child reads through an operation step");
    read.operation = "connection.erp.echo";
    await t.expectOk(t.root.id, "assets.put", {
      params: { kind: "workflow", name: "child" },
      payload: { expectedRevision: 1, config: { name: "child", manifest: second } }
    });
    const warningsOf = async (revision: string) => {
      const response = await t.expectOk(t.admin.id, "assets.get", {
        params: { kind: "workflow", name: "child" },
        query: { revision }
      });
      return z
        .object({ publishNarrative: z.object({ warnings: z.array(z.string()) }) })
        .parse(response.json()).publishNarrative.warnings;
    };
    const advice = " Allow it for the account under Settings › API access, then publish.";
    expect(await warningsOf("1")).toEqual([
      `The account “${t.principal.displayLabel}” may not use the Connection “Connection crm”, so every run fails at the step “Read”.${advice}`
    ]);
    expect(await warningsOf("draft")).toEqual([
      `The account “${erpAccount.displayLabel}” may not use the Connection “Connection erp”, so every run fails at the step “Read”.${advice}`
    ]);
  });

  it("keeps a deny on a deleted child in the rights needed to publish", async () => {
    const { t, childId } = await chain();
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    await t.stores.access.createGrant({
      clientInstanceId: t.principal.clientInstanceId,
      holderKind: "service_principal",
      holderId: t.principal.id,
      action: "workflow.use",
      effect: "deny",
      scopeKind: "asset",
      scopeId: childId,
      grantedBy: t.admin.id
    });
    for (const deleted of [false, true]) {
      if (deleted)
        await t.expectOk(t.root.id, "assets.delete", {
          params: { kind: "workflow", name: "child" },
          payload: { expectedRevision: 1 }
        });
      const answer = await rightsOf(t, t.admin.id);
      expect(answer.workflows.find((entry) => entry.workflow === "parent")?.rights).toEqual([
        expect.objectContaining({ action: "workflow.use", neededFor: "publish", held: false })
      ]);
    }
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
