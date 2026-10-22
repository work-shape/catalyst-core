import { it } from "vitest";
import { expectBatchViews } from "./support/workflow-batch";

it.each([
  [600, 1],
  [100000, 500]
])("runs %i rows in views of %i without copying them", expectBatchViews, 300_000);
