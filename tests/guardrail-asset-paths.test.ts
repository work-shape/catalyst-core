import { describe, expect, it } from "vitest";
import { DATA_STORE_ASSET_KIND, DATA_STORE_MANIFEST_FILE } from "@vivd-catalyst/core";
import { setupNamespaceHolder } from "./support/asset-operations";
import { clientInstanceId as accessInstanceId, skill } from "./support/access-instance";
import { z } from "zod";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { getTestJobs } from "./support/test-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  clientInstanceId as storeInstanceId,
  useDataStoreInstance
} from "./support/data-store-instance";
import { IBAN, guardedEvents, ibanPattern, judge, noIban } from "./support/guardrails";

// The paths by which content reaches an asset or goes live beside a save and a publish: an
// earlier revision brought back, an App written from a Page, a file that is no text, the
// migrations of a Data Store. Each is asked at its before-event like a save or a publish.

describe("a guardrail on a revert", () => {
  // Fails without the change: a revert wrote the earlier revision back unchecked.
  it("refuses to revert to a revision with an IBAN that was written before the guardrail", async () => {
    const t = await setupNamespaceHolder({
      server: (stores) => ({
        operations: { events: guardedEvents(stores, { no_iban: noIban() }).events }
      })
    });
    // Revision 1 as a release before the guardrail left it: written past every check.
    await applyAtCurrentRevisions(t.stores.configAssets, {
      clientInstanceId: accessInstanceId,
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: "kunden-faq",
          config: skill("kunden-faq", `Überweise an ${IBAN}.`)
        }
      ]
    });
    const put = await t.call(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kunden-faq" },
      payload: {
        config: skill("kunden-faq", "Überweisungen klärt die Buchhaltung."),
        expectedRevision: 1
      }
    });
    expect(put.statusCode).toBe(200);
    const reverted = await t.call(t.admin.id, "assets.revert", {
      params: { kind: "skill", name: "kunden-faq" },
      payload: { revision: 1, expectedRevision: 2 }
    });
    expect(reverted.statusCode).toBe(403);
    expect(reverted.json<{ error: { code: string; message: string } }>().error).toMatchObject({
      code: "GUARDRAIL_BLOCKED",
      message:
        "Guardrail 'No IBAN in skills' blocked skill 'kunden-faq': Skills hold no bank account."
    });
    expect(await t.stored("skill", "kunden-faq")).toMatchObject({
      revision: 2,
      config: { content: "Überweisungen klärt die Buchhaltung." }
    });
    const [hit] = await t.stores.guardrails.listHits({
      clientInstanceId: accessInstanceId,
      guardrailName: "no_iban",
      limit: 1
    });
    expect(hit).toMatchObject({ subjectKind: "skill", subjectName: "kunden-faq" });
    expect(hit?.subjectId).toEqual(expect.any(String));
  });
});

describe("a guardrail on an App written from a Page", () => {
  const noIbanInApps = () =>
    noIban({
      displayName: "No IBAN in Apps",
      filter: { kind: "app" },
      check: { kind: "pattern", pattern: ibanPattern, reason: "Apps hold no bank account." }
    });

  // Fails without the change: an App made or updated from a Page was written past
  // `asset.before_write`, and only its publish was checked, where a rule on writes never ran.
  it("refuses to save a Page with an IBAN as an App, or to write it into one, and writes nothing", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({
        operations: { events: guardedEvents(stores, { no_iban: noIbanInApps() }).events }
      })
    });
    try {
      const create = (page: { conversationId: string; pageId: string }) =>
        t.call(t.admin.id, "apps.create_from_page", {
          payload: { ...page, name: "offers", title: "Offers", workspaceId: t.workspaceId }
        });
      const marked = await t.storePage(`Konto ${IBAN}`);
      const refused = await create(marked);
      expect(refused.statusCode).toBe(403);
      expect(refused.json<{ error: { code: string; message: string } }>().error).toMatchObject({
        code: "GUARDRAIL_BLOCKED",
        message: "Guardrail 'No IBAN in Apps' blocked app 'offers': Apps hold no bank account."
      });
      const stored = () =>
        t.stores.configAssets.getConfigAsset({
          clientInstanceId: accessInstanceId,
          kind: "app",
          name: "offers"
        });
      expect(await stored()).toBeUndefined();

      const clean = await t.storePage("Angebot ohne Konto");
      expect((await create(clean)).statusCode).toBe(200);
      // The Page's next revision has the IBAN: writing it into the App is refused.
      await t.storePage(`Konto ${IBAN}`, {}, { conversationId: clean.conversationId });
      const updated = await t.call(t.admin.id, "apps.update_from_page", {
        params: { app: "offers" },
        payload: { ...clean, workspaceId: t.workspaceId, expectedRevision: 1 }
      });
      expect(updated.statusCode).toBe(403);
      expect(await stored()).toMatchObject({ revision: 1 });
      const found = await t.stores.guardrails.listHits({
        clientInstanceId: accessInstanceId,
        guardrailName: "no_iban",
        limit: 5
      });
      expect(found.map((hit) => [hit.event, hit.subjectKind, hit.subjectName])).toEqual([
        ["asset.before_write", "app", "offers"],
        ["asset.before_write", "app", "offers"]
      ]);
      expect(JSON.stringify(found)).not.toContain("3704");
    } finally {
      await t.close();
    }
  });

  // Fails without the change: the guardrails read the Page before anything asked whether the
  // caller reads it, so a refusal told a writer of the App what a Page they cannot read holds.
  it("reads no Page the caller cannot read", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({
        operations: { events: guardedEvents(stores, { no_iban: noIbanInApps() }).events }
      })
    });
    try {
      const page = await t.storePage("Angebot ohne Konto");
      expect(
        (
          await t.call(t.admin.id, "apps.create_from_page", {
            payload: { ...page, name: "offers", title: "Offers", workspaceId: t.workspaceId }
          })
        ).statusCode
      ).toBe(200);
      await t.storePage(`Konto ${IBAN}`, {}, { conversationId: page.conversationId });
      await t.stores.access.createGrant({
        clientInstanceId: accessInstanceId,
        holderKind: "user",
        holderId: t.lena.id,
        action: "app.write",
        effect: "allow",
        scopeKind: "workspace",
        scopeId: t.workspaceId,
        grantedBy: t.admin.id
      });
      const refused = await t.call(t.lena.id, "apps.update_from_page", {
        params: { app: "offers" },
        payload: { ...page, workspaceId: t.workspaceId, expectedRevision: 1 }
      });
      expect(refused.statusCode).toBe(404);
      expect(
        await t.stores.guardrails.listHits({
          clientInstanceId: accessInstanceId,
          guardrailName: "no_iban",
          limit: 5
        })
      ).toEqual([]);
    } finally {
      await t.close();
    }
  });
});

describe("a guardrail that holds an App written from a Page", () => {
  // Fails without the change: after the approval the call read the Page's newest revision
  // again, so a revision saved while the guardrails were asked once more was copied unread.
  it("copies the revision the guardrails read when the approved call is asked again", async () => {
    let t: AppInstance | undefined;
    let page: { conversationId: string; pageId: string } | undefined;
    let asked = 0;
    t = await setupAppInstance({
      server: (stores) => {
        const guarded = guardedEvents(stores, {
          held: { ...judge("asset.before_write", "require_approval"), filter: { kind: "app" } }
        });
        guarded.complete.mockImplementation(async () => {
          asked += 1;
          // Asked again after the approval: the Page is saved anew while the judge reads.
          if (asked === 2 && page) {
            await t?.storePage("third revision", {}, { conversationId: page.conversationId });
          }
          return {
            text: JSON.stringify({ violates: asked === 1, reason: "Needs a look." }),
            toolCalls: [],
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              source: "provider_reported",
              webSearchCallCount: 0
            }
          };
        });
        return { operations: { events: guarded.events } };
      }
    });
    try {
      page = await t.storePage("first revision");
      const held = await t.call(t.admin.id, "apps.create_from_page", {
        payload: { ...page, name: "offers", title: "Offers", workspaceId: t.workspaceId }
      });
      const { approvalRequestId } = z
        .object({ status: z.literal("pending_approval"), approvalRequestId: z.string() })
        .parse(held.json());
      // The Page changes while the call waits; the approval is asked again before it runs.
      await t.storePage("second revision", {}, { conversationId: page.conversationId });
      expectStatus(
        await t.call(t.admin.id, "approval_requests.decide", {
          params: { requestId: approvalRequestId },
          payload: { decision: "approve" }
        }),
        200
      );
      await getTestJobs(t.instance).runDue();
      expect(asked).toBe(2);
      const asset = await t.stores.configAssets.getConfigAsset({
        clientInstanceId: accessInstanceId,
        kind: "app",
        name: "offers"
      });
      const origin =
        asset &&
        (await t.stores.configAssets.getConfigAssetPageOrigin({
          clientInstanceId: accessInstanceId,
          assetId: asset.id
        }));
      // Read when asked again: the second revision. The third came while it was read.
      expect(origin?.fileSetNumber).toBe(2);
    } finally {
      await t?.close();
    }
  });
});

describe("a guardrail on a file that is no text", () => {
  const bytes = (path: string, content: Uint8Array) => ({
    path,
    base64: Buffer.from(content).toString("base64")
  });
  // A PNG's signature and the start of its header: not UTF-8, and it holds NUL bytes.
  const image = bytes(
    "logo.png",
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d])
  );

  // Fails without the change: a file that is no text was left out of what a pattern read, so
  // an IBAN beside a NUL byte was saved unread.
  it("finds a match in the bytes of a file that is no text", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({
        operations: {
          events: guardedEvents(stores, {
            no_iban: noIban({ displayName: "No IBAN in assets", filter: undefined })
          }).events
        }
      })
    });
    try {
      const hidden = bytes(
        "notes.bin",
        new Uint8Array([0, ...Buffer.from(`Konto ${IBAN}`, "latin1"), 0xff])
      );
      const put = await t.putApp(t.admin.id, "offers", [...appFiles("Angebot"), hidden]);
      expect(put.statusCode).toBe(403);
      expect(put.json<{ error: { message: string } }>().error.message).toBe(
        "Guardrail 'No IBAN in assets' blocked app 'offers': Skills hold no bank account."
      );
    } finally {
      await t.close();
    }
  });

  // Fails without the change: a judge was handed the text alone, as if an unknown binary file
  // were not there.
  it("lets a judge pass an image and refuses to publish a file it cannot judge", async () => {
    // How often a judge was asked: once for each publish whose files it can read.
    let judged = 0;
    const t = await setupAppInstance({
      server: (stores) => {
        const guarded = guardedEvents(stores, {
          judged: {
            displayName: "Judged",
            on: "app.before_publish",
            check: {
              kind: "model_judge",
              modelBindingId: "guardrailCheck",
              instruction: "Datenschutz."
            },
            outcome: "block"
          }
        });
        guarded.complete.mockImplementation(async () => {
          judged += 1;
          return {
            text: '{"violates":false,"reason":"Fine."}',
            toolCalls: [],
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              totalTokens: 2,
              source: "provider_reported",
              webSearchCallCount: 0
            }
          };
        });
        return { operations: { events: guarded.events } };
      }
    });
    try {
      expect(
        (await t.putApp(t.admin.id, "offers", [...appFiles("Angebot"), image])).statusCode
      ).toBe(200);
      const offers = await t.publish(t.admin.id, "offers", 1);
      expect(offers.statusCode, offers.body).toBe(200);
      expect(judged).toBe(1);

      const archive = bytes("archive.bin", new Uint8Array([0, 1, 2, 0xff]));
      expect(
        (await t.putApp(t.admin.id, "archive", [...appFiles("Archiv"), archive])).statusCode
      ).toBe(200);
      const published = await t.publish(t.admin.id, "archive", 1);
      expect(published.statusCode).toBe(403);
      // Nothing about it is temporary: it is not told to try again.
      expect(published.json<{ error: { message: string } }>().error.message).toBe(
        "Guardrail 'Judged' blocked app 'archive': Check 'judged' could not judge a file that is no text."
      );
      expect(judged).toBe(1);
      expect((await t.listed("archive")).publishedRevision).toBeUndefined();
    } finally {
      await t.close();
    }
  });
});

describe("a guardrail before a Data Store is published", () => {
  const { start, put, publish } = useDataStoreInstance();

  // Fails without the change: `data_store.before_publish` was no event, and the migrations of
  // the revision were applied unread.
  it("refuses to publish a store whose migrations match, and applies none of them", async () => {
    const world = await start(true, undefined, undefined, {
      no_iban_in_stores: {
        displayName: "No IBAN in Data Stores",
        on: "data_store.before_publish",
        check: { kind: "pattern", pattern: ibanPattern, reason: "Stores hold no bank account." },
        outcome: "block"
      }
    });
    const marked = [
      { path: DATA_STORE_MANIFEST_FILE, text: "id: findings\nname: Findings\n" },
      {
        path: "migrations/0001_init.sql",
        text: `-- Konto ${IBAN}\ncreate table findings (run_id text not null);`
      }
    ];
    expect((await put(world, marked)).statusCode).toBe(200);
    const published = await publish(world, 1);
    expect(published.statusCode).toBe(403);
    expect(published.json<{ error: { message: string } }>().error.message).toBe(
      "Guardrail 'No IBAN in Data Stores' blocked data_store 'findings': Stores hold no bank account."
    );
    const [hit] = await world.stores.guardrails.listHits({
      clientInstanceId: storeInstanceId,
      guardrailName: "no_iban_in_stores",
      limit: 1
    });
    expect(hit).toMatchObject({
      event: "data_store.before_publish",
      subjectKind: DATA_STORE_ASSET_KIND,
      subjectName: "findings"
    });
    const stored = await world.stores.configAssets.getConfigAsset({
      clientInstanceId: storeInstanceId,
      kind: DATA_STORE_ASSET_KIND,
      name: "findings"
    });
    expect(stored).toMatchObject({ revision: 1 });
    expect(stored?.publishedRevision).toBeUndefined();
  });
});
