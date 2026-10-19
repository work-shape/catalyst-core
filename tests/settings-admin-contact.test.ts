import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import { fileTestDatabaseUrl } from "./support/test-database";
import { asClientInstanceId, asUserId } from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestConfig } from "./support/test-instance";

describe("Settings admin contact", () => {
  it("gives a member one active instance admin's name without opening the user directory", async () => {
    const app = await createTestInstance({
      config: createTestConfig({
        developmentAuth: {
          enabled: true,
          defaultUserId: "member",
          users: [
            { id: "member", externalUserId: "member", displayLabel: "A member", roles: ["user"] }
          ]
        }
      }),
      env: {},
      tools: []
    });
    const otherConfig = createTestConfig();
    otherConfig.clientInstance.id = "uxa-5c-other";
    const other = await createTestInstance({ config: otherConfig, env: {}, tools: [] });
    const clientInstanceId = asClientInstanceId(getTestConfig(app).clientInstance.id);
    try {
      await app.stores.users.createUser({
        clientInstanceId,
        displayLabel: "A disabled admin",
        roles: ["superadmin"],
        status: "disabled"
      });
      const deleting = await app.stores.users.createUser({
        clientInstanceId,
        displayLabel: "A departing admin",
        roles: ["superadmin"]
      });
      await app.stores.users.markUserDeletionRequested({ clientInstanceId, userId: deleting.id });
      await other.stores.users.resolveUserIdentity({
        clientInstanceId: asClientInstanceId(getTestConfig(other).clientInstance.id),
        authSource: "contact-test",
        externalUserId: "other-admin",
        displayLabel: "A different instance's admin",
        roles: ["superadmin"],
        permissionRefs: [],
        permissions: []
      });
      // Seeded role accounts have never signed in and are not a person to ask.
      await app.stores.users.createUser({
        clientInstanceId,
        displayLabel: "Musterfinanz Superadmin",
        roles: ["superadmin"]
      });
      const withoutAdmin = await app.call("me.get", {});
      expect(withoutAdmin.statusCode).toBe(200);
      expect(withoutAdmin.json()).not.toHaveProperty("instanceAdminName");

      const admin = await app.stores.users.resolveUserIdentity({
        clientInstanceId,
        authSource: "contact-test",
        externalUserId: "mara",
        displayLabel: "Mara",
        roles: ["superadmin"],
        permissionRefs: [],
        permissions: []
      });
      await app.stores.users.resolveUserIdentity({
        clientInstanceId,
        authSource: "contact-test",
        externalUserId: "ordinary-admin",
        displayLabel: "An ordinary admin",
        roles: ["admin"],
        permissionRefs: [],
        permissions: []
      });
      // General use-right help can name an admin; API access and model settings need a superadmin.
      expect(await app.stores.users.getInstanceAdminName({ clientInstanceId })).toBe(
        "An ordinary admin"
      );
      const me = await app.call("me.get", {});
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ displayLabel: "A member", instanceAdminName: "Mara" });
      expect(me.json()).not.toHaveProperty("identities");
      expect((await app.call("users.list", {})).statusCode).toBe(403);
      const updated = await app.call("me.update", { payload: { displayLabel: "Elif" } });
      expect(updated.statusCode).toBe(200);
      expect(updated.json()).toMatchObject({ displayLabel: "Elif", instanceAdminName: "Mara" });

      await app.stores.users.updateUser({
        clientInstanceId,
        userId: asUserId(admin.id),
        roles: ["user"]
      });
      expect((await app.call("me.get", {})).json()).not.toHaveProperty("instanceAdminName");
    } finally {
      await other.close();
      await app.close();
    }
  });

  it("selects the latest signed-in admin, ties by name and id, in one bounded query", async () => {
    const counted = new AsyncLocalStorage<string[]>();
    const app = await createTestInstance({
      postgres: { onStatement: (statement) => counted.getStore()?.push(statement) }
    });
    const clientInstanceId = asClientInstanceId(`contact-${globalThis.crypto.randomUUID()}`);
    const sql = postgres(await fileTestDatabaseUrl(), { max: 1 });
    const signIn = async (displayLabel: string, externalUserId: string) => {
      const user = await app.stores.users.resolveUserIdentity({
        clientInstanceId,
        authSource: "contact-test",
        externalUserId,
        displayLabel,
        roles: ["superadmin"],
        permissionRefs: [],
        permissions: []
      });
      return { id: asUserId(user.id) };
    };
    const contact = async () => {
      const statements: string[] = [];
      const name = await counted.run(statements, () =>
        app.stores.users.getInstanceAdminName({ clientInstanceId })
      );
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/from "product_users"/);
      expect(statements[0]).toMatch(/limit \$\d+/);
      expect(statements[0]).toMatch(
        /order by "product_users"\."last_authenticated_at" desc, "product_users"\."display_label" COLLATE "C", "product_users"\."id" COLLATE "C"/
      );
      return name;
    };
    try {
      await app.stores.users.createUser({
        clientInstanceId,
        displayLabel: "Musterfinanz Superadmin",
        roles: ["superadmin"]
      });
      const older = await signIn("Anna", "anna");
      const recent = await signIn("Mara", "mara");
      const sameName = await signIn("Mara", "mara-two");
      const laterName = await signIn("Zora", "zora");
      const disabled = await signIn("Disabled", "disabled");
      const deleting = await signIn("Departing", "departing");
      await app.stores.users.updateUser({
        clientInstanceId,
        userId: disabled.id,
        status: "disabled"
      });
      await app.stores.users.markUserDeletionRequested({ clientInstanceId, userId: deleting.id });
      await sql`
        update product_users set last_authenticated_at = '2026-01-02T00:00:00Z'
        where client_instance_id = ${clientInstanceId}`;
      await sql`
        update product_users set last_authenticated_at = '2026-01-01T00:00:00Z'
        where client_instance_id = ${clientInstanceId} and id = ${older.id}`;
      // The seeded account remains unsigned-in; disabled/deleting accounts have newer dates.
      await sql`
        update product_users set last_authenticated_at = null
        where client_instance_id = ${clientInstanceId} and display_label = 'Musterfinanz Superadmin'`;
      await sql`
        update product_users set last_authenticated_at = '2026-01-03T00:00:00Z'
        where client_instance_id = ${clientInstanceId} and id in (${disabled.id}, ${deleting.id})`;
      expect(await contact()).toBe("Mara");
      // Equal names have a stable id tie-break (the query assertion checks that order).
      const firstMara = recent.id < sameName.id ? recent : sameName;
      await app.stores.users.updateUser({
        clientInstanceId,
        userId: firstMara.id,
        roles: ["user"]
      });
      expect(await contact()).toBe("Mara");
      const secondMara = firstMara.id === recent.id ? sameName : recent;
      await app.stores.users.updateUser({
        clientInstanceId,
        userId: secondMara.id,
        roles: ["user"]
      });
      expect(await contact()).toBe("Zora");
      await app.stores.users.updateUser({
        clientInstanceId,
        userId: laterName.id,
        roles: ["user"]
      });
      expect(await contact()).toBe("Anna");
    } finally {
      await sql.end();
      await app.close();
    }
  });
});
