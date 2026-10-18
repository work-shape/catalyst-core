import type { NoticeLink, NoticeRecipients } from "./notice-address";
import type { NotifyChannel } from "@work-shape/catalyst-asset-schemas";
import type { AuthenticatedIdentity } from "./identity";

// A notice: a few lines a Workflow leaves for people of the instance, in their Inbox and, where
// asked, as a mail that leads there. It is an Inbox item of its own kind, addressed to one
// person each, whose only answer is "mark handled" (`operations-and-policy.md`, Inbox).
//
// Title and text stay in the Inbox. Mail always carries a notice count and a link only;
// no author-supplied title, paragraph, client name or finding leaves through the mailer.

/** The Inbox item kind of a notice. */
export const NOTICE_KIND = "notice";

/**
 * Where a notice goes, the channels of a `notify` step (`NOTIFY_CHANNELS`). Every notice is an
 * Inbox item; `mail` adds a mail that links to it.
 */
export type NoticeChannel = NotifyChannel;

/** The longest title of a notice: one line. */
export const NOTICE_TITLE_MAX_LENGTH = 120;
/** The longest text of a notice: one paragraph. */
export const NOTICE_TEXT_MAX_LENGTH = 1000;
/** The most users, and the most workspaces, one notice names. */
export const NOTICE_RECIPIENTS_MAX = 100;

/** Where a notice leads: the run it is about, or an App. Ids only, never a value of a run. */
export type { NoticeLink, NoticeRecipients } from "./notice-address";
export interface NoticeSendInput {
  /** Who sends it: the Workflow's principal, or the person testing it. Named on the item. */
  from: AuthenticatedIdentity;
  to: NoticeRecipients;
  /** One line. Shown in the Inbox only. */
  title: string;
  /** One paragraph: counts, and what to do. Shown in the Inbox only. */
  text: string;
  link?: NoticeLink;
  /** Must hold `inbox`. */
  channels: readonly NoticeChannel[];
}

/** What became of a notice, in counts. */
export interface NoticeSendResult {
  /** The people who got the Inbox item. */
  addressees: number;
  /** People named, directly or through a workspace, who are not active and got nothing. */
  inactive: number;
  /** Mails handed to the mail provider. */
  mailsSent: number;
  /** Mails waiting for the configured digest job. */
  mailsQueued: number;
  /** Mails asked for and not sent: no address, no mailer, or no mailer was configured. */
  mailsUnsent: number;
}

/** The one way the platform sends a notice. The Workflow engine calls it. */
export interface Notices {
  send(input: NoticeSendInput, context: { correlationId: string }): Promise<NoticeSendResult>;
}
