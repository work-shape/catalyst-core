import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  NonRetryableJobError,
  type AuditActor,
  type PlatformStores,
  type UserId,
  type UserRecord
} from "@vivd-catalyst/core";
import { deleteAccountJob } from "./job-kinds";
import {
  acceptDeletion,
  countPendingCleanup,
  deletionDedupeKey,
  retryWorkspaceCleanup,
  type DeletionOutcome,
  type DeletionTransaction
} from "./subject-deletion";
import type { ChatServerOptions } from "./types";
import { cleanupProductUserData, requireNoSoleOwnedSharedWorkspace } from "./user-deletion";

/** Who asked for the deletion of an account: its user, or an administrator. */
export type AccountDeletionRequester = "self" | "admin";

interface AccountDeletion {
  userId: UserId;
  requestedBy: AccountDeletionRequester;
  actor: AuditActor;
  correlationId: string;
}

/**
 * Accepts the deletion of an account. It refuses, before anything is marked, while the user
 * is the last active owner of a Shared Workspace. From the mark on the user is closed.
 */
export async function requestAccountDeletion(
  options: ChatServerOptions,
  input: AccountDeletion & { actorUserId: UserId; alreadyRequested: boolean }
): Promise<DeletionOutcome<UserRecord>> {
  if (!input.alreadyRequested) await requireNoSoleOwnedSharedWorkspace(options, input.userId);
  return acceptDeletion(options, {
    job: deleteAccountJob,
    payload: {
      userId: input.userId,
      requestedBy: input.requestedBy,
      actorUserId: input.actorUserId
    },
    subjectId: input.userId,
    correlationId: input.correlationId,
    async mark(stores) {
      const marked = await stores.users.markUserDeletionRequested({
        clientInstanceId: options.clientInstanceId,
        userId: input.userId
      });
      if (marked) {
        await stores.audit.appendAuditEvent({
          clientInstanceId: options.clientInstanceId,
          type: "user.deletion_requested",
          status: "success",
          actor: input.actor,
          subject: input.userId,
          correlationId: input.correlationId,
          metadata: { requestedBy: input.requestedBy }
        });
      }
      return marked;
    },
    complete: () => completeAccountDeletion(options, input, (fn) => options.stores.transaction(fn))
  });
}

/**
 * One pass of the deletion of an account whose deletion was requested. It removes the
 * password sign-in first, so the credentials are gone whatever the stored data does, then
 * the user's own data, then the user. It throws while data of deleted Conversations is still
 * being removed; the next pass goes on from there. Resolves undefined when the user is gone.
 */
export async function completeAccountDeletion(
  options: ChatServerOptions,
  input: AccountDeletion,
  transaction: DeletionTransaction
): Promise<UserRecord | undefined> {
  const user = await findUser(options.stores, options, input.userId);
  if (!user) return undefined;
  if (user.status !== "deleting") {
    throw new NonRetryableJobError("The deletion of this user was not requested");
  }
  await deleteStandalonePasswordSignIns(options, user);
  const personalWorkspaceId = await personalWorkspaceIdOf(options.stores, options, user.id);
  if (personalWorkspaceId) await retryWorkspaceCleanup(options, personalWorkspaceId);
  const totals = await cleanupProductUserData({
    options,
    actor: input.actor,
    correlationId: input.correlationId,
    userId: user.id
  });
  return transaction(async (stores) => {
    const deleted = await stores.users.deleteUser({
      clientInstanceId: options.clientInstanceId,
      userId: user.id
    });
    await stores.audit.appendAuditEvent({
      clientInstanceId: options.clientInstanceId,
      type: "user.deleted",
      status: "success",
      actor: input.actor,
      subject: deleted.id,
      correlationId: input.correlationId,
      // The counts are those of the pass that finished the deletion.
      metadata: {
        requestedBy: input.requestedBy,
        roles: deleted.roles,
        permissionRefs: deleted.permissionRefs,
        permissions: deleted.permissions,
        ...totals
      }
    });
    await stores.jobs.withdraw(deleteAccountJob, {
      clientInstanceId: options.clientInstanceId,
      dedupeKey: deletionDedupeKey(deleteAccountJob, user.id)
    });
    return deleted;
  });
}

/**
 * Records that the job of an account deletion used up its attempts. The user stays closed.
 * Runs in the transaction that marks the job dead.
 */
export async function recordAccountDeletionStalled(
  stores: PlatformStores,
  options: Pick<ChatServerOptions, "clientInstanceId">,
  input: { userId: UserId; requestedBy: AccountDeletionRequester; correlationId: string }
): Promise<void> {
  await stores.audit.appendAuditEvent({
    clientInstanceId: options.clientInstanceId,
    type: "user.deletion_stalled",
    status: "failed",
    subject: input.userId,
    correlationId: input.correlationId,
    metadata: {
      requestedBy: input.requestedBy,
      pendingCleanupCount: await countPendingCleanup(
        stores,
        options,
        await personalWorkspaceIdOf(stores, options, input.userId)
      )
    }
  });
}

async function findUser(
  stores: PlatformStores,
  options: Pick<ChatServerOptions, "clientInstanceId">,
  userId: UserId
): Promise<UserRecord | undefined> {
  const users = await stores.users.listUsers({ clientInstanceId: options.clientInstanceId });
  return users.find((candidate) => candidate.id === userId);
}

async function personalWorkspaceIdOf(
  stores: PlatformStores,
  options: Pick<ChatServerOptions, "clientInstanceId">,
  userId: UserId
) {
  const workspaces = await stores.workspaces.listWorkspacesForUser({
    clientInstanceId: options.clientInstanceId,
    userId
  });
  return workspaces.find(
    (workspace) => workspace.kind === "personal" && workspace.personalUserId === userId
  )?.id;
}

async function deleteStandalonePasswordSignIns(
  options: ChatServerOptions,
  user: UserRecord
): Promise<void> {
  const deletePasswordSignIn = options.standaloneAuth?.deletePasswordSignIn;
  if (!deletePasswordSignIn) return;
  for (const identity of user.identities) {
    if (identity.authSource !== STANDALONE_AUTH_SOURCE) continue;
    await deletePasswordSignIn({ externalUserId: identity.externalUserId });
  }
}
