import { createElement } from "react";
import { describe, expect, it } from "vitest";
import {
  ToolCallFoldLabel,
  ToolCallPart,
  ToolSubjectsProvider
} from "@work-shape/catalyst-chat-ui/tool-call";
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
    expect(sentence(render(READ))).toBe("Read revenue by month from Sample business · 0 rows");
    expect(sentence(render(CHANGE))).toBe("Changed Sample business: create offer");
    expect(sentence(render(READ, { running: true }))).toBe(
      "Reading revenue by month from Sample business"
    );
    expect(sentence(render(CHANGE, { running: true }))).toBe(
      "Changing Sample business: create offer"
    );
  });

  it("says it in German, the name where German puts it", () => {
    expect(sentence(render(READ, {}, "de"))).toBe(
      "Revenue by month aus Sample business gelesen · 0 Zeilen"
    );
    expect(sentence(render(CHANGE, { running: true }, "de"))).toBe(
      "Ändert Sample business: create offer"
    );
  });

  it("shows the Connection's icon on its tile, and no technical name in the line", () => {
    const markup = render(READ);
    const head = markup.slice(0, markup.indexOf("</button>"));
    expect(head).toContain('data-connection-icon="database"');
    expect(head).not.toContain("revenue_by_month");
    expect(head).not.toContain("Revenue By Month");
  });

  it("keeps the name the agent called under the closed technical details", () => {
    // A failed call opens by itself, with its technical details closed.
    const markup = render(READ, { result: { error: "It failed." }, isError: true });
    expect(sentence(markup)).toBe("Could not read revenue by month from Sample business");
    expect(markup).toContain("Technical details");
    expect(markup).not.toContain("tool-technical-name");
  });

  it("names a Connection nobody lists any more by its id, with the generic icon", () => {
    const markup = render(READ, { known: false });
    expect(sentence(markup)).toBe("Used sample-business: revenue by month · 0 rows");
    expect(markup).toContain('data-connection-icon="generic"');
  });

  it("gives every other tool call its title and no Connection icon", () => {
    const markup = render("demo.workflow_summary");
    expect(markup).not.toContain("tool-call-sentence");
    expect(markup).not.toContain("data-connection-icon");
    expect(markup).toContain("Workflow Summary");
  });
});

describe("the fold of a group of tool calls", () => {
  const fold = (
    props: { only?: { toolName: string; result?: unknown }; count: number },
    locale: "en" | "de" = "en"
  ) =>
    renderToStaticMarkup(
      createElement(
        TranslationProvider,
        { children: null, locale },
        createElement(
          ToolSubjectsProvider,
          { agents, children: null },
          createElement(ToolCallFoldLabel, props)
        )
      )
    );
  const done = { toolName: READ, result: { rows: [] } };

  it("says what its one call of a Connection did, beside the Connection's tile", () => {
    expect(sentence(fold({ only: done, count: 1 }))).toBe(
      "Read revenue by month from Sample business · 0 rows"
    );
    expect(sentence(fold({ only: done, count: 1 }, "de"))).toBe(
      "Revenue by month aus Sample business gelesen · 0 Zeilen"
    );
    expect(sentence(fold({ only: { toolName: READ }, count: 1 }, "de"))).toBe(
      "Liest revenue by month aus Sample business"
    );
    expect(fold({ only: done, count: 1 })).toContain('data-connection-icon="database"');
    expect(fold({ only: done, count: 1 })).not.toContain("tool call");
  });

  it("counts several calls as steps, and says what its one other call did", () => {
    const row = (markup: string) =>
      /data-testid="tool-call-row"[^>]*>([^<]*)<\/span>/u.exec(markup)?.[1];
    expect(fold({ count: 3 })).toBe("3 steps");
    expect(fold({ count: 3 }, "de")).toBe("3 Schritte");
    expect(row(fold({ only: { toolName: "demo.workflow_summary", result: {} }, count: 1 }))).toBe(
      "Workflow Summary"
    );
    expect(row(fold({ only: { toolName: "read_skill", result: {} }, count: 1 }, "de"))).toBe(
      "Anleitung lesen"
    );
  });
});
