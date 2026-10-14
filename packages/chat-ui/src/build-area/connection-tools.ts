import { useQuery } from "@tanstack/react-query";
import type { ConnectionTools } from "@vivd-catalyst/api-client";
import { useSettingsPage } from "../settings/settings-page-context";
import { useBuildNavigation } from "./build-route";
import { toolGroupStartsOpen } from "./tool-group";

// The tools of Connections an agent can be given, as the agent page offers them. The instance
// answers them for the Connections the reader may read (`connections.list_tools`): operations
// that agents may call, that are on and ready. A name the agent holds and the answer lacks is
// kept and shown as unavailable. The page never drops a name the reader did not remove.

/** The path segment of Connections in Build. */
export const CONNECTIONS_BUILD_PATH = "connections";

/** What every tool name of a Connection's operation starts with. */
const CONNECTION_TOOL_PREFIX = "connection.";

type ConnectionToolGroup = ConnectionTools["connections"][number];

/** What the instance says of the tools of Connections, as the agent page asked for it. */
export type ConnectionToolsRead =
  | { status: "loading" }
  /** The read failed, or the instance has no Connections. Nothing can be offered. */
  | { status: "unknown" }
  | { status: "ready"; connections: readonly ConnectionToolGroup[] };

/** What the agent page is handed for the tools of Connections. */
export interface ConnectionToolChoice {
  read: ConnectionToolsRead;
  /** The way to a Connection's page. Absent where the page stands outside Build. */
  place?(name: string): { href: string; open(): void };
}

/** Whether a tool name is one of a Connection's operation, by its form alone. */
export function isConnectionToolName(toolName: string): boolean {
  return toolName.startsWith(CONNECTION_TOOL_PREFIX);
}

/** One Connection as the Tools section shows it. */
interface ConnectionToolGroupView extends ConnectionToolGroup {
  /** How many of its tools the agent holds. */
  selectedCount: number;
  startsOpen: boolean;
}

interface ConnectionToolsView {
  groups: ConnectionToolGroupView[];
  /**
   * The names the agent holds that no group offers: the Connection or the operation is gone,
   * off, not for agents, or not for this reader to see. Empty until the instance answered.
   */
  unavailable: string[];
  /** The names the agent holds while nothing is known of them: shown, never judged. */
  unchecked: string[];
}

/** The groups to show and the names the agent holds that none of them offers. */
export function connectionToolsView(
  read: ConnectionToolsRead,
  selected: readonly string[]
): ConnectionToolsView {
  const held = selected.filter(isConnectionToolName);
  if (read.status !== "ready") {
    return { groups: [], unavailable: [], unchecked: held };
  }
  const offered = new Set(
    read.connections.flatMap((connection) => connection.tools.map((tool) => tool.toolName))
  );
  return {
    groups: read.connections.map((connection) => {
      const selectedCount = connection.tools.filter((tool) =>
        selected.includes(tool.toolName)
      ).length;
      return {
        ...connection,
        selectedCount,
        startsOpen: toolGroupStartsOpen({
          toolCount: connection.tools.length,
          selectedCount,
          groupCount: read.connections.length
        })
      };
    }),
    unavailable: held.filter((toolName) => !offered.has(toolName)),
    unchecked: []
  };
}

/**
 * The tools of Connections on the instance: one read when the agent page opens. The instance
 * answers every Connection the reader may read in one answer, without pages.
 */
export function useConnectionToolChoice(): ConnectionToolChoice {
  const { apiBaseUrl, authScope, client } = useSettingsPage();
  const { href, open } = useBuildNavigation();
  const query = useQuery({
    queryKey: ["connection-tools", apiBaseUrl, authScope],
    queryFn: ({ signal }) => client.connections.list_tools({ signal }),
    retry: false
  });
  return {
    read: query.data
      ? { status: "ready", connections: query.data.connections }
      : query.isPending
        ? { status: "loading" }
        : { status: "unknown" },
    place: (name) => {
      const place = { kindPath: CONNECTIONS_BUILD_PATH, name };
      return { href: href(place), open: () => open(place) };
    }
  };
}
