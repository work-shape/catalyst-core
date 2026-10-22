// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type Conversation } from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { AssetOpenedChip, useAgentOpens } from "./support/chat-ui";

// ACCEPT-FIX-9 C13: "Go to it" on a skill the agent opened for the person first makes it the
// conversation's subject, then opens its page. The browser showed that one click does open
// the page, but nothing answered the click while the subject was set, so it read as a click
// that did nothing. The button now shows that it works and takes no second click meanwhile.

const URL_OF_INSTANCE = "https://chat.example.com";

afterEach(() => {
  vi.unstubAllGlobals();
});

const conversation: Conversation = {
  id: "conv_1",
  clientInstanceId: "client_1",
  collaborationWorkspaceId: "cw_1",
  visibility: "private",
  createdByUserId: "user_elif",
  createdByExternalUserId: "external_elif",
  title: "Urlaub",
  status: "active",
  createdAt: "2026-10-19T08:00:00.000Z",
  updatedAt: "2026-10-19T08:00:00.000Z",
  retainedUntil: "2026-11-18T08:00:00.000Z"
};

async function mountChip() {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const subjectOpens: unknown[] = [];
  let answerSubjectOpen: (() => void) | undefined;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    subjectOpens.push(await request.json());
    // The instance answers when the test says so.
    await new Promise<void>((resolve) => {
      answerSubjectOpen = resolve;
    });
    return Response.json(conversation);
  };
  const client = createApiClient({ baseUrl: URL_OF_INSTANCE, fetchImpl });
  const openPage = vi.fn();
  const dock = {
    openPage,
    show: vi.fn(),
    close: vi.fn(),
    forget: vi.fn(),
    last: undefined,
    forgetLast: vi.fn(),
    reopen: vi.fn(),
    showPage: vi.fn(),
    showChat: vi.fn(),
    conversationId: "conv_1",
    tab: "build" as const,
    tryAgent: undefined,
    showTry: vi.fn(),
    showBuild: vi.fn(),
    open: true,
    inFront: false
  };
  function Probe() {
    const opens = useAgentOpens({
      activeRun: undefined,
      messages: [],
      completedRunProjections: {},
      conversationId: "conv_1",
      storedSubject: undefined,
      workspaceId: "cw_1",
      route: { kind: "new-conversation", collaborationWorkspaceId: "cw_1" },
      dock,
      client,
      onSubjectChanged: () => undefined,
      onError: () => undefined
    });
    return createElement(AssetOpenedChip, {
      open: {
        subject: { kind: "skill", name: "hr-leave-policy" },
        title: "Urlaubsrichtlinie",
        callId: "call_1",
        awaitsPerson: true
      },
      onGoTo: opens.goTo
    });
  }
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        TranslationProvider,
        { locale: "de", children: null },
        createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, createElement(Probe))
      )
    );
  });
  const button = () => {
    const found = container.querySelector("button");
    if (!found) throw new Error("The chip has no button");
    return found;
  };
  return {
    button,
    openPage,
    subjectOpens,
    answer: () => act(async () => answerSubjectOpen?.()),
    unmount: () => act(() => root.unmount())
  };
}

describe("going to an asset the agent opened for the person", () => {
  it("shows the click working until the page opens, once", async () => {
    const chip = await mountChip();
    expect(chip.button().textContent).toContain("Zur Seite");

    await act(async () => chip.button().click());
    await vi.waitFor(() => expect(chip.subjectOpens).toHaveLength(1), {
      timeout: CONDITION_WAIT_MS
    });
    expect(chip.button().getAttribute("aria-busy")).toBe("true");
    expect(chip.button().disabled).toBe(true);
    // A second click while the subject is set sends nothing more.
    await act(async () => chip.button().click());
    expect(chip.subjectOpens).toHaveLength(1);
    expect(chip.openPage).not.toHaveBeenCalled();

    await chip.answer();
    await vi.waitFor(() => expect(chip.openPage).toHaveBeenCalledTimes(1), {
      timeout: CONDITION_WAIT_MS
    });
    expect(chip.openPage).toHaveBeenCalledWith(
      { kind: "build-asset", assetKind: "skills", name: "hr-leave-policy" },
      "conv_1"
    );
    expect(chip.subjectOpens).toEqual([
      { kind: "skill", name: "hr-leave-policy", toolCallId: "call_1" }
    ]);
    expect(chip.button().getAttribute("aria-busy")).toBeNull();
    await chip.unmount();
  });
});
