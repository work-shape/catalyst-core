import { describe, expect, it } from "vitest";
import { dockConversationToReuse } from "./support/chat-ui";

// ACCEPT-1c C12: pressing "Edit with the agent" again made a second conversation. The page
// head's "Chat", which took its place on every asset page, opens the dock's conversation about
// the same asset again.

describe("pressing Chat on an asset's page again", () => {
  const subject = { kind: "app", name: "orders" };
  const base = {
    dockConversationId: "conv_1",
    dock: { subject, collaborationWorkspaceId: "cw_1" },
    subject,
    workspaceId: "cw_1",
    prompt: undefined,
    draftText: ""
  };

  it("opens the dock's conversation about the same asset again", () => {
    expect(dockConversationToReuse(base)).toBe("conv_1");
    // Also with a half-typed message: nothing is put in the composer.
    expect(dockConversationToReuse({ ...base, draftText: "Make the" })).toBe("conv_1");
    // A prompt goes into an empty composer, or one that already holds it.
    expect(dockConversationToReuse({ ...base, prompt: "Fix it" })).toBe("conv_1");
    expect(dockConversationToReuse({ ...base, prompt: "Fix it", draftText: "Fix it" })).toBe(
      "conv_1"
    );
  });

  it("makes a new conversation where the dock's conversation is about the same name in another workspace", () => {
    // An App "orders" of another workspace is another App: its conversation is never opened
    // in this one, nor typed into.
    expect(
      dockConversationToReuse({
        ...base,
        dock: { subject, collaborationWorkspaceId: "cw_other" }
      })
    ).toBeUndefined();
    expect(
      dockConversationToReuse({
        ...base,
        dock: { subject, collaborationWorkspaceId: "cw_other" },
        prompt: "Fix it"
      })
    ).toBeUndefined();
  });

  it("makes a new conversation where the dock holds another one or the person's own words", () => {
    expect(dockConversationToReuse({ ...base, dockConversationId: undefined })).toBeUndefined();
    expect(dockConversationToReuse({ ...base, dock: undefined })).toBeUndefined();
    expect(
      dockConversationToReuse({ ...base, dock: { ...base.dock, subject: undefined } })
    ).toBeUndefined();
    expect(
      dockConversationToReuse({
        ...base,
        dock: { ...base.dock, subject: { kind: "app", name: "invoices" } }
      })
    ).toBeUndefined();
    expect(
      dockConversationToReuse({
        ...base,
        dock: { ...base.dock, subject: { kind: "workflow", name: "orders" } }
      })
    ).toBeUndefined();
    // A prompt never replaces what the person typed.
    expect(
      dockConversationToReuse({ ...base, prompt: "Fix it", draftText: "My own words" })
    ).toBeUndefined();
  });
});
