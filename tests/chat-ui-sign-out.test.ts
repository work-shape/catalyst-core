// @vitest-environment happy-dom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import {
  useWorkspaceApiClient,
  WorkspaceApiClientProvider
} from "@work-shape/catalyst-chat-ui/workspace-api-client";
import { useWorkspaceSignOutMutation } from "./support/chat-ui";
import { required } from "./support/assertions";

const apiBaseUrl = "https://chat.example";
const person = {
  id: "usr_a",
  externalUserId: "external_a",
  displayLabel: "A",
  roles: [],
  permissionRefs: [],
  permissions: [],
  clientInstanceId: "instance",
  authSource: "test"
};
let root: Root | undefined;
let queryClient: QueryClient | undefined;

afterEach(async () => {
  await act(() => root?.unmount());
  queryClient?.clear();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mountSession(readOnMount = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  cache.setQueryData(["me", apiBaseUrl], person);
  queryClient = cache;
  const signedOut = vi.fn();
  let current:
    | {
        api: ReturnType<typeof useWorkspaceApiClient>;
        signOut: ReturnType<typeof useWorkspaceSignOutMutation>;
      }
    | undefined;
  function Probe() {
    const api = useWorkspaceApiClient();
    useQuery({
      queryKey: ["mounted-read"],
      queryFn: () => api.client.me.get(),
      enabled: readOnMount,
      retry: false
    });
    current = {
      api,
      signOut: useWorkspaceSignOutMutation({ apiBaseUrl, onSignedOut: signedOut })
    };
    return null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(() =>
    root?.render(
      createElement(
        StrictMode,
        null,
        createElement(
          QueryClientProvider,
          { client: cache },
          createElement(WorkspaceApiClientProvider, { apiBaseUrl, children: createElement(Probe) })
        )
      )
    )
  );
  return { current: () => required(current), cache, signedOut };
}

it("resumes reads after a failed sign-out without forgetting the person", async () => {
  const failure = new TypeError("offline");
  const fetchImpl = vi.fn(async (resource: string | URL | Request) => {
    if (String(resource).endsWith("/sign-out")) throw failure;
    return Response.json(person);
  });
  vi.stubGlobal("fetch", fetchImpl);
  const session = await mountSession();

  await act(async () => {
    await expect(session.current().signOut.mutateAsync()).rejects.toBe(failure);
  });

  expect(session.signedOut).not.toHaveBeenCalled();
  expect(session.cache.getQueryData(["me", apiBaseUrl])).toEqual(person);
  await expect(session.current().api.client.me.get()).resolves.toEqual(person);
});

it("aborts the session's reads on unmount and preserves a caller's cancellation", async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    "fetch",
    (_resource: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        const signal = required(init?.signal);
        signals.push(signal);
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })
  );
  const session = await mountSession();
  const caller = new AbortController();
  const first = session
    .current()
    .api.client.me.get({ signal: caller.signal })
    .catch(() => undefined);
  const second = session
    .current()
    .api.client.me.get()
    .catch(() => undefined);
  await vi.waitFor(() => expect(signals).toHaveLength(2), { timeout: 5_000 });

  caller.abort();
  expect(signals[0]?.aborted).toBe(true);
  expect(signals[1]?.aborted).toBe(false);
  await act(() => root?.unmount());
  root = undefined;
  expect(signals[1]?.aborted).toBe(true);
  await Promise.all([first, second]);
  // A late callback retaining the old client cannot send another request.
  await expect(session.current().api.client.me.get()).rejects.toBeDefined();
  expect(signals).toHaveLength(2);
});

it("keeps a mounted session readable through React StrictMode's unmount rehearsal", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(person))
  );
  const session = await mountSession(true);
  await act(async () => {
    await vi.waitFor(() => expect(session.cache.getQueryData(["mounted-read"])).toEqual(person), {
      timeout: 5_000
    });
  });
});
