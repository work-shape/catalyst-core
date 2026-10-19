import {
  createActorAccess,
  workflowNeededRightResource,
  type ActorAccess,
  type ConfigAssetStore,
  type OperationRegistry,
  type ServicePrincipalRecord,
  type WorkflowAccountRights,
  type WorkflowManifest
} from "@work-shape/catalyst-core";
import type { WorkflowRunAsOptions } from "@work-shape/catalyst-server";
import {
  indexWorkflowSteps,
  resolveWorkflowNeededRights,
  type WorkflowDefinitionRevision,
  type WorkflowDefinitionSource
} from "@work-shape/catalyst-workflows";

/** How many Workflows one answer covers: the one published and the children it reaches. */
const WORKFLOW_ACCOUNT_RIGHTS_MAX = 25;

export type WorkflowRightsOptions = WorkflowRunAsOptions & {
  configAssets: Pick<ConfigAssetStore, "getConfigAsset">;
  registry?: () => Pick<OperationRegistry, "resolve" | "resolveMany"> | undefined;
};

/**
 * The account a definition names under `runAs` and what it may do, by the ordinary
 * authorizer with no credential scope and no starter rights. Nothing where no principal of
 * the name exists.
 */
export async function workflowRunAccount(
  options: WorkflowRunAsOptions,
  runAs: string | undefined
): Promise<{ principal: ServicePrincipalRecord; access: ActorAccess } | undefined> {
  if (runAs === undefined) return undefined;
  const principal = await options.apiAccess.findServicePrincipalByName({
    clientInstanceId: options.clientInstanceId,
    name: runAs
  });
  if (!principal) return undefined;
  const access = createActorAccess(
    {
      kind: "service_principal",
      id: principal.id,
      clientInstanceId: options.clientInstanceId,
      roles: [],
      permissionRefs: principal.permissionRefs
    },
    await options.access.loadPersistedAccess({
      clientInstanceId: options.clientInstanceId,
      holder: { kind: "service_principal", id: principal.id }
    })
  );
  return { principal, access };
}

/**
 * What a publish of the Workflow's newest revision needs of the accounts it runs as: its own
 * account, and the account of each published child it reaches, each once. An account that is
 * disabled or missing holds nothing.
 */
export async function workflowAccountRights(
  options: WorkflowRightsOptions,
  definitions: Pick<WorkflowDefinitionSource, "read"> & {
    draft(id: string): Promise<WorkflowDefinitionRevision | undefined>;
  },
  workflow: string
): Promise<WorkflowAccountRights[] | undefined> {
  const root = await definitions.draft(workflow);
  if (!root) return undefined;
  const open: {
    id: string;
    manifest: WorkflowManifest;
    revision: WorkflowAccountRights["revision"];
  }[] = [{ id: workflow, manifest: root.manifest, revision: "draft" }];
  const seen = new Set([workflow]);
  const answer: WorkflowAccountRights[] = [];
  for (let next = open.shift(); next; next = open.shift()) {
    const [rights, account] = await Promise.all([
      resolveWorkflowNeededRights(options, next.manifest),
      workflowRunAccount(options, next.manifest.runAs)
    ]);
    const active = account?.principal.status === "active" ? account.access : undefined;
    if (next.manifest.runAs !== undefined)
      answer.push({
        workflow: next.id,
        revision: next.revision,
        runAs: next.manifest.runAs,
        ...(account
          ? {
              account: {
                id: account.principal.id,
                label: account.principal.displayLabel,
                status: account.principal.status
              }
            }
          : {}),
        rights: rights.map((right) => ({
          ...right,
          held: active?.authorize(right.action, workflowNeededRightResource(right)).allowed === true
        }))
      });
    for (const { step } of indexWorkflowSteps(next.manifest).values()) {
      if (step.type !== "workflow" || seen.has(step.workflow)) continue;
      seen.add(step.workflow);
      if (seen.size > WORKFLOW_ACCOUNT_RIGHTS_MAX) continue;
      const child = await definitions.read(step.workflow);
      if (child) open.push({ id: step.workflow, manifest: child.manifest, revision: "published" });
    }
  }
  return answer;
}
