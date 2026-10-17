import {
  AppError,
  NOTICE_KIND,
  NOTIFY_CHANNELS,
  NOTICE_RECIPIENTS_MAX,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromIdentity,
  type ApprovalRequestStore,
  type AuditRecorder,
  type ClientInstanceId,
  type CollaborationWorkspaceStore,
  type LocaleCode,
  type Logger,
  type NoticeSendInput,
  type NoticeSendResult,
  type Notices,
  type UserRecord,
  type UserStore
} from "@work-shape/catalyst-core";
import type { MailSender } from "@work-shape/catalyst-mail";
import { z } from "zod";
import { NOTICE_ID, noticeContentSchema, type NoticePayload } from "./notice-kind";

// The one way the platform sends a notice (NOTIFY-a). The Workflow engine calls it with the
// run's principal as the sender (NOTIFY-b).
//
// Who gets it: the users named and the members of the Shared Workspaces named, each once, as
// long as they are active users of this instance. Nobody else: no address is taken from the
// caller, so a mail goes only to the address the instance holds for an addressee. Each
// addressee gets an Inbox item of their own, which only they see.
//
// What is refused, whole: an id that names no user or no Shared Workspace of the instance,
// and a notice that would reach nobody. A person named who is not active is skipped and
// counted, so one leaver does not stop the notice to the others.
//
// What leaves the instance: a mail that a notice waits, with the link to the addressee's own
// item, and no word of the title or the text (`WorkflowNoticeMail`). The audit event holds
// counts only, and nothing here logs the title or the text.

export interface NoticesOptions {
  clientInstanceId: ClientInstanceId;
  stores: {
    users: Pick<UserStore, "getUser">;
    workspaces: Pick<CollaborationWorkspaceStore, "getWorkspace" | "listMemberships">;
    approvals: Pick<ApprovalRequestStore, "createApprovalRequest">;
  };
  auditRecorder: AuditRecorder;
  /** Without it a notice asked for by mail is in the Inbox only, and its mails count unsent. */
  mail?: { sender: MailSender; appUrl: string };
  /** The language of the mail. A user has no language of their own yet. */
  locale: LocaleCode;
  logger?: Logger;
}

// Ids only: an address or any other value is refused before anything is looked up.
const idsSchema = z.array(z.string().regex(NOTICE_ID)).max(NOTICE_RECIPIENTS_MAX);

const addressingSchema = z
  .object({
    to: z.object({ users: idsSchema.optional(), workspaces: idsSchema.optional() }).strict(),
    channels: z
      .array(z.enum(NOTIFY_CHANNELS))
      .min(1)
      .refine((channels) => channels.includes("inbox"), {
        message: "A notice is always an Inbox item: channels must include inbox"
      })
  })
  .strict();

export function createNotices(options: NoticesOptions): Notices {
  const { clientInstanceId, stores } = options;

  /** A user of this instance, active or not, or nothing. */
  async function userOf(id: string): Promise<UserRecord | undefined> {
    const user = await stores.users.getUser({ clientInstanceId, userId: asUserId(id) });
    return user?.clientInstanceId === clientInstanceId ? user : undefined;
  }

  /**
   * The users a notice reaches, each once; the people named, directly or through a workspace,
   * who are not active; and the ids that name no user, or no Shared Workspace, of the instance.
   */
  async function addresseesOf(to: NoticeSendInput["to"]): Promise<{
    users: UserRecord[];
    inactive: number;
    unknown: { users: string[]; workspaces: string[] };
  }> {
    const users = new Map<string, UserRecord>();
    const inactive = new Set<string>();
    const unknown = { users: new Array<string>(), workspaces: new Array<string>() };
    const reach = (user: UserRecord) => {
      if (user.status === "active") users.set(user.id, user);
      else inactive.add(user.id);
    };
    for (const id of new Set(to.users ?? [])) {
      const user = await userOf(id);
      if (user) reach(user);
      else unknown.users.push(id);
    }
    for (const id of new Set(to.workspaces ?? [])) {
      const workspaceId = asCollaborationWorkspaceId(id);
      const workspace = await stores.workspaces.getWorkspace(clientInstanceId, workspaceId);
      // A Personal Workspace is one person's, who is named as a user.
      if (!workspace || workspace.kind !== "shared") {
        unknown.workspaces.push(id);
        continue;
      }
      const memberships = await stores.workspaces.listMemberships({
        clientInstanceId,
        collaborationWorkspaceId: workspaceId
      });
      for (const { userId } of memberships) {
        if (users.has(userId) || inactive.has(userId)) continue;
        const user = await userOf(userId);
        if (user) reach(user);
      }
    }
    return { users: [...users.values()], inactive: inactive.size, unknown };
  }

  /** Mails one addressee that a notice waits. False where no mail went. */
  async function mailTo(user: UserRecord, itemId: string): Promise<boolean> {
    const { mail } = options;
    if (!mail || !user.email) return false;
    try {
      const result = await mail.sender.send({
        template: "workflow-notice",
        to: { email: user.email, displayLabel: user.displayLabel },
        locale: options.locale,
        params: { link: `${mail.appUrl.replace(/\/+$/u, "")}/inbox/${encodeURIComponent(itemId)}` }
      });
      return result.ok;
    } catch (error) {
      // The provider's own failure; it holds no word of the notice.
      options.logger?.warn(
        { error: error instanceof Error ? error.name : "unknown" },
        "A notice mail could not be handed to the mail provider"
      );
      return false;
    }
  }

  return {
    async send(input, context) {
      if (input.from.clientInstanceId !== clientInstanceId) {
        throw new AppError("FORBIDDEN", "The sender belongs to another client instance");
      }
      const addressing = addressingSchema.safeParse({ to: input.to, channels: input.channels });
      const content = noticeContentSchema.safeParse({
        title: input.title,
        text: input.text,
        ...(input.link ? { link: input.link } : {})
      });
      // The refusal names the field, never what it held.
      if (!addressing.success || !content.success) {
        const issues = [
          ...(addressing.success ? [] : addressing.error.issues),
          ...(content.success ? [] : content.error.issues)
        ];
        throw new AppError("VALIDATION_FAILED", "The notice is not valid", {
          fields: [...new Set(issues.map((issue) => issue.path.join(".")))]
        });
      }
      const payload: NoticePayload = content.data;
      const channels = [...new Set(addressing.data.channels)];
      const { users, inactive, unknown } = await addresseesOf(addressing.data.to);
      // An id that names nothing is a mistake of the sender's, which a notice to the others
      // would hide: the whole notice is refused and the ids are named. They are ids only.
      if (unknown.users.length > 0 || unknown.workspaces.length > 0) {
        throw new AppError(
          "VALIDATION_FAILED",
          "The notice names recipients the instance does not have",
          {
            fields: [
              ...(unknown.users.length > 0 ? ["to.users"] : []),
              ...(unknown.workspaces.length > 0 ? ["to.workspaces"] : [])
            ],
            unknownRecipients: unknown
          }
        );
      }
      // A notice that would reach nobody is refused rather than lost: the step that sends it
      // fails, and the person who answers for the Workflow learns why.
      if (users.length === 0) {
        throw new AppError(
          "CONFLICT",
          "The notice would reach nobody: no person it names is active",
          {
            reason: "no_active_recipient",
            inactive
          }
        );
      }
      let mailsSent = 0;
      let mailsUnsent = 0;
      for (const user of users) {
        const item = await stores.approvals.createApprovalRequest({
          clientInstanceId,
          kind: NOTICE_KIND,
          summary: payload.title,
          payload,
          requestedBy: { id: input.from.id, displayLabel: input.from.displayLabel },
          addresseeUserId: user.id
        });
        if (!channels.includes("mail")) continue;
        if (await mailTo(user, item.id)) mailsSent += 1;
        else mailsUnsent += 1;
      }
      const result: NoticeSendResult = {
        addressees: users.length,
        inactive,
        mailsSent,
        mailsUnsent
      };
      await options.auditRecorder.record({
        type: "notice.sent",
        status: "success",
        actor: auditActorFromIdentity(input.from),
        correlationId: context.correlationId,
        metadata: { channels, ...result }
      });
      return result;
    }
  };
}
