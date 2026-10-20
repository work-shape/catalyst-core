import { PLATFORM_DISCOVERY_TOOLS } from "@work-shape/catalyst-tool-execution";

const { context } = PLATFORM_DISCOVERY_TOOLS;

/** Where the agent learns which kinds exist on this instance. */
export const KINDS_HERE = `Not every instance has every kind: ${context.name} says which kinds and modules exist here and what the user may do.`;
