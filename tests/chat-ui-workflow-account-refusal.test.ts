// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement, Fragment } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { createTranslationContext, TranslationProvider } from "@work-shape/catalyst-chat-ui";
import {
  createInstanceSource,
  resolveWorkflowRights,
  workflowAccountRefusal,
  workflowPublishRefusal,
  WorkflowsHostProvider,
  WorkflowsSourceProvider,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { CONDITION_WAIT_MS } from "./support/assertions";
import { useStartRun } from "./support/chat-ui";
import { recordedApiClient } from "./support/recorded-api-client";

// ACCEPT-1c B4: a test run, a start or a publish refused over the technical account a Workflow
// runs as showed the instance's English diagnostic. The reader now reads, in their language,
// which account it is, by the label people see, and that an administrator changes it under
// Settings › API access. The account's internal name stands only where no label came along.

const en = createTranslationContext("en").t;
const de = createTranslationContext("de").t;
const SERVER_SENTENCE =
  "This Workflow runs as the technical account 'workflow-runner', which is missing or disabled.";

const refusal = (code: string, details: Record<string, string>) =>
  new ApiError(code === "CONFLICT" ? 409 : 400, "refused", {
    error: { code, message: SERVER_SENTENCE, details }
  });

describe("a refusal over the Workflow's technical account", () => {
  it("names the account by its label and where an administrator changes it, in both languages", () => {
    const inactive = refusal("CONFLICT", {
      reason: "principal_inactive",
      runAs: "workflow-runner",
      principalDisplayLabel: "Booking checks"
    });
    expect(workflowAccountRefusal(inactive, en)).toBe(
      "This workflow runs as the technical account “Booking checks”, which is switched off. An administrator switches it on under Settings › API access, or you choose another account in the workflow."
    );
    expect(workflowAccountRefusal(inactive, de)).toBe(
      "Dieser Workflow läuft als Technisches Konto „Booking checks“, das ausgeschaltet ist. Ein Administrator schaltet es unter Einstellungen › API-Zugang ein, oder du wählst im Workflow ein anderes Konto."
    );
    // The account does not exist: no label came along, and its internal name is not shown.
    const gone = refusal("CONFLICT", { reason: "principal_inactive", runAs: "workflow-runner" });
    expect(workflowAccountRefusal(gone, en)).toBe(
      "This workflow runs as a technical account that is missing or switched off. An administrator manages the accounts under Settings › API access."
    );
  });

  it("says each of the publish refusals the same way", () => {
    const cases: [Record<string, string>, string][] = [
      [{ reason: "run_as_missing" }, "names no technical account"],
      [{ reason: "run_as_unknown", runAs: "runner" }, "“runner”, which does not exist"],
      [
        { reason: "run_as_disabled", runAs: "runner", principalDisplayLabel: "Runner" },
        "“Runner”, which is switched off"
      ]
    ];
    for (const [details, words] of cases) {
      const error = refusal("VALIDATION_FAILED", details);
      expect(workflowPublishRefusal(error, en)).toContain(words);
      expect(workflowPublishRefusal(error, en)).toContain("Settings › API access");
      expect(workflowPublishRefusal(error, de)).toContain("Einstellungen › API-Zugang");
    }
    expect(workflowAccountRefusal(refusal("FORBIDDEN", { reason: "no_grant" }), en)).toBe(
      undefined
    );
  });
});

const unmounts: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const unmount of unmounts.splice(0)) await unmount();
});

function StartHarness() {
  const start = useStartRun({ workflow: "month-end", name: "Month end" });
  return createElement(
    Fragment,
    null,
    createElement("button", { type: "button", "data-open": "", onClick: start.open }, "open"),
    start.dialog
  );
}

describe("a start refused over the technical account", () => {
  it("says so in the start dialog, not with the instance's diagnostic", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const { client } = recordedApiClient(() => ({}));
    const instance = createInstanceSource(client, "k");
    const runs = instance.runs;
    if (runs === undefined) throw new Error("The instance source has runs");
    const source: WorkflowsSource = {
      ...instance,
      runs: {
        ...runs,
        start: () =>
          Promise.reject(
            refusal("CONFLICT", {
              reason: "principal_inactive",
              runAs: "workflow-runner",
              principalDisplayLabel: "Booking checks"
            })
          )
      }
    };
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    unmounts.push(async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    });
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
                    rights: resolveWorkflowRights(undefined, undefined),
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
                    createElement(StartHarness)
                  )
                )
              )
            )
          )
        )
      );
    });
    await act(async () => container.querySelector<HTMLButtonElement>("[data-open]")?.click());
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === en("workflows.start.confirm")
    );
    expect(confirm).toBeDefined();
    await act(async () => confirm?.click());
    await vi.waitFor(
      () =>
        expect(document.body.textContent).toContain(
          "This workflow runs as the technical account “Booking checks”, which is switched off."
        ),
      { timeout: CONDITION_WAIT_MS }
    );
    expect(document.body.textContent).toContain("Settings › API access");
    expect(document.body.textContent).not.toContain(SERVER_SENTENCE);
    expect(document.body.textContent).not.toContain("workflow-runner");
  });
});
