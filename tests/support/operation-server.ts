import { apiErrorResponseSchema } from "@vivd-catalyst/api-contract";
import {
  AppError,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  legacyPermissionFor,
  type Authorizer,
  type CentralPolicySetting,
  type Logger,
  type OperationRun,
  type PlatformEventEmitter,
  type PlatformEventName
} from "@vivd-catalyst/core";
import { createTestConfig } from "./fixtures";
import { registeredTestOperations as operations } from "./operations";
import { asCaller, createCallerAuthAdapter, type TestCaller } from "./route-callers";
import { createTestInstanceWith, type TestRoute } from "./test-instance";

// A server with the fixture operations of the registry registered through its HTTP face, and
// what a test reads from it: what executed, what was logged and the runs.

export const secret = "payload-that-must-not-leave";
const config = createTestConfig();
export const clientInstanceId = asClientInstanceId(config.clientInstance.id);

export interface ServerInput {
  settings?: CentralPolicySetting[];
  readingDefault?: "allow" | "deny";
  approvals?: boolean;
  /** The outcome the guardrails of this event answer with. */
  guardrail?: { event: PlatformEventName; outcome: "block" | "require_approval" };
  now?: () => Date;
  /** The event whose recording fails, as when the audit log cannot be written. */
  failingEvent?: PlatformEventName;
  /** Sign-in that takes a key or token from the request, as the API's does. */
  explicitCredentials?: boolean;
  authorizer?: Authorizer;
  register?: (route: TestRoute) => void;
}

export async function createServer(input: ServerInput = {}) {
  const executed: string[] = [];
  const logged: unknown[] = [];
  const approvalRequests: string[] = [];
  let release: () => void = () => undefined;
  let entered: () => void = () => undefined;
  const gate = {
    released: new Promise<void>((resolve) => (release = resolve)),
    entered: new Promise<void>((resolve) => (entered = resolve))
  };
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (fields) => void logged.push(fields),
    child: () => logger
  };
  const { guardrail } = input;
  const { failingEvent } = input;
  const events: PlatformEventEmitter | undefined =
    guardrail || failingEvent
      ? {
          emit: (name) =>
            name === failingEvent
              ? Promise.reject(new Error(secret))
              : Promise.resolve(name === guardrail?.event ? guardrail.outcome : "allow")
        }
      : undefined;
  const server = await createTestInstanceWith(
    (stores) => ({
      authAdapter: {
        ...createCallerAuthAdapter(),
        ...(input.explicitCredentials ? { credentialMode: "explicit" as const } : {})
      },
      ...(input.authorizer ? { authorizer: input.authorizer } : {}),
      logger,
      auditRecorder: new StoreBackedAuditRecorder({ clientInstanceId, store: stores.audit }),
      config: {
        ...config,
        policy: {
          defaults: { ...config.policy.defaults, reading: input.readingDefault ?? "allow" }
        }
      },
      operations: {
        centralPolicySettings: () => input.settings ?? [],
        ...(events ? { events } : {}),
        ...(input.now ? { now: input.now } : {}),
        ...(input.approvals
          ? {
              approvals: {
                request: ({ run }) => {
                  approvalRequests.push(run.id);
                  return Promise.resolve({ approvalRequestId: `apr_${approvalRequests.length}` });
                }
              }
            }
          : {})
      }
    }),
    (route) => (input.register ?? registerFixtures)(route)
  );

  function registerFixtures(route: TestRoute): void {
    route.operation(operations.testRunRead, {
      resource: (item) => ({ kind: "test_item", id: item.itemId }),
      execute: (item) => {
        executed.push("testRunRead");
        return Promise.resolve({ itemId: item.itemId, view: item.view });
      }
    });
    route.operation(operations.testRunList, {
      checksRightsItself: true,
      execute: (_input, { paging }) => {
        executed.push(`testRunList:${paging?.limit}`);
        return Array.from({ length: 5 }, (_, index) => ({
          id: `item-${index}`,
          createdAt: "2026-10-09T12:00:00.000Z"
        }));
      }
    });
    route.operation(operations.testRunChange, {
      execute: async (item, context) => {
        executed.push(`testRunChange:${item.name}`);
        switch (item.mode) {
          case "not-found":
            throw new AppError("NOT_FOUND", "The item does not exist", { name: item.name });
          case "throw":
            throw new Error(secret);
          case "large":
            return { name: item.name, filler: "x".repeat(300 * 1024) };
          case "gated":
            entered();
            await gate.released;
            return { name: item.name };
          case "own-right":
            context.access.require("audit.view");
            return { name: item.name };
          case "ok":
            return { name: item.name };
        }
      }
    });
  }

  const runs = (): Promise<OperationRun[]> =>
    server.stores.operationRuns.list({ clientInstanceId });
  const auditTypes = async (run: string) =>
    (await server.stores.audit.listAuditEvents({ clientInstanceId }))
      .filter((event) => event.metadata?.operationRunId === run)
      .map((event) => `${event.type}:${event.status}`)
      .sort();
  return {
    server,
    executed,
    logged,
    approvalRequests,
    gate,
    release: () => release(),
    runs,
    auditTypes
  };
}

export const right = (...actions: Parameters<typeof legacyPermissionFor>[0][]) =>
  actions.map(legacyPermissionFor);
export const person = (caller: TestCaller = {}) =>
  asCaller({ permissions: right("users.manage", "audit.view"), ...caller });
export const change = (name: string, mode?: string, key?: string) => ({
  payload: { name, ...(mode ? { mode } : {}) },
  headers: key === undefined ? {} : { "idempotency-key": key }
});
export const errorOf = (response: { json(): unknown }) =>
  apiErrorResponseSchema.parse(response.json()).error;
