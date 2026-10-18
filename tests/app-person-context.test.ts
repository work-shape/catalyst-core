import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectStatus } from "./support/app-instance";
import { setupAppActions, type AppActionsInstance } from "./support/app-actions";

// Apps do not send person context yet. A published App's call of a Connection that sends it
// is refused at the call, over the frame's route, before the Connector type is handed
// anything. The test fails without the refusal: the call ran and sent the viewer's value.

describe("a published App on a Connection that sends person context", () => {
  let t: AppActionsInstance;
  beforeAll(async () => {
    // `crm` is stored with App exposure as the fixture writes it, past the save's refusal: a
    // row stored before the save refused the two together is the same.
    t = await setupAppActions({ personContextHeader: "x-person" });
  });
  afterAll(() => t.closeAll());

  it("refuses the viewer's call before the Connector type is handed anything, mapped or not", async () => {
    let received = 0;
    t.setBehaviour((_operation, input) => {
      received += 1;
      return Promise.resolve(input);
    });
    const mapped = await t.call(t.admin.id, "connections.set_person_context", {
      params: { name: "crm" },
      payload: {
        subjectKind: "user",
        subjectId: t.kai.id,
        value: "kai-tenant",
        expectedRowVersion: null
      }
    });
    expectStatus(mapped, 200);
    await t.withRight(t.kai.id, "connection.use", { assetId: t.crm }, async () => {
      const frame = await t.openApp(t.kai.id, "published");
      const handed = t.handed.length;

      const response = await t.callAction(t.kai.id, frame, "load", { text: "cs-15b" });

      expectStatus(response, 403);
      expect(t.refusal(response)).toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringContaining("not available in Apps yet"),
        details: { reason: "person_context_app_unavailable" }
      });
      expect(t.refusal(response).message).not.toContain("kai-tenant");
      expect(received).toBe(0);
      expect(t.handed).toHaveLength(handed);
      const [run, ...others] = await t.runs();
      expect(others).toEqual([]);
      expect(run).toMatchObject({
        operation: "app.orders.load",
        status: "failed",
        origin: { kind: "app", target: { connection: "crm", operation: "echo" } },
        error: { reason: "person_context_app_unavailable" }
      });
    });
  });
});
