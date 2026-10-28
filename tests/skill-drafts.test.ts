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
import {
  createSkillChangePreview,
  parseClientInstanceConfig
} from "@work-shape/catalyst-config-schema";
import { createSkillFolderReader } from "@work-shape/catalyst-server";
import { createSkillSourceVersion, runSkillMounts } from "@work-shape/catalyst-tool-execution";
import { DeterministicModelProvider } from "@work-shape/catalyst-model-provider";
import { json } from "./support/skill-change-fixture";
import { clientInstanceId, skill } from "./support/access-instance";
import { setupWorkspaceHolder } from "./support/asset-operations";
import { drainRunEvents, injectStartConversationRun } from "./support/chat-server-run-harness";
import { createTestConfig, createTestUser } from "./support/fixtures";
import { useSkillCliWorlds } from "./support/skill-config-cli";
import { createStoredConfigAssetSource } from "./support/static-config-asset-source";
import { createTestInstance } from "./support/test-instance";

// SKILL-DRAFT-1: a skill the instance or a Shared Workspace owns has one shared draft. A write
// is that draft, a publish makes it live, and only holders of its write right read the draft,
// in Studio and in Try. A skill of a Personal Workspace is live on save.

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
  const saveDraft = async (content: string, expectedDraftRevision: number | null = null) =>
    (
      await ok(
        app.call("assets.put", {
          params: SKILL,
          payload: {
            config: skill(SKILL.name, content),
            expectedRevision: 1,
            expectedDraftRevision
          }
        })
      )
    ).json<{ revision: number; draftRevision?: number; publishedRevision?: number }>();
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
  return { app, instance, ok, saveDraft, readsSkill };
}

describe("a shared skill's draft", () => {
  it.each([false, true])(
    "approves into the draft and publishes through the guard (blocked: %s)",
    async (blockPublish) => {
      const t = await runFixture(blockPublish);
      const user = (await t.app.stores.users.listUsers({ clientInstanceId: t.instance }))[0];
      if (!user) throw new Error("Approver missing");
      const before = skill(SKILL.name, "LIVE-RULE");
      const operations = [
        {
          type: "replace_text" as const,
          target: "root",
          oldText: "LIVE-RULE",
          newText: "APPROVED-RULE"
        }
      ];
      const request = await t.app.stores.approvals.createApprovalRequest({
        clientInstanceId: t.instance,
        requestedBy: { id: user.id, displayLabel: user.displayLabel },
        kind: "skill_change",
        summary: "Change the house rules",
        payload: json({
          agentName: "test_agent",
          skillName: SKILL.name,
          operations,
          baseSourceVersion: createSkillSourceVersion(before),
          preview: createSkillChangePreview(before, operations)
        })
      });
      const approved = await t.ok(
        t.app.call("approval_requests.decide", {
          params: { requestId: request.id },
          payload: { decision: "approve" }
        })
      );
      expect(approved.json()).toMatchObject({
        status: "approved",
        applyResult: { draftRevision: 1, publishedRevision: 1 }
      });
      const live = () =>
        t.app.stores.configAssets.getConfigAsset({ clientInstanceId: t.instance, ...SKILL });
      expect(await live()).toMatchObject({ revision: 1, config: { content: "LIVE-RULE" } });
      const draft = draftSchema.parse(
        (await t.ok(t.app.call("skills.draft.get", { params: { name: SKILL.name } }))).json()
      ).draft;
      expect(draft).toMatchObject({ revision: 1, config: { content: "APPROVED-RULE" } });
      const blocked = await t.app.call("assets.publish", {
        params: SKILL,
        payload: { revision: 1 }
      });
      if (blockPublish) {
        expect(blocked.statusCode, blocked.body).toBe(403);
        expect(blocked.body).toContain("Review skill publishing");
        expect(await live()).toMatchObject({ revision: 1, config: { content: "LIVE-RULE" } });
      } else {
        expect(blocked.statusCode, blocked.body).toBe(200);
        expect(await live()).toMatchObject({ revision: 2, config: { content: "APPROVED-RULE" } });
      }
    }
  );

  it("leaves a live agent's run on the live skill until it is published", async () => {
    const t = await runFixture();
    const conversation = (await t.ok(t.app.call("conversations.create", { payload: {} }))).json<{
      id: string;
    }>().id;
    expect((await t.readsSkill(conversation)).text).toContain("LIVE-RULE");

    const saved = await t.saveDraft("DRAFT-RULE");
    expect(saved).toMatchObject({ draftRevision: 1, publishedRevision: 1 });
    expect(
      (
        await t.app.stores.configAssets.getConfigAsset({
          clientInstanceId: t.instance,
          ...SKILL
        })
      )?.revision
    ).toBe(1);
    const read = await t.readsSkill(conversation);
    expect(read.text).toContain("LIVE-RULE");
    expect(read.text).not.toContain("DRAFT-RULE");

    const draft = draftSchema.parse(
      (await t.ok(t.app.call("skills.draft.get", { params: { name: SKILL.name } }))).json()
    ).draft;
    expect(draft).toMatchObject({
      revision: 1,
      baseRevision: 1,
      liveRevision: 1,
      config: { content: "DRAFT-RULE" }
    });
    const published = await t.ok(
      t.app.call("assets.publish", { params: SKILL, payload: { revision: 1 } })
    );
    expect(published.json()).toMatchObject({
      draftRevision: 1,
      publishedRevision: 2,
      replacedRevision: 1
    });
    expect((await t.readsSkill(conversation)).text).toContain("DRAFT-RULE");
    expect(
      draftSchema.parse(
        (await t.ok(t.app.call("skills.draft.get", { params: { name: SKILL.name } }))).json()
      ).draft
    ).toBeNull();
  });

  it("is read in Try by a person who may write the skill, and the live skill otherwise", async () => {
    const t = await runFixture();
    await t.saveDraft("DRAFT-RULE");
    const tryId = (
      await t.ok(t.app.call("agents.try.open", { params: { name: "test_agent" } }))
    ).json<{ conversation: { id: string } }>().conversation.id;
    const drafted = await t.readsSkill(tryId);
    expect(drafted.text).toContain("DRAFT-RULE");
    const preview = readUserMessageMetadata(
      drafted.messages.findLast((message) => message.role === "user")?.metadata
    )?.preview;
    expect(preview?.skills?.map((frozen) => frozen.revision)).toEqual([1]);
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
      expect(mounts).toHaveLength(1);
      const mount = mounts[0];
      if (!mount) throw new Error("Skill mount missing");
      const files = await createSkillFolderReader({
        clientInstanceId: t.instance,
        stores: t.app.stores
      }).read({ clientInstanceId: t.instance, ...mount });
      const manifest = files.find((file) => file.path === "SKILL.md");
      if (!manifest) throw new Error("Skill manifest missing");
      return Buffer.from(manifest.bytes).toString("utf8");
    };
    expect(await mountedText(preview)).toContain("DRAFT-RULE");
    // Queued commands retain the admitted content after a later save or publish.
    await t.saveDraft("LATER-RULE", 1);
    expect(await mountedText(preview)).toContain("DRAFT-RULE");

    // Without the write right on the skill the same person's Try reads it live.
    const conversation = await t.app.stores.conversations.getConversation(
      t.instance,
      asConversationId(tryId)
    );
    const stored = await t.app.stores.configAssets.getConfigAsset({
      clientInstanceId: t.instance,
      ...SKILL
    });
    if (!conversation || !stored) throw new Error("Try conversation or skill missing");
    await t.app.stores.access.createGrant({
      clientInstanceId: t.instance,
      holderKind: "user",
      holderId: conversation.createdByUserId,
      action: "skill.write",
      effect: "deny",
      scopeKind: "asset",
      scopeId: stored.id,
      grantedBy: asUserId(conversation.createdByUserId)
    });
    const live = await t.readsSkill(tryId);
    expect(live.text).toContain("LIVE-RULE");
    expect(live.text).not.toContain("DRAFT-RULE");
    const livePreview = readUserMessageMetadata(
      live.messages.findLast((message) => message.role === "user")?.metadata
    )?.preview;
    expect(await mountedText(livePreview)).toContain("LIVE-RULE");
    expect(await mountedText(livePreview)).not.toContain("LATER-RULE");
  });
});

describe("the rights on a shared skill's draft", () => {
  it("lets a writer save and read the draft, refuses that writer's publish, and keeps it from a reader", async () => {
    const t = await setupWorkspaceHolder();
    const address = { kind: "skill", name: "kai-notes" };
    const inTeam = { workspaceId: t.kaiTeam };
    await t.put(t.kai.id, "skill", "kai-notes", t.kaiTeam);
    await t.grant(t.lena.id, "skill.read", inTeam);

    // Kai holds the write right and not the publish right.
    const saved = await t.expectOk(t.kai.id, "assets.put", {
      params: address,
      payload: { config: skill("kai-notes", "Kai's change."), expectedRevision: 1, ...inTeam }
    });
    expect(saved.json()).toMatchObject({ draftRevision: 1, publishedRevision: 1 });
    expect(
      draftSchema.parse(
        (
          await t.expectOk(t.kai.id, "skills.draft.get", {
            params: { name: "kai-notes" },
            query: inTeam
          })
        ).json()
      ).draft
    ).toMatchObject({ revision: 1, config: { content: "Kai's change." } });
    await t.expectRefused(
      t.kai.id,
      "assets.publish",
      { params: address, payload: { revision: 1, ...inTeam } },
      t.forbidden("skill.publish", "no_grant")
    );

    // Lena reads the skill and gets its live revision; its draft is not hers to see.
    await t.expectRefused(
      t.lena.id,
      "skills.draft.get",
      { params: { name: "kai-notes" }, query: inTeam },
      { status: 404, code: "NOT_FOUND" }
    );
    expect(
      (await t.expectOk(t.lena.id, "assets.get", { params: address, query: inTeam })).json()
    ).toMatchObject({ revision: 1, config: { content: "Guidance." } });

    // The administrator holds the publish right.
    await t.expectOk(t.admin.id, "assets.publish", {
      params: address,
      payload: { revision: 1, ...inTeam }
    });
    expect(await t.stored("skill", "kai-notes")).toMatchObject({
      revision: 2,
      config: { content: "Kai's change." }
    });
  });

  it("keeps a personal skill live on save, with no draft to publish", async () => {
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
    expect(saved.json()).not.toHaveProperty("draftRevision");
    expect(await t.stored("skill", "admin-own")).toMatchObject({
      revision: 2,
      config: { content: "Second." }
    });
    expect(
      draftSchema.parse(
        (
          await t.expectOk(t.admin.id, "skills.draft.get", {
            params: { name: "admin-own" },
            query: mine
          })
        ).json()
      ).draft
    ).toBeNull();
    const refused = await t.expectRefused(
      t.admin.id,
      "assets.publish",
      { params: address, payload: { revision: 2, ...mine } },
      { status: 422, code: "VALIDATION_FAILED" }
    );
    expect(refused.details).toMatchObject({ reason: "no_draft" });
  });
});

describe("catalyst and a shared skill's draft", () => {
  const { fixture } = useSkillCliWorlds();

  it("refuses a changed skill draft locally with the server's sentence before any write", async () => {
    const f = await fixture();
    const source = await f.copy();
    expect(await f.run(source, "push")).toMatchObject({ code: 0 });
    expect(await f.run(source, "pull")).toMatchObject({ code: 0 });
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
    expect(refused.err).toContain("The skill draft changed. Read it again before saving");
    expect(
      f.calls.filter((call) => ["assets.sync", "assets.put"].includes(call.operation))
    ).toEqual([]);
  });

  it("pushes a change as the draft, publishes it by command, and with push --publish", async () => {
    const f = await fixture();
    const source = await f.copy();
    expect(await f.run(source, "push")).toMatchObject({ code: 0 });
    const manifest = join(source, "skills/form/SKILL.md");
    const live = async () =>
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

    await writeFile(manifest, `${await readFile(manifest, "utf8")}\nAsk for the case first.\n`);
    const pushed = await f.run(source, "push");
    expect(pushed, pushed.err).toMatchObject({ code: 0 });
    expect(pushed.out).toContain(
      "skill:form: draft revision 1; live revision 1 is unchanged until it is published."
    );
    expect(pushed.out).toContain("catalyst skill publish form --revision 1");
    expect(await live()).toMatchObject({ revision: 1 });
    expect((await live()).config.content).not.toContain("Ask for the case first.");

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
    expect(out.join("")).toContain(
      "Published draft revision 1 of skill 'form' as live revision 2 in place of revision 1."
    );
    expect((await live()).config.content).toContain("Ask for the case first.");

    // A pull records the live revision and that no draft is pending; push --publish makes the
    // next change live in one step.
    expect(await f.run(source, "pull")).toMatchObject({ code: 0 });
    await writeFile(manifest, `${await readFile(manifest, "utf8")}\nThen fill the form.\n`);
    const published = await f.run(source, "push", { publish: true });
    expect(published, published.err).toMatchObject({ code: 0 });
    expect(published.out).toContain(
      "Published draft revision 2 of skill 'form' as live revision 3"
    );
    expect(await live()).toMatchObject({ revision: 3 });
    expect((await live()).config.content).toContain("Then fill the form.");
  });
});
