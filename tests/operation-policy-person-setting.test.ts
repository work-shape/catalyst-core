import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import {
  PLATFORM_EVENT_ALLOW,
  alwaysAllowLockIssues,
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asToolCallId,
  createPlatformId,
  mayAlwaysAllow,
  offersAlwaysAllow,
  resolvePolicy,
  type AuthenticatedUser,
  type OperationCallRuntime,
  type OperationDefinition,
  type OperationOrigin,
  type PolicyInput
} from "@work-shape/catalyst-core";
import { resolveGuardedPolicy } from "@work-shape/catalyst-tool-execution";
import { createTestConfig, createTestUser } from "./support/fixtures";

// OP-6: a person's own setting is one input of `resolvePolicy`. It makes a call stricter, or
// lowers a confirmation to a run where the admin permits it; floors, locks and guardrails win.

const defaults = { reading: "allow", changing: "confirm" } as const;
const reversible = { name: "rows.insert", effect: "changing", changeClass: "reversible" } as const;

/** A call the person's agent makes in the run `runId`. */
const agentOrigin = (runId: string): OperationOrigin => ({
  kind: "agent",
  agentRunId: asAgentRunId(runId),
  conversationId: asConversationId("conv_1"),
  agentName: "assistant",
  toolCallId: asToolCallId("call_1"),
  toolName: "rows.insert"
});

const definition: OperationDefinition = {
  ...reversible,
  action: "rows.write",
  scope: null,
  auth: "principal",
  inputSchema: z.object({}),
  outputSchema: z.unknown(),
  resource: () => undefined,
  http: { method: "POST", path: "/rows" },
  timeoutMs: 1000,
  execute: () => Promise.resolve({})
};

/** What the guardrails answer: nothing holds the call. */
const emit = () => Promise.resolve(PLATFORM_EVENT_ALLOW);

/** A call the person's agent makes while the person is not there to confirm it in place. */
function resolve(input: Partial<PolicyInput> = {}) {
  const full: PolicyInput = {
    definition: reversible,
    origin: agentOrigin("run_1"),
    instanceDefaults: defaults,
    centralSettings: [],
    callerCanConfirm: false,
    canPause: true,
    ...input
  };
  return { full, resolution: resolvePolicy(full) };
}

describe("mayAlwaysAllow", () => {
  it("permits only a reversible changing operation that no lock names", () => {
    expect(mayAlwaysAllow(reversible)).toBe(true);
    expect(mayAlwaysAllow({ ...reversible, changeClass: "irreversible" })).toBe(false);
    expect(mayAlwaysAllow({ ...reversible, changeClass: "outward" })).toBe(false);
    // An operation that declares no class counts as irreversible.
    expect(mayAlwaysAllow({ name: "rows.insert", effect: "changing" })).toBe(false);
    expect(mayAlwaysAllow({ name: "rows.list", effect: "reading" })).toBe(false);
    expect(mayAlwaysAllow(reversible, ["rows.insert"])).toBe(false);
    expect(mayAlwaysAllow(reversible, ["rows.*"])).toBe(false);
    expect(mayAlwaysAllow(reversible, ["other.*"])).toBe(true);
  });
});

describe("resolvePolicy: the person's own setting", () => {
  it("runs a confirmation the person always allows, where the admin permits it", () => {
    const { resolution } = resolve({ person: { setting: "always_allow", mayAlwaysAllow: true } });
    expect(resolution).toEqual({ value: "allow", next: "run", source: "person_setting" });
  });

  it("ignores Always allow on an operation the admin locked or whose class does not permit it", () => {
    const { resolution } = resolve({ person: { setting: "always_allow", mayAlwaysAllow: false } });
    expect(resolution).toMatchObject({ value: "confirm", next: "await_confirmation" });
  });

  it("never lowers an approval or a refusal", () => {
    for (const value of ["approval", "deny"] as const) {
      const { resolution } = resolve({
        centralSettings: [{ operation: "rows.insert", value }],
        person: { setting: "always_allow", mayAlwaysAllow: true }
      });
      expect(resolution.value).toBe(value);
    }
  });

  it("loses to a floor and to a guardrail", () => {
    const person = { setting: "always_allow", mayAlwaysAllow: true } as const;
    expect(
      resolve({ definition: { ...reversible, policyFloor: "confirm" }, person }).resolution
    ).toMatchObject({ value: "confirm", source: "policy_floor" });
    expect(resolve({ guardrailOutcome: "require_approval", person }).resolution).toMatchObject({
      value: "approval",
      source: "guardrail"
    });
  });

  it("makes an allowed call ask, and refuses a call the person never allows", () => {
    const allowed = [{ operation: "rows.insert", value: "allow" }] as const;
    expect(
      resolve({ centralSettings: allowed, person: { setting: "ask", mayAlwaysAllow: true } })
        .resolution
    ).toMatchObject({ value: "confirm", source: "person_setting" });
    expect(
      resolve({ centralSettings: allowed, person: { setting: "never", mayAlwaysAllow: false } })
        .resolution
    ).toEqual({ value: "deny", next: "refuse", source: "person_setting" });
    // Never also holds where the admin locked Always allow: it only makes things stricter.
    expect(resolve({ person: { setting: "never", mayAlwaysAllow: false } }).resolution).toEqual({
      value: "deny",
      next: "refuse",
      source: "person_setting"
    });
  });
});

describe("offersAlwaysAllow", () => {
  it("offers it on a waiting confirmation it would let run", () => {
    const { full, resolution } = resolve({ person: { mayAlwaysAllow: true } });
    expect(offersAlwaysAllow(full, resolution)).toBe(true);
  });

  it("does not offer it where it would have no effect", () => {
    const cases: Partial<PolicyInput>[] = [
      { person: { mayAlwaysAllow: false } },
      // Nobody's setting applies to the call.
      {},
      // A floor keeps asking.
      { definition: { ...reversible, policyFloor: "confirm" }, person: { mayAlwaysAllow: true } },
      // An approval is not a confirmation.
      {
        centralSettings: [{ operation: "rows.insert", value: "approval" }],
        person: { mayAlwaysAllow: true }
      }
    ];
    for (const input of cases) {
      const { full, resolution } = resolve(input);
      expect(offersAlwaysAllow(full, resolution)).toBe(false);
    }
  });
});

describe("whose calls the person's setting reaches", () => {
  const actor = createTestUser("user-1", asClientInstanceId("test-instance"));
  const asked: string[] = [];
  const policy = (origin: OperationOrigin, runtime: OperationCallRuntime = {}) =>
    resolveGuardedPolicy({
      definition,
      call: { input: {}, origin, actor },
      resource: undefined,
      runtime,
      emit,
      deps: {
        policy: {
          instanceDefaults: defaults,
          centralSettings: () => [{ operation: "rows.insert", value: "allow" }],
          personSetting: async ({ userId }) => {
            asked.push(userId);
            return "never";
          }
        }
      }
    });

  it("applies to the person's own agent calls", async () => {
    expect(await policy(agentOrigin("run_1"))).toMatchObject({
      policy: { value: "deny", source: "person_setting" }
    });
    expect(asked).toEqual(["user-1"]);
  });

  it("never applies to a Workflow's calls, nor to an agent step of a Workflow", async () => {
    asked.length = 0;
    const workflow = { kind: "workflow", workflowRunId: "wr_1", stepRunId: "s_1" } as const;
    expect(await policy(workflow)).toMatchObject({ policy: { value: "allow" } });
    expect(await policy(agentOrigin("run_2"), { workflowAgent: true })).toMatchObject({
      policy: { value: "allow" }
    });
    expect(asked).toEqual([]);
  });
});

describe("Always allow reaches only the person's own first-party calls", () => {
  const person = createTestUser("user-1", asClientInstanceId("test-instance"));
  const origin = agentOrigin("run_1");
  const policy = (
    actor: AuthenticatedUser,
    runtime: OperationCallRuntime = {},
    setting: "always_allow" | "never" = "always_allow"
  ) =>
    resolveGuardedPolicy({
      definition,
      call: { input: {}, origin, actor },
      resource: undefined,
      runtime,
      emit,
      deps: {
        policy: {
          instanceDefaults: defaults,
          centralSettings: () => [],
          personSetting: async () => setting
        }
      }
    });
  const worker: OperationCallRuntime = {
    runFence: {
      runId: asAgentRunId("run_1"),
      lease: { jobId: createPlatformId<"JobId">("job"), leaseToken: "lease_1" }
    }
  };

  it("runs the call of the person's own session, and of their run's worker", async () => {
    expect(await policy(person)).toMatchObject({
      policy: { value: "allow", source: "person_setting" }
    });
    expect(await policy(person, { ...worker, firstPartyRun: true })).toMatchObject({
      policy: { value: "allow", source: "person_setting" }
    });
  });

  it("asks for a call made with a key or for a delegated actor, and offers nothing", async () => {
    const actors: AuthenticatedUser[] = [
      { ...person, keyScopes: ["agent_runs:write"] },
      { ...person, keyScopes: [] },
      {
        ...person,
        delegatedActor: { kind: "service_principal", id: "host-user", authSource: "embed" }
      }
    ];
    for (const actor of actors) {
      // Even in a run its owner's session started: the call's own actor carries the key.
      const resolved = await policy(actor, { ...worker, firstPartyRun: true });
      expect(resolved).toMatchObject({ policy: { value: "confirm" } });
      expect(resolved).not.toHaveProperty("offersAlwaysAllow");
    }
  });

  it("asks in the worker of a run no first-party session started", async () => {
    const resolved = await policy(person, worker);
    expect(resolved).toMatchObject({ policy: { value: "confirm" } });
    expect(resolved).not.toHaveProperty("offersAlwaysAllow");
  });

  it("still refuses a call the person never allows, whoever makes it", async () => {
    expect(await policy({ ...person, keyScopes: [] }, worker, "never")).toMatchObject({
      policy: { value: "deny", source: "person_setting" }
    });
  });
});

describe("the admin's locks of Always allow", () => {
  const withLocks = (locked: string[]) =>
    parseClientInstanceConfig({ ...createTestConfig(), policy: { alwaysAllow: { locked } } });

  it("takes an operation's name or every operation under a prefix", () => {
    expect(
      withLocks(["rows.insert", "connection.crm.*", "rows.*", "web_search"]).policy.alwaysAllow
        .locked
    ).toEqual(["rows.insert", "connection.crm.*", "rows.*", "web_search"]);
  });

  it("refuses a bare star, a cut-off name and a star inside a name at load", () => {
    for (const entry of ["*", "rows*", "rows.ins*", "rows.*.insert", ".*", "rows.", ""]) {
      expect(() => withLocks([entry]), entry).toThrow(/policy\.alwaysAllow\.locked/u);
    }
  });

  it("names an entry that names no operation of the instance", () => {
    const registry = { releaseNames: () => ["rows.insert", "rows.remove", "app.save"] };
    expect(
      alwaysAllowLockIssues(
        [
          "rows.insert",
          "rows.*",
          "connection.crm.*",
          "connection.crm.send",
          "connection.*",
          "workflow.*",
          "app.*"
        ],
        registry
      )
    ).toEqual([]);
    const issues = alwaysAllowLockIssues(["rows.upsert", "files.*", "connection"], registry);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatch(/'rows\.upsert' names no operation/u);
  });
});
