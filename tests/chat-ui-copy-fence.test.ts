// @vitest-environment happy-dom

import { TextMessagePartProvider } from "@assistant-ui/react";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { TranslationProvider } from "./chat-ui-render-harness";
import {
  CopyFenceWritingProvider,
  MarkdownArtifact,
  MarkdownLinkPolicyProvider,
  MarkdownText
} from "./support/chat-ui";

// A fence with the language `copy` holds a text the reader takes elsewhere. It draws as the
// library's CopyText, and its button copies exactly what stands between the fence lines.

const policy = { ownOrigins: ["https://chat.example.com"], allowedLinkHosts: [] };

describe("a copy fence in chat Markdown", () => {
  let container: HTMLElement;
  let root: ReturnType<typeof createRoot>;
  let copied: string[];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    copied = [];
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: (text: string) => {
          copied.push(text);
          return Promise.resolve();
        }
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const frame = (children: ReactNode) =>
    createElement(
      UiRoot,
      { mode: "light", labels: uiLabelsEn },
      createElement(
        TranslationProvider,
        { children: null, locale: "en" },
        createElement(MarkdownLinkPolicyProvider, { ...policy, children: null }, children)
      )
    );

  const renderFile = async (markdown: string) => {
    await act(async () => {
      root.render(frame(createElement(MarkdownArtifact, null, markdown)));
    });
  };

  /** A reply as the conversation shows it, `running` while it is still being written. */
  const renderReply = async (text: string, running: boolean) => {
    await act(async () => {
      root.render(
        frame(
          createElement(
            CopyFenceWritingProvider,
            { value: running },
            // The app's text part is not "running" while a reply is written: other parts
            // follow it. The reply's own state is what says so.
            createElement(TextMessagePartProvider, { text }, createElement(MarkdownText))
          )
        )
      );
    });
  };

  const block = () => container.querySelector('[data-slot="copy-text"]');
  const body = () => container.querySelector('[data-slot="copy-text-body"]')?.textContent;
  const button = () => block()?.querySelector("button") ?? null;
  const copy = async () => {
    await act(async () => {
      button()?.click();
    });
    return copied.at(-1);
  };

  it("draws the text as text and copies exactly the raw text, blank lines and indentation kept", async () => {
    const text = [
      "",
      "  Hello **Ms Okafor**,",
      "  1. the offer <b>stands</b> & holds",
      "see [the plan](https://evil.example.net/plan)",
      "Kind regards  ",
      ""
    ].join("\n");
    await renderFile(
      `Here is the reply:\n\n\`\`\`copy Reply to the supplier\n${text}\n\`\`\`\n\nDone.`
    );

    expect(body()).toBe(text);
    // Nothing inside is read as Markdown or HTML.
    expect(block()?.querySelector("strong, b, a, ol, code, pre")).toBeNull();
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull();
    expect(await copy()).toBe(text);
  });

  it("leaves every other fence a code block", async () => {
    await renderFile("```text\ncopy me\n```\n\n```copyright\nnot this either\n```");

    expect(block()).toBeNull();
    expect(container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(2);
  });

  it("shows the text as it arrives and offers the copy once the fence is closed", async () => {
    await renderReply("Here it is:\n\n```copy Reply to the supplier\nHello **Ms", true);
    // The half-written emphasis is not completed, as it would be outside a fence.
    expect(body()).toBe("Hello **Ms");
    expect(button()).toBeNull();

    await renderReply("> ```copy\n> Hello", true);
    expect(button()).toBeNull();
    await renderReply("> ```copy\n> Hello\n> ```", true);
    expect(button()).not.toBeNull();

    // A shorter fence inside does not close the longer one.
    await renderReply("````copy\nRun:\n```sh\nnpm test\n```", true);
    expect(button()).toBeNull();
    await renderReply("````copy\nRun:\n```sh\nnpm test\n```\n````", true);
    expect(await copy()).toBe("Run:\n```sh\nnpm test\n```");
  });

  it("copies a text whose fence never closed once the reply has ended", async () => {
    await renderReply("```copy\nHello Ms Okafor,\nthanks.", false);

    expect(body()).toBe("Hello Ms Okafor,\nthanks.");
    expect(await copy()).toBe("Hello Ms Okafor,\nthanks.");
  });
});
