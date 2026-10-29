import { noticeMailSettingsSchema } from "@work-shape/catalyst-config-schema";
import {
  asUserId,
  createPlatformId,
  NOTICE_KIND,
  NOTICE_TEXT_MAX_LENGTH,
  NOTICE_TITLE_MAX_LENGTH,
  type LocaleCode,
  type Project,
  type UserRecord
} from "@work-shape/catalyst-core";
import type { ChatServerOptions } from "../types";
import { attemptClaimedProjectCleanup, retryDeletedProjectCleanup } from "./project-cleanup";

// Projects in retention (PRJ-6). A project and its files do not expire by themselves; a chat
// in one expires as every chat does. With `retention.projectIdleDays` set, the retention job
// gives notice of a project nothing happened in, and deletes it seven days later where nothing
// happened since. Deleted projects whose cleanup failed are finished on every run.

/** How long before its deletion an idle project's notice goes out. */
const PROJECT_IDLE_NOTICE_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Who files the notice: the platform, never a person. */
const SYSTEM_REQUESTER = { id: "system", displayLabel: "System" };

type RetentionOptions = Pick<
  ChatServerOptions,
  "clientInstanceId" | "stores" | "auditRecorder" | "pages" | "config" | "mail"
>;

export interface ProjectRetentionSummary {
  /** Deleted projects whose cleanup finished in this run. */
  cleanupCompletedCount: number;
  /** Deleted projects still holding bytes or rows. */
  cleanupPendingCount: number;
  noticedCount: number;
  deletedCount: number;
}

/**
 * One run of project retention. The retry of earlier cleanups always runs; notices and the
 * deletion of idle projects only with `retention.projectIdleDays`.
 */
export async function runProjectRetention(
  options: RetentionOptions,
  input: { now: Date; batchSize: number }
): Promise<ProjectRetentionSummary> {
  const retry = await retryDeletedProjectCleanup(options, input.batchSize);
  const summary: ProjectRetentionSummary = {
    cleanupCompletedCount: retry.completedCount,
    cleanupPendingCount: retry.cleanupPendingCount,
    noticedCount: 0,
    deletedCount: 0
  };
  const idleDays = options.config.retention.projectIdleDays;
  if (idleDays === undefined) return summary;
  const { clientInstanceId } = options;
  const now = input.now.getTime();
  const idleBefore = new Date(now - idleDays * DAY_MS).toISOString();
  const noticedBefore = new Date(now - PROJECT_IDLE_NOTICE_DAYS * DAY_MS).toISOString();

  // Activity after a notice keeps the project, and its next idle period is noticed anew.
  await options.stores.projects.clearIdleNoticesAfterActivity({ clientInstanceId });

  // Deletion first: a project noticed in this run is never deleted in it.
  const due = await options.stores.projects.listIdleProjectsToDelete({
    clientInstanceId,
    idleBefore,
    noticedBefore,
    limit: input.batchSize
  });
  for (const projectId of due) {
    const claim = await options.stores.projects.claimProjectDeletion({
      clientInstanceId,
      projectId,
      idle: { idleBefore, noticedBefore },
      deletedAt: input.now.toISOString()
    });
    // Something happened in it since it was listed.
    if (claim.status === "not_claimed") continue;
    const cleanup = await attemptClaimedProjectCleanup(options, projectId);
    if (cleanup.cleanup === "pending") summary.cleanupPendingCount += 1;
    await options.auditRecorder.record({
      type: "project.retention_deleted",
      status: "success",
      subject: projectId,
      correlationId: createPlatformId("corr"),
      metadata: {
        idleDays,
        conversationsKept: claim.conversationIds.length,
        cleanup: cleanup.cleanup
      }
    });
    summary.deletedCount += 1;
  }

  const noticeBefore = new Date(now - (idleDays - PROJECT_IDLE_NOTICE_DAYS) * DAY_MS).toISOString();
  const toNotice = await options.stores.projects.listProjectsToNotice({
    clientInstanceId,
    idleBefore: noticeBefore,
    limit: input.batchSize
  });
  for (const project of toNotice) {
    if (await noticeIdleProject(options, project, { now: input.now, noticeBefore, idleDays })) {
      summary.noticedCount += 1;
    }
  }
  return summary;
}

/**
 * Records the notice and files it in one transaction, to the creator while a member and, for a
 * shared project, to the workspace's Owners: each an Inbox item of their own, in their
 * language, and a mail that one waits where mail is set up. The mail carries no title. False
 * where the project is no longer idle or was noticed meanwhile.
 */
async function noticeIdleProject(
  options: RetentionOptions,
  project: Project,
  input: { now: Date; noticeBefore: string; idleDays: number }
): Promise<boolean> {
  const { clientInstanceId } = options;
  const recipients = await recipientsOf(options, project);
  const delivery = noticeMailSettingsSchema.parse(
    options.config.infrastructure.mail?.notices ?? {}
  );
  const dueAt = new Date(input.now.getTime() + delivery.digestIntervalMs).toISOString();
  const deleteOn = new Date(input.now.getTime() + PROJECT_IDLE_NOTICE_DAYS * DAY_MS);
  const workspace = await options.stores.workspaces.getWorkspace(
    clientInstanceId,
    project.collaborationWorkspaceId
  );
  let mailsQueued = 0;
  const noticed = await options.stores.transaction(async (stores) => {
    const marked = await stores.projects.markIdleNotice({
      clientInstanceId,
      projectId: project.id,
      idleBefore: input.noticeBefore,
      noticedAt: input.now.toISOString()
    });
    if (!marked) return false;
    for (const user of recipients) {
      const locale = user.locale ?? options.config.localization.defaultLocale;
      const content = idleNoticeContent(locale, {
        title: project.title,
        workspace: workspace?.kind === "shared" ? workspace.name : undefined,
        idleDays: input.idleDays,
        deleteOn,
        timeZone: options.config.clientInstance.timeZone
      });
      const item = await stores.approvals.createApprovalRequest({
        clientInstanceId,
        kind: NOTICE_KIND,
        summary: content.title,
        payload: content,
        requestedBy: SYSTEM_REQUESTER,
        addresseeUserId: user.id
      });
      if (options.mail && user.email) {
        await stores.noticeMail.enqueue({
          clientInstanceId,
          noticeId: item.id,
          userId: asUserId(user.id),
          dueAt
        });
        mailsQueued += 1;
      }
    }
    return true;
  });
  if (!noticed) return false;
  await options.auditRecorder.record({
    type: "project.idle_noticed",
    status: "success",
    subject: project.id,
    correlationId: createPlatformId("corr"),
    metadata: { idleDays: input.idleDays, recipients: recipients.length, mailsQueued }
  });
  return true;
}

/** The creator while an active member, and the active Owners of a shared project's workspace. */
async function recipientsOf(options: RetentionOptions, project: Project): Promise<UserRecord[]> {
  const { clientInstanceId } = options;
  const memberships = await options.stores.workspaces.listMemberships({
    clientInstanceId,
    collaborationWorkspaceId: project.collaborationWorkspaceId
  });
  const ids = new Set<string>();
  for (const membership of memberships) {
    if (
      membership.userId === project.createdByUserId ||
      (project.audience === "workspace" && membership.role === "owner")
    ) {
      ids.add(membership.userId);
    }
  }
  const users: UserRecord[] = [];
  for (const id of ids) {
    const user = await options.stores.users.getUser({ clientInstanceId, userId: asUserId(id) });
    if (user?.status === "active") users.push(user);
  }
  return users;
}

/** The notice in the person's language. The project's title is in its text alone, never its summary. */
function idleNoticeContent(
  locale: LocaleCode,
  input: {
    title: string;
    workspace: string | undefined;
    idleDays: number;
    deleteOn: Date;
    timeZone?: string;
  }
): { title: string; text: string } {
  const german = locale.toLowerCase().startsWith("de");
  const date = new Intl.DateTimeFormat(german ? "de-DE" : "en-GB", {
    dateStyle: "long",
    ...(input.timeZone ? { timeZone: input.timeZone } : {})
  }).format(input.deleteOn);
  const name = input.title.replace(/\s+/gu, " ").trim();
  // The title is the Inbox item's summary, which lists and mails show: it names no project.
  const title = cut(
    german
      ? `Ein ungenutztes Projekt wird am ${date} gelöscht`
      : `An unused project will be deleted on ${date}`,
    NOTICE_TITLE_MAX_LENGTH
  );
  const where = input.workspace ? ` in ${input.workspace}` : "";
  const text = german
    ? `Im Projekt „${name}“${where} hat sich seit ${String(input.idleDays - PROJECT_IDLE_NOTICE_DAYS)} Tagen nichts geändert. Am ${date} wird es mit seinen Dateien gelöscht. Schreib bis dahin einen Chat darin oder ändere eine Datei, dann bleibt es. Seine Chats bleiben in jedem Fall im Arbeitsbereich.`
    : `Nothing has changed in the project “${name}”${where} for ${String(input.idleDays - PROJECT_IDLE_NOTICE_DAYS)} days. On ${date} it will be deleted with its files. Write in one of its chats or change a file before then to keep it. Its chats stay in the workspace either way.`;
  return { title, text: cut(text, NOTICE_TEXT_MAX_LENGTH) };
}

function cut(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
