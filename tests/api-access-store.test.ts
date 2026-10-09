import type { PlatformStores } from "@vivd-catalyst/core";
import { createTestInstance } from "./support/test-instance";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  asClientInstanceId,
  createPlatformId,
  hashApiCredentialSecret,
  parseApiCredentialSecret
} from "@vivd-catalyst/core";

import postgres from "postgres";

interface ApiAccessStoreFixture extends Pick<PlatformStores, "apiAccess" | "users"> {
  close?: () => Promise<void>;
}

runApiAccessStoreSuite("In-memory API access store", async () => createTestInstance().stores);

const databaseUrl = process.env.POSTGRES_STORE_TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
runApiAccessStoreSuite(
  "Postgres API access store",
  async () =>
    createTestInstance({
      postgres: {
        databaseUrl: databaseUrl!,
        runMigrations: true
      }
    }).then((instance) => instance.stores),
  describePostgres,
  async () => {
    const sql = postgres(databaseUrl!, { max: 1 });
    try {
      await expect(
        sql`
          insert into service_principals (
            id,
            client_instance_id,
            display_label,
            status,
            permission_refs,
            permissions,
            created_by_client_instance_id,
            created_by_user_id,
            created_at,
            updated_at
          ) values (
            ${createPlatformId("spn")},
            ${createPlatformId("client")},
            'Invalid partial creator',
            'active',
            '[]'::jsonb,
            '[]'::jsonb,
            null,
            ${createPlatformId("usr")},
            now(),
            now()
          )
        `
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql.end();
    }
  }
);

function runApiAccessStoreSuite(
  label: string,
  createStore: () => Promise<ApiAccessStoreFixture>,
  describeSuite: Pick<typeof describe, "each"> &
    ((name: string, body: () => void) => void) = describe,
  verifyDatabaseConstraints?: () => Promise<void>
): void {
  describeSuite(label, () => {
    let store: ApiAccessStoreFixture;

    beforeAll(async () => {
      store = await createStore();
    });

    afterAll(async () => {
      await store?.close?.();
    });

    if (verifyDatabaseConstraints) {
      it("rejects partial-null creator ownership at the database constraint", async () => {
        await verifyDatabaseConstraints();
      });
    }

    it("creates, lists, and updates service principals independently per client", async () => {
      const clientInstanceId = createClientInstanceId();
      const otherClientInstanceId = createClientInstanceId();
      const created = await store.apiAccess.createServicePrincipal({
        clientInstanceId,
        displayLabel: "Catalyst CLI",
        description: "Config asset synchronization",
        permissionRefs: ["config-operators"],
        permissions: ["config_assets.read"]
      });
      await store.apiAccess.createServicePrincipal({
        clientInstanceId: otherClientInstanceId,
        displayLabel: "Other tenant CLI"
      });

      await expect(store.apiAccess.listServicePrincipals({ clientInstanceId })).resolves.toEqual([
        created
      ]);

      const updated = await store.apiAccess.updateServicePrincipal({
        clientInstanceId,
        servicePrincipalId: created.id,
        displayLabel: "Catalyst automation",
        description: null,
        status: "disabled",
        permissions: ["config_assets.read", "config_assets.release"]
      });
      expect(updated).toMatchObject({
        id: created.id,
        displayLabel: "Catalyst automation",
        description: undefined,
        status: "disabled",
        permissionRefs: ["config-operators"],
        permissions: ["config_assets.read", "config_assets.release"]
      });
      expect(updated.updatedAt >= created.updatedAt).toBe(true);
    });

    it("rejects a creator user owned by another client instance", async () => {
      const clientInstanceId = createClientInstanceId();
      const otherClientInstanceId = createClientInstanceId();
      const otherClientUser = await store.users.createUser({
        clientInstanceId: otherClientInstanceId,
        displayLabel: "Other tenant administrator"
      });

      await expect(
        store.apiAccess.createServicePrincipal({
          clientInstanceId,
          displayLabel: "Invalid automation",
          createdByUserId: otherClientUser.id
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });

      const localUser = await store.users.createUser({
        clientInstanceId,
        displayLabel: "Local administrator"
      });
      await expect(
        store.apiAccess.createServicePrincipal({
          clientInstanceId,
          displayLabel: "Valid automation",
          createdByUserId: localUser.id
        })
      ).resolves.toMatchObject({ createdByUserId: localUser.id });
    });

    it("returns a raw API key once while exposing only public credential metadata", async () => {
      const clientInstanceId = createClientInstanceId();
      const principal = await store.apiAccess.createServicePrincipal({
        clientInstanceId,
        displayLabel: "Release automation",
        permissions: ["config_assets.read", "config_assets.release"]
      });
      const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
      const created = await store.apiAccess.createApiCredential({
        clientInstanceId,
        servicePrincipalId: principal.id,
        name: "CI",
        scopes: ["config_assets.release"],
        expiresAt
      });

      expect(parseApiCredentialSecret(created.secret)).toBe(created.credential.id);
      expect(created.secret.startsWith(created.credential.keyPrefix)).toBe(true);
      expect(created.credential).not.toHaveProperty("secret");
      expect(created.credential).not.toHaveProperty("secretHash");
      expect(created.credential).toMatchObject({
        servicePrincipalId: principal.id,
        name: "CI",
        scopes: ["config_assets.release"],
        expiresAt
      });

      const listed = await store.apiAccess.listApiCredentials({
        clientInstanceId,
        servicePrincipalId: principal.id
      });
      expect(listed).toEqual([created.credential]);
      expect(listed[0]).not.toHaveProperty("secretHash");

      const resolved = await store.apiAccess.resolveApiCredential({
        clientInstanceId,
        credentialId: created.credential.id
      });
      expect(resolved).toMatchObject({
        credential: created.credential,
        servicePrincipal: principal,
        secretHash: await hashApiCredentialSecret(created.secret)
      });
      expect(resolved?.secretHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it("updates credential and principal last-used metadata, then revokes idempotently", async () => {
      const clientInstanceId = createClientInstanceId();
      const principal = await store.apiAccess.createServicePrincipal({
        clientInstanceId,
        displayLabel: "Developer CLI"
      });
      const { credential } = await store.apiAccess.createApiCredential({
        clientInstanceId,
        servicePrincipalId: principal.id,
        name: "Laptop"
      });
      const usedAt = new Date(Date.now() - 1_000).toISOString();
      const delayedOlderUsedAt = new Date(Date.now() - 60_000).toISOString();
      const delayedOlderOffsetUsedAt = new Date(Date.now() - 30_000 + 2 * 60 * 60 * 1_000)
        .toISOString()
        .replace("Z", "+02:00");

      const used = await store.apiAccess.updateApiCredentialLastUsed({
        clientInstanceId,
        credentialId: credential.id,
        usedAt
      });
      expect(used.lastUsedAt).toBe(usedAt);
      const delayed = await store.apiAccess.updateApiCredentialLastUsed({
        clientInstanceId,
        credentialId: credential.id,
        usedAt: delayedOlderUsedAt
      });
      expect(delayed.lastUsedAt).toBe(usedAt);
      const delayedWithOffset = await store.apiAccess.updateApiCredentialLastUsed({
        clientInstanceId,
        credentialId: credential.id,
        usedAt: delayedOlderOffsetUsedAt
      });
      expect(delayedWithOffset.lastUsedAt).toBe(usedAt);
      await expect(
        store.apiAccess.listServicePrincipals({ clientInstanceId })
      ).resolves.toMatchObject([{ id: principal.id, lastUsedAt: usedAt }]);

      const [firstRevocation, concurrentRevocation] = await Promise.all([
        store.apiAccess.revokeApiCredential({ clientInstanceId, credentialId: credential.id }),
        store.apiAccess.revokeApiCredential({ clientInstanceId, credentialId: credential.id })
      ]);
      expect(firstRevocation.revokedAt).toBeDefined();
      expect(concurrentRevocation).toEqual(firstRevocation);
    });

    it("does not resolve or mutate credentials through a different client instance", async () => {
      const clientInstanceId = createClientInstanceId();
      const otherClientInstanceId = createClientInstanceId();
      const principal = await store.apiAccess.createServicePrincipal({
        clientInstanceId,
        displayLabel: "Scoped CLI"
      });
      const { credential } = await store.apiAccess.createApiCredential({
        clientInstanceId,
        servicePrincipalId: principal.id,
        name: "Scoped key"
      });

      await expect(
        store.apiAccess.resolveApiCredential({
          clientInstanceId: otherClientInstanceId,
          credentialId: credential.id
        })
      ).resolves.toBeUndefined();
      await expect(
        store.apiAccess.createApiCredential({
          clientInstanceId: otherClientInstanceId,
          servicePrincipalId: principal.id,
          name: "Cross-tenant key"
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        store.apiAccess.revokeApiCredential({
          clientInstanceId: otherClientInstanceId,
          credentialId: credential.id
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
}

function createClientInstanceId() {
  return asClientInstanceId(createPlatformId("client"));
}
