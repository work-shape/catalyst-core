import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  ApiResponseShapeError,
  createApiClient,
  type ApiClient
} from "@vivd-catalyst/api-client";
import {
  getCurrentUserWithinDeadline,
  workspaceConfigQueryOptions
} from "../packages/chat-ui/src/api/workspace-queries";

describe("workspace session query", () => {
  it("aborts the current-user request when its deadline expires", async () => {
    let requestSignal: AbortSignal | undefined;
    const client = {
      me: {
        get: (input?: { signal?: AbortSignal }) => {
          requestSignal = input?.signal;
          return rejectWhenAborted(input?.signal);
        }
      }
    } as { me: Pick<ApiClient["me"], "get"> };

    await expect(
      getCurrentUserWithinDeadline(client, new AbortController().signal, 1)
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("forwards caller cancellation to the current-user request", async () => {
    const queryController = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const client = {
      me: {
        get: (input?: { signal?: AbortSignal }) => {
          requestSignal = input?.signal;
          return rejectWhenAborted(input?.signal);
        }
      }
    } as { me: Pick<ApiClient["me"], "get"> };

    const request = getCurrentUserWithinDeadline(client, queryController.signal, 60_000);
    queryController.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("passes the signal through the API client to fetch", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const client = createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: async (input, init) => {
        requestSignal = (input instanceof Request ? input : new Request(input, init)).signal;
        return Response.json({
          id: "user_1",
          externalUserId: "external_user_1",
          displayLabel: "Test user",
          roles: [],
          permissionRefs: [],
          permissions: [],
          clientInstanceId: "client_1",
          authSource: "test"
        });
      }
    });

    await client.me.get({ signal: controller.signal });
    expect(requestSignal?.aborted).toBe(false);

    controller.abort();
    expect(requestSignal?.aborted).toBe(true);
  });
});

function rejectWhenAborted(signal: AbortSignal | undefined): ReturnType<ApiClient["me"]["get"]> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error("Expected an AbortSignal"));
      return;
    }
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

const colors = {
  accentColor: "#111111",
  accentStrongColor: "#111111",
  backgroundColor: "#ffffff",
  surfaceColor: "#ffffff",
  textColor: "#111111",
  mutedTextColor: "#555555",
  borderColor: "#dddddd"
};
const localization = { locale: "en", defaultLocale: "en", supportedLocales: ["en", "de"] };

/** An instance configuration as a server of this release answers it. */
function configurationAnswer() {
  return {
    clientInstance: { id: "instance", displayName: "Instance", environment: "production" },
    localization,
    retention: {
      conversationDays: 30,
      expireConversations: false,
      auditDays: 90,
      allowUserDelete: true
    },
    usage: { safeguards: {} },
    views: { allowedScriptSrc: ["https://views.example"] },
    features: {
      attachments: { enabled: true, accept: ".pdf" },
      resources: { enabled: true },
      configAssets: { enabled: true, editableAgentFields: ["displayName"] },
      userInvitations: { enabled: true }
    },
    agents: [],
    ui: {
      localization,
      clientName: "Instance",
      logoInvertOnDark: false,
      title: "Instance",
      welcomeMessage: "Welcome",
      showAgentName: true,
      showAgentDescriptions: false,
      accentColor: "#111111",
      theme: colors,
      darkTheme: colors,
      defaultThemeMode: "system"
    }
  };
}

function configQueryAnswering(answers: (() => Response)[]) {
  let requests = 0;
  const options = workspaceConfigQueryOptions({
    apiBaseUrl: "https://chat.example",
    authScope: "test",
    client: createApiClient({
      baseUrl: "https://chat.example",
      fetchImpl: async () => {
        const answer = answers[Math.min(requests, answers.length - 1)];
        requests += 1;
        if (!answer) throw new Error("no answer prepared");
        return answer();
      }
    }),
    localePreference: undefined,
    enabled: true
  });
  return { ...options, requests: () => requests };
}

async function failureOf(load: () => Promise<unknown>): Promise<unknown> {
  try {
    await load();
  } catch (error) {
    return error;
  }
  throw new Error("The load did not fail.");
}

describe("loading the instance configuration", () => {
  it("fails on a shape it cannot work with and logs the paths once, without values", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const query = configQueryAnswering([
        () =>
          Response.json({
            ...configurationAnswer(),
            clientInstance: { id: "instance-secret", displayName: 7 },
            agents: "agents-secret"
          })
      ]);

      const error = await failureOf(query.queryFn);

      expect(error).toBeInstanceOf(ApiResponseShapeError);
      expect(error).toHaveProperty("paths", [
        "clientInstance.displayName",
        "clientInstance.environment",
        "agents"
      ]);
      expect(query.retry(0, error)).toBe(false);
      expect(query.requests()).toBe(1);
      expect(logged.mock.calls).toEqual([
        [
          "The instance configuration does not fit this interface at: " +
            "clientInstance.displayName, clientInstance.environment, agents"
        ]
      ]);
      expect(String(error)).not.toContain("secret");
    } finally {
      logged.mockRestore();
    }
  });

  it("drops a key it does not know", async () => {
    const answer = configurationAnswer();
    const query = configQueryAnswering([
      () =>
        Response.json({
          ...answer,
          addedByALaterRelease: { anything: true },
          features: { ...answer.features, addedByALaterRelease: true }
        })
    ]);

    const config = await query.queryFn();

    expect(config).not.toHaveProperty("addedByALaterRelease");
    expect(config.features).not.toHaveProperty("addedByALaterRelease");
    expect(config.features.attachments).toEqual({ enabled: true, accept: ".pdf" });
  });

  it("takes the schema default for a missing key that has one", async () => {
    const { views: _views, features, ...answer } = configurationAnswer();
    const { userInvitations: _userInvitations, ...olderFeatures } = features;
    const query = configQueryAnswering([
      () => Response.json({ ...answer, features: olderFeatures })
    ]);

    const config = await query.queryFn();

    expect(config.views).toEqual({ allowedScriptSrc: [] });
    expect(config.features.userInvitations).toEqual({ enabled: false });
    expect(config.features.configAssets.allowAgentCreation).toBe(false);
    expect(config.features.configAssets.agentSkillChanges).toEqual({
      enabled: false,
      allowSkillCreation: false
    });
  });

  it("asks again after a network failure and loads on the next answer", async () => {
    const query = configQueryAnswering([
      () => {
        throw new TypeError("Failed to fetch");
      },
      () => Response.json(configurationAnswer())
    ]);

    const error = await failureOf(query.queryFn);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toHaveProperty("status", 0);
    expect(query.retry(0, error)).toBe(true);
    expect((await query.queryFn()).clientInstance.id).toBe("instance");
    expect(query.requests()).toBe(2);
  });

  it("asks again a few times for a 5xx and never for a refusal", () => {
    const { retry } = configQueryAnswering([]);
    const unavailable = new ApiError(503, "unavailable", undefined);
    expect(retry(0, unavailable)).toBe(true);
    expect(retry(2, unavailable)).toBe(true);
    expect(retry(3, unavailable)).toBe(false);
    expect(retry(0, new ApiError(401, "sign in", undefined))).toBe(false);
    expect(retry(0, new ApiError(403, "forbidden", undefined))).toBe(false);
  });
});
