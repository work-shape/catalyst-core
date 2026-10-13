import { useEffect, useMemo, useState } from "react";
import type { LocaleCode } from "@vivd-catalyst/api-client";
import { UiRoot, type UiRootProps } from "@vivd-catalyst/ui";
import { TranslationProvider } from "../../i18n";
import { uiLabelsFor } from "../../ui-labels";
import type { WorkspaceRoute } from "../../workspace/workspace-route";
import { WorkflowsSourceProvider } from "../workflow-source";
import { WorkflowsArea, isWorkflowsRoute, type WorkflowsRoute } from "../workflows-area";
import { WorkflowsHostProvider, type WorkflowsHost } from "../workflows-host";
import { SAMPLE_VIEWER_ID } from "./sample-runs";
import { createSampleSource } from "./sample-source";

// The Workflow pages over sample Workflows and sample runs, beside the UI library and behind
// the same right. An instance has no source of definitions and no read of one yet, so it lists
// no Workflow; this page is where the screens are looked at, photographed and tested in a
// browser until then. The
// address says what to open: `?at=<workflow>`, `?at=<workflow>/runs`,
// `?at=<workflow>/runs/<run>`, `?at=<workflow>/open/<child>`, with `lang=de`. Light and dark
// are the reader's own, as everywhere in the interface.

const WORKSPACE = { id: "samples", name: "Samples" };

function routeAt(at: string | null): WorkflowsRoute {
  const [workflow, runs, run] = (at ?? "").split("/").filter((part) => part !== "");
  const collaborationWorkspaceId = WORKSPACE.id;
  if (workflow === undefined) {
    return { kind: "workflows", collaborationWorkspaceId };
  }
  if (runs === "open") {
    return {
      kind: "workflow",
      collaborationWorkspaceId,
      workflow,
      opened: (at ?? "").split("/").slice(2).join("/")
    };
  }
  if (runs !== "runs") {
    return { kind: "workflow", collaborationWorkspaceId, workflow };
  }
  return run === undefined
    ? { kind: "workflow-runs", collaborationWorkspaceId, workflow }
    : { kind: "workflow-run", collaborationWorkspaceId, workflow, run };
}

function address(route: WorkflowsRoute): string {
  switch (route.kind) {
    case "workflows":
      return "";
    case "workflow":
      return route.opened ? `${route.workflow}/open/${route.opened}` : route.workflow;
    case "workflow-runs":
      return `${route.workflow}/runs`;
    case "workflow-run":
      return `${route.workflow}/runs/${route.run}`;
  }
}

export function WorkflowSamples({
  theme,
  mode,
  locale: givenLocale
}: {
  theme?: UiRootProps["theme"];
  mode: "light" | "dark";
  locale: LocaleCode;
}) {
  const asked = useMemo(() => new URLSearchParams(window.location.search), []);
  const lang = asked.get("lang");
  const locale: LocaleCode = lang === "de" || lang === "en" ? lang : givenLocale;
  const [route, setRoute] = useState<WorkflowsRoute>(() => routeAt(asked.get("at")));
  // The browser's way back and forward lead through the addresses the page has shown.
  useEffect(() => {
    const read = () => setRoute(routeAt(new URLSearchParams(window.location.search).get("at")));
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, []);
  const source = useMemo(() => createSampleSource(locale), [locale]);
  const host = useMemo<WorkflowsHost>(
    () => ({
      rights: { read: true, start: true, write: true },
      viewerId: SAMPLE_VIEWER_ID,
      workspace: WORKSPACE,
      showRoute: (next: WorkspaceRoute, options) => {
        if (!isWorkflowsRoute(next)) {
          return;
        }
        const query = new URLSearchParams(window.location.search);
        query.set("at", address(next));
        const url = `${window.location.pathname}?${query.toString()}`;
        if (options?.replace === true) {
          window.history.replaceState(null, "", url);
        } else {
          window.history.pushState(null, "", url);
        }
        setRoute(next);
      }
    }),
    []
  );
  const labels = uiLabelsFor(locale);
  return (
    <TranslationProvider locale={locale}>
      <UiRoot
        as="main"
        {...(theme === undefined ? {} : { theme })}
        mode={mode}
        labels={labels}
        className="flex h-dvh w-full flex-col bg-background text-foreground"
        data-workflow-samples=""
      >
        <WorkflowsSourceProvider source={source}>
          <WorkflowsHostProvider value={host}>
            <WorkflowsArea route={route} />
          </WorkflowsHostProvider>
        </WorkflowsSourceProvider>
      </UiRoot>
    </TranslationProvider>
  );
}
