// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  StepSettings,
  StepSettingsBar,
  toWorkflow,
  useWorkflow,
  useWorkflowEditing,
  WorkflowsHostProvider,
  WorkflowsSourceProvider,
  type CallableOperationOption,
  type ChildWorkflowOption,
  type WorkflowsHost,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// The Settings of an operation step and of a step that starts another Workflow (WF-EDIT-3,
// Events check 126): picking "Load the bookings" writes the step's operation and shows one row
// per field of its input schema, a required one holding the save back; an operation that cannot
// be reached now cannot be picked, and one that starts a Workflow is named by it; the child
// picker offers the Workflows the person may start, shows one they may only read as disabled,
// and never the Workflow itself; the tools picker writes the Workflow's `tools`. Fails without WF-EDIT-3: these steps were left to the agent.

const { t } = createTranslationContext("en");
const WORKFLOW = "bookings";

type Config = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stepOf = (config: Config | undefined, id: string): Record<string, unknown> | undefined => {
  const manifest = isRecord(config?.manifest) ? config.manifest : {};
  const steps = Array.isArray(manifest.steps) ? manifest.steps.filter(isRecord) : [];
  return steps.find((step) => step.id === id);
};

const manifest = {
  id: WORKFLOW,
  name: "Bookings",
  inputs: { type: "object", properties: { month: { type: "string", title: "Month" } } },
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    {
      id: "load",
      name: "Load",
      type: "operation",
      operation: "connection.crm.echo",
      input: { text: { value: "all" } }
    },
    {
      id: "report",
      name: "Send the report",
      type: "workflow",
      workflow: "report-ok",
      input: {}
    },
    {
      id: "summary",
      name: "Write the summary",
      type: "agent",
      instructions: "Summarise.",
      input: {},
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: { note: { type: "string" } } }
    },
    { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
  ]
};
const initial: Config = { name: WORKFLOW, manifest };

const BOOKINGS: CallableOperationOption = {
  name: "connection.bookings.load",
  title: "Load the bookings",
  effect: "reading",
  source: { kind: "connection", title: "Exampledata" },
  available: true,
  inputSchema: {
    type: "object",
    properties: { from: { type: "string", title: "From" }, limit: { type: "integer" } },
    required: ["from"]
  }
};
const OPERATIONS: CallableOperationOption[] = [
  BOOKINGS,
  {
    name: "connection.crm.write",
    title: "Write the note",
    effect: "changing",
    source: { kind: "connection" },
    available: false
  },
  // Starting a Workflow has no title of its own: it is named by the Workflow it starts.
  {
    name: "workflow.report-ok.start",
    title: "start",
    effect: "changing",
    source: { kind: "workflow", title: "Send the report" },
    available: true
  }
];
const CHILDREN: ChildWorkflowOption[] = [
  {
    id: "report-ok",
    name: "Send the report",
    mayStart: true,
    inputs: { type: "object", properties: { to: { type: "string", title: "To" } } }
  },
  { id: "report-read", name: "Read the report", mayStart: false },
  { id: "archive", name: "Archive", mayStart: true, inputs: { type: "object" } },
  // The Workflow being edited does not start itself.
  { id: WORKFLOW, name: "Bookings", mayStart: true }
];

function sourceOf(saves: { config: Config; expected: number }[]): WorkflowsSource {
  let draft = { config: initial, revision: 2 };
  const view = () => {
    const current = isRecord(draft.config.manifest) ? draft.config.manifest : {};
    return {
      ...toWorkflow(
        { name: WORKFLOW, config: current, publishedRevision: 2 },
        {},
        { draftRevision: draft.revision, publishedRevision: 2 }
      ),
      definition: { config: draft.config, manifest: current, revision: draft.revision }
    };
  };
  const unused = () => Promise.reject(new Error("Not read by Settings."));
  return {
    key: "step-settings-operation",
    listWorkflows: unused,
    getWorkflow: () => Promise.resolve(view()),
    runs: undefined,
    stepChoices: {
      listOperations: () => Promise.resolve({ items: OPERATIONS, nextCursor: undefined }),
      listChildWorkflows: () => Promise.resolve({ items: CHILDREN, nextCursor: undefined })
    },
    drafts: {
      publish: unused,
      discard: unused,
      test: unused,
      runLiveOnce: unused,
      listLiveOnce: unused,
      readRevision: () => Promise.resolve(required(view().definition)),
      validate: () => Promise.resolve([]),
      save: (_workflow, config, expected) => {
        saves.push({ config, expected });
        draft = { config, revision: expected + 1 };
        return Promise.resolve({ revision: expected + 1 });
      }
    }
  };
}

function Harness({ step }: { step: string }) {
  const read = useWorkflow("cw_1", WORKFLOW);
  const editing = useWorkflowEditing({
    workspaceId: "cw_1",
    workflowId: WORKFLOW,
    workflow: read.workflow,
    mayWrite: true
  });
  if (editing === undefined) return null;
  return createElement(
    "div",
    null,
    createElement(StepSettings, { stepId: step, editing, edit: undefined }),
    createElement(StepSettingsBar, { stepId: step, editing })
  );
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

async function mount(source: WorkflowsSource, step: string): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const host: WorkflowsHost = {
    rights: { instance: { read: true, write: true, publish: false, delete: false } },
    viewerId: "user_1",
    workspace: { id: "cw_1", name: "Office" },
    showRoute: () => undefined
  };
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          WorkspaceApiClientProvider,
          { apiBaseUrl: "https://chat.example.com", children: null },
          createElement(
            WorkflowsSourceProvider,
            { source, children: null },
            createElement(
              WorkflowsHostProvider,
              { value: host, children: null },
              createElement(
                TranslationProvider,
                { locale: "en", children: null },
                createElement(
                  UiRoot,
                  { mode: "light", labels: uiLabelsEn },
                  createElement(Harness, { step })
                )
              )
            )
          )
        )
      )
    );
  });
  unmounts.push(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });
  return container;
}

async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(scope: Element, label: string): HTMLButtonElement {
  return required(
    [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label
    )
  );
}

async function settled(check: () => void) {
  await vi.waitFor(async () => act(async () => check()), { timeout: CONDITION_WAIT_MS });
}

/** The rows of the open picker, by their text. */
const rows = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
const rowOf = (text: string) =>
  required(rows().find((row) => row.textContent?.startsWith(text) === true));

/** Opens the picker whose button's name starts with `label`. */
async function openPicker(scope: Element, label: string) {
  const opener = () => scope.querySelector<HTMLElement>(`button[aria-label^="${label}"]`);
  await settled(() => expect(opener()).not.toBeNull());
  await act(async () => opener()?.click());
  await settled(() => expect(rows().length).toBeGreaterThan(0));
}

const fields = (container: Element) =>
  [...container.querySelectorAll("[data-input-field]")].map((row) =>
    row.getAttribute("data-input-field")
  );

describe("the Settings of an operation step and of a child Workflow step (WF-EDIT-3)", () => {
  it("writes the picked operation and one row per field of its input, a required one holding the save", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const container = await mount(sourceOf(saves), "load");
    const operation = t("workflows.settings.operation");
    await openPicker(container, operation);
    // One that cannot be reached now is shown and cannot be picked.
    expect(rowOf("Write the note").getAttribute("aria-disabled")).toBe("true");
    expect(rowOf("Write the note").textContent).toContain(
      t("workflows.settings.operationUnavailable")
    );
    expect(
      rowOf(t("workflows.settings.startWorkflow", { name: "Send the report" })).textContent
    ).toBe(
      `${t("workflows.settings.startWorkflow", { name: "Send the report" })}${t("workflows.step.changing")}`
    );
    await act(async () => rowOf("Load the bookings").click());
    await settled(() => expect(fields(container)).toEqual(["from", "limit"]));
    // "From" is required and has no value yet.
    expect(button(container, t("workflows.settings.save")).disabled).toBe(true);
    const from = required(
      container.querySelector<HTMLInputElement>('[data-input-field="from"] input[type="text"]')
    );
    await type(from, "2026-01");
    await settled(() =>
      expect(button(container, t("workflows.settings.save")).disabled).toBe(false)
    );
    await act(async () => button(container, t("workflows.settings.save")).click());
    await settled(() => expect(saves).toHaveLength(1));
    expect(stepOf(saves[0]?.config, "load")).toEqual({
      id: "load",
      name: "Load",
      type: "operation",
      operation: "connection.bookings.load",
      input: { from: { value: "2026-01" } }
    });
  });

  it("offers the Workflows the person may start, one they may only read disabled, never itself", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const container = await mount(sourceOf(saves), "report");
    await settled(() => expect(fields(container)).toEqual(["to"]));
    await openPicker(container, t("workflows.settings.child"));
    expect(
      rows().map((row) => row.textContent?.split(t("workflows.settings.childMayNotStart"))[0])
    ).toEqual(["Send the report", "Read the report", "Archive"]);
    expect(rowOf("Read the report").getAttribute("aria-disabled")).toBe("true");
    await act(async () => rowOf("Archive").click());
    await settled(() => expect(fields(container)).toEqual([]));
    expect(container.textContent).toContain(t("workflows.settings.getsNothing"));
    await act(async () => button(container, t("workflows.settings.save")).click());
    await settled(() => expect(saves).toHaveLength(1));
    expect(stepOf(saves[0]?.config, "report")).toMatchObject({ workflow: "archive", input: {} });
  });

  it("writes the Workflow's tools from an AI step's Settings", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const container = await mount(sourceOf(saves), "summary");
    await openPicker(container, t("workflows.settings.tools"));
    await act(async () => rowOf("Load the bookings").click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settled(() =>
      expect(button(container, t("workflows.settings.save")).disabled).toBe(false)
    );
    await act(async () => button(container, t("workflows.settings.save")).click());
    await settled(() => expect(saves).toHaveLength(1));
    const saved = saves[0]?.config.manifest;
    expect(isRecord(saved) ? saved.tools : undefined).toEqual(["connection.bookings.load"]);
  });
});
