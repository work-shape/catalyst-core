import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  asAgentRunId,
  asClientInstanceId,
  asServicePrincipalId,
  asApiCredentialId,
  createPlatformId,
  asUserId,
  asToolCallId,
  createUserPrincipal,
  type AgentRun,
  type AuthenticatedUser,
  type Conversation,
  type OperationCall,
  type OperationCallRuntime,
  type OperationOrigin,
  type CentralPolicySetting
} from "@work-shape/catalyst-core";
import {
  createShowViewTool,
  registerToolOperations,
  runOperation
} from "@work-shape/catalyst-tool-execution";
import { createOAuthWorld, landingOf, type OAuthWorld } from "./support/oauth-sign-in-world";
import { createPersonalOAuthProvider } from "./support/personal-oauth-provider";
import { getTestExecution, getTestJobs } from "./support/test-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { withTestSql } from "./support/test-sql";

// Real OAuth, encrypted bindings, persisted run provenance, and a fake API that records requests.
const clientInstanceId = asClientInstanceId("demo-local");
const mail = {
  id: "mail-id-canary",
  subject: "mail-subject-canary",
  sender: "mail-sender@example.test",
  query: "mail-query-canary",
  label: "mail-label-canary"
};
let world: OAuthWorld;
let fake: Awaited<ReturnType<typeof createPersonalOAuthProvider>>;
let alice: string, bob: string, a: AuthenticatedUser, b: AuthenticatedUser;

beforeAll(async () => {
  fake = await createPersonalOAuthProvider();
  world = await createOAuthWorld({ extraPort: Number(new URL(fake.base).port) });
  alice = await world.signIn("alice");
  bob = await world.signIn("bob");
  a = await world.identityOf(alice);
  b = await world.identityOf(bob);
  expect(await world.putConnection("mailbox", definition(), alice)).toBe(200);
  expect(await world.setSecret("mailbox", fake.clientSecret, alice)).toBe(200);
  await connect(alice, "A");
  await connect(bob, "B");
  fake.responseBody = mail;
}, 60_000);
afterEach(() => {
  vi.restoreAllMocks();
  fake.responseStatus = 200;
});
afterAll(async () => {
  await world?.close();
  await fake?.close();
});

function definition(exposure = ["agent"]) {
  return {
    connectorType: "http_api",
    displayName: "Personal mail",
    credentialMode: "user",
    settings: {
      baseUrl: `${fake.base}/personal-api`,
      oauth: {
        authorizationUrl: `${fake.base}/authorize`,
        tokenUrl: `${fake.base}/token`,
        clientId: "personal-client",
        scopes: ["openid", "email", "sample.read"]
      }
    },
    authScheme: "oauth",
    enabled: true,
    operations: [
      {
        name: "who",
        description: "Read the current account",
        method: "GET",
        path: "/who",
        query: { query: { schema: { type: "string" } } },
        effect: "reading",
        exposure,
        enabled: true
      }
    ]
  };
}
async function connect(cookie: string, person: string) {
  const started = await world.start("mailbox", cookie);
  const url = new URL(
    z.object({ authorizationUrl: z.string() }).parse(started.body).authorizationUrl
  );
  url.searchParams.set("person", person);
  expect(
    landingOf((await world.callback(await world.authorize(url.href), { cookie })).location).signIn
  ).toBe("connected");
}
async function conversation(actor = a, shared?: "private" | "workspace"): Promise<Conversation> {
  const workspace = shared
    ? await world.worker.stores.workspaces.createWorkspace({
        clientInstanceId,
        name: `Shared ${randomUUID()}`,
        kind: "shared",
        creatorUserId: asUserId(actor.id)
      })
    : await world.worker.stores.workspaces.ensurePersonalWorkspace({
        clientInstanceId,
        userId: asUserId(actor.id)
      });
  return world.worker.stores.conversations.createConversation({
    clientInstanceId,
    collaborationWorkspaceId: workspace.id,
    createdByUserId: asUserId(actor.id),
    createdByExternalUserId: actor.externalUserId,
    visibility: shared ?? "workspace",
    title: "Private mail",
    retainedUntil: "2099-01-01T00:00:00.000Z"
  });
}
async function prepare(actor = a, chat?: Conversation, proof = true) {
  const root = chat ?? (await conversation(actor));
  const message = await world.worker.stores.conversations.appendMessage({
    clientInstanceId,
    conversationId: root.id,
    role: "user",
    text: "Read my mail"
  });
  const run = await world.worker.stores.agentRuns.createAgentRun({
    id: asAgentRunId(`run_${randomUUID()}`),
    clientInstanceId,
    conversationId: root.id,
    ownerUserId: actor.id,
    inputMessageId: message.id,
    agentName: "personal-fixture",
    status: "running",
    startedAt: new Date().toISOString(),
    correlationId: randomUUID(),
    authorization: {
      personalConnectionsAllowed: proof,
      principal: createUserPrincipal(actor),
      subjectUserId: actor.id,
      scopes: ["*"]
    }
  });
  return { root, run, actor };
}
function origin(run: AgentRun): Extract<OperationOrigin, { kind: "agent" }> {
  return {
    kind: "agent",
    agentRunId: run.id,
    conversationId: run.conversationId,
    agentName: run.agentName,
    toolCallId: asToolCallId(`call_${randomUUID()}`),
    toolName: "connection.mailbox.who"
  };
}
async function call(
  prepared: Awaited<ReturnType<typeof prepare>>,
  patch: Partial<OperationCall> = {},
  runtime: OperationCallRuntime = {}
) {
  const calls = await world.calls();
  const operation = patch.operation ?? "connection.mailbox.who";
  return runOperation(
    {
      operation,
      effect: "reading",
      input: { query: mail.query },
      actor: prepared.actor,
      origin: { ...origin(prepared.run), toolName: operation },
      correlationId: randomUUID(),
      ...patch
    },
    {
      ...calls.deps,
      agentToolNames: () => [operation]
    },
    runtime
  );
}
function resolverSpy() {
  const resolver = getTestExecution(world.worker).connections?.credentials;
  if (!resolver) throw new Error("No credential resolver");
  return vi.spyOn(resolver, "resolveSignIn");
}
async function refused(
  prepared: Awaited<ReturnType<typeof prepare>>,
  patch: Partial<OperationCall> = {},
  runtime: OperationCallRuntime = {}
) {
  const spy = resolverSpy(),
    count = fake.headers.length;
  try {
    const answer = await call(prepared, patch, runtime);
    expect(answer.result).toMatchObject({
      status: "failed",
      error: { code: "FORBIDDEN", details: { reason: "personal_connection_context" } }
    });
    if (answer.result.status === "failed")
      expect(answer.result.error.message).toContain("personal connection cannot run here");
    expect(fake.headers).toHaveLength(count);
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
}

describe("personal Connection context isolation", () => {
  it("refuses every non-agent surface before resolving a token", async () => {
    const p = await prepare();
    const origins: OperationOrigin[] = [
      { kind: "user" },
      { kind: "cli" },
      { kind: "mcp", clientName: "platform MCP" },
      { kind: "schedule", scheduleId: "direct-schedule" },
      { kind: "app", appRevisionId: "rev", actionName: "read", pageSessionId: "session" },
      { kind: "workflow", workflowRunId: "workflow", stepRunId: "step" }
    ];
    for (const from of origins) await refused(p, { origin: from });
    await refused(p, {
      origin: { ...origin(p.run), boundBy: { id: "principal", label: "Workflow" } }
    });
  });

  it("refuses delegated people, keys, service principals and starts without first-party proof", async () => {
    const p = await prepare();
    await refused(p, {
      actor: {
        ...a,
        delegatedActor: { kind: "service_principal", id: "host", authSource: "embedding" }
      }
    });
    await refused(p, { actor: { ...a, keyScopes: ["*"] } });
    await refused(p, { actor: { ...a, keyScopes: [] } });
    await refused(p, {
      actor: {
        kind: "service",
        id: asServicePrincipalId("runner"),
        credentialId: asApiCredentialId("key_runner"),
        displayLabel: "Workflow",
        clientInstanceId,
        authSource: "workflow",
        permissionRefs: [],
        permissions: ["*"],
        scopes: ["*"]
      }
    });
    await refused(await prepare(a, undefined, false));
  });

  it("rejects Workflow exposure at save and obsolete stored exposure at runtime", async () => {
    expect(await world.putConnection("invalid-workflow", definition(["workflow"]), alice)).toBe(
      422
    );
    await withTestSql(
      (sql) =>
        sql`update config_asset_revisions set config = jsonb_set(config, '{operations,0,exposure}', '["agent", "workflow"]'::jsonb) where id = (select active_revision_id from config_assets where kind = 'connection' and name = 'mailbox')`
    );
    try {
      await refused(await prepare(), {
        origin: { kind: "workflow", workflowRunId: "old-row", stepRunId: "step" }
      });
    } finally {
      await withTestSql(
        (sql) =>
          sql`update config_asset_revisions set config = jsonb_set(config, '{operations,0,exposure}', '["agent"]'::jsonb) where id = (select active_revision_id from config_assets where kind = 'connection' and name = 'mailbox')`
      );
    }
    const step = await prepare();
    // A draft Workflow agent can act as a person; neither this thread nor its proof is a chat.
    await withTestSql(
      (sql) =>
        sql`update conversations set kind = 'run_thread', workflow_run_id = 'workflow-run', collaboration_workspace_id = null, created_by_user_id = null, created_by_external_user_id = null where id = ${step.root.id}`
    );
    await refused(step, {}, { workflowAgent: true });
  });

  it("refuses an agent tool reached through an App action and personal administrative probes", async () => {
    const p = await prepare();
    const calls = await world.calls();
    const definition = await calls.deps.registry.resolve("connection.mailbox.who");
    if (!definition) throw new Error("No operation");
    const spy = resolverSpy(),
      before = fake.headers.length;
    try {
      await expect(
        definition.execute(
          { query: mail.query },
          {
            runId: createPlatformId<"OperationRunId">("oprun"),
            actor: a,
            origin: origin(p.run),
            byAppAction: true,
            correlationId: randomUUID(),
            runtime: {},
            access: await calls.deps.authorizer.forActor(a),
            audit: calls.deps.audit
          }
        )
      ).rejects.toMatchObject({ details: { reason: "personal_connection_context" } });
      const probe = await world.test("mailbox", alice);
      expect(probe.text).toContain("personal_connection_context");
      expect(spy).not.toHaveBeenCalled();
      expect(fake.headers).toHaveLength(before);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses conversations another person can read, or that another person created", async () => {
    await refused(await prepare(a, await conversation(a, "workspace")));
    await refused(await prepare(a, await conversation(b)));
    await refused(await prepare(a, await conversation(b, "private")));
  });

  it("uses the current person's binding in a private chat and in a subagent of it", async () => {
    const p = await prepare(a, await conversation(a, "private"));
    expect((await call(p)).result).toMatchObject({ status: "done", output: mail });
    expect(fake.headers.at(-1)).toBe(`Bearer ${fake.lastAccess.get("A")}`);
    const child = await world.worker.stores.childAgentRuns.startSubagentRun({
      clientInstanceId,
      parentRunId: p.run.id,
      parentOperationRunId: createPlatformId<"OperationRunId">("oprun"),
      agentName: "personal-fixture",
      description: "Read my mail",
      task: "Read",
      correlationId: randomUUID()
    });
    if (child.status !== "started") throw new Error("No child");
    expect((await call({ ...p, run: child.run })).result.status).toBe("done");
    expect(fake.headers.at(-1)).toBe(`Bearer ${fake.lastAccess.get("A")}`);
    expect(
      (await world.worker.stores.conversations.getConversation(clientInstanceId, p.root.id))
        ?.personalDataAt
    ).toBeDefined();
    const preview = await call(p, {
      origin: {
        ...origin(p.run),
        draft: {
          kind: "agent_preview",
          asset: { kind: "agent", id: "preview-agent", name: "personal-fixture" },
          revisionId: "preview-revision",
          part: "agent"
        }
      }
    });
    expect(preview.result.status).toBe("done");
    const other = await prepare(b);
    expect((await call(other)).result.status).toBe("done");
    expect(fake.headers.at(-1)).toBe(`Bearer ${fake.lastAccess.get("B")}`);
    await world.disconnect("mailbox", bob);
    const missing = await call(other);
    expect(missing.result).toMatchObject({
      status: "failed",
      error: { details: { reason: "connection_not_connected" } }
    });
    expect(fake.headers.at(-1)).toBe(`Bearer ${fake.lastAccess.get("B")}`);
  });

  it("marks before a failed call, never clears the mark, and refuses a move that widens readers", async () => {
    const p = await prepare();
    fake.responseStatus = 500;
    expect((await call(p)).result.status).toBe("failed");
    const marked = await world.worker.stores.conversations.getConversation(
      clientInstanceId,
      p.root.id
    );
    expect(marked?.personalDataAt).toBeDefined();
    const snapshot = await world.instance.call(
      "conversations.thread.get",
      { params: { conversationId: p.root.id } },
      { headers: { cookie: alice } }
    );
    expect(snapshot.statusCode).toBe(200);
    expect(snapshot.json()).toMatchObject({ personalData: true });
    const dest = await conversation(a, "private");
    const move = (visibility: "private" | "workspace") =>
      world.instance.call(
        "conversations.move",
        {
          params: { conversationId: p.root.id },
          payload: { collaborationWorkspaceId: dest.collaborationWorkspaceId, visibility }
        },
        { headers: { cookie: alice, origin: "http://localhost:5173" } }
      );
    // End the fixture run so the service's idle check permits the private move.
    await world.worker.stores.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: p.run.id,
      status: "completed",
      updatedAt: new Date().toISOString()
    });
    const denied = await move("workspace");
    expect(denied.json()).toMatchObject({
      error: { details: { reason: "personal_conversation_private" } }
    });
    expect((await move("private")).statusCode).toBe(200);
    expect((await move("workspace")).json()).toMatchObject({
      error: { details: { reason: "personal_conversation_private" } }
    });
    expect(
      (await world.worker.stores.conversations.getConversation(clientInstanceId, p.root.id))
        ?.personalDataAt
    ).toBe(marked?.personalDataAt);
    // Store guard also rejects a direct visibility widening, including in the same workspace.
    await expect(
      world.worker.stores.conversations.moveConversation({
        clientInstanceId,
        conversationId: p.root.id,
        fromCollaborationWorkspaceId: dest.collaborationWorkspaceId,
        toCollaborationWorkspaceId: dest.collaborationWorkspaceId,
        visibility: "workspace"
      })
    ).rejects.toMatchObject({ details: { reason: "personal_conversation_private" } });
  });

  it("rechecks a move whose service read predates the first personal mark", async () => {
    const p = await prepare();
    await world.worker.stores.agentRuns.updateAgentRunStatus({
      clientInstanceId,
      runId: p.run.id,
      status: "completed",
      updatedAt: new Date().toISOString()
    });
    const destination = await conversation(a, "private");
    const store = world.instance.stores.conversations;
    const move = store.moveConversation.bind(store);
    const intercepted = vi
      .spyOn(store, "moveConversation")
      .mockImplementationOnce(async (input) => {
        // The service already read the unmarked root. Another process now marks it.
        await world.worker.stores.conversations.markPersonalData({
          clientInstanceId,
          conversationId: p.root.id,
          userId: a.id,
          at: new Date().toISOString()
        });
        return move(input);
      });
    try {
      const answer = await world.instance.call(
        "conversations.move",
        {
          params: { conversationId: p.root.id },
          payload: {
            collaborationWorkspaceId: destination.collaborationWorkspaceId,
            visibility: "workspace"
          }
        },
        { headers: { cookie: alice, origin: "http://localhost:5173" } }
      );
      expect(intercepted).toHaveBeenCalledOnce();
      expect(answer.json()).toMatchObject({
        error: { details: { reason: "personal_conversation_private" } }
      });
    } finally {
      intercepted.mockRestore();
    }
    // The inverse ordering also fails closed: a move first makes marking inadmissible.
    const other = await prepare();
    await world.worker.stores.conversations.moveConversation({
      clientInstanceId,
      conversationId: other.root.id,
      fromCollaborationWorkspaceId: other.root.collaborationWorkspaceId,
      toCollaborationWorkspaceId: destination.collaborationWorkspaceId,
      visibility: "workspace"
    });
    await refused(other);
  });

  it("tightens changing calls in marked roots and subagent threads, preserving stricter policy", async () => {
    const p = await prepare();
    await call(p);
    const calls = await world.calls();
    const execute = vi.fn(async () => ({ changed: true }));
    const base = {
      name: "connection.shared.change",
      effect: "changing" as const,
      defaultPolicy: "allow" as const,
      action: null,
      authorize: async () => ({ allowed: true as const }),
      scope: null,
      auth: "principal" as const,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      resource: () => undefined,
      timeoutMs: 1000,
      execute
    };
    calls.registry.addSource({
      resolve: async (name) => (name === base.name ? base : undefined),
      list: async () => ({ operations: [base], truncated: [] })
    });
    const runtime = {
      runFence: {
        runId: p.run.id,
        lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
      }
    };
    const held = await call(
      p,
      { operation: base.name, effect: "changing", idempotencyKey: randomUUID() },
      runtime
    );
    expect(held.result.status).toBe("pending_confirmation");
    expect(execute).not.toHaveBeenCalled();
    const child = await world.worker.stores.childAgentRuns.startSubagentRun({
      clientInstanceId,
      parentRunId: p.run.id,
      parentOperationRunId: createPlatformId<"OperationRunId">("oprun"),
      agentName: "personal-fixture",
      description: "Changing call",
      task: "Change",
      correlationId: randomUUID()
    });
    if (child.status !== "started") throw new Error("No child");
    const childResult = await call(
      { ...p, run: child.run },
      { operation: base.name, effect: "changing", idempotencyKey: randomUUID() },
      { subagent: true, runFence: { ...runtime.runFence, runId: child.run.id } }
    );
    expect(childResult.result).toMatchObject({
      status: "denied",
      reason: { reason: "confirmation_required" }
    });

    calls.registry.register({ ...base, name: "test.stricter_change", policyFloor: "deny" });
    expect(
      (
        await call(
          p,
          { operation: "test.stricter_change", effect: "changing", idempotencyKey: randomUUID() },
          runtime
        )
      ).result.status
    ).toBe("denied");
  });

  it.each(["show_view", "test.custom_view"])(
    "stores %s HTML displays as static after the mark",
    async (name) => {
      const p = await prepare();
      const calls = await world.calls();
      registerToolOperations(calls.registry, [{ ...createShowViewTool(), name }], {
        clientInstanceId,
        personalConversation: calls.deps.policy.personalConversation
      });
      const input = {
        html: "<p>private text</p><script>window.leak = true</script>",
        mode: "inline"
      };
      const before = await call(p, { operation: name, input });
      expect(before.result).toMatchObject({ status: "done", display: { kind: "html.rendered" } });
      await call(p);
      const after = await call(p, { operation: name, input });
      expect(after.result).toMatchObject({
        status: "done",
        display: { kind: "private_hydrated_view" }
      });
      expect(before.result).toMatchObject({ display: { kind: "html.rendered" } });
      const reads = vi.spyOn(world.worker.stores.conversations, "getConversation");
      for (const root of ["unreadable", "missing", "non-chat"] as const) {
        if (root === "unreadable") reads.mockRejectedValue(new Error("unreadable mark"));
        else
          reads.mockResolvedValue(
            root === "missing" ? undefined : { ...p.root, kind: "run_thread" }
          );
        expect((await call(p, { operation: name, input })).result).toMatchObject({
          status: "done",
          display: { kind: "private_hydrated_view" }
        });
      }
    }
  );

  it("preserves other display kinds in a marked conversation", async () => {
    const p = await prepare();
    await call(p);
    const calls = await world.calls();
    registerToolOperations(
      calls.registry,
      [
        {
          ...createShowViewTool(),
          name: "test.other_display",
          outputSchema: z.unknown(),
          execute: async () => ({
            status: "success" as const,
            output: {},
            display: {
              kind: "test.custom",
              version: 1,
              mode: "inline" as const,
              data: { value: "kept" }
            }
          })
        }
      ],
      { clientInstanceId, personalConversation: calls.deps.policy.personalConversation }
    );
    expect(
      (await call(p, { operation: "test.other_display", input: { html: "<p>x</p>" } })).result
    ).toMatchObject({
      status: "done",
      display: { kind: "test.custom", data: { value: "kept" } }
    });
  });

  it("holds mail.send at confirm despite an admin allow, leaving unmarked calls unchanged", async () => {
    const p = await prepare();
    const calls = await world.calls();
    // Exercise the policy independently of the instance's disabled system sender.
    const execute = vi.fn(async () => ({ sent: true }));
    const definition = {
      name: "mail.send",
      effect: "changing" as const,
      defaultPolicy: "allow" as const,
      action: null,
      authorize: () => ({ allowed: true as const }),
      scope: null,
      auth: "principal" as const,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      resource: () => undefined,
      timeoutMs: 1000,
      execute
    };
    const deps = {
      ...calls.deps,
      registry: {
        ...calls.registry,
        resolve: async (name: string) =>
          name === "mail.send" ? definition : calls.registry.resolve(name)
      },
      agentToolNames: () => ["mail.send"],
      policy: {
        ...calls.deps.policy,
        centralSettings: (): CentralPolicySetting[] => [{ operation: "mail.send", value: "allow" }]
      }
    };
    const send = () =>
      runOperation(
        {
          operation: "mail.send",
          effect: "changing",
          input: {},
          actor: a,
          origin: { ...origin(p.run), toolName: "mail.send" },
          correlationId: randomUUID(),
          idempotencyKey: randomUUID()
        },
        deps,
        {
          runFence: {
            runId: p.run.id,
            lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
          }
        }
      );
    expect((await send()).result.status).toBe("done");
    execute.mockClear();
    await call(p);
    expect((await send()).result.status).toBe("pending_confirmation");
    expect(execute).not.toHaveBeenCalled();
    deps.policy.centralSettings = () => [{ operation: "mail.send", value: "deny" as const }];
    expect((await send()).result.status).toBe("denied");
  });

  it("keeps no input reference or output in personal Operation Runs, with no mail in audit", async () => {
    const p = await prepare();
    const answer = await call(p);
    expect(answer.result.status).toBe("done");
    const row = await world.worker.stores.operationRuns.get({
      clientInstanceId,
      id: answer.run.id
    });
    expect(row).toMatchObject({
      ownerUserId: a.id,
      resultBytes: Buffer.byteLength(JSON.stringify(mail))
    });
    expect(row?.inputRef).toBeUndefined();
    expect(row?.output).toBeUndefined();
    expect(row?.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(row?.finishedAt).toBeDefined();
    expect(row?.startedAt).toBeDefined();
    const persisted = await withTestSql(async (sql) => ({
      audit: await sql`select * from audit_events`,
      runs: await sql`select * from operation_runs`
    }));
    for (const value of Object.values(mail)) expect(JSON.stringify(persisted)).not.toContain(value);
  });

  it("keeps changing personal output ephemeral and never freezes its input in an approval", async () => {
    const p = await prepare();
    await call(p);
    const calls = await world.calls();
    const operation = "test.personal_change";
    calls.registry.register({
      name: operation,
      effect: "changing",
      personalConnection: true,
      defaultPolicy: "allow",
      action: null,
      authorize: () => ({ allowed: true }),
      scope: null,
      auth: "principal",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      resource: () => undefined,
      timeoutMs: 1000,
      execute: async () => mail
    });
    const key = randomUUID();
    const result = await call(p, { operation, effect: "changing", idempotencyKey: key });
    expect(result.result).toMatchObject({ status: "done", output: mail });
    expect(result.run.output).toBeUndefined();
    expect(result.run.inputRef).toBeUndefined();
    expect(result.run.resultBytes).toBe(Buffer.byteLength(JSON.stringify(mail)));
    await expect(
      call(p, { operation, effect: "changing", idempotencyKey: key })
    ).rejects.toMatchObject({ code: "OUTPUT_NOT_RETAINED" });
    calls.registry.register({
      name: "test.personal_confirm",
      effect: "changing",
      personalConnection: true,
      defaultPolicy: "confirm",
      action: null,
      authorize: () => ({ allowed: true }),
      scope: null,
      auth: "principal",
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      resource: () => undefined,
      timeoutMs: 1000,
      execute: async () => mail
    });
    const confirmed = await call(
      p,
      { operation: "test.personal_confirm", effect: "changing", idempotencyKey: randomUUID() },
      {
        runFence: {
          runId: p.run.id,
          lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
        }
      }
    );
    expect(confirmed.result.status).toBe("pending_confirmation");
    expect(confirmed.run.inputRef).toBeUndefined();
    expect(confirmed.run.output).toBeUndefined();
    const inbox = await call(
      p,
      { operation: "test.personal_confirm", effect: "changing", idempotencyKey: randomUUID() },
      {
        unattended: true,
        runFence: {
          runId: p.run.id,
          lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
        }
      }
    );
    expect(inbox.result.status).toBe("denied");
    expect(inbox.run.inputRef).toBeUndefined();
    expect(inbox.run.approvalRequestId).toBeUndefined();
  });

  it("allows an owner-authorized scheduled run while its owner is signed out", async () => {
    await applyAtCurrentRevisions(world.instance.stores.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: "personal-fixture",
          config: {
            name: "personal-fixture",
            displayName: "Personal fixture",
            instructions: "Use the personal mail tool",
            modelProviderId: "local",
            toolNames: ["connection.mailbox.who"]
          }
        }
      ]
    });
    const root = await conversation();
    const response = await world.instance.call(
      "scheduled_starts.create",
      {
        payload: {
          collaborationWorkspaceId: root.collaborationWorkspaceId,
          agentName: "personal-fixture",
          prompt: "Read mail",
          cron: "0 6 * * *"
        }
      },
      { headers: { cookie: alice, origin: "http://localhost:5173" } }
    );
    expect(response.statusCode, response.body).toBe(200);
    const id = z.object({ id: z.string() }).parse(response.json()).id;
    // Revoke all first-party sessions: the scheduled job must rely on persisted owner consent.
    await withTestSql(async (sql) => {
      await sql`delete from session`;
      await sql`update platform_jobs set run_after = now() where kind = 'scheduled_prompt.fire' and subject = ${id} and status = 'queued'`;
    });
    await getTestJobs(world.instance).runDue();
    const [scheduled] = await withTestSql(
      (sql) =>
        sql<
          { agent_run_id: string }[]
        >`select agent_run_id from scheduled_start_runs where scheduled_start_id = ${id}`
    );
    if (!scheduled) throw new Error("No scheduled run");
    const run = await world.worker.stores.agentRuns.getAgentRun({
      clientInstanceId,
      runId: asAgentRunId(scheduled.agent_run_id)
    });
    if (!run) throw new Error("No scheduled agent run");
    expect(run.authorization?.personalConnectionsAllowed).toBe(true);
    const result = await call({ root, run, actor: a }, {}, { unattended: true });
    expect(result.result.status).toBe("done");
    expect(fake.headers.at(-1)).toBe(`Bearer ${fake.lastAccess.get("A")}`);
  });
});
