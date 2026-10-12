import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { operationRunSchema } from "@vivd-catalyst/api-contract";
import type { CentralPolicySetting } from "@vivd-catalyst/core";
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
async function setup() {
  let settings: CentralPolicySetting[] = [];
  const t = await setupNamespaceHolder({
    operations: { centralPolicySettings: () => settings }
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
  // skill. A person with the first and without the second is shown the new text alone.
  it("shows nothing of the stored skill to a reader who may not read it", async () => {
    const { t, holding, hold, preview } = await setup();
    await t.expectOk(t.kai.id, "assets.put", {
      params: { kind: "skill", name: "kai-leave" },
      payload: { config: skill("kai-leave", stored) }
    });
    await t.grant(t.admin.id, "skill.read", { namespace: "kai-" }, "deny");
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
      isNew: false,
      beforeWithheld: true,
      content: { changes: [{ type: "replace", target: "root", after: changed }] }
    });
    expect(shown.asset.previous).toBeUndefined();
    expect(JSON.stringify(shown)).not.toContain(OLD_PARAGRAPH);
    // Kai may read the skill and is shown the paragraph it had.
    expect(JSON.stringify(await preview(t.kai.id, requestId))).toContain(OLD_PARAGRAPH);
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
    await t.grant(t.admin.id, "skill.read", { namespace: "kai-" }, "deny");
    await t.grant(t.kai.id, "skill.delete", { namespace: "kai-" });
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

    // The answer is the one the input alone gives: a create is new and whole, a change is a
    // change with nothing to compare.
    expect((await preview(t.admin.id, collision)).asset).toEqual({
      kind: "skill",
      name: "kai-leave",
      title: "kai-leave",
      namespace: "kai-",
      isNew: true,
      description: "A skill",
      content: {
        skillName: "kai-leave",
        skillTitle: "kai-leave",
        isNewSkill: true,
        changes: [],
        newSkill: {
          name: "kai-leave",
          title: "kai-leave",
          description: "A skill",
          content: changed
        }
      }
    });
    expect((await preview(t.admin.id, orphaned)).asset).toEqual({
      kind: "skill",
      name: "kai-faq",
      title: "kai-faq",
      namespace: "kai-",
      isNew: false,
      description: "A skill",
      beforeWithheld: true,
      content: {
        skillName: "kai-faq",
        skillTitle: "kai-faq",
        isNewSkill: false,
        changes: [{ type: "replace", target: "root", after: changed }]
      }
    });
    // Kai may read both and is shown what is stored: the first exists, the second is gone.
    expect((await preview(t.kai.id, collision)).asset).toMatchObject({ isNew: false });
    expect((await preview(t.kai.id, orphaned)).asset).toMatchObject({ isNew: true });
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
