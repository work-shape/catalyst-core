// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { decision, item } from "./chat-ui-inbox-harness";
import { useApprovalRequestQuery } from "./support/chat-ui";

// ACCEPT-FIX-9 E5: an approved item read "Approved, running" after its change had run, until a
// reload: nothing asked for it again before the Inbox's 60 s, and the card in a conversation
// never. While the change runs, the request is asked for again soon, however long it runs.

const URL_OF_INSTANCE = "https://chat.example.com";
/** A deadline past a few reads at the short cadence, far short of the Inbox's 60 s. */
const SETTLES_WITHIN_MS = 10_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Mounts the request query against an instance whose change runs for `runningReads` reads. */
async function mountRequest(input: {
  refetchIntervalMs: number | undefined;
  runningReads: number;
  decidedAt: string;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const reads: string[] = [];
  const fetchImpl: typeof fetch = async () => {
    const execution = reads.length < input.runningReads ? "queued" : "done";
    reads.push(execution);
    const answer: ApprovalRequestView = item({
      status: "approved",
      decision: { ...decision, approved: true, decidedAt: input.decidedAt },
      applyResult: { execution }
    });
    return Response.json(answer);
  };
  const client = createApiClient({ baseUrl: URL_OF_INSTANCE, fetchImpl });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const seen: { execution: unknown } = { execution: undefined };
  function Probe() {
    const query = useApprovalRequestQuery({
      apiBaseUrl: URL_OF_INSTANCE,
      authScope: "settling-test",
      client,
      requestId: "apr_1",
      ...(input.refetchIntervalMs === undefined
        ? {}
        : { refetchIntervalMs: input.refetchIntervalMs })
    });
    seen.execution = query.data?.applyResult?.execution;
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(Probe)));
  });
  const shows = (execution: string) =>
    vi.waitFor(() => expect(seen.execution).toBe(execution), { timeout: SETTLES_WITHIN_MS });
  return { reads, shows, unmount: () => act(() => root.unmount()) };
}

describe("an approved request whose change still runs", () => {
  // The Inbox item asks every 60 s; the card in a conversation asks only on focus.
  for (const [where, refetchIntervalMs] of [
    ["the Inbox item", 60_000],
    ["the card in a conversation", undefined]
  ] as const) {
    it(`shows the final state in ${where} once the change has run`, async () => {
      const mounted = await mountRequest({
        refetchIntervalMs,
        runningReads: 1,
        decidedAt: new Date().toISOString()
      });

      await mounted.shows("queued");
      await mounted.shows("done");
      expect(mounted.reads).toEqual(["queued", "done"]);
      await mounted.unmount();
    }, 20_000);
  }

  it("keeps asking while a change decided an hour ago still runs", async () => {
    const mounted = await mountRequest({
      refetchIntervalMs: undefined,
      runningReads: 2,
      decidedAt: new Date(Date.now() - 60 * 60_000).toISOString()
    });

    await mounted.shows("done");
    expect(mounted.reads).toEqual(["queued", "queued", "done"]);
    await mounted.unmount();
  }, 20_000);
});
