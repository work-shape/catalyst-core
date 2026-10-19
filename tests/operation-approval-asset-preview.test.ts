import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { operationRunSchema } from "@work-shape/catalyst-api-contract";
import { getTestJobs } from "./support/test-instance";
import { clientInstanceId } from "./support/access-instance";
import type { AccessInstanceOptions } from "./support/access-instance";
import type { CentralPolicySetting } from "@work-shape/catalyst-core";
import { agent, skill } from "./support/access-instance";
import { setupNamespaceHolder } from "./support/asset-operations";

// What the person who decides a held `assets.put` is shown of the asset it saves. The tests
// that read an `asset` block fail without it: the preview named the operation and listed the
// definition as one escaped line. The test of `assets.delete` holds what stays as it was.

const OLD_PARAGRAPH = "Sick notes are due on the third day.";
const NEW_PARAGRAPH = "Sick notes are due on the first day.";
const stored = `# Leave\n\n30 days a year.\n\n${OLD_PARAGRAPH}\n`;
const changed = `# Leave\n\n30 days a year.\n\n${NEW_PARAGRAPH}\n`;

const listedSchema = z.object({
  items: z.array(z.object({ preview: z.object({ asset: z.unknown() }) }))
});

/** An instance that holds nothing until `holding` names a setting. */
async function setup(server?: AccessInstanceOptions["server"]) {
  let settings: CentralPolicySetting[] = [];
  const t = await setupNamespaceHolder({
    operations: { centralPolicySettings: () => settings },
    ...(server ? { server } : {})
  });
  const holding = (...operations: string[]) => {
    settings = operations.map((operation) => ({ operation, value: "approval" }));
  };
  /** Makes the call as Kai and answers the id of the request it waits on. */
  const hold = async (
    operation: "assets.put" | "assets.delete",
    kind: string,
    name: string,
    payload: Record<string, unknown>
  ) => {
    const held = await t.call(t.kai.id, operation, { params: { kind, name }, payload });
    expect(held.statusCode).toBe(202);
    const { approvalRequestId = "" } = operationRunSchema.parse(held.json());
    return approvalRequestId;
  };
  const preview = async (userId: string, requestId: string) =>
    (await t.expectOk(userId, "approval_requests.get", { params: { requestId } })).json().preview;
  return { t, holding, hold, preview };
}

describe("the preview of a held asset save", () => {
  it("ACCEPT-2b E4: keeps the original skill comparison after approval for requester and approver", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: { ...skill("kai-leave", changed), title: "Leave policy" },
      expectedRevision: 1
    });
    const original = (await preview(t.kai.id, requestId)).asset;
    await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    await getTestJobs(t.instance).runDue();
    for (const reader of [t.kai.id, t.admin.id]) {
      const item = (
        await t.expectOk(reader, "approval_requests.get", { params: { requestId } })
      ).json();
      expect(item.applyResult.execution).toBe("done");
      expect(item.preview.asset).toEqual(original);
      expect(item.payload.input).toBeUndefined();
      expect(item.payload.actor.authSource).toBeUndefined();
    }
    // Retained before-text is still gated after the request ended, including its payload copy.
    await t.seedHistoricalGrant(t.admin.id, "skill.read", { namespace: "kai-" }, "deny");
    const withheld = (
      await t.expectOk(t.admin.id, "approval_requests.get", { params: { requestId } })
    ).json();
    expect(JSON.stringify(withheld)).not.toContain(OLD_PARAGRAPH);
    expect(withheld.preview.asset.title).toBe("Leave policy");
    expect(withheld.preview.asset.beforeWithheld).toBe(true);
  });

  it.each(["decide", "withdraw"] as const)(
    "ACCEPT-FIX-9b: %s returns the same reader-gated comparison as GET",
    async (action) => {
      const { t, holding, hold } = await setup();
      await t.expectOk(t.kai.id, "assets.put", {
        params: { kind: "skill", name: "kai-leave" },
        payload: { config: skill("kai-leave", stored) }
      });
      holding("assets.put");
      const requestId = await hold("assets.put", "skill", "kai-leave", {
        config: { ...skill("kai-leave", changed), title: "Leave policy" },
        expectedRevision: 1
      });
      const reader = action === "withdraw" ? t.kai : t.admin;
      await t.grant(
        reader.id,
        "skill.read",
        { assetId: await t.assetId("skill", "kai-leave") },
        "deny"
      );
      const response =
        action === "withdraw"
          ? await t.expectOk(reader.id, "approval_requests.withdraw", { params: { requestId } })
          : await t.expectOk(reader.id, "approval_requests.decide", {
              params: { requestId },
              payload: { decision: "reject" }
            });
      const item = response.json();
      expect(JSON.stringify(item)).not.toContain(OLD_PARAGRAPH);
      expect(item.preview.asset).toMatchObject({
        kind: "skill",
        name: "kai-leave",
        title: "Leave policy",
        beforeWithheld: true
      });
      expect(item.preview.asset.isNew).toBeUndefined();
      expect(item.preview.asset.content).toBeUndefined();
      expect(item).toEqual(
        (await t.expectOk(reader.id, "approval_requests.get", { params: { requestId } })).json()
      );
    }
  );

  it("does not claim a later reader lacks access when the filer could not read before-text", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    await t.grant(
      t.kai.id,
      "skill.read",
      { assetId: await t.assetId("skill", "kai-leave") },
      "deny"
    );
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed),
      expectedRevision: 1
    });
    await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "approve" }
    });
    await getTestJobs(t.instance).runDue();
    expect((await preview(t.admin.id, requestId)).asset.beforeWithheld).toBeUndefined();
    expect((await preview(t.kai.id, requestId)).asset.beforeWithheld).toBe(true);
  });

  it("marks a held non-Skill creation stale when its expected revision changes (LOWS-D)", async () => {
    const { t, holding, hold, preview } = await setup();
    holding("assets.put");
    const requestId = await hold("assets.put", "agent", "kai-new", {
      config: agent("kai-new"),
      expectedRevision: null
    });
    expect((await preview(t.admin.id, requestId)).asset.isStale).toBeUndefined();
    holding();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "agent", name: "kai-new" },
      payload: { config: agent("kai-new"), expectedRevision: null }
    });
    expect((await preview(t.admin.id, requestId)).asset.isStale).toBe(true);
    // Non-readers learn nothing about the stored revision.
    await t.grant(
      t.admin.id,
      "agent.read",
      { assetId: await t.assetId("agent", "kai-new") },
      "deny"
    );
    const withheld = (await preview(t.admin.id, requestId)).asset;
    expect(withheld.isStale).toBeUndefined();
    expect(withheld.beforeWithheld).toBe(true);
  });

  it("ACCEPT-2b E7: warns about a changed revision before deciding and refuses the stale save", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed),
      expectedRevision: 1
    });
    expect((await preview(t.admin.id, requestId)).asset.isStale).toBeUndefined();
    holding();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", "A newer policy"), expectedRevision: 1 }
    });
    const stale = (await preview(t.admin.id, requestId)).asset;
    expect(stale.isStale).toBe(true);
    // ACCEPT-FIX-12 C-2: this is the version Kai saw, not the later admin save.
    expect(JSON.stringify(stale.content)).toContain(OLD_PARAGRAPH);
    expect(JSON.stringify(stale.content)).toContain(NEW_PARAGRAPH);
    expect(JSON.stringify(stale.content)).not.toContain("A newer policy");
    const stillPending = await t.stores.approvals.getApprovalRequest({
      clientInstanceId,
      requestId
    });
    expect(stillPending?.status).toBe("pending");
    const decided = (
      await t.expectOk(t.admin.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      })
    ).json();
    expect(decided).toMatchObject({
      status: "superseded",
      applyResult: { execution: "refused", error: { code: "APPROVAL_STALE" } }
    });
    expect((await t.stored("skill", "kai-leave"))?.config?.content).toBe("A newer policy");
  });

  it("ACCEPT-2e: keeps an outdated request named outdated after it is rejected", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    holding("assets.put");
    const outdatedId = await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed),
      expectedRevision: 1
    });
    const currentId = await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed),
      expectedRevision: 1
    });
    // The current request is rejected while its revision still stands: it was never outdated.
    await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId: currentId },
      payload: { decision: "reject" }
    });
    holding();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", "A newer policy"), expectedRevision: 1 }
    });
    expect((await preview(t.admin.id, outdatedId)).asset.isStale).toBe(true);
    await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId: outdatedId },
      payload: { decision: "reject" }
    });

    for (const reader of [t.admin.id, t.kai.id]) {
      const item = (
        await t.expectOk(reader, "approval_requests.get", { params: { requestId: outdatedId } })
      ).json();
      expect(item.status).toBe("rejected");
      expect(item.preview.asset.isStale).toBe(true);
      // Still the version Kai saw beside his proposal, never the later save.
      expect(JSON.stringify(item.preview.asset.content)).toContain(OLD_PARAGRAPH);
      expect(JSON.stringify(item.preview.asset.content)).not.toContain("A newer policy");
      expect(JSON.stringify(item)).not.toContain("requestedRevision");
    }
    const never = (await preview(t.admin.id, currentId)).asset;
    expect(never.isStale).toBeUndefined();
  });

  it("ACCEPT-2e: keeps a request filed before the fix named outdated after it is rejected", async () => {
    const { t, holding, hold } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    // A request filed by an earlier build froze its preview without the revision it asked
    // for: its call input still names that revision.
    const create = t.stores.approvals.createApprovalRequest.bind(t.stores.approvals);
    vi.spyOn(t.stores.approvals, "createApprovalRequest").mockImplementation((input) => {
      const asset = input.payload.asset;
      if (typeof asset !== "object" || asset === null || Array.isArray(asset)) return create(input);
      const { requestedRevision: _dropped, ...earlier } = asset;
      return create({ ...input, payload: { ...input.payload, asset: earlier } });
    });
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed),
      expectedRevision: 1
    });
    vi.restoreAllMocks();
    const filed = await t.stores.approvals.getApprovalRequest({ clientInstanceId, requestId });
    expect(JSON.stringify(filed?.payload)).not.toContain("requestedRevision");
    holding();
    await t.expectOk(t.admin.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", "A newer policy"), expectedRevision: 1 }
    });
    await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "reject" }
    });
    const item = (
      await t.expectOk(t.admin.id, "approval_requests.get", { params: { requestId } })
    ).json();
    expect(item.status).toBe("rejected");
    expect(item.preview.asset.isStale).toBe(true);
  });

  it("ACCEPT-2b E6: names only visible active people with the approval right", async () => {
    const { t, holding, hold } = await setup();
    const workspaceId = await t.sharedWorkspace("Approval team");
    for (const user of [t.kai, t.lena]) {
      await t.stores.workspaces.addMembership({
        clientInstanceId,
        collaborationWorkspaceId: workspaceId,
        userId: user.id,
        role: "member"
      });
    }
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed)
    });
    const reads = vi.spyOn(t.stores.workspaces, "listWorkspacesForUser");
    const item = (
      await t.expectOk(t.kai.id, "approval_requests.get", { params: { requestId } })
    ).json();
    expect(item.preview.approverNames).toEqual([t.admin.displayLabel]);
    expect(item.preview.approverNames).not.toContain(t.root.displayLabel);
    expect(item.preview.approverNames).not.toContain(t.lena.displayLabel);
    const approver = (
      await t.expectOk(t.admin.id, "approval_requests.get", { params: { requestId } })
    ).json();
    expect(approver.preview.approverNames).toBeUndefined();
    await t.stores.users.updateUser({ clientInstanceId, userId: t.admin.id, status: "disabled" });
    const withoutApprover = (
      await t.expectOk(t.kai.id, "approval_requests.get", { params: { requestId } })
    ).json();
    // Help is cached for this revision rather than walking memberships on each poll.
    expect(reads).toHaveBeenCalledTimes(1);
    expect(withoutApprover.preview.approverNames).toEqual(item.preview.approverNames);
  });

  it("ACCEPT-FIX-9b: leaves an approver with only an e-mail display label unnamed", async () => {
    const { t, holding, hold, preview } = await setup();
    const workspaceId = await t.sharedWorkspace("Approval team");
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: workspaceId,
      userId: t.kai.id,
      role: "member"
    });
    await t.stores.users.updateUser({
      clientInstanceId,
      userId: t.admin.id,
      displayLabel: "admin@example.test"
    });
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed)
    });
    expect((await preview(t.kai.id, requestId)).approverNames).toEqual([]);
  });

  it("shows a new skill with its title, its Namespace and its whole text", async () => {
    const { t, holding, hold, preview } = await setup();
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: { ...skill("kai-leave", stored), title: "Leave policy" }
    });

    const shown = await preview(t.admin.id, requestId);

    expect(shown.asset).toEqual({
      kind: "skill",
      name: "kai-leave",
      title: "Leave policy",
      namespace: "kai-",
      isNew: true,
      description: "A skill",
      content: {
        skillName: "kai-leave",
        skillTitle: "Leave policy",
        isNewSkill: true,
        changes: [],
        newSkill: {
          name: "kai-leave",
          title: "Leave policy",
          description: "A skill",
          content: stored
        }
      }
    });
    // The request says what made it wait: a setting of the instance.
    expect(shown.heldBy).toBe("central_setting");
    // The definition is a row for each of its fields, and the text has its line breaks.
    expect(shown.inputs).toEqual(
      expect.arrayContaining([
        { key: "config.title", value: "Leave policy" },
        { key: "config.content", value: stored }
      ])
    );
  });

  it("shows a change as the paragraph before and after, against the stored skill", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: { ...skill("kai-leave", changed), title: "Leave policy" },
      expectedRevision: 1
    });

    const shown = await preview(t.admin.id, requestId);

    expect(shown.asset).toMatchObject({
      kind: "skill",
      title: "Leave policy",
      namespace: "kai-",
      isNew: false,
      previous: { title: "kai-leave" },
      content: {
        isNewSkill: false,
        changes: [{ type: "replace", target: "root", before: OLD_PARAGRAPH, after: NEW_PARAGRAPH }]
      }
    });
    expect(shown.asset.beforeWithheld).toBeUndefined();
  });

  // The request is open to who may decide it. The stored text is open to who may read the
  // skill. A person with the first and without the second is shown the title alone.
  it("shows nothing of the stored skill to a reader who may not read it", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    await t.seedHistoricalGrant(t.admin.id, "skill.read", { namespace: "kai-" }, "deny");
    await t.expectRefused(
      t.admin.id,
      "assets.get",
      { params: { kind: "skill", name: "kai-leave" } },
      t.forbidden("skill.read", "denied")
    );
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: { ...skill("kai-leave", changed), title: "Leave policy" },
      expectedRevision: 1
    });

    const shown = await preview(t.admin.id, requestId);

    expect(shown.asset).toMatchObject({
      beforeWithheld: true
    });
    expect(shown.asset.previous).toBeUndefined();
    expect(shown.asset.content).toBeUndefined();
    expect(shown.asset.isNew).toBeUndefined();
    expect(JSON.stringify(shown)).not.toContain(OLD_PARAGRAPH);
    // Kai may read the skill and is shown the paragraph it had.
    expect(JSON.stringify(await preview(t.kai.id, requestId))).toContain(OLD_PARAGRAPH);
  });

  it("withholds held asset input when its module no longer provides a readable preview", async () => {
    let switchedOff = false;
    const { t, holding, hold } = await setup(() => ({
      modules: {
        modules: [],
        isEnabled: () => true,
        offModuleOf: (contribution, name) =>
          switchedOff && contribution === "kind" && name === "skill" ? "assetManagement" : undefined
      }
    }));
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: { ...skill("kai-leave", changed), title: "Leave policy" }
    });
    switchedOff = true;
    const detail = (
      await t.expectOk(t.admin.id, "approval_requests.get", { params: { requestId } })
    ).json();
    expect(detail.preview.asset).toBeUndefined();
    expect(detail.payload.input).toBeUndefined();
    expect(detail.preview.inputs).toEqual([]);
    expect(detail.preview.inputFieldCount).toBe(0);
    expect(JSON.stringify(detail)).not.toContain(NEW_PARAGRAPH);
    expect(
      (await t.stores.approvals.getApprovalRequest({ clientInstanceId, requestId }))?.payload.input
    ).toBeDefined();
  });

  it("withholds pending input from an approver without read rights, including the list payload", async () => {
    const { t, holding, hold } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    await t.grant(
      t.admin.id,
      "skill.read",
      { assetId: await t.assetId("skill", "kai-leave") },
      "deny"
    );
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-leave", {
      config: { ...skill("kai-leave", changed), title: "Leave policy" },
      expectedRevision: 1
    });
    const detail = (
      await t.expectOk(t.admin.id, "approval_requests.get", { params: { requestId } })
    ).json();
    expect(detail.canDecide).toBe(true);
    expect(detail.preview.asset).toMatchObject({ title: "Leave policy", beforeWithheld: true });
    expect(detail.payload.input).toBeUndefined();
    expect(detail.preview.inputs).toEqual([]);
    expect(JSON.stringify(detail)).not.toContain(NEW_PARAGRAPH);
    const listed = (
      await t.expectOk(t.admin.id, "approval_requests.list", { query: { status: "pending" } })
    ).json();
    expect(JSON.stringify(listed)).not.toContain(NEW_PARAGRAPH);
    const own = (
      await t.expectOk(t.kai.id, "approval_requests.get", { params: { requestId } })
    ).json();
    expect(own.payload.input.config.content).toBe(changed);
    expect(
      (await t.stores.approvals.getApprovalRequest({ clientInstanceId, requestId }))?.payload.input
    ).toBeDefined();
  });

  // Fails before the fix of the review: an opened request said `isNew` and chose its shape
  // from the stored row before it asked for the read right, so a person without the right
  // learned whether the asset exists.
  it("tells a reader without the read right what the call asks for, whatever is stored", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-faq" },
      payload: { config: skill("kai-faq", stored) }
    });
    await t.seedHistoricalGrant(t.admin.id, "skill.read", { namespace: "kai-" }, "deny");
    await t.seedHistoricalGrant(t.kai.id, "skill.delete", { namespace: "kai-" });
    holding("assets.put");
    // A call that creates under a name that is taken, and a change of a skill that is then
    // deleted while the request waits.
    // Named as absent: the test's caller otherwise fills in the revision the asset is at.
    const collision = await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed),
      expectedRevision: null
    });
    const orphaned = await hold("assets.put", "skill", "kai-faq", {
      config: skill("kai-faq", changed),
      expectedRevision: 1
    });
    await t.expectOk(t.kai.id, "assets.delete", {
      params: { kind: "skill", name: "kai-faq" },
      payload: { expectedRevision: 1 }
    });

    // A non-reader sees only the submitted title and that comparison is withheld.
    for (const [requestId, name] of [
      [collision, "kai-leave"],
      [orphaned, "kai-faq"]
    ] as const) {
      expect((await preview(t.admin.id, requestId)).asset).toEqual({
        kind: "skill",
        name,
        title: name,
        namespace: "kai-",
        beforeWithheld: true
      });
    }
    // Kai may read both and is shown what is stored: the first exists, the second is gone.
    expect((await preview(t.kai.id, collision)).asset).toMatchObject({ isNew: false });
    expect((await preview(t.kai.id, orphaned)).asset).toMatchObject({ isNew: true });

    // A decided preview also withholds the comparison shape from a non-reader.
    await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId: collision },
      payload: { decision: "reject" }
    });
    expect((await preview(t.admin.id, collision)).asset).toEqual({
      kind: "skill",
      name: "kai-leave",
      title: "kai-leave",
      namespace: "kai-",
      beforeWithheld: true
    });
  });

  it("ACCEPT-FIX-9b: withholds a new skill's comparison shape before and after rejection", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.stores.access.createGrant({
      clientInstanceId,
      holderKind: "user",
      holderId: t.admin.id,
      action: "skill.read",
      effect: "deny",
      scopeKind: "instance",
      grantedBy: t.root.id
    });
    holding("assets.put");
    const requestId = await hold("assets.put", "skill", "kai-new", {
      config: { ...skill("kai-new", changed), title: "New policy" }
    });
    const withheld = {
      kind: "skill",
      name: "kai-new",
      title: "New policy",
      beforeWithheld: true
    };
    const before = (await preview(t.admin.id, requestId)).asset;
    expect(before).toMatchObject(withheld);
    expect(before.content).toBeUndefined();
    expect(before.isNew).toBeUndefined();
    await t.expectOk(t.admin.id, "approval_requests.decide", {
      params: { requestId },
      payload: { decision: "reject" }
    });
    const after = (await preview(t.admin.id, requestId)).asset;
    expect(after).toMatchObject(withheld);
    expect(after.content).toBeUndefined();
    expect(after.isNew).toBeUndefined();
  });

  it("names an asset of another kind and shows no content for it", async () => {
    const { t, holding, hold, preview } = await setup();
    holding("assets.put");
    const requestId = await hold("assets.put", "agent", "kai-intake", {
      config: agent("kai-intake", { displayName: "Intake", instructions: "Ask.\nThen file." })
    });

    const shown = await preview(t.admin.id, requestId);

    expect(shown.asset).toEqual({
      kind: "agent",
      name: "kai-intake",
      title: "Intake",
      namespace: "kai-",
      isNew: true
    });
    expect(shown.inputs).toEqual(
      expect.arrayContaining([
        { key: "kind", value: "agent" },
        { key: "config.instructions", value: "Ask.\nThen file." },
        { key: "config.toolNames", value: "[]" }
      ])
    );
  });

  it("describes no asset for an operation that is not assets.put", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.put(t.kai.id, "agent", "kai-intake");
    holding("assets.delete");
    const requestId = await hold("assets.delete", "agent", "kai-intake", { expectedRevision: 1 });

    const shown = await preview(t.admin.id, requestId);

    expect(shown.operation).toBe("assets.delete");
    expect(shown.asset).toBeUndefined();
  });

  // The Inbox asks for a page of requests every few seconds for everyone who decides. A row
  // names the asset from the call itself: the list reads the Namespaces once and no asset.
  it("reads no asset for the rows of a list", async () => {
    const { t, holding, hold } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    holding("assets.put");
    await hold("assets.put", "skill", "kai-leave", {
      config: skill("kai-leave", changed),
      expectedRevision: 1
    });
    await hold("assets.put", "skill", "kai-faq", { config: skill("kai-faq") });
    const assetReads = vi.spyOn(t.stores.configAssets, "getConfigAsset");
    const namespaceReads = vi.spyOn(t.stores.access, "listNamespaceRecords");

    const listed = await t.expectOk(t.admin.id, "approval_requests.list", {
      query: { status: "pending" }
    });

    const assets = listedSchema.parse(listed.json()).items.map((item) => item.preview.asset);
    expect(assets).toEqual(
      expect.arrayContaining([
        { kind: "skill", name: "kai-leave", title: "kai-leave", namespace: "kai-", isNew: false },
        { kind: "skill", name: "kai-faq", title: "kai-faq", namespace: "kai-", isNew: true }
      ])
    );
    expect(assets).toHaveLength(2);
    expect(assetReads).not.toHaveBeenCalled();
    expect(namespaceReads).toHaveBeenCalledTimes(1);
  });
});
