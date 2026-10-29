import { useMemo } from "react";
import type { ProjectView } from "@work-shape/catalyst-api-client";
import { useProjectQuery, useProjectSetupQuery } from "../../shared/api/projects";
import { projectStartAgent } from "./project-setup";

/** A project's page as the start page of a chat in the project. */
export interface ProjectStart {
  /** The project of the page, once it has been read. */
  project: ProjectView | undefined;
  /** The agent a new chat in the project starts with until the person picks another. */
  startAgentName: string | undefined;
  /**
   * The agents a chat in the project may start with, once its setup has been read: an agent of
   * the person's own is not one in a project others read (PRJ-7).
   */
  agentNames: ReadonlySet<string> | undefined;
}

/** The project whose page is open, by the name in its address; nothing elsewhere. */
export function useProjectStart(projectName: string | undefined): ProjectStart {
  const query = useProjectQuery(projectName);
  const project =
    projectName !== undefined && query.data?.name === projectName ? query.data : undefined;
  const setup = useProjectSetupQuery(project?.id).data;
  const agentNames = useMemo(
    () =>
      setup
        ? new Set(
            setup.agents.filter((agent) => agent.refusal === undefined).map(({ name }) => name)
          )
        : undefined,
    [setup]
  );
  return { project, startAgentName: projectStartAgent(setup)?.name, agentNames };
}
