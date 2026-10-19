import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiUserSchema, scheduledStartSchema } from "@work-shape/catalyst-api-contract";
import { asAgentRunId, asUserId, isAuthenticatedServicePrincipal } from "@work-shape/catalyst-core";
import {
  clientInstanceId,
  SCOPES_HEADER,
  recordAuthAdapter,
  setupAccessInstance
} from "./support/access-instance";
import { createTestInstance, getTestJobs } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";
import { createTestConfig } from "./support/fixtures";
import { required, waitUntil } from "./support/assertions";

const fields = {
  agentName: "scheduled-helper",
  prompt: "Prepare my daily summary",
  cron: "0 9 * * 1-5",
  timeZone: "Europe/Berlin"
};

async function fixture(cookieIdentity = false) {
  const t = await setupAccessInstance({
    storedAssetSource: true,
    ...(cookieIdentity
      ? {
          server: () => {
            const auth = recordAuthAdapter();
            return {
              authAdapter: {
                ...auth,
                async authenticate(request) {
                  const actor = await auth.authenticate(request);
                  return isAuthenticatedServicePrincipal(actor) ||
                    request.headers["x-session-cookie"] !== "yes"
                    ? actor
                    : {
                        ...actor,
                        authenticationMethod: "session-cookie" as const,
                        sessionId: "signed-session"
                      };
                }
              }
            };
          }
        }
      : {})
  });
  await t.putAgent(t.admin.id, fields.agentName, {}, "all");
  const workspace = await t.stores.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: t.kai.id
  });
  return {
    t,
    workspace,
    headers: cookieIdentity ? { origin: "http://localhost", "x-session-cookie": "yes" } : {}
  };
}

const listed = (response: { json(): unknown }) =>
  z
    .object({ items: z.array(scheduledStartSchema) })
    .parse(response.json())
    .items.map((row) => row.id);

/** Only this start's queued tick is moved to the database's present. No wall-clock sleep. */
async function fireDue(t: { instance: Parameters<typeof getTestJobs>[0] }, id: string) {
  await withTestSql(async (sql) => {
    await sql`update platform_jobs set run_after = now() where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${id} and status = 'queued'`;
  });
  await getTestJobs(t.instance).runDue();
}

describe("scheduled prompts API", () => {
  it("lets only the owner read and manage a saved start, including another instance admin", async () => {
    const { t, workspace } = await fixture();
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: workspace.id }
        })
      ).json()
    );
    expect(
      (await t.stores.scheduledStarts.get({ clientInstanceId, id: start.id }))
        ?.personalConnectionsAllowed
    ).toBe(false);
    const list = await t.expectOk(t.kai.id, "scheduled_starts.list");
    expect(
      z
        .object({ items: z.array(scheduledStartSchema) })
        .parse(list.json())
        .items.map((row) => row.id)
    ).toEqual([start.id]);
    for (const userId of [t.lena.id, t.admin.id]) {
      expect(
        z
          .object({ items: z.array(scheduledStartSchema) })
          .parse((await t.expectOk(userId, "scheduled_starts.list")).json()).items
      ).toEqual([]);
      for (const operation of [
        "scheduled_starts.runs",
        "scheduled_starts.run_now",
        "scheduled_starts.delete"
      ] as const) {
        expect(
          (await t.call(userId, operation, { params: { scheduledStartId: start.id } })).statusCode
        ).toBe(operation === "scheduled_starts.delete" && userId === t.admin.id ? 403 : 404);
      }
      expect(
        (
          await t.call(userId, "scheduled_starts.update", {
            params: { scheduledStartId: start.id },
            payload: fields
          })
        ).statusCode
      ).toBe(404);
      expect(
        (
          await t.call(userId, "scheduled_starts.set_state", {
            params: { scheduledStartId: start.id },
            payload: { state: "paused" }
          })
        ).statusCode
      ).toBe(404);
    }
    expect(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.set_state", {
          params: { scheduledStartId: start.id },
          payload: { state: "paused" }
        })
      ).json()
    ).toMatchObject({ state: "paused", nextRunAt: null });
    expect(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.run_now", {
          params: { scheduledStartId: start.id }
        })
      ).json()
    ).toEqual({ queued: true });
  });

  it("refuses an unavailable agent and a workspace the owner cannot enter", async () => {
    const { t, workspace } = await fixture();
    await t.putAgent(t.admin.id, "hidden-helper");
    const team = await t.sharedWorkspace("Admin team");
    for (const payload of [
      { ...fields, agentName: "hidden-helper", collaborationWorkspaceId: workspace.id },
      { ...fields, agentName: "does-not-exist", collaborationWorkspaceId: workspace.id },
      { ...fields, collaborationWorkspaceId: team }
    ])
      expect((await t.call(t.kai.id, "scheduled_starts.create", { payload })).statusCode).toBe(404);
    expect(
      (
        await t.call(t.root.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: team }
        })
      ).statusCode
    ).toBe(404);
    expect(
      z
        .object({ items: z.array(scheduledStartSchema) })
        .parse((await t.expectOk(t.kai.id, "scheduled_starts.list")).json()).items
    ).toEqual([]);
  });

  it.each(["workspace"] as const)(
    "pauses a queued tick when its %s becomes unavailable without repeating failures",
    async (unavailable) => {
      const { t } = await fixture();
      const team = await t.sharedWorkspace("Revoked team");
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: t.kai.id,
        role: "member"
      });
      const start = scheduledStartSchema.parse(
        (
          await t.expectOk(t.kai.id, "scheduled_starts.create", {
            payload: { ...fields, collaborationWorkspaceId: team }
          })
        ).json()
      );
      await t.stores.workspaces.removeMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: t.kai.id
      });
      await withTestSql(async (sql) => {
        await sql`update platform_jobs set run_after = now() where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${start.id} and status = 'queued'`;
      });
      await getTestJobs(t.instance).runDue();
      const runs = await t.stores.scheduledStarts.listRuns({
        clientInstanceId,
        scheduledStartId: start.id,
        page: { limit: 10 }
      });
      expect(runs).toHaveLength(1);
      expect(runs[0]).toMatchObject({
        status: "failed",
        reason: `${unavailable}_unavailable`,
        conversationId: null,
        agentRunId: null
      });
      expect(await t.stores.scheduledStarts.get({ clientInstanceId, id: start.id })).toMatchObject({
        state: "paused",
        nextRunAt: null
      });
      for (let tick = 0; tick < 2; tick++) {
        await withTestSql(async (sql) => {
          await sql`update platform_jobs set run_after = now() where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${start.id} and status = 'queued'`;
        });
        await getTestJobs(t.instance).runDue();
      }
      expect(
        await t.stores.scheduledStarts.listRuns({
          clientInstanceId,
          scheduledStartId: start.id,
          page: { limit: 10 }
        })
      ).toHaveLength(1);
    }
  );

  it("pauses a deactivated person's starts at once, before their next tick (access check 25)", async () => {
    const { t, workspace } = await fixture();
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: workspace.id }
        })
      ).json()
    );
    expect(start).toMatchObject({ state: "active" });
    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    expect(await t.stores.scheduledStarts.get({ clientInstanceId, id: start.id })).toMatchObject({
      state: "paused",
      nextRunAt: null
    });
    await fireDue(t, start.id);
    expect(
      await t.stores.scheduledStarts.listRuns({
        clientInstanceId,
        scheduledStartId: start.id,
        page: { limit: 10 }
      })
    ).toEqual([]);
  });

  it("records failed / agent_unavailable when the agent is withdrawn before its tick", async () => {
    const { t, workspace } = await fixture();
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: workspace.id }
        })
      ).json()
    );
    await t.stores.configAssets.setAgentAvailability({
      clientInstanceId,
      agentName: fields.agentName,
      availability: { mode: "selected", personalWorkspaces: false, collaborationWorkspaceIds: [] }
    });
    await fireDue(t, start.id);
    const runs = await t.stores.scheduledStarts.listRuns({
      clientInstanceId,
      scheduledStartId: start.id,
      page: { limit: 10 }
    });
    expect(runs).toEqual([
      expect.objectContaining({
        status: "failed",
        reason: "agent_unavailable",
        agentRunId: null,
        conversationId: null
      })
    ]);
  });

  it("refuses a schedule due more often than every 15 minutes, on create and on edit", async () => {
    const { t, workspace } = await fixture();
    for (const cron of ["*/10 * * * *", "0,5 9 * * *", "0,59 0,23 * * *", "* 8 * * 1"]) {
      const refused = await t.call(t.kai.id, "scheduled_starts.create", {
        payload: { ...fields, cron, collaborationWorkspaceId: workspace.id }
      });
      expect(refused.statusCode, cron).toBe(422);
      expect(refused.body).toContain("at most every 15 minutes");
    }
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, cron: "*/15 * * * *", collaborationWorkspaceId: workspace.id }
        })
      ).json()
    );
    const edited = await t.call(t.kai.id, "scheduled_starts.update", {
      params: { scheduledStartId: start.id },
      payload: { ...fields, cron: "*/5 * * * *" }
    });
    expect(edited.statusCode).toBe(422);
  });

  it("records a late tick once, for the latest due time it missed", async () => {
    const { t, workspace } = await fixture();
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, cron: "0 * * * *", collaborationWorkspaceId: workspace.id }
        })
      ).json()
    );
    // The worker was away for five hours: the queued tick is for a due time five hours ago.
    const hour = 3_600_000;
    const missed = new Date(Math.floor(Date.now() / hour) * hour - 5 * hour).toISOString();
    await withTestSql(async (sql) => {
      await sql`update scheduled_starts set next_run_at = ${missed} where id = ${start.id}`;
      await sql`update platform_jobs set payload = jsonb_set(payload, '{dueAt}', to_jsonb(${missed}::text)), run_after = now() where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${start.id} and status = 'queued'`;
    });
    const hourBefore = Math.floor(Date.now() / hour) * hour;
    await getTestJobs(t.instance).runDue();
    const hourAfter = Math.floor(Date.now() / hour) * hour;
    const runs = await t.stores.scheduledStarts.listRuns({
      clientInstanceId,
      scheduledStartId: start.id,
      page: { limit: 10 }
    });
    expect(runs).toHaveLength(1);
    const recorded = Date.parse(required(runs[0]).scheduledFor);
    expect(recorded).toBeGreaterThanOrEqual(hourBefore);
    expect(recorded).toBeLessThanOrEqual(hourAfter);
  });

  it("keeps the next tick when an edit races a tick that already advanced the start", async () => {
    const { t, workspace } = await fixture();
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: workspace.id }
        })
      ).json()
    );
    // The tick for the first due time runs while the edit still reads a clock before it: here
    // the tick is moved forward instead of the edit's clock back.
    await fireDue(t, start.id);
    const advanced = required(
      await t.stores.scheduledStarts.get({ clientInstanceId, id: start.id })
    );
    expect(Date.parse(required(advanced.nextRunAt))).toBeGreaterThan(
      Date.parse(required(start.nextRunAt))
    );
    const edited = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.update", {
          params: { scheduledStartId: start.id },
          payload: { ...fields, prompt: "Prepare my daily summary, briefly" }
        })
      ).json()
    );
    expect(edited.nextRunAt).toBe(advanced.nextRunAt);
    await withTestSql(async (sql) => {
      expect(
        await sql`select payload->>'dueAt' as "dueAt" from platform_jobs where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${start.id} and status = 'queued'`
      ).toEqual([{ dueAt: advanced.nextRunAt }]);
    });
  });

  it("does not run an old owner's queued Run now after handover", async () => {
    const { t } = await fixture();
    const team = await t.sharedWorkspace("Manual handover team");
    for (const user of [t.kai, t.lena])
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: user.id,
        role: "member"
      });
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: team }
        })
      ).json()
    );
    await t.expectOk(t.kai.id, "scheduled_starts.run_now", {
      params: { scheduledStartId: start.id }
    });
    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    await t.expectOk(t.admin.id, "scheduled_starts.handover", {
      params: { scheduledStartId: start.id },
      payload: { ownerUserId: t.lena.id }
    });
    await getTestJobs(t.instance).runDue();
    expect(
      (
        await t.expectOk(t.lena.id, "scheduled_starts.runs", {
          params: { scheduledStartId: start.id }
        })
      ).json()
    ).toMatchObject({ items: [] });
    await withTestSql(async (sql) => {
      expect(
        await sql`select id from agent_runs where client_instance_id = ${clientInstanceId} and owner_user_id = ${t.lena.id}`
      ).toHaveLength(0);
    });
  });

  it("keeps one future tick for the new owner when a handed-over start resumes before its due time", async () => {
    const { t } = await fixture();
    const team = await t.sharedWorkspace("Resume handover team");
    for (const user of [t.kai, t.lena])
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: user.id,
        role: "member"
      });
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: team }
        })
      ).json()
    );
    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    await t.expectOk(t.admin.id, "scheduled_starts.handover", {
      params: { scheduledStartId: start.id },
      payload: { ownerUserId: t.lena.id }
    });
    const resumed = scheduledStartSchema.parse(
      (
        await t.expectOk(t.lena.id, "scheduled_starts.set_state", {
          params: { scheduledStartId: start.id },
          payload: { state: "active" }
        })
      ).json()
    );
    // Resumed before the original due time, so the new tick has the old tick's due time.
    expect(resumed).toMatchObject({ state: "active", nextRunAt: start.nextRunAt });
    await withTestSql(async (sql) => {
      expect(
        await sql`select payload->>'ownerUserId' as "ownerUserId", payload->>'dueAt' as "dueAt" from platform_jobs where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${start.id} and status = 'queued'`
      ).toEqual([{ ownerUserId: t.lena.id, dueAt: resumed.nextRunAt }]);
    });
    await fireDue(t, start.id);
    const runs = await t.stores.scheduledStarts.listRuns({
      clientInstanceId,
      scheduledStartId: start.id,
      page: { limit: 10 }
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ scheduledFor: resumed.nextRunAt, status: "queued" });
  });

  it("records a terminal dispatcher failure in history and advances the schedule", async () => {
    const { t, workspace } = await fixture();
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: workspace.id }
        })
      ).json()
    );
    await withTestSql(async (sql) => {
      await sql`update platform_jobs set run_after = now(), attempts = max_attempts - 1 where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${start.id} and status = 'queued'`;
    });
    const failure = vi
      .spyOn(t.stores.configAssets, "listAgentAvailability")
      .mockRejectedValue(new Error("Synthetic dispatcher failure"));
    try {
      await getTestJobs(t.instance).runDue();
    } finally {
      failure.mockRestore();
    }
    const runs = await t.stores.scheduledStarts.listRuns({
      clientInstanceId,
      scheduledStartId: start.id,
      page: { limit: 10 }
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "failed",
      reason: "dispatch_failed",
      agentRunId: null,
      conversationId: null
    });
    const updated = required(
      await t.stores.scheduledStarts.get({ clientInstanceId, id: start.id })
    );
    expect(updated.state).toBe("active");
    expect(Date.parse(required(updated.nextRunAt))).toBeGreaterThan(
      Date.parse(required(start.nextRunAt))
    );
  });

  it.each(["membership", "agent"] as const)(
    "rechecks the owner's %s between the due tick and Agent Run execution",
    async (revoked) => {
      const config = createTestConfig({
        developmentAuth: {
          enabled: true,
          user: {
            id: "owner",
            externalUserId: "owner",
            displayLabel: "Owner",
            roles: ["user"],
            permissionRefs: []
          }
        }
      });
      const app = await createTestInstance({
        config,
        env: {},
        tools: [],
        startAgentRunJobs: false
      });
      const me = apiUserSchema.parse((await app.call("me.get")).json());
      const ownerId = asUserId(me.subjectUserId ?? me.id);
      const other = await app.stores.users.createUser({
        clientInstanceId,
        displayLabel: "Other workspace owner"
      });
      const team = await app.stores.workspaces.createWorkspace({
        clientInstanceId,
        creatorUserId: other.id,
        kind: "shared",
        name: "Queued run team"
      });
      await app.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team.id,
        userId: ownerId,
        role: "member"
      });
      await app.stores.configAssets.setAgentAvailability({
        clientInstanceId,
        agentName: "test_agent",
        availability: { mode: "all", personalWorkspaces: true, collaborationWorkspaceIds: [] }
      });
      const created = await app.call("scheduled_starts.create", {
        payload: { ...fields, agentName: "test_agent", collaborationWorkspaceId: team.id }
      });
      expect(created.statusCode, created.body).toBe(200);
      const start = scheduledStartSchema.parse(created.json());
      await withTestSql(async (sql) => {
        await sql`update platform_jobs set run_after = now() where client_instance_id = ${clientInstanceId} and kind = 'scheduled_prompt.fire' and subject = ${start.id} and status = 'queued'`;
      });
      await getTestJobs(app).runDue();
      const queued = required(
        (
          await app.stores.scheduledStarts.listRuns({
            clientInstanceId,
            scheduledStartId: start.id,
            page: { limit: 10 }
          })
        )[0]
      );
      expect(queued.status).toBe("queued");
      const runId = asAgentRunId(required(queued.agentRunId));
      if (revoked === "membership")
        await app.stores.workspaces.removeMembership({
          clientInstanceId,
          collaborationWorkspaceId: team.id,
          userId: ownerId
        });
      // The default agent cannot be withdrawn through the store, so the row is changed.
      else
        await withTestSql(async (sql) => {
          await sql`update config_asset_availability set mode = 'selected', personal_workspaces = true where asset_id = (select id from config_assets where client_instance_id = ${clientInstanceId} and kind = 'agent' and name = 'test_agent')`;
        });
      await createTestInstance({ config, env: {}, tools: [], seedAssets: false });
      await waitUntil(async () => {
        const run = await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId });
        return run?.status === "failed" || run?.status === "completed";
      }, "queued scheduled run reaches an outcome");
      expect((await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId }))?.status).toBe(
        "failed"
      );
      expect(
        (await app.stores.agentRuns.getAgentRun({ clientInstanceId, runId }))?.error
      ).toMatchObject({ code: "FORBIDDEN" });
    }
  );

  it("keeps Personal connection consent only from a signed-in person and refuses delegated or narrowed sessions", async () => {
    const { t, workspace, headers } = await fixture(true);
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          headers,
          payload: { ...fields, collaborationWorkspaceId: workspace.id }
        })
      ).json()
    );
    expect(
      (await t.stores.scheduledStarts.get({ clientInstanceId, id: start.id }))
        ?.personalConnectionsAllowed
    ).toBe(true);
    const delegated = await t.call(t.kai.id, "scheduled_starts.create", {
      headers: { ...headers, "x-test-key": "personal" },
      payload: { ...fields, collaborationWorkspaceId: workspace.id }
    });
    expect(delegated.statusCode).toBe(403);
    const narrowed = await t.call(t.kai.id, "scheduled_starts.create", {
      headers: { ...headers, [SCOPES_HEADER]: "conversation:read conversation:write" },
      payload: { ...fields, collaborationWorkspaceId: workspace.id }
    });
    expect(narrowed.statusCode).toBe(403);
  });

  it("allows an admin to hand over only a deactivated owner's start, paused with consent reset", async () => {
    const { t } = await fixture();
    const team = await t.sharedWorkspace("Scheduled team");
    for (const user of [t.kai, t.lena])
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: team,
        userId: user.id,
        role: "member"
      });
    const start = scheduledStartSchema.parse(
      (
        await t.expectOk(t.kai.id, "scheduled_starts.create", {
          payload: { ...fields, collaborationWorkspaceId: team }
        })
      ).json()
    );
    const oldConversation = await t.stores.conversations.createConversation({
      clientInstanceId,
      collaborationWorkspaceId: team,
      visibility: "private",
      createdByUserId: t.kai.id,
      createdByExternalUserId: t.kai.id,
      title: "Previous owner's private result",
      retainedUntil: "2030-01-01T00:00:00.000Z"
    });
    const oldRun = await t.stores.createAgentRunForTesting(oldConversation);
    await t.stores.scheduledStarts.addRun({
      clientInstanceId,
      run: {
        id: crypto.randomUUID(),
        scheduledStartId: start.id,
        scheduledFor: start.createdAt,
        conversationId: oldConversation.id,
        agentRunId: oldRun.id,
        status: "queued",
        reason: null,
        personalConnectionsAllowed: false,
        createdAt: start.createdAt
      }
    });
    const handover = {
      params: { scheduledStartId: start.id },
      payload: { ownerUserId: t.lena.id }
    };
    expect((await t.call(t.admin.id, "scheduled_starts.handover", handover)).statusCode).toBe(403);
    const kaiStarts = { query: { ownerUserId: t.kai.id } };
    expect((await t.call(t.admin.id, "scheduled_starts.list", kaiStarts)).statusCode).toBe(403);
    await t.stores.users.updateUser({ clientInstanceId, userId: t.kai.id, status: "disabled" });
    expect((await t.call(t.lena.id, "scheduled_starts.handover", handover)).statusCode).toBe(403);
    // The admin finds the deactivated person's starts to hand them over; nobody else does.
    expect(listed(await t.expectOk(t.admin.id, "scheduled_starts.list", kaiStarts))).toEqual([
      start.id
    ]);
    expect((await t.call(t.lena.id, "scheduled_starts.list", kaiStarts)).statusCode).toBe(403);
    const moved = scheduledStartSchema.parse(
      (await t.expectOk(t.admin.id, "scheduled_starts.handover", handover)).json()
    );
    expect(moved).toMatchObject({
      ownerUserId: t.lena.id,
      state: "paused",
      nextRunAt: null
    });
    expect(
      (await t.stores.scheduledStarts.get({ clientInstanceId, id: start.id }))
        ?.personalConnectionsAllowed
    ).toBe(false);
    expect(
      z
        .object({ items: z.array(scheduledStartSchema) })
        .parse((await t.expectOk(t.lena.id, "scheduled_starts.list")).json())
        .items.map((row) => row.id)
    ).toEqual([start.id]);
    expect(
      (
        await t.expectOk(t.lena.id, "scheduled_starts.runs", {
          params: { scheduledStartId: start.id }
        })
      ).json()
    ).toMatchObject({ items: [] });
    expect(
      await t.stores.scheduledStarts.isScheduledAgentRun({ clientInstanceId, runId: oldRun.id })
    ).toEqual({ personalConnectionsAllowed: false });
    expect(
      (
        await t.call(t.admin.id, "scheduled_starts.delete", {
          params: { scheduledStartId: start.id }
        })
      ).statusCode
    ).toBe(403);
    await t.stores.users.updateUser({ clientInstanceId, userId: t.lena.id, status: "disabled" });
    expect(
      (
        await t.expectOk(t.admin.id, "scheduled_starts.delete", {
          params: { scheduledStartId: start.id }
        })
      ).json()
    ).toEqual({ deleted: true });
  });
});
