import { configAssetWords, type GrantKindEntry } from "./entry";

// Retrying a job is granted on the whole instance only: the asset words name no choice the
// dialog offers.
export const jobsKind: GrantKindEntry<"jobs"> = {
  label: "access.kindJobs",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  sentences: {
    "jobs.retry": "access.actionRetryJobsDescription"
  }
};
