import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createApiClient } from "@work-shape/catalyst-api-client";
import { describe, expect, it } from "vitest";
import { createTranslationContext } from "@work-shape/catalyst-chat-ui";
import {
  StepPanel,
  WorkflowsHostProvider,
  resolveWorkflowRights,
  toWorkflow,
  workflowGraph,
  type WorkflowsHost
} from "@work-shape/catalyst-chat-ui/workflows";
import { renderToStaticMarkup, TranslationProvider } from "./chat-ui-render-harness";
import { readsRecipientPeople, workspaceQueryKeys, WorkflowsHostWithRecipients } from "./support/chat-ui";

// ACCEPT-1c C9 (workflow-canvas.md, Notify: "Who receives it"): a Notify step names who it
// reaches, on its node and in its panel, by the names the reader may read. It used to say
// "Inbox" and nothing about the recipients. Whoever the reader cannot name is counted, and no
// id of a person or a workspace reaches the screen.

const en = createTranslationContext("en");
const de = createTranslationContext("de");
const noop = () => undefined;

const OBJECT = { type: "object" };
const workflow = toWorkflow({
  name: "weekly-reminder",
  config: {
    id: "weekly-reminder",
    name: "Weekly reminder",
    runAs: "runner",
    inputs: OBJECT,
    outputs: OBJECT,
    steps: [
      { id: "start", type: "trigger", name: "Start", triggers: [{ kind: "manual" }] },
      {
        id: "tell",
        type: "notify",
        name: "Tell the team",
        to: { users: ["usr_mara", "usr_unknown"], workspaces: ["ws_finance"] },
        channels: ["inbox", "mail"],
        title: "Upload",
        text: "Upload this week's documents"
      },
      {
        id: "tell-hidden",
        type: "notify",
        name: "Tell others",
        to: { users: ["usr_a", "usr_b"], workspaces: ["ws_hidden"] },
        channels: ["inbox"],
        title: "Hi",
        text: "Hi"
      }
    ]
  },
  publishedRevision: 1
});

const names = {
  people: new Map([["usr_mara", "Mara Lindqvist"]]),
  workspaces: new Map([["ws_finance", "Team Finance"]])
};

const host: WorkflowsHost = {
  rights: resolveWorkflowRights(undefined, undefined),
  viewerId: "usr_mara",
  workspace: { id: "ws_finance", name: "Team Finance" },
  showRoute: noop,
  recipients: names
};

function nodeSummary(id: string, locale: "en" | "de" = "en", withNames = true) {
  const graph = workflowGraph(
    workflow.steps,
    locale === "en" ? en : de,
    undefined,
    withNames ? names : undefined
  );
  return graph.nodes.find((node) => node.id === id)?.summary;
}

function panel(id: string, locale: "en" | "de" = "en"): string {
  const graph = workflowGraph(workflow.steps, locale === "en" ? en : de, undefined, names);
  const step = workflow.steps.find((entry) => entry.id === id);
  const part = graph.nodes.find((node) => node.id === id);
  if (step === undefined || part === undefined) throw new Error(`No step ${id}`);
  const node: ReactNode = createElement(WorkflowsHostProvider, {
    value: host,
    children: createElement(StepPanel, {
      step,
      part,
      run: undefined,
      tab: "what",
      onTabChange: noop,
      entries: null,
      onClose: noop
    })
  });
  return renderToStaticMarkup(createElement(TranslationProvider, { locale, children: node }));
}

describe("a Notify step names who receives it", () => {
  it("names the recipients on the node and counts the ones the reader cannot name", () => {
    expect(nodeSummary("tell")).toBe("Mara Lindqvist, Team Finance, and 1 other person");
    expect(nodeSummary("tell", "de")).toBe("Mara Lindqvist, Team Finance und 1 weitere Person");
    expect(nodeSummary("tell-hidden")).toBe("2 people and 1 workspace");
    expect(nodeSummary("tell-hidden", "de")).toBe("2 Personen und 1 Arbeitsbereich");
  });

  it("counts every recipient where the reader may read no names", () => {
    expect(nodeSummary("tell", "en", false)).toBe("2 people and 1 workspace");
  });

  it("lists the recipients in the panel, and the Inbox only as how it is delivered", () => {
    const html = panel("tell");
    expect(html).toContain(">Recipients<");
    expect(html).toContain("Mara Lindqvist, Team Finance, and 1 other person");
    expect(html).toContain(">Delivered<");
    expect(html).toContain("In the Inbox and by email");
    expect(html).not.toMatch(/Goes to/u);
    const german = panel("tell-hidden", "de");
    expect(german).toContain(">Empfänger<");
    expect(german).toContain("2 Personen und 1 Arbeitsbereich");
    expect(german).toContain("Im Eingang");
  });

  it("never shows the id of a person or a workspace", () => {
    for (const html of [panel("tell"), panel("tell-hidden"), panel("tell", "de")]) {
      for (const id of ["usr_mara", "usr_unknown", "ws_finance", "usr_a", "usr_b", "ws_hidden"]) {
        expect(html).not.toContain(id);
      }
    }
  });
});

describe("the instance's people are read for recipient names", () => {
  const ws = { collaborationWorkspaceId: "cw_1" };
  it("only on the page of one Workflow or one run, for a reader who manages people", () => {
    expect(readsRecipientPeople({ kind: "workflow", workflow: "w", ...ws }, true)).toBe(true);
    expect(
      readsRecipientPeople({ kind: "workflow-run", workflow: "w", run: "r", ...ws }, true)
    ).toBe(true);
    expect(readsRecipientPeople({ kind: "workflow", workflow: "w", ...ws }, false)).toBe(false);
  });

  it("never on a chat, an App, the Workflows list or Settings", () => {
    for (const route of [
      { kind: "inbox" as const },
      { kind: "settings" as const, group: "instance", page: "users" },
      { kind: "apps" as const, ...ws },
      { kind: "app-edit" as const, app: "a", ...ws },
      { kind: "workflows" as const, ...ws }
    ]) {
      expect(readsRecipientPeople(route, true), route.kind).toBe(false);
    }
  });
});


describe("recipient names follow current rights even with a warm directory cache", () => {
  it("uses cached directory names only while the reader may read people", () => {
    const queryClient = new QueryClient();
    const api = {
      apiBaseUrl: "https://chat.example.com",
      authScope: "reader",
      client: createApiClient({ baseUrl: "https://chat.example.com" })
    };
    queryClient.setQueryData(workspaceQueryKeys.superadminUsers(api.apiBaseUrl, api.authScope), [
      { id: "usr_unknown", displayLabel: "Previously readable person" }
    ]);
    const step = workflow.steps.find((entry) => entry.id === "tell");
    const part = workflowGraph(workflow.steps, en).nodes.find((entry) => entry.id === "tell");
    if (step === undefined || part === undefined) throw new Error("Missing Notify step");
    const render = (readsPeople: boolean) => renderToStaticMarkup(
      createElement(QueryClientProvider, { client: queryClient, children:
        createElement(TranslationProvider, { locale: "en", children:
          createElement(WorkflowsHostWithRecipients, {
            value: host, api, viewer: { id: "usr_mara", name: "Mara Lindqvist" },
            workspaces: [{ id: "ws_finance", name: "Team Finance" }], readsPeople,
            children: createElement(StepPanel, { step, part, run: undefined, tab: "what", onTabChange: noop, entries: null, onClose: noop })
          })
        })
      })
    );
    expect(render(true)).toContain("Previously readable person");
    const hidden = render(false);
    expect(hidden).not.toContain("Previously readable person");
    expect(hidden).toContain("Mara Lindqvist, Team Finance, and 1 other person");
    queryClient.clear();
  });
});
