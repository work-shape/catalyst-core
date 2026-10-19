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
});
