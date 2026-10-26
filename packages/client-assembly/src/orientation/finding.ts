import { PLATFORM_DISCOVERY_TOOLS } from "@work-shape/catalyst-tool-execution";

const { listAssets, listFiles } = PLATFORM_DISCOVERY_TOOLS;

/** How the agent finds what is on the platform. */
export const FINDING = `Finding: call ${listAssets.name} before you say something does not exist; ${listFiles.name} finds previews and files of other conversations of this workspace.`;
