import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGuardrailAssetKind } from "@vivd-catalyst/chat-server";
import { PLATFORM_EVENT_ALLOW } from "@vivd-catalyst/core";
import { askBeforeEvents } from "@vivd-catalyst/tool-execution";
import { clientInstanceId, errorSchema, skill } from "./support/access-instance";
import { setupAppInstance } from "./support/app-instance";
import { IBAN, guardedEvents, ibanPattern, noIban } from "./support/guardrails";
import { withTestSql } from "./support/test-sql";

// The boundaries of guardrails written as assets (EW-6a), from the independent verification
// of platform PR 67: a newer draft stays inert, no published guardrail locks the change of
// guardrails, a broken asset leaves the floor answering, and only the operations on guardrails
// themselves, never an input that names the kind, skip the published guardrails.

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

async function instance(floor: Record<string, unknown> = {}) {
  const t = await setupAppInstance({
    furtherKinds: [createGuardrailAssetKind()],
    server: (stores) => ({ operations: { events: guardedEvents(stores, floor).events } })
  });
  const put = (name: string, config: Record<string, unknown>, workspaceId?: string) =>
    t.call(t.admin.id, "assets.put", {
      params: { kind: "guardrail", name },
      payload: { config, ...(workspaceId === undefined ? {} : { workspaceId }) }
    });
  const publish = (name: string, revision: number, workspaceId?: string) =>
    t.call(t.admin.id, "assets.publish", {
      params: { kind: "guardrail", name },
      payload: { revision, ...(workspaceId === undefined ? {} : { workspaceId }) }
    });
  const putSkill = (content: string, name = "kunden-faq") =>
    t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name },
      payload: { config: skill(name, content) }
    });
  const enforce = async (name: string, config: Record<string, unknown>) => {
    const written = await put(name, config);
    expect(written.statusCode, written.body).toBe(200);
    const { revision } = writtenSchema.parse(written.json());
    const published = await publish(name, revision);
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

describe("guardrail assets: drafts stay inert", () => {
  // Sanity: a newer draft of a published guardrail does not enforce; the published one does.
  it("enforces the published revision and never the newer draft", async () => {
    const t = await instance();
    await t.enforce("rule", guardrail("rule", { check: { kind: "pattern", pattern: "NEVER" } }));
    expect((await t.put("rule", guardrail("rule"))).statusCode).toBe(200);
    expect((await t.putSkill(`Konto ${IBAN}`)).statusCode).toBe(200);
    expect(await hitsOf("rule")).toBe(0);
  });
});

describe("guardrail assets: no lockout", () => {
  // Sanity: a published guardrail that blocks every call of every operation leaves the
  // guardrail screens and the unpublish working.
  it("leaves listing, hits, unpublish and delete of guardrails open under a block-all call guardrail", async () => {
    const t = await instance();
    await t.enforce(
      "block-all",
      guardrail("block-all", {
        on: "operation.before_call",
        filter: undefined,
        check: { kind: "pattern", pattern: "." }
      })
    );
    expect((await t.putSkill("x")).statusCode).toBe(403);
    const listed = await t.call(t.admin.id, "assets.list", { params: { kind: "guardrail" } });
    expect(listed.statusCode, listed.body).toBe(200);
    const hits = await t.call(t.admin.id, "guardrails.list_hits", {
      params: { name: "block-all" }
    });
    expect(hits.statusCode, hits.body).toBe(200);
    const off = await t.call(t.admin.id, "guardrails.unpublish", { params: { name: "block-all" } });
    expect(off.statusCode, off.body).toBe(200);
    expect((await t.putSkill("x")).statusCode).toBe(200);
  });
});

describe("guardrail assets: the floor with broken assets", () => {
  // Sanity: a published guardrail whose stored definition no longer parses is skipped, and the
  // release floor still answers.
  it("still runs the release floor when a published guardrail asset is corrupt", async () => {
    const t = await instance({ floor_iban: noIban({ displayName: "Floor" }) });
    await t.enforce("broken", guardrail("broken", { check: { kind: "pattern", pattern: "x" } }));
    await withTestSql(
      (sql) => sql`
        update config_asset_revisions set config = '{"bogus": true}'::jsonb
        where asset_id = (select id from config_assets
          where client_instance_id = ${clientInstanceId} and kind = 'guardrail' and name = 'broken')`
    );
    const blocked = await t.putSkill(`Konto ${IBAN}`);
    expect(blocked.statusCode).toBe(403);
    expect(refusalOf(blocked).message).toContain("Guardrail 'Floor' blocked");
    // Any other write is refused while a stored definition is corrupt: the asset set is
    // validated whole on every write, as for every kind before EW-6a.
    const other = await t.putSkill("x marks");
    expect(refusalOf(other).code).toBe("VALIDATION_FAILED");
  });
});

describe("guardrail assets: what counts as a call about guardrails", () => {
  // Fails without the fix: the call was taken for one about guardrails by the shape of its
  // input, so an operation whose input named `kind: "guardrail"`, as the agent's own
  // `workspace.promote_artifact` may, escaped every published guardrail.
  const askedAbout = async (operation: string, input: unknown) => {
    const asked: (boolean | undefined)[] = [];
    await askBeforeEvents({
      definition: { name: operation },
      call: { input, origin: { kind: "user" } },
      emit: (_name, _phase, _payload, before) => {
        asked.push(before?.aboutGuardrails);
        return Promise.resolve(PLATFORM_EVENT_ALLOW);
      }
    });
    return asked;
  };

  it("asks published guardrails about an operation that only names the kind guardrail in its input", async () => {
    // Sanity: the asset operations on guardrails are about guardrails.
    expect(await askedAbout("assets.put", { kind: "guardrail", name: "x" })).toEqual([true]);
    expect(await askedAbout("crm.records.create", { kind: "lead", text: "IBAN" })).toEqual([
      undefined
    ]);
    // The defect: a platform tool whose free `kind` the agent chooses, and a customer
    // operation, with the value an agent may choose.
    expect(
      await askedAbout("workspace.promote_artifact", { path: "out/report.md", kind: "guardrail" })
    ).toEqual([undefined]);
    expect(await askedAbout("crm.records.create", { kind: "guardrail", text: "IBAN" })).toEqual([
      undefined
    ]);
    expect(
      await askedAbout("connection.books.import", { items: [{ kind: "guardrail", row: 1 }] })
    ).toEqual([undefined]);
  });
});
