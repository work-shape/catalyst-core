import type postgres from "postgres";
import { describe, vi } from "vitest";
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

describe("Knowledge Base processing at customer volume", () => {
  registerKnowledgeProcessingVolumeTest(counted, 50000);
});
