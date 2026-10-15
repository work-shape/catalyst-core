import { describe, expect, it } from "vitest";
import { z } from "zod";
import { deriveAppContentKey, storePageFileSet } from "@work-shape/catalyst-server";
import { asConversationId } from "@work-shape/catalyst-core";
import { clientInstanceId as accessInstanceId } from "./support/access-instance";
import { appFiles, setupAppInstance, type AppInstance } from "./support/app-instance";
import { IBAN, guardedEvents, ibanPattern, judge, noIban } from "./support/guardrails";

// Verifier's third round on PR 47 (GR-2b): what the printable runs and the UTF-16 reading of
// files that are no text leave open.

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

describe("GR-2b r3: a judge on text inside an image", () => {
  // A judge reads printable runs of at least 16 characters, and a newline ends a run. A list
  // of names and phone numbers, one per line as any CSV or text holds them, has no line that
  // long: put behind a PNG signature, none of it reaches the judge.
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
});

describe("GR-2b r3: UTF-16 text without a byte order mark", () => {
  // UTF-16 without a BOM (what many APIs and some editors write) holds a NUL beside every
  // ASCII character. It is read as printable runs, each one character long, so a pattern
  // reads nothing of it, and the IBAN passes a block rule.
  it("finds an IBAN in a UTF-16LE file without a byte order mark", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({ operations: { events: guardedEvents(stores, demoRules).events } })
    });
    try {
      const export16 = bytes(
        "accounts.csv",
        new Uint8Array(Buffer.from(`name;iban\nMax;${IBAN}\n`, "utf16le"))
      );
      const put = await t.putApp(t.admin.id, "offers", [...appFiles("Angebot"), export16]);
      expect(put.statusCode, put.body).toBe(403);
    } finally {
      await t.close();
    }
  });
});

describe("GR-2b r3: a Page with several photos becomes an App", () => {
  // `fileSetText` refuses a set whose source files have more than 8 MiB before reading
  // anything (`GUARDRAIL_CHECKED_FIELD_MAX_CHARS * 4`, "a character is at least one byte").
  // That held while every byte was text; a photo now adds next to no characters. A Page holds
  // 25 MB, so five photos of 1.9 MB, under the 2 MB a file may have, are refused as too
  // large under the demo's IBAN rule.
  it("saves a Page with 9.5 MB of photos and no IBAN as an App", async () => {
    let t: AppInstance | undefined;
    t = await setupAppInstance({
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
      const photos = [1, 2, 3, 4, 5].map((index) => ({
        path: `photo-${index}.png`,
        bytes: photoBytes(1_900_000)
      }));
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
            ...photos
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
      await t?.close();
    }
  });
});
