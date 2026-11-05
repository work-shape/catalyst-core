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

// An approved change to a shared skill goes live on approval. A pending draft of the skill gets
// the same change and moves onto the new live revision: its own edits stay unpublished, and
// publishing it later keeps the change. A draft the change does not apply to stays behind.

async function sharedSkill() {
  const f = await fixture(undefined, "shared");
  const live = await f.store.configAssets.getConfigAsset({
    clientInstanceId,
    kind: "skill",
    name: skill.name
  });
  if (!live) throw new Error("Skill missing");
  const draft = () => f.store.agentProposals.get({ clientInstanceId, agentId: live.id });
  const saveDraft = (content: string) =>
    f.store.agentProposals.save({
      clientInstanceId,
      agentId: live.id,
      baseRevision: live.revision,
      expectedDraftRevision: null,
      config: json({ ...skill, content }),
      author: { userId: asUserId(requester.id), release: false },
      savedAt: new Date().toISOString()
    });
  const liveContent = async () => (await f.source.getSkill(skill.name))?.content;
  const undo = (requestId: string) =>
    f.workflow.revertRequest(reviewer, accessOf(reviewer), context, requestId);
  return { ...f, live, draft, saveDraft, liveContent, undo };
}

describe("approved changes to a shared skill", () => {
  it("go live on approval without a draft, and an undo writes the live skill back", async () => {
    const f = await sharedSkill();
    const request = await f.propose();
    expect(await f.approve(request.id)).toMatchObject({
      status: "approved",
      applyResult: { skillName: skill.name, revision: 2 }
    });
    expect(await f.liveContent()).toBe("Verify facts.\n\nKeep evidence.");
    expect(await f.draft()).toBeUndefined();
    await f.undo(request.id);
    expect(await f.liveContent()).toBe(skill.content);
    expect(await f.revisions()).toHaveLength(3);
  });

  it("go live without the pending draft's edits, which get the change and move onto it", async () => {
    const f = await sharedSkill();
    const saved = await f.saveDraft(`Private draft note.\n\n${skill.content}`);
    const request = await f.propose();
    const pending = await f.workflow.getRequest(
      requester,
      accessOf(requester),
      context,
      request.id
    );
    expect(JSON.stringify(pending.preview)).not.toContain("Private draft note");
    const approved = await f.approve(request.id);
    expect(approved).toMatchObject({ status: "approved", applyResult: { revision: 2 } });
    expect(JSON.stringify(approved.applyResult)).not.toContain("Private draft note");
    // Live has the change and nothing of the draft.
    expect(await f.liveContent()).toBe("Verify facts.\n\nKeep evidence.");
    // The draft keeps its edits and its author, gains the change and stands on revision 2.
    const draft = await f.draft();
    expect(draft).toMatchObject({
      revision: (saved?.revision ?? 0) + 1,
      baseRevision: 2,
      author: { userId: requester.id },
      config: { content: "Private draft note.\n\nVerify facts.\n\nKeep evidence." }
    });
    if (!draft) throw new Error("Draft missing");
    // Publishing the draft later keeps the approved change.
    await f.store.configAssets.applyConfigAssetMutations({
      clientInstanceId,
      baseRevisions: { [`skill:${skill.name}`]: draft.baseRevision },
      mutations: [
        {
          type: "upsert",
          kind: "skill",
          name: skill.name,
          scope: f.owner,
          config: draft.config,
          agentPublish: draft.revision
        }
      ]
    });
    expect(await f.liveContent()).toBe("Private draft note.\n\nVerify facts.\n\nKeep evidence.");
    expect(await f.draft()).toBeUndefined();
  });

  it("leave a draft the change does not apply to behind, so its publish is refused as stale", async () => {
    const f = await sharedSkill();
    const saved = await f.saveDraft("Rewritten from scratch.");
    const request = await f.propose();
    expect(await f.approve(request.id)).toMatchObject({ status: "approved" });
    expect(await f.liveContent()).toBe("Verify facts.\n\nKeep evidence.");
    expect(await f.draft()).toMatchObject({
      revision: saved?.revision,
      baseRevision: f.live.revision,
      config: { content: "Rewritten from scratch." }
    });
    await expect(
      f.store.configAssets.applyConfigAssetMutations({
        clientInstanceId,
        baseRevisions: { [`skill:${skill.name}`]: 2 },
        mutations: [
          {
            type: "upsert",
            kind: "skill",
            name: skill.name,
            scope: f.owner,
            config: json({ ...skill, content: "Rewritten from scratch." }),
            agentPublish: saved?.revision ?? 0
          }
        ]
      })
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "stale_base" } });
  });

  it("recovers the live write when recording the approval decision fails", async () => {
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
    expect(
      await f.store.approvals.getApprovalRequest({ clientInstanceId, requestId: request.id })
    ).toMatchObject({ status: "pending" });
    expect(await f.approve(request.id)).toMatchObject({
      status: "approved",
      applyResult: { revision: 2 }
    });
    expect(await f.revisions()).toHaveLength(2);
  });
});
