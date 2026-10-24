import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_ASSET_KIND,
  type OperationAuthorizeContext
} from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { identityOf } from "./support/connection-operations";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows } from "./support/workflow-runs";

// WS-OWN-1b: a workspace owns the Workflows made in it. Its rights are written in that
// workspace and reach those Workflows alone; membership gives none, because a run acts as its
// principal. Before WS-OWN-1b the Workflow kind took the instance as its only owner: every
// write below with a workspace was refused, and a grant in a workspace with `invalid_scope`.

const INSTANCE_WORKFLOW = "notify-clients";
const OWN = "nordlicht-notify";
const SIBLING = "nordlicht-check";
const FOREIGN = "other-check";

const listSchema = z.object({
  items: z.array(
    z.object({ id: z.string(), workspaceId: z.string().optional(), actions: z.array(z.string()) })
  )
});

describe("a Workflow a workspace owns", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /** One published Workflow of the instance, and the workspaces Nordlicht and Other. */
  async function ready() {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
    const revision = await put(t, t.admin.id, INSTANCE_WORKFLOW, undefined, null);
    await t.expectOk(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: INSTANCE_WORKFLOW },
      payload: { revision }
    });
    const nordlicht = await t.sharedWorkspace("Nordlicht");
    const other = await t.sharedWorkspace("Other");
    for (const user of [t.kai, t.lena])
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: nordlicht,
        userId: user.id,
        role: "member"
      });
    return { t, nordlicht, other };
  }

  /** Writes the draft of a Workflow, in a workspace where one is named. Answers the revision. */
  async function put(
    t: WorkflowFixture,
    userId: string,
    id: string,
    workspaceId: string | undefined,
    expectedRevision: number | null,
    manifest: Record<string, unknown> = { ...notifyClients(), id }
  ) {
    const response = await t.expectOk(userId, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: id },
      payload: {
        config: { name: id, manifest },
        expectedRevision,
        ...(workspaceId === undefined ? {} : { workspaceId })
      }
    });
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  }

  const listed = async (t: WorkflowFixture, userId: string) =>
    listSchema
      .parse((await t.expectOk(userId, "workflows.list")).json())
      .items.map(({ id, workspaceId, actions }) => ({ id, workspaceId, actions }));
  const startOf = (workflow: string) => ({
    params: { workflow },
    payload: { input: { note: NOTE } }
  });

  it("is edited, tested and published by a builder of its workspace who holds no right on the instance", async () => {
    const { t, nordlicht } = await ready();
    // Kai builds in Nordlicht: write and publish there, and the right the Workflow's principal
    // holds, on the whole instance, which a publish asks of whoever makes it live (RIGHTS-1a).
    for (const action of [WORKFLOW_ACTIONS.write, WORKFLOW_ACTIONS.publish])
      await t.grant(t.kai.id, action, { workspaceId: nordlicht });
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.kai.id,
      action: "connection.use",
      effect: "allow",
      scopeKind: "instance",
      grantedBy: t.root.id
    });

    const first = await put(t, t.kai.id, OWN, nordlicht, null);
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: OWN
    });
    expect(stored?.scope).toEqual({ kind: "workspace", workspaceId: nordlicht });
    const revision = await put(t, t.kai.id, OWN, nordlicht, first, {
      ...notifyClients(),
      id: OWN,
      name: "Nordlicht notify"
    });

    const tested = runSchema
      .extend({ mode: z.literal("test") })
      .parse((await t.expectOk(t.kai.id, "workflows.test", startOf(OWN))).json());
    expect(tested.workflow).toBe(OWN);
    await t.expectOk(t.kai.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: OWN },
      payload: { revision, workspaceId: nordlicht }
    });
    expect(
      (
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: WORKFLOW_ASSET_KIND,
          name: OWN
        })
      )?.publishedRevision
    ).toBe(revision);
    // Replaces e2e/workflow-workspace-owner.spec.ts "a Workflow a workspace owns is listed on its
    // Workflows page with the workspace's chip": addressed without its workspace, the Workflow
    // is not there, even for the superadmin; the instance owns no such one.
    const address = { kind: WORKFLOW_ASSET_KIND, name: OWN };
    await t.expectOk(t.root.id, "assets.get", {
      params: address,
      query: { workspaceId: nordlicht }
    });
    await t.expectRefused(
      t.root.id,
      "assets.get",
      { params: address },
      { status: 404, code: "NOT_FOUND" }
    );

    // The rights in Nordlicht reach no Workflow of the instance.
    await t.expectRefused(
      t.kai.id,
      "assets.put",
      {
        params: { kind: WORKFLOW_ASSET_KIND, name: INSTANCE_WORKFLOW },
        payload: {
          config: { name: INSTANCE_WORKFLOW, manifest: notifyClients() },
          expectedRevision: 1
        }
      },
      t.forbidden("workflow.write", "no_grant")
    );
    // Taking it back is addressed by its name alone; the owner comes from the store.
    await t.expectOk(t.kai.id, "workflows.unpublish", { params: { workflow: OWN } });
  });

  it("is started by a holder of workflow.use in its workspace, and by no member without it", async () => {
    const { t, nordlicht, other } = await ready();
    const revision = await put(t, t.admin.id, OWN, nordlicht, null);
    await t.expectOk(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: OWN },
      payload: { revision, workspaceId: nordlicht }
    });

    // Lena is a member of Nordlicht: membership gives no Workflow right.
    expect(await listed(t, t.lena.id)).toEqual([]);
    await t.expectRefused(
      t.lena.id,
      "workflows.start",
      startOf(OWN),
      t.forbidden("workflow.use", "no_grant")
    );
    // A right in another workspace reaches no Workflow of Nordlicht.
    await t.grant(t.lena.id, WORKFLOW_ACTIONS.use, { workspaceId: other });
    await t.expectRefused(
      t.lena.id,
      "workflows.start",
      startOf(OWN),
      t.forbidden("workflow.use", "no_grant")
    );

    await t.grant(t.lena.id, WORKFLOW_ACTIONS.use, { workspaceId: nordlicht });

    // The list names the owner, and only what the right in Nordlicht reaches.
    expect(await listed(t, t.lena.id)).toEqual([
      { id: OWN, workspaceId: nordlicht, actions: [WORKFLOW_ACTIONS.use] }
    ]);
    const run = runSchema.parse(
      (await t.expectOk(t.lena.id, "workflows.start", startOf(OWN))).json()
    );
    expect(run.workflow).toBe(OWN);
    await t.expectRefused(
      t.lena.id,
      "workflows.start",
      startOf(INSTANCE_WORKFLOW),
      t.forbidden("workflow.use", "no_grant")
    );
  });

  it("is started through its operation by the rights of its workspace: a grant there admits, a deny there refuses", async () => {
    const { t, nordlicht } = await ready();
    const revision = await put(t, t.admin.id, OWN, nordlicht, null);
    await t.expectOk(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: OWN },
      payload: { revision, workspaceId: nordlicht }
    });
    const operation = `workflow.${OWN}.start`;

    // Lena's right in Nordlicht admits the operation as it admits workflows.start. Before the
    // fix the operation asked no workspace and refused her.
    await t.grant(t.lena.id, WORKFLOW_ACTIONS.use, { workspaceId: nordlicht });
    const admitted = await t.invoke(
      t.lena,
      operation,
      { note: NOTE },
      { effect: "changing", idempotencyKey: "lena" }
    );
    expect(admitted.result.status).toBe("done");

    // Kai may use every Workflow of the instance, and Nordlicht denies him its own: the deny
    // holds on the operation too. Before the fix it was passed over.
    for (const [effect, scope] of [
      ["allow", { scopeKind: "instance" }],
      ["deny", { scopeKind: "workspace", scopeId: nordlicht }]
    ] as const)
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.kai.id,
        action: WORKFLOW_ACTIONS.use,
        effect,
        ...scope,
        grantedBy: t.root.id
      });
    const denied = await t.invoke(
      t.kai,
      operation,
      { note: NOTE },
      { effect: "changing", idempotencyKey: "kai" }
    );
    expect(denied.result.status).toBe("denied");
    expect(
      (await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: OWN })).map(
        (run) => run.startedBy.id
      )
    ).toEqual([t.lena.id]);
  });

  it.each(["asset", "workspace", "none"] as const)(
    "preserves workflow.use for a start operation with a %s grant",
    async (grant) => {
      const { t, nordlicht, other } = await ready();
      for (const [name, workspaceId] of [
        [OWN, nordlicht],
        [SIBLING, nordlicht],
        [FOREIGN, other]
      ] as const) {
        const revision = await put(t, t.admin.id, name, workspaceId, null);
        await t.expectOk(t.root.id, "assets.publish", {
          params: { kind: WORKFLOW_ASSET_KIND, name },
          payload: { revision, workspaceId }
        });
      }
      const assetId = await t.assetId(WORKFLOW_ASSET_KIND, OWN);
      if (grant !== "none")
        await t.grant(
          t.lena.id,
          WORKFLOW_ACTIONS.use,
          grant === "asset" ? { assetId } : { workspaceId: nordlicht }
        );

      const actor = identityOf(t.lena);
      const access = await t.operationCalls.deps.authorizer.forActor(actor);
      for (const name of [OWN, SIBLING, FOREIGN, INSTANCE_WORKFLOW]) {
        const binding = await t.operationCalls.registry.resolve(`workflow.${name}.start`);
        if (!binding || binding.action !== null) throw new Error("Workflow start check missing");
        const input = { note: NOTE };
        const resource = binding.resource(input);
        expect(resource).toMatchObject({
          kind: WORKFLOW_ASSET_KIND,
          name,
          assetId: await t.assetId(WORKFLOW_ASSET_KIND, name),
          ...(name === INSTANCE_WORKFLOW
            ? {}
            : { workspaceId: name === FOREIGN ? other : nordlicht })
        });
        const context: OperationAuthorizeContext = {
          actor,
          access,
          resource,
          origin: { kind: "user" },
          correlationId: "workflow-start-rights"
        };
        const allowed =
          (grant === "asset" && name === OWN) ||
          (grant === "workspace" && (name === OWN || name === SIBLING));
        // The old action: "workflow.use" path asked exactly this access and resource.
        expect(access.authorize(WORKFLOW_ACTIONS.use, resource).allowed).toBe(allowed);
        expect(await binding.authorize(input, context)).toEqual(
          allowed
            ? { allowed: true }
            : { allowed: false, action: "workflow.use", reason: "no_grant" }
        );
      }
    }
  );

  it("goes with its workspace by its own delete: the name stays taken, the principal is retired and open runs end", async () => {
    const { t, nordlicht, other } = await ready();
    // Without `runAs` the publish gives the Workflow an account of its own (AP-10).
    const { runAs: _runAs, ...ownAccount } = { ...notifyClients(), id: OWN };
    const revision = await put(t, t.admin.id, OWN, nordlicht, null, ownAccount);
    await t.expectOk(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: OWN },
      payload: { revision, workspaceId: nordlicht }
    });
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: WORKFLOW_ASSET_KIND,
      name: OWN
    });
    if (!asset) throw new Error("The Workflow is not stored");
    const owner = { kind: WORKFLOW_ASSET_KIND, assetId: asset.id };
    expect(
      await t.stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner })
    ).toBeDefined();
    // A run that has not ended when the workspace goes.
    const open = runSchema.parse(
      (await t.expectOk(t.root.id, "workflows.start", startOf(OWN))).json()
    );

    const deleted = await t.expectOk(t.admin.id, "workspaces.delete", {
      params: { collaborationWorkspaceId: nordlicht },
      payload: { confirmName: "Nordlicht" }
    });
    expect(deleted.json()).toMatchObject({ state: "deleted" });

    // Before the fix the row went, and with it the name; the principal and the run stayed.
    expect(
      await t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: WORKFLOW_ASSET_KIND,
        name: OWN
      })
    ).toMatchObject({ id: asset.id, status: "deleted", scope: { kind: "instance" } });
    expect(
      await t.stores.apiAccess.findServicePrincipalByOwner({ clientInstanceId, owner })
    ).toBeUndefined();
    expect(await t.stores.workflowRuns.readRun({ clientInstanceId, id: open.id })).toMatchObject({
      status: "cancelled"
    });
    // A builder of another workspace makes no new Workflow of the name, so none inherits its
    // runs: before the fix the name was free and the old runs were read through the new one.
    await t.grant(t.lena.id, WORKFLOW_ACTIONS.write, { workspaceId: other });
    await t.expectRefused(
      t.lena.id,
      "assets.put",
      {
        params: { kind: WORKFLOW_ASSET_KIND, name: OWN },
        payload: {
          config: { name: OWN, manifest: { ...notifyClients(), id: OWN } },
          expectedRevision: null,
          workspaceId: other
        }
      },
      // What a name another owner holds is answered to one who may not read it.
      { status: 412, code: "REVISION_CONFLICT" }
    );
  });

  it("names a child Workflow of its own workspace or of the instance, and none of another workspace", async () => {
    const { t, nordlicht, other } = await ready();
    await put(t, t.admin.id, FOREIGN, other, null);
    const naming = (child: string) => ({
      ...notifyClients(),
      id: OWN,
      steps: [
        ...notifyClients().steps.slice(0, -1),
        {
          id: "check",
          name: "Check",
          type: "workflow",
          workflow: child,
          input: { note: { ref: { step: "start", path: "input.note" } } }
        },
        notifyClients().steps.at(-1)
      ]
    });

    const refused = await t.expectRefused(
      t.admin.id,
      "assets.put",
      {
        params: { kind: WORKFLOW_ASSET_KIND, name: OWN },
        payload: {
          config: { name: OWN, manifest: naming(FOREIGN) },
          expectedRevision: null,
          workspaceId: nordlicht
        }
      },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({ reason: "invalid_scope" });

    await put(t, t.admin.id, OWN, nordlicht, null, naming(INSTANCE_WORKFLOW));
  });
});
