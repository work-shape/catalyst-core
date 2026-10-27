import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { WORKFLOW_ASSET_KIND, type JsonValue } from "@work-shape/catalyst-core";
import { workflowScheduleJobKind } from "@work-shape/catalyst-workflows";
import { clientInstanceId, errorSchema } from "./support/access-instance";
import { operationOf } from "./support/connection-operations";
import { issuePersonalKey, personalKeyToken } from "./support/personal-api-keys";
import { runSchema, type WorkflowFixture } from "./support/workflow-instance";
import { MemoryObjectStorage } from "./support/memory-object-storage";
import { NOTE, notifyClients, readyWorkflows, stepRunsOf } from "./support/workflow-runs";

// A Workflow a credential published (a personal API key, a Service Principal's credential or a
// run) reaches only data open to outside clients (WF-OUT), and the publish asks it once. The
// start is the boundary: every start of such a revision asks its reach again, so a child a
// person re-published to read a closed Connection, or `outside` taken off an operation, stops
// the next start, a schedule's too. And a child a credential published starts only from runs
// whose reach is open: a parent that reads a closed Connection could hand its data to the child
// as input, for the child to copy into a Data Store an outside Workflow reads. A person's
// publish keeps everything as it was. Real call path, real engine, real database.
//
// Each test of a refusal fails without the change: the key's publish went live, or the
// key-published Workflow started and ran. The others hold what stays as it was.

const SCOPES = [
  "workflow.read",
  "workflow.write",
  "workflow.publish",
  "workflow.use",
  "connection.use"
];

const ref = (step: string, path: string) => ({ ref: { step, path } });
const NOW = new Date("2020-03-10T10:59:57Z");
const revisionSchema = z.object({ revision: z.number() });

/** Reads the clients of a Connection and hands them to `child`, or returns them. */
function reader(
  id: string,
  connection: string,
  triggers: JsonValue[],
  child?: string
): { id: string } & Record<string, JsonValue> {
  return {
    id,
    name: id,
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers },
      {
        id: "clients",
        name: "Read the clients",
        type: "operation",
        operation: `connection.${connection}.echo`,
        input: { text: { value: "clients" } }
      },
      ...(child === undefined
        ? []
        : [
            {
              id: "child",
              name: "Hand them on",
              type: "workflow",
              workflow: child,
              input: { clients: ref("clients", "clients") }
            }
          ]),
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };
}

/** Starts `child` with its own input: reads nothing itself. */
function relay(
  id: string,
  child: string,
  triggers: JsonValue[] = [{ kind: "parent" }]
): { id: string } & Record<string, JsonValue> {
  return {
    id,
    name: id,
    runAs: "workflow-runner",
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers },
      {
        id: "child",
        name: "Hand on",
        type: "workflow",
        workflow: child,
        input: { clients: ref("start", "input.clients") }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };
}

/** What a key builds: it keeps its input, as a step writing a Data Store would. */
const KEEPER = {
  id: "keep-clients",
  name: "Keep clients",
  runAs: "workflow-runner",
  inputs: { type: "object" },
  outputs: { type: "object" },
  steps: [
    { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "parent" }] },
    {
      id: "result",
      name: "Result",
      type: "output",
      input: { clients: ref("start", "input.clients") }
    }
  ]
};

describe("a Workflow a credential published, at its start", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  const ready = async (now?: () => Date) => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { personalKeys: true, definitions: "assets", ...(now ? { now } : {}) }
    );
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    await expose(t, "crm", true);
    // hr is the Connection whose admin keeps it from outside clients.
    await expose(t, "hr", false);
    const key = personalKeyToken(t, (await issuePersonalKey(t, SCOPES, t.root.id)).secret);
    return { t, key: await key };
  };

  const expose = (t: WorkflowFixture, connection: string, outside: boolean) =>
    t.seed(connection, {
      displayName: connection,
      operations: [
        operationOf("echo", { exposure: outside ? ["workflow", "outside"] : ["workflow"] })
      ]
    });

  /** Writes the definition as a draft and publishes it, by the key where given. */
  async function publish(
    t: WorkflowFixture,
    manifest: { id: string } & Record<string, unknown>,
    headers?: Record<string, string>
  ) {
    const current = await t.call(t.root.id, "assets.get", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id }
    });
    const written = await t.call(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
      payload: {
        config: { name: manifest.id, manifest },
        expectedRevision:
          current.statusCode === 200 ? revisionSchema.parse(current.json()).revision : null
      },
      ...(headers ? { headers } : {})
    });
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = revisionSchema.parse(written.json());
    return { revision, response: await again(t, manifest.id, revision, headers) };
  }

  /** Publishes the revision once more, by the key where given. */
  const again = (
    t: WorkflowFixture,
    name: string,
    revision: number,
    headers?: Record<string, string>
  ) =>
    t.call(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name },
      payload: { revision },
      ...(headers ? { headers } : {})
    });

  const ok = (response: { statusCode: number; body: string }) =>
    expect(response.statusCode, response.body).toBe(200);

  const start = (t: WorkflowFixture, workflow: string) =>
    t.call(t.root.id, "workflows.start", {
      params: { workflow },
      payload: { input: { clients: [] } }
    });

  const expectStartRefused = (
    response: { statusCode: number; body: string; json(): unknown },
    workflow: string
  ) => {
    expect(response.statusCode, response.body).toBe(409);
    expect(errorSchema.parse(response.json()).error.details).toEqual({
      reason: "reach_person_only",
      workflow
    });
    expect(response.body).toContain("a person signed in to Catalyst publishes it again");
    // The starter may be no one who may read the Connection: it is not named.
    expect(response.body).not.toContain("hr");
    expect(response.body).not.toContain("crm");
  };

  const runOf = (response: { json(): unknown }) => runSchema.parse(response.json());

  it("refuses the start once a person re-publishes its child to read a closed Connection", async () => {
    const { t, key } = await ready();
    ok((await publish(t, reader("read-clients", "crm", [{ kind: "parent" }]))).response);
    const parent = relay("copy-clients", "read-clients", [{ kind: "manual" }]);
    ok((await publish(t, parent, key)).response);
    // The child reads crm, open to outside clients: the key's Workflow runs.
    const first = await start(t, "copy-clients");
    ok(first);
    const done = await t.finish(runOf(first).id);
    expect(done.status, JSON.stringify(done.error)).toBe("done");

    // A person re-publishes the child to read hr, kept from outside clients.
    ok((await publish(t, reader("read-clients", "hr", [{ kind: "parent" }]))).response);
    expectStartRefused(await start(t, "copy-clients"), "copy-clients");

    // A person publishes the key's revision again: it is the person's now, and it starts.
    const asset = revisionSchema.parse(
      (
        await t.call(t.root.id, "assets.get", {
          params: { kind: WORKFLOW_ASSET_KIND, name: "copy-clients" }
        })
      ).json()
    );
    ok(await again(t, "copy-clients", asset.revision));
    const byPerson = await start(t, "copy-clients");
    ok(byPerson);
    expect((await t.finish(runOf(byPerson).id)).status).toBe("done");
  });

  it("skips its schedule once outside is taken off an operation it calls", async () => {
    const { t, key } = await ready(() => NOW);
    const scheduled = reader("copy-clients", "crm", [
      { kind: "schedule", cron: "0 * * * *" },
      { kind: "manual" }
    ]);
    const { revision } = await publish(t, scheduled, key);
    // crm's admin takes outside back after the key's publish.
    await expose(t, "crm", false);
    const worker = t.worker(
      t.workflows.jobHandlers.filter(
        (handler) => handler.kind.kind === workflowScheduleJobKind.kind
      )
    );
    await worker.runDue();
    expect(
      await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "copy-clients" })
    ).toEqual([]);
    const skipped = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "workflow_run.tick_skipped"
    });
    expect(skipped.map((event) => event.metadata)).toEqual([
      expect.objectContaining({ workflow: "copy-clients", reason: "reach_person_only" })
    ]);
    expect(t.executed).toEqual([]);
    expectStartRefused(await start(t, "copy-clients"), "copy-clients");

    // A person's publish of the same revision: the schedule starts it again.
    ok(await again(t, "copy-clients", revision));
    await worker.runDue();
    expect(
      (await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "copy-clients" })).map(
        (run) => run.trigger
      )
    ).toContain("schedule");
  });

  it("starts as before what a key published that reaches only open data, and what a person published that reads closed data", async () => {
    const { t, key } = await ready();
    ok((await publish(t, reader("open-clients", "crm", [{ kind: "manual" }]), key)).response);
    const byKey = await start(t, "open-clients");
    ok(byKey);
    expect((await t.finish(runOf(byKey).id)).status).toBe("done");

    ok((await publish(t, reader("hr-clients", "hr", [{ kind: "manual" }]))).response);
    const byPerson = await start(t, "hr-clients");
    ok(byPerson);
    expect((await t.finish(runOf(byPerson).id)).status).toBe("done");
  });
});

describe("a child a credential published, and the Workflows that start it", () => {
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
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    await expose(t, "crm", true);
    await expose(t, "hr", false);
    const key = personalKeyToken(t, (await issuePersonalKey(t, SCOPES, t.root.id)).secret);
    return { t, key: await key };
  };

  const expose = (t: WorkflowFixture, connection: string, outside: boolean) =>
    t.seed(connection, {
      displayName: connection,
      operations: [
        operationOf("echo", { exposure: outside ? ["workflow", "outside"] : ["workflow"] })
      ]
    });

  async function publish(
    t: WorkflowFixture,
    manifest: { id: string } & Record<string, unknown>,
    headers?: Record<string, string>
  ) {
    const current = await t.call(t.root.id, "assets.get", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id }
    });
    const written = await t.call(t.root.id, "assets.put", {
      params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
      payload: {
        config: { name: manifest.id, manifest },
        expectedRevision:
          current.statusCode === 200 ? revisionSchema.parse(current.json()).revision : null
      },
      ...(headers ? { headers } : {})
    });
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = revisionSchema.parse(written.json());
    return {
      revision,
      response: await t.call(t.root.id, "assets.publish", {
        params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
        payload: { revision },
        ...(headers ? { headers } : {})
      })
    };
  }

  const ok = (response: { statusCode: number; body: string }) =>
    expect(response.statusCode, response.body).toBe(200);

  const expectCallersRefused = (
    response: { statusCode: number; body: string; json(): unknown },
    callers: string
  ) => {
    expect(response.statusCode, response.body).toBe(403);
    expect(errorSchema.parse(response.json()).error.details).toEqual({
      reason: "reach_person_only",
      workflow: "keep-clients"
    });
    expect(response.body).toContain(callers);
    expect(response.body).toContain("only a person signed in to Catalyst publishes it");
  };

  it("refuses a key's publish of a child that a live Workflow reading a closed Connection starts", async () => {
    const { t, key } = await ready();
    ok((await publish(t, KEEPER)).response);
    ok((await publish(t, reader("copy-hr", "hr", [{ kind: "manual" }], "keep-clients"))).response);
    // The child reads nothing itself: its own reach is open, its parent's is not.
    const byKey = await publish(t, { ...KEEPER, name: "Keep clients again" }, key);
    expectCallersRefused(byKey.response, "the Workflow 'copy-hr'");
    // The person publishes the same revision.
    const byPerson = await t.call(t.root.id, "assets.publish", {
      params: { kind: WORKFLOW_ASSET_KIND, name: "keep-clients" },
      payload: { revision: byKey.revision }
    });
    ok(byPerson);
  });

  it("refuses it through a Workflow between, and names only Workflows the key may read", async () => {
    const { t, key } = await ready();
    ok((await publish(t, KEEPER)).response);
    ok((await publish(t, relay("relay-clients", "keep-clients"))).response);
    ok((await publish(t, reader("copy-hr", "hr", [{ kind: "manual" }], "relay-clients"))).response);
    const byKey = await publish(t, { ...KEEPER, name: "Keep clients again" }, key);
    expectCallersRefused(byKey.response, "the Workflow 'copy-hr'");
    expect(byKey.response.body).not.toContain("relay-clients");
  });

  it("lets a key publish a child that only Workflows reaching open data start", async () => {
    const { t, key } = await ready();
    ok((await publish(t, KEEPER)).response);
    ok(
      (await publish(t, reader("copy-crm", "crm", [{ kind: "manual" }], "keep-clients"))).response
    );
    ok((await publish(t, { ...KEEPER, name: "Keep clients again" }, key)).response);
    const started = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "copy-crm" },
      payload: { input: {} }
    });
    ok(started);
    expect((await t.finish(runSchema.parse(started.json()).id)).status).toBe("done");
  });

  it("refuses the child's start from a parent a person later published to read a closed Connection", async () => {
    const { t, key } = await ready();
    ok((await publish(t, KEEPER)).response);
    ok(
      (await publish(t, reader("copy-clients", "crm", [{ kind: "manual" }], "keep-clients")))
        .response
    );
    // The parent reaches open data, so the key publishes the child.
    const byKey = await publish(t, { ...KEEPER, name: "Keep clients again" }, key);
    ok(byKey.response);
    // A person publishes the parent to read hr, which they may: a person's publish.
    ok(
      (await publish(t, reader("copy-clients", "hr", [{ kind: "manual" }], "keep-clients")))
        .response
    );
    const started = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "copy-clients" },
      payload: { input: {} }
    });
    ok(started);
    const { id } = runSchema.parse(started.json());
    const ended = await t.finish(id);
    expect(ended.status).toBe("failed");
    const child = (await stepRunsOf(t, id)).find((step) => step.stepId === "child");
    expect(child?.error?.code).toBe("reach_person_only");
    expect(
      await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "keep-clients" })
    ).toEqual([]);

    // A person publishes the child again: the parent hands it on, as any person's child.
    ok(
      await t.call(t.root.id, "assets.publish", {
        params: { kind: WORKFLOW_ASSET_KIND, name: "keep-clients" },
        payload: { revision: byKey.revision }
      })
    );
    const next = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "copy-clients" },
      payload: { input: {} }
    });
    ok(next);
    expect((await t.finish(runSchema.parse(next.json()).id)).status).toBe("done");
  });

  it("walks past a run an operation step started, to the run whose step started it", async () => {
    const { t, key } = await ready();
    ok((await publish(t, KEEPER)).response);
    ok((await publish(t, relay("relay-clients", "keep-clients", [{ kind: "manual" }]))).response);
    // Only the relay starts the child, and it reaches open data: the key publishes the child.
    const byKey = await publish(t, { ...KEEPER, name: "Keep clients again" }, key);
    ok(byKey.response);
    // A person publishes a Workflow that reads hr and starts the relay by an operation step:
    // the relay's run is one of its own, with no parent.
    const copy = reader("copy-hr", "hr", [{ kind: "manual" }]);
    ok(
      (
        await publish(t, {
          ...copy,
          steps: [
            ...z.array(z.json()).parse(copy.steps).slice(0, 2),
            {
              id: "relay",
              name: "Start the relay",
              type: "operation",
              operation: "workflow.relay-clients.start",
              input: { clients: ref("clients", "clients") }
            },
            { id: "result", name: "Result", type: "output", input: {} }
          ]
        })
      ).response
    );
    const started = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "copy-hr" },
      payload: { input: {} }
    });
    ok(started);
    await t.finish(runSchema.parse(started.json()).id);
    const [relayed] = await t.stores.workflowRuns.listRuns({
      clientInstanceId,
      workflow: "relay-clients"
    });
    expect(relayed?.parentRunId).toBeUndefined();
    const ended = await t.finish(relayed?.id ?? "");
    expect(ended.status).toBe("failed");
    const child = (await stepRunsOf(t, ended.id)).find((step) => step.stepId === "child");
    expect(child?.error?.code).toBe("reach_person_only");
    expect(
      await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "keep-clients" })
    ).toEqual([]);
  });
});

describe("a continuation of a child a credential published", () => {
  let open: WorkflowFixture | undefined;
  afterEach(async () => {
    await open?.instance.close();
    open = undefined;
  });

  /** Writes erp's clients in histories of five step runs, each the next continuation. */
  function continuing() {
    const base = z
      .object({ steps: z.array(z.record(z.string(), z.json())) })
      .loose()
      .parse(
        JSON.parse(
          JSON.stringify(
            notifyClients({ continueAsNew: { position: "offset" }, onItemFailure: "continue" })
          ).replaceAll("connection.crm.", "connection.erp.")
        )
      );
    return {
      ...base,
      id: "keep-going",
      name: "Keep going",
      limits: { stepRuns: 5 },
      inputs: {
        type: "object",
        properties: { note: { type: "string" }, offset: { type: "integer" } },
        required: ["note"]
      },
      steps: base.steps.map((step) =>
        step.id === "start"
          ? { ...step, triggers: [{ kind: "parent" }] }
          : step.id === "clients"
            ? { ...step, dataset: { at: "clients" } }
            : step
      )
    };
  }

  /** Reads crm, then starts keep-going. */
  const parent = {
    id: "read-then-keep",
    name: "Read then keep",
    runAs: "workflow-runner",
    inputs: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
    outputs: { type: "object" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "clients",
        name: "Read the clients",
        type: "operation",
        operation: "connection.crm.echo",
        input: { text: { value: "clients" } }
      },
      {
        id: "child",
        name: "Keep going",
        type: "workflow",
        workflow: "keep-going",
        input: { note: ref("start", "input.note") }
      },
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };

  it("fails the next history once a run that started it reads data closed to outside clients", async () => {
    const t = await readyWorkflows(
      (fixture) => {
        open = fixture;
      },
      { personalKeys: true, definitions: "assets", datasetObjects: new MemoryObjectStorage() }
    );
    await t.allow({ kind: "service_principal", id: t.principal.id }, "workflow.use");
    t.state.centralSettings = [
      { operation: "connection.crm.write", value: "allow" },
      { operation: "connection.erp.write", value: "allow" }
    ];
    const expose = (connection: string, outside: boolean) => {
      const exposure = outside ? ["workflow", "outside"] : ["workflow"];
      return t.seed(connection, {
        displayName: connection,
        operations: [
          operationOf("echo", { exposure }),
          operationOf("write", { effect: "changing", exposure })
        ]
      });
    };
    await expose("crm", true);
    await expose("erp", true);
    const key = await personalKeyToken(t, (await issuePersonalKey(t, SCOPES, t.root.id)).secret);
    const publish = async (manifest: { id: string }, headers?: Record<string, string>) => {
      const written = await t.call(t.root.id, "assets.put", {
        params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
        payload: { config: { name: manifest.id, manifest }, expectedRevision: null },
        ...(headers ? { headers } : {})
      });
      expect(written.statusCode, written.body).toBe(200);
      const published = await t.call(t.root.id, "assets.publish", {
        params: { kind: WORKFLOW_ASSET_KIND, name: manifest.id },
        payload: { revision: revisionSchema.parse(written.json()).revision },
        ...(headers ? { headers } : {})
      });
      expect(published.statusCode, published.body).toBe(200);
    };
    await publish(continuing(), key);
    await publish(parent);
    const started = await t.call(t.root.id, "workflows.start", {
      params: { workflow: "read-then-keep" },
      payload: { input: { note: NOTE } }
    });
    expect(started.statusCode, started.body).toBe(200);
    const histories = async () =>
      (await t.stores.workflowRuns.listRuns({ clientInstanceId, workflow: "keep-going" })).sort(
        (a, b) => (a.continuation?.number ?? 1) - (b.continuation?.number ?? 1)
      );
    const worker = t.worker();
    for (let pass = 0; pass < 50 && (await histories()).length === 0; pass++) await worker.runDue();
    expect(await histories()).toHaveLength(1);
    // crm's admin takes outside back while the child's first history runs.
    await expose("crm", false);
    for (let pass = 0; pass < 150; pass++) {
      await worker.runDue();
      if ((await histories()).some((run) => run.status === "failed")) break;
    }
    const parts = await histories();
    expect(parts.map((part) => part.status)).toEqual(["continued", "failed"]);
    expect(parts.at(-1)?.error).toMatchObject({ code: "reach_person_only" });
    expect(parts.at(-1)?.error?.message).toContain("the Workflow that starts it");
  });
});
