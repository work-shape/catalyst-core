import { PLATFORM_DISCOVERY_TOOLS } from "@work-shape/catalyst-tool-execution";

const { context } = PLATFORM_DISCOVERY_TOOLS;

/** How the agent answers a refusal for a missing right. */
export const RIGHTS_REFUSALS = `Rights refusals: use the administrator named by the tool result or ${context.name}.helpContact. Say that the person lacks the right, never that you need access. Explain in the conversation language, without error codes or internal names, and never send the person to a page they cannot open. helpContact is for the instance's content and access; never name it as the one to fix a platform or infrastructure failure.`;
