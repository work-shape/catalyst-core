import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, type AccessInstance } from "./support/access-instance";
import { setupAppActions, type AppActionsInstance } from "./support/app-actions";
import { operationOf } from "./support/connection-operations";
import { issuePersonalKey, personalKeyServer, personalKeyToken } from "./support/personal-api-keys";
import { runSchema, stepRunsSchema, type WorkflowFixture } from "./support/workflow-instance";
import { NOTE, notifyClients, readyWorkflows, start } from "./support/workflow-runs";

// An outside client, a personal API key over the CLI, reaches a Connection's data only through
// an operation exposed to `outside` (connections-and-secrets.md, Exposure to outside clients).
// These are the paths that reached it under another exposure: an App draft's action tried by a
// key, a test run of a draft the key started, the step outputs of runs other people started,
// and the folder names of a document source. A person signed in to the app keeps what they had.
// Real call path, real engine, real database.
//
// Each test fails without the change: the key's try read the Connection through `bridge`, its
// test run read it through `workflow`, a key with `workflow.read` read every step's output, and
// a key with `connection.use` was let through to the folder list.

const runsSchema = z.object({ items: z.array(runSchema) });

/** Lets a person do an action on everything of the instance. */
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

/** What the CLI sends with a key that names these scopes. */
async function keyOf(t: AccessInstance, userId: string, scopes: string[]) {
  return personalKeyToken(t, (await issuePersonalKey(t, scopes, userId)).secret);
}

describe("an App draft's action tried with a key", () => {
  let t: AppActionsInstance | undefined;
  afterEach(async () => {
    await t?.closeAll();
    t = undefined;
  });

  it("is refused to a key with app.read, app.write and connection.use, and tried by the person", async () => {
    t = await setupAppActions({
      modules: { personalApiKeys: { enabled: true } },
      server: (stores) => personalKeyServer(stores)
    });
    await allow(t, t.admin.id, "connection.use");
    const headers = await keyOf(t, t.admin.id, ["app.read", "app.write", "connection.use"]);
    const tryLoad = (extra: { headers?: { authorization: string } } = {}) =>
      t!.call(t!.admin.id, "apps.try_action", {
        params: { app: "orders", action: "load" },
        payload: { input: { text: "client tax data" } },
        ...extra
      });

    const byKey = await tryLoad({ headers });
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(errorSchema.parse(byKey.json()).error.details).toMatchObject({ reason: "user_only" });
    expect(byKey.body).not.toContain("client tax data");
    // No call of the Connection was made for the key.
    expect(t.executed).toEqual([]);

    const bySession = await tryLoad();
    expect(bySession.statusCode, bySession.body).toBe(200);
    expect(bySession.json()).toMatchObject({ status: "done" });
    expect(t.executed).not.toEqual([]);
  });
});

describe("a Workflow run read or started with a key", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  const ready = async (options: { definitions?: "assets" } = {}) => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { personalKeys: true, ...options }
    );
    const tim = await t.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Tim",
      roles: ["user"],
      permissions: []
    });
    return { t, tim };
  };

  /** Tim's draft of a Workflow, saved as the CLI saves it. */
  async function saveDraft(t: WorkflowFixture, manifest: { id: string }) {
    const written = await t.call(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
      payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
    });
    expect(written.statusCode, written.body).toBe(200);
  }

  /** A test run of the draft, started by Tim with the key, or in his session without one. */
  async function testRun(
    t: WorkflowFixture,
    userId: string,
    workflow: string,
    headers?: { authorization: string }
  ) {
    const response = await t.call(userId, "workflows.test", {
      params: { workflow },
      payload: { input: { note: NOTE } },
      ...(headers ? { headers } : {})
    });
    expect(response.statusCode, response.body).toBe(200);
    return t.finish(runSchema.parse(response.json()).id);
  }

  async function stepRuns(
    t: WorkflowFixture,
    userId: string,
    runId: string,
    headers?: { authorization: string }
  ) {
    const response = await t.call(userId, "workflows.list_step_runs", {
      params: { runId },
      query: {},
      ...(headers ? { headers } : {})
    });
    expect(response.statusCode, response.body).toBe(200);
    return stepRunsSchema.parse(response.json()).items;
  }

  /** A draft without a Connection step: it answers the note it is given. */
  const echoNote = {
    id: "echo-note",
    name: "Echo note",
    runAs: "workflow-runner",
    inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { note: { ref: { step: "start", path: "input.note" } } }
      }
    ]
  };

  it("refuses a key's test run at the Connection step that is not exposed to outside, and runs a draft without one", async () => {
    const { t, tim } = await ready({ definitions: "assets" });
    for (const action of ["workflow.read", "workflow.write", "connection.use"]) {
      await allow(t, tim.id, action);
    }
    await saveDraft(t, notifyClients());
    await saveDraft(t, echoNote);
    const headers = await keyOf(t, tim.id, ["workflow.read", "workflow.write", "connection.use"]);

    const refused = await testRun(t, tim.id, "notify-clients", headers);
    expect(refused.status).toBe("failed");
    expect(refused.error).toMatchObject({ action: "connection_exposure:outside" });
    const clients = (await stepRuns(t, tim.id, refused.id, headers)).find(
      (step) => step.stepId === "clients"
    );
    expect(clients).toMatchObject({
      status: "failed",
      error: { action: "connection_exposure:outside" }
    });
    expect(JSON.stringify(clients)).not.toContain("client-anna");
    // The step was refused before the outside system was asked.
    expect(t.executed).toEqual([]);

    // A draft without a Connection step still test-runs with the key, and the key reads it.
    const echoed = await testRun(t, tim.id, "echo-note", headers);
    expect(echoed.status).toBe("done");
    const result = (await stepRuns(t, tim.id, echoed.id, headers)).find(
      (step) => step.stepId === "result"
    );
    expect(result?.outputPreview?.text).toContain(NOTE);

    // Tim in his session test-runs the same draft as before: exposure `workflow` is enough.
    const bySession = await testRun(t, tim.id, "notify-clients");
    expect(bySession.status).toBe("done");
    const read = (await stepRuns(t, tim.id, bySession.id)).find(
      (step) => step.stepId === "clients"
    );
    expect(read?.outputPreview?.text).toContain("client-anna");

    // Exposed to outside, the key's test run reads, and only with the key's connection.use.
    await t.seed("crm", {
      operations: [
        operationOf("echo", { exposure: ["workflow", "outside"] }),
        operationOf("write", { effect: "changing", exposure: ["workflow", "outside"] })
      ]
    });
    const exposed = await testRun(t, tim.id, "notify-clients", headers);
    expect(exposed.status).toBe("done");
    const withoutUse = await keyOf(t, tim.id, ["workflow.read", "workflow.write"]);
    const unscoped = await testRun(t, tim.id, "notify-clients", withoutUse);
    expect(unscoped.status).toBe("failed");
    expect(unscoped.error).toMatchObject({ action: "connection.use" });
  });

  it("gives a key with workflow.read no step output of an admin's run, and the person in the app the same as before", async () => {
    const { t, tim } = await ready();
    const run = await start(t);
    await t.finish(run.id);
    await allow(t, tim.id, "workflow.read");
    const headers = await keyOf(t, tim.id, ["workflow.read"]);

    const byKey = await stepRuns(t, tim.id, run.id, headers);
    expect(byKey.map((step) => step.stepId)).toContain("clients");
    expect(byKey.every((step) => step.outputPreview === undefined)).toBe(true);
    const looped = await t.call(tim.id, "workflows.list_step_runs", {
      params: { runId: run.id },
      query: { containerStepRunId: byKey.find((step) => step.stepId === "each_client")?.id },
      headers
    });
    expect(looped.statusCode, looped.body).toBe(200);
    expect(looped.body).not.toContain("outputPreview");
    expect(looped.body).not.toContain("client-anna");
    // Nor the run's result, read alone or in the list.
    const got = await t.call(tim.id, "workflows.get_run", { params: { runId: run.id }, headers });
    expect(got.statusCode, got.body).toBe(200);
    expect(runSchema.parse(got.json()).outputPreview).toBeUndefined();
    const listed = await t.call(tim.id, "workflows.list_runs", {
      params: { workflow: "notify-clients" },
      query: {},
      headers
    });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(runsSchema.parse(listed.json()).items.every((item) => !item.outputPreview)).toBe(true);

    // Tim signed in to the app reads them as before.
    const bySession = await stepRuns(t, tim.id, run.id);
    expect(bySession.find((step) => step.stepId === "clients")?.outputPreview?.text).toContain(
      "client-anna"
    );
    const read = await t.expectOk(tim.id, "workflows.get_run", { params: { runId: run.id } });
    expect(runSchema.parse(read.json()).outputPreview).toBeDefined();
  });

  it("gives a key the result of a published run it started, and not its steps' outputs", async () => {
    const { t, tim } = await ready();
    for (const action of ["workflow.read", "workflow.write", "workflow.use"]) {
      await allow(t, tim.id, action);
    }
    // `workflows.start` takes the operation scope that a write right gives a key.
    const headers = await keyOf(t, tim.id, ["workflow.read", "workflow.write", "workflow.use"]);
    const started = await t.call(tim.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: NOTE } },
      headers
    });
    expect(started.statusCode, started.body).toBe(200);
    const run = await t.finish(runSchema.parse(started.json()).id);
    expect(run.status).toBe("done");

    const got = await t.call(tim.id, "workflows.get_run", { params: { runId: run.id }, headers });
    expect(runSchema.parse(got.json()).outputPreview).toBeDefined();
    const steps = await stepRuns(t, tim.id, run.id, headers);
    expect(steps.every((step) => step.outputPreview === undefined)).toBe(true);
    // Another key of Tim's did not start it: no result either.
    const other = await keyOf(t, tim.id, ["workflow.read"]);
    const read = await t.call(tim.id, "workflows.get_run", {
      params: { runId: run.id },
      headers: other
    });
    expect(runSchema.parse(read.json()).outputPreview).toBeUndefined();
  });

  it("refuses a key the folder names of a Connection, and lets the person through", async () => {
    const { t, tim } = await ready();
    for (const action of ["connection.read", "connection.use"]) await allow(t, tim.id, action);
    const headers = await keyOf(t, tim.id, ["connection.read", "connection.use"]);
    const folders = (extra: { headers?: { authorization: string } } = {}) =>
      t.call(tim.id, "connections.source_folders", {
        params: { name: "crm" },
        query: {},
        ...extra
      });

    const byKey = await folders({ headers });
    expect(byKey.statusCode, byKey.body).toBe(403);
    expect(errorSchema.parse(byKey.json()).error.details).toMatchObject({
      action: "connection_exposure:outside"
    });
    // The person passes the check; this Connection offers no folder choice.
    const bySession = await folders();
    expect(bySession.statusCode, bySession.body).not.toBe(403);
  });
});
