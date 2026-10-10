import { describe, expect, it } from "vitest";
import { platformContextSchema } from "@vivd-catalyst/api-contract";
import {
  SCOPES_HEADER,
  SERVICE_HEADER,
  clientInstanceId,
  setupAccessInstance as setup
} from "./support/access-instance";

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

  it("names only the actions the credential's scopes let its holder use", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.createNamespace("lena-");
    for (const action of ["agent.read", "agent.write", "agent.delete", "skill.read"]) {
      await t.grant(t.kai.id, action, { namespace: "kai-" });
    }
    const namespacesWith = async (scopes: string) =>
      platformContextSchema.parse(
        (
          await t.expectOk(t.kai.id, "platform.context.get", {
            headers: { [SCOPES_HEADER]: scopes }
          })
        ).json()
      ).namespaces;

    expect(await namespacesWith("config_assets:read config_assets:write")).toEqual([
      {
        prefix: "kai-",
        displayName: "kai-",
        actions: ["agent.read", "agent.write", "agent.delete", "skill.read"]
      }
    ]);
    // A credential that only reads names no write and no delete, whatever its holder is granted.
    expect(await namespacesWith("config_assets:read")).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["agent.read", "skill.read"] }
    ]);
    expect(await namespacesWith("config_assets:write")).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["agent.write", "agent.delete"] }
    ]);
    // One that carries neither can use nothing here, so no Namespace is listed.
    expect(await namespacesWith("chat")).toEqual([]);
  });

  it("answers a service principal with what its grants and its credential open", async () => {
    const t = await setup();
    await t.createNamespace("kai-");
    await t.createNamespace("lena-");
    const asService = async (scopes?: string) => {
      const response = await t.instance.call("platform.context.get", {
        headers: { [SERVICE_HEADER]: "sp_test", ...(scopes ? { [SCOPES_HEADER]: scopes } : {}) }
      });
      expect(response.statusCode, response.body).toBe(200);
      return platformContextSchema.parse(response.json());
    };

    const before = await asService();
    expect(before.instance.id).toBe(clientInstanceId);
    expect(before.kinds).toEqual(kinds);
    // Its key reads every asset of the instance, so both Namespaces are listed for reading.
    const reads = ["agent.read", "skill.read"];
    expect(before.namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: reads },
      { prefix: "lena-", displayName: "lena-", actions: reads }
    ]);

    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "service_principal",
      holderId: "sp_test",
      action: "skill.write",
      effect: "allow",
      scopeKind: "namespace",
      namespace: "kai-",
      grantedBy: t.admin.id
    });
    expect((await asService()).namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["agent.read", "skill.read", "skill.write"] },
      { prefix: "lena-", displayName: "lena-", actions: reads }
    ]);
    expect((await asService("config_assets:write")).namespaces).toEqual([
      { prefix: "kai-", displayName: "kai-", actions: ["skill.write"] }
    ]);
    expect((await asService("chat")).namespaces).toEqual([]);
  });
});
