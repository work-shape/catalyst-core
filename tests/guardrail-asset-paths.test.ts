import { describe, expect, it } from "vitest";
import {
  DATA_STORE_ASSET_KIND,
  DATA_STORE_MANIFEST_FILE,
  asConversationId
} from "@work-shape/catalyst-core";
import { deriveAppContentKey, storePageFileSet } from "@work-shape/catalyst-server";
import { setupWorkspaceHolder } from "./support/asset-operations";
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

// The verifier's regressions of PR 47 (GR-2b) live here too: photos, disguised images,
// UTF-16 and Apps of another workspace.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const text = (value: string) => new TextEncoder().encode(value);
const bytes = (path: string, content: Uint8Array) => ({
  path,
  base64: Buffer.from(content).toString("base64")
});

/** A PNG-signed file of `size` bytes that holds no text: its signature, then binary noise. */
function photoBytes(size: number): Uint8Array {
  const content = new Uint8Array(size);
  content.set(PNG);
  // Bytes that are no printable text and hold no digit run an IBAN pattern could match.
  for (let index = PNG.length; index < size; index += 1) content[index] = 0x80 + (index % 0x7f);
  return content;
}

const verdict = (violates: boolean) => ({
  text: JSON.stringify({ violates, reason: "Needs a look." }),
  toolCalls: [],
  usage: {
    inputTokens: 1,
    outputTokens: 1,
    totalTokens: 2,
    source: "provider_reported" as const,
    webSearchCallCount: 0
  }
});

/** The demo's two IBAN rules (clients/demo/config/app.yaml): block, no `filter.kind`. */
const demoRules = {
  no_iban_in_assets: noIban({
    displayName: "No IBAN in assets",
    filter: undefined,
    check: { kind: "pattern", pattern: ibanPattern, reason: "Assets hold no IBAN." }
  }),
  no_iban_in_apps: noIban({
    displayName: "No IBAN in published Apps",
    on: "app.before_publish",
    filter: undefined,
    check: { kind: "pattern", pattern: ibanPattern, reason: "Apps hold no IBAN." }
  })
};

describe("a guardrail on a revert", () => {
  // Fails without the change: a revert wrote the earlier revision back unchecked.
  it("refuses to revert to a revision with an IBAN that was written before the guardrail", async () => {
    const t = await setupWorkspaceHolder({
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
        message: "Guardrail 'No IBAN in Apps' blocked app 'Offers': Apps hold no bank account."
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
      expect(JSON.stringify(found)).not.toContain("3704 0044");
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
  // again, so a revision nobody was asked about was copied. The held call keeps the revision
  // its guardrails read, and the call asked again reads and copies that one.
  it("copies the revision the approval was asked about, whatever the Page is saved as meanwhile", async () => {
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
          return verdict(asked === 1);
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
      // The revision the approval was asked about. The second and the third came later.
      expect(origin?.fileSetNumber).toBe(1);
    } finally {
      await t?.close();
    }
  });

  // GR-2b: the guardrails read the Page's newest revision, and execute read it again and
  // copied a revision saved in between, unread.
  it("never copies a Page revision that no guardrail read", async () => {
    let t: AppInstance | undefined;
    let conversationId: string | undefined;
    let complete: ReturnType<typeof guardedEvents>["complete"] | undefined;
    t = await setupAppInstance({
      server: (stores) => {
        const guarded = guardedEvents(stores, {
          no_iban: noIban({
            displayName: "No IBAN in Apps",
            filter: { kind: "app" },
            check: { kind: "pattern", pattern: ibanPattern, reason: "Apps hold no IBAN." }
          }),
          privacy: { ...judge("asset.before_write", "block"), filter: { kind: "app" } }
        });
        complete = guarded.complete;
        return { operations: { events: guarded.events } };
      }
    });
    try {
      const clean = await t.storePage("Angebot ohne Konto");
      conversationId = clean.conversationId;
      complete?.mockImplementation(async () => {
        // The Page is saved again while the judge reads revision 1.
        await t?.storePage(`Konto ${IBAN}`, {}, { conversationId });
        return verdict(false);
      });
      const created = await t.call(t.admin.id, "apps.create_from_page", {
        payload: { ...clean, name: "offers", title: "Offers", workspaceId: t.workspaceId }
      });
      // Either the write is refused, or what it wrote is what the guardrails read.
      if (created.statusCode === 200) {
        const asset = await t.stores.configAssets.getConfigAsset({
          clientInstanceId: accessInstanceId,
          kind: "app",
          name: "offers"
        });
        const origin = asset
          ? await t.stores.configAssets.getConfigAssetPageOrigin({
              clientInstanceId: accessInstanceId,
              assetId: asset.id
            })
          : undefined;
        expect(origin?.fileSetNumber).toBe(1);
      } else {
        expect(created.statusCode).toBe(409);
      }
    } finally {
      await t.close();
    }
  });
});

describe("a guardrail on a file that is no text", () => {
  // A PNG's signature and the start of its header: not UTF-8, and it holds NUL bytes.
  const image = bytes("logo.png", new Uint8Array([...PNG, 0, 0, 0, 0x0d]));

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
        "Guardrail 'No IBAN in assets' blocked the action: Skills hold no bank account."
      );
    } finally {
      await t.close();
    }
  });

  // Fails without the change: UTF-16 without a byte order mark was read as text only where
  // every other byte of its start was NUL, so one letter outside Latin-1 ('Ł' is 0x41 0x01 in
  // UTF-16LE) left it printable runs of one character, and the IBAN passed.
  it("reads UTF-16 without a byte order mark as text, also with a letter outside Latin-1", async () => {
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
      const csv = `name;iban\nŁukasz;${IBAN}\n`;
      const littleEndian = bytes("accounts.csv", new Uint8Array(Buffer.from(csv, "utf16le")));
      const bigEndian = bytes("accounts.csv", new Uint8Array(Buffer.from(csv, "utf16le").swap16()));
      // GR-2b r2: a Windows export, UTF-16LE with a byte order mark.
      const marked = bytes(
        "accounts.csv",
        new Uint8Array([0xff, 0xfe, ...Buffer.from(csv, "utf16le")])
      );
      for (const [name, file] of [
        ["offers", littleEndian],
        ["archive", bigEndian],
        ["export", marked]
      ] as const) {
        const put = await t.putApp(t.admin.id, name, [...appFiles("Angebot"), file]);
        expect(put.statusCode, put.body).toBe(403);
      }

      // An image's NUL bytes sit at even and odd offsets alike: it stays a file of printable
      // runs, which hold no IBAN.
      const dark = new Uint8Array(4096);
      dark.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44]);
      // Rows of a mostly black image: a filter byte, then zero pixels, with sparse colour.
      for (let index = 16; index < dark.length; index += 2) {
        dark[index + 1] = index % 64 === 0 ? 7 : 0;
      }
      const put = await t.putApp(t.admin.id, "photos", [
        ...appFiles("Angebot"),
        bytes("dark.png", dark)
      ]);
      expect(put.statusCode, put.body).toBe(200);
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
          return verdict(false);
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
        "Guardrail 'Judged' blocked app 'Offers': Check 'judged' could not judge a file that is no text."
      );
      expect(judged).toBe(1);
      expect((await t.listed("archive")).publishedRevision).toBeUndefined();
    } finally {
      await t.close();
    }
  });

  // GR-2b r2: a photo read as Latin-1 for a pattern was refused as too large to read, and a
  // judge refused a set of photos over 2 MiB before it was asked.
  it("saves and publishes an App with 2.5 MB of photos under the demo's rules and a judge", async () => {
    let judged = 0;
    const t = await setupAppInstance({
      server: (stores) => {
        const guarded = guardedEvents(stores, {
          ...demoRules,
          privacy: { ...judge("asset.before_write", "block"), displayName: "Privacy" }
        });
        guarded.complete.mockImplementation(async () => {
          judged += 1;
          return verdict(false);
        });
        return { operations: { events: guarded.events } };
      }
    });
    try {
      const put = await t.putApp(t.admin.id, "offers", [
        ...appFiles("Angebot"),
        bytes("hero.png", photoBytes(1_250_000)),
        bytes("team.png", photoBytes(1_250_000))
      ]);
      expect(put.statusCode, put.body).toBe(200);
      expect(judged).toBe(1);
      const published = await t.publish(t.admin.id, "offers", 1);
      expect(published.statusCode, published.body).toBe(200);
    } finally {
      await t.close();
    }
  });

  // GR-2b r2/r3: a file that only starts like an image, with short lines of text after it.
  it("hands a judge the lines of a list put into a file that starts like an image", async () => {
    const seen: string[] = [];
    const t = await setupAppInstance({
      server: (stores) => {
        const guarded = guardedEvents(stores, {
          privacy: { ...judge("asset.before_write", "block"), displayName: "Privacy" }
        });
        guarded.complete.mockImplementation(async (request) => {
          seen.push(JSON.stringify(request));
          return verdict(false);
        });
        return { operations: { events: guarded.events } };
      }
    });
    try {
      const disguised = bytes(
        "people.png",
        new Uint8Array([
          ...PNG,
          ...text("Max Mustermann\n0171 2345678\nErika Muster\n030 9876543\nDiagnose F32\n")
        ])
      );
      const put = await t.putApp(t.admin.id, "offers", [...appFiles("Angebot"), disguised]);
      if (put.statusCode === 200) {
        expect(seen.join("\n")).toContain("Mustermann");
      } else {
        expect(put.statusCode).toBe(403);
      }
    } finally {
      await t.close();
    }
  });

  // GR-2b r3: a set over 8 MiB was refused before reading, though photos add next to no text.
  it("saves a Page with 9.5 MB of photos and no IBAN as an App", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({ operations: { events: guardedEvents(stores, demoRules).events } })
    });
    try {
      const { id: conversationId } = z
        .object({ id: z.string() })
        .parse(
          (
            await t.expectOk(t.admin.id, "conversations.create", { payload: { title: "Offers" } })
          ).json()
        );
      const manifest = { id: "offers-page", name: "Offers", kit: "1.0.0", entry: "index.html" };
      const html = text("<!doctype html><title>Offers</title><p>Angebot</p>");
      const stored = await storePageFileSet(
        {
          clientInstanceId: accessInstanceId,
          stores: t.stores,
          pages: {
            objects: t.objects,
            contentKey: deriveAppContentKey("content-secret-".repeat(4))
          }
        },
        {
          conversationId: asConversationId(conversationId),
          pageName: "Offers",
          kitVersion: "1.0.0",
          manifest,
          sourceFiles: [
            { path: "app.yaml", bytes: text(JSON.stringify(manifest)) },
            { path: "index.html", bytes: html },
            ...[1, 2, 3, 4, 5].map((index) => ({
              path: `photo-${index}.png`,
              bytes: photoBytes(1_900_000)
            }))
          ],
          builtFiles: [{ path: "index.html", bytes: html }]
        }
      );
      const created = await t.call(t.admin.id, "apps.create_from_page", {
        payload: {
          conversationId,
          pageId: stored.page.id,
          name: "offers",
          title: "Offers",
          workspaceId: t.workspaceId
        }
      });
      expect(created.statusCode, created.body).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe("a guardrail on an App of another workspace named in a revert or a publish", () => {
  // GR-2b: the before-events read the revision by kind and name alone, so a writer of
  // workspace A had B's App read, judged and named. It is now refused as a name of no App.
  it("reads no revision of it and answers as for the name of no App", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({
        operations: {
          events: guardedEvents(stores, {
            on_write: noIban({
              displayName: "IBAN on write",
              filter: { kind: "app" },
              check: { kind: "pattern", pattern: ibanPattern, reason: "Apps hold no IBAN." },
              outcome: "warn"
            }),
            on_publish: noIban({
              displayName: "IBAN on publish",
              on: "app.before_publish",
              filter: undefined,
              check: { kind: "pattern", pattern: ibanPattern, reason: "Apps hold no IBAN." }
            })
          }).events
        }
      })
    });
    try {
      // Workspace B's App, with an IBAN in its draft.
      expect((await t.putApp(t.admin.id, "payroll", appFiles(`Konto ${IBAN}`))).statusCode).toBe(
        200
      );
      const hits = async (name: string) =>
        (
          await t.stores.guardrails.listHits({
            clientInstanceId: accessInstanceId,
            guardrailName: name,
            limit: 10
          })
        ).length;
      const writeHitsBefore = await hits("on_write");
      // Lena reads, writes and publishes Apps in workspace A only.
      const other = await t.sharedWorkspace("A");
      for (const action of ["app.read", "app.write", "app.publish"]) {
        await t.stores.access.createGrant({
          clientInstanceId: accessInstanceId,
          holderKind: "user",
          holderId: t.lena.id,
          action,
          effect: "allow",
          scopeKind: "workspace",
          scopeId: other,
          grantedBy: t.admin.id
        });
      }
      const answer = async (operation: "assets.revert" | "assets.publish", name: string) => {
        const response = await t.call(t.lena.id, operation, {
          params: { kind: "app", name },
          payload:
            operation === "assets.revert"
              ? { revision: 1, expectedRevision: 1, workspaceId: other }
              : { revision: 1, workspaceId: other }
        });
        const { error } = response.json<{ error: { code: string; message: string } }>();
        return {
          status: response.statusCode,
          code: error.code,
          message: error.message.replaceAll(name, "<name>")
        };
      };
      for (const operation of ["assets.revert", "assets.publish"] as const) {
        expect(await answer(operation, "payroll"), operation).toEqual(
          await answer(operation, "nobody-holds-this")
        );
      }
      expect(await hits("on_write")).toBe(writeHitsBefore);
      expect(await hits("on_publish")).toBe(0);
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
      "Guardrail 'No IBAN in Data Stores' blocked data store 'Findings': Stores hold no bank account."
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
