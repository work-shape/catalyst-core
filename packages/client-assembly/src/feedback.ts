import { defineModule } from "@work-shape/catalyst-core";

/**
 * Feedback on agent answers (LU-4): a "Feedback" action beside copy under each finished answer,
 * the comment as a record of its own with its own retention, and an Inbox item of kind
 * `feedback_review` for whoever holds `feedback.review` on the agent. Off by default. Off, no
 * comment is sent, read or marked, the action is not shown and the retention leaves what is
 * stored alone.
 */
export const feedbackModule = defineModule({
  name: "feedback",
  operations: [
    "feedback.list_own",
    "feedback.send",
    "feedback.update",
    "feedback.withdraw",
    "feedback.list",
    "feedback.get",
    "feedback.mark_handled",
    "feedback.annotate"
  ],
  jobKinds: ["feedback.prune"],
  ui: ["chat.message.feedback", "inbox.feedback_review"]
});
