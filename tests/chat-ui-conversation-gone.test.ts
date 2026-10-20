import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { ConversationGone, isConversationGone } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// An address of a conversation that is gone once opened an empty chat: no messages, no title,
// only the composer, and nothing said why. The instance refuses the thread read alike for every
// way a conversation can be gone, so each of them reaches the interface as the same answer.

/** The instance's refusal of a thread read, as the API client hands it over. */
function refusal(status: number) {
  return new ApiError(status, "Conversation is not available", {
    error: {
      code: status === 404 ? "NOT_FOUND" : "FORBIDDEN",
      message: "Conversation is not available"
    }
  });
}

describe("a conversation that is gone", () => {
  it.each([
    ["deleted", refusal(404)],
    ["expired", refusal(404)],
    ["in a workspace the person does not reach", refusal(404)],
    ["never made", refusal(404)],
    ["refused outright", refusal(403)]
  ])("is gone when it was %s", (_case, error) => {
    expect(isConversationGone(error)).toBe(true);
  });

  it.each([
    ["no answer yet", undefined],
    ["a failure of the instance", new ApiError(500, "Internal error", {})],
    ["a rate limit", new ApiError(429, "Too many requests", {})],
    ["a lost connection", new TypeError("Failed to fetch")]
  ])("is not gone after %s: that load may still work", (_case, error) => {
    expect(isConversationGone(error)).toBe(false);
  });

  it.each([
    ["en", "This conversation no longer exists.", "New chat"],
    ["de", "Diese Unterhaltung gibt es nicht mehr.", "Neuer Chat"]
  ] as const)(
    "says so in %s, as the page's one title, with a new chat as the step",
    (locale, sentence, action) => {
      const markup = renderToStaticMarkup(
        createElement(TranslationProvider, {
          locale,
          children: createElement(ConversationGone, { onNewChat: () => undefined })
        })
      );
      expect(markup).toContain("data-not-found");
      expect(markup).toContain("data-conversation-gone");
      expect(markup.match(/<h1[\s>]/gu)).toHaveLength(1);
      expect(markup).toContain(`>${sentence}</h1>`);
      expect(markup).toMatch(new RegExp(`<button[^>]*>${action}</button>`, "u"));
      // No composer and no thread stand beside it.
      expect(markup).not.toContain("<textarea");
    }
  );
});
