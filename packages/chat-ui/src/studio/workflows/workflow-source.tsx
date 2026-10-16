import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useWorkspaceApiClient } from "../../shared/api/workspace-api-client";
import { createInstanceSource } from "./instance-source";
import type { WorkflowsSource } from "./source-shapes";

// The source the Workflow screens read from: the instance's, or one given from above. What a
// source is, is in `source-shapes.ts`.

const WorkflowsSourceContext = createContext<WorkflowsSource | undefined>(undefined);

/** Gives the Workflow screens below it another source than the instance: samples, a test. */
export function WorkflowsSourceProvider({
  source,
  children
}: {
  source: WorkflowsSource;
  children: ReactNode;
}) {
  return <WorkflowsSourceContext value={source}>{children}</WorkflowsSourceContext>;
}

/** The session the Workflows are read with: the one the workspace shell holds. */
const WORKFLOW_AUTH_SCOPE = "standalone";

/** The source the screens read: the one given from above, else the instance. */
export function useWorkflowsSource(): WorkflowsSource {
  const given = useContext(WorkflowsSourceContext);
  const { apiBaseUrl, client } = useWorkspaceApiClient();
  const instance = useMemo(
    () => createInstanceSource(client, `${apiBaseUrl}:${WORKFLOW_AUTH_SCOPE}`),
    [apiBaseUrl, client]
  );
  return given ?? instance;
}
