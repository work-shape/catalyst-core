import { vi } from "vitest";

// Inspect the actual composed document selected by the file preview, without a browser shell.
vi.mock("../../../packages/chat-ui/src/chat/views/rendered-html-display", async () => {
  const { createElement } = await import("react");
  const { composeViewDocument } = await import("./chat-views");
  return {
    RenderedHtmlDisplay: (props: Parameters<typeof composeViewDocument>[0]) =>
      createElement("pre", { "data-testid": "composed-file" }, composeViewDocument(props))
  };
});
