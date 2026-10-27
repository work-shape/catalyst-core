// @vitest-environment happy-dom

import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { apiOperations, buildApiPath } from "@work-shape/catalyst-api-contract";
import { PREVIEW_CAPTURE_REFUSALS, type PreviewCaptureRefusal } from "@work-shape/catalyst-core";
import { UiRoot, uiLabelsDe, uiLabelsEn } from "@work-shape/catalyst-ui";
import { readPreviewCapture } from "@work-shape/catalyst-chat-ui/pages";
import { ToolCallPart } from "@work-shape/catalyst-chat-ui/tool-call";
import {
  ToolDisplayPanelProvider,
  useToolDisplayPanel
} from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { TranslationProvider } from "./support/chat-ui/shared";
import { AttachmentContentProvider } from "./support/chat-ui";

// The picture a run took of the preview, in the run's work (PREVIEW-SEE-2). The row of the call
// shows it small, read through the conversation's artifact content with the reader's token, and
// opens it in the file viewer beside the chat on a click, never by itself and never as a second
// card. Its blob: address goes when the row leaves or the conversation changes, and a picture
// the reader may no longer read says so. A refusal is a sentence in the reader's language, never
// the code or the server's English reason.

const API = "https://api.example.test";
const WEBP = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]);

let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
let createObjectUrl: MockInstance<typeof URL.createObjectURL>;
let revokeObjectUrl: MockInstance<typeof URL.revokeObjectURL>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fetchMock = vi.fn<typeof fetch>(async () => webp());
  vi.stubGlobal("fetch", fetchMock);
  let next = 0;
  createObjectUrl = vi
    .spyOn(URL, "createObjectURL")
    .mockImplementation(() => `blob:catalyst/picture-${++next}`);
  revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Where the conversation's artifact content of the picture is read. */
const content = (conversationId: string) =>
  API +
  buildApiPath(apiOperations["conversations.artifacts.get_content"].path, {
    params: { conversationId, artifactId: "art_capture_1" }
  });

function webp(): Response {
  return new Response(WEBP, { headers: { "content-type": "image/webp" } });
}

const client = createApiClient({ baseUrl: API, getToken: () => "token-1" });

const captured = {
  status: "success",
  output: { captured: true, revision: 4, width: 1280, height: 800 },
  artifacts: [
    {
      artifactId: "art_capture_1",
      kind: "image.webp",
      filename: "preview-revision-4.webp",
      mimeType: "image/webp",
      modelVisibility: { type: "image", mimeType: "image/webp" },
      metadata: { previewCapture: true, revision: 4 }
    }
  ]
};

const SERVER_REASONS: Record<PreviewCaptureRefusal, string> = {
  capture_limit: "A run takes at most 3 pictures",
  capture_unavailable: "Safari does not allow it. Go on with the preview's report",
  preview_not_viewed: "Nobody has the preview of this conversation open",
  preview_personal_data: "The preview reads data through a personal connection"
};

function refused(code: PreviewCaptureRefusal) {
  return { status: "success", output: { captured: false, code, reason: SERVER_REASONS[code] } };
}

/** What the surface slot beside the chat holds. */
function Panel() {
  const panel = useToolDisplayPanel();
  return panel.open && panel.entry
    ? createElement(
        "section",
        {
          "data-testid": "panel",
          "data-kind": panel.entry.kind,
          "data-key": panel.entry.key,
          "data-title": panel.entry.title
        },
        "node" in panel.entry ? panel.entry.node : null
      )
    : null;
}

function shell(child: ReactNode, conversationId: string | undefined, locale: "en" | "de") {
  return createElement(
    UiRoot,
    { mode: "light", labels: locale === "de" ? uiLabelsDe : uiLabelsEn },
    createElement(
      TranslationProvider,
      { locale, children: null },
      createElement(
        AttachmentContentProvider,
        { client, selectedConversationId: conversationId, children: null },
        createElement(ToolDisplayPanelProvider, null, child, createElement(Panel))
      )
    )
  );
}

function call(result: unknown, toolCallId = "call_capture_1") {
  return createElement(ToolCallPart, {
    type: "tool-call" as const,
    toolName: "preview.capture",
    toolCallId,
    args: {},
    argsText: "{}",
    result,
    status: { type: "complete" as const },
    addResult: () => undefined,
    resume: () => undefined,
    respondToApproval: () => undefined
  });
}

async function show(
  result: unknown,
  {
    conversationId = "conv_1",
    locale = "en"
  }: { conversationId?: string; locale?: "en" | "de" } = {}
) {
  await act(async () => root.render(shell(call(result), conversationId, locale)));
  await settle();
}

async function settle() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function requestedUrls(): string[] {
  return fetchMock.mock.calls.map(([input]) =>
    String(input instanceof Request ? input.url : input)
  );
}

const thumbnail = () =>
  host.querySelector<HTMLButtonElement>('[data-testid="preview-capture-thumbnail"]');

describe("reading a call of preview.capture", () => {
  it("reads the picture, each refusal, and leaves every other shape an ordinary call", () => {
    expect(readPreviewCapture({ toolName: "preview.capture", result: captured })).toEqual({
      kind: "captured",
      artifact: {
        artifactId: "art_capture_1",
        kind: "image.webp",
        filename: "preview-revision-4.webp",
        mimeType: "image/webp"
      }
    });
    for (const code of PREVIEW_CAPTURE_REFUSALS) {
      expect(readPreviewCapture({ toolName: "preview.capture", result: refused(code) })).toEqual({
        kind: "refused",
        code
      });
    }
    const others: { toolName: string; result: unknown; isError?: boolean }[] = [
      { toolName: "workspace.exec", result: captured },
      { toolName: "preview.capture", result: captured, isError: true },
      { toolName: "preview.capture", result: undefined },
      { toolName: "preview.capture", result: { output: { captured: false, code: "other" } } },
      // A picture answer without its picture, or with a file that is no WebP.
      { toolName: "preview.capture", result: { ...captured, artifacts: [] } },
      {
        toolName: "preview.capture",
        result: {
          ...captured,
          artifacts: [{ artifactId: "art_x", mimeType: "image/svg+xml" }]
        }
      }
    ];
    for (const other of others) expect(readPreviewCapture(other)).toBeUndefined();
  });
});

describe("the picture in the run's work", () => {
  it("shows it small from the conversation's artifact content and opens it larger on a click", async () => {
    await show(captured);

    expect(requestedUrls()).toEqual([content("conv_1")]);
    const [init] = fetchMock.mock.calls.map(([, options]) => options);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token-1");
    // The viewer's own address, under the picture's raster type.
    const [object] = createObjectUrl.mock.calls.map(([blob]) => blob);
    expect(object instanceof Blob ? object.type : undefined).toBe("image/webp");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:catalyst/picture-1");
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("Picture of the preview");
    expect(host.textContent).toContain("Look at the preview");

    // No card of its own, and nothing opened by itself.
    expect(host.querySelector('[aria-label^="Open preview for"]')).toBeNull();
    expect(host.querySelector('[data-testid="panel"]')).toBeNull();
    expect(host.textContent).not.toContain("preview-revision-4");

    await act(async () => thumbnail()?.click());
    await settle();
    const panel = host.querySelector<HTMLElement>('[data-testid="panel"]');
    expect(panel?.dataset).toMatchObject({
      kind: "file_preview",
      key: "artifact-preview:art_capture_1",
      title: "Picture of the preview"
    });
    // The viewer reads the same picture through the same route.
    expect(new Set(requestedUrls())).toEqual(new Set([content("conv_1")]));
    expect(panel?.querySelector("img")).not.toBeNull();
  });

  it("lets go of the address when the row leaves and when the conversation changes", async () => {
    await show(captured);
    expect(revokeObjectUrl).not.toHaveBeenCalled();

    await show(captured, { conversationId: "conv_2" });
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:catalyst/picture-1");
    expect(requestedUrls().at(-1)).toBe(content("conv_2"));
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:catalyst/picture-2");

    await act(async () => root.render(shell(null, "conv_2", "en")));
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:catalyst/picture-2");
  });

  it("makes no address for a picture that arrives after the row left", async () => {
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => (answer = resolve)));
    await show(captured);
    await act(async () => root.render(shell(null, "conv_1", "en")));
    answer(webp());
    await settle();
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("says the picture is gone when the reader may not read it, with nothing to open", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { code: "NOT_FOUND", message: "Not found" } }), {
          status: 404,
          headers: { "content-type": "application/json" }
        })
    );
    await show(captured, { locale: "de" });
    expect(thumbnail()).toBeNull();
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("Das Bild ist nicht mehr verfügbar.");
    expect(host.textContent).not.toContain("Not found");
    expect(createObjectUrl).not.toHaveBeenCalled();
  });

  it("shows bytes served as a page only as a raster image, never in a document or frame", async () => {
    const page = "<!doctype html><script>parent.postMessage('owned', '*')</script>";
    fetchMock.mockImplementation(
      async () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } })
    );
    await show(captured);
    // The blob takes a raster type, whatever the response said it was.
    const [object] = createObjectUrl.mock.calls.map(([blob]) => blob);
    expect(object instanceof Blob ? object.type : undefined).toBe("image/png");
    expect(host.querySelector("img")?.getAttribute("src")).toBe("blob:catalyst/picture-1");
    expect(host.querySelector("iframe, object, embed")).toBeNull();
    await act(async () => thumbnail()?.click());
    await settle();
    expect(host.querySelector('[data-testid="panel"] iframe, object, embed')).toBeNull();
  });

  it("says the picture is gone when its bytes do not decode", async () => {
    await show(captured);
    await act(async () => host.querySelector("img")?.dispatchEvent(new Event("error")));
    expect(thumbnail()).toBeNull();
    expect(host.textContent).toContain("The picture is no longer available.");
  });

  it("reads nothing without an open conversation", async () => {
    await act(async () => root.render(shell(call(captured), undefined, "en")));
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.textContent).toContain("The picture is no longer available.");
  });
});

describe("a refusal in the run's work", () => {
  const sentences: Record<"en" | "de", Record<PreviewCaptureRefusal, string>> = {
    en: {
      capture_limit:
        "The agent has already looked at the preview as often as it may in this run or this hour.",
      capture_unavailable:
        "The browser that had the preview open cannot take a picture of it. Safari does not allow it.",
      preview_not_viewed: "The agent could not look at the preview because it was not open.",
      preview_personal_data:
        "The preview shows data from a personal connection, so no picture of it was taken."
    },
    de: {
      capture_limit:
        "Der Agent hat die Vorschau in diesem Lauf oder in dieser Stunde schon so oft angesehen, wie er darf.",
      capture_unavailable:
        "Der Browser, in dem die Vorschau offen war, kann kein Bild davon aufnehmen. Safari erlaubt das nicht.",
      preview_not_viewed:
        "Der Agent konnte die Vorschau nicht ansehen, weil sie nicht geöffnet war.",
      preview_personal_data:
        "Die Vorschau zeigt Daten aus einer persönlichen Verbindung, deshalb wurde kein Bild davon aufgenommen."
    }
  };

  for (const locale of ["de", "en"] as const) {
    for (const code of PREVIEW_CAPTURE_REFUSALS) {
      it(`says ${code} in its own words (${locale})`, async () => {
        await show(refused(code), { locale });
        const sentence = host.querySelector('[data-testid="preview-capture-refused"]');
        expect(sentence?.textContent).toBe(sentences[locale][code]);
        // Shown with the row closed: neither the code nor the server's sentence is in the page.
        expect(host.textContent).not.toContain(code);
        expect(host.textContent).not.toContain(SERVER_REASONS[code]);
        expect(host.querySelector("img")).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
      });
    }
  }
});
