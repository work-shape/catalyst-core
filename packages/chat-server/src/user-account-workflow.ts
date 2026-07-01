import { STANDALONE_AUTH_SOURCE } from "@vivd-catalyst/auth";
import {
  AppError,
  asUserId,
  auditActorFromUser,
  authenticatedUserFromRecord,
  getSubjectUserId,
  type AuthenticatedUser,
  type ConversationId,
  type RuntimeCallContext,
  type UserRecord
} from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";
import {
  cleanupExecutionWorkspaceForConversation,
  executionWorkspaceCleanupAuditMetadata
} from "./workspace-cleanup";

interface UpdateCurrentUserCommand {
  displayLabel: string;
}

interface ChangeCurrentUserPasswordCommand {
  currentPassword: string;
  newPassword: string;
}

interface ConversationDeletionTotals {
  conversationCount: number;
  attachmentCount: number;
  fileCount: number;
  artifactCount: number;
  workspaceCount: number;
  workspaceFileCount: number;
  workspaceCommandCount: number;
  workspaceObjectCount: number;
}

type ConversationDataDeletionTotals = Omit<ConversationDeletionTotals, "conversationCount">;

export class UserAccountWorkflow {
  constructor(private readonly options: ChatServerOptions) {}

  async updateCurrentUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: UpdateCurrentUserCommand
  ): Promise<AuthenticatedUser> {
    const updated = await this.options.userStore.updateUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(actor.id),
      displayLabel: command.displayLabel
    });

    await this.options.auditRecorder.record({
      type: "user.profile_updated",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: updated.id,
      correlationId: context.correlationId,
      metadata: {
        fields: ["displayLabel"]
      }
    });

    return authenticatedUserFromRecord({
      user: updated,
      identity: {
        authSource: actor.authSource,
        externalUserId: actor.externalUserId
      },
      correlationId: context.correlationId
    });
  }

  async changeCurrentUserPassword(
    actor: AuthenticatedUser,
    context: RuntimeCallContext,
    command: ChangeCurrentUserPasswordCommand
  ): Promise<{ ok: true }> {
    if (actor.authSource !== STANDALONE_AUTH_SOURCE) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password changes are only available for standalone auth accounts"
      );
    }

    const changePassword = this.options.standaloneAuth?.changePassword;
    if (!changePassword) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Password changes require standalone auth to be enabled for this client instance"
      );
    }

    await changePassword({
      externalUserId: actor.externalUserId,
      currentPassword: command.currentPassword,
      newPassword: command.newPassword
    });
    await this.options.auditRecorder.record({
      type: "user.password_changed",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: actor.id,
      correlationId: context.correlationId,
      metadata: {
        authSource: actor.authSource
      }
    });

    return { ok: true };
  }

  async deleteCurrentUser(
    actor: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<{ ok: true }> {
    if (actor.principal?.kind === "service" || actor.delegatedActor) {
      throw new AppError(
        "FORBIDDEN",
        "Account deletion must be requested by the signed-in user"
      );
    }

    const existing = await this.getCurrentUserOrThrow(actor);
    const deletionTotals = await this.deleteActiveConversations(actor, context);
    await this.deleteStandalonePasswordSignIns(existing);
    const deleted = await this.options.userStore.deleteUser({
      clientInstanceId: this.options.clientInstanceId,
      userId: asUserId(actor.id)
    });

    await this.options.auditRecorder.record({
      type: "user.deleted",
      status: "success",
      actor: auditActorFromUser(actor),
      subject: deleted.id,
      correlationId: context.correlationId,
      metadata: {
        requestedBy: "self",
        roles: deleted.roles,
        permissionRefs: deleted.permissionRefs,
        ...deletionTotals
      }
    });

    return { ok: true };
  }

  private async getCurrentUserOrThrow(actor: AuthenticatedUser): Promise<UserRecord> {
    const users = await this.options.userStore.listUsers({
      clientInstanceId: this.options.clientInstanceId
    });
    const user = users.find((candidate) => candidate.id === actor.id);
    if (!user) {
      throw new AppError("NOT_FOUND", "User account is not available");
    }
    return user;
  }

  private async deleteActiveConversations(
    actor: AuthenticatedUser,
    context: RuntimeCallContext
  ): Promise<ConversationDeletionTotals> {
    const conversations = await this.options.conversationStore.listConversationsForUser({
      clientInstanceId: this.options.clientInstanceId,
      ownerUserId: getSubjectUserId(actor)
    });
    const totals: ConversationDeletionTotals = {
      conversationCount: 0,
      attachmentCount: 0,
      fileCount: 0,
      artifactCount: 0,
      workspaceCount: 0,
      workspaceFileCount: 0,
      workspaceCommandCount: 0,
      workspaceObjectCount: 0
    };

    for (const conversation of conversations) {
      const deletedAt = new Date().toISOString();
      const deletion = await this.deleteConversationDataForAccountDeletion(
        conversation.id,
        deletedAt
      );
      totals.conversationCount += 1;
      totals.attachmentCount += deletion.attachmentCount;
      totals.fileCount += deletion.fileCount;
      totals.artifactCount += deletion.artifactCount;
      totals.workspaceCount += deletion.workspaceCount;
      totals.workspaceFileCount += deletion.workspaceFileCount;
      totals.workspaceCommandCount += deletion.workspaceCommandCount;
      totals.workspaceObjectCount += deletion.workspaceObjectCount;

      await this.options.auditRecorder.record({
        type: "conversation.deleted",
        status: "success",
        actor: auditActorFromUser(actor),
        subject: conversation.id,
        correlationId: context.correlationId,
        metadata: {
          requestedBy: "account_deletion",
          ...deletion
        }
      });
    }

    return totals;
  }

  private async deleteConversationDataForAccountDeletion(
    conversationId: ConversationId,
    deletedAt: string
  ): Promise<ConversationDataDeletionTotals> {
    const attachmentDeletion = this.options.attachments
      ? await this.options.attachments.deleteConversationAttachments({
          conversationId,
          deletedAt
        })
      : undefined;
    const workspaceDeletion = await cleanupExecutionWorkspaceForConversation(this.options, {
      conversationId,
      deletedAt
    });
    await this.options.conversationStore.deleteConversation({
      clientInstanceId: this.options.clientInstanceId,
      conversationId,
      deletedAt
    });
    const workspaceMetadata = executionWorkspaceCleanupAuditMetadata(workspaceDeletion);
    return {
      attachmentCount: attachmentDeletion?.attachmentCount ?? 0,
      fileCount: attachmentDeletion?.fileObjectKeys.length ?? 0,
      artifactCount: attachmentDeletion?.artifactObjectKeys.length ?? 0,
      workspaceCount: Number(workspaceMetadata.workspaceCount ?? 0),
      workspaceFileCount: Number(workspaceMetadata.workspaceFileCount ?? 0),
      workspaceCommandCount: Number(workspaceMetadata.workspaceCommandCount ?? 0),
      workspaceObjectCount: Number(workspaceMetadata.workspaceObjectCount ?? 0)
    };
  }

  private async deleteStandalonePasswordSignIns(user: UserRecord): Promise<void> {
    const deletePasswordSignIn = this.options.standaloneAuth?.deletePasswordSignIn;
    if (!deletePasswordSignIn) {
      return;
    }
    const identities = user.identities.filter(
      (identity) => identity.authSource === STANDALONE_AUTH_SOURCE
    );
    for (const identity of identities) {
      await deletePasswordSignIn({
        externalUserId: identity.externalUserId
      });
    }
  }
}
