import { describe, expect, it } from "vitest";
import { clientInstanceId as accessInstanceId } from "./support/access-instance";
import { appFiles, setupAppInstance, type AppInstance } from "./support/app-instance";
import { IBAN, guardedEvents, ibanPattern, judge, noIban } from "./support/guardrails";

// Verifier's failing tests for PR 47 (GR-2b). Each one shows a defect found in review; none of
// them changes product code.

describe("GR-2b verify: an image in an App under the demo's IBAN rules", () => {
  const image = {
    path: "logo.png",
    base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]).toString(
      "base64"
    )
  };

  // The demo's release config (clients/demo/config/app.yaml) holds exactly these two rules:
  // a block pattern on `asset.before_write` without `filter.kind`, and one on
  // `app.before_publish`. A pattern for an IBAN cannot match a PNG, yet the App is refused.
  it("saves and publishes an App with a logo when no file holds an IBAN", async () => {
    const t = await setupAppInstance({
      server: (stores) => ({
        operations: {
          events: guardedEvents(stores, {
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
          }).events
        }
      })
    });
    try {
      const put = await t.putApp(t.admin.id, "offers", [...appFiles("Angebot"), image]);
      // Today: 403 "Guardrail 'No IBAN in assets' blocked app 'offers': Check
      // 'no_iban_in_assets' could not read content that is too large or is no text. Try again
      // later."
      expect(put.statusCode, JSON.stringify(put.json())).toBe(200);
      const published = await t.publish(t.admin.id, "offers", 1);
      expect(published.statusCode).toBe(200);
    } finally {
      await t.close();
    }
  });
});

describe("GR-2b verify: the Page an App is written from changes while it is checked", () => {
  // The guardrails read the Page's newest revision in `beforeEvents`; `execute` reads the
  // newest revision again and copies that one. A revision saved in between is copied unread.
  // A judge takes seconds, so the window is wide; the stand-in judge below saves the revision
  // while it is asked, which is what a second tab or the agent's page.save does in that time.
  it("never copies a Page revision that no guardrail read", async () => {
    let t: AppInstance | undefined;
    let conversationId: string | undefined;
    const judged = (() => {
      let made: ReturnType<typeof guardedEvents> | undefined;
      return {
        get complete() {
          if (!made) throw new Error("not set up");
          return made.complete;
        },
        events: (stores: Parameters<typeof guardedEvents>[0]) => {
          made = guardedEvents(stores, {
            no_iban: noIban({
              displayName: "No IBAN in Apps",
              filter: { kind: "app" },
              check: { kind: "pattern", pattern: ibanPattern, reason: "Apps hold no IBAN." }
            }),
            privacy: { ...judge("asset.before_write", "block"), filter: { kind: "app" } }
          });
          return made.events;
        }
      };
    })();
    t = await setupAppInstance({
      server: (stores) => ({ operations: { events: judged.events(stores) } })
    });
    try {
      const clean = await t.storePage("Angebot ohne Konto");
      conversationId = clean.conversationId;
      judged.complete.mockImplementation(async () => {
        // The person (or the agent) saves the Page again while the judge reads revision 1.
        await t?.storePage(`Konto ${IBAN}`, {}, { conversationId });
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
        // The copy records which Page revision it took: the one the guardrails read is 1.
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

describe("GR-2b verify: an App of another workspace named in a revert or a publish", () => {
  // The target of a call is resolved in the workspace the caller names, so a writer of
  // workspace A passes `authorize` for a name that belongs to an App of workspace B. The
  // before-events then read the revision by kind and name alone, which is B's App: its
  // content reaches the guardrails (and a judge's model), a block names it to the caller,
  // and a hit is kept on B's App. `execute` would refuse the call, but only afterwards.
  it("reads no revision of an App that belongs to another workspace", async () => {
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
      // Lena writes and publishes Apps in workspace A only.
      const other = await t.sharedWorkspace("A");
      for (const action of ["app.write", "app.publish"]) {
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

      const reverted = await t.call(t.lena.id, "assets.revert", {
        params: { kind: "app", name: "payroll" },
        payload: { revision: 1, expectedRevision: 1, workspaceId: other }
      });
      expect(reverted.statusCode).not.toBe(200);
      // No guardrail read B's revision for Lena's call.
      expect.soft(await hits("on_write")).toBe(writeHitsBefore);

      const published = await t.call(t.lena.id, "assets.publish", {
        params: { kind: "app", name: "payroll" },
        payload: { revision: 1, workspaceId: other }
      });
      // Before: 403 "Guardrail 'IBAN on publish' blocked app 'payroll': Apps hold no IBAN."
      // Now the publish refuses as for any name of no App in workspace A: NOT_FOUND, which
      // repeats the name Lena sent and tells nothing of B's App.
      expect.soft(published.json<{ error: { code: string; message: string } }>().error).toEqual(
        expect.objectContaining({
          code: "NOT_FOUND",
          message: "Config app 'payroll' was not found"
        })
      );
      expect.soft(await hits("on_publish")).toBe(0);
    } finally {
      await t.close();
    }
  });
});
