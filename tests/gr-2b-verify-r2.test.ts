import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clientInstanceId as accessInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { IBAN, guardedEvents, ibanPattern, judge, noIban } from "./support/guardrails";
import { getTestJobs } from "./support/test-instance";

// Verifier's second round on PR 47 (GR-2b): failing tests for what the fixes leave open, and
// checks that they hold where they claim to.

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const bytes = (path: string, content: Uint8Array) => ({
  path,
  base64: Buffer.from(content).toString("base64")
});

/** A PNG-signed file of `size` bytes that holds no text: its signature, then binary noise. */
function photo(path: string, size: number) {
  const content = new Uint8Array(size);
  content.set(PNG);
  // Bytes that are no printable text and hold no digit run an IBAN pattern could match.
  for (let index = PNG.length; index < size; index += 1) content[index] = 0x80 + (index % 0x7f);
  return bytes(path, content);
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

describe("GR-2b r2: a photo in an App", () => {
  // The fix reads an image's bytes as Latin-1 for a pattern, one character per byte. The demo's
  // IBAN pattern reads at most 1,111,111 characters (40M steps / its program), so a photo of
  // 1.2 MB, which is no rare size for a hero image, is refused as too large to read.
  it("saves and publishes an App with a 1.2 MB photo under the demo's IBAN rules", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({ operations: { events: guardedEvents(stores, demoRules).events } })
    });
    try {
      const put = await t.putApp(t.admin.id, "offers", [
        ...appFiles("Angebot"),
        photo("hero.png", 1_200_000)
      ]);
      expect(put.statusCode, put.body).toBe(200);
      const published = await t.publish(t.admin.id, "offers", 1);
      expect(published.statusCode, published.body).toBe(200);
    } finally {
      await t.close();
    }
  });

  // A judge reads no byte of an image, yet a set over 2 MiB as Latin-1 makes the whole field
  // `null` (too large) before the judge is asked: the judge refuses an App it would read only
  // the text of.
  it("lets a judge that reads text alone pass an App with 2.5 MB of photos", async () => {
    let judged = 0;
    const t = await setupAppInstance({
      server: (stores) => {
        const guarded = guardedEvents(stores, {
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
      // A file of a Page holds at most 2 MB (FILE_SET_MAX_FILE_BYTES): two photos make the
      // 2.5 MB that are more than a field of 2 Mi characters as Latin-1.
      const put = await t.putApp(t.admin.id, "offers", [
        ...appFiles("Angebot"),
        photo("hero.png", 1_250_000),
        photo("team.png", 1_250_000)
      ]);
      expect(put.statusCode, put.body).toBe(200);
      expect(judged).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe("GR-2b r2: text a pattern does not see as text", () => {
  // A CSV or text export from Windows tools is often UTF-16LE with a byte order mark. It holds
  // NUL bytes, so it is no text to the event and its Latin-1 reading interleaves NULs with the
  // digits: the IBAN pattern never matches. Round 1 refused such a file as unread; now it
  // passes a block rule unread.
  it("finds an IBAN in a UTF-16 text file", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({ operations: { events: guardedEvents(stores, demoRules).events } })
    });
    try {
      const export16 = bytes(
        "accounts.csv",
        new Uint8Array([0xff, 0xfe, ...Buffer.from(`name;iban\nMax;${IBAN}\n`, "utf16le")])
      );
      const put = await t.putApp(t.admin.id, "offers", [...appFiles("Angebot"), export16]);
      expect(put.statusCode, put.body).toBe(403);
    } finally {
      await t.close();
    }
  });

  // An image is recognised by its first bytes alone. A file that starts with a PNG signature
  // and then holds plain text is handed to no judge, while the App's script can fetch it and
  // show the text. A judge-only rule (the spec's Datenschutz judge) never reads it.
  it("hands a judge the text of a file that only starts like an image", async () => {
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
        "customers.png",
        new Uint8Array([...PNG, ...Buffer.from("Max Mustermann, geboren 1.2.1970, Diagnose F32")])
      );
      const put = await t.putApp(t.admin.id, "offers", [...appFiles("Angebot"), disguised]);
      // Either the judge read the text, or the write is refused as one it cannot judge.
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

describe("GR-2b r2: a held App from a Page", () => {
  // The hold asked a person about revision 1. The Page is saved again before the approval;
  // the call asked again reads revision 2, which the same judge would hold too, and the
  // approval of revision 1 answers that hold: revision 2 is written without anyone looking.
  it("does not let the approval of one revision answer the hold of another", async () => {
    let t: AppInstance | undefined;
    t = await setupAppInstance({
      server: (stores) => {
        const guarded = guardedEvents(stores, {
          held: { ...judge("asset.before_write", "require_approval"), filter: { kind: "app" } }
        });
        guarded.complete.mockImplementation(async () => verdict(true));
        return { operations: { events: guarded.events } };
      }
    });
    try {
      const page = await t.storePage("first revision, looked at");
      const held = await t.call(t.admin.id, "apps.create_from_page", {
        payload: { ...page, name: "offers", title: "Offers", workspaceId: t.workspaceId }
      });
      const { approvalRequestId } = z
        .object({ status: z.literal("pending_approval"), approvalRequestId: z.string() })
        .parse(held.json());
      await t.storePage(
        `second revision, Konto ${IBAN}`,
        {},
        {
          conversationId: page.conversationId
        }
      );
      expectStatus(
        await t.call(t.admin.id, "approval_requests.decide", {
          params: { requestId: approvalRequestId },
          payload: { decision: "approve" }
        }),
        200
      );
      await getTestJobs(t.instance).runDue();
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
      // Written from the revision the hold was about, or not written at all.
      if (origin) expect(origin.fileSetNumber).toBe(1);
    } finally {
      await t?.close();
    }
  });
});

describe("GR-2b r2: another workspace's App named in a revert or a publish", () => {
  // The fix's claim: the call is refused as for a name of no App in the caller's workspace.
  // Compared here with a name nobody holds, the name aside.
  it("answers the name of another workspace's App as the name of no App", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({ operations: { events: guardedEvents(stores, demoRules).events } })
    });
    try {
      expect((await t.putApp(t.admin.id, "payroll", appFiles(`Konto ${IBAN}`))).statusCode).toBe(
        403
      );
      expect((await t.putApp(t.admin.id, "payroll", appFiles("Lohn"))).statusCode).toBe(200);
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
    } finally {
      await t.close();
    }
  });
});
