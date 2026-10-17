import type { RegisteredJobHandler } from "@work-shape/catalyst-core";
import type { DataStoreRuntime } from "../../runtime";
import { createKnowledgeSyncHandler } from "./sync-job";
import { createKnowledgeFetchHandler } from "./fetch-job";
import type { KnowledgeSourceJobsInput } from "./source-runtime";
export type { KnowledgeSourceJobsInput } from "./source-runtime";
export function createKnowledgeSourceJobs(
  data: DataStoreRuntime,
  input: KnowledgeSourceJobsInput
): RegisteredJobHandler[] {
  const runtime = { data, input };
  return [createKnowledgeSyncHandler(runtime), createKnowledgeFetchHandler(runtime)];
}
