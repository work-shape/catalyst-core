// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  toWorkflow,
  useWorkflow,
  useWorkflowEditing,
  WorkflowSettingsForm,
  WorkflowsHostProvider,
  WorkflowsSourceProvider,
  type WorkflowsHost,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS, required } from "./support/assertions";

// The Settings tab of a Workflow (WF-EDIT-5, Events check 128): "Every weekday at 07:30,
// Berlin time" writes the trigger's cron and zone; a schedule the field cannot read is saved
// untouched; the start fields write `inputs`; the last way to start stays on; the result, the
// limits and the account are read-only lines; and a reader who may not write the Workflow sees
// it all read-only. Fails without WF-EDIT-5: the Workflow had no Settings tab.

const { t } = createTranslationContext("en");
const WORKFLOW = "bookings";

type Config = Readonly<Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const manifestOf = (config: Config | undefined): Record<string, unknown> =>
  isRecord(config?.manifest) ? config.manifest : {};
const triggersOf = (config: Config | undefined) => {
  const steps = manifestOf(config).steps;
  const start = Array.isArray(steps) ? steps.find(isRecord) : undefined;
  return isRecord(start) ? start.triggers : undefined;
};

function manifestWith(triggers: readonly Record<string, unknown>[]) {
  return {
    id: WORKFLOW,
    name: "Bookings",
    inputs: {
      type: "object",
      properties: { month: { type: "string", title: "Month" } },
      required: ["month"],
      additionalProperties: false
    },
    outputs: { type: "object", properties: { count: { type: "integer", title: "Bookings" } } },
    limits: { duration: "30h" },
    steps: [
      { id: "start", name: "Start", type: "trigger", triggers },
      { id: "result", name: "Result", type: "output", input: { count: { value: 1 } } }
    ]
  };
}

function sourceOf(
  manifest: Record<string, unknown>,
  saves: { config: Config; expected: number }[]
): WorkflowsSource {
  let draft: { config: Config; revision: number } = {
    config: { name: WORKFLOW, manifest },
    revision: 2
  };
  const view = () => {
    const current = manifestOf(draft.config);
    return {
      ...toWorkflow(
        { name: WORKFLOW, config: current, publishedRevision: 2 },
        {},
        { draftRevision: draft.revision, publishedRevision: 2 }
      ),
      definition: { config: draft.config, manifest: current, revision: draft.revision }
    };
  };
  const unused = () => Promise.reject(new Error("Not read by the Settings."));
  return {
    key: "workflow-settings",
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

function Harness({ mayWrite }: { mayWrite: boolean }) {
  const read = useWorkflow("cw_1", WORKFLOW);
  const editing = useWorkflowEditing({
    workspaceId: "cw_1",
    workflowId: WORKFLOW,
    workflow: read.workflow,
    mayWrite
  });
  if (read.workflow === undefined) return null;
  return createElement(WorkflowSettingsForm, {
    workspaceId: "cw_1",
    workflow: read.workflow,
    ...(editing === undefined ? {} : { editing }),
    onOpenRoute: () => undefined
  });
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
    instanceTimeZone: { timeZone: "Europe/Berlin", defaulted: false },
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
                  createElement(Harness, { mayWrite })
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
  await settled(() => expect(container.querySelector("[data-workflow-settings]")).not.toBeNull());
  return container;
}

async function settled(check: () => void) {
  await vi.waitFor(async () => act(async () => check()), { timeout: CONDITION_WAIT_MS });
}

/** The control a label names, within `scope`. */
function labelled(scope: Element, label: string): HTMLElement {
  const found = [...scope.querySelectorAll("label")].find(
    (candidate) => candidate.textContent?.startsWith(label) === true
  );
  return required(found?.htmlFor ? document.getElementById(found.htmlFor) : null);
}

function input(scope: Element, label: string): HTMLInputElement {
  const element = labelled(scope, label);
  if (!(element instanceof HTMLInputElement)) throw new Error(`No input labelled ${label}`);
  return element;
}

async function type(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function button(scope: Element, label: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === label
  );
}

const save = (container: Element) => required(button(container, t("workflows.settings.save")));

describe("the Settings tab of a Workflow (WF-EDIT-5)", () => {
  it("sets every weekday at 07:30, Berlin time: the trigger holds the cron and the zone", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const container = await mount(sourceOf(manifestWith([{ kind: "manual" }]), saves));
    await act(async () => labelled(container, t("workflows.workflowSettings.onSchedule")).click());
    await settled(() =>
      expect(container.querySelector('[data-slot="schedule-field"]')).not.toBeNull()
    );
    const schedule = required(container.querySelector('[data-slot="schedule-field"]'));
    // A new schedule is every weekday in the instance's zone; the time is set here.
    await type(input(schedule, uiLabelsEn.scheduleTime), "07:30");
    await settled(() => expect(save(container).disabled).toBe(false));
    await act(async () => save(container).click());
    await settled(() => expect(saves).toHaveLength(1));
    expect(triggersOf(saves[0]?.config)).toEqual([
      { kind: "manual" },
      { kind: "schedule", cron: "30 7 * * 1-5", timeZone: "Europe/Berlin" }
    ]);
  });

  it("saves a schedule it cannot read untouched, and says it in words", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const yearly = {
      kind: "schedule",
      cron: "0 9 1 1 *",
      timeZone: "Europe/Berlin",
      missed: "all"
    };
    const container = await mount(sourceOf(manifestWith([yearly]), saves));
    expect(container.querySelector('[data-slot="schedule-field"]')).toBeNull();
    expect(required(container.querySelector("[data-schedule-unread]")).textContent).toContain(
      "Every year on"
    );
    await type(input(container, t("workflows.workflowSettings.name")), "Yearly bookings");
    await settled(() => expect(save(container).disabled).toBe(false));
    await act(async () => save(container).click());
    await settled(() => expect(saves).toHaveLength(1));
    expect(manifestOf(saves[0]?.config).name).toBe("Yearly bookings");
    expect(triggersOf(saves[0]?.config)).toEqual([yearly]);
  });

  it("writes what it asks for as its inputs, and keeps the last way to start on", async () => {
    const saves: { config: Config; expected: number }[] = [];
    const container = await mount(sourceOf(manifestWith([{ kind: "manual" }]), saves));
    // By hand is the only way on: it cannot be turned off.
    expect(
      labelled(container, t("workflows.workflowSettings.byHand")).hasAttribute("disabled")
    ).toBe(true);
    const inputs = required(container.querySelector("[data-workflow-inputs]"));
    await act(async () => required(button(inputs, uiLabelsEn.addField)).click());
    const added = required(inputs.querySelectorAll("[data-field-id]")[1]);
    await type(input(added, uiLabelsEn.fieldName), "client");
    await settled(() => expect(save(container).disabled).toBe(false));
    await act(async () => save(container).click());
    await settled(() => expect(saves).toHaveLength(1));
    expect(manifestOf(saves[0]?.config).inputs).toEqual({
      type: "object",
      properties: { month: { type: "string", title: "Month" }, client: { type: "string" } },
      required: ["month"],
      additionalProperties: false
    });
  });

  it("shows the result, the limits and the owner as read-only lines", async () => {
    const container = await mount(sourceOf(manifestWith([{ kind: "manual" }]), []));
    const facts = required(container.querySelector("[data-workflow-facts]"));
    expect(facts.textContent).toContain("Bookings");
    expect(facts.textContent).toContain("Runs up to 30 hours");
    expect(facts.textContent).toContain(t("workflows.workflowSettings.onFailureNotify"));
    expect(facts.textContent).toContain(t("workflows.workflowSettings.ownerInstance"));
  });

  it("is read-only for a reader who may not write the Workflow", async () => {
    const container = await mount(sourceOf(manifestWith([{ kind: "manual" }]), []), false);
    expect(container.textContent).toContain(t("workflows.workflowSettings.readOnly"));
    expect(input(container, t("workflows.workflowSettings.name")).readOnly).toBe(true);
    expect(
      labelled(container, t("workflows.workflowSettings.onSchedule")).hasAttribute("disabled")
    ).toBe(true);
    expect(button(container, t("workflows.settings.save"))).toBeUndefined();
  });
});
