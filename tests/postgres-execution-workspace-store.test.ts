import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

  beforeAll(async () => {
    store = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: true
    });
    secondStore = await PostgresPlatformStore.connect({
      databaseUrl: databaseUrl!,
      runMigrations: false
    });
  });

  afterAll(async () => {
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
