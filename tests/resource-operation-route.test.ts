import { describe, expect, it } from "vitest";
import {
  registeredTestOperations,
  resourceRouteTestOperations as operations
} from "./support/operations";
import { clientInstanceId, createServer, errorOf, person, right } from "./support/operation-server";
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
      route.operation(operations.testBoxGreenRead, {
        resource: () => ({ kind: "test_box", id: "green" }),
        execute: ({ shelf }) => {
          read.push(shelf);
          return Promise.resolve({ box: "green", shelf });
        }
      });
      for (const wrong of [operations.testBoxGreyRead, operations.testBoxPinkRead]) {
        route.operation(wrong, {
          resource: () => ({ kind: "test_box", id: "wrong" }),
          execute: ({ shelf }) => Promise.resolve({ box: "wrong", shelf })
        });
      }
      route.resourceOperation(operations.testBoxesRead, {
        target: ({ box, shelf }) => ({ operation: `test_box.${box}.read`, input: { shelf } }),
        right: "audit.view",
        notFound: "The box is not available"
      });
    }
  });
  const call = (box: string, as = person()) =>
    created.server.call("testBoxesRead", { params: { box }, payload: { shelf: "top" } }, as);
  const auditOperations = async () => {
    const events = await created.server.stores.audit.listAuditEvents({ clientInstanceId });
    return events.flatMap((event) =>
      typeof event.metadata?.operation === "string" ? [event.metadata.operation] : []
    );
  };
  return { ...created, read, call, auditOperations };
}

/** The headers of an answer without the one that names the request. */
const withoutCorrelation = (headers: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name !== "x-correlation-id"));

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
    // A read that fails is recorded, under the name that was called.
    expect((await t.runs()).map((run) => [run.operation, run.status])).toEqual([
      ["test_box.blue.read", "failed"]
    ]);
  });

  // Fails where an unknown id is answered beside the run path: both read 403, and only the id
  // that exists left a run and named it in a header, so the header told which ids exist.
  it("answers a caller without the right the same for an id that exists and one that does not", async () => {
    const t = await serverWith();
    const without = person({ permissions: right("users.manage") });
    const answerOf = async (box: string) => {
      const before = new Set((await t.runs()).map((run) => run.id));
      const response = await t.call(box, without);
      const runs = (await t.runs()).filter((run) => !before.has(run.id));
      const { "operation-run-id": runId, date: _date, ...headers } = response.headers;
      const { correlationId: _correlationId, ...error } = errorOf(response);
      return {
        seen: { status: response.statusCode, headers: withoutCorrelation(headers), error },
        runId,
        runs: runs.map(({ status, effect, error: recorded, denial, actor, origin }) => ({
          status,
          effect,
          error: recorded,
          denial,
          actor,
          origin
        })),
        names: runs.map((run) => [run.id, run.operation])
      };
    };
    const existing = await answerOf("red");
    const unknown = await answerOf("blue");
    expect(existing.seen.status).toBe(403);
    expect(unknown.seen).toEqual(existing.seen);
    // Each refusal is recorded as a run under the name that was called, and named in a header.
    expect(existing.names).toEqual([[existing.runId, "test_box.red.read"]]);
    expect(unknown.names).toEqual([[unknown.runId, "test_box.blue.read"]]);
    expect(unknown.runs).toEqual(existing.runs);
    expect(unknown.runs).toEqual([expect.objectContaining({ status: "denied" })]);
    expect(t.read).toEqual([]);
  });

  // A key without the scope is refused where the route admits it, before any id is looked at.
  it("refuses a key without the route's scope the same for both ids, and records neither", async () => {
    const t = await serverWith();
    const key = person({ scopes: ["governance:read"] });
    const existing = await t.call("red", key);
    const unknown = await t.call("blue", key);
    expect(existing.statusCode, existing.body).toBe(403);
    expect(errorOf(unknown).message).toBe(errorOf(existing).message);
    expect(unknown.headers["operation-run-id"]).toBeUndefined();
    expect(existing.headers["operation-run-id"]).toBeUndefined();
    expect(await t.runs()).toEqual([]);
  });

  // An operation that asked more of the key or the caller than its route would be refused
  // where an unknown id is not. Fails without the check: the call was refused with 403.
  it("fails a resource's operation that asks another scope or caller than its route", async () => {
    const t = await serverWith();
    expect((await t.call("grey")).statusCode).toBe(500);
    expect((await t.call("pink")).statusCode).toBe(500);
    expect(await t.runs()).toEqual([]);
  });

  // Fails with the effect read from the route: the call of a changing operation through a
  // route described as reading ended in an internal error.
  it("runs a resource's operation with the effect that operation has", async () => {
    const t = await serverWith();
    const response = await t.call("green");
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ box: "green", shelf: "top" });
    expect((await t.runs()).map((run) => [run.operation, run.effect])).toEqual([
      ["test_box.green.read", "changing"]
    ]);
  });

  it("refuses a route that names a right of its own", async () => {
    await expect(
      createServer({
        register(route: TestRoute) {
          // The right is the resource operation's: a second one on the route is a second rule.
          route.resourceOperation(registeredTestOperations.testRunRead, {
            target: ({ itemId }) => ({ operation: `test_item.${itemId}.read`, input: {} }),
            right: "audit.view",
            notFound: "The item is not available"
          });
        }
      }).then((created) => created.server.call("health.get"))
    ).rejects.toThrow("names no right");
  });
});
