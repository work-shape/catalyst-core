import {
  asConversationId,
  asUserId,
  CONVERSATION_RENAME_TOOL_NAME
} from "@work-shape/catalyst-core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createAssetToolsFixture } from "./support/platform-asset-tools";
import { getTestJobs } from "./support/test-instance";

// An agent gives the chat it runs in a title, following a rule in a skill, as the person in the
// chat would with `conversations.rename`. Fails without the change: no agent can rename a chat.

const RENAME = CONVERSATION_RENAME_TOOL_NAME;
const conversationSchema = z.object({ id: z.string() });

const fixture = () => createAssetToolsFixture("in_process", [], { agentTools: [RENAME] });
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function newConversation(t: Fixture): Promise<string> {
  return conversationSchema.parse((await t.ok(t.converse(undefined))).json()).id;
}

async function storedTitle(t: Fixture, conversationId: string): Promise<string | undefined> {
  const stored = await t.app.stores.conversations.getConversation(
    t.clientInstanceId,
    asConversationId(conversationId)
  );
  return stored?.title;
}

describe(`the tool ${RENAME}`, () => {
  it("renames the conversation it runs in, as the person, and no other", async () => {
    const t = await fixture();
    const id = await newConversation(t);
    const other = await newConversation(t);

    // A conversation the model names is no input of the tool.
    expect(
      await t.call(id, RENAME, { title: "  Sample Customer Ltd  ", conversationId: other })
    ).toEqual({ title: "Sample Customer Ltd" });

    expect(await storedTitle(t, id)).toBe("Sample Customer Ltd");
    expect(await storedTitle(t, other)).toBe("Edit");
    const owner = asUserId((await t.app.call("me.get", {})).json<{ id: string }>().id);
    const runs = await t.app.stores.operationRuns.list({ clientInstanceId: t.clientInstanceId });
    expect(runs.filter((run) => run.operation === RENAME)).toEqual([
      expect.objectContaining({
        status: "done",
        actor: expect.objectContaining({ kind: "user", id: owner }),
        origin: expect.objectContaining({ kind: "agent" })
      })
    ]);
    // Governance counts the title and does not hold it.
    const audited = await t.app.stores.audit.listAuditEvents({
      clientInstanceId: t.clientInstanceId
    });
    const renamed = audited.filter((event) => event.type === "conversation.renamed");
    expect(renamed).toEqual([
      expect.objectContaining({
        subject: id,
        metadata: { previousTitleLength: "Edit".length, titleLength: 19 }
      })
    ]);
    expect(JSON.stringify(audited)).not.toContain("Sample Customer");

    // An empty or a too long title is refused and changes nothing.
    for (const title of ["   ", "x".repeat(121)]) {
      await t.say(other, `/tool ${RENAME} ${JSON.stringify({ title })}`);
      expect(await storedTitle(t, other)).toBe("Edit");
    }
  }, 60_000);

  it("is held only by an agent that lists it", async () => {
    const t = await createAssetToolsFixture();
    const id = await newConversation(t);
    const { events } = await t.say(id, `/tool ${RENAME} ${JSON.stringify({ title: "Other" })}`);
    expect(events).not.toContain("tool_call_completed");
    expect(await storedTitle(t, id)).toBe("Edit");
  }, 60_000);
});

describe("the title an agent gives in the first run, and the title job", () => {
  /** A conversation that carries its first message as its temporary title, as the chat's does. */
  async function firstRun(t: Fixture, message: string): Promise<string> {
    const created = await t.ok(t.app.call("conversations.create", { payload: { title: message } }));
    const { id } = conversationSchema.parse(created.json());
    await t.say(id, message);
    await getTestJobs(t.app).runDue();
    return id;
  }

  it("is left by the job, which titles a conversation that got none, and counts as given in the words it carries", async () => {
    const t = await fixture();

    const plain = "please summarize the release notes";
    expect(await storedTitle(t, await firstRun(t, plain))).not.toBe(plain);

    const renamed = await firstRun(t, `/tool ${RENAME} ${JSON.stringify({ title: "Acme Ltd" })}`);
    expect(await storedTitle(t, renamed)).toBe("Acme Ltd");

    const id = await newConversation(t);
    const before = await t.app.stores.conversations.getConversation(
      t.clientInstanceId,
      asConversationId(id)
    );

    expect(await t.call(id, RENAME, { title: "Edit" })).toEqual({ title: "Edit" });

    await expect(
      t.app.stores.conversations.replaceConversationTitle({
        clientInstanceId: t.clientInstanceId,
        conversationId: asConversationId(id),
        expectedTitle: "Edit",
        title: "Generated",
        updatedAt: new Date().toISOString()
      })
    ).resolves.toBe(false);
    const after = await t.app.stores.conversations.getConversation(
      t.clientInstanceId,
      asConversationId(id)
    );
    expect(after?.title).toBe("Edit");
    expect(before?.title).toBe("Edit");
    const audited = await t.app.stores.audit.listAuditEvents({
      clientInstanceId: t.clientInstanceId
    });
    expect(
      audited.filter((event) => event.type === "conversation.renamed" && event.subject === id)
    ).toEqual([]);
  }, 60_000);
});
