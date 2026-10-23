import { isJsonObject, type ResultShaper } from "@work-shape/catalyst-core";

/** The sample response's envelope becomes a list of items. No state or outside access. */
export const sampleResultShapers: Record<string, ResultShaper> = {
  "sample.customers": (result) => {
    if (!isJsonObject(result) || !Array.isArray(result.customers)) {
      throw new Error("Expected sample customers");
    }
    return { items: result.customers };
  }
};
