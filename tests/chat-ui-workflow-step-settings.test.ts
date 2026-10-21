// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  applyStepEdits,
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

// A step's Settings tab (WF-EDIT-1, Events checks 122 to 124): a holder of `workflow.write`
// changes a notice's text and saves one revision of the draft; the published value stands
// under a changed field; a save over a draft the agent saved meanwhile is applied again, with
// the agent's value under a field both changed; a refused save keeps the form and names the
// field. Fails without WF-EDIT-1: a step had no Settings.

const { t } = createTranslationContext("en");
const WORKFLOW = "client-notes";

type Manifest = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
/** The manifest a save sent, as the store keeps it. */
function manifestOf(value: unknown): Manifest {
  if (!isRecord(value)) throw new Error("No manifest");
  return value;
}
const stepsOf = (manifest: unknown): Record<string, unknown>[] =>
  isRecord(manifest) && Array.isArray(manifest.steps) ? manifest.steps.filter(isRecord) : [];

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

const setStep = (manifest: Manifest, step: string, fields: Record<string, unknown>) =>
  applyStepEdits(manifest, [{ kind: "set", step, fields }]);

/** The stored revisions, the draft last; revision 2 is published. */
interface Store {
  revisions: Map<number, Manifest>;
  draft: number;
}

function sourceOf(
  store: Store,
  save: NonNullable<WorkflowsSource["drafts"]>["save"]
): WorkflowsSource {
  const viewOf = (revision: number) => {
    const manifest = required(store.revisions.get(revision));
    return {
      ...toWorkflow(
        { name: WORKFLOW, config: manifest, publishedRevision: 2 },
        {},
        { draftRevision: revision, publishedRevision: 2 }
      ),
      definition: { config: { name: WORKFLOW, manifest }, manifest, revision }
    };
  };
  const unused = () => Promise.reject(new Error("Not read by Settings."));
  return {
    key: "step-settings",
    listWorkflows: unused,
    getWorkflow: () => Promise.resolve(viewOf(store.draft)),
    runs: undefined,
    drafts: {
      publish: unused,
      discard: unused,
      test: unused,
      runLiveOnce: unused,
      listLiveOnce: unused,
      readRevision: (_workflow, revision) => {
        const manifest = required(store.revisions.get(revision));
        return Promise.resolve({ config: { name: WORKFLOW, manifest }, manifest, revision });
      },
      validate: () => Promise.resolve([]),
      save
    }
  };
}

function Harness({ step, mayWrite }: { step: string; mayWrite: boolean }) {
  const read = useWorkflow("cw_1", WORKFLOW);
  const editing = useWorkflowEditing({
    workspaceId: "cw_1",
    workflowId: WORKFLOW,
    workflow: read.workflow,
    mayWrite
  });
  if (editing === undefined) {
    return createElement("p", { "data-no-settings": "" }, read.workflow?.name ?? "");
  }
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

async function mount(source: WorkflowsSource, mayWrite = true): Promise<HTMLElement> {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const host: WorkflowsHost = {
    rights: { instance: { read: true, write: mayWrite, publish: false, delete: false } },
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
                  createElement(Harness, { step: "notice", mayWrite })
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

/** The control a field's label names. */
function control(container: HTMLElement, label: string): HTMLInputElement {
  const found = [...container.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.startsWith(label) === true
  );
  const element = found?.htmlFor ? document.getElementById(found.htmlFor) : null;
  if (!(element instanceof HTMLInputElement)) {
    throw new Error(`No input labelled ${label}`);
  }
  return element;
}

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  return required(
    [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label
    )
  );
}

async function settled(check: () => void) {
  await vi.waitFor(async () => act(async () => check()), { timeout: CONDITION_WAIT_MS });
}

const titleOf = (manifest: unknown) =>
  stepsOf(manifest).find((step) => step.id === "notice")?.title;

describe("a step's Settings (WF-EDIT-1)", () => {
  it("saves a changed title as one revision of the draft and shows the published one under it", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const saves: { manifest: unknown; expected: number }[] = [];
    const container = await mount(
      sourceOf(store, (_workflow, config, expected) => {
        saves.push({ manifest: config.manifest, expected });
        store.revisions.set(expected + 1, manifestOf(config.manifest));
        store.draft = expected + 1;
        return Promise.resolve({ revision: expected + 1 });
      })
    );
    await settled(() =>
      expect(control(container, t("workflows.settings.noticeTitle")).value).toBe("Notes are ready")
    );
    expect(container.querySelector("[data-published]")).toBeNull();

    await type(control(container, t("workflows.settings.noticeTitle")), "The notes are ready");
    await act(async () => button(container, t("workflows.settings.save")).click());

    await settled(() => expect(container.querySelector('[data-published="title"]')).not.toBeNull());
    expect(saves).toHaveLength(1);
    expect(saves[0]?.expected).toBe(2);
    expect(titleOf(saves[0]?.manifest)).toEqual({ value: "The notes are ready" });
    expect(container.querySelector('[data-published="title"]')?.textContent).toContain(
      "Notes are ready"
    );
    expect(control(container, t("workflows.settings.noticeTitle")).value).toBe(
      "The notes are ready"
    );
    // Saved: the bar is gone until the next change.
    expect(container.textContent).not.toContain(t("workflows.settings.save"));
  });

  it("keeps the form and names the field when the instance refuses the save", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const save = vi.fn(() =>
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
    const container = await mount(sourceOf(store, save));
    await settled(() => control(container, t("workflows.settings.noticeTitle")));
    await type(control(container, t("workflows.settings.noticeTitle")), "Broken");
    await act(async () => button(container, t("workflows.settings.save")).click());

    await settled(() => expect(container.textContent).toContain("The title reads a later step"));
    expect(save).toHaveBeenCalledOnce();
    expect(control(container, t("workflows.settings.noticeTitle")).value).toBe("Broken");
    expect(store.draft).toBe(2);
  });

  it("saves again without a question after a revision conflict where the agent changed another step", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const saves: { manifest: unknown; expected: number }[] = [];
    const save = vi.fn(
      (_workflow: string, config: Readonly<Record<string, unknown>>, expected: number) => {
        if (expected !== store.draft)
          return Promise.reject(new ApiError(412, "revision_conflict", {}));
        saves.push({ manifest: config.manifest, expected });
        store.revisions.set(expected + 1, manifestOf(config.manifest));
        store.draft = expected + 1;
        return Promise.resolve({ revision: expected + 1 });
      }
    );
    const container = await mount(sourceOf(store, save));
    await settled(() => control(container, t("workflows.settings.noticeTitle")));
    await type(control(container, t("workflows.settings.noticeTitle")), "The notes are ready");
    // The agent in the dock saves a change to another step meanwhile.
    store.revisions.set(3, setStep(published, "clients", { name: "Load every client" }));
    store.draft = 3;
    await act(async () => button(container, t("workflows.settings.save")).click());

    await settled(() => expect(saves).toHaveLength(1));
    expect(save).toHaveBeenCalledTimes(2);
    expect(saves[0]?.expected).toBe(3);
    const saved = JSON.stringify(saves[0]?.manifest);
    expect(saved).toContain("Load every client");
    expect(saved).toContain("The notes are ready");
    expect(container.querySelector("[data-conflict]")).toBeNull();
  });

  it("keeps the person's value with the agent's under it where both changed the same field", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const saves: { manifest: unknown; expected: number }[] = [];
    const save = vi.fn(
      (_workflow: string, config: Readonly<Record<string, unknown>>, expected: number) => {
        if (expected !== store.draft)
          return Promise.reject(new ApiError(412, "revision_conflict", {}));
        saves.push({ manifest: config.manifest, expected });
        store.revisions.set(expected + 1, manifestOf(config.manifest));
        store.draft = expected + 1;
        return Promise.resolve({ revision: expected + 1 });
      }
    );
    const container = await mount(sourceOf(store, save));
    await settled(() => control(container, t("workflows.settings.noticeTitle")));
    await type(control(container, t("workflows.settings.noticeTitle")), "Mine");
    store.revisions.set(3, setStep(published, "notice", { title: { value: "The agent's" } }));
    store.draft = 3;
    await act(async () => button(container, t("workflows.settings.save")).click());

    await settled(() => expect(container.querySelector('[data-conflict="title"]')).not.toBeNull());
    const conflict = required(container.querySelector<HTMLElement>('[data-conflict="title"]'));
    expect(conflict.textContent).toContain(t("workflows.settings.theirs"));
    expect(conflict.textContent).toContain("The agent's");
    expect(control(container, t("workflows.settings.noticeTitle")).value).toBe("Mine");
    expect(saves).toHaveLength(0);

    // The next Save writes the person's value over the agent's draft.
    await act(async () => button(container, t("workflows.settings.save")).click());
    await settled(() => expect(saves).toHaveLength(1));
    expect(saves[0]?.expected).toBe(3);
    expect(titleOf(saves[0]?.manifest)).toEqual({ value: "Mine" });
  });

  it("takes the agent's value with Take it", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const save = vi.fn(() => Promise.reject(new ApiError(412, "revision_conflict", {})));
    const container = await mount(sourceOf(store, save));
    await settled(() => control(container, t("workflows.settings.noticeTitle")));
    await type(control(container, t("workflows.settings.noticeTitle")), "Mine");
    store.revisions.set(3, setStep(published, "notice", { title: { value: "The agent's" } }));
    store.draft = 3;
    await act(async () => button(container, t("workflows.settings.save")).click());
    await settled(() => expect(container.querySelector('[data-conflict="title"]')).not.toBeNull());

    await act(async () => button(container, t("workflows.settings.takeIt")).click());
    expect(control(container, t("workflows.settings.noticeTitle")).value).toBe("The agent's");
    expect(container.querySelector("[data-conflict]")).toBeNull();
  });

  it("says the change was dropped where the agent deleted the step", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const save = vi.fn(() => Promise.reject(new ApiError(412, "revision_conflict", {})));
    const container = await mount(sourceOf(store, save));
    await settled(() => control(container, t("workflows.settings.noticeTitle")));
    await type(control(container, t("workflows.settings.noticeTitle")), "Mine");
    store.revisions.set(3, {
      ...published,
      steps: published.steps.filter((step) => step.id !== "notice")
    });
    store.draft = 3;
    await act(async () => button(container, t("workflows.settings.save")).click());

    await settled(() => expect(container.querySelector("[data-edit-dropped]")).not.toBeNull());
    expect(container.textContent).toContain(t("workflows.settings.dropped"));
    expect(save).toHaveBeenCalledOnce();
  });

  it("offers no Settings to a reader who may not write the Workflow", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const container = await mount(
      sourceOf(store, () => Promise.resolve({ revision: 3 })),
      false
    );
    await settled(() =>
      expect(container.querySelector("[data-no-settings]")?.textContent).toBe("Client notes")
    );
    expect(container.querySelector("[data-step-settings]")).toBeNull();
  });
});
