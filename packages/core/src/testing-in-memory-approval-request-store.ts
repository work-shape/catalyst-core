import {
  AppError,
  createPlatformId,
  type ApprovalRequest,
  type ApprovalRequestStore
} from "./index";

export class InMemoryApprovalRequestStore implements ApprovalRequestStore {
  private readonly requests = new Map<string, ApprovalRequest>();
  private readonly locks = new Set<string>();

  async createApprovalRequest(
    input: Parameters<ApprovalRequestStore["createApprovalRequest"]>[0]
  ): Promise<ApprovalRequest> {
    const now = new Date().toISOString();
    const request: ApprovalRequest = {
      ...structuredClone(input),
      id: createPlatformId("apr"),
      status: "pending",
      checks: [],
      createdAt: now,
      updatedAt: now
    };
    this.requests.set(request.id, request);
    return structuredClone(request);
  }

  async getApprovalRequest(
    input: Parameters<ApprovalRequestStore["getApprovalRequest"]>[0]
  ): Promise<ApprovalRequest | undefined> {
    const request = this.requests.get(input.requestId);
    return request?.clientInstanceId === input.clientInstanceId
      ? structuredClone(request)
      : undefined;
  }

  async listApprovalRequests(
    input: Parameters<ApprovalRequestStore["listApprovalRequests"]>[0]
  ): Promise<ApprovalRequest[]> {
    return [...this.requests.values()]
      .filter(
        (request) =>
          request.clientInstanceId === input.clientInstanceId &&
          input.kinds.includes(request.kind) &&
          (input.status === undefined || request.status === input.status) &&
          (input.conversationId === undefined ||
            request.origin?.conversationId === input.conversationId)
      )
      .sort(
        (left, right) =>
          right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id)
      )
      .slice(0, 200)
      .map((request) => structuredClone(request));
  }

  async countPendingApprovalRequests(
    input: Parameters<ApprovalRequestStore["countPendingApprovalRequests"]>[0]
  ): Promise<number> {
    return [...this.requests.values()].filter(
      (request) =>
        request.clientInstanceId === input.clientInstanceId &&
        input.kinds.includes(request.kind) &&
        request.status === "pending"
    ).length;
  }

  async transitionPendingApprovalRequest(
    input: Parameters<ApprovalRequestStore["transitionPendingApprovalRequest"]>[0]
  ): Promise<ApprovalRequest> {
    const request = this.requests.get(input.requestId);
    if (!request || request.clientInstanceId !== input.clientInstanceId) {
      throw new AppError("NOT_FOUND", "Approval request was not found");
    }
    if (request.status !== "pending" || this.locks.has(request.id)) {
      throw new AppError("CONFLICT", "Approval request is no longer pending");
    }
    this.locks.add(request.id);
    try {
      const outcome = await input.resolve(structuredClone(request));
      const updated = {
        ...request,
        ...structuredClone(outcome),
        updatedAt: new Date().toISOString()
      };
      this.requests.set(request.id, updated);
      return structuredClone(updated);
    } finally {
      this.locks.delete(request.id);
    }
  }
}
