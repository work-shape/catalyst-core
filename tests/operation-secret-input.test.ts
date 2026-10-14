import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  change,
  createServer,
  errorOf,
  person,
  type ServerInput
} from "./support/operation-server";
import { registeredTestOperations as operations } from "./support/operations";
import type { TestRoute } from "./support/test-instance";

// An operation whose input can hold a secret, such as a password, and says so with
// `inputWithoutSecrets`. Here a name that starts with `pw-` stands for the password. Without
// the rule the run's hash is a plain SHA-256 over the password, kept in the row and shown
// with the run, the answer is kept, and the call is held with its input for an approval.
const MARK = "[password]";
const registerWithSecretInput =
  (executed: string[]) =>
  (route: TestRoute): void =>
    route.operation(operations.testRunChange, {
      inputWithoutSecrets: (item) =>
        item.name.startsWith("pw-") ? { ...item, name: MARK } : undefined,
      execute: (item) => {
        executed.push(item.name);
        return Promise.resolve({ name: "set" });
      }
    });

/** The hash a run keeps of this fixture's input: SHA-256 over the JSON with sorted keys. */
const hashInput = (input: { name: string; mode: string }): string =>
  createHash("sha256")
    .update(`{"mode":${JSON.stringify(input.mode)},"name":${JSON.stringify(input.name)}}`)
    .digest("hex");

describe("operation over HTTP: an input that holds a secret", () => {
  it("hashes the input without the secret, keeps no answer and does not run twice", async () => {
    const executed: string[] = [];
    const { server, runs } = await createServer({ register: registerWithSecretInput(executed) });
    const first = await server.call("testRunChange", change("pw-hunter22", "ok", "k-1"), person());
    expect(first.statusCode).toBe(200);
    const other = await server.call("testRunChange", change("pw-other-one", "ok", "k-2"), person());
    expect(other.statusCode).toBe(200);
    const [one, two] = (await runs()).sort((a, b) =>
      (a.idempotencyKey ?? "").localeCompare(b.idempotencyKey ?? "")
    );
    // The hash says a password was sent and never which: two passwords hash alike, and
    // nobody finds the password by hashing guesses of the input.
    expect(one?.inputHash).toBe(hashInput({ name: MARK, mode: "ok" }));
    expect(two?.inputHash).toBe(one?.inputHash);
    expect(one?.inputHash).not.toBe(hashInput({ name: "pw-hunter22", mode: "ok" }));
    expect(one?.output).toBeUndefined();
    expect(JSON.stringify([one, two])).not.toContain("hunter22");

    const again = await server.call("testRunChange", change("pw-hunter22", "ok", "k-1"), person());
    expect(again.statusCode).toBe(409);
    expect(errorOf(again)).toMatchObject({
      code: "OUTPUT_NOT_RETAINED",
      details: { operationRunId: one?.id }
    });
    // Not the text of a secret answer: nothing was shown once, and nothing is to revoke.
    expect(errorOf(again).message).toBe(
      "The call was already carried out and its answer is not kept. To carry it out again, call with a new Idempotency-Key."
    );
    expect(executed).toEqual(["pw-hunter22", "pw-other-one"]);
    expect(await runs()).toHaveLength(2);
  });

  // Fails without the change: a judge on `operation.before_call` read the password and sent it
  // to its model.
  it("hands the guardrails of the call the input without the secret", async () => {
    const { server, checked } = await createServer({
      register: registerWithSecretInput([]),
      guardrail: { event: "operation.before_call", outcome: "block" }
    });
    const refused = await server.call(
      "testRunChange",
      change("pw-hunter22", "ok", "k-1"),
      person()
    );
    expect(refused.statusCode).toBe(403);
    expect(checked).toEqual([{ input: JSON.stringify({ name: MARK, mode: "ok" }) }]);
  });

  it("treats a call without a secret as any other: hashed whole, answered again", async () => {
    const executed: string[] = [];
    const { server, runs } = await createServer({ register: registerWithSecretInput(executed) });
    const first = await server.call("testRunChange", change("plain", "ok", "k-1"), person());
    expect(first.statusCode).toBe(200);
    const [run] = await runs();
    expect(run?.inputHash).toBe(hashInput({ name: "plain", mode: "ok" }));
    expect(run?.output).toEqual({ value: { name: "set" } });
    const again = await server.call("testRunChange", change("plain", "ok", "k-1"), person());
    expect(again.statusCode).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(executed).toEqual(["plain"]);
  });

  // The mark is not what tells a secret: a password that reads like the mark is one too.
  it("keeps no answer of a call whose secret reads like the mark", async () => {
    const executed: string[] = [];
    const { server, runs } = await createServer({
      register: (route) =>
        route.operation(operations.testRunChange, {
          inputWithoutSecrets: (item) => ({ ...item, name: MARK }),
          execute: (item) => {
            executed.push(item.name);
            return Promise.resolve({ name: "set" });
          }
        })
    });
    const first = await server.call("testRunChange", change(MARK, "ok", "k-1"), person());
    expect(first.statusCode).toBe(200);
    expect((await runs())[0]?.output).toBeUndefined();
    const again = await server.call("testRunChange", change(MARK, "ok", "k-1"), person());
    expect(again.statusCode).toBe(409);
    expect(executed).toEqual([MARK]);
  });

  it.each([
    ["an admin's setting", { settings: [{ operation: "testRunChange", value: "approval" }] }],
    ["a guardrail", { guardrail: { event: "operation.before_call", outcome: "require_approval" } }]
  ] satisfies [string, ServerInput][])(
    "never holds a call with a secret where %s asks for an approval, and holds one without",
    async (_label, input) => {
      const executed: string[] = [];
      const { server, runs, approvalRequests } = await createServer({
        ...input,
        approvals: true,
        register: registerWithSecretInput(executed)
      });
      const withSecret = await server.call("testRunChange", change("pw-hunter22"), person());
      expect(withSecret.statusCode).toBe(403);
      expect(errorOf(withSecret).code).toBe("POLICY_DENIED");
      expect(approvalRequests).toEqual([]);
      const without = await server.call("testRunChange", change("plain"), person());
      expect(without.statusCode).toBe(202);
      expect(approvalRequests).toHaveLength(1);
      expect((await runs()).map((run) => run.status).sort()).toEqual([
        "denied",
        "pending_approval"
      ]);
      expect(executed).toEqual([]);
    }
  );

  it("runs a call with a secret on its caller's word under an instance default of approval", async () => {
    const executed: string[] = [];
    const { server, runs, approvalRequests } = await createServer({
      changingDefault: "approval",
      approvals: true,
      register: registerWithSecretInput(executed)
    });
    const response = await server.call("testRunChange", change("pw-hunter22"), person());
    expect(response.statusCode).toBe(200);
    const [run] = await runs();
    expect(run).toMatchObject({
      status: "done",
      decision: { mode: "direct", reason: "inherited_approval_not_applied" }
    });
    expect(approvalRequests).toEqual([]);
    expect(executed).toEqual(["pw-hunter22"]);
  });
});
