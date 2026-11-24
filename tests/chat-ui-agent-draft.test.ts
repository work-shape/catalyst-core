import { createElement, createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiError, type AgentDraft, type OperationOutcome } from "@work-shape/catalyst-api-client";
import { createTranslationContext } from "./support/chat-ui/shared";
import {
  AgentEditor,
  AgentUnavailableNotices,
  agentConfigToForm,
  answerOfRevision,
  connectionToolsView,
  decideDraft,
  draftAgentFields,
  draftAuthorLabel,
  editedAgentConfig,
  readDraftRefusal,
  savedAgentUnavailable,
  setPackageTools,
  toggleToolName,
  toolPackages,
  type AgentDraftSource,
  type ConnectionToolsRead,
  type BuildAssetEditorProps
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";

// AD-4, Navigation check 44 (component half): the agent page edits the agent's one draft. The
// fields show the draft and each changed field the published value under it; the head carries
// the draft badge with its revision, the banner its author and time, and Publish for a holder of
// agent.publish; a writer without that right sees Publish disabled with the right named.

const live = {
  name: "assistant",
  displayName: "Assistant",
  instructions: "Help the user.",
  toolNames: [],
  skillNames: ["tax-review"],
  initialPrompts: []
};

const drafted = {
  ...live,
  instructions: "Help the user and cite the contract.",
  skillNames: ["contract-check"]
};

const noop = () => undefined;

function frame(overrides: Partial<BuildAssetEditorProps> = {}): BuildAssetEditorProps {
  return {
    page: { ref: createRef<HTMLDivElement>(), above: null, shown: noop },
    asset: {
      id: "asset_agent",
      kind: "agent",
      name: "assistant",
      scope: { kind: "instance" },
      revision: 3,
      config: live,
      updatedAt: "2026-10-17T01:00:00.000Z"
    },
    start: undefined,
    canWrite: true,
    draft: { canPublish: true },
    instanceWrite: false,
    back: null,
    actions: {},
    notice: null,
    onUnsavedChange: noop,
    save: async () => ({ ok: true }),
    ...overrides
  };
}

function draftOf(config: Record<string, unknown>, overrides: Partial<AgentDraft> = {}): AgentDraft {
  return {
    agent: "assistant",
    revision: 2,
    baseRevision: 3,
    liveRevision: 3,
    stale: false,
    config,
    author: { userId: "user_ana", name: "Ana Writer", release: false },
    updatedAt: "2026-10-17T09:30:00.000Z",
    ...overrides
  };
}

function source(
  latest: AgentDraft | null,
  overrides: Partial<AgentDraftSource> = {}
): AgentDraftSource {
  return {
    latest,
    reread: async () => undefined,
    saved: ({ revision, config, liveRevision }) =>
      draftOf(config, { revision, baseRevision: liveRevision }),
    decide: async () => undefined,
    busy: undefined,
    answerFor: () => undefined,
    ...overrides
  };
}

function agentPage(
  draft: AgentDraftSource | undefined,
  {
    frame: frameOverrides = {},
    connectionTools
  }: {
    frame?: Partial<BuildAssetEditorProps>;
    connectionTools?: ConnectionToolsRead;
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" as const },
      createElement(AgentEditor, {
        frame: frame(frameOverrides),
        initialForm: agentConfigToForm(draft?.latest?.config ?? live),
        isDefault: false,
        references: undefined,
        editableAgentFields: ["instructions", "skillNames"],
        canManageAgentModels: false,
        skillChoice: { options: [{ name: "tax-review", title: "Tax review" }], onSearch: noop },
        ...(connectionTools === undefined ? {} : { connectionTools: { read: connectionTools } }),
        ...(draft === undefined ? {} : { draft })
      })
    )
  );
}

/** The fields the page marks as changed by the draft, in the order of the page. */
function marks(markup: string) {
  return [...markup.matchAll(/data-draft-group="([^"]+)"/gu)].map((match) => match[1]);
}

const publishButton = (markup: string) => /<button[^>]*data-agent-publish[^>]*>/u.exec(markup)?.[0];

describe("the fields a draft changes", () => {
  it("are the fields that differ from the live agent, in the order of the page", () => {
    const form = agentConfigToForm(live);
    expect(draftAgentFields(form, form)).toEqual([]);
    expect(
      draftAgentFields(
        form,
        agentConfigToForm({ ...drafted, modelBindingId: "fast", displayName: "Helper" })
      )
    ).toEqual(["displayName", "instructions", "model", "skillNames"]);
  });
});

describe("the agent page with a draft", () => {
  it("shows the draft in the fields, a list's live value under it, and the draft's revision in the head", () => {
    const markup = agentPage(source(draftOf(drafted)));
    expect(marks(markup)).toEqual(["instructions", "skillNames"]);
    expect(markup).toContain(">Help the user and cite the contract.</textarea>");
    expect(markup).toMatch(/data-published-field="skillNames"[\s\S]*?Tax review/u);
    expect(markup).toMatch(/data-asset-status="draft"[^>]*data-draft-revision="2"/u);
  });

  it("names a published tool of a Connection by the Connection's title, not its tool name", () => {
    const tool = "connection.ledger.listClients";
    const markup = agentPage(source(draftOf(drafted)), {
      frame: {
        asset: {
          id: "asset_agent",
          kind: "agent",
          name: "assistant",
          scope: { kind: "instance" },
          revision: 3,
          config: { ...live, toolNames: [tool] },
          updatedAt: "2026-10-17T01:00:00.000Z"
        }
      },
      connectionTools: {
        status: "ready",
        connections: [
          {
            name: "ledger",
            title: "Ledger",
            tools: [{ toolName: tool, operation: "listClients", effect: "reading" }]
          }
        ]
      }
    });
    const published = /data-published-field="toolNames"[\s\S]*?<\/p>/u.exec(markup)?.[0] ?? "";
    expect(published).toContain("Ledger");
    expect(published).not.toContain(tool);
  });

  it("offers Publish to a holder of agent.publish, disabled to a writer without it, and none for a stale draft", () => {
    expect(publishButton(agentPage(source(draftOf(drafted))))).not.toContain('disabled=""');
    expect(
      publishButton(
        agentPage(source(draftOf(drafted)), { frame: { draft: { canPublish: false } } })
      )
    ).toContain('disabled=""');
    const stale = agentPage(source(draftOf(drafted, { stale: true, liveRevision: 4 })));
    expect(stale).toContain('data-agent-draft="stale"');
    expect(publishButton(stale)).toBeUndefined();
  });

  it("shows what a decision answered: a newer draft, a failure, or a wait for approval", () => {
    expect(
      agentPage(source(draftOf(drafted), { answerFor: () => ({ kind: "changed" }) }))
    ).toContain('data-agent-draft="changed"');
    const failed = agentPage(
      source(draftOf(drafted), { answerFor: () => ({ kind: "failed", message: "Not now." }) })
    );
    expect(failed).toMatch(/data-agent-draft-answer="failed"[^>]*>[\s\S]*Not now\./u);
    expect(agentPage(source(draftOf(drafted), { answerFor: () => ({ kind: "waits" }) }))).toContain(
      'data-agent-draft-answer="waits"'
    );
  });

  it("locks the fields while Publish or Discard is on its way", () => {
    const locked = (markup: string) => [...markup.matchAll(/<fieldset disabled=""/gu)].length;
    expect(locked(agentPage(source(draftOf(drafted))))).toBe(0);
    const busy = agentPage(source(draftOf(drafted), { busy: "publish" }));
    expect(locked(busy)).toBe([...busy.matchAll(/<fieldset/gu)].length);
    expect(locked(busy)).toBeGreaterThan(0);
  });
});

describe("the agent page without a draft", () => {
  it("shows the live agent with no marks or Publish, and a reader nothing of a draft", () => {
    const markup = agentPage(source(null));
    expect(marks(markup)).toEqual([]);
    expect(markup).not.toContain("data-agent-draft");
    expect(publishButton(markup)).toBeUndefined();
    expect(markup).toContain(">Help the user.</textarea>");
    const reader = agentPage(undefined, {
      frame: { canWrite: false, draft: { canPublish: false } }
    });
    expect(reader).not.toContain("data-agent-draft");
    expect(publishButton(reader)).toBeUndefined();
  });
});

describe("the author of a draft", () => {
  const { t } = createTranslationContext("en");
  it("is the person by name, with the agent, the team that runs the instance, or someone gone", () => {
    expect(draftAuthorLabel({ userId: "u", name: "Ana Writer", release: false }, t)).toBe(
      "Ana Writer"
    );
    expect(
      draftAuthorLabel({ userId: "u", name: "Ana Writer", conversationId: "c", release: false }, t)
    ).toBe("Ana Writer with the agent");
    expect(draftAuthorLabel({ release: true }, t)).toBe("The technical team");
    expect(draftAuthorLabel({ userId: "u", release: false }, t)).toBe("A former member");
  });
});

const refused = (status: number, code: string, reason: string) =>
  new ApiError(status, "refused", { error: { code, message: "refused", details: { reason } } });

describe("Publish and Discard", () => {
  const done: OperationOutcome<unknown> = {
    status: "done",
    output: {},
    operationRunId: "run_1",
    replayed: false
  };

  function decide(call: () => Promise<OperationOutcome<unknown>>) {
    const reloaded = vi.fn(async () => undefined);
    const reread = vi.fn(async () => undefined);
    return {
      answer: decideDraft({
        call,
        done: reloaded,
        reread,
        failedMessage: "Try again.",
        t: createTranslationContext("en").t
      }),
      reloaded,
      reread
    };
  }

  it("reads the agent again once the decision is made", async () => {
    const run = decide(async () => done);
    await expect(run.answer).resolves.toBeUndefined();
    expect(run.reloaded).toHaveBeenCalledOnce();
  });

  it("never publishes a draft newer than the one read: it reads the draft again", async () => {
    const run = decide(async () => {
      throw refused(412, "REVISION_CONFLICT", "draft_changed");
    });
    await expect(run.answer).resolves.toEqual({ kind: "changed" });
    expect(run.reloaded).not.toHaveBeenCalled();
    expect(run.reread).toHaveBeenCalledOnce();
  });

  it("tells a stale base apart from other refusals", async () => {
    const run = decide(async () => {
      throw refused(409, "CONFLICT", "stale_base");
    });
    await expect(run.answer).resolves.toEqual({ kind: "stale" });
    expect(readDraftRefusal(refused(409, "CONFLICT", "revision_conflict"))).toBeUndefined();
  });

  it("says a decision that waits for an approval changed nothing yet", async () => {
    const run = decide(async () => ({
      status: "pending_approval",
      run: {},
      location: undefined,
      operationRunId: "run_2",
      replayed: false
    }));
    await expect(run.answer).resolves.toEqual({ kind: "waits" });
    expect(run.reloaded).not.toHaveBeenCalled();
  });

  it("tells any other refusal in the instance's words", async () => {
    const run = decide(async () => {
      throw refused(403, "FORBIDDEN", "missing_right");
    });
    await expect(run.answer).resolves.toEqual({ kind: "failed", message: "refused" });
  });

  it("drops the answer to an earlier revision once a newer one is read", () => {
    const stale = { sent: 2, answer: { kind: "stale" as const } };
    expect(answerOfRevision(stale, 2)).toEqual({ kind: "stale" });
    expect(answerOfRevision(stale, 3)).toBeUndefined();
    const changed = { sent: 2, answer: { kind: "changed" as const } };
    expect(answerOfRevision(changed, 2)).toBeUndefined();
    expect(answerOfRevision(changed, 3)).toEqual({ kind: "changed" });
  });
});

type Status = Parameters<typeof AgentUnavailableNotices>[0]["status"];

function notices(status: Status): string {
  return renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" as const },
      createElement(AgentUnavailableNotices, { status })
    )
  );
}

describe("the top of an agent's page", () => {
  it("stops the chat only for the primary model, and says nothing where every reference runs", () => {
    const status: Status = {
      chatAvailable: true,
      unavailableTools: [{ name: "crm.lookup", reason: "unknown_tool" }],
      unavailableSkills: [{ name: "tax-old", reason: "unknown_skill" }],
      unavailableModels: [
        { name: "retired", field: "userSelectableModelBindingIds", reason: "unknown_model" }
      ]
    };
    const listed = notices(status);
    expect(listed).toContain("crm.lookup");
    expect(listed).toContain("tax-old");
    expect(listed).not.toContain("data-agent-chat-unavailable");
    expect(
      notices({
        chatAvailable: false,
        unavailableModels: [{ name: "removed", field: "modelBindingId", reason: "unknown_model" }]
      })
    ).toContain("data-agent-chat-unavailable");
    expect(
      notices({
        chatAvailable: true,
        unavailableTools: [],
        unavailableSkills: [],
        unavailableModels: []
      })
    ).toBe("");
    expect(notices(undefined)).toBe("");
  });
});

describe("what stays unavailable after a save", () => {
  const status: Status = {
    chatAvailable: false,
    unavailableTools: [{ name: "crm.lookup", reason: "unknown_tool" }],
    unavailableSkills: [{ name: "tax-old", reason: "unknown_skill" }],
    unavailableModels: [
      { name: "removed", field: "modelBindingId", reason: "unknown_model" },
      { name: "retired", field: "userSelectableModelBindingIds", reason: "unknown_model" }
    ]
  };
  const asRead = {
    toolNames: ["crm.lookup", "web.search"],
    skillNames: ["tax-old"],
    modelProviderId: "",
    modelBindingId: "removed",
    userSelectableModelBindingIds: ["retired"]
  };

  it("keeps the report while the saved agent still names what it reports", () => {
    expect(savedAgentUnavailable(status, asRead)).toEqual(status);
  });

  it("drops what a repair save replaced or removed, and lets the agent chat again", () => {
    const repaired = savedAgentUnavailable(status, {
      ...asRead,
      toolNames: ["web.search"],
      skillNames: [],
      modelBindingId: "fast"
    });
    expect(repaired).toEqual({
      chatAvailable: true,
      unavailableTools: [],
      unavailableSkills: [],
      unavailableModels: [
        { name: "retired", field: "userSelectableModelBindingIds", reason: "unknown_model" }
      ]
    });
    const markup = notices(repaired);
    expect(markup).not.toContain("data-agent-chat-unavailable");
    expect(markup).not.toContain("crm.lookup");
    expect(markup).toContain("retired");
  });
});

// The Connections in an agent's Tools section, a row each as the packages are (TOOLS-1), on
// answers of `connections.list_tools` handed to the page. That the instance answers a reader only the
// Connections the reader may read, and only operations agents may call, is held in
// tests/connection-operation-answers.test.ts. Every test here fails without them: the section
// then offered the release's tools alone.

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
}

/** The Tools section of the agent's page. */
function tools(input: AgentInput): string {
  const config = { ...agentBase, ...input.config };
  const markup = renderToStaticMarkup(
    createElement(
      TranslationProvider,
      { children: null, locale: "en" as const },
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
          actions: {},
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
  return /<section[^>]*id="tools">[\s\S]*?<\/section>/u.exec(markup)?.[0] ?? "";
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
  const row = (markup: string, key: string) =>
    new RegExp(`data-tool-package="${key}"[\\s\\S]*?</li>`, "u").exec(markup)?.[0] ?? "";

  it("shows each Connection the instance answered as a row with its count and switch", () => {
    const markup = tools({
      config: { toolNames: ["read_skill", "connection.crm.find_customer"] },
      enabledToolNames: ["read_skill"],
      connectionTools: answered
    });

    // The Connection is a row like a package; one of its two operations is on.
    expect(row(markup, "connection:crm")).toContain("Customer records");
    expect(row(markup, "connection:crm")).toContain(">1/2<");
    // A Connection the agent uses none of stands too, switched off.
    expect(row(markup, "connection:ledger")).toContain('aria-checked="false"');
    expect(markup).not.toContain("data-unavailable-option");
  });

  it("turns on every tool of a Connection the agent does not use with its switch", () => {
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
    for (const toolName of held) {
      expect(group).toContain(`data-unavailable-option="${toolName}"`);
    }
    expect(group).toContain('aria-label="Remove"');
    // The reader learns nothing of a Connection the instance did not answer.
    expect(markup).not.toContain('data-tool-package="connection:payroll"');

    // Saving sends every name the reader did not remove, also the ones no row offers.
    const config = { ...agentBase, toolNames: held };
    const ticked = toggleToolName(held, "connection.crm.add_note", true);
    expect(
      editedAgentConfig({ ...agentConfigToForm(config), toolNames: ticked }, config, []).toolNames
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
    expect(row(readOnly, "connection:crm")).toContain("Customer records");
    expect(row(readOnly, "connection:crm")).toMatch(/role="checkbox"[^>]*disabled=""/u);
    expect(readOnly).not.toContain('aria-label="Remove"');
  });

  it("judges nothing while the instance did not answer", () => {
    const unknown = tools({
      config: { toolNames: ["connection.crm.find_customer"] },
      connectionTools: { status: "unknown" }
    });
    expect(unknown).toContain('data-held-option="connection.crm.find_customer"');
    expect(unknown).not.toContain("data-unavailable-option");
    expect(unknown).not.toContain('data-tool-package="connection:');
  });
});
