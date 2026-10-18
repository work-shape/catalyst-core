import { createElement } from "react";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "@work-shape/catalyst-api-client";
import { startNewAgent } from "@work-shape/catalyst-chat-ui/agents";
import {
  openConnectionDraft,
  readConnectionDraft,
  requestedBuildStart,
  type ConnectionDraft
} from "@work-shape/catalyst-chat-ui/build-area";
import { renderToStaticMarkup } from "./chat-ui-render-harness";
import {
  endShellSession,
  finishSessionChange,
  isRecentlyActiveAssistantRunId,
  personIdIn,
  rememberRecentlyActiveAssistantRunId,
  sessionMark,
  sessionStillOn,
  shellSessionFor,
  showsWorkspace,
  useDraftForNewConnection,
  type ShellSession
} from "./support/chat-ui";

// ACCEPT-FIX-1 F3: a person who signs out, or whose browser signs in as somebody else, leaves
// nothing behind in the shell: not what they read, not an upload notice, not a draft. The shell
// starts a new session, with a new cache and the workspace mounted again. Fails without the
// change: the shell kept one cache and one workspace for every person of the tab.

const apiBaseUrl = "https://chat.example";
const meKey = ["me", apiBaseUrl];
const person = (id: string) => ({ id, displayLabel: id, roles: ["user"] });

function sessionOf(personId: string | undefined): ShellSession {
  const queryClient = new QueryClient();
  if (personId !== undefined) queryClient.setQueryData(meKey, person(personId));
  return { queryClient, personId, generation: 0 };
}

const nextFor = (session: ShellSession, personId: string | undefined) =>
  shellSessionFor(session, personId, apiBaseUrl, () => new QueryClient());

describe("the session of the shell", () => {
  it("reads the person signed in from the answer of /me, and nothing else", () => {
    expect(personIdIn(sessionOf("usr_a").queryClient, apiBaseUrl)).toBe("usr_a");
    expect(personIdIn(sessionOf(undefined).queryClient, apiBaseUrl)).toBeUndefined();
    const odd = new QueryClient();
    odd.setQueryData(meKey, { id: 7 });
    expect(personIdIn(odd, apiBaseUrl)).toBeUndefined();
  });

  it("stays while the person stays, and a first sign-in keeps what the sign-in page read", () => {
    const signedIn = sessionOf("usr_a");
    expect(nextFor(signedIn, "usr_a")).toBe(signedIn);

    const before = sessionOf(undefined);
    const after = nextFor(before, "usr_a");
    expect(after).toEqual({ queryClient: before.queryClient, personId: "usr_a", generation: 0 });
  });

  it("starts anew on a sign-out: a new cache, the workspace mounted again, the old cache ended", () => {
    const a = sessionOf("usr_a");
    a.queryClient.setQueryData(["conversations", apiBaseUrl], ["conv_private_of_a"]);

    const signedOut = nextFor(a, undefined);
    expect(signedOut.queryClient).not.toBe(a.queryClient);
    expect(signedOut.generation).toBe(1);
    expect(signedOut.ended).toBe(a.queryClient);
    expect(signedOut.queryClient.getQueryData(["conversations", apiBaseUrl])).toBeUndefined();
    expect(personIdIn(signedOut.queryClient, apiBaseUrl)).toBeUndefined();
  });

  it("starts anew when the browser is signed in as another person without a sign-out", () => {
    const a = sessionOf("usr_a");
    a.queryClient.setQueryData(["conversations", apiBaseUrl], ["conv_private_of_a"]);
    // A sign-in in another tab: the next answer of /me in this tab names B.
    a.queryClient.setQueryData(meKey, person("usr_b"));

    const b = nextFor(a, personIdIn(a.queryClient, apiBaseUrl));
    expect(b.generation).toBe(1);
    expect(b.ended).toBe(a.queryClient);
    expect(b.queryClient.getQueryData(["conversations", apiBaseUrl])).toBeUndefined();
    // The new session knows whom it shows, so it does not start again on its first read.
    expect(personIdIn(b.queryClient, apiBaseUrl)).toBe("usr_b");
    expect(nextFor(b, "usr_b")).toBe(b);
  });

  it("ends the cache and the stores outside React of the session before", () => {
    const a = sessionOf("usr_a");
    a.queryClient.setQueryData(["conversations", apiBaseUrl], ["conv_private_of_a"]);
    startNewAgent(() => undefined, { name: "a_private_agent", title: "Private" });
    expect(requestedBuildStart("agents")).toBeDefined();

    rememberRecentlyActiveAssistantRunId("run_of_a");

    endShellSession(a.queryClient);
    expect(a.queryClient.getQueryData(["conversations", apiBaseUrl])).toBeUndefined();
    expect(requestedBuildStart("agents")).toBeUndefined();
    expect(isRecentlyActiveAssistantRunId("run_of_a")).toBe(false);
  });

  it("ends a cache once: ending it again leaves the session after alone", async () => {
    const a = sessionOf("usr_a");
    endShellSession(a.queryClient);

    const markOfB = sessionMark();
    await openConnectionDraft(draftOf("b_kept_api"), hostAnswering(undefined));
    startNewAgent(() => undefined, { name: "b_agent", title: "B" });

    // As StrictMode runs the effect again, or a late caller ends A once more.
    endShellSession(a.queryClient);
    expect(sessionStillOn(markOfB)).toBe(true);
    expect(newConnectionDraft()).toBe("b_kept_api");
    expect(requestedBuildStart("agents")).toBeDefined();
    endShellSession(sessionOf("usr_b").queryClient);
  });

  it("names nobody once /me is refused with 401, and keeps the person on other failures", async () => {
    const refusedWith = async (failure: Error) => {
      const queryClient = new QueryClient();
      queryClient.setQueryData(meKey, person("account-a"));
      await expect(
        queryClient.fetchQuery({
          queryKey: meKey,
          queryFn: () => Promise.reject(failure)
        })
      ).rejects.toBe(failure);
      // React Query keeps the answer before beside the error.
      expect(queryClient.getQueryData(meKey)).toEqual(person("account-a"));
      return personIdIn(queryClient, apiBaseUrl);
    };

    expect(await refusedWith(new ApiError(401, "Sign in again.", undefined))).toBeUndefined();
    expect(await refusedWith(new ApiError(503, "Unavailable.", undefined))).toBe("account-a");
    expect(await refusedWith(new ApiError(500, "Broken.", undefined))).toBe("account-a");
    expect(await refusedWith(new TypeError("Failed to fetch"))).toBe("account-a");
  });

  it("starts anew when /me of the person signed in is refused with 401", async () => {
    const a = sessionOf("usr_a");
    await a.queryClient
      .fetchQuery({
        queryKey: meKey,
        queryFn: () => Promise.reject(new ApiError(401, "Sign in again.", undefined))
      })
      .catch(() => undefined);

    const signedOut = nextFor(a, personIdIn(a.queryClient, apiBaseUrl));
    expect(signedOut.ended).toBe(a.queryClient);
    expect(signedOut.personId).toBeUndefined();
    endShellSession(a.queryClient);
  });

  it("shows no workspace until the session before has ended, so the new one starts empty", async () => {
    const a = sessionOf("usr_a");
    startNewAgent(() => undefined, { name: "a_private_agent", title: "Private" });
    await openConnectionDraft(draftOf("a_private_api"), hostAnswering(undefined));
    expect(newConnectionDraft()).toBe("a_private_api");

    const b = nextFor(a, "usr_b");
    // Between the two steps the stores still hold A's: no workspace may mount and read them.
    expect(showsWorkspace(b)).toBe(false);
    expect(requestedBuildStart("agents")).toBeDefined();

    const shown = finishSessionChange(b);
    expect(showsWorkspace(shown)).toBe(true);
    expect(shown).toEqual({ queryClient: b.queryClient, personId: "usr_b", generation: 1 });
    // The workspace that mounts now starts its New connection dialog and agent page empty.
    expect(requestedBuildStart("agents")).toBeUndefined();
    expect(newConnectionDraft()).toBe("none");
    expect(finishSessionChange(shown)).toBe(shown);
  });

  it("drops a draft whose read was still on its way when the person changed", async () => {
    let answer: (type: string | undefined) => void = () => undefined;
    const calls: string[] = [];
    const opening = openConnectionDraft(draftOf("a_late_api"), {
      connectorTypeOf: () =>
        new Promise<string | undefined>((resolve) => {
          answer = resolve;
        }),
      showConnection: (name) => calls.push(`show ${name ?? "list"}`),
      requestCreateDialog: () => calls.push("dialog")
    });

    endShellSession(sessionOf("usr_a").queryClient);
    answer(undefined);

    expect(await opening).toBe("failed");
    expect(calls).toEqual([]);
    expect(newConnectionDraft()).toBe("none");
    // A draft opened in the session after still opens.
    expect(await openConnectionDraft(draftOf("b_api"), hostAnswering(undefined))).toBe("opened");
    expect(newConnectionDraft()).toBe("b_api");
    endShellSession(sessionOf("usr_b").queryClient);
  });
});

function draftOf(name: string): ConnectionDraft {
  const draft = readConnectionDraft({
    output: {
      connection: { name, title: name, baseUrl: "https://api.example.test", headerNames: [] },
      operations: [{ name: "list_items", title: "List items", method: "GET", path: "/items" }]
    }
  });
  if (!draft) throw new Error("The test's draft does not read.");
  return draft;
}

function hostAnswering(type: string | undefined) {
  return {
    connectorTypeOf: async () => type,
    showConnection: () => undefined,
    requestCreateDialog: () => undefined
  };
}

/** The draft a New connection dialog mounted now would start with. */
function newConnectionDraft(): string {
  function Probe() {
    return useDraftForNewConnection()?.connection.name ?? "none";
  }
  return renderToStaticMarkup(createElement(Probe));
}
