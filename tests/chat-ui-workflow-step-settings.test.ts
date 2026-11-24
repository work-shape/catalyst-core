// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { createTranslationContext, TranslationProvider } from "./support/chat-ui/shared";
import {
  applyStepEdits,
  DeleteStepDialog,
  StepSettings,
  StepSettingsBar,
  toWorkflow,
  toWorkflowListItem,
  toWorkflowRun,
  useWorkflow,
  useWorkflowEditing,
  WorkflowRunsPageView,
  WorkflowsHostProvider,
  WorkflowsPageView,
  WorkflowsSourceProvider,
  type CallableOperationOption,
  type ChildWorkflowOption,
  type WorkflowRunList,
  type WorkflowsHost,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// Editing a Workflow by hand in the browser: a step's Settings (WF-EDIT-1 to WF-EDIT-3, MAIL-3b)
// save one revision of the draft, carry a save over a draft the agent saved meanwhile, keep the
// form on a refusal, and are offered only to a holder of `workflow.write`; a step is deleted or
// moved from its panel (WF-EDIT-4); and the Workflows pages' kind filter and folded empty runs
// (WF-KIND).

const { t } = createTranslationContext("en");
const WORKFLOW = "flow";
const noop = () => undefined;

type Config = Readonly<Record<string, unknown>>;
type Save = NonNullable<WorkflowsSource["drafts"]>["save"];
type StepFacts = NonNullable<Parameters<typeof toWorkflow>[2]>["stepFacts"];
type Editing = NonNullable<ReturnType<typeof useWorkflowEditing>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const stepsOf = (config: Config | undefined): Record<string, unknown>[] => {
  const manifest = isRecord(config?.manifest) ? config.manifest : {};
  return Array.isArray(manifest.steps) ? manifest.steps.filter(isRecord) : [];
};
const stepOf = (config: Config | undefined, id: string) =>
  stepsOf(config).find((step) => step.id === id);
const idsOf = (config: Config | undefined) => stepsOf(config).map((step) => String(step.id));

/** The stored revisions of the draft; revision 2 is published. */
interface Store {
  revisions: Map<number, Config>;
  draft: number;
}
const storeOf = (manifest: Config, files?: readonly unknown[]): Store => ({
  revisions: new Map([[2, { name: WORKFLOW, manifest, ...(files ? { files } : {}) }]]),
  draft: 2
});
const withDraft = (store: Store, manifest: Config) => {
  store.revisions.set(store.draft + 1, { name: WORKFLOW, manifest });
  store.draft += 1;
};

/** Saves into the store as the instance does, refusing a save over a newer draft. */
function storing(store: Store) {
  const saved: { config: Config; expected: number }[] = [];
  const save = vi.fn<Save>((_workflow, config, expected) => {
    if (expected !== store.draft) return Promise.reject(new ApiError(412, "revision_conflict", {}));
    saved.push({ config, expected });
    store.revisions.set(expected + 1, config);
    store.draft = expected + 1;
    return Promise.resolve({ revision: expected + 1 });
  });
  return { save, saved };
}

function sourceOf(
  store: Store,
  save: Save,
  extra: { stepFacts?: StepFacts; stepChoices?: WorkflowsSource["stepChoices"] } = {}
): WorkflowsSource {
  const facts = extra.stepFacts === undefined ? {} : { stepFacts: extra.stepFacts };
  const definitionOf = (revision: number) => {
    const config = required(store.revisions.get(revision));
    const manifest = isRecord(config.manifest) ? config.manifest : {};
    return { config, manifest, revision, ...facts };
  };
  const unused = () => Promise.reject(new Error("Not read by Settings."));
  return {
    key: "step-settings",
    listWorkflows: unused,
    getWorkflow: () => {
      const definition = definitionOf(store.draft);
      return Promise.resolve({
        ...toWorkflow(
          { name: WORKFLOW, config: definition.manifest, publishedRevision: 2 },
          {},
          { draftRevision: definition.revision, publishedRevision: 2, ...facts }
        ),
        definition
      });
    },
    runs: undefined,
    ...(extra.stepChoices === undefined ? {} : { stepChoices: extra.stepChoices }),
    drafts: {
      publish: unused,
      discard: unused,
      test: unused,
      runLiveOnce: unused,
      listLiveOnce: unused,
      readRevision: (_workflow, revision) => Promise.resolve(definitionOf(revision)),
      validate: () => Promise.resolve([]),
      save
    }
  };
}

let editingNow: Editing | undefined;

function Harness(props: { step?: string; mayWrite?: boolean; deleting?: string }) {
  const read = useWorkflow("cw_1", WORKFLOW);
  const editing = useWorkflowEditing({
    workspaceId: "cw_1",
    workflowId: WORKFLOW,
    workflow: read.workflow,
    mayWrite: props.mayWrite ?? true
  });
  editingNow = editing;
  if (editing === undefined) {
    return createElement("p", { "data-no-settings": "" }, read.workflow?.name ?? "");
  }
  if (props.deleting !== undefined) {
    const deleting = props.deleting;
    return createElement(DeleteStepDialog, {
      editing,
      stepId: deleting,
      onClose: noop,
      onDeleted: () => document.body.setAttribute("data-deleted", deleting),
      onOpenStep: (id: string) => document.body.setAttribute("data-opened", id)
    });
  }
  if (props.step === undefined) return null;
  return createElement(
    "div",
    null,
    createElement(StepSettings, { stepId: props.step, editing, edit: undefined }),
    createElement(StepSettingsBar, { stepId: props.step, editing })
  );
}

const writer: WorkflowsHost = {
  rights: { instance: { read: true, write: true, publish: false, delete: false } },
  viewerId: "user_1",
  workspace: { id: "cw_1", name: "Office" },
  showRoute: noop
};

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  editingNow = undefined;
  document.body.removeAttribute("data-deleted");
  document.body.removeAttribute("data-opened");
});

async function mount(
  node: ReactNode,
  options: { source?: WorkflowsSource; host?: WorkflowsHost } = {}
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const wrapped = (child: ReactNode) => {
    const hosted = createElement(
      WorkflowsHostProvider,
      { value: options.host ?? writer, children: null },
      createElement(
        TranslationProvider,
        { locale: "en", children: null },
        createElement(UiRoot, { mode: "light", labels: uiLabelsEn }, child)
      )
    );
    return createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        WorkspaceApiClientProvider,
        { apiBaseUrl: "https://chat.example.com", children: null },
        options.source === undefined
          ? hosted
          : createElement(
              WorkflowsSourceProvider,
              { source: options.source, children: null },
              hosted
            )
      )
    );
  };
  const render = (child: ReactNode) => act(async () => root.render(wrapped(child)));
  await render(node);
  unmounts.push(async () => {
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
  });
  return { container, render };
}

const settings = async (source: WorkflowsSource, step: string, mayWrite = true) =>
  (
    await mount(createElement(Harness, { step, mayWrite }), {
      source,
      host: mayWrite
        ? writer
        : {
            ...writer,
            rights: { instance: { read: true, write: false, publish: false, delete: false } }
          }
    })
  ).container;

/** The control a field's label names, inside `scope`. */
function control(scope: Element, label: string): HTMLInputElement | HTMLTextAreaElement {
  const found = [...scope.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.startsWith(label) === true
  );
  const element = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement)) {
    throw new Error(`No field labelled ${label}`);
  }
  return element;
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

const save = (scope: Element) => button(scope, t("workflows.settings.save"));

describe("a notice's Settings (WF-EDIT-1)", () => {
  const published = {
    id: WORKFLOW,
    name: "Client notes",
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "clients", name: "Load the clients", type: "operation", operation: "crm.list" },
      {
        id: "notice",
        name: "Tell the office",
        type: "notify",
        to: { users: ["user_1"] },
        channels: ["inbox"],
        title: { value: "Notes are ready" },
        text: { value: "The client notes are written." }
      },
      { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
    ]
  };
  const setStep = (step: string, fields: Record<string, unknown>) =>
    applyStepEdits(published, [{ kind: "set", step, fields }]);
  const title = (scope: Element) => control(scope, t("workflows.settings.noticeTitle"));

  /** Settings of the notice, its title typed as `mine`, and nothing saved yet. */
  async function typed(store: Store, saving: Save, mine: string) {
    const container = await settings(sourceOf(store, saving), "notice");
    await settled(() => expect(title(container).value).toBe("Notes are ready"));
    await type(title(container), mine);
    return container;
  }

  it("saves a changed title as one revision of the draft and shows the published one under it", async () => {
    const store = storeOf(published);
    const { save: saving, saved } = storing(store);
    const container = await typed(store, saving, "The notes are ready");
    expect(container.querySelector("[data-published]")).toBeNull();
    await act(async () => save(container).click());

    await settled(() => expect(container.querySelector('[data-published="title"]')).not.toBeNull());
    expect(saved).toHaveLength(1);
    expect(saved[0]?.expected).toBe(2);
    expect(stepOf(saved[0]?.config, "notice")?.title).toEqual({ value: "The notes are ready" });
    expect(container.querySelector('[data-published="title"]')?.textContent).toContain(
      "Notes are ready"
    );
    // Saved: the bar is gone until the next change.
    expect(container.textContent).not.toContain(t("workflows.settings.save"));
  });

  it("keeps the form and names the field when the instance refuses the save", async () => {
    const store = storeOf(published);
    const refuse = vi.fn<Save>(() =>
      Promise.reject(
        new ApiError(422, "refused", {
          error: {
            code: "VALIDATION_FAILED",
            message: "refused",
            details: {
              issues: [{ path: "steps.notice.title", message: "The title reads a later step" }]
            }
          }
        })
      )
    );
    const container = await typed(store, refuse, "Broken");
    await act(async () => save(container).click());

    await settled(() => expect(container.textContent).toContain("The title reads a later step"));
    expect(refuse).toHaveBeenCalledOnce();
    expect(title(container).value).toBe("Broken");
    expect(store.draft).toBe(2);
  });

  it("saves again without a question where the agent changed another step meanwhile", async () => {
    const store = storeOf(published);
    const { save: saving, saved } = storing(store);
    const container = await typed(store, saving, "The notes are ready");
    withDraft(store, setStep("clients", { name: "Load every client" }));
    await act(async () => save(container).click());

    await settled(() => expect(saved).toHaveLength(1));
    expect(saving).toHaveBeenCalledTimes(2);
    expect(saved[0]?.expected).toBe(3);
    const written = JSON.stringify(saved[0]?.config);
    expect(written).toContain("Load every client");
    expect(written).toContain("The notes are ready");
    expect(container.querySelector("[data-conflict]")).toBeNull();
  });

  it("keeps the person's value with the agent's under it where both changed the same field", async () => {
    const store = storeOf(published);
    const { save: saving, saved } = storing(store);
    const container = await typed(store, saving, "Mine");
    withDraft(store, setStep("notice", { title: { value: "The agent's" } }));
    await act(async () => save(container).click());

    await settled(() => expect(container.querySelector('[data-conflict="title"]')).not.toBeNull());
    expect(container.querySelector('[data-conflict="title"]')?.textContent).toContain(
      "The agent's"
    );
    expect(title(container).value).toBe("Mine");
    expect(saved).toHaveLength(0);

    // The next Save writes the person's value over the agent's draft.
    await act(async () => save(container).click());
    await settled(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.expected).toBe(3);
    expect(stepOf(saved[0]?.config, "notice")?.title).toEqual({ value: "Mine" });
  });

  it("takes the agent's value with Take it", async () => {
    const store = storeOf(published);
    const refuse = vi.fn<Save>(() => Promise.reject(new ApiError(412, "revision_conflict", {})));
    const container = await typed(store, refuse, "Mine");
    withDraft(store, setStep("notice", { title: { value: "The agent's" } }));
    await act(async () => save(container).click());
    await settled(() => expect(container.querySelector('[data-conflict="title"]')).not.toBeNull());

    await act(async () => button(container, t("workflows.settings.takeIt")).click());
    expect(title(container).value).toBe("The agent's");
    expect(container.querySelector("[data-conflict]")).toBeNull();
  });

  it("drops the change where the agent deleted the step meanwhile", async () => {
    const store = storeOf(published);
    const refuse = vi.fn<Save>(() => Promise.reject(new ApiError(412, "revision_conflict", {})));
    const container = await typed(store, refuse, "Mine");
    withDraft(store, { ...published, steps: published.steps.filter((s) => s.id !== "notice") });
    await act(async () => save(container).click());

    await settled(() => expect(container.querySelector("[data-edit-dropped]")).not.toBeNull());
    expect(refuse).toHaveBeenCalledOnce();
  });

  it("offers no Settings to a reader who may not write the Workflow", async () => {
    const store = storeOf(published);
    const container = await settings(sourceOf(store, storing(store).save), "notice", false);
    await settled(() =>
      expect(container.querySelector("[data-no-settings]")?.textContent).toBe("Client notes")
    );
    expect(container.querySelector("[data-step-settings]")).toBeNull();
  });
});

describe("the Settings of an AI step and of a script (WF-EDIT-2)", () => {
  const manifest = {
    id: WORKFLOW,
    name: "Client notes",
    inputs: { type: "object", properties: { region: { type: "string", title: "Region" } } },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      {
        id: "summary",
        name: "Write the summary",
        type: "agent",
        instructions: "Summarise the notes.",
        input: { region: { ref: { step: "start", path: "input.region" } } },
        inputSchema: { type: "object", properties: { region: { type: "string" } } },
        outputSchema: {
          type: "object",
          properties: { note: { type: "string", title: "Note" } },
          required: ["note"]
        }
      },
      {
        id: "compute",
        name: "Count the notes",
        type: "code",
        file: "compute.py",
        input: {},
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object", properties: { count: { type: "integer" } } }
      },
      { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
    ]
  };
  const files = [{ path: "steps/compute.py", content: "print(1)\n" }];
  const instructions = (scope: Element) => control(scope, t("workflows.settings.instructions"));

  it("saves the instructions and a required answer field, the first Save holding back a field without a title", async () => {
    const store = storeOf(manifest, files);
    const { save: saving, saved } = storing(store);
    const container = await settings(sourceOf(store, saving), "summary");
    await settled(() => expect(instructions(container).value).toBe("Summarise the notes."));
    await type(instructions(container), "Write one line.");
    const answers = required(container.querySelector("[data-step-answers]"));
    await act(async () => button(answers, uiLabelsEn.addField).click());
    const added = required(answers.querySelectorAll("[data-field-id]")[1]);
    // A new field opens without a word against its missing title: the first Save says it and
    // saves nothing; after that Save waits for the title.
    expect(added.textContent).not.toContain(t("workflows.settings.answerTitleMissing"));
    await act(async () => save(container).click());
    await settled(() =>
      expect(added.textContent).toContain(t("workflows.settings.answerTitleMissing"))
    );
    expect(save(container).disabled).toBe(true);
    expect(saved).toHaveLength(0);
    await type(control(added, uiLabelsEn.fieldTitle), "Short summary");
    await act(async () => required(added.querySelector<HTMLElement>('[role="switch"]')).click());
    await settled(() => expect(save(container).disabled).toBe(false));
    await act(async () => save(container).click());

    await settled(() => expect(saved).toHaveLength(1));
    const step = stepOf(saved[0]?.config, "summary");
    expect(step?.instructions).toBe("Write one line.");
    expect(step?.outputSchema).toEqual({
      type: "object",
      properties: {
        note: { type: "string", title: "Note" },
        short_summary: { type: "string", title: "Short summary" }
      },
      required: ["note", "short_summary"]
    });
    // The files of the draft are saved as they were.
    expect(saved[0]?.config.files).toEqual(files);
  });

  it("saves no AI step without instructions: the first Save says so, then waits", async () => {
    const store = storeOf(manifest, files);
    const { save: saving, saved } = storing(store);
    const container = await settings(sourceOf(store, saving), "summary");
    await settled(() => instructions(container));
    await type(instructions(container), "");
    expect(container.textContent).not.toContain(t("workflows.settings.instructionsMissing"));
    await act(async () => save(container).click());
    await settled(() =>
      expect(container.textContent).toContain(t("workflows.settings.instructionsMissing"))
    );
    expect(save(container).disabled).toBe(true);
    expect(saved).toHaveLength(0);
  });

  it("saves a changed script as the step's file and nothing else of the step", async () => {
    const store = storeOf(manifest, files);
    const { save: saving, saved } = storing(store);
    const container = await settings(sourceOf(store, saving), "compute");
    const script = () => control(container, t("workflows.settings.script"));
    await settled(() => expect(script().value).toBe("print(1)\n"));
    // The path of the file is the form's, never shown.
    expect(container.textContent).not.toContain("compute.py");
    await type(script(), "print(2)\n");
    await act(async () => save(container).click());

    await settled(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.config.files).toEqual([{ path: "steps/compute.py", content: "print(2)\n" }]);
    expect(stepOf(saved[0]?.config, "compute")).toEqual(manifest.steps[2]);
    await settled(() => expect(container.textContent).not.toContain(t("workflows.settings.save")));
    expect(script().value).toBe("print(2)\n");
  });
});

// WF-EDIT-3: an operation that cannot be reached now cannot be picked; the child picker offers
// the Workflows the person may start, one they may only read disabled, never the Workflow
// itself; the tools picker writes the Workflow's `tools`.
describe("the Settings of an operation step and of a child Workflow step (WF-EDIT-3)", () => {
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
      { id: "report", name: "Send the report", type: "workflow", workflow: "report-ok", input: {} },
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
  const operations: CallableOperationOption[] = [
    {
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
    },
    {
      name: "connection.crm.write",
      title: "Write the note",
      effect: "changing",
      source: { kind: "connection" },
      available: false
    }
  ];
  const children: ChildWorkflowOption[] = [
    {
      id: "report-ok",
      name: "Send the report",
      mayStart: true,
      inputs: { type: "object", properties: { to: { type: "string", title: "To" } } }
    },
    { id: "report-read", name: "Read the report", mayStart: false },
    { id: "archive", name: "Archive", mayStart: true, inputs: { type: "object" } },
    { id: WORKFLOW, name: "Bookings", mayStart: true }
  ];

  async function open(step: string) {
    const store = storeOf(manifest);
    const { save: saving, saved } = storing(store);
    const container = await settings(
      sourceOf(store, saving, {
        stepChoices: {
          listOperations: () => Promise.resolve({ items: operations, nextCursor: undefined }),
          listChildWorkflows: () => Promise.resolve({ items: children, nextCursor: undefined })
        }
      }),
      step
    );
    return { container, saved };
  }

  /** The rows of the open picker, by their text. */
  const rows = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")];
  const rowOf = (text: string) =>
    required(rows().find((row) => row.textContent?.startsWith(text) === true));
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

  it("writes the picked operation and one row per field of its input, a required one holding the save", async () => {
    const { container, saved } = await open("load");
    await openPicker(container, t("workflows.settings.operation"));
    expect(rowOf("Write the note").getAttribute("aria-disabled")).toBe("true");
    await act(async () => rowOf("Load the bookings").click());
    await settled(() => expect(fields(container)).toEqual(["from", "limit"]));
    await act(async () => save(container).click());
    await settled(() => expect(save(container).disabled).toBe(true));
    expect(saved).toHaveLength(0);
    await type(
      required(
        container.querySelector<HTMLInputElement>('[data-input-field="from"] input[type="text"]')
      ),
      "2026-01"
    );
    await settled(() => expect(save(container).disabled).toBe(false));
    await act(async () => save(container).click());
    await settled(() => expect(saved).toHaveLength(1));
    expect(stepOf(saved[0]?.config, "load")).toEqual({
      id: "load",
      name: "Load",
      type: "operation",
      operation: "connection.bookings.load",
      input: { from: { value: "2026-01" } }
    });
  });

  it("offers the Workflows the person may start, one they may only read disabled, never itself", async () => {
    const { container, saved } = await open("report");
    await settled(() => expect(fields(container)).toEqual(["to"]));
    await openPicker(container, t("workflows.settings.child"));
    expect(
      rows().map((row) => row.textContent?.split(t("workflows.settings.childMayNotStart"))[0])
    ).toEqual(["Send the report", "Read the report", "Archive"]);
    expect(rowOf("Read the report").getAttribute("aria-disabled")).toBe("true");
    await act(async () => rowOf("Archive").click());
    await settled(() => expect(fields(container)).toEqual([]));
    await act(async () => save(container).click());
    await settled(() => expect(saved).toHaveLength(1));
    expect(stepOf(saved[0]?.config, "report")).toMatchObject({ workflow: "archive", input: {} });
  });

  it("writes the Workflow's tools from an AI step's Settings", async () => {
    const { container, saved } = await open("summary");
    await openPicker(container, t("workflows.settings.tools"));
    await act(async () => rowOf("Load the bookings").click());
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await settled(() => expect(save(container).disabled).toBe(false));
    await act(async () => save(container).click());
    await settled(() => expect(saved).toHaveLength(1));
    const manifestSaved = saved[0]?.config.manifest;
    expect(isRecord(manifestSaved) ? manifestSaved.tools : undefined).toEqual([
      "connection.bookings.load"
    ]);
  });
});

// WF-EDIT-4: a delete asks once and saves one revision without the step; a step whose result a
// later step reads is not deleted; a move the instance refuses saves nothing and says why.
describe("deleting and moving a step (WF-EDIT-4)", () => {
  const published = {
    id: WORKFLOW,
    name: "Client notes",
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "clients", name: "Load the clients", type: "operation", operation: "crm.list" },
      { id: "audit", name: "Note the run", type: "operation", operation: "audit.note" },
      {
        id: "notice",
        name: "Tell the office",
        type: "notify",
        to: { users: ["user_1"] },
        channels: ["inbox"],
        title: { value: "Notes are ready" },
        text: { value: "The client notes are written." }
      },
      {
        id: "result",
        name: "Result",
        type: "output",
        input: { clients: { ref: { step: "clients", path: "rows" } } }
      }
    ]
  };
  const editedIds = () => idsOf({ manifest: editingNow?.manifest });

  async function open(saving: Save, store: Store, deleting?: string) {
    await mount(createElement(Harness, deleting === undefined ? {} : { deleting }), {
      source: sourceOf(store, saving)
    });
    await settled(() => expect(editedIds()).toContain("audit"));
  }

  it("asks once and saves one revision of the draft without the step", async () => {
    const store = storeOf(published);
    const { save: saving, saved } = storing(store);
    await open(saving, store, "audit");
    await settled(() => button(document.body, t("workflows.delete.confirm")));
    await act(async () => button(document.body, t("workflows.delete.confirm")).click());

    await settled(() => expect(document.body.getAttribute("data-deleted")).toBe("audit"));
    expect(saved).toHaveLength(1);
    expect(idsOf(saved[0]?.config)).toEqual(["start", "clients", "notice", "result"]);
  });

  it("deletes no step whose result a later step reads, and opens that step instead", async () => {
    const store = storeOf(published);
    const { save: saving, saved } = storing(store);
    await open(saving, store, "clients");
    await settled(() =>
      expect(document.body.querySelector("[data-delete-readers]")?.textContent).toContain("Result")
    );
    expect(document.body.textContent).not.toContain(t("workflows.delete.confirm"));
    await act(async () =>
      button(document.body, t("workflows.delete.openReader", { name: "Result" })).click()
    );
    expect(document.body.getAttribute("data-opened")).toBe("result");
    expect(saved).toHaveLength(0);
  });

  it("saves a move as one revision of the draft", async () => {
    const store = storeOf(published);
    const { save: saving, saved } = storing(store);
    await open(saving, store);
    let refused: string | undefined = "not answered";
    await act(async () => {
      refused = await required(editingNow).commit({
        kind: "move",
        step: "audit",
        at: { kind: "after", step: "notice" }
      });
    });
    expect(refused).toBeUndefined();
    expect(idsOf(saved[0]?.config)).toEqual(["start", "clients", "notice", "audit", "result"]);
    await settled(() =>
      expect(editedIds()).toEqual(["start", "clients", "notice", "audit", "result"])
    );
  });

  it("saves nothing where the instance refuses the move, and says which step would not see it", async () => {
    const store = storeOf(published);
    const refuse = vi.fn<Save>(() =>
      Promise.reject(
        new ApiError(422, "refused", {
          error: {
            code: "VALIDATION_FAILED",
            message: "refused",
            details: {
              issues: [
                {
                  path: "steps.result",
                  code: "reference_out_of_scope",
                  message:
                    "Step 'result' references step 'clients', which it does not see from its place (reference_out_of_scope)"
                }
              ]
            }
          }
        })
      )
    );
    await open(refuse, store);
    let refused: string | undefined;
    await act(async () => {
      refused = await required(editingNow).commit({
        kind: "move",
        step: "clients",
        at: { kind: "after", step: "notice" }
      });
    });
    expect(refused).toBe(
      t("workflows.move.outOfScope", { reader: "Result", step: "Load the clients" })
    );
    expect(refuse).toHaveBeenCalledOnce();
    expect(store.draft).toBe(2);
    expect(editedIds()).toEqual(["start", "clients", "audit", "notice", "result"]);
    expect(editingNow?.unsaved.size).toBe(0);
  });
});

// MAIL-3b: the Settings of a Send email step mark an address outside the instance's domains
// before Save, and write the subject in the `text` form with its chip.
describe("the Settings of a Send email step (MAIL-3b)", () => {
  const stepFacts: StepFacts = {
    send: {
      effect: "changing",
      available: true,
      source: { kind: "mail_sender", title: "Example office", service: "system-mail" },
      mailSender: {
        sender: "system",
        title: "Example office",
        icon: "system-mail",
        address: "office@example.test",
        recipientDomains: ["example.test"]
      }
    },
    load: {
      effect: "reading",
      available: true,
      source: { kind: "connection", title: "Bookings" },
      outputSchema: {
        type: "object",
        properties: {
          emails: { type: "array", title: "Client addresses", items: { type: "string" } },
          findings: { type: "array", title: "Findings", items: { type: "object" } }
        }
      }
    }
  };
  const body = { text: ["Good morning,\n\n", { ref: { step: "load", path: "findings" } }] };
  const manifest = {
    id: WORKFLOW,
    name: "Monthly check",
    inputs: { type: "object", properties: { month: { type: "string", title: "Month" } } },
    steps: [
      { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
      { id: "load", name: "Load the bookings", type: "operation", operation: "x.load", input: {} },
      {
        id: "send",
        name: "Send the result",
        type: "operation",
        operation: "mail.send",
        input: {
          sender: { value: "system" },
          to: {
            value: [
              { user: "usr_mara" },
              { workspace: "ws_finance" },
              { address: "anna@example.test" }
            ]
          },
          cc: { ref: { step: "load", path: "emails" } },
          subject: { text: ["Check result ", { ref: { step: "start", path: "input.month" } }] },
          body
        }
      },
      { id: "result", name: "Result", type: "output", input: { done: { value: 1 } } }
    ]
  };

  it("shows the step's mail, marks an address outside the domains, and saves the text form", async () => {
    const store = storeOf(manifest);
    const { save: saving, saved } = storing(store);
    const { container } = await mount(createElement(Harness, { step: "send" }), {
      source: sourceOf(store, saving, {
        stepFacts,
        stepChoices: {
          listOperations: () => Promise.resolve({ items: [], nextCursor: undefined }),
          listChildWorkflows: () => Promise.resolve({ items: [], nextCursor: undefined })
        }
      }),
      host: {
        ...writer,
        viewerId: "usr_mara",
        workspace: { id: "ws_finance", name: "Team Finance" },
        recipients: {
          people: new Map([["usr_mara", "Mara Lindqvist"]]),
          workspaces: new Map([["ws_finance", "Team Finance"]])
        },
        brand: { name: "Example office" }
      }
    });
    const to = () => required(container.querySelector('[data-mail-field="to"]'));
    await settled(() => expect(to().textContent).toContain("Mara Lindqvist"));
    expect(
      container.querySelector('[data-mail-field="cc"] [data-recipient="picked"]')?.textContent
    ).toContain("Client addresses");
    const subject = required(
      container.querySelector<HTMLElement>('[data-mail-field="subject"] [data-template-editor]')
    );

    // A typed address outside example.test is marked before Save.
    const typing = required(to().querySelector<HTMLInputElement>("input"));
    await type(typing, "otto@outside.test");
    await act(async () => {
      typing.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settled(() =>
      expect(to().querySelector("[data-recipient-invalid]")?.textContent).toContain("outside.test")
    );

    // The subject is changed in place and saved in the text form with its chip.
    await act(async () => {
      subject.append(document.createTextNode(" now"));
      subject.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await settled(() => expect(save(container).disabled).toBe(false));
    await act(async () => save(container).click());
    await settled(() => expect(saved).toHaveLength(1));
    expect(stepOf(saved[0]?.config, "send")?.input).toMatchObject({
      to: {
        value: [
          { user: "usr_mara" },
          { workspace: "ws_finance" },
          { address: "anna@example.test" },
          { address: "otto@outside.test" }
        ]
      },
      cc: { ref: { step: "load", path: "emails" } },
      subject: { text: ["Check result ", { ref: { step: "start", path: "input.month" } }, " now"] },
      body
    });
  });
});

// WF-KIND: the choice of a kind on the Workflows page, and a folded stretch of empty runs that
// the reader opens, which stays open while older runs load.
describe("the Workflows pages by kind (WF-KIND)", () => {
  const now = new Date("2026-10-12T09:12:00.000Z");
  const runLinks = (container: Element): string[] =>
    [...container.querySelectorAll("a")]
      .map((link) => link.getAttribute("href") ?? "")
      .filter((href) => href.includes("/runs/"))
      .map((href) => href.slice(href.lastIndexOf("/") + 1));

  it("lists every Workflow at first, one kind once the reader chooses it, and all again after", async () => {
    const { container } = await mount(
      createElement(WorkflowsPageView, {
        workspaceId: "cw_1",
        list: {
          rows: [
            toWorkflowListItem({ id: "notify-clients", name: "Notify clients" }),
            toWorkflowListItem({ id: "invoice-import", name: "Invoice import", kind: "data" })
          ],
          failed: false,
          hasMore: false,
          loadingMore: false,
          loadMore: noop,
          retry: noop
        },
        now,
        runsAvailable: true,
        onOpenRoute: noop,
        onStart: noop
      })
    );
    const listed = () =>
      ["Notify clients", "Invoice import"].filter((name) => container.textContent?.includes(name));
    const choose = (label: string) =>
      act(async () =>
        required(
          [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((radio) =>
            radio.textContent?.startsWith(label)
          )
        ).click()
      );
    expect(listed()).toEqual(["Notify clients", "Invoice import"]);
    await choose("Data flows");
    expect(listed()).toEqual(["Invoice import"]);
    await choose("Processes");
    expect(listed()).toEqual(["Notify clients"]);
    await choose("All");
    expect(listed()).toEqual(["Notify clients", "Invoice import"]);
  });

  it("opens a folded stretch of empty runs, and keeps it open while older runs load into it", async () => {
    const workflow = toWorkflow(
      {
        name: "invoice-import",
        config: {
          id: "invoice-import",
          name: "Invoice import",
          kind: "data",
          runAs: "importer",
          inputs: { type: "object" },
          outputs: { type: "object" },
          steps: [{ id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] }],
          wiring: []
        },
        publishedRevision: 1
      },
      { mayStart: true }
    );
    const run = (id: string, empty: boolean) =>
      toWorkflowRun({
        id,
        workflow: "invoice-import",
        trigger: "schedule",
        status: "done",
        startedBy: { id: "sp_1", label: "Importer" },
        createdAt: `2026-10-12T0${id.slice(-1)}:00:00.000Z`,
        empty
      });
    const page = (rows: WorkflowRunList["rows"]) =>
      createElement(WorkflowRunsPageView, {
        workspaceId: "cw_1",
        workflowId: "invoice-import",
        workflow,
        runs: {
          rows,
          failed: false,
          hasMore: true,
          loadingMore: false,
          loadMore: noop,
          retry: noop
        },
        runsAvailable: true,
        now,
        onStart: noop,
        onOpenRoute: noop
      });
    const first = [run("wr_9", false), run("wr_8", true), run("wr_7", true), run("wr_6", true)];
    const { container, render } = await mount(page(first));
    const toggle = () =>
      required(container.querySelector<HTMLButtonElement>("[data-empty-runs] button"));
    expect(runLinks(container)).toEqual(["wr_9"]);
    await act(async () => toggle().click());
    expect(runLinks(container)).toEqual(["wr_9", "wr_8", "wr_7", "wr_6"]);

    // The next page continues the stretch with two more empty runs and ends it with one that
    // did something: the row counts five and stays open.
    await render(page([...first, run("wr_5", true), run("wr_4", true), run("wr_3", false)]));
    expect(container.querySelector("[data-empty-runs]")?.getAttribute("data-empty-runs")).toBe("5");
    expect(runLinks(container)).toEqual(["wr_9", "wr_8", "wr_7", "wr_6", "wr_5", "wr_4", "wr_3"]);

    await act(async () => toggle().click());
    expect(runLinks(container)).toEqual(["wr_9", "wr_3"]);
  });
});
