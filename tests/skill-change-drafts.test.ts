import { describe, expect, it, vi } from "vitest";
import { asUserId } from "@work-shape/catalyst-core";
import { accessOf } from "./support/access";
import {
  clientInstanceId,
  context,
  fixture,
  json,
  requester,
  reviewer,
  skill
} from "./support/skill-change-fixture";

async function sharedSkill() {
  const f = await fixture(undefined, "shared");
  const live = await f.store.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "skill",
    name: skill.name
  });
  if (!live) throw new Error("Skill missing");
  const draft = () => f.store.agentProposals.get({ clientInstanceId, agentId: live.id });
  const undo = (requestId: string) =>
    f.workflow.revertRequest(reviewer, accessOf(reviewer), context, requestId);
  return { ...f, live, draft, undo };
}

describe("approved changes to a shared skill", () => {
  it("combines independent approvals in the draft while keeping live history unchanged", async () => {
    const f = await sharedSkill();
    const first = await f.propose();
    const second = await f.propose([
      { type: "replace_text", target: "root", oldText: "Keep", newText: "Retain" }
    ]);
    expect(await f.approve(first.id)).toMatchObject({
      status: "approved",
      applyResult: { draftRevision: 1, publishedRevision: 1 }
    });
    expect(await f.approve(second.id)).toMatchObject({
      status: "approved",
      applyResult: { draftRevision: 2, publishedRevision: 1 }
    });
    expect(await f.draft()).toMatchObject({
      config: { content: "Verify facts.\n\nRetain evidence." }
    });
    expect(await f.revisions()).toHaveLength(1);
    expect((await f.source.getSkill(skill.name))?.content).toBe(skill.content);
    // An older approval cannot undo work saved afterwards.
    await expect(f.undo(first.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.undo(second.id);
    expect(await f.draft()).toMatchObject({
      revision: 3,
      config: { content: "Verify facts.\n\nKeep evidence." }
    });
    expect(await f.revisions()).toHaveLength(1);
  });

  it("keeps another writer's draft out of the requester's preview and approval receipt", async () => {
    const f = await sharedSkill();
    await f.store.agentProposals.save({
      clientInstanceId,
      agentId: f.live.id,
      baseRevision: f.live.revision,
      expectedDraftRevision: null,
      config: json({ ...skill, content: `Private draft note.\n\n${skill.content}` }),
      author: { userId: asUserId(reviewer.id), release: false },
      savedAt: new Date().toISOString()
    });
    const request = await f.propose();
    const pending = await f.workflow.getRequest(
      requester,
      accessOf(requester),
      context,
      request.id
    );
    expect(JSON.stringify(pending.preview)).not.toContain("Private draft note");
    const approved = await f.approve(request.id);
    expect(approved).toMatchObject({ status: "approved" });
    expect(JSON.stringify(approved.applyResult)).not.toContain("Private draft note");
    expect(await f.draft()).toMatchObject({
      config: { content: "Private draft note.\n\nVerify facts.\n\nKeep evidence." }
    });
  });

  it("undoes the first draft without writing a live revision", async () => {
    const f = await sharedSkill();
    const request = await f.propose();
    await f.approve(request.id);
    await f.undo(request.id);
    expect(await f.draft()).toBeUndefined();
    expect(await f.revisions()).toHaveLength(1);
  });

  it("rolls the draft back when recording the approval decision fails", async () => {
    const f = await sharedSkill();
    const request = await f.propose();
    const transition = f.store.approvals.transitionPendingApprovalRequest.bind(f.store.approvals);
    const failing = vi
      .spyOn(f.store.approvals, "transitionPendingApprovalRequest")
      .mockImplementationOnce((input) =>
        transition({
          ...input,
          resolve: async (pending, stores) => {
            await input.resolve(pending, stores);
            throw new Error("Decision storage failed");
          }
        })
      );
    await expect(f.approve(request.id)).rejects.toThrow("Decision storage failed");
    failing.mockRestore();
    expect(await f.draft()).toBeUndefined();
    expect(await f.revisions()).toHaveLength(1);
    expect(
      await f.store.approvals.getApprovalRequest({ clientInstanceId, requestId: request.id })
    ).toMatchObject({ status: "pending" });
    expect(await f.approve(request.id)).toMatchObject({ status: "approved" });
  });
});
