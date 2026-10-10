import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { fileTestDatabaseUrl } from "./support/test-database";
import { createTestInstance } from "./support/test-instance";
import { afterAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import {
  asClientInstanceId,
  type ClientInstanceId,
  type ExecutionWorkspace,
  type PlatformStores
} from "@vivd-catalyst/core";

// How a job takes the row of its command: by id, under a lease the row carries for the
// previous release's worker.
describe("Postgres workspace command claim", () => {
  let store: PlatformStores;
  let rawSql: Sql;

  beforeAll(async () => {
    store = (await createTestInstance({ postgres: {} })).stores;
    rawSql = postgres(await fileTestDatabaseUrl(), { max: 2 });
  });

  afterAll(async () => {
    await rawSql?.end();
    await store?.close?.();
  });

  it("leaves a command under a live lease alone and takes back one that nobody holds", async () => {
    const fixture = await createWorkspaceFixture(store);
    const command = await enqueueAndClaim(store, fixture, "lease-first");
    const claimAs = (leaseOwnerId: string, leaseToken: string) =>
      store.executionWorkspaces.claimWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        commandId: command.id,
        leaseOwnerId,
        leaseToken,
        leaseMs: 60_000
      });

    // Held: the lease is live and belongs to another owner.
    await expect(claimAs("worker-other", "lease-other")).resolves.toEqual({ status: "held" });

    // The owner that holds it takes it back, and the claim is counted: it ran before.
    await expect(claimAs("worker-test", "lease-second")).resolves.toMatchObject({
      status: "claimed",
      row: { status: "running", leaseToken: "lease-second", attempts: 2 }
    });

    // A lease that ran out, by the database's clock, is anybody's.
    await rawSql`
      update workspace_commands set lease_expires_at = now() - interval '1 second'
      where id = ${command.id}
    `;
    await expect(claimAs("worker-other", "lease-third")).resolves.toMatchObject({
      status: "claimed",
      row: { leaseOwner: "worker-other", attempts: 3 }
    });

    await store.executionWorkspaces.failWorkspaceCommand({
      clientInstanceId: fixture.clientInstanceId,
      commandId: command.id,
      leaseToken: "lease-third",
      error: { code: "WORKSPACE_COMMAND_WORKER_LOST", message: "lost", category: "worker_lost" },
      failedAt: "2026-06-29T10:52:05.000Z"
    });
    await expect(claimAs("worker-other", "lease-fourth")).resolves.toEqual({ status: "finished" });
  });

  it("renews the lease on the row only under the token that holds it", async () => {
    const fixture = await createWorkspaceFixture(store);
    const command = await enqueueAndClaim(store, fixture, "lease-held");
    const renew = (leaseToken: string) =>
      store.executionWorkspaces.renewClaimedWorkspaceCommandLease({
        clientInstanceId: fixture.clientInstanceId,
        commandId: command.id,
        leaseToken,
        leaseMs: 60 * 60_000
      });

    await expect(renew("lease-of-another")).resolves.toBe(false);
    await expect(renew("lease-held")).resolves.toBe(true);

    const [row] = await rawSql<{ extended: boolean }[]>`
      select lease_expires_at > now() + interval '30 minutes' as extended
      from workspace_commands where id = ${command.id}
    `;
    expect(row?.extended).toBe(true);
  });

  it("lists the unfinished commands that have no live job, oldest first", async () => {
    const fixture = await createWorkspaceFixture(store);
    const enqueue = (queuedAt: string) =>
      store.executionWorkspaces.enqueueWorkspaceCommand({
        clientInstanceId: fixture.clientInstanceId,
        workspaceId: fixture.workspace.id,
        ownerUserId: fixture.ownerUserId,
        command: "node script.js",
        limits: { timeoutSeconds: 60 },
        queuedAt
      });
    const older = await enqueue("2026-06-29T11:00:00.000Z");
    const withJob = await enqueue("2026-06-29T11:01:00.000Z");
    const newer = await enqueue("2026-06-29T11:02:00.000Z");
    const cancelled = await enqueue("2026-06-29T11:03:00.000Z");
    await store.executionWorkspaces.requestWorkspaceCommandCancellation({
      clientInstanceId: fixture.clientInstanceId,
      commandId: cancelled.id,
      requestedAt: "2026-06-29T11:03:01.000Z"
    });
    await rawSql`
      insert into platform_jobs
        (id, client_instance_id, kind, payload, status, run_after, attempts, max_attempts,
         dedupe_key, correlation_id, created_at)
      values
        (${`job_${withJob.id}`}, ${fixture.clientInstanceId}, 'fixture.command', '{}', 'queued',
         now(), 0, 1, ${`fixture.command:${withJob.id}`}, 'corr_fixture', now())
    `;

    await expect(
      store.executionWorkspaces.listWorkspaceCommandsWithoutJob({
        clientInstanceId: fixture.clientInstanceId,
        jobKind: "fixture.command",
        limit: 10
      })
    ).resolves.toEqual([
      { id: older.id, workspaceId: fixture.workspace.id },
      { id: newer.id, workspaceId: fixture.workspace.id }
    ]);
  });
});

async function createWorkspaceFixture(store: PlatformStores): Promise<{
  clientInstanceId: ClientInstanceId;
  ownerUserId: string;
  workspace: ExecutionWorkspace;
}> {
  const clientInstanceId = asClientInstanceId(`client_${globalThis.crypto.randomUUID()}`);
  const user = await store.users.createUser({ clientInstanceId, displayLabel: "Workspace owner" });
  const ownerUserId = user.id;
  const personalWorkspace = await store.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: user.id
  });
  const conversation = await store.conversations.createConversation({
    visibility: "workspace",
    clientInstanceId,
    collaborationWorkspaceId: personalWorkspace.id,
    createdByUserId: ownerUserId,
    createdByExternalUserId: `external_${ownerUserId}`,
    title: "Workspace test",
    retainedUntil: "2026-07-29T00:00:00.000Z"
  });
  const workspace = await store.executionWorkspaces.ensureExecutionWorkspace({
    clientInstanceId,
    conversationId: conversation.id,
    ownerUserId,
    now: "2026-06-29T10:00:00.000Z"
  });
  return {
    clientInstanceId,
    ownerUserId,
    workspace
  };
}

async function enqueueAndClaim(
  store: PlatformStores,
  fixture: {
    clientInstanceId: ClientInstanceId;
    ownerUserId: string;
    workspace: ExecutionWorkspace;
  },
  leaseToken: string
) {
  const queued = await store.executionWorkspaces.enqueueWorkspaceCommand({
    clientInstanceId: fixture.clientInstanceId,
    workspaceId: fixture.workspace.id,
    ownerUserId: fixture.ownerUserId,
    command: "node script.js",
    limits: { timeoutSeconds: 60 }
  });
  const claim = await store.executionWorkspaces.claimWorkspaceCommand({
    clientInstanceId: fixture.clientInstanceId,
    commandId: queued.id,
    leaseOwnerId: "worker-test",
    leaseToken,
    leaseMs: 5 * 60_000
  });
  if (claim.status !== "claimed") {
    throw new Error("Expected workspace command to be claimed");
  }
  return claim.row;
}
