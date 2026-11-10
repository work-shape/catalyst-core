import { describe, expect, it } from "vitest";
import { asUserId, conversationMarked } from "@work-shape/catalyst-core";
import { createProposeSkillChangeTool } from "@work-shape/catalyst-tool-execution";
import { accessOf } from "./support/access";
import { renderItem } from "./chat-ui-inbox-harness";
import {
  clientInstanceId,
  context,
  fixture,
  operations,
  requester,
  skill
} from "./support/skill-change-fixture";

// A skill change an agent files after it read a functional mailbox (MBX-1b, acceptance check
// 74): the request carries one flag and nothing of the mail, the Inbox says "Angeregt in einem
// Chat mit privaten Daten, etwa Mails von außen" on it, a sentence true of every mark, and the skill stays at its live revision until approved. Fails
// where a request from a marked conversation reads like any other, or where it stored text
// beyond the agent's own edit and reason.

/** A request the tool files in a private chat of the requester, marked or not. */
async function filed(marked: boolean) {
  const f = await fixture();
  // The person who chatted with the agent, in a private chat of their own.
  const author = await f.store.users.createUser({ clientInstanceId, displayLabel: "Author" });
  const own = await f.store.workspaces.ensurePersonalWorkspace({
    clientInstanceId,
    userId: asUserId(author.id)
  });
  const chat = await f.store.conversations.createConversation({
    clientInstanceId,
    collaborationWorkspaceId: own.id,
    createdByUserId: author.id,
    createdByExternalUserId: author.id,
    visibility: "private",
    title: "Mailbox feedback",
    retainedUntil: "2027-01-01T00:00:00.000Z"
  });
  // What the first call of a mailbox's tool does to the conversation (MBX-1a).
  if (marked) {
    await f.store.conversations.markPersonalData({
      clientInstanceId,
      conversationId: chat.id,
      userId: author.id,
      at: new Date().toISOString()
    });
  }
  const tool = createProposeSkillChangeTool({
    assetSource: f.source,
    policy: f.config.administration.agentConfiguration.agentSkillChanges,
    creator: f.workflow,
    markedConversation: (id) => conversationMarked(f.store, clientInstanceId, id)
  });
  const result = await tool.execute(
    { skillName: skill.name, summary: "Verify facts, as a reader asked by mail.", operations },
    {
      ...f.toolContext,
      toolRequest: { ...f.toolContext.toolRequest, conversationId: chat.id }
    }
  );
  if (result.status !== "success") throw new Error(`Expected a request, got ${result.status}`);
  const output: unknown = result.output;
  const requestId =
    typeof output === "object" && output !== null && "requestId" in output
      ? String(output.requestId)
      : "";
  const request = await f.workflow.getRequest(requester, accessOf(requester), context, requestId);
  return { f, request };
}

describe("a skill change filed from a marked conversation", () => {
  it("carries the flag and no mail, and stays unapplied until approved", async () => {
    const { f, request } = await filed(true);
    expect(request.payload).toMatchObject({ markedConversation: true, operations });
    expect(request.preview).toMatchObject({ markedConversation: true });
    // The edit and its reason, and nothing the mailbox answered.
    expect(Object.keys(request.payload).sort()).toEqual(
      [
        "agentName",
        "baseSourceVersion",
        "markedConversation",
        "operations",
        "preview",
        "skillName",
        "subject"
      ].sort()
    );
    // SKILL-LIVE-1: the live skill keeps its revision until a holder of skill.approve approves.
    expect(await f.revisions()).toHaveLength(1);
    expect(request.status).toBe("pending");
  });

  it("reads like any other request where the conversation is not marked", async () => {
    const { request } = await filed(false);
    expect(request.payload).not.toHaveProperty("markedConversation");
    expect(request.preview).not.toHaveProperty("markedConversation");
  });

  it("shows the line in the Inbox, in German and in English", () => {
    const preview = {
      skillName: "payroll",
      skillTitle: "Gehaltsabrechnungen prüfen",
      isNewSkill: false,
      changes: [{ type: "replace", target: "root", before: "Alt.", after: "Neu." }]
    };
    expect(renderItem({ preview: { ...preview, markedConversation: true } })).toContain(
      "Angeregt in einem Chat mit privaten Daten, etwa Mails von außen"
    );
    expect(
      renderItem({ preview: { ...preview, markedConversation: true } }, { locale: "en" })
    ).toContain("Prompted in a chat with private data, such as mail from outside");
    expect(renderItem({ preview })).not.toContain(
      "Angeregt in einem Chat mit privaten Daten, etwa Mails von außen"
    );
  });
});
