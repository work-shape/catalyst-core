// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { personalWorkspace, sharedWorkspace } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";
import {
  ClosedWorkspaceLinkBanner,
  useCollaborationWorkspaceModel,
  type CollaborationWorkspaceModelInput
} from "./support/chat-ui";

// ACCEPT-FIX-10 C5: Kai, no member of Nordlicht, opened a link to a Nordlicht conversation and
// was put in his own workspace without a word. The page still goes to his own workspace, and
// now says why.

type Model = ReturnType<typeof useCollaborationWorkspaceModel>;

async function openLink(memberships: ReturnType<typeof sharedWorkspace>[]) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const client = createApiClient({
    baseUrl: "https://chat.example.com",
    fetchImpl: async () => Response.json({ items: memberships })
  });
  const goTo = vi.fn();
  let model: Model | undefined;
  const input: CollaborationWorkspaceModelInput = {
    apiBaseUrl: "https://chat.example.com",
    authScope: "closed-link-test",
    client,
    isAuthenticated: true,
    enabled: true,
    userId: "user_1",
    route: {
      kind: "conversation",
      collaborationWorkspaceId: "cw_nordlicht",
      conversationId: "c_1"
    },
    loadedConversationCollaborationWorkspaceId: undefined,
    legacyConversationUnavailable: false,
    goToCollaborationWorkspace: goTo,
    showConversation: () => undefined,
    showSettings: () => undefined
  };
  function Probe() {
    model = useCollaborationWorkspaceModel(input);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  await vi.waitFor(() => expect(model?.loading).toBe(false), { timeout: CONDITION_WAIT_MS });
  await act(async () => undefined);
  return { model: () => model, goTo, unmount: () => act(() => root.unmount()) };
}

describe("a link into a workspace the person is no member of", () => {
  it("leads to their own workspace and says why, until dismissed", async () => {
    const opened = await openLink([personalWorkspace()]);
    try {
      expect(opened.goTo).toHaveBeenCalledWith("cw_personal", { replace: true });
      expect(opened.model()?.closedLinkLeftHere).toBe(true);
      await act(async () => opened.model()?.dismissClosedLink());
      expect(opened.model()?.closedLinkLeftHere).toBe(false);
    } finally {
      await opened.unmount();
    }
  });

  it("says nothing where the person is a member", async () => {
    const opened = await openLink([personalWorkspace(), sharedWorkspace({ id: "cw_nordlicht" })]);
    try {
      expect(opened.goTo).not.toHaveBeenCalled();
      expect(opened.model()?.closedLinkLeftHere).toBe(false);
    } finally {
      await opened.unmount();
    }
  });

  it.each([
    { locale: "en" as const, said: "not a member of" },
    { locale: "de" as const, said: "kein Mitglied" }
  ])("is said in the person's language ($locale)", ({ locale, said }) => {
    const markup = renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale,
        children: createElement(ClosedWorkspaceLinkBanner, { onDismiss: () => undefined })
      })
    );
    expect(markup).toContain(said);
  });
});
