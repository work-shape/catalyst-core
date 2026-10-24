import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { asUserId } from "@work-shape/catalyst-core";
import {
  SCOPES_HEADER,
  SERVICE_HEADER,
  agent,
  clientInstanceId,
  errorSchema,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { guardedEvents, judge } from "./support/guardrails";
import { getTestJobs } from "./support/test-instance";

// `agents.give_tools` (ruling of 2026-10-24): a person who may change and publish an instance's
// own agent gives it tools as one new live revision of what is live plus the tools. A pending
// draft, also one a release push wrote, keeps its content and its author, gains the same tools
// and moves onto the new live revision, so it can still be published. A live change since the
// caller read refuses the give. Both rights are decided, each with its own deny; a service
// principal gives nothing, and a workspace's agent is not addressed.

const AGENT = "helper";
const givenSchema = z.object({
  publishedRevision: z.number(),
  replacedRevision: z.number(),
  givenTools: z.array(z.string())
});

const instances: AccessInstance[] = [];
afterEach(async () => {
  await Promise.all(instances.splice(0).map((t) => t.instance.close()));
});

async function setup(
  guardrails: Record<string, unknown> = {},
  /** What a judge answers, call after call: whether the content breaks its rule. */
  verdicts: boolean[] = []
) {
  const t = await setupAccessInstance({
    furtherToolNames: ["read_skill"],
    ...(Object.keys(guardrails).length > 0
      ? {
          server: (stores) => {
            const guarded = guardedEvents(stores, guardrails);
            let asked = 0;
            guarded.complete.mockImplementation(async () => ({
              text: JSON.stringify({ violates: verdicts[asked++] ?? false, reason: "Look." }),
              toolCalls: [],
              usage: {
                inputTokens: 1,
                outputTokens: 1,
                totalTokens: 2,
                source: "provider_reported",
                webSearchCallCount: 0
              }
            }));
            return { operations: { events: guarded.events } };
          }
        }
      : {})
  });
  instances.push(t);
  await t.expectOk(t.admin.id, "assets.put", {
    params: { kind: "agent", name: AGENT },
    payload: { config: agent(AGENT, { toolNames: ["known.tool"] }), expectedRevision: null }
  });
  const live = async () => {
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name: AGENT
    });
    if (!asset?.config) throw new Error(`No agent '${AGENT}'`);
    return { ...asset, config: asset.config };
  };
  const draft = async () =>
    t.stores.agentProposals.get({ clientInstanceId, agentId: (await live()).id });
  /** A draft as a release push writes it: its author is the release, not a person. */
  const releaseDraft = async (instructions: string) => {
    const now = await live();
    return t.stores.agentProposals.save({
      clientInstanceId,
      agentId: now.id,
      baseRevision: now.revision,
      expectedDraftRevision: null,
      config: { ...now.config, instructions },
      author: { release: true },
      savedAt: new Date().toISOString()
    });
  };
  const give = async (
    userId: string,
    toolNames: string[],
    fence: { agentId?: string; expectedLiveRevision?: number } = {},
    headers: Record<string, string> = {}
  ) => {
    const now = await live();
    return t.call(userId, "agents.give_tools", {
      params: { name: AGENT },
      payload: {
        agentId: fence.agentId ?? now.id,
        toolNames,
        expectedLiveRevision: fence.expectedLiveRevision ?? now.revision
      },
      headers
    });
  };
  return { t, live, draft, releaseDraft, give };
}

describe("giving tools to an agent", () => {
  it("makes live plus the tools one revision; a release draft keeps its content and author and gains them", async () => {
    const { t, live, draft, releaseDraft, give } = await setup();
    const saved = await releaseDraft("Released instructions.");
    const before = await live();

    const response = await give(t.admin.id, ["second.tool", "known.tool"]);
    expect(response.statusCode, response.body).toBe(200);
    expect(givenSchema.parse(response.json())).toEqual({
      publishedRevision: before.revision + 1,
      replacedRevision: before.revision,
      givenTools: ["second.tool"]
    });

    // Live: what was live plus the tool, nothing of the draft.
    expect(await live()).toMatchObject({
      revision: before.revision + 1,
      config: { instructions: "Help.", toolNames: ["known.tool", "second.tool"] }
    });
    // The draft: its content and its author, the tool too, on the new live revision.
    expect(await draft()).toMatchObject({
      revision: (saved?.revision ?? 0) + 1,
      baseRevision: before.revision + 1,
      author: { release: true },
      config: {
        instructions: "Released instructions.",
        toolNames: ["known.tool", "second.tool"]
      }
    });

    // The revision is recorded as a person's change with the tools it gave.
    const events = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "config_asset.updated",
      page: { limit: 100 }
    });
    const recorded = events.filter((event) => event.metadata?.name === AGENT);
    expect(
      recorded.find((event) => event.metadata?.revision === before.revision + 1)?.metadata
    ).toEqual(expect.objectContaining({ givenTools: ["second.tool"] }));
    // The names of the tools, and nothing else of them, on the give's event alone.
    expect(recorded.filter((event) => event.metadata?.givenTools !== undefined)).toHaveLength(1);

    // And it is still publishable, as it stands.
    const pending = await draft();
    const published = await t.call(t.admin.id, "assets.publish", {
      params: { kind: "agent", name: AGENT },
      payload: { revision: pending?.revision }
    });
    expect(published.statusCode, published.body).toBe(200);
    expect(await live()).toMatchObject({
      revision: before.revision + 2,
      config: { instructions: "Released instructions.", toolNames: ["known.tool", "second.tool"] }
    });
    expect(await draft()).toBeUndefined();
  });

  it("keeps a person's draft theirs, and a draft behind the live agent behind", async () => {
    const { t, live, draft, give } = await setup();
    const first = await live();
    const saved = await t.stores.agentProposals.save({
      clientInstanceId,
      agentId: first.id,
      baseRevision: first.revision,
      expectedDraftRevision: null,
      config: { ...first.config, instructions: "Lena's draft." },
      author: { userId: asUserId(t.lena.id), release: false },
      savedAt: new Date().toISOString()
    });
    expect((await give(t.admin.id, ["second.tool"])).statusCode).toBe(200);
    expect(await draft()).toMatchObject({
      author: { userId: t.lena.id, release: false },
      baseRevision: first.revision + 1,
      config: { instructions: "Lena's draft.", toolNames: ["known.tool", "second.tool"] }
    });

    // A draft based on an older live revision stays based on it, with the tools too: the give
    // does not hide from its publish what went live past it.
    await t.stores.agentProposals.remove({ clientInstanceId, agentId: first.id });
    await t.stores.agentProposals.save({
      clientInstanceId,
      agentId: first.id,
      baseRevision: first.revision,
      expectedDraftRevision: null,
      config: { ...first.config, instructions: "Old base." },
      author: { userId: asUserId(t.lena.id), release: false },
      savedAt: new Date().toISOString()
    });
    expect((await give(t.admin.id, ["read_skill"])).statusCode).toBe(200);
    expect(await live()).toMatchObject({ revision: first.revision + 2 });
    expect(await draft()).toMatchObject({
      baseRevision: first.revision,
      config: { instructions: "Old base.", toolNames: ["known.tool", "read_skill"] }
    });
    expect(saved).toBeDefined();
  });

  it("refuses a give over a live agent that changed since it was read, and changes nothing", async () => {
    const { t, live, draft, releaseDraft, give } = await setup();
    await releaseDraft("Released.");
    const before = await live();
    const pending = await draft();

    const stale = await give(t.admin.id, ["second.tool"], {
      expectedLiveRevision: before.revision + 1
    });
    expect(stale.statusCode, stale.body).toBe(412);
    expect(errorSchema.parse(stale.json()).error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: { reason: "live_changed", currentRevision: before.revision }
    });

    const replaced = await give(t.admin.id, ["second.tool"], { agentId: "cfga_another" });
    expect(replaced.statusCode, replaced.body).toBe(409);
    expect(errorSchema.parse(replaced.json()).error.code).toBe("CONFLICT");

    expect(await live()).toEqual(before);
    expect(await draft()).toEqual(pending);
  });

  it("writes nothing where the agent holds every tool already", async () => {
    const { t, live, give } = await setup();
    const before = await live();
    const response = await give(t.admin.id, ["known.tool"]);
    expect(response.statusCode, response.body).toBe(200);
    expect(givenSchema.parse(response.json())).toEqual({
      publishedRevision: before.revision,
      replacedRevision: before.revision,
      givenTools: []
    });
    expect(await live()).toEqual(before);
  });

  it("needs both the write and the publish right, and a deny of either wins", async () => {
    const { t, live, give } = await setup();
    const before = await live();
    const onAgent = { assetId: before.id };

    await t.expectRefused(
      t.kai.id,
      "agents.give_tools",
      {
        params: { name: AGENT },
        payload: {
          agentId: before.id,
          toolNames: ["second.tool"],
          expectedLiveRevision: before.revision
        }
      },
      { status: 403, code: "FORBIDDEN" }
    );
    await t.grant(t.kai.id, "agent.write", onAgent);
    const writeOnly = await give(t.kai.id, ["second.tool"]);
    expect(writeOnly.statusCode, writeOnly.body).toBe(403);
    expect(errorSchema.parse(writeOnly.json()).error.details).toMatchObject({
      action: "agent.publish"
    });

    await t.grant(t.lena.id, "agent.publish", onAgent);
    const publishOnly = await give(t.lena.id, ["second.tool"]);
    expect(publishOnly.statusCode, publishOnly.body).toBe(403);
    expect(errorSchema.parse(publishOnly.json()).error.details).toMatchObject({
      action: "agent.write"
    });

    // An administrator holds both on the whole instance; a deny of either on this agent wins.
    for (const denied of ["agent.write", "agent.publish"]) {
      const administrator = await t.instance.stores.users.createUser({
        clientInstanceId,
        displayLabel: `Administrator without ${denied}`,
        roles: ["user", "admin"],
        permissions: []
      });
      await t.grant(administrator.id, denied, onAgent, "deny");
      const refused = await give(administrator.id, ["second.tool"]);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(errorSchema.parse(refused.json()).error.details).toMatchObject({ action: denied });
    }
    expect(await live()).toEqual(before);

    // Both rights and no deny: the give goes live.
    const holder = await t.instance.stores.users.createUser({
      clientInstanceId,
      displayLabel: "Holder",
      roles: ["user"],
      permissions: []
    });
    await t.grant(holder.id, "agent.write", onAgent);
    await t.grant(holder.id, "agent.publish", onAgent);
    const given = await give(holder.id, ["second.tool"]);
    expect(given.statusCode, given.body).toBe(200);
    expect((await live()).config.toolNames).toEqual(["known.tool", "second.tool"]);
  });

  it("gives nothing with a service principal's key, nor to a workspace's agent", async () => {
    const { t, live, give } = await setup();
    const before = await live();
    const service = await give(
      t.admin.id,
      ["second.tool"],
      {},
      {
        [SERVICE_HEADER]: "sp_release",
        [SCOPES_HEADER]: "config_assets:read config_assets:release config_assets:publish"
      }
    );
    expect(service.statusCode, service.body).toBeGreaterThanOrEqual(400);
    expect(await live()).toEqual(before);

    const team = await t.sharedWorkspace("Team");
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "team-helper" },
      payload: { config: agent("team-helper"), expectedRevision: null, workspaceId: team }
    });
    const teamAgent = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "agent",
      name: "team-helper"
    });
    if (!teamAgent) throw new Error("No workspace agent");
    const refused = await t.call(t.admin.id, "agents.give_tools", {
      params: { name: "team-helper" },
      payload: {
        agentId: teamAgent.id,
        toolNames: ["second.tool"],
        expectedLiveRevision: teamAgent.revision
      }
    });
    expect(refused.statusCode, refused.body).toBe(404);
    expect(
      await t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "agent",
        name: "team-helper"
      })
    ).toEqual(teamAgent);
  });

  it("is checked by the guardrails of a write and of a publish, on what goes live", async () => {
    const { t, live, draft, releaseDraft, give } = await setup({
      "no-second-tool": {
        displayName: "No second tool",
        on: "agent.before_publish",
        check: { kind: "pattern", pattern: "second\\.tool", reason: "Not this tool." },
        outcome: "block"
      }
    });
    await releaseDraft("Released.");
    const before = await live();
    const pending = await draft();
    const blocked = await give(t.admin.id, ["second.tool"]);
    expect(blocked.statusCode, blocked.body).toBe(403);
    expect(await live()).toEqual(before);
    expect(await draft()).toEqual(pending);
  });

  it("waits for an approval as a publish does, and gives what was approved over the agent it was asked about", async () => {
    const { t, live, draft, releaseDraft, give } = await setup(
      { held: judge("agent.before_publish", "require_approval") },
      [true, false, true]
    );
    await releaseDraft("Released.");
    const before = await live();
    const pending = await draft();
    const held = await give(t.admin.id, ["second.tool"]);
    expect(held.statusCode, held.body).toBe(202);
    // Nothing is changed while it waits: neither the live agent nor the draft.
    expect(await live()).toEqual(before);
    expect(await draft()).toEqual(pending);
    const { approvalRequestId } = z.object({ approvalRequestId: z.string() }).parse(held.json());
    await t.expectOk(t.root.id, "approval_requests.decide", {
      params: { requestId: approvalRequestId },
      payload: { decision: "approve" }
    });
    await getTestJobs(t.instance).runDue();
    expect(await live()).toMatchObject({
      revision: before.revision + 1,
      config: { instructions: "Help.", toolNames: ["known.tool", "second.tool"] }
    });
    expect(await draft()).toMatchObject({
      baseRevision: before.revision + 1,
      author: { release: true },
      config: { instructions: "Released.", toolNames: ["known.tool", "second.tool"] }
    });

    // A live change while a give waits: the approved give changes nothing.
    const waiting = await give(t.admin.id, ["read_skill"]);
    expect(waiting.statusCode, waiting.body).toBe(202);
    const request = z.object({ approvalRequestId: z.string() }).parse(waiting.json());
    const now = await live();
    await t.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`agent:${AGENT}`]: now.revision },
      mutations: [
        {
          type: "upsert",
          kind: "agent",
          name: AGENT,
          config: { ...now.config, instructions: "Changed meanwhile." }
        }
      ]
    });
    const changed = await live();
    await t.expectOk(t.root.id, "approval_requests.decide", {
      params: { requestId: request.approvalRequestId },
      payload: { decision: "approve" }
    });
    await getTestJobs(t.instance).runDue();
    expect(await live()).toEqual(changed);
  });
});
