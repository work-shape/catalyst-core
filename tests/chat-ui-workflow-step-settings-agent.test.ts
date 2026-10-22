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
  type WorkflowsHost,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// The Settings of an AI step and of a script (WF-EDIT-2, Events check 125): a person changes
// the instructions and adds an answer field, and the saved draft holds the instructions and
// an `outputSchema` with the field required; a changed script is saved as the step's file of
// the draft, which the next test run reads; an answer field with no name holds the save back.
// Fails without WF-EDIT-2: an AI step's and a script's Settings were left to the agent.

const { t } = createTranslationContext("en");
const WORKFLOW = "client-notes";

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
const initial: Config = {
  name: WORKFLOW,
  manifest,
  files: [{ path: "steps/compute.py", content: "print(1)\n" }]
};

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
    key: "step-settings-agent",
    listWorkflows: unused,
    getWorkflow: () => Promise.resolve(view()),
    runs: undefined,
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

describe("the Settings of an AI step and of a script (WF-EDIT-2)", () => {
  it("saves the instructions and an answer field the person added, required", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const container = await mount(sourceOf(saves), "summary");
    await settled(() =>
      expect(control(container, t("workflows.settings.instructions")).value).toBe(
        "Summarise the notes."
      )
    );
    await type(control(container, t("workflows.settings.instructions")), "Write one line.");
    const answers = required(container.querySelector("[data-step-answers]"));
    await act(async () => button(answers, uiLabelsEn.addField).click());
    // A field with no name holds the save back.
    await settled(() =>
      expect(button(container, t("workflows.settings.save")).disabled).toBe(true)
    );
    const added = required(answers.querySelectorAll("[data-field-id]")[1]);
    await type(control(added, uiLabelsEn.fieldName), "summary");
    await act(async () => required(added.querySelector<HTMLElement>('[role="switch"]')).click());
    await settled(() =>
      expect(button(container, t("workflows.settings.save")).disabled).toBe(false)
    );
    await act(async () => button(container, t("workflows.settings.save")).click());

    await settled(() => expect(saves).toHaveLength(1));
    const step = stepOf(saves[0]?.config, "summary");
    expect(step?.instructions).toBe("Write one line.");
    expect(step?.outputSchema).toEqual({
      type: "object",
      properties: { note: { type: "string", title: "Note" }, summary: { type: "string" } },
      required: ["note", "summary"]
    });
    // The files of the draft are saved as they were.
    expect(saves[0]?.config.files).toEqual(initial.files);
  });

  it("refuses to save an AI step without instructions, and says so once the field is left", async () => {
    const container = await mount(sourceOf([]), "summary");
    await settled(() => control(container, t("workflows.settings.instructions")));
    const instructions = control(container, t("workflows.settings.instructions"));
    await type(instructions, "");
    // Not while the field is being written in (WF-EDIT-4: a new step opens without a word).
    expect(container.textContent).not.toContain(t("workflows.settings.instructionsMissing"));
    await act(async () => {
      instructions.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    await settled(() =>
      expect(container.textContent).toContain(t("workflows.settings.instructionsMissing"))
    );
  });

  it("says what an AI step lacks at the first Save, saves nothing and then waits", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const container = await mount(sourceOf(saves), "summary");
    await settled(() => control(container, t("workflows.settings.instructions")));
    await type(control(container, t("workflows.settings.instructions")), "");
    expect(button(container, t("workflows.settings.save")).disabled).toBe(false);
    await act(async () => button(container, t("workflows.settings.save")).click());
    await settled(() =>
      expect(container.textContent).toContain(t("workflows.settings.instructionsMissing"))
    );
    expect(button(container, t("workflows.settings.save")).disabled).toBe(true);
    expect(saves).toHaveLength(0);
  });

  it("saves a changed script as the step's file and nothing else of the step", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const container = await mount(sourceOf(saves), "compute");
    await settled(() =>
      expect(control(container, t("workflows.settings.script")).value).toBe("print(1)\n")
    );
    expect(container.textContent).toContain("Python");
    // The path of the file is the form's, never shown.
    expect(container.textContent).not.toContain("compute.py");
    await type(control(container, t("workflows.settings.script")), "print(2)\n");
    await act(async () => button(container, t("workflows.settings.save")).click());

    await settled(() => expect(saves).toHaveLength(1));
    expect(saves[0]?.config.files).toEqual([{ path: "steps/compute.py", content: "print(2)\n" }]);
    expect(stepOf(saves[0]?.config, "compute")).toEqual(manifest.steps[2]);
    // Saved: the form shows the saved script, and nothing is left to save.
    await settled(() => expect(container.textContent).not.toContain(t("workflows.settings.save")));
    expect(control(container, t("workflows.settings.script")).value).toBe("print(2)\n");
  });
});
