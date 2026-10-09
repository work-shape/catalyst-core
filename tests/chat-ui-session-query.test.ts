import { describe, expect, it } from "vitest";
import { createApiClient, type ApiClient } from "@vivd-catalyst/api-client";
import { getCurrentUserWithinDeadline } from "../packages/chat-ui/src/api/workspace-queries";

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
