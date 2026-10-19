import { describe, expect, it } from "vitest";
import { setupAccessInstance, clientInstanceId } from "./support/access-instance";

const scopes = { mandant: { label: "Mandant", valueType: "text" as const } };

describe("data scope administration", () => {
  it("requires users.manage, saves values, exposes the effective assignment and records no values in audit", async () => {
    const world = await setupAccessInstance({ scopes });
    const input = {
      dimension: "mandant",
      holderKind: "user",
      holderId: world.kai.id,
      effect: "allow",
      values: ["101-private-scope", "102"]
    };
    const denied = await world.call(world.kai.id, "scope_assignments.set", { payload: input });
    expect(denied.statusCode).toBe(403);
    const saved = await world.call(world.root.id, "scope_assignments.set", {
      payload: input
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const read = await world.call(world.root.id, "scope_assignments.list", {
      query: { holderKind: "user", holderId: world.kai.id }
    });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      dimensions: scopes,
      assignments: [input],
      effective: { mandant: input.values }
    });
    const events = await world.stores.audit.listAuditEvents({
      clientInstanceId,
      limit: 100
    });
    const changed = events.filter((event) => event.type === "scope_assignment.changed");
    expect(changed).toHaveLength(1);
    expect(JSON.stringify(changed)).not.toContain("101-private-scope");
    expect(changed[0]?.metadata).toMatchObject({ valueCount: 2, all: false });
  });

  it("refuses an own assignment, also through a group, and asks a principal's administrators (H2, check 41)", async () => {
    const world = await setupAccessInstance({ scopes });
    const set = (actor: string, payload: Record<string, unknown>) =>
      world.call(actor, "scope_assignments.set", {
        payload: { dimension: "mandant", effect: "allow", values: "all", ...payload }
      });
    const lead = await world.stores.users.resolveUserIdentity({
      clientInstanceId,
      authSource: "test",
      externalUserId: "team-lead",
      displayLabel: "Team lead",
      roles: ["user"],
      permissionRefs: [],
      permissions: ["users.manage"],
      groups: ["leads"]
    });
    const principal = await world.stores.apiAccess.createServicePrincipal({
      clientInstanceId,
      displayLabel: "Nightly Workflow"
    });
    const own = { holderKind: "user", holderId: lead.id };
    for (const [actor, payload] of [
      [world.admin.id, { holderKind: "user", holderId: world.admin.id }],
      [lead.id, own],
      [lead.id, { ...own, effect: "deny", values: [] }],
      [lead.id, { holderKind: "group", holderId: "leads" }],
      [lead.id, { holderKind: "service_principal", holderId: principal.id }]
    ] as const) {
      const refused = await set(actor, payload);
      expect(refused.statusCode, JSON.stringify(payload)).toBe(403);
    }
    for (const [actor, payload] of [
      [lead.id, { holderKind: "group", holderId: "staff" }],
      [lead.id, { holderKind: "user", holderId: world.kai.id, values: ["101"] }],
      [world.root.id, { holderKind: "service_principal", holderId: principal.id }],
      [world.root.id, own]
    ] as const) {
      const saved = await set(actor, payload);
      expect(saved.statusCode, saved.body).toBe(200);
    }
  });

  it("replaces a person's stored groups on each sign-in, so a former group's values stop counting (M4)", async () => {
    const world = await setupAccessInstance({ scopes });
    const signIn = (groups: string[]) =>
      world.stores.users.resolveUserIdentity({
        clientInstanceId,
        authSource: "test",
        externalUserId: "moving-member",
        displayLabel: "Moving member",
        roles: ["user"],
        permissionRefs: [],
        permissions: [],
        groups
      });
    const member = await signIn(["staff"]);
    for (const [group, values] of [
      ["staff", ["101"]],
      ["auditors", ["102"]]
    ] as const) {
      const saved = await world.call(world.root.id, "scope_assignments.set", {
        payload: {
          dimension: "mandant",
          holderKind: "group",
          holderId: group,
          effect: "allow",
          values
        }
      });
      expect(saved.statusCode, saved.body).toBe(200);
    }
    const effective = async () => {
      const read = await world.call(world.root.id, "scope_assignments.list", {
        query: { holderKind: "user", holderId: member.id }
      });
      expect(read.statusCode, read.body).toBe(200);
      return (read.json() as { effective: unknown }).effective;
    };
    expect(await effective()).toEqual({ mandant: ["101"] });
    await signIn(["auditors"]);
    expect(
      (await world.stores.users.getUser({ clientInstanceId, userId: member.id }))?.groups
    ).toEqual(["auditors"]);
    expect(await effective()).toEqual({ mandant: ["102"] });
  });
});
