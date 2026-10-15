import { expect, it } from "vitest";
import { asClientInstanceId } from "@work-shape/catalyst-core";
import { createTestConfig } from "./support/fixtures";
import { createTestInstance, getTestJobs } from "./support/test-instance";

// The assembled call path has the kind registry as well as the stores. A Workflow keeps its
// manifest in config and its scripts in config.files; both are files in the publish review.
it("includes workflow.yaml on first publish, compares it with live, and leaves an unchanged manifest out", async () => {
  const config = createTestConfig({
    developmentAuth: {
      enabled: true,
      defaultUserId: "review-root",
      users: [
        {
          id: "review-root",
          externalUserId: "review-root",
          displayLabel: "Root",
          roles: ["user", "admin", "superadmin"]
        },
        {
          id: "review-member",
          externalUserId: "review-member",
          displayLabel: "Publisher",
          roles: ["user"]
        }
      ]
    }
  });
  config.modules = { assetManagement: { enabled: true }, workflows: { enabled: true } };
  const t = await createTestInstance({ config, env: {}, tools: [] });
  const clientInstanceId = asClientInstanceId(config.clientInstance.id);
  const params = { kind: "workflow", name: "review-manifest" };
  const headers = { "x-dev-user-id": "review-member" };
  try {
    await t.call("me.get", { headers });
    await t.call("me.get");
    const people = await t.stores.users.listUsers({ clientInstanceId });
    const member = people.find((person) => person.displayLabel === "Publisher");
    const root = people.find((person) => person.displayLabel === "Root");
    if (!member || !root) throw new Error("Missing test users");
    for (const action of ["workflow.read", "workflow.write", "workflow.publish"]) {
      await t.stores.access.createGrant({
        clientInstanceId,
        holderKind: "user",
        holderId: member.id,
        action,
        effect: "allow",
        scopeKind: "instance",
        grantedBy: root.id
      });
    }
    const principal = await t.call("service_principals.create", {
      payload: { name: "review-runner", displayLabel: "Review runner" }
    });
    expect(principal.statusCode, principal.body).toBe(200);
    const manifest = {
      id: params.name,
      name: "First title",
      runAs: "review-runner",
      inputs: { type: "object" },
      outputs: { type: "object" },
      steps: [
        { id: "start", name: "Start", type: "trigger", triggers: [{ kind: "manual" }] },
        { id: "result", name: "Result", type: "output", input: {} }
      ]
    };
    const put = await t.call("assets.put", {
      params,
      payload: { expectedRevision: null, config: { name: params.name, manifest } }
    });
    expect(put.statusCode, put.body).toBe(200);
    const heldPublish = async (revision: number) => {
      const response = await t.call("assets.publish", { params, headers, payload: { revision } });
      expect(response.statusCode, response.body).toBe(202);
      const requestId = response.json().approvalRequestId;
      const request = await t.call("approval_requests.get", { params: { requestId } });
      expect(request.statusCode, request.body).toBe(200);
      return { requestId, review: request.json().preview.review };
    };
    const approve = async (requestId: string) => {
      const response = await t.call("approval_requests.decide", {
        params: { requestId },
        payload: { decision: "approve" }
      });
      expect(response.statusCode, response.body).toBe(200);
      await getTestJobs(t).runDue();
    };
    const first = await heldPublish(1);
    expect(first.review).toMatchObject({
      runAs: "review-runner",
      files: [{ path: "workflow.yaml", change: "added" }]
    });
    await approve(first.requestId);
    const changed = await t.call("assets.put", {
      params,
      payload: {
        expectedRevision: 1,
        config: { name: params.name, manifest: { ...manifest, name: "Second title" } }
      }
    });
    expect(changed.statusCode, changed.body).toBe(200);
    const second = await heldPublish(2);
    expect(second.review.files).toEqual([{ path: "workflow.yaml", change: "changed" }]);
    await approve(second.requestId);
    const unchanged = await heldPublish(2);
    expect(unchanged.review.files).toEqual([]);
  } finally {
    await t.close();
  }
});
