import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import {
  asClientInstanceId,
  createPlatformId,
  type ClientInstanceId,
  type ExecutionWorkspace,
  type WorkspaceCommandOutput
} from "@vivd-catalyst/core";
import { PostgresPlatformStore } from "@vivd-catalyst/postgres-store";

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres("Postgres execution workspace store", () => {
  let store: PostgresPlatformStore;
  let secondStore: PostgresPlatformStore;
  let rawSql: Sql;

  beforeAll(async () => {
    store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    secondStore = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: false
    });
    rawSql = postgres(databaseUrl!, { max: 5 });
  });

  afterAll(async () => {
    await rawSql?.end();
    await secondStore?.close();
    await store?.close();
  });

  it("creates one execution workspace per conversation idempotently", async () => {
    const fixture = await createWorkspaceFixture(store);

    const repeated = await store.ensureExecutionWorkspace({
      clientInstanceId: fixture.clientInstanceId,
      conversationId: fixture.conversation.id,
      ownerUserId: fixture.ownerUserId,
      now: "2026-06-29T10:05:00.000Z"
    });

    expect(repeated).toMatchObject({
      id: fixture.workspace.id,
      clientInstanceId: fixture.clientInstanceId,
      conversationId: fixture.conversation.id,
      ownerUserId: fixture.ownerUserId,
      status: "active"
    });

    await expect(
      store.ensureExecutionWorkspace({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: fixture.conversation.id,
        ownerUserId: "wrong-owner"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(
      store.getExecutionWorkspace({
        clientInstanceId: fixture.clientInstanceId,
        workspaceId: fixture.workspace.id
      })
    ).resolves.toEqual(fixture.workspace);
    await expect(
      store.getExecutionWorkspaceForConversation({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: fixture.conversation.id
      })
    ).resolves.toEqual(fixture.workspace);
  });

  it("upserts and lists the workspace file manifest by path", async () => {
    const fixture = await createWorkspaceFixture(store);

    const first = await store.upsertWorkspaceFile({
      clientInstanceId: fixture.clientInstanceId,
      workspaceId: fixture.workspace.id,
      path: "reports/analysis.csv",
      objectKey: "workspace/first.csv",
      byteSize: 12,
      checksum: "sha256:first",
      mimeType: "text/csv",
      metadata: { source: "initial" },
      updatedAt: "2026-06-29T10:10:00.000Z"
    });
    const updated = await store.upsertWorkspaceFile({
      clientInstanceId: fixture.clientInstanceId,
      workspaceId: fixture.workspace.id,
      path: "reports/analysis.csv",
      objectKey: "workspace/updated.csv",
      byteSize: 21,
      checksum: "sha256:updated",
      mimeType: "text/csv",
      metadata: { source: "rerun" },
      updatedAt: "2026-06-29T10:11:00.000Z"
    });

    expect(updated).toMatchObject({
      workspaceId: fixture.workspace.id,
      conversationId: fixture.conversation.id,
      path: "reports/analysis.csv",
      objectKey: "workspace/updated.csv",
      byteSize: 21,
      checksum: "sha256:updated",
      metadata: { source: "rerun" }
    });
    expect(updated.createdAt).toBe(first.createdAt);

    await store.upsertWorkspaceFile({
      clientInstanceId: fixture.clientInstanceId,
      workspaceId: fixture.workspace.id,
      path: "notes.txt",
      objectKey: "workspace/notes.txt",
      byteSize: 5,
      checksum: "sha256:notes"
    });

    await expect(
      store.listWorkspaceFiles({
        clientInstanceId: fixture.clientInstanceId,
        workspaceId: fixture.workspace.id
      })
    ).resolves.toMatchObject([
      { path: "notes.txt" },
      { path: "reports/analysis.csv", objectKey: "workspace/updated.csv" }
    ]);
  });

  it("enqueues, claims, completes, and reads a command through separate store connections", async () => {
    const fixture = await createWorkspaceFixture(store);
    const command = await store.enqueueWorkspaceCommand({
      clientInstanceId: fixture.clientInstanceId,
      workspaceId: fixture.workspace.id,
      ownerUserId: fixture.ownerUserId,
      toolCallId: createPlatformId<"ToolCallId">("toolcall"),
      command: "python analysis.py",
      cwd: "reports",
      limits: {
        timeoutSeconds: 60,
        idleTimeoutSeconds: 30,
        maxStdoutBytes: 65536,
        maxStderrBytes: 65536,
        maxWorkspaceBytes: 104857600
      },
      expectedOutputs: [{ path: "reports/analysis.csv", kind: "text/csv" }],
      queuedAt: "2026-06-29T10:20:00.000Z"
    });

    expect(command).toMatchObject({
      workspaceId: fixture.workspace.id,
      conversationId: fixture.conversation.id,
      ownerUserId: fixture.ownerUserId,
      command: "python analysis.py",
      status: "queued",
      attempts: 0
    });
    await expect(
      store.countActiveWorkspaceCommands({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: fixture.conversation.id
      })
    ).resolves.toEqual({
      queued: 1,
      running: 0,
      cancelling: 0,
      total: 1
    });

    const claimed = await secondStore.claimNextWorkspaceCommand({
      clientInstanceId: fixture.clientInstanceId,
      workerId: "worker-a",
      leaseToken: "lease-a",
      now: "2026-06-29T10:21:00.000Z",
      leaseExpiresAt: "2026-06-29T10:22:00.000Z"
    });
    expect(claimed).toMatchObject({
      id: command.id,
      status: "running",
      leaseOwner: "worker-a",
      leaseToken: "lease-a",
      attempts: 1,
      startedAt: "2026-06-29T10:21:00.000Z"
    });
    await expect(
      store.countActiveWorkspaceCommands({
        clientInstanceId: fixture.clientInstanceId,
        ownerUserId: fixture.ownerUserId
      })
    ).resolves.toEqual({
      queued: 0,
      running: 1,
      cancelling: 0,
      total: 1
    });

    const output = commandOutput({
      exitCode: 0,
      stdoutPreview: "done",
      changedFiles: [
        {
          path: "reports/analysis.csv",
          byteSize: 21,
          checksum: "sha256:updated",
          objectKey: "workspace/updated.csv"
        }
      ]
    });
    const completed = await secondStore.completeWorkspaceCommand({
      clientInstanceId: fixture.clientInstanceId,
      commandId: command.id,
      leaseToken: "lease-a",
      output,
      completedAt: "2026-06-29T10:21:30.000Z"
    });
    expect(completed).toMatchObject({
      status: "completed",
      output,
      leaseToken: undefined,
      completedAt: "2026-06-29T10:21:30.000Z"
    });

    await expect(
      store.getWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: command.id
      })
    ).resolves.toMatchObject({
      status: "completed",
      output
    });
    await expect(
      store.countActiveWorkspaceCommands({
        clientInstanceId: fixture.clientInstanceId
      })
    ).resolves.toEqual({
      queued: 0,
      running: 0,
      cancelling: 0,
      total: 0
    });
  });

  it("atomically enforces command capacity during concurrent enqueue attempts", async () => {
    const fixture = await createWorkspaceFixture(store);
    const capacity = {
      perConversationActiveCommands: 1,
      perUserActiveCommands: 10,
      globalActiveCommands: 10
    };

    const attempts = await Promise.allSettled([
      store.enqueueWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        workspaceId: fixture.workspace.id,
        ownerUserId: fixture.ownerUserId,
        command: "sleep 1",
        limits: { timeoutSeconds: 60 },
        capacity,
        queuedAt: "2026-06-29T10:25:00.000Z"
      }),
      secondStore.enqueueWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        workspaceId: fixture.workspace.id,
        ownerUserId: fixture.ownerUserId,
        command: "sleep 2",
        limits: { timeoutSeconds: 60 },
        capacity,
        queuedAt: "2026-06-29T10:25:00.000Z"
      })
    ]);

    expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((result) => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toMatchObject({
        code: "CONFLICT",
        details: {
          scope: "conversation",
          activeCommands: 1,
          limit: 1
        }
      });
    }

    await expect(
      store.countActiveWorkspaceCommands({
        clientInstanceId: fixture.clientInstanceId,
        conversationId: fixture.conversation.id
      })
    ).resolves.toEqual({
      queued: 1,
      running: 0,
      cancelling: 0,
      total: 1
    });
  });

  it("fails a claimed command through a lease-token guarded update", async () => {
    const fixture = await createWorkspaceFixture(store);
    const command = await enqueueAndClaim(store, fixture, {
      leaseToken: "lease-fail",
      now: "2026-06-29T10:30:00.000Z",
      leaseExpiresAt: "2026-06-29T10:31:00.000Z"
    });

    await expect(
      store.failWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: command.id,
        leaseToken: "wrong-lease",
        error: {
          code: "RUNNER_EXITED",
          message: "Runner exited",
          category: "runner_error"
        },
        failedAt: "2026-06-29T10:30:10.000Z"
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const failed = await store.failWorkspaceCommand({
      clientInstanceId: fixture.clientInstanceId,
      commandId: command.id,
      leaseToken: "lease-fail",
      error: {
        code: "RUNNER_EXITED",
        message: "Runner exited",
        category: "runner_error"
      },
      output: commandOutput({
        exitCode: 1,
        stderrPreview: "traceback"
      }),
      failedAt: "2026-06-29T10:30:11.000Z"
    });

    expect(failed).toMatchObject({
      status: "failed",
      error: {
        code: "RUNNER_EXITED",
        category: "runner_error"
      },
      output: {
        exitCode: 1,
        stderrPreview: "traceback"
      },
      leaseToken: undefined,
      completedAt: "2026-06-29T10:30:11.000Z"
    });
  });

  it("supports queued and claimed command cancellation", async () => {
    const fixture = await createWorkspaceFixture(store);
    const queued = await store.enqueueWorkspaceCommand({
      clientInstanceId: fixture.clientInstanceId,
      workspaceId: fixture.workspace.id,
      ownerUserId: fixture.ownerUserId,
      command: "sleep 10",
      limits: { timeoutSeconds: 60 },
      queuedAt: "2026-06-29T10:40:00.000Z"
    });

    await expect(
      store.requestWorkspaceCommandCancellation({
        clientInstanceId: fixture.clientInstanceId,
        commandId: queued.id,
        reason: "user stopped it",
        requestedAt: "2026-06-29T10:40:05.000Z"
      })
    ).resolves.toMatchObject({
      status: "cancelled",
      cancellationReason: "user stopped it",
      completedAt: "2026-06-29T10:40:05.000Z"
    });

    const claimed = await enqueueAndClaim(store, fixture, {
      leaseToken: "lease-cancel",
      now: "2026-06-29T10:41:00.000Z",
      leaseExpiresAt: "2026-06-29T10:42:00.000Z"
    });
    const requested = await store.requestWorkspaceCommandCancellation({
      clientInstanceId: fixture.clientInstanceId,
      commandId: claimed.id,
      reason: "new user request",
      requestedAt: "2026-06-29T10:41:05.000Z"
    });
    expect(requested).toMatchObject({
      status: "cancelling",
      leaseToken: "lease-cancel",
      cancellationReason: "new user request"
    });

    await expect(
      store.cancelClaimedWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: claimed.id,
        leaseToken: "lease-cancel",
        reason: "new user request",
        cancelledAt: "2026-06-29T10:41:06.000Z"
      })
    ).resolves.toMatchObject({
      status: "cancelled",
      leaseToken: undefined,
      completedAt: "2026-06-29T10:41:06.000Z"
    });
  });

  it("does not clear a lease when cancellation races with command claim", async () => {
    const fixture = await createWorkspaceFixture(store);
    const command = await store.enqueueWorkspaceCommand({
      clientInstanceId: fixture.clientInstanceId,
      workspaceId: fixture.workspace.id,
      ownerUserId: fixture.ownerUserId,
      command: "sleep 10",
      limits: { timeoutSeconds: 60 },
      queuedAt: "2026-06-29T10:44:00.000Z"
    });

    let cancellation:
      | ReturnType<PostgresPlatformStore["requestWorkspaceCommandCancellation"]>
      | undefined;
    await rawSql.begin(async (tx) => {
      await tx`select id from workspace_commands where id = ${command.id} for update`;
      cancellation = store.requestWorkspaceCommandCancellation({
        clientInstanceId: fixture.clientInstanceId,
        commandId: command.id,
        reason: "user stopped it",
        requestedAt: "2026-06-29T10:44:05.000Z"
      });
      await waitForBlockedWorkspaceCommandUpdate(rawSql);

      await tx`
        update workspace_commands
        set status = 'running',
            lease_owner = 'worker-race',
            lease_token = 'lease-race',
            lease_expires_at = ${"2026-06-29T10:45:00.000Z"}::timestamptz,
            heartbeat_at = ${"2026-06-29T10:44:01.000Z"}::timestamptz,
            started_at = ${"2026-06-29T10:44:01.000Z"}::timestamptz,
            attempts = attempts + 1,
            updated_at = ${"2026-06-29T10:44:01.000Z"}::timestamptz
        where id = ${command.id}
      `;
    });
    await expect(cancellation!).resolves.toMatchObject({
      status: "cancelling",
      leaseOwner: "worker-race",
      leaseToken: "lease-race",
      cancellationReason: "user stopped it",
      completedAt: undefined
    });

    await expect(
      store.getWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: command.id
      })
    ).resolves.toMatchObject({
      status: "cancelling",
      leaseToken: "lease-race"
    });
  });

  it("does not resurrect a terminal command when cancellation races with completion", async () => {
    const fixture = await createWorkspaceFixture(store);
    const command = await enqueueAndClaim(store, fixture, {
      leaseToken: "lease-complete-race",
      now: "2026-06-29T10:46:00.000Z",
      leaseExpiresAt: "2026-06-29T10:47:00.000Z"
    });

    let cancellation:
      | Promise<
          | {
              status: "resolved";
              value: Awaited<
                ReturnType<PostgresPlatformStore["requestWorkspaceCommandCancellation"]>
              >;
            }
          | {
              status: "rejected";
              error: unknown;
            }
        >
      | undefined;
    await rawSql.begin(async (tx) => {
      await tx`select id from workspace_commands where id = ${command.id} for update`;
      cancellation = store
        .requestWorkspaceCommandCancellation({
          clientInstanceId: fixture.clientInstanceId,
          commandId: command.id,
          reason: "user stopped it late",
          requestedAt: "2026-06-29T10:46:05.000Z"
        })
        .then(
          (value) => ({ status: "resolved" as const, value }),
          (error: unknown) => ({ status: "rejected" as const, error })
        );
      await waitForBlockedWorkspaceCommandUpdate(rawSql);

      await tx`
        update workspace_commands
        set status = 'completed',
            lease_owner = null,
            lease_token = null,
            lease_expires_at = null,
            heartbeat_at = null,
            completed_at = ${"2026-06-29T10:46:04.000Z"}::timestamptz,
            updated_at = ${"2026-06-29T10:46:04.000Z"}::timestamptz
        where id = ${command.id}
      `;
    });
    const result = await cancellation!;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") {
      expect(result.error).toMatchObject({ code: "CONFLICT" });
    }

    await expect(
      store.getWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: command.id
      })
    ).resolves.toMatchObject({
      status: "completed",
      leaseToken: undefined,
      completedAt: "2026-06-29T10:46:04.000Z"
    });
  });

  it("recovers stale claimed commands as failed", async () => {
    const fixture = await createWorkspaceFixture(store);
    const stale = await enqueueAndClaim(store, fixture, {
      leaseToken: "lease-stale",
      now: "2026-06-29T10:50:00.000Z",
      leaseExpiresAt: "2026-06-29T10:51:00.000Z"
    });
    const active = await enqueueAndClaim(store, fixture, {
      leaseToken: "lease-active",
      now: "2026-06-29T10:52:00.000Z",
      leaseExpiresAt: "2026-06-29T10:55:00.000Z"
    });

    const recovered = await store.recoverStaleWorkspaceCommands({
      clientInstanceId: fixture.clientInstanceId,
      staleLeaseExpiredBefore: "2026-06-29T10:52:00.000Z",
      recoveredAt: "2026-06-29T10:52:05.000Z",
      error: {
        code: "WORKSPACE_COMMAND_STALE",
        message: "Workspace command lease expired",
        category: "stale_lease"
      },
      limit: 10
    });

    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      id: stale.id,
      status: "failed",
      error: {
        code: "WORKSPACE_COMMAND_STALE",
        category: "stale_lease"
      },
      leaseToken: undefined,
      completedAt: "2026-06-29T10:52:05.000Z"
    });

    await expect(
      store.getWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: active.id
      })
    ).resolves.toMatchObject({
      status: "running",
      leaseToken: "lease-active"
    });
  });
});

async function createWorkspaceFixture(store: PostgresPlatformStore): Promise<{
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  conversation: Awaited<ReturnType<PostgresPlatformStore["createConversation"]>>;
  workspace: ExecutionWorkspace;
}> {
  const clientInstanceId = asClientInstanceId(`client_${globalThis.crypto.randomUUID()}`);
  const ownerUserId = `user_${globalThis.crypto.randomUUID()}`;
  const conversation = await store.createConversation({
    clientInstanceId,
    ownerUserId,
    ownerExternalUserId: `external_${ownerUserId}`,
    title: "Workspace test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const workspace = await store.ensureExecutionWorkspace({
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId,
    now: "2026-06-29T10:00:00.000Z"
  });
  return {
    clientInstanceId,
    ownerUserId,
    conversation,
    workspace
  };
}

async function enqueueAndClaim(
  store: PostgresPlatformStore,
  fixture: {
    clientInstanceId: ClientInstanceId;
    ownerUserId: string;
    workspace: ExecutionWorkspace;
  },
  lease: {
    leaseToken: string;
    now: string;
    leaseExpiresAt: string;
  }
) {
  await store.enqueueWorkspaceCommand({
    clientInstanceId: fixture.clientInstanceId,
    workspaceId: fixture.workspace.id,
    ownerUserId: fixture.ownerUserId,
    command: "node script.js",
    limits: { timeoutSeconds: 60 },
    queuedAt: lease.now
  });
  const claimed = await store.claimNextWorkspaceCommand({
    clientInstanceId: fixture.clientInstanceId,
    workerId: "worker-test",
    leaseToken: lease.leaseToken,
    now: lease.now,
    leaseExpiresAt: lease.leaseExpiresAt
  });
  if (!claimed) {
    throw new Error("Expected workspace command to be claimed");
  }
  return claimed;
}

async function waitForBlockedWorkspaceCommandUpdate(sql: Sql): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const blocked = await sql`
      select 1
      from pg_stat_activity
      where wait_event_type = 'Lock'
        and query ilike '%workspace_commands%'
      limit 1
    `;
    if (blocked.length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for blocked workspace command update");
}

function commandOutput(input: Partial<WorkspaceCommandOutput>): WorkspaceCommandOutput {
  return {
    exitCode: input.exitCode ?? 0,
    stdoutPreview: input.stdoutPreview ?? "",
    stderrPreview: input.stderrPreview ?? "",
    durationMs: input.durationMs ?? 100,
    changedFiles: input.changedFiles ?? [],
    promotedArtifacts: input.promotedArtifacts ?? [],
    truncated: input.truncated ?? {
      stdout: false,
      stderr: false
    }
  };
}
