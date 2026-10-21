import { WORKFLOW_ASSET_KIND } from "@work-shape/catalyst-core";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import {
  narrativeHolds,
  PublishNarrativeReadLead,
  usePublishNarrative
} from "../../shared/publish-narrative";
import type { AppPublishConfirmationAsk } from "../apps/app-publish-confirmation";

// ACCEPT-FIX-11 C1: an agent's publish of a Workflow is confirmed with the sentence the
// Workflow's own publish question reads: what goes live, when it runs and in which time zone,
// as which account and who reads what it writes. Allow waits for that sentence.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An agent's publish of a Workflow, as its waiting call names it. */
export interface WorkflowPublishCall {
  workflow: string;
  revision: number;
  /** The workspace that owns the Workflow, where the call names one (WS-OWN-1b). */
  workspaceId?: string;
}

/** The Workflow publish a waiting call is, or nothing for any other call. */
export function workflowPublishCall(decision: {
  operationId: string;
  inputPreview: unknown;
}): WorkflowPublishCall | undefined {
  const input = decision.inputPreview;
  if (
    decision.operationId !== "assets.publish" ||
    !isRecord(input) ||
    input.kind !== WORKFLOW_ASSET_KIND
  ) {
    return undefined;
  }
  const { name, revision, workspaceId } = input;
  return typeof name === "string" && typeof revision === "number"
    ? { workflow: name, revision, ...(typeof workspaceId === "string" ? { workspaceId } : {}) }
    : undefined;
}

/** The card's lead for a Workflow publish: the instance's sentence on it, before Allow. */
export function useWorkflowPublishConfirmation(
  call: WorkflowPublishCall
): AppPublishConfirmationAsk {
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const read = usePublishNarrative(
    [apiBaseUrl, WORKFLOW_ASSET_KIND, call.workflow, call.revision],
    async (signal) =>
      (
        await client.assets.get({
          params: { kind: WORKFLOW_ASSET_KIND, name: call.workflow },
          query: {
            revision: String(call.revision),
            ...(call.workspaceId === undefined ? {} : { workspaceId: call.workspaceId })
          },
          signal
        })
      ).publishNarrative
  );
  return {
    node: (
      <div data-testid="workflow-publish-confirmation">
        <PublishNarrativeReadLead read={read} />
      </div>
    ),
    audience: undefined,
    ready: !narrativeHolds(read)
  };
}
