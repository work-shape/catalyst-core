import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { ToolCallPart, ToolSubjectsProvider } from "@vivd-catalyst/chat-ui/tool-call";
import { ToolDisplayPanelProvider } from "@vivd-catalyst/chat-ui/tool-display-panel";
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
  props: { result?: unknown; isError?: boolean; running?: boolean; known?: boolean } = {},
  locale: "en" | "de" = "en"
): string {
  const { running = false, known = true, ...call } = props;
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale },
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
    expect(sentence(render(READ))).toBe("Read Sample business");
    expect(sentence(render(CHANGE))).toBe("Changed Sample business");
    expect(sentence(render(READ, { running: true }))).toBe("Reading Sample business");
    expect(sentence(render(CHANGE, { running: true }))).toBe("Changing Sample business");
  });

  it("says it in German, the name where German puts it", () => {
    expect(sentence(render(READ, {}, "de"))).toBe("Sample business gelesen");
    expect(sentence(render(CHANGE, { running: true }, "de"))).toBe("Ändert Sample business");
  });

  it("shows the Connection's icon on its tile, and no technical name in the line", () => {
    const markup = render(READ);
    const head = markup.slice(0, markup.indexOf("</button>"));
    expect(head).toContain('data-connection-icon="database"');
    expect(head).not.toContain("revenue_by_month");
    expect(head).not.toContain("Revenue By Month");
  });

  it("keeps the name the agent called under the technical details", () => {
    // A failed call opens by itself.
    const markup = render(READ, { result: { error: "It failed." }, isError: true });
    expect(sentence(markup)).toBe("Could not read Sample business");
    expect(markup).toContain("Technical details");
    expect(markup).toMatch(new RegExp(`data-testid="tool-technical-name"[^>]*>${READ}<`, "u"));
  });

  it("names a Connection nobody lists any more by its id, with the generic icon", () => {
    const markup = render(READ, { known: false });
    expect(sentence(markup)).toBe("Used sample-business");
    expect(markup).toContain('data-connection-icon="generic"');
  });

  it("leaves every other tool call as it was", () => {
    const markup = render("demo.workflow_summary");
    expect(markup).not.toContain("tool-call-sentence");
    expect(markup).not.toContain("data-connection-icon");
    expect(markup).toContain("Workflow Summary");
  });
});
