import { describe, expect, it } from "vitest";
import { usePostgresSuite } from "./support/postgres-suite";

describe("audit events on Postgres", () => {
  const suite = usePostgresSuite("audit_mapping");

  it("omits actor, subject and reason when the event has none", async () => {
    const clientInstanceId = suite.clientInstance("absent");
    const appended = await suite.store.audit.appendAuditEvent({
      clientInstanceId,
      type: "test.event",
      status: "success",
      correlationId: "c"
    });
    const [listed] = await suite.store.audit.listAuditEvents({ clientInstanceId });

    for (const event of [appended, listed]) {
      expect(Object.keys(event ?? {}).sort()).toEqual(
        [
          "clientInstanceId",
          "correlationId",
          "createdAt",
          "id",
          "metadata",
          "status",
          "type"
        ].sort()
      );
    }
  });

  it("returns actor, subject and reason when the event has them", async () => {
    const clientInstanceId = suite.clientInstance("present");
    const appended = await suite.store.audit.appendAuditEvent({
      clientInstanceId,
      type: "test.event",
      status: "denied",
      actor: { displayLabel: "Worker", roles: [] },
      subject: "thing",
      reason: "because",
      correlationId: "c"
    });
    expect(appended).toMatchObject({
      actor: { displayLabel: "Worker", roles: [] },
      subject: "thing",
      reason: "because"
    });
  });
});
