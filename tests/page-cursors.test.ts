import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  decodePageCursor,
  encodePageCursor,
  OBJECT_LIST_PAGE_SIZE,
  type JsonValue
} from "@work-shape/catalyst-core";
import { createFilesystemObjectStorage } from "@work-shape/catalyst-object-storage";

// These literals were produced by the separate codecs before their consolidation.
describe("JSON page cursor wire format", () => {
  it.each<{ payload: JsonValue; cursor: string }>([
    {
      payload: { scope: "legacy-list", keys: ["café/東京", 7] },
      cursor: "eyJzY29wZSI6ImxlZ2FjeS1saXN0Iiwia2V5cyI6WyJjYWbDqS_mnbHkuqwiLDddfQ"
    },
    { payload: { k: ["3", "café/東京"] }, cursor: "eyJrIjpbIjMiLCJjYWbDqS_mnbHkuqwiXX0" },
    { payload: { t: "16384", p: "(0,1)" }, cursor: "eyJ0IjoiMTYzODQiLCJwIjoiKDAsMSkifQ" },
    {
      payload: ["objekt", "1402", "kaufpreis", "kb_legacy", "a1"],
      cursor: "WyJvYmpla3QiLCIxNDAyIiwia2F1ZnByZWlzIiwia2JfbGVnYWN5IiwiYTEiXQ"
    },
    {
      payload: ["2026-10-17 12:34:56.123456+00", "doc_1"],
      cursor: "WyIyMDI2LTEwLTE3IDEyOjM0OjU2LjEyMzQ1NiswMCIsImRvY18xIl0"
    },
    {
      payload: { at: "2026-10-17T12:34:56.123Z", id: "item_1" },
      cursor: "eyJhdCI6IjIwMjYtMTAtMTdUMTI6MzQ6NTYuMTIzWiIsImlkIjoiaXRlbV8xIn0"
    }
  ])("reads and writes the existing cursor $cursor", ({ payload, cursor }) => {
    expect(decodePageCursor(cursor)).toEqual(payload);
    expect(encodePageCursor(payload)).toBe(cursor);
  });

  it("retains Buffer's acceptance of padded base64 and leaves payload validation to the list", () => {
    expect(decodePageCursor("eyJrIjpbIjMiLCJjYWbDqS/mnbHkuqwiXX0=")).toEqual({
      k: ["3", "café/東京"]
    });
    expect(decodePageCursor("e30")).toEqual({});
    expect(() => decodePageCursor("nonsense")).toThrow(SyntaxError);
  });
});

it("keeps filesystem cursors as raw keys rather than JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "page-cursor-filesystem-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const storage = createFilesystemObjectStorage(root);
  for (let index = 0; index < OBJECT_LIST_PAGE_SIZE - 1; index++)
    await storage.put(`files/a-${index}`, new Uint8Array());
  await storage.put("files/café/東京", new Uint8Array());
  await storage.put("files/z", new Uint8Array());
  const cursor = "ZmlsZXMvY2Fmw6kv5p2x5Lqs";
  expect((await storage.list("files/")).cursor).toBe(cursor);
  expect((await storage.list("files/", cursor)).objects.map(({ key }) => key)).toEqual(["files/z"]);
});
