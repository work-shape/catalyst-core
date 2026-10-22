// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  DeleteStepDialog,
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

// Deleting and moving a step from its panel (WF-EDIT-4, workflow-canvas 9.6, Events check
// 127): a delete asks once and saves one revision without the step; a step whose result a
// later step reads is not deleted, and the dialog names that step; a move the instance refuses
// saves nothing and gives its sentence. Fails without WF-EDIT-4: a step could not be deleted
// or moved by hand.

const { t } = createTranslationContext("en");
const WORKFLOW = "client-notes";

type Manifest = Readonly<Record<string, unknown>>;
type Editing = NonNullable<ReturnType<typeof useWorkflowEditing>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const idsOf = (manifest: unknown): string[] =>
  isRecord(manifest) && Array.isArray(manifest.steps)
    ? manifest.steps.filter(isRecord).map((step) => String(step.id))
    : [];

const published: Manifest = {
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

interface Store {
  revisions: Map<number, Manifest>;
  draft: number;
}

type Save = NonNullable<WorkflowsSource["drafts"]>["save"];

function sourceOf(store: Store, save: Save): WorkflowsSource {
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
  const unused = () => Promise.reject(new Error("Not read here."));
  return {
    key: "step-actions",
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

/** Saves into the store as the instance does. */
function storing(store: Store): Save & { saved: unknown[] } {
  const saved: unknown[] = [];
  const save: Save = (_workflow, config, expected) => {
    saved.push(config.manifest);
    if (isRecord(config.manifest)) store.revisions.set(expected + 1, config.manifest);
    store.draft = expected + 1;
    return Promise.resolve({ revision: expected + 1 });
  };
  return Object.assign(save, { saved });
}

let editingNow: Editing | undefined;

function Harness({ deleting }: { deleting: string | undefined }) {
  const read = useWorkflow("cw_1", WORKFLOW);
  const editing = useWorkflowEditing({
    workspaceId: "cw_1",
    workflowId: WORKFLOW,
    workflow: read.workflow,
    mayWrite: true
  });
  editingNow = editing;
  if (editing === undefined || deleting === undefined) return null;
  return createElement(DeleteStepDialog, {
    editing,
    stepId: deleting,
    onClose: () => undefined,
    onDeleted: () => document.body.setAttribute("data-deleted", deleting),
    onOpenStep: (id: string) => document.body.setAttribute("data-opened", id)
  });
}

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
  editingNow = undefined;
  document.body.removeAttribute("data-deleted");
  document.body.removeAttribute("data-opened");
});

async function mount(source: WorkflowsSource, deleting?: string): Promise<void> {
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
                  createElement(Harness, { deleting })
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
}

async function settled(check: () => void) {
  await vi.waitFor(async () => act(async () => check()), { timeout: CONDITION_WAIT_MS });
}

const button = (label: string): HTMLButtonElement =>
  required(
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === label
    )
  );

const loaded = () => settled(() => expect(idsOf(editingNow?.manifest)).toContain("audit"));

describe("deleting a step (WF-EDIT-4)", () => {
  it("asks once and saves one revision of the draft without the step", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const save = storing(store);
    await mount(sourceOf(store, save), "audit");
    await loaded();
    await settled(() =>
      expect(document.body.textContent).toContain(
        t("workflows.delete.title", { name: "Note the run" })
      )
    );
    await act(async () => button(t("workflows.delete.confirm")).click());

    await settled(() => expect(document.body.getAttribute("data-deleted")).toBe("audit"));
    expect(save.saved).toHaveLength(1);
    expect(idsOf(save.saved[0])).toEqual(["start", "clients", "notice", "result"]);
  });

  it("deletes no step whose result a later step reads, and names that step", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const save = storing(store);
    await mount(sourceOf(store, save), "clients");
    await loaded();
    await settled(() =>
      expect(document.body.querySelector("[data-delete-readers]")?.textContent).toBe(
        t("workflows.delete.readersOne", { names: "Result" })
      )
    );
    expect(document.body.textContent).toContain(
      t("workflows.delete.blockedTitle", { name: "Load the clients" })
    );
    expect(document.body.textContent).not.toContain(t("workflows.delete.confirm"));
    // The answer has the focus, not the close button; the other button opens the reader.
    expect(document.activeElement?.textContent).toBe(t("workflows.delete.close"));
    await act(async () => button(t("workflows.delete.openReader", { name: "Result" })).click());
    expect(document.body.getAttribute("data-opened")).toBe("result");
    expect(save.saved).toHaveLength(0);
  });
});

describe("moving a step (WF-EDIT-4)", () => {
  it("saves the move as one revision of the draft", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const save = storing(store);
    await mount(sourceOf(store, save));
    await loaded();
    let refused: string | undefined = "not answered";
    await act(async () => {
      refused = await required(editingNow).commit({
        kind: "move",
        step: "audit",
        at: { kind: "after", step: "notice" }
      });
    });
    expect(refused).toBeUndefined();
    expect(idsOf(save.saved[0])).toEqual(["start", "clients", "notice", "audit", "result"]);
    await settled(() =>
      expect(idsOf(editingNow?.manifest)).toEqual(["start", "clients", "notice", "audit", "result"])
    );
  });

  it("saves nothing where the instance refuses the move, and says which step would not see it", async () => {
    const store: Store = { revisions: new Map([[2, published]]), draft: 2 };
    const save = vi.fn<Save>(() =>
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
    await mount(sourceOf(store, save));
    await loaded();
    let refused: string | undefined;
    await act(async () => {
      refused = await required(editingNow).commit({
        kind: "move",
        step: "clients",
        at: { kind: "after", step: "notice" }
      });
    });
    // The instance's scope rule, in the reader's words and by the steps' names.
    expect(refused).toBe(
      t("workflows.move.outOfScope", { reader: "Result", step: "Load the clients" })
    );
    expect(save).toHaveBeenCalledOnce();
    expect(store.draft).toBe(2);
    expect(idsOf(editingNow?.manifest)).toEqual(["start", "clients", "audit", "notice", "result"]);
    expect(editingNow?.unsaved.size).toBe(0);
  });
});
