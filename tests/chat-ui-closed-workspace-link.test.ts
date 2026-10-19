// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { personalWorkspace, sharedWorkspace } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS } from "./support/assertions";
import {
  ClosedWorkspaceLinkBanner,
  useCollaborationWorkspaceModel,
  workspaceQueryKeys,
  type CollaborationWorkspaceModelInput
} from "./support/chat-ui";

// ACCEPT-FIX-10 C5: Kai, no member of Nordlicht, opened a link to a Nordlicht conversation and
// was put in his own workspace without a word. The page still goes to his own workspace, and
// now says why. ACCEPT-2d C-4: it also names whom to ask, as the instance's refusal of the
// workspace names its owners and admins.

type Model = ReturnType<typeof useCollaborationWorkspaceModel>;

const linkedWorkspacePath = apiOperations["workspaces.get"].path.replace(
  ":collaborationWorkspaceId",
  "cw_nordlicht"
);

const ensurePersonalPath = apiOperations["workspaces.ensure_personal"].path;

async function openLink(
  memberships: ReturnType<typeof sharedWorkspace>[],
  /** The owners and admins the instance names when it refuses the linked workspace. */
  administrators: unknown = [],
  /** The memberships once `workspaces.ensure_personal` made the Personal Workspace. */
  ensured?: ReturnType<typeof sharedWorkspace>[]
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const reads: string[] = [];
  let listed = memberships;
  const client = createApiClient({
    baseUrl: "https://chat.example.com",
    fetchImpl: async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname === linkedWorkspacePath) {
        reads.push(url.pathname);
        return Response.json(
          { error: { code: "NOT_FOUND", message: "none", details: { administrators } } },
          { status: 404 }
        );
      }
      if (url.pathname === ensurePersonalPath && ensured !== undefined) {
        listed = ensured;
        return Response.json(ensured.find((workspace) => workspace.kind === "personal"));
      }
      return Response.json({ items: listed });
    }
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
  // The memberships have been read, and the model has heard of it: React Query tells its
  // observers on a timer queued when the read settles, so a timer queued after it runs later.
  const membershipsKey = workspaceQueryKeys.collaborationWorkspaces(
    input.apiBaseUrl,
    input.authScope
  );
  await vi.waitFor(
    () => expect(queryClient.getQueryState(membershipsKey)?.status).toBe("success"),
    { timeout: CONDITION_WAIT_MS }
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  await act(async () => undefined);
  return { model: () => model, goTo, reads, unmount: () => act(() => root.unmount()) };
}

describe("a link into a workspace the person is no member of", () => {
  it("leads to their own workspace and says why, until dismissed", async () => {
    const opened = await openLink([personalWorkspace()]);
    try {
      expect(opened.goTo).toHaveBeenCalledWith("cw_personal", { replace: true });
      await vi.waitFor(() => expect(opened.model()?.closedLink).toEqual({ administrators: [] }), {
        timeout: CONDITION_WAIT_MS
      });
      await act(async () => opened.model()?.dismissClosedLink());
      expect(opened.model()?.closedLink).toBeUndefined();
    } finally {
      await opened.unmount();
    }
  });

  it("says nothing where the person is a member", async () => {
    const opened = await openLink([personalWorkspace(), sharedWorkspace({ id: "cw_nordlicht" })]);
    try {
      expect(opened.goTo).not.toHaveBeenCalled();
      expect(opened.model()?.closedLink).toBeUndefined();
      expect(opened.reads).toEqual([]);
    } finally {
      await opened.unmount();
    }
  });

  // A tab whose browser was signed in as another person reads that person's memberships before
  // `/me` names them. The route still names a workspace of the person before; it is no closed
  // link of the person after, so nothing reads it and nothing moves.
  it("reads nothing while the memberships are those of another person", async () => {
    const opened = await openLink([
      { ...personalWorkspace(), id: "cw_personal_b", personalUserId: "user_2" }
    ]);
    try {
      expect(opened.goTo).not.toHaveBeenCalled();
      expect(opened.model()?.closedLink).toBeUndefined();
      expect(opened.model()?.collaborationWorkspaces).toEqual([]);
      expect(opened.reads).toEqual([]);
    } finally {
      await opened.unmount();
    }
  });

  // At the first visit of the person after, their list holds no Personal Workspace until the
  // read makes it; the list the model hears of is theirs all the same.
  it("reads nothing at the first visit of another person", async () => {
    const otherPersonal = { ...personalWorkspace(), id: "cw_personal_b", personalUserId: "user_2" };
    const opened = await openLink(
      [sharedWorkspace({ id: "cw_other" })],
      [],
      [otherPersonal, sharedWorkspace({ id: "cw_other" })]
    );
    try {
      expect(opened.goTo).not.toHaveBeenCalled();
      expect(opened.model()?.closedLink).toBeUndefined();
      expect(opened.reads).toEqual([]);
    } finally {
      await opened.unmount();
    }
  });

  it("names the owners and admins of the linked workspace the instance names", async () => {
    const opened = await openLink([personalWorkspace()], ["Mara Lindqvist", "Jonas Brandt"]);
    try {
      await vi.waitFor(
        () =>
          expect(opened.model()?.closedLink).toEqual({
            administrators: ["Mara Lindqvist", "Jonas Brandt"]
          }),
        { timeout: CONDITION_WAIT_MS }
      );
      expect(opened.reads).toEqual([linkedWorkspacePath]);
    } finally {
      await opened.unmount();
    }
  });

  it("names nobody where the refusal carries no names it can read", async () => {
    const opened = await openLink([personalWorkspace()], [42, "", "Mara Lindqvist"]);
    try {
      await vi.waitFor(
        () => expect(opened.model()?.closedLink).toEqual({ administrators: ["Mara Lindqvist"] }),
        { timeout: CONDITION_WAIT_MS }
      );
    } finally {
      await opened.unmount();
    }
  });

  const banner = (locale: "en" | "de", administrators: readonly string[]) =>
    renderToStaticMarkup(
      createElement(TranslationProvider, {
        locale,
        children: createElement(ClosedWorkspaceLinkBanner, {
          administrators,
          onDismiss: () => undefined
        })
      })
    );

  it.each([
    { locale: "en" as const, said: "Ask an admin of that workspace to add you." },
    { locale: "de" as const, said: "Bitte einen Admin dieses Arbeitsbereichs, dich hinzuzufügen." }
  ])("asks the workspace's admin where nobody is named ($locale)", ({ locale, said }) => {
    expect(banner(locale, [])).toContain(said);
  });

  it.each([
    { locale: "en" as const, said: "Ask Mara Lindqvist or Jonas Brandt to add you." },
    { locale: "de" as const, said: "Bitte Mara Lindqvist oder Jonas Brandt, dich hinzuzufügen." }
  ])("asks the named admins in the person's language ($locale)", ({ locale, said }) => {
    const markup = banner(locale, ["Mara Lindqvist", "Jonas Brandt"]);
    expect(markup).toContain(said);
    expect(markup).not.toContain(locale === "en" ? "Ask an admin" : "Bitte einen Admin");
  });
});
