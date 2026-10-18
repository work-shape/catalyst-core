/** Instance ids only; an e-mail address is never a notice recipient. */
export const NOTICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

export type NoticeLink =
  | { kind: "workflow_run"; workspaceId?: string; workflowId: string; runId: string }
  | { kind: "app"; workspaceId: string; app: string };

/**
 * Who a notice is for: users of the instance by id, and the members of Shared Workspaces of the
 * instance by the workspace's id. A workspace stands for a group until groups exist (AP-7). No
 * address is taken: a mail goes only to the address the instance holds for an addressee. An id
 * that names no user or no Shared Workspace refuses the whole notice (`VALIDATION_FAILED`,
 * `details.unknownRecipients`), and so does a notice that would reach no active person
 * (`CONFLICT`, `details.reason: "no_active_recipient"`).
 */
export interface NoticeRecipients {
  users?: readonly string[];
  workspaces?: readonly string[];
}
