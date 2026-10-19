import { describe, expect, it, vi } from "vitest";

// One verb per right, said the same by an agent's refusal and every rights screen: the
// interface takes core's `RIGHT_VERB_WORDS` and keeps no verb dictionary of its own. Core's
// words are swapped here, so a screen that spells a verb itself no longer follows them.

vi.mock("@work-shape/catalyst-core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@work-shape/catalyst-core")>();
  return {
    ...core,
    RIGHT_VERB_WORDS: {
      ...core.RIGHT_VERB_WORDS,
      write: { en: "core-edit", de: "core-bearbeiten" },
      approve: { en: "core-approve", de: "core-freigeben" }
    }
  };
});

describe("the verbs of the rights screens", () => {
  it("are core's words for a right, in both languages", async () => {
    const { createTranslationContext } = await import("@work-shape/catalyst-chat-ui");
    const { actionLabel } = await import("@work-shape/catalyst-chat-ui/access");
    const en = createTranslationContext("en").t;
    const de = createTranslationContext("de").t;

    expect(actionLabel("agent.write", en)).toBe("Core-edit agents");
    expect(actionLabel("agent.write", de)).toBe("Agenten core-bearbeiten");
    expect(actionLabel("skill.approve", en)).toBe("Core-approve skills");
    expect(actionLabel("skill.approve", de)).toBe("Skills core-freigeben");
    // A verb core did not change keeps its words.
    expect(actionLabel("connection.use", de)).toBe("Verbindungen verwenden");
  });
});
