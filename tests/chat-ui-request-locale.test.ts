// @vitest-environment happy-dom

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LocaleCode } from "@work-shape/catalyst-api-client";
import {
  useRequestLocale,
  useWorkspaceApiClient,
  WorkspaceApiClientProvider
} from "@work-shape/catalyst-chat-ui/workspace-api-client";

// ACCEPT-FIX-10: the server writes refusals (guardrail blocks, upload refusals) in the
// language a request asks for. The browser's own Accept-Language names its settings, so the
// workspace client asks for the language the person chose in the interface, on every request.

const BASE = "https://instance.example.test";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the language every request asks for", () => {
  it("follows the interface language to German, English and German again", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const sent: {
      language: string | null;
      authorization: string | null;
      signal: boolean;
      credentials?: RequestCredentials;
    }[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        language: new Headers(init?.headers).get("accept-language"),
        authorization: new Headers(init?.headers).get("authorization"),
        signal: init?.signal instanceof AbortSignal,
        ...(init?.credentials ? { credentials: init.credentials } : {})
      });
      return Response.json({ items: [] });
    });
    let client: ReturnType<typeof useWorkspaceApiClient>["client"] | undefined;
    function Interface({ locale }: { locale: LocaleCode }) {
      useRequestLocale(locale);
      client = useWorkspaceApiClient().client;
      return null;
    }
    const root = createRoot(document.createElement("div"));
    const ask = async (locale: LocaleCode) => {
      await act(async () =>
        root.render(
          createElement(WorkspaceApiClientProvider, {
            apiBaseUrl: BASE,
            token: "token",
            children: createElement(Interface, { locale })
          })
        )
      );
      await client?.workspaces.list({ query: { limit: 1 } });
    };

    await ask("de");
    await ask("en");
    await ask("de");

    expect(sent.map((request) => request.language)).toEqual(["de", "en", "de"]);
    // The request keeps what the client sends with it: its token, signal and credentials mode.
    for (const request of sent) {
      expect(request.authorization).toBe("Bearer token");
      expect(request.signal).toBe(true);
      expect(request.credentials).toBe("omit");
    }
    await act(async () => root.unmount());
  });
});
