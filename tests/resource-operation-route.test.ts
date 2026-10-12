import { describe, expect, it } from "vitest";
import {
  registeredTestOperations,
  resourceRouteTestOperations as operations
} from "./support/operations";
import { clientInstanceId, createServer, errorOf, person } from "./support/operation-server";
import type { TestRoute } from "./support/test-instance";

// One name per act. The route of a family of per-resource operations runs the resource's own
// operation, so the policy, the run and the audit trail carry the name an agent and a
// Workflow step call. Each test fails with a route bound to its own `execute`: the call then
// ran as `test_boxes.read`, a second name for the same act that no setting on
// `test_box.red.read` reached.

async function serverWith(settings: Parameters<typeof createServer>[0] = {}) {
  const read: string[] = [];
  const created = await createServer({
    ...settings,
    register(route: TestRoute) {
      route.operation(operations.testBoxRedRead, {
        recordsEveryCall: true,
        resource: () => ({ kind: "test_box", id: "red" }),
        execute: ({ shelf }) => {
          read.push(shelf);
          return Promise.resolve({ box: "red", shelf });
        }
      });
      route.resourceOperation(operations.testBoxesRead, {
        target: ({ box, shelf }) => ({ operation: `test_box.${box}.read`, input: { shelf } }),
        notFound: "The box is not available"
      });
    }
  });
  const call = (box: string) =>
    created.server.call("testBoxesRead", { params: { box }, payload: { shelf: "top" } }, person());
  const auditOperations = async () => {
    const events = await created.server.stores.audit.listAuditEvents({ clientInstanceId });
    return events.flatMap((event) =>
      typeof event.metadata?.operation === "string" ? [event.metadata.operation] : []
    );
  };
  return { ...created, read, call, auditOperations };
}

describe("the route of a family of per-resource operations", () => {
  it("runs the resource's operation, and the run and the audit carry that name", async () => {
    const t = await serverWith();
    const response = await t.call("red");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ box: "red", shelf: "top" });
    expect(t.read).toEqual(["top"]);

    expect((await t.runs()).map((run) => run.operation)).toEqual(["test_box.red.read"]);
    const named = await t.auditOperations();
    expect(named).toContain("test_box.red.read");
    expect(named).not.toContain("test_boxes.read");
  });

  it("is refused by a policy set on the resource's operation", async () => {
    const t = await serverWith({
      settings: [{ operation: "test_box.red.read", value: "deny" }]
    });
    const response = await t.call("red");
    expect(response.statusCode, response.body).toBe(403);
    expect(errorOf(response).code).toBe("POLICY_DENIED");
    expect(t.read).toEqual([]);
    expect(await t.auditOperations()).toContain("test_box.red.read");
    expect(await t.auditOperations()).not.toContain("test_boxes.read");
  });

  it("is untouched by a policy on the route's own name, which is no operation", async () => {
    const t = await serverWith({ settings: [{ operation: "test_boxes.read", value: "deny" }] });
    expect((await t.call("red")).statusCode).toBe(200);
  });

  it("answers a resource that has no such operation with the binding's sentence", async () => {
    const t = await serverWith();
    const response = await t.call("blue");
    expect(response.statusCode, response.body).toBe(404);
    expect(errorOf(response).message).toBe("The box is not available");
    expect(await t.runs()).toEqual([]);
  });

  it("refuses a route that names a right of its own", async () => {
    await expect(
      createServer({
        register(route: TestRoute) {
          // The right is the resource operation's: a second one on the route is a second rule.
          route.resourceOperation(registeredTestOperations.testRunRead, {
            target: ({ itemId }) => ({ operation: `test_item.${itemId}.read`, input: {} }),
            notFound: "The item is not available"
          });
        }
      }).then((created) => created.server.call("health.get"))
    ).rejects.toThrow("names no right");
  });
});
