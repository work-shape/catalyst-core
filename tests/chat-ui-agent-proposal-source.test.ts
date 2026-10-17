// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { useAgentProposal, type AgentProposalState } from "@work-shape/catalyst-chat-ui/build-area";
import { resolveInstanceModules } from "@work-shape/catalyst-client-assembly";
import { createSafeConfigView } from "@work-shape/catalyst-config-schema";
import {
  SettingsPageProvider,
  type SettingsPageContextValue
} from "@work-shape/catalyst-chat-ui/settings-page-context";
import { TranslationProvider } from "./chat-ui-render-harness";
import { personalWorkspace, settingsUser } from "./chat-ui-settings-fixtures";
import { CONDITION_WAIT_MS, required } from "./support/assertions";
import { createTestConfig } from "./support/fixtures";

// TRY-1a2: what Apply answers is about the proposal revision it was sent for. A newer proposal
// the agent writes while Apply waits is shown as it is, whatever the late answer to the older
// one says; a 412 says the proposal changed beside the newer revision it read.

const URL_OF_INSTANCE = "https://chat.example.com";
const CONVERSATION = "conv_dock";

function refusal(status: number, code: string, reason: string): Response {
  return Response.json(
    { error: { code, message: "refused", correlationId: "corr_1", details: { reason } } },
    { status }
  );
}

/**
 * The agent page's proposal hook against an instance whose proposal revision the test moves,
 * and whose answer to Apply the test gives when it wants to.
 */
async function mountProposal() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const instance = { revision: 1 };
  let answerApply: ((response: Response) => void) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path.endsWith("/publish")) {
      return new Promise<Response>((resolve) => {
        answerApply = resolve;
      });
    }
    return Response.json({
      draft: {
        agent: "assistant",
        author: { userId: "author", release: false },
        revision: instance.revision,
        baseRevision: 3,
        liveRevision: 3,
        stale: false,
        config: { name: "assistant", instructions: `Revision ${instance.revision}.` },
        updatedAt: "2026-10-17T01:00:00.000Z"
      }
    });
  };
  const config = createTestConfig();
  const settings: SettingsPageContextValue = {
    apiBaseUrl: URL_OF_INSTANCE,
    authScope: "proposal-test",
    client: createApiClient({ baseUrl: URL_OF_INSTANCE, fetchImpl }),
    user: settingsUser(),
    config: safeConfigSchema.parse(
      createSafeConfigView(
        config,
        { version: 0, agents: [], skills: [] },
        resolveInstanceModules(config, []).snapshot
      )
    ),
    locales: ["en", "de"],
    locale: "en",
    selectLocale: () => undefined,
    showContextIndicator: false,
    setShowContextIndicator: () => undefined,
    themePreference: "light",
    selectThemePreference: () => undefined,
    workspace: undefined,
    activeWorkspace: personalWorkspace(),
    onAccountDeleted: () => undefined,
    onWorkspaceLeft: () => undefined,
    onWorkspaceDeleted: () => undefined,
    dockConversationId: CONVERSATION
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const seen: { state: AgentProposalState | undefined } = { state: undefined };
  function Probe() {
    seen.state = useAgentProposal({
      agent: "assistant",
      canDecide: true,
      reload: async () => undefined
    });
    return null;
  }
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          SettingsPageProvider,
          { value: settings },
          createElement(TranslationProvider, { locale: "en", children: null }, createElement(Probe))
        )
      )
    );
  });
  const shows = async (revision: number) =>
    vi.waitFor(() => expect(seen.state?.proposal.revision).toBe(revision), {
      timeout: CONDITION_WAIT_MS
    });
  await shows(1);
  return {
    seen,
    shows,
    /** The agent saves a newer proposal, which the page has not read yet. */
    instanceHolds(revision: number) {
      instance.revision = revision;
    },
    /** The agent saves a newer proposal, which the dock's save makes the page read. */
    async agentWrites(revision: number) {
      instance.revision = revision;
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      await shows(revision);
    },
    apply() {
      let applied: Promise<void> = Promise.resolve();
      act(() => {
        applied = required(seen.state?.decide).apply();
      });
      return applied;
    },
    async answer(response: Response, applied: Promise<void>) {
      // Apply has reached the instance before it is answered.
      await vi.waitFor(() => expect(answerApply).toBeDefined(), { timeout: CONDITION_WAIT_MS });
      await act(async () => {
        required(answerApply)(response);
        await applied;
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      queryClient.clear();
      container.remove();
      vi.unstubAllGlobals();
    }
  };
}

describe("the answer to Apply", () => {
  it("never hides a newer proposal that arrived while a stale refusal of the older one was on its way", async () => {
    const page = await mountProposal();
    try {
      const applied = page.apply();
      await page.agentWrites(2);
      await page.answer(refusal(409, "CONFLICT", "stale_base"), applied);
      expect(page.seen.state?.proposal).toMatchObject({ revision: 2, stale: false });
      // Marks and Apply stay: there is no stale answer about revision 2.
      expect(page.seen.state?.answer).toBeUndefined();
      expect(page.seen.state?.busy).toBeUndefined();
    } finally {
      await page.unmount();
    }
  });

  it("says a stale refusal of the revision on screen", async () => {
    const page = await mountProposal();
    try {
      const applied = page.apply();
      await page.answer(refusal(409, "CONFLICT", "stale_base"), applied);
      expect(page.seen.state?.answer).toEqual({ kind: "stale" });
    } finally {
      await page.unmount();
    }
  });

  it("says the proposal changed beside the newer revision a 412 makes the page read", async () => {
    const page = await mountProposal();
    try {
      const applied = page.apply();
      // The instance holds a newer proposal than the page sent; the refusal reads it.
      page.instanceHolds(2);
      await page.answer(refusal(412, "REVISION_CONFLICT", "draft_changed"), applied);
      await page.shows(2);
      expect(page.seen.state?.answer).toEqual({ kind: "changed" });
    } finally {
      await page.unmount();
    }
  });
});
