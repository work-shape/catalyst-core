import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { platformContextSchema } from "@work-shape/catalyst-api-contract";
import { WORKFLOW_ACTIONS, WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { setupAccessInstance } from "./support/access-instance";
import type { WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows } from "./support/workflow-runs";

// The sidebar row of the Workflows (NAV-VIS-1): the instance names it in `platform.context`
// for whoever is listed a Workflow by `workflows.list` or may write one, and for nobody while
// the module is off. A member is never shown an empty row; a builder is, to make the first.

const NOTIFY = "notify-clients";

describe("the Workflows row the platform context names", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  async function ready() {
    return readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets" }
    );
  }

  /** Stores the Workflow as a draft of the administrator. Answers the revision. */
  async function draft(t: WorkflowFixture): Promise<number> {
    const response = await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: NOTIFY },
      payload: { config: { name: NOTIFY, manifest: notifyClients() }, expectedRevision: null }
    });
    return z.object({ revision: z.number() }).parse(response.json()).revision;
  }

  async function publish(t: WorkflowFixture, revision: number): Promise<void> {
    await t.expectOk(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: NOTIFY },
      payload: { revision }
    });
  }

  const sectionsOf = async (t: WorkflowFixture, userId: string) =>
    platformContextSchema.parse((await t.expectOk(userId, "platform.context.get")).json())
      .visibleSections;

  const listedTo = async (t: WorkflowFixture, userId: string) =>
    z
      .object({ items: z.array(z.object({ id: z.string() }).loose()) })
      .parse((await t.expectOk(userId, "workflows.list")).json())
      .items.map(({ id }) => id);

  it("names no row to a member who is listed no Workflow, and the row once one is listed", async () => {
    const t = await ready();
    const revision = await draft(t);
    const notify = await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY);
    // A right to read the Workflow while it is a draft lists nothing: the row stays away.
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.read, { assetId: notify });
    expect(await listedTo(t, t.kai.id)).toEqual([]);
    expect(await sectionsOf(t, t.kai.id)).toEqual([]);

    await publish(t, revision);

    expect(await listedTo(t, t.kai.id)).toEqual([NOTIFY]);
    expect(await sectionsOf(t, t.kai.id)).toEqual(["workflows"]);
    // Another member, who holds nothing on it, is listed nothing and shown no row.
    expect(await listedTo(t, t.lena.id)).toEqual([]);
    expect(await sectionsOf(t, t.lena.id)).toEqual([]);
  });

  it("names the row to a member who may only start the published Workflow, as the list does", async () => {
    const t = await ready();
    await publish(t, await draft(t));
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.use, {
      assetId: await t.assetId(WORKFLOW_ASSET_KIND, NOTIFY)
    });

    expect(await listedTo(t, t.kai.id)).toEqual([NOTIFY]);
    expect(await sectionsOf(t, t.kai.id)).toEqual(["workflows"]);
  });

  it("names the empty row to whoever may write a Workflow, on the instance or in a Namespace", async () => {
    const t = await ready();
    await t.createNamespace("kai-");
    await t.grant(t.kai.id, WORKFLOW_ACTIONS.write, { namespace: "kai-" });

    // Nothing is stored yet, so nothing is listed, and the builders still have their row.
    expect(await listedTo(t, t.admin.id)).toEqual([]);
    expect(await sectionsOf(t, t.admin.id)).toEqual(["workflows"]);
    expect(await sectionsOf(t, t.kai.id)).toEqual(["workflows"]);
    expect(await sectionsOf(t, t.lena.id)).toEqual([]);
  });

  it("names no row while the module is off, not even to an administrator", async () => {
    const t = await setupAccessInstance();
    expect(
      platformContextSchema.parse((await t.expectOk(t.admin.id, "platform.context.get")).json())
        .visibleSections
    ).toEqual([]);
  });
});
