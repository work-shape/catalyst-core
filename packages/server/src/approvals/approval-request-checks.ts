import {
  getRuntimeSubjectUserId,
  type ApprovalCheckResult,
  type ApprovalRequest,
  type BeforeActionCheck,
  type RuntimeCallContext
} from "@work-shape/catalyst-core";

/** What `approval_request.before_create` hands its checks. */
export interface ApprovalRequestCheckInput {
  event: "approval_request.before_create";
  /** The kind of the request, which a check's filter names. */
  subjectKind: string;
  /** The summary and the new content. Undefined where the request has nothing to check. */
  fields(): { summary: string; newContent: string } | undefined;
  /** The conversation the request comes from, for the usage of a check's model call. */
  origin?: ApprovalRequest["origin"];
}

/** The checks of a request before it is filed, as the request keeps their results. */
export async function approvalRequestChecks(
  check: Pick<BeforeActionCheck, "answer">,
  input: ApprovalRequestCheckInput,
  context: RuntimeCallContext
): Promise<ApprovalCheckResult[]> {
  const answers = await check.answer(
    {
      event: input.event,
      subject: { kind: input.subjectKind },
      match: { kind: input.subjectKind },
      fields: () => input.fields() ?? {}
    },
    {
      correlationId: context.correlationId,
      userId: getRuntimeSubjectUserId(context),
      ...(input.origin ? { conversationId: input.origin.conversationId } : {}),
      ...(context.deadline ? { deadline: context.deadline } : {}),
      ...(context.signal ? { signal: context.signal } : {})
    }
  );
  return answers.map((answer) => ({
    id: answer.guardrailName,
    status:
      answer.outcome === "block" ? "blocked" : answer.outcome === "warn" ? "warned" : "passed",
    message: answer.reason
  }));
}
