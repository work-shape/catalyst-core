export type Brand<TValue, TBrand extends string> = TValue & {
  readonly __brand: TBrand;
};

export type AgentRunId = Brand<string, "AgentRunId">;
export type ClientInstanceId = Brand<string, "ClientInstanceId">;
export type ConversationId = Brand<string, "ConversationId">;
export type ConversationAttachmentId = Brand<string, "ConversationAttachmentId">;
export type ExecutionWorkspaceId = Brand<string, "ExecutionWorkspaceId">;
export type WorkspaceCommandId = Brand<string, "WorkspaceCommandId">;
export type MessageId = Brand<string, "MessageId">;
export type ManagedArtifactId = Brand<string, "ManagedArtifactId">;
export type ManagedFileId = Brand<string, "ManagedFileId">;
export type UserId = Brand<string, "UserId">;
export type ToolCallId = Brand<string, "ToolCallId">;
export type AuditEventId = Brand<string, "AuditEventId">;
export type ModelUsageEventId = Brand<string, "ModelUsageEventId">;

export function createPlatformId<TBrand extends string>(
  prefix: string
): Brand<string, TBrand> {
  const random = globalThis.crypto?.randomUUID?.() ?? fallbackRandomId();
  return `${prefix}_${random}` as Brand<string, TBrand>;
}

function fallbackRandomId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function asClientInstanceId(value: string): ClientInstanceId {
  return value as ClientInstanceId;
}

export function asConversationId(value: string): ConversationId {
  return value as ConversationId;
}

export function asConversationAttachmentId(value: string): ConversationAttachmentId {
  return value as ConversationAttachmentId;
}

export function asExecutionWorkspaceId(value: string): ExecutionWorkspaceId {
  return value as ExecutionWorkspaceId;
}

export function asWorkspaceCommandId(value: string): WorkspaceCommandId {
  return value as WorkspaceCommandId;
}

export function asMessageId(value: string): MessageId {
  return value as MessageId;
}

export function asManagedArtifactId(value: string): ManagedArtifactId {
  return value as ManagedArtifactId;
}

export function asManagedFileId(value: string): ManagedFileId {
  return value as ManagedFileId;
}

export function asUserId(value: string): UserId {
  return value as UserId;
}

export function asAgentRunId(value: string): AgentRunId {
  return value as AgentRunId;
}

export function asToolCallId(value: string): ToolCallId {
  return value as ToolCallId;
}
