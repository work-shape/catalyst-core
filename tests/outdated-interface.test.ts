import { createApiClient } from "@vivd-catalyst/api-client";
import { UNKNOWN_OPERATION_REASON } from "@vivd-catalyst/api-contract";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { callTestPath, createTestInstance, type TestInstance } from "./support/test-instance";
import { retiredApiPaths } from "./support/retired-api-paths";

// A tab that stays open across an upgrade calls paths the server no longer knows. The server
// marks that answer, the client reports it once per call, and the interface shows one notice,
// which `chat-ui-workspace-status.test.ts` renders.

function notFound(details?: unknown): Response {
  return Response.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "Operation is not available",
        correlationId: "req-1",
        ...(details === undefined ? {} : { details })
      }
    },
    { status: 404 }
  );
}

function clientAnswering(response: () => Response) {
  const onUnknownOperation = vi.fn();
  const client = createApiClient({
    baseUrl: "https://catalyst.example.test",
    getToken: () => "token",
    fetchImpl: () => Promise.resolve(response()),
    onUnknownOperation
  });
  return { client, onUnknownOperation };
}

describe("an interface older than its server", () => {
  let instance: TestInstance;
  beforeAll(async () => {
    instance = await createTestInstance();
  });

  it("is told that a retired path is no operation of the server", async () => {
    const [method, path] = retiredApiPaths[0] ?? ["GET", ""];
    const retired = await callTestPath(instance, method, path, { "x-dev-user-id": "superadmin" });
    expect(retired.statusCode).toBe(404);
    expect(retired.json()).toMatchObject({
      error: { code: "NOT_FOUND", details: { reason: UNKNOWN_OPERATION_REASON } }
    });
  });

  it("is not told so for an operation the instance runs without", async () => {
    // This instance captures no mail, so the development listing is not registered.
    const unavailable = await instance.call("captured_mail.list");
    expect(unavailable.statusCode).toBe(404);
    expect(unavailable.json()).not.toHaveProperty("error.details");
  });

  it("reports the marked answer and no other 404", async () => {
    const outdated = clientAnswering(() => notFound({ reason: UNKNOWN_OPERATION_REASON }));
    await expect(outdated.client.me.get()).rejects.toMatchObject({ status: 404 });
    expect(outdated.onUnknownOperation).toHaveBeenCalledTimes(1);

    const missing = clientAnswering(() => notFound());
    await expect(missing.client.me.get()).rejects.toMatchObject({ status: 404 });
    expect(missing.onUnknownOperation).not.toHaveBeenCalled();
  });
});
