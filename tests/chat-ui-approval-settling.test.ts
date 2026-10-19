// @vitest-environment happy-dom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, type ApprovalRequestView } from "@work-shape/catalyst-api-client";
import { decision, item } from "./chat-ui-inbox-harness";
import {
  approvalRequestState,
  useApprovalRequestQuery,
  type ApprovalRequestState
} from "./support/chat-ui";

// ACCEPT-FIX-9 E5: an approved item read "Approved, running" after its change had run, until a
// reload: nothing asked for it again before the Inbox's 60 s, and the card in a conversation
// never. While the change runs, the request is asked for again soon, for a bounded number of
// reads; then the last state stays and the person can refresh it.

const URL_OF_INSTANCE = "https://chat.example.com";
/** A deadline past a few reads at the short cadence, far short of the Inbox's 60 s. */
const SETTLES_WITHIN_MS = 10_000;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Mounts the request query against an instance whose change runs for `runningReads` reads of
 * `apr_1`; other requests run for good. Reads after `failingAfter` reads fail.
 */
async function mountRequest(input: {
  refetchIntervalMs: number | undefined;
  runningReads: number;
  decidedAt: string;
  failingAfter?: number;
}) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const reads: string[] = [];
  /** Every read, as the id of the request it asked for. */
  const asked: string[] = [];
  const fetchImpl: typeof fetch = async (url) => {
    const requestId = String(url).split("/").pop() ?? "";
    asked.push(requestId);
    if (asked.length > (input.failingAfter ?? Number.POSITIVE_INFINITY)) {
      reads.push("failed");
      return Response.json({ error: { code: "INTERNAL", message: "down" } }, { status: 500 });
    }
    const execution =
      requestId !== "apr_1" || reads.length < input.runningReads ? "queued" : "done";
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
  const seen: { execution: unknown; state?: ApprovalRequestState } = { execution: undefined };
  function Probe({ requestId }: { requestId: string }) {
    const query = useApprovalRequestQuery({
      apiBaseUrl: URL_OF_INSTANCE,
      authScope: "settling-test",
      client,
      requestId,
      ...(input.refetchIntervalMs === undefined
        ? {}
        : { refetchIntervalMs: input.refetchIntervalMs })
    });
    seen.execution = query.data?.applyResult?.execution;
    seen.state = approvalRequestState(query);
    return null;
  }
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  const show = (requestId: string) =>
    act(async () => {
      root.render(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, { requestId })
        )
      );
    });
  await show("apr_1");
  const shows = (execution: string) =>
    vi.waitFor(() => expect(seen.execution).toBe(execution), { timeout: SETTLES_WITHIN_MS });
  return { reads, asked, seen, show, shows, unmount: () => act(() => root.unmount()) };
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
    expect(mounted.seen.state).not.toHaveProperty("onRefresh");
    await mounted.unmount();
  }, 20_000);

  it("stops asking soon after a while, keeps the last state and offers a refresh", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const mounted = await mountRequest({
      refetchIntervalMs: undefined,
      runningReads: Number.POSITIVE_INFINITY,
      decidedAt: new Date().toISOString()
    });
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

    // Ten minutes at the short cadence would be 300 reads.
    await advance(10 * 60_000);
    const stoppedAt = mounted.reads.length;
    expect(stoppedAt).toBeGreaterThan(2);
    expect(stoppedAt).toBeLessThan(100);
    await advance(10 * 60_000);
    expect(mounted.reads).toHaveLength(stoppedAt);
    expect(mounted.seen.execution).toBe("queued");
    const state = mounted.seen.state;
    expect(state).toMatchObject({ status: "ready" });
    if (state?.status !== "ready" || !state.onRefresh) {
      throw new Error("A stopped request offers a refresh.");
    }

    // A refresh asks once and does not start the short cadence over.
    await act(async () => state.onRefresh?.());
    await advance(60_000);
    expect(mounted.reads).toHaveLength(stoppedAt + 1);
    expect(mounted.seen.state).toHaveProperty("onRefresh");
    await mounted.unmount();
  });

  it("stops at once when a read of a running change fails, and keeps the last state", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const mounted = await mountRequest({
      refetchIntervalMs: 60_000,
      runningReads: Number.POSITIVE_INFINITY,
      decidedAt: new Date().toISOString(),
      failingAfter: 2
    });
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

    // Two reads find it running; the third fails with its two retries, then nothing is asked.
    await advance(30_000);
    expect(mounted.reads).toEqual(["queued", "queued", "failed", "failed", "failed"]);
    await advance(10 * 60_000);
    expect(mounted.reads).toHaveLength(5);
    expect(mounted.seen.execution).toBe("queued");
    expect(mounted.seen.state).toMatchObject({ status: "ready" });
    expect(mounted.seen.state).toHaveProperty("onRefresh");
    await mounted.unmount();
  });

  it("counts the two minutes for each request on its own when the page switches between them", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    const mounted = await mountRequest({
      refetchIntervalMs: undefined,
      runningReads: Number.POSITIVE_INFINITY,
      decidedAt: new Date().toISOString()
    });
    const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
    const readsOf = (requestId: string) => mounted.asked.filter((id) => id === requestId).length;

    await advance(5 * 60_000);
    const firstStoppedAt = readsOf("apr_1");
    expect(mounted.seen.state).toHaveProperty("onRefresh");

    // The second request starts its own two minutes, not the first one's spent ones.
    await mounted.show("apr_2");
    await advance(60_000);
    expect(readsOf("apr_2")).toBeGreaterThan(20);
    expect(mounted.seen.state).not.toHaveProperty("onRefresh");

    // Back to the first: read once on showing it, then it stays stopped with its refresh.
    await mounted.show("apr_1");
    await advance(30_000);
    expect(readsOf("apr_1")).toBe(firstStoppedAt + 1);
    expect(mounted.seen.state).toHaveProperty("onRefresh");

    // And the second keeps its own deadline: half a minute was left of it.
    await mounted.show("apr_2");
    const secondBefore = readsOf("apr_2");
    await advance(5 * 60_000);
    expect(readsOf("apr_2") - secondBefore).toBeGreaterThan(5);
    expect(readsOf("apr_2") - secondBefore).toBeLessThan(25);
    expect(mounted.seen.state).toHaveProperty("onRefresh");
    await mounted.unmount();
  });
});
