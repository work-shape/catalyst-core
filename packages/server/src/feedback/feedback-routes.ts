import { apiOperations } from "@work-shape/catalyst-api-contract";
import type { Route } from "../http/route";
import type { ChatServerOptions } from "../types";
import { FeedbackWorkflow, authorizeAuthor, authorizeReviewer } from "./feedback-service";

/**
 * Feedback on agent answers (LU-4). Every call is a registered operation, so the CLI, the API
 * and an MCP client reach the same eight. The module `feedback` refuses all of them where it is
 * off.
 */
export function registerFeedbackRoutes(route: Route, options: ChatServerOptions): void {
  const workflow = new FeedbackWorkflow(options);
  const conversation = ({ conversationId }: { conversationId: string }) => ({
    kind: "conversation",
    id: conversationId
  });
  const comment = ({ feedbackId }: { feedbackId: string }) => ({
    kind: "feedback",
    id: feedbackId
  });

  route.operation(apiOperations["feedback.list_own"], {
    authorize: authorizeAuthor,
    resource: conversation,
    execute: ({ conversationId }, context) => workflow.listOwn(context, conversationId)
  });

  route.operation(apiOperations["feedback.send"], {
    // Withdrawn by its author until a reviewer marked it handled.
    changeClass: "reversible",
    authorize: authorizeAuthor,
    resource: conversation,
    execute: ({ conversationId, ...body }, context) => workflow.send(context, conversationId, body)
  });

  route.operation(apiOperations["feedback.update"], {
    changeClass: "reversible",
    authorize: authorizeAuthor,
    resource: comment,
    execute: ({ conversationId, feedbackId, ...body }, context) =>
      workflow.update(context, conversationId, feedbackId, body)
  });

  route.operation(apiOperations["feedback.withdraw"], {
    authorize: authorizeAuthor,
    resource: comment,
    execute: ({ conversationId, feedbackId }, context) =>
      workflow.withdraw(context, conversationId, feedbackId)
  });

  route.operation(apiOperations["feedback.list"], {
    authorize: authorizeReviewer,
    execute: ({ agent, state }, context) =>
      workflow.list(
        context,
        { ...(agent ? { agent } : {}), ...(state ? { state } : {}) },
        context.paging
      )
  });

  route.operation(apiOperations["feedback.get"], {
    authorize: authorizeReviewer,
    resource: comment,
    execute: ({ feedbackId }, context) => workflow.get(context, feedbackId)
  });

  route.operation(apiOperations["feedback.mark_handled"], {
    authorize: authorizeReviewer,
    resource: comment,
    execute: ({ feedbackId, note }, context) => workflow.markHandled(context, feedbackId, note)
  });

  route.operation(apiOperations["feedback.annotate"], {
    // A later summary replaces it.
    changeClass: "reversible",
    authorize: authorizeReviewer,
    resource: comment,
    execute: ({ feedbackId, summary, category }, context) =>
      workflow.annotate(context, feedbackId, { summary, ...(category ? { category } : {}) })
  });
}
