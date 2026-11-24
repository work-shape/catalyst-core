import { readFile } from "node:fs/promises";
import postgres from "postgres";
import {
  OPERATION_CALL_APPROVAL_KIND,
  platformAssetWriteRefusal
} from "@work-shape/catalyst-tool-execution";
import { AppError, asConversationId } from "@work-shape/catalyst-core";
import { DeterministicModelProvider } from "@work-shape/catalyst-model-provider";
import { afterAll, beforeAll, describe, expect, inject, it, vi } from "vitest";
import { z } from "zod";
import { createAssetToolsFixture, OTHER } from "./support/platform-asset-tools";
import { PostgresFixtures } from "./support/postgres-fixtures";

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
    expect(await allowed()).toEqual(["read"]);
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
    expect(await allowed()).toEqual(["read", "write"]);
    expect(await t.draft(OTHER)).toMatchObject({ revision: 1 });
    const denied = await t.publish(1, OTHER);
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toContain("agent.publish");
    expect(await t.draft()).toMatchObject({ revision: 1 });
    await grant("agent.publish");
    // Studio reads what the caller may do on this asset from the instance, not from its own rules.
    expect(await allowed()).toEqual(["read", "write", "publish"]);
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
    expect(await allowed()).toEqual(["read", "write", "delete", "publish"]);
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
    expect(await allowed()).toEqual(["read", "write", "delete"]);
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
});

describe("agent draft conflict attribution (Platform Access 62)", () => {
  it("tells the Build Agent whose draft won and when, without unrelated error details", () => {
    const details = {
      reason: "draft_changed",
      currentDraftRevision: 4,
      author: { userId: "writer", conversationId: "build", release: false },
      changedAt: "2026-10-17T12:00:00.000Z"
    };
    expect(
      platformAssetWriteRefusal(
        new AppError("REVISION_CONFLICT", "Read the draft again", {
          ...details,
          unrelated: "must not cross the tool boundary"
        })
      )
    ).toEqual({
      saved: false,
      conflict: "REVISION_CONFLICT",
      message: "Read the draft again",
      details
    });
    expect(
      platformAssetWriteRefusal(
        new AppError("REVISION_CONFLICT", "Read again", {
          reason: "draft_changed",
          currentDraftRevision: "invalid",
          author: "invalid"
        })
      )
    ).not.toHaveProperty("details");
  });
});

const fixtures = new PostgresFixtures(inject("postgresFixturePrefix"));

describe("agent draft collapse (Platform Access 65)", () => {
  it("keeps the newest pending head, its author and every agent's highest counter, including settled proposals", async () => {
    const url = await fixtures.database(`agent_draft_${globalThis.crypto.randomUUID()}`, false);
    const sql = postgres(url, { max: 1 });
    try {
      // The populated TRY-1a1 tables, including settled counter rows. No runtime server writes here.
      await sql.unsafe(`
        CREATE TABLE agent_try_conversations (client_instance_id text, agent_id text, conversation_id text);
        CREATE TABLE config_assets (id text PRIMARY KEY);
        CREATE TABLE conversations (id text PRIMARY KEY, created_by_user_id text);
        CREATE TABLE agent_change_proposals (
          id text PRIMARY KEY, client_instance_id text NOT NULL, agent_id text NOT NULL REFERENCES config_assets(id),
          source_kind text NOT NULL, source_id text NOT NULL, base_revision integer NOT NULL, revision integer NOT NULL,
          created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
        );
        CREATE TABLE agent_change_proposal_revisions (
          proposal_id text REFERENCES agent_change_proposals(id) ON DELETE CASCADE,
          revision integer, config jsonb NOT NULL, created_at timestamptz NOT NULL,
          PRIMARY KEY(proposal_id, revision)
        );
        CREATE UNIQUE INDEX agent_change_proposals_source_idx ON agent_change_proposals(agent_id, source_kind, source_id);
        CREATE INDEX agent_change_proposals_of_source_idx ON agent_change_proposals(client_instance_id, source_kind, source_id);
        INSERT INTO config_assets VALUES ('a'), ('b'), ('c'), ('d');
        INSERT INTO conversations VALUES ('build_new', 'user_new'), ('build_old', 'user_old');
        INSERT INTO agent_change_proposals VALUES
          ('old', 'instance', 'a', 'conversation', 'build_old', 4, 3, now(), '2026-10-16'),
          ('new', 'instance', 'a', 'conversation', 'build_new', 4, 7, now(), '2026-10-17'),
          ('settled', 'instance', 'a', 'person', 'settled_user', 4, 12, now(), '2026-10-18'),
          ('person', 'instance', 'b', 'person', 'user_b', 2, 4, now(), '2026-10-17'),
          ('counter_low', 'instance', 'c', 'person', 'user_c1', 1, 2, now(), '2026-10-16'),
          ('counter_high', 'instance', 'c', 'person', 'user_c2', 1, 8, now(), '2026-10-17'),
          ('tie_a', 'instance', 'd', 'person', 'user_da', 1, 9, now(), '2026-10-17'),
          ('tie_z', 'instance', 'd', 'person', 'user_dz', 1, 2, now(), '2026-10-17');
        INSERT INTO agent_change_proposal_revisions VALUES
          ('old', 3, '{"instructions":"old"}', now()),
          ('new', 7, '{"instructions":"new"}', now()),
          ('person', 4, '{"instructions":"single"}', now()),
          ('tie_a', 9, '{"instructions":"tie a"}', now()),
          ('tie_z', 2, '{"instructions":"tie z"}', now());
      `);
      const source = (
        await Promise.all(
          ["0103_agent_draft", "0104_agent_draft_index"].map((name) =>
            readFile(`packages/postgres-store/migrations/${name}.sql`, "utf8")
          )
        )
      ).join("\n--> statement-breakpoint\n");
      for (const statement of source.split("--> statement-breakpoint"))
        if (statement.trim()) await sql.unsafe(statement);
      const rows =
        await sql`SELECT p.agent_id, p.revision, p.last_author_user_id, p.last_build_conversation_id, r.config
        FROM agent_change_proposals p LEFT JOIN agent_change_proposal_revisions r ON r.proposal_id=p.id AND r.revision=p.revision ORDER BY p.agent_id`;
      expect(rows).toEqual([
        {
          agent_id: "a",
          revision: 12,
          last_author_user_id: "user_new",
          last_build_conversation_id: "build_new",
          config: { instructions: "new" }
        },
        {
          agent_id: "b",
          revision: 4,
          last_author_user_id: "user_b",
          last_build_conversation_id: null,
          config: { instructions: "single" }
        },
        {
          agent_id: "c",
          revision: 8,
          last_author_user_id: "user_c2",
          last_build_conversation_id: null,
          config: null
        },
        {
          agent_id: "d",
          revision: 9,
          last_author_user_id: "user_dz",
          last_build_conversation_id: null,
          config: { instructions: "tie z" }
        }
      ]);
      expect(
        await sql`SELECT * FROM agent_change_proposal_revisions WHERE proposal_id IN ('old', 'settled', 'counter_low', 'tie_a')`
      ).toEqual([]);
    } finally {
      await sql.end();
      await fixtures.drop(url);
    }
  });
});
