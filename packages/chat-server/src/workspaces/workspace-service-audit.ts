import { auditActorFromUser, type CollaborationWorkspaceId } from "@work-shape/catalyst-core";
import type { WorkspaceChangeCall } from "./workspace-service-types";

export async function recordWorkspaceChange(
  call: WorkspaceChangeCall,
  collaborationWorkspaceId: CollaborationWorkspaceId,
  type: string,
  metadata?: Record<string, string | string[]>
): Promise<void> {
  const { audit: auditRecorder } = call;
  await auditRecorder.record({
    type,
    status: "success",
    actor: auditActorFromUser(call.user),
    subject: collaborationWorkspaceId,
    correlationId: call.correlationId,
    metadata
  });
}
