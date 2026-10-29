import { apiOperations } from "@work-shape/catalyst-api-contract";
import { AppActionCalls } from "../apps/action-call";
import type { Route } from "../http/route";
import type { ResolvedChatServerOptions } from "../types";
import { FeedbackWorkflow, authorizeAuthor, authorizeReviewer, personOf } from "./feedback-service";

/**
 * Feedback on agent answers (LU-4), from inside an App and on Workflow results in the Inbox
 * (LU-6). Every call is a registered operation, so the CLI, the API and an MCP client reach the
 * same ones. The module `feedback` refuses all of them where it is off.
 */
export function registerFeedbackRoutes(route: Route, options: ResolvedChatServerOptions): void {
  const workflow = new FeedbackWorkflow(options);
  // The frame a comment from an App names is checked as a call of the App's actions is.
  const frames = new AppActionCalls(options);
  const inboxItem = ({ requestId }: { requestId: string }) => ({
    kind: "approval_request",
    id: requestId
  });
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

  route.operation(apiOperations["feedback.send_from_app"], {
    changeClass: "reversible",
    // The frame's address carries a token, which never enters a held input or an audit row.
    inputWithoutSecrets: (input) => ({ ...input, token: "[redacted]" }),
    authorize: authorizeAuthor,
    resource: ({ pageSessionId }) => ({ kind: "app_content_session", id: pageSessionId }),
    execute: async ({ pageSessionId, fileSetId, token, text }, context) => {
      const frame = await frames.session(
        { user: personOf(context.actor), access: context.access },
        { pageSessionId, fileSetId, token }
      );
      return workflow.sendFromApp(context, frame, text);
    }
  });

  // A comment on a result is sent from its notice, which only an instance with an Inbox holds.
  if (options.approvalRequests) {
    route.operation(apiOperations["feedback.list_own_on_result"], {
      authorize: authorizeAuthor,
      resource: inboxItem,
      execute: ({ requestId }, context) => workflow.listOwnOnResult(context, requestId)
    });

    route.operation(apiOperations["feedback.send_on_result"], {
      changeClass: "reversible",
      authorize: authorizeAuthor,
      resource: inboxItem,
      execute: ({ requestId, text }, context) => workflow.sendOnResult(context, requestId, text)
    });
  }

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
