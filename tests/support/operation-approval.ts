import { expect } from "vitest";
import { apiErrorResponseSchema, operationRunSchema } from "@vivd-catalyst/api-contract";
import {
  AppError,
  asClientInstanceId,
  legacyPermissionFor,
  type CentralPolicySetting
} from "@vivd-catalyst/core";
import { createTestConfig } from "./fixtures";
import { registeredTestOperations as operations } from "./operations";
import {
  createTestInstance,
  getTestConfig,
  getTestJobs,
  registerTestOperations,
  type TestInstance
} from "./test-instance";

type TestResponse = Awaited<ReturnType<TestInstance["call"]>>;

// The instance the tests of held calls share: assembled as a deployment assembles it, so a
// request is filed, listed and decided through the product's own approval routes.
//
// An approval records the decision and enqueues the job that executes the call. `approve`
// lets that job run; a test that looks at the moment between the two decides with `decide`.

export const HOUR_MS = 60 * 60 * 1000;
export const approvalSetting: CentralPolicySetting = {
  operation: "testRunChange",
  value: "approval"
};

export async function fixture(
  input: {
    now?: () => Date;
    settings?: () => CentralPolicySetting[] | Promise<CentralPolicySetting[]>;
    /** The time the fixture operation may take. */
    timeoutMs?: number;
  } = {}
) {
  /** `<actor id>:<name>` of every execution of the fixture operation. */
  const executed: string[] = [];
  /** The signals of the calls named `slow…`, which run until they are told to stop. */
  const stopped: string[] = [];
  const person = (id: string, roles: string[], rights: string[] = []) => ({
    id,
    externalUserId: id,
    displayLabel: id[0]?.toUpperCase() + id.slice(1),
    roles,
    permissionRefs: [],
    permissions: rights
  });
  const app = await createTestInstance({
    config: createTestConfig({
      developmentAuth: {
        enabled: true,
        users: [
          // May call the operation and may not decide on it.
          person("requester", ["user"], [legacyPermissionFor("users.manage")]),
          // An admin: may call and may decide, their own calls included.
          person("approver", ["admin"]),
          person("second", ["admin"]),
          // May delete an account.
          person("root", ["superadmin"]),
          person("stranger", ["user"])
        ],
        defaultUserId: "requester"
      }
    }),
    env: {},
    tools: [],
    operations: {
      centralPolicySettings: input.settings ?? (() => [approvalSetting]),
      ...(input.now ? { now: input.now } : {})
    }
  });
  registerTestOperations(app, (route) =>
    route.operation(operations.testRunChange, {
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      execute: async (item, context) => {
        executed.push(`${context.actor.displayLabel.toLowerCase()}:${item.name}`);
        if (item.mode === "not-found") throw new AppError("NOT_FOUND", "No such item");
        if (item.name.startsWith("slow")) {
          // Runs until its call is told to stop, as an implementation that honours its signal.
          await new Promise<void>((resolve) => {
            context.runtime.signal?.addEventListener("abort", () => {
              stopped.push(item.name);
              resolve();
            });
          });
        }
        return { name: item.name };
      }
    })
  );
  const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
  const as = (user: string) => ({ "x-dev-user-id": user });
  const call = (
    user: string,
    name: string,
    key?: string,
    extra: Record<string, unknown> = {}
  ): Promise<TestResponse> =>
    app.call("testRunChange", {
      payload: { name, ...extra },
      headers: { ...as(user), ...(key ? { "idempotency-key": key } : {}) }
    });
  const decide = (
    user: string,
    requestId: string,
    decision: "approve" | "reject",
    comment?: string
  ): Promise<TestResponse> =>
    app.call("approval_requests.decide", {
      params: { requestId },
      headers: as(user),
      payload: { decision, ...(comment ? { comment } : {}) }
    });
  const run = async (id: string) => {
    const found = await app.stores.operationRuns.get({ clientInstanceId, id });
    if (!found) throw new Error(`No run ${id}`);
    return found;
  };
  /** The request as the store keeps it, payload included. */
  const stored = async (requestId: string) => {
    const found = await app.stores.approvals.getApprovalRequest({ clientInstanceId, requestId });
    if (!found) throw new Error(`No request ${requestId}`);
    return found;
  };
  const runJobs = () => getTestJobs(app).runDue();
  /** Approves and lets the job that executes the call run. */
  const approve = async (
    user: string,
    requestId: string,
    comment?: string
  ): Promise<TestResponse> => {
    const response = await decide(user, requestId, "approve", comment);
    await runJobs();
    return response;
  };
  const userId = async (label: string) => {
    const users = await app.stores.users.listUsers({ clientInstanceId });
    const found = users.find((user) => user.displayLabel === label);
    if (!found) throw new Error(`No user ${label}`);
    return found.id;
  };
  /** Files one call and answers its run and its approval request. */
  const hold = async (
    name = "held",
    key = "key-1",
    user = "requester",
    extra: Record<string, unknown> = {}
  ) => {
    const response = await call(user, name, key, extra);
    expect(response.statusCode).toBe(202);
    const body = operationRunSchema.parse(response.json());
    if (!body.approvalRequestId) throw new Error("The held call names no approval request");
    return { runId: body.id, requestId: body.approvalRequestId, body };
  };
  return {
    app,
    clientInstanceId,
    executed,
    stopped,
    as,
    call,
    decide,
    approve,
    runJobs,
    run,
    stored,
    userId,
    hold
  };
}

export const errorOf = (response: { json(): unknown }) =>
  apiErrorResponseSchema.parse(response.json()).error;
