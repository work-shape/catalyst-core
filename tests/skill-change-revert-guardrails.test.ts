import { describe, expect, it } from "vitest";
import {
  createSkillChangePreview,
  type SkillChangeOperation
} from "@work-shape/catalyst-config-schema";
import { createSkillSourceVersion } from "@work-shape/catalyst-tool-execution";
import { accessOf } from "./support/access";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  clientInstanceId,
  context,
  fixture,
  json,
  requester,
  reviewer,
  skill
} from "./support/skill-change-fixture";

describe("GR-2b verify: reverting an approved skill change", () => {
  // `approval_requests.revert` writes the skill's revision before the change back, past every
  // guardrail: a revision written before the guardrail existed returns unread, which
  // `assets.revert` refuses since GR-2b.
  it("refuses to revert to a revision a guardrail on asset writes blocks", async () => {
    const iban = "DE89 3704 0044 0532 0130 00";
    const f = await fixture({
      no_iban: {
        displayName: "No IBAN in skills",
        on: "asset.before_write",
        filter: { kind: "skill" },
        check: {
          kind: "pattern",
          pattern: "(?i)\\bDE\\d{2}(?:\\s?\\d{4}){4}\\s?\\d{2}\\b",
          reason: "Skills hold no bank account."
        },
        outcome: "block"
      }
    });
    // Revision 2 as a release before the guardrail left it: written past every check.
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        {
          type: "upsert",
          scope: f.owner,
          kind: "skill",
          name: skill.name,
          config: json({ ...skill, content: `${skill.content}\n\nPay to ${iban}.` })
        }
      ]
    });
    // The agent proposes to remove the IBAN; the guardrail lets that through.
    const marked = { ...skill, content: `${skill.content}\n\nPay to ${iban}.` };
    const ops: SkillChangeOperation[] = [
      {
        type: "replace_text",
        target: "root",
        oldText: `Pay to ${iban}.`,
        newText: "Pay by invoice."
      }
    ];
    const request = await f.workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Remove the account.",
      payload: json({
        agentName: f.agent.name,
        skillName: skill.name,
        operations: ops,
        baseSourceVersion: createSkillSourceVersion(marked),
        preview: createSkillChangePreview(marked, ops)
      })
    });
    expect(await f.approve(request.id)).toMatchObject({ status: "approved" });
    const reverted = f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id);
    await expect(reverted).rejects.toMatchObject({ code: "GUARDRAIL_BLOCKED" });
    expect(JSON.stringify((await f.revisions()).at(-1)?.config)).not.toContain("3704 0044");
  });
  // Fails without the change: an undo that was written while recording its status failed was
  // asked of the guardrails again, which blocked what is already written, and the request
  // stayed approved with its change undone.
  it("recovers an undo that was written but not recorded, without asking again", async () => {
    const iban = "DE89 3704 0044 0532 0130 00";
    const f = await fixture({
      no_iban: {
        displayName: "No IBAN in skills",
        on: "asset.before_write",
        filter: { kind: "skill" },
        check: {
          kind: "pattern",
          pattern: "(?i)\\bDE\\d{2}(?:\\s?\\d{4}){4}\\s?\\d{2}\\b",
          reason: "Skills hold no bank account."
        },
        outcome: "block"
      }
    });
    const marked = { ...skill, content: `${skill.content}\n\nPay to ${iban}.` };
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      mutations: [
        { type: "upsert", scope: f.owner, kind: "skill", name: skill.name, config: json(marked) }
      ]
    });
    const ops: SkillChangeOperation[] = [
      {
        type: "replace_text",
        target: "root",
        oldText: `Pay to ${iban}.`,
        newText: "Pay by invoice."
      }
    ];
    const request = await f.workflow.createRequest(requester, context, {
      kind: "skill_change",
      summary: "Remove the account.",
      payload: json({
        agentName: f.agent.name,
        skillName: skill.name,
        operations: ops,
        baseSourceVersion: createSkillSourceVersion(marked),
        preview: createSkillChangePreview(marked, ops)
      })
    });
    expect(await f.approve(request.id)).toMatchObject({ status: "approved" });
    // An earlier undo of the request wrote the revision back before a release with the
    // guardrail, and failed to record that the request was undone.
    await applyAtCurrentRevisions(f.store.configAssets, {
      clientInstanceId,
      origin: { kind: "approval_request", requestId: request.id, summary: request.summary },
      mutations: [
        {
          type: "upsert",
          scope: f.owner,
          kind: "skill",
          name: skill.name,
          operation: "revert",
          config: json(marked)
        }
      ]
    });
    const revisions = (await f.revisions()).length;
    expect(
      await f.workflow.revertRequest(reviewer, accessOf(reviewer), context, request.id)
    ).toMatchObject({ status: "reverted" });
    expect(await f.revisions()).toHaveLength(revisions);
  });
});
