import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGuardrailAssetKind } from "@work-shape/catalyst-server";
import {
  asCollaborationWorkspaceId,
  type AuditActor,
  type CollaborationWorkspaceId
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, skill } from "./support/access-instance";
import { appFiles, setupAppInstance, type AppInstance } from "./support/app-instance";
import {
  IBAN,
  guardedEvents,
  ibanPattern,
  judgeBinding,
  noIban,
  runnerOf
} from "./support/guardrails";
import { withTestSql } from "./support/test-sql";

// Guardrails written as assets (EW-6a): a draft that a holder of `guardrail.publish` at its
// scope makes enforce beside the release floor, in its scope only, never on the change of
// guardrails; its test and its dry run, which keep no hit and name nobody; the audit of its
// publish and unpublish, and the usage of its judge by its scope. Spec:
// events-workflows-and-guardrails.md, Scope and publishing, acceptance checks 5 and 54 to 57;
// access-and-permissions.md, acceptance check 31.

const guardrail = (name: string, overrides: Record<string, unknown> = {}) => ({
  name,
  displayName: `Guardrail ${name}`,
  on: "asset.before_write",
  filter: { kind: "skill" },
  check: { kind: "pattern", pattern: ibanPattern, reason: "No bank account here." },
  outcome: "block",
  ...overrides
});

const writtenSchema = z.looseObject({ revision: z.number() });
const refusalOf = (response: { json(): unknown }) => errorSchema.parse(response.json()).error;

const dryRunSchema = z
  .object({
    revision: z.number(),
    event: z.string(),
    outcome: z.enum(["allow", "warn", "require_approval", "block"]),
    days: z.literal(14),
    since: z.string(),
    matched: z.number(),
    evaluated: z.number(),
    notEvaluable: z.number(),
    limitedTo: z.number().optional(),
    wouldBlock: z.object({ actions: z.number(), people: z.number() }).strict(),
    wouldRequireApproval: z.object({ actions: z.number(), people: z.number() }).strict(),
    wouldWarn: z.object({ actions: z.number(), people: z.number() }).strict(),
    published: z.boolean()
  })
  // A dry run names nobody and nothing it checked: an answer that carried more fails here.
  .strict();

async function instance(floor: Record<string, unknown> = {}) {
  const t = await setupAppInstance({
    furtherKinds: [createGuardrailAssetKind()],
    server: (stores) => ({ operations: { events: guardedEvents(stores, floor).events } })
  });
  const put = (
    userId: string,
    name: string,
    config: Record<string, unknown>,
    workspaceId?: string
  ) =>
    t.call(userId, "assets.put", {
      params: { kind: "guardrail", name },
      payload: { config, ...(workspaceId === undefined ? {} : { workspaceId }) }
    });
  const publish = (userId: string, name: string, revision: number, workspaceId?: string) =>
    t.call(userId, "assets.publish", {
      params: { kind: "guardrail", name },
      payload: { revision, ...(workspaceId === undefined ? {} : { workspaceId }) }
    });
  const putSkill = (content: string, name = "kunden-faq") =>
    t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name },
      payload: { config: skill(name, content) }
    });
  /** Writes and publishes an instance guardrail as the administrator. */
  const enforce = async (name: string, config: Record<string, unknown>, workspaceId?: string) => {
    const written = await put(t.admin.id, name, config, workspaceId);
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = writtenSchema.parse(written.json());
    const published = await publish(t.admin.id, name, revision, workspaceId);
    expect(published.statusCode, published.body).toBe(200);
    return revision;
  };
  return { ...t, put, publish, putSkill, enforce };
}

const hitsOf = (name: string) =>
  withTestSql(
    (sql) => sql<{ count: number }[]>`
      select count(*)::int as count from guardrail_hits
      where client_instance_id = ${clientInstanceId} and guardrail_name = ${name}`
  ).then(([row]) => row?.count ?? 0);

const auditOf = (type: string) =>
  withTestSql(
    (sql) => sql<{ metadata: Record<string, unknown>; actor: AuditActor | null }[]>`
      select metadata, actor from audit_events
      where client_instance_id = ${clientInstanceId} and type = ${type}
      order by created_at`
  );

describe("a guardrail written as an asset", () => {
  it("names blocked saves and guardrail hits by readable display title without exposing it to other readers", async () => {
    const t = await instance();
    const name = "konten-review";
    const config = { ...skill(name), title: "Kontenprüfung" };
    expect(
      (
        await t.call(t.admin.id, "assets.put", {
          params: { kind: "skill", name },
          payload: { config }
        })
      ).statusCode
    ).toBe(200);
    await t.enforce(
      "title-rule",
      guardrail("title-rule", {
        displayName: "Keine Kontonummern",
        check: {
          kind: "pattern",
          pattern: ibanPattern,
          reason: "Bankkonten sind hier nicht erlaubt."
        }
      })
    );
    const blocked = await t.call(t.admin.id, "assets.put", {
      headers: { "accept-language": "de" },
      params: { kind: "skill", name },
      payload: { config: { ...config, content: IBAN } }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({
      error: {
        message:
          "Die Leitplanke „Keine Kontonummern“ hat die Aktion „Kontenprüfung“ verhindert: Bankkonten sind hier nicht erlaubt.",
        details: {
          guardrailTitle: "Keine Kontonummern",
          guardrailReason: "Bankkonten sind hier nicht erlaubt."
        }
      }
    });
    const hits = await t.call(t.admin.id, "guardrails.list_hits", {
      params: { name: "title-rule" }
    });
    expect(hits.statusCode, hits.body).toBe(200);
    expect(hits.json()).toMatchObject({
      items: [{ subjectName: name, subjectTitle: "Kontenprüfung" }]
    });
    const target = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "skill",
      name
    });
    if (!target) throw new Error("Missing fixture skill");
    await t.grant(t.admin.id, "skill.read", { assetId: target.id }, "deny");
    const restricted = await t.call(t.admin.id, "guardrails.list_hits", {
      params: { name: "title-rule" }
    });
    expect(restricted.statusCode, restricted.body).toBe(200);
    expect(JSON.stringify(restricted.json())).not.toContain("Kontenprüfung");
  });

  // Fails without the change: a guardrail could not be written, or a draft enforced.
  it("blocks nothing as a draft, enforces once published, and stops when unpublished", async () => {
    const t = await instance();
    const revision = writtenSchema.parse(
      (await t.put(t.admin.id, "no-iban", guardrail("no-iban"))).json()
    ).revision;
    expect((await t.putSkill(`Konto: ${IBAN}`)).statusCode).toBe(200);

    expect((await t.publish(t.admin.id, "no-iban", revision)).statusCode).toBe(200);
    const blocked = await t.putSkill(`Neues Konto: ${IBAN}`);
    expect(blocked.statusCode).toBe(403);
    expect(refusalOf(blocked).message).toContain("Guardrail 'Guardrail no-iban' blocked");
    expect(await hitsOf("no-iban")).toBe(1);

    const unpublished = await t.call(t.admin.id, "guardrails.unpublish", {
      params: { name: "no-iban" }
    });
    expect(unpublished.statusCode, unpublished.body).toBe(200);
    expect(unpublished.json()).toEqual({ draftRevision: revision, unpublishedRevision: revision });
    expect((await t.putSkill(`Wieder: ${IBAN}`)).statusCode).toBe(200);

    // Publish and unpublish are audited with the guardrail, its revision, its scope and who.
    const [published] = await auditOf("guardrail.published");
    expect(published?.metadata).toMatchObject({
      kind: "guardrail",
      name: "no-iban",
      revision,
      scope: "instance"
    });
    expect(published?.actor?.userId).toBe(t.admin.id);
    const [taken] = await auditOf("guardrail.unpublished");
    expect(taken?.metadata).toMatchObject({ name: "no-iban", revision, scope: "instance" });
  });

  // Acceptance check 5. Fails without the change: an asset's `allow` took the floor's block
  // away, or an asset of the floor's name replaced it.
  it("cannot remove or weaken a guardrail of release config: both run and the strictest wins", async () => {
    const t = await instance({ floor_iban: noIban({ displayName: "Floor" }) });
    await t.enforce(
      "allow-iban",
      guardrail("allow-iban", {
        check: { kind: "pattern", pattern: ibanPattern },
        outcome: "allow"
      })
    );
    const blocked = await t.putSkill(IBAN);
    expect(blocked.statusCode).toBe(403);
    expect(refusalOf(blocked).message).toContain("Guardrail 'Floor' blocked");
    // A write that claims to be of the floor is refused: only the release seed writes it.
    const claimed = await t.put(t.admin.id, "floor-copy", {
      ...guardrail("floor-copy"),
      origin: "release"
    });
    expect(claimed.statusCode).toBe(403);
    expect(refusalOf(claimed).details?.reason).toBe("guardrail_release_config_only");
  });

  // Acceptance check 56. Fails without the change: a published guardrail stopped the change
  // of guardrails, and with it its own removal.
  it("never runs on writes, publishes or deletes of guardrails; the floor does", async () => {
    const t = await instance({
      floor_on_guardrails: {
        displayName: "No secret in guardrails",
        on: "asset.before_write",
        filter: { kind: "guardrail" },
        check: { kind: "pattern", pattern: "SECRET" },
        outcome: "block"
      }
    });
    await t.enforce(
      "every-write",
      guardrail("every-write", { filter: undefined, check: { kind: "pattern", pattern: "." } })
    );
    await t.enforce(
      "every-asset-call",
      guardrail("every-asset-call", {
        on: "operation.before_call",
        filter: { operation: "assets.*" },
        check: { kind: "pattern", pattern: "." }
      })
    );
    // Both stop every other write.
    expect((await t.putSkill("Nichts.")).statusCode).toBe(403);

    // A guardrail is written, published and deleted all the same.
    const written = await t.put(t.admin.id, "another", guardrail("another"));
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = writtenSchema.parse(written.json());
    expect((await t.publish(t.admin.id, "another", revision)).statusCode).toBe(200);
    expect(
      (await t.call(t.admin.id, "guardrails.unpublish", { params: { name: "another" } })).statusCode
    ).toBe(200);
    expect(
      (
        await t.call(t.admin.id, "assets.delete", {
          params: { kind: "guardrail", name: "another" }
        })
      ).statusCode
    ).toBe(200);
    // And so is the guardrail that stops everything else: nobody locks themselves out.
    expect(
      (await t.call(t.admin.id, "guardrails.unpublish", { params: { name: "every-asset-call" } }))
        .statusCode
    ).toBe(200);

    // The release floor still answers on guardrails.
    const floored = await t.put(
      t.admin.id,
      "secretive",
      guardrail("secretive", { description: "SECRET" })
    );
    expect(floored.statusCode).toBe(403);
    expect(refusalOf(floored).message).toContain("No secret in guardrails");
    expect(await hitsOf("every-write")).toBe(1);
  });
});

describe("a workspace guardrail", () => {
  async function secondWorkspace(t: AppInstance): Promise<CollaborationWorkspaceId> {
    return t.sharedWorkspace("Support");
  }
  const putAppIn = (t: AppInstance, workspaceId: string, name: string, marker: string) =>
    t.call(t.admin.id, "assets.put", {
      params: { kind: "app", name },
      payload: { files: appFiles(marker), workspaceId }
    });

  // Acceptance check 54. Fails without the change: a workspace guardrail reached outside its
  // workspace, by its filter or by where it ran.
  it("narrows only, applies in its workspace alone, and an instance allow does not lift its block", async () => {
    const t = await instance();
    const other = await secondWorkspace(t);
    const forApps = { filter: { kind: "app" }, check: { kind: "pattern", pattern: "Kontonummer" } };

    const outside = await t.put(
      t.admin.id,
      "sales-only",
      guardrail("sales-only", { ...forApps, filter: { kind: "app", workspace: other } }),
      t.workspaceId
    );
    expect(outside.statusCode).toBe(422);
    expect(refusalOf(outside).details?.reason).toBe("guardrail_filter_outside_scope");
    const unknownAgent = await t.put(
      t.admin.id,
      "sales-only",
      guardrail("sales-only", { ...forApps, filter: { kind: "app", agent: "nowhere" } }),
      t.workspaceId
    );
    expect(refusalOf(unknownAgent).details?.reason).toBe("guardrail_filter_outside_scope");

    await t.enforce("sales-only", guardrail("sales-only", forApps), t.workspaceId);
    await t.enforce(
      "instance-allows",
      guardrail("instance-allows", { ...forApps, outcome: "allow" })
    );

    const inSales = await putAppIn(t, t.workspaceId, "offers", "Kontonummer");
    expect(inSales.statusCode).toBe(403);
    expect(refusalOf(inSales).message).toContain("Guardrail 'Guardrail sales-only' blocked");
    const inSupport = await putAppIn(t, other, "tickets", "Kontonummer");
    expect(inSupport.statusCode, inSupport.body).toBe(200);
  });

  // Acceptance check 55 and access acceptance check 31. Fails without the change: publishing
  // a guardrail asked no right of its own, or a workspace's publish rights carried it.
  it("is published only by a holder of guardrail.publish at its scope", async () => {
    const t = await instance();
    const other = await secondWorkspace(t);
    // What the workspace bundles give Kai in Sales once they are built: writing what the
    // workspace owns and publishing it, Apps among it.
    for (const action of ["guardrail.write", "app.publish"]) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: t.kai.id,
        action,
        effect: "allow",
        scopeKind: "workspace",
        scopeId: t.workspaceId,
        grantedBy: t.admin.id
      });
    }
    const written = await t.put(t.kai.id, "kai-rule", guardrail("kai-rule"), t.workspaceId);
    expect(written.statusCode, written.body).toBe(200);
    const refused = await t.publish(t.kai.id, "kai-rule", 1, t.workspaceId);
    expect(refused.statusCode).toBe(403);
    expect(refusalOf(refused).details).toMatchObject({ action: "guardrail.publish" });

    await t.grant(t.kai.id, "guardrail.publish", { workspaceId: t.workspaceId });
    expect((await t.publish(t.kai.id, "kai-rule", 1, t.workspaceId)).statusCode).toBe(200);

    // Elsewhere the grant gives nothing: another workspace, and the instance.
    expect(
      (await t.put(t.admin.id, "support-rule", guardrail("support-rule"), other)).statusCode
    ).toBe(200);
    const inOther = await t.publish(t.kai.id, "support-rule", 1, other);
    expect(refusalOf(inOther).details).toMatchObject({ action: "guardrail.publish" });
    expect((await t.put(t.admin.id, "instance-rule", guardrail("instance-rule"))).statusCode).toBe(
      200
    );
    const atInstance = await t.publish(t.kai.id, "instance-rule", 1);
    expect(refusalOf(atInstance).details).toMatchObject({ action: "guardrail.publish" });
    // Nor does it take a guardrail back elsewhere.
    expect((await t.publish(t.admin.id, "instance-rule", 1)).statusCode).toBe(200);
    const unpublish = await t.call(t.kai.id, "guardrails.unpublish", {
      params: { name: "instance-rule" }
    });
    expect(refusalOf(unpublish).details).toMatchObject({ action: "guardrail.publish" });
  });

  it("is granted for a workspace or the instance, never on one guardrail", async () => {
    const t = await instance();
    expect((await t.put(t.admin.id, "kai-rule", guardrail("kai-rule"))).statusCode).toBe(200);
    const response = await t.call(t.admin.id, "permissions.grant", {
      payload: {
        holderKind: "user",
        holderId: t.kai.id,
        action: "guardrail.publish",
        effect: "allow",
        scopeKind: "asset",
        scopeId: await t.assetId("guardrail", "kai-rule")
      }
    });
    expect(refusalOf(response).details?.reason).toBe("invalid_scope");
  });
});

describe("trying a guardrail before it enforces", () => {
  // Fails without the change: there was no way to try a draft.
  it("tests a draft on sample content and on an asset, and keeps no hit", async () => {
    const t = await instance();
    expect((await t.put(t.admin.id, "draft-iban", guardrail("draft-iban"))).statusCode).toBe(200);
    const sample = await t.expectOk(t.admin.id, "guardrails.test", {
      params: { name: "draft-iban" },
      payload: { sample: { content: `Konto ${IBAN}` } }
    });
    expect(sample.json()).toEqual({
      revision: 1,
      event: "asset.before_write",
      outcome: "block",
      reason: "No bank account here."
    });
    expect((await t.putSkill(`Konto ${IBAN}`, "faq")).statusCode).toBe(200);
    const onAsset = await t.expectOk(t.admin.id, "guardrails.test", {
      params: { name: "draft-iban" },
      payload: { asset: { kind: "skill", name: "faq" } }
    });
    expect(onAsset.json()).toMatchObject({ outcome: "block", appliesToAsset: true });
    expect(await hitsOf("draft-iban")).toBe(0);

    // A field the event does not have is refused; testing asks the write right.
    const unknown = await t.call(t.admin.id, "guardrails.test", {
      params: { name: "draft-iban" },
      payload: { sample: { input: "{}" } }
    });
    expect(refusalOf(unknown).details?.reason).toBe("unknown_field");
    await t.expectRefused(
      t.kai.id,
      "guardrails.test",
      { params: { name: "draft-iban" }, payload: { sample: { content: "x" } } },
      { status: 403, code: "FORBIDDEN" }
    );
  });

  // Acceptance check 57, server side. Fails without the change: there was no dry run, or it
  // named people or kept hits.
  it("counts what a draft would have blocked in the last 14 days, by actions and people, without names", async () => {
    const t = await instance();
    const actor = (userId: string): AuditActor => ({ userId, displayLabel: userId, roles: [] });
    const write = (userId: string, name: string, content: string) =>
      t.stores.configAssets
        .getConfigAsset({ clientInstanceId, kind: "skill", name })
        .then((asset) =>
          t.stores.configAssets.applyConfigAssetMutations({
            clientInstanceId,
            actor: actor(userId),
            baseRevisions: { [`skill:${name}`]: asset?.revision ?? null },
            mutations: [{ type: "upsert", kind: "skill", name, config: skill(name, content) }]
          })
        );
    await write(t.kai.id, "one", `A ${IBAN}`);
    await write(t.kai.id, "one", `B ${IBAN}`);
    await write(t.lena.id, "two", `C ${IBAN}`);
    await write(t.lena.id, "three", "Nothing to see.");
    await write(t.lena.id, "old", `D ${IBAN}`);
    await withTestSql(
      (sql) => sql`
        update config_asset_revisions set created_at = now() - interval '20 days'
        where asset_id = (select id from config_assets
          where client_instance_id = ${clientInstanceId} and kind = 'skill' and name = 'old')`
    );
    expect((await t.put(t.admin.id, "dry-iban", guardrail("dry-iban"))).statusCode).toBe(200);

    const response = await t.expectOk(t.admin.id, "guardrails.dry_run", {
      params: { name: "dry-iban" },
      payload: {}
    });
    const answer = dryRunSchema.parse(response.json());
    expect(answer).toMatchObject({
      revision: 1,
      event: "asset.before_write",
      matched: 4,
      evaluated: 4,
      notEvaluable: 0,
      wouldBlock: { actions: 3, people: 2 },
      wouldWarn: { actions: 0, people: 0 },
      published: false
    });
    for (const named of [t.kai.id, t.lena.id, "Kai", "Lena", IBAN]) {
      expect(response.body).not.toContain(named);
    }
    expect(await hitsOf("dry-iban")).toBe(0);
  });

  it("counts the calls of an operation and cannot check them, since their input is not kept", async () => {
    const t = await instance();
    await t.putSkill("Anything.");
    expect(
      (
        await t.put(
          t.admin.id,
          "calls",
          guardrail("calls", { on: "operation.before_call", filter: { operation: "assets.*" } })
        )
      ).statusCode
    ).toBe(200);
    const answer = dryRunSchema.parse(
      (
        await t.expectOk(t.admin.id, "guardrails.dry_run", {
          params: { name: "calls" },
          payload: {}
        })
      ).json()
    );
    expect(answer.evaluated).toBe(0);
    expect(answer.notEvaluable).toBeGreaterThan(0);
    expect(answer.notEvaluable).toBe(answer.matched);
  });
});

describe("the usage of a guardrail's judge", () => {
  // Acceptance check 57, usage. Fails without the change: a workspace guardrail's judge was
  // counted for the workspace of the event, or for none.
  it("counts for the guardrail's scope: its workspace, or the instance", async () => {
    const t = await instance();
    const workspaceId = asCollaborationWorkspaceId(t.workspaceId);
    const { runner, complete } = runnerOf(t.stores, clientInstanceId, {});
    const judged = (
      scope: { kind: "instance" } | { kind: "workspace"; workspaceId: CollaborationWorkspaceId }
    ) =>
      runner.evaluate(
        {
          guardrail: {
            name: "privacy",
            displayName: "Datenschutz",
            on: "asset.before_write",
            check: {
              kind: "model_judge",
              modelBindingId: judgeBinding.id,
              instruction: "Datenschutz."
            },
            outcome: "warn",
            origin: "asset"
          },
          scope,
          revision: 1
        },
        { name: "faq", content: "Herr Müller ruft an." },
        { correlationId: "corr_usage", userId: t.kai.id }
      );
    expect(await judged({ kind: "workspace", workspaceId })).toMatchObject({
      outcome: "warn",
      origin: "asset",
      scope: { kind: "workspace", workspaceId },
      revision: 1
    });
    await judged({ kind: "instance" });
    expect(complete).toHaveBeenCalledTimes(2);
    const rows = await withTestSql(
      (sql) => sql<{ workspace: string | null; purpose: string | null }[]>`
        select collaboration_workspace_id as workspace, purpose from model_usage_events
        where client_instance_id = ${clientInstanceId} order by created_at`
    );
    expect(rows).toEqual([
      { workspace: workspaceId, purpose: "guardrail_judge" },
      { workspace: null, purpose: "guardrail_judge" }
    ]);
    // A judge's evaluation keeps no hit.
    expect(await hitsOf("privacy")).toBe(0);
  });
});
