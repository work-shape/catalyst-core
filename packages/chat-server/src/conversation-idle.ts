import { AppError, type ConversationId } from "@vivd-catalyst/core";
import type { ChatServerOptions } from "./types";

/**
 * Refuses while background work still writes into the Conversation: an agent run, an
 * attachment being processed, a workspace command or a preview being rendered.
 */
export async function assertConversationIdle(
  options: ChatServerOptions,
  conversationId: ConversationId
): Promise<void> {
  const [activeRun, draftAttachments, activeCommands, artifacts] = await Promise.all([
    options.stores.agentRuns.getActiveConversationAgentRun({
      clientInstanceId: options.clientInstanceId,
      conversationId
    }),
    options.attachments?.listDraftAttachments(conversationId) ?? [],
    options.stores.executionWorkspaces.countActiveWorkspaceCommands({
      clientInstanceId: options.clientInstanceId,
      conversationId
    }),
    options.stores.files.listConversationManagedArtifacts({
      clientInstanceId: options.clientInstanceId,
      conversationId
    })
  ]);
  const previewJobs = await Promise.all(
    artifacts.map((artifact) =>
      options.stores.files.getArtifactPreviewJob({
        clientInstanceId: options.clientInstanceId,
        sourceArtifactId: artifact.id
      })
    )
  );
  const busyStates = [
    ...(activeRun ? ["active_agent_run"] : []),
    ...(draftAttachments.some(
      (attachment) => attachment.status === "queued" || attachment.status === "preprocessing"
    )
      ? ["attachment_processing"]
      : []),
    ...(activeCommands.total > 0 ? ["execution_workspace_command"] : []),
    ...(previewJobs.some((job) => job?.status === "pending" || job?.status === "processing")
      ? ["artifact_preview"]
      : [])
  ];
  if (busyStates.length > 0) {
    throw new AppError("CONFLICT", "Conversation has mutable background work in progress", {
      busyStates
    });
  }
}
