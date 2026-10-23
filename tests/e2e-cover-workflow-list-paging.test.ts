// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import {
  WorkflowsPageView,
  WorkflowsSourceProvider,
  toWorkflowListItem,
  type WorkflowsSource
} from "@work-shape/catalyst-chat-ui/workflows";
import { WorkspaceApiClientProvider } from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { UiRoot, uiLabelsEn } from "@work-shape/catalyst-ui";
import { TranslationProvider } from "./support/chat-ui/shared";
// The real paging hook and page replace the former static HTML fixture.
import { useWorkflowList } from "./support/chat-ui";

it.each([12, 4])(
  "reads all %i Workflow pages, holding Show more until a late answer is drawn",
  async (pages) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } }
    });
    let answer: (() => void) | undefined;
    const cursors: (string | undefined)[] = [];
    const source: WorkflowsSource = {
      key: "paging",
      runs: undefined,
      getWorkflow: async () => {
        throw new Error("The list must not read definitions");
      },
      listWorkflows: async (workspaceId, query) => {
        expect(workspaceId).toBe("cw_team");
        expect(query.limit).toBe(50);
        cursors.push(query.cursor);
        const page = Number(query.cursor ?? 0);
        if (pages === 4 && page > 0)
          await new Promise<void>((resolve) => {
            answer = resolve;
          });
        return {
          items: Array.from({ length: 50 }, (_, index) =>
            toWorkflowListItem({
              id: `workflow-${page}-${index}`,
              name: `Workflow ${page}-${index}`
            })
          ),
          nextCursor: page === pages - 1 ? undefined : String(page + 1)
        };
      }
    };
    const noop = () => undefined;
    function Page() {
      const list = useWorkflowList("cw_team");
      return createElement(WorkflowsPageView, {
        workspaceId: "cw_team",
        list,
        now: new Date("2026-10-24"),
        runsAvailable: false,
        onOpenRoute: noop,
        onStart: noop
      });
    }
    const drawn = async (text: string) =>
      vi.waitFor(
        async () => {
          await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
          });
          expect(host.textContent).toContain(text);
        },
        { interval: 1 }
      );
    const more = () => host.querySelector<HTMLButtonElement>("[data-workflows-more] button");
    try {
      await act(async () =>
        root.render(
          createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(WorkspaceApiClientProvider, {
              apiBaseUrl: "https://chat.example",
              children: createElement(WorkflowsSourceProvider, {
                source,
                children: createElement(TranslationProvider, {
                  locale: "en",
                  children: createElement(
                    UiRoot,
                    { mode: "light", labels: uiLabelsEn },
                    createElement(Page)
                  )
                })
              })
            })
          )
        )
      );
      await drawn("Workflow 0-49");
      for (let page = 1; page < pages; page++) {
        expect(more()).not.toBeNull();
        await act(async () => more()?.click());
        if (pages === 4) {
          expect(answer).toBeDefined();
          await vi.waitFor(
            async () => {
              await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 0));
              });
              expect(more()?.disabled).toBe(true);
            },
            { interval: 1 }
          );
          // Another press while waiting cannot fetch the cursor twice.
          act(() => more()?.click());
          expect(cursors).toHaveLength(page + 1);
          await act(async () => {
            answer?.();
          });
        }
        await drawn(`Workflow ${page}-49`);
        expect(host.textContent).toContain("Workflow 0-0");
      }
      expect(cursors).toEqual([
        undefined,
        ...Array.from({ length: pages - 1 }, (_, index) => String(index + 1))
      ]);
      expect(host.querySelectorAll("li")).toHaveLength(pages * 50);
      expect(more()).toBeNull();
    } finally {
      act(() => root.unmount());
      queryClient.clear();
      host.remove();
      vi.unstubAllGlobals();
    }
  }
);
