import { describe, expect, it } from "vitest";
import {
  createSkillChangePreview,
  type SkillChangeOperation,
  type SkillConfig
} from "@vivd-catalyst/config-schema";
import { createSkillSourceVersion } from "@vivd-catalyst/tool-execution";
import { applyAtCurrentRevisions } from "./support/asset-revisions";
import {
  clientInstanceId,
  context,
  fixture,
  json,
  requester,
  skill
} from "./support/skill-change-fixture";

const withResource: SkillConfig = {
  ...skill,
  resources: [{ path: "references/payment.md", mediaType: "text/markdown", content: "Pay by invoice." }]
};

const noIban = {
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
} as const;

async function proposeOnResource(newText: string) {
  const f = await fixture(noIban);
  await applyAtCurrentRevisions(f.store.configAssets, {
    clientInstanceId,
    mutations: [{ type: "upsert", kind: "skill", name: skill.name, config: json(withResource) }]
  });
  const ops: SkillChangeOperation[] = [
    { type: "replace_text", target: "references/payment.md", oldText: "Pay by invoice.", newText }
  ];
  const request = await f.workflow.createRequest(requester, context, {
    kind: "skill_change",
    summary: "Change how to pay.",
    payload: json({
      agentName: f.agent.name,
      skillName: skill.name,
      operations: ops,
      baseSourceVersion: createSkillSourceVersion(withResource),
      preview: createSkillChangePreview(withResource, ops)
    })
  });
  return { f, decided: await f.approve(request.id) };
}

// The runtime snapshot leaves a skill's resources out. The guardrails on asset writes read the
// skill an approval writes, so it is read whole: a change to a resource reaches them.
describe("an approved change to a skill resource and the guardrails on asset writes", () => {
  it("writes a resource change the guardrails let through, with the other parts kept", async () => {
    const { f, decided } = await proposeOnResource("Pay within 14 days.");
    expect(decided).toMatchObject({ status: "approved" });
    expect((await f.revisions()).at(-1)?.config).toMatchObject({
      content: skill.content,
      resources: [{ path: "references/payment.md", content: "Pay within 14 days." }]
    });
  });

  it("refuses a resource change a guardrail blocks", async () => {
    const { f, decided } = await proposeOnResource("Pay to DE89 3704 0044 0532 0130 00.");
    expect(decided).toMatchObject({
      status: "superseded",
      applyResult: { execution: "refused", error: { code: "GUARDRAIL_BLOCKED" } }
    });
    expect(JSON.stringify((await f.revisions()).at(-1)?.config)).not.toContain("3704 0044");
  });
});
