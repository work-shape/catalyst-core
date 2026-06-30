import {
  auditActorFromUser,
  type ActiveWorkspaceCommandCounts,
  type AuditActor,
  type AuditEventStatus,
  type AuditRecorder,
  type AuthenticatedUser,
  type JsonObject,
  type WorkspaceCommand
} from "@vivd-catalyst/core";

export type WorkspaceCommandTelemetryEventType =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "stale_recovered"
  | "temp_state_cleaned";

export interface WorkspaceCommandTelemetryEvent {
  type: WorkspaceCommandTelemetryEventType;
  commandId?: string;
  workspaceId?: string;
  clientInstanceId: string;
  conversationId?: string;
  ownerUserId?: string;
  agentRunId?: string;
  toolCallId?: string;
  workerId?: string;
  status?: WorkspaceCommand["status"];
  durationMs?: number;
  timeoutSeconds?: number;
  exitCode?: number;
  changedFileCount?: number;
  promotedArtifactCount?: number;
  errorCode?: string;
  errorCategory?: string;
  activeCounts?: ActiveWorkspaceCommandCounts;
  removedCount?: number;
  failedCount?: number;
}

export interface WorkspaceCommandTelemetry {
  record(event: WorkspaceCommandTelemetryEvent): void | Promise<void>;
}

export interface WorkspaceCommandTelemetryLogger {
  info(input: unknown, message?: string): void;
  warn(input: unknown, message?: string): void;
  error(input: unknown, message?: string): void;
}

export function createConsoleWorkspaceCommandTelemetry(
  logger: WorkspaceCommandTelemetryLogger = console
): WorkspaceCommandTelemetry {
  return {
    record(event) {
      const payload = {
        ...event,
        eventType: event.type,
        type: `workspace_command.${event.type}`
      };
      if (event.type === "failed" || event.type === "timed_out" || event.failedCount) {
        logger.warn(payload, "Workspace command operational event");
      } else {
        logger.info(payload, "Workspace command operational event");
      }
    }
  };
}

export function workspaceCommandCountsMetadata(
  counts: ActiveWorkspaceCommandCounts
): JsonObject {
  return {
    queued: counts.queued,
    running: counts.running,
    cancelling: counts.cancelling,
    total: counts.total
  };
}

export async function emitWorkspaceCommandTelemetry(
  telemetry: WorkspaceCommandTelemetry | undefined,
  event: WorkspaceCommandTelemetryEvent
): Promise<void> {
  try {
    await telemetry?.record(event);
  } catch {
    // Telemetry must not change command lifecycle behavior.
  }
}

export async function recordWorkspaceCommandLifecycleAudit(input: {
  auditRecorder?: AuditRecorder;
  type: string;
  status: AuditEventStatus;
  command: WorkspaceCommand;
  actor?: AuditActor;
  user?: AuthenticatedUser;
  correlationId?: string;
  metadata?: JsonObject;
}): Promise<void> {
  try {
    await input.auditRecorder?.record({
      type: input.type,
      status: input.status,
      actor: input.actor ?? (input.user ? auditActorFromUser(input.user) : undefined),
      subject: input.command.id,
      correlationId: input.correlationId ?? input.command.id,
      metadata: {
        workspaceId: input.command.workspaceId,
        conversationId: input.command.conversationId,
        ownerUserId: input.command.ownerUserId,
        ...(input.command.agentRunId ? { agentRunId: input.command.agentRunId } : {}),
        ...(input.command.toolCallId ? { toolCallId: input.command.toolCallId } : {}),
        status: input.command.status,
        attempts: input.command.attempts,
        ...input.metadata
      }
    });
  } catch {
    // Audit recording is best-effort for command workers; the command row remains authoritative.
  }
}

export function terminalWorkspaceCommandAuditType(command: WorkspaceCommand): {
  type: string;
  status: AuditEventStatus;
  telemetryType: WorkspaceCommandTelemetryEventType;
} {
  if (command.status === "completed") {
    return {
      type: "workspace_command.completed",
      status: "success",
      telemetryType: "completed"
    };
  }
  if (command.status === "cancelled") {
    return {
      type: "workspace_command.cancelled",
      status: "success",
      telemetryType: "cancelled"
    };
  }
  if (command.error?.category === "timeout") {
    return {
      type: "workspace_command.timed_out",
      status: "failed",
      telemetryType: "timed_out"
    };
  }
  return {
    type: "workspace_command.failed",
    status: "failed",
    telemetryType: "failed"
  };
}

export function workspaceCommandTelemetryEvent(
  type: WorkspaceCommandTelemetryEventType,
  command: WorkspaceCommand,
  extra: Partial<WorkspaceCommandTelemetryEvent> = {}
): WorkspaceCommandTelemetryEvent {
  return {
    type,
    commandId: command.id,
    workspaceId: command.workspaceId,
    clientInstanceId: command.clientInstanceId,
    conversationId: command.conversationId,
    ownerUserId: command.ownerUserId,
    ...(command.agentRunId ? { agentRunId: command.agentRunId } : {}),
    ...(command.toolCallId ? { toolCallId: command.toolCallId } : {}),
    status: command.status,
    timeoutSeconds: command.limits.timeoutSeconds,
    durationMs: command.output?.durationMs,
    exitCode: command.output?.exitCode,
    changedFileCount: command.output?.changedFiles.length,
    promotedArtifactCount: command.output?.promotedArtifacts.length,
    errorCode: command.error?.code,
    errorCategory: command.error?.category,
    ...extra
  };
}
