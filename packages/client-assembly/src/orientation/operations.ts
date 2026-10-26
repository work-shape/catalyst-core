import { PLATFORM_ASSET_TOOLS } from "@work-shape/catalyst-tool-execution";

const { operations } = PLATFORM_ASSET_TOOLS;

/**
 * How the agent finds callable operations, and that they are its own: what an outside client
 * can reach is set by the Connection's exposure and the key's scopes, which it does not read.
 */
export const OPERATIONS = `Operations: ${operations.name} finds callable operation names and schemas; read every page before saying an operation does not exist. It shows what you, the agent, can call, not what an outside client (CLI, MCP, a personal key) can reach. Asked what such a client can reach, open your answer by saying that it depends on the Connection's "Outside clients" exposure and the key's scopes, and that you have not checked them; never infer it from your own tools.`;
