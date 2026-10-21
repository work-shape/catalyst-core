// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiOperations } from "@work-shape/catalyst-api-contract";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import { DraftHostsNotice } from "@work-shape/catalyst-chat-ui/pages";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS } from "./support/assertions";

// DRAFT-HOSTS-1: a preview of a draft names the outside hosts it holds back. Where the instance
// offers the click, the person allows them for their own preview, and the frame is asked for
// again; elsewhere the preview says only that the hosts wait for a publish.

const { t } = createTranslationContext("en");

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) {
    await unmount();
  }
});

/** Mounts the notice against an instance that answers each allowing with `answer`. */
async function mount(
  node: ReactNode,
  answer: () => Response = () => Response.json({ host: "api.example.com", allowed: true })
): Promise<{ container: HTMLElement; asked: unknown[] }> {
  const asked: unknown[] = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname === apiOperations["apps.allow_draft_host"].path) {
      asked.push(await request.json());
      return answer();
    }
    return Response.json({ error: { code: "NOT_FOUND", message: "none" } }, { status: 404 });
  });
  const queryClient = new QueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceApiClientProvider,
          { apiBaseUrl: "https://chat.example.com", children: null },
          createElement(
            TranslationProvider,
            { locale: "en", children: null },
            createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, node)
          )
        )
      )
    );
  });
  unmounts.push(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });
  return { container, asked };
}

/** The run of an allowing the policy holds for an approval. */
const waiting = {
  id: "opr_1",
  operation: "apps.allow_draft_host",
  effect: "changing",
  target: "live",
  status: "pending_approval",
  actor: { kind: "user", id: "author", label: "Ana Writer" },
  origin: { kind: "user" },
  inputHash: "sha256:abc",
  attempt: 1,
  correlationId: "corr_1",
  createdAt: "2026-10-21T01:00:00.000Z",
  href: "runs/opr_1"
};

const allowButton = (container: ParentNode) =>
  [...container.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === t("apps.draftHostsAllow")
  );

describe("the outside hosts a preview of a draft holds back", () => {
  it("offers the person to allow them for their own preview, says what it reads, and loads the frame again", async () => {
    const onAllowed = vi.fn();
    const { container, asked } = await mount(
      createElement(DraftHostsNotice, {
        fileSetId: "fs_2",
        heldBackHosts: ["api.example.com", "collect.example.net"],
        draftHosts: { allowable: ["api.example.com", "collect.example.net"], readsData: true },
        onAllowed
      })
    );
    const text = container.textContent ?? "";
    expect(text).toContain(
      t("apps.draftHostsHeld", { hosts: "api.example.com, collect.example.net" })
    );
    expect(text).toContain(t("apps.draftHostsReadsData"));
    expect(text).toContain(t("apps.draftHostsOnlyYou"));

    await act(async () => allowButton(container)?.click());
    await vi.waitFor(() => expect(onAllowed).toHaveBeenCalledOnce(), {
      timeout: CONDITION_WAIT_MS
    });
    expect(asked).toEqual([
      { fileSetId: "fs_2", host: "api.example.com" },
      { fileSetId: "fs_2", host: "collect.example.net" }
    ]);
  });

  it("says when allowing waits for an approval and does not load the frame again", async () => {
    const onAllowed = vi.fn();
    const { container } = await mount(
      createElement(DraftHostsNotice, {
        fileSetId: "fs_2",
        heldBackHosts: ["api.example.com"],
        draftHosts: { allowable: ["api.example.com"], readsData: false },
        onAllowed
      }),
      () => Response.json(waiting, { status: 202 })
    );
    expect(container.textContent).not.toContain(t("apps.draftHostsReadsData"));
    await act(async () => allowButton(container)?.click());
    await vi.waitFor(() => expect(container.textContent).toContain(t("apps.draftHostsWaits")), {
      timeout: CONDITION_WAIT_MS
    });
    expect(allowButton(container)?.disabled).toBe(true);
    expect(onAllowed).not.toHaveBeenCalled();
  });

  it("shows only what waits for a publish where the person may not allow, and nothing without hosts", async () => {
    const fallback = createElement("p", null, "held back until published");
    const offerless = await mount(
      createElement(DraftHostsNotice, {
        fileSetId: "fs_2",
        heldBackHosts: ["api.example.com"],
        draftHosts: { allowable: [], readsData: true },
        fallback,
        onAllowed: () => undefined
      })
    );
    expect(offerless.container.textContent).toBe("held back until published");
    expect(allowButton(offerless.container)).toBeUndefined();

    const empty = await mount(
      createElement(DraftHostsNotice, {
        fileSetId: "fs_2",
        heldBackHosts: [],
        draftHosts: undefined,
        fallback,
        onAllowed: () => undefined
      })
    );
    expect(empty.container.textContent).toBe("");
  });
});
