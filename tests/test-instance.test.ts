import { describe, expect, it, vi } from "vitest";
import { asClientInstanceId } from "@vivd-catalyst/core";
import { createTestInstance } from "./support/test-instance";
import { createTestConfig, seedConversationMessage } from "./support/fixtures";

const identities = ["owner", "other"].map((id) => ({
  id,
  externalUserId: id,
  displayLabel: id,
  roles: ["user"],
  permissionRefs: []
}));
const config = () =>
  createTestConfig({
    developmentAuth: { enabled: true, users: identities, defaultUserId: "owner" }
  });

describe("test instance", () => {
  it("exposes four capabilities and isolates identities and stores between instances", async () => {
    const first = await createTestInstance({ config: config(), tools: [] });
    const second = await createTestInstance({ config: config(), tools: [] });
    expect(Object.keys(first).sort()).toEqual(["call", "close", "signIn", "stores"]);
    const owner = first.signIn("owner");
    const other = first.signIn("other");
    const created = await first.call(
      "createConversation",
      { payload: { title: "Owner's conversation" } },
      owner
    );
    expect(created.statusCode).toBe(200);
    const { id } = created.json<{ id: string }>();
    await seedConversationMessage(first.stores.conversations, id);
    expect(
      (await first.call("getConversationThread", { params: { conversationId: id } }, other))
        .statusCode
    ).toBe(404);
    expect(
      (await first.call("getConversationThread", { params: { conversationId: id } }, owner))
        .statusCode
    ).toBe(200);
    expect(
      (
        await second.call(
          "getConversationThread",
          { params: { conversationId: id } },
          second.signIn("owner")
        )
      ).statusCode
    ).toBe(404);
    expect((await first.call("listConversations", {}, owner)).json()).toHaveLength(1);
    expect((await first.call("listConversations", {}, other)).json()).toHaveLength(0);
    await first.close();
    expect((await second.call("getCurrentUser")).statusCode).toBe(200);
    await second.close();
  });

  it("preserves malformed input, statuses, headers and raw response bytes", async () => {
    const instance = await createTestInstance({
      config: config(),
      tools: [],
      allowedOrigins: "https://ui.example.test"
    });
    const malformed = await instance.call("createConversation", {
      payload: "{",
      headers: { "content-type": "application/json" }
    });
    expect(malformed.statusCode).toBe(500);
    expect(malformed.json()).toMatchObject({ error: { code: "INTERNAL" } });
    const response = await instance.call("getCurrentUser", {
      headers: { origin: "https://ui.example.test" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("https://ui.example.test");
    expect(response.rawPayload.toString()).toBe(response.body);
    const head = await instance.call("getCurrentUser", { method: "HEAD" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    await instance.close();
  });

  it.each([false, true])(
    "cleans resources after a successful or failed call (failure: %s)",
    async (failure) => {
      const cleanup = vi.fn(async () => {});
      const instance = await createTestInstance({
        config: config(),
        tools: [],
        capabilities: [
          {
            name: "cleanup-test",
            create() {
              return { close: cleanup };
            }
          }
        ]
      });
      try {
        if (failure)
          await expect(instance.call("getConversationThread")).rejects.toThrow(
            "Missing path parameter"
          );
        else expect((await instance.call("getCurrentUser")).statusCode).toBe(200);
      } finally {
        await instance.close();
      }
      await instance.close();
      expect(cleanup).toHaveBeenCalledTimes(1);
      await expect(instance.call("getCurrentUser")).rejects.toThrow("Test instance is closed");
      expect(() => instance.signIn("owner")).toThrow("Test instance is closed");
    }
  );

  it("gives store-only fixtures independent state and safe repeated cleanup", async () => {
    const first = createTestInstance();
    const second = createTestInstance();
    const clientInstanceId = asClientInstanceId("store-only");
    await first.stores.users.createUser({ clientInstanceId, displayLabel: "Only in first" });
    expect(await first.stores.users.listUsers({ clientInstanceId })).toHaveLength(1);
    expect(await second.stores.users.listUsers({ clientInstanceId })).toEqual([]);
    await first.close();
    await first.close();
    await second.close();
  });
});
