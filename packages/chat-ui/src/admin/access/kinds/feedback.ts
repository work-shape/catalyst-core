import { configAssetWords, type GrantKindEntry } from "./entry";

// `feedback.review` is granted on a workspace or the instance: the asset words name no
// choice the dialog offers.
export const feedbackKind: GrantKindEntry<"feedback"> = {
  label: "access.kindFeedback",
  words: {
    ...configAssetWords,
    scopeAsset: "access.scopeAgent",
    object: "access.objectAgent"
  },
  sentences: {
    "feedback.review": "access.actionReviewFeedbackDescription"
  }
};
