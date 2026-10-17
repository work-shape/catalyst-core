/** What the interface knows of a Connection where it only names it: its name and its icon. */
export interface ConnectionFacts {
  /** The Connection's id. */
  name: string;
  /** The name people read. */
  title: string;
  /** The key of the icon registry for the system behind the Connection. */
  service?: string;
  /** What kind of system it is, for the icon of a Connection without a registered service. */
  category?: string;
}

/** What every tool name of a Connection's operation starts with. */
const CONNECTION_TOOL_PREFIX = "connection.";

/**
 * The icon registry's key for the kind of system a Connector type reaches. A type the
 * interface does not know has none and shows the generic Connection icon.
 */
export function connectionCategory(connectorType: string | undefined): string | undefined {
  return connectorType === "postgres"
    ? "database"
    : connectorType === "http_api"
      ? "code"
      : undefined;
}

/** The Connection a tool name belongs to, by its form `connection.<name>.<operation>`. */
export function connectionNameOfTool(toolName: string): string | undefined {
  if (!toolName.startsWith(CONNECTION_TOOL_PREFIX)) {
    return undefined;
  }
  const rest = toolName.slice(CONNECTION_TOOL_PREFIX.length);
  const dot = rest.indexOf(".");
  return dot > 0 && dot < rest.length - 1 ? rest.slice(0, dot) : undefined;
}

/** The operation a tool name of a Connection stands for, by its form `connection.<name>.<operation>`. */
export function connectionOperationOfTool(toolName: string): string | undefined {
  const name = connectionNameOfTool(toolName);
  return name === undefined
    ? undefined
    : toolName.slice(CONNECTION_TOOL_PREFIX.length + name.length + 1);
}
