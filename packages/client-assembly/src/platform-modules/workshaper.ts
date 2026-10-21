import { defineModule } from "@work-shape/catalyst-core";

/**
 * Workshaper, the agent that ships with the platform (SA-1): on, the API process stores it at
 * start, available in no workspace until an admin offers it, and refreshes it with each
 * release. Off, the seed writes nothing and a stored Workshaper stays as it is; its name stays
 * the platform's either way.
 */
export const workshaperModule = defineModule({ name: "workshaper" });
