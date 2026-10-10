import { describe, expect, it } from "vitest";
import { platformContextSchema } from "@vivd-catalyst/api-contract";
import { setupAccessInstance as setup } from "./support/access-instance";

// `platform.context.get` is the first read of an outside editor: where it is, which kinds
// exist, and where the caller may do what.

const kinds = [
  {
    kind: "agent",
    plural: "agents",
    actions: { read: "agent.read", write: "agent.write", delete: "agent.delete" }
  },
  {
    kind: "skill",
    plural: "skills",
    actions: { read: "skill.read", write: "skill.write", delete: "skill.delete" }
  }
];

describe("platform.context.get", () => {
  it("answers a user with one Namespace grant that Namespace with the action, and both kinds", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.createNamespace("lena-");
    await t.grant(t.kai.id, "agent.write", { namespace: "kai-" });

    const context = platformContextSchema.parse(
      (await t.expectOk(t.kai.id, "platform.context.get")).json()
    );

    expect(context.instance).toEqual({ id: "demo-local", name: "Access test" });
    expect(context.release.version).toMatch(/^\d+\.\d+\.\d+/u);
    expect(context.kinds).toEqual(kinds);
    expect(context.namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["agent.write"] }
    ]);
    // No field for modules: the module slice adds it.
    expect(Object.keys(context).sort()).toEqual(["instance", "kinds", "namespaces", "release"]);
  });

  it("lists no Namespace for a user who holds nothing, and an administrator's actions less a deny", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.grant(t.admin.id, "agent.delete", { namespace: "kai-" }, "deny");

    const lena = platformContextSchema.parse(
      (await t.expectOk(t.lena.id, "platform.context.get")).json()
    );
    expect(lena.kinds).toEqual(kinds);
    expect(lena.namespaces).toEqual([]);

    const admin = platformContextSchema.parse(
      (await t.expectOk(t.admin.id, "platform.context.get")).json()
    );
    expect(admin.namespaces).toEqual([
      {
        prefix: "kai-",
        displayName: "kai-",
        actions: ["agent.read", "agent.write", "skill.read", "skill.write", "skill.delete"]
      }
    ]);
  });
});
