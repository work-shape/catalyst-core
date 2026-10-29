import { defineModule } from "@work-shape/catalyst-core";

/**
 * Feedback on agent answers (LU-4): a "Feedback" action beside copy under each finished answer,
 * the comment as a record of its own with its own retention, and an Inbox item of kind
 * `feedback_review` for whoever holds `feedback.review` on the agent. The same comment from
 * inside an App through the App Kit, and under a Workflow result in the Inbox (LU-6). Off by
 * default. Off, no comment is sent, read or marked, no control is shown and the retention
 * leaves what is stored alone.
 */
export const feedbackModule = defineModule({
  name: "feedback",
  operations: [
    "feedback.list_own",
    "feedback.send",
    "feedback.send_from_app",
    "feedback.list_own_on_result",
    "feedback.send_on_result",
    "feedback.update",
    "feedback.withdraw",
    "feedback.list",
    "feedback.get",
    "feedback.mark_handled",
    "feedback.annotate"
  ],
  jobKinds: ["feedback.prune"],
  ui: [
    "chat.message.feedback",
    "inbox.feedback_review",
    "app.feedback",
    "inbox.workflow_result_feedback"
  ]
});
