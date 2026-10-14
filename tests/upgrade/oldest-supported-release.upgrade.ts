import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import {
  asAgentRunId,
  asApiCredentialId,
  asClientInstanceId,
  asConversationId,
  asUserId
} from "@vivd-catalyst/core";
import { runVerifyPermissions } from "../../scripts/verify-permissions";
import {
  extractRelease,
  migrationsDirectory,
  migrationsPath,
  platformRoot,
  readMigrationPolicy
} from "../../scripts/migrations/policy.mjs";
import { required } from "../support/assertions";
import { PostgresFixtures } from "../support/postgres-fixtures";
import { beforeAllWithPostgres as beforeAll } from "../support/postgres-hooks";
import { upgradeFixtureDatabase } from "../support/upgrade-database";

const release = readMigrationPolicy().oldestSupportedRelease;
const clientInstanceId = asClientInstanceId("upgrade_fixture");
const userId = asUserId("user_upgrade_fixture");

function journalTags(directory: string): string[] {
  const journal: { entries: { tag: string }[] } = JSON.parse(
    readFileSync(join(directory, "meta/_journal.json"), "utf8")
  );
  return journal.entries.map((entry) => entry.tag);
}

describe(`upgrade from the oldest supported release (${release})`, () => {
  const checkout = mkdtempSync(join(tmpdir(), `catalyst-upgrade-${release}-`));
  const releaseMigrationsDirectory = join(checkout, migrationsPath);
  let upgraded: Awaited<ReturnType<typeof upgradeFixtureDatabase>> | undefined;

  beforeAll(async () => {
    // The release's own migrations, read from its tag; no file pins a copy of them.
    extractRelease({ tag: release, directory: checkout, paths: [migrationsPath] });
    upgraded = await upgradeFixtureDatabase({
      fixtures: new PostgresFixtures(inject("postgresFixturePrefix")),
      releaseMigrationsDirectory,
      fixtureFile: resolve(platformRoot, `tests/fixtures/upgrade/${release}.sql`)
    });
  });

  afterAll(async () => {
    await upgraded?.close();
    rmSync(checkout, { recursive: true, force: true });
  });

  it("applies exactly the migrations the release lacks", () => {
    const releaseTags = journalTags(releaseMigrationsDirectory);
    const headTags = journalTags(migrationsDirectory);
    expect(headTags.slice(0, releaseTags.length)).toEqual(releaseTags);
    expect(required(upgraded).applied).toEqual(headTags.slice(releaseTags.length));
  });

  it("reads the release's conversations, messages and runs through the stores", async () => {
    const { stores } = required(upgraded);
    const workspace = await stores.workspaces.ensurePersonalWorkspace({ clientInstanceId, userId });
    const conversations = await stores.conversations.listConversationsForWorkspace({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id,
      scope: { kind: "viewer", userId }
    });
    expect(conversations.map((conversation) => conversation.title)).toEqual([
      "Synthetic conversation from the oldest supported release"
    ]);
    const conversationId = asConversationId(required(conversations[0]).id);
    const messages = await stores.conversations.listMessages({ clientInstanceId, conversationId });
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Synthetic question written before the upgrade"],
      ["assistant", "Synthetic answer written before the upgrade"]
    ]);
    const run = await stores.agentRuns.getConversationAgentRun({
      clientInstanceId,
      conversationId,
      runId: asAgentRunId("run_upgrade_fixture")
    });
    expect(run).toMatchObject({ agentName: "test_agent", ownerUserId: userId });
  });

  it("has the record of Data Stores, empty, and keeps one written to it", async () => {
    const { stores } = required(upgraded);
    expect(await stores.dataStores.listDataStores({ clientInstanceId, limit: 10 })).toEqual([]);
    const record = {
      id: "cfga_upgrade_fixture",
      clientInstanceId,
      name: "findings",
      status: "provisioning" as const,
      location: { host: "db", port: 5432, database: "catalyst_ds_fixture" },
      roles: { app: "catalyst_ds_fixture_app", migration: "catalyst_ds_fixture_migration" },
      level: 0,
      migrations: [],
      conditions: [],
      targetRevision: 1,
      sizeLimitBytes: 5 * 1024 ** 3,
      createdAt: "2026-10-12T00:00:00.000Z",
      updatedAt: "2026-10-12T00:00:00.000Z"
    };
    await stores.dataStores.putDataStore(record);
    expect(
      await stores.dataStores.findDataStoreByName({ clientInstanceId, name: "findings" })
    ).toEqual(record);
  });

  it("writes what the newer schema adds onto the release's rows", async () => {
    const { stores } = required(upgraded);
    expect(await stores.users.getUserModelPreference({ clientInstanceId, userId })).toBeUndefined();
    await stores.users.setUserModelPreference({
      clientInstanceId,
      userId,
      preference: { reasoningEfforts: {} }
    });
    expect(await stores.users.getUserModelPreference({ clientInstanceId, userId })).toEqual({
      reasoningEfforts: {}
    });
  });

  it("turns the release's legacy permission lists into grant rows, and no holder's right changes", async () => {
    const { databaseUrl, stores } = required(upgraded);
    const lines: string[] = [];
    expect(await runVerifyPermissions({ databaseUrl, write: (line) => lines.push(line) })).toBe(0);
    expect(lines.at(-1)).toBe("6 holders, every right unchanged");

    const admin = await stores.users.getUser({
      clientInstanceId,
      userId: asUserId("user_upgrade_admin")
    });
    expect(admin?.permissions).toEqual([
      "config_assets.release",
      "!usage.view",
      "api_access.manage",
      "!audit.view"
    ]);
    const principals = await stores.apiAccess.listServicePrincipals({ clientInstanceId });
    expect(principals.map((principal) => principal.permissions)).toEqual([
      ["config_assets.read", "config_assets.release"]
    ]);
    // A key without a list has every scope of its principal, an empty list none.
    const scopes = async (id: string) =>
      (
        await stores.apiAccess.resolveApiCredential({
          clientInstanceId,
          credentialId: asApiCredentialId(id)
        })
      )?.credential.scopes;
    expect(await scopes("cred_upgrade_unscoped")).toBeUndefined();
    expect(await scopes("cred_upgrade_empty")).toEqual([]);
    expect(await scopes("cred_upgrade_read")).toEqual(["config_assets:read"]);
  });
});
