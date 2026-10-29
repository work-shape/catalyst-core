import { describe, expect, it } from "vitest";
import { KNOWLEDGE_INDEX_CONCURRENCY_DEFAULTS, knowledgeIndexJob } from "@work-shape/catalyst-core";
import { clientInstanceConfigSchema } from "@work-shape/catalyst-config-schema";

describe("knowledge.indexConcurrency", () => {
  const schema = clientInstanceConfigSchema.shape.knowledge;

  it("defaults to 8 per worker and 16 in total, the limits of the index job", () => {
    expect(schema.parse({}).indexConcurrency).toEqual({ perWorker: 8, total: 16 });
    expect(KNOWLEDGE_INDEX_CONCURRENCY_DEFAULTS).toEqual({ perWorker: 8, total: 16 });
    expect(knowledgeIndexJob.concurrency).toEqual({ global: 16 });
  });

  it("takes each number alone and refuses a number outside its range or a stranger", () => {
    expect(schema.parse({ indexConcurrency: { total: 64 } }).indexConcurrency).toEqual({
      perWorker: 8,
      total: 64
    });
    expect(schema.parse({ indexConcurrency: { perWorker: 32 } }).indexConcurrency).toEqual({
      perWorker: 32,
      total: 16
    });
    expect(schema.safeParse({ indexConcurrency: { perWorker: 0 } }).success).toBe(false);
    expect(schema.safeParse({ indexConcurrency: { total: 1.5 } }).success).toBe(false);
    expect(schema.safeParse({ indexConcurrency: { slots: 4 } }).success).toBe(false);
  });
});
