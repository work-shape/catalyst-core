import { LocalAgentRuntime } from "@vivd-catalyst/agent-runtime";
import {
  asUserId,
  defineJobHandler,
  type AuthenticatedUser,
  type Conversation,
  type Logger,
  type RuntimeCallContext
} from "@vivd-catalyst/core";
import { createPostgresJobWorker } from "@vivd-catalyst/postgres-store";
import { ToolRegistry } from "@vivd-catalyst/tool-execution";
import { ModelUsageGovernance } from "@vivd-catalyst/usage-governance";
import { describe, expect, it } from "vitest";
import { deferred } from "./support/assertions";
import { arrangeDeletion } from "./support/deletion-fixture";
import { kindOf } from "./support/job-executor-harness";
import { withTestModelGateway } from "./support/model-gateway";
import { usePostgresSuite, type PostgresSuite } from "./support/postgres-suite";
import { createStaticConfigAssetSource } from "./support/static-config-asset-source";

// One batch of the cleanup retry of a deletion.
const CLEANUP_BATCH = 100;

describe("a deletion against writes at the same moment, and cleanup that cannot go on", () => {
  const db = usePostgresSuite("deletionraces");
  const messagesOf = async (conversation: Conversation): Promise<string[]> => {
    const messages = await db.store.conversations.listMessages({
      clientInstanceId: conversation.clientInstanceId,
      conversationId: conversation.id
    });
    return messages.map((message) => message.role);
  };

  // Fails without the change: the check read past the uncommitted mark and the message was
  // stored, so no request ever waited.
  it("makes a worker's message wait for a mark that is being set, and refuses it", async () => {
    const t = await arrangeDeletion(db, "insert_race");
    const author = await t.createUser("author");
    const run = await t.startRun(await t.createConversation(author, "open"), author);
    await t.claimRun("lease-race");
    const marking = await db.hold(
      (tx) => tx`update product_users set deletion_requested_at = now() where id = ${author.id}`
    );
    const written = t.workerMessage(run, "lease-race");
    const refused = expect(written).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Conversation no longer accepts messages"
    });
    await t.untilWaitingForLock(1);
    await marking.commit();

    await refused;
    const messages = await db.store.conversations.listMessages({
      ...t.scope,
      conversationId: run.conversationId
    });
    expect(messages.map((message) => message.role)).toEqual(["user", "user"]);
  });

  // Fails without the change: the answer of the model was stored after the mark.
  it.each(["account", "workspace"] as const)(
    "stores nothing for a run of the local runtime whose model answers after the %s was marked",
    async (subject) => {
      const t = await arrangeDeletion(db, `local_${subject}`);
      const superadmin = await t.createUser("superadmin", ["user", "admin", "superadmin"]);
      const author = await t.createUser("author");
      const workspace = await t.createSharedWorkspace(author, "Shared");
      const conversation = await t.createConversation(
        author,
        "open",
        subject === "workspace" ? { workspace } : {}
      );
      const answer = deferred<void>();
      const asked = deferred<void>();
      const runtime = localRuntime(db.store, async () => {
        asked.resolve();
        await answer.promise;
      });
      const context = runtimeContext(t.scope.clientInstanceId, author);
      const input = await db.store.conversations.appendMessage({
        ...t.scope,
        conversationId: conversation.id,
        role: "user",
        text: "go"
      });
      const run = await runtime.start(
        {
          agentName: "test_agent",
          conversationId: conversation.id,
          inputMessageId: input.id,
          message: { text: "go" }
        },
        context
      );
      await asked.promise;

      if (subject === "account") {
        await db.store.users.markUserDeletionRequested({ ...t.scope, userId: asUserId(author.id) });
      } else {
        await db.store.workspaces.markWorkspaceDeletionRequested({
          ...t.scope,
          collaborationWorkspaceId: workspace.id
        });
      }
      const before = await messagesOf(conversation);
      answer.resolve();
      const events: string[] = [];
      for await (const event of runtime.observe(run.runId, context)) events.push(event.type);

      expect(events.at(-1)).toBe("run_failed");
      expect(await messagesOf(conversation)).toEqual(before);
      expect(before).not.toContain("assistant");

      // The run ended, so nothing holds the deletion.
      const deleted =
        subject === "account"
          ? await t.api.call("users.delete", { params: { userId: author.id } }, superadmin.id)
          : await t.api.call(
              "workspaces.delete",
              {
                params: { collaborationWorkspaceId: workspace.id },
                payload: { confirmName: workspace.name }
              },
              superadmin.id
            );
      expect(deleted.statusCode).toBe(202);
      await t.runDeletionJobs();
      if (subject === "account") await expect(t.userRow(author)).resolves.toEqual([]);
      else await expect(t.rowsOf(workspace)).resolves.toMatchObject({ workspaces: 0 });
    }
  );

  // Fails without the change: the statements had no condition on the mark and were accepted.
  it("refuses in the store a change of a user whose deletion was requested", async () => {
    const t = await arrangeDeletion(db, "update_race");
    const removed = await t.createUser("removed");
    const userId = asUserId(removed.id);
    await db.store.users.markUserDeletionRequested({ ...t.scope, userId });
    const refusal = { code: "CONFLICT", message: "User account is being deleted" };

    await expect(
      db.store.users.updateUser({ ...t.scope, userId, displayLabel: "Back", status: "active" })
    ).rejects.toMatchObject(refusal);
    await expect(
      db.store.users.upsertUserIdentity({
        ...t.scope,
        userId,
        authSource: "development",
        externalUserId: "another"
      })
    ).rejects.toMatchObject(refusal);
    await expect(
      db.store.users.deleteUserIdentity({
        ...t.scope,
        userId,
        authSource: "development",
        externalUserId: "removed"
      })
    ).rejects.toMatchObject(refusal);
    const [row] = await db.sql<Array<{ label: string; identities: number }>>`
      select display_label as label,
        (select count(*)::int from user_identities where user_id = ${removed.id}) as identities
      from product_users where id = ${removed.id}`;
    expect(row).toEqual({ label: "removed", identities: 1 });
    await expect(
      db.store.users.updateUser({ ...t.scope, userId: asUserId("user_unknown"), displayLabel: "x" })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  // Fails without the change: the record held the error with its message.
  it("logs of a failed job its class, code, kind and id and no message text", async () => {
    const clientInstanceId = db.clientInstance("job_log");
    const records: unknown[] = [];
    const recording = (bound: object): Logger => {
      const keep = (fields: unknown) => records.push({ ...bound, ...Object(fields) });
      return {
        debug: keep,
        info: keep,
        warn: keep,
        error: keep,
        child: (more) => recording({ ...bound, ...more })
      };
    };
    const kind = kindOf("test.leaky");
    const worker = createPostgresJobWorker({
      stores: db.store,
      clientInstanceId,
      schedules: [],
      logger: recording({}),
      handlers: [
        defineJobHandler({
          kind,
          slots: 1,
          async run() {
            throw Object.assign(new Error("insert failed, params: the-secret-value"), {
              code: "23505"
            });
          }
        })
      ]
    });
    const job = await db.store.jobs.enqueue(kind, { n: 1 }, { clientInstanceId });
    try {
      await worker.runDue();
    } finally {
      await worker.stop();
    }

    expect(records).toContainEqual(
      expect.objectContaining({
        jobId: job.id,
        kind: "test.leaky",
        attempt: 1,
        errorClass: "Error",
        code: "23505"
      })
    );
    expect(JSON.stringify(records)).not.toContain("the-secret-value");
    await db.sql`delete from platform_jobs where id = ${job.id}`;
  });

  // Fails without the change: the cleanup did nothing with the feature off and reported done,
  // so the first pass took the same full batch again and again and the request never answered.
  it("finishes with execution workspaces off and more than one batch of their rows", async () => {
    const t = await arrangeDeletion(db, "feature_off", { executionWorkspaceCleanup: undefined });
    const leaving = await t.createUser("leaving");
    for (let index = 0; index <= CLEANUP_BATCH; index += 1) {
      const conversation = await t.createConversation(leaving, `c${index}`, {
        withMessage: false
      });
      await db.store.executionWorkspaces.ensureExecutionWorkspace({
        ...t.scope,
        conversationId: conversation.id,
        ownerUserId: leaving.id
      });
      await db.store.conversations.deleteConversation({
        ...t.scope,
        conversationId: conversation.id,
        deletedAt: new Date().toISOString()
      });
    }

    expect((await t.api.call("me.delete", {}, leaving.id)).statusCode).toBe(200);
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    const [left] = await db.sql<Array<{ count: number }>>`
      select count(*)::int as count from execution_workspaces
      where client_instance_id = ${t.scope.clientInstanceId}`;
    expect(left?.count).toBe(0);
  }, 60_000);

  // Fails without the change: with the feature off the stored object was never looked at.
  it("fails the pass while a workspace object cannot be removed with the feature off", async () => {
    const t = await arrangeDeletion(db, "feature_off_objects", {
      executionWorkspaceCleanup: undefined
    });
    const leaving = await t.createUser("leaving");
    const conversation = await t.createConversation(leaving, "with a file");
    const data = await t.createWorkspaceData(conversation);

    expect((await t.api.call("me.delete", {}, leaving.id)).statusCode).toBe(202);
    await t.runDeletionJobs();
    await t.runDeletionJobs();
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "queued", attempts: 2 }
    ]);
    await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);
    expect(t.byteStore.has(data.objectKey)).toBe(true);
  });

  // Fails without the change: a full batch that reported done was taken again without end.
  it("fails a pass whose cleanups report done and remove nothing", async () => {
    const t = await arrangeDeletion(db, "no_progress");
    const leaving = await t.createUser("leaving");
    for (let index = 0; index < CLEANUP_BATCH; index += 1) {
      const conversation = await t.createConversation(leaving, `c${index}`, {
        withMessage: false
      });
      await t.createObjects(conversation);
      await db.store.conversations.deleteConversation({
        ...t.scope,
        conversationId: conversation.id,
        deletedAt: new Date().toISOString()
      });
    }
    const attachments = t.options.attachments;
    if (!attachments) throw new Error("The fixture has no attachment service");
    const deleteConversationAttachments = attachments.deleteConversationAttachments;
    attachments.deleteConversationAttachments = async () => ({
      attachmentCount: 0,
      fileObjectKeys: [],
      artifactObjectKeys: []
    });

    expect((await t.api.call("me.delete", {}, leaving.id)).statusCode).toBe(202);
    await t.runDeletionJobs();
    await expect(t.jobs()).resolves.toEqual([
      { kind: "account.delete", status: "queued", attempts: 1 }
    ]);
    await expect(t.userRow(leaving)).resolves.toEqual([{ marked: true }]);

    attachments.deleteConversationAttachments = deleteConversationAttachments;
    await t.runDeletionJobs();
    await expect(t.userRow(leaving)).resolves.toEqual([]);
    expect(t.byteStore.keys()).toEqual([]);
  }, 60_000);
});

type Store = PostgresSuite["store"];

function runtimeContext(
  clientInstanceId: RuntimeCallContext["clientInstanceId"],
  user: AuthenticatedUser
): RuntimeCallContext {
  return { clientInstanceId, correlationId: "corr_local_run", user };
}

/** The default runtime of an instance, on the store, with a model that answers when told. */
function localRuntime(store: Store, beforeAnswer: () => Promise<void>) {
  const provider = { id: "test-provider", type: "deterministic" as const, model: "test-model" };
  return new LocalAgentRuntime(
    withTestModelGateway({
      assetSource: createStaticConfigAssetSource({
        agents: [
          {
            skillNames: [],
            name: "test_agent",
            displayName: "Test Agent",
            instructions: "Help the user.",
            modelProviderId: provider.id,
            toolNames: [],
            initialPrompts: []
          }
        ]
      }),
      modelProviders: [provider],
      defaultModelProvider: provider,
      conversationHistory: store.conversations,
      agentRunStore: store.agentRuns,
      runObservationStore: store.agentRuns,
      modelProvider: {
        id: provider.id,
        async complete() {
          await beforeAnswer();
          return {
            text: "An answer after the mark.",
            toolCalls: [],
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
              source: "not_reported" as const,
              webSearchCallCount: 0
            }
          };
        }
      },
      toolRegistry: new ToolRegistry({ tools: [] }),
      toolExecution: {
        async authorize() {
          throw new Error("Tool execution should not be used");
        },
        async execute() {
          throw new Error("Tool execution should not be used");
        }
      },
      usageGovernance: new ModelUsageGovernance({ store: store.usage, budget: {}, safeguards: {} })
    })
  );
}
