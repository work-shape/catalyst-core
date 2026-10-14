import { createElement, createRef } from "react";
import { describe, expect, it } from "vitest";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import {
  AgentEditor,
  agentConfigToForm,
  connectionToolsView,
  editedAgentConfig,
  setPackageTools,
  toggleToolName,
  toolPackages,
  type ConnectionToolsRead
} from "@vivd-catalyst/chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// The Connections in an agent's Tools section, a chip each as the packages are (TOOLS-1), on
// answers of `connections.list_tools` handed to the page. That the instance answers a reader only the
// Connections the reader may read, and only operations agents may call, is held in
// tests/connection-operation-answers.test.ts. Every test here fails without them: the section
// then offered the release's tools alone.

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
  const chip = (markup: string, key: string) =>
    new RegExp(`data-tool-package="${key}">.*?</li>`, "u").exec(markup)?.[0] ?? "";

  it("shows a Connection the agent uses as a chip with its count, beside the packages", () => {
    const markup = tools({
      config: { toolNames: ["read_skill", "connection.crm.find_customer"] },
      enabledToolNames: ["read_skill"],
      connectionTools: answered
    });

    // The Connection is a chip like a package; one of its two operations is on.
    expect(chip(markup, "connection:crm")).toContain("Customer records");
    expect(chip(markup, "connection:crm")).toContain("1/2");
    expect(chip(markup, "connection:crm")).toContain('aria-label="Remove"');
    expect(chip(markup, "connection:crm")).toContain('aria-haspopup="dialog"');
    // A Connection the agent does not use is not a chip: the picker offers it.
    expect(markup).not.toContain('data-tool-package="connection:ledger"');
    expect(markup).toContain("Add packages");
    // The operations stand in the chip's panel, not on the page at rest.
    expect(markup).not.toContain("find_customer<");
    expect(markup).not.toContain("data-unavailable-option");
  });

  it("offers every Connection the agent does not use in the picker, with its tools all on once added", () => {
    const view = toolPackages({
      references: undefined,
      selected: [],
      skillNames: [],
      locale: "en",
      connections: answered
    });
    const ledger = view.find((item) => item.key === "connection:ledger");

    expect(view.map((item) => item.key)).toEqual(["connection:crm", "connection:ledger"]);
    expect(ledger?.heldCount).toBe(0);
    expect(ledger ? setPackageTools([], ledger, true) : []).toHaveLength(13);
  });

  it("keeps a tool whose Connection or operation the reader is not offered, marked as unavailable", () => {
    const held = ["connection.crm.gone", "connection.payroll.read_salary"];
    const markup = tools({ config: { toolNames: held }, connectionTools: answered });

    const group = markup.slice(markup.indexOf('data-tool-group="unavailable"'));
    expect(group).toContain(
      "These tools are no longer offered to this agent. The agent keeps each one until you remove it."
    );
    for (const toolName of held) {
      expect(group).toContain(`data-unavailable-option="${toolName}"`);
    }
    expect(group).toContain('aria-label="Remove"');
    // The reader learns nothing of a Connection the instance did not answer.
    expect(markup).not.toContain('data-tool-package="connection:payroll"');

    // Saving sends every name the reader did not remove, also the ones no chip offers.
    const config = { ...agentBase, toolNames: held };
    const ticked = toggleToolName(held, "connection.crm.add_note", true);
    expect(
      editedAgentConfig({ ...agentConfigToForm(config), toolNames: ticked }, config).toolNames
    ).toEqual([...held, "connection.crm.add_note"]);
    expect(connectionToolsView(answered, ticked).unavailable).toEqual(held);
    expect(toggleToolName(ticked, "connection.crm.gone", false)).toEqual([
      "connection.payroll.read_salary",
      "connection.crm.add_note"
    ]);
  });

  it("shows a reader without a right on any Connection none, keeps what the agent holds, and lets a reader remove nothing", () => {
    // The instance answers such a reader an empty list.
    const nothing: ConnectionToolsRead = { status: "ready", connections: [] };
    const markup = tools({
      config: { toolNames: ["connection.crm.find_customer"] },
      connectionTools: nothing
    });
    expect(markup).not.toContain('data-tool-package="connection:');
    expect(markup).not.toContain("Customer records");
    expect(markup).toContain('data-unavailable-option="connection.crm.find_customer"');

    const readOnly = tools({
      config: { toolNames: ["connection.crm.find_customer", "connection.crm.gone"] },
      connectionTools: answered,
      editableAgentFields: []
    });
    expect(chip(readOnly, "connection:crm")).toContain("Customer records");
    expect(readOnly).not.toContain('aria-label="Remove"');
    expect(readOnly).not.toContain("Add packages");
  });

  it("judges nothing while the instance did not answer", () => {
    const unknown = tools({
      config: { toolNames: ["connection.crm.find_customer"] },
      connectionTools: { status: "unknown" }
    });
    expect(unknown).toContain('data-held-option="connection.crm.find_customer"');
    expect(unknown).toContain("The connections could not be read, so this was not checked.");
    expect(unknown).not.toContain("data-unavailable-option");
    expect(unknown).not.toContain('data-tool-package="connection:');
  });

  it("says it in German", () => {
    const markup = tools({
      config: { toolNames: ["connection.crm.gone", "connection.crm.find_customer"] },
      connectionTools: answered,
      locale: "de"
    });
    expect(chip(markup, "connection:crm")).toContain("1/2");
    expect(markup).toContain("Pakete hinzufügen");
    expect(markup).toContain(
      "Diese Werkzeuge werden diesem Agenten nicht mehr angeboten. Der Agent behält sie, bis du sie entfernst."
    );
  });
});
