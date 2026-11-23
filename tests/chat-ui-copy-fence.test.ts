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
  const label = () => container.querySelector('[data-slot="copy-text-label"]')?.textContent;
  const button = () => block()?.querySelector("button") ?? null;
  const copy = async () => {
    await act(async () => {
      button()?.click();
    });
    return copied.at(-1);
  };

  it("draws the text as text, with its label, and copies exactly the raw text", async () => {
    const text = [
      "Hello **Ms Okafor**,",
      "",
      "  1. the offer <b>stands</b> & holds",
      "see [the plan](https://evil.example.net/plan)",
      "",
      "Kind regards"
    ].join("\n");
    await renderFile(
      `Here is the reply:\n\n\`\`\`copy Reply to the supplier\n${text}\n\`\`\`\n\nDone.`
    );

    expect(block()?.getAttribute("aria-label")).toBe("Reply to the supplier");
    expect(label()).toBe("Reply to the supplier");
    expect(body()).toBe(text);
    // Nothing inside is read as Markdown or HTML.
    expect(block()?.querySelector("strong, b, a, ol, code, pre")).toBeNull();
    expect(container.querySelector('[data-streamdown="code-block"]')).toBeNull();
    expect(button()?.getAttribute("aria-label")).toBe(uiLabelsEn.copy);
    expect(await copy()).toBe(text);
    expect(button()?.getAttribute("aria-label")).toBe(uiLabelsEn.copied);
  });

  it("has no label when the fence line names none", async () => {
    await renderFile("```copy\nSee you on Thursday.\n```");

    expect(label()).toBeUndefined();
    expect(block()?.hasAttribute("aria-label")).toBe(false);
    expect(await copy()).toBe("See you on Thursday.");
  });

  it("keeps blank lines and indentation at both ends of the text", async () => {
    const text = "\n  indented first line\nlast line  \n";
    await renderFile(`\`\`\`copy\n${text}\n\`\`\``);

    expect(body()).toBe(text);
    expect(await copy()).toBe(text);
  });

  it("holds a fence of another kind inside a longer fence", async () => {
    const text = "Run this:\n```sh\nnpm test\n```";
    await renderFile(`\`\`\`\`copy\n${text}\n\`\`\`\``);

    expect(await copy()).toBe(text);
  });

  it("leaves every other fence a code block", async () => {
    await renderFile("```text\ncopy me\n```\n\n```copyright\nnot this either\n```");

    expect(block()).toBeNull();
    expect(container.querySelectorAll('[data-streamdown="code-block"]')).toHaveLength(2);
  });

  it("shows the text as it arrives and offers the copy once the fence is closed", async () => {
    await renderReply("Here it is:\n\n```copy Reply", true);
    expect(block()).not.toBeNull();
    expect(body()).toBe("");
    expect(button()).toBeNull();

    await renderReply("Here it is:\n\n```copy Reply to the supplier\nHello **Ms", true);
    expect(label()).toBe("Reply to the supplier");
    // The half-written emphasis is not completed, as it would be outside a fence.
    expect(body()).toBe("Hello **Ms");
    expect(button()).toBeNull();

    await renderReply(
      "Here it is:\n\n```copy Reply to the supplier\nHello **Ms Okafor**,\nthanks.\n```\n\nAnything",
      true
    );
    expect(body()).toBe("Hello **Ms Okafor**,\nthanks.");
    expect(await copy()).toBe("Hello **Ms Okafor**,\nthanks.");
  });

  it("waits for the closing line also inside a quote, a list and a longer fence", async () => {
    await renderReply("> ```copy\n> Hello", true);
    expect(body()).toBe("Hello");
    expect(button()).toBeNull();
    await renderReply("> ```copy\n> Hello\n> ```", true);
    expect(button()).not.toBeNull();

    await renderReply("- Draft:\n\n  ```copy\n  Hello", true);
    expect(button()).toBeNull();
    await renderReply("- Draft:\n\n  ```copy\n  Hello\n  ```", true);
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
