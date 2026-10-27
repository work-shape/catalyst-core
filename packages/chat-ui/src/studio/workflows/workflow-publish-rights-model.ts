import { ApiError } from "@work-shape/catalyst-api-client";
import {
  isPrincipalGrantableAction,
  type WorkflowRightNeededFor,
  type WorkflowRightRefusal,
  type WorkflowRightsRevision,
  type WorkflowRunAccountStatus
} from "@work-shape/catalyst-core";
import type { TranslationContextValue, TranslationKey } from "../../shared/i18n";
import { actionLabel } from "../../admin/access/right-words";

// What the publish of a Workflow needs of the technical accounts it runs as, in the screen's
// own shapes, and the sentences for a publish the instance refused. The instance derives the
// rights from the definition, with the same function its publish check asks.

type Translate = TranslationContextValue["t"];

/** Why the reader cannot give a right the account lacks. */
export type { WorkflowRightRefusal };

/** One right an account needs on one resource the definition names. */
export interface WorkflowNeededRightView {
  action: string;
  /** Without a name where the reader may not see the asset. */
  asset: { kind: string; name?: string };
  steps: readonly string[];
  neededFor: WorkflowRightNeededFor;
  held: boolean;
  /** The grant the reader may write for it: the account and the resource. */
  grant?: { holderId: string; scopeId: string };
  refusal?: WorkflowRightRefusal;
}

/** One Workflow of the publish and the account it runs as. */
export interface WorkflowAccountRightsView {
  workflow: string;
  revision: WorkflowRightsRevision;
  runAs: string;
  account: { label?: string; status: WorkflowRunAccountStatus };
  rights: readonly WorkflowNeededRightView[];
}

export interface WorkflowPublishRightsView {
  /** The reader administers technical accounts and may give them rights at all. */
  administers: boolean;
  workflows: readonly WorkflowAccountRightsView[];
  /** Child Workflows the reader may not see that lack something: counted, never named. */
  hiddenWorkflows: number;
}

/** One grant the screen writes: one right of one account on one resource. */
export interface WorkflowRightGrant {
  holderId: string;
  action: string;
  scopeId: string;
}

/** The Workflows whose account lacks a right or cannot run, each with only what it lacks. */
export function lackingAccounts(view: WorkflowPublishRightsView): WorkflowAccountRightsView[] {
  return view.workflows.flatMap((entry) => {
    const rights = entry.rights.filter((right) => !right.held);
    return rights.length > 0 || entry.account.status !== "active" ? [{ ...entry, rights }] : [];
  });
}

/** What the reader may give, as one grant per right. */
export function offeredGrants(view: WorkflowPublishRightsView): WorkflowRightGrant[] {
  return view.workflows.flatMap((entry) =>
    entry.rights.flatMap((right) =>
      !right.held && right.grant ? [{ ...right.grant, action: right.action }] : []
    )
  );
}

/** A grant's key: the same right of the same account on the same resource is one grant. */
export function grantKey(grant: WorkflowRightGrant): string {
  return `${grant.holderId} ${grant.action} ${grant.scopeId}`;
}

const scopeKeys: Readonly<Record<string, TranslationKey>> = {
  agent: "access.scopeAgent",
  skill: "access.scopeSkill",
  connection: "access.scopeConnection",
  app: "access.scopeApp",
  workflow: "access.scopeWorkflow",
  data_store: "access.scopeDataStore",
  knowledge_base: "access.scopeKnowledgeBase",
  guardrail: "access.scopeGuardrail"
};

/** "Verbindungen verwenden: Verbindung crm": the right in the verb table's words, on its asset. */
export function neededRightLabel(
  right: Pick<WorkflowNeededRightView, "action" | "asset">,
  t: Translate
) {
  const name = right.asset.name;
  const key = Object.hasOwn(scopeKeys, right.asset.kind) ? scopeKeys[right.asset.kind] : undefined;
  return t("workflowRights.rightOn", {
    right: actionLabel(right.action, t),
    asset:
      name === undefined
        ? t("workflowRights.assetHidden")
        : t(key ?? "workflowRights.assetUnknownKind", { name })
  });
}

const refusalKeys = {
  not_grantable: "workflowRights.notGrantable",
  not_administrator: "workflowRights.whoGives",
  not_held: "workflowRights.notHeld",
  account_unavailable: "workflowRights.accountUnavailable",
  asset_unavailable: "workflowRights.assetUnavailable",
  not_visible: "workflowRights.notVisible"
} as const satisfies Record<WorkflowRightRefusal, TranslationKey>;

export function rightRefusalSentence(refusal: WorkflowRightRefusal, t: Translate): string {
  return t(refusalKeys[refusal]);
}

/** The sentence for one right the instance refused to give from the publish question. */
export function giveFailureSentence(error: unknown, t: Translate): string {
  return error instanceof ApiError && detailsOf(error.payload).reason === "not_visible"
    ? t("workflowRights.notVisible")
    : t("workflowRights.giveFailed");
}

/**
 * Why the instance refused to publish, test or start a Workflow over the technical account it
 * runs as, in the reader's language: which account, by the label people see, and that an
 * administrator changes it under Settings › API access. Undefined for any other refusal.
 * `principal_inactive` names the account by its label only where it exists, which is then
 * switched off.
 */
export function workflowAccountRefusal(error: unknown, t: Translate): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const details = detailsOf(error.payload);
  const place = `${t("nav.settings")} › ${t("settings.apiAccess")}`;
  const label = details.principalDisplayLabel;
  switch (details.reason) {
    case "run_as_missing":
      return t("workflowRights.refusedAccountMissing", { place });
    case "run_as_owned":
      return t("workflowRights.refusedAccountOwned");
    case "run_as_unknown":
      return details.runAs === undefined
        ? t("workflowRights.refusedAccountMissing", { place })
        : t("workflowRights.refusedAccountUnknown", { name: details.runAs, place });
    case "run_as_disabled": {
      const name = label ?? details.runAs;
      return name === undefined
        ? t("workflowRights.refusedAccountInactive", { place })
        : t("workflowRights.refusedAccountDisabled", { name, place });
    }
    case "principal_inactive":
      return label === undefined
        ? t("workflowRights.refusedAccountInactive", { place })
        : t("workflowRights.refusedAccountDisabled", { name: label, place });
    default:
      return undefined;
  }
}

/**
 * The reader's sentence for a publish of a Workflow the instance refused, where the page has
 * one: the reasons of the publish check of a Workflow and its children. Nothing for any other
 * refusal, which the page then says as the instance said it.
 */
export function workflowPublishRefusal(error: unknown, t: Translate): string | undefined {
  if (!(error instanceof ApiError)) return undefined;
  const details = detailsOf(error.payload);
  const workflow = details.workflow;
  switch (details.reason) {
    case "child_use_forbidden":
      return workflow === undefined
        ? t("workflowRights.refusedChildUseUnnamed")
        : t("workflowRights.refusedChildUse", { workflow });
    case "no_parent_trigger":
      return workflow === undefined
        ? t("workflowRights.refusedNoParentTriggerUnnamed")
        : t("workflowRights.refusedNoParentTrigger", { workflow });
    case "child_unpublished":
      return t("workflowRights.refusedChildUnpublished");
    case "workflow_cycle":
      return t("workflowRights.refusedCycle");
    case "run_as_missing":
    case "run_as_owned":
    case "run_as_unknown":
    case "run_as_disabled":
    case "principal_inactive":
      return workflowAccountRefusal(error, t);
    case "user_only":
      return t("workflowRights.refusedPersonOnly");
    case "outside_switch_person_only":
      return t("workflowRights.refusedOutsidePersonOnly");
    case "no_grant":
    case "denied":
      // The publisher lacks a right the account holds: the rule of no escalation.
      return details.action === undefined ||
        error.code !== "FORBIDDEN" ||
        !isPrincipalGrantableAction(details.action)
        ? undefined
        : t("workflowRights.refusedLends", { right: actionLabel(details.action, t) });
    default:
      return undefined;
  }
}

type DetailName = "reason" | "action" | "workflow" | "runAs" | "principalDisplayLabel";

function detailsOf(payload: unknown): Partial<Record<DetailName, string>> {
  const envelope = field(payload, "error");
  const details = field(envelope, "details");
  const read = (name: string) => {
    const value = field(details, name);
    return typeof value === "string" ? value : undefined;
  };
  const found: Partial<Record<DetailName, string>> = {};
  for (const name of ["reason", "action", "workflow", "runAs", "principalDisplayLabel"] as const) {
    const value = read(name);
    if (value !== undefined) found[name] = value;
  }
  return found;
}

function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.entries(value).find(([key]) => key === name)?.[1];
}
