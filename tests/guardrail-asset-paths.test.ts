import { describe, expect, it } from "vitest";
import { DATA_STORE_ASSET_KIND, DATA_STORE_MANIFEST_FILE } from "@vivd-catalyst/core";
import { setupNamespaceHolder } from "./support/asset-operations";
import { clientInstanceId as accessInstanceId, skill } from "./support/access-instance";
import { appFiles, setupAppInstance } from "./support/app-instance";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  clientInstanceId as storeInstanceId,
  useDataStoreInstance
} from "./support/data-store-instance";
import { IBAN, guardedEvents, ibanPattern, noIban } from "./support/guardrails";

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

describe("a guardrail on a file that is no text", () => {
  // A PNG's signature and the start of its header: not UTF-8, and it holds NUL bytes.
  const image = {
    path: "logo.png",
    base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString(
      "base64"
    )
  };

  // Fails without the change: a file that is no text was left out of what the guardrails read,
  // so the App was checked as if it had no such file, and nothing warned or blocked.
  it("warns on a write and refuses a publish where a guardrail cannot read a file", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({
        operations: {
          events: guardedEvents(stores, {
            unread_warns: noIban({
              displayName: "Unread warns",
              filter: undefined,
              outcome: "warn"
            }),
            unread_blocks: noIban({
              displayName: "Unread blocks",
              on: "app.before_publish",
              filter: undefined
            })
          }).events
        }
      })
    });
    try {
      expect(
        (await t.putApp(t.admin.id, "offers", [...appFiles("Angebot"), image])).statusCode
      ).toBe(200);
      const [warned] = await t.stores.guardrails.listHits({
        clientInstanceId: accessInstanceId,
        guardrailName: "unread_warns",
        limit: 5
      });
      expect(warned).toMatchObject({
        event: "asset.before_write",
        outcome: "warn",
        subjectName: "offers"
      });
      const published = await t.publish(t.admin.id, "offers", 1);
      expect(published.statusCode).toBe(403);
      expect(published.json<{ error: { message: string } }>().error.message).toBe(
        "Guardrail 'Unread blocks' blocked app 'offers': Check 'unread_blocks' could not read content that is too large or is no text. Try again later."
      );
      expect((await t.listed("offers")).publishedRevision).toBeUndefined();
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
