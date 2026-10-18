import type { Logger } from "@work-shape/catalyst-core";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  const error = vi.fn();
  const logger: Logger = { debug() {}, info() {}, warn() {}, error, child: () => logger };
  const t = await setupAccessInstance({
    server: () => ({ logger }),
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
  return { t, executed: () => executed, error };
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

  it.each(["name", "id", "empty-asset-id"] as const)(
    "checks kind-level rights before revealing an absent %s resource",
    async (shape) => {
      const { t, executed, error } = await ready(shape);
      await t.putAgent(t.admin.id, "existing");
      for (const language of ["en", "de"]) {
        const call = (userId: string, itemId: string) =>
          t.call(userId, "testRunRead", {
            params: { itemId },
            headers: { "accept-language": language }
          });
        const existing = await call(t.lena.id, "existing");
        const absent = await call(t.lena.id, "absent");
        expect(existing.statusCode).toBe(403);
        expect(absent.statusCode).toBe(403);
        const { correlationId: _existing, ...existingError } = existing.json().error;
        const { correlationId: _absent, ...absentError } = absent.json().error;
        expect(absentError).toEqual(existingError);
        expect(absentError).toMatchObject({
          code: "FORBIDDEN",
          details: { action: "agent.read", reason: "no_grant" }
        });
        const allowed = await call(t.admin.id, "absent");
        expect(allowed.statusCode).toBe(404);
        expect(allowed.json()).toMatchObject({
          error: { code: "NOT_FOUND", message: "Config agent 'absent' was not found" }
        });
      }
      expect(executed()).toBe(0);
      expect(error).not.toHaveBeenCalled();
    }
  );
});
