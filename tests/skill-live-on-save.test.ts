import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runCli } from "@work-shape/catalyst-cli";
import {
  asAgentRunId,
  asClientInstanceId,
  asConversationId,
  asUserId,
  asToolCallId,
  type AgentPreview,
  readUserMessageMetadata
} from "@work-shape/catalyst-core";
import { parseClientInstanceConfig } from "@work-shape/catalyst-config-schema";
import { createSkillFolderReader } from "@work-shape/catalyst-server";
import { runSkillMounts } from "@work-shape/catalyst-tool-execution";
import { DeterministicModelProvider } from "@work-shape/catalyst-model-provider";
import { clientInstanceId, skill } from "./support/access-instance";
import { setupWorkspaceHolder } from "./support/asset-operations";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig, createTestUser } from "./support/fixtures";
import { useSkillCliWorlds } from "./support/skill-config-cli";
import { createStoredConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

// SKILL-LIVE-1: a skill goes live on save. A holder of `skill.write` and `skill.publish` writes a
// new live revision through `skill.before_publish`; everyone else who may write it files a
// `skill_change` request, decided by `skill.approve`. A draft from before stays until it is
// published or discarded, and no new one appears.

const SKILL = { kind: "skill", name: "house-rules" };
const draftSchema = z.object({
  draft: z
    .object({
      revision: z.number(),
      baseRevision: z.number(),
      liveRevision: z.number(),
      config: z.object({ content: z.string() }).loose()
    })
    .loose()
    .nullable()
});
const filedSchema = z.object({ revision: z.number(), approvalRequestId: z.string() }).loose();

beforeEach(() => {
  vi.spyOn(DeterministicModelProvider.prototype, "stream").mockImplementation(async function* (
    this: DeterministicModelProvider,
    request
  ) {
    yield { type: "completed", completion: await this.complete(request) };
  });
});
afterEach(() => vi.restoreAllMocks());

async function runFixture(blockPublish = false) {
  const config = createTestConfig({
    toolNames: ["read_skill"],
    tools: [{ name: "read_skill", enabled: true }]
  });
  if (blockPublish)
    config.guardrails = parseClientInstanceConfig({
      ...config,
      guardrails: {
        stop_skill_publish: {
          displayName: "Review skill publishing",
          on: "skill.before_publish",
          outcome: "block",
          check: { kind: "pattern", pattern: ".", reason: "Publish blocked for review." }
        }
      }
    }).guardrails;
  config.modules = { assetManagement: { enabled: true } };
  config.conversationTitles.enabled = false;
  config.administration.agentConfiguration.enabled = true;
  config.administration.agentConfiguration.allowSkillEditing = true;
  config.administration.agentConfiguration.agentSkillChanges = {
    enabled: true,
    allowSkillCreation: true
  };
  const app = await createTestInstance({ config, env: {}, tools: [] });
  const instance = asClientInstanceId(config.clientInstance.id);
  const ok = async (response: ReturnType<typeof app.call>) => {
    const value = await response;
    expect(value.statusCode, value.body).toBe(200);
    return value;
  };
  // The instance's skill, live at its first revision, and the live agent that reads it.
  await ok(
    app.call("assets.put", {
      params: SKILL,
      payload: { config: skill(SKILL.name, "LIVE-RULE"), expectedRevision: null }
    })
  );
  const agent = await app.stores.configAssets.getConfigAsset({
    clientInstanceId: instance,
    kind: "agent",
    name: "test_agent"
  });
  if (!agent) throw new Error("Agent missing");
  await app.stores.configAssets.applyConfigAssetMutations({
    clientInstanceId: instance,
    baseRevisions: { "agent:test_agent": agent.revision },
    mutations: [
      {
        type: "upsert",
        kind: "agent",
        name: "test_agent",
        config: { ...agent.config, toolNames: ["read_skill"], skillNames: [SKILL.name] }
      }
    ]
  });
  const live = () =>
    app.stores.configAssets.getConfigAsset({ clientInstanceId: instance, ...SKILL });
  const save = (content: string, expectedRevision = 1) =>
    app.call("assets.put", {
      params: SKILL,
      payload: { config: skill(SKILL.name, content), expectedRevision }
    });
  /** Takes the right to go live from the fixture's person, who keeps `skill.approve`. */
  const denyPublish = async () => {
    const [user] = await app.stores.users.listUsers({ clientInstanceId: instance });
    const stored = await live();
    if (!user || !stored) throw new Error("Fixture person or skill missing");
    await app.stores.access.createGrant({
      clientInstanceId: instance,
      holderKind: "user",
      holderId: user.id,
      action: "skill.publish",
      effect: "deny",
      scopeKind: "asset",
      scopeId: stored.id,
      grantedBy: asUserId(user.id)
    });
  };
  /** The skill text the agent's `read_skill` answered in one turn of the conversation. */
  const readsSkill = async (conversationId: string) => {
    const started = await injectStartConversationRun(
      app,
      conversationId,
      `/tool read_skill {"name":"${SKILL.name}"}`
    );
    await drainRunEvents(app, conversationId, started.run.id);
    const run = await app.stores.agentRuns.getAgentRun({
      clientInstanceId: instance,
      runId: asAgentRunId(started.run.id)
    });
    expect(run?.status, JSON.stringify(run?.error)).toBe("completed");
    const messages = await app.stores.conversations.listMessages({
      clientInstanceId: instance,
      conversationId: asConversationId(conversationId)
    });
    const text = messages.filter((message) => message.role === "tool").at(-1)?.text ?? "";
    return { text, messages };
  };
  return { app, instance, ok, live, save, denyPublish, readsSkill };
}

describe("a shared skill saved with the right to publish it", () => {
  it("is the live revision at once, for a live agent's run and for Try, with no draft", async () => {
    const t = await runFixture();
    const saved = await t.ok(t.save("SAVED-RULE"));
    expect(saved.json()).toMatchObject({ revision: 2 });
    expect(saved.json()).not.toHaveProperty("draftRevision");
    expect(saved.json()).not.toHaveProperty("approvalRequestId");
    expect(await t.live()).toMatchObject({ revision: 2, config: { content: "SAVED-RULE" } });
    expect(
      draftSchema.parse(
        (await t.ok(t.app.call("skills.draft.get", { params: { name: SKILL.name } }))).json()
      ).draft
    ).toBeNull();

    const conversation = (await t.ok(t.app.call("conversations.create", { payload: {} }))).json<{
      id: string;
    }>();
    expect((await t.readsSkill(conversation.id)).text).toContain("SAVED-RULE");

    const tryId = (
      await t.ok(t.app.call("agents.try.open", { params: { name: "test_agent" } }))
    ).json<{ conversation: { id: string } }>().conversation.id;
    const tried = await t.readsSkill(tryId);
    expect(tried.text).toContain("SAVED-RULE");
    const preview = readUserMessageMetadata(
      tried.messages.findLast((message) => message.role === "user")?.metadata
    )?.preview;
    const mountedText = async (frozen: AgentPreview | undefined) => {
      const mounts = await runSkillMounts(
        {
          assetSource: createStoredConfigAssetSource({
            store: t.app.stores.configAssets,
            clientInstanceId: t.instance
          })
        },
        {
          clientInstanceId: t.instance,
          correlationId: "try-skill-folder",
          user: createTestUser("user-1", t.instance),
          agentPreview: frozen,
          toolRequest: {
            toolName: "workspace.exec",
            toolCallId: asToolCallId("call_mount"),
            agentName: "test_agent",
            agentRunId: asAgentRunId("run_mount"),
            conversationId: asConversationId(tryId),
            input: {}
          }
        }
      );
      const [mount] = mounts;
      if (!mount) throw new Error("Skill mount missing");
      const files = await createSkillFolderReader({
        clientInstanceId: t.instance,
        stores: t.app.stores
      }).read({ clientInstanceId: t.instance, ...mount });
      const manifest = files.find((file) => file.path === "SKILL.md");
      if (!manifest) throw new Error("Skill manifest missing");
      return Buffer.from(manifest.bytes).toString("utf8");
    };
    expect(await mountedText(preview)).toContain("SAVED-RULE");
  });

  it("is refused by the guardrail on the publish, a save and a restore alike", async () => {
    const t = await runFixture(true);
    const refused = await t.save("BLOCKED-RULE");
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ error: { code: "GUARDRAIL_BLOCKED" } });
    expect(refused.body).toContain("Review skill publishing");
    expect(await t.live()).toMatchObject({ revision: 1, config: { content: "LIVE-RULE" } });

    // A revision the guardrail did not see: the restore of revision 1 still answers to it.
    await t.app.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId: t.instance,
      baseRevisions: { "skill:house-rules": 1 },
      mutations: [{ type: "upsert", ...SKILL, config: skill(SKILL.name, "UNSEEN-RULE") }]
    });
    const restore = await t.app.call("assets.revert", {
      params: SKILL,
      payload: { revision: 1, expectedRevision: 2 }
    });
    expect(restore.statusCode).toBe(403);
    expect(restore.json()).toMatchObject({ error: { code: "GUARDRAIL_BLOCKED" } });
    expect(await t.live()).toMatchObject({ revision: 2, config: { content: "UNSEEN-RULE" } });
  });

  it("keeps a personal skill live on save, with no guardrail on the publish to ask", async () => {
    // The administrator's own skill: a person's building rights are not this test's subject.
    const t = await setupWorkspaceHolder();
    const personal = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: asUserId(t.admin.id)
    });
    const address = { kind: "skill", name: "admin-own" };
    const mine = { workspaceId: personal.id };
    await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: skill("admin-own", "First."), expectedRevision: null, ...mine }
    });
    const saved = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: skill("admin-own", "Second."), expectedRevision: 1, ...mine }
    });
    expect(saved.json()).toMatchObject({ revision: 2 });
    expect(await t.stored("skill", "admin-own")).toMatchObject({
      revision: 2,
      config: { content: "Second." }
    });
    const refused = await t.expectRefused(
      t.admin.id,
      "assets.publish",
      { params: address, payload: { revision: 2, ...mine } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({ reason: "no_draft" });
  });
});

describe("a shared skill saved without the right to publish it", () => {
  const address = { kind: "skill", name: "kai-notes" };

  async function holder() {
    const t = await setupWorkspaceHolder();
    const inTeam = { workspaceId: t.kaiTeam };
    await t.put(t.kai.id, "skill", "kai-notes", t.kaiTeam);
    const save = async (content: string, expectedRevision = 1) =>
      filedSchema.parse(
        (
          await t.expectOk(t.kai.id, "assets.put", {
            params: address,
            payload: { config: skill("kai-notes", content), expectedRevision, ...inTeam }
          })
        ).json()
      );
    const decide = (requestId: string) =>
      t.expectOk(t.admin.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });
    return { t, inTeam, save, decide };
  }

  it("files a request that leaves live alone until a holder of skill.approve approves it", async () => {
    const { t, inTeam, save, decide } = await holder();
    await t.grant(t.lena.id, "skill.read", inTeam);

    const filed = await save("Kai's change.");
    expect(filed.revision).toBe(1);
    expect(await t.stored("skill", "kai-notes")).toMatchObject({
      revision: 1,
      config: { content: "Guidance." }
    });
    // A reader, and the one who filed, read the live revision; no draft stands anywhere.
    expect(
      (await t.expectOk(t.lena.id, "assets.get", { params: address, query: inTeam })).json()
    ).toMatchObject({ revision: 1, config: { content: "Guidance." } });
    expect(
      draftSchema.parse(
        (
          await t.expectOk(t.kai.id, "skills.draft.get", {
            params: { name: "kai-notes" },
            query: inTeam
          })
        ).json()
      ).draft
    ).toBeNull();

    // The one who decides reads the file by file comparison.
    const pending = (
      await t.expectOk(t.admin.id, "approval_requests.get", {
        params: { requestId: filed.approvalRequestId }
      })
    ).json<{ kind: string; status: string; preview: unknown }>();
    expect(pending).toMatchObject({ kind: "skill_change", status: "pending" });
    expect(JSON.stringify(pending.preview)).toContain("Kai's change.");
    expect(JSON.stringify(pending.preview)).toContain("Guidance.");

    // Kai cannot decide or go around it.
    await t.expectRefused(
      t.kai.id,
      "assets.publish",
      { params: address, payload: { revision: 1, ...inTeam } },
      t.forbidden("skill.publish", "no_grant")
    );

    const approved = await decide(filed.approvalRequestId);
    expect(approved.json()).toMatchObject({ status: "approved", applyResult: { revision: 2 } });
    expect(await t.stored("skill", "kai-notes")).toMatchObject({
      revision: 2,
      config: { content: "Kai's change." }
    });
  });

  it("answers the same request for the same change, and goes stale when live moved", async () => {
    const { t, inTeam, save } = await holder();
    const first = await save("Kai's change.");
    expect((await save("Kai's change.")).approvalRequestId).toBe(first.approvalRequestId);
    const other = await save("Kai's other change.");
    expect(other.approvalRequestId).not.toBe(first.approvalRequestId);

    await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: skill("kai-notes", "The admin's save."), expectedRevision: 1, ...inTeam }
    });
    const stale = await t.call(t.admin.id, "approval_requests.decide", {
      params: { requestId: first.approvalRequestId },
      payload: { decision: "approve" }
    });
    expect(JSON.stringify(stale.json())).not.toContain('"status":"approved"');
    expect(await t.stored("skill", "kai-notes")).toMatchObject({
      revision: 2,
      config: { content: "The admin's save." }
    });
  });

  it("files nothing for a save that changes nothing", async () => {
    const { t, inTeam } = await holder();
    const saved = await t.expectOk(t.kai.id, "assets.put", {
      params: address,
      payload: { config: skill("kai-notes"), expectedRevision: 1, ...inTeam }
    });
    expect(saved.json()).toMatchObject({ revision: 1 });
    expect(saved.json()).not.toHaveProperty("approvalRequestId");
  });

  it("is answered by the guardrail on the publish when it is approved", async () => {
    const t = await runFixture(true);
    await t.denyPublish();
    const filed = filedSchema.parse((await t.ok(t.save("FILED-RULE"))).json());
    expect(filed.revision).toBe(1);
    const decided = await t.ok(
      t.app.call("approval_requests.decide", {
        params: { requestId: filed.approvalRequestId },
        payload: { decision: "approve" }
      })
    );
    expect(decided.json()).toMatchObject({
      status: "superseded",
      applyResult: { execution: "refused", error: { code: "GUARDRAIL_BLOCKED" } }
    });
    expect(await t.live()).toMatchObject({ revision: 1, config: { content: "LIVE-RULE" } });
  });
});

describe("restoring an earlier revision of a shared skill", () => {
  const address = { kind: "skill", name: "kai-notes" };

  it("goes live at once for a holder of the publish right, and files a request for anyone else", async () => {
    const t = await setupWorkspaceHolder();
    const inTeam = { workspaceId: t.kaiTeam };
    await t.put(t.kai.id, "skill", "kai-notes", t.kaiTeam);
    await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: skill("kai-notes", "Second."), expectedRevision: 1, ...inTeam }
    });

    const restored = await t.expectOk(t.admin.id, "assets.revert", {
      params: address,
      payload: { revision: 1, expectedRevision: 2, ...inTeam }
    });
    expect(restored.json()).toMatchObject({ revision: 3 });
    expect(restored.json()).not.toHaveProperty("approvalRequestId");
    expect(await t.stored("skill", "kai-notes")).toMatchObject({
      revision: 3,
      config: { content: "Guidance." }
    });

    const filed = filedSchema.parse(
      (
        await t.expectOk(t.kai.id, "assets.revert", {
          params: address,
          payload: { revision: 2, expectedRevision: 3, ...inTeam }
        })
      ).json()
    );
    expect(filed.revision).toBe(3);
    expect(await t.stored("skill", "kai-notes")).toMatchObject({ revision: 3 });
    await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId: filed.approvalRequestId },
      payload: { decision: "approve" }
    });
    expect(await t.stored("skill", "kai-notes")).toMatchObject({
      revision: 4,
      config: { content: "Second." }
    });
  });
});

describe("a skill draft from before skills went live on save", () => {
  const address = { kind: "skill", name: "kai-notes" };

  async function withDraft() {
    const t = await setupWorkspaceHolder();
    const inTeam = { workspaceId: t.kaiTeam };
    await t.put(t.kai.id, "skill", "kai-notes", t.kaiTeam);
    const live = await t.stored("skill", "kai-notes");
    if (!live) throw new Error("Skill missing");
    await t.stores.agentProposals.save({
      clientInstanceId,
      agentId: live.id,
      baseRevision: live.revision,
      expectedDraftRevision: null,
      config: skill("kai-notes", "The old draft."),
      author: { userId: asUserId(t.kai.id), release: false },
      savedAt: new Date().toISOString()
    });
    return { t, inTeam };
  }

  it("is read as it was and blocks a write that would strand it", async () => {
    const { t, inTeam } = await withDraft();
    expect(
      draftSchema.parse(
        (
          await t.expectOk(t.kai.id, "skills.draft.get", {
            params: { name: "kai-notes" },
            query: inTeam
          })
        ).json()
      ).draft
    ).toMatchObject({ revision: 1, config: { content: "The old draft." } });
    for (const [userId, operation, payload] of [
      [t.admin.id, "assets.put", { config: skill("kai-notes", "New."), expectedRevision: 1 }],
      [t.kai.id, "assets.put", { config: skill("kai-notes", "New."), expectedRevision: 1 }]
    ] as const) {
      const refused = await t.expectRefused(
        userId,
        operation,
        { params: address, payload: { ...payload, ...inTeam } },
        { status: 409, code: "CONFLICT" }
      );
      expect(refused.details).toMatchObject({ reason: "skill_draft_pending", draftRevision: 1 });
    }
    const synced = await t.call(t.admin.id, "assets.sync", {
      payload: {
        ...inTeam,
        items: [
          { type: "put", kind: "skill", config: skill("kai-notes", "New."), expectedRevision: 1 }
        ]
      }
    });
    expect(synced.statusCode).toBe(409);
    expect(await t.stored("skill", "kai-notes")).toMatchObject({
      revision: 1,
      config: { content: "Guidance." }
    });
  });

  it("can still be published", async () => {
    const { t, inTeam } = await withDraft();
    await t.expectRefused(
      t.kai.id,
      "assets.publish",
      { params: address, payload: { revision: 1, ...inTeam } },
      t.forbidden("skill.publish", "no_grant")
    );
    await t.expectOk(t.admin.id, "assets.publish", {
      params: address,
      payload: { revision: 1, ...inTeam }
    });
    expect(await t.stored("skill", "kai-notes")).toMatchObject({
      revision: 2,
      config: { content: "The old draft." }
    });
    // Nothing of it remains, and the next save writes live.
    const saved = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: skill("kai-notes", "Live."), expectedRevision: 2, ...inTeam }
    });
    expect(saved.json()).toMatchObject({ revision: 3 });
  });

  it("can still be discarded, after which no save writes a draft", async () => {
    const { t, inTeam } = await withDraft();
    await t.expectOk(t.kai.id, "skills.draft.discard", {
      params: { name: "kai-notes" },
      payload: { expectedRevision: 1, ...inTeam }
    });
    const saved = await t.expectOk(t.admin.id, "assets.put", {
      params: address,
      payload: { config: skill("kai-notes", "Live."), expectedRevision: 1, ...inTeam }
    });
    expect(saved.json()).toMatchObject({ revision: 2 });
    const live = await t.stored("skill", "kai-notes");
    expect(
      await t.stores.agentProposals.get({ clientInstanceId, agentId: live?.id ?? "" })
    ).toBeUndefined();
  });
});

describe("catalyst and a shared skill", () => {
  const { fixture } = useSkillCliWorlds();
  const live = async (f: Awaited<ReturnType<typeof fixture>>) =>
    z
      .object({ revision: z.number(), config: z.object({ content: z.string() }).loose() })
      .loose()
      .parse(
        (
          await f.world.api.call("assets.get", {
            params: { kind: "skill", name: "form" },
            query: { workspaceId: f.workspaceId }
          })
        ).json()
      );

  it("pushes a change as one live revision, whatever files it changes", async () => {
    const f = await fixture();
    const source = await f.copy();
    expect(await f.run(source, "push")).toMatchObject({ code: 0 });
    const manifest = join(source, "skills/form/SKILL.md");
    await writeFile(manifest, `${await readFile(manifest, "utf8")}\nAsk for the case first.\n`);
    await writeFile(join(source, "skills/form/references/r.md"), "# Changed reference\n");
    await writeFile(join(source, "skills/form/assets/logo.png"), Buffer.from([0, 1, 2]));
    const pushed = await f.run(source, "push");
    expect(pushed, pushed.err).toMatchObject({ code: 0 });
    expect(pushed.out).not.toContain("draft");
    expect(await live(f)).toMatchObject({ revision: 2 });
    expect((await live(f)).config.content).toContain("Ask for the case first.");
    expect(await f.run(source, "diff")).toMatchObject({ code: 0 });
  });

  it("refuses a change over a live revision it has not seen, before any write", async () => {
    const f = await fixture();
    const source = await f.copy();
    expect(await f.run(source, "push")).toMatchObject({ code: 0 });
    const changed = await f.world.api.call("assets.put", {
      params: { kind: "skill", name: "form" },
      payload: {
        workspaceId: f.workspaceId,
        config: skill("form", "Changed in Studio."),
        expectedRevision: 1
      }
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const manifest = join(source, "skills/form/SKILL.md");
    await writeFile(manifest, `${await readFile(manifest, "utf8")}\nLocal change.\n`);
    f.calls.length = 0;
    const refused = await f.run(source, "push");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("catalyst config pull --only skill:form");
    expect(
      f.calls.filter((call) => ["assets.sync", "assets.put"].includes(call.operation))
    ).toEqual([]);
  });

  it("says which draft from before stands in the way, and publishes it by command", async () => {
    const f = await fixture();
    const source = await f.copy();
    expect(await f.run(source, "push")).toMatchObject({ code: 0 });
    const stored = await f.world.api.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name: "form"
    });
    if (!stored) throw new Error("Skill missing");
    await f.world.api.stores.agentProposals.save({
      clientInstanceId,
      agentId: stored.id,
      baseRevision: stored.revision,
      expectedDraftRevision: null,
      config: { ...stored.config, content: "# The old draft" },
      ...(stored.fileSetId === undefined ? {} : { fileSetId: stored.fileSetId }),
      author: { userId: asUserId("usr_draft_author"), release: false },
      savedAt: new Date().toISOString()
    });
    const manifest = join(source, "skills/form/SKILL.md");
    await writeFile(manifest, `${await readFile(manifest, "utf8")}\nLocal change.\n`);
    const refused = await f.run(source, "push");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("catalyst skill publish form --revision 1");

    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      [
        "skill",
        "publish",
        "form",
        "--revision",
        "1",
        "--instance",
        "https://catalyst.test",
        "--workspace",
        f.workspaceId
      ],
      {
        cwd: source,
        env: { CATALYST_API_KEY: "test" },
        fetchImpl: f.fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      }
    );
    expect({ code, err: err.join("") }).toMatchObject({ code: 0 });
    expect(await live(f)).toMatchObject({ revision: 2, config: { content: "# The old draft" } });
  });
});
