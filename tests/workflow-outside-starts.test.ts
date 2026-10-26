import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, type AccessInstance } from "./support/access-instance";
import { operationOf } from "./support/connection-operations";
import { issuePersonalKey, personalKeyToken } from "./support/personal-api-keys";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows } from "./support/workflow-runs";

// A Workflow runs as its own principal under exposure `workflow`, so a key that starts it would
// get what the run read: a Connection's data the Connection's admin kept from outside clients
// would leave the instance through the Workflow. A Workflow is started from outside only where
// its trigger names `outside`, and only while every Connection operation the run calls, in a
// child Workflow too, is exposed to `outside` (connections-and-secrets.md, Exposure to outside
// clients; Workflows started from outside). A person, an agent in the chat and an App start it
// as before. Real call path, real engine, real database.
//
// Each test fails without the change: the key started notify-clients and read the clients the
// Connection answered under `workflow` alone.

const listSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      runnable: z.boolean(),
      reasons: z.array(z.object({ code: z.string() }))
    })
  )
});

async function allow(t: AccessInstance, userId: string, action: string) {
  await t.stores.access.createGrant({
    clientInstanceId,
    holderKind: "user",
    holderId: userId,
    action,
    effect: "allow",
    scopeKind: "instance",
    grantedBy: t.root.id
  });
}

/** notify-clients with these triggers, under its own id. */
function withTriggers(id: string, triggers: { kind: string }[]) {
  const manifest = notifyClients();
  const [trigger, ...rest] = manifest.steps;
  return { ...manifest, id, name: id, steps: [{ ...trigger, triggers }, ...rest] };
}

/** The crm Connection with both operations exposed to Workflows, and to outside where asked. */
async function seedCrm(t: WorkflowFixture, outside: boolean) {
  const exposure = outside ? ["workflow", "outside"] : ["workflow"];
  await t.seed("crm", {
    operations: [
      operationOf("echo", { exposure }),
      operationOf("write", { effect: "changing", exposure })
    ]
  });
}

describe("a Workflow started from outside", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  const ready = async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { personalKeys: true, definitions: "assets" }
    );
    const tim = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Tim",
      roles: ["user"],
      permissions: []
    });
    const scopes = ["workflow.read", "workflow.write", "workflow.use"];
    for (const action of scopes) await allow(t, tim.id, action);
    const headers = personalKeyToken(t, (await issuePersonalKey(t, scopes, tim.id)).secret);
    return { t, tim, headers: await headers };
  };

  const revisions = new Map<string, number>();
  afterEach(() => revisions.clear());

  /** Writes the definition and publishes it as the root; answers the publish's response. */
  async function publish(t: WorkflowFixture, manifest: { id: string }) {
    const written = await t.call(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
      payload: {
        config: { name: manifest.id, manifest },
        expectedRevision: revisions.get(manifest.id) ?? null
      }
    });
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = z.object({ revision: z.number() }).parse(written.json());
    revisions.set(manifest.id, revision);
    return t.call(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
      payload: { revision }
    });
  }

  const startBy = (
    t: WorkflowFixture,
    userId: string,
    workflow: string,
    headers?: Record<string, string>
  ) =>
    t.call(userId, "workflows.start", {
      params: { workflow },
      payload: { input: { note: NOTE } },
      ...(headers ? { headers } : {})
    });

  it("refuses a key a Workflow whose trigger does not name outside, and a person starts it as before", async () => {
    const { t, tim, headers } = await ready();
    await seedCrm(t, true);
    const published = await publish(t, withTriggers("notify-clients", [{ kind: "manual" }]));
    expect(published.statusCode, published.body).toBe(200);

    const byKey = await startBy(t, tim.id, "notify-clients", headers);
    expect(byKey.statusCode, byKey.body).toBe(409);
    expect(errorSchema.parse(byKey.json()).error.details).toMatchObject({
      reason: "no_outside_trigger"
    });
    expect(byKey.body).not.toContain("client-anna");
    expect(t.executed).toEqual([]);
    // The list tells the key it cannot start it.
    const listed = await t.call(tim.id, "workflows.list", { query: {}, headers });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listSchema.parse(listed.json()).items).toContainEqual(
      expect.objectContaining({
        id: "notify-clients",
        runnable: false,
        reasons: expect.arrayContaining([{ code: "no_outside_trigger" }])
      })
    );

    // Tim signed in to the app starts it and reads it as before.
    const bySession = await startBy(t, tim.id, "notify-clients");
    expect(bySession.statusCode, bySession.body).toBe(200);
    const run = await t.finish(runSchema.parse(bySession.json()).id);
    expect(run.status).toBe("done");
  });

  it("refuses the publish and the start while a Connection operation the run calls is not exposed to outside", async () => {
    const { t, tim, headers } = await ready();
    await seedCrm(t, false);
    const opened = withTriggers("notify-clients", [{ kind: "manual" }, { kind: "outside" }]);

    // Turning starts from outside on for a Workflow that reads crm is refused, naming crm.
    const refused = await publish(t, opened);
    expect(refused.statusCode, refused.body).toBe(422);
    expect(errorSchema.parse(refused.json()).error.details).toMatchObject({
      reason: "outside_not_exposed"
    });
    expect(refused.body).toContain("'crm'");

    // With the operations exposed to outside, the key starts it and reads its result.
    await seedCrm(t, true);
    const published = await publish(t, opened);
    expect(published.statusCode, published.body).toBe(200);
    const started = await startBy(t, tim.id, "notify-clients", headers);
    expect(started.statusCode, started.body).toBe(200);
    const run = await t.finish(runSchema.parse(started.json()).id);
    expect(run.status).toBe("done");
    const read = await t.call(tim.id, "workflows.get_run", {
      params: { runId: run.id },
      headers
    });
    expect(runSchema.parse(read.json()).outputPreview).toBeDefined();

    // The Connection's admin takes `outside` back after the publish: the next start is refused
    // before the Connection is called.
    await seedCrm(t, false);
    const calls = t.executed.length;
    const again = await startBy(t, tim.id, "notify-clients", headers);
    expect(again.statusCode, again.body).toBe(403);
    expect(errorSchema.parse(again.json()).error.details).toMatchObject({
      action: "connection_exposure:outside"
    });
    expect(again.body).not.toContain("crm");
    expect(t.executed.length).toBe(calls);
    // The person in the app still starts it.
    const bySession = await startBy(t, tim.id, "notify-clients");
    expect(bySession.statusCode, bySession.body).toBe(200);
  });

  it("asks a child Workflow's Connections too", async () => {
    const { t, tim, headers } = await ready();
    await seedCrm(t, true);
    const child = withTriggers("read-clients", [{ kind: "parent" }]);
    expect((await publish(t, child)).statusCode).toBe(200);
    const parent = {
      id: "outside-parent",
      name: "Outside parent",
      runAs: "workflow-runner",
      inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "outside" }] },
        {
          id: "child",
          name: "Read the clients",
          type: "workflow",
          workflow: "read-clients",
          input: { note: { ref: { step: "start", path: "input.note" } } }
        },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    };
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    const published = await publish(t, parent);
    expect(published.statusCode, published.body).toBe(200);

    await seedCrm(t, false);
    const byKey = await startBy(t, tim.id, "outside-parent", headers);
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(errorSchema.parse(byKey.json()).error.details).toMatchObject({
      action: "connection_exposure:outside"
    });
    expect(t.executed).toEqual([]);
  });

  it("gives a key no data of a run that was not started from outside", async () => {
    const { t, tim, headers } = await ready();
    await seedCrm(t, true);
    const opened = withTriggers("notify-clients", [{ kind: "manual" }, { kind: "outside" }]);
    expect((await publish(t, opened)).statusCode).toBe(200);
    // Tim starts it in his session; his key did not start it and reads no result of it.
    const bySession = await startBy(t, tim.id, "notify-clients");
    const run = await t.finish(runSchema.parse(bySession.json()).id);
    const read = await t.call(tim.id, "workflows.get_run", {
      params: { runId: run.id },
      headers
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(runSchema.parse(read.json()).outputPreview).toBeUndefined();
  });
});
