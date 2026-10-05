import type { AgentRunId, ClientInstanceId, ConversationId, ToolCallId } from "./ids";
import type { AuthenticatedUser } from "./identity";
import type { JsonObject } from "./json";
import type { Permission } from "./permissions";
import type { ToolPermissionDecision } from "./tool-execution";

export type ApprovalRequestStatus =
  "pending" | "approved" | "rejected" | "changes_requested" | "superseded" | "withdrawn";

export interface ApprovalCheckResult {
  id: string;
  status: "passed" | "warned" | "blocked";
  message: string;
}

export interface ApprovalRequest {
  id: string;
  clientInstanceId: ClientInstanceId;
  kind: string;
  summary: string;
  payload: JsonObject;
  requestedBy: Pick<AuthenticatedUser, "id" | "displayLabel">;
  origin?: {
    conversationId: ConversationId;
    agentRunId: AgentRunId;
    toolCallId: ToolCallId;
    agentName: string;
  };
  status: ApprovalRequestStatus;
  decision?: ToolPermissionDecision & { decidedByLabel: string; comment?: string };
  checks: ApprovalCheckResult[];
  applyResult?: JsonObject;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalRequestContext {
  clientInstanceId: ClientInstanceId;
  requestId: string;
  correlationId: string;
  origin?: ApprovalRequest["origin"];
}

export interface ApprovalRequestHandler<TPayload extends JsonObject = JsonObject> {
  kind: string;
  requiredPermission: Permission;
  validate(payload: JsonObject): TPayload;
  preview(payload: TPayload, context: ApprovalRequestContext): Promise<JsonObject>;
  isStale(payload: TPayload, context: ApprovalRequestContext): Promise<boolean>;
  apply(
    payload: TPayload,
    approver: AuthenticatedUser,
    context: ApprovalRequestContext
  ): Promise<JsonObject>;
}

export type ApprovalRequestHandlerRegistry = ReadonlyMap<string, ApprovalRequestHandler>;

export interface ApprovalRequestOutcome {
  status: Exclude<ApprovalRequestStatus, "pending">;
  decision?: ApprovalRequest["decision"];
  applyResult?: JsonObject;
}

export interface ApprovalRequestStore {
  createApprovalRequest(
    input: Pick<
      ApprovalRequest,
      "clientInstanceId" | "kind" | "summary" | "payload" | "requestedBy" | "origin"
    >
  ): Promise<ApprovalRequest>;
  getApprovalRequest(input: {
    clientInstanceId: ClientInstanceId;
    requestId: string;
  }): Promise<ApprovalRequest | undefined>;
  /** Newest first, limited to 200 matching requests. */
  listApprovalRequests(input: {
    clientInstanceId: ClientInstanceId;
    kinds: readonly string[];
    status?: ApprovalRequestStatus;
    conversationId?: ConversationId;
  }): Promise<ApprovalRequest[]>;
  countPendingApprovalRequests(input: {
    clientInstanceId: ClientInstanceId;
    kinds: readonly string[];
  }): Promise<number>;
  /** Exclusively lock a pending request before resolve; otherwise throw CONFLICT.
   * A failed resolve leaves it pending. External handler effects must be idempotent
   * by requestId: they cannot be rolled back with this store's transaction.
   */
  transitionPendingApprovalRequest(input: {
    clientInstanceId: ClientInstanceId;
    requestId: string;
    resolve(request: ApprovalRequest): Promise<ApprovalRequestOutcome>;
  }): Promise<ApprovalRequest>;
}
