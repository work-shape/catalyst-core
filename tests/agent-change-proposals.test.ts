import { OPERATION_CALL_APPROVAL_KIND } from "@work-shape/catalyst-tool-execution";
import { asConversationId } from "@work-shape/catalyst-core";
import { DeterministicModelProvider } from "@work-shape/catalyst-model-provider";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createAssetToolsFixture, OTHER } from "./support/platform-asset-tools";

const AGENT = { kind: "agent", name: "test_agent" };
const liveSchema = z.object({
  id: z.string(),
  revision: z.number(),
  config: z.object({ instructions: z.string() }).loose()
});
const allowedSchema = z.object({ allowed: z.array(z.string()).optional() });
const draftSchema = z.object({
  draft: z
    .object({
      revision: z.number(),
      baseRevision: z.number(),
      config: z.object({ instructions: z.string() }).loose(),
      author: z.object({
        userId: z.string().optional(),
        name: z.string().optional(),
        conversationId: z.string().optional(),
        release: z.boolean()
      })
    })
    .nullable()
});
const writeSchema = z.object({
  saved: z.boolean(),
  revision: z.number().optional(),
  draftRevision: z.number().optional(),
  conflict: z.string().optional(),
  details: z.object({ author: z.object({ userId: z.string() }), changedAt: z.string() }).optional()
});
const errorSchema = z.object({
  error: z.object({
    code: z.string(),
    details: z
      .object({
        reason: z.string().optional(),
        author: z.unknown().optional(),
        changedAt: z.string().optional()
      })
      .loose()
      .optional()
  })
});
const idSchema = z.object({ id: z.string() });

// AD-1: the two fences refer to different revision spaces. Every surface shares one draft.
describe("one shared agent draft (Platform Access 45, 62, 63, 65; Access 45)", () => {
  beforeAll(() =>
    vi.spyOn(DeterministicModelProvider.prototype, "stream").mockImplementation(async function* (
      this: DeterministicModelProvider,
      request
    ) {
      yield { type: "completed", completion: await this.complete(request) };
    })
  );
  afterAll(() => vi.restoreAllMocks());

  async function fixture() {
    const t = await createAssetToolsFixture("in_process", ["instructions"]);
    const live = async () =>
      liveSchema.parse(
        await t.app.stores.configAssets.getConfigAsset({
          clientInstanceId: t.clientInstanceId,
          ...AGENT
        })
      );
    const draft = async (as?: string) =>
      draftSchema.parse(
        (await t.ok(t.app.call("agents.draft.get", { params: { name: AGENT.name } }, as))).json()
      ).draft;
    const converse = async () => idSchema.parse((await t.ok(t.converse(AGENT))).json()).id;
    const put = async (instructions: string, expectedDraftRevision?: number | null) =>
      t.app.call("assets.put", {
        params: AGENT,
        payload: {
          config: { ...(await live()).config, instructions },
          expectedRevision: (await live()).revision,
          ...(expectedDraftRevision === undefined ? {} : { expectedDraftRevision })
        }
      });
    const propose = async (
      conversationId: string,
      instructions: string,
      expectedDraftRevision: number | null
    ) =>
      writeSchema.parse(
        await t.call(conversationId, "platform.assets.put", {
          config: { ...(await live()).config, instructions },
          expectedRevision: (await live()).revision,
          expectedDraftRevision
        })
      );
    const publish = (revision: number, as?: string) =>
      t.app.call("assets.publish", { params: AGENT, payload: { revision } }, as);
    const discard = (expectedRevision: number) =>
      t.app.call("agents.draft.discard", {
        params: { name: AGENT.name },
        payload: { expectedRevision }
      });
    const version = () =>
      t.app.stores.configAssets.getConfigAssetState({ clientInstanceId: t.clientInstanceId });
    return { ...t, live, draft, converse, put, propose, publish, discard, version };
  }

  it("shares a draft across two Build conversations and Studio; an old or absent draft fence never overwrites it (62)", async () => {
    const t = await fixture();
    const before = await t.live();
    const version = await t.version();
    const first = await t.converse();
    const second = await t.converse();
    expect(await t.propose(first, "First draft.", null)).toMatchObject({
      saved: true,
      revision: 1
    });
    expect(await t.propose(second, "Second draft.", 1)).toMatchObject({
      saved: true,
      draftRevision: 2
    });
    await t.ok(t.put("Studio draft.", 2));
    const stale = await t.put("Unseen overwrite.", 2);
    expect(stale.statusCode).toBe(412);
    expect(errorSchema.parse(stale.json()).error).toMatchObject({
      code: "REVISION_CONFLICT",
      details: {
        reason: "draft_changed",
        author: expect.any(Object),
        changedAt: expect.any(String)
      }
    });
    expect((await t.put("Old CLI, no fence.")).statusCode).toBe(412);
    expect(await t.propose(first, "Late agent.", 1)).toMatchObject({
      saved: false,
      conflict: "REVISION_CONFLICT",
      details: { author: { userId: expect.any(String) }, changedAt: expect.any(String) }
    });
    // The draft names its author as people know them (AD-4): the page's badge says it.
    expect(await t.draft()).toMatchObject({
      revision: 3,
      config: { instructions: "Studio draft." },
      author: { userId: expect.any(String), name: expect.stringMatching(/\S/u) }
    });
    expect(await t.live()).toEqual(before);
    expect(await t.version()).toEqual(version);
    const read = z
      .object({
        revision: z.number(),
        draftRevision: z.number(),
        config: z.object({ instructions: z.string() })
      })
      .parse(await t.call(second, "platform.assets.get"));
    expect(read).toMatchObject({
      revision: before.revision,
      draftRevision: 3,
      config: { instructions: "Studio draft." }
    });
    const asset = (await t.ok(t.app.call("assets.get", { params: AGENT }))).json();
    expect(asset).toMatchObject({
      revision: before.revision,
      config: before.config,
      agentDraft: { revision: 3 }
    });
    const list = (await t.ok(t.app.call("assets.list", { params: { kind: "agent" } }))).json();
    expect(list).toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({
          name: AGENT.name,
          revision: before.revision,
          agentDraft: {
            revision: 3,
            baseRevision: before.revision,
            author: expect.any(Object),
            updatedAt: expect.any(String)
          }
        })
      ])
    });
    const history = await t.app.stores.configAssets.listConfigAssetRevisions({
      clientInstanceId: t.clientInstanceId,
      ...AGENT
    });
    expect(history.at(-1)?.revision).toBe(before.revision);
  }, 120_000);

  it("publishes exactly the named draft, discards with its own fence, and never reuses a number (63)", async () => {
    const t = await fixture();
    const before = await t.live();
    await t.ok(t.put("Draft A.")); // Additive field: an old caller is safe only with no pending draft.
    expect((await t.publish(2)).statusCode).toBe(412);
    expect((await t.discard(2)).statusCode).toBe(412);
    expect((await t.ok(t.publish(1))).json()).toEqual({
      draftRevision: 1,
      publishedRevision: before.revision + 1,
      replacedRevision: before.revision
    });
    expect(await t.draft()).toBeNull();
    expect((await t.live()).config.instructions).toBe("Draft A.");
    await t.ok(t.put("Draft B.", null));
    await t.ok(t.discard(2));
    await t.ok(t.put("Draft C.", null));
    expect(await t.draft()).toMatchObject({ revision: 3 });
    expect((await t.publish(1)).statusCode).toBe(412);
    expect((await t.live()).config.instructions).toBe("Draft A.");
    const events = await t.app.stores.audit.listAuditEvents({
      clientInstanceId: t.clientInstanceId,
      type: "config_asset.updated",
      page: { limit: 100 }
    });
    expect(
      events.filter(
        (event) => event.type === "config_asset.updated" && event.metadata?.name === AGENT.name
      )
    ).toHaveLength(1);
  }, 120_000);

  it("hides drafts from readers, separates write from publish and permits an asset publish grant (Access 45, 63)", async () => {
    const t = await fixture();
    await t.ok(t.put("Pending."));
    await t.ok(t.app.call("me.get", {}, OTHER));
    const other = (
      await t.app.stores.users.listUsers({ clientInstanceId: t.clientInstanceId })
    ).find((user) => user.displayLabel === "Other");
    const live = await t.live();
    const grant = (action: string) =>
      t.ok(
        t.app.call("permissions.grant", {
          payload: {
            holderKind: "user",
            holderId: other?.id,
            action,
            scopeKind: "asset",
            scopeId: live.id
          }
        })
      );
    const allowed = async () =>
      allowedSchema.parse((await t.ok(t.app.call("assets.get", { params: AGENT }, OTHER))).json())
        .allowed;
    await grant("agent.read");
    expect(await allowed()).toEqual([]);
    expect(
      (await t.app.call("agents.draft.get", { params: { name: AGENT.name } }, OTHER)).statusCode
    ).toBe(404);
    expect(
      (await t.ok(t.app.call("assets.get", { params: AGENT }, OTHER))).json()
    ).not.toHaveProperty("agentDraft");
    // A reader cannot discard the draft, nor learn from the answer that one is pending.
    const discarded = await t.app.call(
      "agents.draft.discard",
      { params: { name: AGENT.name }, payload: { expectedRevision: 1 } },
      OTHER
    );
    expect(discarded.statusCode).toBe(404);
    expect(await t.draft()).toMatchObject({ revision: 1 });
    await grant("agent.write");
    expect(await allowed()).toEqual(["write"]);
    expect(await t.draft(OTHER)).toMatchObject({ revision: 1 });
    const denied = await t.publish(1, OTHER);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain("agent.publish");
    expect(await t.draft()).toMatchObject({ revision: 1 });
    await grant("agent.publish");
    // Studio reads what the caller may do on this asset from the instance, not from its own rules.
    expect(await allowed()).toEqual(["write", "publish"]);
    await t.ok(t.publish(1, OTHER));
    expect(await t.draft()).toBeNull();
  }, 120_000);

  it("names what a caller may do on the asset: a deny on the asset outweighs the role's instance allow (Access 45, 63)", async () => {
    const t = await fixture();
    await t.ok(t.put("Pending."));
    await t.ok(t.app.call("me.get", {}, OTHER));
    const other = (
      await t.app.stores.users.listUsers({ clientInstanceId: t.clientInstanceId })
    ).find((user) => user.displayLabel === "Other");
    if (other === undefined) throw new Error("The other user signed in and is listed.");
    const live = await t.live();
    const allowed = async () =>
      allowedSchema.parse((await t.ok(t.app.call("assets.get", { params: AGENT }, OTHER))).json())
        .allowed;
    // The admin role allows every agent right on the whole instance.
    await t.ok(
      t.app.call("users.update", {
        params: { userId: other.id },
        payload: { roles: ["user", "admin"] }
      })
    );
    expect(await allowed()).toEqual(["write", "delete", "publish"]);
    await t.ok(
      t.app.call("permissions.grant", {
        payload: {
          holderKind: "user",
          holderId: other?.id,
          action: "agent.publish",
          scopeKind: "asset",
          scopeId: live.id,
          effect: "deny"
        }
      })
    );
    expect(await allowed()).toEqual(["write", "delete"]);
    const denied = await t.publish(1, OTHER);
    expect(denied.statusCode).toBe(403);
    expect(await t.draft()).toMatchObject({ revision: 1 });
  }, 120_000);

  it("refuses a stale base and keeps it as a draft (45, 63)", async () => {
    const t = await fixture();
    const before = await t.live();
    await t.ok(t.put("Draft."));
    // A trusted live change, such as an approved skill attachment, can move the live base.
    await t.app.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId: t.clientInstanceId,
      baseRevisions: { [`agent:${AGENT.name}`]: before.revision },
      mutations: [
        { type: "upsert", ...AGENT, config: { ...before.config, instructions: "Changed live." } }
      ]
    });
    const stale = await t.publish(1);
    expect(stale.statusCode).toBe(409);
    expect(errorSchema.parse(stale.json()).error.details).toMatchObject({ reason: "stale_base" });
    expect(await t.draft()).toMatchObject({ revision: 1 });
  }, 120_000);

  it("revert drafts an earlier live revision and deleting a Build conversation leaves the draft (62)", async () => {
    const t = await fixture();
    const before = await t.live();
    const build = await t.converse();
    await t.propose(build, "First live change.", null);
    await t.ok(t.publish(1));
    const live = await t.live();
    await t.ok(
      t.app.call("assets.revert", {
        params: AGENT,
        payload: {
          revision: before.revision,
          expectedRevision: live.revision,
          expectedDraftRevision: null
        }
      })
    );
    expect(await t.live()).toEqual(live);
    expect(await t.draft()).toMatchObject({ revision: 2, config: before.config });
    await t.ok(t.app.call("conversations.delete", { params: { conversationId: build } }));
    expect(await t.draft()).toMatchObject({ revision: 2 });
    expect(
      await t.app.stores.agentProposals.get({
        clientInstanceId: t.clientInstanceId,
        agentId: live.id,
        source: { kind: "conversation", conversationId: asConversationId(build) }
      })
    ).toBeDefined();
  }, 120_000);

  it.each([
    ["agent.before_publish", "require_approval", 202],
    ["asset.before_write", "block", 403]
  ] as const)(
    "honours %s with %s at publish and keeps the draft (Events 104)",
    async (on, outcome, status) => {
      const t = await fixture();
      const before = await t.live();
      await t.ok(t.put("Draft content to review."));
      const guardrail = { kind: "guardrail", name: "agent-publish-check" };
      const created = await t.ok(
        t.app.call("assets.put", {
          params: guardrail,
          payload: {
            config: {
              name: guardrail.name,
              displayName: "Review agent changes",
              on,
              ...(on === "asset.before_write" ? { filter: { kind: "agent" } } : {}),
              check: { kind: "pattern", pattern: "Draft content", reason: "Review this content." },
              outcome
            },
            expectedRevision: null
          }
        })
      );
      const revision = z.object({ revision: z.number() }).parse(created.json()).revision;
      await t.ok(t.app.call("assets.publish", { params: guardrail, payload: { revision } }));
      const held = await t.publish(1);
      expect(held.statusCode, held.body).toBe(status);
      expect(await t.live()).toEqual(before);
      expect(await t.draft()).toMatchObject({ revision: 1 });
      if (outcome === "require_approval") {
        const requests = await t.app.stores.approvals.listApprovalRequests({
          clientInstanceId: t.clientInstanceId,
          kinds: [OPERATION_CALL_APPROVAL_KIND],
          page: { limit: 100 }
        });
        expect(requests.some((request) => request.status === "pending")).toBe(true);
      }
    },
    120_000
  );

  it("drops a deleted agent's pending content", async () => {
    const t = await fixture();
    const before = await t.live();
    await t.ok(t.put("Never revive this draft."));
    const address = { clientInstanceId: t.clientInstanceId, agentId: before.id };
    await t.app.stores.configAssets.applyConfigAssetMutations({
      clientInstanceId: t.clientInstanceId,
      baseRevisions: { "agent:test_agent": before.revision },
      baseDefaultAgentName: AGENT.name,
      mutations: [
        { type: "setDefaultAgent", agentName: undefined },
        { type: "delete", ...AGENT }
      ]
    });
    expect(await t.app.stores.agentProposals.get(address)).toBeUndefined();
  });

  it("retires all proposal operations (65)", () => {
    expect(Object.keys(apiOperations).filter((id) => id.startsWith("agents.proposal."))).toEqual(
      []
    );
  });
});
