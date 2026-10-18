import { beforeAllWithPostgres as beforeAll } from "./support/postgres-hooks";
import { afterAll, describe, expect, it } from "vitest";
import { appAudienceWidens, createActorAccess } from "@work-shape/catalyst-core";
import { z } from "zod";
import { clientInstanceId } from "./support/access-instance";
import { appFiles, expectStatus, setupAppInstance, type AppInstance } from "./support/app-instance";
import { getTestJobs } from "./support/test-instance";
import { guardedEvents } from "./support/guardrails";

const audienceRead = z.looseObject({
  appAudience: z.object({ selected: z.string(), choices: z.array(z.string()), label: z.string() }),
  publishNarrative: z.object({ summary: z.string(), warnings: z.array(z.string()) }).optional()
});
const listRead = z.object({ items: z.array(z.looseObject({ name: z.string() })) });
const held = z.object({ approvalRequestId: z.string() });

describe("SHARE-1 audience on App availability", () => {
  let t: AppInstance;
  beforeAll(async () => {
    t = await setupAppInstance({
      server: (stores) => ({
        operations: { events: guardedEvents(stores, {}, { shipped: true }).events }
      })
    });
    for (const action of ["app.read", "app.write", "app.publish"]) {
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
  });
  afterAll(() => t?.close());
  const publish = (userId: string, name: string, audience: "self" | "workspace" | "instance") =>
    t.call(userId, "assets.publish", {
      params: { kind: "app", name },
      payload: { workspaceId: t.workspaceId, revision: 1, audience }
    });
  const get = (userId: string, name: string, audience?: "self" | "workspace" | "instance") =>
    t.call(userId, "assets.get", {
      params: { kind: "app", name },
      query: { workspaceId: t.workspaceId, ...(audience ? { audience } : {}) }
    });

  it("check 56: only the builder uses the live private App; another workspace member does not find it in Apps", async () => {
    expectStatus(
      await t.putApp(t.admin.id, "private", appFiles("private", { id: "private" })),
      200
    );
    expectStatus(await publish(t.admin.id, "private", "self"), 200);
    expectStatus(
      await t.call(t.admin.id, "apps.preview", {
        params: { app: "private" },
        payload: { mode: "published" }
      }),
      200
    );
    // Lena joins this workspace but receives no build right.
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: t.workspaceId,
      userId: t.lena.id,
      role: "member"
    });
    const listed = await t.call(t.lena.id, "assets.list", {
      params: { kind: "app" },
      query: { workspaceId: t.workspaceId }
    });
    expectStatus(listed, 200);
    expect(listRead.parse(listed.json()).items.map((item) => item.name)).not.toContain("private");
    expectStatus(await get(t.lena.id, "private"), 403);
    expectStatus(
      await t.call(t.lena.id, "apps.preview", {
        params: { app: "private" },
        payload: { mode: "published" }
      }),
      403
    );
    expect(
      (
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "app",
          name: "private"
        })
      )?.appAvailability
    ).toEqual({ audience: "self", userId: t.admin.id });
  });

  it("check 56: Only me stays distinct from Workspace when the App's owner is a personal workspace", async () => {
    const personal = await t.stores.workspaces.ensurePersonalWorkspace({
      clientInstanceId,
      userId: t.admin.id
    });
    expectStatus(
      await t.call(t.admin.id, "assets.put", {
        params: { kind: "app", name: "personal-owner" },
        payload: { workspaceId: personal.id, files: appFiles("personal-owner", { id: "personal" }) }
      }),
      200
    );
    for (const audience of ["self", "workspace", "self"] as const) {
      expectStatus(
        await t.call(t.admin.id, "assets.publish", {
          params: { kind: "app", name: "personal-owner" },
          payload: { workspaceId: personal.id, revision: 1, audience }
        }),
        200
      );
      const read = await t.call(t.admin.id, "assets.get", {
        params: { kind: "app", name: "personal-owner" },
        query: { workspaceId: personal.id }
      });
      expectStatus(read, 200);
      expect(audienceRead.parse(read.json()).appAudience.choices).not.toContain("workspace");
      expect(audienceRead.parse(read.json()).appAudience.selected).toBe(
        audience === "workspace" ? "self" : audience
      );
      // The Personal Workspace is named after its owner, as the interface names it, never by
      // the name stored on its row (ACCEPT-FIX-2 C5).
      const named = z
        .looseObject({ appAudience: z.looseObject({ workspaceName: z.string() }) })
        .parse(read.json());
      expect(named.appAudience.workspaceName).toBe("Admin's workspace");
      expect(JSON.stringify(read.json())).not.toContain("Personal workspace");
    }
  });

  it("check 56: instance audience is absent without the instance publish right and a forged request is refused", async () => {
    expectStatus(await t.putApp(t.kai.id, "rights", appFiles("rights", { id: "rights" })), 200);
    const read = await get(t.kai.id, "rights");
    expectStatus(read, 200);
    expect(audienceRead.parse(read.json()).appAudience.choices).toEqual(["self", "workspace"]);
    expect(audienceRead.parse(read.json()).appAudience.selected).toBe("self");
    expect(
      audienceRead.parse((await get(t.admin.id, "rights")).json()).appAudience.choices
    ).toContain("instance");
    expectStatus(await publish(t.kai.id, "rights", "instance"), 403);
    expect(
      (
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "app",
          name: "rights"
        })
      )?.publishedRevision
    ).toBeUndefined();
    expectStatus(await get(t.kai.id, "rights", "instance"), 403);
    const malformed = await t.call(t.admin.id, "assets.publish", {
      params: { kind: "app", name: "rights" },
      payload: { workspaceId: t.workspaceId, revision: 1, audience: "everybody" }
    });
    expectStatus(malformed, 422);
  });

  it("check 80 / check 76: the same revision with a wider audience is held and its Inbox review freezes that audience", async () => {
    expectStatus(await t.putApp(t.kai.id, "widen", appFiles("widen", { id: "widen" })), 200);
    const first = await publish(t.kai.id, "widen", "self");
    expectStatus(first, 202);
    expectStatus(
      await t.call(t.admin.id, "approval_requests.decide", {
        params: { requestId: held.parse(first.json()).approvalRequestId },
        payload: { decision: "approve" }
      }),
      200
    );
    await getTestJobs(t.instance).runDue();
    expectStatus(await publish(t.kai.id, "widen", "self"), 202);
    const wider = await publish(t.kai.id, "widen", "workspace");
    expectStatus(wider, 202);
    const requestId = held.parse(wider.json()).approvalRequestId;
    const request = await t.call(t.admin.id, "approval_requests.get", { params: { requestId } });
    expectStatus(request, 200);
    expect(JSON.stringify(request.json())).toContain('"selected":"workspace"');
    expect(
      (await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name: "widen" }))
        ?.appAvailability?.audience
    ).toBe("self");
    expectStatus(
      await t.call(t.admin.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      }),
      200
    );
    await getTestJobs(t.instance).runDue();
    expect(
      (await t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name: "widen" }))
        ?.appAvailability?.audience
    ).toBe("workspace");
    expect(
      audienceRead.parse((await get(t.kai.id, "widen", "self")).json()).publishNarrative?.summary
    ).toContain("only me");
    expect(
      audienceRead.parse((await get(t.kai.id, "widen", "workspace")).json()).publishNarrative
        ?.summary
    ).toContain("everyone in");
  });

  it("check 80: Only me selects the person publishing, and changing that private recipient widens reach", async () => {
    expectStatus(
      await t.putApp(t.admin.id, "recipient", appFiles("recipient", { id: "recipient" })),
      200
    );
    expectStatus(await publish(t.admin.id, "recipient", "self"), 200);
    const change = await publish(t.kai.id, "recipient", "self");
    expectStatus(change, 202);
    const stored = () =>
      t.stores.configAssets.getConfigAsset({ clientInstanceId, kind: "app", name: "recipient" });
    expect((await stored())?.appAvailability?.userId).toBe(t.admin.id);
    expectStatus(
      await t.call(t.admin.id, "approval_requests.decide", {
        params: { requestId: held.parse(change.json()).approvalRequestId },
        payload: { decision: "approve" }
      }),
      200
    );
    await getTestJobs(t.instance).runDue();
    expect((await stored())?.appAvailability).toEqual({ audience: "self", userId: t.kai.id });
    expectStatus(
      await t.call(t.kai.id, "apps.preview", {
        params: { app: "recipient" },
        payload: { mode: "published" }
      }),
      200
    );
    expectStatus(
      await t.call(t.admin.id, "apps.preview", {
        params: { app: "recipient" },
        payload: { mode: "published" }
      }),
      403
    );
  });

  it("a first publish without an audience is private, and later omission keeps the live audience", async () => {
    expectStatus(
      await t.putApp(t.admin.id, "default-private", appFiles("default", { id: "default-private" })),
      200
    );
    const omitted = () =>
      t.call(t.admin.id, "assets.publish", {
        params: { kind: "app", name: "default-private" },
        payload: { workspaceId: t.workspaceId, revision: 1 }
      });
    expectStatus(await omitted(), 200);
    const stored = () =>
      t.stores.configAssets.getConfigAsset({
        clientInstanceId,
        kind: "app",
        name: "default-private"
      });
    expect((await stored())?.appAvailability).toEqual({ audience: "self", userId: t.admin.id });
    expectStatus(await publish(t.admin.id, "default-private", "workspace"), 200);
    expectStatus(await omitted(), 200);
    expect((await stored())?.appAvailability?.audience).toBe("workspace");
  });

  it("every non-widening publish is held, including a workspace publisher narrowing an instance App", async () => {
    expectStatus(await t.putApp(t.admin.id, "narrow", appFiles("narrow", { id: "narrow" })), 200);
    expectStatus(await publish(t.admin.id, "narrow", "instance"), 200);
    const review = audienceRead.parse((await get(t.kai.id, "narrow")).json()).appAudience;
    expect(review).toMatchObject({ selected: "workspace", choices: ["self", "workspace"] });
    // Omission keeps the live audience: it never asks an instance right the person did not choose.
    expectStatus(
      await t.call(t.kai.id, "assets.publish", {
        params: { kind: "app", name: "narrow" },
        payload: { workspaceId: t.workspaceId, revision: 1 }
      }),
      202
    );
    const narrowed = await publish(t.kai.id, "narrow", "workspace");
    expectStatus(narrowed, 202);
    expectStatus(
      await t.call(t.admin.id, "approval_requests.decide", {
        params: { requestId: held.parse(narrowed.json()).approvalRequestId },
        payload: { decision: "approve" }
      }),
      200
    );
    await getTestJobs(t.instance).runDue();
    expect(
      (
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "app",
          name: "narrow"
        })
      )?.appAvailability?.audience
    ).toBe("workspace");
    const events = await t.stores.audit.listAuditEvents({
      clientInstanceId,
      type: "app.published",
      limit: 200
    });
    expect(
      events
        .filter((event) => event.metadata?.name === "narrow")
        .map((event) => event.metadata?.publish_widens)
    ).toContain(false);
    expectStatus(await publish(t.kai.id, "narrow", "workspace"), 202);
  });

  it("rechecks the live audience under the committing row lock before changing availability", async () => {
    expectStatus(
      await t.putApp(t.admin.id, "stale-reach", appFiles("stale", { id: "stale-reach" })),
      200
    );
    expectStatus(await publish(t.admin.id, "stale-reach", "instance"), 200);
    const address = { clientInstanceId, kind: "app", name: "stale-reach" };
    const reviewed = await t.stores.configAssets.getConfigAsset(address);
    if (!reviewed?.publishedRevisionId) throw new Error("Missing live revision");
    expectStatus(await publish(t.admin.id, "stale-reach", "workspace"), 200);
    await expect(
      t.stores.configAssets.publishConfigAssetRevision({
        ...address,
        assetId: reviewed.id,
        revision: 1,
        revisionId: reviewed.publishedRevisionId,
        audience: "instance",
        appPublishReview: {
          liveRevisionId: reviewed.publishedRevisionId,
          liveAudience: { audience: "instance" },
          contentWidens: false
        }
      })
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "live_moved" } });
    expect((await t.stores.configAssets.getConfigAsset(address))?.appAvailability?.audience).toBe(
      "workspace"
    );
  });

  it("check 56: instance availability reaches a person outside the owner workspace without moving the App's owner", async () => {
    expectStatus(
      await t.putApp(t.admin.id, "instance", appFiles("instance", { id: "instance" })),
      200
    );
    expectStatus(await publish(t.admin.id, "instance", "instance"), 200);
    const elsewhere = await t.sharedWorkspace("Other workspace");
    const instanceList = await t.call(t.lena.id, "assets.list", { params: { kind: "app" } });
    expectStatus(instanceList, 200);
    expect(listRead.parse(instanceList.json()).items.map((item) => item.name)).toContain(
      "instance"
    );
    const listed = await t.call(t.lena.id, "assets.list", {
      params: { kind: "app" },
      query: { workspaceId: elsewhere }
    });
    expectStatus(listed, 200);
    expect(listRead.parse(listed.json()).items.map((item) => item.name)).toContain("instance");
    expectStatus(
      await t.call(t.lena.id, "assets.get", {
        params: { kind: "app", name: "instance" },
        query: { workspaceId: elsewhere }
      }),
      200
    );
    expectStatus(
      await t.call(t.lena.id, "apps.preview", {
        params: { app: "instance" },
        payload: { mode: "published" }
      }),
      200
    );
    expect(
      (
        await t.stores.configAssets.getConfigAsset({
          clientInstanceId,
          kind: "app",
          name: "instance"
        })
      )?.scope
    ).toEqual({ kind: "workspace", workspaceId: t.workspaceId });
  });

  it("counts every audience widening and keeps private availability inside the central rights and credential gate", () => {
    expect(appAudienceWidens("workspace", "self")).toBe(true);
    expect(appAudienceWidens("instance", "workspace")).toBe(true);
    expect(appAudienceWidens("instance", "self")).toBe(true);
    expect(appAudienceWidens("self", "workspace")).toBe(false);
    expect(appAudienceWidens("self", "self", "a", "b")).toBe(true);
    expect(appAudienceWidens("self", "self", "a", "a")).toBe(false);
    const holder = {
      kind: "user" as const,
      id: "other",
      clientInstanceId,
      roles: ["user"],
      permissionRefs: []
    };
    const persisted = { holderActive: true, grants: [], memberWorkspaceIds: [t.workspaceId] };
    expect(
      createActorAccess(holder, persisted).authorize("app.use", {
        appAvailability: { audience: "self", userId: "builder" },
        workspaceId: t.workspaceId
      }).allowed
    ).toBe(false);
    expect(
      createActorAccess(
        { ...holder, id: "builder" },
        { ...persisted, memberWorkspaceIds: [] }
      ).authorize("app.use", {
        appAvailability: { audience: "self", userId: "builder" },
        workspaceId: t.workspaceId
      }).allowed
    ).toBe(false);
    expect(
      createActorAccess(holder, persisted).authorize("app.use", {
        appAvailability: { audience: "instance" }
      }).allowed
    ).toBe(true);
    expect(
      createActorAccess(holder, persisted, []).authorize("app.use", {
        appAvailability: { audience: "instance" }
      }).allowed
    ).toBe(false);
  });
});
