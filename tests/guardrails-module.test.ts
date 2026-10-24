import { describe, expect, it } from "vitest";
import { platformModules, resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import {
  parseClientInstanceConfig,
  resolveModuleSwitches
} from "@work-shape/catalyst-config-schema";
import { createModuleRegistry } from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { errorOf, fixture } from "./support/operation-approval";

// The `guardrails` module (core-extraction-guardrails.md, section 3, rules 3 to 6): off, its
// operations, its kind and its rights are gone and every before-event allows; a release that
// names guardrails while it is off does not load; a config without its switch keeps it on for
// one transition release.

const off = { modules: { guardrails: { enabled: false } } };
const blocker = {
  blocker: {
    on: "operation.before_call",
    check: { kind: "pattern", pattern: "." },
    outcome: "block"
  }
};

describe("the guardrails module", () => {
  it("is on where the release config has no switch for it", () => {
    const config = parseClientInstanceConfig(createTestConfig());
    expect(resolveModuleSwitches(config).guardrails).toEqual({ enabled: true });
    expect(resolveInstanceModules(config, []).snapshot.isEnabled("guardrails")).toBe(true);
  });

  it("is off where the switch says so", () => {
    const config = parseClientInstanceConfig({ ...createTestConfig(), ...off });
    expect(resolveInstanceModules(config, []).snapshot.isEnabled("guardrails")).toBe(false);
  });

  it("refuses a release that sets guardrails while the module is off, naming them", () => {
    expect(() =>
      parseClientInstanceConfig({ ...createTestConfig(), ...off, guardrails: blocker })
    ).toThrow(/Module 'guardrails' is off but release config sets 'guardrails' \(blocker\)/u);
    // On, or without a switch, the same guardrails load.
    expect(
      Object.keys(
        parseClientInstanceConfig({ ...createTestConfig(), guardrails: blocker }).guardrails
      )
    ).toEqual(["blocker"]);
  });

  it("refuses to start on, or without a switch, where the build ships no code for it", () => {
    const withoutGuardrails = createModuleRegistry(
      platformModules.filter((module) => module.name !== "guardrails")
    );
    const config = parseClientInstanceConfig(createTestConfig());
    for (const switches of [resolveModuleSwitches(config), { guardrails: { enabled: true } }]) {
      expect(() => withoutGuardrails.snapshot(switches)).toThrow(
        /Module 'guardrails' is enabled but this build ships no code for it/u
      );
    }
    expect(
      withoutGuardrails.snapshot({ guardrails: { enabled: false } }).isEnabled("guardrails")
    ).toBe(false);
  });
});

describe("the guardrails module while it is off", () => {
  it("answers its operations with module_off", async () => {
    const t = await fixture({ release: off, settings: () => [] });
    for (const [operation, input] of [
      ["guardrails.list_shipped", {}],
      ["guardrails.list_hits", { params: { name: "blocker" } }]
    ] as const) {
      const refused = await t.app.call(operation, { ...input, headers: t.as("root") });
      expect(refused.statusCode, operation).toBe(404);
      expect(errorOf(refused).details, operation).toMatchObject({
        reason: "module_off",
        module: "guardrails"
      });
    }
  });

  it("hides the guardrail kind", async () => {
    const t = await fixture({ release: off, settings: () => [] });
    const refused = await t.app.call("assets.list", {
      params: { kind: "guardrail" },
      headers: t.as("root")
    });
    expect(refused.statusCode).toBe(404);
    expect(errorOf(refused).details).toMatchObject({ reason: "module_off", module: "guardrails" });
  });

  it("grants no guardrail right", async () => {
    const t = await fixture({ release: off, settings: () => [] });
    // The requester is known once they have called.
    expect((await t.call("requester", "first")).statusCode).toBe(200);
    const refused = await t.app.call("permissions.grant", {
      headers: t.as("root"),
      payload: {
        holderKind: "user",
        holderId: await t.userId("Requester"),
        action: "guardrail.publish",
        effect: "allow",
        scopeKind: "instance"
      }
    });
    expect(refused.statusCode, refused.body).toBe(404);
    expect(errorOf(refused).details).toMatchObject({ reason: "module_off", module: "guardrails" });
  });

  it("allows at the before-events, also where a guardrail stored while it was on blocks", async () => {
    // On, the release guardrail is seeded as a stored asset and refuses the call.
    const on = await fixture({ release: { guardrails: blocker }, settings: () => [] });
    const blocked = await on.call("requester", "blocked");
    expect(blocked.statusCode).toBe(403);
    expect(errorOf(blocked)).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      details: { guardrailId: "blocker" }
    });
    await on.app.close();

    // Off, on the same database: the stored guardrail is still there and nothing asks it.
    const t = await fixture({ release: off, settings: () => [] });
    const allowed = await t.call("requester", "allowed");
    expect(allowed.statusCode, allowed.body).toBe(200);
    expect(t.executed).toEqual(["requester:allowed"]);
  });
});
