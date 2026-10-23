import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  mayAlwaysAllow,
  offersAlwaysAllow,
  resolvePolicy,
  type AuthenticatedUser,
  type OperationOrigin,
  type PolicyInput
} from "@work-shape/catalyst-core";
import { resolveGuardedPolicy } from "@work-shape/catalyst-tool-execution";

// OP-6: a person's own setting is one input of `resolvePolicy`. It makes a call stricter, or
// lowers a confirmation to a run where the admin permits it; floors, locks and guardrails win.

const defaults = { reading: "allow", changing: "confirm" } as const;
const reversible = { name: "rows.insert", effect: "changing", changeClass: "reversible" } as const;

/** A call the person's agent makes while the person is not there to confirm it in place. */
function resolve(input: Partial<PolicyInput> = {}) {
  const full: PolicyInput = {
    definition: reversible,
    origin: { kind: "agent", agentRunId: "run_1" },
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
  const definition = { ...reversible, input: z.object({}) } as unknown as Parameters<
    typeof resolveGuardedPolicy
  >[0]["definition"];
  const actor = { id: "user-1", displayLabel: "One" } as unknown as AuthenticatedUser;
  const asked: string[] = [];
  const policy = (origin: OperationOrigin, runtime: Record<string, unknown> = {}) =>
    resolveGuardedPolicy({
      definition,
      call: { input: {}, origin, actor },
      resource: undefined,
      runtime: runtime as never,
      emit: async () => ({ outcome: "allow", guardrails: [] }) as never,
      deps: {
        policy: {
          instanceDefaults: defaults,
          centralSettings: () => [{ operation: "rows.insert", value: "allow" }],
          personSetting: ({ userId }) => {
            asked.push(userId);
            return "never";
          }
        }
      }
    });

  it("applies to the person's own agent calls", async () => {
    expect(await policy({ kind: "agent", agentRunId: "run_1" } as OperationOrigin)).toMatchObject({
      policy: { value: "deny", source: "person_setting" }
    });
    expect(asked).toEqual(["user-1"]);
  });

  it("never applies to a Workflow's calls, nor to an agent step of a Workflow", async () => {
    asked.length = 0;
    const workflow = { kind: "workflow", workflowRunId: "wr_1", stepRunId: "s_1" } as const;
    expect(await policy(workflow)).toMatchObject({ policy: { value: "allow" } });
    expect(
      await policy({ kind: "agent", agentRunId: "run_2" } as OperationOrigin, {
        workflowAgent: true
      })
    ).toMatchObject({ policy: { value: "allow" } });
    expect(asked).toEqual([]);
  });
});
