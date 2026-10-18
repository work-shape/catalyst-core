import { MutationObserver, QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createApiClient, type ApiUser } from "@work-shape/catalyst-api-client";
import {
  chosenLocale,
  currentUserUpdateOptions,
  latestSavingLocale,
  savingLocaleFilters,
  workspaceQueryKeys
} from "./support/chat-ui";

// REH-900: the language a person picks is kept with their account, so the instance writes to
// them in it. Without an account choice the browser's choice stands, as before.

const BASE = "https://chat.example";

function user(id: string, locale?: "en" | "de"): ApiUser {
  return {
    id,
    externalUserId: `external_${id}`,
    displayLabel: id,
    roles: [],
    permissionRefs: [],
    permissions: [],
    clientInstanceId: "client_1",
    authSource: "test",
    ...(locale === undefined ? {} : { locale })
  };
}

/**
 * An instance whose saves of the account answer when the test lets them: each save waits
 * until `answer` is called for it, so the test decides the order the answers arrive in.
 */
function instance(userId: string) {
  const sent: string[] = [];
  const waiting: (() => void)[] = [];
  const client = createApiClient({
    baseUrl: BASE,
    fetchImpl: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const body: unknown = await request.json();
      const locale =
        typeof body === "object" && body !== null && "locale" in body ? body.locale : undefined;
      const chosen = locale === "de" || locale === "en" ? locale : undefined;
      sent.push(chosen ?? "none");
      await new Promise<void>((resolve) => waiting.push(resolve));
      return Response.json(user(userId, chosen));
    }
  });
  return { client, sent, answer: (index: number) => waiting[index]?.() };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function saves(
  queryClient: QueryClient,
  client: ReturnType<typeof instance>["client"],
  id: string
) {
  return new MutationObserver(
    queryClient,
    currentUserUpdateOptions(
      { apiBaseUrl: BASE, authScope: "workspace", client, userId: id },
      queryClient
    )
  );
}

describe("the language the interface asks for", () => {
  it("is the account's once a signed-in person chose one, over this browser's", () => {
    expect(chosenLocale({ saving: undefined, account: "de", stored: "en" })).toBe("de");
  });

  it("is the browser's where the account chose none, or nobody is signed in", () => {
    expect(chosenLocale({ saving: undefined, account: undefined, stored: "de" })).toBe("de");
    expect(chosenLocale({ saving: undefined, account: undefined, stored: undefined })).toBe(
      undefined
    );
  });

  it("is a choice still being saved, so the page does not flip back while it saves", () => {
    expect(chosenLocale({ saving: "en", account: "de", stored: "en" })).toBe("en");
  });

  it("is the latest of the choices still being saved, and a name save names none", () => {
    expect(latestSavingLocale([{ locale: "de" }, { displayLabel: "Mara" }, { locale: "en" }])).toBe(
      "en"
    );
    expect(latestSavingLocale([{ displayLabel: "Mara" }, undefined])).toBe(undefined);
  });
});

describe("saving the language to the account", () => {
  it("saves quick choices one after the other, so the last choice is the one kept", async () => {
    const queryClient = new QueryClient();
    const server = instance("usr_a");
    queryClient.setQueryData(workspaceQueryKeys.me(BASE), user("usr_a"));
    const first = saves(queryClient, server.client, "usr_a").mutate({ locale: "en" });
    const second = saves(queryClient, server.client, "usr_a").mutate({ locale: "de" });
    await settle();
    // The second waits for the first: only one was sent.
    expect(server.sent).toEqual(["en"]);
    // While both wait, the one shown is the last choice.
    const pending = queryClient
      .getMutationCache()
      .findAll(savingLocaleFilters(BASE, "usr_a"))
      .map((mutation) => mutation.state.variables);
    expect(latestSavingLocale(pending)).toBe("de");
    server.answer(0);
    await first;
    await settle();
    expect(server.sent).toEqual(["en", "de"]);
    server.answer(1);
    await second;
    expect(queryClient.getQueryData<ApiUser>(workspaceQueryKeys.me(BASE))?.locale).toBe("de");
  });

  it("never sends a save of an account that is no longer signed in, though it was queued", async () => {
    const queryClient = new QueryClient();
    const server = instance("usr_a");
    queryClient.setQueryData(workspaceQueryKeys.me(BASE), user("usr_a"));
    const first = saves(queryClient, server.client, "usr_a").mutate({ locale: "en" });
    const queued = saves(queryClient, server.client, "usr_a").mutate({ locale: "de" });
    await settle();
    expect(server.sent).toEqual(["en"]);
    // Another person signs in on this browser while the second save waits for the first.
    queryClient.setQueryData(workspaceQueryKeys.me(BASE), user("usr_b"));
    server.answer(0);
    await first;
    await expect(queued).rejects.toThrow();
    expect(server.sent).toEqual(["en"]);
    expect(queryClient.getQueryData<ApiUser>(workspaceQueryKeys.me(BASE))).toEqual(user("usr_b"));
  });

  it("leaves the next account's record and choice alone when an earlier one's save answers", async () => {
    const queryClient = new QueryClient();
    const server = instance("usr_a");
    queryClient.setQueryData(workspaceQueryKeys.me(BASE), user("usr_a"));
    const save = saves(queryClient, server.client, "usr_a").mutate({ locale: "de" });
    await settle();
    // Another person signs in on this browser while the save is under way.
    queryClient.setQueryData(workspaceQueryKeys.me(BASE), user("usr_b", "en"));
    const pendingOfB = queryClient
      .getMutationCache()
      .findAll(savingLocaleFilters(BASE, "usr_b"))
      .map((mutation) => mutation.state.variables);
    expect(latestSavingLocale(pendingOfB)).toBe(undefined);
    server.answer(0);
    await save;
    expect(queryClient.getQueryData<ApiUser>(workspaceQueryKeys.me(BASE))).toEqual(
      user("usr_b", "en")
    );
  });
});
