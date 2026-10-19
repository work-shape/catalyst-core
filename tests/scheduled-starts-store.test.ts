import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  asClientInstanceId,
  type ScheduledStart,
  type ScheduledStartRun
} from "@work-shape/catalyst-core";
import { createTestInstance } from "./support/test-instance";
import { fileTestDatabaseUrl } from "./support/test-database";
import { addTestStoreHelpers } from "./support/test-store";

let databaseUrl: string;
beforeAll(async () => {
  databaseUrl = await fileTestDatabaseUrl();
});

async function fixture() {
  const stores = addTestStoreHelpers((await createTestInstance({ postgres: {} })).stores);
  const clientInstanceId = asClientInstanceId(`scheduled_${crypto.randomUUID()}`);
  const owner = await stores.users.createUser({ clientInstanceId, displayLabel: "Owner" });
  const other = await stores.users.createUser({ clientInstanceId, displayLabel: "Other" });
  const workspace = await stores.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: owner.id
  });
  const start: ScheduledStart = {
    id: crypto.randomUUID(),
    clientInstanceId,
    ownerUserId: owner.id,
    collaborationWorkspaceId: workspace.id,
    agentName: "assistant",
    prompt: "Read the news",
    cron: "0 9 * * *",
    timeZone: "Europe/Berlin",
    state: "active",
    nextRunAt: "2026-10-20T07:00:00.000Z",
    personalConnectionsAllowed: false,
    createdAt: "2026-10-19T08:00:00.000Z",
    updatedAt: "2026-10-19T08:00:00.000Z"
  };
  await stores.scheduledStarts.create({ start });
  return { stores, clientInstanceId, owner, other, start };
}

describe("scheduled starts persistence", () => {
  it("scopes lists and writes to the current owner and pages equal timestamps", async () => {
    const { stores, start, clientInstanceId, owner, other } = await fixture();
    const second = { ...start, id: `${start.id}z` };
    await stores.scheduledStarts.create({ start: second });
    expect(
      await stores.scheduledStarts.list({
        clientInstanceId,
        ownerUserId: other.id,
        page: { limit: 10 }
      })
    ).toEqual([]);
    const firstPage = await stores.scheduledStarts.list({
      clientInstanceId,
      ownerUserId: owner.id,
      page: { limit: 1 }
    });
    expect(firstPage.map((row) => row.id)).toEqual([second.id]);
    expect(
      (
        await stores.scheduledStarts.list({
          clientInstanceId,
          ownerUserId: owner.id,
          page: { limit: 1, after: [start.createdAt, second.id] }
        })
      ).map((row) => row.id)
    ).toEqual([start.id]);
    expect(
      await stores.scheduledStarts.get({
        clientInstanceId: asClientInstanceId("elsewhere"),
        id: start.id
      })
    ).toBeUndefined();
    await expect(
      stores.scheduledStarts.update({
        clientInstanceId,
        id: start.id,
        ownerUserId: other.id,
        patch: { prompt: "Hijacked" },
        now: start.updatedAt
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      stores.scheduledStarts.delete({ clientInstanceId, id: start.id, ownerUserId: other.id })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const handedOver = await stores.scheduledStarts.update({
      clientInstanceId,
      id: start.id,
      ownerUserId: owner.id,
      patch: { ownerUserId: other.id, state: "paused", nextRunAt: null },
      now: "2026-10-19T09:00:00.000Z"
    });
    expect(handedOver).toMatchObject({ ownerUserId: other.id, state: "paused", nextRunAt: null });
    await expect(
      stores.scheduledStarts.update({
        clientInstanceId,
        id: start.id,
        ownerUserId: owner.id,
        patch: { state: "active" },
        now: start.updatedAt
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("reads the live run status and preserves immutable consent after handover and deletion", async () => {
    const { stores, start, clientInstanceId, owner, other } = await fixture();
    const conversation = await stores.createConversationForTesting({
      clientInstanceId,
      createdByUserId: owner.id,
      createdByExternalUserId: "owner",
      title: "Scheduled result",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const agentRun = await stores.createAgentRunForTesting(conversation);
    const run: ScheduledStartRun = {
      id: crypto.randomUUID(),
      scheduledStartId: start.id,
      scheduledFor: start.nextRunAt ?? start.createdAt,
      conversationId: conversation.id,
      agentRunId: agentRun.id,
      status: "queued",
      reason: null,
      personalConnectionsAllowed: false,
      createdAt: start.createdAt
    };
    await stores.scheduledStarts.addRun({ clientInstanceId, run });
    expect(
      await stores.scheduledStarts.hasOpenRun({ clientInstanceId, scheduledStartId: start.id })
    ).toBe("active");
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      await sql`update agent_runs set status = 'waiting_for_decision' where id = ${agentRun.id}`;
      expect(
        await stores.scheduledStarts.hasOpenRun({ clientInstanceId, scheduledStartId: start.id })
      ).toBe("waiting_for_decision");
      expect(
        (
          await stores.scheduledStarts.getRun({
            clientInstanceId,
            scheduledStartId: start.id,
            scheduledFor: run.scheduledFor
          })
        )?.status
      ).toBe("waiting_for_decision");
      expect(
        (
          await stores.scheduledStarts.listRuns({
            clientInstanceId,
            scheduledStartId: start.id,
            page: { limit: 10 }
          })
        )[0]?.conversationId
      ).toBe(conversation.id);
      const skippedId = crypto.randomUUID();
      await stores.scheduledStarts.addRun({
        clientInstanceId,
        run: {
          ...run,
          id: skippedId,
          scheduledFor: "2026-10-21T07:00:00.000Z",
          conversationId: null,
          agentRunId: null,
          status: "skipped",
          reason: "waiting_for_decision"
        }
      });
      await stores.transaction(async (tx) => {
        await tx.scheduledStarts.get({ clientInstanceId, id: start.id, forUpdate: true });
        await tx.scheduledStarts.detachRuns({ clientInstanceId, scheduledStartId: start.id });
        await tx.scheduledStarts.update({
          clientInstanceId,
          id: start.id,
          ownerUserId: owner.id,
          patch: { ownerUserId: other.id, personalConnectionsAllowed: true },
          now: start.updatedAt
        });
      });
      expect(
        await stores.scheduledStarts.listRuns({
          clientInstanceId,
          scheduledStartId: start.id,
          page: { limit: 10 }
        })
      ).toEqual([]);
      expect(
        await stores.scheduledStarts.hasOpenRun({ clientInstanceId, scheduledStartId: start.id })
      ).toBeUndefined();
      expect(await sql`select id from scheduled_start_runs where id = ${skippedId}`).toHaveLength(
        0
      );
      expect(
        await stores.scheduledStarts.isScheduledAgentRun({ clientInstanceId, runId: agentRun.id })
      ).toEqual({ personalConnectionsAllowed: false });
      await stores.scheduledStarts.delete({
        clientInstanceId,
        id: start.id,
        ownerUserId: other.id
      });
      expect(
        await stores.scheduledStarts.isScheduledAgentRun({ clientInstanceId, runId: agentRun.id })
      ).toEqual({ personalConnectionsAllowed: false });
      expect(
        await stores.scheduledStarts.isScheduledAgentRun({
          clientInstanceId: asClientInstanceId("elsewhere"),
          runId: agentRun.id
        })
      ).toBeUndefined();
      await sql`delete from conversations where id = ${conversation.id}`;
      expect(
        await stores.scheduledStarts.isScheduledAgentRun({ clientInstanceId, runId: agentRun.id })
      ).toBeUndefined();
    } finally {
      await sql.end();
    }
  });

  it("checks only the newest started result, ignoring newer skipped ticks", async () => {
    const { stores, start, clientInstanceId, owner } = await fixture();
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const runIds = [];
      for (const [index, createdAt] of [
        "2026-10-19T08:00:00.000Z",
        "2026-10-19T09:00:00.000Z"
      ].entries()) {
        const conversation = await stores.createConversationForTesting({
          clientInstanceId,
          createdByUserId: owner.id,
          createdByExternalUserId: "owner",
          title: `Result ${index}`,
          retainedUntil: "2030-01-01T00:00:00.000Z"
        });
        const agentRun = await stores.createAgentRunForTesting(conversation);
        runIds.push(agentRun.id);
        await stores.scheduledStarts.addRun({
          clientInstanceId,
          run: {
            id: crypto.randomUUID(),
            scheduledStartId: start.id,
            scheduledFor: createdAt,
            conversationId: conversation.id,
            agentRunId: agentRun.id,
            status: "queued",
            reason: null,
            personalConnectionsAllowed: false,
            createdAt
          }
        });
      }
      const older = runIds[0];
      const newest = runIds[1];
      if (!older || !newest) throw new Error("Expected both started results");
      await sql`update agent_runs set status = 'waiting_for_decision' where id = ${older}`;
      await sql`update agent_runs set status = 'completed' where id = ${newest}`;
      // The lookup is bounded to the latest started lineage, even if historical data holds
      // an older nonterminal status. A serialized dispatcher cannot start both concurrently.
      expect(
        await stores.scheduledStarts.hasOpenRun({ clientInstanceId, scheduledStartId: start.id })
      ).toBeUndefined();
      await stores.scheduledStarts.addRun({
        clientInstanceId,
        run: {
          id: crypto.randomUUID(),
          scheduledStartId: start.id,
          scheduledFor: "2026-10-19T10:00:00.000Z",
          conversationId: null,
          agentRunId: null,
          status: "skipped",
          reason: "waiting_for_decision",
          personalConnectionsAllowed: false,
          createdAt: "2026-10-19T10:00:00.000Z"
        }
      });
      await sql`update agent_runs set status = 'waiting_for_decision' where id = ${newest}`;
      expect(
        await stores.scheduledStarts.hasOpenRun({ clientInstanceId, scheduledStartId: start.id })
      ).toBe("waiting_for_decision");
      const leadingColumns = await sql<
        { attname: string }[]
      >`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0] where i.indrelid = 'scheduled_start_runs'::regclass and i.indpred is null`;
      expect(leadingColumns.map((row) => row.attname)).toEqual(
        expect.arrayContaining(["scheduled_start_id", "agent_run_id", "conversation_id"])
      );
    } finally {
      await sql.end();
    }
  });

  it("prunes only expired runless history of the requested start", async () => {
    const { stores, start, clientInstanceId, owner } = await fixture();
    const conversation = await stores.createConversationForTesting({
      clientInstanceId,
      createdByUserId: owner.id,
      createdByExternalUserId: "owner",
      title: "Kept result",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const agentRun = await stores.createAgentRunForTesting(conversation);
    const old: ScheduledStartRun = {
      id: crypto.randomUUID(),
      scheduledStartId: start.id,
      scheduledFor: "2025-01-01T00:00:00.000Z",
      conversationId: null,
      agentRunId: null,
      status: "failed",
      reason: "owner_unavailable",
      personalConnectionsAllowed: false,
      createdAt: "2025-01-01T00:00:00.000Z"
    };
    const started = {
      ...old,
      id: crypto.randomUUID(),
      scheduledFor: "2025-01-02T00:00:00.000Z",
      conversationId: conversation.id,
      agentRunId: agentRun.id
    };
    const recent = {
      ...old,
      id: crypto.randomUUID(),
      scheduledFor: start.createdAt,
      createdAt: start.createdAt
    };
    const other = { ...start, id: crypto.randomUUID() };
    await stores.scheduledStarts.create({ start: other });
    const unrelated = { ...old, id: crypto.randomUUID(), scheduledStartId: other.id };
    for (const run of [old, started, recent, unrelated])
      await stores.scheduledStarts.addRun({ clientInstanceId, run });
    await stores.scheduledStarts.pruneRunless({
      clientInstanceId,
      scheduledStartId: start.id,
      keepAfter: "2026-01-01T00:00:00.000Z"
    });
    expect(
      (
        await stores.scheduledStarts.listRuns({
          clientInstanceId,
          scheduledStartId: start.id,
          page: { limit: 10 }
        })
      )
        .map((row) => row.id)
        .sort()
    ).toEqual([started.id, recent.id].sort());
    expect(
      (
        await stores.scheduledStarts.listRuns({
          clientInstanceId,
          scheduledStartId: other.id,
          page: { limit: 10 }
        })
      ).map((row) => row.id)
    ).toEqual([unrelated.id]);
  });

  it("rolls back a start update with the transaction that owns its enqueue", async () => {
    const { stores, start, clientInstanceId, owner } = await fixture();
    await expect(
      stores.transaction(async (tx) => {
        await tx.scheduledStarts.get({ clientInstanceId, id: start.id, forUpdate: true });
        await tx.scheduledStarts.update({
          clientInstanceId,
          id: start.id,
          ownerUserId: owner.id,
          patch: { state: "paused" },
          now: start.updatedAt
        });
        throw new Error("enqueue failed");
      })
    ).rejects.toThrow("enqueue failed");
    expect((await stores.scheduledStarts.get({ clientInstanceId, id: start.id }))?.state).toBe(
      "active"
    );
  });

  it("removes skipped history when its workspace is deleted", async () => {
    const { stores, start, clientInstanceId, owner } = await fixture();
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      creatorUserId: owner.id,
      kind: "shared",
      name: "Scheduled team"
    });
    const workspaceStart = {
      ...start,
      id: crypto.randomUUID(),
      collaborationWorkspaceId: workspace.id
    };
    await stores.scheduledStarts.create({ start: workspaceStart });
    const run: ScheduledStartRun = {
      id: crypto.randomUUID(),
      scheduledStartId: workspaceStart.id,
      scheduledFor: start.nextRunAt ?? start.createdAt,
      conversationId: null,
      agentRunId: null,
      status: "skipped",
      reason: "waiting_for_decision",
      personalConnectionsAllowed: false,
      createdAt: start.createdAt
    };
    await stores.scheduledStarts.addRun({ clientInstanceId, run });
    await stores.workspaces.deleteWorkspace({
      clientInstanceId,
      collaborationWorkspaceId: workspace.id
    });
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      const rows = await sql`select id from scheduled_start_runs where id = ${run.id}`;
      expect(rows).toHaveLength(0);
    } finally {
      await sql.end();
    }
    expect(await stores.scheduledStarts.get({ clientInstanceId, id: start.id })).toEqual(start);
  });

  it("removes owned starts and runless history with the Personal Workspace and account", async () => {
    const { stores, start, clientInstanceId, owner, other } = await fixture();
    const workspace = await stores.workspaces.createWorkspace({
      clientInstanceId,
      creatorUserId: other.id,
      kind: "shared",
      name: "Remaining team"
    });
    const sharedStart = {
      ...start,
      id: crypto.randomUUID(),
      collaborationWorkspaceId: workspace.id
    };
    await stores.scheduledStarts.create({ start: sharedStart });
    const runIds: string[] = [];
    for (const saved of [start, sharedStart]) {
      const id = crypto.randomUUID();
      runIds.push(id);
      await stores.scheduledStarts.addRun({
        clientInstanceId,
        run: {
          id,
          scheduledStartId: saved.id,
          scheduledFor: start.createdAt,
          conversationId: null,
          agentRunId: null,
          status: "skipped",
          reason: "waiting_for_decision",
          personalConnectionsAllowed: false,
          createdAt: start.createdAt
        }
      });
    }
    await stores.workspaces.deletePersonalWorkspaceForUser({ clientInstanceId, userId: owner.id });
    await stores.users.deleteUser({ clientInstanceId, userId: owner.id });
    const sql = postgres(databaseUrl, { max: 1 });
    try {
      expect(
        await sql`select id from scheduled_start_runs where id in ${sql(runIds)}`
      ).toHaveLength(0);
    } finally {
      await sql.end();
    }
    expect(
      await stores.scheduledStarts.get({ clientInstanceId, id: sharedStart.id })
    ).toBeUndefined();
  });
});
