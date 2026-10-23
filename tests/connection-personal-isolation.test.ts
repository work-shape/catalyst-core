import { createHmac, createHash, randomUUID } from "node:crypto";
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
  canonicalJson,
  unknownToJsonValue,
  dispatchConversationFollowUpJob,
  StoreBackedAuditRecorder,
  operationDenialError,
  isAuthenticatedServicePrincipal,
  type AgentRun,
  type AgentRunResumeState,
  type AuthenticatedUser,
  type Conversation,
  type OperationCall,
  type OperationCallRuntime,
  type OperationOrigin
} from "@work-shape/catalyst-core";
import {
  runOperation,
  executeConfirmedOperation,
  type RunOperationDeps
} from "@work-shape/catalyst-tool-execution";
import {
  createOAuthWorld,
  issuePersonalKey,
  landingOf,
  type OAuthWorld
} from "./support/oauth-sign-in-world";
import { ApiKeyAccessTokenExchange } from "@work-shape/catalyst-auth";
import { StoreBackedAgentRuntime } from "@work-shape/catalyst-agent-runtime";
import { createPersonalOAuthProvider } from "./support/personal-oauth-provider";
import {
  getTestAgentRunJobs,
  getTestExecution,
  getTestJobs,
  createTestInstance,
  type TestServerOptions
} from "./support/test-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import { GuardrailRunner, createAuditingEventEmitter } from "@work-shape/catalyst-server";
import {
  createRecordingGovernance,
  createScriptedInstanceModelGateway
} from "./support/model-gateway";
import { withTestSql } from "./support/test-sql";
import { createTestConfig } from "./support/fixtures";

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
  world = await createOAuthWorld({
    extraPort: Number(new URL(fake.base).port),
    workerWithoutAuthSecrets: true
  });
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
  runtime: OperationCallRuntime = {},
  depsPatch: Partial<RunOperationDeps> = {}
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
      agentToolNames: () => [operation],
      ...depsPatch
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

  it.each(["session", "personal_key"] as const)(
    "dispatches a %s queued follow-up preserving its personal access authorization",
    async (source) => {
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
              instructions: "Read mail",
              modelProviderId: "local",
              toolNames: ["connection.mailbox.who"]
            }
          }
        ]
      });
      const p = await prepare(a, undefined, false);
      let followUpId: string;
      if (source === "session") {
        const queued = await world.instance.call(
          "conversations.runs.start",
          {
            params: { conversationId: p.root.id },
            payload: {
              followUp: "queue",
              idempotencyKey: randomUUID(),
              message: { text: "Read my mail next" }
            }
          },
          { headers: { cookie: alice, origin: "http://localhost:5173" } }
        );
        expect(queued.statusCode, queued.body).toBe(200);
        followUpId = z.object({ followUp: z.object({ id: z.string() }) }).parse(queued.json())
          .followUp.id;
      } else {
        const issued = await issuePersonalKey(world, alice, {
          name: "Follow-up isolation",
          scopes: ["agent.read"],
          expiresAt: new Date(Date.now() + 86_400_000).toISOString()
        });
        expect(issued.status).toBe(200);
        const { secret } = z.object({ secret: z.string() }).parse(await issued.json());
        const execution = getTestExecution(world.worker);
        const { identity: user } = await new ApiKeyAccessTokenExchange({
          secret: randomUUID() + randomUUID(),
          clientInstanceId,
          apiAccessStore: execution.store.apiAccess,
          personalApiKeys: { store: execution.store.personalApiKeys, users: execution.store.users }
        }).exchange(secret);
        if (isAuthenticatedServicePrincipal(user)) throw new Error("Not a personal key");
        expect(user.keyScopes).toBeDefined();
        // Today's HTTP key scopes exclude chat writes. Admit this real key identity at
        // the fixture's transport boundary, preserving keyScopes and delegatedActor, so
        // the queue and dispatch must enforce personal isolation themselves.
        const server: TestServerOptions = {
          ...execution,
          infrastructure: undefined,
          stores: execution.store,
          connections: execution.connections?.management,
          authAdapter: {
            id: "personal-key-queue-fixture",
            credentialMode: "explicit",
            authenticate: async () => ({ ...user, scopes: ["*"] })
          },
          agentRuntime: new StoreBackedAgentRuntime({ store: execution.store.agentRuns })
        };
        const keyed = await createTestInstance({ server });
        try {
          const queued = await keyed.call("conversations.runs.start", {
            params: { conversationId: p.root.id },
            payload: {
              followUp: "queue",
              idempotencyKey: randomUUID(),
              message: { text: "Read my mail next" }
            }
          });
          expect(queued.statusCode, queued.body).toBe(200);
          followUpId = z.object({ followUp: z.object({ id: z.string() }) }).parse(queued.json())
            .followUp.id;
        } finally {
          await keyed.close();
        }
      }
      const scope = { clientInstanceId, conversationId: p.root.id };
      expect(
        await world.worker.stores.followUps.getAuthorization({ ...scope, followUpId })
      ).toMatchObject({ subjectUserId: a.id, personalConnectionsAllowed: source === "session" });
      await world.worker.stores.agentRuns.updateAgentRunStatus({
        clientInstanceId,
        runId: p.run.id,
        status: "completed",
        updatedAt: new Date().toISOString()
      });
      await world.worker.stores.jobs.enqueue(
        dispatchConversationFollowUpJob,
        { conversationId: p.root.id, afterRunId: p.run.id },
        { clientInstanceId, subject: p.root.id, correlationId: randomUUID() }
      );
      await getTestJobs(world.instance).runDue();
      const item = await world.worker.stores.followUps.get({ ...scope, followUpId });
      expect(item?.status).toBe("dispatched");
      const run =
        item?.dispatchedRunId &&
        (await world.worker.stores.agentRuns.getAgentRun({
          clientInstanceId,
          runId: asAgentRunId(item.dispatchedRunId)
        }));
      if (!run) throw new Error("No dispatched run");
      expect(run.authorization?.personalConnectionsAllowed).toBe(source === "session");
      if (source === "session") {
        expect((await call({ ...p, run })).result).toMatchObject({ status: "done", output: mail });
        expect(fake.headers.at(-1)).toBe(`Bearer ${fake.lastAccess.get("A")}`);
      } else {
        await refused({ ...p, run });
      }
    }
  );

  it("confirms an inherited personal approval inline, then executes without retaining input or output", async () => {
    // This test drives the resumed worker itself, so the API worker must not race it.
    await getTestAgentRunJobs(world.instance).stop();
    const p = await prepare();
    const calls = await world.calls();
    const source = await calls.deps.registry.resolve("connection.mailbox.who");
    if (!source) throw new Error("No personal operation");
    const operation = "test.personal_confirmed";
    calls.registry.register({
      ...source,
      name: operation,
      effect: "changing",
      recordsEveryCall: undefined,
      defaultPolicy: undefined
    });
    const policy = {
      ...calls.deps.policy,
      instanceDefaults: { reading: "allow", changing: "approval" } as const
    };
    const from = { ...origin(p.run), toolName: operation };
    const patch = {
      operation,
      origin: from,
      effect: "changing" as const,
      idempotencyKey: randomUUID()
    };
    const runtime = {
      runFence: {
        runId: p.run.id,
        lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease" }
      }
    };
    const count = fake.headers.length;
    const held = await call(p, patch, runtime, { policy });
    expect(held.result.status).toBe("pending_confirmation");
    expect(held.run.inputRef).toBeUndefined();
    expect(fake.headers).toHaveLength(count);
    const key = calls.deps.personalInputHashKey;
    if (!key) throw new Error("No instance input hash key");
    const canonical = canonicalJson(unknownToJsonValue({ query: mail.query }));
    expect(held.run.inputHash).toBe(createHmac("sha256", key).update(canonical).digest("hex"));
    expect(held.run.inputHash).not.toBe(createHash("sha256").update(canonical).digest("hex"));
    // Arrange the worker's pause, then record the owner's decision through the real route.
    const resumeState: AgentRunResumeState = {
      version: 1,
      step: 0,
      stepMessageId: p.run.inputMessageId,
      modelInputFrom: { kind: "input" },
      toolCalls: [
        { toolCallId: from.toolCallId, toolName: operation, input: { query: mail.query } }
      ],
      doneToolCallIds: [],
      waiting: [
        {
          toolCallId: from.toolCallId,
          operationRunId: held.run.id,
          frozenInput: { query: mail.query }
        }
      ],
      repeatedToolCalls: {},
      compacted: false
    };
    await withTestSql(
      (sql) =>
        sql`update agent_runs set status = 'waiting_for_decision', resume_state = ${JSON.stringify(resumeState)}::jsonb where id = ${p.run.id}`
    );
    const decision = await world.instance.call(
      "operations.decide",
      {
        params: { runId: held.run.id },
        payload: { decision: "confirm" }
      },
      { headers: { cookie: alice, origin: "http://localhost:5173" } }
    );
    expect(decision.statusCode, decision.body).toBe(200);
    expect(decision.json()).toMatchObject({ run: { decision: { mode: "confirmed" } } });
    const waiting = {
      runId: held.run.id,
      call: {
        ...patch,
        actor: a,
        input: { query: mail.query },
        correlationId: randomUUID()
      }
    };
    const deps = { ...calls.deps, policy, agentToolNames: () => [operation] };
    const done = await executeConfirmedOperation(waiting, deps, { runtime });
    expect(done.execution).toBe("done");
    expect(done.outcome?.result).toMatchObject({ status: "done", output: mail });
    expect(fake.headers).toHaveLength(count + 1);
    expect(fake.headers.at(-1)).toBe(`Bearer ${fake.lastAccess.get("A")}`);
    const row = await calls.deps.runs.get({ clientInstanceId, id: held.run.id });
    expect(row).toMatchObject({
      status: "done",
      decision: { mode: "confirmed" },
      resultBytes: Buffer.byteLength(JSON.stringify(mail))
    });
    expect(row?.inputRef).toBeUndefined();
    expect(row?.output).toBeUndefined();
    const replay = await executeConfirmedOperation(waiting, deps, { runtime });
    expect(replay.execution).toBe("done");
    expect(fake.headers).toHaveLength(count + 1);
    expect(replay.run?.output).toBeUndefined();
  });

  it.each(["setting", "guardrail", "declared_default", "floor"] as const)(
    "explains a personal approval required by a %s without freezing input",
    async (source) => {
      const p = await prepare();
      const calls = await world.calls();
      const base = await calls.deps.registry.resolve("connection.mailbox.who");
      if (!base) throw new Error("No personal operation");
      const operation = `test.personal_approval_${source}`;
      calls.registry.register({
        ...base,
        name: operation,
        effect: "changing",
        recordsEveryCall: undefined,
        defaultPolicy: source === "declared_default" ? "approval" : "allow",
        ...(source === "floor" ? { policyFloor: "approval" as const } : {})
      });
      const approval = vi.fn();
      const patch: Partial<RunOperationDeps> = {
        approvals: { request: approval },
        policy: {
          ...calls.deps.policy,
          centralSettings: () => (source === "setting" ? [{ operation, value: "approval" }] : [])
        },
        ...(source === "guardrail"
          ? { events: { emit: async () => ({ outcome: "require_approval", guardrails: [] }) } }
          : {})
      };
      const count = fake.headers.length;
      const answer = await call(
        p,
        { operation, effect: "changing", idempotencyKey: randomUUID() },
        {},
        patch
      );
      expect(answer.result).toMatchObject({
        status: "denied",
        reason: { reason: "personal_connection_approval" }
      });
      if (answer.result.status !== "denied") throw new Error("Not denied");
      expect(operationDenialError(answer.result.reason)).toMatchObject({
        message: expect.stringContaining("Personal Connection calls can only ask their owner"),
        details: { reason: "personal_connection_approval" }
      });
      expect(approval).not.toHaveBeenCalled();
      expect(fake.headers).toHaveLength(count);
      expect(answer.run.inputRef).toBeUndefined();
      expect(answer.run.approvalRequestId).toBeUndefined();
    }
  );

  it.each([
    { outcome: "warn", effect: "reading" },
    { outcome: "block", effect: "reading" },
    { outcome: "block", effect: "changing" }
  ] as const)(
    "keeps a personal $effect judge's $outcome reason out of stored records",
    async ({ outcome, effect }) => {
      const p = await prepare();
      const config = createTestConfig({
        modelBindings: [{ id: "personalJudge", providerId: "local", model: "local" }]
      });
      const calls = await world.calls();
      const base = await calls.deps.registry.resolve("connection.mailbox.who");
      if (!base) throw new Error("No personal operation");
      const operation = `test.personal_guardrail_${effect}_${outcome}`;
      calls.registry.register({
        ...base,
        name: operation,
        effect,
        recordsEveryCall: undefined,
        defaultPolicy: "allow"
      });
      const guardrailName = `personal_reason_privacy_${effect}_${outcome}`;
      const reason = `The query is ${mail.query}`;
      const runner = new GuardrailRunner({
        clientInstanceId,
        config: {
          ...config,
          guardrails: {
            [guardrailName]: {
              on: "operation.before_call",
              outcome,
              check: {
                kind: "model_judge",
                modelBindingId: "personalJudge",
                instruction: "Check input"
              }
            }
          }
        },
        hits: world.worker.stores.guardrails,
        modelGateway: createScriptedInstanceModelGateway({
          config,
          usageGovernance: createRecordingGovernance(),
          modelProvider: {
            complete: async () => ({
              text: JSON.stringify({ violates: true, reason }),
              toolCalls: [],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
                source: "provider_reported",
                webSearchCallCount: 0
              }
            })
          }
        })
      });
      const events = createAuditingEventEmitter(
        new StoreBackedAuditRecorder({
          clientInstanceId,
          store: world.worker.stores.audit
        }),
        runner
      );
      const before = fake.headers.length;
      const answer = await call(
        p,
        { operation, effect, ...(effect === "changing" ? { idempotencyKey: randomUUID() } : {}) },
        {},
        { events }
      );
      expect(answer.result.status).toBe(outcome === "block" ? "denied" : "done");
      const stored = await withTestSql(async (sql) => ({
        runs: await sql`select * from operation_runs`,
        hits: await sql`select * from guardrail_hits`,
        audit: await sql`select * from audit_events`
      }));
      const hits = stored.hits.filter((hit) => hit.guardrail_name === guardrailName);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ outcome, subject_kind: "operation", message: "" });
      if (outcome === "block") {
        expect(fake.headers).toHaveLength(before);
        expect(answer.result).toMatchObject({
          reason: { guardrailReason: reason, message: expect.stringContaining(reason) }
        });
        const row = stored.runs.find((run) => run.id === answer.run.id);
        expect(row).toMatchObject({
          status: "denied",
          error: {
            code: "GUARDRAIL_BLOCKED",
            message: "A guardrail blocked the call",
            denial: {
              kind: "guardrail",
              guardrailId: guardrailName,
              message: "A guardrail blocked the call"
            }
          }
        });
        expect(row?.error.denial).not.toHaveProperty("guardrailReason");
      }
      expect(JSON.stringify(stored)).not.toContain(reason);
      expect(JSON.stringify(stored)).not.toContain(mail.query);
    }
  );

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
