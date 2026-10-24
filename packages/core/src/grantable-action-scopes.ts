import type { ActionScopes } from "./grantable-scopes/action-scopes";
import { AGENT_GRANT_SCOPES } from "./grantable-scopes/agent";
import { SKILL_GRANT_SCOPES } from "./grantable-scopes/skill";
import { CONNECTION_GRANT_SCOPES } from "./grantable-scopes/connection";
import { APP_GRANT_SCOPES } from "./grantable-scopes/app";
import { DATA_STORE_GRANT_SCOPES } from "./grantable-scopes/data-store";
import { KNOWLEDGE_BASE_GRANT_SCOPES } from "./grantable-scopes/knowledge-base";
import { WORKFLOW_GRANT_SCOPES } from "./grantable-scopes/workflow";
import { GUARDRAIL_GRANT_SCOPES } from "./grantable-scopes/guardrail";
import { FEEDBACK_GRANT_SCOPES } from "./grantable-scopes/feedback";
import { MAIL_SENDER_GRANT_SCOPES } from "./grantable-scopes/mail-sender";
import { WORKSPACE_GRANT_SCOPES } from "./grantable-scopes/workspace";
import { ROLE_GRANT_SCOPES } from "./grantable-scopes/role";
import { USAGE_GRANT_SCOPES } from "./grantable-scopes/usage";
import { USERS_GRANT_SCOPES } from "./grantable-scopes/users";
import { JOBS_GRANT_SCOPES } from "./grantable-scopes/jobs";
import { SYSTEM_GRANT_SCOPES } from "./grantable-scopes/system";

/**
 * The actions a grant row can be written for, with the scope kinds it can be written at. A row
 * at instance scope is written for the actions no legacy key carries (RIGHTS-1c, D3): the
 * actions of a legacy key stay the key's, on the Users page, until AP-5b.
 * One file per kind under `grantable-scopes/`.
 */
export const GRANTABLE_ACTION_SCOPES = {
  ...AGENT_GRANT_SCOPES,
  ...SKILL_GRANT_SCOPES,
  ...CONNECTION_GRANT_SCOPES,
  ...APP_GRANT_SCOPES,
  ...DATA_STORE_GRANT_SCOPES,
  ...KNOWLEDGE_BASE_GRANT_SCOPES,
  ...WORKFLOW_GRANT_SCOPES,
  ...GUARDRAIL_GRANT_SCOPES,
  ...FEEDBACK_GRANT_SCOPES,
  ...MAIL_SENDER_GRANT_SCOPES,
  ...WORKSPACE_GRANT_SCOPES,
  ...ROLE_GRANT_SCOPES,
  ...USAGE_GRANT_SCOPES,
  ...USERS_GRANT_SCOPES,
  ...JOBS_GRANT_SCOPES,
  ...SYSTEM_GRANT_SCOPES
} as const satisfies ActionScopes;
