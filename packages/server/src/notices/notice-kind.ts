import {
  NOTICE_KIND,
  NOTICE_ID_PATTERN,
  NOTICE_TEXT_MAX_LENGTH,
  NOTICE_TITLE_MAX_LENGTH,
  type ApprovalRequestHandler
} from "@work-shape/catalyst-core";
import { z } from "zod";

// The Inbox item of a notice. It is addressed to one person, who alone sees, counts and
// answers it (`ApprovalRequest.addresseeUserId`); its one answer is "mark handled", which
// changes nothing else. It holds the title, the text and the link the sender gave, and no
// value of a run beyond them.

/** One line: no line break or control character. */
const LINE = /^[^\p{Cc}]*$/u;
/** One paragraph: no control character beyond a line break. */
const PARAGRAPH = /^[^\p{Cc}]*(?:\n[^\p{Cc}]*)*$/u;
/** An id in an address: what the platform's ids and asset names are made of. */
export const NOTICE_ID = NOTICE_ID_PATTERN;

const linkSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("workflow_run"),
      workspaceId: z.string().regex(NOTICE_ID),
      workflowId: z.string().regex(NOTICE_ID),
      runId: z.string().regex(NOTICE_ID)
    })
    .strict(),
  z
    .object({
      kind: z.literal("app"),
      workspaceId: z.string().regex(NOTICE_ID),
      app: z.string().regex(NOTICE_ID)
    })
    .strict()
]);

export const noticeContentSchema = z
  .object({
    title: z.string().trim().min(1).max(NOTICE_TITLE_MAX_LENGTH).regex(LINE),
    text: z.string().trim().min(1).max(NOTICE_TEXT_MAX_LENGTH).regex(PARAGRAPH),
    link: linkSchema.optional()
  })
  .strict();

export type NoticePayload = z.infer<typeof noticeContentSchema>;

/** The kind of the notice item. Every instance has it: the platform files notices. */
export function createNoticeHandler(): ApprovalRequestHandler<NoticePayload> {
  return {
    kind: NOTICE_KIND,
    // Never asked of a notice, which is always addressed to its one reader. Were one ever
    // filed without an addressee, only an instance admin would see it.
    requiredPermission: "users.manage",
    validate: (payload) => noticeContentSchema.parse(payload),
    preview: async (payload) => ({
      title: payload.title,
      text: payload.text,
      ...(payload.link ? { link: payload.link } : {})
    }),
    isStale: async () => false,
    // Marking it handled is the whole answer.
    apply: async () => ({ handled: true })
  };
}
