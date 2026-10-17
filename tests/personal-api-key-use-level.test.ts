import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { platformContextSchema } from "@work-shape/catalyst-api-contract";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { inDays, issuePersonalKey, personalKeyToken } from "./support/personal-api-keys";
import type { WorkflowFixture } from "./support/workflow-instance";
import { notifyClients, readyWorkflows } from "./support/workflow-runs";

// CLI-PUBLISH-USE: a personal key carries the use level, so its owner publishes from the CLI a
// Workflow whose technical account uses a Connection. The publish passes the no-escalation rule
// with the key's scopes: the person holds each right the account holds, and the key covers it.
// Fails without the use actions among the key's actions: the key that names `connection.use`
// is refused at issuance, and no key publishes the Workflow.

const WORKFLOW = "notify-clients";
const address = { kind: WORKFLOW_ASSET_KIND, name: WORKFLOW };
const AUTHORING = ["workflow.read", "workflow.write", "workflow.publish"];
const writeSchema = z.object({ revision: z.number() });

describe("the use level of a personal key", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /** The instance, its account using the Connection `crm`, and Tim, who builds Workflows. */
  async function ready() {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { definitions: "assets", personalKeys: true }
    );
    const tim = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Tim",
      roles: ["user"],
      permissions: []
    });
    for (const action of [...AUTHORING, "connection.use"]) {
      await t.allow({ kind: "user", id: tim.id }, action);
    }
    return { t, tim };
  }

  /** What `catalyst push` and `catalyst publish` send with the key's token. */
  async function writeAndPublish(
    t: WorkflowFixture,
    headers: { authorization: string },
    expectedRevision: number | null,
    note: string
  ) {
    const written = await t.call(t.root.id, "assets.put", {
      params: address,
      payload: {
        config: { name: WORKFLOW, manifest: { ...notifyClients(), description: note } },
        expectedRevision
      },
      headers
    });
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = writeSchema.parse(written.json());
    const published = await t.call(t.root.id, "assets.publish", {
      params: address,
      payload: { revision },
      headers
    });
    return { revision, published };
  }

  it("publishes from the CLI a Workflow whose account uses a Connection, and only with the level", async () => {
    const { t, tim } = await ready();
    // The key screen offers the level's rights Tim holds, of the kinds the instance runs.
    const contextOf = async (userId: string) =>
      platformContextSchema.parse((await t.expectOk(userId, "platform.context.get")).json());
    const tims = await contextOf(tim.id);
    expect(tims.useActions).toEqual(["connection.use"]);
    expect((await contextOf(t.root.id)).useActions).toEqual(["connection.use", "workflow.use"]);
    // The key `catalyst setup` asks for starts with Tim's authoring rights and the use level.
    expect(tims.authoringActions).toEqual(AUTHORING);
    const withUse = await issuePersonalKey(
      t,
      [...tims.authoringActions, ...tims.useActions],
      tim.id
    );
    expect(withUse.key.scopes).toContain("connection.use");
    const first = await writeAndPublish(t, await personalKeyToken(t, withUse.secret), null, "one");
    expect(first.published.statusCode, first.published.body).toBe(200);

    // The same key without the level: the publish is refused with the right named.
    const withoutUse = await issuePersonalKey(t, AUTHORING, tim.id);
    const second = await writeAndPublish(
      t,
      await personalKeyToken(t, withoutUse.secret),
      first.revision,
      "two"
    );
    expect(second.published.statusCode).toBe(403);
    const refused = errorSchema.parse(second.published.json()).error;
    expect(refused.details).toEqual({ action: "connection.use", reason: "outside_key_scope" });
    expect(refused.message).toBe(
      "The API key of this call does not cover 'connection.use' on the whole instance, and 'workflow-runner' would act with it. Only a holder of a right gives or lends it: use a key whose scopes name it"
    );
  });

  it("never exceeds the person's own rights: once Tim loses the right, the key publishes nothing", async () => {
    const { t, tim } = await ready();
    const key = await issuePersonalKey(t, [...AUTHORING, "connection.use"], tim.id);
    const headers = await personalKeyToken(t, key.secret);

    const rows = await t.stores.access.listGrants({ clientInstanceId, holderId: tim.id });
    const use = rows.find((row) => row.action === "connection.use");
    if (!use) throw new Error("Tim holds no row for connection.use");
    await t.stores.access.deleteGrant({ clientInstanceId, grantId: use.id });

    const { published } = await writeAndPublish(t, headers, null, "one");
    expect(published.statusCode).toBe(403);
    expect(errorSchema.parse(published.json()).error.details).toEqual({
      action: "connection.use",
      reason: "no_grant"
    });

    // Nor is a key issued with a use right the person does not hold.
    const issued = await t.call(tim.id, "me.api_keys.create", {
      payload: { name: "CLI", scopes: ["connection.use"], expiresAt: inDays(30) }
    });
    expect(issued.statusCode).toBe(422);
    expect(errorSchema.parse(issued.json()).error.details).toEqual({ action: "connection.use" });
  });

  it("counts on the operations the key reaches: a start needs the level's `workflow.use`", async () => {
    const { t, tim } = await ready();
    await t.allow({ kind: "user", id: tim.id }, "workflow.use");
    const start = async (scopes: string[]) =>
      t.call(tim.id, "workflows.start", {
        params: { workflow: WORKFLOW },
        payload: { input: { note: "x" } },
        headers: await personalKeyToken(t, (await issuePersonalKey(t, scopes, tim.id)).secret)
      });
    const key = await issuePersonalKey(t, [...AUTHORING, "connection.use"], tim.id);
    const { published } = await writeAndPublish(
      t,
      await personalKeyToken(t, key.secret),
      null,
      "one"
    );
    expect(published.statusCode, published.body).toBe(200);

    const without = await start(AUTHORING);
    expect(without.statusCode).toBe(403);
    expect(errorSchema.parse(without.json()).error.details).toEqual({
      action: "workflow.use",
      reason: "outside_key_scope"
    });
    expect((await start([...AUTHORING, "workflow.use"])).statusCode).toBe(200);
  });
});
