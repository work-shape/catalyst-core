import { describe, expect, it } from "vitest";
import { z } from "zod";
import { operationRunSchema } from "@work-shape/catalyst-api-contract";
import type { CentralPolicySetting } from "@work-shape/catalyst-core";
import { clientInstanceId, skill } from "./support/access-instance";
import { setupWorkspaceHolder } from "./support/asset-operations";

// `skill.approve` on one skill decides a person's held save of that skill, beside
// `operations.approve`, as `connection.approve` does for a Connection: the request is listed to
// its holder, the approver names the skill page and the request give include them, and the
// held saves of other skills stay out of reach. Kai saves the skills of Kai's team; Lena
// holds `skill.approve` on one of them.

const listed = z.object({ items: z.array(z.object({ id: z.string(), canDecide: z.boolean() })) });
const saveApproval = z.object({
  saveApproval: z.object({ approverNames: z.array(z.string()) })
});

async function setup() {
  let settings: CentralPolicySetting[] = [];
  const t = await setupWorkspaceHolder({
    operations: { centralPolicySettings: () => settings }
  });
  await t.put(t.kai.id, "skill", "kai-leave", t.kaiTeam);
  await t.put(t.kai.id, "skill", "kai-travel", t.kaiTeam);
  const leave = await t.assetId("skill", "kai-leave");
  await t.grant(t.lena.id, "skill.approve", { assetId: leave });
  // Kai sees Lena's name only where they share a workspace.
  const team = await t.sharedWorkspace("Approval team");
  for (const user of [t.kai, t.lena]) {
    await t.stores.workspaces.addMembership({
      clientInstanceId,
      collaborationWorkspaceId: team,
      userId: user.id,
      role: "member"
    });
  }
  settings = [{ operation: "assets.put", value: "approval" }];
  const hold = async (name: string) => {
    const held = await t.call(t.kai.id, "assets.put", {
      params: { kind: "skill", name },
      payload: { config: skill(name, `# ${name}\n\nChanged.\n`), workspaceId: t.kaiTeam }
    });
    expect(held.statusCode).toBe(202);
    const { approvalRequestId = "" } = operationRunSchema.parse(held.json());
    return approvalRequestId;
  };
  return { t, hold };
}

describe("skill.approve on one skill and a held save of it", () => {
  it("names its holder before and after the save is held", async () => {
    const { t, hold } = await setup();
    const page = (name: string) =>
      t.expectOk(t.kai.id, "assets.get", {
        params: { kind: "skill", name },
        query: { workspaceId: t.kaiTeam }
      });
    expect(saveApproval.parse((await page("kai-leave")).json()).saveApproval.approverNames).toEqual(
      expect.arrayContaining([t.lena.displayLabel])
    );
    expect(
      saveApproval.parse((await page("kai-travel")).json()).saveApproval.approverNames
    ).not.toContain(t.lena.displayLabel);
    const requestId = await hold("kai-leave");
    const item = (
      await t.expectOk(t.kai.id, "approval_requests.get", { params: { requestId } })
    ).json();
    expect(item.preview.approverNames).toEqual(expect.arrayContaining([t.lena.displayLabel]));
  });

  it("lists and decides that skill's held save for its holder, and no other skill's", async () => {
    const { t, hold } = await setup();
    const onLeave = await hold("kai-leave");
    const onTravel = await hold("kai-travel");
    expect(
      listed.parse((await t.expectOk(t.lena.id, "approval_requests.list")).json()).items
    ).toEqual([{ id: onLeave, canDecide: true }]);
    const decide = (requestId: string) =>
      t.call(t.lena.id, "approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });
    expect((await decide(onTravel)).statusCode).toBe(404);
    const decided = await decide(onLeave);
    expect(decided.statusCode).toBe(200);
    expect(decided.json()).toMatchObject({ id: onLeave, status: "approved" });
  });
});
