// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  toWorkflow,
  toWorkflowRun,
  toWorkflowStepRun,
  WorkflowRunPage,
  WorkflowsHostProvider,
  WorkflowsSourceProvider,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS } from "./support/assertions";

// UI-FIX-1: the page of a run says when the steps of the run could not be read, with Try
// again, under the head of the run it holds. Try again reads the run and its steps again, also
// where a later reading of steps it held failed. While the steps are on their way, and once
// they arrived, it says nothing of the kind. Where the run's own reading fails too, the page
// says only that it lost the instance, as before.

const { t } = createTranslationContext("en");
const STEPS_FAILED = t("workflows.run.stepsFailedToLoad");
/** The start of the line a run says while the instance does not answer about it. */
const SILENT = t("workflows.run.stale", { seconds: "{s}" }).split("{s}")[0] ?? "";

type StepRunResource = Parameters<typeof toWorkflowStepRun>[0];

const definition = {
  id: "notify-clients",
  name: "Notify clients",
  steps: [
    { id: "start", name: "Start by hand", type: "trigger", triggers: [{ kind: "manual" }] },
    { id: "clients", name: "Load the clients", type: "operation", operation: "crm.list" },
    { id: "result", name: "Result", type: "output", input: {} }
  ]
};
const createdAt = "2026-10-12T09:00:00.000Z";
const doneRun = toWorkflowRun({
  id: "wr_1",
  workflow: "notify-clients",
  trigger: "manual",
  status: "done",
  startedBy: { id: "user_1", label: "Ada Lovelace" },
  createdAt,
  startedAt: "2026-10-12T09:00:01.000Z",
  finishedAt: "2026-10-12T09:00:42.000Z"
});
const runningRun = toWorkflowRun({
  id: "wr_1",
  workflow: "notify-clients",
  trigger: "manual",
  status: "running",
  startedBy: { id: "user_1", label: "Ada Lovelace" },
  createdAt,
  startedAt: "2026-10-12T09:00:01.000Z"
});
const doneClients: StepRunResource = {
  id: "sr_clients",
  stepId: "clients",
  stepType: "operation",
  status: "done",
  attempt: 1,
  createdAt
};

const unused = () => Promise.reject(new Error("Not read by the page of a run."));

/** A refusal without anything of the steps in it. */
const unreadable = () => Promise.reject(new Error("unreadable"));

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) {
    await unmount();
  }
});

type RunView = typeof doneRun;

/**
 * The page of a run whose steps and run the instance answers as `listSteps` and `readRun` do,
 * call after call. `nextCursor` says where the page after the one read from a cursor starts.
 */
async function mountRunPage(
  listSteps: (cursor: string | undefined) => Promise<readonly StepRunResource[]>,
  readRun: () => Promise<RunView> = () => Promise.resolve(doneRun),
  nextCursor: (cursor: string | undefined) => string | undefined = () => undefined
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const getRun = vi.fn(readRun);
  const listFrameStepRuns = vi.fn(async (_runId: string, cursor: string | undefined) => ({
    stepRuns: (await listSteps(cursor)).map(toWorkflowStepRun),
    entryLoops: [],
    nextCursor: nextCursor(cursor)
  }));
  const source: WorkflowsSource = {
    key: "run-steps",
    listWorkflows: unused,
    getWorkflow: () =>
      Promise.resolve(
        toWorkflow(
          { name: "notify-clients", config: definition, publishedRevision: 2 },
          { mayStart: true },
          { draftRevision: 2, publishedRevision: 2 }
        )
      ),
    runs: {
      listRuns: unused,
      getRun,
      listFrameStepRuns,
      listEntryStepRuns: unused,
      start: unused,
      cancel: unused
    }
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
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
              {
                value: {
                  rights: {
                    instance: { read: true, write: false, publish: false, delete: false }
                  },
                  viewerId: "user_1",
                  workspace: { id: "cw_1", name: "Office" },
                  showRoute: () => undefined
                },
                children: null
              },
              createElement(
                TranslationProvider,
                { locale: "en", children: null },
                createElement(
                  UiRoot,
                  { mode: "light", labels: uiLabelsEn },
                  createElement(WorkflowRunPage, { workflow: "notify-clients", run: "wr_1" })
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
  return { container, getRun, listFrameStepRuns };
}

async function until(check: () => void): Promise<void> {
  await vi.waitFor(
    async () => {
      await act(async () => undefined);
      check();
    },
    { timeout: CONDITION_WAIT_MS }
  );
}

function tryAgain(container: ParentNode): HTMLButtonElement | undefined {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === t("tryAgain")
  );
}

describe("the steps of a run on its page", () => {
  it("says they could not be read, with Try again", async () => {
    const page = await mountRunPage(unreadable);
    await until(() => expect(page.container.textContent).toContain(STEPS_FAILED));
    expect(tryAgain(page.container)).toBeDefined();
    // The sentence is the interface's own: nothing the refusal said reaches the page.
    expect(page.container.textContent).not.toContain("unreadable");
    // It is the steps that failed, not the run.
    expect(page.container.textContent).not.toContain(t("workflows.run.failedToLoad"));
  });

  it("reads the run and its steps again on Try again, and shows the steps that arrive", async () => {
    let answer: () => Promise<readonly StepRunResource[]> = unreadable;
    const page = await mountRunPage(() => answer());
    await until(() => expect(page.container.textContent).toContain(STEPS_FAILED));

    // Try again that fails once more says so once more.
    let stepReads = page.listFrameStepRuns.mock.calls.length;
    await act(async () => tryAgain(page.container)?.click());
    // The reading and its two tries have all failed before the next step of the test.
    await until(() =>
      expect(page.listFrameStepRuns.mock.calls.length).toBeGreaterThanOrEqual(stepReads + 3)
    );
    await until(() => expect(page.container.textContent).toContain(STEPS_FAILED));

    const runReads = page.getRun.mock.calls.length;
    stepReads = page.listFrameStepRuns.mock.calls.length;
    answer = () => Promise.resolve([doneClients]);
    await act(async () => tryAgain(page.container)?.click());

    await until(() => expect(page.container.textContent).not.toContain(STEPS_FAILED));
    expect(page.getRun.mock.calls.length).toBeGreaterThan(runReads);
    expect(page.listFrameStepRuns.mock.calls.length).toBeGreaterThan(stepReads);
    // A done run's state stands once its step runs are there.
    await until(() => expect(page.container.textContent).toContain(t("workflows.run.done")));
  });

  it("says nothing of a failure while they load, nor once they arrived", async () => {
    let arrive: (steps: readonly StepRunResource[]) => void = () => undefined;
    const page = await mountRunPage(
      () =>
        new Promise((resolve) => {
          arrive = resolve;
        })
    );
    await until(() => expect(page.listFrameStepRuns).toHaveBeenCalled());
    expect(page.container.textContent).not.toContain(STEPS_FAILED);
    await act(async () => arrive([doneClients]));
    await until(() => expect(page.container.textContent).toContain(t("workflows.run.done")));
    expect(page.container.textContent).not.toContain(STEPS_FAILED);
  });

  it("says a later reading of the steps of a going run failed, until Try again reads them", async () => {
    let answer: () => Promise<readonly StepRunResource[]> = () => Promise.resolve([doneClients]);
    const page = await mountRunPage(
      () => answer(),
      () => Promise.resolve(runningRun)
    );
    await until(() => expect(page.listFrameStepRuns).toHaveBeenCalled());
    await until(() => expect(page.container.textContent).toContain(t("workflows.run.running")));
    expect(page.container.textContent).not.toContain(STEPS_FAILED);

    // The next reading every two seconds fails, and so do the two tries after it.
    answer = unreadable;
    await until(() => expect(page.container.textContent).toContain(STEPS_FAILED));
    expect(tryAgain(page.container)).toBeDefined();
    // The head of the run it holds stays, and the run is not said to be lost.
    expect(page.container.textContent).toContain(t("workflows.run.running"));
    expect(page.container.textContent).toContain(definition.name);
    expect(page.container.textContent).not.toContain(SILENT);

    answer = () => Promise.resolve([doneClients]);
    await act(async () => tryAgain(page.container)?.click());
    await until(() => expect(page.container.textContent).not.toContain(STEPS_FAILED));
    expect(page.container.textContent).toContain(t("workflows.run.running"));
  });

  it("says only that the instance is silent where the run it holds and its steps both fail", async () => {
    let runAnswer: () => Promise<RunView> = () => Promise.resolve(runningRun);
    let stepsAnswer: () => Promise<readonly StepRunResource[]> = () =>
      Promise.resolve([doneClients]);
    const page = await mountRunPage(
      () => stepsAnswer(),
      () => runAnswer()
    );
    await until(() => expect(page.listFrameStepRuns).toHaveBeenCalled());
    await until(() => expect(page.container.textContent).toContain(t("workflows.run.running")));

    // Both readings every two seconds fail, and so do their tries.
    runAnswer = unreadable;
    stepsAnswer = unreadable;
    await until(() => expect(page.container.textContent).toContain(SILENT));
    // The steps' failure stays unsaid, with no Try again: the page tries again by itself.
    await until(() => expect(page.container.textContent).not.toContain(STEPS_FAILED));
    expect(tryAgain(page.container)).toBeUndefined();
    // The head of the run it holds stays.
    expect(page.container.textContent).toContain(t("workflows.run.running"));
    expect(page.container.textContent).toContain(definition.name);

    // Once the instance answers again, the page says nothing of either.
    runAnswer = () => Promise.resolve(runningRun);
    stepsAnswer = () => Promise.resolve([doneClients]);
    // The two readings recover on their own clocks, so the page is read until both have.
    await until(() => {
      expect(page.container.textContent).not.toContain(SILENT);
      expect(page.container.textContent).not.toContain(STEPS_FAILED);
    });
    expect(page.container.textContent).toContain(t("workflows.run.running"));
  });

  // DISCOVERY-PAGING: the frame stopped after ten reads and said so with no way on. The page
  // reads the next page of the frame from the cursor the last one handed on, as often as the
  // reader asks, and says nothing once the last page is there.
  it("reads the next page of the frame from its cursor, and stops saying it is cut after the last", async () => {
    const doneResult: StepRunResource = { ...doneClients, id: "sr_result", stepId: "result" };
    const page = await mountRunPage(
      (cursor) => Promise.resolve(cursor === undefined ? [doneClients] : [doneResult]),
      () => Promise.resolve(doneRun),
      (cursor) => (cursor === undefined ? "c2" : undefined)
    );
    const more = () => page.container.querySelector<HTMLElement>("[data-run-more-steps] button");
    await until(() => expect(more()).not.toBeNull());
    expect(page.container.textContent).toContain(t("workflows.run.stepRunsCut"));
    expect(page.listFrameStepRuns.mock.calls.map((call) => call[1])).toEqual([undefined]);

    await act(async () => more()?.click());
    await until(() => expect(more()).toBeNull());
    expect(page.listFrameStepRuns.mock.calls.map((call) => call[1])).toEqual([undefined, "c2"]);
    expect(page.container.textContent).not.toContain(t("workflows.run.stepRunsCut"));
  });
});
