import { afterEach, describe, expect, it } from "vitest";
import {
  asConversationId,
  createPlatformId,
  getAuthPrincipal,
  getAuthScopes,
  isAuthenticatedServicePrincipal,
  type AgentRun,
  type AuthenticatedUser
} from "@work-shape/catalyst-core";
import { HmacServiceAccessTokenAuthAdapter } from "@work-shape/catalyst-auth";
import {
  createClientInstanceAgentRunWorker,
  type ClientInstanceAgentRunWorker
} from "@work-shape/catalyst-client-assembly";
import { clientInstanceId, finding, useDataStoreInstance } from "./support/data-store-instance";
import { eventually, required } from "./support/assertions";
import { getTestAgentRunJobs } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { withTestSql } from "./support/test-sql";

const reads = [
  ["query", { sql: "select client_id from findings" }],
  ["preview_rows", { table: "findings" }],
  ["describe", {}]
] as const;

describe("personal key scopes on the Agent Run worker", () => {
  const { start, publishStore } = useDataStoreInstance();
  const workers: ClientInstanceAgentRunWorker[] = [];
  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      await worker.stop();
      await worker.close();
    }
  });

  async function setup(
    scopeInput: string[] | ((workspaceId: string) => string[]) = ["agent.read"]
  ) {
    const world = await start(
      true,
      undefined,
      undefined,
      undefined,
      { apiAccess: true },
      undefined,
      {}
    );
    // The API executes no runs; an independently assembled worker claims them below.
    await getTestAgentRunJobs(world.api).stop();
    await publishStore(world);
    const inserted = await world.api.call("data_stores.insert", {
      params: { store: "findings" },
      payload: { table: "findings", rows: [finding] }
    });
    expect(inserted.statusCode, inserted.body).toBe(200);
    const created = await world.api.call("conversations.create", {
      payload: { title: "Read findings", subject: { kind: "data_store", name: "findings" } }
    });
    expect(created.statusCode, created.body).toBe(200);
    const conversationId = asConversationId(created.json<{ id: string }>().id);
    const conversation = required(
      await world.stores.conversations.getConversation(clientInstanceId, conversationId)
    );
    const scopes =
      typeof scopeInput === "function"
        ? scopeInput(conversation.collaborationWorkspaceId)
        : scopeInput;
    const issued = await world.api.call("me.api_keys.create", {
      payload: {
        name: "Worker regression",
        scopes,
        expiresAt: new Date(Date.now() + 86_400_000).toISOString()
      }
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const exchanged = await world.api.call("access_tokens.exchange", {
      headers: { authorization: `Bearer ${issued.json<{ secret: string }>().secret}` }
    });
    expect(exchanged.statusCode, exchanged.body).toBe(200);
    const headers = {
      authorization: `Bearer ${exchanged.json<{ accessToken: string }>().accessToken}`
    };
    const execution = world.execution;
    const auth = new HmacServiceAccessTokenAuthAdapter({
      clientInstanceId,
      secret: required(execution.env.SERVICE_ACCESS_TOKEN_SECRET),
      apiAccessStore: world.stores.apiAccess,
      personalApiKeys: { store: world.stores.personalApiKeys, users: world.stores.users }
    });
    const actor = await auth.authenticate({
      headers,
      clientInstanceId,
      correlationId: "key-worker-regression"
    });
    if (isAuthenticatedServicePrincipal(actor)) throw new Error("Expected the key's owner");
    expect(actor.keyScopes).toEqual(scopes);
    const service = await createClientInstanceAgentRunWorker({
      config: execution.config,
      env: { ...execution.env, DATABASE_URL: await fileTestDatabaseUrl() },
      tools: [],
      capabilities: []
    });
    workers.push(service);
    const accept = async (verb: string, input: unknown, user: AuthenticatedUser = actor) => {
      // Personal keys cannot reach chat HTTP routes. Store the same authorization that run
      // acceptance keeps, then execute it on an independently assembled worker.
      const inputMessageId = createPlatformId<"MessageId">("msg");
      const accepted = await world.stores.agentRuns.prepareConversationRunStart({
        clientInstanceId,
        conversationId,
        ownerUserId: user.id,
        userMessage: {
          id: inputMessageId,
          text: `/tool ${verb.includes(".") ? verb : `data_store.findings.${verb}`} ${JSON.stringify(input)}`
        },
        run: {
          id: createPlatformId<"AgentRunId">("run"),
          clientInstanceId,
          conversationId,
          ownerUserId: user.id,
          inputMessageId,
          agentName: "platform-agent",
          status: "queued",
          authorization: {
            principal: getAuthPrincipal(user),
            subjectUserId: user.id,
            delegatedActor: user.delegatedActor,
            scopes: [...getAuthScopes(user)]
          },
          correlationId: "key-worker-regression"
        }
      });
      return accepted.run;
    };
    const execute = async (run: AgentRun, status = "completed") => {
      await eventually(async () => {
        await service.worker.runDue();
        const current = await world.stores.agentRuns.getAgentRun({
          clientInstanceId,
          runId: run.id
        });
        expect(current?.status).toBe(status);
      });
      return (
        await world.stores.agentRuns.listRunObservations({ clientInstanceId, runId: run.id })
      ).map((row) => row.payload);
    };
    return { world, actor, accept, execute };
  }

  it.each(reads)(
    "refuses %s when the starter key has no Data Store read scope",
    async (verb, input) => {
      const t = await setup();
      const events = await t.execute(await t.accept(verb, input));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "tool_call_failed",
          result: expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({ code: "not_allowed" })
          })
        })
      );
      expect(JSON.stringify(events)).not.toContain(finding.client_id);
    }
  );

  it("keeps the key's asset-read access on successive calls without lending row or write access", async () => {
    const t = await setup(["data_store.read"]);
    const asset = () => t.accept("platform.assets.get", {});
    expect(await t.execute(await asset())).toContainEqual(
      expect.objectContaining({
        type: "tool_call_completed",
        result: expect.objectContaining({ status: "success" })
      })
    );
    // data_store.read reaches asset definitions on a personal key, not data_store_rows:read.
    for (const [verb, input] of reads) {
      const events = await t.execute(await t.accept(verb, input));
      expect(events).toContainEqual(
        expect.objectContaining({
          type: verb === "describe" ? "tool_call_completed" : "tool_call_failed"
        })
      );
      expect(JSON.stringify(events)).not.toContain(finding.client_id);
    }
    const events = await t.execute(
      await t.accept("insert", { table: "findings", rows: [finding] })
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_failed" }));
    expect(await t.execute(await asset())).toContainEqual(
      expect.objectContaining({
        type: "tool_call_completed",
        result: expect.objectContaining({ status: "success" })
      })
    );
  });

  it("does not widen a scope on another workspace or asset to the instance store", async () => {
    const t = await setup((workspaceId) => [`data_store.read:${workspaceId}`]);
    const events = await t.execute(await t.accept("platform.assets.get", {}));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_failed" }));
    expect(JSON.stringify(events)).not.toContain(finding.client_id);
  });

  it("leaves a signed-in person's own rights intact", async () => {
    const t = await setup();
    const {
      keyScopes: _keyScopes,
      scopes: _scopes,
      delegatedActor: _delegatedActor,
      ...person
    } = t.actor;
    const events = await t.execute(await t.accept(...reads[0], person));
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_call_completed" }));
    expect(JSON.stringify(events)).toContain(finding.client_id);
  });

  it.each(["revoked", "expired"])(
    "executes nothing when the starter key was %s before the worker claimed it",
    async (state) => {
      const t = await setup(["data_store.read"]);
      const run = await t.accept(...reads[0]);
      const key = t.actor.delegatedActor;
      if (key?.kind !== "api_key") throw new Error("Expected the starter key");
      if (state === "revoked") {
        await t.world.stores.personalApiKeys.revokePersonalApiKey({
          clientInstanceId,
          keyId: key.id
        });
      } else {
        await withTestSql(
          (sql) =>
            sql`update api_credentials set expires_at = now() - interval '1 second' where id = ${key.id}`
        );
      }
      const events = await t.execute(run, "failed");
      expect(events.map((event) => event.type)).toEqual(["run_failed"]);
      expect(events[0]).toMatchObject({ error: { code: "FORBIDDEN" } });
    }
  );
});
