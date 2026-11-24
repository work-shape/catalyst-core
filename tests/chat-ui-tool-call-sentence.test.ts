import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ToolCallPart, ToolSubjectsProvider } from "@work-shape/catalyst-chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@work-shape/catalyst-chat-ui/tool-display-panel";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// A tool call of a Connection in a conversation. It reads as what was done and with what,
// beside the Connection's icon on its tile. The name the agent called stays under the
// technical details, for whoever builds the agent.

const READ = "connection.sample-business.revenue_by_month";
const CHANGE = "connection.sample-business.create_offer";

const agents = [
  {
    connections: [
      {
        name: "sample-business",
        title: "Sample business",
        connectorType: "postgres",
        tools: [
          { toolName: READ, effect: "reading" as const },
          { toolName: CHANGE, effect: "changing" as const }
        ]
      }
    ]
  }
];

function render(
  toolName: string,
  props: { result?: unknown; isError?: boolean; running?: boolean; known?: boolean } = {}
): string {
  const { running = false, known = true, ...call } = props;
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" },
      createElement(
        ToolDisplayPanelProvider,
        null,
        createElement(
          ToolSubjectsProvider,
          { agents: known ? agents : [], children: null },
          createElement(ToolCallPart, {
            toolName,
            toolCallId: "call_1",
            args: { from: "2026-07-01" },
            argsText: '{"from":"2026-07-01"}',
            result: running ? undefined : { rows: [] },
            ...call,
            type: "tool-call" as const,
            status: running ? { type: "running" as const } : { type: "complete" as const },
            addResult: () => undefined,
            resume: () => undefined,
            respondToApproval: () => undefined
          })
        )
      )
    )
  );
}

const sentence = (markup: string) =>
  /data-testid="tool-call-sentence"[^>]*>((?:[^<]|<span[^>]*>[^<]*<\/span>)*)<\/span>/u
    .exec(markup)?.[1]
    ?.replace(/<[^>]+>/gu, "");

describe("a tool call of a Connection in a conversation", () => {
  it("says what was done with the Connection, by the name people read", () => {
    expect(sentence(render(READ))).toBe("Read revenue by month from Sample business · 0 rows");
    expect(sentence(render(CHANGE))).toBe("Changed Sample business: create offer");
  });

  it("shows the Connection's icon on its tile, and no technical name in the line", () => {
    const markup = render(READ);
    const head = markup.slice(0, markup.indexOf("</button>"));
    expect(head).toContain('data-connection-icon="database"');
    expect(head).not.toContain("revenue_by_month");
    expect(head).not.toContain("Revenue By Month");
  });

  it("names a Connection nobody lists any more by its id, with the generic icon", () => {
    const markup = render(READ, { known: false });
    expect(sentence(markup)).toBe("Used sample-business: revenue by month · 0 rows");
    expect(markup).toContain('data-connection-icon="generic"');
  });
});
