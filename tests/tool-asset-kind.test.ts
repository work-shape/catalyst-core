import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createToolAssetKind } from "@work-shape/catalyst-client-assembly";
import { clientInstanceId, setupAccessInstance } from "./support/access-instance";

// Tools as assets through the asset operations (TOOL-1): a draft until publish, the rights of
// the kind, the write check of the input schema, and agents that name a tool.

const tool = (name: string, input: Record<string, unknown> = { type: "object" }) => ({
  name,
  type: "result",
  title: { en: "Submit review", de: "Prüfung abgeben" },
  summary: { en: "Hands the finished review to the panel." },
  description: "Call when the review is finished.",
  input,
  result: { kind: "review.document_check", title: "Review" }
});

const listedSchema = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      title: z.string(),
      description: z.string().optional(),
      attributes: z.record(z.string(), z.unknown()).optional()
    })
  )
});
const revisionSchema = z.object({ revision: z.number() }).loose();

async function setup() {
  return setupAccessInstance({ furtherKinds: [createToolAssetKind()] });
}

type Instance = Awaited<ReturnType<typeof setup>>;

async function putTool(t: Instance, userId: string, name: string, config = tool(name)) {
  return t.call(userId, "assets.put", { params: { kind: "tool", name }, payload: { config } });
}

describe("tools as assets", () => {
  it("are written as drafts, listed with their result kind and published", async () => {
    const t = await setup();
    const put = await putTool(t, t.admin.id, "submit_review");
    expect(put.statusCode, put.body).toBe(200);
    const { revision } = revisionSchema.parse(put.json());

    const listed = listedSchema.parse(
      (await t.expectOk(t.admin.id, "assets.list", { params: { kind: "tool" } })).json()
    );
    expect(listed.items).toEqual([
      expect.objectContaining({
        name: "submit_review",
        title: "Submit review",
        description: "Hands the finished review to the panel.",
        attributes: { type: "result", resultKind: "review.document_check" }
      })
    ]);

    await t.expectOk(t.admin.id, "assets.publish", {
      params: { kind: "tool", name: "submit_review" },
      payload: { revision }
    });
    const stored = await t.stores.configAssets.getConfigAsset({
      clientInstanceId,
      kind: "tool",
      name: "submit_review"
    });
    expect(stored?.publishedRevision).toBe(revision);
  });

  it("refuses whoever holds no right on tools", async () => {
    const t = await setup();
    const refused = await putTool(t, t.kai.id, "submit_review");
    expect(refused.statusCode).toBe(403);
  });

  it("refuses an input schema the platform cannot compile, and code of any kind", async () => {
    const t = await setup();
    const uncompilable = await putTool(
      t,
      t.admin.id,
      "broken",
      tool("broken", { type: "object", properties: { a: { $ref: "#/definitions/nowhere" } } })
    );
    expect(uncompilable.statusCode, uncompilable.body).toBe(422);
    expect(uncompilable.body).toContain("tool_input_schema_unusable");

    const withCode = await t.call(t.admin.id, "assets.put", {
      params: { kind: "tool", name: "runner" },
      payload: { config: { ...tool("runner"), run: "rm -rf /" } }
    });
    expect(withCode.statusCode).toBe(422);
  });

  it("are named by agents, which cannot name a tool that does not exist", async () => {
    const t = await setup();
    const missing = await t.putAgent(t.admin.id, "reviewer", {
      toolNames: ["tool.submit_review.call"]
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.body).toContain("references missing tool 'submit_review'");

    expect((await putTool(t, t.admin.id, "submit_review")).statusCode).toBe(200);
    const named = await t.putAgent(t.admin.id, "reviewer", {
      toolNames: ["tool.submit_review.call"]
    });
    expect(named.statusCode, named.body).toBe(200);

    // A tool an agent still names is not deleted.
    const deleted = await t.call(t.admin.id, "assets.delete", {
      params: { kind: "tool", name: "submit_review" },
      payload: { expectedRevision: 1 }
    });
    expect(deleted.statusCode).not.toBe(200);
  });
});
