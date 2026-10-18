import { afterEach, describe, expect, it } from "vitest";
import {
  clientInstanceId,
  setupAccessInstance,
  type AccessInstance
} from "./support/access-instance";
import { registeredTestOperations } from "./support/operations";

// Exercise `requires` through HTTP, with a resource builder that omitted the stored identity.
const read = {
  ...registeredTestOperations.testRunRead,
  requires: ["agent.read"] as const
};
let open: AccessInstance | undefined;
afterEach(async () => {
  await open?.instance.close();
  open = undefined;
});

async function ready(shape: "name" | "id" | "empty-asset-id") {
  let executed = 0;
  const t = await setupAccessInstance({
    register(route) {
      route.operation(read, {
        resource: ({ itemId }) => ({
          kind: "agent",
          id: itemId,
          ...(shape === "id" ? {} : { name: itemId }),
          ...(shape === "empty-asset-id" ? { assetId: "" } : {})
        }),
        execute: ({ itemId }) => {
          executed += 1;
          return Promise.resolve({ itemId });
        }
      });
    }
  });
  open = t;
  return { t, executed: () => executed };
}

describe("the identity of an asset a declared operation right is checked on", () => {
  it.each(["name", "id", "empty-asset-id"] as const)(
    "resolves %s before authorization, including after deletion",
    async (shape) => {
      const { t, executed } = await ready(shape);
      await t.putAgent(t.admin.id, "restricted");
      const assetId = await t.assetId("agent", "restricted");
      for (const user of [t.kai, t.lena])
        await t.stores.access.createGrant({
          clientInstanceId,
          holderKind: "user",
          holderId: user.id,
          action: "agent.read",
          effect: "allow",
          scopeKind: "instance",
          grantedBy: t.admin.id
        });
      await t.grant(t.kai.id, "agent.read", { assetId }, "deny");
      for (const deleted of [false, true]) {
        if (deleted)
          await t.expectOk(t.admin.id, "assets.delete", {
            params: { kind: "agent", name: "restricted" },
            payload: { expectedRevision: 1 }
          });
        await t.expectRefused(
          t.kai.id,
          "testRunRead",
          { params: { itemId: "restricted" } },
          t.forbidden("agent.read", "denied")
        );
        expect(executed()).toBe(deleted ? 1 : 0);
        await t.expectOk(t.lena.id, "testRunRead", { params: { itemId: "restricted" } });
      }
      expect(executed()).toBe(2);
    }
  );

  it("fails closed when an asset resource cannot be resolved", async () => {
    const { t, executed } = await ready("name");
    const refused = await t.call(t.admin.id, "testRunRead", { params: { itemId: "absent" } });
    expect(refused.statusCode).toBe(500);
    expect(executed()).toBe(0);
  });
});
