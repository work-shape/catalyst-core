import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { SafeConfig } from "@vivd-catalyst/api-client";
import {
  connectionCategory,
  connectionNameOfTool,
  type ConnectionFacts
} from "../connection-facts";

/** What a tool call of a Connection touched, as the conversation says it. */
export interface ConnectionToolSubject {
  connection: ConnectionFacts;
  /** Whether the call reads or changes. Unknown for a tool no listed agent holds any more. */
  effect?: "reading" | "changing";
}

/** Of an agent, only the Connections its tools reach are read. */
type Agents = readonly Pick<SafeConfig["agents"][number], "connections">[];

const ToolSubjectsContext = createContext<ReadonlyMap<string, ConnectionToolSubject>>(new Map());

/**
 * Tells the tool calls below it what they touch: the Connections the listed agents' tools
 * reach, by tool name, as the instance names them for those agents.
 */
export function ToolSubjectsProvider({
  agents,
  children
}: {
  agents: Agents;
  children: ReactNode;
}) {
  const subjects = useMemo(() => {
    const byToolName = new Map<string, ConnectionToolSubject>();
    for (const agent of agents) {
      for (const { name, title, service, connectorType, tools } of agent.connections ?? []) {
        const connection = { name, title, service, category: connectionCategory(connectorType) };
        for (const tool of tools) {
          byToolName.set(tool.toolName, { connection, effect: tool.effect });
        }
      }
    }
    return byToolName;
  }, [agents]);
  return <ToolSubjectsContext value={subjects}>{children}</ToolSubjectsContext>;
}

/**
 * What a tool call touched, where the tool is an operation of a Connection. A Connection the
 * instance no longer names for an agent is still told apart by the tool's name: it shows the
 * generic Connection icon and the Connection's id.
 */
export function useConnectionToolSubject(toolName: string): ConnectionToolSubject | undefined {
  const subjects = useContext(ToolSubjectsContext);
  const name = connectionNameOfTool(toolName);
  if (name === undefined) {
    return undefined;
  }
  return subjects.get(toolName) ?? { connection: { name, title: name } };
}
