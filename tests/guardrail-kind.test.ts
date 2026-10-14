import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGuardrailAssetKind, seedReleaseGuardrails } from "@vivd-catalyst/chat-server";
import type { ReleaseGuardrailConfig } from "@vivd-catalyst/config-schema";
import { GUARDRAIL_READ_ONLY_REASON, type NewGuardrailHit } from "@vivd-catalyst/core";
import { clientInstanceId, errorSchema, setupAccessInstance } from "./support/access-instance";
import { assetPageSchema } from "./support/asset-operations";
import { createTestInstance } from "./support/test-instance";
import { withTestSql } from "./support/test-sql";

// Guardrails of release config: the seed that makes them assets, Build's read of them through
// the asset operations, the refusal of every write, and the read of their hits.

const judge = (instruction: string): ReleaseGuardrailConfig["check"] => ({
  kind: "model_judge",
  modelBindingId: "plain",
  instruction
});
const privacy: ReleaseGuardrailConfig = {
  displayName: "Datenschutz",
  description: "Keeps personal data out of skills.",
  on: "approval_request.before_create",
  filter: { kind: "skill_change" },
  check: judge("Prüfe den neuen Text auf personenbezogene Daten."),
  outcome: "block"
};
const tone: ReleaseGuardrailConfig = {
  on: "approval_request.before_create",
  check: judge("Warn on an impolite tone."),
  outcome: "warn"
};

/** A row of `assets.list`, with what the Guardrails list shows beside the title. */
const listedSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string().optional(),
      attributes: z.record(z.string(), z.unknown()).optional()
    })
  )
});

const hitsSchema = z.object({
  items: z.array(
    z
      .object({
        id: z.string(),
        event: z.string(),
        outcome: z.enum(["warn", "block"]),
        message: z.string(),
        subjectKind: z.string(),
        convertedFrom: z.literal("require_approval").optional(),
        createdAt: z.string()
      })
      // A hit names no person: an answer that carried one fails here.
      .strict()
  ),
  hasMore: z.boolean(),
  counts: z.object({ last7Days: z.number(), last30Days: z.number() }).strict()
});

function hit(overrides: Partial<NewGuardrailHit> = {}): NewGuardrailHit {
  return {
    guardrailName: "privacy",
    event: "approval_request.before_create",
    outcome: "block",
    message: "Remove the personal data.",
    subjectKind: "skill_change",
    ...overrides
  };
}

const readRevisions = (name: string) =>
  withTestSql(
    (sql) => sql<{ revision: number }[]>`
      select r.revision from config_asset_revisions r
      join config_assets a on a.id = r.asset_id
      where a.client_instance_id = ${clientInstanceId} and a.kind = 'guardrail'
        and a.name = ${name}
      order by r.revision`
  ).then((rows) => rows.map((row) => row.revision));

async function seeded(guardrails: Record<string, ReleaseGuardrailConfig>) {
  const t = await setupAccessInstance({ furtherKinds: [createGuardrailAssetKind()] });
  await seedReleaseGuardrails({ clientInstanceId, guardrails, stores: t.stores });
  return t;
}

describe("the release seed of Guardrails", () => {
  it("writes what release config holds, once, and follows each change of it", async () => {
    const { stores } = await createTestInstance();
    const seed = (guardrails: Record<string, ReleaseGuardrailConfig>) =>
      seedReleaseGuardrails({ clientInstanceId, guardrails, stores });

    expect(await seed({ privacy, tone })).toEqual({
      created: ["privacy", "tone"],
      updated: [],
      removed: [],
      conflicts: []
    });
    // Two processes that start together write once.
    const [first, second] = await Promise.all([seed({ privacy, tone }), seed({ privacy, tone })]);
    expect([first, second]).toEqual([
      { created: [], updated: [], removed: [], conflicts: [] },
      { created: [], updated: [], removed: [], conflicts: [] }
    ]);
    expect(await readRevisions("privacy")).toEqual([1]);

    expect(await seed({ privacy: { ...privacy, outcome: "warn" } })).toEqual({
      created: [],
      updated: ["privacy"],
      removed: ["tone"],
      conflicts: []
    });
    expect(await readRevisions("privacy")).toEqual([1, 2]);
    // A name that comes back continues its revisions.
    expect(await seed({ privacy: { ...privacy, outcome: "warn" }, tone })).toEqual({
      created: ["tone"],
      updated: [],
      removed: [],
      conflicts: []
    });
    expect((await readRevisions("tone")).length).toBeGreaterThan(1);
  });

  // Fails without the change: the floor was stored as a draft nobody published, and a start
  // deleted the guardrails written as assets.
  it("publishes the floor it writes, and leaves the guardrails written as assets alone", async () => {
    const { stores } = await createTestInstance();
    const seed = (guardrails: Record<string, ReleaseGuardrailConfig>) =>
      seedReleaseGuardrails({ clientInstanceId, guardrails, stores });
    const own = { kind: "guardrail", name: "own" };
    await stores.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      actor: { displayLabel: "Admin", roles: [] },
      baseRevisions: { "guardrail:own": null },
      mutations: [
        {
          type: "upsert",
          ...own,
          draft: true,
          config: { name: "own", displayName: "Own", ...tone, origin: "asset" }
        }
      ]
    });
    expect(await seed({ privacy, own: tone })).toEqual({
      created: ["privacy"],
      updated: [],
      removed: [],
      conflicts: ["own"]
    });
    const stored = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "guardrail",
      name: "privacy"
    });
    expect(stored?.publishedRevision).toBe(1);
    expect(await seed({ privacy: { ...privacy, outcome: "warn" } })).toMatchObject({
      updated: ["privacy"],
      removed: []
    });
    const updated = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "guardrail",
      name: "privacy"
    });
    expect(updated?.publishedRevision).toBe(2);
    const kept = await stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "guardrail",
      name: "own"
    });
    expect(kept?.status).toBe("active");
  });
});

describe("Guardrails in Build", () => {
  it("lists them for whoever reads guardrails, with what a row shows", async () => {
    const t = await seeded({ "build-privacy": privacy, "build-tone": tone });
    const listed = listedSchema.parse(
      (await t.expectOk(t.admin.id, "assets.list", { params: { kind: "guardrail" } })).json()
    );
    expect(listed.items.map((item) => item.name)).toEqual(["build-privacy", "build-tone"]);
    expect(listed.items[0]).toMatchObject({
      title: "Datenschutz",
      description: "Keeps personal data out of skills.",
      attributes: {
        event: "approval_request.before_create",
        checkKind: "model_judge",
        outcome: "block",
        origin: "release",
        appliesTo: "skill_change"
      }
    });
    expect(listed.items[1]).toMatchObject({ title: "build-tone" });
    expect(listed.items[1]?.attributes).not.toHaveProperty("appliesTo");

    // A member without the right sees none.
    const forKai = await t.expectOk(t.kai.id, "assets.list", { params: { kind: "guardrail" } });
    expect(assetPageSchema.parse(forKai.json()).items).toEqual([]);
  });

  it("refuses every write through the asset operations, also to a superadmin", async () => {
    const t = await seeded({ locked: privacy });
    const address = { params: { kind: "guardrail", name: "locked" } };
    const changed = { ...privacy, name: "locked", displayName: "Changed", origin: "release" };
    for (const [operation, input] of [
      ["assets.put", { ...address, payload: { config: changed } }],
      [
        "assets.put",
        {
          params: { kind: "guardrail", name: "fresh" },
          payload: { config: { ...changed, name: "fresh" } }
        }
      ],
      ["assets.delete", address]
    ] as const) {
      const response = await t.call(t.root.id, operation, input);
      const body = errorSchema.parse(response.json());
      expect({ status: response.statusCode, reason: body.error.details?.reason }).toEqual({
        status: 403,
        reason: GUARDRAIL_READ_ONLY_REASON
      });
    }
    expect(await readRevisions("locked")).toEqual([1]);
  });
});

describe("the hits of a Guardrail", () => {
  it("answers the newest first, and says when older ones exist", async () => {
    const t = await seeded({ "hits-privacy": privacy, "hits-tone": tone });
    await t.stores.guardrails.recordHits({
      clientInstanceId,
      hits: [hit({ guardrailName: "hits-tone", outcome: "warn", message: "" })]
    });
    // One more than a read answers, each a moment later than the one before.
    for (let index = 0; index < 51; index += 1) {
      await t.stores.guardrails.recordHits({
        clientInstanceId,
        hits: [hit({ guardrailName: "hits-privacy", message: `Hit ${index}` })]
      });
    }
    const read = async (name: string) =>
      hitsSchema.parse(
        (await t.expectOk(t.admin.id, "guardrails.list_hits", { params: { name } })).json()
      );

    const privacyHits = await read("hits-privacy");
    expect(privacyHits.items).toHaveLength(50);
    expect(privacyHits.hasMore).toBe(true);
    expect(privacyHits.items[0]).toMatchObject({
      event: "approval_request.before_create",
      outcome: "block",
      message: "Hit 50",
      subjectKind: "skill_change"
    });
    expect(privacyHits.counts).toEqual({ last7Days: 51, last30Days: 51 });
    expect(privacyHits.items.at(-1)?.message).toBe("Hit 1");
    expect(await read("hits-tone")).toEqual({
      items: [expect.objectContaining({ outcome: "warn", message: "" })],
      hasMore: false,
      counts: { last7Days: 1, last30Days: 1 }
    });
  });

  // Fails without the change: a block that answered a request for an approval the action could
  // not wait for read as any other block.
  it("says which block answered a request for an approval that could not wait", async () => {
    const t = await seeded({ converted: privacy });
    await t.stores.guardrails.recordHits({
      clientInstanceId,
      hits: [
        hit({ guardrailName: "converted", message: "plain" }),
        hit({ guardrailName: "converted", message: "held", convertedFrom: "require_approval" })
      ]
    });
    const answer = hitsSchema.parse(
      (
        await t.expectOk(t.admin.id, "guardrails.list_hits", { params: { name: "converted" } })
      ).json()
    );
    expect(answer.items.map((item) => [item.message, item.outcome, item.convertedFrom])).toEqual(
      expect.arrayContaining([
        ["plain", "block", undefined],
        ["held", "block", "require_approval"]
      ])
    );
  });

  it("counts the hits of the last 7 and the last 30 days by the database's clock", async () => {
    const t = await seeded({ counted: privacy });
    await t.stores.guardrails.recordHits({
      clientInstanceId,
      hits: ["now", "ten days", "forty days"].map((message) =>
        hit({ guardrailName: "counted", message })
      )
    });
    await withTestSql(
      (sql) => sql`
        update guardrail_hits set created_at = now() - case message
          when 'ten days' then interval '10 days' else interval '40 days' end
        where client_instance_id = ${clientInstanceId} and guardrail_name = 'counted'
          and message <> 'now'`
    );
    const answer = hitsSchema.parse(
      (await t.expectOk(t.admin.id, "guardrails.list_hits", { params: { name: "counted" } })).json()
    );
    expect(answer.counts).toEqual({ last7Days: 1, last30Days: 2 });
    expect(answer.items.map((item) => item.message)).toEqual(["now", "ten days", "forty days"]);
  });

  it("asks the Guardrail's read right, and knows no Guardrail release config does not hold", async () => {
    const t = await seeded({ secret: privacy });
    await t.expectRefused(
      t.kai.id,
      "guardrails.list_hits",
      { params: { name: "secret" } },
      { status: 403, code: "FORBIDDEN" }
    );
    await t.expectRefused(
      t.admin.id,
      "guardrails.list_hits",
      { params: { name: "missing" } },
      { status: 404, code: "NOT_FOUND" }
    );
    // A Guardrail that left release config keeps its hits until the audit retention, unread.
    await t.stores.guardrails.recordHits({
      clientInstanceId,
      hits: [hit({ guardrailName: "secret" })]
    });
    await seedReleaseGuardrails({ clientInstanceId, guardrails: {}, stores: t.stores });
    await t.expectRefused(
      t.admin.id,
      "guardrails.list_hits",
      { params: { name: "secret" } },
      { status: 404, code: "NOT_FOUND" }
    );
  });

  it("are deleted with the audit events, by the database's clock", async () => {
    const { stores } = await createTestInstance();
    await stores.guardrails.recordHits({
      clientInstanceId,
      hits: [
        hit({ guardrailName: "pruned", message: "old" }),
        hit({ guardrailName: "pruned", message: "recent" })
      ]
    });
    await withTestSql(
      (sql) => sql`
        update guardrail_hits set created_at = now() - interval '31 days'
        where client_instance_id = ${clientInstanceId} and guardrail_name = 'pruned' and message = 'old'`
    );
    expect(await stores.guardrails.deleteHitsOlderThan({ clientInstanceId, days: 30 })).toBe(1);
    expect(
      (
        await stores.guardrails.listHits({ clientInstanceId, guardrailName: "pruned", limit: 10 })
      ).map((row) => row.message)
    ).toEqual(["recent"]);
  });
});
