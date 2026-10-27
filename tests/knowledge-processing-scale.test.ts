import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";
import { clientInstanceId } from "./support/data-store-instance";
import {
  knowledgeDocumentTypesSchema,
  knowledgeProcessingOf
} from "@work-shape/catalyst-data-stores";
import { required } from "./support/assertions";
import { useKnowledgeSync } from "./support/knowledge-sync";
import { registerKnowledgeProcessingVolumeTest } from "./support/knowledge-processing-volume";

const counted = await vi.hoisted(async () => {
  const { AsyncLocalStorage } = await import("node:async_hooks");
  return new AsyncLocalStorage<string[]>();
});
vi.mock("postgres", async (importOriginal) => {
  type Options = postgres.Options<Record<string, never>>;
  type Connect = (url: string | Options, options?: Options) => postgres.Sql;
  const actual = await importOriginal<{ default: Connect }>();
  const connect: Connect = (url, options) => {
    const debug = (_connection: number, statement: string) => {
      counted.getStore()?.push(statement);
    };
    return typeof url === "string"
      ? actual.default(url, { ...options, debug })
      : actual.default({ ...url, debug });
  };
  return { ...actual, default: Object.assign(connect, actual.default) };
});

const params = { kind: "knowledge_base", name: "sync-test" };
describe("Knowledge Base processing review at scale", () => {
  const { setup } = useKnowledgeSync();
  it("uses the same first-match glob rules in SQL and ingestion, including Unicode and hostile names", async () => {
    const world = await setup();
    world.world.put({
      folderId: "folder",
      name: "base.md",
      mime: "text/markdown",
      bytes: new TextEncoder().encode("Base")
    });
    await world.drain(await world.sync());
    const names = [
      "report-a.md",
      "report-b.pdf",
      ".hidden.md",
      "a\nb.md",
      "a.md\n",
      "a.md\r",
      "a.md\u2028",
      "a.md\u2029",
      "contracts/a\nb.md",
      "contracts/a.md\n",
      "a,b.md",
      "a-b.md",
      "a#b.md",
      String.raw`\x41.md`,
      String.raw`\p{L}.md`,
      "ä.md",
      "😀.md",
      "file' or true --.md",
      "contracts/a.md",
      "/contracts/a.md"
    ];
    for (const [index, name] of names.entries()) {
      const sha = (index + 1).toString(16).padStart(64, "0");
      await world.sql`insert into catalyst_kb.contents (sha256,format,state) values (${sha},'markdown','pending')`;
      await world.sql`insert into catalyst_kb.documents (id,managed_file_id,content_sha256,title,file_name) values (${sha},${sha},${sha},'Example',${name})`;
    }
    const asset = required(
      await world.instance.stores.configAssets.getConfigAsset({ clientInstanceId, ...params })
    );
    for (const pattern of [
      String.raw`\\x41.md`,
      String.raw`\\p{L}.md`,
      "report*",
      "**/*.md",
      "*.{md,pdf}",
      "!(report-a).md",
      "[[:alpha:]].md",
      "[[:ascii:]]*.md",
      "?.md",
      "??.md",
      "a-b.md",
      "a,b.md",
      "a#b.md",
      "**/contracts/**",
      "file' or true --.md"
    ]) {
      const documentTypes = knowledgeDocumentTypesSchema.parse([
        { id: "selected", match: { name: [pattern] }, chunking: "whole" }
      ]);
      const expected = ["base.md", ...names].filter(
        (name) =>
          knowledgeProcessingOf(documentTypes, {
            path: name,
            name,
            mime: "text/markdown",
            format: "markdown"
          }).type === "selected"
      ).length;
      const lines = await world.knowledge.publishQuestion({
        assetId: asset.id,
        scope: asset.scope,
        config: { ...asset.publishedConfig, methods: ["keyword"], documentTypes }
      });
      const count = Number(
        (
          lines.join("\n").match(/([\d,]+) documents? (?:is|are) read again/u)?.[1] ?? "0"
        ).replaceAll(",", "")
      );
      expect(count, pattern).toBe(expected);
    }
    const documentTypes = knowledgeDocumentTypesSchema.parse([
      { id: "first", match: { name: ["report*"], mime: ["application/pdf"] }, chunking: "whole" },
      {
        id: "second",
        match: { path: ["**/contracts/**"], mime: ["text/markdown"] },
        chunking: "whole"
      }
    ]);
    const lines = await world.knowledge.publishQuestion({
      assetId: asset.id,
      scope: asset.scope,
      config: { ...asset.publishedConfig, methods: ["keyword"], documentTypes }
    });
    expect(lines.join("\n")).toContain("2 documents are read again with the new settings.");
  });
  registerKnowledgeProcessingVolumeTest(counted, 1001);
});
