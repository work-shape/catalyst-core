import { expect, it } from "vitest";
import { errorSchema, setupAccessInstance } from "./support/access-instance";

// On an instance whose default agent is its only agent: the tests of a file share a database,
// so this one has a file of its own.

// Fails without the change: the delete answered 428 for a call that named no revision and 412
// with the revision of the agent for one that named another, before the missing right.
it("answers the delete of the last default agent the instance right before the revision", async () => {
  const lone = await setupAccessInstance();
  const assistant = await lone.assetId("agent", "assistant");
  for (const action of ["agent.read", "agent.write", "agent.delete"]) {
    await lone.grant(lone.kai.id, action, { assetId: assistant });
  }
  for (const expectedRevision of [undefined, 99]) {
    const response = await lone.call(lone.kai.id, "assets.delete", {
      params: { kind: "agent", name: "assistant" },
      payload: { expectedRevision }
    });
    const refused = errorSchema.parse(response.json()).error;
    expect(response.statusCode).toBe(403);
    expect(refused).toMatchObject({ code: "FORBIDDEN", details: { action: "agent.write" } });
    expect(JSON.stringify(refused)).not.toContain("currentRevision");
  }
  // With the right on the instance the revision is what is answered.
  const admin = await lone.call(lone.admin.id, "assets.delete", {
    params: { kind: "agent", name: "assistant" },
    payload: { expectedRevision: undefined }
  });
  expect(admin.statusCode).toBe(428);
});
