import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  apiOperations,
  buildApiPath,
  connectionPersonContextSchema,
  type ApiOperationName
} from "@work-shape/catalyst-api-contract";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  asClientInstanceId,
  asServicePrincipalId,
  createPlatformId,
  type AuthenticatedIdentity,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import { runOperation } from "@work-shape/catalyst-tool-execution";
import { createTestConfig } from "./support/fixtures";
import { eventually } from "./support/assertions";
import { json, startRestTestServer, type RestTestServer } from "./support/rest-test-server";
import {
  createTestInstance,
  getTestExecution,
  getTestJobs,
  listenTestInstance,
  type TestInstance
} from "./support/test-instance";
import { generateSecretStoreKey } from "./support/test-connector";
import { withTestSql } from "./support/test-sql";

const clientInstanceId = asClientInstanceId("demo-local");
const connection = "scoped-rest";
const header = "x-audience-context";
const idSchema = z.object({ id: z.string() }).loose();
const runSchema = z.object({ id: z.string(), status: z.string() }).loose();
const servers: RestTestServer[] = [];
const instances: TestInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((instance) => instance.close()));
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function world(exposure: string[] = ["agent", "workflow"]) {
  const outside = await startRestTestServer((request, response) =>
    json({ audience: request.headers[header] })(request, response)
  );
  servers.push(outside);
  const config = parseClientInstanceConfig({
    ...createTestConfig({
      developmentAuth: {
        enabled: true,
        defaultUserId: "alice",
        users: ["alice", "bob", "unmapped", "reader"].map((id) => ({
          id,
          externalUserId: id,
          displayLabel: id,
          roles: id === "reader" ? ["user"] : ["user", "admin", "superadmin"]
        }))
      }
    }),
    modules: {
      assetManagement: { enabled: true },
      connections: { enabled: true },
      workflows: { enabled: true }
    },
    connections: {
      [connection]: {
        connectorType: "http_api",
        displayName: "Scoped REST",
        authScheme: "none",
        settings: { baseUrl: `http://127.0.0.1:${outside.port}`, personContextHeader: header },
        operations: [
          {
            name: "read",
            description:
              "Lists the clients visible to the acting identity. Use to read that identity's clients.",
            method: "GET",
            path: "/clients",
            effect: "reading",
            exposure
          }
        ]
      }
    },
    secretStore: { keys: [{ id: "cs15", ref: "CS15_TEST_SECRET_KEY" }] },
    egress: {
      allow: [
        {
          protocol: "http",
          host: "127.0.0.1",
          port: outside.port,
          network: "private",
          cidrs: ["127.0.0.1/32"]
        }
      ]
    }
  });
  const env = { CS15_TEST_SECRET_KEY: generateSecretStoreKey() };
  const api = await createTestInstance({ config, env, tools: [] });
  instances.push(api);
  await api.call("health.get");
  const address = await listenTestInstance(api);
  // All management calls cross an actual socket too, in addition to the connector's HTTP.
  async function http(
    operation: ApiOperationName,
    input: {
      params?: Record<string, string>;
      query?: Record<string, string>;
      payload?: unknown;
    } = {},
    user = "alice"
  ) {
    const descriptor = apiOperations[operation];
    const response = await fetch(address + buildApiPath(descriptor.path, input), {
      method: descriptor.method,
      headers: {
        "x-dev-user-id": user,
        ...(input.payload === undefined ? {} : { "content-type": "application/json" })
      },
      ...(input.payload === undefined ? {} : { body: JSON.stringify(input.payload) })
    });
    const body: unknown = await response.json();
    return { status: response.status, body };
  }
  const users = new Map<string, string>();
  for (const user of ["alice", "bob", "unmapped", "reader"]) {
    const response = await http("me.get", {}, user);
    expect(response.status).toBe(200);
    users.set(user, idSchema.parse(response.body).id);
  }
  const execution = await createTestInstance({ execution: { config, env, tools: [] } });
  instances.push(execution);
  const { operationCalls } = getTestExecution(execution);
  const userActor = (name: string): AuthenticatedIdentity => ({
    id: users.get(name) ?? name,
    externalUserId: name,
    displayLabel: name,
    roles: ["user", "admin", "superadmin"],
    permissions: [],
    permissionRefs: [],
    clientInstanceId,
    authSource: "test",
    scopes: ["*"]
  });
  async function call(
    actor: AuthenticatedIdentity,
    origin: OperationOrigin = {
      kind: "workflow",
      workflowRunId: "test-run",
      stepRunId: "test-step"
    }
  ) {
    return runOperation(
      {
        operation: `connection.${connection}.read`,
        effect: "reading",
        input: {},
        actor,
        origin,
        correlationId: `context-${crypto.randomUUID()}`
      },
      operationCalls.deps
    );
  }
  async function map(
    subjectKind: "user" | "service_principal",
    subjectId: string,
    value: string | null,
    expectedRowVersion: number | null = null
  ) {
    return http("connections.set_person_context", {
      params: { name: connection },
      payload: { subjectKind, subjectId, value, expectedRowVersion }
    });
  }
  async function principal(name: string) {
    const response = await http("service_principals.create", {
      payload: { name, displayLabel: name }
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const id = z.object({ principal: idSchema }).parse(response.body).principal.id;
    const asset = await api.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "connection",
      name: connection
    });
    if (!asset) throw new Error("Missing connection");
    const granted = await http("permissions.grant", {
      payload: {
        holderKind: "service_principal",
        holderId: id,
        action: "connection.use",
        scopeKind: "asset",
        scopeId: asset.id
      }
    });
    expect(granted.status, JSON.stringify(granted.body)).toBe(200);
    return id;
  }
  return { api, outside, http, users, userActor, call, map, principal, config, env };
}

function readingWorkflow(id: string, runAs: string, child?: string) {
  return {
    id,
    name: id,
    runAs,
    inputs: { type: "object" },
    outputs: { type: "object" },
    steps: [
      {
        id: "start",
        name: "Start",
        type: "trigger",
        triggers: [{ kind: "manual" }, { kind: "parent" }]
      },
      {
        id: "read",
        name: "Read",
        type: "operation",
        operation: `connection.${connection}.read`,
        input: {}
      },
      ...(child
        ? [{ id: "child", name: "Child", type: "workflow", workflow: child, input: {} }]
        : []),
      { id: "result", name: "Result", type: "output", input: {} }
    ]
  };
}

async function save(
  w: Awaited<ReturnType<typeof world>>,
  manifest: ReturnType<typeof readingWorkflow>
) {
  const params = { kind: "workflow", name: manifest.id };
  const saved = await w.http("assets.put", {
    params,
    payload: { config: { name: manifest.id, manifest }, expectedRevision: null }
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  return () => w.http("assets.publish", { params, payload: { revision: 1 } });
}

describe("person context on a shared Connection, with Postgres and real HTTP", () => {
  it.each(["header", "bridge"] as const)(
    "refuses adding %s to a Connection with the other already set until APP-16",
    async (adding) => {
      const w = await world();
      const name = "app-context-guard";
      const params = { kind: "connection", name };
      const original = w.config.connections[connection];
      if (!original) throw new Error("Missing fixture connection");
      const config = {
        ...original,
        name,
        displayName: "App context guard",
        settings: adding === "header" ? { baseUrl: original.settings.baseUrl } : original.settings,
        operations: original.operations.map((operation) => ({
          ...operation,
          exposure: adding === "header" ? ["bridge"] : ["agent", "workflow"]
        }))
      };
      const created = await w.http("assets.put", {
        params,
        payload: { config, expectedRevision: null }
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const refused = await w.http("assets.put", {
        params,
        payload: {
          config: {
            ...config,
            settings: original.settings,
            operations: config.operations.map((operation) => ({
              ...operation,
              exposure: ["bridge"]
            }))
          },
          expectedRevision: 1
        }
      });
      expect(refused.status, JSON.stringify(refused.body)).toBe(422);
      expect(refused.body).toMatchObject({
        error: {
          code: "VALIDATION_FAILED",
          message: expect.stringContaining("Person context is not available in Apps yet."),
          details: { reason: "person_context_app_unavailable" }
        }
      });
      const stored = await w.api.stores.configAssets.getConfigAsset({
        clientInstanceId,
        ...params
      });
      expect(stored).toMatchObject({ revision: 1, config });
      expect(w.outside.requests).toHaveLength(0);
    }
  );

  it("stops startup on release config that sets person context and App exposure", async () => {
    await expect(world(["agent", "bridge"])).rejects.toThrow(
      /Release config defines a Connection the instance cannot run\. connections\.scoped-rest\.operations\.0\.exposure: Person context is not available in Apps yet\./u
    );
    expect(servers[0]?.requests).toHaveLength(0);
  });

  it("always sends the mapped person's value and refuses an unmapped person without sending anything", async () => {
    const w = await world();
    expect((await w.map("user", w.userActor("alice").id, "team-a")).status).toBe(200);
    w.outside.answer((request, response) =>
      json({
        items: request.headers[header] === "team-a" ? [{ id: "client-a" }] : [{ id: "client-b" }]
      })(request, response)
    );
    const mapped = await w.call(w.userActor("alice"));
    expect(mapped.result).toMatchObject({
      status: "done",
      output: { items: [{ id: "client-a" }] }
    });
    expect(w.outside.requests.at(-1)?.headers[header]).toBe("team-a");
    const before = w.outside.requests.length;
    const refused = await w.call(w.userActor("unmapped"));
    expect(refused.run.error?.reason).toBe("person_context_unmapped");
    expect(refused.result.status).toBe("failed");
    expect(w.outside.requests).toHaveLength(before);
    const test = await w.http("connections.test", { params: { name: connection } }, "unmapped");
    expect(test.status).toBe(403);
    expect(JSON.stringify(test.body)).toContain("person_context_unmapped");
    expect(w.outside.requests).toHaveLength(before);
  });

  it("keeps concurrent people's calls apart and uses an explicitly mapped service principal", async () => {
    const w = await world();
    for (const name of ["alice", "bob"])
      expect((await w.map("user", w.userActor(name).id, `team-${name}`)).status).toBe(200);
    const principalId = await w.principal("runner");
    const service: AuthenticatedIdentity = {
      kind: "service",
      id: asServicePrincipalId(principalId),
      workflowRunId: createPlatformId<"WorkflowRunId">("wfrun"),
      displayLabel: "runner",
      permissions: [],
      permissionRefs: [],
      scopes: [],
      clientInstanceId,
      authSource: "workflow_run"
    };
    expect((await w.call(service)).run.error?.reason).toBe("person_context_unmapped");
    expect((await w.map("service_principal", principalId, "service-team")).status).toBe(200);
    const actors = [
      w.userActor("alice"),
      w.userActor("bob"),
      service,
      w.userActor("bob"),
      w.userActor("alice")
    ];
    const outcomes = await Promise.all(actors.map((actor) => w.call(actor)));
    expect(outcomes.map((outcome) => outcome.result)).toEqual(
      ["team-alice", "team-bob", "service-team", "team-bob", "team-alice"].map((audience) =>
        expect.objectContaining({ status: "done", output: { audience } })
      )
    );
    expect(w.outside.requests.every((request) => typeof request.headers[header] === "string")).toBe(
      true
    );
  });

  it("checks the Workflow principal at publish, and child runs send their own principal's context", async () => {
    const w = await world();
    const rootId = await w.principal("root-runner");
    const childId = await w.principal("child-runner");
    expect((await w.map("user", w.userActor("alice").id, "publisher-context")).status).toBe(200);
    const publishChild = await save(w, readingWorkflow("child-context", "child-runner"));
    const denied = await publishChild();
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toContain("person_context_unmapped");
    expect(w.outside.requests).toHaveLength(0);
    expect((await w.map("service_principal", childId, "child-context")).status).toBe(200);
    expect((await publishChild()).status).toBe(200);
    const childAsset = await w.api.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "workflow",
      name: "child-context"
    });
    if (!childAsset) throw new Error("Missing child Workflow");
    expect(
      (
        await w.http("permissions.grant", {
          payload: {
            holderKind: "service_principal",
            holderId: rootId,
            action: "workflow.use",
            scopeKind: "asset",
            scopeId: childAsset.id
          }
        })
      ).status
    ).toBe(200);
    const publishRoot = await save(
      w,
      readingWorkflow("root-context", "root-runner", "child-context")
    );
    expect((await publishRoot()).status).toBe(403);
    expect((await w.map("service_principal", rootId, "root-context")).status).toBe(200);
    const published = await publishRoot();
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const started = await w.http(
      "workflows.start",
      { params: { workflow: "root-context" }, payload: { input: {} } },
      "bob"
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const runId = runSchema.parse(started.body).id;
    const jobs = getTestJobs(w.api);
    await eventually(async () => {
      await jobs.runDue();
      const result = await w.http("workflows.get_run", { params: { runId } });
      expect(runSchema.parse(result.body).status).toBe("done");
    });
    expect(w.outside.requests.map((request) => request.headers[header])).toEqual([
      "root-context",
      "child-context"
    ]);
    // Removing the child's mapping after publication also fails closed in the actual child run.
    expect((await w.map("service_principal", childId, null, 1)).status).toBe(200);
    const next = await w.http("workflows.start", {
      params: { workflow: "root-context" },
      payload: { input: {} }
    });
    const nextId = runSchema.parse(next.body).id;
    await eventually(async () => {
      await jobs.runDue();
      const result = await w.http("workflows.get_run", { params: { runId: nextId } });
      expect(runSchema.parse(result.body).status).toBe("failed");
    });
    expect(w.outside.requests.map((request) => request.headers[header])).toEqual([
      "root-context",
      "child-context",
      "root-context"
    ]);
  });

  it("keeps values out of audit and runs, uses CAS across removal, and stores no token", async () => {
    const w = await world();
    const subjectId = w.userActor("alice").id;
    const value = "private-mapping-value";
    expect((await w.map("user", subjectId, value)).status).toBe(200);
    expect((await w.map("user", subjectId, null, 1)).status).toBe(200);
    expect((await w.call(w.userActor("alice"))).run.error?.reason).toBe("person_context_unmapped");
    expect((await w.map("user", subjectId, "new-context", 2)).status).toBe(200);
    expect((await w.map("user", subjectId, "stale", 1)).status).toBe(409);
    const read = await w.http("connections.person_context", {
      params: { name: connection },
      query: { subjectKind: "user", subjectId }
    });
    expect(connectionPersonContextSchema.parse(read.body)).toMatchObject({
      value: "new-context",
      rowVersion: 3
    });
    const audit = await w.api.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "connection.person_context_set"
    });
    expect(audit).toHaveLength(3);
    expect(JSON.stringify(audit)).not.toContain(value);
    expect(
      JSON.stringify(await w.api.stores.operationRuns.list({ clientInstanceId }))
    ).not.toContain(value);
    await withTestSql(async (sql) => {
      const rows =
        await sql`select scheme, secret_handle, secret_version, context_value from connection_bindings where subject = ${`person_context:user:${subjectId}`}`;
      expect(rows).toEqual([
        expect.objectContaining({
          scheme: "person_context",
          secret_handle: null,
          secret_version: null,
          context_value: "new-context"
        })
      ]);
      await expect(
        sql`update connection_bindings set secret_handle = 'invalid-handle' where subject = ${`person_context:user:${subjectId}`}`
      ).rejects.toMatchObject({ code: "23514" });
      await expect(
        sql`update connection_bindings set scheme = 'oauth' where subject = ${`person_context:user:${subjectId}`}`
      ).rejects.toMatchObject({ code: "23514" });
    });
  });

  it("clears mappings when release config changes the header, including a change back", async () => {
    const w = await world();
    const subjectId = w.userActor("alice").id;
    expect((await w.map("user", subjectId, "team-a")).status).toBe(200);
    const original = w.config.connections[connection];
    if (!original) throw new Error("Missing fixture connection");
    for (const nextHeader of ["x-other-context", header]) {
      const api = await createTestInstance({
        config: parseClientInstanceConfig({
          ...w.config,
          connections: {
            [connection]: {
              ...original,
              settings: { ...original.settings, personContextHeader: nextHeader }
            }
          }
        }),
        env: w.env,
        tools: []
      });
      instances.push(api);
      expect((await w.call(w.userActor("alice"))).run.error?.reason).toBe(
        "person_context_unmapped"
      );
    }
    expect(w.outside.requests).toHaveLength(0);
    // Removing and restoring the release entry must not restore a person's old value either.
    const cleared = await w.http("connections.person_context", {
      params: { name: connection },
      query: { subjectKind: "user", subjectId }
    });
    const version = connectionPersonContextSchema.parse(cleared.body).rowVersion;
    const remapped = await w.map("user", subjectId, "team-a", version);
    expect(remapped.status).toBe(200);
    expect(connectionPersonContextSchema.parse(remapped.body).value).toBe("team-a");
    for (const connections of [{}, { [connection]: original }]) {
      const api = await createTestInstance({
        config: parseClientInstanceConfig({ ...w.config, connections }),
        env: w.env,
        tools: []
      });
      instances.push(api);
    }
    expect((await w.call(w.userActor("alice"))).run.error?.reason).toBe("person_context_unmapped");
    expect(w.outside.requests).toHaveLength(0);
  });

  it("requires Connection write access to read or change a mapping, even for its owner", async () => {
    const w = await world();
    const subjectId = w.users.get("reader");
    if (!subjectId) throw new Error("Missing reader");
    for (const action of ["connection.read", "connection.use"]) {
      expect(
        (
          await w.http("permissions.grant", {
            payload: { holderKind: "user", holderId: subjectId, action, scopeKind: "instance" }
          })
        ).status
      ).toBe(200);
    }
    expect((await w.map("user", subjectId, "private-context")).status).toBe(200);
    const read = await w.http(
      "connections.person_context",
      { params: { name: connection }, query: { subjectKind: "user", subjectId } },
      "reader"
    );
    expect(read.status).toBe(403);
    expect(JSON.stringify(read.body)).not.toContain("private-context");
    const changed = await w.http(
      "connections.set_person_context",
      {
        params: { name: connection },
        payload: { subjectKind: "user", subjectId, value: "other-context", expectedRowVersion: 1 }
      },
      "reader"
    );
    expect(changed.status).toBe(403);
  });

  it("refuses invalid header values and unknown subjects before a write", async () => {
    const w = await world();
    expect((await w.map("user", "missing", "value")).status).toBe(404);
    for (const value of ["", "  ", "line\nbreak", "outside\u0100"])
      expect((await w.map("user", w.userActor("alice").id, value)).status).toBe(422);
    expect(w.outside.requests).toHaveLength(0);
  });
});
