import { describe, expect, it } from "vitest";
import {
  change,
  createServer,
  errorOf,
  person,
  secret,
  type ServerInput
} from "./support/operation-server";
import { registeredTestOperations as operations } from "./support/operations";
import type { TestRoute } from "./support/test-instance";

// An operation whose descriptor declares its answer `secret`: a secret that is shown once, such
// as a new key. Without the flag the run keeps the answer and the second call reads it again,
// the held call answers 202, and the registration with `approval` starts.
const secretChange = { ...operations.testRunChange, secret: true } as const;

describe("operation over HTTP: an answer that holds a secret", () => {
  const registerSecret =
    (executed: string[], defaultPolicy?: "approval") =>
    (route: TestRoute): void =>
      route.operation(secretChange, {
        ...(defaultPolicy ? { defaultPolicy } : {}),
        execute: (item) => {
          executed.push(item.name);
          return Promise.resolve({ name: item.name, filler: secret });
        }
      });

  it("answers the secret once, keeps none of it and answers 409 OUTPUT_NOT_RETAINED again", async () => {
    const executed: string[] = [];
    const { server, runs, auditTypes } = await createServer({
      register: registerSecret(executed)
    });
    const first = await server.call("testRunChange", change("key", "ok", "key-1"), person());
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ name: "key", filler: secret });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", idempotencyKey: "key-1" });
    expect(run?.output).toBeUndefined();
    expect(JSON.stringify(run)).not.toContain(secret);
    expect(await auditTypes(run?.id ?? "")).toEqual([
      "operation.authorization_checked:success",
      "operation.completed:success",
      "operation.started:success"
    ]);

    const second = await server.call("testRunChange", change("key", "ok", "key-1"), person());
    expect(second.statusCode).toBe(409);
    expect(errorOf(second)).toMatchObject({
      code: "OUTPUT_NOT_RETAINED",
      details: { operationRunId: run?.id }
    });
    expect(errorOf(second).message).toContain("shown once");
    expect(second.payload).not.toContain(secret);
    expect(second.headers["operation-run-id"]).toBe(run?.id);
    expect(executed).toEqual(["key"]);
    expect(await runs()).toHaveLength(1);
  });

  it.each([
    ["an admin's setting", { settings: [{ operation: "testRunChange", value: "approval" }] }],
    ["a guardrail", { guardrail: { event: "operation.before_call", outcome: "require_approval" } }]
  ] satisfies [string, ServerInput][])(
    "refuses the call where %s asks for an approval, and never holds it",
    async (_label, input) => {
      const executed: string[] = [];
      const { server, runs, approvalRequests } = await createServer({
        ...input,
        approvals: true,
        register: registerSecret(executed)
      });
      const response = await server.call("testRunChange", change("held"), person());
      expect(response.statusCode).toBe(403);
      expect(errorOf(response)).toMatchObject({
        code: "POLICY_DENIED",
        details: { operation: "testRunChange" }
      });
      expect((await runs()).map((run) => run.status)).toEqual(["denied"]);
      expect(approvalRequests).toEqual([]);
      expect(executed).toEqual([]);
    }
  );

  // Fails without the rule for an inherited approval: the call was refused with POLICY_DENIED,
  // so an instance that sends every change to an approval could never issue a key.
  it("runs on its caller's word where only the instance default asks for an approval", async () => {
    const executed: string[] = [];
    const { server, runs, approvalRequests } = await createServer({
      changingDefault: "approval",
      approvals: true,
      register: registerSecret(executed)
    });
    const response = await server.call("testRunChange", change("issued"), person());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ name: "issued", filler: secret });
    const [run] = await runs();
    expect(run).toMatchObject({ status: "done", decision: { mode: "direct" } });
    expect(run?.output).toBeUndefined();
    expect(approvalRequests).toEqual([]);
    expect(executed).toEqual(["issued"]);
  });

  it("is still refused under that default where a setting for it asks for an approval", async () => {
    const executed: string[] = [];
    const { server, approvalRequests } = await createServer({
      changingDefault: "approval",
      settings: [{ operation: "testRunChange", value: "approval" }],
      approvals: true,
      register: registerSecret(executed)
    });
    const response = await server.call("testRunChange", change("held"), person());
    expect(response.statusCode).toBe(403);
    expect(errorOf(response).code).toBe("POLICY_DENIED");
    expect(approvalRequests).toEqual([]);
    expect(executed).toEqual([]);
  });

  it("does not start with a secret operation whose own policy is approval", async () => {
    const start = createServer({ register: registerSecret([], "approval") }).then(({ server }) =>
      server.call("testRunChange", change("held"), person())
    );
    await expect(start).rejects.toThrow(/answers a secret and cannot wait for an approval/u);
  });
});
