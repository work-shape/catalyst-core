import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  asUserId,
  isAuthenticatedServicePrincipal,
  type DraftHostOwner
} from "@work-shape/catalyst-core";
import { clientInstanceId, errorSchema, recordAuthAdapter } from "./support/access-instance";
import {
  appFiles,
  expectStatus,
  fileWriteSchema,
  previewSchema,
  setupAppInstance,
  type AppInstance
} from "./support/app-instance";
import type { TestCallInput } from "./support/operations";

// A person allows an outside host for their own preview of a draft (DRAFT-HOSTS-1): behind the
// release switch, only by a click of the person, only for a host the draft lists and the build
// accepts, only for their own frame, and only for as long as the draft lists it.

/** The header the test's sign-in reads as a click in the person's own signed-in browser. */
const COOKIE_HEADER = "x-test-cookie";
const asPerson = { [COOKIE_HEADER]: "1", origin: "https://ui.example.test" };

const draftHostsSchema = z.object({ allowable: z.array(z.string()), readsData: z.boolean() });
const shownSchema = previewSchema.extend({ draftHosts: draftHostsSchema.optional() });
const pageShownSchema = z.looseObject({
  url: z.string(),
  fileSetId: z.string(),
  number: z.number(),
  heldBackHosts: z.array(z.string()).optional(),
  draftHosts: draftHostsSchema.optional()
});
const createdSchema = z.object({ id: z.string(), fileSetId: z.string() });

const connects = (policy: string) => /connect-src ([^;]*)/u.exec(policy)?.[1];

describe("an outside host a person allows for their own view of a draft", () => {
  let t: AppInstance;
  // The release config the instance reads, switched by the tests.
  const release = { enabled: true };
  beforeAll(async () => {
    t = await setupAppInstance({
      server: (_stores, config) => {
        const base = recordAuthAdapter();
        return {
          config: {
            ...config,
            apps: {
              draftHosts: {
                get enabled() {
                  return release.enabled;
                }
              }
            }
          },
          authAdapter: {
            ...base,
            async authenticate(request) {
              const identity = await base.authenticate(request);
              return request.headers[COOKIE_HEADER] === "1" &&
                !isAuthenticatedServicePrincipal(identity)
                ? { ...identity, authenticationMethod: "session-cookie" as const }
                : identity;
            }
          }
        };
      }
    });
  });
  afterAll(async () => {
    await t.close();
  });

  const write = async (name: string, hosts: string[]) => {
    const response = await t.putApp(t.admin.id, name, appFiles(name, { externalHosts: hosts }));
    expectStatus(response, 200);
    return fileWriteSchema.parse(response.json()).revision;
  };
  /** What a person is shown who opens the App's draft, and the policy of its frame. */
  const shown = async (userId: string, app: string, headers: Record<string, string> = asPerson) => {
    const response = await t.call(userId, "apps.preview", {
      params: { app },
      payload: { mode: "draft" },
      headers
    });
    expectStatus(response, 200);
    const answer = shownSchema.parse(response.json());
    return { ...answer, policy: (await t.open(answer.url)).policy };
  };
  const allow = (
    userId: string,
    payload: TestCallInput["payload"],
    headers: Record<string, string> = asPerson
  ) => t.call(userId, "apps.allow_draft_host", { payload, headers });
  const refusal = (response: Awaited<ReturnType<typeof allow>>) => {
    const { error } = errorSchema.parse(response.json());
    return { status: response.statusCode, code: error.code, reason: error.details?.reason };
  };
  const assetId = async (name: string) => {
    const asset = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "app",
      name
    });
    if (!asset) throw new Error(`No App '${name}'`);
    return asset.id;
  };
  /** Every host a person's allowances hold, whatever the draft shows now. */
  const stored = (owner: DraftHostOwner, userId: string) =>
    t.stores.pages.listDraftHostAllowances({
      clientInstanceId,
      owner,
      userId: asUserId(userId),
      shownNumber: 1_000_000
    });
  const allowedEvents = async () =>
    (await t.stores.audit.listAuditEvents({ clientInstanceId, limit: 500 })).filter(
      (event) =>
        event.type === "app.draft_host_allowed" || event.type === "app.page_draft_host_allowed"
    );

  it("offers the click to a person who writes the App, and refuses every other caller and host", async () => {
    await write("rates", ["api.example.com"]);
    const draft = await shown(t.admin.id, "rates");
    expect(draft.heldBackHosts).toEqual(["api.example.com"]);
    expect(draft.draftHosts?.allowable).toEqual(["api.example.com"]);
    expect(connects(draft.policy)).toBe("'none'");
    // A call that is no click of the person is offered nothing.
    expect((await shown(t.admin.id, "rates", {})).draftHosts?.allowable).toEqual([]);

    const fileSetId = draft.fileSetId;
    // A key, a Service Principal and a call made for the person are no click.
    expect(refusal(await allow(t.admin.id, { fileSetId, host: "api.example.com" }, {}))).toEqual({
      status: 403,
      code: "FORBIDDEN",
      reason: "draft_host_requires_person"
    });
    expect(
      refusal(
        await allow(
          t.admin.id,
          { fileSetId, host: "api.example.com" },
          { ...asPerson, "x-test-key": "personal" }
        )
      )
    ).toMatchObject({ code: "FORBIDDEN", reason: "draft_host_requires_person" });

    // What the build would not accept, or what names a private network, is never allowed.
    for (const host of [
      "*.example.com",
      "https://api.example.com",
      "api.example.com:8443",
      "10.0.0.1",
      "[::1]",
      "localhost",
      "printer.local",
      "nas.home",
      "wiki.corp",
      "intranet"
    ]) {
      expect(refusal(await allow(t.admin.id, { fileSetId, host })), host).toMatchObject({
        code: "VALIDATION_FAILED",
        reason: "draft_host_invalid"
      });
    }
    expect(
      refusal(await allow(t.admin.id, { fileSetId, host: "other.example.com" }))
    ).toMatchObject({
      code: "VALIDATION_FAILED",
      reason: "draft_host_not_listed"
    });
    // A member who may not write the App does not learn of its draft.
    expect(refusal(await allow(t.kai.id, { fileSetId, host: "api.example.com" }))).toMatchObject({
      status: 404,
      code: "NOT_FOUND"
    });
    expect(
      refusal(await allow(t.admin.id, { fileSetId: "fs_nothing", host: "api.example.com" }))
    ).toMatchObject({ status: 404, code: "NOT_FOUND" });
    expect(await allowedEvents()).toEqual([]);
  });

  it("lets only the person's own frame connect and records the click without the draft", async () => {
    const draft = await shown(t.admin.id, "rates");
    expect(draft.draftHosts?.readsData).toBe(false);
    const response = await allow(t.admin.id, {
      fileSetId: draft.fileSetId,
      host: "api.example.com"
    });
    expectStatus(response, 200);
    expect(response.json()).toEqual({ host: "api.example.com", allowed: true });

    const mine = await shown(t.admin.id, "rates");
    expect(mine.heldBackHosts).toEqual([]);
    expect(connects(mine.policy)).toBe("https://api.example.com");
    // Another builder of the same draft still sees the host held back.
    const theirs = await shown(t.root.id, "rates");
    expect(theirs.heldBackHosts).toEqual(["api.example.com"]);
    expect(connects(theirs.policy)).toBe("'none'");

    const events = await allowedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: "success", actor: { principalId: t.admin.id } });
    expect(Object.keys(events[0]?.metadata ?? {}).sort()).toEqual([
      "assetId",
      "fileSetNumber",
      "host",
      "kind",
      "name",
      "operationRunId",
      "revisionId",
      "workspaceId"
    ]);
    expect(events[0]?.metadata).toMatchObject({
      host: "api.example.com",
      kind: "app",
      name: "rates",
      assetId: await assetId("rates"),
      workspaceId: t.workspaceId
    });

    // A host the frame connects to already is allowed without another row.
    expectStatus(
      await allow(t.admin.id, { fileSetId: mine.fileSetId, host: "api.example.com" }),
      200
    );
    expect(await allowedEvents()).toHaveLength(1);
  });

  it("holds while the draft lists the host and ends for good once a draft no longer does", async () => {
    const owner = { kind: "app" as const, id: await assetId("rates") };
    await write("rates", ["api.example.com"]);
    expect(connects((await shown(t.admin.id, "rates")).policy)).toBe("https://api.example.com");

    await write("rates", []);
    await write("rates", ["api.example.com"]);
    const back = await shown(t.admin.id, "rates");
    expect(back.heldBackHosts).toEqual(["api.example.com"]);
    expect(connects(back.policy)).toBe("'none'");
    // The row stays until a publish or a discard, and is not read.
    expect(await stored(owner, t.admin.id)).toEqual([]);
  });

  it("ends with a discard of the draft and with a publish", async () => {
    const owner = { kind: "app" as const, id: await assetId("rates") };
    const allowNow = async () => {
      const draft = await shown(t.admin.id, "rates");
      expectStatus(
        await allow(t.admin.id, { fileSetId: draft.fileSetId, host: "api.example.com" }),
        200
      );
      expect(connects((await shown(t.admin.id, "rates")).policy)).toBe("https://api.example.com");
    };

    // Published first without the host, so a discard has a revision to go back to.
    const plain = await write("rates", []);
    expectStatus(await t.publish(t.admin.id, "rates", plain), 200);
    const listing = await write("rates", ["api.example.com"]);
    await allowNow();
    expectStatus(
      await t.call(t.admin.id, "assets.discard_draft", {
        params: { kind: "app", name: "rates" },
        payload: { expectedRevision: listing, workspaceId: t.workspaceId }
      }),
      200
    );
    expect(await stored(owner, t.admin.id)).toEqual([]);

    const again = await write("rates", ["api.example.com"]);
    expect((await shown(t.admin.id, "rates")).heldBackHosts).toEqual(["api.example.com"]);
    await allowNow();
    expectStatus(await t.publish(t.admin.id, "rates", again), 200);
    expect(await stored(owner, t.admin.id)).toEqual([]);

    // A click checked before a publish or a discard that came first stores nothing.
    const late = await t.stores.pages.allowDraftHost({
      clientInstanceId,
      owner,
      userId: asUserId(t.admin.id),
      host: "api.example.com",
      fileSetNumber: 1,
      allowedAt: new Date().toISOString(),
      draftOf: { activeRevisionId: "cfgr_before", publishedRevisionId: undefined }
    });
    expect(late).toBe(false);
    expect(await stored(owner, t.admin.id)).toEqual([]);

    // A host the next draft adds is held back again.
    await write("rates", ["api.example.com", "collect.example.net"]);
    expect((await shown(t.admin.id, "rates")).heldBackHosts).toEqual(["collect.example.net"]);
  });

  it("allows a host for a Page of a conversation and keeps it for the App the Page is saved as", async () => {
    const page = await t.storePage("offers", { externalHosts: ["api.example.com"] });
    const params = { conversationId: page.conversationId, pageId: page.pageId };
    const pageShown = async () => {
      const response = await t.call(t.admin.id, "pages.preview", {
        params,
        payload: {},
        headers: asPerson
      });
      expectStatus(response, 200);
      const answer = pageShownSchema.parse(response.json());
      return { ...answer, policy: (await t.open(answer.url)).policy };
    };

    const before = await pageShown();
    expect(before.heldBackHosts).toEqual(["api.example.com"]);
    expect(before.draftHosts).toEqual({ allowable: ["api.example.com"], readsData: false });
    expect(connects(before.policy)).toBe("'none'");
    // A person who does not read the conversation does not learn of the Page.
    expect(
      refusal(await allow(t.kai.id, { fileSetId: before.fileSetId, host: "api.example.com" }))
    ).toMatchObject({ status: 404 });

    expectStatus(
      await allow(t.admin.id, { fileSetId: before.fileSetId, host: "api.example.com" }),
      200
    );
    expect(connects((await pageShown()).policy)).toBe("https://api.example.com");
    const pageEvent = (await allowedEvents()).find(
      (event) => event.metadata?.pageId === page.pageId
    );
    expect(pageEvent?.type).toBe("app.page_draft_host_allowed");
    expect(pageEvent?.metadata).toEqual({
      host: "api.example.com",
      pageId: page.pageId,
      conversationId: page.conversationId,
      fileSetNumber: before.number,
      operationRunId: expect.any(String)
    });

    const created = await t.call(t.admin.id, "apps.create_from_page", {
      payload: { ...page, name: "offers", title: "Offers", workspaceId: t.workspaceId },
      headers: asPerson
    });
    expectStatus(created, 200);
    const app = createdSchema.parse(created.json());
    const appDraft = await shown(t.admin.id, "offers");
    expect(appDraft.heldBackHosts).toEqual([]);
    expect(connects(appDraft.policy)).toBe("https://api.example.com");
    expect(
      (await allowedEvents()).find((event) => event.metadata?.assetId === app.id)?.metadata
    ).toMatchObject({
      host: "api.example.com",
      assetId: app.id,
      movedFrom: { pageId: page.pageId, conversationId: page.conversationId }
    });
    // The Page keeps the host for its own preview.
    expect(connects((await pageShown()).policy)).toBe("https://api.example.com");
  });

  it("says where the draft reads data its frame could send to an allowed host", async () => {
    const page = await t.storePage("orders", {
      externalHosts: ["api.example.com"],
      actions: [
        {
          name: "load-rows",
          kind: "connection",
          file: "actions/load-rows.action.yaml",
          effect: "reading",
          description: "The newest orders.",
          connection: "crm",
          operation: "list_orders",
          input: { schema: { type: "object", properties: {} }, mapping: {} }
        }
      ]
    });
    const response = await t.call(t.admin.id, "pages.preview", {
      params: { conversationId: page.conversationId, pageId: page.pageId },
      payload: {},
      headers: asPerson
    });
    expectStatus(response, 200);
    expect(pageShownSchema.parse(response.json()).draftHosts).toEqual({
      allowable: ["api.example.com"],
      readsData: true
    });
  });

  it("offers and reads nothing where the release switch is off", async () => {
    release.enabled = false;
    try {
      const draft = await shown(t.admin.id, "offers");
      expect(draft.draftHosts).toBeUndefined();
      expect(draft.heldBackHosts).toEqual(["api.example.com"]);
      expect(connects(draft.policy)).toBe("'none'");
      expect(
        refusal(await allow(t.admin.id, { fileSetId: draft.fileSetId, host: "api.example.com" }))
      ).toEqual({ status: 404, code: "NOT_FOUND", reason: "draft_hosts_off" });
    } finally {
      release.enabled = true;
    }
  });
});
