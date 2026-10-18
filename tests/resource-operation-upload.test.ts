import { describe, expect, it } from "vitest";
import type { OperationUpload } from "@work-shape/catalyst-core";
import { createMultipartFilePayload } from "./support/chat-server-attachment-harness";
import { createServer, errorOf, person } from "./support/operation-server";
import { resourceRouteTestOperations as operations } from "./support/operations";
import type { TestRoute } from "./support/test-instance";

// A multipart route of a family of per-resource operations (ACCEPT-FIX-1, F1): the file rides
// the live call, never its input; the input names it by checksum and size, so a key sent again
// with other bytes is a reused key; a call with a file is never held for an approval, since
// nothing could carry its bytes out later; and the staged file is gone once the call ended.

async function serverWith(settings: Parameters<typeof createServer>[0] = {}) {
  const seen: OperationUpload[] = [];
  const inputs: unknown[] = [];
  const created = await createServer({
    ...settings,
    register(route: TestRoute) {
      route.operation(operations.testBoxBlueUpload, {
        resource: () => ({ kind: "test_box", id: "blue" }),
        async execute(input, context) {
          inputs.push(input);
          const { upload } = context.runtime;
          if (!upload) throw new Error("no upload");
          seen.push(upload);
          const text = new TextDecoder().decode(await upload.read());
          if (text === "fail") throw new Error("the operation failed");
          return { text };
        }
      });
      route.resourceOperation(operations.testBoxesUpload, {
        target: ({ box }, upload) => ({
          operation: `test_box.${box}.upload`,
          input: { upload: upload ? { sha256: upload.sha256, bytes: upload.byteSize } : {} }
        }),
        right: "audit.view",
        notFound: "The box is not available"
      });
    }
  });
  const send = (content: string, key?: string) => {
    const body = createMultipartFilePayload({
      fieldName: "file",
      filename: "notes.txt",
      contentType: "text/plain",
      content
    });
    return created.server.call(
      "testBoxesUpload",
      {
        params: { box: "blue" },
        headers: { ...body.headers, ...(key === undefined ? {} : { "idempotency-key": key }) },
        payload: body.payload
      },
      person()
    );
  };
  return { ...created, seen, inputs, send };
}

describe("the multipart route of a family of per-resource operations", () => {
  it("hands the file to the call alone and removes it once the call ended", async () => {
    const t = await serverWith();
    const answer = await t.send("Urlaubstage: 28");
    expect(answer.statusCode, answer.body).toBe(200);
    expect(answer.json()).toEqual({ text: "Urlaubstage: 28" });
    // The input names the bytes; it holds neither them nor the file's name.
    expect(t.inputs).toEqual([
      { upload: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/), bytes: 15 } }
    ]);
    expect(JSON.stringify(await t.runs())).not.toContain("notes.txt");
    await expect(t.seen[0]?.read()).rejects.toThrow();

    // A call that fails removes its file too.
    const failed = await t.send("fail");
    expect(failed.statusCode).toBe(500);
    await expect(t.seen[1]?.read()).rejects.toThrow();
  });

  it("answers the same file under the same key from its run, and refuses other bytes under it", async () => {
    const t = await serverWith();
    expect((await t.send("first", "key-1")).statusCode).toBe(200);
    const again = await t.send("first", "key-1");
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers["idempotent-replayed"]).toBe("true");

    const other = await t.send("other", "key-1");
    expect(errorOf(other).code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(t.seen).toHaveLength(1);
  });

  it("refuses a call with a file that the policy would hold for an approval, and files none", async () => {
    const t = await serverWith({
      approvals: true,
      settings: [{ operation: "test_box.blue.upload", value: "approval" }]
    });
    const answer = await t.send("Urlaubstage: 28");
    expect(answer.statusCode, answer.body).toBe(403);
    expect(errorOf(answer)).toMatchObject({
      code: "POLICY_DENIED",
      details: { reason: "approval_unavailable" }
    });
    expect(t.approvalRequests).toEqual([]);
    expect(t.seen).toEqual([]);
  });
});
