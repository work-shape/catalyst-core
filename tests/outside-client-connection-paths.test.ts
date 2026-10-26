import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DATA_STORE_OPERATION_RIGHTS,
  DATA_STORE_OPERATION_SCOPES,
  KNOWLEDGE_BASE_ACTIONS,
  WORKFLOW_ASSET_KIND,
  asApiCredentialId,
  dataStoreOperationName,
  knowledgeSearchOperationName,
  type JsonValue,
  type OperationDefinition,
  type OperationSource
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, type AccessInstance } from "./support/access-instance";
import { setupAppActions, type AppActionsInstance } from "./support/app-actions";
import { operationOf } from "./support/connection-operations";
import { issuePersonalKey, personalKeyServer, personalKeyToken } from "./support/personal-api-keys";
import {
  publishedDefinitions,
  runSchema,
  stepRunsSchema,
  type WorkflowFixture
} from "./support/workflow-instance";
import type { WorkflowDefinitionSource } from "@work-shape/catalyst-workflows";
import { NOTE, notifyClients, readyWorkflows } from "./support/workflow-runs";

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
    const app = await setupAppActions({
      modules: { personalApiKeys: { enabled: true } },
      server: (stores) => personalKeyServer(stores)
    });
    t = app;
    await allow(t, t.admin.id, "connection.use");
    const headers = await keyOf(t, t.admin.id, ["app.read", "app.write", "connection.use"]);
    const tryLoad = (extra: { headers?: { authorization: string } } = {}) =>
      app.call(app.admin.id, "apps.try_action", {
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

  const ready = async (
    options: {
      definitions?: "assets" | WorkflowDefinitionSource;
      operationSources?: readonly OperationSource[];
    } = {}
  ) => {
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

  it("stops a key's test run once the key is revoked", async () => {
    const { t, tim } = await ready({ definitions: "assets" });
    const scopes = ["workflow.read", "workflow.write", "connection.use"];
    for (const action of scopes) await allow(t, tim.id, action);
    await t.seed("crm", {
      operations: [
        operationOf("echo", { exposure: ["workflow", "outside"] }),
        operationOf("write", { effect: "changing", exposure: ["workflow", "outside"] })
      ]
    });
    await saveDraft(t, notifyClients());
    const key = await issuePersonalKey(t, scopes, tim.id);
    const response = await t.call(tim.id, "workflows.test", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: NOTE } },
      headers: await personalKeyToken(t, key.secret)
    });
    expect(response.statusCode, response.body).toBe(200);
    await t.stores.personalApiKeys.revokePersonalApiKey({
      clientInstanceId,
      keyId: asApiCredentialId(key.key.id)
    });
    const run = await t.finish(runSchema.parse(response.json()).id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatchObject({ code: "tester_key_unusable" });
    expect(t.executed).toEqual([]);
  });

  it("gives a key with workflow.read no step output of an admin's run, and the person in the app the same as before", async () => {
    const { t, tim } = await ready();
    const started = await t.expectOk(t.root.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: NOTE }, key: "2026-10/anna" }
    });
    const run = runSchema.parse(started.json());
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
    // Nor its run key, nor other people's keys spelled out by a prefix.
    expect(got.body).not.toContain("2026-10/anna");
    expect(listed.body).not.toContain("2026-10/anna");
    const byPrefix = await t.call(tim.id, "workflows.list_runs", {
      params: { workflow: "notify-clients" },
      query: { keyPrefix: "2026-10/" },
      headers
    });
    expect(byPrefix.statusCode, byPrefix.body).toBe(403);
    const byRunKey = await t.call(tim.id, "workflows.list_runs", {
      params: { workflow: "notify-clients" },
      query: { key: "2026-10/anna" },
      headers
    });
    expect(byRunKey.statusCode, byRunKey.body).toBe(200);
    expect(runsSchema.parse(byRunKey.json()).items).toEqual([]);
    // A start with a key that the admin's run holds is refused: the Workflow does not start
    // from outside, and the answer names neither the run nor its key.
    for (const action of ["workflow.write", "workflow.use"]) await allow(t, tim.id, action);
    const starter = await keyOf(t, tim.id, ["workflow.read", "workflow.write", "workflow.use"]);
    const again = await t.call(tim.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: NOTE }, key: "2026-10/anna" },
      headers: starter
    });
    expect(again.statusCode, again.body).toBe(409);
    expect(again.body).not.toContain(run.id);
    expect(again.body).not.toContain("2026-10/anna");

    // Tim signed in to the app reads them as before.
    const bySession = await stepRuns(t, tim.id, run.id);
    expect(bySession.find((step) => step.stepId === "clients")?.outputPreview?.text).toContain(
      "client-anna"
    );
    const read = await t.expectOk(tim.id, "workflows.get_run", { params: { runId: run.id } });
    expect(runSchema.parse(read.json()).outputPreview).toBeDefined();
  });

  it("answers a key that may start a Workflow and not read it what a missing Workflow answers for another person's run key", async () => {
    // A Workflow outside clients may start, over crm exposed to them.
    const definitions = publishedDefinitions();
    const opened = notifyClients();
    const [trigger, ...rest] = opened.steps;
    definitions.publish({
      ...opened,
      steps: [{ ...trigger, triggers: [{ kind: "manual" }, { kind: "outside" }] }, ...rest]
    });
    const { t, tim } = await ready({ definitions: definitions.source });
    await t.seed("crm", {
      operations: [
        operationOf("echo", { exposure: ["workflow", "outside"] }),
        operationOf("write", { effect: "changing", exposure: ["workflow", "outside"] })
      ]
    });
    const started = await t.expectOk(t.root.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: NOTE }, key: "2026-10/anna" }
    });
    const run = runSchema.parse(started.json());
    await t.finish(run.id);
    // `workflows.start` takes the operation scope that a write right gives a key.
    for (const action of ["workflow.write", "workflow.use"]) await allow(t, tim.id, action);
    const headers = await keyOf(t, tim.id, ["workflow.write", "workflow.use"]);
    const startWith = (workflow: string, key: string) =>
      t.call(tim.id, "workflows.start", {
        params: { workflow },
        payload: { input: { note: NOTE }, key },
        headers
      });
    // The two answers differ in the Workflow they name and their correlation id alone.
    const asAnswered = (body: string, workflow: string) => {
      const { error } = z
        .object({ error: z.object({ correlationId: z.string() }).loose() })
        .parse(JSON.parse(body.replaceAll(workflow, "<workflow>")));
      return { ...error, correlationId: undefined };
    };

    const taken = await startWith("notify-clients", "2026-10/anna");
    const missing = await startWith("no-such-workflow", "2026-10/anna");
    expect(missing.statusCode, missing.body).toBe(404);
    expect(taken.statusCode, taken.body).toBe(404);
    expect(asAnswered(taken.body, "notify-clients")).toEqual(
      asAnswered(missing.body, "no-such-workflow")
    );
    expect(taken.body).not.toContain(run.id);
    expect(taken.body).not.toContain("Root");

    // A run key of its own answers the key its run, a second time too.
    const own = await startWith("notify-clients", "2026-10/tim");
    expect(own.statusCode, own.body).toBe(200);
    const again = await startWith("notify-clients", "2026-10/tim");
    expect(again.statusCode, again.body).toBe(200);
    expect(runSchema.parse(again.json()).id).toBe(runSchema.parse(own.json()).id);
    // Tim signed in to the app is answered the run as before.
    const bySession = await t.call(tim.id, "workflows.start", {
      params: { workflow: "notify-clients" },
      payload: { input: { note: NOTE }, key: "2026-10/anna" }
    });
    expect(bySession.statusCode, bySession.body).toBe(200);
    expect(runSchema.parse(bySession.json()).id).toBe(run.id);
  });

  it("gives a key the result and step outputs of a published run it started, and another key neither", async () => {
    // Started from outside: its trigger names `outside` and crm's operations are exposed to it.
    const definitions = publishedDefinitions();
    const opened = notifyClients();
    const [trigger, ...rest] = opened.steps;
    definitions.publish({
      ...opened,
      steps: [{ ...trigger, triggers: [{ kind: "manual" }, { kind: "outside" }] }, ...rest]
    });
    const { t, tim } = await ready({ definitions: definitions.source });
    await t.seed("crm", {
      operations: [
        operationOf("echo", { exposure: ["workflow", "outside"] }),
        operationOf("write", { effect: "changing", exposure: ["workflow", "outside"] })
      ]
    });
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
    expect(steps.find((step) => step.stepId === "clients")?.outputPreview?.text).toContain(
      "client-anna"
    );
    // Another key of Tim's did not start it: neither its result nor its steps' outputs.
    const other = await keyOf(t, tim.id, ["workflow.read"]);
    const read = await t.call(tim.id, "workflows.get_run", {
      params: { runId: run.id },
      headers: other
    });
    expect(runSchema.parse(read.json()).outputPreview).toBeUndefined();
    const otherSteps = await stepRuns(t, tim.id, run.id, other);
    expect(otherSteps.every((step) => step.outputPreview === undefined)).toBe(true);
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
  /**
   * A read of a Data Store's rows and a search of a Knowledge Base, as the instance registers
   * them: their names, rights and the scope `data_store_rows:read` a key's call needs. What
   * they answer stands in for the rows; the scope and the rights are what is tested.
   */
  const rowReads = (): OperationDefinition[] => {
    const read = (
      name: string,
      action: string,
      kind: string,
      answer: JsonValue
    ): OperationDefinition => ({
      name,
      effect: "reading",
      action,
      scope: DATA_STORE_OPERATION_SCOPES.query,
      auth: "principal",
      inputSchema: z.object({}).loose(),
      outputSchema: z.unknown(),
      resource: () => ({ kind, id: name, name: name.split(".")[1] ?? name }),
      module: "dataStores",
      timeoutMs: 10_000,
      execute: () => Promise.resolve(answer)
    });
    return [
      read(
        dataStoreOperationName("findings", "query"),
        DATA_STORE_OPERATION_RIGHTS.query,
        "data_store",
        { rows: [{ client: "client tax row" }] }
      ),
      read(knowledgeSearchOperationName("handbook"), KNOWLEDGE_BASE_ACTIONS.use, "knowledge_base", {
        results: [{ text: "handbook passage" }]
      })
    ];
  };

  /** The operations as a source contributes those that come from data. */
  const sourceOf = (definitions: OperationDefinition[]): OperationSource => {
    const byName = new Map(definitions.map((definition) => [definition.name, definition]));
    return {
      resolve: (name) => Promise.resolve(byName.get(name)),
      resolveMany: (names) => Promise.resolve(names.flatMap((name) => byName.get(name) ?? [])),
      list: () => Promise.resolve({ operations: definitions, truncated: [] })
    };
  };

  /** A draft of one step that calls the operation. */
  const reading = (id: string, operation: string) => ({
    id,
    name: id,
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "read", name: "Read", type: "operation", operation, input: {} },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { read: { ref: { step: "read", path: "" } } }
      }
    ]
  });

  it("refuses a key's test run a Data Store query and a Knowledge Base search, which no key's scopes reach", async () => {
    const { t, tim } = await ready({
      definitions: "assets",
      operationSources: [sourceOf(rowReads())]
    });
    const rights = ["workflow.read", "workflow.write", "data_store.read", "knowledge_base.use"];
    for (const action of rights) {
      await allow(t, tim.id, action);
      await t.allow({ kind: "service_principal", id: t.principal.id }, action);
    }
    const drafts = [
      reading("read-findings", dataStoreOperationName("findings", "query")),
      reading("search-handbook", knowledgeSearchOperationName("handbook"))
    ];
    for (const draft of drafts) await saveDraft(t, draft);
    const headers = await keyOf(t, tim.id, rights);

    for (const draft of drafts) {
      const byKey = await testRun(t, tim.id, draft.id, headers);
      expect(byKey.status, JSON.stringify(byKey)).toBe("failed");
      const [read] = (await stepRuns(t, tim.id, byKey.id, headers)).filter(
        (step) => step.stepId === "read"
      );
      expect(read?.status).toBe("failed");
      expect(read?.error?.message).toContain("data_store_rows:read");
      // Tim in his session test-runs it as before.
      const bySession = await testRun(t, tim.id, draft.id);
      expect(bySession.status, JSON.stringify(bySession)).toBe("done");
    }
  });
});
