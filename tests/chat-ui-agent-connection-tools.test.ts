import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import {
  AgentEditor,
  agentConfigToForm,
  connectionToolsView,
  editedAgentConfig,
  toggleToolName,
  type ConnectionToolsRead
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The group of the Connections in an agent's Tools section, on answers of
// `connections.list_tools` handed to the page. That the instance answers a reader only the
// Connections the reader may read, and only operations agents may call, is held in
// tests/connection-operation-answers.test.ts. Every test here fails without the group: the
// section then offered the release's tools alone.

const noop = () => undefined;

const agentBase = {
  name: "assistant",
  displayName: "Assistant",
  instructions: "Help the user.",
  toolNames: [],
  skillNames: [],
  initialPrompts: []
};

interface AgentInput {
  config?: Record<string, unknown>;
  enabledToolNames?: string[];
  /** What the instance answered of the tools of Connections. */
  connectionTools: ConnectionToolsRead;
  editableAgentFields?: string[];
  locale?: LocaleCode;
}

/** The Tools section of the agent's page. */
function tools(input: AgentInput): string {
  const config = { ...agentBase, ...input.config };
  const markup = renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: input.locale ?? "en" },
      createElement(AgentEditor, {
        frame: {
          page: { ref: createRef<HTMLDivElement>(), above: null, shown: noop },
          asset: {
            id: "asset_agent",
            kind: "agent",
            name: config.name,
            scope: { kind: "instance" },
            revision: 3,
            config,
            updatedAt: "2026-10-08T10:00:00.000Z"
          },
          start: undefined,
          canWrite: true,
          instanceWrite: true,
          back: null,
          actions: null,
          notice: null,
          onUnsavedChange: noop,
          save: async () => ({ ok: true as const })
        },
        initialForm: agentConfigToForm(config),
        isDefault: false,
        references: {
          modelProviderIds: [],
          modelBindingIds: [],
          modelBindings: [],
          fastModeModelBindingIds: [],
          reasoningEfforts: [],
          enabledToolNames: input.enabledToolNames ?? []
        },
        editableAgentFields: input.editableAgentFields ?? ["toolNames"],
        canManageAgentModels: false,
        skillChoice: { options: [], onSearch: noop },
        connectionTools: {
          read: input.connectionTools,
          place: (name: string) => ({ href: `/build/connections/${name}`, open: noop })
        }
      })
    )
  );
  return /<section[^>]*id="tools">.*?<\/section>/u.exec(markup)?.[0] ?? "";
}

describe("tools of Connections on the agent page", () => {
  /** What `connections.list_tools` answers a reader who may read these two Connections. */
  const answered: ConnectionToolsRead = {
    status: "ready",
    connections: [
      {
        name: "crm",
        title: "Customer records",
        tools: [
          {
            toolName: "connection.crm.find_customer",
            operation: "find_customer",
            description: "Finds a customer by name.",
            effect: "reading"
          },
          { toolName: "connection.crm.add_note", operation: "add_note", effect: "changing" }
        ]
      },
      {
        name: "ledger",
        title: "Ledger",
        tools: Array.from({ length: 13 }, (_unused, index) => ({
          toolName: `connection.ledger.report_${index}`,
          operation: `report_${index}`,
          effect: "reading" as const
        }))
      }
    ]
  };
  const boxOf = (markup: string, toolName: string) =>
    new RegExp(`<button[^>]*data-connection-tool="${toolName}"[^>]*>`, "u").exec(markup)?.[0] ?? "";

  it("offers a check box per operation under the Connection's label, with description and effect", () => {
    const markup = tools({
      config: { toolNames: ["read_skill", "connection.crm.find_customer"] },
      enabledToolNames: ["read_skill"],
      connectionTools: answered
    });

    // The instance's own tools keep their group, and the Connections are a second one.
    expect(markup).toContain('<legend class="sr-only">Tools</legend>');
    expect(markup).toContain('data-tool-group="connections"');
    expect(markup).toContain('data-connection-tools="crm"');
    expect(markup).toContain("Customer records");
    expect(markup).toContain("1 of 2 selected");
    expect(markup).toContain("Finds a customer by name.");
    expect(markup).toContain("Reading");
    expect(markup).toContain("Changing");
    expect(markup).toContain('href="/build/connections/crm"');
    expect(boxOf(markup, "connection.crm.find_customer")).toContain('aria-checked="true"');
    expect(boxOf(markup, "connection.crm.add_note")).toContain('aria-checked="false"');
    // A tool of a Connection is no box among the instance's own tools.
    expect(markup.split("connection.crm.find_customer")).toHaveLength(2);
    expect(markup).not.toContain("data-unavailable-option");
  });

  it("folds a Connection with more than twelve operations and says how many it has", () => {
    const markup = tools({ connectionTools: answered });
    const ledger = markup.slice(markup.indexOf('data-connection-tools="ledger"'));

    expect(ledger).toContain("0 of 13 selected");
    expect(ledger).toContain('data-state="closed"');
    // What is folded is not built: a long Connection costs one line.
    expect(markup).not.toContain("connection.ledger.report_0");
    expect(boxOf(markup, "connection.crm.add_note")).not.toBe("");
  });

  it("keeps a tool whose Connection or operation the reader is not offered, marked as unavailable", () => {
    const held = ["connection.crm.gone", "connection.payroll.read_salary"];
    const markup = tools({ config: { toolNames: held }, connectionTools: answered });

    for (const toolName of held) {
      expect(markup).toContain(`data-unavailable-option="${toolName}"`);
    }
    expect(markup).toContain("The agent keeps it until you remove it.");
    expect(markup).toContain('aria-label="Remove"');
    // The reader learns nothing of a Connection the instance did not answer.
    expect(markup).not.toContain('data-connection-tools="payroll"');

    // Saving sends every name the reader did not remove, also the ones no group offers.
    const config = { ...agentBase, toolNames: held };
    const ticked = toggleToolName(held, "connection.crm.add_note", true);
    expect(
      editedAgentConfig({ ...agentConfigToForm(config), toolNames: ticked }, config).toolNames
    ).toEqual([...held, "connection.crm.add_note"]);
    expect(connectionToolsView(answered, ticked).unavailable).toEqual(held);
    // Only what the reader removes leaves.
    expect(toggleToolName(ticked, "connection.crm.gone", false)).toEqual([
      "connection.payroll.read_salary",
      "connection.crm.add_note"
    ]);
  });

  it("shows a reader without a right on any Connection no operation, and keeps what the agent holds", () => {
    // The instance answers such a reader an empty list.
    const nothing: ConnectionToolsRead = { status: "ready", connections: [] };
    const markup = tools({
      config: { toolNames: ["connection.crm.find_customer"] },
      connectionTools: nothing
    });

    expect(markup).toContain("No connection you may read offers an operation to agents.");
    expect(markup).not.toContain("data-connection-tools=");
    expect(markup).not.toContain("Customer records");
    expect(markup).toContain('data-unavailable-option="connection.crm.find_customer"');

    // A reader who may not change the agent's tools can remove nothing.
    const readOnly = tools({
      config: { toolNames: ["connection.crm.find_customer", "connection.crm.gone"] },
      connectionTools: answered,
      editableAgentFields: []
    });
    expect(boxOf(readOnly, "connection.crm.find_customer")).toContain("disabled");
    expect(readOnly).not.toContain('aria-label="Remove"');
  });

  it("judges nothing while the instance did not answer, and shows no group to an agent without such tools", () => {
    const unknown = tools({
      config: { toolNames: ["connection.crm.find_customer"] },
      connectionTools: { status: "unknown" }
    });
    expect(unknown).toContain('data-held-option="connection.crm.find_customer"');
    expect(unknown).toContain("The connections could not be read, so this was not checked.");
    expect(unknown).not.toContain("data-unavailable-option");

    const plain = tools({ connectionTools: { status: "unknown" } });
    expect(plain).not.toContain('data-tool-group="connections"');
  });

  it("says it in German", () => {
    const markup = tools({
      config: { toolNames: ["connection.crm.gone"] },
      connectionTools: answered,
      locale: "de"
    });
    expect(markup).toContain("Verbindungen");
    expect(markup).toContain("0 von 2 ausgewählt");
    expect(markup).toContain("Verbindung öffnen");
    expect(markup).toContain("bis du sie entfernst");
  });
});
