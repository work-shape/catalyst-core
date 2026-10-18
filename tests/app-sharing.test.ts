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
    expectStatus(await t.putApp(t.kai.id, "private", appFiles("private", { id: "private" })), 200);
    expectStatus(await publish(t.admin.id, "private", "self"), 200);
    expectStatus(
      await t.call(t.kai.id, "apps.preview", {
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
    ).toEqual({ audience: "self", userId: t.kai.id });
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
    expectStatus(await publish(t.admin.id, "widen", "self"), 200);
    expectStatus(await publish(t.kai.id, "widen", "self"), 200);
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
    ).toContain("Only the builder");
    expect(
      audienceRead.parse((await get(t.kai.id, "widen", "workspace")).json()).publishNarrative
        ?.summary
    ).toContain("Everyone in");
  });

  it("check 56: instance availability reaches a person outside the owner workspace without moving the App's owner", async () => {
    expectStatus(
      await t.putApp(t.admin.id, "instance", appFiles("instance", { id: "instance" })),
      200
    );
    expectStatus(await publish(t.admin.id, "instance", "instance"), 200);
    const elsewhere = await t.sharedWorkspace("Other workspace");
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
