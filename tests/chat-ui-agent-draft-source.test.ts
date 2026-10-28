// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { safeConfigSchema } from "@work-shape/catalyst-api-contract";
import { useAgentDraft, type AgentDraftSource } from "@work-shape/catalyst-chat-ui/build-area";
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

// AD-4: the agent page reads the agent's one draft for a holder of the write right, and what
// Publish answers is about the draft revision it was sent for. A newer draft written while
// Publish waits is shown as it is, whatever the late answer to the older one says; a 412 says
// the draft changed beside the newer revision it read.

const URL_OF_INSTANCE = "https://chat.example.com";

function refusal(status: number, code: string, reason: string): Response {
  return Response.json(
    { error: { code, message: "refused", correlationId: "corr_1", details: { reason } } },
    { status }
  );
}

/**
 * The agent page's draft hook against an instance whose draft revision the test moves, and
 * whose answer to Publish the test gives when it wants to.
 */
async function mountDraft(input: { reload?: () => Promise<unknown> } = {}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const instance: { revision: number | null } = { revision: 1 };
  const sent: { decision: string; body: unknown }[] = [];
  let answerPublish: ((response: Response) => void) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;
    if (request.method === "POST") {
      const decision = path.endsWith("/publish") ? "publish" : "discard";
      sent.push({ decision, body: await request.json() });
    }
    if (request.method === "POST" && path.endsWith("/publish")) {
      return new Promise<Response>((resolve) => {
        answerPublish = resolve;
      });
    }
    if (request.method === "POST" && path.endsWith("/draft/discard")) {
      instance.revision = null;
      return Response.json({ discarded: true });
    }
    if (instance.revision === null) {
      return refusal(404, "NOT_FOUND", "no_draft");
    }
    return Response.json({
      draft: {
        agent: "assistant",
        author: { userId: "author", name: "Ana Writer", release: false },
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
    authScope: "draft-test",
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
    onWorkspaceDeleted: () => undefined
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const seen: { state: AgentDraftSource | undefined } = { state: undefined };
  function Probe() {
    seen.state = useAgentDraft({
      agent: "assistant",
      enabled: true,
      reload: input.reload ?? (async () => undefined)
    });
    return null;
  }
  let generation = 0;
  const render = () =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(
            SettingsPageProvider,
            { value: settings },
            createElement(
              TranslationProvider,
              { locale: "en", children: null },
              createElement(Probe, { key: generation })
            )
          )
        )
      );
    });
  await render();
  const shows = async (revision: number | null) =>
    vi.waitFor(() => expect(seen.state?.latest?.revision ?? null).toBe(revision), {
      timeout: CONDITION_WAIT_MS
    });
  await shows(1);
  return {
    seen,
    shows,
    sent,
    queryClient,
    /** Somebody saves a newer draft, which the page has not read yet. */
    instanceHolds(revision: number) {
      instance.revision = revision;
    },
    /** Somebody saves a newer draft, which a read of the assets makes the page read. */
    async agentWrites(revision: number) {
      instance.revision = revision;
      await act(async () => {
        await queryClient.invalidateQueries();
      });
      await shows(revision);
    },
    /** Publish of the draft revision on screen, with what the reader chose in the dialog. */
    publish(options?: Parameters<AgentDraftSource["decide"]>[2]) {
      let published: Promise<void> = Promise.resolve();
      const state = required(seen.state);
      const revision = required(state.latest).revision;
      act(() => {
        published = state.decide("publish", revision, options);
      });
      return published;
    },
    async answer(response: Response, published: Promise<void>) {
      // Publish has reached the instance before it is answered.
      await vi.waitFor(() => expect(answerPublish).toBeDefined(), { timeout: CONDITION_WAIT_MS });
      await act(async () => {
        required(answerPublish)(response);
        await published;
      });
    },
    /** The page starts again from the agent, as it does after a publish is made. */
    async remount() {
      generation += 1;
      await render();
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

describe("the answer to Publish", () => {
  it("never hides a newer draft that arrived while a stale refusal of the older one was on its way", async () => {
    const page = await mountDraft();
    try {
      const published = page.publish();
      await page.agentWrites(2);
      await page.answer(refusal(409, "CONFLICT", "stale_base"), published);
      expect(page.seen.state?.latest).toMatchObject({ revision: 2, stale: false });
      // The draft and Publish stay: there is no stale answer about revision 2.
      expect(page.seen.state?.answerFor(2)).toBeUndefined();
      expect(page.seen.state?.busy).toBeUndefined();
    } finally {
      await page.unmount();
    }
  });

  it("says a stale refusal of the revision on screen", async () => {
    const page = await mountDraft();
    try {
      const published = page.publish();
      await page.answer(refusal(409, "CONFLICT", "stale_base"), published);
      expect(page.seen.state?.answerFor(1)).toEqual({ kind: "stale" });
      expect(page.sent).toEqual([{ decision: "publish", body: { revision: 1 } }]);
    } finally {
      await page.unmount();
    }
  });

  // The instance makes what the agent uses available only where the agent was when the dialog
  // read what is missing; it refuses a choice that does not say where that was.
  it.each([
    {
      mode: "selected" as const,
      personalWorkspaces: true,
      collaborationWorkspaceIds: ["ws_sales"]
    },
    null
  ])(
    "sends where the agent was when the reader chose to make it available (%o)",
    async (expected) => {
      const page = await mountDraft();
      try {
        const published = page.publish({
          makeDependenciesAvailable: true,
          expectedAvailability: expected
        });
        await page.answer(refusal(409, "CONFLICT", "stale_base"), published);
        expect(page.sent).toEqual([
          {
            decision: "publish",
            body: { revision: 1, makeDependenciesAvailable: true, expectedAvailability: expected }
          }
        ]);
      } finally {
        await page.unmount();
      }
    }
  );

  it("sends neither when the reader did not choose it", async () => {
    const page = await mountDraft();
    try {
      const published = page.publish({
        makeDependenciesAvailable: false,
        expectedAvailability: null
      });
      await page.answer(refusal(409, "CONFLICT", "stale_base"), published);
      expect(page.sent).toEqual([{ decision: "publish", body: { revision: 1 } }]);
    } finally {
      await page.unmount();
    }
  });

  it("says the draft changed beside the newer revision a 412 makes the page read", async () => {
    const page = await mountDraft();
    try {
      const published = page.publish();
      // The instance holds a newer draft than the page sent; the refusal reads it.
      page.instanceHolds(2);
      await page.answer(refusal(412, "REVISION_CONFLICT", "draft_changed"), published);
      await page.shows(2);
      expect(page.seen.state?.answerFor(2)).toEqual({ kind: "changed" });
    } finally {
      await page.unmount();
    }
  });
});

describe("the draft on the page", () => {
  it("is none where the instance tells of none, and none again after a Discard", async () => {
    const reload = vi.fn(async () => undefined);
    const page = await mountDraft({ reload });
    try {
      const state = required(page.seen.state);
      await act(async () => {
        await state.decide("discard", 1);
      });
      expect(page.sent).toEqual([{ decision: "discard", body: { expectedRevision: 1 } }]);
      await page.shows(null);
      expect(page.seen.state?.latest).toBeNull();
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      await page.unmount();
    }
  });

  it("holds the page's own save without reading the draft again, by the reader who saved it", async () => {
    const page = await mountDraft();
    try {
      let saved: unknown;
      act(() => {
        saved = required(page.seen.state).saved({
          revision: 2,
          config: { name: "assistant", instructions: "Mine." },
          liveRevision: 3
        });
      });
      await page.shows(2);
      expect(saved).toMatchObject({
        revision: 2,
        baseRevision: 3,
        author: { userId: settingsUser().id, name: settingsUser().displayLabel }
      });
      expect(page.seen.state?.latest?.config).toEqual({ name: "assistant", instructions: "Mine." });
    } finally {
      await page.unmount();
    }
  });
});

// UI-FIX-1: a made Publish changes the live agent, which the Agents page, the agent picker and
// the configuration also show; they are asked for again, as after a save in Build. A Publish
// that waits for an approval has changed nothing yet.
describe("what a Publish makes the rest of the interface read again", () => {
  const offered = ["collaboration-workspace-agents", URL_OF_INSTANCE, "draft-test", "cw_1"];
  const configuration = ["config", URL_OF_INSTANCE, "draft-test"];
  const waiting = {
    id: "opr_1",
    operation: "assets.publish",
    effect: "changing",
    target: "live",
    status: "pending_approval",
    actor: { kind: "user", id: "author", label: "Ana Writer" },
    origin: { kind: "user" },
    inputHash: "sha256:abc",
    attempt: 1,
    correlationId: "corr_1",
    createdAt: "2026-10-17T01:00:00.000Z",
    href: "runs/opr_1"
  };

  async function publishAnswered(response: Response) {
    const page = await mountDraft();
    page.queryClient.setQueryData(offered, { agents: [] });
    page.queryClient.setQueryData(configuration, {});
    await page.answer(response, page.publish());
    return page;
  }

  it("asks again for the agents people are offered and the configuration once it is made", async () => {
    const page = await publishAnswered(Response.json({ draftRevision: 1, publishedRevision: 1 }));
    try {
      await vi.waitFor(
        () => {
          expect(page.queryClient.getQueryState(offered)?.isInvalidated).toBe(true);
          expect(page.queryClient.getQueryState(configuration)?.isInvalidated).toBe(true);
        },
        { timeout: CONDITION_WAIT_MS }
      );
    } finally {
      await page.unmount();
    }
  });

  it("asks for nothing again while it waits for an approval", async () => {
    const page = await publishAnswered(Response.json(waiting, { status: 202 }));
    try {
      expect(page.seen.state?.answerFor(1)).toEqual({ kind: "waits" });
      expect(page.queryClient.getQueryState(offered)?.isInvalidated).toBe(false);
      expect(page.queryClient.getQueryState(configuration)?.isInvalidated).toBe(false);
    } finally {
      await page.unmount();
    }
  });
});

// OFFER-ON-PUBLISH: the publish is made and the place the dialog chose could not be set. The
// page starts again after the publish, so the choice and the instance's sentence outlive it,
// until the page saves the choice or drops it.
describe("an offer a made Publish could not set", () => {
  const form = { mode: "all" as const, personalWorkspaces: false, collaborationWorkspaceIds: [] };
  const message = "Agent “assistant” is only for you and cannot be offered in a team.";

  it("is held for the page that starts again, and gone once the page settles it", async () => {
    const page = await mountDraft();
    try {
      expect(page.seen.state?.unsetOffer).toBeUndefined();
      const published = page.publish({
        makeDependenciesAvailable: false,
        expectedAvailability: null,
        afterPublish: async () => ({ form, message })
      });
      await page.answer(Response.json({ draftRevision: 1, publishedRevision: 1 }), published);
      await page.remount();
      expect(page.seen.state?.unsetOffer).toEqual({ form, message });

      await act(async () => page.seen.state?.settleOffer?.());
      expect(page.seen.state?.unsetOffer).toBeUndefined();
      await page.remount();
      expect(page.seen.state?.unsetOffer).toBeUndefined();
    } finally {
      await page.unmount();
    }
  });

  it("holds nothing where the place was set", async () => {
    const page = await mountDraft();
    try {
      const published = page.publish({
        makeDependenciesAvailable: false,
        expectedAvailability: null,
        afterPublish: async () => undefined
      });
      await page.answer(Response.json({ draftRevision: 1, publishedRevision: 1 }), published);
      await page.remount();
      expect(page.seen.state?.unsetOffer).toBeUndefined();
    } finally {
      await page.unmount();
    }
  });
});
