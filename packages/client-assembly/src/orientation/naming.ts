import { PLATFORM_DISCOVERY_TOOLS } from "@work-shape/catalyst-tool-execution";

const { context } = PLATFORM_DISCOVERY_TOOLS;

/** How the agent names a new asset. */
export const NAMING = `Naming: give a new asset a short name for what it does, with no prefix. A person's own workspace is no name prefix: use a prefix ${context.name} lists only where the person chose that area for the asset.`;
