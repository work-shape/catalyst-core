import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  callerCanConfirm,
  createOperationRegistry,
  operationDenialError,
  resolvePolicy,
  type OperationDefinition,
  type OperationOrigin,
  type PolicyInput
} from "@vivd-catalyst/core";

// `resolvePolicy` is the one function that says what the policy asks of a call. Every surface
// and the startup check read it, so each rule is stated here once.

const defaults = { reading: "allow", changing: "confirm" } as const;
const changing = { name: "items.create", effect: "changing" } as const;
const reading = { name: "items.list", effect: "reading" } as const;

/** A person's own direct call unless the test says otherwise. */
function resolve(input: Partial<PolicyInput> = {}) {
  return resolvePolicy({
    definition: changing,
    origin: { kind: "user" },
    instanceDefaults: defaults,
    centralSettings: [],
    callerCanConfirm: true,
    canPause: false,
    ...input
  });
}

describe("resolvePolicy: where the value comes from", () => {
  it("takes the instance default of the operation's effect", () => {
    expect(resolve()).toEqual({
      value: "confirm",
      next: "run",
      decisionMode: "direct",
      source: "instance_default"
    });
    expect(resolve({ definition: reading })).toEqual({
      value: "allow",
      next: "run",
      source: "instance_default"
    });
  });

  it("prefers the operation's declared default to the instance default", () => {
    expect(resolve({ definition: { ...changing, defaultPolicy: "allow" } })).toEqual({
      value: "allow",
      next: "run",
      source: "declared_default"
    });
  });

  it("lets a central setting replace both, in either direction", () => {
    const definition = { ...changing, defaultPolicy: "deny" } as const;
    expect(
      resolve({ definition, centralSettings: [{ operation: "items.create", value: "allow" }] })
    ).toEqual({ value: "allow", next: "run", source: "central_setting" });
    expect(resolve({ centralSettings: [{ operation: "items.create", value: "deny" }] })).toEqual({
      value: "deny",
      next: "refuse",
      source: "central_setting"
    });
  });

  it("takes the strictest of the central settings that match", () => {
    expect(
      resolve({
        centralSettings: [
          { operation: "items.create", value: "allow" },
          { operation: "items.*", value: "approval" },
          { operation: "other.*", value: "deny" },
          { operation: "items", value: "deny" },
          { operation: "items.create.more", value: "deny" }
        ]
      })
    ).toMatchObject({ value: "approval", source: "central_setting" });
  });

  it("applies a narrowed central setting only to a call on the same target", () => {
    const centralSettings = [
      { operation: "items.create", value: "deny", workspaceId: "cws_1", assetKind: "skill" }
    ] as const;
    expect(
      resolve({ centralSettings, targets: [{ workspaceId: "cws_1", assetKind: "skill" }] })
    ).toMatchObject({ value: "deny" });
    for (const targets of [
      undefined,
      [],
      [{ workspaceId: "cws_2", assetKind: "skill" }],
      [{ workspaceId: "cws_1", assetKind: "agent" }],
      [{ workspaceId: "cws_1" }],
      // No one target carries both: the setting is narrowed to one asset, not to a batch.
      [
        { workspaceId: "cws_1", assetKind: "agent" },
        { workspaceId: "cws_2", assetKind: "skill" }
      ]
    ]) {
      expect(resolve({ centralSettings, targets })).toMatchObject({ source: "instance_default" });
    }
    expect(
      resolve({
        centralSettings: [{ operation: "items.create", value: "deny", namespace: "sales" }],
        targets: [{ namespace: "support" }]
      })
    ).toMatchObject({ source: "instance_default" });
  });

  it("applies a narrowed central setting to a batch when one of its targets carries the same", () => {
    const targets = [
      { assetKind: "agent", namespace: "sales" },
      { assetKind: "skill", namespace: "sales" }
    ];
    const narrowed = (setting: { assetKind?: string; namespace?: string }) =>
      resolve({
        centralSettings: [{ operation: "items.create", value: "deny", ...setting }],
        targets
      });
    expect(narrowed({ assetKind: "skill" })).toMatchObject({ value: "deny" });
    expect(narrowed({ namespace: "sales" })).toMatchObject({ value: "deny" });
    expect(narrowed({ assetKind: "widget" })).toMatchObject({ source: "instance_default" });
    // A setting that is not narrowed applies to a call that names no target at all.
    expect(
      resolve({ centralSettings: [{ operation: "items.create", value: "deny" }], targets: [] })
    ).toMatchObject({ value: "deny" });
  });
});

describe("resolvePolicy: a call with several targets", () => {
  const skillAllowed = [{ operation: "items.create", value: "allow", assetKind: "skill" }] as const;
  const skill = { assetKind: "skill", namespace: "sales" };
  const agent = { assetKind: "agent", namespace: "sales" };

  it("never lets the setting of one target loosen another target", () => {
    for (const base of ["approval", "deny", "confirm"] as const) {
      const instance = { instanceDefaults: { reading: "allow", changing: base } } as const;
      // The skill alone is allowed, the agent alone stands at the default.
      expect(
        resolve({ ...instance, centralSettings: skillAllowed, targets: [skill] })
      ).toMatchObject({ value: "allow", source: "central_setting" });
      const alone = resolve({ ...instance, centralSettings: skillAllowed, targets: [agent] });
      expect(alone).toMatchObject({ value: base, source: "instance_default" });
      // Together the batch is what its strictest target is, in either order.
      for (const targets of [
        [skill, agent],
        [agent, skill]
      ]) {
        expect(resolve({ ...instance, centralSettings: skillAllowed, targets })).toEqual(alone);
      }
    }
  });

  it("takes the strictest of what each target's own settings resolve to", () => {
    const centralSettings = [
      ...skillAllowed,
      { operation: "items.create", value: "confirm", assetKind: "agent" },
      { operation: "items.create", value: "approval", namespace: "support" }
    ] as const;
    const instance = { instanceDefaults: { reading: "allow", changing: "deny" } } as const;
    expect(resolve({ ...instance, centralSettings, targets: [skill, agent] })).toMatchObject({
      value: "confirm",
      source: "central_setting"
    });
    expect(
      resolve({
        ...instance,
        centralSettings,
        targets: [skill, { assetKind: "skill", namespace: "support" }]
      })
    ).toMatchObject({ value: "approval", source: "central_setting" });
    // A declared default is the base of every target as the instance default is.
    expect(
      resolve({
        definition: { ...changing, defaultPolicy: "approval" },
        centralSettings: skillAllowed,
        targets: [skill, agent]
      })
    ).toMatchObject({ value: "approval", source: "declared_default" });
  });
});

describe("resolvePolicy: guardrails", () => {
  it("lets a guardrail tighten and never loosen", () => {
    expect(resolve({ guardrailOutcome: "block" })).toEqual({
      value: "deny",
      next: "refuse",
      source: "guardrail"
    });
    expect(resolve({ guardrailOutcome: "require_approval" })).toEqual({
      value: "approval",
      next: "await_approval",
      source: "guardrail"
    });
    for (const guardrailOutcome of ["allow", "warn", "require_approval"] as const) {
      expect(
        resolve({
          guardrailOutcome,
          centralSettings: [{ operation: "items.create", value: "deny" }]
        })
      ).toEqual({ value: "deny", next: "refuse", source: "central_setting" });
    }
    expect(resolve({ guardrailOutcome: "warn" })).toMatchObject({ value: "confirm" });
  });
});

describe("resolvePolicy: reading operations", () => {
  it("resolves a reading operation to allow or deny only", () => {
    for (const value of ["confirm", "approval"] as const) {
      // Neither a declaration, a default nor a setting can make a read wait.
      expect(resolve({ definition: { ...reading, defaultPolicy: value } })).toMatchObject({
        value: "allow",
        source: "instance_default"
      });
      expect(
        resolve({ definition: reading, instanceDefaults: { ...defaults, reading: value } })
      ).toMatchObject({ value: "allow", next: "run" });
      expect(
        resolve({ definition: reading, centralSettings: [{ operation: "items.*", value }] })
      ).toMatchObject({ value: "allow", source: "instance_default" });
    }
    expect(
      resolve({ definition: reading, instanceDefaults: { ...defaults, reading: "deny" } })
    ).toMatchObject({ value: "deny", next: "refuse" });
    expect(resolve({ definition: reading, guardrailOutcome: "require_approval" })).toEqual({
      value: "deny",
      next: "refuse",
      source: "guardrail"
    });
  });
});

describe("resolvePolicy: who can confirm and what can wait", () => {
  it("counts a present caller's own call as its confirmation", () => {
    expect(resolve({ callerCanConfirm: true })).toMatchObject({
      next: "run",
      decisionMode: "direct"
    });
  });

  it("holds a call nobody present made where the surface can pause, and refuses it elsewhere", () => {
    expect(resolve({ callerCanConfirm: false, canPause: true })).toEqual({
      value: "confirm",
      next: "await_confirmation",
      source: "instance_default"
    });
    expect(resolve({ callerCanConfirm: false, canPause: false })).toEqual({
      value: "deny",
      next: "refuse",
      source: "surface_cannot_pause"
    });
  });

  it("sends an approval to another person, also for a caller who could confirm", () => {
    const centralSettings = [{ operation: "items.create", value: "approval" }] as const;
    expect(resolve({ centralSettings })).toMatchObject({ next: "await_approval" });
    expect(resolve({ centralSettings, callerCanConfirm: false, canPause: true })).toMatchObject({
      next: "await_approval"
    });
    expect(resolve({ centralSettings, callerCanConfirm: false, canPause: false })).toEqual({
      value: "deny",
      next: "refuse",
      source: "surface_cannot_pause"
    });
  });

  it("reads who can confirm from the origin, not from one origin's name", () => {
    const origins: [OperationOrigin, boolean][] = [
      [{ kind: "user" }, true],
      [{ kind: "cli" }, true],
      [{ kind: "mcp" }, true],
      [{ kind: "app", appRevisionId: "rev", actionName: "save", pageSessionId: "page" }, true],
      [{ kind: "workflow", workflowRunId: "wf", stepRunId: "step" }, false],
      [{ kind: "schedule", scheduleId: "sch" }, false]
    ];
    for (const [origin, expected] of origins) {
      expect(callerCanConfirm(origin)).toBe(expected);
    }
  });
});

describe("operation registry: who checks the right", () => {
  const definition = (): OperationDefinition => ({
    name: "items.list",
    effect: "reading",
    action: "audit.view",
    scope: null,
    auth: "principal",
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    resource: () => undefined,
    http: { method: "GET", path: "/items" },
    timeoutMs: 1000,
    execute: () => Promise.resolve([])
  });

  it("registers an operation with a named right or with its own check", () => {
    const registry = createOperationRegistry();
    registry.register(definition());
    const { action: _action, ...rest } = definition();
    registry.register({
      ...rest,
      name: "items.own",
      action: null,
      authorize: () => ({ allowed: true })
    });
  });

  // The types refuse both registrations, so each is built around them.
  it("refuses an operation that names no right and has no check of its own", () => {
    const unchecked = definition();
    Reflect.set(unchecked, "action", null);
    expect(() => createOperationRegistry().register(unchecked)).toThrow(
      /names no right and has no check of its own/u
    );
  });

  it("refuses an operation that names a right and checks rights itself too", () => {
    const doubled = definition();
    Reflect.set(doubled, "authorize", () => ({ allowed: true }));
    expect(() => createOperationRegistry().register(doubled)).toThrow(
      /may not check rights itself too/u
    );
  });
});

describe("operationDenialError", () => {
  it("answers every refusal with 403 and the code that names what refused", () => {
    const refusals = [
      [{ kind: "forbidden", action: "users.manage", reason: "no_grant" }, "FORBIDDEN"],
      [{ kind: "policy", operation: "items.create" }, "POLICY_DENIED"],
      [{ kind: "guardrail", guardrailId: "grd_1" }, "GUARDRAIL_BLOCKED"],
      [{ kind: "declined", by: "usr_approver", comment: "Not now" }, "DECLINED"]
    ] as const;
    for (const [denial, code] of refusals) {
      const error = operationDenialError(denial);
      expect([error.statusCode, error.code]).toEqual([403, code]);
    }
    expect(operationDenialError(refusals[3][0]).details).toEqual({
      by: "usr_approver",
      comment: "Not now"
    });
    expect(operationDenialError({ kind: "declined", by: "usr_approver" }).details).toEqual({
      by: "usr_approver"
    });
  });
});
