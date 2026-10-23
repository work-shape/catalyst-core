import type { AuthenticatedIdentity, WorkflowRun } from "@work-shape/catalyst-core";
import type { WorkflowDefinitionRevision, WorkflowDefinitionSource } from "./definition-source";
import type { workflowResource } from "./workflow-resource";

/** A test uses the child's draft only for a tester who may write it; live runs use published. */
export async function childDefinition(options: {
  definitions: Pick<WorkflowDefinitionSource, "draft">;
  published: WorkflowDefinitionRevision | undefined;
  mode: WorkflowRun["mode"] | undefined;
  actor: AuthenticatedIdentity;
  resource: ReturnType<typeof workflowResource>;
  mayWrite?: (
    actor: AuthenticatedIdentity,
    resource: ReturnType<typeof workflowResource>
  ) => Promise<boolean>;
}): Promise<WorkflowDefinitionRevision | undefined> {
  if (
    options.mode !== "test" ||
    !options.definitions.draft ||
    !options.mayWrite ||
    !(await options.mayWrite(options.actor, options.resource))
  )
    return options.published;
  return (await options.definitions.draft(options.resource.name)) ?? options.published;
}
