import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ACTIONS, WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { clientInstanceId } from "./support/access-instance";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows } from "./support/workflow-runs";

// WS-OWN-1b: a workspace owns the Workflows made in it. Its rights are written in that
// workspace and reach those Workflows alone; membership gives none, because a run acts as its
// principal. Before WS-OWN-1b the Workflow kind took the instance as its only owner: every
// write below with a workspace was refused, and a grant in a workspace with `invalid_scope`.

const INSTANCE_WORKFLOW = "notify-clients";
const OWN = "nordlicht-notify";
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
