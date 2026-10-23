// @vitest-environment happy-dom
import "./support/chat-ui/mock-file-display";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createApiClient, type ConversationThreadSnapshot } from "@work-shape/catalyst-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { ArtifactPreview } from "./support/chat-ui/chat-files";
import { TranslationProvider } from "./chat-ui-render-harness";

let root: Root | undefined;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function thread(personalData?: boolean): ConversationThreadSnapshot {
  const at = "2026-10-23T10:00:00.000Z";
  return {
    personalData,
    conversation: {
      id: "chat",
      clientInstanceId: "test",
      collaborationWorkspaceId: "workspace",
      createdByUserId: "user",
      createdByExternalUserId: "user",
      visibility: "private",
      title: "Files",
      status: "active",
      createdAt: at,
      updatedAt: at,
      retainedUntil: at
    },
    messages: [],
    serverTime: at,
    userState: { clientInstanceId: "test", conversationId: "chat", userId: "user", updatedAt: at }
  };
}

const html =
  '<p>Private report</p><script>window.fileCanary = true</script><img src="https://outside.example/leak">';

describe("HTML file preview privacy", () => {
  it.each([true, false, undefined, "failed"] as const)(
    "uses a safe document while the mark is unknown, then honors %s",
    async (mark) => {
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const client = createApiClient({ baseUrl: "https://chat.example.test" });
      vi.spyOn(client.conversations.artifacts, "get_content").mockResolvedValue(new Blob([html]));
      let resolve!: (value: ConversationThreadSnapshot) => void;
      let reject!: (error: Error) => void;
      vi.spyOn(client.conversations.thread, "get").mockReturnValue(
        new Promise((yes, no) => {
          resolve = yes;
          reject = no;
        })
      );
      const host = document.createElement("div");
      root = createRoot(host);
      await act(async () =>
        root?.render(
          createElement(
            UiRoot,
            { mode: "light", labels: uiLabelsEn },
            createElement(
              TranslationProvider,
              { locale: "en", children: null },
              createElement(ArtifactPreview, {
                client,
                conversationId: "chat",
                artifact: { artifactId: "file", filename: "report.html", mimeType: "text/html" }
              })
            )
          )
        )
      );
      const composed = () => {
        const document = host.querySelector('[data-testid="composed-file"]')?.textContent;
        expect(document).toContain("Private report");
        return document ?? "";
      };
      expect(composed()).toContain("script-src 'none'");
      expect(composed()).not.toContain("fileCanary");
      await act(async () => {
        if (mark === "failed") reject(new Error("unreadable"));
        else resolve(thread(mark));
      });
      if (mark === false) expect(composed()).toContain("fileCanary");
      else {
        expect(composed()).toContain("script-src 'none'");
        expect(composed()).not.toContain("fileCanary");
        expect(composed()).not.toContain("https://outside.example/leak");
      }
    }
  );
});
