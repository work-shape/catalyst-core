import { describe, expect, it } from "vitest";
import { apiErrorResponseSchema, operationRunSchema } from "@vivd-catalyst/api-contract";
import {
  AppError,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  StoreBackedAuditRecorder,
  asClientInstanceId,
  createPlatformId,
  legacyPermissionFor,
  type CentralPolicySetting,
  type Logger,
  type OperationRun,
  type PlatformEventEmitter,
  type PlatformEventName
} from "@vivd-catalyst/core";
import { createTestConfig } from "./support/fixtures";
import { registeredTestOperations as operations } from "./support/operations";
import { asCaller, createCallerAuthAdapter, type TestCaller } from "./support/route-callers";
import { createTestInstanceWith, type TestRoute } from "./support/test-instance";

// The HTTP face of the operation registry. These tests register fixture operations through it
// and prove, for every class of outcome, what the caller is answered and what the Operation
// Run records, and that each refusal leaves the operation unexecuted.

const secret = "payload-that-must-not-leave";
const config = createTestConfig();
const clientInstanceId = asClientInstanceId(config.clientInstance.id);

interface ServerInput {
  settings?: CentralPolicySetting[];
  readingDefault?: "allow" | "deny";
  approvals?: boolean;
  /** The outcome the guardrails of this event answer with. */
  guardrail?: { event: PlatformEventName; outcome: "block" | "require_approval" };
  now?: () => Date;
}

async function createServer(input: ServerInput = {}) {
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
  const events: PlatformEventEmitter | undefined = guardrail && {
    emit: (name) => Promise.resolve(name === guardrail.event ? guardrail.outcome : "allow")
  };
  const server = await createTestInstanceWith(
    (stores) => ({
      authAdapter: createCallerAuthAdapter(),
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
    (route) => registerFixtures(route)
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

const right = (...actions: Parameters<typeof legacyPermissionFor>[0][]) =>
  actions.map(legacyPermissionFor);
const person = (caller: TestCaller = {}) =>
  asCaller({ permissions: right("users.manage", "audit.view"), ...caller });
const change = (name: string, mode?: string, key?: string) => ({
  payload: { name, ...(mode ? { mode } : {}) },
  headers: key === undefined ? {} : { "idempotency-key": key }
});
const errorOf = (response: { json(): unknown }) =>
  apiErrorResponseSchema.parse(response.json()).error;

describe("operation over HTTP: a call that runs", () => {
  it("answers 200 with the plain output, names its run and records it as done", async () => {
    const { server, runs, auditTypes } = await createServer();
    const response = await server.call(
      "testRunChange",
      { ...change("first"), headers: { "x-correlation-id": "corr-from-caller" } },
      person()
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: "first" });
    expect(response.headers["idempotent-replayed"]).toBeUndefined();
    expect(response.headers.location).toBeUndefined();

    const [run, ...others] = await runs();
    expect(others).toEqual([]);
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(run).toMatchObject({
      operation: "testRunChange",
      effect: "changing",
      status: "done",
      attempt: 1,
      actor: { kind: "user", id: "usr_test", label: "Test user" },
      origin: { kind: "user" },
      correlationId: "corr-from-caller",
      // The caller's own call is the confirmation the default policy asks for.
      decision: { mode: "direct", by: "usr_test" },
      output: { value: { name: "first" } }
    });
    expect(run?.inputHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify({ ...run, output: undefined })).not.toContain("first");
    expect(await auditTypes(run?.id ?? "")).toEqual([
      "operation.authorization_checked:success",
      "operation.completed:success",
      "operation.started:success"
    ]);
  });

  it("runs a reading operation without a decision and keeps none of its answer", async () => {
    const { server, runs } = await createServer();
    const response = await server.call(
      "testRunRead",
      {
        params: { itemId: "item-1" },
        query: { view: "short" },
        headers: { "idempotency-key": "k" }
      },
      person()
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ itemId: "item-1", view: "short" });
    const [run] = await runs();
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(run).toMatchObject({ operation: "testRunRead", effect: "reading", status: "done" });
    expect(run?.decision).toBeUndefined();
    expect(run?.output).toBeUndefined();
    // A reading call takes no key: the same one twice is two runs.
    expect(run?.idempotencyKey).toBeUndefined();
  });

  it("cuts the page of a list operation as every list is cut", async () => {
    const { server, executed } = await createServer();
    const first = await server.call("testRunList", { query: { limit: 2 } }, person());
    expect(first.statusCode).toBe(200);
    const page = first.json<{ items: { id: string }[]; nextCursor?: string }>();
    expect(page.items.map((item) => item.id)).toEqual(["item-4", "item-3"]);
    expect(executed).toEqual(["testRunList:3"]);
    const next = await server.call(
      "testRunList",
      { query: { limit: 2, cursor: page.nextCursor } },
      person()
    );
    expect(next.json<typeof page>().items.map((item) => item.id)).toEqual(["item-2", "item-1"]);
  });

  it("reads the origin from the credential and from nothing the caller sends", async () => {
    const { server, runs } = await createServer();
    const claims = {
      "x-operation-origin": "agent",
      "x-origin": "workflow",
      origin: "https://ui.example.test",
      "user-agent": "catalyst-cli/1.0"
    };
    await server.call("testRunChange", { ...change("by-person"), headers: claims }, person());
    await server.call(
      "testRunChange",
      { ...change("by-key"), headers: claims },
      person({ kind: "service" })
    );
    const origins = Object.fromEntries((await runs()).map((run) => [run.actor.kind, run.origin]));
    expect(origins).toEqual({ user: { kind: "user" }, service_principal: { kind: "cli" } });
  });
});

describe("operation over HTTP: a call that is not admitted", () => {
  it("answers 422 for an invalid body and starts no run", async () => {
    const { server, runs, executed } = await createServer();
    for (const payload of [{}, { name: "" }, { name: "x", mode: "unknown" }]) {
      const response = await server.call("testRunChange", { payload }, person());
      expect(response.statusCode).toBe(422);
      expect(errorOf(response).code).toBe("VALIDATION_FAILED");
      expect(response.headers["operation-run-id"]).toBeUndefined();
    }
    expect(await runs()).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("refuses a credential without the operation's scope before a run exists", async () => {
    const { server, runs, executed } = await createServer();
    const response = await server.call(
      "testRunChange",
      change("scoped"),
      person({ scopes: ["governance:read"] })
    );
    expect(response.statusCode).toBe(403);
    expect(errorOf(response)).toMatchObject({
      code: "FORBIDDEN",
      message: "Missing auth scope 'governance:write'"
    });
    expect(await runs()).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("refuses an Idempotency-Key that is empty or too long", async () => {
    const { server, runs } = await createServer();
    for (const key of ["", "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)]) {
      const response = await server.call("testRunChange", change("keyed", "ok", key), person());
      expect(response.statusCode).toBe(422);
      expect(errorOf(response).message).toContain(String(IDEMPOTENCY_KEY_MAX_LENGTH));
    }
    expect(await runs()).toEqual([]);
  });
});

describe("operation over HTTP: a call that is refused", () => {
  it("answers 403 FORBIDDEN with the action and the reason, and records the run as denied", async () => {
    const { server, runs, executed, auditTypes } = await createServer();
    const response = await server.call(
      "testRunChange",
      change("unauthorized"),
      person({ permissions: right("audit.view") })
    );
    expect(response.statusCode).toBe(403);
    expect(errorOf(response)).toMatchObject({
      code: "FORBIDDEN",
      message: "Missing the right 'users.manage'",
      details: { action: "users.manage", reason: "no_grant" }
    });
    const [run] = await runs();
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(run).toMatchObject({
      status: "denied",
      error: { code: "FORBIDDEN", message: "Missing the right 'users.manage'" },
      denial: { kind: "forbidden", action: "users.manage", reason: "no_grant" }
    });
    expect(executed).toEqual([]);
    expect(await auditTypes(run?.id ?? "")).toEqual([
      "operation.authorization_checked:denied",
      "operation.denied:denied"
    ]);
  });

  it("records a right the operation checks itself as a refusal, not as a failure", async () => {
    const { server, runs } = await createServer();
    const response = await server.call(
      "testRunChange",
      change("own", "own-right"),
      person({ permissions: right("users.manage") })
    );
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).details).toEqual({ action: "audit.view", reason: "no_grant" });
    expect((await runs())[0]).toMatchObject({
      status: "denied",
      denial: { kind: "forbidden", action: "audit.view" }
    });
  });

  it("answers 403 POLICY_DENIED where the policy says deny", async () => {
    const { server, runs, executed } = await createServer({
      settings: [{ operation: "testRunChange", value: "deny" }],
      readingDefault: "deny"
    });
    for (const response of [
      await server.call("testRunChange", change("denied"), person()),
      await server.call("testRunRead", { params: { itemId: "item-1" } }, person())
    ]) {
      expect(response.statusCode).toBe(403);
      expect(errorOf(response).code).toBe("POLICY_DENIED");
      expect(response.headers["operation-run-id"]).toEqual(expect.any(String));
    }
    expect((await runs()).map((run) => [run.operation, run.status, run.denial]).sort()).toEqual([
      ["testRunChange", "denied", { kind: "policy", operation: "testRunChange" }],
      ["testRunRead", "denied", { kind: "policy", operation: "testRunRead" }]
    ]);
    expect(executed).toEqual([]);
  });

  it("refuses a call that needs an approval where nothing can hold it", async () => {
    const { server, runs, executed } = await createServer({
      settings: [{ operation: "testRunChange", value: "approval" }]
    });
    const response = await server.call("testRunChange", change("held"), person());
    expect(response.statusCode).toBe(403);
    expect(errorOf(response)).toMatchObject({
      code: "POLICY_DENIED",
      details: { operation: "testRunChange" }
    });
    expect((await runs())[0]?.status).toBe("denied");
    expect(executed).toEqual([]);
  });

  it("answers 403 GUARDRAIL_BLOCKED where a guardrail blocks", async () => {
    const { server, runs, executed } = await createServer({
      guardrail: { event: "operation.before_call", outcome: "block" }
    });
    const response = await server.call("testRunChange", change("blocked"), person());
    expect(response.statusCode).toBe(403);
    expect(errorOf(response)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "operation.before_call" }
    });
    const [run] = await runs();
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(run).toMatchObject({ status: "denied", denial: { kind: "guardrail" } });
    expect(executed).toEqual([]);
  });

  it("refuses a read that a guardrail wants approved, since a read cannot wait", async () => {
    const { server, executed } = await createServer({
      guardrail: { event: "operation.before_call", outcome: "require_approval" },
      approvals: true
    });
    const response = await server.call("testRunRead", { params: { itemId: "i" } }, person());
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe("GUARDRAIL_BLOCKED");
    expect(executed).toEqual([]);
  });

  it("answers a refused call again from its run when the key is sent again", async () => {
    const { server, runs } = await createServer({
      settings: [{ operation: "testRunChange", value: "deny" }]
    });
    const first = await server.call("testRunChange", change("denied", "ok", "key-1"), person());
    const second = await server.call("testRunChange", change("denied", "ok", "key-1"), person());
    expect([first.statusCode, second.statusCode]).toEqual([403, 403]);
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.headers["operation-run-id"]).toBe(first.headers["operation-run-id"]);
    expect(await runs()).toHaveLength(1);
  });
});

describe("operation over HTTP: a call that waits for an approval", () => {
  const approval: ServerInput = {
    settings: [{ operation: "testRunChange", value: "approval" }],
    approvals: true
  };

  it("answers 202 with the run and where to read it, and executes nothing", async () => {
    const { server, runs, executed, approvalRequests } = await createServer(approval);
    const response = await server.call("testRunChange", change("held", "ok", "key-1"), person());
    expect(response.statusCode).toBe(202);
    const body = operationRunSchema.parse(response.json());
    const [run] = await runs();
    expect(body).toMatchObject({
      id: run?.id,
      operation: "testRunChange",
      status: "pending_approval",
      approvalRequestId: "apr_1"
    });
    expect(body.expiresAt).toEqual(expect.any(String));
    expect(response.headers.location).toBe(body.href);
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(response.payload).not.toContain("held");
    expect(run).toMatchObject({ status: "pending_approval", inputRef: "approval_request:apr_1" });
    expect(approvalRequests).toEqual([run?.id]);
    expect(executed).toEqual([]);

    // The same call again is answered from the run and files no second request.
    const again = await server.call("testRunChange", change("held", "ok", "key-1"), person());
    expect(again.statusCode).toBe(202);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(operationRunSchema.parse(again.json()).id).toBe(run?.id);
    expect(approvalRequests).toHaveLength(1);
    expect(await runs()).toHaveLength(1);

    const read = await server.call("operations.get_run", { params: { runId: body.id } }, person());
    expect(read.statusCode).toBe(200);
    expect(operationRunSchema.parse(read.json()).status).toBe("pending_approval");
  });

  it("answers 409 OPERATION_EXPIRED for the key of a call that expired unexecuted", async () => {
    const longAgo = new Date("2026-01-01T00:00:00.000Z");
    const { server, executed } = await createServer({ ...approval, now: () => longAgo });
    const first = await server.call("testRunChange", change("held", "ok", "key-1"), person());
    expect(first.statusCode).toBe(202);
    const expired = await server.stores.operationRuns.markExpired({ clientInstanceId });
    expect(expired.map((run) => run.status)).toEqual(["expired"]);

    const again = await server.call("testRunChange", change("held", "ok", "key-1"), person());
    expect(again.statusCode).toBe(409);
    expect(errorOf(again).code).toBe("OPERATION_EXPIRED");
    expect(again.headers["operation-run-id"]).toBe(first.headers["operation-run-id"]);
    expect(executed).toEqual([]);
  });
});

describe("operation over HTTP: a call that fails", () => {
  it("answers with the operation's own error and records its code and message", async () => {
    const { server, runs, auditTypes } = await createServer();
    const response = await server.call("testRunChange", change("gone", "not-found"), person());
    expect(response.statusCode).toBe(404);
    expect(errorOf(response)).toMatchObject({
      code: "NOT_FOUND",
      message: "The item does not exist",
      details: { name: "gone" }
    });
    const [run] = await runs();
    expect(response.headers["operation-run-id"]).toBe(run?.id);
    expect(run).toMatchObject({
      status: "failed",
      error: { code: "NOT_FOUND", message: "The item does not exist" }
    });
    expect(run?.error).not.toHaveProperty("details");
    expect(await auditTypes(run?.id ?? "")).toContain("operation.failed:failed");
  });

  it("lets no text of an unexpected error into the answer, the run or the audit log", async () => {
    const { server, runs, logged } = await createServer();
    const response = await server.call("testRunChange", change("broken", "throw"), person());
    expect(response.statusCode).toBe(500);
    expect(errorOf(response).code).toBe("INTERNAL");
    expect(response.payload).not.toContain(secret);
    const [run] = await runs();
    expect(run).toMatchObject({ status: "failed", error: { code: "INTERNAL" } });
    expect(JSON.stringify(run)).not.toContain(secret);
    const audit = await server.stores.audit.listAuditEvents({ clientInstanceId });
    expect(JSON.stringify(audit)).not.toContain(secret);
    // The instance's own log is where the cause is read, under the run's id.
    expect(logged).toContainEqual(expect.objectContaining({ operationRunId: run?.id }));
  });

  it("takes the same run for the next attempt when a failed call is sent again", async () => {
    const { server, runs, executed } = await createServer();
    const first = await server.call(
      "testRunChange",
      change("gone", "not-found", "key-1"),
      person()
    );
    const second = await server.call(
      "testRunChange",
      change("gone", "not-found", "key-1"),
      person()
    );
    expect([first.statusCode, second.statusCode]).toEqual([404, 404]);
    expect(second.headers["operation-run-id"]).toBe(first.headers["operation-run-id"]);
    expect(second.headers["idempotent-replayed"]).toBeUndefined();
    expect(executed).toHaveLength(2);
    expect(await runs()).toMatchObject([{ status: "failed", attempt: 2 }]);
  });
});

describe("operation over HTTP: the same call sent again", () => {
  it("answers what the first call answered and executes once", async () => {
    const { server, runs, executed } = await createServer();
    const first = await server.call("testRunChange", change("once", "ok", "key-1"), person());
    const second = await server.call("testRunChange", change("once", "ok", "key-1"), person());
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(second.json()).toEqual(first.json());
    expect(first.headers["idempotent-replayed"]).toBeUndefined();
    expect(second.headers["idempotent-replayed"]).toBe("true");
    expect(second.headers["operation-run-id"]).toBe(first.headers["operation-run-id"]);
    expect(executed).toEqual(["testRunChange:once"]);
    expect(await runs()).toHaveLength(1);
  });

  it("answers 409 IDEMPOTENCY_KEY_REUSED for the key with another input", async () => {
    const { server, executed } = await createServer();
    await server.call("testRunChange", change("once", "ok", "key-1"), person());
    const other = await server.call("testRunChange", change("other", "ok", "key-1"), person());
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(executed).toEqual(["testRunChange:once"]);
  });

  it("keeps the keys of two callers apart", async () => {
    const { server, runs, executed } = await createServer();
    const callers = [
      person({ id: "usr_one" }),
      person({ id: "usr_two" }),
      person({ kind: "service", id: "sp_one" })
    ];
    for (const caller of callers) {
      const response = await server.call("testRunChange", change("mine", "ok", "shared"), caller);
      expect(response.statusCode).toBe(200);
      expect(response.headers["idempotent-replayed"]).toBeUndefined();
    }
    expect(executed).toHaveLength(3);
    expect((await runs()).map((run) => run.actor.id).sort()).toEqual([
      "sp_one",
      "usr_one",
      "usr_two"
    ]);
  });

  it("answers 409 OPERATION_IN_PROGRESS while the first call runs", async () => {
    const { server, gate, release, executed } = await createServer();
    const first = server.call("testRunChange", change("slow", "gated", "key-1"), person());
    await gate.entered;
    const second = await server.call("testRunChange", change("slow", "gated", "key-1"), person());
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).code).toBe("OPERATION_IN_PROGRESS");
    release();
    const finished = await first;
    expect(finished.statusCode).toBe(200);
    expect(second.headers["operation-run-id"]).toBe(finished.headers["operation-run-id"]);
    expect(executed).toEqual(["testRunChange:slow"]);
  });

  it("executes once when two calls with one key arrive together", async () => {
    const { server, runs, executed } = await createServer();
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        server.call("testRunChange", change("race", "ok", "key-1"), person())
      )
    );
    expect(executed).toEqual(["testRunChange:race"]);
    expect(await runs()).toHaveLength(1);
    const first = responses.filter(
      (response) => response.statusCode === 200 && !response.headers["idempotent-replayed"]
    );
    expect(first).toHaveLength(1);
    for (const response of responses) {
      // Each other call either found the run still running or reads its recorded answer.
      expect([200, 409]).toContain(response.statusCode);
      expect(response.headers["operation-run-id"]).toBe(first[0]?.headers["operation-run-id"]);
    }
  });

  it("answers 409 OUTPUT_NOT_RETAINED when the first answer was too large to keep", async () => {
    const { server, executed } = await createServer();
    const first = await server.call("testRunChange", change("big", "large", "key-1"), person());
    expect(first.statusCode).toBe(200);
    const second = await server.call("testRunChange", change("big", "large", "key-1"), person());
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).code).toBe("OUTPUT_NOT_RETAINED");
    expect(second.headers["operation-run-id"]).toBe(first.headers["operation-run-id"]);
    expect(executed).toHaveLength(1);
  });
});

describe("operation runs: who may read them", () => {
  const read = (
    server: Awaited<ReturnType<typeof createServer>>["server"],
    runId: string,
    as: ReturnType<typeof person>
  ) => server.call("operations.get_run", { params: { runId } }, as);

  it("lets the caller read its own run and nobody else without the governance right", async () => {
    const { server } = await createServer();
    const owner = person({ id: "usr_owner", permissions: right("users.manage") });
    const made = await server.call("testRunChange", change("mine", "ok", "key-1"), owner);
    const runId = String(made.headers["operation-run-id"]);

    const own = await read(server, runId, owner);
    expect(own.statusCode).toBe(200);
    const body = operationRunSchema.parse(own.json());
    expect(body).toMatchObject({ id: runId, status: "done", actor: { id: "usr_owner" } });
    // What a caller reads holds neither the input, the answer nor the caller's key.
    expect(own.payload).not.toContain("mine");
    expect(own.payload).not.toContain("key-1");

    const other = await read(server, runId, person({ id: "usr_other", permissions: [] }));
    expect(other.statusCode).toBe(403);
    expect(errorOf(other)).toMatchObject({
      code: "FORBIDDEN",
      details: { action: "audit.view", reason: "no_grant" }
    });
    expect(other.payload).not.toContain("usr_owner");

    // A service principal whose id reads the same is another caller.
    const sameId = await read(
      server,
      runId,
      person({ kind: "service", id: "usr_owner", permissions: [] })
    );
    expect(sameId.statusCode).toBe(403);

    const auditor = await read(
      server,
      runId,
      person({ id: "usr_auditor", permissions: right("audit.view") })
    );
    expect(auditor.statusCode).toBe(200);

    const unscoped = await read(
      server,
      runId,
      person({ id: "usr_owner", scopes: ["conversation:read"] })
    );
    expect(unscoped.statusCode).toBe(403);
  });

  it("answers 404 for a run of another instance, whatever the reader's rights", async () => {
    const { server } = await createServer();
    const foreign = await server.stores.operationRuns.create({
      id: createPlatformId<"OperationRunId">("oprun"),
      clientInstanceId: asClientInstanceId("another-instance"),
      operation: "testRunChange",
      effect: "changing",
      actor: { kind: "user", id: "usr_test", label: "Test user" },
      origin: { kind: "user" },
      inputHash: "0".repeat(64),
      correlationId: "corr",
      startedAt: new Date().toISOString()
    });
    if (!foreign) throw new Error("The other instance's run must exist");
    for (const runId of [foreign.id, "oprun_missing"]) {
      const response = await read(server, runId, person({ roles: ["superadmin"] }));
      expect(response.statusCode).toBe(404);
      expect(errorOf(response).code).toBe("NOT_FOUND");
    }
    const listed = await server.call("operations.list_runs", {}, person({ roles: ["superadmin"] }));
    expect(listed.json<{ items: unknown[] }>().items).toEqual([]);
  });

  it("lists the runs of the instance for the governance right only, filtered and paged", async () => {
    const { server } = await createServer({
      settings: [{ operation: "testRunRead", value: "deny" }]
    });
    await server.call("testRunChange", change("one"), person({ id: "usr_one" }));
    await server.call("testRunChange", change("two"), person({ kind: "service", id: "sp_one" }));
    await server.call("testRunRead", { params: { itemId: "i" } }, person({ id: "usr_one" }));

    const refused = await server.call(
      "operations.list_runs",
      {},
      person({ id: "usr_one", permissions: right("users.manage") })
    );
    expect(refused.statusCode).toBe(403);

    const auditor = person({ id: "usr_auditor", permissions: right("audit.view") });
    const list = async (query: Record<string, string | number>) => {
      const response = await server.call("operations.list_runs", { query }, auditor);
      expect(response.statusCode).toBe(200);
      return response.json<{ items: { id: string; operation: string }[]; nextCursor?: string }>();
    };
    expect((await list({})).items).toHaveLength(3);
    expect((await list({ operation: "testRunRead" })).items).toHaveLength(1);
    expect((await list({ status: "denied" })).items.map((run) => run.operation)).toEqual([
      "testRunRead"
    ]);
    expect((await list({ actor: "usr_one" })).items).toHaveLength(2);
    expect((await list({ origin: "cli" })).items).toHaveLength(1);
    expect((await list({ workspaceId: "cws_none" })).items).toEqual([]);
    expect((await list({ since: "2999-01-01T00:00:00.000Z" })).items).toEqual([]);

    const firstPage = await list({ limit: 2 });
    expect(firstPage.items).toHaveLength(2);
    const rest = await list({ limit: 2, cursor: firstPage.nextCursor ?? "" });
    expect(rest.items).toHaveLength(1);
    expect(rest.nextCursor).toBeUndefined();
    expect(new Set([...firstPage.items, ...rest.items].map((run) => run.id)).size).toBe(3);
  });
});
