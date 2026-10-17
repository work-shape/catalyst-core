import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createApiClient, type ConversationListItem } from "@work-shape/catalyst-api-client";
import type { CommandPaletteProps } from "@work-shape/catalyst-ui";
import { expect, it, vi } from "vitest";
import { ConversationPalette } from "./support/chat-ui";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The overlay mounts in a browser. Render its item labels here to test the palette's own
// title mapping; the real query hook and translation catalog stay in use.
vi.mock("@work-shape/catalyst-ui", async (importOriginal) => {
  const library = await importOriginal<typeof import("@work-shape/catalyst-ui")>();
  return {
    ...library,
    CommandPalette: ({ groups }: CommandPaletteProps) =>
      createElement(
        "ul",
        null,
        groups.flatMap((group) =>
          group.items.map((item) =>
            createElement("li", { key: item.value, "data-value": item.value }, item.label)
          )
        )
      )
  };
});

const noop = () => undefined;

function conversation(id: string, title: string): ConversationListItem {
  return {
    id,
    title,
    clientInstanceId: "client",
    collaborationWorkspaceId: "workspace",
    createdByUserId: "user",
    createdByExternalUserId: "external",
    visibility: "workspace",
    status: "active",
    createdAt: "2026-10-17T00:00:00.000Z",
    updatedAt: "2026-10-17T00:00:00.000Z",
    retainedUntil: "2027-10-17T00:00:00.000Z"
  };
}

it("translates only the stored placeholder title in command-palette items", () => {
  const recentConversations = [
    conversation("new", "New conversation"),
    conversation("named", "New conversation about Q3")
  ];
  for (const [locale, shown] of [
    ["en", "New conversation"],
    ["de", "Neue Unterhaltung"]
  ] as const) {
    const queryClient = new QueryClient();
    try {
      const markup = renderToStaticMarkup(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            TranslationProvider,
            { children: null, locale },
            createElement(ConversationPalette, {
              open: true,
              apiBaseUrl: "https://example.test",
              authScope: "user",
              client: createApiClient({ baseUrl: "https://example.test" }),
              collaborationWorkspaceId: "workspace",
              collaborationWorkspacesAvailable: true,
              searchedWorkspaceName: "Team",
              recentConversations,
              goToTargets: [],
              onNewChat: noop,
              onSelectConversation: noop,
              onGoTo: noop,
              onClose: noop
            })
          )
        )
      );
      expect(markup).toContain(`<li data-value="new">${shown}</li>`);
      expect(markup).toContain('<li data-value="named">New conversation about Q3</li>');
    } finally {
      queryClient.clear();
    }
  }
  expect(recentConversations[0]?.title).toBe("New conversation");
});
