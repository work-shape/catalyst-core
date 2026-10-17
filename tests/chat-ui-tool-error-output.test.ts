import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolCallPart, readToolDetailSections } from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";

// An open tool call in the work history. An output that is only an error is a sentence for a
// person: what happened, whether trying again helps and who can act. It was shown as one line
// of JSON in a code box, cut at the right edge. The id of the call is never shown.

const SENTENCE =
  "The connection Sample business cannot be used right now. Trying again later may work. If it keeps failing, an administrator can check it under Studio > Connections.";
const labels = { input: "Input", output: "Output" };
const call = {
  toolName: "connection.sample-business.revenue_by_month",
  toolCallId: "call_oMQyHBpus3gSRrAQfi4ImSzL",
  args: { from: "2026-07-01", to: "2026-09-30" }
};

function render(props: { result: unknown; isError?: boolean }): string {
  return renderToStaticMarkup(
    createElement(
      ToolDisplayPanelProvider,
      null,
      createElement(ToolCallPart, {
        ...call,
        ...props,
        type: "tool-call" as const,
        argsText: JSON.stringify(call.args),
        status: { type: "complete" as const },
        addResult: () => undefined,
        resume: () => undefined,
        respondToApproval: () => undefined
      })
    )
  );
}

describe("the output of a tool call in the work history", () => {
  it("shows an output that is only an error as wrapped text, the whole sentence", () => {
    // A failed call opens by itself and says why; its input and output stay under the closed
    // technical details (UXA-7b).
    const markup = render({ result: { error: SENTENCE }, isError: true });
    const text = /<p[^>]*>([^<]*)<\/p>/u.exec(markup);
    expect(text?.[1]).toBe(SENTENCE.replace(">", "&gt;"));
    expect(text?.[0]).toContain("[overflow-wrap:anywhere]");
    // Not as JSON, and no code box until the technical details are opened.
    expect(markup).not.toContain("&quot;error&quot;");
    expect(markup).not.toContain("<pre");
    expect(markup).toContain("Technical details");
  });

  it("keeps every other output as data in a code box", () => {
    const sections = (result: unknown) =>
      readToolDetailSections({ ...call, labels, result }).find(
        (section) => section.label === "Output"
      );
    expect(sections({ error: SENTENCE })).toEqual({
      label: "Output",
      value: SENTENCE,
      kind: "text"
    });
    // An error beside other fields, an error that is not a string and an empty one are data.
    for (const result of [
      { error: SENTENCE, code: "CONFLICT" },
      { error: { message: SENTENCE } },
      { rows: [{ month: "2026-07", revenueCents: 4374698 }] }
    ]) {
      expect(sections(result)).toEqual({
        label: "Output",
        value: JSON.stringify(result, null, 2)
      });
    }
    expect(sections({ error: "  " })?.kind).toBeUndefined();
  });

  it("never writes the id of the call into the page, whatever the state of the call", () => {
    for (const props of [
      { result: { error: SENTENCE }, isError: true },
      { result: { output: { rows: [] } } },
      { result: undefined }
    ]) {
      expect(render(props)).not.toContain(call.toolCallId);
    }
  });
});
