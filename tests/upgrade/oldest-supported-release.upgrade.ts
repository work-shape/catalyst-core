import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, inject, it } from "vitest";
import { asAgentRunId, asClientInstanceId, asConversationId, asUserId } from "@vivd-catalyst/core";
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
});
