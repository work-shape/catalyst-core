import { PLATFORM_ASSET_TOOLS } from "@work-shape/catalyst-tool-execution";

const { operations } = PLATFORM_ASSET_TOOLS;

/** How the agent finds callable operations. */
export const OPERATIONS = `Operations: ${operations.name} finds callable operation names and schemas; read every page before saying an operation does not exist.`;
