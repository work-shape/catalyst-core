import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createGuardrailAssetKind, seedReleaseGuardrails } from "@vivd-catalyst/chat-server";
import {
  clientInstanceId,
  errorSchema,
  recordAuthAdapter,
  setupAccessInstance,
  skill
} from "./support/access-instance";
import { testOperations } from "./support/operations";
import { createTestFetch } from "./support/test-instance";
import { runCli } from "../packages/config-cli/src/index";
import { setupAppInstance } from "./support/app-instance";
import { IBAN, guardedEvents, ibanPattern, noIban } from "./support/guardrails";
import { withTestSql } from "./support/test-sql";
import { PLATFORM_EVENT_ALLOW } from "@vivd-catalyst/core";
import { askBeforeEvents } from "../packages/tool-execution/src/before-events";

// Independent verification of EW-6a (platform PR 67). Each test states the defect it shows;
// the ones marked "sanity" pass and pin behaviour the verifier probed.

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

describe("EW-6a verify: drafts stay inert", () => {
  // Sanity: a newer draft of a published guardrail does not enforce; the published one does.
  it("enforces the published revision and never the newer draft", async () => {
    const t = await instance();
    await t.enforce("rule", guardrail("rule", { check: { kind: "pattern", pattern: "NEVER" } }));
    expect((await t.put("rule", guardrail("rule"))).statusCode).toBe(200);
    expect((await t.putSkill(`Konto ${IBAN}`)).statusCode).toBe(200);
    expect(await hitsOf("rule")).toBe(0);
  });
});

describe("EW-6a verify: no lockout", () => {
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

describe("EW-6a verify: the floor with broken assets", () => {
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

describe("EW-6a verify: what counts as a call about guardrails", () => {
  // DEFECT. `aboutGuardrails` in tool-execution/src/before-events.ts decides by the shape of
  // the input: any operation whose input carries a top-level `kind: "guardrail"`, or `items`
  // all of kind `guardrail`, is taken for a change of guardrails, and no published guardrail
  // runs on it, only the floor. The agent's own `workspace.promote_artifact` takes a free
  // `kind` string, and so may a connection's or a customer tool's operation: with
  // `kind: "guardrail"` the call escapes every published guardrail.
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

describe("EW-6a verify: a release name an asset already holds (open decision 6)", () => {
  // FOLLOW-UP. When a release adds a floor guardrail whose name a guardrail asset holds, the
  // floor runs from release config and records its hits under the shared name, so the hits
  // of the operator's floor show on the asset, a draft that was never published.
  it("does not show the floor's hits on an unpublished asset of the same name", async () => {
    const t = await instance({ pii: noIban({ displayName: "Floor PII" }) });
    // The asset was written before the release that brings the floor rule `pii`.
    await withTestSql(
      (sql) => sql`
        delete from config_assets
        where client_instance_id = ${clientInstanceId} and kind = 'guardrail' and name = 'pii'`
    ).catch(() => undefined);
    const written = await t.put("pii", guardrail("pii", { outcome: "warn" }));
    if (written.statusCode !== 200) {
      // The floor's stored copy holds the name: reproduce the order of an upgrade instead.
      expect(refusalOf(written).details?.reason).toBe("guardrail_release_config_only");
      return;
    }
    const seeded = await seedReleaseGuardrails({
      clientInstanceId,
      guardrails: { pii: noIban({ displayName: "Floor PII" }) },
      stores: t.stores
    });
    expect(seeded.conflicts).toEqual(["pii"]);
    expect((await t.putSkill(`Konto ${IBAN}`)).statusCode).toBe(403);
    const hits = await t.call(t.admin.id, "guardrails.list_hits", { params: { name: "pii" } });
    expect(hits.statusCode, hits.body).toBe(200);
    // The asset `pii` is a draft that never ran; the floor's block is listed under it.
    expect(JSON.stringify(hits.json())).not.toContain("block");
  });
});

describe("EW-6a verify: the CLI's confirmation of a first blocking publish", () => {
  const directories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });

  // DEFECT (check 57). The CLI asks for `--confirm <n>` only where the dry run counted blocked
  // actions. A guardrail on `operation.before_call` is never checked again (its input is not
  // kept), so its dry run says "would have blocked 0" beside N not evaluable, and the CLI
  // publishes it at once, though it blocks every one of those N calls from then on.
  it("does not publish a first blocking guardrail unconfirmed when its dry run could check nothing", async () => {
    const t = await setupAccessInstance({
      furtherKinds: [createGuardrailAssetKind()],
      server: (stores) => ({
        authAdapter: { ...recordAuthAdapter(), credentialMode: "explicit" },
        operations: { events: guardedEvents(stores, {}).events }
      })
    });
    const cwd = await mkdtemp(join(tmpdir(), "ew6a-verify-"));
    directories.push(cwd);
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: skill("faq", "Antworten.") }
    });
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "guardrail", name: "no-puts" },
      payload: {
        config: guardrail("no-puts", {
          on: "operation.before_call",
          filter: { operation: "assets.put" },
          check: { kind: "pattern", pattern: "." }
        })
      }
    });
    const serverFetch = createTestFetch(t.instance, { "x-test-user": t.admin.id });
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      if (new URL(request.url).pathname === testOperations["access_tokens.exchange"].path) {
        return new Response(
          JSON.stringify({
            accessToken: "access-token",
            expiresAt: new Date(Date.now() + 60_000).toISOString()
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return serverFetch(request);
    };
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ["guardrail", "publish", "no-puts", "--revision", "1", "--instance", "https://catalyst.test"],
      {
        cwd,
        env: { CATALYST_API_KEY: "cat_personal" },
        fetchImpl,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text)
      }
    );
    // What it did: published unasked, and the next write of a skill is blocked.
    const blocked = await t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "faq" },
      payload: { config: skill("faq", "Neu.") }
    });
    expect(err.join("")).toContain("would have blocked 0 actions by 0 people");
    expect(blocked.statusCode).toBe(403);
    expect({ code, published: out.join("") }).toMatchObject({ code: 1 });
  });
});
