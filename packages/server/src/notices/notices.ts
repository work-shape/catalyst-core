import { noticeMailSettingsSchema } from "@work-shape/catalyst-config-schema";
import {
  AppError,
  NOTICE_KIND,
  NOTIFY_CHANNELS,
  NOTICE_RECIPIENTS_MAX,
  asCollaborationWorkspaceId,
  asUserId,
  auditActorFromIdentity,
  type AuditRecorder,
  type ClientInstanceId,
  type NoticeSendInput,
  type NoticeSendResult,
  type Notices,
  type UserRecord,
  type PlatformStores
} from "@work-shape/catalyst-core";
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
  stores: Pick<PlatformStores, "users" | "workspaces" | "approvals" | "noticeMail" | "transaction">;
  /** The minimum window before a new notice becomes eligible for its recipient's digest. */
  delivery?: { digestIntervalMs: number };
  now?: () => Date;
  auditRecorder: AuditRecorder;
  /** Without a configured adapter, mail is counted unsent and the Inbox still receives it. */
  mailConfigured?: boolean;
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
  const delivery = noticeMailSettingsSchema.parse(options.delivery ?? {});

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

  return {
    async send(input, context) {
      if (input.from.clientInstanceId !== clientInstanceId) {
        throw new AppError("FORBIDDEN", "The sender belongs to another client instance");
      }
      const addressing = addressingSchema.safeParse({ to: input.to, channels: input.channels });
      const content = noticeContentSchema.safeParse({
        title: input.title,
        text: input.text,
        ...(input.link
          ? {
              link:
                input.link.kind === "workflow_run"
                  ? { ...input.link, workspaceId: input.link.workspaceId ?? "recipient" }
                  : input.link
            }
          : {})
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
      const mailsSent = 0;
      let mailsQueued = 0;
      const deliveryDate = new Date(
        (options.now?.() ?? new Date()).getTime() + delivery.digestIntervalMs
      );
      if (!Number.isFinite(deliveryDate.getTime())) {
        throw new AppError(
          "VALIDATION_FAILED",
          "digestIntervalMs must produce a valid delivery date",
          {
            fields: ["infrastructure.mail.notices.digestIntervalMs"]
          }
        );
      }
      const dueAt = deliveryDate.toISOString();
      let mailsUnsent = 0;
      await stores.transaction(async (tx) => {
        for (const user of users) {
          const link = payload.link;
          const personal =
            link?.kind === "workflow_run" &&
            input.link?.kind === "workflow_run" &&
            !input.link.workspaceId
              ? await tx.workspaces.ensurePersonalWorkspace({ clientInstanceId, userId: user.id })
              : undefined;
          const item = await tx.approvals.createApprovalRequest({
            clientInstanceId,
            kind: NOTICE_KIND,
            summary: payload.title,
            payload:
              personal && link
                ? { ...payload, link: { ...link, workspaceId: personal.id } }
                : payload,
            requestedBy: { id: input.from.id, displayLabel: input.from.displayLabel },
            addresseeUserId: user.id
          });
          if (!channels.includes("mail")) continue;
          if (!options.mailConfigured || !user.email) {
            mailsUnsent += 1;
            continue;
          }
          await tx.noticeMail.enqueue({
            clientInstanceId,
            noticeId: item.id,
            userId: user.id,
            dueAt
          });
          mailsQueued += 1;
        }
      });
      const result: NoticeSendResult = {
        addressees: users.length,
        inactive,
        mailsSent,
        mailsQueued,
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
